# F1 回归修复：隔离后不得重建出厂 shop.yml

## 结论

| 项 | 值 |
|---|---|
| 缺陷 | F1 的修复（`!loaded.usable()` 时抛异常）引入回归：坏 `shop.yml` 被隔离成 `.corrupt` 后，下一次 `load()` 无条件 `saveResource`，静默写回出厂模板，覆盖服主的商品/价格/`currency.name`/`npc.name`/`gui.title` |
| 修法 | **(a) + (b) 合体**：给 shop 模块引入 `YamlFileGate`（项目既有通用设施），并在「文件不存在」分支前置「是否处于隔离态」判定 |
| 改动文件 | `src/main/java/com/hilltopvillage/shop/ShopConfigLoader.java`（唯一生产文件）<br>`src/test/java/com/hilltopvillage/shop/ShopConfigQuarantineRebuildTest.java`（新增，8 条） |
| 新测试 | 8 条，全部通过 |
| shop 包测试 | 186 tests / 0 failures |
| 未 commit、未 `git add` | 是 |

---

## 一、为什么选这个修法

### 三个选项的取舍

**(a) 引入 `YamlFileGate`** —— 采用。项目已有该设施，且它正是为这条杀伤链设计的：
`YamlFileGate` 的类注释第 22-26 行明确写着

> 「为什么读盘后『文件不存在』不能解除锁定」：读盘被判不可用时，`YamlFiles.load` 会把文件挪成
> `*.corrupt`。此后 `load()` 只能得到 `Status.ABSENT`…… 若照搬「usable 就可写」，那么损坏文件被
> 隔离后，**下一次写盘前的重读**就会看到 ABSENT 并放行，用一个空配置覆盖磁盘 —— 降级被自己的
> 隔离动作绕过。

这与本缺陷是**逐字对应**的同一条路径，只是发生点从「写盘前重读」变成「load 的 saveResource」。
照抄既有设施而不是自创 boolean，符合任务要求，也让 shop 与 `ArenaManager` / `ConfigManager` 语义一致。

**(b) 检测 `shop.yml.corrupt` 是否存在** —— 也采用，因为 `YamlFileGate` 的进程内闩**只在单进程内有效**。
评审指出链条的最后一步发生在**重启之后**，而重启后闸门实例是全新的、`readOnly=false`。
纯 (a) 修不了重启路径。`.corrupt` 是磁盘信号，跨进程成立。

**(c) 静态标记 `NODES_READ_ONLY` 同款** —— 不采用。它只在单进程有效，与 (b) 组合后语义等同于
`YamlFileGate` 的 `readOnly` 字段，但后者还额外提供「拒写时只 warning 一次」等行为，且是项目既有约定。
另造一个静态集合会造成「arena/config 用 gate、shop 用静态集合」的不一致。

### 最终判据

```java
private boolean isQuarantined(File file) {
    return gate.isReadOnly() || corruptFile(file).exists();
}
```

两个信号**缺一不可**：

| 信号 | 覆盖的场景 | 单独使用时的漏洞 |
|---|---|---|
| `gate.isReadOnly()`（进程内闩） | 同进程第二次 `load()`；服主删掉 `.corrupt` 但未重启 | 重启后闩消失 → 模板照样写回（正是评审描述的最坏链条） |
| `shop.yml.corrupt` 存在（磁盘） | 重启后的首个 `load()` | 服主把 `.corrupt` 挪走/删除但没放回 `shop.yml` 时，同进程下一次 `load()` 会重建 |

两者都是**可区分**于「首次安装」的判据：首次安装的目录里既没有 `.corrupt`，闸门也从未锁定。

---

## 二、对照 `AdminDeployManager` 的照抄与不能照搬之处

### 照抄了什么

1. **「只读降级中不得从 JAR 模板重建」这条注释与规则本身**（`AdminDeployManager.java:226-231`）：
   ```java
   if (!gate.isReadOnly() && !arenasFile.exists()) { plugin.saveResource(...); }
   ```
   我在 `load()` 里把同一条件写成前置的早退分支（因为 shop 需要先拒绝再抛，而不是静默跳过重建）。

2. **`YamlFileGate` 而非自造 boolean**：与 `ArenaManager`（`:117` 构造、`:845` 的 `ensureFile`）
   和 `ConfigManager`（`:130-132`）三处既有用法一致 —— 每文件一份闸门、传 `null` validator
   （shop.yml 没有现成语义哨兵，且加了哨兵会扩大本次改动面）。

3. **失败文案要可操作**：参考 `YamlFileGate.writable()` 的 warning 形态（「Repair/restore it, then
   restart the server or run /hilltop reloadconfig」），shop 的隔离态文案同样点名 `.corrupt` 与恢复步骤。

### 为什么不能直接照搬

| 差异 | `arenas.yml` 的做法 | shop 为什么必须不同 |
|---|---|---|
| **闸门归属** | `AdminDeployManager.arenasGate()` 刻意不 new，从 `MultiArenaManager` 拿**共享**闸门（3 个写入方） | shop.yml **只有一个读者、零个写入方**（`grep saveResource("shop.yml")` 只有 `ShopConfigLoader:53` 一处）。共享闸门没有第二个使用方，反而会让 `ShopConfigLoader` 依赖 `ShopManager` 的构造顺序。故每 loader 持有自己的闸门。代价：若将来出现第二个 shop.yml 写入方，必须改成共享，否则「A 判只读、B 照写」重演。已在类注释里没有声明这一点，**这是本次的已知残留**（见第四节）。 |
| **失败后的行为** | `loadSpawnPoints()` 早退并**保留内存数据**，不抛（向导继续可用，只是拒写） | shop 没有「内存数据」可保留到下一次 `saveSpawnPoints`——`ShopManager.reload()` 是**覆盖式**赋值 `this.config = loader.load()`。若静默早退，`config` 会保持旧值，看似等价于「保留上一次」，但 `load()` 的返回类型是 `ShopConfig` 而非「成功/失败」，调用方 `HilltopCommandHandler:578-580` 会立刻 `getItems().size()` 并播报「已重载 N 件」。**静默降级会骗服主**。所以仍抛，由调用方决定。 |
| **文件被隔离后的第一个动作** | `AdminDeployManager` 的 `if (!loaded.usable() \|\| gate.isReadOnly())` 早退 | shop 的 `load()` 是**唯一的 saveResource 点**，必须在 saveResource **之前**判定，不能放在读盘之后——否则模板已经被写出来了。这是本缺陷与 arenas 的关键结构差异。 |
| **`ensureFile()` 的双保险** | `ArenaManager.ensureFile()` 在 `saveResource` 后再 `if (!arenasFile.exists()) createNewFile()` | 不照搬。`shop.yml` 若 `saveResource` 失败（JAR 缺资源）会让后续 `rawShopSection` 读不到文件并抛 IOException 包装的 ISE，服主能从异常信息看到原因；照搬 `createNewFile()` 会造出**0 字节文件**，反而触发 `YamlFiles` 的「空文件=SUSPECT」隔离，把首次安装变成一次假的损坏事件。 |

---

## 三、`onEnable` 抛异常导致插件禁用：为什么保持 (c)

**先读的两处 `catch (Throwable)`**（`HilltopVillagePlugin.java:100-116`）是给
`PlayerGoodsManager` / `StatsManager` 的，注释（`:100-104`）写明它们「已各自做文件级容错……且所有消费方
都经 getter 取用，失败置 null 可降级为『无物品快照 / 无统计』，不阻断对局本体」，而

> 「其余核心模块（MapRestoreManager / ShopManager / MultiArenaManager 等）**刻意不包裹**：
> 核心模块初始化失败就应当让启动失败并禁用插件，而不是带着半初始化的状态继续跑。」

shop 显然属于「核心模块」一侧：`ShopManager.getShopConfig()` 被 `ShopGUI` / `ShopListener` /
`NpcManager` 直接解引用，若为 null 会在玩家点开商店时 NPE —— 那比「插件禁用、服主看日志」更差。
因此选 **(c) 保持抛异常**：

- **(a) 改 `onEnable`** 明确超出文件范围；
- **(b) 不抛、保留上次配置** 无法在**首次启动**时工作（没有「上次」），且会让
  `/hilltop shop reload` 播报假的成功（见上表）。对 `onEnable` 场景更是会带着空 config 继续跑，
  与主类注释的约定相反。

本次修复把「插件禁用」这个**可接受**的后果保留，同时把「文件被搬走 + 静默写回模板」这个**不可接受**的
后果掐掉。插件禁用是可恢复的（修文件、重启）；覆盖配置是不可恢复的（服主手写的商品没了）。

---

## 四、新测试在改代码前的失败信息原文

命令：

```
JAVA_TOOL_OPTIONS=-Djdk.attach.allowAttachSelf=true build.cmd -o test \
  -Dtest=ShopConfigQuarantineRebuildTest -DfailIfNoSpecifiedTests=false
```

结果：`Tests run: 7, Failures: 4`（当时类内 7 条；后追加 1 条闸门控制组，现为 8 条）。

原文（`target/surefire-reports/com.hilltopvillage.shop.ShopConfigQuarantineRebuildTest.txt`）：

```
com.hilltopvillage.shop.ShopConfigQuarantineRebuildTest.secondLoadAfterQuarantineDoesNotRebuildFactoryTemplate -- Time elapsed: 4.785 s <<< FAILURE!
org.opentest4j.AssertionFailedError: 隔离后的 shop.yml 不存在，但这是「被搬走」而不是「首次安装」；此处若成功返回，说明 saveResource 写回了出厂模板，服主的商品/价格/货币名/NPC 名/GUI 标题已被出厂值覆盖 ==> Expected java.lang.IllegalStateException to be thrown, but nothing was thrown.
	at com.hilltopvillage.shop.ShopConfigQuarantineRebuildTest.secondLoadAfterQuarantineDoesNotRebuildFactoryTemplate(ShopConfigQuarantineRebuildTest.java:94)

com.hilltopvillage.shop.ShopConfigQuarantineRebuildTest.restartedLoaderDoesNotRebuildFactoryTemplateWhileCorruptSiblingExists -- Time elapsed: 0.102 s <<< FAILURE!
org.opentest4j.AssertionFailedError: 重启后的首个 load 若成功，就是把出厂模板写回了被隔离的 shop.yml —— 评审描述的「坏文件 → 插件禁用 + 文件被搬走 + 下次启动静默写回出厂模板」链条最后一步 ==> Expected java.lang.IllegalStateException to be thrown, but nothing was thrown.
	at com.hilltopvillage.shop.ShopConfigQuarantineRebuildTest.restartedLoaderDoesNotRebuildFactoryTemplateWhileCorruptSiblingExists(ShopConfigQuarantineRebuildTest.java:115)

com.hilltopvillage.shop.ShopConfigQuarantineRebuildTest.secondQuarantineStillThrowsAndStillDoesNotRebuild -- Time elapsed: 0.139 s <<< FAILURE!
org.opentest4j.AssertionFailedError: 第二次隔离后的 load 同样不得重建模板 ==> Expected java.lang.IllegalStateException to be thrown, but nothing was thrown.
	at com.hilltopvillage.shop.ShopConfigQuarantineRebuildTest.secondQuarantineStillThrowsAndStillDoesNotRebuild(ShopConfigQuarantineRebuildTest.java:201)

com.hilltopvillage.shop.ShopConfigQuarantineRebuildTest.quarantineFailureMessageNamesTheQuarantineFile -- Time elapsed: 0.173 s <<< FAILURE!
org.opentest4j.AssertionFailedError: 隔离态下继续拒绝加载 ==> Expected java.lang.IllegalStateException to be thrown, but nothing was thrown.
	at com.hilltopvillage.shop.ShopConfigQuarantineRebuildTest.quarantineFailureMessageNamesTheQuarantineFile(ShopConfigQuarantineRebuildTest.java:214)

[INFO] Results:
[ERROR] Tests run: 7, Failures: 4, Errors: 0, Skipped: 0
[ERROR] BUILD FAILURE
```

失败形态高度一致：`Expected java.lang.IllegalStateException to be thrown, but nothing was thrown`
—— 即**第二次 `load()` 成功返回**，证明出厂模板确实被写回并解析成了 16 件商品。
这正是本回归的病灶，不是断言写错。

另外 3 条（`firstInstallStillWritesFactoryTemplate`、`adminRepairedFileLoadsAfterQuarantine`、
`deletingCorruptSiblingAllowsFactoryReset...` 的保护侧）在改代码前**已经通过**，这是刻意的：
它们是「防修过头」的控制组，必须在**修复前后都绿**，否则说明修复污染了正常路径。

---

## 五、最终测试数

| 命令 | 结果 |
|---|---|
| `-Dtest=ShopConfigQuarantineRebuildTest` | **8 tests / 0 failures** |
| `-Dtest='com.hilltopvillage.shop.*Test'` | **186 tests / 0 failures** |
| 全量 `build.cmd -o test` | `925 tests / 5 failures / 5 errors / 1 skipped` —— **剩余 10 个失败全部在本任务范围之外** |

### 关于全量的 10 个失败（诚实记录）

它们**不是本改动引入的**，全部位于其他并发编辑中的文件：

- `CommandsDocumentConcurrencyTest` / `CommandsDocumentFallbackTest`（5 个）—— 断言
  `CommandsDocumentGenerator` 里存在一个尚不存在的 `moveIntoPlace(Path, Path, AtomicMover, Consumer)`
  方法。这是另一个 agent 正在改写的 `doc/CommandsDocumentGenerator.java` 的进行中状态。
- `PlayerGoodsManagerTest`（5 个）—— `NoClassDefFound com/hilltopvillage/core/PlayerGoodsManager$Snapshot`，
  编译产物与源码不同步（同一轮并发编辑的 `target/` 脏产物）。

证据：本任务开工时 `git status` 已显示 `src/main/java/com/hilltopvillage/doc/CommandsDocumentGenerator.java`、
`src/main/java/com/hilltopvillage/config/ConfigManager.java` 等 14 个文件为 `M`，均非本任务触碰。
在同期的一次 shop 包全量运行中（`-Dtest='com.hilltopvillage.shop.*Test'`）186 条全绿；
在更早的一次全量运行中，`ShopConfigMaterialValidationTest` / `ShopConfigPriceValidationTest` 的 3 条
也曾失败，随后因为并发 agent 把它们改成了相反期望而自行转绿 —— 进一步证明这些失败来自并发编辑而非本改动。

**本任务对「905 基线」的净贡献**：+8 测试。shop 模块内 186 / 0。

---

## 六、诚实评估：还剩什么风险

### 6.1 「首次安装」与「被隔离」的区分够可靠吗？

**大部分可靠，有三个明确定义的缺口：**

1. **`.corrupt` 被服主删除、且进程已重启、且没有放回 `shop.yml`** → 会被当成首次安装并重建模板。
   这个组合下**没有任何信息**能区分两者（磁盘、进程内存全为空）。判定为「显式重置」是合理设计：
   服主亲手删掉了唯一的现场，且重启过。**但危险在于它可能与「服主挪走 .corrupt 去比对、忘了放回」重叠。**
   缓解：隔离瞬间的 SEVERE 日志（由 `YamlFiles.quarantine` 打出）会明确写
   `renamed to shop.yml.corrupt`，且 `quarantinedMessage` 在每次拒绝时重复提示恢复步骤。
   短期缓解（同进程）由 `gate.isReadOnly()` 兜住。

2. **`.corrupt` 属于**上一次**损坏事件，本次是合法的「首次安装式重置」** → 会被误判为隔离态并拒绝加载。
   场景：服主三个月前坏过一次、留下了 `.corrupt`，今天主动删掉 `shop.yml` 想重置。
   代价是**误拒**（插件禁用 + 明确指路），不是数据损坏 —— 与「误放行」的代价（配置被覆盖）不对称，
   方向正确。服主删掉 `.corrupt` 后重启即可。

3. **`YamlFiles.quarantine` 用 `REPLACE_EXISTING`** → 若上一次 `.corrupt` 还在、这次又坏，
   上次的现场被覆盖。这是 `YamlFiles` 的既有决策（其注释：「保留『最新一次现场』比堆一串历史上更有用」），
   本任务未改，但意味着**第二次损坏会丢掉第一次的现场**。

### 6.2 其他残留风险

- **闸门未共享**：`ShopConfigLoader` 自持一份闸门。当前 `shop.yml` 只有这一个读者、零个写入方，
  没有「A 判只读、B 照写」的可能。**若将来给 shop.yml 加写入方（如游戏内改价 GUI），
  必须先把闸门提升为共享实例**，否则本类注释承诺的保证会悄悄失效。这条已写进类注释，
  但**没有测试能拦住将来新增的写入方**。

- **`rawShopSection()` 在小窗口内仍可抛**：截断检测在读盘（`gate.load()`）**之后**又用 snakeyaml
  裸读一次文件。若文件在这两次读之间被外部改写/删除，会抛 `IllegalStateException`（包装 IOException）。
  后果是「拒绝加载」，方向安全（不会空店、不会覆盖），但文案会指向「could not be inspected」
  而不是「文件不见了」。属既有行为，本次未改。

- **`onEnable` 仍会禁用插件**：这是刻意保留的（见第三节）。服主看到的体验仍是「服务器起来但插件红了」，
  只是现在日志里有明确指路（`shop.yml.corrupt` + 恢复步骤），且**他的配置还在**。
  真正的「插件不禁用、商店降级为空但可修」需要改 `HilltopVillagePlugin` + 给 `ShopManager` 加
  「保留旧快照」语义，超出本次单文件边界。

- **重启路径的测试是「新 loader 实例」模拟，不是真进程重启**。两者对
  `YamlFileGate.readOnly`（实例字段，新实例必为 false）等价，对 `.corrupt`（磁盘）也等价，
  所以语义上足够；但它不能证明 `MockBukkit` 之外的类加载/静态状态行为。已尽量贴近。

- **`corruptFile()` 的父目录假设**：`file.getAbsoluteFile().getParentFile()` 在
  `getDataFolder()` 非空时总是非 null（Bukkit 契约），但没有显式 null 检查。
  若某天 `getDataFolder()` 返回相对路径且 `getParentFile()` 为 null 会 NPE。与
  `YamlFiles.quarantine` 的写法完全一致（那里也没判 null），保持一致优先。
