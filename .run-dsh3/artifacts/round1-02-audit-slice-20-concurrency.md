# round1 / slice-20 / dimension=concurrency 深挖产物

- trace_id: `trace-r1-20260215-hilltop-dsh3`
- round_id: `round1`
- slice_id: `slice-20`
- dimension: `concurrency`（本产物只报并发；其余维度一律进 `off_dimension_notes`）
- 被审仓库（只读）：`D:\Server\MCServers\Server plugin\Hilltop Village\Hilltop Village Plugin`
- 上游宽扫：`.run-dsh3/artifacts/round1-02-sweep-slice-20.md`（6 条线索，逐条处置见 §2）

## 0. 结论摘要

| 项 | 值 |
|---|---|
| CONFIRMED | 2（均 LOW，均为「任务生命周期 / 句柄归属」类，非数据竞态） |
| NO_EVIDENCE_FOUND | 1（异步线程触碰 Bukkit API / 跨线程普通集合：5 个文件 0 命中） |
| 数据竞态（race） | 0 条。本切片 5 个文件里出现的所有调度入口都在主线程（事件处理器 / Bukkit 任务体），未发现 `runTaskAsynchronously` 或裸线程 |

**为什么没有 CRITICAL/HIGH**：并发发现要升级必须能给出「两个线程分别读写同一状态」或「任务在错误生命周期被调度且可达」的证据。本切片实测：
- `FireballListener` 的 `cooldowns` / `activeTrails` 是 `ConcurrentHashMap`（:132、:134）；
- `ArenaScoreboard.boards` 是 `ConcurrentHashMap`（:98），且 `refreshAll()` 迭代时 `boards.remove(...)`（:542）在弱一致迭代器下合法；
- 全仓 `src/main/java` 仅 3 处异步入口（`PlayerGoodsManager:478`、`CommandsDocumentGenerator:467`、`StatsManager:640/673`），均不在本切片调用链上（`grep` 结果见 §4）；
- 因此两条 CONFIRMED 都只能是「任务生命周期/句柄」类缺陷，按 `wave2-audit.md` §3.3 与 `evidence-policy.md` §3 不给 HIGH 以上。

## 1. 逐文件并发面核查

| 文件 | 调度/并发结构 | 判定 |
|---|---|---|
| `ArenaScoreboard.java` | 1 条共享刷新任务 `updateTask`（:369）+ 1 条恢复探针 `reEnableProbeTask`（:393）；`boards` 为 CHM；`stopTask()`/`stopReEnableProbe()` 均有 `cancel()` | F1（缺 `isEnabled` 守卫） |
| `FireballListener.java` | 2 条具名全局 ticker（`cooldownTicker` :141、`trailTicker` :350，均有字段句柄与 `shutdown()` 取消）+ 1 条**匿名**每爆任务（:612-622，无句柄）+ 1 条 `runTask` 延迟击退（:598） | F2（匿名任务不可取消） |
| `HammerEffectRenderer.java` | 纯静态粒子渲染，无调度、无字段、无可变共享状态（`STONE_DATA` 等为 `static final` 只读，注释 :47-49 明示不可变） | 无线索 |
| `ArenaAccessListener.java` | 仅 `PlayerTeleportEvent` 处理器，`setCancelled`，无调度/无字段 | 无线索 |
| `FriendlyFireListener.java` | 仅 `EntityDamageByEntityEvent` 处理器，纯读判定 + `setCancelled`，无调度/无字段 | 无线索 |

## 2. 上游线索处置（L1–L6，逐条）

| 线索 | 处置 | 说明 |
|---|---|---|
| **L1** `ArenaScoreboard:369` `runTaskTimer` 缺 `plugin.isEnabled()` 守卫 | **CONFIRMED → F-slice-20-concurrency-01（LOW）** | 守卫不对称属实（同类 `ensureReEnableProbeRunning` :391-392 显式挡禁用阶段）；但禁用窗口内可达性未证实：`show()` 的两个调用点 `ArenaInstance:343`（addPlayer）/`:575`（rejoin）都在「加入/重连」主线程路径，服务器禁用期间不会有新加入。故按「潜在缺陷 / 未来调用方陷阱」定 LOW，不按「当前必崩」定级 |
| **L2** `FireballListener:622` 每次爆炸新建匿名重复任务、不存句柄 | **CONFIRMED → F-slice-20-concurrency-02（LOW）** | 句柄缺失与 `shutdown()` 覆盖面差集属实；影响被 `t++ >= 10` 自停（20 tick）与「插件禁用时 CraftScheduler 统一取消」双重限制，故 LOW |
| **L3** `UUID.fromString` 空 catch（:525） | 转 `off_dimension_notes` | error-handling 维度，本实例不判 |
| **L4** 发射器扣料作用在 `BlockState` 快照库存（:304） | 转 `off_dimension_notes` | data-consistency 维度 |
| **L5** 世界准入只挂传送事件（`ArenaAccessListener:80`） | 转 `off_dimension_notes` | security 维度 |
| **L6** 友伤门控只认玩家/弹射物（`FriendlyFireListener:62`） | 转 `off_dimension_notes` | logic 维度 |

## 3. 发现详情

### F-slice-20-concurrency-01（L1）— 刷新任务的调度缺少「插件已禁用」守卫，与同类的探针任务守卫不一致

- 证据：`ArenaScoreboard.java:369`
  `updateTask = Bukkit.getScheduler().runTaskTimer(plugin, this::refreshAll, refreshPeriodTicks, refreshPeriodTicks);`
- 对照（同一文件、同类任务，:391-392 原文）：
  `// 插件禁用阶段不允许再调度 Bukkit 任务` / `if (!plugin.isEnabled()) return;`
- 控制流：`show()`（:272）→ 末尾 `ensureTaskRunning()`（:310）→ 本行 `runTaskTimer`。`show()` 的调用点是 `ArenaInstance:343`（`addPlayer` 内、传送与设置游戏模式之后）与 `ArenaInstance:575`（`rejoin` 末尾）。
- 推断：在「插件已 `setEnabled(false)`」窗口内调用 `runTaskTimer`，Bukkit 抛 `IllegalPluginAccessException`（RuntimeException）。本方法没有任何 try/catch，异常沿 `ensureTaskRunning → show → ArenaInstance.addPlayer/rejoin` 冒到事件/命令调用方；此时 `boards` 里已 `put` 了新 `BoardState`（:300）且 `player.setScoreboard(board)` 已执行（:304），即「板已挂上、任务没起来、异常已外抛」的半完成状态——该玩家侧边栏在本局内不会再被刷新，直到下一次 `show()`。
- 为什么只定 LOW：已知调用点都在「玩家加入/重连」路径，服务器禁用期间不会产生新加入；Probe 任务（唯一会在运行期再调 `show()` 的路径）本身也被 `isEnabled()` 挡住。因此当前版本大概率不可达，属**潜在陷阱 + 守卫不对称**，不是「现在就崩」。
- 为何仍要报：这是本类自己写下的不变量（:391 注释）在同族方法上的漏用，未来任何新增调用方（软重载、异步重连回调、其它插件的 API 调用）都会直接踩中，而失败形态是「抛异常 + 半完成状态」，排查成本高。

### F-slice-20-concurrency-02（L2）— 每次爆炸新建一条无人持有的重复任务，`shutdown()` 无法取消

- 证据：`FireballListener.java:612-622`（逐字，见信封 quote）
- 控制流：`onProjectileHit`（:477）或 `tickTrails()`（:404-405）→ `triggerExplosion`（:502）→ 末尾 `new BukkitRunnable(){...}.runTaskTimer(plugin, 0L, 2L)`。返回值没有赋给任何字段（本文件两个具名 ticker 都有字段：:74 `cooldownTicker`、:78 `trailTicker`）。
- 推断：每次爆炸产生一条独立重复任务，闭包持有 `world` 与 `impact`（:617、:619 使用）以及外层 `FireballListener` 实例；任务只在第 11 次执行（`t++ >= 10`，约 20 tick）时自停。
  - `shutdown()`（:455-472）只取消 `cooldownTicker` 与 `trailTicker`，遍历 `activeTrails` 清理投射物，对匿名任务无任何引用 → 关服/重载序列里这条任务不在「可取消集合」内。
  - 竞技场结束（`clear()`/世界重置）不会取消它：它不属于任何竞技场实例，任务体也不校验 `isRunningArena`，因此在竞技场结束后的最多 20 tick 内仍会向原坐标发包。
  - 持续交战下任务条数与「爆炸次数 × 20 tick 存活期」成正比，全部由调度器逐 tick 驱动，无上限约束。
- 为什么只定 LOW：单条任务寿命极短（11 次执行）且自带 `cancel()`；CraftScheduler 在插件禁用时会统一取消该插件的任务，所以「关服后永久泄漏」不成立；竞技场世界在本仓库中由 `MapRestoreManager` 做方块回滚而非卸载 world，故「向已卸载世界发包」也未证实。
- 与上游线索的差异：宽扫写「跑满 10 次」——实测为 `t++ >= 10` 时第 11 次进入即 cancel，故实际是 10 次粒子输出、11 次调度回调；结论方向不变。

## 4. 并发专项检索结果（可复核）

| 检索 | 范围 | 命中 |
|---|---|---|
| `runTaskAsynchronously\|runTaskTimerAsynchronously\|CompletableFuture\|new Thread\|ExecutorService` | 本切片 5 文件 | **0** |
| 同上 | `src/main/java` 全仓 | 3 个文件、5 处：`PlayerGoodsManager:478`、`CommandsDocumentGenerator:467`、`StatsManager:640/673`（均不在本切片调用链） |
| `synchronized` | 本切片 5 文件 | 0（并发安全靠 `ConcurrentHashMap` 与「全部主线程」约定，不靠锁） |
| `BukkitRunnable\|runTaskTimer\|runTask` | 本切片 5 文件 | `ArenaScoreboard:369/393`；`FireballListener:141/155/350/362/598/612/622` |
| `cancel()` 覆盖面 | `FireballListener.shutdown()` :455-472 | 具名 ticker 2/2 覆盖；匿名任务 0/1 覆盖 → F2 |
| `plugin.isEnabled()` 守卫 | `ArenaScoreboard` 任务创建点 :369 / :393 | 1/2 覆盖（:393 有，:369 无）→ F1 |

## 5. 逐项维度清单（8 模式 + 并发专项）

| # | 模式 | 结果 | 说明 |
|---|---|---|---|
| 1 | 返回值暴露内部状态 | 未命中 | `ArenaScoreboard` 无返回内部集合的 getter；`FireballListener` 无集合 getter |
| 2 | 同族函数守卫一致性 | **命中** | `ensureTaskRunning`（:369）vs `ensureReEnableProbeRunning`（:391-392）→ F1 |
| 3 | 数值边界（0/负/NaN/Infinity/小数） | 未命中 | `Math.max(5, refreshTicks)`（:368）、`Math.max(1, frameTicks)`（:244）、`t++ >= 10`（:616）均闭合 |
| 4a | 原型链/裸下标 | 不适用 | 无外部字符串当 map 键的查表 |
| 4b | 假值 vs 缺值 | 未命中 | `updateTask != null && !isCancelled()`（:363）、`reEnableProbeTask != null`（:389）均为显式 null 判定 |
| 4c | NaN/Infinity/小数 | 未命中 | 调度周期均来自 int 配置并 `Math.max` 夹取 |
| 4d | 嵌套结构校验 | 不适用 | 无嵌套外部结构解析 |
| 5 | 能力是否真实现（取消/关闭） | **命中** | `shutdown()` 声称「停止全局任务」（:451-452）但匿名每爆任务不在覆盖内 → F2 |
| 6 | 转义/编码顺序 | 不适用 | 无编码/转义 |
| 7 | 边界符号（负数/下标） | 未命中 | `ENTRIES[MAX_LINES]` 静态初始化边界正确（:68-72） |
| 8 | 引用绑定是否存在 | 未命中 | 两文件 import 与使用一致（`BukkitRunnable`、`BukkitTask`、`ConcurrentHashMap` 均已导入） |
| C1 | 异步体里调 Bukkit 世界/记分板 API | 未命中 | 5 文件无异步调度（§4） |
| C2 | 异步线程读写普通 HashMap/ArrayList | 未命中 | 共享集合全为 CHM；`List<DisplayConfig.Line> cachedLayout` 仅主线程读写 |
| C3 | 取消/重载时任务是否 `cancel()`；句柄是否泄漏 | **命中** | 见 F1、F2 |
| C4 | 关闭后回调是否仍触碰世界/实体 | **命中（弱）** | 匿名任务持有 `world`/`impact`，见 F2 的 alternatives 第 2 条 |
| C5 | 跨 tick 状态用 `System.currentTimeMillis()` 还是 tick；`++/--` 非原子 | 未命中 | 冷却用 `Bukkit.getCurrentTick()`（:146、:258）；`state.ticks += 2`（:381）、`tickCounter += refreshPeriodTicks`（:529）均在单条任务体内，天然串行 |
| C6 | 检查后执行（check-then-act）跨线程 | 未命中 | `ensureCooldownTickerRunning`（:139）、`ensureTrailTickerRunning`（:348）的 `volatile` 标志只在主线程调用点被触达，无第二线程证据 |

## 6. 自检记录

1. **标识符对账**：对账 `show/hide/clear/cleanupPlayer/ensureTaskRunning/stopTask/ensureReEnableProbeRunning` 的定义与调用点（`ArenaInstance:343/449/575/611/685/1421`、`HilltopVillagePlugin:578`），无「定义了零调用」的方法；对账「任务句柄字段」与「被调度的任务」：`cooldownTicker`、`trailTicker` 有字段且被 `shutdown()` 取消，`:612` 匿名任务无字段（差集 1 条 → F2）；对账 `isEnabled()` 守卫：`:393` 有、`:369` 无（差集 1 条 → F1）。
2. **自带自检抽验**：仓库有 `src/test/java/com/hilltopvillage/mechanics/FireballListenerTest.java`。抽验结论：`@AfterEach shutDownListener()` 调 `listener.shutdown()`（:131-133），且 `setUp` 注释明写「近炸检测也关掉：即使将来 ticker 路径通了，也不会走到 triggerExplosion 的粒子」（:89）——即自带测试**主动绕开**了本产物 F2 的路径，`ArenaScoreboard` 无对应测试类。故两条发现都没有既有测试覆盖，测试全绿不能反驳它们。未执行测试（见第 3 项）。
3. **运行时验证**：**SKIPPED**。原因：`pom.xml` 项目的 `mvn test/package` 会写 `target/`，违反任务书「零写入、不跑 maven/gradle 构建」；且复现 F1/F2 需要可启动的 Paper 服务器与禁用窗口时序，本回合无此环境。故两条发现的运行时分支（`IllegalPluginAccessException`、任务不可取消）均未实测，已按 `evidence-policy.md` §3 降级为 LOW 并在 alternatives 中写明证伪路径。

## 7. 零写入声明

本回合只执行 `read` / `grep` / `glob`，未在被审仓库内创建、修改、删除任何文件，未执行 `git` 写命令，未运行构建。唯一写入是本产物文件（位于框架 `.run-dsh3/artifacts/`，不在被审仓库内）。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "audit-slice-20-concurrency",
  "role": "audit",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:\\Projects\\AI prompt\\many-agents_multi-prompt-files_token-heavy\\multi-agent-audit-framework\\.run-dsh3\\artifacts\\round1-02-audit-slice-20-concurrency.md",
  "payload": {
    "findings": [
      {
        "finding_id": "F-slice-20-concurrency-01",
        "severity": "LOW",
        "dimension": "concurrency",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/mechanics/ArenaScoreboard.java",
          "line": 369,
          "quote": "updateTask = Bukkit.getScheduler().runTaskTimer(plugin, this::refreshAll, refreshPeriodTicks, refreshPeriodTicks);"
        },
        "inference": {
          "claim": "ensureTaskRunning() 在向调度器注册刷新任务前没有判 plugin.isEnabled()，而同类的 ensureReEnableProbeRunning()（:391-392）显式挡住禁用阶段；一旦 show() 落在插件禁用窗口内，runTaskTimer 会抛 IllegalPluginAccessException 并沿 show -> addPlayer/rejoin 冒到调用方，此时 boards 已 put、player.setScoreboard 已执行，形成「板挂上了但任务没起来」的半完成状态。",
          "basis": "调用链：ArenaInstance:343（addPlayer 内）与 ArenaInstance:575（rejoin 末尾）调用 arena.getScoreboard().show(player)，show() 在 :300 boards.put、:304 player.setScoreboard(board)、:309 refresh(...) 之后于 :310 调 ensureTaskRunning()，后者 :369 直接 runTaskTimer 且无 try/catch；同文件 :389-392 的姊妹方法用 `if (!plugin.isEnabled()) return;` 挡同一场景，证明该类自己承认禁用阶段不可调度。异常抛出时 :300/:304 的副作用已生效，:369 的任务未创建，故为半完成状态而非无损失败。",
          "alternatives": [
            "如果禁用窗口内不存在任何 show() 调用方（当前两个调用点 :343/:575 都在玩家加入/重连路径，禁用期间不产生新加入），则该异常当前不可达，本条只是潜在陷阱——需检查 ArenaInstance.java:343 与 :575 的完整上游（joinArena / rejoin 的触发事件）是否只由主线程在线事件驱动",
            "如果 CraftScheduler 对禁用插件的 runTaskTimer 不是抛 IllegalPluginAccessException 而是静默返回空任务/已取消任务，则「异常外抛」不成立，影响退化为任务不运行——需核对 Paper 版本 CraftScheduler.runTaskTimer 的 isEnabled 判定分支"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "F-slice-20-concurrency-02",
        "severity": "LOW",
        "dimension": "concurrency",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/mechanics/FireballListener.java",
          "line": 612,
          "quote": "new BukkitRunnable() {\n            int t = 0;\n            @Override\n            public void run() {\n                if (t++ >= 10) { cancel(); return; }\n                world.spawnParticle(Particle.FLAME, impact.clone().add(0, 0.1, 0),\n                        3, 1.0, 0.05, 1.0, 0.01);\n                world.spawnParticle(Particle.SMOKE, impact.clone().add(0, 0.2, 0),\n                        2, 0.8, 0.1, 0.8, 0.01);\n            }\n        }.runTaskTimer(plugin, 0L, 2L);"
        },
        "inference": {
          "claim": "triggerExplosion 每次爆炸都新建一条匿名 BukkitRunnable 并以 runTaskTimer(plugin, 0L, 2L) 调度，返回的 BukkitTask 没有赋给任何字段；同类两条全局 ticker 都有字段句柄（:74 cooldownTicker、:78 trailTicker）并在 shutdown()（:455-472）里 cancel，唯此一条无句柄、不可取消，闭包持续持有 world 与 impact 直到第 11 次回调自停。",
          "basis": "控制流：onProjectileHit(:477) 与 tickTrails(:404-405) 都调用 triggerExplosion(:502)，其末尾即 :612-622 的匿名类 + runTaskTimer；赋值目标位置为空（chain 直接调用），本文件字段声明区（:74-79）只有 cooldownTicker/trailTicker 两个句柄；shutdown() 只对这两个字段 cancel 并清空 activeTrails，未涉及匿名任务。任务体自身只在 t++ >= 10 时 cancel，即约 20 tick 生命周期，期间不校验 isRunningArena，故竞技场结束/重置后仍会向 impact 坐标发粒子。并发维度关注点是「任务生命周期无人持有」，不是粒子本身的视觉效果。",
          "alternatives": [
            "如果 Bukkit 在插件 disable 时由 CraftScheduler 统一取消该插件的全部任务（PluginDisableEvent 路径），则 shutdown() 未持有句柄不会造成跨 disable 泄漏，影响仅限「竞技场结束到任务自停之间的最多 20 tick」——需核对 Paper 的 CraftScheduler 对 PluginDisableEvent 的处理",
            "如果竞技场世界在整个服务器生命周期内从不 unload（本仓库用 MapRestoreManager 回滚方块而非卸载 world），则「向已卸载世界发粒子」不成立，本条退化为短时调度与 GC 开销——需检查世界卸载/reload 路径是否会在任务存活的 20 tick 内发生",
            "如果爆炸速率远低于每 20 tick 一次（单发冷却 3-20 tick、单场玩家数有限），同时存活的匿名任务数始终很小，则「任务累积」在实际负载下不可观察——需用生产 TPS/实体统计或压测确认"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "F-slice-20-concurrency-03",
        "severity": null,
        "dimension": "concurrency",
        "evidence": {
          "file": null,
          "line": null,
          "quote": null
        },
        "inference": {
          "claim": "在本切片 5 个文件中没有发现「异步线程触碰 Bukkit 世界/记分板 API」或「异步线程与主线程共享普通 HashMap/ArrayList」这一类并发缺陷。",
          "basis": "对 5 个切片文件逐一检索 runTaskAsynchronously / runTaskTimerAsynchronously / CompletableFuture / new Thread / ExecutorService / synchronized，命中 0；所有调度都经 Bukkit.getScheduler() 的同步任务（ArenaScoreboard:369/393，FireballListener:155/362/598/622）；共享集合均为 ConcurrentHashMap（ArenaScoreboard:98，FireballListener:132/134），refreshAll 迭代中 remove 在弱一致迭代器下合法。全仓异步入口仅 PlayerGoodsManager:478、CommandsDocumentGenerator:467、StatsManager:640/673，均不在本切片调用链。",
          "alternatives": [
            "如果切片外存在以异步方式调用 ArenaScoreboard.show()/hide() 或 FireballListener.triggerExplosion 的入口（例如异步登录回调、跨插件 API），则上述「全部主线程」前提不成立——需对 ArenaInstance.java:343/575 的上游事件与对外公开方法做一次全仓调用方检索"
          ]
        },
        "status": "NO_EVIDENCE_FOUND"
      }
    ],
    "searched_scope": {
      "files_read": [
        "src/main/java/com/hilltopvillage/mechanics/ArenaAccessListener.java",
        "src/main/java/com/hilltopvillage/mechanics/ArenaScoreboard.java",
        "src/main/java/com/hilltopvillage/mechanics/FireballListener.java",
        "src/main/java/com/hilltopvillage/mechanics/FriendlyFireListener.java",
        "src/main/java/com/hilltopvillage/mechanics/HammerEffectRenderer.java",
        "src/main/java/com/hilltopvillage/arena/ArenaInstance.java",
        "src/main/java/com/hilltopvillage/HilltopVillagePlugin.java",
        "src/test/java/com/hilltopvillage/mechanics/FireballListenerTest.java"
      ],
      "files_in_slice": 5,
      "shared_dependencies_read": [
        "src/main/java/com/hilltopvillage/arena/ArenaInstance.java",
        "src/main/java/com/hilltopvillage/HilltopVillagePlugin.java",
        "src/test/java/com/hilltopvillage/mechanics/FireballListenerTest.java"
      ],
      "files_scanned_without_findings": [
        "src/main/java/com/hilltopvillage/mechanics/ArenaAccessListener.java",
        "src/main/java/com/hilltopvillage/mechanics/FriendlyFireListener.java",
        "src/main/java/com/hilltopvillage/mechanics/HammerEffectRenderer.java",
        "src/main/java/com/hilltopvillage/arena/ArenaInstance.java",
        "src/main/java/com/hilltopvillage/HilltopVillagePlugin.java",
        "src/test/java/com/hilltopvillage/mechanics/FireballListenerTest.java"
      ],
      "dimension_checklist": [
        { "pattern": "1 返回值暴露内部状态", "result": "未命中", "note": "ArenaScoreboard 与 FireballListener 都没有返回内部集合引用的 getter；boards/cooldowns/activeTrails 只在类内使用" },
        { "pattern": "2 同族函数守卫一致性", "result": "命中", "note": "ensureTaskRunning（ArenaScoreboard:369）无 plugin.isEnabled() 守卫，ensureReEnableProbeRunning（:391-392）有 → F-slice-20-concurrency-01" },
        { "pattern": "3 数值边界（0/负/NaN/Infinity/小数）", "result": "未命中", "note": "refreshTicks 经 Math.max(5, ...)（:368）、frameTicks 经 Math.max(1, ...)（:244）、粒子任务用 t++ >= 10（:616），调度周期均为正整数 tick" },
        { "pattern": "4a 原型链/裸下标", "result": "不适用", "note": "本切片无把外部字符串当 map key 的查表；ENTRIES 为静态数组且下标由 i < MAX_LINES 闭合" },
        { "pattern": "4b 假值 vs 缺值", "result": "未命中", "note": "任务句柄一律显式判 null 且判 isCancelled（ArenaScoreboard:363/389），未用真值判断" },
        { "pattern": "4c NaN/Infinity/小数", "result": "未命中", "note": "调度相关数值均为 int 配置或静态常量，无浮点进入 tick 计算（击退公式的浮点不参与调度）" },
        { "pattern": "4d 嵌套结构校验", "result": "不适用", "note": "无外部嵌套结构解析；DisplayConfig.Line 为 record，由配置层校验" },
        { "pattern": "5 能力是否真实现（取消/关闭）", "result": "命中", "note": "shutdown()（FireballListener:455-472）声称停止全局任务，但 :612-622 的匿名每爆任务不在覆盖内 → F-slice-20-concurrency-02" },
        { "pattern": "6 转义/编码顺序", "result": "不适用", "note": "本切片无编码/转义/模板拼接" },
        { "pattern": "7 边界符号（负数/下标）", "result": "未命中", "note": "MAX_LINES=15 与 ENTRIES 长度一致（:55、:66-72），writeLines 有超限裁尾与 WARN（:52-53 注释所述实现）" },
        { "pattern": "8 引用绑定是否存在", "result": "未命中", "note": "ArenaScoreboard/FireballListener 的 import 与使用一致（BukkitTask、BukkitRunnable、ConcurrentHashMap、NumberFormat 均已导入）" },
        { "pattern": "C1 异步体调用 Bukkit 世界/记分板 API", "result": "未命中", "note": "5 个切片文件 0 处 runTaskAsynchronously/runTaskTimerAsynchronously/裸线程；全部调度为同步任务" },
        { "pattern": "C2 异步线程读写普通 HashMap/ArrayList", "result": "未命中", "note": "共享集合为 ConcurrentHashMap（ArenaScoreboard:98，FireballListener:132/134）；cachedLayout/animFrameTicks 仅主线程 refreshAll 读写" },
        { "pattern": "C3 取消/重载时任务是否 cancel()、句柄是否泄漏", "result": "命中", "note": "具名 ticker 2/2 有句柄且 shutdown() 取消；匿名每爆任务 0/1 无句柄（F2）；刷新任务在 boards 空/clear/catch 三处 stopTask（:325/:353/:564）" },
        { "pattern": "C4 关闭后回调是否仍触碰世界/实体", "result": "命中", "note": "匿名任务闭包持有 world 与 impact 且不校验 isRunningArena（F2 的 alternatives 第 2 条给出证伪条件）" },
        { "pattern": "C5 跨 tick 状态用 tick 还是毫秒、++/-- 非原子", "result": "未命中", "note": "冷却用 Bukkit.getCurrentTick()（:146/:258）；ticks += 2（:381）与 tickCounter += refreshPeriodTicks（:529）各自只在单条同步任务体内执行" },
        { "pattern": "C6 check-then-act 跨线程", "result": "未命中", "note": "cooldownTickerRunning/trailTickerRunning 为 volatile，但 ensure* 只在主线程事件处理器调用，无第二线程证据" }
      ]
    },
    "self_checks": {
      "identifier_reconcile": {
        "status": "DONE",
        "note": "对账 show/hide/clear/cleanupPlayer/ensureTaskRunning/stopTask 的定义与调用点（ArenaInstance:343/449/575/611/685/1421，HilltopVillagePlugin:578），无零调用方法；对账任务句柄字段与被调度任务，差集=:612 匿名任务无字段（F2）；对账 isEnabled 守卫，差集=:369 缺（F1）"
      },
      "self_check_audit": {
        "status": "DONE",
        "note": "抽验 FireballListenerTest：@AfterEach 调 shutdown()（:131-133），setUp 注释明写关掉近炸检测以避开 triggerExplosion 粒子（:89），即自带测试绕开 F2 路径；ArenaScoreboard 无测试类，F1 无覆盖。未执行 mvn test（会写 target/，违反零写入）"
      },
      "runtime_validation": {
        "status": "SKIPPED",
        "note": "无法运行：mvn 构建会写 target/ 破坏被审仓库零写入约束，且复现禁用窗口需可启动的 Paper 服务器；两条发现的运行时分支均未实测，已按证据策略降级为 LOW 并在 alternatives 写出证伪检查点"
      }
    },
    "off_dimension_notes": [
      "L3（error-handling）：FireballListener:525 `catch (IllegalArgumentException ignored) {}` 吞掉 UUID.fromString 失败，throwerUuid 留 null，伤害退回无来源且无日志——归 error-handling 维度实例处置。",
      "L4（data-consistency）：FireballListener:304 对 event.getBlock().getState() 的 BlockState 快照库存扣料（:309-312），是否回写真实发射器取决于快照语义，而原版消耗已被 :302 setCancelled(true) 阻止——归 data-consistency。",
      "L5（security）：ArenaAccessListener:80 只挂 PlayerTeleportEvent 且不区分 TeleportCause，载具实体传送与场内重生复活不经过该事件——归 security。",
      "L6（logic）：FriendlyFireListener:62-67 的 resolveDamager 只识别 Player 与 Projectile，TNT/苦力怕/驯服狼返回 null 后 :46 直接放行——归 logic。",
      "可靠性（非并发，归 error-handling）：ArenaScoreboard.refreshAll 的 catch 里 stopTask() 后不再重建任务（:555-565），对局中若发生一次 RuntimeException，侧边栏会冻结到下一次 show()；这是错误恢复策略问题，不是竞态——本实例不判。",
      "设计观察（不计发现）：FireballListener 的 cooldownTickerRunning/trailTickerRunning 采用「先置 true 再调度」的写法（:140-141、:349-350），若 runTaskTimer 抛异常标志位不会回滚；但触发条件与 F1 同属禁用窗口，且当前无可达路径，仅作记录。",
      "粒子/性能（归 performance，不在本框架维度内）：HammerEffectRenderer 三档特效调用次数已从 375 降到 210（类注释 :35-37），本实例只确认其无可变共享状态与调度，不评视觉/性能取舍。"
    ]
  },
  "error": null
}
```
