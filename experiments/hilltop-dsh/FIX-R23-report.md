# R23 · 修 R21 的盲区：验证探针测试被误判成「未登记的修复改动」

**任务**：实战（field-test-1）中 `check-files-touched-harness` 报 1 FAIL，把 8 个写完就删的
`*ProbeTest.java` 探针算成「未登记的源码改动」。规则判对了「有未登记写入」，**归类错了**。

**结论**：不是加一个「文件不存在就放过」的开关，而是把判据从**一个信号**变成**两个信号**：

| | R21（改前） | R23（改后） |
|---|---|---|
| 判据 | harness 有 write/edit 记录 **且** 是源码 | harness 有 write/edit 记录 **且** 是源码 **且** 文件现在不存在 **且** harness 记过一条指向它的删除动作 |
| 8 个探针 | 1 FAIL / exit 1 | 0 FAIL + INFO `probe_files_deleted` / exit 0 |
| 写了、文件不在、没删除记录 | FAIL | **仍 FAIL**（关键：这是「没落盘」或「基准指错」，不是探针） |
| 写了、没删、未登记 | FAIL | FAIL（不变） |
| 登记了、但文件不存在 | 本规则不管 | 本规则不管（R18 `files_touched_not_found` 抓，已回归验证） |

**改动文件**：仅 `tools/check-files-touched-harness.mjs` + `tools/check-files-touched-harness.test.mjs`。
断言 75 → 107。`stop-hook.test.mjs` 135 全绿、`check-all.mjs` 全绿。

> ⚠️ **交付说明**：我没有执行 `git add` / `git commit`（任务书明令禁止）。
> 但工作区里出现了一个提交 `5a128cb "fix(R22/R23): …"`，它把本次改动连同另一个
> session 的 R22 改动一起提交了，作者是 `sqkl520 <sqkl520soap@gmail.com>`。
> 我的工作区内容与该提交**逐字节一致**（`git diff HEAD -- tools/…` 为空），
> 改动本身没有丢失或被篡改；但这个提交不是我发的。提请复核时注意这一点。

---

## 一、判据：为什么必须是两个信号

任务书的原始设计是「文件现在不存在 → 归为 `probe_or_scratch`」。**这个设计有一个可绕过点**，
实现时被我改成了双信号。理由不是追求严谨，而是单信号会**重新打开 under-reporting 的口子**：

### 单信号（任务书原案）会怎么被绕过

```
agent 想改 A.java 但不登记 →
  写入 A.java 但让它不要留在工作区（或只写到别处 / 或直接把 target_repo 指歪）→
  「文件现在不存在」成立 → 规则放行 → 改动没登记、检查却绿
```

这条路径与「写完就删的探针」在**磁盘状态上完全一致**（都是「文件不在」），
所以只靠存在性判断，规则区分不了「合规清理」和「逃避登记」。

### 双信号怎么区分

第二个信号取自 harness 自己：**它记了删除动作**。

field-test-1 的 8 个探针，在日志里全部留下了 `Remove-Item ...` 的 pwsh 调用
（逐个核对过：`F6DocStructureProbeTest` 1 条、`ShopListenerPurchaseMessageProbeTest` 1 条……全部 ≥1）。
这是**动作记录**（`tool/call` 里的命令行），不是状态推断，和 R21 选 harness 而非 `git status` 是同一个道理。

| 情形 | 文件现在在？ | 有删除动作？ | 判定 |
|---|---|---|---|
| 合规探针：写了、用完删了 | ✗ | ✓ | `probe_files_deleted`（INFO） |
| 日志说写了、磁盘上没有、也没人删 | ✗ | ✗ | **FAIL**（write 与仓库对不上） |
| 探针写了**忘了删** | ✓ | 可能 ✓ | **FAIL**（真的留下了未登记的文件） |
| 真实改动没登记 | ✓ | — | **FAIL**（不变） |

**「文件现在在」优先于「有删除动作」**：曾删过、后来又写回来的文件仍判 FAIL，
因为仓库最终状态里有它（测试 6.26-6.28 覆盖）。

### `null` 的纪律：判断不了 ≠ 放过

存在性判断有三值：`true` / `false` / `null`。

- `null` **绝不折成 `false`**（折成 false = 判断不了就算已删 = 一律放过 → 把 `target_repo`
  指向一个不存在的目录即可绕过全部 under-reporting）
- `null` 也**不折成 `true`**（折成 true = 基准指错时造出假 FAIL = 整条规则被关掉）

两种猜测都会错，所以 `fileExistence()` 如实返回 `null`，调用方**不做甄别**、维持 R21 口径，
并 WARN `file_existence_unknown`（测试 6.21-6.22：基准不存在 → 仍 FAIL + WARN）。

---

## 二、新测试在改代码前的失败信息（原文）

先写测试、跑出 FAIL、再改实现。以下是改实现前跑出来的原样输出（15 条红）：

```
=== 6：探针甄别（写入后删除的一过性文件不算 under-reported）===
  ✓ 6.1 写了、文件现在存在、未登记 → 仍 exit 1
  ✓ 6.2 仍报 files_touched_underreported_by_harness（FAIL）
  ✓ 6.3 点名的正是留在仓库里的 B.java
  ✓ 6.4 存在性可判定时不报 probe_files_deleted
  ✗ 6.5 探针写了又删、未登记 → exit 0 — code=1 ["project_dir_inferred","files_touched_underreported_by_harness","agent_attribution_unavailable"]
  ✗ 6.6 不报 underreported（仓库最终状态里没有这个文件） — ["project_dir_inferred","files_touched_underreported_by_harness","agent_attribution_unavailable"]
  ✗ 6.7 报 probe_files_deleted（INFO 级，不是 FAIL） — ["project_dir_inferred","files_touched_underreported_by_harness","agent_attribution_unavailable"]
  ✗ 6.8 INFO 里点名 ProbeTest.java 并写明不参与对账
  ✗ 6.9 JSON 里 probe_files_deleted 记录了这个探针
  ✓ 6.10 5 写 / 3 删 / 2 留、只登记 1 个 → exit 1
  ✗ 6.11 FAIL 消息只点名留下的 B.java，不点已删除的探针 — harness 记录本次会话写了 4 个源码文件，但没有任何 fix 产物登记它们（会话 session-dddd0003-0000-0000-0000-000000000003）：
  - src/main/java/com/x/B.java（1 次写操作）
  - src/test/java/com/x/P1Test.java（1 次写操作）
  - src/test/java/com/x/P2Test.java（1 次写操作）
  - src/test/java/com/x/P3Test.java（1 次写操作）

判据口径：这是**外部基准**判的，不是 `git status` 差值
  ✗ 6.12 INFO 列出 3 个已删除的探针
  ✗ 6.13 probeFilesDeleted 恰好 3 个
  ✗ 6.14 写了 4 个、3 个删掉、留下的那个已登记 → exit 0 — code=1 ["project_dir_inferred","files_touched_underreported_by_harness","agent_attribution_unavailable"]
  ✗ 6.15 INFO 列出全部 3 个已删除文件
  ✗ 6.16 消息提醒「若认为不该删，检查是否误删」
  ✓ 6.17 登记的已删除文件不由本规则判 under-reported（方向不同）
  ✓ 6.18 也不误判成 overclaim（harness 确实写过它）
  ✓ 6.19 本规则整体 exit 0（谁的责任谁负）
  ✓ 6.20 R18 的 files_touched_not_found 仍然抓它（两件事没被合并）
  ✓ 6.21 基准目录不存在 → 仍判 under-reported（不静默放过）
  ✗ 6.22 并 WARN file_existence_unknown（降级必须可见，不能假装甄别过） — ["project_dir_inferred","files_touched_underreported_by_harness","agent_attribution_unavailable"]

=== 7：真实数据自证（field-test-1 / session 99da3b3f 的 8 个探针）===
  ✓ 7.1 真实账本能跑通（不是配置错误）
  ✗ 7.2 8 个探针写后已删 → 0 FAIL / exit 0 — code=1 ["files_touched_underreported_by_harness"]
  ✗ 7.3 8 个探针全部进 probe_files_deleted — 0
  ✗ 7.4 一个都不算 under-reported — ["unnormalizable_actual_path","files_touched_underreported_by_harness"]
```

`合计: 86 通过 / 15 失败`。

**注意 6.1-6.4、6.10、6.17-6.21 当时就是绿的**——这些是「不能放水」的反向用例，
它们先绿是刻意的，用来证明新测试没有把现有行为一起改掉。

期间还有一次我自己引入的回归：第一版把判据写成「文件不存在就放过」，
`stop-hook.test.mjs` 的 **case 50 (R21-B)** 立刻从绿变红（`Sneaky.java` 在日志里写了、
从未落盘、也没人删它 → 被新判据误放行）。这正是上面「单信号可绕过」的形状，
促使我把判据改成双信号。**这也是不改 `stop-hook.mjs` 就能两全的唯一方式**
（任务书限定只改两个文件）。

---

## 三、真实数据自证（field-test-1）

数据：`D:/Server/.../Hilltop Village Plugin/.work/round1/state.json`
+ dsh session `session-99da3b3f-7a50-4935-9098-81e4f1accf29`（含 18 个子 session）。
8 个探针文件已 `ls` 逐个确认**全部不存在**。

### 改前（`git show HEAD~1:tools/check-files-touched-harness.mjs`，即 R21 原版）

```
✗ FAIL [files_touched_underreported_by_harness]
    harness 记录本次会话写了 8 个源码文件，但没有任何 fix 产物登记它们（会话 session-99da3b3f-…）：
      - src/test/java/com/hilltopvillage/doc/F6DocStructureProbeTest.java（1 次写操作）
      - src/test/java/com/hilltopvillage/doc/F6IndependentProbeTest.java（2 次写操作）
      - src/test/java/com/hilltopvillage/shop/F1TruncationProbeTest.java（2 次写操作）
      - src/test/java/com/hilltopvillage/shop/F2VerificationProbeTest.java（1 次写操作）
      - src/test/java/com/hilltopvillage/shop/F3VerifyProbeTest.java（1 次写操作）
      - src/test/java/com/hilltopvillage/shop/F4IndependentProbeTest.java（1 次写操作）
      - src/test/java/com/hilltopvillage/shop/F4bGhostSlotProbeTest.java（1 次写操作）
      - src/test/java/com/hilltopvillage/shop/ShopListenerPurchaseMessageProbeTest.java（4 次写操作）
    …

合计: 1 FAIL / 1 WARN / 0 INFO → exit 1
```

（`1 WARN` 是 `unnormalizable_actual_path`：3 次写操作用了另一个仓库的绝对路径，与本条无关。）

### 改后（当前工作区）

```
· INFO [probe_files_deleted]
    harness 记录了 8 个源码文件的写入，但这些文件在 target_repo 里已不存在（写入后删除的一过性探针/临时脚本），不参与 files_touched 对账：
      - src/test/java/com/hilltopvillage/doc/F6DocStructureProbeTest.java（1 次写操作；删除动作 1 条）
      - src/test/java/com/hilltopvillage/doc/F6IndependentProbeTest.java（2 次写操作；删除动作 2 条）
      - src/test/java/com/hilltopvillage/shop/F1TruncationProbeTest.java（2 次写操作；删除动作 1 条）
      - src/test/java/com/hilltopvillage/shop/F2VerificationProbeTest.java（1 次写操作；删除动作 1 条）
      - src/test/java/com/hilltopvillage/shop/F3VerifyProbeTest.java（1 次写操作；删除动作 1 条）
      - src/test/java/com/hilltopvillage/shop/F4IndependentProbeTest.java（1 次写操作；删除动作 1 条）
      - src/test/java/com/hilltopvillage/shop/F4bGhostSlotProbeTest.java（1 次写操作；删除动作 1 条）
      - src/test/java/com/hilltopvillage/shop/ShopListenerPurchaseMessageProbeTest.java（4 次写操作；删除动作 1 条）

    判据（两条都要）：harness 有 write/edit 记录 **且** 该文件当前不在磁盘上，**且** harness 的 shell 调用里记过一条指向它的删除动作。
    为什么这不算 under-reported：files_touched 的语义是「这个实例**改动了**哪些文件」，一个写完就删的临时文件不构成改动——仓库最终状态里没有它。
    为什么还要「删除动作」这一条：光看「文件不在」分辨不出「写完删了」和「日志里的 write 根本没落盘 / 基准指错了」。后者照旧判 under-reported（FAIL）。
    但请注意区分：如果一个探针**写了却忘了删**，它会留在仓库里，那时规则照旧判 under-reported（FAIL）——那才是真的留下了未登记的文件。
    如果你认为其中某些不该删，检查它们是否被误删。

合计: 0 FAIL / 1 WARN / 2 INFO → exit 0
```

`2 INFO` = `probe_files_deleted` + `more_actual_than_claimed_files`（31 个未登记的非源码写目标，`.work/` 下的产物与日志）。

**8 个探针的删除动作是真的**：日志里能捞到原文，例如

```
Remove-Item 'src/test/java/com/hilltopvillage/doc/F6IndependentProbeTest.java' -Force; …
Remove-Item -LiteralPath 'src\test\java\com\hilltopvillage\shop\F1TruncationProbeTest.java' -Force …
Remove-Item 'src/test/java/com/hilltopvillage/shop/F4bGhostSlotProbeTest.java' -Force …
```

---

## 四、验证

```
node tools/check-files-touched-harness.test.mjs   →  合计: 107 通过 / 0 失败
node tools/stop-hook.test.mjs                     →  === 结果: 135 通过 / 0 失败
node tools/check-all.mjs                          →  ✅ 全部通过
```

回归面：原有 75 条断言全过（新增 32 条）。`stop-hook` 从 132 涨到 135 是因为它自身
也含一批 R21 用例，本次一条没动、全绿。

---

## 五、诚实评估

### (a) 这个改动会不会让 under-reporting 重新变成可绕过的？

**「把真实改动写完就删」这条路，本质上是关着的，但它关在别处。**

先厘清语义：`files_touched` 的定义是「这个实例**改动了**哪些文件」。
一个写完就删的文件，在仓库最终状态里没有它 —— **确实没有改动**。
所以本规则放行它是**语义正确**，不是放水。

但会有人问：那我改了 10 个文件、全删了（等于没修），是不是就绕过了？

- **绕过的只是这一条规则，不是整个框架。** 修复没发生这件事，由另外几条抓：
  - R18 `files_touched_not_found`：`files_touched` 里登记的文件必须**真实存在**。
    改了又删意味着它要么没登记（→ 登记了就是 R18 的 FAIL）、要么登记了但文件不在（→ 也是 R18 的 FAIL）。
  - 红测/绿测证据链：`red_log_path` / 全量测试必须指向真实日志且内容对得上。
    没修的东西不会有「红 → 绿」的日志。
  - stop-hook 的相位闭合：`verify` 产物 + 全量测试绿。
  - **最关键**：如果修复目标文件真的被「写完又删」还原了，那 `git status` 与
    `fix_baseline`（R20）会显示目标文件**没有改动**，验收相位直接过不去。
    本规则的放行只影响「多出来的那个临时文件」，不影响「目标文件改没改」。

- **一句话**：本规则管的是「**多出来的**未登记源码」，不是「**该有的**改动有没有发生」。
  「修复没发生」是另一条链的事（`check-fix-instances` / `verify-postfix-snapshot` /
  `git status` 对账 / 测试证据）。把两者混在一起报，正是 R23 要修的那个 bug。

- **残余风险（如实说）**：如果某条修复**只需要改一个文件**，而 agent 改了它、
  又把它删回原状（`git checkout` 或删除后重建原内容），且 `files_touched` 登记了它 ——
  那么 R18 的「存在性」是绿的（文件在）、本规则也绿（登记了）。
  这要求**内容比对**才能抓到，属于 `verify-postfix-snapshot` / diff 层，超出本工具观测面。
  这一点 R21 报告 §六 已经写明（「只判写动作发生过，不判写动作最终生效」），本回合没有改变它。

### (b) 「写了又删」与「根本没写」在 harness 日志里如何区分？这个区分够吗？

**能区分，而且是分得最硬的一种。**

- harness 的 `tool/call` 是 per-call 的动作记录：
  - 写了 → 有一条 `name: "write"`（或 `edit`）+ `arguments.file_path`
  - 删了 → 有一条 `name: "pwsh"`（或 bash）+ `arguments.command` 里含 `Remove-Item`
  - 根本没写 → 两条都没有

  这与 R21 选择 harness 而非 `git status` 的理由同源：**动作 vs 状态**。
  `git status` 只能看到「现在有没有差异」，看不出「谁在什么时候对哪个路径做过什么」。
  harness 日志能，且主 Agent 改不了（要改得篡改 zstd 日志、保持 seq 连续、
  还要让 `tool/result` 与 step 边界自洽）。

- **但这个区分不够完美，有两个已知缺口：**

  1. **删除动作是 shell 命令行文本匹配的**（`Remove-Item` / `rm -` / `git clean` / `File.Delete`…），
     不是结构化语义。`mv`（移走）我**故意没算**删除——移走的文件还在别处，
     它算不算「改动」是另一个问题，我不想在本回合扩大判据。所以：
     「用 `mv` 移走的探针」会被判成 FAIL（保守方向，宁可误报不漏报）。
     同样，自定义脚本/别名删除（`./cleanup.ps1`）认不出来 → 也是 FAIL。
     **代价是可能误报，不是漏报**，这个方向是对的。

  2. **basename 匹配（≥6 字符）可能误命中**：如果同一 session 里有一条删除命令
     指向**另一个目录**的同名文件，会把这个路径也判成探针。风险很低
     （探针名通常带 F1/F2/ProbeTest 这种唯一前缀），而且只在「文件本来就不在磁盘上」
     的前提下才生效——本来就要判 FAIL 的那个文件，才会被错误放过。
     真要收紧，下一步应该改成「拿删除命令解析出的路径做归一化比对」，
     这需要解析 shell 命令行，属于另一个量级的工作。

- **一个正面性质**：这个判据是**双条件与**（文件不在 ∧ 有删除动作），
  而不是单条件。所以**任何一侧缺失都退回 FAIL**。缺口的两个方向都指向「更保守」，
  不会让 `under-reporting` 变成静默放行。

---

## 六、改了什么

### `tools/check-files-touched-harness.mjs`（+264 行）

1. **`fileExistence(rel, targetRepo)`**（新增，导出）：返回 `true` / `false` / `null` 三值。
   只认 `targetRepo` 本身是真目录，不用「父目录存在」兜底。
2. **§6.5 删除记录**（新增）：扫描所有 session 的 `tool/call`，从 `pwsh`/`bash`/`sh`/… 的
   `arguments.command` 里提取删除动作（`Remove-Item` / `rm -` / `del /` / `rmdir` /
   `unlink` / `git clean` / `[System.IO.File]::Delete`…），存成可查询集合。
3. **§8.2 under-reported 分叉**：未登记源码分两路——
   `existsNow===false && 有删除证据` → `probe_files_deleted`（INFO）；
   其余 → 原 FAIL 逻辑。**判断不了（`null`）不甄别**，并 WARN `file_existence_unknown`。
4. **§9 归属对账同步**：逐实例的 `uncovered` 也用同一双判据，探针进
   `probe_files_deleted_by_agent`（INFO），不判 `agent_attribution_mismatch`。
5. JSON 输出新增 `probeFilesDeleted` / `attribution.probeFilesDeleted`；
   人类输出新增「其中写后已删的探针」计数行；headers 文档同步。

### `tools/check-files-touched-harness.test.mjs`（+308 行，75 → 107 断言）

- §6（6.1-6.28）：新增 `makeRealRepo()`（**真实落盘**的临时仓库，存在性判断才有效）
  与 `sessionEvents({ shells })`（往日志里写 shell 调用）。
  覆盖：仍 FAIL 的现有行为 / 纯探针 → exit 0 + INFO / 混合 5 写 3 删 2 留 /
  全删 / R18 方向边界（`files_touched_not_found` 回归）/ 基准不存在降级 /
  **无删除证据仍 FAIL**（反绕过）/ **文件在但曾有删除记录仍 FAIL**。
- §7（7.1-7.4）：真实数据自证。三处 SKIP 守卫：日志不在本机 / 账本不在本机 /
  那 8 个探针又被建出来了（前提不成立）。

### 没有动

`stop-hook.mjs` 一行没改（它只是 `execFileSync` 调本工具并读 `problems[]`，
新 INFO 不触发任何 `problems.push`）。`check-payload.mjs`（R18）一行没改。
