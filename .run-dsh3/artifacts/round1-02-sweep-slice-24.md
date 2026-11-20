# slice-24 宽扫（shop 包：NPC / 配置 / GUI / 购买链）

- status: COMPLETE
- trace_id: trace-r1-20260215-hilltop-dsh3
- round_id: round1
- slice_id: slice-24
- 被审仓库：`D:\Server\MCServers\Server plugin\Hilltop Village\Hilltop Village Plugin`（只读）
- 扫描范围：`src/main/java/com/hilltopvillage/shop/` 下 7 个文件，逐行通读
- reachability：`PROD` —— `ShopListener` 为常驻 Listener，`ShopManager`/`NpcManager` 由插件启用链与 `/hilltop shop` 命令直接驱动，购买链从 `InventoryClickEvent` 生产入口可达

## 1. 切片结构速记

| 文件 | 行数 | 职责 |
|---|---|---|
| `NpcManager.java` | 347 | 商店村民生成 / 清除 / 重启恢复 / 孤儿清理 / 转头任务 |
| `ShopConfig.java` | 47 | 只读配置快照（货币材质、NPC 名、GUI 标题、尺寸、商品列表） |
| `ShopConfigLoader.java` | 387 | shop.yml 解析、隔离态防重建、逐条商品校验与钳制 |
| `ShopGUI.java` | 128 | InventoryHolder，slot→ShopItem 反查，占位板填充 |
| `ShopItem.java` | 58 | 商品不可变数据类 |
| `ShopListener.java` | 289 | 右键开 GUI、点击购买、冷却、扣款/发货/退款、溢出落地打标 |
| `ShopManager.java` | 316 | 配置生命周期、货币工厂、发货路由、余额统计与扣除 |

## 2. 重点维度观察（data-consistency 优先）

1. **扣款/发货顺序**：`purchase` 先 `removeCurrency`（ShopListener:126），再 `deliverItem`（135）；`deliverItem` 返回 null 或抛 `RuntimeException` 时走 `refundCurrency`（142/147）。补偿路径本身完整，但 `refundCurrency` 的补偿动作失败只 `severe` 日志（198），没有重试、没有玩家侧提示、没有待补偿队列——扣款已生效，玩家钱货两空只能靠管理员读日志手工补。这是该链上唯一没有自动收敛的窗口。
2. **部分成交**：`addItem` 溢出的部分 `dropItemNaturally` 落地并打 `PAID_DROP_KEY`（156-161），且 `purchasedAmount` 在 `addItem` 前取（154），避开 Paper 原地改数量。此路径处理得比预期干净。
3. **数值边界**：`price` 没有任何上界校验（Loader:346），`getInt` 会把超 int 的 YAML 数字截断成 int（可翻负），负数随即被钳成 0 → 商品免费；同一数值又用于退款造币。`amount` 同样只有下界校验（315），`MATERIAL` 的巨额 amount 会直接进 `new ItemStack(icon, amount)`。
4. **解析失败与隔离**：`load()` 在 `!file.exists() && isQuarantined(file)` 时抛异常且明确拒绝 `saveResource`（93-102），`.corrupt` + 闸门双信号防重建；文件仍在不丢现场。该路径设计是自洽的，未发现「把原文件弄丢」的直接证据。
5. **GUI 重复触发**：点击事件先 `setCancelled(true)`，再判 `clickedInventory == event.getInventory()`，再用 250ms UUID 冷却（ShopListener:98-101）。同 tick 双击被冷却挡住；冷却在 `purchase` 之前写入，因此「余额不足」的失败点击也会占用 250ms，属轻微副作用而非重复成交。
6. **NPC 残留**：`spawnNpc` 先 `despawnNpc()` 再 `spawnEntity`，无回滚；`cleanupOrphans` 只在启动时清理已加载区块内的 PDC 实体；`reload()` 不重建 NPC，NPC 头顶名只在 spawn 时解析一次。

## 3. Leads

| id | dimension | confidence | 位置 | 一句话 |
|---|---|---|---|---|
| L1 | data-consistency | MEDIUM | ShopListener.java:198 | 退款失败仅日志，扣款已生效且无补偿收敛 |
| L2 | data-consistency | MEDIUM | ShopManager.java:271 | 主背包部分扣减未写回，副手却显式写回（口径不对称） |
| L3 | security | MEDIUM | ShopConfigLoader.java:346 | 价格无上界，超 int 截断翻负后钳 0 → 免费 |
| L4 | error-handling | MEDIUM | ShopConfigLoader.java:305 | 只查 price 缺键，类型写错静默按 1 计价 |
| L5 | data-consistency | MEDIUM | NpcManager.java:86 | 先删旧 NPC 再生成，生成失败无回滚 |
| L6 | data-consistency | MEDIUM | NpcManager.java:102 | NPC 名只在 spawn 解析，reload 后配置与实体不一致 |

### L1 — 退款失败无收敛
`purchase` 的扣款在发货之前，`deliverItem` 抛异常/返回 null 时用 `refundCurrency` 补偿；而 `refundCurrency` 内部 `addItem` 抛异常只写 `severe` 日志。此刻货币已从背包扣除、商品未生成、玩家没有任何提示，代码也没有重试或待补偿记录。日志里点名玩家与数量，等于把一致性责任转交给服主人肉对账。

### L2 — 主背包扣减依赖引用共享
`removeCurrency` 用 `getStorageContents()` 取数组，整叠时 `inv.setItem(i, null)`，部分扣减时只 `item.setAmount(...)`；副手分支却显式 `setItemInOffHand(offHand)` 并注释「不依赖引用共享」。两条路径写回方式不对称：若该 API 返回的是副本，主背包的部分扣减不会落盘，而 `countCurrency` 的余额校验已经通过——玩家少付钱仍拿到货。

### L3 — 价格数值边界
`yaml.getInt` 对超出 int 范围的 Number 走 `intValue()` 截断，`price: 3000000000` 会变成负数，随后被 `if (price < 0)` 钳成 0。结果是一件原本想标高价（或单纯写错位数）的商品变成免费；同一 `price` 还会被 `createCurrencyItem` 用于退款造币。

### L4 — 价格类型错误静默
缺键有 warning，但 `price: "10o"` 这类非数字值走 `getInt` 的默认值 1，`isSet` 为 true 因此既不 warning 也不进 `loadWarnings`。服主以为改过价，实际全店按 1 计价，且日志无迹可查。

### L5 — NPC 生成无回滚
`spawnNpc` 在校验完目标世界后立刻 `despawnNpc()`，随后才 `spawnEntity`。若 spawn 抛异常（世界卸载/实体上限/区块问题），旧 NPC 已被移除、`npc` 字段为 null，方法没有 catch 也没有恢复旧实体，商店从世界中消失直到下一次 set 或重启。

### L6 — reload 与在线 NPC 不一致
NPC 头顶名在 `spawnNpc` 内一次性 `resolveNpcName()`；`ShopManager.reload()` 只替换 config 并关闭残留 GUI，不重建/改名 NPC。改 `shop.npc.name` 后 `/hilltop shop reload` 返回成功、日志显示已加载，但在线 NPC 仍用旧名，直到重启或重新 set 坐标。

## 4. 未发现项的说明

- 未发现异步线程触碰 Bukkit 世界状态：本切片所有购买/GUI/NPC 操作均在主线程事件与调度器任务内。
- 未发现 `InventoryClickEvent` 槽位越界：`bySlot.get(slot)` 对空槽返回 null 并直接 return。
- 未发现 shop.yml 隔离后被出厂模板覆盖的直接路径：`isQuarantined` 同时看 `.corrupt` 与闸门读锁。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "sweep-slice-24",
  "role": "sweep",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/.run-dsh3/artifacts/round1-02-sweep-slice-24.md",
  "payload": {
    "slice_id": "slice-24",
    "reachability": "PROD",
    "generator_ref": null,
    "files_read": [
      {
        "path": "src/main/java/com/hilltopvillage/shop/NpcManager.java",
        "lines": 347,
        "quote": "public boolean spawnNpc(Location location) {"
      },
      {
        "path": "src/main/java/com/hilltopvillage/shop/ShopConfig.java",
        "lines": 47,
        "quote": "public List<ShopItem> getItems() {"
      },
      {
        "path": "src/main/java/com/hilltopvillage/shop/ShopConfigLoader.java",
        "lines": 387,
        "quote": "public ShopConfig load() {"
      },
      {
        "path": "src/main/java/com/hilltopvillage/shop/ShopGUI.java",
        "lines": 128,
        "quote": "public ShopItem getItemAt(int slot) {"
      },
      {
        "path": "src/main/java/com/hilltopvillage/shop/ShopItem.java",
        "lines": 58,
        "quote": "public int getPrice() { return price; }"
      },
      {
        "path": "src/main/java/com/hilltopvillage/shop/ShopListener.java",
        "lines": 289,
        "quote": "private void purchase(Player player, ShopItem item) {"
      },
      {
        "path": "src/main/java/com/hilltopvillage/shop/ShopManager.java",
        "lines": 316,
        "quote": "public boolean removeCurrency(Player player, int amount) {"
      }
    ],
    "files_unreadable": [],
    "leads": [
      {
        "lead_id": "L1",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/shop/ShopListener.java",
        "line": 198,
        "quote": "plugin.getLogger().severe(\"Shop refund FAILED for \" + player.getName() + \" item '\"",
        "why_suspicious": "购买先扣款后发货，退款动作自身失败时只写日志，不回滚、不重试、不通知玩家，钱货两空只能靠服主手工补偿。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L2",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/shop/ShopManager.java",
        "line": 271,
        "quote": "item.setAmount(item.getAmount() - take);",
        "why_suspicious": "主背包部分扣减只改 getStorageContents() 数组元素、未 setItem 写回，副手分支却显式写回，两条路径口径不对称。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L3",
        "suspected_dimension": "security",
        "file": "src/main/java/com/hilltopvillage/shop/ShopConfigLoader.java",
        "line": 346,
        "quote": "int price = yaml.getInt(path + \".price\", 1);",
        "why_suspicious": "价格没有任何上界校验，getInt 会把超 int 的 YAML 数字截断成负数，再被下方钳成 0，商品变成免费。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L4",
        "suspected_dimension": "error-handling",
        "file": "src/main/java/com/hilltopvillage/shop/ShopConfigLoader.java",
        "line": 305,
        "quote": "if (!yaml.isSet(path + \".price\")) {",
        "why_suspicious": "只检测 price 缺键；写成非数字字符串时 getInt 静默回落默认 1，既不 warning 也不进 loadWarnings。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L5",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/shop/NpcManager.java",
        "line": 86,
        "quote": "despawnNpc();",
        "why_suspicious": "生成新 NPC 前先无条件删除旧实体，随后 spawnEntity 失败或抛异常时没有回滚，旧 NPC 已消失。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L6",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/shop/NpcManager.java",
        "line": 102,
        "quote": "String npcName = resolveNpcName();",
        "why_suspicious": "NPC 头顶名只在 spawnNpc 时解析一次，ShopManager.reload 换配置后不重建/改名，配置与在线实体不一致。",
        "confidence": "MEDIUM"
      }
    ],
    "lead_count": 6,
    "dimension_histogram": {
      "logic": 0,
      "concurrency": 0,
      "security": 1,
      "error-handling": 1,
      "data-consistency": 4,
      "contract": 0
    }
  },
  "error": null
}
```
