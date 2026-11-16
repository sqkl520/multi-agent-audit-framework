# mode A prototype run
repo: <TARGET_REPO>
ref : HEAD

changed test files : 27 (modified 7 / added 20)
physical assert lines: old 272 -> new 593
assert call sites    : old 274 -> new 603
parsed subjects      : old 274 -> new 602
unparsable           : old 0 -> new 0

## findings (0)

## per-file

### src/test/java/com/hilltopvillage/ai/AirdropSpawnGoalTest.java  (M)
  old: phys=16 calls=17 parsed=17 unparsable=0 subjects=11
  new: phys=22 calls=25 parsed=25 unparsable=0 subjects=19

### src/test/java/com/hilltopvillage/ai/ExplodeBeetleGoalTest.java  (M)
  old: phys=15 calls=16 parsed=16 unparsable=0 subjects=9
  new: phys=21 calls=22 parsed=22 unparsable=0 subjects=12

### src/test/java/com/hilltopvillage/config/ConfigManagerTest.java  (M)
  old: phys=39 calls=39 parsed=39 unparsable=0 subjects=21
  new: phys=52 calls=52 parsed=52 unparsable=0 subjects=25

### src/test/java/com/hilltopvillage/mechanics/TabListManagerTest.java  (M)
  old: phys=65 calls=65 parsed=65 unparsable=0 subjects=38
  new: phys=70 calls=70 parsed=70 unparsable=0 subjects=42

### src/test/java/com/hilltopvillage/shop/ShopConfigLoaderTest.java  (M)
  old: phys=72 calls=72 parsed=72 unparsable=0 subjects=46
  new: phys=97 calls=97 parsed=97 unparsable=0 subjects=57

### src/test/java/com/hilltopvillage/shop/ShopOverflowPaidDropTest.java  (M)
  old: phys=31 calls=31 parsed=31 unparsable=0 subjects=26
  new: phys=31 calls=31 parsed=31 unparsable=0 subjects=26

### src/test/java/com/hilltopvillage/shop/ShopOverflowPartialFitTest.java  (M)
  old: phys=34 calls=34 parsed=34 unparsable=0 subjects=23
  new: phys=34 calls=34 parsed=34 unparsable=0 subjects=23

### src/test/java/com/hilltopvillage/admin/ArenaResetNodeRollbackTest.java  (A)
  old: phys=- calls=- parsed=- unparsable=- subjects=-
  new: phys=14 calls=14 parsed=14 unparsable=0 subjects=11

### src/test/java/com/hilltopvillage/ai/AirdropMobTypeNpeReachabilityTest.java  (A)
  old: phys=- calls=- parsed=- unparsable=- subjects=-
  new: phys=0 calls=0 parsed=0 unparsable=0 subjects=0

### src/test/java/com/hilltopvillage/command/HilltopCommandReloadResultTest.java  (A)
  old: phys=- calls=- parsed=- unparsable=- subjects=-
  new: phys=7 calls=7 parsed=7 unparsable=0 subjects=5

### src/test/java/com/hilltopvillage/config/AirdropMobTypeNullabilityTest.java  (A)
  old: phys=- calls=- parsed=- unparsable=- subjects=-
  new: phys=7 calls=9 parsed=9 unparsable=0 subjects=3

### src/test/java/com/hilltopvillage/config/ConfigLoadClampTest.java  (A)
  old: phys=- calls=- parsed=- unparsable=- subjects=-
  new: phys=23 calls=23 parsed=23 unparsable=0 subjects=12

### src/test/java/com/hilltopvillage/config/YamlNullMechanismTest.java  (A)
  old: phys=- calls=- parsed=- unparsable=- subjects=-
  new: phys=0 calls=0 parsed=0 unparsable=0 subjects=0

### src/test/java/com/hilltopvillage/config/menu/MainConfigMenuReloadResultTest.java  (A)
  old: phys=- calls=- parsed=- unparsable=- subjects=-
  new: phys=13 calls=13 parsed=13 unparsable=0 subjects=7

### src/test/java/com/hilltopvillage/doc/CommandsDocumentAtomicWriteTest.java  (A)
  old: phys=- calls=- parsed=- unparsable=- subjects=-
  new: phys=22 calls=21 parsed=21 unparsable=0 subjects=19

### src/test/java/com/hilltopvillage/doc/CommandsDocumentConcurrencyTest.java  (A)
  old: phys=- calls=- parsed=- unparsable=- subjects=-
  new: phys=9 calls=7 parsed=7 unparsable=0 subjects=7

### src/test/java/com/hilltopvillage/doc/CommandsDocumentFallbackTest.java  (A)
  old: phys=- calls=- parsed=- unparsable=- subjects=-
  new: phys=22 calls=25 parsed=25 unparsable=0 subjects=22

### src/test/java/com/hilltopvillage/doc/CommandsDocumentationCleanupClaimTest.java  (A)
  old: phys=- calls=- parsed=- unparsable=- subjects=-
  new: phys=3 calls=3 parsed=3 unparsable=0 subjects=3

### src/test/java/com/hilltopvillage/mechanics/RepairSettlementTest.java  (A)
  old: phys=- calls=- parsed=- unparsable=- subjects=-
  new: phys=12 calls=12 parsed=12 unparsable=0 subjects=5

### src/test/java/com/hilltopvillage/mechanics/ScratchReloadProbeTest.java  (A)
  old: phys=- calls=- parsed=- unparsable=- subjects=-
  new: phys=0 calls=0 parsed=0 unparsable=0 subjects=0

### src/test/java/com/hilltopvillage/shop/ShopConfigAmountValidationTest.java  (A)
  old: phys=- calls=- parsed=- unparsable=- subjects=-
  new: phys=21 calls=21 parsed=21 unparsable=0 subjects=11

### src/test/java/com/hilltopvillage/shop/ShopConfigCorruptFileTest.java  (A)
  old: phys=- calls=- parsed=- unparsable=- subjects=-
  new: phys=14 calls=16 parsed=16 unparsable=0 subjects=12

### src/test/java/com/hilltopvillage/shop/ShopConfigMaterialValidationTest.java  (A)
  old: phys=- calls=- parsed=- unparsable=- subjects=-
  new: phys=6 calls=7 parsed=6 unparsable=0 subjects=6

### src/test/java/com/hilltopvillage/shop/ShopConfigPriceValidationTest.java  (A)
  old: phys=- calls=- parsed=- unparsable=- subjects=-
  new: phys=16 calls=16 parsed=16 unparsable=0 subjects=7

### src/test/java/com/hilltopvillage/shop/ShopConfigQuarantineRebuildTest.java  (A)
  old: phys=- calls=- parsed=- unparsable=- subjects=-
  new: phys=48 calls=49 parsed=49 unparsable=0 subjects=18

### src/test/java/com/hilltopvillage/shop/ShopListenerPurchaseMessageTest.java  (A)
  old: phys=- calls=- parsed=- unparsable=- subjects=-
  new: phys=6 calls=6 parsed=6 unparsable=0 subjects=6

### src/test/java/com/hilltopvillage/shop/ShopPaidDropMergeTest.java  (A)
  old: phys=- calls=- parsed=- unparsable=- subjects=-
  new: phys=23 calls=23 parsed=23 unparsable=0 subjects=16