# DIAG3 — Session Forensics: Why the Main Agent Never Delegated a Subagent

Status: COMPLETE — all five questions answered from primary logs; every count is reproducible from the stated event types.
Scope: read-only forensics over dsh `session.v4.jsonl.zstd` logs. No dsh runs, no repo mutation.

## 0. Method / decoding

Logs decoded with Node 26 built-in zstd:

```js
const fs=require('fs'), z=require('zlib');
const out = z.zstdDecompressSync(fs.readFileSync(path)).toString();
const L = out.split('\n').filter(Boolean).map(l=>{try{return JSON.parse(l)}catch(e){return null}}).filter(Boolean);
```

Field locations confirmed empirically:

| datum | location |
|---|---|
| delegation depth | `event.delegationDepth` (top level on `session` event) |
| tool call | `event.data.name` + `event.data.arguments` (arguments = JSON string) |
| reasoning | `assistant/message` → `.data.message.content[]` where `type === 'reasoning'`, text in `.text` |
| tool schema | `request/header` → `.data.header.tools[]` |
| injected task brief | `agent/inbox/spliced` → `.data.inserted[].content[].text` |
| compaction | `compaction/start` / `compaction/summary` / `compaction/end` / `compaction/prune` |

### Sessions examined

| label | session id | dir | depth | steps | tool calls | subagent calls | turn completion |
|---|---|---|---|---|---|---|---|
| repair #1 | `e0582c67-6bed-41a1-9cb7-0e3e59872be0` | audit-framework | 0 | 66 | 113 | **0** | **truncated — no `turn/end`, log stops mid-step 66** |
| repair #2 | `a40f0162-d036-49ca-8677-efb40f821c06` | Hilltop plugin | 0 | 196 | 303 | **0** | completed (57.5 min) |
| repair #3 | `d5ad7820-e3c4-4c04-a260-bcb8cafe1ac0` | Hilltop plugin | 0 | 82 | 129 | **0** | completed (19.0 min) |

Caveat: `e0582c67` is a **partial** capture — 9.4 minutes, last event is `job/registered` at step 66, and there is no `turn/end`. Its 59 reasoning blocks cover the portion that was logged. This does not weaken the finding (0 `subagent` mentions in 59 blocks / 116k chars, and its brief has 0 delegation keywords), but it should not be described as a completed repair run. `a40f0162` and `d5ad7820` are complete single-turn runs and are the load-bearing samples.

Tool-call histograms (from `tool/call` events):

- `e0582c67` (113): `read` 62, `pwsh` 29, `grep` 15, `job_output` 4, `write` 3
- `a40f0162` (303): `read` 124, `pwsh` 64, `edit` 59, `grep` 43, `write` 9, `todo_write` 2, `glob` 1, `working_directory` 1
- `d5ad7820` (129): `read` 45, `grep` 26, `pwsh` 23, `edit` 23, `glob` 6, `write` 3, `job_output` 2, `job_kill` 1

Zero `subagent`, zero `subagent_fork`, zero `workflow`, zero `send_message`, zero `list_agents`, zero `interrupt_agent` in all three.

---

## 1. CORE ANSWER — "didn't think of it" vs "thought about it and judged it wrong"

### 1.1 Quantitative result

Reasoning was extracted from every `assistant/message` `reasoning` block and searched case-insensitively.

| session | reasoning blocks (non-empty) | all reasoning blocks incl. empty | reasoning chars | `subagent` | `sub-agent` | `子agent` | `子代理` | `并行` | `parallel` | `分解` | `decompos` | `委派` | `delegate` | `分工` | `派` (any) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `e0582c67` (repair #1) | 59 | 132 | 116,425 | **0** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | **0** |
| `a40f0162` (repair #2) | 165 | 392 | 239,342 | **0** | 0 | 0 | 0 | 0 | **3** | 0 | 0 | 0 | **1** | 0 | **0** |
| `d5ad7820` (repair #3) | 71 | 164 | 129,330 | **0** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | **1** |
| **total** | **295** | **688** | **485,097** | **0** | **0** | **0** | **0** | **0** | **3** | **0** | **0** | **0** | **1** | **0** | **1** |

Note: dsh emits a `reasoning` block on most assistant messages, but the majority are empty strings (688 blocks total, 295 with text). Counts above are over non-empty text only; including the empty blocks does not change any keyword count.

### 1.1b Exposure vs retrieval — the token was present in context, absent from thought

Because `request/header` is re-emitted on every model request, we can count how often the word `subagent` was actually in the prompt:

| session | occurrences in `request/header` (tool schemas) | occurrences in `system/message` | occurrences in own `assistant` output | occurrences in `user` messages | occurrences in `tool/result` |
|---|---|---|---|---|---|
| `e0582c67` | **105** | 4 | **0** | 0 | 0 |
| `a40f0162` | **240** | 4 | **0** | 0 | 0 |
| `d5ad7820` | **120** | 4 | **0** | 0 | 0 |

(`request/header` count is per-header; 7/16/8 headers respectively, each carrying the `subagent` + `subagent_fork` + `list_agents` + `interrupt_agent` + `send_message` descriptions.)

So over the course of `a40f0162` the model was re-shown the `subagent` tool roughly 15 times per step across 16 header snapshots, plus a system-prompt sentence telling it when to start independent delegations. It never emitted the word once. This is not a salience-by-absence problem; it is a **retrieval/trigger** problem — the tool is present but no task feature maps onto it.

**Headline (explicit form): 295 条非空 reasoning 中，`subagent` 出现 0 次。** If empty blocks are included the denominator is 688; the count is still 0. The same holds for `子agent` / `子代理` / `并行` / `分解` / `decompos` / `委派` / `分工`. Only `parallel` (3), `delegate` (1), and `派` (1) appear at all, and all five occurrences are false positives quoted below.

The 5 loose occurrences (in 4 reasoning blocks) are all false positives, quoted verbatim below so the claim is auditable:

1. `a40f0162` seq 43, step 1.3 — `parallel`:
   > "Need read relevant chunks. ConfigManager 1250-1660, 400-450, merge method, normalizeWaveTimeout, hasUnsaved. Also GameConfig fields/setters. MainConfigMenu. NodeListener. ExplodeBeetle. ArenaReset. Tests. **Use parallel reads.**"

   This is about issuing multiple `read` tool calls in one step — not about subagents.

2. `a40f0162` seq 1417, step 1.190 — `parallel` (twice):
   > "Also test full. **Parallel: full suite and list.** Then copy after."
   > "We can run and simultaneously list artifacts? Independent. **Use multi_tool parallel.**"

   Again, batching tool calls locally.

3. `a40f0162` seq 994, step 1.133 — `delegate`:
   > "Existing call sites nodes use overload 6 args **delegates** true."

   Java method-overload delegation (`abort(...)` → `abort(..., true, ...)`). Nothing to do with agents.

4. `d5ad7820` seq 296, step 1.39 — `派`:
   > "这条我现在正式**派**给你，编号 #8「reload 消息说谎」。"

   This is the model *quoting the user's task brief* back to itself while reasoning about scope. It is the user doing the dispatching, not the agent considering delegation.

The single `multi-agent` occurrences are also incidental: `a40f0162` seq 1428 refers to the audit framework directory path (`multi-agent-audit-framework`), and `e0582c67` seq 417/426 refer to "an automated multi-agent audit experiment" as the *context of the request*, not as an action available to it.

### 1.2 Verdict

**"Didn't think of it" — and more precisely: not merely absent from consideration, but absent from the vocabulary of the reasoning stream.**

This is not the "considered and rejected" failure mode. There is no passage anywhere in 485k characters where the main agent weighs delegating work, enumerates it as an option, or rejects it for a reason (context cost, coordination overhead, task atomicity, sandbox constraints, etc.). The failure mode is **no trigger, no retrieval**: the tool exists in the schema (see §3), the system prompt even contains a positive nudge (see §3.3), and yet the option never enters the deliberation.

Consequence for prompt design: the fix is **not** to remove a conservative "don't use unless asked" instruction (there is none — see §3), and **not** to correct a bad value judgment (there is none to correct). The fix must supply an **explicit, concrete, task-shaped trigger condition** that survives contact with a long single-turn implementation task — something the model pattern-matches against while planning, not a general capability statement.

### 1.3 Secondary observation: the reasoning stream is saturated with local scope arbitration

`a40f0162` in particular spends enormous reasoning budget on *sequencing and scope* decisions — e.g. seq 994 (4,202 chars), seq 1417 (3,098 chars) — all of it about which Java overload to touch, whether an edge case is in scope, and whether to expand a fix. In 196 steps it never once treats "this work has independent parallelizable parts" as a category. The task was in fact decomposable (the brief contains multiple numbered defects #7/#1/#6/#4), which makes the absence more diagnostic: even a task with explicit numbered sub-items did not cue decomposition.

### 1.4 Planning-stage corroboration: the first todo list is serial

The omission is visible at the very first planning step, before any context growth or compaction.

`a40f0162`, step 1.1, first `todo_write` (`seq 15`) — all seven items are serial:

1. "Inspect repo state, config loading, repair flow, explosion and reset code/tests"
2. "#7 Add failing tests, then clamp load/merge values and mark normalization pending"
3. "#3 Assess reload intent from messages.yml and implement/test chosen fix"
4. "#1 Add failing tests, implement planRepair settlement and wire listener"
5. "#6 Add failing test, separate explosion power from node-damage multiplier"
6. "#4 Add failing test, choose safe reset ordering/rollback and implement"
7. "Run full builds after each fix, write done-*.md artifacts and SUMMARY.md"

There is no "dispatch", "delegate", "parallel", or "subagent" item — the plan is a linear checklist of five defects.

Contrast the audit main `d6a9f092`, step 1.1, first `todo_write` (`seq 17`):

1. "Inspect output contract, checker, and target module inventory"
2. **"Launch 3 parallel audit subagents (A/B/C) with strict evidence and output requirements"**
3. "Review outputs, run per-file payload checks, repair failures"
4. "Summarize paths, validation results, and finding counts"

Item 2 is delegation, written into the plan before any module was read. This is the cleanest single contrast in the dataset: same model, same tools, same system prompt, same first-step planning behavior — the only difference is whether the brief put delegation into the plan.

`e0582c67` and `d5ad7820` made no `todo_write` calls at all; their entire work was held as a prose plan (see `d5ad7820` seq 14: a six-step "read → red test → run → fix → full suite → artifact" sequence, again purely serial).

---

## 2. Compaction — `a40f0162` compacted 5 times; the brief was never lost

### 2.1 Counts

`a40f0162` ran **196 steps** in a single turn (~57.5 min wall clock, `turn/end.reason.kind = "completed"`).

| metric | a40f0162 | d5ad7820 | e0582c67 |
|---|---|---|---|
| steps | 196 | 82 | 66 |
| `compaction/start` | **5** | 2 | 2 |
| `compaction/end` | 5 | 2 | 2 |
| `compaction/summary` | 5 | 2 | 2 |
| `compaction/prune` events | **42** | 19 | 19 |
| total `shadowedTokenCount` | **204,445** | 85,653 | 66,943 |
| largest single prune | 12,491 | 12,491 | 12,491 |

Compaction positions in `a40f0162`:

| # | compaction id | at step | summary chars | summary wall time |
|---|---|---|---|---|
| c1 | `71fe119e` | 22 | 13,556 | 22.4 s |
| c2 | `9df30acd` | 63 | 19,671 | 28.1 s |
| c3 | `22d3cd41` | 109 | 12,363 | 18.8 s |
| c4 | `f55f9d29` | 151 | 15,084 | 21.7 s |
| c5 | `e13166ff` | 184 | 17,202 | 23.4 s |

### 2.2 Was the task brief's division-of-work requirement lost?

**No — because the brief never contained one.**

Two separate checks:

1. **The original brief was never pruned.** In all three repair sessions, `compaction/prune` shadows only individual tool-result sequence numbers. The first user message (`seq 8`) is not in any `shadowedSeqs` set:
   - `e0582c67`: `brief seq8 shadowed? false` (19 shadowed seqs)
   - `a40f0162`: `brief seq8 shadowed? false` (42 shadowed seqs)
   - `d5ad7820`: `brief seq8 shadowed? false` (19 shadowed seqs)

2. **Every compaction summary re-states the full defect list and the hard requirements.** Keyword retention across the 5 `a40f0162` summaries:

| summary | `#7` | `#1` | `#6` | `#4` | `#3` | "write a test" | "fails on unfixed" | "artifact per defect" | baseline number |
|---|---|---|---|---|---|---|---|---|---|
| c1 | 7 | 4 | 4 | 3 | 7 | 1 | 1 | 1 | 863 ×2 |
| c2 | 9 | 7 | 7 | 6 | 7 | 1 | 1 | 1 | 863 ×3 |
| c3 | 4 | 4 | 7 | 4 | 4 | 1 | 1 | 1 | 863 ×1 |
| c4 | 3 | 4 | 7 | 8 | 3 | 1 | 1 | 1 | 863 ×1 |
| c5 | 3 | 3 | 6 | 7 | 4 | 1 | 1 | 1 | 863 ×1, 877 ×2 |

The c5 summary's `## Primary Request and Intent` still opens with:

> "Repair 5 defects in `<TARGET_REPO>`. Prior work fixed #2 (`TabListManager` task accumulation) and #5 (`AirdropSpawnGoal` NPE); do not redo them."

and still contains "Mandatory workflow per defect: write a test that fails on unfixed code, prove the failure, fix, then prove green."

Minor drift only: the phrase "do first / prerequisite" for #7 appears in c1–c3 but not c4–c5. That is an ordering nuance, not a delegation requirement, and #7 remains listed first.

**Conclusion for Q2:** compaction is not a contributing cause. The main agent had the full 5-defect brief in context (seq 8 unpruned) and in every summary. No compaction summary contains `subagent`, `parallel`, `并行`, or any decomposition instruction — because the source brief contained none.

---

## 3. `subagent` tool description — verbatim, and no conservative wording

### 3.1 Verbatim tool description (identical in all 5 sessions)

From `request/header` → `.data.header.tools[]`, `name === "subagent"` (description length 560 chars):

> "Delegate a self-contained task to a subagent (a separate agent that works in its own context) to offload focused, independent work — research, a scoped implementation, an analysis — so it does not consume this conversation's context. The subagent returns its result, not its intermediate steps. This tool starts an independently managed subagent and immediately returns its id. The runtime notifies you when it finishes. The child reports results with `send_message`; use `send_message` to steer it while running or continue its conversation after it finishes."

Parameters: `description` (3-5 words, display), `prompt` ("The complete, self-contained task for the subagent. It does not share this conversation's context, so include everything it needs."), `cwd` (optional).

`subagent_fork` also exists (661-char description), for tasks that build on the conversation:

> "Delegate a task to a subagent that inherits this conversation: a child agent seeded with all completed turns so far (it does not see the current in-flight turn). Use this when the subtask builds on this conversation's context — a follow-up analysis, a review, a continuation — without consuming this conversation's context for the work itself. …"

### 3.2 Conservative wording? No.

A regex scan for `unless | only when | do not use | don't use | avoid | prefer not | not unless | explicitly ask | user asks | 除非 | 不要 | 仅在` over the `subagent` description returns **NONE**.

There is no "unless the user explicitly asks, do not use" clause. The description is purely positive capability framing: "offload focused, independent work — research, a scoped implementation, an analysis".

The **only** conservative wording in the toolset is attached to `workflow`, not to `subagent`. From the system prompt (`system/message`, 2,727 chars, identical in every session):

> "Use the workflow tool **ONLY when the user explicitly asks for a workflow or for large multi-agent orchestration**: you write a JavaScript script (the tool description documents the exact format) that fans work out across many subagents with phases and structured results. **For one or two delegations, prefer plain subagent calls.**"

and immediately after:

> "**Start independent delegations with `subagent` or `subagent_fork` together in one assistant message and continue useful work while they run.**"

So the system prompt contains an explicit **positive** instruction to use `subagent`, and explicitly routes small/simple cases *toward* `subagent` and away from `workflow`. A model that over-generalized the `workflow` restriction could conceivably suppress delegation, but there is no trace of that reasoning anywhere (see §1).

### 3.3 Audit phase vs repair phase: byte-identical

| session | phase | system prompt SHA-256 (16) | full tool array SHA-256 (16) | `subagent` tool SHA-256 (16) |
|---|---|---|---|---|
| `e0582c67` | repair #1 | `5a6d63b646c9bae3` | `5225a85180411512` | `bc9f677b65e0e81f` |
| `a40f0162` | repair #2 | `5a6d63b646c9bae3` | `5225a85180411512` | `bc9f677b65e0e81f` |
| `d5ad7820` | repair #3 | `5a6d63b646c9bae3` | `5225a85180411512` | `bc9f677b65e0e81f` |
| `04d1692d` | audit main #1 | `5a6d63b646c9bae3` | `5225a85180411512` | `bc9f677b65e0e81f` |
| `d6a9f092` | audit main #2 | `5a6d63b646c9bae3` | `5225a85180411512` | `bc9f677b65e0e81f` |

All five run `provider: audit`, `model: virtual/opus`, `maxTokens: 32000`, 25 tools including `subagent`, `subagent_fork`, `workflow`, `list_agents`, `send_message`, `interrupt_agent`.

**Conclusion for Q3:** the tool surface did not differ between the phase that delegated and the phase that did not. There is no conservative wording on `subagent` in either phase.

---

## 4. Control group — the 3 successful audit `subagent` calls

### 4.1 What triggered them: the brief said "派 3 个 subagent"

The audit main session's injected brief (`agent/inbox/spliced seq 3`, 1,534 chars, **byte-identical to disk `task-b2.md`**) contains:

> "## 任务
>
> **并行派 3 个 subagent，每个负责一个模块。** 不要一个 agent 串行读三个模块——那样会因上下文超限而草率收尾。
>
> 每个子 agent 的 prompt 里必须包含：
> 1. 它负责的模块绝对路径
> 2. 「必须用 read 工具真的打开每个文件，不许凭文件名猜」
> 3. 「每条发现必须带 file:line 和逐字引用的代码原文，引用必须来自你这一轮实际读到的那一行」
> 4. 产物路径（见下）"

The second audit main (`d6a9f092`) brief (1,196 chars, **byte-identical to disk `task-b3.md`**) says:

> "按风险分成 3 组，**并行派 3 个 subagent**，每个负责一组："

### 4.2 The main agent's reasoning immediately before dispatch

`04d1692d`, first reasoning block (`seq 16`, step 1.1):

> "We need act as coding agent. Need audit target absolute outside workspace D:/Server/... but read likely allowed? … **Need 3 subagents parallel, each module.** Need produce three files in experiments/hilltop-dsh/out. … **Then delegate.** …"

`04d1692d`, `seq 42`, step 1.3:

> "… Could ask 3 subagents in parallel via one message with 3 subagent calls. … **Need models? Default.** Each module 4k/6k lines, within subagent context maybe read all. …"

`04d1692d`, `seq 54`, step 1.4 (the block right before the calls):

> "**Need dispatch now.** Construct prompts. Ensure exact output file paths. … Need ensure agent returns no long prose but product. …"

`d6a9f092`, `seq 16`, step 1.1:

> "**We need execute audit with three parallel subagents.** Need inspect workspace, output contract example, checker, target paths. Need likely write prompts carefully including hard requirements, file output, check command, JSON envelope format. …"

Note the phrasing: the model does not *decide* to delegate. It **restates the brief's instruction as its own plan** ("Need 3 subagents parallel"), then executes it.

### 4.3 The calls themselves

`04d1692d` — all three in one assistant message at step 1.4:

| call | seq | description | prompt chars |
|---|---|---|---|
| 1 | 55 | 审计 arena 模块 | 2,798 |
| 2 | 56 | 审计 mechanics 模块 | 3,072 |
| 3 | 57 | 审计 ai 模块 | 2,819 |

`d6a9f092` — all three in one assistant message at step 1.6:

| call | seq | description | prompt chars |
|---|---|---|---|
| 1 | 60 | 组 A 配置与统计审计 | 3,405 |
| 2 | 61 | 组 B 命令与权限审计 | 3,428 |
| 3 | 62 | 组 C 外围模块审计 | 3,570 |

Prompt shape (all six share the same scaffolding; round-2 prompts are 2.8–3.1k chars, round-3 prompts 3.4–3.6k):

1. Role sentence, e.g. "你是本轮 Hilltop Village 插件审计的 <module> 模块审计员。只做静态代码审计，不改源码。" (round-3 variants: "你是第三轮 Hilltop Village 静态审计的组 A 审计员（三个并行组之一）…")
2. **Absolute** target directory path.
3. Exact file count and approximate line count; "必须逐个文件完整阅读；大文件超过 read 默认 2000 行时用 offset/limit 分段读到 EOF."
4. Hard requirements, verbatim from the brief: must actually open every file with `read`; every finding needs `file:line` and an exact quote from the line actually read this session; no paraphrase/ellipsis/reconstruction.
5. Module-specific hunting hints (concurrency, data-consistency, error-handling, numeric bounds, resource leaks).
6. Artifact absolute path + required body structure + strict JSON envelope schema.
7. A **mandatory self-check command** with exact path and `--role audit`, "不通过就修到通过".
8. Final reply format limited to path / check result / finding count / one-line titles.

### 4.4 The controlled contrast

Same harness, same model, same 25 tools, same system prompt, same `subagent` description. The only material difference is the brief:

| phase | brief says "subagent / 并行派" | subagent calls |
|---|---|---|
| audit main `04d1692d` | **yes** (`task-b2.md`) | **3** |
| audit main `d6a9f092` | **yes** (`task-b3.md`) | **3** |
| repair `e0582c67` | **no** | **0** |
| repair `a40f0162` | **no** | **0** |
| repair `d5ad7820` | **no** | **0** |
| audit children (6 sessions, depth 1) | their prompt did not ask them to delegate | **0** |

Additionally, `04d1692d` and `d6a9f092` both used `list_agents` (12 and 9 calls) and `send_message` (3 each) to supervise/collect children — i.e. once the delegation frame was established, the full orchestration loop ran normally.

The six audit child sessions (`14165c62`, `26f73cfa`, `716a534e`, `ae9ddb35`, `d44062f5`, `da9aa858`) are `delegationDepth: 1` and still have `subagent`/`workflow` in their tool list, yet made 0 delegation calls. This is consistent: their prompts were scoped single-module audits with no instruction to sub-delegate. Tool availability alone does not produce delegation; a task-shaped instruction does.

A subtlety worth noting: the three round-3 children (`14165c62`, `d44062f5`, `ae9ddb35`) **do** contain the word `subagent` in their first user message (e.g. "你是第三轮 Hilltop Village 静态审计的组 A 审计员（**三个并行组之一**）"). That phrase describes their *own position in the parent's fan-out*; it is not an instruction to them to delegate. All three still made 0 calls. This strengthens the conclusion: merely mentioning subagents/parallelism in ambient text does not trigger delegation — the instruction has to assign delegation as an *action* to the reader.

---

## 5. `agent/inbox/spliced` briefs vs disk files

### 5.1 Repair sessions

| session | injected brief seq | chars | disk file | match |
|---|---|---|---|---|
| `e0582c67` | 3 | 2,737 | **earlier revision of `task-repair.md`** | not identical to current disk file |
| `a40f0162` | 3 | 3,139 | `task-repair.md` | **identical** (only trailing newline differs) |
| `d5ad7820` | 3 | 2,680 | `task-repair-8.md` | **identical** (only trailing newline differs) |

Normalized SHA-256 (16):
- `a40f0162` inbox `aecfe291d127346d` = `task-repair.md` `aecfe291d127346d`
- `d5ad7820` inbox `fedf4e1cab6f6e0a` = `task-repair-8.md` `fedf4e1cab6f6e0a`
- `e0582c67` inbox `64a1f388fd465801`; current `task-repair.md` is `aecfe291d127346d` (does not match)

The `e0582c67` brief is the pre-fix revision: its diff against the current `task-repair.md` is only the build command and the added "运行环境" section:

```diff
- 基线：`./build.sh -o test` → Tests run: 863, Failures: 0
+ 基线：`build.cmd -o test` → Tests run: 863, Failures: 0
+ ## 运行环境（这次运行已修正，务必照做）
+ - **用 `cmd.exe /c build.cmd -o test`，不要用 `./build.sh`。** …
...
- 2. **每修完一条，跑全量** `./build.sh -o test`，必须保持 0 失败。基线是 863。
+ 2. **每修完一条，跑全量** `cmd.exe /c build.cmd -o test`，必须保持 0 失败。基线是 863。
```

### 5.2 Keyword audit of the briefs

| brief | chars | `subagent` | `并行` | `parallel` | `分工` | `分解` | `delegate` | `派` |
|---|---|---|---|---|---|---|---|---|
| `e0582c67` (2737) | 2,737 | 0 | 0 | 0 | 0 | 0 | 0 | **0** |
| `a40f0162` (3139) | 3,139 | 0 | 0 | 0 | 0 | 0 | 0 | **0** |
| `d5ad7820` (2680) | 2,680 | 0 | 0 | 0 | 0 | 0 | 0 | **1** |

The single `派` in `d5ad7820` is line 20:

> "**这条我现在正式派给你，编号 #8「reload 消息说谎」。**"

That is the *user* dispatching work to the main agent. It is the opposite direction of delegation, and it names exactly one task, not multiple independent units.

The audit briefs, by contrast:

| brief | chars | `subagent` | `并行` |
|---|---|---|---|
| `task-b2.md` (injected into `04d1692d`) | 1,534 | **1** | **1** |
| `task-b3.md` (injected into `d6a9f092`) | 1,196 | **1** | **1** |

**Conclusion for Q5:** the three repair sessions received briefs with zero delegation vocabulary. `task-repair.md` and `task-repair-8.md` contain no `subagent`, no `并行`, no `parallel`, no `分工`, no `分解`, no `delegate`. The briefs are faithful copies of disk (modulo the pre-fix revision for `e0582c67`), so this is not an injection or truncation artifact.

---

## 6. Overall verdict

**The failure is "didn't think of it", not "thought about it and decided against it".**

The evidence chain:

1. **295 non-empty reasoning blocks / 485,097 chars** across three repair sessions contain **zero** occurrences of `subagent`, `sub-agent`, `子agent`, `子代理`, `并行`, `分解`, `decompos`, `委派`, `分工`. The only loose hits are 3 × `parallel` about batching local `read`/build calls, 1 × `delegate` about a Java overload, and 1 × `派` quoting the user's brief. No block weighs delegation as an option, rejects it, or assigns it a cost.
2. **The tool exists and is described positively** in every phase. The `subagent` description contains no "unless the user asks" caveat. The system prompt actively says to start independent delegations with `subagent`/`subagent_fork` and to prefer plain `subagent` calls over `workflow` for one or two delegations.
3. **Tool surface and system prompt are byte-identical** between the audit phase (3 calls) and the repair phase (0 calls). The difference is not capability, model, or prompting of the tool.
4. **The briefs differ exactly where it matters.** The two audit briefs say "并行派 3 个 subagent"; the three repair briefs say nothing about subagents or parallel work. Audit → 3 calls in one message, every time. Repair → 0 calls, every time.
5. **Compaction did not erase anything.** The original brief (`seq 8`) was never pruned; all five summaries in `a40f0162` retain the numbered defects and the test-first workflow. The summaries contain no delegation requirement because the brief never had one.
6. **Task decomposability was present but insufficient.** `a40f0162` had five explicitly numbered defects (#7, #3, #1, #6, #4) and 196 steps, and still serialized everything. Numbered sub-items alone did not trigger decomposition. The trigger in the control group was an *explicit instruction to dispatch*, not the mere presence of independent work.

### Implication for prompt design

This rules out two fixes:

- **Not** "remove a conservative guardrail" — there is no guardrail on `subagent`.
- **Not** "correct a wrong value judgment" — no value judgment was made.

The missing piece is a **task-shaped trigger condition** in the implementation/repair brief. The audit briefs worked because they named the mechanism (`subagent`), the cardinality (3), the mapping (one per module/group), and the parallelism (`并行`, one message). A repair brief that says only "fix these 5 numbered defects, test-first, run the full suite" gives the model a serial checklist, and it executes a serial checklist.

A minimal effective trigger would need to be equally concrete, e.g.: "These N defects touch independent files/modules. Dispatch one `subagent` per independent unit in a single message; keep integration, full-suite verification, and the final artifacts in the main agent." Whether that is the right policy is a separate design question; the forensic finding is that without such a sentence, this model does not retrieve the option at all.

---

## Appendix — evidence index

| claim | source |
|---|---|
| depth 0 / 0 subagent calls in 3 repair sessions | `session` event `delegationDepth`; `tool/call` histogram |
| 295 non-empty reasoning blocks, 0 `subagent` | all `assistant/message` → `content[type=reasoning]` |
| exact keyword counts | §1.1 table, scripts over decompressed JSONL |
| audit control 3 calls, one message | `04d1692d` seq 55/56/57; `d6a9f092` seq 60/61/62 |
| audit trigger wording | injected brief `seq 3`; identical to `task-b2.md` / `task-b3.md` |
| repair briefs lack delegation vocabulary | `agent/inbox/spliced seq 3`; hashes vs disk |
| compaction counts/positions | `compaction/start|summary|end|prune` |
| brief never pruned | `compaction/prune.shadowedSeqs` excludes seq 8 |
| tool description identical | SHA-256 of `request/header.data.header.tools` |
| no conservative wording | regex scan of `subagent.description`; system prompt quotes |

Raw extracted artifacts used for this report were written under the OS temp directory only; no repository files other than this report were modified.

