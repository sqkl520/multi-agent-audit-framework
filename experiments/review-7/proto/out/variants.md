# rule variants on the 27 changed test files

## v1: 0 findings across 0 files

  calibration check:
    TabListManagerTest.java field("refreshTask") -> no hit   [legit (reported-ok)]
    TabListManagerTest.java field("scheduledPeriod") -> no hit   [legit (reported-ok)]
    ShopConfigLoaderTest.java config.getItems().get(0).getPrice() -> no hit   [FALSE POSITIVE if flagged]

## v2: 5 findings across 2 files

### src/test/java/com/hilltopvillage/mechanics/TabListManagerTest.java
  - reversed [method] field("scheduledPeriod") @refreshFailureIsContained   <<< CALIBRATION: legit (reported-ok)
      old=["negative(-1)"]
      new=["exact(20)"]
  - reversed [method] field("refreshTask") @refreshFailureIsContained   <<< CALIBRATION: legit (reported-ok)
      old=["negative(null)"]
      new=["exact(before)"]

### src/test/java/com/hilltopvillage/shop/ShopConfigLoaderTest.java
  - moved-or-renamed [soft] size(config.getItems()) @missingIconFallsBackToBarrier
      foundIn=factoryTemplateParsesCleanly
  - moved-or-renamed [soft] config.getItems().get(0).getIcon() @missingIconFallsBackToBarrier
      foundIn=validIconMaterialIsHonored
  - moved-or-renamed [soft] config.getItems().get(0).getPrice() @missingPriceDefaultsToOne   <<< CALIBRATION: FALSE POSITIVE if flagged
      foundIn=negativePriceIsClampedToZero

  calibration check:
    TabListManagerTest.java field("refreshTask") -> reversed   [legit (reported-ok)]
    TabListManagerTest.java field("scheduledPeriod") -> reversed   [legit (reported-ok)]
    ShopConfigLoaderTest.java config.getItems().get(0).getPrice() -> moved-or-renamed   [FALSE POSITIVE if flagged]

## v3: 5 findings across 3 files

### src/test/java/com/hilltopvillage/config/ConfigManagerTest.java
  - reversed [file-multiset] config.getSettingsGate().isReadOnly()
      old=["existence_only(true)"]
      new=["existence_only(true)","existence_only(true)","existence_only(true)","negative(false)"]

### src/test/java/com/hilltopvillage/mechanics/TabListManagerTest.java
  - reversed [file-multiset] field("scheduledPeriod")   <<< CALIBRATION: legit (reported-ok)
      old=["exact(20)","exact(DisplayConfig.DEFAULT_TAB_REFRESH_TICKS)","negative(-1)","negative(-1)","negative(-1)"]
      new=["exact(20)","exact(20)","exact(DisplayConfig.DEFAULT_TAB_REFRESH_TICKS)","negative(-1)","negative(-1)"]
  - reversed [file-multiset] field("refreshTask")   <<< CALIBRATION: legit (reported-ok)
      old=["existence_only(notnull)","existence_only(notnull)","negative(null)","negative(null)","negative(null)","negative(null)","negative(null)","negative(null)"]
      new=["exact(before)","exact(first)","existence_only(notnull)","existence_only(notnull)","negative(null)","negative(null)","negative(null)","negative(null)","negative(null)"]

### src/test/java/com/hilltopvillage/shop/ShopConfigLoaderTest.java
  - reversed [file-multiset] size(config.getItems())
      old=["exact(1)","exact(1)","exact(1)","exact(1)","exact(16)","exact(2)","exact(5)","zero_or_empty(0)","zero_or_empty(0)","zero_or_empty(0)","zero_or_empty(0)","zero_or_empty(0)","zero_or_empty(0)","zero_or_empty(0)"]
      new=["exact(1)","exact(1)","exact(1)","exact(1)","exact(1)","exact(1)","exact(1)","exact(16)","exact(2)","exact(2)","exact(5)","zero_or_empty(0)","zero_or_empty(0)","zero_or_empty(0)","zero_or_empty(0)","zero_or_empty(0)","zero_or_empty(0)","zero_or_empty(0)","zero_or_empty(0)","zero_or_empty(0)","zero_or_empty(0)"]
  - reversed [file-multiset] logs.anyContains("is missing icon.material")
      old=["existence_only(true)"]
      new=["existence_only(true)","existence_only(true)"]

  calibration check:
    TabListManagerTest.java field("refreshTask") -> reversed   [legit (reported-ok)]
    TabListManagerTest.java field("scheduledPeriod") -> reversed   [legit (reported-ok)]
    ShopConfigLoaderTest.java config.getItems().get(0).getPrice() -> no hit   [FALSE POSITIVE if flagged]