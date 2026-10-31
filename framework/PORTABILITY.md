# 让这套框架真正跨 harness 可用

> 本文件说明哪些部分是**标准能力**、哪些是**本框架的自定义约定**，以及在不同 harness 上如何落地。
> 如果你只在一套 harness 上使用，读第 1 节即可；如果要移植，读第 2–4 节。

---

## 1. 两类内容的分界

| 类别 | 内容 | harness 是否认识 |
|---|---|---|
| **标准能力** | `wrappers/*.md` 的 `name` / `description` / `tools` / `model` frontmatter；Agent 读取文件、执行命令的工具调用；返回 JSON | 认识。这是各 harness 的公共子集 |
| **自定义约定** | `template` / `requires` / `wave` / `trigger_event` / `role` 等 frontmatter 字段；`# 加载时机` 声明；`output-contract` 的 envelope；`handoff-schema` 的 Resume Packet | **不认识**。它们的读者是主Agent和人工，不是 harness 运行时 |

**关键认识**：Markdown 文件本身**没有加载器**。所谓"波次一加载 `wave1-recon.md`"，并不会被任何 harness 自动执行。它有三种落地方式，见第 2 节。

---

## 2. "加载时机"的三种落地方式

按可靠性从高到低：

### 方式 A：由调度器（代码）加载 —— 最可靠

如果你用 Agent SDK 或自己写编排脚本，可以直接在派发子 Agent 时把模板正文拼进 system prompt：

```python
# 伪代码，示意拼接顺序
system = "\n\n".join([
    read("components/evidence-policy.md"),
    read("components/output-contract.md"),
    read("templates/wave1-recon.md"),
])
agent = spawn(system=system, tools=["Read", "Grep", "Glob", "Bash"])
```

**优点**：加载是强制的，不依赖模型自律。
**代价**：需要写调度代码，不是纯提示词方案。

### 方式 B：靠 harness 的 skill / progressive disclosure —— 中等可靠

如果 harness 支持"按需加载的技能包"（例如 Claude Code 的 skills），把每个 `templates/*.md` 做成一个 skill，`description` 写明触发条件，由模型在合适时机自行加载。

**优点**：无需外部代码。
**代价**：是否真的加载取决于模型自律，可能在长对话中被遗忘。

### 方式 C：全部塞进 system prompt —— 最简单但最贵

把 15 个文件全部拼进一个 system prompt。

**优点**：绝对不会漏加载。
**代价**：上下文占用大，且违背本框架"上下文隔离"的核心原则——如果全塞进去，主 Agent 就能看到所有模板，与"主 Agent 不读代码细节"的设计冲突。

**建议**：主Agent 只塞 `orchestrator/` 两份 + `artifacts/` 两份 + 各模板的触发条件摘要（不塞正文）；各子 Agent 用方式 A 或 B 只加载自己的模板与依赖的组件。

---

## 3. 各 harness 的能力对照

以下是公开文档中能确认的能力。**标注"未核实"的，请以你所用版本的官方文档为准，不要照抄本表当作事实。**

| harness | 子 Agent 定义 | 并行派发 | 并发上限 | 结构化输出可靠性 | 加载机制 |
|---|---|---|---|---|---|
| Claude Code | `.claude/agents/*.md`，frontmatter 支持 `name` / `description` / `tools` / `model` | 支持（同一消息内多个工具调用） | 未核实（实践上受速率与上下文限制） | 依赖提示词约束，非强制 schema | 提示词自律 / skills |
| Claude Agent SDK | 代码中定义 agents 参数 | 支持（编程控制） | 由你的调度代码决定 | 可用 tool schema 强约束 | **代码强制加载**（方式 A） |
| OpenAI Codex CLI | `AGENTS.md` 约定 | 未核实 | 未核实 | 弱 | 提示词自律 |
| Cursor | `.cursor/rules/*.mdc` | 无原生子 Agent 概念 | 不适用 | 弱 | 规则自动注入 |
| GitHub Copilot | custom instructions | 无原生子 Agent 概念 | 不适用 | 弱 | 提示词自律 |
| Gemini CLI | `GEMINI.md` | 未核实 | 未核实 | 未核实 | 提示词自律 |
| LangGraph / CrewAI / AutoGen | 代码定义 agent 与图 | 支持 | 由你的代码决定 | 可用 Pydantic schema 强约束 | **代码强制加载** |

**结论**：如果你要"任何 harness 都能跑"，真正可移植的只有 **提示词文本 + JSON 约定**。并行、并发上限、强制加载这三件事在不同 harness 上的差异很大，必须按实际 harness 适配，不能指望一套配置通吃。

---

## 4. 移植时的三个必改点

### 4.1 并发上限：`scale-mapping.md` 里的 `harness_concurrency_cap`

`scale-mapping.md` 的映射表用了 `min(8, harness_cap)`。如果目标 harness 只支持 2–3 个并行子 Agent，需要：

- 把 `harness_concurrency_cap` 由侦察Agent 从运行时读取（或人工写死）；
- 如果读不到，按 `scale-mapping.md` 第 7 节取保守值 `4`，**不要**乐观假设 8。

### 4.2 结构化输出：`output-contract.md` 的 envelope

`output-contract.md` 要求返回严格 JSON envelope。不同 harness 的保障强度不同：

- **有 tool schema / function calling 强制**的（Agent SDK、LangGraph）：把 envelope 定义成工具参数 schema，不合法就调用失败，这是最可靠的；
- **只有 JSON mode** 的：仍需提示词约束 + 主Agent 的机械校验（`output-contract.md` 第 4 节的检查清单）；
- **什么都没有的**：必须依赖主Agent 的校验，且把 `CONTRACT_VIOLATION` 当作正常分支处理——不要假设子 Agent 一定返回合法 JSON。

### 4.3 文件读写权限：`wrappers/*.md` 的 `tools`

- `fix-worker.md` 需要 `Edit` / `Write`；
- 其余四个 wrapper 只需要只读工具。

如果目标 harness 用不同的工具命名（例如 `str_replace_editor`、`write_file`），**必须**改写 `tools` 字段，否则子 Agent 会拿不到写权限，或拿到不该有的写权限（验收 Agent 有写权限会破坏"只读验收"的设计）。

---

## 5. 不建议做的事

- **不要把 15 个文件合成一个大文件**。这会摧毁上下文隔离，主Agent 会看到所有波次细节，重新引入本文档开头所说的失效模式。
- **不要为了让某个 harness 跑通而删掉 `evidence-policy` 的门 0**。整套框架的可信度全押在这一条上；门 0 一松，后面所有波次都在处理幻觉。
- **不要在 wrapper 里写行为规则**。wrapper 只做身份 + 触发 + 引用。行为规则写进 `templates/`，否则同一套模板就无法被不同 harness 的 wrapper 复用。
