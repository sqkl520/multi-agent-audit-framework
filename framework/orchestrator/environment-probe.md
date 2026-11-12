# 第 0 步：环境探测（每次运行前必做，2026-11-09 新增）

> **为什么需要这一步**：这套框架最初假设「所有 harness 都只有 subagent，没有编排能力」，于是自己实现了并发、重试、状态机、相位——约 2900 行。
>
> 但 2026-11-09 核实官方文档发现：**Claude Code 有原生 dynamic workflows**，其中的并发控制、断点续跑、stall retry、token 预算、逐阶段模型选择**都已经提供且更精确**。
>
> **更关键的是：不同用户的并发上限不一样。** Claude Code 默认 16 个并发 workflow agent（受 CPU 核数影响），subagent 默认 20，而 `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS` 可调到 256。**写死任何一个数字都是错的。**

---

## 0.1 主 Agent 必须在做任何事之前先问这几件事

**不要猜，直接问用户。** 这不是客套——答案会改变整个执行路径。

```
在开始审计之前，我需要确认四件事，它们会决定用哪条执行路径：

1. 你用的是哪个 harness？
   □ Claude Code（有 /workflows 或 Workflow 工具）
   □ 其他（纯 subagent，无编排层）
   □ 不确定 → 我来探测

2. 你的并发上限是多少？
   □ 知道具体数字（请告知）
   □ 不知道 → 用默认值，并在第一次派发后观察是否触顶

3. 单个任务预期跑多久？
   □ 你之前跑过类似任务，有实测值（请告知）
   □ 不知道 → **不设超时，等 harness 报告终态**

4. 要不要中途签核？
   □ 不要（全程自动，最后给报告）
   □ 每个波次结束后我确认
   → 第二项意味着不能用 workflow（官方限制：No mid-run user input）
```

---

## 0.2 根据答案选择执行路径

| 用户情况 | 执行路径 | 框架该加载哪些文件 |
|---|---|---|
| **Claude Code + 不要中途签核** | **Workflow 脚本**（`templates/workflow-audit.mjs`） | 只需 `components/evidence-policy.md` + 各 `templates/*.md` 的**判断**部分 |
| **Claude Code + 要中途签核** | **分阶段 workflow**（每个波次一个 run）+ 主 Agent 串接 | `protocol.md` §3 门控 + 判断层 |
| **其他 harness（纯 subagent）** | **完整 Markdown 编排**（现有 `protocol.md` + `scale-mapping.md`） | 全部 |
| **不确定** | 先探测（见 0.3） | — |

> **⚠ `templates/workflow-audit.mjs` 尚未实现（2026-11-10 核实）**
>
> 本表第一行指向的 `templates/workflow-audit.mjs` **在仓库里不存在**——`framework/templates/` 下只有 6 个 `.md`，全框架零个可执行文件。`docs/analysis/2026-11-09-environment-probe.md:145` 早已记录「Workflow 脚本还没写」，但本表此后一直把它当作可执行路径下发。
>
> **现在的正确做法**：具有 Workflow 能力（L-A）的 harness，**暂时按第三行「完整 Markdown 编排」执行**，不要去找那个脚本。能力探测（`detect-harness.mjs` 报 `Workflow 可用`）只说明 **harness 具备编排能力**，不等于**本框架提供了编排器**——这两件事必须分开。
>
> **为什么没直接删掉这一行**：删掉会掩盖设计意图（L-A 最终应该走脚本编排，这是对的方向）。保留但显式标注「未实现 + 现用替代路径」，比删掉或假装能用都诚实。
>
> **写这个脚本时要注意**：它必须消费与 Markdown 编排**完全相同**的判断逻辑（`evidence-policy` 门 0、各模板的判据），否则两条路径会各自演化出不同的审计质量。建议脚本只负责「派发 + 汇总」，所有判据仍从 `.md` 读取。

**降级原则**：能交给 harness 的一律交出去。`protocol.md` §0.0 的对照表说明了哪些是「harness 已有」、哪些是「框架独有」。

---

## 0.3 探测脚本（用户不确定时用）

```bash
node <FRAMEWORK_ROOT>/tools/detect-harness.mjs
```

它会检查：

| 探测项 | 怎么查 | 输出 |
|---|---|---|
| 是否是 Claude Code | 环境变量 / 可执行文件路径 | `harness: claude-code` \| `unknown` |
| Workflow 是否可用 | 版本号 ≥ 2.1.150（research preview 起始） | `workflow: available \| unavailable \| unknown` |
| 并发上限 | 读 `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS` / `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`，无则用文档默认 | 数字 + 来源标注 |
| CPU 核数 | `os.cpus().length` | 数字（用于推算默认并发） |
| stall 超时 | 读 `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS` | 毫秒数或 `default` |

**探测不到的一律标 `unknown`，不得猜。**

---

## 0.4 并发与超时：必须运行时确定，不得写死

**这是本框架此前最严重的一个设计错误。**

| 我们曾经写死的 | 实际情况 |
|---|---|
| 「`concurrency_window = 4`」 | Claude Code workflow 默认 **16**（受 CPU 影响），subagent 默认 **20**，可调至 **256** |
| 「8 分钟无更新即重派」 | 实测同类任务单 agent Runtime 常态 **47 分钟** |
| 「`STALL_CHECK_HOURS = 2`」 | harness 已有 stall retry，**自动重启 5 次** |

**新规则**：

```
并发上限 = min(用户告知的值, 探测到的值, 256)
           若都拿不到 → 用 4（保守），并在第一次触顶后调整

超时判据 = 不设自己的超时
           一律等 harness 报告终态
           若 harness 无此能力 → 记录 state_unknown，继续等

重试 = 用 harness 的（如果有）
       无则按 protocol.md §4.1 的 attempt 计数
```

**永远不要发明一个比 harness 更小的超时值。** 2026-11-04 的实测中，我按「10 分钟」杀掉 4 个 agent，而它们可能都还正常运行——**那些 agent 的产物和归因全部作废**。

---

## 0.5 一句话总结

**先问，再测，最后才假设。**

写死任何环境参数（并发、超时、模型、路径）都是错的——用户的机器、harness 版本、任务规模都不一样。**框架的职责是提供决策流程，不是提供常数。**
