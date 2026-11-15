# Round 1 independent verification — F1 (ShopConfigLoader corrupt shop.yml)

## Scope and independence

- Finding: F1 (MEDIUM, error-handling) — corrupt or truncated `shop.yml` was silently degraded to a valid empty shop.
- Target: `src/main/java/com/hilltopvillage/shop/ShopConfigLoader.java`.
- I did not read any `round1-04-fix-*.md` artifact, any `.work/round1/redlogs/*` file, or `state.json` fix contracts. Conclusions below come from the production/test source and my own executions.

## Source inspection

- `ShopConfigLoader.load()` now uses `YamlFiles.load(file, null, plugin.getLogger())` and throws `IllegalStateException` when `loaded.usable()` is false. That closes the specific `YamlConfiguration.loadConfiguration(file)` swallow-parse-error path.
- `YamlFiles.load` treats a non-blank, parseable file with no validator as `OK`. No shop-specific schema/semantic validator is passed.
- `ShopManager.reload()` assigns `this.config = loader.load()` directly, with no catch; the command handler calls it without a catch, so a loader exception escapes to the Bukkit boundary.
- Existing regression tests: `ShopConfigCorruptFileTest` (2 tests) and `ShopConfigLoaderTest` (31 tests across nested classes).

## Executed verification

### Baseline / control (real loader path)

Command, run under the global Maven mutex and with a clean build:

`.\build.cmd -o clean '-Dtest=ShopConfigCorruptFileTest,ShopConfigLoaderTest' test`

Results (`.work/round1/verify-F1-final-clean-tests.log`):

- `Tests run: 2, Failures: 0, Errors: 0, Skipped: 0 ... ShopConfigCorruptFileTest`
- `Tests run: 33, Failures: 0, Errors: 0, Skipped: 0` total (`ShopConfigLoaderTest` 31 + corrupt test 2)
- `BUILD SUCCESS`, `EXIT_CODE=0`

This includes the valid-config control: the factory `shop.yml` parses to 16 items, EMERALD, GUI size 54; malformed per-item cases still behave as before.

### Mutation check (implementation only)

1. Backed up the exact production file to `.work/round1/verify-backups/F1-before-verify.java` (10,515 bytes).
2. Before SHA-256: `DF318AC65FF17853A7D9A2EC9C28F44E80CBCE3AB4CA3B1D278260E97977453A`.
3. Replaced the `YamlFiles.load(...)` + `usable()` guard with the old `YamlConfiguration yaml = YamlConfiguration.loadConfiguration(file);` behavior.
4. Ran `.\build.cmd -o '-Dtest=ShopConfigCorruptFileTest' test`; `EXIT_CODE=1`, `Tests run: 2, Failures: 2, Errors: 0, Skipped: 0`. Both failures were the expected behavioral failure: `AssertionFailedError: ... Expected java.lang.IllegalStateException to be thrown, but nothing was thrown.` — i.e. the old behavior returns an empty `ShopConfig` instead of failing. Log: `.work/round1/verify-F1-mutation-tests.log`.
5. Restored the exact bytes from the backup.
6. After SHA-256: `DF318AC65FF17853A7D9A2EC9C28F44E80CBCE3AB4CA3B1D278260E97977453A` — matches before exactly.
7. Important execution detail: `Copy-Item` restored the backup's older mtime, so an initial incremental Maven run reused the mutated class and falsely failed. I forced a clean rebuild; the clean run above is the authoritative green result. No production change remains.

### Declared residual 3 — syntactically valid truncation (observed, not merely unverified)

I added a temporary probe test (removed afterward; no probe source or class remains) that exercised the real `ShopConfigLoader.load()` / `ShopManager.reload()` paths:

- Loaded the factory template (16 items) as control.
- Truncated `shop.yml` at the end of the `  items:` header line, producing 1,130 bytes of syntactically valid YAML.
- `ShopConfigLoader.load()` returned normally with `items=0`, `gui=54` — no exception, accepted as a valid empty shop.
- In a second probe, a valid 1-item shop was loaded first; after the same truncation, `ShopManager.reload()` returned normally and replaced the snapshot: `previousItems=1 currentItems=0 sameSnapshot=false currency=DIAMOND`.

Probe output (`.work/round1/verify-F1-truncation-probe2.log`):

`PROBE_VALID_TRUNCATION_ACCEPTED items=0 gui=54 bytes=1130`

`PROBE_VALID_TRUNCATION_REPLACED_LIVE_SHOP previousItems=1 currentItems=0 sameSnapshot=false currency=DIAMOND`

`Tests run: 2, Failures: 2`, `EXIT_CODE=1`. The files were deleted and the final clean build contains no probe class.

This is a reproducible failure of the original acceptance criteria for the "truncated" input class: loading does not fail visibly, the result is accepted as a valid empty shop, and a reload replaces the live snapshot. The fixer's residual 3 was therefore a real gap, not just an unverified possibility.

## Verdict

FAIL. The parse-error trigger is fixed and the mutation check confirms the regression test is meaningful, but F1 explicitly covers truncated `shop.yml`; a parseable truncation still silently empties the live shop. The correct attribution is `FIX_INCOMPLETE` (the fix covers the parse-failure branch but not the valid-truncation branch), with the concrete trigger below.

The envelope's `artifact_path` is the filename relative to this artifact's directory because the gate resolves relative paths against the artifact file's own directory; the repository-relative path is `.work/round1/round1-05-verify-1.md`.

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "caf2963e-d767-437a-a108-f6cb52700317",
  "role": "verify",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "round1-05-verify-1.md",
  "payload": {
    "finding_id": "F1",
    "fix_agent_id": "2361960f-9b85-4cd6-93cd-1c55a192b29b",
    "verdict": "FAIL",
    "escalation_required": true,
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
        "action_taken": "Mapped the fixer's REGRESSION_UNVERIFIED to IMPACT_UNVERIFIED per the brief. Ran ShopConfigCorruptFileTest (2 tests) and ShopConfigLoaderTest (31 tests) under the Maven mutex after a clean build: Tests run 33, Failures 0, Errors 0, Skipped 0, EXIT_CODE 0. The broader repository suite was intentionally not run per the verification brief; the loader-only regression surface for F1 is covered.",
        "satisfied": true
      },
      {
        "flag": "IMPACT_UNVERIFIED",
        "action_taken": "Mapped the fixer's ENVIRONMENT_LIMITATION to IMPACT_UNVERIFIED per the brief. The co-run YamlFilesTest temp-directory cleanup AccessDeniedException did not reproduce in any focused run; all loader tests exited 0 with no cleanup error. This is a test-harness cleanup limitation, not loader behavior, and it does not affect the F1 evidence.",
        "satisfied": true
      },
      {
        "flag": "IMPACT_UNVERIFIED",
        "action_taken": "Observed as a real gap, not merely unverified. A temporary probe (removed afterward) truncated the factory shop.yml at the end of the '  items:' line (1,130 bytes), leaving syntactically valid YAML. ShopConfigLoader.load() returned a ShopConfig with 0 items and no exception; in a second probe ShopManager.reload() replaced a previous 1-item snapshot (sameSnapshot=false, currentItems=0) instead of throwing. This violates the truncated-input acceptance criterion and the no-live-replacement criterion. Probe source and class removed; final clean build left none.",
        "satisfied": false
      },
      {
        "flag": "OBSERVED_BUT_OUT_OF_SCOPE",
        "action_taken": "Read HilltopCommandHandler's shop reload branch (lines 577-581): it calls ShopManager.reload() without a catch, so IllegalStateException escapes to the Bukkit command boundary and is logged there; there is no localized chat reply. The chat-layer change is outside the target production file, and the failure remains visible at the Bukkit boundary.",
        "satisfied": true
      }
    ],
    "affected_issues_status": [],
    "new_issues_found": [],
    "failure_trigger": "Create shop.yml from src/main/resources/shop.yml truncated at the end of the '  items:' line (1,130 bytes, syntactically valid YAML with shop.currency/shop.npc/shop.gui retained), then call ShopConfigLoader.load() or ShopManager.reload(): load returns a ShopConfig with 0 items without throwing, and reload replaces the previous 1-item snapshot (sameSnapshot=false) instead of failing visibly.",
    "failure_category": "FIX_INCOMPLETE",
    "notes": "F1's parse-invalid branch is fixed: ShopConfigCorruptFileTest and ShopConfigLoaderTest pass 33/33 after a clean build (EXIT_CODE 0), and the old loadConfiguration behavior fails both corrupt tests with 'Expected IllegalStateException ... nothing was thrown' (EXIT_CODE 1). Mutation restore hash matches exactly: before/after DF318AC65FF17853A7D9A2EC9C28F44E80CBCE3AB4CA3B1D278260E97977453A. The valid-truncation branch remains: 1,130-byte parseable truncation loads 0 items and reload replaces the live snapshot, so the original 'truncated' acceptance criterion is not met. FAIL fields are non-null because the contract requires failure_trigger/failure_category for a FAIL verdict."
  },
  "error": null
}
```