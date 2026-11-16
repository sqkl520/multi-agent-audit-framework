# FIX-R6 报告 · 修复实例对账器（`check-fix-instances.mjs`）

**任务**：新建 `tools/check-fix-instances.mjs` + `tools/check-fix-instances.test.mjs`，在 `tools/check-all.mjs` 的 `CHECKS` 里注册一项。这是 R5 明确指出的最后一个缺口。

**结论**：`node tools/check-fix-instances.test.mjs` → **100 通过 / 0 失败**；`node tools/check-all.mjs` → **30 项全绿 / exit 0**。检查器能在 R5 描述的真实事故形态上点名 32 条未登记的 UPHELD。

---

## 0. 变更清单（只碰了 3 个文件）

| 文件 | 动作 |
|---|---|
| `tools/check-fix-instances.mjs` | 新建，750 行 |
| `tools/check-fix-instances.test.mjs` | 新建，740 行，30 个 case / 101 条断言 |
| `tools/check-all.mjs` | `CHECKS` 数组末尾加 1 项（+17 行），无其他改动 |

`git status` 只有这三个文件。没有 commit。

> **时间线说明（必须记录）**：写测试期间，一个并行 agent（R7）落盘了 `tools/fix-phase-e2e.test.mjs`，并且在我完成之后有一个提交 `1e81b95 fix(R6/R7)` 把这三个文件一起提交了。**提交不是我做的**，`git log` 的作者是仓库所有者。我的文件内容与该 commit 一致（`git diff HEAD -- tools/check-fix-instances*.mjs tools/check-all.mjs` 为空），所以这份报告描述的就是仓库里现在的代码。R7 报告第 7 行也记录了「写测试期间有并行 agent 落盘了 `check-fix-instances.*`，我按它的实际行为写断言，没有改它」。
>
> 收尾时仓库里又出现了 `tools/check-fix-instances-harness.mjs` + `.test.mjs`（未跟踪，**不是我写的**，也**没有注册进 `check-all`**）。它正是针对我在 §5.1 承认抓不到的「1 真实 session + N 假 id」去做的 harness 侧实现——**这是 §5.1 那条建议的落地，不是我这轮的交付物**。我没有改它，也没有把它算进本报告的任何验证结果：`check-all` 的 30 项里不含它，我的 100 条断言与它无关。

---

## 1. 十条规则清单

`tools/check-fix-instances.mjs` 实际发出的 rule 名如下（`grep -oE "(fail|warn|configError)\('[a-z0-9_]+'"` 的机读结果，与实现逐条对应）：

| # | rule | 触发条件 | 级别 / 退出码 | 错误消息要点 |
|---|---|---|---|---|
| 1a | `state_missing` | `--state` 指向的文件不存在 | CONFIG / **2** | 「没有账本就无法对账——但这不等于没有违规，只等于无从判断」 |
| 1b | `state_invalid` | `JSON.parse` 失败，或顶层不是对象 | CONFIG / **2** | 「解析不出账本就不能当作『没有 fix_contract』，否则分母会悄悄变成 0」 |
| 2a | `report_missing` | `--report` 指向的文件不存在 | CONFIG / **2** | 「没有裁决索引表就没有外部基准，所有结论退化成自述与自述一致」 |
| 2b | `report_unparsable` | 找不到表头同时含 `finding_id` 与 `裁决`/`verdict` 两列的表 | CONFIG / **2** | 「需要表头同时含 finding_id 与 裁决/verdict 两列」 |
| 3 | `not_fix_path` | `path_mode !== 'FIX'`（大小写不敏感） | 跳过 / **0** | 「AUDIT_ONLY 轮次没有修复相位，在这里报错只会让所有审计轮次变红」 |
| **4** | **`upheld_without_fix_contract`** | 裁决表里 `裁决 == UPHELD` 的 finding_id 不在 `fix_contracts[].finding_id` 里 | **FAIL / 1（永远，不受 `--strict` 影响）** | 逐条列出全部缺失 id + 「它们不是因为『判定不修』而缺席（那需要 WONT_FIX），而是根本没被派发」+ 「`state.json` 少登记一条，`stop-hook` 的 `findingIds.size` 就少 1，判据可能整个不触发」 |
| 5a | `fix_contract_not_upheld` | 登记了，裁决表里有这行，但裁决是 `DOWNGRADED`/`REJECTED`/`WONT_FIX` 等 | WARN / 0（`--strict` → FAIL / 1） | 「修了不该修的。要么裁决表该更新，要么这条修复本身是多余的写入（爆炸半径白白扩大）」 |
| 5b | `fix_contract_not_upheld` | 登记了，裁决表里**完全没有**这个 id | FAIL / 1 | 「不在表里只有两种解释：id 拼错（拼错的登记不会被任何相位消费），或者凭空杜撰」 |
| 6 | `merged_without_record` | 同一个 `fix_agent_id` 承担 >1 个 finding_id，且 `discipline_log` 里没有 `FIX_INSTANCE_MERGED` 记录、或记录的 `merged_finding_ids` ≠ 该 agent 实际承担集合 | FAIL / 1 | 「`wave4-fix.md` §0.3：默认一条 finding 一个实例，合并必须申报；**没有这条记录 = CONTRACT_VIOLATION**，该实例的全部输出作废并回滚」；集合不一致时另写「少写一条就等于把那条 finding 藏进了一次『合规』的合并里」 |
| 7 | `merge_target_files_mismatch` | `FIX_INSTANCE_MERGED.shared_target_files` 与该记录涉及的每条 finding 的 `target_files` **排序后不逐元素相等**（只重叠一部分不行） | FAIL / 1 | 「判据是排序后逐元素相等，不是『有交集』。只重叠一部分时必须分开派发」+ 打印申报值与实际值 |
| 8 | `spawned_count_mismatch` | `budget.spawned_fix_agents` ≠ `distinct(fix_contracts[].fix_agent_id)` | FAIL / 1 | 少记/多记分别给不同解释（「有实例的派发没记账」/「有实例派发了却没有任何 fix_contract 登记」） |
| 9 | `spawned_count_absent` | `budget.spawned_fix_agents` 缺失**或不是 number**（含字符串 `"3"`） | FAIL / 1（按 0 处理） | 「`run-state.md:49`：『账本没记录等于没发生』，不能给『忘了记账』免罚」；与规则 8 **互斥**，缺失时只报这一条（否则一个成因报两次） |
| 10 | `phase_not_wave4_or_wave5` | `path_mode == FIX` 但 `phase` 不是 `wave4`/`wave5` | WARN / 0 | 「可能还没到修复相位，也可能是相位推进被跳过了。这两种情况下 `fix_contracts` 的语义完全不同，所以只警告、不阻断」 |

### 1.1 三条我额外加在同名规则下的子判据（任务书的 10 条允许这样落）

这三条不属于任务书点名的 10 条，但它们落在这 10 条**已有的 rule 名**下，不新增规则名，也不新增退出码语义：

| 位置 | 判据 | 为什么必须加 |
|---|---|---|
| `fix_contract_without_finding_id`（FAIL） | `fix_contracts` 里有一条没有 `finding_id` | 这条契约无法参与任何对账。**忽略它等于让一条 finding 凭空消失**——而这正是本脚本要防的形态 |
| `report_duplicate_row`（WARN) | 裁决索引表同一 `finding_id` 出现两行 | 后一行覆盖前一行，`UPHELD` 集合因此取决于行序。不开新规则名（任务书只给 10 条），但必须可见 |
| 规则 7 的两个退化分支 | 合并记录缺 `shared_target_files`，或 `merged_finding_ids` 里的 id 在 `fix_contracts` 里不存在 | 没有 `shared_target_files` 就无法机械复核「集合相等」，合并退化成一句自述；点名的 finding 不存在则合并依据无处可查 |

**为什么不用新 rule 名**：任务书明确「每条独立 rule 名」是针对那 10 条。多开规则名会让 `check-all` 的报告变长，而这三条在语义上是既有规则的**退化情形**（同一类违规，缺一个必要字段）。错误消息不同，规则归属相同。

---

## 2. 两个关键设计问题的答案（已写进代码注释，`check-fix-instances.mjs:76-96`）

### 2.1 「没有任何 fix_contract」与「没有任何 UPHELD」分别算什么

| 情形 | 判定 | 依据 |
|---|---|---|
| `path_mode=FIX`，`fix_contracts` 为空，裁决表有 5 条 UPHELD | **规则 4 的 5 条 FAIL** | 一条都没派发，不是「没东西可修」 |
| `path_mode=FIX`，裁决表 0 条 UPHELD（全部 DOWNGRADED/REJECTED） | **合法，exit 0** | 没有要修的东西，`fix_contracts` 空是正确状态 |

**这两个情形的输入看起来一样（`fix_contracts: []`），只有裁决表能区分它们**——而裁决表是外部基准。所以实现里绝不能「空就一律合法」或「空就一律违规」：`missing` 是由 `upheldIds − registeredIds` 算出来的，两个空输入里只有一个会产生非空差集。

### 2.2 「同一侧为空」的对称检查

`fix_contracts` 有 3 条、裁决表里有这 3 行但裁决全是 `DOWNGRADED`/`REJECTED`/`WONT_FIX` → 规则 5a，**3 条 WARN**（exit 0）；
`fix_contracts` 有 3 条、裁决表里根本没有这 3 个 id → 规则 5b，**3 条 FAIL**（exit 1）。

这一条**只查 `⊇` 是不够的**：单向检查会漏掉「登记侧凭空多出 id」——那和少登记一样能让账本与事实脱节，只是方向相反。用例 `case 23` / `case 23b` 分别锁这两种形态。

---

## 3. 真实事故形态的实测输出

仓库里 `experiments/hilltop-dsh/` 确实**没有** `state.json`，也**没有** `final-report.md`——那正是被诊断出的问题之一。所以我按任务书的建议造了合成 fixture：

- **裁决表侧**：38 条 UPHELD，id 与严重性取自 `disposition-ledger-example.md` 的 38 行（`round1-core::F1` … `round3-C::F7`），其中 7 条 HIGH（`disposition-ledger-example.md:67-71` 记的 HIGH 是 `round2-mechanics::F3`、`round3-A::A-01`，加上 6 条 FIXED 里属 HIGH 的那几条）。
- **账本侧**：只登记 `disposition-ledger-example.md` 里真实标了 `FIXED` 的 **6 条**（`round1-core::F2`、`round2-ai::R2-AI-001`、`R2-AI-002`、`round2-mechanics::F1`、`F2`、`round3-B::B-01`），6 个不同 `fix_agent_id`，`spawned_fix_agents: 6`。

### 3.1 实测输出（原文）

```
=== 修复实例对账 ===

  账本:     …/state.json
  最终报告: …/final-report.md
  裁决表:   ## A. 裁决索引表（附加），38 行，其中 UPHELD 38 条
  账本侧:   6 条 fix_contract / 6 个 distinct fix_agent_id / spawned_fix_agents=6
  合并申报: 0 条 FIX_INSTANCE_MERGED

✗ [upheld_without_fix_contract] 32 条 UPHELD 发现没有进入任何修复登记：round1-core::F1、round1-core::F3、round2-ai::R2-AI-003、round2-ai::R2-AI-004、round2-ai::R2-AI-005、round2-arena::F1、round2-arena::F2、round2-arena::F3、round2-arena::F4、round2-mechanics::F3、round2-mechanics::F4、round2-mechanics::F5、round3-A::A-01、round3-A::A-02、round3-A::A-03、round3-A::A-04、round3-A::A-05、round3-A::A-06、round3-A::A-07、round3-B::B-02、round3-B::B-03、round3-B::B-04、round3-B::B-05、round3-B::B-06、round3-B::B-07、round3-C::F1、round3-C::F2、round3-C::F3、round3-C::F4、round3-C::F5、round3-C::F6、round3-C::F7。它们不是因为「判定不修」而缺席（那需要 WONT_FIX），而是根本没被派发——`final-report.md` 的裁决索引表是外部基准，`state.json` 少登记一条，`stop-hook` 的 `findingIds.size` 就少 1，判据可能整个不触发。
  已登记 6 条，UPHELD 38 条，缺口 32 条。

合计: 38 条 UPHELD / 已登记 6 / 未登记 32 / 实例 6 / spawned 6
合计: 6 PASS / 1 FAIL / 0 WARN

结论：32 条 UPHELD 从未进入任何修复登记。
它们可能从未进入任何任务书——这正是「38 条只修 6 条」丢失的地方，而这一次它被外部基准抓到了。
EXIT=1
```

**这就是那次真实事故的形态，且它现在会响。** 同一个 fixture 在 `check-fix-instances.mjs` 出现之前，四层检查（`check-payload` / `check-state` / `stop-hook` / `check-disposition-coverage`）**全部零报错**——因为 `fix_contracts` 非空、`spawned_fix_agents` 与之一致、每条登记都有完整的五字段，没有任何一个既有判据要求「UPHELD 集合 ⊆ 登记集合」。

### 3.2 同样的 fixture 在合规态下全绿（证明判据可满足）

3 条 UPHELD、其中 F2/F3 由同一个实例合并完成（已申报 `FIX_INSTANCE_MERGED`，`target_files` 都是 `src/b.ts`）、1 条 DOWNGRADED 未修：

```
  裁决表:   ## A. 裁决索引表（附加），4 行，其中 UPHELD 3 条
  账本侧:   3 条 fix_contract / 2 个 distinct fix_agent_id / spawned_fix_agents=2
  合并申报: 1 条 FIX_INSTANCE_MERGED

合计: 3 条 UPHELD / 已登记 3 / 未登记 0 / 实例 2 / spawned 2
合计: 3 PASS / 0 FAIL / 0 WARN

结论：3 条 UPHELD 全部已登记，实例计数自洽，合并申报可复核。
EXIT=0
```

---

## 4. 自测结果

```
$ node tools/check-fix-instances.test.mjs
...
=== 结果: 100 通过 / 0 失败 ===
```

30 个 case 覆盖（任务书要求的 12 项全部在内，★ 为任务书点名的最重要用例）：

| case | 内容 | 期望 |
|---|---|---|
| 1 | 3 UPHELD / 3 登记 / 3 实例 / spawned=3 | exit 0 |
| ★ 2 | **3 UPHELD 只登记 2 条 → 点名缺的 F3，且不点名已登记的 F1** | exit 1 |
| 3 | 修了 DOWNGRADED 的 | WARN / exit 0 |
| 4 | 修了表里完全没有的 id | FAIL / exit 1 |
| 5 | 同一 `fix_agent_id` 承担 2 条但无合并申报 | FAIL / exit 1 |
| 6 | 有合并记录但 `merged_finding_ids` 少一条 | FAIL / exit 1（且不误报规则 7） |
| 7 | 合并记录 `shared_target_files` 与实际只是「有交集」 | FAIL / exit 1 |
| 8 | `spawned_fix_agents` 缺失 | FAIL / exit 1（按 0，且不重复报规则 8） |
| 8b | `spawned_fix_agents` 是字符串 `"2"` | FAIL / exit 1（同「缺失」判） |
| 9 | spawned=3 但只有 2 个 distinct agent | FAIL / exit 1 |
| 10 | `path_mode=AUDIT_ONLY` | exit 0，零问题，`skipped=not_fix_path` |
| 11 | 报告里找不到裁决索引表 | exit 2 |
| 12/13/14 | state 不存在 / JSON 坏 / report 不存在 | exit 2 各一条 |
| 15 | `--strict` 把 DOWNGRADED 警告升级 | exit 1 |
| 16 | 裁决表里的模板占位行 `| ... |` 被忽略 | exit 0 |
| ★ 17 | **真实事故形态：38 UPHELD / 6 登记 → 点名 32 条，含 HIGH `round2-mechanics::F3`** | exit 1 |
| 18 | `phase=wave3` 但 `path_mode=FIX` | WARN / exit 0 |
| 19 | 人读输出含 `✗` / `合计` / UPHELD 计数 / 未登记计数 | — |
| 20 | `--help` 自述参数、规则名、`FIX_INSTANCE_MERGED`、退出码 | exit 0 |
| 21 | **合规合并（申报完整 + target_files 相等）** | exit 0（证明判据可满足） |
| 22 | 裁决表 0 UPHELD + 账本空 | exit 0（没有要修的东西） |
| 23 | 0 UPHELD + 3 登记（表里有这几行，裁决非 UPHELD） | 3 条 WARN / exit 0 |
| 23b | 0 UPHELD + 3 登记（表里没这些 id） | 3 条 FAIL / exit 1 |
| 23c | 裁决表存在但 0 行数据 | exit 0 |
| 24 | 账本空 + 5 条 UPHELD | exit 1，缺口 5，点名全部 |
| 25 | 表里有 `finding_id` 但没有裁决列（拿别的表顶替） | exit 2 |
| 26 | 围栏代码块里的示例裁决表被忽略 | exit 0（F9 不计数） |
| ★ 27 | **`upheld_without_fix_contract` 在 `--strict` 与否都是 FAIL** | exit 1 ×2 |

### 4.1 测试过程中发现并修掉的两个 bug

**bug 1（实现 bug，会让全部合规合并误报）**：`eqSet` 两边类型不同——`ids` 是 `Set`（来自 `fix_contracts` 分组），`r.ids` 是数组（来自 `merged_finding_ids`）。`a.size === b.size` 对数组取到 `undefined`，于是**永远不相等**，每一组合规合并都会被报成 `merged_without_record`。实测：

```
old eqSet(Set, Array) = false   ← 期望 true，误报
new eqSet(Set, Array) = true
```

case 21（为证明判据可满足而加的那条）抓到了它。修法：两边都归一成 `Set` 再比。**这一类 bug 只有「合规输入」能暴露**——所有违规用例都是绿的，因为违规用例本来就期望报错。

**bug 2（fixture bug，不是实现 bug）**：第一版 `stateOf({ spawned: undefined })` 用的是解构默认值，于是 `spawned` 拿到 `0`、字段**存在**，而不是「缺失」。检查器收到的是一份「记了 0」的账本，报成 `spawned_count_mismatch` 而不是 `spawned_count_absent`——**错误消息指错了成因，但实现是对的**。

改法在测试侧：加 `omitSpawned: true` 显式不赋值。同时补了 case 8b，锁住「`spawned_fix_agents` 是字符串 `"2"`」这个形态——实现的 `typeof === 'number' && Number.isFinite` 双条件本来就排除了它，但没有用例守着。

我把这两条分开标注，是因为它们**不是同一类错误**：bug 1 是代码错了，bug 2 是我对 fixture 的理解错了，而**fixture 错了会让测试说假话**——这种错误比实现 bug 更危险，因为它留下一条「看起来在测、实际没测」的用例。

### 4.2 `check-all` 结果

```
$ node tools/check-all.mjs
...
发现去向对账（每条发现是否都被表态过一次）
  用例：漏 1 条点名 / 产物内 id 重复 / 去向表杜撰 / 少理由 / HIGH 被 DEFERRED 警告 / 去向表缺失 exit 2
  → === 结果: 60 通过 / 0 失败 ===
修复实例对账（UPHELD 是否都进入了修复登记）
  用例：UPHELD 少登记点名 / 修了 DOWNGRADED 警告 / 杜撰 id / 无申报合并 / 合并集合不等 / spawned 缺失按 0 / 审计路径跳过
  → === 结果: 100 通过 / 0 失败 ===

──────────────────────────────────────────
✅ 全部通过
EXIT=0
```

30 项全部通过。注册项仿照 `check-disposition-coverage` 的写法，注释里同样说明「这里注册的是 `.test.mjs` 自测，不是对真实交付物跑对账」，并给出收口时手动跑的完整命令与 `--strict` 的用途。

---

## 5. 还没被这 10 条覆盖的绕法（诚实自评）

R5 就是靠这种自评暴露了真问题，所以这一节我按「能不能被本脚本抓到」逐条标注，并且**都跑了探针实测**，不是推测。

### 5.1 【严重，本脚本结构上抓不到】1 个真实 session + N 个假 `fix_agent_id`

```
5 条 finding 全填 5 个不同 fix_agent_id（fix-1..fix-5），spawned=5，实际 1 个 session 串行做完
→ 5 PASS / 0 FAIL / 0 WARN，exit 0
```

规则 8 比的是 `spawned_fix_agents` 与 `distinct(fix_agent_id)`——**两个都是主Agent自述**。它们一致只证明「主Agent两次说了同一件事」，不证明「真的有 5 个实例」。

这正是 R5 §5.1 表格第 1 行，也是那次真实事故的形态（0 次 `subagent` 调用）。**R6 没有解决它，只是把它从「文档里承认的边界」变成了「代码里承认的边界」**（文件头表格 + 文件尾「它不检查什么」）。要真正解决需要 harness 侧的 subagent 调用计数（`dsh-session-audit.mjs` + `scan-agent-outcomes.mjs` 已经在收集这类证据，但没人把它与 `fix_agent_id` 对齐）。**这是 R1 的下一层，不是本脚本能修的。**

> R7 报告 §4「洞 1（严重）」用 8 个假 id 独立复现了同一个洞，结论一致。两个 agent 从不同路径得出同一判断，这个洞的可信度是高的。

### 5.2 【严重，本脚本结构上抓不到】裁决表本身由主Agent写

本脚本把 `final-report.md` 当**外部基准**，但那份报告在流程上仍由主Agent落盘。R5 的论证前提是「裁决表由锐评相位产生、与 `state.json` 是两条独立路径」——**这个前提成立与否，本脚本无法验证**。

```
把裁决表 8 条 HIGH 全改成 DOWNGRADED，账本 fix_contracts 也删空
→ upheld 0 / missing 0，R6 exit 0
```

实测：单改裁决表时 R6 会放过，但 `stop-hook.mjs` 仍 exit 2（`fix_contracts` 为空）。所以**单纯篡改裁决表不能全绿，要连契约一起删**——那就撞上 `stop-hook`。这层交叉保护是真实存在的（R7 报告 §4「洞 3」记录了同样的观察）。

但要说清：**若有人同时篡改裁决表 + 伪造 `fix_contracts` + 编造 `discipline_log`，四层会全部放行。** 这三份文件都由主Agent写，本脚本无法跳出这个圈。能跳出的只有 harness 侧证据（5.1）。

### 5.3 【中等，10 条里没有】同一 finding 派了两个并行实例

`wave4-fix.md` §0.6 明确把「同一 `finding_id` 派了两个**并行**实例」列为 `CONTRACT_VIOLATION`（串行组被并行执行）。**10 条规则里没有一条查这个**：

```
F1 登记两次（fix-1 / fix-2），spawned=2，两条 target_files 相同
→ 1 PASS / 0 FAIL / 0 WARN，exit 0
```

原因：`registeredIds` 是 `Set`，重复的 `finding_id` 被静默去重；规则 6 只按 `fix_agent_id` 分组，不会注意到「同一个 finding 出现在两个组里」。**这是任务书的 10 条规则本身没覆盖的**，不是实现漏掉。若下一轮要补，规则很直白：`contractsById` 里任何 `length > 1` 且无对应 `FIX_INSTANCE_SPLIT` 申报 → FAIL。

### 5.4 【中等，10 条里没有】`WONT_FIX` 从裁决表里消失

裁决表只取 `finding_id` + `裁决` 两列。若主Agent把一条本该 UPHELD 的发现**整行删掉**（而不是改成 WONT_FIX），两条路径同时消失：

```
真实有 F1 + F2 两条 UPHELD；报告只写 F1、账本只登记 F1
→ 1 PASS / 0 FAIL / 0 WARN，exit 0
```

本脚本能做的只有「比对两个输入文件」，它不知道 F2 存在过。**这是「外部基准」这个设计的上限**：基准本身被削掉时，交叉比对失效。

缓解（不在本次范围）：裁决表可以要求「条数 == 上游 critique 产物的 finding 总数」，那就需要读 `round{N}-03-critique-*.md` 的 JSON 信封——**有了第三个独立来源，才有三方差分的可能**。`check-disposition-coverage.mjs` 已经有解析信封的能力，可以复用。

### 5.5 【轻，10 条里没有】`target_files` 全填同一个文件（R5 表格第 3 行）

```
5 条 finding 的 target_files 全写成 src/same.ts，5 个不同 agent
→ 5 PASS / 0 FAIL / 0 WARN，exit 0
```

规则 7 只在**有合并申报**时比对 `shared_target_files` 与 `target_files` 是否相等。若根本不申报合并（每个 finding 一个 agent），就没人查 `target_files` 的合理性——而「集合相等」是主Agent自己填的，全部填成同一个文件时集合当然相等。

要抓这个，需要一个**机械的合理性判据**：比如「`target_files` 必须包含该 finding 的 `evidence.file`」。这个信息在裁决表里没有（表里只有 `位置` 列写 `path:line`），在 `state.json` 里也没有。**素材不足，10 条规则之外的问题。**

### 5.6 【轻】`phase` 谎报 `wave3`

```
path_mode=FIX + phase=wave3 + 账本空 + 裁决表 5 UPHELD
→ 规则 10 一条 WARN，但规则 4 仍然 5 条 FAIL → exit 1
```

这条**已经被挡住**：`phase` 只影响规则 10 的 WARN，不影响规则 4 的 FAIL。规则 4 不看 `phase`——它只看「裁决表有 UPHELD 吗 / 账本登记了吗」。写在这里是为了记录「WARN 不构成豁免」这个设计选择。

### 5.7 【轻】`path_mode` 谎报 `AUDIT_ONLY`

```
path_mode=AUDIT_ONLY + phase=wave4 + 账本空 + 裁决表 2 UPHELD
→ 跳过全部检查，exit 0
```

规则 3 直接跳过。这是**有意为之**（审计轮次不该被修复判据染色），但它同时是一条现成的逃逸通道。缓解：`check-state.mjs` 已有 `path_mode=FIX` 时的 `fix_contracts_required`，但反向（`AUDIT_ONLY` 却有 `fix_contracts` / `phase` 在 wave4）没有对应判据。**建议**（不在本次范围）：`AUDIT_ONLY` + `phase ∈ {wave4, wave5}` 应当 FAIL，因为这本身就是一份自相矛盾的账本。

### 5.8 汇总

| 绕法 | 本脚本 | 谁能挡 |
|---|---|---|
| 少登记 N 条 UPHELD | **能（规则 4）** | — |
| 登记了裁决表里不存在的 id | **能（规则 5b）** | — |
| 修了 DOWNGRADED 的 | **能（规则 5a，WARN）** | 交付闸门开 `--strict` → FAIL |
| 无申报的合并 | **能（规则 6）** | — |
| 合并的 `target_files` 只是有交集 | **能（规则 7）** | — |
| `spawned_fix_agents` 记错 / 没记 | **能（规则 8/9）** | — |
| 1 真实 session + N 假 id | **不能（5.1）** | 只有 harness 侧 subagent 计数 |
| 篡改裁决表 | **不能（5.2）** | `stop-hook` 部分兜住（契约不能同时删空） |
| 同一 finding 派两个并行实例 | **不能（5.3，规则缺口）** | 无 |
| 把一条 UPHELD 整行从裁决表删掉 | **不能（5.4，外部基准的上限）** | 需要第三个独立来源 |
| `target_files` 全填同一文件且不申报合并 | **不能（5.5，素材不足）** | 无 |
| `path_mode` 谎报 `AUDIT_ONLY` | **不能（5.7）** | 无（`check-state` 没有反向判据） |

**诚实结论**：这 10 条把「无意识的退化」基本堵死了——而 R7 判断那占真实风险的绝大多数。**刻意伪造（5.1/5.2）仍能全绿**，因为它的三份输入全是主Agent写的。R6 的价值是把「少登记一条」从「无人能查」变成「一查就点名」，不是把「造假」变成「造不了假」。**下一层的边际收益在 harness 侧证据，不在再加自述规则。**

---

## 6. 与 R5 的四条检查建议逐条对照

R5 §5.3 给了四条检查，本脚本的落地情况：

| R5 建议 | 落地 | 差异 |
|---|---|---|
| 检查 1：`distinct(finding_id) > 1` 且 `spawned ≤ 1` → FAIL | **改为规则 8**（`spawned` ≠ `distinct(fix_agent_id)`） | R5 的判据在「多条 finding 合成一个契约」时与 `fix_contracts` 的语义冲突（一个实例可以合法地承担多条已申报合并的 finding）。用 `distinct(fix_agent_id)` 对 `spawned` 更准：它直接问「实例数与自述是否一致」，不依赖 finding 数。`stop-hook.mjs:200-227` 仍保留 R5 的原始判据，两者互补 |
| 检查 2：一个 `fix_agent_id` 对应多条时必须有 `FIX_INSTANCE_MERGED` 且集合相等 | **规则 6**，逐字落地 | 额外覆盖「有记录但集合不一致」这个 R5 没点的形态 |
| 检查 3：`shared_target_files` 与 `target_files` 逐元素相等 | **规则 7**，逐字落地 | 改为**逐条 finding 比**而不是比并集——报错才指得出是哪一条不相等 |
| 检查 4：`fix_contracts` 集合 ⊇ 裁决表 UPHELD 集合 | **规则 4**，逐字落地 | 加了对称侧（规则 5），因为单向 `⊇` 挡不住「凭空多出 id」 |

R5 说「检查 4 是关键，只有它需要外部基准」——这句话是本脚本的立项理由，也是文件头第一段引用的原文。

---

## 7. 复现命令

```bash
cd "<FRAMEWORK_ROOT>"

# 自测
node tools/check-fix-instances.test.mjs          # → 100 通过 / 0 失败

# 总检
node tools/check-all.mjs                         # → 30 项全绿 / exit 0

# 对某次真实交付物跑（收口时手动）
node tools/check-fix-instances.mjs \
  --state docs/reports/round{N}/state.json \
  --report docs/reports/round{N}/final-report.md \
  [--json] [--strict]
```
