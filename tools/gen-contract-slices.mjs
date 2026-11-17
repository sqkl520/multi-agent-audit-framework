// 生成按角色拆分的契约文件：framework/components/output-contract/<role>.md
//
// 背景：L16 反复报「planner 启动要加载 951 行，上限 550」，根因是它只用到契约的
// §2.0（37 行），却被迫加载整个 703 行——其余 6 个角色的分支它完全用不到。
// L16 的注释自己写过「压缩不是出路，真正的修法是按角色拆节」。
//
// 这个脚本不删任何内容，只是把同一份契约按角色裁出**该角色需要的节**：
//   通用节  §0 物理形态 / §1 信封 / §3 错误对象 / §4 机械检查清单 / §5 状态转换
//   角色节  该角色自己那一节（如 planner 只取 §2.0）
//
// 产物是被生成物，不要手改——改母文件后重跑本脚本。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 用脚本自身位置定位仓库根，不要用 cwd：测试会在临时目录里跑这个脚本的副本，
// 用相对路径会去读临时目录下的 framework/（不存在）。
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const SRC = join(ROOT, 'framework/components/output-contract.md');
const OUT_DIR = join(ROOT, 'framework/components/output-contract');
// 统一行尾为 LF 再切分。
//
// 为什么必须显式做：Windows 的 checkout 可能把母文件写成 CRLF。按 /\r?\n/ 切分时
// 每行末尾会留下 \r，重新拼回来的产物就是 CRLF——而仓库里存的是 LF。
// 于是「重跑生成器」与「已提交产物」逐字节不等，幂等性测试在 Windows 上失败、
// 在 Linux 上通过。CI 实测正是如此（Linux 三个 job 全绿，Windows 唯一 job 红）。
const src = readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
const lines = src.split('\n');

// ── 按标题切块 ──
function findIndex(re) {
  return lines.findIndex((l) => re.test(l));
}

const marks = {
  head: 0,
  s0: findIndex(/^## 第 0 节/),
  s1: findIndex(/^## 第 1 节/),
  s2: findIndex(/^## 第 2 节/),
  s20: findIndex(/^#### 2\.0 /),
  s21: findIndex(/^#### 2\.1 /),
  s22a: findIndex(/^#### 2\.2a /),
  s22: findIndex(/^#### 2\.2 /),
  s23: findIndex(/^#### 2\.3 /),
  s24: findIndex(/^#### 2\.4 /),
  s25: findIndex(/^#### 2\.5 /),
  s3: findIndex(/^## 第 3 节/),
  s4: findIndex(/^## 第 4 节/),
  s5: findIndex(/^## 第 5 节/),
  s6: findIndex(/^## 第 6 节/),
  ref: findIndex(/^## 参考来源/),
};

const missing = Object.entries(marks).filter(([, v]) => v < 0).map(([k]) => k);
if (missing.length) {
  console.error('找不到这些小节的起始行:', missing.join(', '));
  process.exit(2);
}

const slice = (a, b) => lines.slice(a, b).join('\n');

// 通用部分：文件头 + §0 + §1；尾部：§3 §4 §5 §6 参考
// 文件头里的 `# components/output-contract.md` 和 frontmatter 的 `file:` 指向母文件，
// 在切片里必须换成切片自己的路径——否则读者按那个路径去找，读到的是 703 行的完整版，
// 而不是他手上这份（这属于「自称与实际不符」，比缺内容更容易误导）。
const headPartRaw = slice(marks.head, marks.s2);
const headPart = headPartRaw
  .replace(/^# components\/output-contract\.md$/m, '__SELF_PATH__')
  .replace(/^file: components\/output-contract\.md$/m, '__SELF_FILE__')
  .replace(/^> output-contract\.md$/m, '> __SELF_NAME__');

const tailPart = slice(marks.s3, lines.length);

// 第 2 节导语：切片只保留一个角色分支，但**必须带上父节标题和导语**。
// 否则 #### 2.0 会直接跟在 #### 顶层字段 后面，读的人不知道它属于哪一节，
// 也看不到「payload 用 oneOf 按 role 分支」这个前提。
// 导语 = 从「## 第 2 节」标题到第一个 #### 子节之间的内容。
const section2Intro = slice(marks.s2, marks.s20);

// 角色 → 它自己的那一段（含紧随的下一个标题之前）
const ROLE_SECTION = {
  planner: [marks.s20, marks.s21],
  recon: [marks.s21, marks.s22a],
  sweep: [marks.s22a, marks.s22],
  audit: [marks.s22, marks.s23],
  critique: [marks.s23, marks.s24],
  fix: [marks.s24, marks.s25],
  verify: [marks.s25, marks.s3],
};

mkdirSync(OUT_DIR, { recursive: true });

const banner = (role) => `<!--
  自动生成，请勿手改。母文件：framework/components/output-contract.md
  重跑：node tools/gen-contract-slices.mjs
  本文件 = 母文件的通用节 + ${role} 角色那一节，其它角色的分支已裁掉。
-->

`;

let total = 0;
for (const [role, [a, b]] of Object.entries(ROLE_SECTION)) {
  const selfPath = `components/output-contract/${role}.md`;
  const head = headPart
    .replace('__SELF_PATH__', `# ${selfPath}`)
    .replace('__SELF_FILE__', `file: ${selfPath}`)
    .replace('__SELF_NAME__', `${role}.md（output-contract 的 ${role} 角色切片）`);

  const body = banner(role) + head + '\n' + section2Intro + '\n' + slice(a, b) + '\n' + tailPart;
  const p = join(OUT_DIR, `${role}.md`);
  writeFileSync(p, body);
  const n = body.split(/\r?\n/).length;
  total += n;
  console.log(`${role.padEnd(10)} ${String(n).padStart(4)} 行  → ${p}`);
}

console.log(`\n母文件 ${lines.length} 行；拆出 ${Object.keys(ROLE_SECTION).length} 份，合计 ${total} 行`);
console.log('每个角色只加载自己那份，省掉的是其它 6 个角色的分支。');
