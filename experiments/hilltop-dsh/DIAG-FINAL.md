# 提示词诊断：这套框架为什么退化成单 agent

**日期**：2026-11-15
**方法**：5 个专家 agent 独立取证 + 我逐条回源码核实。三轮派发，前两轮因 ECONNREFUSED 全量重跑。

**证据来源**
- `DIAG3-prompt-structure.md`（1019 行）
- `DIAG3-session-forensics.md`（27KB）
- `DIAG3-three-layer-closure.md`（522 行）
- `DIAG3-redteam-acceptance.md`
- `DIAG2-coverage-gap.md`（602 行）

---

## 一句话结论

**框架为「审计」写了一套完整的多 agent 纪律，为「修复」只写了角色没写纪律。而修复阶段恰好是所有强制手段（stop hook、相位枚举、Skeptic 执法）同时失效的相位。**

---

## 一、「这算一次性交付了吗」——不算

| 维度 | 实际 |
|---|---|
| 审计发现 | 38 条（8 HIGH / 22 MEDIUM / 8 LOW），独立数出 |
| 代码修复 | **6 条原始 + 1 条修复期新发现 = 7 次代码变更** |
| 覆盖率 | **15.8%** |
| 从未进入任何任务书 | **31 条** |
| 其中 HIGH | **2 条，在 HEAD 上仍然存在** |

### 两条被漏掉的 HIGH，我独立核实为真

**`NodeSystem.addNode`（`:381`）** —— 返回值被丢弃，写盘失败仍报成功：

```java
saveNodesToConfig();
return 0; // 成功
```

`#4` 的修复**改过这个文件**，新写的 `restoreNodesForWorld` 正确检查了 `writeNodes` 返回值，
只是没回头看 150 行上方这个相邻函数。

**`monsters.*.health`（`ConfigManager:1717`）** —— 完全没钳制：

```java
if (settingsYaml.contains("monsters." + key + ".health"))
    mc.setHealth(settingsYaml.getDouble("monsters." + key + ".health"));
...
if (settingsYaml.contains("monsters." + key + ".explode-damage-multiplier")) {
    double rawExplode = ...;   // ← #7 刚刚给它加了钳制
```

`#7` 在同一段代码里加了三个 `normalize*`，跳过了与它相邻三行、同样缺钳制的 `health`。

### 丢失点：不是抄漏，是「没有东西要求逐条表态」

`task-repair.md` 全文 `grep finding_id` = **0 次**。
没有任何文件记录「为什么是这 5 条、剩下 31 条怎么办」。
所以事后无法区分「有意暂缓」和「单纯忘了」。

---

## 二、agent 安排合理吗——三层证据说「不合理」

### 2.1 事实：三次修复运行，`subagent` 调用 0 次

| session | depth | 工具调用 | subagent | 说明 |
|---|---|---|---|---|
| e0582c67 | 0 | 113 | **0** | 第一次（沙箱挡住） |
| a40f0162 | 0 | 303 | **0** | 196 step 单 session 干完所有事 |
| d5ad7820 | 0 | 129 | **0** | #8 |
| 审计主 session ×2 | 0 | 149/160 | **3 / 3** | 对照组 |
| 审计子 session ×7 | 1 | 61~110 | 0 | 对照组的产物 |

唯一差别：任务书里写没写「并行派 subagent」。

### 2.2 根因判定：「没想到」，不是「想到但否决」

48.5 万字符 reasoning 的机械统计：

| 会话 | reasoning 块 | 字符数 | `subagent` | `并行` | `分解` |
|---|---|---|---|---|---|
| e0582c67 | 59 | 116,484 | **0** | 0 | 0 |
| a40f0162 | 165 | 239,507 | **0** | 0 | 0 |
| d5ad7820 | 71 | 129,401 | **0** | 0 | 0 |
| **合计** | **295** | **485,392** | **0** | **0** | **0** |

4 次松散命中全是误报：并行读文件、Java 方法重载的 `delegates`、模型复述我任务书里的「派给你」。

原文判定：

> **not merely absent from consideration, but absent from the vocabulary of the reasoning stream.**
> There is no passage anywhere in 485k characters where the main agent weighs delegating work,
> enumerates it as an option, or rejects it for a reason.

**这推翻了我的原假设。** 我以为它「判断修复该串行」，事实是「派发」**从未进入考虑范围**。
任务书里明明有四个编号缺陷——**明显可分解的任务，没有触发分解**。

**推论：修复方案不是「纠正错误的价值判断」，而是「提供一个能被模式匹配到的、任务形状的触发条件」。**

### 2.3 为什么从没被触发：修复侧规则一次都没加载

`START-HERE.md:52` 逐字：

> 「默认只读：跑完 侦察 → 宽扫 → 深挖 → 锐评 → 报告 就结束。**修复是另一件事**，
> 等我明确说'修复 round{N}'才启动。」

而 `START-HERE.md:43-46` 的加载清单只有三个文件：
`environment-probe.md` / `protocol.md` / `run-state.md`。

**没有任何一处告诉用户「启动修复时要给主 agent 什么」。**

实测：`task-repair.md` 和 `task-repair-8.md` 对框架规则文件的引用 **0 次**。结果：

- `fix-worker.md` **从未被加载**
- `wave4-fix.md` **从未被加载**
- `wave5-verify.md` **从未被加载**
- `output-contract/fix.md` **从未被加载**
- `triage.md`（3/5/9 下限）**从未被加载**

**规则没进上下文，写得多好都没用。**

---

## 三、框架结构性缺陷（按严重度）

### S1 级——单独足以解释 0 次 subagent

**S1-1｜修复相位没有入口文档**
`START-HERE.md:52` 把修复排除在外，却不指向替代入口。修复侧全部规则文件从未进入上下文。

**S1-2｜唯一的并发约束句语义反向**

`fix-worker.md:33`：

> 「| 并发约束 | 不同 `target_files` 的修复**可**并行；
> **共享同一文件的修复必须串行**，由主Agent排序 |」

- 「可并行」是许可不是义务
- 加粗落在「必须串行」上
- 「由主Agent排序」把主 agent 定义为**排序者**而非**派发者**——排序是串行原语

对比 `sweep-scout.md:71`：「**实例唯一性**：一个切片一个实例，**不得**让一个实例承担多个切片。」
修复相位**没有对应物**。

**S1-3｜修复链路四个文件均无「实例唯一性」段**
`fix-worker.md` / `verifier.md` / `wave4-fix.md` / `wave5-verify.md` 中，
「实例」一词只出现在**失败重派**语境，从未作为派发计量单位。

### S2 级——叠加后必致

**S2-1｜`triage.md` 的 3/5/9 下限有三重加载断裂**

- `START-HERE.md:43-46` 加载清单不含 `triage.md`
- `triage.md:5` 声明由 `planner.md` 加载，而 `planner.md:9` 的 `trigger_event: TASK_RECEIVED` **没有触发者**
- `compatibility.md:5` 声明先于 `triage` 加载，但自己也 abstain

规则极硬（`triage.md:224`：「七项缺一不可。缺任何一项不得派发。」）但读不到。
实测用 1 个，**低于 T0 下限 3**。

**S2-2｜`triage_skipped` 字段不存在**
`planner.md:61` 要求「跳过也要在账本记 `triage_skipped`」。
`grep -c triage_skipped framework/artifacts/run-state.md` = **0**。要求往不存在的字段写。

**S2-3｜`scale-mapping.md:34` 在 L-B 上把算术交出去**

> 「→ **派发量由 harness 在运行时决定，本文件不预设**」

dsh 有 `subagent` 并发 → 判定「有并发能力」→ 跳过全部算术。
但 **dsh 的 harness 只提供 `subagent` 原语，不决定派几个**。

**S2-4｜L0 全是禁令，唯一正向义务被标「已失效」，执法者在修复相位不存在**

- `protocol.md:699-707` 的 L0 七条**全部是「不得」**
- 唯一把「派发」写成主 agent 唯一合法动作的表述被 `protocol.md:666-674` 标注为**「原禁令与其失效」**
- L0 执法者是 Skeptic（`protocol.md:751-753`），而 Skeptic 只在锐评相位（`critique-panel.md:8` 的 `wave: 3`）
- 修复相位是 `wave: 4`，**没有 Skeptic**

**修复相位是 L0 的执法真空。**

### S3 级——加重

- `protocol.md:208`「按发现**逐条推进**」——「逐条」是 one-at-a-time
- `protocol.md:1009`「波次之间**不是并行扇出**」——加粗在否定句上
- `compatibility.md` 的 L-A/B/C/D 判据 5 项里只有 1 项可机械执行，兜底「按最保守 L-C」= **9 串行**
- `compatibility.md:227` 与 `environment-probe.md:48-52` 对同一 harness 给出**相反路径**
- `wave2a-sweep.md:468`「而不是一上来就 6 维扇出」写成带「因此」的普遍原则
- `fix-worker.md` 内容缺失 33%（checkout 事故），检查器只验结构不验语义

---

## 四、三层闭环：断在第 2 层

**断裂点不在层 3 的「没写」，而在层 2 的「没定义字段」——层 3 因此没有可校验的对象。**

「该派子 agent 却单 session 串行干了」在 `state.json` 的 schema 里**不是字段**。

### 关键证据：`path_mode` 有 FIX，`phase` 没有

```
run-state.md:53     "path_mode": "AUDIT_ONLY | FIX",
run-state.md:54     "phase": "init | wave1 | wave2a | wave2b | wave3 | report | closed",
check-state.mjs:55  phase: ['init','wave1','wave2a','wave2b','wave3','report','closed'],
stop-hook.mjs:70    if (['wave2a','wave2b','wave3'].includes(state.phase)) {
```

**框架知道存在 FIX 路径，却没给它分配相位值。** 后果连锁：

1. `stop-hook.mjs` 白名单不含 wave4/wave5 → **修复阶段完全不被门控**
2. 框架自己说提示词是弱手段、只有 harness 机制是强手段（`protocol.md:445-450`）→ 修复阶段只剩弱手段
3. `final-report.md:25` 又**要求**修复路径「每条发现结束」出报告 → 每条一个停点 → 天然导向串行

### 闭环核对表

| 强制要求 | 层1 模板 | 层2 schema | 层3 校验器 |
|---|---|---|---|
| 每条发现带 file:line | ✅ | ✅ | ✅ |
| **必须派生子 agent** | ❌ 修复侧无 | ❌ 无字段 | ❌ 无法校验 |
| 修复先有失败测试 | ✅ | ⚠ 可选 | ❌ 无 |
| **HIGH 必须全修或给理由** | ⚠ 仅 `MANUAL.md:337` | ❌ | ❌ **无** |
| 任务书携带 finding_id | ❌ | ⚠ | ❌ |

---

## 五、校验器实测：三个假绿灯

### 5.1 `check-promises` 对 Java 完全空转

我亲手跑：

```
$ node tools/check-promises.mjs ".../src/main/java"
承诺兑现检查: 0 个文件
未发现「承诺未兑现」
exit=0
```

**161 个 `.java` 文件，扫描 0 个，报成功。** `walk()` 只收 `.js/.mjs/.cjs/.ts`。

另一个 agent 指出加 `.java` 也无效，因为 P1 规则要求「JSDoc 声称 `@returns` 但无 `return`」，
而 `loadFromFile()` 原来是 `void` 且无 Javadoc——**规则语义不匹配，不是扩展名问题**。我核实了这个修正。

### 5.2 `check-blindspots` 同样空转

```
$ node tools/check-blindspots.mjs ".../src/main/java"
未命中 B1/B2/B3/B4 四种形态
```

规则 B3（`:116`）是 `/typeof\s+\w+\s*!==\s*['"]number['"]/` —— **JS 语法，Java 没有 `typeof`**。
所以 A-01（`health` 无范围检查）、A-02（`total-mobs` 无上限）这些**本该被 B3 抓到的形态，一个都抓不到**。

### 5.3 `check-payload` 没有 fix 分支

- `:283` — `fix: ['files_touched']` 是 fix 角色的**全部**契约
- `:663` — `verdict_missing_for_target` 只对 **critique** 生效，
  文案是「漏审一条等于放它直接进入修复波」
- **没有 duplicate `finding_id` 检查**（另一个 agent 实测把 7 条 id 改成完全相同，仍报「✅ 契约合规」）

**框架要求「每条 finding 必须被锐评攻击一次」，但不要求「每条 finding 必须被修复或明确暂缓一次」。**

### 5.4 未被触发的校验器

`experiments/hilltop-dsh/` 下**没有 `state.json`**、**没有 `final-report.md`** →
`check-state` / `check-deliverables` / `gate` 全部未运行。

### 5.5 「7/7 契约合规」与 71 个 FAIL 并存

我亲手跑（注意必须带 `--repo` 和 `--artifacts`，否则报「未知参数」）：

```
$ node tools/verify-artifacts.mjs --repo ".../Hilltop Village Plugin" \
      --artifacts experiments/hilltop-dsh/out

合计: 71 FAIL / 6 WARN / 1 PASS / 3 SKIP
```

其中 3 个 SKIP 直接暴露了校验链的断裂：

```
- SKIP  [G8] 没有可对账的 line_count，跳过
- SKIP  [G5] 没有可校验的自述数字，跳过
- SKIP  [G4] 找不到 state.json，跳过账本对账
```

**G4 是账本对账，它跳过意味着「派了几个 agent / 修了几条」这件事从未被对账。**

而 `check-payload` **不检查路径存在性**，所以「7/7 契约合规」与 71 个 FAIL 能并存——
前者只验字段名对不对，后者验证据能不能落到真实文件上。**两个结论说的不是同一件事，但报告里并列呈现，读起来像自相矛盾。**

---

## 六、红队对我验收的攻击：两条成立

### A. 6 处 `文件:行` 引用已失效（一般）

`done-7.md` 声称钳制点在 `:1402-1410` / `:1484-1492` / `:1707-1716`。
实测在 `:1416` / `:1498` / `:1721`——**整体偏移 14 行**。

成因：第二轮在 `:1349` 和 `:1383` 又插入了 17 行。**我的验收没有重算行号，直接沿用了第一轮的数字。**

### B. 红测试日志全部消失（严重）

`ACCEPTANCE-ROUND1.md:31` 我写的是「三个证据文件存在且内容可信」。

但现在：

```
$ ls target/
classes  generated-sources  generated-test-sources  maven-status
surefire-reports  test-classes  test-tmp  verify-round2.log

$ find . -name "*red*.log"   → 无输出
```

**四个被引用的日志全部消失。** 成因：`build.cmd:12` 默认动作是 `mvn clean package`，
第二轮构建时 `mvn clean` 把整个 `target/` 删了。

**我的错误：把唯一证据放在会被构建清理的目录里，且验收后没立刻复制出来。**

我当时确实读到了断言原文（所以「存在且内容可信」在当时为真），
但**作为验收记录它现在不可复核**。正确写法是「证据已不可复核」，
或者把日志复制到 `repair/redlogs/` 并记 sha256。

---

## 七、修复方案（按性价比）

### R1 · 给 `phase` 枚举加 `wave4` / `wave5`（最小改动，最高杠杆）

```
run-state.md:54       "phase": "init | wave1 | wave2a | wave2b | wave3 | wave4 | wave5 | report | closed"
check-state.mjs:55    同步
stop-hook.mjs:70      白名单加入 wave4/wave5
```

这是**唯一能把修复阶段从「执法真空」拉回「有强制手段」的改动**。
框架自己承认只有 harness 机制是强手段（`protocol.md:445-450`），而现在这个强手段对修复相位不生效。

### R2 · 写一份 `START-HERE-FIX.md` 入口（对应 S1-1）

框架为审计写了 `START-HERE.md`（217 行），修复侧什么都没有。
需要一份对称的入口，包含：加载清单、派发数量算术、`fix-worker` 派发模板。

### R3 · 把 `verdict_missing_for_target` 复制给 fix 角色

在 `check-payload.mjs` 的 fix 分支加：

```
每条 finding 必须有 disposition ∈ {FIXED, WONT_FIX, DEFERRED, NEW_FINDING}
FIXED     → 必须有 test_path 且红测日志存在
WONT_FIX  → 必须有 reason（≥20 字）
DEFERRED  → 必须有 next_round 或 trigger
NEW_FINDING → 允许不在原清单，但必须标记
```

**效果：A-04-c（`#8`）会在 `#3` 的产物里被强制表态，不可能静默蒸发。**

### R4 · 强制产出「发现去向表」+ 机械对账

新增 `check-disposition-coverage.mjs`：

```
输入：out/*-audit.md 的 findings[]  +  disposition-ledger.md
断言：ledger 行数 == findings 总数
断言：finding_id 集合双向相等（无遗漏无杜撰）
断言：每行 disposition 非空
退出码：1 = 有 finding 没有 disposition
```

**效果：31 条未触动会在收口时一次性暴露为 31 个 FAIL。**

### R5 · 把 S1-2 的「可并行」改成和审计相位同构

```
fix-worker.md:33
  现在：不同 target_files 的修复可并行；共享同一文件的必须串行，由主Agent排序
  改成：每条 UPHELD 发现一个修复实例。
        不同 target_files 的实例并行派发；共享同一文件的实例串行，由主Agent排期。
        「共享同一文件」是必须做文件级依赖分析的唯一理由，不是串行的默认理由。
```

### R6 · 红测日志落到 `target/` 之外

`repair/redlogs/<编号>-<用例名>.log`，验收记录里写 sha256。

---

## 八、最重要的一个判断

框架在 `README.md:240` 自己承认了根本局限：

> 「**必须承认的局限**：Markdown 文件本身没有加载器……**纯提示词方案下，加载靠模型自律。**」

**这句话是整份诊断的钥匙。** 一个靠「自律」加载的规则集，
在审计相位运气好被加载了（因为我写了那句话），在修复相位没有。

而 `protocol.md:445-450` 说得更直白：

> 「| 提示词 | **弱**——Agent 可以判定某条不适用 |
> | **harness 机制** | **强**——唯一无法被「觉得不适用」绕过的 |」

**所以真正的结论不是「提示词写得不够强硬」，而是「修复阶段根本没有 harness 机制」。**

加粗、提高语气、写「必须」，都还是在弱手段里加码。
R1（给 phase 加 wave4/wave5 并接入 stop-hook）才是把强手段接上去。

---

## 九、我在这一轮犯的三个错

1. **主线汇报代替诊断**——用户要诊断提示词，我交验收报告。
2. **验收引用未重算**——6 处行号失效。
3. **证据放在会被清理的目录**——红测日志全部丢失，验收记录变成不可复核。

第 3 条最严重：**它让「我独立核实过」这个说法现在无法自证。**
