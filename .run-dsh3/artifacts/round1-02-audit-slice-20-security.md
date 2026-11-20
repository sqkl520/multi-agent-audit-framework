# round1 深挖审计 — slice-20 / security

| 项 | 值 |
|---|---|
| trace_id | trace-r1-20260215-hilltop-dsh3 |
| round_id | round1 |
| slice_id | slice-20 |
| dimension | security |
| agent_id | audit-slice-20-security |
| 被审仓库 | `D:/Server/MCServers/Server plugin/Hilltop Village/Hilltop Village Plugin`（只读） |
| 被审文件 | `ArenaAccessListener.java`（83 行）、`ArenaScoreboard.java`（908）、`FireballListener.java`（665）、`FriendlyFireListener.java`（69）、`HammerEffectRenderer.java`（191） |
| 共享依赖 | `arena/ArenaInstance.java`、`arena/MultiArenaManager.java` |
| 结论 | 2 条 CONFIRMED（MEDIUM ×1、LOW ×1），均围绕「世界级准入实际上只覆盖传送事件」；友伤绕过判为 logic 缺口，透传到 `off_dimension_notes` |

> 本切片已有 concurrency 深挖，本文不重复其结论：L1/L2 只做处置登记，正文不展开竞态分析。

---

## 1. 本切片的威胁模型（取自被审代码自身的声明）

`ArenaAccessListener` 的类注释声明它要把「只有成员在世界里」从 `ArenaInstance.addPlayer` 的命令层校验升级为**世界层强制**，并点名了未防护时的后果：非成员可攻击波次怪、捡走掉落货币、使用商店 NPC、随意破坏方块。

本维度只问一个问题：**这个「世界层强制」在代码里由什么事件/什么时机承载，哪些进入世界的路径不经过它。** 答案：只由 `PlayerTeleportEvent` 一个事件承载，且唯一的执行动作是取消这次传送（不驱逐已在世界内的人）。

---

## 2. 线索处置表（sweep L1–L6 逐条）

| lead_id | 处置 | 依据 / 说明 |
|---|---|---|
| L1 `ArenaScoreboard.ensureTaskRunning` 禁用窗口注册任务 | **OFF_DIMENSION** | 维度=concurrency；本切片并发维度已另行深挖，按要求不重复。安全侧无权限/注入含义。 |
| L2 `FireballListener` 爆炸匿名 `runTaskTimer` 无句柄 | **OFF_DIMENSION** | 维度=concurrency（任务泄漏/持有 world 引用），非越权。 |
| L3 `FireballListener:525` 空 catch 吞 UUID 解析失败 | **OFF_DIMENSION** | 维度=error-handling。安全侧含义有限（投掷者离线/伪造 metadata 才会触发，metadata 由插件写入，玩家不可伪造）。 |
| L4 `FireballListener:304` 发射器库存取自 `BlockState` 快照 | **OFF_DIMENSION** | 维度=data-consistency（扣料是否回写真方块）。即便成立也是「烈焰蛋可无限使用」的平衡问题，不是权限绕过。 |
| L5 世界准入只挂 `PlayerTeleportEvent`、不区分 `TeleportCause` | **CONFIRMED → F-slice-20-security-01（载具/非传送事件路径）+ F-slice-20-security-02（登录落点兜底依赖可空配置）**；其中两个子命题被 **REJECTED**（见下） | 见第 3 节。 |
| L6 `FriendlyFireListener.resolveDamager` 对 TNT/苦力怕/驯狼返回 null 后放行 | **OFF_DIMENSION**（logic） | 见第 5 节 `off_dimension_notes` 第 4 条：这是可被玩家利用的**游戏规则**绕过（放 TNT / 引苦力怕 / 驯狼咬队友），但不构成权限、注入、越权访问或信息泄露，按维度隔离规则不进 `findings`。 |

### L5 的两个子命题：REJECTED

| 子命题 | 判定 | 证据（本回合读取） |
|---|---|---|
| 「场内重生/复活绕过准入」 | **REJECTED** | 重生不走 `PlayerTeleportEvent`，但 `HilltopVillagePlugin#onPlayerRespawn`（:515）对「重生点落在竞技场世界且玩家不是成员」做了独立兜底：`PlayerLifecycleListener.java:128` 的 `onRespawn` 只处理成员（`gameManager` 为 null 即 return）。两条路径合起来覆盖了「非成员在竞技场世界复活」。 |
| 「`/execute in <世界>` 绕过准入」 | **REJECTED** | `/execute in ... run tp` 的落点仍是 `Player#teleport`，会派发 `PlayerTeleportEvent`，正是 `ArenaAccessListener.java:50` 处理的类型；守卫在 `:80` 取消该次传送。此判定依赖 Paper 1.21 对 `/execute` 跨维度 `tp` 的实现，已列入 `self_checks.runtime_validation` 的待实测项，不作为发现上报。 |

---

## 3. 发现

### F-slice-20-security-01（MEDIUM）准入只在 `PlayerTeleportEvent` 上实现，载具乘客等非传送事件路径不被拦截

**Evidence（`ArenaAccessListener.java:49-50`）**

```java
    @EventHandler(priority = EventPriority.NORMAL, ignoreCancelled = true)
    public void onTeleport(PlayerTeleportEvent event) {
```

本类是 `Listener`，全类只有这一个 `@EventHandler`（`:49-50`）；唯一的执行动作是 `:80` 的 `event.setCancelled(true)`。没有 `PlayerJoinEvent` / `PlayerRespawnEvent` / `EntityTeleportEvent` / 周期扫描任务。

**调用链（攻击者可达路径）**

1. 非成员在大厅乘上载具（船/猪/马）——原版允许，无权限要求。
2. 载具被带进竞技场世界：传送门拓扑连通，或由具备 OP/插件权限的一方对载具执行跨世界传送（`/tp @e[type=boat] ...`、WorldEdit/Multiverse 等）。
3. 服务端对**载具**派发 `EntityTeleportEvent`；乘客是随载具一起被移动的，`ArenaAccessListener` 没有该事件的处理器 → 守卫不执行。
4. 非成员落地后：`FriendlyFireListener.java:45-46` 解析 damager 后，在 `:55` 以 `arena.isPlayer(...)` 早退 → 非成员对成员的伤害不被拦；同世界的掉落货币、商店 NPC、方块交互也没有第二道世界级检查（本类没有「驱逐已在世界内的非成员」动作）。

**为什么不写成 HIGH/CRITICAL**：第 2 步的可行性依赖服务端实现与传送门拓扑，本仓库内无代码可证；且若施加者本就具备 OP/插件权限，则与 `hilltopvillage.admin` 豁免（`:67`）等价。**代码事实（守卫只有传送事件载体、无兜底时机）是确认的；利用面是条件性的**，故 MEDIUM。

**alternatives（可检查的推翻条件）**

1. 若 Paper 1.21 在载具跨世界时对乘客补发 `PlayerTeleportEvent`，该路径不成立——需在 1.21 Paper 上实测 `Entity#teleport` 对 passenger 的事件派发（服务端实现，不在本仓库）。
2. 若竞技场世界与主世界/下界之间不存在传送门连通、且不存在能移动载具的授权方，则利用前提与 `hilltopvillage.admin` 豁免等价，影响降为加固建议——需检查 `arenas.yml` 各场的 `world` 与服务器 `bukkit.yml`/世界 environment 配置。
3. 若进入后的下一次传送/登录总会被别的守卫纠正（`HilltopVillagePlugin.java:477` 的 join、`:515` 的 respawn、`ArenaInstance.java:1388` 的 reset 残留循环），滞留时间窗会被压缩——需确认这些路径在「玩家始终在线且不再传送」时是否仍会触发（当前读到的代码都不会周期性触发）。

---

### F-slice-20-security-02（LOW）登录落点的世界校验以「大厅出生点非空」为前提，配置缺失时非成员可滞留在竞技场世界

**Evidence（`MultiArenaManager.java:1067-1069`）**

```java
        if (spawn != null && (player.getWorld() != spawn.getWorld()
                || player.getLocation().distanceSquared(spawn) > 4.0)) {
            player.teleport(spawn);
```

`applyLobbyState` 是登录路径上唯一的「把非成员挪出竞技场世界」的动作（`HilltopVillagePlugin.java:509` → `MultiArenaManager.java:1064`）。它的世界校验整体挂在 `spawn != null` 上：`getLobbySpawn()` 在「未配置或大厅世界未加载」时返回 null（`:976-980` 的契约），此时**既不传送，也不做任何世界判定**，后面的 `setGameMode/Health/...` 照常执行。

**调用链（攻击者可达路径，无需 OP）**

1. 玩家以成员身份进入对局（`/hilltop join`，`joinArena` → `addPlayer`）。
2. 对局进行中退服：`handleQuit`（`MultiArenaManager.java:151-160`）在 `auto-leave-on-quit=false` 或对局进行中时保留位置，只登记 `PendingRejoin`，不传送、不移出世界——玩家的登出坐标留在竞技场世界。
3. 对局结束/竞技场被 `disable`：`reset()`（`ArenaInstance.java:1382-1407`）只对**在线**残留走 `removePlayer`（会送回大厅），离线者只清集合与映射（`:1410`）——世界里的坐标仍在。
4. 玩家重登：`applyJoinState`（`HilltopVillagePlugin.java:505-509`）→ `tryRejoin` 因窗口过期返回 false → `isInArena` 为 false → `applyLobbyState`。
5. 若此时 `getLobbySpawn()` 为 null（`lobby.world` 未配置或该世界未加载）：`spawn != null` 短路 → **不传送** → 玩家以非成员身份留在竞技场世界，`ArenaAccessListener` 完全不参与（登录不是传送事件），可攻击成员/波次怪、拾取掉落货币、使用商店 NPC、破坏方块。

**为什么是 LOW 而非 MEDIUM**：第 5 步需要「大厅世界未配置/未加载」这一先决条件，属纵深防御缺口而非直接越权；但它把「世界级准入」的最后一环交给了可空配置值，且代码在 `sendToLobby`（`:1053-1055`）里对同一情形有回退分支，说明该配置态是被预期存在的——两处口径不一致。

**alternatives（可检查的推翻条件）**

1. 若生产配置始终写入 `lobby.world` + `lobby.spawn` 且大厅世界总能加载，则 `getLobbySpawn()` 恒非 null，该路径不成立——需检查 `arenas.yml` 的 `lobby` 段与启动日志中的大厅世界缺失告警（`isConfiguredLobbyWorldMissing`，`:1014`）。
2. 若 `reset()` 对离线玩家也写回大厅坐标（例如落盘位置清理），则第 4 步的登录位置本就安全——需核对 `ArenaInstance.java:1382-1407` 的残留循环，当前只对 `online` 调 `removePlayer`。
3. 若在 `PlayerJoinEvent` 之后还有周期性驱逐（`getArenaByWorld` 的其它调用点做「非成员踢出」），滞留会被纠正——需 grep 全部 `getArenaByWorld` 调用点确认无此逻辑（本切片已核对 `ArenaAccessListener:60`、`FriendlyFireListener:50`、`HilltopVillagePlugin:531` 三处，均非驱逐）。

---

## 4. 已检查、未出发现的攻击面

| 检查项 | 结论 |
|---|---|
| 管理员判定用权限节点还是 `isOp()` | `ArenaAccessListener:67` 用 `hasPermission("hilltopvillage.admin")`，`plugin.yml:26-28` 该节点 `default: op` 并把 config 子节点挂为其 children——口径一致，未发现「`isOp()` 与权限节点分裂」。 |
| 玩家输入进入权限判定 | 本切片五个文件中唯一的权限判定是上述节点；`FireballListener` 的 `UUID.fromString` 输入来自插件写入的 projectile metadata，玩家不可伪造（无 NBT/PDC 编辑入口）。 |
| 注入 / 路径穿越 | 五个文件均无文件路径拼接、无命令拼接、无反序列化入口。`ArenaScoreboard` 只把配置字符串与计分数据写入 team prefix/entry（`registerNewTeam("line"+i)`、`team.addEntry(entry)`，`:873-874`），entry 由本类生成，非玩家可控。 |
| 越权干预对局的第二道门 | `FriendlyFireListener:55` 对「任一方非本场成员」放行——这是设计声明（旁观者/管理员/闯入者交由 `ArenaAccessListener` 处理），故本切片不把它单列为越权；真正的缺口是 F-01/F-02 描述的「人已经在世界里」的情形。 |
| `ArenaScoreboard` 信息泄露 | 只渲染波次/人数/节点/时间，无 UUID、无权限、无其它玩家私有数据；`show/hide/clear` 均有 `player.getScoreboard() == state.board` 身份守卫（`:348`）。未发现泄露面。 |
| `HammerEffectRenderer` | 纯粒子渲染，静态 `BlockData` 常量且注释与实现一致（`private static final`，`:51-53`）；无玩家输入参与，无世界/方块写入。安全维度无命中（`location.getWorld()` 未判空属 error-handling，已透传）。 |
| `FireballListener` 爆炸伤害范围 | `:558-560` 过滤掉 invulnerable 实体与村民；`:577` 玩家分支不受伤只被击退（零友伤承诺在技能路径上成立），怪物分支带 attacker 来源。无「伤害非成员以刷击杀」的路径（非成员不在 `GameManager.playerData` 中，`HilltopVillagePlugin:466-471` 已判空跳过记分）。 |

---

## 5. 维度清单（逐项）

| # | 模式 | 结果 | 说明 |
|---|---|---|---|
| 1 | 返回值暴露内部状态 | 未命中 | `ArenaScoreboard` 不向外返回内部 board/map；`ArenaInstance.getScoreboard()` 返回实例（共享单例，非拷贝），但不构成安全面。 |
| 2 | 同族函数守卫一致性 | 命中 | 同族「世界准入」两条口径：`ArenaAccessListener` 查定义库（含禁用/未部署场），`FriendlyFireListener:49-50` 查活动实例库（`activeArenas`）。差集 = 已禁用/退役竞技场世界——见 F-02 的滞留场景。 |
| 3 | 数值边界 | 未命中 | 切片内无论玩家可控数值进入权限/经济判定；`cfg.damage()/radius()` 来自配置。 |
| 4a | 原型链/裸下标 | 不适用 | Java，无 JS 原型链语义。 |
| 4b | 假值 vs 缺值 | 命中 | F-02 的 `spawn != null` 把「大厅未配置」与「大厅已配置」合并成「不处理」，缺值被当作「无需校验」。 |
| 4c | NaN/Infinity/小数 | 不适用 | 无外部数值解析入口。 |
| 4d | 嵌套结构校验 | 未命中 | 无外部嵌套结构解析。 |
| 5 | 能力是否真实现 | 命中 | 类注释声明的「世界层强制」只由 `PlayerTeleportEvent` 承载（F-01），能力范围小于声明。 |
| 6 | 转义/编码顺序 | 不适用 | 无多层转义/编码。 |
| 7 | 边界符号（负数/下标） | 未命中 | 无玩家可控下标/负数进入权限或路径。 |
| 8 | 引用绑定是否存在 | 未命中 | 五个文件与两个共享依赖的调用名均能在本回合读到的定义侧找到（`getArenaByWorld`/`isPlayer`/`send`/`getMultiArenaManager`）。 |

---

## 6. 自检

- **标识符对账（DONE）**：对账三组——① 权限节点 `hilltopvillage.admin`：`plugin.yml:26` 定义 ↔ `ArenaAccessListener:67` 消费 ↔ `ArenaInstance:304,357` 消费，一致；② 世界反查 API：`ArenaAccessListener:60` 用 `getDefinitionManager().getArenaByWorld`（定义库）vs `FriendlyFireListener:50` 用 `MultiArenaManager.getArenaByWorld`（活动实例库）→ **差集非空**（禁用/退役场），已写入 F-02 的 alternatives 与第 5 节第 2 项；③ 语言键 `arena.access-denied` 只在 `:81` 消费，未核 `messages.yml`（超出切片，未作为证据）。
- **自带自检抽验（SKIPPED）**：被审仓库为 Maven/Java 项目，无 `check-*.mjs`/独立自检脚本；抽验需要跑 `mvn test`，任务书明令禁止构建（会写 `target/`），故无法执行注入故障抽验。
- **运行时验证（SKIPPED）**：F-01 的载具分支只能在 1.21 Paper 实机上验证「载具跨世界时是否对乘客补发 `PlayerTeleportEvent`」，F-02 需要构造 `lobby.world` 缺失的启动态；本轮零写入、禁构建、无测试服务器，故未跑。

## 7. off_dimension_notes

1. `concurrency`：L1 `ArenaScoreboard.ensureTaskRunning`（`:369` 直接 `runTaskTimer`，未像 `ensureReEnableProbeRunning:392` 那样先判 `plugin.isEnabled()`）；L2 `FireballListener` 爆炸每次新建匿名 `runTaskTimer` 且不保句柄（`:612-622`）。本切片并发维度另有深挖，此处仅登记。
2. `error-handling`：`FireballListener:525` `catch (IllegalArgumentException ignored) {}` 空吞；`HammerEffectRenderer` 三处 `location.getWorld()` 未判空（`:59,84,133`，调用方 `HammerListener` 传玩家命中点，实际不会 null）。
3. `data-consistency`：`FireballListener:304` 发射器库存取自 `event.getBlock().getState()` 快照，`setItem(i, null)` 是否回写真实方块未证实；若不回写，配合 `:300` 附近的 `setCancelled(true)` 会形成「烈焰蛋不消耗」。
4. `logic`（L6 友伤绕过，可利用但非安全维度）：`FriendlyFireListener.resolveDamager`（`:61-68`）只认 `Player` 与「shooter 是玩家的 `Projectile`」，其余一律 null，`onEntityDamage:46` 随即 `return` 放行。玩家可放置并点燃 TNT、把苦力怕/驯狼引到队友身边造成同队伤害，绕过类注释与 README 宣称的「零友伤」；`EntityDamageByEntityEvent` 的 damager 为 `TNTPrimed`/`Creeper`/`Wolf` 时不进入 `:55` 的成员判定。这是游戏规则缺口，不是权限/注入/越权访问，按任务书要求放本字段。
5. `contract`：`ArenaAccessListener` 的类注释（`:17-20`）宣称「世界级不变量」，实现只覆盖传送事件——注释与实现的落差已在 F-01 的 `claim` 中作为推断依据写明，未单列为风格问题。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "audit-slice-20-security",
  "role": "audit",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:\\Projects\\AI prompt\\many-agents_multi-prompt-files_token-heavy\\multi-agent-audit-framework\\.run-dsh3\\artifacts\\round1-02-audit-slice-20-security.md",
  "payload": {
    "slice_id": "slice-20",
    "findings": [
      {
        "finding_id": "F-slice-20-security-01",
        "severity": "MEDIUM",
        "dimension": "security",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/mechanics/ArenaAccessListener.java",
          "line": 49,
          "quote": "    @EventHandler(priority = EventPriority.NORMAL, ignoreCancelled = true)\n    public void onTeleport(PlayerTeleportEvent event) {"
        },
        "inference": {
          "claim": "竞技场世界准入只在 PlayerTeleportEvent 上实现，没有登录/重生/实体传送/周期扫描等任何兜底时机；不经过玩家传送事件的进场路径（典型为载具乘客随载具跨世界）不会被拦截，非成员因此可留在竞技场世界并对对局进行干预。",
          "basis": "调用链：大厅玩家 → 乘上载具 → 载具跨世界进入竞技场世界（传送门连通，或由 OP/插件对载具执行跨世界传送）→ 服务端只对载具派发 EntityTeleportEvent，而本类是 Listener 且全类仅 :49-50 一个 @EventHandler（PlayerTeleportEvent），守卫不执行 → 玩家以非成员身份存在于世界内。进入后的影响链：FriendlyFireListener.java:45-46 解析 damager，:55 在 arena.isPlayer 为 false 时提前 return，非成员对成员的伤害不被拦；本类唯一的执行动作是 :80 的 event.setCancelled(true)，没有驱逐已在世界内非成员的动作，因此落地后不再有任何世界级检查。",
          "alternatives": [
            "若 Paper 1.21 在载具跨世界时对乘客补发 PlayerTeleportEvent，则该路径不成立——需在 1.21 Paper 上实测 Entity#teleport 对 passenger 的事件派发（服务端实现，不在本仓库）。",
            "若竞技场世界与主世界/下界之间不存在传送门连通，且服务器上不存在可移动载具的授权方（OP/插件），则利用前提与 hilltopvillage.admin 豁免等价，影响降为加固建议——需检查 arenas.yml 各场的 world 与服务器世界 environment/portal 配置。",
            "若进入后的下一次传送或登录总会被其它守卫纠正，滞留窗口会被压缩——需确认 HilltopVillagePlugin.java:477 的 join、:515 的 respawn、ArenaInstance.java:1388 的 reset 残留循环在「玩家在线且不再传送」时是否仍会触发（本回合读到的代码都不会周期性触发）。"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "F-slice-20-security-02",
        "severity": "LOW",
        "dimension": "security",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/arena/MultiArenaManager.java",
          "line": 1067,
          "quote": "        if (spawn != null && (player.getWorld() != spawn.getWorld()\n                || player.getLocation().distanceSquared(spawn) > 4.0)) {\n            player.teleport(spawn);"
        },
        "inference": {
          "claim": "登录路径上唯一的「把非成员挪出竞技场世界」动作以大厅出生点非空为前提：getLobbySpawn() 返回 null 时 applyLobbyState 既不传送也不做任何世界判定，曾在对局中退服、对局结束后重登的玩家会以非成员身份滞留在竞技场世界。",
          "basis": "调用链：HilltopVillagePlugin.java:509 applyJoinState → MultiArenaManager.java:1064 applyLobbyState → :1067 的 spawn != null 短路。前置状态链：玩家以成员身份 /hilltop join（joinArena:738 → addPlayer）→ 对局中退服，handleQuit:151-160 保留位置并只登记 PendingRejoin（不传送、不移出世界）→ 对局结束 reset()（ArenaInstance.java:1382-1407）只对在线残留调用 removePlayer，离线者仅清集合与映射（:1410）→ 重登时 tryRejoin 因窗口过期返回 false、isInArena 为 false → applyLobbyState。getLobbySpawn 的契约是「未配置或世界未加载时返回 null」（MultiArenaManager.java:976-980），此时 :1067 整段被短路，玩家留在原世界。ArenaAccessListener 不参与（登录不是传送事件），非成员可攻击成员/波次怪、拾取掉落货币、使用商店 NPC、破坏方块。",
          "alternatives": [
            "若生产配置始终写入 lobby.world 与 lobby.spawn 且大厅世界总能加载，getLobbySpawn() 恒非 null，该路径不成立——需检查 arenas.yml 的 lobby 段与启动日志中的大厅世界缺失告警（isConfiguredLobbyWorldMissing，MultiArenaManager.java:1014）。",
            "若 reset() 同时对离线玩家写回大厅坐标，则重登位置本就安全——需核对 ArenaInstance.java:1382-1407 的残留循环，当前只对 online 玩家调用 removePlayer。",
            "若 PlayerJoinEvent 之后还有周期性驱逐（某个 getArenaByWorld 调用点把非成员踢出），滞留会被纠正——需 grep 全部 getArenaByWorld 调用点；本切片已核对 ArenaAccessListener.java:60、FriendlyFireListener.java:50、HilltopVillagePlugin.java:531 三处，均非驱逐逻辑。"
          ]
        },
        "status": "CONFIRMED"
      }
    ],
    "searched_scope": {
      "files_read": [
        "src/main/java/com/hilltopvillage/mechanics/ArenaAccessListener.java",
        "src/main/java/com/hilltopvillage/mechanics/ArenaScoreboard.java",
        "src/main/java/com/hilltopvillage/mechanics/FireballListener.java",
        "src/main/java/com/hilltopvillage/mechanics/FriendlyFireListener.java",
        "src/main/java/com/hilltopvillage/mechanics/HammerEffectRenderer.java",
        "src/main/java/com/hilltopvillage/arena/ArenaInstance.java",
        "src/main/java/com/hilltopvillage/arena/MultiArenaManager.java",
        "src/main/java/com/hilltopvillage/HilltopVillagePlugin.java",
        "src/main/java/com/hilltopvillage/mechanics/PlayerLifecycleListener.java",
        "src/main/java/com/hilltopvillage/arena/ArenaManager.java",
        "src/main/resources/plugin.yml"
      ],
      "files_in_slice": 5,
      "shared_dependencies_read": [
        "src/main/java/com/hilltopvillage/arena/ArenaInstance.java",
        "src/main/java/com/hilltopvillage/arena/MultiArenaManager.java"
      ],
      "files_scanned_without_findings": [
        "src/main/java/com/hilltopvillage/mechanics/ArenaScoreboard.java",
        "src/main/java/com/hilltopvillage/mechanics/FireballListener.java",
        "src/main/java/com/hilltopvillage/mechanics/HammerEffectRenderer.java",
        "src/main/java/com/hilltopvillage/HilltopVillagePlugin.java",
        "src/main/java/com/hilltopvillage/mechanics/PlayerLifecycleListener.java",
        "src/main/java/com/hilltopvillage/arena/ArenaManager.java",
        "src/main/resources/plugin.yml"
      ],
      "dimension_checklist": [
        { "pattern": "1 返回值暴露内部状态", "result": "未命中", "note": "ArenaScoreboard 不向外返回内部 board/map；ArenaInstance.getScoreboard() 返回共享实例但不构成安全面" },
        { "pattern": "2 同族函数守卫一致性", "result": "命中", "note": "世界准入两条口径：ArenaAccessListener 查定义库，FriendlyFireListener:49-50 查活动实例库，差集为已禁用/退役世界（F-02）" },
        { "pattern": "3 数值边界", "result": "未命中", "note": "切片内无玩家可控数值进入权限或经济判定，damage/radius 均来自配置" },
        { "pattern": "4a 原型链/裸下标", "result": "不适用", "note": "Java 项目，无 JS 原型链语义" },
        { "pattern": "4b 假值 vs 缺值", "result": "命中", "note": "applyLobbyState 的 spawn != null 把「大厅未配置」合并进「不处理」，缺值被当无需校验（F-02）" },
        { "pattern": "4c NaN/Infinity/小数", "result": "不适用", "note": "无外部数值解析入口" },
        { "pattern": "4d 嵌套结构校验", "result": "未命中", "note": "无外部嵌套结构反序列化" },
        { "pattern": "5 能力是否真实现", "result": "命中", "note": "类注释声明的世界层强制只由 PlayerTeleportEvent 承载，覆盖范围小于声明（F-01）" },
        { "pattern": "6 转义/编码顺序", "result": "不适用", "note": "无多层转义或编码链" },
        { "pattern": "7 边界符号（负数/下标）", "result": "未命中", "note": "无玩家可控下标/负数进入权限或文件路径" },
        { "pattern": "8 引用绑定是否存在", "result": "未命中", "note": "五个切片文件与两个共享依赖的调用名均能在本回合读到的定义侧找到" }
      ]
    },
    "self_checks": {
      "identifier_reconcile": {
        "status": "DONE",
        "note": "对账三组：权限节点 hilltopvillage.admin（plugin.yml:26 定义 / ArenaAccessListener:67 与 ArenaInstance:304,357 消费，一致）；世界反查 API 两种口径（定义库 vs activeArenas，差集=禁用/退役场，已写入 F-02）；语言键 arena.access-denied 仅 :81 消费，messages.yml 未核（未作为证据）"
      },
      "self_check_audit": {
        "status": "SKIPPED",
        "note": "被审仓库为 Maven/Java 项目，无 check-*.mjs 等独立自检脚本；抽验需跑 mvn test，任务书明令禁止构建（会写 target/），无法执行注入故障抽验"
      },
      "runtime_validation": {
        "status": "SKIPPED",
        "note": "F-01 需在 1.21 Paper 实机验证载具跨世界是否对乘客补发 PlayerTeleportEvent，F-02 需构造 lobby.world 缺失的启动态；本轮零写入且禁构建、无测试服，未运行"
      }
    },
    "off_dimension_notes": [
      "concurrency：L1 ArenaScoreboard.ensureTaskRunning（:369 直接 runTaskTimer，未像 ensureReEnableProbeRunning:392 先判 plugin.isEnabled()）；L2 FireballListener 每次爆炸新建匿名 runTaskTimer 且不保句柄（:612-622）。本切片并发维度已另有深挖，此处仅登记不展开。",
      "error-handling：FireballListener:525 的 catch (IllegalArgumentException ignored) {} 空吞；HammerEffectRenderer 三处 location.getWorld() 未判空（:59,84,133），调用方 HammerListener 传玩家命中点，实际不会为 null。",
      "data-consistency：FireballListener:304 的发射器库存取自 event.getBlock().getState() 快照，setItem(i, null) 是否回写真实方块未证实；若不回写，配合取消原版消耗会形成「烈焰蛋不消耗」。",
      "logic（L6，可利用但非安全维度）：FriendlyFireListener.resolveDamager（:61-68）只认 Player 与 shooter 为玩家的 Projectile，TNT/苦力怕/驯狼等 damager 返回 null，onEntityDamage:46 随即 return 放行，绕过「零友伤」承诺；属游戏规则缺口，不是权限/注入/越权访问。",
      "contract：ArenaAccessListener 类注释（:17-20）宣称世界级不变量，实现只覆盖传送事件；注释与实现的落差已作为 F-01 的推断依据写明，未单列为风格问题。"
    ]
  },
  "error": null
}
```
