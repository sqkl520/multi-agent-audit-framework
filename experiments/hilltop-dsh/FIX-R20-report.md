# FIX-R20 报告 · 给双向对账加修复基线（`fix_baseline`）

**任务**：解决 R19 §(a) 指出的假阴/假阳——`git status` 在修复前就是脏的。
**改动文件**：`tools/stop-hook.mjs`（§3.7.6.2b 新增约 170 行 + 3.7.6.4/3.7.6.5 消息补「判据口径」）、`tools/stop-hook.test.mjs`（case 43–48，6 个 case / 21 条断言）、`framework/artifacts/run-state.md`（§2.7 + 第 2 节 JSON 块新增 `fix_baseline`）
**未改**：`tools/check-payload.mjs`、`tools/check-state.mjs`、`tools/verify-postfix-snapshot.mjs`
**我没有 commit**（按纪律；也没有 `git add`）

> **⚠️ 收口时请注意：主线程并行提交了这三个文件**
>
> 我在工作区改完并跑绿后，`7032e37 feat(R20): fix_baseline —— 对账从「相对 HEAD 的差异」
> 变成「本轮改动」` 出现了，包含的正是我改的这三个文件（+ R19 报告的增量）。
> 这是 `experiments/hilltop-dsh/PARALLEL-COMMIT-CONFUSION.md` 记录过的同一模式：
> 我**没有**执行任何 git 写操作，提交由另一个进程完成。
>
> 当前状态：工作区相对 `7032e37` 对这三个文件**零差异**（`git diff 7032e37 -- <三文件>` 为空），
> 所以**以 HEAD 与工作区任一为准都是我的版本**，不存在「报告与代码不一致」的风险。
> 唯一未跟踪的是本报告（`?? experiments/hilltop-dsh/FIX-R20-report.md`），我没有 add 它。
>
> 提交信息里写「stop-hook 103 -> 123 断言」——103 是**提交基线**（`625c06f`）的断言数；
> 我开始改之前工作区实际是 **106**（R19 收口的 case 42 增量当时还未提交，现已并入 `7032e37`）。
> 本报告 §二 的「106 + 17 = 123」用的是工作区口径，两者都对，只是分母不同。


---

## 一、字段定义（`framework/artifacts/run-state.md` §2.7）

```json
"fix_baseline": {
  "captured_at": "2026-11-16T09:12:00Z",
  "dirty_paths": ["src/legacy/A.java", "repair-artifacts/", "app.log"],
  "head": "11ae7223923721bf13846f0cbdfa73151a218fa8"
}
```

| 字段 | 类型 | 含义 |
|---|---|---|
| `captured_at` | `string` (ISO8601) | 抓基线的那一刻。**留痕用，不用于判定**。缺失 → WARN |
| `dirty_paths` | `string[]` | 进入 wave4 **之前** `git status --porcelain` 的全部路径（仓库根相对、正斜杠）。未跟踪目录写 `dir/`（带尾斜杠），按前缀覆盖其下所有文件 |
| `head` | `string` (commit sha) | 抓基线时的 HEAD。**留痕与诊断用**。缺失 → WARN |

文档里写清的三件事（§2.7.2 / 2.7.3 / 2.7.5）：

1. **为什么需要**：`git status` 报的是「相对于 HEAD 的差异」，不是「这一轮改了什么」。被审仓库常常一开始就是脏的。两个方向的失真方向相反——overclaimed 假阴性、underreported 假阳性。
2. **谁来写**：主 Agent 在进入 wave4 **之前**（派发第一个修复实例之前）抓一次，只抓一次。**不是必填**——缺失时降级为「相对 HEAD 的差异」并 WARN，理由是不能让所有存量账本一夜不合规；但**降级必须可见**，不能静默。
3. **诚实标注**：`fix_baseline` 是把假阴性/假阳性**缩小，不是消除。它本身也是自述。**

---

## 二、新测试在改代码前的失败信息原文

先写测试、确认 FAIL，再改实现。改代码前 `node tools/stop-hook.test.mjs` 的结果是
**112 通过 / 11 失败**，以下是原文（节选，未删改）。

### case 43（R20-A）：有基线，基线里已脏的文件不触发 underreported

```
case 43 (R20-A): 有基线，基线里已脏的文件不触发 underreported → exit 0
  ✗ 退出码 0 — 实际 2：[交付粒度检查] 还不能结束这一回合：

1. 仓库里有 1 个文件被改动，其中 1 个是**源码文件**，但没有任何 fix 产物把它们列进 files_touched（被审仓库 C:\Users\ADMINI~1\AppData\Local\Temp\gitrepo-qkTwix）：
  - src/pre-existing.java

规则：files_touched_underreported。这就是 R18 §6 点名的 under-reporting：一个实例改了 10 个文件，只列 1 个存在的，R18 的存在性检查完全绿。存在性只证明「凭证不是假的」，不证明「凭证是完整的」。
...
  ✗ 不报 files_touched_underreported — [交付粒度检查] 还不能结束这一回合：
  ...
  - src/pre-existing.java
...
  ✓ 不报 files_touched_overclaimed
```

**这一条就是 R19 §(a) 的 underreported 假阳性原文**：`src/pre-existing.java` 在修复前就脏，
本轮一个字没碰，却被判成「改了没登记」。

### case 44（R20-B）：同样的仓库状态但没有 `fix_baseline`（对照组）

```
case 44 (R20-B): 同样的仓库状态但没有 fix_baseline → underreported FAIL（对照）
  ✓ 退出码 2
  ✓ 报 files_touched_underreported
  ✓ 指名 src/pre-existing.java（这就是假阳性）
  ✗ WARN 说明没有基线、对账基于相对 HEAD 的差异 — [交付粒度检查] 还不能结束这一回合：
  ...
  - src/pre-existing.java
```

B 组的前三条在改动前就是绿的（旧行为本来就报 FAIL），唯一失败的是「**降级为 WARN 说明**」——
这正说明旧代码是**静默**按相对 HEAD 跑的。这条断言存在的理由：降级本身可以接受，静默降级不行。

### case 45（R20-C）：产物声称「修复前就脏、本轮没动」的文件

```
case 45 (R20-C): 有基线，产物声称「修复前就脏、本轮没动」的文件 → overclaimed FAIL
  ✗ 退出码 2 — 实际 0：
  ✗ 报 files_touched_overclaimed
  ✗ 指名 src/pre-existing.java
```

**这一条是 R19 §(a) 的 overclaimed 假阴性原文**：改动前 `exit 0`——实例声称改了一个
它根本没碰、只是「修复前就已经是 M」的文件，旧判据全绿放行。

### case 46（R20-D）：基线里脏、现在干净（被还原）

```
case 46 (R20-D): 基线里脏、现在干净（被还原）→ WARN 提到 restored
  ✓ 退出码 0（还原不是违规，不阻断）
  ✗ WARN 提到 restored / 被还原
  ✗ WARN 指名 src/old.java
  ✗ 提示可能是 stash/checkout/误操作
```

### case 47（R20-E）：`fix_baseline` 格式非法

```
case 47 (R20-E): fix_baseline 格式非法（dirty_paths 不是数组）→ WARN 并降级，不崩溃
  ✓ 不崩溃（退出码 0，且不是 1/其他）
  ✗ WARN 指出 fix_baseline 格式非法
  ✗ WARN 说明已降级
```

### 改动后的结果

```
=== 结果: 127 通过 / 0 失败 ===
```

原有 106 条（R19 收口时口径）全绿，新增 6 个 case（43–48）共 21 条断言全绿。

> **数字说明**：任务书写「原有 103 条必须全过」。实际基数是 **106**——
> R19 收口前又加了 case 42（`claimed` 为空时留 WARN），所以本文件在 R20 开始前是
> 106 通过 / 0 失败。106 + 21 = 127。没有删改任何既有断言。
>
> **case 48 是写完之后补的。** 它不是任务书列的五条，是自证时实测撞上的边界（见 §五末「HEAD 漂移」）：
> 基线记 `src/A.java` 脏，实例改完并 `git commit`，然后 `git status` 变干净
> → 同一条改动同时报出 `restored` 与 `overclaimed`，**两个都是假警报**。
> 我没有为它改判据（commit 修复是合法做法），只加了一条 WARN 说明口径已不确定——
> 因为「假装没发生」会让读者把假警报当信号。

---

## 三、自证：真实数据，Hilltop 仓库

仓库：`<TARGET_REPO>`
HEAD：`11ae7223923721bf13846f0cbdfa73151a218fa8`

实测 `git status`：**25 项 = 16 个已跟踪修改 + 9 个未跟踪**（其中 8 个是 `.java` 源文件，
1 个是目录 `repair-artifacts/`）。

> 与任务书写的「16 个改动文件」对得上（16 个已跟踪修改）。未跟踪的 9 项必须单独处理：
> `repair-artifacts/` 落在 `NOISE_PREFIXES` 里，但 8 个未跟踪的 `.java` 测试文件**不落**
> 任何噪音前缀，扩展名也不是 `NON_SRC_EXT`，所以它们会全部进 `actual`。
> 这不是 R20 引入的行为（R19 的 `verify-postfix-snapshot` 与 `stop-hook` 都刻意展开未跟踪目录），
> 但自证时必须把这条口径讲清楚，否则 4 / 14 的算术对不上。

构造：

- `fix_baseline.dirty_paths` = 16 个已跟踪修改中的**前 10 个**
- 产物的 `files_touched` = 剩下的 6 个里的**前 2 个**
  （`src/main/resources/game-settings.yml`、`src/main/resources/messages.yml`）
- 另外两个变体把 8 个未跟踪 `.java` 也放进 `claimed`，使口径与任务的 16→6→2 算术完全对齐

> 为什么把 8 个未跟踪文件从基线里拿掉或放进 claimed：它们是「本轮新建的测试」在真实场景里的形态，
> 本来就应该出现在 `claimed` 里。把「基线含未跟踪目录」与「claimed 含未跟踪文件」两种口径都跑一遍，
> 是为了确认 4 / 14 这个数字不是靠某种巧合凑出来的。

### 输出对照（核心证据）

| 场景 | `claimed` | `fix_baseline` | underreported 报出 | 判据口径一行 |
|---|---|---|---|---|
| ① | 2 个 | 10 个已跟踪 + 8 个未跟踪 + `repair-artifacts/` | **4 个**（全源码） | `现在的 git status − 修复基线` |
| ② | 2 个 | **无** | **22 个**（全源码） | `相对 HEAD 的差异（已降级）` |
| ③ | 2 + 8 个未跟踪 | 10 个已跟踪 | **4 个**（全源码） | `现在的 git status − 修复基线` |
| ④ | 2 + 8 个未跟踪 | **无** | **14 个**（全源码） | `相对 HEAD 的差异（已降级）` |

**③ vs ④ 是任务书预期的对照：有基线 → 报 4 个；无基线 → 报 14 个。**
两者在同一个仓库、同一份 `claimed` 上跑，唯一的差别是账本里有没有 `fix_baseline`。

**① vs ② 是更真实的对照**（基线里含「修复前就存在的未跟踪目录/文件」）：
有基线报 4 个，无基线报 22 个。

### 输出原文 · ③ 有基线（报 4 个）

```
════ ③ 有基线（只含 10 个已跟踪修改），claimed = 2 + 8 个未跟踪文件 → 任务口径的 4 ════
EXIT = 2
underreported 总数 / 其中源码 = 4 / 4
--- stderr 原文 ---
[交付粒度检查] 还不能结束这一回合：

1. 相位尚未闭合：计划共 1 步，当前在第 1 步，还有 1 步没做完（最后一步是「修 F1」）。
...

2. 仓库里有 4 个文件被改动，其中 4 个是**源码文件**，但没有任何 fix 产物把它们列进 files_touched（被审仓库 <TARGET_REPO>）：
  - src/test/java/com/hilltopvillage/ai/AirdropSpawnGoalTest.java
  - src/test/java/com/hilltopvillage/ai/ExplodeBeetleGoalTest.java
  - src/test/java/com/hilltopvillage/config/ConfigManagerTest.java
  - src/test/java/com/hilltopvillage/mechanics/TabListManagerTest.java

规则：files_touched_underreported。判据口径：**本轮改动 = 现在的 `git status` − 修复基线**（fix_baseline：captured_at=2026-11-16T09:12:00Z，head=11ae7223923721bf13846f0cbdfa73151a218fa8，dirty_paths=10 个）。
...
```

### 输出原文 · ④ 无基线（报 14 个）

```
════ ④ 无基线，claimed = 2 + 8 个未跟踪文件 → 任务口径的 14 ════
EXIT = 2
underreported 总数 / 其中源码 = 14 / 14
--- stderr 原文 ---
[产物信封检查 · 告警（不阻断）]

1. WARN · 双向对账**降级**：账本里没有修复基线 fix_baseline，本次按「相对 HEAD 的差异」（裸 `git status`）对账。
为什么这是个问题：`git status` 报的是**相对于 HEAD 的差异**，**不是「这一轮改了什么」**。被审仓库在修复前常常一开始就是脏的，于是两个方向都失真：
  · overclaimed 一侧（假阴性）：文件在修复前就已是 M，实例本轮根本没碰它，却因为它在 actual 里而不算 overclaim。
  · underreported 一侧（假阳性）：仓库里本轮之前就存在的改动全被算成「改了没登记」，然后这条规则会被当成噪音关掉。
补法：主 Agent 在进入 wave4 **之前**（派发第一个修复实例之前）执行一次 `git status --porcelain`，把路径写进 state.fix_baseline.dirty_paths，并把时刻与 HEAD 一并记进 captured_at / head（见 artifacts/run-state.md 第 2.7 节）。
注意：fix_baseline 是把假阴性/假阳性**缩小**，不是消除——它本身也是自述。
[交付粒度检查] 还不能结束这一回合：

1. 相位尚未闭合：...

2. 仓库里有 14 个文件被改动，其中 14 个是**源码文件**，但没有任何 fix 产物把它们列进 files_touched（被审仓库 <TARGET_REPO>）：
  - src/main/java/com/hilltopvillage/admin/ArenaResetService.java
  - src/main/java/com/hilltopvillage/admin/gui/ArenaManageGUI.java
  - src/main/java/com/hilltopvillage/ai/AirdropSpawnGoal.java
  - src/main/java/com/hilltopvillage/ai/ExplodeBeetleGoal.java
  - src/main/java/com/hilltopvillage/command/HilltopCommandHandler.java
  - src/main/java/com/hilltopvillage/config/ConfigManager.java
  - src/main/java/com/hilltopvillage/config/menu/MainConfigMenu.java
  - src/main/java/com/hilltopvillage/mechanics/NodeListener.java
  - src/main/java/com/hilltopvillage/mechanics/NodeSystem.java
  - src/main/java/com/hilltopvillage/mechanics/TabListManager.java
  - src/test/java/com/hilltopvillage/ai/AirdropSpawnGoalTest.java
  - src/test/java/com/hilltopvillage/ai/ExplodeBeetleGoalTest.java
  … 另有 2 个

规则：files_touched_underreported。判据口径：**相对 HEAD 的差异**（本回合没有可用的 fix_baseline，已降级——见上方 WARN）。
...
```

**这就是基线价值的直接证据**：同一份产物、同一个仓库，14 个假阳性 → 4 个真信号。
而且 4 个里仍然全是源码——基线**没有把信号一起减掉**，减法只减基线里那 10 个。

### 为什么不是「0 个」

`actual` 里还剩下 4 个（`AirdropSpawnGoalTest` / `ExplodeBeetleGoalTest` /
`ConfigManagerTest` / `TabListManagerTest`）——它们在 16 个已跟踪修改里排在第 11~16 位，
不在我构造的 10 个基线里，也不在 `claimed` 的 2 个里。**这是对的**：
它们代表「本轮真的改了、但没登记」，基线不该把它们也减掉。

### 自证后的清理

自证产物全部落在 `tmpdir()`，没有往 Hilltop 仓库或 `repair-artifacts/` 写任何东西。
跑完后复核：Hilltop `git status` 仍是 25 项，无新增文件。

---

## 四、验证

```
node tools/stop-hook.test.mjs        → === 结果: 123 通过 / 0 失败 ===
node tools/fix-phase-e2e.test.mjs    → === 结果: 48 通过 / 0 失败 ===
node tools/check-all.mjs             → ✅ 全部通过（EXIT=0）
```

---

## 五、实现要点（`stop-hook.mjs` §3.7.6.2b）

位置：`tools/stop-hook.mjs:1147` 起，插在「`actualSet` 构造完成」与「3.7.6.3 归一化 `claimed`」之间。
`claimed` 与 `actual` 的差异计算（3.7.6.4 / 3.7.6.5）一行未改，只是喂给它们的 `actualSet` 变小了。

| 情形 | 行为 |
|---|---|
| `state.fix_baseline` 缺失 | `actual` = 相对 HEAD；WARN（逐条说明两个失真方向 + 补法 + 「它也是自述」） |
| `fix_baseline` 不是对象 / `dirty_paths` 不是数组 / 数组含非字符串 | 同上降级 + WARN **点明格式非法**。**不静默当成空基线**——那比没有基线更糟 |
| 合法基线 | `actual = nowDirty − baselineDirty`；基线里的 `dir/` 条目按前缀覆盖其下所有文件 |
| 基线里脏、现在干净 | `restored = baselineDirty − nowDirty`，取源码部分 WARN（`rollback_command` 合法，故不阻断） |
| `captured_at` / `head` 缺一项 | 基线可用但 WARN：「事后无法核对这份基线是不是修复前那一刻抓的」 |

**`restored` 判据的一个细节**：判「现在还脏吗」不能只看精确匹配。基线记的是文件
（`src/new/Foo.java`），而现在 `git status` 可能只给出它的祖先未跟踪目录（`?? src/new/`）。
所以任一祖先目录仍然脏都算「它还脏」，否则会产生一批假 restored。代码里是 `stillDirty(p)`。

**`restored` 为什么只 WARN 不 FAIL**：`rollback_command` 干的就是还原，合法的还原是修复流程的一部分。
但「修复前脏、现在不脏」也可能是「本轮改动被误 checkout 掉」的唯一痕迹
（`experiments/CHECKOUT-INCIDENT.md` 记过一次真实事故），所以要提示、要留痕，但不阻断。

**减法只用于取 `actual`，不做噪音过滤**。3.7.6.4 原本就写明 overclaim 必须用未过滤集合，
否则「声称改了 `docs/x.md` 而且确实改了」会被误报。R20 保持这条纪律：`actualSet` 只做减法，
`isNoise` 仍然只在 3.7.6.5 的 under-reported 过滤里用。

### 5.1 HEAD 漂移（写完后实测撞上，补了 case 48）

`head` 字段在最初实现里只是溯源装饰。实测发现它有一个**判据价值**：

```
基线记 src/A.java 脏 → 实例改完 A.java → git commit → git status 变干净
→ A.java 落进 restored，同时从 actual 里消失
→ 产物声称改了 A.java，却因为 actual 里没有 → 被判 overclaimed
```

**restored 与 overclaimed 同时报出，两个都是假警报。** 根因是基线记的 HEAD 与现在的 HEAD 不同，
而减法假设「同一个 HEAD 下的两次 `git status` 可比」。

处理：不关判据（`git commit` 是合法的修复做法，把它判违规等于逼人别提交），
改为加一条 WARN，把事实与后果说清楚：

```
WARN · 修复基线与现在的 HEAD 不一致：基线记的是 3d33c94a6590，现在是 fff817945621。
这说明在抓基线之后、本段运行之前，仓库发生过一次 commit（或 reset）。后果：基线里脏、
后来被 commit 掉的文件，在现在的 `git status` 里是干净的，于是它们既会被算成「被还原」，
又会在产物声称改了它们时被误判成 overclaimed。**本段给出的一切结论都建立在这个已经不确定的差值上。**
补法：若 commit 是本轮修复的一部分（合法做法），请重抓基线——在 commit 之后、下一批修复
实例派发之前再跑一次 `git status --porcelain` 并更新 fix_baseline（captured_at 与 head 一起更新）。
溯源（fix_baseline：captured_at=2026-11-16T00:00:00Z，head=3d33c94a6590…，dirty_paths=1 个）。
```

这**不修**那个假警报——它只是让读者知道「现在看到的不一定是真的」。
要真修，基线得记**未提交的 blob hash** 而不是路径（`git hash-object` + `git ls-tree`），
这样「被 commit 掉的改动」能被识别成「还在，只是进了 HEAD」。
那是 §6.2 表里的第 2 项，本次按任务书指定的 `dirty_paths: string[]` 形状，没做。

---

## 六、诚实评估

### 6.1 基线解决了什么？

| 解决了 | 证据 |
|---|---|
| 「修复前就脏」被算成本轮改动 → underreported **假阳性**大幅收窄 | 自证 ③ vs ④：14 → 4 |
| 「修复前就脏、本轮没动」被算成本轮改动 → overclaimed **假阴性**被堵住 | case 45：改动前 `exit 0`，改动后 FAIL |
| 基线里脏、现在干净（还原 / stash / checkout）从**静默**变成 WARN | case 46 |
| 格式非法的基线不会被静默当成空基线 | case 47 |
| 降级在日志上可见（含两个失真方向与补法） | case 44 断言「WARN 说明没有基线 / 基于相对 HEAD」 |

R18 §6 问的「**是不是这一轮改的**」——**这一问现在有答案了，但答案是可伪造的**。

### 6.2 没解决什么？

1. **基线本身的真伪。** 主 Agent 可以写 `dirty_paths: []`，让所有改动都算成本轮改的。
   本段不验证——**做不到**，没有外部基准能与「修复前那一刻」比对。
   能做的只有留痕：`captured_at` / `head` 会出现在降级 WARN 与对账 FAIL 的「判据口径」行里
   （自证 ③ 的原文可见：`fix_baseline：captured_at=…，head=…，dirty_paths=10 个`）。
   **一个假基线至少留下「它声称自己在什么时刻、基于什么 HEAD 抓的」这个痕迹。**
2. **同一文件既在基线里又被本轮改了。** 减法会把这种情况判成「不是本轮改的」——**这是一个新的假阴性**，
   是 R20 引入的、R19 没有的。堵它需要基线记**内容哈希**而不只是路径（`git hash-object` 对比）。
   这一条明确写在 `run-state.md` §2.7.5 的表里，以及 §2.7.6 的「下一个层次」第 2 项。
   我**没有**实现它：那会改变 `dirty_paths` 的形状（从 `string[]` 变成 `{path, hash}[]`），
   与任务书给定的字段定义冲突。任务书指定 `dirty_paths: ["path", ...]`，照做。
   **同一根因还有一个更常见的形态：中途 `git commit`。** 见 §5.1——它会同时造出假 restored 与假 overclaimed。
   我只加了 WARN，没修判据。
3. **跨轮基线**：`fix_baseline` 只管这一轮；`wave5` 验收相位目前**不**重新抓基线。
4. **「验证不了」这件事本身没有出口**：一旦承认基线是自述，「写一个更小的基线」就是新的最短绕过路径。
   这与 R13 的 `report.dir_path` 同构：加字段 → 省略它 → 闸门失效 → R14 只能把它变成条件必填。
   `fix_baseline` 会走同一条路。**它现在不是必填，所以「不写它」只有一条 WARN**——
   这是刻意的选择（不能让存量账本一夜不合规），但也是下一轮一定会被利用的口子。

### 6.3 R19 §(b) 的**归属问题**，本次改了吗？

**完全没有碰。**

R19 §(b) 原文：`files_touched` 没有 `agent_id` 维度，对账是**全局的**，不是逐实例的。
本次改动在这一点上一行没动：

- `claimed` 仍然是**所有** fix 信封的 `files_touched[]` 并集（3.7.6.1 未改）；
- `actual` 仍然是**一次全局** `git status`（3.7.6.2 未改），R20 只在它上面做了一次减法；
- `fix_baseline` 是**全局基线**，不是逐实例基线——它只知道「修复前哪些脏」，不知道「这一轮是**哪个实例**改的」。

R19 §(b) 的那个抵消形态仍然完全可行：

> 实例 A 改了 X（该改，且列了 X），但归到 A 名下的 `change_summary` 描述的是 Y；
> 实例 B 恰好改了 Y 并登记了 Y。全局集合 `claimed = {X, Y} ⊆ actual`，
> 两边都合规，而 A 的 `change_summary` 是假的。under-report 与 over-claim 互相抵消。

**基线让这个抵消更容易发生，而不是更难**：基线把 `actual` 缩小到「本轮新增」，
于是「B 改的 Y」如果也在基线里，Y 会从 `actual` 掉出去，A 声称 Y 反而变成 overclaimed——
这看起来像是抓到了，但抓到的是「A 声称了基线里的东西」，**不是**「A 的 `change_summary` 是假的」。
判据仍然只看**路径集合**，不看**集合到实例的归属**。

要真回答归属，需要的是**逐实例基线**（每次派发前抓一次，`files_touched` 按 `agent_id` 分账），
或者更根本的——**harness 层记录文件写入**。两条都写在 `run-state.md` §2.7.6 里，本次都没做
（任务书明确说「只改三个文件」，且指定的是**全局**基线）。

### 6.4 「自述层还能加什么」——我的答案

**在 `files_touched` 这条链上，已经到极限。**

R13 → R14 → R15 → R17 → R18 → R19 → R20 是一条很清楚的线：
每一次都是「把一个**非自述的证据源**接进闸门」——
产物信封（文件系统）→ check-payload（信封内容）→ 文件存在性（文件系统）→ `git status`（版本控制系统）
→ `git status − 基线`（**同一个版本控制系统的两个时间点之差**）。

R20 与前几次有一个本质区别：前几次接进来的是**新的证据面**，R20 接进来的**还是 `git status`**，
只是多了一个时间点。而**这个时间点由被审者自己声称**。所以 R20 不是一个新层次，
它是**上一个层次的边界条件**——它把「相对 HEAD」这个粗糙近似推到它的合理极限，
同时在推的过程中暴露了天花板：**再往外一步就要求助外部观测面，而自述层够不着。**

极限在哪，具体三条：

1. **自述的深度维度已经用尽**。「谁改的」「什么时候改的」「改的是什么」——
   前两个 R19/R20 各答了一半，「改的是什么」（内容）从来没有被任何机械判据触及过。
   `change_summary` 至今是**纯自由文本**，没有一条规则检查它与实际 diff 的关系。
   这是这条链上最后一块未接的东西，而它**不能靠加字段解决**：要比对 `change_summary` 与 diff，
   得先有 diff 的语义理解，那是模型层的工作，不是账本层。
2. **每一个新字段都是一个新省略点。** R13 已经证明过一次（`report.dir_path`）。
   R20 加了 `fix_baseline`，它现在缺失只有 WARN。下一轮必然有人发现这一点。
   如果把它改成条件必填，「写空基线」就是新的最短路径——**绕过的成本恒等于写一行 JSON**。
3. **判据的原子性是路径，不是内容，也不是归属。** `git status` 给的就是路径列表。
   要突破它，需要 `git diff` 的内容、`git blame` 的归属、或者 harness 的 tool-call 日志。
   前两个是**同一个 VCS 的更细粒度视图**（还能在自述层外包一层，但成本陡增），
   第三个才是**换观测面**。

**下一个层次是什么**：不是再往 `state.json` 加字段，而是**换观测面**。

| 层次 | 内容 | 谁做 |
|---|---|---|
| 自述层（已到极限） | `state.json` 里的字段 + 账本自洽性 | 提示词 + 账本检查器 |
| VCS 细粒度层 | 逐实例基线、blob hash 基线、`change_summary` vs `git diff` 的一致性 | 账本 + 一个会读 diff 的工具 |
| 观测面层 | harness 记录每个 subagent 的 tool call 与文件写入，`files_touched` 变成「由 harness 生成」而不是「由实例声称」 | 工具层 / harness 集成 |

第三层是唯一能真正回答归属的。`check-fix-instances-harness.mjs` 的文件头已经写过这一点：
harness 日志里**没有文件路径**，它只能数 subagent 次数，不能看内容。
**R20 改变的只是「自述层的最后一个加法」已经做完这件事——它没有、也不能改变自述层的性质。**

---

## 七、改动的完整清单

| 文件 | 改动 |
|---|---|
| `tools/stop-hook.mjs` | §3.7.6.2b 新增约 130 行（基线解析 / 减法 / restored / 三类降级 WARN）；3.7.6.4 与 3.7.6.5 的 FAIL 消息加一行「判据口径」；`SRC_EXT` 定义提到 §3.7.6.2b 并改名 `SRC_EXT_UP`，原处留别名 |
| `tools/stop-hook.test.mjs` | case 43–47（5 个 case / 17 条断言） |
| `framework/artifacts/run-state.md` | 第 2 节 JSON 块加 `fix_baseline`；新增 §2.7（字段定义 / 为什么 / 谁写 / 怎么用 / 解决什么没解决什么 / 下一个层次） |

**未 `git add` / 未 `git commit`。**
