# F-report — injected 代码库缺陷审查

审查范围：`experiments/injected/` 全部 9 个文件（约 471 行）。逐个可疑点均以脚本实测验证（脚本放在 `/tmp/audit1/`，未改动被审代码）。
`neg-catch.js` / `neg-race.js` / `neg-unused.js` 三个负例经实测确认**没有缺陷**（见文末「负例复核」），未列入发现。

---

## 发现 1

- **file**: src/index.js:28
- **原文**:
  ```js
  const queue = new TaskQueue({ capacity: tasks.length });
  for (const t of tasks) {
    queue.enqueue(t);
  }
  // 假设队列持有的是独立副本，下面清空原数组不会影响队列
  tasks.length = 0;

  const raw = await runWithConcurrency(tasks, config.concurrency, ...)
  ```
- **类型**: data-consistency
- **严重性**: CRITICAL
- **问题**: 任务被复制进 `queue` 后，原数组 `tasks` 被清空；而后续 `runWithConcurrency` 读的仍是**已被清空的 `tasks`**，而不是 `queue`。任何非空输入都会返回 `[]`，一个 handler 都不会执行——静默失败，不抛错。
- **依据**: 实测 `processTasks([{id:'a'},{id:'b'},{id:'c'}], {handler})` 返回 `[]`，`handler saw: []`。队列 `queue` 从头到尾没被读取过，是完全无用的中间对象。

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
- **严重性**: HIGH
- **问题**: 取号和自增之间插入了 `await`。多个 worker 在同一 tick 内都读到相同的 `cursor`，然后各自 `cursor += 1`，导致同一个索引被多个 worker 重复执行，其余索引永远无人处理。`concurrency` 越大重复越严重，结果数组出现大量空洞（`undefined`）。任务被**重复执行**（对非幂等 handler 是重复副作用）且**大量漏执行**。
- **依据**: 实测 5 个任务 / concurrency=3：runner 实际收到的参数是 `[0,0,0,3,3,3]`，返回值 `[{ok:true,value:0},null,null,{ok:true,value:30},null]`，索引 1/2/4 为空洞。concurrency=1 时正常，`>1` 即出错。调用计数 `{1:3, 4:3}` 证实每个号被跑 3 次。

## 发现 3

- **file**: src/queue.js:53
- **原文**:
  ```js
  if (this.#items[i].priority >= this.#items[bestIdx].priority) {
    bestIdx = i;
  }
  ```
- **类型**: logic
- **严重性**: HIGH
- **问题**: 注释声称「同优先级按 FIFO」，但 `>=` 使扫描时同优先级取到**更靠后**的元素，同优先级实际变成 LIFO（后进先出）。
- **依据**: 实测依次入队 `first/second/third`，均为默认优先级 0，`dequeue` 顺序为 `third second first`。应为 `>` 才能保留先入队者。

## 发现 4

- **file**: src/retry.js:15
- **原文**:
  ```js
  const exponential = base * Math.pow(2, attempt);
  ```
- **类型**: logic
- **严重性**: HIGH
- **问题**: JSDoc 明确写 `base * 2^(attempt-1)`，实现却是 `2^attempt`，退避时间**整体翻倍**。`attempt=1` 应等 1×base，实际等 2×base；每层都翻倍，重试总时延远超预期，且更容易撞 `maxDelay` 上限。
- **依据**: 实测 `backoffDelay(1,{base:100})` 返回 `200`（文档值 100）；`backoffDelay(2,{base:100})` 返回 `400`（文档值 200）。

## 发现 5

- **file**: src/config.js:16-18
- **原文**:
  ```js
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new TypeError(`${name} must be a positive integer, got: ${raw}`);
  }
  return n;
  ```
- **类型**: logic
- **严重性**: HIGH
- **问题**: 函数名为 `parsePositiveInt`、报错文案写 "must be a positive integer"，但只校验了 `Number.isInteger`，**没有校验 > 0**。`CONCURRENCY=0` / `-1` / `TIMEOUT_MS=0` / `RETRY_MAX=0` 都会通过校验。下游拿到 0/负数后行为未定义：`concurrency=0` 会让 `runWithConcurrency` 直接抛 `RangeError`；`retryMax=0` 会让 `retry` 抛 `undefined`（见发现 16）。
- **依据**: 实测 `loadConfig({CONCURRENCY:'0'}).concurrency === 0`、`-1` 原样返回；把该值传给 `runWithConcurrency` 立即得到 `RangeError: concurrency must be a positive integer`。

## 发现 6

- **file**: src/config.js:11
- **原文**:
  ```js
  const VALID_LOG_LEVELS = ['debug', 'info', 'error'];
  ```
- **类型**: contract
- **严重性**: MEDIUM
- **问题**: 合法日志级别漏掉 `warn`。用户设 `LOG_LEVEL=warn`（常见级别）会被当作非法值直接抛 `TypeError`，进程启动失败。
- **依据**: 实测 `loadConfig({LOG_LEVEL:'warn'})` 抛 `logLevel must be one of debug|info|error, got: warn`。

## 发现 7

- **file**: src/store.js:25
- **原文**:
  ```js
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
  ```
- **类型**: error-handling
- **严重性**: HIGH
- **问题**: 文件存在但内容损坏（半写、截断、手工编辑出错）时，静默返回空对象，**与「文件不存在」无法区分**。随后任何一次 `set` 都会用空对象覆盖原文件，把仍然可恢复的旧数据**永久删除**。这是空 catch 吞掉错误的真实缺陷（对比 neg-catch.js 中的刻意空 catch）。
- **依据**: 实测写入 `{not json` 后 `new JsonStore(p)`，`keys()` 为 `[]`、`get('k')` 为 `undefined`；再 `set('other',2)` 后文件内容变为 `{"other": 2}`，原数据无任何提示地丢失。

## 发现 8

- **file**: src/store.js:53-55
- **原文**:
  ```js
  // 先删原文件再写——中途失败会导致数据丢失
  if (existsSync(this.#path)) rmSync(this.#path);
  writeFileSync(this.#path, JSON.stringify(this.#data, null, 2), 'utf8');
  ```
- **类型**: data-consistency
- **严重性**: HIGH
- **问题**: 文件头注释声称「带原子写入：先写临时文件再 rename，避免半写状态」，实际实现是**先 `rmSync` 删除原文件、再原地写**，且代码里根本没有临时文件和 `rename`。`rm` 与 `write` 之间进程崩溃/磁盘满/断电，原文件已删而新文件未落盘，**全部数据丢失**；写入过程中读者也可能读到截断内容。
- **依据**: 全文件 grep 无 `rename`/临时文件，仅第 2 行有相关注释；`#persist` 里只有 `rmSync` + `writeFileSync`。注释与实现直接矛盾。

## 发现 9

- **file**: src/store.js:31
- **原文**:
  ```js
  get(key) {
    return (key in this.#data) ? this.#data[key] : undefined;
  }
  ```
- **类型**: security
- **严重性**: HIGH
- **问题**: 用 `in` 会沿原型链查找，`#data` 是普通对象，因此 `get('constructor')` / `get('toString')` / `get('hasOwnProperty')` 会返回**内置原型成员**而不是 `undefined`。任何用 key 做分支判断的调用方会被误导（例如 `if (store.get(k) !== undefined)` 对任意未存过的原型名恒为真）。
- **依据**: 实测 `get('constructor')` 返回 `function`、`get('toString')` 返回 `function`、`get('hasOwnProperty')` 返回 `function`。同文件的 `delete` 已经正确用了 `hasOwnProperty`，`get` 与之不一致。

## 发现 10

- **file**: src/index.js:34
- **原文**:
  ```js
  const raw = await runWithConcurrency(tasks, config.concurrency, (task) =>
    retry(() => handler(task), {
      maxAttempts: config.retryMax,
      base: 50,
      maxDelay: config.timeoutMs,   // timeoutMs 是单次超时上限，不是退避上限
    }),
  );
  ```
- **类型**: contract
- **严重性**: HIGH
- **问题**: `timeoutMs` 被文档/配置定义为「单次任务超时上限」，但代码里**从未对它做任何超时控制**，只是把它塞进退避的 `maxDelay`。handler 无论跑多久都不会被中断，超时配置完全失效。另有一个连带问题：`retry` 在 `maxDelay < base` 时会抛 `RangeError`，而 `base` 写死 50，因此 `TIMEOUT_MS < 50`（含合法的 `0`，见发现 5）会让每个任务都直接失败。
- **依据**: 实测 `config.timeoutMs=100`、handler 耗时 600ms，调用正常返回、无任何超时中断；`timeoutMs=0` 时 `retry` 抛 `RangeError: maxDelay must be >= base`。注释本身也承认「timeoutMs 是单次超时上限，不是退避上限」，却仍这样传参。

## 发现 11

- **file**: src/queue.js:34
- **原文**:
  ```js
  if (this.#items.length > this.#capacity) {
    return false;
  }
  ```
- **类型**: error-handling
- **严重性**: MEDIUM
- **问题**: 容量边界差一。判断应先于入队，且应为 `>=`；现在允许队列增长到 `capacity + 1` 才拒绝，容量上限被突破一个。
- **依据**: 实测 `capacity:2` 时连续入队返回 `true, true, true`，`size` 最终为 3；`capacity:1` 时 `size` 为 2。

## 发现 12

- **file**: src/queue.js:9-11
- **原文**:
  ```js
  if (typeof capacity !== 'number' || capacity <= 0) {
    throw new TypeError('capacity must be a positive number');
  }
  ```
- **类型**: error-handling
- **严重性**: MEDIUM
- **问题**: 只排除 `<= 0`，`NaN` 的比较恒为 false 因而通过，`Infinity` 和 `2.5` 等非整数也通过，与「positive number」的意图不符。无效容量会导致容量限制失效（`NaN` 时 `length > NaN` 恒为 false，永不拒绝入队）。
- **依据**: 实测 `capacity` 取 `NaN`、`2.5`、`Infinity` 均构造成功，且 `NaN` 下可无限入队。

## 发现 13

- **file**: src/queue.js:65-69
- **原文**:
  ```js
  for (let i = 1; i < this.#items.length; i++) {
    if (this.#items[i].priority >= this.#items[bestIdx].priority) {
      bestIdx = i;
    }
  }
  return this.#items[bestIdx];
  ```
- **类型**: data-consistency
- **严重性**: MEDIUM
- **问题**: 两点。(1) `peek()` 直接返回内部数组里的**活引用**，调用方修改返回值会篡改队列内部状态（优先级可被外部改写）。(2) 同优先级用了 `>=`，注释却说「同优先级时返回最先入队的」，实际返回**最后入队**的，与 `dequeue` 也不一致（`dequeue` 也是 LIFO，见发现 3，但 `peek` 的注释单独声称 FIFO）。
- **依据**: 实测同优先级依次入队 `first/second/third`，`peek().id === 'third'`；对 `peek()` 返回值设 `priority=999` 后再次 `peek()` 读到 `999`，证明是内部对象本身。

## 发现 14

- **file**: src/queue.js:80-86
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
- **问题**: JSDoc 声明返回 `boolean` 且「总是 true」，函数体没有任何 `return`，实际返回 `undefined`。调用方按文档写 `if (q.clear())` 会永远走 false 分支。
- **依据**: 实测 `q.clear()` 返回 `undefined`。

## 发现 15

- **file**: src/queue.js:74
- **原文**:
  ```js
  remove(id) {
    const idx = this.#items.findIndex((t) => t.id === id);
  ```
- **类型**: contract
- **严重性**: LOW
- **问题**: `enqueue` 强制校验 `task.id` 为非空字符串，`remove` 却对 `id` 不做任何校验，两者契约不一致。传入 `null`/数字时不报错而是静默返回 `false`，把「调用方写错」伪装成「没找到」。
- **依据**: 实测 `remove(null)` 与 `remove(123)` 均返回 `false` 且不抛错；而 `enqueue({id:123})` 会抛 `TypeError`。

## 发现 16

- **file**: src/retry.js:47
- **原文**:
  ```js
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  ...
  throw lastError;
  ```
- **类型**: error-handling
- **严重性**: MEDIUM
- **问题**: 只校验 `maxAttempts` 是整数，未校验 `>= 1`。当 `maxAttempts <= 0` 时循环一次都不执行，`lastError` 仍是 `undefined`，函数 `throw undefined`——调用方拿到的是「抛出 undefined」，既无 message 也无 stack，且 `catch (e) { e.message }` 会二次抛错。结合发现 5，`RETRY_MAX=0` 可经配置正常到达这里。
- **依据**: 实测 `retry(fn,{maxAttempts:0})` 与 `{maxAttempts:-1}` 均抛出 `undefined`。

## 发现 17

- **file**: src/index.js:23
- **原文**:
  ```js
  const queue = new TaskQueue({ capacity: tasks.length });
  ```
- **类型**: error-handling
- **严重性**: MEDIUM
- **问题**: 用 `tasks.length` 直接当 `capacity`，空数组时得到 `capacity: 0`，被 `TaskQueue` 构造函数判为非法并抛 `TypeError`。因此「输入为空」这一完全合法的边界情况会让 `processTasks` 抛错而不是返回 `[]`。
- **依据**: 实测 `processTasks([], {handler})` 抛 `TypeError: capacity must be a positive number`。

## 发现 18

- **file**: src/store.js:24
- **原文**:
  ```js
  return JSON.parse(raw);
  ```
- **类型**: data-consistency
- **严重性**: MEDIUM
- **问题**: `#load` 不校验解析结果是否为普通对象。文件内容是合法 JSON 但不是对象时（`null`、`123`、`"str"`），`#data` 会变成 `null`/数字/字符串，随后 `get()` 里的 `key in this.#data` 直接抛 `TypeError`，整个 store 不可用且无法自愈。
- **依据**: 实测内容为 `null` 时 `get()` 抛 `Cannot convert undefined or null to object`；内容为 `123` / `"str"` 时抛 `Cannot use 'in' operator...`。

## 发现 19

- **file**: src/store.js:35
- **原文**:
  ```js
  set(key, value) {
    this.#data[key] = value;
    this.#persist();
  }
  ```
- **类型**: data-consistency
- **严重性**: LOW
- **问题**: `set('__proto__', v)` 不会新增自有属性，而是改写对象原型；`keys()` 看不到该键、`#persist` 写出 `{}`，写入被静默丢弃。`get`/`delete` 对同名键也表现不一致（`delete` 因 `hasOwnProperty` 判定返回 false）。
- **依据**: 实测 `set('__proto__',{polluted:true})` 后 `keys()` 为 `[]`，落盘内容为 `{}`，且 `get('__proto__')` 能读到该值——写入未持久化却可读，状态自相矛盾。

---

## 负例复核（确认不是缺陷，故未上报）

- **src/neg-catch.js** — 三处 `catch {}` 均为刻意设计：失败后状态一致，且都能从返回值判断结果。实测 `tryRemoveTemp` / `safeClose` 在失败路径返回 `false`，调用方可区分。
- **src/neg-race.js** — 经实测确认无竞态：`increment` 是同步读改写；`incrementAsync` 的 `await` 在写入之后、且未回写旧值。`batchIncrement(counter, 1000)` 结果精确为 `1000`。共享状态访问均在同一同步块内，单线程下不会被交错。
- **src/neg-unused.js** — `ERROR_CODES` / `VERSION` / `normalizeError` / `isValidTask` 是库的公共 API，本仓库内部不引用属正常，不应判为死代码。
