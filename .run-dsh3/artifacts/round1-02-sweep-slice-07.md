# slice-07 宽扫：MultiArenaManager

- status: COMPLETE
- slice_id: slice-07
- trace_id: trace-r1-20260215-hilltop-dsh3
- round_id: round1
- file: `src/main/java/com/hilltopvillage/arena/MultiArenaManager.java`（1153 行，单文件切片，shared_dependencies 无）
- 维度：logic / concurrency / security / error-handling / data-consistency / contract 一次快扫，不判严重性

## 可达性

`PROD`。该类被生产入口直接引用：`HilltopVillagePlugin:128` 构造 `new MultiArenaManager(this)`，命令层（`HilltopCommandHandler`、`ArenaCommand`、`SetupWizard`）、监听器（`PlayerLifecycleListener`、`ArenaAccessListener`、`FireballListener`、`LobbyProtectionListener`）、`GameManager` / `NpcManager` / `MapRestoreManager` 均调用其方法；另有大量测试引用，但生产引用已足以判 PROD。

## 快扫记录（6 维度）

| 维度 | 看过的位置 | 结论 |
|---|---|---|
| concurrency | 90/319/615 三处 `runTaskTimer`；34–62 全部 `ConcurrentHashMap` | 任务均在主线程；未发现异步线程碰 Bukkit 状态。`enableQueue` 是普通 `LinkedList`，只在主线程命令与定时任务里改，未构成线索 |
| data-consistency | `leaveArena` 766–772、`expirePendingRejoins` 94–117、`stopAllArenasNow` 535–550 | 两处顺序/清理缺口 → L1、L2 |
| error-handling | 94–117 扫描循环、362/642 管理器解引用、386–394 构造兜底 | → L4、L5（构造处已有 try/catch，不算线索） |
| logic | `processEnableQueue` 328–395、`processRetiredArenas` 632–667、`countByState` 1139–1152 | 隔离期每 tick 轮询重排 → L3；`countByState` 的分桶契约已在 javadoc 说明，未列线索 |
| contract | `enableArena` / `disableArena` / `joinArena` / `resolveArena(Id)` 的 ID 归一化 | 四处都做了归一化，未见签名与调用方明显不匹配 |
| security | 本类无权限判定、无玩家输入进路径/经济数值 | 未发现（权限在命令层） |

## Leads

### L1 映射残留时 `leaveArena` 变成空操作
`getPlayerArena` 先按 `playerArenaMap` 取 arenaId 再查 `activeArenas`，实例已被移除时返回 null；`if (arena != null)` 分支因此整段跳过，`playerArenaMap.remove` 不执行。而 `isInArena` 只看 map 是否 containsKey，于是玩家被判为「仍在竞技场」却永远清不掉——`HilltopCommandHandler:1622` 正是 `if (isInArena) leaveArena` 的写法，会形成点击即空转。

### L2 先删状态、后做副作用
`expirePendingRejoins` 在调用 `removePlayer` / `removeOfflinePlayer` **之前**就把重连记录与玩家→竞技场映射删掉。若随后调用抛异常（Bukkit 实体/世界状态异常并不罕见），记录已不可恢复：玩家仍留在实例的 players 集合里，但映射没了，既不会被下一次扫描重试，也不会再走重连；属于「部分写入」型不一致。

### L3 隔离窗口内每秒轮询重排同一场
世界仍在退役隔离或回滚时，`processEnableQueue` 把队首 `addLast` 回去并 return，但 1-tick 定时任务不停；于是一个处于 60 秒级隔离窗口的竞技场会被约 20 次/秒重新 poll + 重新做定义查找、`findWorldConflict` 全表扫描与 `isRestoring` 查询。功能上能自愈，但空转成本与日志抑制（`quarantineDeferred`）掩盖了真实重试次数。

### L4 重连扫描任务无异常隔离
`expirePendingRejoins` 整个 for 循环没有 try/catch，`arena.removePlayer(player)` 直接暴露在定时任务里。Bukkit 的 repeating task 一旦抛出未捕获异常就会被取消且不再重跑，届时所有 `pendingRejoins` 记录永久滞留（玩家卡在竞技场映射里，物品快照也不归还）。同文件 `stopAllArenasNow` / `reloadAllDeploymentData` 都做了逐项异常隔离，这里没有。

### L5 `MapRestoreManager` 解引用无 null 兜底
同文件 216 行对 `plugin.getPlayerGoodsManager()` 明确做了「初始化失败可能为 null」的兜底，但启用队列里 `plugin.getMapRestoreManager().isRestoring(...)` 与退役清理里同样的调用都直接解引用。若该管理器因启动异常为 null，1-tick 启用任务会 NPE 并停摆，启用队列整体卡死（本条为静态推断，缺运行时证据，故 LOW）。

## 覆盖声明

- 读过的文件：仅本切片 1 个文件，全文 1153 行。
- 未读切片外文件（未读 `ArenaInstance` / `ArenaManager`，因此凡涉及它们内部语义的判断一律标 LOW 或未列入）。
- 未做：严重性判定、完整证据链、构造复现。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "sweep-slice-07",
  "role": "sweep",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/.run-dsh3/artifacts/round1-02-sweep-slice-07.md",
  "payload": {
    "slice_id": "slice-07",
    "reachability": "PROD",
    "generator_ref": null,
    "files_read": [
      {
        "path": "src/main/java/com/hilltopvillage/arena/MultiArenaManager.java",
        "lines": 1153,
        "quote": "public class MultiArenaManager {"
      }
    ],
    "files_unreadable": [],
    "leads": [
      {
        "lead_id": "L1",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/arena/MultiArenaManager.java",
        "line": 768,
        "quote": "if (arena != null) {",
        "why_suspicious": "映射指向已移除实例时 getPlayerArena 返回 null，清理映射的分支被整段跳过，isInArena 永久为真而 leaveArena 永远空转。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L2",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/arena/MultiArenaManager.java",
        "line": 101,
        "quote": "pendingRejoins.remove(entry.getKey());",
        "why_suspicious": "先删重连记录与玩家映射、后调 removePlayer/removeOfflinePlayer，副作用抛异常时记录已不可恢复，玩家留在实例里却无映射。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L3",
        "suspected_dimension": "logic",
        "file": "src/main/java/com/hilltopvillage/arena/MultiArenaManager.java",
        "line": 364,
        "quote": "enableQueue.addLast(arenaId);",
        "why_suspicious": "世界仍在隔离/回滚时把队首放回队尾但 1-tick 任务不停，同一场在 60 秒级窗口内被约 20 次/秒重复 poll 并重做冲突扫描。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L4",
        "suspected_dimension": "error-handling",
        "file": "src/main/java/com/hilltopvillage/arena/MultiArenaManager.java",
        "line": 110,
        "quote": "arena.removePlayer(player);",
        "why_suspicious": "每秒重连扫描的循环内没有 try/catch，单场抛异常会让整个 runTaskTimer 任务被取消，此后所有待过期重连记录永不处理。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L5",
        "suspected_dimension": "error-handling",
        "file": "src/main/java/com/hilltopvillage/arena/MultiArenaManager.java",
        "line": 362,
        "quote": "|| plugin.getMapRestoreManager().isRestoring(worldName);",
        "why_suspicious": "同文件对 PlayerGoodsManager 做了可能为 null 的兜底，此处却直接解引用 MapRestoreManager；为 null 时启用队列任务 NPE 停摆。",
        "confidence": "LOW"
      }
    ],
    "lead_count": 5,
    "dimension_histogram": {
      "logic": 1,
      "concurrency": 0,
      "security": 0,
      "error-handling": 2,
      "data-consistency": 2,
      "contract": 0
    }
  },
  "error": null
}
```
