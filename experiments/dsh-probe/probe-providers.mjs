const targets = [
  { name: 'furryv2',  url: 'https://ai.furry.vg/v1/models',        key: 'sk-REDACTED-USE-ENV-VAR', style: 'bearer' },
  { name: 'furryv1',  url: 'https://api.furry.vg/v1/models',       key: null, style: 'bearer' },
  { name: 'mfawa',    url: 'https://gs.mfawa.top/v1/models',       key: 'sk-REDACTED-USE-ENV-VAR', style: 'bearer' },
  { name: 'uuapi',    url: 'https://uuapi.net/v1/models',          key: 'sk-REDACTED-USE-ENV-VAR', style: 'bearer' },
  { name: 'scnet',    url: 'https://api.scnet.cn/api/llm/anthropic/v1/models', key: 'sk-REDACTED-USE-ENV-VAR', style: 'bearer' },
  { name: 'ip39000',  url: 'http://47.108.197.93:33000/v1/models', key: null, style: 'bearer' },
];

for (const t of targets) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const h = { 'content-type': 'application/json' };
    if (t.key) h.authorization = 'Bearer ' + t.key;
    const r = await fetch(t.url, { headers: h, signal: ctl.signal });
    const text = (await r.text()).slice(0, 160);
    let count = '';
    try { const j = JSON.parse(text); const arr = j.data || j.models || []; if (Array.isArray(arr)) count = ` models=${arr.length} first=${(arr[0]?.id || arr[0]?.name || '?')}`; } catch {}
    console.log(`${t.name.padEnd(10)} HTTP ${r.status}${count}  ${text.replace(/\s+/g, ' ').slice(0, 90)}`);
  } catch (e) {
    console.log(`${t.name.padEnd(10)} FAIL ${e.name} ${String(e.message).slice(0, 60)}`);
  } finally { clearTimeout(timer); }
}
