# 评审 F5：购买成功消息数量（`purchasedAmount`）

评审对象：`<TARGET_REPO>`
文件：`src/main/java/com/hilltopvillage/shop/ShopListener.java`（未提交 diff，+3/−1）
方法：只读。Paper 1.21.4 行为以 `<TARGET_PARENT>/Hilltop Village/versions/1.21.4/paper-1.21.4.jar`
反编译（`javap -p -c`）为证，不引二手文档。

---

## 结论

**正确** —— 但只对了一半，而且**修的不是这条链上最值钱的东西**。

- 根因**属实**：`CraftInventory#addItem` 确实原地改写入参 `ItemStack`（字节码已逐条核对，见 1.2）。
- 作用域/编译**无误**：编译产物 `istore 5` → `iload 5` 与源码一致，无未赋值分支（见 3）。
- 溢出处理**不是**「丢弃」：余量会 `dropItemNaturally` 落地并打 `PAID_DROP_KEY`。所以委托里预设的
  「第 2 点成立 = 修错地方」**不成立**，必须如实否掉（见 2.1）。
- 但**修复者对自己根因的描述指错了形态**，且新增测试**只覆盖了指错的那一半**。真正最伤玩家的形态
  （`overflow` 为空、无任何"背包已满"提示、消息却少报）没有测试钉住（见 1.3 / 5.2）。
- 另有一条**同一代码路径上真实会丢货**的缺陷（`PAID_DROP_KEY` 被原版并物事件吃掉），F5 完全没碰（见 2.3）。

---

## 1. 根因是否理解对了

### 1.1 修复本体

`src/main/java/com/hilltopvillage/shop/ShopListener.java:151-166`：

```java
151        // 背包投递：满则溢出部分掉在脚下
152        // F5：必须先记下购买量——Paper 的 CraftInventory#addItem 在并入半满叠时会原地
153        // 修改传入的 product，把它的数量改成没放进去的余量，之后再读就只能读到余量。
154        int purchasedAmount = product.getAmount();
155        java.util.Map<Integer, ItemStack> overflow = player.getInventory().addItem(product);
...
164        player.sendMessage(lang.getFor(player, "shop.purchase-success",
165                resolveItemName(player, item), String.valueOf(purchasedAmount),
166                String.valueOf(item.getPrice())));
```

### 1.2 它真的会原地修改吗 —— 会，已用字节码钉死

`org/bukkit/craftbukkit/inventory/CraftInventory#addItem`（`paper-1.21.4.jar`，`javap -c`）反编译节选。
先看 `firstPartial` 命中后的合并分支：

```
160: aload_0
161: iload         5
163: invokevirtual #234   // getItem:(I)Lorg/bukkit/inventory/ItemStack;
166: astore        6                              // existing = getItem(index)
168: aload         4
170: invokevirtual #166   // ItemStack.getAmount:()I
173: istore        7                              // itemAmount
175: aload         6
177: invokevirtual #166   // ItemStack.getAmount:()I
180: istore        8                              // existingAmount
...
182: aload_0
185: invokevirtual #214   // getMaxItemStack
188: istore        9                              // maxStack
190: iload         7
192: iload         8
194: iadd
195: iload         9
197: if_icmpgt     221                            // itemAmount + existingAmount > maxStack ?
...
221: aload         6
223: iload         9
225: invokevirtual #232   // ItemStack.setAmount (existing 填到 max)
...
236: aload         4
238: iload         7
240: iload         8
242: iadd
243: iload         9
245: isub
246: invokevirtual #232   // ItemStack.setAmount(itemAmount + existingAmount - maxStack)
249: goto          50                             // 回到 firstPartial，用减小后的 item 继续试
```

`236-246` 就是对 **`aload 4`（= 调用方传入的那个 `ItemStack`）** 调 `setAmount(...)`：
`product` 被改成「本次没并进去的余量」。空槽分支同样会改：

```
130: aload         4
132: aload         4
134: invokevirtual #166   // ItemStack.getAmount:()I
137: iload         7
139: isub
140: invokevirtual #232   // ItemStack.setAmount(itemAmount - maxStack)
```

**根因判断正确。** 修复不是「无害但无用」，是把一个真实存在的读后写脏值挡掉了。

### 1.3 但注释把触发形态说窄了 —— 真正最坏形态是 `overflow` 为空

`ShopListener.java:152-153` 写的是「把它的数量改成**没放进去的余量**」，语义上把缺陷绑到了「有溢出/掉落」上。
实际按上面的字节码，`249: goto 50` 之后会**再走一遍循环**：

- 若此时 `firstPartial` 返回 `-1` 且 `firstEmpty` 命中（背包还有空槽）→ `146-154`：`setItem(空槽, item)`，
  然后 `goto 252` 取下一个入参数组元素。**`item` 的数量没有被清零，仍是余量**，而此时 `overflow` 是空的。

也就是说存在这样一个形态：**买 8 支箭，槽 0 已有 60 支、背包另有空槽** →
4 支并入槽 0（60→64），`product` 被改成 4，剩下 4 支放进空槽。**一件都没掉地，`overflow` 为空，
不会发 `shop.inventory-full`**，而旧代码的成功消息读 `product.getAmount()` = **4**。

玩家实收 8，屏幕上只有一句 "Purchased! arrow x4"，**没有任何补偿提示**。这比注释里描述的
「4 进包 + 4 落地 + 还有一句背包已满」还要糟——那个形态至少玩家能自己拼出 8。

修复本身对两种形态都成立（在 `addItem` 之前取值），但**注释与新增测试都只认「有溢出」那一种**，
把最容易发生在正常玩家身上的形态漏在了测试之外（见 5.2）。

### 1.4 一个不该被忽略的边界：`purchasedAmount` 读的是「发货量」而非「配置量」

`ShopManager.java:123-143`：

```java
123    public ItemStack deliverItem(ShopItem item) {
125        int amount = Math.max(1, item.getAmount());
127        switch (item.getType()) {
128            case "HAMMER":
129                return plugin.getHammerListener().createHammer();      // 固定 1
131            case "FIREBALL":
132                return plugin.getFireballListener().createFireball().asQuantity(amount);
133            case "REPAIR_ITEM":
134                return plugin.getNodeListener().createRepairItem(amount);
135            case "MATERIAL":
136                return new ItemStack(item.getIcon(), amount);
137            case "EQUIPMENT":
138                return createEquipment(item);                            // 固定 1
```

`purchasedAmount = product.getAmount()` 因此是**实际发货量**：HAMMER/EQUIPMENT 恒为 1，
即使 `shop.yml` 给它们写了 `amount: 8` 也报 1。这是**对的**——报的是玩家真正拿到的东西。
反过来说，如果修复者改用 `item.getAmount()` 就会在 HAMMER 上报错。当前写法在这点上占优，
应保留。

---

## 2. 钱和货对不上（委托里预设的最严重问题）

### 2.1 结论：余量**没有**被丢弃，第 2 点不成立

`ShopListener.java:156-162`：

```java
156        if (!overflow.isEmpty()) {
157            for (ItemStack leftover : overflow.values()) {
158                player.getWorld().dropItemNaturally(player.getLocation(), leftover)
159                        .getPersistentDataContainer().set(PAID_DROP_KEY, PersistentDataType.BYTE, (byte) 1);
160            }
161            player.sendMessage(lang.getFor(player, "shop.inventory-full"));
162        }
```

余量逐件落地、逐件打 `PAID_DROP_KEY`（`ShopListener.java:39-40`），
竞技场重置清理掉落物时按该标记放行（`ArenaInstance.java:1502-1508`）：

```java
1502        for (org.bukkit.entity.Item item : world.getEntitiesByClass(org.bukkit.entity.Item.class)) {
1503            // 跳过已付对价的商店掉落（ShopListener#PAID_DROP_KEY），避免「付了钱拿不到货」
1504            if (item.getPersistentDataContainer().has(
1505                    com.hilltopvillage.shop.ShopListener.PAID_DROP_KEY,
1506                    org.bukkit.persistence.PersistentDataType.BYTE)) {
1507                continue;
1508            }
```

`ShopOverflowPartialFitTest.java:226-252` 已经钉住「部分容纳：包内 64 + 地上 4 = 68」的账目守恒。
**所以「付了 5 个的钱只装下 3 个、剩 2 个被吞」这个假设不成立，F5 不是「修错了地方」。**

### 2.2 但消息侧仍有一处真实的信息缺口（F5 没修）

`shop.inventory-full`（`src/main/resources/messages.yml:1822`）**不带任何占位符**：

```yaml
shop.inventory-full: "&e背包已满，物品掉落在你脚下"
```

配合修复后的 `shop.purchase-success`（`messages.yml:1820`）：

```yaml
shop.purchase-success: "&a购买成功！&f{0} &ax{1} &7（消耗 {2} 能量水晶）"
```

玩家在「4 进包 + 4 落地」时看到的是「购买成功 箭 x8」+「背包已满，物品掉落在你脚下」。
**总账对得上，但没有任何一处告诉玩家「有几件在包里、有几件在地上」。** 修复把总数从错的（4）
改成对的（8），却没有把"分割"这件事表达出来——玩家看到 x8 会以为 8 件都在背包里，
找不到地上的 4 件时仍会认为丢货。

这是**本条链上仍然存在的、未被修复的一半**，而且不是理论问题：出厂模板 `shop.yml:49-58`
的 `arrow` 就是 `amount: 8`，箭是最容易在背包里存在半满叠的消耗品。

### 2.3 同一路径上**真正会丢货**的缺陷：`PAID_DROP_KEY` 会被原版并物事件抹掉

这是本次评审在 F5 邻域找到的实质缺陷，F5 完全没碰。

`PAID_DROP_KEY` 打在 **Item 实体**的 PDC 上（`ShopListener.java:159`）。原版
`net.minecraft.world.entity.item.ItemEntity#mergeWithNeighbours/tryToMerge/merge`
（`paper-1.21.4.jar`）在合并时是「保留 `this` 的栈、`copyWithCount` 重建、把 `other` 的栈 shrink 后
`discard`」：

```
797  private static void merge(ItemEntity, ItemStack, ItemStack);
802:  invokestatic #642   // ItemStack.merge(stack, stack, 64)
809  private static void merge(ItemEntity this, ItemStack thisStack, ItemEntity other, ItemStack otherStack);
809-819: merge(this, thisStack, otherStack, 64) → this.setItem(merged)
...
845:  aload_2
846:  getstatic #655   // EntityRemoveEvent$Cause.MERGE
847:  invokevirtual #281 // discard
```

`copyWithCount` 拷贝的是 **`this` 那份栈的 components**。因此：

- 若**已付款的掉落物**是 `this` → 标记保留，安全；
- 若**普通掉落物**是 `this`、已付款的是 `other` → 合并后存活实体只带**普通栈**（无 PDC），
  已付款那份被 `discard`。**货还在世界里，但标记没了** → 下次 `clearDroppedItems()`
  （`ArenaInstance.java:1509` `item.remove()`）把它当普通掉落物删掉 → **玩家付了钱，货真没了**。

哪一方是 `this` 取决于同一 tick 内谁先 `tick()`，以及 0.5 格半径内是否存在同材质普通掉落物。
竞技场商店附近有怪物掉落/玩家丢弃物时可达。这不是 F5 引入的，但 F5 的溢出落地正是
`PAID_DROP_KEY` 的**唯一生产点**（`ShopListener.java:159` 与 `:197`），
只修消息、不修「标记能否活过并物」，是把风险留在了原地。

**建议**（最小改动，不动并物逻辑）：给落地物设一个短窗口的 `setPickupDelay` 的同时，
在 `ItemSpawnEvent` 侧把标记重新盖一次；或更简单——不要让付过钱的货以实体形式存在：
背包满时直接拒绝购买（`if (!overflow.isEmpty()) { refundCurrency(...); return; }`），
把「钱货分离」这个状态从根上消掉。

---

## 3. `purchasedAmount` 的作用域

**没问题。**

- 赋值点 `ShopListener.java:154`，使用点 `:165`，同一方法同一块，中间无重赋值。
- 三条提前返回（`:121` 余额不足、`:130` 扣款失败、`:143`/`:148` 退款）**全部在 `:154` 之前**，
  不存在「进入使用点但未赋值」的路径。
- 编译产物已核对（`target/classes/.../ShopListener.class`，`javap -c`）：

```
190: aload         4
192: invokevirtual #249   // ItemStack.getAmount:()I
195: istore        5       // purchasedAmount
...
347: iconst_1
348: iload         5
350: invokestatic  #101   // String.valueOf(I)
353: aastore
```

`istore 5` 在 `addItem`（`invokeinterface #257`，偏移 212）**之前**，消息里用的是 `iload 5`。
与源码语义一致，没有读回 `product`。

- `product` 的 null 检查在 `:145-149`，早于 `:154`，不会 NPE。

---

## 4. 多物品购买 / `product` 是否复用

**不复用。**

`onInventoryClick`（`ShopListener.java:84-104`）每次点击只取**一个** `ShopItem`
（`:94 ShopItem item = gui.getItemAt(event.getSlot());`），然后 `:103 purchase(player, item);`。
`purchase` 里 `:133 ItemStack product;` 是**方法局部变量**，每次调用新建，
`:135 product = shopManager.deliverItem(item);` 每次重新构造。

各工厂也都返回新实例，无跨调用共享模板：

- `ShopManager.java:136` `return new ItemStack(item.getIcon(), amount);`
- `ShopManager.java:156` `ItemStack equipment = new ItemStack(item.getIcon(), 1);`
- `FireballListener.java:172-173` `public ItemStack createFireball() { ... new ItemStack(cfg.getFireballMaterial()); }`
- `NodeListener.java:306-307` `public ItemStack createRepairItem(int amount) { ItemStack item = new ItemStack(repairItemMaterial(), amount); ... }`
- `HammerListener.java:128-129` `private ItemStack createVanillaHammer(...) { ItemStack hammer = new ItemStack(cfg.getHammerMaterial()); ... }`

**唯一例外，值得记一笔**：`HammerListener.java:138-152` 的 `createItemsAdderItem()` 走反射拿
`CustomStack#getItemStack()`。若 ItemsAdder 返回的是它内部的共享模板实例，
`addItem` 的原地 `setAmount` 会**永久污染该模板**，后续每次 `createHammer()` 拿到的数量都已被改过；
而 F5 的 `purchasedAmount` 也是在污染之后才读，同样救不了。这不在 F5 的责任范围，
但说明「`addItem` 会改入参」这件事的影响面比 F5 注释写的更广，值得单列一条残余风险。

另外 `:97-101` 的 250ms 冷却 + `event.setCancelled(true)`（`:87`）挡住了同 tick 连点，
不存在「一次点击结算两单、`product` 被复用」的现实路径。

---

## 5. 测试

### 5.1 它确实 mock 了一个会修改 `ItemStack` 的 `addItem` —— 这点做得对

`src/test/java/com/hilltopvillage/shop/ShopListenerPurchaseMessageTest.java:66-81`：

```java
66        PlayerInventory bag = proxy(PlayerInventory.class, (proxy, method, args) -> {
67            if ("addItem".equals(method.getName())) {
68                ItemStack[] passed = (ItemStack[]) args[0];
69                assertEquals(1, passed.length, "夹具前提：purchase 每次只投递一个 ItemStack");
70                ItemStack stack = passed[0];
71                assertEquals(PURCHASED_AMOUNT, stack.getAmount(),
72                        "夹具前提：addItem 收到的是完整购买量 " + PURCHASED_AMOUNT);
73                // Paper 1.21.4 CraftInventory#addItem 的原地修改：把传入 stack 的数量改成余量，
74                // 并把该余量放进 overflow（4 支落地）。这是本用例显式复刻的目标语义。
75                stack.setAmount(POST_MERGE_REMAINDER);
76                Map<Integer, ItemStack> overflow = new LinkedHashMap<>();
77                overflow.put(0, stack);
78                return overflow;
```

不是「mock 成不修改」。桩显式 `stack.setAmount(4)` 并把它塞进 `overflow`，**忠实复刻了
1.2 里 `236-246` + `249 goto 50` 的最终效果**。这点比多数「只断言返回值」的测试强。

红测效力也有据：`.work/round1/f5-verify-mutation.log` 记录撤销修复后的真实失败——

```
[ERROR] ShopListenerPurchaseMessageTest.successMessageReportsPurchasedAmountNotPostMergeRemainder:164
  ... expected: <[8]> but was: <[4]>
```

### 5.2 三个实质缺陷（测试通过 ≠ 修复被证明）

**(a) 只覆盖「有溢出」形态，恰好漏掉最坏形态。**

用例是 `overflow` 非空（4 支落地）。而 1.3 证明的**更常见、更伤**的形态是
`overflow` 为空（4 支并进半满叠、4 支进空槽、一件不掉、不触发 `shop.inventory-full`），
旧代码在那里同样少报且**没有任何补偿提示**。该形态没有用例。
测试通过并不能推出「成功消息在整个可达空间内都正确」。

**(b) 「夹具自检」是同义反复，不能作为 Paper 行为的证据。**

`ShopListenerPurchaseMessageTest.java:158-160`：

```java
158        assertEquals(POST_MERGE_REMAINDER, product.getAmount(),
159                "夹具自检：模拟的 Paper addItem 应把传入 product 改成余量 "
160                        + POST_MERGE_REMAINDER + "，否则本用例没有复现缺陷形态");
```

这句断言的是**自己刚写下的桩**（`:75`）有没有生效，与 Paper 是否真的这样无逻辑关联。
把它当作「复现了真实缺陷形态」的凭证是循环论证。真实情形的证明只能是 1.2 的反编译——
我在本次评审中独立做了，结论支持该桩；但**测试本身不提供这个保证**，
若哪天 Paper 改成不改入参，这条自检仍会绿。

**(c) 没有断言「包内 + 地上 = 消息数量」这一真正的不变式。**

用例只断言消息参数是 `8`（`:164`），并在 `:158` 顺带确认 `product` 被改成 4，
但**没有**把「进包 4 / 落地 4 / 合计 8」串起来断言。
`ShopOverflowPartialFitTest.java:249-250` 有这类守恒断言：

```java
249            assertEquals(68, countInBag(player, Material.ARROW) + remainder.getItemStack().getAmount(),
250                    "账目守恒：包内 64 + 地上 4 必须等于 60 + 8 = 68");
```

但那是**另一个类**，且它走 MockBukkit 的 `addItem`（不模拟原地改写），
两条证据各自成立、合起来没有交集。F5 缺少「改写入参的 addItem」+「账目守恒」同时成立的那一条。

**(d) 附带**：`getLocation()` 桩返回 `null`（`:100-102`），真实 Paper 的
`dropItemNaturally(null, ...)` 会 NPE（`CraftWorld#dropItemNaturally` 首行即
`Preconditions.checkArgument(Location cannot be null)`）。桩忽略坐标使其无碍，
但也意味着该用例无法发现「落地调用传了坏坐标」这类回归。

### 5.3 邻接测试 `ShopOverflowPartialFitTest` 的夹具前提与真实 Paper 不符

这条不属于 F5 本体，但 F5 的「溢出已被妥善处理」这个结论部分依赖该类的绿色，
而其夹具前提与生产环境不一致，值得记一笔（不影响 F5 结论的正确性——余量落地、
打标、放行这三件事我已在源码层独立核实）。

`ShopOverflowPartialFitTest.java:75-76, 172-177` 假设 `addItem` 会用 **41 格**
（36 主 + 4 甲 + 1 副）并据此 `fillAllFortyOneSlots()` 造「无空槽」。真实 Paper 不会：

- `CraftInventory#firstEmpty` / `firstPartial` 都只取 `getStorageContents()`
  （`firstPartial` 偏移 1 即 `invokevirtual #151 getStorageContents`；`firstEmpty` 同）；
- `CraftInventoryPlayer#getStorageContents` 走 `Inventory.items`
  （`invokevirtual #44 asCraftMirror(List)`，该 `NonNullList` 在
  `Inventory.<init>` 里 `bipush 36` 创建）。

**真实 Paper 的 `addItem` 只扫 36 格主背包，不碰护甲/副手槽。**
另一边 `ShopManager.java:186/193` 的 `countCurrency` 也是 `getStorageContents()`（36）+ 副手。
所以「副手放 79 个货币 → 扣 15 → 64 → 退款并不进」这类形态（该类 `:303-338`）在真实服务器上
根本不成立：副手不在 `addItem` 的扫描范围内，退款会直接落进主背包的空槽或落地，
而 MockBukkit 的 `getStorageContents()` 是 `Arrays.copyOfRange(getContents(), 0, 36)`
（`PlayerInventoryMock`）——两者对 36 的口径一致，但 MockBukkit 的 `addItem`
（`InventoryMock#addItem`，遍历 `this.items` 全部 41 格）把副手也算进去了。

**结论**：`ShopOverflowPartialFitTest` 的「41 格全占」场景在真实服上等价于
「36 格主背包全占、4 甲 + 1 副空着」——副手是空的，`addItem` 也看不见它，
所以「主背包真的满了」这个前提仍然成立，余量仍会落地。测试结论方向没错，
但它对「副手被当作可投递槽」的建模是错的，涉及副手的几条用例（`:303-338`）在真实 Paper 上
不会走到同一分支。这是既存问题，F5 不应为它负责，只是别把它的绿色当作 F5 的保证。

---

## 最重要的一条

**第 2 点（余量被丢弃）不成立** —— 余量确实落地、确实打标、竞技场重置确实放行
（`ShopListener.java:156-162`、`ArenaInstance.java:1502-1508`、`ShopOverflowPartialFitTest.java:226-252`）。
所以 F5 **不是**「只改消息、放着丢货不管」意义上的修错地方。

真正该指出来的是这两条：

1. **F5 的注释与测试把缺陷形态说窄了。** 最坏的形态不是「有溢出」，而是
   **`overflow` 为空、无任何提示、消息从 8 少报成 4**（1.3 字节码 `249 goto 50` → `146-154` 可证）。
   修复对两种形态都有效，但**只有「有溢出」那一种被测试钉住**，
   而没被钉住的那种恰恰是正常玩家最常遇到的。**补救成本极低**：
   在 `ShopListenerPurchaseMessageTest` 里把桩改成「返回空 `overflow`、但仍 `setAmount(4)`」加一条用例即可。

2. **消息修好了，但玩家仍然无法知道货分裂成了两份。** `shop.inventory-full` 没有数量占位符，
   玩家只看到「x8」+「背包已满」，无从得知 8 里有 4 件在地上。而且这条路径上的
   `PAID_DROP_KEY` 会被原版 `ItemMergeEvent` 抹掉（2.3 的 `merge` 字节码），
   抹掉后 `clearDroppedItems()` 会把它当普通掉落物删除 —— **那才是这一链上真正会"付了钱拿不到货"的地方**，
   比消息少报严重一个量级，F5 没有触及。

---

## 应该怎么修

按优先级。**注意 1 与 3 是二选一**：它们代表两种不同的产品决策（拒绝成交 vs 允许成交但说清楚），
不能都做。

1. **（最小、可立即做）堵住 `PAID_DROP_KEY` 的丢失路径。** 这是 2.3 描述的真实丢货缺陷，
   与 F5 的改动正交，但落在同一段代码上。做法：`dropItemNaturally` 之后不要只依赖实体 PDC，
   同时在**物品栈本身**上打标记（`ItemStack#editMeta` → `meta.getPersistentDataContainer()`），
   或监听 `ItemMergeEvent` 在合并结果上并集标记。物品栈上的 component 会随 `copyWithCount`
   一起保留，能活过原版并物。代价：需同步更新 `ShopOverflowPaidDropTest` 的判定口径
   （当前只读 `item.getPersistentDataContainer()`，见 `:137`）。

2. **（保持 F5 的正确部分）** `int purchasedAmount = product.getAmount();` 保留。
   它比 `item.getAmount()` 正确（HAMMER/EQUIPMENT 固定 1 的情形只有它能报对，见 1.4）。

3. **（若不愿拒绝成交：把消息说全）** 保留「溢出落地」的现有设计（这是 `PAID_DROP_KEY`
   一整套机制存在的前提，改成退款会推翻 `ShopOverflowPaidDropTest` / `ShopOverflowPartialFitTest`
   两个类的核心断言），改为把分割说清楚。`shop.inventory-full` 加数量占位符：
   ```yaml
   shop.inventory-full: "&e背包已满：&f{0} &e件在背包，&f{1} &e件掉在你脚下"
   ```
   在 `:161` 传入 `purchasedAmount - remainderAmount` 与 `remainderAmount`。
   另需注意：1.3 形态（`overflow` 为空、余量进了空槽）**不会**触发这条消息，
   所以这条消息只能覆盖「有溢出」的一半——真正保证消息与实物一致的是第 2 条那个变量，
   不是这条消息。

4. **（补测试，成本最低）** 在 `ShopListenerPurchaseMessageTest` 增加
   「`addItem` 改写入参但返回**空** `overflow`」的用例，断言消息仍为 8 ——
   这才是 1.3 描述的、当前完全无覆盖的最坏形态。
   同时把 `:158-160` 的「夹具自检」改写成独立读取 `ShopListener` 编译产物的断言，
   或直接删掉（它不证明 Paper 行为，只证明桩生效，容易误导后来者）。

5. **（可选，若要更彻底）** 消除「钱货分离」状态：`overflow` 非空时全额退款并收回已入包部分，
   让玩家整理背包后再买。收回需要 `addItem` 前的背包快照。这会改变既有产品语义
   （当前设计明确接受「掉落脚下」），必须同步改写两个 Overflow 测试类，不建议与 F5 一并做。
