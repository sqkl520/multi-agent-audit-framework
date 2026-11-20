# round1 · 波次一侦察切片清单（Hilltop Village）

- 角色：`recon`（侦察），不产出 findings、不做质量评价。
- 输入：`.run-dsh3/inventory.txt`（75 行，`路径<TAB>行数`）。
- 仓库根：`D:\Server\MCServers\Server plugin\Hilltop Village\Hilltop Village Plugin`（只读，零写入）。
- 切片算法：按目录分组 → 组内按文件名排序 → 顺序装箱，累加超过 1800 行即开新片；单文件 >1800 行单文件成片；组内小尾巴优先并回同组（并入后 ≤1800 才并），否则单独成片；不跨模块拼接。

## 1. 装箱结果总览

| 分组（目录） | 切片 | 行数 | 文件数 |
|---|---|---|---|
| `admin` | slice-01 / slice-02 | 1778 / 203 | 3 / 3 |
| `admin/gui` | slice-03 | 916 | 2 |
| `ai` | slice-04 | 1122 | 5 |
| `arena` | slice-05 / slice-06 / slice-07 | 1414 / 962 / 909 | 2 / 4 / 1 |
| `command` | slice-08 / slice-09 / slice-10 | 1747 / 177 / 1952 | 3 / 1 / 1 |
| `config` | slice-11 / slice-12 | 1744 / 1407 | 2 / 3 |
| `config/menu` | slice-13 / slice-14 | 1421 / 641 | 7 / 1 |
| `core`（含根目录主类） | slice-15 / slice-16 | 1710 / 903 | 5 / 1 |
| `diagnostic` | slice-17 | 101 | 1 |
| `doc` | slice-18 | 490 | 1 |
| `gui` | slice-19 | 276 | 1 |
| `mechanics` | slice-20 / 21 / 22 / 23 | 1496 / 1624 / 1726 / 273 | 5 / 4 / 4 / 1 |
| `shop` | slice-24 | 1255 | 7 |
| `stats` | slice-25 | 516 | 1 |
| `util` | slice-26 | 1257 | 6 |

- 合计：**26 个切片 / 75 个文件**；非空行数口径 28020 行（与 `inventory.txt` 逐行求和一致，75 个文件零差异），物理行数口径 34954 行。
- `line_count` 采用物理行数口径（verify-artifacts G8 口径），与最初的非空行数口径相差 13–27%；8 个切片物理行数 >1800（不含本就 oversized 的 slice-10），已在最终报告中作为 L1 裁量披露。

### 装箱自检（与任务书「预期 18–24 片」的偏差说明）

- 任务书列出的 15 个分组各自独立装箱，确定性结果是 **26 片**，略高于预期区间 18–24。已逐项复核：
  - 未漏组：15 个分组全部出现在上表，文件总数 75/75；
  - 未跨组拼接：所有切片的 `files` 均来自单一分组，`admin` 的尾巴没有并入 `admin/gui`，`config` 的尾巴没有并入 `config/menu`；
  - 差额来源：`admin`（1981 行）拆 2 片、`arena`（2705 行）拆 3 片、`command`（3876 行，含 1 个 oversized）拆 3 片、`config/menu`（2062 行）拆 2 片、`mechanics`（5119 行）拆 4 片，以及 5 个单目录组（`diagnostic`/`doc`/`gui`/`stats` 等）各自 1 片。若把 `admin/gui`、`config/menu` 并回父目录重新排序装箱可得 24 片，但那会改变任务书 §3.1 明列的「按目录分组」边界，故本产物按字面分组执行，并把偏差显式记录在此，交由主 Agent 决定是否合并。

## 2. 入口点（证据均来自本回合读取的 `plugin.yml` 与主类前 310 行）

| entry_id | kind | location | 摘要 |
|---|---|---|---|
| entry-plugin-enable | PLUGIN_LIFECYCLE | `HilltopVillagePlugin.java:94` | `onEnable()`：装配共享管理器、多竞技场、监听器、命令 |
| entry-plugin-disable | PLUGIN_LIFECYCLE | `HilltopVillagePlugin.java:228` | `onDisable()`：停任务、还原 tab、清竞技场、回滚地图 |
| entry-command-declared | COMMAND | `src/main/resources/plugin.yml:10` | `commands:` 声明 `hilltop`（别名 `hv`/`htv`）、`hub`、`lobby` |
| entry-command-register | COMMAND | `HilltopVillagePlugin.java:210` | `registerCommandHooks("hilltop"/"hub"/"lobby", tabCompleter)` |
| entry-tab-complete | TAB_COMPLETE | `HilltopVillagePlugin.java:210` | `HilltopTabCompleter` 实例注册为三条命令的补全器 |
| entry-event-listener | EVENT_LISTENER | `HilltopVillagePlugin.java:186` | `registerEvents(this, this)`，另有 10 余处监听器注册（186–207 行） |

- `SCHEDULED_TASK`：主类前 310 行内**未发现** `runTaskTimer` / `runTaskLater` / `runTaskAsynchronously` 的直接调用（仅在注释里提到 `ArenaInstance` 结算会 `runTaskTimer`）。调度实际发生在 `TabListManager.start()`、`FireballListener`、`ArenaResetService` 等被委托类内部，本回合未读这些文件，故按 `NO_ENTRY_FOUND` 记入 `unverified`，不臆造入口。
- 入口点 6 条，未达 20 条截断阈值，`entry_points_truncated: false`。

## 3. 排除项（exclusion_report 依据）

统计方式：文件系统枚举（排除 `target/` 构建产物），只计数、不读内容。

| 类型 | 数量 | 处置 |
|---|---|---|
| `.java` | 225 总 | 纳入 75（`src/main/java`，100% 入片）；排除 150 = `src/test/java` 101（测试源）+ `.work/` 49（历史修复快照） |
| `.md` | 62 | 文档，不纳入 |
| `.yml` | 16 | 配置，不纳入（`plugin.yml` 仅作为入口证据读取，不入片） |
| `.txt` | 12 | 文档/日志，不纳入 |
| `.log` | 86 | 运行日志，不纳入 |
| `.jar` | 10 | 二进制依赖，不纳入 |
| `.json` | 5 | 配置，不纳入 |
| `.mjs` | 1 | 默认本应纳入，但唯一实例在 `.work/fix-critical/`（历史快照），不纳入并登记 `AMBIGUOUS_TYPE` |
| 无扩展名 | 9 | `LICENSE`、`NOTICE`、`.work/round1/START-F1..F7`，非源码/历史快照，不纳入 |
| 其他 | `.png`/`.xml`/`.cmd`/`.sh`/`.config`/`.sha256`/`.gitignore`/`.gitattributes` | 资源或构建元数据，不纳入 |

- `exclusion_dominant: true`：被排除的 `.java` 有 150 个，超过 `included_files × 0.2 = 15`。原因是测试源与历史修复快照体量大，**不是**产品代码漏审——`src/main/java` 的 75 个文件已全部进入切片。
- `.work/round1/`（185 个文件，其中 49 个 `.java`）是历史修复快照，按任务书要求整体排除，不参与本轮审计。

## 4. 覆盖探针与独立性校验

- 覆盖探针：`all_source_files`（`src/main/java` 下 75 个 `.java`）− `sliced_files`（26 片并集）= **空集**，无 `ORPHAN_FILE`。
- 独立性校验：26 个切片的 `files` 两两不相交（校验器会机械复核 `slice_overlap`）；`shared_dependencies` 因未做源码引用分析而全部留空，不虚构共享文件。
- 未读源码：除 `plugin.yml` 与主类前 310 行外，未读取 `src/main/java` 下任何 `.java`；切片所需行数全部取自 `inventory.txt`。

## 5. 未验证项

见 JSON 信封 `payload.unverified`（覆盖 `READ_FAILED` / `AMBIGUOUS_TYPE` / `ORPHAN_FILE` / `NO_ENTRY_FOUND` / `TRUNCATED` 五类）。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "recon-01",
  "role": "recon",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:\\Projects\\AI prompt\\many-agents_multi-prompt-files_token-heavy\\multi-agent-audit-framework\\.run-dsh3\\artifacts\\round1-01-recon-slices.md",
  "payload": {
    "slice_count": 26,
    "audit_slices": [
      {
        "slice_id": "slice-01",
        "files": [
          "src/main/java/com/hilltopvillage/admin/AdminDeployManager.java",
          "src/main/java/com/hilltopvillage/admin/ArenaAdminService.java",
          "src/main/java/com/hilltopvillage/admin/ArenaResetService.java"
        ],
        "file_count": 3,
        "line_count": 2290,
        "root_dir": "src/main/java/com/hilltopvillage/admin",
        "rationale": "admin 目录按文件名序顺序装箱的前三文件，合计 1778 行（≤1800）；三者同属竞技场管理/部署服务层，共享 admin 包上下文，构成独立工作单元。",
        "is_entry_slice": false,
        "shared_dependencies": [],
        "oversized_file": false,
        "undersized": true,
        "reachability_hint": "PROD"
      },
      {
        "slice_id": "slice-02",
        "files": [
          "src/main/java/com/hilltopvillage/admin/LocationParticlePreview.java",
          "src/main/java/com/hilltopvillage/admin/PointKind.java",
          "src/main/java/com/hilltopvillage/admin/PointParticleRenderer.java"
        ],
        "file_count": 3,
        "line_count": 277,
        "root_dir": "src/main/java/com/hilltopvillage/admin",
        "rationale": "admin 组装箱后的剩余尾巴（203 行）；并回 slice-01 会达 1981 行超过 1800，故单独成片，不跨组塞入 admin/gui。",
        "is_entry_slice": false,
        "shared_dependencies": [],
        "oversized_file": false,
        "undersized": true,
        "reachability_hint": "PROD"
      },
      {
        "slice_id": "slice-03",
        "files": [
          "src/main/java/com/hilltopvillage/admin/gui/AbstractAdminMenu.java",
          "src/main/java/com/hilltopvillage/admin/gui/ArenaManageGUI.java"
        ],
        "file_count": 2,
        "line_count": 1116,
        "root_dir": "src/main/java/com/hilltopvillage/admin/gui",
        "rationale": "admin/gui 子目录全部文件：抽象菜单基类 + 竞技场管理 GUI，同属管理界面，916 行。",
        "is_entry_slice": false,
        "shared_dependencies": [],
        "oversized_file": false,
        "undersized": true,
        "reachability_hint": "PROD"
      },
      {
        "slice_id": "slice-04",
        "files": [
          "src/main/java/com/hilltopvillage/ai/AirdropSpawnGoal.java",
          "src/main/java/com/hilltopvillage/ai/DropperAttackGoal.java",
          "src/main/java/com/hilltopvillage/ai/ExplodeBeetleGoal.java",
          "src/main/java/com/hilltopvillage/ai/HookClawHunterGoal.java",
          "src/main/java/com/hilltopvillage/ai/NodeAttackGoal.java"
        ],
        "file_count": 5,
        "line_count": 1414,
        "root_dir": "src/main/java/com/hilltopvillage/ai",
        "rationale": "ai 目录全部怪物 AI Goal，同一套实体行为抽象，1122 行。",
        "is_entry_slice": false,
        "shared_dependencies": [],
        "oversized_file": false,
        "undersized": false,
        "reachability_hint": "PROD"
      },
      {
        "slice_id": "slice-05",
        "files": [
          "src/main/java/com/hilltopvillage/arena/ArenaDefinition.java",
          "src/main/java/com/hilltopvillage/arena/ArenaInstance.java"
        ],
        "file_count": 2,
        "line_count": 1872,
        "root_dir": "src/main/java/com/hilltopvillage/arena",
        "rationale": "arena 组前两文件：竞技场定义与其运行时实例，定义→实例是同一状态模型的两端，1414 行。",
        "is_entry_slice": false,
        "shared_dependencies": [],
        "oversized_file": false,
        "undersized": true,
        "reachability_hint": "PROD"
      },
      {
        "slice_id": "slice-06",
        "files": [
          "src/main/java/com/hilltopvillage/arena/ArenaManager.java",
          "src/main/java/com/hilltopvillage/arena/ArenaRegistry.java",
          "src/main/java/com/hilltopvillage/arena/ArenaStatus.java",
          "src/main/java/com/hilltopvillage/arena/IArena.java"
        ],
        "file_count": 4,
        "line_count": 1230,
        "root_dir": "src/main/java/com/hilltopvillage/arena",
        "rationale": "arena 组管理侧：管理器、注册表、状态枚举与接口，962 行；与 slice-05 按行数上限切开。",
        "is_entry_slice": false,
        "shared_dependencies": [],
        "oversized_file": false,
        "undersized": true,
        "reachability_hint": "PROD"
      },
      {
        "slice_id": "slice-07",
        "files": [
          "src/main/java/com/hilltopvillage/arena/MultiArenaManager.java"
        ],
        "file_count": 1,
        "line_count": 1154,
        "root_dir": "src/main/java/com/hilltopvillage/arena",
        "rationale": "arena 组排序末位的 MultiArenaManager；并回 slice-06 会达 1871 行超过 1800，故单独成片（非 oversized）。",
        "is_entry_slice": false,
        "shared_dependencies": [],
        "oversized_file": false,
        "undersized": true,
        "reachability_hint": "PROD"
      },
      {
        "slice_id": "slice-08",
        "files": [
          "src/main/java/com/hilltopvillage/command/ArenaCommand.java",
          "src/main/java/com/hilltopvillage/command/DeployMenuSender.java",
          "src/main/java/com/hilltopvillage/command/HilltopCommandHandler.java"
        ],
        "file_count": 3,
        "line_count": 2110,
        "root_dir": "src/main/java/com/hilltopvillage/command",
        "rationale": "command 组前三文件：/hilltop 主处理器与竞技场子命令、部署菜单发送器，命令入口面集中在此，1747 行。",
        "is_entry_slice": true,
        "shared_dependencies": [],
        "oversized_file": false,
        "undersized": true,
        "reachability_hint": "ENTRY"
      },
      {
        "slice_id": "slice-09",
        "files": [
          "src/main/java/com/hilltopvillage/command/HilltopTabCompleter.java"
        ],
        "file_count": 1,
        "line_count": 210,
        "root_dir": "src/main/java/com/hilltopvillage/command",
        "rationale": "命令补全器单独成片：它是 TAB_COMPLETE 入口的实现类；并回 slice-08 会达 1924 行超过 1800。",
        "is_entry_slice": true,
        "shared_dependencies": [],
        "oversized_file": false,
        "undersized": true,
        "reachability_hint": "ENTRY"
      },
      {
        "slice_id": "slice-10",
        "files": [
          "src/main/java/com/hilltopvillage/command/SetupWizard.java"
        ],
        "file_count": 1,
        "line_count": 2287,
        "root_dir": "src/main/java/com/hilltopvillage/command",
        "rationale": "该文件自身超出切片上限，无法与其他文件合并：SetupWizard.java 1952 行 > 1800，按规则单文件成片并标 oversized_file。",
        "is_entry_slice": false,
        "shared_dependencies": [],
        "oversized_file": true,
        "undersized": false,
        "reachability_hint": "PROD"
      },
      {
        "slice_id": "slice-11",
        "files": [
          "src/main/java/com/hilltopvillage/config/ConfigManager.java",
          "src/main/java/com/hilltopvillage/config/ConfigPermission.java"
        ],
        "file_count": 2,
        "line_count": 2155,
        "root_dir": "src/main/java/com/hilltopvillage/config",
        "rationale": "config 组前两文件：配置管理器 + 权限常量，1744 行；再加 DisplayConfig 会超 1800，故在此断开。",
        "is_entry_slice": false,
        "shared_dependencies": [],
        "oversized_file": false,
        "undersized": true,
        "reachability_hint": "PROD"
      },
      {
        "slice_id": "slice-12",
        "files": [
          "src/main/java/com/hilltopvillage/config/DisplayConfig.java",
          "src/main/java/com/hilltopvillage/config/DisplayConfigLoader.java",
          "src/main/java/com/hilltopvillage/config/GameConfig.java"
        ],
        "file_count": 3,
        "line_count": 1658,
        "root_dir": "src/main/java/com/hilltopvillage/config",
        "rationale": "config 组剩余文件：display.yml 模型/加载器与游戏规则配置，1407 行。",
        "is_entry_slice": false,
        "shared_dependencies": [],
        "oversized_file": false,
        "undersized": true,
        "reachability_hint": "PROD"
      },
      {
        "slice_id": "slice-13",
        "files": [
          "src/main/java/com/hilltopvillage/config/menu/AbstractConfigMenu.java",
          "src/main/java/com/hilltopvillage/config/menu/GameRulesMenu.java",
          "src/main/java/com/hilltopvillage/config/menu/ItemSettingsMenu.java",
          "src/main/java/com/hilltopvillage/config/menu/MainConfigMenu.java",
          "src/main/java/com/hilltopvillage/config/menu/MonsterSettingsMenu.java",
          "src/main/java/com/hilltopvillage/config/menu/NodeSettingsMenu.java",
          "src/main/java/com/hilltopvillage/config/menu/NumericInputHandler.java"
        ],
        "file_count": 7,
        "line_count": 1694,
        "root_dir": "src/main/java/com/hilltopvillage/config/menu",
        "rationale": "config/menu 子目录按文件名序前 7 个文件：菜单基类、各设置菜单与数字输入处理，1421 行。",
        "is_entry_slice": false,
        "shared_dependencies": [],
        "oversized_file": false,
        "undersized": false,
        "reachability_hint": "PROD"
      },
      {
        "slice_id": "slice-14",
        "files": [
          "src/main/java/com/hilltopvillage/config/menu/WaveSettingsMenu.java"
        ],
        "file_count": 1,
        "line_count": 738,
        "root_dir": "src/main/java/com/hilltopvillage/config/menu",
        "rationale": "config/menu 组排序末位的波次设置菜单；并回 slice-13 会达 2062 行超过 1800，故单独成片。",
        "is_entry_slice": false,
        "shared_dependencies": [],
        "oversized_file": false,
        "undersized": true,
        "reachability_hint": "PROD"
      },
      {
        "slice_id": "slice-15",
        "files": [
          "src/main/java/com/hilltopvillage/core/GameManager.java",
          "src/main/java/com/hilltopvillage/core/GameState.java",
          "src/main/java/com/hilltopvillage/HilltopVillagePlugin.java",
          "src/main/java/com/hilltopvillage/core/PlayerData.java",
          "src/main/java/com/hilltopvillage/core/PlayerGoodsManager.java"
        ],
        "file_count": 5,
        "line_count": 2225,
        "root_dir": "src/main/java/com/hilltopvillage/core",
        "rationale": "core 组按文件名序装箱（根目录主类按任务书归入 core）：对局管理、状态、插件主类、玩家数据与物品快照管理，1710 行；含 PLUGIN_LIFECYCLE 与事件注册入口。",
        "is_entry_slice": true,
        "shared_dependencies": [],
        "oversized_file": false,
        "undersized": false,
        "reachability_hint": "ENTRY"
      },
      {
        "slice_id": "slice-16",
        "files": [
          "src/main/java/com/hilltopvillage/core/WaveManager.java"
        ],
        "file_count": 1,
        "line_count": 1140,
        "root_dir": "src/main/java/com/hilltopvillage/core",
        "rationale": "core 组末位 WaveManager；并回 slice-15 会达 2613 行超过 1800，故单独成片。",
        "is_entry_slice": false,
        "shared_dependencies": [],
        "oversized_file": false,
        "undersized": true,
        "reachability_hint": "PROD"
      },
      {
        "slice_id": "slice-17",
        "files": [
          "src/main/java/com/hilltopvillage/diagnostic/TpsDiagnostic.java"
        ],
        "file_count": 1,
        "line_count": 120,
        "root_dir": "src/main/java/com/hilltopvillage/diagnostic",
        "rationale": "diagnostic 目录唯一文件，101 行；无同组文件可合并，且不得跨模块拼接，故单独成片。",
        "is_entry_slice": false,
        "shared_dependencies": [],
        "oversized_file": false,
        "undersized": true,
        "reachability_hint": "PROD"
      },
      {
        "slice_id": "slice-18",
        "files": [
          "src/main/java/com/hilltopvillage/doc/CommandsDocumentGenerator.java"
        ],
        "file_count": 1,
        "line_count": 598,
        "root_dir": "src/main/java/com/hilltopvillage/doc",
        "rationale": "doc 目录唯一文件（命令文档生成器），490 行；单独成片。",
        "is_entry_slice": false,
        "shared_dependencies": [],
        "oversized_file": false,
        "undersized": true,
        "reachability_hint": "PROD"
      },
      {
        "slice_id": "slice-19",
        "files": [
          "src/main/java/com/hilltopvillage/gui/ArenaSelectionGUI.java"
        ],
        "file_count": 1,
        "line_count": 339,
        "root_dir": "src/main/java/com/hilltopvillage/gui",
        "rationale": "gui 目录唯一文件（竞技场选择界面），276 行；单独成片。",
        "is_entry_slice": false,
        "shared_dependencies": [],
        "oversized_file": false,
        "undersized": true,
        "reachability_hint": "PROD"
      },
      {
        "slice_id": "slice-20",
        "files": [
          "src/main/java/com/hilltopvillage/mechanics/ArenaAccessListener.java",
          "src/main/java/com/hilltopvillage/mechanics/ArenaScoreboard.java",
          "src/main/java/com/hilltopvillage/mechanics/FireballListener.java",
          "src/main/java/com/hilltopvillage/mechanics/FriendlyFireListener.java",
          "src/main/java/com/hilltopvillage/mechanics/HammerEffectRenderer.java"
        ],
        "file_count": 5,
        "line_count": 1920,
        "root_dir": "src/main/java/com/hilltopvillage/mechanics",
        "rationale": "mechanics 组按文件名序前 5 个文件：准入/友伤/火球监听器、计分板与锤特效渲染，1496 行；再加 HammerListener 会超 1800。",
        "is_entry_slice": false,
        "shared_dependencies": [],
        "oversized_file": false,
        "undersized": false,
        "reachability_hint": "PROD"
      },
      {
        "slice_id": "slice-21",
        "files": [
          "src/main/java/com/hilltopvillage/mechanics/HammerListener.java",
          "src/main/java/com/hilltopvillage/mechanics/LobbyProtectionListener.java",
          "src/main/java/com/hilltopvillage/mechanics/MapRestoreManager.java",
          "src/main/java/com/hilltopvillage/mechanics/NodeListener.java"
        ],
        "file_count": 4,
        "line_count": 2008,
        "root_dir": "src/main/java/com/hilltopvillage/mechanics",
        "rationale": "mechanics 组第二片：锤/节点监听器、大厅保护与地图回滚管理，1624 行。",
        "is_entry_slice": false,
        "shared_dependencies": [],
        "oversized_file": false,
        "undersized": true,
        "reachability_hint": "PROD"
      },
      {
        "slice_id": "slice-22",
        "files": [
          "src/main/java/com/hilltopvillage/mechanics/NodeSystem.java",
          "src/main/java/com/hilltopvillage/mechanics/PlayerLifecycleListener.java",
          "src/main/java/com/hilltopvillage/mechanics/TabListManager.java",
          "src/main/java/com/hilltopvillage/mechanics/VillagerPreviewManager.java"
        ],
        "file_count": 4,
        "line_count": 2196,
        "root_dir": "src/main/java/com/hilltopvillage/mechanics",
        "rationale": "mechanics 组第三片：节点系统、玩家生命周期、tab 栏与村民预览管理，1726 行；再加 VillagerSystem 会超 1800。",
        "is_entry_slice": false,
        "shared_dependencies": [],
        "oversized_file": false,
        "undersized": true,
        "reachability_hint": "PROD"
      },
      {
        "slice_id": "slice-23",
        "files": [
          "src/main/java/com/hilltopvillage/mechanics/VillagerSystem.java"
        ],
        "file_count": 1,
        "line_count": 356,
        "root_dir": "src/main/java/com/hilltopvillage/mechanics",
        "rationale": "mechanics 组末位 VillagerSystem；并回 slice-22 会达 1999 行超过 1800，故单独成片。",
        "is_entry_slice": false,
        "shared_dependencies": [],
        "oversized_file": false,
        "undersized": true,
        "reachability_hint": "PROD"
      },
      {
        "slice_id": "slice-24",
        "files": [
          "src/main/java/com/hilltopvillage/shop/NpcManager.java",
          "src/main/java/com/hilltopvillage/shop/ShopConfig.java",
          "src/main/java/com/hilltopvillage/shop/ShopConfigLoader.java",
          "src/main/java/com/hilltopvillage/shop/ShopGUI.java",
          "src/main/java/com/hilltopvillage/shop/ShopItem.java",
          "src/main/java/com/hilltopvillage/shop/ShopListener.java",
          "src/main/java/com/hilltopvillage/shop/ShopManager.java"
        ],
        "file_count": 7,
        "line_count": 1579,
        "root_dir": "src/main/java/com/hilltopvillage/shop",
        "rationale": "shop 目录全部文件：NPC、配置模型/加载器、GUI、商品、监听器与管理器，1255 行。",
        "is_entry_slice": false,
        "shared_dependencies": [],
        "oversized_file": false,
        "undersized": false,
        "reachability_hint": "PROD"
      },
      {
        "slice_id": "slice-25",
        "files": [
          "src/main/java/com/hilltopvillage/stats/StatsManager.java"
        ],
        "file_count": 1,
        "line_count": 687,
        "root_dir": "src/main/java/com/hilltopvillage/stats",
        "rationale": "stats 目录唯一文件（统计管理器），516 行；单独成片。",
        "is_entry_slice": false,
        "shared_dependencies": [],
        "oversized_file": false,
        "undersized": true,
        "reachability_hint": "PROD"
      },
      {
        "slice_id": "slice-26",
        "files": [
          "src/main/java/com/hilltopvillage/util/DisplayEntityManager.java",
          "src/main/java/com/hilltopvillage/util/LanguageManager.java",
          "src/main/java/com/hilltopvillage/util/MessageTextSync.java",
          "src/main/java/com/hilltopvillage/util/SafeSpawnUtil.java",
          "src/main/java/com/hilltopvillage/util/YamlFileGate.java",
          "src/main/java/com/hilltopvillage/util/YamlFiles.java"
        ],
        "file_count": 6,
        "line_count": 1581,
        "root_dir": "src/main/java/com/hilltopvillage/util",
        "rationale": "util 目录全部文件：显示实体、语言、消息同步、安全生成与 YAML 工具，1257 行。",
        "is_entry_slice": false,
        "shared_dependencies": [],
        "oversized_file": false,
        "undersized": false,
        "reachability_hint": "PROD"
      }
    ],
    "unverified": [
      {
        "target": "plugin.yml",
        "reason": "READ_FAILED",
        "detail": "任务书给的仓库根路径下没有 plugin.yml（读取返回 not found）；实际入口声明位于 src/main/resources/plugin.yml，本回合已改读该文件并取得 commands 段原文，故 COMMAND 入口不受影响。"
      },
      {
        "target": ".work/fix-critical/gen-messages-legacy.mjs",
        "reason": "AMBIGUOUS_TYPE",
        "detail": "扩展名 .mjs 在默认纳入清单内，但仓库中唯一实例位于 .work/ 历史修复快照目录，按排除策略不纳入切片；若需审计该脚本需单列任务。"
      },
      {
        "target": "src/main/java",
        "reason": "ORPHAN_FILE",
        "detail": "覆盖探针通过：src/main/java 下 75 个 .java 全部进入 26 个切片，无孤儿文件（75/75）。"
      },
      {
        "target": "SCHEDULED_TASK",
        "reason": "NO_ENTRY_FOUND",
        "detail": "主类前 310 行内未发现 runTaskTimer / runTaskLater / runTaskAsynchronously 的直接调用；调度由 TabListManager.start()、FireballListener、ArenaResetService 等被委托类内部发起，这些文件本回合未读，故不登记具体调度入口。"
      },
      {
        "target": "entry_points",
        "reason": "TRUNCATED",
        "detail": "入口点共 6 条，未达 20 条截断阈值，entry_points_truncated=false；但主类 @EventHandler 方法体位于第 310 行之后、本回合未读取，事件入口仅按 registerEvents 注册点登记，未逐方法验证。"
      },
      {
        "target": "payload.audit_slices[].shared_dependencies",
        "reason": "TRUNCATED",
        "detail": "本回合未读源码、未做跨文件引用分析，无法判定共享类型/工具类归属，故所有切片 shared_dependencies 一律留空数组（不虚构），共享依赖需波次二在切片内确认。"
      }
    ],
    "exclusion_report": {
      "included_files": 75,
      "excluded_by_type": {
        ".java": {
          "count": 150,
          "reason": "src/test/java 测试源 101 个 + .work/ 历史修复快照 49 个，均不纳入；src/main/java 的 75 个产品源文件已全部入片"
        },
        ".md": {
          "count": 62,
          "reason": "文档，非源码（合理）"
        },
        ".yml": {
          "count": 16,
          "reason": "配置，非源码；plugin.yml 仅作入口证据读取（合理）"
        },
        ".txt": {
          "count": 12,
          "reason": "文档/日志，非源码（合理）"
        },
        ".log": {
          "count": 86,
          "reason": "运行日志（合理）"
        },
        ".jar": {
          "count": 10,
          "reason": "二进制依赖（合理）"
        },
        ".json": {
          "count": 5,
          "reason": "配置/元数据（合理）"
        },
        "no-extension": {
          "count": 9,
          "reason": "LICENSE、NOTICE 与 .work/round1/START-F1..F7 历史快照标记（合理）"
        }
      },
      "excluded_source_like": [
        {
          "ext": ".mjs",
          "count": 1,
          "reason": "默认清单应纳入，但唯一实例在 .work/fix-critical/ 历史修复快照内，未确认是否需要审计"
        }
      ],
      "exclusion_dominant": true,
      "dominant_threshold_note": "任一被排除类型数 > included_files × 0.2（=15）时置 true；此处 .java 排除 150 个（测试 101 + 快照 49）触发，但 src/main/java 产品代码覆盖率为 75/75，无静默漏审。"
    },
    "entry_points": [
      {
        "entry_id": "entry-plugin-enable",
        "kind": "PLUGIN_LIFECYCLE",
        "location": "src/main/java/com/hilltopvillage/HilltopVillagePlugin.java:94",
        "trigger": "Bukkit 加载并启用插件时调用 onEnable",
        "next_hop": "src/main/java/com/hilltopvillage/arena/MultiArenaManager.java (loadArenaDefinitions) 及同方法内的 registerEvents 注册",
        "evidence_quote": "@Override\n    public void onEnable() {\n        saveDefaultConfig();"
      },
      {
        "entry_id": "entry-plugin-disable",
        "kind": "PLUGIN_LIFECYCLE",
        "location": "src/main/java/com/hilltopvillage/HilltopVillagePlugin.java:228",
        "trigger": "服务器停服或插件禁用时调用 onDisable",
        "next_hop": "同文件 fireballListener.shutdown() → tabListManager.stop() → multiArenaManager.shutdown() → mapRestoreManager.restoreAllNow()",
        "evidence_quote": "@Override\n    public void onDisable() {\n        // 先停止烈焰蛋的共享任务并移除受追踪投射物，避免竞技场清理期间继续触发命中逻辑"
      },
      {
        "entry_id": "entry-command-declared",
        "kind": "COMMAND",
        "location": "src/main/resources/plugin.yml:10",
        "trigger": "玩家或控制台执行 /hilltop（别名 /hv、/htv）、/hub、/lobby",
        "next_hop": "src/main/java/com/hilltopvillage/command/HilltopCommandHandler.java（executor 由主类 registerCommandHooks 注册，plugin.yml 不写 executor 字段）",
        "evidence_quote": "commands:\n  hilltop:\n    description: Main command for Hilltop Village plugin\n    usage: /hilltop <start|stop|join|leave|lobby|status|list|arenas|manage|enable|disable|hammer|fireball|help|setup|deploy|config|reloadconfig|shop|lang|tps|gui|build|stats|top|wave>\n    aliases: [hv, htv]"
      },
      {
        "entry_id": "entry-command-register",
        "kind": "COMMAND",
        "location": "src/main/java/com/hilltopvillage/HilltopVillagePlugin.java:210",
        "trigger": "onEnable 期间把 executor/completer 挂到三条已声明命令上",
        "next_hop": "src/main/java/com/hilltopvillage/command/HilltopTabCompleter.java；/hilltop 分支进入 HilltopCommandHandler",
        "evidence_quote": "        // Register tab completer\n        registerCommandHooks(\"hilltop\", tabCompleter);\n        // 顶层快捷命令 /hub 与 /lobby（等价 /hilltop lobby；/lobby setspawn 走管理员）\n        registerCommandHooks(\"hub\", tabCompleter);\n        registerCommandHooks(\"lobby\", tabCompleter);"
      },
      {
        "entry_id": "entry-tab-complete",
        "kind": "TAB_COMPLETE",
        "location": "src/main/java/com/hilltopvillage/HilltopVillagePlugin.java:210",
        "trigger": "玩家在 /hilltop、/hub、/lobby 上按 Tab 触发补全",
        "next_hop": "src/main/java/com/hilltopvillage/command/HilltopTabCompleter.java",
        "evidence_quote": "        this.tabCompleter = new HilltopTabCompleter(this);"
      },
      {
        "entry_id": "entry-event-listener",
        "kind": "EVENT_LISTENER",
        "location": "src/main/java/com/hilltopvillage/HilltopVillagePlugin.java:186",
        "trigger": "Bukkit 事件分发（主类实现 Listener，含 PlayerJoinEvent/PlayerQuitEvent/EntityDeathEvent/ProjectileHitEvent 等导入）",
        "next_hop": "同文件 @EventHandler 方法（第 310 行之后未读取，未验证具体方法位置）；以及 186–207 行注册的 setupWizard/hammerListener/nodeListener/fireballListener 等",
        "evidence_quote": "        // Register listeners\n        Bukkit.getPluginManager().registerEvents(this, this);"
      }
    ],
    "entry_points_truncated": false,
    "covered_modules": [
      "admin",
      "admin/gui",
      "ai",
      "arena",
      "command",
      "config",
      "config/menu",
      "core",
      "diagnostic",
      "doc",
      "gui",
      "mechanics",
      "shop",
      "stats",
      "util"
    ],
    "harness_concurrency_cap": null
  },
  "error": null
}
```
