# 宽扫线索汇总（26 切片 / 151 条 lead）

- 来源：`.run-dsh3/artifacts/round1-02-sweep-slice-*.md` 的 `payload.leads`（机械抽取，未改动原文）。
- 生成：`.run-dsh3/lead-summary.mjs`；每条 lead 的 `quote` 仍以对应 sweep 产物为准，深挖时必须回源文件重读。
- 宽扫覆盖：**26/26 切片**（slice-17/18/19/23 为本回合补扫）。

## 1. 维度与置信度分布

| 维度 | lead 数 |
|---|---|
| logic | 28 |
| concurrency | 11 |
| security | 4 |
| error-handling | 34 |
| data-consistency | 45 |
| contract | 29 |
| **合计** | **151** |

置信度：HIGH 10 / MEDIUM 108 / LOW 33。

## 2. 逐切片线索数

| slice | 可达性 | 文件数 | lead 数 | 维度分布 | 已深挖 |
|---|---|---|---|---|---|
| slice-01 | PROD | 3 | 6 | error-handling:1 data-consistency:5 | — |
| slice-02 | PROD | 3 | 6 | logic:2 error-handling:1 data-consistency:1 contract:2 | — |
| slice-03 | PROD | 2 | 5 | logic:1 concurrency:1 security:1 data-consistency:1 contract:1 | — |
| slice-04 | PROD | 5 | 6 | logic:5 error-handling:1 | — |
| slice-05 | PROD | 2 | 6 | logic:1 concurrency:1 error-handling:1 data-consistency:2 contract:1 | — |
| slice-06 | PROD | 4 | 5 | logic:1 error-handling:1 data-consistency:2 contract:1 | — |
| slice-07 | PROD | 1 | 5 | logic:1 error-handling:2 data-consistency:2 | — |
| slice-08 | PROD | 3 | 6 | logic:1 error-handling:1 data-consistency:1 contract:3 | — |
| slice-09 | PROD | 2 | 4 | logic:1 contract:3 | — |
| slice-10 | PROD | 1 | 6 | logic:1 error-handling:2 data-consistency:2 contract:1 | — |
| slice-11 | PROD | 2 | 6 | data-consistency:5 contract:1 | — |
| slice-12 | PROD | 3 | 6 | logic:2 error-handling:2 contract:2 | — |
| slice-13 | PROD | 7 | 6 | logic:1 error-handling:1 contract:4 | — |
| slice-14 | PROD | 2 | 5 | logic:2 data-consistency:1 contract:2 | — |
| slice-15 | PROD | 5 | 6 | concurrency:1 error-handling:1 data-consistency:3 contract:1 | concurrency（已落盘） |
| slice-16 | PROD | 1 | 6 | logic:1 concurrency:1 error-handling:4 | — |
| slice-17 | PROD | 1 | 7 | logic:1 error-handling:4 contract:2 | — |
| slice-18 | PROD | 1 | 5 | concurrency:1 error-handling:2 data-consistency:1 contract:1 | — |
| slice-19 | PROD | 1 | 6 | logic:2 error-handling:2 contract:2 | — |
| slice-20 | PROD | 5 | 6 | logic:1 concurrency:2 security:1 error-handling:1 data-consistency:1 | concurrency（已落盘） |
| slice-21 | PROD | 4 | 6 | logic:1 concurrency:1 error-handling:1 data-consistency:2 contract:1 | concurrency（已落盘） |
| slice-22 | PROD | 5 | 6 | concurrency:1 error-handling:2 data-consistency:3 | — |
| slice-23 | PROD | 1 | 7 | logic:2 security:1 error-handling:1 data-consistency:2 contract:1 | — |
| slice-24 | PROD | 7 | 6 | security:1 error-handling:1 data-consistency:4 | data-consistency（已落盘） |
| slice-25 | PROD | 2 | 6 | concurrency:1 error-handling:1 data-consistency:3 contract:1 | — |
| slice-26 | PROD | 6 | 6 | concurrency:1 error-handling:1 data-consistency:4 | — |

## 3. 待深挖优先级队列（按维度优先级 × 置信度排序）

> 只列尚未深挖的切片；同一格内按 HIGH 优先。

| 序 | slice | 维度 | lead | 置信度 | 位置 | 一句话 |
|---|---|---|---|---|---|---|
| 1 | slice-03 | concurrency | L3 | MEDIUM | `src/main/java/com/hilltopvillage/admin/gui/AbstractAdminMenu.java:71` | @EventHandler 挂在每次打开菜单都 new 的 GUI 实例上，而命令层每次打开都 registerEvents(gui)（HilltopCommandHandler.java:666），未见 unregisterAll，监听器随打开次数累积并持有 Player/Inventory 引用。 |
| 2 | slice-18 | concurrency | L1 | MEDIUM | `src/main/java/com/hilltopvillage/doc/CommandsDocumentGenerator.java:523` | 串行化只覆盖同一 JVM（static 锁），数据目录被两个服务端进程共享时，非原子降级路径上的两次替换会互相删除对方的目标文件。 |
| 3 | slice-26 | concurrency | L4 | MEDIUM | `src/main/java/com/hilltopvillage/util/YamlFileGate.java:89` | writable() 检查与随后的 write 之间无锁，readOnly 仅 volatile；异步写线程可在另一线程上闩之后继续写，两个写者也只会互相覆盖快照。 |
| 4 | slice-05 | concurrency | L4 | LOW | `src/main/java/com/hilltopvillage/arena/ArenaInstance.java:953` | 对 volatile definition 做「读-派生-整体替换」的非原子读改写，与 applyWaitingLocation 的同类替换并发时互相丢更新。 |
| 5 | slice-16 | concurrency | L6 | LOW | `src/main/java/com/hilltopvillage/core/WaveManager.java:406` | 循环内 411 行直接 living.remove()，该模式依赖 world.getEntities() 返回独立快照；若返回实时集合，remove 触发的实体移除监听再改动世界实体即 ConcurrentModificationException（435-437 的静态清扫同样写法）。 |
| 6 | slice-22 | concurrency | L2 | LOW | `src/main/java/com/hilltopvillage/mechanics/NodeSystem.java:698` | 并发容器里的 NodeData 用普通 double/boolean 存血量与存活态，damageNode 先跨两个集合做 isRegisteredActive 判定再改状态，是典型的 check-then-act 窗口。 |
| 7 | slice-25 | concurrency | L4 | LOW | `src/main/java/com/hilltopvillage/stats/StatsManager.java:578` | 该赋值位于 writeAtomically 的 readOnly 分支，运行在异步写线程；生产者在主线程 record() 里置 dirty=true，两个线程对同一个 volatile 标志做非原子的清/置，可能吞掉一次尚未落盘的变更标记。 |
| 8 | slice-11 | data-consistency | L1 | HIGH | `src/main/java/com/hilltopvillage/config/ConfigManager.java:1425` | 读盘失败分支在未写入任何文件的情况下推进已落盘快照，使内存中的未保存改动被 hasUnsavedChanges 判成已保存。 |
| 9 | slice-11 | data-consistency | L2 | HIGH | `src/main/java/com/hilltopvillage/config/ConfigManager.java:1442` | contains 为真不代表 getString 非 null，空值或非字符串标量会把 null 直接写进 worldName，而相邻的 material 键都有 null 判。 |
| 10 | slice-26 | data-consistency | L1 | HIGH | `src/main/java/com/hilltopvillage/util/YamlFiles.java:124` | ATOMIC_MOVE 失败后的降级分支是非原子的「先删后改名」，且 finally 会删掉 tmp，崩溃窗口内原文件与临时副本可能同时消失。 |
| 11 | slice-26 | data-consistency | L2 | HIGH | `src/main/java/com/hilltopvillage/util/LanguageManager.java:93` | 只判 gate 的实例级 readOnly，未查磁盘上的 .corrupt；gate.reset() 后 load() 返回 ABSENT 即可写，已隔离文件会被一份新默认内容覆盖。 |
| 12 | slice-01 | data-consistency | L1 | MEDIUM | `src/main/java/com/hilltopvillage/admin/ArenaResetService.java:295` | 只把 removed==0 当失败，部分删除（0<removed<expected）会继续重置，nodes.yml 残留无主节点。 |
| 13 | slice-01 | data-consistency | L3 | MEDIUM | `src/main/java/com/hilltopvillage/admin/ArenaResetService.java:312` | 商店实体在 clearDeploymentData 之前删除，后一步失败中止并重新启用时实体不会恢复，配置里的 shop-npc 仍在。 |
| 14 | slice-01 | data-consistency | L4 | MEDIUM | `src/main/java/com/hilltopvillage/admin/AdminDeployManager.java:557` | 一次保存拆成两次整份写盘，第二次失败留下生成点已更新、shop-npc 未更新的半成功磁盘状态。 |
| 15 | slice-03 | data-consistency | L1 | MEDIUM | `src/main/java/com/hilltopvillage/admin/gui/ArenaManageGUI.java:663` | applyParam 用点击瞬间的 ArenaView 快照回写未修改的三项参数，聊天栏输入期间经命令改过的参数会被旧值覆盖（类注释 640-642 自认此取舍）。 |
| 16 | slice-05 | data-consistency | L2 | MEDIUM | `src/main/java/com/hilltopvillage/arena/ArenaInstance.java:766` | stopGame() 在此显式调用一次，随后 setState(ENDING) 经 onGameEnd() 又调用一次，同一收尾链上 gameManager.stopGame 执行两遍。 |
| 17 | slice-05 | data-consistency | L5 | MEDIUM | `src/main/java/com/hilltopvillage/arena/ArenaInstance.java:1489` | reset() 内部已对同一世界发起 restoreWithResult 异步回滚，这里再强制 restoreNow 一次，同一世界存在两条回滚请求。 |
| 18 | slice-06 | data-consistency | L1 | MEDIUM | `src/main/java/com/hilltopvillage/arena/ArenaManager.java:836` | findArenaKey 返回首个大小写不敏感匹配，而 load() 只注册通过 ARENA_ID 校验的小写键；同一 ID 的大小写变体并存时，写入可能落到被 load() 跳过的 YAML 节点。 |
| 19 | slice-06 | data-consistency | L5 | MEDIUM | `src/main/java/com/hilltopvillage/arena/ArenaManager.java:374` | lobby.spawn 坐标直接 getDouble 后构造 Location，未像竞技场坐标那样校验 isFinite，YAML 中 .NaN/.inf 可进入传送路径。 |
| 20 | slice-07 | data-consistency | L1 | MEDIUM | `src/main/java/com/hilltopvillage/arena/MultiArenaManager.java:768` | 映射指向已移除实例时 getPlayerArena 返回 null，清理映射的分支被整段跳过，isInArena 永久为真而 leaveArena 永远空转。 |
| 21 | slice-07 | data-consistency | L2 | MEDIUM | `src/main/java/com/hilltopvillage/arena/MultiArenaManager.java:101` | 先删重连记录与玩家映射、后调 removePlayer/removeOfflinePlayer，副作用抛异常时记录已不可恢复，玩家留在实例里却无映射。 |
| 22 | slice-10 | data-consistency | L3 | MEDIUM | `src/main/java/com/hilltopvillage/command/SetupWizard.java:1687` | autoSave 在 saveToFile() 返回 false 时仍写入 wizard.step 并 saveConfig，进度指针落盘而数据未落盘。 |
| 23 | slice-10 | data-consistency | L5 | MEDIUM | `src/main/java/com/hilltopvillage/command/SetupWizard.java:133` | 缓存上下文只重载 spawnPoints 与 nodes，villagers/shop 仍是构造期内存副本，注释所述的整份写回风险只剩这两项未堵。 |
| 24 | slice-11 | data-consistency | L3 | MEDIUM | `src/main/java/com/hilltopvillage/config/ConfigManager.java:1469` | 同一文件对 explode-damage-multiplier 专门挡 NaN/Infinity，villager-health 却裸 getDouble，.nan/.inf/负值原样进实体血量。 |
| 25 | slice-11 | data-consistency | L4 | MEDIUM | `src/main/java/com/hilltopvillage/config/ConfigManager.java:644` | 注释声称缺键/非数值/负数三种形态都显式化，实现只判负数；intValue 的饱和溢出与小数截断静默通过。 |
| 26 | slice-11 | data-consistency | L5 | MEDIUM | `src/main/java/com/hilltopvillage/config/ConfigManager.java:1577` | 载入过程中途用开头的整份 YAML 全量写盘做旧键迁移，不经过 saveToFile 的 mtime 外部修改检测，窗口内的手改会被覆盖。 |
| 27 | slice-14 | data-consistency | L4 | MEDIUM | `src/main/java/com/hilltopvillage/config/menu/WaveSettingsMenu.java:118` | 新增波次直接写内存 map，而同一菜单的删除走 configManager.removeWave 记账，两条路径的落盘语义不对称。 |
| 28 | slice-18 | data-consistency | L5 | MEDIUM | `src/main/java/com/hilltopvillage/doc/CommandsDocumentGenerator.java:576` | 降级路径在 Windows 上先删目标再改名，改名失败时旧文档已删、临时文件又被 finally 清理，净结果是两份都没有，只留一条 WARNING。 |
| 29 | slice-22 | data-consistency | L1 | MEDIUM | `src/main/java/com/hilltopvillage/mechanics/NodeSystem.java:180` | 载入时按当前方块材质跳过节点，随后内存清理会把该节点移出 nodes，而保存逻辑只回写内存里的节点，等于用一次读失败静默删掉 nodes.yml 中的持久条目。 |
| 30 | slice-23 | data-consistency | L2 | MEDIUM | `src/main/java/com/hilltopvillage/mechanics/VillagerSystem.java:235` | 用实体对象身份判定是否本局村民，区块卸载重载后事件里的新实例不在列表中，会跳过伤害拦截与死亡结算 |
| 31 | slice-23 | data-consistency | L3 | MEDIUM | `src/main/java/com/hilltopvillage/mechanics/VillagerSystem.java:178` | 同一身份判定在 cleanupOrphans 中反向使用，重载后在世村民被判成孤儿删除，而 deployedTotal 不同步减少 |
| 32 | slice-25 | data-consistency | L1 | MEDIUM | `src/main/java/com/hilltopvillage/stats/StatsManager.java:378` | 解析失败分支只把隔离结果用于日志措辞，隔离失败时既不置 readOnly 也不阻止后续写盘，下一轮 flushAsync 会用空缓存快照覆盖那份刚被声称「已保留」的损坏文件。 |
| 33 | slice-25 | data-consistency | L2 | MEDIUM | `src/main/java/com/hilltopvillage/stats/StatsManager.java:281` | kills/deaths/nodes/crystals 直接累加调用方给的 int，没有像下方 wave 那样用 Math.max(0, …) 夹取，负值或超大值会原样落盘，并被 top() 的 <=0 过滤条件从榜单里静默排除。 |
| 34 | slice-25 | data-consistency | L6 | MEDIUM | `src/main/java/com/hilltopvillage/stats/StatsManager.java:407` | getInt 对超出 int 范围或非数字的值静默返回默认值 0，按记录包裹的 try/catch 不会触发，随后 buildSnapshot 会把 0 写回整份快照，原值被无声抹平且无任何日志。 |
| 35 | slice-26 | data-consistency | L3 | MEDIUM | `src/main/java/com/hilltopvillage/util/LanguageManager.java:307` | Bukkit saveConfig 走截断式写，与同包 YamlFiles 的「临时文件 + ATOMIC_MOVE」策略相反，写入窗口内崩溃会留下半截 config.yml。 |
| 36 | slice-01 | data-consistency | L5 | LOW | `src/main/java/com/hilltopvillage/admin/AdminDeployManager.java:399` | 迁移写盘前不重新 load，用 loadSpawnPoints 期间的陈旧整份副本覆写，可能回滚其它写入方的落盘内容。 |
| 37 | slice-01 | data-consistency | L6 | LOW | `src/main/java/com/hilltopvillage/admin/ArenaAdminService.java:542` | 只读的 buildView 调用 loadArenas -> gate.load()，而 load 可能把 arenas.yml 隔离成 .corrupt 并上闩只读。 |
| 38 | slice-02 | data-consistency | L4 | LOW | `src/main/java/com/hilltopvillage/admin/LocationParticlePreview.java:88` | 任务表的清理只写在正常结束分支内，循环里 drawMarker 一旦抛异常就跳过 cancel/清理，previewTasks 会残留指向已死任务的条目。 |
| 39 | slice-08 | data-consistency | L6 | LOW | `src/main/java/com/hilltopvillage/command/HilltopCommandHandler.java:915` | 坐标文案用 String.format 加默认 Locale，非英文服务端会输出逗号小数（12,5），而同类坐标在 listspawns 里被当作可粘回命令的参数展示。 |
| 40 | slice-22 | data-consistency | L5 | LOW | `src/main/java/com/hilltopvillage/mechanics/PlayerLifecycleListener.java:95` | 清掉落与 keepInventory 在 playerData 判空之外无条件执行，不属于本局 playerDataMap 的玩家在竞技场世界死亡也会被清空掉落并广播阵亡。 |
| 41 | slice-22 | data-consistency | L6 | LOW | `src/main/java/com/hilltopvillage/mechanics/VillagerPreviewManager.java:122` | 清理只把失效引用从内存列表剔除而不移除实体本体，persistent 且不远离消失的预览村民会留在存档里，仅靠 EntitiesLoadEvent 与开服一次的 cleanupOrphans 兜底。 |
| 42 | slice-26 | data-consistency | L6 | LOW | `src/main/java/com/hilltopvillage/util/MessageTextSync.java:376` | 键冲突时基线哈希写失败被静默 return false，调用方不检查，该键此后只能走 legacy/保守分支并可能被永久标成自定义。 |
| 43 | slice-04 | error-handling | L1 | HIGH | `src/main/java/com/hilltopvillage/ai/AirdropSpawnGoal.java:107` | targetDropLocation 属于 gameWorld，而 dropper 可用外部传送/换世界脱离该世界；此处直接 distanceSquared 未先比 world，跨世界会抛 IllegalArgumentException，同包 DropperAttackGoal 在 :191 明确为此加了守卫而这里没有。 |
| 44 | slice-08 | error-handling | L1 | HIGH | `src/main/java/com/hilltopvillage/command/HilltopCommandHandler.java:1582` | 上一行 stats.get(uuid) 的返回值未判空即解引用，紧随其后的 target == null 判空因此不可达——查询返回 null 时 /hilltop stats 会 NPE。 |
| 45 | slice-10 | error-handling | L4 | HIGH | `src/main/java/com/hilltopvillage/command/SetupWizard.java:1175` | 四项必填复核在解析不到部署管理器时直接放行(true)，而放行后紧接着会清会话与进度并 enableArena。 |
| 46 | slice-17 | error-handling | L3 | HIGH | `src/main/java/com/hilltopvillage/diagnostic/TpsDiagnostic.java:77` | 空 catch 吞掉 NoSuchMethodError，第 74 行初值 0 会被当作真实方块实体数输出。 |
| 47 | slice-01 | error-handling | L2 | MEDIUM | `src/main/java/com/hilltopvillage/admin/ArenaResetService.java:244` | 异常兜底只释放 in-flight 并回调，不调用 abort/reinstate，已 disableArena 的竞技场会静默停在 DISABLED。 |
| 48 | slice-02 | error-handling | L1 | MEDIUM | `src/main/java/com/hilltopvillage/admin/LocationParticlePreview.java:97` | 注释声称覆盖「世界未加载」，但判据只有引用为 null，未加载世界的引用通常仍非 null，逐点绘制仍会走进 spawnParticle。 |
| 49 | slice-05 | error-handling | L1 | MEDIUM | `src/main/java/com/hilltopvillage/arena/ArenaInstance.java:140` | getCore() 在 ArenaDefinition 中允许返回 null（未部署态），构造函数未判空即解引用，抛 NPE 而非可读异常。 |
| 50 | slice-06 | error-handling | L2 | MEDIUM | `src/main/java/com/hilltopvillage/arena/ArenaManager.java:869` | requiredDouble 只用 isSet 判断存在，随后 getDouble 对非数值标量取默认 0.0，损坏坐标会被静默当成合法 (0,0,0) 而不是报错。 |
| 51 | slice-07 | error-handling | L4 | MEDIUM | `src/main/java/com/hilltopvillage/arena/MultiArenaManager.java:110` | 每秒重连扫描的循环内没有 try/catch，单场抛异常会让整个 runTaskTimer 任务被取消，此后所有待过期重连记录永不处理。 |
| 52 | slice-10 | error-handling | L6 | MEDIUM | `src/main/java/com/hilltopvillage/command/SetupWizard.java:921` | deploy() 可返回 null 且同文件五处显式防了 null，但 sendShopStatus/clear-shop/autoSave 等调用点直接解引用。 |
| 53 | slice-12 | error-handling | L6 | MEDIUM | `src/main/java/com/hilltopvillage/config/GameConfig.java:645` | defaultWave 无 null 守卫而 setDefaultWave 接受 null，脏检查调用 snapshot() 时可能 NPE |
| 54 | slice-13 | error-handling | L6 | MEDIUM | `src/main/java/com/hilltopvillage/config/menu/NumericInputHandler.java:214` | 每条非法聊天输入都重挂条目并重置 30 秒超时，玩家靠等待退不出输入态，公屏消息被持续吞掉。 |
| 55 | slice-16 | error-handling | L1 | MEDIUM | `src/main/java/com/hilltopvillage/core/WaveManager.java:464` | world 来自未判空的 getGameWorld()（449），此处只 catch IllegalArgumentException，世界卸载/换图窗口下 NPE 会冒出 runTaskTimer 任务体。 |
| 56 | slice-16 | error-handling | L2 | MEDIUM | `src/main/java/com/hilltopvillage/core/WaveManager.java:167` | 先置空句柄、再执行 onComplete、最后才 cancel()（167-169）：回调抛异常时 cancel 不执行，任务既无句柄可被 cancelSpawnTask 取消、又会每 3 tick 重复触发回调。 |
| 57 | slice-16 | error-handling | L3 | MEDIUM | `src/main/java/com/hilltopvillage/core/WaveManager.java:1011` | 空投批次任务内 spawnEntity 无 try/catch（与三个特殊怪生成方法的 catch 不一致），且 mobType 来自配置，异常后 handle 仍留在 airdropTasks 中按 10 tick 反复抛。 |
| 58 | slice-17 | error-handling | L1 | MEDIUM | `src/main/java/com/hilltopvillage/diagnostic/TpsDiagnostic.java:63` | gameManager 判空后仍直接链式调用 getWaveManager()，未判空即取剩余怪物数。 |
| 59 | slice-17 | error-handling | L2 | MEDIUM | `src/main/java/com/hilltopvillage/diagnostic/TpsDiagnostic.java:65` | getNodeSystem() 未判空且同一行重复取两次，空指针风险与冗余调用并存。 |
| 60 | slice-17 | error-handling | L4 | MEDIUM | `src/main/java/com/hilltopvillage/diagnostic/TpsDiagnostic.java:47` | 入口直接调用 Paper 专有 API 且无可用性保护，与第 76 行对同类 API 的兜底不一致。 |
| 61 | slice-18 | error-handling | L2 | MEDIUM | `src/main/java/com/hilltopvillage/doc/CommandsDocumentGenerator.java:568` | catch 只认 AtomicMoveNotSupportedException；provider 若以 UnsupportedOperationException 上报 ATOMIC_MOVE 不可用，则既不走降级也不被外层 IOException catch 接住，任务静默死亡。 |
| 62 | slice-22 | error-handling | L3 | MEDIUM | `src/main/java/com/hilltopvillage/mechanics/NodeSystem.java:831` | 增益等级由配置值与节点数相加得出且无 0-255 夹取，越界时 PotionEffect 抛 IllegalArgumentException，而这段代码位于无 try/catch 的周期任务体内。 |
| 63 | slice-22 | error-handling | L4 | MEDIUM | `src/main/java/com/hilltopvillage/mechanics/TabListManager.java:739` | viewOf 对 getGameManager() 判了 null，同一文件的 resolveArg 却直接链式调用，实例存在而 GameManager 未装配时会让整帧刷新抛异常并跳过所有玩家。 |
| 64 | slice-23 | error-handling | L5 | MEDIUM | `src/main/java/com/hilltopvillage/mechanics/VillagerSystem.java:144` | 配置血量未做有限性校验，Math.max(1.0, NaN) 仍为 NaN，setHealth 抛异常会让 spawnAll 循环中途退出且 deployedTotal 未回填 |
| 65 | slice-25 | error-handling | L3 | MEDIUM | `src/main/java/com/hilltopvillage/stats/StatsManager.java:597` | 只把 AtomicMoveNotSupportedException 当作可降级信号，ATOMIC_MOVE 抛出的其它 IOException（目标被占用、FileAlreadyExistsException 等）落到外层通用 catch，只置脏后按同样参数永远重试，没有任何降级或停写判定。 |
| 66 | slice-26 | error-handling | L5 | MEDIUM | `src/main/java/com/hilltopvillage/util/DisplayEntityManager.java:15` | getWorld() 可为 null 且 location 未判空，随后直接 world.spawnParticle，缺世界坐标会让 NPE 冒到主线程实体回调。 |
| 67 | slice-07 | error-handling | L5 | LOW | `src/main/java/com/hilltopvillage/arena/MultiArenaManager.java:362` | 同文件对 PlayerGoodsManager 做了可能为 null 的兜底，此处却直接解引用 MapRestoreManager；为 null 时启用队列任务 NPE 停摆。 |
| 68 | slice-12 | error-handling | L5 | LOW | `src/main/java/com/hilltopvillage/config/DisplayConfigLoader.java:113` | 只缺一段时静默用出厂默认且不告警，段名拼错会让用户以为自己的配置已生效 |
| 69 | slice-16 | error-handling | L4 | LOW | `src/main/java/com/hilltopvillage/core/WaveManager.java:574` | getAttribute 返回值直接解引用，同文件 applyMonsterEquipment 对 ATTACK_DAMAGE 做了判空（491-492），此处 622/682 行同样未判；entity-type 可被管理员配置成无该属性的类型。 |
| 70 | slice-18 | error-handling | L3 | LOW | `src/main/java/com/hilltopvillage/doc/CommandsDocumentGenerator.java:530` | parent 为 null 时这里抛 NPE，而 NPE 不是 IOException，第 473 行的 catch 接不住，异步任务终止且无日志。 |
| 71 | slice-19 | error-handling | L4 | LOW | `src/main/java/com/hilltopvillage/gui/ArenaSelectionGUI.java:158` | 地图缺失（世界未加载）是正常状态，但 getWorldName() 未判空就作为语言占位符参数。 |
| 72 | slice-19 | error-handling | L6 | LOW | `src/main/java/com/hilltopvillage/gui/ArenaSelectionGUI.java:75` | 标题直接来自语言键且未判空，缺键返回 null 时 createInventory 会抛异常，调用方无兜底。 |
| 73 | slice-02 | contract | L2 | MEDIUM | `src/main/java/com/hilltopvillage/admin/LocationParticlePreview.java:67` | PointKind 提供的 emptyKey()/showingKey() 按类别区分文案且部署侧确实在用，本类却硬编码通用键，传入的 kind 只用于取色，两套预览的文案契约不一致。 |
| 74 | slice-03 | contract | L2 | MEDIUM | `src/main/java/com/hilltopvillage/admin/gui/ArenaManageGUI.java:496` | 删除用渲染时算出的全局 index，点击时不按当前列表重新定位也不校验边界，渲染后列表被外部命令改动会删错点位。 |
| 75 | slice-05 | contract | L6 | MEDIUM | `src/main/java/com/hilltopvillage/arena/ArenaInstance.java:246` | 屏障命中时 setState 静默 return，void 签名让调用方无法区分「已迁移」与「被吞」，后续 scheduleReset 仍会置位。 |
| 76 | slice-06 | contract | L4 | MEDIUM | `src/main/java/com/hilltopvillage/arena/ArenaRegistry.java:27` | 同一个 public get 对 null 返回 null，但对空串/空白抛 IllegalArgumentException，调用方若只判 null 会被异常穿透。 |
| 77 | slice-08 | contract | L2 | MEDIUM | `src/main/java/com/hilltopvillage/command/HilltopCommandHandler.java:614` | nodes 子命令只在 args.length >= 4 时被识别，`/hilltop config nodes repairitem` 这种 3 参数形态会落到函数末尾打开配置 GUI，既不报用法缺失也不报未知子命令。 |
| 78 | slice-08 | contract | L3 | MEDIUM | `src/main/java/com/hilltopvillage/command/HilltopCommandHandler.java:297` | 唯一一个把用户输入原样交给 manager 的子命令（同 switch 的 start/stop/status/wave 都先 resolveArena 并播报解析失败），且上一行已执行 leaveArena，join 失败时玩家停在已退场未入场的中间态。 |
| 79 | slice-09 | contract | L1 | MEDIUM | `src/main/java/com/hilltopvillage/command/HilltopTabCompleter.java:70` | config 在此被列入统一用 hilltopvillage.admin 过滤的 isAdmin 名单，而 HilltopCommandHandler.java:389 的 case "config" 检查的是 hilltopvillage.config.admin，补全侧与分发侧的权限节点不一致 |
| 80 | slice-10 | contract | L1 | MEDIUM | `src/main/java/com/hilltopvillage/command/SetupWizard.java:1944` | GUI 删除分支裸 parseInt 无 try，而同族村民(1859)/节点(2112)分支都包了 try 并留痕，输入源同为插件自造 tag。 |
| 81 | slice-11 | contract | L6 | MEDIUM | `src/main/java/com/hilltopvillage/config/ConfigManager.java:2006` | loadMonstersConfig 返回 void 且失败只 return，loadFromFile 仍返回 true，调用方会把半份 reload 宣告成成功。 |
| 82 | slice-12 | contract | L2 | MEDIUM | `src/main/java/com/hilltopvillage/config/DisplayConfigLoader.java:272` | blank: false 既不算声明行型也不参与多行型告警，整行会被当成「no line kind」丢弃 |
| 83 | slice-12 | contract | L4 | MEDIUM | `src/main/java/com/hilltopvillage/config/DisplayConfigLoader.java:216` | getString 会把 Integer/Boolean 转成字符串当 i18n 键，类型写错时零告警 |
| 84 | slice-13 | contract | L1 | MEDIUM | `src/main/java/com/hilltopvillage/config/menu/MonsterSettingsMenu.java:82` | 这个 return 在 setBackButton/fillEmpty 之前，怪物键缺失时菜单会没有返回按钮，管理员只能按 ESC 退出。 |
| 85 | slice-13 | contract | L2 | MEDIUM | `src/main/java/com/hilltopvillage/config/menu/ItemSettingsMenu.java:241` | 点击动作不读 ClickType，DROP/NUMBER_KEY/MIDDLE/DOUBLE_CLICK 都会写回配置，而同仓库 GameRulesMenu 已收窄为 LEFT 白名单。 |
| 86 | slice-13 | contract | L3 | MEDIUM | `src/main/java/com/hilltopvillage/config/menu/MonsterSettingsMenu.java:211` | 布尔开关对任意 ClickType 都翻转，双击与丢出键都会改配置，且 lore 未声明哪些键有效。 |
| 87 | slice-13 | contract | L4 | MEDIUM | `src/main/java/com/hilltopvillage/config/menu/AbstractConfigMenu.java:154` | 类里只有 click 与 close 两个处理器，没有 InventoryDragEvent，拖拽把物品拖进 GUI 上半区不会被取消。 |
| 88 | slice-14 | contract | L1 | MEDIUM | `src/main/java/com/hilltopvillage/config/menu/WaveSettingsMenu.java:115` | 新增波次只判重复不判范围，num 可为 0、负数或 Integer.MAX_VALUE 并直接作为 waves 的键。 |
| 89 | slice-14 | contract | L2 | MEDIUM | `src/main/java/com/hilltopvillage/config/menu/WaveSettingsMenu.java:249` | slot 从 27 起随 comp 条目无上界递增，超过 18 条会覆盖 46 号新增按钮，超过 27 条写入 >=54 的越界槽位。 |
| 90 | slice-18 | contract | L4 | MEDIUM | `src/main/java/com/hilltopvillage/doc/CommandsDocumentGenerator.java:467` | generate() 提交异步任务后立即返回 void，调用方与下游消费者都无从判断 commands.md 何时可读；启动即关闭时任务会被取消而不留错误信号。 |
| 91 | slice-19 | contract | L2 | MEDIUM | `src/main/java/com/hilltopvillage/gui/ArenaSelectionGUI.java:329` | 先 closeInventory 再调用 joinArena，返回值未检查，join 失败时玩家得不到任何反馈。 |
| 92 | slice-23 | contract | L6 | MEDIUM | `src/main/java/com/hilltopvillage/mechanics/VillagerSystem.java:285` | 处理方法声明在 EventPriority.MONITOR 却在此改写事件（清掉落、清经验），MONITOR 约定为只读观察点 |
| 93 | slice-02 | contract | L5 | LOW | `src/main/java/com/hilltopvillage/admin/PointParticleRenderer.java:52` | show(...) 未校验 kind，drawMarker 的 javadoc 也只声明 world 非 null，这里直接解引用 kind；null 会在 4 tick 周期的任务里抛 NPE。 |
| 94 | slice-08 | contract | L5 | LOW | `src/main/java/com/hilltopvillage/command/ArenaCommand.java:39` | 无参路径直接返回 true，类中已无 usage/help 分支，命令被执行器调用时空参数会得到零反馈的静默成功。 |
| 95 | slice-09 | contract | L2 | LOW | `src/main/java/com/hilltopvillage/command/HilltopTabCompleter.java:192` | top 的合法类型集合在补全侧硬编码，分发侧用 StatsManager.StatType.fromKey 解析，同一集合双源维护，枚举变更时补全会静默失真 |
| 96 | slice-09 | contract | L3 | LOW | `src/main/java/com/hilltopvillage/command/HilltopTabCompleter.java:58` | 全文件其余分支一律返回 List（空表），唯此支返回 null，同一方法存在两种返回语义，调用方无法区分「不管此命令」与「补全为空」 |
| 97 | slice-17 | contract | L5 | LOW | `src/main/java/com/hilltopvillage/diagnostic/TpsDiagnostic.java:53` | 对 getTPS() 返回值做裸下标访问，未见数组长度校验。 |
| 98 | slice-17 | contract | L7 | LOW | `src/main/java/com/hilltopvillage/diagnostic/TpsDiagnostic.java:26` | 以 null 作为竞技场选择器传入 resolveArena，语义依赖被调方对 null 的约定。 |
| 99 | slice-25 | contract | L5 | LOW | `src/main/java/com/hilltopvillage/stats/StatsManager.java:215` | subList 只对 limit 做了上界收敛，没有下界校验：limit 为负时 toIndex 为负，抛 IllegalArgumentException 而不是返回空列表；当前唯一调用方硬编码 10，属未被触发的边界。 |
| 100 | slice-23 | security | L4 | MEDIUM | `src/main/java/com/hilltopvillage/mechanics/VillagerSystem.java:276` | 白名单只认 instanceof Monster，玩家用刷怪蛋或指令生成的怪物同样被当作合法伤害源，可击杀受保护村民触发全灭失败 |
| 101 | slice-03 | security | L4 | LOW | `src/main/java/com/hilltopvillage/admin/gui/ArenaManageGUI.java:772` | 破坏性重置在点击时直接执行，本类内未见权限节点复核，权限若只在打开菜单时校验，撤权后已打开的菜单仍可执行。 |
| 102 | slice-04 | logic | L2 | HIGH | `src/main/java/com/hilltopvillage/ai/ExplodeBeetleGoal.java:243` | 上一行注释自己写明 NaN 会穿透 Math.max(0, NaN)，但只守了 explodeMultiplier，nodeMultiplier 仍走 Math.max，NaN 会传进 nodeDamage → damageNode(loc, NaN)。 |
| 103 | slice-03 | logic | L5 | MEDIUM | `src/main/java/com/hilltopvillage/admin/gui/ArenaManageGUI.java:802` | 该分支发完 fail-skipped-world 后没有 return，会继续执行 805 行的 manage.reset.partial + failStepText("restore")，一次失败向管理员播报两条口径冲突的消息。 |
| 104 | slice-04 | logic | L3 | MEDIUM | `src/main/java/com/hilltopvillage/ai/ExplodeBeetleGoal.java:170` | noTargetTicks 到点后没有置位/清零的闩锁也没 return 之外的退出条件，beetle 若未立即失效，下一 tick 仍进同一分支再次 discardMob，重复出列；:201 的卡死分支同样是先 discardMob 再 return。 |
| 105 | slice-04 | logic | L4 | MEDIUM | `src/main/java/com/hilltopvillage/ai/NodeAttackGoal.java:232` | 寻路终点用 +1.0 的 Y，而同文件 :129 的攻击判定基准 targetCenter 用 +0.5 的 Y，两处高度基准不一致（ExplodeBeetleGoal:122 也是 +1）。 |
| 106 | slice-04 | logic | L5 | MEDIUM | `src/main/java/com/hilltopvillage/ai/NodeAttackGoal.java:131` | 「目标是否变了」用 NodeData 对象的引用不等来判断；若 getNearestNode 每次返回新的包装对象，同一节点也会判成 changed，tick() 里的 stuckTicks 会被每 30 tick 清零，:209 的 60-tick 卡死兜底可能永远到不了。 |
| 107 | slice-04 | logic | L6 | MEDIUM | `src/main/java/com/hilltopvillage/ai/DropperAttackGoal.java:88` | 这条复用分支只校验目标合法，不复核 HUNT_RANGE_SQ（:42 的 900.0 平方格）也不复核距离，玩家跑远后抛投者会一直追；shouldStayActive(:99) 同样没有距离条件。 |
| 108 | slice-05 | logic | L3 | MEDIUM | `src/main/java/com/hilltopvillage/arena/ArenaInstance.java:814` | 直接写 state 字段而绕过 setState()，restoreStarted 的回滚硬屏障与迁移分支都不生效。 |
| 109 | slice-06 | logic | L3 | MEDIUM | `src/main/java/com/hilltopvillage/arena/ArenaManager.java:563` | waiting-location 段存在但解析失败时 readOptionalLocation 返回 null，覆盖了上一行以 core 作默认值的回退，可能让等待区变成 null。 |
| 110 | slice-07 | logic | L3 | MEDIUM | `src/main/java/com/hilltopvillage/arena/MultiArenaManager.java:364` | 世界仍在隔离/回滚时把队首放回队尾但 1-tick 任务不停，同一场在 60 秒级窗口内被约 20 次/秒重复 poll 并重做冲突扫描。 |
| 111 | slice-08 | logic | L4 | MEDIUM | `src/main/java/com/hilltopvillage/command/HilltopCommandHandler.java:253` | stop 分支没有像 start 那样的状态前置检查，解析到实例后直接停服并固定播报 game-stopped，对 WAITING/结算中/地图恢复中的场会给出与真实状态不符的成功文案。 |
| 112 | slice-10 | logic | L2 | MEDIUM | `src/main/java/com/hilltopvillage/command/SetupWizard.java:1845` | GUI 点击处理器不校验 s.step 就直接 advance()，而聊天路径每条子命令都有步骤守卫，且 goto 不关闭已打开的界面。 |
| 113 | slice-12 | logic | L1 | MEDIUM | `src/main/java/com/hilltopvillage/config/DisplayConfigLoader.java:493` | Number.intValue() 静默截断小数，且超出 int 范围的值会回绕后被夹到下限（想调慢反而变最快） |
| 114 | slice-12 | logic | L3 | MEDIUM | `src/main/java/com/hilltopvillage/config/DisplayConfigLoader.java:372` | 缺 containsKey 判定，when: 空值与缺键同走 always，fail-open 与拼错条件名 fail-closed 策略相反 |
| 115 | slice-13 | logic | L5 | MEDIUM | `src/main/java/com/hilltopvillage/config/menu/GameRulesMenu.java:38` | min-players 与 max-players 各自独立 clamp，可以写出 minPlayers=20 而 maxPlayers=2 的组合，同文件 spawn-max-radius 却做了跨字段下界。 |
| 116 | slice-14 | logic | L3 | MEDIUM | `src/main/java/com/hilltopvillage/config/menu/WaveSettingsMenu.java:216` | wc == null 分支在 buildMenu 内关闭背包并 return，但 open() 随后仍无条件 openInventory，结果是一个 clickActions 已清空、点不动的空 54 格菜单。 |
| 117 | slice-16 | logic | L5 | MEDIUM | `src/main/java/com/hilltopvillage/core/WaveManager.java:1130` | 所有候选玩家都被 continue 跳过时 best 仍停在 players.get(0)、bestDistSq 保持 MAX_VALUE，方法注释所称“保证返回非 null”掩盖了“返回了另一个世界的玩家”，随后 1079 行跨世界 teleport。 |
| 118 | slice-19 | logic | L1 | MEDIUM | `src/main/java/com/hilltopvillage/gui/ArenaSelectionGUI.java:244` | canJoin 允许 STARTING，但图标 switch 无 STARTING 分支，落入 default 的 WOODEN_SWORD（类注释称其为不可用样式）。 |
| 119 | slice-19 | logic | L3 | MEDIUM | `src/main/java/com/hilltopvillage/gui/ArenaSelectionGUI.java:85` | 注释称保留底行做导航，实际超过 45 个竞技场即静默丢弃且没有任何翻页或提示。 |
| 120 | slice-23 | logic | L1 | MEDIUM | `src/main/java/com/hilltopvillage/mechanics/VillagerSystem.java:192` | 存活数按 isValid() 过滤，但全灭失败只在死亡事件里评估，村民被非死亡途径移除时计数归零也不触发失败 |
| 121 | slice-23 | logic | L7 | MEDIUM | `src/main/java/com/hilltopvillage/mechanics/VillagerSystem.java:117` | 未部署村民时只 warning 后 return，竞技场照常开局而失败条件永久不可达，调用方没有失败信号 |
| 122 | slice-02 | logic | L3 | LOW | `src/main/java/com/hilltopvillage/admin/LocationParticlePreview.java:72` | 上一行注释称「快照一份，避免预览过程中源列表被其它逻辑改动」，但这是浅拷贝，Location 元素仍与调用方共享引用。 |
| 123 | slice-02 | logic | L6 | LOW | `src/main/java/com/hilltopvillage/admin/PointKind.java:52` | 枚举常量位于 BEAM_DUST_SIZE/SPIRAL_DUST_SIZE 声明之前，构造常量时按文本顺序这两个静态字段尚未赋值，当前只因它们是编译期常量被内联才没暴露成 0.0f 尺寸。 |
| 124 | slice-09 | logic | L4 | LOW | `src/main/java/com/hilltopvillage/command/HilltopTabCompleter.java:118` | 第三参数补全只判长度与管理员权限，不校验 args[1] 是否为 clear/skip，非法 action 下仍会补出竞技场 ID |
| 125 | slice-14 | logic | L5 | LOW | `src/main/java/com/hilltopvillage/config/menu/WaveSettingsMenu.java:257` | 权重仅 Math.max(1, v) 钳下界、未传 min/max，极大权重会进入后续加权抽样。 |
| 126 | slice-17 | logic | L6 | LOW | `src/main/java/com/hilltopvillage/diagnostic/TpsDiagnostic.java:117` | 数值夹取只封上界，未处理 NaN 与负值，NaN 会落到 RED 分支并被格式化为 "NaN"。 |
| 127 | slice-19 | logic | L5 | LOW | `src/main/java/com/hilltopvillage/gui/ArenaSelectionGUI.java:241` | maxPlayers 为 0 或负数时该比较恒真，所有玩家都被判满、GUI 永久不可加入。 |

## 4. 已处置的深挖（本回合前已落盘，不重做）

| 产物 | 覆盖 | check-payload |
|---|---|---|
| `round1-02-audit-slice-15-concurrency.md` | slice-15 / concurrency | exit 0 |
| `round1-02-audit-slice-20-concurrency.md` | slice-20 / concurrency | exit 0 |
| `round1-02-audit-slice-21-concurrency.md` | slice-21 / concurrency | exit 0 |
| `round1-02-audit-slice-24-data-consistency.md` | slice-24 / data-consistency | exit 0 |

## 5. 说明

- 宽扫 lead 是**线索**，不是发现；深挖阶段允许大量证伪，证伪结果必须逐条落盘（REFUTED / EVIDENCE_GAP）。
- 本节表格的 `quote` 列从略：151 条原文引用在各自 sweep 产物的 JSON 里，避免二次转写引入偏差。