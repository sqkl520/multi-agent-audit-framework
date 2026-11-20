审计目标仓库（只读）：D:\Server\MCServers\Server plugin\Hilltop Village\Hilltop Village Plugin

这是一个 Minecraft Paper 1.21.4 服务端插件，75 个 Java 主源文件、约 34,193 行。
模块：admin / ai / arena / command / config / core / diagnostic / doc / gui / mechanics / shop / stats / util。

你的任务：**按多 Agent 审计框架的流程，自己派子 Agent 完成一次完整审计。**

框架根目录：D:\Projects\AI prompt\many-agents_multi-prompt-files_token-heavy\multi-agent-audit-framework

## 强制顺序

1. 先读框架入口：`START-HERE.md`
2. 按它指出的流程执行：recon（侦察）→ sweep（宽扫）→ audit（深挖）→ critique（锐评）
3. 每个角色的规则在 `framework/wrappers/` 下，**必须加载对应 wrapper 全文**，
   不许自己编简化版任务书。框架里记过：绕过 wrapper 手写任务书，16 份产物 0 份合规。
4. **你必须派子 Agent 去做实际工作**，不要自己读源码。这是框架的第一性原理：
   主 Agent 的上下文里只放结构化任务和结果摘要，不放代码正文。

## 重点维度（按这个仓库的实际情况排序）

- **concurrency**：Bukkit API 大多只能在主线程调用，异步任务里碰世界状态 = 定时炸弹。
  重点看 `core/`、`arena/`、`mechanics/`
- **data-consistency**：存档/配置读写、玩家数据落盘，特别是异常路径下的部分写入
- **error-handling**：插件异常会拖垮整个服务器 tick
- **contract**：GUI / 命令的输入校验

## 已知的 8 个高频缺陷模式

`framework/templates/wave2-audit.md` §4.8.2 有完整清单。
对本仓库最相关的是模式 3（数值边界）、模式 4a（原型链/裸下标）、
模式 5（能力未实现）、模式 7（边界符号）。

## 产物要求（严格遵守，否则校验会失败）

每个子 Agent 的产物写到：`D:\Projects\AI prompt\many-agents_multi-prompt-files_token-heavy\multi-agent-audit-framework\.run-dsh3\artifacts\`

要求：
- 文件名按 `framework/artifacts/report-naming.md` §1：`round{N}-{stage}-{discriminator}.md`
- **必须以一个 ```json 代码块结尾**，内容是该角色契约定义的信封
  （见 `framework/components/output-contract/<role>.md`）
- 写完立刻自检：
  ```
  node "D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/tools/check-payload.mjs" <产物路径> --role <角色>
  ```
  退出码非 0 不得返回，按它给的修法补齐后重跑
- **照抄 `framework/components/output-contract/examples/` 下对应角色的示例再改**，
  比从零拼可靠

## 门 0（最重要的一条）

每一条 finding 的 `evidence.quote` 必须是**本回合从源文件读到的原文**，
逐字，且 `evidence.line` 必须是你实际读到它的那一行。

不许凭记忆、不许推测、不许拼接不同行的片段。
`verify-artifacts.mjs` 会拿它去源文件里逐字比对，对不上就判该发现作废。

## 最终报告

报告写到 `.run-dsh3\artifacts\round{N}-final-report.md`，按
`framework/artifacts/final-report.md` §3 的七节骨架：
0. 一句话结论 / 1. 元信息 / 2. 覆盖说明 / 3. 发现汇总 / 4. 失败与未闭合 / 5. 零写入自证 / 6. 下一步

**报告必须包含 A. 裁决索引表**（表头同时含 `finding_id` 与 `裁决`/`verdict` 两列），
否则 `check-fix-instances.mjs` 会判 exit 2。

## 硬约束

- 目标仓库**只读**，绝不修改
- 并发上限 4，不要一次派 13 个
- 每个子 Agent 最多读 20 个文件就收尾，宁可结论保守，不要卡住

开始。
