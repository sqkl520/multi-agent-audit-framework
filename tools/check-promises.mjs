#!/usr/bin/env node
/**
 * check-promises.mjs — 检测「承诺未兑现」类缺陷（缺失型缺陷）
 *
 * 为什么需要独立工具：
 *   ground truth 实测发现，13 条注入缺陷里唯一一条两个审查员都完全没发现的，
 *   是「config 返回值少了一个 Object.freeze」——代码每一行都对，只是少做了一件事。
 *   这类缺陷不在代码里，读代码结构上抓不到，只能靠「对照承诺」。
 *
 * 能机械做的三类：
 *   P1. JSDoc 声称返回某类型，实现没有 return
 *   P2. JSDoc 声称 throws，实现从不 throw
 *   P3. 函数返回新建对象，且 JSDoc/注释声称只读/不可变，但没有 freeze
 *
 * 做不到的（明确写出来，不要装作能测）：
 *   - 承诺写在散文里而非 JSDoc
 *   - 「这个该有的守卫没有」——需要知道该有什么
 *   - 跨文件的入参防御
 *
 * 用法：node check-promises.mjs <目录>
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const root = process.argv[2];
if (!root) { console.error('用法: node check-promises.mjs <目录>'); process.exit(2); }

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

const files = walk(root);

// 分母为 0 不等于通过（H2，2026-11-25 锐评实测）。
//
// 输出「承诺兑现检查: 0 个文件 / 未发现『承诺未兑现』」并 exit 0 —— 一次目录改名、
// 一次参数拼错，129 个文件的检查就静默变成「检查了 0 个文件，通过」。
// check-repo 把本工具当作「对真实仓库跑」的一员，它不能空转。
if (files.length === 0) {
  console.error(`\n✗ 在 ${root} 下没有找到任何可检查的源文件——分母为 0，不能判「未发现承诺未兑现」。`);
  console.error('  检查参数是否指向了正确的目录。');
  process.exit(2);
}

/** 抽出所有带 JSDoc 的函数定义（粗粒度，但对本类检查够用） */
function extractFunctions(src, relPath) {
  const lines = src.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // 匹配：function x(...) / async function x / x(...) { / async x(...) {
    const m = l.match(/^\s*(?:export\s+)?(?:async\s+)?(?:function\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{?\s*$/)
      || l.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
    if (!m) continue;
    // 往上找最近的 JSDoc 块
    let docStart = -1;
    for (let k = i - 1; k >= Math.max(0, i - 30); k--) {
      if (/\*\/\s*$/.test(lines[k])) { // JSDoc 结束
        for (let j = k; j >= Math.max(0, k - 25); j--) {
          if (/^\s*\/\*\*/.test(lines[j])) { docStart = j; break; }
        }
        break;
      }
      // 遇到非注释非空行就停
      if (lines[k].trim() !== '' && !/^\s*\*/.test(lines[k]) && !/^\s*\/\*/.test(lines[k])) break;
    }
    if (docStart < 0) continue;
    const doc = lines.slice(docStart, i).join('\n');
    // 找函数体范围（简单括号计数）
    let depth = 0, started = false, end = i;
    for (let k = i; k < Math.min(lines.length, i + 200); k++) {
      for (const ch of lines[k]) {
        if (ch === '{') { depth++; started = true; }
        else if (ch === '}') { depth--; }
      }
      if (started && depth === 0) { end = k; break; }
    }
    out.push({
      name: m[1],
      doc,
      body: lines.slice(i, end + 1).join('\n'),
      line: i + 1,
      docLine: docStart + 1,
    });
  }
  return out;
}

for (const f of files) {
  const rel = relative(root, f).replace(/\\/g, '/');
  let src;
  try { src = readFileSync(f, 'utf8'); } catch { continue; }
  const fns = extractFunctions(src, rel);

  for (const fn of fns) {
    // ── P1：JSDoc 声称返回 boolean/number/string，但函数体没有 return ──
    const retMatch = fn.doc.match(/@returns?\s*\{(\w+)\}/);
    if (retMatch) {
      const type = retMatch[1];
      if (['boolean', 'number', 'string', 'object', 'Array'].includes(type)) {
        if (!/\breturn\b/.test(fn.body)) {
          add('FAIL', 'P1', rel, fn.docLine,
            `${fn.name}() 的 JSDoc 声称 @returns {${type}}，函数体没有任何 return（实际返回 undefined）`);
        }
      }
    }

    // ── P2：JSDoc 声称 @throws，但函数体从不 throw ──
    if (/@throws/.test(fn.doc) && !/\bthrow\b/.test(fn.body)) {
      add('FAIL', 'P2', rel, fn.docLine,
        `${fn.name}() 的 JSDoc 声称会 @throws，函数体从不 throw`);
    }

    // ── P3：声称只读/不可变，但返回值没有 freeze ──
    const claimsImmutable = /只读|不可变|read-?only|immutable|不会被修改|调用方不应修改/i.test(
      fn.doc + '\n' + (src.slice(Math.max(0, src.indexOf(fn.body) - 200), src.indexOf(fn.body)) || ''),
    );
    const returnsNewObject = /return\s*\{/.test(fn.body);
    const hasFreeze = /Object\.(freeze|seal)/.test(fn.body);
    if (claimsImmutable && returnsNewObject && !hasFreeze) {
      add('FAIL', 'P3', rel, fn.line,
        `${fn.name}() 声称返回值只读，但直接 return 一个可变对象，没有 Object.freeze`);
    } else if (returnsNewObject && !hasFreeze && /^[A-Z]?[a-z]*[Cc]onfig|^load/.test(fn.name)) {
      // 弱提示：配置类函数返回可变对象（这不是缺陷，只是提示审计时留意承诺）
      add('WARN', 'P3', rel, fn.line,
        `${fn.name}() 返回新建的普通对象且未 freeze——` +
        `若文档/调用方假设它只读，这里就是缺口（本条是提示，不是结论）`);
    }
  }
}

// 输出
const fails = findings.filter((f) => f.level === 'FAIL');
const warns = findings.filter((f) => f.level === 'WARN');

console.log(`\n承诺兑现检查: ${files.length} 个文件\n`);
if (fails.length === 0 && warns.length === 0) {
  console.log('  未发现「承诺未兑现」\n');
  process.exit(0);
}
for (const f of fails) console.log(`  ✗ [${f.rule}] ${f.file}:${f.line}\n      ${f.msg}`);
for (const f of warns) console.log(`  ! [${f.rule}] ${f.file}:${f.line}\n      ${f.msg}`);
console.log(`\n合计: ${fails.length} FAIL / ${warns.length} WARN\n`);
console.log('说明：本工具只检查「JSDoc 明显写了但实现明显没做」的三类。');
console.log('     承诺写在散文里、或需要知道「该有什么守卫」的情形，它查不出来。\n');
process.exit(fails.length > 0 ? 1 : 0);
