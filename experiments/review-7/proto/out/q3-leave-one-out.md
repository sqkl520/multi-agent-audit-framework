# Q3 — leave-one-method-out recall (the "delete the failing test" move)

@Test methods examined           : 38
  ...that contain >=1 assertion  : 38
removal reported (any finding)   : 21 (55.3%)
removal reported, assertion-bearing only: 21 / 38 (55.3%)

## per file
  AirdropSpawnGoalTest.java: 2/9 reported
    [miss] zeroMaxPerDropperDisablesAirdrops  (asserts=1)
    [miss] doesNotAirdropWhenMobCapReached  (asserts=1)
    [miss] backsOffWhenNoDropLocationFound  (asserts=3)
    [miss] inactiveWhenGameStopped  (asserts=1)
    [HIT ] shouldStayActiveFalseWithoutTarget  (asserts=1) -> assertion_target_dropped:goal.shouldStayActive()
    [HIT ] goalIdentityContract  (asserts=4) -> assertion_target_dropped:a.getTypes(), assertion_target_dropped:size(a.getTypes()), assertion_target_dropped:a.getKey().getNamespacedKey().toString(), assertion_target_dropped:b.getKey()
    [miss] nullMobTypeFallsBackToZombie  (asserts=1)
    [miss] blankMobTypeFallsBackToZombie  (asserts=2)
    [miss] validAndTypoStillHandled  (asserts=3)
  ExplodeBeetleGoalTest.java: 3/10 reported
    [miss] explosionPowerIsIndependentFromNodeDamageMultiplier  (asserts=3)
    [miss] zeroMultiplierKeepsExplosionPowerless  (asserts=3)
    [miss] staysActiveEvenWithoutAnyNodeTarget  (asserts=2)
    [HIT ] selfDestructsAfterNoTargetGracePeriod  (asserts=2) -> assertion_target_dropped:verify(waveManager,org.mockito.Mockito.atLeastOnce())
    [miss] doesNotSelfDestructBeforeGracePeriodElapses  (asserts=2)
    [miss] doesNotSelfDestructWhenNodeTargetExists  (asserts=2)
    [miss] inactiveWhenGameStopped  (asserts=2)
    [miss] inactiveWhenBeetleInvalid  (asserts=1)
    [HIT ] zeroRadiusSkipsNodeScan  (asserts=1) -> assertion_target_dropped:verify(nodeSystem,never())
    [HIT ] goalIdentityContract  (asserts=4) -> assertion_target_dropped:a.getTypes(), assertion_target_dropped:size(a.getTypes()), assertion_target_dropped:a.getKey().getNamespacedKey().toString(), assertion_target_dropped:b.getKey()
  ConfigManagerTest.java: 2/3 reported
    [HIT ] loadFromFileRebuildsAdminCreatedWaveFromDisk  (asserts=3) -> assertion_target_dropped:reloaded, assertion_target_dropped:reloaded.getTotalMobs()
    [miss] loadFromFileReturnsTrueOnSuccess  (asserts=2)
    [HIT ] shippedTemplateLoadsWithoutUnknownKeyWarnings  (asserts=4) -> assertion_target_dropped:logs.anyContains("unrecognized top-level keys"), assertion_target_dropped:logs.anyContains("victory-wave")
  TabListManagerTest.java: 1/1 reported
    [HIT ] emptyCacheRestoresNothing  (asserts=4) -> assertion_reversed_unreported:field("scheduledPeriod"), assertion_reversed_unreported:field("refreshTask")
  ShopConfigLoaderTest.java: 2/3 reported
    [HIT ] factoryTemplateParsesCleanly  (asserts=16) -> assertion_target_dropped:bow, assertion_target_dropped:bow.getSlot(), assertion_target_dropped:bow.getPrice(), assertion_target_dropped:bow.getType(), assertion_target_dropped:bow.getIcon(), assertion_target_dropped:bow.getAmount(), assertion_target_dropped:bow.isUnbreakable(), assertion_target_dropped:arrow.getAmount(), assertion_target_dropped:sword, assertion_target_dropped:sword.getType(), assertion_target_dropped:sword.getLore(), assertion_target_dropped:size(sword.getLore())
    [HIT ] itemsListIsUnmodifiable  (asserts=1) -> assertion_target_dropped:throws:config.getItems().clear()
    [miss] shopConfigCopiesItemList  (asserts=1)
  ShopOverflowPaidDropTest.java: 6/6 reported
    [HIT ] purchaseOverflowDropsTheProduct  (asserts=5) -> assertion_target_dropped:shop.countCurrency(player), assertion_target_dropped:occupiedSlots(player)
    [HIT ] refundOverflowDropsTheCurrency  (asserts=5) -> assertion_target_dropped:oversized-bow.getPrice()>64, assertion_target_dropped:spied.countCurrency(player)
    [HIT ] noOverflowMeansNoDrop  (asserts=2) -> assertion_target_dropped:size(player.getWorld().getEntitiesByClass(Item.class)), assertion_target_dropped:firstOfType(player,Material.BOW)
    [HIT ] markedDropSurvivesWhileUnmarkedIsRemoved  (asserts=5) -> assertion_target_dropped:size(remaining), assertion_target_dropped:marked.isValid(), assertion_target_dropped:plain.isValid(), assertion_target_dropped:remaining.get(0).getItemStack().getType()
    [HIT ] dropWithSomeOtherPdcKeyIsStillRemoved  (asserts=2) -> assertion_target_dropped:foreign.isValid()
    [HIT ] shopOverflowDropSurvivesArenaReset  (asserts=6) -> assertion_target_dropped:size(before), assertion_target_dropped:paidBefore, assertion_target_dropped:size(after), assertion_target_dropped:after.get(0).getItemStack().getType(), assertion_target_dropped:isPaidDrop(after.get(0)), assertion_target_dropped:junk.isValid()
  ShopOverflowPartialFitTest.java: 5/6 reported
    [HIT ] exactFitIntoHalfFullStackDropsNothing  (asserts=6) -> assertion_target_dropped:arrow.getAmount(), assertion_target_dropped:arrow.getPrice()
    [HIT ] partialFitDropsOnlyTheRemainder  (asserts=7) -> assertion_target_dropped:countInBag(player,Material.ARROW)+remainder.getItemStack().getAmount()
    [HIT ] refundFullyOverflowsInOnePiece  (asserts=5) -> assertion_target_dropped:refund.getItemStack().getType(), assertion_target_dropped:refund.getItemStack().getAmount(), assertion_target_dropped:isPaidDrop(refund)
    [HIT ] refundPartialFitSplitsBetweenBagAndGround  (asserts=6) -> assertion_target_dropped:offhand, assertion_target_dropped:(offhand-60)+remainder.getItemStack().getAmount()
    [miss] whenItFitsNothingDrops  (asserts=3)
    [HIT ] fixtureSanity  (asserts=7) -> assertion_target_dropped:size(player.getInventory().getContents()), assertion_target_dropped:size(player.getInventory().getStorageContents()), assertion_target_dropped:newItemStack(Material.BOW,1).getMaxStackSize(), assertion_target_dropped:newItemStack(Material.ARROW,1).getMaxStackSize(), assertion_target_dropped:newItemStack(Material.EMERALD,1).getMaxStackSize(), assertion_target_dropped:player.getInventory().getItem(40), assertion_target_dropped:player.getInventory().getItem(40).getAmount()