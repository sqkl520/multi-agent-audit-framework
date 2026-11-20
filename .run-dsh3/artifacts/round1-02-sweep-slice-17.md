# slice-17 宽扫（sweep）

- trace_id: trace-r1-20260215-hilltop-dsh3
- round_id: round1
- slice_id: slice-17
- files[]: `src/main/java/com/hilltopvillage/diagnostic/TpsDiagnostic.java`（119 行，已全文读取）
- shared_dependencies[]: 无
- reachability_hint: PROD
- 结论：`reachability = PROD`；线索 7 条（error-handling 4 / contract 2 / logic 1）

## 1. 切片概况

`TpsDiagnostic` 是 `/htv tps` 一类诊断子命令的渲染器：读 `Bukkit.getTPS()`、`Bukkit.getAverageTickTime()`、
当前竞技场的 `GameManager`（波次 / 怪物数 / 节点数）、各世界实体与已加载区块数、JVM 内存，然后按语言文件
逐行 `sendMessage`。整文件无共享可变状态、无线程/异步、无文件或网络 IO，因此 `concurrency` 与
`data-consistency` 两个维度在本切片没有命中点（不硬凑线索）。

可达性判定依据（浅层检查，非完整 import 闭包）：`grep TpsDiagnostic` 在 `src/main` 下命中
`command/HilltopCommandHandler.java:49`（字段声明）、`:121`（`new TpsDiagnostic(plugin, lang)` 构造），
即由生产命令处理器实例化；测试侧另有 `src/test/.../TpsDiagnosticTest.java`。故标 `PROD`。

## 2. 逐维度快扫

| 维度 | 命中 | 说明 |
|---|---|---|
| `error-handling` | 4 | 链式 getter 未判空（waveManager / nodeSystem）；`catch (NoSuchMethodError) {}` 空吞导致 `tileEntities` 静默为 0；入口处 Paper 专有 API 无可用性保护 |
| `contract` | 2 | `tps[0..2]` 裸下标无长度校验；`resolveArena(null, player)` 以 null 作选择器传入 |
| `logic` | 1 | `formatTps` 的 `Math.min` 未处理 NaN/负值边界 |
| `concurrency` | 0 | 无 `async`/`Executor`/`synchronized`；全部在命令线程同步执行 |
| `data-consistency` | 0 | 无持久化、无缓存副本 |
| `security` | 0 | 权限校验不在本文件（在命令处理器），本文件不接触路径/权限判断 |

## 3. 线索（leads）

### L1 · error-handling · line 63
`gameManager != null` 只保护了第一层，随后直接调用 `getWaveManager().getRemainingMobCount()`；
若竞技场处于等待/结算态而 waveManager 尚未装配，链式调用会抛 NPE，整条诊断输出中断。

### L2 · error-handling · line 65
同上形态：`getNodeSystem()` 连续调用两次且无判空，两处都可能 NPE，且第二个调用点重复取同一对象。

### L3 · error-handling · line 77
`catch (NoSuchMethodError ignored) {}` 空吞异常，`tileEntities` 保持第 74 行的初值 0 并作为真实值打印，
运维侧无法区分「该版本没有此 API」与「真的 0 个方块实体」。

### L4 · error-handling · line 47
入口处直接调用 Paper 专有 API `Bukkit.getTPS()` / `getAverageTickTime()`，无任何可用性保护；
而同文件第 76 行却对另一个 Paper API `getTileEntityCount()` 做了 `NoSuchMethodError` 兜底——
同一文件内 API 可用性防御不一致，在非 Paper 服务端上整条命令会在第一行就失败。

### L5 · contract · line 53
`tps[0] / tps[1] / tps[2]` 裸下标，未见对返回数组长度的校验（第 47 行只接收引用）。
当前 Paper 实现固定返回长度 3，属低风险约定依赖，但一旦契约变化即 `ArrayIndexOutOfBoundsException`。

### L6 · logic · line 117
`Math.min(tps, 20.0)` 对 NaN 与负值都不设边界：NaN 参与比较全为 false 落到 RED 分支并原样格式化出 `NaN`；
负值被夹到负 TPS 显示。数值边界（NaN/负数）未处理。

### L7 · contract · line 26
`resolveArena(null, player)` 以 `null` 作为竞技场选择器传入，语义依赖被调方对 null 的约定；
若实现内直接解引用该参数则 NPE。属跨文件契约依赖，需深挖确认被调方是否接受 null。

## 4. 覆盖与自检

- 切片文件 1/1 已全文读取（`read`，119 行），无 `files_unreadable`。
- 未读切片外文件；可达性仅用 1 次 `grep`（不构成文件读取，未计入 `files_read`）。
- 零写入被审仓库；本产物是唯一写入。
- 按任务书 §7.5.6 配额：线索上限 8，实产 7 条。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "sweep-slice-17",
  "role": "sweep",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:\\Projects\\AI prompt\\many-agents_multi-prompt-files_token-heavy\\multi-agent-audit-framework\\.run-dsh3\\artifacts\\round1-02-sweep-slice-17.md",
  "payload": {
    "slice_id": "slice-17",
    "reachability": "PROD",
    "generator_ref": null,
    "files_read": [
      {
        "path": "src/main/java/com/hilltopvillage/diagnostic/TpsDiagnostic.java",
        "lines": 119,
        "quote": "public void printDiagnostic(CommandSender sender) {"
      }
    ],
    "files_unreadable": [],
    "leads": [
      {
        "lead_id": "L1",
        "suspected_dimension": "error-handling",
        "file": "src/main/java/com/hilltopvillage/diagnostic/TpsDiagnostic.java",
        "line": 63,
        "quote": "sender.sendMessage(msg(sender, \"tps.mobs\", gameManager.getWaveManager().getRemainingMobCount()));",
        "why_suspicious": "gameManager 判空后仍直接链式调用 getWaveManager()，未判空即取剩余怪物数。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L2",
        "suspected_dimension": "error-handling",
        "file": "src/main/java/com/hilltopvillage/diagnostic/TpsDiagnostic.java",
        "line": 65,
        "quote": "gameManager.getNodeSystem().getActiveCount(), gameManager.getNodeSystem().getTotalCount()));",
        "why_suspicious": "getNodeSystem() 未判空且同一行重复取两次，空指针风险与冗余调用并存。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L3",
        "suspected_dimension": "error-handling",
        "file": "src/main/java/com/hilltopvillage/diagnostic/TpsDiagnostic.java",
        "line": 77,
        "quote": "} catch (NoSuchMethodError ignored) {}",
        "why_suspicious": "空 catch 吞掉 NoSuchMethodError，第 74 行初值 0 会被当作真实方块实体数输出。",
        "confidence": "HIGH"
      },
      {
        "lead_id": "L4",
        "suspected_dimension": "error-handling",
        "file": "src/main/java/com/hilltopvillage/diagnostic/TpsDiagnostic.java",
        "line": 47,
        "quote": "double[] tps = Bukkit.getTPS();",
        "why_suspicious": "入口直接调用 Paper 专有 API 且无可用性保护，与第 76 行对同类 API 的兜底不一致。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L5",
        "suspected_dimension": "contract",
        "file": "src/main/java/com/hilltopvillage/diagnostic/TpsDiagnostic.java",
        "line": 53,
        "quote": "formatTps(tps[0]), formatTps(tps[1]), formatTps(tps[2])));",
        "why_suspicious": "对 getTPS() 返回值做裸下标访问，未见数组长度校验。",
        "confidence": "LOW"
      },
      {
        "lead_id": "L6",
        "suspected_dimension": "logic",
        "file": "src/main/java/com/hilltopvillage/diagnostic/TpsDiagnostic.java",
        "line": 117,
        "quote": "return color + String.format(\"%.1f\", Math.min(tps, 20.0));",
        "why_suspicious": "数值夹取只封上界，未处理 NaN 与负值，NaN 会落到 RED 分支并被格式化为 \"NaN\"。",
        "confidence": "LOW"
      },
      {
        "lead_id": "L7",
        "suspected_dimension": "contract",
        "file": "src/main/java/com/hilltopvillage/diagnostic/TpsDiagnostic.java",
        "line": 26,
        "quote": "ArenaInstance arena = plugin.getMultiArenaManager().resolveArena(null, player);",
        "why_suspicious": "以 null 作为竞技场选择器传入 resolveArena，语义依赖被调方对 null 的约定。",
        "confidence": "LOW"
      }
    ],
    "lead_count": 7,
    "dimension_histogram": {
      "logic": 1,
      "concurrency": 0,
      "security": 0,
      "error-handling": 4,
      "data-consistency": 0,
      "contract": 2
    }
  },
  "error": null
}
```
