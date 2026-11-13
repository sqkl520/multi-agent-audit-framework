const key = 'sk-REDACTED-USE-ENV-VAR';
const r = await fetch('https://gs.mfawa.top/v1/models', { headers: { authorization: 'Bearer ' + key } });
const j = await r.json();
const arr = j.data || [];
console.log('count', arr.length);
arr.slice(0, 60).forEach((m) => console.log(' ', m.id));
