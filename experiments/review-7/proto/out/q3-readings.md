# Q2/Q3 — three readings of "predicate_class 变档", all measured

The plan claims sites 1 and 2 will each hit `assertion_reversed_reported`.
That claim is TRUE only under the looser readings. Measured:


## reading: strict  -> 0 findings
  calibration field("refreshTask") : no hit   [legit]
  calibration field("scheduledPeriod") : no hit   [legit]
  calibration config.getItems().get(0).getPrice() : no hit   [FALSE POSITIVE if hit]
  findings NOT on the calibration sites: 0

## reading: classSet  -> 2 findings
  calibration field("refreshTask") : HIT (reversed)   [legit]
  calibration field("scheduledPeriod") : no hit   [legit]
  calibration config.getItems().get(0).getPrice() : no hit   [FALSE POSITIVE if hit]
  findings NOT on the calibration sites: 1
    ConfigManagerTest.java: 1
    - ConfigManagerTest.java :: config.getSettingsGate().isReadOnly()  existence_only -> existence_only/negative

## reading: widening  -> 0 findings
  calibration field("refreshTask") : no hit   [legit]
  calibration field("scheduledPeriod") : no hit   [legit]
  calibration config.getItems().get(0).getPrice() : no hit   [FALSE POSITIVE if hit]
  findings NOT on the calibration sites: 0