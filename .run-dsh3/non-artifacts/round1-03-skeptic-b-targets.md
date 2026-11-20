# skeptic-b 目标清单（非并发 CONFIRMED，机械生成）

共 28 条。每条都要执行五步测试并给 verdict；不得遗漏任何 finding_id。

## F-slice-13-contract-01
- dimension: contract / severity: MEDIUM
- evidence: `src/main/java/com/hilltopvillage/config/menu/AbstractConfigMenu.java:154`
- artifact: `round1-02-audit-slice-13-contract.md`
- claim: AbstractConfigMenu 只注册了 InventoryClickEvent 与 InventoryCloseEvent 两个处理器，没有 InventoryDragEvent 处理器；因此在本菜单为 top inventory 时，玩家可以把受管 GUI 内的物品拖进自己的背包，预期是 raw slot 落在 top inventory 范围内的拖动必须被取消。
- basis: 本文件 153-154 行是唯一的点击入口 @EventHandler public void onClick(InventoryClickEvent event)，175-176 行是第二个也是最后一个处理器 onClose(InventoryCloseEvent)；import 仅见 12-13 行的 InventoryClickEvent/InventoryCloseEvent，全文无 InventoryDragEvent 符号。Bukkit 对 InventoryDragEvent 不做默认取消，父类不监听就不会拦截。同仓库 AbstractAdminMenu.java:15-16 的类注释把这一点明确记为「缺口①：父类只处理 InventoryClickEvent，没有 InventoryDragEvent 处理器，因此玩家可以把 GUI 内的物品拖到自己的背包里」，并在 :48-60 用 guardDrag(InventoryDragEvent) 自行补上；而 ItemSettingsMenu.java:20、MonsterSettingsMenu.java:23、GameRulesMenu.java:14 都直接 extends AbstractConfigMenu，不继承该 guardDrag，故配置菜单全部暴露。
- alternatives: 如果所有配置菜单实际上都继承了 AbstractAdminMenu（从而继承 admin/gui/AbstractAdminMenu.java:48 的 guardDrag），缺口即被覆盖——但 ItemSettingsMenu.java:20、MonsterSettingsMenu.java:23、GameRulesMenu.java:14 均直接 extends AbstractConfigMenu，条件不成立。 | 如果插件在别处注册了全局 InventoryDragEvent 监听器并取消事件，本缺口会被兜底——需检查 src/main/java 下全部 InventoryDragEvent 引用（本次只读范围内仅 AbstractAdminMenu.java:48 一处）。 | 如果受管 GUI 的空槽位都是 AIR、没有可拖动的 ItemStack，拖出无实际影响——但 AbstractConfigMenu.java:118-129 的 fillEmpty() 会给每个空槽填入 BLACK_STAINED_GLASS_PANE，槽位始终有物品。

## F-slice-13-contract-02
- dimension: contract / severity: MEDIUM
- evidence: `src/main/java/com/hilltopvillage/config/menu/ItemSettingsMenu.java:239`
- artifact: `round1-02-audit-slice-13-contract.md`
- claim: ItemSettingsMenu 的材质循环槽位（addMaterialCycle）与 MonsterSettingsMenu 的布尔开关都不读 ClickType：任何 ClickType（DROP、MIDDLE、DOUBLE_CLICK、NUMBER_KEY 等）都会直接写配置，而预期的契约是只有 LEFT/RIGHT（及 SHIFT 自定义输入）改变配置。
- basis: ItemSettingsMenu.java:239-244 注册的 lambda 形参是 ct，但函数体只做 nextMat(current, cycle) 与 setter.accept(next)，从未读取 ct；MonsterSettingsMenu.java:211 同样是 `ct -> { mc.setEntityExplosion(!mc.isEntityExplosion()); reopen(); }`，形参 ct 在函数体中零次出现。AbstractConfigMenu.java:169-172 会把 event.getClick() 原样传给每个动作，且在 161 行已先 setCancelled(true)，所以 DROP/NUMBER_KEY 等点击不会真正丢物品或换手，却仍会推进材质/翻转布尔值。同仓库 GameRulesMenu.java:139-145 在 slice-08-logic-009 注释后已把写配置分支收窄为显式 `clickType == ClickType.LEFT`，SHIFT 分支在 :124、RIGHT 分支在 :135，证明同族实现已按白名单收窄，这两个菜单没有跟上。
- alternatives: 如果 AbstractConfigMenu 在分发前已过滤 ClickType、只放行 LEFT/RIGHT/SHIFT，则子类不读 ct 也无害——但 AbstractConfigMenu.java:171 直接调用 action.onClick(event.getClick())，没有白名单，条件不成立。 | 如果 Bukkit 对被取消的 InventoryClickEvent 不再投递 DROP/MIDDLE/DOUBLE_CLICK，则这些 ClickType 不会到达 lambda——但 GameRulesMenu.java:140-142 的注释明确记录这些 ClickType 会到达并曾静默改配置，说明会被投递。 | 如果 UI 文案承诺的是「任意点击都循环」（lang key config.menu.common.click-cycle），则该行为符合文案而非缺陷——需检查语言文件中该 key 的文案是否只写左/右键。 | 如果这些槽位只对拥有 config 管理权限的 OP 开放，影响可降级为「管理员误操作」——需检查打开菜单的命令权限节点（本次未读命令类）。

## F-05-DC-01
- dimension: data-consistency / severity: MEDIUM
- evidence: `src/main/java/com/hilltopvillage/arena/ArenaInstance.java:471`
- artifact: `round1-02-audit-slice-05-data-consistency.md`
- claim: 当玩家在 STARTING/RUNNING/WAVE_INTERMISSION 离场且内存中不存在物品快照时（goods == null，或 PlayerGoodsManager.restore() 返回 false），removePlayer 在第 471 行无条件清空玩家背包；此刻快照已不存在，清空即不可逆地销毁玩家原版物品，而同一方法在第 433–437 行已经把本局统计提交、第 440/446 行已撤销成员资格，两者与背包归还不构成一个事务。
- basis: 控制流：removePlayer 先 record 统计（ArenaInstance:433-437）→ players.remove（:440）→ gameManager.removePlayer（:446）→ 传送（:459）→ 到 :463-464 的 `if (goods == null || !goods.restore(player))`，再经 :468 的 shouldClearInventoryOnMissingSnapshot(state) 进入 :471 的 clear()。PlayerGoodsManager.restore 的返回语义是「内存里没有快照」（PlayerGoodsManager:184-185 的 snapshot == null 直接 return false），且快照只在全部写回成功后才从内存移除（:216-217），因此 false ⇒ 无任何可回滚副本。goods == null 分支（:464 短路）更严重：addPlayer 在管理器为 null 时既不建快照也不清背包（:322-324），玩家带着自己的物品入局，离场时被 :471 清掉，无快照可还原；代码自身只打一条 warning，措辞为 the original items may be lost（:475-477）。项目自带测试 ArenaInstanceStateMatrixTest:51 用 assertTrue 把三态清背包固化为期望值，故既有绿灯不能反证安全。
- alternatives: 如果 PlayerGoodsManager 初始化失败时插件会中止启用（即 goods 永不为 null），则 goods == null 这一路不可达，只剩「快照意外丢失」的窄口径——需检查 src/main/java/com/hilltopvillage/HilltopVillagePlugin.java 的 onEnable 降级分支 | 如果 restore() 返回 false 时磁盘上仍留有一份未被消耗的快照可人工回灌，则清空可恢复——需检查 src/main/java/com/hilltopvillage/core/PlayerGoodsManager.java:242-249 loadFromDisk 与 :498 saveNow 的落盘时机 | 如果所有 removePlayer 调用点离场时状态都已是 WAITING/VICTORY/DEFEAT/ENDING，则 :468 的判定恒为 false、:471 不可达——但 RUNNING 下的退服/踢人路径会走到它（ArenaInstance:501-504 就在 RUNNING 内触发 stopGame），该条件不成立

## F-slice-01-data-consistency-01
- dimension: data-consistency / severity: MEDIUM
- evidence: `src/main/java/com/hilltopvillage/admin/AdminDeployManager.java:557`
- artifact: `round1-02-audit-slice-01-data-consistency.md`
- claim: 一次 saveSpawnPoints() 被拆成两次独立的整份写盘：539 行先 gate.write(arenasConfig)，557 行再调用 saveShopNpcLocation()（590 行重新 load、610 行再整份写一次）。第二次写盘失败、或进程在两次写之间退出时，磁盘停在「生成点已更新、arenas.<id>.shop-npc 仍旧」的半成功状态；清空商店时旧 shop-npc 键要到第二次写盘才被删除，因此该窗口内退出会让已清除的商店 NPC 在重启后被 respawnFromConfig 复活。预期是一次保存只产生一个可见的磁盘状态。
- basis: 控制流：saveSpawnPoints()(454) → gate.load()(476) → arenasConfig.set(...)(501-536) → gate.write(arenasConfig)(539) → saveShopNpcLocation()(557) → gate.load()(590) → gate.write(yaml)(610)。YamlFiles.write 用同目录临时文件 + ATOMIC_MOVE（YamlFiles.java:111-131），单次替换是原子的，但两次替换之间没有事务边界；第一次写盘用的配置来自 476 行读到的磁盘内容，其中 shop-npc 仍是旧值（525-536 无 shop-npc 分支），删除只发生在 598-605。
- alternatives: 如果所有 false 返回的调用方都会立刻重跑一次 saveSpawnPoints()（把 shop-npc 一并重写），半成功状态会在下一次保存收敛——需检查 SetupWizard.autoSave 的实现（调用点 SetupWizard.java:1250、SetupWizard.java:1266）是否无条件重试。 | 如果 arenas.<id>.shop-npc 的删除在第一次写盘时就已落盘（即 525-536 段对 null 的 shop-npc 也有删除分支），则「已清除的 NPC 复活」这一具体后果不成立——需检查 AdminDeployManager.java:525-536 是否含 shop-npc 的删除分支。 | 如果进程在两次 gate.write 之间不可能退出（同一 tick 内同步完成且无强制终止），则崩溃窗口不成立——需检查 saveSpawnPoints 的调用点是否都在主线程同步路径（SetupWizard.java:1250、HilltopCommandHandler.java:911）。

## F-slice-01-data-consistency-02
- dimension: data-consistency / severity: MEDIUM
- evidence: `src/main/java/com/hilltopvillage/admin/ArenaResetService.java:312`
- artifact: `round1-02-audit-slice-01-data-consistency.md`
- claim: 重置序列第 7 步先删除世界里的商店 NPC 实体，第 8 步 clearDeploymentData 失败时 abort() 只回滚 nodes.yml 并重新启用竞技场，不恢复实体；arenas.yml 里 shop-npc 未被删（第 8 步没写成功），于是磁盘声明「本竞技场有商店 NPC」而世界里没有实体，且 respawnFromConfig() 只在插件启动时调用，要等重启才重新生成。
- basis: 调用链：reset()(221) → proceed()(264) → disableArena(286) → clearNodesForWorld(292) → despawnOwnShopNpc(312) → NpcManager.despawnIfInWorld(NpcManager.java:170-180) → despawnNpc()(NpcManager.java:152-158，仅 npc.remove() 并把字段置 null，不写盘) → clearDeploymentData(318) → false 分支 abort(336-339) → reinstateRestoring(452-463) → enableArena(527)。abort 的入参只有 nodesCleared/dataCleared/tryReinstate，没有实体恢复动作；节点有 nodeBackup 回滚（323-334），实体没有。全仓 getNpcManager() 共 15 处调用，无一在 MultiArenaManager.enableArena(278) 路径内；respawnFromConfig 的调用点仅 HilltopVillagePlugin.java:162。
- alternatives: 如果 enableArena 内部会按 arenas.yml 重建商店实体（例如调用 NpcManager.spawnNpc），该分叉会自动收敛——需逐行检查 MultiArenaManager.java:278 的 enableArena 方法体是否触达 NpcManager（本回合仅 grep 定位签名，未逐行读）。 | 如果在插件启动之外还有 respawnFromConfig() 的调用点（例如每次 enable 成功后），重启前也会补齐实体——需检查 HilltopVillagePlugin.java:162 之外的全部调用点。 | 如果第 8 步失败时调用方传 tryReinstate=false（ArenaResetService.java:336-339 的实参顺序为 nodesCleared/dataCleared/tryReinstate，此处 tryReinstate=nodesRolledBack），则竞技场保持 DISABLED、不会出现「可玩但无商店」——需核对这四处实参的绑定顺序是否与 452-453 的形参一致。

## F-slice-11-data-consistency-01
- dimension: data-consistency / severity: HIGH
- evidence: `src/main/java/com/hilltopvillage/config/ConfigManager.java:1425`
- artifact: `round1-02-audit-slice-11-data-consistency.md`
- claim: 当 game-settings.yml 不可用、不存在或闸门只读时，loadFromFile() 在未写入任何文件的情况下把 lastSavedSnapshot 推进为当前内存快照并 return false；hasUnsavedChanges() 随即变为 false，主菜单把保存按钮换成「已是最新」，此前的 GUI 改动失去唯一保存入口，重启后静默丢失。
- basis: 调用链：MainConfigMenu:151（或 HilltopCommandHandler:422）→ ConfigManager.loadFromFile():1419 三合一失败条件 → :1425 无条件推进快照 → :1426 return false → hasUnsavedChanges():343-344 比较内存与快照得 false → MainConfigMenu:96 判假、:126-128 渲染 GREEN_WOOL。该分支是 loadFromFile() 唯一的 false 返回点，不存在失败但不推进的路径；全库 saveToFile() 调用点仅 MainConfigMenu:106 / HilltopCommandHandler:626 / SetupWizard:1680,1704，无关服或定时兜底。
- alternatives: 如果进入该分支前内存与 lastSavedSnapshot 本就相等（管理员未做过未落盘编辑），推进快照无副作用，问题不成立——需检查重载前是否调用过 activeConfig 的 setter 或 GUI 编辑入口（MainConfigMenu:106 之外）。 | 如果管理员在重载失败后又通过其它显式入口（HilltopCommandHandler:626 / SetupWizard:1680）触发一次保存，改动仍会落盘、损失被缓解——需检查这些入口分别由哪条命令或向导步骤可达。

## F-slice-11-data-consistency-02
- dimension: data-consistency / severity: MEDIUM
- evidence: `src/main/java/com/hilltopvillage/config/ConfigManager.java:1442`
- artifact: `round1-02-audit-slice-11-data-consistency.md`
- claim: contains() 判的是 get(path) 非 null，getString() 判的是值 instanceof String，两者之间的缝隙让数字/布尔/段形态的值把 null 写进 worldName；保存时 :851 以 null 调用 set() 等价于删键，磁盘上那一行静默消失，下一次载入回落到默认 "world"。
- basis: 控制流：loadFromFile():1437 先以 new GameConfig() 重建（worldName 默认 "world"）→ :1442 用 contains 守卫 + getString 取值 → 非字符串标量时 getString 返回 null → setWorldName(null)；saveToFile():851 settingsYaml.set("world-name", null) 删除该键。同形态另有 5 处（:1487 hammer.itemsadder-id、:1499 hammer.item-name、:1517 nodes.repair-cost-name、:1645 fireball.item-name、:1752 monsters.*.display-name），其中 :1487 的 null 会在 HammerListener:97 的 .isEmpty() 处解引用。对照 :1477-1486 与 :1518-1529 的材质键：先判 null 再判 isItem，非法则 warning 并保留默认。
- alternatives: 如果所用服务端的 MemorySection#contains 内部走 getString 而不是 get，非字符串值不会进入该分支，问题不成立——需核对服务端 MemorySection 实现（本仓库 YamlFiles.java:351-356 只证明 null 值会被丢弃，故空值确实不触发）。 | 如果 GameConfig#getWorldName 的消费者对 null 做了判空回退，影响仅限于磁盘键被删、不会运行期失败——需对 getWorldName 做全仓检索（本回合 grep src/main/java 仅命中 GameConfig:671 与 ConfigManager:851）。

## F-slice-11-data-consistency-03
- dimension: data-consistency / severity: MEDIUM
- evidence: `src/main/java/com/hilltopvillage/config/ConfigManager.java:1469`
- artifact: `round1-02-audit-slice-11-data-consistency.md`
- claim: villager-health 从磁盘读入后不做任何归一化，.nan / .inf / 负值原样进入 GameConfig，并在下一次保存时被写回磁盘；同文件的同类风险键（explode-damage-multiplier、victory-waves、repair-cost-amount）都有专门 clamp，唯独这一键在载入与外部合并两条路径上都裸取。
- basis: 两条路径：loadFromFile():1469 直接 getDouble + setVillagerHealth；mergeExternalChanges():441-444 在 hasNumber 守卫下同样直接 getDouble。对照 :776-784 normalizeExplodeDamageMultiplier（显式挡 NaN/+Inf、夹 0..10）、:762-764、:767-769。saveToFile():861 把该值原样写回，SnakeYAML 会输出 .NaN，使非法值在保存—重载之间自我固化。消费者 VillagerSystem:121 取值后，:142-144 的 Math.max(1.0, health) 对 NaN 无效（Java 规范：任一参数为 NaN 则结果为 NaN），NaN 会进入 setBaseValue/setHealth。
- alternatives: 如果所用 Paper 版本在 setBaseValue/setHealth 前对 NaN/Infinity 做了钳制或忽略，运行期异常不成立，但 .nan 仍会在内存与磁盘间往返——需检查 VillagerSystem:140-144 与对应服务端实现。 | 如果该版本解析器把 .nan/.inf 当字符串而非 Double，getDouble 会回落 0.0，该路径不成立——需用 YamlConfiguration.loadFromString("villager-health: .nan") 实测（本回合受零写入约束未运行）。

## F-slice-11-data-consistency-04
- dimension: data-consistency / severity: MEDIUM
- evidence: `src/main/java/com/hilltopvillage/config/ConfigManager.java:644`
- artifact: `round1-02-audit-slice-11-data-consistency.md`
- claim: readWaveInt 只挡「非 Number」和负数，中间直接把 Number 压成 int：1e18 饱和成 Integer.MAX_VALUE、1.9 截断为 1、.nan 变成 0，三种失真都不写入 problems，所以加载结束时的 numericProblems 汇总 warning 不会出现，内存值与磁盘值静默分叉。
- basis: 控制流：:639-643 取 raw 并判 instanceof Number（否则记 problems 并回落）→ :644 number.intValue() → :645-648 只判 value < 0。intValue() 对超出 int 范围的值按 JLS 5.1.3 饱和、对小数截断、对 NaN 得 0；三者在 :645 都不成立，直接 :649 return value。调用点 :673-674（count/weight）、:1827（default.total-mobs）、:1895（各波 total-mobs）共享同一入口，且 :1930-1933 只输出 problems 里已有的条目。方法 javadoc（:614-630）声称把「缺键/非数值/负数」三类显式化，实现与之一致，但未覆盖溢出/小数/NaN。
- alternatives: 如果所有波次数值都只能由 GUI 写入且 GUI 已限制范围，手写 1e18 才是唯一触发方式，暴露面较小——需检查 WaveSettingsMenu 的输入校验（本切片外）。 | 如果 SnakeYAML 把 1e18 解析成 Long/BigInteger 而非 Double，intValue() 的截断规则不同，但「静默失真」的结论不变——需实测该字面量的解析类型后再定影响面。

## F-slice-11-data-consistency-05
- dimension: data-consistency / severity: LOW
- evidence: `src/main/java/com/hilltopvillage/config/ConfigManager.java:1577`
- artifact: `round1-02-audit-slice-11-data-consistency.md`
- claim: 载入过程中的旧键迁移（:1577 nodes.repair-item、:1695 shop.currency-drop-amount）直接全量写盘，写前不比对新旧 mtime，也不经过 mergeExternalChanges；若在读盘（:1414）与写盘之间文件被外部修改，改动会被整份旧内容覆盖，且写成功后 :1579 立即对齐 mtime，后续保存也不会再发现。
- basis: 控制流：:1414 settingsGate.load() 取得磁盘快照存入 settingsYaml → :1428 赋给字段 → :1544-1576 只对迁移键做 set → :1577 settingsGate.write(settingsYaml) 整份写回；对照 saveToFile():840-849 在写前比对 lastModified 并走 mergeExternalChanges。写入内容是刚读到的磁盘快照减去旧键，故偏差仅限窗口内的外部改动；YamlFiles.write(:111-131) 用同目录临时文件 + ATOMIC_MOVE，不会产生半截文件，因此定 LOW 而非更高。
- alternatives: 如果 /hilltop reloadconfig 与 loadFromFile() 只在服务器启动或主线程空闲时执行、管理员不可能在同一毫秒内保存文件，窗口实际不可利用——需检查 HilltopCommandHandler:422 的调用上下文与编辑工具的时间尺度。 | 如果 :1577 之前对 settingsYaml 的所有 set 都只涉及迁移键（本回合核对 :1544-1576 只有 nodes.repair-cost-item / nodes.repair-amount-per-cost 与两个 null），则除窗口内的外部改动外不会引入其它偏差——该条成立，故严重性不再上调。

## F-slice-22-data-consistency-01
- dimension: data-consistency / severity: HIGH
- evidence: `src/main/java/com/hilltopvillage/mechanics/NodeSystem.java:180`
- artifact: `round1-02-audit-slice-22-data-consistency.md`
- claim: 载入时一次「方块当前不是重生锚」的读失败会让该坐标进不了 configuredLocations，随后被移出内存 nodes；下一次任意保存（调用链：GameManager.startGame:283 → loadNodesFromConfig:180-199 → addNode:381 / removeNode:399 / clearAllNodes:353 → saveNodesToConfig:286-298）会把 nodes.yml 中该条目永久删掉，日志只有一行 Skipped invalid energy node。
- basis: 180-184 用实时方块材质作配置有效性判据并 continue；187 是 configuredLocations 唯一 add 点，因此该坐标缺席；194-199 对不在集合内的内存节点 deactivate 并从 nodes 移除（deactivate 不可逆）；278-298 保存时先按世界名过滤掉本竞技场世界全部旧条目（286），再只遍历 nodes.keySet() 追加（291-298），被移出内存的坐标不会回到 nodeList，300 行整段 config.set 后覆写。材质不符走 loaded.status()==OK 分支，153-155 反而解除只读，266 的 nodesWritable 拦不住。保存触发点仅 381/399/353，其中 353 由 ArenaResetService.java:305 常规调用。写入侧整段替换语义被 NodeSystemTest.java:177-194 的 entries.size()==1 断言钉住，说明问题在载入把现场状态混入内存差集。
- alternatives: 若所有 loadNodesFromConfig 调用点都保证方块世界已完全恢复（GameManager.java:283 之前存在重置完成屏障），该读失败不会发生——需检查 ArenaResetService 的方块重建与 startGame 的先后顺序。 | 若保存前把文件中本世界条目与内存做并集，而不是仅保留其它世界再追加内存节点，被跳过条目不会丢——需核对 NodeSystem.java:286 的过滤条件与 291-298 的追加范围。 | 若材质校验失败也会把文件判成 unusable 并锁只读（那样 NodeSystem.java:266 会拒写），条目同样不会丢——需核对 NodeSystem.java:145-155：材质校验在 loaded.usable() 之后，且 status==OK 时反而解除只读。

## F-slice-22-data-consistency-02
- dimension: data-consistency / severity: MEDIUM
- evidence: `src/main/java/com/hilltopvillage/mechanics/NodeSystem.java:381`
- artifact: `round1-02-audit-slice-22-data-consistency.md`
- claim: 写盘失败时 addNode 仍返回 0（成功）：节点只存在于内存，部署向导据此向管理员报「节点已添加」并显示内存计数，nodes.yml 没有该条目，下一局或重启后节点消失；同族的 removeNode 会把同样的失败如实上报。
- basis: addNode 在 378-379 行先改内存，381 行调用 saveNodesToConfig() 却丢弃 boolean 返回值，382 行无条件 return 0（javadoc 361 行把 0 定义为成功）。saveNodesToConfig 有三条只打日志的失败分支：266 只读降级、269-274 文件不可用、306-309 IOException。调用方 SetupWizard.java:1412 取 result，1413-1416 仅在 result==0 时发 setup.node-added 并用 getTotalCount() 报数，无二次读盘。对照 removeNode 399-407 会传播 false 并打 will reappear after a restart，NodeSystemTest.java:132-138 正是为该语义写的断言，说明失败上报是本类既有口径。
- alternatives: 若 addNode 的调用方在 result==0 后还会独立重读 nodes.yml 校验条目数，管理员不会被误导——需检查 SetupWizard.java:1413-1420 与 2053 处的后续动作。 | 若部署流程在进入第 4 步前检查 nodes.yml 只读态并挡住 addnode（NodeSystem 本切片未见 isReadOnly 之类 getter），实际可触发性下降，可降为 LOW——需检查 SetupWizard 第 4 步入口的前置检查。

## F-slice-24-dc-01
- dimension: data-consistency / severity: MEDIUM
- evidence: `src/main/java/com/hilltopvillage/shop/ShopListener.java:197`
- artifact: `round1-02-audit-slice-24-data-consistency.md`
- claim: 购买链先扣款（purchase:126）再发货；发货失败进入 refundCurrency 后，若补偿动作自身抛异常，catch 只写一行 SEVERE 日志就返回——货币已扣、商品未生成、玩家无提示，且没有任何持久化的待补偿记录或重试，一致性只能靠服主读日志人肉收敛。
- basis: 调用链：InventoryClickEvent → ShopListener#onInventoryClick:103 → purchase:142/147 → refundCurrency:186 → catch:197。catch 块内只有 plugin.getLogger().severe（:198-200），其后没有 addItem 重试、没有写入任何待补偿结构、没有 player.sendMessage；而扣款发生在 :126 且已返回成功。项目自带测试 ShopListenerTest:333 注释「币确实回不来（这是「需要人工补偿」的路径）」证实该分支被设计为人工兜底。
- alternatives: 如果插件在别处（如 HilltopVillagePlugin 的日志/数据库初始化）另有失败交易落库或补偿队列，则「无持久记录」不成立——需检查 src/main/java/com/hilltopvillage/HilltopVillagePlugin.java 的 onEnable 与任何 shop 相关持久化。 | 如果 refundCurrency 内的 addItem/createCurrencyItem 在目标 Paper 版本上不可能抛（需检查 CraftInventory#addItem 与 ItemStack 构造的抛面），则该 catch 是死分支，本发现降为无效。 | 如果服主的运维流程本就以 latest.log 的 SEVERE 行为对账依据且日志长期保留，则影响被运维手段缓解——但那不改变代码侧无收敛点的事实。

## F-slice-24-dc-02
- dimension: data-consistency / severity: MEDIUM
- evidence: `src/main/java/com/hilltopvillage/shop/NpcManager.java:86`
- artifact: `round1-02-audit-slice-24-data-consistency.md`
- claim: NPC 换生是「先删旧、再建新」且第二步无保护：despawnNpc() 已把旧实体 remove 并把字段置 null，spawnEntity 或其后的 setProfession/setCustomName 一旦抛异常，方法直接穿出，npc 字段停留在 null——世界里再没有带 shop-npc 标记的实体，而 arenas.yml 里的坐标还在。
- basis: 调用链：/hilltop shop set（HilltopCommandHandler:1205）或向导（SetupWizard:1031/1320）或启动恢复（NpcManager:301）→ spawnNpc → :86 despawnNpc()（内部 :155 npc.remove(); :156 npc=null）→ :92 spawnEntity → :109 this.npc = villager。:86 与 :92 之间无 try/catch，也没有保留旧 Location 供重建；:93-108 的 setAI/setProfession/setCustomName/PDC 写入同样不在保护内。方法体内没有任何回滚语句。
- alternatives: 如果 World#spawnEntity 在受支持的 Paper 版本上对本已加载世界永不抛（需检查 CraftWorld#spawnEntity 的失败路径），则失败窗口只存在于 :93-108 的后续调用。 | 如果上层命令/向导在 spawnNpc 外层有 catch 并调用 respawnFromConfig() 重建（需检查 HilltopCommandHandler.java:1205 与 SetupWizard.java:1031 前后 30 行的 try/catch），实际影响会被收敛为一次日志。 | 如果旧实体可被 cleanupOrphans 之外的机制自动补回（需检查是否有其它代码在 tick 里检测 npc==null 并重建），则该窗口不成立。

## F-slice-24-dc-03
- dimension: data-consistency / severity: LOW
- evidence: `src/main/java/com/hilltopvillage/shop/ShopManager.java:99`
- artifact: `round1-02-audit-slice-24-data-consistency.md`
- claim: reload 的成功路径只替换内存 config 并关闭残留 GUI，不重建也不改名在线 NPC；因此改 shop.npc.name 后 reload 返回 true、日志显示已加载，但实体头顶名仍是旧值，配置（源）与实体（派生状态）分叉，直到重启或重新 set 坐标。
- basis: ShopManager.reload() 成功分支（:82-106）只有 this.config = loader.load()（:84）、关闭 ShopGUI（:99-102）与 info 日志（:104），全程未调用 npcManager；NpcManager 中名字解析 String npcName = resolveNpcName() 的唯一调用点是 spawnNpc:102，赋值 setCustomName 在 :104，二者都只在生成时执行一次。respawnFromConfig:301 也只在启动时调用 spawnNpc。
- alternatives: 如果 /hilltop shop reload 的命令分支在 reload() 返回 true 后另有 despawnNpc()+spawnNpc()（需检查 HilltopCommandHandler.java:580 前后 20 行），本发现不成立。 | 如果 resolveNpcName() 在别处被周期性调用（需全仓搜 resolveNpcName 的调用点），实体名会被后续逻辑纠正；本切片内只看到 spawnNpc:102 一处。 | 如果 reload 的语义被文档明确限定为「只重载商品与 GUI，不重载 NPC 外观」，则属于契约与实现一致的设计限制，应降为文档问题而非一致性缺陷。

## F-slice-26-data-consistency-01
- dimension: data-consistency / severity: HIGH
- evidence: `src/main/java/com/hilltopvillage/util/YamlFiles.java:123`
- artifact: `round1-02-audit-slice-26-data-consistency.md`
- claim: 当 ATOMIC_MOVE 抛 AtomicMoveNotSupportedException 时，write() 降级为不带 ATOMIC_MOVE 的 REPLACE_EXISTING 移动；该移动失败（已进入替换、尚未完成）时 finally 会删除 tmp，磁盘上既没有可用的目标文件、也没有临时副本，与类注释『失败时目标文件保持原样』相反。
- basis: 控制流逐行：:117 生成同目录唯一 tmp，:119 写入完整内容，:121-122 首选 REPLACE_EXISTING+ATOMIC_MOVE，:123 捕获不支持原子移动，:124 用仅带 REPLACE_EXISTING 的 Files.move（无原子性），:126-130 的 finally 只要 tmp 仍存在就 tmp.delete()。JDK 明确 REPLACE_EXISTING 的检查与替换不是原子操作；本仓库 StatsManager.java:556-559 也自述 Windows 上该组合是『先删目标再重命名』。因此『删目标后改名失败 → 抛 IOException → finally 删 tmp』会让两份都不在。类注释 :29-30 承诺失败时目标保持原样，实际降级路径没有这个保证，且不像 StatsManager.java:600-604 那样打 WARNING，失败是静默的（调用方只看到 YamlFileGate.java:96 的 Failed to save）。
- alternatives: 如果本服配置文件所在文件系统都支持 ATOMIC_MOVE，:123 的降级分支永不进入，本发现不成立——需核对部署目录文件系统，入口 src/main/java/com/hilltopvillage/util/YamlFiles.java:123 | 如果运行时 JRE 在 Windows 上对非原子 REPLACE_EXISTING 的实现是改名失败时保留目标，则只有 tmp 被删、目标仍在——需核对实际 JRE 的 WindowsFileCopy.move 实现（仓库内不可见），调用点 src/main/java/com/hilltopvillage/util/YamlFiles.java:124 | 如果失败形态是进程被强杀或掉电而非抛异常，finally 不执行、tmp 留在目录可人工恢复——需确认失败形态，判断点 src/main/java/com/hilltopvillage/util/YamlFiles.java:126-130

## F-slice-26-data-consistency-02
- dimension: data-consistency / severity: HIGH
- evidence: `src/main/java/com/hilltopvillage/util/LanguageManager.java:90`
- artifact: `round1-02-audit-slice-26-data-consistency.md`
- claim: messages.yml 被隔离成 .corrupt 后，管理员执行一次 /hilltop reloadconfig 就会让 reload() 把该文件当成首次运行：load() 返回 ABSENT 且 usable()==true，readOnly 已被 reset 清成 false，于是 diskWritable 为 true，第 4 步用 !messagesFile.exists() 触发写盘，把 JAR 出厂文案写成一份新的 messages.yml，绕过『隔离期间不得写回』的降级语义。
- basis: 调用链：HilltopCommandHandler.java:396 reloadconfig 分支 → :408 messagesGate.reset()（清 readOnly/warned，YamlFileGate.java:102-105）→ :437 LanguageManager.reload() → :90 messagesGate.load() → YamlFileGate.java:52-61 → YamlFiles.load :80-81 因原文件已被 quarantine 的 Files.move（:169）挪走而返回 Loaded(空配置, ABSENT)；YamlFileGate.load :54-60 对 usable=true 且 status=ABSENT 两个分支都不进，readOnly 保持 reset 后的 false → :93 diskWritable=true → :155-163 把 JAR 非 _meta 键灌入 diskConfig → :165 !messagesFile.exists() 为 true → messagesGate.write(diskConfig)。YamlFiles.isQuarantined（:156-157）正是为这条链准备的双信号判据，ConfigManager.java:148/176/209 与 ArenaManager.java:848 都用了，LanguageManager 零调用；:91-92 的注释自称已处理该情形，但依赖的 isReadOnly 被 reset 清掉。
- alternatives: 如果 reload() 在 :165 写盘前调用 YamlFiles.isQuarantined(messagesFile, messagesGate) 或等价检查 .corrupt 是否存在，则不会写回——需检查 src/main/java/com/hilltopvillage/util/LanguageManager.java:153-167 之间是否有该判断（本回合读取：没有） | 如果 /hilltop reloadconfig 不调用 messagesGate.reset()，闸门仍锁、diskWritable 为 false，问题不成立——需检查 src/main/java/com/hilltopvillage/command/HilltopCommandHandler.java:408（本回合读到确实调用） | 如果 quarantine 是复制而非 move，原路径仍有文件、不会走到 ABSENT 分支——需检查 src/main/java/com/hilltopvillage/util/YamlFiles.java:169 的 Files.move

## F-slice-26-data-consistency-03
- dimension: data-consistency / severity: MEDIUM
- evidence: `src/main/java/com/hilltopvillage/util/LanguageManager.java:305`
- artifact: `round1-02-audit-slice-26-data-consistency.md`
- claim: setLocale() 用 Bukkit 的 plugin.saveConfig() 落盘 config.yml，该方法先截断目标再写；写入窗口内发生 IOException（磁盘满、进程被杀）会留下 0 字节或半截 config.yml，且该文件不在任何 YamlFileGate 的保护范围内。
- basis: LanguageManager.java:306 set 与 :307 saveConfig 成对，问题在写入方式：JavaPlugin#saveConfig 走 FileConfiguration.save(File)，先截断再写，正是 YamlFiles.java:20-21/29-30 点名要避免的形态；各 YamlFileGate 只守护 messages/arenas/game-settings/monsters/display/shop 等文件，config.yml 不在其中。Bukkit 对 saveConfig 的 IOException 只打 SEVERE、不重试、不保留旧文件；下次启动 loadConfiguration 解析失败会退化为空配置。入口 HilltopCommandHandler.java:1745-1747，/hilltop lang 且调用者为管理员或控制台。
- alternatives: 如果该版本 Paper/Spigot 的 FileConfiguration.save(File) 已改为先写临时文件再替换，则不存在截断窗口——需核对该服务端实现（仓库内不可见），调用点 src/main/java/com/hilltopvillage/util/LanguageManager.java:307 | 如果 config.yml 的每个键都能由默认值或其它持久化文件重建，则截断只造成设置回退而非数据丢失——需检查 config.yml 是否承载唯一副本，对照 src/main/java/com/hilltopvillage/util/LanguageManager.java:306 与 ConfigManager 的独立配置文件 | 如果 setLocale 只能由有文件系统权限的管理员在停服时调用，窗口可忽略——需检查 src/main/java/com/hilltopvillage/command/HilltopCommandHandler.java:1745-1747 的权限判定与在线调用路径

## F-slice-10-eh-01
- dimension: error-handling / severity: HIGH
- evidence: `src/main/java/com/hilltopvillage/command/SetupWizard.java:1175`
- artifact: `round1-02-audit-slice-10-error-handling.md`
- claim: 当 deploy(player) 解析不到部署管理器（目标世界未加载 / 竞技场定义缺失 / 部署期上下文刚被丢弃）时，四项必填复核把「无法检查」当成「四项齐备」返回 true；调用方 showStepDone 不区分该返回值来源，继续移除会话、清空 wizard.step / wizard.arena 并 saveConfig，随后 finishDeployment 走 reloadDefinitions → enableArena。错误路径被当成完成路径，产生不可逆的进度清除与一次竞技场启用尝试。
- basis: 调用链（本回合逐行读到）：HilltopCommandHandler.java:468-472 的 /hilltop setup goto 8 → SetupWizard.handle:1632-1665 的 case 8 → showStepDone:1005 → :1012 的 if (session != null && !validateCompletion(player, session)) return; → validateCompletion:1173-1175 在 d==null 时 return true，跳过 :1178-1197 的 spawnPoints / mobSpawnPoints / nodes / villagers / shopNpcLocation 五项检查 → :1060 sessions.remove、:1062 与 :1064 config.set(...,null)、:1065 saveConfig、:1068 finishDeployment(arenaId) → :173-177 reloadDefinitions 与 enableArena。deploy() 的 null 契约在 :70-73 明写，同文件另有 4 处判空（:731、:1021、:1141、:1723），说明 null 被作者视为可达状态。
- alternatives: 若存在会话时 deploy() 恒不为 null（start(Player) 在 :210 已用 deploymentGameManager(arenaId)==null 早退，且 :147 的 computeIfAbsent 会缓存上下文），则 :1175 不可达、本条应降为防御性冗余——需检查 SetupWizard.java:210 与 :121-158。 | 若 enableArena 对未部署竞技场一律拒绝（MultiArenaManager.java:293-306 对 definition==null / enabled==false / core==null 三处 return false），则「启用未完成竞技场」的后果不成立，只剩会话与进度被清——需检查 MultiArenaManager.java:302。 | 若被清掉的进度可由 arenas.yml 已落盘数据 + 重新 /hilltop setup 无损恢复（:240-260 的恢复只读 wizard.step / wizard.arena，不读业务数据），影响降为「管理员重走一遍向导」——需检查 SetupWizard.java:240-260。

## F-slice-10-eh-02
- dimension: error-handling / severity: MEDIUM
- evidence: `src/main/java/com/hilltopvillage/command/SetupWizard.java:921`
- artifact: `round1-02-audit-slice-10-error-handling.md`
- claim: sendShopStatus 在第 6 步状态行直接链式调用 deploy(player)，未判其 null 返回；同型未判空解引用至少还有 :452、:497-498、:538、:542、:555、:626、:875、:948、:1344、:1948、:2024。一旦 deploy 为 null，NPE 会从命令处理器或 InventoryClickEvent 处理器抛出，该次操作后续的消息、按钮行、GUI 刷新全部不执行，玩家得不到任何提示；clear-shop 在 :1344 就炸，配置与实体都不会被清。
- basis: deploy(Player) 在 :70-73 明确可返回 null（gm == null 时返回 null），gameManager 在 :64-67 也可返回 null；同文件 :731、:1021、:1141、:1723 都先判空，说明判空是本类既有约定。可达窗口与 F1 同源：live 实例 null、deploymentContexts 无缓存、createDeploymentContext（:151-158）因 def==null 或 world==null 返回 null；缓存移除点只有 :179（finishDeployment）与 :195（invalidateDeploymentContext）。GUI 侧入口为 :1734-1767 → handleSpawnGuiClick:1889 → default 分支 :1942-1962。
- alternatives: 若 deploymentContexts 在会话存活期间不会被移除（只有 :179、:194-196 两处 remove），则 d 恒非 null、本条不可达——需检查 SetupWizard.java:179 与 :194-196。 | 若 Bukkit/Paper 的事件分发器捕获监听器异常后继续派发（只记 Could not pass event），影响限于该次点击无响应，不构成服务器级故障——需检查服务端 InventoryClickEvent 的调用封装。 | 若所有进入 :921 的路径都先经过 start() 的 :210 上下文检查且中途不换世界，则该窗口不存在——需检查 SetupWizard.java:210 与 :1654-1661 的 goto 分支。

## F-slice-10-eh-03
- dimension: error-handling / severity: LOW
- evidence: `src/main/java/com/hilltopvillage/command/SetupWizard.java:1944`
- artifact: `round1-02-audit-slice-10-error-handling.md`
- claim: 第 3 步生成点 GUI 的删除分支对插件自造 tag 直接 Integer.parseInt，未包 try；同族村民分支 :1858-1883 与节点分支 :2111-2134 都包了 try、logger.warning 并回玩家一条提示，刷怪点分支 :2022 同样裸奔。tag 漂移时 NumberFormatException 会从 InventoryClickEvent 处理器逃逸：该次点击的删除、页码复位、GUI 刷新、autoSave 全部不执行，且插件侧零日志。
- basis: 对照证据在同一文件本回合读到：:1858-1883 的 catch (NumberFormatException ignored) 内有 plugin.getLogger().warning 与 player.sendMessage，注释明写「标签由本插件生成……正常路径不可达；真发生时……要出声」；:2111-2134 同型。而 :1944 与 :2022 的 parse 调用前后没有任何 try。tag 唯一生成侧是 :463 的 "setup-spawn-" + i 与 :2227 的 PDC 写入，本类不持久化 GUI 物品，因此这是错误处理口径不一致，不是外部输入信任问题。
- alternatives: 若 GUI 物品不跨 /reload 或跨版本存活（关闭界面即销毁），tag 漂移不可达，本条应降为纯一致性缺陷——需检查 SetupWizard.java:2227 的 PDC 写入与物品生命周期（本类未见持久化容器）。 | 若 Paper 对监听器抛出的 RuntimeException 统一打印含插件名与堆栈的日志，则「零留痕」不成立，只剩「玩家无反馈」——需检查服务端事件分发的日志实现。 | 若 setup-spawn- 前缀只有 :463 一处生成点且不会改，漂移概率极低，可只做防御性补齐——需检查 SetupWizard.java:463 与 :651、:800 的 tag 生成点。

## F-slice-16-error-handling-01
- dimension: error-handling / severity: MEDIUM
- evidence: `src/main/java/com/hilltopvillage/core/WaveManager.java:464`
- artifact: `round1-02-audit-slice-16-error-handling.md`
- claim: 刷怪默认分支只捕获 IllegalArgumentException，且对 gameManager.getGameWorld() 的返回值不判空；一旦 world 为 null 或 spawnEntity 之后抛出其它 RuntimeException，异常会从 runTaskTimer 的任务体冒出，本波批次中止且 onComplete 永不执行——GameManager.waveSpawning 因此永久为 true，清波判定被永久短路，本波无法结束。
- basis: 控制流：:136-172 的 BukkitRunnable.run() 在 :157 调用 spawnCustomMob，而 spawnCustomMob 在 :449 取 world、:464 直接 world.spawnEntity，:462-476 的 try 只 catch IllegalArgumentException（:474）。异常冒泡后 :164 的 spawnedCount[0] >= remainingRef[0] 永不成立，:168 的 onComplete.run() 不执行；onComplete 是 GameManager.java:321 传入的 () -> waveSpawning = false，而 waveSpawning 只在 :319 置 true、:325 catch 分支与回调里复位。GameManager.java:445 的清波判定写作 if (!waveSpawning && waveManager.isWaveCleared())，故标志卡 true 即永久不判完成；超时保险在 GameManager.java:475-476 因 timeoutSeconds <= 0（注释称默认 0）直接 return。同类路径把 world 当可空处理（:334 if (loc != null && world != null)、:404 if (world == null) return 0;、:982 dropLoc.getWorld() == null），说明作者在别处已承认该值可能为 null。
- alternatives: 若 GameManager.gameWorld 在构造后不可能为 null（唯一赋值点 GameManager.java:121，实参来自 ArenaInstance.java:140 的 coreLocation.getWorld()），则 NPE 路径不可达，本条只剩「非 IAE 异常不被捕获」的窄面——需检查 GameManager.java:121 与 ArenaInstance.java:140 是否存在世界未加载窗口 | 若 Bukkit 对 runTaskTimer 任务体抛出的异常不是取消任务而是继续调度，后果变为每 3 tick 重复同一异常且本波同样永不完成，结论不变但表现不同——需在测试服注入一次异常观察调度器行为 | 若 GameManager 在 haltGame/endGame 等路径无条件复位 waveSpawning（例如 GameManager.java:636），清波短路会被打破，后果降为「本波少刷怪」——需核对 :636 是否覆盖所有失败路径

## F-slice-16-error-handling-02
- dimension: error-handling / severity: MEDIUM
- evidence: `src/main/java/com/hilltopvillage/core/WaveManager.java:1011`
- artifact: `round1-02-audit-slice-16-error-handling.md`
- claim: 空投批次任务体内的 spawnEntity 没有任何 try/catch，mobType 来自管理员可配的空投怪类型；一旦该类型不可生成而抛 IllegalArgumentException，本批剩余空投永久丢失，且任务句柄不会被移出 airdropTasks，成为集合内的死句柄直到整局结束才被清空。
- basis: 控制流：spawnAirdropMobs 在 :982 只判 dropLoc/world/mobType 非空，:993-1027 的任务体从 :1011 到 :1025 无 try，异常直接冒出 run()。句柄生命周期为 :1028 airdropTasks.add(handle[0])，而集合内唯一移除点是 :1002 airdropTasks.remove(handle[0])，它只在守卫分支（dropper 失效 / 换波 / 游戏结束 / 已满 / 数量够）执行；异常路径既不 remove 也不 cancel，只有 clearAllMobs -> cancelAirdropTasks（:898-903）在整局结束才全量清空。同文件三条特殊怪生成路径对同一调用显式包了 catch (Exception)（:554-561、:602-609、:655-662）并注明「不能让异常冒泡终止整个刷怪任务」，本条路径缺这道守卫。
- alternatives: 若 AirdropSpawnGoal.java:265 传入的 mobType 已被上游限制为可生成白名单，则 IAE 不可达——需读该文件里 mobType 的取值来源 | 若 World#spawnEntity 对任何 EntityType 常量都不抛 IAE（例如统一返回 null），则本条不成立——需在测试服对 PLAYER 之类不可生成类型实调一次 | 若 airdropTasks 存在本文件之外的周期性清理，死句柄泄漏量可忽略——需检查 clearAllMobs 之外是否有 cancelAirdropTasks 的调用点

## F-slice-16-error-handling-03
- dimension: error-handling / severity: LOW
- evidence: `src/main/java/com/hilltopvillage/core/WaveManager.java:574`
- artifact: `round1-02-audit-slice-16-error-handling.md`
- claim: 三条特殊怪生成路径对 getAttribute 的返回值直接解引用，而同文件 applyMonsterEquipment 对 ATTACK_DAMAGE 做了判空；若 monsters.<id>.entity-type 被配置成不具备 MAX_HEALTH 的实体，:574 / :622 / :682 会抛 NPE，且该异常在 :554-561 的 try 之外，会从刷怪任务体冒出。
- basis: 同族守卫不一致：:491-492 写作 var attackAttr = entity.getAttribute(Attribute.ATTACK_DAMAGE); 后接 if (attackAttr != null && mc.getBaseDamage() > 0)，证明作者认为 getAttribute 可返回 null；而 :574（甲虫）、:622（猎手）、:682（抛投者）三处均直接 .setBaseValue，:584/:632/:692 的 MOVEMENT_SPEED 同样。这三条路径的 entityType 都可被配置覆盖（:551-552、:599-600、:652-653），只经过 instanceof Mob 判定（:562、:610、:663），而 :554-561 的 try 只包住 spawnEntity 本身，属性设置在其外。
- alternatives: 若目标 paper-api 版本中所有 Mob 实现都带 MAX_HEALTH 属性，则本条只是风格不一致，应删除——需查 pom.xml 的 paper-api 版本后对照 Attribute 覆盖表 | 若 MonsterConfig#getEntityType 在配置加载期已过滤为带 MAX_HEALTH 的白名单，则不可达——需读 GameConfig 的 MonsterConfig 实现 | 若 Bukkit 的 getAttribute 对缺失属性返回默认实例而非 null（与 :491 的判空写法矛盾），则本条不成立——需以一次实调或 API 文档确认返回语义

## F-slice08-eh-01
- dimension: error-handling / severity: MEDIUM
- evidence: `src/main/java/com/hilltopvillage/command/HilltopCommandHandler.java:1103`
- artifact: `round1-02-audit-slice-08-error-handling.md`
- claim: 当 arenas.yml 或 nodes.yml 不可用（被隔离成 *.corrupt、闸门只读、竞技场世界未加载）时，/hilltop deploy reloadnodes 仍然无条件播报 deploy.reloadnodes-done 并打印旧的节点数：管理员收到成功回执，而两个加载器都已早退、什么都没重读。
- basis: 调用链：/hilltop deploy reloadnodes → HilltopCommandHandler.handle case "deploy"(HCH:380-386) → handleDeployCommand → switch(args[1]) case "reloadnodes"(HCH:1102) → deploy.loadSpawnPoints()(AdminDeployManager:216，失败分支 220-225 / 238-243 只置 lastSaveFailed 并 return，249-252 连标记都不置) → loadNodesFromConfig()(NodeSystem:127，失败分支 133-137 / 145-151 只 warning/severe 并 return) → HCH:1105 无任何 if 包裹直接发 done 文案。同文件 9 处同类命令都经 reportDeploySaveFailure 消费 consumeSaveFailure()（HCH:681-685 定义，918/945/960/1001/1037/1075/1122/1160/1215 调用），reloadnodes 是唯一漏点。
- alternatives: 如果 AdminDeployManager.loadSpawnPoints 在失败时抛异常而不是 return，命令就不会走到 1105 行的成功播报——需检查 AdminDeployManager.java:238-243 的 return 语义。 | 如果 nodes.yml 损坏时 loadNodesFromConfig 会清空节点、使 getTotalCount() 变成 0，管理员从「0 个节点」也能看出异常，误导性会显著下降——需检查 NodeSystem.java:145-151 是否刻意保留旧节点。 | 如果运维约定「控制台日志才是唯一权威反馈、命令回执不保证真实」，则该问题只是文案瑕疵而非静默失败——需检查 README/运维文档是否明示这一点。

## F-slice-04-logic-01
- dimension: logic / severity: LOW
- evidence: `src/main/java/com/hilltopvillage/ai/ExplodeBeetleGoal.java:243`
- artifact: `round1-02-audit-slice-04-logic.md`
- claim: 当 nodes.self-destruct-multiplier 为 NaN 或 Infinity 时，Math.max(0, ...) 会原样保留非有限值，使 nodeDamage 变成 NaN/Infinity；下游 NodeSystem.damageNode:696 的 !Double.isFinite(damage) 会返回 0，因此当前不会写坏节点血量、不会抛异常，但本行的非负钳制对 NaN/Infinity 实际无效，非法配置被静默折算成 0 伤害且无日志。相邻 explodeMultiplier 在 :241-242 做了 Double.isFinite 折算，同族守卫不一致。
- basis: 第 241-242 行对 rawExplodeMultiplier 使用 Double.isFinite(rawExplodeMultiplier) && rawExplodeMultiplier > 0 ? rawExplodeMultiplier : 0；第 243 行对 nodeMultiplier 只有 Math.max(0, ...)。Java 语义下 Math.max(0, Double.NaN) 返回 NaN，Math.max(0, PositiveInfinity) 返回 Infinity。配置侧 ConfigManager.java:1515 对 nodes.self-destruct-multiplier 仅 settingsYaml.getDouble(...) 后 setNodeSelfDestructMultiplier，没有 :776-784 的 normalizeExplodeDamageMultiplier 那类 NaN→0 / +Inf→10 归一化。控制流：ExplodeBeetleGoal.tick:162 -> :185-186 -> explode:243-244 -> :259 NodeSystem.damageNode:696，后者以 !Double.isFinite(damage) 返回 0，因此本条没有数据损坏，只是本地守卫失效与非法配置静默归零。
- alternatives: 如果 YamlFiles.gameSettingsValidator 在加载阶段已拒绝 .nan / .inf 这类非有限 double，则该输入不可达、本条不成立——需检查 YamlFiles.java 的 gameSettingsValidator（本回合未读该文件，无法确认）。 | 如果所有 setNodeSelfDestructMultiplier 调用点都只接受 GUI 滑块值（NodeSettingsMenu 的 0.5-10、步长 0.5），则非有限值只能来自手改 game-settings.yml；ConfigManager.java:1515 本身不做有限性校验，故手改路径仍可达。 | 如果设计上把 NodeSystem.damageNode:696 的 Double.isFinite 视为该值的正式归一化点，则本行只是重复防御、无独立影响——需确认『每个消费点自守』是否为本项目约定；explodeMultiplier 的本地折算说明作者并不完全依赖下游。

## F-slice-20-security-01
- dimension: security / severity: MEDIUM
- evidence: `src/main/java/com/hilltopvillage/mechanics/ArenaAccessListener.java:49`
- artifact: `round1-02-audit-slice-20-security.md`
- claim: 竞技场世界准入只在 PlayerTeleportEvent 上实现，没有登录/重生/实体传送/周期扫描等任何兜底时机；不经过玩家传送事件的进场路径（典型为载具乘客随载具跨世界）不会被拦截，非成员因此可留在竞技场世界并对对局进行干预。
- basis: 调用链：大厅玩家 → 乘上载具 → 载具跨世界进入竞技场世界（传送门连通，或由 OP/插件对载具执行跨世界传送）→ 服务端只对载具派发 EntityTeleportEvent，而本类是 Listener 且全类仅 :49-50 一个 @EventHandler（PlayerTeleportEvent），守卫不执行 → 玩家以非成员身份存在于世界内。进入后的影响链：FriendlyFireListener.java:45-46 解析 damager，:55 在 arena.isPlayer 为 false 时提前 return，非成员对成员的伤害不被拦；本类唯一的执行动作是 :80 的 event.setCancelled(true)，没有驱逐已在世界内非成员的动作，因此落地后不再有任何世界级检查。
- alternatives: 若 Paper 1.21 在载具跨世界时对乘客补发 PlayerTeleportEvent，则该路径不成立——需在 1.21 Paper 上实测 Entity#teleport 对 passenger 的事件派发（服务端实现，不在本仓库）。 | 若竞技场世界与主世界/下界之间不存在传送门连通，且服务器上不存在可移动载具的授权方（OP/插件），则利用前提与 hilltopvillage.admin 豁免等价，影响降为加固建议——需检查 arenas.yml 各场的 world 与服务器世界 environment/portal 配置。 | 若进入后的下一次传送或登录总会被其它守卫纠正，滞留窗口会被压缩——需确认 HilltopVillagePlugin.java:477 的 join、:515 的 respawn、ArenaInstance.java:1388 的 reset 残留循环在「玩家在线且不再传送」时是否仍会触发（本回合读到的代码都不会周期性触发）。

## F-slice-20-security-02
- dimension: security / severity: LOW
- evidence: `src/main/java/com/hilltopvillage/arena/MultiArenaManager.java:1067`
- artifact: `round1-02-audit-slice-20-security.md`
- claim: 登录路径上唯一的「把非成员挪出竞技场世界」动作以大厅出生点非空为前提：getLobbySpawn() 返回 null 时 applyLobbyState 既不传送也不做任何世界判定，曾在对局中退服、对局结束后重登的玩家会以非成员身份滞留在竞技场世界。
- basis: 调用链：HilltopVillagePlugin.java:509 applyJoinState → MultiArenaManager.java:1064 applyLobbyState → :1067 的 spawn != null 短路。前置状态链：玩家以成员身份 /hilltop join（joinArena:738 → addPlayer）→ 对局中退服，handleQuit:151-160 保留位置并只登记 PendingRejoin（不传送、不移出世界）→ 对局结束 reset()（ArenaInstance.java:1382-1407）只对在线残留调用 removePlayer，离线者仅清集合与映射（:1410）→ 重登时 tryRejoin 因窗口过期返回 false、isInArena 为 false → applyLobbyState。getLobbySpawn 的契约是「未配置或世界未加载时返回 null」（MultiArenaManager.java:976-980），此时 :1067 整段被短路，玩家留在原世界。ArenaAccessListener 不参与（登录不是传送事件），非成员可攻击成员/波次怪、拾取掉落货币、使用商店 NPC、破坏方块。
- alternatives: 若生产配置始终写入 lobby.world 与 lobby.spawn 且大厅世界总能加载，getLobbySpawn() 恒非 null，该路径不成立——需检查 arenas.yml 的 lobby 段与启动日志中的大厅世界缺失告警（isConfiguredLobbyWorldMissing，MultiArenaManager.java:1014）。 | 若 reset() 同时对离线玩家写回大厅坐标，则重登位置本就安全——需核对 ArenaInstance.java:1382-1407 的残留循环，当前只对 online 玩家调用 removePlayer。 | 若 PlayerJoinEvent 之后还有周期性驱逐（某个 getArenaByWorld 调用点把非成员踢出），滞留会被纠正——需 grep 全部 getArenaByWorld 调用点；本切片已核对 ArenaAccessListener.java:60、FriendlyFireListener.java:50、HilltopVillagePlugin.java:531 三处，均非驱逐逻辑。
