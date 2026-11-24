#!/usr/bin/env node
/**
 * check-fixture-portability.mjs — 被跟踪的夹具里有没有写死本机路径
 *
 * ── 为什么需要（2026-11-24 实测）────────────────────────────────────
 *
 * `tools/fixtures/contract-probe/probe/*.md` 里有 18 份产物的
 * `artifact_path` 是这样写的：
 *
 *     "artifact_path": "D:\\Projects\\AI prompt\\...\\probe\\A1-good-audit.md"
 *
 * 生成器 `gen.mjs` 当时图省事，直接把本机绝对路径写了进去。后果：
 *
 *   Windows（建库那台机器）  19 个用例，19 个符合契约
 *   Linux / WSL / CI         19 个用例，17 个符合契约
 *
 * 两个「期望通过」的对照组（A1 完全合规、S4 sweep 允许空 leads）
 * 在 Linux 上被判 `artifact_not_found` 拦截。**同一份夹具，两台机器两种结论。**
 *
 * 更糟的是没人发现：`contract-probe/run.mjs` 结尾写着 `process.exit(0)`，
 * 于是 CI 上稳定打印「2 个不符」，check-all 照样全绿。这张对照表在 Linux
 * 上红了多久，取决于谁恰好看过那行输出。
 *
 * ── 判据 ────────────────────────────────────────────────────────────
 *
 *   扫描 git 跟踪的 `tools/fixtures/**` 下的文本文件，报出三类：
 *
 *     F1  Windows 盘符绝对路径     `D:\...` / `C:/...`
 *     F2  POSIX 绝对路径            `/mnt/...` / `/home/...` / `/Users/...`
 *     F3  `<FRAMEWORK_ROOT>` 占位   这是**按设计**允许的写法，只统计不报错
 *
 *   行尾注释里出现的路径不报——`gen.mjs` 里「原先写的是 D:\Projects\...」
 *   这种历史说明是有价值的，不该被这条检查赶走。只检查 **JSON 字符串值**
 *   与 **.mjs 源码里非注释行**。
 *
 * ── 不检查什么 ──────────────────────────────────────────────────────
 *
 *   - `experiments/` 下的历史报告：它们是当时的快照，写实机路径是记录的一部分
 *   - `//` 与 `/* *\/` 注释内容
 *   - 文档（.md）正文：这条检查只对夹具，不对文档
 *
 * 用法：node check-fixture-portability.mjs [--json]
 * 退出码：0 干净 / 1 有写死路径 / 2 配置错误（一份夹具都没扫到）
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const jsonOut = process.argv.includes('--json');

// JSON 里的反斜杠是双写的（`D:\\Projects`），所以分隔符要允许连写；
// 但后面必须跟至少 3 个非引号字符 —— 这条把 `{n:\"x\"}` 这种误报挡掉。
const WIN_ABS = /[A-Za-z]:[\\/]+[^"'\s,]{3,}/;
const POSIX_ABS = /\/(mnt|home|Users|root|opt)\/[^"'\s,]{2,}/;

// `real-artifacts/` 是一份**真实跑出来的**审计产物，留作 wrapper 有效性分析的
// 原始记录（`experiments/WRAPPER-EFFECTIVENESS.md:138` 引用了它）。
// 里面的路径是当时 agent 实际执行命令的输出，属于证据：改它等于篡改记录，
// 和 `experiments/` 一样排除。
const RECORD_DIRS = ['tools/fixtures/real-artifacts/'];

/** git 跟踪的夹具文件（用 git 而不是遍历磁盘：未跟踪的生成物不该算） */
function trackedFixtures() {
  let out;
  try {
    // stderr 丢弃：自测里有一条故意在非 git 目录跑（验 exit 2），
    // git 会往 stderr 打 "fatal: not a git repository"——预期行为，不是噪声源的锅，
    // 但让它进 check-all 的输出只会让人以为出了事。
    out = execFileSync('git', ['ls-files', 'tools/fixtures'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
  } catch {
    return null; // 不是 git 仓库（例如自测的临时目录）→ 由调用方报 exit 2
  }
  return out.split('\n').filter(Boolean);
}

/** 去掉 .mjs 的行注释与块注释，保留 JSON 文本原样 */
function stripComments(src) {
  // 只剥 // 行注释与 /* */ 块注释中的「说明性路径」。
  // 不用正则做完整词法分析——这里只需要「注释里的路径不触发」，宁可漏判。
  const lines = src.split('\n');
  return lines.map((l) => {
    const i = l.indexOf('//');
    // 注意：JSON 里 `http://` 会出现 //，但夹具里不写 URL；保守起见只在
    // 行首空白之后是 // 时整行丢弃。
    if (/^\s*\/\//.test(l)) return '';
    return l;
  }).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
}

const files = trackedFixtures();
if (files === null) {
  if (jsonOut) console.log(JSON.stringify({ ok: false, error: 'not_a_git_repo' }, null, 2));
  else console.log('✗ 不是 git 仓库，无法确定哪些夹具被跟踪');
  process.exit(2);
}

const problems = [];
const placeholders = [];
let scanned = 0;

for (const rel of files) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs) || !statSync(abs).isFile()) continue;
  if (!/\.(md|mjs|js|json|txt)$/.test(rel)) continue;
  if (RECORD_DIRS.some((d) => rel.startsWith(d))) continue;
  const raw = readFileSync(abs, 'utf8');
  const body = rel.endsWith('.mjs') || rel.endsWith('.js') ? stripComments(raw) : raw;
  scanned++;

  for (const line of body.split('\n')) {
    const win = line.match(WIN_ABS);
    if (win) problems.push({ file: rel, kind: 'windows_abs', hit: win[0].slice(0, 80) });
    const posix = line.match(POSIX_ABS);
    if (posix) problems.push({ file: rel, kind: 'posix_abs', hit: posix[0].slice(0, 80) });
    if (line.includes('<FRAMEWORK_ROOT>')) placeholders.push({ file: rel });
  }
}

if (scanned === 0) {
  if (jsonOut) console.log(JSON.stringify({ ok: false, error: 'no_fixtures_found' }, null, 2));
  else console.log('✗ 一份夹具都没扫到——检查的分母是 0');
  process.exit(2);
}

if (jsonOut) {
  console.log(JSON.stringify({ ok: problems.length === 0, scanned, problems, placeholders }, null, 2));
} else {
  console.log(`\n=== 夹具可移植性（扫描 ${scanned} 份被跟踪的夹具文件）===\n`);
  if (problems.length === 0) {
    console.log('✓ 没有写死的本机绝对路径\n');
  } else {
    for (const p of problems) {
      console.log(`✗ ${p.file}`);
      console.log(`  [${p.kind}] ${p.hit}`);
    }
    console.log(`\n共 ${problems.length} 处。夹具里写死本机路径 → 换一台机器结论就变，`);
    console.log('见本文件头部「为什么需要」。改法：用相对路径（按产物所在目录解析）');
    console.log('或 `<FRAMEWORK_ROOT>/...` 占位。\n');
  }
  if (placeholders.length) {
    console.log(`（另有 ${placeholders.length} 处使用 <FRAMEWORK_ROOT> 占位，按设计允许）\n`);
  }
}

process.exit(problems.length === 0 ? 0 : 1);
