# hybrid detector (drop=file scope, reversal=method scope) on all 27 changed test files
files: 43
findings: 2  {"assertion_reversed_unreported":2}


## src/test/java/com/hilltopvillage/mechanics/TabListManagerTest.java
  - [FAIL] assertion_reversed_unreported
    subject : field("scheduledPeriod")
    method  : refreshFailureIsContained
    old     : negative(-1) @L341
    new     : exact(20) @L361
    lost    : negative(-1)   gained: exact(20)
  - [FAIL] assertion_reversed_unreported
    subject : field("refreshTask")
    method  : refreshFailureIsContained
    old     : negative(null) @L338
    new     : exact(before) @L358
    lost    : negative(null)   gained: exact(before)