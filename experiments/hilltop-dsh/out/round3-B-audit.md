# Hilltop Village 第三轮静态审计报告（B 组：命令与权限）

- 审计角色：`round3-audit-B`（第三轮，B 组，仅负责「命令与权限」模块）
- 审计对象：`<TARGET_REPO>\src\main\java\com\hilltopvillage`
- 审计方式：纯静态源码审计（逐文件 `read` 至 EOF，未启动服务器）
- 结论：发现 7 条有代码证据的缺陷（HIGH 1 / MEDIUM 4 / LOW 2）；**未发现**「某条管理子命令完全没有权限门」的提权入口

## 一、审计范围与阅读清单

本轮 B 组负责 13 个文件，全部以 `read` 工具逐段读取至文件末尾（含此前被截断的中段二次补读），未使用 glob/grep 替代阅读。

| # | 相对路径 | 声明行数 | 实际行数 | 读取情况 |
|---|----------|---------:|---------:|----------|
| 1 | `command/ArenaCommand.java` | 154 | 184 | 全文（1–184） |
| 2 | `command/DeployMenuSender.java` | 146 | 168 | 全文（1–168） |
| 3 | `command/HilltopCommandHandler.java` | 1583 | 1731 | 全文（分段 1–1731） |
| 4 | `command/HilltopTabCompleter.java` | 177 | 209 | 全文（1–209） |
| 5 | `command/SetupWizard.java` | 1943 | 2274 | 全文（分段 1–2274） |
| 6 | `admin/AdminDeployManager.java` | 651 | 824 | 全文（分段 1–824） |
| 7 | `admin/ArenaAdminService.java` | 632 | 794 | 全文（分段 1–794） |
| 8 | `admin/ArenaResetService.java` | 435 | 588 | 全文（分段 1–588） |
| 9 | `admin/gui/AbstractAdminMenu.java` | 60 | 78 | 全文（1–78） |
| 10 | `admin/gui/ArenaManageGUI.java` | 855 | 1035 | 全文（分段 1–1035） |
| 11 | `admin/LocationParticlePreview.java` | 102 | 137 | 全文（1–137） |
| 12 | `admin/PointKind.java` | 53 | 71 | 全文（1–71） |
| 13 | `admin/PointParticleRenderer.java` | 48 | 66 | 全文（1–66） |

## 二、权限门核查结论（本轮首要检查项）

对 `HilltopCommandHandler` 顶层 `switch (sub)` 的每一个分支逐一核对「执行侧权限门」，并与 `HilltopTabCompleter` 的补全门对照：

| 子命令 | 执行侧权限门 | Tab 补全门 | 结论 |
|--------|--------------|------------|------|
| `start` / `stop` | `hilltopvillage.admin`（HCH:190、243） | 同节点 | 一致 |
| `setup` / `deploy` | `hilltopvillage.admin` + 仅玩家（HCH:381、452） | 同节点 | 一致 |
| `config` | `hilltopvillage.config.admin`（HCH:389） | `hilltopvillage.admin` | **不一致，见 B-06** |
| `reloadconfig` | `hilltopvillage.admin`（HCH:397） | 同节点 | 一致 |
| `shop`（reload/give） | `hilltopvillage.admin`（HCH:565） | 同节点 | 一致 |
| `tps` / `build` / `arenas` / `manage` | `hilltopvillage.admin`（HCH:471、487、525、533） | 同节点 | 一致 |
| `enable` / `disable` / `wave` | 处理函数内校验 `hilltopvillage.admin`（HCH:557、561、1479） | 同节点 | 一致 |
| `hammer` / `fireball` | 处理函数内校验 `hilltopvillage.admin`（HCH:348、361） | 同节点 | 一致 |
| `lobby setspawn` | 处理函数内校验 `hilltopvillage.admin`（HCH:1260 附近） | 仅管理员补全 | 一致 |
| `config nodes repairitem` | 额外要求 `hilltopvillage.config.nodes`（HCH:602） | 未补全 | 仅可发现性欠缺 |
| `list` / `status` / `join` / `leave` / `stats` / `top` / `gui` / `lang` | 无（面向玩家的公开命令） | 公开 | 符合设计 |
| 控制台 | `CONSOLE_BLOCKED_COMMANDS` 先行拦截（HCH:183） | — | 一致 |

结论：**13 个文件中不存在「管理/破坏性操作缺少权限门」的路径**；`sender` 与 `player` 的区分（控制台 `player == null`）在 `lang.getFor(null, ...)` 链路上已确认空安全，不构成缺陷。权限维度唯一确认的问题是补全门与执行门使用了不同权限节点（B-06）。

## 三、发现清单

| ID | 严重度 | 维度 | 位置 | 标题 |
|----|--------|------|------|------|
| B-01 | HIGH | data-consistency | `admin/ArenaResetService.java:280` | 重置中途失败时节点已被永久删除，竞技场却被重新启用 |
| B-02 | MEDIUM | data-consistency | `admin/AdminDeployManager.java:530` | 写盘失败后仍把内存部署数据推给运行实例 |
| B-03 | MEDIUM | data-consistency | `admin/gui/ArenaManageGUI.java:496` | 列表项按渲染时下标删除，列表变化后删错条目 |
| B-04 | LOW | logic | `command/SetupWizard.java:547` | 向导 GUI 的完成按钮不校验当前步骤，可跳过必经步骤 |
| B-05 | MEDIUM | error-handling | `admin/ArenaResetService.java:233` | reset 的异常兜底只释放 in-flight，不恢复被禁用的竞技场 |
| B-06 | LOW | contract | `command/HilltopTabCompleter.java:75` | `config` 的补全门与执行门使用不同权限节点 |
| B-07 | MEDIUM | data-consistency | `command/SetupWizard.java:1361` | clear-shop 忽略写盘结果，先删实体后不校验 |

### B-01 重置在第 8 步失败时节点已被永久删除，竞技场却被重新启用

`ArenaResetService.proceed` 的执行顺序是「先破坏、后确认」：第 5 步就用 `NodeSystem.clearNodesForWorld` 删除该世界在 `nodes.yml` 的全部条目，第 7 步摘掉商店 NPC，第 8 步才调用 `clearDeploymentData` 决定重置能否继续。当 `arenas.yml` 在重置期间不可写（只读闸门降级、IO 失败、文件被隔离）时，`clearDeploymentData` 返回 false，代码以 `abort(ctx, "deployment", ..., true, false, onDone)` 中止，此时 `nodesCleared=true`、`dataCleared=false`。中止路径固定走 `reinstateRestoring → reinstate`：`core` 尚未被清除、`enabled` 仍为 true、`wasReady` 为 true，因此 `enableArena` 会成功，竞技场回到 READY。结果是一张「可以开局、但节点表为空」的竞技场；按项目自身在 `SetupWizard` 第 4 步写下的约束，0 节点时任意玩家阵亡会立即判全队失败且无法复活，而管理员只看到一句「部分成功」，无法从提示判断节点已丢失，只能重新走第 4 步逐点补建。

位置：`admin/ArenaResetService.java:280`
原文：`int removedNodes = NodeSystem.clearNodesForWorld(dataFolder, world);`

### B-02 写盘失败后仍把内存部署数据推给运行实例

`saveSpawnPoints` 只在闸门不可写时提前返回（458 行），但对 `gate.write` 的 IO 失败没有第二道早退：第 527 行拿到 false 后仍执行 530-531 行的推送，把「内存已改、磁盘未改」的列表交给正在运行的 `GameManager`。触发方式是磁盘满、文件被占用或权限突变导致 `gate.write` 返回 false 时执行 `/hilltop deploy clearspawns` 并确认，`clearSpawnPoints()` 先清空内存列表（663 行），写盘失败但推送照常发生，`lastSaveFailed` 直到第 541 行才被置位用于提示。其后果是运行中的实例立即按新（空）生成点工作，`hasSpawnPoints()` 变为 false 后 `/hilltop start` 会以「未部署」拒绝开局，而磁盘上仍是旧的点位，重启后同一份配置又「复活」——同一操作在重启前后表现相反，GUI/向导读数与磁盘内容也不再一致。

位置：`admin/AdminDeployManager.java:530`
原文：`gameManager.setSpawnPoints(savedSpawnPoints);`

### B-03 列表项按渲染时下标删除，列表变化后删错条目

`ArenaManageGUI` 在渲染每个坐标条目时把全局下标 `index` 捕获进点击回调，右键删除时直接调用 `deleteLocation(kind, arenaId, index)`，服务端只按「当前列表第 index 条」执行删除，不校验坐标或条目身份。触发场景很现实：管理员打开生成点列表后，在聊天栏执行 `/hilltop deploy delspawn 1`（或另一名管理员在此期间删除、新增了点位），已打开的 GUI 不会自动刷新；此时右键界面上的「第 2 条」，`ArenaAdminService.deleteSpawnPoint` 会把当前列表的第 3 条删掉并立即落盘。删除没有二次确认，反馈消息还按 `index + 1` 播报「第 2 条已删除」，管理员几乎不可能发现删错，且该删除已写入 `arenas.yml`，只能靠人工重新补点恢复。

位置：`admin/gui/ArenaManageGUI.java:496`
原文：`boolean deleted = deleteLocation(kind, arenaId, index);`

### B-04 向导 GUI 的完成按钮不校验当前步骤，可跳过必经步骤

聊天入口的每个子命令都有 `if (s.step != N)` 守卫，但 GUI 点击分发只按标题选择 handler，`handleSpawnsOverviewClick`、`handleVillagersGuiClick`、`handleNodesGuiClick` 内部不再校验 `s.step`，最终都调用同一个 `tryFinishSpawnsStep`。触发方式：在第 3 步打开生成点总览并保持界面不关，在同一世界的聊天栏执行 `/hilltop setup goto 6`（会话步骤变为 6，界面仍在），再点界面里的「完成」，`s.advance()` 会把步骤从 6 推到 7，直接跳过第 6 步商店。第 7 步的预览确认与第 8 步的 `validateCompletion` 虽然会兜底把缺项弹回，但管理员会在第 7 步被莫名弹回第 6 步，且 `config.yml` 中持久化的 `wizard.step` 与界面实际操作顺序不一致——这是可复现的状态机缺陷，未造成数据损坏，因此定为 LOW。

位置：`command/SetupWizard.java:547`
原文：`s.advance();`

### B-05 reset 的异常兜底只释放 in-flight，不恢复被禁用的竞技场

`proceed` 在第 4 步 `disableArena` 之后还有多处可能抛出未检查异常的调用（`NodeSystem` 读写 `nodes.yml`、`despawnOwnShopNpc`、`clearDeploymentData`，以及第 9 步的 `reloadAllDeploymentData`），而 `reset` 的 `catch (RuntimeException)` 只做 `releaseInFlight` 并回调一个 `failStep="internal"` 的结果，**没有**调用 `reinstateRestoring`。与 `abort` 的注释「中止必须恢复启用状态」相比，这是两条收尾路径的行为分叉：一旦异常发生在禁用之后，竞技场会停在 DISABLED，`Outcome.reinstateSkipped()` 仍为 null，GUI 只显示「部分成功 / internal」，不会提示「竞技场仍是禁用状态、需要重新 enable」。影响是场馆在无提示的情况下不可加入，管理员必须自行发现并执行 `/hilltop enable`；若该场原本有排队玩家，他们只会看到加入失败。

位置：`admin/ArenaResetService.java:233`
原文：`if (releaseInFlight(key)) {`

### B-06 `config` 的补全门与执行门使用不同权限节点

`HilltopTabCompleter` 把 `config` 放进 `isAdmin` 列表并按 `hilltopvillage.admin` 过滤，而执行侧 `case "config"` 只要求 `hilltopvillage.config.admin`。在只直接授予 `config.admin`、未同时持有父节点 `admin` 的权限配置下，运维能执行 `/hilltop config`，却在 `/hilltop ` 后按 Tab 看不到该子命令。这不构成提权（执行侧仍由 `config.admin` 保护），但补全与执行对「谁有权」的回答不一致，属于契约层缺陷，故定为 LOW。

位置：`command/HilltopTabCompleter.java:75`
原文：`if (isAdmin && !sender.hasPermission("hilltopvillage.admin")) continue;`

### B-07 clear-shop 忽略写盘结果，先删实体后不校验

向导第 6 步的 `clear-shop` 直接调用 `deploy(player).setShopNpcLocation(null)` 并丢弃返回值，随后无条件执行 `despawnIfInWorld` 摘掉商店实体，再向管理员播报「已清除」。当 `arenas.yml` 只读或写入失败时，该 setter 内部的 `saveSpawnPoints` 在闸门分支返回 false，内存位置被置空、磁盘上的 `shop-npc` 键却原样保留，实体仍然被删除。其后果是：内存/实体侧商店已消失（第 7 步预览会以 `shop-required` 拦截），重启后 `NpcManager.respawnFromConfig` 又会在原位置把 NPC 生成回来；同一操作在管理 GUI 路径（`ArenaAdminService.deleteShopNpc` 检查返回值并返回 `WRITE_FAILED`）行为不同，形成两条入口对同一失败场景的不一致处理。

位置：`command/SetupWizard.java:1361`
原文：`deploy(player).setShopNpcLocation(null);`

## 四、未形成发现的文件与核查说明

以下文件已完整读取并逐项核查，但未获得可复现、可举证的缺陷，故不凑数：

- `command/ArenaCommand.java`：仅保留 `list` / `arenas` 两种内部调用形态；`args.length == 0` 早退，`arenas` 分支自带 `hilltopvillage.admin` 校验；`countByState` 传入 6 个状态、`counts` 长度为 `states.length + 1`，`counts[0..6]` 均合法，未发现越界。
- `command/DeployMenuSender.java`：纯用法文案发送器，管理段落后置于 `hasPermission("hilltopvillage.admin")`，`lang.getFor(null, ...)` 经 `LanguageManager.getPlayerLocale` 的空判断确认安全。
- `admin/gui/AbstractAdminMenu.java`：`guardClick` / `guardDrag` 同时校验「点击者 == admin」与「top inventory holder == this」，并对所有涉及顶栏的点击/拖动 `setCancelled(true)`，未发现物品被拖出或 shift-click 塞入的缺口。
- `admin/LocationParticlePreview.java`：任务按 viewer UUID 登记，`show()` 先 `stop()` 再调度，任务内部在超时/离线时自行 cancel 并移除登记，未发现跨玩家串场或任务泄漏。
- `admin/PointKind.java`、`admin/PointParticleRenderer.java`：纯枚举与无状态渲染器，渲染前校验 `viewer.getWorld() != world`，坐标为空时跳过；未发现空指针或越界路径。
- `admin/ArenaAdminService.java`、`admin/AdminDeployManager.java` 的其余方法：`deleteShopNpc` 正确消费写盘结果并区分 `WRITE_FAILED`，`updateGameParams` 先校验后写盘并在对局中拒绝，`deleteYamlEntry` 按「坐标合法条目」重新计数，均未发现新的独立缺陷（B-02 已覆盖 `AdminDeployManager` 的推送问题）。
- `command/HilltopCommandHandler.java`：顶层 20 余个子命令的权限门逐条核对（见第二节），参数边界（`args.length`、`parseInt` 的 `NumberFormatException`、`Integer.MIN_VALUE` 溢出为负下标）均被显式处理，未发现 AIOOBE 或越权路径。
- `admin/gui/ArenaManageGUI.java` 的其余视图：`RESET_CONFIRM` 在确认时重新执行 `canReset` 并绑定 `pendingResetArenaId`，`applyView` 在离开确认页时清空待重置 ID，返回栈与页码均有钳制，未发现「重置错场馆」或分页越界。

## 五、自检说明

- 标识符核对：7 条发现引用的方法/字段（`clearNodesForWorld`、`clearDeploymentData`、`reinstateRestoring`、`saveSpawnPoints`、`setSpawnPoints`、`tryFinishSpawnsStep`、`deleteLocation`、`setShopNpcLocation`）均在所引文件与行号处存在，跨文件调用链（GUI → Service → Manager）逐段回读确认。
- 反误报复核：已主动排除两个候选——控制台 `lang.getFor(null, ...)` 的空指针（`getPlayerLocale` 已空判断）、`ArenaCommand.counts[6]` 的越界（`countByState` 分配 `states.length + 1`）。
- 运行时验证：未启动 Paper 服务器，全部结论仅来自源码路径与状态机推演。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "round3-audit-B",
  "role": "audit",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "round3-B-audit.md",
  "error": null,
  "payload": {
    "slice_id": "round3-B",
    "searched_scope": {
      "files_read": [
        "command/ArenaCommand.java",
        "command/DeployMenuSender.java",
        "command/HilltopCommandHandler.java",
        "command/HilltopTabCompleter.java",
        "command/SetupWizard.java",
        "admin/AdminDeployManager.java",
        "admin/ArenaAdminService.java",
        "admin/ArenaResetService.java",
        "admin/gui/AbstractAdminMenu.java",
        "admin/gui/ArenaManageGUI.java",
        "admin/LocationParticlePreview.java",
        "admin/PointKind.java",
        "admin/PointParticleRenderer.java"
      ],
      "files_in_slice": 13,
      "dimension_checklist": [
        "security: 子命令执行门、控制台/玩家分支、tab 补全与执行权限一致性",
        "logic: args.length 与 parseInt 边界、向导步骤状态机、GUI 点击路由",
        "data-consistency: 重置/部署/删除的写盘顺序、内存与磁盘收敛、失败回滚",
        "error-handling: 写盘失败与未检查异常的收尾路径",
        "concurrency: 异步回滚回调、in-flight 去重、粒子预览任务生命周期",
        "contract: 同一破坏性操作在不同入口的语义与返回码一致性"
      ]
    },
    "findings": [
      {
        "finding_id": "B-01",
        "severity": "HIGH",
        "dimension": "data-consistency",
        "evidence": {
          "file": "admin/ArenaResetService.java",
          "line": 280,
          "quote": "int removedNodes = NodeSystem.clearNodesForWorld(dataFolder, world);"
        },
        "inference": {
          "claim": "重置在第 8 步 clearDeploymentData 失败时，节点已在第 5 步被永久删除，而 abort 会把竞技场重新启用，留下可开局但 0 节点的场馆。",
          "basis": "proceed 的顺序为：275 行 disableArena → 280 行 clearNodesForWorld → 300 行 despawnOwnShopNpc → 306 行 clearDeploymentData；306 行返回 false 时 309 行以 nodesCleared=true、dataCleared=false 调用 abort，abort 经 reinstateRestoring/reinstate 在 core 未清、enabled 为 true、wasReady 为 true 时执行 enableArena 成功。",
          "alternatives": [
            "若 clearDeploymentData 在只读闸门或 IO 失败时仍返回 true（内部吞掉写盘失败），则不会进入 abort，节点删除与部署清空一致，本条不成立——需核对 ArenaManager.clearDeploymentData 的返回值来源。",
            "若 abort 在 nodesCleared=true 时跳过 reinstate（保持 DISABLED），则不会出现「0 节点仍可开局」，影响降级为场馆不可用而非错误开局。"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "B-02",
        "severity": "MEDIUM",
        "dimension": "data-consistency",
        "evidence": {
          "file": "admin/AdminDeployManager.java",
          "line": 530,
          "quote": "gameManager.setSpawnPoints(savedSpawnPoints);"
        },
        "inference": {
          "claim": "saveSpawnPoints 在写盘失败后仍把内存中的生成点/刷怪点推送给运行实例，造成内存生效、磁盘未改的分叉。",
          "basis": "527 行 gate.write 的结果只赋给 saved，未提前 return；530-531 行无条件 setSpawnPoints/setMobSpawnPoints；541 行才把 lastSaveFailed 置为 !saved。只读路径在 458-462 行提前返回、不经过推送，因此本条特指闸门可写但 IO 写失败的分支。调用链 confirmClear→clearSpawnPoints（663 行先 clear）会先清空内存列表，因此写失败时运行实例拿到空表，hasSpawnPoints 变为 false。",
          "alternatives": [
            "若调用方在 saved=false 时会回滚内存并重新 loadSpawnPoints，运行实例与磁盘仍能收敛，本条不成立——但 clearSpawnPoints 不检查返回值、无回滚。",
            "若 gate.write 在 IO 失败时抛出异常而不是返回 false，530 行不会执行，本条不成立——但 YamlFileGate.write 的契约是记日志并返回布尔。"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "B-03",
        "severity": "MEDIUM",
        "dimension": "data-consistency",
        "evidence": {
          "file": "admin/gui/ArenaManageGUI.java",
          "line": 496,
          "quote": "boolean deleted = deleteLocation(kind, arenaId, index);"
        },
        "inference": {
          "claim": "列表项删除只携带渲染时捕获的全局下标，服务端按当前位置删除，列表在渲染后被改动时会删掉错误条目。",
          "basis": "placeLocationEntry 把 start+i 作为 final index 传入 handleLocationClick（444、478 行）；右键分支 496 行调用 deleteLocation→ArenaAdminService.deleteSpawnPoint(arenaId,index)→deploy.removeSpawnPoint(index)，全程不比对坐标；删除立即经 saveSpawnPoints 落盘。",
          "alternatives": [
            "若 GUI 在列表变化时会收到通知并自动重建，index 始终与当前列表一致，则不会删错——但代码中只有 reopen() 主动刷新，无外部变更监听。",
            "若删除前由 Service 按坐标二次校验（例如比较 location 与当前第 index 条是否相同），则会拒绝过期下标，本条不成立。"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "B-04",
        "severity": "LOW",
        "dimension": "logic",
        "evidence": {
          "file": "command/SetupWizard.java",
          "line": 547,
          "quote": "s.advance();"
        },
        "inference": {
          "claim": "向导 GUI 的完成/推进按钮不校验 s.step，过期界面仍可推进当前会话，导致跳过必经步骤。",
          "basis": "聊天入口在 1237、1255、1273、1292 等处均有 if (s.step != N) 守卫；GUI 路径 onInventoryClick 仅按标题分发（1746-1767），handleSpawnsOverviewClick 的 setup-overview-done 直接调用 tryFinishSpawnsStep，后者在 547 行无条件 s.advance()。",
          "alternatives": [
            "若 goto 入口会先 closeInventory 让旧界面失效，则过期点击不可能发生——但 1632-1669 行的 goto 分支没有关闭背包，只改 s.step 并重发消息。",
            "若 tryFinishSpawnsStep 会校验调用时的 s.step==3，则非第 3 步的点击会被拒绝——实际该方法只校验生成点/刷怪点非空，未读 s.step。"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "B-05",
        "severity": "MEDIUM",
        "dimension": "error-handling",
        "evidence": {
          "file": "admin/ArenaResetService.java",
          "line": 233,
          "quote": "if (releaseInFlight(key)) {"
        },
        "inference": {
          "claim": "reset 的 RuntimeException 兜底只释放 in-flight 并回调 internal 结果，不执行 reinstate，异常发生在 disableArena 之后时场馆会永久停在 DISABLED。",
          "basis": "227-240 行的 catch 块仅调用 releaseInFlight 与 deliver(new Outcome(..., \"internal\", ...))；与之对照，abort 在 413 行调用 reinstateRestoring，并在注释中明确「中止必须恢复启用状态」。proceed 在 275 行 disableArena 之后仍调用 NodeSystem（279-293）、despawnOwnShopNpc（300）、clearDeploymentData（306）、reloadAllDeploymentData（316）等可能抛未检查异常的路径。",
          "alternatives": [
            "若 proceed 在 disableArena 之后的全部调用都保证不抛出 RuntimeException，则该 catch 分支不可达，本条不成立——但这与 catch 块存在的目的矛盾。",
            "若 GUI 在收到 failStep=internal 时会额外提示「竞技场仍禁用」或自动 enable，则影响被缓解——reportReset 只在 reinstateSkipped 非 null 时提示，而该字段在此路径为 null。"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "B-06",
        "severity": "LOW",
        "dimension": "contract",
        "evidence": {
          "file": "command/HilltopTabCompleter.java",
          "line": 75,
          "quote": "if (isAdmin && !sender.hasPermission(\"hilltopvillage.admin\")) continue;"
        },
        "inference": {
          "claim": "config 的补全门要求 hilltopvillage.admin，执行门要求 hilltopvillage.config.admin；只直接持有 config.admin 的运维可执行，但补全列表不显示该子命令。",
          "basis": "HilltopTabCompleter 69-74 行把 config 列入 isAdmin 列表，75 行按 hilltopvillage.admin 过滤；HilltopCommandHandler 388-393 行执行侧只检查 hilltopvillage.config.admin；Bukkit 的父权限只向下继承，直接授予子节点不会获得父节点。",
          "alternatives": [
            "若服务器同时给所有 config.admin 持有者授予 hilltopvillage.admin，则补全与执行可见性一致，本条不成立。",
            "若该子命令不要求可发现性，影响仅为 UX，严重度可下调。"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "B-07",
        "severity": "MEDIUM",
        "dimension": "data-consistency",
        "evidence": {
          "file": "command/SetupWizard.java",
          "line": 1361,
          "quote": "deploy(player).setShopNpcLocation(null);"
        },
        "inference": {
          "claim": "clear-shop 丢弃 setShopNpcLocation 的返回值并无条件 despawn 实体，写盘失败时内存/实体已清、磁盘仍保留 shop-npc，重启后商店复活。",
          "basis": "1361 行调用后未检查 boolean；1363-1364 行无条件 despawnIfInWorld；1369-1370 行直接播报 shop-cleared；失败只在随后 autoSaveSilent 的 consumeSaveFailure 中以通用 save-failed 提示。对照 ArenaAdminService.deleteShopNpc 402 行在写盘失败时返回 WRITE_FAILED 且不 despawn。",
          "alternatives": [
            "若 setShopNpcLocation(null) 在写盘失败时抛出异常而非返回 false，后续 despawn 不会执行，本条不成立——但该方法签名返回 boolean 且 saveSpawnPoints 以 return false 收敛。",
            "若 NpcManager.despawnIfInWorld 自身会校验配置是否已落盘，则不会出现实体消失而配置仍存在的分叉，影响不成立。"
          ]
        },
        "status": "CONFIRMED"
      }
    ],
    "self_checks": {
      "identifier_reconcile": {
        "status": "DONE",
        "note": "7 条发现引用的 NodeSystem.clearNodesForWorld、clearDeploymentData、reinstateRestoring、saveSpawnPoints、setSpawnPoints、tryFinishSpawnsStep、deleteLocation、setShopNpcLocation 均在所引文件与行号处存在；GUI→Service→Manager 的跨文件调用链逐段回读核对。"
      },
      "self_check_audit": {
        "status": "DONE",
        "note": "逐条回读源码复核触发条件与影响，并主动排除两个候选误报：控制台 lang.getFor(null,...) 空指针（getPlayerLocale 已判空）与 ArenaCommand counts[6] 越界（countByState 分配 states.length+1）；另核对 20 余个子命令未发现缺失权限门。"
      },
      "runtime_validation": {
        "status": "SKIPPED",
        "note": "静态审计，未启动 Paper 服务器，无法运行时复现；全部结论仅基于源码路径与状态机推演。"
      }
    }
  }
}
```
