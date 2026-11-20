# slice-12 宽扫（sweep）

- status: COMPLETE
- trace_id: trace-r1-20260215-hilltop-dsh3
- round_id: round1
- slice_id: slice-12
- 被审仓库（只读）: `D:\Server\MCServers\Server plugin\Hilltop Village\Hilltop Village Plugin`
- 切片文件:
  - `src/main/java/com/hilltopvillage/config/DisplayConfig.java`
  - `src/main/java/com/hilltopvillage/config/DisplayConfigLoader.java`
  - `src/main/java/com/hilltopvillage/config/GameConfig.java`
- 本波定位：只标「哪里可能有东西」，不判严重性、不做证据链、不写 findings。

## 1. 扫法与范围

按任务书的 6 维度快扫，重点放在：数值边界（0/负数/NaN/Infinity/小数）、`getDouble`/`Number` 取值后未校验、
默认值 vs 用户值、配置键拼写与消费方一致性、加载失败时的降级路径。

- 三个切片文件全文逐行读完（181 / 530 / 945 行）。
- 键名一致性用只读 `grep` 做了抽查（不计入 `files_read`，仅用于可达性与交叉核对）：
  - `display.yml` 模板中的 `scoreboard.refresh-ticks` / `tab.refresh-ticks` / `tab.player-name.*` /
    `contexts.*` / `separator` / `anim` / `frame-ticks` 与 `DisplayConfigLoader` 读取的键逐一对得上；
  - `DisplayConfig.defaultLines()` 的 10 个 `scoreboard.*` i18n 键与 `messages.yml`（en/zh 各一份）逐一对得上；
  - `GameConfig` 的默认怪种键 `explode-beetle` / `hook-claw-hunter` / `flying-dropper` 与
    `monsters-config.yml`、`game-settings.yml` 一致。
  - 未发现键名拼写不一致的线索，故本片不为此编造 lead。

## 2. 可达性判定：PROD

| 证据 | 说明 |
|---|---|
| `ConfigManager.java:321` `DisplayConfigLoader.Result result = DisplayConfigLoader.parse(displayYaml);` | 加载器由 `ConfigManager` 在加载/热重载时直接调用 |
| `ConfigManager.java:129` `this.displayFile = new File(plugin.getDataFolder(), "display.yml");` | 配置文件随插件启动读取 |
| `ConfigManager.java:135` / `:218` `this.displayConfig = DisplayConfig.defaults();` | 兜底路径确实被生产代码使用 |
| `ArenaScoreboard.java:30` / `TabListManager.java:121` 引用 `display.yml` 的刷新周期与行布局 | `DisplayConfig` 的消费方是生产渲染路径 |
| `WaveManager.java:100` `GameConfig.WaveConfig waveConfig = cfg.getWaveConfig(waveNumber);` | `GameConfig` 由对局主循环消费 |

结论：切片内三个文件均从生产入口可达，标 `PROD`。

## 3. 线索（leads）

### L1 `clampInt` 用 `Number.intValue()` 收窄，小数被静默截断、超 int 范围的值会回绕到最小值

- 位置：`DisplayConfigLoader.java:493`
- 原文：`return clamp(number.intValue(), min, max, label, warnings);`
- 疑点：`refresh-ticks` / `frame-ticks` 都走这里。YAML 的 `5.9` 会被 `intValue()` 截成 `5` 且**不产生任何
  warning**（5 已在合法区间内）；更大的问题是大整数：`refresh-ticks: 4294967296` 经 `intValue()` 回绕成 `0`，
  再被 `clamp` 夹到**下限 5**——用户想要「很慢」，得到的却是「最快刷新」。warning 里打印的也是回绕后的 `0`，
  管理员无法从日志还原自己写的值。
- 置信度：MEDIUM
- 维度：logic

### L2 `blank: false` 不被计为「已声明行型」，会被当成「没有行型」整行丢弃

- 位置：`DisplayConfigLoader.java:272`
- 原文：`boolean blankPresent = Boolean.TRUE.equals(map.get("blank"));`
- 疑点：`blank` 只在值为 `Boolean.TRUE` 时算「声明了 blank 行型」。于是 `blank: false` 这种写法
  （例如模板里留了一个开关、或管理员照 GUI 语义写成 false）既不算 blank，也不参与 `kinds > 1` 的多行型告警；
  若该行没有 `key`/`anim`/`separator`，会命中 `kinds == 0` 分支被整行跳过，报的却是「no line kind」，
  与用户实际写的字段不符。
- 置信度：MEDIUM
- 维度：contract

### L3 `when:` 空值被当成 `always`，缺键与「写了键但值为空」不可区分（fail-open）

- 位置：`DisplayConfigLoader.java:372`
- 原文：`Object raw = map.get("when");`
- 疑点：这里没有 `containsKey("when")` 判定，`when:`（键存在、值为 null）与「没写 when」走同一分支，返回
  `always`。而同一个方法对拼错的条件名采取的是 fail-closed（永不渲染）策略；空值却 fail-open，
  正好落在「本该隐藏的行被显示出来」这一侧，属于默认值 vs 用户值边界没有区分。
- 置信度：MEDIUM
- 维度：logic

### L4 `getString` 把非字符串值 `toString()` 后直接当 i18n 键，类型错误不告警

- 位置：`DisplayConfigLoader.java:216`
- 原文：`String value = section.getString(key);`
- 疑点：Bukkit 的 `getString` 对 Integer/Boolean 会返回 `"123"` / `"true"` 而非 null，于是
  `player-name.alive: 123` 这类类型写错的值会绕过下面 `value == null || value.isBlank()` 的检查，
  被当作合法键名传给渲染层，最终显示成字面量 `123`（或未命中翻译）。方法自称会检出
  「empty or not a string」，实际只检出了 empty。`scoreboard.title`（第 137 行）是同一模式。
- 置信度：MEDIUM
- 维度：contract

### L5 顶层段只缺一段时静默回退默认值，段名拼错（如 `Scoreboard:`）不会产生任何 warning

- 位置：`DisplayConfigLoader.java:113`
- 原文：`boolean hasBoard = yaml.isConfigurationSection("scoreboard");`
- 疑点：只有 `scoreboard` 与 `tab` **同时**缺失才告警并整体回退；只缺一段时走 `: defaults.scoreboard()`
  （第 123–125 行）静默使用出厂布局。若管理员把段名拼错大小写或缩进写坏，得到的是「出厂侧边栏照常显示」
  且日志零告警——用户以为自己的配置生效了，实际改的是一个不被读取的段。
- 置信度：LOW
- 维度：error-handling

### L6 `snapshot()` 对 `defaultWave` 直接 `.copy()`，而 `setDefaultWave` 不拒 null

- 位置：`GameConfig.java:645`
- 原文：`snap.defaultWave = this.defaultWave.copy();`
- 疑点：同类字段 `waves`/`monsters` 都是遍历拷贝（空集合也安全），只有 `defaultWave` 是无保护的解引用；
  而第 775 行的 `setDefaultWave(WaveConfig v)` 没有任何 null 守卫。该类注释（第 833–834 行）说明
  `snapshot()` 被 `ConfigManager.hasUnsavedChanges()` 周期性调用，一旦某条加载/合并路径把 `defaultWave`
  置空，就会在脏检查时抛 NPE，而不是降级为「无默认波次」。
- 置信度：MEDIUM
- 维度：error-handling

## 4. 未发现线索的方向（记录用，不构成「已审计」声明）

- 键名拼写：`display.yml` 模板 / `messages.yml` / `monsters-config.yml` 与加载器读取的键一致，未发现漂移。
- 数值夹取：`separator` 宽度、`anim` 帧数、行数上限的夹取/截断逻辑与注释一致（除 L1 的收窄问题）。
- 并发：三个文件均为纯数据模型/纯函数加载器，无共享可变静态状态、无异步路径，未发现 concurrency 线索。
- `GameConfig` 的 min/max 成对字段（`currency-drop-min/max`、`spawn-radius-min/max`）在模型层无顺序校验，
  但消费方 `WaveManager.java:857-865` 已做 `Math.max` 归一并夹到 [0,64]，未构成可利用线索。

## 5. files_read

| path | lines | 引用 |
|---|---|---|
| `src/main/java/com/hilltopvillage/config/DisplayConfig.java` | 181 | `Board board = new Board(true, DEFAULT_TITLE_KEY, DEFAULT_SCOREBOARD_REFRESH_TICKS, defaultLines());` |
| `src/main/java/com/hilltopvillage/config/DisplayConfigLoader.java` | 530 | `public static Result parse(YamlConfiguration yaml) {` |
| `src/main/java/com/hilltopvillage/config/GameConfig.java` | 945 | `snap.defaultWave = this.defaultWave.copy();` |

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "sweep-slice-12",
  "role": "sweep",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/.run-dsh3/artifacts/round1-02-sweep-slice-12.md",
  "payload": {
    "slice_id": "slice-12",
    "reachability": "PROD",
    "generator_ref": null,
    "files_read": [
      {
        "path": "src/main/java/com/hilltopvillage/config/DisplayConfig.java",
        "lines": 181,
        "quote": "        Board board = new Board(true, DEFAULT_TITLE_KEY, DEFAULT_SCOREBOARD_REFRESH_TICKS, defaultLines());"
      },
      {
        "path": "src/main/java/com/hilltopvillage/config/DisplayConfigLoader.java",
        "lines": 530,
        "quote": "    public static Result parse(YamlConfiguration yaml) {"
      },
      {
        "path": "src/main/java/com/hilltopvillage/config/GameConfig.java",
        "lines": 945,
        "quote": "        snap.defaultWave = this.defaultWave.copy();"
      }
    ],
    "files_unreadable": [],
    "leads": [
      {
        "lead_id": "L1",
        "suspected_dimension": "logic",
        "file": "src/main/java/com/hilltopvillage/config/DisplayConfigLoader.java",
        "line": 493,
        "quote": "        return clamp(number.intValue(), min, max, label, warnings);",
        "why_suspicious": "Number.intValue() 静默截断小数，且超出 int 范围的值会回绕后被夹到下限（想调慢反而变最快）",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L2",
        "suspected_dimension": "contract",
        "file": "src/main/java/com/hilltopvillage/config/DisplayConfigLoader.java",
        "line": 272,
        "quote": "        boolean blankPresent = Boolean.TRUE.equals(map.get(\"blank\"));",
        "why_suspicious": "blank: false 既不算声明行型也不参与多行型告警，整行会被当成「no line kind」丢弃",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L3",
        "suspected_dimension": "logic",
        "file": "src/main/java/com/hilltopvillage/config/DisplayConfigLoader.java",
        "line": 372,
        "quote": "        Object raw = map.get(\"when\");",
        "why_suspicious": "缺 containsKey 判定，when: 空值与缺键同走 always，fail-open 与拼错条件名 fail-closed 策略相反",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L4",
        "suspected_dimension": "contract",
        "file": "src/main/java/com/hilltopvillage/config/DisplayConfigLoader.java",
        "line": 216,
        "quote": "        String value = section.getString(key);",
        "why_suspicious": "getString 会把 Integer/Boolean 转成字符串当 i18n 键，类型写错时零告警",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L5",
        "suspected_dimension": "error-handling",
        "file": "src/main/java/com/hilltopvillage/config/DisplayConfigLoader.java",
        "line": 113,
        "quote": "        boolean hasBoard = yaml.isConfigurationSection(\"scoreboard\");",
        "why_suspicious": "只缺一段时静默用出厂默认且不告警，段名拼错会让用户以为自己的配置已生效",
        "confidence": "LOW"
      },
      {
        "lead_id": "L6",
        "suspected_dimension": "error-handling",
        "file": "src/main/java/com/hilltopvillage/config/GameConfig.java",
        "line": 645,
        "quote": "        snap.defaultWave = this.defaultWave.copy();",
        "why_suspicious": "defaultWave 无 null 守卫而 setDefaultWave 接受 null，脏检查调用 snapshot() 时可能 NPE",
        "confidence": "MEDIUM"
      }
    ],
    "lead_count": 6,
    "dimension_histogram": {
      "logic": 2,
      "concurrency": 0,
      "security": 0,
      "error-handling": 2,
      "data-consistency": 0,
      "contract": 2
    }
  },
  "error": null
}
```
