# 产物聚合摘要（机械生成）

产物文件：39；解析成功信封：37；解析失败：0

## 信封清单

| file | role | agent_id | status | slice/dim/role | 计数 |
|---|---|---|---|---|---|
| round1-01-recon-slices.md | recon | recon-01 | SUCCESS | slices=26 | |
| round1-02-audit-slice-01-data-consistency.md | audit | audit-slice-01-data-consistency | SUCCESS | data-consistency confirmed=2 | |
| round1-02-audit-slice-05-data-consistency.md | audit | audit-slice-05-data-consistency | SUCCESS | data-consistency confirmed=1 | |
| round1-02-audit-slice-08-error-handling.md | audit | audit-slice-08-error-handling | SUCCESS | error-handling confirmed=1 | |
| round1-02-audit-slice-11-data-consistency.md | audit | audit-slice-11-data-consistency | SUCCESS | data-consistency confirmed=5 | |
| round1-02-audit-slice-13-contract.md | audit | audit-slice-13-contract | SUCCESS | contract confirmed=2 | |
| round1-02-audit-slice-15-concurrency.md | audit | audit-slice-15-concurrency | SUCCESS | concurrency confirmed=3 | |
| round1-02-audit-slice-20-concurrency.md | audit | audit-slice-20-concurrency | SUCCESS | concurrency confirmed=2 | |
| round1-02-audit-slice-21-concurrency.md | audit | audit-slice-21-concurrency | SUCCESS | concurrency confirmed=1 | |
| round1-02-audit-slice-24-data-consistency.md | audit | audit-slice-24-data-consistency | SUCCESS | data-consistency confirmed=3 | |
| round1-02-audit-slice-26-data-consistency.md | audit | audit-slice-26-data-consistency | SUCCESS | data-consistency confirmed=3 | |
| round1-02-sweep-slice-01.md | sweep | sweep-slice-01 | SUCCESS | slice-01 PROD leads=6 | |
| round1-02-sweep-slice-02.md | sweep | sweep-round1-slice-02 | SUCCESS | slice-02 PROD leads=6 | |
| round1-02-sweep-slice-03.md | sweep | sweep-slice-03 | SUCCESS | slice-03 PROD leads=5 | |
| round1-02-sweep-slice-04.md | sweep | sweep-slice-04 | SUCCESS | slice-04 PROD leads=6 | |
| round1-02-sweep-slice-05.md | sweep | sweep-slice-05 | SUCCESS | slice-05 PROD leads=6 | |
| round1-02-sweep-slice-06.md | sweep | sweep-slice-06 | SUCCESS | slice-06 PROD leads=5 | |
| round1-02-sweep-slice-07.md | sweep | sweep-slice-07 | SUCCESS | slice-07 PROD leads=5 | |
| round1-02-sweep-slice-08.md | sweep | sweep-slice-08 | SUCCESS | slice-08 PROD leads=6 | |
| round1-02-sweep-slice-09.md | sweep | sweep-slice-09 | SUCCESS | slice-09 PROD leads=4 | |
| round1-02-sweep-slice-10.md | sweep | sweep-slice-10 | SUCCESS | slice-10 PROD leads=6 | |
| round1-02-sweep-slice-11.md | sweep | sweep-slice-11 | SUCCESS | slice-11 PROD leads=6 | |
| round1-02-sweep-slice-12.md | sweep | sweep-slice-12 | SUCCESS | slice-12 PROD leads=6 | |
| round1-02-sweep-slice-13.md | sweep | sweep-slice-13 | SUCCESS | slice-13 PROD leads=6 | |
| round1-02-sweep-slice-14.md | sweep | sweep-slice-14-r1 | SUCCESS | slice-14 PROD leads=5 | |
| round1-02-sweep-slice-15.md | sweep | sweep-slice-15 | SUCCESS | slice-15 PROD leads=6 | |
| round1-02-sweep-slice-16.md | sweep | sweep-slice-16 | SUCCESS | slice-16 PROD leads=6 | |
| round1-02-sweep-slice-17.md | sweep | sweep-slice-17 | SUCCESS | slice-17 PROD leads=7 | |
| round1-02-sweep-slice-18.md | sweep | sweep-slice-18 | SUCCESS | slice-18 PROD leads=5 | |
| round1-02-sweep-slice-19.md | sweep | sweep-slice-19 | SUCCESS | slice-19 PROD leads=6 | |
| round1-02-sweep-slice-20.md | sweep | sweep-slice-20 | SUCCESS | slice-20 PROD leads=6 | |
| round1-02-sweep-slice-21.md | sweep | sweep-slice-21 | SUCCESS | slice-21 PROD leads=6 | |
| round1-02-sweep-slice-22.md | sweep | sweep-slice-22 | SUCCESS | slice-22 PROD leads=6 | |
| round1-02-sweep-slice-23.md | sweep | sweep-slice-23 | SUCCESS | slice-23 PROD leads=7 | |
| round1-02-sweep-slice-24.md | sweep | sweep-slice-24 | SUCCESS | slice-24 PROD leads=6 | |
| round1-02-sweep-slice-25.md | sweep | sweep-slice-25 | SUCCESS | slice-25 PROD leads=6 | |
| round1-02-sweep-slice-26.md | sweep | sweep-slice-26 | SUCCESS | slice-26 PROD leads=6 | |

## 线索（lead）

| slice | id | dim | conf | 位置 | 摘要 |
|---|---|---|---|---|---|
| slice-01 | L1 | data-consistency | MEDIUM | admin/ArenaResetService.java:295 | 只把 removed==0 当失败，部分删除（0<removed<expected）会继续重置，nodes.yml 残留无主节点。 |
| slice-01 | L2 | error-handling | MEDIUM | admin/ArenaResetService.java:244 | 异常兜底只释放 in-flight 并回调，不调用 abort/reinstate，已 disableArena 的竞技场会静默停在 DISABLED。 |
| slice-01 | L3 | data-consistency | MEDIUM | admin/ArenaResetService.java:312 | 商店实体在 clearDeploymentData 之前删除，后一步失败中止并重新启用时实体不会恢复，配置里的 shop-npc 仍在。 |
| slice-01 | L4 | data-consistency | MEDIUM | admin/AdminDeployManager.java:557 | 一次保存拆成两次整份写盘，第二次失败留下生成点已更新、shop-npc 未更新的半成功磁盘状态。 |
| slice-01 | L5 | data-consistency | LOW | admin/AdminDeployManager.java:399 | 迁移写盘前不重新 load，用 loadSpawnPoints 期间的陈旧整份副本覆写，可能回滚其它写入方的落盘内容。 |
| slice-01 | L6 | data-consistency | LOW | admin/ArenaAdminService.java:542 | 只读的 buildView 调用 loadArenas -> gate.load()，而 load 可能把 arenas.yml 隔离成 .corrupt 并上闩只读。 |
| slice-02 | L1 | error-handling | MEDIUM | admin/LocationParticlePreview.java:97 | 注释声称覆盖「世界未加载」，但判据只有引用为 null，未加载世界的引用通常仍非 null，逐点绘制仍会走进 spawnParticle。 |
| slice-02 | L2 | contract | MEDIUM | admin/LocationParticlePreview.java:67 | PointKind 提供的 emptyKey()/showingKey() 按类别区分文案且部署侧确实在用，本类却硬编码通用键，传入的 kind 只用于取色，两套预览的文案契约不一致。 |
| slice-02 | L3 | logic | LOW | admin/LocationParticlePreview.java:72 | 上一行注释称「快照一份，避免预览过程中源列表被其它逻辑改动」，但这是浅拷贝，Location 元素仍与调用方共享引用。 |
| slice-02 | L4 | data-consistency | LOW | admin/LocationParticlePreview.java:88 | 任务表的清理只写在正常结束分支内，循环里 drawMarker 一旦抛异常就跳过 cancel/清理，previewTasks 会残留指向已死任务的条目。 |
| slice-02 | L5 | contract | LOW | admin/PointParticleRenderer.java:52 | show(...) 未校验 kind，drawMarker 的 javadoc 也只声明 world 非 null，这里直接解引用 kind；null 会在 4 tick 周期的任务里抛 NPE。 |
| slice-02 | L6 | logic | LOW | admin/PointKind.java:52 | 枚举常量位于 BEAM_DUST_SIZE/SPIRAL_DUST_SIZE 声明之前，构造常量时按文本顺序这两个静态字段尚未赋值，当前只因它们是编译期常量被内联才没暴露成 0.0f 尺寸。 |
| slice-03 | L1 | data-consistency | MEDIUM | admin/gui/ArenaManageGUI.java:663 | applyParam 用点击瞬间的 ArenaView 快照回写未修改的三项参数，聊天栏输入期间经命令改过的参数会被旧值覆盖（类注释 640-642 自认此取舍）。 |
| slice-03 | L2 | contract | MEDIUM | admin/gui/ArenaManageGUI.java:496 | 删除用渲染时算出的全局 index，点击时不按当前列表重新定位也不校验边界，渲染后列表被外部命令改动会删错点位。 |
| slice-03 | L3 | concurrency | MEDIUM | admin/gui/AbstractAdminMenu.java:71 | @EventHandler 挂在每次打开菜单都 new 的 GUI 实例上，而命令层每次打开都 registerEvents(gui)（HilltopCommandHandler.java:666），未见 unregisterAll，监听器随打开次数累积并持有 Player/Inventory 引用 |
| slice-03 | L4 | security | LOW | admin/gui/ArenaManageGUI.java:772 | 破坏性重置在点击时直接执行，本类内未见权限节点复核，权限若只在打开菜单时校验，撤权后已打开的菜单仍可执行。 |
| slice-03 | L5 | logic | MEDIUM | admin/gui/ArenaManageGUI.java:802 | 该分支发完 fail-skipped-world 后没有 return，会继续执行 805 行的 manage.reset.partial + failStepText("restore")，一次失败向管理员播报两条口径冲突的消息。 |
| slice-04 | L1 | error-handling | HIGH | ai/AirdropSpawnGoal.java:107 | targetDropLocation 属于 gameWorld，而 dropper 可用外部传送/换世界脱离该世界；此处直接 distanceSquared 未先比 world，跨世界会抛 IllegalArgumentException，同包 DropperAttackGoal 在 :191 明确 |
| slice-04 | L2 | logic | HIGH | ai/ExplodeBeetleGoal.java:243 | 上一行注释自己写明 NaN 会穿透 Math.max(0, NaN)，但只守了 explodeMultiplier，nodeMultiplier 仍走 Math.max，NaN 会传进 nodeDamage → damageNode(loc, NaN)。 |
| slice-04 | L3 | logic | MEDIUM | ai/ExplodeBeetleGoal.java:170 | noTargetTicks 到点后没有置位/清零的闩锁也没 return 之外的退出条件，beetle 若未立即失效，下一 tick 仍进同一分支再次 discardMob，重复出列；:201 的卡死分支同样是先 discardMob 再 return。 |
| slice-04 | L4 | logic | MEDIUM | ai/NodeAttackGoal.java:232 | 寻路终点用 +1.0 的 Y，而同文件 :129 的攻击判定基准 targetCenter 用 +0.5 的 Y，两处高度基准不一致（ExplodeBeetleGoal:122 也是 +1）。 |
| slice-04 | L5 | logic | MEDIUM | ai/NodeAttackGoal.java:131 | 「目标是否变了」用 NodeData 对象的引用不等来判断；若 getNearestNode 每次返回新的包装对象，同一节点也会判成 changed，tick() 里的 stuckTicks 会被每 30 tick 清零，:209 的 60-tick 卡死兜底可能永远到不了。 |
| slice-04 | L6 | logic | MEDIUM | ai/DropperAttackGoal.java:88 | 这条复用分支只校验目标合法，不复核 HUNT_RANGE_SQ（:42 的 900.0 平方格）也不复核距离，玩家跑远后抛投者会一直追；shouldStayActive(:99) 同样没有距离条件。 |
| slice-05 | L1 | error-handling | MEDIUM | arena/ArenaInstance.java:140 | getCore() 在 ArenaDefinition 中允许返回 null（未部署态），构造函数未判空即解引用，抛 NPE 而非可读异常。 |
| slice-05 | L2 | data-consistency | MEDIUM | arena/ArenaInstance.java:766 | stopGame() 在此显式调用一次，随后 setState(ENDING) 经 onGameEnd() 又调用一次，同一收尾链上 gameManager.stopGame 执行两遍。 |
| slice-05 | L3 | logic | MEDIUM | arena/ArenaInstance.java:814 | 直接写 state 字段而绕过 setState()，restoreStarted 的回滚硬屏障与迁移分支都不生效。 |
| slice-05 | L4 | concurrency | LOW | arena/ArenaInstance.java:953 | 对 volatile definition 做「读-派生-整体替换」的非原子读改写，与 applyWaitingLocation 的同类替换并发时互相丢更新。 |
| slice-05 | L5 | data-consistency | MEDIUM | arena/ArenaInstance.java:1489 | reset() 内部已对同一世界发起 restoreWithResult 异步回滚，这里再强制 restoreNow 一次，同一世界存在两条回滚请求。 |
| slice-05 | L6 | contract | MEDIUM | arena/ArenaInstance.java:246 | 屏障命中时 setState 静默 return，void 签名让调用方无法区分「已迁移」与「被吞」，后续 scheduleReset 仍会置位。 |
| slice-06 | L1 | data-consistency | MEDIUM | arena/ArenaManager.java:836 | findArenaKey 返回首个大小写不敏感匹配，而 load() 只注册通过 ARENA_ID 校验的小写键；同一 ID 的大小写变体并存时，写入可能落到被 load() 跳过的 YAML 节点。 |
| slice-06 | L2 | error-handling | MEDIUM | arena/ArenaManager.java:869 | requiredDouble 只用 isSet 判断存在，随后 getDouble 对非数值标量取默认 0.0，损坏坐标会被静默当成合法 (0,0,0) 而不是报错。 |
| slice-06 | L3 | logic | MEDIUM | arena/ArenaManager.java:563 | waiting-location 段存在但解析失败时 readOptionalLocation 返回 null，覆盖了上一行以 core 作默认值的回退，可能让等待区变成 null。 |
| slice-06 | L4 | contract | MEDIUM | arena/ArenaRegistry.java:27 | 同一个 public get 对 null 返回 null，但对空串/空白抛 IllegalArgumentException，调用方若只判 null 会被异常穿透。 |
| slice-06 | L5 | data-consistency | MEDIUM | arena/ArenaManager.java:374 | lobby.spawn 坐标直接 getDouble 后构造 Location，未像竞技场坐标那样校验 isFinite，YAML 中 .NaN/.inf 可进入传送路径。 |
| slice-07 | L1 | data-consistency | MEDIUM | arena/MultiArenaManager.java:768 | 映射指向已移除实例时 getPlayerArena 返回 null，清理映射的分支被整段跳过，isInArena 永久为真而 leaveArena 永远空转。 |
| slice-07 | L2 | data-consistency | MEDIUM | arena/MultiArenaManager.java:101 | 先删重连记录与玩家映射、后调 removePlayer/removeOfflinePlayer，副作用抛异常时记录已不可恢复，玩家留在实例里却无映射。 |
| slice-07 | L3 | logic | MEDIUM | arena/MultiArenaManager.java:364 | 世界仍在隔离/回滚时把队首放回队尾但 1-tick 任务不停，同一场在 60 秒级窗口内被约 20 次/秒重复 poll 并重做冲突扫描。 |
| slice-07 | L4 | error-handling | MEDIUM | arena/MultiArenaManager.java:110 | 每秒重连扫描的循环内没有 try/catch，单场抛异常会让整个 runTaskTimer 任务被取消，此后所有待过期重连记录永不处理。 |
| slice-07 | L5 | error-handling | LOW | arena/MultiArenaManager.java:362 | 同文件对 PlayerGoodsManager 做了可能为 null 的兜底，此处却直接解引用 MapRestoreManager；为 null 时启用队列任务 NPE 停摆。 |
| slice-08 | L1 | error-handling | HIGH | command/HilltopCommandHandler.java:1582 | 上一行 stats.get(uuid) 的返回值未判空即解引用，紧随其后的 target == null 判空因此不可达——查询返回 null 时 /hilltop stats 会 NPE。 |
| slice-08 | L2 | contract | MEDIUM | command/HilltopCommandHandler.java:614 | nodes 子命令只在 args.length >= 4 时被识别，`/hilltop config nodes repairitem` 这种 3 参数形态会落到函数末尾打开配置 GUI，既不报用法缺失也不报未知子命令。 |
| slice-08 | L3 | contract | MEDIUM | command/HilltopCommandHandler.java:297 | 唯一一个把用户输入原样交给 manager 的子命令（同 switch 的 start/stop/status/wave 都先 resolveArena 并播报解析失败），且上一行已执行 leaveArena，join 失败时玩家停在已退场未入场的中间态。 |
| slice-08 | L4 | logic | MEDIUM | command/HilltopCommandHandler.java:253 | stop 分支没有像 start 那样的状态前置检查，解析到实例后直接停服并固定播报 game-stopped，对 WAITING/结算中/地图恢复中的场会给出与真实状态不符的成功文案。 |
| slice-08 | L5 | contract | LOW | command/ArenaCommand.java:39 | 无参路径直接返回 true，类中已无 usage/help 分支，命令被执行器调用时空参数会得到零反馈的静默成功。 |
| slice-08 | L6 | data-consistency | LOW | command/HilltopCommandHandler.java:915 | 坐标文案用 String.format 加默认 Locale，非英文服务端会输出逗号小数（12,5），而同类坐标在 listspawns 里被当作可粘回命令的参数展示。 |
| slice-09 | L1 | contract | MEDIUM | command/HilltopTabCompleter.java:70 | config 在此被列入统一用 hilltopvillage.admin 过滤的 isAdmin 名单，而 HilltopCommandHandler.java:389 的 case "config" 检查的是 hilltopvillage.config.admin，补全侧与分发侧的权限节点不一致 |
| slice-09 | L2 | contract | LOW | command/HilltopTabCompleter.java:192 | top 的合法类型集合在补全侧硬编码，分发侧用 StatsManager.StatType.fromKey 解析，同一集合双源维护，枚举变更时补全会静默失真 |
| slice-09 | L3 | contract | LOW | command/HilltopTabCompleter.java:58 | 全文件其余分支一律返回 List（空表），唯此支返回 null，同一方法存在两种返回语义，调用方无法区分「不管此命令」与「补全为空」 |
| slice-09 | L4 | logic | LOW | command/HilltopTabCompleter.java:118 | 第三参数补全只判长度与管理员权限，不校验 args[1] 是否为 clear/skip，非法 action 下仍会补出竞技场 ID |
| slice-10 | L1 | contract | MEDIUM | command/SetupWizard.java:1944 | GUI 删除分支裸 parseInt 无 try，而同族村民(1859)/节点(2112)分支都包了 try 并留痕，输入源同为插件自造 tag。 |
| slice-10 | L2 | logic | MEDIUM | command/SetupWizard.java:1845 | GUI 点击处理器不校验 s.step 就直接 advance()，而聊天路径每条子命令都有步骤守卫，且 goto 不关闭已打开的界面。 |
| slice-10 | L3 | data-consistency | MEDIUM | command/SetupWizard.java:1687 | autoSave 在 saveToFile() 返回 false 时仍写入 wizard.step 并 saveConfig，进度指针落盘而数据未落盘。 |
| slice-10 | L4 | error-handling | HIGH | command/SetupWizard.java:1175 | 四项必填复核在解析不到部署管理器时直接放行(true)，而放行后紧接着会清会话与进度并 enableArena。 |
| slice-10 | L5 | data-consistency | MEDIUM | command/SetupWizard.java:133 | 缓存上下文只重载 spawnPoints 与 nodes，villagers/shop 仍是构造期内存副本，注释所述的整份写回风险只剩这两项未堵。 |
| slice-10 | L6 | error-handling | MEDIUM | command/SetupWizard.java:921 | deploy() 可返回 null 且同文件五处显式防了 null，但 sendShopStatus/clear-shop/autoSave 等调用点直接解引用。 |
| slice-11 | L1 | data-consistency | HIGH | config/ConfigManager.java:1425 | 读盘失败分支在未写入任何文件的情况下推进已落盘快照，使内存中的未保存改动被 hasUnsavedChanges 判成已保存。 |
| slice-11 | L2 | data-consistency | HIGH | config/ConfigManager.java:1442 | contains 为真不代表 getString 非 null，空值或非字符串标量会把 null 直接写进 worldName，而相邻的 material 键都有 null 判。 |
| slice-11 | L3 | data-consistency | MEDIUM | config/ConfigManager.java:1469 | 同一文件对 explode-damage-multiplier 专门挡 NaN/Infinity，villager-health 却裸 getDouble，.nan/.inf/负值原样进实体血量。 |
| slice-11 | L4 | data-consistency | MEDIUM | config/ConfigManager.java:644 | 注释声称缺键/非数值/负数三种形态都显式化，实现只判负数；intValue 的饱和溢出与小数截断静默通过。 |
| slice-11 | L5 | data-consistency | MEDIUM | config/ConfigManager.java:1577 | 载入过程中途用开头的整份 YAML 全量写盘做旧键迁移，不经过 saveToFile 的 mtime 外部修改检测，窗口内的手改会被覆盖。 |
| slice-11 | L6 | contract | MEDIUM | config/ConfigManager.java:2006 | loadMonstersConfig 返回 void 且失败只 return，loadFromFile 仍返回 true，调用方会把半份 reload 宣告成成功。 |
| slice-12 | L1 | logic | MEDIUM | config/DisplayConfigLoader.java:493 | Number.intValue() 静默截断小数，且超出 int 范围的值会回绕后被夹到下限（想调慢反而变最快） |
| slice-12 | L2 | contract | MEDIUM | config/DisplayConfigLoader.java:272 | blank: false 既不算声明行型也不参与多行型告警，整行会被当成「no line kind」丢弃 |
| slice-12 | L3 | logic | MEDIUM | config/DisplayConfigLoader.java:372 | 缺 containsKey 判定，when: 空值与缺键同走 always，fail-open 与拼错条件名 fail-closed 策略相反 |
| slice-12 | L4 | contract | MEDIUM | config/DisplayConfigLoader.java:216 | getString 会把 Integer/Boolean 转成字符串当 i18n 键，类型写错时零告警 |
| slice-12 | L5 | error-handling | LOW | config/DisplayConfigLoader.java:113 | 只缺一段时静默用出厂默认且不告警，段名拼错会让用户以为自己的配置已生效 |
| slice-12 | L6 | error-handling | MEDIUM | config/GameConfig.java:645 | defaultWave 无 null 守卫而 setDefaultWave 接受 null，脏检查调用 snapshot() 时可能 NPE |
| slice-13 | L1 | contract | MEDIUM | config/menu/MonsterSettingsMenu.java:82 | 这个 return 在 setBackButton/fillEmpty 之前，怪物键缺失时菜单会没有返回按钮，管理员只能按 ESC 退出。 |
| slice-13 | L2 | contract | MEDIUM | config/menu/ItemSettingsMenu.java:241 | 点击动作不读 ClickType，DROP/NUMBER_KEY/MIDDLE/DOUBLE_CLICK 都会写回配置，而同仓库 GameRulesMenu 已收窄为 LEFT 白名单。 |
| slice-13 | L3 | contract | MEDIUM | config/menu/MonsterSettingsMenu.java:211 | 布尔开关对任意 ClickType 都翻转，双击与丢出键都会改配置，且 lore 未声明哪些键有效。 |
| slice-13 | L4 | contract | MEDIUM | config/menu/AbstractConfigMenu.java:154 | 类里只有 click 与 close 两个处理器，没有 InventoryDragEvent，拖拽把物品拖进 GUI 上半区不会被取消。 |
| slice-13 | L5 | logic | MEDIUM | config/menu/GameRulesMenu.java:38 | min-players 与 max-players 各自独立 clamp，可以写出 minPlayers=20 而 maxPlayers=2 的组合，同文件 spawn-max-radius 却做了跨字段下界。 |
| slice-13 | L6 | error-handling | MEDIUM | config/menu/NumericInputHandler.java:214 | 每条非法聊天输入都重挂条目并重置 30 秒超时，玩家靠等待退不出输入态，公屏消息被持续吞掉。 |
| slice-14 | L1 | contract | MEDIUM | config/menu/WaveSettingsMenu.java:115 | 新增波次只判重复不判范围，num 可为 0、负数或 Integer.MAX_VALUE 并直接作为 waves 的键。 |
| slice-14 | L2 | contract | MEDIUM | config/menu/WaveSettingsMenu.java:249 | slot 从 27 起随 comp 条目无上界递增，超过 18 条会覆盖 46 号新增按钮，超过 27 条写入 >=54 的越界槽位。 |
| slice-14 | L3 | logic | MEDIUM | config/menu/WaveSettingsMenu.java:216 | wc == null 分支在 buildMenu 内关闭背包并 return，但 open() 随后仍无条件 openInventory，结果是一个 clickActions 已清空、点不动的空 54 格菜单。 |
| slice-14 | L4 | data-consistency | MEDIUM | config/menu/WaveSettingsMenu.java:118 | 新增波次直接写内存 map，而同一菜单的删除走 configManager.removeWave 记账，两条路径的落盘语义不对称。 |
| slice-14 | L5 | logic | LOW | config/menu/WaveSettingsMenu.java:257 | 权重仅 Math.max(1, v) 钳下界、未传 min/max，极大权重会进入后续加权抽样。 |
| slice-15 | L1 | data-consistency | HIGH | core/GameManager.java:652 | endGame() 不检查 state/settlementPhase 是否已结束，重复进入会再次执行结算回调。 |
| slice-15 | L2 | data-consistency | MEDIUM | core/GameManager.java:740 | haltGame() 后 isGameRunning() 仍为 true，此处未查 isSettlementPhase()，结算窗口内掉线仍会走 endGame(false)。 |
| slice-15 | L3 | contract | MEDIUM | core/GameManager.java:657 | stopGame() 只复位状态与取消任务，不调 onGameEndCallback 也不落库，与 endGame() 的收尾职责口径不一致。 |
| slice-15 | L4 | concurrency | MEDIUM | core/PlayerGoodsManager.java:422 | writeYaml 由 runTaskAsynchronously 调用，yaml.saveToString() 在异步线程序列化含 ItemStack 的 Bukkit 配置对象。 |
| slice-15 | L5 | data-consistency | MEDIUM | core/PlayerGoodsManager.java:432 | 写盘失败只记日志无重试，而此时内存快照已在 restore() 中移除、磁盘仍是旧内容。 |
| slice-15 | L6 | error-handling | MEDIUM | HilltopVillagePlugin.java:286 | 整批竞技场停止只包一层 try-catch，单场抛 RuntimeException 会跳过其余场次的停止，而随后的地图回滚仍执行。 |
| slice-16 | L1 | error-handling | MEDIUM | core/WaveManager.java:464 | world 来自未判空的 getGameWorld()（449），此处只 catch IllegalArgumentException，世界卸载/换图窗口下 NPE 会冒出 runTaskTimer 任务体。 |
| slice-16 | L2 | error-handling | MEDIUM | core/WaveManager.java:167 | 先置空句柄、再执行 onComplete、最后才 cancel()（167-169）：回调抛异常时 cancel 不执行，任务既无句柄可被 cancelSpawnTask 取消、又会每 3 tick 重复触发回调。 |
| slice-16 | L3 | error-handling | MEDIUM | core/WaveManager.java:1011 | 空投批次任务内 spawnEntity 无 try/catch（与三个特殊怪生成方法的 catch 不一致），且 mobType 来自配置，异常后 handle 仍留在 airdropTasks 中按 10 tick 反复抛。 |
| slice-16 | L4 | error-handling | LOW | core/WaveManager.java:574 | getAttribute 返回值直接解引用，同文件 applyMonsterEquipment 对 ATTACK_DAMAGE 做了判空（491-492），此处 622/682 行同样未判；entity-type 可被管理员配置成无该属性的类型。 |
| slice-16 | L5 | logic | MEDIUM | core/WaveManager.java:1130 | 所有候选玩家都被 continue 跳过时 best 仍停在 players.get(0)、bestDistSq 保持 MAX_VALUE，方法注释所称“保证返回非 null”掩盖了“返回了另一个世界的玩家”，随后 1079 行跨世界 teleport。 |
| slice-16 | L6 | concurrency | LOW | core/WaveManager.java:406 | 循环内 411 行直接 living.remove()，该模式依赖 world.getEntities() 返回独立快照；若返回实时集合，remove 触发的实体移除监听再改动世界实体即 ConcurrentModificationException（435-437 的静态清扫同样写法）。 |
| slice-17 | L1 | error-handling | MEDIUM | diagnostic/TpsDiagnostic.java:63 | gameManager 判空后仍直接链式调用 getWaveManager()，未判空即取剩余怪物数。 |
| slice-17 | L2 | error-handling | MEDIUM | diagnostic/TpsDiagnostic.java:65 | getNodeSystem() 未判空且同一行重复取两次，空指针风险与冗余调用并存。 |
| slice-17 | L3 | error-handling | HIGH | diagnostic/TpsDiagnostic.java:77 | 空 catch 吞掉 NoSuchMethodError，第 74 行初值 0 会被当作真实方块实体数输出。 |
| slice-17 | L4 | error-handling | MEDIUM | diagnostic/TpsDiagnostic.java:47 | 入口直接调用 Paper 专有 API 且无可用性保护，与第 76 行对同类 API 的兜底不一致。 |
| slice-17 | L5 | contract | LOW | diagnostic/TpsDiagnostic.java:53 | 对 getTPS() 返回值做裸下标访问，未见数组长度校验。 |
| slice-17 | L6 | logic | LOW | diagnostic/TpsDiagnostic.java:117 | 数值夹取只封上界，未处理 NaN 与负值，NaN 会落到 RED 分支并被格式化为 "NaN"。 |
| slice-17 | L7 | contract | LOW | diagnostic/TpsDiagnostic.java:26 | 以 null 作为竞技场选择器传入 resolveArena，语义依赖被调方对 null 的约定。 |
| slice-18 | L1 | concurrency | MEDIUM | doc/CommandsDocumentGenerator.java:523 | 串行化只覆盖同一 JVM（static 锁），数据目录被两个服务端进程共享时，非原子降级路径上的两次替换会互相删除对方的目标文件。 |
| slice-18 | L2 | error-handling | MEDIUM | doc/CommandsDocumentGenerator.java:568 | catch 只认 AtomicMoveNotSupportedException；provider 若以 UnsupportedOperationException 上报 ATOMIC_MOVE 不可用，则既不走降级也不被外层 IOException catch 接住，任务静默死亡。 |
| slice-18 | L3 | error-handling | LOW | doc/CommandsDocumentGenerator.java:530 | parent 为 null 时这里抛 NPE，而 NPE 不是 IOException，第 473 行的 catch 接不住，异步任务终止且无日志。 |
| slice-18 | L4 | contract | MEDIUM | doc/CommandsDocumentGenerator.java:467 | generate() 提交异步任务后立即返回 void，调用方与下游消费者都无从判断 commands.md 何时可读；启动即关闭时任务会被取消而不留错误信号。 |
| slice-18 | L5 | data-consistency | MEDIUM | doc/CommandsDocumentGenerator.java:576 | 降级路径在 Windows 上先删目标再改名，改名失败时旧文档已删、临时文件又被 finally 清理，净结果是两份都没有，只留一条 WARNING。 |
| slice-19 | L1 | logic | MEDIUM | gui/ArenaSelectionGUI.java:244 | canJoin 允许 STARTING，但图标 switch 无 STARTING 分支，落入 default 的 WOODEN_SWORD（类注释称其为不可用样式）。 |
| slice-19 | L2 | contract | MEDIUM | gui/ArenaSelectionGUI.java:329 | 先 closeInventory 再调用 joinArena，返回值未检查，join 失败时玩家得不到任何反馈。 |
| slice-19 | L3 | logic | MEDIUM | gui/ArenaSelectionGUI.java:85 | 注释称保留底行做导航，实际超过 45 个竞技场即静默丢弃且没有任何翻页或提示。 |
| slice-19 | L4 | error-handling | LOW | gui/ArenaSelectionGUI.java:158 | 地图缺失（世界未加载）是正常状态，但 getWorldName() 未判空就作为语言占位符参数。 |
| slice-19 | L5 | logic | LOW | gui/ArenaSelectionGUI.java:241 | maxPlayers 为 0 或负数时该比较恒真，所有玩家都被判满、GUI 永久不可加入。 |
| slice-19 | L6 | error-handling | LOW | gui/ArenaSelectionGUI.java:75 | 标题直接来自语言键且未判空，缺键返回 null 时 createInventory 会抛异常，调用方无兜底。 |
| slice-20 | L1 | concurrency | MEDIUM | mechanics/ArenaScoreboard.java:369 | ensureTaskRunning 未像 ensureReEnableProbeRunning 那样先判 plugin.isEnabled()，禁用窗口内 show() 会向已停服的调度器注册任务 |
| slice-20 | L2 | concurrency | LOW | mechanics/FireballListener.java:622 | 每次爆炸匿名新建重复任务且不保句柄，竞技场结束/世界卸载后无法取消，任务仍会跑满 10 次并持有 world/impact |
| slice-20 | L3 | error-handling | MEDIUM | mechanics/FireballListener.java:525 | UUID.fromString 失败被空 catch 静默吞掉，throwerUuid 留 null，伤害退回无来源且击杀统计丢失，无日志 |
| slice-20 | L4 | data-consistency | MEDIUM | mechanics/FireballListener.java:304 | dispenser 取自 event.getBlock().getState() 的方块状态快照，对其库存扣料与 setItem 可能不回写真实发射器，而原版消耗已被 setCancelled(true) 阻止 |
| slice-20 | L5 | security | MEDIUM | mechanics/ArenaAccessListener.java:80 | 世界准入只挂 PlayerTeleportEvent 且不区分 TeleportCause，载具实体传送与竞技场内重生复活不经过该事件，非成员仍可进入竞技场世界 |
| slice-20 | L6 | logic | MEDIUM | mechanics/FriendlyFireListener.java:62 | resolveDamager 只识别玩家与弹射物，TNT/苦力怕/驯服狼等来源返回 null 后直接放行，与类注释宣称的零友伤不一致 |
| slice-21 | L1 | concurrency | MEDIUM | mechanics/MapRestoreManager.java:564 | 重复任务只注册裸 lambda，restoreBatch/complete 抛出未捕获异常时 Bukkit 会取消任务，而 activeRestores 的唯一移除点在 complete() 内，该世界将永久处于 isRestoring 状态。 |
| slice-21 | L2 | data-consistency | MEDIUM | mechanics/MapRestoreManager.java:610 | 回滚条目取自 journal.entrySet() 的哈希序（第 549 行）而非自下而上，且关闭物理，悬空沙砾与被截断的流体会以无支撑状态写回并缺少后续物理更新。 |
| slice-21 | L3 | error-handling | MEDIUM | mechanics/MapRestoreManager.java:611 | TileState 更新失败被当作整块失败并整批重新入队，没有重试上限或隔离，success 恒为 false，调用方的 ENDING 屏障永远不解除。 |
| slice-21 | L4 | logic | MEDIUM | mechanics/HammerListener.java:344 | 蓄力期间落地伤害被无条件取消，而 executeSmash 在换手时静默放弃且不写冷却，免伤副作用已在伤害事件中生效，形成可重复的无成本免摔落窗口。 |
| slice-21 | L5 | contract | MEDIUM | mechanics/LobbyProtectionListener.java:241 | 只拦盔甲架与展示框，村民商人右键仍可打开交易界面，与类注释「容器交互全部被阻止」及对 Villager 的伤害保护口径不一致。 |
| slice-21 | L6 | data-consistency | LOW | mechanics/NodeListener.java:169 | 只从 blockList 剔除节点方块且不取消事件，床/重生锚自身爆炸时源方块不在 blockList 内，节点方块仍会被移除，与「节点只能被怪物打空血」的注释相悖。 |
| slice-22 | L1 | data-consistency | MEDIUM | mechanics/NodeSystem.java:180 | 载入时按当前方块材质跳过节点，随后内存清理会把该节点移出 nodes，而保存逻辑只回写内存里的节点，等于用一次读失败静默删掉 nodes.yml 中的持久条目。 |
| slice-22 | L2 | concurrency | LOW | mechanics/NodeSystem.java:698 | 并发容器里的 NodeData 用普通 double/boolean 存血量与存活态，damageNode 先跨两个集合做 isRegisteredActive 判定再改状态，是典型的 check-then-act 窗口。 |
| slice-22 | L3 | error-handling | MEDIUM | mechanics/NodeSystem.java:831 | 增益等级由配置值与节点数相加得出且无 0-255 夹取，越界时 PotionEffect 抛 IllegalArgumentException，而这段代码位于无 try/catch 的周期任务体内。 |
| slice-22 | L4 | error-handling | MEDIUM | mechanics/TabListManager.java:739 | viewOf 对 getGameManager() 判了 null，同一文件的 resolveArg 却直接链式调用，实例存在而 GameManager 未装配时会让整帧刷新抛异常并跳过所有玩家。 |
| slice-22 | L5 | data-consistency | LOW | mechanics/PlayerLifecycleListener.java:95 | 清掉落与 keepInventory 在 playerData 判空之外无条件执行，不属于本局 playerDataMap 的玩家在竞技场世界死亡也会被清空掉落并广播阵亡。 |
| slice-22 | L6 | data-consistency | LOW | mechanics/VillagerPreviewManager.java:122 | 清理只把失效引用从内存列表剔除而不移除实体本体，persistent 且不远离消失的预览村民会留在存档里，仅靠 EntitiesLoadEvent 与开服一次的 cleanupOrphans 兜底。 |
| slice-23 | L1 | logic | MEDIUM | mechanics/VillagerSystem.java:192 | 存活数按 isValid() 过滤，但全灭失败只在死亡事件里评估，村民被非死亡途径移除时计数归零也不触发失败 |
| slice-23 | L2 | data-consistency | MEDIUM | mechanics/VillagerSystem.java:235 | 用实体对象身份判定是否本局村民，区块卸载重载后事件里的新实例不在列表中，会跳过伤害拦截与死亡结算 |
| slice-23 | L3 | data-consistency | MEDIUM | mechanics/VillagerSystem.java:178 | 同一身份判定在 cleanupOrphans 中反向使用，重载后在世村民被判成孤儿删除，而 deployedTotal 不同步减少 |
| slice-23 | L4 | security | MEDIUM | mechanics/VillagerSystem.java:276 | 白名单只认 instanceof Monster，玩家用刷怪蛋或指令生成的怪物同样被当作合法伤害源，可击杀受保护村民触发全灭失败 |
| slice-23 | L5 | error-handling | MEDIUM | mechanics/VillagerSystem.java:144 | 配置血量未做有限性校验，Math.max(1.0, NaN) 仍为 NaN，setHealth 抛异常会让 spawnAll 循环中途退出且 deployedTotal 未回填 |
| slice-23 | L6 | contract | MEDIUM | mechanics/VillagerSystem.java:285 | 处理方法声明在 EventPriority.MONITOR 却在此改写事件（清掉落、清经验），MONITOR 约定为只读观察点 |
| slice-23 | L7 | logic | MEDIUM | mechanics/VillagerSystem.java:117 | 未部署村民时只 warning 后 return，竞技场照常开局而失败条件永久不可达，调用方没有失败信号 |
| slice-24 | L1 | data-consistency | MEDIUM | shop/ShopListener.java:198 | 购买先扣款后发货，退款动作自身失败时只写日志，不回滚、不重试、不通知玩家，钱货两空只能靠服主手工补偿。 |
| slice-24 | L2 | data-consistency | MEDIUM | shop/ShopManager.java:271 | 主背包部分扣减只改 getStorageContents() 数组元素、未 setItem 写回，副手分支却显式写回，两条路径口径不对称。 |
| slice-24 | L3 | security | MEDIUM | shop/ShopConfigLoader.java:346 | 价格没有任何上界校验，getInt 会把超 int 的 YAML 数字截断成负数，再被下方钳成 0，商品变成免费。 |
| slice-24 | L4 | error-handling | MEDIUM | shop/ShopConfigLoader.java:305 | 只检测 price 缺键；写成非数字字符串时 getInt 静默回落默认 1，既不 warning 也不进 loadWarnings。 |
| slice-24 | L5 | data-consistency | MEDIUM | shop/NpcManager.java:86 | 生成新 NPC 前先无条件删除旧实体，随后 spawnEntity 失败或抛异常时没有回滚，旧 NPC 已消失。 |
| slice-24 | L6 | data-consistency | MEDIUM | shop/NpcManager.java:102 | NPC 头顶名只在 spawnNpc 时解析一次，ShopManager.reload 换配置后不重建/改名，配置与在线实体不一致。 |
| slice-25 | L1 | data-consistency | MEDIUM | stats/StatsManager.java:378 | 解析失败分支只把隔离结果用于日志措辞，隔离失败时既不置 readOnly 也不阻止后续写盘，下一轮 flushAsync 会用空缓存快照覆盖那份刚被声称「已保留」的损坏文件。 |
| slice-25 | L2 | data-consistency | MEDIUM | stats/StatsManager.java:281 | kills/deaths/nodes/crystals 直接累加调用方给的 int，没有像下方 wave 那样用 Math.max(0, …) 夹取，负值或超大值会原样落盘，并被 top() 的 <=0 过滤条件从榜单里静默排除。 |
| slice-25 | L3 | error-handling | MEDIUM | stats/StatsManager.java:597 | 只把 AtomicMoveNotSupportedException 当作可降级信号，ATOMIC_MOVE 抛出的其它 IOException（目标被占用、FileAlreadyExistsException 等）落到外层通用 catch，只置脏后按同样参数永远重试，没有任何降级或停写判定。 |
| slice-25 | L4 | concurrency | LOW | stats/StatsManager.java:578 | 该赋值位于 writeAtomically 的 readOnly 分支，运行在异步写线程；生产者在主线程 record() 里置 dirty=true，两个线程对同一个 volatile 标志做非原子的清/置，可能吞掉一次尚未落盘的变更标记。 |
| slice-25 | L5 | contract | LOW | stats/StatsManager.java:215 | subList 只对 limit 做了上界收敛，没有下界校验：limit 为负时 toIndex 为负，抛 IllegalArgumentException 而不是返回空列表；当前唯一调用方硬编码 10，属未被触发的边界。 |
| slice-25 | L6 | data-consistency | MEDIUM | stats/StatsManager.java:407 | getInt 对超出 int 范围或非数字的值静默返回默认值 0，按记录包裹的 try/catch 不会触发，随后 buildSnapshot 会把 0 写回整份快照，原值被无声抹平且无任何日志。 |
| slice-26 | L1 | data-consistency | HIGH | util/YamlFiles.java:124 | ATOMIC_MOVE 失败后的降级分支是非原子的「先删后改名」，且 finally 会删掉 tmp，崩溃窗口内原文件与临时副本可能同时消失。 |
| slice-26 | L2 | data-consistency | HIGH | util/LanguageManager.java:93 | 只判 gate 的实例级 readOnly，未查磁盘上的 .corrupt；gate.reset() 后 load() 返回 ABSENT 即可写，已隔离文件会被一份新默认内容覆盖。 |
| slice-26 | L3 | data-consistency | MEDIUM | util/LanguageManager.java:307 | Bukkit saveConfig 走截断式写，与同包 YamlFiles 的「临时文件 + ATOMIC_MOVE」策略相反，写入窗口内崩溃会留下半截 config.yml。 |
| slice-26 | L4 | concurrency | MEDIUM | util/YamlFileGate.java:89 | writable() 检查与随后的 write 之间无锁，readOnly 仅 volatile；异步写线程可在另一线程上闩之后继续写，两个写者也只会互相覆盖快照。 |
| slice-26 | L5 | error-handling | MEDIUM | util/DisplayEntityManager.java:15 | getWorld() 可为 null 且 location 未判空，随后直接 world.spawnParticle，缺世界坐标会让 NPE 冒到主线程实体回调。 |
| slice-26 | L6 | data-consistency | LOW | util/MessageTextSync.java:376 | 键冲突时基线哈希写失败被静默 return false，调用方不检查，该键此后只能走 legacy/保守分支并可能被永久标成自定义。 |

## 发现（finding）

| id | status | severity | dim | 位置 | 摘要 | 产物 |
|---|---|---|---|---|---|---|
| F-slice-01-data-consistency-01 | CONFIRMED | MEDIUM | data-consistency | admin/AdminDeployManager.java:557 | 一次 saveSpawnPoints() 被拆成两次独立的整份写盘：539 行先 gate.write(arenasConfig)，557 行再调用 saveShopNpcLocation()（590 行重新 load、610 行再整份写一次）。第二次写盘失败、或进程在两次写之间退出时，磁盘停在「生 | round1-02-audit-slice-01-data-consistency.md |
| F-slice-01-data-consistency-02 | CONFIRMED | MEDIUM | data-consistency | admin/ArenaResetService.java:312 | 重置序列第 7 步先删除世界里的商店 NPC 实体，第 8 步 clearDeploymentData 失败时 abort() 只回滚 nodes.yml 并重新启用竞技场，不恢复实体；arenas.yml 里 shop-npc 未被删（第 8 步没写成功），于是磁盘声明「本竞技场有商店 NPC」而 | round1-02-audit-slice-01-data-consistency.md |
| F-05-DC-01 | CONFIRMED | MEDIUM | data-consistency | arena/ArenaInstance.java:471 | 当玩家在 STARTING/RUNNING/WAVE_INTERMISSION 离场且内存中不存在物品快照时（goods == null，或 PlayerGoodsManager.restore() 返回 false），removePlayer 在第 471 行无条件清空玩家背包；此刻快照已不存在， | round1-02-audit-slice-05-data-consistency.md |
| F-slice08-eh-01 | CONFIRMED | MEDIUM | error-handling | command/HilltopCommandHandler.java:1103 | 当 arenas.yml 或 nodes.yml 不可用（被隔离成 *.corrupt、闸门只读、竞技场世界未加载）时，/hilltop deploy reloadnodes 仍然无条件播报 deploy.reloadnodes-done 并打印旧的节点数：管理员收到成功回执，而两个加载器都已早退、 | round1-02-audit-slice-08-error-handling.md |
| F-slice08-eh-00 | NO_EVIDENCE_FOUND | null | error-handling | :null | 上游指定的两条 error-handling 线索（L1 stats NPE、L5 ArenaCommand 无参静默）经复核均不成立，本切片在异常路径上未发现其它可确认缺陷。 | round1-02-audit-slice-08-error-handling.md |
| F-slice-11-data-consistency-01 | CONFIRMED | HIGH | data-consistency | config/ConfigManager.java:1425 | 当 game-settings.yml 不可用、不存在或闸门只读时，loadFromFile() 在未写入任何文件的情况下把 lastSavedSnapshot 推进为当前内存快照并 return false；hasUnsavedChanges() 随即变为 false，主菜单把保存按钮换成「已是最 | round1-02-audit-slice-11-data-consistency.md |
| F-slice-11-data-consistency-02 | CONFIRMED | MEDIUM | data-consistency | config/ConfigManager.java:1442 | contains() 判的是 get(path) 非 null，getString() 判的是值 instanceof String，两者之间的缝隙让数字/布尔/段形态的值把 null 写进 worldName；保存时 :851 以 null 调用 set() 等价于删键，磁盘上那一行静默消失，下一 | round1-02-audit-slice-11-data-consistency.md |
| F-slice-11-data-consistency-03 | CONFIRMED | MEDIUM | data-consistency | config/ConfigManager.java:1469 | villager-health 从磁盘读入后不做任何归一化，.nan / .inf / 负值原样进入 GameConfig，并在下一次保存时被写回磁盘；同文件的同类风险键（explode-damage-multiplier、victory-waves、repair-cost-amount）都有专门  | round1-02-audit-slice-11-data-consistency.md |
| F-slice-11-data-consistency-04 | CONFIRMED | MEDIUM | data-consistency | config/ConfigManager.java:644 | readWaveInt 只挡「非 Number」和负数，中间直接把 Number 压成 int：1e18 饱和成 Integer.MAX_VALUE、1.9 截断为 1、.nan 变成 0，三种失真都不写入 problems，所以加载结束时的 numericProblems 汇总 warning 不 | round1-02-audit-slice-11-data-consistency.md |
| F-slice-11-data-consistency-05 | CONFIRMED | LOW | data-consistency | config/ConfigManager.java:1577 | 载入过程中的旧键迁移（:1577 nodes.repair-item、:1695 shop.currency-drop-amount）直接全量写盘，写前不比对新旧 mtime，也不经过 mergeExternalChanges；若在读盘（:1414）与写盘之间文件被外部修改，改动会被整份旧内容覆盖， | round1-02-audit-slice-11-data-consistency.md |
| F-slice-13-contract-01 | CONFIRMED | MEDIUM | contract | config/menu/AbstractConfigMenu.java:154 | AbstractConfigMenu 只注册了 InventoryClickEvent 与 InventoryCloseEvent 两个处理器，没有 InventoryDragEvent 处理器；因此在本菜单为 top inventory 时，玩家可以把受管 GUI 内的物品拖进自己的背包，预期是  | round1-02-audit-slice-13-contract.md |
| F-slice-13-contract-02 | CONFIRMED | MEDIUM | contract | config/menu/ItemSettingsMenu.java:239 | ItemSettingsMenu 的材质循环槽位（addMaterialCycle）与 MonsterSettingsMenu 的布尔开关都不读 ClickType：任何 ClickType（DROP、MIDDLE、DOUBLE_CLICK、NUMBER_KEY 等）都会直接写配置，而预期的契约是只 | round1-02-audit-slice-13-contract.md |
| F-slice-15-concurrency-01 | CONFIRMED | HIGH | concurrency | core/PlayerGoodsManager.java:478 | flushToDisk() 把整个 writeYaml 丢到异步线程，而 writeYaml 在 422 行执行 yaml.saveToString()，于是含 ItemStack 的 Bukkit 配置对象在异步线程被序列化——这直接违反本类 336-341 行自己声明的「序列化留在主线程、只有纯 | round1-02-audit-slice-15-concurrency.md |
| F-slice-15-concurrency-02 | CONFIRMED | MEDIUM | concurrency | HilltopVillagePlugin.java:563 | PlayerQuitEvent（主线程）每次玩家退出都调用 saveNow() → writeYaml() 同步取 writeLock，而异步写线程在 419-423 行持有同一把锁执行整份 YAML 的 saveToString()、并在 429 行锁内做 Files.move；因此主线程在退出事 | round1-02-audit-slice-15-concurrency.md |
| F-slice-15-concurrency-03 | CONFIRMED | LOW | concurrency | core/GameManager.java:478 | 波次超时保险用不可单调的挂钟计算已持续时间：330 行记起点、478 行求差、479/487 行据此决定传送高亮或强清残怪；系统时钟回拨会让 elapsedSeconds 变小甚至为负，本应打破软锁的保险被推迟或永不触发，时钟前跳则会提前清掉仍在场的残怪。 | round1-02-audit-slice-15-concurrency.md |
| F-slice-20-concurrency-01 | CONFIRMED | LOW | concurrency | mechanics/ArenaScoreboard.java:369 | ensureTaskRunning() 在向调度器注册刷新任务前没有判 plugin.isEnabled()，而同类的 ensureReEnableProbeRunning()（:391-392）显式挡住禁用阶段；一旦 show() 落在插件禁用窗口内，runTaskTimer 会抛 Illegal | round1-02-audit-slice-20-concurrency.md |
| F-slice-20-concurrency-02 | CONFIRMED | LOW | concurrency | mechanics/FireballListener.java:612 | triggerExplosion 每次爆炸都新建一条匿名 BukkitRunnable 并以 runTaskTimer(plugin, 0L, 2L) 调度，返回的 BukkitTask 没有赋给任何字段；同类两条全局 ticker 都有字段句柄（:74 cooldownTicker、:78 tra | round1-02-audit-slice-20-concurrency.md |
| F-slice-20-concurrency-03 | NO_EVIDENCE_FOUND | null | concurrency | :null | 在本切片 5 个文件中没有发现「异步线程触碰 Bukkit 世界/记分板 API」或「异步线程与主线程共享普通 HashMap/ArrayList」这一类并发缺陷。 | round1-02-audit-slice-20-concurrency.md |
| F-slice-21-concurrency-01 | CONFIRMED | MEDIUM | concurrency | mechanics/MapRestoreManager.java:551 | 回滚操作在任务注册之前就被发布到 activeRestores 并同步跑完首批；若这一批抛出逃出 catch (RuntimeException) 的 Throwable，该操作既没有 BukkitTask、也没有任何路径会再调用 complete()，activeRestores 中的条目永久残留 | round1-02-audit-slice-21-concurrency.md |
| F-slice-21-concurrency-02-L1-refuted | NO_EVIDENCE_FOUND | null | concurrency | mechanics/MapRestoreManager.java:576 | L1 原样判定 REFUTED：其「Bukkit 在任务抛异常时会取消该 repeating task，导致 activeRestores 永不移除」的机制前提在 paper-1.21.4-232 上不成立；任务被重新入队后会继续推进 nextIndex 并最终走到 complete()。该线索的残 | round1-02-audit-slice-21-concurrency.md |
| F-slice-24-dc-01 | CONFIRMED | MEDIUM | data-consistency | shop/ShopListener.java:197 | 购买链先扣款（purchase:126）再发货；发货失败进入 refundCurrency 后，若补偿动作自身抛异常，catch 只写一行 SEVERE 日志就返回——货币已扣、商品未生成、玩家无提示，且没有任何持久化的待补偿记录或重试，一致性只能靠服主读日志人肉收敛。 | round1-02-audit-slice-24-data-consistency.md |
| F-slice-24-dc-02 | CONFIRMED | MEDIUM | data-consistency | shop/NpcManager.java:86 | NPC 换生是「先删旧、再建新」且第二步无保护：despawnNpc() 已把旧实体 remove 并把字段置 null，spawnEntity 或其后的 setProfession/setCustomName 一旦抛异常，方法直接穿出，npc 字段停留在 null——世界里再没有带 shop-np | round1-02-audit-slice-24-data-consistency.md |
| F-slice-24-dc-03 | CONFIRMED | LOW | data-consistency | shop/ShopManager.java:99 | reload 的成功路径只替换内存 config 并关闭残留 GUI，不重建也不改名在线 NPC；因此改 shop.npc.name 后 reload 返回 true、日志显示已加载，但实体头顶名仍是旧值，配置（源）与实体（派生状态）分叉，直到重启或重新 set 坐标。 | round1-02-audit-slice-24-data-consistency.md |
| F-slice-24-dc-04 | EVIDENCE_GAP | null | data-consistency | shop/ShopManager.java:271 | 主背包部分扣减只修改 getStorageContents() 返回数组里的 ItemStack 数量，没有 setItem 写回；副手分支却显式 setItemInOffHand 并注释「不依赖引用共享」。若该 API 返回的是副本，则部分扣减不落盘而余额校验已通过，玩家少付钱仍拿到货；若返回的是 | round1-02-audit-slice-24-data-consistency.md |
| F-slice-26-data-consistency-01 | CONFIRMED | HIGH | data-consistency | util/YamlFiles.java:123 | 当 ATOMIC_MOVE 抛 AtomicMoveNotSupportedException 时，write() 降级为不带 ATOMIC_MOVE 的 REPLACE_EXISTING 移动；该移动失败（已进入替换、尚未完成）时 finally 会删除 tmp，磁盘上既没有可用的目标文件、也没有 | round1-02-audit-slice-26-data-consistency.md |
| F-slice-26-data-consistency-02 | CONFIRMED | HIGH | data-consistency | util/LanguageManager.java:90 | messages.yml 被隔离成 .corrupt 后，管理员执行一次 /hilltop reloadconfig 就会让 reload() 把该文件当成首次运行：load() 返回 ABSENT 且 usable()==true，readOnly 已被 reset 清成 false，于是 dis | round1-02-audit-slice-26-data-consistency.md |
| F-slice-26-data-consistency-03 | CONFIRMED | MEDIUM | data-consistency | util/LanguageManager.java:305 | setLocale() 用 Bukkit 的 plugin.saveConfig() 落盘 config.yml，该方法先截断目标再写；写入窗口内发生 IOException（磁盘满、进程被杀）会留下 0 字节或半截 config.yml，且该文件不在任何 YamlFileGate 的保护范围内。 | round1-02-audit-slice-26-data-consistency.md |
