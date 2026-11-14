# 修复前必须先知道的既有先例

**来源**：检索 agent 对项目内「正确做法」的穷举（只读，未改文件）

**为什么重要**：这个项目已经解决过大部分同类问题，只是没解决到那 7 个点上。
**照抄既有先例，比自创新方案更安全**——新方案会和项目风格冲突，且没有经过这个代码库的实战检验。

---

## 关键发现：这 7 条缺陷里有 3 条是「同一问题在别处已修过」

| 缺陷 | 项目里已有的正确实现 |
|---|---|
| 第 2 条 TabListManager 任务累积 | `ArenaScoreboard.java:406-419` **修过一模一样的 bug**，注释写明了原因；`StatsManager.java:493-496` 也修过 |
| 第 5 条 NPE 逃出 catch | 项目有统一的「防线二」用法（`NumericInputHandler.java:22-29`） |
| 第 7 条配置钳制 | `normalizeWaveTimeout` / `normalizeStarterKitItems` 是成熟模板，含调用点纪律 |

**`ArenaScoreboard` 那条最关键**——它的注释几乎就是第 2 条的现成修复说明：

> 「必须先 cancel() 再置空。异常在这一帧之内就被本 catch 吞掉，从未穿出 run() →
> CraftScheduler 不会取消任务；只置空句柄会把一个仍然活着的 ticker 变成无人持有的孤儿」

**同一句话在 `TabListManager:149-153` 也写过一遍，但只写在了 `start()` 里，没写进 catch。**

---

## 1. 配置钳制的模板（第 7 条用这个）

### 做法（三段式）

```java
private static int normalizeXxx(int raw) {
    // 1. 纯函数改写值
    // 2. 只对可识别的旧默认值动手，管理员显式设过的一律不吞
    // 3. 值确实被改写时打一条 warning（英文，一句话说清旧值→新值）
    return ...;
}
```

`normalizeWaveTimeout`（`ConfigManager.java:689-701`）的注释自己写了原则：

> 「其它值（含 `<=0` 与其它正数）原样保留——**管理员显式设定过的值不会被吞**。」

### 调用点必须覆盖两条入口（很容易漏）

| 入口 | 位置 |
|---|---|
| `loadFromFile()` 首读 | `ConfigManager.java:1354-1362` |
| `mergeExternalChanges()` 外部手改合并 | `ConfigManager.java:392-395` |

**只改首读、不改合并，会出现「重启才生效、reload 不生效」的诡异行为。**

### 配套纪律：改了内存值必须登记「脏」

`ConfigManager.java:85-97` 的 `loadTimeNormalizationPending`：

```java
private boolean loadTimeNormalizationPending;
```

消费点 `:307-313`，`hasUnsavedChanges()` 第一句：

```java
if (loadTimeNormalizationPending) return true;
```

**不登记就会：主菜单显示「已是最新」、隐藏保存按钮、归一化的值永远写不回磁盘。**

### 取值边界的最规范实现

`DisplayConfigLoader.java:511-524`——warning 带 `[min,max]` 和钳后值：

```java
warnings.add("display.yml " + label + ": " + value + " is out of range ["
        + min + "," + max + "]; clamped to " + min);
```

设计原则在 `:24-46`：**fail-soft（行级）**，越界就夹、不跳过；**本类不打日志**，
warnings 作为返回值交给 `ConfigManager` 转记。

### 项目全局语义约定

- **`<= 0` = 禁用/无效**（`GameManager.java:473-479` `if (timeoutSeconds <= 0) return;`）
- `-1` 只作 `drop-min/max` 的「未配置」哨兵
- **不做「只靠载入侧」**——消费侧都有第二道钳制
  （`WaveManager:855-862`、`:826`、`ArenaManager:280`）

### 反面样本（别学）

`spawn-radius-min/max`（`ConfigManager.java:1505-1506`）完全不校验，只在消费侧兜底。
项目自己把这当作欠账形态。

---

## 2. 任务生命周期的模板（第 2 条用这个）

### 统一形状（7 处同构）

```java
private void stopXxxTask() {
    if (xxxTask != null) {
        xxxTask.cancel();
        xxxTask = null;
    }
}
```

注释一律标「**幂等**」。理由写在 `WaveManager.java:867-874`：

> 「`BukkitTask#cancel()` 对已取消 / 已执行完的任务是空操作（只是把它从调度器摘下），
> 重复调用不会抛异常」

### 最核心的一条：**绝不能只置空不 cancel**

`ArenaScoreboard.java:406-419` 的 catch 分支就是第 2 条的现成答案：

```java
} catch (RuntimeException fatal) {
    plugin.getLogger().log(java.util.logging.Level.SEVERE, "...", fatal);
    // slice-10-conc-001：必须先 cancel() 再置空。异常在这一帧之内就被本 catch 吞掉，
    // 从未穿出 run() → CraftScheduler 不会取消任务；只置空句柄会把一个仍然活着的
    // ticker 变成无人持有的孤儿（stopTask 再也找不到它）
    stopTask();
}
```

### 「任务体内 cancel 自身」的 3 种既有写法

1. **置空句柄 → 跑回调 → cancel 自身**（顺序刻意）——`WaveManager.java:163-172`
   ```java
   spawnTask = null;
   if (onComplete != null) onComplete.run();
   cancel();
   ```
2. **cancel → 按身份从 map 移除**——`LocationParticlePreview.java:85-90` + `removeIfCurrent`
   （只当 map 里存的仍是当前任务时才移除，避免误删之后新启动的）
3. **cancel → 置 null / 复位标志**——`FireballListener.java:145-153`

**所以「在任务体内 cancel 自己」是项目里既有且被广泛使用的做法，没有限制。**

### 老风格（别学）

`NpcManager:229-236` 用 `int taskId = -1` + `cancelTask(id)`，无法表达 `isCancelled()`。
这正是 `ArenaScoreboard` / `TabListManager` / `StatsManager` 被修掉的旧形态。

---

## 3. 二次确认的模板（第 3 条用这个）

### 结论先行：**「GUI 关闭时拦截」在本项目里无先例**

全库 `InventoryCloseEvent` 只有 2 处，都只注销监听器，**没有一处 `setCancelled` / 重开**。

且 `SetupWizard.java:2195-2197` 明确记录**删掉了** close 处理器：

> 「关闭界面不清除 session，玩家可重新打开任意入口继续」

### 项目实际用的形态：GUI 内独立确认页

`ArenaManageGUI.java:700-745` 的 `RESET_CONFIRM`：
TNT + 8 条 warn 列表 + 绿羊毛确认 / 红羊毛取消。

**顺序纪律（`ArenaManageGUI.java:737-745`）：**

> 「成功了先离开确认页再执行（走 `goBack()`）：reset 的回调可能在本次调用栈内同步触发，
> 若不先离开确认页，回调里的 `reopen()` 会再次渲染确认页，管理员可以重复点击。」

### 另一种：聊天命令式 TTL 二次确认

`HilltopCommandHandler.java:76-90` 的 `PendingClear` record
（含 `arenaId` / `expiresAt` / `requestedAt`），15 秒 TTL。

---

## 决定性发现：项目有 846 条存量测试，全部通过

**我独立验证过：**

```
src/test/java   78 个文件
@Test           839 处
Tests run: 846, Failures: 0, Errors: 0, Skipped: 1   BUILD SUCCESS
```

**这改变了整个验收策略。**

原本我打算用 7 个手写 Java 探针验收修复。但验证 agent 指出一个致命问题：

> `RepairProbe.java` 的 `settle()` 是**手抄**的 `node.repair(repairAmountPerCost)` 一行，
> **改源码它不变，永远 ❌**。

也就是说，探针是**复刻**的语义，它验证的是「我理解的代码」，不是「真实代码」。
修复后探针不会自动跟着变，我得手工同步——而手工同步很容易出错。

**正确做法：用项目自己的测试栈写新用例。**

| 项 | 值 |
|---|---|
| 测试框架 | JUnit 5.12.1 + MockBukkit 4.45.0 + Mockito 5.8.0 |
| 已有先例 | `TabListManagerTest` / `ExplodeBeetleGoalTest` / `MainConfigMenuSaveResultTest` 等 |
| CI | `.github/workflows/build.yml:61` → `bash build.sh -B clean test` |

新用例直接调真实类，改源码它就跟着变。**这才是真正的验收。**

### MockBukkit 的能力边界（验证 agent 反编译实测）

这几个限制直接决定了哪些能测、哪些不能：

| API | 状态 | 影响 |
|---|---|---|
| `BukkitSchedulerMock#getPendingTasks()` | **不支持**（UnimplementedOperationException） | **不能数「有几条活跃任务」** —— 第 2 条要换判据 |
| `BukkitSchedulerMock#isQueued(int taskId)` | 可用 | 用 taskId 判「旧任务是否已取消」——第 2 条的钥匙 |
| `ScheduledTask#run()` | **不 catch，异常直上抛** | MockBukkit **不模拟** CraftScheduler 的「抛异常即静默取消」 |
| `WorldMock#createExplosion(...)` | **不支持** | 第 6 条必须 spy world |
| `WorldMock#spawnParticle(...)` | 不支持 | 第 1/6 条需 spy（`ExplodeBeetleGoalTest:70` 有先例） |
| `WorldMock#playSound(...)` | 可用 | 第 5 条可直接跑 |

**第 2 条受影响最大**：MockBukkit 不能数活跃任务，所以不能用「修复后活跃任务数 == 1」这个判据。
替代方案：用 `isQueued(oldTaskId)` 判断旧任务是否被取消。
