// check-gate-doc-sync 自测：证明它既能放行一致的文档，也能抓到漂移。
//
// 关键用例是 case 3：**用改之前的 protocol.md 回放**，它必须报出 3 个缺失参数。
// 一个只在当前（已修好的）仓库上报绿的工具是没有价值的——那可能只是它什么都没查。
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let pass = 0, fail = 0;
const expect = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

/** 在临时副本上跑，可以任意改写 protocol.md / gate.mjs */
function withCopy(mutator, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'gds-'));
  cpSync(join(ROOT, 'framework'), join(dir, 'framework'), { recursive: true });
  mkdirSync(join(dir, 'tools'), { recursive: true });
  cpSync(join(HERE, 'gate.mjs'), join(dir, 'tools', 'gate.mjs'));
  cpSync(join(HERE, 'check-gate-doc-sync.mjs'), join(dir, 'tools', 'check-gate-doc-sync.mjs'));
  mutator(dir);
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function run(dir) {
  try {
    const out = execFileSync(process.execPath,
      [join(dir, 'tools', 'check-gate-doc-sync.mjs'), '--json'],
      { encoding: 'utf8' });
    return { code: 0, data: JSON.parse(out) };
  } catch (e) {
    const out = (e.stdout?.toString() ?? '');
    try { return { code: e.status, data: JSON.parse(out) }; }
    catch { return { code: e.status, data: null, raw: out, err: e.stderr?.toString() }; }
  }
}

console.log('\n=== 门禁文档同步检查器自测 ===\n');

console.log('case 1: 当前仓库应一致');
{
  withCopy(() => {}, (dir) => {
    const r = run(dir);
    expect('exit 0', r.code === 0, `code=${r.code}`);
    expect('无 problem', (r.data?.problems ?? []).length === 0, JSON.stringify(r.data?.problems));
  });
}

console.log('case 2: 从文档示例里删掉一个必需参数 → 必须报');
{
  withCopy((dir) => {
    const p = join(dir, 'framework', 'orchestrator', 'protocol.md');
    const t = readFileSync(p, 'utf8');
    // 只删 close 示例里的 --report（含可能的续行空格）
    writeFileSync(p, t.replace(/(\s*--report <OUTDIR>\/round\{N\}\/round\{N\}-final-report\.md)/, ''));
  }, (dir) => {
    const r = run(dir);
    expect('exit 1', r.code === 1, `code=${r.code}`);
    const hit = (r.data?.problems ?? []).some((p) => p.kind === 'missing_required_arg_in_doc' && p.arg === '--report');
    expect('报 close 缺 --report', hit, JSON.stringify((r.data?.problems ?? []).map((p) => p.arg)));
  });
}

console.log('case 3: 用「改之前」的 protocol.md 回放 → 必须报出 3 个缺失参数');
{
  // 这一条是本工具的存在理由。改前的示例只有 --state / --round-dir，
  // 而 close 门现在还需要 --artifacts / --ledger / --report。
  // 如果这条抓不到，说明本工具只是「在当前仓库上碰巧是绿的」。
  withCopy((dir) => {
    const p = join(dir, 'framework', 'orchestrator', 'protocol.md');
    const lines = readFileSync(p, 'utf8').split('\n');
    // 找到 close 示例的起始行与它的续行，整段换成旧的一行式。
    const start = lines.findIndex((l) => /gate\.mjs --gate close/.test(l));
    if (start < 0) throw new Error('测试自身失效：找不到 close 示例行');
    let end = start;
    // 续行：本行以 \ 结尾，或下一行仍属于同一条命令（以 -- 开头的参数行）
    while (end < lines.length - 1 && (/\\\s*$/.test(lines[end]) || /^\s+--[\w-]+/.test(lines[end + 1]))) end++;
    lines.splice(start, end - start + 1,
      'node tools/gate.mjs --gate close --state <state.json> --round-dir <round{N}>');
    writeFileSync(p, lines.join('\n'));
  }, (dir) => {
    const r = run(dir);
    const missing = (r.data?.problems ?? [])
      .filter((p) => p.kind === 'missing_required_arg_in_doc').map((p) => p.arg).sort();
    expect('exit 1', r.code === 1, `code=${r.code}`);
    expect('报出 --artifacts / --ledger / --report 三项',
      JSON.stringify(missing) === JSON.stringify(['--artifacts', '--ledger', '--report']),
      JSON.stringify(missing));
  });
}

console.log('case 4: 文档里写了工具不认的参数 → 必须报');
{
  withCopy((dir) => {
    const p = join(dir, 'framework', 'orchestrator', 'protocol.md');
    const t = readFileSync(p, 'utf8');
    writeFileSync(p, t.replace('--gate release --state <state.json>',
      '--gate release --state <state.json> --totally-made-up <x>'));
  }, (dir) => {
    const r = run(dir);
    const hit = (r.data?.problems ?? []).some((p) => p.kind === 'unknown_arg_in_doc' && p.arg === '--totally-made-up');
    expect('报 unknown_arg_in_doc', hit, JSON.stringify((r.data?.problems ?? []).map((p) => p.arg)));
  });
}

console.log('case 5: 文档里写了工具没有的门 → 必须报');
{
  withCopy((dir) => {
    const p = join(dir, 'framework', 'orchestrator', 'protocol.md');
    const t = readFileSync(p, 'utf8');
    writeFileSync(p, t + '\n```bash\nnode tools/gate.mjs --gate nonexistent --state x\n```\n');
  }, (dir) => {
    const r = run(dir);
    const hit = (r.data?.problems ?? []).some((p) => p.kind === 'documented_gate_not_in_tool' && p.gate === 'nonexistent');
    expect('报 documented_gate_not_in_tool', hit, JSON.stringify((r.data?.problems ?? []).map((p) => p.kind)));
  });
}

console.log('case 6: gate.mjs 结构被改坏 → exit 2，不得当成「一致」');
{
  withCopy((dir) => {
    writeFileSync(join(dir, 'tools', 'gate.mjs'), '// 完全不含 if (gate === ...)\n');
  }, (dir) => {
    const r = run(dir);
    expect('exit 2（配置错误）', r.code === 2, `code=${r.code}`);
  });
}

console.log('case 7: protocol.md 结构被改坏（无示例）→ exit 2');
{
  withCopy((dir) => {
    writeFileSync(join(dir, 'framework', 'orchestrator', 'protocol.md'), '# 空文档\n\n没有任何示例。\n');
  }, (dir) => {
    const r = run(dir);
    expect('exit 2（分母为 0 不等于通过）', r.code === 2, `code=${r.code}`);
  });
}

console.log('case 8: 工具有某道门、但文档完全没写 → 必须报 gate_undocumented');
{
  // 2026-11-21 变异测试发现：把 gate_undocumented 那条 push 注释掉后，
  // 自测仍然全过——case 5 测的是「文档写了工具没有的门」（反向），
  // 而「工具有而文档没写」这一类从来没被覆盖。
  //
  // 这条漏检的后果：新增一道门但忘了写文档，示例里没有它，
  // 读者照文档跑永远不会触发那道门 —— 而检查器不会响。
  withCopy((dir) => {
    const p = join(dir, 'framework', 'orchestrator', 'protocol.md');
    const t = readFileSync(p, 'utf8');
    // 删掉 release 门的示例命令整行
    writeFileSync(p, t.split('\n')
      .filter((l) => !/--gate release/.test(l))
      .join('\n'));
  }, (dir) => {
    const r = run(dir);
    expect('exit 1', r.code === 1, `code=${r.code}`);
    const hit = (r.data?.problems ?? []).some((p) => p.kind === 'gate_undocumented' && p.gate === 'release');
    expect('报 gate_undocumented(release)', hit,
      JSON.stringify((r.data?.problems ?? []).map((p) => `${p.kind}:${p.gate}`)));
  });
}

console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail > 0 ? 1 : 0);
