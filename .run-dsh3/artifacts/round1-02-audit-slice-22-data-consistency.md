# round1 · slice-22 · data-consistency 深挖审计

- trace_id: `trace-r1-20260215-hilltop-dsh3`
- round_id: `round1`
- slice_id: `slice-22`
- dimension: `data-consistency`（只报这一个维度）
- agent_id: `audit-slice-22-data-consistency`
- 被审仓库（只读，零写入）：`D:\Server\MCServers\Server plugin\Hilltop Village\Hilltop Village Plugin`
- 本回合读取：切片 4 文件（NodeSystem 全文 1000 行、PlayerLifecycleListener 全文、VillagerPreviewManager 全文、TabListManager 100–299 + 全文 grep）、shared_dependency `VillagerSystem.java:130-244`、控制流上下文 `GameManager:255-314/715-774`、`ArenaInstance:410-479`、`MultiArenaManager:714-753`、`ArenaResetService:285-329`、`SetupWizard:1405-1434`、`NodeSystemTest:110-229`、`HilltopVillagePlugin`（grep 注册点）。全部引用来自本回合 read，未复用 sweep 引文。

## 0. 结论摘要

| 项 | 数量 |
|---|---|
| CONFIRMED | 2（1 HIGH / 1 MEDIUM） |
| NO_EVIDENCE_FOUND | 0 |
| 线索 REJECTED | 2（L5 / L6） |
| 线索 OFF_DIMENSION | 3（L2 / L3 / L4） |

两条确认发现共享同一根因域：**`nodes.yml` 的「内存为准、整份重写」持久化模型**。

- **F-slice-22-data-consistency-01（HIGH）**：载入期把「方块现在不是重生锚」当成「配置里没有这个节点」，节点被移出内存；此后任意一次保存都会把 `nodes.yml` 中该条目整段覆写掉 —— 一次读失败静默变成持久条目的永久删除。
- **F-slice-22-data-consistency-02（MEDIUM）**：`addNode` 丢弃 `saveNodesToConfig()` 的失败返回值并无条件 `return 0`（成功），部署向导据此提示「节点已添加」；磁盘没写成功，下一局/重启后节点消失。同族 `removeNode` 会把同样的失败如实上报，口径不一致。

## 1. 线索逐条处置（L1–L6，全部闭合）

| lead | sweep 标的维度 | 本维度处置 | 依据（本回合读取） |
|---|---|---|---|
| **L1** 载入期材质校验 → 保存时静默删条目 | data-consistency | **CONFIRMED → F-slice-22-data-consistency-01（HIGH）** | 回源核对：`NodeSystem.java:180-184` 材质不符 `continue`，坐标缺席 `configuredLocations`（`:187` 是唯一 add 点）；`:194-199` 把不在集合里的内存节点 `deactivate()` 并 `nodes.remove`；`:278-298` 保存先过滤本世界全部旧条目（`:286`），再只追加内存节点（`:291-298`），`:300` 整段 `config.set`。材质不符走的是 `loaded.status()==OK` 分支，`:153-155` 反而解除只读，`:266` 的 `nodesWritable` 检查拦不住。保存入口：`:381`/`:399`/`:353`（后者由 `ArenaResetService.java:305` 调用）。 |
| **L2** 并发容器里的可变 `NodeData` | concurrency | **OFF_DIMENSION** | 属 concurrency。本维度核对到的持久化事实：`nodes.yml` 只写 `world/x/y/z`（`NodeSystem.java:291-298`），`currentHealth`/`active` 从不落盘，故该竞态在本维度无持久化后果。 |
| **L3** 增益等级无上限夹取 | error-handling | **OFF_DIMENSION** | 属 error-handling（异常抛出 + 任务体无 try/catch）。与 set/save 配对、写回顺序无关。 |
| **L4** `getGameManager()` 判空口径不一致 | error-handling | **OFF_DIMENSION** | 属 error-handling（NPE 吞掉整帧刷新）。`TabListManager` 四张缓存只是「上次发出值」的镜像（`:111-118`、`:203-211`、`:238-279`），无持久化源数据，本维度不构成缓存/源数据不一致。 |
| **L5** 死亡处理对非参赛者清掉落 | data-consistency | **REJECTED** | `PlayerLifecycleListener.java:71-72` 先取 `getPlayerArena(player)`，为 null 立即 `return`；`MultiArenaManager.java:726-728` 该查询只来自 `playerArenaMap`；`ArenaInstance.java:442-446` 离场顺序是「先 `forgetPlayerArena(uuid)`，再 `gameManager.removePlayer`」，且 `ArenaInstance.java:422-427` 对不在 `players` 的玩家也先清映射。参赛者映射存在 ⇒ PlayerData 存在，`event.getDrops().clear()` 只对参赛者生效。残余不确定：掉线重连超时窗口（`ArenaInstance.java:1414` 注释所述离线玩家）未取得死亡事件路径证据，无法证成，已写入 off-dimension 备注。 |
| **L6** 失效预览实体引用被剔除但实体留存 | data-consistency | **REJECTED（有兜底，非永久残留）** | `VillagerPreviewManager.java:122-123` 确实只维护内存列表（注释已声明），但 `:174-181` 的 `onEntitiesLoad` 在实体随区块加载时按键直接 `remove()`；`HilltopVillagePlugin.java:207` 注册了该监听器、`:165` 启动时跑 `cleanupOrphans()`；`ArenaInstance.java:1300` 开局再 `clearInWorld`。只有「区块永不加载 ⇒ 实体不进 `getEntities()`」才留在 region 文件，此时实体不可见、不参与对局，不构成现行缺陷。代码注释 `:159-165` 已把该降级写成设计取舍。 |

## 2. 确认发现

### F-slice-22-data-consistency-01（HIGH）载入期一次方块读失败 → 下一次保存永久删除 nodes.yml 条目

**证据（本回合读取，逐字，5 行连续，起始行 180）**

```java
                if (actualType != Material.RESPAWN_ANCHOR) {
                    gameManager.getPlugin().getLogger().warning("Skipped invalid energy node at "
                            + worldName + " " + loc.getBlockX() + "," + loc.getBlockY() + ","
                            + loc.getBlockZ() + ": expected RESPAWN_ANCHOR, found " + actualType);
                    continue;
                }
```

**控制流（逐行核对）**

1. **入口**：`GameManager.java:283` `nodeSystem.loadNodesFromConfig();`（每局 `startGame` 必经）；另有 `ArenaInstance.java:1293`、`HilltopCommandHandler.java:1104`。
2. **判定**：`NodeSystem.java:178-184` 用 `loc.getBlock().getType()` 的**实时方块状态**作为配置有效性判据，不是 `RESPAWN_ANCHOR` 就 `continue`，该坐标不进 `configuredLocations`（`:187` 唯一 `add` 点）。
3. **内存删除**：`:194-199` 遍历 `nodes` 快照，凡不在 `configuredLocations` 的一律 `staleNode.deactivate()`（不可逆）、`activeNodes.remove`、`nodes.remove`。`:122` 的注释把「不再配置」与「方块材质无效」合并成同一语义——但后者是现场世界状态，不是配置文件状态。
4. **持久化删除**：`:278-289` 重读文件后把本竞技场世界的旧条目**全部**跳过（`:286` `continue`），`:291-298` 只把内存 `nodes.keySet()` 追加回去，`:300` `config.set("nodes", nodeList)` 整段替换后写盘。被跳过且已移出内存的坐标不会回到 `nodeList`。
5. **触发时机**：保存只由 `addNode`（`:381`）、`removeNode`（`:399`）、`clearAllNodes`（`:353`）发起；其中 `ArenaResetService.java:305` 的 `clearAllNodes()` 是常规重置动作，`SetupWizard.java:1412` 的加节点也会触发。即：读失败本身不写盘，但**下一次任意保存**把它变成不可逆删除，日志只有 load 期一行 `Skipped invalid energy node`。

**预期语义**：载入期「现场读不到 / 读到别的方块」应只影响本次内存视图（并在日志里区分「配置非法」与「现场暂时不符」），不应改写磁盘配置。实际等价于「用一次读失败静默删除 `nodes.yml` 持久条目」。

**旁证（写入侧语义确为整段替换）**：`NodeSystemTest.java:177-194` 预置一条大小写不同的旧条目，添加新节点后断言 `entries.size()==1`（`:190`）——写回只保留内存内容是该类**既有且被测试钉住**的语义。因此问题不在写回，而在载入把「现场不符」混入「内存里没有」，让写回「合法地」删掉了它。

**为什么 HIGH 不是 CRITICAL**：删除发生在「材质不符」+「后续有一次保存」两个条件同时成立时，且保存入口均为管理员/重置路径；按 `wave2-audit.md §3.3`，未给出从玩家操作直达删除的完整调用链，不标 CRITICAL。

**可推翻条件**

1. 若所有 `loadNodesFromConfig` 调用点都保证方块世界已完全恢复（`GameManager.java:283` 之前存在重置完成屏障），该读失败不会发生——需检查 `ArenaResetService` 的方块重建与 `startGame` 的先后顺序。
2. 若保存前把文件中本世界条目与内存做**并集**而非「过滤本世界 + 只追加内存」，被跳过条目不会丢——需核对 `NodeSystem.java:286` 的过滤与 `:291-298` 的追加范围。
3. 若材质校验失败也会把文件判成 `unusable` 并锁只读（那样 `:266` 会拒写），条目同样不会丢——需核对 `:145-155`：材质校验发生在 `loaded.usable()` 之后，`status==OK` 时反而解除只读。

### F-slice-22-data-consistency-02（MEDIUM）addNode 丢弃写盘结果并返回「成功」

**证据（本回合读取，逐字，2 行连续，起始行 381）**

```java
        saveNodesToConfig();
        return 0; // 成功
```

**控制流（逐行核对）**

1. `addNode`（`NodeSystem.java:362-383`）：`:378` `nodes.put(...)` → `:379` `activeNodes.add(...)` → `:381` 调 `saveNodesToConfig()` 并**丢弃 boolean 返回值** → `:382` `return 0`；javadoc `:361` 把 `0` 定义为「成功」。
2. `saveNodesToConfig` 有三条「磁盘未更新且只打日志」的 `return false`：`:266`（只读降级）、`:269-274`（文件不可用）、`:306-309`（`IOException`）。
3. 调用方：`SetupWizard.java:1412` 取 `int result`，`:1413-1416` 在 `result==0` 时发 `setup.node-added`，计数取自内存 `getTotalCount()`（`:1414`），无二次读盘校验。第二个入口 `SetupWizard.java:2053` 同族。
4. 对照：`removeNode`（`:399-407`）把同一返回值原样上传，并在失败时 warning `will reappear after a restart`；测试 `NodeSystemTest.java:132-138` 正为该语义而写（断言返回 false 且日志含该句）。

**后果**：内存有节点、`nodes.yml` 没有。下一次 `loadNodesFromConfig()` 会因「不在 configuredLocations」把它从内存清掉（`:194-199`），表现为「提示添加成功，下一局/重启后节点消失」，失败只留一行 WARNING。

**可推翻条件**

1. 若 `SetupWizard.java:1413-1420`（以及 `:2053` 之后）在 `result==0` 后还会独立重读 `nodes.yml` 复核条目数，管理员不会被误导——需检查该段后续动作。
2. 若部署流程在进入第 4 步前检查 `nodes.yml` 只读态并挡住 `addnode`（`NodeSystem` 未见 `isReadOnly` 之类 getter），可触发性下降，可降为 LOW——需检查 `SetupWizard` 第 4 步入口的前置检查。

## 3. 已排除（避免下游重复劳动）

- **`YamlFiles` 原子写**：`YamlFiles.write` 不在 `files[]`，本回合**未读**，不据它下任何结论（见 off-dimension 缺口）。`saveNodesToConfig` 内 `set`（`:300`）与 `write`（`:303`）成对出现，失败直接 `return false`（`:306-309`），无「先 set 后 save 失败」的内存脏写路径（内存本就先改）。
- **quarantine 丢原文件**：`NodeSystem.java:129-151` 在文件不存在且只读锁存在时早退并保留内存；`:145-151` 不可用时不碰内存、锁只读；`:266-274` 保存前再次拒写。未发现把原文件覆盖掉的路径。
- **竞技场重置的节点删除**：`ArenaResetService.java:288-299` 先 `readNodesForWorld` 备份、`clearNodesForWorld` 清文件，并用 `expectedNodes>0 && removedNodes==0` 消歧写盘失败；`:324-334` 后续步骤失败时 `restoreNodesForWorld` 回滚。`clearAllNodes()` 丢弃返回值（`NodeSystem.java:353`）在此调用点被第 5 步掩盖，不单列发现。
- **节点血量不落盘**：`nodes.yml` 只写 `world/x/y/z`（`:291-298`），`NodeData.currentHealth` 跨重启重置是显式设计，不按数据丢失处理。
- **`TabListManager` 缓存与源数据**：四张缓存（`:111-118`）均为「上次发出值」的镜像；退出即 `cleanup` 删除（`:203-211`）、`restoreAll` 分项复位并 `clearCaches`（`:238-279`）、入局/状态变化 `forcePush` 先删缓存（`:289-295`）。未发现长期不一致路径。

## 4. 本维度检查清单（逐项结论）

| # | 模式 | 结果 | 说明 |
|---|---|---|---|
| 1 | 返回值暴露内部状态 | 未命中 | `getAllNodeLocations` 返回 `location.clone()`（`:416-421`）；`NodeData.getLocation()` 同样 clone（`:959-961`）；`previews` 私有 `CopyOnWriteArrayList` 无 getter。 |
| 2 | 同族函数守卫一致性 | **命中** | `removeNode` 传播写盘失败（`:399-407`），`addNode` 丢弃同一返回值（`:381-382`）→ F-02。 |
| 3 | 数值边界 | 未命中 | 持久化只有整块坐标，写出用 `getBlockX/Y/Z`（`:294-296`）；血量不落盘。 |
| 4a | 原型链/裸下标 | 不适用 | YAML 键均为字面量 `world/x/y/z`，无以外部字符串为键的查表。 |
| 4b | 假值 vs 缺值 | 未命中 | `entryWorldName` 用 `null` 判定（`:646-650`）；坐标用 `instanceof Number`（`:637`），`0` 不当缺失。 |
| 4c | NaN/Infinity/小数 | 未命中（本维度） | 静态读侧 `coordinateKey` 用 `longValue` 归一（`:580-584`）；运行期血量夹取属 logic/error-handling。 |
| 4d | 嵌套结构校验 | 命中（已兜住） | `getMapList("nodes")` 每条只做 `(String)`/`(Number)` 强转，但整段在 `try/catch`（`:160-190`），单条坏记录只跳过该条并 warning。 |
| 5 | 能力是否真实现 | **命中** | 「只读降级」真实实现（`:133-155`、`:266-274`），但「材质无效」被当作「配置缺失」，持久化侧无保护 → F-01；`addNode` 的「成功」也未被验证 → F-02。 |
| 6 | 转义/编码顺序 | 不适用 | 无多层转义。 |
| 7 | 边界符号（负数/下标） | 未命中 | `removeNodeEntryForWorld` 有 `index < 0` 守卫（`:592`）。 |
| 8 | 引用绑定是否存在 | 未命中 | `YamlFiles.load/write`、`nodesWritable`、`copyNodeEntry`、`normalizeLocation` 均在作用域内。 |
| D1 | YAML `set` 与 `save` 是否成对 | 命中 | `:300` 与 `:303` 成对且失败返回 false；但 `addNode` 丢结果 → F-02。 |
| D2 | 部分写入 / 临时文件 + 原子 move | 不适用（切片外） | `YamlFiles.write` 未读，不评。 |
| D3 | 内存 map 与磁盘写回顺序 | **命中** | 先改内存再整份重写（`:377-382`、`:291-300`）；写失败被吞 → F-02；载入差集误删 → F-01。 |
| D4 | quarantine/backup 是否丢原文件 | 未命中 | `:129-155`、`:266-274` 保留内存 + 只读锁，未见覆盖原文件路径。 |
| D5 | 集合副本 | 未命中 | 同第 1 项。 |
| D6 | 缓存与源数据不一致 | 未命中 | `TabListManager` 四张缓存有完整收口（`:203-211`、`:238-279`、`:289-295`）。 |

## 5. 自检（三项必做）

**标识符对账（DONE）**

- `nodes.yml` 键：写 `world/x/y/z`（`NodeSystem.java:291-298`）、实例读 `:162-165`、静态读 `readNodeLocation`（`:634-642`）、恢复 `restoreNodesForWorld`（`:555-558`）——四处同名，**差集为空**。
- 只读闸门键：`NODES_READ_ONLY` 以 `nodesFile.getAbsolutePath()` 为键，`:37`（判写）、`:133`/`:147`（load）、`:271`（save）口径一致。
- PDC 键：`VillagerPreviewManager.PREVIEW_KEY = "villager-preview"`（`:56`）与真村民键按类注释隔离；`VillagerSystem.cleanupOrphans` 只认后者（`VillagerSystem.java:177`）——本回合只核对到「预览清理只认预览键」这一侧，未跨文件核对常量字面量。
- 差集结论：键名无拼写失配；失配在**返回码语义**（`addNode` 0=成功，底层写盘可为 false），即 F-02。

**自带自检抽验（DONE，抽验 `NodeSystemTest`，295 行，读 110-229）**

- (a) 失败路径：有 `assertFalse/assertTrue/assertEquals`，非恒 exit 0 型。
- (b) 断言空转：`NodeSystemTest.java:177-194` 的 `entries.size()==1` 把「本世界旧条目被整段替换」钉成期望——**该断言保护的正是 F-01 的删除机制**；`:223-236` 只覆盖 `addNode` 返回 1/2，**未覆盖写盘失败下的 `return 0`**，F-02 无测试。
- (c) 断言目标存在：`NODES_READ_ONLY`、`nodes.yml`、`Material.RESPAWN_ANCHOR`、`will reappear after a restart` 均在源码中真实存在（`:33`/`:180`/`:404-406`）。
- (d) 注入故障：**未执行**——`mvn test` 会写 `target/`，违反零写入；故该套件历史 PASS 不作为 F-01/F-02 不存在的证据。

**运行时验证（SKIPPED）**：需构建（写 `target/`）并启动 Paper 服务端，违反零写入且无已构建产物；本产物只做静态控制流取证，已在 `self_checks.runtime_validation.note` 写明。

## 6. 维度外观察（不进 findings）

见 JSON `off_dimension_notes`：L2（concurrency）、L3（error-handling）、L4（error-handling）、L5 的闸门不对称（logic），以及切片外 `YamlFiles.write` 原子性缺口。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "audit-slice-22-data-consistency",
  "role": "audit",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/.run-dsh3/artifacts/round1-02-audit-slice-22-data-consistency.md",
  "payload": {
    "slice_id": "slice-22",
    "findings": [
      {
        "finding_id": "F-slice-22-data-consistency-01",
        "severity": "HIGH",
        "dimension": "data-consistency",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/mechanics/NodeSystem.java",
          "line": 180,
          "quote": "                if (actualType != Material.RESPAWN_ANCHOR) {\n                    gameManager.getPlugin().getLogger().warning(\"Skipped invalid energy node at \"\n                            + worldName + \" \" + loc.getBlockX() + \",\" + loc.getBlockY() + \",\"\n                            + loc.getBlockZ() + \": expected RESPAWN_ANCHOR, found \" + actualType);\n                    continue;\n                }"
        },
        "inference": {
          "claim": "载入时一次「方块当前不是重生锚」的读失败会让该坐标进不了 configuredLocations，随后被移出内存 nodes；下一次任意保存（调用链：GameManager.startGame:283 → loadNodesFromConfig:180-199 → addNode:381 / removeNode:399 / clearAllNodes:353 → saveNodesToConfig:286-298）会把 nodes.yml 中该条目永久删掉，日志只有一行 Skipped invalid energy node。",
          "basis": "180-184 用实时方块材质作配置有效性判据并 continue；187 是 configuredLocations 唯一 add 点，因此该坐标缺席；194-199 对不在集合内的内存节点 deactivate 并从 nodes 移除（deactivate 不可逆）；278-298 保存时先按世界名过滤掉本竞技场世界全部旧条目（286），再只遍历 nodes.keySet() 追加（291-298），被移出内存的坐标不会回到 nodeList，300 行整段 config.set 后覆写。材质不符走 loaded.status()==OK 分支，153-155 反而解除只读，266 的 nodesWritable 拦不住。保存触发点仅 381/399/353，其中 353 由 ArenaResetService.java:305 常规调用。写入侧整段替换语义被 NodeSystemTest.java:177-194 的 entries.size()==1 断言钉住，说明问题在载入把现场状态混入内存差集。",
          "alternatives": [
            "若所有 loadNodesFromConfig 调用点都保证方块世界已完全恢复（GameManager.java:283 之前存在重置完成屏障），该读失败不会发生——需检查 ArenaResetService 的方块重建与 startGame 的先后顺序。",
            "若保存前把文件中本世界条目与内存做并集，而不是仅保留其它世界再追加内存节点，被跳过条目不会丢——需核对 NodeSystem.java:286 的过滤条件与 291-298 的追加范围。",
            "若材质校验失败也会把文件判成 unusable 并锁只读（那样 NodeSystem.java:266 会拒写），条目同样不会丢——需核对 NodeSystem.java:145-155：材质校验在 loaded.usable() 之后，且 status==OK 时反而解除只读。"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "F-slice-22-data-consistency-02",
        "severity": "MEDIUM",
        "dimension": "data-consistency",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/mechanics/NodeSystem.java",
          "line": 381,
          "quote": "        saveNodesToConfig();\n        return 0; // 成功"
        },
        "inference": {
          "claim": "写盘失败时 addNode 仍返回 0（成功）：节点只存在于内存，部署向导据此向管理员报「节点已添加」并显示内存计数，nodes.yml 没有该条目，下一局或重启后节点消失；同族的 removeNode 会把同样的失败如实上报。",
          "basis": "addNode 在 378-379 行先改内存，381 行调用 saveNodesToConfig() 却丢弃 boolean 返回值，382 行无条件 return 0（javadoc 361 行把 0 定义为成功）。saveNodesToConfig 有三条只打日志的失败分支：266 只读降级、269-274 文件不可用、306-309 IOException。调用方 SetupWizard.java:1412 取 result，1413-1416 仅在 result==0 时发 setup.node-added 并用 getTotalCount() 报数，无二次读盘。对照 removeNode 399-407 会传播 false 并打 will reappear after a restart，NodeSystemTest.java:132-138 正是为该语义写的断言，说明失败上报是本类既有口径。",
          "alternatives": [
            "若 addNode 的调用方在 result==0 后还会独立重读 nodes.yml 校验条目数，管理员不会被误导——需检查 SetupWizard.java:1413-1420 与 2053 处的后续动作。",
            "若部署流程在进入第 4 步前检查 nodes.yml 只读态并挡住 addnode（NodeSystem 本切片未见 isReadOnly 之类 getter），实际可触发性下降，可降为 LOW——需检查 SetupWizard 第 4 步入口的前置检查。"
          ]
        },
        "status": "CONFIRMED"
      }
    ],
    "searched_scope": {
      "files_read": [
        "src/main/java/com/hilltopvillage/mechanics/NodeSystem.java",
        "src/main/java/com/hilltopvillage/mechanics/PlayerLifecycleListener.java",
        "src/main/java/com/hilltopvillage/mechanics/TabListManager.java",
        "src/main/java/com/hilltopvillage/mechanics/VillagerPreviewManager.java",
        "src/main/java/com/hilltopvillage/mechanics/VillagerSystem.java"
      ],
      "files_in_slice": 4,
      "shared_dependencies_read": [
        "src/main/java/com/hilltopvillage/mechanics/VillagerSystem.java"
      ],
      "files_scanned_without_findings": [
        "src/main/java/com/hilltopvillage/mechanics/PlayerLifecycleListener.java",
        "src/main/java/com/hilltopvillage/mechanics/TabListManager.java",
        "src/main/java/com/hilltopvillage/mechanics/VillagerPreviewManager.java",
        "src/main/java/com/hilltopvillage/mechanics/VillagerSystem.java",
        "src/main/java/com/hilltopvillage/core/GameManager.java",
        "src/main/java/com/hilltopvillage/arena/ArenaInstance.java",
        "src/main/java/com/hilltopvillage/arena/MultiArenaManager.java",
        "src/main/java/com/hilltopvillage/admin/ArenaResetService.java",
        "src/main/java/com/hilltopvillage/command/SetupWizard.java",
        "src/test/java/com/hilltopvillage/mechanics/NodeSystemTest.java"
      ],
      "unreadable_files": [],
      "dimension_checklist": [
        { "pattern": "1 返回值暴露内部状态", "result": "未命中", "note": "getAllNodeLocations 返回 location.clone()（NodeSystem.java:416-421），NodeData.getLocation() 同样 clone（:959-961）；previews 私有且无 getter。" },
        { "pattern": "2 同族函数守卫一致性", "result": "命中", "note": "removeNode 传播写盘失败（:399-407），addNode 丢弃同一返回值（:381-382）→ F-slice-22-data-consistency-02。" },
        { "pattern": "3 数值边界", "result": "未命中", "note": "持久化只有整块坐标，写出用 getBlockX/Y/Z（:294-296）；血量不落盘。" },
        { "pattern": "4a 原型链/裸下标", "result": "不适用", "note": "YAML 键均为字面量 world/x/y/z，无以外部字符串为键的查表。" },
        { "pattern": "4b 假值 vs 缺值", "result": "未命中", "note": "entryWorldName 用 null 判定（:646-650），坐标用 instanceof Number（:637），0 不当缺失。" },
        { "pattern": "4c NaN/Infinity/小数", "result": "未命中", "note": "静态读侧 coordinateKey 用 longValue 归一（:580-584）；运行期夹取属其它维度。" },
        { "pattern": "4d 嵌套结构校验", "result": "命中", "note": "getMapList 每条只做 String/Number 强转，但整段 try/catch（:160-190），坏记录只跳过该条。" },
        { "pattern": "5 能力是否真实现", "result": "命中", "note": "只读降级真实实现（:133-155、:266-274），但材质无效被当成配置缺失，持久化侧无保护 → F-01；addNode 的成功未被验证 → F-02。" },
        { "pattern": "6 转义/编码顺序", "result": "不适用", "note": "无多层转义。" },
        { "pattern": "7 边界符号（负数/下标）", "result": "未命中", "note": "removeNodeEntryForWorld 有 index<0 守卫（:592）。" },
        { "pattern": "8 引用绑定是否存在", "result": "未命中", "note": "YamlFiles.load/write、nodesWritable、copyNodeEntry、normalizeLocation 均在作用域内。" },
        { "pattern": "D1 YAML set 与 save 是否成对", "result": "命中", "note": "set（:300）与 write（:303）成对且失败返回 false；但 addNode 丢结果 → F-02。" },
        { "pattern": "D2 部分写入 / 原子 move", "result": "不适用", "note": "YamlFiles.write 在切片外且未读，不评。" },
        { "pattern": "D3 内存 map 与磁盘写回顺序", "result": "命中", "note": "先改内存再整份重写（:377-382、:291-300），写失败被吞 → F-02；载入差集误删 → F-01。" },
        { "pattern": "D4 quarantine/backup 是否丢原文件", "result": "未命中", "note": "文件不可用时保留内存并锁只读（:129-155、:266-274），未见覆盖原文件路径。" },
        { "pattern": "D5 集合副本", "result": "未命中", "note": "同第 1 项。" },
        { "pattern": "D6 缓存与源数据不一致", "result": "未命中", "note": "TabListManager 四张缓存有退出删除、restoreAll 分项复位、forcePush 预删（:203-211、:238-279、:289-295）。" }
      ]
    },
    "self_checks": {
      "identifier_reconcile": {
        "status": "DONE",
        "note": "nodes.yml 键 world/x/y/z 在写（NodeSystem.java:291-298）、实例读（:162-165）、静态读（:634-642）、恢复（:555-558）四处一致，差集为空；NODES_READ_ONLY 以绝对路径为键，:37/:133/:147/:271 口径一致；PDC 键预览侧独立（VillagerPreviewManager.java:56），VillagerSystem:177 只认真村民键。差集为返回码语义不一致，已列 F-02。"
      },
      "self_check_audit": {
        "status": "DONE",
        "note": "抽验 NodeSystemTest 110-229：(a) 有 assertFalse/assertTrue/assertEquals 失败路径；(b) :177-194 的 entries.size()==1 把「本世界旧条目被整段替换」钉成期望，正是 F-01 的删除机制，:223-236 未覆盖写盘失败下的 return 0，F-02 无测试；(c) 断言目标 NODES_READ_ONLY/nodes.yml/RESPAWN_ANCHOR 均真实存在；(d) 注入故障未跑（mvn 写 target/ 违反零写入），历史 PASS 不采信。"
      },
      "runtime_validation": {
        "status": "SKIPPED",
        "note": "构建与测试会写被审仓库 target/ 并需启动 Paper 服务端，违反零写入且无已构建产物，只能做静态控制流取证。"
      }
    },
    "off_dimension_notes": [
      "concurrency（L2）：nodes/activeNodes 用并发容器，但 NodeData.currentHealth/active 是普通字段，damageNode 先跨两个集合 isRegisteredActive 再改状态（NodeSystem.java:694-716、946-998）；本维度不成立（血量不落盘），请派 concurrency 维度。",
      "error-handling（L3）：applyBuffsToPlayer 的 finalAmplifier = baseAmplifier + effectiveAmplifier 无 0-255 夹取（NodeSystem.java:826-834），越界时 PotionEffect 抛 IllegalArgumentException，而 buffTask.run() 无 try/catch。",
      "error-handling（L4）：resolveArg 的 activeNodes/totalNodes 分支不判 getGameManager() 为 null（TabListManager.java:739），而同文件 viewOf 判了（:694）。",
      "logic（L5）：onDeath 的 playerData 判空只包住计数，掉落清空/经验归零/全服播报无条件（PlayerLifecycleListener.java:80-101）；本维度已按 getPlayerArena 闸门判 REJECTED，闸门本身的不对称属 logic。",
      "data-consistency 切片外缺口：YamlFiles.write 是否临时文件 + 原子 move、失败是否留半截文件，本回合未读该文件，不据此下结论；需读 src/main/java/com/hilltopvillage/util/YamlFiles.java。"
    ]
  },
  "error": null
}
```
