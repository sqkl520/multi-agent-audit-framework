# FIX-R10 报告 · 堵 R7 报告的「洞 3」——裁决索引表由主 Agent 自己写

**任务**：修 R7 §4 的「洞 3」——最终报告的裁决索引表由主 Agent 自己落盘，可以全填 `DOWNGRADED` 把 `UPHELD` 集合变空。
**日期**：2026-11-15
**改动范围**：只改 `tools/check-fix-instances.mjs` 与 `tools/check-fix-instances.test.mjs`。
**未 commit。** 但见 §7.1：HEAD 里出现了我的改动——那是并行 agent 的 `git add`，不是我做的。

---

## 一、洞 3 的准确形状

R7 §4 的实测原文：

```
HOLE-3 裁决表自填 DOWNGRADED + fix_contracts 空 -> R6 exit 0 | upheld 0 | rules []
  同一 state: stop-hook exit 2 (fix_contracts 空应拦)
```

我在写代码前先用 `HEAD~1`（R6/R7 版，无 `--artifacts-dir`）复现了一次，用的是真实 finding id + 一份合成 arbiter 产物：

```console
$ git show HEAD~1:tools/check-fix-instances.mjs > /tmp/pre-r10.mjs
$ node /tmp/pre-r10.mjs --state state.json --report final-report3.md --json
{
  "totals": { "reportRows": 1, "upheld": 0, "registered": 0, "missing": 0, ... },
  "problems": [],
  "exitCode": 0
}
```

`final-report3.md` 的裁决表只有一行：`round3-A::A-01 | HIGH | ... | DOWNGRADED | round3-03-critique-arbiter.md`；而那份 `round3-03-critique-arbiter.md` 里写着 `UPHELD`。**旧版一条规则都没触发**——`upheld = 0`，所以 `upheld_without_fix_contract` 的循环体根本不会执行。这与 R7 的判定一致。

R7 说这是「R6 设计上的固有前提」——它把报告当**外部基准**，但报告仍在主 Agent 手里。R7 也指出了正确的方向（§5.3）：

> 下一个真正该做的事不是再加规则，是让裁决表的产生与落盘和主 Agent 解耦

本次不做到「解耦」（那要改流程/权限），而是先做它能被机械核对的前提：
**让裁决表的每一行都必须在一个独立文件里得到印证。**

---

## 二、判据：为什么是「出处」，不是「再加一条自述规则」

`framework/artifacts/final-report.md:89` 的原文（我逐字读过，不是转述）：

> **铁律**：主 Agent **只做排序、加索引、加统计**，不得改写任何子 Agent 的措辞、严重性或裁决结论。
> 每一行的「出处」必须是 `artifact_ref`，指向能复核该结论的原始文件。

这句话是现成判据，只是从来没有工具在执行它。表格列名与语义（`final-report.md:83`）：

```markdown
| finding_id | 严重性 | 维度 | 位置 | 裁决 | 出处 |
|---|---|---|---|---|---|
| ... | HIGH | concurrency | `path:line` | UPHELD | `round{N}-03-critique-arbiter.md` |
```

「出处」也是一个 `artifact_ref`，而 `framework/components/handoff-schema.md:297` 已经规定了 `artifact_ref` 失效时的后果：

> `arbiter_artifact_ref` 缺失 → 将对应冲突的 `resolution` 回退为 `PENDING`…**不得**让修复波基于未验证的裁决继续。

所以判据不是「裁决表内部自洽」，而是：

> **裁决表第 N 行的裁决，必须能在它自己声明的出处文件里找到同一个裁决。**

裁决表与锐评产物是两份独立文件。洞 3 把「改 1 处」变成「改 2 处并保持自洽」。

### 2.1 出处文件的真实格式（先读契约再写代码）

我没有猜格式，读了两份文件：

- `framework/components/output-contract/critique.md` §0 与 §2.3：产物末尾必须是 JSON 信封；`critique_role: "arbiter"` 时 `payload.verdicts[] = [{ finding_id, verdict, reason, ... }]`，`verdict` 取 `UPHELD | DOWNGRADED | REVOKED`。
- `framework/templates/wave3-critique.md:82-91`：同一套枚举的语义表；`:508` 的 Arbiter 自检要求「`verdicts` 中每条含 `finding_id`、`verdict`、`reason`」。

但删掉一半会让检查在真实数据上失效，所以**两种形态都读**：

| 形态 | 依据 | 为什么必须支持 |
|---|---|---|
| 末尾 JSON 信封 | output-contract §0/§2.3 | 结构化字段，最权威；`critique_role` 可知 |
| 正文 markdown 裁决表 | wave3-critique.md 的裁决表样式 | 只认信封会把「格式退化」误报成「结论被篡改」——那是把诚信问题安在格式问题上 |

两者对同一条给出不同裁决时，取 JSON 信封（结构化字段优先）并单报 `verdict_source_self_conflict`（WARN，产物该重写）。

---

## 三、改动清单（`tools/check-fix-instances.mjs`）

### 3.1 新增参数

```
--artifacts-dir <目录>   锐评产物所在目录（默认与 --report 同目录）
```

### 3.2 新增规则（5 条，每条独立命名）

| 规则 | 判据 | 级别 |
|---|---|---|
| `verdict_ref_missing` | 某行「出处」为空 / 不是文件路径（散文指代、占位符） | **FAIL**（降级模式下也是） |
| `verdict_ref_not_found` | 「出处」在 `--artifacts-dir` / 报告同目录 / 绝对路径下都解析不到 | FAIL（降级模式下 WARN） |
| `verdict_mismatch_with_source` | **核心**：出处文件里的裁决 ≠ 索引表里的裁决 | FAIL（降级模式下 WARN） |
| `verdict_source_missing_finding` | 出处文件存在，但里面没有该 `finding_id` 的裁决 | FAIL（降级模式下 WARN） |
| `verdict_crosscheck_degraded` | 没有产物可供交叉校验 → 退化为只验索引表内部一致性 | WARN |
| `verdict_source_self_conflict` | 出处文件自身信封与正文表格打架 | WARN |

### 3.3 关键代码位置（行号为本次修改后）

| 内容 | 位置 |
|---|---|
| `normVerdict()` 提到模块作用域（两处共用同一个归一化，避免假阳性） | `tools/check-fix-instances.mjs:328` |
| `REF_COLS`（出处列识别，含 `artifact_ref` 别名） | `:394` |
| `looksLikePath()`（区分 missing 与 not_found 的病因） | `:484` |
| `resolveRefPath()`（三条路径 + `{N}` 占位符通配） | `:526` |
| `readSourceVerdicts()`（JSON 信封 + 正文表格，JSON 优先） | `:559` |
| 交叉校验主体 | `:711`–`:890` |
| 降级判据 | `:769` |

### 3.4 三个实现细节（每一个都来自一次实测失败）

**① 出处的解析容错。** `final-report.md:87` 的模板本身就是 `` `round{N}-03-critique-arbiter.md` ``——带反引号和花括号占位符。解析器必须吃下：反引号、`./` 前缀、绝对路径、`<OUTDIR>/` 前缀、以及 `{N}`（按通配在产物目录里找）。用例 34 逐个覆盖。不做这个容错，这条检查在真实报告上会全量误报，然后被当噪音关掉。

**② `missing` 与 `not_found` 必须分开报。** 「出处」写 `（见上文）` 是「没写要核实什么」（病因在报告），写 `round1-03-critique-nonexistent.md` 是「写的那个东西不存在」（病因在文件系统/流程）。合成一条消息会让人朝错方向找。`looksLikePath()` 就是这条分界线。

**③ 降级判据是「目录不存在或为空」，不是「里面没有可读裁决」。** 这是我在**跑真实数据时改掉的一个自己的错**。第一版写的是「没有能读出裁决的产物 → DEGRADED」，然后用 `experiments/hilltop-dsh/out` 实测，发现：那个目录里有 7 份审计产物、`role=audit`、只有 `findings[]` 没有 `verdicts[]` → 整轮被判成 DEGRADED，只报一条 WARN，**exit 0**。

那等于开了第二条绕法：**把出处全指向审计产物**，检查就永远降级。任务书写的降级条件是「`--artifacts-dir` 不存在或为空」，我第一版写宽了。改后判据是 `artifactFiles > 0`（目录里有产物就不许降级），指向审计产物则逐行报 `verdict_source_missing_finding`——那才是准确病因（「索引表说这条被裁决过，但出处文件里没有它」）。用例 36/36b/38 锁死这个边界。

---

## 四、TDD：先失败，再转绿

### 4.1 改代码前的失败信息原文

先只加测试（`--artifacts-dir` 还不存在），运行，**captured verbatim**：

```
$ node tools/check-fix-instances.test.mjs
exit=1
...
case 28: 索引表填 DOWNGRADED 但 Arbiter 产物说 UPHELD → verdict_mismatch_with_source
未知参数: C:\Users\ADMINI~1\AppData\Local\Temp\fi-test-IQGg1v\artifacts

check-fix-instances.mjs — 修复实例与最终报告裁决索引表的交叉比对
...
  ✗ 退出码 1（不能因为改裁决表就变绿） — 实际 2 /
  ✗ 报 verdict_mismatch_with_source — []
  ✗ 级别是 FAIL — []
  ✗ 点名 F1（逐条，不是「有 N 条不一致」）
  ✗ 消息写明索引表 DOWNGRADED / 出处 UPHELD
  ✗ 8 条全部逐条报出 — 0
  ✗ 交叉校验处于 ENABLED（产物存在）
  ✗ upheld 计数仍是 0（和 R7 实测一致）
case 29: 索引表 UPHELD，Arbiter 产物也 UPHELD → exit 0
  ✗ 退出码 0 — 实际 2 /
  ✗ 交叉校验处于 ENABLED
  ✗ 交叉校验行数 2
case 29b: 索引表 DOWNGRADED，Arbiter 也 DOWNGRADED，fix_contracts 空 → exit 0（合法轮次）
  ✗ 退出码 0 — 实际 2 /
case 30: 出处指向 artifacts-dir 下不存在的文件 → verdict_ref_not_found（FAIL）
  ✗ 退出码 1 — 实际 2 /
  ✗ 报 verdict_ref_not_found — []
...
case 31: 出处列为空 → verdict_ref_missing（FAIL，不受降级影响）
  ✗ 报 verdict_ref_missing — []
  ✗ 两条都报（空 + 非路径占位符） — 0
...
case 32: 出处文件存在但里面没有该 finding_id → verdict_source_missing_finding（FAIL）
  ✗ 报 verdict_source_missing_finding — []
...
case 33: --artifacts-dir 不存在 → 交叉校验降级为 WARN，exit 0
  ✗ 报交叉校验降级规则（WARN） — []
  ✗ 消息写明「退化为只验索引表内部一致性」
...
case 33b: --artifacts-dir 是空目录 → 交叉校验降级为 WARN，exit 0
  ✗ 交叉校验处于 DEGRADED
case 33c: 降级模式下「出处」为空仍是 FAIL（降级不豁免索引表自身的完整性）
  ✗ 报 verdict_ref_missing — []
...
case 34: 出处带反引号 / ./ 前缀 / round{N} 占位符 → 都能解析到同一个文件
  ✗ 三种写法都解析成功
case 35: Arbiter 产物没有 JSON 信封、只有正文裁决表 → 仍能交叉校验
  ✗ 仍报 verdict_mismatch_with_source — []
case 36: 出处指向审计产物（无 verdicts）→ verdict_source_missing_finding
  ✗ 报 verdict_source_missing_finding — []
case 37: --help 说明 --artifacts-dir 与三条新规则
  ✗ 含 --artifacts-dir —
  ✗ 含 verdict_ref_missing
  ✗ 含 verdict_ref_not_found
  ✗ 含 verdict_mismatch_with_source
  ✗ 含 verdict_source_missing_finding
=== 结果: 104 通过 / 46 失败 ===
```

关键点：**`case 28` 的失败原因是 `未知参数`（exit 2）**，而不是「检查器说没问题（exit 0）」。这两者区别很大——前者说明新参数根本没接上，后者说明判据缺失。为了证明**判据缺失**确实存在（而不只是参数没接上），我另外用 `HEAD~1` 的旧版直接喂了同一份 fixture，得到 `exitCode: 0 / problems: []`（见本文 §1）。两条证据合起来才是完整的：旧版的洞是真的，新版的红也是真的。

### 4.2 改代码后

```
$ node tools/check-fix-instances.test.mjs
=== 结果: 167 通过 / 0 失败 ===
```

`check-all.mjs`（25 套件）：

```
$ node tools/check-all.mjs
...
修复实例对账（UPHELD 是否都进入了修复登记）
  → === 结果: 160 通过 / 0 失败 ===
──────────────────────────────────────────
✅ 全部通过
exit=0
```

> 清账时该套件是 160 断言（我后来又加了 case 38/39 到 167）。check-all 那次运行是 160 全绿，单独跑 167 全绿，两次都是 0 失败。

### 4.3 回归：原有的 96 个断言

R7 报告记录的是「96 通过 / 0 失败」。我接手时的基线其实是 **100**（并行 agent 已加过用例）。我的改动后原有用例**一条未改判据**，只给 `reportMd()` 的 `rows` 增加了可选的第 4 个元素（出处原文）——不传时行为与之前完全一致。原 case 1–27 全部仍绿。

---

## 五、真实数据的实测输出

仓库里锐评相位产物**不存在**，只有 7 份审计产物（`experiments/hilltop-dsh/out/`）。这正好用来验证降级路径与「指错产物」路径。

### 5.1 probe A：出处指向不存在的 arbiter 文件

`--artifacts-dir experiments/hilltop-dsh/out`（目录非空，但有 0 份可读裁决的产物）：

```
  出处交叉校验: 已启用（…/experiments/hilltop-dsh/out，产物 8 份，可读出裁决 0 份，已核对 0 行）
✗ [verdict_ref_not_found] 裁决索引表第 13 行（round3-A::A-01）的「出处」指向的文件不存在: round3-03-critique-arbiter.md（已在 …/out 与报告同目录下查找）——出处悬空时，这一行的裁决无法被任何外部文件复核，它等价于「主 Agent 自己说这条降级了，但没人能查」
✗ [verdict_ref_not_found] 裁决索引表第 14 行（round2-mechanics::F3）的「出处」指向的文件不存在: round1-03-critique-arbiter.md（…）
合计: 出处核对 0 / 出处缺失 0 / 出处悬空 2 / 来源无此条 0 / 裁决不一致 0
exit=1
```

**判断：报 `verdict_ref_not_found`（FAIL），不走降级。** 理由：目录里**有产物**——按铁律这些产物本该被核对。把「目录非空但不含裁决」当成降级，等于宣告「只要不生成 arbiter 产物，检查就永远放行」。这正是 §3.4③ 那条自我修正的来源。任务书问的是「报 not_found 还是按降级走 WARN」——答案是前者，且我认为后者是错的。

### 5.2 probe B：出处指向真实存在的审计产物

```
✗ [verdict_source_missing_finding] 裁决索引表第 7 行（round3-A::A-01）的出处 round3-A-audit.md 里**找不到 round3-A::A-01 的裁决**（该文件可读出的裁决 0 条，没有可识别的裁决结构）——索引表声称这条被裁决过，但出处文件里没有它。要么出处指向了错的产物（例如指向审计产物：它只有 findings，没有裁决），要么这条裁决是索引表自己编的
（共 3 条，退出码 1）
```

这一条是最有信息量的实测：它顺带证明了**审计产物不会被误当成裁决来源**——`round3-A-audit.md` 里确实有 `round3-A::A-01`（作为 finding），但解析器读的是 `payload.verdicts[]`，读不到就是 `source_missing`，而不是拿 `findings[]` 里的 id 蒙混过关。

### 5.3 probe C：洞 3 的核心形态（真实 finding id）

用真实 id `round3-A::A-01`，配一份**合成的 arbiter 产物**（结构照 output-contract §2.3 写，内容为 UPHELD）。索引表写 `DOWNGRADED`：

```
  出处交叉校验: 已启用（…/r10crit，产物 9 份，可读出裁决 1 份，已核对 1 行）

✗ [verdict_mismatch_with_source] 裁决索引表第 7 行（round3-A::A-01）的裁决与出处不一致：索引表写 **DOWNGRADED**，出处 round3-03-critique-arbiter.md 写 **UPHELD**（出处原文: "UPHELD"）。
  framework/artifacts/final-report.md:89 的铁律：主 Agent **只做排序、加索引、加统计**，不得改写任何子 Agent 的裁决结论。
  这一条正是 R7「洞 3」的核心形态：把 UPHELD 在索引表里改成 DOWNGRADED，`upheld` 集合变空、`missing` 变 0，于是 `upheld_without_fix_contract` 整个不触发。出处文件说它该修，所以它必须进入修复登记。

合计: 0 条 UPHELD / 已登记 0 / 未登记 0 / 实例 0 / spawned 0
合计: 0 PASS / 1 FAIL / 0 WARN
exit=1
```

注意 `upheld` 仍是 0——规则 5 依然不触发。**红的是新规则**，不是规则 5。这正是修法的要害：不去改「什么算 UPHELD」，而是给「UPHELD 从哪来」加一条独立的核对路径。

### 5.4 probe D：`--artifacts-dir` 不存在（降级路径）

```
  出处交叉校验: 已降级为 WARN（产物目录 …/nonexistent-artifacts-dir 不存在或为空）

! [verdict_crosscheck_degraded] 没有锐评产物可供交叉校验，本检查退化为只验索引表内部一致性。
  索引表有 1 行的裁决**未经任何外部核对**——它们的真伪取决于「主 Agent 是否愿意如实抄写」，本脚本此刻查不出来。
合计: 0 PASS / 0 FAIL / 1 WARN
exit=0
```

默认路径（不传 `--artifacts-dir`，即报告所在目录里只有 `state.json` 与 `final-report.md`）也走这条，实测同样是 `DEGRADED` + exit 0。

### 5.5 probe E：两份都伪造

把 arbiter 产物也改成 `DOWNGRADED`（索引表已经是 `DOWNGRADED`）：

```
  出处交叉校验: 已启用（产物 9 份，可读出裁决 1 份，已核对 1 行）
  （无 problems）
合计: 出处核对 1 / 出处缺失 0 / 出处悬空 0 / 来源无此条 0 / 裁决不一致 0
exit=0
```

**拦不住。** 这是本次交付最重要的诚实结论，见 §6。

---

## 六、诚实评估：洞 3 现在堵住了多少

### 6.1 堵住的部分

| 退化/伪造形态 | 改前 | 改后 |
|---|---|---|
| 改裁决表（UPHELD → DOWNGRADED），arbiter 产物不动 | **exit 0**（probe，`HEAD~1`） | exit 1，逐条点名 + 打出两边的裁决 |
| 改裁决表但把「出处」留空 / 写「见上文」 | exit 0（出处不参与判据） | exit 1（`verdict_ref_missing`，**不受降级豁免**） |
| 删掉 arbiter 产物 | exit 0 | exit 1（`verdict_ref_not_found`），只要产物目录非空 |
| 出处指向审计产物（有 id、无裁决） | exit 0 | exit 1（`verdict_source_missing_finding`），且**不**降级 |
| 裁决表整列没有「出处」 | exit 0 | exit 1（`verdict_ref_missing`，`reason: no_ref_column`） |
| 真的全部降级，arbiter 也说全部降级 | exit 0 | exit 0（**不误杀**，case 29b） |

关键性质：**「改一份」不再可行。** 洞 3 的原始形态（只改裁决表）现在必红。

### 6.2 没堵住的部分

**（a）主 Agent 同时伪造索引表和 Arbiter 产物 → 拦不住（probe E 已实测 exit 0）。**

这是残余的核心。交叉校验把洞 3 的成本从「改 1 处」提到「改 2 处并保持一致」，但**两份文件都落在主 Agent 有写权限的路径上**。R7 §5.3 说的正是这个：

> 这套防线的真实强度上限 = 裁决表有多可信。而洞 3 显示裁决表本身也在主 Agent 手里。

要真正拦住，需要的是**主 Agent 不能写的那一侧**。可选方向，按可行性排序：

1. **流程解耦**：Arbiter 产物由子会话直写、主 Agent 只读。执行者仍能在自己 session 里写同一路径，所以这条只在「子会话使用独立 workspace/权限」时有效。
2. **harness 侧写入日志**：谁在什么时间写了 `*-03-critique-arbiter.md`。这是唯一不可自述的证据（与 R8 的 `check-fix-instances-harness.mjs` 同一条思路）。缺这项能力时该报 `unsupported_harness` 而非静默放行——R8 已建立这个纪律。
3. **产物内容锚定**：Arbiter 产物里带一条只有 Arbiter 能算出的值（例如对证据包算 digest，主 Agent 手上没有原始证据包则算不出）。但主 Agent 通常**手上就有**证据包（它负责派发），所以这条偏弱。
4. **追加式账本**：裁决写入 append-only 日志（`wave3-critique.md:419` 引 `saalis` 的做法），主 Agent 只能追加不能改写。比「两份普通文件」强，但同一 session 里仍可重写文件。

我没有实施这些——它们都要改流程/权限或 tools/ 之外的文件，超出本次授权范围。

**（b）降级路径本身是一条明面上的后门。** 只要「产物目录不存在或为空」，`verdict_ref_not_found` / `verdict_mismatch_with_source` / `verdict_source_missing_finding` 全降 WARN，exit 0。主 Agent 只要**不生成任何锐评产物**（而不是删掉），就能让整轮退化为「只验索引表内部一致性」。

这是任务书明确要求的纪律（「不能因为产物目录缺失就把流程卡死」，与 R8 的 `unsupported_harness` 同源），我照做了。但必须说清代价：**降级形态下，洞 3 完全没有被堵。** 至少它现在会**明说**这件事——`verdict_crosscheck_degraded` 的 WARN 消息里直接写「它们的真伪取决于主 Agent 是否愿意如实抄写，本脚本此刻查不出来」。这是「静默失效」变「公开可见」，不是「失效变有效」。

可选收紧方向（未做，因为会破坏降级纪律）：在生产闸门上加 `--strict-artifacts`，把降级 WARN 升级为 FAIL；仅在 `experiments/` 之外的交付场景开启。

**（c）`WONT_FIX` / `REVOKED` 方向的伪造仍需 Arbiter 也一起改。** 与 (a) 同一性质。

**（d）规则 5 本身没变。** `upheld_without_fix_contract` 仍以索引表的裁决为输入。新规则是**并联**的第二条路径，不是替换。所以「索引表说 UPHELD 但 arbiter 说 REVOKED」这类方向的不一致也会被 `verdict_mismatch_with_source` 抓到（case 35 证明了正文表格那条路径），但「两边都写 UPHELD 却没派发」仍然由规则 5 管——两条规则互补。

### 6.3 一句话结论

**洞 3 的「单方面改裁决表」被堵死了（改前 exit 0 → 改后 exit 1，已实测）；「同时伪造两份文件」没有，且降级形态下完全没有。**
本次交付把洞 3 从「改 1 个文件即可」提升到「改 2 个文件且字段对齐」，并在降级时留下可见的 WARN。它不是「保证正确性」，是「提高伪造成本 + 保证可见性」——与 R9 报告对洞 2 的自我评价同一性质。

---

## 七、附带发现（如实记录）

### 7.1 我的两个文件被并行 agent 的提交卷进了 HEAD

`git status` 显示我的两个文件是 `M`（已修改），但 `git log` 显示 HEAD 已经含有本次改动的**中间态**：

```
0d2b7dc fix(R9/R10): 堵洞 2（WONT_FIX 洗掉 HIGH 警告）与洞 3（裁决表自填）
  tools/check-fix-instances.mjs             | 488 ++++++++--
  tools/check-fix-instances.test.mjs        | 439 ++++++++-
```

那次提交是在我修完最后一个语法错误、测试刚达到 150 全绿的时间窗口里发生的（commit message 里写的正是「check-fix-instances 150 断言」）。**我没有执行任何 commit**，我的全部操作只有 `Edit`/`Write`/`node`。这是并行 agent 的 `git add` 把我未完成的工作树一起收了。

工作区相对 HEAD 仍有 74 行差额（`git diff HEAD --stat`：mjs +16/-5，test +63），是我之后做的三件事：
- 降级判据从「无可读裁决」改为「目录为空」（§3.4③）；
- `verdict_source_self_conflict` 按文件去重（38 行共用一份出处时不再刷屏）；
- 新增 case 31b / 36b / 38 / 39。

**后续收口时请以工作区为准，不要以 HEAD 的版本为准。** 我没有 `git reset` 或 amend——那会动到并行 agent 的提交，超出授权。

### 7.2 `tools/fix-phase-e2e.test.mjs` 现有 3 条断言会红（预期内，不是 bug）

```
$ node tools/fix-phase-e2e.test.mjs
  ✗ B2 [R6/check-fix-instances] exit 0 — 实际 exit 1；problems=["verdict_ref_not_found" × 8]
  ✗ B2 [R6] 没有 FAIL — [8 条 verdict_ref_not_found]
  ✗ B6 [R6] 真实合并（8 条 → 7 实例，已申报）→ exit 0 — 实际 exit 1（同上）
=== 结果: 45 通过 / 3 失败 ===
```

原因是那份 e2e fixture（R7 交付的）里，`finalReportMd()` 给每一行都写了出处 `` `round1-03-critique-arbiter.md` ``，但 `makeWorkspace()` **从不生成这个文件**（只生成 7 份审计产物）。所以在新规则下这是**真实的 FAIL**：出处悬空。

这正是 case 38 固化的场景。两条路：

- **R7 的 fixture 该修**：让它同时生成一份真的 arbiter 产物（8 条 UPHELD），那 B2/B6 会恢复绿，而且 e2e 会顺带覆盖交叉校验的正向路径。
- **或者**：把 B2/B6 改为调用时带 `--artifacts-dir <空目录>`，走降级。

我**没有改这个文件**（任务书：只改那两个文件，有并行 agent 在改别的）。这属于「已知且待处理」，不是我的改动引入的误报。请注意 `fix-phase-e2e.test.mjs` **未注册在 `check-all.mjs` 里**（`grep -c fix-phase-e2e tools/check-all.mjs` → 0），所以 `check-all` 仍是全绿。

### 7.3 `check-all.mjs` 全绿

```
$ node tools/check-all.mjs
...
修复实例对账（UPHELD 是否都进入了修复登记）
  → === 结果: 167 通过 / 0 失败 ===
──────────────────────────────────────────
✅ 全部通过
exit=0
```

25 个套件全过，含本次的 167 断言。

**一次瞬时红，如实记录**：收口验证时有一轮 `check-all` 报 `✗ 1 项失败`。当时 `git status` 显示并行 agent 正在改 `tools/check-payload.mjs` + `.test.mjs`（工作树处于中间态）。两分钟后原样重跑即全绿，且本次改动从未触及 `check-payload`。按任务书「check-all 若因另一个 agent 的并行改动失败，报告出来别修别人的」——记录在此，未做任何修动。

---

## 八、文件清单

| 文件 | 状态 |
|---|---|
| `tools/check-fix-instances.mjs` | 改（+约 490 行：`--artifacts-dir`、5 条新规则、2 个解析器、容错与降级） |
| `tools/check-fix-instances.test.mjs` | 改（+约 500 行：case 28–39，共 16 个新场景 / 67 个新断言） |
| `experiments/hilltop-dsh/FIX-R10-report.md` | 新建（本文） |

未改其他任何文件，未 commit（HEAD 那次提交来自并行 agent，见 §7.1）。

### 验证命令

```
$ node tools/check-fix-instances.test.mjs    # 167 通过 / 0 失败
node tools/check-all.mjs                   # ✅ 全部通过，exit 0
```
