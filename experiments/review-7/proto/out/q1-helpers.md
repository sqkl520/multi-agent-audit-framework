# Q1 — what the "unparsable" bucket really is

Every unparsable call in the tree is either `fail(...)` or a call to a LOCAL helper
(a `private void assertXxx(...)` in the same test class). The plan maps these to
`assertion_unparsable -> WARN` and "strong gate disabled for that file".
The cost of that decision, measured:


## ConfigMenuLeftWhitelistTest.java
  assertOnlyLeftIncrements: called 5x, body contains 4 assertion(s) -> ["menu.clickActions.get(slot)","currentValue(menu,slot)"]

## MonsterPropMenuLeftWhitelistTest.java
  assertNonWhitelistClicksAreInert: called 4x, body contains 2 assertion(s) -> ["menu.clickActions.get(slot)","read.getAsDouble()"]

## WavePaginationClampTest.java
  assertWaveRowsRendered: called 4x, body contains 4 assertion(s) -> ["menu.clickActions.containsKey(slot)","menu.getInventory().getItem(9).getType()","menu.getInventory().getItem(10).getType()","menu.getInventory().getItem(11).getType()"]

## YamlFilesTest.java
  assertFactoryOk: called 5x, body contains 1 assertion(s) -> ["loaded.status()"]
  assertSuspect: called 18x, body contains 0 assertion(s) -> []
  assertOk: called 18x, body contains 0 assertion(s) -> []

helpers called but not defined in the calling file: 0