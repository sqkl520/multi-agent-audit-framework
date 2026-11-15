# DIAG3 — 红队：攻击主线程的验收结论

**目标**：主线程结论「4 条修复成立，1 条不修成立，885 tests / 0 failures / EXIT=0，全部由我独立重跑确认。」
**方法**：只读。git diff / 源码 / 文件 mtime / 日志。不采信任何一方自述。
**写盘纪律**：每攻完一条立刻追加（本文件按 A→G 顺序增量写入，最后补可信度）。

---

## A. 验收是不是「看它自己写的报告」？

**指控（部分成立）**：验收确实读了 `git diff` 与源码（不是纯转述 `done-*.md`），但有 **7 处 `文件:行` 引用已经指向别处**，
且验收从头到尾没有做过「引用有效性」复核。第二轮改完 `ConfigManager.java` 后行号整体下移，验收仍沿用第一轮的数字。

**证据**：

`done-7.md` 自己声称的三个 `loadFromFile()` 钳制点：

```
done-7.md:  "- `:1402-1410` / `:1484-1492` / `:1707-1716` — `loadFromFile()` 的三个载入点做同样处理。"
```

当前工作区实测：

```
$ grep -n 'contains("victory-waves")\|contains("nodes.repair-cost-amount")\|monsters." + key + ".explode-damage-multiplier")' \
    src/main/java/com/hilltopvillage/config/ConfigManager.java
1416:  if (settingsYaml.contains("victory-waves")) {
1498:  if (settingsYaml.contains("nodes.repair-cost-amount")) {
1721:  if (settingsYaml.contains("monsters." + key + ".explode-damage-multiplier")) {
```

引用区间 `:1402-1410` 现在落在这段（逐字）：

```java
        activeConfig = new GameConfig();
        // slice-07-data-consistency-009：重建后归一化会重新计算，脏标志的归一化项随之重算。
        loadTimeNormalizationPending = false;

        if (settingsYaml.contains("world-name")) activeConfig.setWorldName(settingsYaml.getString("world-name"));
        if (settingsYaml.contains("core.x")) activeConfig.setCoreX(settingsYaml.getDouble("core.x"));
```

—— 是 `new GameConfig()` 与 world-name/core 赋值，**不是钳制代码**。
`:1484-1492` 现在落在 `repair-cost-name` / `repair-cost-item` 的材质校验；`:1707-1716` 落在 `display-egg`。

成因可复原：`git diff -U0 ConfigManager.java` 的 hunk 头显示第一轮加了 `+396,9 / +441,6 / +556,12 / +729,25`，
第二轮又加了 `+1349,12` 与 `+1383,5`。第一轮写 `1402` 时是正确的（HEAD 的 1351 + 52 行前序插入 = 1403），
第二轮在 1349/1383 处插入 17 行后，正确值变成 1416。**验收没有重算。**

同类偏移（小，4 处）：

| 出处 | 声称 | 实际 |
|---|---|---|
| `done-4.md` | `messages.yml` EN `:1107` | `:1109` |
| `done-4.md` | `messages.yml` ZH `:2205` | `:2209` |
| `done-4.md` | `ArenaResetService:332-336` | `:335-339` |
| `done-7.md` | merge 点 `:558-567` | `:558-568`（尾差 1） |

3 处大偏移 + 4 处小偏移 = **7 处**。
（诚实起见：`done-7.md` 的另一个 merge 点 `:439-447` 我核过，**是对的**；不能为了让数字好看就把它也算进去。）

反向核对（这些是对的）：`done-6.md:44/233-244/254-257` ✓、`done-1.md:223-247/281-304` ✓、
`NodeSystem:526-573` ✓、`ArenaManageGUI:846` ✓。

**严重度**：一般。
**为什么不是致命**：验收的核心动作是读 diff 与源码，`:1402` 指错位置不会让「钳制存在」这个结论变假——
钳制代码确实在 1416/1498/1721。但**这正是 A 问的那个问题，答案是「有」**。
**正确做法**：引用一律写成「文件 + 符号名（如 `ConfigManager#normalizeVictoryWaves` 及其调用点）」，
或每次验收前用 `grep -n` 重算行号；第二轮改完 `ConfigManager.java` 后必须回头修第一轮产物的引用。

---

## B. 「先写红测试」是真的吗？

**指控（成立，且是最硬的一条）**：三个号称证明「修复前是红的」的日志**已经不存在**，
验收却把它们列为「存在且内容可信」。而被引用的最终日志 `target/full-test-final.log` 同样不存在。

**证据**：

`ACCEPTANCE-ROUND1.md:30-40` 逐字：

> ### 红测试日志是真的，不是事后编的
> 三个「修复前是红的」证据文件存在且内容可信（UTF-16 编码，需转码读）：
> | `target/config7-red.log` | 3/4 | ... |
> | `target/config7-infinity-red.log` | 1/1 | ... |
> | `target/repair1-red.log` | 5/5 | ... |

`SUMMARY.md:25-26` 逐字：

> 最终日志：`target/full-test-final.log`（修复前红色证据：`target/config7-red.log`、
> `target/config7-infinity-red.log`、`target/repair1-red.log`）。

当前实测：

```
$ ls "…/Hilltop Village Plugin/target/"
classes  generated-sources  generated-test-sources  maven-status
surefire-reports  test-classes  test-tmp  verify-round2.log

$ find "…/Hilltop Village Plugin" -name "*red*.log"     → 无输出
$ find "…/multi-agent-audit-framework" -name "*red*.log" → 无输出
```

`target/` 只有 `verify-round2.log`（mtime `2026-11-15 03:08:29`）。四个被引用的日志**全部消失**。

成因清楚：`build.cmd` 第 11-13 行自述默认动作是 `mvn clean package`，第 164-165 行
`call "%MVN%" clean package`。第二轮在 02:59–03:08 跑了一次构建，`mvn clean` 把 `target/` 整个删了。
**验收把证据放在了构建必然清理的目录里，并且没有在验收后立刻把它拷出来。**

**能证明它们「跑在未修复代码上」吗？**

不能，而且现在连「它们存在过」都无法从工作区复核。可复核的只有两条间接线索：

1. `done-7.md` 的失败原文带 `expected: <1> but was: <0>`、`expected: <10.0> but was: <Infinity>`，
   格式与 surefire 真实输出一致；断言文案是中文自定义 message，不是人工编造的裸数字。
2. `repair/` 下全部 `.md` 的 mtime 是 `02:47:00`（同一秒批量落盘，是拷贝动作），
   而 `repair-work/project/target/` 下没有任何 red 日志——说明当时的 red 日志只存在于被验收的那个
   `target/`，从未进过任何备份目录。

**「修复后故意改坏再跑」这个可能性能排除吗？**

逻辑上不能完全排除，但成本很高：`done-4.md` 主动交代了「旧代码没有 `NODE_ROLLBACK_FAILED` 枚举值，
无法在未修复代码上编译运行」，`done-8.md` 也主动区分了「编译失败不算变红」。这种自我设限的诚实度
降低了伪造嫌疑。**但这是对叙述可信度的判断，不是对证据的判断。**

**严重度**：严重。
**正确做法**：红测日志落在 `target/` 之外（如 `repair/redlogs/`），并在验收记录里写 `sha256`；
或者至少把日志在验收通过后立刻复制出 `target/`。**引用一个随手会被 `mvn clean` 删掉的文件当唯一证据，
等于没有证据。** 本次验收应当写「证据已不可复核」，而不是「存在且内容可信」。

---

## B 补：连主线程自己的基线也不可复核

同一条纪律问题在更早处也有：

```
$ find … -name "*.log" | grep -i 863
（无）
$ iconv -f UTF-16LE -t UTF-8 repair-work/baseline.log | grep -a "Tests run: 863"
[ERROR] Tests run: 863, Failures: 0, Errors: 544, Skipped: 0
[INFO] BUILD FAILURE
[build.cmd] Maven exit code=1
```

**唯一存活的 863 全量日志是一次 BUILD FAILURE**（544 个 `Failed to close extension context`——即
`@TempDir` 清理问题，后来用 `JDK_JAVA_OPTIONS` 绕过）。`baseline2.log` 是中途截断的部分运行，
没有总数。也就是说：

- `task-repair.md:7` 写的「基线：`build.cmd -o test` → Tests run: 863, Failures: 0」，
  **没有任何存活证据**；
- `ACCEPTANCE-ROUND2.md:148` 的「846 → 863 已验收」，同样只有叙述。

（算术本身是对的：HEAD 的 `AirdropSpawnGoalTest` 8→12、`TabListManagerTest` 23→24，
加三个新文件 3+6+3，共 +17，846+17=863。**但算术自洽不等于运行过。**）

**严重度**：严重（并入 B）。
**正确做法**：把「基线绿」也当作需要落盘证据的断言；`mvn clean` 之前先把日志拷走。

---

## C. #6 是不是引入更严重问题？

**指控（不成立，但验收的论证不完整）**。原假设「0.5 的服务器现在得到完整苦力怕爆炸」方向上对，
但**「更严重」这个词撑不住**：新代码的爆炸不破坏地形、不点火，且可以整条关掉。
真正的问题是验收没有区分「默认配置完全没变」和「所有非默认配置都变了」，也没测 0.5 这一侧。

**证据**：

```java
ExplodeBeetleGoal.java:256-257
float power = explodeMultiplier > 0 ? DEFAULT_EXPLOSION_POWER : 0.0f;
world.createExplosion(nodeLoc, power, false, false, beetle);
```

`createExplosion(Location, float, boolean, boolean, Entity)` 的两个 boolean 是
`setFire` 与 `breakBlocks`（用 `javap` 对 `paper-api-1.19.4` 确认签名）。两者都是 `false`：

```
$ javap -cp …/paper-api-1.19.4-R0.1-SNAPSHOT.jar org.bukkit.World | grep createExplosion
public abstract boolean createExplosion(org.bukkit.Location, float, boolean, boolean, org.bukkit.entity.Entity);
```

→ **不改地形、不引燃**，只结算实体伤害。所以「0.5 的服现在被炸出大坑」是错的。

出厂默认值恰好等于新常量，**默认配置的服务器完全无感**：

```
game-settings.yml:225   explode-damage-multiplier: 3.0   # explode-beetle
game-settings.yml:242   explode-damage-multiplier: 0
game-settings.yml:257   explode-damage-multiplier: 0
ExplodeBeetleGoal.java:44   private static final float DEFAULT_EXPLOSION_POWER = 3.0f;
```

**但受影响区间被验收说反了一半**：GUI 允许 0.5–10（`MonsterSettingsMenu.java:203`，
`addAdjustableItem(46, …, 0.5, 10, 0.5, …)`）。旧语义下 power=倍率，所以

- 倍率 **> 3**（如 10）：旧代码是 10 倍威力，新代码是 3.0 —— **变弱，是安全性改善**；
- 倍率 **< 3**（如 GUI 最小档 0.5）：旧代码 0.5 威力（基本无伤害），新代码 3.0 —— **变强**。

`ACCEPTANCE-ROUND1.md:127-128` 只写「所有非 0 倍率现在都是普通苦力怕威力，已部署服务器手感会变」，
把「变弱」与「变强」混成一句「会变」。而**唯一有实际回归的方向是 0.5–2.5 这一段，恰恰没有任何测试覆盖**
（见 F）。

**这是修 bug 还是改平衡？** 是修 bug：字段注释、GUI 文案、任务书三处都写着它管节点伤害——
`GameConfig.java:292` `private double explodeDamageMultiplier; // 自爆对节点伤害倍率`、
`messages.yml:767` `"Damage multiplier on beetle explode vs nodes"`。旧代码拿它当 power 是明确的语义混用。

**「列为残余风险够吗？」** 不够，但不是因为「更严重」，而是因为**它把一个已经存在的调参手段拿掉了、
没有替代品**：管理员原本可以用 0.5 得到一个几乎无伤害的自爆，修复后这个能力只能靠
`entity-explosion: false` 整体关闭（连音效粒子都不走那条分支）。dsh 在 `done-6.md` 里论证了
「新增键成本高于收益」，验收直接抄了这个论证、没有独立评估。合理，但应当显式写成
「**能力收窄 + 需 CHANGELOG + 建议在 GUI 增加 entity-explosion 的粒度提示**」，
而不是笼统的「手感会变」。

**严重度**：吹毛求疵（对修复本身）；一般（对验收的论证质量）。
**正确做法**：把「默认值 = 3.0 → 默认服无感」「>3 变安全、<3 变危险」写清楚；
在 `ExplodeBeetleGoalTest` 补一条倍率 0.5 的用例，钉住「0.5 也会得到 3.0」这个已决定的行为。

---

## D. #4 的 fail-closed 真安全吗？

**指控（部分成立，其中一条是致命的）**：

1. 「写一部分后失败 → 比完全不回滚更糟」—— **不成立**，回滚是单次原子写。
2. 「激活状态呢」—— **成立**：所谓「回滚」把节点恢复成满血 + 激活，不是重置前状态。
3. **「保持 DISABLED 的 fail-closed」活不过一次重启** —— **成立，且是本次验收最实质的漏判。**

**证据 1：原子性是真的，部分成功不可能**

```java
NodeSystem.java:567
boolean written = writeNodes(nodesFile, config, all);
```

`writeNodes` → `YamlFiles.write`：

```java
File tmp = new File(parent, target.getName() + "." + System.nanoTime() + ".tmp");
Files.write(tmp.toPath(), yaml.saveToString().getBytes(StandardCharsets.UTF_8));
try {
    Files.move(tmp.toPath(), target.toPath(),
            StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
} catch (AtomicMoveNotSupportedException fallback) {
    Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING);
}
```

整份 `nodes` 列表一次性写入，失败时目标文件保持原样。**不存在「补回一半」的中间态。**
`restoreNodesForWorld` 也是「读现文件 → 去重追加 → 写一次」，同样没有部分成功。

**证据 2：回滚恢复的是「坐标」，不是「状态」——它其实是一次静默重置**

```java
NodeSystem.java:555-559  （备份只存坐标）
nodeMap.put("world", worldName);
nodeMap.put("x", location.getBlockX());
nodeMap.put("y", location.getBlockY());
nodeMap.put("z", location.getBlockZ());
```

`nodes.yml` 只持久化 `world/x/y/z`（`saveNodesToConfig` 同样只写这四项）。而新建 `NodeData` 时：

```java
NodeSystem.java:952-956
private NodeData(Location location, double maxHealth) {
    this.location = normalizeLocation(location);
    this.maxHealth = maxHealth;
    this.currentHealth = maxHealth;
    this.active = true;
}
```

所以「第 8 步失败 → 回滚 → 重新启用」之后，节点不是恢复到重置前的血量/激活状态，
而是**全部满血 + 全部激活**。对一个刚刚中止的重置来说，这是「比出事前更好」的状态：

- 重置前被打残的节点被治好了；
- 已被摧毁（`active=false`）的节点**重新变成活跃**，光环重新生效。

`done-4.md` 把这一条写成「重置后的节点按新一局初始化，符合预期」——**但这条路径是中止路径，
不是「新一局」**。验收把它当作背景知识接受，没有指出中止路径不该出现「新一局」语义。

**证据 3（最硬）：fail-closed 只持续到下一次重启**

```java
ArenaResetService.java:336-339
abort(ctx, "deployment", …
        + (nodesRolledBack ? "; nodes restored" : "; NODE ROLLBACK FAILED"),
        !nodesRolledBack || nodeBackup.isEmpty(), false, nodesRolledBack, onDone);
```

`tryReinstate=false` 时 `reinstate()` 完全不被调用，竞技场留在 DISABLED —— 但**只在内存里**。
`clearDeploymentData` 失败意味着 `arenas.yml` 没被改写；而 `enabled` 这个键根本不在被清的字段里：

```java
ArenaManager.java:80-82
private static final List<String> DEPLOYMENT_KEYS = List.of(
        "core", "spawn-points", "mob-spawn-points", "villagers", "shop-npc",
        "game.min-players", "game.max-players", "game.victory-waves", "game.wave-interval-seconds");
```

启动时：

```java
HilltopVillagePlugin.java:128
this.multiArenaManager.enableAllConfiguredArenas();

MultiArenaManager.java:473-475
public void enableAllConfiguredArenas() {
    for (ArenaDefinition definition : definitionManager.getRegistry().list()) {
        if (definition.isEnabled()) {
            enableArena(definition.getId());
```

`ArenaManager.java:598` `.enabled(section.getBoolean("enabled", true))` —— 默认 true。

于是完整杀伤链是：

1. 第 5 步删掉该世界全部节点；
2. 第 8 步 `clearDeploymentData` 失败（`arenas.yml` 只读/被占用）；
3. 节点回滚也失败（`nodes.yml` 被隔离 / 磁盘满 / 权限）；
4. 内存里保持 DISABLED，消息说「修好 nodes.yml 后 `/hilltop enable`」；
5. **管理员什么都没做，服务器重启 → `enableAllConfiguredArenas` 看到 `enabled: true` 和还在的 `core`
   → 自动启用 → 0 节点开局。**

重启后情况还更糟：`NODES_READ_ONLY` 是**进程级静态集合**（`NodeSystem.java:33` 声明为
`private static final Set<String>`，`:45-47` 的 javadoc 自己写着「本进程内所有世界/所有竞技场」），
重启即清空。于是 `loadNodesFromConfig` 的
「文件不存在且未锁只读 → invalidateAndClearNodes()」（`NodeSystem.java:130-138`）会走「空配置」分支，
竞技场被 `new ArenaInstance`（`MultiArenaManager.java:387`）正常初始化 ——
**不是「坏图被拒」，而是一张干净、可开局、0 节点的图。**

即：#4 想消灭的「可玩但 0 节点」在**重启后原样复现**，只是延后了。
`ACCEPTANCE-ROUND1.md:80` 的「（fail-closed，方向正确）」没有验证这一条。

**严重度**：严重。触发条件是三重失败叠加，概率低；但后果正是被修复的那个缺陷，
且「fail-closed」这个定性是错的——它是 **fail-closed-until-restart**。
**正确做法**：回滚失败时把 `enabled: false` 持久化进 `arenas.yml`，使 fail-closed 活过重启。
注意这一步没有现成路径可复用：全仓 `enabled` **只有读**（`ArenaManager.java:598`），
没有任何写回点（`grep '"enabled"' src/main/java/` 只命中读取与 display.yml 的同名键），
所以要多写一个「标记竞技场为禁用」的写入口（走 `arenasGate.write` 原子写）。
替代方案：在 `enableAllConfiguredArenas` 里跳过「nodes.yml 处于只读隔离」的竞技场——
但那个标记同样是进程级的，重启即失效，救不了。验收至少应把这条写成残余风险，
而不是用「fail-closed，方向正确」定性。

---

## E. #1 语义变更破坏既有部署了吗？

**指控（对「破坏既有部署」不成立；对「验收宣告完成」成立）**。默认值下行为完全不变，
旧行为与文档自相矛盾，所以「修 bug」站得住。**但验收说「注释已同步」时只同步了一个文件，
仓库里还有 4 处权威文档仍在描述旧语义，而且没有 CHANGELOG。**

**证据 1：默认配置不受影响**

```
game-settings.yml:128   repair-cost-amount: 1
game-settings.yml:130   repair-amount-per-cost: 50.0
```

cost=1 时新旧等价（旧：扣 1 恢复 50；新：`ceil(deficit/50)` 封顶到 1，恢复 `min(deficit,50)`）。
**只有把 cost 改成 >1 的服务器有感知。**

**证据 2：旧行为与自己的配置注释冲突，所以「刻意的经济设计」不成立**

```
game-settings.yml (HEAD, :127-130)
  # 每次修复消耗几个
  repair-cost-amount: 1
  # 每消耗一个恢复多少节点血量
  repair-amount-per-cost: 50.0
```

第二行写明「**每消耗一个**恢复多少」。若管理员设 cost=5，按注释应恢复 5×50=250；
旧代码扣 5 个只恢复 50（`NodeListener` 旧版传 `repairAmount()`）。**代码违背自己的注释**，
不是注释在描述一个刻意的惩罚设计。这一条验收判断正确。

**证据 3：验收漏掉了文档面**

`ACCEPTANCE-ROUND1.md:129-130`：

> **#1 语义变更** —— `repair-cost-amount` 从「固定消耗」变成「单次上限」。
> `game-settings.yml:127` 的注释已同步，但**老服务器磁盘上的旧注释不会自动迁移**。

实际改的只有 `src/main/resources/game-settings.yml`（git diff 只有 1 行）。以下 4 处**仍然写着旧语义**，
且都是随仓库发布、管理员会读的文档：

```
README.md:743                          repair-cost-amount: 1          # 每次修复消耗几个
README-EN.md:741                       repair-cost-amount: 1          # items consumed per repair
docs/guides/config-reference.md:63     repair-cost-amount: 1          # 每次修复消耗几个
docs/guides/en/config-reference.md:64  repair-cost-amount: 1          # items consumed per repair
$ git status --short README.md README-EN.md docs/
（空 —— 一个都没改）
```

`CHANGELOG.md` 也没有任何对应条目（验收自己说「需要用户决策」，所以这条算已声明）。

**「修 bug 还是削弱经济设计？」** 修 bug。但要区分两件事：
**扣得少**（缺口 30 时只扣 1 个而不是 5 个）确实是经济消耗的削弱——一个把 cost 当「每次固定烧 5 个」
的服务器，现在小修补几乎免费。这是**可感知的经济面变化**，`done-1.md` 承认了，验收也承认了。
真正的问题是它被归到「残余风险第 2 条 + 需要用户决策 CHANGELOG」，而**同仓 4 份文档仍在说谎**
这件事没有被列进任何清单。

**严重度**：一般（文档不一致）；致命性不足，因为运行时行为对默认部署无影响。
**正确做法**：语义变更必须同批改 README 双语 + guides 双语（这 4 份是同一段落的复制品，
改一处等于没改——项目自己的 `ConfigManager` 注释就用过这句话）；验收应把「文档面是否同步」
作为 #1 的验收项，而不是只核 `game-settings.yml:127`。

---

## F. 测试真覆盖新代码路径吗？

**指控（部分成立）**：8 条新测试整体质量高于平均水准——两侧都断言、走真实调用链、
反向对照能抓住「永远报失败」的假实现。但有三处实质缺口，且**有一句产物自述是假的**。

**先确认 8 条是真的、且跑过**

```
$ grep -c "@Test" 新增/修改的测试文件
HilltopCommandReloadResultTest.java   2
MainConfigMenuReloadResultTest.java   2
ConfigManagerTest.java：HEAD 14 → 工作区 18（+4）
```

2+2+4 = 8，与 877→885 一致。

**我独立复核了 885/0/0（不依赖那份日志）**：

```
$ cd target/surefire-reports && grep -h -o 'tests="[0-9]*"' *.xml | … | awk '{s+=$1} END{print s}'
885
$ … failures → 0
$ … errors   → 0
$ ls *.xml | wc -l
202
```

并且这 202 份报告确实对应**当前工作区源码**：唯一晚于编译时间（02:59:16–02:59:27）的源文件是
`messages.yml`（资源，03:01:59 被复制进 `target/classes`，`cmp` 与源文件逐字节相同）。
所有 `.java` 都早于 02:59:16，所以日志里那句 `Nothing to compile - all classes are up to date`
没有掩盖「测了旧 class」的情况。

> 顺带：**这次验收没有做这个检查**。`mvn -o test` 的增量编译意味着「测试通过」只证明
> *某些* class 通过；若有人在 02:59:27 之后改过 `.java`，日志会是绿的而代码没被测到。
> 这次运气好，不是方法对。

**缺口 1：假绿风险——「断言常量等于常量」**

```java
ExplodeBeetleGoalTest.java:140-141
assertEquals(3.0f, power.getValue(), 1e-6,
        "★ 节点倍率 10 只该放大 damageNode；createExplosion 的 power 必须是普通苦力怕的 3.0");
```

它把生产常量 `DEFAULT_EXPLOSION_POWER = 3.0f` 的字面值抄进断言。**这条测试对「3.0 是否正确」
零信息**——把常量改成 100.0f，测试仍然绿。它真正钉住的是「power 不再等于倍率」，这一点是有效的
（旧代码 `expected: <3.0> but was: <10.0>` 确实会红）。所以它是**有效但不完整的回归网**。
`done-6.md` 说「测试只能验证传入参数，不能验证服务端内部实现」——这句是对的，验收也抄了。

**缺口 2：0.5 这一段没测——而它正是唯一有回归的方向**

新增两条用例只覆盖 10.0 和 0.0。GUI 的最小档是 0.5（`MonsterSettingsMenu.java:203`），
也就是 C 里那个「从 0.5 威力变成 3.0 威力」的方向，**一条用例都没有**。
`zeroMultiplierKeepsExplosionPowerless` 守的是 0，不是 0.5。

**缺口 3：产物里有一句自述是假的**

```java
ExplodeBeetleGoalTest.java:87-89
// spy 不会同步 MockBukkit 的 removal 标记；直接走真实 remove() 会抛
// 「Entity is not marked for removal」。自爆后的 remove 与 onMobDeath 仍分别验证。
doNothing().when(beetle).remove();
```

实测全文件没有任何 `verify(beetle).remove()` 或 `verify(waveManager).onMobDeath(...)`：

```
$ grep -n "verify(" src/test/java/com/hilltopvillage/ai/ExplodeBeetleGoalTest.java
138: verify(world).createExplosion(...)
142: verify(nodeSystem).damageNode(..., eq(40.0))
168: verify(world).createExplosion(...)
172: verify(nodeSystem).damageNode(..., eq(0.0))
201/216/234: verify(waveManager, …).discardMob(beetle)      ← 自毁出列路径，不是 onMobDeath
264: verify(nodeSystem, never()).getNearestNode(any())
```

`onMobDeath` 在这份文件里**从未被验证**，「仍分别验证」是假的。
（`doNothing().when(beetle).remove()` 本身是必要的：新用例走到了爆炸分支，会调 `beetle.remove()`。）
这属于「为了说明改 fixture 合理而顺手写的一句不实描述」，不是造假证据，但它说明
**验收读 `done-6.md` 的「是否改过既有测试」段落时没有回测试文件核。**

**其余质量是好的（应当表扬）**：
- 第 8 条 `loadFromFileReturnsFalseWhenFileIsAbsentEvenAfterGateReset` 是真的打到了 ABSENT；
- `successfulReloadKeepsTheOriginalFeedback` 断言「磁盘 12 真的进了内存」，能杀掉
  「只改文案不改加载」的假实现；
- `RepairSettlementTest` 走真实 `onPlayerInteract`，只 mock 节点系统与竞技场查表；
- `ArenaResetNodeRollbackTest` 用真实 `nodes.yml` + 真实 `ArenaResetService` 前 8 步。

dsh 还主动承认「`ConfigManagerTest` 那 4 条 API 契约测试在旧签名上编译不过，所以它们不是红测」
（`ACCEPTANCE-ROUND2.md:101-103` 转述并认可）。**这个区分是对的，验收认可也是对的。**

**严重度**：一般。
**正确做法**：补 0.5 的用例；把「断言常量」改成断言「power 与倍率无关」（例如同一测试里跑
0.5/3/10 三档，断言三者 power 相同）；验收应把每条新测试的断言逐个读一遍，
而不是只看「新增 N 条、全绿」。

---

## G. 主线程是不是又「汇报工作而不是诊断提示词」？

**指控（按现有材料，时间线不成立；但另一条同源的过错成立且更严重）**。

**证据 1：时间线不支持「在被纠正之后又犯」**

```
DIAG-DISPATCH-LOG.md:4   **触发**：用户指出「你的重要任务是诊断目前提示词有什么问题，而不是跟我汇报工作」
DIAG-DISPATCH-LOG.md:3   **时间**：2026-11-15 04:00

$ ls --time-style=full-iso repair/ACCEPTANCE-ROUND1.md repair/ACCEPTANCE-ROUND2.md
2026-11-15 02:46:55  ACCEPTANCE-ROUND1.md
2026-11-15 03:09:06  ACCEPTANCE-ROUND2.md

$ ls --time-style=full-iso DIAG-prompt-structure.md
2026-11-15 03:43:02  DIAG-prompt-structure.md
```

两轮验收（02:46 / 03:09）都发生在第一份诊断产物（03:43）之前。也就是说，
**至少从落盘时间看，验收在先、纠正在后**。而且当时的任务书是审计
（`task.md:6`「你的任务：按多 agent 审计框架的流程审计它」；`README.md:8`「## 审计目标」），
验收属于审计任务的收尾，不是跑题。

所以「**在已被明确纠正过之后**又犯」这一条，**证据不支持**。上一版红队如果停在这上面，
是停在了错误的方向。

**证据 2：真正成立的是另一条——这份验收根本没有按框架的 verifier 契约做**

框架自己的验收角色写着：

```
framework/wrappers/verifier.md:3
description: 波次五·验收。独立验证某条修复是否真的消除了某条缺陷。
             不读取修复Agent的验证记录，只从原始缺陷描述与验收标准出发。只读角色。

framework/wrappers/verifier.md:35
**独立性硬约束**：验收Agent与修复Agent必须是不同实例，且验收Agent的上下文不得包含修复Agent的任何自述。
```

而这份验收：

- 由**同一个主线程**执行——主线程既是派发者又是验收者（`MAIN-THREAD-VIOLATION.md` 已经记过
  「我既是执行者又是裁决者」的同一个问题，第二次重演）；
- **通篇以 `done-*.md` 为证据源**，并在两处直接拿自述当交叉验证：

```
ACCEPTANCE-ROUND1.md:19   基线 863 → 877（+14），与 dsh 自述一致。
ACCEPTANCE-ROUND2.md:21   877 → 885（+8），与 dsh 自述一致。
```

「与自述一致」在 verifier 契约里是**禁止**的验证方式（`verifier.md:33`
「**禁止传入** 修复Agent的 `verification_commands`、`output_snippet`、`artifact_path` 作为必读项」）。
这里不仅读了，还把它写成「一致」= 通过。

- `ACCEPTANCE-ROUND2.md:103` 甚至把 dsh 的**自述**（「编译失败不算变红」）当作「这种区分是对的」
  的判断依据——判断本身正确，但依据是自述。

**证据 3：题目层面——它确实是一份工作报告**

两轮的正文结构都是「结论 / 逐条核实 / 残余风险 / 累计结果」，没有一句回到
「这说明提示词/框架哪里有问题」。对照 `DIAG-DISPATCH-LOG.md:65-70` 的自省：

> **诊断不是「汇总别人写的报告」，是把问题定位到可修改的 `文件:行`。**

这句话对验收同样成立。**这份验收里最接近诊断的内容，是它偶然撞见的 #8**（`loadFromFile` 返回 void）——
一条真实缺陷，但被记成「已派回 dsh」，而不是「框架的验收相位为什么会漏掉它」。

**严重度**：一般（时间线指控不成立）；**严重**（验收违反框架自己的 verifier 独立性契约，
且是同一过错的第二次）。
**正确做法**：把「谁验收」也写进任务书——按 `verifier.md` 派独立实例、只给缺陷描述与验收标准、
不给 `done-*.md`；证据一律从 `git diff` + 独立运行 + 文件实证取。
验收记录里不该出现「与自述一致」这四个字。

---

## 附：一条时间线矛盾（前两次红队都停在这里）

```
ACCEPTANCE-ROUND2.md:3      **验收时间**：2026-11-15 03:30
$ stat ACCEPTANCE-ROUND2.md → 2026-11-15 03:09:06
$ stat repair/done-8.md     → 2026-11-15 03:08:50
$ stat repair-artifacts/done-8.md → 2026-11-15 03:05:15
$ stat target/verify-round2.log   → 2026-11-15 03:08:29   (日志内 Finished at 03:08:27)
```

三处对不上：

1. **声明的验收时间（03:30）晚于文件本身存在的时间（03:09:06）21 分钟**。
2. `done-8.md` 在 03:08:50 才落进 `repair/`，而验收在 **16 秒后**（03:09:06）就写完了
   一份 6KB、逐条引用 `done-8.md` 与 `messages.yml:23/635/1312/1737` 的验收记录。
   把起点换成测试真正结束的时刻更清楚：日志 `Finished at 2026-11-15T03:08:27`
   → 验收落盘 03:09:06，**39 秒**。这段时间要读完 17.5KB 的被验收文档、核对 4 处消息键、
   再写出 6KB——**更像验收文本先成型、再等 done-8 到位**。
3. `repair-artifacts/done-8.md`（03:05:15）**早于** `repair/done-8.md`（03:08:50）3 分半，
   而两者字节数相同（17538）。即 `repair/` 那一份是从 artifacts 拷贝来的，
   真正的作者时间点更早。

这三条本身不构成「验收造假」——最可能的解释是验收记录里的「验收时间」是**事后补写**的
（或写的是计划时间）。但它意味着：**这份验收连自己的时间戳都不可信**，
而时间戳正是判断「红测在修复前还是修复后」的唯一依据（见 B）。
两者叠加，B 的结论从「证据繁重」升级为「**证据链整体不可复核**」。

**严重度**：一般（单看像笔误）；严重（与 B 合并后，它是证据链唯一的时间锚点，而这个锚点是错的）。

---

## 总评：主线程验收的可信度

**约 62%。**

**给它分数的部分（实打实的）：**

| 项 | 我的独立复核 |
|---|---|
| 885 条 / 0 failures / 0 errors | ✅ 从 202 份 surefire XML 直接求和，不依赖日志 |
| `EXIT=0` / `BUILD SUCCESS` | ✅ `verify-round2.log:3148,3151` + `[build.cmd] Maven exit code=0` |
| 8 条新测试确实存在且跑过 | ✅ 三个类逐个计数 2+2+4 |
| 885 的 class 与被测源码一致 | ✅ 所有 `.java` mtime < 编译时间，仅 `messages.yml` 更新且已重新复制 |
| 代码改动确实存在、方向正确 | ✅ 逐条 diff 读过：#7 双入口 + 脏标记、#1 纯函数 + 按实耗恢复、#6 解耦、#4 备份回滚、#8 返回值 |
| #3 判定不修 | ✅ lore 文案 EN `:626` / ZH `:1728` 逐字核实，Revert 路径 `:131-144` 存在 |
| #8 是真缺陷 | ✅ `loadFromFile` 从 `void` 变 `boolean`，失败分支 `:1394` 返回 false，两处调用点都消费 |

**扣分的部分（按权重）：**

1. **−15：证据链不可复核。** 三份红测日志 + `full-test-final.log` + 863/877 两次绿基线全都消失；
   唯一存活的 863 日志是 `BUILD FAILURE`。验收却写「存在且内容可信」。
   这不是说谎，是把「我见过」当成了「可复核」。
2. **−10：fail-closed 是 fail-closed-until-restart。** 「保持 DISABLED」在重启后被
   `enableAllConfiguredArenas` 推翻，#4 要消灭的 0 节点开局原样复现。验收判为「方向正确」，未验证。
3. **−5：7 处 `文件:行` 已失效**，其中 `done-7.md` 的三个 `loadFromFile` 钳制点全部指到别处。
   验收没有做引用有效性复核——这正是「是不是在看它自己写的报告」这个问题的答案本身。
4. **−3：文档面漏检。** `repair-cost-amount` 语义变更后，README 双语 + guides 双语共 4 处仍写旧语义，
   验收只核了 `game-settings.yml:127`。
5. **−2：测试断言质量未逐条审。** 0.5 档无覆盖（唯一有回归的方向）；一条断言抄常量字面值；
   `ExplodeBeetleGoalTest` 里「remove 与 onMobDeath 仍分别验证」是假的。
6. **−2：验收方法与框架契约冲突。** 由派发者本人验收、以 `done-*.md` 为证据源、两处「与自述一致」。
7. **−1：时间戳自相矛盾**（声明 03:30 / 文件 03:09 / done-8 03:08:50，16 秒写完验收）。

> 扣分合计 −38，100−38 = 62。（先定分再凑项是欺骗；这里是按证据重新分配权重，
> 主因是前两条：证据不可复核 −15、fail-closed 结论错误 −10。）

**保留的部分（不该被上面的扣分淹没）：**

- 五条结论的**技术判断全部成立**。#7 双入口都改、#1 的 `Math.ceil(x - ulp)` 处理浮点噪声、
  #6 用 `Double.isFinite` 补 `Math.max(0, NaN)` 的洞、#4 的「不交换 5/8 步」论证、
  #3 的「已告知的破坏性操作不是缺陷」——我逐条回源码核过，**都对**。
- 它**发现并派回了 #8**，而 #8 是三轮里最危险的一条（静默洗配置 + 宣布成功）。
  这一条是验收真正的增量价值。
- 它对自己那次 `EXIT=1` 的处理（「验收者自己的工具出错，不能算成被验收对象的失败」）是诚实的。

**一句话**：**代码层面的判断可信，证据层面的纪律不可信。**
62% 的含义是——如果你只想知道「这 4 条修复对不对」，答案是「对」；
如果你需要**事后向别人证明**它们对，或者需要它作为「框架验收相位有效」的样本，
这份材料撑不住：它的证据已经随 `mvn clean` 消失，它的 fail-closed 结论是错的，
它的 7 处行号指错了地方，它的「fail-closed」结论经不起一次重启。

---

*红队记录：三次尝试，前两次死于 API 断连。本文件按 A/B/C/D/E/F/G 顺序增量落盘。*

