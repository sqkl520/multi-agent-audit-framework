# R5 · 修正修复相位的并发语义

**任务**：把修复相位的「可并行」（许可）改成与审计相位同构的「实例唯一性」（硬规则）。
**日期**：2026-11-15
**改动文件（5 个，未碰其他）**：

行数为 `check-wrapper-integrity.mjs` 的口径（`split('\n').length`，比 `wc -l` 多 1）。

| 文件 | 改前 → 改后行数 | 增删 |
|---|---|---|
| `framework/wrappers/fix-worker.md` | 73 → 81 | +8 / −1 |
| `framework/wrappers/verifier.md` | 83 → 88 | +5 / −0 |
| `framework/templates/wave4-fix.md` | 198 → 299 | +101 / −0 |
| `framework/templates/wave5-verify.md` | 246 → 304 | +58 / −0 |
| `framework/MANUAL.md` | 605 → 634 | +29 / −3 |

**未 commit**。`framework/artifacts/run-state.md` / `components/*` / `tools/*` 的 diff 是其他并行 agent（R1/R3）的，不是我改的。

---

## 1. 逐字对照

### 1.1 `framework/wrappers/fix-worker.md:33`（核心那一行）

**改前**：

```
| 并发约束 | 不同 `target_files` 的修复可并行；**共享同一文件的修复必须串行**，由主Agent排序 |
```

**改后**：

```
| 并发约束 | **每条 `UPHELD` 的 finding 一个修复实例**（义务，不是许可：`planned_fix_agents = UPHELD 发现数`）。共享同一 `target_files` 的实例**必须串行**——这是「必须做文件级依赖分析」的理由，**不是串行的默认理由**。由主Agent做文件级依赖分析后**编组派发**，主Agent不是排序者 |
```

三个病根各自被拆掉：

| 病根 | 改前 | 改后 |
|---|---|---|
| 「**可**并行」是许可不是义务 | `不同 target_files 的修复**可**并行` | `**每条 UPHELD 的 finding 一个修复实例**（义务，不是许可）` —— 加粗落在**实例数**上，不在串行上 |
| 加粗落在「必须串行」 | `**共享同一文件的修复必须串行**` | 串行被降级为「依赖分析的**理由**」，并明写「**不是串行的默认理由**」 |
| 主Agent是「排序者」 | `由主Agent排序` | `由主Agent做文件级依赖分析后**编组派发**，主Agent不是排序者` |

### 1.2 `fix-worker.md` 新增「实例唯一性」（`:35-41`，全新）

参照 `sweep-scout.md:71` 的写法：

```
**实例唯一性**：**一条 `UPHELD` 的 finding 一个实例**，且一个实例只承担一条 finding。**不得**让一个实例承担多条 finding——「5 条缺陷交给 1 个 session 一次修完」是 `CONTRACT_VIOLATION`，不是「效率」。

> **唯一允许合并的情形**：多条 finding 的 `target_files` **完全重叠**（集合相等，不是「有交集」）**且同源**（同一切片、同一根因），才可编入同一实例；且**必须**把合并理由与参与合并的 `finding_id` 列表显式写进主Agent的派发记录（`state.json` 的 `discipline_log`）。**没有这条记录 = `CONTRACT_VIOLATION`。**

> **产物里出现多条 `disposition` 不等于被允许多条**：`components/output-contract/fix.md` §2.4 的 `dispositions[]` 是容纳**已申报合并**的容器。没有 `FIX_INSTANCE_MERGED` 记录的多条 `disposition`，判 `CONTRACT_VIOLATION`——契约装得下，规则不允许。

**「共享同一文件必须串行」的准确含义**：它只约束**已经决定分开派发**的实例之间的调度顺序。它要求在派发**之前**对全部 finding 的 `target_files[]` 做集合求交、把交集非空的编入同一**串行组**，组内串行、组间并行。**做这个分析是为了知道哪些能并行，不是把一切串起来。** 串行组是唯一能合法压低实例数的理由，压缩必须留痕。
```

对照 `sweep-scout.md:71` 原文：

```
**实例唯一性**：**一个切片一个实例**，且一个实例只承担一个切片。不得让一个实例承担多个切片。
```

结构同构（「**一个 X 一个实例**，且一个实例只承担一个 X。**不得**……」），只是 `X` 从「切片」换成「`UPHELD` 的 finding」。

### 1.3 `framework/wrappers/verifier.md` §2 新增 `并发约束` 行

**改前**（`:32-33` 之间**没有**并发约束行）：

```
| 派发参数 | `trace_id`、`round_id`、`finding_id`、`fix_agent_id`、`target_files[]`、`acceptance_criteria`、`affected_issues[]`、`residual_risk_flags[]` |
| **禁止传入** | 修复Agent的 `verification_commands`、`output_snippet`、`artifact_path` 作为必读项 |
```

**改后**：

```
| 派发参数 | （不变） |
| 并发约束 | **每个 `fix_agent_id` 一个验收实例**，与修复实例**一一对应**（`planned_verify_agents = 派发成功的修复实例数`）。不得让一个实例验收多条修复，也不得让两个实例验收同一条修复 |
| **禁止传入** | （不变） |
```

并新增两段（`:36-38`）：双射说明 + 与 `sweep-scout` / `audit-specialist` 的同构关系。
`:35`（现 `:40`）原有的 `独立性硬约束` **原文保留、未改一字**。

### 1.4 `framework/templates/wave4-fix.md` 新增 `## 第 0 节：派发规则`

改前 7 节全是「修复Agent怎么做」+「主Agent收到返回后怎么处理」。新增 `第 0 节`（`:39-136`），5 个子节：

| 子节 | 内容 |
|---|---|
| 0.1 | `planned_fix_agents = len(UPHELD 发现列表)`，并逐条驳斥「K / 按需 / 看工作量」；引 `triage.md` §3「没有『降级到 2 个』这条路」作同构依据 |
| 0.2 | 文件级依赖分析：`target_files[]` 两两求交，交集非空 → 同一串行组；禁止按文件名/目录/复杂度编组；串行组内按 `finding_id` 升序（唯一允许的排序） |
| 0.3 | 唯一允许的合并（集合**相等** + 同源）+ `FIX_INSTANCE_MERGED` 记录格式 + 「没有这条记录 = CONTRACT_VIOLATION」 |
| 0.4 | 派发前必须就绪：产物目录 / `fix_contracts` 数组 / 编号冻结 |
| 0.5 | 派发后机械对账，**接到 R1 的 `stop-hook.mjs` 实际判据上**（见 §2） |
| 0.6 | 失败模式表：「一个实例修多条 finding」= `CONTRACT_VIOLATION` |

标题取 `第 0 节` 而非 `第 8 节`：因为它必须在第 1 节**之前**生效（派发发生在任何修复行为之前），且不打断既有的 `第 N 节` 编号——`check-wrapper-integrity.mjs` 的必检五节是 wrapper 的，模板不受该约束，但保持编号稳定可以避免 `run-state.md:169` 的「`wave4-fix.md` §2」这类交叉引用错位。

### 1.5 `framework/templates/wave5-verify.md` 新增 `## 第 0 节：派发规则`

改前 9 节零个涉及派发/并发/实例数。新增 `第 0 节`（`:19-75`），同构于 wave4 的第 0 节：

- `planned_verify_agents = 返回 SUCCESS 且契约合规的 fix_agent_id 数`；
- 双射表 + 为什么不能合并验收（**污染源从修复者换成了自己**——这是新论证，不是复述第 2 节）；
- 派发参数必须传 / 必须不传（`fix_agent_id` 必传，因为它是对账的唯一键）；
- 派发前就绪 + 派发后对账；
- 失败模式表：一实例验多条 = `CONTRACT_VIOLATION`。

### 1.6 `framework/MANUAL.md:337`

**改前**：

```
每条 `UPHELD` 的发现派一个修复实例。不同 `target_files` 可并行，**共享同一文件的必须串行**。
```

**改后**（操作手册口径，更直白）：

```
**每条 `UPHELD` 的发现都必须派一个自己的修复实例。这是义务，不是选项。**

```
planned_fix_agents = UPHELD 的发现数（减去已申报合并的条数）
```

**先做文件级依赖分析，再编组派发**：把所有 `UPHELD` 的 `target_files[]` 两两求交。

| 交集 | 怎么派 |
|---|---|
| 空 | 独立一组，**并行**派（同时运行数受 `concurrency_window` 限制） |
| 非空 | 编入**同一串行组**，组内按 `finding_id` 升序依次派 |

**「共享同一文件的必须串行」说的是这个**：它要求你在**派发前**做上面的求交，把冲突的编进同一串行组——不是让你把所有修复排成一队一个个做。**串行组是唯一能合法减少实例数的理由，且必须按上面的规则编组，不能凭手感。**

**不要这样做**：拿一个 session、把 N 条缺陷列成 N 个编号、从头到尾一次做完。这在框架里不是「高效」，是 `CONTRACT_VIOLATION`——实测出现过：5 条 UPHELD、196 个 step、303 次工具调用、`subagent` 调用 **0 次**。

**唯一允许的合并**：……（同规则，`FIX_INSTANCE_MERGED`）
```

另外 `MANUAL.md` 两处配套改动：

- 步骤 5 的代码块 `主Agent → 派 M 个 fix-worker` → `主Agent → 先求交编组 → 每组派 1 个 fix-worker（一条 finding 一个实例）`（`M` 这个字母没定义过，是「按需」的化身）；
- 步骤 6 的 `主Agent → 派 K 个 verifier` 加了行内注释 `# K = 返回 SUCCESS 的修复实例数，一条修复一个验收实例`（`K` 在 `triage.md` 里是**面板成员数**，复用到验证波是语义漂移）；
- 第 5 节「每一波要检查什么」表新增 4 行（2 行波次 5、2 行波次 6），把实例数对账写进逐条过检表。

---

## 2. 一个必须记录的发现：与 R1、R3 的交汇

任务书没要求我碰 `tools/`，我也没有。但改的时候发现两处必须让文档与**已经存在的机械判据**对齐，否则文档写的对账口径是空的：

### 2.1 R1 已经把「多缺陷单实例串行」接到 stop-hook（`tools/stop-hook.mjs:200-227`）

```js
// 3.5 · wave4：多条缺陷必须多实例，不得在单个实例里串行
if (state.phase === 'wave4') {
  const findingIds = new Set(fixContracts.map((fc) => fc?.finding_id)...);
  const spawned = Number(state.budget?.spawned_fix_agents ?? state.spawned_fix_agents ?? 0);
  if (findingIds.size > 1 && spawned <= 1) { problems.push(...); }   // 退出码 2，拒绝结束回合
}
```

字段名是 `budget.spawned_fix_agents`，缺失按 **0** 处理。**我第一版写的是 `distinct(fix_contracts[].fix_agent_id)`，那是另一套口径**——两套口径并存的话，文档说 A、hook 查 B，执行者会以为满足 A 就满足了 B。

已改为三者并列、口径统一：

```
应派实例数 = len(UPHELD) - Σ(已申报合并的 finding 数)
实派实例数 = budget.spawned_fix_agents      # 实际计数，每次派发后 +1
交叉验证   = distinct(fix_contracts[].fix_agent_id)
三者必须一致。
```

`wave4-fix.md` §0.5 与 `MANUAL.md`（步骤 5 门控 + 第 5 节检查表）都用了同一组三个式子。

### 2.2 R3 给 `output-contract/fix.md` §2.4 加了「多发现形态」

`payload.dispositions[]` + `target_finding_ids` 的覆盖校验 —— **契约层现在合法地允许一次派发携带多条发现**。这是与 R5 直接对冲的一处：我这边说「一个实例一条 finding」，契约那边提供了一个「多条 disposition」的合法容器。

**这不是 R3 的错**——它要解决的是另一件事（38 条发现只修 6 条、31 条从未进入任务书）。但两份规则放在一起，执行者可以拿契约的「合法」去抵消派发层的「违规」。

已在**两个文件里**加了显式的优先顺序声明（`fix-worker.md` §2 末、`wave4-fix.md` §0.3 末）：

> 契约能装下多条，规则不允许无申报的多条。不要去用契约层的「合法」抵消派发层的违规。

**这条是我在任务书之外加的**，因为不加的话 R5 的改动会被 R3 的改动部分抵消，而两份文档都不会报错。

---

## 3. 验证结果

### 3.1 三个指定校验器

```
$ node tools/check-wrapper-integrity.mjs
=== Wrapper 完整性检查 ===
✓ audit-specialist   91   —
✓ critique-panel     93   —
✓ fix-worker         81   —
✓ planner           162   —
✓ recon-scout        85   —
✓ sweep-scout       120   —
✓ verifier           88   —
合计: 0 项问题 / 7 个文件
exit=0
```

**必检五节未被打乱**（`:40-46` 的 `1.身份声明 / 2.触发条件 / 3.强制加载 / 4.产物格式（硬要求）/ 5.返回要求`）：我改的两份 wrapper 都没有新增 `## N.` 级标题，只在 §2 内部加表格行与正文段。`fix-worker.md` 从 73 → 81 行，`verifier.md` 从 83 → 88 行，五节正文长度只增不减，五节标题一字未动。

```
$ node tools/check-wrapper-contract.mjs
全部 7 个角色：必填字段均在「产物格式」小节内写成强覆盖。      exit=0
$ node tools/check-wrapper-contract.mjs --strict                  exit=0
```

### 3.2 `--baseline` 模式（即 `check-all` 实际跑的那个）

```
$ node tools/check-wrapper-integrity.mjs --baseline tools/fixtures/wrapper-baseline.json
⚠ audit-specialist   91   行数 91 < 基线 104（少 13%，已知未闭合）
⚠ critique-panel     93   行数 93 < 基线 145（少 36%，已知未闭合）
⚠ fix-worker         81   行数 81 < 基线 109（少 26%，已知未闭合）
✓ planner           162
⚠ recon-scout        85   行数 85 < 基线 106（少 20%，已知未闭合）
✓ sweep-scout       120
⚠ verifier           88   行数 88 < 基线 105（少 16%，已知未闭合）
合计: 0 项问题 / 5 项已知未闭合 / 7 个文件                     exit=0
```

**这 5 条 WARN 是既有问题**，`experiments/CHECKOUT-INCIDENT.md` 已判定「无源可恢复，不补写」，脚本内级别是 WARN（`check-wrapper-integrity.mjs:120-139` 有明确注释说明为何从 FAIL 降级）。**我没有为了凑行数补写任何内容。** 我的改动让 `fix-worker` 从「少 33%」变成「少 26%」，是新增规则条文的副作用，不是补行数的目的——`CHECKOUT-INCIDENT.md` 明写「没有 transcript 佐证的段落，我不会凭空补写」。

### 3.3 `check-all.mjs`

```
$ node tools/check-all.mjs
…（20 个检查项全部通过）
──────────────────────────────────────────
✅ 全部通过
EXIT=0
```

单独看的两个相关项：

```
$ node tools/check-wrapper-integrity.test.mjs   → 13 通过 / 0 失败
$ node tools/lint-autonomy.test.mjs             → 18 通过 / 0 失败
$ node tools/lint-autonomy.mjs                  → L1..L19 全 ✅（含 L16 加载量：fix-worker 未超 1300 行上限）
```

`lint-autonomy.mjs` 是我改动后最需要复核的一个（19 条活规则守卫）：新增文字里有「不得」「必须」「没有…这条路」等祈使句，全部落在已有豁免语义内，L1（不得要求用户值守）、L3（attempt 不得归零）、L8（不得全量重跑）均未误报。

---

## 4. 结构性断裂的记录（按任务书要求，只记不改）

### 4.1 `fix-worker.md` 的内容缺失（既有，未修复）

`CHECKOUT-INCIDENT.md` 记录 109 → 70，实际改动前是 **72 行**（README/事故文档里的数字与实际有偏差）。我的改动后是 80 行。

**在修改时观察到的结构性线索**（不补写，只记录）：

1. **`verifier.md` / `fix-worker.md` 都缺 `artifacts/report-naming.md` 引用**。`audit-specialist.md` 有 3 处、`sweep-scout.md` 有 3 处，而这两个同属「需要写产物文件」的角色却 0 处。`check-wrapper-integrity.mjs:53` 的 `KEY_PASSAGES` 把 `report-naming.md` 标为 `required: false`，所以检查器不报。**这大概率是事故中丢失的段落之一**（`report-naming.md` §5 规定「每个子Agent只允许写入属于自己的产物文件」，没有这句，子 Agent 不知道产物该叫什么名字、落在哪）。
2. **`fix-worker.md` / `verifier.md` 都缺 `sweep-scout.md:19-28` 的「加载路径警告」**。`planner.md` 和 `sweep-scout.md` 有，这两个没有。同一个问题（被复制到 `.claude/agents/` 后相对路径全指错）对它们同样适用。
3. **`verifier.md` 的 `frontmatter` 有 `Write`（`tools: Read, Grep, Glob, Bash, Write`），但正文 §1 写「你是**只读**角色，没有任何写权限」**。这是一处内部矛盾。`audit-specialist.md` 用 §2.5 单独解决了这个矛盾（「`Write` 的唯一用途：写你自己的产物文件」），`verifier.md` 没有对应小节。**这也像是事故中丢掉的段落。**

这三条我都**没有动**——任务书明确说「不要试图补写丢失的内容（无源可恢复），只修正现有的这处语义」。但第 3 条是内部矛盾，不是缺失，值得下一次单独处理。

### 4.2 我这次没有把「实例唯一性」做成可机械校验的

见下一节。

---

## 5. 这个改动能否真的阻止「一个实例修多条 finding」？

**结论：能挡住「无申报的合并」，挡不住「有申报的合并」，也挡不住完全不读规则的人。分三层说。**

### 5.1 有强制力的部分（真正的护栏）

只有一处：**`stop-hook.mjs:200-227`（R1 的改动，不是我的）**。

它比较两个数字：`distinct(fix_contracts[].finding_id).size > 1` 且 `budget.spawned_fix_agents <= 1` → **退出码 2，拒绝结束回合**。这是 harness 机制，不是提示词。它不依赖执行者读没读文档，也不需要任何人「自觉」。

**但它的覆盖面很窄**，至少四个绕法：

| 绕法 | 为什么能过 |
|---|---|
| 把 5 条 finding 的 `fix_contracts` 全填 `fix_agent_id` 为 5 个不同字符串，实际用 1 个 session 做完 | `spawned_fix_agents` 是**主Agent自己写的计数**，hook 无法验证 5 个 id 是否对应 5 个真实实例 |
| 5 条 finding 只登记 1 条 `fix_contract`，其余不登记 | `findingIds.size == 1`，判据不触发。而 `fix_contracts` 非空就满足相位交付物（`stop-hook.mjs:166`） |
| 把所有 finding 的 `target_files` 都写成同一个文件 | §0.3 的合并规则会「合法地」允许合并——判据是「集合相等」，而集合相等是主Agent自己填的 |
| 环境里根本没有 `subagent` 能力（L-C 级 harness） | 规则无法执行，而框架的兜底是「记 `discipline_log` 申报」，申报了就算合规 |

第 2 条最要命：**`spawned_fix_agents` 与 `fix_contracts` 都是主Agent自述，两个自述互相对账不产生外部约束力**——这正是 `run-state.md:49` 已经点明的问题（「它记录的就不再是派发事实，而是主 Agent 对自己工作的印象，和被审计的对象是同一个人」），而 R1 的 hook 只解决了「数字要一致」，没解决「数字要真」。

### 5.2 我的文档改动提供了什么

**提供的是「判据」而不是「执法」**：

1. **把「可并行」改成「必须一个 finding 一个实例」**，加粗位置从串行移到实例数上。这消除了原来那条规则的**语义倒置**——旧文案读起来像「默认并行、冲突时串行」，实际执行者读到的是「串行是常态」。这是实测那次 0 次 subagent 调用的直接诱因。
2. **给出可机械复核的失败判据**：`FIX_INSTANCE_MERGED` 记录的 `mechanically_checkable` 字段写明「两条 finding 的 `target_files` 排序后逐元素相等」。这让「合并是否合规」变成一个**字符串比较**，而不是需要理解内容的判断——符合 `protocol.md` §1.2 禁止主 Agent 做内容判断的边界。**但没有任何工具在查这个字段**（我没被允许改 `tools/`）。
3. **堵住了 R3 契约层提供的合法通道**（§2.2），否则新契约会提供一个「多条 disposition 是正常的」的口实。

**判据完备 ≠ 判据被执行。** 我写的是「什么算违规」，不是「违规会被抓」。

### 5.3 结论与建议

| 问题 | 现在能不能挡住 |
|---|---|
| 一个实例修多条 finding，**且不申报** | **能**——`stop-hook.mjs` 会拒闭合（前提：`fix_contracts` 登记了多条） |
| 一个实例修多条 finding，**申报为合并** | **不能**——合并规则允许它，判据是主Agent自己填的集合相等 |
| 一个实例修多条 finding，**少登记 `fix_contracts`** | **不能**——`spawned_fix_agents` 与 `fix_contracts` 同为自述 |
| 「可并行」被读成「可串行」 | **能（这才是 R5 的主要收益）**——语义倒置已消除，`MANUAL.md` 用「不要这样做」直接点名了那个反模式 |

**要真正变成护栏，还需要一个我这次没做（也没被允许做）的东西**：把 `FIX_INSTANCE_MERGED` 的申报做成可校验的记录，并加一个 `check-fix-instances.mjs`：

```
输入：state.json 的 fix_contracts[] + discipline_log[] + budget.spawned_fix_agents
检查 1：distinct(finding_id) > 1 且 spawned_fix_agents <= 1 → FAIL
检查 2：一个 fix_agent_id 对应多个 finding_id 时，discipline_log 必须有
        FIX_INSTANCE_MERGED 且 merged_finding_ids 与该 fix_agent_id 的 finding 集合相等
检查 3：FIX_INSTANCE_MERGED.shared_target_files 与对应 finding 的 target_files
        逐元素相等（不是「有交集」）
检查 4：fix_contracts[] 的 finding_id 集合 ⊇ UPHELD 报告里的 finding_id 集合
        —— 这条才挡得住「少登记」，它需要一个外部基准（最终报告的裁决索引表）
```

**检查 4 是关键**：前三项都在自述内部对账，只有第 4 项把 `state.json` 与**最终报告**（另一个文件、由另一条路径产生）交叉比对，才能发现「少登记」。这需要读 `round{N}-final-report.md` 的裁决索引表——而那正是 `artifacts/final-report.md` 已经规定的固定第 2 节。**材料齐了，缺的只是那个脚本。**

我不建议现在再加规则文字。这一轮已经把语义从「许可」扭成「义务」，再加语的边际收益接近零；下一步应当是**把 `FIX_INSTANCE_MERGED` 从散文变成被校验的记录**。
