# F5 — 已付对价掉落物标记迁移到 ItemStack

状态：**已完成编译，未 commit，未加测试。**

## 1. 四处改动逐字对照

### 1.1 `ShopListener.java` — 购买溢出（原 :157-160）

改前：
```java
            for (ItemStack leftover : overflow.values()) {
                player.getWorld().dropItemNaturally(player.getLocation(), leftover)
                        .getPersistentDataContainer().set(PAID_DROP_KEY, PersistentDataType.BYTE, (byte) 1);
            }
```
改后：
```java
            for (ItemStack leftover : overflow.values()) {
                dropPaidItem(player.getWorld(), player.getLocation(), leftover);
            }
```

### 1.2 `ShopListener.java` — 退款溢出（原 :195-198）

改前：
```java
                for (ItemStack leftover : refundOverflow.values()) {
                    player.getWorld().dropItemNaturally(player.getLocation(), leftover)
                            .getPersistentDataContainer().set(PAID_DROP_KEY, PersistentDataType.BYTE, (byte) 1);
                }
```
改后：
```java
                for (ItemStack leftover : refundOverflow.values()) {
                    dropPaidItem(player.getWorld(), player.getLocation(), leftover);
                }
```

### 1.3 `ShopListener.java` — 新增共用打标方法（两处赋值收敛到这里）

```java
    private static void dropPaidItem(org.bukkit.World world, org.bukkit.Location location, ItemStack stack) {
        ItemStack marked = stack.clone();
        org.bukkit.inventory.meta.ItemMeta meta = marked.getItemMeta();
        if (meta != null) {
            meta.getPersistentDataContainer().set(PAID_DROP_KEY, PersistentDataType.BYTE, (byte) 1);
            marked.setItemMeta(meta);
        }
        org.bukkit.entity.Item dropped = world.dropItemNaturally(location, marked);
        dropped.setItemStack(marked);
    }
```

### 1.4 `ArenaInstance.java` — 检查侧（`clearDroppedItems`，:1501 起）

改前：
```java
            if (item.getPersistentDataContainer().has(
                    com.hilltopvillage.shop.ShopListener.PAID_DROP_KEY,
                    org.bukkit.persistence.PersistentDataType.BYTE)) {
                continue;
            }
```
改后：
```java
            org.bukkit.inventory.ItemStack stack = item.getItemStack();
            org.bukkit.inventory.meta.ItemMeta meta = stack.getItemMeta();
            if (meta != null && meta.getPersistentDataContainer().has(
                    com.hilltopvillage.shop.ShopListener.PAID_DROP_KEY,
                    org.bukkit.persistence.PersistentDataType.BYTE)) {
                continue;
            }
```

注：`ShopListener` 里原本就还有一处无关的 `purchasedAmount` 修复（:152 附近）在本次改动前就在工作区里，未动。

## 2. `getItemStack()` 是副本还是引用 —— 验证方法

反编译 `paper-1.21.4-232` 服务端 jar（`testharness/servers/hilltop/versions/1.21.4/paper-1.21.4.jar`）：

`javap -p -c org/bukkit/craftbukkit/entity/CraftItem.class`：
```
public org.bukkit.inventory.ItemStack getItemStack();
  invokevirtual  ItemEntity.getItem:()Lnet/minecraft/world/item/ItemStack;
  invokestatic   CraftItemStack.asCraftMirror:(...)Lorg/bukkit/craftbukkit/inventory/CraftItemStack;
```
结论：**镜像，不是副本**。`asCraftMirror` 持有的就是 `ItemEntity` 里那个 NMS `ItemStack` 引用，
`CraftItemStack.setItemMeta` 直接调 `setItemMeta(nmsStack, meta)` 写回本源。
因此即使不写回，`setItemMeta` 也已经生效。

`ArenaInstance` 读取侧同理——`item.getItemStack().getItemMeta()` 读到的是实体真实栈，不是过期副本。

顺带验证了修法的理论前提：
- `ItemEntity.merge(ItemStack,ItemStack,int)` 用的是 `copyWithCount` → `ItemStack.copy()` + `setCount()`
- `ItemStack.copy()` 内部 `new ItemStack(item, count, this.components.copy())`
  → components（含 PDC 所在的 `CUSTOM_DATA`）被**拷贝**，所以合并后标记仍在。

（顺带核对了 MockBukkit 4.45.0：`ItemMock.getItemStack()` 直接返回内部字段、`setItemStack` 存 `clone()`，
`ItemStackMock.getItemMeta()` 返回 `itemMeta.clone()`（PDC 深拷贝）、`setItemMeta` 需 `isApplicable` 通过才写入。
这解释了为何测试侧「先 drop 再打标」必须真的 `setItemStack` 写回。）


## 3. 编译结果

```
powershell -NoProfile -Command "$env:JAVA_TOOL_OPTIONS='-Djdk.attach.allowAttachSelf=true'; cmd.exe /c '...\build.cmd -o test-compile'"
[INFO] BUILD SUCCESS
[INFO] Total time: 40.925 s
```

## 4. 实测结果（重要，与开工时的判断不同）

三份相关测试**已在工作区里被更早的手改成了 ItemStack 契约**（`ShopOverflowPaidDropTest`、`ShopOverflowPartialFitTest` 的 `isPaidDrop`/`markPaid` 都读 ItemStack PDC；
`ShopPaidDropMergeTest` 仍是旧的实体 PDC 写法）。

| 测试类 | 改前（无修复） | 改后 |
|---|---|---|
| `ShopOverflowPaidDropTest`（6） | 4 失败 | **6 全过** |
| `ShopOverflowPartialFitTest`（6） | — | **6 全过** |
| `ShopPaidDropMergeTest`（7） | 4 失败 | **4 失败（未变）** |

`ShopOverflowPaidDropTest` 的 `EndToEnd`（真实购买 → 重置链路）在无修复时失败、有修复时通过，是本改动的有效正向证据。

**`ShopPaidDropMergeTest` 的 4 个失败不是本次改动引入的**：该文件的 `isPaidDrop(Item)` 与 `dropAt(..., paid)`
仍是实体 PDC 旧契约（`:129-131`、`:188-190`、`:241-243`、`:420-422`），断言的是「实体 PDC 上的键能活过合并」——
这个前提在修复后已不成立（迁移后标记不再写实体 PDC）。**这些用例需要按新契约重写，未在本次范围内。**

**另发现一处不稳定**：`ShopOverflowPaidDropTest$SkippingSide.markedDropSurvivesWhileUnmarkedIsRemoved`
在同样代码下出现过 1 次失败（实际：`[]`）、随后两次干净重跑均通过。原因未定，**需要下一个任务排查并钉死**
（怀疑与 `loadFullPluginWithArenas()` 的 tick 时序 / 重置与实体登记竞争有关，而非打标逻辑）。

## 5. 还需要补什么测试（**不要在本任务里补**）

1. **重写 `ShopPaidDropMergeTest` 的契约**：`isPaidDrop` 与 `dropAt(..., paid)` 改读写 ItemStack PDC，
   然后确认方向 A/B、`survivorOfMergeSurvivesArenaReset`、`NoOverclean` 全部转绿。这是本缺陷的**核心回归网**，
   目前实际处于「断言旧契约、恒失败」状态，等于没有覆盖。
2. **合并后重置**：付过钱的 `BOW x1` + 普通 `BOW x1` 合并 → `resetNow()` 后必须剩 1 件（现有
   `survivorOfMergeSurvivesArenaReset` 已搭好骨架，改完契约即可复用）。
3. **部分合并边界**：满叠 `BOW x64`(paid) + `BOW x10` 普通 → 溢出进新实体时标记是否随 `copyWithCount` 保留。
4. **空 ItemMeta 边界**：`dropPaidItem` 里 `meta != null` 分支无测试覆盖。
5. **反向用例**：普通掉落物重置后必须仍被删除（`NoOverclean` 已覆盖，改契约后需重新确认）。
6. **`SkippingSide` 的不稳定要钉死**：重复跑 N 次或显式同步 tick，确认不是重置竞态。

