# 修复派发计划（R1–R6）

**时间**：2026-11-15 19:00
**依据**：`DIAG-FINAL.md` 的诊断结论
**原则**：每个 agent 只改互不重叠的文件，避免并行冲突

---

## 派发表

| 编号 | 内容 | 改哪些文件 | 状态 |
|---|---|---|---|
| **R1** | 给 `phase` 加 `wave4`/`wave5` 并接入 stop-hook | `run-state.md`、`check-state.mjs`、`stop-hook.mjs` + 两个测试 | 进行中 |
| **R3** | fix 角色加 `disposition` 契约与覆盖率校验 | `output-contract/fix.md`、`output-contract.md`、`check-payload.mjs` + 测试 | 进行中 |
| **R5** | 修正修复相位并发语义（「可并行」→ 实例唯一性） | `fix-worker.md`、`wave4-fix.md`、`verifier.md`、`wave5-verify.md`、`MANUAL.md` | 进行中 |
| **R4** | 新建「发现去向表」对账器 | 新建 `check-disposition-coverage.mjs` + `.test.mjs`，注册到 `check-all.mjs` | 进行中 |
| **R2** | 写修复相位入口文档 | 新建 `START-FIX.md`，改 `START-HERE.md:52` 一处 | 进行中 |
| **R6** | 红测日志落到 `target/` 之外 | 已并入 R3 的 `red_log_path` 契约规则 | 并入 R3 |

## 文件冲突检查

无重叠。逐项核对：

- R1 只碰 `artifacts/` + `tools/check-state*` + `tools/stop-hook*`
- R3 只碰 `components/` + `tools/check-payload*`
- R5 只碰 `wrappers/` + `templates/` + `MANUAL.md`
- R4 只新建 `tools/check-disposition-coverage*` + 改 `tools/check-all.mjs` 的 CHECKS 数组
- R2 只新建根目录 `START-FIX.md` + 改 `START-HERE.md:52`

**唯一潜在交汇点**：R4 和 R1 都要碰 `check-all.mjs`？核过——R1 不碰 `check-all.mjs`，只碰 `check-state.mjs` 和 `stop-hook.mjs`。R4 改 `check-all.mjs` 的 CHECKS 数组。**不冲突。**

## 为什么按这个顺序

R1 排第一，因为它是唯一能把修复相位从「执法真空」拉回「有强制手段」的改动。
诊断的核心发现是：框架自己承认提示词是弱手段、只有 harness 机制是强手段
（`protocol.md:445-450`），而 `stop-hook` 的相位白名单不含 wave4/wave5。

**加粗、提高语气、写「必须」，都还是在弱手段里加码。R1 是把强手段接上去。**

R3 + R4 是一对：R3 让单条修复产物必须声明 `disposition`，
R4 让「所有发现」这个集合必须被逐条表态。前者防「子主张蒸发」，后者防「整条发现蒸发」。

R5 修的是 R1/R4 都管不到的语义层：即使派了 N 个实例，如果文档仍写着「可并行」，
下一个执行者还会串行。

R2 解决最上游的问题：规则写得再好，不加载等于不存在。

## 验证纪律（每个 agent 都被要求）

1. **先写失败测试**，在未修改代码上跑，确认 FAIL，把原文贴进报告
2. 改代码，确认转绿
3. 跑 `node tools/check-all.mjs`
4. 如果因别的 agent 的并行改动而失败，报告出来但**不许修别人的部分**

## 预期风险

- **R1 可能误伤审计路径**：改 `check-state.mjs` 的 phase 枚举和 `fix_contracts` 必填规则，
  如果条件写得太宽（比如对所有 path_mode 都要求 fix_contracts），会破坏 AUDIT_ONLY 路径
- **R3 可能把 disposition 变成全角色必填**：只该对 fix 必填，否则既有 audit/critique 产物全部变红
- **R5 会碰 `check-wrapper-integrity.mjs` 的必检五节**：`fix-worker.md` 实际 72 行 vs 基线 109 行，
  是既有问题（checkout 事故），**不许通过补写凑行数**
- **R4 的漏洞**：如果「全填 DEFERRED 就能过」，那这个校验器形同虚设。
  已在任务书里要求它自己论证 `high_severity_unaccounted` 能不能挡住

## 完成后的验收方式

我不能只看 agent 自述。每个都要：
1. 读实际 diff
2. 独立跑测试
3. 核对它声称的「红测试失败信息」是否可信

**上一次验收我把红测日志留在了 `target/` 里，被 `mvn clean` 删光了，导致证据不可复核。
这次要求所有 agent 把证据写到 `experiments/hilltop-dsh/` 下，不依赖构建目录。**
