#!/usr/bin/env node
/**
 * check-all.mjs — 一条命令跑完全部机械检查
 *
 * 存在的理由：框架有 4 个检查器，分散调用必然会漏跑一个。
 * 而「漏跑一个」在这套框架里已经造成过真实损失——
 * 改一处规则没同步另外三处副本，导致「等待人工」的旧规则一直活着。
 *
 * 用法：node tools/check-all.mjs
 * 退出码：0 全绿 / 1 有失败
 */

import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));

const CHECKS = [
  {
    name: '产物机械校验（门 0 / 产物真实性 / 账本对账）',
    script: 'verify-artifacts.test.mjs',
    desc: '自测：含编造引用、空产物、数字不符、注释当证据',
  },
  {
    name: '自动续轮规则模拟',
    script: 'simulate-round-chain.mjs',
    desc: '用例：多轮推进、max_rounds、STALLED、§6/§6.5 一致性',
  },
  {
    name: '失败分类器',
    script: 'classify-failures.test.mjs',
    desc: '用例：NO_OUTPUT / SCRIPT_TIMEOUT / EMPTY_RESULT 及各自的重派策略',
  },
  {
    name: '交付物规范检查',
    script: 'check-deliverables.test.mjs',
    desc: '用例：两类必交付、报告六节、账本四节、自由命名、子目录',
  },
  {
    name: '环境探测器',
    script: 'detect-harness.test.mjs',
    desc: '用例：版本比较、unknown 不猜值、探测脚本可执行',
  },
  {
    name: '契约准入检查器',
    script: 'check-payload.test.mjs',
    desc: '用例：JSON 信封、顶层字段、角色必填、计数自洽、空 findings、空 quote（事前门，非事后补救）',
  },
  {
    name: '门 0 伪造手法逐条对照（红队）',
    script: 'fixtures/gate0-probe/run.mjs',
    desc: '10 个探针：跨行拼接 / 引错函数 / 行号偏 1 / 注释当证据 / 引注释作被审对象',
  },
  {
    name: 'Agent 间一致性计算器',
    script: 'consistency.mjs',
    desc: '用例：Jaccard、随机基线、理论上限、达成度（防止把「报告大」当成「有共识」）',
  },
  {
    name: '声明范围可伪造性对照（红队）',
    script: 'fixtures/scope-probe/run.mjs',
    desc: '4 个探针：声称读 N 个文件却只有 1 个有 quote / 诚实标注应当放行',
  },
  {
    name: '契约判据逐条对照（红队）',
    script: 'fixtures/contract-probe/run.mjs',
    desc: '19 个探针：契约里每条「CONTRACT_VIOLATION」都造一份违反它的产物，看校验器是否执行',
  },
  {
    name: 'state.json 校验器',
    script: 'check-state.test.mjs',
    desc: '用例：枚举、FAILED 诊断、DONE 产物、attempt、budget、CLOSED 联动',
  },
  {
    name: 'attempt 计数器',
    script: 'attempt-ledger.test.mjs',
    desc: '用例：digest 对 agent_id 不敏感、连续同因即停、上限即停',
  },
  {
    name: '门禁系统',
    script: 'gate.test.mjs',
    desc: '用例：四道门的放行与拒绝路径（dispatch/accept/close/release）',
  },
  {
    name: 'Wrapper 完整性（结构 + 关键段落 + tools 权限）',
    script: 'check-wrapper-integrity.mjs',
    // 2026-11-14 修：此前只有 script、没有 args，于是总检跑的是「不含基线对比」的版本，
    // 永远是绿的——而 5 份 wrapper 的行数低于基线这件事，在唯一会自动跑的地方完全不可见。
    // 这正是 CHECKOUT-INCIDENT 那次的翻版：检查器写对了，只是没接上线。
    // 基线的 5 条不足是已知未闭合项（见 START-HERE 缺陷表），它在脚本内是 WARN 级，
    // 所以接上之后总检仍然全绿，但**报告里会列出这 5 条**。
    args: ['--baseline', 'fixtures/wrapper-baseline.json'],
    desc: '7 个文件：必备小节齐全 / 每节非空 / Write 权限 / 交叉引用存在 / 行数基线对比',
  },
  {
    name: '框架自主性静态检查',
    script: 'lint-autonomy.test.mjs',
    desc: '19 条规则的放行与拒绝路径（含 L16 加载量、L19 模式清单完整性）',
  },
  {
    name: '盲区模式检测器',
    script: 'check-blindspots.test.mjs',
    desc: '用例：B1 返回活引用 / B2 同类守卫差异 / B3 缺 isFinite / B4 调用未导入的名字',
  },
  {
    name: '承诺兑现检查器',
    script: 'check-promises.test.mjs',
    desc: '用例：@returns 无 return / @throws 不抛错 / 声称只读却返回可变对象',
  },
  {
    name: '子 Agent 结局扫描（转录大小 ≠ 工作痕迹 / 通知会丢）',
    script: 'scan-agent-outcomes.mjs',
    desc: '用例：转录空但有文件（WORKED_SILENTLY）/ 未知必须报 UNKNOWN / 有产出但没收到通知（WORKED_BUT_NOT_NOTIFIED）',
  },
  {
    name: 'Agent 状态判定（产物 vs 活动痕迹）',
    script: 'agent-status.test.mjs',
    desc: '用例：产物已落盘判 DONE / 只有活动痕迹判 RUNNING / 久无动静判 STALLED / 传目录必须拒绝',
  },
  {
    name: 'Stop hook 相位守卫',
    script: 'stop-hook.test.mjs',
    desc: '用例：相位未闭合时拒绝结束回合',
  },
  {
    name: 'dsh session 闭环检查（子 agent 产出是否被父级消费）',
    script: 'dsh-session-audit.test.mjs',
    desc: '用例：父级漏收 settle / 子 agent 空产出 / finish.reason 可读 / 孤儿 session',
  },
  {
    name: 'Wrapper 契约字段覆盖（必填字段是否写进产物规格）',
    script: 'check-wrapper-contract.test.mjs',
    desc: '用例：字段缺失 / 只顺带一提 / §5 模板算不算 / 子标题之后 / 字段表漂移',
  },
  {
    name: 'Wrapper 完整性检查器自测（表格与合计是否一致）',
    script: 'check-wrapper-integrity.test.mjs',
    desc: '用例：小节缺失 / 只剩标题 / 基线不足时报告不得自相矛盾',
  },
  {
    name: '契约切片完整性（拆节后各角色字段是否还在）',
    script: 'check-contract-slices.test.mjs',
    desc: '用例：缺必填字段 / 缺通用节 / 孤儿切片 / 切片缺失 / 生成器幂等',
  },
  {
    name: '契约切片保真度（拆分是否无损）',
    script: 'check-contract-slice-fidelity.test.mjs',
    desc: '用例：切片丢字段 / 结构变化须拒绝执行 / 父标题 / 自述路径 / 自动生成标注',
  },
  {
    name: '契约示例可用性（照抄示例能否通过校验器）',
    script: 'check-contract-examples.test.mjs',
    desc: '用例：示例被破坏 / 缺文件 / 目录不见 / role 不匹配 / 缺必填字段 / 占位路径不随 cwd 变',
  },
  {
    name: '枚举跨层一致性（契约 / wrapper / 示例 vs 校验器闭集）',
    script: 'check-enum-consistency.test.mjs',
    desc: '用例：文档多写 NONE / 少写 GENERATED / 示例用非法值 / 布尔枚举不得误报',
  },
  {
    name: 'GT 缺陷的模式归属（哪些缺陷结构上查不到）',
    script: 'check-pattern-coverage.test.mjs',
    desc: '用例：pattern 悬空 / none 无理由 / none 关键词须搜不到 / 引用不存在的模式 / 两个 fixture 都要查',
  },
  {
    name: '发现去向对账（每条发现是否都被表态过一次）',
    // 注意：这里注册的是 **.test.mjs 自测**，不是对真实交付物跑对账。
    //
    // check-all 是「框架自检」——它验证校验器本身在合成 fixture 上行为正确；
    // 它不知道也不该知道某次审计的产物在哪、去向表叫什么。
    //
    // 真正校验交付物要在收口时手动跑，并把它当作 close 门的必过项：
    //   node tools/check-disposition-coverage.mjs \
    //     --artifacts <审计产物目录> --ledger <发现去向表.md> [--strict-high]
    // 加 --strict-high 会把「HIGH 被 DEFERRED」从 WARN 升级为 FAIL，
    // 交付闸门应当开启，否则「全填 DEFERRED」即可判绿。
    script: 'check-disposition-coverage.test.mjs',
    desc: '用例：漏 1 条点名 / 产物内 id 重复 / 去向表杜撰 / 少理由 / HIGH 被 DEFERRED 警告 / 去向表缺失 exit 2',
  },
  {
    name: '修复实例对账（UPHELD 是否都进入了修复登记）',
    // 同样注册 **.test.mjs 自测**，理由与上一条相同：check-all 是框架自检，
    // 它不知道某次审计的 state.json 与 final-report.md 在哪。
    //
    // 收口时应把它当作 close 门的必过项手动跑：
    //   node tools/check-fix-instances.mjs \
    //     --state <state.json> --report <final-report.md> [--strict]
    //
    // 为什么它必须单独存在（而不是并进 check-disposition-coverage）：
    // 去向表对的是「每条发现有没有表态」，本检查器对的是「裁决为 UPHELD 的发现
    // 有没有真的被派发」。前者可以全填 DEFERRED 过关，后者要求 state.json 与
    // 最终报告的裁决索引表（外部基准）逐条对齐——这是 R5 §5.1 指出的
    // 「两个自述互相对账不产生外部约束力」的唯一解法。
    script: 'check-fix-instances.test.mjs',
    desc: '用例：UPHELD 少登记点名 / 修了 DOWNGRADED 警告 / 杜撰 id / 无申报合并 / 合并集合不等 / spawned 缺失按 0 / 审计路径跳过',
  },
];

let failed = 0;
console.log('\n══════════════════════════════════════════');
console.log('  框架机械检查（全部）');
console.log('══════════════════════════════════════════\n');

for (const c of CHECKS) {
  const p = join(HERE, c.script);
  if (!existsSync(p)) {
    console.log(`✗ ${c.name}\n  脚本缺失: ${c.script}\n`);
    failed++;
    continue;
  }
  process.stdout.write(`${c.name}\n  ${c.desc}\n  → `);
  try {
    const out = execFileSync('node', [p, ...(c.args ?? [])], { encoding: 'utf8', cwd: HERE });
    const last = out.trim().split('\n').filter(Boolean).pop() ?? '';
    console.log(`${last || 'OK'}`);
  } catch (e) {
    const out = (e.stdout ?? '') + (e.stderr ?? '');
    const lines = out.trim().split('\n').filter(Boolean);
    // 2026-11-12：只打印「失败」无法区分「测试真的失败」和「进程被信号杀掉 / 超时 / 输出超限」。
    // 实测 attempt-ledger 单独跑 15/15 通过，但在 check-all 里偶发判失败——
    // 没有退出码和信号信息，根本没法判断是哪一种。
    const sig = e.signal ? ` signal=${e.signal}` : '';
    const code = e.status != null ? ` exit=${e.status}` : '';
    console.log(`失败${code}${sig}`);
    if (lines.length) for (const l of lines.slice(-8)) console.log(`    ${l}`);
    else console.log(`    （没有任何输出——进程可能被杀或超时）`);
    failed++;
  }
}

console.log('\n──────────────────────────────────────────');
if (failed === 0) {
  console.log('✅ 全部通过\n');
} else {
  console.log(`✗ ${failed} 项失败\n`);
}
process.exit(failed > 0 ? 1 : 0);
