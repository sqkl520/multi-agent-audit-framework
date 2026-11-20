# round1 账本

> 本文件是 `state.json` 的可读投影，两者不一致时以 `state.json` 为准。生成命令：`node .run-dsh3/build-ledger.mjs`。

## 1. 切片状态表

| slice_id | 状态 | 文件数 | 线索/发现数 | attempt | 产物 |
|---|---|---|---|---|---|
| slice-01 | DONE | 3 | 6 | 0 | round1-02-sweep-slice-01.md<br>round1-02-audit-slice-01-data-consistency.md |
| slice-02 | DONE | 3 | 6 | 0 | round1-02-sweep-slice-02.md |
| slice-03 | DONE | 2 | 5 | 0 | round1-02-sweep-slice-03.md |
| slice-04 | DONE | 5 | 6 | 0 | round1-02-sweep-slice-04.md<br>round1-02-audit-slice-04-logic.md |
| slice-05 | DONE | 2 | 6 | 0 | round1-02-audit-slice-05-data-consistency.md<br>round1-02-sweep-slice-05.md |
| slice-06 | DONE | 4 | 5 | 0 | round1-02-sweep-slice-06.md |
| slice-07 | DONE | 1 | 5 | 0 | round1-02-sweep-slice-07.md |
| slice-08 | DONE | 3 | 6 | 0 | round1-02-audit-slice-08-error-handling.md<br>round1-02-sweep-slice-08.md |
| slice-09 | DONE | 1 | 4 | 0 | round1-02-sweep-slice-09.md |
| slice-10 | DONE | 1 | 6 | 0 | round1-02-sweep-slice-10.md<br>round1-02-audit-slice-10-error-handling.md |
| slice-11 | DONE | 2 | 6 | 0 | round1-02-audit-slice-11-data-consistency.md<br>round1-02-sweep-slice-11.md |
| slice-12 | DONE | 3 | 6 | 0 | round1-02-sweep-slice-12.md |
| slice-13 | DONE | 7 | 6 | 0 | round1-02-sweep-slice-13.md<br>round1-02-audit-slice-13-contract.md |
| slice-14 | DONE | 1 | 5 | 0 | round1-02-sweep-slice-14.md |
| slice-15 | DONE | 5 | 6 | 0 | round1-02-audit-slice-15-concurrency.md<br>round1-02-sweep-slice-15.md |
| slice-16 | DONE | 1 | 6 | 0 | round1-02-sweep-slice-16.md<br>round1-02-audit-slice-16-error-handling.md |
| slice-17 | DONE | 1 | 7 | 0 | round1-02-sweep-slice-17.md |
| slice-18 | DONE | 1 | 5 | 0 | round1-02-sweep-slice-18.md |
| slice-19 | DONE | 1 | 6 | 0 | round1-02-sweep-slice-19.md |
| slice-20 | DONE | 5 | 6 | 0 | round1-02-audit-slice-20-concurrency.md<br>round1-02-sweep-slice-20.md<br>round1-02-audit-slice-20-security.md |
| slice-21 | DONE | 4 | 6 | 0 | round1-02-audit-slice-21-concurrency.md<br>round1-02-sweep-slice-21.md |
| slice-22 | DONE | 4 | 6 | 0 | round1-02-sweep-slice-22.md<br>round1-02-audit-slice-22-data-consistency.md |
| slice-23 | DONE | 1 | 7 | 0 | round1-02-sweep-slice-23.md |
| slice-24 | DONE | 7 | 6 | 0 | round1-02-audit-slice-24-data-consistency.md<br>round1-02-sweep-slice-24.md |
| slice-25 | DONE | 1 | 6 | 0 | round1-02-sweep-slice-25.md |
| slice-26 | DONE | 6 | 6 | 0 | round1-02-sweep-slice-26.md<br>round1-02-audit-slice-26-data-consistency.md |

合计：26 片，DONE 26，PENDING 0。

## 2. 预算

| total_cap | spent | 剩余 | 说明 |
|---|---|---|---|
| 60 | 41 | 19 | planned_sweep_agents=26；spawned_deep_dive=15；failed_sweep=0；failed_deep_dive=0 |

## 3. 失败分类

| slice_id | error_type | artifact_bytes | last_write_at | inferred_cause | 重派策略 |
|---|---|---|---|---|---|
| — | — | — | — | 无失败切片 | — |

## 4. 裁量日志（discipline_log）

| seq | 波次 | 类型 | 动作 | 依据 | 机械复核方法 |
|---|---|---|---|---|---|
| 1 | wave1 | SLICE_SIZE_DEVIATION | 保留 9 个物理行数 >1800 的切片（最大 slice-01=2290；slice-10 为单文件 oversized），未重新切分 | 侦察按非空行数装箱（1778 等），verify-artifacts G8 用物理行数口径；物理行数实测 34954，初版声明值与实测偏差 13–27%，修正后 26/26 片偏差 0.0%。9 个切片物理行数 >1800（最大 slice-01=2290；slice-10 为单文件 oversized）。重切会把 26 片推到 31+，超出本轮预算。 | node .run-dsh3/summarize.mjs ".run-dsh3/artifacts/round1-01-recon-slices.md" "<repo>" 应逐片打印 declared=physical、delta=0.0%；>1800 的片号可由同一输出数出（共 9 个）。注意：该命令验证的是「修正后一致」，不能复现「初版偏差 13–27%」——那一项只有旧值被覆盖前的对照才能复现，属不可回溯声明。 |
| 3 | wave2b | DIMENSION_ASSIGNMENT | 10 条深挖记录的 dimension_assigned_by_discretion 全为 false，但 state.json 的 slices[*].deep_dive_dims 为空数组，没有「线索→维度」映射留痕 | 维度是按各 sweep 的 dimension_histogram 直接取的，未做主观调整；但字段留空使复核者无法从账本还原指派依据（Skeptic A 的 U2） | 对每个 slice，`wave2_completed` 里的 dimension 必须出现在该片 sweep 产物的 dimension_histogram 键中且计数 >0 |
| 4 | wave2a | CONCURRENCY_CAP_BREACH | 并发峰值达到 5–6（上限 4），原因是用「产物已落盘」当作「agent 已到终态」补位；共两次（宽扫阶段一次、锐评阶段一次） | 违反 protocol.md §1.2 L0（槽位释放条件是进入终态，不是文件已落盘）；属主 Agent 操作违规，不是子 Agent 失败 | 按 harness 的 agent 起止时间做区间重叠计数；或按产物 mtime 与 agent 派发顺序人工复核（不可完全机械化，故同时给出自述） |
| 2 | wave2b | DEEP_DIVE_SELECTION | 在 12 个计划深挖之外增派 5 个实例（s26-DC、s04-logic、s20-security、s22-DC、s10-error-handling），并把 s22 的维度由 concurrency 改为 data-consistency；计划中的 s07-DC 未派。 | s26 有 2 条 HIGH（YAML 原子降级、隔离文件写回），s04 有 2 条 HIGH（跨世界 distanceSquared、NaN 伤害），s20 有世界准入绕过线索，s22 的 nodes.yml 静默删除风险高于其唯一一条 LOW 并发线索，s10 有「无法校验即放行」的 HIGH；s07 的 2 条 MEDIUM 留给报告 §D。最终预算 26 宽扫 + 15 深挖 + 4 锐评 = 45 ≤ 60。 | node -e "const fs=require('fs');const d='.run-dsh3/artifacts';console.log(fs.readdirSync(d).filter(f=>/^round1-02-audit-/.test(f)).length)" 应为 15；state.json.wave2_completed 中 task=deep_dive 的条数应同为 15；s07 无 audit 产物。 |

## 5. 轮次链

| 轮次 | 覆盖 | 新增发现 | DEFERRED 剩余 | 状态 |
|---|---|---|---|---|
| round1 | 见 §1 | 见最终报告 | 0 | PARTIALLY_CLOSED |
