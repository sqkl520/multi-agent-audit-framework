# Hilltop Village 审计报告

**目标仓库**：`D:/Server/MCServers/Server plugin/Hilltop Village/Hilltop Village Plugin`
**基线提交**：`12f62da`
**规模**：75 个主源文件 / 34,193 行 Java（Paper / Bukkit 1.21.4）
**审计方式**：dsh 多 Agent，10 切片 → 并肩审计 → 独立锐评
**模型**：`virtual/opus`

---

## 一、元信息

| 项 | 数值 |
|---|---|
| 切片数 | 10（覆盖 75/75 文件）|
| 一轮审计发现 | **45 条** |
| 独立锐评 | **41 条** |
| 锐评后确认 | **13** |
| 锐评后降级 | **26** |
| 锐评后撤销 | **6** |

**关键读数：一轮发现的撤销率 13%、降级率 58%。**
锐评波不是形式——它把 45 条里的一大半打掉了。

---

## 二、确认的发现（13 条，按严重性排序）

### S10-F1 · [HIGH] Arena validator quarantines a legal multi-arena arenas.yml when a later arena only declares 'world'

- **位置**：`src/main/java/com/hilltopvillage/util/YamlFiles.java:226-229`
- **证据原文**：`if (thin && (arenaKeys.isEmpty() || sawRichArena)) {`
- **问题**：arenasValidator() treats an arena section whose key set is a subset of {world} as a truncated write whenever ANY earlier arena in the file had a wider key set (sawRichArena). But ArenaManager.readDefinition/validationFailure explicitly accept a world-only arena: 'core 缺失是合法的（core == null 表示尚未部署）' (ArenaManager.java:502-504), display-name/enabled are optional, and spawn points are optional. Only 'world' is required. arenas.yml's own header instructs admins to add an arena by filling in 'world' first and then run /hilltop setup. So two identical arena sections are judged differently depending only on which sibling precedes them: the same minimal arena is accepted when it is the only arena (the code comments even say '单竞技场的裸 {world} 文件两种都不命中，按合法放行') and is fatal when it follows a fully configured arena. The validator returns a reason, YamlFiles.load() renames the whole file to arenas.yml.corrupt, YamlFileGate locks the process read-only, and ArenaManager.load() clears the registry.
- **影响**：One admin add of a second/third arena block containing just 'world:' (the documented first setup step) destroys the entire multi-arena configuration: the file is renamed to arenas.yml.corrupt, all arenas disappear from /hilltop list, /hilltop arenas and the GUI, and every arenas.yml write (deploy wizard, spawn/villager/shop edits, reset) is refused for the rest of the session. The step also fires mid-session, because every deployment write path calls gate.load() first (AdminDeployManager.saveSpawnPoints:471), so a plain '/hilltop deploy addspawn' can rename the live configuration file out from under the server.
- **触发**：Write a second arena entry with only 'world: <name>' after an already-deployed arena (or copy arena1 and delete everything except world), then restart the server, run /hilltop reloadconfig, or run any deploy/write command that calls arenasGate.load().

### S03-F2 · [MEDIUM] Armor cycle list holds only helmets, so chest/legs/boots slots store helmet materials

- **位置**：`src/main/java/com/hilltopvillage/config/menu/MonsterSettingsMenu.java:400-404`
- **证据原文**：`private static final Material[] ARMOR_CYCLE = { Material.LEATHER_HELMET, Material.CHAINMAIL_HELMET, Material.IRON_HELMET, Material.DIAMOND_HELMET, Material.NETHERITE_HELMET, Material.GOLDEN_HELMET, Ma`
- **问题**：addArmorSlot() is invoked for helmet, chestplate, leggings and boots (lines 191-198) but every call passes the single ARMOR_CYCLE array, whose entries are all helmets (LEATHER/CHAINMAIL/IRON/DIAMOND/NETHERITE/GOLDEN_HELMET) plus AIR. A plain click on the chestplate/leggings/boots slot therefore executes mc.setChestplate(LEATHER_HELMET) etc. WaveSettingsMenu.MonsterPropMenu reuses the same all-helmet ARMOR_LIST for all four slots (WaveSettingsMenu:511-514, 661-665). loadMonstersConfig() only checks Material.isItem() (ConfigManager:2040-2059) and saveMonstersConfig:1044-1047 writes the value back, so the wrong material is accepted and persisted.
- **影响**：The only GUI path for monster armor cannot produce a chestplate, leggings or boots; it writes helmet items into those fields (for example chestplate: LEATHER_HELMET), so equipped armor renders wrong or not at all and the misconfiguration survives reload and restart.
- **触发**：/hilltop config -> Monsters -> any page -> click (not shift-click) the chestplate, leggings or boots slot.

### S03-F3 · [MEDIUM] Quarantined game-settings.yml is silently recreated from jar defaults on the next start

- **位置**：`src/main/java/com/hilltopvillage/config/ConfigManager.java:147-149`
- **证据原文**：`if (!settingsFile.exists()) { plugin.saveResource("game-settings.yml", false); }`
- **问题**：initSettingsFile() copies the bundled template whenever the file is missing, without distinguishing a first run from "the previous run quarantined this file to *.corrupt". YamlFiles.load() renames an unreadable file (empty/truncated/validator failure) to game-settings.yml.corrupt, so on the next start !settingsFile.exists() is true: saveResource() writes factory defaults, settingsGate.load() then returns OK and clears the read-only latch. The "this run is READ-ONLY for that file" protection therefore survives exactly one run, and the admin-supplied configuration is replaced by defaults with only the stale .corrupt file as evidence. initMonstersConfigFile() (164-167) and initDisplayFile() (187-190) share the shape, and loadFromFile() then sets settingsLoadedFromDisk = true, so the defaults are treated as an authoritative disk configuration.
- **影响**：One truncated or corrupt save is enough to have game-settings.yml (and monsters-config.yml / display.yml) silently revert to factory values on the following restart; later GUI saves persist those defaults, so tuning, wave tables and monster overrides are lost instead of the run staying read-only as the gate class documents.
- **触发**：Restart the server after YamlFiles.load() has quarantined any of the three config files.

### S07-F3 · [MEDIUM] Node repair interaction handler lacks ignoreCancelled, so a denied right-click still consumes repair items

- **位置**：`src/main/java/com/hilltopvillage/mechanics/NodeListener.java:172-175`
- **证据原文**：`    @EventHandler(priority = EventPriority.NORMAL)     public void onPlayerInteract(PlayerInteractEvent event) {         if (event.getHand() != EquipmentSlot.HAND) return;         if (event.getAction(`
- **问题**：Every other handler in this class declares ignoreCancelled = true (onBlockBreak line 103, onEntityExplode 114, onBlockExplode 124, onBlockExplosionDamage 145), but the repair handler is registered at NORMAL with no ignoreCancelled and never tests event.isCancelled(). A PlayerInteractEvent already cancelled by a region/protection/adventure-mode plugin still reaches the repair branch at lines 208-247: planRepair() is computed, repairNode() heals the node, and item.setAmount(...)/setItemInMainHand(null) consumes the repair item, while the interaction itself was denied. The handler then calls event.setCancelled(true) on an already-cancelled event, so nothing signals the inconsistency.
- **影响**：On servers with any protection plugin (WorldGuard regions, claim plugins) or in worlds where the arena block interaction is denied, players can repair nodes and lose repair items through a click the server refused; conversely, a protection plugin that cancels earlier in the chain cannot actually block node repair.
- **触发**：Right-click a RESPAWN_ANCHOR node with a repair item while another listener at LOWEST/LOW/NORMAL-earlier has already cancelled the PlayerInteractEvent.

### S08-F1 · [MEDIUM] Tab animation frame-ticks are counted in refreshes, not ticks

- **位置**：`src/main/java/com/hilltopvillage/mechanics/TabListManager.java:491`
- **证据原文**：`int frame = (int) ((tick / Math.max(1, line.frameTicks())) % frames.size());`
- **问题**：The animation frame index is derived from `tick`, but `tick` is advanced by exactly one per refresh (line 343 `tick++;`) and never by the configured period `scheduledPeriod`. display.yml documents frame-ticks in Minecraft ticks ("20 tick = 1 秒"), so with the shipped tab.refresh-ticks of 20 a frame-ticks:20 animation advances one frame every 20 refreshes = 400 ticks = 20 s instead of every 20 ticks = 1 s. ArenaScoreboard does this correctly (`tickCounter += refreshPeriodTicks;` at line 383), which shows the tab path is an off-by-unit error rather than an intentional different semantics. Changing tab.refresh-ticks also silently changes animation speed.
- **影响**：Any admin-configured tab header/footer animation runs 1/refresh-ticks too slow — 20x too slow at the default 1 s refresh — so the tab list appears frozen in a way that cannot be corrected from display.yml; the same frame-ticks value animates correctly on the sidebar and wrongly in the tab list.
- **触发**：display.yml tab.header or tab.footer contains an `anim:` line with 2-8 frames and tab.refresh-ticks > 1 (default 20); the refresh task renders the block every period and every viewer's frame is computed from the per-refresh counter.

### S08-F2 · [MEDIUM] Disabling the scoreboard mid-game destroys boards with no re-show path on re-enable

- **位置**：`src/main/java/com/hilltopvillage/mechanics/ArenaScoreboard.java:363`
- **证据原文**：`if (!plugin.getConfigManager().isScoreboardEffectivelyEnabled()) {`
- **问题**：When the effective switch turns false, this branch calls hide(player) for every online board owner (line 367), removes offline entries (line 369) and then stopTask() (line 372). hide() deletes the BoardState from `boards` and restores the main scoreboard, so the arena permanently forgets those players. When the switch is turned back on, refreshAll() finds `boards.isEmpty()` (lines 375-378) and stops; show() is only called from ArenaInstance#addPlayer (line 343) and ArenaInstance#rejoin (line 575). /hilltop reloadconfig re-reads display.yml and restarts the tab task (HilltopCommandHandler lines 428-435) but has no scoreboard re-show step.
- **影响**：An admin who toggles scoreboard off and back on (display.yml scoreboard.enabled or game-settings.yml scoreboard.enabled, both re-read by /hilltop reloadconfig) leaves every player already in an arena with no sidebar for the rest of the match; only leaving and rejoining or a new match restores it.
- **触发**：Set either scoreboard switch false and run /hilltop reloadconfig (or wait for the next refresh), then set it true again while players are inside a waiting or running arena.

### S01-F3 · [LOW] Pending-clear expiry message always says clearspawns even for mob/villager clears

- **位置**：`src/main/java/com/hilltopvillage/command/HilltopCommandHandler.java:766`
- **证据原文**：`admin.sendMessage(lang.getFor(admin, "deploy.clearspawns-expired", arenaId));`
- **问题**：requestClear() is shared by all three ClearKind values (SPAWN, MOB_SPAWN, VILLAGER) and every other message in that method is dispatched through kind-keyed helpers (warningKey/confirmKey/alreadyKey). The expiry callback is the one exception: it hardcodes "deploy.clearspawns-expired", whose text is 'Clear operation for arena {0} timed out and was cancelled.' The same hardcoded key is repeated in confirmClear() at line 802 for the overdue branch, which is likewise reachable for all three kinds. So a /hilltop deploy clearmobspawns or clearvillagers request that times out reports itself as a spawn-point clear.
- **影响**：Misleading admin feedback only (no state corruption): the admin who requested a mob-spawn or villager clear is told a player-spawn clear expired, which makes it ambiguous whether their destructive operation is still pending before they re-issue it.
- **触发**：/hilltop deploy clearmobspawns (or clearvillagers) followed by no confirm within 15 s, or by a confirm after the TTL elapsed.

### S02-F5 · [LOW] Quit path drops the in-memory session but never clears the persisted wizard.step/wizard.arena keys

- **位置**：`src/main/java/com/hilltopvillage/command/SetupWizard.java:2184-2190`
- **证据原文**：`SetupSession s = sessions.get(quitting.getUniqueId());         if (s != null) {             // 会话结束：清掉该玩家第 5 步留下的村民预览实体。必须在移除 session 之前清理，             // 否则按会话 arenaId 解析目标世界会退化成按「所在世界」解析（离服瞬间仍可用，但越早`
- **问题**：onQuit removes the UUID from the session map (correct) but performs no cleanup of the per-player config keys written by autoSave/autoSaveSilent (wizard.step.<uuid> at line 1684, wizard.arena.<uuid> at line 1686). The only place those keys are nulled is showStepDone, i.e. the successful-completion path (lines 1062 and 1064); an abandoned or saveexit-ed wizard leaves them behind forever. Nothing else in the plugin reads or expires them (the only other reader is start() at lines 240 and 243), so config.yml accumulates a permanent key pair per admin UUID, and any later /hilltop setup in that arena silently resumes at the abandoned step even after the arena's deployment data was cleared by ArenaResetService, which then only gets caught by the step-8 validateCompletion bounce.
- **影响**：config.yml grows with dead per-UUID progress entries and abandoned progress keeps being honoured indefinitely; an admin who quit mid-wizard is unexpectedly dropped into an arbitrary step (with the deployment data no longer matching) instead of starting at step 1.
- **触发**：Start /hilltop setup, advance past step 1, then quit the server or /hilltop setup saveexit without finishing; the keys remain and are re-read on the next setup run for that arena.

### S03-F5 · [LOW] Missing tab.header/tab.footer silently blanks the tab instead of using the factory layout

- **位置**：`src/main/java/com/hilltopvillage/config/DisplayConfigLoader.java:201-206`
- **证据原文**：`private static List<DisplayConfig.Line> parseOptionalLines(ConfigurationSection section, String key, String path, List<String> warnings) { if (!section.contains(key)) { return List.of(); }`
- **问题**：parseOptionalLines() returns List.of() whenever the key is absent, and parseTab() runs as soon as a tab: section exists at all. A partial tab section (for example only enabled/contexts/player-name, which passes YamlFiles.displayValidator) therefore drops the default header and footer, whereas the analogous scoreboard case explicitly restores the factory layout when its key is missing (parseBoard:152-155 -> DisplayConfig.defaultLines()). Every other missing tab key (contexts, player-name.*) falls back to the documented default and emits no warning, so this one silent divergence is easy to miss.
- **影响**：Changing one tab setting (for example tab.contexts.arena=false) silently removes the tab header/footer for every player with no console warning, and behaves differently from the scoreboard section for the identical missing-key situation.
- **触发**：display.yml with a tab: section that omits header or footer, then /hilltop reloadconfig or a restart.

### S03-F6 · [LOW] Invalid-number re-arm races with inventory-open and resurrects a pending chat input

- **位置**：`src/main/java/com/hilltopvillage/config/menu/NumericInputHandler.java:211-214`
- **证据原文**：`PendingInput renewed = new PendingInput(pending.plugin, pending.callback, pending.min, pending.max, pending.onCancel, pending.playerId, pending.lang); pendingInputs.put(id, renewed); scheduleNumberTim`
- **问题**：onChat() runs on the async chat thread: it removes the pending entry at line 172, then on NumberFormatException builds a new PendingInput and puts it back (lines 211-214). onInventoryOpen() (lines 246-251) clears the same map on the main thread to express "the player has left chat-input mode". The remove/re-put pair is not atomic, so an inventory opening between the removal and the re-put leaves a live entry behind after the player already left the input flow — the state the class javadoc (lines 236-244) says must not survive, and which the two-argument removals elsewhere were written to avoid.
- **影响**：The player next chat line is cancelled and, if it parses as a number, written straight into the config value with no confirmation while the player is already interacting with a GUI (the hijack the inventory-open guard exists to prevent).
- **触发**：SHIFT-click a numeric slot, then send a non-numeric chat line at the same moment as opening any container so the chat thread re-arm lands after the main thread removal.

### S05-F6 · [LOW] Failed arenas.yml write still replaces the live arena's spawn points and core in memory

- **位置**：`src/main/java/com/hilltopvillage/admin/AdminDeployManager.java:530-534`
- **证据原文**：`gameManager.setSpawnPoints(savedSpawnPoints); gameManager.setMobSpawnPoints(savedMobSpawnPoints); if (savedCoreLocation != null) { gameManager.setCoreLocation(savedCoreLocation); }`
- **问题**：The in-memory push to GameManager runs unconditionally after `boolean saved = gate.write(arenasConfig);`; the write result is only stored in lastSaveFailed. On failure the disk still holds the old deployment data while the running arena immediately uses the new spawn points, mob spawn points and core. There is no rollback and no reload, so the process state and arenas.yml diverge until restart.
- **影响**：A deployment command whose save failed is reported as failed (reportDeploySaveFailure), yet the live arena already switched: players respawn/teleport to points that exist only in memory, and the next successful save of any arena field writes those unsaved points to disk after all. Admins who see the failure message and re-edit the YAML on disk are silently overridden in the running server.
- **触发**：Any deployment edit (addspawn, setcore, setwaiting, removeVillager...) while arenas.yml is read-only or the atomic write fails; saveSpawnPoints continues past the failed gate.write.

### S08-F3 · [LOW] Unmanaged tab contexts still overwrite other plugins' header/footer with empty components

- **位置**：`src/main/java/com/hilltopvillage/mechanics/TabListManager.java:417`
- **证据原文**：`header = Component.empty();`
- **问题**：pushHeaderFooter() runs for every online player on every refresh (refreshAllUnchecked lines 348-351) regardless of isManaged(). For a context explicitly switched off (tab.contexts.lobby/arena/spectator = false) the else branch builds empty header/footer and line 427 still calls viewer.sendPlayerListHeaderAndFooter(header, footer). Bukkit's header/footer is a single per-player value, so this send erases whatever another plugin set for that player. The comment at lines 354-357 states the rule for this exact situation — a context switched off means the plugin must not overwrite the tab layout another plugin set there — but the code applies it only to name/order (resetNameAndOrder), while the header/footer path still sends empty components; the javadoc at lines 396-400 documents the empty send, so the two policies in the same class contradict each other.
- **影响**：On a server that delegates the lobby tab to another plugin (the documented reason to set tab.contexts.lobby: false), Hilltop Village clears that plugin's header and footer for every lobby player on the first refresh after startup or after the context is switched off, and keeps it blank.
- **触发**：display.yml tab.contexts.<context>: false while that context has players (for example the lobby); the refresh task pushes empty header/footer once per player and caches it so it is not re-sent until clearCaches().

### S08-F4 · [LOW] restoreAll resets name/order for players whose name/order the plugin never set

- **位置**：`src/main/java/com/hilltopvillage/mechanics/TabListManager.java:225-226`
- **证据原文**：`player.playerListName((Component) null);`
- **问题**：The "touched" set is the union of all four caches (lines 215-219), and lastHeader/lastFooter are populated for every online viewer on every refresh (lines 427-429) even when the plugin does not manage that context and never called playerListName/setPlayerListOrder for that player. The restore loop then unconditionally executes playerListName(null) (line 225) and setPlayerListOrder(0) (line 226) for every UUID in that union. The T5.1 contract in the method javadoc ("only restore players this plugin really touched", so that tab.enabled=false or tab.lobby=false does not wipe another plugin's layout) therefore does not hold: merely receiving a header/footer makes a player count as fully managed.
- **影响**：On plugin disable/reload (onDisable calls stop() then restoreAll()), tab names and list order set by another tab plugin are wiped for all online players who only received a header/footer push — including lobby players in a context Hilltop was configured not to manage.
- **触发**：Server shutdown or plugin reload while another plugin manages tab names/order; restoreAll() runs after at least one refresh frame has cached header/footer entries for those players.

---

## 三、降级的发现（26 条）

这些发现的代码引用多为真实，但**危害被高估**，或依赖的前提在该平台上不成立。
逐条给出锐评的理由。

| ID | 原级别 → 降级后 | 位置 | 锐评理由（摘要）|
|---|---|---|---|
| S03-F1 | high → medium | `ConfigManager.java:1391` | Mechanism verified verbatim. ConfigManager.loadFromFile() (1360-1933) reaches the early return at 1387-1394 on unusable/ABSENT/read-only, and the last executable statement before ` |
| S04-F1 | high → medium | `ArenaInstance.java:1123` | The citation and mechanism are accurate: ArenaInstance.java:1123 is verbatim `if (getPlayerCount() < getMinPlayers()) {`, getPlayerCount() is `players.size()` (line 1069-1071, memb |
| S05-F4 | medium → medium | `AdminDeployManager.java:278` |  |
| S09-F1 | high → medium | `ShopConfigLoader.java:110` | Quote and mechanism verify exactly: ShopConfigLoader.java:110-112 throws IllegalStateException whenever YamlFiles.Loaded.usable() is false, and YamlFiles.load quarantines then retu |
| S09-F2 | high → medium | `ShopConfigLoader.java:289` | The mechanism verifies end-to-end and the quote is verbatim: ShopConfigLoader.java:260 defaults icon to Material.BARRIER, 289-293 keeps a MATERIAL entry with no icon.material (only |
| S01-F2 | medium → low | `HilltopVillagePlugin.java:158` | The citation is verbatim correct (HilltopVillagePlugin.java:158-159; NpcManager.java:301-305 logs and returns void) and cleanupOrphans does run immediately after, skipping only `en |
| S02-F1 | medium → low | `SetupWizard.java:1749` | The code gap is real: grep over the whole plugin finds InventoryDragEvent handlers only in ArenaSelectionGUI.java:334, ShopListener.java:108 and AbstractAdminMenu.java:48; SetupWiz |
| S02-F2 | medium → low | `SetupWizard.java:1746` | Mechanism verified end-to-end: every wizard inventory bakes the locale-dependent title at creation (Bukkit.createInventory(player, 54, lang.getFor(player, "setup.gui-spawns-overvie |
| S02-F3 | medium → low | `SetupWizard.java:1945` | The quotes and line numbers are accurate: SetupWizard.java:1945 and 2016 drop the boolean returned by AdminDeployManager.removeSpawnPoint/removeMobSpawnPoint (AdminDeployManager.ja |
| S02-F4 | medium → low | `SetupWizard.java:2171` | Citation is verbatim correct: SetupWizard.java:2171-2175 is `case "setup-reset": player.closeInventory(); s.step = 1; showStep(player, s);` and the four required-field bounces at 2 |
| S04-F2 | medium → low | `ArenaInstance.java:184` | The citation and the missing guard are real: scheduleReset() (ArenaInstance.java:180-188) checks only the resetScheduled flag, keeps no BukkitTask handle, and /hilltop stop (Hillto |
| S04-F3 | medium → low | `MultiArenaManager.java:485` | The quotation is exact: MultiArenaManager.java:485 is `if (activeArenas.containsKey(arenaId)) return ArenaStatus.READY;` and it never reads ArenaInstance#getState(), and ArenaInsta |
| S05-F1 | medium → low | `AdminDeployManager.java:656` | The quote is exact: AdminDeployManager.java:656-661 removes the index, calls saveSpawnPoints() and unconditionally returns true, and the identical shape is at :692-697 (removeMobSp |
| S05-F2 | medium → low | `ArenaResetService.java:193` | The quote is verbatim: ArenaResetService.java:196-201 gates only STARTING/RUNNING/WAVE_INTERMISSION (GAME_IN_PROGRESS) and ENDING (RESET_IN_PROGRESS), so VICTORY/DEFEAT fall throug |
| S05-F3 | medium → low | `ArenaResetService.java:312` | The ordering and the quote are exact: ArenaResetService.java:312-314 calls despawnOwnShopNpc(world) (step 7) and :318 calls definitions.clearDeploymentData(arenaId) (step 8), and n |
| S05-F5 | medium → low | `ArenaManager.java:578` | Quote and mechanism are exact: ArenaManager.java:578 is verbatim 'spawns.add(readLocationFromMap(map, worldName, id + ".spawn-points." + index));', readLocationFromMap (640-651) ha |
| S06-F1 | medium → low | `AirdropSpawnGoal.java:265` | The quote and ordering are exact: AirdropSpawnGoal.java:265 calls the void spawnAirdropMobs(...) and :266 increments airdropsDone unconditionally, while WaveManager.java:982/983/98 |
| S07-F1 | medium → low | `NodeSystem.java:825` | The quote is verbatim (NodeSystem.java:825-836) and NodeSystem really has no removePotionEffect; the only removals are arena-exit paths (PlayerGoodsManager.java:209-211 via ArenaIn |
| S07-F2 | medium → low | `MapRestoreManager.java:534` | The quote and the mechanical claim are exact: MapRestoreManager.java:534-538 returns false before the journals.remove at line 540, so the journal survives and no RestoreOperation/a |
| S07-F4 | low → low | `HammerListener.java:149` |  |
| S07-F5 | low → low | `VillagerPreviewManager.java:127` |  |
| S09-F3 | medium → low | `ShopManager.java:56` | The literal claim is correct: ShopManager.reload() performs the throwing loader.load() as its first statement (ShopManager.java:56) with no try/catch, and the /hilltop shop reload  |
| S09-F4 | medium → low | `NpcManager.java:102` | Mechanically confirmed: the configured name is read only in NpcManager.spawnNpc (NpcManager.java:102-105 via resolveNpcName at 338-346), and ShopManager.reload() (ShopManager.java: |
| S10-F2 | medium → low | `StatsManager.java:465` | The quoted call is verbatim and genuinely lacks ATOMIC_MOVE: on Windows JDK 21 sun/nio/fs/WindowsFileCopy.move deletes the existing target (DeleteFile at line 390) before MoveFileE |
| S10-F3 | medium → low | `StatsManager.java:287` | load() wraps Files.readString and loadFromString in one catch (Exception) at StatsManager.java:288, so an IOException is routed to quarantineCorruptFile() exactly like a parse erro |
| S10-F5 | low → low | `CommandsDocumentGenerator.java:159` |  |

---

## 四、被撤销的发现（6 条）

**这些是一轮审计的误报。** 撤销理由全部基于反编译或平台行为核实。

### S01-F1 · onEnable deaths before command hooks leave plugin enabled with zero working commands

- **原位置**：`src/main/java/com/hilltopvillage/HilltopVillagePlugin.java:206`
- **撤销理由**：The finding's load-bearing premise — that Bukkit/Paper leaves a plugin enabled when onEnable throws, so line 206 is skipped and all commands die — is false on the platform this plugin targets. Disassembling Paper 1.21.4 (versions/1.21.4/paper-1.21.4.jar, io.papermc.paper.plugin.manager.PaperPluginInstanceManager#enablePlugin) shows the `JavaPlugin.setEnabled(true)` call wrapped in `catch (Throwable)`; the handler logs 'Error occurred while enabling ...' and then calls `PluginManager.disablePlugin(plugin)`, which logs 'Disabling', fires PluginDisableEvent and clears isEnabled, so PluginCommand.execute short-circuits with 'Cannot execute command ... plugin is disabled' rather than silently serving a half-bound command. The repo itself encodes this contract at HilltopVillagePlugin.java:236 ('onDisable 可能在 onEnable 早期失败后执行，故必须判空'). Second, even under the hypothetical enabled state, plugin.yml omitting `executor:` does not kill command dispatch: PluginCommand's package constructor stores the owning Plugin in its `executor` field (verified in paper-api 1.21.4 bytecode, `putfield executor` from the Plugin argument), and HilltopVillagePlugin overrides onCommand at lines 582-584 delegating to commandHandler.handle, so at worst tab completion would be unbound — not '/hilltop start/stop/enable/disable/join/gui/reloadconfig all unreachable'. A genuine throw path does exist (ShopConfigLoader.load throws IllegalStateException on a quarantined/shop.items-not-a-map shop.yml at ShopConfigLoader.java:98, :110, :125, invoked from ShopManager.reload at ShopManager.java:56, called uncaught at HilltopVillagePlugin.java:120), but the demonstrated outcome is a disabled plugin with a console SEVERE trace — precisely the stated design at HilltopVillagePlugin.java:103-104 ('核心模块初始化失败就应当让启动失败并禁用插件') — and the other cited callees mostly swallow or guard their own failures (ArenaManager.load per-arena try/catch at ArenaManager.java:188, unusable-yml read-only degradation at :135-140, world-load catch at :243-245; NpcManager.spawnNpc returning false on a null world at NpcManager.java:71). The impact the finding claims is therefore not reachable, and the surviving behaviour is by design.

### S03-F4 · Config-menu reload only re-parses the cached display.yml, so display edits never take effect

- **原位置**：`src/main/java/com/hilltopvillage/config/menu/MainConfigMenu.java:148`
- **撤销理由**：The mechanics are accurately quoted: MainConfigMenu.java:151 calls only configManager.loadFromFile(); loadFromFile() reaches loadDisplayConfig() at ConfigManager.java:1381, and that method (ConfigManager.java:284-296) re-parses the cached displayYaml, assigned only in initDisplayFile() (line 199) and reloadDisplay() (line 274), the latter called only from HilltopCommandHandler.java:428. But the claimed failure does not follow. The button is labelled 'Load Config File' with lore 'Reload from game-settings.yml', and the success text is 'Config reloaded from game-settings.yml.' (messages.yml:625/634) — the GUI never asserts that display.yml was reloaded, so there is no false success claim. The impact sentence 'appear to have no effect until a full restart' is also false: /hilltop reloadconfig performs displayGate.reset() + a real disk re-read + TabListManager.start()/refreshNow() (HilltopCommandHandler.java:428-435), and docs/guides/config-reference.md:187 routes display.yml to that command. The only residual issue is that this one GUI button is narrower than the command — a UX/documentation nit, not the stated defect; the display hot-reload path is intentionally owned by reloadDisplay(), whose javadoc and YamlFileGate.reset() ('仅由 /hilltop reloadconfig 或重启后的重新构造调用', YamlFileGate.java:101) make that scope explicit.

### S06-F2 · shouldStayActive() does cross-world distanceSquared with no world guard

- **原位置**：`src/main/java/com/hilltopvillage/ai/AirdropSpawnGoal.java:105`
- **撤销理由**：The quote is verbatim correct (AirdropSpawnGoal.java:105-109) and Location#distanceSquared really does throw on mismatched worlds (paper-api 1.21.4 bytecode: `if_acmpeq` on getWorld(), message 'Cannot measure distance between ...'), but the stated failure is unreachable because a dropper that leaves the arena world does not keep this goal. In Paper 1.21.4 Entity.teleport(T) branches on the level dimension key and, when it differs, calls teleportCrossDimension, which builds a replacement via EntityType.create(..., DIMENSION_TRAVEL), copies only NBT (restoreFrom -> saveWithoutId/load), and calls removeAfterChangingDimensions() on the old entity; Mob.addAdditionalSaveData serialises no goal data, so the replacement Phantom only has its vanilla registerGoals() set, and this plugin attaches AirdropSpawnGoal exactly once at spawn (WaveManager.java:696-702, the only addGoal site for flying-droppers). The old NMS entity is removed by that same call, and ServerLevel's entity-tick consumer returns on isRemoved() before GoalSelector.tick is reached, so shouldStayActive() is never evaluated with a foreign-world Location. The finding's Goal-API premise is also wrong: GoalSelector.tick invokes WrappedGoal.canContinueToUse() (PaperCustomGoal.canContinueToUse -> handle.shouldStayActive()) only inside `if (isRunning())`; for a goal that is not running only canUse() -> shouldActivate() runs, and shouldActivate() never reads dropper.getLocation() (its player loop is world-guarded at AirdropSpawnGoal.java:173). The DropperAttackGoal:191 guard it cites protects a Player target, and players do keep instance identity across dimensions, so that guard is not evidence for the dropper case; what actually survives as a real (different) issue is that the cross-world replacement silently loses the plugin's custom AI, which is out of scope for F2.

### S06-F3 · forceAdvanceWave completes the wave without cancelling the spawn batch or resetting waveSpawning

- **原位置**：`src/main/java/com/hilltopvillage/core/GameManager.java:577`
- **撤销理由**：The quoted block is verbatim GameManager.java:577-589, and it is true that the branch neither cancels WaveManager's private spawnTask nor clears waveSpawning, but the stale flag is never read before it is overwritten: checkWaveCompletion() has exactly one caller, the task created at GameManager.java:340-345 after spawnWave() returns, and both onWaveComplete() call sites cancel waveCheckTask first (GameManager.java:580-583 and 447-450), so no wave check executes during the intermission entered at line 507. At the next wave start, startNextWave() sets waveSpawning = true at line 319 before spawnWave(), and spawnWave() begins with cancelSpawnTask() (WaveManager.java:95), so the leftover batch can neither survive nor double-spawn. The batch's own next invocation (within 3 ticks) hits the state != RUNNING guard at WaveManager.java:145-148 and calls cancelSpawnTask(), so the only residue is a task that stays scheduled for at most 3 ticks and cannot spawn anything because state is already WAVE_INTERMISSION. The claimed impact ('the flag no longer means what checkWaveCompletion() assumes', 'declares the wave over while a spawn task is still live') therefore has no observable consequence - the flag has no reader during the window in which it is stale, and it is re-initialised before the next reader exists.

### S06-F4 · Defeat settlement re-enters endGame(false) from the kick loop, double-ending the session

- **原位置**：`src/main/java/com/hilltopvillage/core/GameManager.java:740`
- **撤销理由**：The quoted guard is verbatim (GameManager.java:740-742) and the kick loop in ArenaInstance.finishSession (ArenaInstance.java:891-897) really does drive players.size() below min-players while GameManager.state is still RUNNING, but the endGame(false) it reaches is the first endGame of that defeat, not a re-entry: triggerDefeat (ArenaInstance.java:787-797) calls haltGame (GameManager.java:701-715), which deliberately changes no GameState and never calls endGame, so nothing has ended the session yet. For any defeat that does begin with endGame (the min-players path at line 741 itself), GameManager.state is already DEFEAT at the moment finishSession runs, so isGameRunning() is false for every removal in the loop and the check cannot fire again - the same guard pattern ArenaInstance.stopGame documents at lines 758-766. In the triggerDefeat path the callback is onNaturalGameEnd -> beginEndSequence, whose isEnding() guard (ArenaInstance.java:800-811) returns because the arena state was set to DEFEAT at line 814, so the callback body - including the countdown, stats broadcast and message - runs once, and no earlier 'game-defeat' broadcast exists to duplicate. The residual behaviour is a single, thematically correct loss message plus one redundant clearAllMobs()/deactivateSmash() during teardown, not the double settlement, duplicate broadcast or twice-run callback the finding claims.

### S10-F4 · YamlFiles.write fallback breaks the 'target file stays intact on failure' guarantee and then deletes the temp copy

- **原位置**：`src/main/java/com/hilltopvillage/util/YamlFiles.java:124`
- **撤销理由**：The fallback at YamlFiles.java:124 is verbatim non-atomic, but it is unreachable for this write path on the deployed platform: tmp is created in target's own parent directory (:117), and JDK 21 WindowsFileCopy.move maps only ERROR_NOT_SAME_DEVICE to AtomicMoveNotSupportedException (:318-330), so a same-directory file on the local NTFS D: volume (verified DriveType Fixed, DriveFormat NTFS) always executes MoveFileEx(MOVEFILE_REPLACE_EXISTING) and never enters the catch at :123. A Windows SMB/FUSE share would report a sharing or I/O failure as a plain IOException from the atomic move, not as AtomicMoveNotSupportedException, and a Unix same-directory rename also cannot be cross-device, so the trigger 'filesystem reports AtomicMoveNotSupportedException' does not occur for this temp layout. The only reachable failure behavior is 'atomic move throws, target stays intact, tmp is cleaned in finally', which is the documented contract at :105-107; the line-30 javadoc is imprecise, but there is no reachable destructive fallback. Revoked as dead code for the Windows/NTFS deployment.

---

## 五、未闭合项

1. **锐评未完成全部**：41 / 45 条走完了锐评，其余按「未锐评」计入降级表。
   原因：dsh 主进程在最后一批锐评期间被手动终止（已运行约 2 小时）。
2. **单轮审计，未做第二轮深挖**：框架默认路径要求对高严重性线索走「深挖」，本次受限于时间未执行。
   这意味着**确认的 13 条可信度较高，但「没有发现的区域」不等于「没有问题」**。
3. **未运行测试**：全程只读，未编译、未跑测试套件。所有结论均基于静态阅读 + 反编译核实。

---

## 六、这次运行暴露的框架问题

| 问题 | 现象 | 影响 |
|---|---|---|
| **并发 8 会挂死** | 8 个 subagent 全部卡在 `step/start`，30 分钟无进展；改成 4 后正常 | 框架文档写「默认假设并发 8」，在这个上游上不成立 |
| **主 Agent 用 `Start-Sleep` 轮询** | 反复执行 `Start-Sleep -Seconds 300` 等待子 Agent | 浪费大量墙钟时间，且进程被中断时任务丢失 |
| **无中间落盘约定时，子 Agent 攒到最后才写** | 第一轮 8 个 agent 跑了 30 分钟一个文件都没写 | 中途失败 = 全部工作丢失 |

---

*本报告由 dsh 多 Agent 审计产出，未做人工逐条复核。*
