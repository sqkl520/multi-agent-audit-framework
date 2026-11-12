## 发现 1
- **file**: src/index.js:28
- **类型**: logic
- **严重性**: CRITICAL
- **问题**: `processTasks(tasks, {handler})` 在把任务 enqueue 后执行 `tasks.length = 0`，而随后真正传给 `runWithConcurrency` 的正是这个已被清空的同一个数组。任何非空输入 → handler 一次都不会被调用，函数恒返回 `[]`，队列里拷贝的任务也从不消费。整个对外主 API 实际是空操作。
- **依据**: 实测 3 个任务、handler 计数为 0，返回 `[]`；`input` 被清成 `[]`。注释「假设队列持有的是独立副本，下面清空原数组不会影响队列」只对队列成立，但紧接着第 30 行用的是被清空的 `tasks`，对象搞错了。

## 发现 2
- **file**: src/worker-pool.js:19-21
- **类型**: concurrency
- **严重性**: CRITICAL
- **问题**: `worker()` 先 `const idx = cursor`，再 `await Promise.resolve()` 让出，然后才 `cursor += 1`。`concurrency >= 2` 时两个 worker 会在让出点读到同一个 `idx` → 同一任务被执行两次，而另一个索引永远没人处理，`results` 里留下 `null` 空洞。输入任意长度 ≥2 的任务数组且并发 >1 即触发。
- **依据**: 实测 `runWithConcurrency(['t0','t1','t2'], 2, ...)` 调用序列为 `t0,t0,t2`，结果为 `[{ok,...},null,{ok,...}]`；4 个任务并发 2 稳定得到 `0,0,2,3` 和 1 个空洞。并发为 1 时正常，故是读改写被 await 打断的典型竞态。去掉第 20 行的 `await` 即修复。

## 发现 3
- **file**: src/config.js:13-20
- **类型**: error-handling
- **严重性**: HIGH
- **问题**: `parsePositiveInt` 名为「positive int」，实际只校验 `Number.isInteger(n)`，不校验 `n > 0`（也未 trim）。输入 `CONCURRENCY=0`/`-2`、`RETRY_MAX=0`、`TIMEOUT_MS=0`、或 `CONCURRENCY='   '`（`Number('   ')==0`）都会被当作合法配置返回。后果向下游扩散：`concurrency=0` 在 `runWithConcurrency` 处抛 `RangeError`；`retryMax=0` 让 `retry` 抛 `undefined`（见发现 5）；`timeoutMs=0` 触发 `backoffDelay` 的 `RangeError` 并掩盖真实错误（见发现 7）。
- **依据**: 实测 `loadConfig({CONCURRENCY:'0'})` 返回 `{concurrency:0,...}`；`{'   '}` 同样返回 0；`RETRY_MAX:'0'`、`TIMEOUT_MS:'0'` 均通过。校验名与行为不符。

## 发现 4
- **file**: src/retry.js:32-47
- **类型**: error-handling
- **严重性**: HIGH
- **问题**: `retry` 只校验 `Number.isInteger(maxAttempts)`，允许 0 和负数。当 `maxAttempts <= 0` 时 for 循环一次都不执行，`lastError` 仍为 `undefined`，最后 `throw lastError` 抛出的是 `undefined`——调用方拿到一个无堆栈、无消息的异常，完全无法定位。经发现 3 的 `RETRY_MAX=0` 可直接触发。
- **依据**: 实测 `retry(fn,{maxAttempts:0})` reject 值为 `undefined`；`maxAttempts:-1` 同样 reject `undefined`。正常 `maxAttempts:1` 执行 1 次正常。

## 发现 5
- **file**: src/store.js:19-28
- **类型**: error-handling
- **严重性**: HIGH
- **问题**: `#load` 对 `JSON.parse` 结果不做「必须是普通对象」校验。文件内容是合法 JSON 但为标量/数组时（如 `null`、`5`、`"str"`）会原样存进 `#data`，之后 `get` 的 `key in null` 抛 `TypeError: Cannot use 'in' operator...`，`set` 抛 `Cannot set properties of null` / `Cannot create property ... on number`。即一个格式合法但类型不符的存储文件会让整个 store 在首次读写时崩溃。
- **依据**: 实测 `null -> get THROWS TypeError`、`5 -> get THROWS`、`"str" -> get THROWS`；`set` 对三者同样抛错；`[]` 时 `set('a')` 静默丢失（写入 `[]` 后 `keys()` 却报 `['a']`）。

## 发现 6
- **file**: src/store.js:53-55
- **类型**: data-consistency
- **严重性**: HIGH
- **问题**: 文件头注释声称「带原子写入：先写临时文件再 rename」，实现却是 `rmSync(原文件)` 后再 `writeFileSync`，既没有临时文件也没有 `rename`。写入过程中崩溃/断电/磁盘满 → 原文件已删、新文件未写全，全部数据丢失；且 `#persist` 是同步写，写一半失败会留下被截断的 JSON。注释与行为直接矛盾。
- **依据**: `#persist` 只 import 并调用了 `rmSync`/`writeFileSync`，全文无 `renameSync`/临时路径；第 53 行注释自己承认「先删原文件再写——中途失败会导致数据丢失」。这是注释声称 vs 实际行为的直接反例。

## 发现 7
- **file**: src/store.js:23-27
- **类型**: data-consistency
- **严重性**: HIGH
- **问题**: `#load` 对损坏/半写的 JSON 静默 `catch { return {} }`，不告警、不备份、不抛错。紧接着任意一次 `set` 都会把 `{}` + 新键整体覆盖回文件，原始（可能可修复的）数据被永久抹掉。输入：磁盘上有一个被截断的 `{"keep":1, BROKEN` → 加载为空对象 → 一次 set 后文件只剩新数据。
- **依据**: 实测写入 `{"keep":1, BROKEN` 后 `keys()` 为 `[]`，`set('new',2)` 后文件变为仅 `{"new":2}`，原 `keep` 数据消失。空 catch 在此并非安全语义（与 neg-catch 的刻意吞异常不同，这里造成不可逆数据丢失）。

## 发现 8
- **file**: src/queue.js:34
- **类型**: logic
- **严重性**: MEDIUM
- **问题**: 容量判断用 `this.#items.length > this.#capacity` 而非 `>=`，存在 off-by-one：容量为 N 的队列实际能塞进 N+1 个。输入 `capacity:2` 连续入队 3 个 → 第 3 个仍返回 `true`、`size` 变成 3，违反「队列满时返回 false」的契约。
- **依据**: 实测 `new TaskQueue({capacity:2})` 依次 enqueue a/b/c 全部返回 `true`，`size` 为 3。

## 发现 9
- **file**: src/queue.js:53、src/queue.js:65
- **类型**: data-consistency
- **严重性**: MEDIUM
- **问题**: `dequeue`/`peek` 选择时用 `this.#items[i].priority >= this.#items[bestIdx].priority`，相等时会把 `bestIdx` 更新为更靠后的元素，导致同优先级按 LIFO（后进先出）而非注释声称的 FIFO。输入同优先级的 a、b、c → 出队顺序为 c、b、a，`peek` 也返回 c 而非最先入队的 a。
- **依据**: 实测 enqueue first/second/third 后 `peek()` 返回 `third`，出队顺序 `['third','second','first']`；混合优先级 `a(1),b(5),c(5),d(0)` 得到 `c,b,a,d`（同为 5 的 b、c 逆序）。改用 `>` 即恢复 FIFO。

## 发现 10
- **file**: src/retry.js:15
- **类型**: logic
- **严重性**: MEDIUM
- **问题**: `backoffDelay` 文档写「attempt 从 1 开始，base * 2^(attempt-1)」，代码却是 `base * Math.pow(2, attempt)`，指数多 1，每次退避都是应有值的两倍。输入 `backoffDelay(1,{base:100})` 期望 100，实际 200；`attempt=2` 期望 200，实际 400。重试等待时间整体翻倍。
- **依据**: 实测输出 attempt1→200、attempt2→400。注释与表达式不一致。

## 发现 11
- **file**: src/retry.js:44（配合 src/index.js:34）
- **类型**: error-handling
- **严重性**: MEDIUM
- **问题**: `retry` 的 catch 块里调用 `backoffDelay(attempt,{base,maxDelay})`，而 `backoffDelay` 在 `maxDelay < base` 时抛 `RangeError`。`processTasks` 把 `maxDelay` 设为 `config.timeoutMs`、`base` 固定 50，因此只要用户配置 `TIMEOUT_MS < 50`，任何一次真实的 handler 失败都会被替换成 `RangeError: maxDelay must be >= base`——原始错误（`lastError`）被丢弃，调用方看到的错误与真实原因无关。
- **依据**: 实测 `retry(抛真实错误, {maxAttempts:3, base:50, maxDelay:10})` reject 的是 `RangeError maxDelay must be >= base`，真实错误信息消失。

## 发现 12
- **file**: src/index.js:34
- **类型**: contract
- **严重性**: MEDIUM
- **问题**: 配置项名为 `timeoutMs`（默认 30000），注释称其为「单次超时上限」，但代码中它只被当作 `retry` 的 `maxDelay`（退避上限）使用，从未对 handler 施加任何超时。输入一个永不 resolve 的 handler → `processTasks` 永久挂起，`timeoutMs` 完全不生效。对外承诺的超时语义未实现（ES module 中 `timeoutMs` 唯一使用点就是这里）。
- **依据**: 全仓 grep `timeoutMs` 仅出现在 config.js 的解析和 index.js:34 的 `maxDelay: config.timeoutMs`；没有任何 `Promise.race`/`AbortSignal`/定时器包裹 handler。第 34 行注释也自认「timeoutMs 是单次超时上限，不是退避上限」，恰好说明用法与命名/语义不符。

## 发现 13
- **file**: src/index.js:23
- **类型**: error-handling
- **严重性**: MEDIUM
- **问题**: `new TaskQueue({ capacity: tasks.length })` 在空批次时 capacity 为 0，而 `TaskQueue` 构造函数要求 capacity > 0 并抛 `TypeError: capacity must be a positive number`。因此合法输入 `processTasks([], {handler})` 直接抛错，而不是返回空结果。
- **依据**: 实测 `processTasks([], {handler})` 抛 `TypeError capacity must be a positive number`；queue.js:9-11 明确对 `capacity <= 0` 抛错。

## 发现 14
- **file**: src/store.js:31、src/store.js:35
- **类型**: security
- **严重性**: MEDIUM
- **问题**: `get` 用 `key in this.#data` 判断存在性，会沿原型链命中 `Object.prototype` 上的键，导致从未写入的 `toString`/`constructor`/`hasOwnProperty` 等返回函数而非 `undefined`。`set('__proto__', v)` 走的是 `this.#data['__proto__'] = v`，改写的是对象原型而非自有属性：数据既不会被 `keys()` 看到，`JSON.stringify` 也输出 `{}`，随后 `get()` 却能读到污染后的值——数据静默丢失且污染 store 实例。
- **依据**: 实测 `get('toString')` 返回 `function`；`set('__proto__',{polluted:true})` 后 `keys()` 为 `[]`、落盘内容为 `{}`，而 `get('polluted')` 返回 `true`。`delete` 用了 `hasOwnProperty` 而 `get`/`set` 没用，同一文件内不一致。

## 发现 15
- **file**: src/queue.js:80-86
- **类型**: contract
- **严重性**: LOW
- **问题**: `clear()` 的 JSDoc 声明 `@returns {boolean} 总是 true`，函数体却没有任何 `return`，实际恒返回 `undefined`。调用方按文档写 `if (queue.clear())` 会永远走假分支。
- **依据**: 实测 `q.clear()` 返回 `undefined`，而注释写「返回是否清空成功 / @returns {boolean} 总是 true」。

---

## 未报告项（刻意判定为无缺陷，避免误报）
- `src/neg-catch.js`：三处空 `catch` 均为刻意吞异常且语义正确（`tryRemoveTemp`/`tryParseJson` 用返回值区分结果，`safeClose` 重复关闭属预期）。`tryParseJson('null')` 返回 `null` 与注释所述一致，不构成缺陷。
- `src/neg-race.js`：`increment`/`incrementAsync` 的读-改-写均在 `await` 之前完成，`batchIncrement` 并发调用不会丢计数，单线程下无竞态。（注：注释提到的 `test-base.mjs` 在目录中不存在，但不影响本文件逻辑正确性，故不作为缺陷上报。）
- `src/neg-unused.js`：`ERROR_CODES`/`VERSION`/`normalizeError`/`isValidTask` 为公共 API，本仓库无内部引用属正常，不是死代码。
