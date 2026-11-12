import fs from 'node:fs';
import path from 'node:path';

const R = path.resolve(process.argv[2]);
const repo = R + '/repo';
const arts = R + '/arts';
fs.rmSync(repo, { recursive: true, force: true });
fs.rmSync(arts, { recursive: true, force: true });
fs.mkdirSync(repo + '/src', { recursive: true });
fs.mkdirSync(arts, { recursive: true });

// 造一个仓库：同文件里有两个相似函数，一个安全一个不安全
const queueSrc = [
  '// src/queue.js — 任务队列',
  'export class TaskQueue {',
  '  #items = [];',
  '  #capacity = 10;',
  '',
  '  // 安全版本：先检查容量',
  '  enqueueSafe(task) {',
  '    if (this.#items.length >= this.#capacity) return false;',
  '    this.#items.push(task);',
  '    return true;',
  '  }',
  '',
  '  // 不安全版本：容量检查写错',
  '  enqueue(task) {',
  '    if (this.#items.length > this.#capacity) return false;',
  '    this.#items.push(task);',
  '    return true;',
  '  }',
  '',
  '  peek() {',
  '    return this.#items[this.#items.length - 1];',
  '  }',
  '}',
].join('\n');

fs.writeFileSync(repo + '/src/queue.js', queueSrc);

const mkArtifact = (name, findings) => {
  const artifact = `${arts}/${name}.md`;
  const e = {
    schema_version: 'output-contract-v1',
    agent_id: 'a1',
    role: 'audit',
    status: 'SUCCESS',
    contract_valid: true,
    artifact_path: artifact,
    payload: {
      slice_id: 's1',
      files: ['src/queue.js'],
      line_count: 23,
      searched_scope: {
        files_read: ['src/queue.js'],
        files_in_slice: 1,
        shared_dependencies_read: [],
        dimension_checklist: ['条件分支', '返回值语义'],
      },
      findings,
      self_checks: {
        identifier_reconcile: { status: 'DONE', note: '对账了 1 个文件的 import 列表，无缺失' },
        self_check_audit: { status: 'DONE', note: '抽验了自检脚本对容量的断言' },
        runtime_validation: { status: 'DONE', note: '跑了 12 次 enqueue 验证容量边界' },
      },
    },
    error: null,
  };
  fs.writeFileSync(artifact, '# 报告\n\n正文\n\n```json\n' + JSON.stringify(e, null, 2) + '\n```\n');
};

const F = (over) => ({
  finding_id: 'F1',
  dimension: 'logic',
  severity: 'HIGH',
  evidence: { file: 'src/queue.js', line: 15, quote: '' },
  inference: { claim: '容量检查用 > 允许塞进 capacity+1 个', basis: '第 15 行用的是 > 而不是 >=，等于多放一个才拒绝', alternatives: ['故意允许溢出'] },
  status: 'CONFIRMED',
  ...over,
});

// ── 对照组：真实
mkArtifact('01-truthful', [F({ evidence: { file: 'src/queue.js', line: 15, quote: 'if (this.#items.length > this.#capacity) return false;' } })]);

// ── 攻击 1：跨行拼接（把第 8 行和第 15 行的片段拼起来）
mkArtifact('02-crossline', [F({ evidence: { file: 'src/queue.js', line: 15, quote: 'if (this.#items.length >= this.#capacity) return false; this.#items.push(task);' } })]);

// ── 攻击 2：取同文件另一个函数的真实行（行号说 15，内容是第 8 行的）
mkArtifact('03-wrong-function', [F({ evidence: { file: 'src/queue.js', line: 15, quote: 'if (this.#items.length >= this.#capacity) return false;' } })]);

// ── 攻击 3：行号偏 1（内容真实但行号错）
mkArtifact('04-off-by-one', [F({ evidence: { file: 'src/queue.js', line: 16, quote: 'if (this.#items.length > this.#capacity) return false;' } })]);

// ── 攻击 4：fuzzy 蒙混——只抄几个 token，顺序对但原文里不连续
mkArtifact('05-fuzzy-tokens', [F({ evidence: { file: 'src/queue.js', line: 15, quote: 'if length > capacity return false' } })]);

// ── 攻击 5：quote 是注释而非代码
mkArtifact('06-comment-quote', [F({ evidence: { file: 'src/queue.js', line: 15, quote: '// 不安全版本：容量检查写错' } })]);

// ── 攻击 6：行号指向空行
mkArtifact('07-blank-line', [F({ evidence: { file: 'src/queue.js', line: 5, quote: '' } })]);

// ── 攻击 6b：注释引文，但行号准确
// 这才是真正测「注释不是证据」的用例。06 那条行号是错的，
// 会被「引错了行」这条规则拦下，根本走不到注释判断。
mkArtifact('06b-comment-right-line', [F({
  evidence: { file: 'src/queue.js', line: 13, quote: '// 不安全版本：容量检查写错' },
})]);

// ── 反向对照：缺陷本身就是「注释与实现不符」
// 此时注释是被审对象，不是证据，必须放行。
// 若这条被误伤，说明注释禁令做得太宽，会惩罚合法发现。
mkArtifact('08b-legit-doc-mismatch', [F({
  evidence: { file: 'src/queue.js', line: 13, quote: '// 不安全版本：容量检查写错' },
  inference: {
    claim: '第 13 行的注释声称这里是「不安全版本」，但下面的实现其实是安全的——注释与实现不符',
    basis: '注释与方法体行为矛盾',
    alternatives: [],
  },
})]);

// ── 攻击 7：把安全的函数说成不安全的（引文真实但结论相反）
mkArtifact('08-truthful-quote-wrong-claim', [F({
  evidence: { file: 'src/queue.js', line: 8, quote: 'if (this.#items.length >= this.#capacity) return false;' },
  inference: { claim: '这里用 >= 导致容量少一个', basis: '>= 会提前拒绝', alternatives: [] },
})]);

console.log('生成 8 个门 0 探针');
for (const f of fs.readdirSync(arts).sort()) console.log('  ' + f);
