# #8 — reload 消息说谎

**状态：已修复。**

## 缺陷根因

`ConfigManager.loadFromFile()` 原签名是 `void`。当 `game-settings.yml` 不可用（空文件 / 解析失败 /
语义哨兵不通过）或本进程已因隔离锁定只读时，它只打一条 SEVERE、保留内存值并提前 `return`，
**既不抛异常也不给调用方任何信号**。

两条生产调用链因此都在“什么都没读进来”时照常宣告成功：

- 原 `MainConfigMenu.java:149`：丢掉返回值，无条件发 `config.menu.main.reloaded-msg`，还播成功音。
- 原 `HilltopCommandHandler.java:420`：虽然包了 `catch (RuntimeException)`，但 `loadFromFile()` 不抛异常，
  catch 永不触发，随后 `config-reloaded` 照发。

## 改了什么

### 1. `src/main/java/com/hilltopvillage/config/ConfigManager.java`

- `:1349-1360` — 签名改为 `boolean`，Javadoc 明确契约：

```java
/**
 * ...
 * <p><b>返回值不是装饰</b>：文件不可用（校验失败 / 空文件 / 读盘异常）或本进程已因隔离锁定只读时，
 * 本方法只打一条 SEVERE 并保留调用前的内存值，<b>不会抛异常</b>。调用方（GUI 的
 * 「加载配置文件」与 {@code /hilltop reloadconfig}）必须消费返回值：{@code false} 表示
 * 这次没有重载，绝不能向管理员宣告「已重载」。</p>
 *
 * @return true = 本次确实读到并应用了可用的 {@code game-settings.yml}；
 *         false = 未重载，内存值保持调用前的状态
 */
public boolean loadFromFile() {
```

- `:1382-1395` — 失败分支保留内存、快照与 `settingsLoadedFromDisk=false`，并返回 `false`：

```java
YamlFiles.Loaded loaded = settingsGate.load();
if (!loaded.usable() || loaded.status() == YamlFiles.Status.ABSENT
        || settingsGate.isReadOnly()) {
    plugin.getLogger().severe("game-settings.yml is unusable; keeping the in-memory values "
            + "(nothing will be read from or written to the file this run)");
    settingsLoadedFromDisk = false;
    loadMonstersConfig();
    lastSavedSnapshot = activeConfig.snapshot();
    return false;
}
settingsYaml = loaded.config();
settingsLoadedFromDisk = true;
```

- `:1932` — 只有真正走完磁盘重建才返回 `true`：

```java
warnUnknownTopLevelKeys();
return true;
```

**额外收紧的 ABSENT 分支**：原注释已经写了“隔离后文件不存在 → load() 返回 ABSENT（usable），
照走会把空配置当权威”，但旧条件只判 `!usable() || isReadOnly()`。`/hilltop reloadconfig` 在
`loadFromFile()` 之前会 `settingsGate.reset()` 解闩；如果隔离后的文件已被删除，此时 `isReadOnly()`
为 false、`load()` 返回 `ABSENT` 且 `usable()==true`，旧条件会放行，用空配置重建内存并返回 `true` ——
既洗掉管理员配置，又继续播报“已重载”。因此把 `ABSENT` 也列入拒绝条件，并加了回归测试。
这是同一个“文件不可用却报成功”的缺陷在命令路径上的真实分支，不是另开一项。

### 2. `src/main/java/com/hilltopvillage/config/menu/MainConfigMenu.java:146-165`

```java
setClickableItem(bottomRow + 4, Material.CRAFTING_TABLE,
        lang.getFor(admin, "config.menu.main.reload"),
        ct -> {
            // #8：loadFromFile() 在 game-settings.yml 不可用/只读时会保留内存值并提前返回，
            // 且不抛异常。丢弃返回值就会在磁盘什么都没读到的情况下宣告「已重新加载」。
            boolean reloaded = configManager.loadFromFile();
            if (reloaded) {
                admin.sendMessage(lang.getFor(admin, "config.menu.main.reloaded-msg"));
                admin.playSound(admin.getLocation(),
                        org.bukkit.Sound.BLOCK_NOTE_BLOCK_PLING, 1.0f, 1.0f);
            } else {
                // 与 save-failed 同款对照音：成功是 PLING，失败是沉重的铁砧落地。
                admin.sendMessage(lang.getFor(admin, "config.menu.main.reload-failed"));
                admin.playSound(admin.getLocation(),
                        org.bukkit.Sound.BLOCK_ANVIL_LAND, 1.0f, 0.8f);
            }
            reopen();
        },
        lang.getFor(admin, "config.menu.main.reload-lore1"),
        lang.getFor(admin, "config.menu.main.reload-lore2"));
```

成功文案与成功音效逐字未变；失败改用同菜单保存失败已有的 `BLOCK_ANVIL_LAND` 对照音。
`reopen()` 两条路径都执行，失败后界面仍展示内存里的旧值。

### 3. `src/main/java/com/hilltopvillage/command/HilltopCommandHandler.java:418-447`

```java
// 成功提示必须放在所有重载步骤之后：早发会让后续步骤抛出时管理员看到假成功。
try {
    // #8：loadFromFile() 失败不抛异常（保留内存值并提前 return），所以这里必须
    // 消费返回值；否则下面的 catch 永远不会触发，config-reloaded 照发。
    boolean configReloaded = plugin.getConfigManager().loadFromFile();
    plugin.getConfigManager().reloadDisplay();
    if (plugin.getTabListManager() != null) {
        plugin.getTabListManager().start();
        for (Player online : Bukkit.getOnlinePlayers()) {
            plugin.getTabListManager().refreshNow(online);
        }
    }
    plugin.getLanguageManager().reload();
    if (configReloaded) {
        sender.sendMessage(lang.getFor(player, "config-reloaded"));
    } else {
        // 不说「已重载」：game-settings.yml 没读进来，内存仍是旧值。
        // messages.yml 是独立文件，仍可能已成功重载，故下面照发 messages-reloaded。
        sender.sendMessage(lang.getFor(player, "config-reload-failed"));
    }
    sender.sendMessage(lang.getFor(player, "messages-reloaded"));
    sender.sendMessage(lang.getFor(player, "config.reload-arena-notice"));
} catch (RuntimeException ex) {
    ...
}
```

`messages-reloaded` 与竞技场提示在失败路径继续发：它们分别描述独立的 `messages.yml` 重载和
`arenas.yml` 需重启这一事实，不是 `config-reloaded` 的同义词。`config-reloaded` 只在
`configReloaded==true` 时发。

### 4. `src/main/resources/messages.yml`

新增 2 个 key × EN/ZH（共 4 行）；既有成功文案一字未改：

- `:23` `config-reload-failed`（EN，命令）
- `:635` `config.menu.main.reload-failed`（EN，GUI）
- `:1312` `config-reload-failed`（ZH，命令）
- `:1737` `config.menu.main.reload-failed`（ZH，GUI）

EN 命令：

```yaml
config-reload-failed: "&cGame settings were NOT reloaded — game-settings.yml is unreadable or read-only this run, so the in-memory game-settings values are unchanged. Check the console log (latest.log) for the SEVERE entry, fix the file, then run /hilltop reloadconfig again."
```

ZH 命令：

```yaml
config-reload-failed: "&c游戏设置未重载——本次运行中 game-settings.yml 无法读取或处于只读状态，游戏设置没有重载，内存中的游戏设置值保持不变。请查看控制台日志（latest.log）中的 SEVERE 记录，修好文件后再次执行 /hilltop reloadconfig。"
```

EN GUI：

```yaml
config.menu.main.reload-failed: "&cReload failed — game-settings.yml is unreadable or read-only this run; no game settings were reloaded and the in-memory game-settings values are unchanged. Check the console log (latest.log) for the SEVERE entry, fix the file, then try again."
```

ZH GUI：

```yaml
config.menu.main.reload-failed: "&c重载失败——本次运行中 game-settings.yml 无法读取或处于只读状态，游戏设置没有重载，内存中的游戏设置值保持不变。请查看控制台日志（latest.log）中的 SEVERE 记录，修好文件后重试。"
```

**为什么文案把范围限定为“游戏设置”而不是“什么都没重载”**：`loadFromFile()` 在失败前已经
`loadDisplayConfig()`，失败分支还会 `loadMonstersConfig()`；命令随后还会 `reloadDisplay()`、
`reload()` messages.yml。写“nothing was reloaded”会制造一条新的假话。文案准确说明了
**game-settings 没有重载、内存中的 game-settings 值未变**，并给出控制台 SEVERE 的排查指引。

### 5. 测试

- `src/test/java/com/hilltopvillage/config/ConfigManagerTest.java:234-307` — 新增 4 条直接契约测试：
  - `loadFromFileReturnsTrueOnSuccess`
  - `loadFromFileReturnsFalseAndKeepsMemoryWhenSettingsUnusable`
  - `loadFromFileReturnsFalseWhenGateIsReadOnlyEvenIfFileIsAbsent`
  - `loadFromFileReturnsFalseWhenFileIsAbsentEvenAfterGateReset`
- `src/test/java/com/hilltopvillage/config/menu/MainConfigMenuReloadResultTest.java`（新文件，2 条）：
  - `failedReloadReportsFailureInsteadOfSuccess`
  - `successfulReloadKeepsTheOriginalFeedback`
- `src/test/java/com/hilltopvillage/command/HilltopCommandReloadResultTest.java`（新文件，2 条）：
  - `failedReloadDoesNotAnnounceSuccess`
  - `successfulReloadKeepsTheOriginalFeedback`

GUI 测试用真实 `ConfigManager` + `BareHost`，点击 `bottomRow+4=49` 的 reload 按钮；命令测试
用 `loadFullPlugin()` + 真实命令处理器。失败侧都用空 `game-settings.yml` 触发真实的
`SUSPECT → 隔离 → 本进程只读 → 提前 return` 链，而不是 mock 一个 false。成功侧都断言磁盘新值
真的进入内存，防止“只改文案、不改加载”的假绿。

## 红的测试与失败信息（未修复代码）

首次在未修复的 `void` 版上跑两个调用方测试：

```
Tests run: 4, Failures: 2, Errors: 0, Skipped: 0
```

两条成功侧反向对照均通过，说明夹具本身能走通；失败只落在“失败仍报成功”的两个用例上。

### GUI：`failedReloadReportsFailureInsteadOfSuccess`

```
org.opentest4j.AssertionFailedError: ★ game-settings.yml 不可用时必须发 reload-failed（而不是 reloaded-msg）。 缺陷版在这里发的是 reloaded-msg —— 管理员会以为磁盘值已经生效 ==> expected: <config.menu.main.reload-failed> but was: <config.menu.main.reloaded-msg>
```

### 命令：`failedReloadDoesNotAnnounceSuccess`

```
org.opentest4j.AssertionFailedError: ★ game-settings.yml 不可用时 /hilltop reloadconfig 必须发 config-reload-failed。 缺陷版完全不发失败消息，管理员只看到「已重载」。实际播报=[§a游戏设置已从 game-settings.yml 重新加载。, §a语言文件已从 messages.yml 重新加载。, §e提示：竞技场参数（min-players / victory-waves / wave-interval / 倒计时等）存放在 arenas.yml，可通过 §f/hilltop manage §e参数页在线修改（立即生效），手动编辑本文件则需重启服务器。] ==> expected: <true> but was: <false>
```

控制台同时出现真实失败路径的 SEVERE：

```
game-settings.yml is unusable (file is empty or has no YAML document); renamed to game-settings.yml.corrupt; this run is READ-ONLY for that file
game-settings.yml is unusable; keeping the in-memory values (nothing will be read from or written to the file this run)
```

说明：`ConfigManagerTest` 的 4 条 API 契约测试无法在旧 `void` 签名上编译，因此它们不是红测，
而是在签名改为 `boolean` 之后补的回归网；真正先红的是上面两条调用方测试。

为把失败原文完整留档，又在保留 `boolean` API（让测试可编译）的前提下，把两个调用方临时还原到
HEAD 复跑，失败文本与首次一致；复现后按字节恢复两个文件并做 SHA-256 比对，再执行 clean build。

## 修复后结果

定向（`MainConfigMenuReloadResultTest` + `HilltopCommandReloadResultTest` + `ConfigManagerTest`）：

```
Tests run: 22, Failures: 0, Errors: 0, Skipped: 0
```

完整套件（`build.cmd -o test`；另用 `build.cmd -o clean test` 强制全量重编译复核）：

```
Tests run: 885, Failures: 0, Errors: 0, Skipped: 1
BUILD SUCCESS
```

基线为 **877 / 0 失败 / 1 跳过**；新增 8 条测试，885 = 877 + 8。`build.cmd` 退出码 0。

## 有没有改既有测试

**没有修改任何既有测试方法或断言。** 只在既有 `ConfigManagerTest.java` 中新增 4 个测试方法，
另新建两个测试类；既有测试未为适配新代码做任何改动。

既有 4 处裸调用 `config.loadFromFile();` 保持原样，且 Java 允许在表达式语句中丢弃返回值，
因此 `boolean` 返回不破坏它们；完整编译已验证：

- `ConfigManagerTest.java:159`
- `ConfigManagerTest.java:180`
- `WaveTombstoneLifetimeTest.java:131`
- `WaveKeySetAuthorityTest.java:185`
- 另有构造器 `ConfigManager.java:139` 的 `loadFromFile();`

## 设计决策

- **用 `boolean`，不用 enum**：两种失败（文件不可用、本进程只读）对管理员是同一个动作——
  看控制台、修文件、重试；没有任何调用方需要区分“解析失败/语义可疑/隔离后缺失”。enum 只会
  增加无人消费的 API 面积。
- **成功文案完全不动**：GUI 仍是 `config.menu.main.reloaded-msg`，命令仍是 `config-reloaded`，
  成功音仍是 `BLOCK_NOTE_BLOCK_PLING`。
- **命令失败仍发 `messages-reloaded` 与竞技场提示**：前者是独立文件的真实结果，后者是
  `arenas.yml` 无法热重载的固定提示；它们不宣称 game-settings 成功。
- **GUI 失败用铁砧音**：与同菜单保存失败的反馈一致，避免“红字 + 成功音”的自相矛盾。
- **ABSENT 也拒绝**：命令路径先 `reset()` 再 `loadFromFile()`，隔离后文件缺失时只剩 ABSENT
  这一条信号；不拦会洗掉内存并返回 true。该分支有独立测试。

## CHANGELOG 建议（未改文件）

合适补，但**不应回填已发布的 `1.1.0-SNAPSHOT-fix3`**（该段日期为 2026-11-11，正文写死 846 项测试）。
建议在文件顶部新开一个版本段（版本号/日期由你定，下面以 `1.1.0-SNAPSHOT-fix4 - 2026-11-15`
占位），沿用既有的 `### Fixed（日期 — 主题）` / `### Changed（日期 — 主题）` 格式：

```markdown
## [1.1.0-SNAPSHOT-fix4] - 2026-11-15

### Fixed（2026-11-15 — reload 回执与真实结果对齐）

- **【#8】reload 失败不再播报成功**：`ConfigManager.loadFromFile()` 改为返回 `boolean`。
  `game-settings.yml` 不可用、只读，或隔离后文件缺失时返回 `false` 并保留内存值；配置菜单与
  `/hilltop reloadconfig` 分别改发 `config.menu.main.reload-failed` / `config-reload-failed`
  （EN/ZH），明确“游戏设置没有重载、内存中的游戏设置值未变、请查控制台 SEVERE”，
  成功文案与成功音效保持不变。测试 885 项（0 失败 / 1 跳过）。

### Changed（2026-11-15 — 两项可感知的数值语义变化）

- **自爆甲虫的爆炸威力与节点伤害倍率解耦**：`explode-damage-multiplier` 现在只放大节点伤害，
  所有非 0 倍率统一使用普通苦力怕的 3.0 爆炸威力。原本配置 0.5 的服务器会感觉爆炸明显变强，
  配置 10 的会感觉变弱。
- **`nodes.repair-cost-amount` 改为“单次修复最多消耗几个”**：按实际缺口取最少物品，不再固定扣满；
  已部署的旧配置注释不会自动迁移，管理员需按新语义理解。
```

后两条不是 #8 的改动（分别来自 #6 与 #1）；这里只给建议文本，没有写进 `CHANGELOG.md`。

## 风险与未覆盖场景

- **ABSENT 的行为变化**：以前隔离后文件被删除、再执行 `/hilltop reloadconfig`，会 reset 解闩后用
  空配置重建内存并报成功；现在会返回 `false` 并保留内存。若管理员确实想恢复出厂值，应重启服务器
  让 `initSettingsFile()` 重新生成模板，而不是删除文件后 reload。这是有意的安全取舍。
- **成功只代表 game-settings 已加载**：`loadFromFile()` 末尾还会 `loadMonstersConfig()`；若
  `monsters-config.yml` 独立失败，它会自己打 SEVERE，但 `loadFromFile()` 仍返回 `true`（本次
  game-settings 确实读到了）。失败提示只覆盖 `game-settings.yml`，不覆盖怪物配置的部分失败。
- **`catch (RuntimeException)` 的部分失败提示仍是硬编码英文**（`Config reload failed part-way...`），
  只在后续 display/tab/language 重载抛异常时触发；它不冒充成功，但未本地化。这是既有路径，未在 #8 改。
- **失败路径仍会独立重载 display.yml / monsters-config.yml，命令还会重载 messages.yml**；
  提示文案已限定为“游戏设置”，没有宣称这些文件也失败。
- **测试覆盖**：失败侧覆盖了 SUSPECT（空文件）、ABSENT（隔离后缺失）和 read-only 闸门；
  没有单独构造 `PARSE_FAILED` / `QUARANTINE_FAILED`，但它们与 SUSPECT 一样走 `!usable()` 分支，
  `YamlFilesTest` 已覆盖状态本身。
- **未覆盖“失败后修好文件再点一次”的 GUI 恢复链**：代码上 `YamlFileGate.load()` 在读到 `OK` 时会
  清除 readOnly，因此提示里的“fix the file, then try again”成立；但没有专门的“先失败、再修好、
  再成功”的单一测试用例，恢复能力由 `YamlFileGateTest` 的 OK 解闩测试与本次成功侧测试间接覆盖。
- **相邻遗留问题（未修，供后续排期）**：
  - `nodeSelfDestructMultiplier` 仍无 NaN/Infinity 钳制，NaN 会污染节点伤害（#6 相邻）。
  - #4 第 7 步商店 NPC 删除仍不可逆。
  - `arenas.yml` 每竞技场的 `game.victory-waves` 有独立读取路径，不受 #7 的 `game-settings.yml`
    钳制覆盖。
