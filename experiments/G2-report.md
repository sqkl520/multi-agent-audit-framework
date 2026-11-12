# G2-report — 代码审计结果

审计对象：`<HOME>\AppData\Local\Temp\iso-g2\code\`（9 个 js 文件，471 行，全部读完）
运行时验证脚本：`%TEMP%\g2-probes\verify.mjs`（汇总复现）+ `p1..p9.mjs`（分项探针）。只读审计，未改动被审计目录。
所有探针均通过 `src/index.js` 的公开导出调用；每个模块附带同模块已知正确函数的对照用例。

---

## 发现 1
- **file**: src/worker-pool.js:19-21
- **类型**: concurrency
- **严重性**: CRITICAL
- **问题**: `const idx = cursor;` 与 `cursor += 1;` 之间夹了 `await Promise.resolve()`。所有 worker 同时读到同一个 `cursor`，随后各自 +1 互相覆盖：同一索引被多跑、大量任务永不执行、`results` 留洞。任何 `concurrency >= 2` 且 `tasks.length > concurrency` 的调用都会命中（即默认配置）。更糟的是落到空洞索引上的 `ok:false` 也被丢弃，调用方完全看不到失败。
- **运行证据**:
  - 命令：`node verify.mjs`
  - 期望：4 个任务、concurrency=2 → 索引 `[0,1,2,3]`，4 个 `{ok:true}`。
  - 实际：索引 `[0,0,2,2]`，结果 `[{"ok":true,"value":10},null,{"ok":true,"value":30},null]`。
  - 放大：100 个任务、concurrency=4 → 只执行 25 个唯一任务，`never executed` 75 个，结果空洞 75 个。
  - 失败丢失：`['ok','FAIL','ok','ok']`（runner 对 FAIL 抛错）→ `ok:false` 条目 0 个、空洞 3 个，异常彻底消失。
  - 对照（同模块、已知正确路径）：concurrency=1 → 索引 `[0,1,2]`、结果 `a,b,c` 完整无洞，证明探针与模块本身可用。

## 发现 2
- **file**: src/index.js:23,28,30
- **类型**: logic
- **严重性**: CRITICAL
- **问题**: `tasks.length = 0` 原地清空了调用方数组，第 30 行却把**同一个已被清空的数组**传给 `runWithConcurrency`，队列里的任务从此无人消费。结果：`processTasks` 对任何非空输入都静默返回 `[]`、handler 零次调用，并擅自清空调用方数组。第 27 行注释「队列持有的是独立副本」是错的——`enqueue` 里 `{...task}` 只复制任务对象，数组本身没有复制。此外空输入会走 `capacity: 0` 构造并抛 `TypeError`，与「空批次返回空结果」的直觉相反。
- **运行证据**:
  - 命令：`node verify.mjs`
  - 期望：3 个任务 → handler 调用 3 次，返回 3 条 `{ok:true,value:'done:*'}`，调用方数组长度仍为 3。
  - 实际：handler 调用 0 次，返回 `[]`，调用方 `tasks` 变为 `[]`。
  - 空输入：`processTasks([], {handler})` → `TypeError: capacity must be a positive number`（期望 `[]`）。
  - 对照：直接 `runWithConcurrency(['a','b','c'], 1, ...)`（同模块正确函数）→ `a,b,c` 全部执行，证明丢失发生在清空数组而非 worker-pool。

## 发现 3
- **file**: src/queue.js:34（构造校验 8-13 行同源）
- **类型**: data-consistency
- **严重性**: HIGH
- **问题**: 容量判断用 `>` 而不是 `>=`。队列已达 `capacity` 时仍返回 `true` 并再入队一个，实际容量变成 `capacity + 1`，`size` 可超过声明的 `capacity`，破坏容量上界契约，依赖返回值做背压的调用方会多放一个任务。构造函数同时放行 `NaN` 与 `Infinity`（`capacity <= 0` 对 NaN 为 false），NaN 使比较恒为 false，队列彻底无界。
- **运行证据**:
  - 命令：`node verify.mjs`
  - 期望：capacity=3 时最多接受 3 个，`size <= 3`。
  - 实际：`[true,true,true,true,false,false]`，`size = 4`，`capacity = 3`。
  - 补充：`new TaskQueue({capacity: NaN})` 连续入队 5 个全部 `true`、`size = 5`；`capacity: Infinity` 同样全部接受。
  - 对照：`capacity: 0` / `-1` 正确抛 `TypeError`，说明校验路径本身工作，只是漏了边界与非有限值。

## 发现 4
- **file**: src/store.js:53-55
- **类型**: data-consistency
- **严重性**: HIGH
- **问题**: `#persist` 先 `rmSync` 删除原文件再 `writeFileSync`，并非注释声称的「先写临时文件再 rename」（文件内根本没用 `rename`）。只要序列化或写入抛错，旧文件已经被删，全部历史数据丢失。用循环引用对象即可稳定触发：`set()` 抛 `TypeError`，但文件已不存在。
- **运行证据**:
  - 命令：`node verify.mjs`
  - 期望：`set(circular)` 失败后旧数据 `{"safe":"important"}` 仍在。
  - 实际：`set(circular) threw TypeError: Converting circular structure to JSON` 之后 `file exists after failed set: false`，`new JsonStore(p).keys()` 为 `[]`，数据全丢。
  - 对照：同一实例正常 `set('a',1); set('b',{c:2})` → 重新加载 `["a","b"]`，`delete` 语义也正确，证明缺陷仅在失败路径。

## 发现 5
- **file**: src/store.js:19-28
- **类型**: error-handling | data-consistency
- **严重性**: HIGH
- **问题**: `#load` 对三类坏数据都静默降级且不报错也不备份：解析失败 → `{}`；文件内容为 `null`/数字/字符串等非对象 JSON → 原样返回，随后在 `get`/`set` 处以裸 `TypeError` 崩在任意调用点。配合 `#persist` 的整文件覆盖，下一次 `set` 会把原有全部键永久抹掉。
- **运行证据**:
  - 命令：`node verify.mjs`
  - 期望：损坏文件应报错或至少保留备份，非对象 JSON 应被拒绝。
  - 实际（截断文件）：有效时 `keys = ["user","token"]`；写成 `{"user":"alice","token":"a` 后 `keys = []`（无任何警告）；再 `set('x',1)` → 磁盘只剩 `{"x":1}`，原有两个键丢失。
  - 实际（非对象）：`null` → 构造成功，`get('0')` 抛 `TypeError: Cannot use 'in' operator to search for '0' in null`，`set('k',1)` 抛 `Cannot set properties of null`；数字 `5`、字符串 `"abc"` 同样。
  - 对照：合法 JSON 文件构造/读取/删除全部正常，说明问题集中在未校验的加载路径。

## 发现 6
- **file**: src/retry.js:32-47
- **类型**: error-handling
- **严重性**: HIGH
- **问题**: 只校验了 `Number.isInteger(maxAttempts)`，没校验 `>= 1`。`maxAttempts <= 0` 时 for 循环一次都不进，`lastError` 保持 `undefined`，最后 `throw lastError` 抛出的是 `undefined`——不是 Error，调用方 `catch (e) { e.message }` 直接二次崩溃。该值可从公开配置直达：`loadConfig({RETRY_MAX:'0'}).retryMax === 0`。
- **运行证据**:
  - 命令：`node verify.mjs`
  - 期望：`maxAttempts=0` → `RangeError`。
  - 实际：`maxAttempts=0 -> caught value: undefined | instanceof Error: false`；`maxAttempts=-1` 相同；`loadConfig({RETRY_MAX:'0'})` → `retryMax 0` → 同样抛 `undefined`。
  - 对照：`maxAttempts=1` → 正常返回 `ok1`；3 次后成功 → 返回 `third`，`attempts=3`，证明正常路径无误。

## 发现 7
- **file**: src/queue.js:53（peek 同缺陷 65 行）
- **类型**: contract
- **严重性**: MEDIUM
- **问题**: 注释与 JSDoc 明确承诺「同优先级按 FIFO」「同优先级时返回最先入队的」，但比较用 `>=`，相等时不断把 `bestIdx` 更新为更靠后的元素，实际是 **LIFO**。同优先级任务的处理顺序被整体反转，依赖 FIFO 公平性的调用方会饿死先入队任务。
- **运行证据**:
  - 命令：`node verify.mjs`
  - 期望：入队 a(prio1), b(prio5), c(prio5), d(prio5) → 出队 `b,c,d,a`。
  - 实际：`d,c,b,a`。
  - peek 一致性：入队 a,b,c（同优先级）→ `peek()` 返回 `c`（期望 `a`），`dequeue()` 也返回 `c`，即两者一致但都违反文档。

## 发现 8
- **file**: src/retry.js:15
- **类型**: logic
- **严重性**: MEDIUM
- **问题**: 文档公式是 `base * 2^(attempt-1)`，实现写成 `base * Math.pow(2, attempt)`，整体多乘 2：首次重试等待 2×base 而非 base，后续每次同样翻倍，退避时间线整体前移一档。
- **运行证据**:
  - 命令：`node verify.mjs`
  - 期望：`base=50`、`maxAttempts=4` 的 sleep 序列 `[50,100,200]`。
  - 实际：`[100,200,400]`。
  - 对照：`backoffDelay(1,{base:100,maxDelay:1e5})` → `200`（文档应为 100），`backoffDelay(2,...)` → `400`，确认是公式偏移而非采样误差；`attempt=0` 正确抛 `RangeError`，`attempt=2000` 正确被 `maxDelay` 夹住。

## 发现 9
- **file**: src/config.js:13-19
- **类型**: contract
- **严重性**: MEDIUM
- **问题**: 函数名与错误文案都声明「positive integer」，实际只校验 `Number.isInteger`，`0`、负数、纯空白（`Number(' ')=0`）全部放行，并把非法值原样交给下游。`CONCURRENCY=0` 让 `loadConfig` 成功返回，随后 `runWithConcurrency` 才抛 `RangeError`；`TIMEOUT_MS=-1`、`RETRY_MAX=0` 则一路潜伏到运行期（后者还触发发现 6）。
- **运行证据**:
  - 命令：`node verify.mjs`
  - 期望：`CONCURRENCY=-3` → `TypeError`。
  - 实际：`CONCURRENCY="0" -> concurrency 0`、`"-3" -> -3`、`" " -> 0`，且 `runWithConcurrency` 下游抛 `RangeError: concurrency must be a positive integer`；`TIMEOUT_MS=-1 -> -1`、`RETRY_MAX=0 -> 0`。
  - 对照：`CONCURRENCY=abc` 与 `2.5` 正确抛 `TypeError`，说明校验存在但判断条件不足。

## 发现 10
- **file**: src/store.js:31
- **类型**: contract | data-consistency
- **严重性**: MEDIUM
- **问题**: `get` 用 `key in this.#data` 判断存在性，`in` 会沿原型链查找。未写入的键名若撞上 `Object.prototype` 成员（`toString`、`constructor`、`valueOf`、`hasOwnProperty` 等），会返回原型函数而不是 `undefined`；而 `keys()` 又只列自有键。调用方「取不到就是默认值」的写法会被静默污染。
- **运行证据**:
  - 命令：`node verify.mjs`
  - 期望：全新 store 上 `get('toString') === undefined`。
  - 实际：`typeof s.get('toString') === 'function'` 且 `s.get('toString') === Object.prototype.toString`；`get('constructor')` 同样是 function；此时 `keys()` 为 `[]`。
  - 对照：真正写入的键 `get('a') === 1` 正常，`keys()`、`delete`、重载均正确，问题限于原型链键。

## 发现 11
- **file**: src/store.js:35
- **类型**: data-consistency | security
- **严重性**: MEDIUM
- **问题**: `this.#data[key] = value` 对 `key === '__proto__'` 是改原型而非加属性：`set` 正常返回、不报错，但键不会出现在 `keys()`，也不会写入磁盘（`JSON.stringify` 跳过原型），重载后消失。副作用是原型被替换，`'admin' in data` 变真，进而 `get('admin')` 返回一个从未写入的值——幽灵数据。
- **运行证据**:
  - 命令：`node verify.mjs`
  - 期望：`set('__proto__', {admin:true})` 后 `keys()` 含该键且落盘。
  - 实际：`keys()` 为 `[]`，磁盘为 `{}`，重载后 `keys()` 为 `[]`；但 `get('admin')` 返回 `true`（值实际写进了原型）。
  - 对照：`set('a',1)` 正常 `keys()=['a']` 并落盘，说明写入路径本身可用。

## 发现 12
- **file**: src/index.js:34
- **类型**: logic | error-handling
- **严重性**: MEDIUM
- **问题**: 把 `config.timeoutMs`（单次执行超时上限）当作重试退避的 `maxDelay`。两者语义不同：`maxDelay < base(=50)` 时 `backoffDelay` 直接抛 `RangeError: maxDelay must be >= base`，而该异常发生在 `catch` 内，会**替换掉真正的任务错误**，调用方拿到的失败原因完全失真。任何把 `TIMEOUT_MS` 配成小于 50 的部署都会命中。
- **运行证据**:
  - 命令：`node verify.mjs`
  - 期望：handler 抛 `REAL task failure` → 调用方看到该错误。
  - 实际：调用方看到 `RangeError: maxDelay must be >= base`（原始错误被吞）。
  - 对照：`backoffDelay(1,{base:50,maxDelay:30000})` 正常返回 100，说明仅在 `maxDelay < base` 的非法组合下触发，而该组合由配置项直接可达（`TIMEOUT_MS=10`）。

## 发现 13
- **file**: src/queue.js:84-86
- **类型**: contract
- **严重性**: LOW
- **问题**: 方法带 `@returns {boolean} 总是 true` 的文档，实现没有 `return`，实际返回 `undefined`。按文档判断 `if (!queue.clear()) ...` 的调用方会把成功当失败。
- **运行证据**:
  - 命令：`node verify.mjs`
  - 期望：`queue.clear() === true`。
  - 实际：`clear() -> undefined`（队列确实被清空，`size = 0`）。
  - 对照：同文件 `remove()` 命中返回 `true`、未命中返回 `false`，`dequeue()` 空队列返回 `null`，均与文档一致，说明是该方法单独的契约遗漏。

---

## 已核查但未列为发现（避免误报）

- `src/neg-catch.js`：三个空 `catch` 均语义正确且带返回值区分（`tryRemoveTemp` 返回 bool、`tryParseJson` 返回 null、`safeClose` 返回 bool），实测 `tryRemoveTemp(missing)=false`、`tryParseJson('nope')=null`、`safeClose` 重复关闭返回 `[true,false]`。唯一瑕疵是注释称「JSON.parse 永远不会返回 null」，实测 `JSON.parse('null')` 返回 `null`，使合法 JSON `"null"` 与解析失败同值——影响仅为极低概率的调用方歧义，故不单列。
- `src/neg-race.js`：`increment`/`incrementAsync` 的读-改-写之间没有 `await`，`batchIncrement(new Counter(), 1000)` 实测返回 `1000`，`Promise.all` 三个并发递增得到 `[1,2,3]`、终值 `3`，无竞态；负例入参 `-1`/`1.5` 正确抛 `RangeError`。
- `src/neg-unused.js`：`ERROR_CODES`/`VERSION`/`normalizeError`/`isValidTask` 无内部引用但属公开 API，不判为死代码（未被任何内部路径误用）。
- `src/store.js` 多实例写同一路径会互相覆盖（实测 A、B 各自实例化后写同一文件，磁盘只剩 `{"fromB":2}`）——该 store 未承诺多实例/跨进程并发语义，属使用约束而非代码缺陷，未列为发现。
