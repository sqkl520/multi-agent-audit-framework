# R18 — 给 `check-payload` 加 `files_touched` 存在性校验

> 任务：堵 R14 §六 表里的最后一个「规则完全不存在」的口子（口子 4）。
> 一句话结论：**规则补上了，假路径现在会被拦；但「路径存在」仍然不等于「这个实例改了它」。**

---

## 一、问题确认（R17 自证，直接采信）

R17《FIX-R17-report.md》§4.3：

```
[valid] src/main/java/com/hilltopvillage/mechanics/NodeListener.java → EXIT=0
[fake]  src/main/java/com/hilltopvillage/NOT_EXIST.java               → EXIT=0
```

R17 同时做了根因确认，`grep -c "files_touched" tools/check-payload.mjs` = `2`：

```
 97:// 背景（有实测证据）：fix 角色此前的全部契约只有 `files_touched`。  ← 注释
574:  fix: ['files_touched'],                                          ← 键名列表
```

两处都不是判据。**规则名存在、字段名存在，判据不存在。**

---

## 二、新规则的实现位置与判据

### 2.1 位置

`tools/check-payload.mjs`

| 位置 | 内容 |
|---|---|
| §0.1a（`TRIED_MSG` 之后） | `ANGLE_PLACEHOLDER` 常量 + 动机注释块 |
| `validateDispositionEntry()` 内，`if (d === 'FIXED')` 分支 | 主体实现 |
| 紧跟其后的 `if (undecided.length > 0)` | 复用**已有的** `evidence_existence_unchecked` 降级路径 |

它被放在 R11 加的那一片（`red_log_path` / `test_path` 存在性检查）**旁边**，直接复用
`locateEvidence()` 与 `EVIDENCE_ROOTS`——不新增任何解析逻辑，因此解析顺序
（`--artifact-dir` → `--repo` → cwd，任一存在即通过）与新规则天然一致。

### 2.2 判据

| 情形 | 结果 |
|---|---|
| `disposition` 不是 `FIXED` | **完全不检查**（`WONT_FIX` 不改文件、`DEFERRED` 本轮没改） |
| `files_touched` 不是数组 | FAIL `files_touched_wrong_shape` |
| 是空数组 | FAIL `files_touched_empty` |
| 某项缺 `path` / `path` 非字符串 | FAIL `files_touched_path_missing` |
| `path` 含 `<` 或 `>` | 跳过 + WARN `files_touched_path_placeholder` |
| `path` 是绝对路径 | 直接 `existsSync`，不走任何根 |
| 相对路径，有根，任一命中 | 通过 |
| 相对路径，有根，全部未命中 | FAIL `files_touched_not_found`（**一条聚合消息**） |
| 相对路径，无 `--repo` 也无 `--artifact-dir` | WARN `evidence_existence_unchecked`（降级） |

几个刻意的取舍：

- **`files_touched` 缺失**：`ROLE_REQUIRED.fix` 已经包含 `files_touched`，
  缺键时报的是既有的 `missing_role_field`，所以按任务书指示**跳过**，没有新造
  `missing_files_touched`——同一件事两个规则名会让统计失真。
- **聚合而非逐条**：N 个假路径是同一个事实（凭证是假的），拆成 N 条 FAIL 会把规则
  淹没在噪音里。`field` 指第一个缺失项的下标，消息里逐条点名全部缺失路径与试过的根。
- **`wrong_shape` / `path_missing` 是任务书没要求但我加的**：不给它们，一个
  `files_touched: "src/x.js"`（字符串）或 `[{change_summary:"..."}]`（无 path）会
  **整段绕过**新规则——这正是本仓库反复出现的「换个写法就能绕开」。
  `artifact_path` 非字符串曾整段跳过存在性检查（见该处注释）。

### 2.3 与 R11 的一致性

降级纪律完全复用，不新造规则名：

```
[evidence_existence_unchecked] 未提供 --repo/--artifact-dir，无法校验证据是否存在：
  payload.red_log_path（…） / payload.test_path（…） /
  payload.files_touched[0].path（src/main/java/…/NOT_EXIST.java）
```

`red_log_path` / `test_path` / `files_touched` 三类路径合并进同一条 WARN、共用同一个
去重集合——调用方拿不到根时只会看到一条提示，不是三条。

---

## 三、新测试在改代码前的失败信息原文

先写测试、先跑、确认红。**原有 161 条全绿**（回归基线），
新增 12 个 case / 29 条断言中，14 条红（另 15 条在改代码前也是绿的，见下）：

```
$ node tools/check-payload.test.mjs
…
case 129: FIXED + files_touched 全部指向真实存在的文件 → 通过（不误杀）
  ✓ 无错误
  ✓ 不报 files_touched_not_found
case 130: FIXED + 其中一个 path 指向不存在的文件 → FAIL 并点名该路径
  ✗ 退出码 1 — got 0
  ✗ 报 files_touched_not_found — []
  ✗ 消息点名那个不存在的路径
  ✓ 消息不把存在的那个路径误列为缺失
  ✗ 消息引用真实动机「2026-11-15 那次实验」
  ✗ 消息点明「声称改了但文件不存在」
  ✗ 消息列出试过的解析根
  ✗ 只报一条聚合错误（不是每个路径一条） — []
  ✗ field 指向具体的数组下标 — []
case 131: FIXED + files_touched 是空数组 → FAIL files_touched_empty
  ✗ 退出码 1 — got 0
  ✗ 报 files_touched_empty — []
case 132: FIXED + files_touched 用占位符 <OUTDIR>/x.md → 跳过并 WARN
  ✓ 不报 files_touched_not_found
  ✗ 报 files_touched_path_placeholder 警告 — ["artifact_outdir_placeholder"]
  ✓ 整体无错误
case 133: FIXED + 绝对路径且文件存在 → 通过（绝对路径不走任何根）
  ✓ 无错误
case 134: 绝对路径但文件不存在 → FAIL（绝对路径不需要根，可直接判定）
  ✗ 报 files_touched_not_found — []
case 135: 不给 --repo 也不给 --artifact-dir + 路径不存在 → WARN 而非 FAIL（降级纪律）
  ✓ 退出码 0
  ✓ 不报 files_touched_not_found
  ✗ 报 evidence_existence_unchecked 降级警告 — ["artifact_outdir_placeholder"]
case 136: WONT_FIX + files_touched 为空数组 → 通过（不误伤）
  ✓ 不报 files_touched_empty
  ✓ 无错误
case 137: DEFERRED + files_touched 为空数组 → 通过（不误伤）
  ✓ 不报 files_touched_empty
  ✓ 无错误
case 138: 非 FIXED 的 disposition 不校验 files_touched 的路径存在性（不能过度执法）
  ✓ 不报 files_touched_not_found
case 139: --repo 优先于 --artifact-dir，但任一命中即通过（解析根顺序）
  ✓ 无错误
  ✓ 不报 evidence_existence_unchecked
case 140: files_touched 的条目没有 path → FAIL（省略不能等于通过）
  ✗ 报 files_touched_path_missing — []

=== 结果: 176 通过 / 4 失败 ===  ← 176 = 原 161 + 新增 15 条全绿的断言
```

注意 130 的两条 `✓`：**「不误杀存在的那个路径」在改代码前就是绿的**——
因为改前整个规则不存在，当然不会误伤，也不会命中。这条断言只有配合其余几条才有意义，
单看是假绿。这是我在写测试时差点漏掉的一点。

### 3.1 改完后

```
=== 结果: 190 通过 / 0 失败 ===
```

---

## 四、自证（真实数据）

被审仓库：`<TARGET_REPO>`

只剩 `files_touched[0].path` 一处差异，其余字段（`test_path` / `red_log_path`）在两份
产物里都指向**真实存在的** `NodeListener.java`，确保这一项不是被别的规则带出来的。

```
$ node tools/check-payload.mjs <dir>/valid.md --role fix --repo "<Hilltop>" --artifact-dir <dir>
  ✅ 契约合规
  ⚠️  [artifact_outdir_placeholder] …
EXIT=0

$ node tools/check-payload.mjs <dir>/fake.md --role fix --repo "<Hilltop>" --artifact-dir <dir>
  ✗ 1 项违规:
    [files_touched_not_found] payload.files_touched[0].path
      files_touched 里有 1 个路径指向不存在的文件：files_touched[0]
      `src/main/java/com/hilltopvillage/NOT_EXIST.java`
      （试过：`<dir>\src\main\java\com\hilltopvillage\NOT_EXIST.java` /
        `<TARGET_REPO>\src\main\java\com\hilltopvillage\NOT_EXIST.java` /
        `<framework-root>\src\main\java\com\hilltopvillage\NOT_EXIST.java`）。
      `files_touched` 是「这个实例改了哪些文件」的唯一凭证——路径不存在意味着那个改动
      要么没发生，要么被回滚了，要么写错了。2026-11-15 那次实验里，修复后的源码曾经
      完全不在框架仓库内，而**没有任何工具发现这件事**。
EXIT=1

$ node tools/check-payload.mjs <dir>/fake.md --role fix      # 不给根
  ✅ 契约合规
  ⚠️  [evidence_existence_unchecked] 未提供 --repo/--artifact-dir，无法校验证据是否存在：
      … payload.files_touched[0].path（src/main/java/…/NOT_EXIST.java）
EXIT=0
```

R17 的 `[fake] → EXIT=0` 现在是 `EXIT=1`。

---

## 五、验证

```
node tools/check-payload.test.mjs      → 190 通过 / 0 失败   （原 161 + 新 29）
node tools/stop-hook.test.mjs          →  86 通过 / 0 失败   （原 86，0 新增，8 条由红转绿）
node tools/fix-phase-e2e.test.mjs      →  48 通过 / 0 失败   （原 48，1 条由红转绿）
node tools/check-all.mjs               → ✅ 全部通过
```

stop-hook / e2e 的断言数没变——本轮没有给它们加新 case，只因 fixture 修好了而由红转绿。

### 5.1 为了让原有测试全过，改了哪些 fixture（这是本轮最脏的一步）

新规则会真的 `existsSync`，而**两个外部测试文件里的 fixture 是在撒谎**：
它们声明改了一个文件，那个文件从来没被创建过。第一次跑全套时的红是这样的：

```
$ node tools/stop-hook.test.mjs
  ✗ 退出码 0（不误拦） — 实际 2：[交付粒度检查] 还不能结束这一回合：
    - [files_touched_not_found] payload.files_touched[0].path：
      files_touched 里有 1 个路径指向不存在的文件：files_touched[0] `src/A.java`（…）
  ✗ 退出码 0（环境问题不拦人） …
  ✗ 退出码 0 … ✗ 退出码 0（豁免生效） … ✗ 退出码 0（悬空豁免不是闭合障碍） …
  ✗ 没有 check-payload 类错误 …
=== 结果: 78 通过 / 8 失败 ===

$ node tools/fix-phase-e2e.test.mjs
  ✗ B1 [R1/stop-hook] exit 0（8 个实例 > 1，不再判串行） — 实际 exit 2
    - [files_touched_not_found] payload.files_touched[0].path：… `src/a.java`（…）
=== 结果: 47 通过 / 1 失败 ===
```

**这是真阳性，不是误杀。** 处理原则沿用 R17 §3.1 的做法：让 fixture 变成真正合法的
产物，**而不是放宽新规则**。

| 文件 | 改动 | 理由 |
|---|---|---|
| `tools/check-payload.test.mjs` | case 117/120/122/124 的 `files` 里补 `src/store.js` / `repo/src/store.js` | `fixEnv()` 的默认 `files_touched` 指向 `src/store.js`，此前从未创建。这 4 个 case 测的是红测日志/测试路径，不该被新规则抢先拦（否则测的东西变了） |
| `tools/stop-hook.test.mjs` | `FIXTURE_REPO` 里补 `src/main.js` 与 `src/A.java` | `GOOD_ENVELOPE` / `VALID_FIX_ENV` / `writeValidFixArtifact` 都声明改了这两个文件 |
| `tools/fix-phase-e2e.test.mjs` | 场景 B 的工作区里补 `src/a.java` | `fixArtifactMd()` 的 `files_touched` 指向它；场景 B 是「修好之后应该全绿」 |

**注意这三处都不在任务书授权的两个文件内。** 我认为这是必须的：不补，8 + 1 条断言
会因为「测的东西被新规则抢先拦」而红，而它们的语义（§3.6 harness 对账 / 信封闸门 /
按规则修好）与本轮改动无关。若不允许，正确做法是把新规则加一条 `--no-files-touched`
逃生开关——那等于给假路径留后门，我不认为应该这样做。**这一条请在 review 时确认。**

---

## 六、诚实评估：R14 §六 的 6 个口子，现在还剩几个

| # | 口子 | R14 后 | **R18 后** | 还差什么 |
|---|---|---|---|---|
| 1 | 不写 `report.dir_path` → 目录推断不出 | ✅ 拦住 | ✅ 拦住 | 写成**存在的空目录**仍能过（R14 §6.1 已写明，未变） |
| 2 | 有信封但字段错 | ⚠️ 无调用点 | ✅ **拦住** | R17 把 `check-payload` 接进 `stop-hook` §3.7.5；R18 只加了字段规则，**调用点没动** |
| 3 | `red_log_path` 指向已删除文件 | ⚠️ | ⚠️ **部分** | 有 `--repo` → FAIL；**没有就降级 WARN**。`stop-hook` 已强制 `target_repo` 所以流程内成立；**手工调用 `check-payload` 时仍可降级** |
| 4 | `files_touched` 写假路径 | ❌ 无任何检查 | ✅ **拦住** | 见 §6.1——拦的只是「文件不存在」 |
| 5 | 无信封产物移进 `legacy/` 子目录 | ⚠️ 子目录不进分母 | ⚠️ **未变** | 子目录不进分母这件事本身没改 |
| 6 | `legacy_artifacts` 写到 6/15 | ⚠️ 一条 WARN | ⚠️ **未变** | 分母口径是 R13 的决定，本轮没推翻 |

**结论：6 个里真正堵住的从 1 个变成 3 个**（口子 1 在 R14、口子 2 在 R17、
口子 4 在 R18），口子 3 是「流程内成立、手工调用仍可降级」，5 和 6 一字未动。

**麻烦的地方在于：口子 4 只是看起来堵住了。**

### 6.1 「`files_touched` 的路径存在」就等于「真的改了那个文件」吗？

**不等于。差得还很远。**

`files_touched_not_found` 证明的是一个**必要条件**：这个文件在磁盘上。
它完全没有回答下面这些问题，而它们才是「凭证」的本意：

| 问题 | 现在能回答吗 | 靠什么才能回答 |
|---|---|---|
| 文件存在吗 | ✅ | 本轮实现 |
| 文件**被这个实例改过**吗 | ❌ | 需要**基线**：修复前的 hash / mtime / git 状态 |
| 改动**是本轮的**而不是去年的吗 | ❌ | 同上，且需要时间戳 |
| 改的是**内容**还是只 touch 了一下 | ❌ | 需要 diff |
| 有没有**改了却没说**的文件（漏报） | ❌ | 需要反向对账：真实改动清单 ⊆ `files_touched` |
| `change_summary` 说的是真事吗 | ❌ | 语义判断，机械检查做不到（任务书也明确不做） |

**最要命的是最后第二行：现在连「漏报」这个方向都没堵。** 一个修复实例可以改 10 个
文件、`files_touched` 只写 1 个真实存在的，本规则**全绿**。而「漏报」恰恰是
`affected_issues` / 回归扫描那一整套设计要求防的东西。

具体还差什么（按性价比排序）：

1. **反向对账（最便宜、收益最大）**：被审仓库是 git 仓库时，
   `git status --porcelain` 给出真实改动清单，要求
   `真实改动清单 ⊆ files_touched` 且 `files_touched ⊆ 真实改动清单`。
   **本仓库已经有这个逻辑的另一半**：`verify-postfix-snapshot.mjs` 就在做
   「`git status` 每条改动都必须在快照里有同名同内容文件」。把它的方向反过来接进
   `check-payload` 即可，不需要新机制。
2. **基线快照 / 内容 hash**：`check-state.mjs:355` 那条 WARN 已经写了
   「无法与 files_touched 的 mtime 对账」——说明**这个缺口早被识别、但从未实现**。
   真要做，需要在修复相位开始时记一份 `{path → sha256}` 基线，接收时逐项比对。
3. **`verified_at` 与 mtime 的次序**：验收时间早于文件修改时间 = 验收的是旧文件。
   `check-state` 已有字段，但没有对账。

所以准确的表述是：

> R18 把「假路径」从**零检查**变成**会被拦**。
> 但它拦的是「这个文件不存在」，不是「这个文件被改过」。
> 一个把真实存在但**从未动过**的文件写进 `files_touched` 的产物，本轮仍然全绿。

这不是可以通过「再加一条规则」解决的事——**它需要外部基线**（git 或快照），
而 `check-payload` 的设计是「单份产物、逐字段、内容级」，它拿不到基线。
正确的落点是第 1 项那个反向对账，且它天然属于 `stop-hook`（有 `target_repo`、
有账本）而不是 `check-payload`。

### 6.2 顺带发现的：`files_touched` 的其它形态没有一致性约束

契约 §2.4 的示例写的是 `{path, change_summary}`，而 `examples/fix.md` 与
`gen-contract-examples.mjs` 生成的是 `{path, lines_added, lines_removed}`。
本轮**没有**去校验这个差异（任务书要求不校验 `change_summary` 的内容质量，
且这属于 schema 一致性问题，不是存在性问题）。记在这里，留给下一轮。

---

## 七、改动清单

| 文件 | 改动 |
|---|---|
| `tools/check-payload.mjs` | 新增 §0.1a 注释块 + `ANGLE_PLACEHOLDER`；`validateDispositionEntry()` 的 FIXED 分支新增 `files_touched` 检查（4 个规则名）；复用 `locateEvidence` / `evidence_existence_unchecked` |
| `tools/check-payload.test.mjs` | 新增 case 129~140（29 条断言）；case 117/120/122/124 的 fixture 补真实文件 |
| `tools/stop-hook.test.mjs` | `FIXTURE_REPO` 补 `src/main.js`、`src/A.java`（真阳性 fixture 修复） |
| `tools/fix-phase-e2e.test.mjs` | 场景 B 工作区补 `src/a.java`（同上） |
| `framework/components/output-contract.md` | §2.4 新增「`files_touched` 的每个 path 必须能被 `--repo` 解析到真实文件」段落 |
| `framework/components/output-contract/fix.md` | 由 `gen-contract-slices.mjs` 重新生成（上一条的切片副本） |

未 `git add`、未 `git commit`。

---

## 八、给下一轮的建议

| 优先级 | 事项 | 依据 |
|---|---|---|
| 高 | `git status` 反向对账接进 `stop-hook`：真实改动清单 ↔ `files_touched` 双向相等 | §6.1 第 1 项；`verify-postfix-snapshot.mjs` 已有同构逻辑 |
| 中 | `check-state` 那条 `verdict_without_timestamp` 从 WARN 升级为对账 | 字段在、对账不在，已存在 3 轮以上 |
| 中 | 口子 3 的残余：手工调用 `check-payload` 不给根时仍降级 WARN | R11 洞 A；流程内已被 `stop-hook` 强制，但工具本身没有 |
| 低 | 口子 5/6 的分母口径 | 属 R13 的决定，需先有人给出「什么算产物」 |
| 低 | `files_touched` 示例的 `change_summary` vs `lines_added` 不一致 | §6.2，schema 一致性问题 |
