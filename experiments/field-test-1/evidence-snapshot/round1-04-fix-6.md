# F6 修复记录：删除 `/hilltop tps` 文档中不存在的 DisplayEntity 清理队列

## 1. 缺陷与证据

- **finding_id**: F6（LOW，data-consistency）
- **target_file**: `src/main/java/com/hilltopvillage/doc/CommandsDocumentGenerator.java`
- **原始证据行**: 189
- **缺陷**: 自动生成的命令文档在 `/hilltop tps` 的「注意事项」中声称输出包含 `DisplayEntity 清理队列`。

核对结果：

1. `TpsDiagnostic#printDiagnostic`（`src/main/java/com/hilltopvillage/diagnostic/TpsDiagnostic.java:46-106`）实际只输出 TPS/MSPT、游戏状态、在线/对局玩家、波次、怪物、节点、世界实体/区块计数与内存；没有 DisplayEntity 清理队列。
2. `DisplayEntityManager` 类注释（`src/main/java/com/hilltopvillage/util/DisplayEntityManager.java:9-10`）明确写明：「原类中的锤击巨物展示与 DisplayEntity 清理队列整链为零调用死代码，已随本轮删除」。
3. 因此生成文档中的该项属于过期描述，会让管理员按文档排查一个不存在的输出项。

## 2. 复现与红测

新增测试文件：

`src/test/java/com/hilltopvillage/doc/CommandsDocumentationCleanupClaimTest.java`

测试通过 `BareHost` 调用 `CommandsDocumentGenerator.generate()`，等待异步写出的 `commands.md` 稳定后读取全文；先断言 `/hilltop tps` 段存在，再断言全文不包含 `DisplayEntity 清理队列`。测试在修复前代码上可以编译，失败原因是对目标文案的断言，而不是编译/环境错误。

红测命令（在共享 Maven 互斥锁内执行）：

```text
.\build.cmd -o '-Dtest=CommandsDocumentationCleanupClaimTest' test
```

红测结果：

```text
[ERROR] Tests run: 1, Failures: 1, Errors: 0, Skipped: 0
org.opentest4j.AssertionFailedError: 生成的 /hilltop tps 文档仍声称输出「DisplayEntity 清理队列」...
==> expected: <false> but was: <true>
[build.cmd] Maven exit code=1
EXIT_CODE=1
```

完整日志：`.work/round1/redlogs/F6-red.log`

## 3. 修法

只修改 `CommandsDocumentGenerator.java` 的 `/hilltop tps` 注意事项字符串：

```text
- 怪物、节点、DisplayEntity 清理队列、各世界实体/区块计数
+ 怪物、节点、各世界实体/区块计数
```

未替换成新项目，因为其余当前输出项在同一句中已经逐项列出；直接删除过期项是满足要求的最小安全修复。未改动 `TpsDiagnostic`、`DisplayEntityManager`，也未触碰 `CommandsDocumentGenerator` 的异步写盘链路。

## 4. 绿测证据

同一测试、同一命令，修复后结果：

```text
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0
[INFO] BUILD SUCCESS
[build.cmd] Maven exit code=0
EXIT_CODE=0
```

完整日志：`.work/round1/redlogs/F6-green.log`

## 5. 影响半径

- 生产代码变更：1 个文件、1 行内的 1 个字符串片段删除。
- 行为影响：下一次 `commands.md` 生成后，`/hilltop tps` 文档不再列出已删除的清理队列；TPS 的实际输出行为不变。
- 未触碰：`TpsDiagnostic.java`、`DisplayEntityManager.java`、异步写盘路径、其他 finding 的生产代码、已有测试、`state.json`、`.git`。
- `F7` 与本 finding 共享 `CommandsDocumentGenerator.java`，因此列入 `affected_issues` 供验收波复核；但本修复只改了第 189 行的文档文本，F7 的异步写盘路径（约第 436-446 行）未改动。

## 6. 残余风险

- `IMPACT_UNVERIFIED`：已通过生成文档的行为测试验证目标文案消失，但未运行完整的 `/hilltop tps` 运行时集成测试；生产差异仅为文档字符串，不包含 TPS 输出逻辑。
- 文档字符串是硬编码文本，本次只移除了 F6 指定的过期项；未复查整份文档的其他内容，避免扩大修复范围。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "1a7e6733-0658-4996-9ae8-dc7e62f58417",
  "role": "fix",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "<TARGET_REPO>/.work/round1/round1-04-fix-6.md",
  "payload": {
    "finding_id": "F6",
    "disposition": "FIXED",
    "test_path": "src/test/java/com/hilltopvillage/doc/CommandsDocumentationCleanupClaimTest.java",
    "red_log_path": ".work/round1/redlogs/F6-red.log",
    "files_touched": [
      {
        "path": "src/main/java/com/hilltopvillage/doc/CommandsDocumentGenerator.java",
        "change_summary": "删除 /hilltop tps 文档注意事项中已不存在的「DisplayEntity 清理队列」文案，仅改文档字符串。"
      },
      {
        "path": "src/test/java/com/hilltopvillage/doc/CommandsDocumentationCleanupClaimTest.java",
        "change_summary": "新增行为测试：生成 commands.md 并断言 /hilltop tps 段存在且不包含 DisplayEntity 清理队列。"
      }
    ],
    "verification_commands": [
      {
        "command": ".\\build.cmd -o '-Dtest=CommandsDocumentationCleanupClaimTest' test",
        "result": "failed",
        "output_snippet": "[ERROR] Tests run: 1, Failures: 1, Errors: 0, Skipped: 0; expected: <false> but was: <true>; EXIT_CODE=1"
      },
      {
        "command": ".\\build.cmd -o '-Dtest=CommandsDocumentationCleanupClaimTest' test",
        "result": "passed",
        "output_snippet": "[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0; BUILD SUCCESS; EXIT_CODE=0"
      }
    ],
    "affected_issues": [
      "F7"
    ],
    "residual_risks": [
      "IMPACT_UNVERIFIED: 已验证生成文档不再包含目标文案，但未运行 /hilltop tps 的完整运行时集成测试；生产差异仅为文档字符串，不涉及 TPS 输出逻辑。",
      "F7 与本 finding 共享 CommandsDocumentGenerator.java；其异步写盘路径未被本次修改触碰，验收波无需将 F6 的文档改动视为 F7 的行为变更。"
    ]
  },
  "error": null
}
```
