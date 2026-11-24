[简体中文](docs/i18n/CONTRIBUTING.zh-CN.md) | English

# Contributing

Thanks for looking. This repo is a **prompt/contract framework**, not a library —
most of the "code" here is Markdown that instructs an LLM, plus a few Node.js
validators that mechanically check artifacts against those instructions.

That shapes what useful contributions look like.

## What's most useful

1. **A measured counterexample.** The framework makes claims backed by numbers
   (recall rates, false-positive rates, gate coverage). If you find a case where a
   claimed gate does not fire, or fires when it shouldn't, that is the single most
   valuable thing you can report. Include the input and the observed output.
2. **A portability fix.** The framework currently assumes a harness that supports
   sub-agents and a filesystem. See `framework/PORTABILITY.md`.
3. **A doc fix where the doc is wrong.** Several failures in this repo's history were
   "the contract said X, the validator did not check X". If you spot one, that is a bug.

## What's less useful

- Generic prompt-engineering advice without a reproduction.
- "This would be cleaner if rewritten in <framework>" — the constraint here is
  that the artifacts must be readable by an LLM *and* checkable by a script.

## Before you open a PR

Run the full mechanical check suite. It must be green:

```bash
node tools/check-all.mjs
```

This runs 53 self-test suites covering every validator. If a suite fails, the PR
is not ready — the suites are the only thing that distinguishes "the rule exists"
from "the rule is enforced".

When you add or change a rule in `framework/`:

```bash
# 1. The three-layer rule: template + contract + validator must all change together.
#    Changing only the Markdown means the rule has no enforcement.
node tools/check-rule-ledger.mjs --gate --since HEAD
```

That command fails if you added a normative sentence ("must / must not / never")
that no validator reads and that is not explicitly marked `DISCRETIONARY` with a reason.

## Commit messages

`type(scope): what changed and why`. Types used in this repo: `feat`, `fix`, `docs`,
`test`, `perf`, `cleanup`, `correct`, `diag`, `verdict`.

Write the *why*. A commit that says "fix bug" is not reviewable six months later.

## Environment

- Node.js **≥ 22** (a few harness-log validators use `zlib.zstdDecompressSync`, added in 22.15).
  On older Node those validators report "this Node cannot read zstd" instead of crashing,
  but the supported floor is 22.
- Git, for the checks that read `git status` / `git diff` against a target repo.
- No package install step — this repo has **zero runtime dependencies** on purpose.
  Please do not add one for a small feature; the validators are deliberately
  dependency-free so they can run anywhere.

### Windows: run the suite inside WSL

The suites spawn a lot of short-lived `node` and `git` processes. On a Windows
host with real-time antivirus scanning, each spawn costs 2–3 seconds (measured:
`node -e 0` 3.4 s, `git --version` 2.0 s), and `check-all` goes from **17 s on CI
to over 50 minutes**. Inside WSL, on the same files, it takes **4 minutes**.

```bash
wsl -d Debian -- bash -lc 'cd /mnt/d/path/to/multi-agent-audit-framework && node tools/check-all.mjs'
```

Install Node ≥ 22 and git in the distro first (`apt-get install git`, Node from
[nodejs.org/dist](https://nodejs.org/dist/) — Debian's `nodejs` package is 20,
below the floor). If a suite does finish on Windows, it detects the slow env and
prints `⊘ … 跳过` lines; those are **skips, not passes** — treat CI as the result.

## Reporting a security issue

**Do not open a public issue.** See [SECURITY.md](SECURITY.md).

## Code of conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
