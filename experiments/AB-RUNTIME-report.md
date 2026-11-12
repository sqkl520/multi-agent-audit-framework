# AB-RUNTIME 审计报告

审查对象：`<HOME>\AppData\Local\Temp\iso-ab-runtime\code\`（9 文件 / 465 行，Node ESM，可直接 import）。
探针脚本位于 `%TEMP%\iso-probe\probe*.mjs`。以下所有「实际值」均为 Node 运行时实测，非静态推断。

> 说明：`src/neg-catch.js`、`src/neg-race.js`、`src/neg-unused.js` 三个负例文件按注释声称「无缺陷」，实测其行为均与注释一致（详见文末「已核实为正确」），**不计为发现**。

---

## 发现 1
- **file**: src/worker-pool.js:19
- **类型**: 并发竞态 / 任务丢失
- **严重性**: 严重
- **问题**: `worker()` 里 `const idx = cursor; await Promise.resolve(); cursor += 1;` 在读取 `cursor` 和自增之间插入了一个 `await`。多个 worker 会读到同一个 `cursor` 值，然后各自自增——导致同一索引被重复执行、其他索引永不执行，且对应 `results` 槽位保持 `undefined`。只要 `concurrency > 1` 且任务数大于 1 就触发，不是偶发而是稳定可复现。输入：任意 `runWithConcurrency([0,1,2,3], 2, fn)` → 任务 1、3 从不被调用，结果数组含 `null`。
- **运行证据**:
  - 命令：`node probe10.mjs`
  - `concurrency=2`，任务 `[0..7]`：期望每个索引调用 1 次、无重复 → 实际 `invoked=[0,0,2,2,4,4,6,6]`，`dup=[0,2,4,6]`，`missing=[1,3,5,7]`，结果数组 4 个 `null`。
  - `concurrency=8` 时 8 个 worker 全读 `cursor=0`：实际 `invoked=[0,0,0,0,0,0,0,0]`，任务 1~7 全部丢失。
  - 对照：`concurrency=1` 时正常 `[0,1,2,3,4,5,6,7]`（无重复/无缺失），证明缺陷只在并发分支出现。
  - 连续 3 次运行 `concurrency=2` 均为 `[0,0,2,2]`，稳定复现。

## 发现 2
- **file**: src/index.js:28
- **类型**: 逻辑错误 / 数据丢失（在途任务被清空）
- **严重性**: 严重
- **问题**: `processTasks` 先把任务 `enqueue` 进队列（第 24-26 行，队列随后被丢弃），紧接着 `tasks.length = 0` 就地清空传入数组；随后 `runWithConcurrency(tasks, ...)` 拿到的已是空数组。后果：任何输入下 handler 都不会被调用，函数恒返回 `[]`。注释「假设队列持有的是独立副本」与事实相反（队列确实复制了对象，但清空的正是随后要遍历的 `tasks` 本身）。
- **运行证据**:
  - 命令：`node probe3.mjs`
  - 输入 `processTasks([{id:'a'},{id:'b'},{id:'c'}], {handler})`：期望 `res.length=3`、handler 调用 3 次 → 实际 `res=[]`、handler 调用 **0** 次。
  - 对照（同模块正确函数）：直接 `runWithConcurrency([{id:'a'}],1,fn)` 正常返回 `[{"ok":true,"value":...}]`。
  - 另一探针 `node probe3.mjs` 中失败 handler 用例：handler 调用 0 次，返回 `[]`，异常也被一并吞掉。

## 发现 3
- **file**: src/queue.js:34
- **类型**: 容量越界（off-by-one）
- **严重性**: 高
- **问题**: 容量判断写成 `this.#items.length > this.#capacity`，应为 `>=`。当队列长度恰好等于 capacity 时仍会入队，实际最大容量为 `capacity + 1`。输入：`capacity=1` 连续 enqueue 3 次 → 期望第 2 次返回 false，实际第 2 次返回 true，最终 size=2。
- **运行证据**:
  - 命令：`node probe8.mjs`
  - `capacity=1`：期望结果 `[true,false,false]`、最终 size=1 → 实际 `[true,true,false]`、最终 size=**2**。
  - `capacity=3`：期望 `[true,true,true,false,false]`、size=3 → 实际 `[true,true,true,true,false]`、size=**4**。
  - 对照：同文件 `remove('zzz')` 返回 false、`remove('a')` 返回 true，行为正确，排除「返回值整体错乱」。

## 发现 4
- **file**: src/queue.js:53（dequeue）与 src/queue.js:65（peek）
- **类型**: 语义错误（违背注释的 FIFO 契约）
- **严重性**: 中
- **问题**: 两处取极值的比较都用 `>=`，相等优先级时会不断把 `bestIdx` 后移，最终选中**最后入队**的那个，实际是同优先级 **LIFO**。注释第 45-48 行与第 60 行明确声称「同优先级按 FIFO / 返回最先入队的」。输入：依次入队同优先级 `first/second/third` → `peek()` 与 `dequeue()` 都返回 `third`。
- **运行证据**:
  - 命令：`node probe1.mjs`
  - `peek()`：期望 `first` → 实际 `third`。
  - `dequeue()`：期望 `first` → 实际 `third`。
  - 混合优先级用例 `dequeue order`：期望 `["b","a","c"]` → 实际 `["b","c","a"]`（b 优先正确，但 a/c 同优先级被反转）。

## 发现 5
- **file**: src/queue.js:84
- **类型**: 返回值契约不符（JSDoc 声称恒返回 true）
- **严重性**: 低
- **问题**: `clear()` 的 JSDoc 写 `@returns {boolean} 总是 true`，但函数体 `this.#items.length = 0;` 没有 `return` 语句，实际返回 `undefined`。依赖返回值的调用方会拿到假值。清空本身有效。
- **运行证据**:
  - 命令：`node probe1.mjs`
  - 期望 `clear()` → `true`，实际 → `undefined`；随后 `size` 为 0（清空动作本身正确）。

## 发现 6
- **file**: src/config.js:16
- **类型**: 校验缺失（"positive integer" 名不副实）
- **严重性**: 中
- **问题**: `parsePositiveInt` 只校验 `Number.isInteger(n)`，从不校验 `n > 0`。负数与 0 都被接受（0 还能被当作合法值，因为 `raw === ''` 只挡空串）。配置层放行非法值，错误被推迟到下游（worker-pool 才对 concurrency 抛 RangeError，而 timeoutMs=0 会一路流入 retry 引发新的异常，见发现 9）。输入：`CONCURRENCY=-3`、`TIMEOUT_MS=0`。
- **运行证据**:
  - 命令：`node probe2.mjs`
  - `loadConfig({CONCURRENCY:'-3'})`：期望抛 TypeError → 实际返回 `{concurrency:-3,...}`。
  - `loadConfig({TIMEOUT_MS:'0'})`：期望抛错 → 实际返回 `{timeoutMs:0,...}`。
  - `node probe8.mjs` 对照：`-3` 被下游 `runWithConcurrency` 拒绝（RangeError），证明本应在此层拦截；`probe2` 中 `CONCURRENCY:'abc'`/`'2.5'` 均正确抛错，说明是「漏校验符号」而非整体失效。

## 发现 7
- **file**: src/retry.js:15
- **类型**: 计算错误（退避量翻倍）
- **严重性**: 中
- **问题**: 注释与公式声称 `base * 2^(attempt-1)`，代码写成 `base * Math.pow(2, attempt)`（指数多了 1）。第 1 次重试本应等 `base`，实际等 `2*base`；后续同比例翻倍，退避整体提前一级。输入：`backoffDelay(1,{base:100})` → 期望 100，实际 200。
- **运行证据**:
  - 命令：`node probe2.mjs` 与 `node probe11.mjs`
  - `backoffDelay(1,{base:100})`：期望 100 → 实际 **200**；`attempt=2` 期望 200 → 实际 400；`attempt=3` 期望 400 → 实际 800。
  - retry 实际睡眠序列 `node probe11.mjs`：`base=10` 时实测 `sleeps=[20,40,80]`，文档公式应为 `[10,20,40]`。
  - 对照：同文件 `attempt=0/-1/1.5` 正确抛 RangeError，`shouldRetry:()=>false` 正确短路（仅调用 1 次），排除参数校验失效。

## 发现 8
- **file**: src/store.js:53
- **类型**: 非原子写入 / 数据丢失（注释自认）
- **严重性**: 高
- **问题**: `#persist` 注释「先删原文件再写——中途失败会导致数据丢失」正是缺陷本身：先 `rmSync` 删旧文件，再 `writeFileSync`。若 `JSON.stringify` 抛错（如循环引用）或写入失败，旧文件已被删除，原有数据全部丢失，磁盘上什么都不剩。且 `set()` 在 `#persist` 抛错前已把坏值写入内存 `#data`，内存与磁盘不一致。输入：已有 `{keep:'important'}` 的文件上 `set('bad', 循环引用对象)` → 抛错且文件被删空。
- **运行证据**:
  - 命令：`node probe5.mjs`
  - 写入 `keep` 后文件内容 `{ "keep": "important" }`；调用 `set('bad',{self:自身})` → 抛 `TypeError: Converting circular structure to JSON`；之后 `existsSync(file)`：期望仍存在 → 实际 **false**（文件已消失）。
  - 重新 `new JsonStore(file)`，期望读回 `["keep"]` → 实际 `[]`（原数据丢失）。
  - 文件顶部注释声称「带原子写入：先写临时文件再 rename」，与实际实现（删后写）直接矛盾。

## 发现 9
- **file**: src/index.js:34
- **类型**: 参数语义混用，掩盖真实错误
- **严重性**: 中
- **问题**: `retry(...)` 的 `maxDelay` 被赋成 `config.timeoutMs`（单次超时上限），注释也承认「timeoutMs 是单次超时上限，不是退避上限」。当 `timeoutMs < base(50)` 时，`backoffDelay` 抛 `RangeError: maxDelay must be >= base`，这个错误在任务实际失败后**取代**了原始任务错误向上抛，调用方看到的是配置错误而非业务失败。输入：`config.timeoutMs=10` 且 handler 失败。
- **运行证据**:
  - 命令：`node probe11.mjs`
  - `retry(fn 抛 TASK_FAILED, {base:50, maxDelay:10})`：期望抛出原始 `TASK_FAILED` → 实际抛出 `RangeError: maxDelay must be >= base`（`maxDelay=0/10/49` 均如此；`maxDelay=50` 才正常透出 `TASK_FAILED`）。
  - 通过 `processTasks` 复现（`node probe7.mjs`，`timeoutMs:30`）：任务失败被吞，返回 `[]`，连 RangeError 都被 worker-pool 捕获进结果。

## 发现 10
- **file**: src/store.js:31
- **类型**: 原型链泄漏（`in` 应为 `hasOwnProperty`）
- **严重性**: 中
- **问题**: `get(key)` 用 `key in this.#data`，会命中 `Object.prototype` 上的属性。查询任意未设置的键名如 `toString`/`constructor`/`hasOwnProperty` 会返回继承函数而非 `undefined`，破坏「缺失键返回 undefined」的语义，可能让调用方把函数当业务值使用。输入：`store.get('toString')`。
- **运行证据**:
  - 命令：`node probe5.mjs`
  - `get('toString')`：期望 `undefined` → 实际 `function`；`get('constructor')`、`get('hasOwnProperty')` 同样返回 function。
  - 对照：同文件 `get('missing')`（普通缺失键）正确返回 `undefined`，说明只在原型属性名上泄漏。

## 发现 11
- **file**: src/store.js:35
- **类型**: 特殊键静默丢失
- **严重性**: 低
- **问题**: `set` 用 `this.#data[key] = value` 赋值。当 `key === '__proto__'` 时这是修改原型而非写自有属性，随后 `keys()` 看不到、`JSON.stringify` 写成 `{}`，数据被静默丢弃且 `set` 不报错。`delete` 用 `hasOwnProperty` 检查，与 `set` 的赋值语义不一致。输入：`set('__proto__', {polluted:true})`。
- **运行证据**:
  - 命令：`node probe5.mjs`
  - `set('__proto__', {polluted:true})` 后 `keys()`：期望 `["__proto__"]` → 实际 `[]`；磁盘内容为 `{}`；重新加载后 `get('__proto__')`：期望 `{polluted:true}` → 实际 `{}`。
  - 补充：`({}).polluted` 仍为 `undefined`（未造成真正的原型污染），本发现定性为「数据静默丢失」而非安全漏洞。

## 发现 12
- **file**: src/retry.js:47
- **类型**: 抛出不存在的值（throw undefined）
- **严重性**: 中
- **问题**: `maxAttempts <= 0` 时 for 循环一次都不执行，`lastError` 保持 `undefined`，最后 `throw lastError` 抛出 `undefined`。调用方 `catch(e)` 拿到 `undefined`，无法 `.message`/判类型，异常信息彻底丢失。参数校验只挡住非整数，没挡 `<= 0`。输入：`retry(fn, {maxAttempts:0})`。
- **运行证据**:
  - 命令：`node probe4.mjs`
  - `maxAttempts=0`：期望抛 RangeError（或明确错误） → 实际 `threw: undefined | type: undefined`。
  - `maxAttempts=-1`：同样 `threw: undefined`。
  - 对照：`maxAttempts=3` 正常路径 `node probe2.mjs` 中正确在第 2 次成功返回 `ok@2`、耗尽时抛最后错误 `always`，排除正常分支问题。

## 发现 13
- **file**: src/index.js:23
- **类型**: 空输入崩溃（capacity=0）
- **严重性**: 中
- **问题**: `new TaskQueue({ capacity: tasks.length })` 在 `tasks` 为空时 capacity=0，而 `TaskQueue` 构造器对 `capacity <= 0` 抛 TypeError。因此 `processTasks([])` 直接抛错，而不是返回 `[]`。空批次是完全合法的输入。输入：`processTasks([], {handler})`。
- **运行证据**:
  - 命令：`node probe7.mjs`
  - `processTasks([], {handler})`：期望返回 `[]` → 实际抛 `TypeError: capacity must be a positive number`。
  - 对照：`processTasks` 传非空数组不抛此错（因发现 2 返回 `[]`），证明是空数组专属触发。

## 发现 14
- **file**: src/store.js:24
- **类型**: 对合法 JSON 根值类型不设防
- **严重性**: 低
- **问题**: `JSON.parse` 对 `null`/数字/字符串等合法但非对象的根值会原样返回，`#load` 直接把它当作 store 数据。之后 `get`（`in` 运算符）和 `set`（属性赋值）对 `null`/原始值抛 TypeError。文件内容仍是合法 JSON，却被视为「已损坏但未走兜底」。输入：文件内容为 `null` 或 `5`。
- **运行证据**:
  - 命令：`node probe9.mjs`
  - 文件内容 `null`：`get('a')` → 抛 `TypeError: Cannot use 'in' operator to search for 'a' in null`；`set('x',1)` → 抛 `Cannot set properties of null`。期望：视为空 store 返回 `undefined`。
  - 文件内容 `5` / `"str"` 同样抛错；`[]` 可正常使用。
  - 对照：真正损坏的 JSON（`{not json`）在 `probe4.mjs` 中正确兜底为空 store（`keys()=[]`），说明兜底只覆盖解析异常、不覆盖类型异常。

---

## 附：已核实为正确的负例（不计发现）

以下三个文件注释均声称「无缺陷」，实测成立，特此记录以防误报：

- **src/neg-catch.js**（空 catch）：`tryRemoveTemp` 对存在/不存在/重复删除分别返回 `true/false/false`；`tryParseJson` 对 `'0'` 返回 `0`、对 `'null'` 返回 `null`、非法输入返回 `null`；`safeClose` 对有效句柄返回 true 且只关闭一次、对 `null`/无 `close`/`close` 抛错均返回 false。均符合注释（命令 `node probe6.mjs`）。
- **src/neg-race.js**（共享状态+async）：`Counter.increment` 三次得 `[1,2,3]`；`batchIncrement(counter,1000)` 最终值恰为 `1000`（无丢失更新）；`-1/1.5/'5'` 正确抛 RangeError。`incrementAsync` 在写后才 `await`，确无竞态（命令 `node probe6.mjs`）。
- **src/neg-unused.js**（看似死代码）：`ERROR_CODES`/`VERSION`/`normalizeError`/`isValidTask` 实测输出全部符合预期（`normalizeError` 保留 code、字符串归为 `UnknownError`；`isValidTask` 对 `{id:'a'}` true、`{}`/`null` false）。属于公共 API，非死代码（命令 `node probe6.mjs`）。

## 附：范围外未计项的观察（非缺陷）

- `src/worker-pool.js:14` `results` 槽位在任务丢失时保持 `undefined`（发现 1 的后果，非独立缺陷）。
- `src/index.js:38` 返回 `runWithConcurrency` 的 `[{ok,value}]` 包装而未解包（注释已声明「不检查 ok」，且因发现 2 实际返回 `[]`，不单列）。
