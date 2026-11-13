// 探测本机可用的 Anthropic 兼容上游，判断现在能不能跑真实 agent 派发。
// 只发一个极短的请求，避免浪费额度。
const targets = [
  { label: 'cc-switch proxy', url: 'http://127.0.0.1:15721/v1/messages', key: 'proxy', model: 'claude-sonnet-5-5' },
  { label: 'mfawa', url: 'https://gs.mfawa.top/v1/messages', key: 'sk-REDACTED-USE-ENV-VAR', model: 'deepseek-ai/deepseek-v4.1-flash' },
  { label: 'scnet', url: 'https://api.scnet.cn/api/llm/anthropic/v1/messages', key: 'sk-REDACTED-USE-ENV-VAR', model: 'DeepSeek-V4.1-Flash-1017' },
];

const body = (model) => JSON.stringify({
  model,
  max_tokens: 8,
  messages: [{ role: 'user', content: 'Say OK' }],
});

await Promise.all(targets.map(async (t) => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 45000);
  const started = Date.now();
  try {
    const r = await fetch(t.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': t.key,
        authorization: 'Bearer ' + t.key,
      },
      body: body(t.model),
      signal: ctl.signal,
    });
    const txt = (await r.text()).replace(/\s+/g, ' ').slice(0, 180);
    console.log(`${t.label.padEnd(16)} HTTP ${r.status} ${Date.now() - started}ms  ${txt}`);
  } catch (e) {
    console.log(`${t.label.padEnd(16)} FAIL ${e.name} after ${Date.now() - started}ms`);
  } finally {
    clearTimeout(timer);
  }
}));
