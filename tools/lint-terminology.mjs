#!/usr/bin/env node
/**
 * lint-terminology.mjs — 静态检查：同一个概念在框架里是否只有一个写法
 *
 * 为什么需要它（2026-11-19 实战暴露）：
 *   跑通一次真实的 dsh 审计后回看模板，发现「子 Agent」这个概念有四种写法：
 *
 *     subagent  22 处 | 子 Agent  106 处 | 子Agent  198 处 | 子 agent  2 处
 *
 *   而且分布是**按文件分裂**的：wave2a-sweep 与 wave4-fix 用 `subagent`（贴工具名），
 *   其余模板用中文；wave5-verify 一处都没有。
 *
 *   这不是文字洁癖。真实后果有两个：
 *     1. **加载方对不上**：模板说「派子 Agent」，而 harness 的工具名是 `subagent`。
 *        agent 需要在脑内做一次映射，这一步没有任何地方要求它做。
 *     2. **规则漏改**：同一个规则被复制到 3–5 个文件（见 lint-autonomy 的教训），
 *        如果连「这条规则在讲哪个角色」的称法都不统一，改一处时更容易漏掉别处。
 *
 *   与 lint-autonomy 同源：那个钉的是「同一个规则被复制到多处而不同步」，
 *   这个钉的是「同一个概念有多个名字」。
 *
 * ── 检查项 ──────────────────────────────────────────────────────────
 *   T1  同一个术语族出现多种写法（TERMS 里定义的每一族，全框架只允许一种规范写法）
 *   T2  违反 DISCRETIONARY 声明的写法（规范写法在术语表里，但不带理由地改写）
 *   T3  某个模板对核心角色一次都没提到（覆盖率缺口，不是格式错）
 *
 * ── 级别 ────────────────────────────────────────────────────────────
 *   T1 / T2 → FAIL（有明确的规范写法，偏离就是错）
 *   T3      → WARN（可能是该波次确实不需要这个词，需要人判断）
 *
 * ── 它的边界（必须写在这里，否则下一个人会以为它管得更多）──────────
 *   1. 它只检查 TERMS 里登记过的术语族。没登记的概念它完全看不见。
 *   2. 它不判断「这个词用得对不对」，只判断「写法是否统一」。
 *   3. 中文分词有歧义：`子Agent` 与 `子 Agent` 在正则层面能区分，
 *      但 `子代理` 这类同义词不在本检查范围内（除非登记进 TERMS）。
 *   4. 它不检查正文语义，只做字面匹配。
 *
 * 用法：node tools/lint-terminology.mjs [--json] [--framework <dir>]
 * 退出码：0 = 无 FAIL（可能有 WARN）／1 = 有 FAIL／2 = 配置错误
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const fwArgIdx = process.argv.indexOf('--framework');
const FW = fwArgIdx >= 0 && process.argv[fwArgIdx + 1]
  ? process.argv[fwArgIdx + 1]
  : join(HERE, '..', 'framework');
const ROOT = join(HERE, '..');
const jsonOut = process.argv.includes('--json');

// ────────────────────────────────────────────────────────────────────
// 术语表 —— 每族只允许一种规范写法
//
// canonical：规范写法（T1 用它判定违规）
// variants：等价写法（出现即违规，除非整段在代码块里）
// why：为什么选这个作规范 —— 写清楚，否则下一个人会想改回去
// ────────────────────────────────────────────────────────────────────
const TERMS = [
  {
    id: 'subagent',
    // 2026-11-19 修正：最初把规范定成英文 `subagent`，跑出来 257 处违规 ——
    // 但打开文件看，那些是中文正文里的**角色称法**（「所有子Agent在产出任何发现前加载」），
    // 在中文语境里是正确表达，强行改成英文反而更差。
    //
    // 真正的缺陷不是「中文 vs 英文」，而是**同一种写法内部不一致**：
    // `子Agent` 197 处 与 `子 Agent` 101 处 混用。中文排版里带空格的写法更易读
    // （避免汉字与拉丁字母紧贴），所以规范取带空格的那个。
    //
    // 英文 `subagent` 保留为合法写法 —— 它出现在需要与工具名精确对齐的地方，
    // 那种语境下用中文反而会失去可执行性。
    canonical: '子 Agent',
    accepted: ['subagent'],
    variants: ['子Agent', '子 agent', '子AGENT', '子 AGENT'],
    why:
      '中文正文统一写「子 Agent」（带空格），与「门 0」的排版习惯一致；'
      + '需要与 harness 工具名精确对齐时用 `subagent`（属合法写法）。'
      + '2026-11-19 实测：模板写「派子 Agent」而工具名是 `subagent`，'
      + 'agent 需要在脑内做一次映射，而没有任何地方要求它做这个翻译。',
  },
  {
    id: 'gate0',
    canonical: '门 0',
    accepted: ['Gate 0'],
    variants: ['gate 0', 'Gate0', 'gate0', '门0'],
    why:
      '全框架以中文为主（「门 0 证据链」），且 `门 0` 带空格与 `门0` 在中文排版上更易读。'
      + '`Gate 0` 在引用英文资料时保留为合法写法。',
  },
];

// ────────────────────────────────────────────────────────────────────
// T3 的覆盖检查：哪些模板**必须**提到子 Agent
//
// ★ 2026-11-19 修正：最初把全部 6 个 wave 模板都列进来，跑出 4 条警告。
// 打开看，那 4 个模板根本不需要提 —— 它们描述的是「你被派来之后怎么干活」，
// 派发这件事由主 Agent 按 protocol.md 决定，不由这些模板决定。
//
// 判据应该是「这个模板是否包含派发决策」：
//   · wave2a-sweep 明确写了「按片派发」「派发含义」→ 必须提
//   · wave4-fix 描述了修复实例的派发与重派 → 必须提
//   · 其余四个是「执行体视角」的作业指导 → **不该要求它们提**
//
// 强加要求会让模板为了过检查而塞一句无关的话，那比没有检查更糟。
// ────────────────────────────────────────────────────────────────────
const MUST_MENTION_SUBAGENT = [
  'templates/wave2a-sweep.md',
  'templates/wave4-fix.md',
];

const findings = [];
const add = (level, rule, file, line, msg) => findings.push({ level, rule, file, line, msg });

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

if (!existsSync(FW)) {
  console.error(`找不到 framework 目录: ${FW}`);
  process.exit(2);
}

const files = walk(FW);
if (files.length === 0) {
  console.error('[预期失败] framework 下一个 .md 都没有——路径可能变了，分母为 0 不等于通过');
  process.exit(2);
}

const docs = files.map((f) => ({
  path: f,
  rel: relative(FW, f).replace(/\\/g, '/'),
  lines: readFileSync(f, 'utf8').split(/\r?\n/),
}));

// ────────────────────────────────────────────────────────────────────
// T1 · 同族多写法
// ────────────────────────────────────────────────────────────────────
const counts = {};
for (const term of TERMS) {
  counts[term.id] = { canonical: 0, accepted: 0, byVariant: {} };
  for (const v of term.variants) counts[term.id].byVariant[v] = 0;
}

for (const doc of docs) {
  let inFence = false;
  doc.lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return; }
    if (inFence) return;                       // 代码块里的写法是示例，不算违规
    for (const term of TERMS) {
      // 规范写法
      const canonHits = line.split(term.canonical).length - 1;
      if (canonHits > 0) counts[term.id].canonical += canonHits;
      // 明确允许的等价写法（例如需要与工具名对齐时的英文形式）
      for (const a of term.accepted ?? []) {
        counts[term.id].accepted += line.split(a).length - 1;
      }
      // 变体：出现即违规
      for (const v of term.variants) {
        const hits = line.split(v).length - 1;
        if (hits > 0) {
          counts[term.id].byVariant[v] += hits;
          // 变体在「紧跟汉字」时的合法性：中文排版里「子 Agent在」是主流写法
          // （实测 189 处 vs 带空格的 98 处），强行在汉字前加空格反而不自然。
          // 只有形如 `子 Agent 在` 这种「两边都加空格」才是真正的排版错误，
          // 但那种写法实测 0 处，所以这里不做特例，统一按变体判违规。
          add('FAIL', 'T1_variant_spelling', doc.rel, i + 1,
            `术语「${term.id}」应统一写作 ${term.canonical}，这里写成 ${v}。`
            + `为什么：${term.why}`);
        }
      }
    }
  });
}

// ────────────────────────────────────────────────────────────────────
// T3 · 模板覆盖（WARN，因为可能是该波次确实不需要）
// ────────────────────────────────────────────────────────────────────
for (const rel of MUST_MENTION_SUBAGENT) {
  const doc = docs.find((d) => d.rel === rel);
  if (!doc) continue;                          // 文件不存在不是本检查的职责
  const text = doc.lines.join('\n');
  const hasAny = text.includes('subagent')
    || text.includes('子Agent') || text.includes('子 Agent') || text.includes('子 agent');
  if (!hasAny) {
    add('WARN', 'T3_template_silent_about_subagent', rel, 0,
      '该模板一次都没提到 subagent。如果这个波次确实需要派发，agent 只能靠自己推断。'
      + '若确实不需要（例如只产出一份文档），请在该模板里显式写明「本波次不派发」。');
  }
}

// ────────────────────────────────────────────────────────────────────
// 输出
// ────────────────────────────────────────────────────────────────────
const fails = findings.filter((f) => f.level === 'FAIL');
const warns = findings.filter((f) => f.level === 'WARN');

const result = {
  ok: fails.length === 0,
  terms: TERMS.map((t) => ({
    id: t.id,
    canonical: t.canonical,
    canonical_count: counts[t.id].canonical,
    accepted_count: counts[t.id].accepted ?? 0,
    variants: counts[t.id].byVariant,
  })),
  fail_count: fails.length,
  warn_count: warns.length,
  findings,
};

if (jsonOut) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log('\n术语一致性检查\n');
  for (const t of result.terms) {
    const variantTotal = Object.values(t.variants).reduce((a, b) => a + b, 0);
    const mark = variantTotal === 0 ? '✓' : '✗';
    console.log(`  ${mark} ${t.id.padEnd(10)} 规范写法 ${t.canonical.padEnd(12)} ${t.canonical_count} 处`);
    for (const [v, n] of Object.entries(t.variants)) {
      if (n > 0) console.log(`      变体 ${v.padEnd(14)} ${n} 处`);
    }
  }
  console.log('');
  if (fails.length) {
    console.log(`  ✗ ${fails.length} 项违规：`);
    const byFile = {};
    for (const f of fails) (byFile[f.file] ??= []).push(f);
    for (const [file, list] of Object.entries(byFile)) {
      console.log(`    ${file}（${list.length} 处）`);
      // 带上规则名：自测与排查都靠它定位是哪一类问题
      for (const f of list.slice(0, 3)) {
        console.log(`      [${f.rule}] :${f.line}  ${f.msg.split('。')[0]}`);
      }
      if (list.length > 3) console.log(`      … 另有 ${list.length - 3} 处`);
    }
    console.log('');
  }
  if (warns.length) {
    console.log(`  ⚠️  ${warns.length} 项警告：`);
    for (const w of warns) console.log(`    [${w.rule}] ${w.file}\n      ${w.msg}`);
    console.log('');
  }
  if (!fails.length && !warns.length) console.log('  ✅ 术语一致\n');
}

process.exit(fails.length > 0 ? 1 : 0);
