// Decisive probe: does `dsh headless` report the answer from turn 1 (the one that
// merely *started* a subagent and then said something) or from turn 2 (the one
// triggered later by the subagent's settle notice)?
//
// Turn 1 and turn 2 are given distinguishable answers so the printed output
// tells us which turn the harness treats as the result.
import { createServer } from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.MOCK_PORT ?? 18891);
const LOG_PATH = join(import.meta.dirname, 'mock-turn.log');
writeFileSync(LOG_PATH, '');

let seq = 0;
const log = (e) => appendFileSync(LOG_PATH, JSON.stringify({ at: new Date().toISOString(), seq: ++seq, ...e }) + '\n');

function readBody(req) {
  return new Promise((res, rej) => {
    const c = [];
    req.on('data', (d) => c.push(d));
    req.on('end', () => res(Buffer.concat(c).toString('utf8')));
    req.on('error', rej);
  });
}

function textOf(m) {
  if (typeof m?.content === 'string') return m.content;
  if (Array.isArray(m?.content)) return m.content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join(' ');
  return '';
}

function stream(res, body, { text, toolCall, finish }) {
  const base = { id: 'c-mock', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model ?? 'mock-model' };
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  if (toolCall) {
    send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: toolCall.name, arguments: '' } }] }, finish_reason: null }] });
    send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(toolCall.args) } }] }, finish_reason: null }] });
  } else {
    send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] });
  }
  send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] });
  send({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  res.write('data: [DONE]\n\n');
  res.end();
}

createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;

  if (req.method === 'GET' && /\/models$/.test(path)) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model', owned_by: 'mock' }] }));
    return;
  }

  if (!(req.method === 'POST' && /chat\/completions$/.test(path))) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
    return;
  }

  let body = {};
  try { body = JSON.parse(await readBody(req)); } catch {}
  const messages = body.messages ?? [];
  const all = messages.map(textOf).join('\n');
  const toolNames = (body.tools ?? []).map((t) => t?.function?.name ?? t?.name);
  const sawSettleNotice = /finished and will do no further work/.test(all);
  const isChild = /CHILD_TASK_MARKER/.test(all);
  const hasToolResult = messages.some((m) => m.role === 'tool');

  // Session-title generation is its own LLM call with no tools mounted.
  const isTitle = toolNames.length === 0 && /session title/i.test(all);

  log({ role: isChild ? 'child' : isTitle ? 'title' : 'parent', hasToolResult, sawSettleNotice, msgCount: messages.length });

  if (isChild) {
    stream(res, body, { text: 'CHILD_REPORT', finish: 'stop' });
    return;
  }
  if (isTitle) {
    stream(res, body, { text: 'probe', finish: 'stop' });
    return;
  }
  if (sawSettleNotice) {
    // Turn 2: the settle notice arrived. This answer can only be produced after
    // the child finished.
    const childMsg = (all.match(/Its closing message:\s*([^\n]+)/) ?? [])[1] ?? 'none';
    stream(res, body, { text: `TURN2_SAW_CHILD=${childMsg}`, finish: 'stop' });
    return;
  }
  if (!hasToolResult && toolNames.includes('subagent')) {
    stream(res, body, { toolCall: { name: 'subagent', args: { prompt: 'CHILD_TASK_MARKER do the work', description: 'probe' } }, finish: 'tool_calls' });
    return;
  }
  stream(res, body, { text: 'TURN1_OK', finish: 'stop' });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`mock turn-probe on http://127.0.0.1:${PORT} log=${LOG_PATH}`);
});
