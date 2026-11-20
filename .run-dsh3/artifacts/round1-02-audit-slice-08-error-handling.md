# round1 / slice-08 / error-handling 深挖

- trace_id: `trace-r1-20260215-hilltop-dsh3` / round_id: `round1` / slice_id: `slice-08`
- 维度: `error-handling`（只报未捕获异常、错误吞没、静默失败、恢复路径缺失；逻辑/契约问题入 `off_dimension_notes`）
- 被审仓库（只读）: `D:\Server\MCServers\Server plugin\Hilltop Village\Hilltop Village Plugin`
- 上游宽扫: `.run-dsh3/artifacts/round1-02-sweep-slice-08.md`（L1、L5 为本维度指定线索）

## 1. 范围与方法

逐行读完切片三文件：`ArenaCommand.java`（184 行）、`DeployMenuSender.java`（168 行）、`HilltopCommandHandler.java`（read 实测 1755 行）。

查法（error-handling 专用）：

1. 全文件扫 `catch` / `printStackTrace` / `parseInt` / `parseDouble` / `valueOf` / `getString` / `getConfigurationSection`，逐个判定是否吞异常或未包裹。
2. 逐个 `args[i]` 下标核对是否有 `args.length` 前置守卫（13 处取值点全覆盖）。
3. 对每个返回 `null` / `boolean` 的被调用方，核对调用点是否消费失败信号（`getStatsManager`、`getShopManager`、`getShopConfig`、`getDefinitionManager().getArena`、`Bukkit.getPlayerExact`、`Material.getMaterial`、`enableArena`、`setLobbySpawn…`）。
4. 对 `void` 型加载器（`AdminDeployManager.loadSpawnPoints`、`NodeSystem.loadNodesFromConfig`）追踪其内部失败早退分支，看命令层是否还能播报成功。
5. 为判定可达性读了 `plugin.yml` 与 `HilltopVillagePlugin#registerCommandHooks`；为判定线索真伪读了 `StatsManager`、`MultiArenaManager`、`LanguageManager`、`ShopManager`、`ArenaInstance` 的目标行段；为抽验自带测试读了 `ArenaCommandTest`、`HilltopCommandReloadResultTest`。

## 2. 上游线索处置（逐条）

| lead | 断言 | 处置 | 依据 |
|---|---|---|---|
| **L1** | `handleStatsCommand` 先 `target.getName()` 后判空，`/hilltop stats` 会 NPE | **REFUTED** | `StatsManager.get(UUID)` 是 `cache.computeIfAbsent(uuid, k -> new PlayerStats())`（StatsManager:189-191），**永不返回 null**；`PlayerStats.name` 默认值是 `""` 而非 null（StatsManager:93）。因此 `target.getName()` 不会 NPE。该写法确实绕，但不会抛异常。 |
| **L5** | `ArenaCommand:39` 无参静默 `return true` | **REFUTED（有意契约，且有回归测试）** | `plugin.yml` 只声明 `hilltop`/`hub`/`lobby` 三条命令，`registerCommandHooks` 只给这三条挂 executor（HilltopVillagePlugin:606-614）；`ArenaCommand` 未注册，仅被 HCH:529/537 以固定实参 `{"list"}` / `{"arenas"}` 调用。`ArenaCommandTest:381-392` 两条用例把「无参/未知子命令静默」写成断言（`args 为空时必须静默返回`、`静默返回即可`）。 |

两条线索均不构成本维度可确认缺陷；按 §4 纪律记入 `NO_EVIDENCE_FOUND` 条目，不包装成 CONFIRMED。

## 3. 发现 1（CONFIRMED / MEDIUM）— `/hilltop deploy reloadnodes` 在重载失败时仍播报成功

**调用链（入口 → 问题点）**：

```
玩家/管理员执行 /hilltop deploy reloadnodes
  → HilltopCommandHandler.handle() case "deploy"（HCH:380-386，权限校验后）
  → handleDeployCommand() switch(args[1]) case "reloadnodes"（HCH:1102）
  → deploy.loadSpawnPoints()（AdminDeployManager:216，void）
  → deployGm.getNodeSystem().loadNodesFromConfig()（NodeSystem:127，void）
  → HCH:1105-1106 无条件 admin.sendMessage("deploy.reloadnodes-done", getTotalCount())
```

**失败侧（本回合读到的原文）**：

- `AdminDeployManager.loadSpawnPoints()`：闸门不可用 → `lastSaveFailed = true;` + `severe(...)` + `return;`（AdminDeployManager:220-225）；文件不可用或闸门已锁只读 → `lastSaveFailed = true;` + `warning("arenas.yml is unusable; keeping the in-memory deployment data (writes are blocked until the file is repaired)")` + `return;`（238-243）；竞技场世界未加载 → 只 `warning("Arena world not found, deferring load.")` + `return;`（249-252，且**连 `lastSaveFailed` 都不置位**）。
- `NodeSystem.loadNodesFromConfig()`：`nodes.yml` 因上次读盘失败被隔离（`NODES_READ_ONLY`）→ 只 `warning` + 保留当前节点 + `return`（NodeSystem:133-137）；校验不可用 → `NODES_READ_ONLY.add(...)` + 只 `severe` + `return`（145-151）。
- 播报侧文案：`deploy.reloadnodes-done: "&a已重新扫描能量节点。当前节点数: &f{0}"`（messages.yml:1617；en 版 513 行）。

即：文件坏着的时候，命令给出「已重新扫描 + 旧节点数」的成功回执，管理员据此以为已经 reload 过，而磁盘上的坏文件、只读锁、以及未被重读的部署点一个都没变。这正是 error-handling 的「静默失败 / 恢复路径缺失」：失败信号在管理器内部产生（`lastSaveFailed`）或被降级成日志（`NODES_READ_ONLY`），命令层没有任何消费点。

**同文件对照（说明这不是设计取舍，而是漏点）**：同一 switch 内 9 处写盘/落盘命令都走 `reportDeploySaveFailure(admin, deploy)` 收口（HCH:918、945、960、1001、1037、1075、1122、1160、1215），该方法的唯一职责就是 `consumeSaveFailure()` 后播 `deploy.save-failed`；`reloadnodes` 是唯一一个既调用落盘/读盘又不消费失败标记的部署子命令。项目甚至已为同类缺陷写过先例测试：`HilltopCommandReloadResultTest#failedReloadDoesNotAnnounceSuccess`（`★ loadFromFile() 失败 → 发 config-reload-failed，绝不发 config-reloaded`），但只覆盖 `reloadconfig`，`reloadnodes` 无对应用例。

**影响面**：`/hilltop reloadconfig` 的 reset 闸门逻辑把「改坏 → 修好 → reload 生效」当作运维闭环（HCH:401-417 注释），而闭环的最后一步 `reloadnodes` 会谎报成功——管理员会去数节点、怀疑坐标，而不是回来看文件/权限。不丢数据（两个加载器都刻意保留内存数据），故 MEDIUM 而非 HIGH。

**修复方向（交给修复波，本 Agent 不改仓库）**：让 `loadSpawnPoints` / `loadNodesFromConfig` 返回状态（或在 `reloadnodes` 分支消费 `reportDeploySaveFailure`），失败时播 `deploy.save-failed` 而非 `reloadnodes-done`。

## 4. 维度清单（8 模式 + 4a–4d，逐项给结论）

| # | 模式 | 结果 | 说明 |
|---|---|---|---|
| 1 | 返回值暴露内部状态 | 未命中 | 命令层无 `return this.x[...]`；`getSpawnPoints()` 等只读消费，未在命令层增删内部集合 |
| 2 | 同族函数守卫一致性 | **命中** | 同族部署子命令 9 处消费 `consumeSaveFailure`，`reloadnodes`（HCH:1102-1107）不消费 → 发现 1 |
| 3 | 数值边界完整 | 未命中 | `parseInt` 4 处全部 try/catch；`amount <= 0`、`> MAX_SHOP_GIVE` 均拦；`delspawn` 的 `index < 0 || index >= size` 齐备 |
| 4a | 原型链/裸下标 | 不适用 | Java，无原型链；`args[i]` 13 处取值全部有长度前置 |
| 4b | 假值 vs 缺值 | 未命中 | `locale` 用 equals 白名单；`args.length` 判据统一 |
| 4c | NaN/Infinity/小数 | 未命中 | `getWinRate()` 自带 `gamesPlayed == 0 ? 0.0`（StatsManager:119-121），不会输出 NaN；`%.1f` 的 Locale 问题属 data-consistency（L6），不在本维度 |
| 4d | 嵌套结构校验 | 未命中 | 命令层不解析嵌套结构；`getMapList` 的逐项 `instanceof Number` 校验在 AdminDeployManager:267-269 |
| 5 | 能力是否真实现 | **命中** | `reloadnodes` 名称/文案声称「重新扫描」，实际失败时什么都不扫（发现 1） |
| 6 | 转义/编码顺序 | 不适用 | 无 HTML/URL 拼接 |
| 7 | 边界符号（负数/下标） | 未命中 | `shownIndex - 1` 后有 `index < 0` 守卫；`counts[6]` 见下 |
| 8 | 引用绑定是否存在 | 未命中 | 无未导入符号；`ArenaCommand` 的 `plugin` 字段赋值后未再使用属死字段，非错误路径 |

**关于 `counts[6]`（上游 §3 的悬置项）**：`MultiArenaManager.countByState` 分配的是 `new int[states.length + 1]`（MultiArenaManager:1140），传 6 个状态即长度 7，`counts[0..6]` 全部合法；`ArenaCommandTest` 亦有「生产代码按固定下标取 counts[0..6]」的契约用例。**不构成 AIOOBE**。

## 5. 排除的候选（查过但不立条）

| 候选 | 结论 |
|---|---|
| `joinArena` 返回 false 时无播报（HCH:297） | 不成立：`ArenaInstance.addPlayer` 的 5 条失败分支各自 `lang.send`（ArenaInstance:284-312），玩家有反馈 |
| `plugin.getShopManager()` 在 `shop reload` 分支未判空（HCH:580-584） | 不成立：`shopManager` 在 onEnable 无条件构造（HilltopVillagePlugin:119），`reload()` 保证 `config` 非 null（ShopManager:92-95） |
| `lang.getFor(null, …)` 控制台路径 NPE | 不成立：`getPlayerLocale(null)` 直接返回 defaultLocale（LanguageManager:311-313） |
| 调度器任务抛异常被静默取消 | 未证实：`requestClear` 的 15s 任务（HCH:769-773）只做 `remove` + `sendMessage`，无抛点证据，不立条 |
| `reloadconfig` 的 `catch (RuntimeException)`（HCH:448） | 合规：有 SEVERE 日志 + 用户提示，且成功提示在 try 末尾之后，不构成假成功 |

## 6. 自带自检抽验（静态）

- `ArenaCommandTest`：`noArgsIsNoOp` / `unknownSubcommandIsNoOp` 把静默出口固化为契约 → 直接否掉 L5；`counts[0..6]` 契约用例否掉 AIOOBE 猜测。
- `HilltopCommandReloadResultTest`：对 `reloadconfig` 做了「失败不得播报成功」的正反用例，**但没有 `reloadnodes` 的对应用例**——发现 1 正落在这个测试盲区。
- `NodeSystemTest:241`「loadNodesFromConfig 在文件损坏时保留现有节点」：证明加载器行为是有意为之，因此缺陷确实在命令层（未消费状态），不在加载器。
- 以上均为静态阅读；需要构建的用例执行见 `self_checks.runtime_validation`。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "audit-slice-08-error-handling",
  "role": "audit",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/.run-dsh3/artifacts/round1-02-audit-slice-08-error-handling.md",
  "payload": {
    "slice_id": "slice-08",
    "findings": [
      {
        "finding_id": "F-slice08-eh-01",
        "severity": "MEDIUM",
        "dimension": "error-handling",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/command/HilltopCommandHandler.java",
          "line": 1103,
          "quote": "deploy.loadSpawnPoints();\ndeployGm.getNodeSystem().loadNodesFromConfig();\nadmin.sendMessage(lang.getFor(admin, \"deploy.reloadnodes-done\",\ndeployGm.getNodeSystem().getTotalCount()));"
        },
        "inference": {
          "claim": "当 arenas.yml 或 nodes.yml 不可用（被隔离成 *.corrupt、闸门只读、竞技场世界未加载）时，/hilltop deploy reloadnodes 仍然无条件播报 deploy.reloadnodes-done 并打印旧的节点数：管理员收到成功回执，而两个加载器都已早退、什么都没重读。",
          "basis": "调用链：/hilltop deploy reloadnodes → HilltopCommandHandler.handle case \"deploy\"(HCH:380-386) → handleDeployCommand → switch(args[1]) case \"reloadnodes\"(HCH:1102) → deploy.loadSpawnPoints()(AdminDeployManager:216，失败分支 220-225 / 238-243 只置 lastSaveFailed 并 return，249-252 连标记都不置) → loadNodesFromConfig()(NodeSystem:127，失败分支 133-137 / 145-151 只 warning/severe 并 return) → HCH:1105 无任何 if 包裹直接发 done 文案。同文件 9 处同类命令都经 reportDeploySaveFailure 消费 consumeSaveFailure()（HCH:681-685 定义，918/945/960/1001/1037/1075/1122/1160/1215 调用），reloadnodes 是唯一漏点。",
          "alternatives": [
            "如果 AdminDeployManager.loadSpawnPoints 在失败时抛异常而不是 return，命令就不会走到 1105 行的成功播报——需检查 AdminDeployManager.java:238-243 的 return 语义。",
            "如果 nodes.yml 损坏时 loadNodesFromConfig 会清空节点、使 getTotalCount() 变成 0，管理员从「0 个节点」也能看出异常，误导性会显著下降——需检查 NodeSystem.java:145-151 是否刻意保留旧节点。",
            "如果运维约定「控制台日志才是唯一权威反馈、命令回执不保证真实」，则该问题只是文案瑕疵而非静默失败——需检查 README/运维文档是否明示这一点。"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "F-slice08-eh-00",
        "severity": null,
        "dimension": "error-handling",
        "evidence": {
          "file": null,
          "line": null,
          "quote": null
        },
        "inference": {
          "claim": "上游指定的两条 error-handling 线索（L1 stats NPE、L5 ArenaCommand 无参静默）经复核均不成立，本切片在异常路径上未发现其它可确认缺陷。",
          "basis": "L1：StatsManager.get(UUID) 为 cache.computeIfAbsent(uuid, k -> new PlayerStats())（StatsManager:189-191），永不返回 null，且 PlayerStats.name 初值为空串（StatsManager:93），target.getName() 不会 NPE，1585 行的判空反而经空串路径可达。L5：plugin.yml 仅声明 hilltop/hub/lobby，registerCommandHooks 只为这三条挂 executor（HilltopVillagePlugin:606-614），ArenaCommand 未注册、仅被 HCH:529/537 以固定实参调用，且 ArenaCommandTest:381-392 把静默行为写成断言。另核查了 catch 吞异常、parseInt 包裹、可空返回值、void 加载器失败路径等模式。",
          "alternatives": [
            "如果 StatsManager.get 在其它分支（例如只读降级或缓存未初始化）会返回 null，则 L1 仍可能成立——需检查 StatsManager.java:189-191 之外是否存在第二条 get 实现或缓存替换路径。",
            "如果 ArenaCommand 通过反射/其它插件被注册为命令执行器，则 L5 的静默出口会变成可达——需检查仓库内是否存在 plugin.yml 之外的命令注册点。"
          ]
        },
        "status": "NO_EVIDENCE_FOUND"
      }
    ],
    "searched_scope": {
      "files_read": [
        "src/main/java/com/hilltopvillage/command/HilltopCommandHandler.java",
        "src/main/java/com/hilltopvillage/admin/AdminDeployManager.java",
        "src/main/java/com/hilltopvillage/mechanics/NodeSystem.java"
      ],
      "files_in_slice": 3,
      "shared_dependencies_read": [
        "src/main/java/com/hilltopvillage/arena/MultiArenaManager.java",
        "src/main/java/com/hilltopvillage/arena/ArenaInstance.java",
        "src/main/java/com/hilltopvillage/stats/StatsManager.java",
        "src/main/java/com/hilltopvillage/util/LanguageManager.java",
        "src/main/java/com/hilltopvillage/shop/ShopManager.java",
        "src/main/java/com/hilltopvillage/HilltopVillagePlugin.java"
      ],
      "files_scanned_without_findings": [
        "src/main/java/com/hilltopvillage/command/ArenaCommand.java",
        "src/main/java/com/hilltopvillage/command/DeployMenuSender.java",
        "src/main/resources/plugin.yml",
        "src/main/resources/messages.yml",
        "src/test/java/com/hilltopvillage/command/ArenaCommandTest.java",
        "src/test/java/com/hilltopvillage/command/HilltopCommandReloadResultTest.java"
      ],
      "dimension_checklist": [
        { "pattern": "1 返回值暴露内部状态", "result": "未命中", "note": "命令层只读消费 getSpawnPoints/getVillagers，无返回内部引用" },
        { "pattern": "2 同族函数守卫一致性", "result": "命中", "note": "9 处部署命令消费 consumeSaveFailure，reloadnodes 不消费 → F-slice08-eh-01" },
        { "pattern": "3 数值边界", "result": "未命中", "note": "4 处 parseInt 全包裹；shop give 有 <=0 与上限；del* 有负数/上界守卫" },
        { "pattern": "4a 原型链/裸下标", "result": "不适用", "note": "Java 无原型链；args[i] 13 处取值均有长度前置" },
        { "pattern": "4b 假值 vs 缺值", "result": "未命中", "note": "locale 白名单 equals；长度判据统一" },
        { "pattern": "4c NaN/Infinity/小数", "result": "未命中", "note": "getWinRate 对 games==0 返回 0.0，无 NaN 输出" },
        { "pattern": "4d 嵌套结构校验", "result": "未命中", "note": "getMapList 逐项 instanceof Number 校验在 AdminDeployManager:267-269" },
        { "pattern": "5 能力是否真实现", "result": "命中", "note": "reloadnodes 声称重新扫描，失败时未重读任何文件 → F-slice08-eh-01" },
        { "pattern": "6 转义/编码顺序", "result": "不适用", "note": "无 HTML/URL/多层替换" },
        { "pattern": "7 边界符号（负数/下标）", "result": "未命中", "note": "shownIndex-1 后判 index<0；counts[6] 对应 new int[states.length+1]，合法" },
        { "pattern": "8 引用绑定是否存在", "result": "未命中", "note": "无未导入符号；ArenaCommand.plugin 死字段非错误路径" }
      ]
    },
    "self_checks": {
      "identifier_reconcile": {
        "status": "DONE",
        "note": "对账三组：①plugin.yml 命令名 vs CONSOLE_BLOCKED_COMMANDS vs switch 子命令（无孤儿分支，24 case 均有入口）；②代码引用的 lang 键 deploy.reloadnodes-done / deploy.save-failed / stats.player-not-found / stats.usage 在 messages.yml 的 en+zh 双侧均存在（179/180/209/513 与 1265/1266/1295/1617），差集为空；③reportDeploySaveFailure 的 9 个调用点 vs reloadnodes 0 个，差集=1（即 F-slice08-eh-01）。"
      },
      "self_check_audit": {
        "status": "DONE",
        "note": "抽验 3 个自带测试：ArenaCommandTest 的 noArgsIsNoOp/unknownSubcommandIsNoOp（把静默出口固化为契约，据此否掉 L5）、counts[0..6] 契约用例（否掉 AIOOBE 猜测）、HilltopCommandReloadResultTest 的 failedReloadDoesNotAnnounceSuccess（同类「失败不得播报成功」先例，但 reloadnodes 无用例，暴露测试盲区）。均为静态阅读，未执行。"
      },
      "runtime_validation": {
        "status": "SKIPPED",
        "note": "运行时验证需要构建（maven 会写 target/）并启动 Paper 服务器构造 arenas.yml/nodes.yml 损坏态，两者都违反本轮零写入约束，故以控制流证据替代，并在正文列出可复现触发条件。"
      }
    },
    "off_dimension_notes": [
      "data-consistency（非本维度）：/hilltop stats 的 stats.get(uuid) 走 computeIfAbsent（StatsManager:190），读命令会向统计缓存插入空记录；若 flush 遍历全量缓存，从未游玩的玩家也会被写进 stats.yml。需读 StatsManager 的落盘路径确认。",
      "contract（非本维度，L3）：join 先 leaveArena 再 joinArena，joinArena 返回 false 时玩家停在「已退原场、未入新场」，HCH:296-300 不消费返回值；因 addPlayer 的失败分支会自行播报，不构成静默失败。",
      "contract（非本维度）：reloadconfig 的 catch 分支（HCH:448-451）用硬编码英文串，而 messages.yml 已有 config-reload-failed 键，zh 服务器会出现中英混排。"
    ]
  },
  "error": null
}
```
