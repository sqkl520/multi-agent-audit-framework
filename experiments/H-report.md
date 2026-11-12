# H-report — iso-a/code 代码审计

审计对象：`<HOME>\AppData\Local\Temp\iso-a\code\`（9 个文件，471 行，全部通读）
审计方式：逐行阅读 + 对每个可疑点写脚本实跑（Node v26.12.1）。下列每条结论都有对应的可复现输出支撑。

先说结论范围：`src/neg-race.js`、`src/neg-unused.js` 经实跑确认**确实无缺陷**（详见文末「已排除的疑似项」），未对其报错。`src/neg-catch.js` 有 1 处注释事实性错误（LOW）。其余缺陷集中在 `worker-pool.js` / `index.js` / `queue.js` / `retry.js` / `config.js` / `store.js`。

---

## 发现 1
- **file**: src/worker-pool.js:19-22
- **原文**:
```js
      const idx = cursor;
      await Promise.resolve();
      cursor += 1;
      if (idx >= tasks.length) return;
```
- **类型**: concurrency
- **严重性**: CRITICAL
- **问题**: `idx` 在 `await` **之前**读取，`cursor += 1` 在 `await` **之后**执行。N 个 worker 同时启动时，全部先读到同一个 `cursor`（0），全被 `await Promise.resolve()` 挂起；微任务恢复后各自把 `cursor` 加 1 并执行**同一个 idx**。后果是三重的：同一任务被并发执行 N 次（副作用重复：扣款、发消息、写文件都会重复）、`tasks[1..N-1]` 永远不被执行、`results` 对应槽位保持 `undefined`（稀疏数组，不是 `{ok:false}`）。实跑（8 个任务、concurrency=4）：执行序列 `0,0,0,0,4,5,6,7`，任务 1/2/3 被静默跳过，`results` 的 1/2/3 位为空洞。concurrency > tasks.length 时更极端：2 个任务 + concurrency=4 → 任务 0 跑 4 次，任务 1 一次都没跑。
- **依据**: `await` 把读 `cursor` 与写 `cursor` 切成两个 tick，破坏了「取号」的原子性；这是本文件唯一一处 `await`，直接造成竞态。实测 `concurrency=1` 时结果完全正确（`[0,1,2]`），说明缺陷只在并发度 > 1 且任务数 > 1 时触发。修复方式是把 `cursor += 1` 移到 `await` 之前（或用 `tasks[idx]` 取号后再让出）。

## 发现 2
- **file**: src/index.js:28（配合 23、30）
- **原文**:
```js
  const queue = new TaskQueue({ capacity: tasks.length });
  for (const t of tasks) {
    queue.enqueue(t);
  }
  // 假设队列持有的是独立副本，下面清空原数组不会影响队列
  tasks.length = 0;

  const raw = await runWithConcurrency(tasks, config.concurrency, (task) =>
```
- **类型**: logic
- **严重性**: CRITICAL
- **问题**: 任务被塞进 `queue` 之后，代码把**原数组** `tasks` 清空，然后把**已被清空的 `tasks`**（不是 `queue`）传给 `runWithConcurrency`。`queue` 从头到尾没有被 `dequeue`，是一个纯摆设。结果是 `processTasks` 对任何非空输入都**一个 handler 都不执行**，静默返回 `[]`。实跑：3 个任务 `{id:'a'|'b'|'c'}`，handler 内的 `console.log` 一次都没打印，返回 `[]`，调用方的 `tasks` 变成 `[]`（长度 0，原数组被就地篡改）。注释「假设队列持有的是独立副本」在「副本」这一点上是对的（`enqueue` 确实 `{...task}` 拷贝），但它误以为后续消费的是队列；真正被消费的是被清空的原数组，所以这个假设救不了它。更糟的是它**没有任何报错**——批量任务「全部丢失」与「本来就没有任务」返回值完全相同。
- **依据**: `TaskQueue.enqueue` 内部 `this.#items.push({...task, ...})` 是拷贝，但 `index.js` 从未调用 `queue.dequeue()` / 从未读取 `queue.size`；`runWithConcurrency` 的入参是 `tasks`。实跑确认 handler 零调用。附带影响：`return raw`（第 38 行）因此恒为 `[]`，任务失败的 `{ok:false}` 信息也无从产生，调用方无法区分「全失败」和「没任务」。

## 发现 3
- **file**: src/index.js:23
- **原文**:
```js
  const queue = new TaskQueue({ capacity: tasks.length });
```
- **类型**: error-handling
- **严重性**: HIGH
- **问题**: 用 `tasks.length` 当容量，空批次时 `capacity === 0`，而 `TaskQueue` 构造函数对 `capacity <= 0` 直接 `throw new TypeError('capacity must be a positive number')`。所以 `processTasks([], {handler})` 不是「无事可做返回 `[]`」，而是**抛异常**。空批次是完全合法的调用（上游过滤后可能为空），调用方必须额外包 try/catch 才能避免批量任务因「这批没数据」而整体失败。实跑：`processTasks([], ...)` → `TypeError: capacity must be a positive number`。
- **依据**: `queue.js:9` 的守卫 `if (typeof capacity !== 'number' || capacity <= 0) throw`；`tasks.length` 为 0 时必然命中。此外 `capacity = tasks.length` 这个设计本身也没意义——队列装满时 `enqueue` 返回 `false`，而循环里 `queue.enqueue(t)` 的返回值被丢弃，满了也不会报错（幸好此处 capacity 恰等于任务数，见发现 4 的 off-by-one 才「没满」）。

## 发现 4
- **file**: src/queue.js:34
- **原文**:
```js
    if (this.#items.length > this.#capacity) {
      return false;
    }
```
- **类型**: logic
- **严重性**: HIGH
- **问题**: 容量判断用了 `>` 而不是 `>=`，off-by-one：队列实际可容纳 `capacity + 1` 个元素。`capacity = 3` 时前 4 次 `enqueue` 全部返回 `true`，第 5 次才返回 `false`。实跑：`capacity=3`，连续入队 6 次 → 返回值 `[true,true,true,true,false,false]`，`size` 最终为 4。对任何依赖「容量上限」做背压/内存保护的上游（例如用 `enqueue` 的 `false` 来暂停生产者）来说，上限被系统性突破一格；当 `capacity` 很小（1 或 2）时这是 100% / 50% 的偏差。
- **依据**: 边界条件应为「已满」时拒绝，即 `length >= capacity`。实测 `TaskQueue({capacity:2})` 入队 3 个全部成功、`size === 3`。

## 发现 5
- **file**: src/queue.js:53（peek 在 65 行同病）
- **原文**:
```js
      if (this.#items[i].priority >= this.#items[bestIdx].priority) {
        bestIdx = i;
      }
```
- **类型**: logic
- **严重性**: HIGH
- **问题**: 用 `>=` 比较，遇到同优先级时会不断把 `bestIdx` 更新为**更靠后**的元素，于是同优先级变成 LIFO（后进先出），与文档承诺的 FIFO 相反。函数注释（46-47 行）明确写「同优先级按 FIFO」，`peek()` 的注释（60 行）更明确写「同优先级时返回最先入队的」。实跑：依次入队 `a,b,c`（priority 均为 5），出队顺序是 `c,b,a`；`peek()` 返回 `c` 而最先入队的是 `a`。对任务队列而言这会造成**同优先级任务饥饿**：持续有新任务入队时，早入队的永远排在后面。
- **依据**: 稳定选择应为「严格大于才替换」（`>`），这样同优先级保留最早出现的下标。注意 `remove`/`clear` 本身没问题，问题只在比较运算符。另：`dequeue` 与 `peek` 用了同一段错误逻辑，所以二者至少是自洽的（peek 看到的就是 dequeue 会拿到的），缺陷是共同偏离文档契约。

## 发现 6
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
- **严重性**: MEDIUM
- **问题**: 文档与 JSDoc 双重承诺返回 `boolean`（且「总是 true」），实现里没有 `return`，实际返回 `undefined`。实跑：`new TaskQueue().clear()` → `undefined`。任何写 `if (!queue.clear()) { ... }` 或 `assert.strictEqual(q.clear(), true)` 的调用方都会走进错误分支/测试失败——尤其 `!undefined === true`，语义正好反了。
- **依据**: 函数体只有一句赋值语句，无 return。修复只需加 `return true;`（或在清空前 `return this.#items.length > 0`）。

## 发现 7
- **file**: src/retry.js:15
- **原文**:
```js
  const exponential = base * Math.pow(2, attempt);
```
- **类型**: logic
- **严重性**: MEDIUM
- **问题**: 文档（5-6 行）写的是 `base * 2^(attempt-1)`，attempt 从 1 开始，即第一次重试应等 `base`。实现用的是 `2^attempt`，整体翻倍：第一次等 `2*base`，第二次 `4*base`，第三次 `8*base`。实跑：`backoffDelay(1,{base:100})` 返回 `200`（文档期望 100），`backoffDelay(2)` 返回 `400`（期望 200），`backoffDelay(3)` 返回 `800`（期望 400）。退化场景：`base=50` 且 `maxDelay=100` 时，文档预期是 50/100/100 的渐进退避，实际是 100/100/100——第一次重试就顶到上限，退避曲线直接失效。该函数是公开导出（`index.js` 重导出），使用方按其文档计算等待时间会对不上。
- **依据**: 指数应为 `Math.pow(2, attempt - 1)`。与上游 `index.js:34` 的 `base: 50` 叠加后，真实首次等待是 100ms 而非注释暗示的 50ms。

## 发现 8
- **file**: src/retry.js:32-35, 47
- **原文**:
```js
  if (!Number.isInteger(maxAttempts)) {
    throw new RangeError('maxAttempts must be an integer');
  }

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
```
```js
  throw lastError;
```
- **类型**: error-handling
- **严重性**: HIGH
- **问题**: 校验只保证 `maxAttempts` 是整数，没保证 `> 0`。当 `maxAttempts = 0`（或负数）时 `for` 循环体一次都不进，`lastError` 保持 `undefined`，最终 `throw undefined`。调用方 `catch (e)` 拿到的是 `undefined`：`e.message` 直接二次抛 `TypeError`，`e instanceof Error` 为 false，错误上报/日志全部失真。实跑：`retry(fn, {maxAttempts:0})` 的 rejection 值为 `undefined`（`typeof e === 'undefined'`）。这条**不是理论值**：`config.js` 允许 `RETRY_MAX=0`（见发现 9），而 `index.js:32` 直接 `maxAttempts: config.retryMax` 透传，所以运维设 `RETRY_MAX=0` 就会让所有任务以 `undefined` 失败、原始错误信息全丢。
- **依据**: 实测 `maxAttempts:0` 与 `maxAttempts:-1` 均为 `throw undefined`。校验应补 `maxAttempts < 1`，并在循环外先判空。

## 发现 9
- **file**: src/config.js:13-19
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
- **类型**: contract
- **严重性**: HIGH
- **问题**: 函数名、报错文案都声称「positive integer」，但只校验了 `Number.isInteger`，**没有校验 `> 0`**。`CONCURRENCY=0` / `CONCURRENCY=-5` / `TIMEOUT_MS=0` / `RETRY_MAX=0` 全部被当作合法配置放行。实跑：`loadConfig({CONCURRENCY:'0'})` → `{concurrency: 0, ...}`；`CONCURRENCY:'-5'` → `{-5}`；`RETRY_MAX:'0'` → `{retryMax: 0}`。下游后果分三路：(a) `concurrency=0` 传给 `runWithConcurrency` 会被 `concurrency < 1` 判为非法并抛 `RangeError`，即配置校验过了、运行时才炸；(b) `retryMax=0` 触发发现 8 的 `throw undefined`；(c) `timeoutMs=0` 会让 `index.js:34` 的 `maxDelay: 0` 与 `base: 50` 冲突，`backoffDelay` 抛 `maxDelay must be >= base`。配置层「信任边界」失效，把三类错误推迟到更难定位的位置。
- **依据**: 实测四个非法值均未抛错。判定应与 `worker-pool.js:9` / `queue.js:9` 保持一致（`n < 1` 即拒）。注意 1.5、'abc' 是正确拒绝的，说明只漏了「正」这一半。

## 发现 10
- **file**: src/store.js:50-56
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
- **问题**: 文件头注释（第 2 行）声称「带原子写入：先写临时文件再 rename，避免半写状态」，实现对**完全相反**：先 `rmSync` 删除原文件、再原地 `writeFileSync`。这既不是原子写，也不是「先写临时文件再 rename」。后果：在 `rmSync` 与 `writeFileSync` 之间进程被杀/断电/磁盘满，原有数据**已删除且新数据未落盘**——文件消失，不是「旧的或新的」二选一而是「两边都没有」。即使正常返回，`writeFileSync` 写完也可能停留在页缓存，非原子替换在崩溃时产生半写 JSON，而 `#load` 的 catch（发现 11）会把这个半写文件当作空库。第 53 行的注释自己承认了「中途失败会导致数据丢失」，但代码没有做任何改善，等于把已知问题留在实现里。多进程/多实例下更严重：两个 `JsonStore` 各自持有内存快照，A 写 `{a:1}`、B 写 `{b:2}`，后写者整个覆盖前者（实跑：文件最终只剩 `{"b": 2}`，`a` 丢失），`rm + write` 放大了这个丢失窗口。
- **依据**: 完全没有 `writeFileSync(tmp)` + `renameSync(tmp, path)` 的痕迹，也没有 `fsync`。实测双实例写入确认丢更新。

## 发现 11
- **file**: src/store.js:23-27（`get` 在 31 行）
- **原文**:
```js
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
```
```js
    return (key in this.#data) ? this.#data[key] : undefined;
```
- **类型**: data-consistency
- **严重性**: HIGH
- **问题**: 解析失败被**静默降级为空对象**，且没有任何告警/备份。于是任何一次损坏（半写、手工编辑出错、磁盘位翻转）都会被读成「空库」；紧接着的第一次 `set()` 会以空库为基底 `#persist()`，把原本可能还能人工抢救的损坏文件**彻底覆盖**。实跑：文件内容 `{"important":"data"`（缺右括号）→ `keys()` 为 `[]`、`get('important')` 为 `undefined`；一次 `set('x',1)` 后文件变成 `{"x":1}`，原 `important` 永久消失。第二类问题：`#load` 只挡了「空字符串」，没挡「合法但非对象的 JSON」。文件内容是 `null` 时 `get()` 抛 `TypeError: Cannot use 'in' operator to search for 'a' in null`；内容是 `"hello"` / `42` 时 `set()` 抛 `TypeError: Cannot create property ... on string`。即一个被截断成 `null` 的合法 JSON 会让 store 在**构造之后的第一次访问**才爆炸，且是未捕获的 TypeError 而非可读的配置错误。
- **依据**: 两条实跑均复现（损坏文件静默清空 + `null`/数字根导致 TypeError）。`#load` 应校验 `parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)`，并在解析失败时抛错或备份后重建。

## 发现 12
- **file**: src/store.js:31（`delete` 在 40 行）
- **原文**:
```js
    return (key in this.#data) ? this.#data[key] : undefined;
```
```js
    if (!Object.prototype.hasOwnProperty.call(this.#data, key)) return false;
```
- **类型**: data-consistency
- **严重性**: MEDIUM
- **问题**: `get` 用 `in` 运算符，会沿原型链查找，因此 `get('toString')` / `get('constructor')` / `get('hasOwnProperty')` 返回的是 `Object.prototype` 上的**函数**而不是 `undefined`。调用方「先 get 判断存在性、再决定是否初始化」的常规写法会拿到一个函数并当成有效值使用（例如当成配置对象去读字段）。与之矛盾的是 `delete()` 用 `hasOwnProperty`，`keys()` 用 `Object.keys`——三者对「是否存在」的判定口径不一致：`get('toString') !== undefined` 但 `delete('toString') === false`。更严重的第二个面：`set('__proto__', obj)` 不存键值，而是**改写实例的原型**。实跑：`set('__proto__',{polluted:true})` 后 `keys()` 为 `[]`（键消失了）、`delete('__proto__')` 返回 `false`（删不掉）、但 `get('__proto__')` 返回 `{polluted:true}`（读得到），持久化文件里是 `{}`。同一个键 set 得到、delete 删不掉、keys 看不到、重启后丢失——四种行为互相矛盾。若 key 来自外部输入，`__proto__` / `constructor` 还会造成原型污染或读伪造值。
- **依据**: 实跑确认 `typeof get('toString') === 'function'`、`keys()` 不含 `__proto__`、`delete('__proto__') === false`。应改用 `Object.prototype.hasOwnProperty.call` 统一判定；如需避免原型键，`#data` 应用 `Object.create(null)` 或 `Map`。

## 发现 13
- **file**: src/index.js:34（`timeoutMs` 全仓无实现）
- **原文**:
```js
      maxDelay: config.timeoutMs,   // timeoutMs 是单次超时上限，不是退避上限
```
- **类型**: contract
- **严重性**: HIGH
- **问题**: 这里把 `timeoutMs` 当作**退避上限**传给了重试器，注释却又声明它「是单次超时上限，不是退避上限」——注释与代码直接对立。全仓 grep `setTimeout|AbortSignal|race` 只命中 `retry.js` 的 sleep 与 `neg-race.js` 的测试用 sleep：**没有任何地方为 handler 施加超时**。实跑：一个耗时 60ms 的 handler 在 `maxAttempts:1` 下完整跑完 68ms，没有任何中断。也就是说配置里的 `TIMEOUT_MS`（默认 30000）是一个从不生效的死配置：一个卡死的 handler 会让 `processTasks` 永远 pending，重试逻辑也救不了。反过来，该参数被误接到 `maxDelay` 后产生了真实故障：`retry` 内部 `if (maxDelay < base) throw RangeError`，而 `index.js` 硬编码 `base: 50`，所以只要 `TIMEOUT_MS` 配成 1..49（一个完全合理的短超时），每次重试都会抛 `RangeError: maxDelay must be >= base` 而根本不执行 handler。实跑：`retry(fn,{maxAttempts:3,base:50,maxDelay:10})` → `RangeError: maxDelay must be >= base`。（注：当前这条路径被发现 2 的「任务数为 0」掩盖，只有直接使用导出的 `retry`、或修好发现 2 之后才会暴露；但配置本身合法且 `retry` 是公开导出，所以是真缺陷。）
- **依据**: `grep -rn "timeout|setTimeout|AbortSignal|race" src/` 无任何超时实施；配置项与使用点的语义错配，外加 `base` 与 `maxDelay` 的约束未被 `config.js` 交叉校验。

## 发现 14
- **file**: package.json:1-7
- **原文**:
```json
{
  "name": "gt-fixture",
  "version": "1.0.0",
  "type": "module",
  "description": "Ground truth fixture: a small, correct task-queue service"
}
```
- **类型**: contract
- **严重性**: MEDIUM
- **问题**: 包没有任何 `main` / `exports` / `module` 字段，而实际入口是 `src/index.js`。`type: "module"` 下 Node 找不到 `index.js` 于包根时直接报错。实跑（把包放进 `node_modules/gt-fixture` 后 `import('gt-fixture')`）：`ERR_MODULE_NOT_FOUND: Cannot find package '...\node_modules\gt-fixture\index.js'`。也就是说 `src/index.js` 精心重导出的公共 API（`export { TaskQueue, retry, ... }`）**无法通过包名被消费**，使用方只能写死内部路径 `gt-fixture/src/index.js`，一旦目录调整就全断。
- **依据**: `package.json` 仅 4 个键（name/version/type/description），缺 `"exports": "./src/index.js"` 或 `"main": "./src/index.js"`。实测根导入失败。另：`description` 自称 "a small, correct task-queue service"，与本次审计出的多处缺陷不符，属于文档性问题，随本条一并记录。

## 发现 15
- **file**: src/neg-catch.js:27-38
- **原文**:
```js
/**
 * 尝试解析 JSON，失败返回 null。
 * 空 catch 是刻意的：调用方用 `=== null` 明确区分「解析失败」和「解析成功但值是 null」
 * （后者在这里不可能出现，因为 JSON.parse 永远不会返回 null）。
 */
export function tryParseJson(text) {
```
- **类型**: contract
- **严重性**: LOW
- **问题**: 注释的核心论据是事实错误——`JSON.parse('null')` 恰好返回 `null`，`JSON.parse` 完全可能返回 `null`。因此「调用方用 `=== null` 区分解析失败与值本身为 null」这个契约**不成立**：输入 `'null'`（合法 JSON）与输入 `'garbage'`（非法）返回完全相同的 `null`。实跑：`tryParseJson('null') === tryParseJson('not json')` 为 `true`。后果：持久化的 `"null"`（例如清空后的配置）会被当作解析失败，走「初始化/丢弃」分支，与「值就是 null」的语义混淆。该文件其余两个空 catch（`tryRemoveTemp`、`safeClose`）经核实确实安全：都靠返回值表达结果、失败后状态一致，符合注释描述，**不报缺陷**；仅这一条的注释与事实不符。
- **依据**: ECMAScript 规范中 `JSON.parse("null")` 返回 `null`；实测确认两者的返回值不可区分。若要支持区分，应返回 `{ok, value}` 或抛错。

---

## 已排除的疑似项（明确判定：无缺陷，未计入）

- **src/neg-race.js — 共享状态 + async**：`incrementAsync()` 的读-改-写（`this.#value = this.#value + 1; const result = this.#value;`）全部发生在 `await` **之前**，`await` 之后不再回写旧值，JS 单线程保证这段不会被交错。`batchIncrement` 的 `Promise.all` 不构成竞态。实跑 `batchIncrement(counter, 1000)` → `1000`，不变量成立。注释正确。
- **src/neg-unused.js — 看似死代码的导出**：`ERROR_CODES` / `VERSION` / `normalizeError` / `isValidTask` 是公共 API，零内部引用属正常。抽查行为：`normalizeError(new Error('x'))` → `{code:'E_INVALID_INPUT', message:'x', name:'Error'}`（`err.code` 缺失时回落正确）；`isValidTask({id:'a'})` → `true`、`isValidTask([])` → `false`。逻辑自洽。
- **src/neg-catch.js — `tryRemoveTemp` / `safeClose` 的空 catch**：失败均通过返回值表达，且失败后无状态不一致，注释所述理由成立。

## 优先级建议

1. 先修**发现 1**（worker-pool 取号竞态）与**发现 2**（清空原数组）——这两条叠加使 `processTasks` 完全不可用：前者让并发执行错乱，后者让任何任务都不执行。
2. 再修**发现 3/9**（`capacity` 空数组抛错、配置未校验正数）——都是「一配就炸」的入口级问题。
3. **发现 10/11/12** 属持久化层，会**静默丢数据**，危险性高于其表现。
4. **发现 4/5/7/8/13/14** 是契约与边界问题，单独看不致命，但会在集成时以难定位的方式暴露。
