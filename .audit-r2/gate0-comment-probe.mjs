// 门 0 的现实检验：契约里的「注释不是证据」这条规则，校验器到底执行了没有？
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = process.cwd();
const D = join(ROOT, '.probe-gate0');
rmSync(D, { recursive: true, force: true });
mkdirSync(D, { recursive: true });

// 造一个被审仓库：第 10 行是注释，第 11 行是真实代码
const REPO = join(D, 'repo');
mkdirSync(REPO, { recursive: true });
writeFileSync(join(REPO, 'Target.java'), [
  'public class Target {',            // 1
  '  void a() {}',                    // 2
  '  void b() {}',                    // 3
  '  void c() {}',                    // 4
  '  void d() {}',                    // 5
  '  void e() {}',                    // 6
  '  void f() {}',                    // 7
  '  void g() {}',                    // 8
  '  void h() {}',                    // 9
  '  // 不安全版本：容量检查写错',      // 10  ← 纯注释
  '    int x = arr[i];',              // 11  ← 真实代码
  '}',
].join('\n'));

function artifact(name, quote, line) {
  const dir = join(D, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'round1-02-audit-S1-logic.md'), `# audit

\`\`\`json
{
  "schema_version": "1.0",
  "role": "audit",
  "status": "SUCCESS",
  "slice_id": "S1",
  "attempt": 1,
  "files_read": ["Target.java"],
  "findings": [
    {
      "local_id": "F1",
      "title": "probe",
      "severity": "high",
      "file": "Target.java",
      "line": ${line},
      "evidence": { "file": "Target.java", "line": ${line}, "quote": ${JSON.stringify(quote)} },
      "problem": "probe problem text that is long enough to pass",
      "inference": { "claim": "probe claim", "basis": "probe basis", "alternatives": ["none"] }
    }
  ],
  "counts": { "findings": 1 }
}
\`\`\`
`);
  return dir;
}

const cases = [
  ['注释当证据（契约明令禁止）', artifact('c1', '// 不安全版本：容量检查写错', 10)],
  ['引用真实代码行（应通过）', artifact('c2', 'int x = arr[i];', 11)],
  ['编造的 quote（应失败）', artifact('c3', 'return voidMagic();', 11)],
];

for (const [label, dir] of cases) {
  let out = '', code = 0;
  try {
    out = execFileSync('node', ['tools/verify-artifacts.mjs', '--repo', REPO, '--artifacts', dir],
      { encoding: 'utf8', cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    code = e.status ?? 'SIG';
    out = (e.stdout ?? '') + (e.stderr ?? '');
  }
  const relevant = out.split('\n').filter((l) => /G0|合计|注释|FAIL|WARN/.test(l)).join('\n');
  console.log('─'.repeat(70));
  console.log('场景: ' + label);
  console.log('exit=' + code);
  console.log(relevant.split('\n').slice(0, 8).join('\n'));
  console.log('');
}
rmSync(D, { recursive: true, force: true });
