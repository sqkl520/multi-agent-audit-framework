#!/usr/bin/env node
/**
 * dsh-run-guard.mjs — dsh 跑完之后，检查「派出去的活有没有真的落盘」
 *
 * ── 为什么需要（2026-11-20 实测）────────────────────────────────────
 *
 * 用 dsh 0.2.1-rc.2 原生跑了一次完整审计。第 1 次运行：
 * 侦察 + 26 份宽扫完成后，主 Agent 派了 4 个深挖 Agent，然后输出「End turn」。
 * **父进程随即退出**，4 份深挖产物全部丢失
 *（子 Agent 在 21:25–21:29 还在写入，父进程 21:30 已终止）。
 *
 * 根因是机械的，`stop-hook.mjs` 文件头写过同一件事：
 *   Agent 循环的退出条件是「本轮回复里没有 tool call」。
 *   「我已完成 X，接下来做 Y」这段话天然没有 tool call，写出来就交差了。
 *
 * Claude Code 有 Stop hook 能在这一刻拦住；**dsh 没有**。
 * 于是同一套提示词在 dsh 上会静默丢掉已经派出去、已经花掉 token 的那部分工作。
 *
 * ── 它做什么 ────────────────────────────────────────────────────────
 *
 * 对一次 dsh 运行的产物目录做四个机械判定：
 *
 *   R1 派发数与落盘数      state.json 记的 spawned_agents vs 实际产物文件数
 *   R2 骨架残留           产物里仍有「尚未开始 / TODO / 待填 / 收尾时填」等占位符
 *   R3 相位缺失           报告声称走完了流程，但锐评/修复波一份产物都没有
 *   R4 会话层漏收         调 dsh-session-audit.mjs，看有没有 parent_missed_child
 *
 * 每一条都对应一类**静默丢工作**。它们不会让产品报错，只会让结果少一块。
 *
 * 用法：
 *   node dsh-run-guard.mjs --artifacts <产物目录> [--state <state.json>]
 *                          [--sessions <~/.dsh/sessions>] [--project <子目录名>]
 *                          [--json] [--strict]
 *
 * 退出码：0 = 全部通过   1 = 有 FAIL   2 = 用法错误
 *         --strict 时 WARN 也算 FAIL
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));

const ARG = { artifacts: null, state: null, sessions: null, project: null, json: false, strict: false };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--artifacts') ARG.artifacts = process.argv[++i];
  else if (a === '--state') ARG.state = process.argv[++i];
  else if (a === '--sessions') ARG.sessions = process.argv[++i];
  else if (a === '--project') ARG.project = process.argv[++i];
  else if (a === '--json') ARG.json = true;
  else if (a === '--strict') ARG.strict = true;
  else if (a === '--help' || a === '-h') {
    console.log('用法: node dsh-run-guard.mjs --artifacts <目录> [--state <state.json>]'
      + ' [--sessions <目录>] [--project <名>] [--json] [--strict]');
    process.exit(0);
  } else { console.error(`未知参数: ${a}`); process.exit(2); }
}

if (!ARG.artifacts) {
  console.error('必须给 --artifacts <产物目录>。没有产物目录就无从判断「丢了什么」');
  process.exit(2);
}
if (!existsSync(ARG.artifacts)) {
  console.error(`产物目录不存在: ${ARG.artifacts}`);
  process.exit(2);
}

const results = [];
const add = (level, id, msg, detail) => results.push({ level, id, msg, detail: detail ?? null });

// ── 收集产物 ──
const files = readdirSync(ARG.artifacts).filter((f) => {
  try { return statSync(join(ARG.artifacts, f)).isFile(); } catch { return false; }
});
const mdFiles = files.filter((f) => f.endsWith('.md'));

if (mdFiles.length === 0) {
  console.error(`[预期失败] ${ARG.artifacts} 里一个 .md 都没有——分母为 0 不等于通过`);
  process.exit(2);
}

// ── R1 · 派发数 vs 落盘数 ──
//
// state.json 的 ledger.spawned_agents 记的是「实际已派发数（含重派）」。
// 如果它比产物文件数大，说明派出去的实例里有一些**没写出东西就消失了**。
//
// 注意口径：重派会让 spawned > 产物数，这是正常的。所以只在**差额较大**时报，
// 且判 WARN —— 精确的「哪几个丢了」要 R4 的会话层信息才能定位。
const statePath = ARG.state ?? join(ARG.artifacts, 'state.json');
if (existsSync(statePath)) {
  let st = null;
  try { st = JSON.parse(readFileSync(statePath, 'utf8')); } catch { /* 下面统一报 */ }
  if (!st) {
    add('WARN', 'R1', `state.json 解析失败: ${statePath}`);
  } else {
    const ledger = st.ledger ?? {};
    const spawned = Number(ledger.spawned_agents ?? NaN);
    // 产物文件里排除交付物（report / ledger），它们不是「一个 agent 的产物」
    const artifactLike = mdFiles.filter((f) => !/-(final-report|ledger)\.md$/.test(f));
    if (Number.isFinite(spawned) && spawned > 0) {
      if (artifactLike.length === 0) {
        add('FAIL', 'R1', `state.json 记了派出 ${spawned} 个 agent，但产物目录里 0 份产物——`
          + '派出去的活全部没落盘');
      } else if (spawned > artifactLike.length * 1.5) {
        add('WARN', 'R1', `派出 ${spawned} 个 agent，产物只有 ${artifactLike.length} 份`
          + `（差额可能来自重派，也可能是丢失；用 R4 定位）`);
      } else {
        add('PASS', 'R1', `派出 ${spawned} 个 agent，产物 ${artifactLike.length} 份，差额在重派可解释范围内`);
      }
    } else {
      add('SKIP', 'R1', 'state.json 里没有 ledger.spawned_agents，无法做派发数对账');
    }
  }
} else {
  add('SKIP', 'R1', `找不到 ${statePath}，跳过派发数对账`);
}

// ── R2 · 骨架残留 ──
//
// 实测：slice-20/21/22 中途出现过「尚未开始」的骨架产物。
// 骨架被当成交付物是最坏的一类——它**看起来有产物**，内容却是空的。
//
// 2026-11-20 修正：不能只看出不出现占位符。
// 锐评 Agent 会**引用**别的产物里的占位符（「该报告同时含未填占位符
// （`:15`「（收尾时填）」）」），那是正确的审计行为，不是骨架。
// 判据要区分「自己是骨架」与「在说别人是骨架」：
//   - 占位符出现在**引用块**（> 开头）或**行内引号/反引号包裹**里 → 是在引用，不算
//   - 占位符出现在普通正文里 → 是骨架
const PLACEHOLDER = /（收尾时填）|（收尾填）|（锐评后填）|（待填）|（待补）|尚未开始|未开始|TODO:|TBD\b/;

// 2026-11-22 修：占位符出现在**整行**才可能是骨架。
//
// 实测误报：round1-02-sweep-slice-03.md 有 12KB 正文、status=COMPLETE、
// 8 条 leads，只因为「## Leads」小节下写了一行「（尚未开始）」就被判成骨架
// ——而真实数据在文末的 JSON 信封里。那份产物是完整的。
//
// 收紧后：只有**整行去掉空白后就是一个占位符**才算。
// 句子里带占位符（"（尚未开始）的检查项"）不算。
const LINE_ONLY = /^\s*[（(]?(收尾时填|收尾填|锐评后填|待填|待补|尚未开始|未开始|TODO|TBD)[）)]?\s*$/i;
const skeleton = [];
for (const f of mdFiles) {
  const lines = readFileSync(join(ARG.artifacts, f), 'utf8').split('\n');
  let hit = null;
  for (const raw of lines) {
    if (!LINE_ONLY.test(raw)) continue;
    // 引用块：整行以 > 开头 → 是在引用别人的产物，不算
    if (/^\s*>/.test(raw)) continue;
    hit = raw.trim();
    break;
  }
  if (hit) skeleton.push({ file: f, hit });
}
if (skeleton.length > 0) {
  const shown = skeleton.slice(0, 5).map((s) => `${s.file}（${s.hit}）`).join('、');
  add('FAIL', 'R2', `${skeleton.length} 份产物含未填占位符：${shown}`
    + `${skeleton.length > 5 ? ' …' : ''}——**骨架不是交付物**（引用他人产物的占位符不计）`, { files: skeleton });
} else {
  add('PASS', 'R2', `${mdFiles.length} 份产物均无未填占位符（引用他人产物里的占位符已排除）`);
}

// ── R3 · 相位缺失 ──
//
// 报告声称走完五波，但某些相位的产物一份都没有。
// 实测第 2 次运行：4 份深挖 + 1 份报告，**锐评波一份都没有**，
// 而报告的 §A 裁决索引表写的是「（锐评后填）」。
const PHASES = [
  { id: '01-recon', name: '侦察', required: true },
  { id: '02-sweep', name: '宽扫', required: true },
  { id: '02-audit', name: '深挖', required: false },
  { id: '03-critique', name: '锐评', required: true },
  { id: '04-fix', name: '修复', required: false },
  { id: '05-verify', name: '验收', required: false },
];
// 修复/验收是可选路径（README 已说明：修复从默认路径移出）。
// 但**锐评是默认路径的第三波**，没有它 = 所有发现都未经攻击，
// 报告里的「确认」二字就没有依据。
const missingRequired = [];
const phaseCount = {};
for (const p of PHASES) {
  const n = mdFiles.filter((f) => f.includes(p.id)).length;
  phaseCount[p.id] = n;
  if (p.required && n === 0) missingRequired.push(p.name);
}
if (missingRequired.length > 0) {
  add('FAIL', 'R3', `必需相位没有任何产物: ${missingRequired.join('、')}——`
    + '**报告若声称走完流程，这些相位必须补跑；若没跑，「已确认」的措辞必须降级为「未锐评」**',
  { phaseCount });
} else {
  add('PASS', 'R3', `必需相位齐全：${Object.entries(phaseCount).filter(([, n]) => n > 0).map(([k, n]) => `${k}×${n}`).join(' ')}`);
}

// ── R4 · 会话层漏收 ──
//
// 调 dsh-session-audit.mjs，看有没有 parent_missed_child。
// 这是**唯一能定位「哪几个子 agent 的产出没被父级看到」的机械手段**。
if (ARG.sessions && existsSync(ARG.sessions)) {
  const auditScript = join(HERE, 'dsh-session-audit.mjs');
  if (!existsSync(auditScript)) {
    add('SKIP', 'R4', '找不到 dsh-session-audit.mjs，跳过会话层检查');
  } else {
    const args = [auditScript, '--sessions', ARG.sessions];
    if (ARG.project) args.push('--project', ARG.project);
    let out = '', code = 0;
    try {
      out = execFileSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    } catch (e) {
      code = e.status ?? 1;
      out = (e.stdout ?? '') + (e.stderr ?? '');
    }
    const missed = (out.match(/parent_missed_child/g) ?? []).length;
    if (missed > 0) {
      add('FAIL', 'R4', `会话层有 ${missed} 个子 agent「有产出但父级没收到 settle 注入」。`
        + '**这些产出可能已经丢了，或父级基于旧状态做了决策**');
    } else if (code === 0) {
      add('PASS', 'R4', '会话层无 parent_missed_child');
    } else {
      add('WARN', 'R4', '会话审计有其它问题（见 dsh-session-audit.mjs 输出）');
    }
  }
} else {
  add('SKIP', 'R4', '未给 --sessions，跳过会话层检查');
}

// ── 输出 ──
const fails = results.filter((r) => r.level === 'FAIL');
const warns = results.filter((r) => r.level === 'WARN');
const ok = fails.length === 0 && (!ARG.strict || warns.length === 0);

if (ARG.json) {
  console.log(JSON.stringify({ ok, results, phaseCount }, null, 2));
  process.exit(ok ? 0 : 1);
}

console.log('\ndsh 运行守卫（派出去的活有没有真的落盘）\n');
for (const r of results) {
  const tag = { FAIL: '✗ FAIL', WARN: '! WARN', PASS: '✓ PASS', SKIP: '- SKIP' }[r.level];
  console.log(`${tag}  [${r.id}] ${r.msg}`);
}
console.log(`\n合计: ${fails.length} FAIL / ${warns.length} WARN / ${results.filter((r) => r.level === 'PASS').length} PASS`);
console.log('');
process.exit(ok ? 0 : 1);
