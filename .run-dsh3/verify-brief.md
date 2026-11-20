# 收尾机械复核 brief（给 verifier 子 Agent）

> 你的 shell 可用，主 Agent 的 shell 后端在本轮中途坏了（`windows-acl-run: --temp is not an existing directory`），
> 所以所有 `node` 校验必须由你执行并把**原始输出**带回来。

## 环境

- 框架根：`D:\Projects\AI prompt\many-agents_multi-prompt-files_token-heavy\multi-agent-audit-framework`
- 产物目录：`<框架根>\.run-dsh3\artifacts`
- 被审仓库：`D:\Server\MCServers\Server plugin\Hilltop Village\Hilltop Village Plugin`（**只读，禁止写入**）
- 辅助脚本（主 Agent 写的，在 `<框架根>\.run-dsh3\` 下）：
  - `aggregate.mjs`：解析全部产物信封，生成 `audit-summary.md` + `envelopes.json`
  - `build-state.mjs`：从产物重建 `state.json` 的 slices / wave2_completed / budget
  - `build-ledger.mjs`：从 `state.json` 生成 `round1-ledger.md`
  - `summarize.mjs`：打印 recon 的 declared vs physical 行数

## 必须执行（按序，逐条带原始输出）

1. **重建账本**
   ```
   cd "<框架根>"
   node .run-dsh3/build-state.mjs "<框架根>/.run-dsh3/artifacts" wave2b
   node .run-dsh3/build-ledger.mjs "<框架根>/.run-dsh3/artifacts"
   node .run-dsh3/aggregate.mjs "<框架根>/.run-dsh3/artifacts" "<框架根>/.run-dsh3/audit-summary.md" "<框架根>/.run-dsh3/envelopes.json"
   ```
2. **逐产物契约校验**（每个 `.md` 一份，role 按文件名判断：`01-recon`→recon，`02-sweep`→sweep，`02-audit`→audit，`03-critique`→critique）
   ```
   node tools/check-payload.mjs "<产物路径>" --role <role> --repo "<被审仓库>"
   ```
   把**每个文件的退出码**列成表；非 0 的逐条抄报错。
3. **全目录门 0 / 覆盖率校验**
   ```
   node tools/verify-artifacts.mjs --repo "<被审仓库>" --artifacts "<产物目录>"
   ```
   把 G0/G1/G2/G3/G4/G5/G7/G8 的 PASS/FAIL/WARN 原文抄回，特别是 **G0 的 `x/y 通过`** 与 **G8 的偏差**。
4. **最终报告 × 裁决表交叉校验**
   ```
   node tools/check-fix-instances.mjs --state "<产物目录>/state.json" --report "<产物目录>/round1-final-report.md" --artifacts-dir "<产物目录>"
   ```
   注意：本轮 `path_mode=AUDIT_ONLY`，预期 `not_fix_path → exit 0`；但它**仍会先解析报告里的「A. 裁决索引表」**，解析不到就 exit 2。请确认 exit code 与输出。
5. **交付物检查**
   ```
   node tools/check-deliverables.mjs --round-dir "<产物目录>"
   ```
6. **零写入自证**
   ```
   git -C "<被审仓库>" status --short
   git -C "<被审仓库>" rev-parse HEAD
   ```
   把原始输出抄回（基线：干净，HEAD=e223e20836af4dbde6b23410c3e7ddbb796bd211）。

7. **骨架产物扫描（本轮真实风险）**
   本轮要求子 Agent「先写骨架再填内容」，因此可能存在 agent 中途死掉、留下 `status: IN_PROGRESS` / 正文写「尚未开始」/ `leads: []` 但文件非空的产物。
   请对每个 `.md` 产物检查：
   - 正文是否含 `尚未开始` / `IN_PROGRESS` / `TODO` / `PLACEHOLDER`
   - `payload.leads` 或 `payload.findings` 是否为空而正文又没有任何线索/发现
   - 文件字节数 < 1500 且不是 legit 的 0 线索切片
   把命中的文件列成「SKELETON_ONLY 候选」表。

## 返回格式

按上面 6 步，每步给：命令 / 退出码 / 原始输出关键行。
最后给一张表：`文件名 | role | check-payload 退出码`。
**不要修改任何产物内容**（除了脚本生成的 state.json / ledger / summary）。
**不要写被审仓库。**
