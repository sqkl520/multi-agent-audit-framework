# Q3 recall check — line-level ground truth vs subject-level findings

files with ANY textual assertion change: 5

## AirdropSpawnGoalTest.java  removed=0 added=8
  + assertEquals(org.bukkit.entity.EntityType.ZOMBIE, got, "null 必须回退 ZOMBIE")
  + assertEquals(org.bukkit.entity.EntityType.ZOMBIE, parseMobTypeLikeProduction(" "))
  + assertEquals(org.bukkit.entity.EntityType.ZOMBIE, parseMobTypeLikeProduction("\t\n"))
  + assertEquals(org.bukkit.entity.EntityType.ZOMBIE, parseMobTypeLikeProduction("ZOMBIE"), "合法值必须原样解析")
  + assertEquals(org.bukkit.entity.EntityType.ZOMBIE, parseMobTypeLikeProduction("zombie"), "大小写不敏感")
  + assertEquals(org.bukkit.entity.EntityType.ZOMBIE, parseMobTypeLikeProduction("ZOMBIE_TYPO"), "拼写错误仍由 IAE 分支兜底")
  + assertTrue(i > 0, "源码里应有 mobTypeName")
  + assertTrue( window.contains("mobTypeName == null") || window.contains("mobTypeName.isBlank"), "★ 回归守卫：mobTypeName 的 null/blank 判断被删掉了 —— " + "`airdrop

## ExplodeBeetleGoalTest.java  removed=0 added=6
  + verify(world)
  + verify(world)
  + assertEquals(3.0f, power.getValue(), 1e-6, "★ 节点倍率 10 只该放大 damageNode；createExplosion 的 power 必须是普通苦力怕的 3.0")
  + verify(nodeSystem)
  + verify(nodeSystem)
  + assertEquals(0.0f, power.getValue(), 1e-6, "倍率 0 本来就是「纯节点 0 伤害」；若固定成 3.0 会凭空出现玩家伤害")

## ConfigManagerTest.java  removed=0 added=13
  + assertTrue(config.loadFromFile(), "出厂模板可用时必须返回 true —— 否则修好的服务器会被永久播报「未重载」")
  + assertFalse(config.getSettingsGate().isReadOnly(), "成功读盘后闸门不应处于只读态（OK 会解闩）")
  + assertFalse(config.loadFromFile(), "★ game-settings.yml 不可用时 loadFromFile() 必须返回 false —— " + "void 版本让 GUI 与 /hilltop reloadconfig 都无法区分成功/失败")
  + assertTrue(config.getSettingsGate().isReadOnly(), "前置/结果校验：空文件必须让 settings 闸门锁定只读")
  + assertEquals(7, config.getActiveConfig().getVictoryWaves(), "失败分支的语义是「读不到就不动内存」：拒绝重载后内存值必须保持 7")
  + assertFalse(config.loadFromFile(), "前置条件：空文件必须让第一次 loadFromFile() 返回 false")
  + assertFalse(config.loadFromFile(), "前置条件：空文件必须让第一次 loadFromFile() 返回 false")
  + assertTrue(config.getSettingsGate().isReadOnly(), "前置条件：隔离后闸门必须锁定只读")
  + assertFalse(config.getActiveConfig().getWaves().isEmpty(), "夹具前提：内存在失败后仍保留构造器预置的波次（证明没有走重建）")
  + assertFalse(config.loadFromFile(), "★ 文件不存在但闸门只读时仍必须返回 false；" + "这正是 loadFromFile 里 isReadOnly() 那一半条件的回归网")
  + assertFalse(settingsFile(host).exists(), "前置条件：SUSPECT 文件必须已被隔离（原路径不再存在）")
  + assertFalse(config.loadFromFile(), "★ reset 之后、文件仍缺失时 loadFromFile() 必须返回 false（ABSENT 不等于可重载）")
  + assertEquals(7, config.getActiveConfig().getVictoryWaves(), "★ 文件缺失时内存值必须保持 7；若被空配置重建，这里会变成出厂默认 20")

## TabListManagerTest.java  removed=2 added=7
  - assertNull(field("refreshTask"), "异常路径必须把句柄置空：CraftScheduler 会静默取消抛异常的重复任务，" + "留着旧句柄会让 start() 永远早退（slice-11-concurrency-001 的成因）")
  - assertEquals(-1, field("scheduledPeriod"), "异常路径必须把周期归 -1，让下一帧重新排期")
  + assertNotNull(before, "前置条件：start() 后应有一个任务句柄")
  + assertSame(before, field("refreshTask"), "异常路径不得清空句柄：Paper 的 CraftScheduler 不会取消抛异常的周期任务，" + "清空只会让下一帧 start() 再建一条，与仍然活着的旧任务并行（刷新频率翻倍）")
  + assertEquals(20, field("scheduledPeriod"), "异常路径不得把周期归 -1：否则下一帧 start() 会判定「周期变了」而重建")
  + assertFalse(before.isCancelled(), "任务不应被取消——本 catch 是兜住异常，不是终止任务")
  + assertNotNull(first)
  + assertSame(first, field("refreshTask"), "第 " + (i + 1) + " 次异常后句柄变了 —— 说明产生了第二条任务，旧任务成了孤儿")
  + assertFalse(first.isCancelled(), "十轮异常之后任务仍应活着（由周期驱动自愈）")

## ShopConfigLoaderTest.java  removed=3 added=28
  - assertEquals(1, config.getItems().size(), "非 EQUIPMENT 条目缺图标时只是外观问题，不应整条丢掉")
  - assertEquals(Material.BARRIER, config.getItems().get(0).getIcon(), "缺省图标是 BARRIER（明确可见的「没配好」提示，而不是 AIR 隐形槽位）")
  - assertEquals(1, config.getItems().get(0).getPrice())
  + assertEquals(1, config.getItems().size(), "MATERIAL 缺图标是外观/发货缺陷，不应整条丢掉 —— 丢弃会让 GUI 少一格：" + config.getItems().stream().map(ShopItem::getId).toList())
  + assertEquals(Material.BARRIER, config.getItems().get(0).getIcon(), "缺省图标是 BARRIER（游戏内可见的「这一格没配好」提示，而不是 AIR 隐形槽位）")
  + assertTrue(logs.anyContains("MATERIAL item 'probe'"), "保留必须仍然告警并点名条目：修复缺陷不能以「无声」为代价：" + logs.lines())
  + assertTrue(logs.anyContains("is missing icon.material"), "告警必须说明缺的是 icon.material：" + logs.lines())
  + assertFalse(logs.anyContains("skipped"), "既然保留商品，告警就不能再说 skipped —— 否则服主会去 GUI 里找一件仍在的商品：" + logs.lines())
  + assertEquals(1, config.getItems().size(), "缺 price 仍是合法配置（默认 1），不得整条丢弃：" + config.getItems().stream().map(ShopItem::getId).toList())
  + assertEquals(1, config.getItems().get(0).getPrice(), "缺键时 price 必须取既有默认值 1")
  + assertTrue(logs.anyContains("missing price"), "F3 真正该修的是「服主不知道自己漏写了」—— 保留默认值的同时必须告警：" + logs.lines())
  + assertTrue(logs.anyContains("defaulting to 1"), "告警必须说明实际采用的默认值，否则服主无法判断该不该补 price：" + logs.lines())
  + assertFalse(logs.anyContains("skipped"), "商品被保留，告警就不能说 skipped：" + logs.lines())
  + assertTrue(config.getItems().isEmpty(), "MATERIAL 的发货数量来自 amount，0 会让 deliverItem 钳成 1 却仍按整价扣费 —— " + "必须拒单：" + config.getItems().stream().map(ShopIte
  + assertTrue(logs.anyContains("invalid amount 0"), "拒单必须点名非法值：" + logs.lines())
  + assertTrue(logs.anyContains("invalid amount 0"), "拒单必须点名非法值：" + logs.lines())
  + assertTrue(config.getItems().isEmpty(), "FIREBALL 走 asQuantity(amount)，非正数量必须拒单：" + config.getItems().stream().map(ShopItem::getId).toList())
  + assertTrue(logs.anyContains("invalid amount -3"), "拒单必须点名非法值：" + logs.lines())
  + assertTrue(config.getItems().isEmpty(), "REPAIR_ITEM 走 createRepairItem(amount)，非正数量必须拒单：" + config.getItems().stream().map(ShopItem::getId).toList())
  + assertEquals(1, config.getItems().size(), "ShopManager#deliverItem 对 HAMMER 固定发 1 个、完全忽略 amount，" + "所以 amount: 0 是冗余无害键，不该把商品判成非法：" + config.getItems
  + assertFalse(logs.anyContains("invalid amount"), "HAMMER 不消费 amount，不应报 amount 非法：" + logs.lines())
  + assertEquals(1, config.getItems().size(), "ShopManager#createEquipment 固定 new ItemStack(icon, 1)，amount 不参与发货 —— " + "amount: 0 在 EQUIPMENT 上无害：" + co
  + assertFalse(logs.anyContains("invalid amount"), "EQUIPMENT 不消费 amount，不应报 amount 非法：" + logs.lines())
  + assertEquals(1, config.getItems().get(0).getAmount(), "未写 amount 时取既有默认值 1")
  + assertFalse(logs.anyContains("invalid amount"), "缺键是合法配置，不应报非法：" + logs.lines())
  + assertEquals(2, config.getItems().size(), "两件商品都只有「保留类」问题，必须全部留在商店里：" + config.getItems().stream().map(ShopItem::getId).toList())
  + assertTrue(logs.anyContains("configuration warning(s)"), "加载末尾必须有一行汇总，否则单条 warning 会被启动日志的其他输出淹没：" + logs.lines())
  + assertTrue(logs.anyContains("'no_icon'"), "汇总必须点名缺图标的条目：" + logs.lines())
  + assertTrue(logs.anyContains("'no_price'"), "汇总必须点名缺 price 的条目：" + logs.lines())
  + assertFalse(logs.anyContains("configuration warning(s)"), "完全合法的配置不能报汇总，否则服主会学会忽略这一行：" + logs.lines())
  + assertFalse(logs.anyContains("configuration warning(s)"), "第二次加载已无问题，汇总列表必须在 load() 开头清空：" + logs.lines())

total: removed 5 / added 62

subjects present in HEAD and absent in work (rule 1 candidates): 0