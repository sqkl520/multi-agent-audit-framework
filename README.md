# 多 Agent 极限审计提示词框架

一套「主 Agent 只调度、子 Agent 干活」的代码审计提示词框架，用上下文隔离来对抗长链路审计中的判断漂移。

## 这是什么

给任何 harness 和模型用的一套 Markdown 提示词，分五个波次做代码审计：

```
侦察 → 审计 → 锐评 → 修复 → 验收
```

核心主张是一句反常识的话：**让主 Agent 什么都不做**。主 Agent 不读代码、不读报告、不做判断，只负责派 Agent、看结构化返回、按写死的规则调度。所有需要「看一眼」才能决定的事，都必须转化为一个子 Agent 任务。

这样做的收益不是分工，而是**上下文隔离**——主 Agent 的上下文里永远只有结构化的任务描述和结果摘要，不会被代码、堆栈、报告全文污染，从而避免长审计链上的上下文漂移和越权判断。

## 怎么开始

1. 先读 [`framework/README.md`](framework/README.md) —— 总纲，讲清设计原理和五个波次为什么这样切。
2. 再读 [`framework/PORTABILITY.md`](framework/PORTABILITY.md) —— 如果你要在不同 harness 上跑，读这个。
3. 文件按依赖分三层：`wrappers → templates → components`，`orchestrator/` 常驻主 Agent，`artifacts/` 是纯机械规则。

## 目录

| 目录 | 内容 |
|---|---|
| `framework/orchestrator/` | 主 Agent 调度协议、规模映射查找表（主 Agent 唯一常驻加载） |
| `framework/components/` | 证据基线（门 0）、统一返回契约、波次间 Resume Packet |
| `framework/templates/` | 五个波次模板 |
| `framework/wrappers/` | 五个角色包装器（身份 + 触发 + 引用，不含行为规则） |
| `framework/artifacts/` | 轮次探测、报告命名（机械规则，不交给 Agent 理解） |
| `docs/reports/` | 本框架来源对话的完整转录 |

## 诚实说明

- **来源**：这套东西的设计出自一段 DeepSeek 对话（转录在 `docs/reports/`）。其中 9 份文件是对话原文，8 份是本仓库续写。
- **局限**：Markdown 文件本身没有加载器，所谓「波次一加载某文件」不会被任何 harness 自动执行。要做可靠加载，得用调度器代码强制拼接，或依赖 harness 的 skill 机制。纯提示词方案下，加载靠模型自律。
- **未验证**：这套框架没有在真实项目上跑过完整一轮。它的逻辑一致性经过多轮交叉审查，但实际效果未经实测。
