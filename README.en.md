[简体中文](README.md) | English

# Multi-Agent Audit Framework

[![checks](https://github.com/sqkl520/multi-agent-audit-framework/actions/workflows/checks.yml/badge.svg)](https://github.com/sqkl520/multi-agent-audit-framework/actions/workflows/checks.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dependencies: none](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen.svg)](tools)

A code-audit prompt framework built on one rule: **the main agent only dispatches; sub-agents do the work.** Context isolation is how it fights judgment drift over long audit chains.

**Who it's for**: people who already have (or are willing to build) sub-agent dispatch, and who want AI to audit a real codebase rather than a toy project.
**What's different**: it isn't only prompts. It ships a layer of **mechanical checks that can fail**. A rule that is written but not enforced counts as a bug here.

---

## Decide in 30 seconds whether this fits

| What you want | What this gives you |
|---|---|
| Have an AI read a repo and produce findings | ✅ Default path, four read-only waves |
| Have an AI change code along the way | ⚠️ Repair is a **separate optional path**, off by default |
| A guarantee the fix is correct | ❌ **No.** The gates verify process compliance, not code correctness |
| Zero dependencies, and no writes left in the audited repo | ✅ Read-only throughout; reports are written outside the target repo |

**Read [`CAPABILITIES.md`](CAPABILITIES.md) first** — it lists, item by item, what this catches and what it misses, including the fact that **nothing will warn you when it misses a check**. That document will help you decide more than this README does.

---

## Quick start

No dependencies. Node.js ≥ 22 (a few harness-log validators use `zlib.zstdDecompressSync`, available from 22.15).

```bash
git clone https://github.com/sqkl520/multi-agent-audit-framework.git
cd multi-agent-audit-framework

# Run every mechanical check (~40 self-test suites). This is the only thing
# that distinguishes "the rule exists" from "the rule is enforced".
node tools/check-all.mjs
```

Seeing `✅ 全部通过` ("all passed") means the framework itself is healthy. Then follow [`START-HERE.md`](START-HERE.md) to audit your first repo. (The framework documents are currently written in Chinese.)

---

## What it looks like in practice

Measurements from one real run (7 defects, 905-test baseline):

| | Value |
|---|---|
| Wall-clock time | ~90 minutes |
| Sub-agents | 9 (10 real subagent calls) |
| Output | 20 files / +804 −78 / 15 new tests |
| Mechanical gates | 26 validator suites, 0 false blocks |
| **Then an independent red team reviewed those 7 fixes** | **5 were defective, 2 of them seriously** |

That last row is the most important thing this framework says about itself: **all gates green and code correct are two different things.**
The root-cause writeup and the repairs are in [`experiments/review-7/`](experiments/review-7/) —
including the conclusion that *"a green light that lights up is more dangerous than no light at all"*, and the three bogus checks of my own that were deleted because of it.

---

## The core claim

**Have the main agent do nothing.** It doesn't read code, doesn't read reports, doesn't make judgments. It only dispatches agents, reads structured returns, and schedules according to hardcoded rules. Anything that would require "taking a look" to decide must be converted into a sub-agent task.

The benefit isn't division of labour — it's **context isolation**. The main agent's context only ever contains structured task descriptions and result summaries, never code, stack traces, or full reports. That's what prevents context drift and out-of-scope judgment over a long audit chain.

The default path is four read-only waves (repair is a separate optional path):

```
Recon → Sweep → Deep-dive → Critique → Report
```

---

## Setup

### Step 1: settle three prerequisites

| Question | Notes |
|---|---|
| **Who loads the templates?** | Markdown has no loader. Options: ① scheduler code concatenates them (most reliable) ② the harness's skill mechanism (medium) ③ stuff everything into the system prompt (fast, but breaks the isolation principle — not recommended) |
| **What's the concurrency cap?** | The framework assumes 8 by default. If your harness only supports 2–3 parallel sub-agents, have the recon agent state that truthfully in `harness_concurrency_cap`; if it can't be read, use the conservative value `4` rather than optimistically assuming 8 |
| **What's the total budget?** | Default `total_agent_count = 60`, split into 40 for discovery waves and 20 reserved downstream. A project with more than 40 slices won't finish in one round; mark the excess `DEFERRED` for the next round |

### Step 2: choose how to run it

**Option 1 · Claude Code or any harness supporting `.claude/agents/`**

Copy `framework/wrappers/*.md` into `.claude/agents/`, keeping the filenames unchanged. In the frontmatter, `name` / `description` / `tools` / `model` are recognized; `template` / `wave` / `trigger_event` are ignored (they're for the main agent and human readers).

**Option 2 · Agent SDK or your own scheduler** (most reliable)

```python
BASE = "framework/"

def spawn_agent(role, template, extra):
    system = "\n\n".join([
        read(BASE + "components/evidence-policy.md"),
        read(BASE + "components/output-contract.md"),
        read(BASE + template),
    ]) + "\n\n" + extra
    return client.agents.create(system=system, tools=TOOLS[role])

# Wave 1
recon = spawn_agent("recon", "templates/wave1-recon.md",
                    f"trace_id={trace_id} round_id={round_id}")
```

The concatenation **order** must be `evidence-policy` → `output-contract` → template, matching the "mandatory loading" section of each template; on conflict the earlier file wins.

**Option 3 · Prompts only** (not recommended). Here "loading" just means "you gave it the text" — there is no enforcement. If this is your only option, at minimum: open a separate context for every sub-agent and put only the files it needs in it; don't run five waves in one long conversation.

### Step 3: confirm the directory

```bash
ls docs/reports/ || mkdir -p docs/reports/
```

The round-detection agent scans for the `round(\d+)` pattern and takes max + 1 as this round's number. Verify:

```bash
ls docs/reports/ | grep -i '^round' | sort -V | tail -5
```

The last number you see is one before this round's number.

---

## Execution flow

> **🔒 Principle one · zero writes**: unless you **explicitly ask** in this conversation, the main agent and all sub-agents **must not write anything** to the audited repo — no `commit`, no `push`, no `add`, no editing files, no creating files, no installing dependencies. Auditing is a purely read-only activity; reports go outside the audited repo (or into a directory covered by `.gitignore`).
>
> **"Repair" authorization is not "commit" authorization**: even if you ask it to fix code, it may only modify `target_files` and **must not commit**. Editing a file ≠ permission to commit; those are two independent authorization gates.
>
> Reports must end with a `git status` self-check proving zero changes to tracked files. See [`framework/orchestrator/protocol.md`](framework/orchestrator/protocol.md) section 0.

> **2026-11-01 structural revision**: the default path is now **read-only**; repair moved out of the default flow. Reason: in the round31 real run, only 1 of 83 pending repairs completed, the whole round stalled at `IN_PROGRESS`, and **no final report was produced**. Repair is the only role with write permission and the strictest rules — putting it on the default path means the most fragile link decides whether the round can end at all.
>
> See [`docs/analysis/2026-11-01-proposal.md`](docs/analysis/2026-11-01-proposal.md) and [`framework/orchestrator/protocol.md`](framework/orchestrator/protocol.md) section 0.7.

```
[Default path · read-only]    Recon → Sweep → Deep-dive → Critique → Report
                              No write permission, no side effects; terminal state is always CLOSED or PARTIALLY_CLOSED
[Optional path · side effects] Repair → Verify (launched independently; consumes UPHELD findings from the default path's report)
```

### Step 0 · Round detection + state machine init

The main agent dispatches a sub-agent to execute `artifacts/round-detection.md`, which returns `round_id`.

**Critical**: if `docs/reports/round{N}/state.json` exists and `status != CLOSED`, **resume it — do not start round{N+1}**. round31 stalled at `IN_PROGRESS`; starting a new round would re-audit 40 slices that were already audited.

**Gate**: `round_id` is non-empty. If it returns `PERMANENT_FAILURE` (directory unreadable), **stop — do not guess a number**.

### Step 1 · Recon

```
Main agent → dispatch recon-scout
         load: evidence-policy + output-contract + wave1-recon
returns: role=recon, payload={ slice_count, audit_slices[], unverified[],
                               entry_points[], covered_modules[],
                               harness_concurrency_cap }
```

**Gates (all must hold)**: `status == SUCCESS`; `slice_count` is an integer; `slice_count == len(audit_slices)`; `audit_slices` is non-empty; `unverified` is annotated. If any fails → dispatch a **brand-new instance** to redo it; do not shrink the task.

The main agent then performs **the only arithmetic it ever does**:

```
effective_slices = len(audit_slices) + len(unverified)
        ↓ if the ledger has covered_modules carrying a "succeeded last round" mark, reduce by at most 30%
        ↓ consult the mapping table in scale-mapping section 3
scale_decision = {
  effective_slices:              <result above>,
  concurrency_window:            min(8, harness_cap),      # the 1–5 slice tier is min(5, cap)
  planned_sweep_agents:          <see below: sweep and deep-dive share discovery_budget; not first-come-first-served>,
  admission_ceiling:             min(60, effective_slices + 30),
  total_budget: 60,  reserved_for_downstream: 20,  discovery_budget: 40,
  critique_roles:                <look up by slice-count tier>,
  critique_extra:                null | "cross-pattern-scan",
  planned_deep_dive_agents:      null,     # only determined after sweep completes
}
Write to the ledger; do not modify afterwards (deep-dive fields freeze in the second segment after wave 2A closes)
```

**The sweep budget must be split from the deep-dive budget, or the two-pass design collapses**:

```
if effective_slices < discovery_budget:
    planned_sweep_agents = effective_slices
    deep_dive_budget     = discovery_budget - effective_slices
else:
    sweep_budget         = ceil(discovery_budget × 0.4)
    planned_sweep_agents = min(effective_slices, sweep_budget)
    deep_dive_budget     = discovery_budget - planned_sweep_agents
```

> **Why**: if you write `planned_sweep_agents = min(effective_slices, discovery_budget)`, then whenever `effective_slices ≥ discovery_budget` (round31 was 85 ≥ 40) the sweep **consumes the entire budget**, leaving zero for deep-dive, and the two-pass design degrades into "sweep only, zero deep-dive" — **worse than the original design**. Plugging in round31: 16 sweep slices + ~24 deep-dive instances. Fewer slices covered, but **deep-dive goes to PROD code filtered by reachability**.

**Easy mistake**: `concurrency_window` is `min(5, cap)` in the 1–5 tier and only `min(8, cap)` from 6 upward. Don't uniformly write 8.

**The report must give two independent coverage figures**: "sweep coverage" and "deep-dive coverage". They must not be merged into one number pretending full coverage.

### Step 2A · Sweep

**One sweep instance per slice.** It looks at all 6 dimensions but produces **leads only** (`file:line` + one line of source + suspected dimension + confidence). It **does not judge severity, does not enter critique, does not enter the report body**.

At the same time it tags each slice with **`reachability`** (`PROD` / `TEST_ONLY` / `UNREACHABLE`) — this is the key to rescuing budget from dead code.

**Gates**: `lead_count == len(leads)`; the `dimension_histogram` sums to `lead_count`; `files_read` covers the slice's files, or the missing ones appear in `files_unreadable`.

> **Why this step is necessary**: the original design dispatched one instance per `(slice, dimension)` × 6 dimensions. 85 slices would need 510 instances (8.5× the budget). Dispatching per slice would let each slice examine only 1 dimension (giving up 5/6 of coverage). Sweeping per slice makes the arithmetic work.

### Step 2B · Deep-dive (audit)

**Only for slices the sweep marked "should deep-dive".** Each slice is split into instances by the dimensions its leads point at, and goes through the full Gate 0 evidence chain.

**Trigger thresholds (hardcoded, zero discretion)**: a `HIGH` lead → must deep-dive that dimension; `lead_count ≥ 3` → deep-dive the 2 highest-count dimensions; `UNREACHABLE` → do not deep-dive.

**Gates**: all instances reach a terminal state; no `CONTRACT_VIOLATION`; each instance's `searched_scope.files_read` covers `files` + `shared_dependencies`, or the missing files are listed in `unreadable_files`.

**"Zero findings" is not required** — `NO_EVIDENCE_FOUND` is a legitimate and valuable result. But the `findings` array must not be empty; an empty array is always a `CONTRACT_VIOLATION`.

### Step 3 · Critique

Three mutually exclusive roles; one instance carries exactly one. Skeptic kills findings, Devil's Advocate hunts coverage gaps, Arbiter adjudicates in a clean context.

**New fixed duty for Skeptic**: mechanically compare `discipline_log` against the actual dispatch record to find **undeclared discretion**, and output `discipline_violations[]`.

**Gates**: both Skeptic and Devil's Advocate are `SUCCESS`; every `conflicts` entry has a `resolution` that is no longer `PENDING`.

**Key rule**: the Arbiter's `verdict` **must not** be `EVIDENCE_GAP`. When evidence is insufficient it must return `RETRYABLE_FAILURE`, and the main agent dispatches an evidence-collection instance.

### Step 4 · Report (**the default path's endpoint; cannot be skipped**)

Produce `docs/reports/round{N}/round{N}-final-report.md` with five fixed sections: metadata → verdict index → coverage → unclosed items → discretion record + appendix of undived leads.

**Hard rule**: every conclusion unit must carry an `artifact_ref` pointing at the original file. The main agent **only sorts, indexes, and tallies**.

**"The run finished but there's no report" is not a legal terminal state.** Every termination path (normal completion / budget exhausted / user interrupt / repeated failure) must produce a report before exiting. See `artifacts/final-report.md`.

### Step 5 · Repair (**optional path, launched independently**)

Starts only when the user issues a "repair round{N}" instruction. It consumes the `UPHELD` findings from the default path's report and **does not re-recon or re-slice**.

Each finding is accounted for independently: one failing (rollback, needs a human, environment unavailable) affects only that one — **it neither blocks the others nor invalidates the report already produced**.

**Hard constraint on verification**: when dispatching, **do not pass** the repair agent's `verification_commands` or `output_snippet`. And mutation testing is **mandatory** (except `harness_unsupported` / `unsafe_revert`), and must cover the **call site** layer — testing only pure functions lets "revert to the wrong implementation" stay fully green.

---

## Per-wave must-checks

| Wave | Must check | If it fails |
|---|---|---|
| 0 Detect | `round_id` is non-empty | Stop; report directory unreadable |
| 1 Recon | `slice_count == len(audit_slices)` and non-empty | Dispatch a new instance to redo |
| 1 Recon | No size labels like "small/medium/large" | Dispatch a new instance to redo (hard prohibition) |
| 2 Audit | Every finding has `file:line` + a `quote` from this turn | Mark that item `GATE_0_FAILED`; it does not enter downstream |
| 2 Audit | No empty `findings` array | Treat as `CONTRACT_VIOLATION`; re-dispatch |
| 2 Audit | Every `HIGH`/`CRITICAL` has ≥2 `alternatives` | Send back for completion, or downgrade |
| 3 Critique | Arbiter did not use `EVIDENCE_GAP` as a final verdict | Treat as `CONTRACT_VIOLATION` |
| 3 Critique | `untested` was not treated as `refuted` | Send back |
| 4 Repair | `files_touched` are all within `target_files` | Roll back + `CONTRACT_VIOLATION` |
| 4 Repair | No "fixed" / "verification passed" in the return | Treat as self-verification; send back |
| 4 Repair | An empty `affected_issues` carries a confirmation marker | Send back to add the marker |
| 5 Verify | `residual_risk_disposition` covers every `residual_risks` | `CONTRACT_VIOLATION` |
| 5 Verify | No references like "according to the fix report" | `CONTRACT_VIOLATION` |

---

## What to do when things go wrong

Four terminal states map to four different actions. **Do not retry everything uniformly** — this is where implementations most often drift.

| State | Meaning | Action |
|---|---|---|
| `RETRYABLE_FAILURE` | Timeout, rate limit, transient tool error | Re-dispatch a **new instance as-is** with the same template and payload, attempt +1, at most 2 retries (3 total). The new instance gets a fresh timeout budget and **does not inherit partial output** |
| `CONTRACT_VIOLATION` | Missing field, no evidence, out-of-scope file write | **Void all output from that instance**, dispatch a fresh instance to rerun from the original task, **attempt continues to increment (does not reset)**, and stop re-dispatching after 2 consecutive failures for the same reason |
| `PERMANENT_FAILURE` | 3 consecutive failures, or the harness explicitly cannot recover | **Must not shrink scope and re-dispatch.** Write `unverified`; the final report exposes "could not cover" |
| Multiple agents fail at once | 2+ in the same wave within 60 seconds | Pause new dispatches in that wave; record `phase_level_failure` |

**Three prohibitions when a gate fails**: don't lower the gate standard yourself; don't merge the failed subtask into the main thread; don't shrink the task scope and re-dispatch.

Repair has side effects, so the rules are stricter: on `RETRYABLE_FAILURE` with a **non-empty** `files_touched`, you **must execute `rollback_command` first** and confirm the baseline is restored before re-dispatching. If `rollback_command` is unavailable, mark `deferred_items` + `requires_human_intervention` — **do not** re-dispatch without rolling back.

---

## Field reference

**Top-level envelope**

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "string",
  "role": "recon | audit | critique | fix | verify",
  "status": "SUCCESS | RETRYABLE_FAILURE | CONTRACT_VIOLATION | PERMANENT_FAILURE",
  "contract_valid": true,
  "payload": {},
  "error": null
}
```

Sub-agents **must not** return `PENDING` or `RUNNING` — those are internal states of the main agent's ledger; returning them is always a `CONTRACT_VIOLATION`.

**Required payload fields per role**

| Role | Required fields |
|---|---|
| `recon` | `slice_count`, `audit_slices[]`, `unverified[]`, `entry_points[]`, `covered_modules[]`, `harness_concurrency_cap` |
| `audit` | `slice_id`, `searched_scope{}`, `findings[]` (at least one entry) |
| `critique` | `critique_role`, `target_finding_ids[]`, `verdicts[]`, `coverage_gaps[]` |
| `fix` | `finding_id`, `files_touched[]`, `verification_commands[]`, `affected_issues[]`, `residual_risks[]` |
| `verify` | `finding_id`, `fix_agent_id`, `verdict`, `escalation_required`, `evidence{}`, `residual_risk_disposition[]`, `affected_issues_status[]`, `new_issues_found[]`, `failure_trigger` (FAIL), `failure_category` (FAIL) |

**Verdict enum (critique wave)**

```
UPHELD        → enters the repair wave
DOWNGRADED    → enters the repair wave, with severity lowered
REVOKED       → not repaired; the original finding is voided
EVIDENCE_GAP  → Skeptic only; Arbiter must not output this value
```

**Verify enum (verification wave)**: only `PASS | FAIL`. "Pass with reservations" is not a third enum value — it's `PASS` + `escalation_required: true`.

**`open_items.kind` (10 kinds)**

The first 8 are "auto-resolvable blockers" that must be handled before advancing; the last 2 are "human blockers" that don't stop the round from terminating but do stop the defect from being recorded as fixed.

| kind | Automatic action? |
|---|---|
| `UNRESOLVED_FINDING` | Yes (dispatch arbitration / repair) |
| `EVIDENCE_GAP` | Yes (dispatch evidence collection) |
| `COVERAGE_GAP` | Yes (dispatch a new audit) |
| `REGRESSION_SCAN_REQUIRED` | Yes (append a regression scan) |
| `AFFECTED_BY_FIX` | Yes (convert to verification review) |
| `PERMANENT_FAILURE` | Yes (mark as uncovered) |
| `UNVERIFIED_TARGET` | Yes (append slices next round) |
| `DEFERRED_SLICE` | Yes (handle next round) |
| `HUMAN_DECISION_REQUIRED` | **No** — only a human can decide |
| `REVOKED` | **No** — only a human can confirm |

---

## Directory structure

```
framework/
├── MANUAL.md              ← complete manual (the detailed version of this README)
├── README.md              ← overview: design rationale
├── PORTABILITY.md         ← guide for porting across harnesses
├── orchestrator/          ← the only thing the main agent loads permanently
│   ├── protocol.md            dispatch protocol: two paths, discretion tiers, ledger, gates, retries, guardrails
│   └── scale-mapping.md       slice count → sweep/deep-dive dispatch counts and concurrency window, zero discretion
├── components/            ← leaf nodes, no internal dependencies
│   ├── evidence-policy.md     evidence baseline (Gate 0) + citation grading discipline
│   ├── output-contract.md     unified return contract (six roles, including sweep)
│   └── handoff-schema.md      cross-wave Resume Packet
├── templates/             ← wave templates
│   ├── wave1-recon.md         recon
│   ├── wave2a-sweep.md        sweep (1 instance per slice; produces leads + reachability)
│   ├── wave2-audit.md         deep-dive (by dimension, full Gate 0)
│   ├── wave3-critique.md      critique (+ discretion audit)
│   ├── wave4-fix.md           repair (optional path)
│   └── wave5-verify.md        verification (optional path)
├── wrappers/              ← role wrappers (identity + trigger + references)
└── artifacts/             ← mechanical rules
    ├── round-detection.md     round-number detection
    ├── report-naming.md       artifact naming
    ├── run-state.md           state machine: the sole basis for resuming
    └── final-report.md        final report: must be produced, never absent
```

Dependencies are one-directional: `wrappers → templates → components`. No reverse references, no sideways dependencies between components.

---

## Differences from the previous version (2026-11-01)

| Item | Before | After | Reason |
|---|---|---|---|
| Default path | Five waves in one run (including repair) | **Four read-only waves + report** | round31: 83 pending / 1 completed, no final report |
| Wave 2 | One instance per `(slice, dimension)` | **2A sweep + 2B deep-dive** | 6 dimensions × 85 slices = 510 instances; arithmetic infeasible |
| Main-agent discretion | Zero discretion | **L0 forbidden / L1 logged / L2 free** | A blanket ban pushed discretion underground (round31: 9/40 deviations) |
| State | In-memory ledger | **`state.json` persisted + resume protocol** | Interruption is the norm; R22 double-instance overwrite incident |
| Report | Only on completion | **Emitted on every termination path** | round31 stalled at IN_PROGRESS with no report |
| Mutation testing | Optional but recommended | **Mandatory + must cover the call site** | R28: pure-function-only testing left 493 tests green after reverting to the wrong implementation |
| Citations | Not graded | **Four levels A/B/C/D + sourcing requirement** | All 25 URLs resolved, but some were used in the wrong place |

---

## Documentation map

| Document | Contents |
|---|---|
| [`framework/MANUAL.md`](framework/MANUAL.md) | **Complete manual** — the three upfront decisions, three ways to run it, step-by-step flow, per-wave checks, troubleshooting table, field reference, FAQ |
| [`framework/README.md`](framework/README.md) | Overview — why each design decision was made, and the intermediate proposals that were overturned |
| [`framework/PORTABILITY.md`](framework/PORTABILITY.md) | Porting across harnesses — three ways to implement loading, capability comparison, the three things you must change |
| `docs/reports/` (created inside the audited repo; not present here) | The full source-conversation transcript lives in the audited repo; it is not shipped with this framework |

> Note: the `framework/` documents are currently written in Chinese.

---

## FAQ

**The audit reported a pile of issues, but I think they're all false positives.**
Look at the `REVOKED` count from the critique wave first. If Skeptic already revoked most of them, the framework is working. Conversely, if Skeptic revoked nothing, be suspicious — its success metric is "how much it removed"; confirming everything is a failure for it, and may indicate a rubber stamp.

**Why can't the verification agent see the repair agent's test results?**
Deliberately. If verification can see "the fixer says the tests pass", it tends to paraphrase rather than verify for itself — and the tests the fixer chose may not target the defect at all. This isolation is one of the most important designs in the framework; don't break it for convenience.

**Can I skip the critique wave and go straight to repair?**
Don't. Critique is the only stage specifically designed to kill findings; skipping it lets false positives flow straight into the repair wave and waste the most expensive budget — repair is the only role with write permission and side effects.

**Arbiter says the evidence is insufficient, but I don't want to collect more.**
Then that finding just stays open. There is no "insufficient evidence, but let's fix it anyway" path in this framework. Either dispatch evidence collection, or mark `REVOKED`, or mark `HUMAN_DECISION_REQUIRED` and hand it to a human. The Arbiter is **not allowed** to "use its judgment" — that would put discretion back in the main agent.

**I want to change a threshold (e.g. concurrency from 8 to 16).**
You can, but change two places consistently: the table in `scale-mapping.md` section 3 and the guardrails in `protocol.md` section 6. Then sync `MANUAL.md`.

> **⚠️ Correction, 2026-11-02**: this section previously claimed the number 8 came from a measurement that "failure rates for uncoordinated parallel agents reach 72–100%". On review, those two figures are **HTTP 502 / connection-reset rates measured against a mock API server in one paper**, not audit failure rates; that paper **never recommended a concurrency window of 8**; and "admission control + backpressure brings it down to 0–18%" is a misreading of the original in the opposite direction. **The concurrency window of 8 is an engineering choice with no direct empirical support** — see `orchestrator/scale-mapping.md` section 3 for the correct reading.

---

## Honest disclosures

- **Origin**: the design came out of a DeepSeek conversation (transcript in `docs/reports/`). Nine of the files are verbatim from that conversation; eight were written afterwards in this repo. That share link now returns **429** and cannot be re-checked — meaning **most claims trace back to an LLM conversation, not to papers**. The correct way to describe this is "a set of design conventions", not "a synthesis of empirical research".
- **Limitations**: Markdown files have no loader. "Wave one loads such-and-such a file" is not automatically executed by any harness. For reliable loading you need scheduler code that concatenates them, or the harness's skill mechanism. Under a prompts-only approach, loading depends on the model's self-discipline.
- **It has been run once on a real project, and the result was "partially failed"**: round31 of `dsh-fcl-android-launcher` was the first complete real run of the five waves and exposed three structural problems (see [`docs/analysis/2026-11-01-structural-diagnosis.md`](docs/analysis/2026-11-01-structural-diagnosis.md)):
  1. **Coverage**: recon found 85 valid slices, only 40 were dispatched, 38 were `DEFERRED`;
  2. **Budget eaten by dead code**: 29 of the 40 slices were `fakefx` (a JavaFX port), and the critique wave later judged 162 files in them "unreachable from any production entry point";
  3. **It never finished**: only 1 of 83 pending repairs completed, `wave_status` stalled at `IN_PROGRESS`, and **no final report was produced**.
- **Citation audit found "links real, used in the wrong place"**: all 25 external URLs resolved with no 404s, but there were cases of treating "API outage rate" as "audit failure rate" and "this package exists" as "this conclusion is proven". Fixed, with a new citation-grading discipline (`components/evidence-policy.md` section 8); details in [`docs/analysis/2026-11-01-citation-audit.md`](docs/analysis/2026-11-01-citation-audit.md).
- **Current state**: this document's **citations and contract consistency** are fixed; the structural rework — **coverage, resume-from-interruption, two-pass design** — is still a proposal, see [`docs/analysis/2026-11-01-proposal.md`](docs/analysis/2026-11-01-proposal.md).

## License

[MIT](LICENSE)
