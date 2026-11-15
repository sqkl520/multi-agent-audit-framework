# FIX-R7 报告 · 修复相位退化的端到端集成测试

**任务**：新建 `tools/fix-phase-e2e.test.mjs`，用合成 fixture 重演 hilltop-dsh 那次「7 份产物、38 条发现、只修 6 条、2 条 HIGH 至今在代码里、框架全程零报错」的事故，证明 R1/R3/R4/R6 每一层防线现在都会响。
**日期**：2026-11-15
**改动范围**：只新建 `tools/fix-phase-e2e.test.mjs`（1 个文件，+约 620 行）。未改任何其他文件，未 commit。

> **关于 `check-fix-instances.mjs`（R6）**：我接手时它和它的自测都不在 `tools/` 下（`git ls-files` 无记录）。写测试期间有并行 agent 落盘了 `tools/check-fix-instances.mjs` + `.test.mjs`（未跟踪）。我按它的实际行为写断言，没有改它。它自己的自测现在是 **96 通过 / 0 失败**。这条时间线影响本报告「保护力」一节的判断，见第四节。

---

## 一、测试形态与自证

| 项 | 内容 |
|---|---|
| 运行 | `node tools/fix-phase-e2e.test.mjs` |
| 结果 | **48 通过 / 0 失败，exit 0** |
| 依赖 | 仅 `node:child_process` / `node:fs` / `node:path` / `node:os` / `node:url`，无第三方依赖 |
| fixture | 写到 `mkdtempSync(tmpdir(), 'fix-e2e-')`，每个场景 `finally` 里 `rmSync` 清理（跑完 `/tmp` 无残留） |
| 调用方式 | `execFileSync` 调**真实脚本**，不 mock；退出码用 `e.status` 取 |
| 风格 | 沿用 `stop-hook.test.mjs` / `check-disposition-coverage.test.mjs`：`expect(label, cond, detail)` + `✓/✗`，末尾 `process.exit(fail>0?1:0)` |

每个断言 label 都带 **`[R编号/工具名]`** 前缀。测试失败时 `✗ A1 [R1/stop-hook] ...` 直接指出「哪一道门没关上」，不需要回读代码。

### 1.1 fixture 与真实事故的对齐

合成数据严格对齐事故的数字，但**不复制真实产物内容**（真实数据会随修复漂移，判据不该随它漂移）：

| 维度 | 真实事故 | fixture |
|---|---|---|
| 产物数 | 7 | 7（`round1-core` / `round2-ai` / `round2-arena` / `round2-mechanics` / `round3-A` / `round3-B` / `round3-C`） |
| finding 总数 | 38 | 38 |
| 严重性分布 | 8 HIGH / 22 MEDIUM / 8 LOW | 8 / 22 / 8 |
| 修了几条 | 6（15.8%） | 场景 A 登记 6 条 |
| 仍在代码里的 HIGH | `R2-mech F3`、`R3-A A-01` | 场景 A 未登记的那 2 条**正好就是** `round2-mechanics::F3`、`round3-A::A-01` |
| 派发实例数 | 1 个 session | `budget.spawned_fix_agents: 1` |
| 红测日志位置 | `target/`（被 `mvn clean` 删光） | 一条产物 `red_log_path: 'target/red.log'` |

唯一的人为调整：`round3-A::A-04` 的 `evidence.file` 也写成 `ConfigManager.java`，为的是在场景 B 里构造一个「两条 HIGH 的 `target_files` 完全相同」的**合法合并**，让 `FIX_INSTANCE_MERGED` 分支真正被走到（否则那段代码在 e2e 里等于没测）。

---

## 二、三个场景的断言清单与实测输出

### 场景 A：重演真实事故 —— 四层必须全部报警

**构造**：`path_mode: FIX`、`phase: wave4`、`fix_contracts` 只有 6 条（同一 `fix_agent_id`）、`budget.spawned_fix_agents: 1`；7 份审计产物共 38 条 finding；`final-report.md` 的「A. 裁决索引表」8 条 HIGH 全部 `UPHELD`；去向表为空表；一条修复产物 `red_log_path: 'target/red.log'`。

**实测输出（原文）**：

```
=== 场景 A：重演真实事故（单实例串行 6 条 / 去向表空白 / 红测日志在 target/）===
  ✓ A1 [R1/stop-hook] 拒绝结束回合（exit 2）
  ✓ A1 [R1/stop-hook] 理由含「多条独立缺陷在单个实例里串行完成」
  ✓ A1 [R1/stop-hook] 理由指出面板下限（T0/T1/T2）
  ✓ A1 [R1/stop-hook] 拦阻理由不是「相位尚未闭合」而是串行（判据可定位）
  ✓ A2 [R6/check-fix-instances] exit 1
  ✓ A2 [R6] 报出规则 upheld_without_fix_contract
  ✓ A2 [R6] 未登记计数恰好是 2
  ✓ A2 [R6] 点名仍在代码里的 round2-mechanics::F3
  ✓ A2 [R6] 点名仍在代码里的 round3-A::A-01
  ✓ A2 [R6] 不点名已登记的 round2-ai::R2-AI-001
  ✓ A2 [R6] 消息里明确「缺口 2 条」
  ✓ A3 [R4/check-disposition-coverage] exit 1
  ✓ A3 [R4] 分母是 38 条 finding
  ✓ A3 [R4] 38 条全部未表态
  ✓ A3 [R4] 逐条报 finding_without_disposition（38 条，不是只报一个百分比）
  ✓ A3 [R4] 逐条消息里点名 HIGH（round3-B::B-01）
  ✓ A4 [R3/check-payload] exit 非 0（契约违规）
  ✓ A4 [R3] 报出规则 red_log_in_target
  ✓ A4 [R3] 消息指出会被 mvn clean 删掉
  ✓ A5 [R6] 同时报 merged_without_record（单实例吞 6 条且未申报合并）
```

`A1 的「拦阻理由不是相位尚未闭合」这一条是有意加的`：stop-hook 在 wave4 有多个判据（无 `current_plan`、相位未闭合、`fix_contracts` 为空、串行）。fixture 把 `current_step` 设成超过总步数，让「相位未闭合」不触发，于是 A1 拦下来的**唯一理由**必须是串行——否则这条断言可能被别的判据顺带满足，等于没证明 R1 的核心规则生效。

### 场景 B：按规则修好 —— 四层全绿

**构造**：8 条 HIGH 全部登记、8 个 distinct `fix_agent_id`、`spawned_fix_agents: 8`、`discipline_log` 有一条 `FIX_INSTANCE_MERGED`；去向表 38 行填满（8 条 FIXED / 30 条 DEFERRED）；红测日志改为 `experiments/round1/red-*.log`。

**实测输出（原文）**：

```
=== 场景 B：按规则修好（逐条派发 + 去向表填满 + 红测日志移出 target/）===
  ✓ B0 [R1/check-state] exit 0（wave4 合法 + 8 条契约字段完整）
  ✓ B1 [R1/stop-hook] exit 0（8 个实例 > 1，不再判串行）
  ✓ B2 [R6/check-fix-instances] exit 0
  ✓ B2 [R6] 未登记数为 0
  ✓ B2 [R6] 没有 FAIL
  ✓ B3 [R4/check-disposition-coverage] exit 0
  ✓ B3 [R4] 38 条全部已表态
  ✓ B3 [R4] 没有 HIGH 悬空
  ✓ B4 [R3/check-payload] exit 0（FIXED + test_path + target/ 外红测日志）
  ✓ B4 [R3] 明确 ok=true
  ✓ B5 [R6] spawned=9 但只有 8 个 distinct agent → exit 1（机器化对账抓自述不一致）
  ✓ B6 [R6] 真实合并（8 条 → 7 实例，已申报）→ exit 0
  ✓ B7 [R6] 无 FIX_INSTANCE_MERGED → exit 1（合并必须申报）
```

B0/B5/B6/B7 是附加的反向断言：**只测「怎么才能绿」会漏掉「绿得对不对」**。B5 把 `spawned` 改错 1 个数就必须变红；B6 用真实的「2 条共用一个实例 + 已申报」证明合法合并**不会**被误拦（否则合并功能一上线就被判违规，人会直接把合并申报删掉）；B7 把申报抽掉就必须变红。

### 场景 C：绕过尝试「全填 DEFERRED」—— 两层互补

**构造**：去向表 38 条全填 `DEFERRED`，依据写「暂缓：本轮不处理，等下一轮统一评估」（≥10 字，过 R4 的门槛）；`fix_contracts` 为空。

**实测输出（原文）**：

```
=== 场景 C：绕过尝试（去向表 38 条全填 DEFERRED，fix_contracts 为空）===
  ✓ C1 [R4/check-disposition-coverage] exit 0（覆盖率 100%）
  ✓ C1 [R4] 未表态数为 0
  ✓ C1 [R4] 合计 38 条全部已表态
  ✓ C2 [R4] 输出里有 high_severity_unaccounted 警告
  ✓ C2 [R4] 警告级别是 WARN（默认不阻断，但必须可见）
  ✓ C2 [R4] 警告写明「8 条 HIGH」
  ✓ C2 [R4] 8 条 HIGH 全部被点名
  ✓ C3 [R6/check-fix-instances] exit 1（去向表满也救不了没派发）
  ✓ C3 [R6] 报 upheld_without_fix_contract
  ✓ C3 [R6] 未登记计数是 8（全部 UPHELD HIGH）
  ✓ C3 [R6] 点名 round2-mechanics::F3（填了 DEFERRED 也照样点名）
  ✓ C4 [R4] 依据只写「暂缓」→ exit 1，报 disposition_missing_reason
  ✓ C5 [R4] --strict-high 下同一条去向表 → exit 1（HIGH 悬空升级为 FAIL）
  ✓ C6 [R1/check-state] fix_contracts 为空 → exit 1，报 fix_contracts_required
  ✓ C7 [R1/stop-hook] 修复相位 fix_contracts 为空 → exit 2
```

**这个场景是三个里最有价值的**，因为它把「两层防线互补」变成了可执行断言：

- R4 的职责是**表态完整性**。全填 DEFERRED 之后它确实 exit 0——这是设计正确，不是漏洞：`DEFERRED` 本来就是合法处置，去向表的意义是「不许静默消失」。
- 但 R4 不会就此闭嘴：它必须报 `high_severity_unaccounted`，并逐条点名 8 条 HIGH（C2 对 8 个 id 各做了一次正则断言，不是只看规则名在不在）。
- R6 的职责是**外部基准对账**。去向表填得再满，只要 `fix_contracts` 为空、裁决表里 8 条 UPHELD 没进登记，它照样 exit 1 并点名（C3）。
- 把 R4 单独拿出来看，C1 会让人以为「过了」；把 R6 单独拿出来看，它根本不读去向表。**只有二者都在，才同时约束「每条都表态」和「每条都真派发」。**

---

## 三、每一层防线的拦截证据（工具 / 退出码 / 原文消息）

以下为直接调用真实工具的原文摘录（fixture 同场景 A）。

### 3.1 R1 · `stop-hook.mjs` —— 多缺陷单实例串行

- **命令**：`node tools/stop-hook.mjs --state stateA.json`（stdin `{}`）
- **退出码**：**2**（拒绝结束回合，stderr 回灌给模型）
- **stderr 原文**：

```
[交付粒度检查] 还不能结束这一回合：

1. wave4 里有 6 条独立缺陷（round2-ai::R2-AI-001, round2-ai::R2-AI-002, round2-mechanics::F1, round2-mechanics::F2, round3-A::A-04…），但账本记录的修复派发实例数是 1。
多条独立缺陷在单个实例里串行完成，违反 triage.md 的面板下限（T0≥3 / T1≥5 / T2≥9，triage.md §3「取消降级路径」）。
修复相位没有 Skeptic 执法（Skeptic 只在 wave3），所以这条只能由本 hook 拦。
请按缺陷逐条派发独立实例，并把实际派发数写进 budget.spawned_fix_agents（实际计数，不得估算）。
```

**这正好是那次事故的形状**：6 条 finding 一个实例。如果当时有这个判据，事故在**第一个回合结束时**就会被踢回来。

### 3.2 R6 · `check-fix-instances.mjs` —— UPHELD 少登记

- **命令**：`node tools/check-fix-instances.mjs --state stateA.json --report reportA.md --json`
- **退出码**：**1**
- **totals 原文**：

```json
{"reportRows":8,"upheld":8,"registered":6,"accounted":6,"missing":2,"spawned":1,"instances":1,"merges":0,"contractRows":6,"notUpheldWarn":0,"notUpheldFail":0}
```

- **problems 原文**（两条 FAIL）：

```
FAIL upheld_without_fix_contract | 2 条 UPHELD 发现没有进入任何修复登记：round2-mechanics::F3、round3-A::A-01。它们不是因为「判定不修」而缺席（那需要 WONT_FIX），而是根本没被派发——`final-report.md` 的裁决索引表是外部基准，`state.json` 少登记一条，`stop-hook` 的 `findingIds.size` 就少 1，判据可能整个不触发。
   已登记 6 条，UPHELD 8 条，缺口 2 条。

FAIL merged_without_record | fix_agent_id "fix-session-1" 承担了 6 条 finding（…），但 discipline_log 里没有对应的 FIX_INSTANCE_MERGED 记录。
```

**关键**：点名的是**外部基准**（`final-report.md` 的裁决表）里存在、而 `state.json` 里不存在的两条。这正是 R5 指出的缺口——`spawned_fix_agents` 与 `fix_contracts` 都是主 Agent 自述，两个自述互相一致不产生约束力；裁决表是与 `state.json` 独立产生的第二份文件，少登记在那里藏不住。

### 3.3 R4 · `check-disposition-coverage.mjs` —— 发现从未表态

- **命令**：`node tools/check-disposition-coverage.mjs --artifacts artifacts/ --ledger ledgerEmpty.md --json`
- **退出码**：**1**
- **totals 原文**：

```json
{"findings":38,"rawFindings":38,"accounted":0,"unaccounted":38,"newFindings":0,"high":8,"highUnaccounted":8,"severity":{"MEDIUM":22,"HIGH":8,"LOW":8}}
```

- **problems**：44 条（38 条 `finding_without_disposition` + 撞名/无去向类），每条点名一个 `scope::id`。首条原文：

```
cross_artifact_id_collision | finding_id "F1" 在 4 份产物里重复（round1-core、round2-arena、round2-mechanics、round3-C）——去向表必须用 scope::id 指定，裸 "F1" 会被判为歧义
```

**分母口径正确**：38 条，不是「7 份产物」也不是「6 条修过的」。这是那次事故最容易被误判的地方——用计数口径看，6/38 和 38/38 的「产物合规性」是一样的。

### 3.4 R3 · `check-payload.mjs` —— 红测日志落在 target/

- **命令**：`node tools/check-payload.mjs fix-1.md --role fix`
- **退出码**：**1**
- **stdout 原文**：

```
  ✗ 1 项违规:

    [red_log_in_target] payload.red_log_path
      red_log_path 指向构建产物目录（target/red.log），会被构建清理（如 mvn clean / gradle clean / rm -rf target）删掉，验收时无法复核「修复前是红的」。2026-11-15 真实教训：红测日志就放在 target/ 下，被整个删光，导致本次修复的证据不可复核。请写到 target/ 之外（例如 experiments/<round>/red-<finding>.log）
```

---

## 四、发现的防线漏洞（如实记录）

测试全绿，但我另外跑了四个**绕过探针**（不属于本次交付文件，只用于评估保护力）。有两个是真洞，且都不是「实现 bug」，是**判据的认知边界**。

### 洞 1（严重）：1 个真实 session + 8 个假 `fix_agent_id` = 全绿

```
HOLE-1 8 fake ids, spawned=8, all 8 registered:
  stop-hook exit 0 | R6 exit 0 | missing 0 | rules []
  => 完全绕过：1 个真实 session 派 8 个假 id，两道门全绿
```

我构造：8 条 HIGH 全部登记成 8 个**不同**的 `fix_agent_id`（`fake-agent-1..8`），`spawned_fix_agents: 8`，每条 `target_files` 不同。主 Agent 实际上仍然是 1 个 session 串行做完——但账本上看起来完美。

- **为什么两道门都放行**：stop-hook 比较的是 `distinct(finding_id)` 与 `spawned_fix_agents`，后者是自述；R6 比较的是 `distinct(fix_agent_id)` 与 `spawned_fix_agents`，也全是自述。**两个自述互相一致，仍然不产生外部约束力。**
- 这一点 R5 报告 §5.1 和 `check-fix-instances.mjs` 文件头其实**已经写明了**（「第 1 种绕法：hook 无法验证 5 个 id 对应 5 个真实实例」）。我的探针只是把它从「文档里承认的边界」变成「可复现的实测结果」。
- **这恰好就是那次真实事故的形态**：0 次 `subagent` 调用。也就是说，**如果有人刻意伪造，这套防线挡不住**。
- 能挡住的只有 harness 侧证据（真实 subagent 调用记录）。账本里没有这个信息，所以这不是 R6 能修的问题——需要 Stop hook 读 harness 的调用计数，属于 R1 的下一层。

### 洞 2（中等）：HIGH 填 `WONT_FIX` 可以洗掉 `high_severity_unaccounted`

```
HOLE-2 HIGH 全填 WONT_FIX + 默认     -> exit 0 | highUnaccounted 0 | has high warn false
HOLE-2 HIGH 全填 WONT_FIX + --strict-high -> exit 0 | highUnaccounted 0 | has high warn false
```

`high_severity_unaccounted` 的判据是「HIGH 处于 `DEFERRED` **或无去向**」。如果把 8 条 HIGH 全填 `WONT_FIX`（理由写够 20 字），警告**完全消失**，连 `--strict-high` 也救不回来——因为规则根本没被触发。

- `disposition-ledger-example.md` 自己已经记过类似情况（A-04 记 `WONT_FIX` 就不计入悬空），并注明「HIGH 还剩几条的真实答案是 2 条，不是 3 条」。所以这也是**已知边界**。
- 危害等级低于洞 1：`WONT_FIX` 需要写 ≥20 字论证，且 R6 的 `upheld_without_fix_contract` 仍然独立要求这 8 条 HIGH 有 `fix_contract`——**如果只填去向表而不派发，洞 2 绕不过 R6**（场景 C 已证明）。只有「填 WONT_FIX + 真的派发并修了 + 但其实没修好」这一条缝隙是敞开的。
- 建议（不在本次交付范围）：`high_severity_unaccounted` 应把 `WONT_FIX` 也纳入，或单开 `high_wont_fix_unreviewed` 并在 `--strict-high` 下升级。当前 `WONT_FIX` 的「不需要 `next_round`」使它比 `DEFERRED` 更省事——这正是绕法的动机。

### 洞 3（轻）：裁决表由主 Agent 自己写

```
HOLE-3 裁决表自填 DOWNGRADED + fix_contracts 空 -> R6 exit 0 | upheld 0 | rules []
  同一 state: stop-hook exit 2 (fix_contracts 空应拦)
```

把裁决表 8 条 HIGH 全改成 `DOWNGRADED`，R6 的 `upheld` 集合变成空，`missing = 0`，exit 0。这是 R6 设计上的固有前提——它把 `final-report.md` 当**外部基准**，但那份报告在流程上仍由主 Agent 落盘。R6 文件头对此是诚实的（「本脚本只保证登记集合与外部裁决一致」），且 `critique` 相位才是裁决表的产生者。缓解因素：同 state 下 stop-hook 仍 exit 2（`fix_contracts` 为空），所以单纯改裁决表不能全绿，要配合「连契约都删光」才行——那就同时撞上 stop-hook。

### 洞 4（轻）：红测证据只校验路径形状，不校验文件存在

```
red_log 指向不存在的文件（target/ 外）      -> exit 0 | rules []
test_path 指向不存在的文件                  -> exit 0 | rules []
red_log_path 写成 red.log（无目录）         -> exit 0 | rules []
```

`check-payload` 只做正则 `(^|\/)target\//`，不 `existsSync`。所以「把路径写成 target 之外，但这个文件从来没生成过」可以通过。成功拦住的是四种 target/ 写法（`target/x`、`./target/x`、`D:/.../target/x`、`../target/x`、绝对路径含 target）——R3 自测 case 105 覆盖了这些。**证据真实存在与否，仍要靠验收相位（wave5）人工/半自动核对。**

### 没有发现的漏洞

- 场景 C 的「填满去向表绕不过派发」：成立，R6 独立拦截（C3）。
- 「少登记一条」：成立，R6 按 id 点名（A2）。
- 「同文件合并未申报」：成立，`merged_without_record` 拦截（A5/B7）；且合法申报不会被误拦（B6）。
- 「`spawned_fix_agents` 记错」：成立，`spawned_count_mismatch` 拦截（B5）；缺失按 0 处理（R6 自测 case 8）。

---

## 五、这套防线对「下一个类似任务」的实际保护力

**结论：从「完全没有」提升到「挡住非恶意退化，挡不住刻意伪造」。**

用那次事故的两种成因分开评估更准确：

### 5.1 挡住的部分：无意识的退化（我判断占真实风险的绝大多数）

那次事故里 0 次 `subagent`、规则从未被加载、`phase` 枚举缺 wave4/wave5——这些都是**结构性缺失**，不是谁在故意规避。对这类退化，四层防线的拦截力很强：

| 退化形态 | 哪一层挡 | 实测 |
|---|---|---|
| 修复相位 stop-hook 完全不触发 | R1（phase 枚举 + 白名单） | A1：exit 2 |
| 一个实例串行修完所有 | R1（`distinct(finding_id)` vs `spawned`） | A1：exit 2 |
| 只登记部分 UPHELD | R6（对外部裁决表） | A2：点名 2 条 |
| 发现从未被表态 | R4（38 条分母逐条） | A3：38 条逐条点名 |
| 红测证据被构建清理 | R3（`red_log_in_target`） | A4：exit 1 |
| 修复相位什么都没登记 | R1（`fix_contracts_required`） | C6/C7 |
| 只填去向表、不派发 | R4+R6 互补 | C1 放行 / C3 拦截 |

**最重要的一点**：这几层的判据来源是**互相独立的文件**（`state.json`、7 份审计产物、`final-report.md`、去向表、修复产物）。主 Agent 要无意识地同时骗过它们，必须同时改五处并保持自洽——这已经不属于「退化」，属于「伪造」。而事故的成因恰恰是「没有任何一处要求它对齐」。

**量化一点的判断**：如果下一次有同样的 38 条发现、同样一个想「尽快交差」的主 Agent，这四道门会在**第一个 wave4 回合结束时**同时响起（exit 2 + 3 份不同工具的 FAIL）。那次事故的 196 step / 303 次调用里，没有任何一处会走到终点而不被点名。

### 5.2 挡住不了的部分：刻意伪造（洞 1）

如果执行者**知道**这套判据，它可以：给 8 条 finding 编 8 个 `fix_agent_id`、`spawned_fix_agents` 写 8、每条 `target_files` 写不同、去向表填 `WONT_FIX`（洞 2）、裁决表自己写。**全部工具 exit 0。**

这不代表防线没用，而代表**它把「无意退化」和「蓄意造假」区分开了**。在此之前，这两者在账本上长得一模一样（都是「全绿」）；现在前者会红，后者要红必须留下**五份自相矛盾风险**的痕迹。审计里这已经是实质性的改进。

若要堵洞 1，唯一有效的方向是引入 harness 侧的**不可自述证据**——`subagent` 实际调用次数、每个子 session 的 id / 起止时间。这需要停手在账本之外取证，不是再加一条 `state.json` 字段能解决的（再加一个自述字段只会增加洞 1 的伪装成本，不改变性质）。

### 5.3 对框架设计的一条观察

四道门里，**只有 R6 的判据来自主 Agent 不能单独控制的地方**（`final-report.md` 的裁决表由锐评相位产生）。其余三层的输入都在 `state.json` 或产物里，最终仍由主 Agent 落盘。

所以这套防线的**真实强度上限 = 裁决表有多可信**。而洞 3 显示裁决表本身也在主 Agent 手里。**下一个真正该做的事不是再加规则，是让裁决表的产生与落盘和主 Agent 解耦**（例如锐评 arbiter 直接写、主 Agent 只读）。这条建议我写在这里，不擅自实施。

---

## 六、交付清单

| 文件 | 状态 |
|---|---|
| `tools/fix-phase-e2e.test.mjs` | **新建**（唯一改动），48 断言全绿 |
| `experiments/hilltop-dsh/FIX-R7-report.md` | **新建**（本文） |

未修改任何现有文件，未 commit。（工作区里 `tools/check-all.mjs` 的改动、`tools/check-fix-instances.mjs` 与其自测的新增，来自并行 agent，不是我做的；我只读了它们。）
