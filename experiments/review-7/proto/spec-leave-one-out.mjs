// Verify the SHIPPED spec implementation reproduces the reported leave-one-out recall,
// and that @Disabled("@param") is caught. Run against the frozen snapshot.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseAssertions, maskSource, detect } from './check-test-assertion-diff.mjs';

const root = import.meta.dirname;
const manifest = JSON.parse(readFileSync(path.join(root, 'out', 'snapshot', 't0', 'manifest.json'), 'utf8'));
const files = manifest.files.filter((f) => f.rel.endsWith('.java') && f.rel.includes('src/test') && f.headContent !== null);

function testMethods(src) {
  const { code } = maskSource(src);
  const out = []; const re = /@(?:Test|ParameterizedTest)\b/g; let m;
  while ((m = re.exec(code))) {
    const i = m.index; let found = null;
    for (let k = i; k < Math.min(code.length, i + 800); k++) {
      if (code[k] !== '{') continue;
      let p = k - 1; while (p > i && /\s/.test(code[p])) p--;
      if (code[p] !== ')') continue;
      let d = 0, q = p;
      for (; q > i; q--) { if (code[q] === ')') d++; else if (code[q] === '(') { d--; if (!d) break; } }
      if (q <= i) continue;
      let r = q - 1; while (r > i && /\s/.test(code[r])) r--;
      const ne = r; while (r > i && /[\w$]/.test(code[r])) r--;
      const nm = code.slice(r + 1, ne + 1);
      if (/^[A-Za-z_$][\w$]*$/.test(nm) && !['if','for','while','switch','catch','try'].includes(nm)) { found = { brace: k, name: nm }; break; }
    }
    if (!found) continue;
    let dd = 0, close = -1;
    for (let k = found.brace; k < code.length; k++) { if (code[k] === '{') dd++; else if (code[k] === '}') { dd--; if (!dd) { close = k; break; } } }
    if (close > 0) out.push({ name: found.name, start: i, end: close + 1 });
    re.lastIndex = close > 0 ? close : i + 5;
  }
  return out;
}

for (const [label, pick] of [['baseline=HEAD', (f) => f.headContent], ['baseline=prev-round', (f) => f.workContent]]) {
  let total = 0, caught = 0;
  for (const f of files) {
    for (const meth of testMethods(f.workContent)) {
      const mut = f.workContent.slice(0, meth.start) + f.workContent.slice(meth.end);
      if (mut === f.workContent) continue;
      total++;
      if (detect(pick(f), mut, { rel: f.rel }).findings.filter((x) => x.severity === 'FAIL' || x.rule !== 'assertion_assumption_added').length) caught++;
    }
  }
  console.log(`${label}: ${caught}/${total} = ${(caught / total * 100).toFixed(1)}%`);
}

// @Disabled forms through the shipped spec
const f0 = manifest.files.find((f) => f.rel.includes('ShopConfigCorruptFileTest'));
const anchor = '    @Test\n    @DisplayName("F1: invalid shop.yml';
for (const [k, v] of Object.entries({
  'bare @Disabled': f0.workContent.replace(anchor, '    @Test\n    @Disabled\n    @DisplayName("F1: invalid shop.yml'),
  '@Disabled("reason")': f0.workContent.replace(anchor, '    @Test\n    @Disabled("flaky")\n    @DisplayName("F1: invalid shop.yml'),
  'Assumptions.assumeTrue': f0.workContent.replace('    void corruptFileDoesNotReturnEmptyShop() throws IOException {', '    void corruptFileDoesNotReturnEmptyShop() throws IOException {\n        org.junit.jupiter.api.Assumptions.assumeTrue(true);'),
})) {
  const r = detect(f0.headContent, v, { rel: f0.rel });
  console.log(k.padEnd(24), '->', r.findings.filter((x) => x.rule.startsWith('test') || x.rule.includes('assumption')).map((x) => `${x.rule}:${x.severity}`).join(',') || 'none');
}
