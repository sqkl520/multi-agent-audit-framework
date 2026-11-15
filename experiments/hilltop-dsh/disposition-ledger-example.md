# 发现去向表 · 示例（hilltop-dsh 真实审计）

> **这是 R4 的示例产物，用来证明 `tools/check-disposition-coverage.mjs` 能在真实数据上跑绿。**
> 内容按 `DIAG2-coverage-gap.md §1` 记载的真实处置结果填写，不是补做的决策。
>
> 三条取值说明：
> - 6 条 `FIXED`：代码已改 + 有红转绿测试（其中 #2 / #5 是主线程越界修）。
> - 1 条 `WONT_FIX`：`A-04` 的子主张 a，裁决不修（#3）。
> - 31 条 `DEFERRED`：从未进入任何修复任务书——这张表现在把它们显式记下来，
>   而不是让它们继续静默消失。
>
> 逐条可追溯：`#N` 指 `repair/REPAIR-LOG.md` 的修复编号；
> `DIAG2-coverage-gap.md §1` 有这 38 条与 HEAD 源码的逐条对照。

| finding_id | disposition | 依据 |
|---|---|---|
| round1-core::F2 | FIXED | #7 已把 victory-waves 钳到 [1,100]，红测通过 |
| round2-ai::R2-AI-001 | FIXED | #6 拆分爆炸倍率 + #7 钳制，红测通过 |
| round2-ai::R2-AI-002 | FIXED | #5 加 null 守卫，红测通过（主线程越界修） |
| round2-mechanics::F1 | FIXED | #2 catch 内补 cancel，红测通过（主线程越界修） |
| round2-mechanics::F2 | FIXED | #1 改 planRepair 纯函数 + #7 cost 钳制，红测通过 |
| round3-B::B-01 | FIXED | #4 第 8 步失败回滚节点，红测通过 |
| round3-A::A-04/a | WONT_FIX | 文案已告知未保存会被覆盖，属设计意图（裁决 #3） |
| round1-core::F1 | DEFERRED | 未纳入任何修复任务书 |
| round1-core::F3 | DEFERRED | 未纳入任何修复任务书 |
| round2-ai::R2-AI-003 | DEFERRED | 未纳入任何修复任务书 |
| round2-ai::R2-AI-004 | DEFERRED | 未纳入任何修复任务书 |
| round2-ai::R2-AI-005 | DEFERRED | 未纳入任何修复任务书 |
| round2-arena::F1 | DEFERRED | 未纳入任何修复任务书 |
| round2-arena::F2 | DEFERRED | 未纳入任何修复任务书 |
| round2-arena::F3 | DEFERRED | 未纳入任何修复任务书 |
| round2-arena::F4 | DEFERRED | 未纳入任何修复任务书 |
| round2-mechanics::F3 | DEFERRED | 未纳入任何修复任务书 |
| round2-mechanics::F4 | DEFERRED | 未纳入任何修复任务书 |
| round2-mechanics::F5 | DEFERRED | 未纳入任何修复任务书 |
| round3-A::A-01 | DEFERRED | 未纳入任何修复任务书 |
| round3-A::A-02 | DEFERRED | 未纳入任何修复任务书 |
| round3-A::A-03 | DEFERRED | 未纳入任何修复任务书 |
| round3-A::A-05 | DEFERRED | 未纳入任何修复任务书 |
| round3-A::A-06 | DEFERRED | 未纳入任何修复任务书 |
| round3-A::A-07 | DEFERRED | 未纳入任何修复任务书 |
| round3-B::B-02 | DEFERRED | 未纳入任何修复任务书 |
| round3-B::B-03 | DEFERRED | 未纳入任何修复任务书 |
| round3-B::B-04 | DEFERRED | 未纳入任何修复任务书 |
| round3-B::B-05 | DEFERRED | 未纳入任何修复任务书 |
| round3-B::B-06 | DEFERRED | 未纳入任何修复任务书 |
| round3-B::B-07 | DEFERRED | 未纳入任何修复任务书 |
| round3-C::F1 | DEFERRED | 未纳入任何修复任务书 |
| round3-C::F2 | DEFERRED | 未纳入任何修复任务书 |
| round3-C::F3 | DEFERRED | 未纳入任何修复任务书 |
| round3-C::F4 | DEFERRED | 未纳入任何修复任务书 |
| round3-C::F5 | DEFERRED | 未纳入任何修复任务书 |
| round3-C::F6 | DEFERRED | 未纳入任何修复任务书 |
| round3-C::F7 | DEFERRED | 未纳入任何修复任务书 |

## 两处必须点名的补充

1. **`#8` 是 38 条之外的新增发现**（重载入口不消费 `loadFromFile()` 返回值）。
   本表按「38 条」的约定没为它开行。若要跟踪，应追加一行：

   ```
   | #8 | NEW_FINDING | 修 #3 时新发现：重载入口不消费 loadFromFile 返回值 |
   ```

   `NEW_FINDING` 是本工具允许「id 不在产物里」的唯一途径。

2. **`A-04` 实际是部分处置**：子主张 a=裁决不修（本表那行）、c=已修（#8）、
   b=被推翻未撤回。本表按约定记为 `WONT_FIX`，但**它是一条 HIGH**，
   而 `WONT_FIX` 不会被 `high_severity_unaccounted` 计为悬空——
   所以「HIGH 还剩几条」的真实答案是 **2 条**（`round2-mechanics::F3`、`round3-A::A-01`），
   不是 3 条。这与 `DIAG2-coverage-gap.md §1.1` 的数字一致。
