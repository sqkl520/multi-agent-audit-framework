# FIX-R21 报告 · 换观测面：用 harness 的 write/edit 记录对账 `files_touched`

**任务**：回答 R20 §三点的那句话——「下一个层次必须换观测面（harness 记录 tool call 与文件写入），而不是继续往 state.json 加字段」。
**新建**：`tools/check-files-touched-harness.mjs`、`tools/check-files-touched-harness.test.mjs`
**改动**：`tools/stop-hook.mjs`（§3.6b 新增约 85 行 + §3.6 的 project 目录推断提为两段共用）、`tools/stop-hook.test.mjs`（case 49–51，3 个 case / 9 条断言；另改 `makeFakeDshSession` 支持写记录、case 18/19 的 fixture）
**未改**：`tools/check-payload.mjs`、`tools/check-state.mjs`、`tools/check-all.mjs`、`framework/` 下任何文件

> 关于 `check-all.mjs`：我一度把它注册进去，然后又撤了——任务书的文件范围是「只新建两个 + 改 stop-hook 两个」。
> 顺带发现一个既有事实：**R8 的 `check-fix-instances-harness.test.mjs` 也没注册在 `check-all.mjs` 里**
> （`grep` 全文只命中 `stop-hook.test.mjs`），所以「harness 系的两个自测都不进 check-all」是一致的现状，
> 不是 R21 的疏漏。想改这一点应该单独一轮。

**我没有 commit，也没有 `git add`**

---

## 一、换的是什么观测面

R19/R20 那条链的两个方向都以 `git status` 为基准：

| 规则 | 基准 | 回答的问题 | 失效条件 |
|---|---|---|---|
| `files_touched_overclaimed`（R19） | `git status` 相对 HEAD | 仓库里这个文件**有没有差异** | 文件在修复前就脏 → 「差异」在，但其实本轮没碰 → **假阴性** |
| `files_touched_underreported`（R19） | 同上 | 仓库里**有没有未登记的差异** | 修复前就脏的文件被算成「改了没登记」→ **假阳性**（R20 才靠 `fix_baseline` 缩小） |

R20 自己也写了：`fix_baseline` 是**自述**，只是把误差缩小，不是消除。

R21 换成 harness 的 `tool/call` 事件：

```
$ node -e "... zstdDecompressSync(session.v4.jsonl.zstd) ..."
session-a40f0162-d036-49ca-8677-efb40f821c06
  tool/call 总数 303；其中 name ∈ {write, edit} 的 68 次；不同被写文件 18 个
  单条事件形状：
    { type:'tool/call', seq:286, time:1794678558611,
      data:{ turn:1, step:27, callId:'call_00_…', name:'write',
             arguments:'{"file_path":"D:/Server/…/src/test/java/…/ConfigLoadClampTest.java","content":"…"}' } }
```

这是**动作**（谁在哪一步写了哪个绝对路径），不是**状态**（相对 HEAD 有没有差异）。
它与仓库脏不脏完全无关，所以上面两个失效条件同时消失。

数据源两条，都是既有字段，**没有往 `state.json` 加任何东西**：
- 声称侧：所有 `role="fix"` 信封的 `payload.files_touched[].path`（含 `payload.dispositions[].files_touched[]` 多发现形态）+ 各自信封的 `agent_id`。产物目录沿用 `state.report.dir_path`。
- 实际侧：session 日志里所有 `write`/`edit` 的 `file_path`（绝对路径）。

---

## 二、实现（`tools/check-files-touched-harness.mjs`）

### 2.1 复用了 `check-fix-instances-harness.mjs` 的三件事

按要求先读了 R8 那个文件，直接照抄它的三个已解决问题，不重新发明：

1. **dsh 格式解码**：`zstdDecompressSync` + JSONL 逐行 `JSON.parse`（半行写入时跳过）；`session` 事件的 `id/cwd/delegationDepth/parentSession` 在**顶层**（不在 `.data` 里）。
2. **session 定位**：目录名 `session-<uuid>` 与裸 uuid 双向比对；`--project-dir` 是显式 flag（dsh 目录名以 `--` 开头，位置参数无法区分）；root 下多 project 且未指定 → `project_dir_ambiguous` exit 2，**不猜**。
3. **跨 harness 降级**：探测不到任何 `session.v4.jsonl.zstd` → `unsupported_harness` **exit 0 + WARN**（R8 同一纪律）；但**显式传了 `--session-id`** 却找不到 → exit 2（路径给错了，继续跑只会假绿）。

### 2.2 新增的三条规则

| 规则 | 判据 | 级别 |
|---|---|---|
| `files_touched_overclaimed_by_harness` | `claimed − actual(未过滤)` 非空 | **FAIL** |
| `files_touched_underreported_by_harness` | `actual(过滤后只剩源码) − claimed` 非空 | **FAIL** |
| `agent_attribution_mismatch` | 子 session 的源码写入 ⊄ 它自己 `agent_id` 的 `files_touched` | **FAIL** |

降级/提示：`no_claimed_files`(WARN)、`agent_attribution_unavailable`(WARN)、`unnormalizable_claimed_path`(WARN)、`unnormalizable_actual_path`(WARN)、`unparsed_write_calls`(WARN)、`repo_from_session_cwd`(INFO)、`more_actual_than_claimed_files`(INFO)。

**为什么 overclaim 用未过滤的 actual**：过滤是给 under-reporting 用的（「剩下的是应该被登记的源码」）。若这一侧也用过滤后的集合，「声称改了一个 .md 而且确实写了」会被误报成 overclaim。这与 R19 `stop-hook.mjs:1383` 的注释是同一条口径。

**为什么 underreported 只看源码**：修复相位必然有合法噪音——产物 `.md`、日志、`repair-artifacts/`、`experiments/`、`build/`、`target/`。无条件升 FAIL 会让每个跑过构建的回合都红，然后这条规则被整体关掉——那比漏报更糟。判据用 `SRC_EXT` 扩展名白名单（与 `verify-postfix-snapshot.mjs:175` / `stop-hook.mjs §3.7.6.5` 同一份正则），不是路径黑名单：黑名单要枚举所有产物目录名，必然漏。

### 2.3 `normalizePath(p, targetRepo, caseInsensitive)` —— 单独导出、单独测

harness 记绝对路径（`D:/Server/…/src/X.java`），`files_touched` 写相对路径（`src/X.java`）。这一层最容易出 bug，所以做成纯函数并 `export`。

四条设计决定：

1. **`rel` 与 `key` 分开**：`rel` 保留原大小写（展示用），`key` 按平台折叠（比较用）。**不统一转小写**——Linux 上敏感（`A.java ≠ a.java`）。
2. **前缀必须按 `repo + '/'` 比**：纯字符串前缀会把 `D:/Server/Some Repo2` 算进 `D:/Server/Some Repo`（测试 0.9 专门钉这一条）。
3. **`../` 越界 → `escapes_repo`**，不是静默归一化到仓库外。
4. **绝对路径但没给 `target_repo` → `no_repo`（不瞎猜）**。

调用侧还有一条：`target_repo` 缺失时用**主 session 的 `cwd`** 作基准（dsh 的 `cwd` 就是启动会话时的工作目录），并记 `repo_from_session_cwd` INFO——降级必须可见。

### 2.4 「本次会话」的边界（本工具最危险的设计点）

**这是我在真实数据上撞到的、任务书没预见的一个坑。**

第一次实现按任务书的「省略 `--session-id` 时取最新顶层 session」写，然后拿真实数据自证，得到 5 条 overclaim。查下去发现：

```
$ ls ~/.dsh/sessions/--D-Server-…-Hilltop~0020Village~0020Plugin--/
session-a40f0162-…   writes=68   done-1/3/4/6/7 来自这里
session-d5ad7820-…   writes=26   done-8 来自这里
```

同一个 project 目录下**有两个顶层 session**（同一个 cwd，两阵工作）。取任意一个当全集，另一边登记的 `files_touched` 全部会被判成 overclaim ——一次**结构性假 FAIL**，而假 FAIL 比漏报更糟（R10：它会导致整条规则被关掉）。

所以边界改成：

- **省略 `--session-id` → 该 project 目录下全部 session**（含子 agent）。一个 project 目录 = 一个工作目录 = 一次工作的全部会话。
- **显式 `--session-id` → 该 session 及其后代**（父链多级回溯）。用户已明确指定范围，就按它算。
- **别的 project 目录绝不进来**（别的 cwd、别的项目）。

两种口径都写进输出（`actualScope: 'project' | 'session'`），并且测试 2.23–2.30 双向钉住：同一份账 + 同一份日志，收窄口径后结论**必须不同**，否则「口径」这个概念就是假的。

改完之后 a40f0162 那 5 条 overclaim 全部消失——因为它们的写记录在 `d5ad7820` 里。**这是 R21 唯一一次「工具自己判错了」的证据，也正是自证的价值。**

### 2.5 归属（R19 §(b)）

R19 §(b) 原文：「`files_touched` 没有 `agent_id` 维度，对账是全局的不是逐实例的。」

dsh 的子 session 有 `parentSession` + `delegationDepth: 1`。当 `fix_contracts[].fix_agent_id` **就是**子 session 的 id（`run-state.md` 的命名习惯）时，可以把「谁写的」拆到实例粒度：逐个子 session 比对自己的 `agent_id` 信封。

映射不到时**不瞎猜**：`agent_attribution_unavailable` WARN，写明「本轮只做了全局对账」。理由与 R8 的 `no_subagent_capability` 同构——不是所有 harness 都能把 agent_id 映射到 session，用 `fix-agent-1` 这类逻辑名也是合法的；强行 FAIL 会让所有逻辑命名的项目永远红。

这条规则真的堵住了一个 R19 明说的洞：测试 3.1 里 B.java **被另一份产物登记过**（全局对账两边都绿），但**没有**被写它的那个子 session 登记——全局对账看不见，逐实例对账看见。

---

## 三、接进 `stop-hook.mjs`（§3.6b）

条件与 §3.6 相同：`phase ∈ {wave4, wave5}` 且探测到 dsh sessions root。为此把 §3.6 里的 `dshEncode` / `guessProjectDir` 提到两段共用（`DSH_SESSIONS_ROOT` + `dshEncode` + `guessDshProjectDir`），**两段必须看同一个 project 目录**，否则一段判的和另一段看的不是同一批日志。

**FAIL → `problems.push` → exit 2**，与 §3 其他判据同等地位。这一点单独写在了注释里，因为 R12/R13 反复批评过「接上了但没接在门上」：

> 那等于给了一道看得见摸不着的闸门，比没有更糟——它让人以为有人在管。

`exit 2`（配置错误）与工具自身崩溃不重复开火（§3.6 已报过 state/环境问题）。

---

## 四、新测试在改代码前的失败信息原文

先写 `tools/check-files-touched-harness.test.mjs`（75 条断言），`node tools/check-files-touched-harness.test.mjs` 的原文（节选，未删改）：

```
  （暂时无法导入被测模块：ERR_MODULE_NOT_FOUND —— 实现尚未写出，属预期）

=== 0：路径归一化（绝对 / 相对 / 大小写 / 越界）===
  ✗ 0.1 绝对路径 → 相对 target_repo
  ✗ 0.2 反斜杠绝对路径 → 正斜杠相对路径
  ✗ 0.3 相对路径原样（去掉前导 ./）
  ✗ 0.4 大小写不敏感（Windows）：盘符与目录名大小写不同仍匹配
  ✗ 0.5 大小写敏感（Linux 语义）：同样的输入**不**匹配，判为仓库外
  ✗ 0.6 大小写敏感时 key 不折叠（A.java ≠ a.java）
  ✓ 0.7 大小写不敏感时 key 折叠（A.java == a.java）
  ✗ 0.8 仓库外的绝对路径 → ok:false / outside_repo
  ✗ 0.9 路径前缀不能靠字符串前缀蒙混（Some Repo2 不算在 Some Repo 里）
  ✗ 0.10 绝对路径但没给 target_repo → ok:false（不瞎猜）
  ✗ 0.11 ../ 越界 → ok:false / escapes_repo
  ✗ 0.12 空串 / 非字符串 → ok:false
  ✗ 0.13 尾斜杠被去掉（目录形态的路径也能对齐）

=== 1：配置错误与 harness 探测（无日志不能假装绿，别家 harness 不能卡死）===
  ✗ 1.1 sessions root 不存在 → exit 2 — code=1
  ✗ 1.2 报 sessions_root_missing
  ✗ 1.3 state.json 不存在 → exit 2 — code=1
  ✗ 1.4 报 state_missing
  ✗ 1.5 缺必填参数 → exit 2（用法错误不是通过） — code=1
  ✗ 1.6 无 dsh 格式日志 → exit 0（unsupported_harness 不卡死别家 harness） — code=1
  ✗ 1.7 报 unsupported_harness WARN — []
  ✗ 1.9 指定 session 找不到 → exit 2 — code=1
  ✗ 1.10 报 session_not_found

=== 2：核心对账（声称侧 = files_touched，实际侧 = write/edit 记录）===
  ✗ 2.1 声称 == 实际 → exit 0 — code=1 []
  ✗ 2.3 JSON 里记录 write/edit 调用数 = 2 — undefined
  ✗ 2.5 报 files_touched_overclaimed_by_harness（FAIL） — []
  ✗ 2.6 消息点名 Ghost.java
  ✗ 2.7 消息写明「从未对它们调用过 write/edit」
  ✗ 2.10 报 files_touched_underreported_by_harness（FAIL） — []
  ✗ 2.11 消息写明「harness 记录本次会话写了 2 个源码文件」
  ✗ 2.12 消息列出 B.java 与 C.java，不列已登记的 A.java
  ✗ 2.13 消息说明这是外部基准判的、不是 git 差值猜的
  ✗ 2.14 写产物 / 非源码未登记 → exit 0（不报） — code=1 []
  ✗ 2.17 JSON 里统计到被忽略的非源码写入数 ≥ 2 — undefined
  ✗ 2.18 绝对/相对/大小写混用 → exit 0（归一化正确） — code=1 []
  ✗ 2.20 edit 工具也被计入（write/edit 都要看） — undefined
  ✗ 2.21 写入发生在子 session → 仍算本次会话（exit 0） — code=1 []
  ✗ 2.22 JSON 里 sessionsScanned ≥ 2 — undefined

=== 3：归属——fix_agent_id 能映射到子 session 时，逐实例对账 ===
  ✗ 3.2 报 agent_attribution_mismatch（FAIL） — []
  ✗ 3.3 消息点名 B.java 与那个子 session id
  ✗ 3.5 两个实例各自对得上 → exit 0 — code=1 []
  ✗ 3.6 JSON 里 mappedAgents = 2
  ✗ 3.7 映射不到 session → exit 0 — code=1 []
  ✗ 3.8 报 agent_attribution_unavailable（WARN，降级必须可见） — []

=== 4：降级纪律（拿不到外部信息 ≠ 账本写错了）===
  ✗ 4.1 没有 fix 信封 → exit 0 — code=1 []
  ✗ 4.2 但必须 WARN no_claimed_files（「没查」与「通过」可区分） — []
  ✗ 4.3 target_repo 缺失但 session 有 cwd → exit 0 — code=1 []
  ✗ 4.4 记一条 INFO 说明基准取自 session cwd — []
  ✗ 4.5 仓库外的绝对路径 → exit 0 — code=1 []
  ✗ 4.6 报 unnormalizable_claimed_path（WARN） — []
  ✗ 4.8 dispositions[].files_touched 被收进 claimed → exit 0 — code=1 []
  ✗ 4.9 claimedFiles 覆盖两个文件 — undefined

=== 5：真实 dsh session 自证（a40f0162）===
  ✗ 5.1 能定位到真实 session — node:internal/modules/cjs/loader:1607
  Error: Cannot find module '…\tools\check-files-to…'
  ✗ 5.2 write/edit 调用数 = 68 — undefined
  ✗ 5.3 不同被写文件数 = 18 — undefined
  ✗ 5.4 只登记 2 个 → 报 underreported（真实 under-reporting） — code=1 []

合计: 13 通过 / 54 失败
```

> 注：`合计: 13 通过` 里有 13 条是「否定式断言」（例如「不报 underreported」「不算 overclaimed」），
> 脚本根本不存在时它们天然成立。这是「否定式断言在工具缺失时恒真」的常见假绿，
> 所以每一个否定式断言旁边都配了一条肯定式断言（例如 2.15 配 2.14 的 exit 0）。

`stop-hook.test.mjs` 侧新增的 case 49–51，为了拿到真实的「改之前」形状，我把 §3.6b 的调用点临时短路成 `if (false)`，
再跑 `node tools/stop-hook.test.mjs`，原文如下（跑完立刻从备份恢复）：

```
case 49 (R21-A): files_touched 声称的文件 harness 从没写过 → 拒绝闭合（exit 2）
  ✗ 退出码 2（必须真的挡住闭合） — 实际 0：
  ✗ 报 files_touched_overclaimed_by_harness
  ✗ 说明判据是 write/edit 记录而不是 git status
case 50 (R21-B): harness 写了源码但没登记 → 拒绝闭合（exit 2）
  ✗ 退出码 2 — 实际 0：
  ✗ 报 files_touched_underreported_by_harness
  ✗ 点名 Sneaky.java
case 51 (R21-C): 声称 == 实际 → 放行（这条闸门不能误拦正常回合）
  ✓ 退出码 0
  ✓ 不退化成 overclaimed / underreported

=== 结果: 129 通过 / 6 失败 ===
```

注意 case 49/50 的 `实际 0`：**没有 §3.6b 时这两个回合是完全放行的**，
包括「声称改了 A.java 但 harness 只写了 B.java」和「harness 写了 Sneaky.java 而没人登记」。
这两条正是 R19 §(b) + R18 §6 在真实产物上曾经静默通过的形状。

接上之后：`node tools/stop-hook.test.mjs` → **135 通过 / 0 失败**（原 127 + 3 个 case / 9 条断言）。

> 接 §3.6b 时**连带暴露了 case 18/19 的 fixture 不完整**：它们的合成 dsh session 里一次 write 都没有，
> 而 `writeValidFixArtifact` 的信封声称改了 `src/A.java` → §3.6b 正确报 overclaim → exit 2，
> 于是「case 19 应当 exit 0」这条变红。
> 这不是新闸门误拦，而是**旧 fixture 缺字段**：一个真实 session 不可能「声称改了文件但一次 write 都没调」。
> 改法是给 `makeFakeDshSession` 加 `writes` 参数、让 case 18/19 的写记录与信封对得上。
> **这条值得记下来**：新增的判据会让存量 fixture 的省略暴露成分歧。

---

## 五、真实数据自证（a40f0162 + 6 份 done-\*.md）

### 5.1 数据

`<HOME>/.dsh/sessions/--D-Server-…-Hilltop~0020Village~0020Plugin--`：

| session | depth | write/edit 次数 | 被写文件数 | 对应产物 |
|---|---|---|---|---|
| `session-a40f0162-…` | 0 | **68** | **18** | done-1 / done-3 / done-4 / done-6 / done-7 |
| `session-d5ad7820-…` | 0 | 26 | 8 | done-8 |

`experiments/hilltop-dsh/repair/done-*.md` **全都没有 JSON 信封**（这正是 R13 §7.2 洞里那个形状）。
所以我把 6 份正文里引用的 `src/...` 路径**手工整理**成 `files_touched`，再**事后补一个信封**（`agent_id` 是编的：
`fix-1`/`fix-3`/`fix-4`/`fix-6`/`fix-7`/`fix-8`，`disposition: FIXED`），
`target_repo` = `<TARGET_REPO>`。

整理出的声称集合 17 个文件（含 done-3 里那个 `MainConfigMenu.java`——它正文写「没有改生产代码」，
但代码引用被当成了改动声明；这本身是 done-*.md 格式的一个真实问题）。

### 5.2 输出 A：`--session-id a40f0162`（只看这一个 session）

```
──────────────────────────────────────────────────────────────────
files_touched × harness write/edit 记录对账
──────────────────────────────────────────────────────────────────
  session: session-a40f0162-d036-49ca-8677-efb40f821c06
  路径基准: <TARGET_REPO>（来自 state.target_repo）

声称侧（files_touched）
  fix 信封数            : 6
  不同文件数            : 17
实际侧（write/edit 记录）
  扫描范围              : 指定的 session 及其子 session（1 个）
  write/edit 调用数     : 68
  不同被写文件数        : 18
  其中未登记的非源码    : 6
  归属（能映射的实例）  : 0

✗ FAIL [files_touched_overclaimed_by_harness]
    这些路径在 files_touched 里，但 harness 日志显示本次会话从未对它们调用过 write/edit（5 个，会话 session-a40f0162-…，共 68 次写操作）：
      - src/main/java/com/hilltopvillage/command/HilltopCommandHandler.java
      - src/main/java/com/hilltopvillage/config/menu/MainConfigMenu.java
      - src/test/java/com/hilltopvillage/command/HilltopCommandReloadResultTest.java
      - src/test/java/com/hilltopvillage/config/ConfigManagerTest.java
      - src/test/java/com/hilltopvillage/config/menu/MainConfigMenuReloadResultTest.java

· INFO [more_actual_than_claimed_files]
    harness 记录了 6 个未被 files_touched 登记的文件，但它们都不是源码
    （repair-artifacts/done-7.md、done-1.md、done-6.md、done-4.md、done-3.md、SUMMARY.md），按噪音处理，不判 under-reported。

! WARN [agent_attribution_unavailable]
    …6 个 fix_agent_id 映射不到任何子 session（本次扫描了 1 个 session），只做了全局对账。

合计: 1 FAIL / 1 WARN / 1 INFO → exit 1
```

### 5.3 输出 B：`--project-dir`（该 project 目录下全部 session）

```
实际侧（write/edit 记录）
  扫描范围              : 该 project 目录下全部 2 个 session（含子 agent）
  write/edit 调用数     : 94
  不同被写文件数        : 24
  其中未登记的非源码    : 7

· INFO [more_actual_than_claimed_files]
    …7 个未登记文件，全部是 repair-artifacts/*.md，按噪音处理。

! WARN [agent_attribution_unavailable]
    本次扫描了 2 个 session：session-a40f0162-…、session-d5ad7820-…

合计: 0 FAIL / 1 WARN / 1 INFO → exit 0
```

### 5.4 输出 C：只声称 done-3 那一个文件（对照）

```
✗ FAIL [files_touched_overclaimed_by_harness]  — 1 个
  - src/main/java/com/hilltopvillage/config/menu/MainConfigMenu.java
✗ FAIL [files_touched_underreported_by_harness] — 10 个源码
  - src/main/java/com/hilltopvillage/admin/ArenaResetService.java（10 次写操作）
  - src/main/java/com/hilltopvillage/admin/gui/ArenaManageGUI.java（1 次写操作）
  - src/main/java/com/hilltopvillage/ai/ExplodeBeetleGoal.java（3 次写操作）
  - src/main/java/com/hilltopvillage/config/ConfigManager.java（9 次写操作）
  - src/main/java/com/hilltopvillage/mechanics/NodeListener.java（8 次写操作）
  - src/main/java/com/hilltopvillage/mechanics/NodeSystem.java（2 次写操作）
  - src/test/java/com/hilltopvillage/admin/ArenaResetNodeRollbackTest.java（6 次写操作）
  - src/test/java/com/hilltopvillage/ai/ExplodeBeetleGoalTest.java（11 次写操作）
  - src/test/java/com/hilltopvillage/config/ConfigLoadClampTest.java（3 次写操作）
  - src/test/java/com/hilltopvillage/config/ConfigManagerTest.java（9 次写操作）
合计: 2 FAIL / 1 WARN / 1 INFO → exit 1
```

### 5.5 这三份输出现实暴露了什么

1. **输出 A/B 的 5 条 overclaim 是工具的口径错，不是账本的错。** 它的根因是同 project 两个顶层 session——
   `_session-id` 口径把 done-8 的 5 个文件算成了「从没写过」。
   这条在真实数据上被抓到，改掉口径后归零。**这就是自证的全部价值：合成用例永远造不出「我以为只有一个 session」这个假设。**
2. **输出 B 的 `0 FAIL` 也不是「账本合规」的证明。** 它是「把 6 份 done-*.md 正文里所有 `src/` 引用都当成了改动声明」的结果——
   而那 6 份 .md 里**没有一份**是 R19 意义上的 `files_touched`（它们没有信封）。
   换句话说：真实产物的 `files_touched` 为空 → 本工具只会 WARN `no_claimed_files`。
   我把正文引用手工搬成 `files_touched` 是在**模拟「如果它们当时按契约交付」**，不是对历史数据的判决。
3. **输出 C 才是真实 under-reporting 的样子**：一个实例（份产物）声称 1 个文件，harness 说它写了 10 个源码。
   R18 的存在性检查、R19 的相对 HEAD、R20 的基线在这个形状上**全绿**——只要那 10 个文件里至少有 1 个被别的产物登记过，
   全局对账还会互相抵消。逐实例对账（§2.5）是唯一能当场指出来的那一条。

---

## 六、回答 R20 的两个问题

### Q1：换观测面真的产生新约束力了吗？还是「自述 vs 另一种自述」？

**有，但要说清它在哪一处。**

harness 日志确实是主 Agent 所在进程写的——这是同一个进程，这一点不能洗。
但 R21 的约束力不来自「另一个写日志的人」，来自**两件事**：

**(a) 粒度的下降：per-call vs per-round。**

`files_touched` 是**一轮结束时的一次声明**，可以一整轮只写一次、事后编纂、想写什么写什么。
`tool/call` 是**每一次写操作一条记录**：`{seq, time, turn, step, callId, name, arguments}`。

这个区别在可伪造性上是量级差异，不是程度差异：

| 伪造 `files_touched` | 伪造 harness 日志 |
|---|---|
| 编辑一个 JSON 字段 | 解压 zstd → 改 JSONL → 重压缩 |
| 不影响任何其他字段的一致性 | 必须保持 `seq` 连续、`tool/result` 与 `tool/call` 配对、`step/start`/`step/end` 边界、`request/header` 与工具集一致 |
| 一次编辑 | 每加一条假 write 就要补一条假 tool/result、并让 step 的计数对得上 |

而且这个「必须有对应 tool/result」不是我在猜：同一份日志里 303 次 `tool/call` 是成对出现的，
`step/start` 与 `step/end` 也是成对的。改一处会让「这条 call 的结果在哪」变成空洞。

**所以「换观测面」的实质不是「换一个来源」，是「伪造的代价从一处跳到一处必须自洽的记录链」。**
R20 §三点说「每个新字段都是一个新省略点」——`fix_baseline` 是一个新字段，加它只增加了一个可以整块省略的位置；
`tool/call` 不是新字段，它**已经存在于日志里**，省略不了，只能篡改。

**(b) 它判的是动作，不是状态。**

这是 R19/R20 那条链卡住的真正原因：`git status` 是**状态**，状态无法回答「谁改的、什么时候改的」。
「文件脏了」有无数种成因（修复前就脏、别的实例改的、构建生成、人工改的），R19/R20 只能靠一个同样自述的
`fix_baseline` 去近似「这一轮从哪开始」。write/edit 记录是**动作**，动作没有这个问题：
`a40f0162` 在 step 27 写了 `ConfigLoadClampTest.java`，有 `callId`、有绝对路径、有结果。

**代价（必须承认）：** 它只覆盖「写操作」。`sed -i`、`mv`、`git checkout`、构建工具生成的产物都不会出现在 write/edit 里。
一条 bash 命令 `sed -i 's/x/y/' src/A.java` 改了 10 个文件，write/edit 记录里是 0 条。
所以 `files_touched_underreported_by_harness` 有一个**明确的盲区**：它只能抓到「用 write/edit 工具做的、没登记的改动」。
本工具没有掩盖这一点——`unparsed_write_calls` WARN 与文件头「它不检查什么」都写了。

**结论：** 够构成「新层次」，但不是「终极层次」。它换掉的是**基准的类型**（动作 vs 状态），
这是 R19→R21 的实质进步；但它仍是**同一进程写的**、且**只覆盖一种工具族**。

### Q2：还剩什么？特别是「先写后回滚」

**能抓到的：** 实例调 write 写了 10 个文件、`files_touched` 只列 1 个 —— 现在抓得到（输出 C 就是）。
这是 R18 §6 说的 under-reporting，之前只能靠 `git status` 差值猜，现在由外部基准判。

**抓不到的（新的边界，正是 R20 提醒的「上一层边界条件」现象）：**

1. **先写后回滚。** 实例 `write` 了 `src/Sneaky.java`，然后 `git checkout -- src/Sneaky.java`（或 `rm`）。
   harness 日志里**仍然有那条 write 记录**——所以：
   - 如果它**没有**把 `Sneaky.java` 写进 `files_touched`：本工具报 `underreported` FAIL。
     **这是正确行为**：它确实「写了」。（附赠发现：这条规则天然覆盖「写了又回滚」的申报义务。）
   - 如果它**把** `Sneaky.java` 写进 `files_touched`：本工具**放行**（声称 ⊆ 动作），但文件已回滚，
     `git status` 也不会有它。R18 的 `files_touched_not_found` 会抓到「路径不存在」；
     但如果它是**改回原内容**（rollback 到 HEAD），路径存在、git 干净、write 记录在——三方全绿，而这轮实际上什么都没改。
     **这是仍存在的一个洞。** 补它的方向是拿 `tool/result` 的 write 结果 + 后续 `git checkout` 的 `pwsh` 调用
     做**时序**判断，本工具没做（那要读 `pwsh` 的 arguments 并解析命令，误报风险高）。

2. **只用 bash 改文件。** 见 Q1 的盲区。

3. **「写了但内容不是它声称的那个改动」。** 本工具只比路径，不比内容。一个实例可以写
   `src/A.java`（加一行注释）然后在 `files_touched` 里写 `change_summary: "修了空指针"` —— 路径对得上，摘要全假。
   下一层要么比 `tool/call` 里的 `content` / `new_string` 与最终 diff 的相似度，
   要么比 `red_log` 与写入的时序。这是真的下一个观测面。

4. **`fix_agent_id` → session 的映射依赖命名习惯。** 当它是逻辑名时只降级 WARN，归属那一层就退回全局对账，
   R19 §(b) 的洞会重新打开。想让这一层稳定生效，`run-state.md` 得把「`fix_agent_id` 用子 session id」写成约定，
   或者在派发时让主 Agent 显式登记 `agent_id ↔ session_id`。**本轮没有改文档**（按任务书的「只新建两个文件 + 改 stop-hook 两个文件」）。

5. **harness 日志的可用性依赖 dsh。** 换 harness = 这整层归零（`unsupported_harness` WARN）。
   Claude Code 的 write/edit 记录在 `~/.claude/projects/<slug>/<uuid>.jsonl` 的
   `assistant.content[].type === "tool_use"` 里，需要单独适配器。**故意不做半成品。**

**一句话：** R21 把「自述 vs 状态」换成了「自述 vs 动作」，动作比状态硬；但动作仍然只是**发生过**，
不等于**生效了**、也不等于**内容对**。下一层的候选是 `tool/result` + 时序（回滚检测）与内容比对，
而不是再往 `state.json` 加一个「我保证我回滚过」的字段。

---

## 七、验证

```
node tools/check-files-touched-harness.test.mjs   75 通过 / 0 失败   （改代码前 13 通过 / 54 失败）
node tools/stop-hook.test.mjs                    135 通过 / 0 失败   （原 127；新增 case 49-51）
node tools/fix-phase-e2e.test.mjs                 48 通过 / 0 失败
node tools/check-all.mjs                          ✅ 全部通过（既有 20+ 项，无回归；R21 自测按文件范围未注册进去，单独跑）
```

**未 commit、未 `git add`。**
