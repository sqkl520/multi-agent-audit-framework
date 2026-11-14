#!/usr/bin/env node
/**
 * verify-artifacts.mjs — 审计产物的机械校验器
 *
 * 只做一件事：把框架里「本来就能机械验证」的规则真的验证一遍。
 *
 * 这些规则此前全部靠提示词约束——由 LLM 互相检查、靠自觉遵守。
 * 写成脚本后，同一个问题从「要相信某个 Agent 的话」变成「跑一次就知道」。
 *
 * ── 用法 ────────────────────────────────────────────────────────────
 *   node verify-artifacts.mjs --repo <被审仓库> --artifacts <产物根目录> [--json] [--strict]
 *
 *   --repo       被审仓库根目录。所有 file 路径相对于它解析。
 *   --artifacts  产物根目录，例如 <OUTDIR>/round31
 *   --json       输出 JSON 而非人类可读文本
 *   --strict     把 WARN 也当作失败（退出码 3）
 *
 * ── 它检查什么（全部无需 LLM 判断）────────────────────────────────────
 *   G0 门 0 回显真实性：evidence.quote 是否真的出现在 evidence.file:line
 *   G1 文件存在性：evidence.file / files_read 路径是否真实存在
 *   G2 产物真实性：artifact_path 指向的文件是否存在且非空
 *   G3 覆盖完整性：files_read 是否覆盖了派发时给的 files[]
 *   G4 账本对账：discipline_log 与 wave2_completed 是否对得上
 *   G5 契约一致性：lead_count / dimension_histogram 等自述数字是否自洽
 *
 * ── 它不检查什么（必须由 LLM 判断，脚本不碰）────────────────────────
 *   证据是否支持主张 / 推断是否成立 / 严重性是否合理 / 可达性判断对不对
 *
 * 退出码：0 = 全通过，1 = 有 FAIL，2 = 用法错误，3 = strict 模式下有 WARN
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute, sep } from 'node:path';

// ────────────────────────────────────────────────────────────────────
// 参数解析
// ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { repo: null, artifacts: null, json: false, strict: false, legacySalvage: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') out.repo = argv[++i];
    else if (a === '--artifacts') out.artifacts = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--strict') out.strict = true;
    else if (a === '--legacy-salvage') out.legacySalvage = true;
    else if (a === '--help' || a === '-h') { out.help = true; }
    else { out.bad = `未知参数: ${a}`; }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────
// 结果收集
// ────────────────────────────────────────────────────────────────────
const findings = [];
function record(level, check, message, detail) {
  findings.push({ level, check, message, detail: detail ?? null });
}
const fail = (c, m, d) => record('FAIL', c, m, d);
const warn = (c, m, d) => record('WARN', c, m, d);
const pass = (c, m, d) => record('PASS', c, m, d);
const skip = (c, m, d) => record('SKIP', c, m, d);

// ────────────────────────────────────────────────────────────────────
// 工具
// ────────────────────────────────────────────────────────────────────

/**
 * 归一化路径。处理三种真实会遇到的形态：
 *   1. Git Bash 风格  /d/Projects/foo  → D:\Projects\foo
 *   2. 正斜杠 Windows  D:/Projects/foo → D:\Projects\foo
 *   3. 普通相对/绝对路径
 *
 * 为什么需要 1：在 Windows 上用 Git Bash 跑脚本时，传进来的 --repo 和产物里
 * 记录的 artifact_path 常常是 /d/... 形态，而 node 的 fs 只认 D:\...。
 * 不归一化会让所有文件「不存在」——校验器会全线误报 FAIL，
 * 比不校验更糟（它会把正确的产物判成违规）。
 */
function normalizePath(p) {
  if (!p || typeof p !== 'string') return p;
  let s = p.trim();
  // /d/foo 或 /c/foo → D:\foo
  const m = s.match(/^\/([a-zA-Z])\/(.*)$/);
  if (m) return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`;
  // 其余情况把正斜杠统一成系统分隔符
  if (/^[a-zA-Z]:[\\/]/.test(s)) return s.replace(/\//g, '\\');
  return s;
}

/** 相对 --repo 解析路径；绝对路径原样返回（均先归一化） */
function resolveRepoPath(repo, p) {
  if (!p) return null;
  const np = normalizePath(p);
  if (isAbsolute(np) || /^[a-zA-Z]:/.test(np)) return np;
  return resolve(repo, np);
}

/** 读取文件全部行（缓存）。读不到返回 null */
const lineCache = new Map();
// 2026-11-14 修（批判 agent 实测）：此前 >8MB 的文件直接返回 null，
// **不报任何东西**——等于「文件太大」悄悄变成「无法验证但算通过」。
// 实测：9.4MB 文件 + 完全编造的 quote → 0 FAIL / 2 WARN / EXIT=0。
// 这是最坏的一种放行：越大的文件越可能有缺陷，而它恰好被跳过。
// 修：超过阈值时记一条 SKIP 到 oversized，调用方据此报 WARN，让「未验证」可见。
const oversized = [];
function readLines(absPath) {
  if (lineCache.has(absPath)) return lineCache.get(absPath);
  let result = null;
  try {
    const st = statSync(absPath);
    if (st.isFile()) {
      if (st.size < 8 * 1024 * 1024) {
        result = readFileSync(absPath, 'utf8').split(/\r?\n/);
      } else {
        oversized.push({ path: absPath, size: st.size });
      }
    }
  } catch { result = null; }
  lineCache.set(absPath, result);
  return result;
}

/** 归一化空白：把连续空白压成单个空格，去首尾。用于宽松比对 */
function norm(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

/**
 * 剥掉 grep 输出的文件名/行号前缀。
 * Agent 常把 `index.html:31:  <button ...>` 整行抄进 quote，
 * 但源文件的第 31 行只有后半段。剥掉前缀后剩余内容仍须逐字匹配源文件，
 * 所以这不是放宽标准，只是去掉工具自带的装饰。
 */
function stripGrepPrefix(q) {
  const s = String(q);
  const m = s.match(/^\s*[^\s:]+:\d+:\s?/);
  return m ? { clean: s.slice(m[0].length), stripped: true } : { clean: s, stripped: false };
}

/**
 * 判断 quote 是否落在某一行里。
 * 三级：
 *   exact   — 去首尾空白后逐字包含
 *   loose   — 压平空白后包含（应对缩进/换行差异）
 *   fuzzy   — 逐 token 顺序匹配（应对行内空白被改写）
 * 返回 'exact' | 'loose' | 'fuzzy' | null
 */
/**
 * quote 是否整行都是注释（不含任何代码）。
 *
 * 只在「匹配成功且是纯注释」时才需要进一步判断——因为注释可以作为
 * 「注释与实现不符」这类缺陷的被审对象，但绝不能作为「代码有缺陷」的证据。
 *
 * 覆盖常见语言：// # -- 单行注释、/* *\/、<!-- -->、以及 Python 的 """。
 */
function isPureCommentLine(quote) {
  const text = String(quote).trim();
  if (!text) return false;
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return false;

  const isComment = (l) =>
    /^\/\//.test(l) ||          // JS/TS/Java/Go/C
    /^#(?![!{])/.test(l) ||     // Python/Shell/Ruby/YAML（排除 shebang 与 #{ 插值）
    /^--/.test(l) ||            // SQL/Lua/Haskell
    /^\/\*/.test(l) ||          // 块注释开头
    /^\*/.test(l) ||            // 块注释续行
    /^<!--/.test(l) ||          // HTML
    /^"""/.test(l);             // Python docstring

  // 整段都是注释行才算「纯注释」
  return lines.every(isComment);
}

function matchQuality(lineText, quote) {
  if (!lineText || !quote) return null;
  // Markdown 转义还原：agent 在反引号包裹的内容里常把 ` 写成 \`
  const q = stripGrepPrefix(String(quote).replace(/\\`/g, '`').replace(/\\\\/g, '\\')).clean;
  const line = String(lineText).replace(/\\`/g, '`').replace(/\\\\/g, '\\');
  if (line.includes(q.trim())) return 'exact';
  if (norm(line).includes(norm(q))) return 'loose';
  // fuzzy：quote 的每个 token 按顺序出现在 line 里
  const tokens = norm(q).split(' ').filter(Boolean);
  if (tokens.length < 3) return null;
  let pos = 0;
  const hay = norm(line);
  for (const t of tokens) {
    const idx = hay.indexOf(t, pos);
    if (idx === -1) return null;
    pos = idx + t.length;
  }
  return 'fuzzy';
}

/** 从产物 markdown 里抽出所有 ```json 块并解析（容忍 // 行注释与尾逗号） */
function extractJsonBlocks(text) {
  const blocks = [];
  const re = /```json\s*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1];
    const lineNo = text.slice(0, m.index).split('\n').length + 1;
    const cleaned = raw
      .split('\n')
      .filter((ln) => !/^\s*\/\//.test(ln))
      .join('\n')
      .replace(/,(\s*[}\]])/g, '$1');
    try {
      blocks.push({ line: lineNo, value: JSON.parse(cleaned) });
    } catch (e) {
      blocks.push({ line: lineNo, error: e.message, raw: raw.slice(0, 200) });
    }
  }
  return blocks;
}

/**
 * 降级抽取：从 Markdown 散文里把 agent 写的线索捞出来。
 *
 * 为什么需要它：实测（round1-web-style）中，一个宽扫 Agent 产出了 12 条线索、
 * quote 全部真实，但写成了 Markdown 散文而非契约要求的 JSON 信封。
 * 校验器解析出 0 个信封，报 SKIP —— 内容全对，却什么都读不到。
 *
 * 这里用保守的正则只捞三类结构明确的信息：
 *   - slice_id：匹配 "slice-XX" 或 "### Slice XX"
 *   - 每条线索：`### L1 — dimension / CONFIDENCE` 这样的标题
 *                下面跟 `- file: xxx` / `- line: N` / `- quote: xxx`
 *
 * 抽到了 → 标记 FORMAT_DEVIATION（内容可用，格式不合规）
 * 抽不到 → 返回 null，调用方按 SKIP 处理（可能真的还没有产物）
 */
function salvageFromMarkdown(text) {
  const lines = text.split(/\r?\n/);

  // 1) slice_id
  let sliceId = null;
  const sm = text.match(/slice[-_ ]?(\d{1,3})/i);
  if (sm) sliceId = `slice-${sm[1].padStart(2, '0')}`;

  // 2) 按 "### L1 ..." 这类标题切块
  const blocks = [];
  let cur = null;
  for (const ln of lines) {
    if (/^#{2,4}\s+L\d+/i.test(ln)) {
      if (cur) blocks.push(cur);
      cur = { title: ln.replace(/^#+\s*/, ''), body: [] };
    } else if (cur) {
      cur.body.push(ln);
    }
  }
  if (cur) blocks.push(cur);

  const leads = [];
  for (const b of blocks) {
    const body = b.body.join('\n');

    // file 与 line 可能在同一行（`- **file**: `x.js` **line 842**`），也可能分行
    let file = null, lineNo = null;

    const combined = body.match(/\*{0,2}file\*{0,2}\s*[:：]\s*`([^`]+)`\s*\*{0,2}line\s*[:：]?\s*(\d+)/i);
    if (combined) {
      file = combined[1];
      lineNo = parseInt(combined[2], 10);
    } else {
      const fileM = body.match(/\*{0,2}file\*{0,2}\s*[:：]\s*`?([^\s`*]+)`?/i) ||
                    body.match(/^[-*]\s*file\s*[:：]\s*`?([^\s`*]+)`?/im);
      const lineM = body.match(/\*{0,2}line\*{0,2}\s*[:：]\s*(\d+)/i) ||
                    body.match(/^[-*]\s*line\s*[:：]\s*(\d+)/im);
      if (fileM) file = fileM[1];
      if (lineM) lineNo = parseInt(lineM[1], 10);
    }
    if (!file || !Number.isFinite(lineNo)) continue;

    // quote 可能本身含反引号（源码里有模板字符串），所以不能简单用 `(.+?)` —
    // 那会在遇到第一个内嵌反引号时截断。改为匹配整行剩余部分，再剥掉首尾的反引号对。
    const quoteLine = body.split(/\r?\n/).find((ln) => /\*{0,2}quote\*{0,2}\s*[:：]/i.test(ln) || /^[-*]\s*quote\s*[:：]/i.test(ln));
    let quoteVal = null;
    if (quoteLine) {
      let v = quoteLine.replace(/^.*?quote\*{0,2}\s*[:：]\s*/i, '').trim();
      // 剥掉外层反引号对（可能是 `...` 或 ``...``）
      v = v.replace(/^`{1,2}/, '').replace(/`{1,2}$/, '').trim();
      quoteVal = v;
    }
    if (!quoteVal) continue;

    // 维度与置信度从标题里取："L1 — error-handling / HIGH"
    const dimM = b.title.match(/—\s*([a-z][a-z-]*)/i) || b.title.match(/[-–]\s*([a-z][a-z-]*)/i);
    const confM = b.title.match(/\b(CRITICAL|HIGH|MEDIUM|LOW)\b/i);

    leads.push({
      lead_id: (b.title.match(/L\d+/i) || [`lead-${leads.length + 1}`])[0],
      suspected_dimension: dimM ? dimM[1].toLowerCase() : 'unknown',
      file: file.replace(/^["'`]|["'`]$/g, '').replace(/\\/g, '/')
        .replace(/^D:\/Web\/style\//, ''),
      line: lineNo,
      quote: quoteVal.replace(/\\`/g, '`').replace(/\\\\/g, '\\'),
      confidence: confM ? confM[1].toUpperCase() : null,
      salvaged: true,
    });
  }

  if (leads.length === 0) return null;
  return { slice_id: sliceId, leads };
}

/** 递归找某个键的所有出现位置，返回 [{path, value}] */
function findAll(obj, key, path = '$', acc = []) {
  if (obj === null || typeof obj !== 'object') return acc;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => findAll(v, key, `${path}[${i}]`, acc));
    return acc;
  }
  for (const [k, v] of Object.entries(obj)) {
    const p = `${path}.${k}`;
    if (k === key) acc.push({ path: p, value: v });
    findAll(v, key, p, acc);
  }
  return acc;
}

/** 递归收集所有 role 信封（含 schema_version 的对象） */
function collectEnvelopes(value, acc = []) {
  if (value === null || typeof value !== 'object') return acc;
  if (Array.isArray(value)) {
    value.forEach((v) => collectEnvelopes(v, acc));
    return acc;
  }
  if (typeof value.role === 'string' && ('payload' in value || 'schema_version' in value)) {
    acc.push(value);
  }
  for (const v of Object.values(value)) collectEnvelopes(v, acc);
  return acc;
}

// ────────────────────────────────────────────────────────────────────
// 校验 1 · 门 0 回显真实性
// ────────────────────────────────────────────────────────────────────
function checkGate0(repo, envelopes, salvagedLeads = []) {
  let checked = 0, ok = 0, bad = 0, noLine = 0, unreadable = 0;

  // 降级线索走同一套比对逻辑（它们来自 Markdown 散文，不是 JSON 信封）
  const pseudoEnvelopes = salvagedLeads.length
    ? [{ role: 'sweep', payload: { findings: salvagedLeads.map((l) => ({
        finding_id: l.lead_id,
        evidence: { file: l.file, line: l.line, quote: l.quote },
      })) } }]
    : [];

  for (const env of [...envelopes, ...pseudoEnvelopes]) {
    // 2026-11-09 修复：原来只找 `evidence` 字段，于是 sweep 产物（用 `leads`）
    // 全部被 SKIP —— 而 sweep 恰恰是最需要机械校验的一层。
    // leads 和 findings[].evidence 的字段名不同，但校验目标相同：
    // file + line + quote 是否真实存在于源文件。
    const evidences = [
      ...findAll(env, 'evidence'),
      // sweep 的 leads：每个 lead 就是一条 (file, line, quote)
      ...findAll(env, 'leads').flatMap(({ path, value }) =>
        Array.isArray(value) ? value.map((l) => ({ path, value: l })) : []),
    ];
    for (const { path, value } of evidences) {
      // evidence 可能是数组（一条发现多个证据）或对象
      const items = Array.isArray(value) ? value : [value];
      for (const ev of items) {
        if (!ev || typeof ev !== 'object') continue;
        // 2026-11-10 修正「空集即通过」后门：
        // 此前「缺 file 或缺 quote」的 evidence 直接 continue，于是攻击者
        // 只要把 quote 字段整个删掉，checked 就是 0 → G0 判 SKIP → 放行。
        //
        // 但第一次修补引入了回归：不加区分地要求所有 evidence 都有 file+quote，
        // 把合法的 NO_EVIDENCE_FOUND（契约 output-contract.md §2.2 明确要求
        // evidence 三个字段全为 null）也判成了 FAIL。那是惩罚诚实、奖励伪造——
        // 遵守契约的 Agent 被拒，随手塞个假 quote 反而通过。
        //
        // 正确判据是「这条 finding 是否声称了一处具体证据」：
        //   NO_EVIDENCE_FOUND / UNREADABLE / EVIDENCE_GAP → evidence 应当为空，跳过
        //   CONFIRMED / GATE_0_FAILED                      → 必须 file+quote 齐全
        // 判断这条 finding 是否声称了具体证据。status 在父对象上，
        // 需要从 path（形如 $.payload.findings[0].evidence）回溯上去取。
        const parentPath = path.replace(/\.evidence$/, '');
        let parent = null;
        if (parentPath !== path) {
          // 从 path 求值：把 $.a.b[0] 转成 ["a","b",0]
          const segs = parentPath.replace(/^\$\.?/, '').split(/\.|\[|\]/).filter(Boolean)
            .map((s) => (/^\d+$/.test(s) ? Number(s) : s));
          let cur = env;
          for (const s of segs) { if (cur == null) break; cur = cur[s]; }
          parent = cur;
        }
        const ST = parent?.status;
        const CLAIMS_EVIDENCE = ['CONFIRMED', 'GATE_0_FAILED'];
        const NO_EVIDENCE = ['NO_EVIDENCE_FOUND', 'UNREADABLE', 'EVIDENCE_GAP'];
        if (NO_EVIDENCE.includes(ST)) continue;         // 合法空证据，不参与门 0
        const hasFile = !!ev.file;
        const hasQuote = ev.quote !== undefined && ev.quote !== null;
        if (!hasFile || !hasQuote) {
          // 只有声称了证据的 finding 缺字段才算违规
          if (CLAIMS_EVIDENCE.includes(ST) || !ST) {
            const missing = [!hasFile && 'file', !hasQuote && 'quote'].filter(Boolean).join(' + ');
            fail('G0', `evidence 缺 ${missing}：status=${ST ?? '未声明'} 的发现必须有 file:line + quote（${path}）`, { at: path });
            bad++;
          }
          continue;
        }
        checked++;

        const abs = resolveRepoPath(repo, ev.file);
        if (!abs || !existsSync(abs)) {
          fail('G0', `evidence.file 不存在: ${ev.file}`, { at: path });
          unreadable++;
          continue;
        }
        const lines = readLines(abs);
        if (!lines) {
          warn('G0', `evidence.file 无法读取: ${ev.file}`, { at: path });
          unreadable++;
          continue;
        }
        if (typeof ev.line !== 'number') {
          warn('G0', `evidence.line 缺失或非数字: ${ev.file}`, { at: path });
          noLine++;
          continue;
        }
        // 行号越界
        if (ev.line < 1 || ev.line > lines.length) {
          fail('G0', `evidence.line=${ev.line} 超出文件行数 ${lines.length}: ${ev.file}`, { at: path });
          bad++;
          continue;
        }

        // 允许 quote 跨多行：从 line 开始向下找，最多 15 行
        const quoteStr = String(ev.quote);
        // 2026-11-10（蓝队 A6）：quote 必须有最小信息量。
        // 一个 1-2 字符的碎片几乎必然在任意行里出现，等于没有证据。
        if (norm(quoteStr).length < 12) {
          fail('G0', `quote 过短（${norm(quoteStr).length} 字符）：不足 12 字符的碎片不能构成"逐字回显"`, {
            at: path, quote: quoteStr,
          });
          bad++;
          continue;
        }
        const span = Math.min(15, lines.length - ev.line + 1);
        // 2026-11-10（蓝队 A6）：窗口高度必须覆盖 quote 自身的行数。
        // 原实现每次只取 1 行，跨行 quote 永远匹配不上——于是落到「整文件模糊命中」
        // 那条 fallback，等于把「引错了行」当成「引对了」。
        const quoteLines = Math.max(1, quoteStr.split('\n').length);
        let best = null;
        for (let k = 0; k < span; k++) {
          const windowText = lines.slice(ev.line - 1 + k, ev.line - 1 + k + quoteLines).join('\n');
          const q = matchQuality(windowText, quoteStr);
          if (q === 'exact') { best = { quality: q, at: ev.line + k }; break; }
          // 2026-11-10（蓝队 A6）：删掉 fuzzy 分支。
          // 它允许省略运算符（"const total acct.balance amt" 能匹配
          // "const total = acct.balance - amt;"），而格式偏差正是最该被报出来的。
          if (q === 'loose' && !best) best = { quality: q, at: ev.line + k };
        }
        if (!best) {
          // 再多行 quote 也试试整段（应对大块引用）
          const whole = lines.join('\n');
          if (norm(whole).includes(norm(quoteStr))) best = { quality: 'loose', at: null };
        }

        if (!best) {
          fail('G0', `quote 未出现在 ${ev.file}:${ev.line} 附近`, {
            at: path,
            quote: quoteStr.slice(0, 120),
            actual: lines[ev.line - 1]?.slice(0, 120) ?? null,
          });
          bad++;
        } else if (best.quality === 'exact') {
          // 2026-11-12 门 0 红队实测新增：注释不是证据。
          // 实测：`// 不安全版本：容量检查写错` 这一行注释，行号准确、引文逐字存在，
          // 旧版判 PASS——但注释是作者的描述，不是代码的行为。
          // 用它支撑「代码有缺陷」等于把「人说它有问题」当成「它有问题」。
          //
          // 例外：缺陷本身就是「注释与实现不符」（JSDoc 声称返回 boolean 但无 return）。
          // 那时注释是被审对象而非证据，inference 里会提到"注释/JSDoc/@returns"等词。
          // 判据取「quote 是纯注释行」且「inference 没在讨论注释本身」。
          const pureComment = isPureCommentLine(quoteStr);
          // 只认「把注释当被审对象」的表述，不能宽到「句子里出现"注释"」——
          // 攻击者完全可以让 basis 写「注释说这里不安全」，那是用注释当证据，
          // 恰恰是这条规则要拦的。
          //
          // 2026-11-12 扩充：实测漏掉了「与 JSDoc 声明的『…』矛盾」这类写法
          // （真实产物 slice-01-logic-f03 因此被误伤）。
          const discussesComments = /注释(与|和)(实现|代码|行为)不符|注释声称|注释写(着|的是)|JSDoc|@returns\s*声称|文档(声称|声明)|注释与实现矛盾|声明.{0,6}未兑现|(与|和).{0,12}(声明|约定|注释).{0,10}(矛盾|不符|不一致)|实现与(文档|注释)/i
            .test(String(parent?.inference?.claim ?? '') + ' ' + String(parent?.inference?.basis ?? ''));

          // 结构性豁免（比关键词可靠）：同一个 finding 里若另有 evidence 引用了
          // 真实代码行，则这条注释是「被审对象」而不是唯一证据——注释与实现不符
          // 这类缺陷本来就要求同时引注释和代码。
          const siblings = Array.isArray(parent?.evidence) ? parent.evidence : [];
          const hasCodeEvidence = siblings.some((s) =>
            s && s !== ev &&
            typeof s.quote === 'string' && s.quote.trim() !== '' &&
            !isPureCommentLine(s.quote));

          if (pureComment && !discussesComments && !hasCodeEvidence) {
            fail('G0', `quote 是纯注释行，不能作为代码缺陷的证据（${ev.file}:${ev.line}）。` +
              `注释是作者对代码的描述，不是代码的行为。请引用实际代码行；` +
              `若缺陷本身就是「注释与实现不符」，请在 inference 中写明`, {
              at: path, quote: quoteStr.slice(0, 120),
            });
            bad++;
            continue;
          }
          ok++;
        } else if (best.at === null) {
          // 2026-11-10（蓝队 A6）：quote 只在整个文件里模糊命中，不在声称行附近
          fail('G0', `quote 仅在整个文件里模糊出现，不在声称的 ${ev.file}:${ev.line} 附近`, {
            at: path, quote: quoteStr.slice(0, 120),
          });
          bad++;
        } else if (best.at !== ev.line) {
          // 2026-11-10（蓝队 A6）：quote 在附近但不在声称的那一行
          fail('G0', `quote 出现在第 ${best.at} 行，但声称第 ${ev.line} 行（${ev.file}）`, {
            at: path, quote: quoteStr.slice(0, 120),
          });
          bad++;
        } else {
          warn('G0', `quote 在 ${best.quality} 级别匹配（空白/换行差异）: ${ev.file}:${ev.line}`, {
            at: path, matched_at: best.at,
          });
          ok++;
        }
      }
    }
  }

  // 2026-11-10：bad > 0 时不能 skip。缺 quote 的 evidence 已经把 bad 加上去了，
  // 此时 checked 可能仍是 0——旧逻辑会在这里 skip 掉，把一条 FAIL 变成「无事发生」。
  if (bad > 0) {
    fail('G0', `门 0 回显: ${ok}/${checked} 通过，${bad} 条 evidence 缺 file 或 quote（等于没有证据）`);
    return;
  }
  if (checked === 0) return skip('G0', '产物中没有任何需要门 0 校验的 evidence，跳过');
  const msg = `门 0 回显: ${ok}/${checked} 通过（${bad} 条 quote 与源文件不符，${noLine} 条缺 line，${unreadable} 条文件不可读）`;
  if (noLine > 0 || unreadable > 0) warn('G0', msg);
  else pass('G0', msg);
}

// ────────────────────────────────────────────────────────────────────
// 校验 2 · files_read 存在性与覆盖完整性
// ────────────────────────────────────────────────────────────────────
// 2026-11-10（蓝队 A4）：G3 此前用 findAll(env.payload,'files') —— 产物自己写的 files。
// 而 sweep 契约里根本没有 files 字段，所以 sliceFiles 恒为空 → G3 永远 PASS。
// 实测：合规 sweep 产物只读 1/2 文件，仍报「切片覆盖缺 0 条」。
//
// 改为「账本说该读什么 vs 产物说读了什么」的交叉比对：
//   声明侧 = state.slices[slice_id].files（侦察波写入，不是本产物自述）
//   实际侧 = 产物的 files_read
// 两者不一致 = 可疑信号。这比「自述与自述比」强一层，虽然主 Agent 也可能被污染。
function checkFilesRead(repo, envelopes, state) {
  let totalLists = 0, totalFiles = 0, missing = 0, uncovered = 0;

  for (const env of envelopes) {
    const lists = findAll(env, 'files_read');
    for (const { path, value } of lists) {
      if (!Array.isArray(value)) {
        fail('G1', `files_read 不是数组: ${path}`);
        continue;
      }
      totalLists++;
      for (const raw of value) {
        totalFiles++;
        // 2026-11-14 修：files_read 的元素有两种合法形态——
        //   sweep 契约：{ path, lines, quote }   （对象）
        //   其它角色：  "src/a.js"               （字符串）
        // 此前直接把元素丢给 resolveRepoPath（内部调 path.isAbsolute），
        // 遇到对象就抛 TypeError: The "path" argument must be of type string.
        // 而对象形态正是 sweep 的**标准形态**——等于这个校验器对 sweep 产物直接崩溃。
        const f = (raw && typeof raw === 'object' && !Array.isArray(raw))
          ? (raw.path ?? raw.file ?? null)
          : raw;
        if (f === null) {
          fail('G1', `files_read 元素既不是字符串也没有 path 字段: ${JSON.stringify(raw).slice(0, 80)}`,
            { at: path });
          missing++;
          continue;
        }
        const abs = resolveRepoPath(repo, f);
        if (!abs || !existsSync(abs)) {
          fail('G1', `files_read 声明的文件不存在: ${f}`, { at: path });
          missing++;
        } else {
          // 2026-11-14 修（红队实测）：`existsSync` 对**目录**也返回 true，
          // 于是 `files_read: ["src"]` / ["."] 能通过 G1——而目录不是「读过的文件」。
          // 这比「填了不存在的文件」更难发现：它看起来是合法的路径，
          // 但声称「读了 src 目录」这句话本身没有意义。
          try {
            if (statSync(abs).isDirectory()) {
              fail('G1', `files_read 声明的是目录不是文件: ${f}——目录不能作为「读过的文件」`, { at: path });
              missing++;
            }
          } catch { /* statSync 失败按不存在处理，上面已报 */ }
        }
      }

      // 覆盖完整性：优先用账本的切片定义（权威），退回产物自述（兼容旧产物）
      const sid = env.payload?.slice_id;
      const declared = state?.slices?.[sid]?.files;
      // files_read 的元素可能是字符串，也可能是 { path, lines, quote }（sweep 契约形态）。
      // 这里必须先归一化再 resolve——否则对象会直接喂进 path.isAbsolute 并抛错。
      const entryPath = (x) => (x && typeof x === 'object' && !Array.isArray(x))
        ? (x.path ?? x.file ?? null) : x;
      const readSet = new Set(
        value.map(entryPath).filter((x) => typeof x === 'string').map((x) => resolveRepoPath(repo, x)));

      if (Array.isArray(declared) && declared.length > 0) {
        // 权威路径
        for (const want of declared) {
          if (!readSet.has(resolveRepoPath(repo, want))) {
            warn('G3', `账本声明本切片应读 ${want}，但产物 files_read 里没有（slice=${sid}）`, { slice_id: sid });
            uncovered++;
          }
        }
      } else {
        // 回退：产物自述。同时警告——账本没记这个切片的 files，比对退化了
        const sliceFiles = findAll(env.payload ?? {}, 'files');
        for (const sf of sliceFiles) {
          if (!Array.isArray(sf.value)) continue;
          for (const want of sf.value) {
            if (!readSet.has(resolveRepoPath(repo, want))) {
              warn('G3', `切片声明要读的文件未出现在 files_read: ${want}`, { slice_path: sf.path });
              uncovered++;
            }
          }
        }
        if (sid && state && !declared) {
          warn('G3', `state.slices["${sid}"].files 缺失，覆盖比对退化为「产物自述 vs 产物自述」——` +
                     `这种比对两边可以一起编，不能作为覆盖证据`, { slice_id: sid });
        }
      }
    }
  }

  if (totalLists === 0) return skip('G1', '没有 files_read 字段，跳过');
  const msg = `files_read: ${totalFiles} 条路径，${missing} 条不存在；切片覆盖缺 ${uncovered} 条`;
  if (missing > 0) fail('G1', msg);
  else if (uncovered > 0) warn('G3', msg);
  else pass('G1', msg);

  // ── 声明范围 vs 证据范围（2026-11-12 新增，G7）──────────────────
  // 缺口：G1 只验「声明的文件存在」，G3 只验「覆盖完整」。两者都能靠复制路径列表满足。
  //
  // 实测：声称读了 20 个文件、对其中 19 个一个 quote 都没有 → PASS，0 警告。
  // 更糟的是激励方向反了——诚实报「只读了 1 个」的会被 G3 警告 19 条，
  // 而把 20 个全列上的反而全绿。**这等于奖励撒谎。**
  //
  // 判据：files_read 里每个文件，要么有 quote 指向它，要么显式记在
  // `files_scanned_without_findings` 里。两者都没有 = 这个文件是「填数」的。
  // 用比例而非绝对数判定，因为大切片里总会有几个没问题的文件。
  let scopeChecked = 0, scopeSuspect = 0;
  for (const env of envelopes) {
    const scopes = findAll(env, 'searched_scope');
    if (!scopes.length) continue;
    for (const { path: scPath, value: sc } of scopes) {
      if (!sc || !Array.isArray(sc.files_read) || sc.files_read.length < 3) continue;

      // 收集本产物里所有 evidence.file（含 leads）
      const quoted = new Set();
      for (const { value: evs } of findAll(env, 'evidence')) {
        for (const ev of (Array.isArray(evs) ? evs : [evs])) {
          if (ev?.file) quoted.add(String(ev.file).replace(/\\/g, '/'));
        }
      }
      for (const { value: leads } of findAll(env, 'leads')) {
        if (!Array.isArray(leads)) continue;
        for (const l of leads) if (l?.file) quoted.add(String(l.file).replace(/\\/g, '/'));
      }

      // 标注过「扫过但没发现」的文件（可选字段，没有就当空）
      const scanned = new Set(
        (Array.isArray(sc.files_scanned_without_findings) ? sc.files_scanned_without_findings : [])
          .map((f) => String(f).replace(/\\/g, '/')),
      );

      const claimed = sc.files_read.map((f) => String(f).replace(/\\/g, '/'));
      const dangling = claimed.filter((f) => !quoted.has(f) && !scanned.has(f));
      scopeChecked++;

      // 超过一半的声明文件既无引用也无「扫过」标注 → 声明不可信
      if (dangling.length > claimed.length / 2) {
        scopeSuspect++;
        warn('G7', `声称读了 ${claimed.length} 个文件，但其中 ${dangling.length} 个既没有 quote 指向、` +
          `也没记入 files_scanned_without_findings（${scPath}）。` +
          `例如: ${dangling.slice(0, 3).join(', ')}${dangling.length > 3 ? ' …' : ''}。` +
          `声明范围大于证据范围时，「覆盖率」不可信——` +
          `这不是说文件没读，而是说读没读在产物上无法区分`, { at: scPath, quoted: quoted.size });
      }
    }
  }
  if (scopeChecked > 0 && scopeSuspect === 0) {
    pass('G7', `声明范围与证据范围一致（检查 ${scopeChecked} 份产物）`);
  }
}

// ────────────────────────────────────────────────────────────────────
// 校验 3 · artifact_path 真实性
// ────────────────────────────────────────────────────────────────────
function checkArtifactPaths(repo, artifactsRoot, envelopes) {
  let checked = 0, missing = 0, empty = 0, reused = 0, inRepo = 0;
  // 2026-11-10（蓝队 A5）：两个 Agent 指向同一个产物文件 → 有人在复用别人的产物
  const seenPaths = new Map();

  for (const env of envelopes) {
    if (env.status !== 'SUCCESS') continue;
    checked++;
    const ap = env.artifact_path;
    if (!ap || typeof ap !== 'string') {
      fail('G2', `status=SUCCESS 但 artifact_path 缺失（role=${env.role}）`, { agent_id: env.agent_id });
      missing++;
      continue;
    }
    // 2026-11-10（蓝队 A5）：只允许相对产物根解析。
    // 此前还有一条 `resolveRepoPath(repo, ap)` 的 fallback——于是 artifact_path
    // 指向被审仓库里一个**本来就存在的源码文件**也能通过 G2。
    // 契约 output-contract.md:88 明文要求「仓库外绝对路径或 <OUTDIR> 相对路径」，
    // fallback 到 repo 与契约直接矛盾。
    //
    // 但仍要用 normalizePath 处理 Git Bash 风格（/c/Users/... → C:\Users\...），
    // 否则在 Windows 上会误报。
    const normalized = normalizePath(ap);
    let abs;
    if (isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
      abs = normalized;                           // 绝对路径直接用
    } else {
      abs = resolve(artifactsRoot, normalized);   // 相对路径只按产物根解析
    }
    // 落在被审仓库内的绝对路径 → 那是源码，不是产物
    const repoAbs = resolve(repo);
    if (abs && resolve(abs).startsWith(repoAbs + sep)) {
      fail('G2', `artifact_path 指向被审仓库内的文件（那是源码不是产物）: ${ap}`, { agent_id: env.agent_id });
      inRepo++;
      continue;
    }
    if (!existsSync(abs)) {
      fail('G2', `artifact_path 指向的文件不存在: ${ap}`, { agent_id: env.agent_id });
      missing++;
      continue;
    }
    // 复用检测
    const real = resolve(abs);
    if (seenPaths.has(real)) {
      fail('G2', `两个 Agent 指向同一产物文件: ${ap}（${seenPaths.get(real)} 与 ${env.agent_id}）`, {
        agent_id: env.agent_id,
      });
      reused++;
    } else {
      seenPaths.set(real, env.agent_id ?? '(未命名)');
    }
    const st = statSync(abs);
    if (st.size === 0) {
      fail('G2', `artifact_path 指向的文件是空文件: ${ap}`, { agent_id: env.agent_id });
      empty++;
    }
  }

  if (checked === 0) return skip('G2', '没有 status=SUCCESS 的信封，跳过');
  const msg = `artifact_path: ${checked} 个 SUCCESS 信封，${missing} 个缺路径或文件不存在，` +
              `${empty} 个空文件，${reused} 个复用，${inRepo} 个指向被审仓库`;
  if (missing > 0 || empty > 0 || reused > 0 || inRepo > 0) fail('G2', msg);
  else pass('G2', msg);
}

// ────────────────────────────────────────────────────────────────────
// 校验 3b · G8：切片自述的行数必须与实测一致（2026-11-10 蓝队 A10）
// ────────────────────────────────────────────────────────────────────
// 此前 line_count 是纯自述，工具里零处校验。实测「line_count: 40000（实际 6 行）」
// 和「line_count: 6」都判 EXIT=0。
//
// 危害：`oversized_file` 判定依赖 line_count 超过 1800，而「大文件」的处理方式是
// 允许抽样阅读。自述一个巨大的行数 = 给自己开一张「可以不逐行读」的许可证。
//
// 修法：拿实际文件行数对账。超过 10% 或 10 行的偏差就报。
function checkLineCounts(repo, envelopes) {
  let checked = 0, bad = 0;
  for (const env of envelopes) {
    const slices = env.payload?.audit_slices;
    if (!Array.isArray(slices)) continue;
    for (const s of slices) {
      if (typeof s?.line_count !== 'number') continue;
      const files = Array.isArray(s.files) ? s.files : [];
      if (files.length === 0) continue;
      let actual = 0, readable = 0;
      for (const f of files) {
        const abs = resolveRepoPath(repo, f);
        const lines = abs ? readLines(abs) : null;
        if (lines) { actual += lines.length; readable++; }
      }
      if (readable === 0) continue;         // 一个文件都读不到，无法对账
      checked++;
      const tol = Math.max(10, actual * 0.1);
      if (Math.abs(actual - s.line_count) > tol) {
        fail('G8', `切片 ${s.slice_id ?? '?'} 自述 line_count=${s.line_count}，实测 ${actual}（偏差 ${Math.abs(actual - s.line_count)} 行，容差 ${Math.round(tol)}）`, {
          slice_id: s.slice_id,
        });
        bad++;
      }
    }
  }
  if (checked === 0) return skip('G8', '没有可对账的 line_count，跳过');
  const msg = `line_count: ${checked} 个切片，${bad} 个与实测不符`;
  if (bad > 0) fail('G8', msg);
  else pass('G8', msg);
}

// ────────────────────────────────────────────────────────────────────
// 校验 4 · 自述数字自洽
// ────────────────────────────────────────────────────────────────────
function checkSelfConsistency(envelopes) {
  let checked = 0, bad = 0;

  for (const env of envelopes) {
    const p = env.payload;
    if (!p || typeof p !== 'object') continue;

    // sweep: lead_count == len(leads)
    if (typeof p.lead_count === 'number' && Array.isArray(p.leads)) {
      checked++;
      if (p.lead_count !== p.leads.length) {
        fail('G5', `lead_count=${p.lead_count} 但 leads.length=${p.leads.length}`, { agent_id: env.agent_id });
        bad++;
      }
    }
    // sweep: dimension_histogram 之和 == lead_count
    if (p.dimension_histogram && typeof p.dimension_histogram === 'object' && typeof p.lead_count === 'number') {
      checked++;
      const sum = Object.values(p.dimension_histogram).reduce((a, b) => a + (Number(b) || 0), 0);
      if (sum !== p.lead_count) {
        fail('G5', `dimension_histogram 之和=${sum} 但 lead_count=${p.lead_count}`, { agent_id: env.agent_id });
        bad++;
      }
    }
    // recon: slice_count == len(audit_slices)
    if (typeof p.slice_count === 'number' && Array.isArray(p.audit_slices)) {
      checked++;
      if (p.slice_count !== p.audit_slices.length) {
        fail('G5', `slice_count=${p.slice_count} 但 audit_slices.length=${p.audit_slices.length}`, { agent_id: env.agent_id });
        bad++;
      }
    }
    // audit: findings 不能为空数组
    if (env.role === 'audit' && Array.isArray(p.findings) && p.findings.length === 0) {
      fail('G5', 'audit 的 findings 是空数组（应为 NO_EVIDENCE_FOUND 条目）', { agent_id: env.agent_id });
      bad++;
    }
  }

  if (checked === 0) return skip('G5', '没有可校验的自述数字，跳过');
  const msg = `自述数字自洽: ${checked} 项检查，${bad} 项不一致`;
  if (bad > 0) fail('G5', msg);
  else pass('G5', msg);
}

// ────────────────────────────────────────────────────────────────────
// 校验 5 · 账本对账（discipline_log vs wave2_completed）
// ────────────────────────────────────────────────────────────────────
// 找并解析 state.json：优先 artifacts 根，其次上一级，再向下找一层
function loadState(artifactsRoot) {
  const candidates = [
    join(artifactsRoot, 'state.json'),
    join(artifactsRoot, '..', 'state.json'),
  ];
  let statePath = candidates.find((p) => existsSync(p));
  if (!statePath) {
    try {
      for (const e of readdirSync(artifactsRoot, { withFileTypes: true })) {
        if (e.isDirectory()) {
          const p = join(artifactsRoot, e.name, 'state.json');
          if (existsSync(p)) { statePath = p; break; }
        }
      }
    } catch { /* ignore */ }
  }
  if (!statePath) return { path: null, state: null, error: null };
  try {
    return { path: statePath, state: JSON.parse(readFileSync(statePath, 'utf8')), error: null };
  } catch (e) {
    return { path: statePath, state: null, error: e };
  }
}

function checkLedger(repo, artifactsRoot) {
  // 找 state.json：优先 artifacts 根，其次向下找
  const candidates = [
    join(artifactsRoot, 'state.json'),
    join(artifactsRoot, '..', 'state.json'),
  ];
  let statePath = candidates.find((p) => existsSync(p));
  if (!statePath) {
    // 递归找一层
    try {
      for (const e of readdirSync(artifactsRoot, { withFileTypes: true })) {
        if (e.isDirectory()) {
          const p = join(artifactsRoot, e.name, 'state.json');
          if (existsSync(p)) { statePath = p; break; }
        }
      }
    } catch { /* ignore */ }
  }
  if (!statePath) return skip('G4', '找不到 state.json，跳过账本对账');

  let state;
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch (e) {
    return fail('G4', `state.json 无法解析: ${e.message}`, { path: statePath });
  }

  const completed = Array.isArray(state.wave2_completed) ? state.wave2_completed : null;
  const log = Array.isArray(state.discipline_log) ? state.discipline_log : null;

  if (!completed) return skip('G4', 'state.json 没有 wave2_completed 数组，跳过');

  let problems = 0;

  // (a) 标了 dimension_assigned_by_discretion 的派发，必须有对应裁量记录
  const discretionary = completed.filter((c) => c.dimension_assigned_by_discretion === true);
  for (const d of discretionary) {
    const hasLog = (log ?? []).some((l) =>
      (l.discretion_type === 'DIMENSION_ASSIGNMENT') &&
      (JSON.stringify(l.action ?? '').includes(d.slice_id ?? '\u0000'))
    );
    if (!hasLog) {
      fail('G4', `派发 ${d.slice_id} 标了裁量指派维度，但 discipline_log 无对应记录`, {
        agent_id: d.agent_id,
      });
      problems++;
    }
  }

  // (b) 每条 L1 裁量必须有 mechanical_check 非空
  for (const l of log ?? []) {
    if (!l.mechanical_check || String(l.mechanical_check).trim() === '') {
      fail('G4', `discipline_log seq=${l.seq} 缺 mechanical_check（退化为 L0 主观判断）`);
      problems++;
    }
  }

  // (c) 每个 SUCCESS 的派发，artifact_path 应有值
  for (const c of completed) {
    if (c.final_status === 'SUCCESS' && !c.artifact_path) {
      fail('G4', `wave2_completed 中 ${c.slice_id} 状态 SUCCESS 但 artifact_path 为空`);
      problems++;
    }
  }

  // (d) 失败率阈值（protocol.md §3.1）
  const budget = state.budget ?? {};
  const fs2a = Number(budget.failed_sweep ?? 0);
  const ps2a = Number(budget.planned_sweep_agents ?? 0);
  const fs2b = Number(budget.failed_deep_dive ?? 0);
  const sp2b = Number(budget.spawned_deep_dive ?? 0);
  if (ps2a > 0 && fs2a / ps2a > 0.2) {
    warn('G4', `宽扫失败率 ${(fs2a / ps2a * 100).toFixed(1)}% 超过 20%——这些切片必须全部进入深挖队列`);
  }
  if (sp2b > 0 && fs2b / sp2b > 0.2) {
    warn('G4', `深挖失败率 ${(fs2b / sp2b * 100).toFixed(1)}% 超过 20%——按 §3.1 应跳过锐评直接出报告`);
  }

  const msg = `账本对账: ${completed.length} 条派发记录、${(log ?? []).length} 条裁量记录，${problems} 处不一致`;
  if (problems > 0) fail('G4', msg);
  else pass('G4', msg);
}

// ────────────────────────────────────────────────────────────────────
// 主流程
// ────────────────────────────────────────────────────────────────────
function main() {
  const args = parseArgs(process.argv);
  if (args.help || args.bad || !args.repo || !args.artifacts) {
    if (args.bad) console.error(args.bad);
    console.error(`用法: node verify-artifacts.mjs --repo <被审仓库> --artifacts <产物目录> [--json] [--strict]`);
    process.exit(2);
  }

  const repo = resolve(normalizePath(args.repo));
  const artifactsRoot = resolve(normalizePath(args.artifacts));

  if (!existsSync(repo)) {
    console.error(`被审仓库不存在: ${repo}`);
    process.exit(2);
  }
  if (!existsSync(artifactsRoot)) {
    console.error(`产物目录不存在: ${artifactsRoot}`);
    process.exit(2);
  }

  // 收集所有产物 md 里的信封
  const envelopes = [];
  const salvaged = [];
  const scanned = [];
  const walk = (dir, depth = 0) => {
    if (depth > 3) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith('.md')) {
        const text = readFileSync(p, 'utf8');
        const rel = relative(artifactsRoot, p);
        const blocks = extractJsonBlocks(text);
        let found = 0;
        for (const b of blocks) {
          if (b.error) {
            fail('G6', `产物 JSON 块解析失败: ${rel}:${b.line}`, { error: b.error });
            continue;
          }
          const before = envelopes.length;
          collectEnvelopes(b.value, envelopes);
          found += envelopes.length - before;
        }

        // 没有任何信封 → 是否降级抽取？
        //
        // 2026-11-09 变更：**默认关闭**，需显式 --legacy-salvage 才启用。
        //
        // 理由（对比 dsh-superagent 后确定）：
        //   它的 `z.object().strict()` 让字段缺失变成调用失败——**事前不可能发生**。
        //   我们的 salvageFromMarkdown 是**事后猜**，73 行代码补偿格式失控。
        //   根因已于 2026-11-09 修复（契约 §0 + 7 个 wrapper 都要求 JSON 信封），
        //   实测新产物 0 次触发 salvage，旧产物 3 次。
        //
        //   所以 salvage 现在是**纯历史包袱**。保留它会给「不写 JSON」留后路，
        //   而这条后路正是 100% 不合规一直没被发现的原因。
        if (found === 0) {
          // 2026-11-09：交付物（final-report / ledger）是给人读的 Markdown，
          // 不要求 JSON 信封。只有「波次产物」才必须带信封。
          //
          // 2026-11-14 修（批判 agent 实测）：这个豁免是**按文件名**判的，
          // 实测把一份产物改名成 `xxx-final-report.md` 就能豁免 G7（exit 1 → 0），
          // 内容一字未改。也就是说「有没有写 JSON 信封」这件事，
          // 可以由产物文件名决定，而不是由内容决定。
          //
          // 收紧：除了文件名，还要求它**真的像交付物**——出现在
          // 「final-report / ledger」这种命名规范里，且不包含波次产物特有的
          // 机器字段（slice_id / findings / leads）。两者都满足才豁免。
          const isDeliverableName = /-(final-report|ledger)\.md$/.test(rel);
          // 机器字段的检测要同时覆盖 JSON 形态（"slice_id":）和散文形态（slice_id: / `slice_id`）。
          // 第一版只写了 JSON 形态，于是「正文里写着 slice_id: "S1"」这种漏掉了。
          const looksLikeDeliverable = !/(["`']?slice_id["`']?\s*:)/.test(text)
            && !/(["`']?lead_count["`']?\s*:)/.test(text)
            && !/(["`']?findings["`']?\s*:\s*\[)/.test(text);
          const isDeliverable = isDeliverableName && looksLikeDeliverable;

          if (isDeliverableName && !looksLikeDeliverable) {
            warn('G7', `${rel} 的文件名像交付物，但内容里有波次产物的机器字段`
              + '（slice_id / lead_count / findings）——不能靠改名豁免信封要求', {});
          }
          if (isDeliverable) {
            // 交付物不检查 JSON 信封，只跳过
          } else if (args.legacySalvage) {
            const s = salvageFromMarkdown(text);
            if (s && s.leads.length > 0) {
              warn('G7', `[legacy] 从 Markdown 降级抽取 ${s.leads.length} 条线索: ${rel}`, {
                slice_id: s.slice_id ?? '(未识别)',
                注意: '这是历史兼容路径，新产物应当直接写 JSON 信封',
              });
              for (const l of s.leads) salvaged.push(l);
            }
          } else {
            // 默认：把「没写 JSON」当作明确的问题报出来，而不是悄悄猜
            fail('G7', `产物没有 JSON 信封: ${rel}`, {
              修法: '按 output-contract.md §0，产物末尾必须有完整 JSON 信封',
              检查: `node tools/check-payload.mjs "${rel}"`,
            });
          }
        }

        scanned.push({ file: rel, blocks: blocks.length, salvaged: found === 0 });
      }
    }
  };
  walk(artifactsRoot);

  // 跑各项检查
  const loaded = loadState(artifactsRoot);
  checkGate0(repo, envelopes, salvaged);
  checkFilesRead(repo, envelopes, loaded.state);
  checkArtifactPaths(repo, artifactsRoot, envelopes);
  checkLineCounts(repo, envelopes);
  checkSelfConsistency(envelopes);
  // 2026-11-14 补（批判 agent 实测）：
  // 空产物目录此前得到 `0 FAIL / 0 WARN / 0 PASS / 6 SKIP` → exit 0。
  // **一条产物都没扫到，却报「通过」。**
  // 这是「全 SKIP 即绿」——所有检查都被跳过，于是没有任何检查失败。
  //
  // 判据：一份产物都没读到，不是「通过」，是「什么也没验证」。
  // 例外：Markdown 降级抽取（salvage）能提出线索时，确实验证了东西，不算空跑。
  if (envelopes.length === 0 && salvaged.length === 0) {
    fail('G0', `产物目录里一份可用产物都没有（扫描 ${scanned.length} 个文件，0 个 JSON 信封，0 条降级线索）。`
      + '**这不等于通过——它意味着什么都没验证**。先确认 --artifacts 指向的目录对不对', {});
  }

  checkLedger(repo, artifactsRoot);

  // 2026-11-14：超过 8MB 的文件被 readLines 跳过了，必须让「未验证」可见。
  // 否则「文件太大」会静默变成「无法验证但算通过」。
  if (oversized.length > 0) {
    const names = oversized.slice(0, 3).map((o) => `${o.path}（${(o.size / 1048576).toFixed(1)}MB）`);
    warn('G0', `${oversized.length} 个文件超过 8MB 未做门 0 校验：${names.join('、')}`
      + `${oversized.length > 3 ? ' …' : ''}——**这些文件里的 quote 一条都没被验证过**`, {});
  }

  // 输出
  const counts = findings.reduce((a, f) => { a[f.level] = (a[f.level] ?? 0) + 1; return a; }, {});

  if (args.json) {
    console.log(JSON.stringify({
      repo, artifacts: artifactsRoot,
      scanned, envelope_count: envelopes.length,
      counts, findings,
    }, null, 2));
  } else {
    console.log(`\n审计产物机械校验`);
    console.log(`  被审仓库: ${repo}`);
    console.log(`  产物目录: ${artifactsRoot}`);
    console.log(`  扫描产物: ${scanned.length} 个文件，解析出 ${envelopes.length} 个信封\n`);

    const order = { FAIL: 0, WARN: 1, PASS: 2, SKIP: 3 };
    const sorted = [...findings].sort((a, b) => order[a.level] - order[b.level]);
    for (const f of sorted) {
      const tag = { FAIL: '✗ FAIL', WARN: '! WARN', PASS: '✓ PASS', SKIP: '- SKIP' }[f.level];
      console.log(`${tag}  [${f.check}] ${f.message}`);
      if (f.detail) {
        for (const [k, v] of Object.entries(f.detail)) {
          if (v !== null && v !== undefined) console.log(`         ${k}: ${v}`);
        }
      }
    }

    console.log(`\n合计: ${counts.FAIL ?? 0} FAIL / ${counts.WARN ?? 0} WARN / ${counts.PASS ?? 0} PASS / ${counts.SKIP ?? 0} SKIP`);
    console.log(`\n注意：本脚本只验证「能否机械验证」的部分。`);
    console.log(`证据是否支持主张、严重性是否合理、可达性判断对不对——这些必须由 LLM 判断，脚本不碰。\n`);
  }

  if ((counts.FAIL ?? 0) > 0) process.exit(1);
  if (args.strict && (counts.WARN ?? 0) > 0) process.exit(3);
  process.exit(0);
}

main();
