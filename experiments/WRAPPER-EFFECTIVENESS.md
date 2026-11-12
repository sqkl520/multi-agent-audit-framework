# Wrapper 到底能不能生效：一次真实派发的实测

**日期**：2026-11-12
**上一轮遗留的问题**：16 份审计产物、0 份符合契约（无 JSON 信封）。我判断根因是「派发时用手写简化任务书，绕过了 wrapper 的强制加载」。**这轮验证这个判断对不对。**

---

## 结论：判断是对的，但我的执行方式差点把结论搞反

### 实验

派一个 agent，提示词只有一句实质要求：**去读 `wrappers/audit-specialist.md`，按它说的做**（含它要求的 4 个强制加载文件）。不给任何格式模板。

### 结果

| 检查 | 结果 |
|---|---|
| 产物是否符合 `report-naming.md` | ✅ `round1-02-audit-slice-01-logic.md` |
| 是否以 JSON 信封结尾 | ✅ 有 ```json 块 |
| `check-payload.mjs --role audit` | **✅ 契约合规** |
| `verify-artifacts.mjs` 全部门禁 | **0 FAIL**（修完一个误伤后）|

**加载 wrapper 之后，agent 自主产出了完整合规的产物。** 上一轮的判断成立：

> 不是 agent 做不到，是我没让它读规则。

---

## 这个产物的质量出乎预料

9 条发现，与 fixture2 真值比对：

| 命中 | 说明 |
|---|---|
| ✅ F2-21（`RULES[r.rule]` 原型链查表） | 只有 3/4 的 agent 找到过 |
| ✅ F2-07（嵌套块匹配恒假） | 埋在 `openTag === closeTag.replace(...)` |
| ✅ F2-12（`emit` 吞掉单监听器错误） | |
| ✅ F2-09 / F2-20 / F2-18（分页边界） | |
| ✅ F2-05 / F2-15（`number` 规则） | |
| **+1 条我没登记的** | `template.js:102` `resolvePath` 裸取 `cur[seg]` 原型链问题 |

**6/9 精确命中真值**，而且命中率高于之前 12 份手工任务书产物的任何一份。

### 更重要的是它的自检是真的

```
identifier_reconcile => DONE
    reconcile.mjs 对 5 个文件做四类对账：跨文件 import/export 差集为空；
    escapeHtml 定义 1 处、消费 0 处（定义零消费，已转为 off_dimension 依据）…
self_check_audit => NOT_APPLICABLE
    被审切片不含任何项目自带检查脚本或测试文件…无可抽验对象
runtime_validation => DONE
    在 %TEMP%\w1-scratch 下用 4 个 node 探针跑公开 API 主路径…
```

**它真的写了 `reconcile.mjs` 去跑 import/export 对账**，不是填个 `DONE` 了事。`self_check_audit` 标 `NOT_APPLICABLE` 并给了理由——这正是契约要求的行为。

还有 `off_dimension_notes`（3 条）：把不属于本维度（security / data-consistency / error-handling）的发现**记下来而不硬报**，遵守了「不越维度报告」的约束。

---

## 我差点把结论搞反：一次误伤

第一次跑 `verify-artifacts`，G0 判了 FAIL：

> `quote 是纯注释行，不能作为代码缺陷的证据（events.js:49）`

看起来像是「我上轮加的注释规则起作用了」。**但这是误伤。**

查原始产物：这条 finding 的 `evidence` 是**数组**，两个元素——

1. `events.js:64` 的真实代码：`if (errors.length > 1) { throw new AggregateError(...) }`
2. `events.js:49` 的 JSDoc：`* 单个监听器抛错不影响其他监听器，错误会在全部执行完后一起抛出。`

`claim` 写着「与 JSDoc 声明的『…』矛盾」——**这正是「注释与实现不符」这一类，规则里明文允许的。**

我的豁免正则写的是 `注释(与|和)(实现|代码|行为)不符`，匹配不上「与 JSDoc 声明的…矛盾」这个句式。

### 修法：加了一条结构性判据

关键词匹配太脆。更可靠的是结构：**同一个 finding 里若另有 evidence 引用了真实代码行，这条注释就是「被审对象」而不是唯一证据。**

```js
const hasCodeEvidence = siblings.some((s) =>
  s && s !== ev && typeof s.quote === 'string' && s.quote.trim() !== '' && !isPureCommentLine(s.quote));
```

两条豁免（关键词 + 结构）任一成立即放行。修完后：`verify-artifacts` 48/48 绿，门 0 探针 `06b`（真正的注释当证据攻击）**仍被判 FAIL**。

**双向都验证过，没有放松到能放过真攻击。**

---

## 这轮真正的教训

### 1. 我上一轮的结论站得住，但我给出的方法不完整

「派发时必须加载 wrapper」是对的。但更准确的说法是：

> **如果 harness 支持子 agent 读文件，加载 wrapper 就能生效；如果不支持（人只粘一段文字），那 wrapper 体系在实践中就是装饰。**

我这次派的 agent 有 Read 工具，所以能生效。**真实使用时是不是这样，没测。**

### 2. 我之前所有的一致性实验，测的都是「简化任务书下的表现」

那 16 份产物不光是没有 JSON 信封——它们连 `searched_scope`、`self_checks`、`off_dimension_notes` 这些字段都没有，也没做过 import/export 对账。

**换句话说，之前测的不只是「格式不合规」，而是「框架的整套自适应行为都没启动」。**

拿那些数据讨论「多 agent 一致性」，讨论的其实是「拿到一句话任务的 agent 表现如何」。

### 3. 「规则没生效」和「规则生效但判错了」看起来一样

G0 报 FAIL 时，第一反应是「规则起作用了」。实际是我的规则误伤了一个正确产物。

**这正是我前几轮反复犯的错：把自己的检查当成真理，直到去看原始数据。**

---

## 现在能说的和不能说的

**能说：**
- 加载 wrapper 后，一个 agent 能自主产出**完全合规**的 audit 产物
- 该产物的 `self_checks` 是实质性的（真的跑了对账脚本）
- 命中率高于之前任何一份手工任务书产物（6/9 精确命中真值）

**不能说：**
- 「框架在实践中有效」——**n=1，一个 agent，一份产物**
- 「wrapper 体系可靠」——只有 `audit-specialist` 一个角色被试过，另外 6 个没有
- 「整体质量提升了」——单份产物无法与 12 份手工任务书的统计结果对比

---

## 固化

| 产物 | 位置 |
|---|---|
| 这份真实产物 | `tools/fixtures/real-artifacts/round1-02-audit-slice-01-logic.md` |
| 门 0 注释豁免修正 | `verify-artifacts.mjs`（关键词 + 结构性双判据） |
| 回归验证 | `verify-artifacts.test.mjs` 48/48；门 0 探针 10/10（`06b` 仍拦住） |

## 我的错误

这轮我犯了两个：

**① 把「agent 还在跑」当成事实反复陈述了七八次。** 实际上它早就完成了，产物在 `w1-scratch/round1/` 里躺了半小时。我一直只盯着一个 0 字节的 JSONL 转录文件，没去查它真正的产出目录。

**根因**：我用「输出文件大小」当进度指标，但 agent 的产物是写到它自己的工作目录的，不是写进 JSONL。**盯错了指标，就会一直得出错误结论。**

**② 差点用误伤来「证明」规则有效。** G0 判 FAIL 时我第一反应是规则生效了，直到去看原始 evidence 数组才发现是误伤。

两次都是同一个毛病：**结论跑在了验证前面。**
