# fixture1 数据集：20 条缺陷，全部机械验证

**最后更新**：manifest v3.0.0（分类改为实测判定）
**状态**：`node verify.mjs` → **21/21 一致**
**审计对象**：`experiments/injected/`（实验各组拷走的就是它）

---

## 分类不再靠记忆

之前的注入型/原生型是我凭「我记得我注入了什么」标的，标错了。GT-016 和 GT-018 都被标成「base 自带」，实际是注入的。

现在由 `verify.mjs` 机械判定——对每条缺陷跑一个行为探针，在 `base/` 和 `injected/` 里各跑一遍：

| base | injected | 判定 | 计入 recall |
|---|---|---|---|
| PASS | FAIL | **注入型** | 是 |
| FAIL | FAIL | **原生型** | 是 |
| FAIL | PASS | **器具缺陷**（只在 base，不在被审计物内） | 否 |
| PASS | PASS | 探针无效，manifest 不成立 | — |

**判据必须是行为可观测的。** 早期有 4 条探针是「读源码看有没有某段文字」，那种判据会把实现方式当成缺陷本身——例如 GT-014 原本检查源码里有没有 `Promise.race`，只要别人用 `AbortController` 实现超时就会被误判。已全部改成真实调用后观察返回值/副作用。

---

## 注入型 13 条

| ID | 缺陷 | base | injected |
|---|---|---|---|
| GT-001 | `processTasks` 清空入参后执行，返回 `[]` | PASS | **FAIL** |
| GT-002 | `dequeue` 用 `>=` 破坏 FIFO | PASS | **FAIL** |
| GT-003 | 容量检查用 `>` 允许塞进 capacity+1 个 | PASS | **FAIL** |
| GT-004 | 指数写错 `2^attempt` 而非 `2^(attempt-1)` | PASS | **FAIL** |
| GT-005 | `parsePositiveInt` 只校验 integer 不校验 positive | PASS | **FAIL** |
| GT-006 | `VALID_LOG_LEVELS` 漏 `warn` | PASS | **FAIL** |
| GT-007 | 损坏 JSON 静默返回 `{}` | PASS | **FAIL** |
| GT-008 | `#persist` 先 `rmSync` 再写，非原子 | PASS | **FAIL** |
| GT-009 | `cursor` 自增在 `await` 后，索引重复 | PASS | **FAIL** |
| GT-010 | `clear()` 的 JSDoc 声称返回 boolean 但实际返回 `undefined` | PASS | **FAIL** |
| GT-015 | `get` 用 `in` 而非 `hasOwnProperty`，原型链泄漏 | PASS | **FAIL** |
| GT-016 | `maxAttempts` 只校验整数不校验正数，`=0` 时抛 `undefined` | PASS | **FAIL** |
| GT-018 | `set("__proto__")` 静默丢失写入并污染实例原型 | PASS | **FAIL** |

## 原生型 7 条

base 写的时候无意留下的，injected 继承了它们。

| ID | 缺陷 | base | injected |
|---|---|---|---|
| GT-011 | `peek()` 返回队列内部活引用 | FAIL | FAIL |
| GT-012 | `remove(id)` 缺 id 校验，与 `enqueue` 不一致 | FAIL | FAIL |
| GT-013 | `capacity` 校验让 `NaN`/`Infinity`/小数通过 | FAIL | FAIL |
| GT-014 | `timeoutMs` 从未被用作超时，只被当成退避上限 | FAIL | FAIL |
| GT-017 | `#load` 不校验解析结果形状，文件为 `null` 时构造即崩 | FAIL | FAIL |
| GT-020 | `processTasks([])` 空数组（合法输入）抛 capacity 错 | FAIL | FAIL |
| GT-021 | `safeClose` 对 async `close()` 返回 `true` 并泄漏未处理 rejection | FAIL | FAIL |

**原生型更有价值**——真实仓库的缺陷不是有人故意埋进去的。

---

## 器具缺陷 1 条（不计分）

| ID | 问题 |
|---|---|
| GT-022 | `base/src/store.js:4` 的 `import { ... } from 'node:fs'` 没导入 `renameSync`，但第 57 行调用了它。**base 的 `JsonStore.set()` 一调用就抛 `ReferenceError`** |

这条不在被审计物里，所以不进 recall 分母。它的价值是三条教训：

1. **base 不能当「无缺陷」的参照物**——任何拿它做 diff oracle 的审计都是错的
2. **旧版 15 条验证有系统性盲区**——没有一条走过 `set()` 这条写入主路径
3. 它是模式 8「引用的绑定是否存在」的真实样本，已进 `wave2-audit.md` §4.8.2，`check-blindspots.mjs` 新增 B4 规则可机械检出

## 已撤下 1 条

| ID | 原因 |
|---|---|
| GT-019 | 与 GT-008 是同一行同一条缺陷（`#persist` 先删后写）。重复登记会在 recall 里被算两次 |

---

## 数据集本身的可信度问题

**manifest 到现在为止补了三次**：

1. 第一次：发现 base 自带 4 条（GT-011/012/013/014）
2. 第二次：D 组发现 2 条（GT-016/017）
3. 第三次：AB-P2 发现 4 条（GT-018/019/020/021）

每次都是「某个 agent 报了我没登记的缺陷，我核实后确认是真的」。

**根因**：我用「我注入了什么」来定义 ground truth，但基准代码本身有问题。真正的 ground truth 应该是「这份代码里客观存在哪些缺陷」，而我至今没有一个独立方法去穷举它。

**所以：**

| 指标 | 可信吗 | 为什么 |
|---|---|---|
| recall | **可信** | 分子分母都是确定的行为验证 |
| 原生型检出 | **可信** | 同上 |
| **precision** | **不可信** | 分母（真实缺陷总数）仍未知，报出来的「误报」里可能混着真缺陷 |

---

## 两个修掉的验证器 bug

**1. 正则转义失效**

GT-014 的 proof 用了 `/timeoutMs:\s*config\.timeoutMs/`，经过多层转义后 `\s` 变成 `s*`，正则失效，base 和 injected 都判 PASS。

改成 `src.includes('maxDelay: config.timeoutMs')` 后正常。

**2. 空集合通过后门**

`verify-artifacts.mjs` 的 G0 门在「一个引用都没提取到」时判通过——什么都没查等于全对。已修。

**教训**：测试判据本身也要验证。一个失效的正则会让「缺陷不存在」看起来像「验证通过」；一个空集合会让「没检查」看起来像「没问题」。
