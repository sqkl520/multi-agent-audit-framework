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
