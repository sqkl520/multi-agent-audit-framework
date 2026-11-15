---
file: templates/wave4-fix.md
title: 波次四：修复（fix worker）
group_order: 4
loaded: 加载前必须已加载 output-contract.md 和 handoff-schema.md
source: https://chat.deepseek.com/share/yn99k1mum4qp5fqwj8 (第 12 轮)
---

# templates/wave4-fix.md
`templates/wave4-fix.md` 是整条链路中**唯一授予写权限**的模板。它的设计难点不在“怎么改代码”，而在**如何让一个写操作受限、可审计、可回滚，且不把副作用留给下游验收波去发现**。搜索到的材料给出了几个必须吸收的锚点：Active Remediation 的 `minimal-safe-diff` 把“安全修复”定义为**≤10 行、单生产文件 + 测试文件、不跨文件、不改公共 API**[^ref0]；sdd-parallel 用**三层范围守卫**拦截越界编辑，并靠 AST + 调用图计算**语义爆炸半径**来防止“孤立分支测试通过、合并后灾难性失败”[^ref1]；break-ai-fix-loops 的核心纪律是**三次尝试预算 + 真实路径证明 + 已测试的回滚**，而不是 patch-and-retry[^ref2]；callsphere 明确指出**爆炸半径由授予的权限决定**——文件系统范围、命令权限、网络与密钥访问，而不是由 Agent 的自我声明决定[^ref3]；NeurIPS 的 silent regression 证据进一步证明，**让修复Agent自己写测试并运行，既不提高解决率也不降低回归率**，部署时验证必须依赖外部提供的、能直接瞄准故障的测试，而不是 Agent 自证的“通过”[^ref4]。这些原则共同决定了：修复Agent必须是**窄边界、可回滚、不自我验收**的执行单元。

> **本框架证据链中最硬的一条，必须读懂它的完整含义**：NeurIPS 2026 的《Silent Regressions: The Verification Gap in Coding Agents》[^ref4] 逐字给出：「**Prompting GPT-5 to write and run a failing test moves neither resolve nor regression rate**，与基线在 10 个百分点边际内等价」。它的对照实验更关键：
>
> | 验证方式 | silent regression 率 |
> |---|---|
> | FAIL TO PASS **外部**测试（能直接瞄准故障） | **4.8%** |
> | 让修复 Agent 自己随机写测试 | 10.0% |
> | **不验证 / 自证**（基线） | **18.8%** |
>
> **三个推论，分开说清楚，不要混用：**
> 1. 「让修复 Agent 自己写并跑测试」**既不提高解决率也不降低回归率**——这是波次四/五必须分离、且修复 Agent 不得自称"已修复"的直接依据；
> 2. 真正的降幅来自「**外部提供的、能直接瞄准故障的**测试」——这决定了 `wave5-verify.md` 的验收必须**独立构造**触发条件，而不是复用修复者选的检查；
> 3. 随机/自选测试只把回归率从 18.8% 降到 10.0%，与外部瞄准测试的 4.8% 差一倍以上——**「有测试」不等于「测试瞄准了缺陷」**，这是变异检验（`mutation_check`）不可省略的量化理由。


## 文件头部：强制加载与写权限边界

> wave4-fix.md
> 修复Agent（fix worker）专属模板。
> 加载本模板前，必须已加载 output-contract.md 和 handoff-schema.md。
> 本模板与 output-contract / handoff-schema 冲突时，以两者为准；
> 本模板只负责“修复Agent在单缺陷、窄边界内如何执行修改并声明影响半径”，
> 不重新定义返回格式（由 output-contract 定义）或波次传递结构（由 handoff-schema 定义）。
> 修复Agent的返回必须符合 output-contract.md 的 role: "fix" payload schema。

**写权限的硬边界**：修复Agent是唯一允许修改源代码文件的角色。它的写入范围**仅限**派发时指定的 `target_files` 列表中的文件，以及与之对应的**测试文件**（如果该缺陷的验收标准要求新增或修改测试）。修复Agent**不得**创建新文件、删除文件、修改依赖清单（`package.json` / `requirements.txt` / `go.mod` 等）、修改构建配置或修改 `target_files` 之外的生产代码。callsphere 的原则在这里直接适用：爆炸半径由授予的权限决定，而不是由修复Agent的意图决定[^ref5]。如果修复需要触及范围外的文件，修复Agent**必须**停止修改，返回 `RETRYABLE_FAILURE` 或 `CONTRACT_VIOLATION`，并在 `residual_risks` 中明确写出“修复需要触及 `<path>`，超出授权范围”，而不是自行扩大权限。


## 第 0 节：派发规则（主Agent执行，先于第 1 节）

> 本节读者是**主Agent**，不是修复Agent。放在最前面，因为「派几个实例」是在任何修复行为发生**之前**就定死的事。

### 0.1 派发数量的算术

```
planned_fix_agents = len(UPHELD 发现列表)        # 减掉 §0.3 显式申报的合并
```

**这不是 K，不是「按需」，不是「看工作量」**。没有系数、没有上限裁量、没有「简单缺陷可以合并」。

- `K` 是锐评面板成员数，与本波无关；
- 「按需」在这个框架里等价于「可以不派」——实测就是这样塌掉的：5 条 UPHELD、5 条编号缺陷任务书，主Agent用**单个 session、196 个 step、303 次工具调用**全部串行做完，`subagent` 调用 **0 次**；
- 「看工作量」更糟：它把「修得快」奖励给串行。

这与 `orchestrator/triage.md` 第 3 节的取向同构——那里取消了 T0 的「降级到 2 个」路径，并明写「**没有『降级到 2 个』这条路**」。修复波沿用同一条原则：**实例数由 `UPHELD` 的基数决定，不由任何人的手感决定。**

> **为什么不设上限**：上限会变成默认值。真实约束是 `concurrency_window`（同时运行数），它管的是**并行度**，不是**实例总数**——超出窗口的实例排队，不是消失。
>
> **分母的准确口径**：`fix-worker.md` §2 的「前置状态」是「`UPHELD` **或** `DOWNGRADED`」，两者都要修。若本轮也派发 `DOWNGRADED`，则 `planned_fix_agents` 的分母是 `UPHELD + DOWNGRADED`——**但绝不是「挑几条重要的」**。这里写 `UPHELD` 是因为它是默认路径上的主集合；任何筛选都要按 `discipline_log` 申报，否则就是未申报的裁量。

### 0.2 文件级依赖分析（派发前必做，机械可复核）

对全部 `UPHELD` finding 的 `target_files[]` 做**两两集合求交**：

```
for (a, b) in pairs(findings):
    if target_files[a] ∩ target_files[b] ≠ ∅:
        union(a, b)                       # 编入同一串行组
```

| 求交结果 | 编组 | 调度 |
|---|---|---|
| 交集为空 | 各自独立成组 | **可并行**（受 `concurrency_window` 限制） |
| 交集非空 | **同一串行组** | 组内**串行**，顺序按 `finding_id` 升序（确定性，零裁量） |

**为什么必须做这一步**：这样做的目的是**知道哪些能并行**，而不是「把一切串起来」。若不做分析就串行，等于用最贵的调度方式处理最便宜的情形；若不做分析就并行，两个实例会用同一个文件的同一段上下文互相覆盖——这是 `minimal-safe-diff` 与三层范围守卫要防的那类灾难[^ref1]。

**禁止的编组依据**：按文件名字母序、按目录名、按「看起来复杂」、按缺陷严重性。`target_files` 的**交集关系**是结构特征，可以用；内容判断不可以。

**串行组的组内顺序是唯一允许的排序**：`finding_id` 升序（或 FIFO）。主Agent在任何地方都**不是**「排序者」——它的职责是**编组并派发**，排序只在串行组内部出现，且由 id 决定而非裁量。

### 0.3 唯一允许的合并，以及必须留的痕

**默认：一条 finding 一个实例。** 允许合并的唯一情形同时满足两条：

1. 多条 finding 的 `target_files` **完全重叠**（集合**相等**，不是「有交集」）；
2. **同源**：同一 `slice_id`、同一根因、同一处代码。

合并在派发记录里**必须**留下：

```json
{
  "kind": "FIX_INSTANCE_MERGED",
  "merged_finding_ids": ["finding-012", "finding-013"],
  "reason": "target_files 完全相等（src/dispatch/pipeline.ts），同一函数同一根因；分开派发会产生两次对同一段代码的竞争写入",
  "shared_target_files": ["src/dispatch/pipeline.ts"],
  "mechanically_checkable": "两条 finding 的 target_files 排序后逐元素相等"
}
```

写进 `state.json` 的 `discipline_log`。**没有这条记录 = `CONTRACT_VIOLATION`**，该实例的全部输出作废并回滚。

> **为什么合并必须留痕而不是禁止**：完全重叠 + 同源的 finding 分开派发会互相踩。禁止合并会制造一个物理上无法执行的规则，而无法执行的规则会让人连其他规则一起不遵守。但「合并」必须是**可被机械复核的申报**，不是口袋条款。

> **⚠ 与 `output-contract/fix.md` §2.4 的「多发现形态」并存时的优先顺序**：契约允许一次派发携带多条发现（`payload.dispositions[]` + `target_finding_ids`），那是为了服务**上一条**申报合并的情形，以及为了不丢处置（每条发现至少得到一个 `disposition`）。**它是容纳合并的容器，不是绕过实例唯一性的通道。** 判据：一个实例的多条 `disposition` 若不在 `discipline_log` 里有对应的 `FIX_INSTANCE_MERGED` 记录，**照样判 `CONTRACT_VIOLATION`**——契约能装下多条，规则不允许无申报的多条。**不要去用契约层的「合法」抵消派发层的违规。**

### 0.4 派发前必须就绪的三件事

| # | 前置 | 判定 | 失败处理 |
|---|---|---|---|
| 1 | 产物目录已建 | `state.json` 的 `report.dir_ready: true`，且路径无空格 / 无中文（`artifacts/report-naming.md` §5.1–5.2） | **不得开始派发**，`PERMANENT_FAILURE` / `ToolError` |
| 2 | `fix_contracts` 数组已就位 | `state.json` 有该字段（`artifacts/run-state.md`），可被逐条追加 | 先补账本结构，否则 §2 的前置登记无处可写 |
| 3 | 编号已冻结 | 每个实例拿到**唯一** `finding_id`；同一 `(round, stage, discriminator)` 只对应一个实例（产物名 `round{N}-04-fix-{finding序号}.md`） | 重派**覆盖**同名文件，不追加 `-v2` |

### 0.5 派发后的机械对账（主Agent自己跑）

```
应派实例数 = len(UPHELD) - Σ(已申报合并的 finding 数)
实派实例数 = budget.spawned_fix_agents      # 实际计数，每次派发后 +1
交叉验证   = distinct(fix_contracts[].fix_agent_id)
三者必须一致。不等 → 差额部分没有被派发，记为 discipline_violation
```

**`spawned_fix_agents` 是这条对账的强制力所在**：`stop-hook.mjs` 在 `phase == "wave4"` 时会比较 `distinct(fix_contracts[].finding_id)` 与 `budget.spawned_fix_agents`，**≥2 条独立缺陷却 ≤1 个实例就拒绝闭合该相位**。字段缺失按 **0** 处理——账本没记录等于没发生，不按 1（理由见 `artifacts/run-state.md` 第 2 节）。

**这条对账是本节唯一有强制力的部分**——它不依赖任何人读文档时是否被说服。

### 0.6 失败模式

| 失败模式 | 表现 | 判定 |
|---|---|---|
| **一个实例修多条 finding** | `fix_contracts` 里多条 `finding_id` 共享同一个 `fix_agent_id`，且 `discipline_log` 无 `FIX_INSTANCE_MERGED` 记录 | **`CONTRACT_VIOLATION`** |
| 一个实例修多条（已申报合并） | 同上，但 `target_files` 排序后逐元素相等且有 `reason` | 合规 |
| 实例数少于 `UPHELD` 数，且无合并申报 | 差额部分无 `fix_agent_id` | **`CONTRACT_VIOLATION`**（未派发） |
| 同一 `finding_id` 派了两个**并行**实例 | 两个实例的 `target_files` 有交集且同时在跑 | **`CONTRACT_VIOLATION`**（串行组被并行执行） |
| 主Agent自己动手改代码 | 出现非 `fix_agent_id` 的写入 | **`CONTRACT_VIOLATION`**——主Agent没有写权限 |

---

## 第 1 节：修复Agent的职责边界——四做四不做

**做**：

1. **只修一个缺陷**。修复Agent在派发时收到一个 `finding_id` 和一个 `verdict: UPHELD`（来自 Arbiter 的裁决）以及该缺陷的**验收标准**。它只针对这个缺陷执行修改，**不得**顺带修复其他问题，即使它在修改过程中看到了另一个明显缺陷。
2. **只碰最小范围**。修改必须遵守 `minimal-safe-diff` 的约束：单个生产文件（或极少数紧密耦合的文件）内的局部修改，**≤10 行变更**是目标区间；如果缺陷确实需要更大范围的修改才能修复，修复Agent**必须**在 `residual_risks` 中标记 `LARGE_PATCH` 并说明原因，而不是悄悄扩大 diff[^ref6]。
3. **显式声明影响半径**。修复Agent必须在 `affected_issues` 中列出“这个修改**可能**影响到的其他已发现缺陷”，并在 `residual_risks` 中写明“影响范围是否已验证”。**不声明**等同于“未考虑”，主Agent在验收波中会将其视为需要额外回归扫描的信号。
4. **提供可复现的验证命令与结果**。修复Agent必须在 `verification_commands` 中给出它实际执行过的检查命令（或如果 harness 不支持执行，则给出“未运行”并说明原因），并附上 `output_snippet`。**不允许**只写“已测试通过”而不提供命令和输出。

**不做**：

1. **不做自我验收**。修复Agent的 `verification_commands` 是**辅助证据**，不是验收结论。NeurIPS 的证据表明，让修复Agent自己写测试并运行，既不提高解决率也不降低回归率；真正的验收由独立的验收波从原始验收标准出发执行[^ref7]。修复Agent**不得**在返回中声称“该缺陷已修复”——它只能说“我做了这些修改，并运行了这些检查，结果如下”。
2. **不做根因重构**。如果修复需要重构共享模块、更改公共 API 签名、或升级依赖才能正确解决，修复Agent**必须**停止并返回 `RETRYABLE_FAILURE`，在 `residual_risks` 中写明“该修复需要超出最小安全差异的重构，应升级为独立任务”，而不是在修复波中做 scope creep。Active Remediation 的 “note + ask” 规则在这里是硬边界：超出最小安全差异的修改**永不自动执行**[^ref8]。
3. **不修改测试来使测试通过**。修复Agent**不得**通过删除、跳过、弱化或重写测试断言来让检查“通过”。如果现有测试与缺陷的正确修复冲突，修复Agent必须在 `residual_risks` 中标记 `TEST_CONFLICT`，说明“测试 `<test_id>` 的当前断言与正确修复矛盾，需由验收波或人工判断”，而不是自行修改测试。
4. **不在返回中夹带推断或“建议”** 。修复Agent的 `payload` 只包含 `files_touched`、`verification_commands`、`affected_issues`、`residual_risks` 四个字段。任何关于“我还发现……”“建议后续……”的内容**不进入** `payload`。如果修复Agent在修改过程中看到了其他问题，它**不得**写入返回，而是在 `residual_risks` 中用一行 `OBSERVED_BUT_OUT_OF_SCOPE: <path:line> <一句话>` 透传，供主Agent决定是否在后续轮次中派发新的审计。


## 第 2 节：修复契约的前置登记——编辑之前必须写下来的五个字段

break-ai-fix-loops 的核心实践是：**在第一次编辑之前，记录精确的缺陷、能证伪它的行为、被测路径、基线结果、以及回滚命令**[^ref9]。修复Agent在动手修改之前，**必须**把这五个字段写进主 Agent 的 `state.json` 的 `fix_contracts` 数组（见 `artifacts/run-state.md`），并且 `registered_at` 必须早于你对该缺陷的第一次 `Edit`。缺失任一字段，修复Agent**不得**进入编辑阶段，主 Agent 判 `CONTRACT_VIOLATION`。

> **⚠ 2026-11-09 修正**：本节原文写的是「在内部（或账本的 `fix_contract` 字段中）登记」。「在内部」不是可接受的落点——子 Agent 的内部推理不落盘，主 Agent 和验收波都读不到，`rollback_command` 也就无人可用。`state.json` 里此前也没有 `fix_contracts` 字段，规则要求往一个不存在的地方写。现已在 `artifacts/run-state.md` 补上该字段，并由 `tools/check-state.mjs` 机械校验。

| 前置字段 | 内容 | 用途 |
|---|---|---|
| `defect_statement` | 一句话重述该缺陷的精确行为（不是“有问题”，而是“当 X 时，Y 会发生，预期是 Z”） | 防止修复Agent修错目标 |
| `disproof_condition` | 一个**可观察的检查**，如果该检查通过，则说明缺陷不存在或已被修复 | 验收波将复用这个检查作为起点 |
| `baseline_result` | 在修改**之前**运行 `disproof_condition` 的实际输出和退出状态 | 证明缺陷在修改前确实可触发 |
| `rollback_command` | 将 `target_files` 恢复到修改前状态的精确命令（`git checkout` / `git stash` / 文件级恢复） | 如果验收失败，主Agent可以机械回滚 |
| `test_path` | `disproof_condition` 所依赖的测试文件或复现脚本的路径；如果不存在，写明“需新建” | 告诉验收波“从哪里瞄准” |

**`baseline_result` 的硬性要求**：如果修复Agent无法在修改前运行 `disproof_condition`（例如 harness 不支持执行命令，或缺陷依赖外部服务无法在本地复现），它**必须**在 `residual_risks` 中写入 `BASELINE_UNVERIFIED`，并且该修复的验收波**必须**额外包含一个“基线确认”步骤——即验收Agent首先要确认缺陷在修复前的版本上确实可触发，然后再确认修复后不再触发。如果修复Agent在编辑前没有记录 `baseline_result`，且没有标记 `BASELINE_UNVERIFIED`，主Agent判定为 `CONTRACT_VIOLATION`。


## 第 3 节：影响半径的显式声明——`affected_issues` 与 `residual_risks`

修复Agent返回中最容易被下游依赖的两个字段是 `affected_issues` 和 `residual_risks`。它们不是可选的“补充说明”，而是主Agent决定“是否为该修复追加回归扫描”的**唯一依据**。

#### 3.1 `affected_issues` 的语义与最小要求

`affected_issues` 必须列出**当前轮次中已发现且仍未闭合的其他缺陷 ID**，这些缺陷可能因为本次修改而改变状态（被修复、被加剧、或触发条件发生变化）。修复Agent不需要为每一条给出完整分析，但必须至少覆盖以下三类：

1. **共享同一函数/模块的缺陷**：如果 `target_files` 中的某个函数被另一个缺陷的 `evidence.file:line` 引用，该缺陷必须出现在 `affected_issues` 中。
2. **依赖被修改符号的缺陷**：如果本次修改改变了某个函数的行为、返回值或异常抛出条件，所有引用该函数作为调用链一部分的缺陷都应被列出。
3. **与本次修改处于同一 `dimension` 的缺陷**：如果同一切片的其他缺陷属于同一维度（例如同为 `logic`），它们可能在修复后被“顺带”改变，修复Agent应当列出它们并要求验收波复查。

**如果 `affected_issues` 为空数组**，修复Agent必须在 `residual_risks` 中写入 `AFFECTED_ISSUES_EMPTY_CONFIRMED`，并说明“已检查当前轮次所有未闭合缺陷，无共享符号或依赖关系”。**不允许**静默返回空数组而不做确认——空数组必须是一个被检查过的结论，而不是“没看”。

#### 3.2 `residual_risks` 的枚举化标记

`residual_risks` 是一个字符串数组，但其中的每一条应当以**固定的标记前缀**开头，以便主Agent和验收Agent机械识别：

| 标记 | 含义 | 对验收波的影响 |
|---|---|---|
| `LARGE_PATCH` | 变更行数超过 10 行或跨多个生产文件 | 验收波必须追加回归扫描 |
| `PUBLIC_API_CHANGE` | 修改改变了公共接口签名或返回形状 | 验收波必须检查所有调用方 |
| `BASELINE_UNVERIFIED` | 修改前无法运行 `disproof_condition` | 验收波必须先确认基线可触发 |
| `TEST_CONFLICT` | 现有测试与正确修复矛盾，修复Agent未修改测试 | 验收波或人工必须裁决测试的取舍 |
| `IMPACT_UNVERIFIED` | 修复Agent无法判断影响范围 | 验收波必须为该修复追加独立回归扫描 |
| `OBSERVED_BUT_OUT_OF_SCOPE` | 修改过程中看到了范围外的问题 | 主Agent可据此在后续轮次派发新审计 |
| `ROLLBACK_UNAVAILABLE` | 无法提供可执行的 `rollback_command` | 主Agent必须标记该修复为高风险，验收失败时需人工回滚 |

**`IMPACT_UNVERIFIED` 的触发条件**：如果修复Agent修改了某个被切片外文件引用的符号，但它**没有读取**那些外部引用文件（因为读取范围受限于 `target_files` 和 `shared_dependencies`），它**必须**写入 `IMPACT_UNVERIFIED`。这比“声称影响范围很小”诚实得多，也直接触发验收波的回归扫描，符合 silent regression 防御的原则[^ref10]。


## 第 4 节：验证命令的纪律——辅助证据，不是验收结论

修复Agent的 `verification_commands` 必须满足以下格式和纪律：

```json
{
  "verification_commands": [
    {
      "command": "pytest tests/dispatch/test_pipeline.py::test_missing_agent -x",
      "result": "passed",
      "output_snippet": "1 passed in 0.42s",
      "directly_observes_defect": true
    }
  ]
}
```

**`directly_observes_defect` 的语义**：如果该命令的输出**直接**观察到了缺陷所声称的行为（或修复后该行为不再出现），标记 `true`。如果该命令只是通用测试套件的一部分，不直接瞄准该缺陷，标记 `false`。NeurIPS 的证据是：把测试预算花在**能瞄准故障的测试**上，比花在随机测试上有效得多；修复Agent自行编写并运行测试，如果没有瞄准缺陷，对验证几乎没有贡献[^ref11]。

**`result` 的枚举**：`passed` / `failed` / `not_run`。如果 `not_run`，必须在 `output_snippet` 中写明原因（例如 harness 不支持执行、依赖缺失、需要网络）。修复Agent**不得**将 `not_run` 伪装为 `passed`，也不得在 `failed` 的情况下继续返回 `SUCCESS`——如果验证命令失败且修复Agent无法在三次尝试内解决，它必须返回 `RETRYABLE_FAILURE` 或 `PERMANENT_FAILURE`，而不是带着失败的验证结果声称完成。

**三次尝试预算**：修复Agent对同一个 `finding_id` 最多执行**三次修改尝试**。一次尝试从代码/配置/测试期望发生变更时开始。只读检查不消耗预算。三次尝试后仍未通过 `disproof_condition`，修复Agent**必须**停止，返回 `PERMANENT_FAILURE`，并在 `error` 中写入 `attempts_exhausted: true` 和每次尝试的 `hypothesis` 与 `result` 摘要，而不是无限 patch-and-retry[^ref12]。


## 第 5 节：与 `handoff-schema` 的精确对接

修复Agent的返回不直接修改 Resume Packet；主Agent在接收并验证修复Agent的 `output-contract` 返回后，按以下规则更新 `handoff-schema` 的字段：

| 修复Agent返回字段 | 写入 Resume Packet 的位置 | 规则 |
|---|---|---|
| `files_touched` | `closed_waves[wave-4].artifact_paths` 的摘要中提及 | 只记录路径，不记录 diff 内容 |
| `affected_issues` | `open_items` 中新增 `kind: "AFFECTED_BY_FIX"` 条目 | 每一条 `affected_issues` 生成一个 `open_item`，`blocking: false`，`next_action: "REASSIGN_TO_VERIFY"` |
| `residual_risks` 中的 `LARGE_PATCH` / `PUBLIC_API_CHANGE` / `IMPACT_UNVERIFIED` | `open_items` 中新增 `kind: "REGRESSION_SCAN_REQUIRED"`，`blocking: true` | 阻止 wave-5 对该修复仅做单点验收；验收波必须包含回归扫描 |
| `residual_risks` 中的 `BASELINE_UNVERIFIED` | 写入对应 `open_item` 的 `summary`，并标记 `requires_baseline_confirmation: true` | 验收波第一步必须是基线确认 |
| `residual_risks` 中的 `TEST_CONFLICT` | `open_items` 中新增 `kind: "HUMAN_DECISION_REQUIRED"`，`blocking: true` | **不阻止本轮终止**：该条不记为已修复，进最终报告「待人工裁决」清单，本轮自动收尾并开下一轮 |
| `residual_risks` 中的 `ROLLBACK_UNAVAILABLE` | `deferred_items` 中新增一条，`requires_human_intervention: true` | 验收失败时无法自动回滚；该条标 `UNVERIFIED_TARGET` 进下一轮，**不等待人工** |
| `verification_commands` | 不写入 Resume Packet | 验收Agent**不得**读取修复Agent的验证命令作为验收依据；验收必须独立执行 |

**关键纪律**：修复Agent的 `verification_commands` **不进入** Resume Packet 的 `open_items` 或 `closed_waves` 摘要，因为验收Agent一旦看到“修复Agent说已经通过了”，就会倾向于复述而不是独立验证。验收Agent只从 `handoff-schema` 中的 `finding_ref` 和**原始验收标准**出发，修复Agent的执行记录留在其 `artifact_path` 指向的文件中，只供审计追溯，不作为验收输入。


## 第 6 节：失败与重派的特殊规则

修复Agent的失败处理比发现波更严格，因为它是**有副作用的**子Agent。

**`RETRYABLE_FAILURE`**：

- 修复Agent返回 `RETRYABLE_FAILURE` 时，主Agent**不自动重派**修复Agent，而是先检查 `error.error_type`：
  - `Timeout` / `ToolError`：如果 `files_touched` 为空（未发生写入），可以重派一个新实例，携带原始 `finding_ref` 和验收标准，**不继承旧实例的 patch**；
  - `InputValidationError` / `SchemaViolation`：不重派，标记 `CONTRACT_VIOLATION`，将缺陷回退到 `open_items`，由主Agent决定是否重新派发锐评波或证据补采；
  - 如果 `files_touched` **非空**（已发生部分写入），主Agent**必须**先执行 `rollback_command`（如果可用），确认基线恢复后，再决定是否重派。如果 `rollback_command` 不可用，标记 `deferred_items` 并写入 `requires_human_intervention: true`。

**`PERMANENT_FAILURE`**：

- 三次尝试预算耗尽，或修复需要超出最小安全差异的重构。主Agent将缺陷写入 `open_items`，`kind: "PERMANENT_FAILURE"`，`blocking: true`，最终报告显式暴露“该缺陷未能修复”。**不得**将修复任务推给验收波或主线程。

**`CONTRACT_VIOLATION`**：

- 越权写文件、缺少 `affected_issues`、`verification_commands` 缺失或伪造、未登记 `rollback_command`。主Agent作废该修复Agent的全部输出，**必须**执行回滚（如果可执行），然后派一个**全新的修复Agent实例**从原始缺陷重新执行。旧实例的 `files_touched` 和 `verification_commands` 不得作为新实例的输入。


## 第 7 节：返回前的自检清单（修复Agent执行）

修复Agent在发出 `output-contract` 返回前，必须逐项确认：

| 检查 | 通过条件 | 失败动作 |
|---|---|---|
| 单缺陷边界 | 只修改了与 `finding_id` 直接相关的代码，未顺带修复其他缺陷 | 回退范围外修改，写入 `OBSERVED_BUT_OUT_OF_SCOPE` |
| 写权限边界 | `files_touched` 全部在 `target_files` 或对应测试文件内 | 回退越界修改，返回 `CONTRACT_VIOLATION` |
| 最小安全差异 | 变更 ≤10 行（或已在 `residual_risks` 标记 `LARGE_PATCH`） | 标记 `LARGE_PATCH` 或缩小修改 |
| 修复契约前置 | `disproof_condition`、`baseline_result`、`rollback_command` 已登记 | 补登记或返回 `RETRYABLE_FAILURE` |
| `affected_issues` 完整 | 覆盖共享符号/依赖的缺陷，或空数组已标记 `AFFECTED_ISSUES_EMPTY_CONFIRMED` | 补全或标记确认 |
| 影响半径诚实 | 无法验证影响范围时标记 `IMPACT_UNVERIFIED` | 补标记 |
| 验证命令可追溯 | `verification_commands` 非空，`result` 枚举合法，`not_run` 有原因 | 补全或返回 `RETRYABLE_FAILURE` |
| 不自我验收 | 返回中不声称“已修复”“验收通过” | 删除该表述 |
| 未修改测试以通过 | 未删除/跳过/弱化测试断言；冲突时标记 `TEST_CONFLICT` | 恢复测试或标记 `TEST_CONFLICT` |
| 尝试预算 | 尝试次数 ≤3 | 返回 `PERMANENT_FAILURE`，`attempts_exhausted: true` |

---

## 参考来源

[^ref0]: [Active Remediation — Mechanics](https://raw.githubusercontent.com/event4u-app/agent-config/refs/heads/main/docs/guidelines/agent-infra/active-remediation-mechanics.md#1)
[^ref1]: [sdd-parallel](https://pypi.org/project/sdd-parallel/)
[^ref2]: [break-ai-fix-loops](https://opensmartroute.ai/marketplace/sickn33-agentic-awesome-skills-break-ai-fix-loops)
[^ref3]: [Risk Management for Parallel Claude Code Agents on Desktop](https://callsphere.ai/blog/risk-management-for-parallel-claude-code-agents-on-desktop)
[^ref4]: Aman Mehta, *Silent Regressions: The Verification Gap in Coding Agents*, NeurIPS 2026 Poster (Workshop 137562) — [规范地址](https://neurips.cc/virtual/2026/poster/171452)
[^ref5]: [Risk Management for Parallel Claude Code Agents on Desktop](https://callsphere.ai/blog/risk-management-for-parallel-claude-code-agents-on-desktop)
[^ref6]: [Active Remediation — Mechanics](https://raw.githubusercontent.com/event4u-app/agent-config/refs/heads/main/docs/guidelines/agent-infra/active-remediation-mechanics.md#1)
[^ref7]: Aman Mehta, *Silent Regressions: The Verification Gap in Coding Agents*, NeurIPS 2026 Poster (Workshop 137562) — [规范地址](https://neurips.cc/virtual/2026/poster/171452)
[^ref8]: [Active Remediation — Mechanics](https://raw.githubusercontent.com/event4u-app/agent-config/refs/heads/main/docs/guidelines/agent-infra/active-remediation-mechanics.md#1)
[^ref9]: [break-ai-fix-loops](https://opensmartroute.ai/marketplace/sickn33-agentic-awesome-skills-break-ai-fix-loops)
[^ref10]: Aman Mehta, *Silent Regressions: The Verification Gap in Coding Agents*, NeurIPS 2026 Poster (Workshop 137562) — [规范地址](https://neurips.cc/virtual/2026/poster/171452)
[^ref11]: Aman Mehta, *Silent Regressions: The Verification Gap in Coding Agents*, NeurIPS 2026 Poster (Workshop 137562) — [规范地址](https://neurips.cc/virtual/2026/poster/171452)
[^ref12]: [break-ai-fix-loops](https://opensmartroute.ai/marketplace/sickn33-agentic-awesome-skills-break-ai-fix-loops)
