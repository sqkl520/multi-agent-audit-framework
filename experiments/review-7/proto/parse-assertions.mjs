// Prototype of the PLAN §A.2 `parse_assertions(src)` for Java/JUnit5.
// No dependencies. Goal: measure how far this idea actually gets on real code.

/* ------------------------------------------------------------------ masking */

/**
 * Returns { code, lit } where
 *   code: same-length string with comment bodies AND string/char literal *contents* blanked
 *         (quote characters are kept, newlines are kept, offsets preserved)
 *   lit : Uint8Array, 1 if that offset belongs to a string/char literal (quotes included)
 * This lets us find call sites / split arguments without being fooled by text inside literals.
 */
export function maskSource(src) {
  const n = src.length;
  const code = new Array(n);
  const lit = new Uint8Array(n);
  const blank = (i) => {
    const c = src[i];
    code[i] = c === '\n' || c === '\r' ? c : ' ';
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    // line comment
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') blank(i++);
      continue;
    }
    // block comment
    if (c === '/' && c2 === '*') {
      blank(i++); blank(i++);
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) blank(i++);
      blank(i++); blank(i++);
      continue;
    }
    // text block
    if (c === '"' && c2 === '"' && src[i + 2] === '"') {
      for (let k = 0; k < 3; k++) { code[i] = '"'; lit[i] = 1; i++; }
      while (i < n) {
        if (src[i] === '\\') { blank(i); lit[i] = 1; i++; if (i < n) { blank(i); lit[i] = 1; i++; } continue; }
        if (src[i] === '"' && src[i + 1] === '"' && src[i + 2] === '"') break;
        blank(i); lit[i] = 1; i++;
      }
      for (let k = 0; k < 3 && i < n; k++) { code[i] = '"'; lit[i] = 1; i++; }
      continue;
    }
    // ordinary string / char literal
    if (c === '"' || c === "'") {
      const q = c;
      code[i] = q; lit[i] = 1; i++;
      while (i < n) {
        if (src[i] === '\\') { blank(i); lit[i] = 1; i++; if (i < n) { blank(i); lit[i] = 1; i++; } continue; }
        if (src[i] === q) break;
        if (src[i] === '\n') break; // unterminated; bail out
        blank(i); lit[i] = 1; i++;
      }
      if (i < n && src[i] === q) { code[i] = q; lit[i] = 1; i++; }
      continue;
    }
    code[i] = c;
    i++;
  }
  return { code: code.join(''), lit };
}

/** remove whitespace that is NOT inside a literal */
export function stripWs(s, lit, offset = 0) {
  let out = '';
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (lit[offset + k]) { out += ch; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') continue;
    out += ch;
  }
  return out;
}

/* ------------------------------------------------------------- call scanning */

const CALL_RE = /(?<![\w$])(assert[A-Z]\w*|fail|verify|expect)\s*\(/g;

function matchParen(code, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < code.length; i++) {
    const ch = code[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitArgs(code, start, end) {
  const ranges = [];
  let depth = 0;
  let s = start;
  for (let i = start; i < end; i++) {
    const ch = code[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      ranges.push([s, i]);
      s = i + 1;
    }
  }
  if (end > s) ranges.push([s, end]);
  return ranges;
}

function lineOf(src, idx) {
  let line = 1;
  for (let i = 0; i < idx && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

/* --------------------------------------------------------------------- atoms */

const LITERAL_NUM = /^-?(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)[lLdDfF]?$/;
const LITERAL_STR = /^"(?:[^"\\]|\\.)*"$/s;
const LITERAL_TEXTBLOCK = /^"""[\s\S]*"""$/;

function isStringish(maskText) {
  const t = maskText.trim();
  if (!t) return false;
  if (t.startsWith('"')) return true; // literal or concatenation that begins with a literal
  return false;
}

/**
 * Canonical subject key + expected + predicate_class for one assertion call.
 * Returns { subject, expected, pclass, note } or { error, reason }.
 */
function classifyCall(fn, argTexts, argMasks) {
  const N = argTexts.length;
  const at = (k) => stripWs(argTexts[k], argMasks[k].lit, argMasks[k].off).trim();
  const maskT = (k) => argMasks[k].code.trim();

  // containers whose children are scanned separately
  if (fn === 'assertAll') return { container: true };

  // trailing human-readable message: last arg is a string expression and arity allows it
  const looksMessage = (k) => isStringish(argMasks[k].code);

  let expected = null;
  let target = null;
  let pclass = null;
  let kind = fn;

  const unary = ['assertTrue', 'assertFalse', 'assertNull', 'assertNotNull'];
  const binary = ['assertEquals', 'assertNotEquals', 'assertSame', 'assertNotSame', 'assertArrayEquals'];

  if (unary.includes(fn)) {
    if (N < 1) return { error: 'no args' };
    target = at(0);
    if (target === '') return { error: 'empty target' };
    expected = { assertTrue: 'true', assertFalse: 'false', assertNull: 'null', assertNotNull: 'notnull' }[fn];
    pclass = fn === 'assertNull' || fn === 'assertFalse' ? 'negative'
      : fn === 'assertNotNull' ? 'existence_only' : 'truthy';
  } else if (fn === 'assertThrows' || fn === 'assertThrowsExactly') {
    if (N < 2) return { error: 'assertThrows needs (Class, executable)' };
    const cls = at(0);
    const exe = at(1);
    // strip a leading lambda arrow, keep the body / method ref as identity
    const body = exe.replace(/^\(\)\s*->\s*/, '').replace(/^\(\s*\)\s*->\s*/, '');
    target = `throws:${body}`;
    expected = cls;
    pclass = 'exact';
    kind = 'assertThrows';
  } else if (fn === 'assertDoesNotThrow') {
    const exe = N >= 2 ? at(1) : at(0);
    target = `nothrow:${exe.replace(/^\(\)\s*->\s*/, '')}`;
    expected = 'nothrow';
    pclass = 'negative';
  } else if (fn === 'fail') {
    return { error: 'fail() is not a subject assertion' };
  } else if (fn === 'verify') {
    // Mockito interaction: the whole call, matchers included, is the identity.
    target = null;
    return { error: 'mockito verify needs whole-call form' };
  } else if (binary.includes(fn)) {
    if (N < 2) return { error: `${fn} needs 2 args` };
    // assertEquals(expected, actual[, delta][, message])
    target = at(1);
    expected = at(0);
    // 3rd arg: numeric literal = delta (JUnit float delta), otherwise a message
    if (fn === 'assertEquals' && N >= 3 && LITERAL_NUM.test(at(2))) {
      expected = `${expected}±${at(2)}`;
    }
    if (target === '') return { error: 'empty actual' };
    if (expected === '') return { error: 'empty expected' };
    pclass = fn === 'assertNotEquals' || fn === 'assertNotSame' ? 'negative' : null;
    kind = fn;
  } else if (fn === 'assertArrayEquals') {
    if (N < 2) return { error: 'assertArrayEquals needs 2 args' };
    expected = at(0); target = at(1); pclass = 'exact';
  } else if (fn === 'assertInstanceOf' || fn === 'assertInstanceOfExactly') {
    if (N < 2) return { error: 'assertInstanceOf needs (Class, actual)' };
    expected = at(0); target = at(1); pclass = 'exact_existence';
  } else {
    return { error: `unknown assertion helper: ${fn}` };
  }

  /* ---------- canonical subject ---------- */

  let subject = null;
  let base = target;

  // size forms
  let m;
  if ((m = base.match(/^(.*)\.size\(\)$/s))) {
    subject = `size(${m[1]})`;
    if (expected === null) { expected = '?'; pclass = pclass || 'truthy'; }
    else pclass = pclass || (isZeroish(expected) ? 'zero_or_empty' : 'exact');
  } else if ((m = base.match(/^(.*)\.length\(\)$/s)) || (m = base.match(/^(.*)\.length$/s))) {
    subject = `size(${m[1]})`;
    pclass = pclass || (isZeroish(expected) ? 'zero_or_empty' : 'exact');
  } else if ((m = base.match(/^(.*)\.isEmpty\(\)$/s))) {
    subject = `size(${m[1]})`;
    if (expected === 'true') { expected = '0'; pclass = 'zero_or_empty'; }
    else if (expected === 'false') { expected = '>0'; pclass = 'non_empty'; }
    else pclass = 'zero_or_empty';
  } else if ((m = base.match(/^!\((.*)\.isEmpty\(\)\)$/s)) || (m = base.match(/^!(.*)\.isEmpty\(\)$/s))) {
    subject = `size(${m[1]})`;
    expected = '>0';
    pclass = 'non_empty';
  } else if ((m = base.match(/^(.*)\.isPresent\(\)$/s))) {
    subject = `${m[1]}.isPresent()`;
    pclass = pclass || (expected === 'true' ? 'existence_only' : 'negative');
  } else if (base === 'true' || base === 'false') {
    return { error: 'boolean literal as target' };
  } else {
    subject = base; // dotted path verbatim, whitespace already stripped
  }

  if (!subject || subject.length === 0) return { error: 'could not derive subject' };

  if (pclass === null) {
    if (expected !== null && isZeroish(expected)) pclass = 'zero_or_empty';
    else if (expected !== null && /^-1/.test(expected)) pclass = 'negative';
    else pclass = 'exact';
  }

  // broadened: a truthiness-only predicate carries no value at all
  if (pclass === 'truthy') pclass = 'existence_only';

  return { subject, expected: expected === null ? '?' : expected, pclass, kind };
}

function isZeroish(e) {
  return /^(0|0L|0\.0|0\.0f|0\.0d|0f|0d)$/.test(e);
}

/* ---------------------------------------------------------------- main parse */

const METHOD_RE = /\n[ \t]*(?:@[\w.]+(?:\([^)]*\))?[ \t\r\n]*)*(?:(?:public|private|protected|static|final|synchronized|abstract|native|default|strictfp)\s+)*(?:<[^>{]{0,80}>\s+)?[\w$.<>\[\], ?]+\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?:throws\s+[\w., \t\r\n]+)?\{/g;

function methodTable(code) {
  const out = [];
  METHOD_RE.lastIndex = 0;
  let m;
  while ((m = METHOD_RE.exec(code))) out.push({ name: m[1], start: m.index });
  return out;
}

function methodAt(table, idx) {
  let name = '<file>';
  for (const t of table) {
    if (t.start <= idx) name = t.name; else break;
  }
  return name;
}

export function parseAssertions(src) {
  const { code, lit } = maskSource(src);
  const table = methodTable(code);
  const subjects = new Map();
  const methods = new Map();
  const unparsable = [];
  const containers = [];
  let callSites = 0;

  CALL_RE.lastIndex = 0;
  let m;
  while ((m = CALL_RE.exec(code))) {
    const fn = m[1];
    const open = code.indexOf('(', m.index + m[0].length - 1);
    if (open < 0) continue;
    const close = matchParen(code, open);
    if (close < 0) {
      unparsable.push({ line: lineOf(src, m.index), fn, reason: 'unbalanced parens', text: src.slice(m.index, m.index + 80) });
      continue;
    }
    callSites++;

    if (fn === 'verify' || fn === 'expect') {
      // Mockito: subject is the whole call text with whitespace stripped.
      const whole = stripWs(src.slice(m.index, close + 1), lit, m.index);
      const mm = methodAt(table, m.index);
      push(subjects, whole, { subject: whole, expected: 'called', pclass: 'interaction', kind: fn, line: lineOf(src, m.index), method: mm });
      bump(methods, mm, whole);
      CALL_RE.lastIndex = close + 1;
      continue;
    }

    const ranges = splitArgs(code, open + 1, close);
    const argTexts = ranges.map(([a, b]) => src.slice(a, b));
    const argMasks = ranges.map(([a, b]) => ({ code: code.slice(a, b), lit, off: a }));
    const r = classifyCall(fn, argTexts, argMasks);

    if (r.container) {
      containers.push({ line: lineOf(src, m.index), fn });
      CALL_RE.lastIndex = open + 1; // keep scanning children
      continue;
    }
    if (r.error) {
      unparsable.push({
        line: lineOf(src, m.index),
        fn,
        reason: r.error,
        text: src.slice(m.index, Math.min(close + 1, m.index + 120)).replace(/\s+/g, ' '),
      });
      CALL_RE.lastIndex = close + 1;
      continue;
    }
    const ln = lineOf(src, m.index);
    const mm = methodAt(table, m.index);
    push(subjects, r.subject, { ...r, line: ln, method: mm });
    bump(methods, mm, r.subject);
    CALL_RE.lastIndex = close + 1;
  }

  // physical lines that *look* like assertions, for comparability with the ground truth's
  // `grep -cE '^\s*(assert|fail|verify)'` metric
  const physical = src.split('\n').filter((l) => /^\s*(assert|fail|verify)/.test(l)).length;

  return {
    subjects, methods, unparsable, containers,
    stats: {
      physicalAssertLines: physical,
      callSites,
      parsed: [...subjects.values()].reduce((a, v) => a + v.length, 0),
      unparsable: unparsable.length,
      containers: containers.length,
      distinctSubjects: subjects.size,
    },
  };
}

function push(map, k, v) {
  if (!map.has(k)) map.set(k, []);
  map.get(k).push(v);
}
function bump(map, k, v) {
  if (!map.has(k)) map.set(k, new Set());
  map.get(k).add(v);
}
