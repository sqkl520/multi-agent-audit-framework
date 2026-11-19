# 批判：对「质量改进」三条结论的逐条攻击

**日期**：2026-11-20  
**状态**：只读。未修改任何仓库文件，未执行 git 写操作。  
**证据口径**：所有仓库内数字由我自己重跑得到；所有临时 fixture 建在系统临时目录，不在仓库内。

复现前提（下文命令均按此）：

```
cd multi-agent-audit-framework
node tools/check-rule-ledger.mjs --json --dump-rows > /tmp/rows.json
node tools/check-rule-ledger.mjs                       # 20.3%
```

---

## 攻击 1：出口率指标

### 指控

**「出口率 20.3%」不是一个在度量「规则能否被机器执行」的指标。它度量的是「一条规则句的 ±3 行窗口里，有没有出现过某个文件名或某个 `rule:` 字符串」。** 这个差别不是学术性的——它导致该指标同时虚高、虚低、可被单行文本操纵，而唯一用来防它退化的机制是一段永远为 false 的代码。

### 证据（文件:行 / 命令输出）

**(a) 分子里 45% 根本不是「机器出口」，只是「另一份文档的名字」**

`tools/check-rule-ledger.mjs:198-216` 把「点名 framework 下的另一个 `.md`」也算作出口。实测分解 226 条「有出口」的规则句：

```
exit kind counts: { script: 107, artifact: 130, rule: 139, discretionary: 16 }
rows whose ONLY exit is artifact: 102   ← 45.1% of the 226
rows with a REAL machine exit (script/rule): 124 / 1113 = 11.1%
```

也就是说，**真实可执行出口是 11.1%，不是 20.3%**。102 条「出口」形如：

```
framework/artifacts/final-report.md:233  ["artifact:protocol.md"]
  **主 Agent 必须在报告末尾原样粘贴以下命令的真实输出**：
```

这里 `protocol.md` 只是被提了一句，没有任何检测器执行「报告末尾是否真的贴了输出」。这正是该工具文件头 `:56-58` 自己批评的「橡皮图章」形态——只是从 `snake_case` 字段名换成了 `.md` 文件名。作者曾在 `:203` 承认「不排除的话出口率会从 33% 虚高」，但排除后 artifact 仍占 45%，说明排除得远远不够。

**(b) 分母里 30% 是结构性噪音**

抽取判据 `:191` 是「该行含 必须|不得|禁止|一律|must|shall|never」。实测：

```
total rows 1113
  headings / YAML frontmatter counted as rule sentences: 48
  table lines counted: 295
of the 887 no-exit rows: headings/frontmatter 46 + table lines 220 = 266 (30.0%)
```

包含：

```
framework/artifacts/final-report.md:16   ## 第 1 节：何时必须产出            (章节标题)
framework/artifacts/report-naming.md:6   source: 续写，遵守 … L0 禁止 …    (frontmatter)
framework/orchestrator/triage.md:22     | 一律按最贵跑 | 改一行错别字也开 7 个 agent |  (反例表格行)
```

第 22 行的「一律按最贵跑」是**被禁止的做法举例**，它是佐证材料，不是规则。把它算进分母并判为「无出口」，等于给一个永远无法正确的分母充数。

**(c) 你举的例子成立，而且工具自己承认了它不处理这件事**

`framework/orchestrator/triage.md:245`：

```
| **未擅自降级** | 不得超过规定成员数下调；确实要下调时，只能由**用户**决定，主 Agent 不得自行判断 |
```

实测该行的 ledger 记录：`245 false []` —— 无出口。但「不得自行判断」约束的是**主 Agent 的内部推理**，不存在任何可以观测它的机器信号（除非读 reasoning trace，而框架不读）。`check-rule-ledger.mjs:69` 原文：

> 它也不判断「这条规则该不该有机器出口」——那是人的决定，本工具只负责让它无法被静默忽略。

**这行注释就是指标构造性缺陷的供词。** 指标把「该不该有出口」这个决定性判断排除在外，却把结果除以一个包含它的总数，然后把这个商当作可行动的数字。一个永远不可能接近 100%、且永远无法区分「缺陷」与「设计」的比率，没有行动含义。

**(d) 指标可被一行文本操纵**

在临时副本里（`git archive HEAD` 解出，不在仓库内）插一行：

```
> 由 `tools/check-payload.mjs` 与 `tools/check-state.mjs` 负责。
```

实测：

```
framework/artifacts/final-report.md@20  credited 1 rows | rate 20.3% -> 20.4%
framework/templates/wave2-audit.md@60   credited 3 rows | rate 20.3% -> 20.6%
```

**一行文字 = 1~3 条规则「获得出口」**，因为 ±3 行窗口（`:112 WINDOW = 3`）覆盖多个规则句。而「写一句指向校验器的话」恰恰是最省力的做法。历史记录证明这条路径真的被走了：`b73b5b4` 只改了 24 行文档（`git show --numstat`: `8 0 triage.md` / `16 0 wave3-critique.md`），出口率 18.4% → 19.1%，一次 +8 条。工具奖励仪式性文本，而它的目标是消灭仪式性文本。

**(e) 唯一的防退化机制是死代码（自相矛盾）**

```
tools/check-rule-ledger.mjs:247   const noExit = totalSentences - totalWithExit;
tools/check-rule-ledger.mjs:337   const regression = ARG.failOnRegress && noExit > totalSentences - totalWithExit;
```

`:337` 的右式恒等于左式，判据化简为 `noExit > noExit`，恒 false。穷举验证：

```
total=10 with=3 -> regression=false
total=3 with=10 -> regression=false
total=5 with=0 -> regression=false
total=0 with=0 -> regression=false
```

`--fail-on-regress` 从未、也永远不可能触发。且 `grep -n "fail-on-regress" tools/check-rule-ledger.test.mjs` = **0 命中**，没有测试覆盖它，所以 30 个自测全绿也没有暴露它。文件头 `:35` 把这个 flag 当成防线写给读者看。

**(f) 历史不稳定，且不稳定方向由判据宽度决定**

在 5 个提交上重跑（`git archive`，非仓库内）：

```
d50937b -> 1090 / 201 = 18.4%
b73b5b4 -> 1096 / 209 = 19.1%
09218af -> 1090 / 201 = 18.4%
c4d1fdb -> 1097 / 210 = 19.1%
HEAD    -> 1113 / 226 = 20.3%
```

提交说明自己记录了判据宽度造成的四次漂移：`9.1% → 27.1% → 33.0% → 18.4%`（`d50937b` message）。**同一个仓库、同一批规则句，指标在 9%~33% 之间摆动，取决于正则宽紧。** 一个对判据实现如此敏感的数字无法用于指导行动。

**(g) 它不是闸门，也进不了 CI 判定**

`.github/workflows/checks.yml:53`：`continue-on-error: true`。仓库里唯一可能是闸门的地方（`CONTRIBUTING.md:45`、`.github/pull_request_template.md:19`）是**人工检查单**。

### 我的结论：**指标无效（作为覆盖率指标）；仅部分有效（作为缺陷定位器）**

必须重构，理由不是数字偏高或偏低，而是它把「该不该有出口」（人的判断）从模型里剔除了：
- 分母应只含「可归属于某个执行主体、且其满足条件可被观测」的规则句；
- 分子应只含「有检测器读取该条件」的出口（排除 `artifact:` 与 `discretionary`）；
- 报告应分三类而不是一个比率：**可机器验证 / 明确豁免（须写理由）/ 不可判定**。

按此口径重算的现有数字是 **11.1%（124/1113）**，且分母仍需人工筛掉 30% 结构性噪音。该工具真正的价值不在那个百分数，而在它确实定位到的实例级缺陷（如 `:16` 记录的 `verify.md` 要求 `mutation_scope` 而无人校验）——**这些是条目的价值，不是比率的价值。**

---

## 攻击 2：`.json` 跳过是不是真缺陷

### 契约到底要求什么（引原文 + 行号）

`framework/components/output-contract.md`：

```
:20   ## 第 0 节：产物的物理形态（所有角色适用）
:36   **你的产物文件必须以一个 json 代码块结尾，里面是本契约定义的信封。**
:45   **这不是「示例」，是格式要求。** 正文写多少都行，但**最后一个代码块必须是完整、可解析的 JSON 信封**。
```

`framework/artifacts/report-naming.md:29`：

```
^round(\d+)-(01-recon|02-sweep|02-audit|03-critique|04-fix|05-verify)-[a-z0-9]+(-[a-z0-9]+)*\.md$
```

7 份 wrapper 全部同义重复「你的产物文件必须以一个 ```json 代码块结尾」（`audit-specialist.md:57`、`critique-panel.md:58`、`fix-worker.md:55`、`planner.md:69`、`recon-scout.md:52`、`sweep-scout.md:84`、`verifier.md:52`）。

**结论：框架从未、也不要求产出 `.json` 产物。** 唯一的合法形态是 `.md` + 尾部 json 块。所以「`verify-artifacts` 应该支持 `.json`」是错的——`.json` 产物是**格式违规**，不是需要被兼容的输入。

### 你的第二句话对，第一句话的两条描述错

**(a) 症状「0 FAIL / 1 PASS，宣称全通过」我没有复现出来。**

我试了四种目录形态，没有一种给出 `0 FAIL / 1 PASS`：

| 场景 | 实际输出 |
|---|---|
| `.json`-only 目录（2 个 json） | `1 FAIL / 0 WARN / 0 PASS / 6 SKIP`，exit 1 |
| `.run-hv` 真实目录（65 json + 5 md） | `6 FAIL / 0 WARN / 0 PASS / 6 SKIP`，exit 1 |
| 1 份合法 md + 1 份 json 产品 | `0 FAIL / 0 WARN / 3 PASS / 3 SKIP`，exit 0 |
| sweep 信封 + RETRYABLE_FAILURE + json 产品 | `0 FAIL / 0 WARN / 0 PASS / 6 SKIP`，exit 0 |

最后一行的场景说明 **`0 FAIL` 绿是真的存在**——但它的机制不是「`.json` 被跳过」，而是 **全 SKIP 即绿**。`verify-artifacts.mjs:1092` 只拦「一个信封都没有」：

```js
if (envelopes.length === 0 && salvaged.length === 0) { fail('G0', ...); }
```

只要有一份信封（哪怕是 `status: RETRYABLE_FAILURE`、`artifact_path: null`、`payload` 无 `files_read`/`evidence`），6 项检查全 SKIP，exit 0，打印「合计: 0 FAIL」。`.run-hv` 那次事故（`DIAG-FINAL.md:335`）里的 `71 FAIL / 6 WARN / 1 PASS / 3 SKIP` 也在同一类：数很吵，但 SKIP 掉了 G4（账本对账）——即「派了几个 agent」从未被对账。

**(b) 「`.json` 被静默跳过」是真的，而且比你说的更严重——但修法不是你设想的那个。**

`tools/verify-artifacts.mjs:1001`：

```js
else if (e.name.endsWith('.md')) {     // 非 .md 一律不进 scanned，也不计数、不 WARN
```

实测「1 份合法 md + 1 份 .json 产品」目录：

```
files on disk: { '.json': 1, '.md': 1 }
扫描产物: 1 个文件，解析出 1 个信封
合计: 0 FAIL / 0 WARN / 3 PASS / 3 SKIP   EXIT=0
```

`.json` 文件在磁盘上存在，在报告里**一个字都没出现**：既没进 `scanned` 计数，也没有「非法格式」告警。这是「覆盖缺口被报告成绿灯」，指控成立。

用仓库自己的真实审计验证一下量级——`.run-hv` 是仓库里唯一一次真实 dsh 审计（`0dbb5ad` 提交，`AUDIT-REPORT.md:6`「dsh 多 Agent，10 切片」），产物是 65 个 `.json` + 5 个 `.md`：

```
$ node tools/verify-artifacts.mjs --repo . --artifacts .run-hv
  扫描产物: 5 个文件，解析出 0 个信封
合计: 6 FAIL / 0 WARN / 0 PASS / 6 SKIP
$ find .run-hv -name '*.json' | wc -l
65
```

**报告说「扫描 5 个文件」，实际有 70 个。65 个真实产物对校验器不存在。**

**(c) 因此正确的缺陷定位是：应报「目录里存在 N 个非契约格式文件」，而不是去解析 `.json`。**

契约的立场很明确（`:45`「这不是示例，是格式要求」），`WRAPPER-EFFECTIVENESS.md:19-21` 也记录过：加载 wrapper 后 agent 自主产出了**合规的 `.md`**。所以 `.json` 出现在产物目录里，本身就是要报的错误，不是要兼容的输入。当前实现把它当空气——这比报错更糟，因为它让「格式违规」和「目录干净」看起来一样。

### 我的结论：**缺陷，但定位错误**

- 「`.json` 被跳过导致绿灯」：**真缺陷**（`verify-artifacts.mjs:1001`），修法是 **FAIL 或至少 WARN 报出非 `.md` 文件数**，不是支持 `.json`；
- 「0 FAIL / 1 PASS」这个具体症状：**未复现**（`NOT_PROVEN`）。要判定它，需要你提供当时的目录内容或命令输出——我按四种组合都没得到 1 PASS；
- 「全 SKIP 即绿」：**真缺陷且更严重**（`verify-artifacts.mjs:1092` 的守卫太窄），它与 `.json` 无关，但同属「覆盖缺口报绿」这一类；
- 契约要求的是 `.md`+json 块，`report-naming.md:29` 的正则强制 `.md`，因此「支持 `.json`」这个方向本身是**错的**。

---

## 攻击 3：补校验器是不是错的方向

### experiments/ 里的既有结论（引文件名 + 关键结论原文）

**1. 唯一做过对照实验的「加规则」，结果是伤害。** `experiments/RULE-EFFECTIVENESS.md:10`：

> **§4.5.0「运行时验证必须调用公开 API 主路径」这条规则，让 recall 下降 5.0 个百分点，效应量中等。**

同文件 `:101-105`：

> **错误 2：先改框架，后做验证** — 我先写了 §4.5.0（模板 + 校验器 + 72 项测试里的 3 项），**然后**才做对照实验。正确顺序应该是：小规模对照 → 确认有效 → 再改框架。

同文件 `:135-144` 的表格把你现在关心的 `check-promises.mjs` 直接列为**从未验证**：

> | `check-promises.mjs` | GT-014 | ❌ |
> **这次是第一次做对照，结果就是我加的那条有害。**

**2. 「这 19 条规则的依据全部是某个 agent 发现了某个东西」。** `experiments/FINAL-REPORT.md:10`：

> **19 条规则里，只有 1 类干预经对照实验证实有效（模式 1/2/3），另有 2 条被证实有害或无效，还有 5 条至今没有任何有效数据。**

同文件 `:155`：

> **最根本的一条**：我之前的每一条规则，依据都是「某个 agent 发现了某个东西」，**没有一条做过对照**。

**3. 明确禁止「凭空造检测器」。** `experiments/FAILURE-MODES.md:90`：

> **所以不写工具。** 没发生过的失败模式，凭空造一个检测器，大概率是错的。

**4. 明确给出优先级，校验器排第三。** `experiments/hilltop-dsh/DIAG2-coverage-gap.md:469`：

> 排序原则：**改一个判定点 > 新增一个产物 > 新增一个校验器 > 扩展语言支持**。前两项能立刻覆盖 31 条，后两项是长期工程。

**5. 真实审计里，校验器「跑了但全空转」。** `experiments/hilltop-dsh/DIAG2-coverage-gap.md:420-430`：

> 目标仓 `src` 下 **161 个 `.java`**，`.js/.mjs/.ts/.cjs` **0 个**。**扫描了 0 个文件，EXIT=0。**

**6. 加到自述层的边际收益已到零。** `experiments/hilltop-dsh/FIX-R19-report.md:309`：

> 继续在自述层加字段的边际收益已经接近零，而边际成本（每个字段都是一个新的「省略它就能绕过」的入口）已经很明显。

`experiments/hilltop-dsh/FIX-R6-report.md:307`：

> **下一层的边际收益在 harness 侧证据，不在再加自述规则。**

**7. 架构层面的结论：11/11 校验器对「该派的活被主线程自己干了」检出率 = 0。** `experiments/hilltop-dsh/DIAG3-three-layer-closure.md` §1.12。而 `FIX-R1-R18-SUMMARY.md:10-16` 记录的正是那次事故：**单 session 串行 196 step、`subagent` 调用 0 次、38 条发现只修 6 条、2 条 HIGH 仍在代码里、框架全程没有任何工具报错**。

### 结构性证据：36 个套件里 29 个是自测，且 `check-all` 不接受任何真实输入

```
$ node -e '...统计 check-all.mjs 的 script: 条目...'
total 36  selftest(.test.mjs) 29  probe fixtures 3  other 4
```

`tools/check-all.mjs` 全文无 `--repo` / `--artifacts` / `--state` / `--round-dir` 参数（`grep "args:"` 只有 1 处，是 wrapper 基线文件）。`check-all.mjs:171-174` 自己写明：

> check-all 是「框架自检」——它验证校验器本身在合成 fixture 上行为正确；它不知道也不该知道某次审计的产物在哪、去向表叫什么。

所以 **「36 项全绿」证明的是「校验器在自造样本上行为正确」，对「真实审计质量」的证明力为零。** 我实跑 `node tools/check-all.mjs` 两分钟内 27 个条目全绿推进（BACKGROUND 截断），这与命题无关。

**更致命的是：能接受真实产物的两个最该接线的检查器，没有接在任何门上。**

- `tools/gate.mjs:51-56` 的 close 门 `checks: ['check-state…', 'check-deliverables…']`；
- `grep -c "disposition" tools/gate.mjs` = **0**；`grep -c "fix-instances" tools/gate.mjs` = **0**；
- `check-all.mjs:179` / `:196` 注册的是 `check-disposition-coverage.test.mjs` / `check-fix-instances.test.mjs`——**自测，不是本体**；
- 而这两个正是 `DIAG2` 认定的、唯一能拦住「38 条只修 6 条、31 条从未表态」的机制。

**它们甚至在仓库唯一的真实审计上跑不起来：**

```
$ node tools/check-disposition-coverage.mjs --artifacts .run-hv --ledger .run-hv/UNFIXED.md

[配置错误] artifacts_contain_subdirectories
  .run-hv 下有子目录（critiques、deep、findings）——子目录里的产物不会进分母，等于凭空白名单。
EXIT=2
```

真实审计的产物天然在子目录里（`findings/`、`critiques/`、`deep/`）。**也就是说：这套框架最重要的两个检查器，对它自己唯一一次真实审计，是 exit 2。** 再补 10 个校验器也不会改变这件事。

### 我的结论

**结论 3 站不住，而且是本末倒置。** `RULE-EFFECTIVENESS.md:144` 已经是这个错误的完整记录：先加规则/校验器、后验证，结果新加的那条有害。现在提议「继续补校验器 / 提高出口率」，是把同一动作再做一遍，且用一个已被证明无效的指标（攻击 1）当目标函数。

「提高出口率」尤其危险：出口率的分子可以由**写一句话**抬高（实测 +1~+3 条/行），而 `b73b5b4` 就是这么做的。优化这个指标的最省力路径，正是把「规则存在、引用断了」这个病写得更像已修复。

---

## 我发现的、你没提到的缺陷

### 0. 【最高优先】一个核心 wrapper 曾被改成「（已删）」，全套 36 项检查仍然全绿

**这是我在本次会话期间直接观测到的实况，不是推演。**（注：并发跑的变异探针随后自行还原了文件，所以现在 `git status` 已看不到它。下面记录的时间戳与命令输出是我亲眼看到并执行的。）

会话开始时 `git status --short` 只有两项：

```
 M tools/check-rule-ledger.mjs
?? .probe-rows.json
```

中途再跑同一条命令，多出：

```
 M framework/wrappers/audit-specialist.md
?? framework/wrappers/audit-specialist.md.mutbak
```

`framework/wrappers/audit-specialist.md` 当时的内容（未修改的 HEAD 版本在 `.mutbak` 里，实测与 `git show HEAD:…` 逐字节相同）：

```
:3   description: 波次二·审计。…产出符合（已删） 的缺陷发现。…
:19  你被指派一个 (slice_id, dimension) 组合…产出有（已删） 证据的发现。
:50  1. `components/evidence-policy.md` — （已删），这是你的准入门槛
```

`门 0` 是这套框架最核心的证据规则，被全局替换成「（已删）」，共 3 处。**在那个被破坏的树上，我实跑了这些命令：**

```
$ node tools/check-all.mjs
✅ 全部通过                       ← 36 项，全部通过

$ node tools/check-wrapper-integrity.mjs --baseline fixtures/wrapper-baseline.json
✓ audit-specialist             91   —
合计: 0 项问题 / 7 个文件        EXIT=0

$ node tools/check-wrapper-contract.mjs
audit  audit-specialist.md  强覆盖 2/2
全部 7 个角色：必填字段均在「产物格式」小节内写成强覆盖。   EXIT=0

$ node tools/lint-autonomy.mjs
合计: 0 FAIL / 1 WARN            EXIT=0
（唯一的 WARN 是 planner.md 行数超限，与本次破坏无关）

$ node tools/check-wrapper-contract.test.mjs   → 12 通过 / 0 失败, EXIT=0
$ node tools/lint-autonomy.test.mjs            → 18 通过 / 0 失败, EXIT=0
```

**成因**：仓库里有两个会**写**受版本控制文件的自测脚本——`.audit-r2/fair-mutation.mjs:27-42` 与 `.audit-r2/mutation-probe.mjs:27-41`，两者都是 `copyFileSync(abs, bak) → writeFileSync(abs, 变异体) → fullSuite() → copyFileSync(bak, abs)`。会话期间有并发进程在跑它们，`audit-specialist.md` 在 `02:45:34` 被写入变异体，直到我观测并跑完检查之后才被还原。

**这条为什么是全篇最严重的**：

1. 它证明「36 项全绿」对**核心提示词文件被语义摧毁**没有任何检出能力——`check-wrapper-integrity` 只查小节存在与行数（变异不改行数），`check-wrapper-contract` 只查字段名出现过（变异不动字段名），`lint-autonomy` 的 L13 也是词频。三者的判据都不包含「这句话是否还说得通」。
2. 它同时证明了攻击 3：**自测绿 ≠ 框架没坏**。`check-all.mjs:5-9` 头注释自己写着「check-all 报全绿，不代表框架没问题」，现在这句话有了实证。
3. 变异脚本把 `.mutbak` 备份放在**仓库工作树内**，且还原在 `finally` 里——一旦进程被杀（`fair-mutation.mjs:19` 的 `timeout: 480000`，单次全套实测 4 分钟以上），备份残留、原文件永久停在变异体状态。这正是 `DATA-LOSS.md` / `CHECKOUT-INCIDENT.md` 记录过的同一类事故在重演，只是这次工具**主动**改写了框架自己的提示词。

**建议**：变异测试必须（a）在临时副本上做，不写工作树；（b）把 `.mutbak` 放到工作树之外；（c）加一个「工作树必须干净」的前置断言——本次事故里 `.mutbak` 在树内被 `git status` 看到，但**没有任何自测会因此失败**。

**1. `--fail-on-regress` 是死代码（`check-rule-ledger.mjs:337`，恒 false，无测试）。** 唯一防趋势退化的机制不存在，且文件头 `:35` 仍然宣称它可用。这属于「仪表自己坏了而仪表盘显示正常」。

**1. 覆盖检查可通过删除输入来绕过——实测 exit 0「契约合规」。** `check-payload.mjs:1364-1385` 的 `disposition_missing_for_target` 只在 `target_finding_ids` 非空时生效。造一份「38 条里只处置 1 条」的 fix 产物，不写 `target_finding_ids`：

```
$ node tools/check-payload.mjs /tmp/fixbypass/round1-04-fix-001.md --role fix
  role: fix   status: SUCCESS
  ✅ 契约合规
EXIT=0
```

它带齐了 `files_touched`、`test_path`、`red_log_path`，一条发现处置得完美，另外 37 条静默消失，判绿。这正是 `FIX-R19:309` 预言的「加字段 → 省略它 → 整道闸门失效」。

**2. `spawned_agents` 是契约要求但零工具读取的死字段。** `framework/orchestrator/protocol.md:1040` 定义 `spawned_agents: int  # 实际已派发数`，`:1067` 拿它做波次闭合条件。`grep -rn "spawned_agents" tools/` = **0 命中**。这与 `DIAG3` 记录的「规则要求往一个不存在的地方写」是同一种病，而且它决定了「有没有派发」这件事无法被对账——恰好是那次 196-step 单线程事故的核心盲区。

**3. 全 SKIP 即绿（比 `.json` 跳过更严重）。** `verify-artifacts.mjs:1092` 的守卫只覆盖 `envelopes.length === 0`。实测一份 sweep 信封 + 一份 `.json` 产品：

```
合计: 0 FAIL / 0 WARN / 0 PASS / 6 SKIP
EXIT=0
```

**6 项检查全被 SKIP，0 项 PASS，退出码 0。** 「什么都没验证」被报告成成功。`DIAG-FINAL.md:335` 那次 `3 SKIP` 里包含 G4（账本对账）——即「派了几个 agent / 修了几条」从未被对账，而报告是绿的。

**4. 仓库门面发布的出口率是 3 个版本前的数字，且与工具输出矛盾。** `README.md:119`、`README.md:185`、`CAPABILITIES.md:113`、`:134`、`:215`、`:223`、`README.en.md:125`、`:191` 全部写 **8.9%（97/1084）**；当前工具输出 **20.3%（226/1113）**。一个以「机械校验」为卖点的仓库，它的头条指标靠手写维护。这正是 `DIAG3` 说的同一形态：文档与工具之间没有对账。

**5. `check-all` 里 4 个条目名为「校验器」实为「自测」，而注释已承认这类接线错误修过一次。** `check-all.mjs:89-93` 记录：`check-wrapper-integrity` 曾经「只有 script、没有 args…永远是绿的…检查器写对了，只是没接上线」。现在 `check-disposition-coverage` / `check-fix-instances` / `check-pattern-coverage` / `check-rule-doc-link` / `check-round-detection` / `check-handoff` / `verify-postfix-snapshot` / `lint-terminology` 都只注册了 `.test.mjs`。**同一个「没接上线」的病，在修过它的文件里又复发了 8 次。**

**6. 唯一真实审计（`.run-hv`，65 JSON）对框架的两个核心检查器都是不可见的/不可跑的。** 见攻击 2(b) 与攻击 3。这意味着框架从未在真实产物上被端到端验证过——`WRAPPER-EFFECTIVENESS.md:128` 自己也承认「n=1，一个 agent，一份产物」。

---

## 一句话总结：这套框架现在最该做的事是什么

**停止新增校验器与提高出口率，先修「检查器的输入面」：把 close 门接上 `check-disposition-coverage` 与 `check-fix-instances`，并让所有检查器接受真实产物（子目录、非 `.md`、`.json`）——因为仓库里唯一一次真实审计（`.run-hv`，65 份 JSON）对这两个检查器是 exit 2，对其余校验器根本不存在；而在这些检查器接上之前，「全部通过」对核心提示词被改坏都不响应（见缺陷 0 的实测）。**

---

## 附：我的判定表

| 你的结论 | 判定 | 关键证据 |
|---|---|---|
| 1. 核心病是「规则在提示词、检测器在 tools、中间没对账」 | **方向成立，指标无效** | 真实可执行出口 11.1% 而非 20.3%（`artifact:` 占 45%）；分母 30% 为标题/表格；`--fail-on-regress` 恒 false（`:337`）；插一行可 +1~3 条（实测） |
| 2. `.json` 跳过使混合目录报「0 FAIL / 1 PASS」 | **缺陷真，症状未复现，定位错** | 契约只允许 `.md`+json 块（`output-contract.md:36,45`；`report-naming.md:29`）；`verify-artifacts.mjs:1001` 确实静默跳过（65 文件只报 5）；`0 FAIL / 1 PASS` `NOT_PROVEN`；真正绿的路径是全 SKIP（`:1092`） |
| 3. 下一步最值得做的是继续补校验器 / 提高出口率 | **错，且与仓库既有实验结论相反** | `RULE-EFFECTIVENESS.md:10,101,144`（加规则导致 recall −5、先改后验有害）；`FINAL-REPORT.md:10,155`（19 条只有 1 类被证实有效）；`FAILURE-MODES.md:90`（不凭空造检测器）；`DIAG2:469`（校验器排第三）；`DIAG3` §1.12（11/11 检出率 0）；`check-all` 29/36 是自测且无真实输入 |
