# Hilltop Village 第三轮静态审计 · A 组：数据与配置

## 一、审计范围

- 目标根：`<TARGET_REPO>\src\main\java\com\hilltopvillage`
- 切片：`round3-A`，共 14 个文件，全部逐个打开读到文件尾（大文件按 120–200 行分段读，不以摘要代替原文）。
- 方式：纯静态阅读，未启动服务器、未执行插件、未修改任何源码；结论只覆盖本轮实际读到的行。
- 重点：YAML 载入 / GUI 展示与回写 / 消费者三方在范围、单位、类型上的一致性；缺失键与空串；数值边界（负数、0、超大值、NaN、小数、强转）；`StatsManager` 的落盘与载入；重载后的对象生命周期；`ConfigPermission` 字符串与消费者一致性。
- 严重性上限按契约取 HIGH；本轮没有把任何条目升级为 CRITICAL。

## 二、已读文件与逐文件结论

| 文件 | 结论 |
| --- | --- |
| `config/ConfigManager.java` | 载入侧多处只做「有键就赋值」，与 GUI 区间不一致（A-01、A-02）；重载替换 activeConfig（A-04）。 |
| `config/ConfigPermission.java` | 6 个权限节点与 `MainConfigMenu` 的 `hasPermission` 调用、命令侧字符串一致；`description` 无 getter，但不参与运行路径，未发现独立缺陷。 |
| `config/DisplayConfig.java` | `defaults()` / `defaultLines()` 与加载器常量一致；`Tab` 紧凑构造对 null 做了归一，未发现独立缺陷（A-05 涉及默认值语义）。 |
| `config/DisplayConfigLoader.java` | tab 段缺失键被解析成空列表，与 scoreboard 的「缺失=出厂」相反（A-05）。 |
| `config/GameConfig.java` | `snapshot()`（594–668）与 `WaveConfig.copy()`（501–507）均为深拷贝，`hasUnsavedChanges()` 不存在别名误判；setter 无校验但与载入侧同源，未发现独立缺陷。 |
| `config/menu/AbstractConfigMenu.java` | `reopen()` 先 `HandlerList.unregisterAll(this)` 再注册，不会重复监听；返回键槽位冲突已在 `WaveSettingsMenu` 用 48 号槽显式规避，未发现独立缺陷。 |
| `config/menu/GameRulesMenu.java` | min/max players 无交叉校验，但 `ArenaManager.validationFailure` 会在下次载入时以明确日志拒绝 `max < min` 的竞技场定义，属「已有下游兜底」，本轮不单列为缺陷以免与既有校验重复。 |
| `config/menu/ItemSettingsMenu.java` | 闭包在 `buildMenu()` 捕获 `cfg` 的问题归入 A-04，不重复计数。 |
| `config/menu/MainConfigMenu.java` | 保存按钮正确消费 `saveToFile()` 返回值；重载按钮不检查未保存修改（A-04）。 |
| `config/menu/MonsterSettingsMenu.java` | health 区间 5–500 与载入侧不一致，归入 A-01；其余区间与 setter 自洽。 |
| `config/menu/NodeSettingsMenu.java` | 4 项区间与 setter 一致；`repair-amount-per-cost=0` 会被 `NodeSystem.repairNode` 的 `isFinite/<=0` 守卫拒绝（静默但无崩溃），未发现独立缺陷。 |
| `config/menu/NumericInputHandler.java` | 整数回调对小数静默截断（A-06）。 |
| `config/menu/WaveSettingsMenu.java` | total-mobs 上限缺失（A-02）；新建波次编号无范围校验（A-03）。 |
| `stats/StatsManager.java` | 载入不校验计数器语义，脏值会被写回（A-07）。 |

## 三、发现

### A-01 怪物 health 载入不设区间，负值会在刷怪任务内抛异常并让波次停摆

`monsters.<key>.health` 在载入侧只要键存在就原样赋值，既没有区间校验也没有有限性校验，而同一字段在配置 GUI 中声明为 5–500。触发条件是把该值手改为 0、负数或 `.NaN` 后执行重载，值会不经任何归一进入 `MonsterConfig`。刷怪路径 `WaveManager.spawnExplodeBeetle` 把它直接传给 `Attribute.MAX_HEALTH.setBaseValue` 与 `Entity.setHealth`，负值会抛 `IllegalArgumentException`，而该调用不在 `spawnEntity` 的 try/catch 内，异常冒泡会取消当前刷怪任务，波次完成判定不再推进。默认 `wave-timeout=0`（禁用超时）时对局会永久停在当前波，只能由管理员手动结束。

`config/ConfigManager.java:1636`

```java
if (settingsYaml.contains("monsters." + key + ".health")) mc.setHealth(settingsYaml.getDouble("monsters." + key + ".health"));
```

### A-02 波次 total-mobs 载入无上限，GUI 一次右键就把 500 静默压成 100

波次详情页把 `total-mobs` 声明为 1–100，并在 setter 里再次 `Math.min/Math.max` 钳制，但载入侧只把负值归零，没有上限。于是 `total-mobs: 500` 会原样载入并显示为 500，管理员右键一次（步长 2）时 setter 直接把 498 压成 100，磁盘上的 500 被静默改写。左键在 500 处因 `val <= max + 容差` 不成立而完全没有反应，GUI 既无法表达也无法保留这个已载入的合法值。结果是一次误点造成 5 倍配置丢失，保存后不可撤销，且全程没有确认或提示。

`config/menu/WaveSettingsMenu.java:226`

```java
() -> wc.getTotalMobs(), v -> wc.setTotalMobs(Math.min(100, Math.max(1, v))),
```

### A-03 新建波次编号没有范围校验，可生成永远不会被刷出的「幽灵波次」

新建波次只查重不查范围：`requestInteger` 的无区间重载最终把值限制在 ±1e9，回调里只用 `containsKey` 判重。输入 0、-3 或 999999 都会写进 `waves.<n>`，而载入侧对数字键同样不做范围校验，因此这些波次会持久化并出现在列表中。但 `WaveManager` 的波次号从 1 开始逐波递增、到 `victory-waves` 结束，这些编号永远不会被取到，管理员看到的是永远不刷的波次，还会稀释分页。GUI 既不拒绝也不提示，管理员会误以为自己配置的「第 0 波」已经生效。

`config/menu/WaveSettingsMenu.java:118`

```java
cfg.getWaves().put(num, new GameConfig.WaveConfig(10, new LinkedHashMap<>()));
```

### A-04 重载丢弃未保存修改，已打开的子菜单继续写入被替换的旧 GameConfig

重载按钮直接调用 `loadFromFile()` 并立即提示「已重载」，既不检查是否存在未保存修改，也不消费载入结果；`activeConfig` 被整体替换后，未保存的 GUI 修改直接消失。命令侧的 `/hilltop reload` 走同一入口，同样没有未保存检查。更隐蔽的是各子菜单在 `buildMenu()` 时把 `GameConfig cfg = configManager.getActiveConfig()` 捕获进闭包，重载后仍然开着的子菜单会继续往旧对象写值；`saveToFile()` 序列化的是新的 `activeConfig`，这些写入既不会落盘，也不会让 `hasUnsavedChanges()` 变脏。该行为与 `ConfigManager` 文末「消费者不得缓存 GameConfig」的契约直接冲突。

`config/menu/MainConfigMenu.java:149`

```java
configManager.loadFromFile();
```

### A-05 display.yml 只写部分 tab 键时，页眉页脚被解析成空而不是出厂默认

`parseTab` 对 `header`/`footer` 复用 `parseOptionalLines`，而该函数在键缺失时直接返回空列表；同一份文件里 `scoreboard.lines` 的缺失语义却是「恢复出厂布局」。因此一份只写了 `tab.enabled`、或只改 `player-name.*` 的 display.yml 会让 tab 头尾变成空白，且不产生任何 warning。`DisplayConfig.defaults()` 明确给出 3 行默认 tab 内容，说明「缺失=空」并非设计意图；服主精简配置或手删这两段后，玩家看到的就是没有页眉页脚的 TAB。两种缺键语义在同一次解析里相反，属于可复现的数据一致性缺陷。

`config/DisplayConfigLoader.java:204`

```java
if (!section.contains(key)) {
```

### A-06 requestInteger 对小数输入静默截断，0.9 会变成 0

`requestInteger` 在回调里先按 ±1e9 钳制，再用 `(int)` 强转，小数被向零截断且没有任何提示。对下限为 0 的整数字段（例如 custom-model-data），输入 0.9 会得到 0，输入 2.9 会得到 2；玩家看到的是「已设置」，实际值与输入不符。注释只声明这样能避免 1e300 溢出，并未处理精度损失，而 prompt 明确要求输入整数。正确做法应是拒绝小数并提示重输，而不是接受后悄悄改值。

`config/menu/NumericInputHandler.java:80`

```java
callback.accept((int) clamped);
```

### A-07 StatsManager 载入不校验计数器语义，脏值会进入排行榜并被写回磁盘

`load()` 对每个玩家记录只做 `getInt`/`getString`，不校验计数器的符号或上限，负的 `wins`/`kills` 与 21 亿级的 `best-wave` 都会原样进入缓存。`top()` 又以 `value <= 0` 过滤，于是负值记录从排行榜静默消失、超大值长期霸榜，`getWinRate` 还能算出大于 100% 的胜率。`buildSnapshot()` 会把同一批值写回磁盘，使一次手改或外部工具合并造成的脏数据永久固化，而全程只有 YAML 解析异常才会告警。语义损坏与语法损坏被当成两件事，后者有隔离机制，前者完全没有。

`stats/StatsManager.java:314`

```java
stats.wins = section.getInt("wins", 0);
```

## 四、自检

- 标识符核对：7 条发现的类名、方法名、字段名、常量名均与源码逐字一致；所有 `file:line` 在写完后按行号回读复核，未使用记忆中的旧行号。
- 引文核对：每条 `evidence.quote` 都是本轮实际读到的单行原文，未拼接相邻行、未改写空白、未用省略号；相邻行只在正文中作为补充路径描述。
- 交叉验证：A-01 同时核对了载入（ConfigManager）、GUI（MonsterSettingsMenu）与消费者（WaveManager）；A-02/A-03 核对了菜单 setter 与 `readWaveInt`/数字键重建；A-04 核对了重载入口、闭包捕获点与保存路径；A-05 核对了加载器与 `DisplayConfig.defaults()`。
- 未采用项：`GameConfig.snapshot()` 浅拷贝、`MainConfigMenu` 忽略保存失败、货币掉落 min/max 未交换、怪物键大小写敏感这四条候选经源码核对均不成立或已有显式告警，故未写入发现，避免凑数。
- 运行时验证：本轮为静态审计，未启动服务器，未做运行时复现；A-01 的异常链依据 Bukkit 调度器「任务抛异常即取消」的既有语义推导，未实测。

## 五、输出契约

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "round3-audit-A",
  "role": "audit",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "round3-A-audit.md",
  "error": null,
  "payload": {
    "slice_id": "round3-A",
    "searched_scope": {
      "files_read": [
        "config/ConfigManager.java",
        "config/ConfigPermission.java",
        "config/DisplayConfig.java",
        "config/DisplayConfigLoader.java",
        "config/GameConfig.java",
        "config/menu/AbstractConfigMenu.java",
        "config/menu/GameRulesMenu.java",
        "config/menu/ItemSettingsMenu.java",
        "config/menu/MainConfigMenu.java",
        "config/menu/MonsterSettingsMenu.java",
        "config/menu/NodeSettingsMenu.java",
        "config/menu/NumericInputHandler.java",
        "config/menu/WaveSettingsMenu.java",
        "stats/StatsManager.java"
      ],
      "files_in_slice": 14,
      "dimension_checklist": [
        "logic：数值边界、单位与步长、波次编号与胜利条件的关系",
        "data-consistency：YAML 载入值 / GUI 区间 / 消费者语义三方一致性",
        "error-handling：缺失键、空串、类型不符、解析异常与静默失败",
        "contract：ConfigManager 的「不得缓存 GameConfig」约定与菜单闭包生命周期",
        "concurrency：StatsManager 的异步刷盘、写入序号与重载窗口",
        "security：配置权限节点与命令/GUI 的校验口径"
      ]
    },
    "findings": [
      {
        "finding_id": "A-01",
        "title": "怪物 health 载入不设区间，负值在刷怪任务内抛异常导致波次停摆",
        "severity": "HIGH",
        "dimension": "data-consistency",
        "evidence": {
          "file": "config/ConfigManager.java",
          "line": 1636,
          "quote": "if (settingsYaml.contains(\"monsters.\" + key + \".health\")) mc.setHealth(settingsYaml.getDouble(\"monsters.\" + key + \".health\"));"
        },
        "inference": {
          "claim": "载入侧对 monsters.<key>.health 无区间/有限性校验，而 GUI 限制 5–500；负值进入 WaveManager 后会使 setBaseValue/setHealth 抛 IllegalArgumentException，刷怪任务被取消，波次无法推进。",
          "basis": "逐行核对 ConfigManager 1610–1648（仅 contains + getDouble）、MonsterSettingsMenu 85–86（5–500 区间）、WaveManager 546–592（health 直接传 setBaseValue/setHealth，try/catch 只包 spawnEntity）。",
          "alternatives": [
            "Bukkit 会把负生命值自动钳到 0 而不抛异常，异常链不成立",
            "WaveManager 外层还有一层 try/catch 会吞掉异常并继续推进波次",
            "health 只用于展示，不参与实体生成与属性设置"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "A-02",
        "title": "波次 total-mobs 载入无上限，GUI 一次右键把 500 静默压成 100",
        "severity": "MEDIUM",
        "dimension": "data-consistency",
        "evidence": {
          "file": "config/menu/WaveSettingsMenu.java",
          "line": 226,
          "quote": "() -> wc.getTotalMobs(), v -> wc.setTotalMobs(Math.min(100, Math.max(1, v))),"
        },
        "inference": {
          "claim": "载入只把负 total-mobs 归零、不设上限，GUI 却声明 1–100 并在 setter 内钳制；载入 500 后任何一次减操作都会把它静默改写为 100，加操作则被上限判断挡住。",
          "basis": "核对 WaveSettingsMenu 224–227（1/100/2 与 setter 双重钳制）、ConfigManager 1773–1775 与 readWaveInt 的负值归零路径（无上限）、以及 WaveManager 92–112 对 totalMobs 的使用。",
          "alternatives": [
            "载入侧也会把 total-mobs 钳到 100，GUI 与磁盘始终一致",
            "500 属于非法配置，钳到 100 是预期修正而非数据丢失",
            "左键在 500 处仍可继续加值，配置不会被改写"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "A-03",
        "title": "新建波次编号无范围校验，可生成永不刷出的幽灵波次",
        "severity": "MEDIUM",
        "dimension": "logic",
        "evidence": {
          "file": "config/menu/WaveSettingsMenu.java",
          "line": 118,
          "quote": "cfg.getWaves().put(num, new GameConfig.WaveConfig(10, new LinkedHashMap<>()));"
        },
        "inference": {
          "claim": "新建波次路径只用 containsKey 判重，不校验编号下界与 victory-waves 上界；0/负数/超大编号会被写入并持久化，但 WaveManager 从 1 递增取波，这些条目永远不会被刷出。",
          "basis": "核对 WaveSettingsMenu 108–128（无 min/max 的 requestInteger 与 containsKey）、NumericInputHandler 85–88（区间为 Integer.MIN_VALUE/MAX_VALUE，最终 ±1e9）、ConfigManager 1762–1796（数字键仅 parseInt，无范围过滤）、WaveManager 92–112（按 waveNumber 取配置）。",
          "alternatives": [
            "WaveManager 会遍历配置中的所有键生成波次，0/负数同样会被取到",
            "编号 0 被有意用作开局预备波，存在专门分支处理",
            "载入侧会丢弃 <=0 的波次键，幽灵波次不会持久化"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "A-04",
        "title": "重载丢弃未保存修改，已打开子菜单继续写入被替换的旧 GameConfig",
        "severity": "HIGH",
        "dimension": "contract",
        "evidence": {
          "file": "config/menu/MainConfigMenu.java",
          "line": 149,
          "quote": "configManager.loadFromFile();"
        },
        "inference": {
          "claim": "重载入口无条件替换 activeConfig 并立即提示成功；子菜单在 buildMenu 时缓存的 cfg 仍指向旧对象，重载后的点击只改旧对象，saveToFile 序列化新对象，修改永久丢失且 hasUnsavedChanges 不会变脏。",
          "basis": "核对 MainConfigMenu 146–156（无 hasUnsavedChanges 检查、无返回值判断）、ItemSettingsMenu 40 与 82–84（闭包捕获 cfg）、WaveSettingsMenu 42/212、ConfigManager 1993–2009 的「消费者不得缓存 GameConfig」约定与 loadFromFile 替换逻辑。",
          "alternatives": [
            "loadFromFile 原地更新 activeConfig 对象，闭包仍指向同一实例",
            "子菜单每次点击都重新调用 getActiveConfig，不缓存对象",
            "重载按钮在有未保存修改时会被禁用或弹出确认"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "A-05",
        "title": "display.yml 缺省 tab.header/footer 被解析成空，与 scoreboard 的缺省语义相反",
        "severity": "MEDIUM",
        "dimension": "data-consistency",
        "evidence": {
          "file": "config/DisplayConfigLoader.java",
          "line": 204,
          "quote": "if (!section.contains(key)) {"
        },
        "inference": {
          "claim": "parseOptionalLines 在键缺失时返回空列表，parseTab 直接用它构造 Tab；同一文件里 scoreboard.lines 缺失却回落到 defaultLines，导致部分配置的 display.yml 静默清空 tab 页眉页脚且无 warning。",
          "basis": "核对 DisplayConfigLoader 201–212（缺失返回 List.of()）、134–164（scoreboard 缺失回落到 defaultLines）、DisplayConfig 149–156（defaults() 给 tab 定义了 3 行）。",
          "alternatives": [
            "tab 缺省 header/footer 本就应为空，defaults() 只是未被使用的兜底",
            "parseTab 随后会用 defaults.tab() 补齐缺失段",
            "display.yml 模板始终包含 header/footer 键，缺失状态不可达"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "A-06",
        "title": "requestInteger 对小数输入静默截断",
        "severity": "MEDIUM",
        "dimension": "error-handling",
        "evidence": {
          "file": "config/menu/NumericInputHandler.java",
          "line": 80,
          "quote": "callback.accept((int) clamped);"
        },
        "inference": {
          "claim": "整数输入在钳制后直接 (int) 强转，向零截断且无提示；下限为 0 的字段输入 0.9 会得到 0，输入 2.9 会得到 2，玩家看到的确认值与实际写入值不一致。",
          "basis": "核对 NumericInputHandler 66–88（±1e9 钳制与强转）与 onChat 的 isFinite 校验（只拦 NaN/Infinity，不拦小数）、ItemSettingsMenu 的 custom-model-data 0–999999 区间。",
          "alternatives": [
            "onChat 已拒绝所有非整数输入，小数到不了回调",
            "截断是文档化的既定行为，玩家已知悉",
            "所有整数字段下限都 >= 1，截断结果总会被钳到合法值"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "A-07",
        "title": "StatsManager 载入不校验计数器语义，脏值进入排行榜并被写回",
        "severity": "MEDIUM",
        "dimension": "data-consistency",
        "evidence": {
          "file": "stats/StatsManager.java",
          "line": 314,
          "quote": "stats.wins = section.getInt(\"wins\", 0);"
        },
        "inference": {
          "claim": "load() 对每项统计只做 getInt/getString，负值与超大值原样入缓存；top() 的 <=0 过滤让负值静默消失、超大值霸榜，buildSnapshot 又把脏值写回磁盘，语义损坏被永久固化。",
          "basis": "核对 StatsManager 304–337（无符号/上限校验）、176–181（value<=0 过滤与排序）、369–395（buildSnapshot 原样写回），以及 268–294 仅对解析异常做隔离。",
          "alternatives": [
            "stats.yml 只由插件写入，手改不在支持范围内",
            "getInt 对非法值返回 0，已足以防御语义损坏",
            "top() 的 <=0 过滤会把负值当作无数据，属于预期行为"
          ]
        },
        "status": "CONFIRMED"
      }
    ],
    "self_checks": {
      "identifier_reconcile": {
        "status": "DONE",
        "note": "7 条发现的类名/方法名/字段名均按源码逐字核对，所有 file:line 在成文后回读复核，未使用旧行号。"
      },
      "self_check_audit": {
        "status": "DONE",
        "note": "逐条复读 evidence.quote 与源码单行比对，确认无拼接、无改写、无省略号；相邻行只在正文中描述。"
      },
      "runtime_validation": {
        "status": "SKIPPED",
        "note": "本轮为纯静态审计，未启动服务器、未执行插件，因此没有运行时复现数据。"
      }
    }
  }
}
```
