# slice-25 宽扫（StatsManager 统计持久化）

- status: COMPLETE
- role: sweep
- trace_id: trace-r1-20260215-hilltop-dsh3 / round1
- 切片文件: `src/main/java/com/hilltopvillage/stats/StatsManager.java`（实测 686 物理行，686 个 LF、0 个 CR）
- 竞态/一致性主轴: 落盘频率与原子性、异步保存与主线程读写同一 map、saveAll 失败是否静默、退出 flush、跨局累积、int 溢出、top 裸下标

## 1. 这个切片在持久化上做了什么（事实）

- 写盘时机是「内存累加 → 脏标记 → 每 1200 tick 异步刷盘」（`FLUSH_PERIOD_TICKS = 1200L`，`ensureFlushTaskRunning()`），关服走 `saveNow()` → `save()` 同步写。
- 序列化(`buildSnapshot()`)留在主线程，纯文件写(`writeAtomically`)丢到异步线程；临时文件名带 `System.nanoTime()` 后缀 + `writeLock` + 单调 `writeSeq` 防「旧快照压掉新快照」。整体设计比同仓库多数管理器更谨慎。
- `cache` 是 `ConcurrentHashMap`，但 `PlayerStats` 字段本身无同步；当前所有读写（load/record/top/buildSnapshot）都在主线程，唯一跨线程共享的只有 `dirty`（volatile）、`readOnly`、`writeSeq`。
- 因此本片的可疑点集中在：损坏文件的后续覆盖路径、调用方传入值的夹取不对称、原子移动异常分支的覆盖度、`dirty` 跨线程写、`top()` 的 limit 边界、`getInt` 的静默默认值。

## 2. 可达性判定

- `StatsManager` 在 `HilltopVillagePlugin:112` 被 `new StatsManager(this)` 构造（onEnable），`record`/`recordOffline` 由 `ArenaInstance`（434/601/669/1395 行）在结算与掉线超时路径调用，`top` 由 `/hilltop top` 命令（`HilltopCommandHandler:1645`）调用，`saveNow` 由 onDisable 调用。→ **PROD**。

## 3. 线索（详见末尾 JSON）

| id | 维度 | 行 | 一句话 |
|---|---|---|---|
| L1 | data-consistency | 378 | 隔离失败仍以空缓存继续，下一轮刷盘会覆盖「被保留」的损坏文件 |
| L2 | data-consistency | 281 | 水晶/击杀等字段直接累加，未像 wave 那样夹负值 |
| L3 | error-handling | 597 | 只捕获 AtomicMoveNotSupportedException，其它移动异常原样重试 |
| L4 | concurrency | 578 | 异步线程写共享 dirty=false，可能吞掉主线程刚置的脏标记 |
| L5 | contract | 215 | subList 只夹上界不夹下界，limit 为负直接抛异常 |
| L6 | data-consistency | 407 | getInt 静默回退 0，随后整份快照把原值抹成 0 |

## 4. 明确排除 / 不构成线索的观察

- `save()` 的 `dirty=false` 在 `buildSnapshot()` 之前执行，但两者同在主线程序列执行，且写失败会在 `writeAtomically` 里把 `dirty` 置回，未见丢写路径。
- `writeAtomically` 的 `finally` 删除临时文件对成功/失败/序号放弃三条路径都成立，未见临时文件误删正式文件的路径（`tmp` 名与 `statsFile` 名不同）。
- `top()` 返回的 `subList` 是局部队列视图，调用方立即遍历，未见视图失效问题。
- 每 1200 tick 定时刷盘、崩溃最多丢 60 秒数据属注释中已声明的取舍，不作为缺陷。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "sweep-slice-25",
  "role": "sweep",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/.run-dsh3/artifacts/round1-02-sweep-slice-25.md",
  "payload": {
    "slice_id": "slice-25",
    "reachability": "PROD",
    "generator_ref": null,
    "files_read": [
      {
        "path": "src/main/java/com/hilltopvillage/stats/StatsManager.java",
        "lines": 686,
        "quote": "public void record(Player player, PlayerData data, Boolean victory, int wave) {"
      },
      {
        "path": "src/main/java/com/hilltopvillage/command/HilltopCommandHandler.java",
        "lines": 1755,
        "quote": "List<Map.Entry<UUID, StatsManager.PlayerStats>> top = stats.top(type, 10);"
      }
    ],
    "files_unreadable": [],
    "leads": [
      {
        "lead_id": "L1",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/stats/StatsManager.java",
        "line": 378,
        "quote": "boolean quarantined = quarantineCorruptFile();",
        "why_suspicious": "解析失败分支只把隔离结果用于日志措辞，隔离失败时既不置 readOnly 也不阻止后续写盘，下一轮 flushAsync 会用空缓存快照覆盖那份刚被声称「已保留」的损坏文件。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L2",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/stats/StatsManager.java",
        "line": 281,
        "quote": "stats.crystalsCollected += data.getCurrencyCollected();",
        "why_suspicious": "kills/deaths/nodes/crystals 直接累加调用方给的 int，没有像下方 wave 那样用 Math.max(0, …) 夹取，负值或超大值会原样落盘，并被 top() 的 <=0 过滤条件从榜单里静默排除。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L3",
        "suspected_dimension": "error-handling",
        "file": "src/main/java/com/hilltopvillage/stats/StatsManager.java",
        "line": 597,
        "quote": "} catch (AtomicMoveNotSupportedException fallback) {",
        "why_suspicious": "只把 AtomicMoveNotSupportedException 当作可降级信号，ATOMIC_MOVE 抛出的其它 IOException（目标被占用、FileAlreadyExistsException 等）落到外层通用 catch，只置脏后按同样参数永远重试，没有任何降级或停写判定。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L4",
        "suspected_dimension": "concurrency",
        "file": "src/main/java/com/hilltopvillage/stats/StatsManager.java",
        "line": 578,
        "quote": "dirty = false;",
        "why_suspicious": "该赋值位于 writeAtomically 的 readOnly 分支，运行在异步写线程；生产者在主线程 record() 里置 dirty=true，两个线程对同一个 volatile 标志做非原子的清/置，可能吞掉一次尚未落盘的变更标记。",
        "confidence": "LOW"
      },
      {
        "lead_id": "L5",
        "suspected_dimension": "contract",
        "file": "src/main/java/com/hilltopvillage/stats/StatsManager.java",
        "line": 215,
        "quote": "return list.subList(0, Math.min(limit, list.size()));",
        "why_suspicious": "subList 只对 limit 做了上界收敛，没有下界校验：limit 为负时 toIndex 为负，抛 IllegalArgumentException 而不是返回空列表；当前唯一调用方硬编码 10，属未被触发的边界。",
        "confidence": "LOW"
      },
      {
        "lead_id": "L6",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/stats/StatsManager.java",
        "line": 407,
        "quote": "stats.gamesPlayed = section.getInt(\"games-played\", 0);",
        "why_suspicious": "getInt 对超出 int 范围或非数字的值静默返回默认值 0，按记录包裹的 try/catch 不会触发，随后 buildSnapshot 会把 0 写回整份快照，原值被无声抹平且无任何日志。",
        "confidence": "MEDIUM"
      }
    ],
    "lead_count": 6,
    "dimension_histogram": {
      "logic": 0,
      "concurrency": 1,
      "security": 0,
      "error-handling": 1,
      "data-consistency": 3,
      "contract": 1
    }
  },
  "error": null
}
```
