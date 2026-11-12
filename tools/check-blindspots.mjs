#!/usr/bin/env node
/**
 * check-blindspots.mjs — 检测三个「六组实验零命中」的盲区模式
 *
 * 为什么需要：2026-11-11 的对照实验里，6 个独立审计 agent 报了 86 条发现，
 * 但下面三条缺陷 **18 次审查、零命中**：
 *
 *   GT-011  peek() 返回队列内部活引用 —— 调用方可以篡改内部状态
 *   GT-012  remove(id) 缺 id 校验 —— 同族的 enqueue() 校验了
 *   GT-013  capacity 校验接受 NaN —— typeof NaN === 'number'
 *
 * 三条都有清晰的静态特征，可以机械检测。
 *
 * 检测规则：
 *   B1. 方法体内出现 `return this.#xxx[...]` 或 `return this.#map.get(...)`
 *       —— 返回了内部容器的元素或引用，调用方可改
 *   B2. 同一类里做同类操作的多个方法，参数校验数量差异 ≥2 处
 *       —— 守卫不一致
 *   B3. 校验「必须是数字」但没用 Number.isFinite / Number.isInteger
 *       —— NaN / Infinity 会漏过
 *
 * 用法：node check-blindspots.mjs <目录>
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const root = process.argv[2];
if (!root) { console.error('用法: node check-blindspots.mjs <目录>'); process.exit(2); }

const findings = [];
const add = (level, rule, file, line, msg) => findings.push({ level, rule, file, line, msg });

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', '.git', 'dist', 'build'].includes(e.name)) continue;
      walk(p, out);
    } else if (['.js', '.mjs', '.cjs', '.ts'].includes(extname(e.name))) {
      out.push(p);
    }
  }
  return out;
}

/** 粗粒度提取方法：名字 + 起止行 + 方法体 */
function extractMethods(src) {
  const lines = src.split('\n');
  const methods = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s{0,4}(?:async\s+)?(?:static\s+)?#?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/);
    if (!m) continue;
    if (['if', 'for', 'while', 'switch', 'catch'].includes(m[1])) continue;
    // constructor 要检查（GT-013 的数值校验就在构造函数里），但 B2 的守卫比对要跳过它
    const isCtor = m[1] === 'constructor';
    let depth = 0, started = false, end = i;
    for (let k = i; k < Math.min(lines.length, i + 200); k++) {
      for (const ch of lines[k]) {
        if (ch === '{') { depth++; started = true; }
        else if (ch === '}') depth--;
      }
      if (started && depth === 0) { end = k; break; }
    }
    methods.push({
      name: m[1],
      line: i + 1,
      body: lines.slice(i, end + 1).join('\n'),
    });
  }
  return methods;
}

for (const f of walk(root)) {
  const rel = relative(root, f).replace(/\\/g, '/');
  let src;
  try { src = readFileSync(f, 'utf8'); } catch { continue; }

  const methods = extractMethods(src);

  // ── B1：返回内部容器元素的活引用 ──
  for (const m of methods) {
    // return this.#items[idx] / this.#map.get(k) / this.#list[i] —— 不带拷贝
    const hits = [...m.body.matchAll(/return\s+this\.#\w+\s*(\[[^\]]*\]|\.get\([^)]*\))/g)];
    for (const h of hits) {
      add('FAIL', 'B1', rel, m.line,
        `${m.name}() 直接返回内部容器的元素（\`${h[0].trim()}\`），` +
        `调用方改它就会改掉内部状态。应返回拷贝（\`{...x}\`）或冻结`);
    }
  }

  // ── B2：同类方法守卫不一致 ──
  // 统计每个方法的参数校验数量
  const guardCount = (body) => (body.match(/typeof\s+\w+|Number\.isInteger|Number\.isFinite|Array\.isArray|instanceof/g) || []).length;
  const withGuards = methods.filter((m) => !m.isCtor && guardCount(m.body) > 0);
  const withoutGuards = methods.filter((m) => !m.isCtor && guardCount(m.body) === 0 && /\b(id|task|key|value|name|param|arg)\b/.test(m.body));
  // 只在一个文件里有 2 个以上同类方法时才比对
  if (withGuards.length >= 1 && withoutGuards.length >= 1) {
    for (const m of withoutGuards) {
      // 找参数名相似的有守卫方法
      const similar = withGuards.find((g) =>
        g.name !== m.name && /^(enqueue|remove|set|get|add|delete|push|pop|insert|update)/.test(g.name) &&
        /^(enqueue|remove|set|get|add|delete|push|pop|insert|update)/.test(m.name),
      );
      if (similar) {
        add('WARN', 'B2', rel, m.line,
          `${m.name}() 没有任何参数校验，而同文件的 ${similar.name}() 有 ${guardCount(similar.body)} 处` +
          `——同类操作守卫不一致，需确认是有意为之`);
      }
    }
  }

  // ── B3：数值校验没用 isFinite/isInteger ──
  // 找「typeof x !== 'number'」这类校验，但同函数内没有 isFinite/isInteger
  for (const m of methods) {
    const hasTypeofNumber = /typeof\s+\w+\s*!==\s*['"]number['"]|typeof\s+\w+\s*===\s*['"]number['"]/.test(m.body);
    const hasFiniteCheck = /Number\.(isFinite|isInteger)/.test(m.body);
    if (hasTypeofNumber && !hasFiniteCheck) {
      // 只有同时做了范围比较（<= 0 之类）才报——说明意图是「正整数」
      if (/[<>]=?\s*0|0\s*[<>]=?/.test(m.body)) {
        add('FAIL', 'B3', rel, m.line,
          `${m.name}() 用 \`typeof x === 'number'\` + 范围比较校验数值，但没有 \`Number.isFinite\`。` +
          `NaN 会通过（typeof NaN === 'number' 且 NaN <= 0 为 false），Infinity 和小数也会通过`);
      }
    }
  }
  // ── B4：调用了作用域里不存在的名字 ──
  {
    const GLOBALS = new Set([
      'console', 'process', 'require', 'module', 'exports', 'Buffer', 'globalThis',
      'Promise', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Math', 'Date',
      'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'Map', 'Set', 'WeakMap',
      'WeakSet', 'Symbol', 'Proxy', 'Reflect', 'BigInt', 'Intl', 'URL', 'URLSearchParams',
      'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask',
      'structuredClone', 'fetch', 'AbortController', 'AbortSignal', 'TextEncoder', 'TextDecoder',
      'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
      'encodeURI', 'decodeURI', 'eval', 'Function', 'super',
      // 其它内置错误类型与全局构造器——漏了会误报「调用了未声明的名字」
      'AggregateError', 'EvalError', 'ReferenceError', 'URIError',
      'WeakRef', 'FinalizationRegistry', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView',
      'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
      'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array',
      'BigUint64Array', 'Atomics', 'WeakMap', 'Iterator',
      'FormData', 'Headers', 'Request', 'Response', 'Blob', 'File', 'FileReader',
      'React', 'defineProps', 'defineEmits', 'describe', 'it', 'test', 'expect', 'beforeEach', 'afterEach',
    ]);
    const KEYWORDS = new Set([
      'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'class', 'typeof',
      'instanceof', 'do', 'else', 'try', 'finally', 'throw', 'new', 'delete', 'void',
      'yield', 'await', 'async', 'of', 'in', 'case', 'default', 'const', 'let', 'var',
      'get', 'set', 'static', 'import', 'export', 'from', 'as',
    ]);

    // 先把「方法定义行」和 `get`/`set` 访问器整行抹掉，
    // 否则 `async incrementAsync() {` / `get value() {` 会被当成调用。
    const cleaned = src
      .split('\n')
      .map((l) =>
        /^\s*(?:async\s+)?(?:static\s+)?(?:get|set)?\s*#?[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/.test(l) ||
        /^\s*(?:async\s+)?(?:static\s+)?(?:get|set)\s+#?[A-Za-z_$][\w$]*\s*$/.test(l)
          ? ''
          : l,
      )
      .join('\n');

    // 判据：某名字若每一处出现都是「调用形式」，且该文件既没 import 也没声明它，
    // 那它一定是未绑定引用。只要它还在别处出现过（参数、属性名、方法定义），就不算。
    const calledAt = new Map();
    for (const m of cleaned.matchAll(/(^|[^.\w$#])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[2];
      if (GLOBALS.has(name) || KEYWORDS.has(name)) continue;
      const idx = m.index + m[1].length;
      if (!calledAt.has(name)) calledAt.set(name, []);
      calledAt.get(name).push(idx);
    }
    // 抹掉定义行之后行号会偏移，用原 src 重新定位
    const lineOf = (name) => {
      const i = src.search(new RegExp(`(^|[^.\\w$#])${name}\\s*\\(`, 'm'));
      return i < 0 ? 0 : src.slice(0, i).split('\n').length;
    };

    for (const [name, positions] of calledAt) {
      if (new RegExp(`import\\s*\\{[^}]*\\b${name}\\b`, 's').test(src)) continue;
      if (new RegExp(`import\\s+\\*?\\s*\\w*\\s*\\{?[^;]*\\b${name}\\b`).test(src.split('\n').slice(0, 20).join('\n'))) continue;
      if (new RegExp(`(function|class|const|let|var)\\s+${name}\\b`).test(src)) continue;

      const all = [...cleaned.matchAll(new RegExp(`(^|[^.\\w$#])${name}\\b`, 'g'))];
      const onlyCalls = all.length > 0 && all.every((m) => {
        const after = cleaned.slice(m.index + m[1].length + name.length).match(/^\s*(.)/);
        return after && after[1] === '(';
      });
      if (!onlyCalls) continue;

      add('FAIL', 'B4', rel, lineOf(name) || src.slice(0, positions[0]).split('\n').length,
        `调用了 \`${name}\`，但它在本文件里从来没有被声明或 import——` +
        `模块加载不报错（名字只在函数体内被引用），一执行到就 ReferenceError。` +
        `检查 \`import\` 解构列表是否漏了这个名字`);
    }
  }
}
const fails = findings.filter((f) => f.level === 'FAIL');
const warns = findings.filter((f) => f.level === 'WARN');

console.log(`\n盲区模式检查: ${walk(root).length} 个文件\n`);
if (findings.length === 0) {
  console.log('  未命中 B1/B2/B3/B4 四种形态');
  console.log('');
  console.log('  ⚠ 这**不等于**「没有缺陷」。');
  console.log('     实测：某代码库有 8 条真缺陷（含 XSS、原型污染、二次转义），本工具 0 命中。');
  console.log('     本工具只认这四种具体代码形态，不具备通用性。\n');
  process.exit(0);
}
for (const f of fails) console.log(`  ✗ [${f.rule}] ${f.file}:${f.line}\n      ${f.msg}`);
for (const f of warns) console.log(`  ! [${f.rule}] ${f.file}:${f.line}\n      ${f.msg}`);
console.log(`\n合计: ${fails.length} FAIL / ${warns.length} WARN\n`);
console.log('这三类对应 2026-11-11 实验里「6 个 agent × 3 轮、18 次审查零命中」的缺陷。');
console.log('工具能机械抓到它们，说明不必依赖 agent 自觉。\n');
process.exit(fails.length > 0 ? 1 : 0);
