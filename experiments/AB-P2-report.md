# AB-P2 审计报告

**目标**: `<HOME>\AppData\Local\Temp\iso-ab-p2\code\src\`（9 个源码文件，465 行，全部读完；另有 `package.json` 7 行）
**方法**: 静态逐行阅读 + 在 `%TEMP%` 写 Node 探针脚本实跑验证（目标目录只读，未做任何修改）
**验证脚本**: `%TEMP%\audit-p2.mjs` / `audit-p2b.mjs` / `audit-p2c.mjs` / `audit-p2d.mjs` / `audit-p2e.mjs` / `audit-p2f.mjs` / `audit-p2g.mjs` / `audit-p2h.mjs` / `audit-p2i.mjs` / `audit-p2j.mjs` / `audit-p2k.mjs` / `audit-p2l.mjs` / `audit-p2m.mjs`

> 说明：`package.json` 自称 "a small, correct task-queue service"，但实测存在两处必然触发的严重缺陷（发现 1、2）。以下结论全部有可复现探针输出支撑，不依赖注释自述。

---

## 模式检查结果

| 模式 | 文件 | 命中/未命中/不适用 | 说明 |
|---|---|---|---|
| 1 返回值暴露内部状态 | src/config.js | 未命中 | `loadConfig` 返回**新建**对象字面量（L37），四个字段均为原始类型；`DEFAULTS` 已 `Object.freeze`（L4）且未被直接返回。实测 `loadConfig({}) !== loadConfig({})`，调用方改动互不影响。 |
| 1 返回值暴露内部状态 | src/index.js | 未命中 | `processTasks` 返回 `raw`（L38），是 `runWithConcurrency` 内部的局部 `results` 数组，模块不保留引用，无回写通道。注意该数组是稀疏的（发现 2），但那是"结果缺失"，不是"内部状态泄漏"。另：本函数会**改写调用方入参数组**（见发现 1），属于对输入的副作用，不是返回值泄漏。 |
| 1 返回值暴露内部状态 | src/queue.js | **命中** | `peek()` 返回 `this.#items[bestIdx]`（L69），与内部数组元素是同一引用。实测把 `peek()` 结果的 `id` 改成 `HIJACKED`、`priority` 改成 `999` 后，再次 `peek()` 读到被污染的对象，`size` 仍为 1，队内数据已被篡改。见发现 10。另 `enqueue` 用 `{...task}` 浅拷贝（L37-41），顶层是新对象但嵌套字段共享（实测 `peek().meta === orig.meta`）。 |
| 1 返回值暴露内部状态 | src/retry.js | 不适用 | `backoffDelay` 返回 number；`retry` 原样透传 `fn` 的返回值，不持有任何内部容器，无共享引用可言。 |
| 1 返回值暴露内部状态 | src/store.js | **命中** | `get(key)` 直接返回 `this.#data[key]`（L31）。实测 `s.set('k',{nested:{v:1}}); s.get('k').nested.v = 999;` 后内部再读为 999，且下一次 `set` 会把 999 **持久化落盘**（文件内容 `"k": {"v": 999}`）。见发现 9。`keys()` 用 `Object.keys` 返回新数组（L47），未命中。另 `set('__proto__', {...})` 会把传入对象挂成 `#data` 的原型，`get` 随即把原型上的字段当成自己的键返回（`get('isAdmin')→true`），`keys()` 却看不到——见发现 21。 |
| 1 返回值暴露内部状态 | src/worker-pool.js | 未命中 | 返回局部 `results`（L14/L36），函数返回后无人持有；调用方改它不会影响任何模块状态。 |
| 1 返回值暴露内部状态 | src/neg-catch.js | 未命中 | `tryParseJson` 每次走 `JSON.parse` 生成新对象（实测两次解析同一字符串得到的对象不共享）；`tryRemoveTemp`/`safeClose` 返回 boolean 原始值。 |
| 1 返回值暴露内部状态 | src/neg-race.js | 不适用 | `increment`/`incrementAsync`/getter/`batchIncrement` 返回的都是 number 原始值，没有引用可泄漏。 |
| 1 返回值暴露内部状态 | src/neg-unused.js | 未命中 | `normalizeError` 每次构造新对象字面量（L27、L32），字段全是原始类型；`isValidTask` 返回 boolean；`ERROR_CODES` 已 `Object.freeze`（L11）。 |
| 2 同族守卫一致性 | src/config.js | 未命中 | `parsePositiveInt`（L13-20）被 `concurrency`/`timeoutMs`/`retryMax` 三个字段**共用同一个守卫**（L26-28），口径一致；`logLevel` 是枚举字符串，用 `includes` 校验（L31），属不同值域，合理。字段之间不存在宽严不一。（守卫本身缺下界 → 模式 3 命中） |
| 2 同族守卫一致性 | src/index.js | **命中** | `processTasks` 只校验 `handler`（L18），对 `tasks` **零校验**；而同包协作的 `runWithConcurrency` 第一句就是 `if (!Array.isArray(tasks)) throw`（worker-pool L8）。实测 `processTasks(null,...)` → `Cannot read properties of null (reading 'length')`，`processTasks('abc',...)` → `task must be an object`，报错点与语义都错位。见发现 14。 |
| 2 同族守卫一致性 | src/queue.js | **命中** | ①`enqueue` 要求 `task.id` 为非空 string（L31），但同族方法 `remove(id)` 对 `id` **零校验**（L73-77）：`remove(undefined)`/`remove(123)` 均静默返回 false，无法区分"没这个 id"和"参数类型错了"。②构造函数的容量守卫用 `typeof capacity !== 'number'`（L9），而包内 `runWithConcurrency`（worker-pool L9）和 `config.parsePositiveInt`（L16）对"正整数"用的是 `Number.isInteger`，三处口径不一致。见发现 4、12。 |
| 2 同族守卫一致性 | src/retry.js | **命中** | 同模块两个函数都校验"正整数"，但强度不同：`backoffDelay` 是 `!Number.isInteger(attempt) \|\| attempt < 1`（L9），完整；`retry` 只有 `!Number.isInteger(maxAttempts)`（L32），**漏掉下界**，放行 0 与负数。见发现 6。 |
| 2 同族守卫一致性 | src/store.js | **命中** | 同一种"键是否存在"语义用了两套判据：`get` 用 `key in this.#data`（L31，**沿原型链**），`delete` 用 `hasOwnProperty`（L40，**只认自有属性**）。实测 `get('toString')` 返回 `function`（真值），而 `delete('toString')` 返回 `false`——同一键上两个方法结论相反。另构造函数校验 `path`（L12），而 `set/get/delete` 对 `key` 完全不校验（`set(null,...)` 会存成字符串 `"null"`）。见发现 7。 |
| 2 同族守卫一致性 | src/worker-pool.js | 未命中 | 三个参数各自独立校验：`Array.isArray(tasks)`、`Number.isInteger(concurrency) && concurrency >= 1`、`typeof runner === 'function'`（L8-12），无遗漏、无宽严不一。 |
| 2 同族守卫一致性 | src/neg-catch.js | 未命中 | 三个函数都是"前置守卫 + try/catch 降级"同一范式，守卫按各自参数类型定制：`existsSync`（L16）、`typeof text !== 'string'`（L33）、`handle && typeof handle.close === 'function'`（L46）。强度适配，不存在同类函数松紧不一。（`safeClose` 对 async `close` 的处置另有问题，见发现 18，但那不是"守卫不一致"） |
| 2 同族守卫一致性 | src/neg-race.js | 不适用 | 仅 `batchIncrement` 带参数（`count`，L47）；`increment`/`incrementAsync` 无参，没有可比的同族函数。 |
| 2 同族守卫一致性 | src/neg-unused.js | 未命中 | `isValidTask`（L43-49）的判据（object + `id` 为非空 string）与 `queue.enqueue`（L28-33）逐条对齐，跨文件口径一致；`normalizeError` 无前置约束需求。 |
| 3 数值边界校验 | src/config.js | **命中** | `parsePositiveInt` 名为 positive、错误文案也写 "positive integer"，实际只判 `Number.isInteger(n)`（L16），**没有 `n > 0`**。实测 `CONCURRENCY='0'`→0、`'-3'`→-3、`'   '`（纯空格，`Number('   ')` 为 0，L14 只挡了 `''` 没 trim）→0、`TIMEOUT_MS='-500'`→-500 全部通过。`NaN`/`Infinity`/小数被 `Number.isInteger` 正确挡下。见发现 5。 |
| 3 数值边界校验 | src/index.js | 不适用 | 本文件不直接做数值校验，把 `config.concurrency`/`retryMax`/`timeoutMs` 原样转交下游；但下游守卫漏洞会经它放大（`timeoutMs` 被当退避上限用，见发现 15）。 |
| 3 数值边界校验 | src/queue.js | **命中** | ①构造守卫 `typeof capacity !== 'number' \|\| capacity <= 0`（L9）：挡住 0 和负数，但 **`NaN <= 0` 为 false → NaN 通过**（实测不抛错，且容量判断 `length > NaN` 恒假 → 队列变成**无上限**）；`Infinity` 通过；`1.5` 通过。②容量边界写的是 `>` 而非 `>=`（L34），**off-by-one**：`capacity=2` 实收 3 条（实测 `[true,true,true,false]`，`size=3`）。见发现 3、4。 |
| 3 数值边界校验 | src/retry.js | **命中** | `attempt` 守卫完整（L9，0/负/NaN/Infinity/小数实测全抛）。但：`base` 只判 `base <= 0`（L12）→ **NaN 漏过**（实测 `base=NaN` 返回 1000）；`maxDelay` 只判 `maxDelay < base`（L13）→ **NaN 漏过**（实测返回 `NaN`）；`maxAttempts` 缺下界（L32，见模式 2）。见发现 6、11。 |
| 3 数值边界校验 | src/store.js | 不适用 | 全文件没有数值参数（只有 path / key / value），不涉及本模式。 |
| 3 数值边界校验 | src/worker-pool.js | 未命中 | `!Number.isInteger(concurrency) \|\| concurrency < 1`（L9）完整排除 0、负数、NaN、Infinity、小数。实测 `0 / -1 / 1.5 / NaN / Infinity` 全部抛 RangeError。这是本仓库**唯一**一处写对的"正整数"守卫。 |
| 3 数值边界校验 | src/neg-catch.js | 不适用 | 三个函数均无数值参数。 |
| 3 数值边界校验 | src/neg-race.js | 未命中 | `!Number.isInteger(count) \|\| count < 0`（L47）正确排除负数、NaN、Infinity、小数，并**有意**放行 0（语义是"非负整数"）。实测 `0`→0；`NaN/Infinity/1.5/-1` 全抛 RangeError。 |
| 3 数值边界校验 | src/neg-unused.js | 不适用 | 无任何数值参数。 |

---

## 发现 21

### 发现 1 — 关键：`processTasks` 先清空入参数组再执行，导致一个任务都不跑
- **file**: src/index.js:28
- **类型**: 逻辑错误 / 数据流顺序错误 / 对入参的破坏性副作用
- **严重性**: **Critical**
- **问题**: L23-26 把任务入队到局部 `queue`，L28 执行 `tasks.length = 0`，L30 却把**已被清空的 `tasks`**（而不是 `queue`）交给 `runWithConcurrency`。任意非空任务列表 → `handler` 一次都不执行 → 恒返回 `[]`；同时那个装满了任务的 `TaskQueue` 被直接丢弃，任务永久丢失。附带后果：调用方传进来的数组被**原地清空**（外部可见的副作用）。L27 的注释"假设队列持有的是独立副本"说明作者把 `queue` 和 `tasks` 两个变量混淆了——副本确实存在，只是没人用它。
- **证据**: 探针 `processTasks([{id:'a'},{id:'b'},{id:'c'}], {handler})` → `ran: []`、`result: []`、调用方数组 `length: 0`。对照实验：单独 `new TaskQueue({capacity:2})` 入队 2 条后再 `arr.length = 0`，`q.size` 仍为 2，证明队列本身独立持有副本，问题只出在传错了变量。

### 发现 2 — 关键：`runWithConcurrency` 在 `await` 之前读 `cursor`，所有 worker 抢到同一索引
- **file**: src/worker-pool.js:19
- **类型**: 并发缺陷 / 真竞态（非误报）
- **严重性**: **Critical**
- **问题**: L19 `const idx = cursor;` → L20 `await Promise.resolve();` → L21 `cursor += 1;`。启动时 `for` 循环同步地把 `concurrency` 个 worker 全部跑到第一个 `await`，此时它们**都**读到了同一个 `cursor`，恢复后各自 +1，于是索引 0 被重复执行 N 次，而 1..N-1 从未执行。`results` 用 `new Array(tasks.length)` 预分配（L14），未赋值的槽是**稀疏洞**（`i in results === false`），不是 `undefined` 值。函数注释"最终把所有结果/错误按索引返回"不成立。只要 `concurrency > 1` 且 `tasks.length > 1` 就必然触发；`concurrency === 1` 时正确。
- **证据**: `runWithConcurrency([0..9], 3, ...)` → `seen: [0,0,0,3,4,5,6,7,8,9]`，`results[1]`/`results[2]` 的 `i in r` 为 false（洞），其余正常。`concurrency=2` → `seen: [0,0,2,3,...]`。`tasks=[0,1] concurrency=4` → `seen: [0,0,0,0]`，`holes: [1]`。同步 runner（`(x)=>x`）更糟：`tasks=[0..4] conc=3` → `seen:[0,0,0,3,3,3]`，`holes:[1,2,4]`。重复运行结果完全一致，是确定性缺陷而非偶发。

### 发现 3 — 高：`TaskQueue` 容量判断 off-by-one，实际可超收一条
- **file**: src/queue.js:34
- **类型**: 边界错误 / 容量约束失效
- **严重性**: **High**
- **问题**: `if (this.#items.length > this.#capacity) return false;` 用的是 `>`。当 `length === capacity` 时条件为假，仍会 push，于是队列可以装到 `capacity + 1` 条。任何依赖 `capacity` 做背压/内存上限的调用方都会多收一条。
- **证据**: `new TaskQueue({capacity:2})` 连续 `enqueue` 四个 → 返回 `[true, true, true, false]`，`size: 3`、`cap: 2`；`capacity:1` 入队 2 条 → `[true, true]`，`size: 2`。

### 发现 4 — 高：`capacity` 守卫放过 `NaN`/`Infinity`/小数，`NaN` 会让队列变成无上限
- **file**: src/queue.js:9
- **类型**: 数值边界校验不完整
- **严重性**: **High**
- **问题**: `typeof capacity !== 'number' || capacity <= 0`。`NaN <= 0` 为 `false`，所以 `NaN` 通过；`Infinity` 通过；`1.5` 通过。而 L34 的比较 `length > NaN` 恒为 `false`，于是 `capacity: NaN` 的队列**永远不返回 false**，容量约束彻底消失，可无限增长。`capacity: 1.5` 则出现"能放 2 条"的怪状态（`length=2 > 1.5` 才停）。正确写法应为 `!Number.isInteger(capacity) || capacity < 1`（同包 `worker-pool.js:9` 就是对的）。
- **证据**: `new TaskQueue({capacity: NaN})` 不抛错；连续入队 5 条全部 `true`，`size: 5`、`cap: NaN`。`new TaskQueue({capacity: 1.5})` 入队 4 条 → `[true,true,false,false]`、`size:2`。`capacity: Infinity` 入队 5 条全 `true`。

### 发现 5 — 高：`parsePositiveInt` 缺下界，`concurrency`/`retryMax`/`timeoutMs` 可为 0 或负数
- **file**: src/config.js:16
- **类型**: 数值边界校验不完整
- **严重性**: **High**
- **问题**: 函数名和报错文案都声称 "positive integer"，但只做 `Number.isInteger(n)`，**没有 `n > 0`**。三条攻击/误配路径：①`CONCURRENCY=0` 或负数 → 原样进入 `runWithConcurrency`，在**更下层**抛 `RangeError: concurrency must be a positive integer`，报错点与配置来源脱节；②`RETRY_MAX=0` → 进入 `retry({maxAttempts:0})`，循环体一次都不执行，最终 `throw lastError` 而 `lastError` 是 `undefined`（见发现 6），任务被静默跳过；③`TIMEOUT_MS=-500` → 被当作退避上限传下去，触发 `maxDelay < base` 的 RangeError，**掩盖真正的 handler 错误**（见发现 15）。另外 L14 只挡 `raw === ''`，没挡纯空格：`Number('   ')` 为 0，`CONCURRENCY='   '` → 0 通过。
- **证据**: `loadConfig({CONCURRENCY:'0'}).concurrency === 0`；`'-3'` → -3；`'   '` → 0；`TIMEOUT_MS:'-500'` → -500；`RETRY_MAX:'0'` → 0；传数字 `0`/`-1` 同样通过。对照：`'1.5'`/`'abc'`/`'Infinity'`/`'NaN'` 均正确抛 TypeError。

### 发现 6 — 高：`retry` 的 `maxAttempts` 漏下界，`0`/负数会 `throw undefined`
- **file**: src/retry.js:32
- **类型**: 数值边界校验不完整 / 同族守卫不一致
- **严重性**: **High**
- **问题**: `if (!Number.isInteger(maxAttempts)) throw ...` 只查整数性，不查 `>= 1`。传 `0` 或负数时，L37 的 `for (let attempt = 1; attempt <= maxAttempts; ...)` 一次都不进，L47 `throw lastError` 抛出的 `lastError` 从未赋值，结果是**抛出一个 `undefined`**。调用方的 `catch (e)` 拿到 `undefined`，`e.message`、`e.stack` 全部报二次错误，原始失败信息彻底丢失。这与同模块 `backoffDelay`（L9 有 `attempt < 1`）的守卫强度不一致。
- **证据**: `await retry(async()=>1,{maxAttempts:0})` 的 catch 分支收到 `undefined`，`typeof e === 'undefined'`、`e instanceof Error === false`；`maxAttempts:-5` 同样。对照 `maxAttempts: NaN / 1.5 / Infinity` 均正确抛 RangeError。

### 发现 7 — 高：`JsonStore.get` 用 `in` 走原型链，与 `delete` 的 `hasOwnProperty` 结论相反
- **file**: src/store.js:31
- **类型**: 同族守卫/语义不一致 / 原型链泄漏
- **严重性**: **High**
- **问题**: `get` 写的是 `(key in this.#data)`，`in` 会沿原型链查找，因此任何 `Object.prototype` 上的名字都会被当成"存在"：`get('toString')` 返回一个**函数**，`get('constructor')` 返回 `Object`，`get('__proto__')` 返回对象。而 L40 的 `delete` 用的是 `hasOwnProperty`，对同样的键返回 `false`。同一 API 的两个方法对"这个键存不存在"给出相反答案，调用方无法用 `delete` 的返回值判断 `get` 为何有值。正确写法：`Object.prototype.hasOwnProperty.call(this.#data, key)`。
- **证据**: 新建空 store 后 `typeof s.get('toString') === 'function'`、`typeof s.get('constructor') === 'function'`、`typeof s.get('__proto__') === 'object'`；`s.delete('toString')` 返回 `false`；而自有键 `s.set('a',1)` 后 `get('a')===1`、`delete('a')===true`，行为正常，差异只出现在原型链键上。

### 发现 8 — 高：`#persist` 先 `rm` 再 `write`，与文件头"临时文件+rename 原子写"的说明相反，崩溃即全量丢数据
- **file**: src/store.js:54
- **类型**: 数据丢失 / 注释与实现不符
- **严重性**: **High**
- **问题**: 文件头 L2 声称"带原子写入：先写临时文件再 rename，避免半写状态"，但 L53-55 的实际实现是 `existsSync → rmSync(path) → writeFileSync(path)`：**先删原文件再写**。二者之间只要进程崩溃、断电、磁盘满或 `JSON.stringify` 抛错（例如值里有循环引用 / BigInt），原文件已经没了、新文件没写成 → 历史数据 100% 丢失。此外 L23-27 的 `catch { return {}; }` 把"文件损坏"静默降级为空对象，下一次任意 `set` 就会用空对象覆盖掉那份还能人工抢救的坏文件。
- **证据**: ①**实测已丢数据**：文件原内容 `{"important":"data"}`，执行 `s.set('bad', 10n)` → `JSON.stringify` 在 L55 抛 `TypeError: Do not know how to serialize a BigInt`；此后 `existsSync(path)` 为 **false**——原文件已被 L54 的 `rmSync` 删掉，新文件没写成，`important` 字段**永久丢失**。②坏 JSON 静默清空：写入 `{"a":1,`（截断）后 `new JsonStore(p)` → `keys: []`（无任何告警）；随后 `s.set('b',2)` → 文件内容变成 `{"b":2}`，原始残留被覆盖。代码路径核对：L54 `rmSync` 与 L55 `writeFileSync` 之间没有任何临时文件或 rename，与 L2 注释相反。

### 发现 9 — 高：`get` 返回内部引用，外部改动会污染内存态并落盘
- **file**: src/store.js:31
- **类型**: 返回值暴露内部状态（模式 1）
- **严重性**: **High**
- **问题**: `get(key)` 直接返回 `this.#data[key]`，没有拷贝。调用方 `const cfg = s.get('cfg'); cfg.nested.v = 999` 改动的是 store 的内部对象；下一次任意 `set` 触发 `#persist` 时，这个未经 `set` 的修改会被**持久化到磁盘**。多调用方共享同一 store 时，任何一方的读后修改都会静默影响其他方。
- **证据**: `s.set('k',{nested:{v:1}})`；`s.get('k').nested.v = 999`；再 `s.set('trigger',1)` 后读文件 → `"k": { "v": 999 }`；`s.get('k')` 返回 `{"nested":{"v":999}}`。全程没有调用过 `set('k', ...)`。

### 发现 10 — 高：`peek()` 返回内部元素引用，可被外部篡改（改 id / 改优先级）
- **file**: src/queue.js:69
- **类型**: 返回值暴露内部状态（模式 1）
- **严重性**: **High**
- **问题**: `return this.#items[bestIdx];` 返回的是队列内部数组里那个对象本身。调用方拿到后修改 `id` 或 `priority`，改动直接作用于队列内部：`id` 被改成别的值后 `remove(原id)` 就再也删不掉这条；`priority` 被改高后出队顺序随之改变。`peek` 的语义是"只看不动"，返回可写引用违背了这一契约。同类问题：`enqueue` 的 `{...task}` 是**浅拷贝**（L37-41），嵌套对象仍与调用方共享，调用方事后改 `task.meta` 会反映到队列里（实测 `peek().meta === orig.meta` 为 true）。
- **证据**: `q.enqueue({id:'a',priority:0})`；`const p = q.peek(); p.id='HIJACKED'; p.priority=999;` → 再次 `q.peek()` 得到 `{id:'HIJACKED', priority:999}`，`size` 仍 1。优先级篡改实验：入队 `a(1)`、`b(5)`，`q.peek().priority=100` 后 `dequeue()` 返回被改过的 `b`（`priority:100`）。浅拷贝实验：`q.enqueue(orig)` 后 `q.peek().meta === orig.meta` 为 true。

### 发现 11 — 中：`retry` 的 `base`/`maxDelay` 放过 `NaN`，会返回 `NaN` 或错误值
- **file**: src/retry.js:12
- **类型**: 数值边界校验不完整
- **严重性**: **Medium**
- **问题**: L12 `if (base <= 0)`——`NaN <= 0` 为 false，`base: NaN` 通过；L13 `if (maxDelay < base)`——`maxDelay: NaN` 时比较为 false，也通过。`base=NaN` 时 L17 `Number.isFinite(NaN)` 为 false → `safe = maxDelay`，函数返回**退避上限**而不是报错；`maxDelay=NaN` 时 L18 `Math.min(x, NaN)` 返回 `NaN`，下游 `setTimeout(fn, NaN)` 会被当成 0ms，退避策略静默失效（变成忙等重试）。正确写法应是 `!Number.isFinite(base) || base <= 0` 与 `!Number.isFinite(maxDelay)`。
- **证据**: `backoffDelay(1,{base:NaN,maxDelay:1000})` → `1000`；`backoffDelay(1,{base:10,maxDelay:NaN})` → `NaN`；对照 `base=-5` 正确抛 RangeError、`maxDelay=Infinity` 返回 20（可接受）。

### 发现 12 — 中：`enqueue` 与 `remove` 的参数校验不对称，非法 id 被静默吞掉
- **file**: src/queue.js:73
- **类型**: 同族守卫不一致（模式 2）
- **严重性**: **Medium**
- **问题**: `enqueue` 对 `task.id` 要求"非空 string"（L31），但同一族的 `remove(id)` 对 `id` 不做任何校验（L74 只做 `findIndex`）。`remove(undefined)` / `remove(123)` 都返回 `false`，与"队列里没有这个 id"完全无法区分；调用方拿到 `false` 会以为"任务已经被处理掉了"，实际可能是自己传错了参数类型。另外对重复 id，`remove` 只删第一个匹配项（实测），这一点也未在文档中说明。
- **证据**: `q.remove(undefined)` → `false`，`q.remove(123)` → `false`，两者都不抛错，且队列里确实存在 `id:'a'`。重复 id 实验：入队 `dup#1`、`dup#2` 后 `remove('dup')` → `true`，`size` 从 2 变 1，`peek()` 仍是 `n:2`。

### 发现 13 — 中：`dequeue`/`peek` 的平级 tie-break 取"最后一个"，与注释的 FIFO 相反
- **file**: src/queue.js:53
- **类型**: 逻辑错误 / 注释与实现不符
- **严重性**: **Medium**
- **问题**: 两处循环都用 `if (items[i].priority >= items[bestIdx].priority) bestIdx = i;`（L53、L65）。`>=` 会让**后入队**的同优先级元素不断覆盖 `bestIdx`，结果同优先级按 **LIFO** 出队。而 L48 的注释写"同优先级按 FIFO"、L60 写"同优先级时返回最先入队的"。若确实要 FIFO，应改用 `>`。
- **证据**: 依次入队 `first/second/third`（同为 `priority:0`）→ `peek().id === 'third'`、第一次 `dequeue()` 得 `third`、第二次得 `second`，`first` 最后才出。与注释完全相反。

### 发现 14 — 中：`processTasks` 不校验 `tasks`，空数组直接崩溃
- **file**: src/index.js:18
- **类型**: 同族守卫不一致（模式 2）/ 边界错误
- **严重性**: **Medium**
- **问题**: 函数只校验 `handler`（L18），却立刻在 L23 使用 `tasks.length` 构造队列。三个后果：①`tasks` 为 `undefined`/`null` → `Cannot read properties of null (reading 'length')`，错误信息不指向真实原因；②`tasks` 为字符串 → 在 L25 `enqueue` 时才抛 `task must be an object`，且此时已被拆成单字符；③**空数组**（完全合法的输入）→ `capacity: 0` → 构造函数抛 `TypeError: capacity must be a positive number`，即"这一批没有任务"这种正常情况也会炸。而同包 `runWithConcurrency` 对 `tasks` 有 `Array.isArray` 守卫（worker-pool L8），二者不一致。
- **证据**: `processTasks([], {handler})` → `TypeError: capacity must be a positive number`；`processTasks(null, ...)` → `Cannot read properties of null (reading 'length')`；`processTasks('abc', ...)` → `task must be an object`；`processTasks([{id:''}], ...)` → `task.id must be a non-empty string`；`processTasks([null], ...)` → `task must be an object`。仅 `handler` 缺失时给出正确报错 `handler must be a function`。

### 发现 15 — 中：重试参数校验错误会掩盖原始失败（`timeoutMs` 被误当退避上限）
- **file**: src/retry.js:13
- **类型**: 错误传播 / 异常掩盖
- **严重性**: **Medium**
- **问题**: `backoffDelay` 的 `base`/`maxDelay` 校验在**第一次失败之后**才执行（L44），一旦不合法就抛出 RangeError 取代原始错误。`index.js:34` 又把 `config.timeoutMs`（单次超时上限）当作 `maxDelay` 传进来，只要 `timeoutMs < base(50)`（例如 `TIMEOUT_MS=10` 或 `-500`），第一次重试就会抛 `maxDelay must be >= base`，真正的 handler 错误被彻底吞掉，排障时看到的是一个与业务无关的参数错误。
- **证据**: `retry(async()=>{throw new Error('ORIGINAL')}, {maxAttempts:3, base:50, maxDelay:10})` → catch 收到 `RangeError: maxDelay must be >= base`，`ORIGINAL` 丢失；同样 `base:0` → `RangeError: base must be positive`。另测 `base: NaN` 且首次成功时 `retry` 返回 `'ok'`，说明参数校验被完全跳过。

### 发现 16 — 低：`JsonStore` 加载非对象 JSON 根时构造成功、后续方法才崩
- **file**: src/store.js:19
- **类型**: 输入边界未校验 / 延迟崩溃
- **严重性**: **Low**
- **问题**: `#load` 只判断了"文件是空的"和"JSON 解析失败"，没有判断解析结果是不是普通对象。文件内容是 `null` 时构造**成功**（`existsSync` 通过、`raw.trim() !== ''`、`JSON.parse('null') === null`），但之后 `keys()` 与 `delete()` 抛 `Cannot convert undefined or null to object`、`get()` 抛 `Cannot use 'in' operator to search for 'a' in null`、`set()` 抛 `Cannot set properties of null`——对象已经造出来了，却一个方法都用不了。是数字 `42` 或字符串 `"hi"` 时同样构造成功，`get`/`set` 才抛 TypeError；是数组 `[1,2,3]` 时 `keys()` 返回 `["0","1","2"]`，`set('a',1)` 因数组不支持命名属性而静默不生效（文件仍是 `[1,2,3]`）。错误在远离注入点的地方才暴露。
- **证据**: 分别写入 `null` / `[1,2,3]` / `42` / `"hi"` 四种内容后 new 实例：`null` → ctor OK，随后 `keys/get/set/delete` 四个方法**全部**抛 TypeError；`[1,2,3]` → `keys: ["0","1","2"]`，`set('a',1)` 后文件仍为 `[1,2,3]`；`42` → `get`/`set` 均抛 TypeError；`"hi"` → `keys: ["0","1"]`，`get`/`set` 抛 TypeError。

### 发现 17 — 低：`set(key, undefined)` 在内存中可见、落盘后消失
- **file**: src/store.js:37
- **类型**: 数据一致性 / 静默丢数据
- **严重性**: **Low**
- **问题**: `set` 直接赋值后调用 `#persist`，而 `JSON.stringify` 会丢弃值为 `undefined` 的属性。于是同一个 key 在当前进程里 `get` 得到 `undefined` 且出现在 `keys()` 中，重启后却完全不存在——"删除"与"设为 undefined"两种意图无法区分，也无法持久化。
- **证据**: `s.set('u', undefined)` 后 `s.keys()` 为 `['u']`，磁盘文件为 `{}`；重新 `new JsonStore(同一路径)` 后 `keys()` 为 `[]`。

### 发现 18 — 低：`safeClose` 对返回 Promise 的 `close()` 返回 true 并泄漏未处理拒绝
- **file**: src/neg-catch.js:48
- **类型**: 异常处理 / 异步错误逃逸
- **严重性**: **Low**
- **问题**: L46 只校验 `typeof handle.close === 'function'`，但没区分同步/异步实现。传入 `{ close: async () => { throw ... } }` 时，`handle.close()` 返回 rejected Promise，`try/catch` 捕获不到（同步抛出才会被捕获），函数**返回 true**（声称关闭成功），同时产生一个无人处理的 rejection；在 Node 默认策略下会触发 `unhandledRejection`，新版 Node 可能直接终止进程。注意：这是"负例文件中唯一可指摘处"，`tryRemoveTemp`/`tryParseJson` 的空 catch 语义确实正确，不应作为缺陷上报。
- **证据**: `safeClose({ close: async () => { throw new Error('async close failed') } })` 返回 `true`，随后进程打印 `UNHANDLED REJECTION: async close failed`。对照 `safeClose({close:1})`、`safeClose(0)` 正确返回 `false`。

### 发现 19 — 低：`clear()` 的 JSDoc 声明返回 boolean，实际返回 `undefined`
- **file**: src/queue.js:84
- **类型**: 文档与实现不符 / API 契约
- **严重性**: **Low**
- **问题**: L81-83 的 JSDoc 写 `@returns {boolean} 总是 true`，L84-86 的函数体只做 `this.#items.length = 0;`，没有 `return`。调用方按文档写 `if (!queue.clear()) { ... }` 会走"清空失败"分支。
- **证据**: `const r = q.clear()` → `r === undefined`、`typeof r === 'undefined'`，`q.size === 0`。

### 发现 20 — 低：`backoffDelay` 指数项与注释差一次幂
- **file**: src/retry.js:15
- **类型**: 注释与实现不符
- **严重性**: **Low**
- **问题**: L5-6 的注释写"`base * 2^(attempt-1)`"、attempt 从 1 开始；L15 实现是 `base * Math.pow(2, attempt)`，即 `2^attempt`。结果第一次重试等的是 `2*base` 而不是 `base`，整体退避时间翻倍（相对文档）。不是安全问题，但会让按文档估算重试耗时（例如与 `timeoutMs` 对齐）的调用方算错。
- **证据**: `backoffDelay(1, {base:100, maxDelay:30000})` → `200`（文档预期 100）；`backoffDelay(5)` → `3200`（`100*2^5`，文档预期 `100*2^4=1600`）。

### 发现 21 — 高：`set('__proto__', v)` 不写入数据而是改写内部对象原型，`get` 出现幽灵键且数据静默丢失
- **file**: src/store.js:35
- **类型**: 原型链污染（对象级）/ 数据静默丢失 / `set` 与 `get`/`keys`/`delete` 语义分裂
- **严重性**: **High**
- **问题**: `this.#data[key] = value` 在 `key === '__proto__'` 时触发的是**原型赋值**而非普通属性写入（`#data` 是普通对象字面量）。三个连锁后果：①`keys()` 返回 `[]`，因为 `__proto__` 不是自有属性；②`get('isAdmin')` 却返回 `true`——传入对象成了 `#data` 的新原型，其所有字段都能被 `get`（走 L31 的 `in`）当作"已存在的键"读到；③这些幽灵键**永远不会被持久化**（`JSON.stringify` 只序列化自有属性，落盘文件里只剩后来的 `x`），重启后全部消失；④`delete('isAdmin')` 返回 `false` 且删不掉。即"写入成功（`set` 无返回值、无报错）→ 读得到 → 但数据不存在、存不下、删不掉"。若该 store 被用作会话/权限缓存，`get('isAdmin') → true` 属于越权读。
- **证据**: `s.set('__proto__', {isAdmin:true, role:'root'})` 后：`keys() === []`；`get('isAdmin') === true`、`get('role') === 'root'`；`delete('isAdmin') === false` 且删除后 `get('isAdmin')` 仍为 `true`；再 `set('x',1)` 后磁盘文件为 `{ "x": 1 }`，`__proto__` 里的内容完全没落盘；重新 `new JsonStore(同一路径)` 后 `keys() === ['x']`、`get('isAdmin') === undefined`。另测全局 `({}).isAdmin === undefined`，确认污染范围限于该 store 实例的 `#data`，未波及 `Object.prototype`（因此不能按"全局原型污染"定级，但实例级危害成立）。若把同样的 JSON 直接写进文件（`{"__proto__":{...}}`），`JSON.parse` 产生的是**自有** `__proto__` 属性，此时 `keys()` 会包含 `'__proto__'`、`delete` 也能删掉——即"从文件加载"和"运行时 set"两条路径行为不一致，进一步说明该 key 未被特殊处理。

---

## 附：三个模式的集中结论

- **模式 1（返回值暴露内部状态）**：9 个文件中 2 个命中（`queue.js:69` 的 `peek`、`store.js:31` 的 `get`），且两者都可被外部改写成内部数据（前者改变队列元数据，后者把改动持久化落盘）。其余为原始类型返回或每次新建对象，未命中。
- **模式 2（同族守卫一致性）**：5 个文件命中，全部是"同一个类/模块里两个方法对同一类参数宽严不一"：`retry` 的 `backoffDelay` vs `retry`（L9 vs L32）、`store` 的 `get` vs `delete`（L31 vs L40）、`queue` 的 `enqueue` vs `remove`（L31 vs L73）、`index.processTasks` vs `worker-pool.runWithConcurrency`（L18 vs L8）、`queue` 构造守卫 vs 包内其他正整数守卫（`typeof` vs `Number.isInteger`）。
- **模式 3（数值边界完整性）**：4 个文件命中，错误形态高度一致——**漏下界**（`config.js:16`、`retry.js:32`）、**漏 `NaN`**（`queue.js:9` 的 `capacity <= 0`、`retry.js:12` 的 `base <= 0`、`retry.js:13` 的 `maxDelay < base`）、**漏整数性**（`queue.js:9` 放行 `1.5`）。`worker-pool.js:9` 与 `neg-race.js:47` 是仅有的两处写对的守卫（`!Number.isInteger(x) || x < 1` / `x < 0`）。
