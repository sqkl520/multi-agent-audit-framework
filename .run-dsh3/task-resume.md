继续上一次未完成的审计。产物目录：D:\Projects\AI prompt\many-agents_multi-prompt-files_token-heavy\multi-agent-audit-framework\.run-dsh3\artifacts\

**先读 `state.json` 与已有的产物，确认进行到哪里，不要从头重跑。**

已完成的部分（不要重做）：
- `round1-01-recon-slices.md` —— 侦察，10 个切片，75/75 文件全覆盖
- `round1-02-sweep-slice-*.md` —— 宽扫，已产出 24 份

## 你要接着做的

1. 读 `state.json` 和所有 `round1-02-sweep-slice-*.md`，把线索汇总出来
2. 派深挖 Agent（`audit` 角色）——**按线索派，不要按切片全派**
3. 锐评：2 个 skeptic（按维度分组）+ 1 个 devils_advocate + 1 个 arbiter
4. 最终报告

## 上一次运行失败的原因（重要，请避免）

上一轮主 Agent 在派了 4 个深挖 Agent 之后说「End turn」结束回合，
**父进程随即退出，4 个深挖 Agent 的产物一份都没落盘**。

dsh 的会话审计工具已经证实了这个形态（`parent_missed_child`：
子 agent 有产出，但父 session 里没有对应的 settle 注入）。

所以：**每派一批 Agent，必须在本回合内等到它们落盘再结束回合。**
不要「派完就 End turn 等下一轮」——在这个环境里没有「下一轮」。

## 目标仓库（只读）

D:\Server\MCServers\Server plugin\Hilltop Village\Hilltop Village Plugin

## 框架目录

D:\Projects\AI prompt\many-agents_multi-prompt-files_token-heavy\multi-agent-audit-framework

每个角色的规则在 `framework/wrappers/` 下，必须加载对应 wrapper 全文。
产物必须以 ```json 代码块结尾（见 `framework/components/output-contract/<role>.md`）。

## 门 0

每条 finding 的 `evidence.quote` 必须是本回合从源文件读到的原文，逐字，
`evidence.line` 必须是实际读到它的那一行。不许凭记忆、不许拼接。

开始。先读 state.json 和已有产物，告诉我你判断进行到了哪里，然后继续。
