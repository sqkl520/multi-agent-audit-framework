# FIX-R9 报告 · 堵 R7「洞 2」：HIGH 填 `WONT_FIX` 可以洗掉 `high_severity_unaccounted` 警告

**任务**：修复 R7 报告 §4「洞 2」——8 条 HIGH 全填 `WONT_FIX`（理由够长）后，`high_severity_unaccounted` 完全不触发，连 `--strict-high` 也救不回来。
**日期**：2026-11-15
**改动范围**：只改 `tools/check-disposition-coverage.mjs` 和 `tools/check-disposition-coverage.test.mjs`。未碰其他文件，未 commit。

| 文件 | 状态 | 变化 |
|---|---|---|
| `tools/check-disposition-coverage.mjs` | 修改 | 新增 2 条规则 + `totals` 两个字段 + 结论文案 |
| `tools/check-disposition-coverage.test.mjs` | 修改 | 新增 case 23–30（42 条断言），原有 60 条不变 |
| `experiments/hilltop-dsh/FIX-R9-report.md` | 新建 | 本文 |

**验证**：`check-disposition-coverage.test.mjs` **102 通过 / 0 失败**（原有 60 + 新增 42）；`check-all.mjs` **✅ 全部通过，exit 0**（其中「发现去向对账」102/102、「修复实例对账」160/160）。

**关于 `fix-phase-e2e.test.mjs`（R7 的文件）**：改动刚落地时它是 **48/48 全过**。收尾复查时变成 **45 通过 / 3 失败**——3 条失败全部是 `[R6/check-fix-instances]` 的 `verdict_ref_not_found`：并行 agent 在我工作期间给 R6 加了一条「裁决索引表『出处』指向的文件必须存在」的新规则，而 R7 的 fixture 里没有那个 `round1-03-critique-arbiter.md`。这是并行改动与 R7 fixture 之间的冲突，**不在我的两个文件里，我按任务要求没有去修**（R6 自己的自测此刻是 160/160 全过，check-all 也全绿，说明这是 fixture 缺文件而不是 R6 坏了）。

---

## 一、失败测试先行（改代码前）

### 1.1 新增的 8 个用例

| case | 场景 | 关键断言 |
|---|---|---|
| 23 | 8 条 HIGH 全 `WONT_FIX`（理由够长） | 默认 exit 0 / WARN；**逐条点名 8 个 id**；消息含理由摘录；`highWontFix: 8` |
| 24 | 8 条 HIGH 全 `DEFERRED` | 仍报 `high_severity_unaccounted`，计数仍 8（既有行为不变） |
| 25 | HIGH 填 `FIXED` | 两条 HIGH 规则都不报 |
| 26 | HIGH 填 `WONT_FIX` 但理由 < 10 字 | 同时报 `disposition_missing_reason` **和** `high_severity_wont_fix` |
| 27 | 同 case 23 + `--strict-high` | exit 1，规则升级为 FAIL |
| 28 | HIGH 的 `WONT_FIX` 理由 ≥10 但 <40 字 | 额外报 `high_wont_fix_reason_thin`（WARN） |
| 29 | MEDIUM/LOW 填 `WONT_FIX` | 不触发 HIGH 专属规则（门槛只对 HIGH 抬高） |
| 30 | 人读输出 | 必须出现 `high_severity_wont_fix` + id + 结论里的 `WONT_FIX` 字样 |

### 1.2 改代码前的失败信息（原文）

`node tools/check-disposition-coverage.test.mjs`：

```
=== 结果: 76 通过 / 26 失败 ===
```

其中 case 23 的原文（这是洞 2 的形状——`problems` 是空数组，`highUnaccounted` 是 0）：

```
case 23: 8 条 HIGH 全填 WONT_FIX（理由够长）→ 默认 WARN，且必须逐条点名
  ✓ 退出码 0（WARN 不阻断）
  ✗ 报 high_severity_wont_fix — []
  ✗ 级别是 WARN 而非 FAIL
  ✗ 计数 = 8 — undefined
  ✗ 逐条点名 round1-core::F1
  ✗ 逐条点名 round1-core::F2
  ✗ 逐条点名 round1-core::F3
  ✗ 逐条点名 round1-core::F4
  ✗ 逐条点名 round1-core::F5
  ✗ 逐条点名 round1-core::F6
  ✗ 逐条点名 round1-core::F7
  ✗ 逐条点名 round1-core::F8
  ✗ 消息里带理由摘录（读者能判断，而不是只看到个数） — undefined
  ✗ 解释为什么 WONT_FIX 要单开一条规则 — undefined
  ✗ totals.highWontFix = 8 — {"findings":8,"rawFindings":8,"accounted":8,"unaccounted":0,"newFindings":0,"high":8,"highUnaccounted":0,"severity":{"HIGH":8}}
  ✓ WONT_FIX 不混进 high_severity_unaccounted
```

case 27（`--strict-high` 下仍然 exit 0 —— 正是 R7 记录的那一行）：

```
case 27: --strict-high 把 HIGH 的 WONT_FIX 从 WARN 升级为 FAIL
  ✗ 退出码 1 — 实际 0 / \ADMINI~1\AppData\Local\Temp\dc-test-cJHQxv\out",
  "ledger": "C:\\Users\\ADMINI~1\\AppData\\Local\\Temp\\dc-test-cJHQxv\\ledger.md",
  "ledgerRows": 8,
  "totals": {
    "findings": 8,
    "rawFindings": 8,
    "accounted": 8,
    "unaccounted": 0,
    "newFindings": 0,
    "high": 8,
    "highUnaccounted": 0,
    "severity": { "HIGH": 8 }
  },
  "problems": [],
  "exitCode": 0
}
```

`problems: []` 是全绿。8 条 HIGH 一句话集体消失，这就是 R7 的 `HOLE-2`。

### 1.3 独立复核（不是同一进程内的断言）

用 `git stash` 把**只有** `check-disposition-coverage.mjs` 回退到改前版本，跑同一份新测试：

```
=== 结果: 76 通过 / 26 失败 ===     ← 改前
--- restored ---
=== 结果: 102 通过 / 0 失败 ===     ← 改后
```

失败→转绿闭环成立，且 26 条失败全部由本次改动消除。

---

## 二、改前 / 改后的判据（逐字）

### 2.1 改前 · §6 的判据

`tools/check-disposition-coverage.mjs`（改前，第 605–626 行）：

```js
const highUnaccounted = [];
for (const [key, f] of findingsByKey) {
  if (f.severity !== 'HIGH') continue;
  const rowKey = key;
  const isDeferred = deferredKeys.has(rowKey);
  const isMissing = !covered.has(rowKey);
  if (isDeferred || isMissing) {
    highUnaccounted.push({ key, severity: f.severity, why: isMissing ? '无 disposition' : 'DEFERRED' });
  }
}

if (highUnaccounted.length > 0) {
  const lvl = ARGS.strictHigh ? 'FAIL' : 'WARN';
  const msg = `${highUnaccounted.length} 条 HIGH 处于 DEFERRED / 无去向：`
    + highUnaccounted.map((h) => `${h.key}（${h.why}）`).join('、')
    + '——HIGH 暂缓不是非法，但必须有人看见；'
    + '全部填 DEFERRED 能让覆盖率 100%，却让最该修的 HIGH 继续留在线上';
  add(lvl, 'high_severity_unaccounted', msg, {
    high_unaccounted: highUnaccounted.length,
    details: highUnaccounted,
  });
}
```

判据只有两项：`DEFERRED` 或 `无去向`。`WONT_FIX` 既不在 `deferredKeys` 里，又已经 `covered`，所以两条判据都不命中，**函数整个不执行**——`--strict-high` 只是给这个不执行的消息换级别，自然也无感。

### 2.2 改后 · 常量与门槛

```js
const MIN_REASON_CHARS = 10;

// R9 · 洞 2（experiments/hilltop-dsh/FIX-R7-report.md §4）：
//   `high_severity_unaccounted` 的原判据是「HIGH 处于 DEFERRED 或无去向」。
//   把 8 条 HIGH 全填 WONT_FIX（理由写够 20 字），警告完全消失——
//   连 --strict-high 也救不回来，因为规则根本没被触发。
//   WONT_FIX 比 DEFERRED 更省事（不需要 next_round、不需要重处置条件），
//   所以它是绕开这条防线的更优路径。这里为它单开一条规则。
const MIN_HIGH_WONT_FIX_CHARS = 40;

// 「可复核指涉」：读者能顺着它去查，而不是只能相信写的人。
//   路径/行号（src/a/B.java、main.rs:42）、反引号标识符、#编号、
//   以及惯例写法的 文件名.扩展名。刻意不放宽到「任意英文单词」——
//   否则「设计如此 by design」这种空话也能命中。
const HIGH_WONT_FIX_ANCHOR = /(?:[\w.-]+\/[\w./-]+|[\w.-]+\.(?:java|kt|ts|js|mjs|py|go|rs|c|cpp|h|json|ya?ml|md|xml|gradle|properties))(?::\d+)?|`[^`]+`|#\d+/;
```

### 2.3 改后 · 收集（第 4 节，去向表解析时记录理由）

```js
const wontFixKeys = new Map();  // R9: disposition 为 WONT_FIX 的 canonical key → 理由原文
...
    covered.add(key);
    if (row.disposition === 'DEFERRED') deferredKeys.add(key);
    // R9: WONT_FIX 的理由要留到第 6 节做逐条呈现（读者要看得到理由才能判断）。
    if (row.disposition === 'WONT_FIX') wontFixKeys.set(key, String(row.reason ?? ''));
    continue;
```

`deferredKeys` 与 `highUnaccounted` 的判据**一个字都没改**——这是有意的（case 24 断言既有行为不变）。

### 2.4 改后 · 新增 §6b

```js
// ────────────────────────────────────────────────────────────────────
// 6b · HIGH 被判 WONT_FIX —— R9 补的洞（R7 报告 §4 洞 2）
//
// 原判据只认「DEFERRED / 无去向」，于是把 8 条 HIGH 全填 WONT_FIX
// （理由写够 20 字）就能让 high_severity_unaccounted 完全消失，
// --strict-high 也无感——因为规则根本没被触发。
//
// 这里**不**把 WONT_FIX 并进 high_severity_unaccounted，因为两者性质不同：
//   DEFERRED = 承认有缺陷，只是这轮不修（自带一个未来的检查点）
//   WONT_FIX = 主张这不是缺陷（写下去之后，再没有任何动作会回头看它）
// 后者更强，风险更高，所以它需要自己一条规则、自己的措辞，
// 而不是被折叠进「暂缓」的计数里。
//
// 关键设计：逐条列出 finding_id + 理由摘录。只报「N 条」等于把人
// 送回原问题——看见数字不等于看见内容，而判断「理由是否成立」
// 必须读到理由本身。
// ────────────────────────────────────────────────────────────────────
const REASON_EXCERPT_CHARS = 30;

/** 按显示宽度截断（CJK 记 2），让摘录在终端里大致等宽。 */
function excerpt(text, maxChars) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '（理由为空）';
  const chars = [...s];
  let width = 0;
  let out = '';
  for (const ch of chars) {
    const w = /[\u2E80-\uFFEF]/.test(ch) ? 2 : 1;
    if (width + w > maxChars * 2 - 1) return `${out}…`;
    width += w;
    out += ch;
  }
  return out;
}

const highWontFix = [];
for (const [key, f] of findingsByKey) {
  if (f.severity !== 'HIGH') continue;
  if (!wontFixKeys.has(key)) continue;
  const reason = wontFixKeys.get(key) ?? '';
  const reasonChars = [...reason.replace(/\s+/g, '')].length;
  const hasAnchor = HIGH_WONT_FIX_ANCHOR.test(reason);
  highWontFix.push({ key, finding_id: f.id, file: f.file, line: f.line, reason, reasonChars, hasAnchor });
}

// 6b-1 · HIGH 的 WONT_FIX 本身要看得见（逐条 + 理由摘录）
if (highWontFix.length > 0) {
  const lvl = ARGS.strictHigh ? 'FAIL' : 'WARN';
  const lines = highWontFix.map((h) => `  · ${h.key} —— 「${excerpt(h.reason, REASON_EXCERPT_CHARS)}」`);
  const msg = `${highWontFix.length} 条 HIGH 被判 WONT_FIX（声称不是缺陷）。`
    + '这个判定比 DEFERRED 更强——DEFERRED 说「下轮修」，WONT_FIX 说「不用修」。'
    + '对 HIGH 来说这是最需要第二个人看一眼的结论，而它只靠一段自由文字支撑；'
    + 'DEFERRED 至少还留下一个「什么条件下重新处置」的钩子，WONT_FIX 什么都不留。'
    + '以下几条请逐条确认理由是否成立：\n'
    + lines.join('\n');
  add(lvl, 'high_severity_wont_fix', msg, {
    high_wont_fix: highWontFix.length,
    details: highWontFix.map((h) => ({
      key: h.key, finding_id: h.finding_id, file: h.file, line: h.line,
      reason: h.reason, reason_chars: h.reasonChars, has_anchor: h.hasAnchor,
    })),
  });
}

// 6b-2 · HIGH 的 WONT_FIX 理由是否撑得住（≥40 字 + 一个可复核指涉）
// 只对 HIGH 抬高门槛：MEDIUM/LOW 的 WONT_FIX 沿用 ≥10 字的既有要求。
const thinHighWontFix = highWontFix.filter(
  (h) => h.reasonChars < MIN_HIGH_WONT_FIX_CHARS || !h.hasAnchor,
);

if (thinHighWontFix.length > 0) {
  const lvl = ARGS.strictHigh ? 'FAIL' : 'WARN';
  const parts = thinHighWontFix.map((h) => {
    const why = [];
    if (h.reasonChars < MIN_HIGH_WONT_FIX_CHARS) {
      why.push(`仅 ${h.reasonChars} 字（要求 ≥ ${MIN_HIGH_WONT_FIX_CHARS}）`);
    }
    if (!h.hasAnchor) why.push('没有一个可复核指涉（文件路径 / 行号 / 反引号标识符 / #编号）');
    return `${h.key}（${why.join('；')}）`;
  });
  const msg = `${thinHighWontFix.length} 条 HIGH 的 WONT_FIX 理由撑不住：`
    + parts.join('、')
    + '——「这不是缺陷」是一个结论，不是一个解释。'
    + `一条理由若既不到 ${MIN_HIGH_WONT_FIX_CHARS} 字、又指不出任何具体位置，`
    + '读者只能选择相信写的人，无法自己复核；'
    + '这正是「一段 20 字的设计意图可以覆盖任何东西」的形态。'
    + '请补到能让人顺着去查的程度（例如 src/a/B.java:42 中该分支的调用方约定）。'
    + '注意：本规则只提示理由质量，不否定 WONT_FIX 这个处置本身——'
    + '该处置的可见性由 high_severity_wont_fix 单独负责。';
  add(lvl, 'high_wont_fix_reason_thin', msg, {
    high_wont_fix_reason_thin: thinHighWontFix.length,
    details: thinHighWontFix.map((h) => ({
      key: h.key, reason_chars: h.reasonChars, has_anchor: h.hasAnchor,
      min_chars: MIN_HIGH_WONT_FIX_CHARS,
    })),
  });
}
```

### 2.5 改后 · 结论文案（顺手堵掉一句假话）

改前只要 `highUnaccounted === 0` 就打「**没有 HIGH 悬空**」——而 R7 洞 2 的形状正是「highUnaccounted 0 + 8 条 HIGH 被 WONT_FIX 一句话关掉」。那句话会主动误导读者。改后：

```js
if (exitCode === 0) {
  if (highUnaccounted.length > 0 || highWontFix.length > 0) {
    const bits = [];
    if (highUnaccounted.length > 0) bits.push(`${highUnaccounted.length} 条 HIGH 仍未闭合（DEFERRED / 无去向）`);
    if (highWontFix.length > 0) {
      bits.push(`${highWontFix.length} 条 HIGH 被判 WONT_FIX（声称不是缺陷，理由见上）`);
    }
    console.log(`结论：全部 ${totalFindings} 条都已表态，但 ${bits.join('；另有 ')}。`);
    ...
```

---

## 三、真实数据自证

命令（任务指定）：

```
node tools/check-disposition-coverage.mjs \
  --artifacts experiments/hilltop-dsh/out \
  --ledger experiments/hilltop-dsh/disposition-ledger-example.md
```

### 3.1 改前（基线，可复现）

```
! [high_severity_unaccounted] 2 条 HIGH 处于 DEFERRED / 无去向：round2-mechanics::F3（DEFERRED）、round3-A::A-01（DEFERRED）……

合计: 38 条 finding / 已表态 38 / 未表态 0
合计: 0 FAIL / 6 WARN / 38 PASS

结论：全部 38 条都已表态，但 2 条 HIGH 仍未闭合（见上）。
```

A-04（HIGH，`WONT_FIX`）**完全不在输出里**。`disposition-ledger-example.md` 第 67-71 行自己就记着这件事：「`WONT_FIX` 不会被 `high_severity_unaccounted` 计为悬空——所以『HIGH 还剩几条』的真实答案是 2 条，不是 3 条」。改前输出与那段自述严丝合缝，证实洞 2 是真的。

### 3.2 改后（实测原文）

```
! [high_severity_unaccounted] 2 条 HIGH 处于 DEFERRED / 无去向：round2-mechanics::F3（DEFERRED）、round3-A::A-01（DEFERRED）——HIGH 暂缓不是非法，但必须有人看见；全部填 DEFERRED 能让覆盖率 100%，却让最该修的 HIGH 继续留在线上
! [high_severity_wont_fix] 1 条 HIGH 被判 WONT_FIX（声称不是缺陷）。这个判定比 DEFERRED 更强——DEFERRED 说「下轮修」，WONT_FIX 说「不用修」。对 HIGH 来说这是最需要第二个人看一眼的结论，而它只靠一段自由文字支撑；DEFERRED 至少还留下一个「什么条件下重新处置」的钩子，WONT_FIX 什么都不留。以下几条请逐条确认理由是否成立：
  · round3-A::A-04 —— 「文案已告知未保存会被覆盖，属设计意图（裁决 #3）」
! [high_wont_fix_reason_thin] 1 条 HIGH 的 WONT_FIX 理由撑不住：round3-A::A-04（仅 24 字（要求 ≥ 40））——「这不是缺陷」是一个结论，不是一个解释。一条理由若既不到 40 字、又指不出任何具体位置，读者只能选择相信写的人，无法自己复核；这正是「一段 20 字的设计意图可以覆盖任何东西」的形态。请补到能让人顺着去查的程度（例如 src/a/B.java:42 中该分支的调用方约定）。注意：本规则只提示理由质量，不否定 WONT_FIX 这个处置本身——该处置的可见性由 high_severity_wont_fix 单独负责。

合计: 38 条 finding / 已表态 38 / 未表态 0
合计: 0 FAIL / 8 WARN / 38 PASS

结论：全部 38 条都已表态，但 2 条 HIGH 仍未闭合（DEFERRED / 无去向）；另有 1 条 HIGH 被判 WONT_FIX（声称不是缺陷，理由见上）。
这些是「已知且被记录」的风险，不再属于「静默丢失」——但收口前应逐条确认。
WONT_FIX 的 HIGH 共 1 条，其中 1 条理由撑不住；「不是缺陷」是唯一不产生后续工作的处置，请把上面列出的理由逐条读完再放行。
```

退出码 **0**（WARN 不阻断，符合设计）。`--strict-high` 下同一条命令 **exit 1**（`3 FAIL / 5 WARN`）。

**「HIGH 还剩几条」的答案现在是 3 条**（F3、A-01、A-04），不再是 2 条。那个「真实答案是 2 条」的自述从此失效——这正是本次改动想达到的效果。

### 3.3 JSON totals（新增两个字段）

```json
{
  "findings": 38, "rawFindings": 38, "accounted": 38, "unaccounted": 0,
  "newFindings": 0, "high": 8,
  "highUnaccounted": 2,
  "highWontFix": 1,
  "highWontFixReasonThin": 1,
  "severity": { "MEDIUM": 22, "HIGH": 8, "LOW": 8 }
}
```

`highUnaccounted` 与 `highWontFix` **并列而非合并**——两者性质不同，合并会让「2」失去含义。

---

## 四、R7 的绕过探针复现（合成 fixture，8 条 HIGH 全 `WONT_FIX`）

**理由约 20 字（R7 用的那种）**：

```
默认:        exit 0 | 0 FAIL / 2 WARN | highWontFix 8 | high_wont_fix_reason_thin 8
--strict-high: exit 1
结论：全部 8 条都已表态，但 8 条 HIGH 被判 WONT_FIX（声称不是缺陷，理由见上）。
```

对比 R7 记录的 `HOLE-2 HIGH 全填 WONT_FIX + 默认 -> exit 0 | highUnaccounted 0 | has high warn false`：退出码仍是 0（WARN 不阻断是既定设计），但「**has high warn**」从 `false` 变成 `true`，而且逐条点名 8 个 id + 8 段理由摘录。`--strict-high` 从「救不回来」变成 exit 1。

**理由精心写（≥40 字 + 每条不同行号）**：

```
exit 0 | 0 FAIL / 1 WARN | highWontFix 8 | highWontFixReasonThin 0
rules: ["high_severity_wont_fix=WARN"]
```

`high_wont_fix_reason_thin` 消失，但 `high_severity_wont_fix` 仍在，**逐条列出 8 条 id 与理由全文**（截 30 字）。这一组数据是第五节自评的依据。

---

## 五、自评：这个改动真的能让人「看见」吗？

**诚实回答：能让人「看见」，但挡不住一个决意造假的人——而且第 5.2 节的数据显示，剩下的缺口比 R7 原先指出的那一条更窄了，但没有消失。**

### 5.1 确实解决了的部分

R7 的洞 2 有两层问题，本次改动把两层都动了：

1. **不可见**（规则不触发 → 报告全绿）。已解决。现在无论理由多好，`high_severity_wont_fix` 都会亮，且逐条列 id + 理由摘录。R7 的探针从 `rules: []` 变成 `rules: ["high_severity_wont_fix=WARN"]`。
2. **`--strict-high` 无感**（因为规则没被触发）。已解决。三条规则同时受控于该开关，`--strict-high` 从 exit 0 变 exit 1。

还有一层是我在动手时才发现、任务描述里没点明的：**结论文案本身在说假话**。改前只要 `highUnaccounted === 0` 就打「没有 HIGH 悬空」。R7 洞 2 的形状恰好让这句话成立——8 条 HIGH 一句话集体消失，然后工具告诉你「没有 HIGH 悬空」。这比「不出警告」更糟：它是一个**主动的错误断言**。已改（§2.5）。

### 5.2 没解决的部分（用上面的实测数据说话）

把理由写到 40 字以上、每条带一个 `src/ConfigManager.java:NNN` 行号，`high_wont_fix_reason_thin` 就归零了。剩下的只有一条 WARN。**这条 WARN 的强度完全取决于有没有人读它。**

- **理由质量门槛是可满足的，而且成本不高。** 上面的探针里，8 条理由是我在 30 秒内编出来的——它们看起来非常像真的（具体行号、具体类名、提及 `#12` 设计评审）。一个知道规则的人可以批量生成这种文本。长度 + 锚点能过滤掉「不修」「设计如此」这类敷衍，但**过滤不掉有条理的敷衍**。
- **脚本无法判断「这条理由是否成立」。** 文件头第「它不检查什么」一节原本就写明：disposition 填得对不对要读代码和测试，脚本不碰。本次改动没有改变这个边界，也不该假装改变了。`src/ConfigManager.java:142` 是否存在、那行代码是否真的「由调用方前置校验」，脚本一概不知道。
- **所以本次改动的真实性质是「提高伪造成本 + 保证可见性」，不是「保证正确性」。** 这比洞 2 之前的状态好一大截（之前连可见性都没有），但如果下一个 agent 决意走这条路，它仍然能拿到 exit 0。

### 5.3 一条不太舒服的观察

R7 报告是靠「自己写探针打自己」暴露洞 2 的，这一点我在这次任务里也复现了：**只有第 2 条规则（`high_wont_fix_reason_thin`）能被自动判掉，第 1 条（`high_severity_wont_fix`）永远只能靠人眼**。任何「再加一条规则」的方案都会有同样的结构——最后一条规则总是需要人来读。

真正能提升的只有两件事，都不在本次范围内：

1. **把 WONT_FIX 的裁决从主 Agent 手里拿走**（R7 §5.3 已经说过同一件事，只是对象是裁决表）。若 WONT_FIX 必须由 critique 相位的 arbiter 落盘、主 Agent 只读，那「填 8 条 WONT_FIX」就不再是主 Agent 能单独完成的动作——这与洞 1/洞 3 是同一个根因。
2. **让 HIGH 的 WONT_FIX 产生一个可验证的后续动作**（例如要求同时提交一条指向「为什么不是缺陷」的代码位置，由人工/测试核对）。这也需要外部基准。

在没有这两样之前，`high_severity_wont_fix` 的正确定位是：**它把「静默关闭」变成「公开声明」**。公开声明可以被第二个人驳回；静默关闭不能。这就是它能做到的全部，我认为值得做，但不该被说成「堵住了」。

### 5.4 为什么做了「抬高 HIGH 的 WONT_FIX 理由门槛」这个可选项

任务说「不做也行，但要说明取舍」。我做了，理由是：

- **它不是一个新判据，而是对既有判据的分级。** `disposition_missing_reason` 已经要求 WONT_FIX 有理由（≥10 字）。对 HIGH 提高门槛不是新增语义，是承认「HIGH 的『不是缺陷』比 MEDIUM 的『不是缺陷』需要更多支撑」——如果两者门槛一样，等于宣称严重性不影响论证义务。
- **它把「敷衍」和「有条理的敷衍」分开了**，虽然只分开了一部分（见 5.2）。
- **代价很低**：只对 `severity === 'HIGH'` 且 `disposition === 'WONT_FIX'` 的行生效（case 29 断言 MEDIUM/LOW 不受影响），是两个条件的交集，`disposition_missing_reason` 的既有行为一个字都没动。

我选的锚点正则刻意**不**接受「任意英文单词」——`by design`、`intentional` 这类短语不能算可复核指涉，否则门槛形同虚设。它接受：含斜杠的路径、常见源码/配置扩展名、`:行号`、反引号标识符、`#编号`。

---

## 六、改动清单（逐项对照任务要求）

| 要求 | 落实 |
|---|---|
| 1. `high_severity_unaccounted` 纳入 WONT_FIX | 改为**单开** `high_severity_wont_fix`，原判据一字未动（理由见 §2.4 注释：两者性质不同，折进同一个计数会让「2 条」失去含义） |
| 1. 新规则消息说明为何需独立可见 | 消息含「DEFERRED 说下轮修，WONT_FIX 说不用修……只靠一段自由文字支撑」 |
| 1. 逐条列出 `finding_id` + 理由前 30 字 | `  · round3-A::A-04 —— 「文案已告知未保存会被覆盖，属设计意图（裁决 #3）」`（CJK 按宽度截断，近似 30 字） |
| 2. 强化 HIGH 的 WONT_FIX 理由 | 新增 `high_wont_fix_reason_thin`：≥40 字 **且** 含可复核指涉。取舍说明见 §5.4 |
| 3. 更新 `--strict-high` 语义 | 三条规则统一受控；文件头注释 + `HELP` 文本 + `--help` 实测均已同步 |
| 4. 测试用例 | case 23–30 全部落地，含要求的 4 个场景 |
| 4. 回归 60 个断言 | 全过（102 = 60 + 42） |
| 5. 真实数据自证 | §3，A-04 已报出 |

**未改动的文件**：`tools/check-all.mjs` 里对 `--strict-high` 的注释（第 177 行）仍是旧的「把「HIGH 被 DEFERRED」从 WARN 升级为 FAIL」。它现在描述得不完整，但任务明确要求只改那两个文件，且那是另一个 agent 的并行范围——**留作后续**，不在本次动。

**未 commit。**
