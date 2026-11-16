# F1–F7 整体回归评审（跨修复耦合视角）

评审对象：`<TARGET_REPO>`
未提交改动 20 文件 / +804 −78；声称 905 测试全绿、7 份产物过 `check-payload --role fix`。

**结论先说**：默认模板这条路是安全的（有测试钉住，我逐条复核过）。
真正会出事的是**"shop.yml 曾经坏过一次"的服主**——F1 的"拒绝降级"在 `ShopConfigLoader`
里缺了本仓库其它每个加载器都有的那道闸门，于是一次损坏会演变成
**插件启动失败 → 下次重启静默写回出厂模板 → 服主的全部商品/价格/货币名/ NPC 名被替换**。
905 个测试没有一条覆盖"连续两次 load 跨越隔离"。详见第 1 节。

---

## 1. 最坏情况推演 / 默认模板与既有服务器（最重要）

### 1.1 全新安装（无 shop.yml）—— 安全

`ShopConfigLoader.load()` 第 51–54 行先判文件不存在 → `saveResource` 写模板 → 第 55 行
`YamlFiles.load` 读到 `OK` → 逐件 `parseItem`。我把模板 16 件商品逐项对过新规则：

| 新规则 | 模板是否全部通过 |
|---|---|
| `type` ∈ {HAMMER,FIREBALL,REPAIR_ITEM,MATERIAL,EQUIPMENT} | 通过（16/16） |
| MATERIAL/EQUIPMENT 必须有 `icon.material`（F2） | 通过（bow=BOW、arrow=ARROW，其余亦全配） |
| 必须有 `price` 键（F3） | 通过（16/16 都写了 price） |
| `amount > 0`（F4） | 通过（缺省=1；显式 8/4 均 >0） |
| `slot` ∈ [0,54) | 通过（0,2,4,6,8,11,13,15,28,30,32,34,37,39,41,43） |
| 槽位无冲突 | 通过 |

`src/test/java/com/hilltopvillage/shop/ShopConfigLoaderTest.java:96-133`
（`factoryTemplateParsesCleanly`）确实按出厂模板跑真实 `load()` 并断言 16 件、54 格、
EMERALD。**默认模板本身不会被新规则判违规，不是一次性破坏性变更。**

### 1.2 既有服务器 + 自定义 shop.yml，但文件完好 —— 部分条目会静默消失

这是"配置条目还在，运行时没了"的那一类。逐条：

1. **管理员手写过 `type: MATERIAL` 却漏了 `icon.material`**（F2）。旧行为：回落 BARRIER，
   商品留在 GUI 里、购买时发一块屏障（丑陋但可见、可发现）。新行为：整条 skip。
   GUI 里直接少一格，服主只会在启动日志里看到一行 `WARNING`（`ShopConfigLoader.java:174-178`）。
2. **管理员依赖过 `price` 缺省值 1**（F3）。这是旧代码里**写在文档注释里的合法默认值**，不是误配。
   新行为：`!yaml.isSet(path+".price")` → skip（`ShopConfigLoader.java:188-192`）。
   一个"所有商品都卖 1 个水晶"的极简店铺，只要当初省略了 `price:`，升级后**整店清空**。
3. **`amount: 0` 写在 HAMMER/FIREBALL 上**。`amount` 对这两类本来就"无视"
   （`ShopManager.deliverItem` 里 HAMMER 固定 1），但 F4 的 `amount <= 0` 检查
   （`ShopConfigLoader.java:194-200`）对**所有类型**生效。本来无害的 `amount: 0` 现在会删掉商品。
   低概率，但属于"新校验的作用域比语义宽"。

这三条都不会抛异常、不会阻止启动，只有日志。**这是"重启后商品不见了"最现实的成因**，
而 F2/F3 恰好是**把两条既有契约测试改写成了反向期望**才变绿的（见第 4 节）。

### 1.3 既有服务器 + shop.yml 损坏/截断 —— 破坏性，且不可原地恢复 ★

这是本次评审的核心发现。分两种损坏形态，行为完全不同：

**(a) 截断在 `items:` 头（可解析）**——`YamlFiles.load` 返回 `OK`（validator 传的是 null），
第 69–77 行的 raw-YAML 复查发现 `items` 存在但为 null → 抛 `IllegalStateException`。
**文件没有被移动**，所以这条路径是可重复、可原地修复的。没问题。

**(b) 解析失败 / 0 字节**——`YamlFiles.load` 走 `quarantine()`
（`util/YamlFiles.java:139-152`）：把 `shop.yml` **改名成 `shop.yml.corrupt`**，返回 `usable()==false`。
然后 `ShopConfigLoader.java:56-61` 抛异常。此刻磁盘上 **`shop.yml` 已经不存在了**。

接着发生的事：

1. `ShopManager.reload()` 抛异常 → `HilltopVillagePlugin.java:119-120` 的
   `this.shopManager.reload();` **没有任何 try/catch**（我确认过：`onEnable` 里只有
   PlayerGoodsManager/StatsManager 两处 `catch (Throwable)`，第 103–106 行的注释明确说
   其余核心模块"刻意不包裹"）→ Bukkit 记为 enable 失败 → **整个插件被禁用**。
   服主丢掉的是整个守卫战玩法，不只是商店。
2. 服主看到报错，想去修 `shop.yml` —— **那个文件已经不在了**，只剩 `shop.yml.corrupt`。
   编辑器里若还开着旧文件，保存下去等于新建一个空文件。
3. 服主重启服务器。`ShopConfigLoader.load()` 第 51–54 行：
   `if (!file.exists()) plugin.saveResource("shop.yml", false);`
   —— 因为文件已被隔离走，这里**写出了一份全新的出厂模板**。
4. `load()` 成功，`ShopManager` 记下 16 件出厂商品，插件正常启动。
   **服主自定义的商品、价格、`currency.name`、`npc.name`、`gui.title` 全部被出厂值替换**，
   唯一残骸是 `shop.yml.corrupt` 和上一次启动日志里的 SEVERE。

**这正是本仓库另外两个加载器明文禁止的形态**：

- `admin/AdminDeployManager.java:226-231`：
  "只读降级中**不得**从 JAR 模板重建：文件被隔离成 `*.corrupt` 后若这里再 `saveResource`
  一份出厂模板，下一次 `gate.load()` 会读到「合法的新文件」并自动解封，降级被重建动作绕过。"
  代码写作 `if (!gate.isReadOnly() && !arenasFile.exists())`。
- `arena/ArenaManager.java:842-849`（`ensureFile`）同样的守卫与同样的注释。

`ShopConfigLoader` **既没有 `YamlFileGate`，也没有任何 `isReadOnly`/隔离状态检查**。
我 grep 过 `src/main/java/com/hilltopvillage/shop/`，唯一的 `saveResource` 调用就是
`ShopConfigLoader.java:53`，没有任何 gate 痕迹。

所以 F1 的净效果是把旧行为
「坏文件 → 空商店（插件照跑）+ **文件原地保留、可修**」
换成了
「坏文件 → 插件禁用 + **文件被搬走** + 下次启动**静默写回出厂模板**」。
从"数据可恢复"退化成"数据被覆盖"。

> 为什么 905 全绿测不到：`ShopConfigCorruptFileTest` 的两个用例都只在**同一次**
> `load()` 上断言抛异常（`:66-78`、`:82-103`、`:106-142`）。没有任何一条测试在
> 隔离之后**再调用一次** `load()`，所以"第二次 load 会 `saveResource` 成功"这条
> 从未被执行。这是典型的"每个修复单测自己都对，拼起来是新缺陷"。

**风险等级：高。** 触发条件现实（磁盘满写坏、异常关机写坏、手动编辑漏了缩进），
后果是服主配置被覆盖且不可逆，且与 F1 声称保护的"不得降级成空商店"目标方向相反。

### 1.4 完整启动链推演（既有服务器，坏文件）

```
onEnable
 → LanguageManager(...)               OK
 → ConfigManager(...)                 OK
 → mapRestoreManager / villagerPreview OK
 → new ShopManager(this, lang)        OK（构造器不读盘，ShopManagerTest:360 钉住）
 → shopManager.reload()               ← 抛 IllegalStateException，无 catch
 ✗ onEnable 中断
 ✗ 后续全部跳过：multiArenaManager / arenaAdminService / tabListManager /
   hammerListener / nodeListener / fireballListener / NPC 重生 / 命令注册
 ✗ 文档生成也没跑
 → Bukkit: "Error occurred while enabling HilltopVillage" → 插件 DISABLED
 → onDisable：各字段判空后逐个跳过（这里写得很好，不会二次崩）
```
对比旧代码：`YamlConfiguration.loadConfiguration(file)` 吞掉解析错误 → 空商店 →
**继续启动**，竞技场、波次、节点一切正常，只有商店空。这是一个**从"局部功能降级"
到"整个插件不可用"的可用性等级变化**，影响面远超 shop 模块。

---

## 2. 每一处被删除的行为（逐条 + 风险）

`git diff -U0 | grep "^-"` 里剔除纯注释后的实际行为删除：

| # | 删除的代码 | 实际删掉的行为 | 风险 |
|---|---|---|---|
| D1 | `YamlConfiguration yaml = YamlConfiguration.loadConfiguration(file);` | 解析失败**静默降级为空配置且不动文件** | **高**——被 `YamlFiles.load` 的"隔离+抛异常"替代，连锁出 §1.3 |
| D2 | `int cost = repairCostAmount(); if (item.getAmount() > cost) item.setAmount(...)` | `repair-cost-amount` = **固定消耗量** | 中——语义改成"单次上限"。默认 1 不变，但自定义 servers 会少扣物品；盘上注释不迁移（见 §5） |
| D3 | `"EQUIPMENT item '" + id + "' is missing icon.material (delivery material), skipped"` | 日志文案里的 `(delivery material)` 短语 | 低——但服主的 grep/告警规则会失效 |
| D4 | `int amount = yaml.getInt(path + ".amount", 1);`（移至 price 校验前） | `amount` 的缺省 1 仍在，但**读点前移** | 低——副作用：被 skip 的条目不再占槽位（这是有意的、有测试） |
| D5 | `refreshTask = null; scheduledPeriod = -1;`（TabListManager catch 内） | 异常后**主动重建任务**的自愈路径 | 中——新依据是"反编译 paper-1.21.4-232 证明不会 cancel"。对非 Paper 分支（Purpur/Folia 等）是**未经同源验证的假设**。缓解：`start()` 仍判 `isCancelled()`，下次 join/reloadconfig 能兜底 |
| D6 | `world.createExplosion(nodeLoc, (float) explodeMultiplier, ...)` | 爆炸威力 = 可配置倍率 | 中——固定 3.0。默认模板 `explode-beetle: 3.0` 恰好不变；自定义倍率（0.5/10）的服务器战斗数值会变，且是**静默**的 |
| D7 | `executeAirdrop(); targetDropLocation = null;` | 投放失败后**下 tick 重试** | 中——改为 try/finally 后，失败一次即消费目标。改的是"永久卡死"换"丢一次空投"，方向对，但应急行为变了 |
| D8 | `abort(ctx, "deployment", ..., true, false, onDone);`（4 参） | deployment 中止**无条件尝试重启用** | 低——改 5 参，新增 `tryReinstate` 分支，语义是收紧（宁可 DISABLED） |
| D9 | `if (!loaded.usable() \|\| settingsGate.isReadOnly())` | ABSENT **照走**（视为可用） | 低-中——新增 `status == ABSENT` 拒绝。启动路径有 `initSettingsFile()` 兜底，主要影响 `reloadconfig` 时文件被删的场景，方向对 |
| D10 | `md.append("...DisplayEntity 清理队列...")` | 文档里一句不存在的功能描述 | **正向**——`TpsDiagnostic.java` 全文 119 行确无该输出，属于修错文档 |
| D11 | `// 每次修复消耗几个`（game-settings.yml 注释） | —— | 中——**这是资源模板，既有服主的盘上文件不会更新**，注释仍写着旧语义 |
| D12 | `ENABLE_REJECTED` → 加尾逗号 | 枚举新增 `NODE_ROLLBACK_FAILED` | 低——`ArenaManageGUI:843` 的 switch 已补 case；无 default 的其它 switch 会编译失败，构建过即安全 |

### 2.1 被"改写"而非删除的测试契约（比删除更值得警惕）

这两条是**旧的、通过的契约测试被反向重写**，因此 905 全绿不能当作向后兼容的证据：

- `ShopConfigLoaderTest.java:415` 原 `missingIconFallsBackToBarrier`（断言"非 EQUIPMENT 缺图标
  仍保留商品、回落 BARRIER"）→ 改成 `missingMaterialIconIsSkipped`（断言 skip）。
- `ShopConfigLoaderTest.java:592` 原 `missingPriceDefaultsToOne`（断言"缺 price 默认 1"）
  → 改成 `missingPriceIsSkipped`（断言 skip）。

这两条改动对 F2/F3 而言是必要的。但它们的真正含义是：
**"曾经被明确承诺过的两个默认值被撤销了"**。测试数字没变（改了断言但用例数不变），
所以"905 通过"这个指标对这两处**完全不设防**。

---

## 3. 调用点风险：`load()` 现在会抛

`ShopConfigLoader.load()` 只有两个生产调用点，都**没有** try/catch：

| 调用点 | 上下文 | 后果 |
|---|---|---|
| `HilltopVillagePlugin.java:119-120` `this.shopManager.reload();` | `onEnable` 主路径，无包裹 | **插件被禁用**（不只是商店）。见 §1.4 |
| `HilltopCommandHandler.java:578` `plugin.getShopManager().reload();` | `/hilltop shop reload`，case 内无 try | 异常穿出 `handle()` → `HilltopVillagePlugin.onCommand` 直接 `return commandHandler.handle(...)`，中间无 catch → Bukkit 打"An internal error occurred"给执行者，**真实原因（哪个键坏了）只进控制台** |

`ShopManager.reload()`（`shop/ShopManager.java:55-65`）本身是原子的：
`this.config = loader.load();` 抛异常时字段不被赋值，旧快照存活（`ShopConfigCorruptFileTest:99`
钉住了这一点）。**这一点做对了**，不会出现半个配置。

但注意 `HilltopCommandHandler.java:579` 紧接着
`plugin.getShopManager().getShopConfig().getItems()`——若 `config` 为 null（首次 load 就抛，
插件已死，命令不可达）会 NPE。仅在"半启用"状态下可达，属理论风险。

**已排除的 NPE**（我逐处确认）：
- `WaveManager.java:821-822`：`shopManager == null || shopManager.getShopConfig() == null` 双判空。
- `NpcManager.java:336-345`（`resolveNpcName`）：`getShopManager() != null && getShopConfig() != null`。
- `ShopGUI` 构造器只用 `cfg.getItems()`，被 skip 的商品只是列表更短，`bySlot` 同步变短。
- `ShopListener.getItemAt(slot)` 返回 null 已有占位符分支。

**结论：shop→listener 的耦合是安全的。真正的风险不在 "被 skip 后 NPE"，而在
"被 skip 后静默消失" 与 "抛异常后整个插件起不来"。**

---

## 4. 测试盲区清单

按"能挡住 §1.3 那条致命路径吗"排序：

1. **★ 没有"隔离后再次 load"的测试。** `ShopConfigCorruptFileTest` 全部用例都是单次
   `load()`/单次 `reload()`。缺的正是：
   ```
   write(corrupt) → assertThrows(load) → assertTrue(shop.yml 已消失)
   → assertFalse(new File("shop.yml.corrupt").length() == 0)
   → load() 再跑一次 → 断言「不该静默成功」/「不该写出厂模板」
   ```
   这一条加上去，§1.3 会立刻变红。
2. **没有 `onEnable` 级测试。** 全部 shop 测试用 `BareHost`（`testsupport/BareHost.java`，
   `onEnable` 刻意留空）。所以"load 抛异常 → 插件禁用"这条链在测试里**物理上不可达**。
   `HilltopVillagePlugin.java:103-106` 的"核心模块失败即禁用"设计意图从未被测试表达过。
3. **没有"损坏 shop.yml + `/hilltop shop reload`"的命令级测试。**
   `HilltopCommandReloadResultTest` 覆盖了 `reloadconfig` 的失败消息，
   但 `/hilltop shop reload` 抛异常后给管理员**什么消息都没有**，没有对应测试。
4. **没有"`saveResource` 是否被调用"的断言。** `saveResource` 是 `ShopConfigLoader` 里
   唯一有破坏性的动作，却没有一条测试监视它。
5. **`assertThrows` 在 shop 包里只出现在 3 处**（`ShopConfigCorruptFileTest:70,97,130`），
   全部是 `loader::load` / `shop::reload`，**没有一处覆盖命令或启动边界**。
6. **F5 的 mock 是手工复刻 Paper 语义**（`ShopListenerPurchaseMessageTest` 用 JDK 动态代理
   强制 `addItem` 原地改写数量）。它验证的是"修复后的读取顺序"，**不验证 Paper 真的会改写**。
   若 Paper 不改写，这个修复是 no-op（无害，但也说明红测的红是构造出来的）。
   这点在测试注释里是诚实的，可接受——但别把它当成"Paper 行为已被验证"。
7. **F2/F3 的"控制组"只覆盖同类合法值**（price:0、amount 缺省），没有覆盖
   "既有服务器那种手写文件"的真实样本 —— 即一个 `price` 缺省但其它键齐全的条目。
8. **D11（game-settings.yml 注释）无迁移测试。** 语义变了，盘上注释不变，没有任何测试或
   迁移逻辑表达这件事。

---

## 5. 跨修复耦合面（逐条）

- **F1 × F2/F3/F4**：F2/F3/F4 都在 `parseItem` 里加 skip，靠"文件层能读通"才生效。
  F1 把文件层改成会抛异常后，四条修复的分界线变成：
  「文件级坏 → 插件死」/「条目级坏 → 静默少商品」。这条分界线本身合理，
  但**没有人写下来**，也没有测试表达。
- **F1 × 隔离机制**：见 §1.3。这是唯一真正的耦合缺陷——F1 借用了 `YamlFiles.load`
  的隔离副作用，却没继承配套的"禁止重建"守卫。
- **F2 × F3 × F4 的检查顺序**：`type` → `icon` → `price` → `amount` → `slot` → 槽位登记 → 负价钳制。
  F3/F4 被刻意放在槽位登记之前（`ShopConfigLoader.java:185-200`，注释明确说明理由），
  所以被 skip 的条目不会造成假槽位冲突——**这条做对了**，`ShopConfigAmountValidationTest:192-237` 有钉。
- **F5 × F4**：`purchasedAmount = product.getAmount()` 在 `addItem` 之前取。
  `deliverItem` 里 `Math.max(1, item.getAmount())` 仍保留（`ShopManager.java:125`），
  与 F4 的加载期 skip 形成双保险，不冲突。
- **F5 × 退款分支**：`refundCurrency` 不受影响（它 `addItem` 之后不读书面量）。
- **F7（commands.md 原子写）× 其它**：完全独立，`writeAtomically` 的
  `Files.createTempFile(parent, ...)` 在 `parent == null` 时会 NPE？
  ——`docFile = new File(plugin.getDataFolder(), "commands.md")`，`getParent()` 非空，安全。
  `writeAtomically` 与 `YamlFiles.write` 是两份几乎相同的实现（重复代码），
  未来修一处漏一处——低风险，值得记一笔。
- **#7 钳制 × #6 倍率**：`normalizeExplodeDamageMultiplier` 保留 0（dropper 等模板用 0 表示不自爆），
  `ExplodeBeetleGoal` 的 `explodeMultiplier > 0 ? 3.0f : 0.0f` 也保留 0 → **语义一致，无冲突**。
  默认模板 `explode-beetle: 3.0` → 爆炸威力 3.0 不变、节点伤害 3.0×倍率不变。默认服务器零变化。
- **#7 钳制 × 脏状态**：`loadTimeNormalizationPending = true` 会让
  `MainConfigMenu.java:96/134` 认为"有未保存改动"。合法配置不会触发（有
  `ConfigLoadClampTest:93` 覆盖）。**但**：一个盘上写着 `victory-waves: 0` 的服务器，
  每次启动都会永久显示"有未保存改动"，直到管理员保存一次。可接受，但属于"修 bug 引入的
  持久提示"。

---

## 6. 总体回归风险评级

### 评级：**高**

理由（不是"小毛病多"，是"一处结构性缺陷 + 一处等级跃变"）：

1. **§1.3（高）**：F1 引入的"抛异常"耦合了 `YamlFiles` 的隔离副作用，却漏掉配套的
   禁止重建守卫。结果是**损坏一次 → 下次启动静默写出厂模板 → 服主配置被覆盖**。
   这直接违背 F1 自己声称的目标（"不得降级成空商店"），也违背本仓库另外两个加载器
   明文写下的不变式。905 全绿完全测不到，因为没有任何测试跨越隔离做第二次 load。
2. **§1.4（中-高）**：`load()` 抛异常 + `onEnable` 无 catch = **shop.yml 一个缩进错误
   就能让整个插件起不来**。商店在 `WaveManager` 里本来是可选依赖（有判空），
   把它提升成启动硬依赖，影响面与"shop 模块缺陷"的量级不匹配。这一步在
   `HilltopVillagePlugin:103-106` 有设计依据，但没有对"shop 是否该算核心模块"单独论证。
3. **§2.1（中）**：F2/F3 撤销了两个曾被明确承诺的默认值，且是**把既有契约测试反向改写**
   才变绿的。对既有服务器是静默的、逐条目的破坏。
4. **中**：D2（`repair-cost-amount` 语义）、D6（爆炸威力固定 3.0）、D5（TabList 自愈策略
   依赖 Paper 反编译结论）、D11（盘上注释不迁移）——都有据可查、都有意为之、
   都在 `repair-artifacts/SUMMARY.md` 的"残余风险"里承认了，属于**已披露的取舍**，不是隐藏缺陷。

### 建议的最小修复（按性价比排序，仅建议，未改动任何文件）

1. **给 `ShopConfigLoader` 补一个 `YamlFileGate`**（或至少一个
   `File shopYaml.corrupt` 存在就不 `saveResource` 的守卫），把 `:51-54` 改成
   `if (!gate.isReadOnly() && !file.exists())`。这一条同时解决 §1.3 的两个后果。
2. **`onEnable` 的 `shopManager.reload()` 包一层 try/catch**，失败时保留
   `config = 空 ShopConfig`（或上次快照）并 `SEVERE`，把"插件禁用"降级回"商店不可用"。
   与 `PlayerGoodsManager`/`StatsManager` 的处理保持一致。
3. **`/hilltop shop reload` 包 try/catch**，把真实原因回给执行者
   （复用新加的 `config-reload-failed` 风格文案），而不是让它变成泛化的 internal error。
4. **补一条"隔离后再次 load"的测试**——这是唯一能让 §1.3 永久不回潮的护栏。
5. **在 `CHANGELOG` 里写明** `repair-cost-amount` 语义变更、爆炸威力固定化、
   以及"缺 price / 缺 MATERIAL icon 的条目现在会被跳过"，让服主升级前能自查。
