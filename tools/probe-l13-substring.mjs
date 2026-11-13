// 探针：L13 对「自动提取字段」的契约检查用的是子串匹配（includes），
// 这会把「字段 A 是字段 B 的前缀」误判成「A 在契约里有定义」。
// 本脚本对照「子串命中」与「词边界命中」，列出所有假绿。
import { readFileSync } from 'node:fs';

const tool = readFileSync('tools/check-payload.mjs', 'utf8');
const contract =
  readFileSync('framework/components/output-contract.md', 'utf8') +
  readFileSync('framework/artifacts/run-state.md', 'utf8');

const block = tool.match(/const ROLE_REQUIRED\s*=\s*\{([\s\S]*?)\n\};/);
if (!block) {
  console.error('无法解析 ROLE_REQUIRED');
  process.exit(2);
}

const fields = new Set();
for (const m of block[1].matchAll(/^\s*(\w+):\s*\[([^\]]*)\]/gm)) {
  for (const f of m[2].split(',').map((x) => x.trim().replace(/['"]/g, '')).filter(Boolean)) {
    fields.add(f);
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

console.log('ROLE_REQUIRED 字段总数:', fields.size);
console.log('');
console.log('字段'.padEnd(26) + '子串命中'.padEnd(12) + '词边界命中'.padEnd(14) + '备注');

let falseGreen = 0;
let genuinelyMissing = 0;
const rows = [];

for (const f of [...fields].sort()) {
  const substring = contract.includes(f);
  const wordBoundary = new RegExp(`\\b${escapeRe(f)}\\b`).test(contract);

  let note = '';
  if (substring && !wordBoundary) {
    falseGreen++;
    // 找出是谁把它"顶替"了
    const m = contract.match(new RegExp(`\\b\\w*${escapeRe(f)}\\w*\\b`));
    note = `← 仅子串命中，实际出现的是 ${m ? m[0] : '?'}`;
  } else if (!substring) {
    genuinelyMissing++;
    note = '← 契约里完全没有';
  }
  if (note) rows.push(`${f.padEnd(26)}${String(substring).padEnd(12)}${String(wordBoundary).padEnd(14)}${note}`);
}

for (const r of rows) console.log(r);

console.log('');
console.log(`仅子串命中（L13 会放行但实际未定义）：${falseGreen}`);
console.log(`契约里完全没有（L13 应报 FAIL）：${genuinelyMissing}`);
