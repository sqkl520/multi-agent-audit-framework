# F2 — `MATERIAL` must reject a missing `icon.material` instead of shipping `BARRIER`

- **Finding**: F2 (MEDIUM, data-validation)
- **Target**: `src/main/java/com/hilltopvillage/shop/ShopConfigLoader.java`
- **New test**: `src/test/java/com/hilltopvillage/shop/ShopConfigMaterialValidationTest.java`
- **Corrected existing test**: `src/test/java/com/hilltopvillage/shop/ShopConfigLoaderTest.java`
- **Backup (post-F1 baseline)**: `.work/round1/backups/F2-before.java`
- **Disposition**: FIXED

## Defect

`parseItem` initializes `icon = Material.BARRIER` and only rejected a missing `icon.material` when `"EQUIPMENT".equals(type)`. For `type: MATERIAL`, an omitted `icon.material` therefore left the icon at `BARRIER` with no warning. `ShopGUI` and the delivery path construct an `ItemStack` from that icon, so the shop showed/shipped a barrier block. This was a silent misconfiguration, not a deliberate default.

The pre-fix code (post-F1 baseline, lines 130-136) is:

```java
// EQUIPMENT 的发货材质 = icon.material（GUI 图标同）：缺省 BARRIER 会发出屏障方块，
// 属明确误配，直接 skip 而不是静默发错东西
if ("EQUIPMENT".equals(type) && !iconConfigured) {
    plugin.getLogger().warning("shop.yml: EQUIPMENT item '" + id
            + "' is missing icon.material (delivery material), skipped");
    return null;
}
```

## Reproduction and red test

The new test writes one `shop.yml` containing two `MATERIAL` entries:

- `no_icon`: `slot: 0`, `price: 1`, `type: MATERIAL`, no `icon` block.
- `with_icon`: `slot: 1`, `price: 1`, `type: MATERIAL`, `icon.material: DIAMOND_SWORD`.

It calls the real `ShopConfigLoader.load()` and uses `assertAll` so both the disproof and the positive control are evaluated in the same run:

1. `no_icon` must not appear in `ShopConfig.getItems()`.
2. `with_icon` must still load, remain `type: MATERIAL`, and have `getIcon() == Material.DIAMOND_SWORD`.

Red command (unmodified loader, new test only):

```text
.\build.cmd -o '-Dtest=ShopConfigMaterialValidationTest' test
```

Red result:

```text
Tests run: 1, Failures: 1, Errors: 0, Skipped: 0
F2 MATERIAL icon validation (1 failure)
  AssertionFailedError: A MATERIAL item without icon.material must be skipped like EQUIPMENT,
  but it loaded with icon BARRIER (items: [with_icon, no_icon])
BUILD FAILURE
EXIT_CODE=1
```

Full log: `.work/round1/redlogs/F2-red.log`

The failure is exclusively the missing-icon assertion. The same `assertAll` run shows the positive control passed: `with_icon` was present and its icon matched `DIAMOND_SWORD` (the assertion group reports exactly 1 failure, not 2). No compile, fixture, or environment error occurred.

## Fix

The missing-icon guard now covers both `EQUIPMENT` and `MATERIAL`, and the warning names the actual type:

```java
// EQUIPMENT 的发货材质 = icon.material（GUI 图标同），MATERIAL 的 GUI/发货图标同：
// 缺省 BARRIER 会发出/显示屏障方块，属明确误配，直接 skip 而不是静默发错东西
if (("EQUIPMENT".equals(type) || "MATERIAL".equals(type)) && !iconConfigured) {
    plugin.getLogger().warning("shop.yml: " + type + " item '" + id
            + "' is missing icon.material, skipped");
    return null;
}
```

A `MATERIAL` entry with a valid item `icon.material` still loads with that icon. The existing invalid-icon-material handling is untouched: `null` or non-item materials are still skipped by the earlier block. F1's `YamlFiles` import and corrupt-file `IllegalStateException` are untouched.

Because the old `ShopConfigLoaderTest.missingIconFallsBackToBarrier` explicitly asserted the defect (MATERIAL without icon loads with `BARRIER`), the parent authorized correcting that stale expectation. It is now `missingMaterialIconIsSkipped` and asserts the item is skipped with a warning containing `MATERIAL item 'probe'` and `is missing icon.material`. The reject behavior and the new F2 test were not weakened.

Diff against the post-F1 backup is exactly the F2 condition/message block (verified with `git diff --no-index .work/round1/backups/F2-before.java src/main/java/com/hilltopvillage/shop/ShopConfigLoader.java`); F1's `YamlFiles` changes do not appear in that delta.

## Green evidence

Green command (new F2 test plus the corrected loader suite):

```text
.\build.cmd -o '-Dtest=ShopConfigMaterialValidationTest,ShopConfigLoaderTest' test
```

Green result:

```text
Tests run: 32, Failures: 0, Errors: 0, Skipped: 0
BUILD SUCCESS
EXIT_CODE=0
```

Full log: `.work/round1/redlogs/F2-green.log`

An additional combined regression also passed F1's corrupt-file tests alongside both F2 classes:

```text
.\build.cmd -o '-Dtest=ShopConfigCorruptFileTest,ShopConfigMaterialValidationTest,ShopConfigLoaderTest' test
Tests run: 34, Failures: 0, Errors: 0, Skipped: 0
BUILD SUCCESS
EXIT_CODE=0
```

Full log: `.work/round1/redlogs/F2-regression.log`

## Impact radius

- Only the authorized loader plus the new test and the parent-authorized correction of the one stale assertion in `ShopConfigLoaderTest` were changed.
- F1 behavior is preserved: the combined run includes `ShopConfigCorruptFileTest` (2/2 pass), and the backup delta contains only F2's block.
- `EQUIPMENT` rejection behavior is unchanged; only its warning text lost the `(delivery material)` parenthetical. Existing assertions match the retained substring `is missing icon.material`.
- Invalid/unknown `icon.material` handling (`null` or non-item → skip) is unchanged.
- No new dependency, no public API change, no unrelated refactor. Source delta is 5 changed lines including comments.

## Residual risks

- `IMPACT_UNVERIFIED`: F3 and F4 both edit the same `parseItem` method after the icon guard. Any F3/F4 fixture that used a `MATERIAL` entry without `icon.material` will now be skipped before slot/price validation; those fixes are not yet applied, so their interaction is not execution-verified.
- `IMPACT_UNVERIFIED`: existing servers whose `shop.yml` relied on the old `BARRIER` fallback will now see those `MATERIAL` entries skipped after upgrade. This is the intended rejection, but no config migration or auto-repair was added.
- `IMPACT_UNVERIFIED`: only the three loader-related test classes were run (34 tests). The full repository suite was not run; the broader shop/Mockito environment has known Byte Buddy self-attach failures documented by F1, so the final full `build.cmd -o test` remains the authoritative regression gate.

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "36409b77-2e0e-46aa-bde8-9aace6bd90c5",
  "role": "fix",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:\\Server\\<TARGET_PARENT>\\Server plugin\\Hilltop Village\\Hilltop Village Plugin\\.work\\round1\\round1-04-fix-2.md",
  "payload": {
    "finding_id": "F2",
    "disposition": "FIXED",
    "test_path": "src/test/java/com/hilltopvillage/shop/ShopConfigMaterialValidationTest.java",
    "red_log_path": ".work/round1/redlogs/F2-red.log",
    "files_touched": [
      {
        "path": "src/main/java/com/hilltopvillage/shop/ShopConfigLoader.java",
        "change_summary": "Extended the missing-icon guard from EQUIPMENT-only to EQUIPMENT and MATERIAL, and made the warning name the actual type; MATERIAL entries without icon.material are now skipped instead of silently keeping Material.BARRIER."
      },
      {
        "path": "src/test/java/com/hilltopvillage/shop/ShopConfigMaterialValidationTest.java",
        "change_summary": "Added the F2 regression test: a MATERIAL item without icon.material must be absent from ShopConfig.getItems(), while a MATERIAL item with icon.material: DIAMOND_SWORD still loads with that icon."
      },
      {
        "path": "src/test/java/com/hilltopvillage/shop/ShopConfigLoaderTest.java",
        "change_summary": "Corrected the stale missingIconFallsBackToBarrier expectation (parent-authorized) to missingMaterialIconIsSkipped: MATERIAL without icon.material is skipped and logs 'MATERIAL item ... is missing icon.material' instead of loading with BARRIER."
      }
    ],
    "verification_commands": [
      {
        "command": ".\\build.cmd -o '-Dtest=ShopConfigMaterialValidationTest' test",
        "result": "failed",
        "output_snippet": "Tests run: 1, Failures: 1, Errors: 0, Skipped: 0; A MATERIAL item without icon.material must be skipped like EQUIPMENT, but it loaded with icon BARRIER (items: [with_icon, no_icon]); BUILD FAILURE; EXIT_CODE=1"
      },
      {
        "command": ".\\build.cmd -o '-Dtest=ShopConfigMaterialValidationTest,ShopConfigLoaderTest' test",
        "result": "passed",
        "output_snippet": "Tests run: 32, Failures: 0, Errors: 0, Skipped: 0; BUILD SUCCESS; EXIT_CODE=0"
      },
      {
        "command": ".\\build.cmd -o '-Dtest=ShopConfigCorruptFileTest,ShopConfigMaterialValidationTest,ShopConfigLoaderTest' test",
        "result": "passed",
        "output_snippet": "Tests run: 34, Failures: 0, Errors: 0, Skipped: 0; BUILD SUCCESS; EXIT_CODE=0"
      }
    ],
    "affected_issues": ["F3", "F4"],
    "residual_risks": [
      "IMPACT_UNVERIFIED: F3 and F4 both edit the same parseItem method after the icon guard; any F3/F4 fixture using a MATERIAL entry without icon.material will now be skipped before slot/price validation. Their fixes are not yet applied, so the interaction is not execution-verified.",
      "IMPACT_UNVERIFIED: existing shop.yml files that relied on the old BARRIER fallback will have those MATERIAL entries skipped after upgrade; this is the intended rejection, but no config migration or auto-repair was added.",
      "IMPACT_UNVERIFIED: only the three loader-related test classes were run (34 tests). The full repository suite was not run, so the final full build.cmd -o test remains the authoritative regression gate."
    ]
  },
  "error": null
}
```
