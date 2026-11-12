# AB-P3 审计报告

**目标**: `<HOME>\AppData\Local\Temp\iso-ab-p3\code\`（9 个文件，466 行，全部读完）
**方法**: 静态逐行阅读 + 在 `%TEMP%` 中写 Node 探针脚本实跑验证（只读，未修改目标）
**验证脚本**: `%TEMP%\audit-p3-probe.mjs` / `-probe2.mjs` / `-probe3.mjs` / `-probe4.mjs` / `-probe5.mjs` / `-probe6.mjs` / `-probe7.mjs`

---

## 模式检查结果

| 模式 | 文件 | 命中/未命中/不适用 | 说明 |
|---|---|---|---|
| 1 返回值暴露内部状态 | src/config.js | 未命中 | `loadConfig` 返回新对象字面量（L37），四个值均为原始类型；`DEFAULTS` 已 `Object.freeze`（L4），返回的不是它的引用。调用方改返回值不影响模块状态。 |
| 1 返回值暴露内部状态 | src/index.js | 未命中 | `processTasks` 返回 `raw`（L38），是 `runWithConcurrency` 的局部 `results` 数组，模块不保留引用。注意：该数组本身是稀疏的（见发现 2），但那不是"内部状态泄漏"。 |
| 1 返回值暴露内部状态 | src/queue.js | **命中** | `peek()` 返回 `this.#items[bestIdx]`（L69），与内部数组元素同一引用。实测：改 `peek()` 结果的 `priority` 再 `dequeue()`，读出 `-999`。见发现 5。另 `enqueue` 用 `{...task}` 浅拷贝（L37-41），嵌套对象仍共享，外部改嵌套会污染内部。 |
| 1 返回值暴露内部状态 | src/retry.js | 不适用 | `backoffDelay` 返回 number，`retry` 原样透传 `fn` 的返回值，不持有任何内部容器。 |
| 1 返回值暴露内部状态 | src/store.js | **命中** | `get(key)` 直接返回 `this.#data[key]`（L31）。实测：`const v=st.get('cfg'); v.nested.v=777` 后内部 `get('cfg').nested.v` 变成 777。见发现 4。`keys()` 用 `Object.keys` 返回新数组（L47），未命中。 |
| 1 返回值暴露内部状态 | src/worker-pool.js | 未命中 | 返回局部 `results`（L14/L36），函数退出后无人持有，不存在回写内部的问题。 |
| 1 返回值暴露内部状态 | src/neg-catch.js | 未命中 | `tryParseJson` 每次返回 `JSON.parse` 的新对象（实测两次调用 `a!==b`）；`tryRemoveTemp`/`safeClose` 返回 boolean。 |
| 1 返回值暴露内部状态 | src/neg-race.js | 未命中 | `value` getter、`increment`、`batchIncrement` 返回的都是 number 原始值，无引用可泄漏。 |
| 1 返回值暴露内部状态 | src/neg-unused.js | 未命中 | `normalizeError` 每次构造新对象字面量（L27/L32）；`isValidTask` 返回 boolean；`ERROR_CODES` 已 `Object.freeze`（L11）。 |
| 2 同族守卫一致性 | src/config.js | 未命中 | `parsePositiveInt` 对 `concurrency/timeoutMs/retryMax` 三个字段用同一守卫（L26-28），一致；`logLevel` 是枚举类型，用 `includes` 校验（L31），属不同类型，合理。字段间无差异。（守卫本身不完整，见模式 3） |
| 2 同族守卫一致性 | src/index.js | **命中** | `processTasks` 只校验 `handler`（L18），完全不校验 `tasks`；而同模块协作的 `runWithConcurrency` 第一句就 `if (!Array.isArray(tasks)) throw`（worker-pool L8）。传 `undefined` 时得到的是 `Cannot read properties of undefined (reading 'length')`（实测）。见发现 13。 |
| 2 同族守卫一致性 | src/queue.js | **命中** | ①`enqueue` 校验 `task.id` 必须非空 string（L31），但 `remove(id)` 对 `id` 零校验（L73）。②构造函数容量守卫用 `typeof === 'number'`（L9），而同包 `runWithConcurrency` 与 `loadConfig` 对"正整数"要求 `Number.isInteger`——三处同族校验口径不一致。见发现 8/16。 |
| 2 同族守卫一致性 | src/retry.js | **命中** | 同模块两个函数都校验"正整数"：`backoffDelay` 要求 `Number.isInteger(attempt) && attempt >= 1`（L9），完整；`retry` 只要求 `Number.isInteger(maxAttempts)`（L32），**漏掉下界**，接受 0 和负数。见发现 7。 |
| 2 同族守卫一致性 | src/store.js | **命中** | 同一"键是否存在"语义，`get` 用 `key in this.#data`（L31，包含原型链），`delete` 用 `hasOwnProperty`（L40，只认自有属性），两者结论相反：实测 `get('toString')` 返回 function（真值），`delete('toString')` 返回 false。见发现 3。构造函数校验 `path`（L12），其余方法对 `key` 零校验。 |
| 2 同族守卫一致性 | src/worker-pool.js | 未命中 | 三个参数 `tasks`/`concurrency`/`runner` 分别用 `Array.isArray`、`Number.isInteger && >= 1`、`typeof === 'function'`（L8-12），校验完整且互相独立，无遗漏。 |
| 2 同族守卫一致性 | src/neg-catch.js | 未命中 | 三个函数都是"前置守卫 + try/catch 降级"同一模式：`existsSync`（L16）、`typeof text !== 'string'`（L33）、`handle && typeof handle.close === 'function'`（L46）。各自参数类型不同，守卫强度适配，一致。 |
| 2 同族守卫一致性 | src/neg-race.js | 未命中 | 只有 `batchIncrement` 有参数（`count`，L47 非负整数校验）；`increment`/`incrementAsync` 无参，无可比对象。 |
| 2 同族守卫一致性 | src/neg-unused.js | 未命中 | `isValidTask`（L43-49）的判据（object + `id` 为非空 string）与 `queue.enqueue`（L28-33）完全一致，跨文件口径对齐。`normalizeError` 无参数约束需求。 |
| 3 数值边界校验 | src/config.js | **命中** | `parsePositiveInt` 名为"positive"，错误文案也写 "positive integer"，但只做 `Number.isInteger(n)`（L16），**未检查 `n > 0`**。实测 `CONCURRENCY=0`→0、`CONCURRENCY=-5`→-5、`CONCURRENCY=-99999`→-99999 均通过；`CONCURRENCY="   "`（纯空格）经 `Number('   ')`→0 也通过（L14 只挡了 `''`，没 trimming）。`NaN`/`Infinity`/小数被 `Number.isInteger` 正确挡下。见发现 6。 |
| 3 数值边界校验 | src/index.js | 不适用 | 本文件不直接校验数值；把 `config.concurrency` 与 `config.retryMax` 转交下游。但下游的守卫漏洞会经由它放大（见发现 6/7）。 |
| 3 数值边界校验 | src/queue.js | **命中** | 构造守卫 `typeof capacity !== 'number' \|\| capacity <= 0`（L9）：挡住 0、负数，但 **`NaN <= 0` 为 false → NaN 通过**（实测 `capacity=NaN` 不抛错）；`Infinity` 通过；`1.5` 通过（非整数）。另 L34 的容量边界用 `>` 而非 `>=`，**off-by-one**：`capacity=2` 实际收 3 条（实测 `[true,true,true,false] size=3`）。见发现 8/9。 |
| 3 数值边界校验 | src/retry.js | **命中** | `backoffDelay` 的 `attempt` 守卫完整（L9，拒 0/负/NaN/Infinity/小数，实测全抛）。但 `base` 只判 `base <= 0`（L12）→ **NaN 漏过**（实测 `base=NaN` 返回 1000）；`maxDelay` 只判 `maxDelay < base`（L13）→ **NaN 漏过**（实测返回 `NaN`）。`retry` 的 `maxAttempts` 漏下界（见模式 2）。见发现 7/10。 |
| 3 数值边界校验 | src/store.js | 不适用 | 全文件无数值参数，只有 path/key/value。 |
| 3 数值边界校验 | src/worker-pool.js | 未命中 | `!Number.isInteger(concurrency) \|\| concurrency < 1`（L9）完整排除了 0、负数、NaN、Infinity、小数。实测 `0/-1/1.5/NaN/Infinity` 全部抛 RangeError。这是本仓库唯一一处写对的"正整数"守卫。 |
| 3 数值边界校验 | src/neg-catch.js | 不适用 | 无数值参数。 |
| 3 数值边界校验 | src/neg-race.js | 未命中 | `!Number.isInteger(count) \|\| count < 0`（L47）正确排除负数、NaN、Infinity、小数，并**有意**允许 0（语义是"非负"）。实测 `0`→0、`-1/1.5/NaN/Infinity` 全抛。 |
| 3 数值边界校验 | src/neg-unused.js | 不适用 | 无数值参数。 |

---

## 发现 18

### 发现 1 — 关键：`processTasks` 清空入参数组后才执行，导致一个任务都不跑
- **file**: src/index.js:28
- **类型**: 逻辑错误 / 数据流顺序错误
- **严重性**: **Critical**
- **问题**: L23-26 把任务入队到 `taskQueue`，L28 执行 `tasks.length = 0`，随后 L30 却把**已被清空的 `tasks`** 传给 `runWithConcurrency`，而不是队列。任何调用 → `handler` 一次都不执行 → 返回 `[]`。同时入队的 `TaskQueue` 被丢弃，任务永久丢失。L27 的注释"假设队列持有的是独立副本"暴露了作者混淆了两个变量。
- **证据**: 探针 `processTasks([{id:'a'},{id:'b'}], {handler})` → `handlerCalls = 0`, `result = []`；单任务同样 `calls = 0`。另测 `const t=[...]; TaskQueue...; t.length=0` 后 `q.size === 2`，证明队列本身确实独立持有副本，只是这份副本没被使用。

### 发现 2 — 关键：`runWithConcurrency` 的 cursor 在 await 之前读取，并发 worker 抢到同一索引
- **file**: src/worker-pool.js:19
- **类型**: 并发缺陷 / 竞态（真竞态，非误报）
- **严重性**: **Critical**
- **问题**: `const idx = cursor;`（L19）→ `await Promise.resolve();`（L20）→ `cursor += 1;`（L21）。三个 worker 在第一个微任务检查点前**全部**读到了相同的 `cursor`，然后各自 +1，于是索引 0 被执行 N 次，而 1..N-1 从未执行。`results` 数组对应位置留下空洞（`new Array(n)` 的稀疏洞，不是 `undefined` 值，`i in results` 为 false）。只要 `concurrency > 1` 且 `tasks.length > 1` 就必然触发。函数注释"最终把所有结果/错误按索引返回"不成立。
- **证据**: `runWithConcurrency([0,1,2,3], 3, ...)` → `executed=[0,0,0,3]`，`holes=[1,2]`；重复 5 次**结果完全一致**（确定性，非偶发）。矩阵测试：`tasks=2/conc=2 → [0,"HOLE"]`、`tasks=4/conc=4 → [0,HOLE,HOLE,HOLE]`、`tasks=8/conc=4 → [0,HOLE,HOLE,HOLE,4,5,6,7]`。仅 `concurrency === 1` 时正确。根因隔离模拟（去掉 runner）复现 `["A:0","B:0","C:0","A:1","B:2","C:3"]`。

### 发现 3 — 高：`JsonStore.get` 用 `in` 走原型链，且 `set('__proto__')` 污染原型
- **file**: src/store.js:31
- **类型**: 原型链污染 / 存在性判断错误
- **严重性**: **High**
- **问题**: `(key in this.#data) ? this.#data[key] : undefined`。①`in` 会命中 `Object.prototype`，所以 `get('toString')`、`get('valueOf')`、`get('constructor')` 都返回继承的函数（真值），调用方会误判"该键存在"并可能把它当数据使用/序列化。②`set('__proto__', v)` 走 `this.#data['__proto__'] = v` 赋值，改的是 `#data` 的原型而不是自有键，效果等同于原型污染：实测 `set('__proto__',{polluted:'YES'})` 后 `get('polluted')` 返回 `"YES"`，但 `keys()` 为空、落盘文件只有其他键。③`delete` 用 `hasOwnProperty`（L40），与 `get` 判定相反：`get('toString')` 为 function 而 `delete('toString')` 返回 false。
- **证据**: 探针 4/6：`get('toString')` → `typeof: "function"`；`set('__proto__',{polluted:1})` 后 `get('polluted')` → `1`，`keys()` → `[]`，磁盘 → `{ "a": 1 }`，重新加载后 `get('polluted')` → `undefined`（说明只在内存里污染，不持久）。`delete('valueOf')` → `false`。建议改 `Object.create(null)` 或 `hasOwnProperty` + `Object.defineProperty` / `Map`。

### 发现 4 — 高：`JsonStore.get` 返回内部对象引用
- **file**: src/store.js:31
- **类型**: 封装泄漏（模式 1）
- **严重性**: **High**
- **问题**: 返回 `#data[key]` 本体。调用方 `const cfg = store.get('cfg'); cfg.nested.v = 777` 会直接改掉 store 的内存状态，而**磁盘不会同步**（因为没走 `set`），造成内存与持久化文件静默分叉——后续任何一次 `#persist()`（由无关的 `set`/`delete` 触发）会把调用方的临时修改意外落盘。
- **证据**: `st.set('cfg',{nested:{v:1}}); st.get('cfg').nested.v=777;` → 内存 `st.get('cfg').nested.v === 777`，磁盘文件里仍是 `1`。应返回 `structuredClone` 或深冻结副本。

### 发现 5 — 高：`TaskQueue.peek` 返回内部元素引用
- **file**: src/queue.js:69
- **类型**: 封装泄漏（模式 1）
- **严重性**: **High**
- **问题**: `peek()` 本该只读，却把 `#items[bestIdx]` 原样交出。调用方修改返回对象的 `priority` 会直接改变队列的排序，修改业务字段会改变随后 `dequeue()` 拿到的数据。`peek` 的语义保证（"查看但不出队"）被破坏——实际可以借它改队列内容。
- **证据**: `q.enqueue({id:'a',priority:1,payload:{n:1}}); const p=q.peek(); p.priority=-999; p.payload.n=42;` → 随后 `dequeue()` 得到 `priority=-999`、`payload.n=42`，且 `p === out` 为 true。
- **补充**: `enqueue` 的 `{...task}`（L37）是浅拷贝，嵌套对象仍与调用方共享。实测入队后改原对象 `nested.v=99`、`arr.push(2)`，出队对象同步变成 99 / `[1,2]`。

### 发现 6 — 高：`parsePositiveInt` 未校验正数，0 / 负数 / 纯空格全部通过
- **file**: src/config.js:16
- **类型**: 数值边界校验不完整（模式 3）
- **严重性**: **High**
- **问题**: 函数名和错误文案都声称 "positive integer"，实现只有 `Number.isInteger(n)`。`Number.isInteger(0) === true`、`Number.isInteger(-5) === true`，所以 0 和负数放行。另外 L14 只判断 `raw === ''`，没有判空白串，`Number('   ') === 0` 让纯空格配置静默变成 0。下游后果：`CONCURRENCY=0` → `runWithConcurrency` 抛 RangeError（启动崩溃）；`RETRY_MAX=0` → 见发现 7，任务全部以 `undefined` 异常失败。
- **证据**: `loadConfig({CONCURRENCY:'0'}).concurrency === 0`；`'-5' → -5`；`'-99999' → -99999`；`'   ' → 0`。对照：`'NaN'`/`'Infinity'`/`'-Infinity'`/`'3.7'`/`'-0.5'` 均被正确抛 TypeError。
- **修复**: `if (!Number.isInteger(n) || n <= 0) throw ...`，并在 L14 改用 `raw == null || String(raw).trim() === ''`。

### 发现 7 — 高：`retry` 的 `maxAttempts` 只校验整数，0 / 负数导致 reject 出 `undefined`
- **file**: src/retry.js:32
- **类型**: 数值边界校验不完整 + 同族守卫不一致（模式 2/3）
- **严重性**: **High**
- **问题**: 同模块的 `backoffDelay` 要求 `attempt >= 1`，`retry` 却只写 `Number.isInteger(maxAttempts)`，漏了下界。`maxAttempts = 0` 时 `for` 循环一次都不进，`lastError` 仍是 `undefined`，L47 `throw lastError` 于是 **reject 一个 `undefined`**（不是 Error 对象）。调用方 `catch (e) { e.message }` 会二次崩溃，日志里也拿不到任何信息。负数同理。
- **证据**: `await retry(async()=> 'x', {maxAttempts:0})` → `rejected with: undefined | typeof: undefined | instanceof Error: false`；`maxAttempts=-1` 同样。`maxAttempts=1.5/NaN/Infinity` 被正确抛 RangeError。

### 发现 8 — 高：`TaskQueue` 容量守卫放过 NaN / Infinity / 小数
- **file**: src/queue.js:9
- **类型**: 数值边界校验不完整（模式 3）
- **严重性**: **High**
- **问题**: `typeof capacity !== 'number' || capacity <= 0`。`typeof NaN === 'number'` 为 true 且 `NaN <= 0` 为 **false**，所以 `capacity = NaN` 通过校验；`Infinity` 同样通过；`1.5` 也通过（未要求整数，与 `runWithConcurrency`、`loadConfig` 的口径不一致）。`#capacity = NaN` 之后，`enqueue` 的 `this.#items.length > NaN`（L34）恒为 false，容量上限彻底失效 → 队列无界增长 → OOM 风险。
- **证据**: `new TaskQueue({capacity: NaN})` 不抛错（探针输出该字段为 `null`，即 `JSON.stringify(NaN)`）；`capacity: Infinity` 同样静默通过；`capacity: 1.5` 通过。对照 `capacity: 0` / `-1` / `"4"` 正确抛 TypeError。

### 发现 9 — 中：`enqueue` 容量边界 off-by-one，可超容 1 条
- **file**: src/queue.js:34
- **类型**: 数值边界 / 比较运算符错误
- **严重性**: Medium
- **问题**: `if (this.#items.length > this.#capacity) return false;` 在 push 之前判断。长度等于容量时仍会 push，实际可容纳 `capacity + 1` 条。应以 `>=` 判断。
- **证据**: `capacity=2` 连续入队 4 条 → `[true,true,true,false]`，最终 `size=3`；`capacity=1` → size 2；`capacity=3` → size 4。

### 发现 10 — 中：`backoffDelay` 的 `base` / `maxDelay` 未排除 NaN
- **file**: src/retry.js:12
- **类型**: 数值边界校验不完整（模式 3）
- **严重性**: Medium
- **问题**: `base <= 0` 只挡 0 和负数，`NaN <= 0` 为 false → NaN 通过；`maxDelay < base` 同理放过 `maxDelay = NaN`。后果：`base=NaN` 时 `exponential` 为 NaN，`Number.isFinite` 判否 → `safe = maxDelay`，函数静默返回 `maxDelay`（错误但无害）；`maxDelay=NaN` 时直接返回 `NaN`，随后 `setTimeout(NaN)` 等价 0ms → 退避失效，退化成紧密重试循环，打爆下游。注释 L16 声称"防止 Math.pow 溢出成 Infinity"，但对 NaN 没有防护。
- **证据**: `backoffDelay(3,{base:NaN,maxDelay:1000})` → `1000`；`backoffDelay(3,{base:10,maxDelay:NaN})` → `NaN`；对照 `base=0/-1`、`maxDelay=0/-1` 正确抛错。

### 发现 11 — 中：`backoffDelay` 的指数与文档公式差一位
- **file**: src/retry.js:15
- **类型**: 数值逻辑 / 文档与实现不符
- **严重性**: Medium
- **问题**: 注释（L6）写 `base * 2^(attempt-1)`，实现是 `base * Math.pow(2, attempt)`。首次重试（attempt=1）本应等 100ms，实际等 200ms，整体退避时间翻倍；在 `maxDelay` 夹取下，达到上限的重试次数也提前一次。
- **证据**: `backoffDelay(1,{base:100,maxDelay:1e9})` → `200`（文档期望 100）；`backoffDelay(2,...)` → `400`（期望 200）。

### 发现 12 — 中：`peek` / `dequeue` 同优先级变成 LIFO，与注释的 FIFO 相反
- **file**: src/queue.js:53
- **类型**: 排序逻辑 / 注释与实现不符
- **严重性**: Medium
- **问题**: `if (this.#items[i].priority >= this.#items[bestIdx].priority)` 用 `>=`，同优先级时不断取更靠后的元素，结果是最晚入队的先出。L60 注释明确写"同优先级时返回最先入队的"，L46-47 写"同优先级按 FIFO"，实现是 LIFO。`peek` 与 `dequeue` 两处（L53、L65）同样错，至少两者行为一致，但都与文档相反。
- **证据**: 依次入队 A/B/C（priority 均为 0）→ `peek().id === 'C'`；`dequeue` 顺序 `['C','B','A']`。改为 `>` 即可恢复 FIFO。

### 发现 13 — 中：`processTasks` 不校验 `tasks`，空数组直接抛错
- **file**: src/index.js:23
- **类型**: 参数校验缺失 / 同族守卫不一致（模式 2）
- **严重性**: Medium
- **问题**: `tasks` 未做 `Array.isArray` 校验。`tasks = undefined` 时在 L23 读 `.length` 抛 `TypeError: Cannot read properties of undefined`，错误信息与调用点无关，难定位。`tasks = []` 时 `capacity: 0` 交给 `TaskQueue`，触发 L9 的 `capacity <= 0` 守卫，抛 `TypeError: capacity must be a positive number`——空批次本该是合法的 no-op，却变成异常。
- **证据**: 探针 4：`processTasks([], {...})` → `THROW TypeError: capacity must be a positive number`；`processTasks(undefined, ...)` → `THROW TypeError: Cannot read properties of undefined (reading 'length')`。

### 发现 14 — 中：`JsonStore.#load` 不校验解析结果是否为对象
- **file**: src/store.js:24
- **类型**: 输入校验缺失 / 延迟崩溃
- **严重性**: Medium
- **问题**: `JSON.parse` 只保证是合法 JSON，不保证是对象。文件内容为 `null` / `5` / `"hi"` 时 `#data` 变成非对象，构造函数**静默成功**，直到第一次 `get()` 执行 `key in this.#data` 才抛 `TypeError: Cannot use 'in' operator to search for 'a' in null`。崩溃点与根因相距很远，且 `catch` 分支（L25-27）只处理语法错误，不处理类型错误。
- **证据**: 用 `null` / `5` / `"hi"` 作为文件内容构造 `new JsonStore(p)`：三者均"构造成功"，随后 `get('a')` 分别抛 `Cannot use 'in' operator ... in null / 5 / hi`。数组 `[1,2]` 不抛（数组也是对象），但语义已错。

### 发现 15 — 中：`#persist` 先删后写，与文件头"原子写入"的声明矛盾
- **file**: src/store.js:54
- **类型**: 数据丢失 / 注释与实现不符
- **严重性**: Medium
- **问题**: 文件头（L2）声称"先写临时文件再 rename，避免半写状态"，实现却是 `rmSync(原文件)` 然后 `writeFileSync(原文件)`。两步之间进程崩溃、磁盘满、SIGKILL 都会留下"原文件已删、新文件未写"的状态，**全部数据丢失**。这不是原子写，是"先毁旧再建新"。同理，`rename` 都不存在。
- **证据**: 静态确认 L53-55 无临时文件、无 `rename`；`#persist` 是 `set`/`delete` 的唯一落盘路径，所有写操作共享该风险窗口。（L53 注释本身已自认"中途失败会导致数据丢失"。）

### 发现 16 — 低：`remove()` 对 `id` 零校验，`clear()` 返回 `undefined` 与 JSDoc 不符
- **file**: src/queue.js:73
- **类型**: 同族守卫不一致（模式 2）/ 契约不符
- **严重性**: Low
- **问题**: ①`enqueue` 强制 `task.id` 为非空 string（L31），`remove(id)` 却不校验，`remove(undefined)` / `remove(null)` / `remove({})` 都静默返回 `false`，把"参数类型错误"和"键不存在"混为一谈，调用方无法区分。②`clear()`（L80-86）JSDoc 写 `@returns {boolean} 总是 true`，函数体没有任何 `return`，实际返回 `undefined`。依赖返回值的调用方会走错分支。
- **证据**: `q.remove()` → `false`、`q.remove(null)` → `false`、`q.remove({})` → `false`，均不抛错；`q.clear()` → `undefined`，且 `q.size` 已为 0。

### 发现 17 — 低：`priority` 规范化用 `Number.isFinite`，数值字符串与 Infinity 被静默归零
- **file**: src/queue.js:39
- **类型**: 数值处理 / 静默降级
- **严重性**: Low
- **问题**: `Number.isFinite(task.priority) ? task.priority : 0`。`Number.isFinite` **不做类型转换**，所以 `priority: '5'`（字符串）判为 false → 变成 0；`priority: Infinity`（想表达"最高优先级"）也被归零。传入方看到的是"优先级没生效"，且没有任何告警，属于静默数据损坏。
- **证据**: 入队 `nan(NaN)/inf(Infinity)/str('5')/neg(-1)/real(7)`，实际 drain 顺序 `['real(7)','str(0)','inf(0)','nan(0)','neg(-1)']`——`str` 与 `inf` 的存储 priority 均为 0，与 `nan` 并列。

### 发现 18 — 低：`processTasks` 直接返回结果数组，调用方无法区分成功/失败
- **file**: src/index.js:38
- **类型**: API 设计缺陷 / 错误信息丢失
- **严重性**: Low
- **问题**: `runWithConcurrency` 返回的每项形如 `{ok:true,value}` / `{ok:false,error}`，`processTasks` 原样透传，自己不读 `ok`。调用方拿到的是"混合了成功值和错误对象"的数组，必须自己遍历判断；若直接 `map(x => x.value)` 会把失败项的 `undefined` 当成功数据。源码 L37 注释已自认此问题。叠加发现 2 后，数组还含空洞，`for...of` / `forEach` 会静默跳过失败槽位。
- **证据**: 探针 2：`runWithConcurrency([0,1,2,3],3,...)` 返回 `[{ok:true,value:0}, null, null, {ok:true,value:3}]`（前两个 `null` 是 `JSON.stringify` 对稀疏洞的呈现），`i in results` 在 1、2 处为 false。

---

## 附：负例文件复核（未误报）

题目范围含三个明确的"负例"文件，逐一确认其声明成立，**不计入发现**：

| 文件 | 声明 | 复核结论 |
|---|---|---|
| src/neg-catch.js | 空 catch 是刻意的，无缺陷 | **成立**。三处 `catch {}` 均先做前置守卫、失败后返回 false/null，调用方可通过返回值区分；状态无部分更新。`tryParseJson` 的 `JSON.parse` 不会返回 null，因此"用 `=== null` 区分"的论证也成立。 |
| src/neg-race.js | 看似竞态，实则原子 | **成立**。`increment` 无 await；`incrementAsync` 在 await 之前完成写、之后只读 `result`，不写回旧值。实测 `batchIncrement(counter, 50)` 连跑 5 次恒为 50。**注意**：同仓库的 `worker-pool.js` 才是真竞态（发现 2），两者不能混为一谈。 |
| src/neg-unused.js | 看似死代码，实为公共 API | **成立**。`ERROR_CODES`、`VERSION`、`normalizeError`、`isValidTask` 均为 `export`，仓库内零引用是合理的库表面。`isValidTask` 的判据与 `queue.enqueue` 一致，非冗余。 |

---

## 汇总

| 严重性 | 数量 | 编号 |
|---|---|---|
| Critical | 2 | 1, 2 |
| High | 6 | 3, 4, 5, 6, 7, 8 |
| Medium | 7 | 9, 10, 11, 12, 13, 14, 15 |
| Low | 3 | 16, 17, 18 |

**模式分布**：模式 1 命中 2 个文件（queue.js、store.js）；模式 2 命中 4 个文件（index.js、queue.js、retry.js、store.js）；模式 3 命中 3 个文件（config.js、queue.js、retry.js）。三个负例文件在三模式下全部未命中，未产生误报。
