# F1 — corrupt or truncated `shop.yml` must not become a valid empty shop

- **Finding**: F1 (MEDIUM, error-handling)
- **Target**: `src/main/java/com/hilltopvillage/shop/ShopConfigLoader.java`
- **New test**: `src/test/java/com/hilltopvillage/shop/ShopConfigCorruptFileTest.java`
- **Disposition**: FIXED

## Defect

`YamlConfiguration.loadConfiguration(File)` logs and swallows YAML parse errors, returning an empty `YamlConfiguration`. In `ShopConfigLoader.load()`, that produced a null `shop.items` section, an empty item list, and a normal `ShopConfig`. `ShopManager.reload()` then assigned that empty snapshot over the live configuration.

Independent verification found a second form: a file truncated at the `  items:` header is still syntactically valid YAML. Bukkit converts the null `items` value by dropping the key, so the section API cannot distinguish it from an omitted `items` key. The old loader again returned 0 items, and reload replaced a previous 1-item snapshot with the empty one (`sameSnapshot=false`).

## Reproduction and red tests

### Pass 1 — unparseable YAML

The test writes this invalid YAML into the host's real `shop.yml`:

```yaml
shop:
  items:
    broken: [unclosed
```

It asserts that `load()` throws `IllegalStateException` naming `shop.yml`. A second test loads a valid snapshot (`currency.material: DIAMOND`), overwrites the file with the corrupt YAML, calls `ShopManager.reload()`, and asserts the previous `ShopConfig` instance is still held.

Red command (unmodified loader):

```text
.\build.cmd -o '-Dtest=ShopConfigCorruptFileTest' test
```

Red result:

```text
Tests run: 2, Failures: 2, Errors: 0, Skipped: 0
Expected java.lang.IllegalStateException to be thrown, but nothing was thrown.
BUILD FAILURE
EXIT_CODE=1
```

Full log: `.work/round1/redlogs/F1-red.log`

### Pass 2 — parseable truncation at `items:`

The added regression first loads a valid one-item snapshot, then writes YAML that keeps `shop.currency`, `shop.npc`, and `shop.gui` but ends at the `items:` header:

```yaml
shop:
  currency:
    material: EMERALD
  npc:
    name: "&aShop Keeper"
  gui:
    size: 54
  items:
```

It asserts that direct `load()` throws, that `shop.items` is named in the message, and that `ShopManager.reload()` throws while the previous 1-item snapshot survives by identity. A fourth test preserves the two legitimate forms: explicit `items: {}` and an omitted `items` key both load as an empty item list.

Red command (pass-1 fix present, no second guard):

```text
.\build.cmd -o '-Dtest=ShopConfigCorruptFileTest' test
```

Red result:

```text
Tests run: 4, Failures: 1, Errors: 0, Skipped: 0
A present-but-null shop.items key is a parseable truncation and must not load as empty
  ==> Expected java.lang.IllegalStateException to be thrown, but nothing was thrown.
BUILD FAILURE
EXIT_CODE=1
```

Full log: `.work/round1/redlogs/F1-pass2-red.log`

The initial first-pass red invocation hit a test-compile error because `TestPaths` is an inherited nested type, not an importable top-level class. It is preserved as `.work/round1/redlogs/F1-red-attempt1-compile.log`; the final first-pass red log above contains only the two intended assertion failures.

## Fix

`ShopConfigLoader.load()` now uses the existing `YamlFiles.load(file, null, plugin.getLogger())` utility, which reads with `Files.readString` + `YamlConfiguration.loadFromString` so parse failures are actually thrown, and quarantines unusable files as `shop.yml.corrupt`. If the result is unusable, the loader throws a descriptive `IllegalStateException` carrying the status and parse detail:

```java
YamlFiles.Loaded loaded = YamlFiles.load(file, null, plugin.getLogger());
if (!loaded.usable()) {
    String detail = loaded.detail();
    throw new IllegalStateException("Cannot use shop.yml (" + loaded.status() + ")"
            + (detail == null ? "" : ": " + detail)
            + ". Refusing to replace the live shop with an empty configuration.");
}
YamlConfiguration yaml = loaded.config();
```

For the parseable truncation, Bukkit has already removed the null `items` key by the time `YamlConfiguration` is available. The loader therefore inspects the raw YAML map only when `shop.items` is not a section:

```java
if (yaml.getConfigurationSection("shop.items") == null) {
    Map<?, ?> rawShop = rawShopSection(file);
    if (rawShop != null && rawShop.containsKey("items")
            && !(rawShop.get("items") instanceof Map)) {
        throw new IllegalStateException("shop.yml: 'shop.items' is present but is not a mapping"
                + " (value: " + rawShop.get("items") + "); the file appears truncated."
                + " Refusing to replace the live shop configuration.");
    }
}
```

This rejects a present-but-null `items:` key and other non-mapping values. An explicit `items: {}` parses as an empty `Map` and remains valid; an omitted `items` key is absent from the raw map and keeps the existing empty-item behavior.

`ShopManager.reload()` still evaluates `loader.load()` before assigning `this.config`; when the exception escapes, the assignment never happens. The last valid `ShopConfig` is preserved, and no success message is sent from the command handler.

Implementation note: an initial guard based on `ConfigurationSection.getKeys(false)` did not fire because Bukkit strips null values during YAML-to-section conversion. That failed green attempt is preserved at `.work/round1/redlogs/F1-pass2-green-attempt1-sectionkey.log`. A subsequent attempt had a duplicate local variable at compile time and is preserved at `.work/round1/redlogs/F1-pass2-green-attempt2-compile.log`. The final guard above inspects the raw YAML map instead.

## Green evidence

Command (focused test plus the existing loader suite):

```text
.\build.cmd -o '-Dtest=ShopConfigCorruptFileTest,ShopConfigLoaderTest' test
```

Green result:

```text
ShopConfigCorruptFileTest: Tests run: 4, Failures: 0, Errors: 0, Skipped: 0
ShopConfigLoaderTest:      Tests run: 31, Failures: 0, Errors: 0, Skipped: 0
Total:                     Tests run: 35, Failures: 0, Errors: 0, Skipped: 0
BUILD SUCCESS
EXIT_CODE=0
```

Full log: `.work/round1/redlogs/F1-pass2-green.log`

## Impact radius

Only the authorized target source and the new test file were changed. No F2/F3/F4 behavior, `ShopListener`, existing tests, command handler, or `CommandsDocumentGenerator` was touched. The fix reuses the repository's existing `YamlFiles` utility for parse failures and adds a narrow raw-YAML check for the parseable `items:` truncation.

## Residual risks

- `REGRESSION_UNVERIFIED`: the broader shop/Mockito suite failed first at `NpcManagerTest.setUp:131` with `Could not initialize plugin: interface org.mockito.plugins.MockMaker (alternate: null)` (Byte Buddy self-attach failure), and 142 MockBukkit tests cascaded in the same JVM. This is an environment/test-isolation limitation, not an assertion failure caused by this change. The final full `build.cmd -o test` should be treated as the authoritative regression run.
- `IMPACT_UNVERIFIED`: this guard covers a present-but-non-mapping `shop.items` value, including the reported `items:`-header truncation. Other parseable truncations outside that shape (for example, a file ending at `shop:` itself, or after a complete `items: {}` but before a later section) may still load partially or as empty. The specifically reported acceptance gap is covered.
- `IMPACT_UNVERIFIED`: on `/hilltop shop reload`, the new `IllegalStateException` escapes to the Bukkit command boundary and is visibly logged; no localized chat reply was added because `HilltopCommandHandler` is outside the authorized target. The in-memory `ShopConfig` remains the previous valid snapshot.

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "2361960f-9b85-4cd6-93cd-1c55a192b29b",
  "role": "fix",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:\\Server\\<TARGET_PARENT>\\Server plugin\\Hilltop Village\\Hilltop Village Plugin\\.work\\round1\\round1-04-fix-1.md",
  "payload": {
    "finding_id": "F1",
    "disposition": "FIXED",
    "test_path": "src/test/java/com/hilltopvillage/shop/ShopConfigCorruptFileTest.java",
    "red_log_path": ".work/round1/redlogs/F1-pass2-red.log",
    "files_touched": [
      {
        "path": "src/main/java/com/hilltopvillage/shop/ShopConfigLoader.java",
        "change_summary": "Replaced the exception-swallowing YamlConfiguration.loadConfiguration(File) call with YamlFiles.load(...); reject unusable parse results and present-but-non-mapping shop.items values (including a null value left by truncation) with descriptive IllegalStateException instead of returning an empty shop."
      },
      {
        "path": "src/test/java/com/hilltopvillage/shop/ShopConfigCorruptFileTest.java",
        "change_summary": "Added four regression tests covering unparseable YAML, parseable truncation at the items: header, preservation of the previous ShopConfig on failed reload, and continued validity of explicit items: {} and omitted items."
      }
    ],
    "verification_commands": [
      {
        "command": ".\\build.cmd -o '-Dtest=ShopConfigCorruptFileTest' test",
        "result": "failed",
        "output_snippet": "Pass 1, unmodified loader: Tests run: 2, Failures: 2, Errors: 0, Skipped: 0; Expected java.lang.IllegalStateException to be thrown, but nothing was thrown.; BUILD FAILURE; EXIT_CODE=1"
      },
      {
        "command": ".\\build.cmd -o '-Dtest=ShopConfigCorruptFileTest' test",
        "result": "passed",
        "output_snippet": "Pass 1 after initial fix: Tests run: 2, Failures: 0, Errors: 0, Skipped: 0; BUILD SUCCESS; EXIT_CODE=0"
      },
      {
        "command": ".\\build.cmd -o '-Dtest=ShopConfigCorruptFileTest' test",
        "result": "failed",
        "output_snippet": "Pass 2, before items guard: Tests run: 4, Failures: 1, Errors: 0, Skipped: 0; A present-but-null shop.items key is a parseable truncation and must not load as empty ==> Expected java.lang.IllegalStateException to be thrown, but nothing was thrown.; BUILD FAILURE; EXIT_CODE=1"
      },
      {
        "command": ".\\build.cmd -o '-Dtest=ShopConfigCorruptFileTest,ShopConfigLoaderTest' test",
        "result": "passed",
        "output_snippet": "Pass 2 final: Tests run: 35, Failures: 0, Errors: 0, Skipped: 0 (4 focused + 31 existing loader); BUILD SUCCESS; EXIT_CODE=0"
      }
    ],
    "affected_issues": [],
    "residual_risks": [
      "REGRESSION_UNVERIFIED: the broader shop/Mockito suite first failed at NpcManagerTest.setUp:131 with Mockito/Byte Buddy self-attach initialization, then 142 MockBukkit tests cascaded in the same JVM; this is an environment/test-isolation limitation, not an assertion caused by this change. Full build.cmd -o test is the authoritative regression run.",
      "IMPACT_UNVERIFIED: the guard covers a present-but-non-mapping shop.items value, including the reported items:-header truncation; other parseable truncations outside that shape (such as a file ending at shop: itself, or after a complete items: {} but before a later section) may still load partially or as empty.",
      "IMPACT_UNVERIFIED: /hilltop shop reload lets IllegalStateException escape to the Bukkit command boundary and logs it visibly; no localized chat reply was added because HilltopCommandHandler is outside the authorized target. The previous ShopConfig remains in memory."
    ]
  },
  "error": null
}
```
