[简体中文](README.md) | English

<div align="center">

# Multi-Agent Extreme Audit Prompt Framework

**Have an AI audit a real codebase, not a toy project**
The main Agent only orchestrates, sub-Agents do the work — using context isolation to fight judgment drift in long-chain audits

![Tests](https://github.com/sqkl520/multi-agent-audit-framework/actions/workflows/checks.yml/badge.svg)
![Dependencies](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen?style=flat-square)
![Node](https://img.shields.io/badge/node-%E2%89%A522-blue?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)

**Zero dependencies** · **Read-only throughout** · **A rule written but not enforced is a bug**

[Quick start](#-quick-start) ·
[Capabilities](CAPABILITIES.md) ·
[Issue tracker](https://github.com/sqkl520/multi-agent-audit-framework/issues)

</div>

> ⚠️ **This is a hobby project by a high-school student, built with AI assistance (vibe coding). It is in early development.**
> Questions and suggestions are welcome via [Issues](https://github.com/sqkl520/multi-agent-audit-framework/issues);
> if you like this project, give it a Star ⭐
>
> The author's original wording (Chinese), kept verbatim:
>
> ⚠️ **这是一个高一牲用 AI 辅助开发（vibe coding）做的 App，处于早期开发中**
> 有任何问题、建议都欢迎提交 [Issues](https://github.com/sqkl520/multi-agent-audit-framework/issues)；
> 如果喜欢这个项目就 Star 一下喵 ⭐

---

## ✨ What it is

A code-audit prompt framework built on the principle that the main Agent only orchestrates and sub-Agents do the work.

**The core claim is a counter-intuitive one: make the main Agent do nothing.** It doesn't read code, doesn't read reports, doesn't make judgments; it only dispatches agents, looks at structured returns, and schedules according to hard-coded rules. Anything that would require "taking a look" in order to decide must be turned into a sub-agent task.

The payoff isn't division of labor, it's **context isolation** — the main Agent's context only ever holds structured task descriptions and result summaries, and is never polluted by code, stack traces, or full report text.

The default path is four read-only waves:

```
Recon → Broad sweep → Deep dive → Critique → Report
```

Fixing is a **separate, optional path**, not enabled by default.

## 🚀 Quick start

Zero dependencies; all you need is **Node.js ≥ 22** (some harness log validators use `zlib.zstdDecompressSync`, available from 22.15).

```bash
git clone https://github.com/sqkl520/multi-agent-audit-framework.git
cd multi-agent-audit-framework

# Run all mechanical checks (about 40 self-test suites)
node tools/check-all.mjs
```

If you see `✅ 全部通过`, the framework itself is healthy. Then follow [`START-HERE.md`](START-HERE.md) to start auditing your first repository.

### Settle three prerequisites first

| Question | Explanation |
|---|---|
| **Who loads the templates?** | Markdown has no loader. ① Dispatcher code concatenates them by force (most reliable) ② the harness's skill mechanism (medium) ③ stuff everything into the system prompt (fast, but breaks the isolation principle) |
| **What's the concurrency cap?** | The framework assumes 8 by default. When the harness only supports 2–3, have the recon agent fill in the truth in `harness_concurrency_cap`; if it can't be read, take the conservative value `4` |
| **How much total budget?** | Default `total_agent_count = 60`: discovery wave 40, downstream reserved 20. More than 40 slices can't finish in one round; the excess is marked `DEFERRED` |

### Three ways to run it

**Option 1 · Claude Code** —— copy `framework/wrappers/*.md` into `.claude/agents/`

**Option 2 · Agent SDK or your own dispatcher** (most reliable)

```python
BASE = "framework/"

def spawn_agent(role, template, extra):
    system = "\n\n".join([
        read(BASE + "components/evidence-policy.md"),
        read(BASE + "components/output-contract.md"),
        read(BASE + template),
    ]) + "\n\n" + extra
    return client.agents.create(system=system, tools=TOOLS[role])
```

The concatenation **order** must be `evidence-policy` → `output-contract` → template.

**Option 3 · Pure prompt** (not recommended) —— "loading" just means "you handed it these words"; there is no enforcement.

## ❓ FAQ

| Question | Solution |
|---|---|
| The audit reported a pile of issues, but I think they're all false positives | Look first at the `REVOKED` count in the critique wave. If the Skeptic has revoked most of them, the framework is working as intended. Conversely, if not a single one was revoked, that's when you should be suspicious — its success metric is "how much did it remove" |
| Why can't the acceptance Agent see the fixing Agent's test results? | Deliberate. On seeing "the fixer says the tests pass", it tends to restate rather than verify for itself — and the tests the fixer picked may not even be aimed at the defect |
| Can I skip the critique wave and go straight to fixing? | Don't. Critique is the only stage dedicated to killing findings; skipping it sends false positives straight into the fixing wave, wasting the most expensive budget |
| The Arbiter says the evidence is insufficient, but I don't want to collect more | That finding just stays hanging. There is no "insufficient evidence, fix it anyway" path in this framework |
| I want to change the threshold (concurrency 8 → 16) | Two places must change: the table in section 3 of `scale-mapping.md` plus the guardrail in section 6 of `protocol.md`, then sync `MANUAL.md` |
| Can it really guarantee the fixes are correct? | **No.** See "Capabilities" below |
| Where do the audit's output artifacts go? | **Outside the repo.** The framework is the repo's content; one audit run's output is not. Write it under `.work/`, `logs/` in the workspace layer, or any directory outside the repo — `.run-*/`, `.audit-*/`, `.probe-*/` are already blocked in `.gitignore` |

## 🔒 Capabilities (read this first)

**A mechanical gate verifies process compliance, not code correctness.**

Measured data from one real run:

| | Value |
|---|---|
| Wall-clock time | about 90 minutes |
| Sub-agents | 9 (10 real subagent calls) |
| Output | 20 files / +804 −78 / 15 new tests |
| Mechanical gate | 26 validation suites, 0 false blocks |
| **Then an independent red-team review of those 7 fixes** | **5 had defects, 2 of them serious** |

That last row is the most important self-description this framework has.

The full line-by-line list of "what it can stop / what it can't" is in [`CAPABILITIES.md`](CAPABILITIES.md). **That document will help you decide whether to use this more than this README does.**

The most important item among them: **when it misses a check, nothing will remind you.**
Of 1118 rule sentences measured, 243 (21.7%) have a machine outlet; only 128 (11.4%) are covered by an executable rule in `tools/*.mjs`.

## 🔧 How it works

```
Main Agent (orchestrates only, does not read code)
   ├─ Wave 1 · Recon        → slices + reachability + concurrency cap
   ├─ Wave 2A · Broad sweep → one instance per slice, produces leads only, no severity judgments
   ├─ Wave 2B · Deep dive   → only the dimensions the leads point to, full Gate 0 evidence chain
   ├─ Wave 3 · Critique     → Skeptic kills findings / Devil's Advocate hunts blind spots / Arbiter rules
   └─ Wave 4 · Report       → five fixed sections, every conclusion carries an artifact_ref
```

### Tech stack

| Layer | What it uses |
|---|---|
| Framework itself | Markdown prompts + JSON contracts (`framework/`) |
| Validators | Zero-dependency Node.js (`tools/*.mjs`, 40 self-test suites) |
| State machine | `state.json` persisted to disk, resumes after interruption |
| Evidence chain | Gate 0: every finding must verbatim echo the `file:line` read in this round |

<details>
<summary><b>Key design: why broad sweep and deep dive must split the budget</b></summary>

If you write it as `planned_sweep_agents = min(effective_slices, discovery_budget)`,
then when `effective_slices ≥ discovery_budget` (measured round31: 85 ≥ 40),
the broad sweep **eats the entire budget**, leaving 0 for the deep dive, and the two-pass design degenerates into "sweep only, zero deep dive" —
**worse than the original design**.

The correct form gives 0.4 of `discovery_budget` to the broad sweep and leaves the rest to the deep dive:

```
if effective_slices < discovery_budget:
    planned_sweep_agents = effective_slices
    deep_dive_budget     = discovery_budget - effective_slices
else:
    planned_sweep_agents = min(effective_slices, ceil(discovery_budget × 0.4))
    deep_dive_budget     = discovery_budget - planned_sweep_agents
```

See section 3 of [`orchestrator/scale-mapping.md`](framework/orchestrator/scale-mapping.md).

</details>

<details>
<summary><b>Key design: why fixing is a separate path rather than the default flow</b></summary>

2026-11-01 structural revision. Reason: in the round31 real run, **of 83 pending fixes only 1 was completed**,
and the whole round stopped at `IN_PROGRESS` with **no final report**.

Fixing is the only role with write permission and the strictest rules; putting it on the default path means letting the most fragile link decide whether the whole round can end.

See [`docs/analysis/2026-11-01-proposal.md`](docs/analysis/2026-11-01-proposal.md).

</details>

## 📌 Current status

> Last updated: 2026-11-18

| Module | Status |
|---|---|
| Four-wave read-only path + report | ✅ Done |
| Fix / acceptance separate path | ✅ Done |
| Mechanical validation suites (40) | ✅ All green · CI passing on three platforms |
| Three-layer contract loop (template/contract/validator) | ⚠️ Partial — 21.7% outlet rate (11.4% strict) |
| Rule → validator reconciliation tool | ✅ Shipped (a dashboard, not a gate) |
| Chinese/English bilingual front | ✅ README + community files |
| Mechanical detection of Mode B (judgment surface covers only self-made samples) | ⬜ Not achievable in practice, not implemented |
| Mechanical detection of Mode C (comments promise more than the code delivers) | ⬜ Permanently lit in practice, abandoned |

**Quality baseline**: `node tools/check-all.mjs` all green · CI passing on three jobs: ubuntu 22/24 + windows 22

## 📦 Verification

```bash
node tools/check-all.mjs          # all mechanical checks (about 40 suites)
node tools/check-rule-ledger.mjs  # rule sentence → machine outlet reconciliation (dashboard)
node tools/check-payload.mjs <产物> --role <角色>   # contract admission for a single artifact
```

CI config is in [`.github/workflows/checks.yml`](.github/workflows/checks.yml);
zero `npm install`, and it runs once each on ubuntu and windows (git invocation behaves differently on the two platforms).

## 🤝 Development and contributing

This is a small project a high-school student built in their spare time. Plenty of rules are written, but **only some of them are actually guarded by machines** —
if you find a rule that claims to exist yet never fires, that is the most valuable kind of Issue.

- **Contributing guide**: [`CONTRIBUTING.md`](CONTRIBUTING.md) —— how to report problems, how to send a PR, testing requirements
- **Security**: [`SECURITY.md`](SECURITY.md) —— **do not open a public issue**; use a private advisory
- **Code of conduct**: [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)

When reporting a bug, please include: the reproduction command, expected vs actual, and the `file:line` of that sentence in the contract.

## 📚 Documentation

| Document | Contents |
|---|---|
| [`CAPABILITIES.md`](CAPABILITIES.md) | **Capabilities** — what it can stop, what it can't, and why nothing warns you when a check is missed |
| [`START-HERE.md`](START-HERE.md) | Audit entry point: audit a repository from zero |
| [`START-FIX.md`](START-FIX.md) | Fix entry point: consume confirmed findings |
| [`framework/MANUAL.md`](framework/MANUAL.md) | The complete manual |
| [`framework/README.md`](framework/README.md) | Master document: why each design decision was made this way |
| [`framework/PORTABILITY.md`](framework/PORTABILITY.md) | Porting across harnesses |
| [`experiments/review-7/`](experiments/review-7/) | The full post-mortem of that "all gates green yet 5 defects" run |
| [`docs/reports/`](docs/reports/) | Framework self-audit reports and the native dsh run record |

## Honest notes

- **Origin**: the design came out of a DeepSeek conversation (the transcript is in the audited repository). That share link now returns **429** and can't be re-checked — **the real upstream of most claims is an LLM conversation, not a paper**. The correct positioning is "a set of design conventions", not "a synthesis of empirical research".
- **Limitation**: Markdown has no loader. So-called "wave one loads this file" is not automatically executed by any harness. Under the pure-prompt approach, loading depends on the model's self-discipline.
- **One real project was run, and the result was "partial failure"**: of 85 slices only 40 were dispatched, the budget was eaten by dead code, and of 83 pending fixes only 1 was completed with no final report.
- **Citations were verified one by one, revealing "real links, wrong usage"**: none of the 25 external URLs 404'd, but there is the problem of treating "API downtime rate" as "audit failure rate". Fixed, and a citation-grading discipline was added.

## License

[MIT](LICENSE)
