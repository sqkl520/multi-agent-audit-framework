import fs from 'node:fs';
import path from 'node:path';

const R = path.resolve(process.argv[2]);
const repo = R + '/repo';
const arts = R + '/arts';
fs.rmSync(repo, { recursive: true, force: true });
fs.rmSync(arts, { recursive: true, force: true });
fs.mkdirSync(repo + '/src', { recursive: true });
fs.mkdirSync(arts, { recursive: true });

// 20 个文件。审计 agent 只真读了 1 个（queue.js），
// 却声称读了全部 20 个。
const FILES = [];
for (let i = 1; i <= 20; i++) {
  const name = i === 1 ? 'queue.js' : `mod${i}.js`;
  FILES.push(name);
  const body = i === 1
    ? [
        '// src/queue.js',
        'export class TaskQueue {',
        '  #items = [];',
        '  enqueue(t) {',
        '    if (this.#items.length > 10) return false;',
        '    this.#items.push(t);',
        '    return true;',
        '  }',
        '}',
      ].join('\n')
    : Array.from({ length: 20 }, (_, k) => `export const v${k} = ${k};`).join('\n');
  fs.writeFileSync(`${repo}/src/${name}`, body);
}

const mkArtifact = (name, payload) => {
  const artifact = `${arts}/${name}.md`;
  const e = {
    schema_version: 'output-contract-v1',
    agent_id: 'a1',
    role: 'audit',
    status: 'SUCCESS',
    contract_valid: true,
    artifact_path: artifact,
    payload,
    error: null,
  };
  fs.writeFileSync(artifact, '# 报告\n\n正文\n\n```json\n' + JSON.stringify(e, null, 2) + '\n```\n');
};

const basePayload = (over) => ({
  slice_id: 's1',
  files: FILES.map((f) => `src/${f}`),
  line_count: 300,
  searched_scope: {
    files_read: FILES.map((f) => `src/${f}`),   // 声称全读了
    files_in_slice: 20,
    shared_dependencies_read: [],
    dimension_checklist: ['条件分支', '返回值语义', '异常路径', '循环边界'],
  },
  findings: [{
    finding_id: 'F1',
    dimension: 'logic',
    severity: 'HIGH',
    evidence: { file: 'src/queue.js', line: 5, quote: 'if (this.#items.length > 10) return false;' },
    inference: { claim: '容量检查用 > 允许塞进 capacity+1 个', basis: '第 5 行用的是 > 而不是 >=', alternatives: ['故意允许溢出'] },
    status: 'CONFIRMED',
  }],
  self_checks: {
    identifier_reconcile: { status: 'DONE', note: '对账了全部 20 个文件的 import 列表，无缺失' },
    self_check_audit: { status: 'DONE', note: '抽验了自检脚本对容量边界的断言' },
    runtime_validation: { status: 'DONE', note: '跑了 12 次 enqueue 验证容量边界' },
  },
  ...over,
});

// ── 攻击 1：声称读 20 个文件，只有 1 个有证据
mkArtifact('scope-01-claim-20-quote-1', basePayload({}));

// ── 攻击 2：files_read 只列 1 个（诚实），但 dimension_checklist 列 4 个维度
mkArtifact('scope-02-honest-files', basePayload({
  searched_scope: {
    files_read: ['src/queue.js'],
    files_in_slice: 1,
    shared_dependencies_read: [],
    dimension_checklist: ['条件分支', '返回值语义', '异常路径', '循环边界'],
  },
}));

// ── 攻击 3：files_read 全列，但 findings 全部集中在同一个文件
mkArtifact('scope-03-all-findings-one-file', basePayload({
  findings: [
    { finding_id: 'F1', dimension: 'logic', severity: 'HIGH',
      evidence: { file: 'src/queue.js', line: 5, quote: 'if (this.#items.length > 10) return false;' },
      inference: { claim: 'a', basis: 'b', alternatives: ['c'] }, status: 'CONFIRMED' },
    { finding_id: 'F2', dimension: 'logic', severity: 'HIGH',
      evidence: { file: 'src/queue.js', line: 6, quote: 'this.#items.push(t);' },
      inference: { claim: 'a', basis: 'b', alternatives: ['c'] }, status: 'CONFIRMED' },
  ],
}));

console.log('生成 3 个 searched_scope 探针');
for (const f of fs.readdirSync(arts).sort()) console.log('  ' + f);
console.log(`\n仓库里共 ${FILES.length} 个文件，每个约 9-20 行`);
