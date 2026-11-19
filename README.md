[English](README.en.md) | 简体中文

<div align="center">

# 多 Agent 极限审计提示词框架

**让 AI 审一个真实代码库，而不是玩具项目**
主 Agent 只调度、子 Agent 干活 —— 用上下文隔离对抗长链路审计中的判断漂移

![Tests](https://github.com/sqkl520/multi-agent-audit-framework/actions/workflows/checks.yml/badge.svg)
![Dependencies](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen?style=flat-square)
![Node](https://img.shields.io/badge/node-%E2%89%A522-blue?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)

**零依赖** · **全程只读** · **规则写了不执行算 bug**

[快速开始](#-快速开始) ·
[能力边界](CAPABILITIES.md) ·
[问题反馈](https://github.com/sqkl520/multi-agent-audit-framework/issues)

</div>

> ⚠️ **这是一个高一牲用 AI 辅助开发（vibe coding）做的 App，处于早期开发中**
> 有任何问题、建议都欢迎提交 [Issues](https://github.com/sqkl520/multi-agent-audit-framework/issues)；
> 如果喜欢这个项目就 Star 一下喵 ⭐

---

## ✨ 它是什么

一套「主 Agent 只调度、子 Agent 干活」的代码审计提示词框架。

**核心主张是一句反常识的话：让主 Agent 什么都不做。** 它不读代码、不读报告、不做判断，只负责派 Agent、看结构化返回、按写死的规则调度。所有需要「看一眼」才能决定的事，都必须转化为一个子 Agent 任务。

这样做的收益不是分工，而是**上下文隔离**——主 Agent 的上下文里永远只有结构化的任务描述和结果摘要，不会被代码、堆栈、报告全文污染。

默认路径是四个只读波次：

```
侦察 → 宽扫 → 深挖 → 锐评 → 报告
```

修复是**独立的可选路径**，默认不启用。

## 🚀 快速开始

零依赖，只需要 **Node.js ≥ 22**（部分 harness 日志校验器用到 `zlib.zstdDecompressSync`，22.15 起提供）。

```bash
git clone https://github.com/sqkl520/multi-agent-audit-framework.git
cd multi-agent-audit-framework

# 跑全部机械校验（约 40 个自测套件）
node tools/check-all.mjs
```

看到 `✅ 全部通过` 就说明框架自身是健康的。然后按 [`START-HERE.md`](START-HERE.md) 开始审计第一个仓库。

### 先定三个前提

| 问题 | 说明 |
|---|---|
| **谁来加载模板？** | Markdown 没有加载器。①调度器代码强制拼接（最可靠）②harness 的 skill 机制（中等）③全塞进 system prompt（快，但破坏隔离原则） |
| **并发上限多少？** | 框架默认假设 8。harness 只支持 2–3 个时，让侦察 Agent 在 `harness_concurrency_cap` 里如实填；读不到取保守值 `4` |
| **总预算给多少？** | 默认 `total_agent_count = 60`：发现波 40、下游预留 20。超过 40 个切片一轮跑不完，超出部分标 `DEFERRED` |

### 三种运行方式

**方式一 · Claude Code** —— 把 `framework/wrappers/*.md` 复制到 `.claude/agents/`

**方式二 · Agent SDK 或自写调度器**（最可靠）

```python
BASE = "framework/"

def spawn_agent(role, template, extra):
    system = "\n\n".join([
        read(BASE + "components/evidence-policy.md"),
        read(BASE + "components/output-contract.md"),
        read(BASE + template),
    ]) + "\n\n" + extra
    return client.agents.create(system=system, tools=TOOLS[role])
```

拼接**顺序**必须是 `evidence-policy` → `output-contract` → 模板。

**方式三 · 纯提示词**（不推荐）—— 「加载」只是「你把这些文字给了它」，没有强制力。

## ❓ 常见问题

| 问题 | 解法 |
|---|---|
| 审计报了一堆问题，但我觉得都是误报 | 先看锐评波的 `REVOKED` 数量。Skeptic 已撤销大部分说明框架在正常工作。反过来，如果一条都没撤销反而要警惕——它的成功标准是「移除了多少」 |
| 为什么验收 Agent 看不到修复 Agent 的测试结果？ | 刻意的。看到「修复者说测试通过了」，它会倾向于复述而不是自己验证，而修复者选的测试可能根本没瞄准缺陷 |
| 能不能跳过锐评波直接修复？ | 不要。锐评是唯一专门杀发现的环节，跳过会让误报直接进入修复波，浪费最贵的预算 |
| Arbiter 说证据不足，但我不想补采 | 那条发现只能悬着。框架里没有「证据不足也先修了再说」的路径 |
| 想改阈值（并发 8 → 16） | 要改两处：`scale-mapping.md` 第 3 节的表 + `protocol.md` 第 6 节的护栏，然后同步 `MANUAL.md` |
| 它真的能保证修得对吗？ | **不能。** 见下方「能力边界」 |

## 🔒 能力边界（先读这个）

**机械闸门验的是流程合规，不是代码正确。**

一次真实运行的实测数据：

| | 数值 |
|---|---|
| 墙钟时间 | 约 90 分钟 |
| 子 Agent | 9 个（10 次真实 subagent 调用）|
| 产出 | 20 个文件 / +804 −78 / 15 个新测试 |
| 机械闸门 | 26 个校验套件，0 误拦 |
| **然后独立红队评审这 7 条修复** | **5 条有缺陷，其中 2 条严重** |

最后一行是这套框架最重要的自我说明。

完整的「能拦住什么 / 拦不住什么」逐条列在 [`CAPABILITIES.md`](CAPABILITIES.md)。**那份文档比本 README 更能帮你决定要不要用。**

其中最重要的一条：**当它漏掉检查时，不会有任何东西提醒你。**
实测 1084 条规则句里只有 97 条（8.9%）有机器出口，其余靠执行者自觉。

## 🔧 它是怎么工作的

```
主 Agent（只调度，不读代码）
   ├─ 波次一 · 侦察   → 切片 + 可达性 + 并发上限
   ├─ 波次二A · 宽扫  → 每片一实例，只产出线索，不判严重性
   ├─ 波次二B · 深挖  → 只对线索指向的维度，走完整门 0 证据链
   ├─ 波次三 · 锐评   → Skeptic 杀发现 / Devil's Advocate 找盲区 / Arbiter 裁决
   └─ 波次四 · 报告   → 五节固定结构，每个结论带 artifact_ref
```

### 技术栈

| 层 | 用了什么 |
|---|---|
| 框架本体 | Markdown 提示词 + JSON 契约（`framework/`）|
| 校验器 | 零依赖 Node.js（`tools/*.mjs`，40 个自测套件）|
| 状态机 | `state.json` 落盘，中断可续跑 |
| 证据链 | 门 0：每条发现必须逐字回显本回合读到的 `file:line` |

<details>
<summary><b>关键设计：为什么宽扫与深挖必须切分预算</b></summary>

若写成 `planned_sweep_agents = min(effective_slices, discovery_budget)`，
当 `effective_slices ≥ discovery_budget` 时（实测 round31 是 85 ≥ 40），
宽扫会**吃光全部预算**，深挖可用预算为 0，两遍制退化成「只宽扫、零深挖」——
**比原设计更糟**。

正确写法是把 `discovery_budget` 按 0.4 切给宽扫，余下留给深挖：

```
if effective_slices < discovery_budget:
    planned_sweep_agents = effective_slices
    deep_dive_budget     = discovery_budget - effective_slices
else:
    planned_sweep_agents = min(effective_slices, ceil(discovery_budget × 0.4))
    deep_dive_budget     = discovery_budget - planned_sweep_agents
```

详见 [`orchestrator/scale-mapping.md`](framework/orchestrator/scale-mapping.md) 第 3 节。

</details>

<details>
<summary><b>关键设计：为什么修复是独立路径而不是默认流程</b></summary>

2026-11-01 结构性修订。原因：round31 实跑中 **83 条待修复只完成 1 条**，
整轮停在 `IN_PROGRESS` 且**没有最终报告**。

修复是唯一有写权限、规则最严的角色，把它放在默认路径里等于让最脆弱的环节决定整轮能否结束。

详见 [`docs/analysis/2026-11-01-proposal.md`](docs/analysis/2026-11-01-proposal.md)。

</details>

## 📌 当前进度

> 最后更新：2026-11-18

| 模块 | 状态 |
|---|---|
| 四波次只读路径 + 报告 | ✅ 完成 |
| 修复 / 验收独立路径 | ✅ 完成 |
| 机械校验套件（40 个） | ✅ 全绿 · CI 三平台通过 |
| 契约三层闭环（模板/契约/校验器） | ⚠️ 部分 —— 出口率 8.9% |
| 规则 → 校验器对账工具 | ✅ 已上线（仪表，不是闸门）|
| 中英双语门面 | ✅ README + 社区文件 |
| 模式 B（判定面只覆盖自造样本）的机械检测 | ⬜ 实测做不到，未实现 |
| 模式 C（注释承诺 > 代码实际）的机械检测 | ⬜ 实测恒亮，已放弃 |

**质量基线**：`node tools/check-all.mjs` 全绿 · CI ubuntu 22/24 + windows 22 三 job 通过

## 📦 验证

```bash
node tools/check-all.mjs          # 全部机械校验（约 40 个套件）
node tools/check-rule-ledger.mjs  # 规则句 → 机器出口对账（仪表）
node tools/check-payload.mjs <产物> --role <角色>   # 单份产物契约准入
```

CI 配置见 [`.github/workflows/checks.yml`](.github/workflows/checks.yml)，
零 `npm install`，ubuntu 与 windows 各跑一次（git 调用在两平台行为不同）。

## 🤝 开发与贡献

这是一个高一牲在课余时间做的小项目。规则写得不少，但**真正有机器守着的只有一部分**——
如果你发现某条规则宣称存在却不触发，那是最有价值的 Issue。

- **贡献指南**：[`CONTRIBUTING.md`](CONTRIBUTING.md) —— 怎么报问题、怎么提 PR、测试要求
- **安全问题**：[`SECURITY.md`](SECURITY.md) —— **不要开公开 issue**，走私密公告
- **行为准则**：[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)

报 bug 请带上：复现命令、期望 vs 实际、以及契约里那句话的 `file:line`。

## 📚 文档

| 文档 | 内容 |
|---|---|
| [`CAPABILITIES.md`](CAPABILITIES.md) | **能力边界**——能拦住什么、拦不住什么，以及漏检时为什么不会提醒你 |
| [`START-HERE.md`](START-HERE.md) | 审计入口：从零开始审一个仓库 |
| [`START-FIX.md`](START-FIX.md) | 修复入口：消费已确认的发现 |
| [`framework/MANUAL.md`](framework/MANUAL.md) | 完整使用说明书 |
| [`framework/README.md`](framework/README.md) | 总纲：每条设计为什么这样定 |
| [`framework/PORTABILITY.md`](framework/PORTABILITY.md) | 跨 harness 移植 |
| [`experiments/review-7/`](experiments/review-7/) | 那次「闸门全绿却有 5 条缺陷」的完整复盘 |

## 诚实说明

- **来源**：设计出自一段 DeepSeek 对话（转录在被审计仓库里）。该分享链接现返回 **429**，无法复核——**多数论断的真实上游是一段 LLM 对话，而非论文**。正确定位是「一套设计约定的集合」，不是「实证研究的汇总」。
- **局限**：Markdown 没有加载器。所谓「波次一加载某文件」不会被任何 harness 自动执行。纯提示词方案下，加载靠模型自律。
- **跑过一轮真实项目，结果是「部分失效」**：85 个切片只派发 40 个、预算被死代码吃掉、83 条待修复只完成 1 条且无最终报告。
- **引用经逐条核实，发现「链接真实、用错地方」**：25 个外部 URL 无一 404，但存在把「API 掉线率」当「审计失败率」的问题。已修复并新增引用分级纪律。

## License

[MIT](LICENSE)
