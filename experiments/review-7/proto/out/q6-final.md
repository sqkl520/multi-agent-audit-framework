# Q6 — final: can anything catch F1 ("only the easiest form passes")?


## Q6-a — append the F1 test to an existing NEW file (no HEAD blob)
file: ShopConfigCorruptFileTest.java   assertions 16 -> 17   subjects 12 -> 12
reported: false
  NO FINDINGS

## Q6-b — append the F1 test AND delete nothing (control: is a pure +addition ever visible?)
file: ShopConfigCorruptFileTest.java   assertions 16 -> 17   subjects 12 -> 12
reported: false
  NO FINDINGS

## Q6-c — the same F1 text appended to a file that DOES have a HEAD blob (ConfigManagerTest)
file: ConfigManagerTest.java   assertions 52 -> 53   subjects 25 -> 25
reported: false
  NO FINDINGS

## corpus evidence for the F1 property itself
tests that iterate over cut points (substring(0, cut/i/len/idx)): 0
references to the single TRUNCATED_AT_ITEMS fixture in ShopConfigCorruptFileTest: 2
The gate has no access to "how many truncation points exist", so it cannot compare 1 against 192.