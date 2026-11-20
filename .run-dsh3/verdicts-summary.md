# 锐评裁决汇总（机械抽取）

- round1-03-critique-arbiter.md · arbiter · verdicts=22 · gaps=0
- round1-03-critique-devils-advocate.md · devils_advocate · verdicts=0 · gaps=11
- round1-03-critique-skeptic-a.md · skeptic · verdicts=6 · gaps=0
- round1-03-critique-skeptic-b1.md · skeptic · verdicts=5 · gaps=0
- round1-03-critique-skeptic-b2.md · skeptic · verdicts=6 · gaps=0
- round1-03-critique-skeptic-c.md · skeptic · verdicts=5 · gaps=0

## verdicts

| source | role | finding_id | verdict | reason(节选) |
|---|---|---|---|---|
| arbiter | arbiter | F-slice-15-concurrency-01 | UPHELD | Skeptic 判 holds：异步线程内 saveToString 构造 ItemStack 的调用链成立，跨线程触碰 Bukkit 非线程安全对象可导致物品数据错乱或异常。Devil's Advocate 的 pattern_sweep 显示其余 3/4 异步入口已正确切回主线程，属遗漏而非架构性误判，HIGH 与后果相称。 |
| arbiter | arbiter | F-slice-15-concurrency-02 | UPHELD | Skeptic 判 holds：主线程 saveNow 与异步写共用同一把锁，争用成立。但上界已被限定为「一次序列化 + 一次 rename」的阻塞窗口，属于有限卡顿而非数据损坏，MEDIUM 未被高估。 |
| arbiter | arbiter | F-slice-15-concurrency-03 | UPHELD | Skeptic 判 holds：挂钟计时在系统时间跳变时会误判超时。但仅在 timeout>0 时生效，而该配置默认关闭，触发条件与 LOW 一致，不构成明显高估。 |
| arbiter | arbiter | F-slice-20-concurrency-01 | DOWNGRADED | Skeptic 判 untested：守卫缺失是可核事实，但「禁用窗口内 show() 仍可达」缺调用链与运行时证据，按判定树 untested 不得 UPHELD。升级所需证据：禁用期内调用 show() 的具体入口（监听器/命令/调度任务）及其前置 return 不存在的那一行，或一次最小复现。severity 维持 LOW。 |
| arbiter | arbiter | F-slice-20-concurrency-02 | UPHELD | Skeptic 判 holds：匿名重复任务未持有句柄，无法主动取消，只能靠 t>=10 自停。影响限于单次重复调度的多余执行，LOW 相称。 |
| arbiter | arbiter | F-slice-21-concurrency-01 | DOWNGRADED | Skeptic 判 holds 但已把「永久残留」收窄为「本次会话内残留」，且禁用路径存在兜底清理。后果从跨重启持久污染降为会话内短暂残留，影响面明显变窄，MEDIUM 过高，降为 LOW。 |
| arbiter | arbiter | F-05-DC-01 | UPHELD | Skeptic 判 holds：无快照离场时清空背包且只打 warning、无任何恢复路径，玩家物品不可逆丢失的链路完整，MEDIUM 相称。 |
| arbiter | arbiter | F-slice08-eh-01 | UPHELD | Skeptic 判 holds：reloadnodes 执行失败仍向管理员播报成功，形成误导性回执，管理员会据此认为配置已生效。链路成立，MEDIUM 相称。 |
| arbiter | arbiter | F-slice-24-dc-01 | UPHELD | Skeptic 判 holds：退款失败仅写日志，无重试、无回滚、无玩家可见提示，资金侧不一致且不可自愈，MEDIUM 相称。 |
| arbiter | arbiter | F-slice-24-dc-02 | UPHELD | Skeptic 判 holds：NPC 先删后建，建失败时没有回滚，异常路径会留下「已删未建」的持久状态，MEDIUM 相称。 |
| arbiter | arbiter | F-slice-24-dc-03 | UPHELD | Skeptic 判 holds：reload 不重建 NPC，但影响仅限显示层，重启后自愈，LOW 恰当。 |
| arbiter | arbiter | F-slice-11-data-consistency-01 | UPHELD | Skeptic 判 holds：读盘失败仍推进 lastSavedSnapshot，使保存按钮消失、后续改动无法落盘，属静默数据丢失，HIGH 与后果相称。 |
| arbiter | arbiter | F-slice-11-data-consistency-02 | DOWNGRADED | Skeptic 判 untested：关键前提「非字符串节点经 getString 返回 null」无法从现有证据验证，缺最小复现或该 API 行为的直接证据。升级所需证据：证明该键在何种写盘路径下会变成非字符串节点，并给出 getString 对非字符串的实际返回（null 还是 toString 结果）。severity 暂保留 MEDIUM。 |
| arbiter | arbiter | F-slice-11-data-consistency-03 | UPHELD | Skeptic 判 holds：villager-health 缺少有限性闸门，NaN/Infinity/负值可直接进入运行期数值计算，MEDIUM 相称。 |
| arbiter | arbiter | F-slice-11-data-consistency-04 | UPHELD | Skeptic 判 holds：intValue 对越界值饱和/截断、对 NaN 归零，全程无日志无提示，配置被静默改写，MEDIUM 相称。 |
| arbiter | arbiter | F-slice-11-data-consistency-05 | UPHELD | Skeptic 判 holds：旧键迁移绕过 mtime 比较，可能用旧值覆盖新值；但只影响首次迁移窗口，LOW 相称。 |
| arbiter | arbiter | F-slice-11-data-consistency-06 | UPHELD | Skeptic 判 holds：monsters 节点 ABSENT 被当作权威空配置处理，会以「无怪物」覆盖既有配置，链路成立，MEDIUM 相称。 |
| arbiter | arbiter | F-slice-26-data-consistency-01 | DOWNGRADED | Skeptic 判 holds 但标注 path_reachable=untested：「先删目标再改名」目前只有代码注释作证，成立还依赖目标文件系统不支持 ATOMIC_MOVE 这一未验证前提。升级所需证据：一次令 ATOMIC_MOVE 抛 AtomicMoveNotSupportedException 的失败注入，或运行期该分支的命中记录。按判定树降级，但 severity 保留 HIGH——前提若成立即全量配置丢失，缺少反证时 |
| arbiter | arbiter | F-slice-26-data-consistency-02 | UPHELD | Skeptic 判 holds：损坏文件被隔离后，下次启动以出厂值重建并回写，隔离文件被默认配置覆盖，全链可核，HIGH 与「原始数据不可恢复」的后果相称。 |
| arbiter | arbiter | F-slice-26-data-consistency-03 | UPHELD | Skeptic 判 holds：saveConfig 采用截断式写且 config.yml 不在原子写 gate 内，崩溃窗口会造成配置半写或清空，MEDIUM 相称。 |
| arbiter | arbiter | F-slice-13-contract-01 | DOWNGRADED | Skeptic 判 holds 但后果子主张被证伪：缺 drag 处理器为真，然而「拖进背包」已被 :161 取消，不存在「拖出即被盗」。真实风险是拖入 GUI 后被 buildMenu 重新渲染覆盖、导致物品丢失，需要「拖入 + 同 tick 内重开/刷新」的特定序列，危害方向从可被第三方利用的失窃变为自身操作失误，降为 LOW。 |
| arbiter | arbiter | F-slice-13-contract-02 | UPHELD | Skeptic 判 holds：处理器不读 ClickType，Shift/数字键点击会落入普通点击分支；同族 GameRulesMenu 的收窄只缩小影响面，不否定该机制，MEDIUM 维持。 |
| skeptic-a | skeptic | F-slice-15-concurrency-01 | holds | 逐字核对 478 行确为 runTaskAsynchronously 派发 writeYaml，而 writeYaml 在 422 行执行 yaml.saveToString()；354/521 行把 ItemStack 引用直接 set 进 YamlConfiguration，339-341 行 javadoc 自述「序列化…留在主线程」。线程归属是静态可判定的，writeLock 只提供互斥、不改变执行线程，故该类自己声明的约束被实 |
| skeptic-a | skeptic | F-slice-15-concurrency-02 | holds | 498-503 saveNow → writeYaml → 419 synchronized(writeLock)；异步侧 419-423 在同一 monitor 内执行 saveToString，425-429 再取同一锁做 Files.move。PlayerQuitEvent(548) 在主线程，563 行每名玩家退出调用一次，因此该主线程必须等异步侧的临界区。作者在 389-393 行明文接受这段等待，但并未消除它。 |
| skeptic-a | skeptic | F-slice-15-concurrency-03 | holds | 330/478 两处都用 System.currentTimeMillis()，479/487 据此分支；挂钟可被 NTP 步进或手动校时改写，回拨会使 elapsedSeconds 变小甚至为负，从而推迟 479 行的保险分支。476 行 timeoutSeconds<=0 直接 return，说明仅在显式启用 wave-timeout-seconds 时执行。 |
| skeptic-a | skeptic | F-slice-20-concurrency-01 | untested | 缺 isEnabled 守卫属实（369 行；对照 392 行同族方法有守卫），但「禁用窗口内 show() 会注册到已停服调度器」需要一条禁用期间可达的调用方：本回合核实 show() 仅由 ArenaInstance:343（addPlayer）与 :575（rejoin）调用，二者都以在线玩家加入/重连为前提，禁用窗口内是否会发生未获证据。机制在给定调用时成立，可达性未证明。 |
| skeptic-a | skeptic | F-slice-20-concurrency-02 | holds | 612-622 的匿名 BukkitRunnable 直接链式 runTaskTimer，返回值未赋给任何字段；455-472 的 shutdown() 只 cancel cooldownTicker(457) 与 trailTicker(461)，全类无第二个句柄。任务体只在 t++>=10 时自停，且不校验竞技场是否仍在运行，故竞技场结束/重置后仍会执行其剩余回调。 |
| skeptic-a | skeptic | F-slice-21-concurrency-01 | holds | 551 put 之后 554 行同步跑首批，563 行才注册任务；612 行只捕 RuntimeException，Error/LinkageError 会穿透 restoreBatch 抛给调用方，此时既无 task 也无 complete()，682 行的唯一常规移除点不会到达，515-519 的合并分支只挂回调不查存活。限定：插件禁用时 518/631 会经 finishSynchronously 兜底清理，因此残留限于本次会话而 |
| skeptic-b1 | skeptic | F-05-DC-01 | holds | ArenaInstance.java:464 的 goods==null \|\| !goods.restore(player) 分支内，471 行执行 player.getInventory().clear()；门控 shouldClearInventoryOnMissingSnapshot（412-416）对 STARTING/RUNNING/WAVE_INTERMISSION 返回 true，即真实对局态无快照时必清。清空后只有  |
| skeptic-b1 | skeptic | F-slice08-eh-01 | holds | HilltopCommandHandler.java:1102-1106 在调用两个 void 方法后无条件 sendMessage(deploy.reloadnodes-done, getTotalCount())。NodeSystem#loadNodesFromConfig（127 起）在 nodes.yml 不可用（145-151）或被隔离（133-137）时只 logger.severe 后 return，保留旧节点，故 get |
| skeptic-b1 | skeptic | F-slice-24-dc-01 | holds | ShopListener.java:197-201 的 catch (RuntimeException) 内只有 getLogger().severe，无 player.sendMessage、无重试、无回滚、未向调用方回传失败。方法注释 188-190 明说此时货币已扣、货未生成、玩家无任何反馈。触发链：purchase 扣款 -> deliverItem 失败 -> refundCurrency 补偿再抛 -> 玩家钱货两空，只剩日 |
| skeptic-b1 | skeptic | F-slice-24-dc-02 | holds | NpcManager.java:86 先 despawnNpc()，92 才 spawnEntity；despawnNpc（152-157）已 remove 旧实体并把 npc 置 null。若 spawnEntity 因 EntitySpawnEvent 被取消返回 null（或抛异常），93 行 villager.setAI 立即 NPE，this.npc 保持 null，旧 NPC 已消失且无任何 try/catch 或回滚，商店 |
| skeptic-b1 | skeptic | F-slice-24-dc-03 | holds | ShopManager#reload（82-106）只替换 config、关闭 ShopGUI、打日志，全程未调用 NpcManager 的 spawn/despawn。NpcManager#resolveNpcName（338-343）第一优先级读取 getShopConfig().getNpcName()，所以修改 shop.npc.name 后执行 /hilltop shop reload，活 NPC 不会重建，头顶仍是旧名，直到 |
| skeptic-b2 | skeptic | F-slice-11-data-consistency-01 | holds | 1425 在 1419 的三合一失败条件后无条件执行且不写盘，1426 立即 return false；hasUnsavedChanges() 在 343-344 只比较 activeConfig.snapshot() 与 lastSavedSnapshot，推进后两者必然相等，MainConfigMenu:96 随即渲染 GREEN_WOOL 并撤掉保存入口，机制与调用链均成立。 |
| skeptic-b2 | skeptic | F-slice-11-data-consistency-02 | untested | 1442 的 contains/getString 组合本身属实，但「非字符串标量会让 getString 返回 null」这一决定性前提未被证实：仓库内唯一的机制测试 YamlNullMechanismTest:11 只测带引号的字符串 null，且 46-50 用 %s 打印，无法区分 String null 与真正的 null；Paper/Spigot 的 MemorySection 实现不在仓库内，本机无服务端、禁止构建、外网被 |
| skeptic-b2 | skeptic | F-slice-11-data-consistency-03 | holds | 1469 直接 getDouble 后 setVillagerHealth，GameConfig:692 的 setter 是纯赋值 this.villagerHealth = v，mergeExternalChanges:443 同样裸取，三处都没有 NaN/Infinity/负值闸门；同文件 1448-1455 的 victory-waves 却走了 normalizeVictoryWaves，构成同类键守卫不一致。 |
| skeptic-b2 | skeptic | F-slice-11-data-consistency-04 | holds | 644 的 intValue() 前只有 639-643 的 instanceof Number 守卫、后只有 645-648 的负值守卫；JLS 5.1.3 的饱和与截断、NaN 转 0 都不写入 problems，1930-1933 的汇总 warning 因此保持沉默，静默失真成立。 |
| skeptic-b2 | skeptic | F-slice-11-data-consistency-05 | holds | 1577 直接 write(settingsYaml) 整份写回，1575-1576 只对两个旧键 set null，前段没有任何 lastModified 比对；写成功后 1579 立刻把 settingsLastModified 对齐到新 mtime，1414 读盘到 1577 写盘之间的外部编辑会被旧快照覆盖且此后再无检测点。 |
| skeptic-b2 | skeptic | F-slice-11-data-consistency-06 | holds | 2005 的 monstersGate.load() 之后，2006 的守卫只有 !usable() 与 isReadOnly()，缺 1419 对 ABSENT 的显式拒绝；YamlFileGate.load 对 ABSENT 既不解锁也不加锁，于是 2011 把空 YAML 当成权威 monstersConfigYaml，2015-2039 的逐键读取全部落空、扩展字段只能保留代码默认。 |
| skeptic-c | skeptic | F-slice-26-data-consistency-01 | holds | 机制逐字成立：:123 捕获 AtomicMoveNotSupportedException 后，:124 用仅带 REPLACE_EXISTING 的 Files.move 重试（无原子性保证），:126-130 的 finally 只要 tmp 还在就 tmp.delete()，且 YamlFileGate.java:96 只留一行 Failed to save。但「两份都不存在」这一后果依赖一个本回合无法在仓库内验证的前提——非原 |
| skeptic-c | skeptic | F-slice-26-data-consistency-02 | holds | 调用链逐环成立：HilltopCommandHandler.java:408 先 messagesGate.reset()，:437 再 reload()；LanguageManager.java:90 的 load() 在原件已被 YamlFiles.java:169 的 Files.move 挪成 .corrupt 后返回 ABSENT 且 usable()==true（:80-81、:49-51）；YamlFileGate.jav |
| skeptic-c | skeptic | F-slice-26-data-consistency-03 | holds | set 与 saveConfig 成对出现在 LanguageManager.java:306-307；Bukkit 的 saveConfig 走 FileConfiguration.save(File)，开文件流截断目标再写，与 YamlFiles.java:20-21/29-30 点名要避免的形态一致，IOException 只打 SEVERE、不重试、不留旧副本。全仓 new YamlFileGate(...) 共 6 处（Con |
| skeptic-c | skeptic | F-slice-13-contract-01 | holds | 机制成立：AbstractConfigMenu.java 只有 onClick(:154) 与 onClose(:176) 两个处理器，import 无 InventoryDragEvent；全仓 InventoryDragEvent 仅 AbstractAdminMenu:48、ArenaSelectionGUI:334、ShopListener:108 三处，没有覆盖配置菜单的全局 drag 监听，9 个配置菜单类（6 顶层 + 3 |
| skeptic-c | skeptic | F-slice-13-contract-02 | holds | ItemSettingsMenu.java:239-244 的 lambda 形参 ct 在函数体零次出现（只有 nextMat/setter.accept/reopen），逐字核对；AbstractConfigMenu.java:171 把 event.getClick() 原样传给动作，:161 只取消事件、不做 ClickType 白名单，因此 DROP/MIDDLE/NUMBER_KEY/DOUBLE_CLICK 都会推进材质并 |

## coverage_gaps

- [DIMENSION_OMITTED] slice-16/logic — slice-16 只含 core/WaveManager.java（903 行），宽扫产出 6 条线索其中 L5 为 logic 类（:1130 所有候选被 continue 跳过时 best 仍停在 players.get(0)，随后 :1079 跨世界 teleport），但 slice-16 不在深挖名单（01/05/08/11/13/15/20/21/24/26）内，该逻辑缺陷至今只是未验
- [DIMENSION_OMITTED] slice-22/concurrency — slice-22 深挖只做了 data-consistency；其 L2（mechanics/NodeSystem.java:698，并发容器里的 NodeData 用普通 double/boolean，damageNode 跨两个集合做 isRegisteredActive 判定再改状态）是 concurrency 类线索，从未被验证或推翻。
- [DIMENSION_OMITTED] slice-04/error-handling — ai 包 5 文件 1122 行全部只有宽扫；2 条 HIGH 线索（AirdropSpawnGoal.java:107 跨世界 distanceSquared、ExplodeBeetleGoal.java:243 NaN 穿透 Math.max）均记为 logic，error-handling 维度对 slice-04 为 0 次深挖——而 Bukkit Goal 内未捕获异常会静默终止 AI，
- [DIMENSION_OMITTED] slice-10/error-handling — command/SetupWizard.java 1952 行是全仓最大且唯一 oversized 切片，L4（:1175 四项必填复核在解析不到部署管理器时直接放行 true，随后清会话并 enableArena，HIGH）与 L6（:921 deploy() 可返回 null 而多处直接解引用）都属 error-handling，slice-10 未深挖。
- [DIMENSION_OMITTED] slice-12/error-handling — config/DisplayConfigLoader.java 有三处静默回落：:113 缺段时用出厂默认且不告警、:216 getString 把 Integer/Boolean 当 i18n 键、:372 缺 containsKey 判定使 when 空值与缺键同走 always（fail-open 与拼错条件名 fail-closed 相反）。slice-12 未深挖，这三处都停在线索状态。
- [DIMENSION_OMITTED] slice-23/security — mechanics/VillagerSystem.java:276 的白名单只认 instanceof Monster，玩家用刷怪蛋或指令生成的怪物同样被当作合法伤害源，可击杀受保护村民触发全灭失败（L4，MEDIUM，security）。这是全仓 4 条 security 线索中唯一玩家可利用路径，slice-23 未深挖。
- [DIMENSION_OMITTED] slice-18/concurrency — doc/CommandsDocumentGenerator.java 的串行化只有 static 锁（:523 区段），只覆盖同一 JVM；数据目录被两个服务端进程共享时非原子降级路径上的两次替换会互删目标文件（L1，concurrency，MEDIUM）。同文件 :568 只认 AtomicMoveNotSupportedException、:530 parent 为 null 抛 NPE 不在
- [DIMENSION_OMITTED] security（全仓，26 片横切） — 26 份宽扫合计只产出 4 条 security 线索（slice-03 L4、slice-20 L5、slice-23 L4、slice-24 L3），10 个深挖片的 security 深挖次数为 0，已确认 24 条 finding 中 security 维度 0 条。权限节点在补全侧（HilltopTabCompleter.java:70 用 hilltopvillage.admin）与分
- [DIMENSION_OMITTED] logic（全仓，26 片横切） — 宽扫合计 28 条 logic 线索，深挖 0 次，已确认 finding 中 logic 维度 0 条；其中含 1 条 HIGH（ai/ExplodeBeetleGoal.java:243，NaN 穿透 Math.max 后传入 damageNode）。同维度还有多条 MEDIUM（slice-04 L3/L4/L5、slice-19 L1/L3/L5、slice-14 L3/L5、slice-
- [ENTRY_UNCOVERED] 动态 registerEvents 入口集（17 处，全仓） — grep registerEvents\( 在 src/main/java 命中 31 处：14 处在 HilltopVillagePlugin 生命周期注册，17 处在 GUI/菜单类内按次注册（HilltopCommandHandler.java:648/:666、AbstractConfigMenu.java:61、WaveSettingsMenu.java:101/183/264/288/
- [DIMENSION_OMITTED] slice-02/error-handling — admin/LocationParticlePreview.java:97 的注释声称覆盖「世界未加载」，但判据只有引用为 null，未加载世界的引用通常仍非 null，逐点绘制仍会走进 spawnParticle（L1，error-handling，MEDIUM）；同文件 :88 的任务清理只写在正常结束分支，drawMarker 抛异常即跳过 cancel，previewTasks 残留死任务