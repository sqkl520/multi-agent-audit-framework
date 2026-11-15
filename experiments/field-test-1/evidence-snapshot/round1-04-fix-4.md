# F4 修复产物 — 显式 `amount: 0` / 负数必须在加载期跳过

- **finding_id**: F4
- **severity / dimension**: LOW / data-validation
- **target_file**: `src/main/java/com/hilltopvillage/shop/ShopConfigLoader.java`
- **test_file**: `src/test/java/com/hilltopvillage/shop/ShopConfigAmountValidationTest.java`（新建）
- **disposition**: FIXED

## 1. 缺陷

`ShopConfigLoader#parseItem` 用 `yaml.getInt(path + ".amount", 1)` 读取数量。显式 `amount: 0`
与负数都会原样进入 `ShopItem`；购买时仍按完整 `price` 扣费，而
`ShopManager#deliverItem` 为保护直接调用方，会把发货数量 `Math.max(1, item.getAmount())`
钳成 1。结果是买家支付了配置未合法指定的数量，GUI/描述与实际发货数量可能不一致。

缺键和显式 `amount:`（null）原本由 `getInt(..., 1)` 落到默认值 1，这是既有正确行为，必须保留。
`amount: 3` 等正数也必须原样保留。

## 2. 红测设计（先写测试、先跑红）

新测试类完全沿用 `ShopConfigPriceValidationTest` / `ShopConfigMaterialValidationTest` 的夹具风格：
`MockBukkitTestBase` + `loadBareHost()` +
`TestPaths.write(new File(host.getDataFolder(), "shop.yml"), yaml)`，使用真实
`ShopConfigLoader#load()`，**不使用 Mockito**。所有 MATERIAL 条目都带合法
`icon: { material: BOW }`，不会先被 F2 的 icon 守卫截走。共 5 条用例：

1. `zeroAmountIsSkipped`：`amount: 0`，断言条目不在 `ShopConfig#getItems()`，warning 包含
   `invalid amount 0` 与 `item 'probe'`。
2. `negativeAmountIsSkipped`：`amount: -5`，同样断言条目缺失，warning 包含
   `invalid amount -5` 与 `item 'probe'`。
3. `missingAmountDefaultsToOne`（控制组）：不写 `amount`，断言条目存在、数量为 1、无
   `invalid amount` 告警。
4. `nullAmountDefaultsToOne`（控制组）：显式 `amount:`，断言条目存在、数量为 1、无
   `invalid amount` 告警。
5. `positiveAmountIsHonored`（控制组）：`amount: 3`，断言条目存在、数量为 3、无告警。

测试只引用修复前已存在的 API，因此在旧代码上可编译；红测失败来自数量断言，不是编译错误。

## 3. 红测证据（未修复代码）

命令（共享 Maven 互斥锁内执行；退出码非 0 是红测预期）：

```powershell
.\build.cmd -o '-Dtest=ShopConfigAmountValidationTest' test
```

结果：`Tests run: 5, Failures: 2, Errors: 0, Skipped: 0`，`EXIT_CODE=1`。
两个失败恰好是 `amount: 0` 与 `amount: -5`，三个正控制组在修复前已通过：

```text
[ERROR] ShopConfigAmountValidationTest.zeroAmountIsSkipped:84
  An explicit amount: 0 must reject the item ...; it loaded with amount 0
  (items: [probe]) ==> expected: <null> but was: <ShopItem@2596d7f4>
[ERROR] ShopConfigAmountValidationTest.negativeAmountIsSkipped:110
  An explicit amount: -5 must reject the item ...; it loaded with amount -5
  (items: [probe]) ==> expected: <null> but was: <ShopItem@76a14c8d>
[ERROR] Tests run: 5, Failures: 2, Errors: 0, Skipped: 0
```

完整日志：`.work/round1/redlogs/F4-red.log`（末尾带 `EXIT_CODE=1`）。

## 4. 修法（最小安全差异）

在 `amount` 解析之后、`name` / `lore` 之前增加非正数守卫：显式 0 或负数 warning 点名 item id
和非法值，并 `return null` 跳过。缺键和 null 已经由 `getInt(..., 1)` 得到 1，不进入该分支；
正数不受影响。`ShopManager#deliverItem` 的 `Math.max(1, ...)` 防御性钳制保持原样，供直接调用方
继续使用。

```diff
         int amount = yaml.getInt(path + ".amount", 1);
+        // fix4 F4：deliverItem 会把非正数量钳成 1 发货，但购买仍按整价扣费——显式 0/负数必须在加载期跳过。
+        if (amount <= 0) {
+            plugin.getLogger().warning("shop.yml: item '" + id + "' has invalid amount " + amount
+                    + " (must be at least 1), skipped");
+            return null;
+        }
 
         String name = yaml.getString(path + ".name");
```

修改前备份：`.work/round1/backups/F4-before.java`，在 `START-F4` 出现后、F3 已完成时复制，
SHA-256 `E0CBA0FFCE9F3F4C0316B7F2DB18A7A5C34B86E2F75B96A4E81D4627B5473468`。
备份与最终文件的 diff 只有上述 6 行新增、0 行删除；F1 的 `YamlFiles.load`、F2 的 MATERIAL
icon 守卫、F3 的 missing-price 守卫均未改动。

## 5. 绿测证据（修复后，最终代码）

命令：

```powershell
.\build.cmd -o '-Dtest=ShopConfigAmountValidationTest,ShopConfigLoaderTest' test
```

结果：`Tests run: 36, Failures: 0, Errors: 0, Skipped: 0`，`BUILD SUCCESS`，`EXIT_CODE=0`。
其中 `ShopConfigAmountValidationTest` 5/5 通过，`ShopConfigLoaderTest` 31/31 通过。
完整日志：`.work/round1/redlogs/F4-green.log`（末尾带 `EXIT_CODE=0`）。

## 6. 影响半径

- 生产代码只改 `ShopConfigLoader#parseItem`：显式 `amount <= 0` 的条目由「加载后按 1 发货、
  按整价扣费」变为「跳过 + 点名非法值的 warning」。这是 F4 要求的行为变化。
- 缺 `amount` 键与 `amount: null` 仍为 1；`amount: 3` 仍为 3；正数解析路径未改。
- 守卫位于共享解析路径，因此对 HAMMER / FIREBALL / REPAIR_ITEM / MATERIAL / EQUIPMENT
  一致生效；其中 HAMMER / EQUIPMENT 原本忽略 amount，但显式 0 / 负数属于非法配置，跳过符合
  F4 的统一要求。
- `ShopManager#deliverItem` 未改，其对直接调用方的 `Math.max(1, ...)` 防御性钳制仍然保留。
- 未修改其他源码、已有测试、`state.json`、`pom.xml` 或其他 finding 的产物。

补充回归尝试：额外运行 `.\build.cmd -o '-Dtest=ShopManagerTest' test`，34 个测试全部在
`setUp` 阶段因环境中的 Mockito 5.8 inline Byte Buddy 无法 self-attach 而报
`MockitoInitializationException` / `IllegalStateException`，没有执行到任何断言，也没有改变
`deliverItem` 的源码。该失败与 F4 无关，但本实例无法在此沙箱内取得 `ShopManagerTest` 的通过证据。

## 7. 残余风险

- `REGRESSION_UNVERIFIED`：`ShopManagerTest` 在本沙箱中无法执行（Mockito inline mock maker
  无法 self-attach；失败日志保留在 `.work/round1/redlogs/F4-shopmanager.log` 与
  `F4-shopmanager-attach.log`）。F4 未修改 `ShopManager`，但最终权威门禁仍应在正常环境中运行
  `ShopManagerTest` / 全量测试。
- `IMPACT_UNVERIFIED`：`amount` 配置为非整数（如 `abc`）时仍走 Bukkit `getInt(..., 1)` 的既有
  类型转换路径；F4 只约束转换结果 `<= 0` 的情况，未扩大为通用类型校验。
- 测试只直接覆盖 MATERIAL 的显式 0 / 负数与正控制组；其他类型的跳过依据是共享 `parseItem`
  代码路径，未逐一构造五类商品的夹具。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "15d68097-68e3-4355-aba0-28ff82df6c5d",
  "role": "fix",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "<TARGET_REPO>/.work/round1/round1-04-fix-4.md",
  "payload": {
    "finding_id": "F4",
    "disposition": "FIXED",
    "test_path": "src/test/java/com/hilltopvillage/shop/ShopConfigAmountValidationTest.java",
    "red_log_path": ".work/round1/redlogs/F4-red.log",
    "files_touched": [
      {
        "path": "src/main/java/com/hilltopvillage/shop/ShopConfigLoader.java",
        "change_summary": "在 amount 解析后增加非正数守卫：显式 amount <= 0 时 warning 点名 item id 与非法值并 return null；缺键/null 仍由 getInt(...,1) 得到 1，正数不变。"
      },
      {
        "path": "src/test/java/com/hilltopvillage/shop/ShopConfigAmountValidationTest.java",
        "change_summary": "新增 F4 红绿测试：amount: 0 与 -5 必须跳过并告警；缺键、null 仍为 1；amount: 3 仍为 3。使用 MockBukkitTestBase + TestPaths.write，无 Mockito。"
      }
    ],
    "verification_commands": [
      {
        "command": ".\\build.cmd -o '-Dtest=ShopConfigAmountValidationTest' test",
        "result": "failed",
        "output_snippet": "Tests run: 5, Failures: 2, Errors: 0, Skipped: 0; zeroAmountIsSkipped loaded amount 0; negativeAmountIsSkipped loaded amount -5; EXIT_CODE=1"
      },
      {
        "command": ".\\build.cmd -o '-Dtest=ShopConfigAmountValidationTest,ShopConfigLoaderTest' test",
        "result": "passed",
        "output_snippet": "Tests run: 36, Failures: 0, Errors: 0, Skipped: 0; BUILD SUCCESS; EXIT_CODE=0"
      }
    ],
    "affected_issues": [],
    "residual_risks": [
      "REGRESSION_UNVERIFIED: ShopManagerTest 无法在本沙箱执行（Mockito 5.8 inline Byte Buddy self-attach 失败，34 个测试全部在 setUp 报 MockitoInitializationException）；F4 未修改 ShopManager，但应在正常环境补跑 ShopManagerTest 或全量测试。",
      "IMPACT_UNVERIFIED: amount 为非整数时仍走 Bukkit getInt(...,1) 的既有类型转换路径；F4 只约束转换结果 <= 0 的情况。",
      "测试直接覆盖 MATERIAL 的显式 0/负数与正控制组；其他类型的跳过依赖共享 parseItem 路径，未逐类构造夹具。"
    ]
  },
  "error": null
}

```