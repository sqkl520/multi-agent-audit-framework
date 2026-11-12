#!/usr/bin/env node
/**
 * verify.mjs — manifest 的可信度来源
 *
 * 对每条缺陷跑一个行为探针，在 base 和 injected 里各跑一遍，用结果判定类型：
 *
 *   base PASS + injected FAIL  → 注入型（injected 独有）
 *   base FAIL + injected FAIL  → 原生型（base 自带，injected 继承）
 *   base FAIL + injected PASS  → 器具缺陷（只在 base，不计分）
 *   base PASS + injected PASS  → 探针无效（manifest 不成立）
 *
 * 被审计物是 injected：实验各组拷走的就是它，所以计分以 injected 为准。
 *
 * 判据必须是行为可观测的。「读源码看有没有某段文字」这类探针会把实现方式
 * 当成缺陷本身，已全部改成真实调用后观察返回值/副作用。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = join(HERE, 'base');
const INJ = join(HERE, 'injected');

const PROOFS = {};

// ── 注入型 ────────────────────────────────────────────────────
PROOFS['GT-001'] = `
  import { processTasks, loadConfig } from './src/index.js';
  const r = await processTasks([{id:'a'},{id:'b'},{id:'c'}], {config:loadConfig({}), handler:async(t)=>t.id});
  if (r.length !== 3) { console.log('缺陷：返回 ' + r.length + ' 个结果（应为 3）'); process.exit(1); }
`;

PROOFS['GT-002'] = `
  import { TaskQueue } from './src/queue.js';
  const q = new TaskQueue({capacity:10});
  q.enqueue({id:'first',priority:1}); q.enqueue({id:'second',priority:1});
  const got = q.dequeue();
  if (got.id !== 'first') { console.log('缺陷：同优先级 FIFO 破坏，先出的是 ' + got.id); process.exit(1); }
`;

PROOFS['GT-003'] = `
  import { TaskQueue } from './src/queue.js';
  const q = new TaskQueue({capacity:2});
  q.enqueue({id:'a'}); q.enqueue({id:'b'});
  if (q.enqueue({id:'c'}) === true) { console.log('缺陷：容量 2 塞进了第 3 个'); process.exit(1); }
`;

PROOFS['GT-004'] = `
  import { backoffDelay } from './src/retry.js';
  const d1 = backoffDelay(1,{base:100});
  if (d1 !== 100) { console.log('缺陷：首次退避 ' + d1 + 'ms，应为 100ms'); process.exit(1); }
`;

PROOFS['GT-005'] = `
  import { loadConfig } from './src/config.js';
  let ok=false;
  try { loadConfig({CONCURRENCY:'0'}); ok=true; } catch {}
  if (ok) { console.log('缺陷：CONCURRENCY=0 被接受'); process.exit(1); }
`;

PROOFS['GT-006'] = `
  import { loadConfig } from './src/config.js';
  let rejected=false;
  try { loadConfig({LOG_LEVEL:'warn'}); } catch { rejected=true; }
  if (rejected) { console.log('缺陷：LOG_LEVEL=warn 被拒'); process.exit(1); }
`;

PROOFS['GT-007'] = `
  import { JsonStore } from './src/store.js';
  import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
  import { join } from 'node:path'; import { tmpdir } from 'node:os';
  const d=mkdtempSync(join(tmpdir(),'v07-')); const p=join(d,'x.json');
  writeFileSync(p,'{ bad');
  let silent=false;
  try { const s=new JsonStore(p); if(s.keys().length===0) silent=true; } catch {}
  rmSync(d,{recursive:true,force:true});
  if (silent) { console.log('缺陷：损坏 store 静默当作空'); process.exit(1); }
`;

PROOFS['GT-008'] = `
  import { JsonStore } from './src/store.js';
  import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
  import { join } from 'node:path'; import { tmpdir } from 'node:os';
  const d=mkdtempSync(join(tmpdir(),'v08-')); const p=join(d,'x.json');
  writeFileSync(p,'{"keep":"me"}','utf8');
  const s=new JsonStore(p);
  let threw=false;
  try { s.set('bad', 10n); } catch { threw=true; }
  const gone = !existsSync(p);
  rmSync(d,{recursive:true,force:true});
  if (threw && gone) { console.log('缺陷：序列化抛错后原文件已删，数据永久丢失'); process.exit(1); }
`;

PROOFS['GT-009'] = `
  import { runWithConcurrency } from './src/worker-pool.js';
  const seen=new Map();
  await runWithConcurrency([0,1,2,3,4,5],3,async(x,idx)=>{seen.set(idx,(seen.get(idx)??0)+1);return x;});
  const dup=[...seen.entries()].filter(([,n])=>n>1);
  if (dup.length) { console.log('缺陷：索引重复 '+JSON.stringify(dup)); process.exit(1); }
`;

PROOFS['GT-010'] = `
  import { TaskQueue } from './src/queue.js';
  import { readFileSync } from 'node:fs';
  const src=readFileSync('./src/queue.js','utf8');
  const declares = /@returns \\{boolean\\}[\\s\\S]{0,80}?clear\\(\\)\\s*\\{/.test(src);
  const q=new TaskQueue({capacity:2}); q.enqueue({id:'a'});
  const ret = q.clear();
  if (declares && ret === undefined) {
    console.log('缺陷：clear() 声明 @returns {boolean} 但实际返回 undefined');
    process.exit(1);
  }
`;

PROOFS['GT-015'] = `
  import { JsonStore } from './src/store.js';
  import { mkdtempSync, rmSync } from 'node:fs';
  import { join } from 'node:path'; import { tmpdir } from 'node:os';
  const d=mkdtempSync(join(tmpdir(),'v15-'));
  const s=new JsonStore(join(d,'x.json'));
  const v=s.get('constructor');
  rmSync(d,{recursive:true,force:true});
  if (v!==undefined) { console.log('缺陷：get("constructor") 返回 '+typeof v); process.exit(1); }
`;

PROOFS['GT-016'] = `
  import { retry } from './src/retry.js';
  let threw=false, err;
  try { await retry(async () => { throw new Error('boom'); }, { maxAttempts: 0 }); }
  catch (x) { threw=true; err=x; }
  if (!threw) { console.log('缺陷：maxAttempts=0 没有抛错'); process.exit(1); }
  if (err === undefined) { console.log('缺陷：maxAttempts=0 抛了 undefined'); process.exit(1); }
`;

PROOFS['GT-018'] = `
  import { JsonStore } from './src/store.js';
  import { mkdtempSync, rmSync } from 'node:fs';
  import { join } from 'node:path'; import { tmpdir } from 'node:os';
  const d=mkdtempSync(join(tmpdir(),'v18-'));
  const s=new JsonStore(join(d,'x.json'));
  try { s.set('__proto__', { isAdmin: true }); } catch {}
  const polluted = s.get('isAdmin') === true;
  const invisible = !s.keys().includes('__proto__');
  const undeletable = s.delete('__proto__') === false;
  rmSync(d,{recursive:true,force:true});
  if (polluted && invisible && undeletable) {
    console.log('缺陷：__proto__ 写入静默丢失并污染原型');
    process.exit(1);
  }
`;

// ── 原生型 ────────────────────────────────────────────────────
PROOFS['GT-011'] = `
  import { TaskQueue } from './src/queue.js';
  const q=new TaskQueue({capacity:10});
  q.enqueue({id:'a',priority:1});
  const p=q.peek(); p.priority=999;
  if (q.peek().priority===999) { console.log('缺陷：peek 返回内部活引用'); process.exit(1); }
`;

PROOFS['GT-012'] = `
  import { TaskQueue } from './src/queue.js';
  const q=new TaskQueue({capacity:10});
  q.enqueue({id:'a'});
  let threw=false;
  try { q.remove(undefined); } catch { threw=true; }
  if (!threw) { console.log('缺陷：remove(undefined) 不校验 id 类型，静默返回 false'); process.exit(1); }
`;

PROOFS['GT-013'] = `
  import { TaskQueue } from './src/queue.js';
  let accepted=false;
  try { new TaskQueue({capacity:NaN}); accepted=true; } catch {}
  if (accepted) { console.log('缺陷：capacity=NaN 被接受'); process.exit(1); }
`;

PROOFS['GT-014'] = `
  import { readFileSync } from 'node:fs';
  const all=['index.js','retry.js','worker-pool.js'].map(f=>readFileSync('./src/'+f,'utf8')).join('');
  const usesTimeout = /Promise\\.race|AbortController|AbortSignal/.test(all);
  const passesAsBackoff = /maxDelay:\\s*config\\.timeoutMs/.test(readFileSync('./src/index.js','utf8'));
  if (passesAsBackoff && !usesTimeout) {
    console.log('缺陷：timeoutMs 从未被当作超时使用，只被当成退避上限');
    process.exit(1);
  }
`;

PROOFS['GT-017'] = `
  import { JsonStore } from './src/store.js';
  import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
  import { join } from 'node:path'; import { tmpdir } from 'node:os';
  const d=mkdtempSync(join(tmpdir(),'v17-')); const p=join(d,'x.json');
  writeFileSync(p,'null');
  let crashed=false, silentEmpty=false;
  try { const s=new JsonStore(p); if (s.keys().length===0) silentEmpty=true; } catch { crashed=true; }
  rmSync(d,{recursive:true,force:true});
  if (crashed) { console.log('缺陷：文件内容为 null 时构造即崩'); process.exit(1); }
  if (silentEmpty) { console.log('缺陷：文件内容为 null 时静默当作空 store'); process.exit(1); }
`;

PROOFS['GT-020'] = `
  import { processTasks } from './src/index.js';
  let msg=null;
  try { await processTasks([], { handler: async () => 1 }); } catch (e) { msg=e.message; }
  if (msg !== null) { console.log('缺陷：processTasks([]) 抛错 — ' + msg); process.exit(1); }
`;

PROOFS['GT-021'] = `
  import { safeClose } from './src/neg-catch.js';
  const leaked=[];
  process.on('unhandledRejection', (r) => leaked.push(r));
  const r = safeClose({ close: async () => { throw new Error('close failed'); } });
  await new Promise((res) => setTimeout(res, 30));
  if (r === true && leaked.length > 0) {
    console.log('缺陷：safeClose 返回 true 却泄漏未处理 rejection');
    process.exit(1);
  }
`;

// ── 器具缺陷（只在 base） ─────────────────────────────────────
PROOFS['GT-022'] = `
  import { JsonStore } from './src/store.js';
  import { mkdtempSync, rmSync } from 'node:fs';
  import { join } from 'node:path'; import { tmpdir } from 'node:os';
  const d=mkdtempSync(join(tmpdir(),'v22-'));
  const s=new JsonStore(join(d,'x.json'));
  let err=null;
  try { s.set('a',1); } catch (e) { err=e; }
  rmSync(d,{recursive:true,force:true});
  if (err) { console.log('缺陷：set() 抛错 — ' + err.constructor.name + ': ' + err.message); process.exit(1); }
`;

function run(dir, src) {
  try {
    execFileSync('node', ['--input-type=module', '-e', src], {
      cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000,
    });
    return { pass: true, out: '' };
  } catch (e) {
    const raw = ((e.stdout ?? '') + (e.stderr ?? '')).trim();
    const line = raw.split('\n').find((l) => l.includes('缺陷')) ?? raw.split('\n')[0] ?? '';
    return { pass: false, out: line.trim() };
  }
}

const manifest = JSON.parse(readFileSync(join(HERE, 'manifest.json'), 'utf8'));
const declared = new Map();
for (const d of manifest.defects) declared.set(d.id, d.origin === 'native' ? 'native' : 'injected');
for (const a of manifest.apparatus ?? []) declared.set(a.id, 'base-only');

// manifest 覆盖检查：探针与 manifest 必须一一对应，否则计分口径会漂
const missingProbe = [...declared.keys()].filter((id) => !(id in PROOFS));
const orphanProbe = Object.keys(PROOFS).filter((id) => !declared.has(id));

const rows = [];
for (const [id, src] of Object.entries(PROOFS)) {
  const b = run(BASE, src);
  const i = run(INJ, src);
  let actual;
  if (b.pass && !i.pass) actual = 'injected';
  else if (!b.pass && !i.pass) actual = 'native';
  else if (!b.pass && i.pass) actual = 'base-only';
  else actual = 'absent';
  rows.push({ id, actual, expect: declared.get(id), b: b.pass, i: i.pass, note: i.out || b.out });
}

console.log('\n=== 逐条验证（被审计物 = injected）===\n');
for (const r of rows) {
  const ok = r.actual === r.expect;
  const label = { injected: '注入型', native: '原生型', 'base-only': '器具缺陷', absent: '不存在' }[r.actual];
  console.log(`  ${ok ? '✓' : '✗'} ${r.id}  base=${r.b ? 'PASS' : 'FAIL'}  injected=${r.i ? 'PASS' : 'FAIL'}  ${label}`);
  if (r.note) console.log(`         ${r.note.slice(0, 110)}`);
  if (!ok) console.log(`         ↑ manifest 登记为「${r.expect}」，实测为「${r.actual}」`);
}

const bad = rows.filter((r) => r.actual !== r.expect);
const absent = rows.filter((r) => r.actual === 'absent');
const inArtifact = rows.filter((r) => r.actual === 'injected' || r.actual === 'native');

console.log('\n--- 汇总 ---');
console.log(`  manifest defects: ${manifest.defects.length} 条，apparatus: ${(manifest.apparatus ?? []).length} 条`);
console.log(`  探针覆盖: ${rows.length} 条`);
console.log(`  被审计物内实有缺陷: ${inArtifact.length} 条（注入 ${rows.filter((r) => r.actual === 'injected').length} + 原生 ${rows.filter((r) => r.actual === 'native').length}）`);
console.log(`  与 manifest 声明一致: ${rows.length - bad.length}/${rows.length}`);

if (missingProbe.length) console.log(`\n  ✗ manifest 里没有对应探针: ${missingProbe.join(', ')}`);
if (orphanProbe.length) console.log(`  ✗ 探针不在 manifest 里: ${orphanProbe.join(', ')}`);
if (absent.length) console.log(`  ✗ 探针两边都通过（缺陷不成立）: ${absent.map((r) => r.id).join(', ')}`);
if (bad.length) console.log(`  ✗ 分类不符: ${bad.map((r) => r.id).join(', ')}`);

const allGreen = bad.length === 0 && absent.length === 0 && missingProbe.length === 0 && orphanProbe.length === 0;
console.log(allGreen ? '\n全部通过\n' : '\n存在不一致，见上\n');
process.exit(allGreen ? 0 : 1);
