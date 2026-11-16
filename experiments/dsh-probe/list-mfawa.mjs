// 探测某个 OpenAI 兼容端点的模型列表。
//
// 凭据从环境变量读，不要写进源码 —— 这个仓库是公开的，写进源码的 key
// 会随 git 历史永久留存，删掉后续提交也没用。
//
//   PROBE_API_KEY=sk-... node list-models.mjs <base-url>
//
// 例：PROBE_API_KEY=xxx node list-models.mjs https://api.example.com/v1
const baseUrl = process.argv[2];
const key = process.env.PROBE_API_KEY;

if (!baseUrl || !key) {
  console.error('用法: PROBE_API_KEY=<key> node list-models.mjs <base-url>');
  process.exit(2);
}

const r = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
  headers: { authorization: `Bearer ${key}` },
});
const j = await r.json();
const arr = j.data || [];
console.log('count', arr.length);
arr.slice(0, 60).forEach((m) => console.log(' ', m.id));
