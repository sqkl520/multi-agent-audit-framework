# 第二轮 dsh 交付验收（#8 reload 消息说谎）

**验收时间**：2026-11-15 03:30
**对象**：dsh 对 `task-repair-8.md` 的交付
**原则**：同上轮，不采信自述，回到源码 / 消息键 / 测试实跑

---

## 结论

**修复成立，且超出了我任务书里写的内容。**

全量测试由我独立重跑确认：

```
Tests run: 885, Failures: 0, Errors: 0, Skipped: 1
BUILD SUCCESS
EXIT=0
```

877 → 885（+8），与 dsh 自述一致。

---

## 核实过的点

### `loadFromFile()` 签名真的改了

```java
public boolean loadFromFile() {
```

成功路径末尾 `return true;`，失败分支 `return false;`。
既有 4 处裸调用 `config.loadFromFile();` 仍合法（Java 允许表达式语句丢弃返回值），
完整编译通过即为证明。

### 两个调用点都消费了返回值

`MainConfigMenu.java`：`boolean reloaded = configManager.loadFromFile();`，
成功发 `reloaded-msg` + PLING 音，失败发 `reload-failed` + `BLOCK_ANVIL_LAND` 音。
**成功文案与音效逐字未改**——这是任务书的硬性要求。

`HilltopCommandHandler.java`：`boolean configReloaded = ...`，
`config-reloaded` 只在 true 时发。

### 消息键 EN/ZH 成对存在

```
:23    config-reload-failed            (EN, 命令)
:635   config.menu.main.reload-failed  (EN, GUI)
:1312  config-reload-failed            (ZH, 命令)
:1737  config.menu.main.reload-failed  (ZH, GUI)
```

---

## dsh 超出任务书的发现：`ABSENT` 分支

我任务书里的缺陷定义是「文件不可用时保留内存值，但菜单仍报成功」。
dsh 发现还有**更危险的变体**，我核实了，属实：

`HilltopCommandHandler` 在调 `loadFromFile()` **之前**先做 `settingsGate.reset()`
（`:404-408`，注释写明「先解封各 YAML 闸门，再重载」）。这之后：

- `isReadOnly()` 已被 reset 清掉 → `false`
- 若隔离期间文件被删除，`load()` 返回 `ABSENT`
- `YamlFiles.Status.ABSENT` 的注释写明「config 是可写的空配置，不是错误」→ `usable()` 为 `true`

于是旧条件 `!loaded.usable() || settingsGate.isReadOnly()` **放行**，
用空配置重建内存并返回成功。

结果不是「消息说谎」而升级为「**静默洗掉管理员全部配置，并宣布重载成功**」。

dsh 把 `ABSENT` 加进拒绝条件，并加了独立回归测试
`loadFromFileReturnsFalseWhenFileIsAbsentEvenAfterGateReset`。

**这条我认可是真缺陷，不是过度防御**——触发条件是「文件坏了被隔离 → 管理员删掉它 → 再 reloadconfig」，
是运维中会走到的路径。

---

## 测试红绿证据

红测（未修复的 `void` 版上跑两个调用方测试）：

```
Tests run: 4, Failures: 2, Errors: 0, Skipped: 0
```

GUI 侧失败原文：

```
★ game-settings.yml 不可用时必须发 reload-failed（而不是 reloaded-msg）。
缺陷版在这里发的是 reloaded-msg —— 管理员会以为磁盘值已经生效
==> expected: <config.menu.main.reload-failed> but was: <config.menu.main.reloaded-msg>
```

命令侧失败原文附了完整实际播报数组（`§a游戏设置已从 game-settings.yml 重新加载。` 等三条），
证明它抓的是真实输出而非构造断言。

dsh 还诚实说明：`ConfigManagerTest` 里那 4 条 API 契约测试**在旧签名上编译不过**，
所以它们不是红测，是改签名后补的回归网；真正先红的是两条调用方测试。
**这种区分是对的**——把编译失败说成「测试变红」是常见的自欺。

---

## 一处需要记录的验收方法

dsh 为了留档失败原文，做了这个流程：

> 在保留 `boolean` API（让测试可编译）的前提下，把两个调用方临时还原到 HEAD 复跑，
> 失败文本与首次一致；复现后按字节恢复两个文件并做 SHA-256 比对，再执行 clean build。

这是正确做法：**证明红测不是靠把 API 改回去，而是靠把调用方改回去**。
如果它把 API 一起还原，那两条测试根本编译不过，就没有红测可谈。

---

## 残余风险

### 我认可的

1. **`ABSENT` 行为变化**：以前「删掉坏文件再 reloadconfig」会恢复出厂空配置并报成功，
   现在返回 false 保留内存。这是有意的安全取舍，但属于可感知行为变更，需要 CHANGELOG。
2. **成功只代表 game-settings 已加载**：`monsters-config.yml` 独立失败时
   `loadFromFile()` 仍返回 true。文案已限定为「游戏设置」，没有夸大，但部分失败不可见。
3. **`catch (RuntimeException)` 的部分失败提示仍是硬编码英文**——既有路径，未本地化，
   也不冒充成功。可接受但应记一笔。

### 需要用户决策的

**CHANGELOG**。dsh 给了完整建议文本（在 `done-8.md` 末尾），并正确判断
「不应回填已发布的 `1.1.0-SNAPSHOT-fix3`（那段日期 2026-11-11、正文写死 846 项测试）」，
应新开一个版本段。它**没有擅自改 `CHANGELOG.md`**，符合我「先别改文件」的指示。

我现在有 3 条可写入 CHANGELOG 的内容：

- 【#8】reload 失败不再播报成功（Fixed）
- #6 爆炸威力与节点伤害倍率解耦（Changed，影响手感）
- #1 `repair-cost-amount` 语义变更（Changed，旧配置注释不迁移）

---

## 三轮 dsh 派发的累计结果

| 轮次 | 内容 | 测试数 | 结果 |
|---|---|---|---|
| 前序（主线程越界完成） | #2 #5 | 846 → 863 | 已验收 |
| 第一轮 | #7 #1 #6 #4，判定 #3 不修 | 863 → 877 | 已验收 |
| 第二轮 | #8 | 877 → 885 | 已验收 |

**全部由我独立重跑确认，不是采信 dsh 的自述。**

剩下的已知未修项（dsh 三轮都记录了，未顺手改）：

- `nodeSelfDestructMultiplier` 缺 NaN/Infinity 钳制
- #4 第 7 步商店 NPC 删除不可逆
- `arenas.yml` 的 per-arena `game.victory-waves` 不受 #7 钳制
- `catch (RuntimeException)` 硬编码英文未本地化
