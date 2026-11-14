#!/usr/bin/env node
/**
 * lint-autonomy.test.mjs — 护栏的自测
 *
 * 为什么需要：可维护性批判者实测发现 `lint-autonomy.mjs` 有 58 个 FAIL 断言、
 * **0 个测试**。而框架自己定义过「护栏自己无护栏」是一种缺陷。
 *
 * 更严重的是，它实测出至少三处假绿：
 *   - 日期前缀能绕过 L1（「2026-11-05 实测：…请等待用户决定」）
 *   - triage.md 里 T2 从 9 改 10，另两处不定，全绿
 *   - 契约新增必填字段但校验器不动，全绿
 *
 * 这里的每个用例都是「已知该红 → 必须红」或「已知该绿 → 必须绿」。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LINT = join(HERE, 'lint-autonomy.mjs');
const FW = join(HERE, '..', 'framework');

let pass = 0, fail = 0;
const expect = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); }
};

// 在 framework 的副本上跑 lint，避免污染真文件
function withMutatedFramework(mutator, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'lint-test-'));
  const fwCopy = join(dir, 'framework');
  cpSync(FW, fwCopy, { recursive: true });
  mutator(fwCopy);
  try {
    return fn(fwCopy);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runLint(dirOverride) {
  const args = dirOverride ? [LINT, '--framework', dirOverride] : [LINT];
  try {
    const out = execFileSync('node', args, { encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

console.log('\n=== lint-autonomy 自测 ===\n');

console.log('case 1: 未改动的框架必须全绿');
{
  const r = runLint();
  expect('退出码 0', r.code === 0, r.out.slice(-300));
  expect('无 FAIL', !/✗/.test(r.out), r.out.split('\n').filter(l => l.includes('✗')).join('; '));
}

console.log('case 2: L1 —— 裸的「等待用户决定」必须判红');
{
  const r = withMutatedFramework(
    (fw) => {
      const p = join(fw, 'MANUAL.md');
      writeFileSync(p, readFileSync(p, 'utf8') + '\n遇到冲突请等待用户决定。\n');
    },
    (fw) => runLint(fw),
  );
  expect('报 L1', /\[L1\]/.test(r.out), r.out.slice(-300));
}

console.log('case 3: L1 —— 日期前缀不能成为绕过通道（可维护性批判者实测的洞）');
{
  const r = withMutatedFramework(
    (fw) => {
      const p = join(fw, 'MANUAL.md');
      writeFileSync(p, readFileSync(p, 'utf8') + '\n2026-11-05 实测：遇到冲突请等待用户决定，不要自行处理。\n');
    },
    (fw) => runLint(fw),
  );
  expect('仍然报 L1（历史前缀 + 祈使句 = 活规则）', /\[L1\]/.test(r.out), r.out.slice(-300));
}

console.log('case 4: L1 —— 纯历史叙述（无祈使句）应豁免，不能误伤');
{
  const r = withMutatedFramework(
    (fw) => {
      const p = join(fw, 'MANUAL.md');
      writeFileSync(p, readFileSync(p, 'utf8')
        + '\n2026-11-05 实测：此前该判据会等待用户决定，后改为自动续轮。\n');
    },
    (fw) => runLint(fw),
  );
  expect('无 L1 报错', !/\[L1\]/.test(r.out), r.out.split('\n').filter(l => l.includes('L1')).join('; '));
}

console.log('case 5: L10 —— 已更名枚举复活必须判红');
{
  const r = withMutatedFramework(
    (fw) => {
      const p = join(fw, 'artifacts', 'run-state.md');
      writeFileSync(p, readFileSync(p, 'utf8') + '\n    "error_type": "SCRIPT_TIMEOUT",\n');
    },
    (fw) => runLint(fw),
  );
  expect('报 L10', /\[L10\]/.test(r.out), r.out.slice(-300));
}

console.log('case 6: L14 —— 指向不存在的框架文件必须判红');
{
  const r = withMutatedFramework(
    (fw) => {
      const p = join(fw, 'MANUAL.md');
      writeFileSync(p, readFileSync(p, 'utf8') + '\n加载 `templates/does-not-exist-at-all.mjs`。\n');
    },
    (fw) => runLint(fw),
  );
  expect('报 L14', /\[L14\]/.test(r.out), r.out.slice(-300));
}

console.log('case 7: L15 —— MANUAL 用 discovery_budget 当 sweep 上限必须判红');
{
  const r = withMutatedFramework(
    (fw) => {
      const p = join(fw, 'MANUAL.md');
      const s = readFileSync(p, 'utf8')
        .replace(/planned_sweep_agents:\s*min\(effective_slices, sweep_budget\)/,
          'planned_sweep_agents:    min(effective_slices, discovery_budget)');
      writeFileSync(p, s);
    },
    (fw) => runLint(fw),
  );
  expect('报 L15', /\[L15\]/.test(r.out), r.out.slice(-300));
}

console.log('case 8: L13 —— 模板漏掉关键字段必须判红');
{
  const r = withMutatedFramework(
    (fw) => {
      const p = join(fw, 'templates', 'wave3-critique.md');
      const s = readFileSync(p, 'utf8').split('sub_claims').join('SOMETHING_ELSE');
      writeFileSync(p, s);
    },
    (fw) => runLint(fw),
  );
  expect('报 L13', /\[L13\]/.test(r.out), r.out.slice(-300));
}

console.log('case 8c: L3 必须抓住「attempt 归零」的任意写法（红队实测 6/8 绕过）');
{
  // 2026-11-14 实测：原正则 /attempt\s*从\s*0|attempt\s*从头计/ 只认两种写法，
  // 下面 8 种表达里 6 种绕过。而这条规则防的是**无限重派死锁**，
  // 靠关键词列表守它等于没守——换个动词就绕过。
  const VARIANTS = [
    'attempt 从 0 计',
    'attempt 记为 0',
    '把 attempt 抹回 0',
    'attempt 重置为 0',
    'attempt 归零',
    'attempt 清零',
    'attempt 置 0',
    'attempt 从头计',
  ];
  const missed = [];
  for (const v of VARIANTS) {
    const r = withMutatedFramework(
      (fw) => {
        const p = join(fw, 'orchestrator', 'protocol.md');
        writeFileSync(p, readFileSync(p, 'utf8') + `\n\n测试注入：${v}\n`);
      },
      (fw) => runLint(fw),
    );
    if (!/\[L3\]/.test(r.out)) missed.push(v);
  }
  expect('8 种写法全部被抓', missed.length === 0, `绕过: ${missed.join(' / ')}`);
}

console.log('case 8d: L3 不得误抓「不归零」这类正确表述');
{
  // 加强正则后立刻误抓了 10 处，全都是正确的否定表述：
  //   「attempt + 1（**不归零**，见 protocol.md §4.1）」
  // 规则本身是对的，不能判红。
  const r = withMutatedFramework(
    (fw) => {
      const p = join(fw, 'orchestrator', 'protocol.md');
      writeFileSync(p, readFileSync(p, 'utf8') + '\n\n测试注入：派发全新实例，attempt + 1（**不归零**）。\n');
    },
    (fw) => runLint(fw),
  );
  expect('「不归零」不算违规', !/\[L3\][\s\S]{0,120}不归零/.test(r.out),
    r.out.split('\n').filter((l) => l.includes('L3')).join('; '));
}

console.log('case 8e: L1 必须抓住「要求用户介入」的各种说法（红队实测 5/6 绕过）');
{
  // 2026-11-14 实测：原 WAIT_PATTERNS 是 5 条固定短语，
  // 「询问用户 / 向用户请示 / 提交给用户拍板 / 需要用户介入 / 等待使用者答复」
  // 全部绕过。而 L1 防的是整个框架最核心的失败模式（宣称无人值守却要人值守）。
  const BAD = [
    '遇到冲突时等用户决定。',
    '遇到冲突时询问用户。',
    '遇到冲突时向用户请示。',
    '遇到冲突时提交给用户拍板。',
    '遇到冲突时需要用户介入。',
    '遇到冲突时等待使用者答复。',
  ];
  const missed = [];
  for (const t of BAD) {
    const r = withMutatedFramework(
      (fw) => {
        const p = join(fw, 'orchestrator', 'protocol.md');
        writeFileSync(p, readFileSync(p, 'utf8') + '\n\n测试注入：' + t + '\n');
      },
      (fw) => runLint(fw),
    );
    if (!/\[L1\]/.test(r.out)) missed.push(t);
  }
  expect('6 种说法全部抓到', missed.length === 0, `绕过: ${missed.join(' / ')}`);
}

console.log('case 8f: L1 不得误伤「描述产物含义/禁止推给用户」这类合法表述');
{
  // 加强 L1 后实测误伤过 6 处，全是合法表述。判据要能区分
  // 「要求 agent 停下来等」和「描述字段含义 / 规定不得交给用户」。
  const LEGIT = [
    '向用户汇报时必须说「无法确认状态」',
    '列入「待人工裁决」；本轮 PARTIALLY_CLOSED',
    '在下一轮或人工介入后处理',
    '用户拿去决定修什么',
    '默认路径没有理由跑不完（无人工裁决触发点）',
    '那不在上述三条之内——是主 Agent 自己的判定职责，不是需要用户裁决的事项',
    '这正是用户明确反对的「把决定推回给用户」',
    '它们的读者是主Agent和人工：主Agent据此决定派发时机',
  ];
  const falsePositives = [];
  for (const t of LEGIT) {
    const r = withMutatedFramework(
      (fw) => {
        const p = join(fw, 'orchestrator', 'protocol.md');
        writeFileSync(p, readFileSync(p, 'utf8') + '\n\n测试注入：' + t + '\n');
      },
      (fw) => runLint(fw),
    );
    if (/\[L1\]/.test(r.out)) falsePositives.push(t);
  }
  expect('合法表述全部放行', falsePositives.length === 0,
    `误伤: ${falsePositives.map((x) => x.slice(0, 24)).join(' / ')}`);
}

console.log('case 8g: L4 必须抓住「停止条件表被压成一行」（红队实测可绕过）');
{
  // 原 L4 只查「全框架里有没有这四个词」，只要有一处出现就算齐备。
  // 实测把整张停止条件表替换成
  //   `max_rounds DEFERRED STALLED 自动开启下一轮`
  // 也能通过——四个词都在，但规则本身已经不存在了。
  // 修：要求这几个要素出现在同一张表里（>=3 行含要素的表格行）。
  const r = withMutatedFramework(
    (fw) => {
      const p = join(fw, 'artifacts', 'run-state.md');
      const lines = readFileSync(p, 'utf8').split('\n');
      let start = -1;
      for (let i = 0; i < lines.length; i++) {
        if (/^#{2,4}\s.*停止条件/.test(lines[i])) { start = i; break; }
      }
      if (start < 0) throw new Error('测试前提不成立：找不到停止条件小节');
      let tblStart = -1;
      for (let j = start + 1; j < lines.length; j++) {
        if (/^\s*\|/.test(lines[j])) { tblStart = j; break; }
        if (/^#{1,4}\s/.test(lines[j])) break;
      }
      let tblEnd = tblStart;
      if (tblStart >= 0) { while (tblEnd < lines.length && /^\s*\|/.test(lines[tblEnd])) tblEnd++; }
      writeFileSync(p, [
        ...lines.slice(0, tblStart),
        'max_rounds DEFERRED STALLED 自动开启下一轮',
        '',
        ...lines.slice(tblEnd),
      ].join('\n'));
    },
    (fw) => runLint(fw),
  );
  expect('报 L4（停止条件未被组织成表）', /\[L4\]/.test(r.out),
    r.out.split('\n').filter((l) => l.includes('L4')).join('; ') || r.out.slice(-300));
}

console.log('case 8b: L13 必须用词边界匹配 —— 字段名只作为更长字段的前缀时不得算「已定义」');
{
  // 2026-11-13 实测：L13 原来三处都用 .includes()（子串匹配）。
  // 而 ROLE_REQUIRED 里存在大量前缀关系：score/score_breakdown、
  // findings/findings_count、verdict/verdicts。
  // 若把 score 从契约里删干净、只留 score_breakdown，子串匹配会假绿。
  // 这里构造该情形：把所有独立的 score（含 `score`、`"score":`、`score = ...`）
  // 都替换掉，只保留 score_breakdown。
  const r = withMutatedFramework(
    (fw) => {
      const p = join(fw, 'components', 'output-contract.md');
      const s = readFileSync(p, 'utf8');
      // 用词边界替换：不处理 score_breakdown（它后面跟的是 _，\b 不匹配）
      const mutated = s.replace(/\bscore\b/g, '__GONE__');
      writeFileSync(p, mutated);
      // 前提校验：确认 score 真的删干净了，否则这个用例什么也没验证
      if (/\bscore\b/.test(mutated)) throw new Error('测试前提不成立：score 未被删干净');
      if (!/score_breakdown/.test(mutated)) throw new Error('测试前提不成立：score_breakdown 也被误删');
    },
    (fw) => runLint(fw),
  );
  expect('报 L13 score 未在契约定义', /\[L13\][\s\S]{0,300}score/.test(r.out),
    r.out.split('\n').filter((l) => l.includes('L13')).join('; ') || r.out.slice(-400));
}

console.log('case 9: 重复小节编号必须判红');
{
  const r = withMutatedFramework(
    (fw) => {
      const p = join(fw, 'MANUAL.md');
      writeFileSync(p, readFileSync(p, 'utf8') + '\n### 7.1 重复的小节\n\n### 7.1 又一个同号小节\n');
    },
    (fw) => runLint(fw),
  );
  expect('报 L10（小节编号重复）', /小节编号.*重复/.test(r.out), r.out.slice(-300));
}

console.log('case 10: L9 —— T2 只改一处必须判红（可维护性批判者实测的洞）');
{
  const r = withMutatedFramework(
    (fw) => {
      const p = join(fw, 'orchestrator', 'triage.md');
      const lines = readFileSync(p, 'utf8').split('\n');
      const idx = lines.findIndex((ln) => /^\s*\|\s*\*\*T2\*\*/.test(ln));
      if (idx >= 0) lines[idx] = lines[idx].replace(/\*\*9\*\*/, '**10**');
      writeFileSync(p, lines.join('\n'));
    },
    (fw) => runLint(fw),
  );
  expect('报 L9（T2 数字不一致）', /\[L9\].*T2.*不同取值/.test(r.out), r.out.slice(-400));
}

console.log('case 11: L17 —— 删掉交付粒度定义必须判红');
{
  const r = withMutatedFramework(
    (fw) => {
      const p = join(fw, 'orchestrator', 'protocol.md');
      const s = readFileSync(p, 'utf8').split('交付粒度').join('XXX').split('整个相位').join('YYY').split('允许中途停下').join('ZZZ');
      writeFileSync(p, s);
    },
    (fw) => runLint(fw),
  );
  expect('报 L17', /[L17]/.test(r.out), r.out.slice(-400));
}

console.log(`
=== 结果: ${pass} 通过 / ${fail} 失败 ===
`);
process.exit(fail > 0 ? 1 : 0);
