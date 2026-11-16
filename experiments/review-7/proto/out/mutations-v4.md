# mutation sensitivity, v4 detector

| # | mutation | base | expected | actual | verdict |
|---|---|---|---|---|---|
| M1 | value flip, same method | work | undefined | FAIL | correct (weaker severity) |
| M2 | polarity flip on a boolean | work | undefined | FAIL | correct (weaker severity) |
| M3 | remove ONE of two same-subject asserts in a method | head | undefined | WARN | correct (weaker severity) |
| M4 | rename method AND flip value | round2 | undefined | none | MISS |
| M5 | broaden assertEquals -> assertTrue(expr) | round2 | undefined | WARN | correct (weaker severity) |
| M6 | move assertion into a private helper (same file) | round2 | undefined | WARN | correct (weaker severity) |
| M7 | delete one assertion (subject survives elsewhere) | round2 | undefined | WARN | correct (weaker severity) |
| M8 | delete a whole pre-existing @Test method | head | undefined | FAIL | correct (weaker severity) |
| M9 | wrap unique subject in if(true)-style dead branch | head | undefined | none | MISS |


## M1 value flip, same method
TabListManagerTest.java  note: assertEquals(20, field("scheduledPeriod")) -> 60
  [FAIL] assertion_reversed_unreported  field("scheduledPeriod") @cancelledHandleIsReplaced
     lost=["exact(20)"] gained=["exact(60)"]
  [FAIL] assertion_reversed_unreported  field("scheduledPeriod") @refreshFailureIsContained
     lost=["negative(-1)"] gained=["exact(20)"]
  [FAIL] assertion_reversed_unreported  field("refreshTask") @refreshFailureIsContained
     lost=["negative(null)"] gained=["exact(before)"]

## M2 polarity flip on a boolean
ExplodeBeetleGoalTest.java  note: assertTrue(goal.shouldStayActive()) -> assertFalse(...)
  [FAIL] assertion_reversed_unreported  goal.shouldStayActive() @staysActiveEvenWithoutAnyNodeTarget
     lost=["existence_only(true)"] gained=["negative(false)"]

## M3 remove ONE of two same-subject asserts in a method
TabListManagerTest.java  note: not a weakening: a duplicate value remains in the same method
  [WARN] assertion_moved_out_of_method  field("refreshTask") @stopCancelsAndResetsPeriod
     foundIn=disabledTabStopsInsteadOfStarting, nonPositivePeriodFallsBackToDefault, refreshFailureIsContained, restoreClearsCachesAndStops, constructionDoesNotScheduleAnything, applySelfHealsTheTask

## M4 rename method AND flip value
ShopConfigLoaderTest.java  note: the exact rename+reverse combination; HEAD-vs-work rename also means the method disappears
  (no findings)

## M5 broaden assertEquals -> assertTrue(expr)
ConfigManagerTest.java  note: assertEquals(7, X) -> assertTrue(X > 0) — the "broadened" predicate class
  [WARN] assertion_moved_out_of_method  config.getActiveConfig().getVictoryWaves() @loadFromFileReturnsFalseAndKeepsMemoryWhenSettingsUnusable
     foundIn=loadFromFileReturnsFalseWhenFileIsAbsentEvenAfterGateReset

## M6 move assertion into a private helper (same file)
ConfigManagerTest.java  note: plan explicitly wants this to count as "still there"
  [WARN] assertion_moved_out_of_method  config.getActiveConfig().getVictoryWaves() @loadFromFileReturnsFalseAndKeepsMemoryWhenSettingsUnusable
     foundIn=loadFromFileReturnsFalseWhenFileIsAbsentEvenAfterGateReset

## M7 delete one assertion (subject survives elsewhere)
ConfigManagerTest.java  note: the M5-style deletion that hybrid silently swallowed
  [WARN] assertion_moved_out_of_method  config.getSettingsGate().isReadOnly() @loadFromFileReturnsFalseAndKeepsMemoryWhenSettingsUnusable
     foundIn=saveToFileRefusesWhenSettingsUnwritable, loadFromFileReturnsTrueOnSuccess, loadFromFileReturnsFalseWhenGateIsReadOnlyEvenIfFileIsAbsent

## M8 delete a whole pre-existing @Test method
ShopOverflowPaidDropTest.java  note: removes an old test entirely; subjects that survive elsewhere in the file are invisible to rule 1
  [FAIL] assertion_target_dropped  foreign.isValid()

## M9 wrap unique subject in if(true)-style dead branch
ConfigManagerTest.java  note: assertion still textually present, but only runs conditionally — text-level detection cannot see it
  (no findings)