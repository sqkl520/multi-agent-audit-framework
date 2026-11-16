# 红队评审：F2 / F3 / F4 三处修复

评审对象：`src/main/java/com/hilltopvillage/shop/ShopConfigLoader.java`（未提交 diff）
评审方式：只读。全部结论基于**实测**（JDK 21 + paper-api 1.21.4 + 真实 `YamlConfiguration` + MockBukkit 端到端跑真实 `ShopConfigLoader` / `ShopManager` / `ShopGUI`），不靠推测。

---

## 结论速览

| 修复 | 结论 | 一句话 |
|---|---|---|
| **F2**（MATERIAL 缺 icon → skip） | **有缺陷** | 修好了 `icon.material` 缺损，但漏掉了 `icon.material: AIR` —— 该值通过 `isItem()` 检查、在 GUI 里渲染成灰色占位板、却仍可点击购买，玩家付钱拿到 `AIR x0`，比 BARRIER 更隐蔽 |
| **F3**（price 缺键/null → skip） | **有缺陷（且题设假设不成立）** | **`isSet` 对显式 null 返回 `false`，修复确实生效**；但 `isSet` 之后仍用 `getInt(path, 1)`，`price: "15"` / `"abc"` / `true` / `[1]` / `{}` 全部 `isSet=true` 且落回 **price=1** —— 原来的 bug 换个类型原样复发；`price: 0.4` 与 `price: 2147483648` 变成**免费** |
| **F4**（amount ≤ 0 → skip） | **有缺陷（过度修复）** | 真的挡住了 `amount: 0/-5`，但对 `HAMMER` / `EQUIPMENT` 这两个**明确忽略 amount 的类型**也一律跳过（文档写着「HAMMER 固定 1，忽略」），属于把合法配置判死；同时 `amount: "8"` 仍静默变 1（原 bug 未修） |

**最重要的发现不是 `isSet` 无效（它有效），而是 F3 的修复层级错了：它检查的是「键存不存在」，而 bug 是「值的类型不对」。**

---

## F2：MATERIAL 缺 `icon.material` 时 skip

### 结论：**有缺陷**

### 攻击点验证结果

**修复本体是正确的。** 实测（真实 loader 端到端）：

| 配置 | 结果 |
|---|---|
| `type: MATERIAL`，无 `icon` 段 | SKIPPED ✅ |
| `type: MATERIAL`，`icon: {}` | SKIPPED ✅ |
| `type: MATERIAL`，`icon.material: ""` | SKIPPED ✅ |
| `type: MATERIAL`，`icon.material: BOW` | LOADED ✅ |

`ShopConfigLoader.java:174-178`：

```java
if (("EQUIPMENT".equals(type) || "MATERIAL".equals(type)) && !iconConfigured) {
    plugin.getLogger().warning("shop.yml: " + type + " item '" + id
            + "' is missing icon.material, skipped");
    return null;
}
```

**但是同一个洞换个值就重新打开：`icon.material: AIR`。**

`ShopConfigLoader.java:164` 的守卫是：

```java
if (parsed == null || !parsed.isItem()) {
    ... skip
}
```

实测 `Material.AIR.isItem() == true`，`Material.BARRIER.isItem() == true`（Paper 的 `isItem()` 实现是 `asItemType() != null`，AIR 有 item type）。所以 `icon.material: AIR` 完整通过 loader：

```
=== F2 hole: icon.material: AIR loads as a buyable item ===
loaded items = [air_trap@0 icon=AIR price=100]
deliverItem equivalent -> type=AIR amount=0
```

**这个漏洞的后果比 BARRIER 严重得多**，因为渲染端把 AIR 当「空槽」处理：

`ShopGUI.java:72-81`（`buildDisplayItem`）对 AIR 返回 `ItemStack{AIR x0}`，`getItemMeta()` 返回 `null`，直接 `return icon`（裸 AIR）。接着 `ShopGUI.java:109-122` 的 `fillEmpty()` 判定 `current == null || current.getType() == Material.AIR` → **用灰色玻璃板盖住这个槽**：

```
slot0 rendered = ItemStack{GRAY_STAINED_GLASS_PANE x 1, ... display-name=" "}
slot2 rendered = ItemStack{BOW x 1, ...}
getItemAt(0)  = air_trap        <-- 仍然是商品！
getItemAt(2)  = normal
```

即：**玩家看到的是一个灰色占位板（视觉上等同于「这里没东西」），但它被 `bySlot` 登记为商品 `air_trap`，点击会走完整购买流程。** `ShopGUI.java:108` 的注释明确写着占位符「不可点击购买，getItemAt 返回 null」—— 这个不变量被绕过了。

购买链的真实结果（`ShopManager.java:125` `Math.max(1, item.getAmount())` + `new ItemStack(AIR, 1)` → `AIR x0`）：

```
deliverItem(air_trap) = ItemStack{AIR x 0} type=AIR amount=0
addItem overflow = 0        <-- 无任何报错，也无任何获得
>>> 玩家付 100 水晶，收到 AIR x0，无退款（product != null 走不到 refundCurrency）
```

`ShopListener.java:145` 的退款分支只接 `product == null`；`AIR x0` 非 null，所以**不退款、不报错、还发一条「购买成功！air_trap x0（消耗 100 水晶）」**。

### 最严重的问题

**F2 只补上了「键缺失」，没补上「值无效」。** 声称解决的是「玩家付费后收到屏障方块」，但 `icon.material: AIR` 让玩家付费后收到**什么都没有**，而且连「屏障方块」这个可见的错误信号都没有 —— GUI 显示成普通空槽，退款链不触发，日志不告警。这是比原 bug 更隐蔽的同类 bug。

另外两处未被 F2 覆盖的相邻缺口（同一根因：`isItem()` 过宽）：
- `HAMMER` / `FIREBALL` / `REPAIR_ITEM` 缺 `icon` 仍回落 `BARRIER`（实测 LOADED，icon=BARRIER）。对这三类，icon 只是 GUI 图标、发货材质是硬编码的，所以危害较小 —— 但同一个 `BARRIER` 兜底值在不同 type 下的语义不一致，说明这个补丁是按 type 打补丁而不是按「icon 是否可用」打补丁。

---

## F3：price 缺键或 null 时 skip

### 结论：**有缺陷**

### 攻击点 1：`isSet` 语义 —— 题设假设**不成立**，修复**确实生效**

我反编译了 `paper-api-1.21.4` 的 `MemorySection.isSet`：

```
public boolean isSet(java.lang.String);
  ...
  11: aload_2  (root)
  12: invokeinterface Configuration.options()
  17: invokevirtual ConfigurationOptions.copyDefaults()
  20: ifeq 29                      // copyDefaults == false 时走下面
  23: aload_0; aload_1; invokevirtual contains(String)   // 分支 A
  29: aload_0; aload_1; aconst_null
  32: invokevirtual get(String, Object)                 // 分支 B
  35: ifnull 42
```

Bukkit 的 `YamlConfiguration` 默认 `copyDefaults == false`，所以走**分支 B：`get(path, null) != null`**。而 `MemorySection.get(String,Object)` 在最后一跳是 `map.get(key)` 拿 `SectionPathData`，为 null 直接返回默认值 —— 不是 `contains`。

实测（真实 `YamlConfiguration.loadConfiguration`，路径 `shop.items.probe.price`）：

| 写法 | `isSet` | `contains` | `get` | `getInt(...,1)` |
|---|---|---|---|---|
| 键缺失 | **false** | false | null | 1 |
| `price:`（空值） | **false** | false | null | 1 |
| `price: null` | **false** | false | null | 1 |
| `price: ~` | **false** | false | null | 1 |
| `price: ""` | **true** | true | `String:` | 1 |
| `price: 0` | true | true | `Integer:0` | 0 |
| `price: -5` | true | true | `Integer:-5` | -5 |

**结论：`isSet` 对显式 null 返回 `false`。** 这与题设的怀疑相反 —— F3 的 `!yaml.isSet(path + ".price")` 对「缺键」和「显式 null」都返回 true，两条路径都被 skip。测试 `ShopConfigPriceValidationTest.java:94-113`（`nullPriceIsSkipped`）也是绿的。

原因在 `YamlConfiguration.fromNodeTree`：null 值节点的 `construct()` 返回 null，随后 `ConfigurationSection.set(key, null)` 走 `MemorySection.set` 的 `map.remove(key)` 分支 —— **键被整个删除**，所以 `YamlConfiguration` 里根本不存在这个键。这也正是 `ShopConfigLoader.java:64-68` 的 F1 注释所描述的现象。

### 攻击点 4：`isSet` 之后仍 `getInt` —— **这是 F3 的真 bug**

`ShopConfigLoader.java:188-192` 只判存在性，然后 `ShopConfigLoader.java:224` 仍然：

```java
int price = yaml.getInt(path + ".price", 1);
```

`getInt(String,int)` 的反编译是：`get(path, Integer.valueOf(def))` → `instanceof Number ? NumberConversions.toInt(x) : def`。**非 Number 一律落回默认值 1（或 0，见 `MemorySection.getInt` 语义）**。

实测（复刻 F3 判定序：`isSet` 通过后再 `getInt(path,1)`）—— 这是端到端跑真实 loader 的结果，不是推测：

```
price: "abc"                 isSet=true  isInt=false  => LOADED price=1   ← 原 bug 原样复发
price: "15"                  isSet=true  isInt=false  => LOADED price=1   ← 服主以为卖 15，实收 1
price: ""                    isSet=true  isInt=false  => LOADED price=1
price: true                  isSet=true  isInt=false  => LOADED price=1
price: [1,2]                 isSet=true  isInt=false  => LOADED price=1
price: {}                    isSet=true  isInt=false  => LOADED price=1
price: {value: 15}           isSet=true  isInt=false  => LOADED price=1
price: 0.4                   isSet=true  isInt=false  => LOADED price=0   ← 免费
price: 0.9                   isSet=true  isInt=false  => LOADED price=0   ← 免费
price: 2147483648            isSet=true  isInt=false  => LOADED price=0   ← 免费（int 溢出）
price: 4294967296            isSet=true  isInt=false  => LOADED price=0   ← 免费
price: -2147483649           isSet=true  isInt=false  => LOADED price=2147483647  ← 天价
```

**`price: "15"` 是最要命的一条。** 服主从网页/文档复制带引号的 `price: "15"`，F3 的 `isSet` 检查一路绿灯（键存在、值非 null），`getInt` 落回默认 1。这跟修复前 `getInt(path,1)` 的行为**逐字节相同** —— F3 声称解决的「静默当作 1」，在字符串型价格上**完全没有被解决**。

而 `price: 0.4` / `2147483648` 这两条，比修复前的「按 1 计价」**更糟**：修复前它们至少还是 1（要收钱），现在 `getInt` 给出 0（或负数被 `ShopConfigLoader.java:228-232` 钳到 0），变成**免费商品**。攻击点 4 的猜测「比原来的按 1 计价更糟」在这里被证实了，只是触发值不是 `"abc"`（那条还是 1）而是小数和整数溢出。

### 攻击点 5 相关：数值溢出无任何防护

`price: 2147483648` → `NumberConversions.toInt` 回绕成 `-2147483648` → `ShopConfigLoader.java:228` 的 `price < 0` 分支把它钳到 0 并打一条「negative price」告警。告警文案说「clamped to 0 (free)」，但根因是溢出而非手写负数 —— 服主看到「negative price -2147483648」会一头雾水，因为文件里写的是正的 2147483648。

### 攻击点 3：告警可见性

`ShopConfigLoader.java` 每件商品最多打一条 `plugin.getLogger().warning(...)`。实测 20 件商品全缺 `icon.material` → **20 条独立 warning，无去重、无汇总**：

```
loaded items = 0
WARNING lines emitted = 20 (no dedup, no aggregate summary)
first line: shop.yml: MATERIAL item 'bad0' is missing icon.material, skipped
last  line: shop.yml: MATERIAL item 'bad19' is missing icon.material, skipped
```

且因为 `icon.material` 检查在 price 检查之前（`ShopConfigLoader.java:174` vs `188`），一件同时缺 icon 和缺 price 的商品**只会报 icon 那条**，price 的问题被完全吞掉：

```
=== 20 items missing BOTH price and icon: which warning wins? ===
warnings = 5 ; sample = shop.yml: MATERIAL item 'both0' is missing icon.material, skipped
```

服主按提示补上 icon，重启，才会看到下一批「missing price」。**逐个掩码，需要 N 轮修复才能把一份配错的文件修干净。**

`ShopManager.java:64` 只在 reload 末尾打一行 `Shop loaded N items`。当 N=0 时这行是 `Shop loaded 0 items` —— 与「服主主动清空商店」不可区分，没有「你刚才那份文件有 20 条被跳过」的汇总。

### 攻击点 2：跳过 vs 保留 —— 玩家/GUI 侧

**被 skip 的商品在 GUI 里完全不显示**（`ShopGUI.java:46` 只遍历 `cfg.getItems()`，跳过项不进 `bySlot`，槽位被 `fillEmpty()` 填成灰色玻璃板）。所以**不存在「显示但点击无反应」的更糟情况** —— 这一点 F3/F4 的取舍是对的。

但代价是**静默的**：玩家看到的是「这个位置是空的」，而不是「这里有个坏掉的商品」。对服主则是「商品凭空消失」，只有控制台那 20 条 warning 作证。`docs/guides/shop-customization.md` 没有任何地方说「缺 price 会被整条丢弃」，这是未文档化的破坏性行为变更。

### 最严重的问题

**F3 修的是「键存在性」，而 bug 是「值类型」。** `isSet` 语义没问题（题设假设不成立），但 `isSet` 这一层根本拦不住 `"15"` / `"abc"` / `0.4` / `2147483648` —— 它们全都 `isSet=true`。正确的判据是 `yaml.isInt(path)`（实测对上述全部返回 `false`，只对真正的 `Integer` 返回 `true`），或在 `isSet` 之后改用 `get(path)` + `instanceof Number` 显式校验。

现有测试没有一条覆盖这些：`grep "price: \"" src/test/java/.../shop/` 只命中一条**断言消息字符串**，无实际用例；也没有 `price: 0.4` / `price: 2147483648` / `price: true` 的用例。三个新测试文件（Price/Amount/Material）全部只测「键缺失 / null / 0 / 负数 / 正常值」这五种，恰好绕开了所有类型错配。

---

## F4：amount ≤ 0 时 skip

### 结论：**有缺陷（既漏又过）**

### 漏：`amount: "8"` 仍静默变 1，原 bug 未修

`ShopConfigLoader.java:194` 仍是 `yaml.getInt(path + ".amount", 1)`。实测端到端：

```
amount: "8" (string -> 1)   -> LOADED price=5 amount=1
```

服主写 `amount: "8"`（带引号，YAML 里是字符串），玩家付 5 只拿到 1 个。**这与 F4 声称要修的「发货阶段静默改为 1」是完全同一个症状**，只是触发条件从 `amount: 0` 换成了 `amount: "8"`。F4 的检查是 `amount <= 0`，字符串走 `getInt` 默认值 1 完美绕过。

`amount: 3.9` 会静默变成 3（`NumberConversions.toInt` 截断），也没告警。

### 过：对忽略 amount 的类型误杀

`deliverItem` 的 `switch`（`ShopManager.java:127-142`）里：

```java
case "HAMMER":
    return plugin.getHammerListener().createHammer();   // 不看 amount
case "EQUIPMENT":
    return createEquipment(item);                        // 不看 amount
```

`ShopItem.java:25` 注释也写明「HAMMER 固定 1，忽略此值；EQUIPMENT 亦固定 1」。出厂模板 `src/main/resources/shop.yml:23` 与 `docs/guides/shop-customization.md:44` 都写着 `amount: 1  # 一次购买给的数量（HAMMER 固定 1，忽略）`。

**但 F4 的 `amount <= 0` 检查在 type 分支之后、无 type 区分，对所有类型一视同仁。** 实测：

```
HAMMER amount:0        -> items=[]      ← 合法配置被判死
EQUIPMENT amount:0     -> items=[]      ← 合法配置被判死
HAMMER amount:-1       -> items=[]
HAMMER no amount       -> items=[x]     ← 只有省略 amount 才活
```

对 HAMMER/EQUIPMENT 来说，`amount` 是**死键**，写 0 与写 1 与不写，发货行为完全一致。F4 却因此把整条商品删掉。这违反 F4 自己的修复原则：「amount 为 0 会让发货被钳成 1、价格照扣」—— 对 HAMMER/EQUIPMENT 根本不成立，它们的发货量本来就不来自 amount。

对一个已经部署、`shop.yml` 里给 HAMMER 写了 `amount: 0`（完全无害）的服务器，这次升级会让那把锤子**从商店里消失**，且只留一条 `invalid amount 0` warning。这是回归。

### 攻击点 5：`amount = Integer.MAX_VALUE`

**不会 OOM，但会造成可见的荒诞结果。** 实测端到端（真实 `deliverItem` + `addItem` + `dropItemNaturally`）：

```
amount: 2147483647 (MAX)  -> LOADED price=5 amount=2147483647
deliverItem(huge) -> BOW x2147483647 in 15ms
purchasedAmount (message {1}) = 2147483647
dropped item entity stack = BOW x2147483606 (maxStack=1)
in inventory = 41 bows; price paid = 5
```

`ItemStack(Material, int)` 只校验 `amount > 0`，不校验上限（`ItemStack.of` 的 `Preconditions` 只有 `amount must be greater than 0`）。`addItem` 把 41 个塞进 54 格，余量 2147483606 **作为单个 ItemStack 掉在地上**。

三个后果：
1. **`dropItemNaturally` 掉落一个 `BOW x2147483606` 的实体**。vanilla 的 `Item` 实体 `count` 是 int，不溢出；但这一个实体被拾取/合并/序列化时是极端值。是否会让区块存档膨胀或客户端渲染异常，需要真服验证 —— **但至少 `chat` 里的 `BOW x2147483606` 已经是明确的服主误配信号，而 F4 恰恰宣称「非正数量必须在加载期挡住」**。
2. 花 5 水晶买 21 亿支箭，是**货币体系的直接崩塌**。价格上限与数量上限完全脱钩。
3. `createCurrencyItem` 那边有 `MAX_SHOP_GIVE = 6400` 的先例（`HilltopCommandHandler.java:99`，注释「防手滑输入天文数字刷爆背包 / 卡服」），说明本项目**已经承认**「配置里的数量需要上界」。F4 只在 `<= 0` 一侧设了闸，上界一侧完全敞开。

`amount: 4294967296`（2^32）会回绕成 0 从而被 F4 挡住 —— 这是**巧合**而非设计：溢出恰好落在被检查的那一侧。

### 最严重的问题

**F4 的判据选错了维度：它检查「加载期能观测到的值是否 ≤ 0」，但真正的缺陷是「加载期接受了一个无法安全发货的量」。** 下界（`"8"` → 1）没修，上界（`2147483647`）没管，中间还误伤了两个忽略 amount 的类型。

---

## 跨修复的系统性问题（三处共有的根因）

这三处修复有一个共同模式：**在 `parseItem` 里逐个 if 打补丁，而不是建立「这个字段的值是否可用」的统一校验层。** 具体表现：

1. **判定顺序制造掩码效应。** `type` → `icon` → `price` → `amount` → `slot`，先失败的先 return，后面的问题完全不可见。一件同时缺 icon / 缺 price / amount=0 的商品，服主要改三轮才知道全貌。

2. **`isSet` / `getInt` / `isItem` 三个 API 的语义都比它们看起来宽。** `isSet` 不管类型；`getInt` 静默回退；`isItem` 把 AIR 算作 item。三处修复各踩了一个，且都没有写注释记录这个陷阱。仓库里已有 `YamlNullMechanismTest.java` 这类「钉死 YamlConfiguration 怪癖」的先例，但**没有一个测试钉死 `isSet`/`getInt`/`isItem` 的这三条**。

3. **测试全部是「我以为的坏输入」。** `ShopConfigPriceValidationTest` / `ShopConfigAmountValidationTest` / `ShopConfigMaterialValidationTest` 三个文件共 12 个用例，覆盖的是 `缺键 / null / 0 / 负数 / 正常值`，恰好是**实现者已经想到的那几种**。没有一条测 `price: "15"`、`price: 0.4`、`amount: "8"`、`amount: 2147483647`、`icon.material: AIR`。这不是测试不足，是测试**照着实现写**（断言字符串都能和实现里的 warning 文案一一对应），所以三处缺陷全部漏网。

4. **`amount` / `price` 缺少上界，而项目里已有上界先例。** `MAX_SHOP_GIVE = 6400`（`HilltopCommandHandler.java:99`）就是为了防同一类事故。shop.yml 这条路径没有对应常量。

5. **「全部条目被跳过」= 空商店，且不触发 F1 的「拒绝用空配置替换线上商店」保护。** `ShopConfigLoader.java:56-61` 的 `IllegalStateException` 只在**文件不可解析**时抛；如果文件完全可解析、只是 20 件商品全被 F2/F3/F4 跳过，`load()` 正常返回一个 0 商品的 `ShopConfig`。`ShopManager.reload()`（`ShopManager.java:56`）无条件 `this.config = loader.load()`，于是线上商店被替换成空的。实测：

```
before reload: items=1
after  load : items=0   (load() returned normally; 无异常)
```

F1 的整个设计前提是「不得降级成空商店」（`ShopConfigLoader.java:47-48` 注释逐字如此），但 F2/F3/F4 三个 skip 分支恰恰是**制造空商店的主要途径**，且完全绕过了 F1 的哨兵。三处修复彼此孤立，谁也没看谁。

---

## 附：实测环境与可复现步骤

- JDK：`D:/Java/zulu21.48.17-ca-jdk21.0.10-win_x64`（项目 enforcer 要求 21）
- API：`paper-api-1.21.4-R0.1-SNAPSHOT`（与 `pom.xml` 一致）
- 测试宿主：`BareHost`（`src/test/java/com/hilltopvillage/testsupport/BareHost.java`），`onEnable()` 空实现
- 端到端探针：写 `shop.yml` 到临时 `dataFolder` → `new ShopConfigLoader(host).load()` → 直接检查返回的 `ShopConfig`；GUI 侧用反射注入 `ShopManager.config` 后构造真实 `ShopGUI`
- `isSet` 语义另有两条独立证据：① 反编译 `paper-api` 的 `MemorySection.isSet` / `get(String,Object)` / `SectionPathData`；② 独立 `YamlConfiguration` 单测表（见上文两张表）
- 关键源文件与行号：`ShopConfigLoader.java:159-200`（icon/price/amount 校验）、`:224`（`getInt` 默认 1）、`ShopGUI.java:72-81,108-122`（AIR→占位板）、`ShopManager.java:125,127-142`（`Math.max(1, amount)` 与忽略 amount 的 type）、`ShopListener.java:145-149`（退款只接 null）、`HilltopCommandHandler.java:99`（`MAX_SHOP_GIVE` 先例）
