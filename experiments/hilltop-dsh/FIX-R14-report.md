# R14 — 堵上「最省力的绕过」：不写 `report.dir_path` 换掉整道信封闸门

> 任务：`FIX-R13-report.md` §7.2 口子 1。R13 自己把它标为「**本轮最大的残留口子**」。
>
> 一句话结论：**口子堵上了，但同类的下一个口子还在**——把 `dir_path` 写成一个真实存在的空目录，
> 仍然能用一条 WARN 换掉闸门（见 §六）。本轮把「省略」这条零成本路径关掉了，没有把「降级换门」这一类关掉。

---

## 一、改前 / 改后的判据代码

### 1.1 `check-state.mjs`：新增 `report_dir_required`

**改前**：没有这条规则。`path_mode=FIX`、`phase=wave4`、`report` 整个字段缺席 → 判「schema 合规」，exit 0。

**改后**（`tools/check-state.mjs` §4.55，紧随 R1 的 `fix_contracts_required`）：

```js
const hasFixContracts = Array.isArray(state.fix_contracts) && state.fix_contracts.length > 0;
const nonEmptyStr = (v) => typeof v === 'string' && v.trim() !== '';

if (fixContractsRequired && hasFixContracts) {
  const hasDir = nonEmptyStr(state.report?.dir_path);
  const hasFinal = nonEmptyStr(state.report?.final_report_path);
  if (!hasDir && !hasFinal) {
    err('report.dir_path', 'report_dir_required', /* 见下 */);
  }
}
```

`fixContractsRequired` 就是 R1 已有的那个条件变量
（`state.path_mode === 'FIX' && ['wave4','wave5'].includes(state.phase)`），
两处故意复用同一个变量，让「有修复登记」与「能定位修复产物」在代码里也是同一条线的两个必要条件。

错误消息（原文）：

> path_mode=FIX 且 phase=wave4，账本里有 2 条 fix_contract，但 `report.dir_path` 和 `report.final_report_path` 都没写。
> **这不是格式问题**——stop-hook.mjs §3.7 要从这两个字段推断修复产物目录，才能跑「产物必须带 JSON 信封」那道闸门。
> 两个字段都空 = 闸门推断不出目录 = 只能用一条 WARN 放行。
> 换句话说：**不写这两个字段，等于用省略换掉一道门。**
> 补法：把本轮产物目录的绝对路径写进 `report.dir_path`（report-naming.md §5.1：波次一启动前就该有它），或至少写 `report.final_report_path`

### 1.2 `stop-hook.mjs` §3.7：降级条件收紧

**改前**：

```js
const inferred = inferArtifactDir(state);
if (!inferred) {
  warnings.push(`WARN · 产物目录无法确定：…本次**没有执行**产物信封检查…`);   // 一律 exit 0
} else { /* 跑闸门 */ }
```

**改后**：

```js
const inferred = inferArtifactDir(state);
if (!inferred) {
  if (fixContracts.length > 0) {
    // 账本缺字段 → 拒绝闭合（exit 2）
    problems.push(`产物目录推断不出来，而 phase=${state.phase} 已经登记了 N 条修复契约。…`);
  } else {
    warnings.push(`WARN · 产物目录无法确定：…（这一档仍可降级，因为 fix_contracts 为空）`);
  }
} else { /* 跑闸门 */ }
```

判据只多了一条 `fixContracts.length > 0`。**它用的 `fixContracts` 是 §3 就已经算好的那个变量**
（`Array.isArray(state.fix_contracts) ? state.fix_contracts : []`），没有引入新的数据来源。

**报错里额外区分了两种成因**（这是改代码时才发现必要的）：

| 形态 | 消息说的 | 为什么必须区分 |
|---|---|---|
| 两个字段都没写 | 「state.json 里既没有 …」 | 这是本案的主要目标（最省力的绕过） |
| 写了但指向不存在的目录 | 「写了目录线索（`dir_path="does-not-exist-xyz"`），但按它解析出的目录都不存在 ……**这仍然是账本问题**：路径写错了」 | 不区分的话，模型会去补一个它**已经写过**的字段，方向是错的 |

理由注释（写进了文件头）：

> 降级纪律仍然适用于**真正的环境问题**：sessions root 不存在（§3.6）、目录可推断但读不了、检查器执行失败——那些是拿不到外部信息，不是账本没写。
> 两者的区别是「谁有能力让它变成可查」：环境不行时主 Agent 无能为力，缺字段时它只要写一行。**能自己修的事不能算降级理由。**

---

## 二、新测试在改代码之前的失败信息原文

### 2.1 `check-state.test.mjs`

新增 case 36–41。改代码之前跑，case 36 的四个断言全红：

```
$ node tools/check-state.test.mjs
...
case 36: FIX + wave4 + 有契约但两个目录字段都没写 → 报 report_dir_required
  ✗ 报 report_dir_required — []
  ✗ 字段指向 report.dir_path
  ✗ 说明不是格式问题，而是闸门推断不出目录
  ✗ 点明「等于用省略换掉一道门」
case 37: FIX + wave4 + 只有 final_report_path → 通过
  ✓ 不报 report_dir_required
  ✓ 无错误
...
=== 结果: 48 通过 / 4 失败 ===
EXIT=1
```

注意 case 37–41（`final_report_path` 单写能过 / 两个都有能过 / AUDIT_ONLY 不误伤 / wave1 不误伤 /
空契约不叠加报错）在改代码之前**就已经是绿的**——它们是防误伤的哨兵，不是红的证明。
只有 case 36 是「应当红」的那一条。

### 2.2 `stop-hook.test.mjs`

原 case 23（`wave4 + 产物目录推断不出来 → exit 0 + WARN`）的断言**本身就是 R13 §7.2 口子 1 的文字化**。
留着它绿，等于把要堵的洞写成契约，所以直接改写为「应当 exit 2」。

改代码之前：

```
$ node tools/stop-hook.test.mjs
case 23: wave4 + 契约非空 + 产物目录推断不出来 → exit 2（R14：不再是 WARN）
  ✗ 退出码 2（拒绝闭合） — 实际 0：[产物信封检查 · 告警（不阻断）]

1. WARN · 产物目录无法确定：state.json 里既没有可用的 report.dir_path，也没有 report.final_report_path / fix_contracts[].test_path 可供推断。
因此本次**没有执行**产物信封检查（check-fix-artifacts-envelope.mjs）——「修复产物有没有信封」这一项在本回合未验证。
按 report-naming.md §5.1，主 Agent 应在波次一启动前把产物目录写进 report.dir_path；补上它之后这个检查会自动生效。

  ✗ 指出这是账本缺字段，不是环境问题 — [同上 WARN 全文]
  ✗ 点明它等于用省略换掉一道门 — [同上 WARN 全文]
...
=== 结果: 59 通过 / 3 失败 ===
EXIT=1
```

（`59 通过` 里包含了新增的 23b/23c/23d 三条本应绿的防误伤用例。）

### 2.3 改代码后转绿

```
$ node tools/check-state.test.mjs
=== 结果: 52 通过 / 0 失败 ===

$ node tools/stop-hook.test.mjs
=== 结果: 63 通过 / 0 失败 ===
```

---

## 三、真实数据自证

构造的账本：`experiments/hilltop-dsh/out/r14-selfproof/state.json`
（`path_mode=FIX`、`phase=wave4`、`fix_contracts` 2 条、`report` 字段**完全不写**、
`current_plan` 与 `budget` 都齐备——即除了这一项之外全部合规）。

### 3.1 `check-state.mjs`

```
$ node tools/check-state.mjs experiments/hilltop-dsh/out/r14-selfproof/state.json

state.json 校验: experiments/hilltop-dsh/out/r14-selfproof/state.json

  round: round-r14   status: RUNNING   slices: 0

  ✗ 1 项违规:

    [report_dir_required] report.dir_path
      path_mode=FIX 且 phase=wave4，账本里有 2 条 fix_contract，但 report.dir_path 和 report.final_report_path 都没写。这不是格式问题——stop-hook.mjs §3.7 要从这两个字段推断修复产物目录，才能跑「产物必须带 JSON 信封」那道闸门。两个字段都空 = 闸门推断不出目录 = 只能用一条 WARN 放行。换句话说：不写这两个字段，等于用省略换掉一道门。补法：把本轮产物目录的绝对路径写进 report.dir_path（report-naming.md §5.1：波次一启动前就该有它），或至少写 report.final_report_path

  ⚠️  1 项警告:
    [empty_slices] slices: slices 为空。若这是 init 阶段可忽略，否则应有切片

EXIT=1
```

（`empty_slices` 是构造数据故意留空的，与本改动无关。）

### 3.2 `stop-hook.mjs`

```
$ node tools/stop-hook.mjs --state experiments/hilltop-dsh/out/r14-selfproof/state.json
[交付粒度检查] 还不能结束这一回合：

1. 产物目录推断不出来，而 phase=wave4 已经登记了 2 条修复契约。
state.json 里既没有 report.dir_path，也没有 report.final_report_path，fix_contracts[].test_path 也不足以定位产物目录。

**在这条判据上，「推断不出目录」不是环境问题，是账本缺字段。** 修复已经登记了，就必然有产物要交、有「产物必须带 JSON 信封」这道闸门要跑；而闸门需要一个目录作为输入。
所以不能像 R13 那样用一条 WARN 放行——那样等于把「检查没跑」记成「检查通过」，而绕过它只需要省略一个字段（FIX-R13-report.md §7.2 口子 1，R13 自己标为「最大的残留口子」）。

环境问题（例如 sessions root 不存在）可以降级，账本缺字段不行——区别在于「谁有能力让它变成可查」：环境不行时你无能为力，缺字段时你只要写一行。
补法：把本轮产物目录的**绝对路径**写进 report.dir_path（report-naming.md §5.1：波次一启动前就该有它），或至少写 report.final_report_path（与产物同目录），并确认该目录真实存在。

如果你确实需要用户决定某件事，只有 protocol.md §0.8.5 列出的 6 种情形可以。其余情况请自行判断、记进 discipline_log，然后继续。
EXIT=2
```

两个工具都报了错，且理由一致（都指向「账本缺字段」而不是「格式」）。

### 3.3 反向验证：补上 `dir_path` 就放行

同一份账本加上 `report.dir_path`（指向真实存在的 `r14-selfproof/` 目录，里面没有产物）：

```
$ node tools/check-state.mjs .../state.with-dir.json
  ✅ schema 合规                         EXIT=0

$ node tools/stop-hook.mjs --state .../state.with-dir.json
[产物信封检查 · 告警（不阻断）]
1. WARN · 产物目录 …\r14-selfproof（来自 report.dir_path）下没有任何 done-*.md / *-fix-*.md，产物信封检查没有对象可查。…
                                       EXIT=0
```

### 3.4 顺带查出的第三个形态（改代码时补的）

`dir_path` 写了但目录不存在：

```
1. 产物目录推断不出来，而 phase=wave4 已经登记了 2 条修复契约。
state.json 里写了目录线索（report.dir_path="does-not-exist-xyz"，report.final_report_path=undefined），但按它解析出的目录都不存在，fix_contracts[].test_path 也定位不到。
**这仍然是账本问题，不是环境问题**：路径写错了，而「写错」不能当成「没写」的降级通道。…    EXIT=2
```

它本来就是 exit 2（因为目录推断不出），但**改前的消息会误报成「既没有 report.dir_path」**——
而它明明写了。这条分支不是新增的拦截力，是把已有拦截的解释修对了。

---

## 四、改动清单

| 文件 | 改动 | 在任务书清单内 |
|---|---|---|
| `tools/check-state.mjs` | +§4.55（41 行，含理由注释），新增 `report_dir_required` | ✅ |
| `tools/check-state.test.mjs` | +6 个 case / +15 断言（40 → 52）；case 29 / 32 的样本补上 `report` | ✅ |
| `tools/stop-hook.mjs` | §3.7 降级判据改为按 `fix_contracts` 分流 + 文件头判据说明重写 | ✅ |
| `tools/stop-hook.test.mjs` | case 23 改判 + 新增 23b/23c/23d；case 18/19/20 的样本补上 `report` | ✅ |
| `framework/artifacts/run-state.md` | §2 schema 注释、§2 字段表、§2.5.2 机械校验行、§2.6.2 改写 | ✅ |
| `experiments/hilltop-dsh/FIX-R14-report.md` | 本文件 | 报告 |

**对原有测试的改动（必须说明，否则「55 条全过」是骗人的）**：

| case | 改了什么 | 为什么 |
|---|---|---|
| stop-hook case 23 | 断言从 `exit 0 + WARN` **反转**为 `exit 2` | 原断言锁的就是要堵的洞 |
| stop-hook case 18 / 19 / 20 | 样本补上 `report.dir_path`（指向真实存在的空目录） | 这三条测的是 §3.6 的 harness 对账。不补的话，`exit 2` 会来自「账本缺 `report.dir_path`」而不是被测的路径——测试仍然会红/绿，但**测的东西变了** |
| check-state case 29 / 32 | 样本补上 `report.dir_path` | 同上：这两条是「应当完全合规」的样本 |

这三处（+case 29/32）**不是为了让测试通过而改测试**：它们都在断言「除被测项之外全绿/全红」，
而 R14 让 `path_mode=FIX + wave4 + 契约非空 + 无目录字段` 从「合规」变成了「不合规」，
所以那些样本自身的基线变了。改的是基线，不是期望。

**没动的**：`check-fix-artifacts-envelope.mjs`（一行未改，仍无 `--ignore`）、
`experiments/hilltop-dsh/repair/*.md`（6 份历史产物原样）、`check-all.mjs`（新测试已被现有注册项覆盖）。

**未 commit**（遵守任务书）。`git status`：

```
 M framework/artifacts/run-state.md
 M tools/check-state.mjs
 M tools/check-state.test.mjs
 M tools/stop-hook.mjs
 M tools/stop-hook.test.mjs
?? experiments/hilltop-dsh/out/r14-selfproof/     ← 自证用的 state.json
?? experiments/hilltop-dsh/FIX-R14-report.md
```

---

## 五、验证

```
$ node tools/check-state.test.mjs
=== 结果: 52 通过 / 0 失败 ===        （原 40 + 新 12：case 36–41，其中 4 条断言 x 若干）

$ node tools/stop-hook.test.mjs
=== 结果: 63 通过 / 0 失败 ===        （原 55，case 23 改写为 3 条断言 + 新增 23b/23c/23d 共 8 条断言）

$ node tools/check-all.mjs
✅ 全部通过
```

---

## 六、诚实评估：R13 §7.2 那张表的 6 个口子，还剩几个

R13 的原表（`FIX-R13-report.md` §7.2）：

| # | 口子 | R14 之前 | R14 之后 | 还差什么 |
|---|---|---|---|---|
| 1 | 不写 `report.dir_path` / `final_report_path` → 目录推断不出 | ❌ 一条 WARN 放行（**最省力**） | ✅ **拦住**：`check-state` 报 `report_dir_required` + `stop-hook` exit 2 | **但换了个写法仍然能绕**，见下 |
| 2 | 有信封但字段错（`schema_version` / `role` / `disposition` 非法） | ⚠️ 部分拦（`envelope_wrong_role` / `envelope_missing_disposition` 是 FAIL，其余不拦） | ⚠️ **完全没变** | `stop-hook` §3.7 只调 `check-fix-artifacts-envelope`，不调 `check-payload` |
| 3 | `red_log_path` 指向已删除文件 | ⚠️ 不给 `--repo` 就降级 WARN | ⚠️ **完全没变** | R11 洞 A，需要被审仓库根 |
| 4 | 信封里 `files_touched` 写假路径 | ❌ 无任何检查 | ❌ **完全没变** | 需要与 git / 文件系统对账 |
| 5 | 把无信封产物移进 `legacy/` 子目录 | ⚠️ 一条 WARN（子目录不进分母） | ⚠️ **完全没变** | 子目录不进分母这件事本身没改 |
| 6 | `legacy_artifacts` 写到 6/15（真实形态） | ⚠️ 一条「本轮没有任何修复产物经过信封检查」的 WARN | ⚠️ **完全没变** | 分母口径是 R13 的决定，本轮没推翻 |

**结论：6 个里堵住了 1 个（口子 1），另外 5 个一字未动。**

### 6.1 口子 1 本身还剩多深（不要读成「堵完了」）

`report_dir_required` 要求的是「**字符串非空**」，不是「**目录存在**」。
所以把 `dir_path` 写成一个真实存在、但没有 `done-*.md` / `*-fix-*.md` 的目录，仍然 exit 0：

```
$ node tools/stop-hook.mjs --state <dir_path 指向空目录>
[产物信封检查 · 告警（不阻断）]
1. WARN · 产物目录 … 下没有任何 done-*.md / *-fix-*.md，产物信封检查没有对象可查。…
EXIT=0
```

这仍然是「用一条 WARN 换掉闸门」，与 R13 §7.2 口子 1 同一类。它比改前**难一点**（要写一个存在的路径，
而且这个路径会原样出现在 WARN 里），但**不是不可行**。

**为什么本轮没顺手把它也升成 FAIL**：这条降级是 R13 在有意识的情况下留的——
修复相位允许「产物还没写完」这个中间态（`stop-hook.mjs` §3.7.2 注释：
「修复相位允许『产物还没写完』这个中间态，真正的『这个相位做完了』由 3 的交付物判据负责」）。
把它无条件升成 FAIL 会让「派了 3 个修复、还没一个落盘」的回合无法结束回合——
而那正是本框架鼓励的并行形态。要升它，得先回答「什么信号说明产物应当已经写完了」
（比如「所有 fix_agent 都不在 `in_flight` 里」），那是下一轮的事。

这一条我写进了 `run-state.md` §2.6.2 的正文里，不只是写在这份报告里——
否则它会和 R13 的口子 1 一样，变成「下一个 R 轮才看见」的东西。

### 6.2 「agent 还是不跑 check-payload」还能发生吗？

**能发生，而且本次改动完全没有改变这一点。**

R13 的 Layer 2 讲的是：`stop-hook` §3.7 只调 `check-fix-artifacts-envelope`，
而那个检查器**只问一件事：有没有信封**，不问信封里的字段对不对。

R14 改的是「§3.7 能不能拿到目录」，不是「§3.7 拿到目录之后跑几个检查器」。
判据链条仍然是：

```
stop-hook §3.7
  → check-fix-artifacts-envelope.mjs --dir <dir>     （只验信封的存在与 role/disposition）
  → 从不调用 check-payload.mjs                        （不验 red_log_path / files_touched / schema_version）
```

所以 R13 §7.1 那张表逐行仍然成立，**一个字都没变**：

| 产物状态 | 信封闸门（R14 后仍如此） | `check-payload` |
|---|---|---|
| 无信封 | FAIL | FAIL（`no_json_envelope`） |
| 有信封、`schema_version: "WRONG"` | **放行** | **FAIL** |
| 有信封、`disposition` 全缺 | FAIL | FAIL |

一个 `schema_version` 写错、`red_log_path` 指向已删除文件的产物，**R14 之后仍然能闭合 wave4**。

R14 唯一改变的是一件事：**绕过「有没有信封」这道闸门，不能再靠「什么都不写」了**。
它把这条路的成本从「省略」提高到「写一个存在的路径，并且接受 stderr 上一条指名道姓的 WARN」。
成本提高了，但门还在原地。**把「成本提高」说成「闭环」就是 R11 §8.2 与 R12 §八批评过的写法。**

### 6.3 一句话总结

> **R14 把「用省略换掉一道门」关掉了。**
> **但它没有动「门只查一件事」「门可以被指向空目录」「降级仍然是一种通过」这三件更根本的事。**
> **四环证据链的（1）现在要求先写对字段；（2）（3）（4）与 R13 完全相同。**

---

## 七、下一轮建议

| 序 | 内容 | 为什么 | 成本 |
|---|---|---|---|
| 1 | `dir_path` 从「非空字符串」升级为「存在且是目录」 | 本轮留下的同类绕过（§6.1）。判据只需 `existsSync`，但报错必须区分「没写」与「写了但不存在」 | 低 |
| 2 | 「所有 fix_agent 都不在 `in_flight` + 契约非空 + 产物 0 份」→ FAIL | 这才是把 §6.1 那条空目录降级真正关掉的判据：它有客观信号，不需要猜「产物该不该写完」 | 中 |
| 3 | `stop-hook` §3.7 对每份产物顺带跑一次 `check-payload --role fix --repo <inferred>` | 补 Layer 2（§6.2）。**这是把第 2 环自动化的唯一走法**。前提是要有被审仓库根——`state.json` 里没有这个字段 | 中 |
| 4 | `check-payload --role fix` + `disposition: FIXED` 时强制 `--repo` / `--artifact-dir`，缺则 exit 2 | R11 洞 A / R12 §九建议 3 / R13 §十建议 3，三轮未做 | 低 |
| 5 | `red_log_path` 内容最低要求（含 `FAIL` / `BUILD FAILURE` / 非 0 退出码）+ mtime 早于 `files_touched` | 四环之第 4 环，一次未动 | 低 |
