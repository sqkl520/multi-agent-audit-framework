# START FIX

**这是修复相位的入口。** 它与 [`START-HERE.md`](START-HERE.md) 并列，不替代它——审计走那份，修走这份。

修复和审计是**两次独立任务**，不是一次流程的两个阶段（理由见 `framework/orchestrator/protocol.md` §0.7）。所以入口也必须是两份：一份只读，一份有副作用。

---

## 为什么需要第二份入口（先读这一节）

`START-HERE.md:52` 写的是「修复是另一件事，等我明确说"修复 round{N}"才启动」。这句话**排除了修复，却没有给出替代入口**——它说了「等我说那句话」，但从没给过那句话的模板，也没说过启动修复要加载什么。

实测后果，三次修复 session 全部如此：

| 观测 | 数值 | 出处 |
|---|---|---|
| 修复任务书对框架规则文件的引用 | **0 次** | `experiments/hilltop-dsh/DIAG3-prompt-structure.md:910` |
| 三个修复 session 的 reasoning 总条数 | **295 条 / 485,097 字符** | `experiments/hilltop-dsh/DIAG3-session-forensics.md:13` |
| 其中 `subagent` 出现次数 | **0 次** | 同上 |
| `subagent` 在修复 session 的 prompt 里出现次数 | **240 次** | `experiments/hilltop-dsh/DIAG3-session-forensics.md:93` |
| 审计与修复两阶段的工具 schema 哈希 | **完全相同**（`bc9f677b65e0e81f`） | `experiments/hilltop-dsh/DIAG-FINAL.md:112` |
| 一次修复 session 的规模 | 196 step / 303 次工具调用 / 0 次派发 | `experiments/hilltop-dsh/DIAG-FINAL.md:70` |

**工具一直在眼前，模型一次都没用。** 排除法也做完了：工具描述里没有保守措辞、上下文压缩没有丢掉任务书、模型和 system prompt 都相同。

对照组是审计相位：审计任务书写了「并行派 3 个 subagent」，主 agent 第一次 `todo_write` 的第 2 项就是「Launch 3 parallel audit subagents」，然后真的派了 3 个。

**结论只有一句：编号子项不触发分解，任务形状的显式派发条目才触发。** 修复任务书里有编号的 5 条缺陷——**明显可分解**，一次都没分解。

所以这份文档的全部价值在于一件事：**把「派几个实例」变成一个已经算好的数，而不是留给执行者临场判断。**

> 而 `triage.md:224` 写着「七项缺一不可。缺任何一项不得派发」，`triage.md:72-76` 规定 T0 最少 3 个成员、T1 最少 5 个、T2 最少 9 个，「**没有"降级到 2 个"这条路**」。**规则极硬，但读不到，等于不存在。**

---

## 第一步：触发条件

用户在审计报告产出之后说下面这句话，修复相位启动。**把 `<...>` 换成实际路径，直接复制**：

```
修复 round{N}

<FRAMEWORK_ROOT> = D:/path/to/multi-agent-audit-framework/framework
<TARGET_REPO>    = D:/path/to/被审仓库
<OUTDIR>         = D:/path/to/审计报告输出目录        （必须在上面的仓库之外，且路径无空格）

先读 <FRAMEWORK_ROOT>/../START-FIX.md，按它的加载清单把八份文件读完，
再跑 TIER 判定，然后按 UPHELD 的条数逐条派独立修复实例——
一轮 N 条发现就派 N 个实例，不要一个 agent 串行修完。
修完派验收，一条修复一个验收实例，验收实例不许看修复 Agent 的自述。
不要 commit。
```

**这句话里的三件事缺一不可**：① 指向 `START-FIX.md`（否则框架的修复侧规则一份都不会被加载）；② 说明「一轮 N 条就派 N 个」（否则默认串行）；③ 说明验收独立（否则验收退化成复述）。

**没有人会替你补上这三句。** 这不是流程缺陷，是这套框架的已知边界——`framework/README.md:240` 自己写着：「纯提示词方案下，加载靠模型自律。」

### 1.1 前置条件（缺任一，先补审计，不要开修）

| 前置 | 判定 | 缺了怎么办 |
|---|---|---|
| 审计已出报告 | `<OUTDIR>/round{N}/round{N}-final-report.md` 存在 | 先把审计跑完，修复消费的是报告不是仓库 |
| 有 `UPHELD` 清单 | 报告第 3 节「发现汇总」里裁决为 `UPHELD` 的条目可逐条枚举 | 没有 `UPHELD` 就没有修复对象；`DOWNGRADED` 不默认进修复波 |
| 每条发现带 `evidence.file:line` | 能定位到具体行 | 定位不到的先派证据补采，不要拿它开工 |

---

## 第二步：加载清单（八份，缺一不得派发）

**这是本文档的核心。** 逐条加载，不要读「摘要版」，不要凭记忆复述。

| # | 文件 | 为什么必须加载 |
|---|---|---|
| 1 | `framework/orchestrator/triage.md` | **此前从未被加载过的那一份。** 它定义 TIER 判定卡（§2）与面板规模（§3：T0≥3 / T1≥5 / T2≥9），并在 `:110` 明写「主 Agent 没有简化权，只有执行权」。不读它，修复相位没有任何规模下限 |
| 2 | `framework/wrappers/planner.md` | 唯一**被授权不读源码就判 TIER** 的角色（triage.md §2.1 只允许三类输入）。它产出的 `members[]` 是面板配置，主 Agent 据此派角色，不自己编 |
| 3 | `framework/wrappers/fix-worker.md` | 修复角色的身份与边界：唯一有写权限的角色、写权限仅限 `target_files[]`、**一条 `UPHELD` 一个实例**、不得自我验收 |
| 4 | `framework/templates/wave4-fix.md` | 派发算术（§0.1）、文件级依赖分析（§0.2）、唯一允许的合并（§0.3）、派发后对账（§0.5）、编辑前必须登记的五个字段（§2）。**「派几个」的答案在这里，不在任务书里** |
| 5 | `framework/templates/wave5-verify.md` | 验收派发算术（§0.1）、修复与验收的**双射**（§0.2）、必须传/必须不传的派发参数（§0.3）、变异检验（§3） |
| 6 | `framework/components/output-contract/fix.md` | 返回信封与 `role: "fix"` 的 payload schema：`disposition` 四值闭集、`test_path`、`red_log_path`。没有它，产物格式不合规，`check-payload.mjs` 会判 `CONTRACT_VIOLATION` |
| 7 | `framework/artifacts/run-state.md` | 账本：`fix_contracts[]`（编辑前登记）、`budget.spawned_fix_agents`（实际派发数）、`phase: wave4 / wave5`。不读它，规则要求写的字段会写到一个不存在的地方 |
| 8 | `framework/orchestrator/protocol.md` | 三条硬约束：§0 零写入（`PASS` 到 `FIX` 的授权边界在 §0.4）、§3 波次门控（波次四/五的闭合条件）、§6 并发与总量护栏（计划量 ≠ 并发量，不得因排队时间合并） |

**加载口径**：`protocol.md` 至少读 §0、§0.4、§3、§6 四节。其余五份读全文——它们都不长（triage 约 250 行、planner 约 160 行、fix-worker 不到 100 行、wave4 与 wave5 各约 300 行）。

> **为什么把 `triage.md` 放在第一行**：审计相位之所以「有入口」，是因为 `START-HERE.md:43-46` 给了加载清单。修复相位之所以「像一个零件库」，是因为那份清单只覆盖审计的三个文件。`triage.md` 从来不在任何清单里——它的 `loaded:` 字段写的是「主Agent在收到任何任务后、派发第一个Agent之前」，而这个事件在纯提示词方案里**没有任何东西会触发**。

---

## 第三步：第一个动作是 TIER 判定，不是读发现清单

进入修复相位的**第一个动作**是按 `framework/orchestrator/triage.md` §2（`:29-45`）的判定卡逐项打分，得出 T0/T1/T2，再按 `triage.md:72-76` 开出 3/5/9 个成员：

```
K1 写入面    需要写入 ≥1 个文件或执行非只读命令 ............ 修复必然为 1
K2 跨度      涉及 ≥2 个目录 / 模块 ......................... 按 target_files 实际分布判
K3 交付物    交付物 ≥2 类 ................................. 代码 + 测试通常为 1
K4 证据源    结论需 ≥2 个独立证据源交叉支持 ................ 红测 + 验收通常为 1
K5 候选解    存在 ≥2 个互斥且都能自洽的方案 ................ 按发现性质判
K6 不可逆    改对外接口 / 数据格式 / 迁移 / 删除 / 发布 ..... 按改动面判
K7 未知前提  任务书含必须自行发现的未知前提 ................ 按发现描述判

score = K1+…+K7
score = 0 → T0（≥3 成员）  score = 1 → T1（≥5）  score ≥ 2 → T2（≥9）
```

**K1 在修复相位恒为 1**（修复一定写文件），所以修复任务**至少是 T1**；只要同时涉及两个目录，就是 T2。

### 3.1 不得跳过，不得降级

`triage.md:107` 原文：

> **正确做法**：按 TIER 判定给的面板规模开，**该 9 个就 9 个**。

`triage.md:110` 原文：

> **主 Agent 没有简化权，只有执行权。**

`triage.md:224` 原文：

> **七项缺一不可。缺任何一项不得派发。**

**「这次改动很小」不是降级理由。** 它最多是 `discipline_log` 里的一条记录，不是成员数的调整依据。`triage.md` §3 已经取消了 T0 的「降级到 2 个」路径（`triage.md:74` 原文「**没有"降级到 2 个"这条路**」），修复波沿用同一条原则。

### 3.2 面板成员数与修复实例数是两个数，都要开

这是最容易混的一处，分开说清：

| 数 | 由什么决定 | 用来干什么 |
|---|---|---|
| **面板成员数** | TIER（`triage.md:72-76`）：3 / 5 / 9 | 谁在**监督**这条修复链路：规划、执行、检索、批判、红队、验证 |
| **修复实例数** | `UPHELD` 的**基数**（`wave4-fix.md` §0.1） | 每条发现由谁**动手修**：一条一个实例 |
| **验收实例数** | 派发成功的修复实例数（`wave5-verify.md` §0.1） | 每条修复由谁**独立验**：一条一个实例，双射 |

**三者不互相替代。** 5 条发现不是「5 个成员」——是 5 个执行实例 + TIER 要求的面板角色（含 1 个规划、至少 1 个批判/红队、每条一个验收）。把 5 条发现折算成「一个执行成员顺手做完」，等于同时违反了 TIER 下限和实例唯一性。

判定结果写进 `<OUTDIR>/round{N}/round{N}-00-plan.md`（planner 的产物，信封格式见 `framework/components/output-contract/planner.md`）。

---

## 第四步：派发数量算术

审计相位有 `planned_sweep_agents = min(effective_slices, sweep_budget)` 这种明确算术（`framework/orchestrator/scale-mapping.md:185`）。修复相位对应的是：

```
planned_fix_agents    = |UPHELD 发现列表|  - Σ(已显式申报合并的 finding 数)
planned_verify_agents = 派发成功且契约合规的 fix_agent_id 数
```

**没有系数、没有上限裁量、没有「简单缺陷可以合并」。** 减号后面那一项只能在**显式申报**时用（`wave4-fix.md` §0.3：`target_files` 集合**相等**且同源），而且必须在 `discipline_log` 里留痕。

### 4.1 文件级依赖分析（派发前必做）

对全部 `UPHELD` finding 的 `target_files[]` 做**两两集合求交**：

```
for (a, b) in pairs(findings):
    if target_files[a] ∩ target_files[b] ≠ ∅:
        union(a, b)          # 编入同一串行组
```

| 求交结果 | 编组 | 调度 |
|---|---|---|
| 交集为空 | 各自独立成组 | **可并行**（受 `concurrency_window` 限制） |
| 交集非空 | 同一**串行组** | 组内串行，顺序按 `finding_id` 升序（确定性，零裁量） |

**这一步的目的不是「找出哪些必须串行」，是「知道哪些能并行」。** 不做分析就串行，等于用最贵的调度方式处理最便宜的情形——实测就是这样塌成单 session 的。不做分析就并行，两个实例会互相覆盖同一段上下文。

**禁止的编组依据**：文件名字母序、目录名、「看起来复杂」、缺陷严重性。只有 `target_files` 的交集关系可以用，因为它是结构特征，可机械复核。

### 4.2 派发后的对账（主 Agent 自己跑）

```
应派实例数 = len(UPHELD) - Σ(已申报合并的 finding 数)
实派实例数 = distinct(fix_contracts[].fix_agent_id)
必须相等。不等 → 差额部分没有被派发
```

**这一条是本节唯一有强制力的部分**——它不依赖任何人读文档时是否被说服。账本里 `budget.spawned_fix_agents` 缺失时按 **0** 处理，不按 1 处理：账本没记录等于没发生。

### 4.3 计划量 ≠ 并发量

`protocol.md` §6：`planned_agents` 可以大于 `concurrency_cap`，主 Agent 按 FIFO 排队派发，**不得因为排队时间长就合并切片或减少计划量**。修复相位同理——超窗口的实例排队，不是消失。

---

## 第五步：可直接复制的任务书模板

**这是整份文档最关键的一段。** 上一节算出「派 N 个」还不够——实测证明，**这个数不进任务书，就不会变成派发**。

### 5.1 模板

把 `<...>` 换成实际值，整段粘给主 Agent：

```
修复 round{N}。全程遵守 <FRAMEWORK_ROOT>/orchestrator/protocol.md §0 的零写入边界：
只允许修改每条发现 target_files[] 里的文件及其对应测试，不得 commit / add / push。

<FRAMEWORK_ROOT> = D:/path/to/multi-agent-audit-framework/framework
<TARGET_REPO>    = D:/path/to/被审仓库
<OUTDIR>         = D:/path/to/审计报告输出目录

【第 0 步：先加载，再动手】
按顺序读完这八份，不许读摘要版、不许凭记忆复述：
  1. <FRAMEWORK_ROOT>/orchestrator/triage.md
  2. <FRAMEWORK_ROOT>/wrappers/planner.md
  3. <FRAMEWORK_ROOT>/wrappers/fix-worker.md
  4. <FRAMEWORK_ROOT>/templates/wave4-fix.md
  5. <FRAMEWORK_ROOT>/templates/wave5-verify.md
  6. <FRAMEWORK_ROOT>/components/output-contract/fix.md
  7. <FRAMEWORK_ROOT>/artifacts/run-state.md
  8. <FRAMEWORK_ROOT>/orchestrator/protocol.md（§0 零写入、§3 波次门控、§6 并发护栏）

【第 1 步：TIER 判定】
读 triage.md §2 的七项判定卡，逐项打 0/1，算出 T0/T1/T2，
按 triage.md:72-76 开出 3/5/9 个成员。不得跳过，不得降级。
判定结果写 <OUTDIR>/round{N}/round{N}-00-plan.md。

【第 2 步：派发要求 —— 这一段是硬要求，不是建议】
本轮共 N 条 UPHELD 发现，**必须派 N 个独立修复实例并行执行**。
每条发现一个实例，不得由一个实例承担多条。
不要一个 agent 串行修完 N 条——那样会因上下文污染和串行停点草率收尾。
派发前先对全部 finding 的 target_files[] 做两两集合求交：
交集为空的组并行派发；交集非空的编入同一串行组，组内按 finding_id 升序串行。
派发完成后，在 state.json 的 fix_contracts 里逐条登记
（finding_id / fix_agent_id / registered_at / defect_statement /
  disproof_condition / baseline_result / rollback_command / test_path），
并把实际派发数写进 budget.spawned_fix_agents（实际计数，不得估算）。

【第 3 步：每条修复的产物要求】
每条发现必须有 disposition（FIXED / WONT_FIX / DEFERRED / NEW_FINDING）：
  FIXED      → 必须给 test_path 和 red_log_path（修复前跑红的日志）
  WONT_FIX   → 必须给 disposition_reason（≥20 字）
  DEFERRED   → 必须给 next_round（什么条件下重新处置）
红测日志**必须落在 target/ 之外**（例如 <OUTDIR>/round{N}/redlogs/）。
写在 target/ 下的日志会被 mvn clean / gradle clean 删掉，验收时无法复核
「修复前确实是红的」——证据一旦可被构建清理，等于没有证据。
产物命名：<OUTDIR>/round{N}/round{N}-04-fix-{finding序号}.md，
末尾必须是完整的 JSON 信封（一个 json 代码块，见 output-contract/fix.md 第 0 节），写完自检：
  node <FRAMEWORK_ROOT>/tools/check-payload.mjs <产物文件> --role fix

【第 4 步：验收不可跳过】
每条成功的修复派一个验收实例，一个 fix_agent_id 对一个验收实例（双射）。
验收实例的上下文**不得包含修复 Agent 的 verification_commands、output_snippet、
artifact_path**——它只从原始 finding_ref 和验收标准出发，独立构造能瞄准缺陷的检查，
并做一次微变异（把修复行改回原样，确认检查确实变红）。

【纪律】
- 主 Agent 不得自己动手改代码（protocol.md §1.2 的 L0）。
- harness 报告终态之前，不因为「产物很久没更新」就终止或重派 agent。
- 任何终止路径都必须出报告，哪怕不完整。禁止「修完了但没有报告」。
```

### 5.2 为什么非要写这几句

「派发要求」这一段不是修辞。它是唯一被实测证明有效的东西：

| 任务书写了什么 | `subagent` 调用数 | 出处 |
|---|---|---|
| 「并行派 3 个 subagent，每个负责一个模块。不要一个 agent 串行读三个模块」 | **3**（同一条 message 内发出） | `experiments/hilltop-dsh/task-b2.md:10`，实际注入文本见 `DIAG3-session-forensics.md:295` |
| 「按风险分成 3 组，并行派 3 个 subagent」 | **3** | `experiments/hilltop-dsh/task-b3.md:4` |
| 五条**编号**缺陷，全文不提 subagent / 并行 | **0**（196 step / 303 次工具调用） | `DIAG-FINAL.md:70`、`DIAG3-session-forensics.md:49` |

**编号子项不触发分解。** 五个编号缺陷比「三个模块」更像可分解任务，但只有后者触发了派发——差别不在任务形状，在于**任务书有没有写「派」这个动作**。

### 5.3 「N」怎么算出来

```
N = |UPHELD 发现列表| - Σ(已显式申报合并的 finding 数)
```

把算出来的数字**写进任务书**（「本轮共 N 条」），不要写「按需派发」或「按条数派发」。含变量的指令在实测中会被解释成「可以只派一个」。

---

## 第六步：修复产物的硬要求

### 6.1 `disposition`：每条发现必须表态一次

四值闭集，缺一即 `CONTRACT_VIOLATION`（`framework/components/output-contract/fix.md` §2.4）：

| `disposition` | 语义 | 附加必填 |
|---|---|---|
| `FIXED` | 代码已改，**有证明修复前是红的测试** | `test_path`、`red_log_path` |
| `WONT_FIX` | 判定为设计意图或不该修 | `disposition_reason`（≥20 字） |
| `DEFERRED` | 已知但本轮不修 | `next_round`（什么条件下重新处置） |
| `NEW_FINDING` | 修复过程中新发现、不在原清单里的缺陷 | 无（建议给 `disposition_reason`） |

**为什么这条是硬要求**：框架此前的 `role: "fix"` 契约只有 `files_touched`。它要求「每条 finding 必须被锐评攻击一次」，却**不要求每条 finding 被修复或明确暂缓一次**。实测后果：38 条发现只修了 6 条，**31 条从未进入任何任务书**，全程没有任何工具报错。另有一例：一条发现含 3 个子主张，任务书只覆盖 1 个，另外 2 个静默消失。**漏处置一条等于让它静默蒸发。**

### 6.2 红测日志必须落在 `target/` 之外

这是真实教训，不是风格建议：

> 诊断阶段的四份红测日志当时就放在 `target/` 下。第二轮构建跑的是 `mvn clean package`，`mvn clean` 把整个 `target/` 删了。**四个被引用的日志全部消失**，验收时再也无法复核「修复前确实是红的」。（`experiments/hilltop-dsh/DIAG-FINAL.md:379-380`）

**证据一旦可被构建清理，等于没有证据。** 正确落点：

```
<OUTDIR>/round{N}/redlogs/<finding序号>-<用例名>.log
```

校验器对含 `target/` 的 `red_log_path` 直接报 `red_log_in_target`（`tools/check-payload.mjs`）。验收记录里建议同时记 `sha256`，这样日志被替换也能发现。

### 6.3 编辑前必须登记，不是修完再补

`wave4-fix.md` §2：修复 Agent 在**第一次 `Edit` 之前**，必须把五个字段写进 `state.json` 的 `fix_contracts[]`：

| 字段 | 内容 |
|---|---|
| `defect_statement` | 一句话重述缺陷的精确行为（「当 X 时，Y 会发生，预期是 Z」） |
| `disproof_condition` | 一个**可观察的检查**，通过则说明缺陷不存在或已修复 |
| `baseline_result` | 修改**之前**运行它的实际输出与退出码 |
| `rollback_command` | 把 `target_files` 恢复到修改前的精确命令 |
| `test_path` | 检查依赖的测试文件或复现脚本路径；不存在就写「需新建」 |

`registered_at` 必须早于对应 `files_touched` 的 mtime——晚于 = 事后补写，判 `CONTRACT_VIOLATION`。无法在修改前运行时，必须写 `baseline_unverified: true`，验收波会为它额外执行一次「基线确认」。

### 6.4 产物落点

```
<OUTDIR>/round{N}/
├── round{N}-04-fix-{finding序号}.md    ← 每条发现一份，末尾带 JSON 信封
├── round{N}-05-verify-{finding序号}.md ← 每条修复一份
└── redlogs/{finding序号}-{用例名}.log  ← 红测日志，在 target/ 之外
```

命名规则见 `framework/artifacts/report-naming.md:53-54`。重派**覆盖**同名文件，不追加 `-v2`。

---

## 第七步：验收相位不可跳过

```
planned_verify_agents = 返回 SUCCESS 且契约合规的 fix_agent_id 数
```

**双射，不是「抽检」**：每个 `fix_agent_id` 恰好一个验收实例，每个验收实例只对一个 `fix_agent_id` 负责。一个实例验收多条修复判 `CONTRACT_VIOLATION`。

### 7.1 验收实例的上下文必须隔离

派发参数**必须传**：`trace_id`、`round_id`、`finding_id`、`fix_agent_id`、`target_files[]`、`acceptance_criteria`、`affected_issues[]`、`residual_risk_flags[]`。

**不得传**：修复 Agent 的 `verification_commands`、`output_snippet`、`artifact_path`（作为必读项）。

**理由是可量化的**：NeurIPS 2026《Silent Regressions》的对照实验——外部提供的、能直接瞄准故障的测试把 silent regression 压到 **4.8%**，让修复 Agent 自己写并跑测试只到 **10.0%**，不验证是 **18.8%**。验收 Agent 一旦看到「修复者说已经通过了」，它就会倾向于复述而不是独立验证。

### 7.2 定向检查要瞄准，不是跑测试套件

`evidence.original_trigger_retested = true` 的判据是全部四条：**瞄准性**（直接观察该缺陷声称的行为）、**可证伪性**（修复前的代码上会失败）、**本回合执行**、**输出可见**。

**变异检验强制**（除 `harness_unsupported` / `unsafe_revert` 两种例外）：把修复的那一行改回原样，确认检查**确实变红**，再恢复。只做实现层变异时还要补一次**调用点变异**——某项目实测「把纯函数改回错误实现后 493 条测试全绿」，因为变的是调用点。

### 7.3 验收的三种去向

| 结论 | 条件 | 去向 |
|---|---|---|
| **通过** | 定向检查通过，影响半径全部处理，无未决标记 | 该缺陷关闭 |
| **带保留通过** | 定向检查通过，但存在人工裁决类标记 | `verdict: PASS` + `escalation_required: true`，本轮 `PARTIALLY_CLOSED`，**不记为已修复** |
| **不通过** | 定向检查失败，或影响半径检查发现破损 | **回波次四**重新修复，**不回波次二** |

---

## 什么时候**不要**走这条路径

| 情况 | 为什么别走 |
|---|---|
| 审计报告里没有 `UPHELD` | 没有修复对象。先重走锐评或证据补采 |
| 你只想看会怎么修，不想真改代码 | 修复相位**有写权限和副作用**，默认路径没有。要方案不要改动，就在审计报告里读 |
| 缺陷描述缺 `evidence.file:line` | 定位不到行的发现无法验收——验收要「瞄准」，瞄准需要靶心 |
| 你不能接受「一部分修好、一部分明确不修」 | 这套框架要求每条发现都有 `disposition`，`WONT_FIX` 是合法结论，不是失败 |

---

## 现在这条路径的真实状态（请先读这一节）

**这是一份提示词文档，它防不住「不读它的人」。** `framework/README.md:240` 已经承认：「纯提示词方案下，加载靠模型自律。」本文档能做的只有两件：把该加载什么列清楚，把该派几个算成数。

| 已知缺陷 | 状态 |
|---|---|
| **文档本身没有加载器** | 没有任何 harness 会因为你存在 `START-FIX.md` 就自动读它。用户任务书里必须指向它（见第一步的模板）。**未修，且不可在本层修复** |
| **「派 N 个」仍是提示词要求** | 强层是 `tools/stop-hook.mjs`：`wave4` 里 `fix_contracts` 有 ≥2 条不同 `finding_id` 而 `budget.spawned_fix_agents ≤ 1` 时，拒绝结束回合。**这是唯一不依赖自律的一环**，但它只在 harness 调 stop hook 时生效 |
| **`spawned_fix_agents` 可能被估算** | 账本纪律要求实际计数。字段缺失按 0 处理（不是按 1），否则「忘了记账」会变成免罚通道 |
| **验收独立性靠派发参数** | 框架能规定「不传 `verification_commands`」，但无法阻止验收 Agent 自己去读修复产物。只能靠 `evidence` 里出现「根据修复报告」时判 `CONTRACT_VIOLATION` |
| **TIER 面板在执行上仍然重** | T2 要 9 个成员 + N 个修复实例 + N 个验收实例。这是设计意图（「token 不是约束」），但意味着一次修复 round 的 agent 数很容易过 20 |

**不要指望这份文档把修复变便宜。它的目标是让修复变正确**——尤其是让「一轮 5 条发现」不再变成「1 个 agent 串行 196 步」。

---

## 验证

改完这条路径的东西之后，跑：

```bash
node <FRAMEWORK_ROOT>/tools/lint-autonomy.mjs
node <FRAMEWORK_ROOT>/tools/check-all.mjs
```

- `lint-autonomy.mjs` 静态钉住「框架里不得存在停下来等用户介入的活规则」等 19 条规则；
- `check-all.mjs` 一条命令跑完全部机械检查，含 `stop-hook` 相位守卫、契约校验器、wrapper 完整性。

---

## 一句话

**审计相位的入口解决的是「怎么审全」，修复相位的入口解决的是「怎么不塌成一个 agent」。**

`START-HERE.md` 用一份加载清单和一段可粘贴任务书，把审计从「零件库」变成了产品。这份文档做同一件事，代价是它多了一条硬要求：**「派 N 个」必须写进任务书**——因为实测证明，不写就不会发生。
