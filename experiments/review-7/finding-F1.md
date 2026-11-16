# F1 复审（红队）：`shop.yml` 解析失败不再降级为空商店

复审对象：`git diff src/main/java/com/hilltopvillage/shop/ShopConfigLoader.java`（未提交改动）
复审方式：只读 + 在 `/tmp` 下用真实 `paper-api 1.21.4` / `snakeyaml 2.2` 复刻判定链做实证（未改动仓库任何文件）
复审日期：本轮

---

## 结论

**有缺陷（且引入了一条新的、比原缺陷更隐蔽的数据丢失路径）。**

核心问题不是「代码写得脏」，而是**这条修复的判定面只覆盖了它自己炮制的那一个样本**：

- 用出厂 `shop.yml`（5575 字节）做**逐字节截断穷举**，`ShopConfigLoader.load()` 的新判定对 **70.8%** 的截断仍归为「静默降级」，只拦下 29.2%（且其中 27.8% 是靠既有的 `parse` 异常路径拦的，与本次修复无关）。
- 换成更贴近真实编辑器的**行边界截断**（192 个样本），新判定只拦下 **2 个（1.0%）**，其余 **190 个** 全部静默变成「部分商店」或「空商店」。

F1 的原始症状（无提示变空店）在 **30.3%** 的字节偏移上**原样存在**。修复是有效的，但只在一个极窄的窗口内有效，而注释与测试把它描述成「截断已被拦住」。

---

## 攻击点逐条验证

### 攻击点 1：`rawShopSection` 的正确性

**1a. 空文件 / 只有注释 / 非 Map 根节点分别返回什么？会不会 NPE？**

实证（`new Yaml().load(String)`，snakeyaml 2.2）：

| 输入 | `new Yaml().load()` | `root instanceof Map` | 是否 NPE |
|---|---|---|---|
| `""`（空文件） | `null` | false → `return null` | 否 |
| 只有注释 `# a\n# b\n` | `null` | false → `return null` | 否 |
| 根是标量 `hello` | `String:"hello"` | false → `return null` | 否 |
| 根是列表 `- a\n- b` | `ArrayList` | false → `return null` | 否 |
| `shop: 5` | `{shop=5}` | shop 非 Map → `return null` | 否 |

NPE 风险为**零**。但这不是好消息：**每一个 `return null` 都被调用方解释成「找不到截断证据 → 放行」**。

`ShopConfigLoader.java:130-144`：

```java
private Map<?, ?> rawShopSection(File file) {
    try {
        Object root = new Yaml().load(Files.readString(file.toPath(), StandardCharsets.UTF_8));
        if (root instanceof Map<?, ?> rootMap) {
            Object shop = rootMap.get("shop");
            if (shop instanceof Map<?, ?> shopMap) {
                return shopMap;
            }
        }
        return null;
    } catch (IOException | RuntimeException failure) {
        ...
```

守卫本身 `ShopConfigLoader.java:69-77` 有三层独立的「静默放行」出口：

```java
if (yaml.getConfigurationSection("shop.items") == null) {
    Map<?, ?> rawShop = rawShopSection(file);
    if (rawShop != null && rawShop.containsKey("items")
            && !(rawShop.get("items") instanceof Map)) {
        throw new IllegalStateException(...);
```

`rawShop == null`（注释头截断、`shop: 5`）、`!containsKey("items")`（缺键）、`items instanceof Map`（`items:` 下全是 null 子键，见下）——三者任一命中就是「文件没问题」。

**实测：逐字节截断出厂 `shop.yml`（5575 个前缀，复刻完整判定链）**

| 判定结果 | 字节偏移数 | 占比 |
|---|---:|---:|
| `B` 解析失败 → 隔离 → 抛（**修复前也是这个行为**） | 1549 | 27.8% |
| `D` `items` 存在但非映射 → 抛（**本次新增**） | 76 | 1.4% |
| `E` **静默空店**（`items` 键根本不存在） | 1690 | **30.3%** |
| `F` **静默空店**（`items` 存在但子键全 null） | 8 | 0.1% |
| `G` **静默部分商店**（少了若干商品） | 2252 | **40.4%** |

**换成行边界截断（更贴近真实编辑器/磁盘半写，192 个样本）：**

| 判定结果 | 样本数 | 命中行号（文件行） |
|---|---:|---|
| `D` 抛 | **2** | 37–38（`  items:` 与其后一行注释） |
| `E` 静默空店 | 36 | 1–36（整段注释头 + `currency`/`npc`/`gui`） |
| `F` 静默空店 | 1 | 39（`    bow:`） |
| `G` 静默部分商店 | 153 | 40–192 |

即：**修复只覆盖了「正好截在 `items:` 这一行」这一个点；截在它前一行或后一行都失效。**

最刺眼的一行是 `F`：文件停在

```yaml
shop:
  gui:
    size: 54
  items:
    bow:
```

此时 snakeyaml 给出 `items = {bow: null}` —— **`items` 值是 Map，`instanceof Map` 为真 → 守卫跳过 → 静默 0 件商品**。这距离被拦住的形态只差**一行**。实证：

```
=== real-template-cut-at-bow-header
  raw shop = {items={bow=null}} | items instanceof Map = true
  bk CS(shop.items) = OBJ keys=[] | verdict: PASS->items=0
```

同理 `items:` 下写三个空段头（`bow:` / `arrow:` / `sword:`）也是 `PASS->items=0`。

**1b. `catch (IOException | RuntimeException)` 把解析失败吞了，归类对吗？**

**不对，而且这段 catch 的文案在任何正常路径下都是错的。**

先看顺序：`YamlFiles.load`（`ShopConfigLoader.java:55`）已经先行解析并隔离，凡是真正的解析失败都在那里变成 `PARSE_FAILED` → `!usable()` → `:56-61` 先抛，**根本走不到 `rawShopSection`**。

因此 `rawShopSection` 里能捕获到 `RuntimeException`，只可能是这几种：

1. **两个解析器不是同一个解析器**（见下）；
2. 两次读盘之间文件被改动（见 1c）；
3. 两次读盘之间文件被删除（`Files.readString` → `NoSuchFileException`）。

这三种没有一种是「文件被截断」。但代码把它们统一写成：

```java
throw new IllegalStateException("shop.yml could not be inspected for a truncated"
        + " 'shop.items' section: " + failure.getMessage(), failure);
```

**「无法检查截断」被当成「疑似截断」上报，是诊断责任的错误转移**：真正的原因（文件被并发替换 / 文件消失 / 解析器限额不一致）被降级成 `failure.getMessage()` 的附带信息，管理员读到的第一句是「你的文件被截断了」——而它可能根本没被截断。这与仓库其他地方的姿势相反：`YamlFiles` 的注释（`YamlFiles.java:26-27`）明确说「让解析异常真的抛出来」，其目的是**如实归因**，这里反而把归因糊掉了。

**并且两个解析器的限额不一致（实证）**：

`new Yaml()` 用 snakeyaml 默认 `LoaderOptions`（alias 上限 50 / codePoint 上限 3 MiB / nesting 上限 50）；而 Bukkit 的 `YamlConfiguration` 构造器把三项都放宽了（反编译 `YamlConfiguration.class` 可见 `setMaxAliasesForCollections(2147483647)`、`setCodePointLimit(2147483647)`、`setNestingDepthLimit(100)`）。

| 形态 | `new Yaml()`（`rawShopSection`） | `YamlConfiguration`（Bukkit） |
|---|---|---|
| 60 层嵌套 | **抛** `Nesting Depth exceeded max 50` | **OK** |
| 60 个别名引用 | **抛** `Number of aliases ... max=50` | **OK** |
| 3.2 MB 文档 | **抛** `exceeds the limit: 3145728 code points` | **OK** |

两份解析器对同一份文件「一份接受、一份拒绝」是系统性存在的。这在此处只会往「误报截断 + 启动失败」方向倒。

**1c. 读同一个文件两次，两次之间文件变了会怎样？**

`ShopConfigLoader.java:55` 读第一次（`YamlFiles.load` → `Files.readString`），`:70` 读第二次（`rawShopSection` → `Files.readString`），**中间没有任何快照/比较**。后果分两种，都是错的：

- **误杀**：第一次读到合法文件（`usable()` 通过），第二次读到管理员正在保存的半截文件 → `rawShopSection` 抛 / 或判定截断 → 一份**合法**配置被拒绝加载。开服期间管理员用编辑器存 `shop.yml` 就会被撞上（窗口很小，但 `/hilltop shop reload` 是给管理员在改文件时用的命令，撞上的场景恰恰是它的主场）。
- **漏放**：反方向——第一次读到 `items: null`（该抛），第二次读到已修好的文件 → `instanceof Map` 成立 → **静默放行**。判定用的根本不是那份被加载的文档。

正确做法是把 `YamlFiles` 已读到的 `raw` 字符串复用（或让 `load` 返回原文），而不是再开一次文件。当前实现把一个**本可以完全一致的判定**做成了两个独立 I/O 的竞态。

---

### 攻击点 2：`!usable()` 的范围，`ABSENT` 算不算 usable

`YamlFiles.java:46-52`：

```java
public record Loaded(YamlConfiguration config, Status status, String detail) {

    /** 是否可以安全使用这份配置（含「文件不存在 → 空的可写配置」这一合法情形）。 */
    public boolean usable() {
        return config != null;
    }
}
```

`YamlFiles.java:80-82`：

```java
if (!file.exists()) {
    return new Loaded(new YamlConfiguration(), Status.ABSENT, null);
}
```

**`ABSENT` 是 `usable()`（config 非 null）。** 所以 `:56-61` 的 `!usable()` 只覆盖 `PARSE_FAILED` / `SUSPECT` / `QUARANTINE_FAILED` 三种。

首次运行的正常路径**不会**抛：`:52-54` 先 `saveResource("shop.yml", false)` 把模板写出来，然后 `YamlFiles.load` 读到真文件 → `OK`。测试也覆盖了这一条（`ShopConfigLoaderTest.java:97-101`：`// 不写文件 —— 让 load() 自己 saveResource("shop.yml")`）。

**但存在一条会真抛的「文件不存在」路径，且报的是假错**：

`JavaPlugin#saveResource` **不抛异常**——它把 `IOException` 吞掉、只打一行 SEVERE（反编译可见 `Exception table: 128..225 → 228 Class java/io/IOException`，处理器体是 `logger.log(Level.SEVERE, ...)` 后 `return`）。于是数据目录只读 / 磁盘满 / JAR 内模板缺失时：

1. `saveResource` 失败，只留一行 SEVERE，`shop.yml` 仍不存在；
2. `YamlFiles.load` → `ABSENT` → `usable() == true` → 不抛；
3. `yaml.getConfigurationSection("shop.items") == null` 成立 → 进 `rawShopSection`；
4. `Files.readString` → `NoSuchFileException`（`IOException`）→ **抛 `IllegalStateException("...could not be inspected for a truncated 'shop.items' section: ...")`**。

结果：**「数据目录不可写」被报告成「shop.yml 被截断」**，并且顺着攻击点 3 直接把插件启停掉。这条路径连 `detail()` 都是 null（`ABSENT` 的 detail 为 null），管理员拿不到任何有效信息。

顺带：`ABSENT → usable` 这个语义本身在别处已经被坑过一次。`YamlFileGate.java:22-26` 专门为此写了一段注释：

> 「若照搬『usable 就可写』，那么损坏文件被隔离后，**下一次写盘前的重读**就会看到 ABSENT 并放行，用一个空配置覆盖磁盘 —— 降级被自己的隔离动作绕过。」

`ShopConfigLoader` 没有 gate，于是同一个坑以另一种形式重新出现，见「最严重的一条问题」。

---

### 攻击点 3：抛 `IllegalStateException` 的后果

调用点有两个，**一个在启动链、一个在命令链，都没有 catch**。

**启动链**：`HilltopVillagePlugin.java:119-120`

```java
this.shopManager = new ShopManager(this, languageManager);
this.shopManager.reload();
```

**未包裹**，且这是**有意**的，`HilltopVillagePlugin.java:103-104` 写得很清楚：

> 「其余核心模块（MapRestoreManager / ShopManager / MultiArenaManager 等）刻意不包裹：
> 核心模块初始化失败就应当让启动失败并禁用插件，而不是带着半初始化的状态继续跑。」

所以：**`shop.yml` 坏一个字节 → `onEnable()` 抛 → 整个插件被 Bukkit 禁用**。竞技场、对局、波次、节点、统计全部不启动。

**命令链**：`HilltopCommandHandler.java:577-581`

```java
if (args.length >= 2 && args[1].equalsIgnoreCase("reload")) {
    plugin.getShopManager().reload();
    int itemCount = plugin.getShopManager().getShopConfig().getItems().size();
    sender.sendMessage(lang.getFor(player, "shop-reloaded", String.valueOf(itemCount)));
    break;
}
```

**没有 try/catch**（整个 `handle()` 只在 `reloadconfig` 分支内包了 `RuntimeException`，见 `:448`）。异常逃逸到 Paper 的 `SimpleCommandMap.dispatch`，被包成 `ServerCommandException`（反编译可见 `new com/destroystokyo/paper/exception/ServerCommandException`）——管理员看到的是**内部错误堆栈**，不是「shop.yml 坏了，修好后重试」。且由于异常发生在 `reload()` 内、`this.config` 赋值之前，旧快照确实保住了（`ShopManager.java:55-56`），这一点是对的。

**这个交换对吗？不对，理由有三，且都是仓库自己写下的标准：**

1. **与本仓库对「YAML 不可用」的一贯处理相反。** 同样的 `!usable()` 分支，其他三份文件全部是「降级 + SEVERE」，不是抛：

   `ConfigManager.java:150-155`
   ```java
   YamlFiles.Loaded loaded = settingsGate.load();
   if (!loaded.usable()) {
       plugin.getLogger().severe("game-settings.yml is unusable; running with defaults and NOT writing it this run");
       settingsYaml = new YamlConfiguration();
       return;
   }
   ```
   同理 `ConfigManager.java:168-174`（monsters）、`:191-199`（display → `DisplayConfig.defaults()` 顶上）、`LanguageManager.java:93-96`（messages → 只发 JAR 默认值）。

   `ShopConfigCorruptFileTest` 的姊妹测试说得更直白——`StatsManagerTest.java:265`：
   ```java
   "损坏文件应以空统计启动，而不是让 onEnable 抛异常");
   ```

   也就是说：**「配置损坏不得打崩 onEnable」是本仓库已经成文的约定，这条修复的 shop 分支是唯一的例外**；而 shop 是这些文件里最不核心的一个（商店坏了，对局照样能打）。

2. **粒度失衡。** 一个商品的 `price` 写错只 warning 跳过，一个字节的截断却禁用整个插件。同一个文件里的错误严重度跨度是「一行日志」到「全服停摆」。

3. **失败信息不可执行。** 抛出的消息是 `"Cannot use shop.yml (PARSE_FAILED): ... Refusing to replace the live shop with an empty configuration."`——但启动失败时**不存在** "live shop"，「拒绝替换」描述的是一个没有发生的动作。

**更温和且更正确的方案是现成的**：`ShopManager.reload()` 的赋值顺序（先 `load()` 再赋值）已经保证「抛了就保留旧快照」。所以只需要在 `reload()` 里 catch 住：

```java
public void reload() {
    try {
        this.config = loader.load();
    } catch (IllegalStateException broken) {
        if (config == null) throw broken;          // 启动期：没有旧快照可用，但仍应只禁商店
        plugin.getLogger().severe("shop.yml unusable; keeping the previous shop snapshot (" + ... + ")");
        return;                                     // 重载期：保留旧配置 + 告警，命令提示失败
    }
    ...
}
```

启动期没有旧快照时，对外表现应当是「商店不可用 + 醒目 SEVERE + 不写盘」，而不是「插件禁用」。

---

### 攻击点 4：`items: {}` 的边界 —— 这条**没有**误杀

实证，`yaml.getConfigurationSection("shop.items")` 对空映射返回的**不是** `null`：

```
[raw] items-empty-map -> LinkedHashMap: {shop={gui={size=54}, items={}}}
[bk]  items-empty-map -> contains(shop.items)=true isSet=true getCS=OBJ keys=[] ... keys(shop)=[gui, items]
```

`items: {}` → 返回一个 keys 为空的 `MemorySection` → 守卫 `== null` 不成立 → 不读原始 YAML。`ShopConfigCorruptFileTest.java:146-154` 也钉住了这条（`An explicit empty mapping is a legitimate empty shop`）。**攻击点 4 不成立，这一处是对的。**

**但同一处有一个反向的误杀，测试没覆盖：`items: []`。**

```
[raw] items-list -> {shop={gui={size=54}, items=[]}}  | items instanceof Map = false
[bk]  items-list -> CS(shop.items)=null
```

旧代码：`getConfigurationSection` 为 null → 静默空店（可跑）。
新代码：`containsKey("items") && !(items instanceof Map)` → **抛 → 启动失败**。

「显式空列表」在语义上是「我就是要空商店」的一种写法（和 `items: {}` 等价），现在会让插件起不来。`items: 0`、`items: "none"` 同理。这不是「拦住截断」，这是把「类型写错的意图明确的空配置」升级成致命错误——严重度与意图倒挂。

---

### 攻击点 5：测试到底覆盖了什么

`ShopConfigCorruptFileTest` 四个用例（`:65-163`）：解析失败 / 重载保留旧快照 / `items:` 空值 / `items: {}` 与缺键合法。

**覆盖到的**：`items:` 后直接 EOF（`D`）；`categories` 之外的两条断言「旧快照存活」（`assertSame(previous, ...)`，这是实测有价值的部分）。

**没覆盖、且都是攻击面命中的**：

| 缺失用例 | 为什么必须要 | 实测结果 |
|---|---|---|
| **注释头截断**（只留前 5 行注释） | 这是 36/192 行边界、30.3% 字节偏移的形态 | 静默空店 |
| **`items:` 下一个商品段头截断**（`items:\n  bow:`） | 与被拦住的形态只差一行 | 静默空店（`items={bow=null}`） |
| **部分商店截断**（截在第 N 个商品中间） | 40.4% 字节偏移，最隐蔽 | 静默少商品 |
| **价格被截断**（`price: 15` → `price: 1`） | 静默改价，比空店更危险 | 实测多处命中 |
| **`shop:` 裸段头 / `shop: 5`** | `rawShopSection` 两处 `return null` 的出口 | 静默空店 |
| **`items: []`** | 误杀 | 抛 → 启动失败 |
| **首次运行 `saveResource` 失败** | `ABSENT` + 假错 | 抛「could not be inspected」 |
| **启动链**（真 `onEnable()` 带坏 `shop.yml`） | 断言「插件是否被禁用」这一后果 | 无覆盖（全部用 `BareHost`，其 `onEnable` 是空的） |
| **`/hilltop shop reload` 的玩家可见反馈** | 抛异常 → 内部错误 vs 可读提示 | 无覆盖 |

「首次运行无文件」这一条**有**覆盖（`ShopConfigLoaderTest.java:97-101` `factoryTemplateParsesCleanly`，不写文件让 `load()` 自己 `saveResource`）——但只覆盖了 `saveResource` 成功的那一支。

`rawShopSection` 是 `private`，没有任何单测直接打它的五个出口；四个用例全部经由 `load()` 间接命中两个。

---

## 最严重的一条问题

**这次的 `YamlFiles.load` 会先把坏文件隔离成 `shop.yml.corrupt`，而 `load()` 开头又会无条件重建出厂模板——两段凑出了「静默恢复成出厂店」的数据丢失路径。**

链条（每一环都已核对源码）：

1. `ShopConfigLoader.java:55` 走 `YamlFiles.load`，解析失败 → `YamlFiles.java:139-146` 的 `quarantine()` 把 `shop.yml` **改名**为 `shop.yml.corrupt`；
2. 返回 `Loaded(null, PARSE_FAILED, ...)` → `:56-61` 抛异常；
3. 管理员按提示重启（或再敲一次 `/hilltop shop reload`）；
4. `ShopConfigLoader.java:51-54`：
   ```java
   File file = new File(plugin.getDataFolder(), "shop.yml");
   if (!file.exists()) {
       plugin.saveResource("shop.yml", false);
   }
   ```
   **文件不存在 → 无条件写出出厂模板**；
5. 出厂模板合法 → `OK` → 加载成功 → 日志 `"Shop loaded 16 items"`，命令回显 `shop-reloaded: "&a商店配置已重载（16 件商品）。"`。

**结果：服主那份精心配过的商店，被静默替换成 16 件出厂商品。表面上一切正常——比「空商店」更难发现**：空商店至少一眼看出没货；现在货架是满的，只是卖的东西全变了（价格、槽位、装备线全是模板值）。唯一的线索是数据目录里一个 `shop.yml.corrupt` 和一行早已滚过去的 SEVERE。

这不是我推演的边角情形，而是**本仓库已经踩过、且已经写下防护的坑**。`ArenaManager.java:842-846`：

```java
private void ensureFile() {
    // 只读降级中**不得**从 JAR 模板重建：读盘不可用时文件已被隔离成 *.corrupt，
    // 若这里再 saveResource 一份出厂模板，下一次 gate.load() 就会读到「合法的新文件」
    // 并自动解封——降级被自己的重建动作绕过（正是 spec D1.5-③ 第 4 步要拦的路径）。
    if (arenasGate != null && arenasGate.isReadOnly()) return;
    if (!arenasFile.exists()) {
```

`ShopConfigLoader` 既没有 gate、也没有这道 `isReadOnly()` 守卫，于是把 `arenas.yml` 当初被明确修掉的那个缺陷，原样搬到了 `shop.yml` 上。**F1 修复的净效果是：把「无提示空店」换成了「有提示的空店 → 重启后变成无提示的出厂店」。**

（补充：`YamlFiles.load(file, null, logger)` 的 `validator` 传的是 `null`。仓库里其他每一份 YAML 都有语义哨兵——`arenasValidator` / `nodesValidator` / `gameSettingsValidator` / `monstersConfigValidator` / `displayValidator` / `messagesValidator`——唯独刚出过 F1 的 `shop.yml` 没有。这也解释了为什么 `E`/`G` 那 70% 形态一个都拦不住：结构层面的「截断却可解析」本该由哨兵拦，而这里哨兵是空的。）

---

## 如果重写会怎么做

按优先级：

**1）改变失败姿态：不抛到启动链，改为「保留旧快照 + 响亮告警 + 禁写」。**

- `ShopConfigLoader.load()` 返回一个结果对象（`ShopConfig` + `Status` + `detail`），**不抛**；或者在 `ShopManager.reload()` 里 catch，重载期保留旧快照、启动期进「商店不可用但插件照跑」的降级态。
- 启动期降级态的最小实现：`config = ShopConfig.empty(guiSize, ...)` + 一行 `SEVERE` 横幅（含修复指引与 `.corrupt` 路径）+ 不 spawn 商店 NPC（`HilltopVillagePlugin.java:158` 那一行已存在，加个 `if` 即可）。
- 依据是仓库自己的成文标准：`ConfigManager.java:150-155`、`LanguageManager.java:93-96`、`StatsManagerTest.java:265`。

**2）堵住「隔离 → 重建 → 出厂店」这条链。**

- 引入 `YamlFileGate`（`YamlFileGate.java` 现成的类），`load()` 前置 `if (shopGate.isReadOnly()) return <degraded>;`，把 `:52-54` 的 `saveResource` 包在 `!isBlocked` 条件里，照抄 `ArenaManager.java:842-846` 的注释与逻辑。
- 或者更简单：**隔离时改名但不重建** —— 只有在「从未存在过」时才 `saveResource`（用一个 `plugin.getResource` 检查 + 一次性标记），隔离后只报错不重建。

**3）判定改用语义哨兵 + 单一读盘，不要再读第二遍。**

把 `shop.yml` 的判据放进 `YamlFiles` 的 validator 体系（与其余六份对齐），一次 `Files.readString` 的结果同时喂给 Bukkit 解析和结构判定：

```java
public static Function<YamlConfiguration, String> shopValidator() {
    return yaml -> {
        if (yaml.getConfigurationSection("shop") == null) return "top-level 'shop' section is missing";
        // items 必须在；缺键对出厂/常见手写文件都是截断
        if (!yaml.contains("shop.items")) return "shop.items is missing (truncated before the item list?)";
        if (yaml.getConfigurationSection("shop.items") == null) return "shop.items is not a mapping";
        // 出厂模板 16 件；远小于它的非空商店要人工确认（阈值取可配置/低水位，如 <4）
        ...
    };
}
```

这三个判据把我实测的 `E`（缺键，36/192）、`F`（子键全 null，1/192）、`D`（非映射，2/192）全部收进来，且**不需要第二次读盘**，也就同时消灭了竞态和「两个解析器限额不一致」两个问题。

**4）保留「显式空」的合法出口，但只保留一种写法。**

`items: {}` 明确合法；`items:`（null）、`items: []`、`items: 0` 一律按「配置写错」报错——但要**报给管理员并在重载期保留旧配置**，而不是禁插件。`ShopConfigCorruptFileTest.java:146-163` 的两条断言可以原样保留。

**5）补齐测试（依据上面的攻击面）。**

参数化跑「出厂模板在每一个行边界被截断」，断言两件事：**(a) 不出现静默降级；(b) 失败时旧 `ShopConfig` 引用不变**。再补三条单测：`saveResource` 失败（数据目录只读）、隔离后再次 `load()` 不得重建出厂模板、`/hilltop shop reload` 在坏文件下给玩家可读提示。启动链那条用 `MockBukkitTestBase` 的全量 `load()`（`MockBukkitTestBase.java:124` 已有此夹具），断言插件**仍在启用状态**。

---

## 附：本次实证方法

`/tmp/yamlprobe/Probe*.java`（仓库外），`classpath` = `paper-api 1.21.4-R0.1-SNAPSHOT` + `snakeyaml 2.2` + `commons-lang3` + `guava` + `adventure-api/key`，JDK 21。逐字节 / 逐行截断 `src/main/resources/shop.yml`（5575 字节 / 193 行），对每个前缀复刻 `ShopConfigLoader.load()` 的判定链并分类。未修改仓库任何文件，未执行 git 操作。
