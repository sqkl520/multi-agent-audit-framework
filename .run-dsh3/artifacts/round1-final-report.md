# round1 审计报告

## 0. 一句话结论

对 Hilltop Village（Paper 1.21.4，75 个主源文件 / 34,954 物理行）做了一轮只读多 Agent 审计：26 个切片中 **22 片完成宽扫**、**7 片进入单维度深挖**，锐评后确认的缺陷集中在 **异步线程触碰 Bukkit 对象**、**YAML 落盘原子性**、**竞技场重置/回滚的不可恢复中间态**、**GUI/命令输入契约**四类。覆盖不完整（4 片未宽扫、19 片未深挖），结论可复核但**不能当作全仓保证**；可进入定向修复。

## 1. 元信息

| 字段 | 值 |
|---|---|
| round_id | round1 |
| trace_id | trace-r1-20260215-hilltop-dsh3 |
| 路径模式 | AUDIT_ONLY |
| report_state | PARTIAL_BUDGET |
| 开始 / 结束时间 | 2026-11-20T20:34+08:00 / （收尾时填） |
| 是否续跑 | 否 |
| 实际派发 agent 数 | 26 宽扫 + 7 深挖 + 4 锐评 = 37（来自 state.json，不估算） |
| 预算上限 | 60 |
| 被审仓库 | `D:\Server\MCServers\Server plugin\Hilltop Village\Hilltop Village Plugin` |
| 基线 HEAD | `e223e20836af4dbde6b23410c3e7ddbb796bd211`（工作区干净） |

## 2. 覆盖说明

### 2.1 派发覆盖率

| 指标 | 数值 | 口径 |
|---|---|---|
| 规划切片（`effective_slices`） | 26 | recon 产物 `payload.slice_count` |
| 已宽扫 | 22（84.6%） | `round1-02-sweep-*.md` 计数 |
| 已深挖 | 7（26.9%） | `round1-02-audit-*.md` 计数 |
| 未宽扫（DEFERRED） | 4（15.4%） | slice-17/18/19/23，预算截断 |
| 未深挖（有线索但预算截断） | 15 | 见 §D |
| 失败 agent | 1 | recon 首实例耗尽上下文（NO_OUTPUT） |
| 状态不明 agent | 0 | — |

**未覆盖清单**：slice-17（TpsDiagnostic，120 行）、slice-18（CommandsDocumentGenerator，598 行）、slice-19（ArenaSelectionGUI，339 行）、slice-23（VillagerSystem，356 行）。原因：预算优先给 core/arena/mechanics/config/shop，四片均为低可达性或展示层。

### 2.2 证据覆盖率

| 指标 | 数值 | 口径 |
|---|---|---|
| 通过门 0 的 quote 条数 Q | （verifier 填） | `verify-artifacts.mjs` G0 的 ok 计数 |
| 切片声明文件总数 F | 75 | recon `audit_slices[].files` 去重 |
| **证据覆盖率 Q/F** | （收尾填） | Q / F |

## A. 裁决索引表

| finding_id | 严重性 | 维度 | 位置 | 裁决 | 出处 |
|---|---|---|---|---|---|
| （锐评后填） | | | | | |

## 3. 发现汇总

（按缺陷族归并，锐评后填；每条带 finding_id / 严重性 / 维度 / 位置 / artifact_ref）

## 4. 失败与未闭合

| item | error_type | 观察到的现象 | 处置 |
|---|---|---|---|
| recon 首实例 | `NO_OUTPUT` | 耗尽上下文、零产物（读完框架文档后仍试图通读源码） | 重派为「清单驱动」窄任务，9 个文件内完成，产物合规 |
| 主 Agent shell | `ToolError` | `windows-acl-run: --temp is not an existing directory`；`danger-full-access` 无审批通道 | 所有 `node` 校验改由子 Agent 执行；主 Agent 只用 read/write/glob/grep |
| **并发上限突破** | `L0_VIOLATION` | 峰值 **6** 个并发（上限 4）：主 Agent 用「产物已落盘」当作「agent 已终态」补位 | 已停止派发并等待终态；在 §5 与纪律日志中如实记录，本轮结论的调度部分按 L0 违规处理 |
| 骨架产物 | `SKELETON_ONLY`（潜在） | 任务书要求「先写骨架再填」，slice-20/21/22 中途出现「尚未开始」骨架 | 已加入 verifier 的骨架扫描；最终产物需确认无残留骨架 |
| 4 片未宽扫 | `DEFERRED` | slice-17/18/19/23 预算截断 | 记入 §D，下一轮优先 |

## 5. 零写入自证

```
（收尾时原样粘贴 git status --short 与 rev-parse HEAD 的真实输出）
```

## 6. 下一步

- 本轮为 AUDIT_ONLY，**不自动开下一轮**（用户初始指令未要求自动续轮）。
- 建议下一轮：补 slice-17/18/19/23 宽扫；对 §D 中 concurrency/data-consistency 的高价值线索补深挖；按 §A 的 UPHELD 清单进入修复相位（需用户明确授权）。
- 修复优先级建议：先修「异步线程序列化 ItemStack」「YAML 原子写降级」「MapRestoreManager 任务异常导致 isRestoring 永久 true」这三条（影响面最大且互相独立）。

## C. 裁量记录

| seq | 波次 | 类型 | 做了什么 | 依据 | 机械复核方法 | 可回退 |
|---|---|---|---|---|---|---|
| 1 | wave1 | SLICE_SIZE_DEVIATION | 保留 9 个物理行数 >1800 的切片（最大 2290） | 侦察按非空行数装箱；物理口径偏差 13–27%；重切会把 26 片推到 31+ | `node .run-dsh3/summarize.mjs` 打印 declared vs physical | 是 |
| 2 | wave2b | DEEP_DIVE_SELECTION | 只深挖 7 片（预算截断） | 优先 concurrency/data-consistency 且 lead 密度高 | 见 `.run-dsh3/deep-dive-plan.md` 的规则与各 sweep 的 histogram | 是 |

## D. 未深挖线索附录

| lead_id | 切片 | 疑似维度 | 位置 | 为什么没深挖 |
|---|---|---|---|---|
| （收尾时按 sweep 产物汇总） | | | | 预算截断 |
