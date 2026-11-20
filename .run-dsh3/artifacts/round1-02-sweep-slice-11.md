# slice-11 宽扫（ConfigManager / ConfigPermission）

- status: COMPLETE
- slice: slice-11 / trace-r1-20260215-hilltop-dsh3 / round1
- 被审仓库（只读）：`D:\Server\MCServers\Server plugin\Hilltop Village\Hilltop Village Plugin`
- 范围偏差：任务书标注 `ConfigManager.java` 为 2155 物理行，实测 **2133 行**（`read` 工具报 "total 2133"）。本产物按实际内容审查，行号均取自本次读取。
- 重点：配置读写的数据一致性（reload 旧值清理 / 原子写盘 / `getString`→`valueOf` 未判空 / 数值 clamp 漏 NaN、Infinity / 默认值回填 / 部分写入）。

## 1. 切片概况

`ConfigManager` 是插件级单例（`HilltopVillagePlugin:99` `this.configManager = new ConfigManager(this);`），构造器里即跑 `initSettingsFile / initMonstersConfigFile / initDisplayFile / loadFromFile`；`/hilltop reloadconfig` 经 `HilltopCommandHandler:422` 调 `loadFromFile()`。因此本切片从生产入口可达（PROD）。

已确认该文件在数据一致性上做得比一般插件多：`loadFromFile()` 用 `activeConfig = new GameConfig()` 整体重建（1437），避免了「删键后 reload 无效、旧值复活」；两份 YAML 各有一把 `YamlFileGate`，读盘不可用时进入「本次只读、不回写」降级；`saveToFile()` 写前用 mtime 检测外部手改并先合并。下面的线索集中在这些机制**没有覆盖到的角落**，不是对整体设计的否定。

## 2. 线索（6 条，全部本回合逐字读取）

| id | 维度 | 位置 | 一句话 |
|---|---|---|---|
| L1 | data-consistency | ConfigManager.java:1425 | reload 失败分支把「当前内存」写成已落盘快照，未保存改动被洗成「已保存」 |
| L2 | data-consistency | ConfigManager.java:1442 | `contains()` 为真但值为 null 时 `getString` 返回 null，直接灌进 `worldName` |
| L3 | data-consistency | ConfigManager.java:1469 | `villager-health` 直接 `getDouble`，`.nan`/Infinity/负值无任何 clamp |
| L4 | data-consistency | ConfigManager.java:644 | `readWaveInt` 只钳负数，`Number.intValue()` 的溢出/小数截断不报 |
| L5 | data-consistency | ConfigManager.java:1577 | 载入过程中途直接全量写盘，绕过 `saveToFile` 的 mtime 外部修改检测 |
| L6 | contract | ConfigManager.java:2006 | 怪物配置读盘失败只 return，`loadFromFile()` 仍返回 true 宣告「已重载」 |

### L1 —— 失败分支把内存当成磁盘

`loadFromFile()` 在 `!loaded.usable() || ABSENT || isReadOnly()` 时保留内存值并提前返回，这是对的；但返回前执行了 `lastSavedSnapshot = activeConfig.snapshot()`。`hasUnsavedChanges()` 正是用「内存 vs `lastSavedSnapshot`」判脏，于是这一刻之后，本会话此前所有未落盘的 GUI 改动都会被判成「已是最新」，主菜单隐藏保存按钮。而文件根本没写成——改动只活在内存里，重启即丢。这条与 `revertAll()` 注释里「回滚不清脏标志」的谨慎正好相反。

### L2 —— `contains()` 与 `getString()` 不互斥

`world-name: `（空值）或写成非字符串标量时，`contains()` 为真、`getString()` 返回 `null`，`setWorldName(null)` 直接落地。同文件对 `hammer.material`（1477-1486）、`nodes.repair-cost-item`（1518-1529）都做了 null + 合法性双判，唯独这一行没有；`fireball.item-name`（1645）与 `monsters.*.display-name`（1752）同款。`worldName` 的消费者是 `Bukkit.getWorld(...)` 一类调用，null 会一路带到运行期。

### L3 —— `villager-health` 无 NaN/区间闸门

同一文件里 `explode-damage-multiplier` 有专门的 `normalizeExplodeDamageMultiplier`（显式挡 NaN / +Infinity / 负值），`victory-waves`、`repair-cost-amount` 也各有 normalize；但 `villager-health` 从磁盘 `getDouble` 后原样进 `GameConfig`。YAML 的 `.nan` / `.inf` 会被 SnakeYAML 读成 `Double.NaN` / `Infinity`，之后 `VillagerSystem:121` 取它设实体血量，Bukkit 的 `setHealth` 对 NaN 会抛 `IllegalArgumentException`。`mergeExternalChanges()` 的 441-444 行同样没有 clamp。clamp 覆盖是逐键手写的，这里漏了一键。

### L4 —— `readWaveInt` 的溢出与小数

该方法的注释明确说「三种非法形态（缺键 / 非数值 / 负数）全部显式化」，实现只做了 `value < 0` 一档。`intValue()` 对 `1e18`、`Long` 或 `Double.NaN` 的行为分别是饱和到 `Integer.MAX_VALUE`、截断、0，全部静默通过：`total-mobs: 1e18` 会变成 21 亿只的波次，控制台一句提示都没有。注释声称的覆盖面比代码宽——这是「能力声明大于实现」的形态。

### L5 —— 载入路径的两次全量写盘

`nodes.repair-item` 迁移（1544-1585）与 `shop.currency-drop-amount` 迁移（1660-1703）都在 `loadFromFile()` 内部直接 `settingsGate.write(settingsYaml)`。这两处写的是**载入开头读到的那份 `settingsYaml` 全量内容**，不经过 `saveToFile()` 的 mtime 比对，也不经过 `mergeExternalChanges()`。若在本次载入与这次写盘之间有人手改了文件（或另一进程写入），手改会被整份旧内容覆盖；同时 `activeConfig` 尚未构造完成，写盘发生在「内存半成品 + 磁盘已变」的中间态。

### L6 —— 半份 reload 被报成成功

`loadMonstersConfig()` 返回 `void`：`monsters-config.yml` 不可用或闸门只读时只打一条 SEVERE 就 return（2006-2010），内存里的怪物配置停留在构造器默认值。`loadFromFile()` 随后照常 `loadMonstersConfig(); ... return true`（1955、1964），调用方（`/hilltop reloadconfig`、GUI「加载配置文件」）据此向管理员宣告「已重载」。结果是 game-settings 生效、monsters-config 静默未生效，而唯一的信号是一条容易被刷过去的日志。随后 `lastSavedSnapshot` 也把这份「默认怪」快照成基线。

## 3. 明确未发现问题的点（避免下游重复劳动）

- `loadFromFile()` 的重建策略（1437 `activeConfig = new GameConfig()`）已正确处理「磁盘删键 → 内存回落默认」，旧 map 不会残留。
- `waves` 段用局部 `rebuiltWaves` 建好再整体 `clear()+putAll()`（1883-1922），解析期异常不会留下半张表。
- `nodes.buff-effects` 与 `starter-kit.items` 都用 `isSet()` 区分「键缺失 = 出厂」与「显式空 = 空」，并有对应告警。
- `Material` / `PotionEffectType` / `EntityType` 的解析普遍有 null 与 `isItem()` 校验，`EntityType.valueOf` 有 try/catch。
- `removedWaveKeys` 墓碑在 settings 写盘成功后立即清空，注释解释了为何不能等到 monsters 写成功（1013-1022），逻辑自洽。

## 4. 可达性

`PROD`。`ConfigManager` 由 `HilltopVillagePlugin:99` 在 `onEnable` 路径构造并被 `getConfigManager()` 暴露给 `GameManager` / 各菜单 / 监听器；`loadFromFile()` 与 `saveToFile()` 分别被 `/hilltop reloadconfig` 与配置 GUI 调用。非测试、非生成代码。

## 5. 产物信封

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "sweep-slice-11",
  "role": "sweep",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/.run-dsh3/artifacts/round1-02-sweep-slice-11.md",
  "payload": {
    "slice_id": "slice-11",
    "reachability": "PROD",
    "generator_ref": null,
    "files_read": [
      {
        "path": "src/main/java/com/hilltopvillage/config/ConfigManager.java",
        "lines": 2133,
        "quote": "public class ConfigManager {"
      },
      {
        "path": "src/main/java/com/hilltopvillage/config/ConfigPermission.java",
        "lines": 22,
        "quote": "public enum ConfigPermission {"
      }
    ],
    "files_unreadable": [],
    "leads": [
      {
        "lead_id": "L1",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/config/ConfigManager.java",
        "line": 1425,
        "quote": "lastSavedSnapshot = activeConfig.snapshot();",
        "why_suspicious": "读盘失败分支在未写入任何文件的情况下推进已落盘快照，使内存中的未保存改动被 hasUnsavedChanges 判成已保存。",
        "confidence": "HIGH"
      },
      {
        "lead_id": "L2",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/config/ConfigManager.java",
        "line": 1442,
        "quote": "if (settingsYaml.contains(\"world-name\")) activeConfig.setWorldName(settingsYaml.getString(\"world-name\"));",
        "why_suspicious": "contains 为真不代表 getString 非 null，空值或非字符串标量会把 null 直接写进 worldName，而相邻的 material 键都有 null 判。",
        "confidence": "HIGH"
      },
      {
        "lead_id": "L3",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/config/ConfigManager.java",
        "line": 1469,
        "quote": "if (settingsYaml.contains(\"villager-health\")) activeConfig.setVillagerHealth(settingsYaml.getDouble(\"villager-health\"));",
        "why_suspicious": "同一文件对 explode-damage-multiplier 专门挡 NaN/Infinity，villager-health 却裸 getDouble，.nan/.inf/负值原样进实体血量。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L4",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/config/ConfigManager.java",
        "line": 644,
        "quote": "int value = number.intValue();",
        "why_suspicious": "注释声称缺键/非数值/负数三种形态都显式化，实现只判负数；intValue 的饱和溢出与小数截断静默通过。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L5",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/config/ConfigManager.java",
        "line": 1577,
        "quote": "if (settingsGate.write(settingsYaml)) {",
        "why_suspicious": "载入过程中途用开头的整份 YAML 全量写盘做旧键迁移，不经过 saveToFile 的 mtime 外部修改检测，窗口内的手改会被覆盖。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L6",
        "suspected_dimension": "contract",
        "file": "src/main/java/com/hilltopvillage/config/ConfigManager.java",
        "line": 2006,
        "quote": "if (!loaded.usable() || monstersGate.isReadOnly()) {",
        "why_suspicious": "loadMonstersConfig 返回 void 且失败只 return，loadFromFile 仍返回 true，调用方会把半份 reload 宣告成成功。",
        "confidence": "MEDIUM"
      }
    ],
    "lead_count": 6,
    "dimension_histogram": {
      "logic": 0,
      "concurrency": 0,
      "security": 0,
      "error-handling": 0,
      "data-consistency": 5,
      "contract": 1
    }
  },
  "error": null
}
```
