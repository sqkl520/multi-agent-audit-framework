修复 round1（实战验证轮）。全程遵守 `D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/framework/orchestrator/protocol.md` §0 的零写入边界：
只允许修改每条发现 target_files[] 里的文件及其对应测试，不得 commit / add / push。

## 路径

```
<FRAMEWORK_ROOT> = D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/framework
<TARGET_REPO>    = <TARGET_REPO>
<OUTDIR>         = D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/experiments/field-test-1
```

## 第 0 步：先加载，再动手

按顺序读完这八份，不许读摘要版、不许凭记忆复述：

1. `<FRAMEWORK_ROOT>/orchestrator/triage.md`
2. `<FRAMEWORK_ROOT>/wrappers/planner.md`
3. `<FRAMEWORK_ROOT>/wrappers/fix-worker.md`
4. `<FRAMEWORK_ROOT>/templates/wave4-fix.md`
5. `<FRAMEWORK_ROOT>/templates/wave5-verify.md`
6. `<FRAMEWORK_ROOT>/components/output-contract/fix.md`
7. `<FRAMEWORK_ROOT>/artifacts/run-state.md`
8. `<FRAMEWORK_ROOT>/orchestrator/protocol.md`（§0 零写入、§3 波次门控、§6 并发护栏）

## 第 1 步：TIER 判定

读 `triage.md` §2 的七项判定卡，逐项打 0/1，算出 T0/T1/T2，
按 `triage.md` §3 开出 3/5/9 个成员。不得跳过，不得降级。

判定结果写 `<OUTDIR>/round1-00-plan.md`。

## 第 2 步：本轮要修的 7 条发现

来源：`experiments/hilltop-dsh/out/round3-C-audit.md` 的 findings（全部裁决为 UPHELD）。
**先去读那份产物的 JSON 信封确认原文**，不要只信下面的摘要。

| finding_id | 严重性 | 位置 | 一句话 |
|---|---|---|---|
| F1 | MEDIUM | `shop/ShopConfigLoader.java:46` | shop.yml 解析失败被当成空配置继续加载，商店无提示变成空店 |
| F2 | MEDIUM | `shop/ShopConfigLoader.java:123` | MATERIAL 商品漏配 `icon.material` 时以 BARRIER 发货，玩家付费收到屏障方块 |
| F3 | MEDIUM | `shop/ShopConfigLoader.java:156` | `price` 缺键或写成 null 时静默按 1 计价 |
| F4 | LOW | `shop/ShopConfigLoader.java:165` | `amount` 为 0 或负数不拒绝，发货静默改为 1，但价格仍按原值扣除 |
| F5 | LOW | `shop/ShopListener.java:162` | 购买成功消息显示的数量少于实际到账（`addItem` 改写了传入的商品栈） |
| F6 | LOW | `doc/CommandsDocumentGenerator.java:189` | 自动生成的文档声称存在 DisplayEntity 清理队列输出，实际没有 |
| F7 | LOW | `doc/CommandsDocumentGenerator.java:441` | 异步线程直接覆盖 commands.md，中断会留下半截文档 |

真实路径前缀：`<TARGET_REPO>/src/main/java/com/hilltopvillage/`

## 第 3 步：派发要求 —— 这一段是硬要求，不是建议

本轮共 **7 条 UPHELD 发现，必须派 7 个独立修复实例并行执行**。
每条发现一个实例，不得由一个实例承担多条。
不要一个 agent 串行修完 7 条——那样会因上下文污染和串行停点草率收尾。

派发前先对全部 finding 的 `target_files[]` 做两两集合求交：
- 交集为空的组并行派发；
- 交集非空的编入同一串行组，组内按 `finding_id` 升序串行。

**注意**：F1/F2/F3/F4 都在 `ShopConfigLoader.java` 里 → 这 4 条**必须串行**（同一文件）。
F5 在 `ShopListener.java`，F6/F7 在 `CommandsDocumentGenerator.java`（这 2 条串行）。
所以实际是 **3 个串行组**，组间并行。

派发完成后，在 `state.json` 的 `fix_contracts` 里逐条登记
（`finding_id` / `fix_agent_id` / `registered_at` / `defect_statement` /
`disproof_condition` / `baseline_result` / `rollback_command` / `test_path`），
并把**实际派发数**写进 `budget.spawned_fix_agents`（实际计数，不得估算）。

## 第 4 步：state.json

写在 `<OUTDIR>/round1/state.json`。必填字段见 `run-state.md` §2。本轮特别注意：

```json
{
  "schema_version": "run-state-v1",
  "path_mode": "FIX",
  "phase": "wave4",
  "status": "RUNNING",
  "target_repo": "<TARGET_REPO 的绝对路径，必须是真实存在的目录>",
  "report": {
    "dir_ready": true,
    "dir_path": "<OUTDIR>/round1",
    "final_report_path": "<OUTDIR>/round1/round1-final-report.md"
  },
  "fix_baseline": {
    "captured_at": "<进入 wave4 之前抓的时刻，ISO8601>",
    "dirty_paths": ["<此刻 git status --porcelain 的路径清单>"],
    "head": "<此刻的 HEAD sha>"
  }
}
```

**`fix_baseline` 必须在派发第一个修复实例之前抓**——它记的是「修复前仓库本来就脏的文件」，
对账时用「现在的改动 − 基线」而不是裸 `git status`。

## 第 5 步：每条修复的产物要求

每条发现必须有 `disposition`（`FIXED` / `WONT_FIX` / `DEFERRED` / `NEW_FINDING`）：

- `FIXED` → 必须给 `test_path` 和 `red_log_path`（修复前跑红的日志），
  且 `files_touched[]` 里每个 path 都要真实存在、且**确实是这个实例改的**
- `WONT_FIX` → 必须给 `disposition_reason`（≥20 字，HIGH 需 ≥40 字且含可复核指涉）
- `DEFERRED` → 必须给 `next_round`

**红测日志必须落在 `target/` 之外**（例如 `<OUTDIR>/round1/redlogs/`）。
写在 `target/` 下的日志会被 `mvn clean` 删掉。

产物命名：`<OUTDIR>/round1/round1-04-fix-{序号}.md`，
末尾必须是完整的 JSON 信封（见 `output-contract/fix.md`），写完自检：

```
node <FRAMEWORK_ROOT>/../tools/check-payload.mjs <产物文件> --role fix --repo <TARGET_REPO> --artifact-dir <OUTDIR>/round1
```

## 第 6 步：验收不可跳过

每条成功的修复派一个验收实例，一个 `fix_agent_id` 对一个验收实例（双射）。
验收实例的上下文**不得包含**修复 Agent 的 `verification_commands` / `output_snippet` / `artifact_path`。

## 第 7 步：相位闭合前

1. 产出修复后快照到 `<OUTDIR>/repair-work/post-fix/`，然后：
   ```
   node <FRAMEWORK_ROOT>/../tools/verify-postfix-snapshot.mjs \
     --repo <TARGET_REPO> --snapshot <OUTDIR>/repair-work/post-fix --exclude repair-artifacts/
   ```
2. 跑 `<TARGET_REPO>/build.cmd -o test`，基线是 885 tests / 0 failures
3. 更新 `state.fix_contracts[].verdict`（PASS / FAIL + verified_at）

## 纪律

- 主 Agent 不得自己动手改代码（`protocol.md` §1.2 的 L0）
- harness 报告终态之前，不因为「产物很久没更新」就终止或重派 agent
- 任何终止路径都必须出报告，哪怕不完整
- **不要 commit / add / push 目标仓库**

## 这一轮的特殊目的

这是一次**实战验证**：上面提到的所有闸门（`stop-hook` 的 6 道判据、`check-payload` 的
`files_touched` / `red_log` 校验、`check-fix-instances` 的 UPHELD 对账、
`check-files-touched-harness` 的 write/edit 对账）都是新加的，**从未在真实任务上跑过**。

所以：**如果你觉得某道闸门在误拦正常操作，明确说出来并给出证据**——
那比「想办法绕过它让它变绿」有价值得多。误拦是必须修的 bug，
绕过是掩盖 bug。
