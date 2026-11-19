对 13 条已确认的发现做**深挖**。目标仓库（只读）：
D:\Server\MCServers\Server plugin\Hilltop Village\Hilltop Village Plugin

## 深挖和第一轮审计的区别

第一轮回答的是「这里有没有问题」。深挖要回答三个更难的问题：

1. **可达性**：这条缺陷真的能被玩家/管理员触发吗？给出完整的调用链，从入口（命令、事件监听器、GUI 点击、定时任务）一路到缺陷行。如果中间有任何一条 guard 挡住了，说明它不可达，要标 REJECT。
2. **实际危害**：触发之后，玩家的实际体验是什么？数据会不会丢？会不会崩服？严重性到底是 high / medium / low？如果第一轮高估了，降级。
3. **误报风险**：这条的成立依赖什么前提？那个前提在 Paper 1.21.4 上成立吗？需要时反编译核实（jar 在 versions/1.21.4/paper-1.21.4.jar）。

## 硬约束

1. 只读，绝不修改目标仓库。
2. 你（主 Agent）不读源码，必须派子 Agent。
3. **并发上限 4**，不要一次派 13 个。
4. **每个子 Agent 必须在读完立刻写结果到 .run-hv/deep/<ID>.json**，不要攒着。
5. 每个子 Agent 最多读 20 个文件就收尾，宁可结论保守，不要卡住。

## 13 条待深挖

S10-F1 [high] YamlFiles.java:226 — Arena validator quarantines a legal multi-arena arenas.yml
S03-F2 [medium] MonsterSettingsMenu.java:400 — Armor cycle list holds only helmets
S03-F3 [medium] ConfigManager.java:147 — Quarantined game-settings.yml silently recreated
S07-F3 [medium] NodeListener.java:172 — Node repair handler lacks ignoreCancelled
S08-F1 [medium] TabListManager.java:491 — Tab animation frame-ticks counted in refreshes
S08-F2 [medium] ArenaScoreboard.java:363 — Disabling scoreboard mid-game destroys boards
S01-F3 [low] HilltopCommandHandler.java:766 — Expiry message always says clearspawns
S02-F5 [low] SetupWizard.java:2184 — Quit drops session but not persisted wizard keys
S03-F5 [low] DisplayConfigLoader.java:201 — Missing tab.header silently blanks tab
S03-F6 [low] NumericInputHandler.java:211 — Invalid-number re-arm resurrects pending input
S05-F6 [low] AdminDeployManager.java:530 — Failed write still replaces in-memory state
S08-F3 [low] TabListManager.java:417 — Unmanaged contexts overwrite other plugins' header
S08-F4 [low] TabListManager.java:225 — restoreAll resets name/order plugin never set

每条发现的完整描述在 .run-hv/findings/ 和 .run-hv/critiques/ 下，子 Agent 应先读对应的 JSON 了解原始主张与锐评理由。

## 输出格式

每个 .run-hv/deep/<ID>.json：

```json
{
  "finding_id": "S10-F1",
  "verdict": "REACHABLE | REJECT | NEEDS_RUNTIME_CHECK",
  "final_severity": "high|medium|low|none",
  "call_chain": ["入口: xxx", "中间: yyy", "缺陷行: zzz"],
  "guard_check": "有没有 guard 挡住？逐条说明",
  "actual_impact": "触发后玩家/管理员实际会遇到什么",
  "premise_verified": "成立的前提 + 怎么核实的（字节码/源码/文档）",
  "evidence": "关键代码原文",
  "confidence": "high|medium|low",
  "notes": "其他要点"
}
```

最后把所有深挖结果汇总到 .run-hv/DEEP-REPORT.md，按 final_severity 排序，REJECT 的单独一节说明为什么不可达。

现在开始。分批派，每批最多 4 个，做完继续下一批，不要停下来问我。
