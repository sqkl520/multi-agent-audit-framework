---
file: artifacts/report-naming.md
title: 报告命名与落盘（机械规则）
group_order: 5
loaded: 所有子 Agent在写出产物文件前加载；主Agent在生成最终报告时加载
source: 续写，遵守 orchestrator/protocol.md 第 1 节的裁量分级（L0 禁止 / L1 留痕 / L2 自由）
---

# artifacts/report-naming.md

> **加载时机**：所有子 Agent 在写出产物文件前加载；主 Agent 在生成最终报告时加载。
> **职责边界**：只定义文件名规则和最终报告的拼接规则。不定义报告内容、不定义审查逻辑。

## 第 1 节：文件命名规则

```
round{RN}-{stage}-{discriminator}.md
```

| 片段 | 定义 | 示例 |
|---|---|---|
| `round{RN}` | 轮次号，来自 `artifacts/round-detection.md`，无前导零、无后缀 | `round30` |
| `{stage}` | 波次标识，固定两位数字 + 短名 | `01-recon`、`02-sweep`、`02-audit`、`03-critique`、`04-fix`、`05-verify` |
| `{discriminator}` | 区分同一波次内多个实例的稳定标识 | `slice-07`、`slice-07-logic`、`skeptic`、`fix-017` |

**校验正则**：

```
^round(\d+)-(01-recon|02-sweep|02-audit|03-critique|04-fix|05-verify)-[a-z0-9]+(-[a-z0-9]+)*\.md$
```

**全路径**：`docs/reports/round{RN}/{文件名}`。

> **2026-11-03 修订：`02-sweep` 是新增的合法 stage。** 此前 `{stage}` 只有五个值，而两遍制的宽扫波（`templates/wave2a-sweep.md`）**没有对应的 stage 名**——但 `protocol.md` 第 1.2 节的 L1 留痕示例里已经引用了 `round31-02a-sweep-slice-31.md`，这个文件名**不匹配任何一个合法 stage**，会被本节的校验正则判为非法。宽扫产物无处可写，其 `artifact_ref` 必然悬空。现在统一为 `02-sweep`（与 `02-audit` 同为波次二的两个子阶段，用短名区分）。
>
> **旧名 `02a-sweep` 不向后兼容**：历史文件仅存在于示例中，无实际产物，不需要迁移。

**禁止的命名**：

- 时间戳后缀（`round30-02-audit-slice07-20261101.md`）——破坏幂等，重跑会产生新文件；
- 递增版本号（`-v2`、`-final`、`-final2`）——同上；
- 中文或空格——跨平台路径问题；
- 超过一个连字符的波次名（必须是固定的 `01-recon` / `02-sweep` / `02-audit` / `03-critique` / `04-fix` / `05-verify` 六个之一）。

## 第 2 节：`{stage}` 与 `{discriminator}` 的取值

| 波次 | `{stage}` | `{discriminator}` 构成 | 完整示例 |
|---|---|---|---|
| 一·侦察 | `01-recon` | `slices`（固定常量，无论派出几个侦察实例都用同一个 discriminator） | `round30-01-recon-slices.md` |
| 二A·宽扫 | `02-sweep` | `{slice_id}`（**一个切片一个实例**，不带维度） | `round30-02-sweep-slice-07.md` |
| 二B·深挖 | `02-audit` | `{slice_id}-{dimension}` | `round30-02-audit-slice-07-logic.md` |
| 三·锐评 | `03-critique` | `{critique_role}` | `round30-03-critique-skeptic.md` |
| 四·修复 | `04-fix` | `fix-{finding序号}` | `round30-04-fix-017.md` |
| 五·验收 | `05-verify` | `verify-{finding序号}` | `round30-05-verify-017.md` |

**`discriminator` 的稳定性要求**：同一 `(round, stage, discriminator)` 三元组必须唯一。若一个实例被重派（`RETRYABLE_FAILURE` 后），新实例**覆盖**同名文件，而不是追加 `-v2`。理由：重派意味着旧输出已作废，保留旧文件会让最终报告误把作废内容计入。

**禁止的命名**：

- 时间戳后缀（`round30-02-audit-slice07-20261101.md`）——破坏幂等，重跑会产生新文件；
- 递增版本号（`-v2`、`-final`、`-final2`）——同上；
- 中文或空格——跨平台路径问题；
- 超过一个连字符的波次名（必须是固定的 `01-recon` 等五个之一）。

## 第 3 节：最终报告的结构

最终报告 `docs/reports/round{RN}/round{RN}-final-report.md`，**只做拼接和索引，不重写任何子 Agent的结论**。

固定五个部分，顺序不变：

1. **元信息**：`round_id`、开始/结束时间、`trace_id`、`scale_decision` 摘要（`effective_slices`、`concurrency_window`、`agent_count`）。
2. **裁决索引表**：一行一条 `UPHELD` / `DOWNGRADED` / `REVOKED` 的发现，列 `finding_id`、原文 `severity`、最终裁决、`artifact_ref`。
3. **验收结果表**：一行一条修复，列 `finding_id`、`verdict`、`escalation_required`、`failure_category`（若有）、`artifact_ref`。
4. **未闭合项**：直接来自 `handoff-schema` 的 `open_items` 中 `blocking: true` 的条目，原样转写，不改写措辞。
5. **覆盖说明**：`deferred_slices` 与 `unverified` 的完整列表；若 `deferred_slices` 超过 `effective_slices` 的 50%，必须在此显式标注"本轮覆盖不完整"。

**"只拼接不重写"的操作定义**：

- 汇总文件的**每个结论单元**必须带 `artifact_ref` 指向原始文件；
- 主Agent不得修改原始文件中的任何措辞、严重性、裁决结论；
- 主Agent可以做的只有三件事：排序、加索引、加统计数字（统计必须可复核，即读者能按索引自行数出同样的结果）。

## 第 4 节：目录结构（2026-11-05 定版）

```
docs/reports/
├── round1/
│   ├── round1-01-recon-slices.md
│   ├── round1-02-sweep-slice-01.md
│   ├── round1-02-audit-slice-01-logic.md
│   ├── round1-03-critique-skeptic.md
│   ├── round1-04-fix-017.md
│   ├── round1-05-verify-017.md
│   ├── round1-final-report.md      ← 必交付 ①
│   └── round1-ledger.md            ← 必交付 ②
├── round2/
└── round3/
```

**一层：一轮一个文件夹，所有产物平铺在里面。** 不再分子目录。

| 项 | 规定 |
|---|---|
| 轮次如何确定 | 读 `docs/reports/` 下已有的 `round{N}/`，取 `max(N)+1`。详见 `round-detection.md` |
| 目录谁创建 | **主 Agent 在波次一启动前创建**（见 §5.1） |
| 新建位置 | **只在 `docs/reports/round{N}/` 下**，不得建子目录、不得散落到别处 |
| 交付物 vs 过程日志 | 同目录并存，靠文件名区分（见 §4.1） |

### 4.1 必交付文件：两类，缺一不可

**「交付物」是一次运行结束后，用户真正要拿走的东西。只有两类：**

| # | 文件 | 读者 | 作用 |
|---|---|---|---|
| ① | `round{N}-final-report.md` | **人** | 结论：发现了什么、覆盖了多少、还剩什么 |
| ② | `round{N}-ledger.md` | **机器 / 人** | 状态：每个切片怎样了、预算花在哪、失败为什么 |

**其余波次产物（`01-recon` / `02-sweep` / `02-audit` / `03-critique` / `04-fix` / `05-verify`）是过程日志**，不作为交付物，但必须留在同目录下供追溯。

> **为什么必须分开**：用户不需要读 20 个波次产物才知道结论是什么。**如果一份运行结束后，用户要自己翻文件拼结论，那这次交付就是失败的。**

### 4.2 两类交付物的强制结构

#### ① `round{N}-final-report.md` —— 固定六节，顺序不变

```markdown
# round{N} 审计报告

## 0. 一句话结论
（不超过 3 行。这轮到底审出了什么、覆盖多少、能不能信）

## 1. 元信息
| 项 | 值 |
|---|---|
| round_id | round{N} |
| trace_id | ... |
| 开始 / 结束 | ISO8601 / ISO8601 |
| 状态 | CLOSED \| PARTIALLY_CLOSED \| BLOCKED |
| 被审仓库 | 绝对路径 |
| 是否自动续轮 | 否 / 是（母轮 round{M}，链序号 k/max） |

## 2. 覆盖说明
| 项 | 数值 | 口径 / 复核命令 |
|---|---|---|
| 规划切片 | N | 源：`round{N}-01-recon-slices.md` |
| 完成 | N | 源：`ledger.md` 的 slices 表 |
| 失败 | N | 分类见 §3 |
| DEFERRED | N | |
| **覆盖率** | N/N = xx% | `完成 / 规划` |

**未覆盖清单**：逐条列出 `slice_id` + 原因。

## 3. 发现汇总
| finding_id | 严重性 | 位置 | 一句话 | 裁决 | artifact_ref |
|---|---|---|---|---|---|

（每条必须有 `artifact_ref` 指向具体产物文件；主 Agent 不得改写子 Agent 的措辞）

## 4. 失败与未闭合
| item | error_type | 观察到的现象 | 重派策略 / 处置 |
|---|---|---|---|

## 5. 零写入自证
（原样粘贴 `git status --short | grep -E '^ ?[MDARC]'` 的真实输出）

## 6. 下一步
（若有 DEFERRED：说明是否已自动开下一轮；若已停止：说明停止原因）
```

**六节缺一不可。** 缺节的报告视为未完成，`status` 不得写 `CLOSED`。

#### ② `round{N}-ledger.md` —— 从 `state.json` 机械生成

```markdown
# round{N} 账本

## 1. 切片状态表
| slice_id | 状态 | 文件数 | 行数 | 线索/发现数 | attempt | 产物 |
|---|---|---|---|---|---|---|

## 2. 预算
| total_cap | spent | 剩余 | 说明 |
|---|---|---|---|

## 3. 失败分类
| slice_id | error_type | artifact_bytes | last_write_at | inferred_cause | 重派策略 |
|---|---|---|---|---|---|

## 4. 裁量日志（discipline_log）
| seq | 波次 | 类型 | 动作 | 依据 | 机械复核方法 |
|---|---|---|---|---|---|

## 5. 轮次链（若自动续轮）
| 轮次 | 覆盖 | 新增发现 | DEFERRED 剩余 | 状态 |
|---|---|---|---|---|
```

**账本必须能从 `state.json` 机械生成**——它不该包含任何 `state.json` 里没有的信息。审核方式是：读者能按账本里的数字自己去 `state.json` 里数出同样的结果。

> **为什么账本要用 Markdown 而不是直接给 `state.json`**：`state.json` 是给程序读的，字段名对人不友好且不能加注释。账本是它的可读投影，**两者必须一致**，不一致时以 `state.json` 为准。

### 4.3 交付完成的判定

一轮结束后，`docs/reports/round{N}/` 下**至少**要有：

```
round{N}-final-report.md     存在且非空，六节齐全
round{N}-ledger.md           存在且非空，五节齐全
```

缺任何一个 → 本轮 `status` 不得为 `CLOSED`，只能在 `PARTIALLY_CLOSED` 或 `BLOCKED` 之间选。

**检查命令**：

```bash
node <FRAMEWORK_ROOT>/tools/check-deliverables.mjs --round-dir "docs/reports/round3"
```

**向后兼容**：历史上存在 `round16/` ~ `round29/` 目录与 `round2-audit.md` 等散落文件（两种命名风格）。本规则**只约束新产出**，不要求重命名历史文件。`artifacts/round-detection.md` 的探测逻辑同时兼容两种形态。

## 第 5 节：写入纪律

| 规则 | 说明 |
|---|---|
| 只写自己那一个文件 | 每个子 Agent只允许写入属于自己的产物文件，不得写其他的 |
| 不覆盖他人文件 | 唯一允许的覆盖是"自己重派后的自我覆盖"（见第 2 节） |
| 不写历史轮次目录 | 本轮产物只能写 `round{RN}/`，不得修改 `round{M}`（M ≠ RN） |
| 临时文件不入库 | 复现脚本等临时产物写入系统临时目录，路径在 `payload` 中说明 |
| 不创建额外目录 | 除 `round{RN}/` 外不新建目录 |

### 5.1 目录的创建责任（2026-11-03 新增）

**此前没有任何一条规则说 `round{RN}/` 目录由谁创建。** 而 `output-contract.md` §1 现在要求 `artifact_path` 指向的**文件必须存在**，否则判 `CONTRACT_VIOLATION`——如果目录不存在，**每个子 Agent 的第一次写入都会失败，且每次重派都会同样失败**（这正好是 F2「系统性契约缺陷」那一类）。

**规则：目录由主 Agent 在派发前创建，不由子 Agent 创建。**

| 阶段 | 动作 | 失败处理 |
|---|---|---|
| 波次一启动**之前** | 主 Agent 执行 `mkdir -p <OUTDIR>/round{N}/`，并写入 `state.json` 的 `report.dir_ready: true` | 创建失败 → 返回 `PERMANENT_FAILURE`，`error_type: "ToolError"`，**不得开始派发** |
| 每个子 Agent 写入前 | **只验证**目录存在（`ls`），**不创建** | 不存在 → `RETRYABLE_FAILURE`，`failed_at: "<path>"`，说明「目录缺失，非本 Agent 责任」 |

**为什么由主 Agent 创建，而不是让第一个写入的子 Agent 顺手创建**：

| 理由 | 说明 |
|---|---|
| **并发竞态** | 宽扫波可能同时派出 10+ 个 Agent。若各自 `mkdir -p`，在部分文件系统上会互相干扰；更糟的是「谁先跑谁建」意味着顺序不同则行为不同，**不可复现** |
| **失败归因清晰** | 目录缺失是**调度层的错**，不是审计 Agent 的错。让子 Agent 建目录会把调度缺陷伪装成子 Agent 失败，重派多少次都没用 |
| **符合只读原则** | 子 Agent 的 `Write` 权限写的是「自己的产物文件」，`mkdir` 是**创建目录**，不在这个授权范围内。让它们建目录等于悄悄扩大权限 |
| **写入面单一** | 主 Agent 已经有「写账本与报告」的职责，创建报告目录是它的自然延伸，不新增角色能力 |

**主 Agent 需要 `Bash` 才能执行 `mkdir -p`**——这落在 `protocol.md` §1.5 白名单的「只读核验」之外，属于**唯一被允许的写盘命令**，且**只能作用于 `<OUTDIR>`，绝不可作用于被审仓库**：

```bash
# 允许：在仓库外的产物目录下建本轮目录
mkdir -p "<OUTDIR>/round${N}"

# 禁止：任何形式的 mkdir 作用于被审仓库
mkdir -p "<被审仓库>/docs/reports/round${N}"   # ← 只有在 git check-ignore 通过后才允许，
                                                 #    见 protocol.md §0.2
```

> **这条新增本身是个例证**：我上一轮给契约加了「`artifact_path` 指向的文件必须存在」，却没定义「父目录谁建」。**新加的强制校验会在真实运行的第一步就全线失败**——而当时我以为自己修好了。机械规则的价值在于它会立刻暴露这类遗漏；自然语言规则则会让它一直藏着，直到有人真跑一遍。

### 5.2 `<OUTDIR>` 的路径限制：必须无空格（2026-11-04 实测新增）

**`<OUTDIR>` 的完整路径不得包含空格、中文或任何需要 shell 转义的字符。**

```bash
# ✅ 允许
D:/audit-out/round1-web-style
/workspace/audit/round31

# ❌ 禁止
"<WORKSPACE>/many-agents_multi-prompt-files_token-heavy/audit-runs"   # 含空格
D:/审计报告/round31                                                              # 含中文
```

**理由不是洁癖，是一次实测事故**：

| 时长 | 事件 |
|---|---|
| 28 分钟 | recon-1 零输出 |
| 20 分钟 | recon-1b 零输出 |
| 42 分钟 | sweep-slice-01 输出 643KB，**产物一次都没写成功** |

从子 Agent 的 transcript 里挖出的根因：

```json
{"toolDenialKind":"user-rejected",
 "content":"The user doesn't want to proceed with this tool use..."}
```

**含空格的路径触发了工具调用的权限确认；子 Agent 没有交互界面，确认请求被自动拒绝。** 它既不报错也不返回失败——只是继续分析直到超时，外观与「正在正常工作」完全一样。

换成无空格路径 `D:/audit-out/round1-web-style` 后，**同一份任务书，产物在第 1 分钟就落地了**。

**派发前的强制自检**（主 Agent 必须在 `mkdir` 之后执行）：

```bash
OUT="<OUTDIR>/round${N}"
mkdir -p "$OUT" || { echo "目录创建失败"; exit 1; }
touch "$OUT/.write-probe" 2>/dev/null && rm "$OUT/.write-probe" \
  || { echo "❌ 目录不可写或路径含特殊字符，中止派发"; exit 1; }
case "$OUT" in *" "*|*[! -~]*) echo "⚠️ 路径含空格或非 ASCII，极可能导致子 Agent 写盘被静默拒绝"; exit 1;; esac
echo "✅ 产物目录就绪: $OUT"
```

**子 Agent 侧的对策**：若收到 `user-rejected`（工具调用被拒绝），**必须立即返回 `PERMANENT_FAILURE`**，`error_type: "ToolError"`，`message: "产物写入被权限系统拒绝，疑似路径含特殊字符"`。**不得静默继续分析**——这会让一次 1 秒钟就能定位的配置问题，伪装成一次 40 分钟的正常运行。

> **为什么这条特别值得记**：`report-naming.md` §2 早已写了「禁止的命名：……**中文或空格**……」——但那条约束的是 **`round{N}-{stage}-{discriminator}.md` 这个文件名**，从没管过 `<OUTDIR>` 这个**目录**。**一个字的适用对象差异，让整条链路瘫了 90 分钟，且外观完全正常。**

**主Agent的写权限**：主 Agent 只写两个文件——账本（由 harness 提供）与最终报告 `round{N}-final-report.md`。它**不得**写任何波次产物文件。

> **2026-11-03 修订说明**：本表与上一条的**读者是不同角色**，此前没有说清，导致 13 份锐评里有 3 份独立判定「没有任何角色被授权写产物」。
>
> | 规则 | 约束对象 | 含义 |
> |---|---|---|
> | 「只写自己那一个文件」 | **子 Agent** | 每个子 Agent 有 `Write`，但只能写自己的产物 |
> | 「主 Agent 不得写任何波次产物」 | **主 Agent** | 它只写最终报告，不代写任何子 Agent 的产物 |
>
> 两条合起来才是完整规则：**产物由产生它的子 Agent 自己写，主 Agent 只拼最终报告。** 此前子 Agent 的 `tools` 里没有 `Write`，而本表假设它们「只写自己那一个文件」——**规则要求它们做一件它们在物理上做不到的事**。这是框架能静默产出「格式完美、结论为空」的报告的根因，已在 2026-11-03 的 wrapper 修订中补齐（`recon` / `sweep` / `audit` / `critique` / `verify` 五个角色均获得 `Write`，且明确限定只能写自己的产物路径）。

## 第 6 节：幂等与冲突

| 情形 | 处理 |
|---|---|
| 同一文件被重复写入（重跑同一实例） | 覆盖，内容以最后一次为准 |
| 两个实例试图写同名文件 | 说明 `discriminator` 设计有误——同一 `(round, stage, discriminator)` 应只对应一个实例。主Agent发现冲突时作废两者并按 `protocol.md` 重派 |
| 目标目录已存在同名历史文件（跨轮次冲突） | 不可能发生（路径含 `round{RN}`），除非 `round_id` 被中途改动——见 `round-detection.md` 第 7 节 |
| 写入失败（磁盘满、权限） | 返回 `PERMANENT_FAILURE`，`error_type: "ToolError"`，不得假装成功 |

## 第 7 节：自检清单

| 检查 | 通过条件 |
|---|---|
| 文件名合规 | 匹配第 1 节的正则 |
| 路径在正确轮次 | 全路径以 `docs/reports/round{RN}/` 开头 |
| `discriminator` 唯一 | 同一 `(round, stage, discriminator)` 本批次只一个实例 |
| 未越权写入 | 只写了自己的产物文件 |
| 最终报告只做索引 | 每个结论单元带 `artifact_ref`，未改写原文措辞 |
| 覆盖说明完整 | `deferred_slices` 与 `unverified` 全部列出，超 50% 有显式标注 |
