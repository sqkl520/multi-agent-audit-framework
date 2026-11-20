// check-concurrency-cap 自测
//
// 核心是 case 3：复刻 2026-11-20 的真实现象——主 Agent 自己申报
// 「峰值 5–6」，而用会话日志算出来是 13。自述低估比不申报更危险。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, 'check-concurrency-cap.mjs');

let pass = 0, fail = 0;
const expect = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

/**
 * 造一个假的 dsh 会话目录。
 * @param spans [{ id, start, end }] 每个子 agent 的存活区间（毫秒时间戳）
 */
function mkSessions(spans) {
  const root = mkdtempSync(join(tmpdir(), 'conc-'));
  for (const s of spans) {
    const d = join(root, `session-${s.id}`);
    mkdirSync(d, { recursive: true });
    const lines = [
      JSON.stringify({ time: new Date(s.start).toISOString(), type: 'step/start' }),
      JSON.stringify({ time: new Date(s.end).toISOString(), type: 'step/end' }),
    ];
    writeFileSync(join(d, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(lines.join('\n'))));
  }
  return root;
}

function run(args) {
  try {
    const out = execFileSync(process.execPath, [TOOL, ...args, '--json'], { encoding: 'utf8' });
    return { code: 0, data: JSON.parse(out) };
  } catch (e) {
    const out = e.stdout?.toString() ?? '';
    try { return { code: e.status, data: JSON.parse(out) }; }
    catch { return { code: e.status, data: null, raw: out, err: e.stderr?.toString() }; }
  }
}

const T0 = new Date('2026-11-20T12:00:00Z').getTime();
const MIN = 60_000;

console.log('\n=== check-concurrency-cap 自测 ===\n');

console.log('case 1: 3 个区间不重叠 → 峰值 1，通过');
{
  const root = mkSessions([
    { id: 'a', start: T0, end: T0 + 10 * MIN },
    { id: 'b', start: T0 + 20 * MIN, end: T0 + 30 * MIN },
    { id: 'c', start: T0 + 40 * MIN, end: T0 + 50 * MIN },
  ]);
  const r = run(['--sessions', root]);
  expect('峰值 1', r.data?.peak === 1, `peak=${r.data?.peak}`);
  expect('exit 0', r.code === 0, `code=${r.code}`);
  rmSync(root, { recursive: true, force: true });
}

console.log('case 2: 5 个区间全重叠 → 峰值 5 > 默认上限 4 → FAIL');
{
  const root = mkSessions([1, 2, 3, 4, 5].map((i) => ({
    id: String(i), start: T0, end: T0 + 10 * MIN,
  })));
  const r = run(['--sessions', root]);
  expect('峰值 5', r.data?.peak === 5, `peak=${r.data?.peak}`);
  expect('超限标记', r.data?.over_cap === true, JSON.stringify(r.data));
  expect('exit 1', r.code === 1, `code=${r.code}`);
  rmSync(root, { recursive: true, force: true });
}

console.log('case 3: 自述申报 6 但实测 13 → 必须报「低估」');
{
  // 复刻真实：主 Agent 在 discipline_log 写「并发峰值达到 5–6」，
  // 而会话日志算出来是 13。
  const root = mkSessions([...Array(13)].map((_, i) => ({
    id: String(i), start: T0, end: T0 + 10 * MIN,
  })));
  const st = join(root, 'state.json');
  writeFileSync(st, JSON.stringify({
    discipline_log: [{
      discretion_type: 'CONCURRENCY_CAP_BREACH',
      action: '并发峰值达到 5–6（上限 4），原因是用「产物已落盘」当作「agent 已到终态」补位',
    }],
  }));
  const r = run(['--sessions', root, '--state', st]);
  expect('峰值 13', r.data?.peak === 13, `peak=${r.data?.peak}`);
  expect('判自述低估', r.data?.under_declared === true, JSON.stringify(r.data));
  expect('exit 1', r.code === 1, `code=${r.code}`);
  rmSync(root, { recursive: true, force: true });
}

console.log('case 4: --cap 显式指定会覆盖兜底值');
{
  const root = mkSessions([...Array(6)].map((_, i) => ({
    id: String(i), start: T0, end: T0 + 5 * MIN,
  })));
  const loose = run(['--sessions', root, '--cap', '8']);
  expect('cap=8 时放行', loose.data?.cap === 8 && loose.code === 0, JSON.stringify({ cap: loose.data?.cap, code: loose.code }));
  rmSync(root, { recursive: true, force: true });
}

console.log('case 5: 相邻区间（A 结束瞬间 B 开始）不算并发');
{
  const root = mkSessions([
    { id: 'a', start: T0, end: T0 + 10 * MIN },
    { id: 'b', start: T0 + 10 * MIN, end: T0 + 20 * MIN },
  ]);
  const r = run(['--sessions', root]);
  expect('峰值为 1（不是 2）', r.data?.peak === 1, `peak=${r.data?.peak}`);
  rmSync(root, { recursive: true, force: true });
}

console.log('case 6: 空目录 → exit 2（分母为 0 不等于通过）');
{
  const root = mkdtempSync(join(tmpdir(), 'conc-empty-'));
  let code = 0, stderr = '';
  try {
    execFileSync(process.execPath, [TOOL, '--sessions', root, '--json'],
      { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) { code = e.status; stderr = e.stderr?.toString() ?? ''; }
  expect('exit 2', code === 2, `code=${code}`);
  expect('说明分母为 0', /分母为 0/.test(stderr) || /没有可解析/.test(stderr), stderr.slice(0, 150));
  rmSync(root, { recursive: true, force: true });
}

console.log('case 7: 不给 --sessions → exit 2');
{
  let code = 0;
  try { execFileSync(process.execPath, [TOOL], { encoding: 'utf8', stdio: 'pipe' }); }
  catch (e) { code = e.status; }
  expect('exit 2', code === 2, `code=${code}`);
}

console.log('case 8: --since 过滤掉早于时间窗的 session');
{
  const root = mkSessions([
    { id: 'old', start: T0 - 120 * MIN, end: T0 - 110 * MIN },
    { id: 'new1', start: T0, end: T0 + 5 * MIN },
    { id: 'new2', start: T0, end: T0 + 5 * MIN },
  ]);
  const r = run(['--sessions', root, '--since', new Date(T0 - 10 * MIN).toISOString()]);
  expect('只算窗口内的 2 个', r.data?.spans === 2, `spans=${r.data?.spans}`);
  expect('峰值 2', r.data?.peak === 2, `peak=${r.data?.peak}`);
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail > 0 ? 1 : 0);
