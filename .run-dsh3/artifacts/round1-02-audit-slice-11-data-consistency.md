# round1 深挖（audit）— slice-11 / data-consistency

- trace_id：`trace-r1-20260215-hilltop-dsh3` / round_id：`round1`
- slice_id：`slice-11` / dimension：`data-consistency`（只报这一个维度）
- agent_id：`audit-slice-11-data-consistency`
- 被审仓库（只读）：`D:\Server\MCServers\Server plugin\Hilltop Village\Hilltop Village Plugin`
- 切片文件：`ConfigManager.java`（实测 2133 行）、`ConfigPermission.java`（22 行）
- shared_dependencies：`GameConfig.java`、`YamlFileGate.java`、`YamlFiles.java`
- 控制流/自检补充读取：`MainConfigMenu.java`、`VillagerSystem.java`、`ConfigManagerTest.java`、`ConfigLoadClampTest.java`、`YamlNullMechanismTest.java`
- 结论：**5 条 CONFIRMED**（1 HIGH / 3 MEDIUM / 1 LOW），**0 条 NO_EVIDENCE_FOUND**；6 条 lead 全部处置（5 升级 + 1 判「不构成本维度缺陷」）。

## 0. 结论摘要

| finding | 严重性 | 位置 | 一句话 |
|---|---|---|---|
| F-slice-11-data-consistency-01 | HIGH | `ConfigManager.java:1425` | reload 失败分支无条件推进 `lastSavedSnapshot`，内存中未落盘的 GUI 改动被洗成「已保存」，保存按钮熄灭且无关服兜底 |
| F-slice-11-data-consistency-02 | MEDIUM | `ConfigManager.java:1442` | `contains()` 与 `getString()` 不互斥：非字符串标量 → `null` 写入 `worldName`，下一次保存把磁盘键删掉；同形态另有 5 处 |
| F-slice-11-data-consistency-03 | MEDIUM | `ConfigManager.java:1469` | `villager-health` 无归一化：`.nan`/`.inf`/负值原样进 `GameConfig` 并写回磁盘，同文件同类键有专门 clamp |
| F-slice-11-data-consistency-04 | MEDIUM | `ConfigManager.java:644` | `Number.intValue()` 无上界与整数性校验：1e18 饱和成 `Integer.MAX_VALUE`、小数截断、NaN→0，全部零诊断 |
| F-slice-11-data-consistency-05 | LOW | `ConfigManager.java:1577` | 载入中途用开头的整份 YAML 全量写盘做旧键迁移，不经过 `saveToFile` 的 mtime 外部修改检测（另见 1695） |

## 1. 线索处置（L1–L6，逐条）

| lead | 原判维度/置信 | 处置 | finding / 去向 | 本回合重读后的依据 |
|---|---|---|---|---|
| L1 `:1425` 失败分支推进快照 | data-consistency / HIGH | **CONFIRMED** | F-slice-11-data-consistency-01（HIGH） | `:1425` 在 `:1419` 的三合一失败条件后**无条件**执行，紧接着 `:1426 return false`。这是 `loadFromFile()` 唯一的 `false` 返回点，不存在「失败但不推进」的路径；`hasUnsavedChanges()`（`:339-345`）只比内存与快照，推进即变干净 |
| L2 `:1442` contains 真但 getString null | data-consistency / HIGH | **CONFIRMED（机制修正）** | F-slice-11-data-consistency-02（MEDIUM） | 机制成立，但 sweep 举的「空值」不触发：YAML 的 null 值会被 `YamlConfiguration` 整个丢弃（本仓库 `YamlFiles.java:351-356` 有同款说明），`contains()` 为 false。真正触发的是**非字符串标量/段**（如 `world-name: 123`）。另：sweep 说「消费者是 `Bukkit.getWorld(...)`」系误归属——那些 `getWorldName()` 命中全是 `ArenaDefinition`，`GameConfig#getWorldName` 在 `src/main/java` 内的唯一读取点是 `:851` 的写盘 |
| L3 `:1469` villager-health 无闸门 | data-consistency / MEDIUM | **CONFIRMED** | F-slice-11-data-consistency-03（MEDIUM） | `:1469` 裸 `getDouble`；`mergeExternalChanges()` 的 `:441-444` 同样裸取。对照 `:776-784` 的 `normalizeExplodeDamageMultiplier` 与 `:762-769` 的另两个 normalize，确认是「逐键手写 clamp 漏了一键」 |
| L4 `:644` readWaveInt 溢出/小数 | data-consistency / MEDIUM | **CONFIRMED** | F-slice-11-data-consistency-04（MEDIUM） | `:639-643` 只挡「非 Number」，`:644` 直接 `intValue()`，`:645-648` 只挡负数；饱和/截断/NaN 三条都不进 `problems`，故 `:1930-1933` 的汇总 warning 不会出现 |
| L5 `:1577` 载入中途全量写盘 | data-consistency / MEDIUM | **CONFIRMED（降为 LOW）** | F-slice-11-data-consistency-05（LOW） | `:1577` 与 `:1695` 两处 `settingsGate.write(settingsYaml)` 前均无 `lastModified` 比对（对照 `:840` 的保存路径有）。窗口是「`:1414` 读盘 → `:1577` 写盘」之间的解析耗时，写入内容又是刚读到的磁盘快照减去旧键，故影响面小 |
| L6 `:2006` 半份 reload 报成功 | contract / MEDIUM | **REFUTED（本维度）** | `off_dimension_notes[0]` | 该观察指向返回值契约（`loadMonstersConfig()` 为 void，`loadFromFile()` 仍返回 true），不是「磁盘与内存的数据不一致」：怪物闸门只读/文件不可用时 `saveMonstersConfig()` 会拒写（`:1044-1046`），磁盘内容保持不变。按维度隔离纪律不塞进 findings |

## 2. `loadFromFile()` 的分支与快照推进点（逐条走完）

| 行 | 分支 | 条件 | 动作 | 快照是否推进 |
|---|---|---|---|---|
| 1405–1410 | defaultWave 空值修复 | `getDefaultWave() == null`（标注 unreachable） | 用新 `GameConfig` 模板补回 | 否 |
| 1413 | 展示配置 | 无条件 | `loadDisplayConfig()` | 否 |
| 1414 | 读 game-settings | 无条件 | `settingsGate.load()`（可能隔离并上闩） | 否 |
| **1419–1426** | **失败早退** | `!loaded.usable() \|\| status == ABSENT \|\| settingsGate.isReadOnly()` | `settingsLoadedFromDisk=false`；`loadMonstersConfig()`；**`:1425 lastSavedSnapshot = activeConfig.snapshot();`**；`:1426 return false` | **是（无条件）** |
| 1428–1440 | 成功读盘 + 重建 | 上条不成立 | `settingsYaml = loaded.config()`；`activeConfig = new GameConfig()`；清 `loadTimeNormalizationPending` | 否（此刻） |
| 1442–1770 | 逐键读取 | 各自 `contains` / `isSet` / `isList` 守卫 | 写 `activeConfig` | 否 |
| 1544–1585 | 旧键迁移写盘 | 存在 `nodes.repair-item` / `nodes.repair-amount` | `:1577 settingsGate.write(settingsYaml)`；成功才更新 `settingsLastModified` | 否 |
| 1660–1703 | 旧键迁移写盘 | 存在 `shop.currency-drop-amount` | `:1695 settingsGate.write(settingsYaml)` | 否 |
| 1955 | 怪物配置 | 无条件 | `loadMonstersConfig()`（void；内部失败只 SEVERE 后 return） | 否 |
| 1957 | 成功路径快照 | 走到这里 | `lastSavedSnapshot = activeConfig.snapshot();` | 是 |
| 1964 | 成功返回 | — | `return true` | — |

补充两点（决定「异常分支」的结论）：

1. `loadFromFile()` 全程**没有 try/catch**：`1442–1953` 之间若抛出未预期的 `RuntimeException`，`:1425`/`:1957` 都不会执行，异常直接抛给调用方（`MainConfigMenu:151` 未捕获，菜单不会 `reopen()`）。也就是说，**「失败」只有两种形态：受控早退（必推进快照）与异常逃逸（不推进、但也没有 `return false`）**。
2. 早退分支的三合一条件里，`ABSENT` 是唯一「闸门仍可写」的情形（`YamlFileGate.load()` 对 ABSENT 不改 `readOnly`，见 `YamlFileGate.java:52-62`）。因此 `:1425` 之后并非「反正也存不了」：文件被外部删除后保存本来可以成功，但保存按钮已经被 `hasUnsavedChanges()==false` 藏掉了。

## 3. 发现详情

### F-slice-11-data-consistency-01（HIGH）reload 失败把「内存」写成「已落盘基线」

**证据（本回合 read，`ConfigManager.java:1425`）**：`lastSavedSnapshot = activeConfig.snapshot();`

- 条件在 `:1419`：`if (!loaded.usable() || loaded.status() == YamlFiles.Status.ABSENT || settingsGate.isReadOnly()) {`
- 该分支没有写入任何文件，却在 `:1425` 把快照推进到当前内存，`:1426` 立刻 `return false`。

**推断**：`hasUnsavedChanges()`（`:339-345`）的判据是 `!activeConfig.snapshot().equals(lastSavedSnapshot)`（外加 `loadTimeNormalizationPending`）。`:1425` 之后两者相等，方法返回 false。`MainConfigMenu:96` 正是用这个返回值决定渲染 LIME_WOOL「保存」还是 GREEN_WOOL「已是最新」（`:126-128`）。链路是：管理员先在 GUI 改了若干项（未保存）→ 执行「重新加载」（`MainConfigMenu:151` 或 `/hilltop reloadconfig`，`HilltopCommandHandler:422`）→ 配置文件恰好不可用/被删/已只读 → 界面提示「重载失败」（`:156-161`）→ `reopen()` 后保存按钮**同时消失**，此前的改动再也没有入口可保存。全库 `saveToFile()` 的调用点只有菜单保存（`MainConfigMenu:106`）、`HilltopCommandHandler:626`、`SetupWizard:1680/1704`，**没有关服或定时兜底**，因此这些改动在重启后静默丢失。

值得注意：仓库自己的测试 `ConfigManagerTest:93-96` 已把这条不变式写成断言（「monsters 落盘失败时快照不得推进，否则保存按钮熄灭、这批改动永远不再重试」），`MainConfigMenu:119-120` 的注释也写着「失败时 `hasUnsavedChanges()` 仍为 true（快照未推进）」——两处都只对 `saveToFile()` 成立，`loadFromFile()` 的失败分支恰好违反同一不变式且无测试覆盖。

**alternatives（HIGH 需 ≥2）**

1. 如果进入该分支前内存与 `lastSavedSnapshot` 本就相等（管理员没做过未落盘编辑），推进快照无副作用，问题不成立——需检查重载前是否调用过任何 `activeConfig` setter 或 GUI 编辑入口（`MainConfigMenu:106` 之外）。
2. 如果管理员在重载失败后又通过其它显式入口（`HilltopCommandHandler:626` / `SetupWizard:1680`）触发一次保存，改动仍会落盘、损失被缓解——需检查这些入口分别由哪条命令或向导步骤可达。

### F-slice-11-data-consistency-02（MEDIUM）`contains()` + `getString()`：真值守卫放进 null

**证据（本回合 read，`ConfigManager.java:1442`）**：`if (settingsYaml.contains("world-name")) activeConfig.setWorldName(settingsYaml.getString("world-name"));`

**推断**：`contains(path)` 的语义是「`get(path)` 非 null」，`getString(path)` 的语义是「值 `instanceof String` 才返回，否则 null」。两者之间有一整个缝隙：数字、布尔、段都能让 `contains` 为真而 `getString` 返回 null。于是 `world-name: 123`（或 `world-name: {x: y}`）会把 `null` 写进一个刚在 `:1437` 重建、本来持有合法默认值 `"world"` 的字段。保存时 `:851 settingsYaml.set("world-name", activeConfig.getWorldName())` 收到 null，而 Bukkit 的 `set(path, null)` 是**删键**——磁盘上那一行连同管理员的输入一起消失，全程零 warning；下一次载入 `contains` 为 false，回落到默认 `"world"`，形成「磁盘值 → null → 键消失 → 默认值」的静默改写链。

同一种写法在本方法还有 5 处：`:1487`（`hammer.itemsadder-id`）、`:1499`（`hammer.item-name`）、`:1517`（`nodes.repair-cost-name`）、`:1645`（`fireball.item-name`）、`:1752`（`monsters.*.display-name`）。对照 `:1477-1486`（`hammer.material`）与 `:1518-1529`（`nodes.repair-cost-item`）——那两处是「先 `getString` 判 null，再 `Material` 判合法，非法就 warning 并保留默认」，说明作者知道该怎么写，只是这一族没套用。`:1487` 的同类实例还有运行期后果：`HammerListener:97` 是 `cfg.getHammerItemsAdderId().isEmpty()`，null 会直接 NPE（需 `hammer.use-itemsadder: true`）。

严重性定 MEDIUM 而非 HIGH：`GameConfig#getWorldName` 在 `src/main/java` 内**没有运行期消费者**（唯一读取点是 `:851` 的写盘），故 `world-name` 这一实例的后果限于「磁盘键被删 + 内存值对象含 null」；`hammer.itemsadder-id` 的 NPE 路径虽然存在，但需要非字符串输入且开关打开。

**alternatives**

1. 如果所用服务端的 `MemorySection#contains` 内部走的是 `getString` 而不是 `get`，非字符串值不会进入该分支，问题不成立——需核对服务端 `MemorySection` 实现；本仓库 `YamlFiles.java:351-356` 只证明了「null 值被丢弃」（因此空值确实不触发），未覆盖数字/布尔标量。
2. 如果 `GameConfig#getWorldName` 的消费者（含切片外代码）对 null 做了判空回退，则影响仅限于磁盘键被删、不会运行期失败——需对 `getWorldName` 做全仓检索（本回合 grep `src/main/java` 仅命中 `GameConfig:671` 与 `ConfigManager:851`）。

### F-slice-11-data-consistency-03（MEDIUM）`villager-health` 缺 NaN/Infinity 闸门

**证据（本回合 read，`ConfigManager.java:1469`）**：`if (settingsYaml.contains("villager-health")) activeConfig.setVillagerHealth(settingsYaml.getDouble("villager-health"));`

**推断**：SnakeYAML 会把 `villager-health: .nan` / `.inf` 解析成 `Double.NaN` / `Double.POSITIVE_INFINITY`，`getDouble` 原样返回，`setVillagerHealth` 原样收下。同文件对同类风险键都有专门闸门：`:776-784` 的 `normalizeExplodeDamageMultiplier`（显式挡 NaN、+Infinity、负值并夹到 0..10）、`:762-764` 的 `normalizeVictoryWaves`、`:767-769` 的 `normalizeRepairCostAmount`；唯独 `villager-health` 在**载入**（`:1469`）与**外部修改合并**（`:441-444`）两条路径上都是裸取。更糟的是 `:861 settingsYaml.set("villager-health", activeConfig.getVillagerHealth())` 会把 NaN 写回磁盘（SnakeYAML 输出 `.NaN`），使非法值在「保存 → 重载」之间自我固化。

消费者是 `VillagerSystem:121`，随后 `:142-144` 用 `Math.max(1.0, health)` 兜底——但 `Math.max(1.0, Double.NaN)` 按 Java 规范仍返回 `NaN`：负值能被兜住，NaN/Infinity 不能。NaN 最终进入 `AttributeInstance#setBaseValue` / `LivingEntity#setHealth`；这两者对非有限值的处置取决于服务端实现（Paper 各版本有差异），因此本条只把「配置值域被污染并回写磁盘」作为确认结论，运行期异常列为待验证分支。

**alternatives**

1. 如果所用 Paper 版本在 `setBaseValue`/`setHealth` 前对 NaN/Infinity 做了钳制或忽略，运行期异常不成立，但 `.nan` 仍会在内存与磁盘间往返——需检查 `VillagerSystem:140-144` 与对应服务端实现。
2. 如果该版本的 YAML 解析器把 `.nan`/`.inf` 当字符串而非 Double，`getDouble` 会回落 0.0，该路径不成立——需用 `YamlConfiguration.loadFromString("villager-health: .nan")` 实测（本回合受零写入约束未运行）。

### F-slice-11-data-consistency-04（MEDIUM）`readWaveInt` 的饱和、截断与 NaN

**证据（本回合 read，`ConfigManager.java:644`）**：`int value = number.intValue();`

**推断**：`readWaveInt` 在 `:639-643` 只排除「不是 Number」，在 `:645-648` 只排除负数，中间这一步把 `Number` 直接压成 `int`，三种失真全部静默：

- `total-mobs: 1e18` → `Double.intValue()` 按 JLS 5.1.3 饱和为 `Integer.MAX_VALUE`（2147483647）；
- `count: 1.9` → 截断为 1（小数部分无声消失）；
- `total-mobs: .nan` → 转为 0，恰好落进「本波不刷怪」的语义，却不会被 `:645` 的负数分支接住。

这三种都不会向 `problems` 写条目，因此 `:1930-1933` 的 `numericProblems` 汇总 warning 保持沉默——管理员看到的是一份「加载成功、无任何提示」的配置，而内存值与磁盘值已经不同。方法 javadoc（`:614-630`）声称把「缺键 / 非数值 / 负数」三种非法形态显式化，实现与之一致，但溢出、小数、NaN 属于同一问题域里未被覆盖的三类。

**alternatives**

1. 如果所有波次数值都只能由 GUI 写入且 GUI 已限制范围，手写 `1e18` 才是唯一触发方式，暴露面较小——需检查 `WaveSettingsMenu` 的输入校验（本切片外）。
2. 如果 SnakeYAML 把 `1e18` 解析成 `Long`/`BigInteger` 而非 `Double`，`intValue()` 的截断规则不同，但「静默失真」的结论不变——需实测该字面量的解析类型后再定影响面。

### F-slice-11-data-consistency-05（LOW）载入中途的全量写盘绕过 mtime 检测

**证据（本回合 read，`ConfigManager.java:1577`）**：`if (settingsGate.write(settingsYaml)) {`

**推断**：`:1577`（`nodes.repair-item` 迁移）与 `:1695`（`shop.currency-drop-amount` 迁移）都在 `loadFromFile()` 内部直接写盘，写入的是 `:1428` 读到的整份 `settingsYaml`。`saveToFile()` 在写前会比对 `settingsFile.lastModified()` 与 `settingsLastModified`（`:840-849`），发现外部修改就先 `mergeExternalChanges()`；这两处迁移写盘没有这道检查，也不经过 `mergeExternalChanges()`。若在 `:1414` 读盘与 `:1577` 写盘之间有人（编辑器/另一进程）改了文件，改动会被整份旧内容覆盖，且写成功后 `:1579` 立即把 `settingsLastModified` 对齐到新 mtime，后续保存也不会再发现。

定 LOW 的理由：窗口是同一次方法调用内的解析耗时（毫秒级），且写入内容除迁移键外逐字来自刚读到的磁盘快照，不会引入内存旧值；`YamlFiles.write`（`111-131`）用同目录临时文件 + `ATOMIC_MOVE`，不存在半截文件。这是一条「纪律不一致 + 极小窗口」，不是可直接利用的数据覆盖。

**alternatives**

1. 如果 `/hilltop reloadconfig` 与 `loadFromFile()` 只在服务器启动或主线程空闲时执行，且管理员不可能在同一毫秒内保存文件，窗口实际不可利用——需检查 `HilltopCommandHandler:422` 的调用上下文与文件编辑工具的时间尺度。
2. 如果 `:1577` 之前对 `settingsYaml` 的所有 `set` 都只涉及迁移键（本回合核对 `:1544-1576`：仅 `nodes.repair-cost-item` / `nodes.repair-amount-per-cost` 与两个 null），则除窗口内的外部改动外不会引入其它偏差——这一条成立，故严重性不再上调。

## 4. 覆盖、检查清单与自检

### 4.1 读过的文件

| 文件 | 角色 | 是否产出独立 finding |
|---|---|---|
| `src/main/java/com/hilltopvillage/config/ConfigManager.java` | 切片主体 | 是（5 条） |
| `src/main/java/com/hilltopvillage/config/ConfigPermission.java` | 切片主体 | 否（枚举 6 节点与 `plugin.yml:30-51` 全对齐） |
| `src/main/java/com/hilltopvillage/config/GameConfig.java` | shared dependency | 否（`snapshot()` 深拷贝完整，`equals` 字段集与 `snapshot` 一致） |
| `src/main/java/com/hilltopvillage/util/YamlFileGate.java` | shared dependency | 否（`ABSENT` 不解锁的行为已核对 `52-62`） |
| `src/main/java/com/hilltopvillage/util/YamlFiles.java` | shared dependency | 否（原子写 + 隔离逻辑已核对 `111-131`、`166-178`） |
| `src/main/java/com/hilltopvillage/config/menu/MainConfigMenu.java` | 直接调用方（控制流） | 否（`:96`/`:126-128`/`:151-162` 用于 F-01 的调用链） |
| `src/main/java/com/hilltopvillage/mechanics/VillagerSystem.java` | 直接调用方（控制流） | 否（`:121`/`:142-144` 用于 F-03 的影响面） |
| `src/test/java/com/hilltopvillage/config/ConfigManagerTest.java` | 自带自检抽验 | 否（`:68-97` 只覆盖 save 侧快照门控） |
| `src/test/java/com/hilltopvillage/config/ConfigLoadClampTest.java` | 自带自检抽验 | 否（覆盖 victory/repair/explode，未覆盖 villager-health） |
| `src/test/java/com/hilltopvillage/config/YamlNullMechanismTest.java` | 自带自检抽验 | 否（零断言，见 4.3） |

### 4.2 维度检查清单

| # | 模式 | 结果 | 说明 |
|---|---|---|---|
| 1 | 返回值暴露内部状态 | 未命中 | `GameConfig#getNodeBuffEffects`/`getStarterKitItems` 返回内部容器，但切片内唯一写入方是 `ConfigManager` 自身的载入逻辑（`:1604-1605`、`:1720`），无外部调用方就地改写；`snapshot()` 对集合与元素逐项深拷贝（`GameConfig:631`、`:664-667`） |
| 2 | 同族函数守卫一致性 | 命中 | 材质族有 null+`isItem` 双判（`:1477-1486`、`:1518-1529`），`world-name` 只有 `contains`（F-02）；`explode-damage-multiplier` 有 normalize（`:776-784`），`villager-health` 没有（F-03） |
| 3 | 数值边界 | 命中 | `intValue()` 无上界与整数性检查（F-04）；`villager-health` 无非有限值闸门（F-03） |
| 4a | 原型链/裸下标 | 不适用 | Java 实现；外部键只经 `ConfigurationSection#getKeys` 进入 `LinkedHashMap`，无 `obj[key]` 式反射查表 |
| 4b | 假值 vs 缺值 | 命中 | `contains` 被当作「有值」使用（F-02）；正确用法 `isSet` 出现在 `:1595`（buff-effects）与 `:1712`（starter-kit.items） |
| 4c | NaN/Infinity/小数 | 命中 | F-03、F-04；`normalizeExplodeDamageMultiplier` 证明作者已知该风险 |
| 4d | 嵌套结构校验 | 未命中 | `monsters`/`waves` 段先 `getConfigurationSection` 判 null，再逐键类型守卫；`:1819-1836` 对「段头/标量/列表」三种形态分别告警；`:1849-1853` 有「解析后为空不清空」守卫 |
| 5 | 能力是否真实现 | 命中（部分） | `readWaveInt` 的 javadoc 覆盖声明与实现对得上（三类），但漏掉溢出/小数/NaN；clamp 家族逐键手写，因此漏一键（F-03） |
| 6 | 转义/编码顺序 | 不适用 | 本切片无多层转义/编码；`YamlFiles.write` 统一 UTF-8 单次写出 |
| 7 | 边界符号（负数/下标） | 未命中 | 负数在 `:645-648` 归 0；`waves` 键 `parseInt` 有 try（`:1788-1793`、`:1887-1891`）；`starter-kit` 数量 `Math.max(1, amount)`（`:721`） |
| 8 | 引用绑定是否存在 | 未命中 | 全部符号编译期解析；`PotionEffectType.getByName` 有 null 判（`:372-376`）；未发现「调用了未导入的名字」形态 |
| 9 | YAML 写入成对性 / 原子写 / 部分写入 | 命中 | 原子写本身合格（`YamlFiles.java:111-131`）；但迁移写盘绕过 mtime 检测（F-05）。`set`+`save` 在 `saveToFile` 内成对，失败路径返回 false |

### 4.3 三项必做自检

**标识符对账（DONE）**：`ConfigPermission` 的 6 个权限节点与 `plugin.yml:30-51` 逐一比对，6/6 全部声明、差集为空（`hilltopvillage.config.admin/rules/waves/monsters/items/nodes`）。`saveToFile()` 写集合（`:851-996`）与 `loadFromFile()` 读集合（`:1442-1770`）对账：`world-name`、`villager-health` 等为 `contains`+`getString/getDouble` 形态（F-02/F-03）；`hammer.tier.low.charge`（`:879`）与 5 个 `hammer.damage-*`（`:1979-1983`）是双向墓碑，读写两侧一致，属刻意漂移而非漏配。

**自带自检抽验（DONE）**：项目无 `check-*.mjs` 类脚本，自检载体是 JUnit。抽验 3 个：

- `ConfigManagerTest:68-97`：有真实断言（`assertFalse(saved)` + `assertTrue(hasUnsavedChanges())`），并对「快照不得在失败时推进」给了与 F-01 完全相同的理由；但只覆盖 `saveToFile()` 的 monsters 失败，**没有覆盖 `loadFromFile()` 的早退分支**——F-01 正好落在该缺口，故本测试不构成反证。
- `ConfigLoadClampTest`：5 个用例对 `victory-waves`/`repair-cost-amount`/`explode-damage-multiplier` 的上下界与 ±Infinity 都有断言（`:79-151`），有效；但 `villager-health` 不在覆盖范围，故不构成对 F-03 的反证。
- `YamlNullMechanismTest`：3 个测试**全部只有 `System.out.printf`，零 `assert`/`fail`**，永远不会变红；且 `getString=%s` 对 `String "null"` 与 `null` 打印同形（都是 `null`），无法区分二者——它声称要验证的 `contains==true / getString==null` 机制其实从未被真正断言过。按 §4.7 判 `UNRELIABLE_SELF_CHECK`，其输出不得采信。

**运行时验证（SKIPPED）**：任务书禁止 maven/gradle 构建（会写 `target/`，破坏零写入），本机也没有可启动的 Paper 服务端，因此 `.nan` 解析、`contains/getString` 实测、`setHealth(NaN)` 行为均未运行；对应的验证方法已逐条写入各 finding 的 `alternatives`。

## 5. 维度外观察（不进 findings）

1. **L6 / contract**：`loadMonstersConfig()` 返回 `void`，`monsters-config.yml` 不可用或闸门只读时只打一条 SEVERE 就 return（`:2006-2010`），`loadFromFile()` 随后照常 `loadMonstersConfig(); ... return true`（`:1955`、`:1964`）。调用方 `MainConfigMenu:151-161` 与 `HilltopCommandHandler:422` 据此宣告「已重载」，实际是「game-settings 生效、monsters-config 静默未生效」，且 `:1957` 把这份「默认怪」快照成基线。属返回值契约缺陷，建议由 contract/error-handling 维度接手。
2. **error-handling**：`loadFromFile()` 无 try/catch，`:1442-1953` 的未预期异常会直接抛给 `MainConfigMenu:151` 的点击处理器（未捕获、菜单不 reopen），且快照不推进。
3. **error-handling**：`VillagerSystem:142-144` 用 `Math.max(1.0, health)` 兜底，对 NaN 无效；`setBaseValue`/`setHealth` 收到 NaN 的行为依赖服务端版本，需运行期确认。
4. **contract/style**：`ConfigPermission.description` 有赋值无 getter，是死字段（不影响权限判定）。
5. **test-quality**：`YamlNullMechanismTest` 零断言且输出歧义（详见 4.3），属「自带自检本身不可靠」，不是产品代码缺陷。

## 6. 产物信封

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "audit-slice-11-data-consistency",
  "role": "audit",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/.run-dsh3/artifacts/round1-02-audit-slice-11-data-consistency.md",
  "payload": {
    "slice_id": "slice-11",
    "findings": [
      {
        "finding_id": "F-slice-11-data-consistency-01",
        "severity": "HIGH",
        "dimension": "data-consistency",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/config/ConfigManager.java",
          "line": 1425,
          "quote": "lastSavedSnapshot = activeConfig.snapshot();"
        },
        "inference": {
          "claim": "当 game-settings.yml 不可用、不存在或闸门只读时，loadFromFile() 在未写入任何文件的情况下把 lastSavedSnapshot 推进为当前内存快照并 return false；hasUnsavedChanges() 随即变为 false，主菜单把保存按钮换成「已是最新」，此前的 GUI 改动失去唯一保存入口，重启后静默丢失。",
          "basis": "调用链：MainConfigMenu:151（或 HilltopCommandHandler:422）→ ConfigManager.loadFromFile():1419 三合一失败条件 → :1425 无条件推进快照 → :1426 return false → hasUnsavedChanges():343-344 比较内存与快照得 false → MainConfigMenu:96 判假、:126-128 渲染 GREEN_WOOL。该分支是 loadFromFile() 唯一的 false 返回点，不存在失败但不推进的路径；全库 saveToFile() 调用点仅 MainConfigMenu:106 / HilltopCommandHandler:626 / SetupWizard:1680,1704，无关服或定时兜底。",
          "alternatives": [
            "如果进入该分支前内存与 lastSavedSnapshot 本就相等（管理员未做过未落盘编辑），推进快照无副作用，问题不成立——需检查重载前是否调用过 activeConfig 的 setter 或 GUI 编辑入口（MainConfigMenu:106 之外）。",
            "如果管理员在重载失败后又通过其它显式入口（HilltopCommandHandler:626 / SetupWizard:1680）触发一次保存，改动仍会落盘、损失被缓解——需检查这些入口分别由哪条命令或向导步骤可达。"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "F-slice-11-data-consistency-02",
        "severity": "MEDIUM",
        "dimension": "data-consistency",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/config/ConfigManager.java",
          "line": 1442,
          "quote": "if (settingsYaml.contains(\"world-name\")) activeConfig.setWorldName(settingsYaml.getString(\"world-name\"));"
        },
        "inference": {
          "claim": "contains() 判的是 get(path) 非 null，getString() 判的是值 instanceof String，两者之间的缝隙让数字/布尔/段形态的值把 null 写进 worldName；保存时 :851 以 null 调用 set() 等价于删键，磁盘上那一行静默消失，下一次载入回落到默认 \"world\"。",
          "basis": "控制流：loadFromFile():1437 先以 new GameConfig() 重建（worldName 默认 \"world\"）→ :1442 用 contains 守卫 + getString 取值 → 非字符串标量时 getString 返回 null → setWorldName(null)；saveToFile():851 settingsYaml.set(\"world-name\", null) 删除该键。同形态另有 5 处（:1487 hammer.itemsadder-id、:1499 hammer.item-name、:1517 nodes.repair-cost-name、:1645 fireball.item-name、:1752 monsters.*.display-name），其中 :1487 的 null 会在 HammerListener:97 的 .isEmpty() 处解引用。对照 :1477-1486 与 :1518-1529 的材质键：先判 null 再判 isItem，非法则 warning 并保留默认。",
          "alternatives": [
            "如果所用服务端的 MemorySection#contains 内部走 getString 而不是 get，非字符串值不会进入该分支，问题不成立——需核对服务端 MemorySection 实现（本仓库 YamlFiles.java:351-356 只证明 null 值会被丢弃，故空值确实不触发）。",
            "如果 GameConfig#getWorldName 的消费者对 null 做了判空回退，影响仅限于磁盘键被删、不会运行期失败——需对 getWorldName 做全仓检索（本回合 grep src/main/java 仅命中 GameConfig:671 与 ConfigManager:851）。"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "F-slice-11-data-consistency-03",
        "severity": "MEDIUM",
        "dimension": "data-consistency",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/config/ConfigManager.java",
          "line": 1469,
          "quote": "if (settingsYaml.contains(\"villager-health\")) activeConfig.setVillagerHealth(settingsYaml.getDouble(\"villager-health\"));"
        },
        "inference": {
          "claim": "villager-health 从磁盘读入后不做任何归一化，.nan / .inf / 负值原样进入 GameConfig，并在下一次保存时被写回磁盘；同文件的同类风险键（explode-damage-multiplier、victory-waves、repair-cost-amount）都有专门 clamp，唯独这一键在载入与外部合并两条路径上都裸取。",
          "basis": "两条路径：loadFromFile():1469 直接 getDouble + setVillagerHealth；mergeExternalChanges():441-444 在 hasNumber 守卫下同样直接 getDouble。对照 :776-784 normalizeExplodeDamageMultiplier（显式挡 NaN/+Inf、夹 0..10）、:762-764、:767-769。saveToFile():861 把该值原样写回，SnakeYAML 会输出 .NaN，使非法值在保存—重载之间自我固化。消费者 VillagerSystem:121 取值后，:142-144 的 Math.max(1.0, health) 对 NaN 无效（Java 规范：任一参数为 NaN 则结果为 NaN），NaN 会进入 setBaseValue/setHealth。",
          "alternatives": [
            "如果所用 Paper 版本在 setBaseValue/setHealth 前对 NaN/Infinity 做了钳制或忽略，运行期异常不成立，但 .nan 仍会在内存与磁盘间往返——需检查 VillagerSystem:140-144 与对应服务端实现。",
            "如果该版本解析器把 .nan/.inf 当字符串而非 Double，getDouble 会回落 0.0，该路径不成立——需用 YamlConfiguration.loadFromString(\"villager-health: .nan\") 实测（本回合受零写入约束未运行）。"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "F-slice-11-data-consistency-04",
        "severity": "MEDIUM",
        "dimension": "data-consistency",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/config/ConfigManager.java",
          "line": 644,
          "quote": "int value = number.intValue();"
        },
        "inference": {
          "claim": "readWaveInt 只挡「非 Number」和负数，中间直接把 Number 压成 int：1e18 饱和成 Integer.MAX_VALUE、1.9 截断为 1、.nan 变成 0，三种失真都不写入 problems，所以加载结束时的 numericProblems 汇总 warning 不会出现，内存值与磁盘值静默分叉。",
          "basis": "控制流：:639-643 取 raw 并判 instanceof Number（否则记 problems 并回落）→ :644 number.intValue() → :645-648 只判 value < 0。intValue() 对超出 int 范围的值按 JLS 5.1.3 饱和、对小数截断、对 NaN 得 0；三者在 :645 都不成立，直接 :649 return value。调用点 :673-674（count/weight）、:1827（default.total-mobs）、:1895（各波 total-mobs）共享同一入口，且 :1930-1933 只输出 problems 里已有的条目。方法 javadoc（:614-630）声称把「缺键/非数值/负数」三类显式化，实现与之一致，但未覆盖溢出/小数/NaN。",
          "alternatives": [
            "如果所有波次数值都只能由 GUI 写入且 GUI 已限制范围，手写 1e18 才是唯一触发方式，暴露面较小——需检查 WaveSettingsMenu 的输入校验（本切片外）。",
            "如果 SnakeYAML 把 1e18 解析成 Long/BigInteger 而非 Double，intValue() 的截断规则不同，但「静默失真」的结论不变——需实测该字面量的解析类型后再定影响面。"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "F-slice-11-data-consistency-05",
        "severity": "LOW",
        "dimension": "data-consistency",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/config/ConfigManager.java",
          "line": 1577,
          "quote": "if (settingsGate.write(settingsYaml)) {"
        },
        "inference": {
          "claim": "载入过程中的旧键迁移（:1577 nodes.repair-item、:1695 shop.currency-drop-amount）直接全量写盘，写前不比对新旧 mtime，也不经过 mergeExternalChanges；若在读盘（:1414）与写盘之间文件被外部修改，改动会被整份旧内容覆盖，且写成功后 :1579 立即对齐 mtime，后续保存也不会再发现。",
          "basis": "控制流：:1414 settingsGate.load() 取得磁盘快照存入 settingsYaml → :1428 赋给字段 → :1544-1576 只对迁移键做 set → :1577 settingsGate.write(settingsYaml) 整份写回；对照 saveToFile():840-849 在写前比对 lastModified 并走 mergeExternalChanges。写入内容是刚读到的磁盘快照减去旧键，故偏差仅限窗口内的外部改动；YamlFiles.write(:111-131) 用同目录临时文件 + ATOMIC_MOVE，不会产生半截文件，因此定 LOW 而非更高。",
          "alternatives": [
            "如果 /hilltop reloadconfig 与 loadFromFile() 只在服务器启动或主线程空闲时执行、管理员不可能在同一毫秒内保存文件，窗口实际不可利用——需检查 HilltopCommandHandler:422 的调用上下文与编辑工具的时间尺度。",
            "如果 :1577 之前对 settingsYaml 的所有 set 都只涉及迁移键（本回合核对 :1544-1576 只有 nodes.repair-cost-item / nodes.repair-amount-per-cost 与两个 null），则除窗口内的外部改动外不会引入其它偏差——该条成立，故严重性不再上调。"
          ]
        },
        "status": "CONFIRMED"
      }
    ],
    "searched_scope": {
      "files_read": [
        "src/main/java/com/hilltopvillage/config/ConfigManager.java",
        "src/main/java/com/hilltopvillage/config/ConfigPermission.java",
        "src/main/java/com/hilltopvillage/config/GameConfig.java",
        "src/main/java/com/hilltopvillage/util/YamlFileGate.java",
        "src/main/java/com/hilltopvillage/util/YamlFiles.java",
        "src/main/java/com/hilltopvillage/config/menu/MainConfigMenu.java",
        "src/main/java/com/hilltopvillage/mechanics/VillagerSystem.java",
        "src/test/java/com/hilltopvillage/config/ConfigManagerTest.java",
        "src/test/java/com/hilltopvillage/config/ConfigLoadClampTest.java",
        "src/test/java/com/hilltopvillage/config/YamlNullMechanismTest.java"
      ],
      "files_in_slice": 2,
      "shared_dependencies_read": [
        "src/main/java/com/hilltopvillage/config/GameConfig.java",
        "src/main/java/com/hilltopvillage/util/YamlFileGate.java",
        "src/main/java/com/hilltopvillage/util/YamlFiles.java"
      ],
      "supporting_files_read": [
        "src/main/java/com/hilltopvillage/config/menu/MainConfigMenu.java",
        "src/main/java/com/hilltopvillage/mechanics/VillagerSystem.java",
        "src/test/java/com/hilltopvillage/config/ConfigManagerTest.java",
        "src/test/java/com/hilltopvillage/config/ConfigLoadClampTest.java",
        "src/test/java/com/hilltopvillage/config/YamlNullMechanismTest.java"
      ],
      "files_scanned_without_findings": [
        "src/main/java/com/hilltopvillage/config/ConfigPermission.java"
      ],
      "unreadable_files": [],
      "dimension_checklist": [
        {
          "pattern": "1 返回值暴露内部状态",
          "result": "未命中",
          "note": "GameConfig#getNodeBuffEffects/getStarterKitItems 返回内部容器，但切片内唯一写入方是 ConfigManager 自身；snapshot() 对集合与元素逐项深拷贝（GameConfig:631、664-667）"
        },
        {
          "pattern": "2 同族函数守卫一致性",
          "result": "命中",
          "note": "材质族有 null+isItem 双判（1477-1486、1518-1529），world-name 只有 contains（F-02）；explode 有 normalize（776-784），villager-health 没有（F-03）"
        },
        {
          "pattern": "3 数值边界",
          "result": "命中",
          "note": "intValue() 无上界与整数性检查（F-04）；villager-health 无非有限值闸门与区间（F-03）"
        },
        {
          "pattern": "4a 原型链/裸下标",
          "result": "不适用",
          "note": "Java 实现；外部键只经 ConfigurationSection#getKeys 进入 LinkedHashMap，不存在 obj[key] 式反射查表"
        },
        {
          "pattern": "4b 假值 vs 缺值",
          "result": "命中",
          "note": "contains 被当作「有值」使用（F-02）；正确用法 isSet 出现在 1595 与 1712，两处都能区分「键缺失」与「显式空」"
        },
        {
          "pattern": "4c NaN/Infinity/小数",
          "result": "命中",
          "note": "F-03（villager-health 的 .nan/.inf）与 F-04（intValue 的 NaN→0、小数截断）"
        },
        {
          "pattern": "4d 嵌套结构校验",
          "result": "未命中",
          "note": "monsters/waves 段先判 getConfigurationSection 为 null，再逐键类型守卫；1819-1836 对段头/标量/列表分别告警；1849-1853 有「解析后为空不清空」守卫"
        },
        {
          "pattern": "5 能力是否真实现",
          "result": "命中",
          "note": "readWaveInt 的 javadoc 覆盖与实现一致但漏掉溢出/小数/NaN；clamp 家族逐键手写，导致 villager-health 漏键（F-03）"
        },
        {
          "pattern": "6 转义/编码顺序",
          "result": "不适用",
          "note": "本切片无多层转义/编码；YamlFiles.write 统一 UTF-8 单次写出"
        },
        {
          "pattern": "7 边界符号（负数/下标）",
          "result": "未命中",
          "note": "负数在 readWaveInt:645-648 归 0；waves 数字键 parse 有 try（1788-1793、1887-1891）；starter-kit 数量 Math.max(1, amount)（721）"
        },
        {
          "pattern": "8 引用绑定是否存在",
          "result": "未命中",
          "note": "符号在编译期解析；PotionEffectType.getByName 有 null 判（372-376）；未发现调用未导入名字的形态"
        },
        {
          "pattern": "9 YAML 写入成对性/原子写/部分写入",
          "result": "命中",
          "note": "原子写合格（YamlFiles:111-131，临时文件 + ATOMIC_MOVE）；但迁移写盘绕过 mtime 检测（F-05）；saveToFile 的 set+write 成对且失败返回 false"
        }
      ]
    },
    "lead_dispositions": [
      {
        "lead_id": "L1",
        "disposition": "CONFIRMED",
        "finding_id": "F-slice-11-data-consistency-01",
        "note": "1425 在 1419 的三合一失败条件后无条件推进快照，1426 是唯一的 false 返回点"
      },
      {
        "lead_id": "L2",
        "disposition": "CONFIRMED",
        "finding_id": "F-slice-11-data-consistency-02",
        "note": "机制成立但触发条件修正为非字符串标量（空值会被 YAML 丢弃，contains 为 false）；sweep 的运行时消费者归属有误，严重性定 MEDIUM"
      },
      {
        "lead_id": "L3",
        "disposition": "CONFIRMED",
        "finding_id": "F-slice-11-data-consistency-03",
        "note": "载入 1469 与合并 441-444 双路径均无归一化，同文件 explode 键有专门 clamp"
      },
      {
        "lead_id": "L4",
        "disposition": "CONFIRMED",
        "finding_id": "F-slice-11-data-consistency-04",
        "note": "intValue 的饱和/截断/NaN→0 均不进入 problems，汇总 warning 静默"
      },
      {
        "lead_id": "L5",
        "disposition": "CONFIRMED",
        "finding_id": "F-slice-11-data-consistency-05",
        "note": "1577 与 1695 均无 mtime 比对；窗口为毫秒级且写入内容来自刚读到的磁盘快照，故降为 LOW"
      },
      {
        "lead_id": "L6",
        "disposition": "REFUTED",
        "finding_id": null,
        "note": "不构成本维度缺陷：观察指向返回值契约（void + 恒 true），且怪物闸门只读时磁盘内容不变，无内存/磁盘数据分叉；已记入 off_dimension_notes[0]"
      }
    ],
    "self_checks": {
      "identifier_reconcile": {
        "status": "DONE",
        "note": "ConfigPermission 6 个权限节点对 plugin.yml:30-51 逐一比对，6/6 全部声明、差集为空；saveToFile 写集合（851-996）与 loadFromFile 读集合（1442-1770）对账，hammer.tier.low.charge 与 5 个 hammer.damage-* 为双向墓碑，其余为 contains/isSet 读取，world-name 与 villager-health 见 F-02/F-03"
      },
      "self_check_audit": {
        "status": "DONE",
        "note": "抽验 3 个自带测试：ConfigManagerTest:68-97 有真断言但只覆盖 save 侧快照门控，未覆盖 loadFromFile 早退（F-01 的缺口）；ConfigLoadClampTest 对 victory/repair/explode 的上下界有有效断言，未覆盖 villager-health；YamlNullMechanismTest 三个用例只有 printf、零 assert，且输出无法区分 String null 与 null，判 UNRELIABLE_SELF_CHECK"
      },
      "runtime_validation": {
        "status": "SKIPPED",
        "note": "任务书禁止 maven/gradle 构建（会写 target/，破坏零写入），本机也无 Paper 服务端可启动；.nan 解析、contains/getString 实测、setHealth(NaN) 均未运行，验证方法已写入各条 alternatives"
      }
    },
    "off_dimension_notes": [
      "contract / L6：loadMonstersConfig() 返回 void，monsters-config.yml 不可用或闸门只读时只打 SEVERE 后 return（2006-2010），loadFromFile() 仍 return true（1955、1964）；MainConfigMenu:151-161 与 HilltopCommandHandler:422 据此宣告「已重载」，实际 game-settings 生效而 monsters-config 的扩展字段（entity-type / 装备 / base-damage）回落代码默认，静默未生效；1957 又把这些默认值登记为已落盘基线",
      "error-handling：loadFromFile() 无 try/catch，1442-1953 的未预期异常会抛给 MainConfigMenu:151 的点击处理器（未捕获、菜单不 reopen），且快照不推进",
      "error-handling：VillagerSystem:142-144 用 Math.max(1.0, health) 兜底，对 NaN 无效；setBaseValue/setHealth 收到 NaN 的行为依赖服务端版本，需运行期确认",
      "contract/style：ConfigPermission.description 有赋值无 getter，是死字段，不影响权限判定",
      "test-quality：YamlNullMechanismTest 零断言且 printf 输出对 String \"null\" 与 null 同形，其声称验证的 contains/getString 机制从未被真正断言，属自带自检不可靠"
    ]
  },
  "error": null
}
```