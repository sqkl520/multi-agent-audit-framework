# R8 集成：把 harness 对账接进 stop-hook

**时间**：2026-11-15
**触发**：R8 自己在报告 §5.2 指出「残余绕法 1（真洞）：不接进流程 = 不产生约束力」

---

## R8 的原话

> **工具存在 ≠ 有人在跑它。**
> 判据已经存在且被真实数据验证过；**约束力取决于下一轮有没有人把它挂到 stop-hook 上**。
> 在挂上去之前，它是「可用的证据」而不是「生效的闸门」。

它说得对。而且这正是我在诊断里反复批评的那个模式——**规则写下但没人执行**。
我自己的任务书限定「不要注册到 check-all」，结果亲手造了一个同样的缺口。

---

## 做了什么

在 `tools/stop-hook.mjs` 加了 §3.6：wave4/wave5 且 `DSH_SESSIONS_ROOT` 存在时，
调用 `check-fix-instances-harness.mjs`，把它的 FAIL 提升为本 hook 的 problems。

### 遇到的三个问题（都是真问题，不是实现细节）

**问题 1：`--json` 的输出结构我猜错了**

我第一版写的是 `res.findings[]` 和 `f.msg`。实际是 `res.problems[]` 和 `f.message`。
如果没去读源码核实，这条集成会永远静默失效。

**问题 2：真实环境的 sessions root 有 19 个 project 目录**

`check-fix-instances-harness.mjs` 在多 project 时报 `project_dir_ambiguous`（exit 2），
立场是「不猜」。这个立场对**工具**是对的，但如果**集成层**也照抄，
这条对账在真实环境永远跑不起来——等于没接。

**推断的责任在调用方。** 所以我在 stop-hook 里实现了 project 目录推断：

```
dsh 的目录名编码（实测）：
  空格 → ~0020
  路径分隔符与冒号 → -
  字母/数字/下划线 _/连字符 - 原样保留
  整体包一层 --
```

从 `state.json` 所在目录向上找三级（按 `docs/reports/round{N}/state.json` 的约定），
逐级编码后与真实目录名精确比对。

**问题 3：我第一版把 `_` 也替换成了 `-`**

真实目录名：

```
--D-Projects-AI~0020prompt-many-agents_multi-prompt-files_token-heavy-multi-agent-audit-framework--
```

我的编码结果把 `_multi-prompt-files_token-heavy` 变成了 `-multi-prompt-files-token-heavy`，
**永不匹配**，集成静默失效。

这个 bug 只有靠「把编码结果和真实目录名打出来逐字对比」才能发现。
如果我只跑测试（测试用的是合成目录，恰好用同一套错误编码生成的），**测试会全绿而集成是坏的**。

---

## 验证：洞 1 真的堵住了

用真实 session 日志构造「8 条发现 / 3 个假 id / 0 次真实 subagent」场景，
通过 stop-hook 跑，输出：

```
[交付粒度检查] 还不能结束这一回合：

1. 账本声称与实际派发对不上（zero_subagent_but_multiple_agents）：
   账本里有 3 个不同的 fix_agent_id（fake-agent-1、fake-agent-2、fake-agent-3），
   但 harness 日志显示这个主 session 一次 subagent 都没有发起
   （本 session 实测：113 次工具调用、66 个 step、0 次 subagent）。
   这与 2026-11-15 那次真实事故完全同形：303 次工具调用、196 个 step、0 次 subagent
   ——主 Agent 在自己一个 session 里串行做完了全部修复，
   然后在账本上把「我修了 3 条」写成了「我派发了 3 个实例」。
   账本记的是主 Agent 对自己工作的印象，session 日志是外部事实。

2. 账本声称与实际派发对不上（spawned_count_exceeds_real）：
   budget.spawned_fix_agents = 3，但 harness 日志显示主 session 只发起了 0 次 subagent 调用。
```

**三条防线全部触发**，且错误消息直接引用了真实事故的数字。

---

## 新增的测试（stop-hook.test.mjs case 18–20）

| 用例 | 断言 |
|---|---|
| case 18 | 3 个假 id + 0 次真实 subagent → **exit 2**，报 `zero_subagent_but_multiple_agents`，错误消息引用外部事实 |
| case 19 | 真派 3 次 + 3 个 id + spawned=3 → **exit 0**（不误拦） |
| case 20 | 推断不出 project 目录 → **exit 0**（环境问题不拦人） |

case 20 是必要的：不能让一个只支持 dsh 的判据在别的 harness 上把流程卡死。
R8 的工具本身已经在 `unsupported_harness` 上做了降级，集成层要保持一致。

**结果：33 通过 / 0 失败**（原有 28 条 + 新增 5 条断言）。

---

## 残余局限（必须记下来）

1. **只有 dsh 能用。** Claude Code 的 session 格式不同（`~/.claude/projects/<slug>/<uuid>.jsonl`），
   未实现适配器。在 Claude Code 上这条对账会降级跳过。
   这不是「支持了但有 bug」，是「明确没做」——R8 在文件头写清了映射方式，留给后续。

2. **推断失败时静默跳过。** 如果 `state.json` 不在约定的 `docs/reports/round{N}/` 下，
   推断不到 project 目录，这条对账不生效。这是有意的降级，但它确实是一个口子：
   把 `state.json` 放到别处就能绕开。

   要不要改成「推断失败就报 WARN」？我倾向于不——那会让每个不符合目录约定的项目
   都收到噪音，而目录约定本来就写在 `run-state.md:35` 里。**但这是一个判断，不是事实。**

3. **真派 8 次但子 agent 空跑** 仍然通过（R8 §5.3 已记录）。
   这条检查器只验证「派发发生了」，不验证「派发有效」。要堵需要看子 session 的产出，
   属于下一层。

---

## 一句话

**洞 1 从「账本自述互相对账」升级成了「账本 vs harness 运行时事实」。**
伪造成本从「改一个 json 文件」跳到「篡改 zstd 日志且保持 seq 连续性」。
这不能证明永远不会被绕过，但它把「无意退化」和「刻意伪造」分开了——
前者是这次事故的成因，后者是另一个问题。
