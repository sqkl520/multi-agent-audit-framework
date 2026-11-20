# slice-21 宽扫（mechanics：锤 / 大厅保护 / 地图回滚 / 节点）

- status: COMPLETE
- trace_id: trace-r1-20260215-hilltop-dsh3
- round_id: round1
- slice_id: slice-21
- reachability: PROD（`MapRestoreManager` 在 `HilltopVillagePlugin.onEnable()` 注册为监听器，`ArenaInstance` / `ArenaResetService` 直接调用其 restore API）
- 扫描方式：4 个切片文件全文 read（逐行），另用 grep 做浅层引用检索判可达性（未读切片外文件）

## 0. 范围核对（任务书行数 vs 实测）

| 文件 | 任务书行数 | 实测（read / LF 计数） | 结论 |
|---|---|---|---|
| `HammerListener.java` | 553 | 634 | 派发行数偏低（差 81 行，含大量 Javadoc） |
| `LobbyProtectionListener.java` | 未给 | 281 | — |
| `MapRestoreManager.java` | 599 | 768 | 派发行数偏低（差 169 行）；本报告行号以实测 read 为准 |
| `NodeListener.java` | 未给 | 321 | — |

## 1. 针对任务书重点的核查结论（先写否决项，避免下游重复劳动）

1. **异步线程碰世界**：本切片**没有** `runTaskAsynchronously` / `CompletableFuture` / 自建 `Executor`。`MapRestoreManager` 的公开入口 `restoreWithResult` / `restoreNow` / `restoreAllNow` 均先调 `requirePrimaryThread()`（第 763 行），回滚统一走 `Bukkit.getScheduler().runTaskTimer`（第 563–564 行）。**「异步线程 setBlockData」这一假设在本切片不成立。**
2. **快照文件落盘/读取的原子性**：`MapRestoreManager` 的回滚日志是**纯内存**结构（`journals`，第 123 行），没有任何快照文件写入或读取；第 638–641 行注释明确「journal 只存在于内存：一旦这里没能把方块改回去，条目就会随进程消失」。**「快照文件原子性」这一假设在本切片不成立**（仓库内确有异步 YAML 写盘，但在 `PlayerGoodsManager` / `StatsManager`，不在本切片）。
3. **`getClickedInventory` 判空 / `InventoryClickEvent`**：本切片的 4 个文件**都没有** `InventoryClickEvent` 或 `InventoryOpenEvent` 监听器，因此没有 `getClickedInventory()` 调用点可供判空。大厅容器防护只做了 `PlayerInteractEvent`（RIGHT_CLICK_BLOCK）+ `Material.isInteractable()` 判定，见 L5 的相邻缺口（村民商人界面）。
4. **`restoreStarted` 复位**：`MapRestoreManager` 没有名为 `restoreStarted` 的字段；等价状态是 `activeRestores`（第 145 行）。其唯一移除点是 `complete()`（第 682 行），此即 L1 的成立基础。另注：`journals` 的移除用 `journals.remove(worldName, journal)`（第 540 行）做值比对，单线程下不会失败，第 541 行的递归分支实际不可达（非缺陷，仅记录）。
5. **同一世界并发回滚**：`restoreWithResult` 在入口用 `activeRestores.get(worldName)` 做合并（第 515–520 行），配合主线程断言，**同世界并发回滚已被设计性阻止**；`RestoreOperation` 的计数器（第 582–583 行）也按 operation 隔离。不构成线索。

## 2. Leads

### L1 — 回滚定时任务异常逃逸后 `activeRestores` 永不复位（concurrency，MEDIUM）

`restoreBatch` 在 `restoreRange` 之后才调 `complete()`（第 576 行），而 `runTaskTimer` 的 lambda 没有任何 try/catch（第 563–564 行）。`restoreBlock` 只捕获 `RuntimeException`（第 612 行），`complete()` → `requeueFailedBlocks`（第 731 行 `journals.computeIfAbsent`）→ `runCompletion` 之外的路径（如 OOM、`plugin.getLogger()` 在 disable 后抛 `IllegalStateException`、`operation.entries.get` 越界）一旦抛出：Bukkit 调度器会取消该重复任务，而 `complete()` 永不执行 → `activeRestores` 中该世界的条目、`isRestoring()==true`、`resolveJournal()` 恒返回 null（第 268 行）永久保持。下游 `ArenaInstance` 的多处 `isRestoring(...)` 门（292/734/1036/1092/1242 行）会一直把该竞技场当作「回滚中」。

### L2 — 回滚顺序是哈希序 + 关闭物理，悬空方块/流体被原样写回（data-consistency，MEDIUM）

`new ArrayList<>(journal.entrySet())`（第 549 行）取的是 `ConcurrentHashMap` 的哈希序，不是 Y 轴自下而上；`setBlockData(..., false)`（第 610 行）关闭物理。于是「沙/砾石柱底下被挖空」「水/熔岩被截断」这类快照会以无支撑状态写回，且不会触发后续物理更新——回滚报告 success，地图却不是原图。

### L3 — `TileState.update` 失败被永久重排队，无重试上限/死信（error-handling，MEDIUM）

第 611 行把 `update(true, false)` 的布尔值直接当作整块的成功判据。失败条目进 `failedEntries`（第 588 行），`complete()` 里 `requeueFailedBlocks` 无条件写回 journal（第 733–735 行），而 `success = failedBlocks == 0 && !truncated`（第 713 行）恒为 false。没有任何「重试 N 次后隔离/告警升级」的出口，同一坐标会在每次回滚重复失败，调用方的屏障（arena ENDING）永远不解除。

### L4 — 猛击取消路径不撤销「落地免伤」副作用（logic，MEDIUM）

`onFallDamage` 只要 `data.isSmashActive()` 就取消落地伤害（第 344–345 行），而 `executeSmash` 在换手/丢锤时静默放弃（第 357–360 行：`deactivateSmash` + return，不扣次数、不进冷却）。蓄力态按玩家存、不绑物品，因此「空中开锤 → 落地前换手」可以在伤害事件已取消后无成本放弃本次猛击，等于一段可重复的落地免伤窗口。冷却只在 `executeSmash` 成功路径写入（第 382–385 行），不覆盖此分支。

### L5 — 大厅只拦盔甲架/展示框，村民商人界面仍可打开（contract，MEDIUM）

第 241 行只对 `ArmorStand` / `ItemFrame` 生效，`Villager` 不在其中；而类注释第 39 行声称「容器交互全部被阻止」，第 38 行声称「商店 NPC」。结果是：大厅内右键商店村民可打开交易界面（`MERCHANT` inventory），与 `onEntityDamage` 里对 `Villager` 的保护口径（第 250–251 行）不一致，也不受 `isBuildMode` 之外任何门控。这是大厅保护矩阵里唯一未覆盖的容器型交互入口。

### L6 — 节点方块的「自爆源方块」不在 blockList，过滤不覆盖（data-consistency，LOW）

`filterNodeBlocks` 只从 `blockList` 里剔除节点方块（第 169 行），且不取消事件。重生锚/床的充能爆炸走 `BlockExplodeEvent`，其**源方块**是 `event.getBlock()` 而不在 `blockList()` 中，原版会把源方块置空——与第 121–123 行「保住『节点只能被怪物打空血』的设计」相悖。另注：该过滤对 `EntityExplodeEvent`/`BlockExplodeEvent` 均不 `setCancelled`，属刻意设计（保留爆炸对其它方块的效果），本条只针对源方块。

## 3. 覆盖说明

- 4 个切片文件均全文读完（HammerListener 634 / LobbyProtectionListener 281 / MapRestoreManager 768 / NodeListener 321）。
- 未读切片外文件；可达性仅用 grep 命中行判定（`HilltopVillagePlugin:199` 注册监听器、`ArenaInstance:1425` 调 `restoreWithResult`、`ArenaResetService:369` 调 `restoreWithResult`）。
- 本切片无线索的维度：`security`（0 条）。锤/节点的 PDC 防伪（`isHammer` 第 162–169 行、`isRepairItem` 第 259–266 行）已删除显示名回退，未发现可伪造入口；`planRepair`（第 281–299 行）对 NaN/0/负数/持有量均做了钳制。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "sweep-slice-21",
  "role": "sweep",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/.run-dsh3/artifacts/round1-02-sweep-slice-21.md",
  "payload": {
    "slice_id": "slice-21",
    "reachability": "PROD",
    "generator_ref": null,
    "files_read": [
      {
        "path": "src/main/java/com/hilltopvillage/mechanics/HammerListener.java",
        "lines": 634,
        "quote": "smashCooldowns.remove(player.getUniqueId());"
      },
      {
        "path": "src/main/java/com/hilltopvillage/mechanics/LobbyProtectionListener.java",
        "lines": 281,
        "quote": "return player == null || !inLobby(player) || isBuildMode(player);"
      },
      {
        "path": "src/main/java/com/hilltopvillage/mechanics/MapRestoreManager.java",
        "lines": 768,
        "quote": "private static void requirePrimaryThread() {"
      },
      {
        "path": "src/main/java/com/hilltopvillage/mechanics/NodeListener.java",
        "lines": 321,
        "quote": "double neededCeil = Math.ceil(neededExact - Math.ulp(neededExact));"
      }
    ],
    "files_unreadable": [],
    "leads": [
      {
        "lead_id": "L1",
        "suspected_dimension": "concurrency",
        "file": "src/main/java/com/hilltopvillage/mechanics/MapRestoreManager.java",
        "line": 564,
        "quote": "plugin, () -> restoreBatch(operation), 1L, 1L);",
        "why_suspicious": "重复任务只注册裸 lambda，restoreBatch/complete 抛出未捕获异常时 Bukkit 会取消任务，而 activeRestores 的唯一移除点在 complete() 内，该世界将永久处于 isRestoring 状态。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L2",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/mechanics/MapRestoreManager.java",
        "line": 610,
        "quote": "block.setBlockData(original.blockData().clone(), false);",
        "why_suspicious": "回滚条目取自 journal.entrySet() 的哈希序（第 549 行）而非自下而上，且关闭物理，悬空沙砾与被截断的流体会以无支撑状态写回并缺少后续物理更新。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L3",
        "suspected_dimension": "error-handling",
        "file": "src/main/java/com/hilltopvillage/mechanics/MapRestoreManager.java",
        "line": 611,
        "quote": "return original.tileState() == null || original.tileState().update(true, false);",
        "why_suspicious": "TileState 更新失败被当作整块失败并整批重新入队，没有重试上限或隔离，success 恒为 false，调用方的 ENDING 屏障永远不解除。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L4",
        "suspected_dimension": "logic",
        "file": "src/main/java/com/hilltopvillage/mechanics/HammerListener.java",
        "line": 344,
        "quote": "if (data.isSmashActive()) {",
        "why_suspicious": "蓄力期间落地伤害被无条件取消，而 executeSmash 在换手时静默放弃且不写冷却，免伤副作用已在伤害事件中生效，形成可重复的无成本免摔落窗口。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L5",
        "suspected_dimension": "contract",
        "file": "src/main/java/com/hilltopvillage/mechanics/LobbyProtectionListener.java",
        "line": 241,
        "quote": "if (!(target instanceof ArmorStand) && !(target instanceof ItemFrame)) return;",
        "why_suspicious": "只拦盔甲架与展示框，村民商人右键仍可打开交易界面，与类注释「容器交互全部被阻止」及对 Villager 的伤害保护口径不一致。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L6",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/mechanics/NodeListener.java",
        "line": 169,
        "quote": "blockList.removeAll(blocksToRemove);",
        "why_suspicious": "只从 blockList 剔除节点方块且不取消事件，床/重生锚自身爆炸时源方块不在 blockList 内，节点方块仍会被移除，与「节点只能被怪物打空血」的注释相悖。",
        "confidence": "LOW"
      }
    ],
    "lead_count": 6,
    "dimension_histogram": {
      "logic": 1,
      "concurrency": 1,
      "security": 0,
      "error-handling": 1,
      "data-consistency": 2,
      "contract": 1
    }
  },
  "error": null
}
```
