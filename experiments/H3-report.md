# H3 代码审计报告

审计对象：`%TEMP%\iso-h3\code\`（9 文件 / 471 行），Node v26.12.1，只读审计。
下列每条均在独立脚本中实际复现过（`node` 直接 import 对应 `src/*.js`）。

---

## 发现 1

- **file**: src/worker-pool.js:19-21
- **类型**: concurrency
- **严重性**: CRITICAL
- **问题**: 任意 `tasks.length > concurrency` 的调用 → 同一个任务被并发重复执行多次，其他任务被永久跳过，返回数组出现空洞。
- **依据**: 三个 worker 在 `await Promise.resolve()` 之前就各自执行了 `const idx = cursor`，此时 `cursor` 仍为 0，三个 worker 全部拿到 `idx = 0`；`cursor += 1` 发生在 `await` 之后，无法阻止这次抢占。实测 `runWithConcurrency([0..7], 4, ...)` 的执行序列为 `[0,0,0,0,4,5,6,7]`——index 0 跑了 4 遍，index 1/2/3 一次都没跑。返回值 `results` 长度仍为 8，但 index 1/2/3 是稀疏空洞（`hasOwnProperty(res,1) === false`），`JSON.stringify` 输出 `[...,null,null,null,...]`，`for...of` 只能遍历到 5 项。docs 声称"任一任务抛错不中断其余任务"，实际是根本没执行。正确写法应为 `const idx = cursor++` 放在 await 之前，或在 await 之后重新读取。这是整个 fixture 最严重的问题，且因为发现 2，`processTasks` 路径下从未暴露。

## 发现 2

- **file**: src/index.js:28
- **类型**: logic
- **严重性**: CRITICAL
- **问题**: 任意非空 `tasks` 数组 → `processTasks` 一个任务都不执行，静默返回 `[]`。
- **依据**: 第 23-26 行先把 `tasks` 入队，第 28 行 `tasks.length = 0`，第 30 行却把**同一个已被清空的 `tasks`** 传给 `runWithConcurrency`。`runWithConcurrency` 收到 `[]`，worker 立即退出，返回 `[]`。实测 `processTasks([{id:'a'},{id:'b'},{id:'c'}], {handler})`：返回 `[]`，handler 调用记录为 `[]`，调用后原数组为 `[]`。第 27 行注释"假设队列持有的是独立副本，下面清空原数组不会影响队列"本身是对的（`enqueue` 确实做了 `{...task}` 浅拷贝），但结论错在**下一行用的不是队列而是原数组**——队列 `queue` 此后成为完全无人读取的孤立对象。正确做法是从 `queue.dequeue()` 取值，或直接不清空原数组。

## 发现 3

- **file**: src/store.js:50-56
- **类型**: data-consistency
- **严重性**: HIGH
- **问题**: 任意一次 `set()` 序列化失败（如循环引用）→ 磁盘上原有的有效数据文件被永久删除，只剩空文件。
- **依据**: 第 54 行先 `rmSync(this.#path)` 删原文件，第 55 行才执行 `JSON.stringify` + `writeFileSync`。序列化在第 55 行抛错时，原文件已经不存在，数据无任何副本。实测：先 `set('good','data')`（文件正常），再 `set('bad', circularObj)` → 抛 `TypeError: Converting circular structure to JSON`，随后 `existsSync(path) === false`，重新 `new JsonStore(path)` 得到 `keys() === []`。另外第 2 行注释宣称"先写临时文件再 rename，避免半写状态"，但整个文件里**没有任何 rename/temp 调用**（`grep rename|tmp|temp src/store.js` 只命中注释本身）——声称的原子性完全没有实现，`writeFileSync` 直接截断原文件，进程在写入中途被杀同样导致数据全丢。

## 发现 4

- **file**: src/store.js:23-27
- **类型**: error-handling | data-consistency
- **严重性**: HIGH
- **问题**: JSON 文件损坏（被截断、手写错误、半写残留）→ 静默当作空对象 `{}`，下一次 `set()` 立即用新内容覆盖，损坏前的内容永久丢失且无任何告警。
- **依据**: `catch { return {} }` 把"解析失败"与"文件本就不存在"（第 20 行同样返回 `{}`）混为一谈，调用方无法区分"全新库"和"库已损坏"。实测：写入 `{corrupt!!` 后 `new JsonStore(p)`，`keys()` 为 `[]`、`get('a')` 为 `undefined`；再 `set('b',2)`，磁盘内容变为 `{ "b": 2 }`，原 `a` 不可恢复。结合发现 3 的非原子写，真实场景下"损坏"正是由本模块自己的写入中断造成的，两者叠加形成静默数据丢失闭环。

## 发现 5

- **file**: src/store.js:54 + src/store.js:12
- **类型**: data-consistency
- **严重性**: MEDIUM
- **问题**: 同一路径被多个 `JsonStore` 实例（或多进程）使用时 → 后写者以自己内存中的旧快照整体覆盖文件，先写者的数据丢失。
- **依据**: 每个实例在构造时 `#load()` 一份快照到 `#data`，`#persist()` 每次写的是整份 `#data`，没有读-合并、没有文件锁、没有 mtime 校验。实测：`a=new JsonStore(p)`、`b=new JsonStore(p)`，`a.set('x',1)` 后 `b.set('y',2)`，最终文件为 `{"y":2}`，`a` 的 `x` 消失，而 `a.keys()` 仍返回 `['x']`——内存与磁盘状态分叉。这是本模块被定位为"持久化"用途时的核心一致性缺陷。

## 发现 6

- **file**: src/retry.js:32-34,47
- **类型**: error-handling
- **严重性**: HIGH
- **问题**: `maxAttempts <= 0`（含 `RETRY_MAX=0`，这是 config 明确允许并被接受的值）→ `retry()` 中 `for` 循环一次都不执行，`lastError` 保持 `undefined`，最终 `throw undefined`；调用方 `catch (e) { e.message }` 直接抛 `TypeError`，真实失败原因彻底丢失。
- **依据**: 第 32 行只校验 `Number.isInteger(maxAttempts)`，不校验 `>= 1`；循环条件 `attempt <= maxAttempts` 在 0/-1 时立即为假。实测 `retry(fn,{maxAttempts:0})` / `-1` / `-5` 均以 `undefined` reject（`e instanceof Error === false`）。该路径可通过公开配置触达：`loadConfig({RETRY_MAX:'0'})` 返回 `retryMax: 0`（见发现 10），传入 `processTasks` 后异常被 `runWithConcurrency` 捕获成 `{ok:false, error: undefined}`。

## 发现 7

- **file**: src/retry.js:44（配合 src/index.js:32-34）
- **类型**: error-handling
- **严重性**: HIGH
- **问题**: `maxDelay < base` 时 → 退避计算抛出的 `RangeError` 在 `catch` 块内覆盖掉真正的业务错误，调用方看到的完全是与失败原因无关的报错。
- **依据**: 第 44 行 `await sleep(backoffDelay(...))` 位于 `catch (err)` 块内部，`backoffDelay` 第 13 行的 `throw new RangeError('maxDelay must be >= base')` 会终止 `retry`，`lastError` 再也不会被抛出。实测 `retry(async()=>{throw new Error('HANDLER_BUG')}, {maxAttempts:3, base:100, maxDelay:10})` 最终抛出的是 `RangeError: maxDelay must be >= base`，`HANDLER_BUG` 丢失。该路径可经配置直接触达：`processTasks` 固定 `base: 50`、`maxDelay: config.timeoutMs`，用户设置 `TIMEOUT_MS=10`（config 允许，见发现 10）后所有重试都会变成这个假错误。

## 发现 8

- **file**: src/queue.js:53,65
- **类型**: logic
- **严重性**: MEDIUM
- **问题**: 同优先级任务 → 出队/查看顺序为 LIFO（后进先出），与第 47、60 行注释声明的"同优先级按 FIFO"相反。
- **依据**: 比较用 `>=`，遇到相等优先级仍把 `bestIdx` 更新为更靠后的下标，因此停在**最后一个**同优先级元素上。实测队列依次入队 `first`、`second`（priority 均为 5）：`peek()` 返回 `second`，第一次 `dequeue()` 返回 `second`，第二次才返回 `first`。改成 `>` 即符合注释。`dequeue` 与 `peek` 两处实现完全相同，故错误也被复制了两份；两者不一致本身也是隐患。

## 发现 9

- **file**: src/queue.js:34
- **类型**: logic
- **严重性**: MEDIUM
- **问题**: 容量上限 off-by-one → `capacity: N` 的队列可以塞进 `N+1` 个元素；结合发现 2，`processTasks` 的 `capacity: tasks.length` 永远不会返回 `false`（注释第 21 行自称"永远塞不满"），让上限形同虚设。
- **依据**: 判断写成 `if (this.#items.length > this.#capacity) return false;`，应在 `>=` 时拒绝。实测 `new TaskQueue({capacity:1})` 连续入队两次均返回 `true`，`size === 2`、`capacity === 1`。此外容量校验只挡 `typeof !== 'number' || <= 0`，`NaN` 与 `1.5` 都能通过：`new TaskQueue({capacity:NaN})` 构造成功，之后任意次入队都返回 `true`，容量彻底失效。

## 发现 10

- **file**: src/config.js:13-19
- **类型**: contract
- **严重性**: MEDIUM
- **问题**: `CONCURRENCY=0`、`CONCURRENCY=-5`、`RETRY_MAX=0` 均被当作合法值接受 → 错误信息与实际校验逻辑矛盾，并向下游注入两种崩溃（见发现 6、7）。
- **依据**: 函数名 `parsePositiveInt`、报错文案 `must be a positive integer` 都声称校验正数，实际只检查 `Number.isInteger(n)`，没有 `n > 0`。实测 `loadConfig({CONCURRENCY:'0'})` 返回 `concurrency: 0`；`{CONCURRENCY:'-5'}` 返回 `-5`；`{RETRY_MAX:'0'}` 返回 `retryMax: 0`。`concurrency: 0` 直到 `runWithConcurrency` 第 9-10 行才报 `RangeError`，`retryMax: 0` 则静默变成发现 6 的 `throw undefined`——校验位置与错误归属都错位了。注释第 23 行"非法值抛错"与实际行为不符。

## 发现 11

- **file**: src/config.js:27,30-35（配合 src/index.js:34）
- **类型**: contract
- **严重性**: MEDIUM
- **问题**: 配置项 `timeoutMs` 与 `logLevel` 没有任何真实消费者 → 用户设置的单次任务超时从来不会生效，卡死的 handler 会永久占住一个并发槽；`logLevel` 是纯粹的无效配置。
- **依据**: 全仓 `grep timeoutMs|logLevel src/` 只有 config.js 的解析/返回和 index.js:34 一处使用，而那一处把 `timeoutMs` 当作**退避上限** `maxDelay` 传给 `retry`（该行注释自己也承认"timeoutMs 是单次超时上限，不是退避上限"）。没有任何 `AbortController`、`Promise.race` 或 `setTimeout` 实现超时。`logLevel` 被读入、被校验、被返回，之后没有任何模块引用（项目中也无 logger 模块）。

## 发现 12

- **file**: package.json:1-6
- **类型**: contract
- **严重性**: HIGH
- **问题**: 包没有 `main` / `exports` / `index.js` 入口 → `import 'gt-fixture'` 直接 `ERR_MODULE_NOT_FOUND`，整个包按包名不可用；连带使 neg-unused.js 声称的"公共 API，由使用方消费"无法成立。
- **依据**: package.json 只有 `name/version/type/description`。实测在 `node_modules/gt-fixture` 软链到本目录后执行 `import('gt-fixture')`，报 `ERR_MODULE_NOT_FOUND: Cannot find package ...\node_modules\gt-fixture\index.js`。同时 `src/index.js` 的导出实测为 `JsonStore,TaskQueue,backoffDelay,loadConfig,processTasks,retry,runWithConcurrency`，**不含** `ERROR_CODES`、`VERSION`、`normalizeError`、`isValidTask`。因此 neg-unused.js 顶部"这些导出是公共 API 的一部分，由使用方消费"的前提在发布形态下不成立——使用方只能深路径 `import 'gt-fixture/src/neg-unused.js'` 才能拿到（`type: module` 在 Node 下会放行深路径），这不是一个可预期的公共契约。

## 发现 13

- **file**: src/store.js:31（配合 src/store.js:16-17）
- **类型**: contract | security
- **严重性**: MEDIUM
- **问题**: 任意键名查询走的是原型链查找 → `get('toString')` 返回一个函数而不是 `undefined`，`get('__proto__')` 返回 `Object.prototype`，`get('constructor')` 返回 `Object`；把外部可控字符串当 key 的调用方会拿到非预期对象甚至可被用于原型相关的逻辑绕过。
- **依据**: `key in this.#data` 会命中原型链。实测新建空库上 `typeof s.get('toString') === 'function'`、`typeof s.get('__proto__') === 'object'`。同一个类里 `delete()` 第 40 行却用 `hasOwnProperty` 判断，`set()` 用直接赋值——三处语义不一致，`get` 是唯一越界的那个，应改为 `Object.hasOwn`。

## 发现 14

- **file**: src/store.js:16-17,23-27
- **类型**: error-handling
- **严重性**: MEDIUM
- **问题**: 文件内容本身是合法 JSON 但不是对象（`null` / `42` / `"str"`）→ `#data` 被赋成标量，构造不报错，但之后**每一个**方法（`get`/`keys`/`set`/`delete`）都抛 `TypeError`，存储对象彻底不可用。
- **依据**: `#load()` 直接 `return JSON.parse(raw)`，不校验结果类型。实测写入 `"null"` 后构造成功、`keys()` 抛 `Cannot convert undefined or null to object`；写入 `42` 或 `"str"` 后 `get('0')` 抛 `Cannot use 'in' operator to search for '0' in ...`。写入 `[1,2,3]` 更隐蔽：不报错但退化成以 `"0"/"1"/"2"` 为键的伪字典。应在 `#load` 里加 `typeof === 'object' && !Array.isArray() && !== null` 的守卫。

## 发现 15

- **file**: src/neg-catch.js:28-38
- **类型**: contract
- **严重性**: MEDIUM
- **问题**: `tryParseJson('null')` 返回 `null`，与"解析失败"的返回值完全相同 → 第 29-30 行注释所依据的"调用方用 `=== null` 区分解析失败和解析成功但值是 null"这一关键前提是**错的**，该区分能力根本不存在。
- **依据**: 注释原话"后者在这里不可能出现，因为 JSON.parse 永远不会返回 null"与事实相反：`JSON.parse('null') === null` 为 `true`（实测）。因此 `tryParseJson('null')` 与 `tryParseJson('bad')` 都返回 `null`。这不是空 catch 本身的问题（catch 的位置确实是安全的），而是注释所声称的契约不成立——按该注释编写的调用方会把合法输入 `null` 误判为解析失败。修法：失败时返回哨兵对象，或用 `{ok, value}` 结构。

## 发现 16

- **file**: src/neg-catch.js:45-52
- **类型**: error-handling
- **严重性**: MEDIUM
- **问题**: `handle.close()` 返回 Promise 且异步 reject 时 → `safeClose` 返回 `true`（谎报成功），拒绝逃逸出 try/catch 成为 unhandled rejection，在 `--unhandled-rejections=strict` 或 Node 默认行为下直接终止进程。
- **依据**: `try { handle.close(); return true; } catch {}` 只能捕获同步抛错，无法捕获返回 Promise 的 rejection；且函数没有 `await`。实测 `safeClose({ close: async () => { throw new Error('ASYNC_CLOSE_FAILED') } })` 同步返回 `true`，随后进程以 `Error: ASYNC_CLOSE_FAILED` 崩溃。`fs.promises` 句柄、net.Socket 的异步 close 都符合这个形状，因此不是理论问题。修法：`await handle.close()` 并把函数改为 async，或至少 `.catch()` 掉。

## 发现 17

- **file**: src/queue.js:80-86
- **类型**: contract
- **严重性**: LOW
- **问题**: `clear()` 的 JSDoc 明确写 `@returns {boolean} 总是 true`，实际函数体没有 `return`，返回 `undefined` → 按文档写 `if (!queue.clear())` 的调用方会把每次成功清空都当成失败。
- **依据**: 第 84-86 行只有 `this.#items.length = 0;`，无 return 语句。实测 `q.clear()` 返回 `undefined`。同文件 `enqueue`/`remove` 都规规矩矩返回布尔值，说明返回布尔是既定契约，此处是漏写。

## 发现 18

- **file**: src/retry.js:8-19
- **类型**: contract
- **严重性**: LOW
- **问题**: 退避时间整体偏大一倍 → 首次重试等待 `2*base` 而非文档写的 `base`，4 次尝试的总等待时间比宣称值多出一倍。
- **依据**: 第 6 行注释写 `base * 2^(attempt-1)`，第 15 行实现是 `base * Math.pow(2, attempt)`，指数多了 1。实测 `base=100` 时 `backoffDelay(1)` 返回 200、`(2)` 返回 400、`(3)` 返回 800（文档应为 100/200/400）；`retry` 在 `maxAttempts=4` 下实际 sleep 序列为 `[200,400,800]`。仅在 `attempt=1` 或 `maxAttempts` 很小时影响有限，但会实质性拉长重试窗口。

---

## 附：经验证确认无缺陷的部分（不作为发现）

为避免误报，以下几处是刻意设置的陷阱，实测均**正确**：

- `src/neg-race.js:20-35`：`increment`/`incrementAsync` 的读-改-写之间没有 `await`，`incrementAsync` 的 `await` 在写入之后，不构成竞态。实测 `batchIncrement(counter, 1000)` 精确返回 `1000`；额外用 `await null` 在 500 个调用之间强制交错，结果仍为 `500`。
- `src/neg-catch.js:15-25`：`tryRemoveTemp` 的空 catch 语义安全——`existsSync` 预检 + 返回布尔，删除失败不影响主流程，确属刻意设计。
- `src/neg-catch.js:32-39`：`tryParseJson` 的空 catch 本身位置正确（缺陷在注释声称的契约，见发现 15，而非 catch）。
- `src/neg-unused.js`：导出确实无内部引用，但其"公共 API"正当性取决于打包入口，该前提不成立，已归入发现 12，不重复计为死代码。
- `src/worker-pool.js:23-27`：单项任务的 try/catch 把错误收集为 `{ok:false,error}` 的设计本身正确（缺陷是发现 1 的索引抢占）。
- `src/index.js:18-20`：`handler` 类型前置校验正确。
- `src/store.js:39-44`：`delete` 用 `hasOwnProperty` 判断存在性，语义正确（与发现 13 的 `get` 形成对比）。
