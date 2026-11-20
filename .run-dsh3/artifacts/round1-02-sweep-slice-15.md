# slice-15 宽扫（GameManager / GameState / HilltopVillagePlugin / PlayerData / PlayerGoodsManager）

- status: COMPLETE
- trace_id: trace-r1-20260215-hilltop-dsh3 / round_id: round1
- 被审仓库（只读）: `D:\Server\MCServers\Server plugin\Hilltop Village\Hilltop Village Plugin`
- 读取方式: 逐文件 `read` 全文（5/5），行号以 LF 切分为准（与 `tools/verify-artifacts.mjs` 的 `split(/\r?\n/)` 同口径；本文件全部为 LF，无 CR）。
- 重点加权: concurrency + data-consistency（按派发要求）。

## 1. 覆盖与总体印象

| 文件 | 行数 | 结论摘要 |
|---|---|---|
| `core/GameManager.java` | 906 | 所有调度（`runTaskTimer`/`runTaskLater`）都在主线程；未发现异步线程碰世界状态。可疑点集中在**收尾/结算路径的状态守卫**（`endGame` 无重入守卫、`removeOfflinePlayer` 不查 `settlementPhase`）。 |
| `core/GameState.java` | 23 | 纯枚举 + `i18nKey()`，无缺陷线索。 |
| `HilltopVillagePlugin.java` | 617 | `onDisable` 的取消清单相当完整（fireball / tab / reset service / particles / arenas / map / stats / goods 各自独立 try-catch）。可疑点：**整批停止只包一层 try-catch**，单场异常会跳过其余场次的停止。 |
| `core/PlayerData.java` | 105 | 纯内存 POJO，无落盘、无并发原语；字段全部非 volatile，但调用点均为主线程事件/调度路径。本切片未取线索。 |
| `core/PlayerGoodsManager.java` | 569 | 落盘设计最复杂：1 tick 防抖 + 唯一 tmp 名 + `writeSeq` 两次校验 + 锁外 `Files.write`。可疑点：**异步线程内 `yaml.saveToString()`**、**写失败只记日志无补偿**。 |

`GameManager.stopGame()` 的幂等性（派发重点）：方法体只做 `state=WAITING`、`currentWave=0`、取消两个任务句柄、`stopBuffTask()`、`clearAllMobs()`、`deactivateSmash()`；两次调用在**任务取消**层面幂等，但它**不触发** `onGameEndCallback`、不做任何统计落库，也不清 `players` / `playerDataMap`（那是 `clearAllPlayers()` 的职责，见其 javadoc）。因此「同一收尾链调用两次」本身不会重复落库——**重复落库的风险在 `endGame(boolean)`**，它没有已结束/结算中守卫（L1）。

`runTaskAsynchronously` 的使用面：本切片只有 `PlayerGoodsManager.flushToDisk()` 一处（第 478 行），它交给异步线程的只有 `YamlConfiguration` + 序号；但该 lambda 内部会调用 `yaml.saveToString()`（L4），序列化对象里含 `ItemStack`。

`reload` 泄漏：本切片 5 个文件内没有 `onEnable` 重复注册的入口（`HilltopVillagePlugin` 未覆写 reload，`/hilltop reloadconfig` 走命令层不在本切片），**未取到可证据化的 reload 泄漏线索**；`PlayerGoodsManager` 的 `pendingSaveTask` 由 `saveNow()` → `cancelScheduledSave()` 取消，`onDisable` 已调用。

## 2. 线索（leads）

### L1 `GameManager.endGame(boolean)` 无重入守卫，回调可能被重复执行
- 位置：`core/GameManager.java:652`
- 观察：`endGame` 方法体先无条件写 `state = victory ? VICTORY : DEFEAT`（630），随后无条件 `if (onGameEndCallback != null) onGameEndCallback.accept(victory)`（651-653）。全方法没有 `if (state == VICTORY || state == DEFEAT) return;`，也没有 `settlementPhase` 判断。
- 疑点：同一收尾链若两次进入 `endGame`，`onGameEndCallback`（ArenaInstance 用于「状态机同步与统计结算」，见字段注释 76 行）会被调用两次，且第二次的 `victory` 可以与前一次不同。这与派发方提到的「同一收尾链调用两次」直接相关。
- 置信度：HIGH（结构在文件内闭合；回调的下游影响需在 ArenaInstance 侧证实）。

### L2 结算窗口内掉线仍会走 `endGame(false)`，可覆盖已定的胜负
- 位置：`core/GameManager.java:740`
- 观察：`removeOfflinePlayer` 的判负条件是 `players.size() < getArenaMinPlayers() && isGameRunning()`，而 `isGameRunning()` 只认 `RUNNING` / `WAVE_INTERMISSION`（823）。`haltGame()` 刻意不改 state（701-715 注释明说），只把 `settlementPhase` 置 true；`isSettlementPhase()` 在本方法里没有被调用（对比 `forceAdvanceWave()` 第 575 行有 `if (settlementPhase) return`）。
- 疑点：结算倒计时窗口内玩家退出，会再次进入 `endGame(false)`，把已经判定的胜利改写成失败并再次触发回调。
- 置信度：MEDIUM（`settlementPhase` 的语义在文件内自洽，触发需结算窗口内有人退出）。

### L3 `stopGame()` 不复位任何结算状态、不落库，与 `endGame()` 职责不对称
- 位置：`core/GameManager.java:657`
- 观察：`stopGame()`（656-669）只做 `state = WAITING` / `settlementPhase = false` / `currentWave = 0` / 取消两个句柄 / `stopBuffTask()` / `clearAllMobs()` / `deactivateSmash()`；没有 `onGameEndCallback` 调用，也没有统计或快照写盘。`endGame()` 则有回调（651-653）。
- 疑点：同一「收尾链」既可能调 `endGame` 又可能调 `stopGame`，两者对「本局是否结算落库」的口径不一致；只走 `stopGame` 的路径（重置/禁用收尾）不会产生本局结算。
- 置信度：MEDIUM（属契约/职责口径问题，实际影响取决于 ArenaInstance 的调用组合）。

### L4 异步线程内执行 `yaml.saveToString()`，序列化含 `ItemStack` 的 Bukkit 配置对象
- 位置：`core/PlayerGoodsManager.java:422`
- 观察：`writeYaml` 的唯一调用点之一是 `flushToDisk()` 第 478 行的 `runTaskAsynchronously(plugin, () -> writeYaml(yaml, seq))`；`writeYaml` 在 `synchronized (writeLock)` 内执行 `payload = yaml.saveToString().getBytes(...)`。该 YAML 由 `buildYaml()`（343-376）填充，含 `ItemStack`（`contents`/`armor`/`off-hand`）与 `PotionEffect` 的序列化结果。
- 疑点：把「Bukkit 配置对象的序列化」放在异步调度线程，而不是注释声称的「只有纯 `Files` 写入丢到异步线程」；`save()` 第 147-149 行对 `ItemStack[]` 只做数组 `clone()`（浅拷贝），异步序列化读到的是与主线程共享的 `ItemStack` 实例。
- 置信度：MEDIUM（线程边界可由 478→422 的调用链确认；实际撕裂是否可观测需运行期证据）。

### L5 写盘失败只记日志、无重试，磁盘可能停留在旧快照
- 位置：`core/PlayerGoodsManager.java:432`
- 观察：`writeYaml` 的 `catch (IOException)` 只 `log(Level.SEVERE, ...)` 后返回（431-433），没有重试、没有把失败回传给调用方，`flushToDisk()`/`saveNow()` 的返回值均为 void；而 `restore()` 在写回成功后已 `goods.remove(uuid)`（217）并只登记防抖写盘。
- 疑点：写失败时内存中该玩家的快照已删除、磁盘仍是「未归还」的旧内容，下次登录 `has()` 命中会再归还一次（物品翻倍）；同一路径也可反向造成快照永久丢失（`save()` 后清空背包、写盘失败）。
- 置信度：MEDIUM（失败分支与删除顺序均在文件内可见；触发需磁盘/权限异常）。

### L6 `onDisable` 用单个 try-catch 包住整批 `stopAllArenasNow()`，单场异常跳过其余场次
- 位置：`HilltopVillagePlugin.java:286`
- 观察：`onDisable` 中 `multiArenaManager.stopAllArenasNow()` 只被一层 `try { ... } catch (RuntimeException)` 包住（285-289）；紧邻的注释（275-278）自述「竞技场清理会逐个 removePlayer，而移除最后一名玩家可能触发 GameManager.endGame(false) → ArenaInstance 结算倒计时（无条件 runTaskTimer），在禁用阶段抛出 IllegalPluginAccessException」。
- 疑点：该异常一旦从某个竞技场抛出，整批停止就此中断，后续竞技场不会被停止，而第 293-299 行的 `mapRestoreManager.restoreAllNow()` 仍会继续回滚地图。
- 置信度：MEDIUM（异常可达性由同文件注释与 `endGame` 路径支持；具体是否中断取决于 `stopAllArenasNow` 内部是否自行逐场隔离，该方法不在本切片）。

## 3. 明确未取线索的点（避免下游重复劳动）

- `GameManager` 的 `waveCheckTask` / `waveSchedulerTask`：创建、取消、置空全部在 Bukkit 主线程调度回调内，且 `startNextWave()` 入口先 `cancelWaveScheduler()`（300），未发现双开波次的路径。
- `players` / `playerDataMap`：`ConcurrentHashMap` 支撑的集合，遍历（`broadcastI18n`、`respawnDeadPlayers`、`hasAlivePlayer`）为弱一致遍历，本切片未见异步写入方。
- `GameState.i18nKey()`：`toLowerCase(Locale.ROOT)` + `replace('_','-')`，与注释声明的键面一致。
- `PlayerGoodsManager` 的 `writeSeq` 两次校验：进锁/发布前各校验一次，且 `Files.move` 在锁内，未发现「旧快照覆盖新快照」的窗口。
- `PlayerData`：无落盘逻辑（落盘在 `PlayerGoodsManager` / `StatsManager`），字段读写均发生在主线程事件与调度回调。

## 4. 可达性

`PROD`。`HilltopVillagePlugin` 是 Bukkit 插件主类（`onEnable`/`onDisable` 为生产入口，命令 executor 与事件监听器在此注册）；`GameManager` 由 `ArenaInstance` 逐场构造并驱动（`onGameStart → startGame`），`PlayerGoodsManager` 在 `onEnable` 第 106 行实例化并在 `PlayerJoinEvent` / `PlayerQuitEvent` / `onDisable` 三处被调用；`PlayerData` 由 `GameManager.addPlayer` 创建、由 `onMobDeath` 累加。全部文件在生产路径上。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "sweep-slice-15",
  "role": "sweep",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/.run-dsh3/artifacts/round1-02-sweep-slice-15.md",
  "payload": {
    "slice_id": "slice-15",
    "reachability": "PROD",
    "generator_ref": null,
    "files_read": [
      {
        "path": "src/main/java/com/hilltopvillage/core/GameManager.java",
        "lines": 906,
        "quote": "public void stopGame() {"
      },
      {
        "path": "src/main/java/com/hilltopvillage/core/GameState.java",
        "lines": 23,
        "quote": "public String i18nKey() {"
      },
      {
        "path": "src/main/java/com/hilltopvillage/HilltopVillagePlugin.java",
        "lines": 617,
        "quote": "multiArenaManager.stopAllArenasNow();"
      },
      {
        "path": "src/main/java/com/hilltopvillage/core/PlayerData.java",
        "lines": 105,
        "quote": "public void addCurrencyCollected(int amount) {"
      },
      {
        "path": "src/main/java/com/hilltopvillage/core/PlayerGoodsManager.java",
        "lines": 569,
        "quote": "private void writeYaml(YamlConfiguration yaml, long seq) {"
      }
    ],
    "files_unreadable": [],
    "leads": [
      {
        "lead_id": "L1",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/core/GameManager.java",
        "line": 652,
        "quote": "onGameEndCallback.accept(victory);",
        "why_suspicious": "endGame() 不检查 state/settlementPhase 是否已结束，重复进入会再次执行结算回调。",
        "confidence": "HIGH"
      },
      {
        "lead_id": "L2",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/core/GameManager.java",
        "line": 740,
        "quote": "if (players.size() < getArenaMinPlayers() && isGameRunning()) {",
        "why_suspicious": "haltGame() 后 isGameRunning() 仍为 true，此处未查 isSettlementPhase()，结算窗口内掉线仍会走 endGame(false)。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L3",
        "suspected_dimension": "contract",
        "file": "src/main/java/com/hilltopvillage/core/GameManager.java",
        "line": 657,
        "quote": "state = GameState.WAITING;",
        "why_suspicious": "stopGame() 只复位状态与取消任务，不调 onGameEndCallback 也不落库，与 endGame() 的收尾职责口径不一致。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L4",
        "suspected_dimension": "concurrency",
        "file": "src/main/java/com/hilltopvillage/core/PlayerGoodsManager.java",
        "line": 422,
        "quote": "payload = yaml.saveToString().getBytes(StandardCharsets.UTF_8);",
        "why_suspicious": "writeYaml 由 runTaskAsynchronously 调用，yaml.saveToString() 在异步线程序列化含 ItemStack 的 Bukkit 配置对象。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L5",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/core/PlayerGoodsManager.java",
        "line": 432,
        "quote": "plugin.getLogger().log(Level.SEVERE, \"Failed to save \" + FILE_NAME, exception);",
        "why_suspicious": "写盘失败只记日志无重试，而此时内存快照已在 restore() 中移除、磁盘仍是旧内容。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L6",
        "suspected_dimension": "error-handling",
        "file": "src/main/java/com/hilltopvillage/HilltopVillagePlugin.java",
        "line": 286,
        "quote": "multiArenaManager.stopAllArenasNow();",
        "why_suspicious": "整批竞技场停止只包一层 try-catch，单场抛 RuntimeException 会跳过其余场次的停止，而随后的地图回滚仍执行。",
        "confidence": "MEDIUM"
      }
    ],
    "lead_count": 6,
    "dimension_histogram": {
      "logic": 0,
      "concurrency": 1,
      "security": 0,
      "error-handling": 1,
      "data-consistency": 3,
      "contract": 1
    }
  },
  "error": null
}
```
