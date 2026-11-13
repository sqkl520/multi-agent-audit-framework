# dsh 本机实验报告

日期：2026-11-13
环境：Windows，dsh `0.2.1-rc.2`（`~/.dsh-win/versions/0.2.1-rc.2`）

## 结论先说

**dsh 可以在这台机器上跑起来，多 agent 链路是真的。** 但由于本机所有真实 LLM 上游当前都不可用，我改用本地 mock LLM 服务器验证运行机制——结论来自真实进程执行，不是读代码推断。

四条被实测确认的事实：

1. **dsh 能启动并完成任务**（headless profile，输出落在 stdout）。
2. **单个 agent 首轮挂载 25 个工具**，其中包括 `subagent`、`subagent_fork`、`workflow`、`list_agents`、`send_message`。
3. **`subagent` 工具真的会创建独立子 agent**，子 agent 有自己的 session 目录、自己的 LLM 请求、自己的 turn 生命周期。
4. **`headless` 会等到子 agent 完成后才返回**，并且返回的是第 2 轮的答复（第 1 轮只是启动了子 agent）。

由此落成一个框架工具：`tools/dsh-session-audit.mjs`（12 个用例）。
它在真实 session 数据上跑出的第一件事是——本机 9 个 session 里 **4 个开了 turn 却零 assistant 消息**，
并且能说出每次的具体 `finish.reason`。

## 环境现状（为什么必须用 mock）

| 检查项 | 结果 |
|---|---|
| `dsh --help` / `--version` | 正常，`0.2.1-rc.2` |
| `~/.dsh-win/versions/0.2.1-rc.5` | **空目录**（只有 `node_modules` 骨架），不可用 |
| 全局 `npm` 的 `@deepseek-ai/dsh` | **空目录**，`dsh` 命令直接跑会 `MODULE_NOT_FOUND` |
| DeepSeek 官方 API | `QUOTA: Insufficient Balance` |
| 本机 cc-switch 代理 `127.0.0.1:15721` | 进程活着，Anthropic 端点上游 **HTTP 524**（超时） |
| 代理的 OpenAI 兼容端点 | 通，但上游 `S3 AI` 渠道 **503 无可用渠道** |
| `gs.mfawa.top` | `/v1/models` 返回 200，但 `/chat/completions` 全部超时 |
| `api.scnet.cn` | 返回 **402 Insufficient Balance** |

所以：**不接 mock 就无法验证任何一次真实 agent 运行。**

## 怎么接上 mock

dsh 的 provider 通过 `--patch` 覆盖，不需要改 profile 本体：

```yaml
[
  { id: llm-pi-ai, config: { providers: { mock: { displayName: "Mock",
      api: "openai-completions", baseURL: "http://127.0.0.1:18891/v1",
      apiKeyEnv: "MOCK_API_KEY",
      models: [ { id: "mock-model", name: "mock", contextWindow: 128000, maxTokens: 4096 } ] } } } },
  { id: agent-default-model, config: { provider: "mock", model: "mock-model" } }
]
```

启动命令：

```bash
MOCK_API_KEY=x node ~/.dsh-win/versions/0.2.1-rc.2/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --profile headless --patch ./patch-turn.yml "delegate this task to a subagent"
```

**关键坑**：mock 必须支持 SSE 流式。dsh 用 `stream: true` 发起请求，返回普通 JSON 会得到
`dsh: TRANSPORT: Stream ended without finish_reason`。

## 多 agent 实测证据

一次完整运行产生了 5 次 LLM 请求（顺序来自 mock 服务器日志，非推测）：

```
seq 1  parent  无工具结果          ← 父 agent 首轮
seq 2  title   0 个工具            ← 会话标题生成（独立调用）
seq 3  parent  有工具结果          ← 父 agent 拿到 "started subagent <id>"
seq 4  child   无工具结果          ← 子 agent 自己的首轮
seq 5  parent  收到 settle 通知    ← 父 agent 第 2 轮，此时子 agent 已结束
```

对应的 session 文件（zstd 压缩的 jsonl）：

- 父：`session-ecc5b264-.../session.v4.jsonl.zstd`（34 → 实际本次 32 事件）
- 子：`82757119-cfd1-45d1-8807-d5f82d3f52e6/session.v4.jsonl.zstd`（18 事件）

子 session 首个事件就写明了父子关系：

```json
{"type":"session","version":4,"id":"82757119-...","parentSession":"session-ecc5b264-...",
 "origin":"subagent","delegationDepth":1}
```

以及一条专门的描述事件：

```json
{"type":"subagent/descriptor","data":{"version":3,"mode":"continuable",
 "provider":"spawn","label":"probe child","agentProvider":"mock","agentModel":"mock-model"}}
```

## 三个值得注意的行为

### 1. 子 agent 的产出不是工具返回值

`subagent` 工具的返回是 `started subagent <id>`，**不是**子 agent 的答案。子 agent 的结论通过
`agent/inbox/spliced` 事件以 `subagent-settled` 形式注入到父 agent 的下一轮：

```json
{"type":"agent/inbox/spliced","data":{"inserted":[{
  "content":[{"text":"Background subagent 82757119-... finished and will do no further work unless you send it more."},
             {"text":"Its closing message:"},{"text":"CHILD_FINAL_OK"}],
  "source":{"kind":"subagent-settled","senderSessionId":"82757119-..."}}]}}
```

**这直接对应我们之前查到的失败模式**：如果调用方只看工具返回值，会认为结果是
`started subagent <id>`，而真正的产出在另一条事件里。这正是「agent 已经产出了但 AI 没意识到」的
机制级原因——不是模型疏忽，是**返回值语义就是「已启动」而不是「已完成」**。

### 2. headless 会自动多跑一轮

`headless` 不是在 turn 1 结束后就退出。它等到子 agent settle 通知到达、父 agent 跑完 turn 2 才返回，
输出的也是 turn 2 的答复。用可区分的应答验证过：

```
输出：TURN2_SAW_CHILD=CHILD_REPORT
```

如果 turn 1 和 turn 2 的答复不可区分，就会误以为「headless 只返回第一次的答案」。

### 3. 子 agent 被要求主动汇报

子 agent 的 inbox 里被注入了一段：

> Your parent agent id is "session-ecc5b264-...". Before you finish, send your result to that agent with
> `send_message({ agent_id: "...", message: "<self-contained result>" })`. The parent shares your workspace
> but does not automatically receive your transcript, tool output, or reasoning.

**框架自己知道并明说了「父 agent 不自动收到子 agent 的 transcript / 工具输出 / 推理」**——这句话本身
就是对我之前那个失败模式的产品级承认。

## 复现方法

```bash
cd experiments/dsh-probe
node mock-turn.mjs &                    # 启动 mock（端口 18891）
MOCK_API_KEY=x node ~/.dsh-win/versions/0.2.1-rc.2/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --profile headless --patch ./patch-turn.yml "delegate this task to a subagent"
cat mock-turn.log                       # 看 5 次请求的顺序
node read-sessions.mjs                  # 看 session 事件类型统计
node dump-sessions.mjs                  # 看父子 session 完整结构
```

## 本目录文件

| 文件 | 用途 |
|---|---|
| `mock-llm.mjs` | 最小 OpenAI 兼容 mock（含 SSE 流式） |
| `mock-multi.mjs` | 触发 `subagent` 的 mock（第一版） |
| `mock-turn.mjs` | 区分 turn 1 / turn 2 的 mock，用于验证 headless 等待行为 |
| `patch-mock.yml` | 指向单轮 mock 的 patch |
| `patch-multi.yml` | 指向多 agent mock 的 patch |
| `patch-turn.yml` | 指向 turn-probe mock 的 patch |
| `read-sessions.mjs` | 统计 session 事件类型 |
| `dump-sessions.mjs` | 导出父子 session 关键事件 |
| `probe-providers.mjs` | 探测本机所有 provider 端点可用性 |
| `list-mfawa.mjs` | 列可用模型 |

## 局限（必须说清楚）

- **mock 的智能是假的**。它按固定规则应答，不反映真实模型的行为。以上结论只关于
  **dsh 的运行机制**，不关于模型能力。
- **没有验证真实 provider 下的多 agent 质量**。上游恢复后需要重跑。
- **`maxActiveSubagents` 默认 8**，本次只测了 1 个子 agent。并发上限、深度限制（`maxDepth` 默认 1）、
  取消传播都未测。
- **`workflow` 工具存在但未测**。本次只验证了 `subagent`。
