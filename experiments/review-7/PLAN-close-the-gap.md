# 把 review-7 的缺陷模式变成可执行检查——实现方案

**日期**：2026-11-17
**范围**：只改框架仓库。不触碰被审仓库（`<TARGET_PARENT>/...`），不做任何 git 写操作。
**任务范围**：A / B / C 三条来自任务书；**D（元规则）是本轮读定标时浮现的第四条**，它与 A/B/C 同源且成本最低、根治面最大，故一并给出（见 Q1 末尾「模式 D」）。

**一句话结论**：**A 能做但必须做成「申报制」；B 和 C 的核心做不到；D（规则→校验器对账）能做且应最先做。**
本方案的第一稿在 A 上设计错了——真实定标（3 删 58 增）显示直觉设计有 1/3–2/3 假阳性，已按定标重写。
**前置阅读已完成**（本轮真读，行号均取自本轮回读）：`framework/templates/wave4-fix.md`（380 行）、
`framework/templates/wave5-verify.md`（338 行）、`framework/components/output-contract/fix.md`（352 行）、
`framework/components/output-contract/verify.md`（312 行）、`framework/components/output-contract.md`（811 行）、
`framework/artifacts/run-state.md`（989 行）、`tools/verify-postfix-snapshot.mjs`（223 行）、
`tools/check-fix-artifacts-envelope.mjs`（424 行，读前 120 行 + 文件头）、`tools/stop-hook.mjs`（1598 行，读 §2/§3/§3.5/§3.6b/§3.7 全段）、
`tools/check-payload.mjs`（1557 行，读 §3/§4/§5 关键段）、`tools/check-files-touched-harness.mjs`（1112 行，读 §6–§7）、
`tools/check-promises.mjs`、`tools/check-blindspots.mjs`、`tools/check-all.mjs`、`tools/check-enum-consistency.mjs`、
`experiments/review-7/{SUMMARY.md, finding-F1.md, finding-F2F3F4.md, finding-F6F7.md, fix-F2F3F4-contract.md, fix-F7.md, LESSON-track-vs-eliminate.md, GROUND-TRUTH-assertion-diff.md}`、`CAPABILITIES.md`。

---

## 0. 先把「现在到底缺什么」钉死在代码上

**四条阻断性事实，全部来自本轮回读或本轮实测，不是推断：**

1. **规则存在、检测不存在。** `wave4-fix.md:200` 逐字写着「不得通过删除、跳过、弱化或重写测试断言来让检查"通过"……必须在 `residual_risks` 中标记 `TEST_CONFLICT`」。
   而 `grep -rn "TEST_CONFLICT" tools/` 的命中数是 **0**（连注释都没有）。
   `residual_risks` 在整个 `tools/` 里只出现在测试夹具的构造参数中（`check-payload.test.mjs:1311`、`fix-phase-e2e.test.mjs:240`、`gen-contract-examples.mjs:184`），**没有任何校验器读过它的内容**。
   `wave4-fix.md:342` 的自检行「未修改测试以通过」是**纯自觉项**。

2. **框架从不看被测仓库的 `git diff`。** `grep -rn "git diff\|git show\|cat-file" tools/*.mjs` 只命中 `gen-contract-examples.mjs`（与本次无关）和 `verify-postfix-snapshot.mjs`（只跑 `git status --porcelain`，见 `:100`）。`verify-postfix-snapshot.mjs:29-32` 自己写明「不做 git 操作（不 stash、不 diff 全仓）……不判断那些改动『对不对』」。
   **「改了什么」这件事，框架手里只有 `files_touched`（自述）与 `git status`（只有 `M`/`??`，没有内容）。**

3. **验收波的独立性纪律是对的，且它排除了「让修复者自报改了哪些测试」这条路。**
   `wave5-verify.md:15` 明确验收输入只有三样，`verification_commands` 不在其中；`:47-52` 的派发参数 `✗ 不传: verification_commands, output_snippet, artifact_path`；`:95-108` 用整节解释信息隔离。
   `wave5-verify.md:124` 甚至已经写出了模式 A 的判据文字——「测试被修复Agent修改过（对照 `files_touched` 与测试文件清单）」——**但括号里那件事没有任何工具做**。

所以本方案的立足点不是「加更多文本规则」，而是：**把已经写好、但只有人在读的三条判据，换成从被审仓库 git 里取的事实。**

4. **定标先于设计，而且它推翻了设计的初稿。** `experiments/review-7/GROUND-TRUTH-assertion-diff.md` 直接读被审仓库的测试 diff，得到 **3 处删除 / 58 处新增**（`:11-16`），逐处人工判定后：**2 处是合法的断言反转**（`TabListManagerTest` 的两条，原断言编码的前提经反编译证伪），**1 处是行级 diff 的假象**（方法改名 + 原断言原样保留，`:20-24`）。
   **结论：按「极性翻转即 FAIL」或「按方法名匹配」设计，在这个真实样本上的假阳性率是 1/3 到 2/3。** 本方案的 A 章按这份定标重写过（见 A.2）。

---

# Q1 三条模式能否机械检查（+ 一条元规则）

## 模式 A：把测试改成反向期望

### 结论：**能，但必须做成「申报制」而不是「翻转即错」。定标（3 删 58 增的真实样本）推翻了直觉设计。**

一句话判据：**按断言的语义对象（subject）跨方法匹配，断言消失 = FAIL；断言被改反但没申报 `TEST_CONFLICT` = FAIL；申报了 = WARN + 人工裁决。**
按直觉设计（极性翻转即 FAIL、或按方法名匹配）在真实样本上的假阳性率是 **1/3 到 2/3**（见 A.2），会在第一个样本上就被关掉。

### A.1 输入是什么、谁提供

| 数据 | 来源 | 谁提供 |
|---|---|---|
| 被改动的测试文件清单 | `git -C <repo> diff --name-only <ref>` 一次调用 | **hook 自己**（`stop-hook.mjs:1128` 已经在跑 `git -C repoDir status --porcelain`，`:1329` 已经在跑 `git -C repoDir rev-parse HEAD`，「hook 会 shell 出 git」是既有惯例，不是新增依赖） |
| 断言变更前后的**原文** | `git -C <repo> show <ref>:<path>` 取基线全文 + `readFileSync(<repo>/<path>)` 取工作区全文 | 同上 |
| 基线 ref | `state.fix_baseline.head`（`run-state.md:408-419` 定义，`:439` 规定「进入 wave4 之前抓一次」） | 主 Agent 已写；缺失则降级为 `HEAD` 并 WARN |
| 「修复前就脏」的测试文件 | `state.fix_baseline.dirty_paths`（`run-state.md:418`） | 主 Agent 已写；用于排除跨轮噪声 |
| 修复者是否申报了冲突 | 各 fix 产物的 `payload.residual_risks[]` 里是否有 `TEST_CONFLICT: <path>` 条目 | 修复 Agent 自报 —— **只作为「消音器」，不作为「事实来源」**（见 A.4）。它决定一条命中是 FAIL 还是 WARN+人工裁决，不决定有没有命中 |

**关键：断言的新旧内容来自 git，不来自任何人。** 修复 Agent 不参与提供事实，只被允许**申报一个既成事实**（「我确实改了测试，因为原断言与正确修复冲突」），而这个申报的代价是把该缺陷推进 `HUMAN_DECISION_REQUIRED`、不算已修复（`wave4-fix.md:301`、`wave5-verify.md:163`）。这与 `wave5-verify.md:15` 的独立性完全不冲突：验收 Agent 仍然读不到修复者的自述，机械检测在**相位闭合门**上独立运行。

### A.2 判定算法（具体到比较什么）

**先定标，再设计。** 被审仓库本轮全部测试改动实测（`experiments/review-7/GROUND-TRUTH-assertion-diff.md:11-16`）：
**删除的断言行 3 条，新增 58 条。** 这 3 条的逐处人工判定是：

| # | 位置 | 变更 | 判定 |
|---|---|---|---|
| 1 | `TabListManagerTest.refreshFailureIsContained` | `assertNull(field("refreshTask"))` → `assertSame(before, field("refreshTask"))` | **合法**（原断言编码的前提是错的，反编译 `CraftScheduler.mainThreadHeartbeat()` 证明任务从未被 cancel） |
| 2 | 同上 | `assertEquals(-1, field("scheduledPeriod"))` → `assertEquals(20, ...)` | **合法**（同一根因） |
| 3 | `ShopConfigLoaderTest.missingPriceDefaultsToOne` | 方法**改名** + 原断言**原样保留** + 新增 3 条 | **假阳性** |

这份定标推翻了两种直觉设计，必须写进算法：

- **「极性翻转即 FAIL」不能做。** 处 1、2 正是 `zero/negative` → `exact(other)` 的翻转，在真实样本上的假阳性率是 **2/3**。而这两处是**正确的**——`wave4-fix.md:200` 对这种情况指定的出路是 `TEST_CONFLICT` + 人工裁决，但把它当 FAIL 拦在闭合门上，会把一次合法修复打断。
- **「按方法名匹配」不能做。** 处 3 的方法被改名，断言一字未改；行级 diff 与「方法名 + 断言字符串」匹配**都会**把它判成「删除了一条断言 + 新增三条」（`GROUND-TRUTH-assertion-diff.md:58` 原文：「任何基于『文本行匹配』或『方法名/断言字符串匹配』的检测都会把它判成违规。在这个只有 3 处删除的样本上，假阳性率 1/3」）。

**因此算法是「按断言对象（subject）跨方法匹配」，且把「翻转」从 FAIL 改成「必须申报」：**

```
对每个「被改动的测试文件」T：
  old = parse_assertions( git show <ref>:<T> )
  new = parse_assertions( readFileSync(repo/T) )

parse_assertions(src) 产出三层结构：
  subjects: Map<subject_key, [assertion...]>      ← 文件级，不按方法分组
  methods : Map<method_name, [assertion...]>      ← 只用于生成人读的定位信息
  unparsed: [line...]
```

`subject_key` 是断言的**语义对象**做规范形归约后的字符串（`GROUND-TRUTH-assertion-diff.md:86` 起的「对设计的三条硬约束」给的可行方向）：

| 原形态 | 规范形 |
|---|---|
| `X.size()` / `X.length` | `size(X)` |
| `X.isEmpty()` | `size(X)`，期望 0 |
| `X.getItems().get(0).getPrice()` | `X.getItems().get(0).getPrice()`（点路径原样，只抹空白） |
| AssertJ `assertThat(X).hasSize(n)` | `size(X)`，期望 n |
| Jest `expect(X.length).toBe(n)` | `size(X)`，期望 n |
| `field("refreshTask")` | `field("refreshTask")`（字符串字面量保留，它是身份的一部分） |

`expected` 与 `predicate_class` 五档（`exact(n)` / `zero_or_empty` / `negative` / `existence_only` / `broadened`）同前。

**判定（五条规则；注意前两条的级别与直觉相反）**：

| 规则 | 判据（精确） | 级别 |
|---|---|---|
| `assertion_target_dropped` | 某个 `subject_key` 在 `old` 有断言、在 `new` **整份文件里一条都没有** | **FAIL** |
| `assertion_reversed_unreported` | 同一 `subject_key` 两侧都有，但 `predicate_class` 变档（含极性翻转）或 `exact` 的 `expected` 变值，**且**没有任何 fix 产物在 `residual_risks` 里以 `TEST_CONFLICT: <T>` 申报 | **FAIL** |
| `assertion_reversed_reported` | 同上，但已申报 | **WARN + 强制 `HUMAN_DECISION_REQUIRED`** |
| `test_disabled` | `new` 新增 `@Disabled` / `@Ignore` / `it.skip(` / `@pytest.mark.skip` / `xfail` | **FAIL** |
| `assertion_unparsable` | 抽不出 `subject_key` 的断言行 | **WARN**（**该文件强判据不生效，必须明说**） |

**为什么 `assertion_target_dropped` 用「整份文件里都没有」而不是「同一方法里没有」**：处 3 证明方法名会变；
`wave5-verify.md:125` 的判据「断言被弱化」关心的是「这个行为还有人钉着吗」，不是「钉在哪个方法里」。
反过来，这也意味着**把断言搬进 helper 会被算作「还在」**——这是有意的保守选择：宁可漏报也不误拦（`stop-hook.mjs:1434`「假 FAIL 会让人把整段关掉，比漏报更糟」）。

**为什么 `assertion_reversed_unreported` 判 FAIL 而不是「检测到翻转就 FAIL」**：
FAIL 的判据是**「你做了一次通常需要理由的动作，但没有留下理由」**，而不是「你做了这个动作」。
这与框架里已有的形态同构——`wave4-fix.md:218` 的 `BASELINE_UNVERIFIED`（没做就必须声明）、
`:233` 的 `AFFECTED_ISSUES_EMPTY_CONFIRMED`（空数组必须是被检查过的结论）。
`GROUND-TRUTH-assertion-diff.md:94` 末句要求的正是这个：「它应当触发『要求 `TEST_CONFLICT` 声明 + 反编译级证据』，而不是直接 FAIL」。
落地后，处 1、2 会命中 `assertion_reversed_reported`（WARN + 人工裁决），处 3 **一条都不命中**——按 `subject_key` 匹配时 `getItems().get(0).getPrice()` 两侧都在、期望值都是 1。

**`test_disabled` 的已知假阳性**：`GROUND-TRUTH-assertion-diff.md:109-110` 指出 `YamlFilesTest` 用 `Assumptions.assumeTrue` 跳过平台相关用例，那是 1 个合法 skip。
因此 `Assumptions.assumeTrue/assumeFalse` **不在** `test_disabled` 的触发词里——只有无条件禁用（`@Disabled` 无参、`@Ignore`、`skip(` 无 `if`）才命中。

### A.3 假阳性风险与误拦代价

| 假阳性来源 | 缓解 | 残余 |
|---|---|---|
| 合法重述（定标处 1、2） | 走 `assertion_reversed_reported`：只要 `TEST_CONFLICT` 申报就降为 WARN。**定标已证明这类是真的会发生**（2/3） | 申报的代价是「该条不记为已修复」（`wave4-fix.md:301`、`wave5-verify.md:163`）。对一个确实修对了的缺陷，这是**偏严**的：它会被推到「待人工裁决」。这是本方案唯一主动接受的偏严，理由是 `TEST_CONFLICT` 本来就是框架给这类变更指定的唯一出口 |
| 方法改名 + 断言包裹（定标处 3） | 按 `subject_key` 跨方法匹配 → 不命中。**这是定标直接验证过的一条** | 方法改名 + 同时把断言挪进 helper 会命中 `assertion_target_dropped`（因为 helper 不在同一文件） |
| 测试文件是新增的 | `old` 为空 → 只跑 `test_disabled` | 新增文件里的反向断言抓不到 → 记入 Q4 |
| 断言抽进 `assertXxx` 自定义包装 | 抽不出 `subject_key` → `assertion_unparsable` WARN，**绝不猜** | 该文件强判据不生效；沿用 `stop-hook.mjs:1113-1122` 的纪律：「检查没跑」必须与「检查通过」可区分 |
| 该测试文件在 `fix_baseline.dirty_paths` 里（跨轮已脏） | 排除，避免上一轮改动每轮重报 | 排除 = 对该文件放弃强判据 → WARN + 点名（`run-state.md:506` 已记录这个缺口） |
| `git show <ref>:<T>` 取不到（重命名 / 删除） | 重命名按 `git status --porcelain` 的 `-> 新路径` 取；删除文件只跑 `assertion_target_dropped` | 重命名 + 同时弱化会漏 → WARN |

**误拦的代价（真实数字）**：一次 7 条缺陷的修复 = 9 个子 agent、336 次工具调用、约 90 分钟（`CAPABILITIES.md:115-119`）。
误拦一条 = 多一轮人工裁决 + 该条从「已修复」降为「待裁决」。相比 review-7 的实际损失（7 条里 5 条有缺陷、2 条严重，`SUMMARY.md:11`），这个代价低一个数量级。
**但定标给出的 1/3～2/3 假阳性率说明：如果按直觉设计，这道闸门会在第一个真实样本上就被关掉。所以 A.2 的「申报制」不是妥协，是能否落地的前提。**

### A.4 为什么不用「修复 Agent 自报改了哪些测试」

因为那会把 `wave5-verify.md:95-108` 整节作废，并且撞上 `CAPABILITIES.md:67-76` 自己承认的极限：「`files_touched`、`spawned_fix_agents`、`fix_baseline`——**全是主 Agent 写的**。两个自述互相对账不产生任何外部约束力。」
本方案里申报只承担**一个方向**的作用：把一个「已发生但未申报」的 FAIL 降成「已发生且已申报」的 WARN + 人工裁决。**自述只能让状态变差（从可闭合变成 `PARTIALLY_CLOSED`），不能让它变好。** 断言的新旧内容始终来自 git。

---

## 模式 B：判定面只覆盖自己炮制的样本

### 结论：**核心做不到；能做的只有「声明与证据自相矛盾」这一条，而它恰好是最有价值的那条。**

### B.1 为什么核心做不到（先把话说死）

F1 的失效是「192 个行边界截断样本里只堵住 1.0%」（`finding-F1.md:16`、`:79-88`；
`SUMMARY.md:33-48`）。要机械判定这件事，必须**拿 192 个截断样本去跑被审仓库的代码**。
框架从来没执行过被审仓库的任何构建或测试：

- `verify-postfix-snapshot.mjs:30`「不做 git 操作（不 stash、不 diff 全仓），只用 `git status --porcelain` 拿清单」；
- `grep -rn "maven\|gradle\|mvn\|pytest\|npm test" tools/*.mjs` 在框架工具里没有对目标仓库的调用点；
- `CAPABILITIES.md:86-89` 自己写「只有 dsh 能用」，且它的输入是 session 日志，不是执行结果。

**所以「覆盖率不足」本身不可判定。** 任何声称能算「修复覆盖了 X% 的输入空间」的检查，都会变成第二个「自造样本验证自己」——即它自己变成模式 B。

### B.2 能机械做的那一条：声明与证据的量化矛盾

F1 的根因可以精确表述成一句可比较的话：**证据是 1 个样本，结论是「截断已被拦住」（全称断言）。**
这一步是纯算术，不需要跑任何代码：

**输入**
- 新增两个 verify payload 字段（见 Q2）：
  - `input_space_basis: "exhaustive" | "boundary" | "single_sample" | "unknown"`
  - `input_variants_covered: <int>`
- 从被引用测试文件里**数出来的**输入变体数：对 `git diff --name-only` 命中的测试文件的新增行，统计
  - `@CsvSource` / `@MethodSource` 的行数（每行 1 个变体），
  - `@ParameterizedTest` 的存在（若声明 `single_sample` 而测试是参数化的 → 反向矛盾），
  - 数组 / `List.of(` / `[...]` 字面量的元素数，
  - `assertThrows` / 循环里的 `for (int cut = ...)`
- 修复产物正文里的全称量词（`任意|所有|每一个|穷举|全部|any|all|every|exhaustive`）与 `verification_commands` 引用的 distinct test id 数。

**判定**

| 规则 | 判据 | 级别 |
|---|---|---|
| `claim_exceeds_samples` | `input_space_basis ∈ {exhaustive, boundary}` 且 `input_variants_covered < 2` | **FAIL**（这是**矛盾**，不是判断：声明「穷举」而证据是 1 个样本，两句话不能同时为真） |
| `input_variants_inflated` | `input_variants_covered > observed_variants × 3`（声明的样本数超过源码里能数出来的 3 倍） | **FAIL**（同一类矛盾，反方向） |
| `universal_claim_thin_evidence` | 产物正文含全称量词，且 `verification_commands` 里 distinct test id ≤ 1 | **WARN** |
| `input_basis_undeclared` | verify payload 无 `input_space_basis` | **WARN**（存量产物不因新增字段一夜不合规，沿用 `run-state.md:449-451` 的纪律） |

### B.3 为什么只做到这里

`claim_exceeds_samples` 抓得住 F1 的**形式**（1 个样本 + 全称结论），抓不住 F1 的**实质**（那 1 个样本恰好是最容易通过的形态）。
前者仍然有价值：它把「`SUMMARY.md:94` 那句『用一个自造的样本验证自己』」变成一个会红的退出码，并强制修复者自己写出 `single_sample` —— 一旦写成 `single_sample`，`wave5-verify.md` 的「带保留通过」就该被触发，人就会看到。
后者只能靠 review-7 真正用的那套：5 个独立红队 agent + 穷举探针（`SUMMARY.md:3-5`）。**这一点不要假装能替代。**

---

## 模式 C：注释承诺 > 代码实际

### 结论：**核心做不到。只有两小块能机械做：源码守卫的「文本断言」和变异检验的申报字段。**

### C.1 能做的第一块：文本断言（有精确形态）

`finding-F6F7.md:223` 记录的那个测试：「只断言源码里**出现字符串** `AtomicMoveNotSupportedException`，是文本断言，不是行为断言」。
这个形态是**结构可判**的：

**判据**：在一个测试文件的方法体内，同时满足
1. 出现读取文件内容的调用（`Files.readString` / `readFileSync` / `Files.readAllBytes` / `new String(Files.readAllBytes` / `getResourceAsStream`）；
2. 被读取的路径字符串解析后落在**生产源码树**（`src/main/`、`app/`、`lib/`、`src/`，且不属于 test 目录）；
3. 断言是 `assertTrue(<var>.contains("<literal>"))` / `assertIn("<literal>", <var>)` / `assertThat(<var>).contains("<literal>")`，且 `<literal>` 是一个**标识符或异常类名**（匹配 `^[A-Za-z_$][\w$.]*(Exception|Error|Policy|Mode)?$` 或含 `.` 的全限定名）。

→ `text_assertion_on_production_source` **FAIL** 仅当该测试方法里**没有其他任何非文本断言**；否则 **WARN**。
理由：这三条同时成立时，那个测试**在逻辑上不可能失败于行为变更**——它只钉住了「这几行字还在」。它给出的是 `wave5-verify.md:117` 所要求的「瞄准性」的反面。

**定标给的两条硬约束（`GROUND-TRUTH-assertion-diff.md:102-103`）**：
- 被审仓库里这种测试共 **4 处 / 3 文件**：`AirdropSpawnGoalTest:287`、`CommandsDocumentConcurrencyTest:137`、`CommandsDocumentAtomicWriteTest:163,179`、`CommandsDocumentFallbackTest`。
- 其中 `javadocStopsClaimingTheFalseInvariant` 是**刻意的**文本守卫（它守的对象就是注释本身，F7 的修复正是「删掉假承诺」）。**这类测试是对的，判 FAIL 就是误拦。**
  缓解：命中时检查被断言的 needle 是否是**注释**（needle 出现在 `//` 或 `/* */` 里）——守注释的测试一律降 WARN。这不能完全分开「守注释」与「用注释代替行为断言」，所以 C1 恒有假阳性，**这是它只能做窄形态的原因**。

### C.2 能做的第二块：变异检验的申报字段（今天完全没校验）

`wave5-verify.md:129-148` 把变异检验从「可选」升为「强制」，并规定 `mutation_check: "performed"` + `mutation_scope`，且**只允许两种 `skipped` 理由**（`harness_unsupported` / `unsafe_revert`，`:136-140`），其余「一律视为 `CONTRACT_VIOLATION`」。
而 `check-payload.mjs` 里对 `mutation_check` 只有**一条**规则（`:1513-1520`）：`performed` 时给一条「验收 Agent 是只读角色」的 WARN。
**枚举未校验、`mutation_scope` 未校验、`skipped` 的理由未校验。** 所以今天写 `mutation_check: "yes"` 或 `"skipped"` + `notes: "时间不够"` 都能过。

这是**现成的、便宜的一次补洞**（见 Q2 改动 4）。它与模式 C 的关系：F7 那条「降级分支在全部测试中一次都没被执行过」（`finding-F6F7.md:222`）正是**调用点/实现变异**能直接暴露的；若变异是强制的且被机械校验，F7 会以 `FIX_INCOMPLETE` 而不是 `PASS` 收尾。

### C.3 做不到的部分（明确说「做不到」）

**「javadoc 写的『任何失败都保留旧目标』在这条降级路径上是假的」**（`finding-F6F7.md:216-218`）——要做到这一点，必须证明「这段代码在其声称的输入域上满足该谓词」。这是**规格验证**，需要：
- 抽取注释里的不变量（自然语言，无形式语法）；
- 把不变量翻译成可判定的条件（需要程序语义）；
- 对每条失败路径做符号执行或穷举。

`check-promises.mjs` 是这个方向已有的最诚实尝试，它在文件头 `:15-18` 自己列出了三条做不到的事：「承诺写在散文里而非 JSDoc」「这个该有的守卫没有」「跨文件的入参防御」。
F1/F7 的注释恰恰**不是 JSDoc 形态**（是 `//` 与 `/**` 混写的散文），落在它自认做不到的第一类里。
**结论：模式 C 的核心只能靠人（或独立红队 agent）。不要设计假检查。** 替代方案见 Q4。

---

## 模式 D / 元规则：三条模式的共同形态是「规则写了，机器没读」

### 结论：**这一条能机械做，而且它比 A/B/C 任何一条都便宜、都根治。**

本轮回读 `experiments/review-7/` 时又出现三份定标（`DIAGNOSIS-why-the-framework-missed-it.md`、`GROUND-TRUTH-checklist-not-gated.md`、`GROUND-TRUTH-example-violates-contract.md`），
它们把 A/B/C 收束成一条可判定的元规则。**这三份的核心事实我都独立复验过**：

| 事实 | 复验命令 | 结果 |
|---|---|---|
| `TEST_CONFLICT` 零实现 | `grep -rn "TEST_CONFLICT" tools/` | **0 命中** |
| `mutation_scope` 零实现 | `grep -rn "mutation_scope" tools/*.mjs` | **1 命中，且是范例生成器**：`gen-contract-examples.mjs:192` |
| 契约范例自己违反正文 | `verify.md:185` 要求 `implementation_and_callsite`，`gen-contract-examples.mjs:192` 写 `implementation_only`、`:195` 的 `notes` 无解释 | 定标属实 |
| 「已验证」的章是真的跑过校验器 | `gen-contract-examples.mjs:243` 调 `check-payload.mjs`，`:250-253` 不过就不写，`:273` 写「已经过 check-payload.mjs 验证」 | 属实——**它验证的是校验器知道的那部分，而 `mutation_scope` 校验器不知道** |
| 必查清单只校验 `length > 0` | `check-payload.mjs:986-988` 只判 `Array.isArray && length > 0`；且整段只在 `noEv.length > 0` 时执行（`:983-984`） | 属实 |
| 模板里的硬规则数与「点名了工具」的数 | `DIAGNOSIS:26-31` 的表：`wave5-verify.md` 50 条硬规则、**0 条点名工具** | 未逐条复验（成本高），但与本轮读到的 `wave5-verify.md` 观感一致 |

### D.1 判定算法

这是**静态对账**，不需要跑任何东西：

```
对 framework/templates/*.md 与 framework/components/**/*.md 的每一个「规则句」：
  rule_sentence = 含 (必须|不得|禁止|一律|must|shall|never) 的行（去掉代码块与引用块）

  若 rule_sentence 附近 ±3 行内出现下列任一「出口标记」→ 视为已对账：
    (a) 点名了 tools/ 下某个脚本（正则 `tools/[\w.-]+\.mjs`）
    (b) 点名了某个规则名（正则 `[a-z][a-z0-9]+(?:_[a-z0-9]+){1,}` 且该串在 tools/*.mjs 里出现过）
    (c) 显式标注 `DISCRETIONARY`
  否则 → 违规
```

| 规则 | 判据 | 级别 |
|---|---|---|
| `rule_without_validator` | 规则句没有 (a)/(b)/(c) 任一出口 | **FAIL** |
| `discretionary_without_reason` | 标了 `DISCRETIONARY` 但同一行/下一行没有理由（≥10 字） | **FAIL** |
| `named_rule_not_in_tools` | 规则句点名了一个形如 `snake_case` 的规则名，但 `tools/*.mjs` 里搜不到 | **FAIL** |
| `rule_sentence_overcount` | 汇总统计有规则句、但**其中一条出口都没有**的文件数与阈值不符 | WARN（防口径漂移） |

**为什么这个判据不会退化成「给每条规则加一句 `DISCRETIONARY` 就过」**：`discretionary_without_reason` 强制写理由。理由写不出来的规则，就是「本来就没人打算执行」——它应当被删掉，而不是被标注。

### D.2 它会立刻暴露什么（这就是它的价值）

按 `DIAGNOSIS:143-146` 的推演，这条元规则上线第一天会红出：
- `wave4-fix.md:200`（`TEST_CONFLICT` 零实现）→ 本方案的改动 1 修掉它；
- `verify.md:185`（`mutation_scope` 零实现）→ 改动 4 修掉它；
- `wave2-audit.md:629` 模式 5（被排除在检查项外）→ 必须显式写 `DISCRETIONARY` + 理由，不能沉默降级；
- **`wave5-verify.md` 的 50 条硬规则里，绝大多数**会成为 `rule_without_validator`。

最后一条是最重要的：**如果这条元规则一次上线就红出几十处，它会被立刻关掉。** 所以它必须以「分层存量豁免」落地，机制照 `stop-hook.mjs:472-480` 已对 `legacy_artifacts` 用过的做法：
- `state.json`（或工具参数）声明 `rules_ledger`：`{ rule_anchor: "wave5-verify.md:129", resolution: "GATED" | "DISCRETIONARY" | "PENDING", reason }`
- `DISCRETIONARY` 必须带理由；`GATED` 必须点名规则名且该名在 tools 里存在；
- **`PENDING` 条目计入一个递减的预算**，预算耗尽即 FAIL —— 否则 `PENDING` 变成永久豁免，正是 `stop-hook.mjs:476-479` 点名的那种「豁免条目数 ≥ 待检总数 → 全量豁免等于把检查关掉」。

### D.3 做不到的部分

**「规则句」的抽取是正则，必然有假阳性与假阴性。** 表格里的规则（`wave4-fix.md` 的标记表、`wave5-verify.md` 的动作对照表）不含「必须/不得」字样但同样是硬判据；而叙述性的「必须」有可能只是措辞（「必须读懂这一节」）。
缓解：**首版只统计不判定**（`rule_sentence_overcount` 一条 WARN，报告出「N 条规则句 / M 条有出口」），把判 FAIL 推迟到 `rules_ledger` 建立之后。
**这也是 A/B/C 三条都适用的纪律：先测量，再闸门。**

---

# Q2 最小可行方案 —— 文件级改动清单

约定：`tools/check-*.mjs` 是 CLI（退出码 0/1/2），`tools/check-*.test.mjs` 是自测；新增工具各写**反向用例**（漏补/漏检必须被抓住），照 `verify-postfix-snapshot.test.mjs:41-58` 的 `makeRepo()` 造临时 git 仓库的做法。

### 改动 0 · 新增 `tools/check-rule-validator-coverage.mjs` + `.test.mjs`（元规则 D）

这是**最便宜、也最根治**的一条，所以排在最前。

```
用法：node tools/check-rule-validator-coverage.mjs \
        [--ledger <rules-ledger.json>] [--report-only] [--json]
退出码：0 全部对账 / 1 有 FAIL / 2 配置错误

扫描范围：framework/templates/*.md、framework/components/**/*.md（排除 output-contract/examples/）
解析：去掉 ``` 代码块与 > 引用块后，取含「必须|不得|禁止|一律」的行
出口（三选一）：(a) 同一行 ±3 行内出现 tools/xxx.mjs
               (b) 出现一个 snake_case 规则名且该名在 tools/*.mjs 中存在
               (c) 显式标注 DISCRETIONARY + 理由（≥10 字）

规则：
  rule_without_validator        FAIL  无任何出口
  discretionary_without_reason  FAIL  标了 DISCRETIONARY 无理由
  named_rule_not_in_tools       FAIL  点名的规则名在 tools 里搜不到
  rules_ledger_stale            FAIL  ledger 里的 GATED 条目，其点名的规则名已不在 tools 里
  rules_ledger_all_pending      FAIL  ledger 里 PENDING 占比 ≥ 总数（全量豁免 = 关掉检查）
  rule_sentence_overcount       WARN  只输出「N 条规则句 / M 条有出口」的统计（--report-only 时唯一输出）
```

**`--report-only` 是第一阶段的默认形态**，理由见 D.3：`DIAGNOSIS:26-31` 估计 `wave5-verify.md` 的 50 条硬规则里几乎全部无出口，首版直接 FAIL 会让这条规则当天被关掉（`stop-hook.mjs:1558-1562` 的教训）。先出统计，再建 ledger，最后才闸门。

**`rules_ledger` 放在哪里**：不进 `state.json`（那是**每轮**的账本，而规则清单是**跨轮**的框架属性）。放 `framework/rules-ledger.json`，随框架一起版本化。这样它不会成为 `run-state.md:449-451` 那种「新增必填字段让存量账本一夜不合规」的问题。

### 改动 1 · 新增 `tools/check-test-assertion-diff.mjs` + `.test.mjs`（模式 A）

```
用法：
  node tools/check-test-assertion-diff.mjs \
    --repo <被审仓库> [--state <state.json>] [--ref <commit>] [--json]
退出码：0 无强判据命中 / 1 有 FAIL / 2 配置错误（repo 不是 git、ref 取不到）

**没有 `--ignore` / `--skip-file`。** 「哪些文件不判」的唯一来源是 `state.fix_baseline.dirty_paths`
（主 Agent 在进入 wave4 前抓的，`run-state.md:439-447`），且被排除的每个文件都单独 WARN。
命令行开关会成为默认路径——`check-fix-artifacts-envelope.mjs:60-63` 对同一件事的结论是「降级纪律：无」。

规则（**级别由「有没有申报」决定，不由「有没有改」决定**）：
  assertion_target_dropped        FAIL  old 有某个 subject_key、new 整份文件里一条都没有
  assertion_reversed_unreported   FAIL  同 subject_key 的 predicate_class 变档或 expected 变值，且未申报
  assertion_reversed_reported     WARN + 强制 HUMAN_DECISION_REQUIRED  同上但已申报
  test_disabled                   FAIL   新增 @Disabled(无参) / @Ignore / it.skip( / pytest.mark.skip / xfail
                                         （Assumptions.assumeTrue 不算——`GROUND-TRUTH-assertion-diff.md:109-110`：那是 1 个合法 skip）
  assertion_unparsable            WARN   抽不出 subject_key → **该文件强判据未生效**
  assertion_baseline_unavailable  WARN   文件在 fix_baseline.dirty_paths 里 / git show 取不到
  test_files_not_found            exit2  仓库里一个测试文件都没识别到（分母为 0 不等于通过）
```

实现要点（每条都对应一个已记录的坑）：
- **分母为 0 必须是 exit 2**，不是通过——照 `check-fix-artifacts-envelope.mjs:44-46` 的 `no_fix_artifacts`（「配置错误，绝不等于通过」）。
- **不接受 `--skip-file` 之类的开关**——照 `check-fix-artifacts-envelope.mjs:60-63` 的「降级纪律：无」。
- **一次 `git diff --name-only`，不逐文件起进程**（`stop-hook.mjs:822-823` 已有 `MAX_PAYLOAD_FILES = 50` / `PAYLOAD_TIMEOUT_MS = 10_000` 的性能前提；本工具对测试文件数加上限 200 并 WARN）。
- **自测用例必须包含定标的 3 处真实形态**（`GROUND-TRUTH-assertion-diff.md:20-24`）：
  - 处 1、2（`assertNull(field("refreshTask"))` → `assertSame(before, ...)`）：**未申报** → `assertion_reversed_unreported` FAIL；**已申报** → WARN。这条用例是这道闸门能否落地的唯一证明。
  - 处 3（方法改名 + 原断言保留 + 新增 3 条）：**一条规则都不许命中**（按 subject_key 匹配时 `getItems().get(0).getPrice()` 两侧期望值都是 1）。
  - F2/F3 原样复刻（`assertEquals(1, cfg.getItems().size())` → `assertTrue(cfg.getItems().isEmpty())`，`fix-F2F3F4-contract.md:88-92`/`:111-116`）：必须命中 `assertion_reversed_unreported`。
  - `@Disabled` 注入；`assertNotNull` 弱化；纯格式化重排**不得**误报；`Assumptions.assumeTrue` **不得**误报。

### 改动 2 · 新增 `tools/check-sample-claims.mjs` + `.test.mjs`（模式 B）

```
用法：node tools/check-sample-claims.mjs --artifact <verify 产物> --repo <被审仓库> [--json]
规则：claim_exceeds_samples FAIL / input_variants_inflated FAIL /
      universal_claim_thin_evidence WARN / input_basis_undeclared WARN
```

### 改动 3 · 新增 `tools/check-source-guard-tests.mjs` + `.test.mjs`（模式 C1）

`text_assertion_on_production_source`：FAIL 窄形态、WARN 其余。**必须**有 `test_files_not_found` → exit 2。

### 改动 4 · 改 `tools/check-payload.mjs` + `tools/gen-contract-examples.mjs`（模式 C2 + 模式 D + 四条现成缺口）

**先修范例（`GROUND-TRUTH-example-violates-contract.md`）**：契约正文（`verify.md:185`）要求「对『函数返回值决定用户可见行为』的修复必须 `implementation_and_callsite`，否则须在 `notes` 说明」，而**框架给 agent 照抄的范例**（`gen-contract-examples.mjs:186-196`）用的是 `implementation_only`、`:195` 的 `notes` 一句解释都没有。那一行 `mutation_scope` 在 `tools/` 里是**唯一**一处（`grep -rn "mutation_scope" tools/*.mjs` → 1 命中），即零实现。
`:243` 那个「已经过 check-payload 验证」的章是真的跑过校验器的（`:250-253` 不过就不写，`:273` 写章），**只是校验器不看这件事**——所以它是「按范例写的却违反正文」，`check-all` 全绿也拦不住。

| 位置 | 改动 |
|---|---|
| `tools/gen-contract-examples.mjs:192` | `'implementation_only'` → `'implementation_and_callsite'`（范例应当示范强形态）；若刻意保留弱形态，则 `:195` 的 `notes` 必须写出「本范例不涉及函数返回值决定用户可见行为的情形」 |
| `:1513-1520` 那一段 | 把「只 WARN」扩成完整校验：`mutation_check` ∈ `{performed, skipped}`（否则 `invalid_mutation_check` FAIL）；`performed` 时 `mutation_scope` 必填且 ∈ `{implementation_only, implementation_and_callsite}`（否则 `missing_mutation_scope` FAIL）；`skipped` 时 `notes` 必须以 `harness_unsupported` 或 `unsafe_revert` 开头（否则 `invalid_mutation_skip_reason` FAIL）。依据：`wave5-verify.md:136-140` 的「其余一律视为 `CONTRACT_VIOLATION`」，今天零执行 |
| `:1513-1520` 新增一条 | `mutation_scope === 'implementation_only'` 且 `notes` 未说明理由 → `mutation_scope_weak_unexplained`。**级别取 WARN 起步**（`GROUND-TRUTH-example-violates-contract.md:164` 的建议），理由是「怎样才算『函数返回值决定用户可见行为』」需要语义判断，判 FAIL 会误拦。**若首轮实测零误报再升 ERROR**——这条升不升级必须由数据决定，不能由设计者决定 |
| `:1464-1508` verify 分支 | 新增 `residual_risk_disposition` 覆盖校验：`flag` 去重后数量必须等于修复产物 `residual_risks` 的标记数。依据：`wave5-verify.md:207`「缺任一条目的后果：……主Agent判定为 `CONTRACT_VIOLATION`」，今天零执行 |
| `:986-988` 必查清单 | 现在只判 `Array.isArray && length > 0`，且整段只在 `noEv.length > 0` 时执行（`:983-984`）——即「全是有发现的审计产物」连这一项都不查。**本方案不改它的内容要求**（`GROUND-TRUTH-checklist-not-gated.md:66-79` 论证了「冻结数量」会禁止合法的模式增删），只改两件：① 去掉「仅 `NO_EVIDENCE_FOUND` 时执行」的包裹，让 `searched_scope` 在有发现时也校验存在性；② 交给改动 0 的 `rules_ledger` 把「必须覆盖 8 条」标成 `PENDING` 或 `DISCRETIONARY`，让它成为一个**显式决策**而不是沉默降级 |
| `:699` `ENUM_CHECKS` | 加 `residual_risk_disposition[].flag`、`evidence.mutation_check`、`evidence.mutation_scope`、`input_space_basis`。**理由**：`check-enum-consistency.mjs:47-58` 是从 `ENUM_CHECKS` 里抽枚举去和契约/示例比对的，不加进去 = 这条漂移永远不会被发现 |

**改动 4 的验收标准（机械）**：改完后 `node tools/gen-contract-examples.mjs` 重新生成的 `framework/components/output-contract/examples/verify.md` 必须**通过**新增的 `mutation_scope` 规则；同时 `node tools/check-contract-examples.mjs` 仍 exit 0。这两条一起才证明「范例不再反向示范」。


### 改动 5 · 改 `framework/templates/wave4-fix.md`

| 节 | 改动 |
|---|---|
| §1「不做 3」（`:200`） | 末尾追加一句：「本条有机械检测点：`tools/check-test-assertion-diff.mjs` 从被审仓库 git 直接比对断言四元组。`TEST_CONFLICT` 是唯一消音途径，且它会让该缺陷进入 `HUMAN_DECISION_REQUIRED`、**不记为已修复**」 |
| §3.2 标记表（`:239-247`） | 新增一行 `TEST_ASSERTION_CHANGED`：修复者主动改了测试断言但**不认为**与正确修复冲突（例如补参数化用例、改文案字符串）。处置：验收波必须逐条复核改动的断言是否弱化；`satisfied:false` 时不得无条件 PASS |
| §0.7（`:138-158`） | 在既有 `verify-postfix-snapshot.mjs` 自检块后追加一条命令：`node tools/check-test-assertion-diff.mjs --repo <TARGET_REPO> --state <state.json>`，并写明「退出码非 0 = 本轮有测试断言被反向或弱化，必须按 `TEST_CONFLICT` 处置」 |
| §7 自检表（`:342`） | 「未修改测试以通过」的「失败动作」列补上「或跑改动 1 的工具，非 0 即补齐」 |

### 改动 6 · 改 `framework/templates/wave5-verify.md`

| 节 | 改动 |
|---|---|
| §3 测试有效性排除（`:122-127`） | 第 1、2、3 条后加「（机械判据：`tools/check-test-assertion-diff.mjs` 的 `assertion_target_dropped` / `assertion_reversed_*` / `test_disabled`，不由验收 Agent 目测。**未申报的反转 = FAIL；已申报 = WARN + 人工裁决**）」 |
| §3 变异检验（`:129-148`） | 补一句「`mutation_check` / `mutation_scope` / `skipped` 理由由 `check-payload.mjs` 机械校验，写错枚举即 `CONTRACT_VIOLATION`」 |
| §5.1 两个结构化字段（`:185-222`） | 新增第三个：`input_space_basis` + `input_variants_covered`，写明「声明 `exhaustive`/`boundary` 而样本数 < 2 = `claim_exceeds_samples`，判 `CONTRACT_VIOLATION`」 |
| §9 自检表（`:283-300`） | 加一行「断言未被反向（`check-test-assertion-diff` 退出码 0）」，并在命令块里加 `check-sample-claims.mjs` |

### 改动 7 · 改 `framework/components/output-contract.md`（母文件）→ 重跑 `node tools/gen-contract-slices.mjs`

**必须改母文件**：`output-contract/fix.md:1-4` 与 `verify.md` 同款头部写明「自动生成，请勿手改。母文件：framework/components/output-contract.md，重跑：`node tools/gen-contract-slices.mjs`」。

| 位置 | 改动 |
|---|---|
| §2.4 修复角色（`output-contract.md:536`） | `residual_risks` 的说明里补 `TEST_ASSERTION_CHANGED` 进标记闭集（现在 `wave4-fix.md:239-247` 是唯一的闭集定义处，母契约 §2.4 只是散文提「固定标记前缀」，两处必须一致） |
| §2.5 验收角色（`output-contract.md:636`，切片 `verify.md:141-190`） | payload schema 新增 `input_space_basis`、`input_variants_covered` 两字段 + 必填表；`residual_risk_disposition[].flag` 枚举（切片 `verify.md:155`）加 `TEST_ASSERTION_CHANGED` |

### 改动 8 · 改 `framework/artifacts/run-state.md`

§2.7（`:403-451`）：补一段「`fix_baseline.head` 现在是 `check-test-assertion-diff` 的基线 ref。缺失时降级为 `HEAD` 并 WARN；若此时仓库里有测试文件在 `dirty_paths` 里，则该文件的断言判定不可用（`assertion_baseline_unavailable`）」。
**不新增任何 state 字段**——理由照 `:449-451`「不能让所有存量账本一夜之间变不合规」，且 `:203-206` 对 `target_repo` 已示范过「用已有字段承载新判据」的做法。

### 改动 9 · 改 `tools/stop-hook.mjs`（挂载，见 Q3）

在 `§3.7.6`（`:984-1571`）之后新增三段 `§3.7.7 / §3.7.8 / §3.7.9`，复用同一段外层的 `files` / `inferred.dir` / `repoDir` / `baselinePaths` / `claimedRaw`，**不重复 shell git**（`:1128` 已经拿过 `git status`、`:1329` 已经拿过 `git rev-parse HEAD`；本段新增的唯一一次 git 调用是 `git diff --name-only <ref>`，一次进程启动）。

三段的分工：
| 段 | 内容 | 依赖 |
|---|---|---|
| §3.7.7 | 调 `check-test-assertion-diff.mjs`（模式 A），FAIL→problems 推入 | `repoDir` + `baselinePaths`（`fix_baseline`）+ `claimedRaw` 所在产物的 `residual_risks` |
| §3.7.8 | 调 `check-sample-claims.mjs`（模式 B 的启发式两条），只 WARN | 各 verify 产物的信封 |
| §3.7.9 | 调 `check-source-guard-tests.mjs`（模式 C1），窄形态 FAIL、宽松形态 WARN | `repoDir` 里的测试文件 |

**降级纪律（三段共用，措辞照 `:1094-1096`）**：拿不到 `repoDir` / `ref` / 测试文件 → 跳过判据，但**必须**在 stderr 里写「断言变更 / 样本声明 / 文本断言这三项本回合没有答案——不是通过，是没查」。`check-fix-artifacts-envelope.mjs` 的「降级纪律：无」风格（`:60-63`）适用于工具本身，hook 侧仍按既有惯例区分环境问题与账本问题。

**不接 `--report-only`**：`stop-hook` 只接最终形态。模式 D 走 `check-all`（见 Q3）。

### 改动 10 · 改 `tools/check-all.mjs`

在 `CHECKS` 数组（`:18` 起，尾部追加点在 `verify-postfix-snapshot.test.mjs` 那条之后）注册三个新自测：

```js
{ name: '规则→校验器对账（元规则 D）', script: 'check-rule-validator-coverage.test.mjs',
  desc: '用例：规则句无出口 FAIL / DISCRETIONARY 无理由 FAIL / 点名的规则名在 tools 里搜不到 FAIL / 全量 PENDING FAIL / --report-only 只统计不判' },
{ name: '测试断言反向/弱化检测（机械 A）', script: 'check-test-assertion-diff.test.mjs',
  desc: '用例：定标处1/2 未申报 FAIL、已申报 WARN / 定标处3 改名+包裹零命中 / F2F3 原样命中 / @Disabled / assumeTrue 不误报 / 纯重排不误报 / 无测试文件 exit 2' },
{ name: '样本数与声明自相矛盾检测（机械 B）', script: 'check-sample-claims.test.mjs', ... },
{ name: '源码守卫文本断言检测（机械 C1）', script: 'check-source-guard-tests.test.mjs', ... },
```

**其中 `check-rule-validator-coverage.test.mjs` 必须有这三条反向用例**（照 `check-contract-examples.test.mjs:69-87` 的形态：破坏一个真实文件，看它是否报出，而不是构造一个玩具输入）：
1. 在 `framework/templates/wave5-verify.md` 里插入一条「必须 XXX」且无任何出口 → 必须报 `rule_without_validator` 并**点名行号**；
2. 把某条 `DISCRETIONARY` 的理由删掉 → 必须报 `discretionary_without_reason`；
3. 构造一个 `rules_ledger.json`，其 `GATED` 条目点名一个不存在的规则名 → 必须报 `named_rule_not_in_tools`（或 `rules_ledger_stale`）。

### 改动 11 · 改 `CAPABILITIES.md`

§二「现在能拦住的」表（`:41-54`）加三行；§三「拦不住的」（`:58-95`）把「注释承诺 vs 代码实际」明确列为**纯人工项**，并写明「B 的覆盖率实质仍然拦不住、D 的规则句抽取仍是正则」。
理由：这份文档的自我定位是「给你判断该不该用它、能信它到什么程度」（`:6-7`）。加了闸门却不同步它，就是制造 `README.md:375` 那类「声称有、实际没有」的缺口——原文：「纯提示词方案下，加载靠模型自律」。**这正是模式 C 本身。**

### 改动 12 · 新增 `framework/rules-ledger.json`（元规则 D 的存量账）

```json
{
  "schema": "rules-ledger-v1",
  "entries": [
    { "anchor": "templates/wave4-fix.md:200", "resolution": "GATED",
      "rule_name": "assertion_reversed_unreported" },
    { "anchor": "components/output-contract/verify.md:185", "resolution": "GATED",
      "rule_name": "missing_mutation_scope" },
    { "anchor": "templates/wave2-audit.md:629", "resolution": "DISCRETIONARY",
      "reason": "模式 5 是「注释承诺 vs 代码实际」，无形式判定手段；见 PLAN-close-the-gap.md Q4-2" },
    { "anchor": "templates/wave5-verify.md:129", "resolution": "PENDING",
      "reason": "变异检验的深度无法机械观测；已由 mutation_check/mutation_scope 字段做弱校验，深度待人工" }
  ]
}
```

三条纪律（照 `stop-hook.mjs:472-480` 对 `legacy_artifacts` 的教训）：
- **`PENDING` 必须有理由**，且 `PENDING` 占比 ≥ 全部条目数时 `rules_ledger_all_pending` **FAIL**（全量豁免等于关掉检查）；
- **`GATED` 必须点名一个在 `tools/*.mjs` 里真实存在的规则名**，否则 `rules_ledger_stale`；
- **`DISCRETIONARY` 必须写理由**，且首版只允许它覆盖「语义判定」类（注释是否说谎、样本是否选得好），不允许覆盖「事实比对」类（A、C2 那些能从 git/信封取到数据的）。
  第三条是防止 `DISCRETIONARY` 变成万能挡箭牌——**能从数据判定的事，不许标成自觉项。**

---

# Q3 挂到哪道闸门、FAIL 还是 WARN

`stop-hook.mjs` 的现有层次（本轮已读）：§2 in_flight → §3 相位交付物（`:159-204`）→ §3.5 多实例（`:206-233`）→ §3.6 harness 派发数 → §3.6b files_touched↔write/edit（`:338-412`）→ §3.7 产物可观测性（`:414` 起，仅在 `phase ∈ {wave4,wave5}` 且 `path_mode == 'FIX'` 时进入，见 `:481-485`），其内 §3.7.2 分母（`:566`）、§3.7.4 信封（`:713`）、§3.7.5 逐份 check-payload（`:783-982`）、§3.7.6 files_touched↔git（`:984`）。

| 检查 | 挂载点 | 级别 | 理由 |
|---|---|---|---|
| **A** 断言反向/弱化 | **新 §3.7.7**，紧跟 §3.7.5 之后、§3.7.6 之前 | **FAIL（exit 2）**，但**只对「未申报」形态**；已申报 → WARN + 强制 `HUMAN_DECISION_REQUIRED` | ① 事实来自 git，非自述，符合 §3.6/§3.6b「必须换观测面」的既有取向（`:338-349`）；② **判 FAIL 的对象是「反转了却没留理由」，不是「反转了」**——定标证明合法反转真实存在（2/3），把它当 FAIL 会在第一个样本上被关掉；而「未申报」这个判据不依赖任何人的手感，且申报的补法只有一行；③ 若连「未申报」都只 WARN，就复现 `stop-hook.mjs:450-454` 记录的同一失效：「不写 report.dir_path 是最省力的绕过，只消省略一个字段，整道闸门就变成一条 WARN」；④ `:355-358` 明写「接上了但没接在门上……比没有更糟」 |
| **A** 的降级档 | 同上 | **WARN** | 只有四种：`repo_not_git`、`ref` 取不到、测试文件全在 `dirty_paths` 里、`assertion_unparsable`。四种都属「拿不到可信输入」，与 `:1138-1140` / `:1113-1122` 同一纪律。但 WARN 文案必须**点明「断言变更这一项本回合没有答案」**——照 `:1094-1096` 的写法 |
| **B** 的**矛盾**两条（`claim_exceeds_samples` / `input_variants_inflated`） | **§3.7.5 内部**（`check-payload.mjs` 或新工具被 §3.7.5 调用） | **FAIL** | 它是等式比较，不是判断：声明「穷举」+ 证据 1 样本，两句话不能同真。判据不依赖任何人的手感 |
| **B** 的启发式两条（`universal_claim_thin_evidence` / `input_basis_undeclared`） | 新 §3.7.8 | **WARN** | 全称量词识别是文本启发式，误报会落在**合法的**「所有商品都必须有 price」这类注释上。按 `:1558-1562` 的理由（「无条件升 FAIL 会让每个回合都红，然后被一条 WARN 关掉」），这一档只能 WARN |
| **C1** 窄形态 `text_assertion_on_production_source` | 新 §3.7.9 | **FAIL** | 三条条件同时成立时该测试**不可能失败于行为变更**，与 `wave5-verify.md:117`「瞄准性」正面冲突，且判据纯结构 |
| **C1** 宽松形态（读测试夹具 / 有多条断言） | 同 §3.7.9 | **WARN** | 注释/文档生成类测试合法地读生产源码 |
| **C2** 变异申报字段 | **§3.7.5 内部**（`check-payload.mjs`） | **FAIL** | `wave5-verify.md:136-140` 已经写了「一律视为 `CONTRACT_VIOLATION`」，只是没执行。这不是新增严格度，是实现既有条款 |
| **C2 的深度档**（`mutation_scope === 'implementation_only'` 且 `notes` 无解释） | 同 §3.7.5 | **WARN 起步**，实测零误报后才考虑升 ERROR | 「怎样才算『函数返回值决定用户可见行为』」需要语义判断。`GROUND-TRUTH-example-violates-contract.md:164` 也建议 WARN 起步。**升级必须由数据决定**，否则会误拦一次合法修复 |
| **D** 元规则（规则→校验器对账） | **不进 `stop-hook`**，挂在 `check-all.mjs` | 首版 `--report-only` 只输出统计（WARN），ledger 建好后 FAIL | 这不是相位门，是**框架自身的 CI**。±3 行的正则出口检测必然有假阳/假阴（D.3），放进每轮闭合门会让每次交付都被它卡。放在 `check-all` 里，改框架的人跑，改被审仓库的人不受影响 |
| **C 的核心**（注释是否说谎） | **不挂** | — | 见 Q4 |

**为什么不把 D 挂进 `stop-hook`**：`stop-hook` 的每一道闸门都针对**某一轮的交付**；而 D 针对**框架文本本身**。把它塞进 `stop-hook` 会让「修别人代码」的回合因为「框架文档里有一条规则没接校验器」而无法闭合——那是**错误的对象**（`stop-hook.mjs:361-363` 对 §3.6b 的同一条纪律：「只支持 dsh 的判据不该在别处把流程卡死」）。

**为什么不挂在验收派发前**：`wave5-verify.md:59-61` 的派发前判据只看 `state.json` 的 `fix_contracts`。而 A 需要的数据（fix 产物信封 + 仓库 diff）在波次五闭合时才齐；挂在派发前等于要求验收 Agent 自己跑，而它是**只读角色**（`wave5-verify.md:90`）且它的输入刻意不含这些（`:15`）。**唯一正确的位置是相位闭合门，由主 Agent / hook 侧运行。**

**为什么不能只挂 `check-all`（CI）**：`check-all`（`tools/check-all.mjs` 尾部循环）只跑**框架自己的自测**，不接触被审仓库。挂在那里等于「在没用过的路径上验证过」——正是 `SUMMARY.md:106` 那种「26 个校验套件全绿而代码有 5 处缺陷」的形态。

---

# Q4 我认为做不到的部分（诚实清单）

1. **模式 B 的实质：输入空间的覆盖度。**
   框架不执行被审仓库的任何代码（无 maven/gradle/pytest 调用点，`verify-postfix-snapshot.mjs:30` 明说不做）。要判断「192 个截断样本里堵住几个」，必须有人真的跑那 192 个样本。
   **替代**：`claim_exceeds_samples`（声明与证据的矛盾）+ 独立红队 agent。review-7 正是靠后者发现的（`SUMMARY.md:3-5`、`finding-F1.md:69-88`）。
   **不要**做「静态估算覆盖率」——那会变成第二个自造样本。

2. **模式 C 的核心：注释承诺是否与代码行为一致。**
   需要的输入是「注释里那句自然语言谓词」与「代码在声称的输入域上的实际行为」的等价性。无形式语法、无规格语言、无符号执行 → 不可判定。
   `check-promises.mjs:15-18` 已自认三类做不到，F1/F7 的注释正落在第一类（散文而非 JSDoc）。
   **替代（且是唯一有效的）**：`wave5-verify.md:129-148` 已强制的变异检验 —— F7 的「`moveIntoPlace` 一次都没执行过」（`finding-F6F7.md:222`）只要做一次实现变异就会暴露。所以 C 的补法不是「检查注释」，而是**让变异检验真的发生**（C2）。以及：把 review-7 这套「5 个独立 agent 红队」写进流程，而不是假装能自动化。

3. **模式 A 的残余（五条：1 条是主动接受的偏严，4 条是漏报面）**
   - **合法反转会被推到「待人工裁决」，即使它真的修对了。** 定标处 1、2 就是这种：修复者按正确语义改了断言，`TEST_CONFLICT` 一申报，该条就**不记为已修复**（`wave4-fix.md:301`、`wave5-verify.md:163`）。这比「误拦」轻，但确实是代价：一个修对了的缺陷要人工点头才算数。**这是本方案主动接受的唯一偏严项**，因为框架对这类变更本就只指定了这一条出口。
   - 断言被搬进同一文件（或跨文件）的 helper 方法后再弱化：同文件 helper 会被算作「断言还在」（保守选择，见 A.2），跨文件 helper 会命中 `assertion_target_dropped` 但**指向的是被删的那个 subject，不是 helper 里的弱化**——人要自己顺着查。
   - 测试文件在本轮之前就是脏的：`fix_baseline` 只存路径不存内容（`run-state.md:506` 自己列了这个假阴性），取不到可信的「改动前」→ 只能 `assertion_baseline_unavailable`。修法是 `run-state.md:521-523` 的路标（内容哈希基线），本轮不做。
   - 非 JS/Java 断言方言（Kotlin `shouldBe`、Go 手写 `if got != want`、JUnit 4 的 `assertThat(x, is(...))`）：只做「能解析的才算」，其余显式 WARN。**定标只覆盖了 Java/JUnit5，其他语言的抽取规则未经真实样本验证——这一点必须在工具文件头写明，不要假装它是通用的。**
   - 新增测试文件里的反向断言：`old` 为空 → 无对照基线 → 抓不到。

4. **A 抓不到「测试在更早的轮次被改」**。`fix_baseline` 是「本轮开始时的状态」，不是「缺陷注入时的状态」。跨轮累积的弱化只看得到最后一层。**承认这一点，不要把它说成能查。**

5. **B/A 都抓不到「选一个好过的样本」这个动作本身**。样本数够、断言也强，只是恰好绕开了真正的攻击面（`finding-F2F3F4.md:282`「测试全部是『我以为的坏输入』」）。这是选择问题，不是可见行为问题。

6. **元规则 D 的「规则句」边界是模糊的。**
   抽取靠「必须/不得/禁止/一律」四个词 + ±3 行出口检测。三类必然漏：
   ① 硬判据写在**表格**里（`wave4-fix.md` 的标记表 `:239-247`、`wave5-verify.md` 的动作对照表 `:158-167`），一整个表可能是十条硬规则，但一行「必须」都没有；
   ② 叙述性的「必须」只是措辞（「必须读懂这一节」）；
   ③ 出口标记 `(a)` 的正则只认 `tools/xxx.mjs`，写「由校验器负责」这种不点名的说法会漏。
   **结论：D 只能保证「没有完全没人管的规则句」，不能保证「每条规则都被正确执行」。** 它的真正价值不是覆盖率，而是**让那个差额变得可见且需要显式决策**（`DISCRETIONARY` 必须写理由）。
   首版只统计、`PENDING` 有预算，就是为了不让它自己在第一个真实样本上崩掉。

7. **所有闸门的共同上限仍然是 `CAPABILITIES.md:60-65` 那句**：「所有闸门验的是『流程合规』，不是『代码正确』」。本方案把 A 从「零检测」变成「有检测」，把 B/C 从「零检测」变成「矛盾检测 + 申报校验」，把 D 从「没人问」变成「必须表态」，**没有**把「流程合规」变成「代码正确」。报告里必须保持这句话，并补上 `DIAGNOSIS:121-126` 的下半句：**「而且闸门验不到的东西，框架不会告诉你它没验。」**

---

## 附：实施顺序（按「先堵最贵的那条」排）

| 序 | 内容 | 为什么这个顺序 |
|---|---|---|
| 0a | **改 `gen-contract-examples.mjs:192` + 加 `mutation_scope` 规则**（改动 4 的第一块） | 这是全方案**最便宜的一处**（改一个字符串 + 一条规则），而且它污染的是**两个方向**：向下 agent 照抄错的范例，向上「契约合规」这个结论不可信（`GROUND-TRUTH-example-violates-contract.md:150-152` 原文：「D 比 A/B/C 更值得先修」）。先做它，后面所有「契约合规」的结论才站得住 |
| 0b | **拿定标当验收标准**（已完成，`GROUND-TRUTH-assertion-diff.md`） | 定标证明直觉设计有 1/3–2/3 假阳性。**改动 1 的自测用例直接照抄那 3 处**：处 1/2 未申报→FAIL、已申报→WARN；处 3 零命中。没有这三条，改动 1 无法证明自己不会把这道闸门逼死 |
| 0c | **改动 0（元规则 D）以 `--report-only` 上线** | 先出统计，不闸门。它上线第一天就会红出 `wave5-verify.md` 的 50 条硬规则里绝大多数无出口。**先测量，再闸门**——这是 A/B/C/D 四条共同的落地前提 |
| 1 | 改动 1（A）+ 改动 5/7/8 的文本/契约 + 改动 9 的 §3.7.7 + 改动 10 | A 是唯一能做成**非自述**判据的，且 review-7 里它出现了两次（`SUMMARY.md:83-88`）。规则已写好（`wave4-fix.md:200`），只差执行 |
| 2 | 改动 4 的其余部分（`residual_risk_disposition` 覆盖 + 枚举登记 + 必查清单去掉 `NO_EVIDENCE_FOUND` 包裹） | 纯补洞，无新算法，且 `wave5-verify.md:207` 的条款已经写好，今天零执行 |
| 3 | 改动 2（B 的矛盾检测） | 需要新增契约字段（改动 7），必须先有 `input_space_basis` 才有东西可比 |
| 4 | 改动 3（C1 源码守卫） | 窄，收益确定，但**恒有假阳性**（`GROUND-TRUTH-assertion-diff.md:102-103` 里的 `javadocStopsClaimingTheFalseInvariant` 是刻意的文本守卫），优先级低于上面几条 |
| 5 | 改动 12（`rules-ledger.json`）+ 改动 0 从 `--report-only` 切到闸门模式 | ledger 建不完就不能闸门；`PENDING` 预算要按真实存量标定 |
| 6 | 改动 11（同步 `CAPABILITIES.md`） | 最后做，但**必须做**——它本身就是模式 C 的防治对象 |

**定标同时纠正了本方案起草时的两个错误认知**（记录下来，因为它正是模式 C 的实例）：
1. 我最初以为 F1 的 `not a mapping` 分支零覆盖——错，`ShopConfigCorruptFileTest.TRUNCATED_AT_ITEMS` 覆盖了它（`GROUND-TRUTH-assertion-diff.md:100`）。
2. 我最初以为 `items: []` 是纯误杀——定标指出 `items: {}` 被刻意判合法且仓库里有 5 处测试依赖它，任何截断检测都不能把它一起拦掉（`GROUND-TRUTH-assertion-diff.md:101`）。

这两条都属于「我在没读测试文件之前就下了结论」。**它们是本方案自己被模式 B/C 命中的证据。**

**还有一条更贵的过程教训**：本方案的第一稿把 A 设计成「极性翻转即 FAIL」，并按「方法内匹配」抽取断言四元组。**那份设计在定标出现之前就已经写完**，如果直接实施，它会在第一个真实样本上产生 2/3 的假阳性，然后被关掉。定标是**外部提供的事实**，不是我自己找的——这与 `SUMMARY.md:113` 那句「闸门能保证『没有静默跳过验证』，不能保证『验证本身是对的』」是同一件事的又一次实例：**设计者对设计的验证，不是独立验证。**

每一步都必须同时落三处（模板 / 契约 / 校验器），否则就是 `output-contract/audit.md:229` 记的那句：「契约的每一条硬判据都必须有对应的测试用例，否则它只是一句愿望。这个框架里『三层闭环』（模板 / 契约 / 校验器）的第三条腿，正是最容易缺的那条。」
