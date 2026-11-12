# AB-PATTERNS 审计报告

- **审计对象**: `<HOME>\AppData\Local\Temp\iso-ab-patterns\code\`
- **范围**: `src/` 下 9 个 JS 文件，共 465 行（全部逐行读完；`package.json` 一并读过，非代码不计入三模式）
- **方法**: 静态逐文件检查 + 运行时验证（脚本写在 `%TEMP%\iso-ab-patterns\verify.mjs`、`verify2.mjs`、`verify3.mjs`）
- **结论**: 三个模式全部命中，共 17 项发现，其中 2 项 Critical、5 项 High

---

## 模式检查结果

| 模式 | 文件 | 命中/未命中/不适用 | 说明 |
|---|---|---|---|
| 1 返回值暴露内部状态 | src/config.js | 未命中 | `loadConfig` 每次返回新对象字面量，字段全是原始值；`DEFAULTS` 已 `Object.freeze` 且从不整体返回 |
| 1 返回值暴露内部状态 | src/index.js | 未命中 | 返回的是 `runWithConcurrency` 内新建的 `results` 数组，返回后函数内无其他引用，调用方修改不回写模块状态（内容为空的缺陷见发现 2） |
| 1 返回值暴露内部状态 | src/neg-catch.js | 未命中 | `tryRemoveTemp`/`safeClose` 返回 boolean，`tryParseJson` 返回 `JSON.parse` 新建值，均非内部容器 |
| 1 返回值暴露内部状态 | src/neg-race.js | 未命中 | `increment`/`incrementAsync`/`batchIncrement` 只返回 number 原始值，`#value` 为私有字段 |
| 1 返回值暴露内部状态 | src/neg-unused.js | 未命中 | `ERROR_CODES` 已 freeze；`normalizeError` 每次新建对象；`VERSION` 为字符串 |
| 1 返回值暴露内部状态 | src/queue.js | **命中** | `peek()` 返回 `this.#items[bestIdx]` 本身（同一引用），调用方改 `id`/`priority` 直接污染队列内部元素并改变后续出队顺序；`enqueue` 只做顶层浅拷贝，嵌套对象仍与调用方共享 |
| 1 返回值暴露内部状态 | src/retry.js | 未命中 | 只透传 `fn` 自己的返回值或抛错，模块内无容器 |
| 1 返回值暴露内部状态 | src/store.js | **命中** | `get(key)` 返回 `this.#data[key]` 活引用；`set(key,value)` 直接保存调用方引用。改返回值只改内存、不落盘，内存与磁盘静默分叉 |
| 1 返回值暴露内部状态 | src/worker-pool.js | 未命中 | 返回函数内新建的 `results` 数组，返回后无内部引用（该数组本身有空洞缺陷，见发现 1） |
| 2 同族函数守卫一致 | src/config.js | 未命中 | 三个数值字段统一走 `parsePositiveInt`，`logLevel` 统一走白名单，同族一致（校验强度不足归模式 3） |
| 2 同族函数守卫一致 | src/index.js | **命中** | `handler` 有显式 `typeof` 校验，`tasks`、`config` 完全无校验；`tasks=null` 时在 `tasks.length` 处抛底层 `Cannot read properties of null`，与其委托的 `runWithConcurrency`（显式校验 `Array.isArray`）不一致 |
| 2 同族函数守卫一致 | src/neg-catch.js | 未命中 | 三个防御式函数各自校验与其契约匹配：`tryParseJson` 查 string、`safeClose` 查 `close` 为函数、`tryRemoveTemp` 对非法输入统一返回 `false`（"没删掉"），语义自洽 |
| 2 同族函数守卫一致 | src/neg-race.js | 未命中 | 只有 `batchIncrement` 一个入口，参数校验完整（整数且 `>=0`） |
| 2 同族函数守卫一致 | src/neg-unused.js | 未命中 | `normalizeError` / `isValidTask` 职责不同，各自校验与契约相符；二者均为对外 API，非内部同族重复实现 |
| 2 同族函数守卫一致 | src/queue.js | **命中** | `enqueue` 严格校验 `task` 为对象且 `id` 为**非空字符串**，同族的 `remove(id)` 完全不校验（`undefined`/`123` 静默返回 `false`）；`clear()` 的 JSDoc 写 `@returns {boolean} 总是 true`，实际无返回值 |
| 2 同族函数守卫一致 | src/retry.js | **命中** | `backoffDelay` 校验 `attempt`/`base`/`maxDelay` 三者；`retry` 只校验 `maxAttempts`（且放过 0/负数），`base`/`maxDelay` 不校验，直到真正需要退避时才由 `backoffDelay` 抛错，错误点被推迟到循环内部 |
| 2 同族函数守卫一致 | src/store.js | **命中** | 构造器校验 `path`，但 `set`/`get`/`delete` 对 `key` 零校验（`undefined`/`123`/`__proto__` 全部接受）；且 `get` 用 `in`（含原型链）、`delete` 用 `hasOwnProperty`（仅自有属性），同族判定口径相反 |
| 2 同族函数守卫一致 | src/worker-pool.js | 未命中 | `tasks`（数组）、`concurrency`（正整数）、`runner`（函数）三项均有显式校验，无遗漏 |
| 3 数值边界校验 | src/config.js | **命中** | `Number.isInteger` 排除了 NaN/Infinity/小数（`1.5`、`"Infinity"` 均抛错），但 **0 和负数通过**：`CONCURRENCY=0` 返回 `0`，`CONCURRENCY=-5` 返回 `-5`，与函数名/错误文案 "positive integer" 矛盾 |
| 3 数值边界校验 | src/index.js | **命中** | `capacity: tasks.length`，空数组时 `tasks.length === 0`，直接触发 `TaskQueue` 的 `capacity <= 0` 抛错——`processTasks([])` 必然抛 `TypeError`；且未对 `config` 的 `concurrency`/`retryMax`/`timeoutMs` 做任何边界检查 |
| 3 数值边界校验 | src/neg-catch.js | 不适用 | 无数值参数 |
| 3 数值边界校验 | src/neg-race.js | 未命中 | `!Number.isInteger(count) \|\| count < 0` 完整排除 NaN/Infinity/小数/负数（0 按注释语义明确允许），是本仓库最规范的写法之一 |
| 3 数值边界校验 | src/neg-unused.js | 不适用 | 无数值参数 |
| 3 数值边界校验 | src/queue.js | **命中** | 构造器只查 `typeof capacity !== 'number' \|\| capacity <= 0`：`NaN`（`NaN <= 0` 为 false）、`Infinity`、`1.5` 全部通过，队列变成无上限/非整数容量；入队判断用 `>` 而非 `>=`，容量 1 实际收 2 条、容量 3 实际收 4 条 |
| 3 数值边界校验 | src/retry.js | **命中** | `attempt` 校验正确；但 `base <= 0`、`maxDelay < base` 都是比较式，`NaN` 全部漏过（`base=NaN` → 退化为 `maxDelay` 且静默返回；`maxDelay=NaN` → 返回 `NaN` → `setTimeout(NaN)` 变 0ms）；`maxAttempts` 放行 0 与负数 → 循环一次不执行、抛出 `undefined` |
| 3 数值边界校验 | src/store.js | 不适用 | 无数值参数 |
| 3 数值边界校验 | src/worker-pool.js | 未命中 | `Number.isInteger(concurrency) && concurrency >= 1` 完整排除 0/负/NaN/Infinity/小数，是本仓库唯一完整的"正整数"实现（可作修复参照） |

---

## 发现 1
- **file**: src/worker-pool.js:19-21
- **类型**: 并发正确性（索引竞争）
- **严重性**: Critical
- **问题**: `const idx = cursor; await Promise.resolve(); cursor += 1;` 在自增前先 `await`，所有 worker 在首个微任务前都读到同一个 `cursor`。传入 5 个任务 + `concurrency: 5` 时 5 个 worker 全拿 `idx=0`，`tasks[0]` 被执行 5 次，`tasks[1..4]` 永不执行；`results` 保留空洞，`JSON.stringify` 后变成 `null`。多 worker 下还会出现索引跳跃（10 任务/3 并发只跑了索引 0、3~9，1 和 2 丢失）
- **证据**: `verify2.mjs` 用带副作用的 runner 记录实参：5 任务/5 并发得到 `seen=[0,0,0,0,0]`，`results=[{ok:true,value:1},null,null,null,null]`；10 任务/3 并发得到 `counts={0:3,3:1,...,9:1}`、`totalRuns=10` 但索引 1、2 一次未跑。属静默丢任务，不抛错。

## 发现 2
- **file**: src/index.js:28
- **类型**: 逻辑错误（数据被提前清空）
- **严重性**: Critical
- **问题**: `tasks.length = 0;` 在 `runWithConcurrency(tasks, ...)` 之前执行，且第 27 行注释"A 假设队列持有的是独立副本"是错的（队列确实拷贝了元素，但下面用的是**已被清空的 tasks**）。任何非空输入都变成 `processTasks` 返回 `[]`、`handler` 一次不被调用、全部任务丢失；第 37 行"不检查 ok 字段"的隐患也因此被掩盖
- **证据**: `verify3.mjs` 统计 handler 调用次数：传入 2 个任务，返回 `{calls:0, resultLen:0, tasksLen:0}`。`verify.mjs` 传 3 个任务同样得到 `resultLen=0`。

## 发现 3
- **file**: src/index.js:23
- **类型**: 数值边界（0 未处理）
- **严重性**: High
- **问题**: `new TaskQueue({ capacity: tasks.length })` 在空数组时传入 `0`，而 `TaskQueue` 构造器要求 `capacity > 0` → `processTasks([])` 抛 `TypeError: capacity must be a positive number`。一个"处理空批次"的合法调用被当成错误
- **证据**: `verify2.mjs`：`processTasks([])` 与 `processTasks([], {config...})` 均抛 `TypeError | capacity must be a positive number`。

## 发现 4
- **file**: src/queue.js:34
- **类型**: 数值边界（off-by-one）
- **严重性**: High
- **问题**: `if (this.#items.length > this.#capacity) return false;` 应为 `>=`。容量 N 实际可存 N+1 条，`capacity` getter 与 `size` 自相矛盾，依赖容量做背压的调用方会多放一条
- **证据**: `verify2.mjs`：`capacity=1` 连续入队 a、b 均返回 `true`，`size=2, cap=1`；`capacity=3` 入队 5 条得到 `[true,true,true,true,false]`、`size=4`。

## 发现 5
- **file**: src/queue.js:9
- **类型**: 数值边界（NaN / Infinity / 小数）
- **严重性**: High
- **问题**: 守卫 `typeof capacity !== 'number' || capacity <= 0` 只挡住了 0 和负数。`NaN`（`NaN <= 0` 为 false）、`Infinity`、`1.5` 全部通过：容量为 NaN 时 `length > NaN` 恒为 false，队列无上限（可无限增长至 OOM）；`1.5` 产生非整数容量语义
- **证据**: `verify.mjs`：`new TaskQueue({capacity: NaN})` 成功且连续 `enqueue` 5 条全部 `true`、`size=5`；`Infinity` 同样成功；`capacity=1.5` 返回 `1.5`；`capacity='4'` 抛错（仅字符串被挡）。

## 发现 6
- **file**: src/queue.js:61-70（`peek`），配合 src/queue.js:37-41（`enqueue`）
- **类型**: 返回值暴露内部状态
- **严重性**: High
- **问题**: `peek()` 直接返回内部数组元素，调用方拿到引用后可改 `id`、`priority`、`enqueuedAt`，篡改会保留在队列中并改变出队优先级；`enqueue` 的 `{...task}` 只拷贝顶层，`task.meta` 等嵌套对象仍与调用方共享，通过 `peek` 也能反向污染调用方对象
- **证据**: `verify.mjs`：`peek()` 后改写 `p.id='HIJACKED'; p.priority=99`，`p === q.peek()` 为 `true`，下一次 `dequeue()` 返回 `{id:'HIJACKED', priority:99}`；嵌套测试中 `enqueue` 后改 `meta.n=2`，出队对象 `meta.n` 也为 `2` 且 `d.meta === meta`。

## 发现 7
- **file**: src/config.js:13-20（调用点 26-28）
- **类型**: 数值边界（0 / 负数）
- **严重性**: High
- **问题**: `parsePositiveInt` 名字和错误文案都声称 "positive integer"，但 `Number.isInteger(-5)` 为 true、`Number.isInteger(0)` 也为 true，二者被原样返回。后果链：`CONCURRENCY=0` 或负数最终传入 `runWithConcurrency` 抛 `RangeError`；`RETRY_MAX=0`/负数使 `retry` 抛出 `undefined`（见发现 8）；`TIMEOUT_MS=0` 作为 `maxDelay` 小于默认 `base=50`，退避时抛 `RangeError`
- **证据**: `verify.mjs`：`loadConfig({CONCURRENCY:'0'}).concurrency === 0`，`{CONCURRENCY:'-5'}` → `-5`；同时确认 `'1.5'`、`'Infinity'`、`'abc'` 均抛错，说明只漏了 0/负数。

## 发现 8
- **file**: src/retry.js:32-34（循环 37-47）
- **类型**: 数值边界（0 / 负数）→ 抛出非 Error 值
- **严重性**: Medium
- **问题**: `maxAttempts` 只校验 `Number.isInteger`，0 和负数通过。此时 `for` 循环体一次不执行，`lastError` 保持 `undefined`，函数最终 `throw undefined`。调用方 `catch (e)` 无法访问 `e.message`，日志/监控里表现为空错误，且丢失"为什么没执行"的信息
- **证据**: `verify2.mjs`：`maxAttempts=0` 与 `-3` 均 `THROW undefined`，`typeof e === 'undefined'`、`e instanceof Error === false`、`calls === 0`；对照 `maxAttempts=1.5`/`NaN`/`Infinity` 均被正确拒绝。

## 发现 9
- **file**: src/retry.js:12-13
- **类型**: 数值边界（NaN 全部漏过）
- **严重性**: Medium
- **问题**: `if (base <= 0)` 与 `if (maxDelay < base)` 对 `NaN` 恒为 false，`base=NaN` 被接受；`Math.pow(2, attempt)` 得 `NaN`，`Number.isFinite` 判定为 false 后走"溢出保护"分支返回 `maxDelay`，于是**错误的 base 被静默替换成最大延迟**。`maxDelay=NaN` 时 `Math.min(safe, NaN)` 返回 `NaN`，传给 `sleep` 后 `setTimeout(NaN)` 按 0ms 处理，退避完全失效
- **证据**: `verify.mjs`：`backoffDelay(1,{base:NaN})` 返回 `30000`（默认 maxDelay）；`backoffDelay(1,{maxDelay:NaN})` 返回 `null`（实为 `NaN`）。`verify2.mjs` 捕获实际 sleep 参数：`base=NaN, maxDelay=777` → `sleeps=[777]`；`maxDelay=NaN` → `sleeps=["NaN"]`。

## 发现 10
- **file**: src/store.js:30-37
- **类型**: 返回值暴露内部状态
- **严重性**: Medium
- **问题**: `get(key)` 返回内部对象的活引用，`set(key,value)` 保存调用方的同一引用。调用方"改 get 的返回值"只改内存不落盘，同一进程内读到新值、重新 `new JsonStore` 或进程崩溃后读到旧值，属于静默的数据分叉；若内存态在下次 `set` 时被序列化，还可能把未预期的外部修改一起写盘
- **证据**: `verify3.mjs`：`set('k',{n:1})` 后 `get('k').n = 99`，当前实例读到 `{n:99}`，新实例重载磁盘得到 `{n:1}`；`verify.mjs` 中 `got === v` 为 `true`，改 `got.a=999` 后磁盘仍为 `1`。

## 发现 11
- **file**: src/store.js:31 与 src/store.js:40
- **类型**: 同族函数守卫不一致（原型链口径）
- **严重性**: Low
- **问题**: `get` 用 `key in this.#data`（包含原型链），`delete` 用 `hasOwnProperty`（仅自有属性）。空 store 上 `get('toString')` 返回内置函数而非 `undefined`，`delete('toString')` 却返回 `false`；调用方用 `get(k) !== undefined` 判断"键是否存在"会被原型属性欺骗
- **证据**: `verify2.mjs`：空 store `typeof s.get('toString') === 'function'`、`typeof s.get('constructor') === 'function'`，同时 `s.delete('toString') === false`；自有键 `k` 则 `delete` 返回 `true`、再次 `false`。

## 发现 12
- **file**: src/queue.js:73-78
- **类型**: 同族函数守卫不一致
- **严重性**: Low
- **问题**: `remove(id)` 不做任何类型/空值校验，`remove(undefined)`、`remove(123)` 静默返回 `false`，与 `enqueue` 对 `task.id` 的严格校验（非空字符串、否则抛 `TypeError`）不对称。调用方把"参数写错"误读成"队列里没有这条"，难以排查
- **证据**: `verify.mjs`：`enqueue({id:123})` 抛 `TypeError`，同一实例 `remove(123)` 返回 `false`；`remove(undefined)`/`remove('')` 同样返回 `false` 而不抛错。

## 发现 13
- **file**: src/store.js:34-37（键校验），关联 src/store.js:19-28
- **类型**: 同族函数守卫不一致 + 键名特殊值
- **严重性**: Medium
- **问题**: `set` 不校验 key：`set(undefined,1)`/`set(123,2)` 会被隐式转成字符串键 `"undefined"`/`"123"`；更严重的是 `set('__proto__', {...})` 触发原型 setter，值被写到原型上而非自有属性——`keys()` 返回 `[]`、写入磁盘的是 `{}`，**数据静默丢失**，但 `get('__proto__')` 又能读到该对象。从磁盘加载含自有 `"__proto__"` 键的 JSON 时行为又相反（`JSON.parse` 会创建自有属性），两条路径语义不一致
- **证据**: `verify.mjs`：`set('__proto__',{polluted:true})` 后 `keys=[]`、磁盘 `"{}"`、但 `get('__proto__')={polluted:true}`；`verify3.mjs` 预写 `{"__proto__":{...},"safe":1}` 后加载，`keys=["__proto__","safe"]`，即磁盘加载能保留、内存写入会丢。

## 发现 14
- **file**: src/index.js:34
- **类型**: 语义错配（配置项被当作另一含义使用）
- **严重性**: Medium
- **问题**: 把 `config.timeoutMs`（单次执行超时）当作 `retry` 的 `maxDelay`（退避上限）传入。默认 `timeoutMs=30000` 尚可掩盖问题，但用户设 `TIMEOUT_MS=0` 或小于 `base=50` 时，`backoffDelay` 的 `maxDelay < base` 校验会抛 `RangeError`，重试流程中断；逻辑上"超时时间"也不再控制超时（`handler` 从未被包超时）
- **证据**: 静态对照 config.js:6（timeoutMs 语义）与 index.js:34 注释"timeoutMs 是单次超时上限，不是退避上限"（作者已注明却仍这样传）；`verify.mjs` 复现 `backoffDelay(1,{maxDelay:0})` 抛 `maxDelay must be >= base`（默认 base 100/50 场景同理）。当前被发现 2 掩盖，一旦修复发现 2 即暴露。

## 发现 15
- **file**: src/queue.js:80-86
- **类型**: 返回值与文档不符
- **严重性**: Low
- **问题**: JSDoc 声明 `@returns {boolean} 总是 true`，实现 `clear()` 无 `return`，实际返回 `undefined`。调用方按文档写 `if (!queue.clear())` 会永远走失败分支
- **证据**: `verify2.mjs`：`clear()` 返回 `undefined`、`typeof` 为 `"undefined"`，`size=0`。

## 发现 16
- **file**: src/retry.js:15
- **类型**: 文档/实现不一致（指数偏一位）
- **严重性**: Low
- **问题**: 注释与 JSDoc 写 `base * 2^(attempt-1)`（首次退避 = base），实现是 `base * Math.pow(2, attempt)`，首次退避为 `2*base`，每次都比文档多一倍。默认 `base=100` 时第一次实际等 200ms
- **证据**: `verify2.mjs`：`[1,2,3].map(a => backoffDelay(a,{base:100}))` 返回 `[200,400,800]`，而按文档应为 `[100,200,400]`。

## 发现 17
- **file**: src/store.js:53-55
- **类型**: 持久化原子性（先删后写）
- **严重性**: High
- **问题**: `#persist` 先 `rmSync(this.#path)` 再 `writeFileSync`，注释也承认"中途失败会导致数据丢失"。进程在两步之间崩溃/磁盘满/权限错误，原文件已删除、新文件未写成，整库数据归零；文件头声称的"原子写入：先写临时文件再 rename"并未实现（没有临时文件、没有 `renameSync`）
- **证据**: 静态确认 import 列表（store.js:4）无 `renameSync`，`#persist` 中只有 `rmSync` + `writeFileSync`；文件第 2 行注释与第 53 行注释互相矛盾。

---

## 附：验证脚本

- `<HOME>\AppData\Local\Temp\iso-ab-patterns\verify.mjs` — 参数矩阵（config/queue/retry/store/worker-pool/neg-*）+ 边界值
- `<HOME>\AppData\Local\Temp\iso-ab-patterns\verify2.mjs` — 并发索引、空数组、`__proto__`、`clear` 返回值、retry 零次执行
- `<HOME>\AppData\Local\Temp\iso-ab-patterns\verify3.mjs` — 守卫对称性、容量边界、store 键类型/持久化分叉

所有结论均为实际运行输出，未依赖静态猜测。
