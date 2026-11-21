// check-bilingual-links 自测
//
// 关键是 case 2 和 case 3：这两种坏法都不是"写得不好看"，是读者实际走不通。
//   404 —— 文件改名了，链接没改
//   单向 —— A 指向 B，B 里没有指回 A
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, 'check-bilingual-links.mjs');

let pass = 0, fail = 0;
const expect = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

/** 在临时副本上跑，可任意改写文档 */
function withCopy(mutator, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'bi-'));
  mkdirSync(join(dir, 'tools'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'i18n'), { recursive: true });
  cpSync(TOOL, join(dir, 'tools', 'check-bilingual-links.mjs'));

  // 最小可用的双语集合（与真实仓库同构）
  writeFileSync(join(dir, 'README.md'), '[English](README.en.md) | 简体中文\n\n# 标题\n');
  writeFileSync(join(dir, 'README.en.md'), '[简体中文](README.md) | English\n\n# Title\n');
  writeFileSync(join(dir, 'CONTRIBUTING.md'), '[简体中文](docs/i18n/CONTRIBUTING.zh-CN.md) | English\n\n# Contributing\n');
  writeFileSync(join(dir, 'docs/i18n/CONTRIBUTING.zh-CN.md'), '[English](../../CONTRIBUTING.md) | 简体中文\n\n# 贡献\n');
  writeFileSync(join(dir, 'SECURITY.md'), '[简体中文](docs/i18n/SECURITY.zh-CN.md) | English\n\n# Security\n');
  writeFileSync(join(dir, 'docs/i18n/SECURITY.zh-CN.md'), '[English](../../SECURITY.md) | 简体中文\n\n# 安全\n');
  writeFileSync(join(dir, 'CODE_OF_CONDUCT.md'), '[简体中文](docs/i18n/CODE_OF_CONDUCT.zh-CN.md) | English\n\n# CoC\n');
  writeFileSync(join(dir, 'docs/i18n/CODE_OF_CONDUCT.zh-CN.md'), '[English](../../CODE_OF_CONDUCT.md) | 简体中文\n\n# 行为准则\n');

  mutator(dir);
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function run(dir, extra = []) {
  try {
    const out = execFileSync(process.execPath,
      [join(dir, 'tools', 'check-bilingual-links.mjs'), '--json', ...extra], { encoding: 'utf8' });
    return { code: 0, data: JSON.parse(out) };
  } catch (e) {
    const out = e.stdout?.toString() ?? '';
    try { return { code: e.status, data: JSON.parse(out) }; }
    catch { return { code: e.status, data: null, raw: out, err: e.stderr?.toString() }; }
  }
}

console.log('\n=== check-bilingual-links 自测 ===\n');

console.log('case 1: 完整双向互链 → 通过');
{
  withCopy(() => {}, (dir) => {
    const r = run(dir);
    expect('exit 0', r.code === 0, `code=${r.code}`);
    expect('4 对全部互通', r.data?.checked === 4, `checked=${r.data?.checked}`);
    rmSync(dir, { recursive: true, force: true });
  });
}

console.log('case 2: 英文文件改名但中文链接没改 → L2（点进去 404）');
{
  withCopy((dir) => {
    // 模拟真实事故：README-EN.md → README.en.md，但中文那边还指着旧的
    writeFileSync(join(dir, 'README.md'), '[English](README-EN.md) | 简体中文\n\n# 标题\n');
  }, (dir) => {
    const r = run(dir);
    expect('exit 1', r.code === 1, `code=${r.code}`);
    const hit = (r.data?.problems ?? []).some((p) => p.id === 'L2');
    expect('报 L2（目标不存在）', hit, JSON.stringify((r.data?.problems ?? []).map((p) => p.id)));
    rmSync(dir, { recursive: true, force: true });
  });
}

console.log('case 3: 单边删除回链 → L3（点进去回不来）');
{
  withCopy((dir) => {
    // 英文那版首行没指回中文
    writeFileSync(join(dir, 'README.en.md'), '# Title\n\nNo language switch here.\n');
  }, (dir) => {
    const r = run(dir);
    expect('exit 1', r.code === 1, `code=${r.code}`);
    const hit = (r.data?.problems ?? []).some((p) => p.id === 'L3');
    expect('报 L3（单向链接）', hit, JSON.stringify((r.data?.problems ?? []).map((p) => p.id)));
    rmSync(dir, { recursive: true, force: true });
  });
}

console.log('case 4: 首行是普通标题不是互链 → L1');
{
  withCopy((dir) => {
    writeFileSync(join(dir, 'SECURITY.md'), '# Security Policy\n\n[简体中文](docs/i18n/SECURITY.zh-CN.md)\n');
  }, (dir) => {
    const r = run(dir);
    const hit = (r.data?.problems ?? []).some((p) => p.id === 'L1');
    expect('报 L1', hit, JSON.stringify((r.data?.problems ?? []).map((p) => p.id)));
    rmSync(dir, { recursive: true, force: true });
  });
}

console.log('case 5: 首行前有空行 / BOM 也不算错（真实文件常有）');
{
  withCopy((dir) => {
    writeFileSync(join(dir, 'README.md'), '﻿\n\n[English](README.en.md) | 简体中文\n\n# 标题\n');
  }, (dir) => {
    const r = run(dir);
    expect('不报 L1', !(r.data?.problems ?? []).some((p) => p.id === 'L1'),
      JSON.stringify((r.data?.problems ?? []).map((p) => p.id)));
    rmSync(dir, { recursive: true, force: true });
  });
}

console.log('case 6: 一对文件全删 → 分母为 0 相关判定');
{
  withCopy((dir) => {
    // 删掉所有配对，只剩配对表里的名字 → 全是 L0
    for (const f of ['README.md', 'README.en.md', 'CONTRIBUTING.md', 'docs/i18n/CONTRIBUTING.zh-CN.md',
      'SECURITY.md', 'docs/i18n/SECURITY.zh-CN.md', 'CODE_OF_CONDUCT.md', 'docs/i18n/CODE_OF_CONDUCT.zh-CN.md']) {
      rmSync(join(dir, f), { force: true });
    }
  }, (dir) => {
    const r = run(dir);
    expect('exit 1', r.code === 1, `code=${r.code}`);
    expect('报 L0（文件不存在）', (r.data?.problems ?? []).some((p) => p.id === 'L0'),
      JSON.stringify((r.data?.problems ?? []).map((p) => p.id)));
    rmSync(dir, { recursive: true, force: true });
  });
}

console.log('case 7: 规则命名与实际不一致 → 报 L4 但不判失败');
{
  // 这是本仓库的真实情况：规则写 README-EN.md，实际用 README.en.md（GitHub 官方命名）
  withCopy(() => {}, (dir) => {
    const r = run(dir);
    expect('exit 0（L4 不判失败）', r.code === 0, `code=${r.code}`);
    expect('报 L4', (r.data?.warnings ?? []).some((w) => w.id === 'L4'),
      JSON.stringify((r.data?.warnings ?? []).map((w) => w.id)));
    rmSync(dir, { recursive: true, force: true });
  });
}

console.log('case 8: --strict 时 L4 也算失败');
{
  withCopy(() => {}, (dir) => {
    const r = run(dir, ['--strict']);
    expect('exit 1', r.code === 1, `code=${r.code}`);
    rmSync(dir, { recursive: true, force: true });
  });
}

console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail > 0 ? 1 : 0);
