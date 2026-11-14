# 第一轮 dsh 交付的独立验收

**验收时间**：2026-11-15 02:45
**对象**：dsh 对 `task-repair.md`（#7 #3 #1 #6 #4）的交付
**原则**：不采信产物的自述，每条都回到源码 / 日志 / 测试实跑

---

## 结论

**4 条修复成立，1 条不修成立。** 全量测试由我独立重跑确认：

```
Tests run: 877, Failures: 0, Errors: 0, Skipped: 1
BUILD SUCCESS
EXIT=0
```

基线 863 → 877（+14），与 dsh 自述一致。

> 附注：我第一次重跑得到 `EXIT=1`，但那是我自己的命令写错了——
> `cmd.exe /c 'build.cmd ...'` 在 PowerShell 里不继承 `Set-Location`，
> 报的是「'build.cmd' 不是内部或外部命令」。改成绝对路径后通过。
> **验收者自己的工具出错，不能算成被验收对象的失败。**

---

## 逐条核实

### 红测试日志是真的，不是事后编的

三个「修复前是红的」证据文件存在且内容可信（UTF-16 编码，需转码读）：

| 日志 | 失败数 | 关键断言 |
|---|---|---|
| `target/config7-red.log` | 3/4 | `victory-waves=0 会让首波即判胜；必须钳到 GUI 下界 1 ==> expected: <1> but was: <0>` |
| `target/config7-infinity-red.log` | 1/1 | `+Infinity 必须收敛到 GUI 上限 10 ==> expected: <10.0> but was: <Infinity>` |
| `target/repair1-red.log` | 5/5 | `差 30 血只需 ceil(30/50)=1 个物品；固定扣 5 个会让玩家白丢 4 个 ==> expected: <9> but was: <5>` |

断言带 `expected` / `actual` 和中文解释，是真实执行产物。

### #7 配置钳制

读了 `git diff ConfigManager.java`（+84 行）。三处钳制都实现，且：

- `loadFromFile()` 与 `mergeExternalChanges()` **两个入口都改**（任务书明确要求，容易漏）
- 值被改写时置 `loadTimeNormalizationPending = true`（这是「钳制只存在于内存」的陷阱所在）
- `explode-damage-multiplier` 允许为 0（任务书要求「不得改变合法配置」）
- NaN / ±Infinity 单独处理：NaN→0、+Inf→10、-Inf→0

### #1 修复结算

`NodeListener.planRepair()` 抽成 `static` 纯函数 + `record RepairPlan`，符合任务书建议。
逻辑核对：

- `itemsNeeded = min(ceil(deficit/perItem), min(maxPerAction, held))`
- `restored = min(deficit, itemsNeeded * perItem)` —— **按实际消耗算恢复量**，这正是旧 bug 的另一半
- 用 `Math.ceil(x - Math.ulp(x))` 吸收浮点噪声，避免 `30/0.1 = 300.00000000000006` 多扣一个

边界处理正确：`!(deficit > 0.0)` 同时挡住 NaN 和负数。

### #6 爆炸倍率

固定 `DEFAULT_EXPLOSION_POWER = 3.0f`（普通苦力怕），倍率 0 时仍传 `0.0f` 保留「纯视觉」语义。
复用乘法抽出 + 新增 `Double.isFinite` 检查（附注：`Math.max(0, NaN)` 返回 NaN，原写法挡不住）。

**没有新配置键**——dsh 论证了为什么不拆：为一个只有一种怪用的参数引入新键，
迁移成本高于收益。这个判断我认同。

### #4 重置回滚

`readNodesForWorld` 本来就返回 `List<Location>`，dsh 把
`int expectedNodes = NodeSystem.readNodesForWorld(...).size()` 改成先存 `List` 再取 `.size()`，
是**正确的最小改动**，没有臆测接口。

新增 `NodeSystem.restoreNodesForWorld(...)`：保留其它世界、按坐标去重（`Integer 100` 与
`Double 100.0` 归一化）、文件不可用返回 `false` 不谎报成功。

`abort()` 加 `tryReinstate` 重载，回滚失败时**保持 DISABLED** 而非启用出 0 节点空图
（fail-closed，方向正确）。

连带改动 `ArenaManageGUI.java` + `messages.yml`（EN/ZH 各一个键）是必要的——
新增 `NODE_ROLLBACK_FAILED` 枚举若没有对应文案，GUI 会崩在 switch 上。

**不交换第 5/8 步的理由成立**：交换只是把不可逆损失挪到另一条路径（部署数据丢失 + 竞技场停用）。

### #3 判定不修 —— 我独立核实，认可

dsh 的理由引用了 `messages.yml` 的两行文案。**我自己读了原文**：

```yaml
config.menu.main.reload: "&bLoad Config File"
config.menu.main.reload-lore1: "&7Reload from game-settings.yml"
config.menu.main.reload-lore2: "&8Note: unsaved changes will be overwritten"
```

中文 `:1723-1725` 同样是「注意：当前未保存的更改将被覆盖」。

且 `MainConfigMenu.java:131-144` 有独立的 **Revert All Unsaved Changes** 路径。
管理员有「保存」「撤销」「重载」三条明确路径，重载的破坏性已写在按钮 lore 里。

**判定为设计意图成立，不是缺陷。**

---

## 验收中发现的新缺陷 #8（dsh 自己在 done-3.md 里指出，我核实为真）

`ConfigManager.loadFromFile()` 返回 `void`。当 `!loaded.usable() || settingsGate.isReadOnly()` 时
（`:1372-1382`），它打一条 SEVERE 日志、设 `settingsLoadedFromDisk = false`、`return;`，
**调用方完全不知道失败**。

我核实了两处生产调用点：

- `MainConfigMenu.java:149` —— 无条件发 `config.menu.main.reloaded-msg`
- `HilltopCommandHandler.java:420-437` —— 虽然包在 `try/catch (RuntimeException)` 里，
  但失败路径**不抛异常**，所以 catch 不触发，`config-reloaded` 照样发出

这比 #3 严重：#3 是「已告知的破坏性操作」，#8 是**「消息与事实相反」**。
而且 `settingsGate.isReadOnly()` 是 YAML 解析失败后的隔离模式，正常运行中可能发生。

已作为 `task-repair-8.md` 派回 dsh。

---

## 残余风险（认可 dsh 的清单，按我的判断重排优先级）

1. **#6 战斗数值变化** —— 所有非 0 倍率现在都是普通苦力怕威力，已部署服务器手感会变。
   需要 CHANGELOG。
2. **#1 语义变更** —— `repair-cost-amount` 从「固定消耗」变成「单次上限」。
   `game-settings.yml:127` 的注释已同步，但**老服务器磁盘上的旧注释不会自动迁移**。
3. **#4 第 7 步商店 NPC 仍不可逆** —— 节点能回滚，已 despawn 的村民不回来。
4. `nodeSelfDestructMultiplier` 未做 NaN/Infinity 钳制（#6 相邻）。
5. `arenas.yml` 的 per-arena `game.victory-waves` 是独立读取路径，不受 #7 钳制。

第 1、2 条需要用户决策是否写 CHANGELOG，第 3–5 条可以继续派给 dsh。
