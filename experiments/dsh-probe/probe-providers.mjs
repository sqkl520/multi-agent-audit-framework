// 批量探测若干 OpenAI 兼容端点的可达性与模型数量。
//
// 凭据从环境变量读 —— 这个仓库是公开的，写进源码的 key 会随 git 历史永久留存，
// 后续提交里删掉也没用（那一次事故本仓库真的发生过，整个历史被重写过一遍）。
//
//   PROBE_KEYS='{"endpoint-a":"sk-...","endpoint-b":"sk-..."}' node probe-providers.mjs
//
// 未在 PROBE_KEYS 里给出的端点会以匿名方式探测（用于确认可达性）。
const KEYS = JSON.parse(process.env.PROBE_KEYS || '{}');

const targets = [
  { name: 'endpoint-a', url: 'https://api.example.com/v1/models', style: 'bearer' },
  { name: 'endpoint-b', url: 'https://llm.example.net/v1/models', style: 'bearer' },
  { name: 'endpoint-c', url: 'https://gateway.example.org/api/llm/anthropic/v1/models', style: 'bearer' },
];

for (const t of targets) {
  const key = KEYS[t.name] ?? null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const h = { 'content-type': 'application/json' };
    if (key) h.authorization = 'Bearer ' + key;
    const r = await fetch(t.url, { headers: h, signal: ctl.signal });
    const text = (await r.text()).slice(0, 160);
    let count = '';
    try {
      const j = JSON.parse(text);
      const arr = j.data || j.models || [];
      if (Array.isArray(arr)) count = ` models=${arr.length} first=${(arr[0]?.id || arr[0]?.name || '?')}`;
    } catch { /* 非 JSON 响应，只要状态码 */ }
    console.log(`${t.name.padEnd(10)} HTTP ${r.status}${count}  ${text.replace(/\s+/g, ' ').slice(0, 90)}`);
  } catch (e) {
    console.log(`${t.name.padEnd(10)} FAIL ${e.name} ${String(e.message).slice(0, 60)}`);
  } finally { clearTimeout(timer); }
}
