审计目标：<TARGET_REPO>

这是一个 Minecraft Paper 服务端插件的自研代码库，153 个 Java 文件、约 57,852 行，15 个模块
（admin / ai / arena / command / config / core / diagnostic / doc / gui / mechanics / shop / stats / util）。

你的任务：按多 agent 审计框架的流程审计它。**必须真的读代码**，不许凭目录名猜。

## 强制执行顺序

1. 先读框架的入口：D:\Projects\AI prompt\many-agents_multi-prompt-files_token-heavy\multi-agent-audit-framework/START-HERE.md
2. 按它指出的流程派 recon（侦察）→ sweep（宽扫）→ audit（深挖）→ critique（锐评）
3. 每个角色的规则在 D:\Projects\AI prompt\many-agents_multi-prompt-files_token-heavy\multi-agent-audit-framework/framework/wrappers/ 下，**必须加载对应 wrapper 全文**，
   不许自己编简化版任务书——实测过：绕过 wrapper 手写任务书，16 份产物 0 份合规。

## 重点关注的维度（按这个仓库的实际情况排序）

- **concurrency**：Minecraft 插件最常见的缺陷源。Bukkit API 大多只能在主线程调用，
  异步任务里碰世界状态 = 定时炸弹。重点看 `core/`、`arena/`、`mechanics/`
- **data-consistency**：存档/配置读写、玩家数据落盘，特别是异常路径下的部分写入
- **error-handling**：插件异常会拖垮整个服务器 tick
- **contract**：GUI / 命令的输入校验

## 已知的 8 个高频缺陷模式

框架 D:\Projects\AI prompt\many-agents_multi-prompt-files_token-heavy\multi-agent-audit-framework/framework/templates/wave2-audit.md 的 §4.8.2 有完整清单。
其中对本仓库最相关的是模式 3（数值边界）、模式 4a（原型链/裸下标）、模式 5（能力未实现）、模式 7（边界符号）。

## 产物要求

每个 agent 的产物必须：
- 以完整 JSON 信封结尾（契约见 D:\Projects\AI prompt\many-agents_multi-prompt-files_token-heavy\multi-agent-audit-framework/framework/components/output-contract/<role>.md）
- 写完立刻自检：node D:\Projects\AI prompt\many-agents_multi-prompt-files_token-heavy\multi-agent-audit-framework/tools/check-payload.mjs <产物> --role <role>
- 退出码非 0 不得返回，按它给的修法补齐

**照抄 D:\Projects\AI prompt\many-agents_multi-prompt-files_token-heavy\multi-agent-audit-framework/framework/components/output-contract/examples/ 下对应角色的示例再改**，
比从零拼可靠。

## 报告

最终报告按 D:\Projects\AI prompt\many-agents_multi-prompt-files_token-heavy\multi-agent-audit-framework/framework/artifacts/final-report.md §3 的七节骨架写：
0. 一句话结论 / 1. 元信息 / 2. 覆盖说明 / 3. 发现汇总 / 4. 失败与未闭合 / 5. 零写入自证 / 6. 下一步
