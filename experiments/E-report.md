# E-report — `experiments/injected/` 代码审计

审计对象：`experiments/injected/`（9 文件 / 471 行，全部读完）
运行时验证脚本：`%TEMP%\audit-v\p1..p16*.mjs`（Node v26.12.1，ESM，直接 import）
对照基准：`experiments/base/src/*`（同仓库「无缺陷」版本，仅用于确认探针有效，不作为结论依据）

方法：每条结论都由 `node` 实际执行，记录「期望值 vs 实际值」。所有探针均包含一个 `CONTROL` 对照调用
（同批输入的已知正确函数 `runWithConcurrency(concurrency=1)` / `retry` / 手工 FIFO），用于证明探针本身能观测到差异。

**负例确认无缺陷**：`src/neg-catch.js`、`src/neg-race.js`、`src/neg-unused.js` 三个文件已逐条实测，行为与注释声明一致，
**不计入缺陷**（详见文末「已排除项」）。

---

## 发现 1

- **file**: src/index.js:28
- **原文**:
  ```js
  // 假设队列持有的是独立副本，下面清空原数组不会影响队列
  tasks.length = 0;
  ```
  紧随其后的第 30 行才是真正的执行：`runWithConcurrency(tasks, config.concurrency, ...)`
- **类型**: data-consistency
- **严重性**: CRITICAL
- **问题**: `tasks.length = 0` 在 `runWithConcurrency` **之前**原地清空了调用方传入的数组。
  第 30 行读到的 `tasks` 与第 23–26 行入队的是同一个数组对象，清空后长度为 0。
  后果：`processTasks` 对**任何非空输入都一个 handler 都不调用**，直接返回 `[]`。
  注释声称「队列持有的是独立副本，清空原数组不会影响队列」——但真正被清空的是**将要被执行的那个数组**，
  而 `queue` 里那 100% 的副本从头到尾没有被消费过（见发现 12），所以这条注释把风险位置搞反了。
  由于返回 `[]` 不抛错，调用方会认为「任务批次成功完成，共 0 个任务」。
- **运行证据**:
  ```
  $ node "$TEMP/audit-v/p1-index.mjs"
  期望 : handler calls=3, out=["A","B","C"]
  实际 : handler calls=0, out=[], out.length=0
  tasks.length after call = 0
  CONTROL runWithConcurrency(concurrency=2) 同批任务: calls=3 out=[A,B,C]   ← 探针本身有效
  ```

## 发现 2

- **file**: src/worker-pool.js:19-22
- **原文**:
  ```js
  const idx = cursor;
  await Promise.resolve();
  cursor += 1;
  if (idx >= tasks.length) return;
  ```
- **类型**: concurrency
- **严重性**: CRITICAL
- **问题**: `cursor` 的自增被放在 `await Promise.resolve()` **之后**。所有 worker 在启动时先同步执行到 `await`，
  此时每个 worker 都读到**同一个** `idx`（都是 0），随后才有一次让出。结果：
  1. `tasks[0]` 被并发执行 `concurrency` 次；
  2. 索引 1..concurrency-1 对应的任务**永远不会执行**；
  3. `results` 里这些索引保持稀疏空洞（`undefined`，不是 `{ok:false}`）。
  在 `processTasks` 里这意味着数据被重复处理 + 静默丢失 + 返回值含 `undefined` 空洞。
- **运行证据**:
  ```
  $ node "$TEMP/audit-v/p2-pool.mjs"
  tasks=3  concurrency=2 → runner(idx:次数)={"0":2,"2":1}     从未执行=[1]     重复执行=[0]
  tasks=4  concurrency=4 → runner(idx:次数)={"0":4}           从未执行=[1,2,3] 重复执行=[0]
  tasks=10 concurrency=3 → runner(idx:次数)={"0":3,"3":1,...} 从未执行=[1,2]   重复执行=[0]
  tasks=5  concurrency=1 → {"0":1,"1":1,...}   从未执行=[] 重复执行=[]   ← CONTROL：concurrency=1 时完全正确
  ```
  ```
  $ node "$TEMP/audit-v/p3-pool-hole.mjs"
  runWithConcurrency([10,11,12,13], 4, x=>x*2)
  期望 [20,22,24,26]   实际 [ {ok:true,value:20}, <3 empty items> ]
  idx1 present? false   typeof r[1] = undefined
  CONTROL concurrency=1 → [20,22,24,26]   ← 正确
  CONTROL retry         → done@3          ← 探针有效
  ```

## 发现 3

- **file**: src/queue.js:53
- **原文**:
  ```js
  if (this.#items[i].priority >= this.#items[bestIdx].priority) {
  ```
- **类型**: logic
- **严重性**: HIGH
- **问题**: 同优先级比较用 `>=`，循环会一路取到**最后一个**同优先级元素，FIFO 变成 LIFO。
  第 46 行 JSDoc 明确承诺「同优先级按 FIFO」。优先级不同的排序仍然正确。
  同一处错误也存在于 `peek()`（src/queue.js:65），使 `peek()` 返回**最后**入队的同优先级元素，
  与第 60 行注释「同优先级时返回最先入队的」直接矛盾。
- **运行证据**:
  ```
  $ node "$TEMP/audit-v/p4-queue.mjs"
  同优先级 FIFO 期望 ["a","b","c"]  实际 ["c","b","a"]
  优先级降序    期望 ["hi","mid","lo"] 实际 ["hi","mid","lo"]   ← 优先级排序本身正常
  $ node "$TEMP/audit-v/p15-misc.mjs"
  peek() 同优先级 期望 "first"(按 JSDoc) 实际 "third"
  ```

## 发现 4

- **file**: src/retry.js:15
- **原文**:
  ```js
  const exponential = base * Math.pow(2, attempt);
  ```
  第 6 行 JSDoc：`base * 2^(attempt-1)，再夹到 maxDelay`
- **类型**: logic
- **严重性**: HIGH
- **问题**: 指数少减 1，每一次退避都翻倍。第 1 次重试就等 `2*base` 而不是 `base`。
  实际等待序列是期望值的 2 倍，且 `attempt=maxAttempts-1` 那一步会更早撞到 `maxDelay` 上限，
  使退避策略在重试次数较多时提前退化为「恒定上限等待」。属于心跳/限流场景下的可观测行为偏差。
- **运行证据**:
  ```
  $ node "$TEMP/audit-v/p5-retry.mjs"
  backoffDelay(1,{base:100}) 期望 100  实际 200
  backoffDelay(2,{base:100}) 期望 200  实际 400
  backoffDelay(3,{base:100}) 期望 400  实际 800
  backoffDelay(4,{base:100}) 期望 800  实际 1600
  retry 实际退避序列 期望 [100,200,400]  实际 [200,400,800]
  ```

## 发现 5

- **file**: src/retry.js:32-33
- **原文**:
  ```js
  if (!Number.isInteger(maxAttempts)) {
    throw new RangeError('maxAttempts must be an integer');
  }
  ```
- **类型**: error-handling
- **严重性**: HIGH
- **问题**: 只校验「是整数」，不校验「≥ 1」。`maxAttempts = 0` 或负数时，第 37 行的
  `for (let attempt = 1; attempt <= maxAttempts; attempt++)` 一次都不执行，`lastError` 保持 `undefined`，
  第 47 行 `throw lastError` 于是 `reject(undefined)`。
  后果：调用方 `catch (e)` 拿到 `undefined`，任何 `e.message` / `e instanceof Error` 都会二次崩溃
  （本次探针本身就因此崩过一次：`TypeError: Cannot read properties of undefined (reading 'constructor')`）。
  错误信息完全丢失，是最难排查的一类失败。
- **运行证据**:
  ```
  $ node "$TEMP/audit-v/p5b-retry.mjs"
  knock: retry(fn, {maxAttempts: 0}) 的 rejection 值
  {"typeofE":"undefined","isError":false}
  maxAttempts=-1 详细: {"rejectedWith":"undefined","typeofE":"undefined"}
  $ node "$TEMP/audit-v/p12-e2e.mjs"
  loadConfig({CONCURRENCY:'0', RETRY_MAX:'0'}) 通过 → 下游 retry 抛出的 typeof = undefined (应为 Error)
  ```
  注：非整数（1.5）走抛错分支，行为正确 —— 只有 `< 1` 的整数漏网。

## 发现 6

- **file**: src/config.js:16
- **原文**:
  ```js
  if (!Number.isInteger(n)) {
  ```
  函数名 `parsePositiveInt`，报错文案 `must be a positive integer`
- **类型**: logic
- **严重性**: HIGH
- **问题**: 名称、报错文案、注释都声称校验「正整数」，实现只校验「整数」。`0` 与负数被放行。
  三个字段全部受影响，且错误会**在下游才爆发**，崩溃点离根因很远：
  `CONCURRENCY=0` → `runWithConcurrency` 抛 `RangeError`；
  `RETRY_MAX=0` → `retry` reject `undefined`（见发现 5）；
  `TIMEOUT_MS=0` → 传给 `retry` 的 `maxDelay:0 < base:50` → 抛 `maxDelay must be >= base`（见发现 9）。
- **运行证据**:
  ```
  $ node "$TEMP/audit-v/p6-config.mjs"
  {"CONCURRENCY":"0"}  -> ACCEPTED {"concurrency":0,...}
  {"CONCURRENCY":"-5"} -> ACCEPTED {"concurrency":-5,...}
  {"TIMEOUT_MS":"0"}   -> ACCEPTED {"timeoutMs":0,...}
  {"RETRY_MAX":"-1"}   -> ACCEPTED {"retryMax":-1,...}
  {"CONCURRENCY":"abc"} -> throws TypeError   ← 非数字能挡住，探针有效
  $ node "$TEMP/audit-v/p12-e2e.mjs"
  loadConfig({CONCURRENCY:'0'}) 通过后 → runWithConcurrency throws RangeError: concurrency must be a positive integer
  CONTROL 合法 env 全链路 → [{"ok":true,"value":"a"},...]   ← 链路本身可用
  ```

## 发现 7

- **file**: src/store.js:25-26
- **原文**:
  ```js
  } catch {
    return {};
  }
  ```
- **类型**: error-handling
- **严重性**: HIGH
- **问题**: 存储文件损坏时静默当成「空库」。构造函数不报错，后续一次 `set()` 就会用新内容**整体覆盖**
  已损坏的文件，原有数据不可恢复。这是「静默数据丢失」：调用方无法区分「新库」和「库已损坏」。
  注意与 `neg-catch.js` 的空 catch 不同——那里的吞掉是可观测的（返回 `false`/`null`），
  这里的吞掉返回的是一个看起来完全正常的空对象。
- **运行证据**:
  ```
  $ node "$TEMP/audit-v/p7-store.mjs"
  写文件 "{ this is not json" 后 new JsonStore(path)
  期望 抛错   实际 静默成功, keys = []
  随后 set('newkey','v') → 磁盘变成 {"newkey":"v"}   （原始内容已消失）
  ```

## 发现 8

- **file**: src/store.js:54-55
- **原文**:
  ```js
  // 先删原文件再写——中途失败会导致数据丢失
  if (existsSync(this.#path)) rmSync(this.#path);
  writeFileSync(this.#path, JSON.stringify(this.#data, null, 2), 'utf8');
  ```
  第 2 行文件头注释：`带原子写入：先写临时文件再 rename，避免半写状态`
- **类型**: data-consistency
- **严重性**: HIGH
- **问题**: 实现与文件头「原子写入 / tmp + rename」的声明完全相反：先 `rmSync` 删掉原文件，再写新文件。
  两者之间任何失败（`JSON.stringify` 抛错、写盘中途 ENOSPC/EACCES、进程被杀）都会让**文件彻底消失**，
  而不是保留旧版本。注意 `JSON.stringify` 在 `writeFileSync` 的实参里求值，
  所以序列化失败时 `rmSync` **已经执行**——破坏发生在任何人能反应之前。
- **运行证据**:
  ```
  $ node "$TEMP/audit-v/p7-store.mjs"
  写前磁盘 = {"keep":"important"}
  set('bad', 循环引用对象) -> throws TypeError: Converting circular structure to JSON
  失败后文件是否还存在  期望 true   实际 false
   磁盘读取 -> ENOENT（数据已丢失）
   重新打开 keys 期望 ["keep"]  实际 []
  ```

## 发现 9

- **file**: src/index.js:34
- **原文**:
  ```js
  maxDelay: config.timeoutMs,   // timeoutMs 是单次超时上限，不是退避上限
  ```
- **类型**: contract
- **严重性**: HIGH
- **问题**: 两个问题叠加。
  1. **契约缺失**：`config.timeoutMs` 被命名为「超时」，全仓库却**没有任何超时实现**，它只被当作退避上限 `maxDelay`。
     慢 handler 不会被中断。注释本身就承认了这一点，但字段名与 `loadConfig` 的对外契约仍在宣称有超时能力。
  2. **掩盖真实错误**：当 `timeoutMs < 50`（`base` 硬编码 50）时，`backoffDelay` 的
     `if (maxDelay < base) throw new RangeError` 会在**第一次重试**时抛出，
     顶替掉 handler 的真实错误，并且**跳过 `shouldRetry` 与剩余重试次数**。
     而 `loadConfig` 明确接受 `TIMEOUT_MS=10`（见发现 6），所以这是可达路径：
     配置 `TIMEOUT_MS < 50` 的调用方永远看不到业务错误，只看到一个与业务无关的 `RangeError`。
- **运行证据**:
  ```
  $ node "$TEMP/audit-v/p9-timeout.mjs"
  handler 耗时 300ms, maxDelay(=timeoutMs) 50 → 是否超时？实际 "slow-ok" elapsed=327ms
  CONTROL runWithConcurrency 同样无超时 → [{"ok":true,"value":"done"}] elapsed=215ms
  $ node "$TEMP/audit-v/p13-retry2.mjs"
  timeoutMs=10 : 最终抛出 RangeError: maxDelay must be >= base   | handler calls=1   ← 真实错误被吞，只跑 1 次
  timeoutMs=49 : 最终抛出 RangeError: maxDelay must be >= base   | handler calls=1   ← 同上
  timeoutMs=50 : 最终抛出 Error: REAL-HANDLER-ERROR              | handler calls=3   ← CONTROL：合法值下行为正确
  timeoutMs=100: 最终抛出 Error: REAL-HANDLER-ERROR              | handler calls=3   ← CONTROL
  loadConfig({TIMEOUT_MS:"10"}) = {"timeoutMs":10,...}   ← 合法配置，可达
  ```

## 发现 10

- **file**: src/queue.js:34
- **原文**:
  ```js
  if (this.#items.length > this.#capacity) {
  ```
- **类型**: logic
- **严重性**: MEDIUM
- **问题**: 容量检查用了 `>` 且发生在 `push` **之前**，实际可容纳 `capacity + 1` 个。
  `capacity` getter 与 JSDoc 承诺的是 `capacity`。第 25 行还声称「队列满时返回 false，
  不抛错——调用方需要能区分『满了』和『出错了』」，但容量本身就多放行 1 个，背压计算会偏差一格。
- **运行证据**:
  ```
  $ node "$TEMP/audit-v/p4-queue.mjs"
  capacity=2, enqueue 三个
  期望 [true,true,false]   实际 [true,true,true]   size=3
  ```

## 发现 11

- **file**: src/queue.js:9-10
- **原文**:
  ```js
  if (typeof capacity !== 'number' || capacity <= 0) {
    throw new TypeError('capacity must be a positive number');
  }
  ```
- **类型**: error-handling
- **严重性**: MEDIUM
- **问题**: 只排除 `<= 0`，`NaN`、`Infinity`、小数全部通过（`NaN <= 0` 为 `false`，`Infinity <= 0` 为 `false`）。
  `capacity = NaN` 或 `Infinity` 时队列**完全无上限**，`enqueue` 永远返回 `true`——
  内存只能靠 OOM 兜底，而不是靠声明的容量。小数则产生「容量 2.5 实际放 3 个」这种半格语义。
  报错文案 `must be a positive number` 与实际校验范围不符（`NaN` 不是 positive number 却被接受）。
- **运行证据**:
  ```
  $ node "$TEMP/audit-v/p16-final.mjs"
  capacity=NaN      : 构造成功, accepted=5000/5000, q.capacity=NaN
  capacity=Infinity : 构造成功, accepted=5000/5000, q.capacity=Infinity
  capacity=2.5      : 构造成功, accepted=3
  capacity=0.5      : 构造成功, accepted=1
  capacity=-1 / 0   : throws TypeError       ← CONTROL：负数与 0 能被挡住，探针有效
  ```

## 发现 12

- **file**: src/index.js:23-26
- **原文**:
  ```js
  const queue = new TaskQueue({ capacity: tasks.length });
  for (const t of tasks) {
    queue.enqueue(t);
  }
  ```
- **类型**: logic
- **严重性**: MEDIUM
- **问题**: 这个 `queue` 是**纯死对象**——入队之后再也没有被 `dequeue`/`peek`/`size` 访问过，
  第 30 行执行用的是原始 `tasks` 数组。构造+填充的唯一实际效果是两个副作用：
  1. `tasks` 为空时 `capacity: 0` 触发 `TypeError: capacity must be a positive number`，
     即 **`processTasks([])` 本应返回 `[]`，却抛错**；
  2. 非法任务（缺 `id`）会在这里抛错——但这不是文档声明的契约，且与 `neg-unused.js`
     里公开的 `isValidTask()` 校验器重复。
  另外 `capacity: tasks.length` 加上发现 10 的 `> ` 只会多放行，`enqueue` 的 `false` 分支在这里永远不可达。
- **运行证据**:
  ```
  $ node "$TEMP/audit-v/p9-timeout.mjs"
  processTasks([], {handler}) 期望 []   实际 throws TypeError: capacity must be a positive number
  $ node "$TEMP/audit-v/p11-store2.mjs"
  processTasks([{id:'a'},{nope:1}]) → throws TypeError: task.id must be a non-empty string
  （抛错来自这个从不被消费的 queue）
  ```

## 发现 13

- **file**: src/store.js:31
- **原文**:
  ```js
  return (key in this.#data) ? this.#data[key] : undefined;
  ```
- **类型**: security
- **严重性**: MEDIUM
- **问题**: 用 `in` 而不是 `hasOwnProperty`，会命中原型链。空库里 `get('constructor')` 返回 `Object` 构造函数，
  `get('toString')` 返回函数对象——这些键**不在 `keys()` 里**，却能被 `get()` 取到，
  与同文件 `delete()`（第 40 行用的是 `hasOwnProperty`）语义不一致。
  连带问题：`#data` 是普通对象字面量，`set('__proto__', v)` 会改写原型而不是存数据，
  数据既写不进磁盘（`JSON.stringify` 只序列化自有属性），又能在内存里通过 `get()` 读到——静默丢失。
- **运行证据**:
  ```
  $ node "$TEMP/audit-v/p7-store.mjs"
  get("constructor") 期望 undefined  实际 function Object() { [native code] }
  get("toString")    期望 undefined  实际 function
  keys()             期望 []         实际 []            ← keys 与 get 不一致
  delete("constructor") 期望 false    实际 false        ← delete 用 hasOwnProperty，与 get 不一致
  $ node "$TEMP/audit-v/p11-store2.mjs"
  set("__proto__", {injected:'yes'}) 后 keys()=[]  磁盘={}
  get("injected") 期望 undefined  实际 "yes"          ← 内存可见、磁盘丢失
  ```

## 发现 14

- **file**: src/queue.js:69
- **原文**:
  ```js
  return this.#items[bestIdx];
  ```
  第 60 行注释：`查看队首但不出队。`
- **类型**: data-consistency
- **严重性**: MEDIUM
- **问题**: `peek()` 返回内部对象的**活引用**（`enqueue` 时做过一次 spread 浅拷贝，
  但那次拷贝只保护了入队参数，保护不了出队的 `peek`）。调用方修改返回值就直接改写了队列内部状态，
  包括 `priority`（出队顺序）和 `id`（`remove()` 的匹配键），而 `size` 保持不变——队列在「不知情」的情况下被重新排序。
  `dequeue()` 返回引用尚可接受（对象已离开队列），`peek()` 返回引用则破坏了「查看」的语义。
- **运行证据**:
  ```
  $ node "$TEMP/audit-v/p8-queue2.mjs"
  入队 low(prio 0), high(prio 10)；peek() 后把返回值 priority 改成 -99
  期望出队顺序 ["high","low"]   实际 ["low","high"]     ← 出队顺序被外部改写
  另一例：peek().id 改成 'HIJACKED' 后 remove('a') 返回 false，且 remove('HIJACKED') 会命中
  ```

## 发现 15

- **file**: src/store.js:19-28
- **原文**:
  ```js
  #load() {
    if (!existsSync(this.#path)) return {};
    const raw = readFileSync(this.#path, 'utf8');
    if (raw.trim() === '') return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  ```
- **类型**: data-consistency
- **严重性**: MEDIUM
- **问题**: 只校验「能 JSON.parse」，不校验「解析结果是对象」。文件内容为 `null` / `42` / `"hi"` / `true`
  时合法 JSON 通过，`#data` 变成非对象值；构造函数**成功**，但之后每个公开方法都抛 `TypeError`，
  且报错点全部落在使用方（`get`/`set`/`keys`），离根因很远。这与发现 7 是同一处 `#load()`
  的两个不同失效模式：7 是「解析失败静默」，本条是「解析成功但类型错误延后爆炸」。
- **运行证据**:
  ```
  $ node "$TEMP/audit-v/p14-store3.mjs"
  null    -> 构造成功; get() threw TypeError: Cannot use 'in' operator to search for 'a' in null
                        keys() threw Cannot convert undefined or null to object; set() threw TypeError
  42      -> 构造成功; get() threw TypeError: Cannot use 'in' operator ... in 42;  set() threw
  "hi"    -> 构造成功; get() threw TypeError ... in hi;  keys()=["0","1"]（字符串被当对象，更隐蔽）
  true    -> 构造成功; get()/set() 均 threw TypeError
  ```
  注：数组 `[1,2,3]` 不报错但 `keys()` 返回 `["0","1","2"]`，语义已错。

## 发现 16

- **file**: src/config.js:11
- **原文**:
  ```js
  const VALID_LOG_LEVELS = ['debug', 'info', 'error'];
  ```
- **类型**: contract
- **严重性**: MEDIUM
- **问题**: 白名单漏了 `warn`。`warn` 是 Node `console` / 绝大多数日志库的标准级别，
  且 `error` 在列表里、`warn` 不在，属于明显的中间档缺失。设置 `LOG_LEVEL=warn` 的部署会在
  `loadConfig()` 阶段直接 `throw`——注意这是**启动期抛错**，会让服务起不来，而不是降级。
  这条属于对外配置契约的破坏：报错文案会把合法级别说成非法。
- **运行证据**:
  ```
  $ node "$TEMP/audit-v/p6-config.mjs"
  LOG_LEVEL=warn -> throws TypeError: logLevel must be one of debug|info|error, got: warn
  LOG_LEVEL=verbose -> throws TypeError（CONTROL：真正非法的值确实应被拒绝，探针有效）
  ```

## 发现 17

- **file**: src/queue.js:84-86
- **原文**:
  ```js
  /**
   * 清空队列。返回是否清空成功。
   * @returns {boolean} 总是 true
   */
  clear() {
    this.#items.length = 0;
  }
  ```
- **类型**: contract
- **严重性**: LOW
- **问题**: JSDoc 明确声明 `@returns {boolean}`，实现没有 `return`，实际返回 `undefined`。
  按文档写 `if (!q.clear())` 的调用方会把「清空成功」判为失败。JSDoc 里「总是 true」的措辞尤其误导，
  因为根本不存在返回值。清空动作本身是正确的（`size` 归零）。
- **运行证据**:
  ```
  $ node "$TEMP/audit-v/p4-queue.mjs"
  clear() 实际 return = undefined   | size after = 0
  ```

## 发现 18

- **file**: src/queue.js:73
- **原文**:
  ```js
  remove(id) {
    const idx = this.#items.findIndex((t) => t.id === id);
  ```
- **类型**: contract
- **严重性**: LOW
- **问题**: `enqueue()`（第 28–33 行）对 `task` 和 `task.id` 做了严格校验并抛 `TypeError`，
  `remove()` 对 `id` 不做任何校验。传入 `undefined` / `null` / 数字全部静默返回 `false`，
  与 `enqueue` 的失败语义（抛错 vs 返回 false）不一致。调用方把 `remove(undefined)` 的 `false`
  理解成「这个 id 不在队列里」，而真实原因是「参数类型根本不对」，两种失败无法区分。
- **运行证据**:
  ```
  $ node "$TEMP/audit-v/p8-queue2.mjs"
  remove(undefined) -> false（不抛错）
  remove(null)      -> false（不抛错）
  remove(42)        -> false（不抛错）
  remove({id:'a'})  -> false（不抛错）
  $ node "$TEMP/audit-v/p4-queue.mjs"  ← CONTROL：enqueue 对同类输入全部抛 TypeError
  enqueue(null) / "str" / 42 / {} / {id:''} / {id:5} -> 全部 throws TypeError
  ```

---

## 已排除项（实测确认无缺陷，不计入）

这三个文件的设计意图就是「诱导误报」，逐条实测后行为与注释一致：

- **src/neg-catch.js** — 三处空 `catch` 均为刻意且可观测：
  `tryRemoveTemp` 存在/不存在 → `true`/`false`；`tryParseJson` 合法/非法/非字符串 → `1`/`null`/`null`；
  `safeClose` 正常/重复关闭/null/无 close → `true`/`false`/`false`/`false`。
  每个失败都用返回值表达，没有异常吞没。
- **src/neg-race.js** — `increment()` 无 `await`，单 tick 内完成；
  `incrementAsync()` 的 `await` 在**写之后**，不回写旧值。`batchIncrement(5)` → `5`，`batchIncrement(50)` → `50`。
  非法 `count`（-1 / 1.5 / '3' / null）全部抛 `RangeError`。
- **src/neg-unused.js** — `ERROR_CODES` 已 `Object.freeze`；`normalizeError` 对
  Error（带/不带 `code`）、字符串、`null` 的输出均正确；`isValidTask` 判定与 `TaskQueue.enqueue` 的校验一致。
  零内部引用是「公共 API」的预期特征，不是死代码。

## 未采用的观察（证据不足或非缺陷，为避免误报不单列）

- `src/config.js:37` 返回值未 `Object.freeze`（base 版本冻结，注入版本不冻结）。实测可变，但没有文档承诺不可变，
  改动只影响调用方自己持有的副本，未观察到实际后果，故不报。
- `src/index.js:37` 注释称「调用方无法区分成功与失败」，但返回项带 `{ok:false,error}` 字段，实际**可以**区分——
  这是注释错误而非代码缺陷。真正的可区分性问题来自发现 2 的 `undefined` 空洞（那里已计入）。
- `src/retry.js:29` `shouldRetry` 默认为 `() => true`，会对 `TypeError` 这类不可重试错误也重试。
  没有文档承诺相反行为，属宽松默认，不报。
- `src/queue.js:37-41` `enqueue` 用 spread 浅拷贝，嵌套对象仍共享引用。属常规行为，不报。
