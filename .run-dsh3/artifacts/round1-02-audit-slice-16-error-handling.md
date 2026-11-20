# slice-16 深挖 — error-handling（WaveManager.java）

- trace_id: trace-r1-20260215-hilltop-dsh3 / round1
- slice_id: slice-16
- dimension: error-handling
- 被审文件：`src/main/java/com/hilltopvillage/core/WaveManager.java`（1139 行，本轮 read 全文，未跳读）
- shared dependency：`src/main/java/com/hilltopvillage/core/GameManager.java`
- 被审仓库：`D:/Server/MCServers/Server plugin/Hilltop Village/Hilltop Village Plugin`（**只读**，本回合零写入、未跑 maven/gradle）
- 产物：本文件

## 1. 范围与方法

按任务书 §1 顺序加载了 evidence-policy / output-contract/audit / wave2-audit（1–842 行，分两次读完）/ report-naming / examples/audit，再读宽扫产物 `round1-02-sweep-slice-16.md`。

审计只做 error-handling：**异常路径**——谁抛、谁接、接不住时任务与状态会怎样。
控制流证据只取本切片文件 + 声明的 shared dependency（GameManager），另外读了 `arena/ArenaInstance.java:115-154`（40 行）仅用于确认 `getGameWorld()` 的实参来源（构造期 `coreLocation.getWorld()`），未据此扩展任何发现。

读的文件（3 个 Java 源文件）：

| 文件 | 用途 |
|---|---|
| `core/WaveManager.java` | 全量异常路径（三套刷怪任务 / 空投任务 / 特殊怪生成 / 属性应用 / 集合清理） |
| `core/GameManager.java` | `getGameWorld()` 实现（814-816）、`spawnWave` 唯一生产调用点（321）、`waveSpawning` 复位语义（317-327）、清波判定短路（445）、超时保险默认值（470-479） |
| `arena/ArenaInstance.java` | 仅确认 `new GameManager(...)` 传入 `coreLocation.getWorld()`（137-144），无 quote |

## 2. 线索处置（L1–L6 逐条）

| lead_id | 处置 | finding_id / 理由 | 证据行 |
|---|---|---|---|
| L1 `getGameWorld()` 未判空且只 catch IAE | **CONFIRMED** | F-slice-16-error-handling-01（MEDIUM） | `WaveManager.java:464`；对照 `:334`、`:404`、`:474` |
| L2 先置空句柄 → onComplete → cancel | **REJECTED** | 触发条件在生产代码中不存在：`spawnWave(int,Runnable)` 全仓唯一生产调用点是 `GameManager.java:321`，回调体为 `() -> waveSpawning = false`（纯赋值，不可能抛异常）；另一重载 `spawnWave(int)` 传 `null`（`WaveManager.java:88-89`）且无调用方。因此「回调抛异常 → cancel 不执行 → 每 3 tick 重复触发」在本仓库不可达。 | `GameManager.java:321`（本回合读取） |
| L3 空投批次 `spawnEntity` 无 try | **CONFIRMED** | F-slice-16-error-handling-02（MEDIUM） | `WaveManager.java:1011`；对照 `:556`、`:604`、`:657`、`:1002`、`:1028` |
| L4 `getAttribute` 返回值直接解引用 | **CONFIRMED** | F-slice-16-error-handling-03（LOW） | `WaveManager.java:574`；对照 `:491-492`、`:622`、`:682` |
| L5 `nearestPlayer` 跨世界回退 | **OFF_DIMENSION** | 属 logic（返回值语义），已记入 `off_dimension_notes`，不进 findings | — |
| L6 `getEntities()` 遍历中 remove | **OFF_DIMENSION** | 属 concurrency（快照假设/CME），已记入 `off_dimension_notes`，不进 findings | — |

L2 的补充说明（不为凑数硬立条）：167-169 的写法确实把「句柄置空」放在「回调」之前，是**脆弱顺序**；但 frame 的判据是「有具体失败场景」，而该场景要求 `onComplete` 抛异常，当前唯一实参是赋值 lambda。作为 off-dimension 的健壮性建议记一笔，不冒充 CONFIRMED。

## 3. 发现详述

### F-slice-16-error-handling-01（MEDIUM）刷怪默认分支的异常逃逸：只兜 IAE、不兜 world 为 null，而同类路径两处都兜了

- 证据（`:464`）：`Entity entity = world.spawnEntity(location, entityType);`
- 上下文（均为本回合读取）：
  - `:449` `World world = gameManager.getGameWorld();` —— 其后到 `:464` 之间**没有任何 null 检查**；
  - `:462-476` 整个 default 分支只有 `catch (IllegalArgumentException e)`（`:474`），`EntityType.valueOf` 抛的 IAE 被接住，其它 RuntimeException 不接；
  - 同文件另两条路径明确把 world 当可空处理：`:334` `if (loc != null && world != null) {`、`:404` `if (world == null) return 0;`；空投入口 `:982` 也先判 `dropLoc.getWorld() == null`。
- 推断：`spawnCustomMob` 由三套刷怪任务的 `run()` 直接调用（`:157`、`:252`，以及兜底路径 `:333-339` 自己判空）。一旦 `getGameWorld()` 为 null（或 `spawnEntity` 之后 `prepareWaveMob`/`applyMonsterEquipment` 抛出非 IAE 异常），异常会从 `BukkitRunnable.run()` 冒出 → 本波刷怪批次终止（Bukkit 取消该重复任务，或反复抛同一异常），`spawnedCount[0]` 停在原值 → `:164` 的完成条件永不成立 → `:168` 的 `onComplete.run()` 永不执行 → `GameManager.waveSpawning` 永久为 true（`:319` 置位，只有该回调与 `:325` 的 catch 分支会复位）→ `GameManager.java:445` `if (!waveSpawning && waveManager.isWaveCleared())` 永久为假 → 本波即使怪被清光也不判完成，超时保险默认又是禁用（`:470-476` `timeoutSeconds <= 0` 直接 return，注释称默认 0），只能 `/stop`。
- 为什么不是 HIGH：触发需要一个非 IAE 的 RuntimeException，`getGameWorld()` 的唯一赋值点是 `GameManager.java:121` 构造器，实参来自 `ArenaInstance.java:140` 的 `coreLocation.getWorld()`；「运行期该值会变 null」缺少运行时证据（无日志/无复现），按 evidence-policy §3 属「怀疑但未证实」，severity 封顶 MEDIUM、confidence LOW。
- 可推翻条件：
  1. 若 `GameManager.gameWorld` 在构造后不可能为 null（唯一赋值点 `GameManager.java:121`），则 NPE 分支不可达，本条只剩「非 IAE 异常不接」的窄面；
  2. 若 Bukkit 对 `runTaskTimer` 任务体抛出的异常不是取消任务而是继续调度，则后果变为「每 3 tick 重复同一异常 + 本波永久不完成」，结论仍成立但表现不同——需在测试服注入一次异常确认；
  3. 若 `GameManager` 在别处（`haltGame`/`endGame`）无条件复位 `waveSpawning`，则清波短路会被打破——需检查 `GameManager.java:636` 的复位是否在所有失败路径上被调用。

### F-slice-16-error-handling-02（MEDIUM）空投批次任务里 `spawnEntity` 裸调用：异常即整批中止，且任务句柄永久留在 `airdropTasks`

- 证据（`:1011`）：`Entity entity = world.spawnEntity(spawnLoc, mobType);`
- 上下文（本回合读取）：
  - `:993-1027` 的任务体从 `:1011` 到 `:1025` **没有任何 try/catch**；
  - 同文件三条特殊怪生成路径都显式包了 `catch (Exception e)` 并只跳过这一只：`:554-561`、`:602-609`、`:655-662`（注释写明「不能让异常冒泡终止整个刷怪任务」）；
  - 句柄生命周期：`:1028` `airdropTasks.add(handle[0]);`，集合内**唯一**移除点是 `:1002` `airdropTasks.remove(handle[0]);`，而它只在守卫分支（dropper 失效 / 换波 / 游戏结束 / 已满 / 数量够）里执行。
- 推断：`mobType` 来自配置（`:978` 注释「空投小怪的实体类型」），管理员可把它配成不可生成的类型（如 `PLAYER`，或需要额外数据的实体），`spawnEntity` 会抛 `IllegalArgumentException`。异常从任务体冒出后：① 本批剩余 `toSpawn - spawned[0]` 只永久不再空投（无重试、无补偿）；② `handle[0]` 既没走到 `:1002` 也没被清出 `airdropTasks`，成为集合里的死句柄，只有 `clearAllMobs()` → `cancelAirdropTasks()`（`:898-903`）在整局结束时才清；③ 与同文件三条特殊怪路径的 `catch (Exception)` 形成守卫不一致——那里明确选择「跳过一只、保住批次」。
- 为什么不是 HIGH：后果是「本批空投少刷 + 句柄泄漏」，不阻塞波次完成（空投怪不是清波的必要条件），也没有跨局状态污染；且 `mobType` 非法需要管理员误配。
- 可推翻条件：
  1. 若 `AirdropSpawnGoal.java:265` 传入的 `mobType` 已被上游限制为「可生成的白名单」，则 IAE 不可达——需读该文件的取值来源；
  2. 若 `EntityType` 的所有常量在 `World#spawnEntity` 上都不会抛 IAE（例如统一返回 null），则本条不成立——需在测试服对 `PLAYER` 实调一次；
  3. 若 `airdropTasks` 另有周期性清理（本文件内未见，`:899-902` 只在取消时清空），泄漏量可忽略。

### F-slice-16-error-handling-03（LOW）三条特殊怪生成路径对 `getAttribute` 不判空，而同文件 `applyMonsterEquipment` 判了

- 证据（`:574`）：`spider.getAttribute(Attribute.MAX_HEALTH).setBaseValue(health);`
- 上下文（本回合读取）：
  - 同文件 `:491-492` 的写法是 `var attackAttr = entity.getAttribute(Attribute.ATTACK_DAMAGE);` + `if (attackAttr != null && ...)`；
  - `:622` `skeleton.getAttribute(Attribute.MAX_HEALTH).setBaseValue(health);`、`:682` `phantom.getAttribute(Attribute.MAX_HEALTH).setBaseValue(health);` 同样直接解引用；
  - `:584` / `:632` / `:692` 的 `MOVEMENT_SPEED` 亦同；
  - 三条路径的 `entityType` 都可被管理员用 `monsters.<id>.entity-type` 覆盖（`:551-552`、`:599-600`、`:652-653`），只做了 `instanceof Mob` 判定（`:562`、`:610`、`:663`）。
- 推断：`LivingEntity#getAttribute` 在实体不具备该属性时返回 null。`MAX_HEALTH` 在主流 Mob 上存在，所以正常配置下不会 NPE；但代码自己的同族方法（`:491`）已经承认「属性可能不存在」，这里却直接解引用——一旦 `entity-type` 被配成无 `MAX_HEALTH` 的实体，`:574` 抛 NPE，且该 NPE 在 `:554-561` 的 try 之外，会从刷怪任务体冒出，后果与 F-01 同一条链（本波批次中止、`onComplete` 不执行）。
- 为什么是 LOW 而非更高：缺陷成立依赖「存在无 MAX_HEALTH 的 Mob 实现」这一未在本回合验证的前提；缺陷形态是守卫不一致 + 潜在 NPE，不是已证实的崩溃。
- 可推翻条件：
  1. 若目标 API 版本中所有 `Mob` 实现都带 `MAX_HEALTH`（可查 `pom.xml` 的 `paper-api` 版本后对照 `Attribute` 表），则本条降为风格问题，应删除；
  2. 若 `MonsterConfig#getEntityType` 在配置加载期已过滤为「有 MAX_HEALTH 的白名单」，则不可达——需读 `GameConfig`；
  3. 若 Bukkit 的 `getAttribute` 对缺失属性返回默认实例而非 null（与本文件 `:491` 的判空写法矛盾），则本条不成立。

## 4. 覆盖与排除记录

- 空吞异常：全文件 `catch` 共 4 处（`:474` 记 warning 后继续、`:556`/`:604`/`:657` 记 warning 后 `return` 跳过单只），**没有** `catch {}` 或 `catch` 后继续用未初始化变量。`:474` 的问题不是吞掉，而是**捕获面太窄**（已单列 F-01）。
- 解析类调用：`EntityType.valueOf`（`:463`）在 try 内、IAE 被接；本切片无 `Integer.parseInt` / `Double.parseDouble` / `UUID.fromString` / `Material.valueOf` / `Sound.valueOf`。
- 配置返回 null 后解引用：`getMonsters().get(...)` 的返回值都做了 `mc != null` 判定（`:551`、`:573`、`:583`、`:599`、`:621`、`:631`、`:652`、`:681`、`:691`）或由 `applyMonsterEquipment` 首行 `if (mc == null) return;`（`:488`）兜住；`getMobSpawnPointsView()` 的空集在 `:715` 处理。
- scheduler 任务抛异常：三套刷怪任务 + 空投任务的 `run()` 内只有 F-01/F-02 两条逃逸面；`state != RUNNING` 守卫（`:145`、`:242`、`:325`、`:997-1001`）都在任务体首部，自身不会抛。
- 返回值 null 表示失败：`getRandomSpawnLocation()` 返回 null 的三处调用全部判空（`:156`、`:251`、`:334`），`SafeSpawnUtil.findSafeGround` 的 null 在 `:743`/`:775`/`:780` 处被消费，均无未判空解引用。
- 边界说明（不立条）：`:1009` `dropLoc.clone().add(...)`、`:1022-1023` 的 `playSound`/`spawnParticle` 也在无 try 的任务体内，但它们不改变 F-02 的结论，不重复计数。

## 5. 自检

- **标识符对账（DONE）**：四类对账中与本维度相关的两组做了集合比对——① `airdropTasks` 的写/读配对：`add` 仅 `:1028`，`remove` 仅 `:1002`（守卫分支），另有 `:899-902` 全量 cancel+clear；差集 = 「异常退出路径无 remove」→ 对应 F-02。② `spawnTask` 的置空点：`:167`、`:260`、`:346`、`:878`；`onComplete` 调用点 `:104`、`:168`、`:222`、`:261`、`:317`，其中只有 `:168`/`:261`/`:346` 在任务体内且在 `cancel()` 之前 → 对应 L2 的处置。③ 守卫一致性：`getGameWorld()` 判空点 `:334`、`:404`、`:982`、`:1113` vs 未判空点 `:449→:464`、`:547→:555`、`:595→:603`、`:648→:656` → 对应 F-01。CSS/DOM 类对账不适用于 Java 源文件。
- **自带自检抽验（NOT_APPLICABLE）**：本切片是单个 Java 业务类，仓库内没有与该类配套的 `check-*`/`verify*` 脚本或单测（宽扫产物亦未列出）；按第 4.7 节需抽验的对象不存在，故不适用，且零写入禁止跑 maven 构建来补。
- **运行时验证（SKIPPED）**：验证 NPE/异常逃逸需起 Paper 服务端并 `mvn package`，会写 `target/` 并需完整服务器世界，违反本任务「零写入、不跑构建」的硬约束；因此 F-01/F-02 均在 `alternatives` 里写明「缺少运行时证据」与可证伪的检查点，severity 已按 evidence-policy §3 封顶 MEDIUM。
- **线索闭合**：L1–L6 全部处置（3 CONFIRMED / 1 REJECTED / 2 OFF_DIMENSION），无遗漏。
- **维度单一**：3 条 finding 的 `dimension` 均为 `error-handling`；L5/L6 已移出 findings。
- **零写入**：未创建、修改、删除被审仓库任何文件；未执行 git 写命令；未跑构建。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "audit-slice-16-error-handling",
  "role": "audit",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/.run-dsh3/artifacts/round1-02-audit-slice-16-error-handling.md",
  "payload": {
    "slice_id": "slice-16",
    "findings": [
      {
        "finding_id": "F-slice-16-error-handling-01",
        "severity": "MEDIUM",
        "dimension": "error-handling",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/core/WaveManager.java",
          "line": 464,
          "quote": "Entity entity = world.spawnEntity(location, entityType);"
        },
        "inference": {
          "claim": "刷怪默认分支只捕获 IllegalArgumentException，且对 gameManager.getGameWorld() 的返回值不判空；一旦 world 为 null 或 spawnEntity 之后抛出其它 RuntimeException，异常会从 runTaskTimer 的任务体冒出，本波批次中止且 onComplete 永不执行——GameManager.waveSpawning 因此永久为 true，清波判定被永久短路，本波无法结束。",
          "basis": "控制流：:136-172 的 BukkitRunnable.run() 在 :157 调用 spawnCustomMob，而 spawnCustomMob 在 :449 取 world、:464 直接 world.spawnEntity，:462-476 的 try 只 catch IllegalArgumentException（:474）。异常冒泡后 :164 的 spawnedCount[0] >= remainingRef[0] 永不成立，:168 的 onComplete.run() 不执行；onComplete 是 GameManager.java:321 传入的 () -> waveSpawning = false，而 waveSpawning 只在 :319 置 true、:325 catch 分支与回调里复位。GameManager.java:445 的清波判定写作 if (!waveSpawning && waveManager.isWaveCleared())，故标志卡 true 即永久不判完成；超时保险在 GameManager.java:475-476 因 timeoutSeconds <= 0（注释称默认 0）直接 return。同类路径把 world 当可空处理（:334 if (loc != null && world != null)、:404 if (world == null) return 0;、:982 dropLoc.getWorld() == null），说明作者在别处已承认该值可能为 null。",
          "alternatives": [
            "若 GameManager.gameWorld 在构造后不可能为 null（唯一赋值点 GameManager.java:121，实参来自 ArenaInstance.java:140 的 coreLocation.getWorld()），则 NPE 路径不可达，本条只剩「非 IAE 异常不被捕获」的窄面——需检查 GameManager.java:121 与 ArenaInstance.java:140 是否存在世界未加载窗口",
            "若 Bukkit 对 runTaskTimer 任务体抛出的异常不是取消任务而是继续调度，后果变为每 3 tick 重复同一异常且本波同样永不完成，结论不变但表现不同——需在测试服注入一次异常观察调度器行为",
            "若 GameManager 在 haltGame/endGame 等路径无条件复位 waveSpawning（例如 GameManager.java:636），清波短路会被打破，后果降为「本波少刷怪」——需核对 :636 是否覆盖所有失败路径"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "F-slice-16-error-handling-02",
        "severity": "MEDIUM",
        "dimension": "error-handling",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/core/WaveManager.java",
          "line": 1011,
          "quote": "Entity entity = world.spawnEntity(spawnLoc, mobType);"
        },
        "inference": {
          "claim": "空投批次任务体内的 spawnEntity 没有任何 try/catch，mobType 来自管理员可配的空投怪类型；一旦该类型不可生成而抛 IllegalArgumentException，本批剩余空投永久丢失，且任务句柄不会被移出 airdropTasks，成为集合内的死句柄直到整局结束才被清空。",
          "basis": "控制流：spawnAirdropMobs 在 :982 只判 dropLoc/world/mobType 非空，:993-1027 的任务体从 :1011 到 :1025 无 try，异常直接冒出 run()。句柄生命周期为 :1028 airdropTasks.add(handle[0])，而集合内唯一移除点是 :1002 airdropTasks.remove(handle[0])，它只在守卫分支（dropper 失效 / 换波 / 游戏结束 / 已满 / 数量够）执行；异常路径既不 remove 也不 cancel，只有 clearAllMobs -> cancelAirdropTasks（:898-903）在整局结束才全量清空。同文件三条特殊怪生成路径对同一调用显式包了 catch (Exception)（:554-561、:602-609、:655-662）并注明「不能让异常冒泡终止整个刷怪任务」，本条路径缺这道守卫。",
          "alternatives": [
            "若 AirdropSpawnGoal.java:265 传入的 mobType 已被上游限制为可生成白名单，则 IAE 不可达——需读该文件里 mobType 的取值来源",
            "若 World#spawnEntity 对任何 EntityType 常量都不抛 IAE（例如统一返回 null），则本条不成立——需在测试服对 PLAYER 之类不可生成类型实调一次",
            "若 airdropTasks 存在本文件之外的周期性清理，死句柄泄漏量可忽略——需检查 clearAllMobs 之外是否有 cancelAirdropTasks 的调用点"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "F-slice-16-error-handling-03",
        "severity": "LOW",
        "dimension": "error-handling",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/core/WaveManager.java",
          "line": 574,
          "quote": "spider.getAttribute(Attribute.MAX_HEALTH).setBaseValue(health);"
        },
        "inference": {
          "claim": "三条特殊怪生成路径对 getAttribute 的返回值直接解引用，而同文件 applyMonsterEquipment 对 ATTACK_DAMAGE 做了判空；若 monsters.<id>.entity-type 被配置成不具备 MAX_HEALTH 的实体，:574 / :622 / :682 会抛 NPE，且该异常在 :554-561 的 try 之外，会从刷怪任务体冒出。",
          "basis": "同族守卫不一致：:491-492 写作 var attackAttr = entity.getAttribute(Attribute.ATTACK_DAMAGE); 后接 if (attackAttr != null && mc.getBaseDamage() > 0)，证明作者认为 getAttribute 可返回 null；而 :574（甲虫）、:622（猎手）、:682（抛投者）三处均直接 .setBaseValue，:584/:632/:692 的 MOVEMENT_SPEED 同样。这三条路径的 entityType 都可被配置覆盖（:551-552、:599-600、:652-653），只经过 instanceof Mob 判定（:562、:610、:663），而 :554-561 的 try 只包住 spawnEntity 本身，属性设置在其外。",
          "alternatives": [
            "若目标 paper-api 版本中所有 Mob 实现都带 MAX_HEALTH 属性，则本条只是风格不一致，应删除——需查 pom.xml 的 paper-api 版本后对照 Attribute 覆盖表",
            "若 MonsterConfig#getEntityType 在配置加载期已过滤为带 MAX_HEALTH 的白名单，则不可达——需读 GameConfig 的 MonsterConfig 实现",
            "若 Bukkit 的 getAttribute 对缺失属性返回默认实例而非 null（与 :491 的判空写法矛盾），则本条不成立——需以一次实调或 API 文档确认返回语义"
          ]
        },
        "status": "CONFIRMED"
      }
    ],
    "searched_scope": {
      "files_read": [
        "src/main/java/com/hilltopvillage/core/WaveManager.java",
        "src/main/java/com/hilltopvillage/core/GameManager.java"
      ],
      "files_in_slice": 1,
      "shared_dependencies_read": [
        "src/main/java/com/hilltopvillage/core/GameManager.java"
      ],
      "files_scanned_without_findings": [
        "src/main/java/com/hilltopvillage/arena/ArenaInstance.java"
      ],
      "dimension_checklist": [
        { "pattern": "1 返回值暴露内部状态", "result": "不适用", "note": "error-handling 维度不判集合别名；getActiveMobs 返回 unmodifiableSet（:1046），异常路径无关" },
        { "pattern": "2 同族函数守卫一致性", "result": "命中", "note": "getAttribute 在 :491 判空、:574/:622/:682 未判空（F-03）；getGameWorld 在 :334/:404 判空、:449→:464 未判空（F-01）；特殊怪 spawnEntity 有 catch(Exception)、空投路径无 try（F-02）" },
        { "pattern": "3 数值边界", "result": "未命中", "note": "刷怪计数 remaining/spawned 由 :111-112 三层 Math.min 与 :988 Math.max(0, ...) 夹取；掉落区间在 :857-864 双向钳制并交换 min/max" },
        { "pattern": "4a 原型链/裸下标", "result": "未命中", "note": "Java 无原型链；集合下标访问仅 :249/:751，前者受 spawned[0] < total 约束、后者受 :715 非空集约束" },
        { "pattern": "4b 假值 vs 缺值", "result": "未命中", "note": "mc 用 != null 判定（:551/:573/:599/:621/:652/:681 与 :488），未用布尔化；配置哨兵值 <0 在 :854-855 显式处理" },
        { "pattern": "4c NaN/Infinity/小数", "result": "未命中", "note": "本维度相关的 health/speed 直接来自配置 double，未参与除法或取整；trimProportionally 的除法在 :277 且 total>0（:217 前置）" },
        { "pattern": "4d 嵌套结构校验", "result": "未命中", "note": "异常路径不消费嵌套结构；getMonsters().get(...) 的 null 由 :488 首行兜住" },
        { "pattern": "5 能力是否真实现", "result": "命中", "note": "三条特殊怪路径注释声称「不能让异常冒泡终止整个任务」并实现了 catch(Exception)（:556/:604/:657），但空投路径（:1011）没有对应实现——承诺与实现不一致，见 F-02" },
        { "pattern": "6 转义/编码顺序", "result": "不适用", "note": "Java 源码，本切片无多层转义或编码拼接" },
        { "pattern": "7 边界符号（负数/下标）", "result": "未命中", "note": "空投只数在 :988 双向 Math.max(0, ...) 收敛；purge/relocate 用副本遍历（:1065/:1097），无负下标" },
        { "pattern": "8 引用绑定是否存在", "result": "未命中", "note": "编译期绑定由 javac 保证；本回合未发现调用了未导入/未声明的符号（未跑构建，属静态核对）" }
      ]
    },
    "self_checks": {
      "identifier_reconcile": {
        "status": "DONE",
        "note": "对账三组标识符：airdropTasks 写/读配对（add 仅 :1028，remove 仅 :1002 守卫分支）差集=异常退出无 remove → F-02；spawnTask 置空点（:167/:260/:346/:878）与 onComplete 调用点（:104/:168/:222/:261/:317）比对 → L2 判 REJECTED；getGameWorld 判空点（:334/:404/:982/:1113）vs 未判空点（:449→:464）→ F-01"
      },
      "self_check_audit": {
        "status": "NOT_APPLICABLE",
        "note": "本切片是单个 Java 业务类，仓库内无与该类配套的 check-*/verify* 脚本或单测可抽验；宽扫产物也未列出任何自带检查，故第 4.7 节四项无对象可做"
      },
      "runtime_validation": {
        "status": "SKIPPED",
        "note": "验证异常逃逸需起 Paper 服务端并跑 mvn package，会写 target/ 且需完整世界环境，违反本任务零写入与不跑构建的硬约束；已在各 finding 的 alternatives 写明缺少运行时证据与可证伪检查点"
      }
    },
    "off_dimension_notes": [
      "L5（logic，WaveManager.java:1130）：nearestPlayer 在所有候选世界都不匹配时仍返回 players.get(0)（:1126），随后 :1079 跨世界 teleport——属 logic 的返回值语义/状态机问题，已按维度隔离移出 findings。",
      "L6（concurrency，WaveManager.java:406）：cleanupOrphans 在 world.getEntities() 遍历中直接 living.remove()（:411），依赖 Bukkit 返回独立快照这一未声明前提；:435-437 的启动清扫同样写法。属 concurrency，移出 findings。",
      "L2 的健壮性残留（error-handling 但不满足门 0 的失败场景）：:167-169 把 spawnTask = null 放在 onComplete.run() 之前、cancel() 之后，若将来给 spawnWave 传入会抛异常的 Runnable，句柄会先丢、cancel 会被跳过。当前唯一生产实参是 GameManager.java:321 的赋值 lambda，不可抛，故不作为 CONFIRMED，仅留作下游修复建议。",
      "空投任务体内 :1009 dropLoc.clone().add(...) 与 :1022-1023 playSound/spawnParticle 同样无 try，但它们不改变 F-02 的后果判断，未单列，避免同一形态重复计数。"
    ]
  },
  "error": null
}
```
