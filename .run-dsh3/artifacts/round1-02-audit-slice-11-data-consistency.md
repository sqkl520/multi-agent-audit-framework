# round1 深挖（audit）— slice-11 / data-consistency

- trace_id: `trace-r1-20260215-hilltop-dsh3`
- round_id: `round1`
- slice_id: `slice-11`
- dimension: `data-consistency`（本产物只报这一个维度）
- 被审仓库（只读）：`D:\Server\MCServers\Server plugin\Hilltop Village\Hilltop Village Plugin`
- 被审文件：`src/main/java/com/hilltopvillage/config/ConfigManager.java`（2133 行）、`src/main/java/com/hilltopvillage/config/ConfigPermission.java`（22 行）
- 结论：**1 HIGH / 3 MEDIUM / 2 LOW**，全部 `CONFIRMED`，均有本回合逐字引用。

## 0. 发现一览

| # | id | 严重性 | 位置 | 一句话 |
|---|---|---|---|---|
| 1 | F-slice-11-data-consistency-01 | **HIGH** | ConfigManager.java:1425 | 读盘失败分支把「保留在内存的未保存改动」登记成已落盘快照，脏标志被洗白、保存按钮消失 |
| 2 | F-slice-11-data-consistency-02 | LOW | ConfigManager.java:1442 | `contains()` 为真但 `getString()` 为 null 时 `worldName` 被写成 null，下一次保存把该键从磁盘删掉 |
| 3 | F-slice-11-data-consistency-03 | MEDIUM | ConfigManager.java:1469 | `villager-health` 无有限性/区间闸门，`.nan` 穿过 `Math.max` 一路进实体属性 |
| 4 | F-slice-11-data-consistency-04 | MEDIUM | ConfigManager.java:644 | `readWaveInt` 只钳负数；`intValue()` 的 NaN→0、1e18→MAX、小数截断全部静默通过 |
| 5 | F-slice-11-data-consistency-05 | LOW | ConfigManager.java:1577 | 载入途中用开头读到的整份 YAML 直接写盘做旧键迁移，绕过 mtime 外部修改检测 |
| 6 | F-slice-11-data-consistency-06 | MEDIUM | ConfigManager.java:2006 | `monsters-config.yml` 缺失（隔离后 ABSENT）被当成可用空配置，怪物扩展字段回落出厂值并被登记为新基线，下一次保存据此重建文件 |

上游线索 L1/L2/L3/L4/L5 全部升级为 CONFIRMED（见 §2），**L6 判为 contract 维度**，只写入 `off_dimension_notes`（见 §5）。

## 1. 范围与方法

- 读全 `ConfigManager.java` 的 12 个关键区段：字段与构造器（1–145）、`hasUnsavedChanges`/`removeWave`（330–360）、`mergeExternalChanges`（386–607）、`readWaveInt`/`readComposition`（614–700）、`saveToFile`/`saveMonstersConfig`/`adoptExternalMonsterChanges`（826–1155）、`loadFromFile`（1392–1731）、收尾与 `loadMonstersConfig`/`revertAll`（1925–2133）。
- 控制流证据来自 4 个直接调用方/被调用方：`MainConfigMenu`（保存/重载按钮）、`HilltopCommandHandler`（`/hilltop reloadconfig`）、`VillagerSystem`（`villager-health` 消费者）、`YamlFileGate`/`YamlFiles`（ABSENT 与只读语义）。它们不扩大切片，只用于坐实「入口 → 问题点」。
- 自带测试抽验 2 个：`ConfigLoadClampTest`、`YamlNullMechanismTest`（见 §6）。
- 数据一致性检查面：写入集合 ↔ 合并白名单 ↔ 读取集合的三方对账；脏标志与快照的语义；部分写入与事务边界；ABSENT/不可用/只读三种降级；类型与数值边界。

## 2. 逐条发现

### F-01（HIGH）失败路径把内存当成磁盘：脏标志被洗白

**证据（ConfigManager.java:1419–1426，逐字）**

```java
        if (!loaded.usable() || loaded.status() == YamlFiles.Status.ABSENT || settingsGate.isReadOnly()) {
            // 不可用时不套用磁盘值（保留内存/默认值），也不做任何迁移写回
            plugin.getLogger().severe("game-settings.yml is unusable; keeping the in-memory values "
                    + "(nothing will be read from or written to the file this run)");
            settingsLoadedFromDisk = false;
            loadMonstersConfig();
            lastSavedSnapshot = activeConfig.snapshot();
            return false;
        }
```

**推断**：`lastSavedSnapshot` 的语义是「上一次真正落盘的配置」。这个分支没有写任何文件（日志自己说 "nothing will be read from or written to the file"），却把**当前内存**（含本会话所有未保存的 GUI 改动）复制成基线。`hasUnsavedChanges()`（同文件 339–345）就是 `!activeConfig.snapshot().equals(lastSavedSnapshot)`，于是返回 false。

**调用链（入口 → 问题点）**：
`/hilltop reloadconfig`（`HilltopCommandHandler.java:422`）或配置 GUI「重新加载」（`MainConfigMenu.java:151`）→ `ConfigManager.loadFromFile()` → 1419 守卫命中（文件被删/被隔离/只读）→ 1425 推进快照 → 返回 false。
调用方随后 `reopen()`（`MainConfigMenu.java:162`）→ `buildMenu()` 读 `configManager.hasUnsavedChanges()`（`MainConfigMenu.java:96`）→ 现在为 false → 底部槽位从 LIME_WOOL「保存」变成 GREEN_WOOL「已是最新」，保存入口消失。

**为什么是 HIGH 而不是 CRITICAL**：丢失的是「本会话尚未落盘的编辑」（崩溃/关服本来也会丢），磁盘上的既有配置没有被破坏，所以不到 CRITICAL；但「失败提示 + 保存按钮消失」同时发生，管理员会以为改动已随重载保住，实际只能等重启后全部蒸发。同文件 119–120 行的注释明确承诺「失败时 hasUnsavedChanges() 仍为 true，保存按钮必须继续可见」——本条正是该承诺在 reload 路径上的反例。

**alternatives**
1. 如果 `hasUnsavedChanges()` 在 reload 失败后被别的标志兜住（例如 `loadTimeNormalizationPending` 恰好为 true），保存按钮不会消失——需检查 `ConfigManager.java:339-345` 与本次会话是否发生过归一化（`loadTimeNormalizationPending` 只在归一化改写时置位，普通 GUI 编辑不置位）。
2. 如果调用方在调用 `loadFromFile()` 之前会先把未保存改动落盘或显式回滚，则没有可被洗白的改动——需检查 `HilltopCommandHandler.java:419-422` 与 `MainConfigMenu.java:148-151`（两处调用前均无 save/revert 调用）。

### F-02（LOW）`contains` 与 `getString` 不互斥：worldName 收下 null

**证据（ConfigManager.java:1442，逐字）**

```java
        if (settingsYaml.contains("world-name")) activeConfig.setWorldName(settingsYaml.getString("world-name"));
```

**推断**：`contains()` 判的是「路径存在」，`getString()` 只在值**是 String** 时返回非 null（空值 `world-name:`、数字/布尔标量都会得到 null）。`GameConfig.setWorldName`（`GameConfig.java:672`）没有任何 null 守卫，于是 `worldName` 变成 null；下一次 `saveToFile()` 的 `settingsYaml.set("world-name", activeConfig.getWorldName())`（`ConfigManager.java:851`）会以 null 值**删除该键**——磁盘上原本「存在但写错」的键被静默抹掉，而不是保留原样等管理员修。

同文件对 `hammer.material`（1477–1486）、`nodes.repair-cost-item`（1518–1529）都做了 null + 合法性双判，唯独这一行与 `fireball.item-name`（1645）没有。项目自己的 `YamlNullMechanismTest`（src/test/.../config/YamlNullMechanismTest.java:17-30）就是为这个机制写的，说明作者知道 `contains==true && getString==null` 存在。

**为什么只有 LOW**：全仓 grep 显示 `GameConfig#getWorldName` 除 `ConfigManager.java:851`（写回）外没有任何运行期消费者——它是死键，所以 null 不会引发 NPE/世界加载失败；实际损害限于「下一次保存删掉一个本就写错的键」。

**alternatives**
1. 如果目标 Bukkit 版本的 `MemorySection#getString` 对非 String 标量返回 `String.valueOf(value)` 而不是 null，则只有空值形态成立——需按实际服务端版本核对 `getString` 实现（本项目 `YamlNullMechanismTest` 的前提是它会返回 null）。
2. 如果 `world-name` 在切片外确有消费者（例如某处 `Bukkit.getWorld(config.getWorldName())`），影响会升级为运行期 NPE——需在 `src/main/java` 全量搜索 `getActiveConfig().getWorldName()`（本回合 grep 未命中）。

### F-03（MEDIUM）`villager-health` 漏掉有限性闸门

**证据（ConfigManager.java:1469，逐字）**

```java
        if (settingsYaml.contains("villager-health")) activeConfig.setVillagerHealth(settingsYaml.getDouble("villager-health"));
```

**推断**：同文件对同类「来自磁盘的 double」有明确的归一化范式：`normalizeExplodeDamageMultiplier`（776 起）显式挡 NaN / +Infinity / 负值并夹到 [0,10]；`victory-waves`、`repair-cost-amount`、`wave-timeout-seconds` 也各有 normalize。`villager-health` 从磁盘 `getDouble` 后原样进入 `GameConfig`，没有经过任何 `Double.isFinite` 或下界检查；`mergeExternalChanges` 的 441–444 行同样没有。

消费点 `VillagerSystem.spawnAll()`：`double health = ...getVillagerHealth();`（`VillagerSystem.java:121`）→ `maxHealth.setBaseValue(Math.max(1.0, health));`（`VillagerSystem.java:142`）。`Math.max(1.0, Double.NaN)` 按 Java 语义返回 **NaN**，所以下界兜底对 NaN 无效；负值则被这一行兜到 1.0（这一点上游线索说「负值无 clamp」不准确，应修正为「负数由消费者兜底，NaN/Infinity 没有」）。

**影响**：YAML 的 `.nan` / `.inf` 会被 SnakeYAML 读成 `Double.NaN` / `Infinity` 并作为 Number 通过 `getDouble`。之后要么在 `setBaseValue` 处抛 `IllegalArgumentException`（刷村民中途中断，已生成一半，属部分状态），要么把非有限值写进实体属性。两条路都不是「可玩」状态。

**为什么是 MEDIUM**：需要管理员手写 `.nan`/`.inf` 才会触发，且不会破坏磁盘文件；但它把「载入期数值卫生」的既有承诺撕开一个键的口子，且发生在每个竞技场开局路径上。

**alternatives**
1. 如果 `AttributeInstance#setBaseValue` 对 NaN 有服务端侧夹取/忽略（而不是抛异常），症状会从「刷村民中断」变成「血量显示/结算异常」——需在 `VillagerSystem.java:142` 用 NaN 实测一次。
2. 如果 GUI 的村民血量输入已经限制了取值范围、且手改文件被视为不支持的操作，本条可降为 LOW——需检查村民血量菜单项的输入边界（本回合未读到该菜单，属切片外）。

### F-04（MEDIUM）`readWaveInt` 只兑现了注释里的三分之一

**证据（ConfigManager.java:644，逐字）**

```java
        int value = number.intValue();
```

**推断**：方法注释（617–622）声明「把三种非法形态（缺键 / 非数值 / 负数）全部显式化」，实现只有 `value < 0` 一档（645–648）。`Number#intValue()` 对 `Double.NaN` 返回 0、对 `1e18` 饱和到 `Integer.MAX_VALUE`、对 `2.9` 截断为 2，三种都不进 `problems`，也没有日志：
- `total-mobs: .nan` → 0 只 → 该波静默空转（与注释里「把该波静默变成 0 只」要防的形态一模一样，只是入口从「缺键」换成了「NaN」）；
- `total-mobs: 1e18` → 21 亿 → 波次永不结束；
- `count: 2.7` → 2，静默改小。

这是「注释声称的覆盖面大于实现」的形态（模式 5），也是数值边界（4c/模式 3）的漏网。

**alternatives**
1. 如果所有写入该键的路径都经过 GUI 的整数输入且已 clamp，`1e18`/`NaN` 只能来自手改文件，影响面限于手改场景——需检查 `WaveSettingsMenu` 的 `total-mobs` 输入范围（切片外）。
2. 如果 `number` 对 `1e18` 被 SnakeYAML 解析为 `Long` 而非 `Double`，`Long.intValue()` 取低 32 位，结果可能不是 `Integer.MAX_VALUE`——结论（静默通过）不变，具体数值需以实际解析类型核对。

### F-05（LOW）载入途中的全量写盘绕过外部修改检测

**证据（ConfigManager.java:1577–1579，逐字）**

```java
            if (settingsGate.write(settingsYaml)) {
                // M-15：本次写盘更新 mtime 记录，避免随后的保存误判为「外部修改」
                settingsLastModified = settingsFile.lastModified();
```

**推断**：`loadFromFile()` 在 1414 行读入 `settingsYaml`，到 1577 行（以及 1695 行的 shop 迁移）直接把**开头读到的那份整份 YAML** 写回磁盘做旧键迁移。这条写路径既没有 `saveToFile()` 的 mtime 前置比对（840），也不经过 `mergeExternalChanges()`；写成功后 1579 行还把基线更新成新 mtime，于是「读盘之后、写盘之前」发生的任何外部手改被整份旧内容覆盖，且此后再也检测不到（基线已被刷新）。

**为什么只有 LOW**：触发需要「存在 `nodes.repair-item`/`nodes.repair-amount`/`shop.currency-drop-amount` 旧键」且「外部编辑恰好落在同一次 reload 的毫秒级窗口内」；迁移本身是幂等的、下一次启动会重试。但丢失是永久且无日志的，属于「事务边界外的写」。

**alternatives**
1. 如果 `YamlFiles.load` 与 `YamlFiles.write` 全程对同一文件加排它锁，使窗口内的外部写入不可能发生，则本条不成立——需检查 `YamlFiles.java` 的 load/write 是否有文件锁（本回合读到的 79–98 行与 `YamlFileGate.write` 均无锁）。
2. 如果这两处写盘后会重新从磁盘读回并据此重建内存，覆盖造成的分歧会被立刻发现——需检查 1577 之后到 1957 之间是否有二次 `settingsGate.load()`（实测没有）。

### F-06（MEDIUM）monsters 侧把 ABSENT 当权威：同族守卫不一致

**证据（ConfigManager.java:2005–2010，逐字）**

```java
        YamlFiles.Loaded loaded = monstersGate.load();
        if (!loaded.usable() || monstersGate.isReadOnly()) {
            plugin.getLogger().severe("monsters-config.yml is unusable; keeping monster defaults "
                    + "(nothing will be read from or written to the file this run)");
            return;
        }
```

**推断**：`YamlFiles.Loaded.usable()` 只判 `config != null`（`YamlFiles.java:49-51`），而文件缺失时 `load()` 返回 `new Loaded(new YamlConfiguration(), Status.ABSENT, null)`（`YamlFiles.java:80-81`）——ABSENT 是 usable。所以这个守卫**拦不住「文件不存在」**。

对比 settings 侧：同一方法 1419 行显式把 `loaded.status() == YamlFiles.Status.ABSENT` 列为拒绝条件，并在 1415–1418 的注释里写明理由——「隔离后文件不存在 → 返回 ABSENT，照走会把空配置当权威再迁移写回……管理员配置被洗成默认值」。monsters 侧缺的正是这半条守卫。

**触发条件（可复现）**：
1. 启动时 `monsters-config.yml` 损坏 → `YamlFiles.load` 把它隔离成 `.corrupt`，`monstersGate` 上闩（`YamlFileGate.load` 54–55）。
2. 管理员按提示修好后执行 `/hilltop reloadconfig`；该命令先 `getMonstersGate().reset()`（`HilltopCommandHandler.java:406`）解闩。
3. 若管理员没有把 `.corrupt` 还原成 `monsters-config.yml` 就重载：`load()` 得到 ABSENT（不重新上闩，`YamlFileGate.load` 56–60 只在 OK 时解闩、ABSENT 既不上闩也不解闩，但 reset 已把闩清掉）→ 2006 守卫通过 → `monstersConfigYaml` = 空配置。
4. `activeConfig` 已在 1437 重建为出厂默认，`loadMonstersConfig` 对空配置逐键 `contains` 全为 false → `base-damage`、`itemsadder-id`、`custom-model-data`、六部位装备保持默认；随后 1957 行把这份内存登记为 `lastSavedSnapshot`（脏标志读作干净）。
5. 下一次 GUI 保存 → `saveMonstersConfig()` 的 mtime 比对是 `0 == 0`（文件不存在），不触发 `adoptExternalMonsterChanges`，`writable()` 为 true → 用一个「默认装备 + 默认伤害」的新文件重建 `monsters-config.yml`。磁盘上真实值只剩在 `.corrupt` 里，日志只有启动期那一条 SEVERE 和一条「reload 成功」。

**为什么是 MEDIUM**：`.corrupt` 保留了原始内容，可人工恢复；但插件会静默生成一份看起来正常的默认文件，且脏标志被清掉（与 F-01 同一机制），管理员很难察觉。

**alternatives**
1. 如果 `YamlFileGate.reset()` 之后 `load()` 对 ABSENT 仍保持只读（例如 reset 不禁用闩而另有标志），2006 守卫会拦住——需检查 `YamlFileGate.java:52-62`（实测 reset 只清 `readOnly` 与 `warned`）。
2. 如果管理员按提示先把 `.corrupt` 还原再 reload，`load()` 返回 OK，本条不成立——这取决于恢复步骤，而插件文案只写「Repair/restore it」，未要求先还原文件名。
3. 如果 `saveToFile()` 在 monsters 闸门为 ABSENT 时拒绝写，重建不会发生——需检查 `saveMonstersConfig` 的 `writable()` 前置（`ConfigManager.java:1044`，ABSENT 下为 true）。

## 3. 上游线索处置

| lead | 处置 | 说明 |
|---|---|---|
| L1 | **CONFIRMED → F-01（HIGH）** | 事实成立；补充了调用链与「保存按钮消失」的可观察后果，并修正为「返回 false 但快照仍被推进」 |
| L2 | **CONFIRMED → F-02（LOW）** | 机制成立；下调为 LOW，因为 `worldName` 无运行期消费者，损害限于下一次保存删键 |
| L3 | **CONFIRMED（修正后）→ F-03（MEDIUM）** | 成立，但「负值无 clamp」不准确：`VillagerSystem:142` 的 `Math.max(1.0, health)` 已兜负数；真缺口是 NaN/Infinity |
| L4 | **CONFIRMED → F-04（MEDIUM）** | 成立；补充 NaN→0、1e18→MAX、2.9→2 三种具体形态 |
| L5 | **CONFIRMED → F-05（LOW）** | 成立；窗口为毫秒级且仅旧键迁移路径可达，故定 LOW |
| L6 | **REFUTED（本维度）** | 见 §5：这是「返回值/契约」问题，不是数据一致性问题；其数据面后果已由 F-06 以同一切片内的守卫不一致形式单列 |

## 4. 已排查但未立条的候选（避免下游重复劳动）

- `saveToFile()` 的「settings 写成功、monsters 写失败」部分写入：返回 false 且不推进快照（1023–1033），GUI 消费返回值（`MainConfigMenu.java:106-121`）并保留保存按钮，重试可收敛。原子性确实跨两个文件，但失败可重入，未立条。
- `removedWaveKeys` 在 settings 写成功后立即 `clear()`（1022）：墓碑的职责只覆盖那一次 settings 写盘，且判据读当前内存，未发现删除被撤销的路径。
- `revertAll()` 不清 `loadTimeNormalizationPending`（2124–2131）：注释已说明「回滚到的是上次落盘快照，归一化仍未落盘」，语义自洽。
- 外部修改合并白名单 vs `saveToFile` 写集合：逐键核对后，未进白名单的写键（`nodes.repair-amount-per-cost`、`nodes.self-destruct-multiplier`、`spawning.spawn-radius-min/max`、`hammer.material` 等）都有 GUI/命令编辑入口（`NodeSettingsMenu.java:42,52`、`GameRulesMenu.java:58,69`、`HilltopCommandHandler.java:622`），符合「游戏内为权威」的设计，未发现漏网。
- `ConfigPermission`：纯枚举，无持久化/键名映射，不在 data-consistency 的问题域内。

## 5. off_dimension_notes

1. **L6（contract）**：`loadMonstersConfig()` 返回 void，读盘失败只打一条 SEVERE 就 return（`ConfigManager.java:2006-2010`），`loadFromFile()` 仍走到 `return true`（1964）。调用方（`HilltopCommandHandler.java:438-444`、`MainConfigMenu.java:151-161`）据此宣告「已重载」。这是返回值语义/契约问题，应由 contract 维度立项；本维度只报其数据面（F-06）。
2. **`world-name` 疑似死键**：全仓仅 `ConfigManager.java:851`（写）与 1442（读）触及 `GameConfig#getWorldName`，没有运行期消费者。若确认，属「配置项存在但能力未实现」（模式 5），建议另立 logic/contract 条目。
3. **monsters-config 的 9 个「写而不读」键**（`MONSTERS_CONFIG_NON_EFFECTIVE_KEYS`，119–121）：作者已在 2101–2102 做了一次性告警，属可观测性设计，不是一致性问题。
4. **`world-name` / `core.*` 的类型形状未校验**：`getDouble`/`getInt` 对标量类型不符时静默回落到 0，与 F-02 同族但影响仅限数值错误，未单列，留给后续类型校验议题。

## 6. 自检

- **标识符对账（DONE）**：把 `saveToFile` 的写集合（60+ 键）、`mergeExternalChanges` 白名单、`loadFromFile` 的读集合、GUI 编辑入口做四方对账。差集结论：`villager-health` 读写两端都在、却没有 normalize（F-03）；`world-name` 读写两端都在、无消费者（§5.2）；`nodes.repair-amount-per-cost` / `self-destruct-multiplier` / `spawn-radius-min|max` 有 GUI 入口，故不在合并白名单是正确设计；未发现「写了但读不到」或「读了但从不写」的键。
- **自带自检抽验（DONE，静态）**：抽验 `ConfigLoadClampTest` 与 `YamlNullMechanismTest`。前者为 `victory-waves` / `repair-cost-amount` / `explode-damage-multiplier` 钉了「载入期钳制 + 计入脏标志」的断言（第 69–152 行），其中**没有任何 `villager-health` 用例**——这正好证明 F-03 是同一策略的漏网键，而不是设计选择；后者证明项目已知 `contains==true / getString==null` 机制，但只用于排查 `airdrop-mob-type`，没有推广到 `world-name`。注入故障（4.7-d）未执行，原因同下：构建会写 `target/`。
- **运行时验证（SKIPPED）**：需要 Maven 构建（写 `target/`）并启动 Paper 服务端才能复现 reload/隔离路径，违反零写入约束；改用「入口 → 调用点 → 问题行」的静态调用链坐实（见各条 `basis`）。

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
          "line": 1419,
          "quote": "        if (!loaded.usable() || loaded.status() == YamlFiles.Status.ABSENT || settingsGate.isReadOnly()) {\n            // 不可用时不套用磁盘值（保留内存/默认值），也不做任何迁移写回\n            plugin.getLogger().severe(\"game-settings.yml is unusable; keeping the in-memory values \"\n                    + \"(nothing will be read from or written to the file this run)\");\n            settingsLoadedFromDisk = false;\n            loadMonstersConfig();\n            lastSavedSnapshot = activeConfig.snapshot();\n            return false;\n        }"
        },
        "inference": {
          "claim": "读盘失败的早退分支在未写入任何文件的情况下把当前内存登记为「已落盘快照」，使本会话所有未保存的 GUI 改动被 hasUnsavedChanges() 判成已保存；调用链 /hilltop reloadconfig → loadFromFile → 1425 之后，配置主菜单把保存按钮换成「已是最新」，改动无法再保存，重启即丢。",
          "basis": "1419 的守卫只处理「文件不可用/ABSENT/只读」，日志明确写着 nothing will be read from or written to the file，但 1425 仍执行 lastSavedSnapshot = activeConfig.snapshot()；hasUnsavedChanges()（339-345）正是 activeConfig.snapshot() 与 lastSavedSnapshot 的比较，因此该赋值等价于清除脏标志。入口与消费点：HilltopCommandHandler.java:422 调用 loadFromFile() 并在 438-444 消费返回值；MainConfigMenu.java:151 同样调用，162 行 reopen() 后 buildMenu() 在 96 行读 hasUnsavedChanges() 决定渲染 LIME_WOOL 保存按钮还是 GREEN_WOOL「已是最新」。同文件 119-120 的注释明确承诺失败时该标志应保持 true，与本路径相反。",
          "alternatives": [
            "如果本会话此前发生过归一化（loadTimeNormalizationPending 为 true），保存按钮不会消失，本条的可观察后果被缓解——需检查 ConfigManager.java:339-345 与本次会话是否触发过 1453/1464/1535/1718 的置位；普通 GUI 编辑不会置位。",
            "如果两个调用方在调用 loadFromFile() 前会先落盘或回滚未保存改动，则没有可被洗白的改动——需检查 HilltopCommandHandler.java:419-422 与 MainConfigMenu.java:148-151（两处调用前均无 save/revert）。",
            "如果主菜单的保存按钮不是 hasUnsavedChanges() 的唯一消费者（例如另有监听器在关服时无条件 saveToFile），丢失会被兜住——需检查插件的 onDisable 路径（本回合未读到，属切片外）。"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "F-slice-11-data-consistency-02",
        "severity": "LOW",
        "dimension": "data-consistency",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/config/ConfigManager.java",
          "line": 1442,
          "quote": "        if (settingsYaml.contains(\"world-name\")) activeConfig.setWorldName(settingsYaml.getString(\"world-name\"));"
        },
        "inference": {
          "claim": "world-name 写成空值或非字符串标量时，contains() 为真而 getString() 返回 null，setWorldName(null) 直接落地；下一次 saveToFile() 用 settingsYaml.set(\"world-name\", null) 回写，会把该键从磁盘删除，而不是保留管理员写错的原值。",
          "basis": "contains 判路径存在，getString 仅在值为 String 时非 null（空值 world-name: 与数字/布尔标量都会得到 null）；GameConfig.java:672 的 setWorldName 无 null 守卫；ConfigManager.java:851 的全量回写直接把 null 交给 YamlConfiguration#set，null 即删除键。同文件相邻的 hammer.material（1477-1486）与 nodes.repair-cost-item（1518-1529）都做了 null 与合法性双判，唯独此键与 fireball.item-name（1645）没有。",
          "alternatives": [
            "如果目标 Bukkit 版本的 MemorySection#getString 对非 String 标量返回 String.valueOf(value) 而非 null，则只有空值形态成立——需按实际服务端版本核对 getString 实现；项目自带的 YamlNullMechanismTest（src/test/java/com/hilltopvillage/config/YamlNullMechanismTest.java:17-30）以 contains=true/getString=null 为前提。",
            "如果 world-name 在切片外存在运行期消费者（如 Bukkit.getWorld(config.getWorldName())），null 会升级为 NPE——需在 src/main/java 搜索 getActiveConfig().getWorldName()（本回合 grep 仅命中 ConfigManager.java:851/1442，未发现消费者）。"
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
          "quote": "        if (settingsYaml.contains(\"villager-health\")) activeConfig.setVillagerHealth(settingsYaml.getDouble(\"villager-health\"));"
        },
        "inference": {
          "claim": "villager-health 从磁盘 getDouble 后原样进入 GameConfig，没有 NaN/Infinity/下界闸门；.nan 会穿过 VillagerSystem.spawnAll 的 Math.max(1.0, health)（该表达式对 NaN 返回 NaN）进入 Attribute#setBaseValue，导致刷村民抛异常中断或血量非有限值。",
          "basis": "同文件对同类磁盘 double 有成熟范式：normalizeExplodeDamageMultiplier（776 起）显式挡 NaN/+Infinity/负值并夹到 [0,10]，victory-waves 与 repair-cost-amount 也各有 normalize；本条与 mergeExternalChanges 的 441-444 行都没有。消费链：ConfigManager.getActiveConfig().getVillagerHealth() → VillagerSystem.java:121 取出 → VillagerSystem.java:142 maxHealth.setBaseValue(Math.max(1.0, health))，Java 的 Math.max 对 NaN 传播 NaN，因此下界兜底只覆盖负数。",
          "alternatives": [
            "如果 AttributeInstance#setBaseValue 对 NaN 自行夹取或忽略而不是抛异常，症状会从「刷村民中途中断（部分村民已生成）」变成「血量显示/结算异常」——需在 VillagerSystem.java:142 用 Double.NaN 实测一次服务端行为。",
            "如果村民血量的 GUI 输入已限制为有限的合理区间，且手改 YAML 被视为不受支持，则本条可降为 LOW——需检查村民血量菜单项的输入边界（切片外）。",
            "如果 SnakeYAML 对 .nan/.inf 的解析被 Bukkit 的 getDouble 拒绝（返回默认 0.0），本条不成立——需确认 getDouble 只做 instanceof Number 判定（Number 包含 NaN/Infinity，故推测成立，但需以实际版本复核）。"
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
          "quote": "        int value = number.intValue();"
        },
        "inference": {
          "claim": "readWaveInt 只把负数显式化，Number#intValue() 对 NaN 返回 0、对 1e18 饱和到 Integer.MAX_VALUE、对小数截断，三种都静默通过且无日志；total-mobs: .nan 会让该波静默变成 0 只，正是方法注释声称要防的形态。",
          "basis": "方法注释（617-622）声称「三种非法形态（缺键 / 非数值 / 负数）全部显式化」，实现只在 645-648 判 value < 0；640 行的 instanceof Number 放行 Double.NaN 与 Infinity，644 行的 intValue() 完成静默转换，随后 649 行直接 return，没有任何 isFinite 或上界检查。调用点：readComposition 的 count/weight（673-674）与 waves 段的 total-mobs，均直接进入 GameConfig 的波次模型。",
          "alternatives": [
            "如果所有写入这些键的路径都经过 GUI 的整数输入并已 clamp，极端值只能来自手改文件，影响面限于手改场景——需检查 WaveSettingsMenu 的 total-mobs 输入范围（切片外）。",
            "如果 1e18 被 SnakeYAML 解析为 Long 而非 Double，Long.intValue() 取低 32 位，具体数值可能不是 Integer.MAX_VALUE——静默通过的结论不变，需以实际解析类型核对。",
            "如果 WaveManager 对 total-mobs 另有上限夹取，超大值的运行期后果会被缓解——需检查 WaveManager 对 getTotalMobs 的使用（切片外）。"
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
          "quote": "            if (settingsGate.write(settingsYaml)) {\n                // M-15：本次写盘更新 mtime 记录，避免随后的保存误判为「外部修改」\n                settingsLastModified = settingsFile.lastModified();"
        },
        "inference": {
          "claim": "loadFromFile 在做旧键迁移时用开头（1414 行）读到的整份 settingsYaml 直接写盘，不经过 saveToFile 的 mtime 前置比对与 mergeExternalChanges；写成功后还把基线刷新为新 mtime，使「读盘后、写盘前」的外部手改被永久覆盖且不再可检测。",
          "basis": "1414 行 settingsGate.load() 取得磁盘快照，1577 行（以及 1695 行的 shop.currency-drop-amount 迁移）直接 settingsGate.write(settingsYaml)；这条路径没有 840 行的 lastModified 比对，也没有 mergeExternalChanges 的白名单合并。1579 行随后把 settingsLastModified 设为新 mtime，等于把这次覆盖登记为新的「无外部修改」基线。触发前提是文件里存在 nodes.repair-item / nodes.repair-amount / shop.currency-drop-amount 旧键。",
          "alternatives": [
            "如果 YamlFiles.load 与 YamlFiles.write 对同一文件全程加排它锁，使窗口内不可能发生外部写入，本条不成立——需检查 YamlFiles.java 的 load/write（本回合读到的 79-98 行与 YamlFileGate.write 均无锁）。",
            "如果迁移写盘后会重新从磁盘读回并据此重建内存，覆盖造成的分歧会被立刻发现——需检查 1577 到 1957 之间是否有二次 settingsGate.load()（实测没有）。",
            "如果迁移只在服务器启动、尚无外部编辑者时执行，实际风险趋近于零——需确认 /hilltop reloadconfig 也会走到这段（会，loadFromFile 是同一入口）。"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "F-slice-11-data-consistency-06",
        "severity": "MEDIUM",
        "dimension": "data-consistency",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/config/ConfigManager.java",
          "line": 2005,
          "quote": "        YamlFiles.Loaded loaded = monstersGate.load();\n        if (!loaded.usable() || monstersGate.isReadOnly()) {\n            plugin.getLogger().severe(\"monsters-config.yml is unusable; keeping monster defaults \"\n                    + \"(nothing will be read from or written to the file this run)\");\n            return;\n        }"
        },
        "inference": {
          "claim": "loadMonstersConfig 的守卫拦不住「文件不存在」：ABSENT 的 Loaded 是 usable（config 非 null），于是被隔离成 .corrupt 的 monsters-config.yml 在 /hilltop reloadconfig 解闩后会被当成权威空配置，怪物扩展字段回落出厂值并被登记为 lastSavedSnapshot，下一次保存据此重建一份默认 monsters-config.yml。",
          "basis": "YamlFiles.Loaded.usable() 只判 config != null（YamlFiles.java:49-51）；文件缺失时 load() 返回 new Loaded(new YamlConfiguration(), Status.ABSENT, null)（YamlFiles.java:80-81），因此 2006 的条件为 false。对照同文件 1419：settings 侧显式把 status == ABSENT 列为拒绝条件，并在 1415-1418 注释说明「隔离后文件不存在 → ABSENT（usable）……会把空配置当权威重建内存（管理员配置被洗成默认值）」。触发链：启动期损坏隔离并上闩（YamlFileGate.java:54-55）→ /hilltop reloadconfig 先 reset 解闩（HilltopCommandHandler.java:406）→ 未还原 .corrupt 时 load() 得 ABSENT 且不再上闩（YamlFileGate.java:56-60）→ 2006 放行 → 空 YamlConfiguration 使 2019 起的 contains 全 false → activeConfig 保持 1437 重建出的出厂值 → 1957 登记快照 → 之后 saveMonstersConfig 的 mtime 比对为 0==0、writable 为 true，写出默认值。",
          "alternatives": [
            "如果 YamlFileGate.reset() 之后 load() 对 ABSENT 仍保持只读，2006 守卫会拦住——需检查 YamlFileGate.java:52-62（实测 reset 只清 readOnly/warned，ABSENT 分支既不上闩也不解闩）。",
            "如果管理员按提示先把 .corrupt 还原成 monsters-config.yml 再 reload，load() 返回 OK，本条不成立——取决于恢复步骤，而插件文案只写 Repair/restore it，未要求先还原文件名。",
            "如果 saveToFile 在 monsters 闸门为 ABSENT 时拒绝写，默认文件不会被重建——需检查 saveMonstersConfig 的 writable() 前置（ConfigManager.java:1044，ABSENT 下为 true）。"
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
        "src/main/java/com/hilltopvillage/config/menu/MainConfigMenu.java",
        "src/main/java/com/hilltopvillage/command/HilltopCommandHandler.java",
        "src/main/java/com/hilltopvillage/mechanics/VillagerSystem.java",
        "src/main/java/com/hilltopvillage/util/YamlFileGate.java",
        "src/main/java/com/hilltopvillage/util/YamlFiles.java",
        "src/test/java/com/hilltopvillage/config/ConfigLoadClampTest.java",
        "src/test/java/com/hilltopvillage/config/YamlNullMechanismTest.java"
      ],
      "files_in_slice": 2,
      "shared_dependencies_read": [
        "src/main/java/com/hilltopvillage/config/GameConfig.java",
        "src/main/java/com/hilltopvillage/config/menu/MainConfigMenu.java",
        "src/main/java/com/hilltopvillage/command/HilltopCommandHandler.java",
        "src/main/java/com/hilltopvillage/mechanics/VillagerSystem.java",
        "src/main/java/com/hilltopvillage/util/YamlFileGate.java",
        "src/main/java/com/hilltopvillage/util/YamlFiles.java",
        "src/test/java/com/hilltopvillage/config/ConfigLoadClampTest.java",
        "src/test/java/com/hilltopvillage/config/YamlNullMechanismTest.java"
      ],
      "files_scanned_without_findings": [
        "src/main/java/com/hilltopvillage/config/ConfigPermission.java",
        "src/main/java/com/hilltopvillage/config/GameConfig.java",
        "src/main/java/com/hilltopvillage/config/menu/MainConfigMenu.java",
        "src/main/java/com/hilltopvillage/command/HilltopCommandHandler.java",
        "src/main/java/com/hilltopvillage/mechanics/VillagerSystem.java",
        "src/main/java/com/hilltopvillage/util/YamlFileGate.java",
        "src/main/java/com/hilltopvillage/util/YamlFiles.java",
        "src/test/java/com/hilltopvillage/config/ConfigLoadClampTest.java",
        "src/test/java/com/hilltopvillage/config/YamlNullMechanismTest.java"
      ],
      "dimension_checklist": [
        { "pattern": "1 返回值暴露内部状态", "result": "命中", "note": "getActiveConfig() 返回可变的内部 GameConfig，GUI 直接改字段；这是本插件既定的编辑模型（revertAll 的注释专门讨论对象身份），本回合未发现由此产生的破坏性写回，故只记录不立条。" },
        { "pattern": "2 同族函数守卫一致性", "result": "命中", "note": "settings 侧拒绝 ABSENT（1419）而 monsters 侧不拒绝（2006）→ F-06；hammer.material / repair-cost-item 有 null 判，world-name / fireball.item-name 没有 → F-02；explode/victory/repair 有 normalize，villager-health 没有 → F-03。" },
        { "pattern": "3 数值边界", "result": "命中", "note": "readWaveInt 的 intValue() 对 NaN/溢出/小数无守卫 → F-04；villager-health 无 isFinite/下界 → F-03。" },
        { "pattern": "4a 原型链/裸下标", "result": "不适用", "note": "Java 无原型链；YAML 键访问均经 contains/get/getConfigurationSection，未发现把外部键当继承表用的形态。" },
        { "pattern": "4b 假值 vs 缺值", "result": "命中", "note": "contains 与 getString 不互斥导致「存在即 null」→ F-02；同文件对 nodes.buff-effects 与 starter-kit.items 正确使用 isSet 区分「键缺失」与「显式空」，形成对照。" },
        { "pattern": "4c NaN/Infinity/小数", "result": "命中", "note": "villager-health 的 .nan/.inf 无闸门 → F-03；readWaveInt 的 NaN→0、1e18→MAX、小数截断 → F-04。" },
        { "pattern": "4d 嵌套结构校验", "result": "命中", "note": "core.* / world-name 等标量键只判 contains、不判类型，段/字符串会被 getDouble/getInt 静默折成 0（与 F-02 同族，影响限于数值错误），未单列；waves/monsters 段的 section 判空已做。" },
        { "pattern": "5 能力是否真实现", "result": "命中", "note": "readWaveInt 的注释声称三种非法形态全部显式化，实现只做负数一档 → F-04；world-name 写入/读取齐全但无消费者（疑似死键）→ off_dimension_notes。" },
        { "pattern": "6 转义/编码顺序", "result": "不适用", "note": "本切片只做 YAML 值读写与数值转换，无多层转义或 HTML 编码路径。" },
        { "pattern": "7 边界符号（负数/下标）", "result": "未命中", "note": "负值路径已逐一核对：victory-waves / repair-cost-amount / explode 有 normalize；readWaveInt 显式把负数钳到 0；removedWaveKeys 的波次号为 GUI 传入的正整数。" },
        { "pattern": "8 引用绑定是否存在", "result": "未命中", "note": "Java 编译期绑定，本切片无动态导入；所有被调用的 ConfigManager/GameConfig 方法均能在源码中定位。" }
      ]
    },
    "self_checks": {
      "identifier_reconcile": {
        "status": "DONE",
        "note": "对账 saveToFile 写集合（60+ 键）× mergeExternalChanges 白名单 × loadFromFile 读集合 × GUI 编辑入口：villager-health 两端齐全但无 normalize（F-03）；world-name 两端齐全但无消费者；repair-amount-per-cost/self-destruct-multiplier/spawn-radius-min|max 有 GUI 入口故不在白名单属正确设计；未发现写了读不到或读了从不写的键。"
      },
      "self_check_audit": {
        "status": "DONE",
        "note": "抽验 ConfigLoadClampTest（为 victory/repair/explode 钉了钳制+脏标志断言，无任何 villager-health 用例，佐证 F-03 是漏网而非设计）与 YamlNullMechanismTest（证明项目已知 contains/getString 机制但只用于 airdrop-mob-type）。注入故障（4.7-d）因构建写 target/ 未执行。"
      },
      "runtime_validation": {
        "status": "SKIPPED",
        "note": "复现 reload/隔离路径需 Maven 构建（会写 target/）并启动 Paper 服务端，违反零写入约束；改用入口→调用点→问题行的静态调用链坐实，各条 basis 已写明行号。"
      }
    },
    "off_dimension_notes": [
      "contract（L6）：loadMonstersConfig() 返回 void，读盘失败只打一条 SEVERE 就 return（ConfigManager.java:2006-2010），loadFromFile() 仍 return true（1964），调用方 HilltopCommandHandler.java:438-444 / MainConfigMenu.java:151-161 据此宣告「已重载」。这是返回值契约问题，应由 contract 维度立项；其数据面后果已单列为 F-06。",
      "logic/contract（模式 5）：world-name 疑似死键——全仓只有 ConfigManager.java:851（写）与 1442（读）触及 GameConfig#getWorldName，没有运行期消费者。",
      "observability：monsters-config.yml 的 9 个「写而不读」键已有一次性告警（ConfigManager.java:2101-2102，MONSTERS_CONFIG_NON_EFFECTIVE_KEYS），属知情设计，不是一致性问题。",
      "类型形状：core.* / world-name 等标量键只判 contains 不判类型，段或字符串会被 getDouble/getInt 静默折成 0，与 F-02 同族但影响仅限数值错误，未单列。"
    ]
  },
  "error": null
}
```
