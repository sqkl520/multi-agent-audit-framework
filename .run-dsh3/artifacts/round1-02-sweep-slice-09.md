# slice-09 宽扫（HilltopTabCompleter）

- trace_id: trace-r1-20260215-hilltop-dsh3
- round_id: round1
- slice_id: slice-09
- status: COMPLETE
- 切片文件: `src/main/java/com/hilltopvillage/command/HilltopTabCompleter.java`（209 行）
- 上下文文件（1 个，同目录）: `src/main/java/com/hilltopvillage/command/HilltopCommandHandler.java`（1755 行）

## 1. 覆盖与判定

| 项 | 结果 |
|---|---|
| 数组越界（`args[args.length-1]` / 裸下标） | **未命中**：全文件没有 `args[args.length-1]` 形态；每一处 `args[1]` / `args[2]` 都被同一 `if` 的 `args.length == 2/3` 先行守卫（83/91/101/108/118/124/136/151/166/178/189/198 行），无 `args.length == 0` 时读取 `args[0]` 的路径（0 长度直接落到 207 行返回空表） |
| 子命令表 vs 分发一致性 | **命中 0 处缺项**：tab 顶层 26 项（64–66 行）与 `HilltopCommandHandler` 的 `switch (sub)` 26 个 case（188–594 行）逐项一一对应，无「能补全但无 case」或「有 case 但不补全」。deploy 的 22 个 tab 项与 deploy switch 的 22 个 case 亦一致；setup 交由 SetupWizard 拼接处理，未深究 |
| 权限过滤 | **命中 1 处不一致**：`config` 在 tab 侧归入 `hilltopvillage.admin` 组，而分发给 `config` 用的是 `hilltopvillage.config.admin`（详见 L1） |
| 返回 null vs 空 list | **命中 1 处**：仅未知命令返回 `null`，其余全部返回 `new ArrayList<>()`（详见 L3） |

## 2. 线索

### L1 — config 子命令的权限门在补全侧与分发侧不是同一个节点

tab 把 `config` 列入 `isAdmin` 名单，该名单统一用 `hilltopvillage.admin` 过滤；而 `HilltopCommandHandler` 的 `case "config"` 检查的是 `hilltopvillage.config.admin`。两个方向都可能出偏差：只持 `hilltopvillage.config.admin` 的运维看不到 `config` 补全；只持 `hilltopvillage.admin`（且该权限不继承 config.admin）的管理员能看到补全、敲下去却吃 no-permission。是否真构成缺陷取决于 `plugin.yml` 的权限继承声明（本切片未读，留待深挖）。

### L2 — top 的排行榜类型是硬编码副本，与 StatType 双源

tab 里 7 个类型键写死在 `Arrays.asList(...)`，而 `handleTopCommand` 用 `StatsManager.StatType.fromKey(args[1])` 解析，`statValue` 的 switch 又穷举了 7 个枚举常量。同一份「合法类型集合」在补全侧与解析侧各存一份，新增/改名枚举时补全表会静默失真（不报错、只是补不出或补出错项）。该方法的 javadoc 只列 6 个类型（缺 crystals），已经能看到副本漂移的迹象。

### L3 — 未知命令返回 null，与全文件其余路径的「空 list」契约不一致

`onTabComplete` 除该行外所有分支都返回 `List`（含空表）；这一支返回 `null`。Bukkit 侧 `null` 通常等价于「无补全」，故大概率不是崩溃点，但它让调用方无法区分「本插件不管这个命令」与「补全结果为空」，也让该方法出现两种返回语义。属契约一致性线索，非高危。

### L4 — `/hilltop wave <任意串> <TAB>` 仍补全竞技场 ID

第三个参数的补全只看 `args.length == 3` 与管理员权限，不校验 `args[1]` 是否为 `clear` / `skip`。分发侧对非法 action 会直接回用法提示，因此这里补出的竞技场列表对着一个注定被拒的命令前缀，属补全噪音而非执行缺陷。

## 3. 未命中维度的说明

- `concurrency`：本文件只在命令线程读 `plugin.getMultiArenaManager()...getRegistry().list()` 与 `Bukkit.getOnlinePlayers()`，无异步、无共享可变状态写入，未命中。
- `data-consistency`：本文件不写任何持久化状态，未命中。
- `error-handling`：`arenaIds` / 各补全分支均无异常吞没、无 `parseInt`、无 `valueOf`，未命中。
- `security`：补全只回显竞技场 ID 与在线玩家名，两者本就在客户端可见范围内；未发现越权数据暴露。唯一与权限相关的是 L1。
- `logic`：除 L4 外未见状态机或边界翻转问题。

## 4. 可达性

`PROD`：`HilltopTabCompleter` 是 Bukkit `TabCompleter` 实现，由插件在启用时注册到 `/hilltop`（及 `/hub`、`/lobby` 快捷命令）上，属于玩家输入的直接入口路径；`slice-09` 的唯一文件即该实现类，故整片从生产入口可达。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "sweep-slice-09",
  "role": "sweep",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/.run-dsh3/artifacts/round1-02-sweep-slice-09.md",
  "payload": {
    "slice_id": "slice-09",
    "reachability": "PROD",
    "generator_ref": null,
    "files_read": [
      {
        "path": "src/main/java/com/hilltopvillage/command/HilltopTabCompleter.java",
        "lines": 209,
        "quote": "public List<String> onTabComplete(CommandSender sender, Command command, String alias, String[] args) {"
      },
      {
        "path": "src/main/java/com/hilltopvillage/command/HilltopCommandHandler.java",
        "lines": 1755,
        "quote": "switch (sub) {"
      }
    ],
    "files_unreadable": [],
    "leads": [
      {
        "lead_id": "L1",
        "suspected_dimension": "contract",
        "file": "src/main/java/com/hilltopvillage/command/HilltopTabCompleter.java",
        "line": 70,
        "quote": "|| sub.equals(\"setup\") || sub.equals(\"deploy\") || sub.equals(\"config\")",
        "why_suspicious": "config 在此被列入统一用 hilltopvillage.admin 过滤的 isAdmin 名单，而 HilltopCommandHandler.java:389 的 case \"config\" 检查的是 hilltopvillage.config.admin，补全侧与分发侧的权限节点不一致",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L2",
        "suspected_dimension": "contract",
        "file": "src/main/java/com/hilltopvillage/command/HilltopTabCompleter.java",
        "line": 192,
        "quote": "for (String sub : Arrays.asList(\"kills\", \"wins\", \"games\", \"best-wave\", \"nodes\", \"deaths\", \"crystals\")) {",
        "why_suspicious": "top 的合法类型集合在补全侧硬编码，分发侧用 StatsManager.StatType.fromKey 解析，同一集合双源维护，枚举变更时补全会静默失真",
        "confidence": "LOW"
      },
      {
        "lead_id": "L3",
        "suspected_dimension": "contract",
        "file": "src/main/java/com/hilltopvillage/command/HilltopTabCompleter.java",
        "line": 58,
        "quote": "if (!commandName.equals(\"hilltop\")) return null;",
        "why_suspicious": "全文件其余分支一律返回 List（空表），唯此支返回 null，同一方法存在两种返回语义，调用方无法区分「不管此命令」与「补全为空」",
        "confidence": "LOW"
      },
      {
        "lead_id": "L4",
        "suspected_dimension": "logic",
        "file": "src/main/java/com/hilltopvillage/command/HilltopTabCompleter.java",
        "line": 118,
        "quote": "if (args.length == 3 && args[0].equalsIgnoreCase(\"wave\")",
        "why_suspicious": "第三参数补全只判长度与管理员权限，不校验 args[1] 是否为 clear/skip，非法 action 下仍会补出竞技场 ID",
        "confidence": "LOW"
      }
    ],
    "lead_count": 4,
    "dimension_histogram": {
      "logic": 1,
      "concurrency": 0,
      "security": 0,
      "error-handling": 0,
      "data-consistency": 0,
      "contract": 3
    }
  },
  "error": null
}
```
