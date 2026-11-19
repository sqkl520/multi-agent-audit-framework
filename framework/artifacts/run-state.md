---
file: artifacts/run-state.md
title: 运行状态机（断点续跑的唯一依据）
group_order: 5
loaded: 主Agent全程维护；新对话续跑时首先加载
source: 续写（2026-11-01）。解决 round31「跑不完、断了接不上、无最终报告」问题
---

# artifacts/run-state.md

> **加载时机**：主 Agent 在整轮运行中持续维护；**新对话续跑时，这是第一个要读的文件**。
> **职责边界**：只定义「状态存在哪、怎么写、怎么续」。不定义审计逻辑、不定义报告内容。

---

## 第 1 节：为什么需要它

框架原有的 `handoff-schema.md` 只解决**波次之间**传什么，它是内存中的账本，对话一结束就没了。

真实运行证明这不够：

| 事实 | 后果 |
|---|---|
| round31 停在 `IN_PROGRESS`，83 条待修复只做了 1 条 | 40 个审计 agent + 4 个锐评 agent 的产出，停在下游无法直接消费的半成品上 |
| 网关 502 在 launcher 项目里**连续掐断 agent**（R15 掐断 B1d×2、B1e×2、L3；R16 六路调查掐断四路） | 中断是常态，不是意外 |
| R22：红队 agent 100 分钟没更新输出文件，主代理据此判定"静默中断"并重跑 | **两个实例并发写同一文件，后写的覆盖先写的** |
| 账本记 22 个实例，实际产物 ≥47 个 | 账本不是可靠的事实来源 |

**结论：状态必须落盘，且必须能回答「哪些真的做完了」。**

---

## 第 2 节：状态文件

**路径**：`docs/reports/round{N}/state.json`（与轮次产物同目录，随仓库一起留存）

**`budget` 中五个计数字段的用途**（2026-11-03 新增前四个；2026-11-15 新增 `spawned_fix_agents`。`protocol.md` 第 3.1 节要用它们算失败率阈值，此前 `state.json` 里没有对应字段——阈值规则写着却没有分母）：

| 字段 | 含义 | 何时写入 | 为什么不能用别的字段替代 |
|---|---|---|---|
| `planned_sweep_agents` | 波次二A 计划派发的宽扫实例数 | 波次二A 启动**前**冻结 | 是**计划**，用作 2a 失败率的分母 |
| `spawned_deep_dive` | 波次二B **实际**派发的深挖实例数 | 每次派发后 +1 | 是**事实**。2b 失败率必须用它当分母，用 `discovery_budget`（计划）会在「预算没用完就停了」时把失败率算小，从而错误放行覆盖不足的一轮 |
| `failed_sweep` | 宽扫中 `PERMANENT_FAILURE` 的实例数 | 每次判定终态时 +1 | 2a 失败率的分子 |
| `failed_deep_dive` | 深挖中 `PERMANENT_FAILURE` 的实例数 | 每次判定终态时 +1 | 2b 失败率的分子 |
| `spawned_fix_agents` | 波次四（`wave4`）**实际**派发的修复实例数 | 每次派发后 +1 | 与 `fix_contracts` 的 `finding_id` 去重数对账：多条独立缺陷却只有 1 个实例，说明是单实例串行，`stop-hook.mjs` 会拒绝闭合该相位 |

**硬规则：五个字段都只能由实际计数写入，不得估算。** 与 `budget.spent` 同一条纪律（见第 4 节规则 3）——round31 的 `spent=22` vs 实际 ≥47 就是估算的后果。估算出来的失败率会让阈值判定失去意义。

> **`spawned_fix_agents` 为什么必须是「实际计数」**（2026-11-15 新增）：它是 `wave4` 唯一能识别「多缺陷单实例串行」的字段。若由主 Agent 估算（比如「我大概修了 3 个」），这个对账立刻失效——它记录的就不再是派发事实，而是主 Agent 对自己工作的印象，和被审计的对象是同一个人。字段缺失时一律按 0 处理：**账本没记录等于没发生**。

```json
{
  "schema_version": "run-state-v1",
  "trace_id": "trace-r31-20261101-a7f3c9",
  "round_id": "round31",
  "path_mode": "AUDIT_ONLY | FIX",
  "phase": "init | wave1 | wave2a | wave2b | wave3 | wave4 | wave5 | report | closed",
  "status": "RUNNING | PARTIALLY_CLOSED | CLOSED | BLOCKED",
  "target_repo": "path|null — 被审仓库绝对路径。FIX 路径下必填（缺或指向不存在的目录则报 target_repo_required，见第 2 节）",

  "budget": {
    "total_cap": 60,
    "spent": 45,
    "reserved_for_downstream": 20,
    "planned_sweep_agents": 40,
    "spawned_deep_dive": 12,
    "failed_sweep": 2,
    "failed_deep_dive": 1,
    "spawned_fix_agents": 0
  },

  "slices": {
    "slice-01": {
      "state": "DONE | RUNNING | PENDING | FAILED | DEFERRED",
      "files": ["src/a.js", "src/b.js"],
      "reachability": "PROD | ENTRY | TEST_ONLY | UNREACHABLE | GENERATED | null",
      "sweep_artifact": "path|null",
      "lead_count": 0,
      "deep_dive_dims": ["logic"],
      "deep_dive_done": ["logic"],
      "deep_dive_pending": [],
      "artifact_paths": [],
      "attempt": 1,
      "failure": {
        "error_type": "SKELETON_ONLY | TOOL_REJECTED | NO_OUTPUT | EMPTY_RESULT | CONTRACT_VIOLATION | null",
        "observed": "string|null",
        "artifact_bytes": 0,
        "last_write_at": "ISO8601|null",
        "inferred_cause": "string|null"
      }
    }
  },

  "in_flight": [
    {
      "agent_id": "string",
      "slice_id": "string",
      "task": "sweep | deep_dive | critique | fix | verify",
      "started_at": "2026-11-01T21:40:00Z",
      "heartbeat": "2026-11-01T21:52:00Z"
    }
  ],

  "current_plan": {
    "phase": "wave2a — 必须与 state.phase 逐字相同；FIX 路径取 wave4 / wave5",
    "written_at": "ISO8601",
    "steps": [
      { "id": 1, "action": "派 16 个宽扫 agent", "done_when": "16 个全部到终态" }
    ],
    "exit_condition": "全部 agent 终态 + 账本更新完",
    "current_step": 1,
    "revised_at": "ISO8601|null",
    "revision_reason": "string|null"
  },

  "discipline_log": [ ],

  "failure_stats": {
    "NO_OUTPUT": 0,
    "SKELETON_ONLY": 0,
    "TOOL_REJECTED": 0,
    "EMPTY_RESULT": 0,
    "CONTRACT_VIOLATION": 0
  },

  "wave2_completed": [
    {
      "agent_id": "string",
      "slice_id": "string",
      "task": "sweep | deep_dive",
      "dimension": "logic | concurrency | security | error-handling | data-consistency | contract | null",
      "dispatched_at": "ISO8601",
      "terminal_at": "ISO8601",
      "final_status": "SUCCESS | PERMANENT_FAILURE",
      "artifact_path": "path|null",
      "lead_or_finding_count": 0,
      "dimension_assigned_by_discretion": false
    }
  ],
  "report": {
    "dir_ready": false,
    "dir_path": "path|null — FIX 路径进入 wave4/wave5 且 fix_contracts 非空时必填（缺则 report_dir_required，见 2.6.2）",
    "final_report_path": "path|null — 同上；与 dir_path 至少一个非空。AUDIT_ONLY 路径下 report 整个字段可以缺席",
    "written_at": "ISO8601|null",
    "is_complete": false
  },

  "legacy_artifacts": [
    "done-1.md — 可选字段。列被豁免的无信封历史产物（只写文件名）。见第 2.6 节"
  ],

  "fix_baseline": {
    "captured_at": "ISO8601 — wave4 开始（派发第一个修复实例之前）抓基线的时刻。留痕用，不用于判定。缺失则 WARN",
    "dirty_paths": ["src/legacy/A.java", "repair-artifacts/"],
    "head": "commit sha — 抓基线时的 HEAD。留痕与诊断用。缺失则 WARN"
  },

  "fix_contracts": [
    {
      "finding_id": "string",
      "fix_agent_id": "string",
      "registered_at": "ISO8601 — 必须在第一次 Edit 之前",
      "defect_statement": "string — 当 X 时，Y 会发生，预期是 Z",
      "disproof_condition": "string — 一个可观察的检查",
      "baseline_result": "string|null — 修改前运行 disproof_condition 的实际输出与退出码",
      "baseline_unverified": false,
      "rollback_command": "string",
      "test_path": "string — 不存在则写 需新建",

      "verdict": "PASS | FAIL — wave5 写入。带保留通过写 PASS + escalation_required:true",
      "escalation_required": false,
      "verified_at": "ISO8601 — 有 verdict 时必填，供与 files_touched 的 mtime 对账"
    }
  ]
}
```

> **`verdict` 只由 `wave5`（验收相位）写入，`wave4` 期间必须缺席**（2026-11-15 新增）：一端是「登记了但没人验」，另一端是「验过且给出结论」，两者不能混。修复实例**不得**自己填 `verdict`——`wave4-fix.md` §1「不做自我验收」的依据是 NeurIPS 的对照数据：修复者自证既不能提高解决率，也不能降低回归率。`check-state.mjs` 只校验已写出的 `verdict` 是否为闭集内的值，不强制它存在；**强制它存在的是 `stop-hook.mjs` 的 `wave5` 交付物检查**——因为「可以暂时没有」和「相位可以闭合」是两个问题，前者由 schema 回答，后者由相位门回答。

**`fix_contracts` 为什么必须进账本**（2026-11-09 新增）：`templates/wave4-fix.md` §2 要求修复 Agent 在**第一次编辑之前**登记五个前置字段，原文写的是「在内部（或账本的 `fix_contract` 字段中）」。但 `state.json` 里此前**没有这个字段**——和 `wave2_completed` 当初的情况一模一样：规则要求往一个不存在的地方写。

**「在内部」不是一个可接受的落点**。子 Agent 的内部推理不会被落盘，主 Agent 读不到，验收波也读不到，`rollback_command` 也就无人可用。因此：

| 规则 | 判定 |
|---|---|
| `registered_at` 必须**早于**该 `finding_id` 对应的第一个 `files_touched` 的 mtime | 晚于 = 事后补写，判 `CONTRACT_VIOLATION` |
| `baseline_result` 为 `null` 时，`baseline_unverified` 必须为 `true` | 两个都空 = 没做也没声明，判 `CONTRACT_VIOLATION` |
| `baseline_unverified: true` | 验收波必须额外执行「基线确认」步骤（见 `wave5-verify.md` §4） |
| `rollback_command` 为空 | 验收失败时无法机械回滚，该修复标 `ROLLBACK_UNAVAILABLE` |

**`report.dir_ready` 是派发前的硬闸**（2026-11-03 新增）：`output-contract.md` 要求 `SUCCESS` 的 Agent 有一个**真实存在**的产物文件，而产物目录必须由主 Agent 在波次一启动前建好（见 `report-naming.md` §5.1）。

| 字段 | 规则 |
|---|---|
| `dir_ready` | 为 `false` 时**不得派发任何子 Agent**。建目录成功后置 `true`，同时写 `dir_path` |
| `dir_path` | 本轮产物目录的绝对路径，供子 Agent 拼 `artifact_path` |
| `dir_path` / `final_report_path`（FIX 路径） | `path_mode = FIX` 且 `phase ∈ {wave4, wave5}` 且 `fix_contracts` 非空时，两者**不能都为空** —— 条件必填，缺则 `check-state.mjs` 报 `report_dir_required` 且 `stop-hook.mjs` 拒绝闭合。见第 2.6.2 节 |

> **为什么它是一个硬闸而不是一句提醒**：目录缺失会让**每一个**子 Agent 的写入失败，且重派不会好转——这正是 `protocol.md` §4.1 定义的「系统性契约缺陷」。放在派发前检查，一次就拦住；不检查则要等所有 Agent 失败一遍才发现。

**`target_repo`：被审仓库在哪（2026-11-16 / R16a 新增）**

| 字段 | 规则 |
|---|---|
| `target_repo` | 被审仓库根的**绝对路径**，`string\|null`。`path_mode = FIX` 且 `phase ∈ {wave4, wave5}` 且 `fix_contracts` 非空时必须非空**且解析后是一个真实存在的目录**，否则 `check-state.mjs` 报 `target_repo_required`。**不在 `TOP_REQUIRED` 里**——AUDIT_ONLY 路径可缺席，存量账本不会一夜不合规 |
| 谁写 | 主 Agent 建产物目录的那一步一起写（即 `report.dir_ready` 置 `true` 的同一步，见 `report-naming.md` §5.1）。位置在顶层，不在 `report` 下 |

**为什么需要这个字段**：`check-payload.mjs` 有两条规则 `red_log_not_found` / `test_path_not_found`，
它们要判断「信封里写的 `red_log_path` / `test_path` 真的存在吗」。而这两条路径通常是**相对路径**（相对被审仓库根），
`check-payload` 只有拿到 `--repo <被审仓库根>` 才能把它们解析成绝对路径去 `existsSync`。
没有 `--repo` 时它判定不了，只能降级成 `evidence_existence_unchecked` **WARN** 而不是 FAIL——
也就是说，**「证据文件是否真的存在过」这一整项检查被跳过**，只留下路径形状检查（见 `check-payload.mjs` 规则 1 / 2 之后的降级分支）。
在 `target_repo` 之前，`state.json` 里**没有任何字段记录被审仓库在哪**，于是每一次接收产物都只能由主 Agent 自己决定要不要传 `--repo`——
而正是那个「忘了传」的时刻，降级路径会静默生效。

**它不是自述吗？承认。** `target_repo` 由主 Agent 自己写，它可以指向一个假仓库，甚至指向一个存在但无关的目录。
这一层防不住存心造假。但它仍然值得存在，因为两类失效形态在**可追溯性**上完全不同：

| 失效形态 | 事后能不能看出问题 |
|---|---|
| `target_repo` 指向一个假仓库 | 能。路径写在账本里，任何人拿它一试就知道对不对；它和 `fix_contracts[].test_path`、产物路径是同一个坐标系，可以互相印证 |
| **根本不写 `target_repo`** | 不能。账本上没有任何关于「被审对象在哪」的记录，事后无法重建当时到底查没查，也无法重跑那次校验 |

**「指向一个假仓库」至少留了痕，「不写这个字段」连痕迹都没有。** 这与 R14 §6.1 的教训是同一条：
只验「字符串非空」等于没验——所以这里的判据不止要求非空，还要求 `resolve()` 之后**目录真实存在**。
（它仍然不能证明「这个目录就是被审仓库」；能证明这一点的只有独立来源，见 `check-payload.mjs` 的独立性约束。）

---

## 第 2.5 节：修复相位（`wave4`）与验收相位（`wave5`）（2026-11-15 新增）

### 2.5.1 为什么这两个相位此前不存在

`path_mode` 的枚举一直有 `FIX` 这个取值，但 `phase` 的枚举里没有任何一个值对应「正在修复」或「正在验收」。这不是笔误，是一处**结构性空洞**，后果是连锁的：

| 事实 | 后果 |
|---|---|
| `stop-hook.mjs` 的相位白名单按 `phase` 匹配，只有 `wave2a/wave2b/wave3` | **修复与验收阶段 hook 完全不触发**，框架唯一的硬手段（harness 强制）失效 |
| 框架自己认定「提示词是最弱的手段，Stop hook 是最强的」（`protocol.md` §0.8 与 `stop-hook.mjs` 文件头的强弱排序） | 修复阶段只剩最弱那一层——**规则能被「判定为不适用」** |
| `final-report.md` 要求 FIX 路径「每条发现结束」出报告 | 每条发现天然产生一个停点，而每个停点都是串行的入口 |
| Skeptic 只在锐评相位执法（`critique-panel.md` 注明 `wave: 3`） | **修复相位是 L0 的执法真空**：没有批判角色会反对「一条一条串着修」 |

**所以这两个相位值不是新功能，是把原有一条路径接进门控。** 补齐之后，`stop-hook.mjs` 与 `check-state.mjs` 对修复路径的约束力，与它们对审计路径的约束力相同。

### 2.5.2 `wave4`：修复相位

| 项 | 定义 |
|---|---|
| **进入条件** | `path_mode = FIX`；锐评相位已闭合（`wave3` 的裁决记录落盘）；本轮 `UPHELD` 的发现清单已冻结 |
| **相位内允许的动作** | 按 `finding_id` **逐条派发独立修复实例**（`templates/wave4-fix.md`）；每个实例在**第一次 Edit 之前**把五个前置字段登记进 `fix_contracts` |
| **闭合条件** | `fix_contracts` **非空**（每条被派发的缺陷都有登记）+ 所有修复实例到终态 + `budget.spawned_fix_agents` 已按实际派发数更新 |
| **交付物** | `fix_contracts[]`（账本条目）+ 各修复实例的产物文件 |
| **机械校验** | `check-state.mjs`：`path_mode=FIX` 且 `phase ∈ {wave4, wave5}` 时 `fix_contracts` 必须存在且非空（`fix_contracts_required`），`report.dir_path` / `report.final_report_path` 不能都为空（`report_dir_required`，2026-11-15 / R14 新增），且 `target_repo` 必须是一个真实存在的目录（`target_repo_required`，2026-11-16 / R16a 新增）。`stop-hook.mjs`：`wave4` 无 `current_plan` 或 `fix_contracts` 为空时拒绝结束回合 |

**并行下限（比 `wave2a` 更严的一条）**：如果 `fix_contracts` 里有 **≥2 条不同的 `finding_id`**，而 `budget.spawned_fix_agents` **≤ 1**，`stop-hook.mjs` 拒绝闭合该相位，理由写「多条独立缺陷在单个实例里串行完成，违反 `triage.md` 的面板下限」。

> **为什么这条要写死在 hook 里，而不是写进提示词**：修复相位没有 Skeptic。锐评相位有一个专门角色攻击「这条结论对不对」，而修复相位连这个都没有——它的全部约束都来自主 Agent 自己的自律。上文第 4.4.4 节的那句话在这里正好适用：**「门控在，但没有一个门控真的拦住东西」。** 这条判据之所以可机械执行，是因为它只比较两个数字（`finding_id` 去重数 vs `spawned_fix_agents`），不需要理解修复内容——而 `protocol.md` §1.2 明令禁止主 Agent 去做需要理解内容的判断。
>
> **`spawned_fix_agents` 缺失按 0 处理**，不是按 1。账本没记录等于没发生；按 1 处理等于给「忘了记账」一条免罚通道，而记账遗漏恰恰是 round31「账本记 22、产物 ≥47」的成因。

### 2.5.3 `wave5`：验收相位

| 项 | 定义 |
|---|---|
| **进入条件** | `wave4` 已闭合；每条 `fix_contract` 都有对应的 `fix_agent_id` 与产物 |
| **相位内允许的动作** | 按 `finding_id` 逐条派发**只读**验收实例（`templates/wave5-verify.md`）；验收必须**独立构造**能瞄准缺陷的检查，**不得**读取修复实例的 `verification_commands` 作为验收依据 |
| **闭合条件** | **每一条** `fix_contract` 都有 `verdict ∈ {PASS, FAIL}`；带保留通过的写成 `PASS` + `escalation_required: true`（不是新增枚举值，见 `wave5-verify.md` §5.2） |
| **交付物** | 每条契约上的 `verdict` + `verified_at`，以及验收实例的产物文件 |
| **机械校验** | `check-state.mjs`：`verdict` 取值非法时判 `invalid_verify_verdict`（拼成 `PASSED` 不会被当成通过）。`stop-hook.mjs`：`wave5` 存在无 `verdict` 的契约时拒绝结束回合 |

**为什么闭合条件是「无未裁决」而不是「有 PASS」**：验收相位做完的标志是**没有没人看过的修复**，不是「修好了几条」。`FAIL` 同样是合法终态——它意味着回波次四重修，但那个决定已经被做出来了。缺 `verdict` 的那条是「没人看过」，它与「看过后判不通过」在账本上必须可区分，否则**未验收会被统计进已验收**。

**去向**（详细规则见 `wave5-verify.md` §5 与 §8）：

| 结论 | 去向 |
|---|---|
| `PASS`（无保留） | 该缺陷关闭，计入「已修复」 |
| `PASS` + `escalation_required: true` | 生成 `HUMAN_DECISION_REQUIRED` 开放项；本轮以 `PARTIALLY_CLOSED` 收尾，该缺陷**不记为已修复** |
| `FAIL` + `FIX_INCOMPLETE` / `FIX_INCORRECT` | **回 `wave4`**（不回 `wave2a`），派新修复实例 |
| `FAIL` + `BASELINE_INVALID` | 原发现是误报，标 `REVOKED`，不回修复波 |

### 2.5.4 与审计路径的关系（不破坏原有路径）

`wave4` / `wave5` **只在 `path_mode = FIX` 时有意义**。`AUDIT_ONLY` 路径的相位序列仍是 `init → wave1 → wave2a → wave2b → wave3 → report → closed`，一个值都没变。

两条硬约束保证这一点：

1. `fix_contracts_required` 的检查同时要求 `path_mode === 'FIX'`，`AUDIT_ONLY` 下缺 `fix_contracts` 仍然合法；
2. `report_dir_required`（R14 新增）同样要求 `path_mode === 'FIX'` **且** `fix_contracts` 非空，
   `AUDIT_ONLY` 下 `report` 整个缺席仍然合法（回归用例 `check-state.test.mjs` case 39 / 40）；
3. `stop-hook.mjs` 的 `wave4`/`wave5` 分支只在 `state.phase` 字面等于这两个值时进入，审计路径永远不会落到它们上面。

**唯一的跨界改动是相位白名单本身**（`['wave2a','wave2b','wave3']` → 加上 `wave4`/`wave5`）。它是**加**不是**改**：`wave2a/wave2b/wave3` 的行为逐字不变，回归用例 `stop-hook.test.mjs` case 11 专门锁这一点。

---

## 第 2.6 节：产物信封检查与 `legacy_artifacts` 豁免（2026-11-15 / R13 新增）

### 2.6.1 为什么需要这一节

R12《`experiments/hilltop-dsh/FIX-R12-report.md`》§八·洞 B 逐字写下了一个「本轮之后仍然完全可行」的失败场景：

> 修复 Agent 写完 6 份 `done-*.md`，全都没有信封，`check-payload` 一次没跑。
> 主 Agent 不看模板第 7 节，直接收下返回（信封里 `payload` 为空也能过 `status` 检查——因为**根本没有信封可检查**）。
> `stop-hook` 放行（`fix_contracts` 非空即可）。本轮仍然可以闭合。

根因是 `stop-hook.mjs` 的 wave4 分支只检查**账本里写了什么**（`fix_contracts` 非空、实例数对得上），
从不检查**产物本身**。而没有信封 = `check-payload` 除 `no_envelope` 外一条规则都不跑 = 产物未被观测 = 未交付。

`stop-hook.mjs` §3.7 现在会在 `phase ∈ {wave4, wave5}` 且 `path_mode == 'FIX'` 时，
调用 `check-fix-artifacts-envelope.mjs --dir <产物目录>`，把它的 FAIL 提升为拒绝闭合的理由。

### 2.6.2 产物目录从哪里来（FIX 路径下条件必填）

**用已有的 `report.dir_path`**，不新增字段。理由：

- `report.dir_path` 在本文档第 2 节已经定义为「本轮产物目录的绝对路径」，且 `report.dir_ready` 是派发前的硬闸——
  每个合规的轮次在派发任何子 Agent 之前就已经有它了；
- 新增一个必填的顶层字段会让**所有存量 `state.json` 一夜之间变不合规**
  （`check-state.mjs` 的 `TOP_REQUIRED` 有 7 项，加一项就是一次全量迁移）。

**但「不新增顶层必填字段」不等于「可以一直不写」。**（2026-11-15 / R14 修订）

R13 把「目录推断不出来」整档降级成了 WARN，结果 `FIX-R13-report.md` §7.2 自己把它列为
「本轮最大的残留口子」：**不写 `report.dir_path` 就能把整道信封闸门换成一条 WARN**——
不用伪造产物、不用改账本数字，只消省略一个字段。它把「检查不通过」和「检查没跑」混成了同一种结局。

所以现在改为**条件必填**，条件是「这一相位有没有已登记的修复」：

| `path_mode` | `phase` | `fix_contracts` | 目录字段 | 判定 |
|---|---|---|---|---|
| `FIX` | `wave4` / `wave5` | 非空 | `dir_path` 或 `final_report_path` 至少一个非空 | ✅ 通过 |
| `FIX` | `wave4` / `wave5` | 非空 | 两个都为空 | ❌ `check-state.mjs` 报 `report_dir_required`；`stop-hook.mjs` **拒绝闭合**（exit 2） |
| `FIX` | `wave4` / `wave5` | 空 | 两个都为空 | ⚠️ WARN 降级（此时没有待检产物，目录对信封检查没有意义；「wave4 却无登记」由 `fix_contracts_required` 与 `stop-hook` §3 的交付物判据拦） |
| `AUDIT_ONLY` | 任意 | 任意 | 任意 | 不检查（审计路径的相位序列里没有 `wave4/wave5`） |
| `FIX` | `init` ~ `wave3` | 任意 | 任意 | 不检查（未到修复相位） |

推断顺序（前三行都只是**输入**，第四行已不再是「一律降级」）：

| 序 | 来源 | 说明 |
|---|---|---|
| 1 | `report.dir_path` | 首选，约定字段 |
| 2 | `dirname(report.final_report_path)` | 兜底。`report-naming.md` §4：一轮一个目录、所有产物平铺 |
| 3 | `dirname(fix_contracts[].test_path)` | 最后兜底；测试文件常在仓库里而非产物目录，容易推错 |
| — | 三条都推不出 + `fix_contracts` 非空 | **FAIL**（`stop-hook` exit 2）：账本缺字段，不是环境问题 |
| — | 三条都推不出 + `fix_contracts` 为空 | **WARN，不 FAIL**（降级纪律，与 R8/R10/R11 同一条） |

> **降级纪律的边界（R14 修订）**：降级只适用于「拿不到**外部**信息」的判据缺输入
> （sessions root 不存在、目录存在但读不了、检查器执行失败）。
> 而 `report.dir_path` 是**账本自己的字段**——主 Agent 手上有这个路径（它派发时用过），
> 写一行就能让闸门跑起来。省略不是受环境所限，是选择。
> **能自己修的事不能算降级理由。** 这与 R10 点名的「降级路径本身就是一条明面上的后门」是同一条纪律。

> **降级必须留痕**：`stop-hook` 在 exit 0 时仍会往 stderr 写「本次没有执行产物信封检查」。

**这条改动之后仍然存在的绕过（R14 诚实标注，不要把它读成「口子堵完了」）**：
把 `report.dir_path` 写成一个**真实存在但空**的目录（或一个没有 `done-*.md` / `*-fix-*.md` 的目录），
`stop-hook` §3.7 会判定「没有对象可查」并降级为 WARN，`exit 0`。
它比 R14 之前的绕过难一点（要写一个存在的路径，且这个路径会出现在 WARN 里），
但仍然是「用一条 WARN 换掉闸门」，同一类问题。是否把「有 2 条以上 `fix_contract` 而产物目录 0 份产物」
也升为 FAIL，是下一轮的决定——升它需要先回答「修复相位允许不允许『产物还没写完』这个中间态」，
而 R13 的答案是允许，所以本轮没有擅自改。

### 2.6.3 `legacy_artifacts`：可声明豁免

**字段定义**：`legacy_artifacts: string[]`，可选，**不是必填**。列出被豁免的无信封历史产物（只写文件名，`basename` 会被取）。

**为什么要有它**：硬 FAIL 一个历史产物目录会让所有老项目无法闭合。
`experiments/hilltop-dsh/repair/` 的 6 份产物就是这种情况——它们是 2026-11-15 那次派发的唯一自证数据
（修复后的源码树已不在仓库里），补信封注定 FAIL（红测日志已被 `mvn clean` 删除）。
决策与逐份分析见 `experiments/hilltop-dsh/LEGACY-ARTIFACTS.md`。

**三条约束（缺一条这个字段就变成关掉检查的开关）**：

| 约束 | 行为 | 理由 |
|---|---|---|
| 只能逐个列文件名 | 数组，不是布尔 | `true` 一旦存在就会成为默认路径 |
| **不能全量豁免** | 豁免条目数 ≥ 产物目录下**文件总数** → **FAIL**（`stop-hook` exit 2） | 分母取文件总数而非产物数，因为 `report-naming.md` §4 规定产物与流程文档平铺共存；6 份产物 / 15 个文件才是「少数例外」的正确刻画 |
| 每条豁免都留痕 | 逐条 WARN：「契约体系之外 / 证据不可机械复核 / 不是通过了检查，是没被检查」 | 「降级」与「什么都没发生」必须在日志上可区分 |
| 悬空条目 WARN | 列了但目录里没有 → WARN，不阻断 | 一条永远匹配不上的豁免会在同名文件将来出现时静默生效 |

**另一条退化形态**：产物 100% 被豁免但目录里有文档稀释了计数 → 不阻断，但报一条
「本轮**没有任何**修复产物经过信封检查」。这是「整批承认不可复核」，不是「这批产物合规」。

### 2.6.4 与 `check-fix-artifacts-envelope.mjs` 的分工

**豁免是账本层的概念，不是检查器层的。** `check-fix-artifacts-envelope.mjs` 仍然故意**没有** `--ignore` 开关
（见其文件头「降级纪律：无」）。所以：

- `node tools/check-fix-artifacts-envelope.mjs --dir experiments/hilltop-dsh/repair` → 仍然报 6 条 FAIL；
- `node tools/stop-hook.mjs --state <带 legacy_artifacts 的 state.json>` → exit 0 + 7 条 WARN。

两者不一致是**刻意的**：检查器回答「这批能不能被观测」，账本回答「这一轮允许哪几份不可观测」。

### 2.6.5 与审计路径的关系

与 §2.5.4 同一条纪律：该检查只在 `phase ∈ {wave4, wave5}` **且** `path_mode == 'FIX'` 时启用。
`AUDIT_ONLY` 路径的相位序列里没有 `wave4/wave5`，因此逐字不变
（回归用例 `stop-hook.test.mjs` case 26 / case 27 锁定）。

---

## 第 2.7 节：修复基线 `fix_baseline`（2026-11-16 / R20 新增）

### 2.7.1 字段定义

```json
"fix_baseline": {
  "captured_at": "2026-11-16T09:12:00Z",
  "dirty_paths": ["src/legacy/A.java", "repair-artifacts/", "app.log"],
  "head": "11ae7223f0c9..."
}
```

| 字段 | 类型 | 含义 |
|---|---|---|
| `captured_at` | `string` (ISO8601) | 抓基线的那一刻。**用于留痕，不用于判定**。缺失时 WARN |
| `dirty_paths` | `string[]` | 进入 wave4 **之前** `git status --porcelain` 解析出的全部路径（仓库根相对、正斜杠）。未跟踪目录写成 `dir/`（带尾斜杠），会被当作前缀覆盖其下所有文件 |
| `head` | `string` (commit sha) | 抓基线时的 HEAD。**用于留痕与诊断**，缺失时 WARN |

### 2.7.2 为什么需要它

**`git status` 报的是「相对于 HEAD 的差异」，不是「这一轮改了什么」。被审仓库常常一开始就是脏的。**

R19 §(a) 的自证数据：被审的 Hilltop 仓库在修复开始时就已经有 25 行改动，
其中相当一部分不是本轮修复产生的。把裸 `git status` 当成 `actual` 会让**双向都失真**，
而且两个方向的失真方向相反：

| 方向 | 失真 | 后果 |
|---|---|---|
| `overclaimed` | **假阴性**：文件在修复**之前**就已是 `M`，实例本轮根本没碰它，却因为它在 `actual` 里而不算 overclaim | R18 §6 问的「是不是**这一轮**改的」——旧判据没有回答 |
| `underreported` | **假阳性**：仓库里本轮之前就存在的改动全被算成「改了没登记」 | 假阳性是规则被卸载的最短路径（R10 的教训），这条规则会被当成噪音关掉 |

`fix_baseline` 把 `actual` 从「相对 HEAD 的差异」改成「**现在的脏 − 基线里的脏**」，
即「这一轮新增的脏」，从而同时收窄两个方向的失真。

### 2.7.3 谁来写、什么时候写

**主 Agent 在进入 `wave4` 之前、派发第一个修复实例之前抓一次。** 命令：

```bash
cd <target_repo> && git rev-parse HEAD && git status --porcelain
```

把 `git status` 的路径逐行填进 `dirty_paths`（保留 `git status` 的输出形态：` M src/x.java`
取 `src/x.java`；`?? newdir/` 保留尾斜杠）。**只抓一次**，不要在每个修复实例前后各抓一次——
那是另一套机制（逐实例归属，见 §2.7.6），本字段不声称能替代它。

**它是条件必填吗？不是。** 缺失时双向对账**降级**为「相对 HEAD 的差异」并 WARN 说明，
理由与 §2.6.2 的「不新增顶层必填字段」同源：不能让所有存量账本一夜之间变不合规。
但**降级必须可见**：`stop-hook.mjs` 会写一条显式 WARN，逐条说明两个方向的失真方式与补法。
「检查没跑」与「检查通过」在日志上必须可区分（R13 §7.2）。

**格式非法**（`fix_baseline` 不是对象、`dirty_paths` 不是数组、数组里有非字符串）→
同样降级 + WARN，**不崩溃**。绝不能把格式错当成「空基线」静默吞掉：那比没有基线更糟——
主 Agent 以为自己在提供基线，而对账实际按相对 HEAD 跑，且毫无提示。

### 2.7.4 `stop-hook.mjs` §3.7.6 里它怎么用

```
nowDirty      = git status --porcelain 的全部路径
baselineDirty = state.fix_baseline?.dirty_paths ?? null

if (baselineDirty === null) {
  actual = nowDirty                                    // 降级
  WARN  '没有基线，对账基于相对 HEAD 的差异——修复前就脏的文件会被误判'
} else {
  actual   = nowDirty - baselineDirty                  // 这一轮新增的脏
  restored = baselineDirty - nowDirty                  // 基线里脏、现在干净了
  if (restored 里有源码文件)
    WARN  '这些文件在修复前是脏的，现在变干净了——可能是被还原，也可能是 stash/checkout'
}
```

然后 `overclaimed`（`claimed - actual`）与 `underreported`（`actual - claimed`，过滤后）
都用新的 `actual`。**减法只用于取 `actual`，不做噪音过滤**——过滤是给 under-reporting 判据用的
（「剩下的是应该被覆盖的东西」），overclaim 必须用未过滤集合，否则「声称改了 docs/x.md 而且确实改了」
会被误报。

**`restored` 为什么只 WARN 不 FAIL**：`rollback_command` 干的就是还原，合法的还原是修复流程的一部分。
但「修复前脏、现在不脏」也可能是「本轮改动被误 checkout 掉」的唯一痕迹
（`experiments/CHECKOUT-INCIDENT.md` 记过一次真实事故），所以要提示、要留痕，但不阻断。

**HEAD 漂移（`head` 字段唯一的判据价值）**：减法假设「同一个 HEAD 下的两次 `git status` 可比」。
若在抓基线之后、hook 运行之前仓库发生过一次 commit（或 reset），这个假设就不成立了：

```
基线记 src/A.java 脏 → 实例改完 A.java → git commit → git status 变干净
→ A.java 落进 restored，同时从 actual 里消失
→ 产物声称改了 A.java，却因为 actual 里没有 → 被判 overclaimed
```

`restored` 与 `overclaimed` 会**同时**报出，两个都是假警报。`stop-hook.mjs` 会比对
`fix_baseline.head` 与现在的 `git rev-parse HEAD`，不一致时 WARN 说明「本段给出的一切结论
都建立在这个已经不确定的差值上」，并给出补法（在 commit 之后**重抓**基线，`captured_at` 与 `head` 一起更新）。
**它不修那个假警报，只是让它可见**——真正的修法是基线记未提交的 blob hash，见 §2.7.5。

### 2.7.5 它解决了什么、没解决什么（诚实标注）

> **`fix_baseline` 是把假阴性/假阳性缩小，不是消除。它本身也是自述。**

| 它解决的 | 它没解决的 |
|---|---|
| 「修复前就脏」被算成本轮改动 → underreported 假阳性大幅收窄（自证：14 个 → 4 个） | **实例级的归属**：`files_touched` 没有 `agent_id` 维度，对账是全局的。基线只知道「修复前哪些脏」，不知道「这一轮是**哪个实例**改的」 |
| 「修复前就脏、本轮没动」被算成本轮改动 → overclaimed 假阴性被堵住（用例 C） | **基线本身的真伪**：主 Agent 可以写 `dirty_paths: []`，让所有改动都算成本轮改的。做不到验证——没有外部基准能与「修复前那一刻」比对 |
| 基线里脏、现在干净（被还原 / stash / checkout）从「静默」变成 WARN | **同一文件既在基线里又被本轮改了**：减法会把这种情况判成「不是本轮改的」，即新的假阴性。要堵它需要基线记内容哈希，不是路径列表 |
| 格式非法的基线不会被静默当成空基线 | **中途 commit**：基线记的 HEAD 与现在不一致时，减法假设失效，会同时造出假 restored 与假 overclaimed。已加 HEAD 漂移 WARN，但**判据本身没修**（见 §2.7.4 末） |
| 基线记的 HEAD 与现在不一致时 WARN 说明口径已不确定 | **跨轮基线**：`fix_baseline` 只管这一轮；`wave5` 的验收相位目前**不**重新抓基线 |

**`captured_at` / `head` 的作用就是让假基线留痕。** 本框架不试图验证基线真伪，
但一个假基线至少要写下「它声称自己在什么时刻、基于什么 HEAD 抓的」，
事后任何人拿 `git reflog` 一对就知道那个时刻的 HEAD 对不对、那个时刻的脏文件大概是什么。
这两项会同时出现在降级 WARN 与对账 FAIL 的「判据口径」一行里。

### 2.7.6 下一个层次是什么（给下一轮的路标）

自述层到这里已经接近极限。再往下走必须换基准，而不是再加字段：

1. **逐实例基线**：每次派发修复实例前抓一次，`files_touched` 按 `agent_id` 分账。
   代价是 N 次 `git status`，收益是 overclaimed / underreported 从「全局」变成「归属到实例」。
2. **内容哈希基线**：`fix_baseline` 记每个脏文件的 blob hash 而不只是路径。
   这样「同一文件既脏又被改」可以被区分（`git hash-object` 对比），
   堵掉 §2.7.5 表里最后一行那个新的假阴性。
3. **hook 侧抓基线**：让 `stop-hook.mjs` 在 `phase` 从 `wave3` 迁到 `wave4` 的那一次调用里
   自己抓基线并写盘。这是唯一能把「主 Agent 忘了抓 / 故意抓假的」从自述层挪出去的做法，
   代价是 hook 需要写 state 文件（它目前是只读的）。

---

## 第 3 节：三条写入硬规则

这三条决定了「中断最多损失多少」。

> **`wave2_completed` 是什么**（2026-11-03 补充定义）：`protocol.md` 第 1.4 节与 `templates/wave3-critique.md` 第 2.3 节都要求 Skeptic「把 `discipline_log` 与 `wave2_completed` 逐条比对」以找出未申报的裁量——**但这个字段此前在 `state.json` 里不存在**。规则要求对一个不存在的文件做比对，稽查在物理上无法执行。
>
> 它是**派发事实的账**，与 `discipline_log`（**裁量的自述**）构成对账的两侧：
>
> | 字段 | 性质 | 谁写 | 用途 |
> |---|---|---|---|
> | `discipline_log` | 主Agent **自称**做了哪些裁量 | 主Agent | 被审查对象 |
> | `wave2_completed` | **客观发生**了哪些派发 | 主Agent 每次派发后追加 | 审查基准 |
> | `slices[].artifact_paths` | 磁盘上**实际存在**的产物 | 主Agent 从子 Agent 返回中抄 | 第二重交叉验证 |
>
> 三者两两比对才有意义：`wave2_completed` 里有的派发，`discipline_log` 里没有对应裁量记录 → 未申报裁量；`artifact_paths` 里有路径但文件不存在 → 产物造假或丢失。
>
> **`dimension_assigned_by_discretion` 是关键字段**：round31 的 9 处维度偏离正是「派发记录里有、`discipline_log` 里没有」——有了这个布尔值，Skeptic 不必理解裁量内容，只需机械核对「这一条标了 `true` 吗？标了就去 `discipline_log` 找对应条目，找不到即违规」。

### 规则 1 · 派发前先写 `in_flight`

```
spawn_agent 之前：
  1. 把该 agent 加入 in_flight
  2. 把该 slice 的 state 改为 RUNNING
  3. 落盘 state.json        ← 必须先于 spawn
  4. 才发起 spawn
```

**为什么顺序不能反**：如果先 spawn 再写状态，中间崩溃会导致「有一个 agent 在跑，但状态里没有它」——续跑时它不会被发现，它的产物成为孤儿。

### 规则 2 · 拿到结果先写 `slices`，再派下一个

```
read_result 之后：
  1. 把产物路径写进 slices[id].artifact_paths
  2. state 改为 DONE（或 FAILED）
  3. 从 in_flight 移除
  4. 落盘 state.json        ← 必须先于下一次派发
  5. 才派下一个
```

### 规则 3 · 每完成一个 agent 更新一次 `budget.spent`

`budget.spent` **必须来自实际派发计数，不得由主 Agent 估算**。round31 的 `spent=22` vs 实际 ≥47 就是因为它在估算。

---

## 第 4 节：续跑协议

**触发方式**：用户在新对话里说「继续 round31」或「继续上次的审计」。

**续跑 Agent 的执行序列（严格按序）**：

1. **读 `state.json`**。不存在 → 报「没有可续跑的状态」，**不得**猜测或新开一轮。
2. **核对 `phase` 与 `status`**（按第一匹配执行，四条互斥且穷尽）：

   | `status` | 含义 | 动作 |
   |---|---|---|
   | `RUNNING` | 还没写报告，本轮没跑完 | **续跑同一轮**，从 `in_flight` 与 `DEFERRED` 继续 |
   | `PARTIALLY_CLOSED` | **已出报告**，本轮已收口，但有 `DEFERRED` | **不要续跑本轮**。执行 `tools/check-round-chain-live.mjs`，按 `OPEN_NEXT_ROUND` / `STOP` 处理 |
   | `CLOSED` | 已出报告且无遗留 | 直接指向 `report.final_report_path`，**不再派任何 agent** |
   | `BLOCKED` | 连续失败停下 | 出报告说明阻塞原因，开新轮不继承失败切片；**不要问用户「要不要继续」** |

   > **2026-11-04 修订**：原文只有 `CLOSED` 与 `BLOCKED` 两条分支，`PARTIALLY_CLOSED` 与 `RUNNING` **没有定义**。而 `PARTIALLY_CLOSED` 恰恰是「预算耗尽」这个最常见终止方式的落点（第 360 行）。落到这条分支的轮次，续跑 Agent **无从判断该干什么**——实际表现就是要么重复续跑一个已收口的轮次，要么停下来问用户。
   >
   > 同时删掉了原文第 183 行的「等用户决定」。**续跑的目标就是不让用户值守**，在已知 `BLOCKED` 原因时停下来问，等于把这个目标取消掉。正确做法是出报告 + 自动开新轮（失败切片记入新轮的 `unverified`），让用户回来时看到的是结果，不是问题。

   **`phase` 不改变上面四条分支的判定，只决定「从哪里继续」**（2026-11-15 补充）：

   | `phase` | `status = RUNNING` 时从哪里继续 |
   |---|---|
   | `init` ~ `wave3` | 按上表从 `in_flight` 与 `DEFERRED` 继续（审计路径，行为不变） |
   | `wave4` | 逐条检查 `fix_contracts`：有 `fix_agent_id` 且产物完整 → 该缺陷已修完；没有登记但发现是 `UPHELD` → 补派修复实例。**不得**因为上次是在单实例里串着修的，就在本次续跑里继续串着修——并行下限在续跑时同样成立 |
   | `wave5` | 逐条检查 `fix_contracts` 的 `verdict`：无 `verdict` 的补派验收实例。已 `FAIL` 的按 `failure_category` 决定回 `wave4` 还是标 `REVOKED`，**不得**在续跑里把 `FAIL` 当通过记账 |

   > **为什么这条必须补**：`phase` 与 `status` 是两个正交的信号，但原文只按 `status` 分支。修复路径续跑时，`status=RUNNING` 给的指令是「从 `in_flight` 与 `DEFERRED` 继续」——而 FIX 路径的进度**不在 `in_flight` 里，在 `fix_contracts` 里**。照原文续跑，续跑 Agent 会去一个空数组里找进度，然后得出「没有未完成项」的结论。这正是 round31「账本记 22、产物 ≥47」那类错误的同一形态：**判据指向了不记录该事实的字段。**
3. **处理 `in_flight`**（这是最容易出错的一步）：

   | `in_flight` 中的项 | 处理 |
   |---|---|
   | 有 `artifact_paths` 非空且产物**内容完整** | 标 `DONE`，不重派（**先查产物再判断，不要凭 mtime**） |
   | 无产物，或产物明显截断 | 标 `PENDING`，等下面重派 |
   | 状态无法判断 | **标 `PENDING` 重派，并在报告中记一条 `UNVERIFIED_AGENT_STATE`**，**不得停下来等用户** |

   > **严禁用文件 mtime 判断 agent 是否中断。** R22 的教训：回队 agent 100 分钟不写文件是正常的（它在读码），据此重派会导致双实例并发写同一文件、后写覆盖先写。**判据是 agent 的运行状态，不是文件时间戳。**

#### 4.1 那该用什么判断？（2026-11-02 补充）

上面只说了「不能用 mtime」，**没说清「用什么」**——这个空缺导致了一次真实丢失（见 4.2）。

**三级证据，按可靠性排序**：

| 级别 | 证据 | 怎么拿 | 可靠性 |
|---|---|---|---|
| **A** | **agent 的运行状态** | harness 提供的任务状态查询（`ListAgents` / 后台任务状态 / `SendMessage` 问一句"你现在到哪一步"） | **最高**。这是唯一直接证据 |
| **B** | **该 agent 正在操作的外部资源** | 查进程表、端口监听、临时目录写入。例：headless Chrome 带 `--remote-debugging-port`、node 服务监听 127.0.0.1 的某个端口 | 中。能证明"有东西在跑"，但不能证明"是我那个 agent" |
| **C** | 产物文件 mtime | `ls -l` | **最低，且会骗人**。只读型 agent 长时间不写文件是常态 |

**判定流程（2026-11-09 重写：与 §4.4.2「不主动杀」对齐）**：

```
1. 查 A（harness 的运行状态）。有状态就信状态，到此为止。
   → 状态说「在跑」：等待。不查 B、不查 C、不重派。
   → 状态说「已完成/失败/超时」：按终态处理。

2. A 拿不到（harness 无状态查询能力）：
   → 记录 state_unknown: true
   → **继续等**，不得用 B/C 做替代判据去杀 agent
   → 向用户汇报时必须说「无法确认状态」

3. 不用 C（mtime）做任何判定。
```

> **⚠️ 2026-11-09 重大修订：原流程的第 2、3 步（查 B 级进程表、用 C 级 mtime）已作废。**
>
> 作废理由：实测显示同类任务的单 agent Runtime 常态是 **47 分钟**，而本流程此前配套的判据是「8 分钟 / 10 分钟」。**用一个比真实值小一个数量级的阈值去判断「是不是卡住了」，结论必然错。**
>
> **B 级和 C 级证据的问题不是「不够准」，是「它们回答的不是同一个问题」。** harness 状态回答「这个 agent 现在是什么状态」，进程表和 mtime 回答「有没有某个外部痕迹」。后者无法证明前者——进程表里 25 个 `claude.exe` 分不清哪个是我的 agent，mtime 会骗人（我自己在 §4.4.1 写过这句话，然后用它杀了 4 个 agent）。
>
> 保留在原文档里的教训：**没有触发条件的检查流程等于没有流程**——这条仍然成立，只是触发条件从「2 小时」改成了「harness 报告终态之前什么都不做」。

#### 4.2 疑似丢失时怎么重派（避免双实例打架）

**这是 R22 事故的正确解法**：

```
判定「疑似丢失」后：
  1. 不要杀原实例（可能只是慢）
  2. 重派时把范围**切小**，且明确告知新实例：
     "前一个实例可能仍在运行，你的产物请写到 <独立路径>，不要碰 <原路径>"
  3. 两个实例若都返回，取**内容更完整**的，并在报告中标注 duplicate_run
  4. 事后核对：若两个实例都写了文件，以先写的为准（后写的覆盖是 R22 的失效形态）
```

**更好的做法（本次实测采用）**：把一个大 agent 的范围**拆成两个独立范围**再派，而不是原样重派。因为原样重派会让两个实例竞争同一批文件。

#### 4.3 实测记录：一个 agent 静默丢失

`D:\Web\style` 第 2 轮，5 个 agent 中 1 个（原型组 C）未返回：

- 其余 4 个正常返回，报告完整；
- 该 agent 的 `tasks/<id>.output` **0 字节**，无完成通知；
- 用 B 级证据排查进程表：Chrome（`--user-data-dir=C:/tmp/cprof`，端口 9333）、node（`scripts/watch.mjs`、`npx serve -l 8099`、`dsh web`、`bridge.mjs`）——**逐个查命令行后确认都不属于该 agent**（分属其它会话）；
- 判定「疑似丢失」，按 4.2 处理：**把原范围拆成两个独立子范围重派**（S25/S27/S28/S29 一组；`_selection/style.css` + 模板 + 机制脚本一组），而非原样重派。

**教训**：`tasks/*.output` 是 0 字节**不能作为"agent 没干活"的证据**——subagent 的最终报告走完成通知投递，本来就不落盘到该文件。判断必须回到 A 级证据（运行状态）。

4. **重建待办**：`PENDING` + 失败项 + `deep_dive_pending` 非空的切片。
5. **按原 `scale_decision` 的确定性规则排序**（`reachability` → `lead_count` 降序 → FIFO），**不得重新判断优先级**。
6. **从 `budget.total_cap - budget.spent` 得到剩余预算**。不够 → 直接进第 5 节收尾。
7. 继续派发。

**续跑时必须做的声明（写进报告）**：

```
本轮为续跑：原轮次 round31，续跑于 <时间>。
已完成：N 个 agent（依据 state.json 的 DONE 计数）
本次补派：M 个 agent
预算：已用 X / 上限 Y
```

---

## 第 4.4 节：等待超时必须主动检查（2026-11-03 新增，来自一次真实失效）

### 4.4.1 事故经过

4.1~4.3 写了「三级证据」和「疑似丢失怎么重派」，**但漏了一个触发条件：什么时候去查。**

实际后果：13 个锐评 Agent 派出去，**5 个从未返回**。我**等了 16 小时**，期间：

- 改文件 ✓
- 出报告 ✓
- 向用户汇报"还有 5 个在跑" ✓

**唯独没有花 1 分钟查一次进程表。**

当用户问"agent 在哪里"时，我才去查——30 秒就得到明确结论：**没有任何进程证据表明它们在运行**。

### 4.4.2 规则：超时阈值 + 强制检查动作（2026-11-09 重大修订）

```
派发任何 agent 后，必须记录 started_at。

【默认：不主动杀】
在 harness 报告终态（完成 / 失败 / 超时）之前，主 Agent 不得主动终止 agent。
```

**为什么改成「不主动杀」**

2026-11-09 观察到的真实运行时数据（harness 原生统计）：

| 工作流 | agent 数 | 单 agent Runtime | 总 token |
|---|---|---|---|
| `round3-verify-batch1` | 5 | **28m36s / 47m48s / 47m48s / 47m48s / 40m31s** | 243.8K |
| `round3-fix-batch2` | 7 | 33m40s / **47m34s** / 11m29s / 20m08s / 8m33s / 16m29s / 22m51s | 638K |

**47 分钟是这批任务的常态，不是异常。**

而本框架此前定的判据是「8 分钟无更新即重派」和「10 分钟无输出即 `TaskStop`」。按这个判据，**上面 12 个 agent 里有 9 个会被杀掉，而它们实际上都在正常工作。**

**这个错误的实际代价**：2026-11-04/05 的链式实测中，我用 `TaskStop` 终止了 4 个 agent，并把其中 2 个归因为 `SCRIPT_TIMEOUT`。**这些归因现在不可信**——它们可能只是「还没跑到写产物那一步」。

---

**修订后的规则**

| 情形 | 动作 |
|---|---|
| harness 报告 agent 仍在运行 | **等待，不干预**。不查 mtime、不查进程、不重派 |
| harness 报告完成 / 失败 / 超时 | 按终态处理 |
| harness 无法报告状态（不支持查询） | 记录 `state_unknown: true`，**继续等**，只在用户询问时如实说「无法确认」 |
| 用户明确要求停止 | 才 `TaskStop` |

**唯一允许主动终止的情形**：

1. **用户明确要求**；
2. **预算硬触顶**（`budget.spent >= total_cap`）且必须为新任务腾出槽位——此时按 FIFO 终止最长运行的那个，并在账本记 `TERMINATED_BY_BUDGET`；
3. **确认 agent 的产物已被另一实例正确产出**（重复实例，可安全终止其一）。

**这三种之外，一律不得主动终止。**

---

**如果 harness 完全不提供状态查询**

那么「判断 agent 死活」这件事本身就是不可能的。此时：

- **不得用 mtime / 进程表做代理判据**（§4.4.1 已证明两者都不可靠）
- 账本记 `state_unknown: true`
- 向用户汇报时必须说「无法确认运行状态」，**不得说「还在跑」或「卡住了」**

### 4.4.3 三条硬规则

**规则 1：不得把「没收到通知」当成「还在跑」。**

这是本次失效的直接原因。**没有消息 ≠ 好消息**，尤其在长任务上——它可能已经死了，而你不知道。

**规则 2：不得把「产物文件 0 字节」当成任何方向的证据。**

两个相反的错误都犯过：
- 第一次：以为 0 字节 = 死了 → **错**（只读型 agent 长时间不写文件是常态）
- 这一次：以为 0 字节 + 无通知 = 还活着 → **也错**

**0 字节什么都不能证明。** 它只是一个"没有信息"的状态。

**规则 3：向用户汇报进度时，必须区分三种情况。**

| 说法 | 什么时候能用 |
|---|---|
| ❌「还有 5 个在跑」 | **只有在 A 或 B 级证据支持时才能说** |
| ✅「5 个未返回，已确认无进程证据，判定丢失」 | 查过 B 级 |
| ✅「5 个未返回，尚未检查运行状态」 | **诚实版本**——没查就说没查 |

**本次我用了第一种说法，但没有证据支持它。这是对用户的误报。**

### 4.4.4 为什么这条规则比 4.1~4.3 更重要

4.1~4.3 解决的是**"查到之后怎么办"**。

4.4 解决的是**"什么时候去查"**。

**没有触发条件的规则，等于没有规则。** 这和数据审计员指出的那个通病是同构的：

> 「门控在，但没有一个门控真的拦住东西」
> 「证据纪律写得很细，但没有一道纪律真的在生成结论时被用上」

**我写好了三级证据，但从未触发过一次检查。**

### 4.4.5 实测记录

| 项 | 值 |
|---|---|
| 派发时间 | 11-03 01:44 |
| 用户追问时间 | 11-03 17:26 |
| 间隔 | **15 小时 42 分** |
| 实际查询耗时 | **约 30 秒** |
| 查询结果 | 最近 3 小时新启动的 node 进程只有 1 个（`server.js`，属用户其它项目）；与 Claude 相关的 node 进程 0 个 |
| 判定 | 疑似丢失（B 级证据） |

**30 秒能查清的事，拖了 15 小时 42 分，而且期间向用户报告了"还在跑"。**

---

## 第 5 节：收尾保险——「必须出报告」规则

**这是本文件最重要的一条。**

**硬规则**：**任何导致运行结束的情形，都必须先产出最终报告，再退出。**

触发条件（任一）：

| 触发 | 动作 |
|---|---|
| 正常跑完所有波次 | 出完整报告，`status: CLOSED` |
| 预算耗尽 | 出报告，未处理的标 `DEFERRED`，`status: PARTIALLY_CLOSED` |
| 用户中断 / 对话即将结束 | **出报告**，`is_complete: false`，`status: PARTIALLY_CLOSED` |
| 连续失败触发暂停 | 出报告，说明阻塞原因，`status: BLOCKED` |
| 主 Agent 自己判断「跑不完了」 | 出报告，**不得**静默停止 |

**「跑完了但没有报告」不是合法终态。** 若违反，等同于该轮从未发生——因为它没有留下任何可消费的产出。

**`status` 是闭集：`RUNNING` / `PARTIALLY_CLOSED` / `CLOSED` / `BLOCKED`。`IN_PROGRESS` 不得作为终态**（2026-11-04 补记）：round31 正是停在这个值上，既没跑完也没收尾，续跑时无法判断该做什么。新设计用两个独立信号代替它——`RUNNING`（还在跑，需要续跑）+ 报告产物是否存在（已有产出）。**一个状态不能同时表示两件事。**

**报告的最低内容**（不完整也要有）：

```markdown
# round{N} 审计报告（不完整）

## 状态
本轮未跑完。原因：<预算耗尽 / 用户中断 / agent 连续失败 / ...>
已完成波次：<列表>
未完成：<列表>

## 已确认的发现
<已有的 UPHELD 发现，按严重性排序>

## 未覆盖
- 未审切片：N 片（列出 slice_id）
- 未深挖线索：M 条
- 失败/状态不明的 agent：K 个

## 下一步
续跑指令：`继续 round{N}`
预计还需：X 个 agent
```

**一条容易被忽略的要求**：`report.final_report_path` 必须在**文件真正写成功之后**才写入 `state.json`。写失败（磁盘满、权限）→ `status: BLOCKED`，并在 stdout 明确报出，**不得假装成功**。

---

## 第 6 节：与 `round-detection.md` 的配合

`round-detection.md` 负责**新开一轮**时确定编号；本文件负责**同一轮内**的状态。

两者的交界点是「孤儿轮次」：`round-detection.md` 第 6 节规定，只有三个条件全满足才复用 N。本文件补充一条**判定依据**：

```
若 state.json 存在，且 status == RUNNING
  → 该轮是「跑到一半」，续跑同一轮，不要新开 round{N+1}
若 state.json 存在，且 status ∈ {CLOSED, PARTIALLY_CLOSED, BLOCKED}
  → 本轮已收尾（已出报告），不要再续跑它
  → 交给第 6.5 节决定是否开新一轮
若 state.json 不存在但产物目录存在
  → 该轮是「孤儿轮」，按 round-detection.md 第 6 节处理
```

**2026-11-04 修订：原文把 `PARTIALLY_CLOSED` 判成「未完成轮，续跑它」，与第 6.5 节直接冲突。**

原文的判据是「status 不是 `CLOSED`」，于是 `PARTIALLY_CLOSED` 落进了「续跑同一轮」分支。但第 5 节规定**预算耗尽 → `PARTIALLY_CLOSED`**（第 360 行），第 6.5.1 节又规定**`PARTIALLY_CLOSED` + 有 `DEFERRED` → 自动开 `round{N+1}`**。

预算耗尽是最常见的终止方式，于是最常见那条路径上两条规则给出相反指令：

| 规则 | 对同一次终止的指令 |
|---|---|
| §6（旧） | 不是 `CLOSED` → 续跑同一轮，**不要**开新轮 |
| §6.5.1 | `PARTIALLY_CLOSED` + 有 `DEFERRED` → **自动开新轮** |

**主 Agent 无论按哪条走都是违规的**：按 §6 走，`DEFERRED` 永远不会被消化，轮次链不推进，外部表现就是「停下来等人」——正是 §6.5 开头说要解决的那个问题。

**根因是判据选错了。** 正确的分界不是「有没有 `CLOSED`」，而是**「本轮波次是否已经走完」**：

| 情形 | 该轮状态 | 正确动作 |
|---|---|---|
| 波次全部走完并出了报告，但留有 `DEFERRED` | `PARTIALLY_CLOSED` | **开新轮**，把 `DEFERRED` 作为新轮输入 |
| 跑到一半被中断（对话结束、主 Agent 判断跑不完） | `RUNNING`（尚未写报告） | **续跑同一轮** |
| 连续失败停下 | `BLOCKED` | 开新轮，失败切片进新轮队列 |

**关键区别**：`RUNNING` 意味着「还没写报告」，产物目录不完整；`PARTIALLY_CLOSED` 意味着「报告已写、本轮已收口」。**已经出过报告的那一轮不应该被续跑**——续跑会让同一轮产出两份报告，且旧的 `DEFERRED` 与新派发的切片混在一起，无法判断谁覆盖了谁。

---

## 第 6.5 节：自动多轮推进（2026-11-01 新增）

**问题**：上面第 4 节的续跑需要用户说一句「继续 round31」。但实测（`D:\Web\style`）显示，**56 片的项目在 `discovery_budget = 40` 下一轮只能覆盖 29%**，40 片会被 `DEFERRED`。如果每轮都要用户手动催一次，等于把「跑不完」的问题转成了「要催 N 次」的问题——用户仍然得擦屁股。

### 6.5.1 轮次链

一轮跑完（出报告、`status: CLOSED` 或 `PARTIALLY_CLOSED`）后，主 Agent **必须**检查是否还有 `DEFERRED` 项：

```
若有 DEFERRED（deferred_slices / deferred_deep_dive / DEFERRED_DEEP_DIVE 线索）:
    → 自动开启下一轮 round{N+1}
    → 新轮的输入 = 上一轮的 DEFERRED 清单 + covered_modules
    → 新轮的侦察波跳过已 DONE 的切片（按 state.json 的 slices 判定）
    → 在最终报告中写「本轮为自动续轮 #k，母轮 round{N}」
若无 DEFERRED:
    → 正常结束，不再开新轮
```

### 6.5.2 停止条件（必须写死，否则会无限循环）

| 条件 | 动作 |
|---|---|
| 无 `DEFERRED` 项 | 停止，正常结束 |
| 连续 2 轮新增覆盖为 0（同一批 `DEFERRED` 反复无法处理） | 停止，标记 `STALLED`，报告说明原因 |
| 累计轮数达 `max_rounds`（默认 5） | 停止，报告剩余未覆盖项 |
| 累计 `budget.spent` 达 `total_budget × max_rounds` | 停止 |
| 某轮 `defect_count` 为 0 且 `DEFERRED` 只剩 `UNREACHABLE` | 停止（剩下的不值得审） |

**`STALLED` 是最重要的停止条件**：如果某一轮跑完，`DEFERRED` 清单与上一轮**完全相同**（没有任何推进），说明遇到了系统性问题（预算太小、切片规则不匹配、或某个 agent 稳定失败），继续跑只是烧钱。**必须停止并报告，不得重试。**

### 6.5.3 轮次链的报告

自动续轮时，最终报告**不得**分成 N 份互相独立的报告。必须有一份**主报告**，汇总所有轮次：

```markdown
# round31~round33 审计报告（自动续轮）

## 轮次链
| 轮次 | 覆盖切片 | 新增发现 | DEFERRED 剩余 | 状态 |
|---|---|---|---|---|
| round31 | 16 | 12 | 40 | CLOSED |
| round32 | 16 | 5 | 24 | CLOSED |
| round33 | 16 | 2 | 8 | CLOSED |

## 总计
覆盖 48/56 切片（86%），8 片因 <REASON> 未覆盖。
```

**为什么必须汇总**：用户关心的是「这个仓库被审到什么程度」，不是「每一轮各做了什么」。分散成 N 份报告等于让用户自己加总——这又回到擦屁股。

### 6.5.4 成本护栏

自动续轮会**成倍放大 token 消耗**。三层护栏：

```
1. 单轮上限：total_budget（默认 60）
2. 总链上限：max_rounds（默认 5）→ 最坏 300 个 agent
3. 用户可设 hard_stop：任一时刻可中断，已产出的报告有效
```

**默认 `max_rounds = 5` 是保守值**，不是最优值。大仓库（如 `D:\Web\style` 这种 56 片的）需要约 4 轮才能覆盖完（56/16）。若用户明确说「不计 token 审到底」，可以提高；**默认值不应假设用户愿意付出 4 倍成本**。

---

## 第 7 节：最小可行实现（纯提示词方案怎么办）

上面的协议在**没有调度器**的情况下也能落地，方法是让主 Agent 把 `state.json` 当作**自己维护的一个文件**：

```
主 Agent 的每一轮动作循环：
  1. 读 state.json（或用自己上一轮的内存副本 + 校验）
  2. 决定下一个要派的任务（确定性规则）
  3. 写 state.json（加 in_flight）
  4. 派 agent
  5. 收结果
  6. 写 state.json（改 DONE、加产物路径、扣预算）
  7. 回到 1
```

**代价（必须承认）**：纯提示词下 `state.json` 的写入靠模型自律，可能漏写。因此：

- **至少要保证规则 1 和规则 2 的落盘顺序**（先写后派 / 先写再派下一个）；
- 若发现 `state.json` 与产物目录不一致，**以产物目录为准重建**——因为产物是子 Agent 真实写出的，比主 Agent 的记账更可信；
- 重建时把差异写进 `discipline_log`，标注 `state_rebuilt_from_artifacts`。

**这条兜底很重要**：round31 的教训正是「账本记 22，产物 47」。**产物优先于账本**这一条，比账本自身的准确性更可靠。

---
