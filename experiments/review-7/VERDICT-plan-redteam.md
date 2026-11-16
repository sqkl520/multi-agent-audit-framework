# 实施方案的红队裁定：四六开，偏"补上了更多文字"

**时间**：2026-11-17 05:00
**方法**：红队 agent 把方案里每条判据**逐字实现成脚本**，喂真实数据，看它到底判了什么。
不采信方案自己的描述。

---

## 一句话

**方案里有一条真的检测、一处真的补洞、三条恒亮或恒不亮的 WARN、一条判据本身等于"没检查"的元规则。**
而那条元规则，恰恰是方案自己排在最前、称为"最便宜也最根治"的一条。

---

## 保留下来的（真货）

| 项 | 判定 | 理由 |
|---|---|---|
| **A 断言 diff** | ✅ 唯一"事实来自被审仓库"的检测 | 设计过程本身是范本：拿 3 删 58 增定标，然后**推翻自己的初稿** |
| **C2 枚举校验**（`mutation_check`/`mutation_scope`/`skipped` 理由） | ✅ 真的补上一个零实现的洞 | 今天是 0 实现，改动最小、收益最确定 |
| `input_basis_undeclared` | ⚠️ 保留为 WARN | 但必须配 `unknown` 的后果规则，否则只是占位 |
| `assertion_unparsable` | ⚠️ 保留为 WARN | 但必须统计比例报出来 |

## 该删掉的（实测恒亮或恒不亮）

| 规则 | 实测 | 判定 |
|---|---|---|
| `input_variants_inflated` | 分母 `observed_variants` 在 3 个真实文件上算出 **0** → **诚实填报反而 FAIL** | **删**。方向是错的：惩罚诚实 |
| `universal_claim_thin_evidence` | **9/9 真实产物触发，0/9 真阳**。命中的是 `FIREBALL` 里的 `ALL`、`writeAtomically` 里的 `all`、`finally` | **删**。且读的字段 `verification_commands` 在 verify 契约里**不存在** |
| `text_assertion_on_production_source` | 在它自己的定标仓库上 **0 FAIL**；两个最该抓的（`.lock()`、`mobTypeName == null`）判 no-hit | **删**。分错的全部落在错误的一侧 |
| `mutation_scope_weak_unexplained` | **9/9 真实 verify 产物全中**（我实现的那条） | **删或重定义**。见下 |

---

## 最讽刺的一条：元规则 D 的出口 (b)

方案 D.1 把「有出口」定义为：
> (b) 点名了某个规则名（正则 `[a-z][a-z0-9]+(?:_[a-z0-9]+){1,}` 且**该串在 tools/*.mjs 里出现过**）

红队把这个判据逐字实现，结果是 **322 条规则句靠它拿到"已对账"通行证**。
但那 322 条里绝大多数匹配到的是 **payload 字段名**：

```
13 次 residual_risks        9 次 escalation_required
 6 次 output_snippet        6 次 failure_category
 6 次 searched_scope        5 次 finding_id
```

于是这句：

> `wave5-verify.md:41` 同一 `finding_id` 的两个并行验收实例 | **禁止**

被判成"已与校验器对账"——**而没有任何校验器检查那件事**。

最刺眼的是 `residual_risks`：它在整个 `tools/` 里只出现在 `gen-contract-examples.mjs` 的一个字面量中，
内容从未被任何规则读过。**这正是本工具要暴露的缺陷，却被本工具自己判成了"有出口"。**

---

## 但现在必须记一件更重要的事：我的实现没有犯这个错

红队测的是**方案里写的字面正则**。我实际写的 `tools/check-rule-ledger.mjs` 用的是**严格判据**：

```js
for (const m of src.matchAll(/rule:\s*['"]([a-z0-9_]+)['"]/g)) ruleNames.add(m[1]);
```

只收 `rule:` 字面值。实测：

| 判据 | 集合大小 | `residual_risks` 算出口吗 |
|---|---|---|
| 宽松（方案的字面写法） | 512 | **算**（所以出口率虚高到 8.9%）|
| 严格（我的实现） | 104 | **不算** |

**所以「8.9%」这个数字是有水分的**，但它是因为我沿用了方案的宽松判据去解释。
按我的代码实际行为，`wave5-verify.md` 50 条规则句里只有 **1 条**（`:324` 提到 `no_json_envelope`）算有出口。

**真实的出口率比 8.9% 更低。** 我先前用 8.9% 写的结论方向对，数量级偏乐观。

---

## 三条必须马上改的

### 1. `mutation_scope_weak_unexplained` —— 我自己刚加的，实测 9/9 全中

我在 2026-11-17 04:50 加的这条 WARN，红队拿 9 份真实 verify 产物跑：
**9 份全中。**

命中率 100% 的 WARN 与 0% 的 WARN 是同一个东西：不携带信息的信号。
而且它有明显的绕过方式——在 `notes` 里加一句「未做调用点变异」，正则匹配的是**出现**不是**语义**。

**这条要按红队的建议处理**：它想抓的那个东西（是否属于"函数返回值决定用户可见行为"）
正是方案 Q4-2 自己承认做不到的事。**把做不到的事做成一条 100% 触发的 WARN，就是本报告标题说的那件事。**

保留枚举校验（`missing_mutation_check` 等），删掉这条语义 WARN。

### 2. A 的输入面必须换（否则上线即空转）

`git diff --name-only HEAD` **不含 untracked 文件**。被审仓库有 **19 个 `??`**（93 个测试文件的 20%），
而本轮修复新写的测试几乎全在里面：

```
??  ShopConfigCorruptFileTest.java      ← F1 的 test_path
??  CommandsDocumentAtomicWriteTest.java ← F7
??  CommandsDocumentFallbackTest.java    ← F7
??  ShopConfigPriceValidationTest.java   ← F3
??  ShopConfigAmountValidationTest.java  ← F4
```

**方案把 A 排在第 1 位实施，但按当前输入面，它本轮能判的新测试数 = 0。**
必须换成 `git status --porcelain`（`M` + `??`），untracked 文件显式报 `assertion_baseline_unavailable`。

另外 `fix_baseline.dirty_paths` 会再砍掉 4 个，其中包括 `TabListManagerTest`——
**定标里处 1、处 2 的位置。** 净效果：93 个测试文件只有 70 个进入判据，新的 19 个 0% 进入。

### 3. `@Disabled` 带参必须也命中

方案为了躲 `Assumptions.assumeTrue` 那 1 个合法 skip，把 `@Disabled("…")` 整个放行了。
**这是为了 1 个假阳性，开了 1 个真后门。** 带参 `@Disabled` 只用一行注释就能让一条测试消失。

---

## 红队的最后一段，我认为是本轮最重要的判断

> 这份方案在**"承认做不到什么"上非常诚实**（Q4 的七条，实测支持），
> 在**"我新加的东西真的会响吗"上完全没做过验证**——
> A 章做了定标，B/C/D 三章一条定标都没有。
>
> **方案把"设计"和"验证设计"的差额，从 A/B/C 三个模式，搬到了 B/C/D 三个新规则上。**

这与我写 DIAGNOSIS 时看到的形态**完全相同**，只是换了一层：
原来病在「策略 → 执行」，现在病在「策略 → 策略」。

> 要避免这个结局，只需要改一件事：
> **把 A 章对待 A 的方式，用在 B/C/D 上——先拿真实样本定标，再写判据。**

---

## 所以实施顺序要改

| 原方案顺序 | 新顺序 | 理由 |
|---|---|---|
| 1. A | **1. C2 枚举校验** | 唯一已实测有效、无新算法、改动最小 |
| 2. C2 | **2. A（先修输入面：M+??、带参 @Disabled、多重集比法）** | 修完才是真检测；不修就是空转 |
| 3. B | **3. 其余一律先定标再决定** | B/C1/D 三条实测中两条恒亮一条 0 命中 |
| 4. C1 | — | 删 |
| 5. D | **D 的想法保留，实现重写** | 出口 (b) 改成真实 `rule:` 名（我已这么做）；`--report-only` 必须是代码默认值 |

**已经做完的**：C2（`mutation_check`/`mutation_scope` 枚举 + `missing_mutation_check`）、
D 的严格版（`check-rule-ledger.mjs`）。这两项都带自测，且 check-all 全绿。
