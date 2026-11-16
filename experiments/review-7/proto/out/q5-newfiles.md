# Q5 — the 19 new test files

new test files: 19
assertions in them: 271
distinct subjects in them: 170
files with ZERO assertions: 2
  - AirdropMobTypeNpeReachabilityTest.java
  - YamlNullMechanismTest.java

## what the detector reports on each new file (old side = empty)
files with >=1 finding: 0 of 19
  ArenaResetNodeRollbackTest.java                findings=0  (subjects=11)
  AirdropMobTypeNpeReachabilityTest.java         findings=0  (subjects=0)
  HilltopCommandReloadResultTest.java            findings=0  (subjects=5)
  AirdropMobTypeNullabilityTest.java             findings=0  (subjects=3)
  ConfigLoadClampTest.java                       findings=0  (subjects=12)
  YamlNullMechanismTest.java                     findings=0  (subjects=0)
  MainConfigMenuReloadResultTest.java            findings=0  (subjects=7)
  CommandsDocumentAtomicWriteTest.java           findings=0  (subjects=19)
  CommandsDocumentConcurrencyTest.java           findings=0  (subjects=7)
  CommandsDocumentFallbackTest.java              findings=0  (subjects=22)
  CommandsDocumentationCleanupClaimTest.java     findings=0  (subjects=3)
  RepairSettlementTest.java                      findings=0  (subjects=5)
  ShopConfigAmountValidationTest.java            findings=0  (subjects=11)
  ShopConfigCorruptFileTest.java                 findings=0  (subjects=12)
  ShopConfigMaterialValidationTest.java          findings=0  (subjects=6)
  ShopConfigPriceValidationTest.java             findings=0  (subjects=7)
  ShopConfigQuarantineRebuildTest.java           findings=0  (subjects=18)
  ShopListenerPurchaseMessageTest.java           findings=0  (subjects=6)
  ShopPaidDropMergeTest.java                     findings=0  (subjects=16)

## cross-file subject overlap (new file subject also present in a modified file)
pairs: 25
  AirdropMobTypeNullabilityTest.java :: got  also in AirdropSpawnGoalTest.java
  ConfigLoadClampTest.java :: config.getActiveConfig().getVictoryWaves()  also in ConfigManagerTest.java
  ConfigLoadClampTest.java :: config.hasUnsavedChanges()  also in ConfigManagerTest.java
  ConfigLoadClampTest.java :: config.saveToFile()  also in ConfigManagerTest.java
  MainConfigMenuReloadResultTest.java :: config.getActiveConfig().getVictoryWaves()  also in ConfigManagerTest.java
  MainConfigMenuReloadResultTest.java :: config.getSettingsGate().isReadOnly()  also in ConfigManagerTest.java
  ShopConfigAmountValidationTest.java :: logs.anyContains("invalid amount 0")  also in ShopConfigLoaderTest.java
  ShopConfigAmountValidationTest.java :: logs.anyContains("invalid amount")  also in ShopConfigLoaderTest.java
  ShopConfigPriceValidationTest.java :: logs.anyContains("missing price")  also in ShopConfigLoaderTest.java
  ShopConfigPriceValidationTest.java :: logs.anyContains("defaulting to 1")  also in ShopConfigLoaderTest.java
  ShopConfigPriceValidationTest.java :: logs.anyContains("negative price")  also in ShopConfigLoaderTest.java
  ShopConfigPriceValidationTest.java :: logs.anyContains("negative price -5")  also in ShopConfigLoaderTest.java
  ShopConfigQuarantineRebuildTest.java :: config.getCurrencyMaterial()  also in ShopConfigLoaderTest.java
  ShopConfigQuarantineRebuildTest.java :: config.getGuiSize()  also in ShopConfigLoaderTest.java
  ShopConfigQuarantineRebuildTest.java :: size(config.getItems())  also in ShopConfigLoaderTest.java

## the "move a weakened assertion into a new file" scenario
deleted strong assertion from ShopConfigLoaderTest.java:
  assertEquals(1, config.getItems().get(0).getPrice(),
                    "缺键时 price 必须取既有默认值 1");
findings on that file: 0
  (the new file that now holds the weakened version contributes nothing: no HEAD blob)