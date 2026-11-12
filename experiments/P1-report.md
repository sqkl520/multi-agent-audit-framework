# P1 审计报告 — `iso-p1/code`（ground-truth fixture）

- 审计对象：`<HOME>\AppData\Local\Temp\iso-p1\code\`
- 范围：9 个文件 / 471 行，全部读完
- 方式：只读静态审阅 + 在 `%TEMP%\iso-p1\` 写探针脚本实际执行验证（`audit-probe.mjs` ~ `audit-probe4.mjs`）
- 结论：确认 **25 项发现**，其中 2 项 CRITICAL（`processTasks` 一个任务都不跑、`runWithConcurrency` 索引竞态）。`neg-catch.js` / `neg-race.js` / `neg-unused.js` 三个负例文件按语义**无真实缺陷**（仅有 3 处 LOW 级注释/守卫瑕疵，发现 24/25），不应报为缺陷。

---

## 模式检查结果

| 模式 | 文件 | 命中/未命中/不适用 | 说明 |
|---|---|---|---|
| 1. 返回值暴露内部状态 | src/config.js | 未命中 | `loadConfig` 返回全新字面量，成员均为原始值；`DEFAULTS` 虽被 `Object.freeze` 但不外泄 |
| 1. 返回值暴露内部状态 | src/index.js | 未命中 | 返回的是 `runWithConcurrency` 新建的结果数组；但存在**反向别名**：`tasks.length = 0` 改写了调用方入参（见发现 2） |
| 1. 返回值暴露内部状态 | src/neg-catch.js | 不适用 | 三个函数均无模块级/实例级内部状态，`tryParseJson` 每次返回新解析对象 |
| 1. 返回值暴露内部状态 | src/neg-race.js | 未命中 | `increment` / `incrementAsync` / `value` 返回的都是 `number` 原始值 |
| 1. 返回值暴露内部状态 | src/neg-unused.js | 未命中 | `normalizeError` 返回新字面量，`isValidTask` 返回 boolean，`ERROR_CODES` 已 freeze |
| 1. 返回值暴露内部状态 | src/queue.js | **命中** | `peek()` 第 69 行 `return this.#items[bestIdx]` 返回队列内部同一引用；另 `enqueue` 用浅展开，嵌套对象仍与入参共享 |
| 1. 返回值暴露内部状态 | src/retry.js | 不适用 | 无内部状态，`retry` 直接透传 `fn` 的返回值 |
| 1. 返回值暴露内部状态 | src/store.js | **命中** | `get()` 第 31 行返回 `this.#data[key]` 内部引用，改动会污染 store 内存态且与磁盘不一致 |
| 1. 返回值暴露内部状态 | src/worker-pool.js | 未命中 | `results` 为新数组，元素为 `{ok, value}` 新包装对象；但数组内含空洞（见发现 1） |
| 2. 同族函数守卫一致 | src/config.js | 未命中 | `concurrency` / `timeoutMs` / `retryMax` 三个数值字段统一走 `parsePositiveInt`，一致（但该函数本身有洞，见模式 3） |
| 2. 同族函数守卫一致 | src/index.js | **命中** | `processTasks` 校验了 `handler` 是函数，却完全不校验 `tasks` 是数组（`worker-pool.js` 对同一参数有校验），校验层级不一致 |
| 2. 同族函数守卫一致 | src/neg-catch.js | **命中（LOW）** | `tryParseJson` 有 `typeof text !== 'string'` 守卫、`safeClose` 有 `typeof handle.close === 'function'` 守卫，同族的 `tryRemoveTemp(path)` 对 `path` 无任何类型守卫 |
| 2. 同族函数守卫一致 | src/neg-race.js | 未命中 | 唯一带参入口 `batchIncrement` 有完整校验；`Counter` 的方法无参数 |
| 2. 同族函数守卫一致 | src/neg-unused.js | 未命中 | `isValidTask` 校验完整，`normalizeError` 对 `Error` / 非 `Error` 两分支都处理 |
| 2. 同族函数守卫一致 | src/queue.js | **命中** | `enqueue` 校验 `task` 是对象且 `id` 是非空字符串；做同类事的 `remove(id)` 完全不校验 `id`。另 `get`/`delete` 语义不一致（`in` vs `hasOwnProperty`，见发现 15） |
| 2. 同族函数守卫一致 | src/retry.js | **命中** | `backoffDelay` 校验 3 个参数（attempt/base/maxDelay），`retry` 只校验 `maxAttempts`；`fn`、`shouldRetry`、`sleep` 三个函数型参数均无前置校验，靠调用时抛原生 TypeError |
| 2. 同族函数守卫一致 | src/store.js | **命中** | `get` 用 `key in this.#data`（含原型链），`delete` 用 `hasOwnProperty`（仅自有）——同一"键是否存在"判断用了两套语义；`set`/`get`/`delete` 均不校验 key 类型 |
| 2. 同族函数守卫一致 | src/worker-pool.js | 未命中 | `tasks` / `concurrency` / `runner` 三项全部前置校验，且是全部文件里最严格的 |
| 3. 数值边界完整 | src/config.js | **命中** | `parsePositiveInt` 只做 `Number.isInteger`，未做 `> 0`：`CONCURRENCY=0` → 0，`CONCURRENCY=-3` → -3，均放行 |
| 3. 数值边界完整 | src/index.js | **命中** | 无本地数值校验，直接透传 `config.retryMax`；`retryMax=0` 会触发 `retry` 的 `throw undefined` |
| 3. 数值边界完整 | src/neg-catch.js | 不适用 | 无数值参数 |
| 3. 数值边界完整 | src/neg-race.js | 未命中 | `batchIncrement` 用 `!Number.isInteger(count) \|\| count < 0`，正确排除 0.5 / NaN / Infinity / 负数 |
| 3. 数值边界完整 | src/neg-unused.js | 不适用 | 无数值参数 |
| 3. 数值边界完整 | src/queue.js | **命中** | `capacity` 只判 `typeof === 'number' && > 0`：`NaN`、`Infinity`、`0.5` 全部放行；且 `>` 导致 off-by-one |
| 3. 数值边界完整 | src/retry.js | **命中** | `maxAttempts` 放行 `0` / `-1`（→ `throw undefined`）；`base` 用 `<= 0`，`NaN` 漏过；`maxDelay` 用 `< base`，`NaN` 漏过 |
| 3. 数值边界完整 | src/store.js | 不适用 | 无数值参数 |
| 3. 数值边界完整 | src/worker-pool.js | 未命中 | `concurrency` 用 `!Number.isInteger(c) \|\| c < 1`，正确排除 0 / 负 / `NaN` / `Infinity` / 小数 / 字符串 |
| 4. 解析结果校验形状 | src/config.js | 不适用 | 无 JSON/文件解析 |
| 4. 解析结果校验形状 | src/index.js | 不适用 | 无解析逻辑 |
| 4. 解析结果校验形状 | src/neg-catch.js | **命中（LOW）** | `tryParseJson` 不校验形状（作为通用工具可接受），但第 30 行注释断言"`JSON.parse` 永远不会返回 null"是事实错误：`tryParseJson("null")` 返回 `null`，与解析失败不可区分 |
| 4. 解析结果校验形状 | src/neg-race.js | 不适用 | 无解析逻辑 |
| 4. 解析结果校验形状 | src/neg-unused.js | 不适用 | 无解析逻辑 |
| 4. 解析结果校验形状 | src/queue.js | 不适用 | 无解析逻辑 |
| 4. 解析结果校验形状 | src/retry.js | 不适用 | 无解析逻辑 |
| 4. 解析结果校验形状 | src/store.js | **命中** | `#load` 对 `JSON.parse` 结果零校验：`null` / `123` / `"str"` / `true` 构造成功但 `get`/`set` 立即抛 TypeError；`[1,2,3]` 被当成 map；损坏 JSON 静默 `{}` 并在下次写入时覆盖原数据 |
| 4. 解析结果校验形状 | src/worker-pool.js | 不适用 | 无解析逻辑 |
| 5. 能力是否真实现 | src/config.js | **命中** | `logLevel` 被解析、被校验（且漏了 `warn`），但全仓库**从未有任何日志调用消费它**——纯装饰性配置 |
| 5. 能力是否真实现 | src/index.js | **命中** | `timeoutMs` 注释称"单次超时上限"，实际只被当作 `retry` 的 `maxDelay`；**超时能力完全不存在**，handler 跑多久都不会被打断 |
| 5. 能力是否真实现 | src/neg-catch.js | 未命中 | 函数名/注释与行为一致（"尽力删除"确实返回 boolean，空 catch 语义正确） |
| 5. 能力是否真实现 | src/neg-race.js | 未命中 | 注释声称"无 await 间隔故无竞态"，实测 `incrementAsync` 确实在写之后才 `await`，声称成立 |
| 5. 能力是否真实现 | src/neg-unused.js | 未命中 | 声称"公共 API，非死代码"，导出确实构成对外契约，不是死代码 |
| 5. 能力是否真实现 | src/queue.js | **命中** | 注释声称"容量上限"与"同优先级 FIFO"，两者都未实现：上限被 `>` 突破 1 个；同优先级实际是 **LIFO** |
| 5. 能力是否真实现 | src/retry.js | **命中** | 注释声称 `base * 2^(attempt-1)`，实现是 `base * 2^attempt`，每次退避翻倍（首跳 2×base） |
| 5. 能力是否真实现 | src/store.js | **命中** | 文件头注释声称"先写临时文件再 rename，避免半写状态"，实现是 `rmSync` 后 `writeFileSync`，`renameSync` **从未 import**；注释还自认"中途失败会导致数据丢失" |
| 5. 能力是否真实现 | src/worker-pool.js | **命中** | 声称"以固定并发度跑一组任务，每个任务跑一次"，实际因 cursor 竞态同一任务被重复执行多次、另有任务一次都不跑 |

---

## 发现 25

### 1. `runWithConcurrency` 索引竞态：任务重复执行 + 任务被静默跳过
- **file**: src/worker-pool.js:19-22
- **类型**: 并发 / 数据一致性
- **严重性**: CRITICAL
- **问题**: `const idx = cursor; await Promise.resolve(); cursor += 1;` —— 自增发生在 `await` **之后**。N 个 worker 全部启动后先同步读到同一个 `cursor`，再各自 `await`，于是同一索引被 N 个 worker 同时领走；后续索引整段被跳过。输入 `[0..5]`（6 个任务）、`concurrency=4` → 任务 0 被调用 4 次，任务 1/2/3 **一次都没跑**，返回数组 `[0, null, null, null, 40, 50]`，空洞为 `undefined`。用在 `processTasks` 上意味着 "部分任务被丢弃、部分被重复执行"——对非幂等 handler（扣款、发信）是灾难。
- **证据**: 连跑 10 次结果完全一致，非偶发：
  ```
  run 0..9  seen= 0,0,0,0,4,5  holes= [1,2,3]
  1 task, concurrency 3 -> handler invoked 3 times (should be 1)
  tasks=2 conc=5 seen= 1,1,1,1,1 results= [{"ok":true,"value":1},null]
  ```

### 2. `processTasks` 先清空入参数组再执行，一个任务都不跑
- **file**: src/index.js:28
- **类型**: 数据一致性 / 逻辑
- **严重性**: CRITICAL
- **问题**: 第 23-26 行把 `tasks` 逐个 `enqueue` 进队列（无任何消费），第 28 行 `tasks.length = 0` 清空调用方数组，第 30 行却把这个**已清空的数组**传给 `runWithConcurrency`。任何输入 → 返回 `[]`，handler 永不调用；且调用方的数组被静默清空（副作用外泄）。注释"假设队列持有的是独立副本"是错误假设——队列里的副本从未被读取。
- **证据**:
  ```
  handler invoked for ...   <- 一行都没有
  processTasks returned: [] | caller array length now 0
  ```

### 3. 空批次直接抛错，正常业务场景被打断
- **file**: src/index.js:23
- **类型**: 边界 / 契约
- **严重性**: MEDIUM
- **问题**: `capacity: tasks.length`，当 `tasks` 为空数组时 `capacity = 0`，`TaskQueue` 构造函数要求 `capacity > 0`，于是 `processTasks([])` 抛 `TypeError: capacity must be a positive number`。"今天没有任务"是常见输入，却被当成参数错误。同时 `tasks` 为 `undefined`/非数组时也在 `tasks.length` 处抛原生 TypeError（未走 `worker-pool` 的友好校验）。
- **证据**: `empty batch THROW TypeError: capacity must be a positive number`；`processTasks(undefined)` → `Cannot read properties of undefined (reading 'length')`

### 4. `JsonStore` 构造后即处于不可用状态（解析结果不校验形状）
- **file**: src/store.js:19-28
- **类型**: 解析 / 错误处理
- **严重性**: HIGH
- **问题**: `#load` 直接 `return JSON.parse(raw)`，未校验结果是普通对象。文件内容为 `null` → 构造成功；随后 `get()` 抛 `TypeError: Cannot use 'in' operator to search for 'a' in null`，`set()` 抛 `Cannot set properties of null`。`123` / `"str"` / `true` 同样构造成功、读写即崩。`[1,2,3]` 更隐蔽：被当成 map，`keys()` 返回 `["0","1","2"]`，`set` 写进去后把数组序列化——store 变数组且不报错。`null` 是最典型的"文件存在但内容是 `null`"场景（其他工具写出的空值）。
- **证据**:
  ```
  "null"   -> get() THROW TypeError: Cannot use 'in' operator to search for 'a' in null
  "123"    -> get() THROW TypeError: Cannot use 'in' operator to search for 'a' in 123
  "\"str\"" -> get() THROW TypeError: Cannot use 'in' operator to search for 'a' in str
  "[1,2,3]" -> get("a") = undefined | keys = ["0","1","2"]   (静默错型)
  "true"   -> get() THROW TypeError: Cannot use 'in' operator to search for 'a' in true
  ```

### 5. 损坏 JSON 被静默吞成 `{}`，下一次写入覆盖全部原数据
- **file**: src/store.js:23-27
- **类型**: 异常吞没 / 数据丢失
- **严重性**: HIGH
- **问题**: `catch { return {} }` 让"文件损坏"和"文件是空 store"完全不可区分。构造不报错，第一次 `set()` 就把 `{}` + 新键写回同一路径，原文件内容永久丢失（无备份、无告警）。对持久化组件来说，静默把损坏当成空是最危险的选择——用户以为只加了一个键，实际清空了整库。
- **证据**: 写入截断 JSON `{"important": "data"` → 构造后 `keys()` 为 `[]`；`set('x',1)` 后文件变成 `{"x":1}`，"important" 不可恢复。

### 6. 所谓"原子写入"实际是先删后写，崩溃窗口内数据全丢
- **file**: src/store.js:50-56
- **类型**: 数据一致性 / 能力未实现
- **严重性**: HIGH
- **问题**: 文件头注释声称"先写临时文件再 rename，避免半写状态"，`#persist` 实现却是 `if (existsSync) rmSync(path)` 然后 `writeFileSync(path, ...)`。`renameSync` 从未被 import。删与写之间进程被杀 / 磁盘满 / 断电 → 原文件已删、新文件未成，**数据 100% 丢失**（不是"半写"，是"没有"）。代码自己的注释都承认"中途失败会导致数据丢失"，与文件头的能力声明直接矛盾。
- **证据**: `store.js imports: writeFileSync, readFileSync, existsSync, mkdirSync, rmSync | renameSync imported? false`；源码第 53 行注释即"先删原文件再写——中途失败会导致数据丢失"。

### 7. `get()` 用 `in` 判断键存在，把原型链成员当数据返回
- **file**: src/store.js:31
- **类型**: 安全 / 原型链泄漏
- **严重性**: HIGH
- **问题**: `(key in this.#data)` 会命中 `Object.prototype`。`get('constructor')`、`get('toString')`、`get('hasOwnProperty')` 返回**继承来的函数**，`get('__proto__')` 返回对象——调用方以为拿到了存储值，实际拿到可执行的原生函数，典型场景是把 store 值直接当数据用/序列化/拼日志时的信息泄漏与类型混淆。同文件 `delete()` 第 40 行用的却是 `hasOwnProperty`，两处判断语义相反。
- **证据**:
  ```
  get("constructor") = function (LEAK: inherited member)
  get("toString")    = function (LEAK: inherited member)
  get("__proto__")   = object   (LEAK: inherited member)
  delete("toString") -> false   (此处语义正确，与 get 不一致)
  ```

### 8. `get()` 返回内部活引用：内存态与磁盘态静默分叉
- **file**: src/store.js:31
- **类型**: 封装泄漏 / 数据一致性
- **严重性**: MEDIUM
- **问题**: `get` 返回 `this.#data[key]` 本身。调用方 `store.get('cfg').a = 99` 后，内存里是 `{a:99}`，磁盘上仍是 `{a:1}`，`set` 未被触发；进程重启后修改无声消失。这是"看起来保存成功、实际丢失"的一类最难排查的 bug。
- **证据**:
  ```
  in-memory after mutating get() result: {"a":99}
  on-disk: {"cfg":{"a":1}}
  after reload: {"a":1}   <- 分叉
  ```

### 9. `set` 不校验 key，`__proto__` / `undefined` 值静默丢失
- **file**: src/store.js:34-37
- **类型**: 契约 / 数据丢失
- **严重性**: MEDIUM
- **问题**: 两个静默失败：(a) `set('__proto__', {...})` 改写的是原型而非自有属性，`keys()` 为空、文件为 `{}`，用户以为写成功了；(b) `set('u', undefined)` 让 `keys()` 出现 `"u"`，但 `JSON.stringify` 丢弃 `undefined`，文件里没有——内存与磁盘立刻不一致，重载后键消失。key 为 `null` / 对象时同样被隐式转成字符串。
- **证据**:
  ```
  after set __proto__: keys= [] | file= {}
  set key=u value=undefined -> keys ["u"] | file {}
  ```

### 10. `capacity` 校验放行 `NaN` / `Infinity` / 小数
- **file**: src/queue.js:9-12
- **类型**: 数值边界
- **严重性**: MEDIUM
- **问题**: 守卫是 `typeof capacity !== 'number' || capacity <= 0`。`NaN <= 0` 为 `false`，`NaN` 通过；`Infinity` 通过；`0.5` 通过。后果："容量上限"这一能力被静默关闭——`capacity=NaN` 时比较 `length > NaN` 恒为 `false`，队列**无限增长**，内存无界。
- **证据**:
  ```
  capacity NaN      ACCEPT -> capacity= NaN   -> accepted 10 items (无上限)
  capacity Infinity ACCEPT -> capacity= Infinity -> accepted 10 items
  capacity 0.5      ACCEPT -> capacity= 0.5   -> accepted 1 items
  ```

### 11. 容量检查用 `>`，实际可塞入 `capacity + 1` 个
- **file**: src/queue.js:34
- **类型**: 边界 / off-by-one
- **严重性**: MEDIUM
- **问题**: `if (this.#items.length > this.#capacity) return false;` 在 `length === capacity` 时不拦截，`push` 后长度为 `capacity+1`。`capacity=1` 的队列实际容纳 2 个任务。容量是内存保护，多 1 个通常不致命，但对"背压/限流"语义是明确的契约违背。
- **证据**: `capacity=1 -> accepted 2 items`；`capacity=2 -> accepted 3 items`；`capacity=3 -> accepted 4 items`。

### 12. `dequeue` / `peek` 用 `>=` 选最大，同优先级变成 LIFO
- **file**: src/queue.js:53、src/queue.js:65
- **类型**: 逻辑 / 顺序破坏
- **严重性**: HIGH
- **问题**: 注释明确写"同优先级按 FIFO"，但循环条件是 `this.#items[i].priority >= this.#items[bestIdx].priority`，相等时后者胜出，于是返回**最后入队**的元素。三个同优先级任务出队顺序为 `third,second,first`。FIFO 是队列的基本契约，打破它会让依赖"同优先级保序"的去重/串行语义（如按用户 id 顺序处理）出错。注意 `peek` 与 `dequeue` 复制了同一段错误逻辑，两处都需改。
- **证据**:
  ```
  peek with 3 equal priorities -> third (FIFO 应为 first)
  dequeue order -> third,second,first
  ```

### 13. `peek()` 返回队列内部对象引用
- **file**: src/queue.js:69
- **类型**: 封装泄漏
- **严重性**: MEDIUM
- **问题**: `return this.#items[bestIdx]` 把内部元素直接交出去。调用方 `q.peek().id = 'x'` 即改写队列内任务的身份；更实际的是 `q.peek().priority = -100` 会**改变出队顺序**（优先级是排序键，且被外部改过）。"只读查看"的语义完全不成立。
- **证据**:
  ```
  peek().id after mutation -> HACKED   (内部原值 'a')
  peek() same ref twice -> true
  q.peek().priority = -100 后 dequeue 顺序变为 b,a
  ```

### 14. `enqueue` 浅拷贝，嵌套字段仍与调用方共享
- **file**: src/queue.js:37-41
- **类型**: 封装泄漏
- **严重性**: LOW
- **问题**: `{...task, priority, enqueuedAt}` 只做一层展开。`task.meta` 等嵌套对象与调用方是同一引用，调用方在入队后修改 `nested.meta.x` 会直接改变队列中任务的载荷。优先级字段被正常拷贝（`Number.isFinite` 兜底），这点是对的。
- **证据**: `q2.enqueue(nested); nested.meta.x = 42` → `q2.peek().meta.x === 42`。

### 15. `remove(id)` 缺 id 校验，与 `enqueue` 的守卫不一致
- **file**: src/queue.js:73-78
- **类型**: 守卫一致性
- **严重性**: LOW
- **问题**: `enqueue` 对 `task.id` 要求"非空字符串"，同族的 `remove(id)` 对 `id` 不做任何检查。传入 `undefined` / `null` / `123` 时静默返回 `false`，与"没找到这个 id"无法区分——调用方无法判断是自己传错了参数还是任务真的不存在，错误被延后到更难定位的地方。
- **证据**: `remove(undefined) -> false`、`remove(null) -> false`、`remove(123) -> false`（均无异常、无提示）。

### 16. `clear()` 的 JSDoc 声称返回 boolean 且"总是 true"，实现无 return
- **file**: src/queue.js:80-86
- **类型**: 契约 / 文档
- **严重性**: LOW
- **问题**: `@returns {boolean} 总是 true`，实际函数体只有 `this.#items.length = 0`，返回 `undefined`。依赖 `if (q.clear())` 的调用方永远走 false 分支。
- **证据**: `clear() returned: undefined (doc says always true)`。

### 17. `parsePositiveInt` 只校验 integer，不校验 positive
- **file**: src/config.js:13-20
- **类型**: 数值边界
- **严重性**: HIGH
- **问题**: 函数名与错误信息都声称"positive integer"，实现只有 `Number.isInteger(n)`。`CONCURRENCY=0` → `0`，`CONCURRENCY=-3` → `-3`，全部通过。下游后果：`concurrency=0` 让 `runWithConcurrency` 抛 RangeError（服务起不来）；`retryMax=0` 进入 `retry` 的 `maxAttempts=0` 分支并 `throw undefined`（见发现 19）；`timeoutMs=-1` 变成负的退避上限。这是**唯一**的数值配置入口，三个字段都受影响。
- **证据**:
  ```
  CONCURRENCY="0"  -> 0
  CONCURRENCY="-3" -> -3
  CONCURRENCY="4.5"-> THROW   (小数反而被拦，说明只差一个 > 0)
  CONCURRENCY=""   -> 4 (回退默认)
  ```
  另：`Number()` 的宽松转换也顺带放行 `"0x10"` → 16、`" 7 "` → 7、`"1e3"` → 1000。

### 18. `VALID_LOG_LEVELS` 漏掉 `warn`
- **file**: src/config.js:11
- **类型**: 契约
- **严重性**: MEDIUM
- **问题**: 白名单只有 `debug` / `info` / `error`。`LOG_LEVEL=warn` 是所有日志框架的通用级别，却会直接抛 `TypeError` 让服务启动失败。用户按常规习惯配置即触发不可用。
- **证据**: `VALID_LOG_LEVELS = ['debug','info','error']`；`loadConfig({LOG_LEVEL:'warn'})` → `TypeError: logLevel must be one of debug|info|error, got: warn`。

### 19. `logLevel` 配置项被读、被校验，但从未被任何代码消费
- **file**: src/config.js:7、src/config.js:30-37
- **类型**: 能力未实现 / 死配置
- **严重性**: MEDIUM
- **问题**: 全仓库 grep `logLevel` 只出现在 `config.js`（定义、校验、返回）和 `index.js` 的透传之外——**没有任何一行日志语句读取它**，也没有 logger 模块。用户可以设 `LOG_LEVEL=debug` 并相信打开/关闭了日志，实际完全不生效。这比"没有这个配置"更糟：它给了错误的能力承诺。
- **证据**: `grep -rn "logLevel" src/` 命中 6 行，全部在 `config.js` 的定义/校验/返回中；`index.js` 只把 `config` 传给 `retry`/`runWithConcurrency`，二者都不读 `logLevel`。

### 20. `timeoutMs` 不是超时，超时能力整体缺失
- **file**: src/index.js:34
- **类型**: 能力未实现
- **严重性**: HIGH
- **问题**: 配置名 `timeoutMs` + 注释"timeoutMs 是单次超时上限"声称提供单次任务超时。实际它只被当作 `retry` 的 `maxDelay`（退避等待上限）传入——语义完全不同的两件事。`handler` 卡死（网络无响应、死锁）时没有任何 `AbortController` / `Promise.race` 介入，整个 `processTasks` 永久挂起。这是典型的"配置项存在 → 使用者以为有保护 → 实际没有"。
- **证据**: 全仓库 grep `timeoutMs` 仅 4 处，均在 `config.js` 定义与 `index.js:34` 的 `maxDelay: config.timeoutMs`；实测 `TIMEOUT_MS=100` 时 handler 跑 1500ms 仍正常返回，`elapsed 1581 ms | result {"ok":true,"value":"finished after 1500ms"}`，无超时。

### 21. `retry` 的 `maxAttempts` 放行 0 / 负数，抛出的不是 Error 而是 `undefined`
- **file**: src/retry.js:32-47
- **类型**: 数值边界 / 错误处理
- **严重性**: MEDIUM
- **问题**: 守卫是 `if (!Number.isInteger(maxAttempts))`，缺 `|| maxAttempts < 1`。`maxAttempts=0` 或 `-1` 时 for 循环一次都不进，`lastError` 保持 `undefined`，最后 `throw lastError` 抛出 `undefined`。调用方 `catch (e) { log(e.message) }` 会立刻二次抛 `TypeError: Cannot read properties of undefined`，真正的原因被彻底掩盖——这是"错误处理把错误吃掉"的经典形态。与同文件 `backoffDelay` 的 `attempt < 1` 校验形成鲜明对比（同一模块内守卫不一致）。
- **证据**:
  ```
  maxAttempts 0  REJECT -> UNDEFINED (not an Error!)
  maxAttempts -1 REJECT -> UNDEFINED (not an Error!)
  maxAttempts 0.5/NaN/Infinity -> RangeError（正确拦截）
  ```
  叠加发现 17：`RETRY_MAX=0` 可直接从环境变量走到这条路径。

### 22. `backoffDelay` 指数写错，退避时长整体翻倍
- **file**: src/retry.js:8、src/retry.js:15
- **类型**: 逻辑 / 能力偏差
- **严重性**: HIGH
- **问题**: 注释与 JSDoc 均写 `base * 2^(attempt-1)`（`attempt` 从 1 开始），实现是 `base * Math.pow(2, attempt)`，即多乘一个 2。首跳从 100ms 变成 200ms，第 n 跳全部 2 倍。对"重试风暴保护"影响有限，但对延迟敏感场景（配置了 `base=50` 期望 50/100/200）会稳定地多等一倍，属可观测的行为偏差（也会放大 `maxDelay` 的实际等待）。
- **证据**:
  ```
  base=100 attempt=1 -> 200 (doc expects 100)
  base=100 attempt=2 -> 400 (doc expects 200)
  ```

### 23. `backoffDelay` 的 `base` / `maxDelay` 让 `NaN` 与字符串通过，退避退化为 1ms
- **file**: src/retry.js:12-13
- **类型**: 数值边界
- **严重性**: MEDIUM
- **问题**: `if (base <= 0) throw` —— `NaN <= 0` 为 `false`，`NaN` 通过；`if (maxDelay < base) throw` —— `NaN < base` 也为 `false`，`NaN` 通过。随后 `Math.min(safe, NaN)` 返回 `NaN`，`setTimeout(fn, NaN)` 被 Node 当作 1ms，**指数退避完全失效**，重试变成紧循环打爆下游。`base="100"` 字符串也能过（隐式转换），`base=null` 变成 `0` 时被 `<=0` 拦下但报错信息误导。
- **证据**:
  ```
  attempt=1 opts={"base":null}            -> 30000   (null 转 0 未按预期报错路径)
  attempt=1 opts={"base":100,"maxDelay":NaN} -> NaN
  elapsed with maxDelay=NaN: 1 ms   (Node: TimeoutNaNWarning, duration set to 1)
  attempt=1 opts={"base":"100"}           -> 200     (字符串被接受)
  ```

### 24. `tryParseJson("null")` 与解析失败返回同一个 `null`，且注释断言相反
- **file**: src/neg-catch.js:28-39
- **类型**: 契约 / 文档错误
- **严重性**: LOW
- **问题**: 注释写"调用方用 `=== null` 明确区分失败与成功，后者在这里不可能出现，因为 `JSON.parse` 永远不会返回 null"——事实错误：`JSON.parse("null") === null`。因此合法 JSON 字面量 `null` 与语法错误被归为同一结果，调用方无法区分。该文件的其它设计（空 catch 语义、返回 boolean）经核实是正确的，**不是缺陷样本**，仅此处注释论证有误。
- **证据**: `JSON.parse('null') === null` → `true`；`tryParseJson("null") === tryParseJson("{bad")` → `true`。

### 25. `tryRemoveTemp` 对 `path` 无类型守卫，非字符串输入触发弃用告警
- **file**: src/neg-catch.js:15-25
- **类型**: 守卫一致性
- **严重性**: LOW
- **问题**: 同模块的 `tryParseJson` 有 `typeof text !== 'string'` 守卫、`safeClose` 有 `typeof handle.close === 'function'` 守卫；`tryRemoveTemp` 把 `path` 直接交给 `existsSync`。传 `undefined` / `123` 时 Node 抛 `DEP0187 DeprecationWarning`（未来版本将变成 TypeError），当前"碰巧"返回 `false` 而不报错。功能无实际损害，但同族函数的防御水位不一致。
- **证据**: `tryRemoveTemp(undefined) -> false` 并伴随 `[DEP0187] DeprecationWarning: Passing invalid argument types to fs.existsSync is deprecated`。

---

## 附：负例文件核验（避免误报）

| 文件 | 结论 | 依据 |
|---|---|---|
| src/neg-catch.js | **无真实缺陷**（仅发现 24/25 两处 LOW） | 3 个 `catch {}` 均刻意为空且不破坏状态；`tryRemoveTemp` 返回 boolean 供调用方判断；`safeClose` 先做能力检测。空 catch 不等于吞错 |
| src/neg-race.js | **无真实缺陷** | `increment` 是纯同步读-改-写；`incrementAsync` 的 `await` 在写**之后**，不构成 read-modify-write 跨 await。实测 `batchIncrement(counter, 5)` 精确得 +5，且 `count` 的校验（`Number.isInteger && >= 0`）是全仓库最规范的 |
| src/neg-unused.js | **无真实缺陷** | `ERROR_CODES` / `VERSION` / `normalizeError` / `isValidTask` 是导出契约，零内部引用属正常；`ERROR_CODES` 已 `Object.freeze`，`isValidTask` 守卫完整。不应判为死代码 |

## 附：按模式的命中统计

| 模式 | 命中文件数 | 命中的文件 |
|---|---|---|
| 1. 返回值暴露内部状态 | 2 / 9 | queue.js、store.js |
| 2. 同族函数守卫一致 | 5 / 9 | index.js、neg-catch.js、queue.js、retry.js、store.js |
| 3. 数值边界完整 | 4 / 9 | config.js、index.js、queue.js、retry.js |
| 4. 解析结果校验形状 | 2 / 9 | neg-catch.js、store.js |
| 5. 能力是否真实现 | 6 / 9 | config.js、index.js、queue.js、retry.js、store.js、worker-pool.js |

未命中任一模式的只有 `neg-race.js` 与 `neg-unused.js`——与它们"负例、无缺陷"的设计意图一致，可作为框架是否会产生误报的对照。
