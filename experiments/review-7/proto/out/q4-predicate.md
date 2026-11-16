# Q4 — predicate_class feasibility

## class distribution (both sides, all changed files)
  exact              359
  existence_only     280
  negative           153
  zero_or_empty      61
  interaction        16
  non_empty          7

subjects carrying >1 class in the same file: 34 of 330

## the five plan classes vs what the code actually needed
  exact(n)          -> produced, dominant
  zero_or_empty     -> produced from 0 / isEmpty() / size()==0
  negative          -> produced from assertNull/assertFalse/assertNotEquals/-1
  existence_only    -> produced 208 times from assertTrue(expr)
  broadened         -> 22 assertions carry an operator inside assertTrue(...)
   ...plus two classes the plan does not name and which the data forces:
  truthy/non_empty  -> produced from assertFalse(isEmpty()) / assertTrue(size()>0)
  interaction       -> produced from Mockito verify(...)  (48 occurrences tree-wide)

## canonicalization hazards (plan says size(X) is a safe normalization)
  subjects of the form size(...): 28
  same size() subject reached from BOTH size() and isEmpty()/assertTrue: 0

### assertions whose SUBJECT contains a comparison operator (NOT normalized by the plan)
10 occurrences; these never merge with the equivalent assertEquals form:
  AirdropSpawnGoalTest.java:155  afterBelowCap>0  existence_only(true)
  AirdropSpawnGoalTest.java:155  afterBelowCap>0  existence_only(true)
  AirdropSpawnGoalTest.java:290  i>0  existence_only(true)
  TabListManagerTest.java:440  spectator>=0  existence_only(true)
  TabListManagerTest.java:483  spectator>=0  existence_only(true)
  ShopOverflowPaidDropTest.java:224  oversized-bow.getPrice()>64  existence_only(true)
  ShopOverflowPaidDropTest.java:230  oversized-bow.getPrice()>64  existence_only(true)
  CommandsDocumentAtomicWriteTest.java:165  start>=0  existence_only(true)
  CommandsDocumentationCleanupClaimTest.java:64  file.isFile()&&file.length()>0  existence_only(true)
  ShopPaidDropMergeTest.java:433  plain.getPickupDelay()<32767  existence_only(true)