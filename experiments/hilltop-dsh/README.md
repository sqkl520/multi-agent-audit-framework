# 用 dsh 主控审计 Hilltop Village：现状与阻塞

**日期**：2026-11-14
**要求**：测试的主线程不由 Claude Code 主会话承担，改为指挥 dsh 去执行。

---

## 审计目标

`<TARGET_REPO>`

| 项 | 值 |
|---|---|
| 语言 | Java（Minecraft Paper 插件） |
| 规模 | **153 个文件 / 57,852 行** |
| 模块 | admin / ai / arena / command / config / core / diagnostic / doc / gui / mechanics / shop / stats / util（15 个） |
| 构建 | Maven（`pom.xml`） |

这是个真实、够格的目标——不是玩具代码。

---

## 阻塞：没有任何可用的 LLM 上游

dsh 是**纯编排器**，它自己不产生智能。没有可用模型，它就派不出 agent。

2026-11-14 19:17–19:23 逐条探活：

| 上游 | `/models` | 实际对话 | 判定 |
|---|---|---|---|
| `api.scnet.cn` | 200 | **402 Insufficient Balance** | 余额不足 |
| `gs.mfawa.top` | 200 | **60s 超时（AbortError）** | 不通 |
| cc-switch `127.0.0.1:15721` | —— | Anthropic 端点 524 / OpenAI 端点 503 无可用渠道 | 上游挂了 |
| `api.deepseek.com` | —— | 401 | 无有效 key |
| `api.furry.vg` | —— | 401 | 无有效 key |
| `uuapi.net` | —— | 10s TypeError | 不通 |
| 本机 ollama / LM Studio / llama.cpp | —— | 无 | **未安装** |

> 注意 `/models` 返回 200 **不代表能用**——scnet 和 mfawa 都返回 200，但一个余额不足、一个对话超时。
> 这正是本仓库反复出现的教训：**别拿一个看起来相关的指标（能不能列模型）代替真正的判据（能不能对话）**。

---

## 已验证可用的部分：dsh 的编排链路是通的

用一个 mock 模型跑通了完整链路，**这不是推演，是实测**：

```
父 session  session-59b11e76-…
  parentSession: (顶层)   delegationDepth: 0
  → 工具: subagent {prompt: "CHILD_MARK 审计 core 模块的并发问题"}
  → 文本: PARENT_TURN1
  → 文本: PARENT_SAW_CHILD_RESULT

子 session  1db6c1ef-…
  parentSession: session-59b11e76-…    origin: subagent   delegationDepth: 1
  → 工具: glob {path: "pom.xml"}          ← 子 agent 真的去读了目标文件
  → 文本: CHILD_DONE: read the file
```

**证明了三件事**：
1. dsh 的子 agent 有独立的 session，`parentSession` / `origin` / `delegationDepth` 都正确记录
2. 子 agent **真的调用了工具去读目标代码**（`glob pom.xml`），不是凭空编
3. 子 agent 的结果**回到了父 agent**（`PARENT_SAW_CHILD_RESULT`）

缺的只有真实模型。

---

## 现在能做的：一份可直接跑的配置 + 任务书

`experiments/hilltop-audit-via-dsh.mjs` 生成两样东西：

1. **dsh patch 配置** —— 指定 provider / baseURL / model / apiKeyEnv
2. **审计任务书** —— 写清了目标路径、执行顺序、重点维度、产物要求

上游一恢复，一条命令就能跑：

```bash
node experiments/hilltop-audit-via-dsh.mjs \
  --endpoint https://api.scnet.cn/api/llm/anthropic/v1 \
  --key-env SCNet_API_KEY \
  --model DeepSeek-V4.1-Flash-1017
```

它会打印完整运行命令。

### 任务书里针对这个仓库的重点

按这个代码库的实际情况排序，不是照抄通用清单：

- **concurrency**：Minecraft 插件最常见的缺陷源。Bukkit API 大多必须在主线程调用，
  异步任务里碰世界状态 = 定时炸弹。重点 `core/`、`arena/`、`mechanics/`
- **data-consistency**：玩家数据落盘、异常路径下的部分写入
- **error-handling**：插件异常会拖垮整个服务器 tick
- **contract**：GUI / 命令的输入校验

### 明确写了「不许绕过的要求」

任务书里有一条是从本框架的实测教训来的：

> 必须加载 wrapper 全文，**不许自己编简化版任务书**——
> 实测过：绕过 wrapper 手写任务书，16 份产物 0 份合规。

这条不是建议。`WRAPPER-EFFECTIVENESS.md` 记录了一次真实派发：同一个 agent，
给了 wrapper 全文就产出合规产物，给了手写任务书就全不合规。

---

## 复现

```bash
# 探活各上游（默认行为）
node experiments/hilltop-audit-via-dsh.mjs

# 上游可用后生成配置与任务书
node experiments/hilltop-audit-via-dsh.mjs --endpoint <url> --key-env <ENV> --model <id>
```

---

## 局限

- **没有产生任何真实的审计结论。** 本次只验证了编排链路，没有审计 Hilltop Village 的任何一行代码。
- mock 模型的输出是固定的，它证明「dsh 会派 agent 去读文件」，不证明「agent 读懂了」。
- 上游恢复后需要重跑，并人工检查产物是否符合契约（`check-payload.mjs --role <role>`）。
