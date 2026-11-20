# slice-18 宽扫 — CommandsDocumentGenerator

- trace_id: trace-r1-20260215-hilltop-dsh3
- round_id: round1
- slice_id: slice-18
- agent_id: sweep-slice-18
- 切片文件: `src/main/java/com/hilltopvillage/doc/CommandsDocumentGenerator.java`（597 行，单文件切片）
- shared_dependencies: 无
- reachability: **PROD**

## 1. 这片代码是什么

一个「运行时命令文档生成器」：把整份 `commands.md` 的 Markdown 文本以 400+ 次
`StringBuilder.append` 硬编码在 Java 里（第 59–463 行），然后在
`Bukkit.getScheduler().runTaskAsynchronously` 里做一次「临时文件 → 写满 → 移动 → 清理」
的原子落盘（第 465–477 行）。写盘工具方法 `writeAtomically` / `moveIntoPlace` 是包内可见的
可注入接缝（第 510–584 行），带 `static ReentrantLock` 串行化与「原子移动不支持时降级为非原子
替换」的分支。

## 2. 可达性判断（PROD）

- 派发时 `reachability_hint: PROD`，本片不再做完整 import 闭包（那是侦察波职责）。
- 文件内可自证它是被调度器接管的运行时代码，而不是死代码或测试夹具：入口方法 `generate()`
  内部直接向 Bukkit 调度器提交异步任务（第 467 行），说明它由插件生命周期在启动时调用；
  类注释也把它定位为「启动时异步写出 commands.md」。
- 未标 `GENERATED`：文件头是手写 javadoc 与包声明，没有「勿手改 / DO NOT EDIT / 自动生成」
  标记（注意区分：它**生成**别人，自身不是生成产物）。

## 3. 六维度快扫结论

| 维度 | 本片观察 | 是否有 lead |
|---|---|---|
| `concurrency` | 异步任务只碰文件 IO 与 logger，**没有**触碰 Bukkit 世界状态（方块/实体/玩家/计分板/背包/传送），这一点是干净的；可疑处在于锁的作用域只是 JVM 进程级 | 1（L1） |
| `data-consistency` | 主路径（ATOMIC_MOVE）确实整份替换；降级路径是「先删目标再改名」，失败即新旧都没有 | 1（L5） |
| `error-handling` | `generate()` 只 catch `IOException`；`moveIntoPlace` 只 catch `AtomicMoveNotSupportedException`；`parent` 为 null 时会走到 NPE 而不是 IOException | 2（L2、L3） |
| `contract` | `generate()` 是 fire-and-forget，无返回值/无 Future，调用方拿不到「文档是否已就绪」 | 1（L4） |
| `logic` | 临时文件名拼接、finally 清理、双重 `try/finally` 的嵌套顺序都自洽，未看到 off-by-one 或集合遍历删除 | 0 |
| `security` | 路径来自 `plugin.getDataFolder()` 常量拼 `commands.md`，无玩家输入进路径；无经济数值；无权限判定代码 | 0 |

补充：本片全部是文档正文（几十条 `md.append("### ...")`）与写盘逻辑，**没有命令解析、没有
`args.length`、没有 `Integer.parseInt`、没有 GUI 点击**，所以「本仓库 6 维度扫法」里
`contract` 一栏的输入校验类重点在本片不适用——不是因为查过没问题，而是本片没有这类代码。

## 4. 覆盖记账

| 文件 | 行数 | 读取方式 | 一条原文短引 |
|---|---|---|---|
| `src/main/java/com/hilltopvillage/doc/CommandsDocumentGenerator.java` | 597 | `read` 全文（1–597） | `static void writeAtomically(Path target, byte[] content) throws IOException {` |

- `files_unreadable`: 无。
- 未读切片外文件（未做上下文补读）：本片的写盘接缝与调用方都在同一文件内，判断不需要外部文件。

## 5. 线索（详细）

### L1 — `WRITE_LOCK` 只串行化同一 JVM，跨进程共享数据目录时降级路径会互相删文件

`WRITE_LOCK` 是 `static`，类注释自己也写明是「进程级 static 锁」（第 28 行）。它保证的是
**同一 JVM 内**不会有两个线程各自建临时文件、各自 move。但 `commands.md` 落在
`plugin.getDataFolder()` 下的**数据目录**，而数据目录完全可能被两个服务端进程共享
（SMB 网络盘、同一台机的两份 server 指向同一 plugin 目录、备份/同步工具）。该场景下锁失效，
且两进程若都落到非原子降级分支（先在 Windows 上删目标再改名），重叠窗口里会真的丢文件。
本片不判严重性，只记录这个作用域缺口。

### L2 — 降级分支只认 `AtomicMoveNotSupportedException`，更宽的 `UnsupportedOperationException` 会绕过兜底

`moveIntoPlace` 的 catch 类型收得很窄。`Files.move` 的契约里，选项不受支持时抛的是
`UnsupportedOperationException`（RuntimeException），而「不能作为原子操作执行」才抛
`AtomicMoveNotSupportedException`。部分 provider（尤其网络盘/自定义 FS）把 ATOMIC_MOVE
当作「不支持的选项」上报时，异常不会进 catch，降级移动与那条 WARNING 都不会发生；它也不是
`IOException`，于是 `generate()` 第 473 行的 catch 同样接不住，异步任务直接死掉，
`commands.md` 静默缺失且日志里没有任何记录。

### L3 — `parent` 为 null 时 `createTempFile(null, ...)` 抛 NPE，不在任何 catch 的射程内

第 525–530 行：`absoluteTarget = target.toAbsolutePath()`，随后只在 `parent != null` 时才
建目录，但紧接着无条件把 `parent` 传给 `createTempFile`。当目标路径没有父目录（`toAbsolutePath()`
落在文件系统根，或 path 形如单段根路径）时，`Files.createTempFile(null, ...)` 抛 NPE。
NPE 不是 `IOException`，第 473 行的 catch 接不住，异步任务终止且无日志。触发面很窄
（生产路径是 `dataFolder/commands.md`，正常有父目录），属于健壮性缺口而非当前必现缺陷。

### L4 — `generate()` 是 fire-and-forget，调用方无法知道文档何时可读

`generate()` 把整段落盘丢进 `runTaskAsynchronously` 后立即返回 `void`。这意味着：
（a）调用方（启动流程/reload 流程）无法判断 `commands.md` 是否已经写出；
（b）服务器若在异步任务真正执行前关闭，`runTaskAsynchronously` 提交的任务会被调度器取消，
`commands.md` 这一次启动就是没有更新——而外部观察者看到的只是「文件时间戳比启动时间旧」，
没有任何错误信号。若下游有「启动后读取该文档」的消费方（文档站、运维脚本），这是一个
时序契约缺口。

### L5 — 降级路径「先删目标再改名」，失败时新旧文档同时消失，只留一条 WARNING

第 576 行的非原子 `Files.move(REPLACE_EXISTING)` 在 Windows 上实现为
`DeleteFile(target)` 后再 `MoveFileEx`。若改名失败，旧 `commands.md` 已被删除、新文件还在
临时路径上，而第 534–544 行的 `finally` 又会把临时文件删掉——净结果是**两份都没了**。
javadoc 第 485–502 行诚实地承认了这一点，并说明「不做备份还原，因为在不支持原子替换的
文件系统上还原本身也只能靠非原子写」。这是一条被显式接受的取舍，仍然值得深挖确认：
该取舍的兜底只有一条 WARNING，而文档丢失后运维看到的现象是「文件不存在」，与「首次启动
还没生成」不可区分。

## 6. 不做的事（本波边界）

- 未判严重性（L1–L5 都不带 severity）。
- 未做完整证据链、未给 `alternatives`、未验证运行时行为——这些是二B 深挖的职责。
- 未跨文件核对文档正文与 `plugin.yml` usage / README 是否一致：那需要读切片外文件，
  本片配额内不做，留给深挖波按 `contract` 维度处理。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "sweep-slice-18",
  "role": "sweep",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:\\Projects\\AI prompt\\many-agents_multi-prompt-files_token-heavy\\multi-agent-audit-framework\\.run-dsh3\\artifacts\\round1-02-sweep-slice-18.md",
  "payload": {
    "slice_id": "slice-18",
    "reachability": "PROD",
    "generator_ref": null,
    "files_read": [
      {
        "path": "src/main/java/com/hilltopvillage/doc/CommandsDocumentGenerator.java",
        "lines": 597,
        "quote": "static void writeAtomically(Path target, byte[] content) throws IOException {"
      }
    ],
    "files_unreadable": [],
    "leads": [
      {
        "lead_id": "L1",
        "suspected_dimension": "concurrency",
        "file": "src/main/java/com/hilltopvillage/doc/CommandsDocumentGenerator.java",
        "line": 523,
        "quote": "WRITE_LOCK.lock();",
        "why_suspicious": "串行化只覆盖同一 JVM（static 锁），数据目录被两个服务端进程共享时，非原子降级路径上的两次替换会互相删除对方的目标文件。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L2",
        "suspected_dimension": "error-handling",
        "file": "src/main/java/com/hilltopvillage/doc/CommandsDocumentGenerator.java",
        "line": 568,
        "quote": "} catch (AtomicMoveNotSupportedException fallback) {",
        "why_suspicious": "catch 只认 AtomicMoveNotSupportedException；provider 若以 UnsupportedOperationException 上报 ATOMIC_MOVE 不可用，则既不走降级也不被外层 IOException catch 接住，任务静默死亡。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L3",
        "suspected_dimension": "error-handling",
        "file": "src/main/java/com/hilltopvillage/doc/CommandsDocumentGenerator.java",
        "line": 530,
        "quote": "Path tmp = Files.createTempFile(parent, absoluteTarget.getFileName() + \".\", \".tmp\");",
        "why_suspicious": "parent 为 null 时这里抛 NPE，而 NPE 不是 IOException，第 473 行的 catch 接不住，异步任务终止且无日志。",
        "confidence": "LOW"
      },
      {
        "lead_id": "L4",
        "suspected_dimension": "contract",
        "file": "src/main/java/com/hilltopvillage/doc/CommandsDocumentGenerator.java",
        "line": 467,
        "quote": "Bukkit.getScheduler().runTaskAsynchronously(plugin, () -> {",
        "why_suspicious": "generate() 提交异步任务后立即返回 void，调用方与下游消费者都无从判断 commands.md 何时可读；启动即关闭时任务会被取消而不留错误信号。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L5",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/doc/CommandsDocumentGenerator.java",
        "line": 576,
        "quote": "Files.move(source, target, StandardCopyOption.REPLACE_EXISTING);",
        "why_suspicious": "降级路径在 Windows 上先删目标再改名，改名失败时旧文档已删、临时文件又被 finally 清理，净结果是两份都没有，只留一条 WARNING。",
        "confidence": "MEDIUM"
      }
    ],
    "lead_count": 5,
    "dimension_histogram": {
      "logic": 0,
      "concurrency": 1,
      "security": 0,
      "error-handling": 2,
      "data-consistency": 1,
      "contract": 1
    }
  },
  "error": null
}
```
