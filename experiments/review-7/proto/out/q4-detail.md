# Q4 — predicate_class, measured

## class distribution and a sample of each

### exact  (1131 assertions, 42.3%)
  ArenaAdminServiceTest.java:138  service.spawnPoints("ghost")  -> exact(List.of())
  ArenaAdminServiceTest.java:139  service.mobSpawnPoints("ghost")  -> exact(List.of())
  ArenaAdminServiceTest.java:140  service.villagers("ghost")  -> exact(List.of())
  ArenaAdminServiceTest.java:141  service.nodes("ghost")  -> exact(List.of())

### existence_only  (810 assertions, 30.3%)
  ArenaAdminServiceTest.java:150  service.describe("ARENA1")  -> existence_only(notnull)
  ArenaAdminServiceTest.java:161  view  -> existence_only(notnull)
  ArenaAdminServiceTest.java:185  deployed.hasCore()  -> existence_only(true)
  ArenaAdminServiceTest.java:186  deployed.configuredEnabled()  -> existence_only(true)

### negative  (467 assertions, 17.5%)
  ArenaAdminServiceTest.java:137  service.describe("ghost")  -> negative(null)
  ArenaAdminServiceTest.java:142  service.shopNpc("ghost")  -> negative(null)
  ArenaAdminServiceTest.java:187  deployed.hasInstance()  -> negative(false)
  ArenaAdminServiceTest.java:190  bare.hasCore()  -> negative(false)

### zero_or_empty  (192 assertions, 7.2%)
  ArenaAdminServiceTest.java:229  view.spawnCount()  -> zero_or_empty(0)
  ArenaAdminServiceTest.java:248  view.spawnCount()  -> zero_or_empty(0)
  ArenaResetServiceTest.java:289  got.get(0).blocksPendingBefore()  -> zero_or_empty(0)
  LocationParticlePreviewTest.java:207  size(spawns)  -> zero_or_empty(0)

### interaction  (48 assertions, 1.8%)
  ArenaAdminServiceTest.java:340  verify(definitions,never())  -> interaction(called)
  ArenaAdminServiceTest.java:369  verify(multi)  -> interaction(called)
  ArenaAdminServiceTest.java:382  verify(live)  -> interaction(called)
  ArenaResetNodeRollbackTest.java:135  verify(multi)  -> interaction(called)

### non_empty  (21 assertions, 0.8%)
  LocationParticlePreviewTest.java:189  size(spawns)  -> non_empty(>0)
  LocationParticlePreviewTest.java:240  size(spawns)  -> non_empty(>0)
  LocationParticlePreviewTest.java:260  size(spawns)  -> non_empty(>0)
  LocationParticlePreviewTest.java:283  size(spawns)  -> non_empty(>0)

### exact_existence  (2 assertions, 0.1%)
  WaveMenusLeftWhitelistTest.java:349  holder  -> exact_existence(WaveSettingsMenu.WaveDetailMenu.class)
  TestInfrastructureProbeTest.java:199  world  -> exact_existence(WorldMock.class)

## hardest class: existence_only
total: 810 (30.3% of all assertions)
shapes that all collapse into it:
  method-call          220
  literal-laden        184
  other                177
  bare-identifier      139
  comparison           77
  boolean-combinator   13

representative expressions it swallows:
  aliceSpawns>=54
  bobSpawns>=54
  singleShowCount>0
  spawns.stream().allMatch(spawn->spawn.worldName().equals("hilltop_arena1"))
  spawns.stream().noneMatch(spawn->spawn.x()<15)
  spawns.stream().allMatch(spawn->spawn.x()>=19.0&&spawn.x()<=22.0)
  spawns.stream().allMatch(spawn->spawn.x()<70)
  kind.spiralDust().getSize()>kind.beamDust().getSize()
  start>=0
  spawns.stream().allMatch(spawn->spawn.count()==1)

## class flips across HEAD->work (class changed, value set otherwise stable)
count: 2
  ConfigManagerTest.java :: config.getSettingsGate().isReadOnly()  existence_only -> existence_only/negative  (true -> true,false,true,true)
  TabListManagerTest.java :: field("refreshTask")  negative/existence_only -> negative/existence_only/exact  (null,null,notnull,null,null,null,null,notnull -> null,null,notnull,before,first,null,null,null,notnull)

## "-1 as negative" — how many assertions depend on that reading
count: 5
  DefaultWaveAlignmentTest.java:105  countOf(defaultWave,"flying-dropper") = -1
  DefaultWaveAlignmentTest.java:313  countOf(defaultWave,"arrow") = -1
  LobbyProtectionListenerTest.java:560  player.getLocation().getY() = -1
  TabListManagerTest.java:226  field("scheduledPeriod") = -1
  TabListManagerTest.java:618  field("scheduledPeriod") = -1