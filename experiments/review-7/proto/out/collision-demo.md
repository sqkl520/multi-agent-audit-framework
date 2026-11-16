# identity-collision demos (real files, in-memory edits)

## D1 — delete an entire @Test whose assertThrows subjects also occur in another @Test
applied: true
expectation: rule 1 should fire, masked by duplicate subject
findings: 5 -> assertion_target_dropped size(previous.getItems()); assertion_target_dropped directFailure.getMessage(); assertion_target_dropped directFailure.getMessage().contains("shop.yml"); assertion_target_dropped directFailure.getMessage().contains("shop.items"); assertion_target_dropped size(shop.getShopConfig().getItems())
throws-subjects before: ["throws:loader::load","throws:shop::reload"]
throws-subjects after : ["throws:loader::load","throws:shop::reload"]
  size(previous.getItems()): ["1"] -> undefined
  directFailure.getMessage(): ["notnull"] -> undefined
  directFailure.getMessage().contains("shop.yml"): ["true"] -> undefined
  directFailure.getMessage().contains("shop.items"): ["true"] -> undefined
  size(shop.getShopConfig().getItems()): ["1"] -> undefined

## D2 — change one assertThrows expected class IllegalStateException -> IllegalArgumentException
applied: true
expectation: reversed should fire on the SAME subject
findings: 1 -> assertion_reversed_unreported throws:loader::load
throws-subjects before: ["throws:loader::load","throws:shop::reload"]
throws-subjects after : ["throws:loader::load","throws:shop::reload"]
  throws:loader::load: ["IllegalStateException.class","IllegalStateException.class"] -> ["IllegalStateException.class","IllegalArgumentException.class"]

## D3 — assertThrows(..., shop::reload) -> assertThrows(..., () -> {}) — the executable changed
applied: true
expectation: rule 1/2 should fire
findings: 1 -> assertion_moved_out_of_method throws:shop::reload
throws-subjects before: ["throws:loader::load","throws:shop::reload"]
throws-subjects after : ["throws:loader::load","throws:{}","throws:shop::reload"]
  throws:shop::reload: ["IllegalStateException.class","IllegalStateException.class"] -> ["IllegalStateException.class"]