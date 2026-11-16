// 探测配置好的 Anthropic 兼容上游现在能不能跑真实 agent 派发。
// 只发一个极短的请求（max_tokens: 8），避免浪费额度。
//
// 凭据从环境变量读 —— 这个仓库是公开的，写进源码的 key 会随 git 历史永久留存。
//
//   PROBE_KEYS='{"proxy":"...","endpoint-b":"..."}' node probe-anthropic.mjs
const KEYS = JSON.parse(process.env.PROBE_KEYS || '{}');

const targets = [
  { label: 'local proxy', url: 'http://127.0.0.1:15721/v1/messages', key: KEYS.proxy ?? 'proxy', model: 'claude-sonnet-5-5' },
  { label: 'endpoint-b', url: 'https://llm.example.net/v1/messages', key: KEYS['endpoint-b'] ?? null, model: 'example-model' },
  { label: 'endpoint-c', url: 'https://gateway.example.org/api/llm/anthropic/v1/messages', key: KEYS['endpoint-c'] ?? null, model: 'example-model' },
].filter((t) => t.key);

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
