# mutation sensitivity of the hybrid detector

| # | mutation | should catch | caught | verdict |
|---|---|---|---|---|
| M1 | flip expected value in place | true | true | correct |
| M2 | negate a boolean assertion in place | true | true | correct |
| M3 | delete one assertion from a method that asserts the same subject twice | false | false | correct |
| M4 | rename method AND flip its expected value | true | false | MISS |
| M5 | broaden equals -> assertTrue(expr) | true | false | MISS |
| M6 | move assertion into a private helper (same file) | false | false | correct |
| M7 | drop an assertion line entirely (unique subject) | true | false | MISS |
| M8 | delete an entire @Test method | true | false | MISS |


## M1 flip expected value in place
file: src/test/java/com/hilltopvillage/mechanics/TabListManagerTest.java
why: assertEquals(20, field("scheduledPeriod")) -> 60 in the same method
caught with HEAD baseline : true
caught with no baseline   : false
   reversed field("scheduledPeriod") ["exact(20)"] -> ["exact(60)"]
   reversed field("scheduledPeriod") ["negative(-1)"] -> ["exact(20)"]
   reversed field("refreshTask") ["negative(null)"] -> ["exact(before)"]

## M2 negate a boolean assertion in place
file: src/test/java/com/hilltopvillage/ai/ExplodeBeetleGoalTest.java
why: assertTrue(...) -> assertFalse(...) for a subject pinned only in that method
caught with HEAD baseline : true
caught with no baseline   : false
   reversed goal.shouldStayActive() ["existence_only(true)"] -> ["negative(false)"]

## M3 delete one assertion from a method that asserts the same subject twice
file: src/test/java/com/hilltopvillage/shop/ShopConfigLoaderTest.java
why: drop one of two assertEquals(1, config.getItems().size()) in the same method
caught with HEAD baseline : false
caught with no baseline   : false

## M4 rename method AND flip its expected value
file: src/test/java/com/hilltopvillage/shop/ShopConfigLoaderTest.java
why: the exact "rename + reverse" combination: method scope loses the pair, file scope sees the subject elsewhere
caught with HEAD baseline : false
caught with no baseline   : false

## M5 broaden equals -> assertTrue(expr)
file: src/test/java/com/hilltopvillage/config/ConfigManagerTest.java
why: assertEquals(7, config.getActiveConfig().getVictoryWaves()) -> assertTrue(config.getActiveConfig().getVictoryWaves() > 0)
caught with HEAD baseline : false
caught with no baseline   : false

## M6 move assertion into a private helper (same file)
file: src/test/java/com/hilltopvillage/config/ConfigManagerTest.java
why: the plan says moving into a helper counts as "still there" — verify that is true
caught with HEAD baseline : false
caught with no baseline   : false

## M7 drop an assertion line entirely (unique subject)
file: src/test/java/com/hilltopvillage/config/ConfigManagerTest.java
why: delete one assertFalse(config.getSettingsGate().isReadOnly(), ...) where the file has both polarities
caught with HEAD baseline : false
caught with no baseline   : false

## M8 delete an entire @Test method
file: src/test/java/com/hilltopvillage/ai/AirdropSpawnGoalTest.java
why: the most common real weakening: remove the test that would fail
caught with HEAD baseline : false
caught with no baseline   : false

## totals: 2/8 reported; 4 MISS; 0 false positive