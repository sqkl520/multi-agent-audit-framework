# slice-08 宽扫（命令层：ArenaCommand / DeployMenuSender / HilltopCommandHandler）

- status: COMPLETE
- trace_id: trace-r1-20260215-hilltop-dsh3 / round_id: round1 / slice_id: slice-08
- 被审仓库（只读）：`D:\Server\MCServers\Server plugin\Hilltop Village\Hilltop Village Plugin`

## 0. 范围与实测行数（任务书输入已核对）

任务书对 `HilltopCommandHandler` 写的是「1447 行（物理 2110）」。本回合用 read 工具实测为 **1755 行**（read 工具返回 `total 1755`）；`Get-Content | Measure-Object -Line` 得 1447，是因为该 cmdlet 不计纯空行（1755 - 1447 = 308 行空白）。产物中 `files_read.lines` 一律采用 **read 工具实测总行数**。

| 文件 | read 实测行数 | 任务书 | 备注 |
|---|---|---|---|
| `ArenaCommand.java` | 184 | — | 一致 |
| `DeployMenuSender.java` | 168 | — | 一致 |
| `HilltopCommandHandler.java` | 1755 | 1447（物理 2110） | 见上，非阻塞偏差 |

## 1. 这一片是什么

`HilltopCommandHandler.handle()` 是本插件 `/hilltop`（以及 `/hub`、`/lobby`）的总入口：`/hilltop` 一个 switch 分出 start/stop/join/leave/status/hammer/fireball/help/deploy/config/reloadconfig/lang/setup/tps/gui/build/stats/top/list/arenas/manage/lobby/wave/enable/disable/shop 共 24 个子命令，再各自下沉到 `handleDeployCommand` / `handleConfigCommand` / `handleWaveCommand` / `handleShopGive` / `handleLobbyCommand` 等。

可达性判断（浅层，按模板 §5 要求）：`HilltopCommandHandler` 由 `plugin.getCommand("hilltop").setExecutor(...)` 这类注册路径接入（`ArenaCommand` 经 `plugin.getArenaCommand()` 在本类 `list`/`arenas` 分支被直接调用，`DeployMenuSender` 由本类构造并用于 usage/deploy 菜单）。三文件均处于命令入口链上 → **PROD**。

## 2. 扫过的点（按 6 维度）

| 维度 | 查了什么 | 结果 |
|---|---|---|
| `contract` | 每个 case 的 `args.length` 判定、`Integer.parseInt` 包裹、权限节点、子命令分发 | 3 条线索：`config nodes` 参数不足时静默落到 GUI（L2）、`join` 的 `args[1]` 原样进 `joinArena`（L3）、`ArenaCommand` 无参静默 return（L5） |
| `error-handling` | catch 块、可空返回值、异常是否会冒到命令层 | 1 条线索：`handleStatsCommand` 先解引用后判空（L1）。`reloadconfig` 的 `catch (RuntimeException)` 有日志 + 用户提示，不记线索 |
| `logic` | 状态机前置条件、返回值语义 | 1 条线索：`stop` 无状态前置检查却无条件播报成功（L4） |
| `data-consistency` | 写盘结果消费、内存与落盘一致 | 写盘结果普遍消费（`reportDeploySaveFailure` / `saved` 分支），仅 1 条低置信：`String.format("%.1f")` 走默认 Locale（L6） |
| `security` | 权限节点、玩家名/UUID 作键、经济数值 | `shop give` 有 `amount <= 0` 与 `MAX_SHOP_GIVE` 上限；`lang` 已区分个人偏好与全服默认；未发现可写线索（记 0） |
| `concurrency` | 异步/调度器/共享集合 | 全部在主线程执行；`pendingClears` 是 `ConcurrentHashMap` 且只在主线程 + `runTaskLater` 访问，过期任务用 `remove(key, fresh)` 双参删除。未发现线索（记 0） |

## 3. 未记为线索但值得下游知道的观察（不占 lead 配额）

- `ArenaCommand.handleArenas` 的 `counts[0]` 语义：本类注释明确 `counts[0]` 是 Total、`counts[1..6]` 是六个状态桶，`countByState` 传 6 个状态却访问到 `counts[6]`——若 `countByState` 返回长度仅为 `states.length`（=6），第 97 行会 `ArrayIndexOutOfBoundsException`。本回合未读 `MultiArenaManager`，无法证实返回数组长度，故不记为 lead，仅提示深挖若碰 `arena` 维度可顺手核一眼。
- `case "status"`、`case "list"`、`case "gui"` 无权限节点：与 `plugin.yml` 的口径是否一致需读 `plugin.yml`（本切片未授权读该文件），未记为 lead。
- `case "build"`、`case "manage"`、`case "config"` 每次调用都 `registerEvents` 一个新 GUI 监听器，注销依赖 GUI 关闭回调；未观察到可复现的重复注册路径，仅记录。

## 4. 线索

### L1 — `stats.get()` 的返回值在判空前被解引用

`HilltopCommandHandler.java:1581-1585`：

```java
target = stats.get(player.getUniqueId());
if (target.getName() == null || target.getName().isEmpty()) {
    target = null;
}
if (target == null) {
```

第 1585 行的 `target == null` 判空，只有在第 1582 行**没有**抛 NPE 时才会被执行到——即该判空实际上不可达。同一方法内 `findByName`（1570）与 `get`（1581）都是可能返回 null 的查询，作者对前者做了判空、对后者没有。`/hilltop stats`（无参、玩家执行）即可触达。

### L2 — `/hilltop config nodes ...` 参数不足时静默打开 GUI

`HilltopCommandHandler.java:613-645`：外层只判 `args.length >= 2`，内层要求 `args[1].equals("nodes") && args.length >= 4`。于是 `/hilltop config nodes repairitem`（3 个 token，最容易被手敲出来的形态）既不进 `repairitem` 分支、也不进 `config.unknown-sub` 分支，而是直接落到 647 行的 `new MainConfigMenu(...).open()`。管理员看到的是「配置 GUI 打开了」，而不是「repairitem 少了一个材质参数」。

### L3 — `join` 把 `args[1]` 原样交给 `joinArena`，与同文件其它子命令的解析纪律不一致

`HilltopCommandHandler.java:296-300`。同一 switch 里 `start`/`stop`/`status`/`wave` 都走 `arenaManager.resolveArena(id, player)` + `sendArenaResolveFailure(...)`，只有 `join` 直接 `joinArena(player, args[1])`；且第 293 行已经先 `leaveArena(player)`，若随后的 `joinArena` 因为 ID 不存在而失败，玩家会停在「已退出原场、没进新场」的中间态，而命令层没有任何返回值消费或失败播报。

### L4 — `stop` 没有状态前置检查，却无条件播报「已停止」

`HilltopCommandHandler.java:247-255`。对照 `start`（214 行检查 `getState() != WAITING`、221 行检查 `ENDING`/地图恢复中），`stop` 解析到实例后直接 `stopGame()` 并固定发 `game-stopped`。对 WAITING / 已结算 / 地图恢复中的场执行，管理员会得到一条与实际状态无关的成功文案。

### L5 — `ArenaCommand` 无参调用时静默 `return true`

`ArenaCommand.java:39`。整个类没有 usage 分支（javadoc 说明 join/leave/无参/help 已在 fix6 删除），`args.length == 0` 时既不执行也不提示。若该执行器仍被注册到某个命令名上，`/<cmd>` 会得到「命令存在但毫无反应」；即使是内部调用，这个分支也是一个没有任何反馈的静默出口。

### L6 — 坐标文案用默认 Locale 格式化（低置信）

`HilltopCommandHandler.java:915`（同类还有 942/957/976/1053/1138/1212 等）。插件自带 en/zh 语言包，但 `String.format("%.1f", ...)` 用的是 JVM 默认 Locale：在 `de_DE` / `fr_FR` 之类服务端上会输出 `12,5`，而同一串坐标在 `listspawns` 里是可粘回命令的参数形态（本文件多处注释强调「1 基编号可直接粘贴回命令」）。是否构成实际缺陷取决于服主是否跑非英文 Locale，故记 LOW。

## 5. 覆盖说明

- 逐行读完：`HilltopCommandHandler.java`（1-1755，分 4 段 read）、`ArenaCommand.java`（全 184 行）、`DeployMenuSender.java`（全 168 行）。
- 未读切片外文件（未读 `plugin.yml`、`MultiArenaManager`、`StatsManager`），相关不确定项已写进 §3，不冒充结论。
- 本产物只做线索登记，不判严重性、不做证据链。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "sweep-slice-08",
  "role": "sweep",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/.run-dsh3/artifacts/round1-02-sweep-slice-08.md",
  "payload": {
    "slice_id": "slice-08",
    "reachability": "PROD",
    "generator_ref": null,
    "files_read": [
      {
        "path": "src/main/java/com/hilltopvillage/command/ArenaCommand.java",
        "lines": 184,
        "quote": "if (args.length == 0) return true;"
      },
      {
        "path": "src/main/java/com/hilltopvillage/command/DeployMenuSender.java",
        "lines": 168,
        "quote": "public void sendUsage(CommandSender sender) {"
      },
      {
        "path": "src/main/java/com/hilltopvillage/command/HilltopCommandHandler.java",
        "lines": 1755,
        "quote": "public boolean handle(CommandSender sender, Command command, String label, String[] args) {"
      }
    ],
    "files_unreadable": [],
    "leads": [
      {
        "lead_id": "L1",
        "suspected_dimension": "error-handling",
        "file": "src/main/java/com/hilltopvillage/command/HilltopCommandHandler.java",
        "line": 1582,
        "quote": "if (target.getName() == null || target.getName().isEmpty()) {",
        "why_suspicious": "上一行 stats.get(uuid) 的返回值未判空即解引用，紧随其后的 target == null 判空因此不可达——查询返回 null 时 /hilltop stats 会 NPE。",
        "confidence": "HIGH"
      },
      {
        "lead_id": "L2",
        "suspected_dimension": "contract",
        "file": "src/main/java/com/hilltopvillage/command/HilltopCommandHandler.java",
        "line": 614,
        "quote": "if (args[1].equalsIgnoreCase(\"nodes\") && args.length >= 4) {",
        "why_suspicious": "nodes 子命令只在 args.length >= 4 时被识别，`/hilltop config nodes repairitem` 这种 3 参数形态会落到函数末尾打开配置 GUI，既不报用法缺失也不报未知子命令。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L3",
        "suspected_dimension": "contract",
        "file": "src/main/java/com/hilltopvillage/command/HilltopCommandHandler.java",
        "line": 297,
        "quote": "arenaManager.joinArena(player, args[1]);",
        "why_suspicious": "唯一一个把用户输入原样交给 manager 的子命令（同 switch 的 start/stop/status/wave 都先 resolveArena 并播报解析失败），且上一行已执行 leaveArena，join 失败时玩家停在已退场未入场的中间态。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L4",
        "suspected_dimension": "logic",
        "file": "src/main/java/com/hilltopvillage/command/HilltopCommandHandler.java",
        "line": 253,
        "quote": "stopArena.stopGame();",
        "why_suspicious": "stop 分支没有像 start 那样的状态前置检查，解析到实例后直接停服并固定播报 game-stopped，对 WAITING/结算中/地图恢复中的场会给出与真实状态不符的成功文案。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L5",
        "suspected_dimension": "contract",
        "file": "src/main/java/com/hilltopvillage/command/ArenaCommand.java",
        "line": 39,
        "quote": "if (args.length == 0) return true;",
        "why_suspicious": "无参路径直接返回 true，类中已无 usage/help 分支，命令被执行器调用时空参数会得到零反馈的静默成功。",
        "confidence": "LOW"
      },
      {
        "lead_id": "L6",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/command/HilltopCommandHandler.java",
        "line": 915,
        "quote": "String.format(\"%.1f\", admin.getLocation().getX()),",
        "why_suspicious": "坐标文案用 String.format 加默认 Locale，非英文服务端会输出逗号小数（12,5），而同类坐标在 listspawns 里被当作可粘回命令的参数展示。",
        "confidence": "LOW"
      }
    ],
    "lead_count": 6,
    "dimension_histogram": {
      "logic": 1,
      "concurrency": 0,
      "security": 0,
      "error-handling": 1,
      "data-consistency": 1,
      "contract": 3
    }
  },
  "error": null
}
```
