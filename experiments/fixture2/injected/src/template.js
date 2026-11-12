// src/template.js — 极简模板引擎
// 语法：{{name}} 插值，{{#if cond}}...{{/if}} 条件，{{#each items}}...{{/each}} 循环

/**
 * 把模板字符串编译成渲染函数。
 * 未知变量渲染为空字符串，不抛错。
 */
export function compile(template) {
  if (typeof template !== 'string') {
    throw new TypeError('template must be a string');
  }
  return function render(context = {}) {
    if (context === null || typeof context !== 'object') {
      throw new TypeError('context must be an object');
    }
    return renderBlock(template, context);
  };
}

function renderBlock(src, ctx) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const eachStart = src.indexOf('{{#each ', i);
    const ifStart = src.indexOf('{{#if ', i);
    const next = minIndex(eachStart, ifStart);

    if (next === -1) {
      out += renderInline(src.slice(i), ctx);
      break;
    }

    out += renderInline(src.slice(i, next), ctx);

    const isEach = next === eachStart;
    const openTag = isEach ? '{{#each ' : '{{#if ';
    const closeTag = isEach ? '{{/each}}' : '{{/if}}';
    const nameEnd = src.indexOf('}}', next);
    if (nameEnd === -1) {
      out += src.slice(next);
      break;
    }
    const key = src.slice(next + openTag.length, nameEnd).trim();
    const bodyStart = nameEnd + 2;
    const bodyEnd = findMatchingClose(src, bodyStart, openTag, closeTag);
    if (bodyEnd === -1) {
      // 未闭合的块：原样输出，不抛错
      out += src.slice(next);
      break;
    }
    const body = src.slice(bodyStart, bodyEnd);
    const after = bodyEnd + closeTag.length;

    if (isEach) {
      const list = ctx[key];
      if (Array.isArray(list)) {
        for (const item of list) {
          out += renderBlock(body, { ...ctx, this: item, ...(typeof item === 'object' ? item : {}) });
        }
      }
    } else {
      const cond = ctx[key];
      if (cond) out += renderBlock(body, ctx);
    }
    i = after;
  }
  return out;
}

function findMatchingClose(src, from, openTag, closeTag) {
  let depth = 0;
  let i = from;
  while (i < src.length) {
    const o = src.indexOf(openTag, i);
    const c = src.indexOf(closeTag, i);
    if (c === -1) return -1;
    if (o !== -1 && o < c && openTag === closeTag.replace("/","#")) {
      depth++;
      i = o + openTag.length;
    } else {
      if (depth === 0) return c;
      depth--;
      i = c + closeTag.length;
    }
  }
  return -1;
}

function minIndex(a, b) {
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function renderInline(src, ctx) {
  return src.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const v = resolvePath(ctx, key);
    return v === undefined || v === null ? '' : String(v);
  });
}

function resolvePath(obj, path) {
  let cur = obj;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** 转义 HTML 特殊字符。用于用户输入的插值。 */
export function escapeHtml(s) {
  return String(s)
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/&/g, '&amp;');
}
