# FIX-R22 报告：T2 递归上限「3 vs 2」矛盾 + 一致性校验器

日期：2026-11-16
范围：`framework/orchestrator/triage.md`、`framework/wrappers/planner.md`、
`tools/check-enum-consistency.mjs`、`tools/check-enum-consistency.test.mjs`
未 commit、未 add。

---

## 1. 判断：3 是对的，2 是旧副本

**结论：T2 递归上限 = 3 层。改 planner，不改 triage。**

### 依据（按证据强度排序）

| # | 证据 | 说明 |
|---|---|---|
| 1 | `tools/check-plan.mjs:77` — `const maxDepth = { T0: 1, T1: 2, T2: 3 };` | **运行时机械闸门**。planner 产出的 `max_depth` 由它判定，它按 3 走。若文档说 2 而闸门按 3，等于「文档劝你别做闸门允许的事」——文档是错的，不是闸门。 |
| 2 | `tools/lint-autonomy.mjs:646-648` — 要求 `check-plan.mjs` 里必须有 `T2: 3`，否则 `FAIL: check-plan 的 T2 递归上界未同步为 3` | 静态检查已经把「3」钉成了**期望值**。这是仓库里唯一一处对递归上限的显式断言。 |
| 3 | `framework/orchestrator/triage.md:119` — 「T2 递归 3 层 / Claude Code 官方 subagent 嵌套上限就是 3」，同文件 :182 给出机制名 `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` 默认 3 | 有**外部物理依据**（harness 实现上限），不是拍脑袋。 |
| 4 | `framework/orchestrator/triage.md:165` 标题「2026-11-09 修订：放宽到 3 层」+ :167「原版写 2 层，用户要『极限』，改为 3 层」 | **历史证据**：2 是被明确废弃的旧值。planner 的 2 就是这次修订漏改的残余。 |
| 5 | `framework/orchestrator/compatibility.md:16,50,227` — 「9 个成员 × 3 层递归」「L-A: 9 并行 + 3 层递归」 | 兼容性矩阵把 3 当作**基线能力**，2 只出现在 L-B 降级列。 |
| 6 | `framework/orchestrator/protocol.md` §0.0 harness 优先原则 + §6 只约束总量与并发，**不约束递归深度** | protocol 没有第二套递归数字，所以不是 protocol 与谁冲突，而是 planner 单点漂移。 |

### 为什么不选「两者都对，条件不同」

任务书设想的一种可能是「理论 3 / 实操建议 2」。核实后**不成立**：

- 「实操建议 2」这个语义**已经存在于别处**，且位置正确——`compatibility.md` §2.2 的 L-B 列（`9 并行 + 2 层`），那里写清了触发条件是 **harness 能力级别**，不是任务难度。
- `triage.md` 第 5 节说的是**框架允许的上限**，`compatibility.md` 说的是**某 harness 上能落地多少**，两者是不同层级，本来就没有冲突。
- 如果把这层条件塞进 planner 的 `max_depth` 表，就等于**用任务规划去承担 harness 探测**——而 harness 探测已经由 `detect-harness.mjs` 在做，planner 收到的是 `harness_cap`。**同一件事有两个负责人，正是本次矛盾的成因。**
- 更要命的是：planner 的产物字段只有 `recursion.max_depth` 一个数，没有地方携带「这是建议值还是上限」的标记。写成「≤2（建议）」会被 `check-plan.mjs` 当成上限执行，条件实际落不了地。

所以选了**单一数字 3**，并用一句话把「harness 更低时由 compatibility.md 处理」写进两个文件的表格下方，把层级关系钉死。

### 为什么 planner 会写成 2 —— 根因

`triage.md` 修订到 3 时，planner 的硬约束表里那行 `T0=0 / T1=1 / T2=2` 是**手抄的散文副本**。手抄副本没有单一事实来源，修订时漏改没人发现。同一个文件里 `max_depth: 1` 的示例（对应 T1）反而是对的，说明漂移只发生在这行表格。

**注意原值 T0=0**：这不只是数字小 1，它与 `triage.md` 的「T0 → 1 层」语义也冲突（0 层 = 执行者不许再派，与「极限多 agent」相悖）。planner 那行是整行作废，不是整体平移。

---

## 2. 改动的逐字对照

### 2.1 `framework/orchestrator/triage.md` 第 5 节（:165-208）

**改前**（散文块，无法机械提取）：

```
递归上限：
  T0 → 1 层（简单任务也可能需要一层助手）
  T1 → 2 层
  T2 → 3 层

每层派生必须继承：零写入、证据标准、失败分类规则
```

**改后**（机制标记 + 结构化表格，成为唯一事实来源）：

```markdown
<!-- RECURSION-DEPTH-TABLE -->
| TIER | 递归上限（层） |
|---|---|
| T0 | 1 |
| T1 | 2 |
| T2 | 3 |
```

并在表格下方补了三段说明（:176-186）：
- 「上面这张表是『递归上限』的唯一事实来源」+ 点名三处消费者（planner 的 `max_depth`、`check-plan.mjs`、本节说明）；
- 「为什么 T0 是 1 层而不是 0」；
- 「为什么 T2 是 3 层而不是 2」——并明确 **harness 更低时由 `compatibility.md` §2.2 降级（L-B = 2 层、L-C = 无递归），不在这里写小**。

**修正痕迹**（:202-208）：

> **2026-11-16 修正痕迹**：本节此前只在散文里写「T0 → 1 层 / T1 → 2 层 / T2 → 3 层」，而 `wrappers/planner.md:137` 写的是「T0=0 / T1=1 / T2=2」——**同一框架两套数字**。实战（field-test-1）里 agent 读到 planner 的 2，就按 depth 2 保守执行，并在收尾报告里把这写成「框架文档/闸门矛盾」。现已把层数改成结构化表格（上面的 `RECURSION-DEPTH-TABLE`），并加校验器逐 TIER 比对两个文件。结论：**triage 的 3 是对的，planner 的 2 是旧副本**。

### 2.2 `framework/wrappers/planner.md`（:137 → :137 + :139-161）

**改前**（硬约束表最后一行）：

```
| `recursion.max_depth` | 不得超过 T0=0 / T1=1 / T2=2 |
```

**改后**（该行只留指针，数字移进结构化表）：

```
| `recursion.max_depth` | 必须 ≤ 下表该 TIER 的值，见「递归上限」 |
```

**新增 §4.1**（:139-151）：

```markdown
### 4.1 递归上限（与 `orchestrator/triage.md` 第 5 节保持一致，2026-11-16 修正）

<!-- RECURSION-DEPTH-TABLE -->
| TIER | 递归上限（层） |
|---|---|
| T0 | 1 |
| T1 | 2 |
| T2 | 3 |

**这张表必须与 `orchestrator/triage.md` 第 5 节的同名表逐格相同。**
`max_depth` 是**上限**不是目标：取更小永远合法（复杂度不需要就别硬派），
取更大就是超界。harness 能力不足导致的更低上限由 `compatibility.md` §2.2 统一处理，
**不写进这张表**。
```

**修正痕迹**（:153-161）：

> **2026-11-16 修正痕迹**：此处原写「不得超过 T0=0 / T1=1 / T2=2」，与 `orchestrator/triage.md:119`「T2 递归 3 层（Claude Code 官方 subagent 嵌套上限就是 3）」矛盾，也与 `tools/check-plan.mjs` 的 `maxDepth = { T0: 1, T1: 2, T2: 3 }` 矛盾——**两处机械检查都按 3 走，只有这份文档按 2 走**。实战（field-test-1）确实因此让 agent 按 depth 2 保守执行，并把「任务书 depth 3 vs planner 上限 2」当成框架缺陷报了上来。现改为与 triage 逐格一致的结构化表格，并由 `tools/check-enum-consistency.mjs` 的 `recursion_depth_mismatch` 规则守住。

### 2.3 两处的最终数字

| TIER | triage.md:172-174 | planner.md:144-146 | 一致 |
|---|---|---|---|
| T0 | 1 | 1 | ✅ |
| T1 | 2 | 2 | ✅ |
| T2 | 3 | 3 | ✅ |

**同一组数字，无条件修饰**。层级的差异（L-B 只到 2 层）留在 `compatibility.md`，不混进来。

---

## 3. 校验器：`recursion_depth_mismatch`

文件：`tools/check-enum-consistency.mjs:209-325`

### 3.1 提取逻辑

```js
const DEPTH_MARK = '<!-- RECURSION-DEPTH-TABLE -->';
const DEPTH_SOURCES = [
  { file: 'orchestrator/triage.md', path: join(ROOT,'framework','orchestrator','triage.md') },
  { file: 'wrappers/planner.md',    path: join(WRAPPERS,'planner.md') },
];

function extractDepthTable(text, label) {
  const at = text.indexOf(DEPTH_MARK);
  if (at < 0) return { ok:false, reason:'找不到标记 …' };   // ← 失败，不是跳过
  // 标记之后逐行找表格：
  //   空行 → 表前忽略，表后结束
  //   |…|---|…| → 分隔行（缺它说明不是合法 markdown 表 → 失败）
  //   |TIER|…|   → 表头
  //   |T0|1|     → 取值
  // 三列任一缺失 → 失败
}
```

三个设计点，都是为了「稳」：

1. **标记而非标题正则。** 用 `<!-- RECURSION-DEPTH-TABLE -->` 定位，而不是 `grep '递归上限'`。标题措辞迟早会被重写（这次就改了 `第 5 节` 的副标题），标记不会被顺手改掉——而且标记是给人看的「这里有一张被机器读的表」，改文档的人知道动了要同步。

2. **按列位置取值，不从散文抽数字。** `triage.md` 的 TIER 表（:72-76）里，`T2` 那一行同时有 `≥2`（分数）、`**9**`（成员）、`3 层`（递归）。任何「找数字」的写法都会抓错列——`lint-autonomy.mjs:559-564` 的注释里已经为同一个坑踩过一遍。新表是两列 `| TIER | 层数 |`，**结构上不可能混淆**。

3. **失败即失败，不静默放行。** 三条失败路径全部产出 `recursion_depth_table_missing`：
   - 文件不存在；
   - 标记不存在；
   - 标记后的表格缺分隔行 / 缺任何 TIER 行 / 层数格没数字。

   这是本任务最关键的一条。`recursionDepth.sources.length !== 2` 时**根本不进比对**，所以不会有「一边没解析出来 → 空对象比较 → 相等 → 绿」的假通过。

### 3.2 判据与输出

逐 TIER 比较两个来源，不一致的每一条都单独列出（不是只报「不一致」）：

```
[recursion_depth_mismatch] orchestrator/triage.md vs wrappers/planner.md —
  递归上限不一致 —— T2: orchestrator/triage.md 说 3 层，wrappers/planner.md 说 2 层。
  两处必须逐 TIER 相同（harness 能力不足造成的更低上限由 compatibility.md 处理，不写进这两张表）
```

（上面是实跑输出，通过把 `planner.md` 的 `| T2 | 3 |` 手工改成 `| T2 | 2 |` 得到，exit 1。）

`--json` 输出新增 `recursionDepth: { sources: [{file, depths}], consistent }`，供测试断言。

### 3.3 为什么把它放进 `check-enum-consistency.mjs` 而不是新建文件

这两条规则是**同一类问题**：同一个事实在多个文件里各写一份，任何单份读起来都自洽，只有并排看才发现冲突。枚举是「值的闭集」，递归上限是「单值的事实的多副本」——提取和比对机制几乎一样（定位 → 取值 → 跨来源比对 → 不一致就点名）。放进同一个检查器，`check-all.mjs` 里已有的注册项自动覆盖，不用改 `check-all.mjs`。

---

## 4. 测试

`tools/check-enum-consistency.test.mjs` 新增 case 8-10（原有 case 1-7 全部保留并通过）：

| case | 场景 | 断言 |
|---|---|---|
| 8 | 两文件一致（无变异） | 无 `recursion_depth_*` 问题；`recursionDepth.sources.length === 2`；triage 解析出 `T2 = 3` |
| 9 | 把 planner 的 `\| T2 \| 3 \|` 改成 `\| T2 \| 2 \|`（**实战里真实发生的那次漂移**） | exit 1；kind = `recursion_depth_mismatch`；detail 含 `T2:`；detail 同时含 `3` 和 `2` |
| 10 | 把 planner 的整张递归表删掉 | kind = `recursion_depth_table_missing`；detail 点名 `planner.md`；exit ≠ 0 |

**先写测试、确认 FAIL 的记录**（改实现之前跑的）：

```
case 8: 两个文件的递归上限表都存在且一致 → 必须通过
  ✓ 无 recursion_depth_* 问题
  ✗ 解析出两个来源的递归表
  ✗ triage 解析出 T2 = 3
case 9: ...
  Error: ...\framework\wrappers\planner.md 里找不到 <!-- RECURSION-DEPTH-TABLE -->
```

FAIL 的原因正是「表和标记还不存在」——符合预期。

**改完之后**：

```
=== 结果: 25 通过 / 0 失败 ===
```

case 10 是任务书点名的关键用例：**提取失败必须报错**。它和 case 6（`ENUM_CHECKS` 消失 → exit 2）是同一个原则的两次落地。

---

## 5. 验证

```
$ node tools/check-enum-consistency.test.mjs
=== 结果: 25 通过 / 0 失败 ===

$ node tools/check-enum-consistency.mjs
结论：契约切片 / wrapper / 模板 / 示例四处与校验器闭集一致。
递归上限：orchestrator/triage.md T0=1 T1=2 T2=3 | wrappers/planner.md T0=1 T1=2 T2=3 — 逐 TIER 一致。

$ node tools/check-all.mjs
✅ 全部通过
```

`check-all` 里「枚举跨层一致性」一项现在报 `25 通过 / 0 失败`（原为 10 通过）。其余 28 项不受影响。

---

## 6. 顺带检查：其他同类矛盾（**只列不改，待确认**）

grep 了两个文件的数字约定（成员数 / 递归层数 / 并发窗口 / 尝试次数预算）。递归层数已修，其余如下。

### 6.1 已核实**不是**矛盾（记录以免下轮重复怀疑）

| 数字 | 位置 | 为什么不是矛盾 |
|---|---|---|
| T2 = 9 成员 | `triage.md:76,118,124,217,237` | 五处全一致。`lint-autonomy.mjs:614-636` 已在机械校验同一文件内多处 T2 成员数必须相等。 |
| T0 = 3 / T1 = 5 | `triage.md:74-75,217,237` | 一致；`check-plan.mjs:60` 同值。 |
| 扇出 5 | `triage.md:120,124,198` | 一致。 |
| 总 agent 200（T2） | `triage.md:121` ↔ `protocol.md:1289` | 一致（默认 60，T2 放宽 200）。 |
| L-B = 2 层 | `compatibility.md:50` | **不是**与 T2=3 矛盾——它是 harness 能力降级，适用条件已写在矩阵列头。本次已在两处表格下点明这个分工。 |

### 6.2 待确认

| # | 不一致 | 位置 | 说明 |
|---|---|---|---|
| **A** | `check-plan.mjs` 的 T0/T1 递归上界 | `tools/check-plan.mjs:77` `{T0:1,T1:2,T2:3}` ↔ `triage.md` 表格 | **现在一致**，但它仍是**手抄副本**——本次只让两个 md 互相比对，`check-plan.mjs` 没被纳入比对。下次改 triage 表仍可能漏改 check-plan（`lint-autonomy.mjs:646` 只钉了 T2 一个值）。**建议下轮把 `check-plan.mjs` 的 `maxDepth` 也变成被比对来源。** 本轮不动：任务书限定改四个文件，且 `check-plan.mjs` 当前值正确。 |
| **B** | `compatibility.md` 的 L-B 列 vs 文档对「T2 上限」的表述 | `compatibility.md:50` | L-B 写「9 并行 + 2 层」。若某次运行在 L-B 上，planner 若仍按 3 填 `max_depth`，`check-plan.mjs` 不会拦（它只看 TIER，不看 `harness_cap`）。**「planner 是否应按 harness_cap 下调 max_depth」这件事，文档没有明确规定**——`compatibility.md` 说 L-B 只能 2 层，`planner.md` 说 T2 可以 3 层，两者对同一个运行给出不同答案。这是本次矛盾的同构问题，只是作用在「任务 TIER」和「harness 级别」两个维度之间。**待确认，本轮不改。** |
| **C** | triage §3.2 的 `T2 递归 3 层` 与第 5 节表格 | `triage.md:119` vs `:174` | 现在数值一致（都是 3），但 `:119` 仍是散文副本，**不在校验器扫描范围内**。若第 5 节表格改成 4，`:119` 会静默留在 3。建议把 §3.2 那行也改成指向表格，或纳入校验。**待确认，本轮不改**（怕过度改动，且 §3.2 的语义是「极限规模目标」而非「上限声明」）。 |
| **D** | 尝试次数上限的表述 | `protocol.md:1122`（`同一 agent 重跑 3 次；同 error_type 连续 2 次 → 停止`）、`:1137`（`最多 2 次重试（即总尝试 3 次）`）、`:1145`（`连续失败 ≥3 次同因` 即判系统性缺陷、终止本轮）、`:1169-1170`（`attempt > 3`） | **`连续 2 次` 与 `连续 ≥3 次` 数字差 1**，且两者都触发「停」。`attempt-ledger.mjs:168-172` 实现的是「连续 **2** 次」，已有测试锁定。可能的辩解是作用域不同（:1122 是单 agent 重跑，:1145 是整个波次终止），但两份文本都用「连续 … 同 error_type/violated_fields」这一措辞，**读者无法从文字上区分作用域**。倾向 :1145 需改写（要么改成 2，要么明写「波次级，独立于单 agent 的 2 次」）。**待确认，本轮不改**（不在限定的四个文件内）。 |
| **E** | 并发窗口 8 / admission_ceiling 60 / 单波并发 | `scale-mapping.md:202,234,239-253` | 看起来自洽（`min(8, harness_cap)`；`admission_ceiling = min(60, …)`），且 `:246-253` 已专门解释「60 是队列上限不是总数」。**未发现矛盾**，仅记录已查。 |

---

## 7. 一句话结论

**这个改动能防止**：任何人改了两个文件里任意一处递归上限而忘了另一处——`check-all` 会立刻红，并且点名是哪个 TIER、两个文件各说了什么。它把「agent 在收尾报告里发现框架自相矛盾」这种**事后、昂贵、且依赖 agent 自觉**的发现，变成了**事前、免费、绕不过去**的机械检查。

**不能防止**：它只守住「这两张表的数字相同」，守不住 (a) 数字本身是否合理——如果两处一起被改成 4，校验器全绿而 harness 实际只支持 3；(b) 第三个副本——`check-plan.mjs:77` 与 `compatibility.md:50` 仍是同值的手抄，本次未纳入比对（见 6.2-A/B）；(c) 表格之外的散文副本（如 `triage.md:119`）——它们不在扫描范围内，改表不会带动它们（见 6.2-C）。**校验器管的是「已结构化的声明」，管不了还留在散文里的那部分。**
