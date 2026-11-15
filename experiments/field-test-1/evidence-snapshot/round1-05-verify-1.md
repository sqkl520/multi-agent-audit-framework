# Round 1 independent verification — F1 (pass 2)

- **Finding:** F1 (MEDIUM, error-handling): corrupt or truncated `shop.yml` was silently degraded to a valid empty shop and could replace the live `ShopConfig`.
- **Target:** `src/main/java/com/hilltopvillage/shop/ShopConfigLoader.java`
- **Fix agent id:** `2361960f-9b85-4cd6-93cd-1c55a192b29b`
- **Verdict:** PASS

## Source and test review

The loader now separates two failure classes:

1. `YamlFiles.load(...)` reads the file explicitly and returns `usable() == false` on a real parse failure; `load()` throws `IllegalStateException` before constructing a `ShopConfig`.
2. When `YamlConfiguration` has no `shop.items` section, the loader re-reads the raw YAML and rejects a present-but-null/non-mapping `items` value. This preserves the two controls: `items: {}` is a `Map` and remains valid, while an omitted key still follows the existing empty-item behavior.

`ShopManager.reload()` assigns `this.config = loader.load()` in one statement, so a thrown loader exception occurs before assignment and leaves the previous `ShopConfig` instance in place. `HilltopCommandHandler` calls `reload()` without a catch at the shop command, so the failure is visible at the Bukkit boundary.

## Focused test execution

Command (under `Global\HilltopRound1Maven`):

```text
.\build.cmd -o clean '-Dtest=ShopConfigCorruptFileTest,ShopConfigLoaderTest' test
```

- `EXIT_CODE=0`
- `Tests run: 35, Failures: 0, Errors: 0, Skipped: 0`
- `ShopConfigCorruptFileTest`: **4/4 passed**
- `ShopConfigLoaderTest`: **31/31 passed** (reported across outer/nested surefire files; total 31)
- Build result: `BUILD SUCCESS`

Log: `.work/round1/verify-logs/round1-05-verify-1-F1-focused.log`

## Exact factory-truncation probe

A temporary probe outside the project test tree exercised the real `ShopConfigLoader` and `ShopManager` against the actual `src/main/resources/shop.yml` cut immediately after the exact `  items:` header (12 checks passed, exit 0):

- Real loader threw `IllegalStateException`: `shop.yml: 'shop.items' is present but is not a mapping (value: null); the file appears truncated. Refusing to replace the live shop configuration.`
- `ShopManager.reload()` threw the same failure.
- The previous `ShopConfig` instance was preserved by identity and its one original item survived.
- `items: {}` loaded as a valid empty shop.
- Omitted `items` loaded as a valid empty shop.

One-off parseable truncations outside the accepted `items:`-null trigger were also probed separately:

- File ending at `shop:` itself: loaded normally with 0 items.
- File ending after `items: {}` and a later `currency:` header: loaded normally with 0 items.

These are recorded as residual risk 2, not conflated with the accepted `shop.items:`-null trigger.

## Mutation check

- Backup: `.work/round1/verify-backups/F1b-before-verify.java`
- SHA-256 before: `E08E6F3DB67FC8F76BC4D32FB5BE0599DE7BCAA9E7BFDF954510F5159EA07915`
- Mutation: changed the raw-`shop.items` guard condition to `if (false && ...)`, leaving invalid-YAML handling intact.
- Mutated SHA-256: `66E7DBC63102F4F3BBED8642DF72282BE23064398725D0ED8CE8D83600716C6B`
- Mutation test command: `.\build.cmd -o '-Dtest=ShopConfigCorruptFileTest' test`
- Mutation result: `EXIT_CODE=1`, `Tests run: 4, Failures: 1`; exactly `truncatedItemsHeaderFailsAndPreservesPreviousConfig` failed at line 130 with `Expected java.lang.IllegalStateException to be thrown, but nothing was thrown.`
- Restoration: copied the exact backup bytes back, then re-ran the clean focused suite.
- SHA-256 after: `E08E6F3DB67FC8F76BC4D32FB5BE0599DE7BCAA9E7BFDF954510F5159EA07915`
- Before/after hashes equal; restored suite: `EXIT_CODE=0`, `Tests run: 35, Failures: 0, Errors: 0, Skipped: 0`.
- Temporary probe source/classes were removed; the production loader is byte-for-byte restored. No `shop.yml.corrupt` files were left in the repository.

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "e54d3289-e936-4fc8-a9e0-8d1fbdd21e9b",
  "role": "verify",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "round1-05-verify-1.md",
  "payload": {
    "finding_id": "F1",
    "fix_agent_id": "2361960f-9b85-4cd6-93cd-1c55a192b29b",
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
        "action_taken": "Normalized the fixer's REGRESSION_UNVERIFIED label to IMPACT_UNVERIFIED. Per the brief I did not rerun the full repository suite. I independently ran the clean focused command '.\\build.cmd -o clean -Dtest=ShopConfigCorruptFileTest,ShopConfigLoaderTest test' under the global Maven mutex: exit 0, 35/35 tests green (4 corrupt-file + 31 loader). The broader shop/Mockito suite remains environment-blocked by Byte Buddy self-attach; the focused loader regression required for F1 is green.",
        "satisfied": true
      },
      {
        "flag": "IMPACT_UNVERIFIED",
        "action_taken": "Independently probed distinct parseable truncations with the real loader. A file ending at 'shop:' itself, and a file ending after 'items: {}' before a later 'currency:' header, both still load normally as an empty ShopConfig. This confirms the fixer's disclosed limitation but is a separate shape from the accepted present-but-null 'shop.items:' trigger; it is recorded honestly and is not treated as the same trigger or as a new finding.",
        "satisfied": true
      },
      {
        "flag": "OBSERVED_BUT_OUT_OF_SCOPE",
        "action_taken": "Confirmed the corruption failure remains visible: ShopConfigCorruptFileTest observes IllegalStateException escaping ShopManager.reload(), and HilltopCommandHandler.java:577-580 calls reload() without a catch, so the exception reaches the Bukkit command boundary and is logged. No localized chat failure reply is sent; that callsite/chat change is outside the authorized ShopConfigLoader target.",
        "satisfied": true
      }
    ],
    "affected_issues_status": [],
    "new_issues_found": [],
    "failure_trigger": null,
    "failure_category": null,
    "notes": "PASS. Exact factory shop.yml truncated at the '  items:' header was probed with a temporary out-of-tree harness (12/12 checks): real loader and ShopManager.reload both threw a descriptive IllegalStateException, and the previous ShopConfig instance plus its item survived. Explicit 'items: {}' and omitted-items controls both remained valid empty shops. Clean focused suite: 4 corrupt-file + 31 loader = 35/35 passed, EXIT_CODE=0. Mutation disabled only the raw shop.items guard: before SHA-256 E08E6F3DB67FC8F76BC4D32FB5BE0599DE7BCAA9E7BFDF954510F5159EA07915, mutated 66E7DBC63102F4F3BBED8642DF72282BE23064398725D0ED8CE8D83600716C6B, expected truncation test failed 1/4 with no exception thrown, restored SHA-256 E08E6F3DB67FC8F76BC4D32FB5BE0599DE7BCAA9E7BFDF954510F5159EA07915 (byte-identical), restored suite green. Temporary probe source/classes removed; no production mutation remains."
  },
  "error": null
}
```
