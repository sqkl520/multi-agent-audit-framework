// Mock LLM that drives dsh's multi-agent path: the first request asks for the
// `subagent` tool, the child agent's request gets a distinct reply, and the
// parent's post-tool request gets the final text.
//
// The point is not intelligence — it is to observe whether dsh actually spawns a
// child agent, routes a second LLM request for it, and reports back.
import { createServer } from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.MOCK_PORT ?? 18890);
const LOG_PATH = join(import.meta.dirname, 'mock-multi.log');
writeFileSync(LOG_PATH, '');

let requestSeq = 0;
const seenSessions = new Map();

function log(entry) {
  appendFileSync(LOG_PATH, JSON.stringify({ at: new Date().toISOString(), seq: ++requestSeq, ...entry }) + '\n');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Distinguish parent from child by the system prompt / first user message.
function classify(body) {
  const messages = body.messages ?? [];
  const sys = messages.filter((m) => m.role === 'system').map((m) => String(m.content ?? '')).join('\n');
  const firstUser = messages.find((m) => m.role === 'user');
  const firstUserText = typeof firstUser?.content === 'string'
    ? firstUser.content
    : Array.isArray(firstUser?.content) ? firstUser.content.map((p) => p?.text ?? '').join(' ') : '';
  const combined = sys + '\n' + firstUserText;
  if (combined.includes('CHILD_TASK_MARKER')) return 'child';
  return 'parent';
}

function replyStream(res, body, { text, toolCall, finish }) {
  const id = 'chatcmpl-mock';
  const created = Math.floor(Date.now() / 1000);
  const base = { id, object: 'chat.completion.chunk', created, model: body.model ?? 'mock-model' };
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  if (toolCall) {
    send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_sa', type: 'function', function: { name: toolCall.name, arguments: '' } }] }, finish_reason: null }] });
    send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(toolCall.args) } }] }, finish_reason: null }] });
  } else {
    send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] });
  }
  send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] });
  send({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  res.write('data: [DONE]\n\n');
  res.end();
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;

  if (req.method === 'GET' && /\/models$/.test(path)) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model', owned_by: 'mock' }] }));
    return;
  }

  if (req.method === 'POST' && /chat\/completions$/.test(path)) {
    const raw = await readBody(req);
    let body = {};
    try { body = JSON.parse(raw); } catch {}
    const messages = body.messages ?? [];
    const hasToolResult = messages.some((m) => m.role === 'tool');
    const who = classify(body);
    const toolNames = (body.tools ?? []).map((t) => t?.function?.name ?? t?.name);

    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const lastUserText = typeof lastUser?.content === 'string'
      ? lastUser.content
      : Array.isArray(lastUser?.content) ? lastUser.content.map((p) => p?.text ?? '').join(' ') : '';

    log({
      who,
      model: body.model,
      messageCount: messages.length,
      hasToolResult,
      toolNames,
      lastUser: lastUserText.slice(0, 120),
    });

    if (who === 'parent' && !hasToolResult && toolNames.includes('subagent')) {
      replyStream(res, body, {
        toolCall: {
          name: 'subagent',
          args: { prompt: 'CHILD_TASK_MARKER: list files in the current directory and report', description: 'probe child' },
        },
        finish: 'tool_calls',
      });
      return;
    }

    if (hasToolResult) {
      const toolMsg = messages.filter((m) => m.role === 'tool').pop();
      const toolText = typeof toolMsg?.content === 'string' ? toolMsg.content.slice(0, 200) : '';
      log({ note: 'tool result received by parent', toolText });
      replyStream(res, body, { text: 'PARENT_FINAL_OK', finish: 'stop' });
      return;
    }

    if (who === 'child') {
      replyStream(res, body, { text: 'CHILD_FINAL_OK', finish: 'stop' });
      return;
    }

    replyStream(res, body, { text: 'FALLBACK_OK', finish: 'stop' });
    return;
  }

  log({ unmatched: path, method: req.method });
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not mocked: ' + path } }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock multi-agent LLM on http://127.0.0.1:${PORT} log=${LOG_PATH}`);
});
