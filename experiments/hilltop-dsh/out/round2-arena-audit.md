# 竞技场模块（com.hilltopvillage.arena）第二轮静态审计

审计范围：`src/main/java/com/hilltopvillage/arena/` 下全部 7 个源文件（ArenaDefinition / ArenaRegistry / IArena / ArenaManager / ArenaInstance / ArenaStatus / MultiArenaManager，合计约 4,241 行），逐文件全文通读，未改动任何源码。检查维度：logic / concurrency / data-consistency / error-handling / contract；模块内未出现 `runTaskAsynchronously`、`CompletableFuture`、自建线程池等异步原语，跨线程访问未构成发现，故本轮 4 条发现集中在配置口径、状态机可重入与状态映射三处。`MapRestoreManager.restoreWithResult` 有主线程断言且回调在主线程执行，未作为并发问题上报。以下是证据最强的 4 条。

## F1 整段 `game:` 缺失时游戏参数回落到硬编码 2/6/20/30，与 `defaultMinPlayers()` 的继承承诺相反

`ArenaManager.readDefinition` 只在 `game != null` 时读取四个游戏参数，见 ArenaManager.java:612 `int minPlayers = game.getInt("min-players", defaultMinPlayers());`——该兜底被包在 607 行的 `if (game != null) {` 内，`game` 整段缺失时不进入，四个参数一个都不写，直接由 `builder.build()` 落回 `ArenaDefinition.Builder` 的硬编码默认值（ArenaDefinition.java:239 `private int minPlayers = 2;`，同处 max=6、victory-waves=20、wave-interval-seconds=30）。这与同文件 621-626 行 `defaultMinPlayers()` 的 javadoc「只有『整个 min-players 键都不存在』时才继承全局值，避免硬编码默认值 2 与 game-settings.yml 不一致」直接矛盾：整段缺失正是最彻底的「键不存在」，却恰恰拿不到全局兜底。触发链完全在仓库内：管理 GUI 的「重置竞技场」→ `clearDeploymentData` 删完 `game.*` 后执行 ArenaManager.java:744 `if (game != null && game.getKeys(false).isEmpty()) disk.set(path + ".game", null);`（注释称「使该竞技场回到与『从未部署』完全一致的状态」）→ `load()` 重读磁盘 → 命中 `game == null` 分支。后果是同一个问题（「该竞技场没写 min-players 时用几个人」）有两个答案：`game:` 段存在但键缺失 → 全局 `min-players`；`game:` 段缺失 → 2。在全局 `min-players: 4` 的服务器上，被重置过的竞技场变成 2 人即可开局，`max-players` 也从 `Math.max(6, min)` 退化为固定 6，`victory-waves` / `wave-interval-seconds` 一并回退到 20/30，与 `game-settings.yml` 的口径悄悄分叉；反之全局为 1 的单人服，重置后该竞技场无法单人开局。

## F2 `stopArena` 移除实例却不更新 `statuses`，`getStatus` 对已停止的竞技场仍返回 READY

`MultiArenaManager.stopArena` 在移除实例后直接返回，见 MultiArenaManager.java:523 `activeArenas.remove(arenaId);`——方法内没有任何 `statuses` 写入；而 `getStatus` 对非活动 ID 只回落到 `statuses`（MultiArenaManager.java:490 `ArenaStatus s = statuses.get(arenaId);`），因此被停止的竞技场对外仍报告 `READY`。这与枚举契约冲突：ArenaStatus.java:32 定义 `READY` 为「就绪：已加载并初始化完成，可以加入与开局」，而同一 ID 走 `joinArena` 会在 MultiArenaManager.java:748 `if (arena == null) {` 处得到 `arena-not-found`——状态查询与加入入口对「能否加入」给出相反答案。对照 `disableArena` 在同样位置显式执行 MultiArenaManager.java:463 `statuses.put(arenaId, ArenaStatus.DISABLED);`，可见 stop 分支是遗漏而非有意保留的语义。需要如实说明：本次全仓检索未发现 `stopArena(` 的调用方（只有 504 行的定义本身），所以这是公共生命周期 API 的状态不变式缺口，当前没有线上触发点，按 LOW 记录；一旦主插件或管理命令接上该方法，`/hilltop list`、GUI 与重置服务都会读到错误的 READY。

## F3 `removePlayer` 的「无快照是否清背包」判定读到被自身调用改写的 DEFEAT 状态，把对局中离场者误判为幽灵成员

`removePlayer` 先用 `gameManager.removePlayer(player)` 摘人（ArenaInstance.java:446），再在 468 行用 `state` 决定是否清空背包：`if (shouldClearInventoryOnMissingSnapshot(state)) {`。但前者会同步改写后者：`GameManager.removePlayer` 转调 `removeOfflinePlayer`（GameManager.java:723），后者在剩余人数低于 `min-players` 且对局进行中时执行 `endGame(false)`（GameManager.java:740-741 `if (players.size() < getArenaMinPlayers() && isGameRunning()) {`），`endGame` 又同步调用回调（GameManager.java:652 `onGameEndCallback.accept(victory);`），回调 `beginEndSequence` 把状态置为失败：ArenaInstance.java:814 `state = victory ? GameState.VICTORY : GameState.DEFEAT;`。回到 468 行时 `state` 已是 DEFEAT，按该方法 404-405 行的成因分类被判成「结算窗口的幽灵成员」（该处把 VICTORY / DEFEAT / ENDING 一律归入成因 B），走 478-484 行的「只把模式拉回生存、不清背包」分支。触发场景不需要罕见时序：2 人局进行中一人退服或被踢，其离场使剩余 1 人跌破 min-players 触发判负，只要该玩家没有快照（`PlayerGoodsManager` 初始化失败为 null 是受支持的降级模式，或 `save` 失败使 `has(player)` 为假），他就会带着 starter-kit 与局内货币回到大厅——正是 470-471 行注释声称「必须清空游戏物品，否则套装与局内货币会被带出竞技场」要防的情况，属于同一方法内「先改状态、后读状态」的自伤。

## F4 大厅世界未加载时回退到主世界，却继续使用原大厅世界的坐标

`ArenaManager.getLobbyWorldName()` 在 `lobby.world` 指向的世界未加载时静默回退到主世界，见 ArenaManager.java:305 `return Bukkit.getWorlds().get(0).getName();`（299 行的前置条件要求 `Bukkit.getWorld(name) != null` 才使用配置值）。但 `getLobbySpawn()` 只要 `lobby.spawn` 段存在，就按其中 x/y/z/yaw/pitch 拼 Location（ArenaManager.java:371-379，只有缺失的单个键才用「所选世界」的出生点坐标兜底），只有 `lobby.spawn` 整段缺失时才直接走 `if (spawn == null) return world.getSpawnLocation();` 使用所选世界的安全出生点。`ArenaInstance.removePlayer` 直接把这个 Location 用于传送（ArenaInstance.java:458-459 `Location lobbySpawn = plugin.getMultiArenaManager().getLobbySpawn();` 与随后的 `player.teleport(...)`），于是当大厅世界被改名、删除或尚未加载时，离场玩家会被送到「主世界 + 另一张地图坐标」的位置，可能悬空、埋进方块或落在数千格外。`isConfiguredLobbyWorldMissing()` 的注释已承认该回退「让『服主忘了配大厅』变成不可见的失败」（ArenaManager.java:353-354），但只补了告警 API，没有修正坐标来源，回退路径本身仍会把玩家丢到错配位置。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "audit-arena-r2",
  "role": "audit",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "round2-arena-audit.md",
  "payload": {
    "findings": [
      {
        "finding_id": "F1",
        "severity": "MEDIUM",
        "dimension": "data-consistency",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/arena/ArenaManager.java",
          "line": 612,
          "quote": "int minPlayers = game.getInt(\"min-players\", defaultMinPlayers());"
        },
        "inference": {
          "claim": "整段 game: 缺失时四个游戏参数完全不读全局值，直接落到 ArenaDefinition.Builder 的硬编码 2/6/20/30；而 game 段存在但键缺失时走 defaultMinPlayers()。两条路径对「没配 min-players 时用几个人开局」给出不同答案，且 clearDeploymentData 会主动把竞技场从后者改造成前者。",
          "basis": "ArenaManager.java:607 `if (game != null) {` 包住全部四个参数的赋值（612-616 行），没有 else 分支；ArenaDefinition.java:239-242 的 Builder 字段默认值为 minPlayers=2、maxPlayers=6、victoryWaves=20、waveIntervalSeconds=30；ArenaManager.java:625-626 的 javadoc 明写「只有『整个 min-players 键都不存在』时才继承全局值，避免硬编码默认值 2 与 game-settings.yml 不一致」；ArenaManager.java:743-744 在清空部署数据后删除空 game 段，注释称「使该竞技场回到与『从未部署』完全一致的状态」。调用链：管理 GUI 重置 → clearDeploymentData → disk.set(path + \".game\", null) → load() → readDefinition 的 game == null 分支 → Builder 默认值。",
          "alternatives": [
            "如果 AdminDeployManager 的旧数据迁移会在 load() 之前为缺少 game 段的竞技场补写 game.min-players，则重置后会被重新补齐，问题不成立——需核对该迁移的写入范围（当前它只迁移旧版 spawnpoints.yml 的坐标，未见写 game 段）。",
            "如果出厂 arenas.yml 的每个竞技场都必带 game: 段且任何管理入口都不会删除该段，则只影响手改配置或新增竞技场的场景——但 clearDeploymentData 的 744 行正是这样做的。"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "F2",
        "severity": "LOW",
        "dimension": "data-consistency",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/arena/MultiArenaManager.java",
          "line": 523,
          "quote": "activeArenas.remove(arenaId);"
        },
        "inference": {
          "claim": "stopArena 移除实例后不更新 statuses，getStatus 对已停止的竞技场仍返回 READY（契约是「可以加入与开局」），而 joinArena 对同一 ID 返回 arena-not-found；disableArena 在同一位置则显式写入 DISABLED。",
          "basis": "MultiArenaManager.java:504-525 的 stopArena 只有 purgePlayerArenaMapping 与 activeArenas.remove，无 statuses.put；MultiArenaManager.java:485 `if (activeArenas.containsKey(arenaId)) return ArenaStatus.READY;`，未命中时 490-491 行回落到 statuses；MultiArenaManager.java:463 disableArena 写入 DISABLED 作为对照；ArenaStatus.java:32 定义 READY 为「已加载并初始化完成，可以加入与开局」；MultiArenaManager.java:747-750 joinArena 用 activeArenas.get 判空并回 arena-not-found。",
          "alternatives": [
            "本次全仓检索未发现 stopArena( 的调用方，只有 504 行的定义本身；若该方法确为死代码，则当前版本无线上触发点，仅是公共 API 的状态不变式缺口。",
            "如果调用方在 stopArena 之后自行 statuses.put(DISABLED)，则不一致被外部补齐——但方法自身的文档没有提出这一要求，调用方也无从得知。"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "F3",
        "severity": "MEDIUM",
        "dimension": "logic",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/arena/ArenaInstance.java",
          "line": 468,
          "quote": "if (shouldClearInventoryOnMissingSnapshot(state)) {"
        },
        "inference": {
          "claim": "该判定读取的 state 已被同一次 removePlayer 调用在第 446 行改写为 DEFEAT：离场者使剩余人数跌破 min-players 时 GameManager 同步判负，回调把竞技场状态置为 DEFEAT，于是「确实带着局内物品但快照丢失」的成因 A 被误判为「结算窗口幽灵成员」的成因 B，背包不被清空，starter-kit 与局内货币被带出竞技场。",
          "basis": "ArenaInstance.java:446 `gameManager.removePlayer(player);` 先于 468 行执行；GameManager.java:722-723 removePlayer 转调 removeOfflinePlayer；GameManager.java:740-741 `if (players.size() < getArenaMinPlayers() && isGameRunning()) { endGame(false); }`；GameManager.java:651-652 `if (onGameEndCallback != null) { onGameEndCallback.accept(victory); }` 为同步调用；ArenaInstance.java:814 直接把 state 置为 DEFEAT；ArenaInstance.java:404 的成因分类把 VICTORY/DEFEAT/ENDING 一律归为成因 B；470-471 行注释要求成因 A 必须清空。",
          "alternatives": [
            "如果 PlayerGoodsManager 恒非 null 且每个入场玩家都成功 save（has(player) 恒真），goods.restore 不会返回 false，该分支不可达，问题只影响降级模式与 save 失败场景。",
            "如果 endGame 的回调改为下一 tick 执行，则 468 行读到的仍是 RUNNING，也不会误判——当前实现是同步 accept，需以运行期实测确认调度语义。"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "F4",
        "severity": "MEDIUM",
        "dimension": "logic",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/arena/ArenaManager.java",
          "line": 305,
          "quote": "return Bukkit.getWorlds().get(0).getName();"
        },
        "inference": {
          "claim": "getLobbyWorldName 在配置的大厅世界未加载时静默回退到主世界，但 getLobbySpawn 仍用同一份 lobby.spawn 坐标构造 Location，返回「主世界 + 原大厅世界坐标」的错配位置；玩家离场传送会落到任意远处、悬空或方块内。",
          "basis": "ArenaManager.java:297-306 的回退逻辑仅在 Bukkit.getWorld(name) != null 时采用配置值；ArenaManager.java:371-379 在 lobby.spawn 段存在时按 x/y/z/yaw/pitch 拼接 Location（缺键才用所选世界出生点坐标兜底），只有整段缺失才用 world.getSpawnLocation()；ArenaInstance.java:458-459 用该 Location 直接 teleport；ArenaManager.java:352-354 的注释承认该回退使「服主忘了配大厅」变成不可见失败。",
          "alternatives": [
            "如果 lobby.world 指向的世界与主世界相同或始终加载，回退分支不可达，问题不成立。",
            "如果运维把 lobby.spawn 按主世界坐标填写，则错配恰好碰对；但 updateLobbySpawn 只在玩家位于大厅世界时写盘，正常流程下坐标属于 lobby.world。"
          ]
        },
        "status": "CONFIRMED"
      }
    ],
    "searched_scope": {
      "files_read": [
        "src/main/java/com/hilltopvillage/arena/ArenaDefinition.java",
        "src/main/java/com/hilltopvillage/arena/ArenaRegistry.java",
        "src/main/java/com/hilltopvillage/arena/IArena.java",
        "src/main/java/com/hilltopvillage/arena/ArenaManager.java",
        "src/main/java/com/hilltopvillage/arena/ArenaInstance.java",
        "src/main/java/com/hilltopvillage/arena/ArenaStatus.java",
        "src/main/java/com/hilltopvillage/arena/MultiArenaManager.java"
      ],
      "dimension_checklist": [
        "logic",
        "concurrency",
        "data-consistency",
        "error-handling",
        "contract"
      ],
      "methods": [
        "full-file read of all 7 arena sources with offset/limit chunks to EOF",
        "cross-file call-chain tracing for state transitions, join/leave, config reload and reset paths",
        "grep for async primitives (runTaskAsynchronously / CompletableFuture / new Thread / ExecutorService) to rule in/out concurrency findings"
      ]
    },
    "self_checks": {
      "identifier_reconcile": {
        "status": "DONE",
        "note": "4 条 finding 引用的 clearDeploymentData、defaultMinPlayers、Builder 默认字段、stopArena、getStatus、removePlayer、removeOfflinePlayer、endGame、beginEndSequence、getLobbyWorldName、getLobbySpawn 均在本次读取的源码中逐一定位，行号与引用片段已回读核对。"
      },
      "self_check_audit": {
        "status": "DONE",
        "note": "对候选逐条做反证：victory 复用 defeat-countdown 文案、离线成员统计缺失、局中热改 victory-waves 三条曾被否证并从清单剔除；F2 额外核实了调用方缺失，因此降为 LOW 而未按状态错乱夸大。"
      },
      "runtime_validation": {
        "status": "SKIPPED",
        "note": "只做静态代码审计，未启动 Paper/Bukkit 服务器复现（无可用测试服与构建产物）；四条结论均来自源码调用链，未声称运行时验证。"
      }
    }
  },
  "error": null
}
```
