# G-report — 代码审计结果

审计对象：`<HOME>\AppData\Local\Temp\iso-a\code\`（9 个 js 文件 + package.json，约 470 行）
运行时验证脚本位于 `%TEMP%\audit-a\probe*.mjs`，只读审计，未修改任何被审计文件。

---

## 发现 1
- **file**: src/worker-pool.js:19
- **原文**:
```js
async function worker() {
  while (true) {
    const idx = cursor;          // 19: 读 cursor
    await Promise.resolve();     // 20: await 在“读”和“写”之间
    cursor += 1;                 // 21: 写回 cursor
    if (idx >= tasks.length) return;
```
- **类型**: concurrency
- **严重性**: CRITICAL
- **问题**: 读-改-写之间夹了 `await`。JS 单线程下 `const idx = cursor` 之后立即让出，所有 worker 都读到同一个 `cursor`，随后都把它 +1（相互覆盖）。结果：同一个索引被并发领取多次（任务被重复执行），大量任务永远不会执行，且 `results` 数组留洞，调用方读取时 `undefined.ok` 崩溃。这直接违背文件头注释「以固定并发度跑一组异步任务」。触发条件就是任何 `concurrency >= 2` 且 `tasks.length > concurrency` 的普通调用。
- **运行证据**:
  - 命令：`node probe7.mjs`（8 个任务，concurrency=4）
  - 期望：8 个任务各执行一次，`results` 为 8 个 `{ok,...}`，无空洞。
  - 实际：`ran = [0, 4]`、`NEVER RAN = [1,2,3,5,6,7]`、`duplicate idx claims = 6`、`holes at = [1,2,3,5,6,7]`、`results[1].ok THREW: TypeError: Cannot read properties of undefined (reading 'ok')`。
  - 对照用例（同模块、concurrency=1）：`node probe3.mjs` → `invocations = 4 values = [0,1,2,3]`，`results` 完整无洞 —— 证明探针有效，且缺陷只在并发>1 时暴露。

## 发现 2
- **file**: src/index.js:28
- **原文**:
```js
  const queue = new TaskQueue({ capacity: tasks.length });
  for (const t of tasks) {
    queue.enqueue(t);
  }
  // 假设队列持有的是独立副本，下面清空原数组不会影响队列
  tasks.length = 0;                                 // 28

  const raw = await runWithConcurrency(tasks, config.concurrency, (task) =>  // 30: 传的是已清空的 tasks
```
- **类型**: logic
- **严重性**: CRITICAL
- **问题**: `tasks.length = 0` 把调用方传入的数组原地清空，随后第 30 行把**同一个已被清空的数组**传给 `runWithConcurrency`。队列里虽已入队，但再也不被使用。结果：`processTasks` 对任何非空输入都静默返回 `[]`，handler 一次都不执行；同时**篡改了调用方的数组**（副作用）。这是对外主入口，正常用法即命中。第 27 行注释「假设队列持有的是独立副本」是错误假设——`enqueue` 里 `{...task}` 只复制了单个任务对象，`tasks` 数组本身并未复制。
- **运行证据**:
  - 命令：`node probe9.mjs`
  - 期望：3 个任务 → 返回 3 个结果，handler 调用 3 次，调用方数组长度仍为 3。
  - 实际：`processTasks returned: [] (expected 3 entries)`、`handler calls: 0 (expected 3)`、`caller array length after processTasks: 0 (expected 2)`。
  - 对照：手动复现中间态显示 `queue.size BEFORE tasks.length=0: 3`、`queue.size AFTER: 2`（队列数据完好但被弃用），证明丢失发生在数组清空而非入队。

## 发现 3
- **file**: src/queue.js:34
- **原文**:
```js
    if (this.#items.length > this.#capacity) {
      return false;
    }
```
- **类型**: data-consistency
- **严重性**: HIGH
- **问题**: 容量判断用了 `>` 而不是 `>=`。当队列已有 `capacity` 个元素时仍返回 `true` 并再入队一个，实际容量变成 `capacity + 1`。依赖返回值做背压的调用方会多放一个任务，且 `size` 可超过声明的 `capacity`，破坏容量上界这条硬约定。
- **运行证据**:
  - 命令：`node probe1.mjs`
  - 期望：`capacity=2` 时第 3 次 `enqueue` 返回 `false`，`size` 保持 2。
  - 实际：`enqueue#3 (expected false) => true`、`size (expected 2) => 3`。
  - 边界复核：`capacity=3` 时第 4 次入队 `=> true size 4`。
  - 对照：非法输入校验正常 —— `capacity 0` / 空 `id` 均按期望抛出 `TypeError`，说明缺陷仅在边界判断的运算符。

## 发现 4
- **file**: src/queue.js:53
- **原文**:
```js
      if (this.#items[i].priority >= this.#items[bestIdx].priority) {
        bestIdx = i;
      }
```
- **类型**: contract
- **严重性**: MEDIUM
- **问题**: 注释（第 46-48 行 dequeue、第 60 行 peek）明确声称「同优先级按 FIFO」，但并列比较用 `>=`，导致后面的元素持续覆盖 `bestIdx`，同优先级实际变成 **LIFO**（后入先出）。`peek` 与 `dequeue` 同样错误（第 65 行同源），调用方按文档预期取「最先入队」会拿到反序。
- **运行证据**:
  - 命令：`node probe1.mjs`
  - 期望：入队 first/second/third（同 priority=5）→ `peek()` 为 `first`，出队顺序 `first,second,third`。
  - 实际：`peek ... => "third"`、`dequeue order => ["third","second","first"]`。
  - 对照（同函数、不同优先级）：`priority order control (expect high,mid,low) => ["high","mid","low"]` —— 主排序正确，缺陷仅在并列分支。

## 发现 5
- **file**: src/store.js:53
- **原文**:
```js
  #persist() {
    const dir = dirname(this.#path);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    // 先删原文件再写——中途失败会导致数据丢失
    if (existsSync(this.#path)) rmSync(this.#path);
    writeFileSync(this.#path, JSON.stringify(this.#data, null, 2), 'utf8');
  }
```
- **类型**: data-consistency
- **严重性**: HIGH
- **问题**: 文件头注释（第 2-3 行）声称「带原子写入：先写临时文件再 rename，避免半写状态」，实际实现相反：先 `rmSync` 删除原文件，再 `writeFileSync` 直接覆盖。若 `JSON.stringify` 抛错（循环引用）或写入中途失败，原文件已被删除，**历史数据永久丢失**。注释自己第 53 行也承认「中途失败会导致数据丢失」，与文件头「原子写入」自相矛盾。
- **运行证据**:
  - 命令：`node probe8.mjs`
  - 期望：写入失败时旧文件 `{"keep":"IMPORTANT"}` 仍在（原子语义）。
  - 实际：`set(circular) threw: TypeError: Converting circular structure to JSON` 之后 `file AFTER failed set: <FILE GONE>`、`existsSync after failed set: false`、`reload keys after failed set => []`。旧值彻底丢失。
  - 反证「无临时文件」：`probe5.mjs` → `no tmp file`（不存在 `.tmp` 兄弟文件，证明并非 temp+rename）。

## 发现 6
- **file**: src/store.js:31
- **原文**:
```js
  get(key) {
    return (key in this.#data) ? this.#data[key] : undefined;
  }
```
- **类型**: data-consistency
- **严重性**: MEDIUM
- **问题**: 用 `in` 会沿原型链查找，而 `delete`（第 40 行）用 `hasOwnProperty`。二者不对称：`get('toString')` 返回内置函数而非 `undefined`，`get('__proto__')` 返回原型对象；但 `delete('toString')` 返回 `false`，调用方永远删不掉、也分不清「真实存了这个 key」与「命中了 Object.prototype」。`keys()` 只列自有键，与 `get` 的可见性进一步不一致。
- **运行证据**:
  - 命令：`node probe8.mjs` / `node probe5.mjs`
  - 期望：未存过的 `toString`/`__proto__` 经 `get` 返回 `undefined`。
  - 实际：`get('toString') ... => "function"`、`get('__proto__') ... => {}`、`constructor => "function"`；对照 `delete("toString") => false`（`hasOwnProperty` 路径判定不存在）。
  - 对照：真实键工作正常 —— `probe5.mjs` 中 `get a => 1`、`get missing => undefined`，说明缺陷只在原型链键名。

## 发现 7
- **file**: src/retry.js:15
- **原文**:
```js
  const exponential = base * Math.pow(2, attempt);
```
- **类型**: logic
- **严重性**: MEDIUM
- **问题**: 注释（第 5-6 行）声称 `base * 2^(attempt-1)`，实际实现是 `base * 2^attempt`，首次退避就比文档大 2 倍并逐次放大。所有重试时序等比放大一倍，对依赖退避时长的容量规划是错的（attempt=1 期望 100ms 实得 200ms）。
- **运行证据**:
  - 命令：`node probe2.mjs`
  - 期望 vs 实际：`backoffDelay(1,{base:100,maxDelay:30000}) => 200`（doc-expected `100`）、`(2) => 400`（期望 200）、`(3) => 800`（期望 400）、`(4) => 1600`（期望 800）。
  - 对照：上限夹取正确 —— `backoffDelay(10,{base:100,maxDelay:1000}) => 1000`，说明 `Math.min(safe, maxDelay)` 逻辑无误，缺陷仅在指数项。

## 发现 8
- **file**: src/retry.js:32
- **原文**:
```js
  if (!Number.isInteger(maxAttempts)) {
    throw new RangeError('maxAttempts must be an integer');
  }

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) { ... }
  throw lastError;
```
- **类型**: error-handling
- **严重性**: MEDIUM
- **问题**: 只校验「是整数」，未校验「> 0」。`maxAttempts = 0` 或负数时 `for` 循环一次都不执行，`lastError` 仍是 `undefined`，最后 `throw lastError` **抛出 `undefined`**——不是 Error 对象。调用方 `catch (e)` 后 `e.message`/`e.stack` 全部崩溃或丢失，错误信息完全蒸发。
- **运行证据**:
  - 命令：`node probe2.mjs` 及 `node -e`（专用验证）
  - 期望：非法 `maxAttempts` 应抛 `RangeError`。
  - 实际：`maxAttempts=0 threw => "undefined (not an Error!)"`；专项验证 `typeof e = undefined | e instanceof Error = false | String(e) = undefined | e === undefined = true`；`maxAttempts=-1 threw => "undefined (not an Error!)"`。
  - 对照：`maxAttempts=1.5` 被正确拒绝 —— `RangeError: maxAttempts must be an integer`；正常路径 `ok@3`、耗尽路径抛最后一次错误 `always2` 均正确，说明缺陷只在「整数但非正」这一区间。

## 发现 9
- **file**: src/config.js:13
- **原文**:
```js
function parsePositiveInt(raw, name) {
  if (raw === undefined || raw === '') return DEFAULTS[name];
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new TypeError(`${name} must be a positive integer, got: ${raw}`);
  }
  return n;
}
```
- **类型**: logic
- **严重性**: MEDIUM
- **问题**: 函数名与报错文案都声称「positive integer」，但只检查 `Number.isInteger`，`0` 和负数被原样放行。`CONCURRENCY=0` 会在下游 `runWithConcurrency` 触发 `RangeError`；`RETRY_MAX=-1` 会在下游 `retry` 走到发现 8 的 `throw undefined`。另外纯空白 `'   '` 经 `Number` 变成 `0` 也被当作合法输入，属于隐蔽误配。
- **运行证据**:
  - 命令：`node probe4.mjs`
  - 期望：0 / 负数应抛 `TypeError`（与文案一致）。
  - 实际：`CONCURRENCY='0' => {"concurrency":0,...}`、`CONCURRENCY='-3' => {"concurrency":-3,...}`、`CONCURRENCY='   ' (blank -> 0?) => {"concurrency":0,...}`、`RETRY_MAX='-1' => {"retryMax":-1,...}`。
  - 对照：真正非数字仍按期望拒绝 —— `CONCURRENCY='abc' => TypeError: concurrency must be a positive integer, got: abc`；`LOG_LEVEL='warn' => TypeError`，说明探针能区分合法/非法，缺陷只在数值边界。

## 发现 10
- **file**: src/store.js:19
- **原文**:
```js
  #load() {
    if (!existsSync(this.#path)) return {};
    const raw = readFileSync(this.#path, 'utf8');
    if (raw.trim() === '') return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
```
- **类型**: error-handling
- **严重性**: MEDIUM
- **问题**: 只处理了「空文件 / 损坏 JSON」，未校验解析结果必须是普通对象。文件内容为 `null` 时构造直接崩溃（`null` 上传给 `Object.keys`/`in`）；内容为 `5` 或 `true` 时构造成功但后续 `get`/`set` 抛 `TypeError`（`Cannot use 'in' operator` / `Cannot create property`）。即持久化文件被外部或旧版本写成非对象根时，`JsonStore` 无法自愈，而相邻的损坏 JSON 场景却会静默重置——错误处理不一致。
- **运行证据**:
  - 命令：`node probe11.mjs`
  - 期望：非对象根应按损坏文件同样降级为 `{}`。
  - 实际：`root=null` → `construct threw: TypeError: Cannot convert undefined or null to object`；`root=5` → `get threw: TypeError: Cannot use 'in' operator to search for 'x' in 5`、`set threw: Cannot create property 'x' on number '5'`；`root=true` 同理。
  - 对照：真正损坏的 JSON 正常降级 —— `probe5.mjs`：`corrupt-file keys (silently reset) => []`，证明缺陷只在「合法 JSON 但非对象」。

## 发现 11
- **file**: src/index.js:23
- **原文**:
```js
  const queue = new TaskQueue({ capacity: tasks.length });
```
- **类型**: contract
- **严重性**: MEDIUM
- **问题**: 用 `tasks.length` 直接当容量。当调用方传入空数组（合法且常见，例如「本批无任务」）时 `capacity = 0`，而 `TaskQueue` 构造函数要求 `capacity > 0`，直接抛 `TypeError`。空输入本应返回 `[]`，实际变成崩溃，且错误信息 `capacity must be a positive number` 与真实原因（空任务列表）无关，误导排查。
- **运行证据**:
  - 命令：`node probe4.mjs` / `node probe9.mjs`
  - 期望：`processTasks([])` 返回 `[]`。
  - 实际：`processTasks([]) threw => "TypeError: capacity must be a positive number"`。
  - 对照：非空输入不会在此处抛错（缺陷 2 才让它返回空），`runWithConcurrency([], 3, ...)` 本身正确返回 `[]` —— 证明崩溃来自 `new TaskQueue` 这一行而非并发执行器。

## 发现 12
- **file**: src/neg-catch.js:32
- **原文**:
```js
/**
 * 尝试解析 JSON，失败返回 null。
 * 空 catch 是刻意的：调用方用 `=== null` 明确区分「解析失败」和「解析成功但值是 null」
 * （后者在这里不可能出现，因为 JSON.parse 永远不会返回 null）。
 */
export function tryParseJson(text) {
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
```
- **类型**: contract
- **严重性**: LOW
- **问题**: 注释的核心论据「`JSON.parse` 永远不会返回 null」与事实相反——`JSON.parse('null')` 合法且返回 `null`。因此注释承诺的「用 `=== null` 区分解析失败与 JSON null」不成立：输入字符串 `'null'` 与输入 `'nul'`（解析失败）返回值完全相同，调用方无法区分。该空 catch 本身语义尚可，但这段 API 契约是错的。
- **运行证据**:
  - 命令：`node probe6.mjs`
  - 期望：`tryParseJson('null')` 与解析失败可区分（例如前者返回 `null` 值但可标记成功）。
  - 实际：`tryParseJson('null') => null`，`tryParseJson('nul') => null`，`JSON.parse('null') === null ? true`，`=> both return null: ... true`（不可区分）。
  - 对照：正常解析与非法类型路径无误 —— `tryParseJson('{"a":1}') => {"a":1}`、`tryParseJson(123) => null`，说明缺陷仅在「合法 JSON 字面量 null」这一项。

---

## 未报告的项（已运行验证，确认无缺陷——用于排除误报）

- **src/neg-race.js**：`Counter.increment` 的 `this.#value = this.#value + 1` 确为同 tick 原子操作；`batchIncrement(counter, 1000)` 实测最终值 `1000`，`batchIncrement(0) => 0`，`-1`/`1.5` 正确抛 `RangeError`。无竞态。
- **src/neg-unused.js**：`ERROR_CODES`（已 `Object.freeze`）、`VERSION`、`normalizeError`、`isValidTask` 均为公共 API，`normalizeError(new Error('boom'))`、`isValidTask({id:''}) => false` 等行为正确。非死代码。
- **src/neg-catch.js 的 `tryRemoveTemp` / `safeClose`**：空 catch 语义正确，实测 `tryRemoveTemp` 对不存在/存在/已删分别返回 `false/true/false`，`safeClose` 对 `null`/重复关闭/正常句柄返回 `false/false/true`。
- **src/queue.js 的 `clear()`**：文档 `@returns {boolean} 总是 true` 但实际返回 `undefined`——属注释瑕疵，不影响调用方逻辑（无人依赖返回值），按「宁可少报」未单列为缺陷。
- **src/index.js:34 的 `maxDelay: config.timeoutMs`**：确为语义误用（已实测 `backoffDelay(1,{base:50,maxDelay:10})` 会抛 `RangeError`），但当前被发现 2 屏蔽（`runWithConcurrency` 收到空数组，`retry` 永不被调用），不是可独立触发的运行时缺陷，故不单列。
