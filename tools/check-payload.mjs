#!/usr/bin/env node
/**
 * check-payload.mjs — 子 Agent 返回的**准入检查**（事前门，不是事后补救）
 *
 * 设计依据（2026-11-09 对比 dsh-superagent 后确定）：
 *
 *   参考项目用 `z.object().strict().refine()` 让「accept 必须有 worktree_name」
 *   变成一个**工具调用失败**——错误在产生的那一刻就被挡住。
 *
 *   而我们的 verify-artifacts.mjs 里有一半代码在做 salvageFromMarkdown，
 *   补偿「输出不是结构化产生的」。**这是事后补救。**
 *
 *   实测代价：15 个真实产物，**0 个含 JSON 信封**（100% 需要 salvage）。
 *   根因不是子 Agent 不听话，是 `output-contract.md` 要求 JSON 信封，
 *   而各模板只在示例里出现过一次，**没有一句「必须写」**。
 *
 * 所以这个脚本做两件事：
 *   1. 给主 Agent 一个**派发前的检查器**：收到返回先跑它，不合规就当场判违规
 *   2. 输出**可直接粘回给子 Agent 的错误信息**，说明缺什么
 *
 * 用法：node check-payload.mjs <产物文件> [--role sweep|audit|...] [--json]
 * 退出码：0 合规 / 1 不合规 / 2 用法错误
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, isAbsolute, join } from 'node:path';

const args = process.argv.slice(2);
const jsonOut = args.includes('--json');
const roleIdx = args.indexOf('--role');
const expectRole = roleIdx >= 0 ? args[roleIdx + 1] : null;

// 2026-11-15（R11）：证据存在性检查需要知道「相对路径相对于谁」。
// 背景（R7 实测的「洞 4」）：red_log_path / test_path 此前只做正则形状校验
// （`(^|\/)target\/`），从不 existsSync。于是「路径写成 target/ 之外、
// 但这个文件从来没生成过」可以通过——而「路径不指向 target/」只证明证据不会
// 被构建清理，不证明证据曾经存在过。同形事故：验收引用的三个红测日志全被
// mvn clean 删掉，验收记录却写「证据存在且内容可信」。
const repoIdx = args.indexOf('--repo');
const artifactDirIdx = args.indexOf('--artifact-dir');
for (const [flag, idx] of [['--repo', repoIdx], ['--artifact-dir', artifactDirIdx]]) {
  if (idx >= 0) {
    const v = args[idx + 1];
    // 显式给了 flag 却没给值，不能静默忽略——那会让调用方以为检查生效了
    if (v === undefined || v.startsWith('--')) {
      console.error(`${flag} 需要一个目录参数`);
      process.exit(2);
    }
  }
}
const repoDir = repoIdx >= 0 ? resolve(args[repoIdx + 1]) : null;
const artifactDir = artifactDirIdx >= 0 ? resolve(args[artifactDirIdx + 1]) : null;

// 选项的「值」不是产物文件。此前只排除 --role 的值，新增两个带值选项后
// 必须一起排除，否则 `--repo /path` 里的 /path 会被当成产物路径。
// 注意用**原始 argv 字符串**比较：repoDir 已被 resolve 成绝对路径，与 argv 不同形。
const OPTION_VALUES = new Set([expectRole, repoIdx >= 0 ? args[repoIdx + 1] : null,
  artifactDirIdx >= 0 ? args[artifactDirIdx + 1] : null]
  .filter((v) => typeof v === 'string' && v !== ''));
const file = args.find((a) => !a.startsWith('--') && !OPTION_VALUES.has(a));

if (!file) {
  console.error('用法: node check-payload.mjs <产物文件> [--role sweep|audit|recon|critique|fix|verify]'
    + ' [--repo <被审仓库根>] [--artifact-dir <产物所在目录>] [--json]');
  process.exit(2);
}
if (!existsSync(file)) {
  console.error(`文件不存在: ${file}`);
  process.exit(2);
}

const text = readFileSync(file, 'utf8');
const errors = [];
const warnings = [];

// 2026-11-14 补（批判 agent 实测）：
// 各处的 `length < N` 用的是 JS 的 `.length`，即 **UTF-16 code unit 计数**。
// 于是中文（1 字符）和零宽字符（1 字符、0 视觉宽度）都能「凑够长度」：
//   `​`.repeat(81) → length 81，实际视觉内容为空
//   「待填」→ length 2，但信息量等于没写
// 判据：先剥掉零宽字符与空白，再数**非空白字符**；并对纯占位词单独判死。
const ZERO_WIDTH = /[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/g;
function substanceLength(s) {
  return String(s ?? '').replace(ZERO_WIDTH, '').replace(/\s/g, '').length;
}
// 公认的「没写」词。命中即视为空内容，不管多长。
const PLACEHOLDER_WORDS = /^(待填|待补|待定|待确认|待补充|TODO|TBD|FIXME|N\/?A|无|略|同上|见上|见上文|参见上文|详见|xxx+|\.{3,}|…+)$/i;
function isVacuous(s) {
  const t = String(s ?? '').replace(ZERO_WIDTH, '').trim();
  if (t === '') return true;
  return PLACEHOLDER_WORDS.test(t.replace(/[\s。，,.;；:：!！?？]/g, ''));
}

// ────────────────────────────────────────────────────────────────────
// 0 · disposition 契约的公共部分（2026-11-15 新增）
// ────────────────────────────────────────────────────────────────────
// 背景（有实测证据）：fix 角色此前的全部契约只有 `files_touched`。
// 框架要求「每条 finding 必须被锐评攻击一次」（critique 的
// `verdict_missing_for_target`），但**不要求每条 finding 被修复或明确暂缓一次**。
// 实测后果：38 条发现只修了 6 条，31 条从未进入任何任务书，没有任何工具报错。
// 另一例：一条 finding 含 3 个子主张，任务书只覆盖 1 个，另外 2 个静默消失
// （其中 1 个后来靠巧合才被捞回来）。
//
// 所以 fix 的产物必须对每条发现表态，四个值构成闭集。缺省即违规——
// 「省略最省事」正是静默蒸发的机制。
const DISPOSITIONS = ['FIXED', 'WONT_FIX', 'DEFERRED', 'NEW_FINDING'];

// 红测日志路径不得落在构建产物目录里。
// 2026-11-15 真实教训：诊断用的红测日志放在 `target/` 下，被 `mvn clean`
// 整个删掉，验收时就再也无法复核「修复前确实是红的」。
// 证据一旦可被构建清理，等于没有证据。
const RED_LOG_IN_TARGET = /(^|\/)target\//i;

// ────────────────────────────────────────────────────────────────────
// 0.1 · 证据存在性（2026-11-15 R11 新增，修 R7 报告的「洞 4」）
// ────────────────────────────────────────────────────────────────────
// 洞 4 的实测形态（R7《FIX-R7-report.md》§4）：
//   red_log 指向不存在的文件（target/ 外）  -> exit 0 | rules []
//   test_path 指向不存在的文件              -> exit 0 | rules []
//   red_log_path 写成 red.log（无目录）     -> exit 0 | rules []
//
// 即上面的 RED_LOG_IN_TARGET 只校验**路径形状**。形状对了，只证明
// 「证据不会被构建清理」；它无法证明「这个文件曾经存在过」。
// 而同形事故真实发生过：某次验收引用的三个「修复前是红的」日志全被
// `mvn clean` 删掉，验收记录却写着「证据存在且内容可信」。
//
// 所以对 FIXED 的产物要再问一次：这些路径现在能打开吗？
//
// 降级纪律（关键）：产物里的路径可能是相对路径，解析需要外部根。
// 若调用方既没给 --repo 也没给 --artifact-dir，就无法判定——此时
// **降级为 WARN**，绝不 FAIL。理由与 R8 的 unsupported_harness、
// R10 的 --artifacts-dir 缺失一致：不能因为一个「需要外部信息」的参数
// 没传就把整条流程卡死（否则所有既有调用方一夜之间全红）。

// 可用作「相对路径解析根」的目录。顺序契约：artifact-dir → repo → cwd。
const EVIDENCE_ROOTS = [];
for (const [label, dir] of [['--artifact-dir', artifactDir], ['--repo', repoDir]]) {
  if (!dir) continue;
  if (!existsSync(dir)) {
    warnings.push({
      field: label, rule: 'evidence_root_not_found',
      msg: `${label} 指向的目录不存在: ${dir}。该根不可用于解析证据路径，已忽略`,
    });
    continue;
  }
  EVIDENCE_ROOTS.push({ label, dir });
}

// 解析顺序：先按 --artifact-dir 拼，再按 --repo 拼，再按 cwd 拼；任一存在即通过。
// 绝对路径不依赖任何根，直接判。
function locateEvidence(rawPath) {
  if (isAbsolute(rawPath)) {
    return { decided: true, found: existsSync(rawPath), tried: [rawPath] };
  }
  if (EVIDENCE_ROOTS.length === 0) {
    // 没有根 → 只还能试 cwd。命中即通过；未命中则**无法判定**（降级 WARN）。
    // 不直接判 FAIL：调用方没给根，测不到不等于不存在。
    const cwdPath = join(process.cwd(), rawPath);
    if (existsSync(cwdPath)) return { decided: true, found: true, tried: [cwdPath], hit: cwdPath };
    return { decided: false, found: false, tried: [cwdPath] };
  }
  const tried = [...new Set([
    ...EVIDENCE_ROOTS.map((r) => join(r.dir, rawPath)),
    join(process.cwd(), rawPath),
  ])];
  const hit = tried.find((p) => existsSync(p));
  return { decided: true, found: !!hit, tried, hit };
}

// wave4-fix.md:169 的契约允许「test_path 如果不存在，写明『需新建』」，
// 所以占位值不能被当成一个「不存在的路径」判死。
const TEST_PATH_PLACEHOLDER = /^(需新建|待创建|待新建|需创建|新建|TODO|TBD|N\/?A|无)$/i;
const isPlaceholderPath = (s) => {
  const t = String(s ?? '').replace(ZERO_WIDTH, '').trim()
    .replace(/[\s。，,.;；:：!！?？()[\]（）]/g, '');
  if (t === '') return false;
  // 精确占位词，或「需新建」「TODO:<说明>」这类以占位词开头并带补充说明的写法
  return TEST_PATH_PLACEHOLDER.test(t)
    || /^(需新建|待创建|待新建|需创建|TODO|TBD).{2,}$/i.test(t);
};

const TRIED_MSG = (tried) => tried.length > 0
  ? `试过：${tried.map((t) => `\`${t}\``).join(' / ')}`
  : '未提供任何可解析的根';

// 2026-11-16（R18）：files_touched 的存在性。
//
// 背景（R17《FIX-R17-report.md》§4.3 自证）：
//   [valid] src/main/java/com/hilltopvillage/mechanics/NodeListener.java → EXIT=0
//   [fake]  src/main/java/com/hilltopvillage/NOT_EXIST.java               → EXIT=0
// 假路径没有被拦。原因是 `grep -c files_touched tools/check-payload.mjs` = 2：
// 一处是注释，一处是 ROLE_REQUIRED.fix 的键名列表。后者只保证
// 「payload.files_touched 这个键存在」——不检查值、不检查数组元素、
// 不检查 path 是否存在。规则名存在、字段名存在，判据不存在。
//
// 而 files_touched 是「这个实例改了哪些文件」的**唯一凭证**。凭证指向一个
// 不存在的文件，说明那个改动要么没发生、要么被回滚了、要么写错了。
// 2026-11-15 那次实验里，修复后的源码曾经完全不在框架仓库内，
// 而没有任何工具发现这件事——这正是本条要堵的形态。
//
// 只对 disposition=FIXED 生效：WONT_FIX 不改文件、DEFERRED 本轮没改，
// 要求它们列出改动文件是错的。空数组对 FIXED 是自相矛盾（说改了却一个没改），
// 所以单独一条规则，别混进「路径不存在」里。
//
// 解析根与降级纪律完全复用 §0.1 的 locateEvidence：任一存在即通过；
// 没有可解析的根时降级为 evidence_existence_unchecked 的 WARN，不 FAIL。
const ANGLE_PLACEHOLDER = /[<>]/;

// 多发现形态下 payload.dispositions[] 里每条都可能带同一批不可判定路径，
// 降级警告按「路径集合」去重，避免同一句提示刷 N 遍。
const UNDECIDED_WARNED = new Set();

function validateDispositionEntry(entry, prefix) {
  const out = [];
  const d = entry?.disposition;

  if (d === undefined || d === null || d === '') {
    out.push({
      field: `${prefix}.disposition`, rule: 'missing_disposition',
      msg: `缺少 disposition。fix 产物必须对每条发现表态：${DISPOSITIONS.join(' | ')}。`
        + '不表态 = 这条发现静默蒸发——实测 38 条发现里 31 条从未进入任何任务书，而没有任何工具报错',
    });
    return out;
  }
  if (!DISPOSITIONS.includes(d)) {
    out.push({
      field: `${prefix}.disposition`, rule: 'invalid_disposition',
      msg: `disposition 只能取 ${DISPOSITIONS.join(' | ')}，实际是 ${JSON.stringify(d)}。`
        + '枚举不闭合时「暂缓 / 不修 / 新发现」三者无法区分，下游统计会失真',
    });
    return out;
  }

  // 只要给了红测日志路径就检查，不论 disposition 是哪个值——
  // 一条放在 target/ 下的日志在任何档位下都不是可复核的证据。
  const rlp = entry?.red_log_path;
  if (typeof rlp === 'string' && rlp.trim() !== '') {
    const normalized = rlp.replace(/\\/g, '/');
    if (RED_LOG_IN_TARGET.test(normalized)) {
      out.push({
        field: `${prefix}.red_log_path`, rule: 'red_log_in_target',
        msg: `red_log_path 指向构建产物目录（${rlp}），会被构建清理（如 mvn clean / gradle clean / rm -rf target）删掉，`
          + '验收时无法复核「修复前是红的」。2026-11-15 真实教训：红测日志就放在 target/ 下，被整个删光，'
          + '导致本次修复的证据不可复核。请写到 target/ 之外（例如 experiments/<round>/red-<finding>.log）',
      });
    }
  }

  if (d === 'FIXED') {
    const tp = entry?.test_path;
    if (typeof tp !== 'string' || tp.trim() === '') {
      out.push({
        field: `${prefix}.test_path`, rule: 'fixed_without_test',
        msg: 'disposition=FIXED 时必须给出 test_path——「改了代码」不等于「修好了」，'
          + '没有测试就没有可复核的判据',
      });
    }
    if (typeof rlp !== 'string' || rlp.trim() === '') {
      out.push({
        field: `${prefix}.red_log_path`, rule: 'fixed_without_red_log',
        msg: 'disposition=FIXED 时必须给出 red_log_path（修复前测试为红的日志）。'
          + '没有红测日志，无法区分「修复生效」和「测试本来就是绿的」',
      });
    }

    // ── 证据存在性（R11 新增，见文件顶部 §0.1）──
    // 规则 3：裸文件名 → WARN，不 FAIL。
    // 理由：裸文件名无法判断落在哪个目录，容易和 cwd 混淆；但有些环境里
    // 「产物和日志并排」是正常做法，升级为 FAIL 会误杀。
    if (typeof rlp === 'string' && rlp.trim() !== '' && !/[\\/]/.test(rlp.trim())) {
      warnings.push({
        field: `${prefix}.red_log_path`, rule: 'red_log_no_directory',
        msg: `red_log_path 是裸文件名（${rlp}），不含任何路径分隔符——无法判断它落在哪个目录，`
          + '容易和「当前工作目录」混淆。建议写成相对产物或仓库根的路径'
          + '（例如 experiments/<round>/red-<finding>.log）',
      });
    }

    const undecided = [];

    // 规则 1：red_log_path 解析后不存在 → FAIL
    if (typeof rlp === 'string' && rlp.trim() !== '') {
      const p = rlp.trim();
      const loc = locateEvidence(p);
      if (!loc.decided) {
        undecided.push({ field: `${prefix}.red_log_path`, path: p, rule: 'red_log_not_found' });
      } else if (!loc.found) {
        out.push({
          field: `${prefix}.red_log_path`, rule: 'red_log_not_found',
          msg: `red_log_path 指向的文件不存在（${TRIED_MSG(loc.tried)}）。`
            + '路径形状对了不代表文件存在过——2026-11-15 那次验收引用的三个红测日志就是这样：'
            + '路径都合法，但已经被构建清理掉了，验收却写着『证据存在且内容可信』。',
        });
      }
    }

    // 规则 2：test_path 解析后不存在 → FAIL；占位值（需新建 / 待创建 / TODO）跳过并 WARN
    if (typeof tp === 'string' && tp.trim() !== '') {
      const p = tp.trim();
      if (isPlaceholderPath(p)) {
        // wave4-fix.md:169 的契约允许「如果不存在，写明『需新建』」——
        // 这是合法写法，但必须让主 Agent 看见「这条测试现在还不存在」。
        warnings.push({
          field: `${prefix}.test_path`, rule: 'test_path_placeholder',
          msg: `test_path 是占位值（${p}）：按 wave4-fix.md 契约允许，本次跳过存在性检查。`
            + '**但意味着这条修复的测试当时并不存在**——验收波必须确认它后来真的被建出来了',
        });
      } else {
        const loc = locateEvidence(p);
        if (!loc.decided) {
          undecided.push({ field: `${prefix}.test_path`, path: p, rule: 'test_path_not_found' });
        } else if (!loc.found) {
          out.push({
            field: `${prefix}.test_path`, rule: 'test_path_not_found',
            msg: `test_path 指向的文件不存在（${TRIED_MSG(loc.tried)}）。`
              + 'FIXED 声称「有证明修复前是红的测试」，但测试文件本身找不到——'
              + '「声称有测试」和「测试真的存在」是两件事',
          });
        }
      }
    }

    // ── files_touched 的存在性（R18 新增，见文件顶部 §0.1a）──
    // 只对 FIXED 生效：WONT_FIX 不改文件、DEFERRED 本轮没改，
    // 要求它们列出改动文件是错的（case 136/137/138 是这三条防误伤的护栏）。
    const ft = entry?.files_touched;
    if (ft !== undefined && ft !== null && !Array.isArray(ft)) {
      // 非数组会**整段跳过**下面所有检查——正是「换个类型就能绕开规则」。
      // 本仓库已经出过同一类缺陷（artifact_path 非字符串躲过存在性检查）。
      out.push({
        field: `${prefix}.files_touched`, rule: 'files_touched_wrong_shape',
        msg: `files_touched 必须是数组 [{\`path\`, \`change_summary\`}]，实际是 `
          + `${Array.isArray(ft) ? 'array' : typeof ft}：${JSON.stringify(ft).slice(0, 60)}。`
          + '非数组会让「路径是否存在」这一整项检查静默跳过',
      });
    } else if (Array.isArray(ft)) {
      if (ft.length === 0) {
        out.push({
          field: `${prefix}.files_touched`, rule: 'files_touched_empty',
          msg: 'disposition=FIXED 但 files_touched 是空数组。'
            + '「代码已改」和「一个文件都没改」不可能同时成立——'
            + 'wave4-fix.md 的契约要求修复必须列出改动文件，空数组是把这句话取消掉的最省力写法',
        });
      } else {
        const missing = [];
        ft.forEach((item, i) => {
          const raw = item?.path;
          if (typeof raw !== 'string' || raw.trim() === '') {
            // 省略 path 不能等于通过：没有路径的 files_touched 条目无法被任何东西复核。
            out.push({
              field: `${prefix}.files_touched[${i}].path`, rule: 'files_touched_path_missing',
              msg: `files_touched[${i}] 没有可用的 path（实际 ${JSON.stringify(item?.path)}）。`
                + '**省略不能等于通过**——没有路径的条目无法与文件系统对账，'
                + '它只是把「我改了」写成一句无法复核的话',
            });
            return;
          }
          const p = raw.trim();
          if (ANGLE_PLACEHOLDER.test(p)) {
            // 与 artifact_path 的 artifact_outdir_placeholder 同一处理：
            // <OUTDIR> 是运行时才知道的目录，静态校验不可能验证它——
            // 不能判死，但必须让主 Agent 在接收时核对。
            warnings.push({
              field: `${prefix}.files_touched[${i}].path`, rule: 'files_touched_path_placeholder',
              msg: `files_touched[${i}].path 含占位符（${p}）：静态校验无法展开它，本次跳过存在性检查。`
                + '**主 Agent 在接收时必须核对展开后的真实文件是否存在**',
            });
            return;
          }
          const loc = locateEvidence(p);
          if (!loc.decided) {
            // 没有可解析的根 → 不可判定，走 §0.1 的降级纪律（WARN，不 FAIL）。
            undecided.push({
              field: `${prefix}.files_touched[${i}].path`,
              path: p, rule: 'files_touched_not_found',
            });
          } else if (!loc.found) {
            missing.push({ i, p, tried: loc.tried });
          }
        });

        if (missing.length > 0) {
          // 一条聚合消息，一条 FAIL：N 个假路径是同一个事实（凭证是假的），
          // 拆成 N 条只会把这一条规则淹没在噪音里。field 指第一个缺失项，
          // 消息里逐条点名，读的人仍然知道去改哪一行。
          out.push({
            field: `${prefix}.files_touched[${missing[0].i}].path`,
            rule: 'files_touched_not_found',
            msg: `files_touched 里有 ${missing.length} 个路径指向不存在的文件：`
              + missing.map((m) => `files_touched[${m.i}] \`${m.p}\`（${TRIED_MSG(m.tried)}）`).join('；')
              + '。`files_touched` 是「这个实例改了哪些文件」的唯一凭证——路径不存在意味着'
              + '那个改动要么没发生，要么被回滚了，要么写错了。2026-11-15 那次实验里，'
              + '修复后的源码曾经完全不在框架仓库内，而**没有任何工具发现这件事**。',
          });
        }
      }
    }

    // 降级纪律：没有可解析的根时，物理解析不可能，只能 WARN 不能 FAIL。
    // 若这些路径是绝对路径，locateEvidence 已能判定，不会走到这里。
    if (undecided.length > 0) {
      const key = JSON.stringify(undecided.map((u) => u.path).sort());
      if (!UNDECIDED_WARNED.has(key)) {
        UNDECIDED_WARNED.add(key);
        warnings.push({
          field: undecided.map((u) => u.field).join(', '),
          rule: 'evidence_existence_unchecked',
          msg: '未提供 --repo/--artifact-dir，无法校验证据是否存在：'
            + undecided.map((u) => `${u.field}（${u.path}）`).join(' / ')
            + '。路径形状检查仍然生效，但**「文件是否真的存在过」这一项本轮没有验证**——'
            + '请主 Agent 在接收时带 --repo <被审仓库根> 或 --artifact-dir <产物目录> 重跑一次',
        });
      }
    }
  }

  // 契约 §2.4 把 disposition_reason 列为 WONT_FIX / DEFERRED 的条件必填（≥20 字）。
  // 两个分支分开报规则名，好让「不修」与「暂缓」两种缺理由在统计上可区分。
  const reason = String(entry?.disposition_reason ?? '');
  const reasonTooThin = substanceLength(reason) < 20 || isVacuous(reason);
  const reasonDetail = `（去空白与零宽字符后 ${substanceLength(reason)} 字，要求 ≥20 字`
    + `${isVacuous(reason) ? '，或命中占位词' : ''}）`;

  if (d === 'WONT_FIX' && reasonTooThin) {
    out.push({
      field: `${prefix}.disposition_reason`, rule: 'wont_fix_without_reason',
      msg: `disposition=WONT_FIX 但 disposition_reason 没有实质内容${reasonDetail}。`
        + '「不修」是一个需要论证的判断，不是省略号——否则它只是把静默蒸发换了个名字',
    });
  }

  if (d === 'DEFERRED') {
    if (reasonTooThin) {
      out.push({
        field: `${prefix}.disposition_reason`, rule: 'deferred_without_reason',
        msg: `disposition=DEFERRED 但 disposition_reason 没有实质内容${reasonDetail}。`
          + '「本轮不修」必须说明为什么不能在本轮修，否则与「忘了」无法区分',
      });
    }
    const nr = entry?.next_round;
    if (typeof nr !== 'string' || nr.trim() === '' || isVacuous(nr)) {
      out.push({
        field: `${prefix}.next_round`, rule: 'deferred_without_trigger',
        msg: 'disposition=DEFERRED 时必须给出 next_round（什么条件满足时重新处置）。'
          + '没有触发条件的「暂缓」等于永久丢弃——它永远不会被任何后续波次重新捡起',
      });
    }
  }

  // NEW_FINDING 只要求显式标记（disposition 本身即是标记），
  // 但建议给 disposition_reason 说明「新发现在哪里、为什么不在原清单里」。
  return out;
}

// ────────────────────────────────────────────────────────────────────
// 1 · 必须有一个可解析的 JSON 信封
// ────────────────────────────────────────────────────────────────────
const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)];
if (blocks.length === 0) {
  errors.push({
    field: '(root)',
    rule: 'no_json_envelope',
    msg: '产物里没有 ```json 代码块。契约要求返回必须包在 JSON 信封里。',
    fix: '在产物文件末尾追加一个 ```json 块，内容见 components/output-contract.md §1',
  });
} else if (blocks.length > 1) {
  warnings.push({
    field: '(root)',
    rule: 'multiple_json_blocks',
    msg: `发现 ${blocks.length} 个 json 块，会取最后一个是信封的那个`,
  });
}

// ── 取哪个 json 块当信封 ──
// 2026-11-14 修：此前固定取 blocks[0]，而契约 §1 和全部 wrapper 都写的是
// 「你产物的**最后**一个代码块必须是完整 JSON 信封」，且 wrapper §4 明确
// 鼓励「正文随便写（分析、证据、表格）」。
// 于是 agent 越认真写正文（正文里带示例 json），越会被判违规：
// 实测一份产物末尾有完全正确的信封，只因正文有两个示例块，被判 7 项违规、
// `role: undefined`。**认真写反而失败**，这是最坏的一类缺陷。
//
// 现在的做法：从后往前找第一个「看起来是信封」的块（含 schema_version 或 role）；
// 都不像信封时退回最后一个可解析的块。
const looksLikeEnvelope = (s) => /"schema_version"\s*:/.test(s) || /"role"\s*:/.test(s);
let envelopeBlockIdx = -1;
for (let i = blocks.length - 1; i >= 0; i--) {
  if (looksLikeEnvelope(blocks[i][1])) { envelopeBlockIdx = i; break; }
}
if (envelopeBlockIdx < 0 && blocks.length > 0) envelopeBlockIdx = blocks.length - 1;

let envelope = null;
if (blocks.length > 0) {
  // 2026-11-14 修：尾随逗号的「容错」正则不尊重字符串边界，会**静默改写 quote 的内容**。
  // 实测：源码里引用 `if (a) { return {x,}; }`，正则把 `,}` 改成 `}`，
  // 解析出来的 quote 变成 `if (a) { return {x}; }`——而 quote 正是门 0 要求
  // 「逐字来自本回合读到的原文」的那一项。改写了却没任何警告。
  //
  // 正确做法：先按原样解析。原样能解析就**绝不改写**（绝大多数产物都是合法 JSON）。
  // 只有原样解析失败时才启用容错，且容错生效必须留下 WARN——
  // 因为一旦容错改动了内容，这份产物就不能再声称「quote 逐字」。
  const raw = blocks[envelopeBlockIdx][1]
    .split('\n').filter((ln) => !/^\s*\/\//.test(ln)).join('\n');

  let parseErr = null;
  try {
    envelope = JSON.parse(raw);
  } catch (e) {
    parseErr = e;
    const tolerant = raw.replace(/,(\s*[}\]])/g, '$1');
    if (tolerant !== raw) {
      try {
        envelope = JSON.parse(tolerant);
        warnings.push({
          field: '(root)', rule: 'json_trailing_comma_fixed',
          msg: '原样 JSON 无法解析，已自动修复尾随逗号后通过。'
            + '**但该修复会改动字符串内的内容**（例如 quote 里的 `,}` 变成 `}`），'
            + '因此本产物的 quote 不能视为「逐字原文」——请让 agent 输出合法 JSON',
        });
      } catch {
        envelope = null;
      }
    }
  }

  if (envelope === null) {
    errors.push({
      field: '(root)',
      rule: 'json_parse_failed',
      msg: `JSON 解析失败: ${parseErr?.message ?? '未知'}（取的是第 ${envelopeBlockIdx + 1}/${blocks.length} 个 json 块）`,
      fix: '检查是否有多余逗号、单引号、未转义的引号',
    });
  }
}

// ────────────────────────────────────────────────────────────────────
// 2 · 顶层信封字段（缺一即违规）
// ────────────────────────────────────────────────────────────────────
const REQUIRED_TOP = ['schema_version', 'agent_id', 'role', 'status', 'contract_valid', 'payload'];

// 2026-11-14 修（批判 agent 实测）：
// 信封能被解析成**假值**（false / 0 / ""）时，`if (envelope)` 整段跳过，
// 于是打印「✅ 契约合规」exit 0。实测 4 种通过：
//   false / 0 / "" / payload=null
// 一个不是对象、或必填字段值为 null 的「信封」，在语义上等于没有信封。
if (envelope !== null && (typeof envelope !== 'object' || Array.isArray(envelope))) {
  errors.push({
    field: '(root)', rule: 'envelope_not_object',
    msg: `信封必须是 JSON 对象，实际是 ${Array.isArray(envelope) ? 'array' : typeof envelope}: `
      + `${JSON.stringify(envelope)}。非对象信封会跳过全部字段校验`,
  });
}

if (envelope && typeof envelope === 'object' && !Array.isArray(envelope)) {
  for (const k of REQUIRED_TOP) {
    if (!(k in envelope)) {
      errors.push({ field: k, rule: 'missing_top_field', msg: `顶层缺字段: ${k}` });
    } else if (envelope[k] === null || envelope[k] === undefined) {
      // 2026-11-14 修：只查 key 存不存在，不查值。实测六个必填字段全写 null → exit 0。
      // 「字段在但值是 null」和「字段缺失」对下游是同一件事：拿不到可用的值。
      // 例外：artifact_path 与 error 允许 null（失败时没有产物），但它们不在 REQUIRED_TOP 里。
      errors.push({
        field: k, rule: 'null_top_field',
        msg: `顶层字段 ${k} 的值是 null——「写了 null」和「没写」对下游是同一件事`,
      });
    }
  }

  if (envelope.schema_version && envelope.schema_version !== 'output-contract-v1') {
    errors.push({
      field: 'schema_version',
      rule: 'wrong_schema_version',
      msg: `schema_version 必须精确等于 "output-contract-v1"，实际是 "${envelope.schema_version}"`,
    });
  }
  const VALID_ROLES = ['recon', 'sweep', 'audit', 'critique', 'fix', 'verify', 'planner'];
  if (envelope.role && !VALID_ROLES.includes(envelope.role)) {
    errors.push({
      field: 'role', rule: 'invalid_role',
      msg: `role 必须是 ${VALID_ROLES.join(' / ')} 之一，实际是 "${envelope.role}"`,
    });
  }
  if (expectRole && envelope.role !== expectRole) {
    errors.push({
      field: 'role', rule: 'role_mismatch',
      msg: `期望 role="${expectRole}"，实际 "${envelope.role}"`,
    });
  }
  const VALID_STATUS = ['SUCCESS', 'RETRYABLE_FAILURE', 'CONTRACT_VIOLATION', 'PERMANENT_FAILURE'];
  if (envelope.status && !VALID_STATUS.includes(envelope.status)) {
    errors.push({
      field: 'status', rule: 'invalid_status',
      msg: `status 必须是 ${VALID_STATUS.join(' / ')} 之一，实际是 "${envelope.status}"`,
    });
  }
  // artifact_path 与 status 的联动（output-contract §1）
  if (envelope.status === 'SUCCESS') {
    if (!envelope.artifact_path) {
      errors.push({
        field: 'artifact_path', rule: 'missing_artifact_path',
        msg: 'status=SUCCESS 时 artifact_path 必填',
      });
    } else if (typeof envelope.artifact_path !== 'string') {
      // 2026-11-14 修（红队实测）：存在性检查此前整个包在 `else if (typeof === 'string')` 里，
      // 于是**非字符串值完全跳过检查**。实测：
      //   artifact_path = {"path":"x"} / 12345 / ["x"] / true  → 全部 ✅ 契约合规
      // 而契约 §1 要求 SUCCESS 时 artifact_path 必须是「仓库外绝对路径或 <OUTDIR> 相对路径」，
      // 这四种都不是路径，却因为类型不是 string 而躲过了所有校验。
      // 一个对象类型的 artifact_path 在下游 `existsSync()` 里会静默返回 false，
      // 或者被强制转成 "[object Object]" —— 无论哪种，「产物存在」这条门控都失效了。
      errors.push({
        field: 'artifact_path', rule: 'artifact_path_wrong_type',
        msg: `artifact_path 必须是字符串，实际是 ${Array.isArray(envelope.artifact_path) ? 'array' : typeof envelope.artifact_path}：`
          + `${JSON.stringify(envelope.artifact_path).slice(0, 60)}。`
          + '非字符串会绕过存在性检查，让「格式完美但产物没写出来」通过门控',
      });
    } else if (typeof envelope.artifact_path === 'string') {
      // 2026-11-10 修正：output-contract.md:92 宣称「artifact_path 指向的文件不存在
      // = CONTRACT_VIOLATION，这道校验是机械的」——但此前本工具只检查非空，
      // 从不检查存在性。一个指向 D:/不存在.md 的信封能拿到「✅ 契约合规」。
      //
      // 2026-11-14 修：契约 §1 明确允许两种写法——
      //   「仓库外绝对路径 **或** `<OUTDIR>` 相对路径`」
      // 但本工具此前只实现了第一种，于是用 `<OUTDIR>` 写的产物一律被拒。
      // 更糟的是我上一轮为了让示例「能过」，把示例的路径改成 `<OUTDIR>` 后用
      // --no-exists 校验——**等于把校验器的不完整实现，用「跳过检查」掩盖过去**。
      // 正确的修法是让校验器实现契约允许的语义：`<OUTDIR>` 是「运行时才知道的
      // 输出目录」，静态校验不可能验证它，因此按约定视为「存在性待运行时确认」，
      // 并给一条 WARN 提醒主 Agent 在接收时核对真实路径。
      const skipExists = args.includes('--no-exists');
      const p = envelope.artifact_path;
      const isOutdirPlaceholder = /^<OUTDIR>[/\\]/.test(p);

      // 2026-11-14 修（批判 agent 实测）：
      // 此前直接 existsSync(p)，而 p 是相对路径时按 **cwd** 解析。
      // 实测同一份 `artifact_path: "real.md"`：
      //   在产物所在目录跑 → exit 0 ✅
      //   在 /tmp 跑        → exit 1 ✗
      // **同一份产物两种结论**。这让「产物是否存在」取决于你在哪跑，而不是产物本身。
      //
      // 修：相对路径按**产物文件所在目录**解析，与 cwd 无关。
      // 这符合直觉——artifact_path 描述的是「相对于这份产物」的位置。
      const resolvedPath = isAbsolute(p)
        ? p
        : resolve(dirname(file), p);

      if (isOutdirPlaceholder) {
        warnings.push({
          field: 'artifact_path', rule: 'artifact_outdir_placeholder',
          msg: `artifact_path 使用 <OUTDIR> 占位（契约 §1 允许）：${p}。`
            + '静态校验无法验证它——**主 Agent 在接收时必须核对 <OUTDIR> 展开后的真实文件是否存在**',
        });
      } else if (!skipExists && !existsSync(resolvedPath)) {
        errors.push({
          field: 'artifact_path', rule: 'artifact_not_found',
          msg: `artifact_path 指向的文件不存在: ${p}。` +
               `output-contract.md §1 要求 SUCCESS 必须有真实落盘的产物——` +
               `「格式完美但产物没写出来」不构成完成。`
               + '（若这是运行时才知道的输出目录，请按契约写成 `<OUTDIR>/文件名`）',
        });
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// 3 · 按角色的 payload 必填字段
// ────────────────────────────────────────────────────────────────────
const ROLE_REQUIRED = {
  recon: ['slice_count', 'audit_slices', 'entry_points', 'unverified'],
  sweep: ['slice_id', 'reachability', 'files_read', 'leads', 'lead_count'],
  audit: ['findings', 'self_checks'],
  critique: ['critique_role', 'verdicts'],
  fix: ['files_touched'],
  verify: ['finding_id', 'verdict'],
  planner: ['tier', 'score', 'members', 'member_count'],
};

if (envelope && envelope.payload && envelope.role) {
  // 2026-11-14 修：`ROLE_REQUIRED[envelope.role]` 是普通对象直查，role 取
  // "__proto__" / "constructor" / "toString" 等原型链键时会取到**函数**而非
  // undefined，`?? []` 兜不住，`for...of` 直接抛 TypeError: req is not iterable。
  // 结果是把「契约违规」误报成「校验器崩了」，错误信息变成 JS 堆栈。
  // 这正是本项目 GT-015/GT-018 那类缺陷（裸下标查表）在自家工具里的复现。
  const req = Object.prototype.hasOwnProperty.call(ROLE_REQUIRED, envelope.role)
    ? ROLE_REQUIRED[envelope.role]
    : [];
  for (const k of req) {
    if (!(k in envelope.payload)) {
      errors.push({
        field: `payload.${k}`, rule: 'missing_role_field',
        msg: `role="${envelope.role}" 的 payload 缺必填字段: ${k}`,
      });
    }
  }

  // 角色特定的算术自洽
  const p = envelope.payload;
  // 通用枚举校验（2026-11-10 新增）：闭集写错一个词，整个产物就该作废
  const ENUM_CHECKS = [
    { path: 'leads[].confidence',         values: ['HIGH', 'MEDIUM', 'LOW'] },
    { path: 'leads[].suspected_dimension',values: ['logic', 'concurrency', 'security', 'error-handling', 'data-consistency', 'contract'] },
    { path: 'findings[].severity',        values: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', null] },
    { path: 'findings[].dimension',       values: ['logic', 'concurrency', 'security', 'error-handling', 'data-consistency', 'contract'] },
    { path: 'audit_slices[].reachability_hint', values: ['PROD', 'ENTRY', 'TEST_ONLY', 'UNREACHABLE', 'GENERATED', 'MIXED'] },
    // 2026-11-10（蓝队 A2）：sweep 的 payload 顶层 reachability 此前完全没有枚举校验，
    // 实测写 "TOTALLY_IGNORE_ME" 仍判契约合规。这个字段决定要不要花钱深挖。
    { path: 'reachability', values: ['PROD', 'ENTRY', 'TEST_ONLY', 'UNREACHABLE', 'GENERATED'] },
    { path: 'verdicts[].five_step.path_reachable',  values: ['true', 'false', 'untested', true, false] },
    { path: 'verdicts[].five_step.already_handled', values: ['true', 'false', 'untested', true, false] },
    // 2026-11-17：登记到这里，check-enum-consistency.mjs 才会把它的闭集
    // 拿去和契约切片 / 母文件 / 示例做四处比对。不登记 = 这条枚举的漂移永远发现不了。
    { path: 'evidence.mutation_check',     values: ['performed', 'skipped'] },
    { path: 'evidence.mutation_scope',     values: ['implementation_only', 'implementation_and_callsite', null] },
    { path: 'evidence.input_space_basis',  values: ['exhaustive', 'boundary', 'single_sample', 'unknown'] },
  ];
  for (const { path: fp, values } of ENUM_CHECKS) {
    // 顶层字段（如 reachability）：直接校验，不走数组遍历
    if (!fp.includes('[].')) {
      const v = fp.split('.').reduce((o, k) => (o == null ? o : o[k]), p);
      if (v === undefined) continue;
      if (!values.includes(v)) {
        errors.push({
          field: `payload.${fp}`, rule: 'invalid_enum_value',
          msg: `${fp} 只能取 [${values.map(x => JSON.stringify(x)).join(' | ')}]，实际是 ${JSON.stringify(v)}`,
        });
      }
      continue;
    }
    const [arrayKey, field] = fp.split('[].');
    const arr = p[arrayKey];
    if (!Array.isArray(arr)) continue;
    arr.forEach((item, idx) => {
      // 支持嵌套字段（如 five_step.path_reachable）
      const segs = field.split('.');
      let v = item;
      for (const s of segs) { if (v == null) break; v = v[s]; }
      if (v === undefined) return;
      if (!values.includes(v)) {
        errors.push({
          field: `payload.${arrayKey}[${idx}].${field}`, rule: 'invalid_enum_value',
          msg: `${fp} 只能取 [${values.map(x => JSON.stringify(x)).join(' | ')}]，实际是 ${JSON.stringify(v)}`,
        });
      }
    });
  }
  if (envelope.role === 'sweep') {
    // 2026-11-10（蓝队 A3）：GENERATED 必须给出生成器引用。
    // 实测：reachability=GENERATED 但完全不写 generator_ref → 契约合规。
    // 这让「文件头写一行 DO NOT EDIT 就免检」成为最廉价的逃避通道。
    if (p.reachability === 'GENERATED') {
      const gr = p.generator_ref;
      if (!gr || typeof gr !== 'string' || gr.trim().length < 3) {
        errors.push({
          field: 'payload.generator_ref', rule: 'generated_without_generator_ref',
          msg: `reachability=GENERATED 时必须写 generator_ref（生成器路径或命令）。` +
               `否则「标 GENERATED 就不深挖」等于一个免检开关——文件头写一行 DO NOT EDIT 即可绕过全部审计`,
        });
      }
    }
    if (typeof p.lead_count === 'number' && Array.isArray(p.leads) && p.lead_count !== p.leads.length) {
      errors.push({
        field: 'payload.lead_count', rule: 'count_mismatch',
        msg: `lead_count=${p.lead_count} 但 leads.length=${p.leads.length}`,
      });
    }
    // dimension_histogram 各值之和必须等于 lead_count（契约 §2.2a 明文，
    // 2026-11-12 实测此前从未校验）。直方图是覆盖率记账的唯一来源，
    // 对不上就等于覆盖率数字可以随手编。
    if (Array.isArray(p.leads) && p.dimension_histogram && typeof p.dimension_histogram === 'object') {
      const histSum = Object.values(p.dimension_histogram)
        .filter((v) => typeof v === 'number')
        .reduce((s, v) => s + v, 0);
      if (histSum !== p.leads.length) {
        errors.push({
          field: 'payload.dimension_histogram', rule: 'histogram_mismatch',
          msg: `dimension_histogram 各值之和=${histSum}，但 leads.length=${p.leads.length}。` +
               `契约 §2.2a 要求两者相等——直方图是覆盖率记账的唯一来源，对不上则覆盖率不可信`,
        });
      }
    }
  }
  if (envelope.role === 'recon') {
    if (typeof p.slice_count === 'number' && Array.isArray(p.audit_slices) && p.slice_count !== p.audit_slices.length) {
      errors.push({
        field: 'payload.slice_count', rule: 'count_mismatch',
        msg: `slice_count=${p.slice_count} 但 audit_slices.length=${p.audit_slices.length}`,
      });
    }
    // 入口点必须是带证据的对象，不是 "path:line" 字符串（2026-11-09 修正）
    if (Array.isArray(p.entry_points)) {
      p.entry_points.forEach((e, i) => {
        if (typeof e === 'string') {
          errors.push({
            field: `payload.entry_points[${i}]`, rule: 'entry_point_not_object',
            msg: `入口点必须是对象（含 location + evidence_quote），实际是字符串 "${e}"。旧契约写成 ["path:line"] 是错的`,
          });
          return;
        }
        for (const k of ['location', 'evidence_quote']) {
          if (!e?.[k]) {
            errors.push({
              field: `payload.entry_points[${i}].${k}`, rule: 'missing_entry_point_field',
              msg: `入口点 ${e?.entry_id ?? `#${i}`} 缺 ${k}——没有 evidence_quote 的入口等同凭印象列的，门 0 不通过`,
            });
          }
        }
      });
    }
    // 切片独立性：files 与 shared_dependencies 不得相交，且各切片 files 两两不相交
    if (Array.isArray(p.audit_slices)) {
      const seen = new Map();
      p.audit_slices.forEach((s, i) => {
        const sid = s?.slice_id ?? `#${i}`;
        const files = Array.isArray(s?.files) ? s.files : [];
        const shared = Array.isArray(s?.shared_dependencies) ? s.shared_dependencies : [];
        for (const f of files) {
          if (seen.has(f)) {
            errors.push({
              field: `payload.audit_slices[${i}].files`, rule: 'slice_overlap',
              msg: `文件 ${f} 同时出现在 ${seen.get(f)} 与 ${sid}——切片必须两两不相交（共享文件应进 shared_dependencies）`,
            });
          } else seen.set(f, sid);
        }
        for (const f of shared) {
          if (files.includes(f)) {
            errors.push({
              field: `payload.audit_slices[${i}].shared_dependencies`, rule: 'shared_in_files',
              msg: `${f} 同时在 files 和 shared_dependencies 里——共享文件不得计入 files / file_count`,
            });
          }
        }
      });
    }
    // 静默截断：声明了 truncated 却没在 unverified 里说明
    if (p.entry_points_truncated === true) {
      const hasNote = Array.isArray(p.unverified) &&
        p.unverified.some((u) => /截断|truncat/i.test(String(u?.reason ?? '')));
      if (!hasNote) {
        errors.push({
          field: 'payload.entry_points_truncated', rule: 'silent_truncation',
          msg: 'entry_points_truncated=true 但 unverified 里没有说明截断了多少——静默截断判违规',
        });
      }
    }
  }
  if (envelope.role === 'audit') {
    // findings[].status 枚举校验（2026-11-10 蓝队实测新增）
    // 实测：status 写 "TOTALLY_FINE_TRUST_ME" → ✅ 契约合规。
    // 这个字段决定发现是否进入锐评/修复，任意字符串等于没有约束。
    const FINDING_STATUS = ['CONFIRMED', 'NO_EVIDENCE_FOUND', 'GATE_0_FAILED', 'UNREADABLE', 'EVIDENCE_GAP'];
    const fs4 = Array.isArray(p.findings) ? p.findings : [];
    // findings 不得为空数组（契约 §2.2 明文：「空数组一律视为 CONTRACT_VIOLATION」）。
    // 实测：findings: [] 曾拿到「✅ 契约合规」——「没查」和「查了没发现」在契约上
    // 必须可区分，而空数组恰好把两者抹平了，让「什么都不做」成为最省事的通过方式。
    if (Array.isArray(p.findings) && p.findings.length === 0) {
      errors.push({
        field: 'payload.findings', rule: 'empty_findings',
        msg: `findings 是空数组。没发现任何问题时也必须返回一条 status="NO_EVIDENCE_FOUND" 的条目，` +
             `并在 searched_scope 里写明读了哪些文件、查了哪些模式——` +
             `否则「没查」和「查了没发现」无法区分`,
      });
    }
    fs4.forEach((f, j) => {
      // 2026-11-14 修：此前是 `f?.status !== undefined && ...`——**不写 status 就跳过检查**。
      // 但契约 §2.2 把 status 列为 findings 条目的字段，且「空 findings」被明确禁止，
      // 意味着每条 finding 都必须声明它的状态。缺省即违规，否则「省略最省事」。
      if (f?.status === undefined || f?.status === null) {
        errors.push({
          field: `payload.findings[${j}].status`, rule: 'missing_finding_status',
          msg: `findings[${j}] 缺 status。契约 §2.2 要求每条发现声明状态`
            + `（${FINDING_STATUS.join(' | ')}）——否则下游无法区分「已确认」和「证据不足」`,
        });
      } else if (!FINDING_STATUS.includes(f.status)) {
        errors.push({
          field: `payload.findings[${j}].status`, rule: 'invalid_finding_status',
          msg: `finding.status 只能取 ${FINDING_STATUS.join(' | ')}，实际是 "${f.status}"`,
        });
      }

      // 2026-11-14 修：finding 的字段名与结构此前完全没校验，导致
      // **示例里的错误结构能通过校验器，进而变成「错误但被验证过的规范」**。
      // 实测：我生成的 audit 示例用 `id`（契约是 `finding_id`）、把 `evidence` 写成
      // 数组（契约是对象）、把 `inference` 写成字符串（契约是 {claim,basis,alternatives}），
      // 全部通过了校验器，因为这里只查顶层必填键。
      //
      // 后果比「示例不标准」严重：第 366 行那段 CRITICAL 检查读 `inf.claim`，
      // 如果 inference 是字符串，`f.inference ?? {}` 拿到字符串、`.claim` 是 undefined，
      // **检查静默失效而不是报错**。
      const FIELD_ALIASES = {
        finding_id: 'id',
        evidence: null,
        inference: null,
      };
      if (f && typeof f === 'object') {
        if (!f.finding_id && f.id) {
          errors.push({
            field: `payload.findings[${j}].finding_id`, rule: 'wrong_field_name',
            msg: `findings[${j}] 用了 "id"，契约 §2.2 的字段名是 "finding_id"`,
          });
        } else if (!f.finding_id) {
          errors.push({
            field: `payload.findings[${j}].finding_id`, rule: 'missing_finding_id',
            msg: `findings[${j}] 缺 finding_id——下游锐评/修复/vrify 都靠它挂接`,
          });
        }

        if (f.evidence !== undefined) {
          if (Array.isArray(f.evidence)) {
            errors.push({
              field: `payload.findings[${j}].evidence`, rule: 'evidence_wrong_shape',
              msg: `findings[${j}].evidence 是数组，契约 §2.2 要求是对象 {file, line, quote}`,
            });
          } else if (!f.evidence || typeof f.evidence !== 'object') {
            errors.push({
              field: `payload.findings[${j}].evidence`, rule: 'evidence_wrong_shape',
              msg: `findings[${j}].evidence 必须是对象 {file, line, quote}`,
            });
          }
        }

        if (f.inference !== undefined && (typeof f.inference !== 'object' || Array.isArray(f.inference))) {
          errors.push({
            field: `payload.findings[${j}].inference`, rule: 'inference_wrong_shape',
            msg: `findings[${j}].inference 是 ${typeof f.inference}，契约 §2.2 要求对象`
              + ` {claim, basis, alternatives}。写成字符串会让 CRITICAL 准入检查静默失效`,
          });
        }
      }

      // CONFIRMED 必须真有证据（2026-11-10 蓝队实测新增）
      // 实测：CONFIRMED + severity:null + evidence 全 null → 契约合规。
      // 这意味着「已确认」可以完全没有证据——比「洗白」严重一个量级。
      if (f?.status === 'CONFIRMED') {
        const ev = f?.evidence;
        // 注意：quote 必须是非空字符串。只判 `!= null` 会放过 quote:""，
        // 红队实测过——CONFIRMED + quote:"" + basis:"looked" 曾拿到「✅ 契约合规」。
        const hasRealQuote = (e) =>
          e && typeof e.file === 'string' && e.file !== '' &&
          typeof e.quote === 'string' && e.quote.trim() !== '';
        const ok = ev && (Array.isArray(ev)
          ? ev.length > 0 && ev.every(hasRealQuote)
          : hasRealQuote(ev));
        if (!ok) {
          errors.push({
            field: `payload.findings[${j}].evidence`, rule: 'confirmed_without_evidence',
            msg: `status=CONFIRMED 但 evidence 的 file 为空或 quote 不是非空字符串（实际 quote=${JSON.stringify(ev?.quote)}）。` +
                 `CONFIRMED 的含义是「有门 0 级证据」，没有可引用的原文只能标 EVIDENCE_GAP`,
          });
        }
        if (!f?.severity) {
          errors.push({
            field: `payload.findings[${j}].severity`, rule: 'confirmed_without_severity',
            msg: `status=CONFIRMED 但 severity 为空。确认了缺陷却不判严重性，下游无法定级`,
          });
        }
        // CRITICAL 的准入门槛（wave2-audit.md §3.3，2026-11-12 之前无机械校验）
        // 契约原文：「不得把任何发现标为 CRITICAL，除非同时提供调用链证据
        // （从入口到问题点的完整路径）或可复现触发条件。仅有定义位置 + 推断的，最高 HIGH」
        //
        // 实测：4 个 agent 里有 3 个把「escapeHtml 顺序错」标成 CRITICAL，
        // 但只给了单元级测试输出，没有调用链——按 §3.3 应降为 HIGH。
        // 规则存在但从未被执行，等于不存在。
        if (f.severity === 'CRITICAL') {
          const inf = f.inference ?? {};
          const text = [
            inf.claim, inf.basis, f.runtime_evidence?.observed, f.runtime_evidence?.command,
            ...(Array.isArray(inf.alternatives) ? inf.alternatives : []),
          ].filter((x) => typeof x === 'string').join(' ');
          // 调用链：形如 a() → b() → c，或明确写了「调用链 / 入口 / caller」
          const hasCallChain = /调用链|调用路径|从\s*\S+\s*到|入口.*→|→.*→|caller|call site/i.test(text);
          // 可复现触发条件：明确的输入 → 输出，或命令 + 结果
          const hasTrigger = /(输入|传入|调用).{0,40}(得|返回|输出|→|抛出|抛错)|可复现|复现步骤|命令.{0,20}输出/i.test(text)
            || (f.runtime_evidence && typeof f.runtime_evidence.observed === 'string' && f.runtime_evidence.observed.trim() !== '');
          if (!hasCallChain && !hasTrigger) {
            errors.push({
              field: `payload.findings[${j}].severity`, rule: 'critical_without_call_chain',
              msg: `severity=CRITICAL 但既没有调用链证据、也没有可复现触发条件（wave2-audit.md §3.3）。` +
                   `仅凭定义位置 + 推断的最高只能标 HIGH——` +
                   `把 CRITICAL 锁在硬证据后面，是为了防止「看上去吓人」的东西挤占修复队列`,
            });
          }
        }
      }
    });
    // NO_EVIDENCE_FOUND 必须带搜索范围与方法（2026-11-10 新增）
    // 红队实测：一个 quote 为空、basis 只有 "looked" 三个字母的 NO_EVIDENCE_FOUND
    // 条目能拿到「✅ 契约合规」。这让「什么都不做」成为最廉价的攻击。
    const noEv = fs4.filter((f) => f?.status === 'NO_EVIDENCE_FOUND');
    if (noEv.length > 0) {
      const sc = p.searched_scope;
      const validScope = sc && typeof sc === 'object' &&
        Array.isArray(sc.files_read) && sc.files_read.length > 0 &&
        Array.isArray(sc.dimension_checklist) && sc.dimension_checklist.length > 0;
      if (!validScope) {
        errors.push({
          field: 'payload.searched_scope', rule: 'no_evidence_without_scope',
          msg: `${noEv.length} 条 NO_EVIDENCE_FOUND 但 payload.searched_scope 缺失或不完整（需 files_read + dimension_checklist 非空）。` +
               `「我查了没发现」必须证明「我真查了」——否则「什么都不做」就是最廉价的攻击`,
        });
      }
      // 每条 NO_EVIDENCE_FOUND 的 basis 不能是空话
      noEv.forEach((f, j) => {
        const basis = String(f?.inference?.basis ?? '').trim();
        if (basis.length < 15) {
          errors.push({
            field: `payload.findings[${j}].inference.basis`, rule: 'vacuous_basis',
            msg: `NO_EVIDENCE_FOUND 的 basis 只有 ${basis.length} 字（"${basis}"）——至少要说明查了哪些模式、覆盖了什么`,
          });
        }
      });
    }
    // 三项必做自检必须有承载字段（wave2-audit.md §6）
    // 没有这三个字段时，「必做」在契约上无法验证——子 Agent 做了主 Agent 也看不到。
    const sc = p.self_checks;
    if (sc && typeof sc === 'object' && !Array.isArray(sc)) {
      const REQUIRED_CHECKS = ['identifier_reconcile', 'self_check_audit', 'runtime_validation'];
      for (const k of REQUIRED_CHECKS) {
        if (!(k in sc)) {
          errors.push({
            field: `payload.self_checks.${k}`, rule: 'missing_self_check',
            msg: `缺少必做自检项 ${k}（wave2-audit.md §6 三项必做之一）。若确实不适用，写 "SKIPPED" 并在 note 说明理由`,
          });
          continue;
        }
        const VALID = ['DONE', 'SKIPPED', 'NOT_APPLICABLE'];
        const v = sc[k];
        const status = typeof v === 'string' ? v : v?.status;
        if (!VALID.includes(status)) {
          errors.push({
            field: `payload.self_checks.${k}`, rule: 'invalid_self_check_status',
            msg: `${k} 的 status 必须是 ${VALID.join(' / ')} 之一，实际是 "${status}"`,
          });
        }
        // SKIPPED / NOT_APPLICABLE 必须给理由，否则等同于静默跳过
        if ((status === 'SKIPPED' || status === 'NOT_APPLICABLE')) {
          const note = typeof v === 'string' ? null : (v?.note ?? v?.reason);
          if (!note || String(note).trim().length < 10) {
            errors.push({
              field: `payload.self_checks.${k}`, rule: 'self_check_no_reason',
              msg: `${k} 标为 ${status} 但没给具体理由（note 至少 10 字）——静默跳过等于没做`,
            });
          }
        }
      }
    }
  }
  if (envelope.role === 'critique') {
    const vs = Array.isArray(p.verdicts) ? p.verdicts : [];
    // verdicts 必须覆盖全部 target_finding_ids（2026-11-10 蓝队 A12）
    // wave3-critique.md 的自检表写了「verdicts 覆盖派发时传入的全部 target_finding_ids」，
    // 但校验器从来没查过。实测：只覆盖 1/3 个 target → EXIT=0。
    const targets = Array.isArray(p.target_finding_ids) ? p.target_finding_ids : [];
    if (targets.length > 0) {
      const covered = new Set(vs.map((v) => v?.finding_id).filter(Boolean));
      const missing = targets.filter((t) => !covered.has(t));
      if (missing.length > 0) {
        errors.push({
          field: 'payload.verdicts', rule: 'verdict_missing_for_target',
          msg: `以下 target_finding_ids 没有任何 verdict: ${missing.join(', ')}。` +
               `漏审一条等于放它直接进入修复波——锐评波的价值全在「每条都被攻击过」`,
        });
      }
    }
    // 裁决枚举按子角色分支（output-contract §2.3）
    const VERDICT_BY_ROLE = {
      skeptic: ['holds', 'refuted', 'untested'],
      arbiter: ['UPHELD', 'DOWNGRADED', 'REVOKED'],
      devils_advocate: [],   // 它不返回 verdicts
    };
    const allowed = VERDICT_BY_ROLE[p.critique_role];
    if (allowed && allowed.length > 0) {
      vs.forEach((v, i) => {
        if (v?.verdict !== undefined && !allowed.includes(v.verdict)) {
          errors.push({
            field: `payload.verdicts[${i}].verdict`, rule: 'invalid_verdict_enum',
            msg: `${p.critique_role} 的 verdict 只能取 ${allowed.join(' | ')}，实际是 "${v.verdict}"`,
          });
        }
      });
    }
    // devils_advocate 不得填 verdicts
    if (p.critique_role === 'devils_advocate' && vs.length > 0) {
      errors.push({
        field: 'payload.verdicts', rule: 'devils_advocate_has_verdicts',
        msg: `devils_advocate 只评覆盖，不评发现。verdicts 必须为空数组，实际有 ${vs.length} 条`,
      });
    }

    // 2026-11-14 修：coverage_gaps.kind 是契约声明的闭集，但此前**零校验**。
    // 实测 `kind: "TOTALLY_MADE_UP"` → ✅ 契约合规。
    // 而 kind 决定下一波派谁（SLICE_UNCOVERED → REASSIGN_TO_NEW_AUDIT 等），
    // 枚举不闭合 = 调度器收到未知指令。
    const COVERAGE_KIND = ['SLICE_UNCOVERED', 'FILE_UNREAD', 'DIMENSION_OMITTED', 'ENTRY_UNCOVERED'];
    const gaps = Array.isArray(p.coverage_gaps) ? p.coverage_gaps : [];
    gaps.forEach((g, i) => {
      if (g?.kind !== undefined && !COVERAGE_KIND.includes(g.kind)) {
        errors.push({
          field: `payload.coverage_gaps[${i}].kind`, rule: 'invalid_coverage_kind',
          msg: `coverage_gaps[${i}].kind 只能取 ${COVERAGE_KIND.join(' | ')}，实际是 "${g.kind}"`,
        });
      }
      // 契约 §2.3 表格：每条缺口都要有 gap_id / kind / target / evidence.observation /
      // potential_impact / recommended_action，缺任一即无法被主 Agent 机械消费。
      for (const k of ['kind', 'target', 'recommended_action']) {
        if (g && typeof g === 'object' && g[k] === undefined) {
          errors.push({
            field: `payload.coverage_gaps[${i}].${k}`, rule: 'incomplete_coverage_gap',
            msg: `coverage_gaps[${i}] 缺 ${k}——每条缺口必须可被主 Agent 机械消费成下一步动作`,
          });
        }
      }
    });

    // 2026-11-14：Devil's Advocate 的四个覆盖扫描布尔。
    // wave3-critique.md:493 原文：「`slice_scan_performed`、`file_scan_performed`、
    // `dimension_scan_performed`、`entry_scan_performed`，四者均为 `true`」。
    // 实测：这四者在全仓 tools/ 里**零命中**，DA 完全靠自述「我扫了」。
    // 而 DA 是锐评波里唯一负责覆盖完整性的角色——它有没有真扫是**二值可判**的，
    // 不需要设计判据，是本轮性价比最高的一条。
    if (p.critique_role === 'devils_advocate') {
      const SCANS = ['slice_scan_performed', 'file_scan_performed', 'dimension_scan_performed', 'entry_scan_performed'];
      for (const k of SCANS) {
        if (p[k] !== true) {
          errors.push({
            field: `payload.${k}`, rule: 'missing_scan_flag',
            msg: `devils_advocate 必须以 ${k}: true 声明四类覆盖扫描均执行（wave3-critique.md:493）。`
              + '四者缺一即无法证明真的扫过，等于把「有没有查」退回自述',
          });
        }
      }
    }

    // 契约 §2.3 原文（:490 / :503）：
    //   「仅 critique_role == "skeptic" 时必填。devils_advocate 与 arbiter 不得返回
    //     该字段（返回即越界，判 CONTRACT_VIOLATION）」
    //   「skeptic 缺失该字段 = 未完成职责，其全部 verdicts 作废」
    // 没这条校验时，我生成的 critique 示例（skeptic、无 discipline_audit）
    // 能通过校验器——于是示例成了「错误但被验证过的规范」。
    const hasDiscipline = p.discipline_audit !== undefined && p.discipline_audit !== null;
    if (p.critique_role === 'skeptic') {
      if (!hasDiscipline) {
        errors.push({
          field: 'payload.discipline_audit', rule: 'missing_discipline_audit',
          msg: 'skeptic 必填 discipline_audit（契约 §2.3）。缺失该字段 = 未完成职责，'
            + '其全部 verdicts 按契约作废——未申报的裁量只有被主动找出来才能发现',
        });
      } else if (typeof p.discipline_audit === 'object' && !Array.isArray(p.discipline_audit)) {
        // performed 是这条审计的核心开关：声称做了就必须有可核对的结构
        if (p.discipline_audit.performed === undefined) {
          errors.push({
            field: 'payload.discipline_audit.performed', rule: 'discipline_audit_no_performed',
            msg: 'discipline_audit 缺 performed。这一项决定「有没有真的查」——省略等于没申报',
          });
        }
      }
    } else if (['devils_advocate', 'arbiter'].includes(p.critique_role) && hasDiscipline) {
      errors.push({
        field: 'payload.discipline_audit', rule: 'discipline_audit_out_of_role',
        msg: `${p.critique_role} 不得返回 discipline_audit（契约 §2.3：返回即越界，判 CONTRACT_VIOLATION）`,
      });
    }

    // 2026-11-14：pattern_sweep 同样有角色分支（仅 devils_advocate + 存在
    // HIGH/CRITICAL 时必填，其他子角色返回即越界），此前也未校验。
    const hasSweep = p.pattern_sweep !== undefined && p.pattern_sweep !== null;
    if (hasSweep && p.critique_role !== 'devils_advocate') {
      errors.push({
        field: 'payload.pattern_sweep', rule: 'pattern_sweep_out_of_role',
        msg: `pattern_sweep 仅 devils_advocate 可用，${p.critique_role} 返回即越界（契约 §2.3）`,
      });
    }
    for (let i = 0; i < vs.length; i++) {
      const v = vs[i];
      const fid = v?.finding_id ?? `#${i}`;
      // five_step 必填且五步齐全（wave3-critique.md §2.1）
      if (p.critique_role === 'skeptic') {
        const fs2 = v?.five_step;
        if (!fs2 || typeof fs2 !== 'object') {
          errors.push({
            field: `payload.verdicts[${i}].five_step`, rule: 'missing_five_step',
            msg: `${fid} 缺 five_step——Skeptic 必须逐条执行五步测试，不允许用「整体看起来没问题」替代`,
          });
        } else {
          for (const k of ['evidence_opened', 'evidence_supports_claim', 'path_reachable', 'already_handled', 'failure_chain_holds']) {
            if (!(k in fs2)) {
              errors.push({
                field: `payload.verdicts[${i}].five_step.${k}`, rule: 'incomplete_five_step',
                msg: `${fid} 的五步测试缺第 ${k} 步`,
              });
            }
          }
        }
      }
      // sub_claims：裁决作用在子主张上（2026-11-10 新增）
      const subs = v?.sub_claims;
      // 强制：verdict=holds 但 reason 在否定原危害/后果 → 必须拆子主张
      // （不写就是「部分成立」被压成二元裁决，下游无法判断该不该降级）
      if (p.critique_role === 'skeptic' && v?.verdict === 'holds') {
        const reason = String(v?.reason ?? '');

        // 2026-11-14 补（批判 agent 实测）：reason 此前完全无长度/实质检查。
        // 实测 `reason: "待填"`（3 字符）→ ✅ 契约合规。
        // 而 verdict 是整条裁决的唯一说明——它空着，下游无从复核为什么判 holds。
        // 用 substanceLength 而不是 .length：中文 1 字符 = 1、零宽字符 = 0，
        // 避免「零宽字符凑够 81 个」这种绕过。
        if (substanceLength(reason) < 15 || isVacuous(reason)) {
          errors.push({
            field: `payload.verdicts[${i}].reason`, rule: 'vacuous_reason',
            msg: `${fid} 的 reason 没有实质内容（去空白与零宽字符后 ${substanceLength(reason)} 字，`
              + `${isVacuous(reason) ? '或命中占位词' : '少于 15 字'}）。`
              + 'verdict 是整条裁决的唯一说明，空着下游无从复核为什么这么判',
          });
        }

        const deniesHarm = /后果|危害|影响方向|方向相反|方向说反|不至于|被夸大|高估|降级/.test(reason);
        if (deniesHarm && !(Array.isArray(subs) && subs.length > 0)) {
          errors.push({
            field: `payload.verdicts[${i}].sub_claims`, rule: 'missing_sub_claims',
            msg: `${fid} 的 reason 在否定原危害/后果（判为 holds 但说方向错了），却没拆 sub_claims。这种「机制对、后果错」必须逐条给结论，否则下游无法区分「全对」和「一半对」`,
          });
        }
      }
      if (Array.isArray(subs) && subs.length > 0) {
        const SUB_VALID = ['holds', 'refuted', 'untested'];
        let hasHold = false, hasRefute = false;
        subs.forEach((s, j) => {
          const sid = `${fid}.sub[${j}]`;
          if (!s?.claim || !s?.verdict) {
            errors.push({
              field: `payload.verdicts[${i}].sub_claims[${j}]`, rule: 'incomplete_sub_claim',
              msg: `${sid} 缺 claim 或 verdict——子主张必须可独立判定`,
            });
            return;
          }
          if (!SUB_VALID.includes(s.verdict)) {
            errors.push({
              field: `payload.verdicts[${i}].sub_claims[${j}].verdict`, rule: 'invalid_sub_verdict',
              msg: `${sid} 的 verdict 只能取 ${SUB_VALID.join(' | ')}，实际是 "${s.verdict}"——不要发明新枚举`,
            });
          }
          if (s.verdict === 'refuted' && !s.direct_contradiction && !s.reason) {
            errors.push({
              field: `payload.verdicts[${i}].sub_claims[${j}]`, rule: 'sub_refuted_without_basis',
              msg: `${sid} 判 refuted 但既没有 direct_contradiction 也没有 reason——空口反驳`,
            });
          }
          if (s.verdict === 'holds') hasHold = true;
          if (s.verdict === 'refuted') hasRefute = true;
        });
        // 机制对后果错时，reason 必须区分
        if (hasHold && hasRefute) {
          const reason = String(v?.reason ?? '');
          if (!/机制|后果|危害/.test(reason)) {
            errors.push({
              field: `payload.verdicts[${i}].reason`, rule: 'mixed_sub_claims_unexplained',
              msg: `${fid} 同时有 holds 和 refuted 子主张，但 reason 没说明哪类是机制、哪类是后果——下游无法判断该不该降级`,
            });
          }
        }
      }
      // verdict=refuted 时，五个「不可自信领域」必须有 direct_contradiction
      // refuted 但没给直接矛盾证据（2026-11-10 蓝队 A12）
      // 五个「不可自信领域」里，只有 concurrency 与 dimension 是一对一映射，
      // 所以那一个硬执行，其余保持警告（避免凭空造一张映射表）。
      if (v?.verdict === 'refuted' && !v?.direct_contradiction) {
        const dim = v?.dimension;
        if (dim === 'concurrency') {
          errors.push({
            field: `payload.verdicts[${i}].direct_contradiction`, rule: 'sensitive_refuted_without_contradiction',
            msg: `${fid} 属于 concurrency 领域且判 refuted，但没有 direct_contradiction。` +
                 `并发类缺陷最难判断，误杀代价最高——必须给出一行直接矛盾的代码`,
          });
        } else {
          warnings.push({
            field: `payload.verdicts[${i}].direct_contradiction`, rule: 'refuted_without_contradiction',
            msg: `${fid} 判 refuted 但没有 direct_contradiction。若该发现属于内存安全/并发/声明一致性/行为变更/未使用参数，按 §2.2 不得判 refuted`,
          });
        }
      }
      // runtime_evidence 的对照实验（2026-11-10 新增）
      const re2 = v?.runtime_evidence;
      // 先要求显式声明「这条发现是否涉及运行时可观察行为」——
      // 否则「该跑没跑」无法机械判定（契约层拿不到语义）
      if (p.critique_role === 'skeptic' && v?.runtime_applicable === undefined) {
        errors.push({
          field: `payload.verdicts[${i}].runtime_applicable`, rule: 'missing_runtime_applicable',
          msg: `${fid} 缺 runtime_applicable。你必须显式回答「这条发现是否涉及运行时可观察行为」——` +
               `不声明就无法判断你是否该跑一遍，而「该跑没跑」的 holds 是不可信的`,
        });
      }
      if (v?.runtime_applicable === true && (!re2 || !re2.method || re2.method === 'null')) {
        errors.push({
          field: `payload.verdicts[${i}].runtime_evidence`, rule: 'runtime_required_but_missing',
          msg: `${fid} 声明了 runtime_applicable=true 却没有 runtime_evidence——声明的运行时行为必须真跑一次`,
        });
      }
      if (re2 && typeof re2 === 'object' && re2.method && re2.method !== 'null') {
        if (!re2.control_case || String(re2.control_case).trim().length < 5) {
          warnings.push({
            field: `payload.verdicts[${i}].runtime_evidence.control_case`, rule: 'runtime_no_control',
            msg: `${fid} 给了 runtime_evidence 但没有 control_case——没有对照的实验不可采信（无法区分「真的没反应」和「探针失灵」）`,
          });
        }
        if (!re2.observed || String(re2.observed).trim().length < 3) {
          errors.push({
            field: `payload.verdicts[${i}].runtime_evidence.observed`, rule: 'runtime_no_output',
            msg: `${fid} 的 runtime_evidence 缺 observed 原始输出。「我跑过了」不构成证据`,
          });
        }
        // 2026-11-11 实测修正：main_path 从「必填」降级为「建议」。
        // 对照实验（3 组有规则 vs 3 组无规则）显示：强制要求「设计运行验证」
        // 会让 recall 下降 7.9 个点（70.6% vs 78.5%，Cohen's d=1.63）——
        // 多漏的全是「跑起来看不出、只有读代码才知道」的缺陷。
        // 唯一保留硬要求的是 control_case（没有对照无法区分缺陷与探针故障）。
        const mp = re2.main_path;
        if (!mp || typeof mp !== 'object') {
          warnings.push({
            field: `payload.verdicts[${i}].runtime_evidence.main_path`, rule: 'runtime_no_main_path',
            msg: `${fid} 的 runtime_evidence 没有 main_path（建议但非必需）。` +
                 `若跑过公开 API 主路径，请写出期望值 vs 实际值；没跑也接受，但不得声称已验证运行时行为`,
          });
        } else {
          if (!mp.expected || !mp.observed) {
            errors.push({
              field: `payload.verdicts[${i}].runtime_evidence.main_path`, rule: 'runtime_main_path_incomplete',
              msg: `${fid} 的 main_path 缺 expected 或 observed——没有「期望值 vs 实际值」就不构成验证`,
            });
          } else if (String(mp.expected).trim() === String(mp.observed).trim()) {
            warnings.push({
              field: `payload.verdicts[${i}].runtime_evidence.main_path`, rule: 'runtime_main_path_trivial',
              msg: `${fid} 的 main_path 期望值与实际值完全相同——这条运行验证没有区分力（是不是只跑了语法检查？）`,
            });
          }
        }
      }
    }
  }
  if (envelope.role === 'fix') {
    // 2026-11-15：fix 的 disposition 契约（见文件顶部 §0 的注释）。
    // 支持两种形态：
    //   单发现   payload 本身是一个 disposition 条目（finding_id + disposition + …）
    //   多发现   payload.dispositions[] 逐条列出，配合派发时传入的 target_finding_ids
    // 两种都必须经同一套校验，否则「换个写法就能绕开」。
    //
    // 判定顺序：dispositions 非空时它就是权威清单，不再把 payload 顶层
    // 当成一条额外条目——否则顶层那个 finding_id（多发现形态里往往是
    // 派发的主发现）会被要求写一个它本来不该有的 disposition。
    const entries = [];
    if (Array.isArray(p.dispositions) && p.dispositions.length > 0) {
      p.dispositions.forEach((d, i) => entries.push({ entry: d, prefix: `payload.dispositions[${i}]` }));
    } else {
      // 单发现形态；也包括「什么都没写」的情况——那需要一个 missing_disposition
      // 指向 payload.disposition，而不是静默跳过。
      entries.push({ entry: p, prefix: 'payload' });
    }

    for (const { entry, prefix } of entries) {
      errors.push(...validateDispositionEntry(entry, prefix));
    }

    // 覆盖校验：与 critique 的 verdict_missing_for_target 同构。
    // critique 那边管「每条发现被攻击过一次」，这里管「每条发现被处置过一次」。
    // 少了这一条，修复波可以只做 1/38 而完全合规——实测就是这样发生的。
    const targets = Array.isArray(p.target_finding_ids) ? p.target_finding_ids : [];
    if (targets.length > 0) {
      const covered = new Set(
        entries.map(({ entry }) => entry?.finding_id).filter((x) => typeof x === 'string' && x !== ''),
      );
      const missing = targets.filter((t) => !covered.has(t));
      if (missing.length > 0) {
        errors.push({
          field: Array.isArray(p.dispositions) ? 'payload.dispositions' : 'payload.disposition',
          rule: 'disposition_missing_for_target',
          msg: `以下 target_finding_ids 没有任何 disposition: ${missing.join(', ')}。` +
               `漏处置一条等于让它静默蒸发——实测 38 条发现只修了 6 条，31 条从未进入任何任务书，` +
               `而框架里没有任何工具报错。锐评波要求「每条都被攻击过」，修复波必须要求「每条都被处置过」`,
        });
      }
    }
  }
  if (envelope.role === 'planner') {
    const sum = Object.values(p.score_breakdown ?? {}).reduce((a, b) => a + b, 0);
    if (typeof p.score === 'number' && sum > 0 && p.score !== sum) {
      errors.push({
        field: 'payload.score', rule: 'score_mismatch',
        msg: `score=${p.score} 但 breakdown 之和=${sum}`,
      });
    }
    if (typeof p.member_count === 'number' && Array.isArray(p.members)) {
      // 2026-11-14 修：契约 §2.0 的 members[] 结构是
      //     { agent_id, role, depends_on, note }        ← 逐 agent 列出，没有 count
      // 而 wrappers/planner.md §5 的结构是
      //     { role, count, scope, sees, must_not_see }  ← 按职能聚合，有 count
      // 校验器此前只认后者（reduce 求 count 之和），于是**严格照契约写必被拒**：
      // 一份完全按 §2.0 写的产物会得到 `member_count=2 但 members 展开数=0`。
      // 契约里的 schema 通不过自己的校验器 —— 这是最坏的一类缺陷。
      //
      // 两种表示法本身都合法：
      //   逐个列出 → 每个成员代表 1 个 agent（count 缺省为 1）
      //   按职能聚合 → 显式给 count
      // 所以校验器两种都认：有 count 用 count，没有就按 1 计。
      const msum = p.members.reduce(
        (a, x) => a + (typeof x?.count === 'number' ? x.count : 1), 0);
      if (p.member_count !== msum) {
        errors.push({
          field: 'payload.member_count', rule: 'count_mismatch',
          msg: `member_count=${p.member_count} 但 members 展开数=${msum}`
            + '（逐个列出时每项按 1 计，按职能聚合时按 count 计）',
        });
      }
      // 两种结构都必须能唯一确定「这个成员是谁」。逐个列出要有 agent_id；
      // 按职能聚合要有 role + scope。两者都没有时，下游无法从 members 复原面板。
      p.members.forEach((m, i) => {
        const hasId = typeof m?.agent_id === 'string' && m.agent_id.trim() !== '';
        const hasFunc = typeof m?.role === 'string' && m.role.trim() !== '';
        if (!hasId && !hasFunc) {
          errors.push({
            field: `payload.members[${i}]`, rule: 'member_unidentifiable',
            msg: `members[${i}] 既没有 agent_id 也没有 role——下游无法知道这个成员是谁`,
          });
        }
      });
    }
  }

  // ── duplicate_finding_id：对所有角色生效（2026-11-15 新增）──
  // 实测：把 7 条 finding 的 finding_id 改成完全相同，校验器仍报「✅ 契约合规」。
  // 后果不是「格式不整齐」：下游的锐评裁决、验收结论、修复回填全部按 finding_id
  // 挂接，id 重复意味着 7 条发现里只有 1 条能被引用，其余 6 条**在结构上无法被处置**——
  // 而它们仍然出现在账本里，看起来像是被覆盖了。这是「发现静默蒸发」最隐蔽的一种。
  for (const arrKey of ['findings', 'verdicts', 'dispositions', 'target_finding_ids']) {
    const arr = p[arrKey];
    if (!Array.isArray(arr)) continue;
    // target_finding_ids 是字符串数组，其余是对象数组
    const ids = arr
      .map((x) => (typeof x === 'string' ? x : x?.finding_id))
      .filter((x) => typeof x === 'string' && x.trim() !== '');
    const seen = new Map();
    const dupes = new Map();
    ids.forEach((id, i) => {
      if (seen.has(id)) {
        if (!dupes.has(id)) dupes.set(id, [seen.get(id)]);
        dupes.get(id).push(i);
      } else seen.set(id, i);
    });
    for (const [id, idxs] of dupes) {
      errors.push({
        field: `payload.${arrKey}`,
        rule: 'duplicate_finding_id',
        msg: `${arrKey} 里 finding_id "${id}" 重复 ${idxs.length} 次（下标 ${idxs.join(', ')}）。`
          + '下游锐评/验收/修复回填全部按 finding_id 挂接，重复 id 会让这些条目'
          + '**在结构上无法被单独处置**，但它们仍出现在账本里，看起来像是被覆盖了',
      });
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// 4 · 验收角色：FAIL 时必须给出归因与可复现触发条件
// ────────────────────────────────────────────────────────────────────// 2026-11-14 补：契约 §2.5 白纸黑字写了两条条件必填——
//   `failure_category`  `verdict: FAIL` 时必填（决定回波次四还是判 REVOKED）
//   `failure_trigger`   `verdict: FAIL` 时必填（可复现的触发条件）
// 但校验器此前**完全不检查**。实测一个 `verdict: "FAIL"`、没有任何归因的
// 产物被判「✅ 契约合规」——规则写在文档里，要求没有强制力。
//
// 为什么这两条重要：没有 `failure_category`，主Agent无法判断该重派（FIX_INCOMPLETE）
// 还是该撤稿（FIX_INCORRECT）；没有 `failure_trigger`，下一轮修复 Agent
// 只能盲猜复现路径，等于把验收结论退化成一句「没过」。
if (envelope && envelope.role === 'verify') {
  const vp = envelope.payload ?? {};
  // 2026-11-14 修：verdict 枚举此前完全不校验。契约 §2.5 写死闭集 PASS | FAIL。
  // 实测 `verdict: "fail"` 会让整段 FAIL 检查被跳过（因为 !== "FAIL"），
  // 而人类读到的是「验收没通过」——主 Agent 不进故障分支，人却以为失败了。
  // 同文件对 critique 的 verdicts[].verdict 有 invalid_verdict_enum，verify 却没有。
  if (vp.verdict !== undefined) {
    if (!['PASS', 'FAIL'].includes(vp.verdict)) {
      errors.push({
        field: 'payload.verdict', rule: 'invalid_verify_verdict',
        msg: `verdict 只能取 PASS | FAIL，实际是 ${JSON.stringify(vp.verdict)}。`
          + '大小写不符会让 FAIL 的必填检查被静默跳过',
      });
    }
  }
  if (vp.verdict === 'FAIL') {
    if (!vp.failure_category) {
      errors.push({
        field: 'payload.failure_category', rule: 'missing_failure_category',
        msg: 'verdict=FAIL 时必须给出 failure_category（FIX_INCOMPLETE / FIX_INCORRECT / '
          + 'BASELINE_INVALID / ENVIRONMENT）——主Agent靠它判断该重派还是该撤稿',
      });
    } else if (!['FIX_INCOMPLETE', 'FIX_INCORRECT', 'BASELINE_INVALID', 'ENVIRONMENT'].includes(vp.failure_category)) {
      errors.push({
        field: 'payload.failure_category', rule: 'invalid_failure_category',
        msg: `failure_category="${vp.failure_category}" 不在闭集内`
          + '（FIX_INCOMPLETE | FIX_INCORRECT | BASELINE_INVALID | ENVIRONMENT）',
      });
    }
    if (!vp.failure_trigger || String(vp.failure_trigger).trim() === '') {
      errors.push({
        field: 'payload.failure_trigger', rule: 'missing_failure_trigger',
        msg: 'verdict=FAIL 时必须给出可复现的触发条件——否则下一轮修复 Agent 只能盲猜复现路径',
      });
    }
  }
  // ENVIRONMENT 归因与 FAIL 状态自相矛盾：环境问题是可重试的，不该判 FAIL
  if (vp.failure_category === 'ENVIRONMENT' && vp.verdict === 'FAIL') {
    warnings.push({
      field: 'payload.failure_category', rule: 'environment_should_be_retryable',
      msg: 'failure_category=ENVIRONMENT 时应改用 RETRYABLE_FAILURE 顶层状态而非 FAIL'
        + '（契约 §2.5 明文）',
    });
  }
}

// ────────────────────────────────────────────────────────────────────
// 5 · 验收角色的变异检验 vs 只读身份
// ────────────────────────────────────────────────────────────────────
if (envelope && envelope.role === 'verify' && envelope.payload?.evidence?.mutation_check === 'performed') {
  // 变异检验要求改文件再改回来——验收 Agent 是只读角色（wrappers/verifier.md）
  warnings.push({
    field: 'payload.evidence.mutation_check',
    rule: 'mutation_check_vs_readonly',
    msg: '声称做了变异检验，但验收 Agent 是只读角色。确认它真的有写权限',
  });
}

// ────────────────────────────────────────────────────────────────────
// 5b · 变异检验的强制性与深度（2026-11-17 补）
// ────────────────────────────────────────────────────────────────────
// 契约 `output-contract/verify.md` 对这两个字段写得很硬：
//   · `mutation_check`：除 harness_unsupported / unsafe_revert 外**强制为 performed**，
//     skipped 时必须在 notes 写明属于哪一种，「其余理由一律不接受」
//   · `mutation_scope`：对「函数返回值决定用户可见行为」的修复**必须为
//     implementation_and_callsite**，否则须在 notes 说明为何未做调用点变异
//
// 但在补这一段之前，`grep -rn "mutation_scope" tools/*.mjs` 的**唯一命中**是
// `gen-contract-examples.mjs:192` —— 那是范例生成器，不是校验器。
// 后果不是假设的：`gen-contract-examples.mjs:243` 会真的把范例喂给本校验器，
// 通过后在生成物里写「这份示例已经过 check-payload.mjs 验证，可以直接照抄再改」
// （`:273`），而那份范例用的正是 `implementation_only`、notes 一句解释都没有。
// **框架给 agent 照抄的标准范例自己违反正文，还盖了「已验证」的章。**
// 实战产出 `field-test-1/.../round1-05-verify-1.md` 用的就是这个写法，
// 拿到 verdict: PASS + escalation_required: false。
//
// 级别选择：`mutation_check` 缺失/非法 → ERROR（契约说「一律不接受」）；
// scope 偏弱但没有解释 → WARNING 起步，因为它需要一个判断——是否属于
// 「函数返回值决定用户可见行为」。把它判 ERROR 会把合法情形误拦成硬失败。
if (envelope && envelope.role === 'verify') {
  const ev = envelope.payload?.evidence ?? {};
  const notes = String(envelope.payload?.notes ?? '');
  const mc = ev.mutation_check;

  // 契约 `verify.md:184` 把 `evidence.mutation_check` 的必填性写死为「是」，
  // 只有 harness_unsupported / unsafe_revert 两种情形可以是 skipped。
  // 所以**整个字段缺失也是违规**——而在补这一条之前，缺失会让下面所有
  // scope 检查静默跳过：`mutation_scope` 写了什么都不再被看。
  // 这正是本仓库反复出现的形态：判据指向的字段可以不存在，于是判据变成可选。
  if (mc === undefined || mc === null || mc === '') {
    errors.push({
      field: 'payload.evidence.mutation_check', rule: 'missing_mutation_check',
      msg: 'evidence.mutation_check 必填（performed | skipped）。'
        + '它缺失时，下面所有关于变异深度（mutation_scope）的检查都会被静默跳过——'
        + '「字段不存在」与「检查通过」必须可区分。',
    });
  } else if (!['performed', 'skipped'].includes(mc)) {
    errors.push({
      field: 'payload.evidence.mutation_check', rule: 'invalid_mutation_check',
      msg: `mutation_check 只能取 performed | skipped，实际是 ${JSON.stringify(mc)}`,
    });
  }

  if (mc === 'skipped') {
    // 只有两种理由被接受：harness_unsupported / unsafe_revert
    const okReason = /harness_unsupported|unsafe_revert/.test(notes);
    if (!okReason) {
      errors.push({
        field: 'payload.evidence.mutation_scope', rule: 'invalid_mutation_skip_reason',
        msg: 'mutation_check=skipped 时 notes 必须写明属于 harness_unsupported 或 unsafe_revert。'
          + '契约原话是「其余理由一律不接受」——变异检验是唯一能证明「检查瞄准了这个缺陷」的手段，'
          + '随便一个理由就能跳过它，等于这道验收没有。',
      });
    }
  }

  if (mc === 'performed') {
    const ms = ev.mutation_scope;
    if (ms === undefined || ms === null || ms === '') {
      errors.push({
        field: 'payload.evidence.mutation_scope', rule: 'missing_mutation_scope',
        msg: 'mutation_check=performed 时 mutation_scope 必填'
          + '（implementation_only | implementation_and_callsite）。'
          + '只写「做了变异」不写做到哪一层，无法判断它是否能证明修复点正确。',
      });
    } else if (!['implementation_only', 'implementation_and_callsite'].includes(ms)) {
      errors.push({
        field: 'payload.evidence.mutation_scope', rule: 'invalid_mutation_scope',
        msg: `mutation_scope="${ms}" 不在闭集内`
          + '（implementation_only | implementation_and_callsite）',
      });
    }
  }

  // ── 5c · input_space_basis：唯一能触及「只测了最容易通过的形态」的抓手 ──
  // 契约 `verify.md` 把它定为必填。它无法阻止不诚实的申报（那是自述层的极限），
  // 但它能让「本条修复只测了一个样本」这件事**进入最终报告**，而不是静默消失。
  //
  // 为什么需要它：2026-11-16 的 F1 修复声称「截断已被拦住」，实际只堵住 1.0%
  // （独立评审用 192 个截断样本穷举才证明）。后来实测过三种「按断言语义 diff」
  // 的检测器形态，对这件事全部 0 命中——因为被测仓库里 0 个测试在遍历截断点，
  // 没有可比的东西。所以只能靠申报。
  //
  // 为什么 `unknown` 也算触发：它和 `single_sample` 对验收的含义相同（都没证明覆盖），
  // 若只惩罚前者，写 `unknown` 就成了一条免费绕道。
  const basis = ev.input_space_basis;
  if (basis === undefined || basis === null || basis === '') {
    errors.push({
      field: 'payload.evidence.input_space_basis', rule: 'missing_input_space_basis',
      msg: 'evidence.input_space_basis 必填'
        + '（exhaustive | boundary | single_sample | unknown）。'
        + '它是唯一能记录「这条修复覆盖了缺陷输入空间的哪一档」的字段——'
        + '缺了它，「只测了一个样本」这件事在账本上完全不可见。',
    });
  } else if (!['exhaustive', 'boundary', 'single_sample', 'unknown'].includes(basis)) {
    errors.push({
      field: 'payload.evidence.input_space_basis', rule: 'invalid_input_space_basis',
      msg: `input_space_basis="${basis}" 不在闭集内`
        + '（exhaustive | boundary | single_sample | unknown）',
    });
  } else if ((basis === 'single_sample' || basis === 'unknown')
             && envelope.payload?.escalation_required !== true) {
    errors.push({
      field: 'payload.escalation_required', rule: 'weak_basis_without_escalation',
      msg: `input_space_basis="${basis}" 表示这条修复没有证明输入空间覆盖，`
        + 'escalation_required 必须为 true（「带保留通过」）。'
        + '否则「只测了一个样本」会被当成完整通过写进已闭合集合。',
    });
  }
}

// ────────────────────────────────────────────────────────────────────
// 输出
// ────────────────────────────────────────────────────────────────────
const result = {
  file,
  ok: errors.length === 0,
  role: envelope?.role ?? null,
  errors,
  warnings,
};

if (jsonOut) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`\n契约准入检查: ${file}\n`);
  if (envelope) console.log(`  role: ${envelope.role}   status: ${envelope.status}\n`);

  if (errors.length === 0) {
    console.log('  ✅ 契约合规\n');
  } else {
    console.log(`  ✗ ${errors.length} 项违规:\n`);
    for (const e of errors) {
      console.log(`    [${e.rule}] ${e.field}`);
      console.log(`      ${e.msg}`);
      if (e.fix) console.log(`      修法: ${e.fix}`);
    }
    console.log();
  }
  if (warnings.length) {
    console.log(`  ⚠️  ${warnings.length} 项警告:`);
    for (const w of warnings) console.log(`    [${w.rule}] ${w.msg}`);
    console.log();
  }
}

process.exit(errors.length > 0 ? 1 : 0);
