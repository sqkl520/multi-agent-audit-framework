# slice-05 深挖 · data-consistency（ArenaDefinition / ArenaInstance）

- trace_id: `trace-r1-20260215-hilltop-dsh3`
- round_id: `round1`
- slice_id: `slice-05`
- dimension: `data-consistency`
- 被审仓库（只读）：`D:\Server\MCServers\Server plugin\Hilltop Village\Hilltop Village Plugin`
- 上游线索：`.run-dsh3\artifacts\round1-02-sweep-slice-05.md`（L1–L6）
- 读取方式：全部 `read` 全文/连续区间，无抽样、无 grep 代读

## 0. 覆盖与可达性

| 文件 | 行数（本回合 read 实测） | 用途 |
|---|---|---|
| `src/main/java/com/hilltopvillage/arena/ArenaDefinition.java` | 281 | 切片文件，全文 |
| `src/main/java/com/hilltopvillage/arena/ArenaInstance.java` | 1589 | 切片文件，全文（4 段：1–380 / 381–800 / 801–1220 / 1221–1589） |
| `src/main/java/com/hilltopvillage/core/GameManager.java` | 906 | 被调方：`stopGame` / `removeOfflinePlayer` / `clearAllPlayers` 语义（取证 L110–229、280–329、590–789、805–904） |
| `src/main/java/com/hilltopvillage/mechanics/MapRestoreManager.java` | 768 | 被调方：`restoreWithResult` / `restoreNow` / 回调语义（取证 L470–768） |
| `src/main/java/com/hilltopvillage/arena/MultiArenaManager.java` | 1153 | 调用方：`stopArena` / `stopAllArenasNow` → `resetNow()`（取证 L495–579） |
| `src/main/java/com/hilltopvillage/core/PlayerGoodsManager.java` | 569 | 被调方：`restore()` 返回值语义与快照生命周期（取证 L160–249） |
| `src/main/java/com/hilltopvillage/admin/ArenaAdminService.java` | 794 | 调用方：`updateGameParams` 的时序守卫（取证 L470–539） |

`reachability = PROD`：`ArenaInstance implements IArena`，由 `MultiArenaManager` 启用队列构造，是插件主流程状态机核心。

## 1. 上游线索逐条处置（先处置，再谈发现）

| 线索 | 结论 | 依据（本回合读取） |
|---|---|---|
| **L2** 同一次收尾 `gameManager.stopGame()` 执行两次 → 是否重复记账/重复落库 | **不成立（已排除）** | `GameManager.stopGame()` 全文只有内存字段写入：`state = WAITING` / `settlementPhase = false` / `currentWave = 0` / 取消两个任务 / `nodeSystem.stopBuffTask()` / `waveManager.clearAllMobs()` / `deactivateSmash()`（GameManager:656–669）。**没有任何 StatsManager / YAML / playerdata 调用**。统计的唯一写点是 `StatsManager.record*`，全部在 `ArenaInstance.removePlayer`（:433–437）、`removeOfflinePlayer`（:599–603）、`dropMember`（:665–671）、`reset` 补录（:1391–1396），且都以「先从 `players` 集合移除成功」为前置（:440 / :587 / :657），同一玩家不可能被结算两次。第 2 次调用发生在 `setState(ENDING) → onGameEnd()`（:258–259 → :1342），此时 `players` 已被踢空、`currentWave` 已为 0，重复执行只做幂等清理。 |
| **L5** `resetNow()` 在 `reset()` 已发起 `restoreWithResult` 后再 `restoreNow`，`restoreStarted` 是否永不复位 | **不成立（已排除）** | `restoreWithResult` 对同一世界**不会开第二条操作**：命中 `activeRestores` 时把回调合并进已有操作并返回 true（MapRestoreManager:515–520）；`restoreNow` = `restore(world,null)` + 对活动操作 `finishSynchronously`（:627–633），`complete()` 必然取出并逐个执行 `completionCallbacks`（:709–716），成功/失败都走 `runCompletion`，null 回调被跳过（:248–250、739–742）。`ArenaInstance.reset()` 的两条分支都复位 `restoreStarted`：成功 → `completeResetAfterRestore()`（:1450–1451），失败 → 回调内 `restoreStarted = false`（:1430），请求被拒 → `:1441`。因此「`restoreStarted` 永不复位」缺少证据；实际影响只剩「禁用期把分批回滚强制同步做完」（性能面，非一致性面）。 |
| **L1** `getCore()` 允许 null，构造函数直接解引用 | 转 `off_dimension_notes`（error-handling），按派发要求不写入 findings | `ArenaDefinition.java:16–19/136`；`ArenaInstance.java:133/140` |
| **L3** `beginEndSequence` 直接写 `state` 绕过 `setState` 屏障 | 转 `off_dimension_notes`（logic） | `ArenaInstance.java:814` vs `:246` |
| **L4** `definition` 读-改-写非原子 | 转 `off_dimension_notes`（concurrency） | `ArenaInstance.java:953` / `:970` |
| **L6** `setState` 屏障期静默 no-op | 转 `off_dimension_notes`（contract） | `ArenaInstance.java:246–248` |

> 排除 L2/L5 是本切片的主要工作量：两条线索都「看起来像」重复写，但一条落在纯内存清理，一条落在「合并 + 强制完成」的回滚 API 上。**没有把线索直接升级成发现**，是因为门 0 要求行为声明必须带控制流证据（evidence-policy §3）。

### 1.1 另两条候选，查证后判为误报（记录以免下游重复劳动）

| 候选 | 为何不立条 |
|---|---|
| `applyGameParams` 只改 `definition`，而 `GameManager.totalWaves` 是开局快照 → 「记分板写 20 波、实际第 10 波结算」 | 该分歧已被调用方显式封死：`ArenaAdminService.updateGameParams` 在 `STARTING/RUNNING/WAVE_INTERMISSION` 返回 `GAME_IN_PROGRESS`，在 `VICTORY/DEFEAT/ENDING` 返回 `COUNTDOWN_IN_PROGRESS`（ArenaAdminService:484–491），注释逐字写明「`GameManager.totalWaves` 还是开局时的快照，而 `ArenaScoreboard` 读的是实例定义的实时值」。且 `GameManager.startGame` 每局重读（GameManager:293）。不可达 → 不立条。 |
| `ArenaDefinition` 构造期未校验 `minPlayers/maxPlayers/victoryWaves` 的数值不变式 | 唯一的量产入口 `ArenaAdminService.updateGameParams` 先调 `ArenaManager.validGameParams(...)` 才落盘并推送内存（:496–503），非法值到不了 `withGameParams`。属契约/校验维度，且当前无绕过路径 → 不立条。 |

## 2. 发现

### F-05-DC-01（CONFIRMED / MEDIUM）无快照离场时直接 `clear()` 玩家背包，且此时不存在任何可回滚副本

**证据**：`ArenaInstance.java:471`（`player.getInventory().clear();`），所在分支由 `:464` 的 `if (goods == null || !goods.restore(player))` 与 `:468` 的 `shouldClearInventoryOnMissingSnapshot(state)` 共同守卫。

**控制流（为什么 `restore()` 返回 false 时已无副本）**：

1. `removePlayer` 先结算统计（`:433–437`），再 `players.remove(uuid)`（`:440`）、`forgetPlayerArena`（`:444`）、`gameManager.removePlayer`（`:446`），然后传送到大厅（`:459`），最后才到 `:463–464` 的归还分支。**统计已提交、成员资格已撤销，两者与背包归还不在同一事务里。**
2. `PlayerGoodsManager.restore(player)` 的返回语义是「内存里没有快照」：`Snapshot snapshot = goods.get(uuid); if (snapshot == null) return false;`（PlayerGoodsManager:184–185）；只有全部写回成功后才 `goods.remove(uuid)`（:216–217）。所以 `false` ⇒ 内存中**没有**可回滚副本。
3. `true` 分支才有副本可写回（:187–214）；`false` 分支走到 `:468`，在三态（STARTING/RUNNING/WAVE_INTERMISSION）下执行 `:471` 的 `clear()`。清空之后，玩家背包内容在内存与磁盘上都不再存在第二份。
4. `goods == null` 同样进入该分支（`:464` 的短路），而 `goods == null` 被代码自身认定为可达（`:462` 注释「管理器初始化失败时为 null」）。此时 `addPlayer` 的 `if (plugin.getPlayerGoodsManager() != null) save(player);`（`:322–324`）连快照都没建、也没清背包——玩家带着**自己的**物品进了局，离场时被 `:471` 清掉，**没有任何快照可还原**。

**预期 vs 实际**：预期是「无快照 → 保留现状或隔离待人工恢复」；实际是「无条件清空 + 只打一条 warning（`:475–477`，措辞自认 *the original items may be lost*）」，属于不可逆的部分写入。

**为何只判 MEDIUM**：触发需「快照缺失」这一前置（管理器初始化失败或快照丢失），非每局必现；但一旦命中即为玩家资产全损，故不降为 LOW。

**项目自带测试把该行为固化为期望值**：`ArenaInstanceStateMatrixTest:51` 对三态断言 `assertTrue(ArenaInstance.shouldClearInventoryOnMissingSnapshot(state), ...)`——所以「清背包」不会被既有测试暴露为缺陷，这正是 §4.7 所说的「防护的防护」盲区。

**可推翻条件**：

1. 若 `PlayerGoodsManager` 初始化失败时插件会中止启用（`goods` 永不为 null），则只剩「快照丢失」这一窄口径 —— 需读 `HilltopVillagePlugin` 的 `onEnable` 降级路径确认。
2. 若 `PlayerGoodsManager` 在 `restore()` 之外另有「未被消耗的磁盘快照」可人工回灌，则清空可恢复 —— 需读 `PlayerGoodsManager` 的 `loadFromDisk` / `saveNow`（:242–249、:498）与 `goods.yml` 的实际写入时机确认。
3. 若所有 `removePlayer` 调用点在离场时状态必为 `WAITING/VICTORY/DEFEAT/ENDING`（即 `shouldClearInventoryOnMissingSnapshot` 恒 false），则 `:471` 不可达 —— 但 RUNNING 下的退服/踢人路径会调用它（`:501–504` 即在本状态内触发 `stopGame()`），该条件不成立。

## 3. 维度清单逐项结论（12 项，对应模板 §4.8.2）

| # | 模式 | 结果 | 说明 |
|---|---|---|---|
| 1 | 返回值暴露内部状态 | 未命中 | `ArenaDefinition` 的 `core/waitingLocation/shopNpc/spawnPoints/mobSpawnPoints` 全部 `copyLocation` / 新建 `unmodifiableList`（ArenaDefinition:134–158、221–223）；`ArenaInstance.getSpawnPoints()` 转调 `GameManager.getSpawnPoints()`，后者 `new ArrayList<>(arenaSpawnPoints)`（GameManager:843–845）。`getMobSpawnPointsView()` 返回活视图，但 `unmodifiableList` 且约定「取出后必须 clone」——本切片调用点（`ArenaInstance:1286–1290`）只读 `getWorld()/getChunkAt`，未写入。 |
| 2 | 同族函数守卫一致性 | 未命中 | 逐对比较：`applyGameParams`（:951–955，含 `checkAutoStart()`）vs `applyWaitingLocation`（:969–971，不含）——等待区不影响 `isPlayable()`，无需开局重判，非缺陷；`removePlayer` vs `removeOfflinePlayer` vs `dropMember` 三者的「先取统计再 `gameManager.removeOfflinePlayer`」顺序一致（:433/:599/:665）。 |
| 3 | 数值边界 | 未命中 | 切片内无外部数值解析；`definition` 的 4 个数值由调用方 `ArenaManager.validGameParams` 前置校验（ArenaAdminService:496）。 |
| 4a | 原型链键名 / 裸下标 | 不适用 | Java 无原型链；切片内无「外部字符串当 map key」的查表。 |
| 4b | 假值 vs 缺值 | 未命中 | `sessionVictory` 用 `Boolean` 且 `null` 明确表示「中途离开、不计胜负」，四处结算点原样透传（:435/:601/:669/:1395），未把 `false` 当缺失；`Math.max(getCurrentWave(), sessionWave)` 处理 0 与快照的先后（:436/:602/:670/:765/:1366）。 |
| 4c | NaN / Infinity / 小数 | 不适用 | 切片内无数值运算取自外部输入；波次/人数均为 `int` 且由上游校验。 |
| 4d | 嵌套结构校验 | 不适用 | 无嵌套对象/数组的外部反序列化（`ArenaDefinition` 由代码构造）。 |
| 5 | 能力是否真实现 | 未命中 | 追了三条「声称的能力」：`restoreStarted` 屏障（:246/:1355/:1430/:1441/:1451 闭合）、`resetScheduled` 幂等（:181–187，且 `completeResetAfterRestore` 复位 :1452）、`sessionId` 让过期回调失效（:825/:842/:880）。三条均有实现而非空声明。 |
| 6 | 转义 / 编码顺序 | 不适用 | 无字符串拼接转义/编码逻辑。 |
| 7 | 边界符号（负数/下标） | 未命中 | `spawns.get(index % spawns.size())` 有 `!spawns.isEmpty()` 守卫（:1262–1265）；`Bukkit.getWorlds().get(0)`（:459）在无世界时会 IOOBE，但属理论态且为 error-handling，记入 off-dimension。 |
| 8 | 引用绑定是否存在 | 未命中 | 切片内所有被调符号均在 import 或本类/字段中定义（`PlayerGoodsManager` :9、`SafeSpawnUtil` :14、`ConcurrentHashMap` :25）；无「调用了未导入的名字」。 |

## 4. 自检（三项必做）

1. **标识符对账（DONE）**：对账了 `ArenaDefinition` 的 12 个字段 ↔ getter ↔ 17 参构造 ↔ `withGameParams/withWaitingLocation` 的转发参数，差集为空（逐一比对 :23–40、:129–167、:183–214、:274–279）。对账了 `restoreStarted` 的写点（:1356、:1430、:1441、:1451）与读点（:246、:734、:1035、:1092、:1242、:1355、:1488），无「只写不读」或「只读不写」。`GameState` 7 个枚举值在 `shouldClearInventoryOnMissingSnapshot`（:412–416）与 `isEnding()`（:801）中的覆盖均已核对。
2. **自带自检抽验（DONE）**：项目有 121 个测试文件（含 `.work/round1/post-fix` 副本）。抽验与切片直接相关的 2 个：`ArenaInstanceStateMatrixTest`（覆盖 7 态 + `null`，:51/:59/:66，纯断言、无「空集即通过」形态）、`ArenaDefinitionTest`（:310–386 断言 `withGameParams` 只换 4 个数值、原实例不变、逐字段保真）。**关键结论：`ArenaInstanceStateMatrixTest:51` 把「三态缺快照即清背包」写成 `assertTrue`，即该行为被测试固化为期望值，既有绿灯不能证明它安全。**
3. **运行时验证（SKIPPED）**：本仓库是 Maven + Bukkit 插件，`mvn test` 会写 `target/`，违反零写入；运行实例还需 Paper 服务端与竞技场世界，无法在只读约束内构造。已在 `self_checks.runtime_validation` 记录。

## 5. 复核方式

- 本发现的门 0 复核：`read ArenaInstance.java` 第 464/468/471 行，再读 `PlayerGoodsManager.java:179–220` 确认 `restore()` 的 false 语义与「成功后才 remove 快照」。
- L2 复核：`GameManager.java:656–669` 全文，确认方法体内无任何统计/落库调用。
- L5 复核：`MapRestoreManager.java:511–520`（合并）、`:627–633`（强制完成）、`:709–716`（回调必然执行）。

## 6. 信封

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "audit-slice-05-data-consistency",
  "role": "audit",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/.run-dsh3/artifacts/round1-02-audit-slice-05-data-consistency.md",
  "payload": {
    "slice_id": "slice-05",
    "findings": [
      {
        "finding_id": "F-05-DC-01",
        "severity": "MEDIUM",
        "dimension": "data-consistency",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/arena/ArenaInstance.java",
          "line": 471,
          "quote": "player.getInventory().clear();"
        },
        "inference": {
          "claim": "当玩家在 STARTING/RUNNING/WAVE_INTERMISSION 离场且内存中不存在物品快照时（goods == null，或 PlayerGoodsManager.restore() 返回 false），removePlayer 在第 471 行无条件清空玩家背包；此刻快照已不存在，清空即不可逆地销毁玩家原版物品，而同一方法在第 433–437 行已经把本局统计提交、第 440/446 行已撤销成员资格，两者与背包归还不构成一个事务。",
          "basis": "控制流：removePlayer 先 record 统计（ArenaInstance:433-437）→ players.remove（:440）→ gameManager.removePlayer（:446）→ 传送（:459）→ 到 :463-464 的 `if (goods == null || !goods.restore(player))`，再经 :468 的 shouldClearInventoryOnMissingSnapshot(state) 进入 :471 的 clear()。PlayerGoodsManager.restore 的返回语义是「内存里没有快照」（PlayerGoodsManager:184-185 的 snapshot == null 直接 return false），且快照只在全部写回成功后才从内存移除（:216-217），因此 false ⇒ 无任何可回滚副本。goods == null 分支（:464 短路）更严重：addPlayer 在管理器为 null 时既不建快照也不清背包（:322-324），玩家带着自己的物品入局，离场时被 :471 清掉，无快照可还原；代码自身只打一条 warning，措辞为 the original items may be lost（:475-477）。项目自带测试 ArenaInstanceStateMatrixTest:51 用 assertTrue 把三态清背包固化为期望值，故既有绿灯不能反证安全。",
          "alternatives": [
            "如果 PlayerGoodsManager 初始化失败时插件会中止启用（即 goods 永不为 null），则 goods == null 这一路不可达，只剩「快照意外丢失」的窄口径——需检查 src/main/java/com/hilltopvillage/HilltopVillagePlugin.java 的 onEnable 降级分支",
            "如果 restore() 返回 false 时磁盘上仍留有一份未被消耗的快照可人工回灌，则清空可恢复——需检查 src/main/java/com/hilltopvillage/core/PlayerGoodsManager.java:242-249 loadFromDisk 与 :498 saveNow 的落盘时机",
            "如果所有 removePlayer 调用点离场时状态都已是 WAITING/VICTORY/DEFEAT/ENDING，则 :468 的判定恒为 false、:471 不可达——但 RUNNING 下的退服/踢人路径会走到它（ArenaInstance:501-504 就在 RUNNING 内触发 stopGame），该条件不成立"
          ]
        },
        "status": "CONFIRMED"
      }
    ],
    "searched_scope": {
      "files_read": [
        "src/main/java/com/hilltopvillage/arena/ArenaDefinition.java",
        "src/main/java/com/hilltopvillage/arena/ArenaInstance.java"
      ],
      "files_in_slice": 2,
      "shared_dependencies_read": [
        "src/main/java/com/hilltopvillage/core/GameManager.java",
        "src/main/java/com/hilltopvillage/mechanics/MapRestoreManager.java",
        "src/main/java/com/hilltopvillage/arena/MultiArenaManager.java",
        "src/main/java/com/hilltopvillage/admin/ArenaAdminService.java"
      ],
      "files_scanned_without_findings": [
        "src/main/java/com/hilltopvillage/core/PlayerGoodsManager.java",
        "src/main/java/com/hilltopvillage/core/GameManager.java",
        "src/main/java/com/hilltopvillage/mechanics/MapRestoreManager.java",
        "src/main/java/com/hilltopvillage/arena/MultiArenaManager.java",
        "src/main/java/com/hilltopvillage/admin/ArenaAdminService.java",
        "src/test/java/com/hilltopvillage/arena/ArenaDefinitionTest.java",
        "src/test/java/com/hilltopvillage/arena/ArenaInstanceStateMatrixTest.java"
      ],
      "dimension_checklist": [
        { "pattern": "1 返回值暴露内部状态", "result": "未命中", "note": "ArenaDefinition 全部 copyLocation/unmodifiableList（:134-158、:221-223）；ArenaInstance.getSpawnPoints 转调 GameManager.getSpawnPoints，后者 new ArrayList 拷贝（GameManager:843-845）；getMobSpawnPointsView 为 unmodifiableList 活视图但本切片调用点只读" },
        { "pattern": "2 同族函数守卫一致性", "result": "未命中", "note": "applyGameParams 含 checkAutoStart、applyWaitingLocation 不含，但等待区不影响 isPlayable，非缺陷；removePlayer/removeOfflinePlayer/dropMember 的「先取统计再移除」顺序一致（:433/:599/:665）" },
        { "pattern": "3 数值边界", "result": "未命中", "note": "切片内无外部数值解析；definition 的 4 个数值由调用方 ArenaManager.validGameParams 前置校验（ArenaAdminService:496）" },
        { "pattern": "4a 原型链/裸下标", "result": "不适用", "note": "Java，无原型链；切片内无外部字符串当键查表" },
        { "pattern": "4b 假值 vs 缺值", "result": "未命中", "note": "sessionVictory 用 Boolean，null 明确表示中途离开不计胜负（:435/:601/:669/:1395）；波次用 Math.max 兼顾 0 与快照（:436/:602/:670/:765/:1366）" },
        { "pattern": "4c NaN/Infinity/小数", "result": "不适用", "note": "切片内无数值运算取自外部输入，波次/人数均为 int" },
        { "pattern": "4d 嵌套结构校验", "result": "不适用", "note": "无外部反序列化，ArenaDefinition 全部由代码构造" },
        { "pattern": "5 能力是否真实现", "result": "未命中", "note": "verified restoreStarted 屏障、resetScheduled 幂等、sessionId 过期失效三项均有实现（:246/:1355/:1430/:1441/:1451；:181-187/:1452；:825/:842/:880）" },
        { "pattern": "6 转义/编码顺序", "result": "不适用", "note": "切片内无字符串转义或编码拼接" },
        { "pattern": "7 边界符号（负数/下标）", "result": "未命中", "note": "spawns.get(index % spawns.size()) 有 !spawns.isEmpty() 守卫（:1262-1265）；Bukkit.getWorlds().get(0)（:459）无世界时 IOOBE 属理论态，记入 off_dimension_notes" },
        { "pattern": "8 引用绑定是否存在", "result": "未命中", "note": "切片内被调符号均有 import 或本类定义（PlayerGoodsManager:9、SafeSpawnUtil:14、ConcurrentHashMap:25），无未绑定引用" }
      ]
    },
    "self_checks": {
      "identifier_reconcile": {
        "status": "DONE",
        "note": "对账 ArenaDefinition 12 个字段↔getter↔17 参构造↔withGameParams/withWaitingLocation 转发参数，差集为空；对账 restoreStarted 4 个写点（1356/1430/1441/1451）与 7 个读点、resetScheduled 写点（182/1358/1442/1452）与读点（181），无单边标识符；GameState 7 态在 shouldClearInventoryOnMissingSnapshot 与 isEnding 的覆盖已核对"
      },
      "self_check_audit": {
        "status": "DONE",
        "note": "仓库有 121 个测试文件；抽验与切片直接相关的 2 个：ArenaInstanceStateMatrixTest（7 态+null，:51/:59/:66，纯断言无常空形态）与 ArenaDefinitionTest（:310-386 断言只换 4 个数值且原实例不变）。关键结论：前者把「三态缺快照即清背包」写成 assertTrue，该行为被测试固化为期望值，其绿灯不能证明安全"
      },
      "runtime_validation": {
        "status": "SKIPPED",
        "note": "Maven 构建与 mvn test 都会写 target/，违反被审仓库零写入约束；运行期复现另需 Paper 服务端与竞技场世界，本会话不可得"
      }
    },
    "off_dimension_notes": [
      "L1（error-handling）：ArenaDefinition.getCore() 契约允许 null（ArenaDefinition.java:16-19、:136），ArenaInstance 构造函数在 :133 取值后于 :140 直接 coreLocation.getWorld()，无守卫；失败形态是 NPE 而非可读异常，且构造体内 :162 cleanupOrphans() 的副作用已发生",
      "L3（logic）：beginEndSequence 在 ArenaInstance.java:814 直接赋值 state，绕过 setState 的 restoreStarted 屏障（:246）与迁移分支",
      "L4（concurrency）：definition 的读-改-写非原子（ArenaInstance.java:953、:970），volatile 只保证可见性",
      "L6（contract）：setState 命中屏障时静默 return（ArenaInstance.java:246-248），void 签名使调用方无法区分「已迁移」与「被吞」，:774 后仍会 scheduleReset",
      "L2/L5 两条上游线索在本维度均已查证为不成立，证据见正文 §1（stopGame 全文无统计/落库；restoreWithResult 合并 + restoreNow 强制完成，回调必然执行）",
      "ArenaInstance.java:459 的 Bukkit.getWorlds().get(0) 在无任何世界时抛 IndexOutOfBoundsException（理论态，error-handling 维度）",
      "ArenaInstance.java:1543-1560 的 while (remaining > 0) 若 getMaxStackSize() 返回 0 会死循环（logic/健壮性，当前 Material.isItem() 过滤下几乎不可达）"
    ]
  },
  "error": null
}
```
