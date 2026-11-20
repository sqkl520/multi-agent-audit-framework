# round1 / slice-01 / data-consistency 深挖审计

- trace_id: trace-r1-20260215-hilltop-dsh3
- round_id: round1
- slice_id: slice-01
- dimension: data-consistency（**只报这一个维度**）
- agent_id: audit-slice-01-data-consistency
- 被审仓库: `D:\Server\MCServers\Server plugin\Hilltop Village\Hilltop Village Plugin`（只读，零写入）
- 切片文件: `AdminDeployManager.java`(860) / `ArenaAdminService.java`(794) / `ArenaResetService.java`(634)
- shared_dependencies: `ArenaManager.java`(907) / `YamlFileGate.java`(122)

## 1. 读法与覆盖

本回合用 read 全文读完 3 个切片文件与 2 个 shared_dependency；另按「直接调用方/被调用方」余量读了 4 个直接 callee 的目标区段与 2 个仓库脚本：

| 文件 | 读法 | 用途 |
|---|---|---|
| AdminDeployManager.java | 全文 1–860 | 主证据（F-01） |
| ArenaResetService.java | 全文 1–634 | 主证据（F-02） |
| ArenaAdminService.java | 全文 1–794 | 只读视图/删除路径（L6 处置） |
| ArenaManager.java | 全文 1–907 | `clearDeploymentData` / `updateGameParams` / gate 归属 |
| YamlFileGate.java | 全文 1–122 | `load/writable/write` 语义（L6） |
| YamlFiles.java | 全文 1–426 | 隔离（`*.corrupt`）与原子写实现（L1/L6） |
| NodeSystem.java | 240–399、430–695 | `readNodesForWorld/clearNodesForWorld/clearAllNodes` 数量口径（L1） |
| NpcManager.java | 150–309 | `despawnIfInWorld/despawnNpc/respawnFromConfig`（F-02） |
| SetupWizard.java | 1215–1294 | `setCoreLocation(null)` 调用点语义（P2-4 排除） |
| build.sh / gen-messages-legacy.mjs | 全文 / 1–60 | 仓库自带脚本抽验（无 verify/check 类脚本） |

`MultiArenaManager.java` 仅用 grep 定位过 `enableArena` 签名与全仓 `getNpcManager()/spawnNpc()` 调用点，未逐行读——这一点已写进 F-02 的 alternatives，供 Skeptic 定向补证。

## 2. 线索逐条处置（L1–L6，一条不漏）

| lead | 宽扫疑似维度 | 处置 | 结论与依据 |
|---|---|---|---|
| L1 部分删除仍继续 reset | data-consistency | **REFUTED** | 不存在「0 < removed < expected」态。`clearNodesForWorld` 先数出该世界全部条目 `removed`，再 `return writeNodes(...) ? removed : 0`（NodeSystem.java:506）；写盘失败一律返回 0，成功则返回全部条目数。定量见 §3。 |
| L2 异常兜底不恢复启用 | error-handling | **REFUTED（不构成本维度缺陷）** | 属实但根因是「恢复路径缺失」，归 error-handling：`reset()` 的 catch（ArenaResetService.java:244-250）只 `releaseInFlight` + `deliver`，不调用 `abort()/reinstateRestoring()`；磁盘侧 arenas.yml 未被改动、自身自洽，重启会按 `enabled` 重新启用。已写入 `off_dimension_notes`，不入 findings。 |
| L3 商店实体先删、配置后清，失败不回滚 | data-consistency | **CONFIRMED → F-slice-01-data-consistency-02** | 见 §4.2。 |
| L4 一次保存拆两次整份写盘 | data-consistency | **CONFIRMED → F-slice-01-data-consistency-01** | 见 §4.1。 |
| L5 用陈旧副本覆写 | data-consistency | **REFUTED** | `migrateLegacyShopNpc` 写盘用的 `arenasConfig` 并非陈旧副本：唯一调用链是 `loadSpawnPoints()`（317）→ `loadShopNpcLocation`（363）→ `migrateLegacyShopNpc`，而同一方法在 244 行刚把该字段赋值为 `gate.load()` 的返回值；244→399 之间没有任何 arenas.yml 写入方（317 前只有 `ensureSpawnPointsConfigLoaded()` 读 spawnpoints.yml，333），全同步主线程。故写盘基准与磁盘同一版本，不存在「用旧副本回滚他人落盘」。 |
| L6 只读视图走可能触发隔离的 load | data-consistency | **REFUTED** | 隔离确实会被只读视图触发（`buildView`→`loadArenas()`(542)→`gate.load()`(637)→`YamlFiles.load`→`quarantine`），但 `quarantine` 用 `Files.move` 把原文件整体改名 `*.corrupt`（YamlFiles.java:166-172），**原字节不丢**；同时 gate 上闩、`ensureFile()` 双信号拒绝重建（ArenaManager.java:841-851），不存在「读一下就把数据洗成空」的路径。属设计内的降级检测，不构成落盘一致性缺陷。 |

## 3. L1 的数量口径（明确到可复算）

记：

- `n` = nodes.yml 中 `world` 字段（忽略大小写）等于目标世界的条目总数（NodeSystem.java:498 的判据）；
- `e` = `readNodesForWorld` 返回条数 = 同世界**且** x/y/z 均为 `Number` 的条目数（NodeSystem.java:630-642），因此恒有 `e ≤ n`；
- `r` = `clearNodesForWorld` 返回值（ArenaResetService.java:292）。

`clearNodesForWorld` 的行为是「先全删、后整份写」，返回值只有两种取值（NodeSystem.java:494-506）：

- 写盘成功 → `r = n`（该世界条目全部删除并已落盘）；
- 写盘失败 / `n == 0` → `r = 0`。

于是 `r` **不可能落在 (0, e) 区间**，守卫 `expectedNodes > 0 && removedNodes == 0`（ArenaResetService.java:295）在 `e > 0` 时只在「写盘失败」命中，处置正确；`e == 0` 时 `r == 0` 表示「本来就没有可读节点」，继续 reset 也正确（此时若 `n > 0`，即该世界条目坐标全损坏，`r = n > 0`，同样会被删净，不会残留）。

唯一的口径偏差方向相反：`n > e`（存在坐标损坏条目）时日志与返回值会大于备份条数，`abort` 的 `nodeBackup` 只含 `e` 条合法节点，损坏条目不可恢复——这是清理语义的既有取舍，**不产生「无主节点残留」**。因此 L1 的原始怀疑不成立。

## 4. CONFIRMED 发现

### 4.1 F-slice-01-data-consistency-01（MEDIUM）一次保存 = 两次独立整份写盘

- 证据：`src/main/java/com/hilltopvillage/admin/AdminDeployManager.java:557`
  `if (!saveShopNpcLocation()) {`
- 写盘 #1：同方法 539 行 `boolean saved = gate.write(arenasConfig);`（基准是 476 行刚 load 的磁盘内容）
- 写盘 #2：557 行进入 `saveShopNpcLocation()` → 590 行再次 `gate.load()` → 610 行 `gate.write(yaml)`
- 两次替换各自原子（YamlFiles.java:111-131 同目录临时名 + `ATOMIC_MOVE`），但**两次之间没有事务边界**。

可观测后果（两条，都指向「一次保存应只有一个磁盘状态」）：

1. **半成功**：写盘 #1 成功后 `gameManager.setSpawnPoints(...)` 已刷新（550-554），写盘 #2 失败只返回一个 `false`（557-562）；磁盘停在「spawn-points 已更新、arenas.<id>.shop-npc 仍旧」，代码自己在 558-559 行承认这个状态。
2. **清空商店被回滚**：管理员清除商店时 `savedShopNpcLocation == null`，写盘 #1 用的配置来自 476 行的磁盘读取，其中 `shop-npc` 仍是旧值（525-536 只写 spawn/mob/villager/core/waiting，没有 shop-npc 分支），旧键要到写盘 #2（598-605 的 `yaml.set(path, null)`）才被删。两次写之间进程退出 → 已清除的商店 NPC 在重启后由 `NpcManager.respawnFromConfig()`（HilltopVillagePlugin.java:162）复活。

为何不是 HIGH：触发半成功需要第二次写盘失败或两次写之间进程终止，窗口在毫秒级；且失败时返回值与 `lastSaveFailed` 都如实为 false（544-547、560-561），管理员能收到失败播报。

### 4.2 F-slice-01-data-consistency-02（MEDIUM）实体先删、配置后清：中止路径不恢复实体

- 证据：`src/main/java/com/hilltopvillage/admin/ArenaResetService.java:312`
  `if (despawnOwnShopNpc(world)) {`
- 调用链（入口 → 问题点 → 中止）：`reset()`(221) → `proceed()`(264) → `disableArena`(286) → `clearNodesForWorld`(292) → **`despawnOwnShopNpc`(312)** → `NpcManager.despawnIfInWorld`(NpcManager.java:170-180) → `despawnNpc()`(152-158，只 `npc.remove(); npc = null`，不写盘) → `clearDeploymentData(arenaId)`(318) → 返回 false → `abort("deployment", ...)`(336-339) → `reinstateRestoring`(452-463) → `enableArena`(527)。
- 关键点：`abort` 的入参只有 `nodesCleared / dataCleared / tryReinstate`（441-463），**没有任何实体恢复动作**；节点有 `nodeBackup` 可回滚（323-334），商店实体没有。
- 于是当第 8 步写盘失败（arenas.yml unusable / 写失败 / 该竞技场键缺失，ArenaManager.java:716-753）而节点回滚成功时：竞技场被重新启用、`arenas.<id>.shop-npc` 仍在磁盘上（第 8 步没写成功），世界里却没有实体；`respawnFromConfig()` 全仓唯一调用点是插件启动（HilltopVillagePlugin.java:162），`enableArena` 不生成实体（全仓 `getNpcManager()` 15 处调用点无一在 MultiArenaManager）。结果是 GUI `shopNpcSet=true`（ArenaAdminService.java:539/549）但玩家找不到商店，直到重启。

为何不是 HIGH：需要第 8 步写盘失败（即 arenas.yml 已处于降级/故障态）叠加节点回滚成功才成立；且竞技场此时已被重新启用，影响是「功能缺失」而非数据丢失。

## 5. 同维度已排除的候选（正文留痕，不入 findings）

| 候选 | 排除理由 |
|---|---|
| `saveShopNpcLocation` 先 `writable()`(582) 后 `load()`(590)，与同类 `saveSpawnPoints` 的「先 load 再查 writable」(471-490) 顺序相反 | 591 行 load 之后重新判 `!loaded.usable() \|\| gate.isReadOnly()`，不会写出只读文件；仅多一次 warning，无落盘后果。 |
| `saveSpawnPoints` 对 core 只在非 null 时写 x/y/z(525-529)，无「null 即删除」 | 刻意设计：SetupWizard.java:1243-1248 的 P2-4 注释明确「避免只改商店的场在第 1 步就被物理删除 core」，core 的删除只由 `clearDeploymentData` 负责（ArenaManager.java:734-738）。 |
| `removeSpawnPoint/clearSpawnPoints` 写盘失败时不回滚内存 | 已在方法 javadoc 声明（690-691「写盘失败时内存里的移除不回滚」），且返回值/`lastSaveFailed` 如实上报，属显式取舍。 |
| `migrateLegacyShopNpc` 写盘失败仍返回 legacy | 幂等：下次 load 从同一份 spawnpoints.yml 重试（374-377、400-403）。 |

## 6. 维度清单（data-consistency 逐模式结论）

| # | 模式 | 结论 | 说明 |
|---|---|---|---|
| 1 | 返回值暴露内部状态 | 未命中 | `getSpawnPoints` 返回 `unmodifiableList`(622)；`getVillagers` 返回克隆(743-747)；`ArenaAdminService.immutableCopy` 再包一层(614-616)。 |
| 2 | 同族函数守卫一致性 | 命中（已排除） | 两个写盘方法的 load/writable 顺序不一致，但后者 load 后复判，见 §5。 |
| 3 | 数值边界 | 未命中 | 下标 `index < 0 \|\| index >= size` 统一（694/730/766）；`validGameParams` 要求 `min>0,max>=min,waves>0,interval>0`（ArenaManager.java:823-829）。 |
| 4a | 原型链 / 裸下标 | 不适用 | Java，无原型链；YAML 访问统一走 `isSet` / `isConfigurationSection`。 |
| 4b | 假值 vs 缺值 | 未命中 | `readLocation` 用 `isSet("x")` 区分「缺失」与 0.0（423-426）；`saveShopNpcLocation` 用 `isSet(path)` 再删（600-605）。 |
| 4c | NaN / Infinity / 小数 | 未命中 | `Double.isFinite` 校验坐标（428-431；ArenaAdminService.java:791）。 |
| 4d | 嵌套结构校验 | 未命中 | 位置节点逐键校验；列表条目逐条 `readCoordinates`，坏的跳过（656-673）。 |
| 5 | 能力是否真实现（写前重读） | 命中（已落实） | `saveSpawnPoints`(476)、`saveShopNpcLocation`(590)、`clearDeploymentData`(719)、`updateGameParams`(786) 均写前重读；`migrateLegacyShopNpc` 复用同栈内刚读的副本（见 L5）。 |
| 6 | 转义 / 编码顺序 | 不适用 | 本切片无字符串转义/编码层；写盘编码统一 UTF-8（YamlFiles.java:119）。 |
| 7 | 边界符号（负数 / 下标） | 未命中 | 负数下标在各入口先拒（见模式 3）。 |
| 8 | 引用绑定是否存在 | 未命中 | 本回合未发现调用未声明符号；`AdminDeployManager` 引用的 `ArenaManager.SHOP_NPC_MIGRATED_KEY` 确实存在（ArenaManager.java:96）。 |

## 7. 自检三项（结果已同步进 payload.self_checks）

1. **标识符对账（YAML 键级）**：对账了 arenas.yml 的键集合——`DEPLOYMENT_KEYS`（ArenaManager.java:80-82）vs `AdminDeployManager` 写入键（spawn-points / mob-spawn-points / villagers / core / waiting-location / shop-npc / shop-npc-migrated）vs `ArenaAdminService` 常量（SPAWN_POINTS_KEY / MOB_SPAWN_POINTS_KEY / VILLAGERS_KEY / SHOP_NPC_KEY）。差集只有 `waiting-location` 不在 `DEPLOYMENT_KEYS`，且两侧注释都写明是刻意（重置不清等待区）。无拼写级失效。
2. **自带自检抽验**：仓库无 `src/test`，无 `check-*`/`verify-*` 脚本；仅 `build.sh`（构建包装，会写 `target/`，本回合禁跑）与 `.work/fix-critical/gen-messages-legacy.mjs`（一次性代码生成器，缺 yaml 解析器时 `exit 1`）。两者都不是针对本切片不变量的断言脚本，故无「绿灯」可采信；改用内联守卫推演：把 `clearNodesForWorld` 强制为 0 → `abort("nodes")` 分支触发（295-299）；把 `clearDeploymentData` 强制 false → `abort("deployment")` 触发（336-339）。
3. **运行时验证**：SKIPPED。需 Paper/Spigot 服务端与已加载竞技场世界，`build.sh`/Maven 会写 `target/`，违反零写入；无 `runnable: true`。

## 8. off_dimension_notes

见 payload。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "audit-slice-01-data-consistency",
  "role": "audit",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/.run-dsh3/artifacts/round1-02-audit-slice-01-data-consistency.md",
  "payload": {
    "slice_id": "slice-01",
    "findings": [
      {
        "finding_id": "F-slice-01-data-consistency-01",
        "severity": "MEDIUM",
        "dimension": "data-consistency",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/admin/AdminDeployManager.java",
          "line": 557,
          "quote": "if (!saveShopNpcLocation()) {"
        },
        "inference": {
          "claim": "一次 saveSpawnPoints() 被拆成两次独立的整份写盘：539 行先 gate.write(arenasConfig)，557 行再调用 saveShopNpcLocation()（590 行重新 load、610 行再整份写一次）。第二次写盘失败、或进程在两次写之间退出时，磁盘停在「生成点已更新、arenas.<id>.shop-npc 仍旧」的半成功状态；清空商店时旧 shop-npc 键要到第二次写盘才被删除，因此该窗口内退出会让已清除的商店 NPC 在重启后被 respawnFromConfig 复活。预期是一次保存只产生一个可见的磁盘状态。",
          "basis": "控制流：saveSpawnPoints()(454) → gate.load()(476) → arenasConfig.set(...)(501-536) → gate.write(arenasConfig)(539) → saveShopNpcLocation()(557) → gate.load()(590) → gate.write(yaml)(610)。YamlFiles.write 用同目录临时文件 + ATOMIC_MOVE（YamlFiles.java:111-131），单次替换是原子的，但两次替换之间没有事务边界；第一次写盘用的配置来自 476 行读到的磁盘内容，其中 shop-npc 仍是旧值（525-536 无 shop-npc 分支），删除只发生在 598-605。",
          "alternatives": [
            "如果所有 false 返回的调用方都会立刻重跑一次 saveSpawnPoints()（把 shop-npc 一并重写），半成功状态会在下一次保存收敛——需检查 SetupWizard.autoSave 的实现（调用点 SetupWizard.java:1250、SetupWizard.java:1266）是否无条件重试。",
            "如果 arenas.<id>.shop-npc 的删除在第一次写盘时就已落盘（即 525-536 段对 null 的 shop-npc 也有删除分支），则「已清除的 NPC 复活」这一具体后果不成立——需检查 AdminDeployManager.java:525-536 是否含 shop-npc 的删除分支。",
            "如果进程在两次 gate.write 之间不可能退出（同一 tick 内同步完成且无强制终止），则崩溃窗口不成立——需检查 saveSpawnPoints 的调用点是否都在主线程同步路径（SetupWizard.java:1250、HilltopCommandHandler.java:911）。"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "F-slice-01-data-consistency-02",
        "severity": "MEDIUM",
        "dimension": "data-consistency",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/admin/ArenaResetService.java",
          "line": 312,
          "quote": "if (despawnOwnShopNpc(world)) {"
        },
        "inference": {
          "claim": "重置序列第 7 步先删除世界里的商店 NPC 实体，第 8 步 clearDeploymentData 失败时 abort() 只回滚 nodes.yml 并重新启用竞技场，不恢复实体；arenas.yml 里 shop-npc 未被删（第 8 步没写成功），于是磁盘声明「本竞技场有商店 NPC」而世界里没有实体，且 respawnFromConfig() 只在插件启动时调用，要等重启才重新生成。",
          "basis": "调用链：reset()(221) → proceed()(264) → disableArena(286) → clearNodesForWorld(292) → despawnOwnShopNpc(312) → NpcManager.despawnIfInWorld(NpcManager.java:170-180) → despawnNpc()(NpcManager.java:152-158，仅 npc.remove() 并把字段置 null，不写盘) → clearDeploymentData(318) → false 分支 abort(336-339) → reinstateRestoring(452-463) → enableArena(527)。abort 的入参只有 nodesCleared/dataCleared/tryReinstate，没有实体恢复动作；节点有 nodeBackup 回滚（323-334），实体没有。全仓 getNpcManager() 共 15 处调用，无一在 MultiArenaManager.enableArena(278) 路径内；respawnFromConfig 的调用点仅 HilltopVillagePlugin.java:162。",
          "alternatives": [
            "如果 enableArena 内部会按 arenas.yml 重建商店实体（例如调用 NpcManager.spawnNpc），该分叉会自动收敛——需逐行检查 MultiArenaManager.java:278 的 enableArena 方法体是否触达 NpcManager（本回合仅 grep 定位签名，未逐行读）。",
            "如果在插件启动之外还有 respawnFromConfig() 的调用点（例如每次 enable 成功后），重启前也会补齐实体——需检查 HilltopVillagePlugin.java:162 之外的全部调用点。",
            "如果第 8 步失败时调用方传 tryReinstate=false（ArenaResetService.java:336-339 的实参顺序为 nodesCleared/dataCleared/tryReinstate，此处 tryReinstate=nodesRolledBack），则竞技场保持 DISABLED、不会出现「可玩但无商店」——需核对这四处实参的绑定顺序是否与 452-453 的形参一致。"
          ]
        },
        "status": "CONFIRMED"
      }
    ],
    "searched_scope": {
      "files_read": [
        "src/main/java/com/hilltopvillage/admin/AdminDeployManager.java",
        "src/main/java/com/hilltopvillage/admin/ArenaAdminService.java",
        "src/main/java/com/hilltopvillage/admin/ArenaResetService.java",
        "src/main/java/com/hilltopvillage/arena/ArenaManager.java",
        "src/main/java/com/hilltopvillage/util/YamlFileGate.java",
        "src/main/java/com/hilltopvillage/util/YamlFiles.java",
        "src/main/java/com/hilltopvillage/mechanics/NodeSystem.java",
        "src/main/java/com/hilltopvillage/shop/NpcManager.java",
        "src/main/java/com/hilltopvillage/command/SetupWizard.java",
        "build.sh",
        ".work/fix-critical/gen-messages-legacy.mjs"
      ],
      "files_in_slice": 3,
      "shared_dependencies_read": [
        "src/main/java/com/hilltopvillage/arena/ArenaManager.java",
        "src/main/java/com/hilltopvillage/util/YamlFileGate.java"
      ],
      "files_scanned_without_findings": [
        "src/main/java/com/hilltopvillage/admin/ArenaAdminService.java",
        "src/main/java/com/hilltopvillage/arena/ArenaManager.java",
        "src/main/java/com/hilltopvillage/util/YamlFileGate.java",
        "src/main/java/com/hilltopvillage/util/YamlFiles.java",
        "src/main/java/com/hilltopvillage/mechanics/NodeSystem.java",
        "src/main/java/com/hilltopvillage/shop/NpcManager.java",
        "src/main/java/com/hilltopvillage/command/SetupWizard.java",
        "build.sh",
        ".work/fix-critical/gen-messages-legacy.mjs"
      ],
      "unreadable_files": [],
      "dimension_checklist": [
        { "pattern": "1 返回值暴露内部状态", "result": "未命中", "note": "getSpawnPoints 返回 unmodifiableList(622)；getVillagers 返回克隆(743-747)；ArenaAdminService.immutableCopy 再包一层(614-616)" },
        { "pattern": "2 同族函数守卫一致性", "result": "命中", "note": "saveShopNpcLocation 先 writable(582) 后 load(590)，与 saveSpawnPoints 的 load→writable(471-490) 相反；但 591 行 load 后复判 isReadOnly，无落盘后果，已排除" },
        { "pattern": "3 数值边界", "result": "未命中", "note": "下标 index<0 与 >=size 成对(694/730/766)；validGameParams 要求 min>0、max>=min、waves>0、interval>0(ArenaManager.java:823-829)" },
        { "pattern": "4a 原型链/裸下标", "result": "不适用", "note": "Java 无原型链；YAML 访问统一 isSet/isConfigurationSection，无裸下标查表" },
        { "pattern": "4b 假值 vs 缺值", "result": "未命中", "note": "readLocation 用 isSet 区分缺失与 0.0(423-426)；saveShopNpcLocation 用 isSet 再删键(600-605)" },
        { "pattern": "4c NaN/Infinity/小数", "result": "未命中", "note": "坐标统一 Double.isFinite 校验(428-431；ArenaAdminService.java:791)，yaw/pitch 在 ArenaManager 侧 Float.isFinite(892-895)" },
        { "pattern": "4d 嵌套结构校验", "result": "未命中", "note": "位置节点逐键校验；列表条目逐条 readCoordinates，坏条目跳过并保留原条目(656-673、705-715)" },
        { "pattern": "5 能力是否真实现", "result": "未命中", "note": "「写前重读」在 saveSpawnPoints(476)/saveShopNpcLocation(590)/clearDeploymentData(719)/updateGameParams(786) 均已实现；migrateLegacyShopNpc 复用同栈刚读副本，不陈旧" },
        { "pattern": "6 转义/编码顺序", "result": "不适用", "note": "本切片无字符串转义/编码层；写盘统一 UTF-8(YamlFiles.java:119)" },
        { "pattern": "7 边界符号（负数/下标）", "result": "未命中", "note": "负数下标在各入口先拒：694/730/766、ArenaAdminService 246/268/290/312、NodeSystem 592" },
        { "pattern": "8 引用绑定是否存在", "result": "未命中", "note": "未发现调用未声明符号；AdminDeployManager 引用的 ArenaManager.SHOP_NPC_MIGRATED_KEY 确实存在(ArenaManager.java:96)" }
      ]
    },
    "self_checks": {
      "identifier_reconcile": {
        "status": "DONE",
        "note": "对账 arenas.yml 键集合：DEPLOYMENT_KEYS(ArenaManager.java:80-82) vs AdminDeployManager 写键 vs ArenaAdminService 四个常量。差集仅 waiting-location 不在 DEPLOYMENT_KEYS，两侧注释均写明刻意（重置不清等待区）；shop-npc-migrated 由 clearDeploymentData 重写(748)。无拼写级失效。"
      },
      "self_check_audit": {
        "status": "DONE",
        "note": "仓库无 src/test、无 check-*/verify-* 脚本；抽验 build.sh（构建包装，有 exit 1 失败路径，会写 target/ 禁跑）与 gen-messages-legacy.mjs（一次性生成器，缺解析器 exit 1）。二者都不针对本切片不变量，无绿灯可采信；改用内联守卫推演：clearNodesForWorld 强制 0 → abort(nodes) 触发(295-299)；clearDeploymentData 强制 false → abort(deployment) 触发(336-339)。"
      },
      "runtime_validation": {
        "status": "SKIPPED",
        "note": "需 Paper/Spigot 服务端与已加载的竞技场世界；build.sh/Maven 会写 target/，违反被审仓库零写入约束，且本回合无 runnable 授权，故只做静态控制流与数量推演。"
      }
    },
    "off_dimension_notes": [
      "L2（error-handling，不构成本维度缺陷）：ArenaResetService.reset 的 catch(244-250) 只 releaseInFlight + deliver，不调用 abort()/reinstateRestoring()。proceed 在 286 行已 disableArena，第 6-9 步抛未预期异常会让竞技场停在 DISABLED，而 arenas.yml 的 core 与 enabled 仍在（重启会重新启用）。磁盘状态本身自洽，属恢复路径缺失，归 error-handling，未写入 findings。",
      "L6 的 security/robustness 侧面（不构成本维度缺陷）：buildView 每个竞技场都调 loadArenas()→gate.load()，文件被判可疑时会在「打开管理 GUI」这一读动作里把 arenas.yml 改名为 *.corrupt 并锁死本进程写盘。隔离保留原字节且闸门拒绝重建，数据不丢；但「读操作触发写侧降级」在 error-handling/contract 视角可能值得单独审。",
      "可观测性观察（非 data-consistency）：ArenaAdminService.buildView 的 dataUnavailable 只看 gate.isReadOnly()(545)，未复用 YamlFiles.isQuarantined(file, gate) 的双信号；若 .corrupt 存在而闸门已被 reset() 解锁，GUI 会把「文件被隔离」显示成「未部署」。",
      "跨切片待确认（不构成本切片结论）：F-slice-01-data-consistency-02 的 alternatives 需要逐行读 MultiArenaManager.enableArena(278)；本回合只 grep 了签名与全仓 getNpcManager 调用点，未逐行读该方法体。"
    ]
  },
  "error": null
}
```
