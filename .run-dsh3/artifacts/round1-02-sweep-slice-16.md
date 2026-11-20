# slice-16 宽扫 — WaveManager.java

- status: COMPLETE
- slice_id: slice-16
- trace_id: trace-r1-20260215-hilltop-dsh3 / round1
- file: `src/main/java/com/hilltopvillage/core/WaveManager.java`（read 工具实测 1139 行；PowerShell `Measure-Object -Line` 计 903 行是因为空行不计，非真实行数）
- 只读：未对被审仓库做任何写入

## 1. 范围与方法

单文件切片，用 read 分三段（1–400 / 401–800 / 801–1139）通读全文，未跳读。
可达性用一次浅层 grep 确认：`GameManager.java:131` `this.waveManager = new WaveManager(this);`，
并由 `GameManager.java:321` 的 `waveManager.spawnWave(currentWave, () -> waveSpawning = false);`
与 `:445` / `:482` / `:488` / `:646` 等调用点驱动 → `PROD`。

重点看：`runTaskTimer` 刷怪批次（三套：权重路径 / 精确配比 / 兜底）、`addGoal` 注册（5 个自定义 Goal
的实际注册点在 364 / 589 / 637 / 642 / 697 / 702）、波次计数与结束条件（`spawnedCount >= remaining`、
`isWaveCleared`）、实体清理（`clearAllMobs` / `purgeStuckMobs` / `cleanupOrphans`）、
`getEntities()` 遍历、世界为 null 的守卫覆盖差异。

## 2. 观察到的结构（不含推断）

| 路径 | 任务句柄 | state!=RUNNING 守卫 | 句柄置空 → 回调 → cancel 顺序 |
|---|---|---|---|
| `spawnWave` 权重路径（136–172） | `spawnTask` | 有（145） | 有（167–169） |
| `spawnExactMixWave`（238–265） | `spawnTask` | 有（242） | 有（260–262） |
| `spawnDefaultWave`（321–351） | `spawnTask` | 有（325） | 有（346–348） |
| `spawnAirdropMobs`（993–1027） | 局部 `handle[0]` + `airdropTasks` | 有（997–1001） | 无 onComplete，靠守卫自摘 |

三套刷怪路径的 `spawnEntity` 异常处理不一致：
`spawnExplodeBeetle`/`spawnHookClawHunter`/`spawnFlyingDropper` 用 `catch (Exception)` 包住（556/604/657），
`spawnCustomMob` 的 default 分支只兜 `IllegalArgumentException`（474），
`spawnAirdropMobs` 完全无 try（1011）。

## 3. 线索清单

| id | 维度 | 行 | 一句话 |
|---|---|---|---|
| L1 | error-handling | 464 | `getGameWorld()` 未判空即 `spawnEntity`，且只兜 `IllegalArgumentException` |
| L2 | error-handling | 167 | 先把 `spawnTask` 置空再跑回调，回调抛异常则任务失去句柄且不再 cancel |
| L3 | error-handling | 1011 | 空投批次任务里 `spawnEntity` 无 try，异常会留下每 10 tick 复发的死任务 |
| L4 | error-handling | 574 | `getAttribute(MAX_HEALTH)` 未判空（同类 `ATTACK_DAMAGE` 反而判了） |
| L5 | logic | 1130 | `nearestPlayer` 世界不匹配时 continue 到底，回退到 `players.get(0)` 造成跨世界传送 |
| L6 | concurrency | 406 | `getEntities()` 遍历中直接 `remove()`（411），依赖 Bukkit 返回快照这一未声明前提 |

## 4. 可达性判定

`PROD`。理由见 §1：本类由 `GameManager` 构造持有，`spawnWave` 在开局/换波时被调用，
`isWaveCleared` 被 3 秒波次检查任务调用，`clearAllMobs` 出现在 stopGame/结算/关服路径。

## 5. 未覆盖 / 边界说明

- 未读 `GameManager`、`GameConfig`、5 个 Goal 的实现（超出本切片文件清单），
  因此 `onComplete` 实际会不会抛异常、`getGameWorld()` 在换图/卸载窗口能否返回 null，
  只能标 MEDIUM/LOW，留给深挖用调用链证据确认。
- `addGoal` 调用本身（364/589/637/642/697/702）未见空指针风险：`Bukkit.getMobGoals()` 为静态门面，
  `mob` 在调用点均已 instanceof 判定；Goal 内部行为属 slice-04 范围。
- `activeMobs` 用 `ConcurrentHashMap.newKeySet()`（80），`removeIf`（909）、`clearAllMobs` 遍历中
  `clear()`（894）等写操作在 Bukkit 主线程语义下未发现明确的并发写冲突，故未出线索。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "sweep-slice-16",
  "role": "sweep",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/.run-dsh3/artifacts/round1-02-sweep-slice-16.md",
  "payload": {
    "slice_id": "slice-16",
    "reachability": "PROD",
    "generator_ref": null,
    "files_read": [
      {
        "path": "src/main/java/com/hilltopvillage/core/WaveManager.java",
        "lines": 1139,
        "quote": "public void spawnWave(int waveNumber, Runnable onComplete) {"
      }
    ],
    "files_unreadable": [],
    "leads": [
      {
        "lead_id": "L1",
        "suspected_dimension": "error-handling",
        "file": "src/main/java/com/hilltopvillage/core/WaveManager.java",
        "line": 464,
        "quote": "Entity entity = world.spawnEntity(location, entityType);",
        "why_suspicious": "world 来自未判空的 getGameWorld()（449），此处只 catch IllegalArgumentException，世界卸载/换图窗口下 NPE 会冒出 runTaskTimer 任务体。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L2",
        "suspected_dimension": "error-handling",
        "file": "src/main/java/com/hilltopvillage/core/WaveManager.java",
        "line": 167,
        "quote": "spawnTask = null;",
        "why_suspicious": "先置空句柄、再执行 onComplete、最后才 cancel()（167-169）：回调抛异常时 cancel 不执行，任务既无句柄可被 cancelSpawnTask 取消、又会每 3 tick 重复触发回调。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L3",
        "suspected_dimension": "error-handling",
        "file": "src/main/java/com/hilltopvillage/core/WaveManager.java",
        "line": 1011,
        "quote": "Entity entity = world.spawnEntity(spawnLoc, mobType);",
        "why_suspicious": "空投批次任务内 spawnEntity 无 try/catch（与三个特殊怪生成方法的 catch 不一致），且 mobType 来自配置，异常后 handle 仍留在 airdropTasks 中按 10 tick 反复抛。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L4",
        "suspected_dimension": "error-handling",
        "file": "src/main/java/com/hilltopvillage/core/WaveManager.java",
        "line": 574,
        "quote": "spider.getAttribute(Attribute.MAX_HEALTH).setBaseValue(health);",
        "why_suspicious": "getAttribute 返回值直接解引用，同文件 applyMonsterEquipment 对 ATTACK_DAMAGE 做了判空（491-492），此处 622/682 行同样未判；entity-type 可被管理员配置成无该属性的类型。",
        "confidence": "LOW"
      },
      {
        "lead_id": "L5",
        "suspected_dimension": "logic",
        "file": "src/main/java/com/hilltopvillage/core/WaveManager.java",
        "line": 1130,
        "quote": "if (loc.getWorld() != from.getWorld()) continue;",
        "why_suspicious": "所有候选玩家都被 continue 跳过时 best 仍停在 players.get(0)、bestDistSq 保持 MAX_VALUE，方法注释所称“保证返回非 null”掩盖了“返回了另一个世界的玩家”，随后 1079 行跨世界 teleport。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L6",
        "suspected_dimension": "concurrency",
        "file": "src/main/java/com/hilltopvillage/core/WaveManager.java",
        "line": 406,
        "quote": "for (Entity entity : world.getEntities()) {",
        "why_suspicious": "循环内 411 行直接 living.remove()，该模式依赖 world.getEntities() 返回独立快照；若返回实时集合，remove 触发的实体移除监听再改动世界实体即 ConcurrentModificationException（435-437 的静态清扫同样写法）。",
        "confidence": "LOW"
      }
    ],
    "lead_count": 6,
    "dimension_histogram": {
      "logic": 1,
      "concurrency": 1,
      "security": 0,
      "error-handling": 4,
      "data-consistency": 0,
      "contract": 0
    }
  },
  "error": null
}
```
