# round1-03 锐评 · Devil's Advocate（覆盖完整性攻击）

- **子角色**：`devils_advocate`（唯一职责：攻击审计波次的**覆盖完整性**，不评单条发现）
- **输入**：`round1-01-recon-slices.md`（26 切片 / 75 文件）、`round1-02-sweep-*.md`（26 份宽扫）、10 份深挖产物、`audit-summary.md`
- **`verdicts`**：`[]`（本子角色不产出裁决，契约要求）

---

## 1. 集合差：切片 × 文件 × 维度

### 1.1 切片级：0 条真空缺口（附算术，可机械复核）

宽扫 `files_read` 的 `"path":` 条目共 **79 条**（一次 grep 覆盖全部 26 份 sweep 产物）。其中 4 条是跨片重复登记，故去重后 **75 个唯一文件**：

| 重复登记的文件 | 出现在 |
|---|---|
| `command/HilltopCommandHandler.java` | slice-08、slice-09、slice-25 |
| `config/menu/AbstractConfigMenu.java` | slice-13、slice-14 |
| `mechanics/NodeListener.java` | slice-21、slice-22 |

复算：79 − (3−1) − (2−1) − (2−1) = 79 − 2 − 1 − 1 = **75**，与 recon 的「75 文件」逐片吻合（每片的 `路径数` 与 recon 表 `文件数` 列完全相等：admin 3/3、admin/gui 2、ai 5、arena 2/4/1、command 3/1/1、config 2/3、config/menu 7/1、core 5/1、diagnostic 1、doc 1、gui 1、mechanics 5/4/4/1、shop 7、stats 1、util 6）。

结论：**不存在「覆盖了但未实际读取」的文件，也不存在零覆盖的切片**。因此本报告**不产出** `SLICE_UNCOVERED` 与 `FILE_UNREAD` —— 编造这两类缺口会直接违反任务书 §2.2「不得编造缺口」。真正的缺口全部落在**维度**与**入口**两层。

### 1.2 维度级：这是真正的塌陷面

深挖只覆盖 **10/26 片**（01/05/08/11/13/15/20/21/24/26），10/156 个「切片×维度」组合 = **6.4%**。逐维度统计（依据 26 份 sweep 的 `leads` 表 + 10 份深挖的 `confirmed`）：

| 维度 | 宽扫线索数 | 深挖过的片 | 深挖片数 |
|---|---|---|---|
| data-consistency | 48 | 01/05/11/24/26 | 5 |
| error-handling | 27 | 08 | 1 |
| contract | 26 | 13 | 1 |
| logic | **28** | — | **0** |
| concurrency | 14 | 15/20/21 | 3 |
| security | **4** | — | **0** |

（线索数为按 `audit-summary.md` 线索表 dim 列逐行计数；security 的 4 条为 slice-03 L4、slice-20 L5、slice-23 L4、slice-24 L3。）

两条硬事实：

1. **`logic` 有 28 条线索、其中 1 条 HIGH，深挖 0 次。** 已确认的 24 条 finding 里 logic 维度 **0 条**——这不是「仓库没有逻辑缺陷」，而是该维度从未被任何切片深挖过。宽扫把 HIGH 级线索（`ai/ExplodeBeetleGoal.java:243` NaN 穿透 `Math.max`）留在桌上没人接。
2. **`security` 全仓只有 4 条线索、深挖 0 次。** 权限节点在补全侧与分发侧各写一套（`command/HilltopTabCompleter.java:70` 用 `hilltopvillage.admin`，`command/HilltopCommandHandler.java:389` 的 `case "config"` 用 `hilltopvillage.config.admin`），这条**权限一致性**问题被当作 `contract` 线索记录，从未以 security 视角核验；`mechanics/VillagerSystem.java:276` 的「刷怪蛋造合法伤害源」是 4 条里唯一玩家可利用路径，同样未深挖。

### 1.3 入口级

`registerEvents\(` 在 `src/main/java` 命中 **31 处**：14 处在 `HilltopVillagePlugin`（生命周期一次性注册），**17 处在 GUI/菜单类内按次注册**（`command/HilltopCommandHandler.java:648`、`:666`；`config/menu/AbstractConfigMenu.java:61`；`config/menu/WaveSettingsMenu.java:101/183/264/288/307/405/421/544`；`gui/ArenaSelectionGUI.java:67` 等）。全仓**监听器注册集从未作为一个入口集合被审计**，只有 slice-03 L3 对 `:666` 一处做过单点观察，且 slice-03 未深挖、该线索今天仍是未验证状态。

---

## 2. pattern_sweep（轻量版：只做 1 个模式）

**起点发现**：`F-slice-15-concurrency-01`（HIGH，`core/PlayerGoodsManager.java:478`）——异步线程序列化含 `ItemStack` 的 Bukkit 配置对象。

**缺陷形态**（不是这条缺陷本身）：*把 Bukkit 对象的序列化/访问放到非主线程执行*。机械代理模式 = 一切异步入口。

**口径（必须带）**：
- 目录：`D:\Server\MCServers\Server plugin\Hilltop Village\Hilltop Village Plugin\src\main\java`（递归）
- 排除：`.work\`（历史快照，不在 `src/main/java` 内，结构上已排除）、`src/test`（不在 `src/main/java` 内，结构上已排除）
- 文件过滤：`*.java`
- grep 原文：`runTaskAsynchronously|runTaskTimerAsynchronously|CompletableFuture|new Thread`

**命中 4 处**（另：`CompletableFuture` 与 `new Thread` 两模式 **0 命中**，即本仓非主线程执行面只有 4 个调度器入口）。

| # | 位置 | 判定 | 依据（本回合逐字读到） |
|---|---|---|---|
| 1 | `core/PlayerGoodsManager.java:478` | **SAME_DEFECT**（本条即起点发现本身，非新增扩散点） | `:478` `Bukkit.getScheduler().runTaskAsynchronously(plugin, () -> writeYaml(yaml, seq));` → `writeYaml` 在 `:422` 执行 `payload = yaml.saveToString().getBytes(StandardCharsets.UTF_8);`，`yaml` 为含 `ItemStack` 的 `YamlConfiguration`，序列化确实落在异步线程。 |
| 2 | `stats/StatsManager.java:640` | **NOT_APPLICABLE** | `runTaskTimerAsynchronously` 起的 `flushAsync()` 在 `:661` 立刻 `Bukkit.getScheduler().runTask(plugin, () -> {` 跳回主线程，`:669` `final String content = buildSnapshot();` 在主线程完成序列化，异步只拿 `String`。 |
| 3 | `stats/StatsManager.java:673` | **NOT_APPLICABLE** | `:673` `Bukkit.getScheduler().runTaskAsynchronously(plugin, () -> writeAtomically(content, seq));` —— 捕获变量 `content` 是 `:669` 主线程构建的不可变 `String`，异步侧无任何 Bukkit 对象引用。 |
| 4 | `doc/CommandsDocumentGenerator.java:467` | **NOT_APPLICABLE** | `:465` `final String content = md.toString();`（`StringBuilder` 在主线程拼完），`:469` `writeAtomically(docFile.toPath(), content.getBytes(StandardCharsets.UTF_8),` 只传 `byte[]`；异步体内无 Bukkit 配置对象。该文件的问题在异常/降级路径（`F-slice-18` 系列），与本形态不同。 |

**结论**：该形态**未向东扩散**——4 个异步入口中只有 `PlayerGoodsManager:478` 把 Bukkit 序列化丢出主线程，另 3 处都做了「主线程序列化 → 异步纯文件写」的正确切分（`StatsManager` 甚至在 `:647` 注释里显式写了这条纪律）。这条结果**加强**而非削弱 `F-slice-15-concurrency-01`：同仓库已有两份正确实现作为对照，说明该缺陷是可避免的实现疏漏，不是架构约束。

**残留盲区（诚实披露）**：本模式只覆盖**调度器型**异步入口。事件型异步入口（`AsyncChatEvent`、`AsyncPlayerChatEvent`、异步预登录等）不经调度器，不在 4 条命中内；本仓库存在聊天输入型交互（`config/menu/NumericInputHandler`、`command/SetupWizard` 聊天步骤），若其中挂了 async 事件监听则本模式扫不到。该盲区已作为覆盖缺口登记（见 gap #10 的 next_action）。

---

## 3. coverage_gaps（11 条）

| # | kind | target | 一句话 |
|---|---|---|---|
| 1 | DIMENSION_OMITTED | slice-16/logic | WaveManager 903 行，L5 逻辑线索未验证 |
| 2 | DIMENSION_OMITTED | slice-22/concurrency | NodeSystem 双集合 check-then-act 未验证 |
| 3 | DIMENSION_OMITTED | slice-04/error-handling | ai 包 5 文件、2 条 HIGH 线索，EH 维度 0 深挖 |
| 4 | DIMENSION_OMITTED | slice-10/error-handling | 全仓最大切片，HIGH 级 fail-open 未深挖 |
| 5 | DIMENSION_OMITTED | slice-12/error-handling | 配置解析三处静默回落未深挖 |
| 6 | DIMENSION_OMITTED | slice-23/security | 唯一玩家可利用 security 线索未深挖 |
| 7 | DIMENSION_OMITTED | slice-18/concurrency | 单 JVM 锁 + 降级删写未深挖 |
| 8 | DIMENSION_OMITTED | security（全仓） | 4 条线索、0 次深挖，权限双源未核验 |
| 9 | DIMENSION_OMITTED | logic（全仓） | 28 条线索、0 次深挖，1 条 HIGH |
| 10 | ENTRY_UNCOVERED | 动态 registerEvents 入口（17 处） | 监听器注册集从未作为入口集审计 |
| 11 | DIMENSION_OMITTED | slice-02/error-handling | 世界未加载判据失效的 MEDIUM 线索未深挖 |

每条均给出文件名/行号/维度，可由第三方用一次 grep 或一次 read 复核。

---

## 4. 给主 Agent 的处置建议

1. **不必补扫切片**：26/26 片、75/75 文件已读全，宽扫层没有缺口。补的是**维度**，不是范围。
2. **优先级**：`logic`（28 条线索含 1 条 HIGH）> `security`（4 条线索、含 1 条玩家可利用）> 16 个未深挖片里带 HIGH 线索的 `slice-04` / `slice-10`。
3. **不要**把「logic 维度 0 条已确认」读成「无逻辑缺陷」——它只反映该维度从未被派发。
4. `F-slice-15-concurrency-01` 的 pattern_sweep 结果（3/4 命中点已正确切分）可作为**该发现成立的旁证**提交给 arbiter。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "critique-devils_advocate",
  "role": "critique",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:\\Projects\\AI prompt\\many-agents_multi-prompt-files_token-heavy\\multi-agent-audit-framework\\.run-dsh3\\artifacts\\round1-03-critique-devils-advocate.md",
  "payload": {
    "critique_role": "devils_advocate",
    "target_finding_ids": [],
    "verdicts": [],
    "coverage_gaps": [
      {
        "kind": "DIMENSION_OMITTED",
        "target": "slice-16/logic",
        "reason": "slice-16 只含 core/WaveManager.java（903 行），宽扫产出 6 条线索其中 L5 为 logic 类（:1130 所有候选被 continue 跳过时 best 仍停在 players.get(0)，随后 :1079 跨世界 teleport），但 slice-16 不在深挖名单（01/05/08/11/13/15/20/21/24/26）内，该逻辑缺陷至今只是未验证线索。",
        "next_action": "派发 slice-16/logic 深挖：先复核 :1130 的回退语义与 :1079 的 teleport 可达性，再顺带验证 :406/:435 静态清扫对 world.getEntities() 快照语义的依赖。",
        "recommended_action": "派发 slice-16/logic 深挖：先复核 :1130 的回退语义与 :1079 的 teleport 可达性，再顺带验证 :406/:435 静态清扫对 world.getEntities() 快照语义的依赖。"
      },
      {
        "kind": "DIMENSION_OMITTED",
        "target": "slice-22/concurrency",
        "reason": "slice-22 深挖只做了 data-consistency；其 L2（mechanics/NodeSystem.java:698，并发容器里的 NodeData 用普通 double/boolean，damageNode 跨两个集合做 isRegisteredActive 判定再改状态）是 concurrency 类线索，从未被验证或推翻。",
        "next_action": "派发 slice-22/concurrency 深挖：确认 NodeData 字段可见性、isRegisteredActive 的 check-then-act 窗口，以及 :180 载入期清理与 :831 周期任务体的交互。",
        "recommended_action": "派发 slice-22/concurrency 深挖：确认 NodeData 字段可见性、isRegisteredActive 的 check-then-act 窗口，以及 :180 载入期清理与 :831 周期任务体的交互。"
      },
      {
        "kind": "DIMENSION_OMITTED",
        "target": "slice-04/error-handling",
        "reason": "ai 包 5 文件 1122 行全部只有宽扫；2 条 HIGH 线索（AirdropSpawnGoal.java:107 跨世界 distanceSquared、ExplodeBeetleGoal.java:243 NaN 穿透 Math.max）均记为 logic，error-handling 维度对 slice-04 为 0 次深挖——而 Bukkit Goal 内未捕获异常会静默终止 AI，正是该维度的高价值面。",
        "next_action": "派发 slice-04/error-handling 深挖：核查 5 个 Goal 的 tick()/start() 是否有 try 边界，异常后 Goal 是否被 Bukkit 移除、怪物是否卡死。",
        "recommended_action": "派发 slice-04/error-handling 深挖：核查 5 个 Goal 的 tick()/start() 是否有 try 边界，异常后 Goal 是否被 Bukkit 移除、怪物是否卡死。"
      },
      {
        "kind": "DIMENSION_OMITTED",
        "target": "slice-10/error-handling",
        "reason": "command/SetupWizard.java 1952 行是全仓最大且唯一 oversized 切片，L4（:1175 四项必填复核在解析不到部署管理器时直接放行 true，随后清会话并 enableArena，HIGH）与 L6（:921 deploy() 可返回 null 而多处直接解引用）都属 error-handling，slice-10 未深挖。",
        "next_action": "派发 slice-10/error-handling 深挖，优先 :1175 的 fail-open 链路与 :921 的 null 解引用面；该切片体量建议拆两批读。",
        "recommended_action": "派发 slice-10/error-handling 深挖，优先 :1175 的 fail-open 链路与 :921 的 null 解引用面；该切片体量建议拆两批读。"
      },
      {
        "kind": "DIMENSION_OMITTED",
        "target": "slice-12/error-handling",
        "reason": "config/DisplayConfigLoader.java 有三处静默回落：:113 缺段时用出厂默认且不告警、:216 getString 把 Integer/Boolean 当 i18n 键、:372 缺 containsKey 判定使 when 空值与缺键同走 always（fail-open 与拼错条件名 fail-closed 相反）。slice-12 未深挖，这三处都停在线索状态。",
        "next_action": "派发 slice-12/error-handling 深挖，把三处静默回落与 GameConfig.java:645 defaultWave 无 null 守卫合并成一条「配置解析失败不可观测」的横切结论。",
        "recommended_action": "派发 slice-12/error-handling 深挖，把三处静默回落与 GameConfig.java:645 defaultWave 无 null 守卫合并成一条「配置解析失败不可观测」的横切结论。"
      },
      {
        "kind": "DIMENSION_OMITTED",
        "target": "slice-23/security",
        "reason": "mechanics/VillagerSystem.java:276 的白名单只认 instanceof Monster，玩家用刷怪蛋或指令生成的怪物同样被当作合法伤害源，可击杀受保护村民触发全灭失败（L4，MEDIUM，security）。这是全仓 4 条 security 线索中唯一玩家可利用路径，slice-23 未深挖。",
        "next_action": "派发 slice-23/security 深挖：确认伤害源是否可追溯到玩家（投掷者/生成原因），并评估其对局内经济与失败条件的实际影响。",
        "recommended_action": "派发 slice-23/security 深挖：确认伤害源是否可追溯到玩家（投掷者/生成原因），并评估其对局内经济与失败条件的实际影响。"
      },
      {
        "kind": "DIMENSION_OMITTED",
        "target": "slice-18/concurrency",
        "reason": "doc/CommandsDocumentGenerator.java 的串行化只有 static 锁（:523 区段），只覆盖同一 JVM；数据目录被两个服务端进程共享时非原子降级路径上的两次替换会互删目标文件（L1，concurrency，MEDIUM）。同文件 :568 只认 AtomicMoveNotSupportedException、:530 parent 为 null 抛 NPE 不在 IOException catch 内。slice-18 未深挖。",
        "next_action": "派发 slice-18/concurrency 深挖，把「跨进程互删」与「启动期一次性任务失败无重试、无日志」合并评估；注意该文件仅 490 行，成本很低。",
        "recommended_action": "派发 slice-18/concurrency 深挖，把「跨进程互删」与「启动期一次性任务失败无重试、无日志」合并评估；注意该文件仅 490 行，成本很低。"
      },
      {
        "kind": "DIMENSION_OMITTED",
        "target": "security（全仓，26 片横切）",
        "reason": "26 份宽扫合计只产出 4 条 security 线索（slice-03 L4、slice-20 L5、slice-23 L4、slice-24 L3），10 个深挖片的 security 深挖次数为 0，已确认 24 条 finding 中 security 维度 0 条。权限节点在补全侧（HilltopTabCompleter.java:70 用 hilltopvillage.admin）与分发侧（HilltopCommandHandler.java:389 的 case \"config\" 用 hilltopvillage.config.admin）双源维护，该不一致被登记为 contract 线索而非 security 缺口；GUI 破坏性动作的撤权后窗口（slice-03 L4）同样无人验证。",
        "next_action": "单开一轮 security 横切波次（不按切片、按攻击面）：权限节点全集矩阵（分发侧 × 补全侧 × plugin.yml）、破坏性动作的点击时复核、世界准入事件覆盖面（slice-20 L5 的 TeleportCause 缺口）。",
        "recommended_action": "单开一轮 security 横切波次（不按切片、按攻击面）：权限节点全集矩阵（分发侧 × 补全侧 × plugin.yml）、破坏性动作的点击时复核、世界准入事件覆盖面（slice-20 L5 的 TeleportCause 缺口）。"
      },
      {
        "kind": "DIMENSION_OMITTED",
        "target": "logic（全仓，26 片横切）",
        "reason": "宽扫合计 28 条 logic 线索，深挖 0 次，已确认 finding 中 logic 维度 0 条；其中含 1 条 HIGH（ai/ExplodeBeetleGoal.java:243，NaN 穿透 Math.max 后传入 damageNode）。同维度还有多条 MEDIUM（slice-04 L3/L4/L5、slice-19 L1/L3/L5、slice-14 L3/L5、slice-12 L1/L3）全部停在未验证状态。",
        "next_action": "按「HIGH 优先、跨片聚类」派发 logic 深挖：先 slice-04（2 条 HIGH/MEDIUM 同文件），再把「注释声明的契约与实现不符」聚成一类（slice-19 L3、slice-14 L3）批量验证。",
        "recommended_action": "按「HIGH 优先、跨片聚类」派发 logic 深挖：先 slice-04（2 条 HIGH/MEDIUM 同文件），再把「注释声明的契约与实现不符」聚成一类（slice-19 L3、slice-14 L3）批量验证。"
      },
      {
        "kind": "ENTRY_UNCOVERED",
        "target": "动态 registerEvents 入口集（17 处，全仓）",
        "reason": "grep registerEvents\\( 在 src/main/java 命中 31 处：14 处在 HilltopVillagePlugin 生命周期注册，17 处在 GUI/菜单类内按次注册（HilltopCommandHandler.java:648/:666、AbstractConfigMenu.java:61、WaveSettingsMenu.java:101/183/264/288/307/405/421/544、ArenaSelectionGUI.java:67 等）。全仓监听器注册集从未作为入口集合审计；slice-03 L3 只对 HilltopCommandHandler.java:666 一处做过单点观察（未见 unregisterAll，监听器随打开次数累积并持有 Player/Inventory），而 slice-03 本身未深挖，该线索至今未验证。",
        "next_action": "派发一次入口集审计：逐个确认 17 处动态注册的配对注销路径，并顺带核查事件型异步入口（AsyncChatEvent/AsyncPlayerChatEvent）是否存在于聊天输入链路——该面不在调度器型异步 grep 的覆盖内。",
        "recommended_action": "派发一次入口集审计：逐个确认 17 处动态注册的配对注销路径，并顺带核查事件型异步入口（AsyncChatEvent/AsyncPlayerChatEvent）是否存在于聊天输入链路——该面不在调度器型异步 grep 的覆盖内。"
      },
      {
        "kind": "DIMENSION_OMITTED",
        "target": "slice-02/error-handling",
        "reason": "admin/LocationParticlePreview.java:97 的注释声称覆盖「世界未加载」，但判据只有引用为 null，未加载世界的引用通常仍非 null，逐点绘制仍会走进 spawnParticle（L1，error-handling，MEDIUM）；同文件 :88 的任务清理只写在正常结束分支，drawMarker 抛异常即跳过 cancel，previewTasks 残留死任务（L4）。slice-02 未深挖。",
        "next_action": "派发 slice-02/error-handling 深挖（该片仅 203 行、3 文件，成本极低），验证世界未加载判据与 previewTasks 泄漏两条线索。",
        "recommended_action": "派发 slice-02/error-handling 深挖（该片仅 203 行、3 文件，成本极低），验证世界未加载判据与 previewTasks 泄漏两条线索。"
      }
    ],
    "pattern_sweep": {
      "performed": true,
      "patterns_checked": [
        {
          "from_finding": "F-slice-15-concurrency-01",
          "pattern": "非主线程执行 Bukkit 对象序列化/访问（形态代理：全部异步调度入口）——runTaskAsynchronously|runTaskTimerAsynchronously|CompletableFuture|new Thread",
          "grep_command": "grep -rnE \"runTaskAsynchronously|runTaskTimerAsynchronously|CompletableFuture|new Thread\" --include=*.java \"D:/Server/MCServers/Server plugin/Hilltop Village/Hilltop Village Plugin/src/main/java\"   # 口径：递归 src/main/java；排除 .work/ 与 src/test（均在该目录之外，结构上已排除）；命中 4 处；CompletableFuture 与 new Thread 各 0 命中",
          "notes": "4 个命中点中仅 #1 为 SAME_DEFECT，且 #1 就是起点发现本身（core/PlayerGoodsManager.java:478），故形态向其余模块的净扩散数为 0；另 3 处均实现「主线程构建 String/byte[] → 异步纯文件写」的正确切分。残留盲区：事件型异步入口（AsyncChatEvent 等）不经调度器，不在本模式覆盖内。",
          "other_occurrences": [
            {
              "location": "core/PlayerGoodsManager.java:478",
              "verdict": "SAME_DEFECT"
            },
            {
              "location": "stats/StatsManager.java:640",
              "verdict": "NOT_APPLICABLE"
            },
            {
              "location": "stats/StatsManager.java:673",
              "verdict": "NOT_APPLICABLE"
            },
            {
              "location": "doc/CommandsDocumentGenerator.java:467",
              "verdict": "NOT_APPLICABLE"
            }
          ]
        }
      ]
    },
    "slice_scan_performed": true,
    "file_scan_performed": true,
    "dimension_scan_performed": true,
    "entry_scan_performed": true
  },
  "error": null
}
```
