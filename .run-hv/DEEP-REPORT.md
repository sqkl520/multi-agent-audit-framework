# Hilltop Village 深挖报告（13 条已确认发现）

- 目标仓库（只读）：`D:\Server\MCServers\Server plugin\Hilltop Village\Hilltop Village Plugin`
- 深挖输入：`.run-hv/findings/S01..S10.json` + `.run-hv/critiques/<ID>.json`
- 逐条结果：`.run-hv/deep/<ID>.json`（13 个文件，均为 UTF-8 合法 JSON，字段齐全）
- 核实环境：Paper 1.21.4 服务端 `D:\Server\MCServers\Hilltop Village\versions\1.21.4\paper-1.21.4.jar`、`paper-api-1.21.4-R0.1-SNAPSHOT.jar`、仓库 `target/classes`；`javap` 字节码核对 + 必要时实跑探针（临时文件已删除，仓库零修改）

## 0. 结论总览

| 结论 | 数量 |
|---|---|
| REACHABLE | 13 |
| REJECT | 0 |
| NEEDS_RUNTIME_CHECK | 0 |
| final_severity = high | 0 |
| final_severity = medium | 3 |
| final_severity = low | 10 |

深挖的核心产出不是"又找到几条"，而是**三条降级 + 两条维持但换了成立理由 + 一条危害被推翻**：

| ID | 首轮 | 深挖 | 变化原因（一句话） |
|---|---|---|---|
| S10-F1 | high | **medium** | 机制完全成立且可用一条 `/hilltop deploy addspawn` 中途触发；但入口只能是管理员手工写出 world-only 段，内容移到 `.corrupt` 可恢复，非数据销毁 |
| S03-F2 | medium | **medium** | 维持；但"完全无法配置非头盔"被推翻——主点击路径写头盔 + 一次误点破坏已有正确值 + 第二菜单无逃生口 |
| S07-F3 | medium | **medium** | 维持；成立理由从"需要第三方保护插件"改为"纯 Paper 旁观者路径即可复现"，危害更实 |
| S03-F3 | medium | **low** | 静默回退真实存在，但需上一轮已有坏文件、`.corrupt` 完整保留、出厂默认安全 |
| S08-F1 | medium | **low** | 量纲错误真实且默认调度即生效，但出厂无 `anim` 行（opt-in）、纯视觉、缓存反而减少发包 |
| S08-F2 | medium | **low** | 销毁/无 re-show 真实，但需管理员本局内主动关→开，影响仅本局信息显示、可自愈 |
| S01-F3 | low | **low** | 可达但**用户可见危害被推翻**：过期文案本身 kind 中立，缺陷只剩 i18n 键不对称 |
| S02-F5 | low | **low** | `saveexit` 落盘是设计；真正咬人的只有"重置后同场重开" |
| S03-F5 | low | **low** | 措辞被修正：整段缺 `tab:` 不 blank，只有"部分 tab 段缺 header/footer"才触发 |
| S03-F6 | low | **low** | 交错机制成立但窗口微秒级、30s 自过期、`E` 开背包不触发事件 |
| S05-F6 | low | **low** | 失败会显式播报、原文件不损坏；但"只读到不了 :530"被修正为"OS 级只读恰好会到" |
| S08-F3 | low | **low** | 一次性擦除而非持续压制；需非默认 context + 第三方插件 + 对方不周期重推 |
| S08-F4 | low | **low** | 触发面比锐评更宽（`touched` 恒等于最近一帧全部在线玩家），但仍是一次性展示层回退 |

---

## 1. medium（3 条）

### S10-F1 — Arena 校验器把合法的多竞技场 arenas.yml 判为截断写并隔离

- **verdict**: REACHABLE ｜ **severity**: medium（首轮 high，降级）｜ **confidence**: high
- **文件**: `src/main/java/com/hilltopvillage/util/YamlFiles.java:226`

**调用链**

1. 入口 A（重启）：`HilltopVillagePlugin.onEnable:124-125` → `MultiArenaManager.loadArenaDefinitions:262-264` → `ArenaManager.load:132` → `YamlFileGate.load:53` → `YamlFiles.load`。
2. 入口 B（会话中，已核实）：`/hilltop deploy addspawn` → `HilltopCommandHandler.handleDeployCommand:946-947` → `AdminDeployManager.addSpawnPoint:639-653` → `saveSpawnPoints:458 gate.writable()`（此刻未加锁，返回 true）→ `:471 gate.load()` → 同一 gate → `YamlFiles.load`。
3. 缺陷行：`YamlFiles.arenasValidator:224-229`
   `arenaKeys = arena.getKeys(false); thin = allMatch(Set.of("world")); if (thin && (arenaKeys.isEmpty() || sawRichArena)) return "arena '<id>' has only [world] — looks like a truncated write";`
4. 后果：`quarantine:143 Files.move(..., .corrupt, REPLACE_EXISTING)` → 返回 `Loaded(null, SUSPECT)` → `YamlFileGate:54-55 readOnly = true` → `ArenaManager.load:135-139 registry.clear()`；会话中路径则在 `saveSpawnPoints:474-478` 中止并报失败。
5. 重启后：新进程 `readOnly=false` + 文件已不存在 → `ArenaManager.ensureFile:846-847 saveResource("arenas.yml", false)` 落回出厂模板。

**guard_check**：无任何 guard 能挡住"rich 在前 + world-only 在后"。

- 插件自身**没有任何写入方**会写出 world-only 段（`AdminDeployManager` 只写 spawn-points/core/waiting/shop-npc，`ArenaManager.updateGameParams` 只写 `game.*`，无 addarena 命令），所以入口只能是手工编辑/复制段落后删剩 world。
- 无 arena 数量阈值、无文件级标记；反而 thin-thin、单独 thin 都放行，只有 `sawRichArena` 之后的 thin 才失败——恰好是"出厂 arena1 在前、管理员在文件尾部追加"的自然布局。
- `/hilltop reloadconfig` 确实**不重读** arenas.yml（`Handler:396-453` 只 reset gate + 重载 settings/display/messages），但它会 `reset()` 解闩且不重新校验，配合 `YamlFileGate:76-78` 的"修好或 reloadconfig"提示，会让管理员误以为已恢复（实际 registry 仍为空）。

**actual_impact**：两条 SEVERE 日志后，`/hilltop list`、`/hilltop arenas`、竞技场选择 GUI 全空；所有 arenas.yml 写入被拒直到重启。本进程内 `ensureFile`/`loadSpawnPoints` 刻意不在只读态重建（防绕过），所以当场不被模板覆盖；但下次重启会用出厂模板重建，真配置只剩 `arenas.yml.corrupt`，需停服手工改回。`REPLACE_EXISTING` 还意味着二次误判会覆盖上一次备份。

**premise_verified**

- `ConfigurationSection.getKeys(false)` 保文档顺序：`javap -c MemorySection` 显示构造器 `new LinkedHashMap`，`getKeys` 用 `LinkedHashSet` 按 `map.entrySet()` 顺序 add；用 paper-api 1.21.4 + snakeyaml 2.2 实跑探针，`zzz/aaa`、`arena4/arena1` 均保持写入序。
- validator 行为实跑复现：rich-then-thin → 报错；两段颠倒 / 单独 thin / 两个 thin → null。
- 加载侧确实接受 world-only：`ArenaManager.readDefinition:555` 只 `requiredString("world")`；`validationFailure:527-536` 只在 core 非空时校验 core、空 spawn 列表循环零次；`Builder` 默认 2/6/20/30 合法。
- 仓库单测 `YamlFilesTest:226-230` 本身就把 rich-then-thin 断言为 SUSPECT——说明是**有意设计**，修法必须同时改该测试。

**修复方向**：把 `sawRichArena` 判据去掉，或只在"同 id 段被截断"（例如该段存在但 `world` 为空）时判可疑；至少不要把"缺少可选键"当截断证据。

---

### S03-F2 — 护甲循环列表只有头盔，普通点击把头盔写进胸/腿/脚槽

- **verdict**: REACHABLE ｜ **severity**: medium（维持）｜ **confidence**: high
- **文件**: `src/main/java/com/hilltopvillage/config/menu/MonsterSettingsMenu.java:400`

**调用链**

1. `/hilltop config`（`hilltopvillage.config.admin`，默认 op）→ `HilltopCommandHandler:388-393` → `handleConfigCommand:599-644` → `MainConfigMenu`。
2. `MainConfigMenu:60-66` slot 23 → `openSubMenu(new MonsterSettingsMenu(...))` → `:179-188` 延迟 2 tick 注册监听并 open。
3. `MonsterSettingsMenu.buildMenu:187-198` 对 helmet/chestplate/leggings/boots 四次 `addArmorSlot`，**四次都传同一个静态 `ARMOR_CYCLE`**。
4. 缺陷行：`addArmorSlot` 的 else（非 Shift，含左右键）`:296-299` `cycleMaterial(current, ARMOR_CYCLE); setter.accept(next);`
   `:400-404` 数组 = `{LEATHER_HELMET, CHAINMAIL_HELMET, IRON_HELMET, DIAMOND_HELMET, NETHERITE_HELMET, GOLDEN_HELMET, AIR}`。
5. 落库：setter = `mc::setChestplate/setLeggings/setBoots`（`GameConfig:372-378` 纯字段赋值）→ 保存 `ConfigManager:1044-1047` 原样 `.name()` 写回 → 重启后 `loadMonstersConfig:2040-2059` 只校验 `isItem()`，错误值继续存活。

**guard_check**：无 REJECT 级 guard，但有**一个逃生口必须记录**：

- 权限只缩小受众，不阻断。
- `:280-292` 的 `SHIFT_LEFT/SHIFT_RIGHT` 分支会 `requestString` + `Material.getMaterial` + `isItem()` 校验，可写入真实胸甲——所以"完全无法配置非头盔护甲"**不成立**。
- 但普通点击仍写头盔；更糟的是 `cycleMaterial:381-386` 对"不在表内的 current"回退 `cycleList[0]`，一个已正确配置的 `IRON_CHESTPLATE` 被点一次就变成 `LEATHER_HELMET` 并可落盘跨重启。
- `WaveSettingsMenu.MonsterPropMenu:611-627` **没有 Shift 分支**，`ARMOR_LIST:661-665` 同样全头盔——该入口四件护甲永久只能写头盔。

**actual_impact**：管理员点"胸甲"槽，字段被写成 `LEATHER_HELMET` 等；刷怪时 `WaveManager:525-542` 把该材质放进 `EquipmentSlot.CHEST/LEGS/FEET`（`CraftEntityEquipment.setItem` 无部位校验，javap 已确认），客户端渲染错位或视觉为空，掉落表还按该物品掉。危害限于配置正确性/怪物外观/掉落，不影响主流程，故维持 medium（有逃生口不升 high；因破坏性覆盖 + 第二菜单无替代路径不降 low）。

**premise_verified**：`Material[]` 类型（非 ItemStack/EquipmentSlot）由源码与 `javap -p -c` 的 `static{}` 逐一 `getstatic *_HELMET` + `aastore` 确认；`cycleMaterial` 用 `(i+1) % length`，null/AIR 取 `[0]`，不在表内回退 `[0]`。

**修复方向**：按槽位拆四张表；`cycleMaterial` 对未知 current 保留原值而不是回退 `[0]`；`WaveSettingsMenu` 补 Shift 输入或复用同一实现。

---

### S07-F3 — 节点修复 handler 缺 ignoreCancelled，旁观者/被取消的右键仍能修节点并扣材料

- **verdict**: REACHABLE ｜ **severity**: medium（维持，理由更换）｜ **confidence**: high
- **文件**: `src/main/java/com/hilltopvillage/mechanics/NodeListener.java:172`

**调用链**

1. 玩家右键 → `ServerGamePacketListenerImpl.handleUseItemOn` → `ServerPlayerGameMode.useItemOn`。
2. `CraftEventFactory.callPlayerInteractEvent`：旁观者且方块无 `MenuProvider`（重生锚满足）时，在 `PluginManager.callEvent` **之前**就 `setUseInteractedBlock(DENY)`，事件以 `isCancelled()==true` 进入分发。
3. `RegisteredListener.callEvent`：`isCancelled() && isIgnoringCancelled()` 才 return；本 handler `ignoreCancelled=false`，照常 execute。
4. 缺陷行：`NodeListener:172 @EventHandler(priority = NORMAL)` 无 `ignoreCancelled`、全文件无 `isCancelled()`/`useInteractedBlock()` 检查；`:208-247` 直接 `repairNode` + `item.setAmount(...)`/`setItemInMainHand(null)`。

**guard_check**：七道门控（hand / RIGHT_CLICK_BLOCK / clickedBlock / 竞技场世界 / 是 RESPAWN_ANCHOR / PlayerData 非空 / 对局运行中）**没有一道读事件取消状态**。类内其余 4 个 handler（`:103/:114/:124/:145`）都是 `HIGH + ignoreCancelled=true`，`FireballListener:242`、`HammerListener:248` 都有 SPECTATOR 门控——说明是遗漏。

**actual_impact**：

- **路径 A（纯 Paper，无需第三方）**：`PlayerLifecycleListener:83 setAlive(false)` + `:97 setKeepInventory(true)` + `:203` 切 `SPECTATOR`，玩家仍留在 `playerDataMap`。死亡/旁观者仍可右键节点：`repairNode` 回血、全队广播 `node.repaired`、扣掉手上世界树汁液（默认 GHAST_TEAR ×1）。直接违反插件自己在 Fireball/Hammer 中立的"旁观者不得行动"规则。
- **路径 B（第三方保护插件）**：LOWEST/LOW 先取消的交互无法阻止修复，材料照扣、保护插件以为已拒绝。
- 边界：无物品复制（满血 `repairNode` 返回 false 不扣）、不能改世界方块（只改内存 NodeData），属规则破坏 + 材料误扣 + 战报 `addNodeRepaired` 虚增；上限是"一波内让濒死节点被鬼魂续命"。

**premise_verified**（字节码级）：`EventHandler` 注解默认 `ignoreCancelled=false`（`javap -v` AnnotationDefault）；`RegisteredListener.callEvent` 的 `ifeq 27 / return` 分支；`PlayerInteractEvent implements Cancellable` 且 `isCancelled() ≡ useInteractedBlock()==DENY`；`CraftEventFactory` 中 `setUseInteractedBlock(DENY)` 位于 `callEvent` 之前；`target/classes` 与线上 `HilltopVillage-...-fix2.jar` 中该方法注解均只有 `priority=NORMAL`。

**修复方向**：加 `ignoreCancelled = true`（同时堵住旁观者路径，因为事件已被预取消），并补 `GameMode.SPECTATOR` / `data.isAlive()` 门控对齐 Fireball/Hammer；`FireballListener:231`、`HammerListener:173` 同类缺失可一并处理。

---

## 2. low（10 条）

### S03-F3 — 被隔离的 game-settings.yml 在下次启动被静默重建为出厂值

- **verdict**: REACHABLE ｜ **severity**: low（首轮 medium，降级）｜ **confidence**: high
- **文件**: `src/main/java/com/hilltopvillage/config/ConfigManager.java:147`

**调用链**：`onEnable:99 new ConfigManager` → 构造器 `:123-140 initSettingsFile()` → `:146-149 if (!settingsFile.exists()) plugin.saveResource("game-settings.yml", false)` → `settingsGate.load()` 读到刚写的模板 → `Status.OK` 清 `readOnly` → `loadFromFile` 走正常分支 `settingsLoadedFromDisk = true`。

**guard_check**：全部未挡住。

- `gameSettingsValidator` 只要 ≥3 个已知顶层键即放行，出厂模板 19 键必过。
- `YamlFileGate.readOnly` 是**实例级 volatile**，每次启动新建，不跨进程。
- `loadFromFile` 的 ABSENT/isReadOnly 拒绝分支重启时不可达。
- 仓库已有正确先例而 ConfigManager 未采用：`ShopConfigLoader:93`（`isQuarantined = gate.isReadOnly() || corruptFile.exists()`）、`ArenaManager.ensureFile:841-845`、`AdminDeployManager:226-230`。
- `javap` 确认 `saveResource(..., false)` 在目标不存在时全量写且**零日志**；`target/classes` 中 `ConfigManager.class` 的 `'corrupt'` 出现 0 次。

**actual_impact**：重启后控制台没有任何"配置被换成出厂值"的日志，服务器以出厂参数开服（min/max players、victory-waves、waves 波表、monsters 覆盖、hammer/nodes/starter-kit 全部回默认）。管理员之后任意一次保存会把默认值固化。原文完整留在 `.corrupt` 可手工恢复；但**再发生一次隔离会覆盖旧 `.corrupt`**（`REPLACE_EXISTING`）。出厂默认是可玩值，`game-settings` 的 `core.x/y/z` 全库无消费者，故不出现运行期异常——这是降为 low 的核心理由。

**premise_verified**：隔离 = `Files.move(..., REPLACE_EXISTING)`（`YamlFiles:139-152`）；重建 = `saveResource` 目标不存在时 `new FileOutputStream` 全量拷贝；重建目标是 `game-settings.yml`、隔离目标是 `game-settings.yml.corrupt`，不同名不互相覆盖；gate 每次启动新建。

**修复方向**：`initSettingsFile` 补 `corruptFile(file).exists()` 探针（照抄 `ShopConfigLoader:206`），隔离后跨重启持续只读；`initMonstersConfigFile:164-167` 同形。注意 `initDisplayFile` 属作者明示的"删掉应重建"，不应一并改。

---

### S08-F1 — Tab 动画 frame-ticks 按刷新次数计，慢 refresh-ticks 倍

- **verdict**: REACHABLE ｜ **severity**: low（首轮 medium，降级）｜ **confidence**: high
- **文件**: `src/main/java/com/hilltopvillage/mechanics/TabListManager.java:491`

**调用链**：`onEnable:144-145 start()` → `:149 period = tab.refreshTicks()`（出厂 20）→ `:159 runTaskTimer(this::refreshAll, period, period)` → `:309 refreshAll` → `:318 refreshAllUnchecked` → `:343 tick++`（全类唯一写入）→ `:348-351 pushHeaderFooter` → `:414-415 buildBlock` → `:484-496 renderLine` → 缺陷行 `:491 (tick / max(1, frameTicks)) % frames.size()`。

**guard_check**：无缩放补偿（grep 全类 `tick` 仅 123/124/303/343/491，字节码为 `tick = tick + 1`）；`anim` 在 header/footer 与侧边栏共用同一 `parseLine`（`Loader:335-343`）被正常接受；`Math.max(1, …)` 只防 0 不修量纲。唯一实质限制是**出厂 header/footer 无 anim 行**（`display.yml:145-152` 全 key，`:69-71` 示例被注释）——opt-in，不是 guard。

**actual_impact**：管理员按文档写 `frame-ticks: 20` 后，一帧实际持续 `20 × 20 = 400 tick`（20 秒）而非 1 秒；同一数值在侧边栏正常、在 tab 上慢 20 倍。纯视觉，无数据/功能/性能损害；`Component.equals` 缓存（`:424`）反而减少了发包。

**premise_verified**：`CraftScheduler`/`CraftTask` 字节码确认 period 以 tick 计、`MinecraftServer.tickServer` 每 tick `mainThreadHeartbeat`；`frameTicks` 来自 `clampInt(..., 10, [1,200])`；对照 `ArenaScoreboard:381-383 "frame-ticks 的单位是 tick" + tickCounter += refreshPeriodTicks`，`:616` 公式与 `:491` 完全相同——证明预期量纲是 tick。

**修复方向**：`tick += period`（对齐 ArenaScoreboard），或 `:491` 用 `tick * period / frameTicks`。

---

### S08-F2 — 对局中关闭计分板会销毁 boards，重新启用无 re-show

- **verdict**: REACHABLE ｜ **severity**: low（首轮 medium，降级）｜ **confidence**: high
- **文件**: `src/main/java/com/hilltopvillage/mechanics/ArenaScoreboard.java:363`

**调用链**：`/hilltop reloadconfig` → `Handler:422 loadFromFile`（`:1405` 重建 activeConfig、`:1443` 重读 `scoreboard.enabled`）+ `:428 reloadDisplay` → 下一帧 `refreshAll` → `:363 if (!isScoreboardEffectivelyEnabled())` → 对每个 owner `hide()`（`:280 boards.remove`、`:282-284 setScoreboard(main)`）→ `:372 stopTask()`（全类唯一 ticker，`:326`）。

**guard_check**：`show()` 全仓库只有 `ArenaInstance:343 addPlayer` 与 `:575 rejoin` 两处；`startGame/onGameStart/状态切换/onRespawn/reloadconfig:396-453` 都不调用。`ensureTaskRunning` 只在 `show()` 内调用，任务取消后不自愈。`refreshAll` 的 `boards.isEmpty()` 早退（`:375-378`）只 `stopTask`，且任务已停、实际不会再跑到（原 finding 此处表述不准确，结论不变）。`/hilltop reloadconfig` 只重启 tab 任务（`Handler:431-436`），对 scoreboard 无动作。

**actual_impact**：管理员在一局内关→开，场内所有玩家侧边栏消失直到离场重进/断线重连/下一局。丢掉波次、存活人数、等待复活、节点、村民、个人战绩——节点/村民没有第二条常驻展示通道。游戏本身可正常进行，无崩服、无丢数据。违反 `display.yml:13`"立即生效"与类 javadoc `:344-345`"重新打开时动画从关闭处继续"的意图。

**premise_verified**：`hide()` 的 `boards.remove` + 身份校验后 `setScoreboard(main)`；`stopTask` 置 null；开关每帧现算不缓存；`javap -p` 确认 `ArenaScoreboard` 只有 `show/hide/clear` 三个公开入口，无隐藏 re-show。

**修复方向**：`reloadconfig` 在 `false→true` 时遍历活动竞技场对在线成员重新 `show`（幂等覆盖式重建）。

---

### S01-F3 — 清除操作的过期提示只有 clearspawns 一个 i18n 键

- **verdict**: REACHABLE ｜ **severity**: low ｜ **confidence**: high
- **文件**: `src/main/java/com/hilltopvillage/command/HilltopCommandHandler.java:766`

**调用链**：`/hilltop deploy clearmobspawns`（`plugin.yml:11-14`，`onEnable:206 setExecutor`）→ `handle:380-386` 权限 → `handleDeployCommand:1071-1076`（clearvillagers `:1153-1159`、clearspawns `:1000-1005`）→ `requestClear:739-770` → `:764-768 runTaskLater(..., TTL 15_000/50 = 300 ticks)` → `:766 lang.getFor(admin, "deploy.clearspawns-expired", arenaId)`；`:802` 同样硬编码。

**guard_check**：无 guard 阻断；唯一不发消息的路径是 15s 内已 confirm（`:820` 已 remove，任务 `remove(key, fresh)` 返回 false）或同 kind 新请求替换——属正确语义。首次请求必排一个过期任务，故"发起后不确认"必有一次 `:766`。

**actual_impact**：**用户可见危害被推翻**。`messages.yml:489/1591` 的文案本身 kind 中立（"Clear operation for arena {0} timed out and was cancelled." / "针对竞技场 {0} 的清除操作已超时取消。"），不含 spawn/出生点字样；该分支只 `remove` + `sendMessage`，不执行 `clearAction`，无状态/数据影响。真实缺陷只剩：三种 kind 无法分别定制 expired 文案（若管理员把它改成"玩家出生点清除超时"就会误导），以及 TTL 注释声称"6 个 *-expired 文案"实际只有 1 个。若只按用户可见缺陷计分可降 none，但不构成 REJECT。

**premise_verified**：`grep expired` 全资源仅 `messages.yml:489/1591` + legacy 同键；Java 侧仅 `:766/:802` 两处引用；不存在 `clearmobspawns-expired`/`clearvillagers-expired`；`{0}` 占位符与 `LanguageManager:470-492` 的替换一致。

**修复方向**：补 `clearmobspawns-expired` / `clearvillagers-expired`（或 `deploy.clear-expired` 带 kind 参数），修正 TTL 注释。

---

### S02-F5 — 退出向导只删内存 session，不清理持久化 wizard 键

- **verdict**: REACHABLE ｜ **severity**: low ｜ **confidence**: high
- **文件**: `src/main/java/com/hilltopvillage/command/SetupWizard.java:2184`

**调用链**：`/hilltop setup`（`Handler:459-475`）→ `start()` 读 `wizard.step.<uuid>`/`wizard.arena.<uuid>`（`:240/:243`），`savedStep ∈ 1..8` 且同场则直接落到该步（`:248-262`，`savedStep>1` 发 `setup.resuming`）。写入方全部"有 session 就写值"：`autoSave:1684/1686`、`autoSaveSilent:1707/1708`、`start():229/230`、`validateCompletion:1202`；唯一置 null 是成功收尾 `showStepDone:1062/1064 + saveConfig:1065`。缺陷行：`onQuit:2179-2191`（`PlayerQuitEvent`，`HilltopVillagePlugin:186` 注册）只 `clearVillagerPreviews` + `sessions.remove`。`onDisable`、`ArenaResetService:351 invalidateDeploymentContext` 都不碰这些键。

**guard_check**：无 TTL、无版本号、无部署时间戳；`start()` 唯一重置分支是 `savedArena != arenaId`（换场）。**但 `saveexit` 落盘是显式设计**（`:1610` 注释 + `messages.yml setup.saved-exit` 承诺"从上次步骤继续"），所以"重开从第 6 步继续"多数是预期行为，不算缺陷。

**actual_impact**：真正咬人的只有一种组合——`ArenaResetService` 清空部署数据后同 UUID 同场重开：旧 step==8 会被 `validateCompletion:1173-1206` 弹回缺项步骤并给提示（有提示、不卡死、不写坏数据）；旧 step 3~7 则静默落在该步，界面显示空列表，最坏多花几十秒。`config.yml` 不会膨胀（每 UUID 两个短键，按 UUID 覆盖；实测 `plugins/HilltopVillage/config.yml` 的 wizard 段仍是空 map）。

**premise_verified**：`javap` 确认 `JavaPlugin#getConfig` 惰性 reload 返回同一 `FileConfiguration`、`saveConfig` 走 `FileConfiguration.save(configFile)` 整份落盘、`set(path, null)` 即删键。

**修复方向**：不要改成"退出即清"（会废掉掉线续做）；在 `ArenaResetService` 清空部署数据后按 arena 清对应 wizard 记录，或给键加部署版本号。

---

### S03-F5 — 部分 tab 段缺 header/footer 时静默清空 tab 头尾

- **verdict**: REACHABLE ｜ **severity**: low ｜ **confidence**: high
- **文件**: `src/main/java/com/hilltopvillage/config/DisplayConfigLoader.java:201`

**调用链**：手改 display.yml 留下部分 `tab:` 段（`display.yml:57` 明确把板级字段标为"可选，缺省即出厂值"）→ `/hilltop reloadconfig`（`Handler:428` → `ConfigManager.reloadDisplay:264-276` 真读盘）或重启（`initDisplayFile:187-200` → `loadFromFile:1381`）→ `DisplayConfigLoader.parse:113-128`：`hasTab=true` 走 `parseTab`，只有**整段缺失**才回落 `defaults.tab()` → `parseTab:168-199` 对 header/footer 调 `parseOptionalLines:201-212` → 缺陷行 `if (!section.contains(key)) return List.of();` 且无 warning（warning 只覆盖"非 list"）→ `TabListManager.buildBlock:433-445` 空列表返回 `Component.empty()` → `:427` 发出。

**guard_check**：`displayValidator:332-352` 的 `DISPLAY_TAB_KEYS={enabled,header,footer,contexts}` 是 `anyMatch`，只写 `tab: {contexts: {arena: false}}` 也合法通过；`DisplayConfig.Tab:102-114` 不做空列表回填；`ConfigManager:34/129/132/188` 是 `displayFile` 全部引用，`saveToFile:784-794` **明确不写 display.yml**，全仓库无 `YamlFiles.write(displayFile)`——缺失 key 永不会被补上。额外发现：`header:` 写成空键会被 snakeyaml 丢成 absent，同样静默。

**actual_impact**：在线玩家 tab 头/尾整体消失（与 `restoreAll:227`"还原成未接管"等价），player-name/排序/contexts 全部照常，**零控制台提示**，管理员易误判为其他基础设施问题。纯展示层，`reloadconfig` 改回即恢复。

**premise_verified**：`Component.empty()` 返回 `TextComponentImpl.EMPTY` 单例；`Audience.sendPlayerListHeaderAndFooter` 存在；对照 `parseBoard:151-158` 缺 `lines` 显式恢复 `defaultLines()` 且单测 `missingLinesFallsBackToDefaultLayout` 固化了该契约，tab 无对应测试。

**修复方向**：`parseOptionalLines` 对 header/footer 缺 key 时回落 `defaults.tab().header()/footer()` 并给 warning；补一条与 scoreboard 对称的单测。

---

### S03-F6 — 非法数字重新挂起与"打开容器"清空竞争，可复活待输入

- **verdict**: REACHABLE ｜ **severity**: low ｜ **confidence**: medium
- **文件**: `src/main/java/com/hilltopvillage/config/menu/NumericInputHandler.java:211`

**调用链**：`/hilltop config` → 数值槽 SHIFT 点击（如 `MonsterSettingsMenu:322-329`）→ `requestNumber`（`:45-58`，`pendingInputs.put` + 600 tick 超时）→ 管理员输入非数字 → `onChat`（async 线程）：`:172 remove` → `:175 setCancelled` → `:189 parseDouble` 抛 `NumberFormatException` → `:207 sendMessage` → `:211-213` new + put → `:214` 重新调度；同时主线程 `InventoryOpenEvent` → `onInventoryOpen:246-251` → `:249 pendingInputs.remove(uuid)` 单参。若 remove 落在 `:172` 与 `:213` 之间，它删的是空 map，随后 renewed 被放回。

**guard_check**：没有 guard 挡住交错。

- `:249` 是单参 remove，无法按身份匹配尚未创建的 renewed；两参 remove 只在 `:115`（字符串输入）与 `:136`（超时）出现。
- `:214` 的"重调度"实际是**新增任务不取消旧任务**；旧任务靠 `:136` 两参身份匹配空转，不会误杀 renewed。
- `AbstractConfigMenu.onClose:175-182` 只 `unregisterAll`，不碰 `pendingInputs`；且 SHIFT 点击前已 `closeInventory()`。
- 事件优先级不构成互斥：`AsyncPlayerChatEvent`（LOWEST）与 `InventoryOpenEvent`（MONITOR）不在同一 HandlerList。
- 唯一收敛是 `:214` 的 30 秒超时。

**actual_impact**：管理员已在开箱子，但 map 里留着该数值槽条目，30 秒内：下一行公屏聊天被 cancel 吞掉；若解析为数字则 clamp 后**静默改写内存配置**并强行重开菜单把他踢出当前操作；输入 `cancel` 也会触发 `onCancel` 重开。不扩权（本来就有 config 权限），30s 自愈。触发率比原描述更低：`InventoryOpenEvent` 只为真实容器触发，按 `E` 开自己背包不触发；`sendMessage` 不同步等主线程，窗口仅微秒级。

**premise_verified**（字节码）：`handleChat → thenApplyAsync(chatExecutor) → FutureChain(chatExecutor).append → chat(..., true) → ChatProcessor(async=true) → callEvent(AsyncPlayerChatEvent)`，`chatExecutor = Executors.newCachedThreadPool`；`InventoryEvent` 走 `Event(Z=false)` 故在主线程；`ConcurrentHashMap` 的 remove/put 非原子。因"撞窗口"只能运行时复现，confidence 定 medium（若口径要求"必须已复现"可等价降 `NEEDS_RUNTIME_CHECK`，严重度仍 low）。

**修复方向**：把 `:172` 的 remove 改为"先标记输入模式失效"，或在 `:213` 用 `compute`/双参 remove 保证只有仍处于输入模式时才放回；`onInventoryOpen` 用 `remove(uuid, current)` 并同时置一个"已离开输入模式"标志。

---

### S05-F6 — arenas.yml 写盘失败后仍用新值替换内存状态

- **verdict**: REACHABLE ｜ **severity**: low ｜ **confidence**: high
- **文件**: `src/main/java/com/hilltopvillage/admin/AdminDeployManager.java:530`

**调用链**：`/hilltop deploy setcore|addspawn|addmobspawn|addvillager|setwaiting|setshop`（`Handler:905/946/1018/1100/919/1173`）或 SetupWizard 第 1/2 步（`:1262/:1280`）或 ArenaManageGUI 删除 → 都汇入 `AdminDeployManager.saveSpawnPoints:454` → 两道早退（`:457-462 writable`、`:474-478 usable/isReadOnly`）→ 序列化 `:481-524` → 缺陷行 `:527 boolean saved = gate.write(arenasConfig);` → `:530-534` **无条件** `gameManager.setSpawnPoints/setMobSpawnPoints/setCoreLocation`；`saved` 只在 `:537-539`（商店二次写盘）与 `:541 lastSaveFailed` 被读。

**guard_check**：`YamlFileGate.write:88-99` 把 `IOException` catch 成 `false` **不传播**，所以 `:527` 之后方法体继续执行、push 必然运行；add/set 方法在调用 save 前已改 `saved*` 列表，失败也不回滚。

- 注意：第一轮锐评的"只读到不了 :530"**只对插件闸门 read-only 成立**；文件系统层只读（磁盘满/只读属性/ACL/tmp 被占用）走 `YamlFiles.write → IOException → false`，**恰好会到达 :530**。
- 同文件 `:781-786` 的注释（"先写盘再推送……推送只在成功后才做"）证明这是遗漏而非设计。

**actual_impact**：管理员会连续收到"已设置/已添加…"与 `deploy.save-failed`（`messages.yml:208/1293` 明说"仅在内存、重启丢失"），**失败并非静默**。真实危害收窄为：(a) 运行中的场立刻使用未落盘坐标（但这些坐标正是管理员刚设的）；(b) 管理员照着提示手改 YAML 后，任意一次成功 save 会用 `saved*` 整份覆写这些键，手改被静默回滚；(c) 提示说"重启会丢"并不总成立——下一次成功 save 会把它写盘，改动"复活"；(d) `/hilltop deploy reloadnodes` 的 `loadSpawnPoints:216-318` **只重建 AdminDeployManager 列表、不调 `gameManager.set*`**，所以运行实例不会恢复，自愈只发生在下次成功写盘或重启。另：`:537-539` 商店二次写盘失败也会 `saved=false`，此时出生点/核心其实已落盘却仍提示"仅在内存"（反向误导）。

**premise_verified**：`YamlFiles.write:111-131` 用同目录唯一 tmp + `Files.write` + `ATOMIC_MOVE`，仅 `AtomicMoveNotSupportedException` 降级普通 move，失败时目标文件原样；`GameManager.setSpawnPoints/setCoreLocation:889-905` 只是字段替换；`ArenaInstance:992-1017` 实时读 GameManager 而非 definition 快照。

**修复方向**：`:527` 后 `if (saved) { push... }`（或失败时回滚 `saved*`）；把 `:537-539` 的二次失败与主写失败区分文案。与 S05-F1 可合并修。

---

### S08-F3 — 未托管 context 仍推送空 header/footer，覆盖其他插件

- **verdict**: REACHABLE ｜ **severity**: low ｜ **confidence**: high
- **文件**: `src/main/java/com/hilltopvillage/mechanics/TabListManager.java:417`

**调用链**：`onEnable:144-145 start()`（`tab.enabled=true`）→ 每 20 tick `refreshAll:309` → `refreshAllUnchecked:318` → `:320 getOnlinePlayers` → `:324` 唯一全局闸门 `tab.enabled` → `:348-351 for (viewer : online) pushHeaderFooter`（**无 isManaged 过滤**）→ `:402-408` 算 `managed`，`:412 if (managed) … else :417-418 header/footer = Component.empty()` → `:427 sendPlayerListHeaderAndFooter` 无条件发出 → `:428-429` 缓存空值。加入路径 `PlayerJoinEvent → apply → forcePush:255-267 → :262 pushHeaderFooter` 同样命中。

**guard_check**：`isManaged` 只在第二遍（名字/排序）`:358` 被调用；`pushHeaderFooter` 自己算的 `managed` 走 else 时不 `continue` 而是发空。`forcePush:258-259` 每次 join/reloadconfig 清缓存，保证至少清一次。`tab.enabled=false` 时 `:331 clearCaches()` 反而安全。出厂 `display.yml:139-142` 与 `DisplayConfigLoader:184-186` 三个 context 全 `true`——必须管理员显式关掉才可达，这是配置前提不是代码 guard。

**actual_impact**：分三档——(a) 无第三方 tab：头/尾为空，与"本插件不管这块"预期一致，无损害；(b) 第三方周期重发：亚秒闪烁，肉眼通常不可见；(c) 第三方只在 join/状态变化时设置一次：那一份被 Hilltop 的 join `forcePush` 或首帧清掉并保持空白，**这是唯一有持续可见损失的路径**。注意缓存使擦除是**一次性**，锐评的"keeps it blank"不成立（不会持续压制对方后续写入）。真正价值是类内语义矛盾：名字/排序是"复位+不再碰"，头/尾是"主动发空"，违反 `T4.1` 注释 `:354-357` 与 README:528 "不会和别的插件抢"。

**premise_verified**（`javap` 于 `paper-1.21.4.jar`）：`CraftPlayer#sendPlayerListHeaderAndFooter` = `putfield playerListHeader` + `putfield playerListFooter` + `new ClientboundTabListPacket(h,f)` + `send()`——单字段整体替换、非追加；`Component.empty()` 返回 `TextComponentImpl.EMPTY`。

**修复方向**：`:417-418` 改 `continue`（不碰未托管玩家的头/尾）。

---

### S08-F4 — restoreAll 会重置插件从未设置过的 name/order

- **verdict**: REACHABLE ｜ **severity**: low ｜ **confidence**: high
- **文件**: `src/main/java/com/hilltopvillage/mechanics/TabListManager.java:225`

**调用链**：`HilltopVillagePlugin#onDisable:237-244`（实调 `:240`，**全仓库唯一** `restoreAll` 调用点）→ `restoreAll:215-219 touched = lastHeader ∪ lastFooter ∪ lastName ∪ lastOrder` → `:225-226` 对每个在线 UUID 无条件 `playerListName((Component) null)` + `setPlayerListOrder(0)` → `:227` 再发空头尾。`touched` 主要由第一遍 `pushHeaderFooter` 填充（每个在线 viewer 都会写 `lastHeader/lastFooter`，含 unmanaged 的 empty），而 `resetNameAndOrder:382-391` 只 remove `lastName/lastOrder`，无法把 UUID 从头/尾缓存摘掉。

**guard_check**：`ensureMainThread` 在 onDisable 恒真；`player == null || !isOnline` 只过滤离线；`tab.enabled=false` 时 `:331 clearCaches()` 反而保护（缓存空则不遍历）；`isManaged` 只作用于第二遍；不存在单独的 `pushedName/pushedOrder` 集合（`:112-118` 四张缓存即全部状态）。**修正锐评**：`/hilltop reloadconfig`（`Handler:396-453`）只 `start()`+`refreshNow()`，**不**触发 `restoreAll`；只有插件级 disable/reload（stop、`/reload`、PlugMan）会。

**actual_impact**：`tab.enabled=true` + 某 context 关闭 + 装第三方 tab 插件 + 插件级禁用/重载 → 所有在线玩家（含大厅里 Hilltop 声明不管理的玩家）的 listName 被写 null、listOrder 写 0 并广播 `UPDATE_DISPLAY_NAME`/`UPDATE_LIST_ORDER`，头/尾也发空。对方周期性重推则一闪即恢复；diff/缓存式推送则可能一直保持默认直到该玩家状态变化。无第三方插件时等价于原版默认，无损害。**触发面比锐评更宽**：`touched` 在 `tab.enabled=true` 时恒等于最近一帧全部在线玩家，不只是"被关掉的 context"。

**premise_verified**（`javap` 字节码）：`Player#playerListName(Component)`/`setPlayerListOrder(int)` 存在；`CraftPlayer#playerListName` 对 null 走 `aconst_null → putfield ServerPlayer.listName`（非 NPE），getter 回落 `Component.text(getName())`；`setPlayerListOrder` 只拒绝负数；广播包用 `FriendlyByteBuf.writeNullable` 编码，客户端回落 GameProfile 名。现有单测 `TabListManagerTest#onlyTouchedPlayersAreRestored:396-413` 只构造"缓存为空"的玩家，未覆盖"只有头/尾缓存、无 name/order"，故测试通过不构成反证。

**修复方向**：`restoreAll` 只遍历 `lastName ∪ lastOrder` 还原 name/order，头/尾单独只清空；或维护显式 `pushedName/pushedOrder` 集合；`forcePush:255-267` 也复用 `isManaged`（否则关闭 context 的新玩家加入时会闪一下本插件的名字/分带）。

---

## 3. REJECT（0 条）与被排除的候选路径

**本轮 13 条没有一条判 REJECT。** 每条都至少有一条从真实入口（命令/事件/定时任务/onEnable）到缺陷行的完整链路，且中途没有"读到取消状态/提前 return/开关关闭"的 guard 把它完全挡住。

为避免"确认偏误"，下面列出**被认真检查后排除**的候选路径（它们本可以让某条变成 REJECT，但核实后不成立）：

| 候选"挡板" | 涉及 | 核实结果 |
|---|---|---|
| `/hilltop reloadconfig` 会重读 arenas.yml | S10-F1 | **不成立**：`Handler:396-453` 只 reset gate + 重载 settings/display/messages；`:446-447` 明确提示需重启。但它会解闩且不校验，反而制造"以为已恢复"的二次误导 |
| 插件自己会写出 world-only 段，属正常升级 | S10-F1 | **不成立**：`AdminDeployManager` 只写坐标/core/shop-npc，`ArenaManager.updateGameParams` 只写 `game.*`，无 addarena 命令；入口只能是手工编辑 |
| `gate.writable()` 能挡住会话中的隔离 | S10-F1 | **不成立**：`saveSpawnPoints:458` 先查 `writable()`（此刻 true），`:471 load()` 才隔离并置 latch，`:474` 才中止——顺序本身是缺陷的一部分 |
| Shift+点击可自定义任意护甲，故 S03-F2 不成立 | S03-F2 | **部分成立**：`MonsterSettingsMenu:280-292` 确实是逃生口，但普通点击路径仍写头盔、会破坏已正确值，且 `WaveSettingsMenu.MonsterPropMenu` 无 Shift 分支 |
| 隔离后 `.corrupt` 会一直只读，不会重建 | S03-F3 | **不成立**：`YamlFileGate.readOnly` 是实例级 volatile，每次启动新建；`ConfigManager` 无 `corrupt` 探针（编译类中 `'corrupt'` 出现 0 次） |
| 只读闸门能挡住 S05-F6 的 push | S05-F6 | **部分成立**：插件闸门 read-only 确实早退；但 OS 级只读走 `YamlFiles.write → IOException → gate.write=false`，恰好到达 `:530` |
| 打开任意容器都会清空待输入，S03-F6 不可达 | S03-F6 | **部分成立**：`E` 开自己背包不触发 `InventoryOpenEvent`，只含真实容器；但真实容器仍可撞窗口 |
| `saveexit` 落盘是缺陷 | S02-F5 | **推翻**：`:1610` 注释与 `setup.saved-exit` 文案都明确"从上次步骤继续"，属设计；只有"重置后同场重开"才是真缺陷 |
| 过期提示会误导管理员重复清除 | S01-F3 | **推翻**：文案 kind 中立、分支不执行 `clearAction`；缺陷只剩 i18n 键不对称 |
| 整段缺 `tab:` 会清空头尾 | S03-F5 | **推翻**：`:126-128` 整段缺失回落 `defaults.tab()`；只有"部分 tab 段缺 header/footer"才命中 |
| `anim` 只在侧边栏生效，tab 不接受 | S08-F1 | **不成立**：header/footer 与侧边栏共用 `parseLine`，`anim` 正常解析 |
| `tab.enabled=false` 时 restoreAll 会乱改 | S08-F4 | **不成立**：`:331 clearCaches()` 使缓存为空，`restoreAll` 不遍历 |
| 第三方保护插件是 S07-F3 的唯一前提 | S07-F3 | **推翻**：Paper 对旁观者右键在 `callEvent` 前预置 `DENY`，配合插件自己的 `SPECTATOR + keepInventory` 流程，纯 Paper 即可复现 |

---

## 4. 横向根因族与修复优先级

按"一处修复覆盖多条"排序：

**P1 — 配置隔离/重建协议不一致（S10-F1 + S03-F3 + S05-F6）**

- 三个文件（`arenas.yml` / `game-settings.yml` / `monsters-config.yml`）都缺"隔离后跨重启持续只读"的探针；`ShopConfigLoader:93`、`ArenaManager.ensureFile:841` 已有正确先例。
- `AdminDeployManager.saveSpawnPoints` 的 `writable() → load() → isReadOnly()` 顺序使"检查通过后 load 才隔离活文件"，应改为"先 load 再判断"。
- `:527` 的 `saved` 未参与 push 决策，与同文件 `:781-786` 的纪律自相矛盾。
- 建议一次性引入统一的 `QuarantineAwareLoad`：`corruptFile.exists()` 时拒绝 `saveResource`、拒绝写、并在 `/hilltop reloadconfig` 输出"文件仍处于隔离态"。

**P2 — Tab 头/尾与名字/排序两套 managed 判定（S08-F3 + S08-F4 + S08-F1）**

- 同一处根因：`pushHeaderFooter` 不看 `isManaged`、`forcePush` 不看 `isManaged`、`restoreAll` 用四张缓存并集。
- 建议：统一 `isManaged` 判定；`else` 分支改 `continue`；`restoreAll` 分开还原 name/order 与 header/footer；顺手把 `tick += period` 修掉（S08-F1）。

**P3 — 事件/状态机 guard 缺失（S07-F3 + S03-F6 + S08-F2）**

- `NodeListener:172` 补 `ignoreCancelled=true` + SPECTATOR/isAlive 门控。
- `NumericInputHandler:172/:213` 改为原子化（`compute` 或"输入模式失效"标志）。
- `ArenaScoreboard` 在 `reloadconfig` 的 `false→true` 边沿补 re-show。

**P4 — 文案/i18n 与文档契约（S01-F3 + S03-F5 + S02-F5）**

- 补 `clearmobspawns-expired`/`clearvillagers-expired`；`parseOptionalLines` 对 header/footer 回落默认并 warning；`ArenaResetService` 清 wizard 键。
- `display.yml:57` 的"板级字段可选，缺省即出厂值"与实现不符，应改文档或改实现（二选一，不要两边都留）。

**P5 — 纯展示/低优先（S08-F1 的动画节奏、S03-F2 的护甲表）**

- 护甲表按槽位拆分并让 `cycleMaterial` 保留未知值，属独立小修。

---

## 5. 方法与可信度说明

- **只读约束**：目标仓库全程未修改；所有输出写入 `.run-hv/deep/`。唯一的临时探针（S10-F1 的 validator 复刻）放在工件目录 `deep/probe/`，跑完即删。
- **字节码核实**：`EventHandler` 注解默认值、`RegisteredListener.callEvent` 的 ignoreCancelled 分支、`CraftEventFactory` 的预取消顺序、`CraftPlayer.playerListName` 的 null 语义、`CraftScheduler` 的 period 单位、`MemorySection` 的 LinkedHashMap、`saveResource` 的写文件分支——均用 `javap -v/-c` 于 `paper-1.21.4.jar` / `paper-api-1.21.4` 核对，并与 `target/classes`、线上 `plugins/HilltopVillage-...-fix2.jar` 交叉验证。
- **未做运行时验证**：没有启动 1.21.4 服务端，没有抓包。因此 `S03-F6` 的交错窗口给 `confidence: medium`（机制与路径成立，撞窗口概率只能实测）；`S07-F3` 的旁观者路径基于服务端字节码，置信度高但非实测。两者都不影响 `REACHABLE` 判定。
- **降级原则**：只要"触发需要非默认配置/管理员主动操作 + 后果为展示层或可恢复 + 有自愈路径"，一律从 medium 降到 low（S03-F3、S08-F1、S08-F2）；"后果被文案/默认值/二次校验兜住"的维持 low（S01-F3、S02-F5、S03-F5）。反之，即使需要管理员操作，只要"一次误操作即可破坏已正确配置并持久化"（S03-F2）或"违反插件自己立的规则且能改变战局"（S07-F3），维持 medium。
- **口径分歧已记录在各 JSON 的 notes**：S03-F3（可维持 medium）、S08-F1（可维持 medium）、S03-F6（可降 NEEDS_RUNTIME_CHECK）、S01-F3（可降 none）。若团队口径不同，按 notes 里的条件调整即可，无需重新核实事实。
