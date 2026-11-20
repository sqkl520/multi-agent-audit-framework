// dsh-driver 自测：验证「相位闭合判定」与「防空转」这两条核心逻辑。
//
// 不实际调用 dsh —— 用一个假的 dsh 脚本（node -e 写文件）模拟
// 「跑一轮 → 改 state.json / 加产物」，检查驱动会不会正确续跑与停止。
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DRIVER = join(HERE, 'dsh-driver.mjs');

let pass = 0, fail = 0;
const expect = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

/**
 * 造一个可运行的假 dsh：根据环境变量 FAKE_SCRIPT 决定每次被调用做什么。
 * 驱动要求 --dsh 指向一个 .js 文件（它用 process.execPath 跑）。
 */
function setup({ dshBody, stateAfter, extraArtifacts = 0 }) {
  const root = mkdtempSync(join(tmpdir(), 'drv-'));
  const art = join(root, 'artifacts');
  mkdirSync(art, { recursive: true });
  writeFileSync(join(art, 'round1-01-recon-slices.md'), '# r\n');

  // 初始 state：相位未闭合
  writeFileSync(join(art, 'state.json'), JSON.stringify({
    phase: 'wave2b', status: 'RUNNING', slices: { s1: { state: 'RUNNING' } },
  }));

  const dsh = join(root, 'fake-dsh.mjs');
  writeFileSync(dsh, dshBody);

  const patch = join(root, 'patch.yml');
  writeFileSync(patch, '- id: noop\n  name: "@x/y"\n');
  const task = join(root, 'task.md');
  writeFileSync(task, '原始任务书');

  return { root, art, dsh, patch, task, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function runDriver(f, extra = []) {
  try {
    const out = execFileSync(process.execPath,
      [DRIVER, '--patch', f.patch, '--task', f.task, '--artifacts', f.art, '--dsh', f.dsh, '--json', ...extra],
      { encoding: 'utf8' });
    return { code: 0, data: JSON.parse(out) };
  } catch (e) {
    const out = e.stdout?.toString() ?? '';
    try { return { code: e.status, data: JSON.parse(out) }; }
    catch { return { code: e.status, data: null, raw: out, err: e.stderr?.toString() }; }
  }
}

console.log('\n=== dsh-driver 自测 ===\n');

console.log('case 1: 假 dsh 一次就把相位置为 CLOSED → 只跑 1 轮就停');
{
  const f = setup({
    dshBody: `
import { writeFileSync } from 'node:fs';
const art = process.argv[process.argv.length - 1]; // 不是产物路径，占位
const dir = process.env.FAKE_ART;
writeFileSync(dir + '/round1-03-critique-skeptic.md', '# c');
writeFileSync(dir + '/state.json', JSON.stringify({ phase: 'closed', status: 'CLOSED' }));
process.exit(0);
`,
  });
  process.env.FAKE_ART = f.art;
  const r = runDriver(f);
  expect('驱动判闭合', r.data?.closed === true, JSON.stringify(r.data?.reason));
  expect('只跑了 1 轮', r.data?.iterations === 1, `iterations=${r.data?.iterations}`);
  delete process.env.FAKE_ART;
  f.cleanup();
}

console.log('case 2: 假 dsh 两轮都不改任何东西 → 第 2 轮判 STALLED 并停');
{
  const f = setup({ dshBody: 'process.exit(0);\n' });
  const r = runDriver(f, ['--max-iterations', '4']);
  expect('未闭合', r.data?.closed === false, `closed=${r.data?.closed}`);
  expect('判 STALLED', /STALLED/.test(r.data?.reason ?? ''), r.data?.reason);
  expect('没跑满 4 轮', (r.data?.iterations ?? 0) < 4, `iterations=${r.data?.iterations}`);
  f.cleanup();
}

console.log('case 3: 假 dsh 每轮都加产物但不改 state → 不得判 STALLED（有进展）');
{
  // 关键：只看 state 会被「说 RUNNING 但什么都不做」骗过去；
  // 只看产物会被「加了个空文件」骗过去。两者都要看。
  const f = setup({
    dshBody: `
import { writeFileSync } from 'node:fs';
const dir = process.env.FAKE_ART;
const n = Date.now();
writeFileSync(dir + '/round1-02-sweep-extra-' + n + '.md', '# x');
process.exit(0);
`,
  });
  process.env.FAKE_ART = f.art;
  const r = runDriver(f, ['--max-iterations', '3']);
  expect('不判 STALLED', !/STALLED/.test(r.data?.reason ?? ''), r.data?.reason);
  expect('跑满 max-iterations 才停', r.data?.iterations === 3, `iterations=${r.data?.iterations}`);
  delete process.env.FAKE_ART;
  f.cleanup();
}

console.log('case 4: 起始状态已 CLOSED → 一轮都不跑');
{
  const f = setup({ dshBody: 'process.exit(0);\n' });
  writeFileSync(join(f.art, 'state.json'), JSON.stringify({ phase: 'closed', status: 'CLOSED' }));
  const r = runDriver(f);
  expect('判闭合', r.data?.closed === true, JSON.stringify(r.data?.reason));
  expect('0 轮', r.data?.iterations === 0, `iterations=${r.data?.iterations}`);
  f.cleanup();
}

console.log('case 5: PARTIALLY_CLOSED 也算闭合（预算耗尽时是合法终态）');
{
  const f = setup({
    dshBody: `
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.FAKE_ART + '/state.json',
  JSON.stringify({ phase: 'closed', status: 'PARTIALLY_CLOSED' }));
process.exit(0);
`,
  });
  process.env.FAKE_ART = f.art;
  const r = runDriver(f);
  expect('判闭合', r.data?.closed === true, JSON.stringify(r.data?.reason));
  expect('只跑 1 轮', r.data?.iterations === 1, `iterations=${r.data?.iterations}`);
  delete process.env.FAKE_ART;
  f.cleanup();
}

console.log('case 6: 缺 --artifacts → exit 2');
{
  let code = 0;
  try {
    execFileSync(process.execPath, [DRIVER, '--patch', 'x.yml', '--task', 'y.md'],
      { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) { code = e.status; }
  expect('exit 2', code === 2, `code=${code}`);
}

console.log('case 7: patch 里有 <your-upstream> 但没设环境变量 → exit 2（不得把占位符当 URL）');
{
  // 2026-11-20 踩到的真实坑：为了不进公开仓库把 IP 换成占位符，
  // 结果 dsh 报 PI_AI_ERROR: Invalid URL，驱动连跑两轮都立刻失败并判 STALLED。
  const root = mkdtempSync(join(tmpdir(), 'drv7-'));
  const art = join(root, 'artifacts');
  mkdirSync(art, { recursive: true });
  writeFileSync(join(art, 'state.json'), JSON.stringify({ phase: 'wave2b', status: 'RUNNING' }));
  writeFileSync(join(art, 'a.md'), '# a');
  const patch = join(root, 'patch.yml');
  writeFileSync(patch, 'baseURL: http://<your-upstream>:33000\n');
  const task = join(root, 'task.md');
  writeFileSync(task, 't');
  const dsh = join(root, 'd.mjs');
  writeFileSync(dsh, 'process.exit(0);\n');

  delete process.env.DSH_UPSTREAM_BASEURL;
  let code = 0, stderr = '';
  try {
    execFileSync(process.execPath,
      [DRIVER, '--patch', patch, '--task', task, '--artifacts', art, '--dsh', dsh],
      { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) { code = e.status; stderr = e.stderr?.toString() ?? ''; }
  expect('exit 2', code === 2, `code=${code}`);
  expect('提示设置 DSH_UPSTREAM_BASEURL', /DSH_UPSTREAM_BASEURL/.test(stderr), stderr.slice(0, 200));
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail > 0 ? 1 : 0);
