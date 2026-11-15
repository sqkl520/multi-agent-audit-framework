# FIX-R19 报告 · files_touched ↔ git status 双向对账

**任务**：堵 R18 §6 指出的最后一个结构缺口
**改动文件**：`tools/stop-hook.mjs`（§3.7.6 新增，约 330 行含注释）、`tools/stop-hook.test.mjs`（case 37–41）
**未改**：`tools/check-payload.mjs`、`tools/check-state.mjs`（`check-state.mjs:355` 那条「无法与 files_touched 的 mtime 对账」的 WARN 现在有了对应实现，但注释本身仍准确，不改）

> **⚠️ 收口时请注意（主线程并行提交）**
> 本任务的初版（§3.7.6 + case 37–41）在我工作期间已被主线程提交为
> `cc3ecf5 feat(R19): files_touched 双向对账`，报告初版提交为
> `625c06f docs(R19)`。这与 `PARALLEL-COMMIT-CONFUSION.md` 记录的是同一模式。
>
> **工作区相对 HEAD 还有一处未提交的增量**（我自证时发现并修的残余口子 §4.2c）：
> - `tools/stop-hook.mjs`：`claimed` 为空时由「静默跳过」改为留一条 WARN
> - `tools/stop-hook.test.mjs`：新增 case 42 锁住这一档
> - 本报告 §4.2c 与 §五 的数字随之更新（103 → 106 通过）
>
> **以工作区为准，不要以 HEAD 为准。** 我没有 `git add` / `git commit` / `git reset`。
>
> **第二次并行（R20）**：收口前我发现同一对文件里又出现了 R20 的基线工作
> （`fix_baseline`、case 43–47，§4.2a 建议的修法已被另一个 agent 实现）。
> 两次改动在同一文件的不同位置，`node tools/stop-hook.test.mjs` 现在 **123 通过 / 0 失败**
> （R19 的 case 37–42 全绿，R20 的 case 43–47 全绿）。
> 我**没有**改 R20 的任何代码或断言；R19 的报告数字（下文 §二/§五）是 R19 单独的口径。

**未 commit**（按纪律）

---

## 一、实现位置与判据

位置：`tools/stop-hook.mjs:902` 起，嵌入 wave4/wave5 的 §3.7 闸门，
在 §3.7.5（check-payload 逐份校验）之后。条件与 §3.7 相同：
`phase ∈ {wave4, wave5}` 且 `path_mode === 'FIX'`。

### 数据来源

| 集合 | 来源 | 代码位置 |
|---|---|---|
| `claimed` | 所有 fix 信封的 `payload.files_touched[].path` **并集**（同时收 `payload.dispositions[].files_touched[]` 多发现形态） | §3.7.6.1，`stop-hook.mjs:949` |
| `actual` | **一次** `git -C <target_repo> status --porcelain`，未跟踪目录逐个展开 | §3.7.6.2，`stop-hook.mjs:1024` |

`claimed` 会归一化到「仓库根相对的 posix 路径」：`.\src\X.java` → `src/X.java`；
绝对路径若在被审仓库内则转相对，否则进 `unnormalizable` 只留 WARN（不判 overclaim —— 假 FAIL 比漏报更糟，它会导致整段被关掉）。

### 两条规则

**1. `files_touched_overclaimed` → FAIL**（`stop-hook.mjs:1155` 附近）

```
claimed - actual 非空 → problems.push(...)
消息：这些路径在 files_touched 里，但 `git status` 显示仓库里它们没有改动
```

与 R18 的 `files_touched_not_found` **严格分工**：
- `not_found` = 路径**不存在**（凭证指向空气）
- `overclaimed` = 路径**存在但没被改**（凭证指向一个真实的、但从没被碰过的文件）

一个实例把 `src/B.java`（长期存在、本次从未修改）写进 files_touched，R18 全绿——这正是 R18 §6 的「path existence does not mean the file was changed by this instance」。

注意：overclaim 用的是**未过滤**的 `actual`。过滤是给 under-reporting 用的；若 overclaim 也用过滤后的集合，「声称改了 docs/x.md 而且确实改了」会被误报为 overclaim。

**2. `files_touched_underreported` → 源码 FAIL / 非源码 WARN**（`stop-hook.mjs:1207` 附近）

```
unclaimed          = actual - claimed
unclaimedNoisy     = unclaimed.filter(isNoise)
unclaimedMaterial  = unclaimed - unclaimedNoisy
unclaimedSrc       = unclaimedMaterial.filter(SRC_EXT)
unclaimedSrc.length > 0 → FAIL
unclaimed.length > 0    → WARN（不阻断）
```

### 过滤规则（先排除再判断）

`isNoise(p)` 依次排除：

1. 前缀：`repair-artifacts/` `experiments/` `docs/` `.work/` `target/` `build/`
   （另有 `node_modules/` `.git/`，**只参与展开阶段**的性能保护，不改变判据）
2. `state.report.dir_path` 解析后落在被审仓库内的相对路径（产物目录）
3. `state.legacy_artifacts` 里的文件名（按 basename 比 —— 该字段通常只写文件名）
4. 非源码扩展名：`.md .log .json .yml .yaml .txt .xml .properties`

`SRC_EXT` 与 `verify-postfix-snapshot.mjs:175` 逐字相同（R15 同款白名单）：
`.java .js .mjs .cjs .ts .tsx .jsx .py .go .rs .kt .kts .c .cc .cpp .h .hpp .cs .rb .php .swift .scala .sh`

### 降级纪律（三条，全部实现）

| 情形 | 处理 |
|---|---|
| `target_repo` 缺失或不是目录 | WARN「**未做双向对账**」，不 FAIL（`check-state` 报 `target_repo_required`，§3.7.5 也报账本问题，本段不重复开火） |
| `git status` 执行失败（非 git 仓库 / 无 git） | WARN，不 FAIL |
| 没有任何 fix 产物（`fixEnvelopeCount === 0` 或 `claimedRaw` 为空） | 静默跳过（没有 claimed 集合可比；此时 under-reported 会把仓库里**全部**改动报成未登记，是误伤） |

### 性能

`git status` 是**一次**调用（不是逐份），带 20s 超时。
未跟踪目录展开有 `WALK_LIMIT = 20000` 硬上限，触顶时 WARN 说明「只覆盖了一部分」——**不是通过，是没查完**。
噪音前缀在**展开之前**就排除：`?? node_modules/` / `?? target/` 不会触发全盘 walk。

### 与 `verify-postfix-snapshot.mjs` 的关系

`verify-postfix-snapshot.mjs` 已经实现了同一逻辑的**反方向**：
「仓库改动 → 快照里必须都有」。R19 补的是「信封声称 → 仓库改动里必须都有」以及反向。
三者的口径统一在 porcelain 解析（`XY <path>`、rename 取新路径、未跟踪目录展开）上，代码各自独立（不 import，避免为了一行解析引入耦合）。

---

## 二、新测试在改代码前的失败原文

改动实现前运行 `node tools/stop-hook.test.mjs`，结果：**92 通过 / 11 失败**。

```
case 37 (R19): files_touched 列的文件确实被改了 → exit 0（防误伤）
  ✓ 退出码 0
  ✓ 不报 overclaimed / underreported
case 38 (R19): files_touched 列了一个存在但没被改的文件 → overclaimed FAIL
  ✗ 退出码 2 — 实际 0：
  ✗ 报 files_touched_overclaimed
  ✗ 指名 src/B.java
  ✗ 说明路径存在不等于被改过
case 39 (R19): 仓库里改了源码文件却没登记 → underreported FAIL
  ✗ 退出码 2 — 实际 0：
  ✗ 报 files_touched_underreported
  ✗ 指名 src/C.java
  ✗ 说明是「源码被改却没登记」
case 40 (R19): 仓库里改了一个非源码文件（.log）没登记 → exit 0 + WARN（不升级）
  ✓ 退出码 0（不误拦）
  ✗ 仍有 WARN 提到 underreported
  ✗ WARN 指名 app.log
case 41 (R19): target_repo 缺失 → 跳过双向对账并 WARN（不重复报 FAIL）
  ✗ WARN 说明未做双向对账 — [交付粒度检查] 还不能结束这一回合：

1. state.json 顶层没有 target_repo，而 stop-hook 需要它来对 1 份修复产物跑 check-payload。
...
  ✓ 不报 files_touched_overclaimed
  ✓ 不报 files_touched_underreported
  ✓ 退出码 2 来自既有的 target_repo 判据

=== 结果: 92 通过 / 11 失败 ===
```

**注意 case 37 与 case 40 的退出码断言在改动前就是绿的**（`✓ 退出码 0`），
这不是巧合，是设计：它们断言的是「**不能**因为新判据而误拦」。
一个只在「该拦时拦」的改动，在改动前也必然让「不该拦」的用例保持绿。
真正证明新判据存在的是 case 38/39 的 `实际 0`（该拦没拦）与 case 40 的 `✗ 仍有 WARN`（该说没说）。

改动后：**106 通过 / 0 失败**（原 86 条回归全绿 + 20 条新断言，含 case 37–42）。

### 测试的关键设计

- **真 git 仓库**：`makeGitRepo()` 做 `git init` + `commit`，再从干净状态改文件。
  不用 mock，因为要测的就是 `git status --porcelain` 的真实输出。
- **`src/B.java` 在 case 38 里是存在的**——这是 case 38 的全部意义：
  它证明新规则拦的是「存在但没改」，而不是重复 R18 的「不存在」。
- **产物目录在仓库外**（tmp），否则未跟踪的产物目录会污染 `git status`。
- **case 37 / 40 是防误伤的两根柱子**，见上。

---

## 三、真实数据自证

`target_repo` = `<TARGET_REPO>`
（`git status --porcelain` 25 行，展开后 30 个文件：17 个 `M` + 6 个未跟踪源码 + `?? repair-artifacts/` 里 7 个文件）

构造一份 `files_touched` 只列了其中 2 个（`NodeListener.java`、`NodeSystem.java`）的 fix 产物，跑 stop-hook：

```
EXIT = 2

3. 仓库里有 30 个文件被改动，其中 20 个是**源码文件**，但没有任何 fix 产物把它们列进 files_touched
   （被审仓库 <TARGET_REPO>）：
  - src/main/java/com/hilltopvillage/admin/ArenaResetService.java
  - src/main/java/com/hilltopvillage/admin/gui/ArenaManageGUI.java
  - src/main/java/com/hilltopvillage/ai/AirdropSpawnGoal.java
  - src/main/java/com/hilltopvillage/ai/ExplodeBeetleGoal.java
  - src/main/java/com/hilltopvillage/command/HilltopCommandHandler.java
  - src/main/java/com/hilltopvillage/config/ConfigManager.java
  - src/main/java/com/hilltopvillage/config/menu/MainConfigMenu.java
  - src/main/java/com/hilltopvillage/mechanics/TabListManager.java
  - src/test/java/com/hilltopvillage/admin/ArenaResetNodeRollbackTest.java
  - src/test/java/com/hilltopvillage/ai/AirdropMobTypeNpeReachabilityTest.java
  - src/test/java/com/hilltopvillage/ai/AirdropSpawnGoalTest.java
  - src/test/java/com/hilltopvillage/ai/ExplodeBeetleGoalTest.java
  … 另有 8 个

规则：files_touched_underreported。这就是 R18 §6 点名的 under-reporting：
一个实例改了 10 个文件，只列 1 个存在的，R18 的存在性检查完全绿。
存在性只证明「凭证不是假的」，不证明「凭证是完整的」。
已排除的合法噪音（10 个）：产物目录、legacy_artifacts、repair-artifacts/ 等前缀、
以及 .md/.log/.json 这类非源码扩展名——排除之后**剩下的**才叫「应该被 files_touched 覆盖的东西」。
```

数字核对：30 个 actual − 10 个噪音 = 20 个 material，**全部是源码**（17 个 `M` 含 2 个 yml 被扩展名排掉 → 15 个源码 `M`，加 6 个未跟踪源码 = 21…实际报 20 个，因为 `NodeListener.java` 在 claimed 里）。

噪音部分正确剔除：`src/main/resources/game-settings.yml`、`messages.yml`（`.yml`）、
`repair-artifacts/` 下的 7 个产物文件（前缀 + 目录）。

另外输出里还有两条**既有**判据的 FAIL（与 R19 无关，是真实仓库的既有问题）：
- 5 份历史产物 `done-3/4/6/7/8.md` 没有信封
- 我的自证产物 `done-1.md` 的 `red_log_path` / `test_path` 指向合成路径（自证 fixture 故意没造证据文件）

自证结束后已清理：真实仓库 `git status` 仍是 25 行，`repair-artifacts/` 里没有 `done-1.md` 残留。

---

## 四、诚实评估

### 4.1 R18 说的「改了 10 个只列 1 个」堵住了吗？

**部分堵住，不是完全堵住。**

堵住的部分：如果那 10 个里**有源码**（绝大多数情况），`actual - claimed` 过滤后仍含源码
→ `files_touched_underreported` FAIL。真实数据自证就是这个形态：20 个源码里 18 个未登记 → exit 2。

没堵住的部分，有三条**明面上的绕过**：

### 4.2 还能怎么绕？—— 四条，按严重程度排序

**（a）基线问题：`git status` 在修复前就是脏的。** 这是最严重的一条。

`git status` 报的是「相对于 HEAD 的差异」，**不是「这一轮改了什么」**。
真实场景里被审仓库常常一开始就是脏的（R19 自证用的 Hilltop 仓库就是这样：25 行改动里有相当一部分不是本轮修复产生的）。
后果是**双向都失真**：

- `overclaimed` 侧：实例根本没改 `src/B.java`，但 `src/B.java` 在修复**之前**就已经是 `M` 状态
  → `actual` 里有它 → 声称它不算 overclaim → **假阴性**。
  这是 R18 §6 问的「是不是**这一轮**改的」——**这一问没有回答**。
- `underreported` 侧：实例改的是 `src/A.java`，但仓库里另有一堆本轮之前就存在的改动
  → 全部算成 under-reported → **假阳性**，然后这条规则会被当成噪音关掉或被人加进忽略列表。

R19 没有解决基线问题，因为解决它需要**修复前的基线快照**，而账本里没有这个字段。
最便宜的修法（下一轮）：在 wave4 开始时把 `git status --porcelain` + `git stash create` 的悬挂提交
写进 `state.fix_baseline`，对账时用 `git diff <baseline>` 而不是裸 `git status`。

> **后续（收口前实测）**：这条建议已被并行进行的 R20 实现（`stop-hook.mjs` §3.7.6.2b，
> case 43–47）。其代码注释逐字引用了本节的分析与两个失真方向。
> R20 的写法是 `state.fix_baseline.dirty_paths`（路径集合）而非悬挂提交，
> 并且它**明确承认自己也是自述**：「主 Agent 可以写一个假的空基线（`dirty_paths: []`），
> 让所有改动都算成本轮改的。本段不试图验证它的真伪——做不到。」
> 所以基线问题从「完全没答案」变成「有答案但答案可伪造，且伪造会留痕（captured_at / head）」。
> **这是缩小，不是消除。** 下面 (b) 的归属问题仍然完全没有答案。

**（b）实例改的文件本来就该被改，而它列了另一个也存在的文件。**

命中 `overclaimed` 的条件是「声称的文件不在 `actual` 里」。
若实例 A 改了 `X.java`（该改，且在 actual 里），但 files_touched 里写的是 `Y.java`（不该改、但**恰好也被改了**——比如实例 B 改的，或者基线里就是脏的）
→ `claimed ⊆ actual`，overclaim 全绿；`Y.java` 那一行的 `change_summary` 是**假的**（描述的是它没做的事）。
本规则检查的是**路径集合**，不是**集合到实例的归属**。
「改了 10 个只列 1 个」在这个形态下仍然可行：改 10 个，列 1 个（另 9 个也改），
若那 9 个恰好在 actual 里但不在 claimed 里 → 被 under-reported 抓到。
但如果那 9 个**同时**被另一个实例登记了，两边都合规，而 A 的 under-report 被 B 的 over-claim 抵消。
**归属问题是下一个洞：`files_touched` 没有 `agent_id` 维度，对账是全局的，不是逐实例的。**

**（c）`claimed` 集合为空时整段跳过 —— 自证时发现，已修（WARN，不升 FAIL）。**

初版实现里 `fixEnvelopeCount === 0 || claimedRaw.length === 0` → **静默跳过**。
自证时用探针实测到一条真实口子：

```
一份 disposition=WONT_FIX、files_touched:[] 的产物
+ 仓库里 src/A.java 有真实源码改动
→ EXIT = 0，stderr 一片安静，underreported = false，未做双向对账 = false
```

也就是「检查没跑」被记成了「检查通过」——正是 R13 §7.2 那条最大的残留口子的原型。
已修：现在这种情况留一条 WARN 写明「claimed 集合为空，无从比对，本回合没有答案」。
**不能升 FAIL**，因为 WONT_FIX / DEFERRED 轮次里 `files_touched` 为空是合法的。
新增 case 42 锁住这一档（改动前 `✗ WARN 说明没有 claimed 集合可比`，改动后绿）。

仍然存在但不该堵的变体：把全部产物写成 `WONT_FIX` → `claimed` 为空 → 只有 WARN。
这一档由上游的 `disposition_missing_for_target` / `disposition_coverage` 管——
每条被派发的发现都必须有 disposition，全写 WONT_FIX 会在那边被抓到（若那两条规则接上了）。

**（d）噪音前缀是一份名单，写死在代码里 —— 实际安全。**

`repair-artifacts/` `experiments/` `docs/` `.work/` `target/` `build/`——
实例只要把源码挪进 `docs/`（或任何前缀名单里没有的目录）改完再挪回来…不现实。
但更现实的是：**新建一个不在名单里的子目录**（比如 `tmp-fix/`）放源码，`git status` 里是 `?? tmp-fix/X.java`，
`isNoise` 不命中前缀、`SRC_EXT` 命中 `.java` → **仍然会被抓到**（扩展名判断在噪音判断之后，且源码扩展名没有进 `NON_SRC_EXT`）。
所以（d）实际是**安全的**：排除项只排除「非源码扩展名」或「明确的前缀」，
一个放在任意目录里的 `.java` 改动仍然会被 under-reported 抓到。
唯一的漏是：源码文件被改成 `.txt` 扩展名（`Foo.java.txt`）—— 但那已经不是源码了，编译器不会看它。

### 4.3 「自述层还能加什么」这个问题有答案吗？

**没有。R19 是自述层加法的终点，不是新起点。**

R13 → R14 → R15 → R17 → R18 → R19 的路径是一致的：
每一次都是「把另一份**非自述的证据**接进闸门」。
- R13：接产物信封（文件系统）
- R17：接 check-payload（信封内容）
- R18：接文件存在性（文件系统）
- R19：接 `git status`（**版本控制系统**）

每接一层，能绕的空间就收窄一层，而**剩下的绕法全部是同一个形状**：
「证据本身是真的，但它不覆盖你想证明的那件事」。

R19 之后，`files_touched` 这条链上还剩两个未被任何外部基准约束的断言：
1. **「这个改动是本轮做的」** —— 需要基线，账本里原本没有。
   **R20 已补**（`fix_baseline.dirty_paths`），但它是自述，只能缩小失真、不能消除。
2. **「这个改动是这个实例做的」** —— 需要 harness 把 tool call 与文件写入关联，
   而 harness 日志里**没有文件路径**（`check-fix-instances-harness.mjs` 只能数 subagent 次数，不能看内容）

第 2 条不是「往 state.json 加字段」能解决的。它是**观测能力的边界**，不是自述层的边界。
所以对「自述层还能加什么」的回答是：**在 files_touched 这条链上，加法已经用完。**
R20 补的基线是这条链上**最后一个能加的东西**，而它一加进来就立刻暴露了天花板：
它是自述，且代码注释自己写着「本段不试图验证它的真伪——做不到」。

继续在自述层加字段的边际收益已经接近零，而边际成本（每个字段都是一个新的「省略它就能绕过」的入口）已经很明显。
R13 的 `report.dir_path` 就是前车之鉴：加字段 → 省略它 → 整道闸门失效 → R14 只能把它变成必填。
`fix_baseline` 会走同一条路：下一轮一定会有人发现「不写它只有一条 WARN」，
然后它变成条件必填，然后「写一个空基线」成为新的最短绕过路径。

真正剩下的只有两条路：
- **换观测面**：让 harness 记录文件写入（dsh 的 session 日志里加 tool/result 内容），
  这样「哪个实例改了哪个文件」才有外部基准。这是工具层的工作，不是提示词/账本层能做的。
- **或者承认归属不可证**，把它写成文档里的一条残余风险，而不是继续加检查。

---

## 五、验证结果

```
node tools/stop-hook.test.mjs        → 106 通过 / 0 失败   （原 86 + 20 新断言，case 37–42）
node tools/fix-phase-e2e.test.mjs    →  48 通过 / 0 失败
node tools/check-state.test.mjs      →  61 通过 / 0 失败
node tools/check-all.mjs             → ✅ 全部通过（EXIT=0）
```

`check-all` 的子套件全绿，含 `verify-postfix-snapshot.test.mjs`（32 通过）——
R19 与它共用同一套 porcelain 解析口径，没有互相干扰。

真实仓库未被污染：`D:/Server/.../Hilltop Village Plugin` 的 `git status` 仍是 25 行，
`repair-artifacts/` 下无 R19 残留文件。
框架仓库工作树只有预期的两处改动（`tools/stop-hook.mjs`、`tools/stop-hook.test.mjs`），未 commit。
