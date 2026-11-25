/**
 * lib/code-scan.mjs — 判断一段源码里对某个名字的「引用」是不是真代码
 *
 * ── 为什么需要（2026-11-25 锐评实测）────────────────────────────────
 *
 * `check-test-registration.mjs` 的 R4 用裸子串判定「校验器 X 被别的工具引用」：
 *
 *     if (g !== n && src.includes(n)) wired.add(n)
 *
 * 于是**注释里提到**也算接线。实测被这条子串骗过的有两个：
 *
 *     check-contract-slices.mjs   唯一"引用"是 check-contract-slice-fidelity.mjs
 *                                 文件头注释「与 check-contract-slices.mjs 的分工」
 *     check-suite-vitality.mjs    唯一"引用"是 check-all.mjs 的注释
 *                                 「全量按需手动跑：node tools/check-suite-vitality.mjs」
 *
 * 两者都**从不被任何工具调用**，而 R4 判它们已接线。
 * 这正是 R4 要抓的「只在自测里存在」，只不过骗它的人是一段注释。
 *
 * 另外两个坑：
 *   · 文件名互为子串：`consistency.mjs` ⊂ `check-enum-consistency.mjs` /
 *     `severity-consistency.mjs`。裸子串会让前者凭空"被引用"。
 *   · 字符串字面量里的文件名（如 help 文本）同样不是调用。
 *
 * ── 判据 ────────────────────────────────────────────────────────────
 *
 *   stripComments(src)   去掉 `//`、`/* *\/` 注释（保留字符串内容）
 *   referencedNames(src) 返回「出现在**字符串字面量或代码**里」的文件名集合，
 *                        按「完整文件名」匹配（前后不是标识符/文件名续字符）
 *
 *   注意 `referencedNames` **不**区分字符串和代码：一个 `execFileSync('node', ['x.mjs'])`
 *   里的 x.mjs 就在字符串里。真正要排除的只有注释。
 *
 * 这是一个小工具而不是完整词法分析器：目标只有「别把注释当引用」和「别撞子串」。
 * 它宁可漏判（少数真引用被当成没引用）也不误判——误判会让 R4 放行真缺口。
 */

/** 把注释内容替换成空格（保留换行与偏移，字符串原样保留） */
export function stripComments(src) {
  const out = src.split('');
  let i = 0;
  let state = 'code';
  let quote = '';
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (state === 'code') {
      if (c === '/' && n === '/') {
        const s = i;
        while (i < src.length && src[i] !== '\n') i++;
        blank(s, i);
        continue;
      }
      if (c === '/' && n === '*') {
        const s = i;
        i += 2;
        while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
        i = Math.min(i + 2, src.length);
        blank(s, i);
        continue;
      }
      if (c === "'" || c === '"' || c === '`') { state = 'str'; quote = c; i++; continue; }
      i++;
      continue;
    }
    // state === 'str'
    if (c === '\\') { i += 2; continue; }
    if (c === quote) { state = 'code'; i++; continue; }
    i++;
  }
  return out.join('');
}

/**
 * 把注释与**字符串内容**都替换成空格，只留代码。
 *
 * 用途与 `stripComments` 不同：
 *   · `stripComments` 保留字符串——因为「文件名出现在字符串里」是**真引用**
 *     （`execFileSync('node', ['x.mjs'])`）。
 *   · `codeMask` 连字符串一起去掉——用于「只该改代码」的场景，
 *     例如变异测试。2026-11-25 实测：M2 把描述字符串里的
 *     `desc: '...process.exit(1)...'` 也改了，行为不变 → 报「存活」，
 *     而那是假阳性（不是覆盖缺口，是变异打偏了）。
 */
export function codeMask(src) {
  const out = src.split('');
  let i = 0, state = 'code', quote = '';
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '; };
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (state === 'code') {
      if (c === '/' && n === '/') { const s = i; while (i < src.length && src[i] !== '\n') i++; blank(s, i); continue; }
      if (c === '/' && n === '*') {
        const s = i; i += 2;
        while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
        i = Math.min(i + 2, src.length); blank(s, i); continue;
      }
      if (c === "'" || c === '"' || c === '`') { state = 'str'; quote = c; i++; continue; }
      i++; continue;
    }
    // state === 'str'：整个字符串内容都抹掉
    if (c === '\\') { blank(i, i + 2); i += 2; continue; }
    if (c === quote) { blank(i, i + 1); state = 'code'; i++; continue; }
    blank(i, i + 1);
    i++;
  }
  return out.join('');
}

/** 该区间是否落在代码里（不在注释/字符串里） */
export function isCodeAt(src, start, len) {
  const masked = codeMask(src);
  return masked.slice(start, start + len) === src.slice(start, start + len);
}
export function mentionsFile(src, fileName) {
  const code = stripComments(src);
  const esc = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 前后不能是「文件名字符」：字母数字 _ . -（**不含 /** —— 路径分隔符必须能当边界，
  // 否则 'tools/x.mjs' 这种最常见的写法就匹配不到了）。
  // 这样 consistency.mjs 不会命中 check-enum-consistency.mjs（前一个字符是 -），
  // 而 ./tools/x.mjs 与 'x.mjs' 都能命中。
  const re = new RegExp(`(^|[^A-Za-z0-9_.\\-])${esc}(?![A-Za-z0-9_.\\-])`, 'm');
  return re.test(code);
}

/**
 * workflow YAML 里是否有**未注释**的一行真的在跑该脚本。
 *
 * 支持两种写法：
 *   1. 单行      `- run: node tools/x.mjs`
 *   2. 块标量    `run: |` 后面缩进的若干行里有 `node tools/x.mjs`
 *                （本仓库 check-commit-msg 那一步就是这种写法——
 *                  2026-11-25 实测：换成只认单行时它被误报成「没在 CI 里跑」）
 *
 * 注释行（以 # 开头）不算。
 */
export function workflowRuns(yml, fileName) {
  const esc = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lines = yml.replace(/\r\n/g, '\n').split('\n');
  const isRun = (l) => /^\s*(?:-\s*)?run\s*:/.test(l);
  const runsIt = (l) => !/^\s*#/.test(l) && new RegExp(`\\bnode\\b[^\\n]*\\btools/${esc}\\b`).test(l);

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!isRun(l)) continue;
    if (runsIt(l)) return true;
    // 块标量：run: | / run: > / run: |- …
    if (/^\s*(?:-\s*)?run\s*:\s*[|>][-+]?\s*$/.test(l)) {
      const indent = (l.match(/^\s*/) ?? [''])[0].length;
      for (let j = i + 1; j < lines.length; j++) {
        const b = lines[j];
        if (b.trim() === '') continue;
        const bIndent = (b.match(/^\s*/) ?? [''])[0].length;
        if (bIndent <= indent) break;   // 块结束
        if (runsIt(b)) return true;
      }
    }
  }
  return false;
}
