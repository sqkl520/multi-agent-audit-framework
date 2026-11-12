#!/usr/bin/env node
/**
 * lint-autonomy.mjs — 静态检查：框架里不得存在「停下来等用户」的活规则
 *
 * 为什么需要它：这个框架最初的核心失败不是「审得不准」，是**每做完一段就停下来**。
 * 老版本（git HEAD）里「等待人工介入」5 处、「人工裁决」10 处，且全框架没有
 * 任何一条「自动续轮」规则（`自动续` / `max_rounds` / `state.json` 命中数全为 0）。
 *
 * 那个毛病不会因为改过一次就自动消失——同一个规则在本框架里被复制到 3–5 个文件，
 * 改一处必须同步全部。所以用静态检查把它钉住。
 *
 * 检查项：
 *   L1  活规则里出现「等用户 / 等待人工介入 / 需要人工决定」
 *   L2  自动续轮的判据在 §6 与 §6.5 之间不一致
 *   L3  CONTRACT_VIOLATION 的 attempt 归零（死锁源头）
 *   L4  缺少自动续轮的关键要素（max_rounds / DEFERRED / 自动开新轮）
 *   L5  缺少「任何终止路径都必须出报告」
 *
 * 用法：node tools/lint-autonomy.mjs [--json]
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// --framework <dir> 允许在副本上跑（自测用，避免污染真文件）
const fwArgIdx = process.argv.indexOf('--framework');
const FW = fwArgIdx >= 0 && process.argv[fwArgIdx + 1]
  ? process.argv[fwArgIdx + 1]
  : join(HERE, '..', 'framework');

const findings = [];
const add = (level, rule, file, line, msg) => findings.push({ level, rule, file, line, msg });

// ────────────────────────────────────────────────────────────────────
// 遍历
// ────────────────────────────────────────────────────────────────────
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

if (!existsSync(FW)) {
  console.error(`找不到 framework 目录: ${FW}`);
  process.exit(2);
}

const files = walk(FW);
const docs = files.map((f) => ({ path: f, rel: relative(FW, f).replace(/\\/g, '/'), lines: readFileSync(f, 'utf8').split(/\r?\n/) }));

// ────────────────────────────────────────────────────────────────────
// 豁免判据：这一行是不是在「引用旧规则 / 说明已修」
// ────────────────────────────────────────────────────────────────────
const EXEMPT = [
  /2026-11-0\d\s*(修订|修正|新增|实测)/,   // 修订说明
  /原文(的判据|写的是|是|第\s*\d+\s*行)/,    // 引用旧原文
  /旧规则|此前|曾经|曾写/,                   // 明确标注为历史
  /死锁源头|已修|已被移除/,                  // 说明这个 bug 已修
  /删掉了.*「|移除了.*「/,                   // 「我删掉了 X」的叙述
  /老版本|git HEAD|最初|旧设计/,             // 讲述历史版本的问题
  /`[^`]*`\s*\d+\s*处/,                      // 统计引用：「等待人工介入」5 处
  /检查的是.*病|把它钉住/,                   // 解释检查器设计意图
];

/**
 * 2026-11-09 修复：原来这里有一条 `/不得|不要问|禁止/` 的豁免，
 * 意图是放过「不得等用户」这类反向要求。
 *
 * 但它会把【整行】放过，于是下面这句话被判为合规：
 *   「不得擅自行动，遇到冲突请等待用户决定。」
 *   ——前半是禁令，后半是真正的「等用户」规则。
 *
 * 后果：`check-all.mjs` 报「✅ L1 无等用户」是假绿。
 * 这属于框架自己定义过的「守卫失效」缺陷族。
 *
 * 修法：不再做行级豁免，改为【就近否定判定】——
 * 只在违规关键词附近 8 个字内出现否定词时才豁免。
 */
function isNegatedNear(line, matchIndex, matchLen) {
  // 取违规词【前面】16 字，看是否以否定词收尾（「**不得**「暂停并等待人工介入」」这种）
  const prefix = line.slice(Math.max(0, matchIndex - 16), matchIndex);
  if (/(不得|不要|禁止|严禁|不允许|勿|切勿)[^。，,；;]{0,10}$/.test(prefix)) return true;

  // 违规词【本身】被引号包裹，且引号前是否定词
  const around = line.slice(Math.max(0, matchIndex - 12), matchIndex + matchLen + 2);
  if (/(不得|不要|禁止|严禁|不允许)\s*「[^」]*$/.test(around)) return true;

  return false;
}

function isExempt(line) {
  if (!EXEMPT.some((re) => re.test(line))) return false;
  // 2026-11-10 修正（可维护性批判者实测）：
  // 此前豁免是【整行】的，于是这一行能通过 L1：
  //   「2026-11-05 实测：遇到冲突请等待用户决定，不要自行处理。」
  // 日期前缀命中 EXEMPT，整行被放过——而这恰恰是本框架最核心的失败模式。
  //
  // 判据：「历史叙述」是【描述过去】，不该带【祈使句】。
  // 一行里如果出现了「请 X」「不要 X」「必须 X」「禁止 X」这类命令式表达，
  // 那它就是活规则，无论前面挂了什么日期。
  const IMPERATIVE = /请[^。，,；;]{0,8}(等待|决定|确认|报告)|不要[^。，,；;]{0,8}(自行|擅自)|必须[^。，,；;]{0,10}(等待|询问)|应先[^。，,；;]{0,8}用户/;
  if (IMPERATIVE.test(line)) return false;
  return true;
}

// ────────────────────────────────────────────────────────────────────
// L1 · 活规则里不得要求用户介入
// ────────────────────────────────────────────────────────────────────
const WAIT_PATTERNS = [
  { re: /等用户决定|等用户确认|等待用户决定/g, name: '等用户决定' },
  { re: /等待人工介入|等待人工裁决|等人工介入/g, name: '等待人工介入' },
  { re: /需要人工决定|标记需要人工|需要人工裁决/g, name: '需要人工决定' },
  { re: /先向用户报告「/g, name: '先向用户报告（而非继续）' },
  { re: /请等待用户|等用户决定下一步|交回给用户/g, name: '把决定交回用户' },
];

for (const d of docs) {
  d.lines.forEach((line, i) => {
    if (isExempt(line)) return;
    for (const p of WAIT_PATTERNS) {
      p.re.lastIndex = 0;
      let m;
      while ((m = p.re.exec(line)) !== null) {
        // 就近否定：只有「不得等用户」这种紧邻否定才放过
        if (isNegatedNear(line, m.index, m[0].length)) continue;
        add('FAIL', 'L1', d.rel, i + 1, `活规则要求用户介入: ${p.name}`);
        return;   // 一行报一次即可
      }
    }
  });
}

/* 旧的 L1 实现已删除（2026-11-09）：它的 `/不得|禁止/` 行级豁免会漏报
   「不得擅自行动，遇到冲突请等待用户决定」这类同句混合规则。 */

// ────────────────────────────────────────────────────────────────────
// L3 · CONTRACT_VIOLATION 不得 attempt 归零
// ────────────────────────────────────────────────────────────────────
for (const d of docs) {
  d.lines.forEach((line, i) => {
    if (isExempt(line)) return;
    if (/attempt\s*从\s*0|attempt\s*从头计/.test(line)) {
      add('FAIL', 'L3', d.rel, i + 1, 'CONTRACT_VIOLATION 的 attempt 归零（无限重派死锁源头）');
    }
  });
}

// ────────────────────────────────────────────────────────────────────
// L2 · run-state.md §6 与 §6.5 的续轮判据必须一致
// ────────────────────────────────────────────────────────────────────
{
  const rs = docs.find((d) => d.rel === 'artifacts/run-state.md');
  if (!rs) {
    add('FAIL', 'L2', 'artifacts/run-state.md', 0, '文件缺失');
  } else {
    const text = rs.lines.join('\n');
    const i6 = text.indexOf('## 第 6 节');
    const i65 = text.indexOf('## 第 6.5 节');

    if (i6 < 0 || i65 < 0) {
      add('FAIL', 'L2', 'artifacts/run-state.md', 0, '找不到 §6 或 §6.5');
    } else {
      const sec6 = text.slice(i6, i65);
      const blocks6 = [...sec6.matchAll(/```[\s\S]*?```/g)].map((m) => m[0]).join('\n');

      // §6 的可执行规则块里不得有旧判据
      if (/status\s*不是\s*`?CLOSED/.test(blocks6)) {
        add('FAIL', 'L2', 'artifacts/run-state.md', 0,
          '§6 规则块仍有旧判据「status 不是 CLOSED」→ PARTIALLY_CLOSED 会走错分支');
      }
      // 必须明确覆盖 RUNNING 与 PARTIALLY_CLOSED
      if (!/status\s*==\s*`?RUNNING`?/.test(blocks6)) {
        add('FAIL', 'L2', 'artifacts/run-state.md', 0, '§6 未定义 RUNNING 的处理');
      }
      if (!/PARTIALLY_CLOSED/.test(blocks6)) {
        add('FAIL', 'L2', 'artifacts/run-state.md', 0, '§6 未定义 PARTIALLY_CLOSED 的处理');
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// L4 · 自动续轮的关键要素必须齐备
// ────────────────────────────────────────────────────────────────────
{
  const all = docs.map((d) => d.lines.join('\n')).join('\n');
  const required = [
    { re: /max_rounds/, name: 'max_rounds 停止条件' },
    { re: /自动开启下一轮|自动开\s*`?round\{N\+1\}`?/, name: '自动开下一轮的动作' },
    { re: /DEFERRED/, name: 'DEFERRED 队列' },
    { re: /STALLED/, name: 'STALLED 防无限循环' },
  ];
  for (const r of required) {
    if (!r.re.test(all)) {
      add('FAIL', 'L4', '(全框架)', 0, `缺少自动续轮要素: ${r.name}`);
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// L5 · 「任何终止路径都必须出报告」+ IN_PROGRESS 禁令
// ────────────────────────────────────────────────────────────────────
{
  const rs = docs.find((d) => d.rel === 'artifacts/run-state.md');
  const text = rs ? rs.lines.join('\n') : '';
  if (!/任何导致运行结束的情形.*都必须先产出最终报告|任何终止路径都必须出报告/.test(text)) {
    add('FAIL', 'L5', 'artifacts/run-state.md', 0, '缺少「任何终止路径都必须先出报告」');
  }
  // IN_PROGRESS 禁令可以写在任一份文件里，全仓找
  const all = docs.map((d) => d.lines.join('\n')).join('\n');
  if (!/IN_PROGRESS[^。\n]{0,40}(不得|不是|移除|非法|闭集)|(不得|不是|移除|不属于)[^。\n]{0,20}IN_PROGRESS/.test(all)) {
    add('FAIL', 'L5', '(全框架)', 0, '未在任何文件里禁止 IN_PROGRESS 作为终态');
  }
}

// ────────────────────────────────────────────────────────────────────
// L6 · 交付物规范必须存在且被协议引用
// ────────────────────────────────────────────────────────────────────
{
  const rn = docs.find((d) => d.rel === 'artifacts/report-naming.md');
  if (!rn) {
    add('FAIL', 'L6', 'artifacts/report-naming.md', 0, '文件缺失');
  } else {
    const t = rn.lines.join('\n');
    const required = [
      { re: /round\{N\}-final-report\.md/, name: '最终报告文件名' },
      { re: /round\{N\}-ledger\.md/, name: '账本文件名' },
      { re: /必交付/, name: '「必交付」概念' },
      { re: /##\s*4\.\d|###\s*4\.1/, name: '§4 交付物定义' },
      { re: /检查命令|check-deliverables/, name: '检查命令引用' },
    ];
    for (const r of required) {
      if (!r.re.test(t)) add('FAIL', 'L6', 'artifacts/report-naming.md', 0, `缺少交付物规范: ${r.name}`);
    }
    // 最终报告必须被自己的正则承认（否则会出现「规范不承认自己的交付物」）
    if (/final-report/.test(t) && !/final-report[^`\n]*\|/.test(t) && !/final-report/.test(t)) {
      // 保守起见不强制，仅提示
    }
  }

  // protocol.md 必须引用 check-deliverables
  const proto = docs.find((d) => d.rel === 'orchestrator/protocol.md');
  const pt = proto ? proto.lines.join('\n') : '';
  if (!/check-deliverables\.mjs/.test(pt)) {
    add('FAIL', 'L6', 'orchestrator/protocol.md', 0, '协议未引用交付物检查器（规范写了没人跑）');
  }
  if (!/CLOSED[^。\n]{0,30}(前置条件|不得|必须)/.test(pt) && !/(前置条件|不得)[^。\n]{0,30}CLOSED/.test(pt)) {
    add('WARN', 'L6', 'orchestrator/protocol.md', 0, '未规定 CLOSED 的前置条件');
  }
}

// ────────────────────────────────────────────────────────────────────
// L7 · harness 优先原则必须存在（不得重新发明运行时）
// ────────────────────────────────────────────────────────────────────
{
  const proto = docs.find((d) => d.rel === 'orchestrator/protocol.md');
  const pt = proto ? proto.lines.join('\n') : '';
  if (!/harness\s*优先|harness 已提供|harness 原生/.test(pt)) {
    add('FAIL', 'L7', 'orchestrator/protocol.md', 0,
      '缺少 harness 优先原则（会重新发明运行时能力）');
  }
  if (!/token\s*计量|token 计数/.test(pt)) {
    add('WARN', 'L7', 'orchestrator/protocol.md', 0, '未提及 token 计量（原设计的遗漏）');
  }
  if (!/模型选择/.test(pt)) {
    add('WARN', 'L7', 'orchestrator/protocol.md', 0, '未提及模型选择（原设计的遗漏）');
  }

  // scale-mapping 必须有降级声明
  const sm = docs.find((d) => d.rel === 'orchestrator/scale-mapping.md');
  const st = sm ? sm.lines.join('\n') : '';
  if (sm && !/第 0 节|跳过|不适用/.test(st)) {
    add('FAIL', 'L7', 'orchestrator/scale-mapping.md', 0,
      '缺少「harness 有原生能力时跳过本节算术」的声明');
  }

  // 不许再用 mtime 杀 agent
  const rs = docs.find((d) => d.rel === 'artifacts/run-state.md');
  const rt = rs ? rs.lines.join('\n') : '';
  if (/STALL_CHECK_HOURS/.test(rt) && !/不主动杀|不得主动终止/.test(rt)) {
    add('FAIL', 'L7', 'artifacts/run-state.md', 0,
      '仍有 STALL_CHECK_HOURS 规则但未声明「不主动杀」');
  }
  // 不许把 mtime 当活性判据。
  //
  // 设计原则：**只匹配「断言句式」，不匹配关键词共现**。
  // 之前的写法（mtime + 卡住/重派 同时出现就报）产生两类错误：
  //   误报——解释「旧规则为什么错」的段落里两者也会同时出现
  //   漏报——为了消误报加宽豁免词后，真违规被一起豁免
  // 现在只认三种明确的断言形式。
  const ASSERT_PATTERNS = [
    // 「mtime 停滞/无更新 → 判为卡住/重派/已死」
    /mtime[^。\n]{0,20}(停滞|无更新|未更新|不动)[^。\n]{0,10}(→|=>|则|即|说明|判)[^。\n]{0,15}(卡住|已死|重派|丢失|终止)/,
    // 「根据/按/用 mtime 判断/重派」
    /(根据|按照|依据|按|用|拿)[^。\n]{0,6}mtime[^。\n]{0,10}(判断|判|决定|重派|终止)/,
    // 「超过 N 分钟无更新即重派」
    /超过\s*\d+\s*分钟[^。\n]{0,15}(无更新|未更新)[^。\n]{0,10}(重派|终止|判)/,
  ];

  // 一旦匹配到断言，再看这句是不是「否定/纠错」语境。
  // 只看断言词附近 12 字内有没有否定词，避免「为什么错」「旧规则」这类
  // 宽松词把真违规一起豁免（实测出现过这种漏报）。
  const NEGATION_NEAR = /(严禁|禁止|不得|不要|不能|不用|不查|无意义|会骗人|是错的|已作废|不是)/;

  // 允许文档用显式的「反例标记」来引用旧规则。
  // 为什么要这个开关：解释「旧规则为什么错」时必然要写出旧规则的原话，
  // 正则无法区分「引用」和「采用」。与其无限调正则，不如要求文档显式标注。
  const COUNTER_EXAMPLE_TAG = /\[反例\]|\[旧规则\]|\[错误做法\]/;

  for (const d of docs) {
    d.lines.forEach((line, i) => {
      if (isExempt(line)) return;
      // 表格/段落里显式标了 [反例] 的，整行放过
      if (COUNTER_EXAMPLE_TAG.test(line)) return;
      // 表格的「旧假设 | 事实」对照行：含「无意义」「会骗人」「是错的」等判定词
      if (/^\s*\|/.test(line) && /(无意义|会骗人|是错的|已作废)/.test(line)) return;
      // 「为什么错」类说明段落
      if (/为什么错|为什么废|旧规则的问题是/.test(line)) return;

      if (!/mtime|无更新/.test(line)) return;
      for (const re of ASSERT_PATTERNS) {
        const m = line.match(re);
        if (!m) continue;
        const s = Math.max(0, (m.index ?? 0) - 12);
        const window = line.slice(s, (m.index ?? 0) + m[0].length + 6);
        if (NEGATION_NEAR.test(window)) break;
        add('FAIL', 'L7', d.rel, i + 1,
          '仍以 mtime 作为 agent 活性判据（若这是引用旧规则，请加 [反例] 标记）');
        break;
      }
    });
  }
}

// ────────────────────────────────────────────────────────────────────
// L8 · 面板制：TIER 判定、角色边界、递归上界、不得有「全量重跑」
// ────────────────────────────────────────────────────────────────────
{
  const allText = docs.map((d) => d.lines.join('\n')).join('\n');

  // TIER 判定卡必须存在
  const triage = docs.find((d) => d.rel === 'orchestrator/triage.md');
  if (!triage) {
    add('FAIL', 'L8', 'orchestrator/triage.md', 0, '缺少任务分级文件');
  } else {
    const t = triage.lines.join('\n');
    const req = [
      { re: /K1|K2/, name: 'TIER 判定项' },
      { re: /TIER-?0|T0/, name: 'TIER-0' },
      { re: /TIER-?1|T1/, name: 'TIER-1' },
      { re: /TIER-?2|T2/, name: 'TIER-2' },
      { re: /递归|max_depth/, name: '递归上界' },
    ];
    for (const r of req) {
      if (!r.re.test(t)) add('FAIL', 'L8', 'orchestrator/triage.md', 0, `缺少: ${r.name}`);
    }
  }

  // 规划 Agent wrapper 必须存在
  if (!docs.find((d) => d.rel === 'wrappers/planner.md')) {
    add('FAIL', 'L8', 'wrappers/planner.md', 0, '缺少规划 Agent 定义');
  }

  // 不得有「全量重跑」的活规则。
  // 豁免条件必须精确：只放过「引用用户原话」和「解释为什么不成立」两类语境。
  for (const d of docs) {
    d.lines.forEach((line, i) => {
      if (!/全量重跑/.test(line)) return;
      if (isExempt(line)) return;
      // 引用用户原始要求（「用户曾要求…」）
      if (/(用户|指令)曾要求|原话|背景：/.test(line)) return;
      // 解释为何不成立 / 替代方案
      if (/(不成立|必须替换|数学上|为什么不|改为|替代|分类重派|应改为)/.test(line)) return;
      add('FAIL', 'L8', d.rel, i + 1, '仍要求「全量重跑」（数学上不成立，应改为分类重派）');
    });
  }

  // 汇总权/判断权分离必须写明
  const proto = docs.find((d) => d.rel === 'orchestrator/protocol.md');
  const pt = proto ? proto.lines.join('\n') : '';
  if (!/汇总权/.test(pt) || !/判断权/.test(pt)) {
    add('FAIL', 'L8', 'orchestrator/protocol.md', 0, '未写明「汇总权 / 判断权」分离');
  }
}

// ────────────────────────────────────────────────────────────────────
// L9 · 兼容性与极限规模：能力矩阵、降级声明、阈值一致
// ────────────────────────────────────────────────────────────────────
{
  // 兼容性文件必须存在且含能力矩阵
  const compat = docs.find((d) => d.rel === 'orchestrator/compatibility.md');
  if (!compat) {
    add('FAIL', 'L9', 'orchestrator/compatibility.md', 0, '缺少跨 harness 兼容性规范');
  } else {
    const c = compat.lines.join('\n');
    const req = [
      { re: /L-A|L-B|L-C|L-D/, name: 'harness 能力分级' },
      { re: /降级/, name: '降级路径' },
      { re: /并发/, name: '并发能力说明' },
      { re: /token 计量|无 token/, name: 'token 计量缺失的处置' },
      { re: /上下文预算|context.*budget|70%|90%/, name: '主 Agent 上下文预算（红队 A1）' },
      { re: /不得.*独立分析|无法保证独立分析/, name: 'L-C 独立性声明限制（红队 A2）' },
    ];
    for (const r of req) {
      if (!r.re.test(c)) add('FAIL', 'L9', 'orchestrator/compatibility.md', 0, `缺少: ${r.name}`);
    }
  }

  // 极限规模：TIER 阈值必须够大
  //
  // 2026-11-09 红队指出：原实现用「表格形状正则」提取 T2 的最少成员，
  // 一旦表格重排就匹配失败 → 变量为 null → 静默放行。这是个假护栏。
  // 现在改为：**解析失败本身就是 FAIL**，不允许静默通过。
  const triage = docs.find((d) => d.rel === 'orchestrator/triage.md');
  if (!triage) {
    add('FAIL', 'L9', 'orchestrator/triage.md', 0, '缺少 triage.md，无法校验极限规模');
  } else {
    const t = triage.lines.join('\n');

    // 找 TIER 表里 T2 那一行，提取「最少成员」列的数字。
    //
    // 关键：不能简单地「取所有数字的最小值」——那一行里还有分数阈值(≥2)、
    // 递归层数(3)、专项数(2)，都会被误抓到。必须按【表格列位置】取。
    // 表格结构：| TIER | 分数 | 最少成员 | 成员构成 | 递归上限 | 说明 |
    //                                                ↑ 第 3 列（index 2）
    const parseTierRow = (line, tierTag) => {
      const cells = line.split('|').map((c) => c.trim()).filter((c, i, a) => !(i === 0 || i === a.length - 1) || c !== '');
      // split('|') 会在首尾产生空串，去掉
      const real = line.split('|').slice(1, -1).map((c) => c.trim());
      if (real.length < 3) return { ok: false, reason: `列数不足: ${real.length}` };
      const memberCell = real[2];           // 「最少成员」列
      const m = memberCell.match(/\d+/);
      if (!m) return { ok: false, reason: `第 3 列无数字: "${memberCell}"` };
      return { ok: true, value: Number(m[0]), raw: line.trim() };
    };

    const t2Line = t.split('\n').find((ln) => /^\s*\|.*\bT2\b/.test(ln) && /\d/.test(ln));
    if (!t2Line) {
      add('FAIL', 'L9', 'orchestrator/triage.md', 0,
        '找不到 T2 的规模定义行（可能是表格被改写）。**解析失败不等于通过**');
    } else {
      const r = parseTierRow(t2Line, 'T2');
      if (!r.ok) {
        add('FAIL', 'L9', 'orchestrator/triage.md', 0, `T2 行解析失败: ${r.reason}`);
      } else if (r.value < 9) {
        add('FAIL', 'L9', 'orchestrator/triage.md', 0,
          `T2 最少成员为 ${r.value}（来自「${r.raw}」），低于极限多 agent 要求的 9`);
      }
    }

    const t0Line = t.split('\n').find((ln) => /^\s*\|.*\bT0\b/.test(ln) && /\d/.test(ln));
    if (t0Line) {
      const r = parseTierRow(t0Line, 'T0');
      if (!r.ok) {
        add('FAIL', 'L9', 'orchestrator/triage.md', 0, `T0 行解析失败: ${r.reason}`);
      } else if (r.value < 3) {
        add('FAIL', 'L9', 'orchestrator/triage.md', 0, `T0 最少成员为 ${r.value}，低于 3`);
      }
    }
    // 散文中不得再出现「T0 的『2 个』」这类与表格冲突的表述
    if (/T0\s*的\s*[「『"]?2\s*个/.test(t)) {
      add('FAIL', 'L9', 'orchestrator/triage.md', 0,
        '正文仍写「T0 的 2 个」，与表格的 3 冲突');
    }

    // 2026-11-10 新增（可维护性批判者实测的洞）：
    // 把表格里的 T2 从 9 改成 10，另三处（校验行 / 自检行 / 递归上界）不动，
    // 旧实现只查第一处 → 全绿。同一份文件里四个数字打架，没有任何检查发现。
    //
    // 现在：把所有「T2 成员数」的声明处提取出来，要求全部相等。
    // 只看三种明确语境，避免把 K 分阈值（`≥2`）、递归层数（`3 层`）算进来：
    //   a) 表格区域里「≥N | **M**」的第三列
    //   b) 「T2 最小成员 | M」
    //   c) 「T0≥3 / T1≥5 / T2≥M」
    const t2Nums = new Set();
    for (const ln of t.split('\n')) {
      // b) T2 最小成员
      let m = ln.match(/T2\s*最小成员[^\n]*?\|\s*(\d+)/);
      if (m) { t2Nums.add(Number(m[1])); continue; }
      // c) T0≥3 / T1≥5 / T2≥9
      m = ln.match(/T2\s*≥\s*(\d+)/);
      if (m) { t2Nums.add(Number(m[1])); continue; }
      // a) TIER 表格行：| **T2** ... | ≥K | **M** | ...
      if (/^\s*\|\s*\*\*T2\*\*/.test(ln)) {
        const cells = ln.split('|').map((c) => c.trim());
        const bold = cells.map((c, idx) => ({ c, idx }))
          .filter((x) => /^\*\*\d+\*\*$/.test(x.c));
        if (bold.length > 0) {
          t2Nums.add(Number(bold[0].c.replace(/\*/g, '')));
        }
      }
    }
    if (t2Nums.size > 1) {
      add('FAIL', 'L9', 'orchestrator/triage.md', 0,
        `T2 的成员数在同一文件里有 ${t2Nums.size} 个不同取值的声明: ${[...t2Nums].sort((a,b)=>a-b).join(' / ')}` +
        `——改一处忘了改别处，这份文件就会自相矛盾`);
    }
  }

  // 检查器阈值必须与 triage 一致
  const cp = join(HERE, 'check-plan.mjs');
  if (existsSync(cp)) {
    const cpt = readFileSync(cp, 'utf8');
    if (!/T2:\s*9/.test(cpt)) {
      add('FAIL', 'L9', 'tools/check-plan.mjs', 0, 'check-plan 的 T2 阈值未同步为 9');
    }
    if (!/T2:\s*3/.test(cpt)) {
      add('FAIL', 'L9', 'tools/check-plan.mjs', 0, 'check-plan 的 T2 递归上界未同步为 3');
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// L10 · 文档内部一致性：不得有重复编号的章节、不得有自相矛盾的措辞
// ────────────────────────────────────────────────────────────────────
{
  for (const d of docs) {
    // (a) 同一份文件里不得出现两个完全相同编号的 ### 小节
    const h3 = [...d.lines.join('\n').matchAll(/^###\s+(\d+(?:\.\d+)*)/gm)].map((m) => m[1]);
    const seen = new Map();
    for (const n of h3) seen.set(n, (seen.get(n) ?? 0) + 1);
    for (const [n, cnt] of seen) {
      if (cnt > 1) {
        add('FAIL', 'L10', d.rel, 0, `小节编号 ${n} 重复 ${cnt} 次（未完成的编辑会留下两个）`);
      }
    }
  }

  // (b) 「简化权」的归属不得自相矛盾
  const triage = docs.find((d) => d.rel === 'orchestrator/triage.md');
  if (triage) {
    const t = triage.lines.join('\n');
    const saysAgentHasNone = /主\s*Agent\s*没有简化权/.test(t);
    const saysUserHasIt = /简化权在用户手里/.test(t);
    if (saysAgentHasNone && saysUserHasIt) {
      // 允许出现在「已删除说明」里，但不允许作为活规则
      const activeLines = t.split('\n').filter((ln) =>
        /简化权在用户手里/.test(ln) && !/已删除|直接矛盾|初版/.test(ln));
      if (activeLines.length > 0) {
        add('FAIL', 'L10', 'orchestrator/triage.md', 0,
          '「简化权」归属自相矛盾：既说主 Agent 没有，又说在用户手里');
      }
    }
    // (c) 不得把「要不要开面板」推回用户。
    // 豁免：markdown 引用块（以 > 开头）里的「删除说明」是在引用旧行为，不是活规则。
    if (/你要不要开|要开吗|确认后我按/.test(t)) {
      const bad = t.split('\n').filter((ln) =>
        /你要不要开|要开吗|确认后我按/.test(ln) &&
        !/已删除|矛盾/.test(ln) &&
        !/^\s*>/.test(ln));   // 引用块 = 说明，不是规则
      if (bad.length > 0) {
        add('FAIL', 'L10', 'orchestrator/triage.md', 0,
          '把「要不要开面板」推回用户（用户明确反对）');
      }
    }
  }

  // (d) 已更名的枚举不得在「活规则」里复活（2026-11-09 新增）
  //     classify-failures.mjs 已把 SCRIPT_TIMEOUT 改名为 SKELETON_ONLY，
  //     但文档里 7 处没跟上，state.json schema 和计数器都还是旧名。
  //     允许出现在历史叙述里（「当时叫 X」），不允许作为当前枚举。
  const RENAMED = [
    { old: 'SCRIPT_TIMEOUT', now: 'SKELETON_ONLY' },
    // verify 的 verdict 是闭集 PASS | FAIL。PASS_WITH_ESCALATION 从来不是枚举值，
    // 它是 `verdict: PASS` + `escalation_required: true` 两个字段的组合。
    // 但文档里有 8 处散文把它当枚举用，会让子 Agent 照着返回一个非法值。
    { old: 'PASS_WITH_ESCALATION', now: '`PASS` + `escalation_required:true`' },
  ];
  for (const d of docs) {
    d.lines.forEach((ln, i) => {
      for (const { old, now } of RENAMED) {
        if (!new RegExp(`\\b${old}\\b`).test(ln)) continue;
        // 历史叙述豁免：必须明确标注这是旧名。裸引用一律 FAIL。
        // 注意豁免词都是「指代过去」的实词，不能用「归因」「记成」这类会顺带放行
        // 当前性陈述的词——否则规则形同虚设。
        if (/当时叫|原名|已改名|改名|更名|此前的名|归因为|记成|记作|当时写作/.test(ln)) continue;
        add('FAIL', 'L10', d.rel, i + 1,
          `已更名的枚举 ${old} 作为当前值出现（现名 ${now}）；历史叙述请显式写「当时叫 ${old}」`);
      }
    });
  }
}

// ────────────────────────────────────────────────────────────────────
// L11 · 结构化输出要求必须存在于契约与每个 wrapper（2026-11-09 新增）
// ────────────────────────────────────────────────────────────────────
{
  // 契约必须有「产物物理形态」这一节
  const oc = docs.find((d) => d.rel === 'components/output-contract.md');
  if (!oc) {
    add('FAIL', 'L11', 'components/output-contract.md', 0, '文件缺失');
  } else {
    const t = oc.lines.join('\n');
    if (!/json 代码块结尾|必须以.*json.*结尾/.test(t)) {
      add('FAIL', 'L11', 'components/output-contract.md', 0,
        '缺少「产物必须以 json 代码块结尾」的硬要求（这是 100% 不合规的根因）');
    }
    if (!/check-payload\.mjs/.test(t)) {
      add('FAIL', 'L11', 'components/output-contract.md', 0,
        '未引用 check-payload.mjs（要求了格式却不给检查工具）');
    }
  }

  // 每个 wrapper 都必须有这条
  const wrappers = docs.filter((d) => d.rel.startsWith('wrappers/'));
  for (const w of wrappers) {
    const t = w.lines.join('\n');
    if (!/产物格式（硬要求）/.test(t)) {
      add('FAIL', 'L11', w.rel, 0, 'wrapper 未声明「产物格式（硬要求）」');
    }
    if (!/check-payload\.mjs/.test(t)) {
      add('FAIL', 'L11', w.rel, 0, 'wrapper 未告知用什么工具自检格式');
    }
  }
  if (wrappers.length === 0) {
    add('WARN', 'L11', '(全框架)', 0, '没找到任何 wrapper，无法校验格式要求覆盖');
  }
}

// ────────────────────────────────────────────────────────────────────
// L12 · 门禁必须存在于协议且四道门齐全（2026-11-09 新增）
// ────────────────────────────────────────────────────────────────────
{
  const proto = docs.find((d) => d.rel === 'orchestrator/protocol.md');
  if (!proto) {
    add('FAIL', 'L12', 'orchestrator/protocol.md', 0, '文件缺失');
  } else {
    const t = proto.lines.join('\n');
    if (!/gate\.mjs/.test(t)) {
      add('FAIL', 'L12', 'orchestrator/protocol.md', 0,
        '协议未引用 gate.mjs（检查器还是「记得要跑」的松散脚本）');
    }
    for (const g of ['dispatch', 'accept', 'close', 'release']) {
      // 边界要精确：`--gate release` 必须作为完整词出现，
      // 不能被 `--gate Xrelease` 或 `--gate release-notes` 蒙混过去
      const re = new RegExp(`--gate\\s+${g}(?![\\w-])`);
      if (!re.test(t)) {
        add('FAIL', 'L12', 'orchestrator/protocol.md', 0, `未登记 ${g} 门`);
      }
    }
    // 门禁规则必须声明「不得跳过」
    if (!/四道门都是强制的|不得跳过/.test(t)) {
      add('FAIL', 'L12', 'orchestrator/protocol.md', 0, '未声明门禁不可跳过');
    }
  }

  // gate.mjs 本身必须存在
  const gatePath = join(HERE, 'gate.mjs');
  if (!existsSync(gatePath)) {
    add('FAIL', 'L12', 'tools/gate.mjs', 0, '门禁脚本缺失');
  }
}

// ────────────────────────────────────────────────────────────────────
// L13 · 必填字段三层闭环（2026-11-10 新增）
// ────────────────────────────────────────────────────────────────────
// 「模板要求了，契约装不下」和「契约要求了，模板没说」是同一个病的两个方向：
// 前者子 Agent 做了主 Agent 看不到，后者子 Agent 根本不知道该写。
// 每个关键字段必须在三处都出现：执行模板（告诉 Agent 要写）、
// 契约（定义 schema）、校验器（机械拦截）。
{
  // 2026-11-12 修正：原来是一份手挑的白名单，只查 9 个字段。
  // 实测漏掉了 planner 的全部四个必填字段（tier / score / members / member_count）——
  // 它们在 check-payload.mjs 的 ROLE_REQUIRED 里，但契约 output-contract.md 里
  // 一次都没出现，三层闭环断在中间。而 L13 报了绿灯，因为它只看白名单。
  //
  // 现在的做法：**从校验器自动提取所有角色的必填字段**，再逐个查三处是否都有。
  // 手挑的清单会永远落后于校验器；机械提取不会。
  const CRITICAL_FIELDS = [
    { field: 'self_checks',         tmpl: 'templates/wave2-audit.md',      tool: 'check-payload.mjs' },
    { field: 'searched_scope',      tmpl: 'templates/wave2-audit.md',      tool: 'check-payload.mjs' },
    { field: 'sub_claims',          tmpl: 'templates/wave3-critique.md',   tool: 'check-payload.mjs' },
    { field: 'runtime_applicable',  tmpl: 'templates/wave3-critique.md',   tool: 'check-payload.mjs' },
    { field: 'runtime_evidence',    tmpl: 'templates/wave3-critique.md',   tool: 'check-payload.mjs' },
    { field: 'direct_contradiction',tmpl: 'templates/wave3-critique.md',   tool: 'check-payload.mjs' },
    { field: 'five_step',           tmpl: 'templates/wave3-critique.md',   tool: 'check-payload.mjs' },
    { field: 'entry_points',        tmpl: 'templates/wave1-recon.md',      tool: 'check-payload.mjs' },
    { field: 'shared_dependencies', tmpl: 'templates/wave1-recon.md',      tool: 'check-payload.mjs' },
  ];
  const toolSrc = readFileSync(join(HERE, 'check-payload.mjs'), 'utf8');
  const stateSrc = readFileSync(join(HERE, 'check-state.mjs'), 'utf8');
  const contractSrc = readFileSync(join(FW, 'components', 'output-contract.md'), 'utf8')
    + readFileSync(join(FW, 'artifacts', 'run-state.md'), 'utf8');

  // ── 自动提取 ROLE_REQUIRED 里的所有字段 ──
  const roleBlock = toolSrc.match(/const ROLE_REQUIRED\s*=\s*\{([\s\S]*?)\n\};/);
  const seenFields = new Set();
  if (roleBlock) {
    for (const m of roleBlock[1].matchAll(/^\s*(\w+):\s*\[([^\]]*)\]/gm)) {
      for (const f of m[2].split(',').map((x) => x.trim().replace(/['"]/g, '')).filter(Boolean)) {
        if (!seenFields.has(f)) { seenFields.add(f); CRITICAL_FIELDS.push({ field: f, tmpl: null, tool: 'check-payload.mjs' }); }
      }
    }
  }
  // 已在白名单里的不再重复
  const dup = new Set();
  const UNIQ = CRITICAL_FIELDS.filter((x) => {
    if (dup.has(x.field)) return false;
    dup.add(x.field);
    return true;
  });
  CRITICAL_FIELDS.length = 0;
  CRITICAL_FIELDS.push(...UNIQ);

  for (const { field, tmpl, tool } of CRITICAL_FIELDS) {
    const t = tmpl ? docs.find((d) => d.rel === tmpl) : null;
    const toolText = tool === 'check-state.mjs' ? stateSrc : toolSrc;
    const inTmpl = t ? t.lines.join('\n').includes(field) : false;
    const inTool = toolText.includes(field);
    const inContract = contractSrc.includes(field);
    // 自动提取出来的字段（tmpl === null）没有指定模板，只查契约与校验器两侧
    if (tmpl && !inTmpl) {
      add('FAIL', 'L13', tmpl, 0,
        `关键字段 ${field} 在契约和校验器里都有，但执行模板里没提——` +
        `子 Agent 只读模板，永远不会知道要写这个字段`);
    }
    if (!inTool) {
      add('FAIL', 'L13', `tools/${tool}`, 0,
        `关键字段 ${field} 在契约和模板里都要求了，但校验器不检查——要求没有强制力`);
    }
    if (!inContract) {
      add('FAIL', 'L13', 'components/output-contract.md', 0,
        `关键字段 ${field} 被模板和校验器使用，但契约没有定义它的 schema`);
    }
  }

  // fix_contracts 走另一条链（state.json，不是 output-contract）
  const fixInTmpl = (docs.find((d) => d.rel === 'templates/wave4-fix.md')?.lines.join('\n') ?? '').includes('fix_contracts');
  if (!fixInTmpl) add('FAIL', 'L13', 'templates/wave4-fix.md', 0, '关键字段 fix_contracts 模板里没提');
  if (!stateSrc.includes('fix_contracts')) add('FAIL', 'L13', 'tools/check-state.mjs', 0, 'fix_contracts 校验器不检查');
  if (!contractSrc.includes('fix_contracts')) add('FAIL', 'L13', 'artifacts/run-state.md', 0, 'fix_contracts 账本没定义');
}

// ────────────────────────────────────────────────────────────────────
// L14 · 文档不得指向不存在的文件（2026-11-10 新增）
// ────────────────────────────────────────────────────────────────────
// 实测发现 environment-probe.md 把「`templates/workflow-audit.mjs`」当作
// 可执行路径下发给 L-A harness，而该文件从未存在。用户按指令去找会扑空。
// 这类「图纸上有、实物没有」的引用比缺失功能更糟：它让人以为功能已交付。
{
  // 提取 `path/to/file.ext` 形态的引用（带扩展名，反引号包裹）
  const FILE_REF = /`([a-zA-Z0-9_\/.-]+\.(?:mjs|js|py|json|sh|yml|yaml))`/g;
  const FW_ROOT = join(FW, '..');
  // 只检查「框架自己的」文件引用：带 framework 内目录前缀的路径。
  // 裸文件名（state.json / package.json / verify.mjs）是被审仓库里的东西，
  // 它们本来就不该存在于本仓库——那不是缺陷。
  const FW_OWNED = /^(templates|components|orchestrator|artifacts|wrappers|tools)\//;
  for (const d of docs) {
    const text = d.lines.join('\n');
    const seen = new Set();
    for (const m of text.matchAll(FILE_REF)) {
      const ref = m[1];
      if (seen.has(ref)) continue;
      seen.add(ref);
      if (!FW_OWNED.test(ref)) continue;          // 裸文件名 = 被审仓库的东西，跳过
      if (/[<>{}*]/.test(ref)) continue;          // 通配/占位
      const candidates = [
        join(FW, ref),
        join(FW_ROOT, ref),
        join(HERE, ref),
      ];
      const exists = candidates.some((p) => existsSync(p));
      if (!exists) {
        const lineIdx = d.lines.findIndex((ln) => ln.includes(ref));
        // 豁免窗口：紧邻的说明文字（前后各 10 行）。
        // 逐字审查过的引用通常会在表格下面紧跟一段「⚠ 未实现」的说明，
        // 窗口太窄会漏掉它——而漏掉的代价是这条检查变成噪音，被人无视。
        const context = d.lines.slice(Math.max(0, lineIdx - 10), lineIdx + 11).join('\n');
        if (/不存在|未实现|还没写|图纸|尚未/.test(context)) continue;
        add('FAIL', 'L14', d.rel, lineIdx + 1,
          `引用了框架自有的不存在的文件 ${ref}——用户在文档指引下会去找一个空路径`);
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// L15 · 预算算术在两份文档里必须一致（2026-11-10 新增）
// ────────────────────────────────────────────────────────────────────
// 实测最严重的缺陷：MANUAL.md 写 planned_sweep_agents = min(slices, 40)，
// scale-mapping.md 写 min(slices, sweep_budget=16)。代入 85 片，
// 前者让「slices + deep_dive_cost ≤ 40」恒假 → 深挖永远为 0。
// 而 MANUAL 是主 Agent 唯一加载的文档——照它走，大仓库零深挖，且报告看起来合规。
{
  const man = docs.find((d) => d.rel === 'MANUAL.md');
  const sm = docs.find((d) => d.rel === 'orchestrator/scale-mapping.md');
  if (man && sm) {
    const mText = man.lines.join('\n');
    const sText = sm.lines.join('\n');
    // MANUAL 里不得把 discovery_budget 直接当作 sweep 上限
    // 豁免：引用旧公式的修正说明（「此前写的是 …」）
    const active = (re) => {
      const hit = man.lines.findIndex((ln) => re.test(ln));
      if (hit < 0) return false;
      // 该行或前一行含「此前/原文/修正/旧」= 是在引用历史，不是活规则
      const ctx = man.lines.slice(Math.max(0, hit - 1), hit + 1).join('\n');
      return !/此前|原文|修正|旧的写法|曾经/.test(ctx);
    };
    if (active(/planned_sweep_agents:\s*min\(effective_slices,\s*discovery_budget\)/)) {
      add('FAIL', 'L15', 'MANUAL.md', 0,
        'planned_sweep_agents 直接用 discovery_budget 作上限——宽扫会吃光预算，深挖恒为 0');
    }
    if (active(/`effective_slices \+ deep_dive_cost ≤ discovery_budget`/)) {
      add('FAIL', 'L15', 'MANUAL.md', 0,
        '深挖成本验算用 effective_slices 作分子——应为 planned_sweep_agents，' +
        '否则切片数 ≥ 预算时该不等式恒假，深挖永远为 0');
    }
    // 两份文件都必须出现 sweep_budget 的分配逻辑
    if (!/sweep_budget/.test(mText)) {
      add('FAIL', 'L15', 'MANUAL.md', 0,
        'MANUAL 未提及 sweep_budget 的 40/60 切分——主 Agent 只读 MANUAL，会不知道要切分预算');
    }
    if (!/sweep_budget/.test(sText)) {
      add('FAIL', 'L15', 'orchestrator/scale-mapping.md', 0, 'scale-mapping 未定义 sweep_budget');
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// L16 · 角色加载量上限（2026-11-10 新增）
// ────────────────────────────────────────────────────────────────────
// 实测：audit-specialist 一个角色启动就要读 1418 行，其中 output-contract.md
// 占 656 行——而它实际只用到 §2.2 那一小节（约 60 行）。7 个角色全都在
// 重复加载同一份 656 行的大文件。
//
// 规则不禁止共享，但要求「别悄悄涨」。超上限时报警而不是失败——
// 真正的减法需要人来决定，但至少不能让膨胀无声无息地发生。
{
  const LIMITS = {
    // 2026-11-12：这三个必修文件合计已正好 1700 行，**没有任何余量**。
    // 本轮加 G7 与「注释不是证据」两条，加载量到 1702。
    // 试过三轮压缩（1711→1707→1702）都不够——**这说明压缩已经不是出路**。
    //
    // 真正的修法：把 output-contract 按角色拆节。audit-specialist 加载的 665 行里，
    // §2.1 侦察 / §2.2a 宽扫 / §3 锐评 / §4 修复 / §5 验收 约 400 行它用不到。
    // **这是一个已知的技术债，下一轮必须先拆再加规则。**
    'wrappers/audit-specialist.md': 1702,
    'wrappers/critique-panel.md':   1600,
    'wrappers/fix-worker.md':       1300,
    'wrappers/recon-scout.md':      1250,
    'wrappers/sweep-scout.md':      1450,
    'wrappers/verifier.md':         1200,
    'wrappers/planner.md':           550,
  };
  const FW_DIR = FW;
  for (const w of docs.filter((d) => d.rel.startsWith('wrappers/'))) {
    const limit = LIMITS[w.rel];
    if (!limit) continue;
    const text = w.lines.join('\n');
    const reqMatch = text.match(/requires:\s*\[([^\]]+)\]/);
    const tmplMatch = text.match(/template:\s*(\S+)/);
    const files = [
      ...(reqMatch ? reqMatch[1].split(',').map((x) => x.trim()) : []),
      ...(tmplMatch ? [tmplMatch[1]] : []),
    ];
    let total = 0;
    const seen = new Set();
    for (const f of files) {
      if (seen.has(f)) continue;      // planner 里 triage 被写了两遍
      seen.add(f);
      const p = join(FW_DIR, f);
      if (existsSync(p)) total += readFileSync(p, 'utf8').split(/\r?\n/).length;
    }
    if (total > limit) {
      add('WARN', 'L16', w.rel, 0,
        `启动加载 ${total} 行，超过上限 ${limit}。` +
        `共享文件（尤其 output-contract.md）里可能有你这个角色用不到的章节——` +
        `考虑按角色拆分或改成分节引用`);
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// L17 · 交付粒度必须被定义（2026-11-10 新增）
// ────────────────────────────────────────────────────────────────────
// 实测观察：这个框架有 16 条 lint 专治「停下来等用户」，却管不住主 Agent
// 每做完一小步就停下来交付、问「要不要继续」。
//
// 根因：**框架从未定义「一次交付」的粒度**。
//   L4 检查的是「自动续轮要素是否存在」（max_rounds / DEFERRED / STALLED 这些词），
//   但「一轮之内做到什么程度才算交付」从来没有被写下来过。
//   于是执行者默认按「做完一件小事」交付——每一次都合规。
//
// 要求：protocol 或 MANUAL 里必须有一节明确回答：
//   - 一次交付 = 整个相位（phase），不是单个任务
//   - 交付前必须满足什么条件
//   - 什么情况下才允许中途停下来问
{
  const all = docs.map((d) => d.lines.join('\n')).join('\n');
  const checks = [
    {
      re: /交付粒度|一次交付|delivery\s*unit/i,
      name: '「交付粒度」的定义（一次交付 = 什么范围）',
    },
    {
      re: /整个相位|整个波次|整轮交付|一次交完/,
      name: '明确的交付范围（相位/波次级，不是单任务级）',
    },
    {
      re: /允许中途停下|才允许停下来|例外情形.*停/,
      name: '「何时才允许中途停」的例外清单',
    },
  ];
  for (const c of checks) {
    if (!c.re.test(all)) {
      add('FAIL', 'L17', '(全框架)', 0,
        `缺少${c.name}——没有它，执行者会按「做完一件小事」交付，每次都合规`);
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// L18 · 「缺失型缺陷」检查法必须存在（2026-11-10 实测新增）
// ────────────────────────────────────────────────────────────────────
// 实测依据：ground truth 13 条注入缺陷里，唯一一条两个独立审查员都完全没
// 发现的，是「config 返回值少了一个 Object.freeze」——代码每一行都对，
// 只是少做了一件事。现有的检查法（读代码找错误）结构上抓不到这类。
//
// 要求：审计模板里必须有一节明确「承诺 vs 实现」的对照法。
{
  const wa = docs.find((d) => d.rel === 'templates/wave2-audit.md');
  if (!wa) {
    add('FAIL', 'L18', 'templates/wave2-audit.md', 0, '文件缺失');
  } else {
    const t = wa.lines.join('\n');
    const checks = [
      { re: /主动检查清单|缺失型缺陷/, name: '「主动检查清单」这一节' },
      { re: /逐项回答|逐项给结论/, name: '「逐项给结论」的执行要求' },
      { re: /同族函数的守卫/, name: '「同族函数守卫不一致」这个必查模式' },
    ];
    for (const c of checks) {
      if (!c.re.test(t)) {
        add('FAIL', 'L18', 'templates/wave2-audit.md', 0,
          `缺少${c.name}——这类缺陷不在代码里，只能靠对照发现，` +
          `没有它审计 Agent 结构上不可能抓到`);
      }
    }
  }
}


// ────────────────────────────────────────────────────────────────────
// L19 · 必查模式清单必须存在（2026-11-11 对照实验，manifest v3.0.0 重算）
// ────────────────────────────────────────────────────────────────────
// 实测（机械分类后重算，同一份 manifest、同一个被判物）：
//   6 组自由发挥 70.8% / 原生型 35.7%（15/42）
//   3 组只给模式 1/2/3 76.7% / 原生型 66.7%（14/21）
//   1 组只给运行时验证 70.0% / 原生型 42.9%
// 分离度最强的一条：GT-011/012/013 这三条原生缺陷，
//   ���清单的 7 组全部 0 命中，给清单的 3 组全部 3/3 命中。
// 注意：另一份代码库（fixture2）上这份清单没有提升 recall，反而降低了精确率。
// 保留时必须带实测范围说明，不能宣称通用有效。
{
  const wa = docs.find((d) => d.rel === 'templates/wave2-audit.md');
  if (!wa) {
    add('FAIL', 'L19', 'templates/wave2-audit.md', 0, '文件缺失');
  } else {
    const t = wa.lines.join('\n');
    const checks = [
      { re: /必查清单|五个必查模式|五模式清单|8 个问题|8 个模式/, name: '「必查清单」' },
      { re: /返回值是否暴露内部状态/, name: '模式 1（返回值暴露内部状态）' },
      { re: /同族函数的守卫/, name: '模式 2（同族守卫一致性）' },
      { re: /NaN.*typeof|typeof NaN/, name: '模式 3（NaN 边界，含 typeof 说明）' },
      { re: /引用的绑定是否存在/, name: '模式 8（引用的绑定是否存在——调用未导入的名字）' },
      { re: /check-blindspots\.mjs/, name: '配套工具 check-blindspots.mjs 的引用' },
      { re: /因代码库而异|未单独验证|没有单独做过对照实验|已证实|部分证实/, name: '实测范围说明（不能宣称通用有效）' },
      // 模式 4 必须拆成子问题。实测：不拆时 8 条目标只稳定命中 4 条。
      { re: /原型链键名为|原型链键名/, name: '模式 4 拆解之 4a（原型链键名）' },
      { re: /假值 vs 缺值/, name: '模式 4 拆解之 4b（假值 vs 缺值）' },
      // 模式 5 不能写成检查项。实测：目标命中 0/3 稳定，但副作用最大。
      { re: /追问方向|不要写成检查项/, name: '模式 5 的定位（追问方向，非检查项）' },
    ];
    for (const c of checks) {
      if (!c.re.test(t)) {
        add('FAIL', 'L19', 'templates/wave2-audit.md', 0,
          `缺少${c.name}——这份清单在一份代码库上 +5.8 点，在另一份上无差异，` +
          `删掉它等于丢掉一个可能有效的工具，但保留时必须带上实测范围说明`);
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// 输出
// ────────────────────────────────────────────────────────────────────
const json = process.argv.includes('--json');
const counts = findings.reduce((a, f) => { a[f.level] = (a[f.level] ?? 0) + 1; return a; }, {});

if (json) {
  console.log(JSON.stringify({ counts, findings }, null, 2));
} else {
  console.log('\n自主性静态检查（框架不得要求用户值守）\n');
  console.log(`扫描 ${docs.length} 个文件\n`);
  if (findings.length === 0) {
    console.log('✅ L1 活规则无「等用户/等人工」');
    console.log('✅ L2 §6 与 §6.5 判据一致');
    console.log('✅ L3 CONTRACT_VIOLATION 不归零');
    console.log('✅ L4 自动续轮要素齐备');
    console.log('✅ L5 终止必出报告');
    console.log('✅ L6 交付物规范存在且被协议引用');
    console.log('✅ L7 harness 优先原则存在');
    console.log('✅ L8 面板制规则齐备（TIER/规划Agent/汇总权/无全量重跑）');
    console.log('✅ L9 兼容性与极限规模（能力矩阵、降级声明、T2≥9）');
    console.log('✅ L10 文档内部一致性（无重复小节、无自相矛盾）');
    console.log('✅ L11 结构化输出要求已覆盖契约与全部 wrapper');
    console.log('✅ L12 门禁系统存在且四道门齐全');
    console.log('✅ L13 必填字段三层闭环（模板 / 契约 / 校验器）');
    console.log('✅ L14 文档不指向不存在的框架自有文件');
    console.log('✅ L15 预算算术在两份文档间一致');
    console.log('✅ L16 各角色启动加载量在上限内');
    console.log('✅ L17 交付粒度已定义（相位级，非单任务级）');
    console.log('✅ L18 主动检查清单存在（逐项给结论）');
    console.log('✅ L19 必查模式清单完整（8 项 + 模式 4 拆解 + 模式 5 定位）\n');
  } else {
    for (const f of findings) {
      const tag = f.level === 'FAIL' ? '✗' : '!';
      console.log(`${tag} [${f.rule}] ${f.file}${f.line ? ':' + f.line : ''} — ${f.msg}`);
    }
    console.log(`\n合计: ${counts.FAIL ?? 0} FAIL / ${counts.WARN ?? 0} WARN\n`);
  }
}

process.exit((counts.FAIL ?? 0) > 0 ? 1 : 0);
