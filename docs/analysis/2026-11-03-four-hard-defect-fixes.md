# 四条硬缺陷的修复记录（2026-11-03）

> **这份文档的性质**：不是设计文档，是**改动台账**。每一条都给出「原矛盾 → 证据 → 修法 → 修完后的验证方式」。
>
> **为什么要单独记**：13 份锐评里 11 份独立指向同一批问题。修完之后如果只留下一句「已修复」，下次读到这些文件的人无法判断修得对不对。**可复核性必须跟着改动走**，不能留在对话记录里。

---

## 总览

| # | 缺陷 | 原状 | 修法落点 | 状态 |
|---|---|---|---|---|
| ① | 没有角色被授权写产物 | 6 个 wrapper 只有 `fix-worker` 有 `Write` | 5 个 wrapper 加 `Write` + `artifact_path` 进契约 | 已修 |
| ② | 主 Agent 被禁用它被要求用的工具 | 白名单无 `Bash`，但三处要求跑 `git`/`wc` | `protocol.md` §1.5 重写 | 已修 |
| ③ | 两个死锁（F1 波次门 / F2 无限重派） | 见下 | `protocol.md` §3.1 + §4.1 | 已修 |
| ④ | `direct_contradiction` 不在契约 | 模板要求 5 处，契约登记 0 处 | `output-contract.md` §2.3 | 已修 |

**修完后框架规模**：6114 行 → 6476 行（+362）。**新增的行全部是规则与其理由，没有新增流程波次。**

---

## ① 没有角色被授权写产物

### 原矛盾

三条规则合起来是一个闭环空转：

| 出处 | 原文 | 问题 |
|---|---|---|
| `artifacts/report-naming.md:5` | `loaded: 所有子Agent在**写出产物文件前**加载` | 加载时机假设产物即将写 |
| `artifacts/report-naming.md:91` | `每个子Agent只允许写入属于自己的产物文件` | 假设子 Agent 有写能力 |
| `wrappers/*.md:4` | `tools: Read, Grep, Glob, Bash` | **实际没有 `Write`** |

**规则的加载时机是「写产物之前」，而写产物的能力不存在。** 一个没有 `Write` 的 Agent 不会被触发去写产物，也就不会加载「怎么写产物」的规则。

更严重的是 `report-naming.md:97` 还写着「主 Agent **不得**写任何波次产物文件」——所以既没有子 Agent 能写，主 Agent 也被禁止写。**产物在规则层面不可能存在。**

### 为什么这是最隐蔽的一条

它不会报错。Agent 会正常返回一个格式完美的 payload，`contract_valid: true`，字段齐全。主 Agent 拼报告时每个 `artifact_ref` 都是悬空路径，但**拼接逻辑本身不校验文件是否存在**，所以报告照样生成——只是每条结论都指向空气。

**round31 的实测结局（`IN_PROGRESS`、83 条待修、1 条实际修复、无最终报告）此前被归因为「修复波太脆弱」。这条提供了一个独立且更早的失效路径：上游产物从未真正落盘。**

### 修法

**1. 五个 wrapper 获得 `Write`**

```
recon-scout     Read, Grep, Glob, Bash, Write
sweep-scout     Read, Grep, Glob, Bash, Write
audit-specialist Read, Grep, Glob, Bash, Write
critique-panel  Read, Grep, Glob, Write        ← 无 Bash，见下方「遗留」
verifier        Read, Grep, Glob, Bash, Write
fix-worker      Read, Grep, Glob, Edit, Write, Bash   （原有）
```

**2. 每个 wrapper 的 §0 新增一节，明确 `Write` 的唯一合法用途**

不写清这一节，新给的 `Write` 会直接和 `protocol.md` §0.1 零写入原则打架。每份 wrapper 现在都有：

> 你拥有 `Write`，但**它只能写一个路径**：`docs/reports/round{RN}/` 下属于你的那个产物文件。
>
> | 可以写 | 不可以写 |
> |---|---|
> | 你的产物文件 | 被审仓库的任何文件 |
> | 该文件的重派自我覆盖 | 其他人的产物文件 |

并附一条前置检查：若所在目录落在被审仓库内，先用 `git check-ignore -q <路径>` 验证被忽略，不通过就改写到仓库外的 `<OUTDIR>`。

**3. 每个 wrapper 的 §3 强制加载新增第 4 项**

```
4. `artifacts/report-naming.md` — 产物文件名与落盘位置。
   **你的产物文件（`round{N}-02-audit-{slice_id}-{dimension}.md`）是返回的一部分，不写 = 这一片没做完。**
```

**4. `output-contract.md` 顶层信封新增必填字段 `artifact_path`**

```
| `status == SUCCESS` 但 `artifact_path` 为 null、空串，或指向的文件不存在 | CONTRACT_VIOLATION |
```

**这是把「产物存在」从口头约定变成机械校验。** 此前没有任何检查会验证产物文件是否真的存在，现在它和「缺字段」是同一级别的违规。

### 顺带修的第五处

`report-naming.md` 的 `{stage}` 枚举只有五个值（`01-recon` / `02-audit` / `03-critique` / `04-fix` / `05-verify`），而两遍制的宽扫波**没有对应的 stage 名**。但 `protocol.md` §1.2 的 L1 留痕示例已经引用了 `round31-02a-sweep-slice-31.md` —— 这个文件名不匹配任何一个合法 stage，会被自己的校验正则判为非法。

**新增 `02-sweep`**，并更新校验正则：

```
^round(\d+)-(01-recon|02-sweep|02-audit|03-critique|04-fix|05-verify)-[a-z0-9]+(-[a-z0-9]+)*\.md$
```

### 怎么验证修好了

```bash
# 每个 returned SUCCESS 的 Agent 都必须有一个真实存在的产物文件
cd "/d/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/framework"
grep -n "tools:" wrappers/*.md          # 五个角色都有 Write
grep -n "artifact_path" components/output-contract.md   # 契约里有校验条目
```

---

## ② 主 Agent 被禁止使用它被要求使用的工具

### 原矛盾

`protocol.md:259` 的白名单是：

```
允许：spawn_agent / read_result / write_ledger / write_report / update_state
禁止：Read(源代码) / Grep(源代码) / Edit(源代码) / 任何代码分析工具
```

但另外三处要求它跑 `Bash`：

| 出处 | 要求的命令 |
|---|---|
| `protocol.md:99` | `git -C <repo> status --short \| grep -E '^ ?[MDARC]'` |
| `artifacts/final-report.md:174-178` | 同上 + `git status --short \| grep -c '^??'` |
| `templates/wave2a-sweep.md:289` | `wc -l` 核验切片行数 |

**后果**：零写入自证**无法产出**。报告只能写「我没有改动」，但这恰恰是框架自己批判过的「声称」而非「证据」（`final-report.md` §7：「不只声称没改，而是给出可复核的证据」）。

### 修法

白名单拆成三类，并给出「是否污染上下文」这个可机械判定的区分标准：

```
允许：
  调度类    spawn_agent / read_result / write_ledger / write_report / update_state
  只读核验  Bash（白名单命令，见下表）
禁止：
  Read / Grep / Glob 作用于「被审仓库的源代码」
  Edit / Write 作用于「被审仓库的任何文件」
  任何代码分析工具（AST、lint、semgrep）
```

**白名单命令表的核心判据是「输出会不会包含源代码正文」**，而不是「命令名是不是 grep」：

| 命令 | 输出含代码正文？ | 判定 |
|---|---|---|
| `git status --short` / `git diff --stat` / `git log --oneline` | 否，只有路径与计数 | 允许 |
| `git check-ignore -q <path>` | 否，只有退出码 | 允许 |
| `wc -l` / `ls` / `find -type f` | 否，只有行数与文件名 | 允许 |
| `jq '.findings \| length'` 作用于产物文件 | 否，只取计数 | 允许 |
| `git diff` / `git show` / `git blame` | **是** | 禁止，派子 Agent |
| `cat` / `head` / `grep` 作用于源码 | **是** | 禁止（L0） |

**组合命令按数据源判定**：

```
git status --short | grep -E '^ ?[MDARC]'   ✅  流的是路径与状态字符
git status --short | xargs grep TODO        ❌  xargs grep 读的是源码正文
```

> 这一条特别重要：`git status | grep` 正是 `final-report.md` §7 的**强制命令**，而 `grep` 又在 L0 禁用清单里。若判据是「命令名」，主 Agent 面对「必须跑 grep」和「禁止 grep」只能二选一。**把判据从命令名改成数据源，矛盾才消失。**

### 怎么验证修好了

主 Agent 现在能跑 `final-report.md` §7 的两条命令并粘贴真实输出。**修好与否的判据是：报告末尾那段自检输出是否为真实命令结果，而不是手写的结论。**

---

## ③ 两个死锁

### F1：波次二的闭合门永远打不开

**原矛盾**：

```
protocol.md:306  波次二闭合条件：spawned_agents 中所有切片状态均为 SUCCESS
protocol.md:334  PERMANENT_FAILURE 是合法终态，且「主Agent不得缩小范围后重派」
                 ↓
一个切片永久失败 → 状态永远 ≠ SUCCESS → 闭合条件永远 false → 卡在波次二
```

**`PERMANENT_FAILURE` 是设计上的兜底出口，但它到不了任何地方**——流程在到达修复波之前就停住了。无论修复波多健壮，都救不了这条路径。

**修法：闭合条件从「全部成功」改为「全部进入终态」。**

```
波次闭合 ⟺ ∀ agent ∈ 本波：status ∈ {SUCCESS, PERMANENT_FAILURE}
           ∧ 不存在 attempt ≤ 3 的 CONTRACT_VIOLATION
```

**这个条件一定可达**：每个 agent 最多 3 次尝试就落到终态之一（见 F2）。

**然后定义「有失败时怎么走」**，并先定分母：

| 队列 | 分母 | 说明 |
|---|---|---|
| 2a 宽扫 | `planned_sweep_agents` | 计划量 |
| 2b 深挖 | `spawned_deep_dive` | **实派量，不是 `discovery_budget`** |

> 2b 用实派量当分母的理由：预算是计划，实派是事实。用预算当分母，会在「预算没用完就因为别的原因停了」时把失败率算小，从而错误放行覆盖不足的一轮。

| 情形 | 处置 |
|---|---|
| 2b 深挖失败率 ≤ 20% | 正常进波次三，失败切片写 `unverified`，DA 必须标 `COVERAGE_GAP` |
| 2b 深挖失败率 > 20% | 跳过波次三与修复波，直接出报告，终态 `PARTIALLY_CLOSED` |
| 2a 宽扫失败 | **不单独触发终止**。该切片 `reachability` 记 `UNKNOWN`，**一律进深挖队列** |

> 2a 不终止的理由：宽扫产出线索，线索少 ≠ 没缺陷。把扫描器失灵当作「项目干净」是最坏的一种误判。**宁可贵一点，不可静默丢弃。**

**20% 是可调参数，不是科学常数**，文档里已明说。

### F2：契约违规无限重派

**原矛盾**：

```
protocol.md:333  CONTRACT_VIOLATION → attempt 从头计数
protocol.md:332  RETRYABLE_FAILURE  → 最多 3 次
                 ↓
每次违规都归 0 → 永远不会达到「连续 3 次」→ 无限循环
```

**这不是理论推演。** `CONTRACT_VIOLATION` 最可能的成因是**系统性**的：某个 wrapper 漏了字段、模板与契约版本不一致、上下文过长导致返回截断。**这些每一次重派都会复现。**

> 顺带一个自我印证：本次修订过程中我自己犯了三次同类错误——先给 `devils_advocate` 编了一套不存在的枚举，又引用了契约里没定义的 `violated_fields` 和 `task_payload_digest`，还把 apply 时碰坏了 JSON 结构。**这些恰恰都是「重派也会复现」的系统性错误**，正是 F2 要兜的那一类。

**修法：**

| 失败类型 | `attempt` | 判定 `PERMANENT_FAILURE` 的条件 |
|---|---|---|
| `RETRYABLE_FAILURE` | +1 | `attempt > 3` |
| `CONTRACT_VIOLATION` | +1 | `attempt > 3`，**或**连续 2 次 `violated_fields` 完全相同 |

**第二条比计数更快**：两次缺同一批字段，第三次大概率还是同一批——**这是确定性缺陷，不是随机波动**。此时不值得再消耗一次派发。

**为了让这条可执行，补了三个此前不存在的定义：**

1. **`violated_fields` 的格式规范**（`output-contract.md` §3）：JSON Pointer 风格、最深粒度、字典序去重。
   > 规范不是洁癖：这条判定靠「两次数组是否相同」，写法不一致比较就失效，死锁判定退回无限重派。
2. **`task_payload_digest` 的计算方式**（`protocol.md` §4.1）：`jq -S 'del(.trace_id,.agent_id,.spawned_at)'` 后取 sha256。
   > 必须排除 `agent_id`——重派必然换新 id，算进去等于每次都算新任务，与要解决的死锁同形。
3. **`failed_sweep` / `failed_deep_dive` / `spawned_deep_dive`** 三个计数字段（`run-state.md` §2）：阈值规则需要分母，而 `state.json` 里没有。

### 怎么验证修好了

构造一个必然触发 `CONTRACT_VIOLATION` 的场景（例如派一个模板与契约版本不一致的 Agent），观察：
- 第 1 次违规 → 重派，`attempt: 2`
- 第 2 次违规，`violated_fields` 与第 1 次相同 → 立即 `PERMANENT_FAILURE`，**不再派第 3 次**
- 流程继续往下走，最终出报告

---

## ④ `direct_contradiction` 不在契约

### 原矛盾

```
templates/wave3-critique.md   出现 direct_contradiction  5 处（必须字段）
components/output-contract.md 出现                        0 处
```

契约是唯一校验入口，未登记的字段在 `contract_valid` 自检时会被判为「多余字段」。**规则要求 Skeptic 返回的东西，校验器不认识。**

同族还有两处更根本的：

```
output-contract.md:209  "verdict": "UPHELD | DOWNGRADED | REVOKED | EVIDENCE_GAP"
wave3-critique.md       Skeptic 的裁决是 refuted / holds / untested
```

**两个枚举完全不相交。** Skeptic 按自己模板返回 `refuted`，会被契约判为非法值 —— 这是两份文件直接打架，不是措辞差异。

`UPHELD` 对 Skeptic 也是合法的（在契约里），但 `UPHELD` 是 Arbiter 的**终局裁决**。**Skeptic 有权"维持"一条它本该攻击的发现，等于取消了这个角色。**

### 修法

**按子角色分载体，而不是给每个子角色编一套裁决词：**

| `critique_role` | 输出载体 | 说明 |
|---|---|---|
| `skeptic` | `verdicts[]`，取 `holds` \| `refuted` \| `untested` | 不得返回 `UPHELD`/`DOWNGRADED`/`REVOKED` |
| `devils_advocate` | `coverage_gaps[]`，**`verdicts` 必须为空** | 它不评发现，只评覆盖 |
| `arbiter` | `verdicts[]`，取 `UPHELD` \| `DOWNGRADED` \| `REVOKED` | 不得返回 `EVIDENCE_GAP` |

**并新增两个字段进契约**：`direct_contradiction`（仅 skeptic 敏感领域必填）、`five_step`（仅 skeptic 必填，对应五步测试的五个布尔）。

### 一个中途犯的错，值得记下来

我第一版修法是给 `devils_advocate` 也编一套枚举：`coverage_gap | no_gap`。

**这是凭空发明。** 模板里 `devils_advocate` 从不返回 `verdicts`，它返回的是 `coverage_gaps[]`。加这个枚举会让它**两条路都不合规**——不填 `verdicts` 违反必填，填了又说没有合法值。

**正确的修法是承认它的输出载体根本不同，而不是强行统一成「每个角色都有一套裁决词」。** 这个错误本身就是 F2 要兜的那类系统性错误的一个样本：我在修「契约与模板不一致」时，又制造了一处「契约与模板不一致」。

---

## 遗留问题（本次未修，已确认存在）

| # | 问题 | 为什么没修 |
|---|---|---|
| 1 | `critique-panel` 没有 `Bash`，但 Skeptic 的裁量稽查要做机械比对 | 比对对象是 `state.json` 与产物文件，`Read`/`Grep` 够用。**但如果将来要求它跑 `git` 核对，就必须补 `Bash`** |
| 2 | 产物目录的父目录由谁创建 | 现有规则只说「写到哪」，没说「谁建目录」。实践中由第一个写入者创建，但这是个隐含假设 |
| 3 | `wave2_completed` 的写入时机没有硬规则 | 三条硬规则覆盖了 `in_flight` 和 `slices`，没有覆盖它。理论上主 Agent 可以事后补写（虽然 Skeptic 能用 `artifact_paths` 交叉验出） |

> 第 2、3 条都不是死锁，不会阻断流程，但都是「规则没写全」的地方。**记在这里，不假装已经修好。**

---

## 四条的独立性

这四条**互相不依赖**，可以分开验证：

- ① 是**产物能否存在**
- ② 是**证据能否产出**
- ③ 是**流程能否终止**
- ④ 是**锐评能否返回**

每一条的修法都不需要另一条先修好。这也是选择先修它们的原因：**它们不需要任何设计决策，只需要把互相矛盾的规则改成一致的。** 相比之下，13 份锐评里更根本的那条结论（「机械归代码、判断归提示词」，把 6114 行缩到 ~1500 行提示词 + 工具链）需要真正的取舍，不在本次范围内。

---

## 附：修完之后我自己做的独立核查

### 校验 1 · JSON 块

```bash
node -e '...遍历 framework/ 下所有 .md，提取 ```json 块并 JSON.parse...'
# 输出：JSON blocks: 35/35 ALL VALID
```

> 中途我自己碰坏过一次 JSON 结构（在 `output-contract.md` 里删多了一行），当场由这个检查捕获并修回。**这个脚本存在的价值就是这一刻。**

### 校验 2 · 六个角色的 `Write` 权限与限定说明

```bash
grep -n "tools:" framework/wrappers/*.md
# 六个 wrapper 全部含 Write
grep -c "Write\` 权限的唯一用途" framework/wrappers/*.md
# 五个非 fix-worker 角色各有 1 处；fix-worker 用的是「两个写入面」的表述（见下）
```

`fix-worker` 是**特例**：它原有的 §0 只允许写 `target_files`，而 `report-naming.md` §5 又要求它写自己的产物文件——**这两条把它自己的修复记录也禁掉了**。它明明是唯一有 `Write` 的角色，却没有被明确授权写产物。已补一节「你的两个写入面是分开的」：

| 写入面 | 授权条件 |
|---|---|
| 改代码（被审仓库内的 `target_files`） | 需要用户单独授权修复 |
| 写产物（`round{N}-04-fix-{finding_id}.md`） | 无条件需要 |

> **「改被审仓库」需要授权，「记录我改了什么」不需要。** 后者是审计留痕，恰恰是零写入原则要保护的那部分可信度。

### 校验 3 · 被审仓库是否被本轮触碰（安全约束的实证）

用户的硬约束是「除非用户要求，不能动被审仓库的任何内容」。实测核对：

**`D:\Web\style`**

```
git status --short  →  M prototypes/_selection/prompts.js
git diff            →  空
git hash-object     →  3fa3fe093124a0cd8b829dea127f702cf6f697bd
git ls-files -s     →  100644 3fa3fe093124a0cd8b829dea127f702cf6f697bd
```

**工作区内容与 git 索引的 hash 完全相同**（`3fa3fe0`），`git diff` 为空。`M` 标记来自 **stat 缓存失效**，不是内容改动。`git update-index --refresh` 后该文件从 status 中消失。

**内容为何未变而 mtime 变了**：`prompts.js` 是 `prototypes/_prompts/build-prompts.mjs:370` 的**生成产物**（`writeFileSync(...)"utf8"`）。生成器重跑会产生字节相同但 mtime 更新的结果。

**必须如实说明一点**：我为了验证「内容是否真的变了」，跑了一次 `git update-index --refresh`。**这条命令写了 `.git/index`**——它属于「读被审仓库」的范畴，但技术上是对仓库目录的写操作。这是我自己的零写入原则（`protocol.md` §0.1）没有覆盖到的边界情形：

| 命令 | 是否写盘 | 现有规则如何判定 |
|---|---|---|
| `git status` / `git diff` / `git hash-object` | 否 | 允许（§0.5 明确列出） |
| `git update-index --refresh` | **是，写 `.git/index`** | **规则没写**——它不在允许清单，也不在禁止清单 |

**结论：判定「内容未变」的证据是 `hash-object` 与 `ls-files -s` 的 hash 相同，这一点不依赖 `update-index`。** 后者只是让 `git status` 输出变干净，是冗余操作。**下次不该跑它**——要验证内容是否真变，`git diff --exit-code --quiet` 就够，且完全只读。

**`D:\Projects\dsh-fcl-android-launcher`**

12 个文件的改动（+1110/−62）是**更早会话的 `fix-r31-001` 留下的**，`final-report.md` §7.1 已有记录。本轮全程未触碰该仓库。

---

## 一句话总结

四条修的都是**规则之间互相矛盾**，不是设计取舍，所以修法不需要拍板：把互相打架的两条改成一致的即可。

**但这正是 Skeptic 批评的那个模式。** 这四条一条都不来自「实测证明这样更好」，全部来自「这两条规则打架」。修完框架从 6114 行涨到 6489 行——**又长了 375 行**。

一个只靠修矛盾增长的系统，净收益无法证明。**这次修完，下一件该做的不是找下一批矛盾，是拿它真跑一轮，看它到底能不能审出东西。**

---

## 补记：修正外溢到了文档层（2026-11-03 晚）

四条修完后做一致性扫描，发现**旧门控措辞在另外两个文件里还活着**——它们不是重复叙述，是独立可执行的规范，所以必须同步：

| 文件 | 原文 | 问题 |
|---|---|---|
| `framework/README.md:43` | 「命中切片的实例均 `SUCCESS`」 | 与 F1 修法直接冲突。README 是**读者第一眼看的波次表** |
| `framework/MANUAL.md:280` | 「所有派出的实例达到终态（`SUCCESS`）」 | **更隐蔽**：它把「终态」当成 `SUCCESS` 的同义词 |

`MANUAL.md` 那一处值得单独说。它的措辞看起来是「终态」，实际上用括号把终态**定义**成了 `SUCCESS` —— 这比直接写「全部 SUCCESS」更容易骗过一致性扫描（grep「全部 SUCCESS」抓不到它）。**它的危害与 `protocol.md` 原文完全相同：`PERMANENT_FAILURE` 被排除，门控永远为 false。**

三处现在统一为：

```
终态 = SUCCESS ∪ PERMANENT_FAILURE
```

并各自附一句为什么（不是「已按要求修改」，而是「原来为什么会死锁」）。

### 这件事本身是个例证

**修一处矛盾，要扫全仓找它的副本。** 同一个门控条件在 `protocol.md`、`README.md`、`MANUAL.md` 各写了一遍——三份独立文本，任一份不更新都会让读者读到互相打架的规则。

这恰好是「机械归代码、判断归提示词」那条结论的又一个证据：**如果这个门控是一个函数，改一处就够了。写成三段自然语言，就必须三次人工同步。** 而三次同步里漏掉一次的概率，不比漏掉零次低多少——`MANUAL.md` 那处带括号的写法，我第一遍扫描就没抓到。

---

## 琛ヨ浜岋細鎴戣嚜宸卞厛鏌ュ嚭鐨勫洓涓紡娲烇紙2026-11-03 娣卞锛?
娲惧嚭鐨勫鎶楁€ф牳鏌?agent 涓ゆ閮芥病杩斿洖锛堣瑙佹湰鑺傛湯灏撅級锛屼絾鎴戝湪绛夌殑鏃跺€欒嚜宸辨寜鍚屾牱鐨勬€€鐤戠偣鏌ヤ簡涓€閬嶏紝**鎵惧埌鍥涗釜鐪熼棶棰?*銆?
### 婕忔礊 1 路 鎴戝姞鐨勫己鍒舵牎楠屼細鍦ㄧ涓€娆¤繍琛屽氨鍏ㄧ嚎澶辫触

`output-contract.md` 鏂板浜嗐€宍SUCCESS` 浣?`artifact_path` 鎸囧悜鐨勬枃浠朵笉瀛樺湪 = `CONTRACT_VIOLATION`銆嶃€備絾**娌℃湁浠讳綍瑙勫垯璇翠骇鐗╃洰褰曠敱璋佸垱寤?*銆?
鍏ㄦ鏋?`grep -rn "mkdir|鍒涘缓鐩綍|鐖剁洰褰晐寤虹洰褰?` 鍙湁涓夊鍛戒腑锛屼笖閮戒笉鏄鍒欙細

```
report-naming.md:107      涓嶅垱寤洪澶栫洰褰?| 闄?round{RN}/ 澶栦笉鏂板缓鐩綍   鈫?鍙"涓嶅缓"锛屾病璇?璋佸缓"
round-detection.md:68     docs/reports 涓嶅瓨鍦?鈫?鍒涘缓鐩綍              鈫?鍙拡瀵归杞牴鐩綍
MANUAL.md:140             ls docs/reports/ || mkdir -p docs/reports/   鈫?鎿嶄綔绀轰緥锛屼笉鏄鍒?```

**鍚庢灉**锛氳嫢 `round{N}/` 涓嶅瓨鍦紝姣忎釜瀛?Agent 鐨勫啓鍏ラ兘浼氬け璐ワ紝涓?*姣忔閲嶆淳閮藉悓鏍峰け璐?*鈥斺€旀濂借惤杩?`protocol.md` 搂4.1 瀹氫箟鐨勩€岀郴缁熸€у绾︾己闄枫€嶉偅涓€绫汇€?
**淇硶**锛歚report-naming.md` 鏂板 搂5.1锛岃瀹?*鐩綍鐢变富 Agent 鍦ㄦ淳鍙戝墠鍒涘缓锛屽瓙 Agent 鍙獙璇佷笉鍒涘缓**锛屽苟鍦?`state.json` 鍔?`report.dir_ready` 浣滀负娲惧彂鍓嶇殑纭椄銆?
| 涓轰粈涔堜笉鑳借瀛?Agent 椤烘墜寤?| |
|---|---|
| 骞跺彂绔炴€?| 瀹芥壂娉㈠彲鑳藉悓鏃舵淳 10+ 涓紝璋佸厛璺戣皝寤?鈫?椤哄簭涓嶅悓鍒欒涓轰笉鍚岋紝涓嶅彲澶嶇幇 |
| 澶辫触褰掑洜 | 鐩綍缂哄け鏄?*璋冨害灞傜殑閿?*锛岃瀛?Agent 寤轰細鎶婅皟搴︾己闄蜂吉瑁呮垚瀹¤澶辫触 |
| 鏉冮檺杈圭晫 | 瀛?Agent 鐨?`Write` 鎺堟潈鏄€屽啓鑷繁鐨勪骇鐗╂枃浠躲€嶏紝`mkdir` 涓嶅湪鍏朵腑 |

### 婕忔礊 2 路 銆屾寜 (agent_id, digest) 绱 attempt銆嶇収瀛楅潰瀹炵幇姘歌繙涓?1

`protocol.md` 搂4.1 鍘熸枃鍐欑殑鏄細

> `attempt` 鎸?`(agent_id, task_payload_digest)` 绱

浣?*閲嶆淳鏃跺繀鐒舵崲鏂?`agent_id`**锛堣繖鏄?搂4 鑷繁鐨勮瀹氾級銆備簬鏄瘡涓?`(agent_id, digest)` 缁勫悎閮芥槸鍏ㄦ柊鐨勶紝璁℃暟鍣ㄦ案杩滀粠 1 寮€濮嬧€斺€?*F2 姝婚攣鍘熷皝涓嶅姩鍦扮暀鐫€锛屽彧鏄崲浜嗕釜浼**銆?
**杩欐槸鎴戝湪淇?F2 鏃惰嚜宸遍€犲嚭鏉ョ殑涓€涓?F2銆?*

**淇硶**锛氭槑纭啓銆屼互 `digest` 涓轰富閿淮鎶ら噸璇曡鏁帮紝`agent_id` 鍙褰曟槸鍝竴娆″皾璇曘€嶃€?
### 婕忔礊 3 路 鎽樿鍛戒护渚濊禆 shell 鎹㈣澶勭悊锛屼笉鍙鐜?
鍘熸枃鍐欑殑绠楁硶鏄細

```bash
sha256sum <<< "$(jq -S 'del(...)' task_payload.json)"
```

**here-string 浼氶澶栬拷鍔犱竴涓崲琛岀锛岃€?`$(...)` 浼氬悆鎺夊熬閮ㄦ崲琛?*锛屽噣鏁堟灉鍙栧喅浜?shell 涓庢湯灏炬崲琛屾暟銆傛憳瑕佺畻娉曠殑绗竴姝ユ槸銆岃緭鍏ラ€愬瓧鑺傜‘瀹氥€嶏紝杩欎釜鍐欐硶鐮村潖浜嗚繖涓墠鎻愩€?
**淇硶**锛氭敼涓虹閬撶洿杩烇細

```bash
jq -S 'del(.trace_id, .agent_id, .spawned_at)' task_payload.json | sha256sum | cut -d' ' -f1
```

**瀹炴祴楠岃瘉**锛坄D:\Git\bin\bash.exe` + jq 1.7锛夛紝杈撳叆涓や唤 JSON锛岄敭搴忎笉鍚屻€乣agent_id` 涓嶅悓銆乣trace_id` 涓嶅悓锛?
```
h1 = 1d85c3e6a66bb4163c9984889944464239ce64ec46fdb8bc20545a95f3920481
h2 = 1d85c3e6a66bb4163c9984889944464239ce64ec46fdb8bc20545a95f3920481
OK: reproducible
confirmed: keeping agent_id changes digest
```

鎽樿鐩稿悓锛涗笉鍒犺繖涓変釜瀛楁鏃舵憳瑕佷笉鍚屻€傚懡浠ゅ彲澶嶇幇銆?
### 婕忔礊 4 路 `pattern_sweep` 瑕佹眰璺?grep锛屼絾璇ヨ鑹叉病鏈?Bash

`templates/wave3-critique.md` 搂2.4 瑕佹眰 Devil's Advocate 鎻愪氦锛?
```json
"grep_command": "grep -rn 'catch { continue' prototypes/",
"other_occurrences": [...]
```

鑰?`wrappers/critique-panel.md` 鐨?tools 鍘熸湰鏄?`Read, Grep, Glob, Write`鈥斺€?*娌℃湁 `Bash`**銆?
**杩欐瘮缂哄け瀛楁鍗遍櫓寰楀**锛欰gent 浼氱収鏍疯繑鍥炰竴涓牸寮忓畬缇庣殑 `pattern_sweep`锛坄performed: true`銆佸瓧娈甸綈鍏級锛岃€岄偅浜?`other_occurrences` 鏄畠鍑嵃璞″啓鐨勩€?*缂哄け瀛楁浼氳濂戠害鎷︿綇锛岀紪閫犵殑瀛楁涓€璺豢鐏繘鏈€缁堟姤鍛娿€?*

**淇硶**锛氱粰 `critique-panel` 琛?`Bash`锛屽苟鍐欐槑鍙厑璁?`grep -rn` / `find` / `git status` / `jq` / `wc -l` 杩欑被鍙鏍搁獙銆?
> 杩欎笌 `protocol.md` 搂1.5 缁欎富 Agent 琛ュ彈闄?`Bash` 鏄?*鍚屼竴涓慨娉曘€佸悓涓€涓悊鐢?*锛氬彧璇荤殑鏈烘鏍搁獙蹇呴』鑳界湡璺戯紝鍚﹀垯瑙勫垯浼氶€€鍖栨垚銆岃姹?Agent 鍋囪璺戣繃銆嶃€?
---

## 杩欏洓涓紡娲炵殑鍏卞悓鐐?
**瀹冧滑鍏ㄩ儴鏄垜鍦ㄣ€屼慨鐭涚浘銆嶆椂鏂伴€犲嚭鏉ョ殑銆?*

| 鎴戝仛鐨勪慨璁?| 鎴戝悓鏃堕€犲嚭鐨勬柊闂 |
|---|---|
| 鍔?`artifact_path` 寮哄埗鏍￠獙 | 娌″畾涔夌洰褰曡皝寤?鈫?鏍￠獙蹇呯劧澶辫触 |
| 鏀?`attempt` 绱閿?| 绱閿噷鍚瘡娆￠兘鍙樼殑 `agent_id` 鈫?璁℃暟鍣ㄦ案杩滀负 1 |
| 鍐欐憳瑕佺畻娉?| 鐢?`<<<` 鈫?鎽樿涓嶅彲澶嶇幇 |
| 琛?`pattern_sweep` 鍒板绾?| 瑕佹眰璺?grep锛屼絾瑙掕壊娌℃湁 Bash |

**鍥涙淇锛屽洓娆℃柊婕忔礊锛屽叏閮ㄥ睘浜庡悓涓€绫伙細鍔犱簡涓€鏉¤鍒欙紝娌℃鏌ュ畠鍜屽叾浠栬鍒欒兘鍚﹀悓鏃舵垚绔嬨€?*

杩欐伆濂芥槸 Skeptic 閭ｆ潯閿愯瘎鐨勭簿纭鐜扳€斺€斻€屼竴涓彧闈犱慨鐭涚浘澧為暱鐨勭郴缁燂紝鍑€鏀剁泭涓鸿礋涓斾笉鍙瘉浼€嶃€?*鎴戜粖澶╁仛鐨勫伐浣滐紝鏈変竴鍗婃槸鍦ㄤ慨鎴戜笂鍗堜慨鍑烘潵鐨勭煕鐩俱€?*

鐪熸璇ラ棶鐨勪笉鏄€岃繕鏈夊嚑澶勭煕鐩俱€嶏紝鑰屾槸銆屼负浠€涔堝姞瑙勫垯鏃剁郴缁熸€ф鏌ヤ笉鍒拌繖浜涖€嶃€傜瓟妗堝湪 13 浠介攼璇勯噷宸茬粡缁欏嚭涓夐亶浜嗭細**鏈烘褰掍唬鐮併€佸垽鏂綊鎻愮ず璇嶃€?* 杩欏洓鏉＄煕鐩惧叏閮芥槸銆屼袱娈佃嚜鐒惰瑷€浜掔浉寮曠敤銆嶅鑷寸殑鈥斺€斿鏋?`artifact_path`銆乣attempt` 绱銆佹憳瑕佺畻娉曟槸浠ｇ爜锛屽姞杩涘幓鐨勬椂鍊欐祴璇曚細绔嬪埢澶辫触銆?
## 鍏充簬閭ｄ釜鏍告煡 agent

娲句簡涓ゆ锛屼袱娆￠兘娌℃甯歌繑鍥烇細

| 娆?| 娲惧嚭鏃堕棿 | 瑙傚療鍒扮殑鐘舵€?|
|---|---|---|
| 绗?1 娆?| 21:44 | 杈撳嚭鏂囦欢闈欓粯 47 鍒嗛挓鍚庡垽瀹氫涪澶憋紝閲嶆淳 |
| 绗?2 娆?| 绾?22:59 | 寰呰瀵?|

**鎴戞嬁涓嶅埌 A 绾ц瘉鎹紙harness 浠诲姟鐘舵€侊級**鈥斺€擿ListAgents` 鍙垪瀵圭瓑浼氳瘽锛屼笉鍒楀瓙 Agent銆侭 绾э紙杩涚▼琛級鏄剧ず鏈?25 涓?`claude.exe`锛屼絾鍚姩鏃堕棿鏃犱竴鍖归厤锛汣 绾э紙鏂囦欢 mtime锛夋樉绀洪暱鏃堕棿闈欓粯銆?
**涓夌骇璇佹嵁浜掔浉鐭涚浘鏃讹紝涓嶈兘鎶?C 绾у綋缁撹銆?* 杩欐槸 `run-state.md` 搂4.1 鐨勮鍒欙紝鑰屾垜涓婃杩濆弽瀹冩椂绛変簡 15 灏忔椂 42 鍒嗘墠鎵胯銆?
> **璁藉埡鐨勬槸**锛氭垜鍒氬垰鍦ㄦ鏋堕噷鍔犱簡銆孉/B/C 涓夌骇璇佹嵁銆嶅拰銆孲TALL_CHECK_HOURS=2 寮哄埗妫€鏌ャ€嶏紝鍗村湪鐪熷疄闇€瑕佺敤瀹冪殑鏃跺€欏彂鐜拌嚜宸?*娌℃湁 A 绾у伐鍏?*銆傝鍒欏啓寰楀啀濂斤紝缂烘祴閲忔墜娈靛氨鏄┖鐨勩€?*杩欐潯涔熻杩涚己闄疯〃銆?*

