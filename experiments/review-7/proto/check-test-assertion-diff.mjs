#!/usr/bin/env node
/**
 * check-test-assertion-diff.mjs — 检测「修复者是否把测试断言改反/改弱」
 *
 * 这是 review-7 模式 A 的实现规格，由原型的真实数据实测校准（见 proto/out/*.md）。
 * 文件头即规格；正文即实现。用法：
 *
 *   node check-test-assertion-diff.mjs --repo <被审仓库> [--ref <基线ref>] [--state <state.json>] [--json]
 *
 * 退出码：0 = 无 FAIL（可能有 WARN）／1 = 有 FAIL／2 = 配置错误（repo 非 git、ref 取不到）
 *
 * ══════════════════════════════════════════════════════════════════════════════════
 * 0. 这份规格的三个前提事实（全部实测，不是设计偏好）
 * ══════════════════════════════════════════════════════════════════════════════════
 *
 * F-1 【必须做的口径修正】规则 2（"断言被改反"）**必须按方法作用域比较，不能按文件作用域**。
 *     原因：实测被审仓库本轮 7 个被改测试文件，HEAD 的签名集**全部**是工作区签名集的子集
 *     （7/7）。文件级比较下，只要文件里任何一处还留着旧期望值，规则 2 就永不触发——
 *     真实定标里的 2 处反转在文件级读数是 **0 命中**。方案原文（:88「文件级，不按方法分组」）
 *     在这个样本上是 0 召回。降到方法作用域后 2/2 命中，且文件级规则 1 仍保留用于
 *     吸收"方法改名"（让改名不被误判为删除）。
 *
 * F-2 【必须做的口径修正】"expected 变值" 与 "predicate_class 变档" 要用**多重集**比较，
 *     不是集合。实测：多重集把「删方法」召回从 21/38 (55.3%) 提到 23/38 (60.5%)，
 *     而真实改动集上仍是 2 findings / 0 误报。集合比较会漏掉「同一方法里同 subject 有两条
 *     相同期望、删掉其中一条」这种情况。
 *
 * F-3 【必须承认的硬盲区】对「新增测试文件」结构上完全无话可说（无 HEAD blob）。
 *     本轮 19/26 个改动文件是新增，占 **271/602 = 45.0%** 的断言、73.1% 的文件。
 *     因此**禁止静默跳过**：每个新增测试文件必须显式产出 `assertion_baseline_unavailable`
 *     WARN 并计入 WARN 总数。这条不是礼貌，是让"检查没跑"与"检查通过"可区分。
 *
 * ══════════════════════════════════════════════════════════════════════════════════
 * 1. 输入
 * ══════════════════════════════════════════════════════════════════════════════════
 *
 * 改动测试文件清单：`git -C repo diff --name-only --diff-filter=M <ref> -- src/test`
 *                   + `git status --porcelain -- src/test` 的 `??` 新增
 *                   + `--diff-filter=R -M` 的重命名（按 `old -> new` 取 old 的 blob）
 * 改动前全文：`git -C repo show <ref>:<path>`（取不到 → baseline_unavailable）
 * 改动后全文：readFileSync(<repo>/<path>)
 * 基线 ref：--ref 优先；否则 state.fix_baseline.head；缺失则降级 HEAD 并 WARN。
 * 排除：state.fix_baseline.dirty_paths 里的文件（跨轮噪声），且每个被排除文件单独 WARN。
 * 没有 --ignore / --skip-file：命令行开关会变成默认路径。
 *
 * ══════════════════════════════════════════════════════════════════════════════════
 * 2. parse_assertions(src) → { subjects, methods, unparsable, stats }
 * ══════════════════════════════════════════════════════════════════════════════════
 *
 * 2.1 遮罩（必须先做，否则字符串/注释里的 `assert` 会污染）
 *     maskSource(src) 返回等长字符串 code（注释体与字面量内容替换为空格，保留引号与换行）
 *     + Uint8Array lit（标记字面量偏移）。支持 // 、/* *​/ 、"..." 、'...' 、"""text block"""。
 *     这是纯文本解析，**不建 AST**；实测在 97 文件 / 2742 调用点上够用。
 *
 * 2.2 调用点
 *     正则 /(?<![\w$])(assert[A-Z]\w*|fail|verify|expect)\s*\(/g，再按括号配对找到调用右界。
 *     必须排除**方法定义**：若右括号之后（跳过空白）紧跟 `{` 或 `throws`，那是定义不是调用。
 *
 * 2.3 参数切分
 *     splitArgs 按顶层逗号切（跟踪 ()[]{} 深度），每个参数保留原文 + 遮罩。
 *     去掉参数内**字面量之外**的空白（stripWs），字面量原样保留。
 *
 * 2.4 尾部 message 识别
 *     最后一个实参若以 `"` 开头（字符串表达式，含拼接）→ 视为 message，不参与 subject/expected。
 *     assertEquals 第 3 参若是数字字面量 → 它是 delta，编入 expected：`3.0f±1e-6`。
 *     （不这么做，`3.0f` 与 `3.0` 会被判成"值变了"，这是实测过的假阳性来源。）
 *
 * 2.5 每条断言 → { subject, expected, pclass }
 *     assertEquals/NotEquals/Same/NotSame/ArrayEquals: expected=arg0, target=arg1
 *     assertTrue/False:  target=arg0, expected=true/false
 *     assertNull/NotNull: target=arg0, expected=null/notnull
 *     assertThrows(Exactly): subject=`throws:<被调用表达式>`, expected=`<异常类>`
 *                             （剥掉 `() ->` 前缀；lambda 体或方法引用即身份）
 *     assertDoesNotThrow:   subject=`nothrow:<表达式>`
 *     assertInstanceOf:     expected=arg0, target=arg1
 *     assertAll:            容器——**不产生 subject**，递归扫描其子断言（必须，否则 assertAll 内断言全丢）
 *     verify/expect(Mockito): subject=整条调用文本（抹空白），pclass=interaction
 *     fail:                 不是 subject 断言 → 记入 unparsable，不产生 subject
 *
 * 2.6 【本地 helper 展开 —— 必做，不是可选】
 *     对每个"未知 helper"（形如 assertXxx 但不在 JUnit 内置表里），在本文件内按名字查找
 *     **所有同名方法定义**（Java 重载常见：assertOk(3参) 委派给 assertOk(5参)），
 *     递归解析其 body（深度上限 4，用 `name#overloadIndex` 防环）。
 *     实测（97 文件 / 2733 调用点，用本文件实现自测）：
 *       不展开 → unparsable 56 (2.05%)，6 个文件需降级；
 *       展开后 → **46 处 helper 调用被解析进 body，unparsable 归零（0.00%）**，
 *       0 个文件需要"强判据降级"。
 *     剩余唯一的非 subject 调用是 `fail(...)`（2 处），它本来就没有 subject，
 *     单独计入 stats.nonSubject，**不得**据此触发 assertion_unparsable 降级（否则误降 2 文件）。
 *     不展开的代价是 4 个文件（如 YamlFilesTest 的 36 处 helper 调用）整体失去强判据——
 *     而那些 helper 承载的正是它们全部的实质断言。
 *
 * ══════════════════════════════════════════════════════════════════════════════════
 * 3. subject_key 规范化
 * ══════════════════════════════════════════════════════════════════════════════════
 *
 *   X.size()            → size(X)
 *   X.length() / X.length → size(X)
 *   X.isEmpty()         → size(X)，expected true→0（pclass zero_or_empty）／false→>0（non_empty）
 *   !(X.isEmpty())      → size(X)，expected >0
 *   X.isPresent()       → X.isPresent()
 *   field("refreshTask")→ field("refreshTask")   ← 字符串字面量是身份的一部分，必须保留
 *   X.getItems().get(0).getPrice() → 点路径原样，只抹空白
 *   其它复合表达式        → 原样（抹空白）
 *
 *   注意：`X.size() > 0` 这类**比较表达式**不会被归一化成 size(X)（实测 10 处）。
 *   这是有意的：把 assertTrue(x.size()>0) 与 assertEquals(1, x.size()) 混为一谈会制造假信号。
 *
 * 3.1 predicate_class（实测 7 档，不是 5 档；方案漏了 2 档）
 *   exact(n)          期望是确定值
 *   zero_or_empty     期望 0 / isEmpty()==true
 *   negative          期望 null / false / 非 0 负值（-1 这类哨兵）/ assertNotEquals
 *   existence_only    assertNotNull / assertTrue(<任意表达式>)   ← **最大的一档，实测 30.3%**
 *   non_empty         assertFalse(isEmpty()) / assertTrue(size()>0)
 *   interaction       Mockito verify/expect
 *   exact_existence   assertInstanceOf
 *   排序（仅用于判断"是否变宽"）：exact/exact_existence/interaction=0 < zero_or_empty/negative/non_empty=1
 *                                 < 复合表达式=2 < existence_only=3
 *
 * ══════════════════════════════════════════════════════════════════════════════════
 * 4. 判定规则（级别由"有没有申报"决定，不由"有没有改"决定）
 * ══════════════════════════════════════════════════════════════════════════════════
 *
 *   assert_baseline_unavailable        WARN   新增测试文件（无 HEAD blob）。**每文件必报，禁止静默跳过**
 *   assertion_target_dropped           FAIL   某 subject 在 old 有、在 new 整份文件里一条都没有
 *   assertion_reversed_unreported      FAIL   同 (方法,subject) 两侧都有，但签名多重集少了条目
 *   assertion_reversed_reported        WARN   同上，但 payload.residual_risks 里有 `TEST_CONFLICT: <path>`
 *                                             （+ 强制 HUMAN_DECISION_REQUIRED）
 *   assertion_moved_out_of_method      WARN   方法还在、该 subject 在本方法消失、但文件里别处还在
 *                                             （覆盖"搬进 helper / assertAll 包裹"和"删掉重复断言"，
 *                                              两者不可区分，故只 WARN）
 *   assertion_count_reduced            WARN   本文件断言总数 < 基线（subject-blind，用于补 subject 规则的盲区）
 *   test_disabled                      FAIL   new 新增 @Disabled / @Ignore（**带参也算**，见 §6-1）
 *                                             新增 it.skip( / @pytest.mark.skip / xfail
 *   assertion_conditionally_disabled   WARN   新增 @DisabledIf* / @EnabledIf* / @EnabledOnOs
 *   assertion_assumption_added         INFO   新增 Assumptions.assume*（合法，仅记录）
 *   assertion_unparsable               WARN   展开 helper 后仍抽不出 subject —— **该文件强判据不生效，必须明说**
 *
 *   多重集比较的精确写法（F-2）：
 *     cnt(arr) = Map<signature, count>，signature = `${pclass}(${expected})`
 *     lost = [ s for s in cnt(old) for i in 1..cnt(old)[s]-cnt(new)[s] ]
 *     lost.length > 0 → reversed
 *
 * ══════════════════════════════════════════════════════════════════════════════════
 * 5. 已知漏报形态（实测，写进规格以便验收时对账，不要当成"待修 bug"）
 * ══════════════════════════════════════════════════════════════════════════════════
 *
 *   漏-1 新增测试文件里的任何弱化          100% 漏。无基线。仅 assertion_baseline_unavailable 兜底。
 *                                           实测占本轮 45.0% 的断言。
 *   漏-2 删掉整个 @Test 方法               留一法实测 24/38 = **63.2%** 召回（v5 全规则）。
 *                                          剩下 14 个漏：该方法的 subject 在文件里别处也有断言，
 *                                          且基线是 HEAD（work 断言数已是 HEAD 的 1.21 倍，
 *                                          删一个方法后仍不低于 HEAD，count 规则也不响）。
 *                                          **把基线换成上一轮快照后 count 规则 38/38 全命中**（实测）
 *                                          —— 所以这道闸门的召回率完全由 fix_baseline 口径决定。
 *   漏-3 方法改名 + 同时改值              文件级规则 1 因 subject 仍在别处而不响；方法级规则因方法名
 *                                          不再匹配而跳过 → 漏。（与定标处 3 同形，处 3 是合法的，
 *                                          所以这里无法只靠"改名就报"来补——会立刻误拦处 3。）
 *   漏-4 把断言包进 if(true) / 死分支      断言文本仍在 → 漏。文本级检测的结构极限。
 *   漏-5 F1 形态（只测最容易通过的样本 + 名字声称穷举）
 *                                          **0 命中，有无基线都一样**（实测 3 个变体全 0）。
 *                                          原因：算法只比较"旧 vs 新"，F1 不是 delta；
 *                                          且输入里没有"输入空间有多大"。实测全仓 0 个测试在
 *                                          遍历截断点 → 缺陷是"从来没测过这件事"，不是"加了弱测试"。
 *                                          这一类**必须走申报制**（input_space_basis），不要假装能测。
 *   漏-6 断言被弱化到"同一 subject、同一 pclass、只放宽了值域"
 *                                          （如 assertEquals(10, x) → assertEquals(5, x)，语义上是放宽）
 *                                          签名变了所以会被抓到；但 assertEquals(10,x) → assertTrue(x>0)
 *                                          只是 WARN（moved_out_of_method），不 FAIL。
 *
 * ══════════════════════════════════════════════════════════════════════════════════
 * 6. 实现中必须避开的四个坑（都是实测踩过的）
 * ══════════════════════════════════════════════════════════════════════════════════
 *
 *   6-1 **@Disabled 带参同样是禁用**。方案写"只有 @Disabled(无参) 才命中"，这是事实错误：
 *       JUnit 5 的 value() 是可选原因，不是条件。`@Disabled("flaky")` 与裸 `@Disabled`
 *       对测试是否执行**完全等价**。只匹配无参会把最常见的禁用形态整个漏掉。
 *       真正该排除的是 `Assumptions.assume*`（合法的条件跳过，实测语料 6 处）。
 *   6-2 **文件级做规则 2 = 0 召回**（见 F-1）。别照方案原文实现。
 *   6-3 **集合比较漏"删重复"**，必须多重集（见 F-2）。
 *   6-4 **helper 要递归且要试每个重载**。只试第一个定义会让 assertOk(3参)→assertOk(5参)
 *       这条链在第 1 层就断掉（实测：单层展开 unparsable 降到 38，递归+重载降到 2）。
 *
 * ══════════════════════════════════════════════════════════════════════════════════
 * 7. 输出契约
 * ══════════════════════════════════════════════════════════════════════════════════
 *
 *   { schema, repo, ref, baselineSource, files:{examined, modified, added, excluded},
 *     coverage:{assertCallSites, parsed, unparsable, unparsableRate, strongGateDisabledFiles},
 *     counts:{FAIL, WARN, INFO}, findings:[...], degraded:[...], note }
 *
 *   coverage 必须与 findings 并列输出。**"检查没跑"必须与"检查通过"可区分**——
 *   unparsableRate > 0 或 added > 0 时，报告必须显式声明闸门射程，不得只报 0 findings。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/* ─────────────────────────────── masking ─────────────────────────────── */

export function maskSource(src) {
  const n = src.length;
  const code = new Array(n);
  const lit = new Uint8Array(n);
  const blank = (i) => { const c = src[i]; code[i] = c === '\n' || c === '\r' ? c : ' '; };
  let i = 0;
  while (i < n) {
    const c = src[i], c2 = src[i + 1];
    if (c === '/' && c2 === '/') { while (i < n && src[i] !== '\n') blank(i++); continue; }
    if (c === '/' && c2 === '*') {
      blank(i++); blank(i++);
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) blank(i++);
      blank(i++); blank(i++); continue;
    }
    if (c === '"' && c2 === '"' && src[i + 2] === '"') {
      for (let k = 0; k < 3; k++) { code[i] = '"'; lit[i] = 1; i++; }
      while (i < n) {
        if (src[i] === '\\') { blank(i); lit[i] = 1; i++; if (i < n) { blank(i); lit[i] = 1; i++; } continue; }
        if (src[i] === '"' && src[i + 1] === '"' && src[i + 2] === '"') break;
        blank(i); lit[i] = 1; i++;
      }
      for (let k = 0; k < 3 && i < n; k++) { code[i] = '"'; lit[i] = 1; i++; }
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c; code[i] = q; lit[i] = 1; i++;
      while (i < n) {
        if (src[i] === '\\') { blank(i); lit[i] = 1; i++; if (i < n) { blank(i); lit[i] = 1; i++; } continue; }
        if (src[i] === q) break;
        if (src[i] === '\n') break;
        blank(i); lit[i] = 1; i++;
      }
      if (i < n && src[i] === q) { code[i] = q; lit[i] = 1; i++; }
      continue;
    }
    code[i] = c; i++;
  }
  return { code: code.join(''), lit };
}

function stripWs(s, lit, offset = 0) {
  let out = '';
  for (let k = 0; k < s.length; k++) {
    if (lit[offset + k]) { out += s[k]; continue; }
    const ch = s[k];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') continue;
    out += ch;
  }
  return out;
}

/* ───────────────────────────── call plumbing ───────────────────────────── */

const CALL_RE = /(?<![\w$])(assert[A-Z]\w*|fail|verify|expect)\s*\(/g;
const BUILTIN = new Set([
  'assertEquals', 'assertNotEquals', 'assertSame', 'assertNotSame', 'assertTrue', 'assertFalse',
  'assertNull', 'assertNotNull', 'assertThrows', 'assertThrowsExactly', 'assertDoesNotThrow',
  'assertArrayEquals', 'assertAll', 'assertInstanceOf', 'assertInstanceOfExactly', 'assertIterableEquals',
  'assertLinesMatch', 'assertTimeout', 'assertTimeoutPreemptively', 'fail',
]);
const LITERAL_NUM = /^-?(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)[lLdDfF]?$/;
const isZeroish = (e) => /^(0|0L|0\.0|0\.0f|0\.0d|0f|0d)$/.test(e);

function matchParen(code, open) {
  let d = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '(') d++;
    else if (code[i] === ')') { d--; if (!d) return i; }
  }
  return -1;
}

function splitArgs(code, start, end) {
  const out = [];
  let d = 0, s = start;
  for (let i = start; i < end; i++) {
    const ch = code[i];
    if (ch === '(' || ch === '[' || ch === '{') d++;
    else if (ch === ')' || ch === ']' || ch === '}') d--;
    else if (ch === ',' && d === 0) { out.push([s, i]); s = i + 1; }
  }
  if (end > s) out.push([s, end]);
  return out;
}

function lineOf(src, idx) { let l = 1; for (let i = 0; i < idx && i < src.length; i++) if (src[i] === '\n') l++; return l; }

/* ─────────────────────────── method attribution ─────────────────────────── */

const METHOD_RE = /\n[ \t]*(?:@[\w.]+(?:\([^)]*\))?[ \t\r\n]*)*(?:(?:public|private|protected|static|final|synchronized|abstract|native|default|strictfp)\s+)*(?:<[^>{]{0,80}>\s+)?[\w$.<>\[\], ?]+\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?:throws\s+[\w., \t\r\n]+)?\{/g;

function methodTable(code) {
  const out = [];
  METHOD_RE.lastIndex = 0;
  let m;
  while ((m = METHOD_RE.exec(code))) out.push({ name: m[1], start: m.index });
  return out;
}
function methodAt(table, idx) {
  let name = '<file>';
  for (const t of table) { if (t.start <= idx) name = t.name; else break; }
  return name;
}

/* ──────────────────────── helper definition resolution ──────────────────────── */

function findBodies(src, name) {
  const { code } = maskSource(src);
  const re = new RegExp('(?<![\\w$])' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\(', 'g');
  const out = [];
  let m;
  while ((m = re.exec(code))) {
    const paren = code.indexOf('(', m.index);
    let d = 0, j = paren;
    for (; j < code.length; j++) { if (code[j] === '(') d++; else if (code[j] === ')') { d--; if (!d) break; } }
    const rest = code.slice(j + 1, j + 200);
    const brace = rest.indexOf('{');
    if (brace < 0) continue;
    if (!/^\s*(?:throws\s+[\w.,\s]+)?\{/.test(rest.slice(0, brace + 1))) continue;
    const open = j + 1 + brace;
    let dd = 0, close = -1;
    for (let k = open; k < code.length; k++) {
      if (code[k] === '{') dd++;
      else if (code[k] === '}') { dd--; if (!dd) { close = k; break; } }
    }
    if (close > 0) out.push(src.slice(open, close + 1));
  }
  return out;
}

/** does any overload of `name` (transitively) contain a real assertion? */
function helperCarriesAssertions(src, name, depth = 0, seen = new Set()) {
  if (depth > 4) return false;
  for (let bi = 0; bi < findBodies(src, name).length; bi++) {
    const key = `${name}#${bi}`;
    if (seen.has(key)) continue;
    const body = findBodies(src, name)[bi];
    const inner = parseAssertions(body);
    if (inner.stats.parsed > 0) return true;
    for (const u of inner.unparsable) {
      if (u.fn === 'fail') continue;
      if (helperCarriesAssertions(src, u.fn, depth + 1, new Set([...seen, key]))) return true;
    }
  }
  return false;
}

/* ─────────────────────────────── classify ─────────────────────────────── */

function classify(fn, argTexts, argMasks) {
  const N = argTexts.length;
  const at = (k) => stripWs(argTexts[k], argMasks[k].lit, argMasks[k].off).trim();
  const isStr = (k) => argMasks[k].code.trim().startsWith('"');

  if (fn === 'assertAll') return { container: true };
  if (fn === 'fail') return { error: 'fail() carries no subject' };
  if (fn === 'verify' || fn === 'expect') return { error: 'interaction form handled by caller' };

  let target, expected, pclass;

  if (['assertTrue', 'assertFalse', 'assertNull', 'assertNotNull'].includes(fn)) {
    if (N < 1) return { error: 'no args' };
    target = at(0);
    if (!target) return { error: 'empty target' };
    expected = { assertTrue: 'true', assertFalse: 'false', assertNull: 'null', assertNotNull: 'notnull' }[fn];
    pclass = fn === 'assertNull' || fn === 'assertFalse' ? 'negative'
      : fn === 'assertNotNull' ? 'existence_only' : 'existence_only';
    if (fn === 'assertTrue' && /^(true|false)$/.test(target)) return { error: 'boolean literal target' };
  } else if (fn === 'assertThrows' || fn === 'assertThrowsExactly') {
    if (N < 2) return { error: 'needs (Class, executable)' };
    const exe = at(1).replace(/^\(\s*\)\s*->\s*/, '');
    target = `throws:${exe}`;
    expected = at(0);
    pclass = 'exact';
  } else if (fn === 'assertDoesNotThrow') {
    const exe = (N >= 2 ? at(1) : at(0)).replace(/^\(\s*\)\s*->\s*/, '');
    target = `nothrow:${exe}`; expected = 'nothrow'; pclass = 'negative';
  } else if (['assertEquals', 'assertNotEquals', 'assertSame', 'assertNotSame', 'assertArrayEquals'].includes(fn)) {
    if (N < 2) return { error: 'needs 2 args' };
    target = at(1);
    expected = at(0);
    if (fn === 'assertEquals' && N >= 3 && LITERAL_NUM.test(at(2))) expected = `${expected}±${at(2)}`;
    if (!target) return { error: 'empty actual' };
    if (!expected) return { error: 'empty expected' };
    pclass = (fn === 'assertNotEquals' || fn === 'assertNotSame') ? 'negative' : null;
  } else if (fn === 'assertInstanceOf' || fn === 'assertInstanceOfExactly') {
    if (N < 2) return { error: 'needs (Class, actual)' };
    expected = at(0); target = at(1); pclass = 'exact_existence';
  } else {
    return { error: 'unknown helper' };
  }

  /* canonical subject */
  let subject = target, m;
  if ((m = target.match(/^(.*)\.size\(\)$/s)) || (m = target.match(/^(.*)\.length\(\)$/s)) || (m = target.match(/^(.*)\.length$/s))) {
    subject = `size(${m[1]})`;
    pclass = pclass || (isZeroish(expected) ? 'zero_or_empty' : 'exact');
  } else if ((m = target.match(/^(.*)\.isEmpty\(\)$/s))) {
    subject = `size(${m[1]})`;
    if (expected === 'true') { expected = '0'; pclass = 'zero_or_empty'; }
    else if (expected === 'false') { expected = '>0'; pclass = 'non_empty'; }
    else pclass = 'zero_or_empty';
  } else if ((m = target.match(/^!\(?(.*)\.isEmpty\(\)\)?$/s))) {
    subject = `size(${m[1]})`; expected = '>0'; pclass = 'non_empty';
  }
  if (!subject) return { error: 'no subject' };
  if (pclass === null) {
    if (isZeroish(expected)) pclass = 'zero_or_empty';
    else if (/^-1(\.0)?[lLdDfF]?$/.test(expected)) pclass = 'negative';
    else pclass = 'exact';
  }
  return { subject, expected, pclass };
}

/* ────────────────────────────── parseAssertions ────────────────────────────── */

export function parseAssertions(src) {
  const { code, lit } = maskSource(src);
  const table = methodTable(code);
  const subjects = new Map();
  const methods = new Map();
  const unparsable = [];
  const containers = [];
  let callSites = 0;

  CALL_RE.lastIndex = 0;
  let m;
  while ((m = CALL_RE.exec(code))) {
    const fn = m[1];
    const open = code.indexOf('(', m.index + m[0].length - 1);
    if (open < 0) continue;
    const close = matchParen(code, open);
    if (close < 0) { unparsable.push({ line: lineOf(src, m.index), fn, reason: 'unbalanced' }); continue; }
    // skip the definition itself
    const after = code.slice(close + 1, close + 90).trimStart();
    if (after.startsWith('{') || /^throws\s/.test(after)) { CALL_RE.lastIndex = close + 1; continue; }
    callSites++;

    if (fn === 'verify' || fn === 'expect') {
      const whole = stripWs(src.slice(m.index, close + 1), lit, m.index);
      add(subjects, whole, { subject: whole, expected: 'called', pclass: 'interaction', kind: fn, line: lineOf(src, m.index), method: methodAt(table, m.index) });
      addMethod(methods, methodAt(table, m.index), whole);
      CALL_RE.lastIndex = close + 1;
      continue;
    }

    const ranges = splitArgs(code, open + 1, close);
    const argTexts = ranges.map(([a, b]) => src.slice(a, b));
    const argMasks = ranges.map(([a, b]) => ({ code: code.slice(a, b), lit, off: a }));
    const r = classify(fn, argTexts, argMasks);

    if (r.container) {
      containers.push({ line: lineOf(src, m.index), fn });
      CALL_RE.lastIndex = open + 1; // recurse into children
      continue;
    }
    if (r.error) {
      // local helper? if its body carries assertions, the file is still gateable -> count as resolved
      const local = !BUILTIN.has(fn) && helperCarriesAssertions(src, fn);
      unparsable.push({
        line: lineOf(src, m.index), fn,
        reason: r.error === 'unknown helper' && local ? 'local helper (resolved into body)' : r.error,
        resolved: local,
        text: src.slice(m.index, Math.min(close + 1, m.index + 110)).replace(/\s+/g, ' '),
      });
      CALL_RE.lastIndex = close + 1;
      continue;
    }
    add(subjects, r.subject, { ...r, line: lineOf(src, m.index), method: methodAt(table, m.index) });
    addMethod(methods, methodAt(table, m.index), r.subject);
    CALL_RE.lastIndex = close + 1;
  }

  const unresolved = unparsable.filter((u) => !u.resolved && u.fn !== 'fail');
  const nonSubject = unparsable.filter((u) => u.fn === 'fail').length;
  return {
    subjects, methods, unparsable, containers,
    stats: {
      callSites,
      parsed: [...subjects.values()].reduce((a, v) => a + v.length, 0),
      unparsable: unresolved.length,
      unparsableTotal: unparsable.length,
      nonSubject,
      containers: containers.length,
      distinctSubjects: subjects.size,
      physicalAssertLines: src.split('\n').filter((l) => /^\s*(assert|fail|verify)/.test(l)).length,
    },
  };
}

function add(map, k, v) { if (!map.has(k)) map.set(k, []); map.get(k).push(v); }
function addMethod(map, k, v) { if (!map.has(k)) map.set(k, new Set()); map.get(k).add(v); }

/* ─────────────────────────────── detection ─────────────────────────────── */

const DISABLE_RE = /@Disabled\b|@Ignore\b|\bit\.skip\s*\(|@pytest\.mark\.skip|\bxfail\b/g;
const COND_RE = /@DisabledIf\w*|@EnabledIf\w*|@EnabledOnOs/g;
const ASSUME_RE = /Assumptions\.assume\w+/g;
const sig = (a) => `${a.pclass}(${a.expected})`;

/** multiset difference: how many of each signature are in `a` beyond `b` */
function multisetLost(a, b) {
  const ca = new Map(), cb = new Map();
  for (const x of a) ca.set(sig(x), (ca.get(sig(x)) ?? 0) + 1);
  for (const x of b) cb.set(sig(x), (cb.get(sig(x)) ?? 0) + 1);
  const lost = [];
  for (const [s, v] of ca) { const d = v - (cb.get(s) ?? 0); for (let i = 0; i < d; i++) lost.push(s); }
  return lost;
}

export function detect(oldSrc, newSrc, { rel = '<file>', reported = false, dirty = false } = {}) {
  const findings = [];
  const newP = parseAssertions(newSrc);

  const cnt = (s, re) => ((s ?? '').match(re) ?? []).length;
  if (cnt(newSrc, DISABLE_RE) > cnt(oldSrc, DISABLE_RE)) {
    findings.push({ rule: 'test_disabled', severity: 'FAIL', file: rel, subject: '@Disabled/@Ignore/skip', detail: 'test newly disabled' });
  }
  if (cnt(newSrc, COND_RE) > cnt(oldSrc, COND_RE)) {
    findings.push({ rule: 'assertion_conditionally_disabled', severity: 'WARN', file: rel, subject: '@DisabledIf/@EnabledIf/@EnabledOnOs' });
  }
  if (cnt(newSrc, ASSUME_RE) > cnt(oldSrc, ASSUME_RE)) {
    findings.push({ rule: 'assertion_assumption_added', severity: 'INFO', file: rel, subject: 'Assumptions.assume*' });
  }

  if (oldSrc === null || oldSrc === '') {
    findings.push({
      rule: 'assertion_baseline_unavailable', severity: 'WARN', file: rel,
      subject: `${newP.stats.distinctSubjects} subjects / ${newP.stats.parsed} assertions`,
      detail: 'new test file: no baseline blob, rules 1-2 cannot run (strong gate unavailable)',
    });
    return { findings, stats: { old: null, new: newP.stats }, gateable: false };
  }

  if (dirty) {
    findings.push({ rule: 'assertion_baseline_dirty', severity: 'WARN', file: rel, subject: '-', detail: 'in fix_baseline.dirty_paths; strong gate disabled' });
    return { findings, stats: { old: null, new: newP.stats }, gateable: false };
  }

  const oldP = parseAssertions(oldSrc);

  // rule 1 — dropped from the whole file
  for (const [subj, olds] of oldP.subjects) {
    if (!newP.subjects.has(subj)) {
      findings.push({ rule: 'assertion_target_dropped', severity: 'FAIL', file: rel, subject: subj, old: olds.map(sig) });
    }
  }

  // rule 2 — reversed, METHOD scope, MULTISET (F-1 + F-2)
  const idx = (p) => {
    const m = new Map();
    for (const [subj, arr] of p.subjects) for (const a of arr) {
      const k = `${a.method}::${subj}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(a);
    }
    return m;
  };
  const oi = idx(oldP), ni = idx(newP);
  const newMethods = new Set(newP.methods.keys());
  for (const [k, olds] of oi) {
    const sep = k.indexOf('::');
    const meth = k.slice(0, sep), subj = k.slice(sep + 2);
    const news = ni.get(k);
    if (news) {
      const lost = multisetLost(olds, news);
      if (lost.length) {
        findings.push({
          rule: reported ? 'assertion_reversed_reported' : 'assertion_reversed_unreported',
          severity: reported ? 'WARN' : 'FAIL',
          file: rel, subject: subj, method: meth, lost, now: news.map(sig),
          detail: reported ? 'declared via TEST_CONFLICT -> HUMAN_DECISION_REQUIRED' : 'expectation changed without TEST_CONFLICT declaration',
        });
      }
      continue;
    }
    if (newMethods.has(meth) && newP.subjects.has(subj)) {
      findings.push({
        rule: 'assertion_moved_out_of_method', severity: 'WARN', file: rel, subject: subj, method: meth,
        foundIn: [...new Set((newP.subjects.get(subj) ?? []).map((a) => a.method))],
        detail: 'assertion left this method but survives elsewhere in the file (helper wrap / duplicate removed / relocated)',
      });
    }
  }

  // rule 3 — count decreased (subject-blind; closes part of the leave-one-out gap)
  if (newP.stats.parsed < oldP.stats.parsed) {
    findings.push({
      rule: 'assertion_count_reduced', severity: 'WARN', file: rel, subject: `${oldP.stats.parsed} -> ${newP.stats.parsed}`,
      detail: 'file-level assertion count went down (recall depends on baseline being the previous round, not HEAD)',
    });
  }

  if (newP.stats.unparsable > 0) {
    findings.push({
      rule: 'assertion_unparsable', severity: 'WARN', file: rel,
      subject: `${newP.stats.unparsable} unresolved call site(s)`,
      detail: 'strong rules did not cover these assertions',
      samples: newP.unparsable.filter((u) => !u.resolved).slice(0, 5),
    });
  }

  return { findings, stats: { old: oldP.stats, new: newP.stats }, gateable: true };
}

/* ──────────────────────────────── CLI ──────────────────────────────── */

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
}

export function run({ repo, ref = 'HEAD', state = null, dirtyPaths = [] }) {
  const changed = [];
  for (const rel of git(repo, ['diff', '--name-only', '--diff-filter=M', ref, '--', 'src/test']).trim().split('\n').filter(Boolean)) changed.push({ rel, status: 'M' });
  for (const rel of git(repo, ['diff', '--name-only', '--diff-filter=R', '-M', ref, '--', 'src/test']).trim().split('\n').filter(Boolean)) changed.push({ rel, status: 'R' });
  for (const line of git(repo, ['status', '--porcelain', '--', 'src/test']).trim().split('\n')) {
    if (line.startsWith('??')) changed.push({ rel: line.slice(3).trim(), status: 'A' });
  }
  const seen = new Map();
  for (const c of changed) if (!seen.has(c.rel)) seen.set(c.rel, c);

  const findings = [];
  const coverage = { assertCallSites: 0, parsed: 0, unparsable: 0, strongGateDisabledFiles: [] };
  let modified = 0, added = 0, excluded = 0;

  for (const { rel, status } of seen.values()) {
    const abs = path.join(repo, rel);
    if (!existsSync(abs)) continue;
    const newSrc = readFileSync(abs, 'utf8');
    let oldSrc = null;
    try { oldSrc = git(repo, ['show', `${ref}:${rel}`]); } catch { oldSrc = null; }
    if (oldSrc === null) added++; else modified++;
    const isDirty = dirtyPaths.some((p) => rel === p || rel.endsWith(p));
    if (isDirty) excluded++;
    const r = detect(oldSrc, newSrc, { rel, dirty: isDirty });
    findings.push(...r.findings);
    coverage.assertCallSites += r.stats.new.callSites;
    coverage.parsed += r.stats.new.parsed;
    coverage.unparsable += r.stats.new.unparsable;
    if (!r.gateable) coverage.strongGateDisabledFiles.push(rel);
  }

  const counts = { FAIL: 0, WARN: 0, INFO: 0 };
  for (const f of findings) counts[f.severity]++;
  return {
    schema: 'check-test-assertion-diff/v1',
    repo, ref,
    files: { examined: seen.size, modified, added, excluded },
    coverage: { ...coverage, unparsableRate: coverage.assertCallSites ? +(coverage.unparsable / coverage.assertCallSites * 100).toFixed(2) : 0 },
    counts, findings,
    note: counts.FAIL === 0 && (coverage.strongGateDisabledFiles.length || coverage.unparsable)
      ? 'PASS with reduced scope: see strongGateDisabledFiles / unparsableRate. Zero FAIL does not mean zero weakening.'
      : undefined,
  };
}

if (process.argv[1] && path.basename(process.argv[1]) === 'check-test-assertion-diff.mjs') {
  const args = process.argv.slice(2);
  const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const repo = getArg('--repo');
  if (!repo) { console.error('usage: --repo <path> [--ref <ref>] [--json]'); process.exit(2); }
  try {
    const res = run({ repo, ref: getArg('--ref', 'HEAD') });
    if (args.includes('--json')) console.log(JSON.stringify(res, null, 2));
    else {
      console.log(`${res.files.examined} test files (${res.files.modified} modified, ${res.files.added} added, ${res.files.excluded} excluded)`);
      console.log(`coverage: ${res.coverage.parsed} assertions parsed, ${res.coverage.unparsable} unresolved (${res.coverage.unparsableRate}%)`);
      console.log(`findings: FAIL=${res.counts.FAIL} WARN=${res.counts.WARN} INFO=${res.counts.INFO}`);
      for (const f of res.findings) console.log(`  [${f.severity}] ${f.rule} ${f.file}${f.subject ? ' :: ' + f.subject : ''}`);
      if (res.note) console.log(`NOTE: ${res.note}`);
    }
    process.exit(res.counts.FAIL > 0 ? 1 : 0);
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(2);
  }
}
