# slice-20 宽扫（round1 / Hilltop Village）

- status: COMPLETE
- trace_id: trace-r1-20260215-hilltop-dsh3
- round_id: round1
- slice_id: slice-20
- role: sweep（只出线索，不判严重性，不做证据链）

## 0. 范围偏差（先声明）

任务书给的行数与实测不一致，按实测审计：

| 文件 | 任务书写 | 实测（read 工具末行号） |
|---|---|---|
| `ArenaAccessListener.java` | — | 83 |
| `ArenaScoreboard.java` | 699 | **908** |
| `FireballListener.java` | 529 | **665** |
| `FriendlyFireListener.java` | — | 69 |
| `HammerEffectRenderer.java` | — | 191 |

## 1. 可达性判定：PROD

浅层引用检查（grep 全仓库 `*.java`，未读切片外文件）：

- `HilltopVillagePlugin.java:154` `this.fireballListener = new FireballListener(this);`；`:194` 注册 `FriendlyFireListener`；`:198` 注册 `ArenaAccessListener` → 三个监听器都由插件主类注册到 `PluginManager`。
- `ArenaInstance.java:153` `this.scoreboard = new ArenaScoreboard(plugin, this);`；`:1582` `public ArenaScoreboard getScoreboard()` → 每实例持有，生命周期跟随竞技场。
- `HammerListener.java:576-580` 调用 `HammerEffectRenderer.spawn{High,Medium,Low}TierEffect(location)`。
- `FireballListener` 另被 `HilltopCommandHandler.java:370`、`ShopManager.java:183` 作为物品工厂使用。

结论：五个文件均可从生产入口（插件 `onEnable` → 事件注册 / 命令 / 商店 / 锤子技能）到达，标 `PROD`。

## 2. 重点问题的直接回答

| 重点 | 观察 |
|---|---|
| 监听器里是否直接改世界/实体 | 是。`FireballListener` 在事件与 ticker 里直接 `spawnParticle` / `damage` / `setFireTicks` / `setVelocity`；`FriendlyFireListener` 直接 `setCancelled`；`ArenaAccessListener` 直接 `setCancelled`。均在主线程事件/task 内，未发现异步触碰 Bukkit 世界状态。 |
| `ArenaScoreboard` 的 `runTaskTimer` 是否在退出/结束后取消 | 有取消路径：`hide()` 在 `boards` 空时 `stopTask()`（:325），`clear()` 同时停刷新任务与恢复探针（:353-356），`refreshAll()` 空板自停（:521-524）与异常自停（:564）。**未取消的缺口**见 L1。 |
| 是否遍历离线玩家 | `refreshAll()` 对离线残留做 `boards.remove` 而非 `continue`（:541-543），`clear()` 对离线玩家跳过 `setScoreboard`（:348），`restoreBoardsAfterReEnable()` 只遍历 `arena.getPlayers()`。未见「向离线玩家发包」。 |
| 爆炸/火焰传播是否在主线程、是否有 `runTask` | `triggerExplosion` 由 `ProjectileHitEvent` 与 `trailTicker` 调用，均在主线程；投掷者击退用 `Bukkit.getScheduler().runTask(plugin, ...)` 延后 1 tick（:598），命中残留粒子用 `runTaskTimer(..., 0L, 2L)`（:622）。无异步爆炸。 |
| `getScoreboard()` 的 team/objective 增删竞态 | team/objective 都注册在 `Bukkit.getScoreboardManager().getNewScoreboard()` 得到的**每玩家私有板**上，`writeLines` 的 `registerNewTeam("line"+i)` 不跨玩家共享；`show()/hide()/clear()` 都用 `player.getScoreboard() == state.board` 身份守卫。未发现跨玩家 team 键冲突；剩余可疑点见 L1。 |
| 事件取消遗漏 | `FriendlyFireListener` 只覆盖「玩家 / 弹射物」两种 damager（L6）；`ArenaAccessListener` 只挂 `PlayerTeleportEvent`（L5）。 |

## 3. 线索（6 条）

### L1 — 刷新任务在插件禁用阶段仍会被调度
`ArenaScoreboard.ensureTaskRunning()` 直接 `runTaskTimer`，而同类的 `ensureReEnableProbeRunning()`（:391-392）显式用 `plugin.isEnabled()` 挡住禁用阶段并写明理由。`show()` 是公开入口（`ArenaInstance` 的加入/重连路径会调），退出/重连事件若落在禁用窗口，`runTaskTimer` 抛 `IllegalPluginAccessException` 会沿 `show()` 冒到事件处理器。

### L2 — 每次爆炸新建一条无人持有的重复任务
`triggerExplosion` 末尾 `new BukkitRunnable(){...}.runTaskTimer(plugin, 0L, 2L)`：句柄不保存、不可取消，闭包持有 `world` 与 `impact`；竞技场结束或世界卸载后该任务仍会跑满 10 次（`t == 10` 才自停）。同类其它 ticker 都有字段句柄 + `shutdown()` 取消，唯此一条例外。

### L3 — 投掷者 UUID 解析失败被空 catch 吞掉
`UUID.fromString(val)` 失败时进 `catch (IllegalArgumentException ignored) {}`，既不记日志也不降级标记；后续 `throwerUuid` 保持 null，伤害退回无来源路径，击杀统计归零且现场无任何痕迹。

### L4 — 发射器扣料作用在 `BlockState` 快照的库存上
`dispenser` 来自 `event.getBlock().getState()`（:299 的 `instanceof` 模式变量），随后 `dispenser.getInventory()` 拿到的库存属于方块状态快照；扣料（:309-312）与 `inv.setItem(i, null)` 是否回写到真实发射器取决于快照语义——若不回写则烈焰蛋不被消耗（无限弹药），且事件已被 `setCancelled(true)`，原版消耗路径也不会执行。

### L5 — 世界准入只挂传送事件，且对所有 cause 一律取消
`onTeleport` 只处理 `PlayerTeleportEvent`，`event.setCancelled(true)` 不区分 `TeleportCause`；玩家被载具（船/猪）带走触发的实体传送、以及竞技场世界内的重生点复活不走该事件，「非成员不得在竞技场世界」的世界级不变量存在绕过面。

### L6 — 友伤门控只认玩家与弹射物
`resolveDamager` 对 `Player` 与 `Projectile` 之外的 damager 一律返回 null，随后 `if (damager == null ...) return;` 直接放行；TNT/苦力怕/玩家驯服的狼等非弹射物来源可以打伤同场队友，与类注释宣称的「零友伤」不一致。

## 4. 未列为线索但已核对

- `ArenaScoreboard.refreshAll()` 在 `boards.entrySet()` 迭代中 `boards.remove(...)`（:536-543）：`boards` 是 `ConcurrentHashMap`，弱一致迭代器允许该操作，**不构成 CME**，故不出线索。
- `FireballListener` 的 `cooldowns` / `activeTrails` 均为 `ConcurrentHashMap`，`entrySet().removeIf` 与 `it.remove()` 都合法。
- `HammerEffectRenderer` 三处 `location.getWorld()` 未判空（如 :65），但调用方 `HammerListener` 传的是玩家命中点，世界必然存在；证据不足，未出线索。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "sweep-slice-20",
  "role": "sweep",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:\\Projects\\AI prompt\\many-agents_multi-prompt-files_token-heavy\\multi-agent-audit-framework\\.run-dsh3\\artifacts\\round1-02-sweep-slice-20.md",
  "payload": {
    "slice_id": "slice-20",
    "reachability": "PROD",
    "generator_ref": null,
    "files_read": [
      {
        "path": "src/main/java/com/hilltopvillage/mechanics/ArenaAccessListener.java",
        "lines": 83,
        "quote": "public void onTeleport(PlayerTeleportEvent event) {"
      },
      {
        "path": "src/main/java/com/hilltopvillage/mechanics/ArenaScoreboard.java",
        "lines": 908,
        "quote": "private void refreshAll() {"
      },
      {
        "path": "src/main/java/com/hilltopvillage/mechanics/FireballListener.java",
        "lines": 665,
        "quote": "private void triggerExplosion(Snowball projectile, Location impact, FireballSnapshot cfg) {"
      },
      {
        "path": "src/main/java/com/hilltopvillage/mechanics/FriendlyFireListener.java",
        "lines": 69,
        "quote": "public void onEntityDamage(EntityDamageByEntityEvent event) {"
      },
      {
        "path": "src/main/java/com/hilltopvillage/mechanics/HammerEffectRenderer.java",
        "lines": 191,
        "quote": "public static void spawnHighTierEffect(Location location) {"
      }
    ],
    "files_unreadable": [],
    "leads": [
      {
        "lead_id": "L1",
        "suspected_dimension": "concurrency",
        "file": "src/main/java/com/hilltopvillage/mechanics/ArenaScoreboard.java",
        "line": 369,
        "quote": "updateTask = Bukkit.getScheduler().runTaskTimer(plugin, this::refreshAll, refreshPeriodTicks, refreshPeriodTicks);",
        "why_suspicious": "ensureTaskRunning 未像 ensureReEnableProbeRunning 那样先判 plugin.isEnabled()，禁用窗口内 show() 会向已停服的调度器注册任务",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L2",
        "suspected_dimension": "concurrency",
        "file": "src/main/java/com/hilltopvillage/mechanics/FireballListener.java",
        "line": 622,
        "quote": "}.runTaskTimer(plugin, 0L, 2L);",
        "why_suspicious": "每次爆炸匿名新建重复任务且不保句柄，竞技场结束/世界卸载后无法取消，任务仍会跑满 10 次并持有 world/impact",
        "confidence": "LOW"
      },
      {
        "lead_id": "L3",
        "suspected_dimension": "error-handling",
        "file": "src/main/java/com/hilltopvillage/mechanics/FireballListener.java",
        "line": 525,
        "quote": "} catch (IllegalArgumentException ignored) {}",
        "why_suspicious": "UUID.fromString 失败被空 catch 静默吞掉，throwerUuid 留 null，伤害退回无来源且击杀统计丢失，无日志",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L4",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/mechanics/FireballListener.java",
        "line": 304,
        "quote": "org.bukkit.inventory.Inventory inv = dispenser.getInventory();",
        "why_suspicious": "dispenser 取自 event.getBlock().getState() 的方块状态快照，对其库存扣料与 setItem 可能不回写真实发射器，而原版消耗已被 setCancelled(true) 阻止",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L5",
        "suspected_dimension": "security",
        "file": "src/main/java/com/hilltopvillage/mechanics/ArenaAccessListener.java",
        "line": 80,
        "quote": "event.setCancelled(true);",
        "why_suspicious": "世界准入只挂 PlayerTeleportEvent 且不区分 TeleportCause，载具实体传送与竞技场内重生复活不经过该事件，非成员仍可进入竞技场世界",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L6",
        "suspected_dimension": "logic",
        "file": "src/main/java/com/hilltopvillage/mechanics/FriendlyFireListener.java",
        "line": 62,
        "quote": "if (damager instanceof Player player) return player;",
        "why_suspicious": "resolveDamager 只识别玩家与弹射物，TNT/苦力怕/驯服狼等来源返回 null 后直接放行，与类注释宣称的零友伤不一致",
        "confidence": "MEDIUM"
      }
    ],
    "lead_count": 6,
    "dimension_histogram": {
      "logic": 1,
      "concurrency": 2,
      "security": 1,
      "error-handling": 1,
      "data-consistency": 1,
      "contract": 0
    }
  },
  "error": null
}
```
