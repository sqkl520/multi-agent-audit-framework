# P2 审计报告 — iso-p2 任务队列服务

审计对象：`<HOME>\AppData\Local\Temp\iso-p2\code\`（9 个文件，465 行）
方法：全部读完 + 每个假设都用 `node` 实跑验证（探针脚本写在 `%TEMP%\iso-p2-audit\`，未改动被测代码）

## 模式检查结果

| 模式 | 文件 | 命中/未命中/不适用 | 说明 |
|---|---|---|---|
| 1. 返回值暴露 | queue.js | 命中 | `peek()` 第 69 行 `return this.#items[bestIdx]` 直接返回内部对象；调用方改 `peek().priority` 后内部排序立即被篡改（实测改完后 `dequeue()` 吐出了错误的任务） |
| 1. 返回值暴露 | store.js | 命中 | `get()` 第 31 行 `return this.#data[key]` 返回内部引用；对返回值改嵌套字段，store 内存态同步被改（磁盘未变，出现内存/磁盘分叉） |
| 1. 返回值暴露 | config.js | 未命中 | 返回全新字面量对象，字段全是 primitive |
| 1. 返回值暴露 | index.js | 未命中 | `return raw` 是 `runWithConcurrency` 新建的数组，非内部状态 |
| 1. 返回值暴露 | retry.js | 不适用 | 无内部状态，只返回 `fn` 的返回值/抛错 |
| 1. 返回值暴露 | worker-pool.js | 未命中 | `results` 为函数内新建数组；错误对象是新捕获的引用，不指向模块状态 |
| 1. 返回值暴露 | neg-catch.js | 未命中 | `tryParseJson` 返回 `JSON.parse` 新建的值；其余返回 boolean |
| 1. 返回值暴露 | neg-race.js | 未命中 | `value` getter 返回 number primitive |
| 1. 返回值暴露 | neg-unused.js | 未命中 | `normalizeError` 返回新字面量；`ERROR_CODES` 已 `Object.freeze` |
| 2. 守卫一致性 | queue.js | 命中 | `enqueue()`（31 行）校验 `task.id` 为非空字符串；做同类事情的 `remove(id)`（73 行）完全不校验 id。`enqueue(123)` 抛错、`remove(123)` 静默返回 false |
| 2. 守卫一致性 | store.js | 命中 | `get()`（31 行）用 `key in this.#data`，`delete()`（40 行）却用 `hasOwnProperty` —— 同一个「键是否属于本 store」的判断两套语义，导致 `get('toString')` 返回原型链上的函数而 `delete('toString')` 返回 false。`set()` 对 key 也无任何校验 |
| 2. 守卫一致性 | config.js | 未命中 | concurrency/timeoutMs/retryMax 三个字段走同一个 `parsePositiveInt`，校验完全一致 |
| 2. 守卫一致性 | index.js | 命中 | 第 18 行校验了 `handler` 必须是函数，但第 23-30 行对 `tasks` 不做 `Array.isArray` 校验，直接 `.length`/`for...of`。`processTasks(null)` 报 `Cannot read properties of null (reading 'length')`，`processTasks({})` 报 `tasks is not iterable` —— 错误信息对调用方毫无指向性 |
| 2. 守卫一致性 | retry.js | 命中 | `backoffDelay()`（9 行）严格校验 `Number.isInteger(attempt) && attempt >= 1`；做同类边界判断的 `retry()`（32 行）只校验 `Number.isInteger(maxAttempts)`，漏掉正数校验 |
| 2. 守卫一致性 | worker-pool.js | 未命中 | tasks / concurrency / runner 三个参数全部有类型校验，且都用了正确的 `Number.isInteger` |
| 2. 守卫一致性 | neg-catch.js | 未命中 | `tryRemoveTemp` 未校验 path 类型，但 `existsSync(null/123/{})` 返回 false 而非抛错，语义上安全；`tryParseJson`/`safeClose` 均有类型校验。无实际缺陷 |
| 2. 守卫一致性 | neg-race.js | 未命中 | `batchIncrement` 校验 count；其余方法无参数 |
| 2. 守卫一致性 | neg-unused.js | 未命中 | `isValidTask` 的判定与 queue 的 `enqueue` 一致（object + 非空 string id） |
| 3. 数值边界 | queue.js | 命中 | `capacity` 只判 `typeof === 'number' && > 0`。实测接受 `NaN`、`Infinity`、`0.5`、`1.5`（`capacity=NaN` 时容量检查恒 false，队列无限增长）；`-0` 被拒。容量检查本身还有 off-by-one |
| 3. 数值边界 | store.js | 不适用 | 无数值参数 |
| 3. 数值边界 | config.js | 命中 | `parsePositiveInt` 只判 `Number.isInteger`，名字里的 positive 没实现：`0`、`-5` 原样放行；`NaN`/`Infinity`/`0.5` 被拒；`'0x10'`→16、`'1e3'`→1000、`' 7 '`→7 也接受。实测 `CONCURRENCY=0` 返回 `{concurrency:0}`，随后在 worker-pool 才炸，错误被推迟到另一个模块 |
| 3. 数值边界 | index.js | 命中 | 自身不做数值校验；`capacity: tasks.length` 对空数组传 0，直接命中 queue 构造器的 `capacity > 0` 断言抛 TypeError（`processTasks([])` 实测抛错）。`config.concurrency` 也不在入口把关，0 一路带到 worker-pool |
| 3. 数值边界 | retry.js | 命中 | `backoffDelay`：`attempt` 校验完整（0/负数/小数/NaN 全拒）；但 `base=NaN` 通过（`NaN <= 0` 为 false）、`base=Infinity` 通过、`maxDelay=NaN` 通过（`NaN < base` 为 false），实测返回 `NaN` 毫秒延迟。`retry`：`maxAttempts` 接受 0 和负数 |
| 3. 数值边界 | worker-pool.js | 未命中 | `concurrency` 用 `Number.isInteger && >= 1`，0 / 负数 / NaN / Infinity / 1.5 / null / undefined / '2' 全部拒绝（逐个实测）。唯一缺口是没有上界，见「非缺陷观察」 |
| 3. 数值边界 | neg-catch.js | 不适用 | 无数值参数 |
| 3. 数值边界 | neg-race.js | 未命中 | `count` 拒绝负数/小数/NaN/Infinity，接受 0（符合「累加 0 次」的语义），校验完整 |
| 3. 数值边界 | neg-unused.js | 不适用 | 无数值参数 |
| 4. 解析结果形状 | queue.js | 不适用 | 无 JSON 解析 |
| 4. 解析结果形状 | store.js | 命中 | `#load()` 第 24 行 `return JSON.parse(raw)` 不校验形状。实测：文件为 `null` → 构造成功但 `get()` 抛 `Cannot use 'in' operator to search for 'a' in null`；`123`/`"str"`/`true` → 同样抛；`[1,2,3]` → 构造成功，`keys()` 返回 `["0","1","2"]`，`set('k',1)` 静默成功并把数组当对象用。构造期不报错，故障推迟到第一次使用 |
| 4. 解析结果形状 | config.js | 不适用 | 只读 `process.env` 字符串，无文件解析 |
| 4. 解析结果形状 | index.js | 不适用 | 无解析 |
| 4. 解析结果形状 | retry.js | 不适用 | 无解析 |
| 4. 解析结果形状 | worker-pool.js | 不适用 | 无解析 |
| 4. 解析结果形状 | neg-catch.js | 未命中 | `tryParseJson` 不校验形状，但这是接口契约（失败返回 null），且注释明示；唯一歧义是 `tryParseJson('null')` 返回 null 与解析失败不可区分，作者已在注释中说明。不构成缺陷 |
| 4. 解析结果形状 | neg-race.js | 不适用 | 无解析 |
| 4. 解析结果形状 | neg-unused.js | 不适用 | 无解析 |
| 5. 能力是否实现 | queue.js | 未命中 | `capacity` 被构造器、getter、enqueue 三处真实使用；`priority` 真实参与排序。`enqueuedAt` 写入后无人读，但属元数据非能力声明 |
| 5. 能力是否实现 | store.js | 命中 | 文件头第 2 行声称「带原子写入：先写临时文件再 rename，避免半写状态」，`#persist()` 第 54-55 行实际是 `rmSync` 原文件再 `writeFileSync`，**先删后写**，与原子写入相反 |
| 5. 能力是否实现 | config.js | 命中 | `logLevel` 被解析、被白名单校验、被返回，但全仓库 grep 只有 config.js 内部出现，没有任何 logger 消费它 —— 一个只被读、从未被用的配置项 |
| 5. 能力是否实现 | index.js | 命中 | `timeoutMs`（名字与默认 30000 都指向「单次调用超时」）在第 34 行被当成**退避上限** `maxDelay` 传给 retry，全仓库无任何超时实现。实测 `TIMEOUT_MS=1` + 300ms 的 handler：既不超时也不报错 |
| 5. 能力是否实现 | retry.js | 命中 | 第 6 行注释「base * 2^(attempt-1)」，第 15 行实现 `base * Math.pow(2, attempt)` —— 声称的退避曲线没有实现，实际是 2 倍于文档值 |
| 5. 能力是否实现 | worker-pool.js | 命中 | 文件头与函数注释声称「以固定并发度跑」，第 19-21 行把 `cursor += 1` 放在 `await` 之后，并发度 >= 2 时同一索引被多个 worker 领取，实际既非固定并发也非每任务一次 |
| 5. 能力是否实现 | neg-catch.js | 未命中 | 无能力声明；三个函数的「吞异常」均有返回值区分成功/失败，与注释一致 |
| 5. 能力是否实现 | neg-race.js | 未命中 | 注释声称的原子性与实测一致：1000 次并发 `incrementAsync` 后 `value === 1000` |
| 5. 能力是否实现 | neg-unused.js | 未命中 | 「零引用」是刻意的公共 API，`normalizeError`/`isValidTask`/`ERROR_CODES`/`VERSION` 被 export，非死代码 |

## 发现 1
- **file**: src/index.js:28
- **类型**: data-consistency
- **严重性**: CRITICAL
- **问题**: `processTasks` 在 24-26 行把 `tasks` 逐个 enqueue 进 `queue`，紧接着 28 行 `tasks.length = 0` 清空**调用方传入的同一个数组**，30 行才把这个已经空掉的数组交给 `runWithConcurrency`。队列 `queue` 此后再也没被读取。结果：任何非空任务列表都一个任务都不跑，直接返回 `[]`，且调用方的数组被就地清空（副作用外泄）。24 行 `queue.enqueue(t)` 的返回值也被丢弃，队列纯属摆设。
- **证据**: `processTasks([{id:'a'},{id:'b'}], {handler})` → handler 调用次数 0，`done = []`，返回 `[]`，调用方 `tasks.length` 变为 0。单任务、空 config、带 config 三种调用方式结果相同。附带后果：`processTasks([])` 因 23 行 `capacity: 0` 先抛 `TypeError: capacity must be a positive number`，连空批次都无法正常返回。

## 发现 2
- **file**: src/queue.js:51-53
- **类型**: logic
- **严重性**: HIGH
- **问题**: `dequeue()` 的择优条件用 `>=`，遇到同优先级时不断把 `bestIdx` 推到更靠后的元素，于是同优先级变成 LIFO。注释（第 47 行「同优先级按 FIFO」、第 60 行「返回最先入队的」）与实现相反。对任务队列而言这会饿死早入队的任务。
- **证据**: 依次 enqueue `first/second/third`（同优先级）→ `dequeue()` 顺序为 `third,second,first`；`peek()` 返回 `third`。`peek()` 第 65 行有同样的 `>=`。

## 发现 3
- **file**: src/queue.js:34
- **类型**: error-handling
- **严重性**: MEDIUM
- **问题**: 容量检查写成 `if (this.#items.length > this.#capacity)`，在 push 之前判断，实际允许装入 `capacity + 1` 个元素。`capacity` 是硬上限语义，越界一个对下游的背压/内存估算都是错的。
- **证据**: `new TaskQueue({capacity:2})` 连续 enqueue 4 次 → `true,true,true,false`，`size` 达到 3 才拒绝。`capacity:1` 时同样装下 2 个。index.js 第 23 行用 `capacity: tasks.length` 正是为了「永远塞不满」，被这个 off-by-one 兜住，掩盖了溢出。

## 发现 4
- **file**: src/queue.js:9-10
- **类型**: error-handling
- **严重性**: MEDIUM
- **问题**: `capacity` 只校验 `typeof capacity === 'number' && capacity <= 0`。`typeof NaN === 'number'` 为真、`NaN <= 0` 为假，所以 `NaN` 通过；`Infinity > 0` 通过；小数 `0.5`/`1.5` 通过。`capacity=NaN` 时第 34 行 `length > NaN` 恒为 false，队列**永不拒绝**，内存无上限；`capacity=0.5` 时限装 1 个，`1.5` 时限装 2 个，行为不可预期。
- **证据**: `new TaskQueue({capacity:NaN})` 连 enqueue 5 个全返回 `true`，`size=5`；`Infinity` 同样全过；`0.5` → `true,false,false...`（装 1 个）；`1.5` → 装 2 个；`-0` 被正确拒绝。

## 发现 5
- **file**: src/queue.js:69
- **类型**: data-consistency
- **严重性**: MEDIUM
- **问题**: `peek()` 返回队列内部对象的**活引用**而非副本。调用方对返回值做任何修改（改 priority、改 id）都会直接改写队列内部状态，破坏排序不变量；改 id 后 `remove(原id)` 再也找不到该任务，任务变成既删不掉也认不出的僵尸。
- **证据**: enqueue `{id:'low',priority:1}`、`{id:'high',priority:5}` → `peek()` 得 high；调用方执行 `p.priority = -999; p.id='HIJACKED'` → 再 `peek()` 返回的是 low，`dequeue()` 也先吐出 low（高优先级任务被调用方"降级"了）。另测：`peek().id = 'zzz'` 后 `remove('a')` 返回 false。

## 发现 6
- **file**: src/queue.js:73-74
- **类型**: contract
- **严重性**: LOW
- **问题**: `remove(id)` 与 `enqueue(task)` 做同一类入参校验，但 `remove` 完全不校验 id 类型。`enqueue` 对 `id` 要求「非空 string」，`remove` 收到 `123`/`null`/对象时静默返回 false —— 调用方无法区分「没有这个 id」和「传错了类型」，误用被永久掩盖。
- **证据**: `remove(123)` → `false`；`remove(null)` → `false`；而 `enqueue({id:''})` → `TypeError: task.id must be a non-empty string`。两者守卫强度不一致。

## 发现 7
- **file**: src/queue.js:84-86
- **类型**: contract
- **严重性**: LOW
- **问题**: `clear()` 的 JSDoc 明确写 `@returns {boolean} 总是 true`，实现里没有 `return`，实际返回 `undefined`。调用方若按文档写 `if (queue.clear())` 永远走 false 分支。
- **证据**: `new TaskQueue().clear()` → `undefined`（`node` 实测）。文档与返回值直接矛盾。

## 发现 8
- **file**: src/retry.js:15-18
- **类型**: logic
- **严重性**: HIGH
- **问题**: 注释与函数名约定的退避是 `base * 2^(attempt-1)`（attempt 从 1 开始，首次重试等 base），实现写成 `base * Math.pow(2, attempt)`，整体翻倍。所有重试的实际等待时间是设计值的 2 倍，叠加在多层重试上会显著放大故障时的恢复延迟，也会让 `maxDelay` 提前触顶。
- **证据**: `backoffDelay(1,{base:100,maxDelay:1e6})` → 200（文档公式 100）；attempt=2 → 400（文档 200）；3 → 800；4 → 1600。全部是文档值的 2 倍。

## 发现 9
- **file**: src/retry.js:32-34
- **类型**: error-handling
- **严重性**: MEDIUM
- **问题**: `maxAttempts` 只校验 `Number.isInteger`，不校验 `>= 1`。传 0 或负数时 for 循环一次都不进，函数体直接走到 `throw lastError`，而 `lastError` 从未赋值 —— **`throw undefined`**。调用方 `catch (e)` 拿到的 `e` 是 undefined，`e.message` 立刻二次抛错，原始上下文彻底丢失。这个值来自 `config.retryMax`，而 config 恰好允许 `RETRY_MAX=0`，两个缺陷可以串起来。
- **证据**: `maxAttempts=0` → 抛出值 `undefined`（`e === undefined` 为 true，`e instanceof Error` 为 false），fn 调用次数 0；`maxAttempts=-1` 相同；`Infinity`/`NaN`/`1.5` 被正确拒绝。经 `loadConfig({RETRY_MAX:'0'})` 得到的 0 直接复现。

## 发现 10
- **file**: src/config.js:16-18
- **类型**: logic
- **严重性**: HIGH
- **问题**: 函数叫 `parsePositiveInt`，错误信息也写 "must be a positive integer"，但只判断 `Number.isInteger(n)`，没判断 `n > 0`。`0` 和所有负数原样通过，`-0` 也变成 0。后果按字段不同：`CONCURRENCY=0` 让 `loadConfig` 成功返回，直到 `runWithConcurrency` 才抛 RangeError（错误位置离配置源很远）；`TIMEOUT_MS=0` 让 `maxDelay=0`，退避全部退化为立即重试；`RETRY_MAX=0` 触发发现 9 的 `throw undefined`。配置层是唯一的集中校验点，这里漏了等于全线漏。
- **证据**: `loadConfig({CONCURRENCY:'0'})` → `{concurrency:0}` 无异常；`'-5'` → `-5`；`'-0'` → `0`。对照：`'NaN'`、`'Infinity'`、`'0.5'` 被正确拒绝，说明作者知道要拦这些，只是漏了符号。另测 `CONCURRENCY=0`（number 类型）→ `0`，`false`/`[]`/`null` → `0`。

## 发现 11
- **file**: src/config.js:11
- **类型**: contract
- **严重性**: MEDIUM
- **问题**: `VALID_LOG_LEVELS = ['debug','info','error']` 漏掉 `'warn'`。日志级别是通用约定（debug/info/warn/error），使用方设 `LOG_LEVEL=warn` 会在启动时被当成非法值抛错，整个服务起不来；而 `warn` 恰恰是生产环境最常用的级别。这是「比承诺更严格」的校验，属于契约缺陷。
- **证据**: `loadConfig({LOG_LEVEL:'warn'})` → `TypeError: logLevel must be one of debug|info|error, got: warn`。`'INFO'`、`'debug '`（尾空格）也被拒，无 trim/大小写归一。

## 发现 12
- **file**: src/store.js:19
- **类型**: data-consistency
- **严重性**: MEDIUM
- **问题**: `#load()` 对 `JSON.parse` 的结果不做形状校验，直接把任意 JSON 值赋给 `#data`。文件内容为 `null`、数字、字符串、布尔时构造函数**不报错**，`this.#data` 变成 primitive，之后 `get()` 的 `key in this.#data` 抛 `TypeError`、`keys()` 抛 `Cannot convert undefined or null to object`、`set()` 抛 `Cannot create property ... on number`。故障从构造期推迟到首次使用，堆栈指向 store 内部而不是真正的坏文件。文件为数组 `[1,2,3]` 时更隐蔽：构造、`keys()`（返回 `["0","1","2"]`）、`set()` 全部"正常"，数组被当对象写脏。
- **证据**: 分别写入 `null`/`123`/`"str"`/`true`/`[1,2,3]` 后构造 JsonStore：前四种构造成功，`get('a')` 均抛 `Cannot use 'in' operator to search for 'a' in <value>`；数组的 `keys()` 为 `["0","1","2"]`，`set('k',1)` 返回 ok 且数组被改写。`path` 传目录时构造期抛 EISDIR（这个倒是对的）。

## 发现 13
- **file**: src/store.js:25
- **类型**: error-handling
- **严重性**: HIGH
- **问题**: `catch { return {}; }` 把「文件不存在」「文件是空的」和「文件内容损坏」三种情况合并成同一个结果 `{}`。磁盘上一个被截断/写坏的 JSON 会被静默当成空库，随后任何 `set()` 都会用这个空库覆盖原文件 —— **一次读失败直接升级为数据全丢**，且没有任何日志或异常让运维察觉。
- **证据**: 写入 `{bad` 后构造 JsonStore → 构造成功，`keys()` 返回 `[]`；再 `set('a',1)` → 文件被覆写为 `{"a":1}`，原内容不可恢复。对照组：文件不存在时同样返回 `{}`，两种语义无法区分。

## 发现 14
- **file**: src/store.js:31
- **类型**: security
- **严重性**: HIGH
- **问题**: `get()` 用 `(key in this.#data)` 而非 `hasOwnProperty`，`in` 会沿原型链查找。`store.get('toString')`、`get('constructor')`、`get('hasOwnProperty')` 都返回函数而不是 `undefined`；对 `__proto__` 更是直接返回 `Object.prototype`。调用方按「不存在则 undefined」的约定写 `if (v === undefined) v = defaultValue` 会拿到原型上的函数并当数据用；若把 key 来自外部输入，等于开放了原型链读取面。同一文件的 `delete()`（40 行）用的却是 `hasOwnProperty`，进一步说明这是疏漏而非设计。
- **证据**: 空 store 上 `get('toString')` → `function`，`get('constructor')` → `function`，`get('__proto__')` → `[object Object]`；`delete('constructor')` → `false`（因为不是 own property）。`keys()` 不含这些键，`get` 与 `keys` 看到的键集合不一致。

## 发现 15
- **file**: src/store.js:53-55
- **类型**: data-consistency
- **严重性**: HIGH
- **问题**: 文件头第 2 行声称「带原子写入：先写临时文件再 rename，避免半写状态」，`#persist()` 的实际做法是 `rmSync` 删掉原文件、再 `writeFileSync` 写新内容 —— 与原子写入正好相反，存在一个「原文件已删、新文件未写完」的窗口。任何写入异常（序列化失败、磁盘满、进程被杀）都会让数据**从"旧版本"直接变成"不存在"**，而不是"保留旧版本"。注释里的 tmp+rename 一行都没实现。
- **证据**: 写入 `{"keep":"important"}`，再 `set('bad', <循环引用对象>)` → `JSON.stringify` 抛 `Converting circular structure to JSON`，此时文件已被 `rmSync` 删除，`existsSync` 为 false，原数据 100% 丢失；而内存里的 `#data` 仍带着坏值。注释与实现直接矛盾。

## 发现 16
- **file**: src/worker-pool.js:19-22
- **类型**: concurrency
- **严重性**: HIGH
- **问题**: worker 的取号逻辑是 `const idx = cursor; await Promise.resolve(); cursor += 1;` —— 读和写之间夹了一个 `await`。所有 worker 在第一个 tick 都读到相同的 `cursor`，各自 `+1` 相互覆盖。结果：同一个索引被多个 worker 重复领取（任务重复执行）、中间大量索引永远没人处理、`results` 数组留洞。调用方遍历结果时 `results[i].ok` 直接抛 `Cannot read properties of undefined`。文件头「以固定并发度跑一组异步任务」的能力因此完全没有兑现。
- **证据**: 6 个任务、concurrency=2 → runner 实际收到的索引序列 `[0,0,2,2,4,4]`，结果 `[10,null,12,null,14,null]`；concurrency=3 → `[0,0,0,3,3,3]`；concurrency=4 → `[0,0,0,0,4,4,4,4]`。200 次重复运行全部出现空洞（确定性，非偶发）。concurrency=1 时索引为 `[0,1,2,3]` 正常 —— 证明缺陷只在并发 > 1 时触发。

## 发现 17
- **file**: src/index.js:34
- **类型**: contract
- **严重性**: HIGH
- **问题**: `config.timeoutMs`（默认 30000，命名与默认值都指向「单次任务超时」）在第 34 行被当作**退避延迟上限** `maxDelay` 传给 retry，而代码库里没有任何超时实现 —— 没有 `Promise.race`、没有 `AbortController`、没有 `setTimeout` 中断。两个后果：(1) 一个卡死的 handler 会永远挂住，整个批次无法结束；(2) 超时配置实际只控制重试间隔上限，改它不会改变任何超时行为，运维会被误导。注释本身也承认了这一点（"timeoutMs 是单次超时上限，不是退避上限"），却仍然这么用。
- **证据**: `TIMEOUT_MS=1` + 一个耗时 300ms 的 handler → 调用正常返回，耗时 300ms，无超时、无报错。全仓库 grep `timeoutMs` 仅 4 处：config 的默认值、解析、返回，以及 index.js:34 的 maxDelay —— 没有任何一处是超时执行。

## 非缺陷观察（不计入发现，供后续参考）

- `runWithConcurrency` 的 `concurrency` 没有上界。`concurrency=1e7` 被接受，随后一次性 `new Array` 出上千万个 worker Promise，实测直接把 node 打到 `FATAL ERROR: Ineffective mark-compacts near heap limit / JavaScript heap out of memory`。对「固定并发度」的执行器来说这是个可被配置触发的 OOM 面（`CONCURRENCY` 来自环境变量）。未单列为发现，是因为它不属于任务给定的五个模式，且与发现 16 同文件同函数。
- `backoffDelay` 对 `base=NaN`/`maxDelay=NaN` 放行，返回 `NaN`；`setTimeout(fn, NaN)` 被当成 0，退避静默失效。属数值边界问题的延伸，已被发现 10 的同类根因覆盖。
- `tryParseJson('null')` 返回 `null`，与「解析失败」不可区分。注释里作者已明确说明并接受这一权衡，不算缺陷。
- `queue.enqueue` 用 `{...task}` 展开，若 task 的 `priority` 是抛错的 getter，异常会从 enqueue 冒出（实测 `getter blew up`），而 `enqueuedAt` 也会被调用方传入的同名字段覆盖前的顺序问题不存在（展开在前，赋值在后，覆盖是正确的）。
- `neg-catch.js` / `neg-race.js` / `neg-unused.js` 三个文件经逐项验证确认**无缺陷**：空 catch 均有返回值区分成败；`Counter` 的 1000 次并发自增结果为 1000；零引用导出确为公共 API。未在这三个文件中报告任何发现。
- 交叉验证：`processTasks` 因发现 1 永远传入空数组，端到端跑不出发现 9（retryMax=0）和发现 16（并发取号）—— 这两条只能通过直接调用 `retry` / `runWithConcurrency` 复现。审阅时若只做端到端测试会漏掉它们。
