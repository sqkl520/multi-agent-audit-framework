# parse census (whole src/test tree)
files: 98
physical assert lines: 2638
assert call sites    : 2744
parsed               : 2670 (97.85 of call sites)
unparsable           : 59 (2.15%)
assertAll containers : 15 (recursed into, not counted as subjects)

## subject shape buckets
  dottedPath         1322  (49.5%)
  literalCoupled     519  (19.4%)
  compositeExpr      301  (11.3%)
  bareIdentifier     246  (9.2%)
  sizeForm           234  (8.8%)
  interaction        48  (1.8%)

## top bare-identifier subjects (collision risk)
  got: 18
  probe: 10
  world: 9
  reason: 7
  after: 7
  out: 7
  arena: 7
  second: 6
  before: 5
  delivered: 5
  total: 4
  arenaWorld: 4
  in: 3
  ending: 3
  wave7: 3
  wave1: 3
  restored: 3
  host: 3
  found: 3
  arena1: 2
  already: 2
  saved: 2
  reloaded: 2
  defaultWave: 2
  snapshot: 2

## files with unparsable assertions: 9

### src/test/java/com/hilltopvillage/config/WavesKeySetAlignmentTest.java
  L94 fail: fail() is not a subject assertion :: fail("waves.1 根本没进内存表（当前键集 " + waves.keySet() + "）。" + " 若这里红而 getWaveConfig(1) 看起来「有值」，那是回落到了 defau

### src/test/java/com/hilltopvillage/config/menu/ConfigMenuLeftWhitelistTest.java
  L84 assertOnlyLeftIncrements: unknown assertion helper: assertOnlyLeftIncrements :: assertOnlyLeftIncrements(AbstractConfigMenu menu, int slot, int before, int step, 
  L156 assertOnlyLeftIncrements: unknown assertion helper: assertOnlyLeftIncrements :: assertOnlyLeftIncrements(menu, 10, 5, 1, "GameRulesMenu[min-players]")
  L194 assertOnlyLeftIncrements: unknown assertion helper: assertOnlyLeftIncrements :: assertOnlyLeftIncrements(menu, 19, 600, 20, "ItemSettingsMenu[smash-timeout]")
  L228 assertOnlyLeftIncrements: unknown assertion helper: assertOnlyLeftIncrements :: assertOnlyLeftIncrements(menu, 10, 500, 50, "NodeSettingsMenu[base-health]")
  L257 assertOnlyLeftIncrements: unknown assertion helper: assertOnlyLeftIncrements :: assertOnlyLeftIncrements(menu, 19, 40, 10, "MonsterSettingsMenu[health]")

### src/test/java/com/hilltopvillage/config/menu/MonsterPropMenuLeftWhitelistTest.java
  L113 assertNonWhitelistClicksAreInert: unknown assertion helper: assertNonWhitelistClicksAreInert :: assertNonWhitelistClicksAreInert(AbstractConfigMenu menu, int slot, D
  L148 assertNonWhitelistClicksAreInert: unknown assertion helper: assertNonWhitelistClicksAreInert :: assertNonWhitelistClicksAreInert(menu, slot, () -> monster("explode-beetle").getExplodeDamageMultipl
  L173 assertNonWhitelistClicksAreInert: unknown assertion helper: assertNonWhitelistClicksAreInert :: assertNonWhitelistClicksAreInert(menu, 19, () -> monster("explode-beetle").getHealth(), 
  L197 assertNonWhitelistClicksAreInert: unknown assertion helper: assertNonWhitelistClicksAreInert :: assertNonWhitelistClicksAreInert(menu, slot, () -> monster("hook-claw-hunter").getCooldownTicks(), 

### src/test/java/com/hilltopvillage/config/menu/WaveMenusLeftWhitelistTest.java
  L349 assertInstanceOf: unknown assertion helper: assertInstanceOf :: assertInstanceOf(WaveSettingsMenu.WaveDetailMenu.class, holder, "对照半：LEFT 仍然打开波次详情菜单。若这条也红，说明分支被整段删除

### src/test/java/com/hilltopvillage/config/menu/WavePaginationClampTest.java
  L122 assertWaveRowsRendered: unknown assertion helper: assertWaveRowsRendered :: assertWaveRowsRendered(WaveSettingsMenu menu, String when)
  L169 assertWaveRowsRendered: unknown assertion helper: assertWaveRowsRendered :: assertWaveRowsRendered(menu, "末页删波次后重开")
  L208 assertWaveRowsRendered: unknown assertion helper: assertWaveRowsRendered :: assertWaveRowsRendered(menu, "page=7 / 3 个波次")
  L222 assertWaveRowsRendered: unknown assertion helper: assertWaveRowsRendered :: assertWaveRowsRendered(menu, "page=-3 / 3 个波次")

### src/test/java/com/hilltopvillage/mechanics/MapRestoreManagerTest.java
  L347 fail: fail() is not a subject assertion :: fail("世界不存在时不应调用完成回调（那会让调用方以为回滚成功了）")

### src/test/java/com/hilltopvillage/testsupport/TestInfrastructureProbeTest.java
  L199 assertInstanceOf: unknown assertion helper: assertInstanceOf :: assertInstanceOf(WorldMock.class, world, "世界不是 WorldMock：" + name)

### src/test/java/com/hilltopvillage/util/YamlFilesTest.java
  L176 assertFactoryOk: unknown assertion helper: assertFactoryOk :: assertFactoryOk(dir, "/game-settings.yml", YamlFiles.gameSettingsValidator())
  L177 assertFactoryOk: unknown assertion helper: assertFactoryOk :: assertFactoryOk(dir, "/monsters-config.yml", YamlFiles.monstersConfigValidator())
  L178 assertFactoryOk: unknown assertion helper: assertFactoryOk :: assertFactoryOk(dir, "/messages.yml", YamlFiles.messagesValidator())
  L192 assertSuspect: unknown assertion helper: assertSuspect :: assertSuspect(YamlFiles.arenasValidator(), "schema-version: 2\n", "缺 arenas 段")
  L193 assertSuspect: unknown assertion helper: assertSuspect :: assertSuspect(YamlFiles.arenasValidator(), "default-arena: arena1\nlobby:\n world: lobby\narenas: {}\n"
  L195 assertSuspect: unknown assertion helper: assertSuspect :: assertSuspect(YamlFiles.arenasValidator(), "schema-version: 0\n" + REALISTIC_ARENA, "schema-version 存在但 
  L197 assertSuspect: unknown assertion helper: assertSuspect :: assertSuspect(YamlFiles.arenasValidator(), "arenas: []\n", "arenas 不是段")
  L199 assertOk: unknown assertion helper: assertOk :: assertOk(YamlFiles.arenasValidator(), REALISTIC_ARENA)
  L222 assertSuspect: unknown assertion helper: assertSuspect :: assertSuspect(YamlFiles.arenasValidator(), "arenas:\n arena1: {}\n", "竞技场段一个键都没有也是截断形态")
  L226 assertSuspect: unknown assertion helper: assertSuspect :: assertSuspect(YamlFiles.arenasValidator(), "arenas:\n" + " arena1:\n display
  L239 assertOk: unknown assertion helper: assertOk :: assertOk(YamlFiles.arenasValidator(), "arenas:\n arena1:\n world: hilltop_arena1\n", "手写的最小竞技场段是加载器认
  L244 assertOk: unknown assertion helper: assertOk :: assertOk(YamlFiles.arenasValidator(), "arenas:\n arena1:\n world: are\n", "单竞技场裸 world 不再当截断证据")
  L248 assertOk: unknown assertion helper: assertOk :: assertOk(YamlFiles.arenasValidator(), "arenas:\n arena1:\n world: w1\n arena2:\n world: w2\n", 
  L274 assertSuspect: unknown assertion helper: assertSuspect :: assertSuspect(YamlFiles.arenasValidator(), "arenas:\n a:\n enabled: true\n display-name: x\n", 
  L277 assertSuspect: unknown assertion helper: assertSuspect :: assertSuspect(YamlFiles.arenasValidator(), "arenas:\n a:\n world: \" \"\n enabled: true\n", 
  L281 assertOk: unknown assertion helper: assertOk :: assertOk(YamlFiles.arenasValidator(), "arenas:\n stray:\n enabled: false\n arena1:\n display-nam
  L285 assertOk: unknown assertion helper: assertOk :: assertOk(YamlFiles.arenasValidator(), "arenas:\n arena1:\n display-name: x\n enabled: true\n w
  L293 assertSuspect: unknown assertion helper: assertSuspect :: assertSuspect(YamlFiles.nodesValidator(), "other: 1\n")
  L294 assertSuspect: unknown assertion helper: assertSuspect :: assertSuspect(YamlFiles.nodesValidator(), "nodes:\n a: 1\n")
  L295 assertOk: unknown assertion helper: assertOk :: assertOk(YamlFiles.nodesValidator(), "nodes: []\n")
  L296 assertOk: unknown assertion helper: assertOk :: assertOk(YamlFiles.nodesValidator(), "nodes:\n - world: w\n")
  L302 assertSuspect: unknown assertion helper: assertSuspect :: assertSuspect(YamlFiles.gameSettingsValidator(), "world-name: world\nmin-players: 2\n")
  L303 assertOk: unknown assertion helper: assertOk :: assertOk(YamlFiles.gameSettingsValidator(), "world-name: world\nmin-players: 2\nmax-players: 6\n")
  L311 assertSuspect: unknown assertion helper: assertSuspect :: assertSuspect(YamlFiles.monstersConfigValidator(), "schema: 1\n", "顶层全是标量 = 没有怪物段")
  L313 assertSuspect: unknown assertion helper: assertSuspect :: assertSuspect(YamlFiles.monstersConfigValidator(), "# 只剩注释\n", "空文档 = 解析后 0 个段")
  L317 assertSuspect: unknown assertion helper: assertSuspect :: assertSuspect(YamlFiles.monstersConfigValidator(), "beetle:\n healht: 40\n", "唯一子键是拼错的未知键")
  L322 assertOk: unknown assertion helper: assertOk :: assertOk(YamlFiles.monstersConfigValidator(), "beetle:\n main-hand: IRON_SWORD\n", "只写装备键（无 entity-type
  L324 assertOk: unknown assertion helper: assertOk :: assertOk(YamlFiles.monstersConfigValidator(), "beetle:\n base-damage: 4.0\n helmet: IRON_HELMET\n", 
  L328 assertOk: unknown assertion helper: assertOk :: assertOk(YamlFiles.monstersConfigValidator(), "beetle:\n health: 40\n", "health 在文件头的可编辑清单里，不应被当成垃圾")
  L332 assertOk: unknown assertion helper: assertOk :: assertOk(YamlFiles.monstersConfigValidator(), "beetle:\n entity-type: CAVE_SPIDER\n")
  L333 assertOk: unknown assertion helper: assertOk :: assertOk(YamlFiles.monstersConfigValidator(), "beetle:\n entity-type: CAVE_SPIDER\nhunter:\n main-hand
  L342 assertFactoryOk: unknown assertion helper: assertFactoryOk :: assertFactoryOk(dir, "/monsters-config.yml", YamlFiles.monstersConfigValidator())
  L355 assertSuspect: unknown assertion helper: assertSuspect :: assertSuspect(YamlFiles.messagesValidator(), "en:\n a: b\nzh:\n c: d\n")
  L360 assertOk: unknown assertion helper: assertOk :: assertOk(YamlFiles.messagesValidator(), onlyZh.toString(), "只有 zh 也应放行")
  L517 assertFactoryOk: unknown assertion helper: assertFactoryOk :: assertFactoryOk(Path dir, String resource, java.util.function.Function<YamlConfiguration, String> validator)
  L525 assertSuspect: unknown assertion helper: assertSuspect :: assertSuspect(java.util.function.Function<YamlConfiguration, String> validator, String text)
  L526 assertSuspect: unknown assertion helper: assertSuspect :: assertSuspect(validator, text, "")
  L529 assertSuspect: unknown assertion helper: assertSuspect :: assertSuspect(java.util.function.Function<YamlConfiguration, String> validator, String text, 
  L535 assertOk: unknown assertion helper: assertOk :: assertOk(java.util.function.Function<YamlConfiguration, String> validator, String text)
  L536 assertOk: unknown assertion helper: assertOk :: assertOk(validator, text, "")
  L539 assertOk: unknown assertion helper: assertOk :: assertOk(java.util.function.Function<YamlConfiguration, String> validator, String text, 

### src/test/java/com/hilltopvillage/mechanics/ScratchReloadProbeTest.java
  L88 assertTrue: boolean literal as target :: assertTrue(true)