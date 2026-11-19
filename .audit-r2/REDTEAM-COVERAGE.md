# 红队报告 · 覆盖缺口被报告成绿灯

审计对象：`multi-agent-audit-framework/tools/*.mjs`（36 个校验器）
方法：读源码定位过滤/跳过/计数点 → 在 `.probe-redteam/` 构造最小输入 → 实跑取真实输出
硬约束遵守：未改 `tools/` 或 `framework/` 任何文件；未做任何 git 写操作；探针目录收尾已删。

分档：
- **一档**：会让真实审计产物（含编造证据）逃过检查 → 直接导致「全绿但没查」
- **二档**：只会误报不合规（惩罚诚实产物）
- **三档**：只影响统计数字 / 仪表读数

---

# 一档 · 会让真实审计产物逃过检查

## 1. 尾逗号容错会静默改写 quote 字符串，门 0 因此把编造的 quote 判成「逐字原文」

**`tools/verify-artifacts.mjs:204-208`**

```js
const cleaned = raw
  .split('\n')
  .filter((ln) => !/^\s*\/\//.test(ln))
  .join('\n')
  .replace(/,(\s*[}\]])/g, '$1');   // ← 正则不尊重字符串边界
```

这个 `.replace` 作用于**整段 JSON 文本**，包括字符串字面量内部。`check-payload.mjs` 在
2026-11-14 已经因为同一原因把容错降级为「先按原样解析，失败才容错，且必须留 WARN」
（`check-payload.mjs:466-500`，规则 `json_trailing_comma_fixed`）。**`verify-artifacts.mjs`
的这条路径没有跟着改**：它无条件先容错、再解析、且不产生任何 WARN。

### 探针（双向都实测）

源文件 `.probe-redteam/repo/src/comma.js` 全文一行：

```
if (a) { return {x}; }
```

**方向 A — 编造的 quote 被判真实（假绿）**

产物 `.probe-redteam/c10/round1-core-audit.md` 的 evidence：

```json
{ "file": "src/comma.js", "line": 1, "quote": "if (a) { return {x,}; }" }
```

这个 quote 在源文件里**逐字不存在**（`grep -c 'return {x,}; }'` → `0`）。容错正则把
`{x,}` 改写成 `{x}` 后拿去比对，于是匹配成功：

```
$ node tools/check-payload.mjs .probe-redteam/c10/round1-core-audit.md
  ✅ 契约合规                      EXIT=0
$ node tools/verify-artifacts.mjs --repo .probe-redteam/repo --artifacts .probe-redteam/c10
✓ PASS  [G0] 门 0 回显: 1/1 通过（0 条 quote 与源文件不符 …）   EXIT=0
$ node tools/gate.mjs --gate accept --artifact … --role audit --repo …
  ✓ check-payload
  ✓ verify-artifacts
  ✅ 放行                          EXIT=0
```

**方向 B — 诚实产物被判伪造（假红）**

源文件 `.probe-redteam/repo2/src/comma.js` 原文就是 `if (a) { return {x,}; }`，
产物逐字引用它（这是**正确**的门 0 引用）。同一个正则把产物里的 quote 也改写成 `{x}`，
于是比对源文件失败：

```
$ node tools/verify-artifacts.mjs --repo .probe-redteam/repo2 --artifacts .probe-redteam/c11
✗ FAIL  [G0] quote 未出现在 src/comma.js:1 附近
✗ FAIL  [G0] 门 0 回显: 0/1 通过，1 条 evidence 缺 file 或 quote（等于没有证据）
                                                                    EXIT=1
```

### 危害

门 0 是框架的**唯一证据规则**（「每条 finding 必须逐字引用 file:line 原文」）。这条路径让
「逐字」变成「经一个会改内容的 regex 处理后相等」。实际后果两种：

1. 子 Agent 写出含 `,}` / `,]` 的 quote（Java/Kotlin/Rust/Scala 的对象与数组字面量里极常见），
   即使原文是编的也能通过门 0 —— 而 `gate accept` 会放行它进入下游。
2. 反过来，真实产物被误判为伪造，主 Agent 按 `CONTRACT_VIOLATION` 重派，浪费一次完整派发。

### 反方意见

- 文件头注释（`verify-artifacts.mjs:196`）写的是「容忍 // 行注释与尾逗号」，说明容错是**有意设计**。
  但「有意容错」不等于「允许静默改写 quote 内容」——同一作者在 `check-payload.mjs:466-500`
  为同一问题加了 WARN，并明确写了「一旦容错改动了内容，这份产物就不能再声称 quote 逐字」。
  两个工具对同一份产物给出不同结论，而 `gate accept` 同时调用两者。
- `//` 行注释过滤（:206）有同样的问题，且**影响更广**：任何一行以 `//` 开头的字符串
  内容都会被整行删掉。这一点未单独构造探针（属于同一处代码的同一类缺陷）。

**置信度：CONFIRMED**（双向实测）

---

## 2. `verify-artifacts.mjs` 只扫 `.md`：`.json` / `.txt` 产物连分母都不进

**`tools/verify-artifacts.mjs:1001`**

```js
else if (e.name.endsWith('.md')) {   // ← 非 .md 静默丢弃
```

已知项（本次审计的起点），此处补充**新的实测证据**：不只 `.json`，`.txt` 同样被丢弃，
且报告里的「扫描 N 个文件」N **不包含**它们。

### 探针

`.probe-redteam/c13/arts/` 放一份 `round1-extra-audit.txt`（内含一条 `severity: HIGH`
的 finding）。同一条过滤在 `check-disposition-coverage.mjs:224` 也存在：

```js
.filter((f) => /\.(md|markdown)$/i.test(f))
```

```
$ node tools/check-disposition-coverage.mjs --artifacts .probe-redteam/dc/arts \
    --ledger .probe-redteam/dc/ledger.md
  解析产物: 1 个文件，1 条 finding（HIGH 0 / MEDIUM 1 / LOW 0）   ← .txt 里的 HIGH 未计入
合计: 1 条 finding / 已表态 1 / 未表态 0
合计: 0 FAIL / 0 WARN / 1 PASS
结论：全部 1 条都已表态，且没有 HIGH 悬空。                       EXIT=0
```

去向表只对 `.md` 那条（F1）表了态；`.txt` 里的 F9（HIGH）从未表态，而工具报
「没有 HIGH 悬空」。

`.probe-redteam/c13/arts/` 只放 `.txt` 时，`check-disposition-coverage` 直接
`configError('artifacts_missing', '产物目录里没有任何 .md')` → exit 2。也就是说它**知道**
自己只认 `.md`，但在「有一个 .md + 一个 .txt」的混合形态下，那个 `.txt` 完全不留痕迹。

### 危害

「每条发现都被表态过一次」这条防线针对的历史损失是「38 条发现只修了 6 条」。只要把某批
产物存成 `.txt`（或 `.json` 信封），它们既不进分母、也不触发任何 WARN，覆盖率仍显示 100%。

### 反方意见

- 契约 `report-naming.md:106` 明确「只在 `docs/reports/round{N}/` 下」、`wave2a-sweep.md:123`
  的产物命名规范全是 `.md`。所以「产物是 .md」**是有契约依据的**。
- 但缺陷不在「只处理 .md」，而在「非 .md 出现在产物目录里时不留任何痕迹」。对比同仓库里
  做对了的实现：`check-disposition-coverage.mjs:235-243` 对「有子目录」报 configError，
  理由写得很清楚——「子目录里的产物不会进分母，等于凭空白名单」。
  `.txt` / `.json` 是同一种白名单，只是没被识别。

**置信度：CONFIRMED**

---

## 3. `gate accept` 把门 0 检查声明成「可选」：不给 `--repo` 就完全跳过，且报「✅ 放行」

**`tools/gate.mjs:141-147`**

```js
// 门 0 回显校验是可选的（需要 --repo）
const repo = getArg('--repo');
if (repo && artifact) {
  const r = runScript('verify-artifacts.mjs', ['--repo', repo, '--artifacts', dir]);
  add('verify-artifacts', r.ok, r.out);
}
```

`framework/orchestrator/protocol.md:967` 把 `--gate accept` 定义为「**每次收到返回后**」执行、
检查「契约合规（`check-payload`）、**门 0 回显（`verify-artifacts`）**」、拒绝后果「判
`CONTRACT_VIOLATION`，**不得进下游**」。缺 `--repo` 时两个检查里的第二个**整条消失**，
报告仍打印「✅ 放行」。

### 探针

`.probe-redteam/gate2/fabricated-ok.md`：`check-payload` 全绿的产物，但 evidence 的 quote
是「这一行原文完全不存在，是我编的」（源文件 `.probe-redteam/repo/src/pay.js` 第 1 行是
`const total = acct.balance - amt;`）。

```
$ node tools/gate.mjs --gate accept --artifact …/fabricated-ok.md --role audit
  ✓ check-payload
  ✅ 放行                                         EXIT=0     ← 编造引用被放行

$ node tools/gate.mjs --gate accept --artifact …/fabricated-ok.md --role audit --repo …/repo
  ✓ check-payload
  ✗ verify-artifacts   （G0: 2 FAIL）
  ⛔ 拒绝 —— 判 CONTRACT_VIOLATION，不得进下游      EXIT=1
```

注意 `results` 数组里根本没有 `verify-artifacts` 这一项——不是「检查失败」，是「检查没跑」，
而汇总层 `const failed = results.filter((r) => !r.ok)` 对这二者无法区分。

### 危害

`protocol.md` 把 `--repo <被审仓库>` 写在示例命令里，但**没有任何机械约束**要求它必须出现。
漏写一个 flag = 门 0 这条证据规则在被审计的整个下游路径上不存在，而门禁输出照样是
「✅ 放行」。这正是本框架自己反复记录的失效形态（「检查没跑」被报告成「检查通过」）。

### 反方意见

- 注释写「可选」可能是有意的：某些形态（例如被审仓库路径拿不到）确实无法做门 0。
  但对比同文件的其它门：`--gate close` 缺 `--state` 时是 `add('check-state', false, '未提供 --state')`
  即**判失败**；`--gate dispatch` 缺 `--payload` 时同样是 `add(..., false, ...)`。
  只有 `accept` 这一门把「缺参数」处理成「不检查且放行」。同一文件内两种处理方式不一致，
  而这一段是唯一会让证据校验凭空消失的那一种。

**置信度：CONFIRMED**

---

## 4. `check-payload` 的 `ROLE_REQUIRED` 只查 key 存在、不查值：所有必填字段写成 `null` 仍判「✅ 契约合规」

**`tools/check-payload.mjs:687-693`**

```js
for (const k of req) {
  if (!(k in envelope.payload)) {          // ← 只看 key 在不在
    errors.push({ …, rule: 'missing_role_field', … });
  }
}
```

同一文件在顶层字段处已经修过这个形状（`:552-566`，规则 `null_top_field`，注释原文：
「只查 key 存不存在，不查值。实测六个必填字段全写 null → exit 0。『字段在但值是 null』和
『字段缺失』对下游是同一件事」）。**`ROLE_REQUIRED` 这一段没有跟着修**。

### 探针

`.probe-redteam/c6/round1-core-sweep.md`：sweep 角色的 5 个必填字段全部存在，值是 `null`：

```json
{ "payload": { "slice_id": null, "reachability": "PROD",
               "files_read": ["src/pay.js"], "leads": null, "lead_count": null } }
```

```
$ node tools/check-payload.mjs .probe-redteam/c6/round1-core-sweep.md
  ✅ 契约合规                       EXIT=0
$ node tools/verify-artifacts.mjs --repo .probe-redteam/repo --artifacts .probe-redteam/c6
✓ PASS  [G1] files_read: 1 条路径，0 条不存在；切片覆盖缺 0 条
合计: 0 FAIL / 0 WARN / 2 PASS / 4 SKIP                            EXIT=0
$ node tools/gate.mjs --gate accept --artifact … --role sweep --repo …
  ✓ check-payload
  ✓ verify-artifacts
  ✅ 放行                            EXIT=0
```

`leads: null` + `lead_count: null` 的语义是「这条线索清单不存在」，但它拿到的是合规章。
（若连 `files_read` 也写成 `null`，`verify-artifacts` 会抓 G1；所以只 null 掉
`leads` / `lead_count` / `slice_id` 是**完全不触发任何检查**的组合。）

### 危害

`ROLE_REQUIRED` 是「该角色的 payload 至少要有这些字段」的机械锚。写成 `null` 等于该锚
对下游完全无效：锐评波读 `verdicts` 拿到 null、修复波读 `files_touched` 拿到 null，
而准入闸全绿。审计产物可以被「字段名齐全但内容全空」地交出去。

### 反方意见

- 契约 `output-contract/sweep.md:160` 写 `"generator_ref": "string|null"`，说明**部分**字段
  允许 null。但 `slice_id` / `leads` / `lead_count` / `files_read` 在契约里是
  `"string"` / `[...]` / `0` 等具体类型，没有 `|null`。`artifact_path` 是唯一显式允许 null
  的位置（`sweep.md:130`，且有独立规则 `missing_artifact_path` 管 SUCCESS 时必填）。
  所以「null 合法」不能普遍化。

**置信度：CONFIRMED**

---

## 5. `check-payload` 的 audit 分支只认 `Array.isArray(findings)`：`findings: null / {} / "text" / 42` 全部放行，且门 0 静默跳过

**`tools/check-payload.mjs:851`, `:855`**

```js
const fs4 = Array.isArray(p.findings) ? p.findings : [];   // 非数组 → 空数组
…
if (Array.isArray(p.findings) && p.findings.length === 0) { // ← 只对「空数组」报错
```

`empty_findings` 的注释（`:852-854`）写得很明确：「『没查』和『查了没发现』在契约上必须可
区分，而空数组恰好把两者抹平了，让『什么都不做』成为最省事的通过方式」。但 `findings: null`
比空数组**更省事**，而它绕过了这条判据——因为 `Array.isArray(null) === false`。

`verify-artifacts.mjs:355-360` 的 `findAll(env, 'findings')` 对非数组值同样返回空，
于是门 0 报 `SKIP 产物中没有任何需要门 0 校验的 evidence`。

### 探针

`.probe-redteam/c4/round1-core-audit.md`，`payload.findings: null`（其余字段齐全）：

```
$ node tools/check-payload.mjs …
  ✅ 契约合规                                    EXIT=0
$ node tools/verify-artifacts.mjs --repo … --artifacts .probe-redteam/c4
✓ PASS  [G2] artifact_path: 1 个 SUCCESS 信封，0 个缺路径或文件不存在…
- SKIP  [G0] 产物中没有任何需要门 0 校验的 evidence，跳过
合计: 0 FAIL / 0 WARN / 1 PASS / 5 SKIP          EXIT=0
$ node tools/gate.mjs --gate accept --artifact … --role audit --repo …
  ✓ check-payload
  ✓ verify-artifacts
  ✅ 放行                                        EXIT=0
```

逐个类型实测（`.probe-redteam/c5`）：

```
findings="text" → check-payload: ✅ 契约合规   → gate accept EXIT=0
findings=42     → check-payload: ✅ 契约合规   → gate accept EXIT=0
findings=true   → check-payload: ✅ 契约合规
findings={}     → check-payload: ✅ 契约合规   → gate accept EXIT=0
```

对照：`findings: []` 被正确判 `empty_findings`（gate accept 拒绝）。

**附带发现（同一条根因，另一个方向）**：`payload` 本身写成字符串时，
`k in envelope.payload` 抛 `TypeError`（`check-payload.mjs:688`），
整个校验器崩溃退出 1 并打印 JS 堆栈，而不是报契约违规：

```
$ node tools/check-payload.mjs .probe-redteam/c12/x.md
file:///…/tools/check-payload.mjs:688
    if (!(k in envelope.payload)) {
TypeError: Cannot use 'in' operator …          EXIT=1
```

这正是 `:683` 注释里自己点名的「GT-015/GT-018 那类缺陷在自家工具里的复现」——
上一次修的是原型链键，这次是 `in` 的右操作数不是对象。

### 危害

`audit` 是**整个框架的核心角色**。把 findings 写成 `null`（或任何非数组）比写 `[]` 更省事，
而它同时绕过 `empty_findings` 与门 0 两条防线。一份「什么都没查」的 audit 产物可以
一路拿到「✅ 契约合规 / ✅ 放行」，进入锐评波时则没有任何 finding 可供攻击。

### 反方意见

- 契约没有显式说「findings 必须是数组」——但 `audit.md:163` 的 JSON 骨架写的是 `"findings": [`，
  `:235` 写「`findings` 仍然必须包含**至少一个条目**」，`:215` 把 `status` 定义为「`payload.findings`
  数组内的条目状态」。语义上「数组」是隐含但明确的。
- 若要论证「这不是缺陷」，最可能的依据是「非数组会在下游崩掉，所以不必在这查」。
  但实测下游不崩：`verify-artifacts` 对它报 SKIP、`gate accept` 报放行。

**置信度：CONFIRMED**

---

## 6. `check-handoff --dir` 静默不递归：子目录里的 packet 不进分母，也不留任何痕迹

**`tools/check-handoff.mjs:163-165`**

```js
targets = readdirSync(ARGS.dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => join(ARGS.dir, f));
```

`readdirSync` 的顶层列举不包含子目录内容，且这里没有任何「有子目录」的提示。
对照同仓库里做对了的实现：`check-fix-artifacts-envelope.mjs:272-278`（`subdirectory_not_scanned`
WARN）与 `check-disposition-coverage.mjs:235-243`（`artifacts_contain_subdirectories` configError），
两处的注释都解释了「子目录不进分母 = 凭空白名单」。`check-handoff` 缺这一段。

### 探针

```
.probe-redteam/handoff/
  good.json                 ← 完全合规的 packet
  round1/broken.json        ← { "this": "is not a handoff packet at all" }
```

```
$ node tools/check-handoff.mjs --dir .probe-redteam/handoff
Resume Packet 校验（1 份）

  ✓ good.json

  ✅ 全部合规                        EXIT=0
```

`round1/broken.json` 全文没出现在任何输出里。把同一份 `broken.json` 挪到顶层：

```
$ node tools/check-handoff.mjs --dir <顶层含 broken.json>
  ✗ broken.json  [missing_field] …  ✗ 6 项违规
```

### 危害

`handoff-schema.md:10` 把 Resume Packet 定义为「主Agent在波次之间传递状态的**唯一序列化格式**」。
按轮次分目录（`out/round1/packet.json`、`out/round2/packet.json`）是最自然的组织方式，
而那种组织下这个校验器的分母恒为 0 或只含顶层零散文件。更糟的是：**分母非 0 时**（顶层
有一个合规 packet）它会报「✅ 全部合规」，而不像「顶层为空」那样报 exit 2。

### 反方意见

- `handoff-schema.md:32` 只写了「`--dir <产物目录>`」，没规定目录结构。若预期用法是
  「一个目录只放一份 packet」，那么不递归是合理的。
- 但同仓库两个同类工具都明确把「子目录不扫」升级为可见警告/配置错误，并写下了理由。
  这里的不一致本身就是缺陷信号——不是「设计不同」，是「同一个教训只应用到了 3 个工具里的 2 个」。

**置信度：CONFIRMED**

---

## 7. `check-rule-doc-link` 的规则抽取只认 `rule: '...'` 对象字面量：约 59 条真实规则对它完全不可见，而它报「✅ 每条规则都能在契约里找到落点」

**`tools/check-rule-doc-link.mjs:85`**

```js
for (const m of code.matchAll(/rule:\s*['"]([a-z0-9_]+)['"]/g)) {
```

框架里的规则名有两种书写约定。`check-payload.mjs` 用对象字面量
（`{ rule: 'x', msg: … }`，111 处），其余工具用**位置参数**：

- `fail('disposition_missing_reason', …)` / `warn('capability_unknown', …)` / `rFail(…)`
- `err('report.is_complete', 'closed_but_incomplete', …)` / `E('bad_wave_id', 'wave_id', …)`

后一种一个都抽不到。同一个正则也存在于 `check-rule-ledger.mjs:122`（同样是分母）。

### 探针（镜像，不是推断）

`.probe-redteam/dl/` 镜像了 `check-rule-doc-link.mjs` 的目录结构：
`tools/` 下放两个工具，一个是对象字面量样式（规则名在文档里），一个是位置参数样式
（规则名 `positional_style_rule_nowhere_in_docs` 在文档里**一个字都没有**）：

```
$ node .probe-redteam/dl/tools/check-rule-doc-link.mjs
  校验器规则     1 条
  有落点         1
  无落点         0
  ✅ 每条规则都能在契约里找到落点        EXIT=0
```

那 1 条是合规的那个；位置参数样式的规则**整条不在分母里**。

对真实仓库的量化（`.probe-redteam/rule-gap5.mjs`，纯静态统计，不改任何文件）：

```
=== check-rule-doc-link 的分母 ===
它能看见的规则（只认 rule: {...} 字面量）: 107

=== 它完全看不见的规则名（位置参数约定）===
数量: 75
其中在 framework/**/*.md 里一次都没出现（按它自己的 D1 判据 = 应当 FAIL）: 59

抽样：
  artifact_without_envelope        ← tools/check-fix-artifacts-envelope.mjs
  finding_without_disposition      ← tools/check-disposition-coverage.mjs
  files_touched_underreported_by_harness ← tools/check-files-touched-harness.mjs
  closed_but_incomplete            ← tools/check-state.mjs
  bad_wave_id                      ← tools/check-handoff.mjs
  …
```

三次 `grep -rl <规则名> framework/` 均返回空，确认这三条在主契约里确实一字未提。

真实工具的输出：

```
$ node tools/check-rule-doc-link.mjs
  校验器规则     107 条
  有落点         107
  无落点         0
  ✅ 每条规则都能在契约里找到落点        EXIT=0
```

### 危害

这个工具存在的全部理由（`:5-17`）是：「这个框架反复出同一个 bug：**校验器比契约严**……
结果是子 Agent 照契约写会被判违规，且修法提示指向一段不存在的规范」。它现在对
**接近一半的真实规则**（59 / 166）完全不执行这件事，同时输出「✅ 每条规则都能找到落点」。
`artifact_without_envelope` 是其中最贵的一条：它是「没有信封 = 未被任何机械检查观测到 = 未交付」
这条纪律的规则名，契约里没写，而工具报「每条规则都有落点」。

### 反方意见

- 工具的文件头（`:28-34`）把自己的检查项写成 D1/D2，并把输出统计定义成 `校验器规则`。
  可以主张「它只声称覆盖它抽到的那些」，不声称覆盖全部。但输出末行的措辞是
  **「每条规则都能在契约里找到落点」**——「每条」是全集断言，而分母只含 107/166。
- 这也是 CSS 分析里最常见的「正则做语法分析」缺陷，修复成本低（两条额外正则），
  存量 59 条是否 FAIL 是策略问题，**但把分母写对不是策略问题**。

**置信度：CONFIRMED**（镜像探针证明了机制；真实仓库的 59 是静态统计，未逐条造探针）

---

## 8. `check-deliverables` 的 D3 账本四节检查仍用「包含」判据：四个节塞进同一个标题仍判「必备齐全」

**`tools/check-deliverables.mjs:226-233`**

```js
const headings = [...ledgerText.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1]);
const missing = required.filter((r) => !headings.some((h) => h.includes(r.key)));
```

同一文件的 **D2**（最终报告七节，`:140-161`）在 2026-11-14 已修成「每节独占一个标题、一个
标题只满足一个节」，并在注释里写下了实测：「把七个关键词塞进同一个标题即判『七节齐全』，
一个标题承载七个节，报告实际上只有一节」。**D3 用的是被 D2 抛弃的那套判据**。

### 探针

`.probe-redteam/deliv/round1/round1-ledger.md` 全文：

```markdown
# round1 账本

## 1. 切片状态表 2. 预算 3. 失败分类 4. 裁量日志

（本节没有任何实际内容——所有四节被塞进一个标题里）
```

```
$ node tools/check-deliverables.mjs --round-dir .probe-redteam/deliv/round1
✓ [D2] 最终报告七节齐全（7 个二级标题）
✓ [D3] 账本四节必备齐全（第四节轮次链为可选）      ← 实际只有 1 个标题
合计: 0 FAIL / 0 WARN / 8 PASS                      EXIT=0
```

对照（`.probe-redteam/deliv2`，同样手法用在 D2 上）：D2 正确报
`✗ [D2] 最终报告缺节: 1. 元信息 / 2. 覆盖说明 / …`。

### 危害

`report-naming.md:208` 把「`round{N}-ledger.md` 五节齐全」列为交付完成的判定条件之一，
而 `--gate close` 直接调用 `check-deliverables`。一份只有标题、没有内容的账本能过收口门。
这是「D2 已修、D3 未修」的**回归缺口**，不是新设计。

### 反方意见

- D3 少了 D2 的 `stuffers` 检测（「一个标题里塞了多个节关键词 → 明确报出来」）。
  可以主张账本节比报告节宽松是有意的；但同一份文件里对同类对象用两套判据、
  且被抛弃的那套正是已知有缺陷的那套，很难论证是设计选择。
- 另一个 D3 的缺口（未构造探针，属推断）：`required` 只有 4 项，而 `report-naming.md:189-193`
  定义了 5 节（第 4 节裁量日志 + 第 5 节轮次链）。代码注释与输出都写「第四节轮次链为可选」，
  给出了明确理由（「若自动续轮」），因此**这一项不算缺陷**。

**置信度：CONFIRMED**

---

# 二档 · 只会误报不合规

## 9. `verify-artifacts` 深度限制 `depth > 3`：第 4 层以后的产物完全不计入分母，报「0 FAIL / 1 PASS」

**`tools/verify-artifacts.mjs:995`**

```js
const walk = (dir, depth = 0) => {
  if (depth > 3) return;
```

### 探针

`.probe-redteam/art-deep2/`：

```
art-deep2/good.md              ← 合规 audit 产物（门 0 1/1 通过）
art-deep2/a/b/c/d/bad.md       ← 完全没有 JSON 信封的产物
$ node tools/verify-artifacts.mjs --repo .probe-redteam/repo --artifacts .probe-redteam/art-deep2
扫描产物: 1 个文件，解析出 1 个信封
✓ PASS  [G0] 门 0 回显: 1/1 通过
合计: 0 FAIL / 0 WARN / 1 PASS / 5 SKIP                            EXIT=0
```

同一份 `bad.md` 挪到 `.probe-redteam/art-deep3/a/b/c/bad.md`（深度 3，未触发截断）：

```
扫描产物: 2 个文件，解析出 1 个信封
✗ FAIL  [G7] 产物没有 JSON 信封: a\b\c\bad.md
合计: 1 FAIL / 0 WARN / 1 PASS / 5 SKIP                            EXIT=1
```

深度差异**一字未改内容**，EXIT 从 1 变 0。

### 危害 / 排序理由

排在二档（而非一档）是因为：契约 `report-naming.md:106` 明确「不得建子目录」、
`evidence-policy.md` 与两个同类工具都把子目录视为异常。所以真实审计产物**按契约**是扁平的，
深度限制在合规场景下不会漏东西。

但它仍是缺陷：`art-deep2` 的 `scanned.length === 1`，报告没说「有 2 个文件、1 个被深度截断」。
`scanned` 只 push 进扫描循环的项（`:1072`），被 `depth > 3` 挡掉的文件连计数器都不经过。
这与本报告第 2 条（后缀过滤）是同一形状——**分母缩小不留痕**。

### 反方意见

- 深度限制很可能是有意的（防止意外把 `.git/objects` 之类大目录拖进来）。
- 但对比同一文件里对超大文件的处理（`:1099-1105`，`oversized` 数组 + 显式 WARN：
  「N 个文件超过 8MB 未做门 0 校验……这些文件里的 quote 一条都没被验证过」），
  说明作者已经知道「跳过必须留痕」这条纪律。深度截断没跟上。

**置信度：CONFIRMED**

---

## 10. 小写状态值让证据检查整条消失（门 0 静默跳过），但 `check-payload` 会抓——只有 `gate accept` 无 `--repo` 时才致命

**`tools/verify-artifacts.mjs:392-403`**

```js
const NO_EVIDENCE = ['NO_EVIDENCE_FOUND', 'UNREADABLE', 'EVIDENCE_GAP'];
if (NO_EVIDENCE.includes(ST)) continue;         // 合法空证据，不参与门 0
…
if (!hasFile || !hasQuote) {
  if (CLAIMS_EVIDENCE.includes(ST) || !ST) {    // ← 'confirmed' 既不在 CLAIMS 也不在 NO_EVIDENCE，且 ST 非空 → 静默跳过
```

`ST` 是 finding 的 `status`。三个集合（`CONFIRMED`/`GATE_0_FAILED` vs `NO_EVIDENCE_FOUND`/
`UNREADABLE`/`EVIDENCE_GAP`）都是**大小写敏感**的字面量比较。写 `"confirmed"` 时：
`NO_EVIDENCE.includes('confirmed')` = false（不 skip），`CLAIMS_EVIDENCE.includes('confirmed')` = false
（且 `ST` 非空），于是 `if (!hasFile || !hasQuote)` 整个分支不进入，`checked` 不增加——
**这条 evidence 对门 0 不存在**。

### 探针

`.probe-redteam/c2/bad.md`：`status: "confirmed"`、`severity: CRITICAL`、
evidence 只有 `{file, line}` **没有 quote**：

```
$ node tools/verify-artifacts.mjs --repo .probe-redteam/repo --artifacts .probe-redteam/c2
- SKIP  [G0] 产物中没有任何需要门 0 校验的 evidence，跳过
合计: 0 FAIL / 0 WARN / 1 PASS / 5 SKIP
```

对照（同一份，`status` 改成 `CONFIRMED`）：

```
✗ FAIL  [G0] evidence 缺 quote：status=CONFIRMED 的发现必须有 file:line + quote
合计: 2 FAIL / 0 WARN / 0 PASS / 5 SKIP
```

### 危害 / 排序理由

排在二档是因为 `check-payload.mjs:873-880` 有 `invalid_finding_status`，会正确拒绝
`"confirmed"`。只有绕过 `check-payload` 的调用路径（即第 3 条的 `gate accept` 无 `--repo`）
才会真正放行。但它仍是「early continue 让后续检查全部不发生，且结果计成 SKIP 而非 FAIL」的
教科书形态，且 `SKIP` 的措辞（「产物中没有任何需要门 0 校验的 evidence」）在源文件里
**是假的**——有 evidence，只是被静默排除了。

### 反方意见

- `check-payload` 已经拦住了，`gate accept` 默认也会调它。所以单一工具的这个缺口在
  完整调用链下不致命。
- 但「靠另一个工具兜底」不构成设计理由，尤其当本报告第 3 条证明那个兜底可以被一个
  缺参数绕开。

**置信度：CONFIRMED**

---

# 三档 · 只影响统计数字

## 11. `stop-hook` 与 `check-fix-artifacts-envelope` 的产物 pattern 口径不一致：`fix-*.md` 在前者计入分母、在后者被当成 0 份

**`tools/stop-hook.mjs:575`** vs **`tools/check-fix-artifacts-envelope.mjs:110`**

```js
// stop-hook.mjs:573-575（注释明写「口径必须一致」）
// 待检产物口径必须与 check-fix-artifacts-envelope.mjs 的默认 pattern 一致
const patternRes = [/^done-.*\.md$/i, /^.*-fix-.*\.md$/i, /^fix-.*\.md$/i];
// check-fix-artifacts-envelope.mjs:110
const DEFAULT_PATTERNS = ['done-*.md', '*-fix-*.md'];
```

`stop-hook.mjs:573` 的注释原文：「待检产物口径必须与 check-fix-artifacts-envelope.mjs 的
默认 pattern 一致（done-*.md 与 *-fix-*.md），否则两套工具会对同一目录给出不同分母」，
紧接着 575 行补了第三个 pattern `fix-*.md`——**注释与代码互相矛盾，且代码是那个与注释
不一致的版本**。对外的 `check-fix-artifacts-envelope.mjs` 仍是两个 pattern。

### 探针

`.probe-redteam/fixdir/`：`done-1.md`（合规）+ `fix-2.md`（**完全没有 JSON 信封**）

```
$ node tools/check-fix-artifacts-envelope.mjs --dir .probe-redteam/fixdir
pattern: done-*.md *-fix-*.md
  ✓ done-1.md
结果: 1 份产物 / 0 FAIL / 0 WARN                      EXIT=0     ← fix-2.md 消失

$ node tools/check-fix-artifacts-envelope.mjs --dir .probe-redteam/fixdir --pattern 'fix-*.md'
结果: 1 份产物 / 1 FAIL / 1 WARN
其中 1 份没有信封: fix-2.md                           EXIT=1     ← 加上 pattern 后它能抓到
```

**端到端复现（这条最要紧）**——`.probe-redteam/hook4/`，state.json 为 `phase: wave4`、
`fix_contracts` 非空、`target_repo` 指向真实目录，目录放 `done-1.md`（合规 WONT_FIX）
+ `fix-2.md`（无信封）：

```
$ echo '{}' | node tools/stop-hook.mjs --state .probe-redteam/hook4/state.json
[产物信封检查 · 告警（不阻断）]
1. WARN · 未做双向对账…（与信封无关）
                                                                   EXIT=0
$ grep -c 'fix-2' <stdout> <stderr>
stdout: 0
stderr: 0                       ← fix-2.md 全文未出现一次
```

`stop-hook` 自己的分母（`:575`）**包含** `fix-2.md`，所以它没被「目录里 0 份产物」拦下；
但它把 `--dir` 交给 `check-fix-artifacts-envelope.mjs`，后者用两个 pattern 的数，
**看到的只有 `done-1.md`**。因此「没有信封 = 未交付」这条硬 FAIL 在这份产物上一次都没触发。

### 危害 / 排序理由

**这条的严重性其实更接近一档**：`fix-*.md` 是一个合法命名（`check-fix-artifacts-envelope.mjs:57`
自己的 `NAME_CONFORMING` 正则就认 `^done-[^/]*\.md$`，而 stop-hook 的 `fix-*.md` 是 R15
为了覆盖 `fix-1.md` 这种「最朴素的名字」补进来的）。写出一份 `fix-2.md` 就能让信封闸门
静默漏过它。我把它放在三档只是因为**触发条件需要一个特定文件名**（`fix-N.md` 而非
`round{N}-04-fix-N.md`），而契约 `report-naming.md` 的规范命名是后者。

### 反方意见

- 可以用 `--pattern` 显式补齐（探针已证明）。但 `stop-hook` 调用时**不传 `--pattern`**
  （`:721-724` 只有 `--dir` 和 `--json`），所以集成层永远走默认口径。
- 这条也可能是「stop-hook 先改了、检查器没跟上」的半完成修改——不管哪种，两者现在不一致。

**置信度：CONFIRMED**

---

## 12. `stop-hook` 只处理 `level === 'FAIL'` 的问题项：检查器报的 CONFIG 级错误被完全丢弃

**`tools/stop-hook.mjs:740`**

```js
for (const f of (parsed.problems ?? [])) {
  if (f.level !== 'FAIL') continue;      // ← CONFIG 被跳过
```

`check-fix-artifacts-envelope.mjs:172-175` 的 `configError` 以 `level: 'CONFIG'` 记录并
`exit 2`。`stop-hook.mjs:726-728` 在 `execFileSync` 抛异常时从 `e.stdout` 里把 JSON 捞回来
（所以 `parsed` 非 null），然后上面那行丢掉所有非 FAIL 项。

### 探针

`.probe-redteam/hook3/round1/` 只放 `fix-2.md`（无信封）。检查器单独跑：

```
$ node tools/check-fix-artifacts-envelope.mjs --dir .probe-redteam/hook3/round1 --json
{ "problems": [ { "level": "CONFIG", "rule": "no_fix_artifacts",
    "msg": "… 选中 0 个文件。「每份都有信封」在 0 份上恒为真——这是配置错误，不是通过。…" } ],
  "exitCode": 2 }                                     EXIT=2
```

`stop-hook` 拿到这段 JSON，输出里**没有任何 no_fix_artifacts / CONFIG / 配置错误**字样：

```
$ echo '{}' | node tools/stop-hook.mjs --state .probe-redteam/hook3/state.json
[产物信封检查 · 告警（不阻断）]
1. WARN · 未做双向对账…（与信封无关）                    EXIT=0
```

对照：目录里同时放 `done-9.md`（无信封）时，`artifact_without_envelope` 是 FAIL，
stop-hook 正确报 `有 1 份修复产物没有可用的信封 … done-9.md`。

### 危害

检查器自己把「0 份选中」定义成「配置错误，**绝不等于通过**」。集成层把它读成「没有 FAIL
所以没问题」。这就是 `check-fix-artifacts-envelope.mjs` 文件头（`:37-38`）写的那句话
（「`no_fix_artifacts` pattern 选中 0 个文件 exit 2（**配置错误，绝不等于通过**）」）
在集成层被撤销了。

不过它只在「目录里没有任何 pattern 命中的文件」时触发，而这种情况 `stop-hook` 在
`:611-645` 已经有独立的「空目录 → `problems.push`」判据（`in_flight` 空时拒绝闭合）。
所以实际影响被另一条判据覆盖了大部分。**这是它排在三档、以及我只标 PLAUSIBLE-adjacent
的原因**——但这个 CONFIG-丢弃代码一旦被复用到别的检查器，就会成为一个通用的静默放行口。

### 反方意见

- 上面自己给出了反方论证：空目录已被另一条判据拦住，实际不可利用。
- 严格说这条是**真实的代码缺陷**（同一个 JSON 里 CONFIG 被丢）但**当前不可利用**。
  我按「危害」排序而非「代码有多丑」排序，所以放三档。

**置信度：CONFIRMED（机制） / 危害当前被覆盖（不可利用）**

---

## 13. 门 0 的 evidence 收集只认 `evidence` 与 `leads` 两个键名，且 must be 数组；其他形态静默不进分母

**`tools/verify-artifacts.mjs:355-360`**

```js
const evidences = [
  ...findAll(env, 'evidence'),
  ...findAll(env, 'leads').flatMap(({ path, value }) =>
    Array.isArray(value) ? value.map((l) => ({ path, value: l })) : []),
];
```

`findAll(env, 'evidence')` 会递归找到 `evidence` 键（键名固定）。`leads` 分支要求
**值必须是数组**——`leads: {}` 或 `leads: null` 时 flatMap 返回空数组，整条 sweep 的证据
链静默消失。

### 探针

`.probe-redteam/payload2/sweep-leads-obj2.md`：`leads: {}`、`lead_count: 0`、
`files_read: []`、`dimension_histogram: {}`

```
$ node tools/check-payload.mjs .probe-redteam/payload2/sweep-leads-obj2.md
  role: sweep   status: SUCCESS
  ✅ 契约合规                                    EXIT=0
```

（注：这一条与第 4 条部分重叠——`leads` 的类型错没有被 `ROLE_REQUIRED` 抓到是因为它只查
key 存在；`leads: {}` 被当成「有 this key」而通过。）

### 危害

本质是第 4 条（不查值）与第 5 条（不查类型）在 sweep 角色的同一次重现。我单列它是为了
指出**门 0 的抽取面本身是白名单**：任何不叫 `evidence` / 不叫 `leads` 的证据字段都不进分母。
例如契约 `sweep.md:160` 的 `files_unreadable`，或 `audit.md` 的 `runtime_evidence`
（`check-payload.mjs:1293` 引用了它，`verify-artifacts` 完全不看）——
它们的 quote 内容永远不会被门 0 验证。

### 反方意见

- `evidence` / `leads` 是契约里唯一两个承载 `(file, line, quote)` 三元组的位置，
  所以「只认这两个键」有契约依据。
- 但 `runtime_evidence` 里也有 `observed`（原始输出），`verify-artifacts` 不看它——
  这一项已在 `check-payload.mjs` 里由独立规则管（`runtime_no_output` 等），
  所以「门 0 不看它」可能是有意的分工。我把它放三档并且**不声称这是可利用缺陷**。

**置信度：PLAUSIBLE**（`leads: {}` 全绿是 CONFIRMED；「其他键名也漏」是代码推断，未逐个造探针）

---

## 14. `check-blindspots` / `check-promises` 只扫 `.js/.mjs/.cjs/.ts`：对 Java 目录报「0 个文件」+ EXIT 0

**`tools/check-blindspots.mjs:40`** / **`tools/check-promises.mjs:38`**

```js
} else if (['.js', '.mjs', '.cjs', '.ts'].includes(extname(e.name))) {
```

### 探针

`.probe-redteam/java/Q.java` 有 B1 形态（`return this.items[i];` 返回内部数组元素）：

```
$ node tools/check-blindspots.mjs .probe-redteam/java
盲区模式检查: 0 个文件

  未命中 B1/B2/B3/B4 四种形态

  ⚠ 这**不等于**「没有缺陷」。
     实测：某代码库有 8 条真缺陷（含 XSS、原型污染、二次转义），本工具 0 命中。
     本工具只认这四种具体代码形态，不具备通用性。            EXIT=0
```

### 危害 / 反方意见

这个工具的输出**主动否认了**自己的覆盖面（「0 个文件」+「这不等于没有缺陷」+ 明确说
只认这四种形态），而且它的 B1/B2/B3 规则本身就用 JS 语法（`this.#private`、`Number.isFinite`）。
所以「只扫 JS」是**与工具自述一致的设计**，不是静默缩小范围。

但框架的被审对象包括 Java 仓库（`experiments/hilltop-dsh/probes/ExplodeProbe.java`、
`field-test-1/evidence-snapshot/.../*.java` 都是真实被审对象）。在那种仓库上跑
`check-blindspots` 会得到「0 个文件 / EXIT 0」，而 `wave2-audit.md:745` 把它列为
「配套工具」推荐使用——**推荐语没有「只对 JS/TS 有效」的限定**。

严格按「是否静默」判定：**不算缺陷**（工具自述完整）。按「是否让人误读」判定：
「0 个文件」这个数字太容易被当成「跑过了、没问题」。我把它列入三档并明确标为**设计正当**，
只为提示后续的人：这一条不该拿去当成缺陷修，该修的是 `wave2-audit.md:745` 的推荐措辞。

**置信度：CONFIRMED（行为） / 判定：正当设计**

---

# 未证实 / 已排查但不构成缺陷

以下是查过、构造过探针、最终**判定不是缺陷**的项。列出来是为了让后续复核者不必重跑。

| 候选 | 结论 | 依据 |
|---|---|---|
| `check-deliverables.mjs:79` 用 `readdirSync` 只看顶层找 `round*-final-report.md` | 正当 | `report-naming.md:106` 明确「不得建子目录」；且这是兜底推断路径，`--round-id` 可显式指定 |
| `check-fix-instances.mjs:494` `depth > 6` | 正当（暂无探针） | 限制远大于契约要求的扁平结构；且它是 `ref` 解析的兜底路径。**未构造探针**，不声称 |
| `lint-autonomy.mjs:39-46` / `lint-terminology.mjs:120` 只扫 `.md` | 正当 | 这两个工具的目标对象就是契约文档本身，契约全是 `.md` |
| `check-rule-ledger.mjs:150-165` `collectDocs` 跳过 `examples/` | 正当，且有注释 | 「那是校验器自己验证的生成物，不是规范」 |
| `verify-postfix-snapshot.mjs:180` 未跟踪目录展开上限 20000 | 正当 | 触上限时显式 WARN「双向对账**只覆盖了一部分**……不是通过」 |
| `stop-hook.mjs:822-846` 超过 50 份只查前 50 | 正当 | 显式 WARN「只检查了前 50 份……被跳过的 N 份的字段合规性本轮无答案」 |
| `check-fix-artifacts-envelope.mjs:272-278` 子目录不扫 | 正当 | 显式 `subdirectory_not_scanned` WARN + 文件头解释了「子目录不递归是刻意的」 |
| `check-disposition-coverage.mjs:235-243` 子目录 | 正当 | `configError` 直接 exit 2，理由「子目录里的产物不会进分母，等于凭空白名单」 |
| `check-disposition-coverage.mjs:247` 用 `/gi` 正则（大小写不敏感） | 比 `check-payload`/`verify-artifacts` 更宽容 | 同一个 ```` ```JSON ```` 产物：`check-disposition-coverage` 能解析，`check-payload` / `verify-artifacts` 报 `no_json_envelope`。这是**二档方向**（误报不合规），已在第 1 条的反方意见里提到；未单列为独立缺陷因为触发它需要 agent 写出非规范围栏 |
| `check-enum-consistency.mjs:60-72` `values` 解析 | 已处理布尔混合 | 注释与探针均确认「不能把它们过滤掉」 |
| `verify-artifacts.mjs:1085-1095` 空产物目录 | 已修 | 探针确认会 FAIL `G0`「一份可用产物都没有」 |

---

# 汇总

| # | 缺陷 | 位置 | 档 | 置信度 |
|---|---|---|---|---|
| 1 | 尾逗号容错改写 quote，门 0 双向失真 | `tools/verify-artifacts.mjs:204-208` | 一 | CONFIRMED |
| 2 | 只扫 `.md`，`.json`/`.txt` 不进分母（含 disposition-coverage） | `tools/verify-artifacts.mjs:1001`<br>`tools/check-disposition-coverage.mjs:224` | 一 | CONFIRMED |
| 3 | `gate accept` 无 `--repo` 就完全跳过门 0 且报「✅ 放行」 | `tools/gate.mjs:141-147` | 一 | CONFIRMED |
| 4 | `ROLE_REQUIRED` 只查 key 不查值，必填字段全 `null` 判合规 | `tools/check-payload.mjs:687-693` | 一 | CONFIRMED |
| 5 | `findings` 非数组全放行（`null`/`{}`/`"text"`/`42`），门 0 静默 SKIP | `tools/check-payload.mjs:851-862` | 一 | CONFIRMED |
| 6 | `check-handoff --dir` 不递归，子目录 packet 不进分母且不留痕 | `tools/check-handoff.mjs:163-165` | 一 | CONFIRMED |
| 7 | 规则抽取只认 `rule:` 字面量，约 59 条真实规则不可见，仍报「每条都有落点」 | `tools/check-rule-doc-link.mjs:85`<br>`tools/check-rule-ledger.mjs:122` | 一 | CONFIRMED |
| 8 | D3 账本四节仍用「包含」判据，四节塞一标题判齐全 | `tools/check-deliverables.mjs:226-233` | 一 | CONFIRMED |
| 9 | `depth > 3` 截断不留痕 | `tools/verify-artifacts.mjs:995` | 二 | CONFIRMED |
| 10 | 小写状态值让 evidence 静默退出门 0 分母 | `tools/verify-artifacts.mjs:392-403` | 二 | CONFIRMED |
| 11 | `fix-*.md` 在 stop-hook 计入分母、在信封检查器被当 0 份 | `tools/stop-hook.mjs:575`<br>`tools/check-fix-artifacts-envelope.mjs:110` | 三（近一） | CONFIRMED |
| 12 | stop-hook 丢弃 CONFIG 级问题项 | `tools/stop-hook.mjs:740` | 三 | CONFIRMED（不可利用） |
| 13 | 门 0 的 evidence 抽取面是键名白名单；`leads` 非数组即静默消失 | `tools/verify-artifacts.mjs:355-360` | 三 | PLAUSIBLE |
| 14 | blindspots/promises 只扫 JS/TS，对 Java 报 0 个文件 | `tools/check-blindspots.mjs:40`<br>`tools/check-promises.mjs:38` | 三（**设计正当**） | CONFIRMED |

确认缺陷 **13 条**（第 14 条明确判定为正当设计，不计入）。

其中一档 8 条：**每一条都有实跑的 EXIT 从「应当 1」变成「0」的证据**，且都不是「只读代码推断」。
第 7 条的镜像探针证明了机制，真实仓库的 59 条是静态统计——这一点在条目内已标注。
