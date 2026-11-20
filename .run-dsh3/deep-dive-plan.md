# 深挖派发计划（L1 裁量，先写后派）

## 选择规则（确定性，可机械复核）

1. 只考虑 `reachability = PROD` 的切片（全部 26 片均为 PROD）。
2. 按该切片 `leads` 中**本仓库重点维度**（`concurrency` > `data-consistency` > `error-handling` > `contract`）的线索数降序，同分按 `slice_id` 升序。
3. 每个切片深挖**一个**维度：取该片 `dimension_histogram` 中在上述优先级下「有线索且优先级最高」的维度。
4. 预算上限：12 个深挖实例（`budget.spent` ≤ 60 的约束下）。

**机械复核**：每个 sweep 产物的 `payload.dimension_histogram` 与 `leads[].suspected_dimension` 可直接数出上表；派发记录在 `state.json.wave2_completed`。

## 计划（依据各 sweep 完成消息与产物直方图）

| 序 | slice | dimension | 依据（该维度 lead 数 / 总 lead） |
|---|---|---|---|
| 1 | slice-15 | concurrency | 1/6，但含「异步线程序列化 ItemStack YAML」+ endGame 重入，影响面最大 |
| 2 | slice-21 | concurrency | 1/6，MapRestoreManager 任务无 try/catch → `isRestoring` 永久 true |
| 3 | slice-20 | concurrency | 2/6，计分板任务无 `isEnabled` 守卫、爆炸匿名任务不可取消 |
| 4 | slice-22 | concurrency | 待 sweep 完成（NodeSystem/TabList 刷新任务） |
| 5 | slice-11 | data-consistency | 5/6，ConfigManager 落盘与快照 |
| 6 | slice-05 | data-consistency | 2/6（另有 logic 1），ArenaInstance 状态机 + restore 双发 |
| 7 | slice-07 | data-consistency | 2/6，MultiArenaManager 映射残留 / 先删后副作用 |
| 8 | slice-01 | data-consistency | 5/6，admin 整份读改写 |
| 9 | slice-24 | data-consistency | 待 sweep 完成（交易原子性） |
| 10 | slice-08 | error-handling | 1/6（HIGH：`/hilltop stats` NPE） |
| 11 | slice-16 | error-handling | 4/6，WaveManager 刷怪任务链 |
| 12 | slice-13 | contract | 4/6，GUI 点击/拖拽契约 |

**未深挖但有线索的切片**（进报告 D 节）：slice-02/03/04/06/09/10/12/14/25/26 等，原因：预算截断。

## 预算

- 宽扫：26
- 深挖：12
- 锐评：3（skeptic / devils_advocate / arbiter）
- 合计 41 ≤ `total_cap` 60
