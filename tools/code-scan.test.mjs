// code-scan 自测
//
// 这两个函数的存在理由，是 R4 被注释骗过（2026-11-25 锐评实测）：
// `check-contract-slices` 的唯一"引用"是别人文件头的注释，
// `check-suite-vitality` 的唯一"引用"是 check-all.mjs 的说明性注释，
// 两者都被裸子串判成「已接线」——而这正是 R4 要抓的形态。
import { mentionsFile, stripComments, workflowRuns } from './lib/code-scan.mjs';

let pass = 0, fail = 0;
const expect = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

console.log('\n=== code-scan 自测 ===\n');

console.log('case 1: 行注释里提到文件名 → 不算引用');
{
  expect('注释不命中', !mentionsFile("// 见 check-doc-counts.mjs\nconst a = 1;\n", 'check-doc-counts.mjs'));
}

console.log('case 2: 块注释里提到文件名 → 不算引用');
{
  expect('块注释不命中', !mentionsFile(
    "/**\n * 与 check-contract-slices.mjs 的分工：\n */\nconst a = 1;\n",
    'check-contract-slices.mjs',
  ));
}

console.log('case 3: 字符串字面量里的文件名 → 算引用（execFileSync 的参数就在字符串里）');
{
  expect('字符串命中', mentionsFile("execFileSync('node', ['tools/x.mjs']);\n", 'x.mjs'));
  expect('双引号也命中', mentionsFile('run("tools/x.mjs");\n', 'x.mjs'));
}

console.log('case 4: 子串撞车 → 不算引用');
{
  // 锐评实测：consistency.mjs ⊂ check-enum-consistency.mjs
  expect('consistency.mjs 不被 check-enum-consistency.mjs 命中',
    !mentionsFile("execFileSync('node', ['tools/check-enum-consistency.mjs']);\n", 'consistency.mjs'));
  expect('反过来也不命中',
    !mentionsFile("execFileSync('node', ['tools/consistency.mjs']);\n", 'check-enum-consistency.mjs'));
}

console.log('case 5: 路径前缀与引号不影响');
{
  expect('./tools/x.mjs', mentionsFile("node ./tools/x.mjs\n", 'x.mjs'));
  expect("'x.mjs'", mentionsFile("run('x.mjs')\n", 'x.mjs'));
}

console.log('case 6: 注释掉的 workflow 步骤 → 不算在 CI 里跑');
{
  expect('单行注释', !workflowRuns('      # run: node tools/old.mjs\n', 'old.mjs'));
  expect('块内注释', !workflowRuns('      - name: x\n        run: |\n          # node tools/y.mjs\n          echo hi\n', 'y.mjs'));
}

console.log('case 7: 真正在跑的单行步骤 → 命中');
{
  expect('单行', workflowRuns('      - name: x\n        run: node tools/b.mjs\n', 'b.mjs'));
  expect('带参数', workflowRuns('        run: node tools/b.mjs --since HEAD~1\n', 'b.mjs'));
}

console.log('case 8: 块标量（run: |）里的命令 → 命中');
{
  // 本仓库 check-commit-msg 那一步就是这种写法；只认单行会把它误报成「没在 CI 里跑」。
  const yml = '      - name: Commit message format\n        run: |\n          set -e\n          node tools/check-commit-msg.mjs --since "$BASE"\n';
  expect('块标量命中', workflowRuns(yml, 'check-commit-msg.mjs'));
}

console.log('case 9: 别的脚本名不误命中');
{
  expect('不同名不命中', !workflowRuns('        run: node tools/other.mjs\n', 'b.mjs'));
}

console.log('case 10: stripComments 保留偏移（不能把后面的代码也吞掉）');
{
  const src = 'const a = 1; // x.mjs\nconst b = 2;\n';
  const out = stripComments(src);
  expect('长度不变', out.length === src.length, `${out.length} vs ${src.length}`);
  expect('后面的代码还在', out.includes('const b = 2;'));
  expect('换行保留', out.split('\n').length === src.split('\n').length);
}

console.log('case 11: 字符串里的 // 不是注释');
{
  const src = "const url = 'http://x';\nconst b = 2;\n";
  const out = stripComments(src);
  expect('字符串保留', out.includes("'http://x'"));
  expect('后续代码保留', out.includes('const b = 2;'));
}

console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail > 0 ? 1 : 0);
