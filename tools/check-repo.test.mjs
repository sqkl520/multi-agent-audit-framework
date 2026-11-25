// check-repo 自测
//
// 这条检查的价值全在「分母」上：
//   · TARGETS 里少列一个 → 那个校验器回到「只跑自测」的状态，而 CI 全绿
//   · SKIPPED 里空理由 → 「因为懒得接」被伪装成「需要运行时输入」
//   · 跑了但退出码没被读 → 又一个 stop-hook.test.mjs 式的永远绿
//
// 2026-11-25 锐评实测把第一版打穿了三条（C1/C2/C3），这个文件是重写后的自测：
//   每条都被锐评**实际演示过**能骗过旧判据，现在必须反过来——骗不过去。
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, 'check-repo.mjs');
const REAL_SRC = readFileSync(TOOL, 'utf8');

let pass = 0, fail = 0;
const expect = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const dirs = [];

/** 假的「需要运行时输入的校验器」：无参数 exit 2 并打用法 */
const USAGE_SCRIPT = "if (process.argv.length < 3) { console.error('用法: need --x'); process.exit(2); }\nprocess.exit(0);\n";

/**
 * 在临时仓库里跑一份被改过的 check-repo。
 * @param {object} o
 *   targets / skipped / manual / exempt  对应四张表；undefined = 保留原文
 *   files    { 相对路径: 内容 }
 *   baseline 写进 fixtures/repo-targets-baseline.json 的 targets 数组；null = 不写
 */
function mkAndRun({ targets, skipped, manual, exempt, files = {}, baseline } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cr-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'tools'), { recursive: true });

  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }

  let src = REAL_SRC;
  const repl = (name, val) => {
    const re = new RegExp(`const ${name} = \\[[\\s\\S]*?\\n\\];`);
    if (!re.test(src)) throw new Error(`can't find ${name} in check-repo.mjs`);
    src = src.replace(re, `const ${name} = ${JSON.stringify(val, null, 2)};`);
  };
  if (targets !== undefined) repl('TARGETS', targets);
  if (skipped !== undefined) repl('SKIPPED', skipped);
  if (manual !== undefined) repl('MANUAL_ONLY', manual);
  if (exempt !== undefined) repl('EXEMPT_NO_ARG_FAIL', exempt);
  writeFileSync(join(dir, 'tools', 'check-repo.mjs'), src);

  if (baseline !== null) {
    const b = baseline ?? (targets ?? []).map((t) => t.script);
    mkdirSync(join(dir, 'tools', 'fixtures'), { recursive: true });
    writeFileSync(join(dir, 'tools', 'fixtures', 'repo-targets-baseline.json'),
      JSON.stringify({ targets: b }, null, 2));
  }

  try {
    const out = execFileSync(process.execPath, [join(dir, 'tools', 'check-repo.mjs'), '--json'],
      { encoding: 'utf8', stdio: 'pipe', timeout: 120000 });
    return { code: 0, data: JSON.parse(out) };
  } catch (e) {
    const out = e.stdout?.toString() ?? '';
    try { return { code: e.status ?? 1, data: JSON.parse(out) }; }
    catch { return { code: e.status ?? 1, data: null, raw: out + (e.stderr ?? '') }; }
  }
}

const cfg = (r) => JSON.stringify(r.data?.configErrors ?? []);

console.log('\n=== check-repo 自测 ===\n');

console.log('case 1: 目标校验器全部 exit 0 → 通过');
{
  const r = mkAndRun({
    targets: [{ script: 'ok.mjs', args: [], why: '总是通过' }],
    skipped: [], manual: [], exempt: [],
    files: { 'tools/ok.mjs': 'console.log("✓ 好");\nprocess.exit(0);\n' },
  });
  expect('exit 0', r.code === 0, `${r.code}: ${r.raw ?? cfg(r)}`);
  expect('ran=1 failed=0', r.data?.ran === 1 && r.data?.failed?.length === 0, JSON.stringify(r.data?.failed));
}

console.log('case 2: 任一目标 exit 1 → 失败（退出码必须被读，不能只看输出）');
{
  const r = mkAndRun({
    targets: [
      { script: 'ok.mjs', args: [], why: '通过' },
      { script: 'bad.mjs', args: [], why: '必须失败' },
    ],
    skipped: [], manual: [], exempt: [],
    files: {
      'tools/ok.mjs': 'console.log("✓ 好");\nprocess.exit(0);\n',
      'tools/bad.mjs': 'console.log("✓ 看起来很好"); process.exit(1);\n',
    },
  });
  expect('exit 1', r.code === 1, `实际 ${r.code}`);
  expect('failed 里点名 bad.mjs', r.data?.failed?.some((f) => f.script === 'bad.mjs'), JSON.stringify(r.data?.failed));
}

console.log('case 3: SKIPPED 里理由为空 → exit 2');
{
  const r = mkAndRun({
    targets: [{ script: 'ok.mjs', args: [], why: '通过' }],
    skipped: [{ script: 'usage.mjs', reason: '' }],
    manual: [], exempt: [],
    files: { 'tools/ok.mjs': 'process.exit(0);\n', 'tools/usage.mjs': USAGE_SCRIPT },
  });
  expect('exit 2', r.code === 2, `实际 ${r.code}`);
  expect('说明是理由缺失', cfg(r).includes('理由'), cfg(r));
}

console.log('case 4: SKIPPED 里的脚本不存在 → exit 2（改名后忘了同步）');
{
  const r = mkAndRun({
    targets: [{ script: 'ok.mjs', args: [], why: '通过' }],
    skipped: [{ script: 'ghost.mjs', reason: '这是一个足够长的理由用于测试' }],
    manual: [], exempt: [],
    files: { 'tools/ok.mjs': 'process.exit(0);\n' },
  });
  expect('exit 2', r.code === 2, `实际 ${r.code}`);
  expect('点名 ghost.mjs', cfg(r).includes('ghost.mjs'), cfg(r));
}

console.log('case 5: TARGETS 为空 → exit 2（一份都没跑不能算通过）');
{
  const r = mkAndRun({ targets: [], skipped: [], manual: [], exempt: [], baseline: [] });
  expect('exit 2', r.code === 2, `实际 ${r.code}`);
  expect('说明分母为 0', cfg(r).includes('为空'), cfg(r));
}

console.log('case 6: TARGETS 与 SKIPPED 同时收录同一脚本 → exit 2（自相矛盾）');
{
  const r = mkAndRun({
    targets: [{ script: 'usage.mjs', args: [], why: '通过' }],
    skipped: [{ script: 'usage.mjs', reason: '这是一个足够长的理由用于测试' }],
    manual: [], exempt: [],
    files: { 'tools/usage.mjs': USAGE_SCRIPT },
  });
  expect('exit 2', r.code === 2, `实际 ${r.code}`);
  expect('说明自相矛盾', cfg(r).includes('自相矛盾'), cfg(r));
}

// ── C1：SKIPPED 是后门吗 ──
console.log('case 7 (C1): 把一个其实能跑的校验器藏进 SKIPPED → R1 当场判红');
{
  // 锐评实测：旧版把 check-doc-counts 从 TARGETS 挪进 SKIPPED、编一句 22 字的理由，
  // check-repo 与 check-test-registration 同时变绿 —— 这轮改动可原样撤销。
  // 现在 R1 会真的用无参数跑它一次：能跑通的脚本不会 exit 2。
  const r = mkAndRun({
    targets: [{ script: 'ok.mjs', args: [], why: '通过' }],
    skipped: [{ script: 'runnable.mjs', reason: '该检查器需要现场运行时输入，暂不纳入仓库自检' }],
    manual: [], exempt: [],
    files: {
      'tools/ok.mjs': 'process.exit(0);\n',
      // 一个能在本仓库跑通的校验器：无参数也 exit 0
      'tools/runnable.mjs': 'console.log("✓ 跑完了，一切正常"); process.exit(0);\n',
    },
  });
  expect('exit 1（不是 0，也不是 2）', r.code === 1, `实际 ${r.code}`);
  expect('报 skip_proof_failed 点名 runnable.mjs',
    r.data?.skip_proof_failed?.some((x) => x.script === 'runnable.mjs'), JSON.stringify(r.data?.skip_proof_failed));
}

console.log('case 8 (C1): 真的需要运行时输入的 → R1 放行');
{
  const r = mkAndRun({
    targets: [{ script: 'ok.mjs', args: [], why: '通过' }],
    skipped: [{ script: 'usage.mjs', reason: '需要 --sessions 指向真实会话日志' }],
    manual: [], exempt: [],
    files: { 'tools/ok.mjs': 'process.exit(0);\n', 'tools/usage.mjs': USAGE_SCRIPT },
  });
  expect('exit 0', r.code === 0, `${r.code}: ${r.raw ?? JSON.stringify(r.data?.skip_proof_failed)}`);
}

// ── C2：分母能悄悄变小吗 ──
console.log('case 9 (C2): TARGETS 比基线少一个 → exit 2（分母不许悄悄变小）');
{
  const r = mkAndRun({
    targets: [{ script: 'ok.mjs', args: [], why: '通过' }],
    skipped: [], manual: [], exempt: [],
    baseline: ['ok.mjs', 'gone.mjs'],   // 基线里有两个，现在只有一个
    files: { 'tools/ok.mjs': 'process.exit(0);\n' },
  });
  expect('exit 2', r.code === 2, `实际 ${r.code}`);
  expect('点名被移出的 gone.mjs', cfg(r).includes('gone.mjs'), cfg(r));
}

console.log('case 10 (C2): 缺基线文件 → exit 2（没有基线就没有证据）');
{
  const r = mkAndRun({
    targets: [{ script: 'ok.mjs', args: [], why: '通过' }],
    skipped: [], manual: [], exempt: [],
    baseline: null,
    files: { 'tools/ok.mjs': 'process.exit(0);\n' },
  });
  expect('exit 2', r.code === 2, `实际 ${r.code}`);
  expect('说明缺基线', cfg(r).includes('基线'), cfg(r));
}

// ── R4：exit 0 但输出里报失败 ──
console.log('case 11 (R4): exit 0 但输出里有 ✗ → 判失败（contract-probe 那次的形态）');
{
  const r = mkAndRun({
    targets: [{ script: 'liar.mjs', args: [], why: '嘴上说失败，退出码说成功' }],
    skipped: [], manual: [], exempt: [],
    files: { 'tools/liar.mjs': 'console.log("✗ 2 个不符"); process.exit(0);\n' },
  });
  expect('exit 1', r.code === 1, `实际 ${r.code}`);
  expect('标出 claimed_fail_but_exit_0',
    r.data?.failed?.some((f) => f.claimed_fail_but_exit_0 === true), JSON.stringify(r.data?.failed));
}

// ── EXEMPT ──
console.log('case 12 (R3): EXEMPT 里的脚本不在 SKIPPED 里 → exit 2（豁免不能凭空出现）');
{
  const r = mkAndRun({
    targets: [{ script: 'ok.mjs', args: [], why: '通过' }],
    skipped: [], manual: [],
    exempt: [{ script: 'elsewhere.mjs', reason: '这是一个足够长的理由用于测试' }],
    files: { 'tools/ok.mjs': 'process.exit(0);\n' },
  });
  expect('exit 2', r.code === 2, `实际 ${r.code}`);
  expect('说明豁免必须在 SKIPPED 里', cfg(r).includes('elsewhere.mjs'), cfg(r));
}

// ── MANUAL_ONLY ──
console.log('case 13 (MANUAL_ONLY): 受限切片失败 → 判失败');
{
  const r = mkAndRun({
    targets: [{ script: 'ok.mjs', args: [], why: '通过' }],
    skipped: [], exempt: [],
    manual: [{ script: 'slow.mjs', boundedArgs: ['--only', 'x'], reason: '全量要十几分钟' }],
    files: {
      'tools/ok.mjs': 'process.exit(0);\n',
      'tools/slow.mjs': 'console.log("✗ 切片跑挂了"); process.exit(3);\n',
    },
  });
  expect('exit 1', r.code === 1, `实际 ${r.code}`);
  expect('manual 里点名 slow.mjs',
    r.data?.manual?.some((m) => m.script === 'slow.mjs' && m.code === 3), JSON.stringify(r.data?.manual));
}

console.log('case 14 (MANUAL_ONLY): boundedArgs 为空且未声明 noArgsIsBounded → exit 2');
{
  const r = mkAndRun({
    targets: [{ script: 'ok.mjs', args: [], why: '通过' }],
    skipped: [], exempt: [],
    manual: [{ script: 'slow.mjs', boundedArgs: [], reason: '全量要十几分钟' }],
    files: { 'tools/ok.mjs': 'process.exit(0);\n', 'tools/slow.mjs': 'process.exit(0);\n' },
  });
  expect('exit 2', r.code === 2, `实际 ${r.code}`);
  expect('说明会卡住 CI', cfg(r).includes('卡住'), cfg(r));
}

// ── 真实表的结构 ──
console.log('case 15: 真实 TARGETS 里每个脚本都存在（防改名漂移）');
{
  const m = REAL_SRC.match(/const TARGETS = \[([\s\S]*?)\n\];/);
  const scripts = [...(m?.[1] ?? '').matchAll(/script:\s*'([^']+)'/g)].map((x) => x[1]);
  expect('TARGETS 至少 8 个', scripts.length >= 8, `实际 ${scripts.length}`);
  const missing = scripts.filter((s) => !existsSync(join(HERE, s)));
  expect('全部存在', missing.length === 0, `缺: ${missing.join(', ')}`);
}

console.log('case 16: 真实基线文件存在，且与真实 TARGETS 一致');
{
  const bPath = join(HERE, 'fixtures', 'repo-targets-baseline.json');
  expect('基线文件存在', existsSync(bPath), bPath);
  if (existsSync(bPath)) {
    const b = JSON.parse(readFileSync(bPath, 'utf8'));
    const m = REAL_SRC.match(/const TARGETS = \[([\s\S]*?)\n\];/);
    const now = [...(m?.[1] ?? '').matchAll(/script:\s*'([^']+)'/g)].map((x) => x[1]).sort();
    expect('与 TARGETS 完全一致（改 TARGETS 必须同步基线）',
      JSON.stringify(b.targets) === JSON.stringify(now),
      `基线 ${JSON.stringify(b.targets)} vs 现在 ${JSON.stringify(now)}`);
  }
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });

console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail > 0 ? 1 : 0);
