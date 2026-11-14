# #6 — 爆炸倍率同时被当作节点伤害倍率和原版爆炸威力

**状态：已修复（选择固定原版威力，不做配置拆分）。**

## 涉及文件与关键代码

### `src/main/java/com/hilltopvillage/ai/ExplodeBeetleGoal.java`

- `:44` — 新增常量，普通苦力怕的原版爆炸威力：

```java
private static final float DEFAULT_EXPLOSION_POWER = 3.0f;
```

- `:233-244` — 倍率只参与节点伤害，且非有限值统一折算为 0：

```java
GameConfig cfg = gameManager.getConfigManager().getActiveConfig();
GameConfig.MonsterConfig monsterCfg = cfg.getMonsters().get("explode-beetle");
double rawExplodeMultiplier = monsterCfg == null
        ? 0
        : monsterCfg.getExplodeDamageMultiplier();
double explodeMultiplier = Double.isFinite(rawExplodeMultiplier)
        && rawExplodeMultiplier > 0 ? rawExplodeMultiplier : 0;
double nodeMultiplier = Math.max(0, cfg.getNodeSelfDestructMultiplier());
double nodeDamage = resolveBaseDamage(monsterCfg) * explodeMultiplier * nodeMultiplier;
```

- `:254-257` — 实体爆炸威力与节点倍率解耦：

```java
float power = explodeMultiplier > 0 ? DEFAULT_EXPLOSION_POWER : 0.0f;
world.createExplosion(nodeLoc, power, false, false, beetle);
```

倍率为 0 时仍传 `0.0f`，保留“纯节点 0 伤害、无实体爆炸伤害”的既有语义。

### `src/test/java/com/hilltopvillage/ai/ExplodeBeetleGoalTest.java`（新增 2 条，既有测试类）

- `explosionPowerIsIndependentFromNodeDamageMultiplier`：
  倍率 10、节点自毁倍率 1、基础伤害 4 → 断言 `createExplosion` 的 power 是 `3.0f`，
  且 `damageNode(..., 40.0)`。
- `zeroMultiplierKeepsExplosionPowerless`：
  倍率 0 → 断言 power 是 `0.0f`，节点伤害 0。

## 失败测试与失败信息（未修复代码）

临时还原 `ExplodeBeetleGoal.java` 到 HEAD，跑本测试类：

```
Tests run: 10, Failures: 1, Errors: 0, Skipped: 0
```

- `explosionPowerIsIndependentFromNodeDamageMultiplier`
  `★ 节点倍率 10 只该放大 damageNode；createExplosion 的 power 必须是普通苦力怕的 3.0 ==> expected: <3.0> but was: <10.0>`

`zeroMultiplierKeepsExplosionPowerless` 在旧代码上通过（旧代码 `Math.max(0, 0)` 本来就是 0），
它守的是“不要把 0 也抬成固定 3.0”这一侧。

## 修复后结果

```
ExplodeBeetleGoalTest: Tests run: 10, Failures: 0, Errors: 0, Skipped: 0
完整套件: Tests run: 877, Failures: 0, Errors: 0, Skipped: 1
BUILD SUCCESS
```

## 是否改过既有测试

没有改既有断言。只在既有测试类里补了两个用例，并为它们补了 fixture：
`doNothing().when(beetle).remove()`（Mockito spy 不同步 MockBukkit 的 removal 标记）、
`DisplayEntityManager` 返回值、`createExplosion` 的 `doReturn(false)` 以及 `configManager` 字段。
这些 stub 也让原有用例继续走同一条生产路径；完整套件全绿说明没有改变既有测试的语义。

## 为什么选“固定 3.0”，不选另外两种方案

1. **拆分配置**（新增 `explosion-power`）：语义最干净，但要改 `GameConfig`、`game-settings.yml`、
   配置 GUI、`ConfigManager` 的保存/合并/迁移，还要决定旧值怎么映射。为一个只有一种怪使用的
   参数引入新键，迁移成本和长期维护成本都高于收益。
2. **继续复用倍率、只把节点伤害另算**：会保留 0.5 倍小爆炸的调参能力，但 `explode-damage-multiplier`
   的文档语义仍是“对节点伤害倍率”，继续拿它当 power 只是把同一个歧义换个方向保留下来。
3. **固定为普通苦力怕 3.0**：与“自爆甲虫 = 靠近节点自爆”的直觉一致，不需要新配置，也不会让
   GUI 允许的 10 变成 10 倍原版爆炸。代价是失去按怪种调爆炸范围的能力，且低倍率（如 0.5）
   现在也会产生完整的普通苦力怕爆炸。

**结论**：选择 3，因为它在不增加配置面积的前提下消除了语义混用；如果未来确实需要按怪种调
爆炸范围，应新增独立键，而不是复活这个倍率的双重职责。

## 风险与未覆盖场景

- **战斗数值会变**：所有非 0 倍率现在都是普通苦力怕威力。原本配置 0.5 的服会感觉爆炸明显变强；
  原本配置 10 的服会感觉变弱。节点伤害不变（仍按倍率缩放），玩家受到的爆炸伤害会变。
- 0 倍率仍调用 `createExplosion(..., 0.0f, ...)`。Paper 在 power=0 时是否完全不产生伤害，
  测试只能验证传入参数，不能验证服务端内部实现；`entity-explosion: false` 的纯视觉路径不受影响。
- `nodeSelfDestructMultiplier` 仍直接参与节点伤害，未做 NaN/Infinity 钳制；
  若该配置被写成 NaN，`nodeDamage` 仍会是 NaN。它不属于 #6 的“爆炸威力”混用，但属于相邻风险。
- 没有为负倍率单独写测试；代码会把负数折算成 0（与 0 同一路径）。
- 固定 3.0 是原版普通苦力怕值，不是“所有爆炸类实体”的通用值（ charging creeper 等更强）；
  本插件只生成普通自爆甲虫，因此按普通苦力怕选取。
