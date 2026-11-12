# 框架锐评 · 第 6 视角（可执行性）· 已核实

> **唯一一份真的在 Claude Code 2.1.289 上做了一遍安装演练的锐评。**
> 它先肯定了框架"真的对"的地方，然后指出最致命的一处——比白名单问题更严重。

---

## 一、先记它肯定了什么（这很重要）

从 Claude Code 二进制里提取的 agent 定义允许字段：

```
["name","description","prompt","tools","disallowedTools","model","effort",
 "permissionMode","mcpServers","hooks","maxTurns","skills","initialPrompt",
 "memory","background","omitClaudeMd","isolation"]
```

- `name` / `description` / `tools` / `model` **全部在列**——`MANUAL:92` 说"会被识别"是**准确的**
- `model: inherit` 是合法值
- `tools: Read, Grep, Glob, Bash` 每个都能解析
- `template` / `requires` / `wave` / `trigger_event` **不在列表里**，但那是**宽松过滤**而非严格校验，**不会导致 agent 失效**

**所以 `PORTABILITY.md:13` 说"不认识"是准确的，框架没有隐瞒。** 真正的问题不在"忽略"，而在被忽略的字段承载了**加载契约**，且没有替代通道。

---

## 二、最致命的一条：没有角色被授权写产物（我完整核实）

### 证据链（四段，缺一不成立）

**第一段：6 个 wrapper 的工具清单**

| wrapper | tools |
|---|---|
| `recon-scout` | `Read, Grep, Glob, Bash` |
| `sweep-scout` | `Read, Grep, Glob, Bash` |
| `audit-specialist` | `Read, Grep, Glob, Bash` |
| `critique-panel` | `Read, Grep, Glob` |
| `verifier` | `Read, Grep, Glob, Bash` |
| `fix-worker` | `Read, Grep, Glob, Edit, Write, Bash` ← **唯一有 Write** |

**第二段：没有任何模板指示子 Agent 写文件**

```bash
$ grep -rn "写到\|写入.*\.md\|Write.*产物" templates/ wrappers/ | grep -v "写入 findings\|写入 payload"
（零命中）
```

**第三段：主 Agent 被禁止写产物**

```markdown
<!-- report-naming.md:97 -->
主 Agent 只写两个文件——账本与最终报告。
它**不得**写任何波次产物文件。
```

**第四段：报告要求每行有 artifact_ref，找不到就删**

```markdown
<!-- final-report.md:67 -->
每一行的「出处」必须是 artifact_ref，指向能复核该结论的原始文件

<!-- final-report.md:153 -->
| 1 | 报告的每一行结论都有 artifact_ref | 找不到出处的条目**删掉** |
```

### 后果链

```
产物文件不存在
  ↓
artifact_paths 全空
  ↓
final-report:153 要求删掉所有无出处的条目
  ↓
最终报告结论表为空
  ↓
run-state:349 的兜底「以产物目录为准重建」也失效（没有产物可依）
```

**整个框架的交付物被自己的三条规则联合清零。**

### 为什么这比"白名单没有 Bash"更致命

| | 白名单问题 | 产物链路断裂 |
|---|---|---|
| 表现 | **当场打架**，肉眼可见 | **静默**，不报错 |
| 结果 | 报告缺一节 | **格式完美、结论为空的报告** |
| 发现难度 | 低 | 极高 |

**能静默失败的那个才最致命。**

---

## 三、其余已核实项

### 主 Agent 白名单是五个虚构符号

```markdown
<!-- protocol.md:259 -->
允许：spawn_agent / read_result / write_ledger / write_report / update_state
```

**这五个名字在 Claude Code 里一个都不存在。** 真实工具叫 `Agent`（旧名 `Task`），没有 `read_result`（子 Agent 的文本作为工具结果直接回父上下文）。

而实际需要的是：`Agent` + `Read` + `Write` + `Edit` + `Bash`。

**修法只需一行**（`protocol.md:263` 其实已经是这个意思——"主 Agent 仍然不得读取**源代码内容**"，对象是内容不是工具）：

```markdown
允许：Agent / Read(账本·报告·state.json) / Write(同上) / Bash(git status:*)(git diff:*)(git log:*)
禁止：Read(源代码) / Grep(源代码) / Edit(源代码)
```

### `tools` 里的 Bash 是无限制的

`verifier` 的 `tools: Read, Grep, Glob, Bash` —— **`Bash` 给了 `rm -rf`、`git commit`、`> file` 的全部能力**。"只读"完全靠 wrapper 里那一句话。

而 Claude Code **支持带作用域的写法**（`Bash(git log:*)`），框架**从没用过**。

**所以 `verifier` 和 `fix-worker` 拿到的 Bash 权限完全一样。**

### `critique-panel` 的规则与权限直接打架

```yaml
tools: Read, Grep, Glob        # 没有 Bash
```
```markdown
<!-- 同一文件 :33 -->
你的 `Bash` 权限仅用于只读取证（git log / git status / ...）
```

**它没有 Bash。这句是死文本。**

### "机械校验"没有校验器

```bash
全仓库 *.py / *.ts / *.js / *.json 文件数 = 0（只有 .md）
也没有一处提到 jq
```

**所谓"机械校验"实际是：主 Agent 用自然语言读一段文本，然后在脑子里逐条对照。** 这和"模型自律"是同一件事，只是换了个更严肃的名字。

**而清单本身还对不上**：`MANUAL:481` 的 `role` 是 5 个值，`output-contract:32` 是 6 个值（含 `sweep`）——**照 MANUAL 校验，每个宽扫返回都会被判 CONTRACT_VIOLATION**。

---

## 四、它给出的"最该改的一件事"

**把"产物文件"从隐含约定，变成契约里的必填字段 + 明确的生产者。**

三改合一：

1. `output-contract.md` 顶层信封加 `artifact_path`（string，必填）
2. 6 个 wrapper 的 `tools` 各加 `Write`，但只授权写自己那一个产物文件
   （`verifier` 除外——它应改为"不写产物，结果全走 payload"，因为"每人一个文件"与"零写入验收"本来就不相容）
3. 6 个模板的"返回前自检"各加一行硬指令：**把完整 JSON 写到 `<OUTDIR>/round{N}/...`，并把路径回填 `artifact_path`**

**为什么是这一件**：它同时修好三条彼此独立的断链——`final-report` 的 `artifact_ref`、`handoff-schema` 的 `artifact_paths`、`run-state` 的"以产物目录为准重建"。**而且它是唯一一条不需要写调度代码就能修好的致命项。**

---

## 五、我对它的评价

**这份是 13 份里唯一做了实证的。** 它：

- 真的把 wrapper 复制进 `.claude/agents/` 跑了一遍
- 从二进制里提取了 agent 定义的真实字段列表
- 核了全仓库的文件类型（确认没有校验器）
- 先肯定了框架对的地方（frontmatter 字段真的有效），再批评

**它找到的"产物链路断裂"是 13 份锐评里我完全没想到的一条**——而且它比所有人都在说的"白名单没 Bash"更致命，因为那条会报错，这条不会。

**我接受它的三改方案，但要加一条前提**：`verifier` 的处理需要重新设计。现在的规则是"验收 Agent 有写权限会破坏只读验收的设计"，但如果它不写产物，`final-report` 的 `artifact_ref` 就指不到验收结论——**这也是一个死结**。

可能的解法：**验收结论由主 Agent 写**（因为它是"拼接"而非"判断"），而 `verifier` 只返回 payload。这样既保持只读，又让结论有落点。
