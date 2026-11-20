# slice-22 宽扫（concurrency + data-consistency 重点）

- status: COMPLETE
- trace_id: trace-r1-20260215-hilltop-dsh3
- round_id: round1
- slice_id: slice-22
- 被审仓库：`D:\Server\MCServers\Server plugin\Hilltop Village\Hilltop Village Plugin`（只读）
- reachability: **PROD**（NodeSystem 由 GameManager 持有、TabListManager/PlayerLifecycleListener/VillagerPreviewManager 由插件主类注册，均从生产入口可达）

## 0. 范围偏差（任务书 vs 实测，按模板 §9.4 显式记录）

| 文件 | 任务书写 | 实测（LF 计数 = read 工具显示总行数） |
|---|---|---|
| `NodeSystem.java` | 778 | **1000** |
| `TabListManager.java` | 628 | **785** |
| `PlayerLifecycleListener.java` | 无 | 209 |
| `VillagerPreviewManager.java` | 无 | 198 |

任务书两处行数均偏小约 20%，不影响切片边界（文件名一致），已按实际文件全量阅读，未抽样。
另按“确需上下文时最多再读 1 个同目录文件”的额度，加读了 `NodeListener.java`（321 行），
用于确认 `damageNode` / `repairNode` 的调用线程（结论：全部是 Bukkit 事件处理器，主线程）。

## 1. 本切片实际确认的“没有找到”的项（避免下游重复劳动）

- `NodeSystem.nodes` 是 `ConcurrentHashMap`、`activeNodes` 是 `ConcurrentHashMap.newKeySet()`；
  `loadNodesFromConfig()` 的 stale 清理走 `new ArrayList<>(nodes.entrySet())` 快照，`saveNodesToConfig()`
  也是弱一致遍历。**没有** `HashMap` 遍历中增删导致的 `ConcurrentModificationException` 路径。
- `TabListManager` 的刷新任务生命周期看起来是收敛的：`start()` 幂等（比对 `isCancelled()` 与周期）、
  `stopTask()` 置空、`restoreAll()` 末尾 `stop()`；`refreshAll()` 用 `try/catch(RuntimeException)` 包住整帧，
  且注释（第 326–341 行）明确论证了“异常后不要把句柄置空，否则会并行出第二条任务”。
  **未发现**“异常后重复注册任务”的现行缺陷（这是被修过的形态）。
- `TabListManager` 完全不碰 `player.getScoreboard()`（该类只发 tab 头尾/名字/排序包），
  “计分板线程安全”这一疑点在本文件不成立，真正的计分板在 `ArenaScoreboard`（不在本切片）。
- `TabListManager.refreshAllUnchecked()` 对 `Bukkit.getOnlinePlayers()` 快照逐人 `isOnline()` 复查
  （第 386–391 行），**没有**“遍历离线玩家并对其发包”的路径。
- `VillagerPreviewManager` 用 `CopyOnWriteArrayList` 持有实体引用，`clearInWorld` / `clearAll` /
  `onEntitiesLoad` 三条清理路径均有 PDC 键 `villager-preview` 兜底，与真村民键隔离。

## 2. 线索

### L1 — 载入期的材质校验会静默丢节点，下一次保存把文件条目永久删掉

`loadNodesFromConfig()` 对每条 YAML 记录要求“该坐标当前方块必须是 RESPAWN_ANCHOR”，否则
`continue`（不进入 `configuredLocations`）。随后第 194–200 行把所有“不在 configuredLocations 里”的
内存节点 `deactivate()` 并从 `nodes` 移除；而第 291–298 行的保存逻辑是“读文件 → 过滤掉本世界条目 →
把**内存里的** nodes 全部追加回去”。于是：只要 reload/开局那一刻方块暂时不是重生锚
（地图回滚未完成、管理员临时换方块、区块未加载导致 `getBlock()` 取到空气），该节点就会在
**没有任何持久化层删除动作**的情况下从内存消失，并在下一次任意保存时从 `nodes.yml` 里被抹掉。
日志只有一行 "Skipped invalid energy node"，不区分“配置写错”与“现场暂时不对”。

### L2 — 索引是线程安全的，被索引的对象不是

`nodes` / `activeNodes` 都用了并发容器，注释也反复以“多线程安全”为前提；但 `NodeData` 的
`currentHealth`（`double`）与 `active`（`boolean`）都是普通字段，没有 `volatile`/`synchronized`/`Atomic`，
而 `damageNode()` 的判定是典型的 check-then-act：`isRegisteredActive(node)`（跨 `activeNodes` 与 `nodes`
两次查询）通过后再 `node.damage()`、再 `activeNodes.remove()`。任何第二个线程在同一窗口结算伤害，
都会看到过期血量或重复走“摧毁”分支（重复广播 + 重复音效）。
诚实标注：本切片内的入口（`NodeListener` 的 `BlockBreakEvent`/`PlayerInteractEvent`、`BukkitRunnable`
同步任务）**全部在主线程**，所以这是“并发契约不自洽”，不是已证实的线上竞态；怪物 AI 是否在异步线程
结算伤害，需要用 `getNearestNode` 的调用方证伪/证实。

### L3 — 增益等级无上限夹取，越界会打断整轮 buff 施加

`applyBuffsToPlayer()` 把 `buffStackCap`（配置项）与节点数直接相加得到 `finalAmplifier`，没有任何
0–255 夹取，也没有对 `buffStackCap` 为负/超大值的防御（`loadConfig()` 只是原样 `cfg.getNodeBuffStackCap()`）。
`PotionEffect` 的 amplifier 越界会抛 `IllegalArgumentException`，而这段代码在 `buffTask.run()` 里、
没有 try/catch —— 一轮里第一个玩家抛异常，该轮后续所有玩家都拿不到增益，且每个刷新周期重复抛一次。
配置来自 GUI/`nodes.buff-stack-cap`，属管理员可写入口。

### L4 — 同一帧里对 `getGameManager()` 的判空口径不一致，NPE 会吞掉全服这一帧的 tab 刷新

`viewOf()` 明确写了 `gameManager == null ? null : ...`（第 694 行），说明作者认为
`arena.getGameManager()` 可能为 null；但 `resolveArg()` 的 `activeNodes` / `totalNodes` /
`aliveVillagers` / `totalVillagers` 四个分支只判了 `arena == null`，直接
`arena.getGameManager().getNodeSystem()`。一旦某个竞技场实例存在而 GameManager 尚未装配
（未启用/正在重置的竞技场仍在 `MultiArenaManager` 里），`display.yml` 里任何一行引用
`{activeNodes}` 都会让 `refreshAllUnchecked()` 整体抛出，被 `refreshAll()` 的 catch 吃掉后
**这一帧所有玩家的头/尾与名字都不再更新**，且每周期复现。

### L5 — 死亡处理对“非参赛者”也清掉落并锁背包

`onDeath()` 只对 `PlayerData` 做了判空（`data != null` 才记死亡/清蓄力），但其后的
`event.getDrops().clear()` / `setKeepInventory(true)` / `setDroppedExp(0)` 以及
`broadcastDeath()` / `checkTeamWipe()` 都是无条件的。处于该竞技场世界、但不在
`playerDataMap` 里的玩家（刚被移出对局的、旁观转生存的管理员、结算窗口内的残留成员）
死亡时会：掉落被清空、经验归零、全服播一条“玩家阵亡”。这与“只有参赛者的死亡才计入对局”的
口径不一致，且清掉落是不可逆的数据损失。

### L6 — 失效实体引用被静默剔除，实体本体仍留在存档里

`clearInWorld()` 的 `removeIf` 把 `!villager.isValid()` 的引用直接从内存列表剔除，但**没有**
`villager.remove()`。预览实体是 `setPersistent(true)` + `setRemoveWhenFarAway(false)`，
区块卸载后 `isValid()` 即为 false —— 此时引用被丢掉、实体还在世界存档里，之后
`clearInWorld` 再也看不到它。现存的兜底只有两条：`onEntitiesLoad`（区块重新加载时按 PDC 删）
与 `cleanupOrphans`（仅开服跑一次）。若该实体所在的区块在对局期间被加载、而
`EntitiesLoadEvent` 因任何原因未覆盖（例如实体随区块生成阶段一并载入），预览村民就会
以“无敌 + 无 AI + 有自定义名”的形态残留在对局世界里。

## 3. 覆盖说明

| 文件 | 读法 | 用于 |
|---|---|---|
| `NodeSystem.java` | 全文 1–1000 | L1 L2 L3 |
| `TabListManager.java` | 全文 1–785 | L4 |
| `PlayerLifecycleListener.java` | 全文 1–209 | L5 |
| `VillagerPreviewManager.java` | 全文 1–198 | L6 |
| `NodeListener.java`（上下文，额度内 1 个） | 全文 1–321 | 确认 L2 的调用线程 |

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "sweep-slice-22",
  "role": "sweep",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/.run-dsh3/artifacts/round1-02-sweep-slice-22.md",
  "payload": {
    "slice_id": "slice-22",
    "reachability": "PROD",
    "generator_ref": null,
    "files_read": [
      {
        "path": "src/main/java/com/hilltopvillage/mechanics/NodeSystem.java",
        "lines": 1000,
        "quote": "private final ConcurrentHashMap<Location, NodeData> nodes;"
      },
      {
        "path": "src/main/java/com/hilltopvillage/mechanics/TabListManager.java",
        "lines": 785,
        "quote": "private final Map<UUID, Component> lastHeader = new ConcurrentHashMap<>();"
      },
      {
        "path": "src/main/java/com/hilltopvillage/mechanics/PlayerLifecycleListener.java",
        "lines": 209,
        "quote": "public class PlayerLifecycleListener implements Listener {"
      },
      {
        "path": "src/main/java/com/hilltopvillage/mechanics/VillagerPreviewManager.java",
        "lines": 198,
        "quote": "private final List<Villager> previews = new CopyOnWriteArrayList<>();"
      },
      {
        "path": "src/main/java/com/hilltopvillage/mechanics/NodeListener.java",
        "lines": 321,
        "quote": "static RepairPlan planRepair(double deficit, double perItem, int maxPerAction, int held) {"
      }
    ],
    "files_unreadable": [],
    "leads": [
      {
        "lead_id": "L1",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/mechanics/NodeSystem.java",
        "line": 180,
        "quote": "if (actualType != Material.RESPAWN_ANCHOR) {",
        "why_suspicious": "载入时按当前方块材质跳过节点，随后内存清理会把该节点移出 nodes，而保存逻辑只回写内存里的节点，等于用一次读失败静默删掉 nodes.yml 中的持久条目。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L2",
        "suspected_dimension": "concurrency",
        "file": "src/main/java/com/hilltopvillage/mechanics/NodeSystem.java",
        "line": 698,
        "quote": "double actualDamage = Math.min(damage, node.getCurrentHealth());",
        "why_suspicious": "并发容器里的 NodeData 用普通 double/boolean 存血量与存活态，damageNode 先跨两个集合做 isRegisteredActive 判定再改状态，是典型的 check-then-act 窗口。",
        "confidence": "LOW"
      },
      {
        "lead_id": "L3",
        "suspected_dimension": "error-handling",
        "file": "src/main/java/com/hilltopvillage/mechanics/NodeSystem.java",
        "line": 831,
        "quote": "int finalAmplifier = baseAmplifier + effectiveAmplifier;",
        "why_suspicious": "增益等级由配置值与节点数相加得出且无 0-255 夹取，越界时 PotionEffect 抛 IllegalArgumentException，而这段代码位于无 try/catch 的周期任务体内。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L4",
        "suspected_dimension": "error-handling",
        "file": "src/main/java/com/hilltopvillage/mechanics/TabListManager.java",
        "line": 739,
        "quote": ": arena.getGameManager().getNodeSystem().getActiveCount());",
        "why_suspicious": "viewOf 对 getGameManager() 判了 null，同一文件的 resolveArg 却直接链式调用，实例存在而 GameManager 未装配时会让整帧刷新抛异常并跳过所有玩家。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L5",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/mechanics/PlayerLifecycleListener.java",
        "line": 95,
        "quote": "event.getDrops().clear();",
        "why_suspicious": "清掉落与 keepInventory 在 playerData 判空之外无条件执行，不属于本局 playerDataMap 的玩家在竞技场世界死亡也会被清空掉落并广播阵亡。",
        "confidence": "LOW"
      },
      {
        "lead_id": "L6",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/mechanics/VillagerPreviewManager.java",
        "line": 122,
        "quote": "previews.removeIf(villager -> villager == null || !villager.isValid()",
        "why_suspicious": "清理只把失效引用从内存列表剔除而不移除实体本体，persistent 且不远离消失的预览村民会留在存档里，仅靠 EntitiesLoadEvent 与开服一次的 cleanupOrphans 兜底。",
        "confidence": "LOW"
      }
    ],
    "lead_count": 6,
    "dimension_histogram": {
      "logic": 0,
      "concurrency": 1,
      "security": 0,
      "error-handling": 2,
      "data-consistency": 3,
      "contract": 0
    }
  },
  "error": null
}
```
