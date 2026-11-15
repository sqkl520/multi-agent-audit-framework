# F3 修复产物 — 缺 `price` 键不得静默默认成 1 货币

- **finding_id**: F3
- **severity / dimension**: MEDIUM / data-validation
- **target_file**: `src/main/java/com/hilltopvillage/shop/ShopConfigLoader.java`
- **test_file**: `src/test/java/com/hilltopvillage/shop/ShopConfigPriceValidationTest.java`（新建）
- **stale_test_corrected**: `src/test/java/com/hilltopvillage/shop/ShopConfigLoaderTest.java`
- **disposition**: FIXED

## 1. 缺陷

`ShopConfigLoader#parseItem` 在修复前用：

```java
int price = yaml.getInt(path + ".price", 1);
```

读取价格。Bukkit 的 `getInt(path, def)` 对「键不存在」和「键存在但值为 null」都返回默认值 1，
因此「服主漏写 price」与「price 写了但被留空」都被静默定价为 1 货币：商品照常出现、照常出售，
日志里没有任何提示。与此同时 `price: 0` 是合法的「有意免费」，`price: -5` 会走已有的
「钳到 0 + negative price 告警」分支。缺键与显式 0 在结果上无法区分，属于数据校验缺陷。

## 2. 复现与红测设计（先写测试、先跑红）

新测试类 `ShopConfigPriceValidationTest` 完全沿用 `ShopConfigCorruptFileTest` /
`ShopConfigMaterialValidationTest` 的夹具风格：`MockBukkitTestBase` + `loadBareHost()` +
`TestPaths.write(new File(host.getDataFolder(), "shop.yml"), yaml)`，**不使用 Mockito**，
只通过真实的 `ShopConfigLoader#load()` 读取真实写盘的 `shop.yml`。共 4 条用例：

1. `missingPriceKeyIsSkipped`：MATERIAL 条目只写 `slot/type/icon.material`，**不写 price**。
   断言 `getItems()` 里没有 `probe`，且 warning 同时包含 `missing price` 与 `item 'probe'`。
2. `nullPriceIsSkipped`：写成 `price:`（显式 null）。同样断言条目被跳过并告警。
3. `zeroPriceIsLegalWithoutWarning`（控制组）：`price: 0`。断言条目仍存在、价格为 0，
   且不出现 `missing price` / `negative price` 告警。
4. `negativePriceIsStillClampedToZero`（控制组）：`price: -5`。断言条目仍存在、价格被钳到 0，
   且保留 `negative price -5` 告警。

红测只依赖修复前就存在的 API（`ShopConfig#getItems`、`ShopItem#getPrice`、日志捕获），
因此**在未修复代码上可编译**，失败来自断言本身而不是「方法不存在」。

## 3. 红测证据（未修复代码）

命令（共享 Maven 互斥锁内执行；退出码非 0 是红测的预期结果）：

```powershell
.\build.cmd -o '-Dtest=ShopConfigPriceValidationTest' test
```

结果：`Tests run: 4, Failures: 2, Errors: 0, Skipped: 0`，`EXIT_CODE=1`。
两个失败恰好是缺价断言，控制组（0 与 -5）在修复前就已通过：

```text
[ERROR] ShopConfigPriceValidationTest.missingPriceKeyIsSkipped:81
  A missing price key must reject the item instead of defaulting to 1; it loaded with price 1
  (items: [probe]) ==> expected: <null> but was: <com.hilltopvillage.shop.ShopItem@334ebcaa>
[ERROR] ShopConfigPriceValidationTest.nullPriceIsSkipped:105
  An explicit price: null must reject the item instead of defaulting to 1; it loaded with price 1
  (items: [probe]) ==> expected: <null> but was: <com.hilltopvillage.shop.ShopItem@66f28a1f>
```

完整日志：`.work/round1/redlogs/F3-red.log`（末尾带 `EXIT_CODE=1`）。

## 4. 修法（最小安全差异）

在读取 price 之前用 `yaml.isSet(...)` 区分「键存在且非 null」与「缺键 / null」；后者直接
`return null` 跳过该条目，warning 点名 item id 并明确写 `missing price`。检查放在槽位登记之前，
这样被跳过的条目不会占用槽位、不会给后续商品制造虚假的槽位冲突告警。`price: 0` 的 `isSet`
为 true，不受影响；负数继续走原有钳制分支。

```diff
+        // fix3 F3：缺键 / 显式 null 与 price: 0 不能混为一谈——getInt(...,1) 会把前者静默变成
+        // 1 货币。缺价是误配，跳过并点名；0 仍是有意免费，负数仍走下面的钳制分支。
+        // 放在槽位登记之前：被跳过的条目不应占用槽位，否则会误报槽位冲突。
+        if (!yaml.isSet(path + ".price")) {
+            plugin.getLogger().warning("shop.yml: item '" + id
+                    + "' is missing price (key absent or null), skipped");
+            return null;
+        }
+
         int slot = yaml.getInt(path + ".slot", -1);
```

`int price = yaml.getInt(path + ".price", 1);` 保留在原位（此时键一定存在），因此
「键存在但不是数字」的既有行为（仍取默认 1）未被本次改动扩大或改变。

同时修正了编码缺陷的旧测试：`ShopConfigLoaderTest` 的
`missingPriceDefaultsToOne`（原断言缺 price 时 `getPrice() == 1`）重命名为
`missingPriceIsSkipped`，改为断言 `config.getItems().isEmpty()` 且日志包含
`missing price`。`zeroPriceIsLegalWithoutWarning` 与 `negativePriceIsClampedToZero`
原样保留并通过。

修改前备份：`.work/round1/backups/F3-before.java`，在 `START-F3` 出现后、F2 已完成时复制，
SHA-256 `9E0E74F41FAB52CE23AF16B3FACD1DBC6D5946FF6288EF88BB92B4D3DF5DA7DD`，与当时的
`ShopConfigLoader.java` 完全一致（该文件已含 F1 的 `YamlFiles.load` 与 F2 的 MATERIAL
icon 条件）。最终差异只包含上述新增块（`Compare-Object` 显示 5 条 added、0 条 removed）。

## 5. 绿测证据（修复后，最终代码）

命令：

```powershell
.\build.cmd -o '-Dtest=ShopConfigPriceValidationTest,ShopConfigLoaderTest' test
```

结果：`Tests run: 35, Failures: 0, Errors: 0, Skipped: 0`，`BUILD SUCCESS`，`EXIT_CODE=0`。
其中 `ShopConfigPriceValidationTest` 4/4 通过，`ShopConfigLoaderTest` 31/31 通过
（含修正后的 `missingPriceIsSkipped` 与保留的 0 价 / 负价用例）。完整日志：
`.work/round1/redlogs/F3-green.log`（末尾带 `EXIT_CODE=0`）。

## 6. 影响半径

- 生产代码只改 `ShopConfigLoader#parseItem` 的 price 读取前置校验：缺键 / null 的条目由
  「静默按 1 货币出售」变为「跳过 + warning」。这是 F3 要求的行为变化。
- `price: 0` 仍是有意免费；`price: -5` 仍钳到 0 并保留原 warning；`amount/name/lore/icon/type/slot`
  的解析路径未改。公共 API、配置格式、消息 key 均未改。
- 检查前置到槽位登记之前，仅影响「缺价条目是否占用槽位」：被跳过的条目不再占位，后续同槽位商品
  不会收到虚假冲突告警。
- F1 的 `YamlFiles.load` 与 F2 的 `(EQUIPMENT || MATERIAL) && !iconConfigured` 条件均未改动；
  备份与最终文件的差异只有 F3 新增块。
- 未修改其他源码、其他测试、`state.json`、`pom.xml` 或其他 finding 的产物。

## 7. 残余风险

- `REGRESSION_UNVERIFIED`：本实例只运行了指定的
  `-Dtest=ShopConfigPriceValidationTest,ShopConfigLoaderTest`。曾尝试更宽的
  `-Dtest=Shop*Test,NpcManagerTest` 子集，结果被环境中 Mockito inline mock maker 无法
  self-attach（`Could not initialize plugin: interface org.mockito.plugins.MockMaker`，
  125 个 `MockitoInitializationException`）打断，属于环境失败，**不作为通过证据**，也不是
  F3 回归。全量 `build.cmd -o test` 是最终权威门禁，本实例未运行。
- `IMPACT_UNVERIFIED`：`price` 键存在但值不是数字（如 `price: "5"` 或 `price: abc`）时，
  `isSet` 为 true，仍走 `getInt(..., 1)` 返回 1。这是修复前既有行为，F3 只要求区分
  「缺键 / null」与「显式 0」，本次未扩大改动范围。
- 显式 null 的判定依赖 Bukkit `ConfigurationSection#isSet` 的语义（键存在但值为 null 视为
  not set）；测试 `nullPriceIsSkipped` 已在真实 `YamlConfiguration` 上覆盖该路径。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "c8a13a85-3814-4877-b520-b92ea386e99c",
  "role": "fix",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "<TARGET_REPO>/.work/round1/round1-04-fix-3.md",
  "payload": {
    "finding_id": "F3",
    "disposition": "FIXED",
    "test_path": "src/test/java/com/hilltopvillage/shop/ShopConfigPriceValidationTest.java",
    "red_log_path": ".work/round1/redlogs/F3-red.log",
    "files_touched": [
      {
        "path": "src/main/java/com/hilltopvillage/shop/ShopConfigLoader.java",
        "change_summary": "在读取 price 前增加 yaml.isSet(path + \".price\") 校验：缺键或显式 null 时 warning（missing price）并 return null 跳过条目；检查位于槽位登记之前。显式 price: 0 与负数钳制分支不变。"
      },
      {
        "path": "src/test/java/com/hilltopvillage/shop/ShopConfigPriceValidationTest.java",
        "change_summary": "新增 F3 红绿测试：缺 price 键与 price: null 必须跳过并告警；price: 0 仍合法免费；price: -5 仍钳到 0 并保留 negative price 告警。使用 MockBukkitTestBase + TestPaths.write，无 Mockito。"
      },
      {
        "path": "src/test/java/com/hilltopvillage/shop/ShopConfigLoaderTest.java",
        "change_summary": "修正编码缺陷的旧测试：missingPriceDefaultsToOne 重命名为 missingPriceIsSkipped，断言由 getPrice()==1 改为条目被跳过且日志包含 missing price；0 价与负价用例未改。"
      }
    ],
    "verification_commands": [
      {
        "command": ".\\build.cmd -o '-Dtest=ShopConfigPriceValidationTest' test",
        "result": "failed",
        "output_snippet": "Tests run: 4, Failures: 2, Errors: 0, Skipped: 0 ... missingPriceKeyIsSkipped:81 expected: <null> but was: <ShopItem@334ebcaa>; nullPriceIsSkipped:105 expected: <null> but was: <ShopItem@66f28a1f>",
        "exit_code": 1
      },
      {
        "command": ".\\build.cmd -o '-Dtest=ShopConfigPriceValidationTest,ShopConfigLoaderTest' test",
        "result": "passed",
        "output_snippet": "Tests run: 35, Failures: 0, Errors: 0, Skipped: 0 ... BUILD SUCCESS",
        "exit_code": 0
      }
    ],
    "affected_issues": [],
    "residual_risks": [
      "REGRESSION_UNVERIFIED: 仅运行 -Dtest=ShopConfigPriceValidationTest,ShopConfigLoaderTest；更宽的 Shop*Test,NpcManagerTest 子集因环境 Mockito inline mock maker 无法 self-attach（125 个 MockitoInitializationException）失败，属环境限制，不作为通过证据；全量 build.cmd -o test 未由本实例运行。",
      "IMPACT_UNVERIFIED: price 键存在但值非数字（如 price: \"5\" 或 price: abc）时仍走 getInt(path, 1) 得到 1；这是修复前既有行为，F3 只要求缺键/null 与显式 0 可区分，本次未扩大范围。",
      "显式 null 的判定依赖 Bukkit ConfigurationSection#isSet 语义（键存在但值为 null 视为 not set），已由 nullPriceIsSkipped 在真实 YamlConfiguration 上覆盖。"
    ]
  },
  "error": null
}

```