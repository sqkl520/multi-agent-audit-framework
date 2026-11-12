# P3 代码审计报告

审计目标：`<HOME>\AppData\Local\Temp\iso-p3\code\`
范围：9 个文件 / 471 行（`package.json` + `src/*.js`），全部读完。
方式：只读源码；所有结论均由 `%TEMP%\p3-audit\*.mjs` 实测验证（Node v26.12.1）。

> 重要背景：`package.json` 自述 "a small, **correct** task-queue service"。
> 实测证明它并不 correct：核心任务执行路径 100% 丢弃任务（发现 2），并发执行器会漏跑+重跑任务（发现 1）。
> `neg-catch.js` / `neg-race.js` / `neg-unused.js` 三个 "负例" 文件确实无实质缺陷，但其注释中的事实性声明也有错误（见发现 19、20）。

---

## 模式检查结果

| 模式 | 文件 | 命中/未命中/不适用 | 说明 |
|---|---|---|---|
| 1. 返回值暴露 | queue.js | **命中** | `peek()` (L69) 直接 `return this.#items[bestIdx]`，返回队列内部对象本体。实测改返回值 `id`/`priority` 后，`peek()` 与后续 `dequeue()` 都读到被改的值。`enqueue` (L37) 只做浅拷贝，`task.payload` 等嵌套对象与调用方共享引用（实测双向可见）。 |
| 1. 返回值暴露 | store.js | **命中** | `get()` (L31) 返回 `this.#data[key]` 本体。实测改返回值后内部数据变化，且与磁盘内容不一致（内存 777 / 磁盘 1）。`keys()` (L47) 返回新数组，安全。 |
| 1. 返回值暴露 | retry.js | 未命中 | 只返回 number（`backoffDelay`）或原样透传 `fn` 的返回值（`retry`），无内部状态容器。 |
| 1. 返回值暴露 | worker-pool.js | 未命中 | `results` 是函数内新建的局部数组，返回它不暴露任何模块内部状态（但它本身是稀疏数组，见模式 4/发现 1）。 |
| 1. 返回值暴露 | config.js | 未命中 | L37 返回新对象字面量；`DEFAULTS` 已 `Object.freeze`。 |
| 1. 返回值暴露 | index.js | 未命中 | 内部 `TaskQueue` 构造后即被丢弃，从未返回；返回的 `raw` 是 worker-pool 新建的数组。问题在别处（发现 2）。 |
| 1. 返回值暴露 | neg-catch.js | 未命中 | `tryParseJson` 返回 `JSON.parse` 产生的新对象，非内部状态；`safeClose` 返回 boolean。 |
| 1. 返回值暴露 | neg-race.js | 未命中 | `value` getter 返回 number 原始值。 |
| 1. 返回值暴露 | neg-unused.js | 未命中 | `normalizeError` 每次新建对象；`ERROR_CODES` 已冻结。 |
| 2. 守卫一致性 | queue.js | **命中** | `enqueue` (L31) 强校验 `typeof task.id === 'string' && !== ''`，但同族的 `remove(id)` (L73) 对 `id` 零校验（实测 `remove(123)`/`remove(null)` 静默返回 false，不抛错）。`enqueue` 也不校验 `priority` 类型（实测字符串 `'99'` 被静默归零）。 |
| 2. 守卫一致性 | store.js | **命中** | `get` (L31) 用 `key in this.#data`（走原型链），`delete` (L40) 用 `hasOwnProperty`（仅自有），`keys` (L47) 用 `Object.keys`（仅自有）。三处语义不一致：实测 `get('toString')` 返回原生函数、`get('constructor')` 返回函数、`delete('toString')` 返回 false、`keys()` 不含它。 |
| 2. 守卫一致性 | retry.js | **命中** | `backoffDelay` 校验 `attempt`(整数≥1)、`base`(>0)、`maxDelay`(≥base)；`retry` 只校验 `maxAttempts` 是否整数，**不校验** `fn`、`shouldRetry`、`sleep`、`base`、`maxDelay`。实测 `shouldRetry: 'nope'` 会延迟到重试时才抛 `TypeError: shouldRetry is not a function`。 |
| 2. 守卫一致性 | worker-pool.js | 未命中 | 三个参数 `tasks`/`concurrency`/`runner` 都有类型与取值校验，彼此一致。 |
| 2. 守卫一致性 | config.js | **命中** | 三个数值字段共用 `parsePositiveInt`，而 `logLevel` 走另一条 `env.LOG_LEVEL \|\| 默认值` 路径：实测 `LOG_LEVEL=''` 静默回落 `info`，但 `LOG_LEVEL='warn'` 抛错——同等"非法"输入一个静默一个抛错。且 `CONCURRENCY='   '` 被当作 0 接受。 |
| 2. 守卫一致性 | index.js | **命中** | 校验了 `handler` 是函数 (L18)，却**不校验 `tasks` 是数组**就直接取 `tasks.length` (L23)。结果：`processTasks([])` 抛 `TypeError: capacity must be a positive number`，而 `processTasks('str')` 反而静默返回 `[]`。 |
| 2. 守卫一致性 | neg-catch.js | **命中**（轻微） | 同文件三个"尽力而为"函数守卫不一致：`tryParseJson` 有 `typeof text !== 'string'` 校验，`safeClose` 有 `handle && typeof close === 'function'` 校验，唯独 `tryRemoveTemp(path)` (L16) 对 `path` 零类型校验——实测传 `123`/`{}` 时靠 `existsSync` 内部容错返回 false，并触发 `DeprecationWarning`。 |
| 2. 守卫一致性 | neg-race.js | 未命中 | 只有 `batchIncrement` 有参数，单点校验无同族可比。 |
| 2. 守卫一致性 | neg-unused.js | 未命中 | `isValidTask` 与 `queue.enqueue` 的校验逻辑一致（object + id 非空字符串），无内部矛盾。 |
| 3. 数值边界 | queue.js | **命中** | `capacity` 校验 `typeof !== 'number' \|\| <= 0` (L9)。实测：`NaN` 通过（`NaN<=0` 为 false）、`Infinity` 通过、`1.5` 通过。另 L34 `>` 应为 `>=`：`capacity=2` 实测接受 3 个（capacity 1,1.5,2,2.9 全部超收 1 个）。 |
| 3. 数值边界 | store.js | 不适用 | 无数值参数。 |
| 3. 数值边界 | retry.js | **命中** | `attempt` 校验正确（`Number.isInteger && >=1`，实测拒绝 0/-1/1.5/NaN/Infinity/字符串）。但 `base <= 0` (L12) 漏 NaN：实测 `base:NaN` 静默返回 30000；`maxDelay < base` (L13) 漏 NaN：实测 `maxDelay:NaN` 返回 `NaN`（污染下游 `setTimeout(NaN)`）。`maxAttempts` (L32) 只查整数：实测 0/-1/-100 均被接受。 |
| 3. 数值边界 | worker-pool.js | 未命中 | `concurrency`: `Number.isInteger && <1` 正确拒绝 0/-1/1.5/NaN/Infinity（实测全部抛错）。 |
| 3. 数值边界 | config.js | **命中** | `parsePositiveInt` 名为 "positive"，实际 `Number.isInteger(n)` 不查正负。实测接受：`0`、`-5`、`-0`、`'   '`(→0)、`'0x10'`(→16)、`'1e3'`(→1000)、`'+3'`(→3)。拒绝：`1.5`/`abc`/`Infinity`/`NaN`。 |
| 3. 数值边界 | index.js | **命中**（传导） | `config.concurrency` 可为 0/负数（来自 config 缺陷），传给 `runWithConcurrency` 才抛错；`capacity: tasks.length` 在空数组时为 0 → 构造即抛错。 |
| 3. 数值边界 | neg-catch.js | 不适用 | 无数值参数。 |
| 3. 数值边界 | neg-race.js | 未命中 | `count`: `Number.isInteger && <0` 拒绝，接受 0（符合"非负整数"文档）。正确。 |
| 3. 数值边界 | neg-unused.js | 不适用 | 无数值参数。 |
| 4. 解析形状 | queue.js | 不适用 | 无 parse。 |
| 4. 解析形状 | store.js | **命中** | `#load` (L24) 直接 `return JSON.parse(raw)`，零类型校验。实测：文件为 `null` → 构造后 `get/keys/set` 全抛 `TypeError`；`123`/`"str"`/`true` → `get` 抛错、`keys()` 对字符串返回 `["0","1","2"]`、`set` 抛错；`[1,2,3]` → 静默当作 store，`set` 后写回数组，原有内容错位。 |
| 4. 解析形状 | retry.js | 不适用 | 无 parse。 |
| 4. 解析形状 | worker-pool.js | 未命中 | 无 parse；但"结果按索引对齐"的形状承诺被破坏（见发现 1）。 |
| 4. 解析形状 | config.js | 不适用 | 用 `Number()` 解析环境变量，非 JSON.parse；数值解析缺陷已计入模式 3。 |
| 4. 解析形状 | index.js | **命中** | 返回 `runWithConcurrency` 的结果数组，但**不校验**每项是否 `ok`；更严重的是该数组实际是稀疏的（发现 1），`JSON.stringify` 后变成 `[]`，调用方拿到"成功"的假象。 |
| 4. 解析形状 | neg-catch.js | **命中**（文档级） | `tryParseJson` 注释断言"JSON.parse 永远不会返回 null"，**此为事实错误**：实测 `tryParseJson("null")` 返回 `null`，与解析失败返回值无法区分，直接击穿它自己声明的 `=== null` 契约。 |
| 4. 解析形状 | neg-race.js | 不适用 | 无 parse。 |
| 4. 解析形状 | neg-unused.js | 不适用 | 无 parse。 |
| 5. 能力真伪 | queue.js | **命中** | `peek()` 注释称"同优先级时返回最先入队的"（FIFO）。实测 `peek()`/`dequeue()` 用 `>=` 比较，返回**最后**入队者（`first/second/third` → 取出 `third`）。声明的 FIFO 未实现。另 `clear()` JSDoc 写 `@returns {boolean} 总是 true`，实际无 return（`undefined`）。 |
| 5. 能力真伪 | store.js | **命中** | 文件头注释称"带原子写入：先写临时文件再 rename"。实测全库 grep 无 `rename`、无临时文件；`#persist` (L54) 是 `rmSync` 再 `writeFileSync`——先删后写，与"原子"恰好相反。 |
| 5. 能力真伪 | retry.js | **命中** | 注释/公式称 `base * 2^(attempt-1)`，代码 L15 是 `base * Math.pow(2, attempt)`。实测 base=100 时 attempt=1 返回 200 而非 100，整体恒为文档值的 2 倍。 |
| 5. 能力真伪 | worker-pool.js | **命中** | 注释称"以固定并发度跑一组异步任务""最终把所有结果/错误按索引返回"。实测 4 任务/并发 4：任务 10 被执行 4 次，20/30/40 从未执行，`results` 仅索引 0 有值（稀疏）。两个能力声明均未实现。 |
| 5. 能力真伪 | config.js | **命中** | `logLevel` 被解析 + 枚举校验 + 返回（L30-37），但全库 grep 显示**除 config.js 自身外无任何消费方**。纯装饰性配置项。 |
| 5. 能力真伪 | index.js | **命中** | `config.timeoutMs` 注释明确为"单次超时上限"（L34），实际只被当作退避 `maxDelay` 使用；全库无 `AbortSignal`/`AbortController`/`Promise.race`/超时定时器（grep 验证）。超时能力完全未实现。 |
| 5. 能力真伪 | neg-catch.js | 未命中 | 三个函数确实做到了注释所述（删除失败返回 false、解析失败返回 null、关闭失败返回 false）。 |
| 5. 能力真伪 | neg-race.js | 未命中 | `incrementAsync` 在 `await` 前完成读改写，确实无竞态；`batchIncrement` 不变量成立。 |
| 5. 能力真伪 | neg-unused.js | 未命中 | 导出确为公共 API 面，被外部消费属正常设计；非死代码。 |

---

## 发现 25

### 发现 1（严重 · Critical）
- **file**: src/worker-pool.js:18-22
- **类型**: 并发逻辑错误 / 任务漏跑与重复执行
- **严重性**: Critical
- **问题**: `worker()` 先 `const idx = cursor`，再 `await Promise.resolve()`，之后才 `cursor += 1`。`await` 让出执行权，所有 worker 协程都在自增前读到**同一个** `cursor` 值。并发 N 时，前 N 个 worker 全部拿到 `idx=0`，重复执行 `tasks[0]`；随后每轮同理集体跳号。
  - 后果：典型输入 `runWithConcurrency([10,20,30,40], 4, fn)` → 只执行 `10` 四次，`20/30/40` 永不执行；`results` 成为稀疏数组，`JSON.stringify` 输出 `[]`。依赖"每个任务跑一次、结果按索引对齐"的调用方会静默丢数据。
- **证据**: `t4-index.mjs` / `t3-rest.mjs` 实测：
  - `seen => [10,10,10,10]`；`results => [{"ok":true,"value":10},null,null,null]`
  - `assigned indices => ["0"]`；`has holes => false`（`every` 跳过空位，进一步掩盖）
  - 并发=1 时正常（`seen => [1,2,3]`），证明问题只在 `concurrency > 1` 出现。

### 发现 2（严重 · Critical）
- **file**: src/index.js:28（配合 L23-26、L30）
- **类型**: 逻辑错误 / 任务全部丢弃
- **严重性**: Critical
- **问题**: `processTasks` 先把所有 task 入队到局部 `queue`，随后 `tasks.length = 0` 清空**原始数组**，再把同一个（已清空的）`tasks` 传给 `runWithConcurrency`。队列从头到尾没有任何出队/消费逻辑，等于把任务搬进一个垃圾桶再清空源。
  - 后果：任何非空任务列表 → handler 调用 0 次 → 返回 `[]`。调用方以为批处理成功。
  - 附带：`processTasks([])` 因 `capacity: 0` 触发队列构造抛 `TypeError`（发现 5）。
- **证据**: `t4-index.mjs`：
  - `tasks=[{id:'a'},{id:'b'},{id:'c'}]` → `handler call count => 0`、`returned => []`、`original tasks.length => 0`。
  - 空数组 → `THREW TypeError: capacity must be a positive number`。

### 发现 3（高 · High）
- **file**: src/queue.js:34
- **类型**: 边界 off-by-one
- **严重性**: High
- **问题**: `if (this.#items.length > this.#capacity) return false;` 判断在 push **之前**，应使用 `>=`。实际可装入 `capacity + 1` 个元素，容量上限形同虚设。
- **证据**: `t1-queue.mjs`：`capacity=2` → push1/push2/**push3 全 true**，最终 `size => 3`。

### 发现 4（高 · High）
- **file**: src/queue.js:9
- **类型**: 数值边界校验不完整
- **严重性**: High
- **问题**: `typeof capacity !== 'number' || capacity <= 0` 无法排除 `NaN`（`NaN<=0` 为 false）、`Infinity`、小数。`NaN` 容量会让 L34 的 `length > NaN` 恒为 false，队列永久无上限。
- **证据**: `t1-queue.mjs`：`capacity=NaN → accepted 20（未拒绝）`、`Infinity → accepted 20`、`1.5 → capacity readback 1.5，实际接受 2 个`、`1.2 → 2 个`、`2.9 → 3 个`。

### 发现 5（高 · High）
- **file**: src/store.js:24
- **类型**: 解析结果未校验形状
- **严重性**: High
- **问题**: `#load` 直接返回 `JSON.parse(raw)`，假定一定是普通对象。JSON 顶层合法但非对象时，实例进入不可用状态或静默损坏：
  - `null` → `get()`: `TypeError: Cannot use 'in' operator ... in null`；`keys()`、`set()` 同样抛错。
  - `123` / `"str"` / `true` → `get`/`set` 抛 TypeError；字符串的 `keys()` 返回 `["0","1","2"]`（把字符串当对象）。
  - `[1,2,3]` → 静默当 store 使用，`set('b',2)` 后写回仍为数组，原数据语义丢失。
- **证据**: `t2-store.mjs` "P4" 段，六种输入逐一实测，输出如上。

### 发现 6（高 · High）
- **file**: src/store.js:53-55
- **类型**: 能力未实现（原子写入）
- **严重性**: High
- **问题**: 注释声称"先写临时文件再 rename，避免半写状态"，实现是 `rmSync(原文件)` 然后 `writeFileSync`。这是**先删后写**：两次调用之间崩溃 / 写盘失败 → 原文件已删除、新文件未写成 → 全量数据丢失。且没有任何临时文件与 rename。
- **证据**: 全库 `grep -rn "rename"` 仅命中 store.js:2 的注释本身，无任何 `renameSync` 调用。`t2-store.mjs` 观测到第二次 `set` 期间文件确实先消失再出现。

### 发现 7（高 · High）
- **file**: src/retry.js:37 / L47
- **类型**: 数值边界 + 错误对象丢失
- **严重性**: High
- **问题**: `maxAttempts` 只用 `Number.isInteger` 校验，`0` 与负数通过。循环 `attempt=1; attempt <= maxAttempts` 一次都不执行，`lastError` 保持 `undefined`，最终 `throw lastError` 抛出 `undefined`。
  - 后果：调用方 `catch (e)` 拿到的不是 Error，`e.message` 直接二次抛错；日志/监控丢失全部失败上下文。
- **证据**: `t6-edge.mjs`：`maxAttempts=0 / -1 / -100` 全部 `reject value = undefined`，`instanceof Error => false`，且 `fn calls => 0`（函数从未被调用）。

### 发现 8（高 · High）
- **file**: src/config.js:13-20
- **类型**: 数值边界校验不完整
- **严重性**: High
- **问题**: 函数名与错误信息都声称 "positive integer"，实际只检查 `Number.isInteger`。接受 `0` 与负数。
  - 下游后果：`concurrency=0` → worker-pool 抛错；`retryMax=-1` → retry 抛 `undefined`（发现 7）；`timeoutMs=0` 静默通过。
  - 附带：`'   '` → `Number('   ')===0` 被当作合法 0；`'0x10'`→16、`'1e3'`→1000、`'+3'`→3，环境变量语义被放宽。
- **证据**: `t3-rest.mjs`：`'0'→0`、`'-5'→-5`、`'-0'→0`、`'   '→0`、`'0x10'→16`、`'1e3'→1000` 全部 OK。

### 发现 9（高 · High）
- **file**: src/index.js:34
- **类型**: 能力未实现（超时）
- **严重性**: High
- **问题**: `config.timeoutMs` 被注释定义为"单次超时上限"，但唯一用途是传给 retry 当 `maxDelay`（退避上限）。整个代码库没有任何超时/中断实现：无 `AbortSignal`、无 `AbortController`、无 `Promise.race`、无针对单次调用的定时器。慢 handler 会无限期挂起。
- **证据**: 全库 `grep -rn "setTimeout|AbortSignal|AbortController|Promise.race|signal|timeout"`：仅命中 config 字段、index 的该行注释、retry 的 sleep 定时器、neg-race 的 sleep。无一处实现调用超时。

### 发现 10（中 · Medium）
- **file**: src/store.js:31
- **类型**: 返回值暴露内部引用
- **严重性**: Medium
- **问题**: `get(key)` 返回内部对象本体。调用方修改返回值即修改 store 内存状态，且**不落盘**，造成内存与磁盘长期不一致；下一次其他 key 的 `set()` 才会把被污染的对象一起写出去。
- **证据**: `t2-store.mjs`：`get('obj').n = 777` 后 `internal value => 777`，而 `on-disk value => 1`。

### 发现 11（中 · Medium）
- **file**: src/store.js:31 vs L40
- **类型**: 同族守卫不一致 / 原型链泄漏
- **严重性**: Medium
- **问题**: `get` 用 `in`（含原型链），`delete` 用 `hasOwnProperty`（仅自有）。`get('toString')`、`get('constructor')`、`get('hasOwnProperty')` 返回原生函数；`delete('toString')` 返回 false；`keys()` 不列出它们。调用方用 `in`/`hasOwnProperty` 判断存在性会得到互相矛盾的结论。
- **证据**: `t2-store.mjs` "P2" 段：`typeof get('toString') => function`、`delete('toString') => false`、`keys() => []`。

### 发现 12（中 · Medium）
- **file**: src/store.js:35
- **类型**: 原型污染（实例级）
- **严重性**: Medium
- **问题**: `set('__proto__', {...})` 走普通赋值，改写 `this.#data` 的原型而非写入自有属性。之后 `get()` 会从原型读到注入值，`keys()` 看不到，持久化时该字段被丢弃——内存与磁盘再次分叉。未污染全局 `Object.prototype`（`({}).polluted === undefined`），但实例已被劫持。
- **证据**: `t6-edge.mjs`：`set('__proto__',{polluted:'yes'})` → `get('polluted') => yes`、`keys() => []`、文件内容 `{}`、重载后 `get('polluted') => undefined`。

### 发现 13（中 · Medium）
- **file**: src/index.js:38
- **类型**: 返回形状 / 失败不可区分
- **严重性**: Medium（叠加发现 1 后升为 Critical 的表现）
- **问题**: 直接 `return raw`，不检查每项 `{ok:false,error}`。调用方拿到的数组里成功与失败混排，且失败项携带原始 error 引用。叠加发现 1 的稀疏化后，`JSON.stringify` 把空洞抹掉，失败信息彻底消失。
- **证据**: `t6-edge.mjs`：`JSON.stringify(res2) => []`；`res2[0] => undefined`，尽管 handler 中 `a` 明确抛了错。

### 发现 14（中 · Medium）
- **file**: src/config.js:30
- **类型**: 能力未实现（logLevel）
- **严重性**: Medium
- **问题**: `logLevel` 被解析、枚举校验、随配置返回，但全库无任何模块读取它。配置项声称的日志级别能力完全不存在。
- **证据**: `grep -rn "logLevel" src/` 仅命中 config.js 自身（L7/30/31/33/37）；`index.js` 只用 `concurrency`/`retryMax`/`timeoutMs`。

### 发现 15（中 · Medium）
- **file**: src/queue.js:69
- **类型**: 返回值暴露内部引用
- **严重性**: Medium
- **问题**: `peek()` 返回队列内部对象本体。调用方修改它等于直接篡改队列中待处理任务的 `id`/`priority`，后续 `dequeue()` 与 `remove(id)` 都会基于被污染的数据工作。
- **证据**: `t1-queue.mjs`：改 `peek().id='HACKED'` 后 `dequeue().id => HACKED`。

### 发现 16（中 · Medium）
- **file**: src/queue.js:37-41
- **类型**: 浅拷贝导致嵌套状态共享
- **严重性**: Medium
- **问题**: `{...task}` 只复制第一层，`task.payload` 等嵌套对象仍与调用方共享。调用方事后修改原对象会改变队列内任务；反之亦然。
- **证据**: `t1-queue.mjs`：外部改 `orig.payload.n=42`、内部改 `peek().payload.n=99`，两侧读到同一个 `99`。

### 发现 17（中 · Medium）
- **file**: src/queue.js:53 / L65
- **类型**: 能力未实现（FIFO） / 文档与实现不符
- **严重性**: Medium
- **问题**: 注释明确"同优先级按 FIFO""同优先级时返回最先入队的"，实现用 `>=` 比较，同优先级时 `bestIdx` 被后者不断覆盖，实际是 **LIFO**（后入先出）。优先级队列在同级下的顺序保证不成立。
- **证据**: `t1-queue.mjs`：依次入队 `first/second/third`（同 priority 5）→ `peek().id => third`、`dequeue().id => third`。

### 发现 18（中 · Medium）
- **file**: src/retry.js:12-13
- **类型**: 数值边界校验不完整
- **严重性**: Medium
- **问题**: `base <= 0` 不能拦 NaN；`maxDelay < base` 也不能拦 NaN。实测 `base:NaN` 静默回退到 30000，`maxDelay:NaN` 让函数返回 `NaN`（下游 `setTimeout(NaN)` 变成 0ms 忙等）。
- **证据**: `t6-edge.mjs`：`base=NaN => 30000`、`maxDelay=NaN => NaN`。

### 发现 19（中 · Medium）
- **file**: src/index.js:23
- **类型**: 守卫缺失 / 空输入崩溃
- **严重性**: Medium
- **问题**: `processTasks` 不校验 `tasks` 是数组。`tasks=[]` 时 `capacity: 0` 触发队列构造抛 `TypeError`；`tasks='str'` 时 `'str'.length=3` 构造成功、for-of 逐字符入队（每字符无 id → 抛错）。错误信息指向 `capacity`，与真实原因（空任务列表）完全无关，误导排查。
- **证据**: `t4-index.mjs`：`tasks=[] → THREW TypeError: capacity must be a positive number`。

### 发现 20（低 · Low）
- **file**: src/neg-catch.js:30 / L32-38
- **类型**: 注释事实错误 / 契约被击穿
- **严重性**: Low
- **问题**: 注释断言"JSON.parse 永远不会返回 null"，这是错的。`JSON.parse('null') === null`。因此 `tryParseJson('null')` 返回 `null`，与"解析失败"的哨兵值完全重合，它声明的"用 `=== null` 明确区分"不成立。
- **证据**: `t5-final.mjs`：`tryParseJson("null") => null | ===null: true`（与 `tryParseJson("{bad")` 无法区分）；而 `tryParseJson("123") => 123`、`"\"str\""`、`"[1,2,3]"`、`"true"` 均非 null。

### 发现 21（低 · Low）
- **file**: src/queue.js:73
- **类型**: 同族守卫不一致
- **严重性**: Low
- **问题**: `enqueue` 强制 `task.id` 为非空字符串，`remove(id)` 对入参零校验。传 `undefined`/`null`/数字时静默返回 false，调用方无法区分"没找到"与"传错了"。
- **证据**: `t5-final.mjs`：`remove(undefined) => false`、`remove(null) => false`、`remove(123) => false`，均不抛错；对照 `enqueue({id:123})` 抛 `TypeError`。

### 发现 22（低 · Low）
- **file**: src/queue.js:84-86
- **类型**: 返回值契约不符
- **严重性**: Low
- **问题**: JSDoc 声明 `@returns {boolean} 总是 true`，函数体无 `return`，实际返回 `undefined`。调用方 `if (queue.clear())` 恒为假。
- **证据**: `t1-queue.mjs`：`clear() return (JSDoc: boolean true) => undefined`。

### 发现 23（低 · Low）
- **file**: src/retry.js:15
- **类型**: 文档与实现不符（数值）
- **严重性**: Low
- **问题**: 注释公式 `base * 2^(attempt-1)`，代码为 `base * Math.pow(2, attempt)`，实际值恒为文档的 2 倍。对依赖文档计算重试总时长的调用方造成系统性偏差。
- **证据**: `t6-edge.mjs`：base=100 时 attempt=1 返回 `200`（应为 100），attempt=2 `400`，attempt=3 `800`。

### 发现 24（低 · Low）
- **file**: src/retry.js:25-35
- **类型**: 同族守卫不一致
- **严重性**: Low
- **问题**: `retry(fn, opts)` 不校验 `fn`/`shouldRetry`/`sleep` 的类型。`shouldRetry` 传字符串时不会立即报错，要等到第一次失败重试时才抛 `TypeError`——错误点与错误源相距很远。
- **证据**: `t3-rest.mjs`：`retry(fn, {shouldRetry:'nope'})` 在 fn 成功时不报错；fn 抛错时 `THREW TypeError: shouldRetry is not a function`。

### 发现 25（低 · Low）
- **file**: src/neg-catch.js:15-16
- **类型**: 同族守卫不一致
- **严重性**: Low
- **问题**: `tryRemoveTemp(path)` 缺少 `tryParseJson`/`safeClose` 都有的类型守卫。非法入参靠 `fs.existsSync` 内部容错返回 false，并触发 Node 的 `DEP0187` 弃用警告，污染 stderr。
- **证据**: `t5-final.mjs`：`tryRemoveTemp(123) => false` 并输出 `DeprecationWarning: Passing invalid argument types to fs.existsSync is deprecated`。

---

## 总结

| 严重性 | 数量 |
|---|---|
| Critical | 2 |
| High | 7 |
| Medium | 10 |
| Low | 6 |
| **合计** | **25** |

**最该先修的三条**：
1. `worker-pool.js` 的 `cursor` 竞态（发现 1）——并发>1 时任务漏跑+重跑，结果数组稀疏。
2. `index.js` 的 `tasks.length = 0`（发现 2）——任务全部丢弃，批处理恒返回空。
3. `store.js` 的"假原子写"（发现 6）——先删后写，写盘失败即全量数据丢失。

**关于三个 neg 文件**：`neg-catch.js`、`neg-race.js`、`neg-unused.js` 的核心逻辑确实无缺陷，不应报为 bug。但 `neg-catch.js` 的注释存在事实错误（发现 20），且 `tryRemoveTemp` 守卫不一致（发现 25）——这两条是**注释/一致性问题**，不是功能缺陷，评级为 Low。
