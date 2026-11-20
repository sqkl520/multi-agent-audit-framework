# round1 / slice-24 / data-consistency 审计

- trace_id: `trace-r1-20260215-hilltop-dsh3`
- round_id: `round1`
- slice_id: `slice-24`
- dimension: `data-consistency`
- 被审仓库（只读，零写入）：`D:\Server\MCServers\Server plugin\Hilltop Village\Hilltop Village Plugin`
- 上游线索：`round1-02-sweep-slice-24.md`（L1/L2/L5/L6 属本维度；L3/L4 越维度，转入 `off_dimension_notes`）

## 1. 结论

| 维度 | 数值 |
|---|---|
| CONFIRMED | 3（MEDIUM×2 / LOW×1） |
| EVIDENCE_GAP | 1（L2 写回口径，需服务端实现才能定论） |
| NO_EVIDENCE_FOUND | 0 |
| 晋升 CRITICAL | 0（三条均无法在切片内给出「必抛」的触发条件，按 §3.3 封顶 MEDIUM） |

本切片的一致性风险集中在**两处「先破坏、后重建」的事务边界**（退款补偿、NPC 换生）和**一处 reload 派生状态未刷新**。三处都不是「代码写错一行」，而是**失败面没有收敛点**：一旦第二步失败，第一步已生效且没有回滚/待补偿记录。

## 2. 上游线索逐条处置

| lead | 处置 | 依据 |
|---|---|---|
| L1 退款失败只打日志 | **升级为 CONFIRMED / MEDIUM** → `F-slice-24-dc-01` | `ShopListener.java:186-203`：补偿动作的抛面被 catch 收敛为日志，扣款已生效（`purchase:126` 在前），无重试、无待补偿队列 |
| L2 主背包部分扣减未 setItem 写回 | **EVIDENCE_GAP** → `F-slice-24-dc-04` | 切片内只能看到「主背包依赖引用共享、副手显式写回」的不对称；能否真落盘取决于 `getStorageContents()` 是否返回 NMS 镜像，属服务端实现，不在本仓库 |
| L3 价格无上界 / 超 int 截断翻负 | 越维度（security/economy）→ `off_dimension_notes` | `ShopConfigLoader.java:346-355` |
| L4 price 类型错静默按 1 计价 | 越维度（error-handling）→ `off_dimension_notes` | `ShopConfigLoader.java:305-309` |
| L5 NPC 先删后建、生成失败无回滚 | **升级为 CONFIRMED / MEDIUM** → `F-slice-24-dc-02` | `NpcManager.java:86` 先 `despawnNpc()`，`:92` 才 `spawnEntity`，两者之间无 try/catch、无旧实体恢复 |
| L6 reload 后 NPC 名不一致 | **升级为 CONFIRMED / LOW** → `F-slice-24-dc-03` | `ShopManager.reload()` 成功路径只换 `config` + 关 GUI（`:99-104`）；`resolveNpcName()` 的唯一消费点是 `NpcManager.spawnNpc:102` |

## 3. 发现详情

### F-slice-24-dc-01（MEDIUM）：退款补偿失败后货币不回、且无持久补偿记录

**调用链**：`InventoryClickEvent` → `ShopListener#onInventoryClick`（`ShopListener.java:103`）→ `purchase`（`:126` 先 `removeCurrency`，`:142`/`:147` 触发退款）→ `refundCurrency`（`:186`）→ `catch (RuntimeException)`（`:197`）。

扣款在发货之前，这是刻意的顺序（先扣后发，避免刷货）。发货失败时 `refundCurrency` 用 `addItem(createCurrencyItem(price))` 反向补偿；但补偿动作自身抛异常时，只写一行 SEVERE 日志就返回：

> `ShopListener.java:197-201`：catch 只 `plugin.getLogger().severe(... "manual compensation required" ...)`，没有重试、没有把「待补偿」写进任何持久结构、没有玩家侧提示。

一致性后果：**货币已从背包消失、商品未生成、玩家无任何反馈**，一致性收敛责任被转交给服主读 `latest.log` 人肉对账；日志滚动后连这条线索也消失。

项目自带测试 `ShopListenerTest:333` 的注释直接承认了这一点（「币确实回不来（这是「需要人工补偿」的路径）」），`refundFailureLogsSevere` 也只断言日志文案——**这是被接受的设计降级，不是未察觉的 bug**，所以定 MEDIUM 而非 HIGH；但「无持久记录 + 无重试」的一致性缺口仍然存在。

**可推翻条件**：
1. 若 `HilltopVillagePlugin` 在插件级日志/数据库里另有失败交易落库（需检查 `HilltopVillagePlugin.java` 的日志初始化与任何 `shop_refund` 表），则「无持久记录」不成立。
2. 若 `refundCurrency` 的 `addItem`/`createCurrencyItem` 在服务端实际不可抛（需检查 `CraftInventory#addItem` 与 `ItemStack` 构造的抛面），则该 catch 是死分支。

### F-slice-24-dc-02（MEDIUM）：NPC 换生是「先删后建」，第二步失败即无回滚

**调用链**：`/hilltop shop set`（`HilltopCommandHandler.java:1205`）/ 向导（`SetupWizard.java:1031`、`:1320`）/ 启动恢复（`NpcManager.java:301`）→ `spawnNpc` → `despawnNpc()`（`:86`，旧实体 `remove()` 且 `npc = null`）→ `spawnEntity`（`:92`）→ 赋值 `this.npc`（`:109`）。

`:86` 与 `:92` 之间没有任何 try/catch，也没有保留旧 `Location` 以便重建：只要 `spawnEntity` 抛异常（目标世界在判定后被卸载、区块/实体上限、其它插件的生成拦截），或 `:93` 起的 `setProfession` / `setCustomName` 抛异常，方法就以异常穿出，`npc` 字段保持 `null`。

一致性后果：**磁盘上 `arenas.yml` 的 `shop-npc` 坐标仍在，世界里却没有任何带 `shop-npc` PDC 的实体**（旧实体已被移除、新实体未标记完），商店从世界中消失，直到管理员重跑 `set` 或重启；这段窗口内的 `/hilltop shop reload` 也不会修好它（reload 不重建 NPC，见 F-03）。这是典型的「两阶段无补偿」：删除是已提交的，创建不是。

**可推翻条件**：
1. 若 `World#spawnEntity` 在本插件支持的 Paper 版本上对已加载世界不抛（需检查 `CraftWorld#spawnEntity` 的失败路径），则该窗口只在 `setProfession` 等后续调用抛异常时成立。
2. 若上层命令/向导对 `spawnNpc` 的异常有 catch 并调用 `respawnFromConfig()` 重建（需检查 `HilltopCommandHandler.java:1205` 周围 30 行的 try/catch），影响会被收敛。

### F-slice-24-dc-03（LOW）：reload 成功但在线 NPC 头顶名不刷新

`ShopManager.reload()` 的成功路径只做两件事：替换 `this.config`（`:84`）与关闭残留 GUI（`:99-102`），随后直接打印 `Shop loaded N items`（`:104`）。而 NPC 名字只在 `NpcManager.spawnNpc` 内解析一次（`NpcManager.java:102` `String npcName = resolveNpcName();` → `:104` `setCustomName`），`reload()` 全程没有触碰 `npcManager`。

一致性后果：改 `shop.npc.name` 后执行 `/hilltop shop reload`，命令返回成功、日志显示已加载，但**在线实体的显示名仍是旧值**，配置（源）与实体（派生状态）分叉，直到重启或重新 `set` 坐标。玩家可见的是一条与 `shop.yml` 不符的 NPC 名；服主按日志判断「已生效」会继续在错误前提上排查。

**可推翻条件**：
1. 若 `HilltopCommandHandler.java:580` 的 reload 分支在 `reload()` 返回 true 后另有 `despawnNpc()+spawnNpc()`（需检查该行前后 20 行），本发现不成立。
2. 若 `resolveNpcName()` 在别处被周期调用（需全仓搜 `resolveNpcName`），名字会被后续 tick 纠正——本切片内只看到 `:102` 一个调用点。

## 4. EVIDENCE_GAP：主背包「隐式写回」无法在切片内定论

`ShopManager#removeCurrency` 主背包分支整叠时 `inv.setItem(i, null)`（`:273`），**部分扣减时只改数组元素的 amount**（`:271`），没有 `setItem` 写回；副手分支却显式 `setItemInOffHand(offHand)` 并注释「不依赖引用共享」（`:285`）。

这构成口径不对称，但「是否真的丢扣减」取决于 `PlayerInventory#getStorageContents()` 在部署版 Paper 上返回的是 NMS 镜像（`asCraftMirror`，改 amount 即落盘）还是副本（`asCraftCopy`，改动丢失）。**该实现不在本仓库，属跨切片证据**，按纪律不猜测，标 `EVIDENCE_GAP`。

需要的证据：`CraftInventoryPlayer#getStorageContents`（或 `CraftInventory#getContents(int,int)`）的字节码/源码，确认是否对每个槽位调用 `CraftItemStack.asCraftMirror`。若确认是镜像 → 本项 REFUTED（现有写法可用，仅口径不统一）；若是副本 → 升级为 HIGH（玩家少付钱仍拿货，`countCurrency` 的余额校验已通过）。

## 5. 已检查、未立条（避免凑数）

- **重复槽位**：`ShopConfigLoader.java:336-344` 保留两件同槽商品，GUI 与 `bySlot` 都是后者胜出（`ShopGUI.java:47-48`），前者不可购买。这是**已显式告警并在注释里承认的取舍**，且 GUI 显示与购买映射彼此一致（不存在「看到 A 买到 B」），故不立条。
- **`getItems()` 返回内部 list**：`ShopConfig.java:45` 返回 `Collections.unmodifiableList`，元素 `ShopItem` 全字段 final、无 setter，未命中「返回值暴露内部状态」。
- **`load()` 的实例级状态**：`occupiedSlots` / `loadWarnings` 在每次 `load()` 的 `:163-164` 清空；早抛路径（`:98/:110/:125`）虽在清空之前返回，但下一次成功加载会先清空，不会把上次的告警/占位带进新快照。未命中。
- **`gui.size` 与 `slot` 的边界**：`clampGuiSize`（`:373-386`）只产出 9/18/27/36/45/54，`parseItem` 用同一个 `guiSize` 判 `slot`（`:324`），`ShopGUI` 按 `cfg.getGuiSize()` 建容器（`:44`）——三处同源，未命中越界。

## 6. 维度清单（8 模式 + 4 子问题逐项）

| # | 模式 | 结果 | 说明 |
|---|---|---|---|
| 1 | 返回值暴露内部状态 | 未命中 | `ShopConfig.getItems` 不可变视图；`ShopGUI.getItemAt` 返回不可变 `ShopItem`；无调用方改写内部集合 |
| 2 | 同族函数守卫一致性 | 命中 | `countCurrency` 与 `removeCurrency` 读写口径同源（均含副手），但**写回方式不对称** → F-04（EVIDENCE_GAP） |
| 3 | 数值边界 | 未命中 | 本维度只关心「落库值是否与配置一致」：`price`/`amount` 的越界属 L3/L4，已转 off-dimension |
| 4a | 原型链 / 裸下标 | 不适用 | Java 无原型链；`bySlot.get(slot)` 有 null 分支（`ShopListener:94-95`） |
| 4b | 假值 vs 缺值 | 未命中 | `currencyName`/`npcName`/`guiTitle` 空串统一归一为 null（`:145-159`），与「未配置」同义，消费侧都判 null/empty |
| 4c | NaN / Infinity / 小数 | 不适用 | `YamlConfiguration#getInt` 只产出 int，NaN/Infinity 无法进入本切片；超 int 截断属 L3（security） |
| 4d | 嵌套结构校验 | 未命中 | `shop.items` 存在但非 Map 时抛异常（`:121-129`）；`icon.material`、`lore` 逐条校验/归一 |
| 5 | 能力是否真实现 | 命中 | `PAID_DROP_KEY` 的写入（`:226`）与并物补标（`:260-262`）双侧都在；但 reload「已生效」的承诺只覆盖 config/GUI，未覆盖 NPC 名 → F-03 |
| 6 | 转义 / 编码顺序 | 不适用 | 仅单层 `ChatColor.translateAlternateColorCodes`，无多层替换 |
| 7 | 边界符号（负数 / 下标） | 未命中 | `slot < 0` 与 `slot >= guiSize` 被 `:324` 拦掉；`price` 负数在 `:350` 钳 0 |
| 8 | 引用绑定是否存在 | 未命中 | 本切片符号均由 import/同包解析，编译期可证；无「调用了未导入的名字」形态 |

## 7. 自检记录

**标识符对账（DONE）**：五组键名双侧比对，只有一处差集。

| 标识符 | 定义侧 | 消费侧 | 差集结论 |
|---|---|---|---|
| PDC `shop-currency` | `createCurrencyItem:164` 写 | `isCurrency:314` 读（唯一判定点） | 无差集 |
| PDC `shop_paid_drop` | `markPaidDrop:226`、`onItemMerge:262` | `onItemMerge:260-261` 读 | 无差集（无删除点符合「只标地面实体」语义） |
| `shop.npc.name` | `Loader:150` 读 → `ShopConfig:40` | `NpcManager.resolveNpcName:340` ← 仅 `spawnNpc:102` | **差集：reload 路径无消费点** → F-03 |
| `slot` | `Loader:323` | `ShopGUI:47-48`、`ShopListener:94` | 三处同源，无差集 |
| `price` | `Loader:346` | `ShopItem.price` → `ShopListener:117/126`、`ShopGUI:104` | 无差集 |

**自带自检抽验（DONE，仅 a/b/c 静态抽验）**：抽验 `ShopManagerTest#Removing`（`removesExactAmount`/`removesAcrossSlots`/`offHandIsUsedWhenMainInventoryRunsOut`/`insufficientBalanceRemovesNothing`）与 `ShopListenerTest` 退款三例。

- (a) 失败路径：均用 JUnit `assertEquals`/`assertTrue` 真断言，非「打印即通过」；
- (b) 空转：`ShopListenerTest:318-337`（`refundFailureDoesNotEscapeTheEventHandler`）**没有断言**，只断言「不抛」——退款静默失败时它同样绿，属可空转用例；`refundFailureLogsSevere` 有断言但只钉日志文案，钉不住「钱回来了」；
- (c) 断言目标存在：`removesAcrossSlots` 断言扣 5 后余 2，该断言只有在「部分扣减真的写回」时才成立——它反过来证明项目假设 `getStorageContents()` 元素是活引用（与 F-04 的待证点同源）。

**(d) 注入故障未做**：需运行 Maven 测试，见下。

**运行时验证（SKIPPED）**：项目是 Maven + Paper 插件，`mvn test` 会写 `target/`，违反「零写入被审仓库」的硬约束；MockBukkit 用例也只能在构建产物存在时运行，故本轮不做运行时验证，全部结论均为静态证据 + 控制流推断。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "audit-slice-24-data-consistency",
  "role": "audit",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/.run-dsh3/artifacts/round1-02-audit-slice-24-data-consistency.md",
  "payload": {
    "slice_id": "slice-24",
    "findings": [
      {
        "finding_id": "F-slice-24-dc-01",
        "severity": "MEDIUM",
        "dimension": "data-consistency",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/shop/ShopListener.java",
          "line": 197,
          "quote": "            } catch (RuntimeException ex) {\n                plugin.getLogger().severe(\"Shop refund FAILED for \" + player.getName() + \" item '\"\n                        + item.getId() + \"' amount \" + item.getPrice()\n                        + \" — manual compensation required: \" + ex);\n            }"
        },
        "inference": {
          "claim": "购买链先扣款（purchase:126）再发货；发货失败进入 refundCurrency 后，若补偿动作自身抛异常，catch 只写一行 SEVERE 日志就返回——货币已扣、商品未生成、玩家无提示，且没有任何持久化的待补偿记录或重试，一致性只能靠服主读日志人肉收敛。",
          "basis": "调用链：InventoryClickEvent → ShopListener#onInventoryClick:103 → purchase:142/147 → refundCurrency:186 → catch:197。catch 块内只有 plugin.getLogger().severe（:198-200），其后没有 addItem 重试、没有写入任何待补偿结构、没有 player.sendMessage；而扣款发生在 :126 且已返回成功。项目自带测试 ShopListenerTest:333 注释「币确实回不来（这是「需要人工补偿」的路径）」证实该分支被设计为人工兜底。",
          "alternatives": [
            "如果插件在别处（如 HilltopVillagePlugin 的日志/数据库初始化）另有失败交易落库或补偿队列，则「无持久记录」不成立——需检查 src/main/java/com/hilltopvillage/HilltopVillagePlugin.java 的 onEnable 与任何 shop 相关持久化。",
            "如果 refundCurrency 内的 addItem/createCurrencyItem 在目标 Paper 版本上不可能抛（需检查 CraftInventory#addItem 与 ItemStack 构造的抛面），则该 catch 是死分支，本发现降为无效。",
            "如果服主的运维流程本就以 latest.log 的 SEVERE 行为对账依据且日志长期保留，则影响被运维手段缓解——但那不改变代码侧无收敛点的事实。"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "F-slice-24-dc-02",
        "severity": "MEDIUM",
        "dimension": "data-consistency",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/shop/NpcManager.java",
          "line": 86,
          "quote": "        despawnNpc();\n\n        // 只保留水平朝向：克隆后把 pitch 归零再生成，避免低头状态被带入实体\n        Location spawnLocation = location.clone();\n        spawnLocation.setPitch(0f);\n\n        Villager villager = (Villager) spawnLocation.getWorld().spawnEntity(spawnLocation, EntityType.VILLAGER);"
        },
        "inference": {
          "claim": "NPC 换生是「先删旧、再建新」且第二步无保护：despawnNpc() 已把旧实体 remove 并把字段置 null，spawnEntity 或其后的 setProfession/setCustomName 一旦抛异常，方法直接穿出，npc 字段停留在 null——世界里再没有带 shop-npc 标记的实体，而 arenas.yml 里的坐标还在。",
          "basis": "调用链：/hilltop shop set（HilltopCommandHandler:1205）或向导（SetupWizard:1031/1320）或启动恢复（NpcManager:301）→ spawnNpc → :86 despawnNpc()（内部 :155 npc.remove(); :156 npc=null）→ :92 spawnEntity → :109 this.npc = villager。:86 与 :92 之间无 try/catch，也没有保留旧 Location 供重建；:93-108 的 setAI/setProfession/setCustomName/PDC 写入同样不在保护内。方法体内没有任何回滚语句。",
          "alternatives": [
            "如果 World#spawnEntity 在受支持的 Paper 版本上对本已加载世界永不抛（需检查 CraftWorld#spawnEntity 的失败路径），则失败窗口只存在于 :93-108 的后续调用。",
            "如果上层命令/向导在 spawnNpc 外层有 catch 并调用 respawnFromConfig() 重建（需检查 HilltopCommandHandler.java:1205 与 SetupWizard.java:1031 前后 30 行的 try/catch），实际影响会被收敛为一次日志。",
            "如果旧实体可被 cleanupOrphans 之外的机制自动补回（需检查是否有其它代码在 tick 里检测 npc==null 并重建），则该窗口不成立。"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "F-slice-24-dc-03",
        "severity": "LOW",
        "dimension": "data-consistency",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/shop/ShopManager.java",
          "line": 99,
          "quote": "        for (Player p : Bukkit.getOnlinePlayers()) {\n            if (p.getOpenInventory().getTopInventory().getHolder() instanceof ShopGUI) {\n                p.closeInventory();\n            }\n        }\n        plugin.getLogger().info(\"Shop loaded \" + config.getItems().size() + \" items\");"
        },
        "inference": {
          "claim": "reload 的成功路径只替换内存 config 并关闭残留 GUI，不重建也不改名在线 NPC；因此改 shop.npc.name 后 reload 返回 true、日志显示已加载，但实体头顶名仍是旧值，配置（源）与实体（派生状态）分叉，直到重启或重新 set 坐标。",
          "basis": "ShopManager.reload() 成功分支（:82-106）只有 this.config = loader.load()（:84）、关闭 ShopGUI（:99-102）与 info 日志（:104），全程未调用 npcManager；NpcManager 中名字解析 String npcName = resolveNpcName() 的唯一调用点是 spawnNpc:102，赋值 setCustomName 在 :104，二者都只在生成时执行一次。respawnFromConfig:301 也只在启动时调用 spawnNpc。",
          "alternatives": [
            "如果 /hilltop shop reload 的命令分支在 reload() 返回 true 后另有 despawnNpc()+spawnNpc()（需检查 HilltopCommandHandler.java:580 前后 20 行），本发现不成立。",
            "如果 resolveNpcName() 在别处被周期性调用（需全仓搜 resolveNpcName 的调用点），实体名会被后续逻辑纠正；本切片内只看到 spawnNpc:102 一处。",
            "如果 reload 的语义被文档明确限定为「只重载商品与 GUI，不重载 NPC 外观」，则属于契约与实现一致的设计限制，应降为文档问题而非一致性缺陷。"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "F-slice-24-dc-04",
        "severity": null,
        "dimension": "data-consistency",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/shop/ShopManager.java",
          "line": 271,
          "quote": "                item.setAmount(item.getAmount() - take);"
        },
        "inference": {
          "claim": "主背包部分扣减只修改 getStorageContents() 返回数组里的 ItemStack 数量，没有 setItem 写回；副手分支却显式 setItemInOffHand 并注释「不依赖引用共享」。若该 API 返回的是副本，则部分扣减不落盘而余额校验已通过，玩家少付钱仍拿到货；若返回的是 NMS 镜像，则写法可用，仅口径不统一。",
          "basis": "removeCurrency 主背包分支：整叠走 inv.setItem(i, null)（:273），部分扣减只 item.setAmount(...)（:271）；副手分支在 :285 显式 inv.setItemInOffHand(offHand) 并注明不依赖引用共享。两条路径的写回方式不对称，且 :258 的 countCurrency 余额校验在写回之前完成。是否真丢扣减取决于 CraftInventoryPlayer#getStorageContents 的实现（asCraftMirror 还是 asCraftCopy），该文件不在本仓库，按切片纪律不猜测。",
          "alternatives": [
            "如果 CraftInventoryPlayer#getStorageContents 对每格返回 CraftItemStack.asCraftMirror（与 CraftInventory#getContents 同源），则 setAmount 直接写穿 NMS，本项 REFUTED——需检查部署版 paper 服务端 jar 中该方法的字节码。",
            "如果 MockBukkit 的 PlayerMock 与真实服务端行为不同，则项目自带用例 ShopManagerTest#removesAcrossSlots（断言扣 5 后余 2）只能证明测试环境行为，不能外推到生产。"
          ]
        },
        "status": "EVIDENCE_GAP",
        "missing_evidence": "部署版 Paper 服务端中 CraftInventoryPlayer#getStorageContents（或 CraftInventory#getContents(int,int)）的实现：是否对每格调用 CraftItemStack.asCraftMirror。"
      }
    ],
    "searched_scope": {
      "files_read": [
        "src/main/java/com/hilltopvillage/shop/NpcManager.java",
        "src/main/java/com/hilltopvillage/shop/ShopConfig.java",
        "src/main/java/com/hilltopvillage/shop/ShopConfigLoader.java",
        "src/main/java/com/hilltopvillage/shop/ShopGUI.java",
        "src/main/java/com/hilltopvillage/shop/ShopItem.java",
        "src/main/java/com/hilltopvillage/shop/ShopListener.java",
        "src/main/java/com/hilltopvillage/shop/ShopManager.java",
        "src/test/java/com/hilltopvillage/shop/ShopManagerTest.java",
        "src/test/java/com/hilltopvillage/shop/ShopListenerTest.java"
      ],
      "files_in_slice": 7,
      "shared_dependencies_read": [
        "src/test/java/com/hilltopvillage/shop/ShopManagerTest.java",
        "src/test/java/com/hilltopvillage/shop/ShopListenerTest.java"
      ],
      "files_scanned_without_findings": [
        "src/main/java/com/hilltopvillage/shop/ShopConfig.java",
        "src/main/java/com/hilltopvillage/shop/ShopConfigLoader.java",
        "src/main/java/com/hilltopvillage/shop/ShopGUI.java",
        "src/main/java/com/hilltopvillage/shop/ShopItem.java",
        "src/test/java/com/hilltopvillage/shop/ShopManagerTest.java",
        "src/test/java/com/hilltopvillage/shop/ShopListenerTest.java"
      ],
      "dimension_checklist": [
        { "pattern": "1 返回值暴露内部状态", "result": "未命中", "note": "ShopConfig.getItems 返回 unmodifiableList，ShopItem 全字段 final 无 setter；ShopGUI.getItemAt 只返回不可变对象" },
        { "pattern": "2 同族函数守卫一致性", "result": "命中", "note": "countCurrency/removeCurrency 读写口径同源（均含副手），但主背包隐式写回 vs 副手显式写回不对称 → F-slice-24-dc-04" },
        { "pattern": "3 数值边界", "result": "未命中", "note": "本维度只查落库值是否与配置一致；price/amount 越界属 L3/L4，已转 off_dimension_notes" },
        { "pattern": "4a 原型链/裸下标", "result": "不适用", "note": "Java 无原型链；bySlot.get(slot) 有 null 分支并直接 return" },
        { "pattern": "4b 假值 vs 缺值", "result": "未命中", "note": "currencyName/npcName/guiTitle 的空串在 Loader:145-159 统一归一为 null，与缺键同义" },
        { "pattern": "4c NaN/Infinity/小数", "result": "不适用", "note": "getInt 只产出 int，NaN/Infinity 无法进入本切片；超 int 截断归 L3 security" },
        { "pattern": "4d 嵌套结构校验", "result": "未命中", "note": "shop.items 存在但非 Map 时抛异常（Loader:121-129）；icon.material 与 lore 逐条校验/归一" },
        { "pattern": "5 能力是否真实现", "result": "命中", "note": "PAID_DROP 标记写入与并物补标双侧都在；但 reload 的「已生效」只覆盖 config/GUI，未覆盖 NPC 名 → F-slice-24-dc-03" },
        { "pattern": "6 转义/编码顺序", "result": "不适用", "note": "仅单层 ChatColor.translateAlternateColorCodes，不存在多层替换的二次转义" },
        { "pattern": "7 边界符号（负数/下标）", "result": "未命中", "note": "slot<0 与 slot>=guiSize 被 Loader:324 拦掉；price 负数在 :350 钳 0，读侧一致" },
        { "pattern": "8 引用绑定是否存在", "result": "未命中", "note": "本切片符号均由 import 或同包解析，编译期可证，无调用未导入名字的形态" }
      ]
    },
    "self_checks": {
      "identifier_reconcile": {
        "status": "DONE",
        "note": "对账五组标识符：PDC shop-currency（写 createCurrencyItem:164 / 读 isCurrency:314，无差）；PDC shop_paid_drop（写 :226/:262 / 读 :260-261，无差）；slot（Loader:323 / ShopGUI:47-48 / ShopListener:94，同源）；price（Loader:346 → ShopItem → ShopListener:117,126 / ShopGUI:104，无差）；shop.npc.name（Loader:150 → ShopConfig:40 → 仅 NpcManager.spawnNpc:102 消费）——唯一差集是 reload 路径无消费点，即 F-slice-24-dc-03。"
      },
      "self_check_audit": {
        "status": "DONE",
        "note": "抽验 ShopManagerTest#Removing 四例与 ShopListenerTest 退款三例：(a) 均有 assertEquals/assertTrue 真断言；(b) 发现一处可空转用例 ShopListenerTest:318-337 refundFailureDoesNotEscapeTheEventHandler 无断言，退款静默失败也绿；refundFailureLogsSevere 只钉日志文案；(c) removesAcrossSlots 的「扣 5 余 2」断言反向证明项目假设 getStorageContents 元素是活引用。未做注入故障 (d)，原因见 runtime_validation。"
      },
      "runtime_validation": {
        "status": "SKIPPED",
        "note": "项目为 Maven + Paper 插件，mvn test 会写 target/ 违反被审仓库零写入；MockBukkit 用例需先构建产物，故本轮不跑运行时，全部结论为静态证据加控制流推断。"
      }
    },
    "off_dimension_notes": [
      "security/economy（Lead L3）：ShopConfigLoader.java:346 的 yaml.getInt 无上界，超 int 的 YAML 数字被截断为负、再于 :350-355 钳成 0，商品变免费；同一 price 又用于 createCurrencyItem 退款造币。请由 security 维度处置。",
      "error-handling（Lead L4）：ShopConfigLoader.java:305 只检测 price 缺键；price 写成非数字（如 \"10o\"）时 getInt 静默回落 1，isSet 为 true，既不 warning 也不进 loadWarnings。",
      "error-handling：F-slice-24-dc-01 的退款分支（ShopListener:186-203）成功后不给玩家任何 sendMessage/ActionBar 更新，玩家侧表现为「点了一下，什么都没发生」。",
      "logic/observability：ShopManager.java:87-91 的降级日志写「no items can be bought until the file is fixed」，但当 config != null 时保留的是上一份有效配置、商品仍可正常购买——日志描述与实际可售状态矛盾，会误导管理员判断商店已停业。",
      "logic：ShopListener.java:101 的 250ms 冷却在余额校验与扣款之前写入，余额不足的失败点击同样占用冷却，属轻微副作用（非重复成交）。",
      "logic：ShopConfigLoader.java:336-344 对重复槽位保留两件商品（后者在 GUI 覆盖前者），先到的那件实际不可购买；已在日志与 loadWarnings 显式承认，故未在本维度立条。"
    ]
  },
  "error": null
}
```
