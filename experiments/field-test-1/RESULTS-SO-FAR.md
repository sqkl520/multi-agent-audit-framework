# 实战验证记录（field-test-1）

**时间**：2026-11-15 21:57 起
**素材**：Hilltop Village `shop` 模块 7 条真实未修缺陷（R3-C F1–F7）
**目的**：验证 R1–R21 的所有闸门在真实任务上会不会误拦

---

## 已确认成功的地方

### 1. 多 agent 派发真的发生了

**这是诊断的核心发现（修复阶段 0 次 subagent）第一次被真正修复。**

| 指标 | 值 |
|---|---|
| 主 session | `99da3b3f`，323 次工具调用 |
| `subagent` 调用 | **9 次** |
| 子 session | 4 个已确认（`1a7e6733` / `09140833` / `2361960f` / `0222220b`）|
| `spawned_fix_agents` | **7**（= 7 条发现，完全符合 R5 的「一条 finding 一个实例」）|

**三个串行组真的并行了**：

| 子 session | 负责 | 改的文件 |
|---|---|---|
| `2361960f` | F1–F4 | `ShopConfigLoader.java`（4 条同文件 → 串行组）|
| `09140833` | F5 | `ShopListener.java` |
| `1a7e6733` | F6/F7 | `CommandsDocumentGenerator.java` |

任务书里的「文件级依赖分析 → 3 个串行组 → 组间并行」被**正确执行**了。

### 2. `state.json` 的关键字段全部正确

```json
{
  "phase": "wave5",
  "target_repo": "<TARGET_REPO>",
  "budget": { "spawned_fix_agents": 7 },
  "fix_baseline": { "dirty_paths": [25 项] }
}
```

- `target_repo` 是绝对路径且真实存在 ✅（R16a 的判据）
- `fix_baseline.dirty_paths` 抓到 **25 项**，正好是修复前的脏文件数 ✅（R20 的判据）
- `fix_contracts` 7 条，`fix_agent_id` **全是真实 dsh session id**，不是 `fake-agent-1` 这种编的 ✅

**最后一条最关键**：这意味着 R21 的 harness 对账可以真正验证归属，而不是两个自述互相对账。

### 3. 7 份修复产物全部通过契约校验

```
round1-04-fix-1.md → 0 项违规
round1-04-fix-2.md → 0 项违规
...
round1-04-fix-7.md → 0 项违规
```

对比：那次真实事故的 **6 份产物全部没有信封**（`artifact_without_envelope` × 6）。
这次 **7/7 全部合规**。

每条都有：
- `disposition: FIXED`
- `files_touched`（2–3 个文件）
- `red_log_path`（指向真实日志）

### 4. 红测日志是真的

`redlogs/` 下有 30+ 份日志，命名本身记录了真实的调试过程：

```
F1-red-attempt1-compile.log       ← 第一次"红"是编译失败（不算红测）
F1-pass2-red.log                  ← 第二次红是真实断言失败
F1-pass2-green.log                ← 转绿
```

**它经历了「编译失败 → 修正 → 真正的红 → 绿」**，而不是直接宣称成功。

### 5. 全量测试 902 个全绿

```
Tests: 902  Failures: 0  Errors: 0
```

---

## 暴露出的真实问题

### 问题 1：`check-state` 抓到相位不一致

```
[plan_phase_mismatch] current_plan.phase=wave4 与 state.phase=wave5 不一致
```

它推进到验收相位了，但没同步更新 `current_plan.phase`。
**这是闸门在正常工作**——它抓到了一个真实的小疏漏。

### 问题 2：构建需要 `-Djdk.attach.allowAttachSelf=true`

第一次全量构建 **11 个测试 ERROR**：

```
Could not initialize plugin: interface org.mockito.plugins.MockMaker
```

原因：Mockito inline mock maker 需要 self-attach 权限。

dsh 自己发现了，加了 `JAVA_TOOL_OPTIONS: -Djdk.attach.allowAttachSelf=true` 重跑 → 902/0/0。

**这是框架文档的缺口**：`wave4-fix.md` / `run-state.md` 都要求「相位闭合前跑全量」，
但没写「某些项目的测试需要特定 JVM 参数」。
真实项目会因此卡住，而 agent 得自己摸索出来。

**建议**：在 `wave4-fix.md` 的构建章节加一句「若测试因 mock/attach 类错误失败，
检查是否需要 `-Djdk.attach.allowAttachSelf=true`；这不是产物问题」。

### 问题 3：耗时远超预期

跑了 **70+ 分钟、323 次工具调用、9 个 subagent**，还没结束。

对比：那次真实事故是 196 step / 303 调用 / **1 个实例** / 57 分钟。
这次是 323 调用 / **9 个实例** / 70+ 分钟。

**代价翻了约 3 倍，产出从 6 条未合规变成 7 条全合规。**
这个交换是否值得，要看修出来的东西对不对——但至少「多 agent 一定更慢」这件事是确定的。

### 问题 4：它在目标仓库的 `.work/` 下工作，不是任务书指定的 `<OUTDIR>`

任务书写的是 `experiments/field-test-1/`，它选了 `<TARGET_REPO>/.work/round1/`。

**这违反了 protocol.md §0 的零写入原则**（不得往被审仓库写产物）。
但同时 `.work/` 是项目里已有的工作目录约定，可能它认为这不算「污染」。

**这是一个真实的规则模糊点**：`.work/` 算不算「写进被审仓库」？
如果不算，`protocol.md §0.2` 该写明例外；如果算，这次就是违例。

---

## 待确认

- dsh 会不会自己收口（`turn/end`）
- `check-fix-instances` / `check-files-touched-harness` 对这份账本的判定
- 修复后的代码是否正确（要实际读 `ShopConfigLoader.java` 的改动）

---

## 备份

```
/tmp/hilltop-pre-fieldtest-src      修复前的完整 src/
/tmp/prefixed-status.txt            修复前的 git status（25 行）
```
