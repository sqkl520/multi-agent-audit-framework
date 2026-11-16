# Q1 — parse quality + baseline cross-check

## baseline cross-check (git diff -U0 on the frozen snapshot)
deleted assert lines: 3
  TabListManagerTest.java: assertNull(field("refreshTask"),
  TabListManagerTest.java: assertEquals(-1, field("scheduledPeriod"), "异常路径必须把周期归 -1，让下一帧重新排期");
  ShopConfigLoaderTest.java: assertEquals(1, config.getItems().get(0).getPrice());
added assert lines  : 58

## parse census over the 27 changed files, both sides
file-sides parsed          : 61
physical assert lines      : 867
assert call sites          : 877
subjects produced          : 876
rejected (unparsable)      : 0  (0.00% of call sites)
assertAll containers       : 1 (recursed into, not counted)

### subject shapes
  dottedPath       373  42.6%
  literalCoupled   187  21.3%
  sizeForm         110  12.6%
  bareIdentifier   87  9.9%
  compositeExpr    81  9.2%
  throws           22  2.5%
  mockitoVerify    16  1.8%

### rejected (unparsable) forms, grouped

### representative rejected samples

## subject collisions (same file+subject pinned to >1 value)
file-subject pairs with >1 signature: 93
distinct colliding subjects         : 56
  ExplodeBeetleGoalTest.java :: goal.shouldActivate()
      existence_only(true)  negative(false)
  ExplodeBeetleGoalTest.java :: goal.shouldStayActive()
      existence_only(true)  negative(false)
  ExplodeBeetleGoalTest.java :: power.getValue()
      exact(3.0f±1e-6)  exact(0.0f±1e-6)
  ExplodeBeetleGoalTest.java :: goal.shouldActivate()
      existence_only(true)  negative(false)
  ExplodeBeetleGoalTest.java :: goal.shouldStayActive()
      existence_only(true)  negative(false)
  ConfigManagerTest.java :: config.hasUnsavedChanges()
      existence_only(true)  negative(false)
  ConfigManagerTest.java :: config.saveToFile()
      existence_only(true)  negative(false)
  ConfigManagerTest.java :: config.getActiveConfig().getMinPlayers()
      exact(nonDefault)  exact(defaultValue)
  ConfigManagerTest.java :: wavesSection(settingsFile(host)).getConfigurationSection("42")
      existence_only(notnull)  negative(null)
  ConfigManagerTest.java :: logs.anyContains("unrecognized entries under waves")
      existence_only(true)  negative(false)
  ConfigManagerTest.java :: logs.anyContains("unrecognized top-level keys")
      existence_only(true)  negative(false)
  ConfigManagerTest.java :: config.getActiveConfig().getWaveTimeoutSeconds()
      zero_or_empty(0)  exact(121)
  ConfigManagerTest.java :: config.hasUnsavedChanges()
      existence_only(true)  negative(false)
  ConfigManagerTest.java :: config.saveToFile()
      existence_only(true)  negative(false)
  ConfigManagerTest.java :: config.getSettingsGate().isReadOnly()
      existence_only(true)  negative(false)
  ConfigManagerTest.java :: config.getActiveConfig().getMinPlayers()
      exact(nonDefault)  exact(defaultValue)
  ConfigManagerTest.java :: wavesSection(settingsFile(host)).getConfigurationSection("42")
      existence_only(notnull)  negative(null)
  ConfigManagerTest.java :: config.loadFromFile()
      existence_only(true)  negative(false)
  ConfigManagerTest.java :: logs.anyContains("unrecognized entries under waves")
      existence_only(true)  negative(false)
  ConfigManagerTest.java :: logs.anyContains("unrecognized top-level keys")
      existence_only(true)  negative(false)

### top bare-identifier subjects (generic names => cross-method collisions)
  probe: 9
  got: 7
  arena: 7
  arenaWorld: 5
  afterRestart: 4
  found: 3
  afterAtCap: 2
  saved: 2
  reloaded: 2
  wave42: 2
  original: 2
  second: 2
  replaced: 2
  firstName: 2
  firstOrder: 2
  bow: 2
  sword: 2
  world: 2
  shop: 2
  paidBefore: 2