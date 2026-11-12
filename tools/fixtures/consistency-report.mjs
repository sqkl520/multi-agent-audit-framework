import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const R = path.resolve(process.argv[2]);
const scoreScript = path.join(R, 'fixture2', 'score.mjs');

// 收集所有报告
const reports = fs.readdirSync(R).filter((f) => /^SP-P[4-7]-[abc]\.md$/.test(f)).sort();

const hits = {};
for (const f of reports) {
  const key = f.replace('.md', '');
  try {
    const out = execFileSync('node', [scoreScript, path.join(R, f)], { encoding: 'utf8' });
    hits[key] = out.split('\n').filter((l) => /★/.test(l)).map((l) => l.trim().split(/\s+/)[1]);
  } catch {
    hits[key] = [];
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(R, 'fixture2', 'manifest.json'), 'utf8'));
const ALL = manifest.defects.map((d) => d.id);

// ── 按提示词分组 ──
const groups = { P4: [], P5: [], P6: [], P7: [] };
for (const k of Object.keys(hits)) {
  const g = k.slice(3, 5);
  if (groups[g]) groups[g].push(k);
}

const pairstats = (a, b) => {
  const A = new Set(hits[a]), B = new Set(hits[b]);
  const inter = [...A].filter((x) => B.has(x)).length;
  const union = new Set([...A, ...B]).size;
  return { inter, union, jaccard: union ? inter / union : 0 };
};

console.log('\n=== 现有 12 份报告的 agent 间一致性 ===\n');
console.log('注意：这是 4 种不同提示词产生的，含提示词差异，只能当基线。\n');

let allJ = [];
for (const [g, members] of Object.entries(groups)) {
  console.log(`--- ${g}（同提示词，3 个独立 agent）---`);
  const js = [];
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const s = pairstats(members[i], members[j]);
      js.push(s.jaccard);
      allJ.push(s.jaccard);
      console.log(`  ${members[i]} vs ${members[j]}  交集 ${String(s.inter).padStart(2)} / 并集 ${String(s.union).padStart(2)}  Jaccard ${s.jaccard.toFixed(3)}`);
    }
  }
  if (js.length) {
    const avg = js.reduce((a, b) => a + b, 0) / js.length;
    console.log(`  → 组内平均 Jaccard ${avg.toFixed(3)}\n`);
  }
}

// ── 每条缺陷被多少个 agent 找到 ──
console.log('=== 每条缺陷的检出分布（12 份报告）===\n');
console.log('缺陷    检出数  比例    判断');
const counts = ALL.map((id) => ({ id, n: Object.values(hits).filter((h) => h.includes(id)).length }));
counts.sort((a, b) => b.n - a.n || a.id.localeCompare(b.id));
for (const c of counts) {
  const r = c.n / reports.length;
  const verdict = r >= 0.9 ? '几乎所有 agent 都找到' : r <= 0.2 ? '几乎没人找到' : r >= 0.5 ? '多数找到' : '少数找到';
  console.log(`${c.id}    ${String(c.n).padStart(2)}    ${(r * 100).toFixed(0).padStart(3)}%   ${verdict}`);
}

// ── 全体一致 / 全体遗漏 ──
const unanimousYes = counts.filter((c) => c.n === reports.length).map((c) => c.id);
const unanimousNo = counts.filter((c) => c.n === 0).map((c) => c.id);
console.log(`\n全体一致命中（12/12）: ${unanimousYes.join(', ') || '无'}`);
console.log(`全体遗漏（0/12）: ${unanimousNo.join(', ') || '无'}`);

// ── 总体 Jaccard ──
const avgAll = allJ.reduce((a, b) => a + b, 0) / allJ.length;
console.log(`\n全部两两平均 Jaccard: ${avgAll.toFixed(3)}（${allJ.length} 对）`);

// ── 期望值：如果每个 agent 随机报 k 条，两个随机集合的 Jaccard 是多少 ──
console.log('\n=== 随机基线对照 ===\n');
const avgSize = Object.values(hits).reduce((s, h) => s + h.length, 0) / reports.length;
const N = ALL.length;
const expInter = (avgSize * avgSize) / N;
const expUnion = avgSize + avgSize - expInter;
console.log(`平均每份报告命中 ${avgSize.toFixed(1)} / ${N} 条`);
console.log(`若随机挑选，两两期望交集 ${expInter.toFixed(2)}，并集 ${expUnion.toFixed(2)}，Jaccard ≈ ${(expInter / expUnion).toFixed(3)}`);
console.log(`实际 ${avgAll.toFixed(3)} vs 随机 ${(expInter / expUnion).toFixed(3)} → 比值 ${(avgAll / (expInter / expUnion)).toFixed(2)}x`);
