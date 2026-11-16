// Sensitivity harness: the baseline run found 0 extra findings on real data, which is only
// meaningful if the gate can find anything at all. So inject realistic weakenings into COPIES of
// the frozen snapshot and measure what the hybrid detector catches.
//
//   node mutations.mjs --snapshot out/snapshot/t0
//
// Nothing is written to the audited repo; mutations are applied in memory.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseAssertions } from './parse-assertions.mjs';

const args = process.argv.slice(2);
const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const snap = getArg('--snapshot', path.join(import.meta.dirname, 'out', 'snapshot', 't0'));
const outDir = getArg('--out', path.join(import.meta.dirname, 'out'));
mkdirSync(outDir, { recursive: true });
const manifest = JSON.parse(readFileSync(path.join(snap, 'manifest.json'), 'utf8'));
const byRel = new Map(manifest.files.map((f) => [f.rel, f]));

const TBL = 'src/test/java/com/hilltopvillage/mechanics/TabListManagerTest.java';
const SHOP = 'src/test/java/com/hilltopvillage/shop/ShopConfigLoaderTest.java';
const CM = 'src/test/java/com/hilltopvillage/config/ConfigManagerTest.java';
const BEETLE = 'src/test/java/com/hilltopvillage/ai/ExplodeBeetleGoalTest.java';
const AIRDROP = 'src/test/java/com/hilltopvillage/ai/AirdropSpawnGoalTest.java';

/* -------------------------------------------------- detector (verbatim copy of hybrid) */

function detect(oldSrc, newSrc) {
  const newP = parseAssertions(newSrc);
  const findings = [];
  if (oldSrc !== null) {
    const oldP = parseAssertions(oldSrc);
    for (const [subj, olds] of oldP.subjects) {
      if (!newP.subjects.has(subj)) findings.push({ rule: 'dropped', subject: subj, old: olds.map(f2) });
    }
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
    for (const [k, olds] of oi) {
      const news = ni.get(k);
      if (!news) continue;
      const osig = new Set(olds.map(f2)), nsig = new Set(news.map(f2));
      const lost = [...osig].filter((s) => !nsig.has(s));
      if (lost.length) findings.push({ rule: 'reversed', subject: k.split('::')[1], method: k.split('::')[0], lost, gained: [...nsig].filter((s) => !osig.has(s)) });
    }
  }
  const cd = (s) => s === null ? 0 : (s.match(/@Disabled\b|\b@Ignore\b|\bit\.skip\s*\(|@pytest\.mark\.skip/gi) ?? []).length;
  if (cd(newSrc) > cd(oldSrc)) findings.push({ rule: 'disabled' });
  return findings;
}
const f2 = (a) => `${a.pclass}(${a.expected})`;

/* ---------------------------------------------------------------- mutations */

// Each mutation: take current work content, apply a realistic "weakening" edit,
// declare whether it SHOULD be caught (true = a gate that aims at this must report).
const MUTS = [
  {
    id: 'M1 flip expected value in place',
    file: TBL, shouldCatch: true,
    why: 'assertEquals(20, field("scheduledPeriod")) -> 60 in the same method',
    apply: (s) => s.replace('assertEquals(20, field("scheduledPeriod"),', 'assertEquals(60, field("scheduledPeriod"),'),
  },
  {
    id: 'M2 negate a boolean assertion in place',
    file: BEETLE, shouldCatch: true,
    why: 'assertTrue(...) -> assertFalse(...) for a subject pinned only in that method',
    apply: (s) => {
      const i = s.indexOf('assertTrue(goal.shouldStayActive()');
      if (i < 0) return s;
      return s.slice(0, i) + 'assertFalse(goal.shouldStayActive()' + s.slice(i + 'assertTrue(goal.shouldStayActive()'.length);
    },
  },
  {
    id: 'M3 delete one assertion from a method that asserts the same subject twice',
    file: SHOP, shouldCatch: false, // removing a *duplicate* value is not a weakening
    why: 'drop one of two assertEquals(1, config.getItems().size()) in the same method',
    apply: (s) => {
      const needle = 'assertEquals(1, config.getItems().size(),\n                    "缺 price 仍是合法配置（默认 1），不得整条丢弃："';
      return s.replace(needle, '// removed by mutation\n                    "缺 price 仍是合法配置（默认 1），不得整条丢弃："');
    },
  },
  {
    id: 'M4 rename method AND flip its expected value',
    file: SHOP, shouldCatch: true,
    why: 'the exact "rename + reverse" combination: method scope loses the pair, file scope sees the subject elsewhere',
    apply: (s) => s.replace('void missingPriceDefaultsToOneWithWarning() throws IOException {', 'void missingPriceDefaultsToOneRenamed() throws IOException {')
      .replace('assertEquals(1, config.getItems().get(0).getPrice(),\n                    "缺键时 price 必须取既有默认值 1");', 'assertEquals(999, config.getItems().get(0).getPrice(),\n                    "缺键时 price 必须取既有默认值 1");'),
  },
  {
    id: 'M5 broaden equals -> assertTrue(expr)',
    file: CM, shouldCatch: true,
    why: 'assertEquals(7, config.getActiveConfig().getVictoryWaves()) -> assertTrue(config.getActiveConfig().getVictoryWaves() > 0)',
    apply: (s) => s.replace('assertEquals(7, config.getActiveConfig().getVictoryWaves(),', 'assertTrue(config.getActiveConfig().getVictoryWaves() > 0,'),
  },
  {
    id: 'M6 move assertion into a private helper (same file)',
    file: CM, shouldCatch: false,
    why: 'the plan says moving into a helper counts as "still there" — verify that is true',
    apply: (s) => s.replace('assertEquals(7, config.getActiveConfig().getVictoryWaves(),', 'assertVictory(7, config,\n                '),
  },
  {
    id: 'M7 drop an assertion line entirely (unique subject)',
    file: CM, shouldCatch: true,
    why: 'delete one assertFalse(config.getSettingsGate().isReadOnly(), ...) where the file has both polarities',
    apply: (s) => s.replace('        assertTrue(config.getSettingsGate().isReadOnly(),\n                "前置/结果校验：空文件必须让 settings 闸门锁定只读");\n', ''),
  },
  {
    id: 'M8 delete an entire @Test method',
    file: AIRDROP, shouldCatch: true,
    why: 'the most common real weakening: remove the test that would fail',
    apply: (s) => {
      const start = s.indexOf('    @Test\n    @DisplayName("★ 反证：airdrop-mob-type 为空白串');
      const end = s.indexOf('    @Test', start + 10);
      return s.slice(0, start) + s.slice(end);
    },
  },
];

/* ------------------------------------------------------------------- run */

const rows = [];
for (const m of MUTS) {
  const f = byRel.get(m.file);
  if (!f) { rows.push({ ...m, error: 'file missing' }); continue; }
  const before = f.workContent;
  const mutated = m.apply(before);
  if (mutated === before) { rows.push({ ...m, error: 'mutation did not apply (pattern not found)' }); continue; }
  const findings = detect(f.headContent, mutated);
  const caught = findings.length > 0;
  // also: does it catch it when the mutation is applied to a *new* file (no HEAD baseline)?
  const findingsNoBase = detect(null, mutated);
  rows.push({ ...m, caught, findings, findingsNoBase, correct: caught === m.shouldCatch });
}

const L = [];
L.push('# mutation sensitivity of the hybrid detector');
L.push('');
L.push('| # | mutation | should catch | caught | verdict |');
L.push('|---|---|---|---|---|');
for (const r of rows) {
  const verdict = r.error ? 'ERROR ' + r.error : (r.correct ? 'correct' : (r.shouldCatch ? 'MISS' : 'FALSE POSITIVE'));
  L.push(`| ${r.id.split(' ')[0]} | ${r.id.slice(3)} | ${r.shouldCatch} | ${r.caught} | ${verdict} |`);
}
L.push('');
for (const r of rows) {
  L.push(`\n## ${r.id}`);
  L.push(`file: ${r.file}`);
  L.push(`why: ${r.why}`);
  if (r.error) { L.push(`ERROR: ${r.error}`); continue; }
  L.push(`caught with HEAD baseline : ${r.caught}`);
  L.push(`caught with no baseline   : ${r.findingsNoBase.length > 0}`);
  if (r.findings.length) for (const f of r.findings) L.push(`   ${f.rule} ${f.subject ?? ''} ${f.lost ? JSON.stringify(f.lost) + ' -> ' + JSON.stringify(f.gained) : ''}`);
}
const caught = rows.filter((r) => r.caught).length;
const missed = rows.filter((r) => r.shouldCatch && !r.caught).length;
const fp = rows.filter((r) => !r.shouldCatch && r.caught).length;
L.push(`\n## totals: ${caught}/${rows.length} reported; ${missed} MISS; ${fp} false positive`);
writeFileSync(path.join(outDir, 'mutations.md'), L.join('\n'));
writeFileSync(path.join(outDir, 'mutations.json'), JSON.stringify(rows, null, 2));
console.log(L.join('\n'));
