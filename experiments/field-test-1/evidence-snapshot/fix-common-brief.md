# round1 修复实例通用任务书

你是**一个**独立修复实例，只处理一个 `finding_id`。不得顺带修其他 finding，不得合并实例。

## 环境

- 被审仓库（同时是唯一可写工作区）：`<TARGET_REPO>`
- 产物根：`<REPO>\.work\round1`
- 红测日志：`<REPO>\.work\round1\redlogs\<finding>-red.log`
- 绿测日志：`<REPO>\.work\round1\redlogs\<finding>-green.log`
- 修改前备份：`<REPO>\.work\round1\backups\<finding>-before.java`
- 构建入口：`<REPO>\build.cmd`（参数原样转发给 Maven；本仓库要求 JDK 21，脚本会自动探测）

## 强制加载

按顺序读：

1. `D:\Projects\AI prompt\many-agents_multi-prompt-files_token-heavy\multi-agent-audit-framework\framework\wrappers\fix-worker.md`
2. `...\framework\templates\wave4-fix.md`
3. `...\framework\components\output-contract\fix.md`（至少第 0、1、2.4 节）
4. `...\framework\orchestrator\protocol.md` 的 §0（零写入边界）、§1.2（L0 主 Agent 不写代码）、§6（并发）

## 硬边界

- 只允许修改派发时指定的 **一个** `target_file` 和 **一个** 新测试文件。
- 不得修改其他源码、已有测试、`state.json`、其他 finding 的产物、`.git`。
- 不得 `git add` / `git commit` / `git push` / `git checkout` 整个文件。
- 不得删除或改写本仓库已有的 25 项脏改动。
- 不得把日志写进 `target/`（`mvn clean` 会删掉）。
- 先写测试并跑红，再改生产代码；不得先改代码再补红测。
- 测试必须在**未修复**的生产代码上**编译通过并断言失败**，不能靠“方法不存在”的编译错误充当红测。若确实无法构造，必须在产物 `residual_risks` 明确写 `BASELINE_UNVERIFIED: ...` 并说明原因；不得伪造红测。
- 最多 3 次修复尝试。每次失败保留日志。

## 等待闸门（必须先做）

主 Agent 需要先登记 `fix_contract` 再放行编辑。启动后：

1. 先完成强制加载、源码阅读、测试设计（此阶段只读）。
2. 然后轮询 `<REPO>\.work\round1\START-<finding>`：
   ```powershell
   $start = Join-Path $repo '.work\round1\START-F1'
   $deadline = (Get-Date).AddMinutes(15)
   while (-not (Test-Path -LiteralPath $start)) {
     if ((Get-Date) -gt $deadline) { throw "START-F1 timeout" }
     Start-Sleep -Seconds 3
   }
   ```
3. 文件出现前**绝对不要** Edit/Write 生产代码或测试。

## 构建互斥（必须遵守）

多个实例共享同一个 Maven `target/`，并发构建会互相破坏。每次跑测试都必须用命名互斥锁串行化，并把完整输出写入日志：

```powershell
$repo = '<TARGET_REPO>'
$log  = Join-Path $repo '.work\round1\redlogs\F1-red.log'
$m = [System.Threading.Mutex]::new($false, 'Global\HilltopRound1Maven')
$m.WaitOne()
try {
  Push-Location $repo
  & .\build.cmd -o '-Dtest=ShopConfigCorruptFileTest' test *>&1 | Tee-Object -FilePath $log
  $code = $LASTEXITCODE
  Pop-Location
} finally {
  $m.ReleaseMutex(); $m.Dispose()
}
"EXIT_CODE=$code" | Tee-Object -FilePath $log -Append
if ($code -ne 0) { exit $code }
```

红测退出码非 0 是**预期**；把输出与 `EXIT_CODE` 留在日志后继续修复，不要因为红测失败就终止。绿测必须退出码 0。

## 修复与产物

1. 在第一次 Edit 前备份目标源文件：
   `Copy-Item -LiteralPath <target> -Destination .work\round1\backups\<finding>-before.java -Force`
2. 写指定测试文件，跑红测，确认失败原因是目标缺陷（不是编译错误/环境错误）。
3. 做**最小安全修复**：只改目标文件，保留原有风格；不引入新依赖，不做无关重构。
4. 跑同一测试的绿测，必须 0 失败。
5. 写产物 `<REPO>\.work\round1\round1-04-fix-<n>.md`，正文写：缺陷、复现、红测证据、修法、绿测证据、影响半径、残余风险。
6. 产物**最后一个代码块**必须是完整 JSON 信封，字段严格按 `output-contract/fix`：

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "<你的 $env:DSH_SESSION_ID，原样>",
  "role": "fix",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "<产物绝对路径>",
  "payload": {
    "finding_id": "<F?>",
    "disposition": "FIXED",
    "test_path": "src/test/java/.../XxxTest.java",
    "red_log_path": ".work/round1/redlogs/<F?>-red.log",
    "files_touched": [
      { "path": "src/main/java/...", "change_summary": "..." },
      { "path": "src/test/java/...", "change_summary": "..." }
    ],
    "verification_commands": [
      { "command": "... red ...", "result": "failed", "output_snippet": "Tests run: 1, Failures: 1" },
      { "command": "... green ...", "result": "passed", "output_snippet": "Tests run: 1, Failures: 0" }
    ],
    "affected_issues": [],
    "residual_risks": ["IMPACT_UNVERIFIED: ..."]
  },
  "error": null
}
```

- `agent_id` 必须使用你自己的 `$env:DSH_SESSION_ID`（含 `session-` 前缀），否则 harness 逐实例对账会对不上。
- `files_touched` 必须**真实**包含你写过的每个源码/测试文件；不得少报、多报。
- 不要写 `verdict`（验收阶段才写）。
- 不要改 `state.json`。

## 返回前自检

```powershell
node 'D:\Projects\AI prompt\many-agents_multi-prompt-files_token-heavy\multi-agent-audit-framework\tools\check-payload.mjs' `
  '<产物绝对路径>' --role fix `
  --repo '<TARGET_REPO>' `
  --artifact-dir '<TARGET_REPO>\.work\round1'
```

退出码必须为 0；不为 0 就按提示修产物并重跑，不得用“人工核对”代替。

最终返回：状态、产物路径、测试路径、红/绿日志路径、修改文件、红/绿命令与退出码、残余风险。不要声称成功，除非 `check-payload` 已 0。
