# G3 审计报告 — gt-fixture 任务队列服务

审查范围：`%TEMP%\iso-g3\code\src\` 下 9 个文件（465 行），全部读完。
运行时验证脚本位于 `%TEMP%\g3-probe\p1..p10-*.mjs`，均已 `node` 实际执行。
Node v26.12.1（ESM）。

---

## 发现 1
- **file**: src/worker-pool.js:19
- **类型**: concurrency
- **严重性**: CRITICAL
- **问题**: `worker()` 先读 `cursor`、再 `await Promise.resolve()`、然后才 `cursor += 1`。多个 worker 在同一微任务轮次里读到相同的 `cursor`，于是**同一个 index 被重复执行**，而其它 index 永远不被执行。`results` 数组出现空洞（`undefined`），返回给调用方时被序列化成 `null`。任意 `concurrency >= 2` 且任务数 >= 2 都触发。
- **运行证据**:
  - `node %TEMP%\g3-probe\p2-worker.mjs`
  - `concurrency=2 n=4`：runner 实际收到 `[0,0,2,3]`（期望 `[0,1,2,3]`），结果 `[{ok:true,value:0},null,{ok:true,value:20},{ok:true,value:30}]`
  - `concurrency=3 n=10`：收到 `[0,0,0,3,4,5,6,7,8,9]`，结果第 1、2 位为 `null`
  - 对照 `concurrency=1`：收到 `[0,1,2,3]`，结果全 `set` → 说明只要并发 >1 就复现
  - `node %TEMP%\g3-probe\p10-isolate.mjs` 用同步 runner 同样复现：`conc=2 seen=["0:10","0:10","2:30","2:30","4:50"]`

## 发现 2
- **file**: src/index.js:28
- **类型**: data-consistency
- **严重性**: CRITICAL
- **问题**: `processTasks` 先把任务 `enqueue` 进 `queue`，随后 `tasks.length = 0` 清空**调用方的原数组**；但第 30 行传给 `runWithConcurrency` 的仍是 `tasks`（此时已空），而不是 queue。结果 `processTasks` 对任何非空输入**永远返回 `[]`，handler 一次都不会被调用**。
- **运行证据**:
  - `node %TEMP%\g3-probe\p1-index.mjs`
  - 输入 `[{id:'a',n:1},{id:'b',n:2},{id:'c',n:3}]`，handler 累加 id → 期望 3 个结果、3 次调用；实际 `MAIN processTasks -> [] handler calls: []`
  - `node %TEMP%\g3-probe\p10-isolate.mjs`（concurrency=1 排除发现 1 干扰）：期望 2 结果/2 调用，实际 `result: [] handlerCalls: []`
  - 对照：同一数据直接走 `runWithConcurrency(..., 1, ...)` → `[{ok:true,value:2},...]` 正常

## 发现 3
- **file**: src/queue.js:34
- **类型**: logic
- **严重性**: HIGH
- **问题**: 容量检查写成 `this.#items.length > this.#capacity`，应为 `>=`。满队列仍能再入队一个，**实际容量恒为 capacity+1**。`capacity:1` 可塞入 2 个任务。
- **运行证据**:
  - `node %TEMP%\g3-probe\p3-queue.mjs`
  - `capacity:2`，连续入队 x1/x2/x3 → 期望 `[true,true,false]`；实际 `[true,true,true]`，size=3
  - `node %TEMP%\g3-probe\p9-cap.mjs`：`cap=1` → 期望 `[true,false,false,false]`；实际 `[true,true,false,false]`，最终 size=2
  - 对照：非法任务确实被拒（`enqueue({})` 抛 TypeError），说明校验本身有效，仅容量边界错

## 发现 4
- **file**: src/index.js:23
- **类型**: error-handling
- **严重性**: MEDIUM
- **问题**: `new TaskQueue({ capacity: tasks.length })`。空任务数组时 `capacity:0`，构造函数对 `capacity <= 0` 抛 `TypeError`，于是 `processTasks([], { handler })` **抛异常而不是返回空结果**。批处理空批次是正常输入。
- **运行证据**:
  - `node %TEMP%\g3-probe\p1-index.mjs`
  - `processTasks([], {handler})` → 期望 `[]`；实际 `TypeError: capacity must be a positive number`

## 发现 5
- **file**: src/queue.js:53
- **类型**: contract
- **严重性**: MEDIUM
- **问题**: `dequeue()`（第 53 行）和 `peek()`（第 65 行）用 `priority >= best` 扫描，同优先级时**后入队者胜出**，与注释「同优先级按 FIFO」「返回最先入队的」相矛盾。同优先级任务按 LIFO 出队，会反转提交顺序。
- **运行证据**:
  - `node %TEMP%\g3-probe\p3-queue.mjs`
  - 依次入队 a,b,c（同 priority），`dequeue` 顺序 → 期望 `a,b,c`；实际 `c,b,a`
  - `peek` → 期望 `a`；实际 `c`

## 发现 6
- **file**: src/retry.js:15
- **类型**: logic
- **严重性**: MEDIUM
- **问题**: 注释（第 6 行）声明 `base * 2^(attempt-1)`，实现为 `base * Math.pow(2, attempt)`，**退避整体翻倍**。第 1 次退避应为 base，实际为 2×base（attempt=1 base=100 → 200）。重试节奏与文档不符。
- **运行证据**:
  - `node %TEMP%\g3-probe\p4-retry.mjs`
  - `backoffDelay(1,{base:100})` → 期望 100；实际 200
  - `backoffDelay(2,{base:100})` → 期望 200；实际 400
  - `backoffDelay(3,{base:100})` → 期望 400；实际 800
  - 对照：`attempt0` 正确抛 RangeError、`maxDelay<base` 正确抛 RangeError

## 发现 7
- **file**: src/retry.js:32
- **类型**: error-handling
- **严重性**: HIGH
- **问题**: 仅校验 `Number.isInteger(maxAttempts)`，未校验 `>= 1`。`maxAttempts <= 0` 时 for 循环一次不跑，`lastError` 为 `undefined`，第 47 行 `throw lastError` 即 **`throw undefined`**；调用方 `catch (e)` 拿到 `undefined`，无法获知错误。`retryMax` 来自可被 `loadConfig` 接受为负数的配置（见发现 9），可达。
- **运行证据**:
  - `node %TEMP%\g3-probe\p8-edge.mjs`
  - `retry(fn,{maxAttempts:0})` → 实际 `threw: undefined (!!)`
  - `maxAttempts:-2` → 同样 `undefined (!!)`
  - 对照：`maxAttempts:3` 耗尽后正确 `throw` 最后一次 `Error('always')`，tries=3

## 发现 8
- **file**: src/index.js:34
- **类型**: logic
- **严重性**: MEDIUM
- **问题**: `retry` 的 `maxDelay` 被传成 `config.timeoutMs`（单次超时上限），而 `base=50`。当 `timeoutMs < 50`（如设为 10/0）时，`backoffDelay` 抛 `RangeError('maxDelay must be >= base')`，该异常**逃出 retry 并替换掉 handler 的真实错误**，掩盖原始失败原因。语义也错配：timeout 不是退避上限。
- **运行证据**:
  - `node %TEMP%\g3-probe\p8-edge.mjs`
  - `retry(handler 抛 Error('h'), {base:50,maxDelay:10})` → 期望保留 `h` 或按上限退避；实际 `RangeError: maxDelay must be >= base`，原始 handler 错误丢失
  - 对照：`timeoutMs=30000` 时 processTasks 正常产出 `{ok}` 结构

## 发现 9
- **file**: src/config.js:16
- **类型**: contract
- **严重性**: HIGH
- **问题**: 函数名为 `parsePositiveInt`、注释称「非法值抛错」「positive integer」，但 `Number.isInteger` 对负数/0 均为 true。`CONCURRENCY=-5`、`TIMEOUT_MS=0`、`RETRY_MAX=-3`、`CONCURRENCY=" "`（`Number(' ')=0`）全部被接受。这些值下游会触发 `runWithConcurrency` 的 `concurrency<1` 抛错、`retry` 的 `maxAttempts<=0` 抛 undefined（发现 7）、`backoffDelay` 的 maxDelay 校验（发现 8）。
- **运行证据**:
  - `node %TEMP%\g3-probe\p5-config.mjs`
  - `loadConfig({RETRY_MAX:'-3'})` → 期望抛错；实际 `{"retryMax":-3,...}`
  - `loadConfig({CONCURRENCY:'-5'})` → 期望抛错；实际 `concurrency:-5`
  - `loadConfig({TIMEOUT_MS:'0'})` → 期望抛错；实际 `timeoutMs:0`
  - `loadConfig({CONCURRENCY:' '})` → 期望抛错；实际 `concurrency:0`
  - 对照：`'abc'`、`'1.5'` 正确抛 `TypeError`；`LOG_LEVEL:'verbose'` 正确抛错

## 发现 10
- **file**: src/store.js:31
- **类型**: data-consistency
- **严重性**: MEDIUM
- **问题**: `get` 用 `(key in this.#data)` 判断。`#data` 是普通对象，拥有 `Object.prototype`，因此 `get('toString')`、`get('hasOwnProperty')`、`get('constructor')` 等**未存储的键返回原型上的函数**而非 `undefined`。调用方无法区分「没存过」和「存了一个函数」。
- **运行证据**:
  - `node %TEMP%\g3-probe\p6-store.mjs`
  - `s.get('toString')` → 期望 `undefined`；实际 `function`
  - `s.get('hasOwnProperty')` → 期望 `undefined`；实际 `function`
  - 对照：已存储键 `get('a')` → `1`，`get('b')` → `{"x":2}`，`delete` 后再取为 `undefined`（说明仅有原型键泄漏）

## 发现 11
- **file**: src/store.js:35
- **类型**: data-consistency
- **严重性**: MEDIUM
- **问题**: `this.#data[key] = value` 对 `key === '__proto__'` 会**改写对象原型而非写入自有属性**，数据被静默丢弃：`keys()` 不含该键，落盘为 `{}`；重载后 `get('__proto__')` 返回的是对象原型而非存入的值。属静默丢数据 + 原型污染面。
- **运行证据**:
  - `node %TEMP%\g3-probe\p6-store.mjs`
  - `s2.set('__proto__', {polluted:true})` → 期望 `keys()` 含 `__proto__`；实际 `keys: []`，落盘原文 `{}`
  - 重载后 `typeof new JsonStore(p2).get('__proto__')` → `object`（非存入的 `{polluted:true}`）

## 发现 12
- **file**: src/store.js:53
- **类型**: data-consistency
- **严重性**: MEDIUM
- **问题**: 文件头注释（第 2 行）声称「带原子写入：先写临时文件再 rename，避免半写状态」，实现却是**先 `rmSync` 删除原文件再 `writeFileSync`**——正好相反。删除与写入之间有窗口，进程崩溃/磁盘满会**丢失全部既有数据**；且没有任何临时文件 + rename。
- **运行证据**:
  - 代码路径：`store.js:54 rmSync(this.#path)` 后 `store.js:55 writeFileSync(...)`，无 tmp/rename
  - 直接对比注释第 2 行与实际两行；`node %TEMP%\g3-probe\p6-store.mjs` 的 set 操作均命中该路径（`MAIN ... reload from disk` 能读到说明正常路径可用，但原子性声明不成立）
  - 期望：rename 原子替换；实际：先删后写，存在数据丢失窗口

## 发现 13
- **file**: src/store.js:23
- **类型**: error-handling
- **严重性**: MEDIUM
- **问题**: `#load` 对损坏 JSON 直接 `catch { return {} }`，**静默丢弃整个文件内容**。随后任意 `set` 会用空数据覆写原文件，未损坏的历史数据不可恢复。无备份、无告警。
- **运行证据**:
  - `node %TEMP%\g3-probe\p6-store.mjs`
  - 预写截断 JSON `{"keep":"me"`，构造 `JsonStore` → `keys: []`（期望：抛错或保留/备份）
  - 紧接 `set('new',1)` → 文件变为 `{"new":1}`，原 `"keep":"me"` 永久丢失

## 发现 14
- **file**: src/queue.js:84
- **类型**: contract
- **严重性**: LOW
- **问题**: `clear()` 的 JSDoc 声明 `@returns {boolean} 总是 true`，但函数体无 return，**实际返回 `undefined`**。调用方若写 `if (!q.clear())` 会误判为失败。
- **运行证据**:
  - `node %TEMP%\g3-probe\p3-queue.mjs`
  - `cl.clear()` → 期望 `true`；实际 `undefined`，size 归 0
  - 对照：`remove` 正常返回布尔（存在→true，不存在→false）

## 发现 15
- **file**: src/neg-catch.js:29
- **类型**: contract
- **严重性**: LOW
- **问题**: `tryParseJson` 注释断言「JSON.parse 永远不会返回 null」，据此用 `=== null` 区分失败。但 `JSON.parse('null')` 合法返回 `null`，此时输入 `'null'` 与解析失败**得到同一个返回值**，契约歧义。空 catch 本身语义正确（该文件主要逻辑无缺陷）。
- **运行证据**:
  - `node %TEMP%\g3-probe\p7-neg.mjs`
  - `tryParseJson('null')` → `null`（期望：能区分「合法 null」与「失败」）
  - 对照：`tryParseJson('{"a":1}')` → `{"a":1}`；`tryParseJson('bad')` → `null`（失败路径）

---

## 负例文件核查结论（不报缺陷）
- `src/neg-catch.js`：`tryRemoveTemp` / `safeClose` 的空 catch 语义正确，失败返回 false，状态一致。实际运行 `tryRemoveTemp(existing)=true / missing=false`、`safeClose(null)=false / 已关闭对象=false`，无缺陷。
- `src/neg-race.js`：`incrementAsync` 读-改-写在同一同步段内、await 在写之后，不构成竞态。实测 `batchIncrement(counter,100)=100`、连续两次 `100,200`，不变量成立；`count=-1` 正确抛 RangeError。无缺陷。
- `src/neg-unused.js`：`ERROR_CODES` / `VERSION` / `normalizeError` / `isValidTask` 均为公共 API，实测输出合理（见 p7 日志）。零引用≠死代码，无缺陷。

## 额外观察（低置信，不计入发现）
- `src/neg-race.js:44` 注释引用 `test-base.mjs`，本仓库不存在该文件。属注释失准，非代码缺陷，故单列不报。

## 验证脚本清单（均在 `%TEMP%\g3-probe\`）
- `p1-index.mjs` 公开 API 主路径 + 空输入 + 对照
- `p2-worker.mjs` 并发执行器多并发度
- `p3-queue.mjs` 队列主路径/容量边界/同优先级/clear
- `p4-retry.mjs` 退避值/重试耗尽/小 timeout
- `p5-config.mjs` 配置合法与非法输入
- `p6-store.mjs` 存取/原型键/`__proto__`/损坏文件
- `p7-neg.mjs` 负例三文件
- `p8-edge.mjs` maxAttempts<=0 / maxDelay<base / 部分失败
- `p9-cap.mjs` 容量边界细查
- `p10-isolate.mjs` 隔离数组清空与游标竞态
