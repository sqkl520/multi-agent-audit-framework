# P1 修复方案：配置隔离/重建协议统一

**日期**：2026-11-19
**依据**：深挖报告 `DEEP-REPORT.md` 第 4 节的 P1 根因族（S10-F1 + S03-F3 + S05-F6）
**范围**：目标仓库 `Hilltop Village Plugin`

> ## ✅ 实施状态：已完成（2026-11-19）
>
> **测试：944 通过 / 0 失败**（起点 937，新增 7 个）
> **红测已验证**：把 `isQuarantined` 临时退回旧逻辑后，2 个跨重启用例立刻变红
> （`corruptFileAloneIsEnough`、`quarantineSurvivesRestart`），恢复后转绿。
>
> 改动的 5 个文件：
> `util/YamlFiles.java`（+30）、`util/YamlFileGate.java`（+16）、
> `config/ConfigManager.java`（+139/−12）、`arena/ArenaManager.java`（+8/−3）、
> `admin/AdminDeployManager.java`（+35/−12）
> 新增测试：`test/.../util/YamlFilesQuarantinePersistenceTest.java`（7 个用例）
>
> **未提交**：目标仓库工作区里还混着前几轮未提交的改动，按用户约定「只审查不动 git」，
> 本轮不做任何提交。

---

## 一、问题是什么

三个配置文件（`arenas.yml` / `game-settings.yml` / `monsters-config.yml`）共享同一套隔离基础设施，
但**只有 `arena` 一处接了正确的探针，另外两处漏了**，而 `arenas.yml` 自己的写入路径还有一个顺序错误。

基础设施本身是对的：

| 组件 | 行为 | 位置 |
|---|---|---|
| `YamlFiles.quarantine` | 把坏文件 `Files.move` 成 `<name>.corrupt`（`REPLACE_EXISTING`，保留最新现场）| `YamlFiles.java:139-152` |
| `YamlFileGate` | 读盘不可用后 `readOnly=true` 闩死；**ABSENT 不解闩** | `YamlFileGate.java:55-60` |
| `YamlFileGate` 类注释 | 明确写了为什么不能自动解封 | `YamlFileGate.java:23-26` |

问题出在**调用方**。

---

## 二、三处缺陷（已逐行核实）

### 缺陷 1 · `ConfigManager` 三个 init 方法没有隔离探针

`ConfigManager.java:146-147`（settings）、`:164-165`（monsters）、`:187-188`（display）
三个方法形状完全相同：

```java
private void initSettingsFile() {
    if (!settingsFile.exists()) {
        plugin.saveResource("game-settings.yml", false);   // ← 缺陷在这
    }
    YamlFiles.Loaded loaded = settingsGate.load();
    ...
}
```

**为什么会咬人**：`YamlFiles.quarantine()` 成功后原路径**真空了**。下一次启动时
`!settingsFile.exists()` 为真 → `saveResource` 写出出厂模板 → `settingsGate.load()` 读到
一个合法的新文件 → 返回 `OK` → `readOnly` 闩被清掉。

**闩是实例级 volatile（`YamlFileGate.java:35`），每次启动新建一个。** 所以那层保护
**只活一次运行**。管理员精心调的波次表、怪物覆盖，在下一次重启时被出厂值覆盖，
只剩一个陈旧的 `.corrupt` 作证据。

> 深挖核实：`ConfigManager` 编译类里 `'corrupt'` 字样出现 **0 次** —— 它从没检查过隔离产物。

### 缺陷 2 · `ArenaManager.ensureFile` 只看闸门，重启后失效

`ArenaManager.java:842`：

```java
if (arenasGate != null && arenasGate.isReadOnly()) return;
if (!arenasFile.exists()) { plugin.saveResource("arenas.yml", false); ... }
```

这一处**比缺陷 1 好**（知道要查闸门），但同样只覆盖**同一次运行内**。
重启后新 gate 是干净的，`arenas.yml.corrupt` 还在磁盘上，模板照样被写回去。

### 缺陷 3 · `saveSpawnPoints` 的检查顺序有窗口

`AdminDeployManager.java:457-474`：

```java
YamlFileGate gate = arenasGate();
if (gate == null || !gate.writable()) { ... return false; }   // :458  此刻 writable() == true
...
YamlFiles.Loaded loaded = gate.load();                        // :471  这里才把活文件隔离掉
if (!loaded.usable() || gate.isReadOnly()) { ... return false; } // :474
```

`:458` 的检查**通过**了，`:471` 的 `load()` 才把**正在使用的** `arenas.yml` 改名成 `.corrupt`。
虽然 `:474` 会中止写入，但伤害已经发生：文件已被移走，注册表被清空，
整个会话后续所有写入被拒。

**这条可以在会话中途触发**，且 `:474` 的注释承认了 `load()` 会返回 ABSENT —— 说明写代码时
知道 `load()` 有副作用，却没把「先 load 再判断」这个顺序落实。

---

## 三、仓库里已有正确先例

### 先例 A · `ShopConfigLoader:93`（**双信号**，这是标准）

```java
public ShopConfig load() {
    File file = new File(plugin.getDataFolder(), "shop.yml");
    if (!file.exists() && isQuarantined(file)) {
        throw new IllegalStateException(quarantinedMessage(file) + ...);
    }
```

```java
private boolean isQuarantined(File file) {
    return gate.isReadOnly() || corruptFile(file).exists();   // ← 双信号
}
```

为什么必须是两个信号，`ShopConfigLoader` 的 javadoc 已经写清楚了：

> 只看 `.corrupt` 时，隔离成功但服主随后把 `.corrupt` 挪走/删除、又没放回 `shop.yml`，
> 同进程下一次 `load()` 就会重建模板；只看闸门时，**重启后闩已随进程消失**，模板照样会被写回。

### 先例 B · `ArenaManager.ensureFile:842`（只查闸门，不够）

它证明了「想到要查」这件事在仓库里出现过，但没做完整。

---

## 四、修复方案

### 4.1 抽一个共用的隔离探针

不要把 `ShopConfigLoader` 的私有方法复制三份。提到 `YamlFiles` 里：

```java
// YamlFiles.java 新增

/**
 * 该文件的隔离产物路径（{@code <name>.corrupt}），与 {@link #quarantine} 的命名保持一致。
 */
public static File corruptFile(File file) {
    return new File(file.getAbsoluteFile().getParentFile(), file.getName() + ".corrupt");
}

/**
 * 判断「这个文件当前处于隔离态」——**磁盘与闸门两个信号缺一不可**。
 *
 * <p>只看 {@code .corrupt}：服主把坏文件挪走又没放回原文件时，会被判成「首次安装」而重建模板。</p>
 * <p>只看闸门：{@link YamlFileGate} 的 readOnly 是实例级 volatile，重启即失效，
 * 而 {@code .corrupt} 留在磁盘上——最坏的那条数据覆盖链正发生在重启之后。</p>
 */
public static boolean isQuarantined(File file, YamlFileGate gate) {
    return gate != null && gate.isReadOnly() || corruptFile(file).exists();
}
```

> **注意运算符优先级**：必须写成 `(gate != null && gate.isReadOnly()) || corruptFile(file).exists()`，
> 或加括号。`&&` 优先级高于 `||`，所以 `a && b || c` 等于 `(a && b) || c`——这里刚好是对的，
> 但显式加括号更好读。

### 4.2 改 `ConfigManager` 三个 init

三处改成同一个形状：

```java
private void initSettingsFile() {
    if (!settingsFile.exists()) {
        if (YamlFiles.isQuarantined(settingsFile, settingsGate)) {
            // 隔离态：绝不能重建。保持闸门锁定，本文件本次运行只读。
            plugin.getLogger().severe("game-settings.yml is missing but "
                + YamlFiles.corruptFile(settingsFile).getName() + " is present: "
                + "the file was quarantined. Refusing to rebuild it from the jar template "
                + "(that would silently replace the admin's tuning with factory defaults). "
                + "Restore/repair the .corrupt file as game-settings.yml, then restart.");
            settingsGate.lock();       // 新增：确保本进程内保持只读
            return;                    // 不要调 settingsGate.load()
        }
        plugin.saveResource("game-settings.yml", false);   // 真·首次安装
    }
    YamlFiles.Loaded loaded = settingsGate.load();
    if (!loaded.usable()) { ... 现有逻辑不变 ... }
}
```

`initMonstersConfigFile` / `initDisplayFile` 同样处理。

**`settingsGate.lock()` 需要新增**（`YamlFileGate` 目前只有 `reset()` 能改这个字段，
没有强制锁定的公开方法）：

```java
/**
 * 强制置为只读。用于「已知处于隔离态、且没有 load() 可调用」的场景
 * （文件不存在时调 load() 会返回 ABSENT 并保持闩——但如果调用方选择了不调 load()，
 * 就必须显式锁，否则 writable() 会返回 true）。
 */
public void lock() {
    readOnly = true;
}
```

### 4.3 改 `ArenaManager.ensureFile`

```java
private void ensureFile() {
    if (YamlFiles.isQuarantined(arenasFile, arenasGate)) return;   // 双信号
    if (!arenasFile.exists()) { ... }
}
```

把原来只看闸门的那一行换成 `isQuarantined`，一行改动。

### 4.4 改 `saveSpawnPoints` 的顺序

**把 `load()` 提到所有写入前检查之前**：

```java
public boolean saveSpawnPoints() {
    String arenaId = gameManager.getArenaId();

    YamlFileGate gate = arenasGate();
    if (gate == null) { lastSaveFailed = true; return false; }

    if (arenasFile == null) {
        arenasFile = new File(plugin.getDataFolder(), "arenas.yml");
    }

    // 先 load —— 这一步本身可能触发隔离，必须在任何 writable() 判断之前发生。
    YamlFiles.Loaded loaded = gate.load();
    if (!loaded.usable() || gate.isReadOnly()) {
        lastSaveFailed = true;
        plugin.getLogger().warning("Refusing to write arenas.yml (unusable"
            + (gate.isReadOnly() ? " or quarantined" : "") + ")");
        return false;
    }

    // 现在可以安全判断：load 之后 gate 的状态才是可信的
    if (!gate.writable()) { lastSaveFailed = true; return false; }

    arenasConfig = loaded.config();
    ...
}
```

**关键点**：`writable()` 的语义是「能不能写」，而 `load()` 会改变它。所以
**任何以 `writable()` 为前置条件的多步操作，都必须先 `load()` 再查 `writable()`.**
这条纪律值得写进 `YamlFileGate` 的类注释。

### 4.5 改 `saveSpawnPoints` 的「写失败仍改内存」

> **先纠正一处**：深挖报告的 S05-F6 写的是「`:527` 的 `saved` 未参与 push 决策」，
> 容易读成「`saved` 没被检查」。**核实后不是这样** —— `:541` 明确有 `lastSaveFailed = !saved`。
>
> 真实问题是：**`saved` 被记录了，但没有阻止后面的内存写入。**

`AdminDeployManager.java:527-541` 的实际顺序：

```java
boolean saved = gate.write(arenasConfig);        // :527  写盘，可能失败

// 无条件刷新内存 —— 不管 saved 是真是假
gameManager.setSpawnPoints(savedSpawnPoints);    // :530
gameManager.setMobSpawnPoints(savedMobSpawnPoints);
if (savedCoreLocation != null) {
    gameManager.setCoreLocation(savedCoreLocation);
}

if (!saveShopNpcLocation()) { saved = false; }   // :539
lastSaveFailed = !saved;                         // :541  才记录失败
return saved;
```

**后果**：写盘失败后，服务器内存里是新值，磁盘上是旧值。重启即回滚，
而管理员在本次会话内看到的是「已生效」。这是**静默的会话级状态漂移**。

修法：

```java
boolean saved = gate.write(arenasConfig);
if (!saved) {
    lastSaveFailed = true;
    // 不 push 内存：内存必须与磁盘保持一致，否则重启即回滚，
    // 而管理员在本次会话内看到的是「已生效」——那是静默的状态漂移。
    return false;
}

// 写盘成功后才刷新内存
gameManager.setSpawnPoints(savedSpawnPoints);
gameManager.setMobSpawnPoints(savedMobSpawnPoints);
if (savedCoreLocation != null) gameManager.setCoreLocation(savedCoreLocation);

if (!saveShopNpcLocation()) { lastSaveFailed = true; return false; }
lastSaveFailed = false;
return true;
```

**需要确认**：`saveShopNpcLocation()` 写的是同一份 `arenas.yml`。如果它失败时主写入已成功，
则磁盘上「生成点已更新、shop-npc 未更新」。这个半成功状态本身要不要回滚，是个产品判断——
不在 P1 范围内，但值得单独记一笔。

---

## 五、改动清单

| 文件 | 改动 | 行数估计 |
|---|---|---|
| `util/YamlFiles.java` | 新增 `corruptFile(File)` + `isQuarantined(File, YamlFileGate)` | +25 |
| `util/YamlFileGate.java` | 新增 `lock()`；类注释补「load 会改状态」纪律 | +12 |
| `config/ConfigManager.java` | 三个 init 方法加隔离探针 | +45 |
| `arena/ArenaManager.java` | `ensureFile` 一行换成双信号 | +2 / −1 |
| `admin/AdminDeployManager.java` | `saveSpawnPoints` 调整顺序；`:527` 检查 `saved` | +15 / −8 |

**总计约 +100 行**，无新依赖，不改任何公开 API。

---

## 六、验证方式（每条缺陷对应一个必须变红的测试）

| 缺陷 | 测试 | 断言 |
|---|---|---|
| 1 · settings | 写坏 `game-settings.yml` → 加载（被隔离）→ **销毁 gate 新建一个**（模拟重启）→ 再加载 | `game-settings.yml` **不存在**（没被重建），且日志含 `quarantined` |
| 1 · monsters/display | 同上 ×2 | 同上 |
| 2 · arenas 重启 | 同上，针对 `arenas.yml` | 同上 |
| 3 · 顺序 | 让 `gate.load()` 返回不可用（文件损坏），断言 `saveSpawnPoints()` 返回 false **且** 隔离发生前没有任何内存状态被改 | `gameManager` 的生成点与调用前一致 |
| 4 · saved 未检查 | 注入 `gate.write` 返回 false | 内存状态不变 |

**关键**：缺陷 1 和 2 的测试**必须模拟「重启」**——新建一个 `YamlFileGate` 实例。
只断言「同一次运行内不会重建」是测不出这个 bug 的，因为原来的代码在单次运行内是对的。

---

## 七、我推荐的实施顺序

1. **先做 4.1（共用探针）** —— 后面三处都依赖它，且它本身可独立测试
2. **再做 4.2（ConfigManager 三处）** —— 危害最大（丢管理员配置）
3. **然后 4.3（ArenaManager 一行）** —— 同族，顺手
4. **最后 4.4 / 4.5（顺序）** —— 需要改流程，测试也要改，单独一次提交

每一步都配对应测试，且**先在旧代码上跑一遍确认测试是红的**——否则你不知道测试有没有真的测到东西。

---

## 八、核实记录与仍未验证的部分

### 已核实（本轮补证）

**`Plugin#saveResource(String, boolean)` 在文件不存在时必定写盘。**

反编译 `JavaPlugin.class`（paper-api 1.20.4，该 API 自 Bukkit 起未变）的控制流：

```
113: invokevirtual java/io/File.exists:()Z
116: ifne          125      ← 文件存在 → 跳过写入，直接到结尾
...
134: ifeq          192      ← replace=false 且已存在 → 也跳
137: new           java/io/FileOutputStream
143: invokespecial FileOutputStream."<init>":(Ljava/io/File;)V   ← 写盘
```

`replace` 参数只影响「文件**已存在**时」是否覆盖；文件**不存在**时，无论 `replace` 取值都会写。

**这确认了整个缺陷链的关键一环**：`quarantine()` 把原文件 `Files.move` 走之后，
下一次启动 `!file.exists()` 必然为真 → `saveResource` 必然写出出厂模板 → 缺陷 1 和 2 成立。

### 仍未验证

1. **没有实际运行服务端**。缺陷 1/2 的「重启后会重建」是基于
   `readOnly` 是实例级 volatile（`YamlFileGate.java:35`）+ `quarantine` 用 `Files.move` 移走原文件
   + 上面那条 `saveResource` 语义，三段推理串起来的。每一段都核实过，但没跑过完整重启流程。

2. **`lastSaveFailed` 的读取方**已查：只有 `AdminDeployManager:634-635` 一处消费
   （`boolean failed = lastSaveFailed; lastSaveFailed = false;`），供向导 autoSave 播报。
   **所以改返回时机不影响其它调用方**——但 `:653/659/665/689` 四处调 `saveSpawnPoints()`
   都忽略了返回值，改后它们的「失败时仍改内存」行为会变成「失败时不改内存」，
   这是**修复**而非回归，但需在测试里覆盖。

3. **`YamlFiles.write` 的降级路径**（S10-F4，锐评已撤销）说非原子移动在 Windows 上是
   「先删目标再改名」——本轮没有重新反编译 `WindowsFileCopy.move` 验证。
   不影响 P1 方案（不涉及这条路径），但如果要一并修，需先核实。

4. **`saveShopNpcLocation()` 失败时的半成功状态**（生成点已写、shop-npc 未写）
   要不要回滚，是产品判断，本方案未处理。

### 一处需要向深挖报告更正的

深挖报告 S05-F6 的标题写「failed arenas.yml write still replaces the live arena's spawn points
**and core** in memory」，其中 "and core" 需要限定：
`gameManager.setCoreLocation` 只在 `savedCoreLocation != null` 时调用（`:532-534`），
所以**核心坐标只在本次确实设置过时才被覆盖**，不是无条件覆盖。生成点才是无条件的。
