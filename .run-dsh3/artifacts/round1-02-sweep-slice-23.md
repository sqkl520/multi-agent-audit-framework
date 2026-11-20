# round1 / slice-23 宽扫（sweep）

- trace_id: trace-r1-20260215-hilltop-dsh3
- slice_id: slice-23
- 切片文件: `src/main/java/com/hilltopvillage/mechanics/VillagerSystem.java`（355 行，LF 行尾，本回合全文 read）
- shared_dependencies: 无
- reachability: **PROD**
- 定位：只出线索，不判严重性、不做证据链、不写 findings。

## 1. 可达性判定（浅层，按 wave2a §5）

本回合用 grep（非 read，未计入 files_read）确认了引用链，三处命中：

| 位置 | 命中内容 | 含义 |
|---|---|---|
| `src/main/java/com/hilltopvillage/arena/ArenaInstance.java:150` | `this.villagerSystem = new VillagerSystem(plugin, gameManager);` | 每个竞技场实例化一次 |
| `src/main/java/com/hilltopvillage/HilltopVillagePlugin.java:204` | `Bukkit.getPluginManager().registerEvents(new VillagerSystem.GlobalListener(this), this);` | `onEnable()` 里全局注册监听器 |
| `src/main/java/com/hilltopvillage/mechanics/ArenaScoreboard.java:588`、`TabListManager.java:743` | `arena.getVillagerSystem().getAliveCount()` | 记分板 / TabList 每轮读取 |

结论：从插件启用入口（`onEnable` → 注册监听器）与竞技场实例（`ArenaInstance` 构造）双向可达，且被计分板热路径读取 → `PROD`。以上三行来自 grep 输出，未做逐文件 read，故不列入 `files_read`。

## 2. 六维度快扫结论

| 维度 | 本切片观察 | 线索数 |
|---|---|---|
| `logic` | 失败判定只在死亡事件里评估，而存活判定带 `isValid()` 过滤；零村民部署时只 warning 后照常开局 | 2 |
| `concurrency` | 列表用 `CopyOnWriteArrayList`、`deployedTotal` 用 `volatile`；生产路径均在主线程（事件回调 / 计分板 runnable），未发现异步触碰世界状态的证据，不硬凑 | 0 |
| `security` | 伤害白名单只判 `instanceof Monster`，不校验怪物归属（刷怪蛋 / 指令怪同样放行） | 1 |
| `error-handling` | 配置血量直接进 `setHealth`，无有限性校验；异常会中断 `spawnAll` 循环 | 1 |
| `data-consistency` | 以实体对象身份（`villagers.contains`）判定成员资格，与「区块卸载重载后包装实例会变」冲突；同一判定在 `cleanupOrphans` 中反向使用会删除在世村民 | 2 |
| `contract` | `EventPriority.MONITOR` 的监听器内改写事件（清掉落、清经验） | 1 |

## 3. 线索清单（quote 均为本回合 read 到的原文，line 为 quote 起始行）

### L1 · logic · line 192
- quote: `if (villager != null && villager.isValid() && !villager.isDead()) count++;`
- why_suspicious: 存活数按 `isValid()` 过滤，但「全灭 = 失败」只在 `handleVillagerDeath` 里评估；村民被非死亡途径移除（区块卸载、其他插件 `remove()`、实体丢失）时计数静默归零却不会触发失败结算。
- confidence: MEDIUM

### L2 · data-consistency · line 235
- quote: `if (!villagers.contains(villager)) return;`
- why_suspicious: 用实体对象身份判定「是否本局村民」，而列表保存的是生成时的包装实例；区块卸载重载后事件里的新实例不在列表中，该村民会整条跳过伤害拦截与死亡结算。
- confidence: MEDIUM

### L3 · data-consistency · line 178
- quote: `if (villagers.contains(villager)) continue;`
- why_suspicious: 同一身份判定在 `cleanupOrphans` 中反向使用，重载后仍在世的受保护村民会被判成孤儿并 `remove()`，而 `deployedTotal` 不同步减少，存活数与分母从此不一致。
- confidence: MEDIUM

### L4 · security · line 276
- quote: `if (entity instanceof Monster) return true;`
- why_suspicious: 白名单只认 `instanceof Monster`，任何玩家用刷怪蛋或 `/summon` 生成的僵尸、骷髅都会被当成合法伤害源，可击杀受保护村民并触发全灭失败。
- confidence: MEDIUM

### L5 · error-handling · line 144
- quote: `villager.setHealth(Math.max(1.0, health));`
- why_suspicious: 配置血量未做有限性 / 上限校验，`Math.max(1.0, NaN)` 仍是 `NaN`，`setHealth` 会抛异常，`spawnAll` 在 for 循环中途退出：已生成村民留在世界里，而 `deployedTotal` 停在旧值。
- confidence: MEDIUM

### L6 · contract · line 285
- quote: `event.getDrops().clear();`
- why_suspicious: 该处理方法声明在 `EventPriority.MONITOR`（第 333 行）却在此改写事件（清空掉落、`setDroppedExp(0)`），MONITOR 约定为只读观察点，且村民本身并无掉落物。
- confidence: MEDIUM

### L7 · logic · line 117
- quote: `plugin.getLogger().warning("Arena " + gameManager.getArenaId() + " has no villagers deployed; the all-villagers-slain defeat will never trigger");`
- why_suspicious: 未部署任何村民时只打印一条 warning 就 return，竞技场照常开局，而这一局的失败条件永久不可达，调用方拿不到任何失败信号。
- confidence: MEDIUM

## 4. 复现要点（给深挖）

- L2/L3 的验证点：Bukkit 实体包装实例在区块卸载/重载后是否重新创建（若是，`contains` 的身份判定即失效）；可查 `CraftEntity#equals` 与实体缓存生命周期。
- L4 的验证点：`gameManager.getWaveManager().getActiveMobs()` 之外的怪物是否有归属校验；结合 `WaveManager` 的刷怪登记范围确认「非本局怪物」是否可进入白名单。
- L5 的验证点：`ConfigManager#getVillagerHealth()` 的解析路径是否可能返回 `NaN`（缺键 / 非数字默认值 / 除零）。
- L1 的验证点：是否存在「村民未死亡但 `isValid()` 为 false」的清理路径（`/kill`、区块卸载、`remove()`），以及该路径是否有独立的失败兜底。

## 5. 自检说明

- 本切片只 read 了派发的 1 个文件，未读切片外文件；grep 仅用于可达性浅查，未将其结果当作证据。
- 未对被审仓库做任何写入。
- 校验命令与退出码见返回汇报。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "sweep-slice-23",
  "role": "sweep",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:\\Projects\\AI prompt\\many-agents_multi-prompt-files_token-heavy\\multi-agent-audit-framework\\.run-dsh3\\artifacts\\round1-02-sweep-slice-23.md",
  "payload": {
    "slice_id": "slice-23",
    "reachability": "PROD",
    "files_read": [
      {
        "path": "src/main/java/com/hilltopvillage/mechanics/VillagerSystem.java",
        "lines": 355,
        "quote": "public void spawnAll() {"
      }
    ],
    "files_unreadable": [],
    "leads": [
      {
        "lead_id": "L1",
        "suspected_dimension": "logic",
        "file": "src/main/java/com/hilltopvillage/mechanics/VillagerSystem.java",
        "line": 192,
        "quote": "if (villager != null && villager.isValid() && !villager.isDead()) count++;",
        "why_suspicious": "存活数按 isValid() 过滤，但全灭失败只在死亡事件里评估，村民被非死亡途径移除时计数归零也不触发失败",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L2",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/mechanics/VillagerSystem.java",
        "line": 235,
        "quote": "if (!villagers.contains(villager)) return;",
        "why_suspicious": "用实体对象身份判定是否本局村民，区块卸载重载后事件里的新实例不在列表中，会跳过伤害拦截与死亡结算",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L3",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/mechanics/VillagerSystem.java",
        "line": 178,
        "quote": "if (villagers.contains(villager)) continue;",
        "why_suspicious": "同一身份判定在 cleanupOrphans 中反向使用，重载后在世村民被判成孤儿删除，而 deployedTotal 不同步减少",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L4",
        "suspected_dimension": "security",
        "file": "src/main/java/com/hilltopvillage/mechanics/VillagerSystem.java",
        "line": 276,
        "quote": "if (entity instanceof Monster) return true;",
        "why_suspicious": "白名单只认 instanceof Monster，玩家用刷怪蛋或指令生成的怪物同样被当作合法伤害源，可击杀受保护村民触发全灭失败",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L5",
        "suspected_dimension": "error-handling",
        "file": "src/main/java/com/hilltopvillage/mechanics/VillagerSystem.java",
        "line": 144,
        "quote": "villager.setHealth(Math.max(1.0, health));",
        "why_suspicious": "配置血量未做有限性校验，Math.max(1.0, NaN) 仍为 NaN，setHealth 抛异常会让 spawnAll 循环中途退出且 deployedTotal 未回填",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L6",
        "suspected_dimension": "contract",
        "file": "src/main/java/com/hilltopvillage/mechanics/VillagerSystem.java",
        "line": 285,
        "quote": "event.getDrops().clear();",
        "why_suspicious": "处理方法声明在 EventPriority.MONITOR 却在此改写事件（清掉落、清经验），MONITOR 约定为只读观察点",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L7",
        "suspected_dimension": "logic",
        "file": "src/main/java/com/hilltopvillage/mechanics/VillagerSystem.java",
        "line": 117,
        "quote": "plugin.getLogger().warning(\"Arena \" + gameManager.getArenaId() + \" has no villagers deployed; the all-villagers-slain defeat will never trigger\");",
        "why_suspicious": "未部署村民时只 warning 后 return，竞技场照常开局而失败条件永久不可达，调用方没有失败信号",
        "confidence": "MEDIUM"
      }
    ],
    "lead_count": 7,
    "dimension_histogram": {
      "logic": 2,
      "concurrency": 0,
      "security": 1,
      "error-handling": 1,
      "data-consistency": 2,
      "contract": 1
    }
  },
  "error": null
}
```
