# 框架质量审计 · 第二轮汇总

**日期**：2026-11-20
**方法**：5 个并行 Agent（规划 / 红队 / 真实产物复跑 / 契约对账 / 批判 / 分诊）+ 主线程独立探针
**口径**：本文件只写**主线程亲手跑过探针**或**Agent 报告且主线程复核过**的条目。未复核的标 `[未复核]`。

> **本轮的 4 条 P0/P2 已修**（`verify-artifacts` 门 0 绕过、非 `.md` 静默跳过、全 SKIP 即绿、`--baseline` 静默跳过、`/find/i` 误杀出口），
> 每条都带回归测试。修了什么、怎么验证的见各节末尾的「已修」标记。

---

## 一、先说结论

**框架的核心问题不是「校验器太少」，而是「校验器接错了地方」。**

上一轮我把它诊断成「规则写在提示词里、检测器在 tools/ 里、中间没有对账」，然后去补校验器、提高出口率。
这一轮的数据推翻了这个方向：

| 我上一轮的判断 | 这一轮的证据 | 判定 |
|---|---|---|
| 出口率 20.3% 是可信的进步指标 | 真实可执行出口只有 **11.1%**（124/1113）；另外 102 条（45%）的「出口」只是另一份 `.md` 的文件名 | **指标虚高** |
| 继续补校验器是最值得做的事 | 仓库自己的实验：`RULE-EFFECTIVENESS.md:10` 唯一做过对照的规则让 recall **下降 5 点**；`FINAL-REPORT.md:10` 19 条规则只有 1 类被证实有效 | **方向相反** |
| `.json` 跳过是重要缺陷 | 是真缺陷，但**修法不是支持 `.json`**——契约只允许 `.md`，正确修法是**报出非契约格式文件** | **定位错误** |

真正的病是下面三条，按危害排序。

---

## 二、P0 · 门 0 会被一条正则绕过——编造的 quote 判「逐字原文」（**全轮最严重**）

门 0 是这套框架的立足点：*每条 finding 必须逐字回显源文件的 `file:line` 原文，否则不采纳*。

`verify-artifacts.mjs:203-208` 的 JSON 抽取器**无条件**对整段文本做尾逗号容错：

```js
const cleaned = raw
  .split('\n')
  .filter((ln) => !/^\s*\/\//.test(ln))
  .join('\n')
  .replace(/,(\s*[}\]])/g, '$1');   // ← 正则不尊重字符串边界
```

这个 `.replace` **作用于字符串字面量内部**。于是 quote 里的 `,}` 会被改写成 `}`。

### 主线程实测

源文件 `.probe-mine/repo/src/comma.js` 全文一行：

```
if (a) { return {x}; }
```

产物里的 evidence：

```json
{ "file": "src/comma.js", "line": 1, "quote": "if (a) { return {x,}; }" }
```

**这个 quote 在源文件里逐字不存在**（`grep -c '{x,}' → 0`）。结果：

```
$ node tools/verify-artifacts.mjs --repo .probe-mine/repo --artifacts .probe-mine/art
✓ PASS  [G0] 门 0 回显: 1/1 通过（0 条 quote 与源文件不符，0 条缺 line，0 条文件不可读）
```

**判「1/1 通过」。** 容错正则把产物里的 quote 也改成 `{x}`，再拿它去和源文件比对——两个都改过，所以匹配。

### 这为什么是全轮最严重

1. **它直接摧毁框架的第一性原理。** 门 0 存在的唯一理由是「不接受未逐字核验的引用」。这条路径让「引用」和「核验」用同一套改写，于是**永远匹配**。
2. **反方向同样会坏**：如果源文件原文真是 `if (a) { return {x,}; }`，一份**诚实**的逐字引用会被同一个正则改写后比对失败 → 判伪造。**诚实产物被打回，编造产物被放行。**
3. **同一个 bug 在别的文件里已经修过。** `check-payload.mjs:493-520` 的注释逐字记录了这个教训：

   > 尾随逗号的「容错」正则不尊重字符串边界，会**静默改写 quote 的内容**……正确做法：先按原样解析。原样能解析就**绝不改写**。只有原样解析失败时才启用容错，且容错生效必须留下 WARN。

   `verify-artifacts.mjs` 的这条路径**没有跟着改**。这是「修了一处没修同族的另一处」，正是框架自己反复记录的失效模式。

### 顺带发现：`check-payload` 也抓不到编造

同一份产物喂 `check-payload.mjs --role audit`，4 条违规全是格式问题（缺 `agent_id`、`self_checks` 状态值大小写、缺 note），**没有任何一条检查 quote 是否真实存在**——那不是它的职责。所以在这条链路上，**「quote 真实性」只有 `verify-artifacts` 一个守卫，而它被这条正则绕过了。**

### ✅ 已修（`verify-artifacts.mjs:196-`）

改法与 `check-payload.mjs:493-520` 对齐：

1. **先按原样 `JSON.parse`**，成功就绝不改写；
2. 原样失败才启用容错，并打 `tolerated` 标记；
3. 带标记的信封在门 0 里**不判 PASS 也不判 FAIL**，判 `GQ_UNVERIFIABLE` 并计入 WARN——
   既不假绿，也不惩罚一份本来没问题的产物。

**验证**（新增 2 条回归测试，`case 53`）：

```
编造 quote + 尾逗号 → ! WARN [G0] 门 0 无法核验 1 条 evidence … **这几条没有被真正验证过**
合法 JSON + 真实 quote → ✓ PASS [G0] 门 0 回显: 1/1 通过
```

两个方向都钉住了：编造不再被判真实，诚实不再被判伪造。

---

## 三、P1 · 最重要的一条：真实审计产物对框架的核心检查器不可用

仓库里唯一一次真实 dsh 审计的产物在 `.run-hv/`：**65 个 `.json` + 5 个 `.md`**。

```
$ node tools/check-disposition-coverage.mjs --artifacts .run-hv --ledger .run-hv/UNFIXED.md
[配置错误] artifacts_contain_subdirectories
  .run-hv 下有子目录（critiques、deep、findings）——子目录里的产物不会进分母
EXIT=2

$ node tools/check-disposition-coverage.mjs --artifacts .run-hv/findings --ledger .run-hv/UNFIXED.md
[配置错误] artifacts_missing
  产物目录里没有任何 .md: .run-hv/findings
EXIT=2

$ node tools/check-fix-instances.mjs --state .run-hv/state.json --report .run-hv/AUDIT-REPORT.md
EXIT=2

$ node tools/verify-artifacts.mjs --repo . --artifacts .run-hv
扫描产物: 5 个文件，解析出 0 个信封      ← 实际有 70 个文件
EXIT=1
```

**三个核心校验器，对真实审计产物：两个 exit 2（跑不了），一个把 70 个文件看成 5 个。**

而 `check-disposition-coverage` 与 `check-fix-instances` 恰恰是唯一能拦住框架史上最严重事故的那两个检查器——`FIX-R1-R18-SUMMARY.md:10` 记录的「38 条发现只修 6 条、2 条 HIGH 仍在代码里、框架全程没有任何工具报错」。

**它们没被接在任何门上。** `tools/gate.mjs` 四道门的 `checks` 列表里：

```
close 门 → check-state, check-deliverables
grep -c "disposition" tools/gate.mjs    → 0
grep -c "fix-instances" tools/gate.mjs  → 0
```

`check-all.mjs` 注册的也是它们的 `.test.mjs` 自测，不是本体。

**结论**：这套框架的「全部通过」从未覆盖过一次真实审计。再补 10 个校验器不改变这一点。

---

## 四、P2 · 覆盖缺口被报告成绿灯（这一类共 3 例，全部实测）

### P2-a `verify-artifacts.mjs:1001` 只扫 `.md`，`.json` 产物从统计里消失

```js
else if (e.name.endsWith('.md')) {   // ← .json 静默丢弃，不进 scanned 计数
```

混合目录探针（一个永不检查的 `.json` + 一个合规 `.md`）：

```
扫描产物: 1 个文件        ← 实际 2 个
合计: 0 FAIL / 0 WARN / 1 PASS
```

**输出里连一句「有 N 个文件被忽略」都没有。** 这让「格式违规」与「目录干净」在报告上完全一致。

**✅ 已修**：`walk()` 现在收集非 `.md` 产物，并在报告里出一条 WARN：
```
! WARN [G0] 有 1 个非 .md 文件未被检查（bad.json）——契约要求产物是带 JSON 信封的 .md。
       **这些文件一条规则都没有被核对过**
```
判 WARN 不判 FAIL：这些文件可能确实不是产物，但**它们被跳过了这件事必须可见**。
回归测试 `case 55`。

### P2-b `verify-artifacts.mjs:1092` 全 SKIP 也返回 exit 0（**这是三个里最严重的**）

`envelopes.length === 0` 的守卫只挡住「一份产物都没有」。一个**格式完全合法、但所有检查都无从下手**的信封能穿过它：

```
$ cat .probe/round1-02-sweep-a.md     # 合法 envelope，PERMANENT_FAILURE，无 evidence
$ node tools/verify-artifacts.mjs --repo . --artifacts .probe
- SKIP [G2] 没有 status=SUCCESS 的信封，跳过
- SKIP [G8] 没有可对账的 line_count，跳过
- SKIP [G5] 没有可校验的自述数字，跳过
- SKIP [G4] 找不到 state.json，跳过账本对账
合计: 0 FAIL / 0 WARN / 0 PASS / 6 SKIP
真 EXIT=0
```

**6 项检查 0 项被真正执行、0 项通过、6 项跳过，退出码 0。**

对比：一个真的失败的产物（`SUCCESS` + 空 `files_read`）→ `2 FAIL` → **真 EXIT=1**。
所以退出码逻辑本身没错，**错的只有「全跳过」这一个边界**：它把「无从验证」和「验证通过」混成了同一个信号。

这条比 `.json` 跳过更严重，因为 `.json` 至少是格式错误（有别的检查器会报），而这个是**格式全对、语义全空**——正是「我做了但没找到」与「我什么也没做」不可区分的那类，而契约 `output-contract.md:382` 专门写过这句教训。

**✅ 已修**：新增退出码 **4**（专指「验证仪什么都没跑」，与 1「产物违规」区分开）：
```
$ node tools/verify-artifacts.mjs --repo . --artifacts .
[什么都没验证] 0 项检查通过、6 项跳过——这份报告的「无 FAIL」不代表产物合规，
  只代表没有检查被执行过。退出码 4 专指这种状态。
EXIT=4
```
回归测试 `case 54`。

### P2-c `check-wrapper-integrity.mjs:126` 传错 `--baseline` 路径时静默跳过整段检查

```js
if (baselinePath && existsSync(baselinePath)) {   // ← 路径不存在 → 整段跳过
```

同一份基线、同一个文件，只因 cwd 不同：

```
从仓库根（路径错一级）: 合计: 0 项问题 / 7 个文件          EXIT=0
从 tools/（路径正确）  : 合计: 0 项问题 / 5 项已知未闭合    EXIT=0
```

那 5 项是 `CHECKOUT-INCIDENT.md` 记录的永久内容丢失，工具注释明写「**不能因此不报**——它必须每次都被看见」。传错路径时它一次都不被看见。

**✅ 已修**：给了 `--baseline` 但文件不存在 → `exit 2`（配置错误），不再当作「调用方不想比」。
回归测试 `case 6` / `case 7`（后者确保修了这条不误伤正常比对）。

**这一类缺陷的共同形态**：*检查器在某个条件下跳过了工作，而报告的形态与「检查通过」不可区分。*

---

## 四、P2 · wrapper（派发原话）与校验器直接对撞

`framework/wrappers/*.md` 是**唯一实际派发给子 Agent 的原话**。契约审计对账了 120 条可机械判定的要求：

| 类 | 条数 | 含义 |
|---|---|---|
| A 一致 | 64（53%） | 校验器确实做到了 |
| B 校验器更严 | 9 | **照契约写会被打回** |
| C 契约空文 | 40 | 契约要求，没工具查 |
| D 语义不同 | 6+1 | 阈值/口径不一致 |

### 实测 B 类两条（主线程亲自复现）

**B1 · `wrappers/fix-worker.md:76`**

> `payload` **只包含四个字段**：`files_touched`、`verification_commands`、`affected_issues`、`residual_risks`

按这句话原样写产物，`check-payload.mjs --role fix`：

```
✗ [missing_disposition] payload.disposition
  缺少 disposition。fix 产物必须对每条发现表态……
```

而 wrapper 同一节还写着「写完立刻自检……退出码非 0 不得返回」。
**子 Agent 照派发原话写，100% 打回，且它无法自救**——因为修法提示要求的字段正是 wrapper 说「不该有」的。

**B2 · `wrappers/audit-specialist.md:80`**

> 即使一条都没找到，也要写 `"findings": []`，**不能省略这个键**。空数组是一个结论

`output-contract.md:384` 说的是：**空数组一律视为 `CONTRACT_VIOLATION`**。

同一份 wrapper 内部就自相矛盾（上句说合法、下句指向说非法的契约），实测 `findings: []` 被判 `[empty_findings]`。

**这两条是「校验器比契约严」的实例，而来源是 wrapper 落后于契约。** 危害集中在：使用者承担全部后果，且框架承诺的「自检通过再返回」在这个场景下永远不可能达成。

---

## 五、P3 · 出口率指标本身不可信（这推翻了我上一轮的工作方向）

### 分子虚高

| 判据 | 出口率 |
|---|---|
| 现行（含「点名另一个 `.md`」） | 22.3%（248/1113）← 修了下述 bug 之后 |
| 只认 `script:` + `rule:`（真有可执行检查器） | **11.1%**（124/1113） |

**102 条（占「有出口」的 45%）的唯一「出口」是另一份 `.md` 的文件名。**

抽样核对，这 102 条**确实有真的**（如 `planner.md:133`「`score` 必须等于 `score_breakdown` 七项之和」→ 由 `check-payload` 的 `score_mismatch` 执行），**也确实有纯装饰的**（如 `README.md:182` 只是正文提到 `protocol.md`）。

问题在于判据**无法区分这两者**。工具文件头自己写过这个教训：
「宽松判据给出 512 个『出口』，严格判据是 104 个。**那个差值是假的**。」
——现在从 `snake_case` 换成了 `.md` 文件名，**同一个病换了张皮又回来了**。

### ✅ 已修：`/find/i` 把 `finding_id` 当成命令示例，吃掉 46 条真出口

`check-rule-ledger.mjs:206` 原判据：

```js
if (/grep|xargs|find|cat |del |rm /i.test(window)) continue;  // 命令示例
```

`find` **没有词边界**，会命中 `finding_id` / `findings`——而这两个词几乎出现在每一条
finding 相关规则附近，于是它们所指的 `.md` 出口被系统性否决。

主线程量化：窗口里含 `.md` 文件名、被旧判据否决的有 **51 条**；换成只在真命令上下文
（`grep ` / `xargs ` / `find ` 后跟参数）才否决的判据后只剩 **5 条**。
**46 条真出口被一个正则吃掉了。**

修后出口率 20.3% → **22.3%**。回归测试 `case 15` 钉住两个方向：
`finding_id` 附近算出口，真的 `xargs grep foo.md` 仍不算出口。

### 分母的指控不成立（我核实过，Agent 说错了）

批判者称分母里 30% 是标题/表格/frontmatter，会拉低指标。实测：

| 行类型 | 总数 | 出口率 |
|---|---|---|
| 散文句 | 770 | 19.4% |
| 表格行 | 295 | 25.4% |
| 章节标题 | 39 | 5.1% |
| frontmatter | 9 | 0% |

散文句 19.4% vs 全部 20.3%——**几乎一致，分母没有扭曲指标**。这条指控驳回。

### `--fail-on-regress` 是死代码

`check-rule-ledger.mjs:337`：

```js
const regression = ARG.failOnRegress && noExit > totalSentences - totalWithExit;
```

`noExit` 恒等于 `totalSentences - totalWithExit`，所以右侧**永远为 false**。
文件头 `:35` 仍宣称「出口数比上次少就 FAIL」。**唯一防趋势退化的机制不存在，且无自测。**

### 仓库门面仍在发布 3 个版本前的数字

`README.md:119`、`README.en.md:125`、`CAPABILITIES.md:113/215/223` 全部写 **8.9%（97/1084）**，当前工具输出 **20.3%（226/1113）**。一个以「机械校验」为卖点的仓库，它的头条指标靠手写。

`CAPABILITIES.md:114` 甚至写着「出口率为 0 的文件有 14 个」，并逐一点名 `evidence-policy.md(0/27)`、`wave3-critique.md(0/51)` 等。实测现在分别是 2/29 和 3/54：

```
framework/components/evidence-policy.md          2/29
framework/components/handoff-schema.md           1/31
framework/components/output-contract/verify.md   7/29
framework/templates/wave1-recon.md               1/35
framework/templates/wave3-critique.md            3/54
```

**门面文件从来没跟工具对过账。**

---

## 六、P4 · 门 0 在真实数据上的实际表现（45 条实测）

用 45 条真实 finding 逐条核对（被审仓库 `git archive 12f62da` 还原审计当时的树）：

| 结果 | 条数 | 说明 |
|---|---|---|
| 逐字命中声称行 | 24 | 完全合规 |
| 压平空白后命中 | 8 | 内容对，格式被改写 |
| **quote 存在但行号错了** | **8** | 行号偏移 −3 到 −77 |
| **全文件找不到 quote** | **3** | 见下 |
| **声称行号超出文件总行数** | **2** | |
| 合计 | 45 | **32 条通过 / 13 条不过** |

### 那 3 条「找不到」的，我亲自查了根因——结论与 Agent 报告不同

Agent 报告称这 3 条是「引用了审计之后才提交的修复代码」。我逐条核对，**其中至少 2 条的实际情况相反**。

**S03-F1**：`evidence` = `"settingsLoadedFromDisk = false;\nloadMonstersConfig();\nlastSavedSnapshot = activeConfig.snapshot();\nreturn false;"`，声称 `line: 1391`

在基线 `12f62da` 里：

- 这段代码**真实存在**，在 2009 行文件的**第 1326–1333 行**
- 但 `return false;` 不对——基线写的是裸 `return;`（方法返回 `void`）
- 声称的 1391 行在基线里是一段 `hammer.*` 配置读取注释，与 quote 无关

**我读了这条的 `problem` 字段，缺陷本身是真的**：

> `loadFromFile()` 走了「文件不可用 / gate 只读」的提前返回分支，**但在此之前先执行了 `lastSavedSnapshot = activeConfig.snapshot()`**。快照取自仍然被修改过的内存配置，于是 `hasUnsavedChanges()` 拿配置跟它自己比，返回 false。`MainConfigMenu` 随后渲染绿色的「已是最新」图标并隐藏保存按钮，而加载失败只产生了一条控制台 SEVERE。

我在基线里确认这段代码顺序确实是 `settingsLoadedFromDisk = false;` → `lastSavedSnapshot = activeConfig.snapshot();` → `return;`。**缺陷成立。**

**所以这条的真实形态是**：推理正确、缺陷真实，但 `evidence.quote` 的四行是把相邻代码**拼在一起并按修复后的形态改写了**（`return;` 写成 `return false;`），行号也声称成修复后的位置。

**这是门 0 最该抓、而现有实现抓不到的一类：quote 的每一片段都真实存在，拼接起来却不存在；行号指向另一个提交。**

现有 `verify-artifacts.mjs` 的判据是「quote 是否在某行附近模糊匹配」，对这种情形只能报 `WHOLE_FILE_ONLY` 或不报——它没有「拼接检测」，也没有「行号必须是本行」的严格模式。

---

## 七、P5 · 死字段与死规则

| 项 | 位置 | 状态 |
|---|---|---|
| `spawned_agents` | `protocol.md:1040` 定义、`:1067` 拿它做波次闭合条件 | `grep -rn spawned_agents tools/` = **0 命中** |
| `--fail-on-regress` | `check-rule-ledger.mjs:337` | 恒 false |
| 「契约没规定文件后缀」 | `output-contract.md:36` 只要求「以 json 代码块结尾」 | `report-naming.md:29` 正则强制 `\.md$`，两处从未对账 |

`spawned_agents` 尤其值得注意：它决定「有没有派发」这件事能否被对账，而这恰是 196-step 单线程事故（`subagent` 调用 0 次、全程无工具报错）的核心盲区。

---

## 八、§ 我没有采纳的指控

| 指控 | 为什么驳回 |
|---|---|
| 「出口率分母 30% 是标题/表格，指标被稀释」 | 实测散文句 19.4% vs 全部 20.3%，**几乎无差异** |
| 「`evidence-policy.md` 无人读取 = 门 0 无执行者」 | 该文件 `:28-34` 明确写着机械执行由 `check-payload` 与 `verify-artifacts` 负责。实测三种门 0 场景（纯注释 / 真实代码 / 编造引用）**全部按契约正确判定** |
| 「`.json` 被跳过导致『0 FAIL / 1 PASS』」 | 「0 FAIL 却报通过」可复现，但**具体是 `1 PASS + 5 SKIP`**，不是 Agent 描述的形态。缺陷真，症状描述不准 |
| 「`self_checks` 字段名三处不一致」 | 实测 wrapper / 模板 / 契约 / 校验器**四处一致**（`identifier_reconcile` / `self_check_audit` / `runtime_validation`） |
| 「那 3 条不到 quote 是引用了审计之后的修复代码」 | 我逐条核到基线 `12f62da`：**S03-F1 的代码在基线里真实存在（1326–1333 行）**，缺陷本身也成立。真实形态是「quote 片段拼接 + 行号指向另一版本」，不是「引用了未来的代码」 |

---

## 九、建议的下一步（单一答案，不列清单）

**先修「检查器的输入面」，不要碰出口率。**

本轮已经修完的四条（见各节 ✅ 标记）：

| 修了什么 | 回归测试 |
|---|---|
| 门 0 不再被尾逗号容错绕过 | `case 53` |
| 全 SKIP 从 exit 0 改为 exit 4 | `case 54` |
| 非 `.md` 产物从静默丢弃改为报 WARN | `case 55` |
| `--baseline` 路径不存在从静默跳改为 exit 2 | `case 6` / `case 7` |
| `/find/i` 误杀 46 条真出口 | `case 15` |

`check-all` 36 项仍全绿；自测数：verify-artifacts 58、wrapper-integrity 17、rule-ledger 32。

**还没做的三件事，按顺序**：

1. **让 `check-disposition-coverage` 与 `check-fix-instances` 能吃真实产物**：支持子目录递归、支持 `.json` 输入（或至少把「目录里有 N 个非契约格式产物」报出来）。
   现在它们对唯一一次真实审计是 **exit 2**，等于不存在。
2. **把它们接进 `gate.mjs` 的 close 门**，并让 `check-all` 注册本体而非自测。
3. **`check-rule-ledger` 的 artifact 出口加二级判据**：那个 `.md` 是否被某个 `tools/*.mjs` 实际读取。
   现在的 45% 里真假混在一起，不可用于决策。

至于「提高出口率」：**在指标修好之前不要把它当目标函数。** `b73b5b4` 那次提交就是「把规则写得更像已修复」的典型——它让数字从 18.4% 涨到 19.1%，但真实可执行出口一条没多。

---

## 附：本轮产物

- `MAIN-THREAD-PROBES.md` — 主线程逐条探针记录
- `CONTRACT-VS-IMPL.md` — 120 条契约 × 校验器双向对账（A/B/C/D）
- `CRITIQUE-DIRECTION.md` — 批判者对上一轮三条结论的攻击
- `RULE-LEDGER-TRIAGE.md` — 887 条无出口规则句的分诊分析 `[未复核]`
- `VERIFY-REAL-ARTIFACTS.md` — 真实产物复跑 `[未复核]`
- `REDTEAM-COVERAGE.md` — 覆盖缺口系统扫描 `[未复核]`

---

## 十、本轮已提交

| commit | 内容 |
|---|---|
| `b1d55af` | 门 0 尾逗号绕过 + 非 `.md` 静默丢弃 + 全 SKIP 即绿（exit 4） |
| `a9577b7` | `/find/i` 吃 46 条出口 + `--baseline` 路径错静默跳过 |
| `f55fe1d` | 门面陈旧出口率（8.9% → 22.3%，并明写严格口径 11.1%） |

`check-all` 36 项全绿。自测：verify-artifacts 58、wrapper-integrity 17、rule-ledger 32。

**未修，留给下一轮**（因为这些需要决定「契约该不该改」，不是改代码能定的）：

- P1 三条（真实产物对核心检查器不可用）—— 需要先决定产物格式是 `.md` 还是 `.json`
- P2 wrapper 与校验器对撞（`fix-worker.md:76` 说四字段、契约要 `disposition`）
- P4 `spawned_agents` 死字段（`protocol.md:1040` 定义、`:1067` 当闭合条件、tools 里 0 命中）
- P3 `--fail-on-regress` 恒 false（`check-rule-ledger.mjs:337`）

---

## 十一、第二轮续（2026-11-20 晚）—— 把「接错了地方」修掉

第十节列的未修项里，P1 与 P2 已处理。

| commit | 内容 |
|---|---|
| `61512bf` | wrapper 与契约对撞：照 wrapper 写产物必定被打回（fix 缺 disposition、audit 说空数组合法） |
| `f660a16` | `--fail-on-regress` 死代码修活 + `--quiet` 从未生效 |
| `6d2d7d0` | 发现去向检查器能吃真实产物 + 接进 close 门 |

### 修的三类「声明了但没接上」

这一轮反复撞见同一个形态，值得单独记：

1. **`--fail-on-regress` 恒为 false**。判据写成 `noExit > totalSentences - totalWithExit`，
   而 `noExit` 的定义就是这个差值。参数存在、文档宣称可用、**永远不生效**。
2. **`--quiet` 解析后从未被引用**。同上，只是更无声。
3. **两个最关键的检查器不在任何门上**。`check-disposition-coverage` 与
   `check-fix-instances` 是唯一能拦住「38 条发现只修 6 条」的机制，
   而 `gate.mjs` 的 close 门里 `grep -c "disposition"` 是 **0**。

共同点：**代码是好的，只是没有地方调用它。** 这与第一轮修的「门 0 被正则绕过」
是反方向的两极——那边是执行了但判据坏，这边是判据好但没执行。
`check-all` 36 个套件里 29 个是自测，理由正当（它验证校验器在合成 fixture 上对不对），
但代价是「全部通过」这句话对真实审计的证明力接近零。

### 一处我一开始修错的

`check-disposition-coverage` 里我先按**文件名**排除交付物
（`final-report` / `readme` / `unfixed`…），结果 `.run-hv/AUDIT-REPORT.md`
没被排除——真实文件名是 `-REPORT` 不是 `-final-report`。

枚举文件名这个思路本身就是错的：真实审计里交付物的命名千变万化。
改成按**内容**判断（出现 finding 的数据形状才要求信封），并补上表格形态
（`| S01-F1 | HIGH |`）——真实清单常是表格，早期只认 JSON 键会漏掉它们，
而那些漏掉的正好是「描述了 finding 却没信封」的文件，它们会静默逃出分母。

### 仍未修

- `check-fix-instances` 对真实产物 exit 2，缺口不在工具而在**报告真的没有裁决索引表**。
  这需要下一轮审计按契约产出，不是改代码能解决的。
- `check-rule-ledger` 的 artifact 出口仍占 41%（真假混在一起，不可用于决策）。
