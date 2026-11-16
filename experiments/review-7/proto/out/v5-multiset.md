# v5 (multiset) — does counting assertions per method raise recall?

real change set, findings: V4=2, V5=2

  TabListManagerTest.java
    [FAIL] assertion_reversed_unreported field("scheduledPeriod") @refreshFailureIsContained 
    [FAIL] assertion_reversed_unreported field("refreshTask") @refreshFailureIsContained 


leave-one-method-out: 38 methods
  V4 caught: 21 (55.3%)
  V5 caught: 23 (60.5%)
  additionally caught by V5: 2
    + ExplodeBeetleGoalTest.java :: doesNotSelfDestructBeforeGracePeriodElapses
    + ExplodeBeetleGoalTest.java :: doesNotSelfDestructWhenNodeTargetExists