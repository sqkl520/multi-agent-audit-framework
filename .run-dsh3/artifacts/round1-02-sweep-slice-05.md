# slice-05 宽扫（ArenaDefinition / ArenaInstance）

- trace_id: trace-r1-20260215-hilltop-dsh3
- round_id: round1
- slice_id: slice-05
- 被审仓库: `D:\Server\MCServers\Server plugin\Hilltop Village\Hilltop Village Plugin`（只读）
- 角色: sweep（只产线索，不判严重性，不做证据链）

## 0. 覆盖率与可达性

| 文件 | 行数（read 实测） | 读法 |
|---|---|---|
| `src/main/java/com/hilltopvillage/arena/ArenaDefinition.java` | 281 | 全文 |
| `src/main/java/com/hilltopvillage/arena/ArenaInstance.java` | 1589 | 全文（4 段连续读，无抽样） |

`ArenaInstance` 物理 1589 行（任务书提示的 1175 行为旧值，本回合以实测为准，见任务书 §9.4）。
未读切片外文件；`shared_dependencies` 为空。

**reachability = PROD**：`ArenaInstance implements IArena`，由 `MultiArenaManager` 的启用队列
`new ArenaInstance(...)` 构造（构造体内 `plugin.getArenaManager()` / `plugin.getMultiArenaManager()`
调用可证其运行期存在），是插件主流程的状态机核心；`ArenaDefinition` 是其实例的构造输入。

## 1. 状态机与定时任务结构（速记，供深挖定位）

- 状态字段：`state`（非 volatile）；状态迁移入口 `setState()`（L244），另有 **5 处直接赋值**绕过它：
  L814（VICTORY/DEFEAT）、L1093、L1099、L1243、L1357、L1462、L1487。
- 定时任务三件：`startCountdownTask`（L1110）、`endSequenceTask`（L836）、`emptyArenaTask`（L1189），
  各有 `cancelXxx()` 幂等收口；`sessionId` 用于让上一局结算回调失效。
- 收尾链路：`stopGame()` / `finishSession()` / `reset()` / `resetNow()` → `setState(ENDING)` → `onGameEnd()`
  → `reset()` → `MapRestoreManager.restoreWithResult(...)` → `completeResetAfterRestore()`。
- 玩家进出场：`addPlayer` / `removePlayer` / `removeOfflinePlayer` / `dropMember` / `rejoin`，
  物品快照走 `PlayerGoodsManager.save/restore`，统计走 `gameManager.getPlayerData()` 单份数据。

## 2. 线索

### L1 — 构造期对 `definition.getCore()` 返回的 null 直接解引用

`ArenaDefinition` 的类注释明写 `getCore()` 允许返回 null（未部署态，`ArenaDefinition.java:16-19`、
`getCore()` 本身 L136 只是 `copyLocation(core)`），而 `ArenaInstance` 构造函数先取
`Location coreLocation = definition.getCore();`（L133），随后在 L140 直接 `coreLocation.getWorld()`。
本类自己的 `getCoreLocation()` 注释（L982-989）也承认「core 为 null 时会 NPE」，并把安全性
完全托付给上游 `MultiArenaManager` 的构建前校验——构造函数本身没有守卫，抛的是 NPE 而不是可读的
`IllegalArgumentException`。上游校验一旦被绕过（例如管理 GUI/命令新增入口），失败形态是
「实例半构造 + 构造体内已 `cleanupOrphans()` 的副作用已发生」。

### L2 — 同一次收尾里 `gameManager.stopGame()` 被执行两次

`stopGame()` 在 L766 显式调用 `gameManager.stopGame()`，随后 L769-771 踢人、L774
`setState(GameState.ENDING)`；而 `setState` 对新状态 ENDING 会调 `onGameEnd()`（L258-259），
`onGameEnd()` 第一件事又是 `gameManager.stopGame()`（L1342）。注释只说 `stopGame` 幂等（L1368
「幂等：波次/怪物/节点 Buff 全部清理」），但清理与「结算落库」若在同一方法里，第二次调用是否
重复记账（波次/击杀/胜负）本文件看不出来——这正是需要深挖确认的点。

### L3 — `beginEndSequence` 直接写 `state` 字段，绕过 `setState` 的硬屏障

`setState()` 开头有 `if (restoreStarted && newState != GameState.ENDING) return;`（L246）作为
「地图回滚期间不得离开 ENDING」的屏障，而 `beginEndSequence` 在 L814 用
`state = victory ? GameState.VICTORY : GameState.DEFEAT;` 直接赋值，不经过该屏障，也不触发
`setState` 的迁移分支。地图回滚进行中（`restoreStarted == true`）若波次系统仍回调
`onNaturalGameEnd` → `beginEndSequence`，状态会被改写成 VICTORY/DEFEAT，屏障失效；
`isCurrentEndSequence()`（L879-882）只认 VICTORY/DEFEAT，届时还会拉起一个新的结算倒计时。

### L4 — `definition` 的读-改-写非原子（volatile 只保证可见性）

L953 `this.definition = definition.withGameParams(...)`、L970
`this.definition = definition.withWaitingLocation(waitingLocation);` 都是「读整个对象 → 派生新对象 →
整体替换」。字段虽是 volatile，两次并发调用（GUI 改参数 / 部署向导改等待区）会互相覆盖，
后写者把前者的字段改动丢掉。类注释（L47-49）声明「替换只发生在主线程」，因此当前是潜在而非
已发生的缺陷——但这也意味着任何一次把这两个方法挪进异步任务（如 `runTaskAsynchronously`
做落盘后回调）都会立刻变成丢更新。

### L5 — `resetNow()` 在 `reset()` 已发起回滚后再发一次 `restoreNow`

`resetNow()` L1488 `if (!restoreStarted) reset();`，而 `reset()` 内部 L1425 已经调用
`plugin.getMapRestoreManager().restoreWithResult(definition.getWorldName(), ...)`（异步回滚 + 回调）；
紧接着 L1489 又对**同一个世界**调用 `restoreNow(...)`。同一世界存在两条回滚请求：一条带回调
（成功才 `completeResetAfterRestore()` 回 WAITING），一条强制立即回滚。若 `restoreNow` 同步完成，
`restoreStarted` 已在 `reset()` 里置 true 且无回调复位路径，实例可能停在 ENDING；
若 `reset()` 因 `restoreStarted` 已 true 被跳过，则只剩 `restoreNow`，`restoreStarted` 永不复位。

### L6 — `setState` 在屏障期静默 no-op，void 签名让调用方无法察觉

L246-248 命中屏障时直接 `return`，既不记日志也不返回布尔；而调用方普遍按「调用即生效」写
（如 L509 `setState(GameState.WAITING)`、L774 `setState(GameState.ENDING)` 之后紧接着
`scheduleReset()`）。L774 之后若因屏障被吞，`scheduleReset()` 仍会执行并把 `resetScheduled` 置 true，
下一次真正的 reset 调度会被 `if (resetScheduled) return;`（L181）挡掉——屏障与调度标志之间
没有一致性保证。

## 3. 未深挖但值得注意（不进 leads，避免凑数）

- `grantStarterKit` L1543-1560 的 `while (remaining > 0)`：`stack = Math.min(remaining, maxStack)`，
  若 `getMaxStackSize()` 返回 0 则 `remaining` 不减，主线程死循环。当前 `Material.isItem()` 过滤下
  几乎不可能为 0，故仅记录。
- `removePlayer` L459 兜底 `Bukkit.getWorlds().get(0)`：无世界时 `IndexOutOfBoundsException`（理论态）。
- `startCountdown` 倒计时播报（L1147）从 `initialCountdown` 起播、到 `countdown == 1` 停，`0` 那一秒无播报，
  属 off-by-one 观感问题。

## 4. 信封

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "sweep-slice-05",
  "role": "sweep",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/.run-dsh3/artifacts/round1-02-sweep-slice-05.md",
  "payload": {
    "slice_id": "slice-05",
    "reachability": "PROD",
    "generator_ref": null,
    "files_read": [
      {
        "path": "src/main/java/com/hilltopvillage/arena/ArenaDefinition.java",
        "lines": 281,
        "quote": "public Location getCore() { return copyLocation(core); }"
      },
      {
        "path": "src/main/java/com/hilltopvillage/arena/ArenaInstance.java",
        "lines": 1589,
        "quote": "public class ArenaInstance implements IArena {"
      }
    ],
    "files_unreadable": [],
    "leads": [
      {
        "lead_id": "L1",
        "suspected_dimension": "error-handling",
        "file": "src/main/java/com/hilltopvillage/arena/ArenaInstance.java",
        "line": 140,
        "quote": "coreLocation.getWorld(),",
        "why_suspicious": "getCore() 在 ArenaDefinition 中允许返回 null（未部署态），构造函数未判空即解引用，抛 NPE 而非可读异常。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L2",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/arena/ArenaInstance.java",
        "line": 766,
        "quote": "gameManager.stopGame();",
        "why_suspicious": "stopGame() 在此显式调用一次，随后 setState(ENDING) 经 onGameEnd() 又调用一次，同一收尾链上 gameManager.stopGame 执行两遍。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L3",
        "suspected_dimension": "logic",
        "file": "src/main/java/com/hilltopvillage/arena/ArenaInstance.java",
        "line": 814,
        "quote": "state = victory ? GameState.VICTORY : GameState.DEFEAT;",
        "why_suspicious": "直接写 state 字段而绕过 setState()，restoreStarted 的回滚硬屏障与迁移分支都不生效。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L4",
        "suspected_dimension": "concurrency",
        "file": "src/main/java/com/hilltopvillage/arena/ArenaInstance.java",
        "line": 953,
        "quote": "this.definition = definition.withGameParams(minPlayers, maxPlayers, victoryWaves, waveIntervalSeconds);",
        "why_suspicious": "对 volatile definition 做「读-派生-整体替换」的非原子读改写，与 applyWaitingLocation 的同类替换并发时互相丢更新。",
        "confidence": "LOW"
      },
      {
        "lead_id": "L5",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/arena/ArenaInstance.java",
        "line": 1489,
        "quote": "plugin.getMapRestoreManager().restoreNow(definition.getWorldName());",
        "why_suspicious": "reset() 内部已对同一世界发起 restoreWithResult 异步回滚，这里再强制 restoreNow 一次，同一世界存在两条回滚请求。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L6",
        "suspected_dimension": "contract",
        "file": "src/main/java/com/hilltopvillage/arena/ArenaInstance.java",
        "line": 246,
        "quote": "if (restoreStarted && newState != GameState.ENDING) {",
        "why_suspicious": "屏障命中时 setState 静默 return，void 签名让调用方无法区分「已迁移」与「被吞」，后续 scheduleReset 仍会置位。",
        "confidence": "MEDIUM"
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
