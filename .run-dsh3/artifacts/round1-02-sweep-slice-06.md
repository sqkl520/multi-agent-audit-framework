# slice-06 宽扫

- status: COMPLETE
- trace_id: trace-r1-20260215-hilltop-dsh3
- round_id: round1
- slice_id: slice-06
- 被审仓库: `D:\Server\MCServers\Server plugin\Hilltop Village\Hilltop Village Plugin`（只读）

## Scope / reachability

本切片 4 个文件均已读。生产可达性为 `PROD`：`ArenaManager` 由 `MultiArenaManager` 构造函数实例化（`new ArenaManager(plugin)`），而 `MultiArenaManager` 由插件主类 `HilltopVillagePlugin` 在启动流程中创建；`ArenaRegistry` / `ArenaStatus` / `IArena` 均在该竞技场定义与运行时链路上被引用。

## Leads（5）

| lead_id | dimension | file:line | confidence | 摘要 |
|---|---|---|---|---|
| L1 | data-consistency | ArenaManager.java:836 | MEDIUM | 大小写不敏感的首个 YAML 键可能与实际注册的键不同 |
| L2 | error-handling | ArenaManager.java:869 | MEDIUM | 非数值坐标可能被 getDouble 默认为 0.0 而通过校验 |
| L3 | logic | ArenaManager.java:563 | MEDIUM | 损坏的 waiting-location 会覆盖 core 默认回退为 null |
| L4 | contract | ArenaRegistry.java:27 | MEDIUM | get(null) 与 get(空白) 的异常语义不一致 |
| L5 | data-consistency | ArenaManager.java:374 | MEDIUM | lobby.spawn 坐标未经有限性校验即进入 Location/传送路径 |

## 说明

- 仅做宽扫，不判严重性，不构造完整证据链。
- `ArenaStatus` 的枚举与 `IArena` 的接口声明未发现独立可疑点，仅作为切片覆盖记录。
- `ArenaManager` 中确有大量防御性校验与“重读盘再写”的注释；上述线索集中在这些防护未覆盖的边界。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "sweep-slice-06",
  "role": "sweep",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/.run-dsh3/artifacts/round1-02-sweep-slice-06.md",
  "payload": {
    "slice_id": "slice-06",
    "reachability": "PROD",
    "generator_ref": null,
    "files_read": [
      {
        "path": "src/main/java/com/hilltopvillage/arena/ArenaManager.java",
        "lines": 907,
        "quote": "public String validationFailure(ArenaDefinition definition) {"
      },
      {
        "path": "src/main/java/com/hilltopvillage/arena/ArenaRegistry.java",
        "lines": 87,
        "quote": "public ArenaDefinition get(String id) {"
      },
      {
        "path": "src/main/java/com/hilltopvillage/arena/ArenaStatus.java",
        "lines": 39,
        "quote": "public enum ArenaStatus {"
      },
      {
        "path": "src/main/java/com/hilltopvillage/arena/IArena.java",
        "lines": 193,
        "quote": "public interface IArena {"
      }
    ],
    "files_unreadable": [],
    "leads": [
      {
        "lead_id": "L1",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/arena/ArenaManager.java",
        "line": 836,
        "quote": "if (candidate.equalsIgnoreCase(arenaId)) return candidate;",
        "why_suspicious": "findArenaKey 返回首个大小写不敏感匹配，而 load() 只注册通过 ARENA_ID 校验的小写键；同一 ID 的大小写变体并存时，写入可能落到被 load() 跳过的 YAML 节点。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L2",
        "suspected_dimension": "error-handling",
        "file": "src/main/java/com/hilltopvillage/arena/ArenaManager.java",
        "line": 869,
        "quote": "double value = section.getDouble(key);",
        "why_suspicious": "requiredDouble 只用 isSet 判断存在，随后 getDouble 对非数值标量取默认 0.0，损坏坐标会被静默当成合法 (0,0,0) 而不是报错。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L3",
        "suspected_dimension": "logic",
        "file": "src/main/java/com/hilltopvillage/arena/ArenaManager.java",
        "line": 563,
        "quote": "waitingLocation = readOptionalLocation(",
        "why_suspicious": "waiting-location 段存在但解析失败时 readOptionalLocation 返回 null，覆盖了上一行以 core 作默认值的回退，可能让等待区变成 null。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L4",
        "suspected_dimension": "contract",
        "file": "src/main/java/com/hilltopvillage/arena/ArenaRegistry.java",
        "line": 27,
        "quote": "return id == null ? null : arenas.get(normalizeId(id));",
        "why_suspicious": "同一个 public get 对 null 返回 null，但对空串/空白抛 IllegalArgumentException，调用方若只判 null 会被异常穿透。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L5",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/arena/ArenaManager.java",
        "line": 374,
        "quote": "double x = spawn.getDouble(\"x\", world.getSpawnLocation().getX());",
        "why_suspicious": "lobby.spawn 坐标直接 getDouble 后构造 Location，未像竞技场坐标那样校验 isFinite，YAML 中 .NaN/.inf 可进入传送路径。",
        "confidence": "MEDIUM"
      }
    ],
    "lead_count": 5,
    "dimension_histogram": {
      "logic": 1,
      "concurrency": 0,
      "security": 0,
      "error-handling": 1,
      "data-consistency": 2,
      "contract": 1
    }
  },
  "error": null
}
```
