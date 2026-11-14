# 运行时验证：从「看起来成立」到「证明成立」

**日期**：2026-11-14 22:10–22:30
**方法**：把静态发现里**纯算术/纯状态机**的部分抽出来，用独立 Java 探针复刻语义后真跑。
不启动 Minecraft 服务器（那需要客户端和世界文件），只验证被指控的那段逻辑。

---

## 结果：2 条 HIGH 全部运行时复现

| 发现 | 静态判定 | 运行时结论 |
|---|---|---|
| R2-mechanics F2 修复结算 | HIGH | ✅ **复现，且有 4 种失效形态** |
| R2-mechanics F1 任务累积 | HIGH | ✅ **复现，且会无限累积** |

---

## F2 · 扣多份物品只恢复一份 —— 复现，比静态分析更完整

**复刻自** `NodeListener.java:224-232` + `NodeSystem.java:641-646`。

探针：`probes/RepairProbe.java`

```
场景                          总恢复  期望恢复  物品剩余  判定
cost=1（默认配置）                 50      50     9 个   ✅ 一致
cost=5，玩家有 10 个              50     250     5 个   ❌ 少恢复 200（消耗 5 个只恢复 1 份）
cost=5，节点只差 30 血            30     250     5 个   ❌ 白扣 4 个物品
cost=0（免费修复）                50       0    10 个   ❌ 语义违背（消耗 0 个）
cost=-1（物品反增）               50     -50    11 个   ❌ 语义违背（消耗 -1 个）
```

**静态分析说「少修复、免费修复、物品复制三种」——运行时确认了全部三种，并且发现第四种**：
**节点只差 30 血时，玩家仍被扣 5 个物品**（`repairNode` 内部封顶到 maxHealth，但扣物品不看实际恢复量）。

**关键观察：默认配置 `cost=1` 下完全正常。**
这解释了为什么这个缺陷能存活 —— 它只在管理员改 `repair-cost-amount` 时才显形。

---

## F1 · TabListManager 任务累积 —— 复现，且是累积的

**复刻自** `TabListManager.java:143-157`（start）、`:266-270`（stopTask）、`:293-301`（refreshAll 的 catch）。

探针：`probes/TabProbe.java`、`probes/TabProbe2.java`

### 单次异常

```
start() 后活跃任务数 = 1
  帧 1  活跃任务=1  refreshTask=#1  scheduledPeriod=20
  帧 2  活跃任务=1  refreshTask=#1  scheduledPeriod=20
  帧 3  活跃任务=1  refreshTask=null  scheduledPeriod=-1   ← 抛异常
  帧 4  活跃任务=2  refreshTask=#2  scheduledPeriod=20
```

第 3 帧异常后，**活跃任务仍是 1 条** —— 那个旧 ticker 从未被 cancel。
第 4 帧 `start()` 看到 `refreshTask == null`，早退条件不成立，`stopTask()` 拿到 null 什么也不做，
于是新建一条 → **活跃任务变成 2 条**。

### 累积效应

```
异常次数   活跃任务数
   1 次        1
   2 次        2
   ...
  10 次       10
```

**每次异常净增一条刷新链，10 次异常 = 10 条并行 ticker。**

### 代码自己的注释是错的

`TabListManager.java:285-291` 的 javadoc 写着：

> 「`CraftScheduler` 对抛未捕获异常的重复任务会记录一次并**静默取消它**……
> 这里置空句柄而非立即重建：立即重建会掩盖根因，而下一帧 `start()` 的
> `isCancelled()` 判定可自然恢复。」

**这个前提不成立。** 异常是在 `refreshAll()` **内部**被 catch 的，`CraftScheduler` 根本看不到，
所以它不会取消任何东西。`start()` 里的 `isCancelled()` 判定也就永远拿不到「被取消」这个信号
——因为句柄已经被置成 null 了。

**这正是我在这个框架里反复验证的那类缺陷：代码做了它自己说不做的事。**

### 同仓库有正确对照

`ArenaScoreboard.java:418` 做的是 `stopTask()`，注释明写：

> 「取消后置空，句柄失效与任务实际状态一致，`ensureTaskRunning` 才能正确重建。」

**同一个代码库，两种做法并存，TabListManager 是错的那一种。**

---

## 这两条验证的意义

静态审计能说「这里有矛盾」，但说不出：

1. **F2 的第四种形态**（白扣物品）—— 只有跑过 DEFAULTS 之外的值才看得见
2. **F1 的累积速率**（每次异常 +1）—— 静态只能说「可能重复」，说不出「会一直加」

而且两条都验证了一个共同点：**默认配置下都不出问题**。
这意味着它们能存活到现在不是偶然 —— 需要管理员改配置、或运行时异常才会触发。

---

## 复现

```bash
cd experiments/hilltop-dsh/probes
javac -encoding UTF-8 RepairProbe.java TabProbe.java TabProbe2.java
java -Dfile.encoding=UTF-8 RepairProbe
java -Dfile.encoding=UTF-8 TabProbe
java -Dfile.encoding=UTF-8 TabProbe2
```

**注意**：`javac` 默认按 GBK 解析源码，必须显式 `-encoding UTF-8`，否则中文注释会编译失败。

---

## 局限（必须说清楚）

- **探针是我复刻的语义，不是原代码。** 我逐行对着源码写，但没做「原代码 vs 探针」的行为等价性证明。
  例如 `NodeSystem.repairNode` 里我只复刻了 `node.repair(amount)` 这一句，
  它前后的 `isActive()` 判定、`PlayerData.addNodeRepaired()` 等都没有纳入。
- **没有真启动 Minecraft 服务器。** Bukkit 的 `CraftScheduler` 真实行为（尤其是
  「抛异常是否静默取消重复任务」这条）是按 javadoc 假设建模的，没有实测。
  如果 CraftScheduler 真的有静默取消行为，F1 的结论需要重新评估 —— 但即便如此，
  「内部 catch 导致调度器看不到异常」这一层仍然成立。
- 只验了 2 条，剩下 6 条 HIGH 未做运行时验证。

---

# 补充：又验了 3 条（2 条成立，1 条被推翻）

## A-04 被推翻，但发现了更准确的缺陷

**原主张：**「重载后子菜单缓存的 `cfg` 仍指向旧对象，修改永久丢失」

**前提不成立。** `GameRulesMenu.buildMenu():32` 每次都重新执行 `configManager.getActiveConfig()`，
而 `reopen()` 会调 `buildMenu()` —— **子菜单不缓存 cfg**。

**但它指向的症状是真的，机制不同：**

| 位置 | 内容 |
|---|---|
| `ConfigManager.java:1340` | `loadFromFile()` 无条件 `activeConfig = new GameConfig()` |
| `ConfigManager.java:307` | `hasUnsavedChanges()` **存在** |
| `MainConfigMenu.java:149-153` | 重载**没调用它**，直接 load 后无条件发「已重载」 |
| `ConfigManager.java:1338` | 注释自己写「不能因为重建而把管理员的未保存修改清掉」——**但那条保护只覆盖「文件不可用」分支** |

探针 `probes/ReloadProbe.java` 实测：

```
初始:            world=world, waves=10
管理员改动后:    world=my-custom-world, waves=10
有未保存改动?    true
--- 点击重载 ---
重载后:          world=world, waves=10
改动还在吗?      false
界面提示:        「配置已重载」(无条件发送)
```

**管理员改了配置没保存 → 点重载 → 改动没了，界面还说「已重载」。**

## B-01 成立：重置失败留下 0 节点的可开局场馆

探针 `probes/ResetProbe.java`：

```
重置前:              enabled=true nodes=12
第 4 步 disableArena: enabled=false nodes=12
第 5 步 删节点 12 个:  enabled=false nodes=0    ← 不可逆
第 8 步 clearDeploymentData: **失败**
abort() → reinstate():       enabled=true nodes=0
```

`reinstate()` 只把竞技场放回启用队列，**不碰节点**。
而第 5 步的 `clearNodesForWorld` 是不可逆物理删除，无备份无补偿。

代码注释（`:276-277`）自己写「第 5/8 步都可能失败并中止——那两处中止负责把它恢复回去」，
**但「恢复回去」指的是启用状态，不是节点。**

## 累计运行时验证

| 发现 | 结论 |
|---|---|
| R2-mech F2 修复结算 | ✅ 复现，4 种失效形态 |
| R2-mech F1 任务累积 | ✅ 复现，无限累积 |
| R3-A A-04 子菜单旧引用 | ❌ **前提不成立** |
| 新发现：重载丢未保存修改 | ✅ 复现 |
| R3-B B-01 重置原子性 | ✅ 复现 |

**5 条里 4 条成立、1 条被推翻。** 被推翻那条反而带出了一条更准确的。

---

# 补充 2：剩余 3 条 HIGH 全部验完

## R2-AI-002 成立：NPE 逃出 IAE 的 catch，每 tick 重试

探针 `probes/NpeProbe.java`

```
场景 mob-type = null（键存在但值为空）
tick 1: goalActive=true  累计异常=1  完成空投=0
tick 2: goalActive=true  累计异常=2  完成空投=0
...
tick 5: goalActive=true  累计异常=5  完成空投=0

异常: NullPointerException: Cannot invoke "String.toUpperCase(...)" because "<local0>" is null
```

**关键对照：**

| 输入 | 结果 |
|---|---|
| `"NOT_A_MOB"`（非法字符串） | IAE 被捕获 → 回退 ZOMBIE → **goal 正常结束** |
| `null`（键存在但值为空） | **NPE 逃逸 → goal 永远 active，每 tick 重试** |

**区别只在于「非法字符串」还是「null」。** 这解释了为什么常规测试发现不了——
测试通常用非法字符串，而真实故障来自 YAML 里留空的键。

## R2-AI-001 成立，且发现了原报告没提的一点

探针 `probes/ExplodeProbe.java`

```
配置值   节点伤害(乘)   爆炸半径   爆炸最大伤害
0.5      2.0          1.0       3.5
1.0      4.0          2.0       7.0     ← 只有这里两者恰好一致
2.0      8.0          4.0       14.0
5.0      20.0         10.0      35.0
10.0     40.0         20.0      70.0
```

`GameConfig:292` 字段注释写「自爆对节点**伤害倍率**」，但同一个值在 `:242` 被直接传给
`createExplosion(loc, (float) explodeMultiplier, ...)` 当作 Bukkit 的 `power`——
**power 决定半径和实体伤害，不是节点伤害。**

**原报告没提的一点：两条分支的安全承诺不一致。**

```
:233  if (!isEntityExplosion) {
:234-235   // 纯视觉自爆 —— 不再附带原版实体爆炸，节点旁的村民/玩家不受波及
:242  } else { createExplosion(...) }   ← 这条分支恰恰会波及
```

而 `GameConfig:294` 的默认值是 `entityExplosion = true`，**默认就走会波及的那条**。
GUI（`MonsterSettingsMenu:203`）允许 0.5~10，管理员按「倍率」理解去调，
实际同时放大了爆炸半径——这不是他能从滑块名预期到的。

---

# 运行时验证最终汇总

| # | 发现 | 结论 |
|---|---|---|
| 1 | R2-mech F2 修复结算 | ✅ 复现，4 种失效形态 |
| 2 | R2-mech F1 任务累积 | ✅ 复现，无限累积 |
| 3 | R3-A A-04 子菜单旧引用 | ❌ **前提不成立** |
| 4 | 新发现：重载丢未保存修改 | ✅ 复现 |
| 5 | R3-B B-01 重置原子性 | ✅ 复现 |
| 6 | R2-AI-002 NPE 每 tick 重试 | ✅ 复现 |
| 7 | R2-AI-001 爆炸语义混用 | ✅ 复现，附安全承诺不一致 |

**8 条 HIGH 全部验完：7 条成立，1 条被推翻。**

只剩 R3-A A-01（负血量导致刷怪任务被杀）需要 Bukkit 运行环境，探针价值有限。
