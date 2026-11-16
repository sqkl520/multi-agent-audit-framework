# 红队：这份方案里哪些"检查"其实什么也没检查

**对象**：`experiments/review-7/PLAN-close-the-gap.md`（577 行版，md5 `67b4a2927753cb621708d97e7a652e21`；
第一次读时是 416 行版本，中途新增了模式 D / 元规则章。以下全部按 577 行版判定。）
**方法**：只读被审仓库 `<TARGET_REPO>`，
把方案里每条判据**逐字实现成脚本**，喂给它真实数据，看它在**真实样本**上到底判了什么。
我不做 git 写操作，不改任何已有文件。

**先说结论，一句话**：方案里有 **一条真的检测**（A 的断言 diff）、**一处真的补洞**（C2 的枚举校验）、
**两条在真实数据上恒假或恒真的 WARN**（B 的启发式、C1）、
**一条判据本身等于"没检查"的元规则**（D 的出口 b）——
而 D 恰恰是方案自己排在最前、称为"最便宜也最根治"的那一条。

---

## 一、我实测了什么（可复现）

| 脚本 | 它做什么 | 关键输出 |
|---|---|---|
| 模拟 D 的抽取算法 | 按方案 D.1 的正则扫 `framework/templates/*.md` + `framework/components/**/*.md` | 532 条规则句；只有 **4** 条点名 `tools/*.mjs`；**0** 条标 `DISCRETIONARY`；**207** 条无任何出口 |
| 模拟 B 的 `observed_variants` | 按方案列的 6 个信号（`@CsvSource`/`@MethodSource`/`@ParameterizedTest`/`List.of(`/`assertThrows`/`for (int`）数真实文件 | 3 个真实测试文件得 **0**，而它们各有 5～7 个真实 YAML 输入样本 |
| 模拟 C1 | 按方案三条条件逐字实现，扫全部 93 个测试文件 | **6** 个候选方法；**0 个 FAIL**；**3 个 no-hit**；**3 个 WARN** |
| 模拟 `universal_claim` | 方案的全称量词表 + `verification_commands` 里的 distinct test id | 9/9 真实 verify 产物触发（子串版）；7/9（词边界版）；**0/9 是因为真的过度宣称** |
| 模拟 A 的可见面 | `git diff --name-only HEAD` + `fix_baseline.dirty_paths` | 93 个测试文件里只有 **70** 个进入判据；**本轮新建的 19 个测试文件，A 一个都看不到** |
| 模拟 `residual_risk_disposition` 覆盖 | 7 组真实 fix/verify 产物对 | 契约字面读法 6/7 违规；方案写的等号读法 2/7 违规；**三种读法互相矛盾** |

---

## 二、逐条攻击

### 1. `claim_exceeds_samples` —— 自述，且**最省力的通过方式是"不填"**

判据：`input_space_basis ∈ {exhaustive, boundary}` 且 `input_variants_covered < 2` → FAIL。

**射程**：它只能抓"agent 在 verify 产物里亲手写下 `exhaustive` 或 `boundary` 这个词"。
它读的是**自述**，不是事实。方案称自己"优先用事实"——这一条不在其列。

**最省力的通过方式（三档，从最省力开始）**：
1. `input_space_basis: "unknown"` → **零条规则命中**。这是方案自己定义合法的枚举值，而**没有任何规则把 `unknown` 当回事**。
2. `input_space_basis: "single_sample"` → 也零命中。方案 `:196` 说"一旦写成 `single_sample`，`wave5-verify.md` 的『带保留通过』就该被触发"——**那条规则不存在**：`escalation_required` 在整份 577 行方案里出现 **0 次**。这是"写了后果、没写检测"，正是 DIAGNOSIS 说的病。
3. 不填字段 → `input_basis_undeclared` **WARN**。这就是 `stop-hook.mjs:450-454` 自己记录过的那句"只消省略一个字段，整道闸门就变成一条 WARN"，方案在 Q3 里为 A 引用了它，却在 B 上原样犯了一次。

**它在真实样本上的召回是 0**：F1 的 fix 产物正文里，方案的全称量词表命中 **0** 次
（`任意|所有|每一个|穷举|全部|any|all|every|exhaustive` 逐个 grep，全部为 0）。
F1 的过度宣称写在**生产代码的 javadoc 里**（`ShopConfigLoader.java:83-85`「不得降级成空商店」，
`:116-120`「the file appears truncated」），而这条规则读的是 **verify payload**，不是源码。
**过度宣称的真实位置和这条规则读的位置不是同一个文件。**

**关于可疑 1 的具体问题**：写 `input_space_basis: "boundary"` + `input_variants_covered: 12` 而实际只测 1 种形态——
这要过 `input_variants_inflated`（12 > observed × 3）。所以能否放行**完全取决于挂在哪个文件上**。
若挂在 `ShopConfigAmountValidationTest`（见下条，observed 算出来是 0）→ 12 > 0 → FAIL，是**误拦**；
若挂在 `ShopConfigQuarantineRebuildTest`（observed 算出来是 14）→ 12 ≤ 42 → **放行**。
所以答案不是"会放行"或"不会"，而是：**这条规则的判定结果由它数文件的方式决定，而不是由 agent 实际测了什么决定。**

**建议**：**降级为 WARN，或删掉**。改成事实源就能救：从 `git show <ref>:<test_path>` 直接数**文本块 fixture 的个数**
（本仓库 142 个 `"""` / 71 个 fixture，这才是真实的输入样本数），不读任何自述字段。否则它就是一个可自述满足的字段。

---

### 2. `input_variants_inflated`（`> observed_variants × 3`）—— **阈值 3 无来源，且分母可以是 0**

**射程**：比 `claim_exceeds_samples` 更窄，因为它的分母是方案自己发明的一个数。

**"3" 是哪来的？** 我在整份方案里搜 `observed_variants`，它**只出现 1 次**，就在这条规则行里，
没有任何定标、没有样本、没有出处。对照方案自己 A 章的做法（先用 3 删 58 增的真实 diff 定标，
推翻了初稿）——**B 章完全没有做定标**，直接拍了一个 3。

**实测这个 3 在真实仓库上有多荒唐**（按方案列的 6 个信号逐个数）：

| 真实文件 | 真实不同输入样本（text block） | 方案算出的 `observed_variants` | 诚实填 `input_variants_covered` 的后果 |
|---|---|---|---|
| `ShopConfigAmountValidationTest` | 7 | **0** | 7 > 0×3 → **FAIL（诚实填反而炸）** |
| `ShopConfigPriceValidationTest` | 5 | **0** | 5 > 0 → **FAIL（诚实填反而炸）** |
| `ShopConfigMaterialValidationTest` | 1 | **0** | 1 > 0 → **FAIL（诚实填反而炸）** |
| `ShopConfigCorruptFileTest`（F1 的 test_path） | 6 | 5 | 通过 |
| `ShopConfigQuarantineRebuildTest` | 2 | 14 | 通过（可以虚报到 42） |

**根本原因**：方案的信号清单里**没有 JUnit 文本块**（`"""`），而这正是本仓库唯一的输入机制。
全仓库 93 个测试文件里，有 **35 个**用这 6 个信号数出来是 0；
其中 4 个文件（Amount/Price/Material 校验 + ShopListenerTest）是"只有文本块、零信号"。
**这个仓库的标准写法会让这条规则的分母恒为 0。**

**分母为 0 会怎样？** 方案对 A 和 C1 都写了 `test_files_not_found → exit 2`，
**对 B 一个字都没写**。`observed = 0` 会被静默接受，然后 `× 3 = 0` 变成一个绝对阈值：
agent 诚实填任何 ≥1 的数 → FAIL；填 0 → 通过。**这条规则在分母为 0 时不是"静默通过"，是"反向惩罚诚实"。** 比静默通过更糟。

**建议**：**删掉**。它依赖一个方案没定义的量（`observed_variants` 在 Q2 改动 2 的用法里根本不存在，
只在 B.2 的规则行出现过一次），而定义它的方式已被实测证明在目标仓库上恒定失效。
如果要留，先补一份像 `GROUND-TRUTH-assertion-diff.md` 那样的定标：拿 5 个真实测试文件，
人工标出"真实输入样本数"，再让算法去对——这一步 A 章做了，B 章没做。

---

### 3. `universal_claim_thin_evidence` —— **在真实产物上 100% 误报，且读的字段不存在**

判据：正文含 `任意|所有|每一个|穷举|全部|any|all|every|exhaustive` 且 `verification_commands` 里 distinct test id ≤ 1 → WARN。

**第一个硬伤：`verification_commands` 不是 verify 产物的字段。** 它是 **fix** 角色的字段
（`output-contract/fix.md` 有，`verify.md` 里搜 `verification_commands` → **0 命中**；
`wave5-verify.md:15` 甚至明令它**不进**验收输入）。
实测 9 份真实 verify 产物：**9/9 的 `verification_commands` 出现次数为 0**。
于是"distinct test id ≤ 1"恒为真，这条规则退化成一句话：**"这份产物里有没有出现过 all/any 这几个字母"。**

**第二个硬伤：方案写的是子串，不是词边界。** 我把两种读法都跑了：

| 读法 | 9 份真实 verify 产物触发数 | 真实过度宣称数 |
|---|---|---|
| 子串（方案的字面写法） | **9 / 9** | 0 |
| 词边界 `\b(any\|all\|every)\b` | **7 / 9** | 0 |

**误报的具体样本**（全部来自真实产物，不是构造）：

- `round1-04-fix-5.md`：子串版触发 WARN。命中的是 `"其他商品类型（HAMMER / FIRE**ALL** / REPAIR_ITEM…）"`。
  **`FIREBALL` 里的 `ALL`。**
- `round1-04-fix-7.md`：子串命中 13 次，全部来自 `writeAtomically`（含 `all`）和 `finally`（含 `all`）。
- `round1-04-fix-1.md`：子串命中 9 次，全部来自 `partially` / `calls` / `specifically` / `actually` / `swallows`。
- 词边界版的 7/9 命中，样本是 `"Inspected all F3/F4 fixtures"`、`"all five classes, 45 tests"`、
  `"every one supplies icon.material"`——**这是验收 agent 在描述自己做了什么，正是我们要的东西**。
  方案 `:504` 自己预料到误报会落在"所有商品都必须有 price"，但实测误报面比它想的宽得多：
  **凡是认真写验收记录的产物都会被标黄。**

**方案自己引用的那条纪律说了什么**：`:504` 引 `stop-hook.mjs:1558-1562`——
"无条件升 FAIL 会让每个回合都红，然后被一条 WARN 关掉"。**实测结果就是它描述的那个结局，只是发生在 WARN 层**：
一道 9/9 都亮的 WARN，第一次看到会有人读，第三次就没人读了。**这就是"两年后变成一条没人读的规则"的开端。**

**建议**：**删掉**。它在真实数据上的信噪比是 0:9。
若一定要留，唯一可救的形态是：**只匹配"覆盖类全称"的具体句式**（`所有…都`/`任意…均`/`every … is` + 与"测试/样本/用例"同句），
并且分母换成产物里**实际出现的 `Dtest=` / 测试类名**（那 9 份里是 1～5 个，有区分度），而不是一个不存在的字段。

---

### 4. `text_assertion_on_production_source`（C1）—— **在它自己的定标样本上 0 FAIL，且有一行开关**

这是用户点名怀疑的第三处。我把方案的三条条件**逐字实现**，扫全部 93 个测试文件，结果如下：
共 6 个候选方法（方案说 4 处，我的候选里多出 `GameConfigTest` 一个读 classpath 模板的，另算）。

| 方法 | 方案条件 3 是否成立 | 最终判定 |
|---|---|---|
| `CommandsDocumentAtomicWriteTest.asyncBlockNoLongerTruncatesTheTargetInPlace` | 是（`ATOMIC_MOVE`, `AtomicMoveNotSupportedException`） | **WARN**（因为 `ATOMIC_MOVE` 在 javadoc 里出现过 → 注释缓解生效） |
| `CommandsDocumentFallbackTest.javadocStopsClaimingTheFalseInvariant` | 是（`DeleteFile`, `WARNING`） | **WARN**（同上） |
| `CommandsDocumentAtomicWriteTest.twoArgOverloadDoesNotSwallowTheFallbackWarning` | 是 | WARN（有其他断言） |
| `AirdropSpawnGoalTest.productionCodeHasNullGuard` | **否** | no-hit |
| `CommandsDocumentConcurrencyTest.writeAtomicallyIsGuardedByALock` | **否** | no-hit |
| `GameConfigTest.shippedTemplateAgreesWithCodeDefaults` | 否 | no-hit |

**合计：0 FAIL / 3 WARN / 3 no-hit。这条规则在它自己的定标仓库上，一条 FAIL 都不会亮。**

为什么？两个独立的原因：

**(a) 注释缓解是一行开关。** 我的实测：`ATOMIC_MOVE` 在 `CommandsDocumentGenerator.java` 里
inComment=**true**（480/487/498 行）、inCode=true；`WARNING` inComment=**true**（39/40/498/562/592）。
于是"needle 出现在注释里 → 降 WARN"这条缓解**自动命中几乎所有源码守卫**——
因为源码守卫的存在理由就是"javadoc 说了 X，代码也得做 X"，**needle 必然同时在注释和代码里**。
后果：agent 只要在 javadoc 里补一句含该 needle 的话（甚至 `// 见 ATOMIC_MOVE`），
就能把一个 FAIL 换成 WARN。**它读的是 agent 正在编辑的那个文件**，所以这是自述的变体，不是事实。

**(b) 条件 3 的正则 `^[A-Za-z_$][\w$.]*(Exception|Error|Policy|Mode)?$` 两边都错。**
它接受 `ATOMIC_MOVE`、`WARNING`、`DeleteFile`、`Logger.getLogger`（`?` 让后缀可选，于是任何标识符都过），
却**拒绝** `.lock()` 和 `"mobTypeName == null"`（前者以 `.` 开头，后者含空格）。
结果：**这个仓库里最该被这条规则抓住的两个文本守卫——
`writeAtomicallyIsGuardedByALock`（只断言源码里有 `.lock()` 和 `.unlock()`）和
`productionCodeHasNullGuard`（在源码里 grep `mobTypeName == null`）——恰好都判 no-hit。**

**能不能区分"合法文本守卫"和"用文本断言代替行为断言"？** 实测答案是**不能**，而且不是"有一点假阳性"：
- 方案给的缓解是"needle 是不是落在注释里"。实测这个判据对两个**正确**的守卫
  （`asyncBlock…`：源码守卫是补充，旁边有 3 条行为断言；`javadocStopsClaiming…`：守的就是注释）
  **都判 WARN，判对了**；但对**错误的**那个（`.lock()` 守卫，纯文本、无行为断言）**判 no-hit，漏了**。
- 也就是说：**这条规则在真实样本上的表现是"该抓的漏了、不该抓的标黄了"，与设计意图相反。**

**建议**：**删掉**。它的射程窄到不值得维护：0 个真命中、1 个一行 javadoc 即可拆掉的开关、
1 个连自己定标都覆盖不到的正则。要保留"文本断言"这个信号，唯一可行的方向是**换观测面**：
看这个测试方法**在把生产源码的字符串常量改掉之后会不会红**（一次变异即可证明它是文本断言），
而不是静态看它 `contains` 了什么。但那已经属于 Q4 明确说"做不到"的变异检验，不该伪装成 C1。

---

### 5. `assertion_*` 系列（A）—— **唯一真的有检测的一条，但本轮它看不到本轮的 19 个新测试文件**

先说好的：A 的设计（按 subject_key 跨方法匹配、申报只做消音器、用真实 3 删 58 增定标推翻"翻转即 FAIL"）
是本方案里**唯一一处"先定标再设计"**，也是唯一一处外部事实源（`git show` + `readFileSync`）。
这部分是对的，我不攻击它。

攻击它的**输入面**。实测：

**(a) `git diff --name-only` 不含 untracked 文件。** 被审仓库 `git status --porcelain -- src/test` 有 **19 个 `??`**，
等于 **93 个测试文件里的 19 个（20%）**。而**本轮修复新写的测试几乎全在这 19 个里**：

```
??  src/test/java/com/hilltopvillage/shop/ShopConfigCorruptFileTest.java     ← F1 的 test_path
??  src/test/java/com/hilltopvillage/doc/CommandsDocumentAtomicWriteTest.java ← F7
??  src/test/java/com/hilltopvillage/doc/CommandsDocumentFallbackTest.java    ← F7
??  src/test/java/com/hilltopvillage/shop/ShopConfigPriceValidationTest.java  ← F3
??  src/test/java/com/hilltopvillage/shop/ShopConfigAmountValidationTest.java ← F4
??  ... 共 19 个
```

方案 A.2 说"新增文件 old 为空 → 只跑 `test_disabled`"。但**它连"新增了这些文件"都看不见**——
`git diff --name-only HEAD` 返回 7 个文件，全部是 `M`。**A 本轮能判的新测试数 = 0。**
更狠的是：这 19 个文件里的反向断言（模式 A 的典型形态）**恰好就藏在它们里面**。

**(b) `fix_baseline.dirty_paths` 再砍掉 4 个，其中包含定标的两条主例。**
被审仓库 `.work/round1/state.json` 的 `fix_baseline.dirty_paths` 有 12 条 `src/test` 路径（wave4 之前抓的）。
被 `git diff` 命中的 7 个测试文件里，**4 个在 dirty 名单里**：
`AirdropSpawnGoalTest` / `ExplodeBeetleGoalTest` / `ConfigManagerTest` / **`TabListManagerTest`**。
`TabListManagerTest` 正是 `GROUND-TRUTH-assertion-diff.md` 处 1、处 2 的位置——**定标的两条主例，在真实基线上被排除了。**

净效果：**93 个测试文件，70 个进入判据（75%），新的 19 个 0% 进入。** 而本轮的 5 条缺陷全部落在新的 19 个里。

**(c) `test_disabled` 有一行绕过。** 判据是 `@Disabled`（**无参**）/ `@Ignore` / `it.skip(` / `xfail`。
`@Disabled("相邻 flaky，待查")` 带参数 → 不在触发词里 → 通过。这是**一个参数就能关掉一条测试**，
而 `wave4-fix.md:200` 明文禁止"跳过测试"。方案为了躲 `Assumptions.assumeTrue` 那 1 个合法 skip，
把整个带参 `@Disabled` 放行了。**这是为了 1 个假阳性，开了 1 个真后门。**

**(d) `assertion_reversed_unreported` 在定标处 2 上不确定。** 实测 `field("scheduledPeriod")` 的断言：
HEAD 是 `assertEquals(20)`×1 + `assertEquals(-1)`×3；worktree 是 `20`×2 + `-1`×2。
按 subject_key 聚合到文件级时，**"这个 subject 的 expected"是一个集合，不是一个值**。
方案的判据写"`exact` 的 `expected` 变值 → FAIL"，但没说集合怎么比（多重集？取众数？逐个配？）。
**同一份定标样本，三种比法给出三种结论。** 这不是实现细节，这是判据本身没定义。

**(e) 申报通道是一行文本，且后果没实现。** 最省力的绕过：
在 `residual_risks` 里写一行 `TEST_CONFLICT: src/test/.../FooTest.java`，
该文件里任何反转都从 FAIL 降成 WARN。方案称这有代价（推进 `HUMAN_DECISION_REQUIRED`、不算已修复），
但**那个后果同样没有检测器**（同 B 条：`escalation_required` 在方案里出现 0 次）。
真实数据佐证：7 份 fix 产物里 `TEST_CONFLICT` 出现 **0 次**——**没人申报过，所以这道消音器从未被验证过。**

**建议**：**保留，但先修输入面，否则上线即空转**：
1. 文件清单换成 `git status --porcelain` 全量（`M` + `??`），`old` 用 `git show`，`new` 用 `readFileSync`；
   untracked 文件 `old` 为空不是"跳过"，是"新增文件"，必须显式报 `assertion_baseline_unavailable` **并计入 WARN 数量**。
2. `@Disabled` 带参也命中，只在 `@Disabled` 的值里写明 `assumption`/`platform` 时才降级。
3. 把"expected 集合怎么比"写死（建议：按 `(subject_key, expected)` 多重集比较，集合差非空即命中）。
4. **如果不修 (a)，这条规则本轮抓到的缺陷数是 0**，而它排在第 1 位实施。这是全方案最贵的排序错误。

---

### 6. `residual_risk_disposition` 覆盖校验（改动 4）—— **三种读法，三种结论；且它需要的数据路径不存在**

方案写："`flag` 去重后数量必须等于修复产物 `residual_risks` 的标记数"。
契约原文（`wave5-verify.md:207`）写的是："如果 `residual_risks` 有 N 个**标记**，而 `residual_risk_disposition` 少于 N 条（重复 `flag` 的条目只算一次）→ CONTRACT_VIOLATION"。
**这两句话不是同一件事**：契约说"去重后 ≥ N"，方案说"去重后 == 标记数"。

实测 7 组真实产物对：

| | 契约字面读法（distinct ≥ N） | 方案等号读法 |
|---|---|---|
| fix-1 | 违规（N=3, distinct=2） | 通过 |
| fix-2 | 违规（N=3, distinct=1） | 通过 |
| fix-3 | 违规 | **FAIL** |
| fix-4 | 违规 | **FAIL** |
| fix-5 | 违规 | 通过 |
| fix-6 | 通过 | 通过 |
| fix-7 | 违规（N=6, distinct=4） | 通过 |
| **合计** | **6/7 违规** | **2/7 FAIL** |

**同一条规则，两个读法在真实数据上差 4 条。** 方案没有消解这个歧义，直接选了等号——而等号恰恰是**更松**的那个。

更要命的是：**它比的不是集合，是计数。** 实测 fix-7：

- fixer 声明：`RED_BASELINE`(闭集外) `LARGE_PATCH` `IMPACT_UNVERIFIED`×3
- verify 处置：`BASELINE_UNVERIFIED` `LARGE_PATCH` `IMPACT_UNVERIFIED`×3 `OBSERVED_BUT_OUT_OF_SCOPE`(fixer 从没声明)

去重都是 4 → **等号判据通过**。但两边**没有一条集合关系成立**：fixer 用了闭集外的 `RED_BASELINE`，
verifier 自己造了一个 fixer 没声明的 `OBSERVED_BUT_OUT_OF_SCOPE`。
**这正是"验收 Agent 没读修复者声明、自由发挥"的形态，而计数校验对它完全免疫。**
同样的情形在 fix-1、fix-6 上各出现一次。**3/7 的真实产物是"集合不等但计数相等"。**

**第二个问题（结构性）**：`check-payload.mjs` 的输入是**单个产物文件**
（`const file = args.find(...)`，`import { readFileSync, existsSync } from 'node:fs'`，**没有 `readdir`**）。
它拿不到"这个 verify 对应的 fix 产物在哪"、"fix 产物的 `residual_risks` 是什么"。
方案要把它塞进 `check-payload` 的 verify 分支，但**没有给出任何数据通路**（没有 `--fix-artifacts <dir>` 参数）。
最可能的实现结果是：`residual_risks` 取不到 → 判据 `continue` → **静默通过**。
这就是 DIAGNOSIS 说的"规则写了、位置有了、机器没读"的复刻。

**建议**：**改判据，不要改计数**。正确的判据是**集合包含**：
`distinct(disposition.flag) ⊇ distinct(fixer.residual_risks 的标记前缀)`，且自动拒绝闭集外标记。
计数是错的守恒量。另外必须给 `check-payload` 加 `--fix-artifacts <dir>` 或把这条规则挪到
`stop-hook`（那里已经有 `files` / `repoDir` / 全部产物，见 `§3.7.5`）。

---

### 7. 元规则 D（`check-rule-validator-coverage`）—— **出口 (b) 是一枚橡皮图章，本方案最大的问题在这**

方案把 D 排在最前（改动 0 / 0c），称它"最便宜，也最根治"。
我把 D.1 的算法逐字实现（去掉代码块与引用块，取含 `必须|不得|禁止|一律` 的行，检查 ±3 行内有没有 (a)/(b)/(c)）：

```
规则句总数: 532
exit (a) 点名 tools/xxx.mjs :                    4
exit (c) DISCRETIONARY     :                    0
exit (b) 字面读法：snake_case 且"该串在 tools/*.mjs 里出现过" : 322
exit (b) 严格读法：snake_case 是 tools 里真实的 rule: 名   :  22
无任何出口 :                                    207
```

**出口 (b) 放过的 300 条，绝大多数是 payload 字段名，不是规则名。**
统计一下给规则句发"已对账"通行证的 token：

```
 13  residual_risks         ← 一个数组字段名
  9  escalation_required    ← 一个布尔字段名
  6  output_snippet         ← 一个字段名
  6  failure_category       ← 一个枚举字段名
  6  searched_scope         ← 一个字段名
  5  finding_id             ← 一个字段名
  5  disproof_condition     ← 一个字段名
  5  shared_dependencies    ← 一个字段名
```

样例（全部来自真实文件，`wave5-verify.md`）：

```
:41  [finding_id]      | 同一 `finding_id` 的两个并行验收实例 | **禁止**——它们会读同一份代码…
:53  [fix_agent_id]    **`fix_agent_id` 必须传**——它不是给验收Agent看的背景信息…
:82  [failure_trigger] 2. **独立执行能直接瞄准故障的检查**。验收Agent必须自己构造…
```

这三条规则句里**没有任何一条提到校验器**；它们只是**提到了一个 JSON 字段名**，
而那个字段名恰好在 `check-payload.mjs` 里出现过（因为它是 schema 的一部分）。
方案 D.1 的正则是 `[a-z][a-z0-9]+(?:_[a-z0-9]+){1,}` + "该串在 `tools/*.mjs` 里出现过"——
**这个正则匹配的是"任何 snake_case 标识符"，判据是"它在工具源码里出现过"。**
schema 字段名当然在工具源码里出现。于是：

> **一条提到 `residual_risks` 的规则句，会被 D 判为"已与校验器对账"。**
> 而 `residual_risks` 在整个 `tools/*.mjs` 里只在 `gen-contract-examples.mjs:184` 的一个字面量里出现过，
> **没有任何校验器读它的内容**——这正是本方案 `:22` 自己写下的第一条事实。

**这就是"看起来在检查，实际上什么也没检查"的教科书形态，而且它出现在方案用来根治这个病的工具里。**
而且比现状更糟：现在至少没有人报一个绿色的覆盖率数字；D 上线后会有。

**D 自己还有一处自相矛盾**：D.3 与 Q3 都说"首版只统计不判定（`--report-only`）"，
但改动 0 的规则表把 `rule_without_validator` 定成 **FAIL**，只让 `rule_sentence_overcount` 走 WARN。
按方案自己估计（"`wave5-verify.md` 的 50 条硬规则里几乎全部无出口"），
首版一开就会红 207 条——**正好触发它自己引用的 `:1558-1562`"会被整体关掉"**。
方案在 0c 里写了"先测量再闸门"，但没有一条判据把这个顺序钉住（没有"ledger 未建立时强制 report-only"的规则）。

**建议**：**保留 D 的想法，删掉 D 的实现**。
- 出口 (b) 必须改成"该串是 `tools/*.mjs` 里某个 `rule: '…'` 的值"（严格读法）。实测这样只剩 22 条合法出口，
  放过的 300 条假出口全部暴露——**这才是 D 想做的事**。
- `--report-only` 必须是**代码里的默认值**，而不是文档里的一句话。
- `rules_ledger` 的 `GATED` 条目必须指向真实的 `rule:` 名（方案已经这么写了，`:489`），
  但**入口 (b) 没跟着改**，两处判据不一致。

---

---

## 二·补：C2 在我分析期间已被实现，我实测了它

报告写到一半时，工作区出现了 `tools/check-payload.mjs` 的未提交改动（`git diff --stat`：+94 行），
实现了方案改动 4 的 C2 部分。我没有改它，只是拿真实产物跑了它：

**枚举校验部分（`missing_mutation_check` / `invalid_mutation_check` / `missing_mutation_scope` /
`invalid_mutation_scope` / `invalid_mutation_skip_reason`）**：这是**真的补上了一个洞**，
`mutation_scope` 在 `tools/` 里从 0 实现变成有实现。这部分我的判定不变——保留，而且它应该是第 1 位。

**但它同时新增的 `mutation_scope_weak_unexplained`（WARN）在真实数据上是 9/9 触发：**

```
round1-05-verify-1-attempt1-fail.md   mc=performed ms=implementation_only notesHasCallsite=false -> weakWarn=true
round1-05-verify-1.md                 ...  -> weakWarn=true
round1-05-verify-2.md                 ...  -> weakWarn=true
round1-05-verify-3.md                 ...  -> weakWarn=true
round1-05-verify-4-attempt1-fail.md   ...  -> weakWarn=true
round1-05-verify-4.md                 ...  -> weakWarn=true
round1-05-verify-5.md                 ...  -> weakWarn=true
round1-05-verify-6.md                 ...  -> weakWarn=true
round1-05-verify-7.md                 ...  -> weakWarn=true
```

**9 份真实验收产物，9 份触发。** 命中率 100% 的 WARN 与命中率 0% 的 WARN 是同一件东西：
一个不携带信息的信号。这与本报告第三节对 `universal_claim_thin_evidence` 的判定完全同形——
方案 `:391` 自己写"级别取 WARN 起步…**若首轮实测零误报再升 ERROR**"，
现在首轮实测是"**9/9 全中**"：它连"零误报"都做不到，升级路径从第一天就是空的。

顺带一个实现层面的观察：这条规则用 `/调用点|callsite|call[- ]?site/.test(notes)` 判"有没有解释"。
最省力的绕过是**在 notes 里加一句"未做调用点变异"**——那句话本身就是它的触发词的反面，但正则匹配的是**出现**，
不是**语义**。于是"补上一句承认没做"就能把 WARN 消掉。

**结论不变**：C2 的枚举校验保留（第 1 位），`mutation_scope_weak_unexplained` 这条 WARN 应当
要么删掉，要么按"是否属于『函数返回值决定用户可见行为』"重新定义——后者方案自己说了做不到（Q4-2）。
**把做不到的事做成一条 100% 触发的 WARN，就是本报告标题说的那件事。**

---

## 三、总表

| 新规则 | 射程（抓什么 / 抓不到什么） | 最省力的绕过 | 事实 or 自述 | 分母 0 时 | 建议 |
|---|---|---|---|---|---|
| `claim_exceeds_samples` | 只抓"agent 亲手写了 exhaustive/boundary 且数字<2"；抓不到实际只测 1 种形态 | 写 `input_space_basis:"unknown"` 或 `"single_sample"` → **零命中** | **自述** | 未定义 | **降级 WARN**，或改成数文本块 fixture |
| `input_variants_inflated` | 分母是方案自造的量；在目标仓库恒定失效 | 挂在 observed=0 的文件上 → 诚实填就 FAIL；挂在 observed=14 的文件上 → 虚报到 42 也过 | 半自述 | **未定义 → 阈值变 0，反向惩罚诚实** | **删掉**（无定标、无定义、无分母规则） |
| `universal_claim_thin_evidence` | 只抓"产物里出现 all/any 这几字母" | 什么都不用做——**9/9 真实产物自动亮**，无人再读 | 半事实（读错字段） | `verification_commands` 在 verify 上**不存在** → 恒 ≤1 | **删掉** |
| `input_basis_undeclared` | 只抓"字段没填" | 填 `"unknown"` | 自述 | — | 保留为 WARN，但**必须配 `unknown` 的后果规则**，否则它就是个占位 |
| `assertion_target_dropped` / `assertion_reversed_*` / `test_disabled` | **唯一真检测**：git 取的断言四元组；抓不到 untracked 新文件（本轮 0%）、dirty 文件（本轮 4/7） | `TEST_CONFLICT:` 一行；`@Disabled("…")` 带参 | **事实（改后）** | A 有 exit 2 ✅ | **保留**，但**先修文件清单（M+??）和 `@Disabled` 带参**，否则上线空转 |
| `assertion_unparsable` | 只是 WARN；本轮新增断言里 63% 是布尔谓词形态（`assertTrue(logs.anyContains(…)`） | 写 `assertTrue(helper(x))` 即可让强判据失效 | — | — | 保留为 WARN，但要**统计比例**并报出来 |
| `text_assertion_on_production_source` | **在定标仓库上 0 FAIL**；两个最该抓的（`.lock()`、`mobTypeName == null`）判 no-hit | 在被读的源码里补一句含 needle 的注释 → FAIL 变 WARN | **自述变体**（agent 控制被读文件） | C1 有 exit 2 ✅ | **删掉** |
| `residual_risk_disposition` 覆盖（改动 4） | 计数相等；抓不到"集合不等但计数相等"（真实 3/7） | fixer 写 `residual_risks: []`；或 verifier 自己造 flag | 自述 | 空数组 = 合法空 → 规则空转 | **改判据为集合包含**，并补数据通路 |
| `mutation_check` / `mutation_scope` / `skipped` 枚举（改动 4） | **真的补了一个洞**：今天 `mutation_scope` 在 `tools/` 里 0 实现 | 写 `"performed"` + `"implementation_and_callsite"` —— **零规则验证这个声明** | 自述 | 不适用 | **保留**（本方案最实的一处），但别把"声明"当"证据" |
| `mutation_scope_weak_unexplained` | 能抓真实案例（verify-7 确实填了 `implementation_only` 且 notes 无解释） | notes 里加一句「未做调用点变异」 | 自述 | — | **删掉**：实测 9/9 全中，与 0/9 等价，无信息量 |
| **D `rule_without_validator` 等** | 想要"规则↔校验器对账"；实际只对账"这句话里有没有出现过某个 snake_case" | **什么都不用做**：提到 `residual_risks` 就自动通过 | 事实（但判据本身错） | — | **改出口 (b) 为真实 `rule:` 名**，否则删掉 |

---

## 四、建议直接删掉的三条

1. **`input_variants_inflated`**。分母 `observed_variants` 在方案里只出现一次、无定义、无定标；
   实测在 3 个真实文件上算出 0，使诚实填报直接 FAIL；阈值 3 无出处；分母为 0 时的行为方案没写。
   **射程窄到不值得维护，而且方向是错的（惩罚诚实）。**
2. **`universal_claim_thin_evidence`**。读的字段在目标产物类型上不存在（9/9 为 0），
   字面正则把 `FIREBALL`、`writeAtomically`、`finally` 当成全称量词，实测 9/9 触发、0/9 真阳。
   它不会帮助任何人发现缺陷，只会训练人忽略黄色的字。
3. **`text_assertion_on_production_source`**。在它自己的定标仓库上 0 FAIL；
   两个最该命中的（`.lock()`、`mobTypeName` 的 null 守卫）被条件 3 的正则排除；
   缓解条件把其余全部降成 WARN，且这个降级是**agent 改一行注释就能触发**的。
   它与它要防守的东西**在真实样本上不可区分**——这正是方案 C.1 自己承认的那句"不能完全分开"，
   但实测的结论比"不能完全分开"更硬：**分错的全部落在错误的一侧。**

（第 4 条：**D 的出口 (b)**——如果不同意删，就必须改成"snake_case 必须是 `tools/` 里某个 `rule:` 字面值"。
按现在的写法保留，它会成为本方案里最讽刺的一件东西。）

---

## 五、总评：这是"补上了检测"还是"补上了更多文字"？

**四六开，偏向"补上了更多文字"，但有一件东西是真的。**

**真的那部分（约 40%）**：
- **A 的断言 diff** 是唯一"事实来自被审仓库、不来自任何人的自述"的检测，而且它的设计过程（拿 3 删 58 增定标，
  然后推翻自己的初稿）是本方案里唯一一次"设计者对自己的验证被外部事实否定"。
  这部分值钱。**但它当前的输入面（`git diff` 不含 untracked + dirty 排除）让它在本轮抓到 0 个缺陷**——
  这不是设计问题，是一个可以修的实现问题。修了它就是真检测。
- **C2 的枚举校验**（`mutation_scope` / `mutation_check` / `skipped` 理由）是真的在补一个零实现的洞。
  实测 `mutation_scope` 在 `tools/*.mjs` 里只有 1 处出现，还是范例生成器——方案说的属实。
  这是全方案**最便宜、最确定有收益**的一处，而它排在第 2 位。**应该排第 1。**

**是文字的那部分（约 60%）**：
- B 的两条（`claim_exceeds_samples` / `input_variants_inflated`）本质是**新增两个必填字段 + 一条对它们的算术**。
  agent 只要写 `"unknown"`，整套 B 归零。**这是把自述换了个字段名，不是把自述换成事实。**
- `universal_claim_thin_evidence` 是一段从未在真实数据上跑过的正则，实测 9/9 误报。
- C1 在定标仓库上 0 FAIL，且带一个一行注释即可触发的降级开关。
- `residual_risk_disposition` 的计数相等是错的守恒量（真实 3/7 情形免疫），且没有数据通路。

**最需要指出的结构性问题**：方案反复引用 `stop-hook.mjs:450-454` 和 `:1558-1562` 这两条教训
（"省略一个字段就让闸门变 WARN"、"无条件升 FAIL 会被整体关掉"），
**然后在自己新增的 4 条 WARN 规则上把这两条教训原样犯了一遍**：

- `input_basis_undeclared` = 省略一个字段 → WARN（正是 `:450-454`）；
- `universal_claim_thin_evidence` = 无条件 WARN 且 9/9 触发 → 必被忽略（正是 `:1558-1562`）。

它把它们当作**引用**写进了论证，而不是当作**约束**用在了设计上。这与方案 Q4-6 和 `:575` 承认的
"设计者对设计的验证，不是独立验证"是同一件事的第三次实例。

**最后一句话**：这份方案在**"承认做不到什么"上非常诚实**（Q4 的七条，逐条可信，且实测支持），
在**"我新加的东西真的会响吗"上完全没做过验证**——
A 章做了定标，B/C/D 三章一条定标都没有，而实测显示这三章新加的 4 条规则里，3 条在真实样本上
要么恒亮要么恒不亮。**方案把"设计"和"验证设计"的差额，从 A/B/C 三个模式，搬到了 B/C/D 三个新规则上。**
两年后如果这份方案被原样实施，最可能的结果是：
**A 因为看不见 untracked 文件而静默空转，B/C 因为恒定误报或恒定漏报被一条 WARN 关掉，
D 给出一个绿色的"已对账"数字，而 `wave5-verify.md` 的 50 条硬规则一条都没接上校验器。**

要避免这个结局，只需要改一件事：**把 A 章对待 A 的方式，用在 B/C/D 上——先拿真实样本定标，再写判据。**
方案已经知道怎么做了（`GROUND-TRUTH-assertion-diff.md` 就是范本），只是没有对 B/C/D 做同样的事。
