#!/usr/bin/env node
/**
 * verify.mjs — fixture2 的 ground truth 验证
 *
 * 和 fixture1 的 verify.mjs 同一套判定：
 *
 *   base PASS + injected FAIL  → 注入型
 *   base FAIL + injected FAIL  → 原生型
 *   base FAIL + injected PASS  → 器具缺陷（不在被审计物内）
 *   base PASS + injected PASS  → 探针无效，manifest 不成立
 *
 * 被审计物是 injected。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = join(HERE, 'base');
const INJ = join(HERE, 'injected');

const P = {};

// ── 注入型：转义 / 分页 / 事件 ──
P['F2-01'] = `
  import { escapeHtml } from './src/template.js';
  const got = escapeHtml('<b>');
  // 正确：&lt;b&gt;    错误：&amp;lt;b&amp;gt;
  if (got !== '&lt;b&gt;') { console.log('缺陷：& 放最后替换导致二次转义 — ' + got); process.exit(1); }
`;

P['F2-05'] = `
  import { validate } from './src/validate.js';
  const r = validate({ n: Infinity }, { n: [{ rule: 'number' }] });
  if (r.valid) { console.log('缺陷：number 规则放行 Infinity'); process.exit(1); }
`;

P['F2-07'] = `
  import { compile } from './src/template.js';
  // 同类块嵌套：findMatchingClose 数到第一个 closeTag 就返回，内层块没被跳过
  const r1 = compile('{{#if a}}1{{#if a}}2{{/if}}3{{/if}}');
  const g1 = r1({ a: true });
  const r2 = compile('{{#each xs}}{{#each ys}}{{this}}{{/each}}{{/each}}');
  const g2 = r2({ xs: [{ ys: [1] }, { ys: [2] }] });
  if (g1 !== '123' || g2 !== '12') {
    console.log('缺陷：同类块嵌套时匹配错误 — if套if=' + JSON.stringify(g1) + ' each套each=' + JSON.stringify(g2));
    process.exit(1);
  }
`;

P['F2-08'] = `
  import { EventBus } from './src/events.js';
  const bus = new EventBus();
  bus.on('x', () => { throw new Error('only one'); });
  let kind = null;
  try { bus.emit('x'); } catch (e) { kind = e.constructor.name; }
  // 正确：AggregateError（无论几个失败，类型一致）
  if (kind === 'Error') { console.log('缺陷：只有一个监听器失败时抛原 Error，类型不一致'); process.exit(1); }
`;

P['F2-09'] = `
  import { paginateArray } from './src/pagination.js';
  const r = paginateArray([0,1,2,3,4,5,6,7,8,9], -1, 3);
  // 负数未排除：offset=(-3-1)*3=-12 → slice(-12, -9) 语义翻转
  if (r.page !== 1 || r.offset !== 0) {
    console.log('缺陷：page 未排除负数 — page=' + r.page + ' offset=' + r.offset);
    process.exit(1);
  }
`;

// ── 原生型候选（manifest 标为「base 本身」，需实测核对） ──
P['F2-06'] = `
  import { compile } from './src/template.js';
  const render = compile('<div>{{x}}</div>');
  const got = render({ x: '<script>alert(1)</script>' });
  // escapeHtml 定义了但 renderInline 从没调用它
  if (got.includes('<script>')) { console.log('缺陷：插值未转义，XSS — ' + got); process.exit(1); }
`;

P['F2-10'] = `
  import { validate } from './src/validate.js';
  const r = validate({}, { __proto__: [{ rule: 'required' }] });
  // errors 用普通 {}，字段名为 __proto__ 时污染原型或崩溃
  let polluted = ({}).polluted !== undefined || Object.prototype.polluted !== undefined;
  if (r && r.errors && Object.getPrototypeOf(r.errors) !== Object.prototype) {
    console.log('缺陷：errors 对象的原型被改动');
    process.exit(1);
  }
  // 换个更直接的探针：字段名 constructor
  const r2 = validate({}, { constructor: [{ rule: 'required' }] });
  if (r2.valid === true && r2.errors && Object.keys(r2.errors).length === 0) {
    // 没记录到错误 —— 说明 constructor 这个 key 被吞了
    console.log('缺陷：字段名 constructor 时错误被吞掉');
    process.exit(1);
  }
`;

P['F2-11'] = `
  import { paginateArray } from './src/pagination.js';
  const src = [{ n: 1 }, { n: 2 }, { n: 3 }];
  const r = paginateArray(src, 1, 2);
  r.items[0].n = 999;
  // slice 是浅拷贝，改元素属性会污染源数组
  if (src[0].n === 999) { console.log('缺陷：slice 浅拷贝，改元素属性污染源数组'); process.exit(1); }
`;


P['F2-12'] = `
  import { EventBus } from './src/events.js';
  const bus = new EventBus();
  bus.on('x', () => { throw new Error('boom'); });
  let threw = false;
  try { bus.emit('x'); } catch { threw = true; }
  if (!threw) { console.log('缺陷：单个监听器抛错时错误被完全吞掉，emit 静默返回'); process.exit(1); }
`;

P['F2-13'] = `
  import { compile } from './src/template.js';
  const got = compile('{{constructor}}')({});
  if (got.includes('[native code]')) { console.log('缺陷：resolvePath 沿原型链取值 — ' + got); process.exit(1); }
`;

P['F2-14'] = `
  import { validate } from './src/validate.js';
  const r = validate({ n: false }, { n: [{ rule: 'required' }] });
  if (r.valid) { console.log('缺陷：required 把 false 当作已填写'); process.exit(1); }
`;

P['F2-15'] = `
  import { validate } from './src/validate.js';
  const r = validate({ n: 5 }, { n: [{ rule: 'minLength', arg: 3 }] });
  const msg = r.errors.n ? r.errors.n[0] : '';
  // 期望区分「类型不对」；实际只报「failed minLength」，与长度不足无法区分
  if (/failed minLength/.test(msg)) { console.log('缺陷：minLength 对非字符串只报通用失败，不区分类型错误'); process.exit(1); }
`;

P['F2-16'] = `
  import { renderListView } from './src/index.js';
  let accepted = false;
  try { renderListView('{{x}}', ['a'], 'abc'); accepted = true; } catch {}
  if (accepted) { console.log('缺陷：renderListView 对 options 不校验，字符串被静默接受'); process.exit(1); }
`;

P['F2-17'] = `
  import { validate } from './src/validate.js';
  const r = validate({}, { toString: [{ rule: 'required' }] });
  if (r.valid === true) { console.log('缺陷：字段名 toString 时错误被吞（errors 用普通对象）'); process.exit(1); }
`;

P['F2-18'] = `
  import { paginate } from './src/pagination.js';
  const p = paginate(0, 1, 10);
  if (p.totalPages === 1) { console.log('缺陷：total=0 时 totalPages 声明为 1，但没有任何数据'); process.exit(1); }
`;

P['F2-19'] = `
  import { renderListView } from './src/index.js';
  const r = renderListView('{{#each items}}{{this}}{{/each}}', ['a','b','c'], 'abc');
  // 非法 options 被静默接受后，分页信息与数据不符
  if (r.pagination.totalPages === 1 && r.pagination.hasNext === false) {
    console.log('缺陷：非法 options 导致分页信息错误（3 条数据却报 totalPages=1/hasNext=false）');
    process.exit(1);
  }
`;

P['F2-20'] = `
  import { paginate } from './src/pagination.js';
  const p = paginate(10, 0, 3);
  if (p.page === 0 || p.offset < 0) { console.log('缺陷：page=0 时 offset 变成 ' + p.offset); process.exit(1); }
`;

P['F2-21'] = `
  import { validate } from './src/validate.js';
  const r = validate({ a: 1 }, { a: [{ rule: 'toString' }] });
  if (r.valid === true) {
    console.log("缺陷：rule:'toString' 命中原型链成员，被当作合法规则静默放行");
    process.exit(1);
  }
`;

P['F2-22'] = `
  import { compile } from './src/template.js';
  const got = compile('{{#if constructor}}Y{{/if}}')({});
  if (got === 'Y') {
    console.log("缺陷：{{#if constructor}} 取到原型链成员，条件恒为真");
    process.exit(1);
  }
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

const rows = [];
for (const [id, src] of Object.entries(P)) {
  const b = run(BASE, src);
  const i = run(INJ, src);
  let actual;
  if (b.pass && !i.pass) actual = 'injected';
  else if (!b.pass && !i.pass) actual = 'native';
  else if (!b.pass && i.pass) actual = 'base-only';
  else actual = 'absent';
  rows.push({ id, actual, expect: declared.get(id), b: b.pass, i: i.pass, note: i.out || b.out });
}

console.log('\n=== fixture2 缺陷分类实测（被审计物 = injected）===\n');
for (const r of rows) {
  const ok = r.actual === r.expect;
  const label = { injected: '注入型', native: '原生型', 'base-only': '器具缺陷', absent: '不存在' }[r.actual];
  console.log(`  ${ok ? '✓' : '✗'} ${r.id}  base=${r.b ? 'PASS' : 'FAIL'}  injected=${r.i ? 'PASS' : 'FAIL'}  ${label}`);
  if (r.note) console.log(`         ${r.note.slice(0, 100)}`);
  if (!ok) console.log(`         ↑ manifest 登记「${r.expect}」，实测「${r.actual}」`);
}

const bad = rows.filter((r) => r.actual !== r.expect);
const absent = rows.filter((r) => r.actual === 'absent');
const inj = rows.filter((r) => r.actual === 'injected').length;
const nat = rows.filter((r) => r.actual === 'native').length;

console.log('\n--- 汇总 ---');
console.log(`  探针覆盖: ${rows.length} 条`);
console.log(`  被审计物内实有缺陷: ${inj + nat} 条（注入 ${inj} + 原生 ${nat}）`);
console.log(`  与 manifest 声明一致: ${rows.length - bad.length}/${rows.length}`);
const missing = manifest.defects.filter((d) => !(d.id in P));
if (missing.length) console.log(`  ✗ manifest 中无探针: ${missing.map((d) => d.id).join(', ')}`);
const allGreen = bad.length === 0 && absent.length === 0 && missing.length === 0;
console.log(allGreen ? '\n全部通过\n' : '\n存在不一致，见上\n');
process.exit(allGreen ? 0 : 1);
