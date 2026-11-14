# #1 — 修复一次扣多份物品，却只恢复一份血量

**状态：已修复。**

## 涉及文件与关键代码

### `src/main/java/com/hilltopvillage/mechanics/NodeListener.java`

- `:223-247` — 结算改成“先算缺口与计划，再按实际消耗扣物品”：

```java
double deficit = Math.max(0.0, node.getMaxHealth() - node.getCurrentHealth());
RepairPlan plan = planRepair(deficit, repairAmount(), repairCostAmount(),
        item.getAmount());
if (plan.itemsConsumed() <= 0) {
    return;
}

boolean repaired = gameManager.getNodeSystem().repairNode(
        clickedBlock.getLocation(), player, plan.healthRestored());

if (repaired) {
    int remaining = item.getAmount() - plan.itemsConsumed();
    if (remaining > 0) {
        item.setAmount(remaining);
    } else {
        player.getInventory().setItemInMainHand(null);
    }
    gameManager.getDisplayEntityManager().spawnNodeRepairEffect(
            clickedBlock.getLocation());
}
```

- `:281-304` — 新增纯函数与不可变结果：

```java
static RepairPlan planRepair(double deficit, double perItem, int maxPerAction, int held) {
    if (!(deficit > 0.0) || !Double.isFinite(deficit)
            || !(perItem > 0.0) || !Double.isFinite(perItem)
            || maxPerAction <= 0 || held <= 0) {
        return RepairPlan.NONE;
    }

    int usableItems = Math.min(maxPerAction, held);
    double neededExact = deficit / perItem;
    // 吸收 30/0.1=300.00000000000006 这类浮点噪声
    double neededCeil = Math.ceil(neededExact - Math.ulp(neededExact));
    int itemsNeeded = neededCeil >= usableItems ? usableItems : (int) neededCeil;
    if (itemsNeeded <= 0) {
        return RepairPlan.NONE;
    }

    double restored = Math.min(deficit, itemsNeeded * perItem);
    return new RepairPlan(itemsNeeded, restored);
}
```

消耗量 = `ceil(缺口 / 每物品恢复量)`，再受“单次上限”和“实际持有量”双重封顶；
恢复量按**真正消耗的数量**计算，并封顶到缺口。

### `src/main/resources/game-settings.yml:127`

原注释“每次修复消耗几个”与新语义冲突，已改为：

```yaml
# 单次修复最多消耗几个（按实际缺口取最少，够修就不多扣）
```

### `src/test/java/com/hilltopvillage/mechanics/RepairSettlementTest.java`（新增，5 条）

全部走真实 `NodeListener.onPlayerInteract`，只 mock 节点系统与竞技场查表，因此红色失败对应生产结算代码本身：

- `consumesOnlyWhatTheDeficitNeeds`
- `consumesConfiguredCostAndRestoresAllOfIt`
- `zeroCostDoesNothing`
- `negativeCostDoesNothing`
- `neverConsumesMoreThanHeld`

## 失败测试与失败信息（未修复代码）

临时还原 `NodeListener.java` 到 HEAD，跑 `RepairSettlementTest`：

```
Tests run: 5, Failures: 5, Errors: 0, Skipped: 0
```

- `consumesOnlyWhatTheDeficitNeeds`
  `差 30 血只需 ceil(30/50)=1 个物品；固定扣 5 个会让玩家白丢 4 个 ==> expected: <9> but was: <5>`
- `consumesConfiguredCostAndRestoresAllOfIt`
  `★ 消耗 5 个只恢复 1 份是 #1 的核心缺陷 ==> expected: <250.0> but was: <50.0>`
- `zeroCostDoesNothing`
  `cost=0 不得凭空修复 ==> expected: <0.0> but was: <50.0>`
- `negativeCostDoesNothing`
  `负数 cost 不得把物品从 10 加到 13 ==> expected: <10> but was: <13>`
- `neverConsumesMoreThanHeld`
  `恢复量必须按实际消耗的 2 个计算，而不是配置的 5 个 ==> expected: <100.0> but was: <50.0>`

## 修复后结果

```
RepairSettlementTest: Tests run: 5, Failures: 0, Errors: 0, Skipped: 0
完整套件: Tests run: 877, Failures: 0, Errors: 0, Skipped: 1
BUILD SUCCESS
```

## 是否改过既有测试

没有。新增 `RepairSettlementTest.java`，既有测试未动。

## 风险与未覆盖场景

- **这是可感知的行为变更**：`repair-cost-amount` 从“固定扣几个”变成“单次最多扣几个”。
  例如 cost=5、每物品恢复 50、缺口 30 时，旧版扣 5 个，新版只扣 1 个。改配置模板注释是为了
  让新装服主看到正确语义；**已经部署的旧配置文件注释不会被迁移**，老管理员可能仍以为是固定扣 5 个。
  这是本次修复最需要写进更新日志的一条。
- `repairNode(...)` 返回 false 时不会扣物品（代码路径正确），但没有专门的回归测试；现有 mock 恒返回 true。
- `repair-amount-per-cost <= 0`、NaN、Infinity 会让 `planRepair` 返回 `NONE`，没有单独的测试用例；
  当前由纯函数的首个守卫覆盖。
- `planRepair` 是 package-private 静态方法，测试通过真实事件间接覆盖；没有直接单测其浮点边界
  （例如极大的缺口/极小的每物品恢复量导致 `deficit / perItem` 溢出为 Infinity）。
- 修复只处理主手物品；副手/背包内相同物品的结算规则未改变，也不在本缺陷范围内。
