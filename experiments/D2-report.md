# D2 — 缺失型缺陷审查报告

**目标**：`<HOME>\AppData\Local\Temp\gt-hidden\codebase\`（单份代码，无 git 历史、无对照版本）
**方法**：`wave2-audit.md` §4.8「缺失型缺陷」——对每处「承诺」问「实现有没有兑现？」
**范围**：只报「少做了一件事」。`FIFO 破坏 / 容量差一 / 指数算错 / 空 catch / 先删后写` 一律不报（见文末「明确排除」）。
**验证方式**：全部结论用 Node 实际运行过（只读执行，未修改任何文件）。标 ★ 者为可稳定复现的运行时证据。

> 顶层承诺（载体 #5，文件头/元数据）：`package.json:5` 声明
> `"description": "Ground truth fixture: a small, correct task-queue service"`
> 本报告列出的所有条目都是对这句声明以及各文件自身承诺的偏离。

---

## 缺失 1

- **file**: `src/queue.js:82`（承诺）/ `src/queue.js:84-86`（实现）
- **承诺来源**: JSDoc
- **承诺内容**:
  ```
  /**
   * 清空队列。返回是否清空成功。
   * @returns {boolean} 总是 true
   */
  clear() {
  ```
- **实现缺口**: 函数体只有 `this.#items.length = 0;`，**没有 `return` 语句**，隐式返回 `undefined`。整个 `@returns` 与「返回是否清空成功」的契约都没有兑现。
- **影响**: ★ 实测 `q.clear() === undefined`。调用方按文档写 `if (!queue.clear()) {...}` 或在类型检查下当 boolean 用时，会把一次**成功**的清空判成失败；TS/JS 消费者拿到 `undefined` 与 `false` 无法区分。这是纯粹的「少写一行」型缺陷，不涉及任何逻辑错误。

---

## 缺失 2

- **file**: `src/config.js:13-20`（重点 `16-18`）
- **承诺来源**: 命名约定 + 错误消息文本（双重载体）
- **承诺内容**:
  函数名 `parsePositiveInt`，且抛错文案为
  ``throw new TypeError(`${name} must be a positive integer, got: ${raw}`)``
- **实现缺口**: 只校验了 `Number.isInteger(n)`，**没有校验 `n > 0`**。名字和报错都说 "positive"，实现只做了 "integer"。
- **影响**: ★ 实测 `loadConfig({CONCURRENCY:'0'}).concurrency === 0`、`CONCURRENCY=-3 → -3`、`RETRY_MAX=-1 → -1`。这不是理论问题，两条都立刻炸在下游：
  - `concurrency: 0` → `runWithConcurrency` 抛 `RangeError`（它自己是校验的），配置层放行了执行层要拒绝的值；
  - `retryMax: -1` → `retry` 里 `for (attempt = 1; attempt <= -1; ...)` 一次都不执行 → 见缺失 11，最终 `throw undefined`。
  即：**同一个「正整数」概念，config 的守卫比 worker-pool / backoffDelay 少了一半**（那两处都用 `Number.isInteger` + 正数判断）。

---

## 缺失 3

- **file**: `src/queue.js:9`
- **承诺来源**: 同类一致性（跨文件）+ 错误消息文本
- **承诺内容**: ``throw new TypeError('capacity must be a positive number');``，条件是 `typeof capacity !== 'number' || capacity <= 0`
- **实现缺口**: `typeof NaN === 'number'`，且 `NaN <= 0` 为 `false` → **NaN 通过校验**；同理 `2.7`、`Infinity` 也全部通过。缺 `Number.isFinite()` / `Number.isInteger()`。同仓库另外三处同类校验都用了 `Number.isInteger`（`config.js:16`、`retry.js:9`、`worker-pool.js:9`），这里是唯一的例外。
- **影响**: ★ 实测 `new TaskQueue({capacity: NaN})` 构造成功，随后连续 20 次 `enqueue` **全部返回 true**，`size` 涨到 20。因为满队判断是 `this.#items.length > NaN`，恒为 `false`。容量上限在最常见的误传路径（配置缺省/表达式算出 NaN）下彻底失效——而 `capacity` 恰恰是这个类存在的主要理由。`capacity: Infinity` 同理。

---

## 缺失 4

- **file**: `src/queue.js:60-70`（`peek`，返回点 `69`）与 `src/queue.js:49-58`（`dequeue`，返回点 `57`）
- **承诺来源**: JSDoc + 类语义（框架必查模式「返回值未防御」）
- **承诺内容**:
  - `/** 查看队首但不出队。同优先级时返回最先入队的（注释声称如此）。 */`
  - `/** 按优先级出队（priority 越大越先出）。 */`
- **实现缺口**: 两个方法都**直接把内部对象的引用交给调用方**，没有 freeeze、没有拷贝，也没有任何「返回值可改」的说明。`peek` 的语义（「查看」）尤其暗示只读。
- **影响**: ★ 实测：`queue.enqueue({id:'a',priority:1}); queue.enqueue({id:'b',priority:5}); const p = queue.peek(); p.priority = -99;` 之后下一次 `dequeue()` 返回的是 **`a`** 而不是 `b`——调用方只是「看了一眼」，就把队列的出队顺序改掉了。`dequeue` 同理（返回的就是被 splice 出来的那个内部元素）。这是队列不变量被外部输入静默破坏的典型路径。

---

## 缺失 5

- **file**: `src/queue.js:37-41`
- **承诺来源**: 同类一致性 + 实现自身的意图（框架必查模式「入参未防御」）
- **承诺内容**: `enqueue` 明确用 `{ ...task, priority: ..., enqueuedAt: ... }` 建了一个**新对象**——这个展开操作本身就是「入队时对任务做了一份隔离副本」的声明。
- **实现缺口**: 只做了**浅拷贝**。嵌套字段（`task.meta`、`task.payload`、`task.args` 等）仍与调用方共享引用；且这份浅副本会经 `peek`/`dequeue` 原样交还给调用方（见缺失 4），于是嵌套引用在「调用方 → 队列 → 调用方」之间三向共享。缺少深拷贝或对嵌套结构的冻结/文档声明。
- **影响**: ★ 实测两向都成立：
  - 入队后调用方改 `inner.v = 99` → `queue.peek().inner.v === 99`；
  - 取出后改 `peeked.meta.n = 777` → 调用方原对象 `t.meta.n === 777`。
  队列里存的任务内容在排队期间可被外部任意篡改，`enqueuedAt` / `priority` 的隔离是有效的、但业务字段不是。说是「隔离副本」只兑现了最外层一层。

---

## 缺失 6

- **file**: `src/store.js:30-32`（`get`）与 `src/store.js:34-37`（`set`）
- **承诺来源**: 模块头注释 + 框架必查模式「返回值未防御 / 入参未防御」
- **承诺内容**:
  ```
  // src/store.js — 简单的 key-value 持久化（JSON 文件）
  ```
  一个「持久化」存储，`get` 是读、`set` 是写。
- **实现缺口**: `get` 返回内部对象的**直接引用**；`set` 把调用方对象**按引用存起来**（`this.#data[key] = value`）。两个方向都没有拷贝/冻结/文档说明。
- **影响**: ★ 实测：
  - `const v = store.get('user'); v.n = 999;` → `store.get('user').n === 999`，**下一次任何 `#persist()` 都会把这次外部改动写进磁盘**。读到的东西一改，持久化数据就被改了，且没有任何 `set` 调用留痕。
  - `const obj = {n:1}; store.set('k', obj); obj.n = 42;` → `store.get('k').n === 42`。写完之后调用方继续用自己那个对象（很常见），存储内容跟着一起漂移。这正是「持久化」承诺最不该漏的一件事。

---

## 缺失 7

- **file**: `src/store.js:31`
- **承诺来源**: 同类一致性（同文件内守卫不一致）
- **承诺内容**: `delete` 写得很严谨：
  ```js
  if (!Object.prototype.hasOwnProperty.call(this.#data, key)) return false;
  ```
- **实现缺口**: `get` 用的是 `key in this.#data`，**没有同样的 own-property 守卫**。`in` 会走原型链。同文件里两个「按键访问」的方法，一个守了原型链、一个没守。
- **影响**: ★ 实测 `store.get('toString')` 返回一个 **function**，`store.get('constructor')` 返回 `Object`。对任何调用方来说，查询一个从未写入过的键本该得到 `undefined`，却拿到了原型上的东西：
  - `store.get(key) === undefined` 这种「键不存在」判断直接失真；
  - 更糟的是 `store.get('toString')` 结果非空，调用方若按「存在」分支处理（比如 JSON 序列化它、当配置值用）就会拿到一个函数。
  文件里 `delete('toString')` 正确返回 `false`（走了 hasOwnProperty），于是同一个键上 `get` 说有、`delete` 说没有——两个方法自相矛盾。

---

## 缺失 8

- **file**: `src/store.js:19-28`（重点 `24`）
- **承诺来源**: 文件头注释 + 构造函数的入参契约
- **承诺内容**: `// src/store.js — 简单的 key-value 持久化（JSON 文件）`；`constructor` 校验 `path` 之后直接 `this.#data = this.#load()`，把 `#load()` 的返回当作可信的键值表。
- **实现缺口**: `JSON.parse(raw)` 之后**没有校验解析结果的形状**——没有 `parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)`。JSON 合法的顶层值有六种，代码只处理了「对象」这一种，其余五种原样装进 `#data`。
- **影响**: ★ 实测，全部是构造阶段就发生的：
  - 文件内容 `null` → `constructor` 本身不报错，之后**任何** `get` 都抛 `TypeError: Cannot use 'in' operator to search for 'k' in null`；
  - 文件内容 `"hello"` → 同样在 `get` 处抛错；
  - 文件内容 `[1,2,3]` → 静默变成一个数组，`get('0') === 1`、`keys() === ['0','1','2']`，键空间被数字下标污染，之后 `set('a',9)` 持久化出的仍是 `[1,2,3]`，**新值直接丢失**；
  - 文件内容 `42` → `set` 抛 `Cannot create property 'a' on number '42'`。
  触发条件很现实：文件被人手改过、被别的版本写过、或者上一次写入了非对象值。缺的就是一行形状校验。

---

## 缺失 9

- **file**: `src/store.js:55`
- **承诺来源**: 模块头注释（「持久化」= 写下去的东西读回来还在）
- **承诺内容**: `// src/store.js — 简单的 key-value 持久化（JSON 文件）`
- **实现缺口**: `#persist()` 直接 `JSON.stringify(this.#data, ...)`，**没有先校验值是否可序列化**，也不检查序列化后是否丢失了内容。`JSON.stringify` 对函数 / `undefined` / `Symbol` 是**静默丢弃**，不抛错，`#persist` 也无法察觉。
- **影响**: ★ 实测 `store.set('fn', () => {}); store.set('undef', undefined); store.set('ok', 1);` → `keys()` 返回 `['fn','undef','ok']`、`get('fn')` 仍然是 function，但磁盘上是 `{"ok": 1}`。**内存与磁盘分歧，且两次 `set` 都报告成功**。进程重启后这两个键凭空消失，而运行期间一切正常——这是最难排查的一类数据丢失。
- **补充（同类，一并说明）**: 值不可序列化到**抛错**的情形（循环引用），`this.#data[key] = value` 已经先执行了，`#persist()` 抛错后**没有回滚**，内存里留下了磁盘上没有的键。缺的是「先序列化成功、再提交内存」这个顺序（与文末排除的「先删后写」无关，这里是提交顺序问题）。

---

## 缺失 10

- **file**: `src/store.js:2`（承诺）/ `src/store.js:50-56`（实现）
- **承诺来源**: 文件头注释的整体声明（载体 #5）
- **承诺内容**:
  ```
  // src/store.js — 简单的 key-value 持久化（JSON 文件）
  // 带原子写入：先写临时文件再 rename，避免半写状态
  ```
- **实现缺口**: `#persist()` 里**既没有临时文件，也没有 rename**。写的是 `writeFileSync(this.#path, ...)` 直接覆盖目标路径。整句「原子写入 / 先写临时文件再 rename」在实现里完全不存在——这属于承诺声明的机制压根没写，不是写坏了。
- **影响**: 头部注释所述的崩溃安全性为零：进程在 `writeFileSync` 中途被杀（大 JSON、磁盘满、断电）会留下被截断的文件，下次 `#load` 走 `catch { return {} }` → **整库数据变成空对象**。此外注释让人相信这里已经有原子性保证，从而不会再去别处补。触发条件需要进程异常终止，属于低概率但后果是全量数据丢失。

---

## 缺失 11

- **file**: `src/index.js:21-28`（重点 `25`、`27-28`）
- **承诺来源**: 函数级注释 + 另一函数的 JSDoc（跨函数契约）
- **承诺内容**:
  - `/** 把一批任务按配置并发执行，失败的按策略重试。 */`
  - `src/queue.js:25`：`队列满时返回 false，不抛错——调用方需要能区分「满了」和「出错了」。`
- **实现缺口**: 三件事一起缺：
  1. `queue.enqueue(t)` 的**布尔返回值被丢弃**（`for (const t of tasks) queue.enqueue(t);`）——`enqueue` 特意设计了返回值就是为了让调用方能区分，这里第一个调用方就没接；
  2. 建好的 `queue` **此后从未被读取或消费**（没有任何 `dequeue`/`size` 调用），构造 + 逐个入队 + 逐个校验的整段工作全是死代码，其校验结果没有被传给执行器；
  3. 注释 `// 假设队列持有的是独立副本，下面清空原数组不会影响队列` 之后立刻 `tasks.length = 0`，而**紧接着第 30 行正是拿这个已被清空的 `tasks` 去执行**。
- **影响**: ★ 实测 `processTasks([{id:'a'},{id:'b'},{id:'c'}], {handler})` 返回 **`[]`**——一个任务都没执行，且调用方传入的数组被清空（`tasks.length === 0`）。函数名与文档承诺「把一批任务并发执行」，实现对非空输入的执行量是 0。这不是理论上可能：这是默认路径下 100% 发生。

---

## 缺失 12

- **file**: `src/index.js:34`
- **承诺来源**: 字段命名约定 + 同一行的注释 + `config.js` 的字段语义
- **承诺内容**:
  ```js
  maxDelay: config.timeoutMs,   // timeoutMs 是单次超时上限，不是退避上限
  ```
- **实现缺口**: `timeoutMs` 这个配置项**从未被用作超时**。全仓库搜索 `timeoutMs` 只有三处：默认值 `30000`、`parsePositiveInt` 解析、以及这一行把它当成 `maxDelay` 用。**没有任何 `Promise.race` / `AbortController` / `setTimeout` 超时实现**。「单次超时上限」这个能力整块缺失——注释自己都点明了语义错位，却没有补上实现。
- **影响**: 两层，都由实测确认：
  1. **功能缺失**：一个永久挂起的 handler（无超时的 socket / 死锁 promise）永远不会被 `timeoutMs` 打断，`processTasks` 永久悬挂。`timeoutMs` 这个名字会让使用者相信有超时保护。
  2. **牵出真实故障**：`timeoutMs` 被当 `maxDelay` 后，`config.js` 允许 `TIMEOUT_MS=10`（正整数，合法），而 `retry.js:13` 要求 `maxDelay >= base`，而 `index.js:33` 把 `base` 硬编码为 `50`。★ 实测 `loadConfig({TIMEOUT_MS:'10'})` 通过校验，随后首次失败即抛 `RangeError: maxDelay must be >= base`，被 `runWithConcurrency` 吞成 `{ok:false}`，**真正的 handler 错误被这个内部 `RangeError` 完全替换**。`TIMEOUT_MS` 取 10/20/30/40/50 之类的小值都是合法输入，都会触发。

---

## 缺失 13

- **file**: `src/index.js:14-20`（入参校验）与 `src/index.js:37-38`（返回值）
- **承诺来源**: 同类一致性（`runWithConcurrency` 有，`processTasks` 没有）+ 框架必查模式「返回值未防御」
- **承诺内容**:
  - `worker-pool.js:8`: `if (!Array.isArray(tasks)) throw new TypeError('tasks must be an array');`
  - `index.js:18-20` 只校验了 `handler`：`if (typeof handler !== 'function') throw ...`
- **实现缺口**:
  - **入参**：`tasks` 和 `config` 都没校验。同仓库的 `runWithConcurrency` 对同一个 `tasks` 参数是校验的——`processTasks` 作为更外层的公共入口反而没有，而且它比 `runWithConcurrency` 更早用到 `tasks`（`tasks.length`，第 23 行），所以错误会更早、更莫名其妙地发生。
  - **返回值**：`return raw` 直接把 `runWithConcurrency` 内部的 `[{ok:true,value}|{ok:false,error}]` 包装数组原样交给调用方，不 freeze、不转换、也没有任何文档说明这个结构（第 37 行注释是「实现者自述」，不是对调用方的契约）。对照 `runWithConcurrency` 的 JSDoc「最终把所有结果/错误按索引返回」是有文档的，这里没有。
- **影响**: ★ 实测 `processTasks(null, {handler})` 抛 `TypeError: Cannot read properties of null (reading 'length')`——报的是 `.length` 而不是「tasks must be an array」，调用方无从知道是哪个参数错了。`processTasks('abc', ...)` 则走到 `queue.enqueue` 才抛 `task must be an object`（字符串被逐字符遍历）。返回值方面：调用方拿到的是带 `ok` 字段的包装对象，但**返回值本身可被随意改写**（未冻结），且没有任何签名/文档告知这一结构——公共 API 的返回结构只能靠读源码猜。

---

## 缺失 14

- **file**: `src/retry.js:32-34`（守卫）与 `src/retry.js:42,47`（后果）
- **承诺来源**: 同类一致性（同函数内 `Number.isInteger` 守了一半）+ JSDoc
- **承诺内容**:
  - `/** 达到 maxAttempts 仍失败则抛出最后一次的错误。 */`
  - 守卫写的是 `if (!Number.isInteger(maxAttempts)) throw new RangeError(...)`
- **实现缺口**: 只校验了「整数」，**没校验 `maxAttempts >= 1`**。`maxAttempts = 0` 或负数时，`for (let attempt = 1; attempt <= maxAttempts; ...)` 循环体一次都不进，`lastError` 保持 `undefined`，最后执行 `throw lastError` → **`throw undefined`**。对比 `backoffDelay`（同文件）对 `attempt < 1` 是明确抛 `RangeError` 的，这里少了同一半守卫。
- **影响**: ★ 实测 `retry(async () => 'x', { maxAttempts: 0 })` 抛出的值是字面量 `undefined`，`catch (e) { e.message }` 直接二次崩溃（`Cannot read properties of undefined`）。而 `maxAttempts: 0` 是一个完全合理的输入语义（「不重试」），`config.js` 的解析器现在也**允许**它（见缺失 2，`RETRY_MAX=-1` 同样放行）。抛 `undefined` 让上游任何 `err instanceof Error` / `err.code` 分支全部失效。

---

## 缺失 15

- **file**: `src/retry.js:25-31`（签名）与 `src/retry.js:38`（使用）
- **承诺来源**: JSDoc + 同类一致性（同文件 `backoffDelay` 校验了全部三个数值参数；同函数校验了 `maxAttempts`）
- **承诺内容**: `/** 按策略重试一个 async 函数。 */` —— 参数位置的 `fn` 按文档就是一个函数。
- **实现缺口**: **`fn` 没有 `typeof fn === 'function'` 守卫**。`shouldRetry`、`sleep` 同样没有。一个编程错误（传错参数）不会在入口被立刻拒绝，而是被 `try { return await fn(attempt) }` 当成**可重试的运行时失败**捕获。
- **影响**: ★ 实测 `retry('nope', { maxAttempts: 2 })` 并不在入口报错，而是把 `TypeError: fn is not a function` 当成业务错误捕获、走完退避、再重试，最后才抛出这个被包装过的 `TypeError`。后果：(a) 一个参数错误被当成瞬时故障重试了 `maxAttempts` 次，白白消耗退避时间和副作用预算；(b) `shouldRetry(err)` 会被这个 `TypeError` 调用，自定义策略可能据此决定「不重试」并静默 `break`，错误分类被彻底搞乱；(c) 报错堆栈指向 `retry` 内部的调用点，而不是调用方写错参数的位置。同文件其它参数都校验了，唯独最关键的执行体没有。

---

## 缺失 16

- **file**: `src/worker-pool.js:3-6`（承诺）/ `src/worker-pool.js:19-21,36`（实现）
- **承诺来源**: JSDoc 的显式结果契约
- **承诺内容**:
  ```
  /**
   * 以固定并发度跑一组异步任务。
   * 任何一个抛错不会中断其余任务；最终把所有结果/错误按索引返回。
   */
  ```
  「**所有**结果/错误**按索引**返回」是一个很强的不变量：返回数组必须每个下标都有值，且每个任务恰好被执行一次。
- **实现缺口**: 返回前**没有任何完整性校验**——没有对 `results` 逐个检查是否已填充，也没有校验 `cursor` 最终覆盖了 `tasks.length`。调度部分在 `const idx = cursor;` 与 `cursor += 1;` 之间插入了 `await Promise.resolve();`，多个 worker 会在同一个 tick 读到相同 `cursor`，于是下标被重复领取、部分下标永远无人领取；而 `results` 是 `new Array(tasks.length)`，未领取的下标保持空位（sparse hole），代码不填充、不报错、直接返回。
- **影响**: ★ 实测 `runWithConcurrency([1..8], 4, async x => x*10)` 实际只执行了下标 `1,1,1,1,5,6,7,8`（下标 **0,2,3 从未执行**，下标 1 执行了 4 次），返回数组为
  `[{ok:true,value:10}, <hole>, <hole>, <hole>, {ok:true,value:50}, ...]`。
  对调用方的后果完全静默：`results.length === 8`（看起来正常）、`results.filter(x => x === undefined).length === 0`（因为 **`filter` 会跳过稀疏空位**，连「有没有缺」都检测不出来）、而 `JSON.stringify(results)` 会把三个空位渲染成 `null`。也就是说 JSDoc 承诺的「所有结果按索引返回」在最基本的意义上不成立，且缺失的部分无法通过常规检查发现。
  说明：根因是共享 `cursor` 的读-改-写被 `await` 打断；本报告只就「缺少返回前的完整性守卫 / 缺少每个下标恰好执行一次的保证」这一缺口定性，属于「承诺了却没有兑现机制」。

---

## 缺失 17

- **file**: `src/neg-catch.js:27-31`（承诺）/ `src/neg-catch.js:32-39`（实现）
- **承诺来源**: JSDoc —— 且该 JSDoc 明确写出了一个**可被证伪的事实断言**
- **承诺内容**:
  ```
  /**
   * 尝试解析 JSON，失败返回 null。
   * 空 catch 是刻意的：调用方用 `=== null` 明确区分「解析失败」和「解析成功但值是 null」
   * （后者在这里不可能出现，因为 JSON.parse 永远不会返回 null）。
   */
  ```
- **实现缺口**: 括号里的前提是**错的**：`JSON.parse('null')` 返回的就是 `null`。因此「用 `=== null` 区分失败与成功」这个被明确承诺的可区分性，在输入 `"null"` 时不成立。函数缺少一个与 `null` 可区分的失败哨兵（或 `{ok, value}` 结构）。
- **影响**: ★ 实测 `tryParseJson('null') === null`，与 `tryParseJson('{bad')` 的返回值**完全相同**——两者无法区分。调用方按 JSDoc 的指示用 `=== null` 判断「解析失败」，会把一个合法的 `"null"` JSON 文档误判为损坏数据。触发条件很具体但很常见：上游存的是合法 JSON 字面量 `null`（表示「无值」是很自然的用法）。这是注释承诺与实现能力之间的直接缺口，**与空 catch 无关**——catch 的语义是对的，错的是「可区分」这个承诺没有兑现。

---

## 缺失 18

- **file**: `src/neg-race.js:42-56`
- **承诺来源**: JSDoc 的不变量声明
- **承诺内容**:
  ```
  /**
   * 批量累加。任务用 runWithConcurrency 并发跑，但每次 increment 都是原子的，
   * 所以最终值一定等于任务数。这里的不变量有测试保护（见 test-base.mjs）。
   */
  ```
- **实现缺口**: 返回的是 `counter.value`，即**计数器的绝对值**，不是本次增量的结果。要兑现「最终值一定等于任务数」这个不变量，必须要么 (a) 校验 `counter.value === 0` 的入口前置条件，要么 (b) 返回增量（`after - before`）而不是绝对值。两者都没做。此外注释引用的 `test-base.mjs` **在仓库中不存在**（`codebase/` 下只有 `package.json` 和 `src/`），所谓「有测试保护」也无法兑现/核对。
- **影响**: ★ 实测：`const c = new Counter(); c.increment(); c.increment(); await batchIncrement(c, 3)` 返回 **5**，而不是文档承诺的 3。只要计数器在调用前被用过（同一个 `Counter` 被复用于多个批次、或与 `increment()` 混用），承诺就破产。
  说明：本次 3 次 `incrementAsync` 自身是原子的、`Promise.all` 之后值确实是 `+3`（文件头「没有竞态」的判断成立，予以确认）。缺的是「入口前置条件」这一件事，不是并发逻辑。

---

## 缺失 19

- **file**: `src/neg-race.js:46-49`
- **承诺来源**: 同类一致性（同一函数内，两个参数一守一不守）
- **承诺内容**:
  ```js
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError('count must be a non-negative integer');
  }
  ```
- **实现缺口**: `count` 被严格校验（类型 + 范围 + 错误消息），**`counter` 参数完全没有校验**。一个做参数防御的函数对另一个参数不做防御，形成明显的同类不同守卫。
- **影响**: ★ 实测 `batchIncrement({}, 3)` 抛 `TypeError: counter.incrementAsync is not a function`——报的是内部实现细节，而不是「counter 必须是 Counter 实例」；且这个错误发生在循环内第一次 `push` 时，若 `count === 0` 则**完全不报错直接返回 `undefined`**（`counter.value` 也是 undefined）。调用方拿到的错误信息与真实原因（传错参数）不匹配。

---

## 缺失 20

- **file**: `src/neg-unused.js:20-37`（重点 `34`）
- **承诺来源**: JSDoc 的用途声明
- **承诺内容**:
  ```
  /**
   * 把错误对象规范化为一个稳定的结构，供使用方打印日志。
   * 本仓库内部不调用它——它是给使用方用的。
   */
  ```
  关键词是「**稳定**」和「**供打印日志**」。
- **实现缺口**: 非 `Error` 分支用 `String(err)`（第 34 行），**外面没有兜底**。`String()` 会调用对象的 `toString`/`Symbol.toPrimitive`，而错误对象恰恰是最不可信、最可能抛错的一类输入；一个「为打日志而生」的归一化函数，在归一化失败时自己抛错，恰好会在日志路径上制造二次故障。缺的是对这一行的 try/catch（同仓库 `neg-catch.js` 的 `tryParseJson` 就示范了该有的写法）。
- **影响**: ★ 实测 `normalizeError({ toString() { throw new Error('boom-toString') } })` **抛出** `boom-toString`，而不是返回那个「稳定的结构」。触发条件：日志中间件捕获了某个代理对象 / 序列化错误 / `toString` 被重写的第三方 error-like 值——正是本函数最该覆盖的场景。此时调用方（一个正在处理错误的日志路径）二次崩溃，原始错误信息丢失。
- **次要（同类，低危）**: 返回值是新建的普通对象，未 freeze、无「可改」说明（框架必查模式「返回值未防御」）；作为公共 API 的归一化产物，调用方改它不会影响内部状态，因此实际风险很低，仅记录。

---

## 缺失 21

- **file**: `src/neg-unused.js:43-50`
- **承诺来源**: 命名约定 + JSDoc + 同类一致性（与 `queue.js` 的入队校验对照）
- **承诺内容**:
  ```
  /**
   * 校验一个任务对象。使用方在提交任务前可以调用。
   * 内部不使用——入队时 Queue 自己会校验。
   */
  export function isValidTask(task) { ... }
  ```
  名字是 `isValidTask`，文档说它是「提交任务前」的校验器。
- **实现缺口**: 只判断 `typeof task === 'object'` 和 `id` 是非空字符串，**没有排除数组**。数组的 `typeof` 也是 `'object'`，所以 `[]` 只要挂上 `id` 就会被判定为合法任务。同仓库 `queue.js:28` 的入队校验用的是完全相同的判断，因此两边一致地放行数组——也就是说这个公共校验器**没有做到它名字承诺的「验证任务对象」**。
- **影响**: ★ 实测 `const a = []; a.id = 'x'; isValidTask(a) === true`。使用方信任这个 API 提前过滤非法任务，数组会通过检查然后进入队列；后续 `priority`/`enqueuedAt` 会被挂到数组上，`{...task}` 展开数组也会得到 `{0:..., 1:..., id:...}` 这种畸形对象。属于边界输入，影响有限但确实与「校验任务对象」的承诺不符。缺失的是 `Array.isArray(task) === false` 这一句。

---

## 明确排除（属于「代码写错了」，不在本次范围）

审查过程中确认存在、但按任务要求**不报告**的缺陷：

| 位置 | 现象 | 排除理由 |
|---|---|---|
| `queue.js:53` / `queue.js:65` | `>=` 使同优先级时取**最后**入队的元素，`dequeue`/`peek` 实测返回 `c,b,a`；`peek` 注释明说「返回最先入队的（注释声称如此）」 | FIFO 破坏 |
| `queue.js:34` | `this.#items.length > this.#capacity`，容量为 N 时可放入 N+1 个 | 容量差一 |
| `retry.js:15` | `base * Math.pow(2, attempt)`，注释承诺 `2^(attempt-1)`，实测第一次退避就是 `base*2` | 指数算错 |
| `store.js:54-55` | `rmSync` 后 `writeFileSync`，中途失败数据全丢 | 先删后写 |
| `neg-catch.js:20,36,50` | 三处 `catch {}` | 空 catch（且该文件语义经核验确实正确） |

---

## 完整清单：检查了哪些承诺

### 未兑现（本报告 21 条）

| # | 位置 | 承诺载体 | 承诺 | 缺了什么 |
|---|---|---|---|---|
| 1 | queue.js:82 | JSDoc | `@returns {boolean} 总是 true` | 缺 `return true` |
| 2 | config.js:16 | 命名 + 错误消息 | `parsePositiveInt` / "positive integer" | 缺 `n > 0` |
| 3 | queue.js:9 | 跨文件同类一致性 | "capacity must be a positive number" | 缺 `Number.isFinite`（NaN 通过） |
| 4 | queue.js:69,57 | JSDoc + 返回值未防御 | `peek`「查看」不出队 | 缺拷贝/冻结，外部可改队列序 |
| 5 | queue.js:37 | 入参未防御 | `{...task}` 表示做了隔离副本 | 只浅拷贝，嵌套引用三向共享 |
| 6 | store.js:31,36 | 返回值/入参未防御 | 「持久化」 | get 返引用、set 存引用，双向别名 |
| 7 | store.js:31 | 同文件同类一致性 | `delete` 用 hasOwnProperty | `get` 用 `in`，漏原型链守卫 |
| 8 | store.js:24 | 文件头 + 构造契约 | 「key-value 持久化」 | 缺解析结果形状校验（null/string/array 放行） |
| 9 | store.js:55 | 文件头 | 「持久化」 | 缺可序列化校验，函数/undefined 静默丢失 |
| 10 | store.js:2 | 文件头整体声明 | 「先写临时文件再 rename」 | 临时文件与 rename 均未实现 |
| 11 | index.js:25,28 | 注释 + queue.js JSDoc | 「把一批任务并发执行」/「调用方需要能区分」 | 丢弃 enqueue 返回值；队列建后从不消费；清空后才执行 |
| 12 | index.js:34 | 命名 + 同行注释 | `timeoutMs` 是「单次超时上限」 | 超时能力整块未实现，反被当 maxDelay |
| 13 | index.js:14,37 | 同类一致性 + 返回值未防御 | 同参数在 worker-pool 里被校验 | 缺 tasks/config 校验；返回值结构无文档/未冻结 |
| 14 | retry.js:32 | 同类一致性 + JSDoc | 「抛出最后一次的错误」 | 缺 `maxAttempts >= 1`，`throw undefined` |
| 15 | retry.js:25 | 同类一致性 | 「重试一个 async 函数」 | 缺 `typeof fn` 守卫，参数错误被当可重试故障 |
| 16 | worker-pool.js:5 | JSDoc 结果契约 | 「**所有**结果/错误按索引返回」 | 缺返回前完整性守卫；下标重复领取、空位静默返回 |
| 17 | neg-catch.js:29 | JSDoc（含可证伪断言） | 「用 `=== null` 明确区分」 | `JSON.parse('null')===null`，承诺的可区分性不成立 |
| 18 | neg-race.js:44 | JSDoc 不变量 | 「最终值一定等于任务数」 | 缺入口前置校验或增量返回；另 `test-base.mjs` 不存在 |
| 19 | neg-race.js:46 | 同函数内同类一致性 | `count` 有完整校验 | 缺 `counter` 参数校验 |
| 20 | neg-unused.js:34 | JSDoc「稳定的结构」 | 归一化供打印日志 | `String(err)` 无兜底，可抛错 |
| 21 | neg-unused.js:43 | 命名 + JSDoc | `isValidTask`「校验任务对象」 | 缺 `Array.isArray` 排除 |

### 兑现了（核实无误）

| 位置 | 承诺 | 核实结论 |
|---|---|---|
| `config.js:4` | `DEFAULTS` 冻结 | ✅ `Object.isFrozen(DEFAULTS) === true`，且 `loadConfig` 从不外泄它（每次返回新对象，实测改返回值不影响后续调用） |
| `config.js:23` | 「未知字段忽略，非法值抛错」 | ✅ 未知 env 字段被忽略；`LOG_LEVEL` 有白名单校验（`logLevel` 的校验比三个整数项严格，反衬出缺失 2） |
| `queue.js:28-33` | 入队参数校验抛 TypeError | ✅ 非对象/空 id 均抛出 |
| `queue.js:73-78` | `remove` 返回是否移除 | ✅ 找到返回 true，找不到返回 false |
| `retry.js:13` | `maxDelay >= base` | ✅ 抛出 `RangeError`；但它正是缺失 12 的引爆点 |
| `retry.js:43` | `shouldRetry` 为 false 时停止 | ✅ 语义成立（但它「停止后仍抛错误」这一行为无文档，属文档缺口） |
| `store.js:46-48` | `keys()` | ✅ 返回新数组，不与内部状态别名（与缺失 6 的 `get` 对比，这里是对的） |
| `store.js:12-14` | `path` 校验 | ✅ 非字符串/空串抛 TypeError |
| `worker-pool.js:8-12` | 三个参数全部校验 | ✅ tasks/concurrency/runner 都守了（正因如此，`processTasks` 不守才是缺失 13） |
| `neg-catch.js:15-25,45-53` | 空 catch 但语义正确 | ✅ 与文件头声明一致：`tryRemoveTemp` 先 `existsSync` 再删、返回值可区分；`safeClose` 有句柄形状预检。这两个不报 |
| `neg-race.js:10-40` | 「没有竞态」 | ✅ 逐行核对：`increment` 与 `incrementAsync` 的读-改-写都在 `await` 之前完成，中间无让出点。不报 |
| `neg-race.js:54` | `Promise.all` 后计数正确 | ✅ 实测从 0 起算的 `batchIncrement(c,3)` 返回 3；问题只在非零起点（缺失 18） |
| `neg-unused.js:11` | `ERROR_CODES` 冻结 | ✅ 确实 `Object.freeze`，且冻结的是对外导出的常量本身——**这是正确的冻结对象**，与缺失 4/6 中「返回活引用」形成对照 |
| `neg-unused.js:43` | 「内部不使用」 | ✅ 全仓库无内部调用，仅导出。文件头「不是死代码、是公共 API」的声明成立，不报死代码 |

### 「有但不够」专项（按框架警告逐条排掉）

1. **`config.js:4` 的 `Object.freeze`** — 搜索 `freeze` 会命中这里，但它保护的是 `DEFAULTS` 这个**常量**，不是 `loadConfig()` 的返回值。判定：**不是缺陷**。`loadConfig` 每次返回全新对象字面量，改动返回值不会污染 `DEFAULTS`（实测第二次调用仍是 `concurrency: 4`），没有共享可变状态可被破坏。这条正好是框架警告的「命中关键字但保护对象错了」的典型假阳性，已排除。
2. **`neg-unused.js:11` 的 `Object.freeze`** — 冻结对象 $=$ 对外导出值本身，保护方向正确。✅ 兑现。
3. **`store.js` 的 `get` 有守卫（`in`）** — 「有检查」但检查的是原型链而非自身属性。判定：**是缺陷**（缺失 7），属于「有但不够」。
4. **`queue.js:37` 有 `{...task}`** — 「有拷贝」但只有一层。判定：**是缺陷**（缺失 5），属于「有但不够」。
5. **`retry.js:32` 有 `Number.isInteger`** — 「有校验」但缺正数半边。判定：**是缺陷**（缺失 14），属于「有但不够」。
6. **`store.js:2` 声称原子写、`#persist` 里确实有一串写操作** — 「有写入逻辑」但没有临时文件与 rename。判定：**是缺陷**（缺失 10）。
7. **`neg-catch.js` 大量空 catch** — 关键字密集命中。判定：**不是缺陷**，逐条核对语义后确认安全（见上表）。
8. **`neg-race.js` 共享可变状态 + 异步** — 模式命中。判定：**不是缺陷**，`await` 位置经核验不构成交错（见缺失 18 的说明）。
9. **`neg-unused.js` 零内部引用** — 「死代码」模式命中。判定：**不是缺陷**，是公共 API（见上表）。
