# Round 1 — independent verification common brief

You are an independent verifier. You did not write the fix and must not rely on the fixer's account.

## Absolute independence rules

- Do **not** read any `round1-04-fix-*.md` artifact, any file under `.work/round1/redlogs/`, `state.json` fix contracts, or any fixer summary.
- Use only: the original finding text in your task prompt, the production/test source in the repository, and your own executions.
- Do not edit the repository's tests. Temporary production-code mutation is allowed only for the mutation check, and must be restored byte-for-byte.
- Do not run `git checkout`, `git restore`, `git reset`, `git stash`, or any command that would revert the round's fixes. The worktree is intentionally dirty.
- Do not change production behavior except during the temporary mutation; after restoring, verify the SHA-256 matches the before value.

## Repository and build

`<TARGET_REPO> = <TARGET_REPO>`

Before running Maven, acquire the global Maven mutex (verification instances share it):

```powershell
$m = [System.Threading.Mutex]::new($false, 'Global\HilltopRound1Maven')
if (-not $m.WaitOne(300000)) { throw 'Maven mutex timeout' }
try { Push-Location '<TARGET_REPO>'; .\build.cmd -o '-Dtest=<classes>' test *> '<log>'; $code=$LASTEXITCODE } finally { Pop-Location; $m.ReleaseMutex() }
```

Record the command, target classes, `Tests run:` line, and `EXIT_CODE`. Do not run the full repository suite; the main agent already ran it.

## Mutation check

1. Copy the exact production file to `.work/round1/verify-backups/<F>-before-verify.java` and record its SHA-256.
2. Apply the smallest reversion that restores the old behavior described in the finding.
3. Run the targeted test; it must fail for the expected behavioral reason (record the failure).
4. Restore the exact bytes from the backup.
5. Recompute SHA-256; it must equal the before value. Confirm the file compiles/tests green again.
6. Do not leave a mutation, backup test, or temporary test in the repository.

If mutation is genuinely impossible, use `mutation_check: "skipped"` only for `harness_unsupported`/`unsafe_revert`, explain in `notes`, and do not claim a mutation was performed.

## Artifact

Write `<TARGET_REPO>\.work\round1\round1-05-verify-<N>.md`.

The file must be UTF-8 without BOM and end with exactly one closed ```json envelope:

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "<your own DSH session UUID, no session- prefix>",
  "role": "verify",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": ".work/round1/round1-05-verify-<N>.md",
  "payload": {
    "finding_id": "<F1..F7>",
    "fix_agent_id": "<exact UUID from your task prompt>",
    "verdict": "PASS",
    "escalation_required": false,
    "evidence": {
      "original_trigger_retested": true,
      "regression_scan_performed": true,
      "user_journey_aligned": true,
      "mutation_check": "performed",
      "mutation_scope": "implementation_only"
    },
    "residual_risk_disposition": [
      {
        "flag": "IMPACT_UNVERIFIED",
        "action_taken": "What you actually executed and observed, including test class/result and any mapping from the fixer's non-contract label.",
        "satisfied": true
      }
    ],
    "affected_issues_status": [],
    "new_issues_found": [],
    "failure_trigger": null,
    "failure_category": null,
    "notes": "Concise evidence, including mutation result and restoration hash."
  },
  "error": null
}
```

`payload.evidence.mutation_scope` must be `implementation_only` or `implementation_and_callsite` when performed. For a user-visible return/callsite change, use `implementation_and_callsite` if you reverted both the implementation and the callsite; otherwise explain in `notes`.

## Residual flags

The fixer used some non-contract labels. The verifier must emit contract-enum flags, one disposition per distinct residual risk string, and explain any label mapping in `action_taken`/`notes`:

- `REGRESSION_UNVERIFIED` or `ENVIRONMENT_LIMITATION` -> `IMPACT_UNVERIFIED`
- `RED_BASELINE` -> `BASELINE_UNVERIFIED`
- an unflagged residual item -> choose the closest contract flag (`IMPACT_UNVERIFIED` or `OBSERVED_BUT_OUT_OF_SCOPE`) and say why.

`affected_issues_status` must contain exactly one entry per finding ID in your task's `affected_issues`, with status `STILL_EXISTS | RESOLVED_BY_THIS_FIX | UNCHANGED | NOT_FOUND`. In this run, affected issues that were fixed by a separate serial finding are `UNCHANGED` **by this fix**, with a note naming the separate verification; do not claim this fix resolved them.

## Gate

Run:

```powershell
node 'D:\Projects\AI prompt\many-agents_multi-prompt-files_token-heavy\multi-agent-audit-framework\tools\check-payload.mjs' '<artifact>' --role verify --repo '<TARGET_REPO>' --artifact-dir '<TARGET_REPO>\.work\round1'
```

It must exit 0 (`✅ 契约合规`). If it reports a real envelope/schema problem, fix the artifact and rerun; report the exact output. Do not bypass the gate.

Report back: artifact path, check-payload exit, targeted test count/result, mutation before/after hashes, and any residual uncertainty.
