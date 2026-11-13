// Mock OpenAI-compatible server for exercising dsh end-to-end without a real
// upstream LLM. Serves both plain JSON and SSE streaming (dsh uses streaming).
//
// Log goes to a file rather than an HTTP endpoint so a hung client cannot block
// inspection.
import { createServer } from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.MOCK_PORT ?? 18888);
const MODE = process.env.MOCK_MODE ?? 'plain'; // plain | tool
const LOG_PATH = join(import.meta.dirname, 'mock-llm.log');

writeFileSync(LOG_PATH, '');

function log(entry) {
  appendFileSync(LOG_PATH, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function decide(body) {
  const messages = body.messages ?? [];
  const last = messages[messages.length - 1] ?? {};
  const text = typeof last.content === 'string'
    ? last.content
    : Array.isArray(last.content)
      ? last.content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join(' ')
      : '';
  const hasToolResult = messages.some((m) => m.role === 'tool');

  if (MODE === 'tool' && !hasToolResult && (body.tools ?? []).length > 0) {
    const firstTool = body.tools[0];
    const name = firstTool?.function?.name ?? firstTool?.name ?? 'unknown';
    return { kind: 'tool_call', toolName: name };
  }
  return { kind: 'text', text: hasToolResult ? 'MOCK_TOOL_ROUNDTRIP_OK' : `MOCK_OK len=${text.length} mode=${MODE}` };
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;

  if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model', owned_by: 'mock' }] }));
    return;
  }

  if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
    const raw = await readBody(req);
    let body = {};
    try { body = JSON.parse(raw); } catch {}
    const wantsStream = body.stream === true;
    const decision = decide(body);
    log({
      model: body.model,
      stream: wantsStream,
      messageCount: (body.messages ?? []).length,
      tools: (body.tools ?? []).map((t) => t?.function?.name ?? t?.name),
      decision: decision.kind,
    });

    const id = 'chatcmpl-mock';
    const created = Math.floor(Date.now() / 1000);
    const base = { id, object: 'chat.completion.chunk', created, model: body.model ?? 'mock-model' };

    const deltas = decision.kind === 'tool_call'
      ? [
          { role: 'assistant', tool_calls: [{
              index: 0, id: 'call_1', type: 'function',
              function: { name: decision.toolName, arguments: '' },
            }] },
          { tool_calls: [{ index: 0, function: { arguments: '{"path":"README.md"}' } }] },
        ]
      : [{ role: 'assistant', content: decision.text }];

    const finish = decision.kind === 'tool_call' ? 'tool_calls' : 'stop';

    if (!wantsStream) {
      const message = decision.kind === 'tool_call'
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: decision.toolName, arguments: '{"path":"README.md"}' } }] }
        : { role: 'assistant', content: decision.text };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id, object: 'chat.completion', created, model: body.model ?? 'mock-model',
        choices: [{ index: 0, finish_reason: finish, message }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    for (const delta of deltas) send({ ...base, choices: [{ index: 0, delta, finish_reason: null }] });
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] });
    send({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  log({ unmatched: path, method: req.method });
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not mocked: ' + path, type: 'mock_error' } }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock LLM on http://127.0.0.1:${PORT} mode=${MODE} log=${LOG_PATH}`);
});
