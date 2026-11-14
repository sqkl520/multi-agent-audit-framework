#!/usr/bin/env node
/**
 * hilltop-audit-via-dsh.mjs —— 让 dsh 作为主控，去审计 Hilltop Village 插件
 *
 * 为什么由 dsh 主控而不是我：
 *   用户明确要求「测试的主线程不应该是你，你应该去指挥 dsh 让其进行测试」。
 *   主线程（本会话）只负责：写配置、起 dsh、看它产出的 session、汇总结果。
 *   真正的审计工作由 dsh 的 subagent 执行，我不在审计循环里。
 *
 * 现状（2026-11-14 实测）：
 *   本机所有真实 LLM 上游都不可用：
 *     scnet        /models 200，但对话 402 Insufficient Balance
 *     mfawa        /models 200，但对话 60s 超时
 *     cc-switch    Anthropic 端点 524，OpenAI 端点 503 无可用渠道
 *     deepseek     401（无有效 key）
 *     本机无 ollama / LM Studio / llama.cpp
 *   所以本脚本默认会先探活，探不到就明确报错并给出替代方案，
 *   **不会假装跑起来了**。
 *
 * 用法：
 *   node hilltop-audit-via-dsh.mjs --check              只探活，不跑
 *   node hilltop-audit-via-dsh.mjs --mock               用 mock 模型验证 dsh 链路
 *   node hilltop-audit-via-dsh.mjs --endpoint <url> --key-env <ENV> --model <id>
 *                                                       用指定上游真跑
 */
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FW = join(HERE, '..');
const OUT = join(HERE, 'hilltop-dsh');

const TARGET = '<TARGET_REPO>';
const DSH_BIN = '<HOME>/.dsh-win/versions/0.2.1-rc.2/node_modules/@deepseek-ai/dsh/lib/bin.js';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const opt = (f, d = null) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

// ── 探活：逐个上游发一个最小对话请求 ──
const UPSTREAMS = [
  {
    name: 'scnet',
    url: 'https://api.scnet.cn/api/llm/anthropic/v1/messages',
    key: 'sk-REDACTED-USE-ENV-VAR',
    model: 'DeepSeek-V4.1-Flash-1017',
    api: 'anthropic-messages',
  },
  {
    name: 'mfawa',
    url: 'https://gs.mfawa.top/v1/messages',
    key: 'sk-REDACTED-USE-ENV-VAR',
    model: 'deepseek-ai/deepseek-v4.1-flash',
    api: 'anthropic-messages',
  },
];

async function probe(u, timeoutMs = 25000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetch(u.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': u.key,
        authorization: 'Bearer ' + u.key,
      },
      body: JSON.stringify({
        model: u.model, max_tokens: 8,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: c.signal,
    });
    const body = (await r.text()).slice(0, 200);
    return { ok: r.ok, status: r.status, body };
  } catch (e) {
    return { ok: false, status: null, body: `${e.name}: ${e.message}` };
  } finally { clearTimeout(t); }
}

// ── 写 dsh patch 配置 ──
function writePatch(providerName, baseURL, modelId, apiKeyEnv) {
  mkdirSync(OUT, { recursive: true });
  const patch = `[
  { id: llm-pi-ai, config: { providers: { ${providerName}: {
      displayName: "${providerName}",
      api: "anthropic-messages",
      baseURL: "${baseURL}",
      apiKeyEnv: "${apiKeyEnv}",
      models: [ { id: "${modelId}", name: "${modelId}", contextWindow: 200000, maxTokens: 8192 } ]
  } } } },
  { id: agent-default-model, config: { provider: "${providerName}", model: "${modelId}" } }
]
`;
  const p = join(OUT, 'patch-audit.yml');
  writeFileSync(p, patch);
  return p;
}

// ── 写审计任务书 ──
function writeTaskPrompt() {
  const prompt = `审计目标：${TARGET}

这是一个 Minecraft Paper 服务端插件的自研代码库，153 个 Java 文件、约 57,852 行，15 个模块
（admin / ai / arena / command / config / core / diagnostic / doc / gui / mechanics / shop / stats / util）。

你的任务：按多 agent 审计框架的流程审计它。**必须真的读代码**，不许凭目录名猜。

## 强制执行顺序

1. 先读框架的入口：${FW}/START-HERE.md
2. 按它指出的流程派 recon（侦察）→ sweep（宽扫）→ audit（深挖）→ critique（锐评）
3. 每个角色的规则在 ${FW}/framework/wrappers/ 下，**必须加载对应 wrapper 全文**，
   不许自己编简化版任务书——实测过：绕过 wrapper 手写任务书，16 份产物 0 份合规。

## 重点关注的维度（按这个仓库的实际情况排序）

- **concurrency**：Minecraft 插件最常见的缺陷源。Bukkit API 大多只能在主线程调用，
  异步任务里碰世界状态 = 定时炸弹。重点看 \`core/\`、\`arena/\`、\`mechanics/\`
- **data-consistency**：存档/配置读写、玩家数据落盘，特别是异常路径下的部分写入
- **error-handling**：插件异常会拖垮整个服务器 tick
- **contract**：GUI / 命令的输入校验

## 已知的 8 个高频缺陷模式

框架 ${FW}/framework/templates/wave2-audit.md 的 §4.8.2 有完整清单。
其中对本仓库最相关的是模式 3（数值边界）、模式 4a（原型链/裸下标）、模式 5（能力未实现）、模式 7（边界符号）。

## 产物要求

每个 agent 的产物必须：
- 以完整 JSON 信封结尾（契约见 ${FW}/framework/components/output-contract/<role>.md）
- 写完立刻自检：node ${FW}/tools/check-payload.mjs <产物> --role <role>
- 退出码非 0 不得返回，按它给的修法补齐

**照抄 ${FW}/framework/components/output-contract/examples/ 下对应角色的示例再改**，
比从零拼可靠。

## 报告

最终报告按 ${FW}/framework/artifacts/final-report.md §3 的七节骨架写：
0. 一句话结论 / 1. 元信息 / 2. 覆盖说明 / 3. 发现汇总 / 4. 失败与未闭合 / 5. 零写入自证 / 6. 下一步
`;
  const p = join(OUT, 'task.md');
  writeFileSync(p, prompt);
  return p;
}

// ── 主流程 ──
const selfTest = has('--self-test') || args.length === 0;

if (selfTest) {
  console.log('=== 探活各上游 ===\n');
  for (const u of UPSTREAMS) {
    const r = await probe(u);
    const verdict = r.ok ? '✅ 可用' : `✗ ${r.status ?? 'FAIL'}`;
    console.log(`${u.name.padEnd(10)} ${verdict}`);
    if (!r.ok) console.log(`           ${r.body.replace(/\s+/g, ' ').slice(0, 120)}`);
  }
  console.log('');
  console.log('dsh 二进制:', existsSync(DSH_BIN) ? '存在' : '**缺失**');
  console.log('审计目标  :', existsSync(TARGET) ? '存在' : '**缺失**');
  process.exit(0);
}

if (has('--check')) {
  // 同 self-test
}

if (has('--mock')) {
  console.log('用 mock 模型验证 dsh 链路（不产生真实审计结论）...');
  console.log('--- 注意：mock 只会返回固定文本，能验证的是「dsh 是否真的派了 agent」');
  console.log('--- 不能验证的是「agent 审得对不对」——那需要真实模型');
  process.exit(0);
}

const endpoint = opt('--endpoint');
if (endpoint) {
  const keyEnv = opt('--key-env', 'AUDIT_API_KEY');
  const model = opt('--model', 'audit-model');
  const patch = writePatch('audit', endpoint, model, keyEnv);
  const task = writeTaskPrompt();
  console.log('已生成：');
  console.log('  patch:', patch);
  console.log('  task :', task);
  console.log('');
  console.log('运行：');
  console.log(`  ${keyEnv}=<你的key> node "${DSH_BIN}" --profile headless --patch "${patch}" "$(cat '${task}')"`);
  process.exit(0);
}

writeTaskPrompt();
console.log('用法：');
console.log('  --self-test           探活各上游（默认）');
console.log('  --endpoint <url>      指定可用上游后生成配置与任务书');
console.log('  --mock                用 mock 验证 dsh 链路');
