# FIX-R8 报告 · 用 harness 真实 session 日志堵住洞 1

**任务**：用 dsh 的真实 session 日志作为外部基准，让「账本声称派发了 N 个修复实例」必须与「harness 记录的 M 次 `subagent` 调用」对得上，从而堵住 R7 §4 报告的洞 1。
**日期**：2026-11-15
**改动范围**：只新建 `tools/check-fix-instances-harness.mjs`（检查器）+ `tools/check-fix-instances-harness.test.mjs`（自测）。未改任何其他文件，**未注册到 `check-all.mjs`**，未 commit。

---

## 一、8 条规则的实现清单

| # | 规则 | 级别 | 判据 | 退出码影响 |
|---|---|---|---|---|
| 0 | `sessions_root_missing` | CONFIG | `--sessions` 指向的目录不存在 | exit 2 |
| 0 | `state_missing` / `state_invalid` | CONFIG | `state.json` 不存在 / 解析失败 / 顶层不是对象 | exit 2 |
| 0 | `session_not_found` | CONFIG | 指定或推断的主 session 在 root 下找不到 | exit 2 |
| 0 | `session_undecodable` | CONFIG | 找到文件但 zstd 解不开 / 没有 `type:"session"` 事件 | exit 2 |
| 0 | `project_dir_ambiguous` | CONFIG | root 下有多个 project 目录且未指定 `--project-dir` | exit 2 |
| 0 | `unsupported_harness` | **WARN** | root 下一个 `session.v4.jsonl.zstd` 都没有 | **exit 0** |
| **3** | **`claimed_agents_exceed_real_subagents`** | **FAIL** | `distinct(fix_agent_id)` > 真实 `subagent` 调用数 | exit 1 |
| **4** | **`zero_subagent_but_multiple_agents`** | **FAIL** | 真实调用 == 0 且 `distinct(fix_agent_id)` ≥ 2 | exit 1 |
| 5 | `spawned_count_exceeds_real` | FAIL | `budget.spawned_fix_agents` > 真实调用数 | exit 1 |
| 6 | `no_subagent_capability` | WARN | `request/header.data.header.tools` 里没有 `subagent` / `subagent_fork` | exit 0（并把 3/4/5 降级为 WARN） |
| 7 | `child_sessions_missing` | WARN | 真实调用 N 次，但 `parentSession == 主 session id` 的子 session 数 < N | exit 0 |
| 8 | `session_id_mismatch` | WARN | `fix_agent_id` 形如 `session-<uuid>` 或裸 uuid，且 sessions root 下找不到 | exit 0 |
| — | `capability_unknown` | WARN | 日志里没有 `request/header`，无法判断 harness 能力 | exit 0 |
| — | `more_real_dispatches_than_claimed` | INFO | 真实调用数 > `spawned_fix_agents`（多派发不是违规，但账本少记要可见） | exit 0 |
| — | `single_contract_without_dispatch` | WARN | 1 条契约 + 0 次真实派发时的可操作提示（见 §5.2） | exit 0（规则 3 仍 FAIL） |
| — | `project_dir_inferred` | INFO | 自动识别了 project 目录 | exit 0 |

退出码：**0 通过（允许 WARN/INFO）/ 1 有 FAIL / 2 配置错误**。

### 1.1 「外部事实」是怎么取的

复用 `tools/dsh-session-audit.mjs` 的解码逻辑（未 import 它——它顶层就 `process.exit`，不可复用为模块，所以照抄了同样的解码写法）：

- `<root>/<project-dir>/<session-dir>/session.v4.jsonl.zstd`，`zlib.zstdDecompressSync`
- `session` 事件字段在**顶层**：`id` / `delegationDepth` / `parentSession` / `origin` / `cwd`
- 真实派发数 = `tool/call` 里 `.data.name === 'subagent'` 的条数（`subagent_fork` 单独计数并合并进 `realSpawnCalls`）
- 兜底：整份日志没有 `tool/call` 时，改数 `assistant/message` 的 `tool-call` 内容块（`countedFrom` 字段会标出用了哪条路径），避免把「日志格式差异」误判成造假
- 工具集 = 所有 `request/header` 的 `.data.header.tools[].name` **并集**（一次请求里出现过 `subagent` 就算有该能力）
- 子 session 数 = 同 project 目录下 `parentSession === 主 session.id` 的 session 个数

---

## 二、先写测试：RED → GREEN

**RED**（工具还没写时的实际输出）：

```
node tools/check-fix-instances-harness.test.mjs
Error: Cannot find module 'D:\Projects\AI prompt\many-agents…'
合计: 13 通过 / 54 失败
EXIT=0
```

> 注意 `EXIT=0` 是 shell 的 `PIPESTATUS` 假象——测试脚本自己 `process.exit(1)`，但那行是 `tail` 的退出码。断言层面的 54 条失败已足以确认测试是真的在测东西，而不是空跑。

**GREEN**：

```
node tools/check-fix-instances-harness.test.mjs
合计: 72 通过 / 0 失败
EXIT=0（无 FAIL / WARN）
```

覆盖范围：配置错误 5 组（A）、核心对账 7 组（B，含 B6 的单契约边界）、WARN 与合法降级 4 组（C）、session 推断 3 组（D）、**真实 dsh 日志自证 2 组（E）**。

另做了一次「真实日志不存在」的降级验证（把常量改成不存在的路径后跑）：

```
=== E：真实 dsh session 自证（外部基准）===
  SKIP: … 不存在——真实 session 日志不在这台机器上，按降级处理（不计失败）
合计: 59 通过 / 0 失败
```

即：E 段整体跳过，其余 59 条照跑，**exit 0**。这是任务书要求的「跳过不算失败」。

---

## 三、合成 fixture 的实测输出（规则 4 为最关键）

fixture：`zstdCompressSync` 生成 `--D-Tmp-zero--/session-cccccccc-…/session.v4.jsonl.zstd`，内含
`196` 个 `step/start`、`303` 个 `tool/call`（全是 `read`，**0 个 `subagent`**），`request/header` 的工具集含 `subagent`；账本 5 条契约、5 个不同 `fix_agent_id`、`spawned_fix_agents: 5`。

**原文输出**：

```
──────────────────────────────────────────────────────────────────
修复实例 × harness session 日志对账
──────────────────────────────────────────────────────────────────
  账本:   …/state.json
  session: session-cccccccc-1111-2222-3333-444444444444
账本（自述）
  distinct fix_agent_id : 5
  spawned_fix_agents    : 5
harness（外部事实）
  subagent 调用         : 0
  subagent_fork 调用    : 0
  工具调用总数 / step   : 303 / 196
  subagent 能力         : 有
  子 session 数         : 0

✗ FAIL [zero_subagent_but_multiple_agents]
    账本里有 5 个不同的 fix_agent_id（fake-agent-1、fake-agent-2、fake-agent-3、fake-agent-4、fake-agent-5），但 harness 日志显示这个主 session 一次 subagent 都没有发起（本 session 实测：303 次工具调用、196 个 step、0 次 subagent）。
    这与 2026-11-15 那次真实事故完全同形：303 次工具调用、196 个 step、0 次 subagent——主 Agent 在自己一个 session 里串行做完了全部修复，然后在账本上把「我修了 5 条」写成了「我派发了 5 个实例」。
    账本记的是主 Agent 对自己工作的印象，session 日志是外部事实。这 5 个 id 里有 5 个没有对应的真实派发——没有任何外部依据证明这些实例存在过。
    请真正按缺陷逐条派发独立实例，或改用 discipline_log 如实申报「单实例串行」并说明理由。

✗ FAIL [spawned_count_exceeds_real]
    budget.spawned_fix_agents = 5，但 harness 日志显示主 session 只发起了 0 次 subagent 调用（subagent 0 次 / subagent_fork 0 次）。…

合计: 2 FAIL / 0 WARN / 1 INFO → exit 1
```

规则 3 的 8 假 id（`spawned=1`，真实 1 次调用）原文关键行：

```
✗ FAIL [claimed_agents_exceed_real_subagents]
    账本声称派发了 8 个修复实例（fix_agent_id 去重 8 个），但 harness 日志显示主 session 只发起了 1 次 subagent 调用（subagent 1 次 / subagent_fork 0 次；该 session 共 41 次工具调用、20 个 step）。账本记的是主 Agent 对自己工作的印象，session 日志是外部事实。这 8 个 id 里有 7 个没有对应的真实派发。
```

三个「绿」的形态（防止检查器只会判红）：

| 场景 | 断言 |
|---|---|
| 5 次真实 subagent + 5 个 id + spawned=5 + 5 个子 session | exit 0，无 FAIL，`child_sessions_missing` 不报 |
| 工具集无 `subagent` + 5 个 id | exit 0，`no_subagent_capability` WARN，规则 4 降级为 WARN 仍可见 |
| 真实 6 次派发 vs 账本 4 个 | exit 0（多派发不是违规），`more_real_dispatches_than_claimed` INFO |

---

## 四、真实数据自证结果

root：`<HOME>/.dsh/sessions`（19 个 project 目录、1445 个 session、约 845 MB）。

### 4.1 `a40f0162` —— 那次事故的修复 session

账本按 R7 洞 1 的构造重放：8 个 `fake-agent-1..8`、`spawned_fix_agents: 8`。

```
  session: session-a40f0162-d036-49ca-8677-efb40f821c06
账本（自述）
  distinct fix_agent_id : 8
  spawned_fix_agents    : 8
harness（外部事实）
  subagent 调用         : 0
  subagent_fork 调用    : 0
  工具调用总数 / step   : 303 / 196
  subagent 能力         : 有
  子 session 数         : 0

✗ FAIL [zero_subagent_but_multiple_agents]
✗ FAIL [spawned_count_exceeds_real]

合计: 2 FAIL / 0 WARN / 0 INFO → exit 1
```

**报出的是**：8 个 id **一个都没有**真实派发（`这 8 个 id 里有 8 个没有对应的真实派发`），并引用真实基线 `303 次工具调用、196 个 step、0 次 subagent`。数字与 R7 / `dsh-session-audit` 的独立统计**完全一致**——303 / 196 是日志里数出来的，不是 fixture 里的常量。

注意 `subagent 能力: 有`：这个 session 的 `request/header` 里确实带了 `subagent` 工具。所以这里是「有能力但没派发」，不是「环境不支持」——正好排除了「被规则 6 降级」这条辩解。

### 4.2 `d6a9f092` —— 审计阶段成功派发的对照

```
  session: session-d6a9f092-b6df-4b41-b053-3a2e802e7214
  distinct fix_agent_id : 3
  spawned_fix_agents    : 3
  subagent 调用         : 3        ← 正确数出 3 次
  子 session 数         : 3        ← parentSession 反查找到 3 个

✓ 账本与 harness 记录一致（无 FAIL / WARN）。
合计: 0 FAIL / 0 WARN / 0 INFO → exit 0
```

**数出了 3 次**，且 `parentSession == d6a9f092` 的子 session 恰好 3 个（`14165c62` / `ae9ddb35` / `d44062f5`），双向对得上。同一个检查器在事故 session 上红、在成功 session 上绿——这不是「永远红」或「永远绿」的摆设。

（`04d1692d` 是另一个成功对照：3 次 `subagent`、3 个子 session（`26f73cfa` / `716a534e` / `da9aa858`），行为与 `d6a9f092` 一致。）

---

## 五、洞 1 现在真的堵住了吗？

**结论：账本侧的自述造假已经堵住了；但它不是「修复相位的强制闸门」，残余绕法有三条，其中一条是真的。**

### 5.1 堵住的部分

R7 的原始绕过探针（8 个假 id + spawned=8 → 两道门全绿）现在：

```
stop-hook        exit 0   （仍然绿，它只能看账本）
check-fix-instances exit 0 （仍然绿，它只能看账本 + 裁决表）
check-fix-instances-harness exit 1，2 FAIL  ← 新
```

洞 1 的成因是「三个数字全是自述」。现在第四个数字**不来自 `state.json`**：它来自 harness 在执行时写下的 `tool/call` 记录。主 Agent 要伪造它，必须去改 `~/.dsh/sessions/` 下的 zstd 日志——那已经越过了「账本造假」进入「篡改 harness 运行时数据」，性质完全不同（而且 zstd 日志里还有 `tool/result`、`job/registered`、`seq` 连续性，单改一处会对不上）。

**一个关键设计点**：规则 4（0 次派发 + ≥2 个 id）与规则 3 是**互斥**的，0 次时只报规则 4。这是有意的：一个成因只报一条，否则读的人会以为有两个独立问题。但两条消息都带同样的核心句「账本记的是主 Agent 对自己工作的印象，session 日志是外部事实」和缺口数字（`这 N 个 id 里有 N-M 个没有对应的真实派发`）。

### 5.2 残余绕法 1（**真洞**）：不接进流程 = 不产生约束力

本次任务的约束是「不要注册到 `check-all.mjs`」（理由正当：它依赖外部 session 目录）。但这也意味着：**工具存在 ≠ 有人在跑它**。

R7 洞 1 的两道门之所以能拦人，是因为 `stop-hook.mjs` 在**每个回合结束时**自动跑。本检查器没有这个挂载点，所以如果有人真的想绕过，他只要不跑它就行——账本照旧全绿。

**要真正闭上，需要 `stop-hook.mjs` 在 wave4/wave5 且 `path_mode=FIX` 时调用它，并且只在该 project 有 dsh 日志时才启用**（否则每个非 dsh 环境都会收到 unsupported_harness 的噪音）。这属于 R1 的改动，**不在本次范围**（任务书限定只新建两个文件）。我把这一点明写在这里，是因为它决定了「洞 1 是否真的堵住」的答案：

> 判据已经存在且被真实数据验证过；**约束力取决于下一轮有没有人把它挂到 stop-hook 上**。在挂上去之前，它是「可用的证据」而不是「生效的闸门」。

### 5.3 残余绕法 2（**中等，已在测试里固化**）：真派 8 次，但子 agent 空跑

```
8 次真实 subagent 调用 + 8 个 id + spawned=8 → exit 0（只报 child_sessions_missing WARN）
```

只要主 Agent 真的调用 8 次 `subagent`（哪怕每次 prompt 是「立即返回 ok」），规则 3/4/5 全过。本检查器**只验证「派发发生了」，不验证「派发有效」**。

- 部分缓解：`child_sessions_missing` 会对着「8 次调用但 0 个子 session」的情况报警（因为空跑的子 agent 往往不落独立 session）。但如果它真的写了 8 个空子 session，这条 WARN 也消失。
- 完整的下一步是复用 `dsh-session-audit.mjs` 的判据（子 agent 是否有 `assistant/message` 文本产出、父级是否收到 `subagent-settled`），那是另一个工具，不在本次范围。
- **但注意成本不对称**：洞 1 的原始形态（1 个 session 假称 8 个）成本为零；「真派 8 次空跑」要花 8 次真实 LLM 调用。检查器把造假成本从「改 8 行 JSON」抬到了「真的付 8 次派发的钱」。这在审计上是实质性的改进，尽管不是绝对的。

### 5.4 残余绕法 3（**轻**）：`--session-id` 指错

指到另一个session（比如上一次跑的、恰好有 3 次 subagent 的），就能拿别人的事实给自己背书。缓解：省略 `--session-id` 时按该 project 下**最新顶层 session**（mtime）推断；多 project 目录时不猜（`project_dir_ambiguous` exit 2）。但如果没有人显式指定，而「最新的 session」并不是「本次账本对应的 session」（例如日志在账本之后又开了一个新对话），推断就会错。这是推断类判据的固有边界，故只做 WARN 级别的辅助规则，不升级。

### 5.5 规则 6 的降级是必要之恶

`no_subagent_capability` 触发时，规则 3/4/5 全部降为 WARN。这意味着：**一个真的没有 subagent 能力的环境，账本可以随便写**。这是合法的（`run-state.md` 承认 `discipline_log` 申报），但也确实是一个口子。判断：接受。理由是若不降级，所有非 subagent 环境会永远红，防线会被直接关掉——那比留一个「只在无能力环境存在的口子」更糟。**唯一不能接受的是静默**：所以降级后的 WARN 消息里写明了「已降级为 WARN：本 harness 的工具集里没有 subagent」。

### 5.6 与洞 2 / 洞 3 的关系

不改变 R7 的判断：洞 2（HIGH 全填 `WONT_FIX`）仍然绕得过 `high_severity_unaccounted`；洞 3（裁决表自填）仍然绕得过 R6。本检查器只看派发事实，不看裁决与去向。**洞 1 是这三者里唯一「有外部记录可查」的，所以也只有它能被这样堵。**

---

## 六、跨 harness 的适用性

### 6.1 现状：只支持 dsh

| harness | 日志位置 | 本次是否支持 |
|---|---|---|
| dsh | `<root>/<project-dir>/<session>/session.v4.jsonl.zstd`（zstd 压缩 JSONL） | **是** |
| Claude Code | `~/.claude/projects/<slug>/<session-uuid>.jsonl`（未压缩 JSONL，子 agent 记录是 `isSidechain` / `parentUuid` / `Task` 工具调用） | **否** |
| 其他 | — | 否 |

文件头（`check-fix-instances-harness.mjs` 顶部注释）写清了这一限制，并给出 Claude Code 的接入路径：新增 `readClaudeCodeSession()` 适配器，把「真实派发数」映射到 `type:"assistant"` 且 `content[].type === "tool_use"` 且 `name === "Task"` 的条数，父子关系从 `isSidechain` / `parentUuid` 推。本轮**故意不做半成品**——写一个没被真实日志验证过的适配器，等于给一个假的外部基准。

### 6.2 降级策略：不支持 ≠ 造假

这是本次最重要的跨 harness 设计决定：

```
探测 sessions root → 有没有 session.v4.jsonl.zstd
  有                     → 按 dsh 规则跑（可能 exit 1）
  没有，且未显式指定 id   → unsupported_harness WARN → exit 0
  没有，且显式指定了 id   → session_not_found → exit 2
```

- 第一分支才产生 FAIL。
- 第二分支：**exit 0 + WARN**。一个只支持 dsh 的工具在 Claude Code 环境里不能把修复流程卡死——那会让人直接把这个检查器从流程里删掉，反而失去将来的接入机会。WARN 消息里明确写「这是『工具没覆盖』，不是『账本合规』」。
- 第三分支：显式指定了 id 却找不到，说明路径或 id 给错了，继续跑只会得到假绿，所以 exit 2 而不是 exit 0。

同样地，`session_undecodable`（文件在但 zstd 解不开）走 **exit 2**，不当作「0 次派发」——**读不到 ≠ 没有**。这条与 `sessions_root_missing` 是同一条纪律：配置/读取错误必须与「事实为 0」区分开，否则会把「工具坏了」误报成「账本造假」。

---

## 七、交付清单

| 文件 | 状态 | 行数 | 验证 |
|---|---|---|---|
| `tools/check-fix-instances-harness.mjs` | **新建** | 约 430 | 被下列自测调用 |
| `tools/check-fix-instances-harness.test.mjs` | **新建** | 约 400 | **72 通过 / 0 失败，exit 0** |
| `experiments/hilltop-dsh/FIX-R8-report.md` | **新建**（本文） | — | — |

- **未注册到 `check-all.mjs`**（已 grep 确认：`grep -c check-fix-instances-harness tools/check-all.mjs` → `0`）。
- `git status --short` 只显示这两个新文件（另有一个不是本次产生的 `FIX-R6-report.md`，来自并行 agent，未触碰）。
- 未修改任何现有文件，未 commit。

**给下一轮的一句话**：判据已经就绪并被真实数据双向验证（事故 session 红 / 成功 session 绿）；**要让它成为闸门，下一步是把它挂到 `stop-hook.mjs` 的 wave4/wave5 分支上，并且只在探测到 dsh 日志时启用**。
