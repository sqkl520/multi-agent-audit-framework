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
