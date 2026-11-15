# round1-04 fix F7：`commands.md` 改为同目录临时文件 + 原子替换

- finding_id: **F7**（LOW，error-handling）
- 修复实例: `0222220b-f7a7-4683-9819-37d52555acaf`
- 目标文件: `src/main/java/com/hilltopvillage/doc/CommandsDocumentGenerator.java`
- 新增测试: `src/test/java/com/hilltopvillage/doc/CommandsDocumentAtomicWriteTest.java`
- 备份（当前 post-F6 文件）: `.work/round1/backups/F7-before.java`
- 红测日志: `.work/round1/redlogs/F7-red.log`
- 绿测日志: `.work/round1/redlogs/F7-green.log`
- F6 回归日志: `.work/round1/redlogs/F7-f6-regression.log`
- 既有生成器测试回归日志: `.work/round1/redlogs/F7-generator-regression.log`

## 1. 缺陷

`generate()` 在 `Bukkit.getScheduler().runTaskAsynchronously(...)` 里用

```java
java.nio.file.Files.write(docFile.toPath(), content.getBytes(StandardCharsets.UTF_8));
```

直接写 `plugins/HilltopVillage/commands.md`。`Files.write` 默认 `CREATE + TRUNCATE_EXISTING + WRITE`：
打开目标的那一刻旧文档就被截断，随后才逐块写入。于是崩溃、磁盘满、权限在打开后变化、或并发读取
都会看到**空文件/半截文档**；而本类只在服务器启动时生成一次，没有重试，也没有上一版可回退。

项目已有的 `util/YamlFiles.write` 用的是「同目录唯一临时名 + `ATOMIC_MOVE` + `finally` 清理」，
本 finding 要求 `commands.md` 采用同一模式。

## 2. 复现

无需真实崩溃即可确定性复现该缺陷形态（修复前的红测）：

1. **行为层**：修复前生产代码没有临时文件、也没有可注入的移动步骤，因此无法在不改代码的前提下
   让「移动到目标」这一步失败——这本身就是缺陷的一部分：写盘只有一个不可中断的截断动作。
2. **静态层**：读取生产源码，异步块中确实存在 `Files.write(docFile`，且不存在 `ATOMIC_MOVE`。
   断言这一条会以「仍在直接截断写目标文件」失败，原因即目标缺陷。

修复后的故障注入（确定性，无 sleep、无并发竞态）：把移动步骤替换为「抛 `IOException` 的代理」，
在移动发生的那一刻读取临时文件与目标文件内容，并检查失败后的目录状态。

## 3. 红测证据

命令（Maven 互斥锁内执行）：

```
.\build.cmd -o '-Dtest=CommandsDocumentAtomicWriteTest' test
```

结果：`Tests run: 3, Failures: 3, Errors: 0, Skipped: 0`，`EXIT_CODE=1`（完整输出见 `F7-red.log`）。
三条失败原因分别是：

| 测试 | 修复前失败信息（截断） |
|---|---|
| `successfulWriteReplacesTargetAndLeavesNoTempFile` | `CommandsDocumentGenerator 缺少 writeAtomically(2 参数)` |
| `failedMoveKeepsOldDocumentAndCleansUpTempFile` | `CommandsDocumentGenerator 缺少 writeAtomically(3 参数)` |
| `asyncBlockNoLongerTruncatesTheTargetInPlace` | `异步块仍在直接 Files.write 目标 commands.md ... expected: <false> but was: <true>` |

测试用**按方法名反射**查找新 API，因此在修复前的代码上**编译通过、运行期断言失败**，
不是编译错误（红测日志中 `testCompile` 正常、surefire 实际执行了 3 条用例）。

## 4. 修法

只改目标文件，保留 F6 已做的文档字符串改动（`fix6 Y3-M-10` 注释与 `setup` 流程文案未动）：

1. 新增包内可见的 `static void writeAtomically(Path target, byte[] content)`：
   - 在目标同目录用 `Files.createTempFile` 建唯一临时文件（同目录 ⇒ 不跨分区，`ATOMIC_MOVE` 才有意义）；
   - 先把完整内容写进临时文件，再调用移动步骤；
   - `finally` 中 `Files.deleteIfExists(tmp)`；删除自身失败时 `deleteOnExit()`，不掩盖原始异常。
2. 新增包内可见的 `writeAtomically(Path, byte[], MoveStep)` 重载作为**故障注入接缝**；
   生产路径固定传 `CommandsDocumentGenerator::moveIntoPlace`。
3. `moveIntoPlace`：`Files.move(..., REPLACE_EXISTING, ATOMIC_MOVE)`；**仅**捕获
   `AtomicMoveNotSupportedException` 时降级为普通 `REPLACE_EXISTING` move，其他 `IOException` 原样上抛。
4. 异步块改为调用 `writeAtomically(docFile.toPath(), ...)`，`catch (IOException)` 与 WARNING 文案保持不变；
   父目录创建移入 helper（`Files.createDirectories`），行为等价。

净变化：生产文件 +53/-4 行（含注释与接缝），声明 `LARGE_PATCH`。文档内容、异步调度均未改动。

## 5. 绿测证据

命令（Maven 互斥锁内、先删除目标 class 强制重编译，确保跑的是修复后源码）：

```
.\build.cmd -o '-Dtest=CommandsDocumentAtomicWriteTest' test
```

结果：`Tests run: 3, Failures: 0, Errors: 0, Skipped: 0`，`BUILD SUCCESS`，`EXIT_CODE=0`；
日志中可见 `Changes detected - recompiling the module!` 与 `Compiling 75 source files`。

三条用例覆盖：

1. **成功路径**：目标先有旧内容，原子写后是完整新内容，目录里只剩 `commands.md`（临时文件已消失）。
2. **移动失败路径**：注入抛 `IOException` 的移动；在移动发生的那一刻断言
   - 源路径 ≠ 目标路径，且源与目标同目录；
   - 临时文件里已是**完整新内容**；
   - 目标此刻仍是**完整旧内容**（即没有先截断目标）；
   失败后断言旧内容逐字节不变、目录里没有 `.tmp` 残留、异常以 `IOException` 抛给调用方。
3. **源码守卫**：生产源码不再含 `Files.write(docFile`，且含 `writeAtomically(`、`ATOMIC_MOVE`、
   `AtomicMoveNotSupportedException`。

同一文件上 F6 的回归：`.\build.cmd -o '-Dtest=CommandsDocumentationCleanupClaimTest' test`
→ `Tests run: 1, Failures: 0`，`EXIT_CODE=0`（`F7-f6-regression.log`）。
既有 `CommandsDocumentGeneratorTest`（7 条，含「目标是目录时只记 WARNING 不抛异常」）→
`Tests run: 7, Failures: 0`，`EXIT_CODE=0`（`F7-generator-regression.log`）；日志中失败路径的
WARNING 显示为 `...commands.md.<tmp> -> ...commands.md`，即目标为目录时原子移动失败后仍走
`catch (IOException) → WARNING`，启动不受影响。

## 6. 影响半径

- 仅 `CommandsDocumentGenerator.generate()` 的写盘方式；生成文本、生成时机、异步调度、
  日志文案（INFO/WARNING）均未变。
- `writeAtomically` / `MoveStep` 为包内可见新 API，只在 `com.hilltopvillage.doc` 内可见；
  不涉及公共 API、不引入依赖。
- 目标为目录 / 父目录不可写等失败仍以 `IOException` 被 `catch` 成 WARNING，不会打挂插件启动
  （既有 `CommandsDocumentGeneratorTest` 的容错断言仍通过）。
- 其他写入方（`YamlFiles`、`StatsManager` 等）未触碰；F6 的文档改动保持原样。

## 7. 残余风险

- `RED_BASELINE`：修复前的红测是「按名反射找不到 `writeAtomically`」+「源码守卫命中 `Files.write(docFile`」，
  **不是**在旧代码上实际观测到半截文件。原因：旧实现没有临时文件/移动接缝，无法在不改生产代码的前提下
  注入「移动失败」。修复后该故障注入用例真实执行并通过（见绿测第 2 条）。
- `IMPACT_UNVERIFIED`：只在 Windows NTFS + 本机 JDK 21 验证；未在 Linux/POSIX 或网络文件系统上验证
  `ATOMIC_MOVE`，`AtomicMoveNotSupportedException` 降级分支未被实际触发（无对应测试）。
- `IMPACT_UNVERIFIED`：故障注入覆盖「移动失败」，未覆盖「写临时文件阶段失败」（该路径按代码结构
  不会触碰目标文件，但没有专门用例）；也未做真实磁盘满/进程崩溃演练。
- `IMPACT_UNVERIFIED`：未对同一目标的两个并发 `generate()` 做压力测试；临时文件名由
  `Files.createTempFile` 保证唯一，理论上安全但未实测。
- F6 与本 finding 共享 `CommandsDocumentGenerator.java`；本次 diff 已核对为仅 F7 变更
  （以 `backups/F7-before.java` 为基线），F6 的回归测试通过。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "0222220b-f7a7-4683-9819-37d52555acaf",
  "role": "fix",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "<TARGET_REPO>/.work/round1/round1-04-fix-7.md",
  "payload": {
    "finding_id": "F7",
    "disposition": "FIXED",
    "test_path": "src/test/java/com/hilltopvillage/doc/CommandsDocumentAtomicWriteTest.java",
    "red_log_path": ".work/round1/redlogs/F7-red.log",
    "files_touched": [
      {
        "path": "src/main/java/com/hilltopvillage/doc/CommandsDocumentGenerator.java",
        "change_summary": "commands.md 写盘由直接 Files.write 改为 writeAtomically：同目录临时文件 + ATOMIC_MOVE（仅 AtomicMoveNotSupportedException 降级），失败保留旧目标并在 finally 清理临时文件；新增包内可见的移动接缝供故障注入。保留 F6 的文档改动。"
      },
      {
        "path": "src/test/java/com/hilltopvillage/doc/CommandsDocumentAtomicWriteTest.java",
        "change_summary": "新增 3 条测试：成功路径整份替换且无临时文件残留；注入移动 IOException 时旧文档在移动瞬间与失败后均保持不变、临时文件被清理、异常上抛；源码守卫禁止直接 Files.write(docFile 并要求 ATOMIC_MOVE。测试按方法名反射，修复前编译通过、断言失败。"
      }
    ],
    "verification_commands": [
      {
        "command": ".\\build.cmd -o '-Dtest=CommandsDocumentAtomicWriteTest' test (修复前, mutex)",
        "result": "failed",
        "output_snippet": "Tests run: 3, Failures: 3, Errors: 0, Skipped: 0; EXIT_CODE=1"
      },
      {
        "command": ".\\build.cmd -o '-Dtest=CommandsDocumentAtomicWriteTest' test (修复后强制重编译, mutex)",
        "result": "passed",
        "output_snippet": "Changes detected - recompiling the module!; Tests run: 3, Failures: 0, Errors: 0, Skipped: 0; BUILD SUCCESS; EXIT_CODE=0"
      },
      {
        "command": ".\\build.cmd -o '-Dtest=CommandsDocumentationCleanupClaimTest' test (F6 同文件回归, mutex)",
        "result": "passed",
        "output_snippet": "Tests run: 1, Failures: 0, Errors: 0, Skipped: 0; BUILD SUCCESS; EXIT_CODE=0"
      },
      {
        "command": ".\\build.cmd -o '-Dtest=CommandsDocumentGeneratorTest' test (既有生成器行为回归, mutex)",
        "result": "passed",
        "output_snippet": "Tests run: 7, Failures: 0, Errors: 0, Skipped: 0; BUILD SUCCESS; EXIT_CODE=0"
      }
    ],
    "affected_issues": [],
    "residual_risks": [
      "RED_BASELINE: 修复前红测为「反射找不到 writeAtomically」+「源码守卫命中 Files.write(docFile」，不是在旧代码上实际观测到半截文件；旧实现没有临时文件/移动接缝，无法在不改生产代码的前提下注入移动失败。修复后故障注入用例真实执行并通过：移动瞬间目标仍为完整旧内容，失败后旧内容不变且无临时文件残留。",
      "LARGE_PATCH: 生产文件净增约 53 行（含注释与故障注入接缝），超过 ≤10 行建议阈值；这是同目录临时文件 + 原子移动 + 仅对 AtomicMoveNotSupportedException 降级 + 接缝的最小完整形态。",
      "IMPACT_UNVERIFIED: 仅在 Windows NTFS + 本机 JDK 21 验证；未在 Linux/POSIX 或网络文件系统验证 ATOMIC_MOVE，AtomicMoveNotSupportedException 降级分支未被实际触发。",
      "IMPACT_UNVERIFIED: 故障注入只覆盖「移动失败」，未覆盖「写临时文件阶段失败」与真实磁盘满/进程崩溃；前者按代码结构不会触碰目标，但无用例。",
      "IMPACT_UNVERIFIED: 未对同一目标的两个并发 generate() 做压力测试；临时文件名由 Files.createTempFile 保证唯一但未实测。",
      "F6 与本 finding 共享 CommandsDocumentGenerator.java；diff 以 backups/F7-before.java 为基线核对为仅 F7 变更，F6 的 CommandsDocumentationCleanupClaimTest 通过（.work/round1/redlogs/F7-f6-regression.log）。"
    ]
  },
  "error": null
}
```
