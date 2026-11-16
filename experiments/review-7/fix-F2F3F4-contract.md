# F2 / F3 / F4 契约破坏修复

评审对象：`<TARGET_REPO>`
改动文件：`src/main/java/com/hilltopvillage/shop/ShopConfigLoader.java`、
`src/test/java/com/hilltopvillage/shop/ShopConfigLoaderTest.java`
（另：两份由 F2/F3 修复者新建、把反向期望一起写进去的测试文件
`ShopConfigMaterialValidationTest.java` / `ShopConfigPriceValidationTest.java` 同步改回正确期望——
它们是同一处契约破坏的副本，留着就还是绿的假契约。）

最终结果：**929 tests / 0 failures / 0 errors / 1 skipped**（基线 905 全绿，净增 24 条）。
未 `git add`、未 `git commit`。

---

## 0. 先说结论

三处修复里，**两条（F2、F3）把「合法配置」判成了「非法配置」，并把既有的契约测试改成反向期望来让自己变绿**。
这是把缺陷编码成契约，不是修缺陷。

| 编号 | 原缺陷是否真实 | 原修复的方向 | 我的判定 | 采用方案 |
|---|---|---|---|---|
| F2 MATERIAL 缺 `icon.material` | 真实（会显示/发放屏障方块） | 整条丢弃 | **方向错**（破坏性） | 保留商品 + 回落 BARRIER + 明确 warning + 末尾汇总 |
| F3 `price` 缺键 | 部分是（真问题是「服主不知道默认了」，不是「默认 1」） | 整条丢弃 | **方向错**（把合法配置判非法） | 保留默认 1 + 明确 warning（点名实际采用值）+ 末尾汇总 |
| F4 `amount <= 0` | 真实 | 整条丢弃 | **方向对，作用域过宽** | 保留丢弃，但只在真正消费 `amount` 的类型上校验 |

三处都**没有**做成「整条丢弃」以外的破坏性形态，也**没有**再删任何商品的合法配置入口。

---

## 1. 开工前读的三处（决定修法的依据）

### 1.1 `ShopManager.deliverItem(...)` —— 哪些类型真的用 `amount`

```java
int amount = Math.max(1, item.getAmount());
switch (item.getType()) {
    case "HAMMER":       return plugin.getHammerListener().createHammer();          // 固定 1，忽略 amount
    case "FIREBALL":     return ...createFireball().asQuantity(amount);             // 用
    case "REPAIR_ITEM":  return ...createRepairItem(amount);                        // 用
    case "MATERIAL":     return new ItemStack(item.getIcon(), amount);              // 用
    case "EQUIPMENT":    return createEquipment(item);                              // new ItemStack(icon, 1)，忽略 amount
}
```

结论：**只有 `FIREBALL` / `REPAIR_ITEM` / `MATERIAL` 消费 `amount`**。
`HAMMER` / `EQUIPMENT` 完全忽略它 —— 在这两类上写 `amount: 0` 是冗余无害键，
F4 对它俩做 `amount <= 0` 校验等于「用一条与语义无关的键删掉合法商品」。
这直接决定了 F4 的收窄方式（新增 `USES_AMOUNT` 常量）。

### 1.2 `ShopGUI` —— 有没有「不可购买」的既有表示

**没有。** `ShopGUI.buildDisplayItem` 无条件 `new ItemStack(item.getIcon())`，
`fillEmpty()` 用灰色玻璃板占位且 `bySlot` 不登记 → 占位格点击无效。
`ShopItem` 是 9 个 final 字段 + 全参构造，没有任何 `purchasable` / `enabled` 标记；
`ShopGUI` / `ShopListener` / `ShopManager` / `ShopItem` 四个文件都不在本次可改范围内。

所以我**没有**选「灰显 + 阻止购买」方案：它需要给 `ShopItem` 加字段并由
`ShopGUI` 灰显、`ShopListener` 拒单，跨 4 个文件，超出「只改两个文件」的硬边界。
我选的是这个代码库**既有且一致**的形态 —— **保留商品 + 明确告警**，
与既有先例逐条对齐：

| 既有先例 | 处理方式 |
|---|---|
| 负数价格（`negativePriceIsClampedToZero`） | 钳到 0 + 保留商品 + warning |
| 槽位冲突（fix5 M-10） | 保留两件 + warning 点名双方 |
| 非 item 货币材质（fix6 Y2-06） | 回落 EMERALD + 保留 + warning |
| GUI 尺寸非法 | 钳制 + 保留 + warning |

**注意**：`EQUIPMENT` 缺 `icon.material` 的「整条跳过」是 round1 起的既有契约
（`equipmentWithoutIconIsSkipped`，HEAD 里就有），我**原样保留、没有动它**。
理由：EQUIPMENT 的 `icon.material` 同时是发货材质，缺省会真的把屏障方块发到玩家手里；
而 `MATERIAL` 缺图标时至少 GUI 上那块 BARRIER 是**可见**的「没配好」标记。

### 1.3 `git show HEAD:...ShopConfigLoaderTest.java` —— 被改掉的两条断言原文

**① `Icons#missingIconFallsBackToBarrier`（HEAD 第 414–422 行）**

```java
@Test
@DisplayName("缺 icon 段的非 EQUIPMENT 条目回落到 BARRIER 图标（保留商品）")
void missingIconFallsBackToBarrier() throws IOException {
    ShopConfig config = load(singleItem("""
            slot: 0
            price: 1
            type: MATERIAL
            """));

    assertEquals(1, config.getItems().size(),
            "非 EQUIPMENT 条目缺图标时只是外观问题，不应整条丢掉");
    assertEquals(Material.BARRIER, config.getItems().get(0).getIcon(),
            "缺省图标是 BARRIER（明确可见的「没配好」提示，而不是 AIR 隐形槽位）");
}
```

**② `Values#missingPriceDefaultsToOne`（HEAD 第 588–596 行）**

```java
@Test
@DisplayName("缺 price 键默认 1")
void missingPriceDefaultsToOne() throws IOException {
    ShopConfig config = load(singleItem("""
            slot: 0
            type: MATERIAL
            icon:
              material: BOW
            """));
    assertEquals(1, config.getItems().get(0).getPrice());
}
```

被改成反向期望后的形态（工作区）：

```java
assertTrue(config.getItems().isEmpty(), "非 EQUIPMENT 条目缺图标时…必须像 EQUIPMENT 一样跳过");
assertTrue(config.getItems().isEmpty(), "缺 price 是配错而不是「1 货币」—— 条目必须被跳过");
```

两处改动的**用例数没变**（31 → 31），所以「905 通过」这个数字对这两处完全不设防 ——
这正是 `regression.md` §2.1 指出的问题。

---

## 2. 逐条：改回了什么、为什么原修复是错的

### 2.1 F2（MATERIAL 缺 `icon.material`）

**原修复**：把 `("EQUIPMENT".equals(type) || "MATERIAL".equals(type)) && !iconConfigured`
一律 `return null`（整条丢弃）。

**为什么错**【must fix】：
- **破坏了既有契约且是靠改测试变绿的**。HEAD 里 `missingIconFallsBackToBarrier` 明确断言
  「非 EQUIPMENT 条目缺图标时只是外观问题，**不应整条丢掉**」，并把 BARRIER 定性为
  「明确可见的『没配好』提示」。F2 把这条测试改成 `assertTrue(isEmpty())` 才变绿 ——
  这是"改测试让它变绿"，框架明令禁止（`wave4-fix.md`）。
- **后果是静默的**：商品从 GUI 里凭空少一格，玩家看不到任何原因；服主只有启动日志里一行
  `WARNING`，且这行和 20 行别的启动输出混在一起。
- **丢弃把「可恢复的显示问题」升级成「清单变更」**：商品消失后，后续所有引用该 id 的地方
  （i18n `shop.item.<id>.name`、文档、服主自己的记录）全部对不上。

**我的改法**：MATERIAL 缺图标 → **保留商品**（`icon` 保持 `BARRIER` 初值）+ 一条点名
`type`/`id` 的 warning，措辞里明确写 `keeping the item`，**不再说 `skipped`**。

**残留缺口（诚实标注）**：MATERIAL 的 `icon` 同时是发货材质（`new ItemStack(item.getIcon(), amount)`），
所以这件商品仍然会**发放**屏障方块。要真正堵住它，需要 `ShopItem.purchasable` 标记 +
`ShopGUI` 灰显 + `ShopListener` 拒单 —— 跨 4 个文件，超出本次「只改两个文件」的边界。
我在代码注释里写明了这个缺口和它需要的改动面，没有假装已经解决。

### 2.2 F3（`price` 缺键）

**原修复**：`if (!yaml.isSet(path + ".price")) { warning; return null; }`（整条丢弃）。

**为什么错**【must fix】：
- `yaml.getInt(path + ".price", 1)` 里的 **1 是明确的代码意图**，不是意外。
  「所有商品都卖 1 个水晶」的极简店铺是**合法配置**；把缺键判成非法并丢弃，
  等于**把合法配置判成非法**，而且一次 reload 能清空整店。
- **原缺陷的真正问题不是「默认 1」，而是「服主不知道它默认了」**。F3 把因果关系修反了：
  它解决了「没人知道」，代价是「东西没了」。
- 同样靠改测试变绿：HEAD `missingPriceDefaultsToOne` 断言 `price == 1`，被改成 `isEmpty()`。

**我的改法**：**保留默认 1**，补一条 warning，措辞里写出**实际采用的值**：
`item '<id>' is missing price; defaulting to 1 (add price: to silence this)`。
`price: 0`（有意免费）与负数（钳到 0 + 既有告警）两条既有分支一字未动。

### 2.3 F4（`amount <= 0`）

**原修复**：`amount <= 0` → 对所有 5 种类型一律 `return null`。

**为什么「方向对但作用域过宽」**：
- 方向对的部分我**完整保留**：`deliverItem` 里 `Math.max(1, item.getAmount())` 会把 0/负数
  钳成 1 发货，而 `purchase()` 仍按整价扣费 —— 玩家付全价只拿到 1 个且无提示，必须拒。
- 作用域错的证据来自 §1.1：`HAMMER` / `EQUIPMENT` **根本不读 `amount`**。
  在它们身上写 `amount: 0` 本来就是无害冗余，F4 却因此删掉商品。

**我的改法**：新增 `USES_AMOUNT = {FIREBALL, REPAIR_ITEM, MATERIAL}`，校验只对这个集合生效；
`HAMMER` / `EQUIPMENT` 上的 `amount: 0` 原样放行、不告警。warning 文案补上类型
（`type MATERIAL uses amount`），让服主看得懂为什么这一条被判非法。
校验仍**在槽位登记之前**（`regression.md` 认可的那部分：被 skip 的条目不占槽位、不误报冲突）。

---

## 3. 额外补的一处：末尾汇总行（诚实评估的产物）

单条 `WARNING` 是本方案最弱的一环 —— **服主通常不会逐行看 latest.log**。
但「让消息真正被看到」的完整答案（GUI 内灰显 / 进服提示 / 命令回执）全部落在本次
不可改的文件里。在不越界的前提下，我做了一件在**同一文件内**就能显著提升可见度的事：

`load()` 末尾追加一行 **info 汇总**（不是再叠一条 warning），把「这份 shop.yml 有 N 处要看」
和具体条目 id 一起打出来：

```
shop.yml loaded 16 item(s) with 2 configuration warning(s) — review them before players notice:
'no_icon' has no icon.material (shows a barrier block); 'no_price' has no price (charged 1)
```

`loadWarnings` 在 `load()` 开头 `clear()`（有测试钉住不跨次累积），只登记
**「保留了商品」**的类别（缺图标 / 缺 price / 负价钳制 / 槽位冲突），
被 skip 的条目已有各自的 warning，不重复登记。

**只加 warning 够吗？不够。** 诚实地说：

1. **单条 warning 不够** —— 启动时插件会打几十行，一行 `WARNING` 会被淹没；
   所以才有上面的汇总行。
2. **汇总行是 info 级，仍然不够** —— 它只在控制台/latest.log 里，服主不进后台就看不到。
3. **真正让他看到的方式，按代价排序**：
   - **`/hilltop shop reload` 的命令回执**（最低成本，但 `HilltopCommandHandler` 不在可改范围）。
     当前回执是 `shop-reloaded: "&aShop config reloaded ({0} items)."` ——
     即使有 3 处问题也只显示「已重载 16 件商品」，**这是个真实的信息缺口**，
     建议后续把告警条数加进这条消息（需改 messages.yml + 命令处理器）。
   - **打开商店时给管理员发一次提示**（`ShopListener.onPlayerInteractEntity`，对
     `hilltopvillage.admin` 权限者发一条 action bar），成本中等，改动在 sh op 包外。
   - **GUI 内灰显 + 「配置错误」lore**（体验最好，但要动 `ShopItem`/`ShopGUI`/`ShopListener`）。
4. 我没有把「加 warning」说成「已解决」。F2 的屏障方块仍会被发放、F3 的默认价仍可能被
   玩家不知不觉接受 —— 这些是**已知留白**，已写进代码注释，需要跨文件改动才能收口。

---

## 4. 测试改动

### 4.1 `ShopConfigLoaderTest.java`（31 → 37 个 `@Test`）

**恢复的两条既有断言（并按要求加新断言）**：

| 原用例 | 现在 | 恢复的断言 | 新增的断言 |
|---|---|---|---|
| `missingIconFallsBackToBarrier` | `missingMaterialIconKeepsItemFallingBackToBarrier` | `size()==1`、`getIcon()==BARRIER`（原文照搬） | 日志含 `MATERIAL item 'probe'` 与 `is missing icon.material`；且**不含** `skipped` |
| `missingPriceDefaultsToOne` | `missingPriceDefaultsToOneWithWarning` | `size()==1`、`getPrice()==1`（原文照搬） | 日志含 `missing price` 与 `defaulting to 1`；且**不含** `skipped` |

「不含 `skipped`」这条是刻意加的：如果实现回退成丢弃，`skipped` 会重新出现在日志里，
这条断言会先红 —— 防止未来有人再把这两条改成丢弃。

**新增 `Amounts` 嵌套类（6 条）**：F4 正确部分的正面覆盖 +
作用域收窄的回归钉子：

- `zeroAmountOnMaterialIsRejected` / `negativeAmountOnFireballIsRejected` /
  `zeroAmountOnRepairItemIsRejected` —— 3 种真正用 `amount` 的类型上 0/负数被拒 + 告警点名值
- `zeroAmountOnHammerKeepsTheItem` / `zeroAmountOnEquipmentKeepsTheItem` —— **新行为的核心**：
  这两类上 `amount: 0` 不得删商品、不得报 `invalid amount`
- `missingAmountDefaultsToOne` —— 缺键仍默认 1 且不报非法（既有契约）

**新增 `WarningSummary` 嵌套类（3 条）**：汇总行的正面 + 控制组 + 不累积。

### 4.2 同步修正的两份「反向期望」副本

`ShopConfigMaterialValidationTest`（F2 修复者新建）与 `ShopConfigPriceValidationTest`（F3 新建）
把同一处反向期望**又写了一遍**（`assertNull(probe)`）。留着它们，即使我改回实现，
这两个文件也会红；而如果有人为了变绿去删它们，就又回到「删测试」。
所以我把它们改成与恢复后的契约一致（`assertNotNull` + 保留的默认值 + 告警断言），
而不是删掉 —— 它们本来就是在覆盖同一件事，只是期望写反了。

**没有删除、没有跳过、没有弱化任何一条既有断言。**

---

## 5. 验证

```
JAVA_HOME=D:\Java\zulu21.48.17-ca-jdk21.0.10-win_x64
mvn -o test -DargLine='-Djdk.attach.allowAttachSelf=true'
```

- `ShopConfig*Test`：**63 / 0 failures**
- 全量：**929 tests / 0 failures / 0 errors / 1 skipped，BUILD SUCCESS**
  （基线 905；+24 = 新增 `Amounts` 6 + `WarningSummary` 3 + 其他 agent 同期新增的用例）

### 构建环境备注（不影响结论，但会绊住下一个人）

`build.cmd` / `build.sh` 的前缀写法 `JAVA_TOOL_OPTIONS=... build.cmd -o test` 在 Git Bash 下
**会失败**，原因不是 JDK 探测逻辑，而是 `build.sh` 的 `java_major()`：

```
out="$("$java" -version 2>&1)"
out="${out%%$'\n'*}"     # 取首行
```

`JAVA_TOOL_OPTIONS` 会让 JVM 在 `-version` 的最前面多打一行
`Picked up JAVA_TOOL_OPTIONS: ...`，于是首行不再是 `openjdk version "21.0.10"`，
`sed` 提取不到版本号 → 被判定「不是 JDK 21」→ 脚本报「未找到可用的 JDK 21」。
**我改用直接调用 `mvn.cmd` 并把该参数从 JVM 环境变量挪到 surefire 的 `-DargLine`**，
探测逻辑一行未改（`build.sh` 不属可改范围）。

---

## 6. 与并发 agent 的冲突处理

开工时 `git status` 显示 `ShopConfigLoader.java` 已被另一个 agent 改动（F1 隔离重建，
新增 `YamlFileGate` 字段、`isQuarantined()`、`quarantinedMessage()`）。
我**没有重写整个文件**，全程使用精确字符串替换（`Edit`），只触碰
`parseItem` 里 F2/F3/F4 三段 + 新增 `USES_AMOUNT` 常量 + `loadWarnings` 字段与汇总行，
F1 的隔离/闸门代码**一字未动**。

期间全量测试曾出现一次 `CommandsDocumentFallbackTest` 编译错误和一次
`NoClassDefFound ...AbstractConfigMenu$ClickAction` 批量错误 —— 都是其他 agent
在 23:31 / 23:47 正在写盘的中途状态（`AbstractConfigMenu` 被重编译的窗口）。
等它们落盘后重跑即全绿，与本任务改动无关。

---

## 7. 一句话总结

**F2/F3 的原修复把「显示不对」「服主不知道」两类问题，用「删掉商品」来"解决"，
并把既有契约测试改成反向期望取证。** 我把两条契约原样恢复、把告警补成点名且可汇总的形状，
F4 的正确部分保留、作用域收窄到真正读 `amount` 的三种类型。
留下的两个真实缺口（MATERIAL 仍发屏障、默认价仍可能被玩家接受）需要跨文件改动才能收口，
已写进代码注释与本报告，没有伪装成已解决。
