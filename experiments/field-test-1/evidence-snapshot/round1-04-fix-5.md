# F5 修复产物 — 购买成功消息报「合并后余量」而非「购买量」

- **finding_id**: F5
- **severity / dimension**: LOW / data-consistency
- **target_file**: `src/main/java/com/hilltopvillage/shop/ShopListener.java`
- **test_file**: `src/test/java/com/hilltopvillage/shop/ShopListenerPurchaseMessageTest.java`（新建）
- **disposition**: FIXED

## 1. 缺陷

`ShopListener#purchase` 在把商品交给背包之后才拼成功消息：

```java
Map<Integer, ItemStack> overflow = player.getInventory().addItem(product);
...
player.sendMessage(lang.getFor(player, "shop.purchase-success",
        resolveItemName(player, item), String.valueOf(product.getAmount()),
        String.valueOf(item.getPrice())));
```

Paper 1.21.4 的 `CraftInventory#addItem` 在把商品并进已有的半满叠时会**原地修改**调用方传入的
`ItemStack`，把它的数量改成没放进去的余量。复现形态：玩家已有 60 支箭，买 8 支 → 4 支并进旧叠
（60 → 64），4 支溢出落地，`product` 被改成 4，成功消息显示 `x4`，而玩家实际到账 8 支
（4 支在背包 + 4 支在脚下）。消息数量与实际购买量不一致，属于数据一致性缺陷。

## 2. 红测设计（修复前先写并跑红）

测试走真实的 `ShopListener#purchase`（private，方法签名修复前后不变；用反射调用，因此
**编译期只依赖既有 API**，不会用「方法不存在」冒充红测）。`Player` / `PlayerInventory` /
`World` / `Item` / `PersistentDataContainer` 用 JDK 动态代理构造，`PlayerInventory#addItem`
的桩精确复刻 Paper 的原地修改语义：

1. 校验传入的 stack 数量是完整购买量 8；
2. `stack.setAmount(4)`（模拟 4 支并进旧叠后的余量）；
3. 返回 overflow map（模拟 4 支溢出落地）。

`ShopManager` 用匿名子类只覆盖 `countCurrency` / `removeCurrency` / `deliverItem`，其余仍走真实
构造函数；`LanguageManager` 用匿名子类捕获 `shop.purchase-success` 的占位符实参
`{1}`（数量）。断言期望捕获 `[8]`。

测试文件还自检 `product.getAmount() == 4`，证明「addItem 已原地改写 product」这一缺陷触发条件
确实成立，而不是夹具没复现出形态。

## 3. 红测证据（未修复代码）

命令：

```powershell
.\build.cmd -o '-Dtest=ShopListenerPurchaseMessageTest' test
```

结果：`Tests run: 1, Failures: 1, Errors: 0`，退出码 1。失败原因是目标断言本身，不是编译/环境错误：

```text
org.opentest4j.AssertionFailedError: 成功消息的数量必须是购买量 8，而不是 addItem 合并后的余量 4。
实际捕获：[4]（未修复代码在 addItem 之后读 product.getAmount()，会得到余量）
==> expected: <[8]> but was: <[4]>
```

完整日志：`.work/round1/redlogs/F5-red.log`。

### 三次尝试内的环境失败（如实保留）

- attempt 1：`new ItemStack(...)` 在未初始化 MockBukkit server 时触发 `org.bukkit.Tag.<clinit>`
  的 `ExceptionInInitializerError`（夹具/环境问题，不是目标缺陷）。已改为继承
  `MockBukkitTestBase`，日志保留在 `.work/round1/redlogs/F5-red-attempt1-env.log`。
- attempt 2：Mockito 5.8.0 的 inline mock maker 在本机无法 self-attach，报
  `Could not initialize plugin: interface org.mockito.plugins.MockMaker`（环境限制）。已移除
  Mockito，改用 JDK 动态代理，日志保留在 `.work/round1/redlogs/F5-red-attempt2-mockito.log`。
- attempt 3：上文的有效红测，`expected: <[8]> but was: <[4]>`。

## 4. 修法（最小安全差异）

只在 `addItem` 之前捕获购买量，并用它拼消息；不改价格、扣款、发货、溢出落地语义：

```diff
         // 背包投递：满则溢出部分掉在脚下
+        // F5：必须先记下购买量——Paper 的 CraftInventory#addItem 在并入半满叠时会原地
+        // 修改传入的 product，把它的数量改成没放进去的余量，之后再读就只能读到余量。
+        int purchasedAmount = product.getAmount();
         java.util.Map<Integer, ItemStack> overflow = player.getInventory().addItem(product);
...
         player.sendMessage(lang.getFor(player, "shop.purchase-success",
-                resolveItemName(player, item), String.valueOf(product.getAmount()),
+                resolveItemName(player, item), String.valueOf(purchasedAmount),
                 String.valueOf(item.getPrice())));
```

`purchasedAmount` 位于 `product == null` 守卫之后、`addItem` 之前，因此捕获的一定是发货时的完整
购买量；溢出/合并只会改变 `product`，不会改变已捕获的值。修改前备份：
`.work/round1/backups/F5-before.java`（SHA-256 与修改前源文件一致：
`027FA4F28A93DFB8E5796DB9EF80C6C43776974C1826FEE767D25D1D72DCCF1E`）。

## 5. 绿测证据（修复后）

命令（禁用增量编译，强制重新编译 `ShopListener.java`，排除共享 `target/` 造成「Nothing to compile」
的歧义）：

```powershell
.\build.cmd -o '-Dtest=ShopListenerPurchaseMessageTest' '-Dmaven.compiler.useIncrementalCompilation=false' test
```

结果：`Compiling 1 source file with javac ... to target\classes`，
`Tests run: 1, Failures: 0, Errors: 0, Skipped: 0`，`BUILD SUCCESS`，退出码 0。
完整日志：`.work/round1/redlogs/F5-green.log`。

（此前同一命令的普通增量跑法也已通过，日志保留在
`.work/round1/redlogs/F5-green-sharedtarget.log`。）

## 6. 影响半径

- 只改 `ShopListener#purchase` 的成功消息数量占位符；发货、扣款、退款、冷却、溢出落地、
  `PAID_DROP_KEY` 打标均未改变。
- 不改变公共 API、配置格式、消息 key 或 `messages.yml` 模板。
- 对其他商品类型（HAMMER / FIREBALL / REPAIR_ITEM / MATERIAL / EQUIPMENT）同样只是让消息
  报「发货时的数量」，其中 HAMMER / EQUIPMENT 固定为 1，行为不变。
- 未修改其他源码、已有测试、`pom.xml`、`state.json` 或其他 finding 的产物。

## 7. 残余风险

- `IMPACT_UNVERIFIED`：测试用动态代理显式复刻 Paper `CraftInventory#addItem` 的原地余量语义，
  未在真实 Paper 1.21.4 服务端跑端到端购买；修复本身只依赖「捕获早于 addItem」这一调用顺序，
  即使某个服务端实现不原地改写，修复也仍然正确（消息仍等于购买量）。
- `IMPACT_UNVERIFIED`：只跑了 `-Dtest=ShopListenerPurchaseMessageTest`，未跑全量测试套件；
  其他购买分支（退款、全满、零价）未在本实例逐一回归。改动仅影响成功消息文本，不影响这些分支的
  控制流或金额计算。
- 未覆盖「购买量 > 单叠上限、跨多格拆分」的消息语义；`purchasedAmount` 仍是发货 stack 的初始
  数量，语义上就是「购买量」，与拆分无关。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "09140833-03e6-4981-ab37-f18c021f3762",
  "role": "fix",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "<TARGET_REPO>/.work/round1/round1-04-fix-5.md",
  "payload": {
    "finding_id": "F5",
    "disposition": "FIXED",
    "test_path": "src/test/java/com/hilltopvillage/shop/ShopListenerPurchaseMessageTest.java",
    "red_log_path": ".work/round1/redlogs/F5-red.log",
    "files_touched": [
      {
        "path": "src/main/java/com/hilltopvillage/shop/ShopListener.java",
        "change_summary": "在 addItem 之前捕获 int purchasedAmount = product.getAmount()，成功消息改用 purchasedAmount，避免读到 Paper addItem 原地改写后的余量"
      },
      {
        "path": "src/test/java/com/hilltopvillage/shop/ShopListenerPurchaseMessageTest.java",
        "change_summary": "新增 F5 红绿测试：动态代理模拟 addItem 把 product 改成余量 4，断言 shop.purchase-success 的数量占位符应为购买量 8；修复前实际为 4"
      }
    ],
    "verification_commands": [
      {
        "command": ".\\build.cmd -o '-Dtest=ShopListenerPurchaseMessageTest' test",
        "result": "failed",
        "output_snippet": "Tests run: 1, Failures: 1, Errors: 0 ... expected: <[8]> but was: <[4]>",
        "exit_code": 1
      },
      {
        "command": ".\\build.cmd -o '-Dtest=ShopListenerPurchaseMessageTest' '-Dmaven.compiler.useIncrementalCompilation=false' test",
        "result": "passed",
        "output_snippet": "Compiling 1 source file ... Tests run: 1, Failures: 0, Errors: 0, Skipped: 0 ... BUILD SUCCESS",
        "exit_code": 0
      }
    ],
    "affected_issues": [],
    "residual_risks": [
      "IMPACT_UNVERIFIED: 测试用动态代理显式复刻 Paper CraftInventory#addItem 的原地余量语义，未在真实 Paper 1.21.4 服务端跑端到端购买；修复只依赖捕获早于 addItem 的调用顺序，若服务端不原地改写则修复仍正确。",
      "IMPACT_UNVERIFIED: 仅运行 -Dtest=ShopListenerPurchaseMessageTest，未跑全量测试套件；退款/全满/零价等其他购买分支未在本实例逐一回归。"
    ]
  },
  "error": null
}
```
