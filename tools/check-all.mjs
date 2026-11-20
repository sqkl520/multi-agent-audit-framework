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
  {
    name: '契约规则句 → 机器出口对账（有多少「必须/不得」没人读）',
    // 仪表，不是闸门：默认只报告，存量无出口的规则句不判 FAIL。
    // 2026-11-17 实测：1084 条规则句 / 97 条有出口 / 出口率 8.9%。
    // 一道上线首日就红出 987 条的闸门会被立刻关掉，然后连带把真的能用的检查一起拖下水，
    // 所以这里只注册自测；真正拦新增要用 --gate --since <ref>，且只对新增规则句生效。
    script: 'check-rule-ledger.test.mjs',
    desc: '用例：存量不判 / 点名脚本算出口 / 点名真实 rule 名算出口 / DISCRETIONARY 须带理由 / 代码块不算 / --gate 只拦新增 / 分母为 0 须 exit2 / 非 git 须 exit2 / 退化基准',
  },
  {
    name: '规则出口数退化检测（有出口的规则句是否变少了）',
    // 2026-11-20 补：这个套件跑的是**本体**不是自测，而且是 check-all 里
    // 少数几个真的读取 framework/ 现状的检查之一。
    //
    // 为什么必须注册本体：`--fail-on-regress` 从写下那天起就是死代码
    //（判据 `noExit > totalSentences - totalWithExit` 恒为 false），
    // 因为没人跑它，坏了 3 个月也没人发现。现在它读持久化基准，接进总检
    // 之后至少每次 CI 都会执行一次「有出口的规则句有没有变少」。
    //
    // 它不判存量无出口（那是仪表），只判**相对基线的退化**。
    script: 'check-rule-ledger.mjs',
    args: ['--fail-on-regress', '--quiet'],
    desc: '有出口的规则句数低于 tools/fixtures/rule-ledger-baseline.json 即 FAIL',
  },
  {
    name: '规则 → 契约落点（校验器比契约严吗）',
    // 2026-11-19 补：这个框架反复出同一个 bug —— 校验器在执行的规则，
    // 契约里没写。audit.md:180 记过原话「校验器比契约严，结果是子 Agent 照契约写
    // 会被判违规，且修法提示指向一段不存在的规范」。
    //
    // 判据必须三层（实测出来的）：只认规则名会误报 71 条，
    // 加英文字段名降到 16 条，加中文短语才降到 4 条真实水平。
    script: 'check-rule-doc-link.test.mjs',
    desc: '用例：规则名命中 / 英文字段命中 / 中文短语命中 / 三样都没有必须报 / field 行字段要扫到 / 测试文件不计入 / 分母为0须exit2',
  },
  {
    name: '轮次探测（round_id 是怎么算出来的）',
    // 2026-11-19 补：round-detection.md 把探测规则写成了完全可判定的形式
    // （正则 / 大小写 / 前导零 / 上限 / 后缀 / 边界表），自己还写着「不含任何主观判断」，
    // 但 grep -rl round-detection tools/*.mjs 是 0 —— 这份规格零校验。
    // check-deliverables.mjs 虽用 round{N} 这个形状，却只做字符串拼接。
    //
    // 代价：轮次号算错会静默复用已审过的轮次。框架历史里 round31 就卡过这件事。
    script: 'check-round-detection.test.mjs',
    desc: '用例：13 条匹配模式 / 5 条计算 / 异常分类 / 空目录 / 目录不存在 / 非目录阻塞 / 无参数 exit2 / 可疑值不回退',
  },
  {
    name: 'Resume Packet 校验（波次间传递格式）',
    // 2026-11-19 补：handoff-schema.md 定义了 7 个必填字段、3 套枚举、10 种 open_items.kind，
    // 并写着「缺失时行为：拒绝整个包」「违反视为 CONTRACT_VIOLATION」——
    // 但此前 grep 不到任何校验器。这份契约的每一条约束从写下那天起就没被执行过。
    // 这是「根本没有检测器」，比「引用断了」更彻底。
    script: 'check-handoff.test.mjs',
    desc: '用例：合规通过 / 缺必填 / 版本错 / wave_id 错 / wave_status 错 / kind 非法 / 塞原始正文 / round_id 形态 / 10 种 kind 全合法 / 非 JSON / 空目录 exit2',
  },
  {
    name: '术语一致性（同一个概念是否只有一个写法）',
    // 与 lint-autonomy 同源：那个钉「同一条规则被复制到多处而不同步」，
    // 这个钉「同一个概念有多个名字」。
    // 2026-11-19 实测：「子 Agent」这个概念有 4 种写法共 328 处（子Agent 197 / 子 Agent 101 /
    // subagent 22 / 子 agent 2）。不是文字洁癖——模板写「派子 Agent」而工具名是 `subagent`，
    // agent 要在脑内做一次映射，没有任何地方要求它做。
    //
    // 注意 `accepted` 字段：英文 `subagent` 与 `Gate 0` 是合法写法（需要与工具名/
    // 英文资料精确对齐时用），不能判违规——否则合法写法被误伤，人会直接关掉这道检查。
    script: 'lint-terminology.test.mjs',
    desc: '用例：规范写法通过 / 变体报错 / accepted 不误伤 / 代码块不参与 / 模板覆盖 WARN / 分母为0须exit2',
  },
  {
    name: '修复后快照一致性（事后补拍有没有补漏）',
    // 注册 **.test.mjs 自测**，理由同上。
    //
    // 收口时应手动跑一次真实核对：
    //   node tools/verify-postfix-snapshot.mjs \
    //     --repo <被审仓库> --snapshot experiments/<run>/repair-work/post-fix \
    //     [--exclude repair-artifacts/]
    //
    // 为什么需要它：`post-fix/` 是**事后补拍**的源码快照。事后补拍有一个共同的
    // 失效模式——补漏了没人发现。2026-11-15 第一次补拍就漏了 7 个文件
    // （4 个被改的测试类 + 3 个新增测试类），是人工逐行比对 `git status` 才发现的。
    // 这个校验器把那次人工比对变成机械检查：仓库的每一条改动都必须在快照里有同名
    // 且逐字节相同的文件。
    //
    // 一时间想到的替代方案是「相信补拍的人看全了 `git status`」——那正是失效的那一次。
    script: 'verify-postfix-snapshot.test.mjs',
    desc: '用例：漏补点名 / 快照过期内容不同 / 多余文件仅 WARN / 空快照 exit 2 / 未跟踪目录展开 / --exclude 不误伤源码',
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
