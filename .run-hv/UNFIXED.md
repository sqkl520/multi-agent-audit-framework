# Hilltop Village 未修复缺陷清单

**目标仓库**：`D:/Server/MCServers/Server plugin/Hilltop Village/Hilltop Village Plugin`
**基线提交**：`12f62da`
**审计时间**：2026-11-19
**规模**：75 个主源文件 / 34,193 行 Java（Paper 1.21.4）

**数据来源**：本清单完全来自 `.run-hv/` 下的原始审计产物，未做人工二次核实。
每条都标了可回溯的文件路径。

| 阶段 | 条数 |
|---|---|
| 一轮发现 | 45 |
| 独立锐评后确认 | 13 |
| 独立锐评后降级 | 22 |
| 独立锐评后撤销（误报）| 6 |
| 其中已深挖 | 13 |
| **已修复** | **3（P1 根因族）** |
| **本清单收录（未修）** | **36** |

> **关于严重性**：13 条深挖过的降到了 `0 high / 3 medium / 10 low`。
> 表格里给的是**深挖后的最终判定**；没深挖的 32 条给的是锐评后的判定。
> 深挖口径明显更严——它要求给出完整调用链和实际危害，所以数字更保守。

---

## 一、已修复（供对照，不在此清单范围）

提交 `2abd942`「隔离后跨重启仍不得重建出厂模板」修复了 P1 根因族：

| ID | 位置 | 问题 |
|---|---|---|
| S03-F3 | `ConfigManager.java:147-149` | Quarantined game-settings.yml is silently recreated from jar defaults on the next start |
| S05-F6 | `AdminDeployManager.java:530-534` | Failed arenas.yml write still replaces the live arena's spawn points and core in memory |
| S10-F1 | `YamlFiles.java:226-229` | Arena validator quarantines a legal multi-arena arenas.yml when a later arena only declare |

---

## 二、未修复清单（36 条）

### 中危（7 条）

#### S03-F1 · Failed reload marks in-memory edits as saved and hides the save button

- **位置**：`ConfigManager.java:1391-1394`
- **状态**：锐评确认（首轮 high → 终判 medium）
- **问题**：loadFromFile() takes the "file unusable / gate read-only" early return but first executes lastSavedSnapshot = activeConfig.snapshot(). The snapshot is taken from the still-modified in-memory config, so hasUnsavedChanges() (lines 307-313) compares the config against itself and returns false. MainConfigMenu then renders the GREEN_WOOL "up to date" item and omits the save button, while the load failu
- **影响**：Admin GUI edits (wave tuning, monster stats, rules) made while game-settings.yml was locked/corrupt are reported as persisted: the save button disappears, no retry is offered, and the next restart rebuilds activeConfig from disk, discarding every edit with no further trace.
- **证据**：`settingsLoadedFromDisk = false; loadMonstersConfig(); lastSavedSnapshot = activeConfig.snapshot(); return false;`
- **原始数据**：`.run-hv/findings/` + `.run-hv/critiques/S03-F1.json`

#### S03-F2 · Armor cycle list holds only helmets, so chest/legs/boots slots store helmet materials

- **位置**：`MonsterSettingsMenu.java:400-404`
- **状态**：深挖确认
- **问题**：addArmorSlot() is invoked for helmet, chestplate, leggings and boots (lines 191-198) but every call passes the single ARMOR_CYCLE array, whose entries are all helmets (LEATHER/CHAINMAIL/IRON/DIAMOND/NETHERITE/GOLDEN_HELMET) plus AIR. A plain click on the chestplate/leggings/boots slot therefore executes mc.setChestplate(LEATHER_HELMET) etc. WaveSettingsMenu.MonsterPropMenu reuses the same all-helm
- **影响**：管理员在 /hilltop config -> Monsters（slot 23）中左键点“胸甲”槽：候选序列从 LEATHER_HELMET 开始，每次点击在六种头盔与 AIR 之间循环，字段 chestplate 被写成 LEATHER_HELMET/IRON_HELMET…；点“护腿”“靴子”同理。下一次刷怪时 WaveManager:525-542 把该材质放进 EquipmentSlot.CHEST/LEGS/FEET，客户端按物品自身 equipment asset 渲染，会出现部位与模型不符（头盔模型挂胸/腿/脚位）或该部位看起来仍是空装备；掉落表也被设为 0.05，玩家可能捡到“胸甲位掉出的头盔”。更糟的是破坏性覆盖：若该字段原本由 Shift 输入或手改 YAML 配成真实的 IRON_CHESTPLATE，它不在 ARMOR_CYCLE 中，cycleMaterial:
- **调用链**：入口: 玩家执行 /hilltop config，HilltopCommandHandler:388-393 校验 hilltopvillage.config.admin（plugin.yml:36-38 默认 op，hilltopvillage.admin 的 child）后调用 handleConfigCommand(sender,args) → 中间: handleConfigCommand:599-644 -> new MainConfigMenu(...) + registerEvents + menu.open()；MainConfigMenu:22-24 buildMenu，slot 从 19 起每项 +2，怪物入口落在 slot 23（MainConfigMenu:60-66
- **证据**：`private static final Material[] ARMOR_CYCLE = { Material.LEATHER_HELMET, Material.CHAINMAIL_HELMET, Material.IRON_HELMET, Material.DIAMOND_HELMET, Material.NETH`
- **原始数据**：`.run-hv/findings/` + `.run-hv/deep/S03-F2.json`

#### S04-F1 · Countdown and match start count offline retained members, so a match can start with nobody online

- **位置**：`ArenaInstance.java:1123-1129`
- **状态**：锐评确认（首轮 high → 终判 medium）
- **问题**：The STARTING countdown validates the player count with getPlayerCount(), which is players.size() (membership), not the online player count. When settings.auto-leave-on-quit=false, MultiArenaManager.handleQuit keeps the member's UUID in the arena (keepPosition = !isAutoLeaveOnQuit() || inProgress), so the count never drops when players disconnect. Every other liveness path in this class uses getPla
- **影响**：With auto-leave-on-quit disabled (a documented setting), a countdown started while members are online keeps running after all of them disconnect; the match starts with zero online players, spawns a full wave and villagers, loses all villagers/nodes unattended, and the settlement path then records a defeat (sessionVictory=false) for every offline member during reset()'s backfill (recordOffline). Th
- **证据**：`if (getPlayerCount() < getMinPlayers()) {`
- **原始数据**：`.run-hv/findings/` + `.run-hv/critiques/S04-F1.json`

#### S05-F4 · Core coordinates are read without an isSet guard, so a damaged core node becomes core (x, y, 0) and is later p

- **位置**：`AdminDeployManager.java:278-283`
- **状态**：未锐评
- **问题**：The core node is read with ConfigurationSection#getDouble and no isSet/finite check. Bukkit returns 0.0 for a missing key, so a core section that lost one coordinate (hand edit, truncated write, or a file written by an older schema) is accepted as a valid core at that 0 coordinate instead of being treated as undeployed. The same class does guard the other nodes it reads (readLocation() at line 420
- **影响**：Any subsequent deployment action on this arena (addspawn, setcore of another field, setshop, removeVillager...) calls saveSpawnPoints(), which writes the invented core back to arenas.yml (line 514-516) and pushes it to gameManager. The core then genuinely is at coordinate 0 on that axis: the arena counts as deployed (hasCore true, enableArena allowed), players respawn/teleport to the world origin 
- **证据**：`if (arenasConfig.isConfigurationSection(corePath)) { double cx = arenasConfig.getDouble(corePath + ".x"); double cy = arenasConfig.getDouble(corePath + ".y"); d`
- **原始数据**：`.run-hv/findings/` + `.run-hv/critiques/S05-F4.json`

#### S07-F3 · Node repair interaction handler lacks ignoreCancelled, so a denied right-click still consumes repair items

- **位置**：`NodeListener.java:172-175`
- **状态**：深挖确认
- **问题**：Every other handler in this class declares ignoreCancelled = true (onBlockBreak line 103, onEntityExplode 114, onBlockExplode 124, onBlockExplosionDamage 145), but the repair handler is registered at NORMAL with no ignoreCancelled and never tests event.isCancelled(). A PlayerInteractEvent already cancelled by a region/protection/adventure-mode plugin still reaches the repair branch at lines 208-24
- **影响**：两条独立触发路径，其中第一条不依赖任何第三方插件：(A) 竞技场内阵亡玩家：PlayerLifecycleListener:83 setAlive(false) 且 :97 setKeepInventory(true)（掉落物清空但背包保留），:203 切 GameMode.SPECTATOR；该玩家仍留在 gameManager.playerDataMap 中，仍能飞行并右键节点。旁观者右键时服务端在事件派发前就把 useInteractedBlock 置为 DENY（PlayerInteractEvent.isCancelled()==true），但 NodeListener 不检查，于是 repairNode 回血、向全队广播 node.repaired、并扣掉手上的世界树汁液（默认 GHAST_TEAR x1，repair-amount-per-cost 50）。即『已死亡/旁观者
- **调用链**：入口: 玩家右键方块 -> ServerboundUseItemOnPacket -> ServerGamePacketListenerImpl.handleUseItemOn（isImmobile 检查 -> canInteractWithBlock 距离检查 -> ServerPlayerGameMode.useItemOn） → 中间: ServerPlayerGameMode.useItemOn -> CraftEventFactory.callPlayerInteractEvent(..., boolean useInteractedBlockDeny, boolean useItemInHandDeny, ...) —— 旁观者且方块无 MenuProvider 时该方法在 ca
- **证据**：`@EventHandler(priority = EventPriority.NORMAL) public void onPlayerInteract(PlayerInteractEvent event) { if (event.getHand() != EquipmentSlot.HAND) return; if (`
- **原始数据**：`.run-hv/findings/` + `.run-hv/deep/S07-F3.json`

#### S09-F1 · Unusable shop.yml throws out of onEnable and takes the whole plugin down

- **位置**：`ShopConfigLoader.java:110-112`
- **状态**：锐评确认（首轮 high → 终判 medium）
- **问题**：load() throws IllegalStateException for every unusable read (blank file, parse failure, quarantined/absent-after-quarantine). ShopManager.reload() assigns this.config = loader.load() at ShopManager.java:56 with no try/catch, and HilltopVillagePlugin.onEnable calls shopManager.reload() at line 120 without the fault isolation applied to PlayerGoodsManager/StatsManager (lines 105-116 catch Throwable)
- **影响**：A single empty or corrupt plugins/HilltopVillage/shop.yml aborts onEnable, so the plugin never enables: no arenas, no worlds, no /hilltop commands, no listeners. Recovery requires manually repairing/removing shop.yml and restarting; the config is core to the whole plugin, not just the shop.
- **证据**：`throw new IllegalStateException("Cannot use shop.yml (" + loaded.status() + ")" + (detail == null ? "" : ": " + detail) + ". Refusing to replace the live shop w`
- **原始数据**：`.run-hv/findings/` + `.run-hv/critiques/S09-F1.json`

#### S09-F2 · MATERIAL item without icon.material charges full price and delivers a barrier block

- **位置**：`ShopConfigLoader.java:289-292`
- **状态**：锐评确认（首轮 high → 终判 medium）
- **问题**：parseItem keeps a MATERIAL entry that has no icon.material and leaves icon at the BARRIER default (line 260). Because deliverItem builds the shipped product from that same field (ShopManager.java:135: return new ItemStack(item.getIcon(), amount);), the fallback is not display-only: it is what the player receives. The in-code comment admits the residual gap. The purchase path (ShopListener.purchase
- **影响**：A player pays the full configured price and receives a BARRIER (a non-survival, unusable block), i.e. a guaranteed currency loss per purchase, repeatable for as long as the admin leaves the entry unconfigured. The only signal is a startup warning line.
- **证据**：`if ("MATERIAL".equals(type) && !iconConfigured) { plugin.getLogger().warning("shop.yml: MATERIAL item '" + id + "' is missing icon.material; keeping the item wi`
- **原始数据**：`.run-hv/findings/` + `.run-hv/critiques/S09-F2.json`

### 低危（29 条）

#### S01-F2 · Shop respawn failure is swallowed and the whole startup path is left half-initialized

- **位置**：`HilltopVillagePlugin.java:158-159`
- **状态**：锐评确认（首轮 medium → 终判 low）
- **问题**：respawnFromConfig() returns void and internally only logs a warning when spawnNpc() fails (NpcManager:301-305), and spawnNpc() returns false both for an invalid world and for the 'another arena is mid-match' cross-world guard. The caller discards this outcome entirely: no retry, no gate, no state marking. Directly after it, cleanupOrphans() (line 159) deletes every PDC-marked shop villager that is
- **影响**：Lobby/arena shop silently disappears for the whole session (no NPC, no 'shop unavailable' signal), while /hilltop shop give still hands out currency that cannot be spent; the only trace is a single warning line. Because ShopManager is treated as a non-degradable core module (comment at lines 100-104), this is an inconsistency between the stated policy and the actual behaviour.
- **证据**：`this.shopManager.getNpcManager().respawnFromConfig();`
- **原始数据**：`.run-hv/findings/` + `.run-hv/critiques/S01-F2.json`

#### S01-F3 · Pending-clear expiry message always says clearspawns even for mob/villager clears

- **位置**：`HilltopCommandHandler.java:766`
- **状态**：深挖确认
- **问题**：requestClear() is shared by all three ClearKind values (SPAWN, MOB_SPAWN, VILLAGER) and every other message in that method is dispatched through kind-keyed helpers (warningKey/confirmKey/alreadyKey). The expiry callback is the one exception: it hardcodes "deploy.clearspawns-expired", whose text is 'Clear operation for arena {0} timed out and was cancelled.' The same hardcoded key is repeated in co
- **影响**：管理员在竞技场世界执行 /hilltop deploy clearmobspawns（或 clearvillagers）后 15 秒内未输入 confirmclearmob / confirmclearvillagers，会在聊天栏收到一条过期提示；英文为 '&7Clear operation for arena &f{0} &7timed out and was cancelled.'，中文为 '&7针对竞技场 &f{0} &7的清除操作已超时取消。' 文案本身 kind 中立，既未写 'spawn' 也未写 'player spawn point'，所以玩家/管理员看到的信息在语义上是正确的（清除未执行、已取消），不存在「误以为玩家出生点清除被取消」的误导——缺陷只体现为代码/资源键名用了 clearspawns-* 前缀。状态与数据影响为零：该分支只做 pendingClears.r
- **调用链**：入口: /hilltop deploy clearmobspawns（plugin.yml:11-14 声明 hilltop 命令，无 executor 字段；HilltopVillagePlugin.onEnable:206 registerCommandHooks("hilltop", tabCompleter) 调 pluginCommand.setExecutor(this) 绑定 HilltopCommandHandler；HilltopCommandHandler.handle:380-386 case "deploy" 先过 sender.hasPermission("hilltopvillage.admin")（plugin.yml:26-28 default: op）再进 
- **证据**：`admin.sendMessage(lang.getFor(admin, "deploy.clearspawns-expired", arenaId));`
- **原始数据**：`.run-hv/findings/` + `.run-hv/deep/S01-F3.json`

#### S02-F1 · Wizard GUIs cancel clicks but never cancel InventoryDragEvent, so items can be dragged into and destroyed by t

- **位置**：`SetupWizard.java:1749-1750`
- **状态**：锐评确认（首轮 medium → 终判 low）
- **问题**：SetupWizard registers only an InventoryClickEvent handler. A drag from the player's inventory into the wizard's top inventory fires InventoryDragEvent, which nothing in this class handles, so the stated invariant (no item movement inside wizard GUIs) holds only for clicks. Every wizard inventory is a throw-away Bukkit.createInventory() (buildSpawnsOverview/buildSpawnGui/buildMobSpawnGui/showVillag
- **影响**：An admin who drags (or double-click-collects into) a wizard GUI loses the dragged items permanently with no message; the GUI also stops reflecting the deployed data until reopened.
- **证据**：`// 防御：向导 GUI 内一律禁止移动物品（即使 session 意外丢失） event.setCancelled(true);`
- **原始数据**：`.run-hv/findings/` + `.run-hv/critiques/S02-F1.json`

#### S02-F2 · Wizard identifies its GUIs by comparing the view title to the player's current-locale string, so a mid-session

- **位置**：`SetupWizard.java:1746-1747`
- **状态**：锐评确认（首轮 medium → 终判 low）
- **问题**：The handler rebuilds the expected titles with lang.getFor(player, ...) at click time (lines 1738-1743) and returns early when the view title does not match. The title stored in the open inventory was rendered with the locale that was active when the GUI was opened, so running /hilltop lang <other> while a wizard GUI is open makes the comparison fail. Because the early return happens before event.s
- **影响**：A locale switch locks the admin out of the open wizard GUI (silent, no error), and the now-unguarded view lets items be shifted out of / into a temp inventory that is cleared on refresh, destroying the moved items.
- **证据**：`if (!title.equals(overviewTitle) && !title.equals(spawnsTitle) && !title.equals(mobSpawnsTitle) && !title.equals(nodesTitle) && !title.equals(villagersTitle) &&`
- **原始数据**：`.run-hv/findings/` + `.run-hv/critiques/S02-F2.json`

#### S02-F3 · Spawn/mob-spawn deletion discards removeSpawnPoint/removeMobSpawnPoint's boolean and reports success for a sta

- **位置**：`SetupWizard.java:1945-1951`
- **状态**：锐评确认（首轮 medium → 终判 low）
- **问题**：AdminDeployManager.removeSpawnPoint(index) returns false for an out-of-range index and true only when the element was actually removed, but the return value is dropped here, and the same pattern is repeated for mob spawn points at line 2016 (removeMobSpawnPoint). The "spawn point #N removed" message, the page clamp and autoSave(player) therefore all run on a no-op. The villager branch does check i
- **影响**：The admin is told a point was deleted and shown a "saved" confirmation while the point is still deployed; the GUI is re-rendered from the unchanged list, so the entry reappears and the deletion appears to have silently failed.
- **证据**：`deploy(player).removeSpawnPoint(idx); // If removing caused current page to become empty, go back one page int totalAfter = deploy(player).getSpawnPoints().size`
- **原始数据**：`.run-hv/findings/` + `.run-hv/critiques/S02-F3.json`

#### S02-F4 · Preview-GUI reset and validation bounces change s.step without persisting it, so a disconnect resumes at the a

- **位置**：`SetupWizard.java:2171-2174`
- **状态**：锐评确认（首轮 medium → 终判 low）
- **问题**：Wizard progress is persisted only inside autoSave/autoSaveSilent (wizard.step.<uuid> at lines 1684 and 1707) and in validateCompletion (line 1202). The [Reset Setup] button sets s.step = 1 and calls showStep with neither, and the mandatory-field bounces in the same handler (s.step = 3 / 5 / 6 at lines 2140, 2148, 2155, 2162) do the same. In contrast the goto path persists explicitly (s.step = targ
- **影响**：If the admin disconnects (or the server stops) after a reset or a validation bounce, the next /hilltop setup in the same arena restores the stale step from config.yml instead of step 1, so the reset silently did not stick: the admin is dropped back onto the abandoned step (e.g. straight into showStepPreview at step 7) rather than restarting the wizard as the button promised, and must notice the mi
- **证据**：`case "setup-reset": player.closeInventory(); s.step = 1; showStep(player, s);`
- **原始数据**：`.run-hv/findings/` + `.run-hv/critiques/S02-F4.json`

#### S02-F5 · Quit path drops the in-memory session but never clears the persisted wizard.step/wizard.arena keys

- **位置**：`SetupWizard.java:2184-2190`
- **状态**：深挖确认
- **问题**：onQuit removes the UUID from the session map (correct) but performs no cleanup of the per-player config keys written by autoSave/autoSaveSilent (wizard.step.<uuid> at line 1684, wizard.arena.<uuid> at line 1686). The only place those keys are nulled is showStepDone, i.e. the successful-completion path (lines 1062 and 1064); an abandoned or saveexit-ed wizard leaves them behind forever. Nothing els
- **影响**：管理员实际体验：中途退出（掉线/关服/直接 quit）后再进同一竞技场世界执行 /hilltop setup，会看到“正在从第 N 步恢复 <arena>（世界 …）”横幅（messages.yml setup.resuming），然后直接停在第 N 步——这正是 saveexit 注释宣称的设计（“稍后可在竞技场世界内 /hilltop setup 继续”），所以“以为重新开始却从第 6 步继续”在没有重置的情况下是预期行为，不算缺陷。真正会咬人的只有一种组合：竞技场被 ArenaResetService 清空部署数据后又用同一 UUID 在同一竞技场重开向导——步骤指针仍是旧的。若旧步骤是 8，会立刻被 validateCompletion 弹回缺项步骤并给出 setup.spawns-required 等提示（有提示、有重绘，不会卡死、不会报错、不会写坏数据）；若旧步骤是 3~7，则
- **调用链**：入口: 管理员（permission hilltopvillage.admin，plugin.yml default: op）在竞技场世界执行 /hilltop setup —— HilltopCommandHandler.java:459-475 权限检查后，args.length<2 或 !hasSession 时调用 setupWizard.start(player) → 中间: SetupWizard.start() 先按所在世界解析 ArenaDefinition（:201-207），仅校验 deploymentGameManager(arenaId)!=null（:210-213，世界加载即非 null，与“竞技场是否仍部署”无关），随后读 plugin.getConfig().
- **证据**：`SetupSession s = sessions.get(quitting.getUniqueId()); if (s != null) { // 会话结束：清掉该玩家第 5 步留下的村民预览实体。必须在移除 session 之前清理， // 否则按会话 arenaId 解析目标世界会退化成按「所在世界」解析（离服瞬`
- **原始数据**：`.run-hv/findings/` + `.run-hv/deep/S02-F5.json`

#### S03-F5 · Missing tab.header/tab.footer silently blanks the tab instead of using the factory layout

- **位置**：`DisplayConfigLoader.java:201-206`
- **状态**：深挖确认
- **问题**：parseOptionalLines() returns List.of() whenever the key is absent, and parseTab() runs as soon as a tab: section exists at all. A partial tab section (for example only enabled/contexts/player-name, which passes YamlFiles.displayValidator) therefore drops the default header and footer, whereas the analogous scoreboard case explicitly restores the factory layout when its key is missing (parseBoard:1
- **影响**：触发后在线玩家的 tab 列表顶部标题/竞技场信息与底部提示整体消失（客户端收到的是空 header/footer，与 restoreAll():227 用来「还原成从未接管」的写法完全一致），但 tab 的其余接管功能全部照常：player-name.* 仍回落到出厂键（nameKey 传 fallback，TabListManager.pushName/fallbackKey:540-562）、排序分带 pushOrder 正常、contexts 开关正常。控制台没有任何 WARN/SEVERE —— 管理员只看到 tab 变「素」，通常误判为别的基础设施问题。危害是纯展示/可观测性回退，不丢数据、不影响对局逻辑、不影响玩家名与排序，且 /hilltop reloadconfig 或改回文件即可立即恢复，故定 low（与锐评一致，非 none：确有玩家可见的静默功能回退，且文档明确承诺
- **调用链**：入口: 管理员手改 display.yml 留下「部分 tab: 段」（例如只写 tab.enabled / tab.contexts，删掉或注释掉 header/footer —— 模板头部注释第 57 行明确把板级字段标为「可选，缺省即出厂值」，正好诱导这种写法），然后执行 /hilltop reloadconfig（或重启服务器）。 → 中间: HilltopCommandHandler.java:428 -> ConfigManager.reloadDisplay():264-276 —— 先 displayGate.reset() 再真读盘（YamlFiles.load:79-99 只做解析与显示哨兵校验），随后 loadDisplayConfig():284-296 -> Dis
- **证据**：`private static List<DisplayConfig.Line> parseOptionalLines(ConfigurationSection section, String key, String path, List<String> warnings) { if (!section.contains`
- **原始数据**：`.run-hv/findings/` + `.run-hv/deep/S03-F5.json`

#### S03-F6 · Invalid-number re-arm races with inventory-open and resurrects a pending chat input

- **位置**：`NumericInputHandler.java:211-214`
- **状态**：深挖确认
- **问题**：onChat() runs on the async chat thread: it removes the pending entry at line 172, then on NumberFormatException builds a new PendingInput and puts it back (lines 211-214). onInventoryOpen() (lines 246-251) clears the same map on the main thread to express "the player has left chat-input mode". The remove/re-put pair is not atomic, so an inventory opening between the removal and the re-put leaves a
- **影响**：触发交错后，管理员已经在开箱子/工作台，但 map 里仍留着他 SHIFT 点击的那个数值槽的待输入条目（原 callback/min/max/onCancel），并在 30 秒后自动过期。在这 30 秒内： (a) 他在公屏打的下一行聊天会被 event.setCancelled(true) 吞掉（其他人收不到、他自己只看到提示），属于可见异常； (b) 若这行能解析为数字（含负数/小数），则 clamp 到该槽位 min..max 后由 :202-204 切回主线程执行 callback -> setter.accept(v) + reopen()：配置值被静默改写（内存态，需随后点保存/落盘才持久化），同时强行把配置菜单在箱子之上重新打开，把他从正在做的事里踢出来； (c) 若打的是 "cancel"，走 :178-185 分支，条目被消费并执行 onCancel（即 this::r
- **调用链**：入口: /hilltop config -> MainConfigMenu (HilltopCommandHandler.java:642) -> 任一数值页（如 Monsters -> MonsterSettingsMenu.addAdjustableItem:308-341，SHIFT_LEFT/SHIFT_RIGHT 分支 :322-329）执行 admin.closeInventory() 后调用 NumericInputHandler.requestNumber(plugin, admin, prompt, min, max, v -> { setter.accept(v); reopen(); }, this::reopen, lang)；同类入口 GameRulesMenu:1
- **证据**：`PendingInput renewed = new PendingInput(pending.plugin, pending.callback, pending.min, pending.max, pending.onCancel, pending.playerId, pending.lang); pendingIn`
- **原始数据**：`.run-hv/findings/` + `.run-hv/deep/S03-F6.json`

#### S04-F2 · Delayed reset is fire-and-forget with no handle or generation guard, so a second reset can wipe a freshly reop

- **位置**：`ArenaInstance.java:184`
- **状态**：锐评确认（首轮 medium → 终判 low）
- **问题**：scheduleReset() only flips the resetScheduled boolean and then schedules reset() with runTaskLater without keeping the BukkitTask, so the pending reset cannot be cancelled, identified or superseded. reset() clears resetScheduled at entry (line 1358) while restoreStarted is still true, so a second scheduleReset() during the reset window is accepted and queues another full reset. If that second rese
- **影响**：A player who joined the reopened arena and is waiting in the start countdown is silently ejected to the lobby with their session recorded as a mid-match leave, the countdown is cancelled, and the arena re-enters ENDING/rollback for no reason. Repeated admin stops during the reset window keep re-arming the same stale reset.
- **证据**：`Bukkit.getScheduler().runTaskLater(plugin, this::reset, getConfiguredResetDelayTicks());`
- **原始数据**：`.run-hv/findings/` + `.run-hv/critiques/S04-F2.json`

#### S04-F3 · getStatus reports READY from map presence, hiding a stuck-ENDING instance and blocking /hilltop enable

- **位置**：`MultiArenaManager.java:485`
- **状态**：锐评确认（首轮 medium → 终判 low）
- **问题**：getStatus() derives READY purely from activeArenas membership and never looks at the instance's GameState or its restore barrier. An instance stays in activeArenas after a failed or blocked reset, where ArenaInstance.reset() deliberately parks it in ENDING with restoreStarted=false when restoreWithResult is rejected or rollback fails (lines 1430-1446) and logs 'the arena stays in ENDING'. getStatu
- **影响**：After a rollback failure the arena is permanently unjoinable but advertised as READY; the enable command refuses to act, so an admin following the log's own advice ('run /hilltop disable ... then /hilltop enable ...') must discover by trial that only disable-then-enable works. Any status surface built on getStatus() (list, manage GUI, reset gate messages) is wrong for the whole outage.
- **证据**：`if (activeArenas.containsKey(arenaId)) return ArenaStatus.READY;`
- **原始数据**：`.run-hv/findings/` + `.run-hv/critiques/S04-F3.json`

#### S05-F1 · Spawn/villager removal reports success even when the arenas.yml write failed

- **位置**：`AdminDeployManager.java:656-660`
- **状态**：锐评确认（首轮 medium → 终判 low）
- **问题**：removeSpawnPoint() discards the boolean returned by saveSpawnPoints() and always returns true. removeMobSpawnPoint() (line 692) and removeVillager() (line 728) have the identical shape. The published contract in ArenaAdminService#deleteSpawnPoint says "true = deleted; ... false on write failure", and the class itself tracks failures through saveSpawnPoints()/lastSaveFailed, so the GUI path loses t
- **影响**：When arenas.yml is in read-only degradation (quarantined/parse failure) or the atomic write throws IOException, the admin management GUI shows "manage.entry.deleted" for a point that is still on disk. The in-memory list no longer contains it, so the GUI list also appears shorter for the rest of the session; after a restart the deleted spawn point / villager comes back, and villagers silently reapp
- **证据**：`public boolean removeSpawnPoint(int index) { if (index < 0 || index >= savedSpawnPoints.size()) return false; savedSpawnPoints.remove(index); saveSpawnPoints();`
- **原始数据**：`.run-hv/findings/` + `.run-hv/critiques/S05-F1.json`

#### S05-F2 · Arena reset is allowed during the VICTORY/DEFEAT settlement countdown and kicks players mid-settlement

- **位置**：`ArenaResetService.java:193-201`
- **状态**：锐评确认（首轮 medium → 终判 low）
- **问题**：canReset() gates only STARTING/RUNNING/WAVE_INTERMISSION and ENDING. GameState.VICTORY and GameState.DEFEAT - the settlement countdown, during which players are still inside the arena - fall through to Gate.OK. MultiArenaManager#disableArena() likewise rejects only the three in-play states, so the reset proceeds: disableArena -> stopGame() evicts every player and the map is cleared/rolled back whi
- **影响**：Players are teleported out and their session is destroyed before the settlement finishes (stat summary and scoreboard state are cut off), and the shop NPC is despawned underneath them, even though the same GUI refuses to merely edit min-players in that window. The arena then proceeds straight to a map rollback while the defeat/victory broadcast is still in flight.
- **证据**：`ArenaInstance live = multi.getArena(definition.getId()); if (live != null) { GameState state = live.getState(); if (state == GameState.RUNNING || state == GameS`
- **原始数据**：`.run-hv/findings/` + `.run-hv/critiques/S05-F2.json`

#### S05-F3 · Reset despawns the shop NPC before deployment-data clearing; a failed clear leaves the re-enabled arena with n

- **位置**：`ArenaResetService.java:312-314`
- **状态**：锐评确认（首轮 medium → 终判 low）
- **问题**：Step 7 irreversibly removes the physical shop villager (NpcManager#despawnIfInWorld -> despawnNpc) before step 8 calls ArenaManager#clearDeploymentData(). If step 8 fails, abort() rolls back nodes.yml and then calls reinstate(), which re-enables the arena - but nothing re-spawns the shop NPC and arenas.yml still contains arenas.<id>.shop-npc. The rollback therefore restores "enabled" but not the s
- **影响**：After an aborted reset (arenas.yml write failure, e.g. read-only degradation or IO error) the arena is playable again but the plugin-level shop NPC is gone: right-clicking the shop no longer opens the shop for anyone, even though the GUI still reports the arena as having a shop and /hilltop deploy listshows a shop-npc position. It only comes back after a full server restart (NpcManager#respawnFrom
- **证据**：`if (despawnOwnShopNpc(world)) { plugin.getLogger().info(LOG + "shop-npc-despawned arena=" + arenaId + " world=" + world); }`
- **原始数据**：`.run-hv/findings/` + `.run-hv/critiques/S05-F3.json`

#### S05-F5 · One malformed spawn-point entry drops the whole arena from the registry instead of skipping the point

- **位置**：`ArenaManager.java:578`
- **状态**：锐评确认（首轮 medium → 终判 low）
- **问题**：readDefinition() only tolerates list entries that are not Maps (they are skipped with a warning at line 572-575), but for a Map entry readLocationFromMap() throws IllegalArgumentException when x/y/z is missing or non-finite (mapDouble, line 653-659), and that exception is not caught locally. It escapes to load()'s per-arena catch (line 188-191), which drops the entire definition - no registry entr
- **影响**：A single corrupted spawn point (or a .NaN value, which mapDouble rejects) makes the arena disappear from /hilltop list, the selection GUI and the management GUI. ArenaResetService then answers ARENA_NOT_FOUND, so the admin cannot reset the arena to recover it from inside the game, and cannot even see which arena is broken without reading the console log. Mob spawn points have the identical failure
- **证据**：`spawns.add(readLocationFromMap(map, worldName, id + ".spawn-points." + index));`
- **原始数据**：`.run-hv/findings/` + `.run-hv/critiques/S05-F5.json`

#### S06-F1 · Dropper burns its lifetime airdrop budget even when the batch is refused

- **位置**：`AirdropSpawnGoal.java:265-266`
- **状态**：锐评确认（首轮 medium → 终判 low）
- **问题**：spawnAirdropMobs() is void and silently drops the whole batch on several early returns: dropLoc/mobType null, !isGameRunning(), or `toSpawn <= 0` when the mob cap is already full at the moment of arrival (WaveManager.java:982-989). executeAirdrop() increments airdropsDone unconditionally, so the per-dropper lifetime limit (airdrop-max-per-dropper, default 3, enforced only in shouldActivate() at li
- **影响**：A flying-dropper that reaches its drop point while the arena is at the mob cap permanently stops airdropping after three such no-ops, even though it never produced a single airdrop mob. The wave still has to be cleared without those mobs; on crowded waves (global-mob-cap 80 / mob-cap-per-player 15) the dropper effectively becomes a plain harasser for the rest of its life.
- **证据**：`gameManager.getWaveManager().spawnAirdropMobs(dropper, dropLoc, count, mobType, gameManager.getCurrentWave()); airdropsDone++;`
- **原始数据**：`.run-hv/findings/` + `.run-hv/critiques/S06-F1.json`

#### S07-F1 · Node buffs are re-applied each refresh but never removed or downgraded when a node dies or the player leaves r

- **位置**：`NodeSystem.java:825-836`
- **状态**：锐评确认（首轮 medium → 终判 low）
- **问题**：The buff loop only ever calls addPotionEffect with a freshly computed amplifier; there is no removePotionEffect / amplifier-lowering path anywhere in NodeSystem (grep over the whole mechanics package finds removePotionEffect only in PlayerGoodsManager and MultiArenaManager). Two consequences: (a) when a player leaves buffRadius or the last node is destroyed, the effect survives for the full config
- **影响**：Players keep node speed/resistance/regeneration for up to buff-duration-ticks after the node is gone or after they walk out of range, and the amp level ratchets upward within a fight and only decays by expiry. With the GUI-exposed buff-duration-ticks set above buff-refresh-ticks this becomes a permanent free buff; it also makes 'destroy the node to remove the buff' untrue, which is core tower-defe
- **证据**：`private void applyBuffsToPlayer(Player player, int activeNodes) { int effectiveAmplifier = Math.min(activeNodes - 1, buffStackCap); for (Map.Entry<PotionEffectT`
- **原始数据**：`.run-hv/findings/` + `.run-hv/critiques/S07-F1.json`

#### S07-F2 · Journal is retained forever and the arena is wedged in ENDING when the world is not loaded at reset time

- **位置**：`MapRestoreManager.java:534-538`
- **状态**：锐评确认（首轮 medium → 终判 low）
- **问题**：On the not-loaded path restoreWithResult returns false before `journals.remove(worldName, journal)` (line 540) and before any RestoreOperation is created, so the per-world journal is neither drained nor dropped and no active restore exists to retry it. Callers treat `false` as terminal: ArenaInstance.reset() logs 'reset blocked ... run /hilltop disable then /hilltop enable to retry' and leaves sta
- **影响**：A single unloaded/renamed arena world (Multiverse unload, world deleted during a reset, multiverse reload) permanently wedges that arena in ENDING with no automatic retry, and retains an arbitrarily large block-snapshot map (~140-170 bytes/entry per the class's own estimate) for the rest of the uptime. The only recovery is a full server restart, which loses the journal entirely and leaves the map 
- **证据**：`World world = Bukkit.getWorld(worldName); if (world == null) { plugin.getLogger().warning("Map rollback cannot start: world not loaded " + worldName); return fa`
- **原始数据**：`.run-hv/findings/` + `.run-hv/critiques/S07-F2.json`

#### S07-F4 · ItemsAdder reflection swallows the root cause, then logs a misleading 'not installed' warning per hammer

- **位置**：`HammerListener.java:149-151`
- **状态**：未锐评
- **问题**：The catch block discards the exception object entirely (`catch (Exception ignored)`) and emits a fixed message that asserts the plugin is missing. ClassNotFoundException, NoSuchMethodException (ItemsAdder API changed), IllegalAccessException and InvocationTargetException (CustomStack.getInstance returned null so getItemStack NPEs) are all collapsed into the same text with no class name, no stack t
- **影响**：Admins cannot tell 'ItemsAdder not installed' from 'ItemsAdder installed but API incompatible / item id wrong'; the configured custom hammer model silently degrades to a vanilla IRON_AXE (getHammerMaterial default) with no actionable diagnostic, and log spam grows with every hammer crafted.
- **证据**：`} catch (Exception ignored) { plugin.getLogger().warning("ItemsAdder is not installed or the item could not be fetched: " + itemId); }`
- **原始数据**：`.run-hv/findings/` + `.run-hv/critiques/S07-F4.json`

#### S07-F5 · Preview villagers whose chunk unloaded are dropped from the tracking list without being removed from the world

- **位置**：`VillagerPreviewManager.java:127-134`
- **状态**：未锐评
- **问题**：Both clearAll() (line 127-134) and clearInWorld() (line 112-124) only call remove() on entities for which isValid() is true, then unconditionally drop every reference. A preview villager whose chunk was unloaded has isValid() == false while the entity body is still stored in the region file, so the onDisable path (HilltopVillagePlugin line 309 `villagerPreviewManager.clearAll()`) loses the only ha
- **影响**：Invulnerable, no-AI, persistent preview villagers can survive /hilltop reload ... plugin disable and the following server restart in an unloaded chunk, reappearing when an admin or player later loads that chunk; until onEntitiesLoad runs they are ordinary villagers with the preview PDC and are not covered by any in-memory cleanup path.
- **证据**：`public void clearAll() { for (Villager villager : previews) { if (villager != null && villager.isValid()) { villager.remove(); } } previews.clear(); }`
- **原始数据**：`.run-hv/findings/` + `.run-hv/critiques/S07-F5.json`

#### S08-F1 · Tab animation frame-ticks are counted in refreshes, not ticks

- **位置**：`TabListManager.java:491`
- **状态**：深挖确认（首轮 medium → 终判 low）
- **问题**：The animation frame index is derived from `tick`, but `tick` is advanced by exactly one per refresh (line 343 `tick++;`) and never by the configured period `scheduledPeriod`. display.yml documents frame-ticks in Minecraft ticks ("20 tick = 1 秒"), so with the shipped tab.refresh-ticks of 20 a frame-ticks:20 animation advances one frame every 20 refreshes = 400 ticks = 20 s instead of every 20 ticks
- **影响**：管理员按文档在 tab.header/footer 写 anim 行后，帧推进速度被放慢 refreshTicks 倍：换帧所需时间 = frameTicks × refresh-ticks。出厂 refresh-ticks=20 时，frame-ticks: 20 的一帧持续 400 tick（20 秒）而非文档承诺的 20 tick（1 秒）；未写 frame-ticks 时取加载器缺省 10，也会变成 200 tick（10 秒）一帧。玩家看到的是头/尾几乎静止、每隔十几秒突然跳一帧的『卡住』动画，且同一份 frame-ticks 在侧边栏（ArenaScoreboard:383 累加 refreshPeriodTicks、:616 同一公式）播放正常、在 tab 上明显偏慢，管理员无法从 display.yml 的文档语义推出原因。副作用是动画速度被 refresh-ticks 隐
- **调用链**：入口: HilltopVillagePlugin.onEnable -> this.tabListManager = new TabListManager(this); this.tabListManager.start(); (HilltopVillagePlugin.java:144-145)。start() 只以 tab.enabled() 为门槛（TabListManager.java:143-148），出厂 display.yml:135 tab.enabled: true，因此插件启用即调度，无需任何玩家在线、无需任何权限或命令。 → 调度: TabListManager.start():149 int period = tab.refreshTicks() > 0 ? tab.
- **证据**：`int frame = (int) ((tick / Math.max(1, line.frameTicks())) % frames.size());`
- **原始数据**：`.run-hv/findings/` + `.run-hv/deep/S08-F1.json`

#### S08-F2 · Disabling the scoreboard mid-game destroys boards with no re-show path on re-enable

- **位置**：`ArenaScoreboard.java:363`
- **状态**：深挖确认（首轮 medium → 终判 low）
- **问题**：When the effective switch turns false, this branch calls hide(player) for every online board owner (line 367), removes offline entries (line 369) and then stopTask() (line 372). hide() deletes the BoardState from `boards` and restores the main scoreboard, so the arena permanently forgets those players. When the switch is turned back on, refreshAll() finds `boards.isEmpty()` (lines 375-378) and sto
- **影响**：管理员在对局中把侧边栏关掉再打开（或在同一局内先关后开），场内所有玩家（等待区与对局中）的侧边栏直接消失，且整局不再出现，直到他们离开竞技场重进、断线重连、或本局结束后的下一局。丢掉的信息正是侧边栏承载的波次/总波次、存活人数、等待复活人数、能量节点、村民数、个人击杀/阵亡/水晶——其中节点与村民计数没有第二条常驻展示通道（BossBar 只用于锤子蓄力，波次只在开始/完成时广播一次），所以玩家无法随时查看战况，指挥与节奏判断变差。但游戏本身仍可正常进行：不崩服、不丢数据、不影响伤害/刷怪/结算，且下一次入场自动恢复。属于「管理员操作触发、本局内不可自愈、信息性损失」的显示缺陷，不是数据或功能损坏。
- **调用链**：入口(禁用): 管理员把 game-settings.yml 的 scoreboard.enabled 或 display.yml 的 scoreboard.enabled 改为 false，执行 /hilltop reloadconfig (HilltopCommandHandler.java:422 loadFromFile + :428 reloadDisplay)，或点主配置菜单的 Reload 按钮 (MainConfigMenu.java:151 loadFromFile) → 中间(配置生效): ConfigManager#loadFromFile 在 :1405 activeConfig = new GameConfig() 后于 :1443 读回 scoreboard.en
- **证据**：`if (!plugin.getConfigManager().isScoreboardEffectivelyEnabled()) {`
- **原始数据**：`.run-hv/findings/` + `.run-hv/deep/S08-F2.json`

#### S08-F3 · Unmanaged tab contexts still overwrite other plugins' header/footer with empty components

- **位置**：`TabListManager.java:417`
- **状态**：深挖确认
- **问题**：pushHeaderFooter() runs for every online player on every refresh (refreshAllUnchecked lines 348-351) regardless of isManaged(). For a context explicitly switched off (tab.contexts.lobby/arena/spectator = false) the else branch builds empty header/footer and line 427 still calls viewer.sendPlayerListHeaderAndFooter(header, footer). Bukkit's header/footer is a single per-player value, so this send e
- **影响**：触发前提：管理员把 tab.contexts.lobby（或 arena/spectator）设为 false，且该上下文有在线玩家。后果分三种：(a) 没有第三方 tab 插件：头/尾变成空，与‘本插件不管这一块’的期望一致，玩家只看到没有 header/footer，无实际损害；(b) 第三方插件周期性重发（TAB/Tablisk 默认每数百毫秒~1 秒重绘一次）：Hilltop 每个缓存周期只发一次空包，对方下一帧就覆盖回来，实际是亚秒级闪烁，通常肉眼不可见；(c) 第三方插件只在 join / 状态变化时设置一次头/尾：那一份会被 Hilltop 的 join 时 forcePush（:480 -> :262 -> :427）或启动后首帧 refreshAll 清掉，并一直保持空白，直到对方下一次主动设置——这是唯一有持续可见损失的路径，但要求对方实现恰好是‘一次性设置’。锐评指出
- **调用链**：入口 A（周期）：HilltopVillagePlugin.onEnable :144-145 new TabListManager(this); start() -> start() :143-160 读 tabConfig()，tab.enabled=true 时 runTaskTimer(plugin, this::refreshAll, period, period)（默认 20 tick） → 中间 A：refreshAll :309-316 -> refreshAllUnchecked :318 -> :320 Bukkit.getOnlinePlayers() -> :323 tabConfig() -> :324 唯一全局闸门 if (tab == null || !tab.
- **证据**：`header = Component.empty();`
- **原始数据**：`.run-hv/findings/` + `.run-hv/deep/S08-F3.json`

#### S08-F4 · restoreAll resets name/order for players whose name/order the plugin never set

- **位置**：`TabListManager.java:225-226`
- **状态**：深挖确认
- **问题**：The "touched" set is the union of all four caches (lines 215-219), and lastHeader/lastFooter are populated for every online viewer on every refresh (lines 427-429) even when the plugin does not manage that context and never called playerListName/setPlayerListOrder for that player. The restore loop then unconditionally executes playerListName(null) (line 225) and setPlayerListOrder(0) (line 226) fo
- **影响**：触发条件：tab.enabled=true（出厂默认）且至少一个上下文被关掉（例如 tab.contexts.lobby: false，把大厅 tab 交给第三方插件），服务器上装有管理 tab 名字/排序的第三方插件，且 Hilltop 至少跑过一轮刷新（默认 1 秒内即满足）。此时禁用/重载 Hilltop（服务器 stop、/reload、PlugMan reload 单插件）会让所有在线玩家——包括大厅里 Hilltop 明确声明不管理的玩家——的 listName 被写成 null、listOrder 被写成 0，并广播 UPDATE_DISPLAY_NAME / UPDATE_LIST_ORDER，同时头/尾被发成空。玩家侧表现：第三方插件给的名字前缀/颜色/排序分带在那一刻全部回落到原版用户名与 order 0，tab 列表按默认规则重排（同带内按名字），头/尾也变空。是否“
- **调用链**：入口: HilltopVillagePlugin#onDisable -> tabListManager.stop() 后立即 tabListManager.restoreAll()（HilltopVillagePlugin.java:237-244，调用点 240，有 try/catch 但不阻断） → 入口（等价）: 服务器 /reload、PlugMan 等对 Hilltop Village 单插件的 reload/disable 都走 onDisable，同一条链；/hilltop reloadconfig 不走这里（HilltopCommandHandler.java:431-436 只调 start() + refreshNow()，全仓库 grep 无其它 restoreAll
- **证据**：`player.playerListName((Component) null);`
- **原始数据**：`.run-hv/findings/` + `.run-hv/deep/S08-F4.json`

#### S09-F3 · reload() has no failure isolation: exception escapes the command and skips the GUI refresh

- **位置**：`ShopManager.java:56`
- **状态**：锐评确认（首轮 medium → 终判 low）
- **问题**：reload() is the single entry point used both by onEnable and by /hilltop shop reload, and it performs the throwing load() as its first statement. There is no try/catch, no status return, and no admin-facing message: the following loop that closes stale ShopGUI instances (lines 59-63) and the item-count log (line 64) are skipped, and the exception propagates into Bukkit's command dispatch. The call
- **影响**：Degraded/partial reload: on a refused load the in-memory snapshot and every already-open ShopGUI keep using the old prices while the admin gets no in-game error (only a console stack trace). Any price change the admin believes is live is not, and re-running the command keeps failing until the file is repaired and the server restarted.
- **证据**：`this.config = loader.load();`
- **原始数据**：`.run-hv/findings/` + `.run-hv/critiques/S09-F3.json`

#### S09-F4 · Reload never re-applies the NPC name, so a changed shop.npc.name stays stale

- **位置**：`NpcManager.java:102`
- **状态**：锐评确认（首轮 medium → 终判 low）
- **问题**：The configured name is resolved and applied only inside spawnNpc(). ShopManager.reload() (lines 55-65) swaps the config snapshot and closes GUIs but never re-spawns, renames, or reconfigures the live Villager; nothing in NpcManager is touched by reload(). The villager field is deliberately kept stable across reloads ('reload does not rebuild', ShopManager.java:29), so the entity keeps the display 
- **影响**：Partial reload: an admin edits shop.npc.name (or the i18n shop.npc.name fallback) and runs /hilltop shop reload, gets 'Shop config reloaded', but the villager in game keeps the old name until a restart or until someone re-runs setshop / the wizard and thereby triggers spawnNpc.
- **证据**：`String npcName = resolveNpcName();`
- **原始数据**：`.run-hv/findings/` + `.run-hv/critiques/S09-F4.json`

#### S10-F2 · StatsManager writes player-stats.yml with a non-atomic replace and then deletes the only surviving copy

- **位置**：`StatsManager.java:465`
- **状态**：锐评确认（首轮 medium → 终判 low）
- **问题**：writeAtomically() never requests StandardCopyOption.ATOMIC_MOVE, despite its own javadoc claiming '临时文件 + 原子替换：避免写入中途被中断时留下半截 YAML' (line 440). A plain REPLACE_EXISTING move on Windows is implemented as DeleteFile(target) followed by a non-replacing MoveFileEx (the JDK behaviour documented at CommandsDocumentGenerator.java:489-493 in this same repository), i.e. it is delete-then-rename, not a repl
- **影响**：All persisted player statistics (games, wins, kills, deaths, nodes, crystals, best wave) can be lost outright instead of at worst being one flush cycle stale. On the next start load() sees no file and begins with an empty cache, then the first save writes a file containing only post-restart records, so the loss becomes permanent. The narrow window also exists on every 60-second async flush, not on
- **证据**：`Files.move(tmp.toPath(), statsFile.toPath(), StandardCopyOption.REPLACE_EXISTING);`
- **原始数据**：`.run-hv/findings/` + `.run-hv/critiques/S10-F2.json`

#### S10-F3 · StatsManager.load() treats transient read errors as corruption and renames the stats file away

- **位置**：`StatsManager.java:287-296`
- **状态**：锐评确认（首轮 medium → 终判 low）
- **问题**：The read and the parse are wrapped in one 'catch (Exception exception)' that unconditionally calls quarantineCorruptFile() and then 'dirty = false; return;' with an empty cache. Files.readString throws IOException for reasons that have nothing to do with content corruption (file locked by antivirus/backup on Windows, ACL/permission change, sharing violation, I/O error). In those cases the file is 
- **影响**：A single transient read failure at startup silently wipes the live statistics file: the server serves empty leaderboards and /hilltop stats, and the first save after that permanently replaces the data set (the old data survives only as an unread .corrupt file the plugin never reads back). Every player's history is affected for a failure that a simple retry would have survived.
- **证据**：`yaml.loadFromString(Files.readString(statsFile.toPath(), StandardCharsets.UTF_8));`
- **原始数据**：`.run-hv/findings/` + `.run-hv/critiques/S10-F3.json`

#### S10-F5 · Generated commands.md still documents /hilltop help as admin-only after the permission gate was removed

- **位置**：`CommandsDocumentGenerator.java:159`
- **状态**：未锐评
- **问题**：The generated documentation for '/hilltop help' claims the command is admin-only ('- **权限**: `hilltopvillage.admin`' at line 156 and '管理员专用' here), but HilltopCommandHandler.handle() deliberately removed that gate: 'case "help":' now calls deployMenuSender.sendUsage(sender) with no permission check, and the inline comment says 'fix6 Y3-R07-08：撤掉 admin 门——sendUsage 内部按权限裁剪（玩家看不到管理段）'. sendUsage() i
- **影响**：Admins and players read a freshly generated in-game/disk reference that contradicts the running plugin: operators may grant hilltopvillage.admin believing help requires it, and players are told a command they can use is forbidden. The class javadoc explicitly makes keeping this text in sync with the implementation a maintenance obligation, so the drift defeats the purpose of generating the documen
- **证据**：`md.append("- **注意事项**: 管理员专用，显示所有可用命令及简要说明。\n\n");`
- **原始数据**：`.run-hv/findings/` + `.run-hv/critiques/S10-F5.json`

---

## 三、被撤销的误报（6 条）

**这些不要修。** 独立锐评尝试反驳后，判定原发现的前提不成立。
列在这里是为了避免下一轮审计把它们重新报一遍。

| ID | 位置 | 原主张 | 撤销理由（摘要）|
|---|---|---|---|
| S01-F1 | `HilltopVillagePlugin.java:206-217` | onEnable deaths before command hooks leave plugin enabled with zero wo | The finding's load-bearing premise — that Bukkit/Paper leaves a plugin enabled when onEnable throws, so line 206 is skipped and all commands die — is false on the platform this plugin targets. Disassembling Paper 1.21.4  |
| S03-F4 | `MainConfigMenu.java:148-152` | Config-menu reload only re-parses the cached display.yml, so display e | The mechanics are accurately quoted: MainConfigMenu.java:151 calls only configManager.loadFromFile(); loadFromFile() reaches loadDisplayConfig() at ConfigManager.java:1381, and that method (ConfigManager.java:284-296) re |
| S06-F2 | `AirdropSpawnGoal.java:105-109` | shouldStayActive() does cross-world distanceSquared with no world guar | The quote is verbatim correct (AirdropSpawnGoal.java:105-109) and Location#distanceSquared really does throw on mismatched worlds (paper-api 1.21.4 bytecode: `if_acmpeq` on getWorld(), message 'Cannot measure distance be |
| S06-F3 | `GameManager.java:577-589` | forceAdvanceWave completes the wave without cancelling the spawn batch | The quoted block is verbatim GameManager.java:577-589, and it is true that the branch neither cancels WaveManager's private spawnTask nor clears waveSpawning, but the stale flag is never read before it is overwritten: ch |
| S06-F4 | `GameManager.java:740-742` | Defeat settlement re-enters endGame(false) from the kick loop, double- | The quoted guard is verbatim (GameManager.java:740-742) and the kick loop in ArenaInstance.finishSession (ArenaInstance.java:891-897) really does drive players.size() below min-players while GameManager.state is still RU |
| S10-F4 | `YamlFiles.java:124-129` | YamlFiles.write fallback breaks the 'target file stays intact on failu | The fallback at YamlFiles.java:124 is verbatim non-atomic, but it is unreachable for this write path on the deployed platform: tmp is created in target's own parent directory (:117), and JDK 21 WindowsFileCopy.move maps  |

---

## 四、根因族（按「一处修复覆盖多条」排序）

审计把部分发现归成了根因族。**P1 已修**，其余四族仍然全部未修。

### P2 · Tab 头尾与名字/排序两套 managed 判定（3 条）

涉及：`S08-F3` `S08-F4` `S08-F1`

同一处根因：`pushHeaderFooter` 不看 `isManaged`、`forcePush` 不看 `isManaged`、
`restoreAll` 用四张缓存并集。

建议方向（来自深挖报告，未经核实）：统一 `isManaged` 判定；`else` 分支改 `continue`；
`restoreAll` 分开还原 name/order 与 header/footer。

### P3 · 事件/状态机 guard 缺失（3 条）

涉及：`S07-F3` `S03-F6` `S08-F2`

三条互不相关，各修各的：
- `NodeListener:172` 补 `ignoreCancelled=true` + SPECTATOR/isAlive 门控
- `NumericInputHandler:172/:213` 改为原子化
- `ArenaScoreboard` 在 reloadconfig 的 false→true 边沿补 re-show

### P4 · 文案/i18n 与文档契约（3 条）

涉及：`S01-F3` `S03-F5` `S02-F5`

其中一条是**文档与实现不符**：`display.yml:57` 说「板级字段可选，缺省即出厂值」，
但实现不是这样。改文档还是改实现，需要人定。

### P5 · 纯展示（2 条）

涉及：`S08-F1`（动画节奏，已在 P2 中）、`S03-F2`（护甲表只有头盔）

---

## 五、这份清单不能证明什么

1. **「没列出」不等于「没问题」**。本次只做了单轮审计，41/45 条走完锐评，
   深挖只做了 13 条。未覆盖的区域可能仍有缺陷。
2. **没有编译、没有跑测试、没有启动服务端**。所有结论来自静态阅读 + 必要时的字节码核实。
   其中 `S03-F6`（交错窗口）和 `S07-F3`（旁观者路径）的置信度是 medium，
   机制成立但未实测。
3. **严重性有主观成分**。深挖报告在每条的 `notes` 里记了口径分歧
   （例如 S03-F3 在另一种口径下可维持 medium）。若团队标准不同，按 notes 调整即可，
   不用重新核实事实。

---

## 六、原始产物位置

| 文件 | 内容 |
|---|---|
| `.run-hv/AUDIT-REPORT.md` | 45 条一轮发现 + 锐评裁决全文 |
| `.run-hv/DEEP-REPORT.md` | 13 条深挖详情 + 根因族分析 |
| `.run-hv/findings/S01..S10.json` | 各切片原始发现（含证据原文）|
| `.run-hv/critiques/<ID>.json` | 每条锐评的裁决与理由 |
| `.run-hv/deep/<ID>.json` | 深挖的调用链、前提核实、最终严重性 |
| `.run-hv/P1-FIX-PLAN.md` | 已修的 P1 的方案（供对照）|
