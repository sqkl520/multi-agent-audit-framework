# 深挖发现清单（机械抽取）

- 审计产物：15 份；CONFIRMED：34 条；非 CONFIRMED 条目：4 条。
- 严重性：MEDIUM 19 / LOW 9 / HIGH 6
- 维度：data-consistency 16 / logic 1 / error-handling 7 / contract 2 / concurrency 6 / security 2

| # | finding_id | 严重性 | 维度 | 位置 | claim | 状态 |
|---|---|---|---|---|---|---|
| 1 | F-slice-01-data-consistency-01 | MEDIUM | data-consistency | `admin/AdminDeployManager.java:557` | 一次 saveSpawnPoints() 被拆成两次独立的整份写盘：539 行先 gate.write(arenasConfig)，557 行再调用 saveShopNpcLocation()（590 行重新 load、610 行再整份写一次）。第二次写盘失败、或进程在两次写之间退出时，磁盘停在「生成点已更新、arenas.<id>.shop-npc 仍旧」的半成功状态；清空商店时旧 shop-npc 键要到第二次写盘才被删除，因此该窗口内退出会让已清除的商店 NPC 在重启后被 respawnFromConfig 复活。预期是一次保存只产生一个可见的磁盘状态。 | CONFIRMED |
| 2 | F-slice-01-data-consistency-02 | MEDIUM | data-consistency | `admin/ArenaResetService.java:312` | 重置序列第 7 步先删除世界里的商店 NPC 实体，第 8 步 clearDeploymentData 失败时 abort() 只回滚 nodes.yml 并重新启用竞技场，不恢复实体；arenas.yml 里 shop-npc 未被删（第 8 步没写成功），于是磁盘声明「本竞技场有商店 NPC」而世界里没有实体，且 respawnFromConfig() 只在插件启动时调用，要等重启才重新生成。 | CONFIRMED |
| 3 | F-slice-04-logic-01 | LOW | logic | `ai/ExplodeBeetleGoal.java:243` | 当 nodes.self-destruct-multiplier 为 NaN 或 Infinity 时，Math.max(0, ...) 会原样保留非有限值，使 nodeDamage 变成 NaN/Infinity；下游 NodeSystem.damageNode:696 的 !Double.isFinite(damage) 会返回 0，因此当前不会写坏节点血量、不会抛异常，但本行的非负钳制对 NaN/Infinity 实际无效，非法配置被静默折算成 0 伤害且无日志。相邻 explodeMultiplier 在 :241-242 做了 Double.isFinite 折算，同族守卫不一致。 | CONFIRMED |
| 4 | F-05-DC-01 | MEDIUM | data-consistency | `arena/ArenaInstance.java:471` | 当玩家在 STARTING/RUNNING/WAVE_INTERMISSION 离场且内存中不存在物品快照时（goods == null，或 PlayerGoodsManager.restore() 返回 false），removePlayer 在第 471 行无条件清空玩家背包；此刻快照已不存在，清空即不可逆地销毁玩家原版物品，而同一方法在第 433–437 行已经把本局统计提交、第 440/446 行已撤销成员资格，两者与背包归还不构成一个事务。 | CONFIRMED |
| 5 | F-slice08-eh-01 | MEDIUM | error-handling | `command/HilltopCommandHandler.java:1103` | 当 arenas.yml 或 nodes.yml 不可用（被隔离成 *.corrupt、闸门只读、竞技场世界未加载）时，/hilltop deploy reloadnodes 仍然无条件播报 deploy.reloadnodes-done 并打印旧的节点数：管理员收到成功回执，而两个加载器都已早退、什么都没重读。 | CONFIRMED |
| 6 | F-slice08-eh-00 | null | error-handling | `:-` | 上游指定的两条 error-handling 线索（L1 stats NPE、L5 ArenaCommand 无参静默）经复核均不成立，本切片在异常路径上未发现其它可确认缺陷。 | NO_EVIDENCE_FOUND |
| 7 | F-slice-10-eh-01 | HIGH | error-handling | `command/SetupWizard.java:1175` | 当 deploy(player) 解析不到部署管理器（目标世界未加载 / 竞技场定义缺失 / 部署期上下文刚被丢弃）时，四项必填复核把「无法检查」当成「四项齐备」返回 true；调用方 showStepDone 不区分该返回值来源，继续移除会话、清空 wizard.step / wizard.arena 并 saveConfig，随后 finishDeployment 走 reloadDefinitions → enableArena。错误路径被当成完成路径，产生不可逆的进度清除与一次竞技场启用尝试。 | CONFIRMED |
| 8 | F-slice-10-eh-02 | MEDIUM | error-handling | `command/SetupWizard.java:921` | sendShopStatus 在第 6 步状态行直接链式调用 deploy(player)，未判其 null 返回；同型未判空解引用至少还有 :452、:497-498、:538、:542、:555、:626、:875、:948、:1344、:1948、:2024。一旦 deploy 为 null，NPE 会从命令处理器或 InventoryClickEvent 处理器抛出，该次操作后续的消息、按钮行、GUI 刷新全部不执行，玩家得不到任何提示；clear-shop 在 :1344 就炸，配置与实体都不会被清。 | CONFIRMED |
| 9 | F-slice-10-eh-03 | LOW | error-handling | `command/SetupWizard.java:1944` | 第 3 步生成点 GUI 的删除分支对插件自造 tag 直接 Integer.parseInt，未包 try；同族村民分支 :1858-1883 与节点分支 :2111-2134 都包了 try、logger.warning 并回玩家一条提示，刷怪点分支 :2022 同样裸奔。tag 漂移时 NumberFormatException 会从 InventoryClickEvent 处理器逃逸：该次点击的删除、页码复位、GUI 刷新、autoSave 全部不执行，且插件侧零日志。 | CONFIRMED |
| 10 | F-slice-11-data-consistency-01 | HIGH | data-consistency | `config/ConfigManager.java:1425` | 当 game-settings.yml 不可用、不存在或闸门只读时，loadFromFile() 在未写入任何文件的情况下把 lastSavedSnapshot 推进为当前内存快照并 return false；hasUnsavedChanges() 随即变为 false，主菜单把保存按钮换成「已是最新」，此前的 GUI 改动失去唯一保存入口，重启后静默丢失。 | CONFIRMED |
| 11 | F-slice-11-data-consistency-02 | MEDIUM | data-consistency | `config/ConfigManager.java:1442` | contains() 判的是 get(path) 非 null，getString() 判的是值 instanceof String，两者之间的缝隙让数字/布尔/段形态的值把 null 写进 worldName；保存时 :851 以 null 调用 set() 等价于删键，磁盘上那一行静默消失，下一次载入回落到默认 "world"。 | CONFIRMED |
| 12 | F-slice-11-data-consistency-03 | MEDIUM | data-consistency | `config/ConfigManager.java:1469` | villager-health 从磁盘读入后不做任何归一化，.nan / .inf / 负值原样进入 GameConfig，并在下一次保存时被写回磁盘；同文件的同类风险键（explode-damage-multiplier、victory-waves、repair-cost-amount）都有专门 clamp，唯独这一键在载入与外部合并两条路径上都裸取。 | CONFIRMED |
| 13 | F-slice-11-data-consistency-04 | MEDIUM | data-consistency | `config/ConfigManager.java:644` | readWaveInt 只挡「非 Number」和负数，中间直接把 Number 压成 int：1e18 饱和成 Integer.MAX_VALUE、1.9 截断为 1、.nan 变成 0，三种失真都不写入 problems，所以加载结束时的 numericProblems 汇总 warning 不会出现，内存值与磁盘值静默分叉。 | CONFIRMED |
| 14 | F-slice-11-data-consistency-05 | LOW | data-consistency | `config/ConfigManager.java:1577` | 载入过程中的旧键迁移（:1577 nodes.repair-item、:1695 shop.currency-drop-amount）直接全量写盘，写前不比对新旧 mtime，也不经过 mergeExternalChanges；若在读盘（:1414）与写盘之间文件被外部修改，改动会被整份旧内容覆盖，且写成功后 :1579 立即对齐 mtime，后续保存也不会再发现。 | CONFIRMED |
| 15 | F-slice-13-contract-01 | MEDIUM | contract | `config/menu/AbstractConfigMenu.java:154` | AbstractConfigMenu 只注册了 InventoryClickEvent 与 InventoryCloseEvent 两个处理器，没有 InventoryDragEvent 处理器；因此在本菜单为 top inventory 时，玩家可以把受管 GUI 内的物品拖进自己的背包，预期是 raw slot 落在 top inventory 范围内的拖动必须被取消。 | CONFIRMED |
| 16 | F-slice-13-contract-02 | MEDIUM | contract | `config/menu/ItemSettingsMenu.java:239` | ItemSettingsMenu 的材质循环槽位（addMaterialCycle）与 MonsterSettingsMenu 的布尔开关都不读 ClickType：任何 ClickType（DROP、MIDDLE、DOUBLE_CLICK、NUMBER_KEY 等）都会直接写配置，而预期的契约是只有 LEFT/RIGHT（及 SHIFT 自定义输入）改变配置。 | CONFIRMED |
| 17 | F-slice-15-concurrency-01 | HIGH | concurrency | `core/PlayerGoodsManager.java:478` | flushToDisk() 把整个 writeYaml 丢到异步线程，而 writeYaml 在 422 行执行 yaml.saveToString()，于是含 ItemStack 的 Bukkit 配置对象在异步线程被序列化——这直接违反本类 336-341 行自己声明的「序列化留在主线程、只有纯 Files 写入才异步」，异步线程因此会读取主线程仍在使用的 Bukkit/NMS 物品对象。 | CONFIRMED |
| 18 | F-slice-15-concurrency-02 | MEDIUM | concurrency | `HilltopVillagePlugin.java:563` | PlayerQuitEvent（主线程）每次玩家退出都调用 saveNow() → writeYaml() 同步取 writeLock，而异步写线程在 419-423 行持有同一把锁执行整份 YAML 的 saveToString()、并在 429 行锁内做 Files.move；因此主线程在退出事件现场可能被一次完整序列化加一次磁盘 rename 阻塞，异步化收益被这把锁抵消，表现为 tick 停顿随未归还快照数与物品总量增长。 | CONFIRMED |
| 19 | F-slice-15-concurrency-03 | LOW | concurrency | `core/GameManager.java:478` | 波次超时保险用不可单调的挂钟计算已持续时间：330 行记起点、478 行求差、479/487 行据此决定传送高亮或强清残怪；系统时钟回拨会让 elapsedSeconds 变小甚至为负，本应打破软锁的保险被推迟或永不触发，时钟前跳则会提前清掉仍在场的残怪。 | CONFIRMED |
| 20 | F-slice-16-error-handling-01 | MEDIUM | error-handling | `core/WaveManager.java:464` | 刷怪默认分支只捕获 IllegalArgumentException，且对 gameManager.getGameWorld() 的返回值不判空；一旦 world 为 null 或 spawnEntity 之后抛出其它 RuntimeException，异常会从 runTaskTimer 的任务体冒出，本波批次中止且 onComplete 永不执行——GameManager.waveSpawning 因此永久为 true，清波判定被永久短路，本波无法结束。 | CONFIRMED |
| 21 | F-slice-16-error-handling-02 | MEDIUM | error-handling | `core/WaveManager.java:1011` | 空投批次任务体内的 spawnEntity 没有任何 try/catch，mobType 来自管理员可配的空投怪类型；一旦该类型不可生成而抛 IllegalArgumentException，本批剩余空投永久丢失，且任务句柄不会被移出 airdropTasks，成为集合内的死句柄直到整局结束才被清空。 | CONFIRMED |
| 22 | F-slice-16-error-handling-03 | LOW | error-handling | `core/WaveManager.java:574` | 三条特殊怪生成路径对 getAttribute 的返回值直接解引用，而同文件 applyMonsterEquipment 对 ATTACK_DAMAGE 做了判空；若 monsters.<id>.entity-type 被配置成不具备 MAX_HEALTH 的实体，:574 / :622 / :682 会抛 NPE，且该异常在 :554-561 的 try 之外，会从刷怪任务体冒出。 | CONFIRMED |
| 23 | F-slice-20-concurrency-01 | LOW | concurrency | `mechanics/ArenaScoreboard.java:369` | ensureTaskRunning() 在向调度器注册刷新任务前没有判 plugin.isEnabled()，而同类的 ensureReEnableProbeRunning()（:391-392）显式挡住禁用阶段；一旦 show() 落在插件禁用窗口内，runTaskTimer 会抛 IllegalPluginAccessException 并沿 show -> addPlayer/rejoin 冒到调用方，此时 boards 已 put、player.setScoreboard 已执行，形成「板挂上了但任务没起来」的半完成状态。 | CONFIRMED |
| 24 | F-slice-20-concurrency-02 | LOW | concurrency | `mechanics/FireballListener.java:612` | triggerExplosion 每次爆炸都新建一条匿名 BukkitRunnable 并以 runTaskTimer(plugin, 0L, 2L) 调度，返回的 BukkitTask 没有赋给任何字段；同类两条全局 ticker 都有字段句柄（:74 cooldownTicker、:78 trailTicker）并在 shutdown()（:455-472）里 cancel，唯此一条无句柄、不可取消，闭包持续持有 world 与 impact 直到第 11 次回调自停。 | CONFIRMED |
| 25 | F-slice-20-concurrency-03 | null | concurrency | `:-` | 在本切片 5 个文件中没有发现「异步线程触碰 Bukkit 世界/记分板 API」或「异步线程与主线程共享普通 HashMap/ArrayList」这一类并发缺陷。 | NO_EVIDENCE_FOUND |
| 26 | F-slice-20-security-01 | MEDIUM | security | `mechanics/ArenaAccessListener.java:49` | 竞技场世界准入只在 PlayerTeleportEvent 上实现，没有登录/重生/实体传送/周期扫描等任何兜底时机；不经过玩家传送事件的进场路径（典型为载具乘客随载具跨世界）不会被拦截，非成员因此可留在竞技场世界并对对局进行干预。 | CONFIRMED |
| 27 | F-slice-20-security-02 | LOW | security | `arena/MultiArenaManager.java:1067` | 登录路径上唯一的「把非成员挪出竞技场世界」动作以大厅出生点非空为前提：getLobbySpawn() 返回 null 时 applyLobbyState 既不传送也不做任何世界判定，曾在对局中退服、对局结束后重登的玩家会以非成员身份滞留在竞技场世界。 | CONFIRMED |
| 28 | F-slice-21-concurrency-01 | MEDIUM | concurrency | `mechanics/MapRestoreManager.java:551` | 回滚操作在任务注册之前就被发布到 activeRestores 并同步跑完首批；若这一批抛出逃出 catch (RuntimeException) 的 Throwable，该操作既没有 BukkitTask、也没有任何路径会再调用 complete()，activeRestores 中的条目永久残留，isRestoring(world) 恒为 true，竞技场 ENDING 屏障永不解除。 | CONFIRMED |
| 29 | F-slice-21-concurrency-02-L1-refuted | null | concurrency | `mechanics/MapRestoreManager.java:576` | L1 原样判定 REFUTED：其「Bukkit 在任务抛异常时会取消该 repeating task，导致 activeRestores 永不移除」的机制前提在 paper-1.21.4-232 上不成立；任务被重新入队后会继续推进 nextIndex 并最终走到 complete()。该线索的残余真实形态已收窄为 F-slice-21-concurrency-01（首轮同步批次无任务可兜底），不再以「异常即永久卡死」立条。 | NO_EVIDENCE_FOUND |
| 30 | F-slice-22-data-consistency-01 | HIGH | data-consistency | `mechanics/NodeSystem.java:180` | 载入时一次「方块当前不是重生锚」的读失败会让该坐标进不了 configuredLocations，随后被移出内存 nodes；下一次任意保存（调用链：GameManager.startGame:283 → loadNodesFromConfig:180-199 → addNode:381 / removeNode:399 / clearAllNodes:353 → saveNodesToConfig:286-298）会把 nodes.yml 中该条目永久删掉，日志只有一行 Skipped invalid energy node。 | CONFIRMED |
| 31 | F-slice-22-data-consistency-02 | MEDIUM | data-consistency | `mechanics/NodeSystem.java:381` | 写盘失败时 addNode 仍返回 0（成功）：节点只存在于内存，部署向导据此向管理员报「节点已添加」并显示内存计数，nodes.yml 没有该条目，下一局或重启后节点消失；同族的 removeNode 会把同样的失败如实上报。 | CONFIRMED |
| 32 | F-slice-24-dc-01 | MEDIUM | data-consistency | `shop/ShopListener.java:197` | 购买链先扣款（purchase:126）再发货；发货失败进入 refundCurrency 后，若补偿动作自身抛异常，catch 只写一行 SEVERE 日志就返回——货币已扣、商品未生成、玩家无提示，且没有任何持久化的待补偿记录或重试，一致性只能靠服主读日志人肉收敛。 | CONFIRMED |
| 33 | F-slice-24-dc-02 | MEDIUM | data-consistency | `shop/NpcManager.java:86` | NPC 换生是「先删旧、再建新」且第二步无保护：despawnNpc() 已把旧实体 remove 并把字段置 null，spawnEntity 或其后的 setProfession/setCustomName 一旦抛异常，方法直接穿出，npc 字段停留在 null——世界里再没有带 shop-npc 标记的实体，而 arenas.yml 里的坐标还在。 | CONFIRMED |
| 34 | F-slice-24-dc-03 | LOW | data-consistency | `shop/ShopManager.java:99` | reload 的成功路径只替换内存 config 并关闭残留 GUI，不重建也不改名在线 NPC；因此改 shop.npc.name 后 reload 返回 true、日志显示已加载，但实体头顶名仍是旧值，配置（源）与实体（派生状态）分叉，直到重启或重新 set 坐标。 | CONFIRMED |
| 35 | F-slice-24-dc-04 | null | data-consistency | `shop/ShopManager.java:271` | 主背包部分扣减只修改 getStorageContents() 返回数组里的 ItemStack 数量，没有 setItem 写回；副手分支却显式 setItemInOffHand 并注释「不依赖引用共享」。若该 API 返回的是副本，则部分扣减不落盘而余额校验已通过，玩家少付钱仍拿到货；若返回的是 NMS 镜像，则写法可用，仅口径不统一。 | EVIDENCE_GAP |
| 36 | F-slice-26-data-consistency-01 | HIGH | data-consistency | `util/YamlFiles.java:123` | 当 ATOMIC_MOVE 抛 AtomicMoveNotSupportedException 时，write() 降级为不带 ATOMIC_MOVE 的 REPLACE_EXISTING 移动；该移动失败（已进入替换、尚未完成）时 finally 会删除 tmp，磁盘上既没有可用的目标文件、也没有临时副本，与类注释『失败时目标文件保持原样』相反。 | CONFIRMED |
| 37 | F-slice-26-data-consistency-02 | HIGH | data-consistency | `util/LanguageManager.java:90` | messages.yml 被隔离成 .corrupt 后，管理员执行一次 /hilltop reloadconfig 就会让 reload() 把该文件当成首次运行：load() 返回 ABSENT 且 usable()==true，readOnly 已被 reset 清成 false，于是 diskWritable 为 true，第 4 步用 !messagesFile.exists() 触发写盘，把 JAR 出厂文案写成一份新的 messages.yml，绕过『隔离期间不得写回』的降级语义。 | CONFIRMED |
| 38 | F-slice-26-data-consistency-03 | MEDIUM | data-consistency | `util/LanguageManager.java:305` | setLocale() 用 Bukkit 的 plugin.saveConfig() 落盘 config.yml，该方法先截断目标再写；写入窗口内发生 IOException（磁盘满、进程被杀）会留下 0 字节或半截 config.yml，且该文件不在任何 YamlFileGate 的保护范围内。 | CONFIRMED |

## 按审计产物

| 产物 | 切片 | 维度 | CONFIRMED | 条目总数 |
|---|---|---|---|---|
| round1-02-audit-slice-01-data-consistency.md | slice-01 | data-consistency | 2 | 2 |
| round1-02-audit-slice-04-logic.md | slice-04 | logic | 1 | 1 |
| round1-02-audit-slice-05-data-consistency.md | slice-05 | data-consistency | 1 | 1 |
| round1-02-audit-slice-08-error-handling.md | slice-08 | error-handling | 1 | 2 |
| round1-02-audit-slice-10-error-handling.md | undefined | error-handling | 3 | 3 |
| round1-02-audit-slice-11-data-consistency.md | slice-11 | data-consistency | 5 | 5 |
| round1-02-audit-slice-13-contract.md | undefined | contract | 2 | 2 |
| round1-02-audit-slice-15-concurrency.md | slice-15 | concurrency | 3 | 3 |
| round1-02-audit-slice-16-error-handling.md | slice-16 | error-handling | 3 | 3 |
| round1-02-audit-slice-20-concurrency.md | undefined | concurrency | 2 | 3 |
| round1-02-audit-slice-20-security.md | slice-20 | security | 2 | 2 |
| round1-02-audit-slice-21-concurrency.md | slice-21 | concurrency | 1 | 2 |
| round1-02-audit-slice-22-data-consistency.md | slice-22 | data-consistency | 2 | 2 |
| round1-02-audit-slice-24-data-consistency.md | slice-24 | data-consistency | 3 | 4 |
| round1-02-audit-slice-26-data-consistency.md | slice-26 | data-consistency | 3 | 3 |