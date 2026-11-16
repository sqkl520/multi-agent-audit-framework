// Fair mutation harness: runs the v4 detector (drop=file scope, reversal=method scope,
// moved-out-of-method=WARN) against realistic weakenings, including ones anchored on tests that
// EXIST IN HEAD (the gate can only see regressions w.r.t. HEAD, which is a real limitation).
//
//   node mutations-v4.mjs --snapshot out/snapshot/t0

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseAssertions } from './parse-assertions.mjs';
import { detectV4 } from './v4.mjs';

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
const PW = 'src/test/java/com/hilltopvillage/shop/ShopOverflowPaidDropTest.java';

// base: 'work' (mutate the current file, compare against HEAD) or 'head' (mutate HEAD, compare
// against HEAD — stands in for "the fixer weakens a pre-existing test")
const MUTS = [
  {
    id: 'M1 value flip, same method', base: 'work', file: TBL, expect: 'FAIL',
    note: 'assertEquals(20, field("scheduledPeriod")) -> 60',
    apply: (s) => s.replace('assertEquals(20, field("scheduledPeriod"),', 'assertEquals(60, field("scheduledPeriod"),'),
  },
  {
    id: 'M2 polarity flip on a boolean', base: 'work', file: BEETLE, expect: 'FAIL',
    note: 'assertTrue(goal.shouldStayActive()) -> assertFalse(...)',
    apply: (s) => {
      const i = s.indexOf('assertTrue(goal.shouldStayActive()');
      return i < 0 ? s : s.slice(0, i) + 'assertFalse(goal.shouldStayActive()' + s.slice(i + 'assertTrue(goal.shouldStayActive()'.length);
    },
  },
  {
    id: 'M3 remove ONE of two same-subject asserts in a method', base: 'head', file: TBL, expect: 'none',
    note: 'not a weakening: a duplicate value remains in the same method',
    apply: (s) => {
      // the HEAD version of refreshFailureIsContained asserts refreshTask twice (null + notnull elsewhere);
      // remove one occurrence of assertNull(field("refreshTask") in a method that keeps another
      const i = s.indexOf('assertNull(field("refreshTask"), "stop() 后句柄必须归 null");');
      return i < 0 ? s : s.slice(0, i) + '/* removed */' + s.slice(i + 'assertNull(field("refreshTask"), "stop() 后句柄必须归 null");'.length);
    },
  },
  {
    id: 'M4 rename method AND flip value', base: 'round2', file: SHOP, expect: 'none-or-miss',
    note: 'the exact rename+reverse combination; HEAD-vs-work rename also means the method disappears',
    apply: (s) => s
      .replace('void missingPriceDefaultsToOneWithWarning() throws IOException {', 'void missingPriceDefaultsToOneRenamed() throws IOException {')
      .replace('assertEquals(1, config.getItems().get(0).getPrice(),\n                    "缺键时 price 必须取既有默认值 1");', 'assertEquals(999, config.getItems().get(0).getPrice(),\n                    "缺键时 price 必须取既有默认值 1");'),
  },
  {
    id: 'M5 broaden assertEquals -> assertTrue(expr)', base: 'round2', file: CM, expect: 'WARN',
    note: 'assertEquals(7, X) -> assertTrue(X > 0) — the "broadened" predicate class',
    apply: (s) => s.replace('assertEquals(7, config.getActiveConfig().getVictoryWaves(),', 'assertTrue(config.getActiveConfig().getVictoryWaves() > 0,'),
  },
  {
    id: 'M6 move assertion into a private helper (same file)', base: 'round2', file: CM, expect: 'none',
    note: 'plan explicitly wants this to count as "still there"',
    apply: (s) => s.replace('assertEquals(7, config.getActiveConfig().getVictoryWaves(),', 'assertVictory(7, config,\n                '),
  },
  {
    id: 'M7 delete one assertion (subject survives elsewhere)', base: 'round2', file: CM, expect: 'WARN',
    note: 'the M5-style deletion that hybrid silently swallowed',
    apply: (s) => s.replace('        assertTrue(config.getSettingsGate().isReadOnly(),\n                "前置/结果校验：空文件必须让 settings 闸门锁定只读");\n', ''),
  },
  {
    id: 'M8 delete a whole pre-existing @Test method', base: 'head', file: PW, expect: 'FAIL',
    note: 'removes an old test entirely; subjects that survive elsewhere in the file are invisible to rule 1',
    apply: (s) => {
      const start = s.indexOf('        @Test\n        @DisplayName("对照：带「别的」PDC 键的掉落物仍被删除');
      if (start < 0) return s;
      // cut to the start of the NEXT @Test or @BeforeEach, whichever comes first: the previous cut
      // ran to the next '@Test' and swallowed setUp(), which inflated the finding count
      const nextTest = s.indexOf('        @Test', start + 12);
      const nextBefore = s.indexOf('        @BeforeEach', start + 12);
      const cands = [nextTest, nextBefore].filter((x) => x > 0);
      const end = cands.length ? Math.min(...cands) : -1;
      return end < 0 ? s : s.slice(0, start) + s.slice(end);
    },
  },
  {
    id: 'M9 wrap unique subject in if(true)-style dead branch', base: 'head', file: CM, expect: 'WARN-or-MISS',
    note: 'assertion still textually present, but only runs conditionally — text-level detection cannot see it',
    apply: (s) => {
      const needle = '        assertFalse(config.hasUnsavedChanges(),';
      const i = s.indexOf(needle);
      if (i < 0) return s;
      return s.slice(0, i) + '        if (System.nanoTime() > 0) {\n' + s.slice(i);
    },
  },
];

const rows = [];
for (const m of MUTS) {
  const f = byRel.get(m.file);
  if (!f) { rows.push({ ...m, error: 'file missing' }); continue; }
  const baseSrc = m.base === 'head' ? f.headContent : f.workContent;
  if (baseSrc === null) { rows.push({ ...m, error: 'no HEAD version' }); continue; }
  const mutated = m.apply(baseSrc);
  if (mutated === baseSrc) { rows.push({ ...m, error: 'pattern not found' }); continue; }
  const headSrc = m.base === 'head' ? baseSrc : f.headContent;
  // round2 == "the baseline ref is the CURRENT work tree", i.e. fix round N+1
  const baseRef = m.base === 'round2' ? f.workContent : headSrc;
  const { findings } = detectV4(baseRef, mutated);
  const sev = findings.length ? findings.map((x) => x.severity).sort()[0] : 'none';
  rows.push({ ...m, findings, severity: sev, reported: findings.length > 0 });
}

const L = [];
L.push('# mutation sensitivity, v4 detector');
L.push('');
L.push('| # | mutation | base | expected | actual | verdict |');
L.push('|---|---|---|---|---|---|');
for (const r of rows) {
  const verdict = r.error ? 'ERROR: ' + r.error
    : (r.expected === 'none' ? (r.reported ? 'FALSE POSITIVE' : 'correct')
      : r.expected === 'FAIL' ? (r.findings.some((x) => x.severity === 'FAIL') ? 'correct' : 'MISS')
        : r.reported ? 'correct (weaker severity)' : 'MISS');
  L.push(`| ${r.id.split(' ')[0]} | ${r.id.slice(3)} | ${r.base} | ${r.expected} | ${r.severity} | ${verdict} |`);
}
L.push('');
for (const r of rows) {
  L.push(`\n## ${r.id}`);
  L.push(`${r.file.split('/').pop()}  note: ${r.note}`);
  if (r.error) { L.push('ERROR: ' + r.error); continue; }
  if (!r.findings.length) L.push('  (no findings)');
  for (const f of r.findings) {
    L.push(`  [${f.severity}] ${f.rule}  ${f.subject}${f.method ? ' @' + f.method : ''}`);
    if (f.lost) L.push(`     lost=${JSON.stringify(f.lost)} gained=${JSON.stringify(f.new)}`);
    if (f.foundIn) L.push(`     foundIn=${f.foundIn.join(', ')}`);
  }
}
writeFileSync(path.join(outDir, 'mutations-v4.md'), L.join('\n'));
writeFileSync(path.join(outDir, 'mutations-v4.json'), JSON.stringify(rows, null, 2));
console.log(L.join('\n'));
