# FIX-R11 报告 · 修「洞 4」：红测证据的存在性校验

**任务**：`check-payload` 对 fix 角色的 `FIXED` 产物只校验 `red_log_path` 的**路径形状**（正则 `(^|\/)target\/`），从不 `existsSync`。于是「路径写在 `target/` 之外、但那个文件从来没生成过」可以通过。
**依据**：`experiments/hilltop-dsh/FIX-R7-report.md` §4（洞 4，R7 实测，直接采信）。
**日期**：2026-11-15
**改动范围**：只改 `tools/check-payload.mjs` 和 `tools/check-payload.test.mjs`。未改 stop-hook，未改契约文档。

> **关于 commit（如实记录）**：我没有执行任何 `git commit`。但在我写完报告后，工作树由外部动作
> 提交为 `afb590e fix(R11): 洞 4 —— 证据文件必须真实存在，不只路径形状对`
> （作者 `sqkl520`，22:30:58；该 commit 同时装进了并行进行的 R9/R10 的改动）。
> 我已核对：`git diff HEAD` 对本次三个文件为空，即**提交内容与工作树逐字一致**，
> 且 `git show HEAD:tools/check-payload.mjs` 拿到独立目录实跑仍是 **161 通过 / 0 失败**。
> 记录在此是因为任务书要求「不要 commit」——若这是不该发生的提交，它已经发生了，需要由人决定是否回退。

---

## 一、结论

| 项 | 改动前 | 改动后 |
|---|---|---|
| `node tools/check-payload.test.mjs` | 126 通过 / 0 失败 | **161 通过 / 0 失败** |
| `node tools/check-all.mjs` | 全绿 | **全绿，exit 0**（`grep -c "✗"` = 0） |
| 洞 4 的三种形态 | 全部 exit 0 | 两种 FAIL（`red_log_not_found` / `test_path_not_found`），一种 WARN（`red_log_no_directory`） |
| 新增规则 | — | 3 条 + 3 条配套（降级/占位/根缺失） |

新增的 35 个断言（161 − 126）**无一改写在既有用例上**：case 1–116 的断言、`run()` / `runRaw()` 两个既有辅助函数、`env()` / `fixEnv()` 两个既有 fixture 全部原样保留。

---

## 二、判据代码

### 2.1 新增参数与「选项值不是产物路径」

`check-payload` 原来只有 `--role` 一个带值选项，取产物路径的方式是
`args.find((a) => !a.startsWith('--') && a !== expectRole)`——**新增两个带值选项后这里必须同步**，否则 `--repo /path` 里的 `/path` 会被当成产物文件。

```js
// tools/check-payload.mjs:39-60
const repoIdx = args.indexOf('--repo');
const artifactDirIdx = args.indexOf('--artifact-dir');
for (const [flag, idx] of [['--repo', repoIdx], ['--artifact-dir', artifactDirIdx]]) {
  if (idx >= 0) {
    const v = args[idx + 1];
    // 显式给了 flag 却没给值，不能静默忽略——那会让调用方以为检查生效了
    if (v === undefined || v.startsWith('--')) {
      console.error(`${flag} 需要一个目录参数`);
      process.exit(2);
    }
  }
}
const repoDir = repoIdx >= 0 ? resolve(args[repoIdx + 1]) : null;
const artifactDir = artifactDirIdx >= 0 ? resolve(args[artifactDirIdx + 1]) : null;

// 注意用**原始 argv 字符串**比较：repoDir 已被 resolve 成绝对路径，与 argv 不同形。
const OPTION_VALUES = new Set([expectRole, repoIdx >= 0 ? args[repoIdx + 1] : null,
  artifactDirIdx >= 0 ? args[artifactDirIdx + 1] : null]
  .filter((v) => typeof v === 'string' && v !== ''));
const file = args.find((a) => !a.startsWith('--') && !OPTION_VALUES.has(a));
```

> 这一处是我在实现中撞到的坑：第一版把 `resolve()` 之后的 `repoDir` 放进排除集，
> 而 `file` 的候选是**原始 argv**，两者不同形，排除集失效。已改成用原始字符串。
> CLI 边界实测见第六节。

### 2.2 解析与降级（规则 1/2 的公共骨架）

```js
// tools/check-payload.mjs:135-168
// 可用作「相对路径解析根」的目录。顺序契约：artifact-dir → repo → cwd。
const EVIDENCE_ROOTS = [];
for (const [label, dir] of [['--artifact-dir', artifactDir], ['--repo', repoDir]]) {
  if (!dir) continue;
  if (!existsSync(dir)) {
    warnings.push({
      field: label, rule: 'evidence_root_not_found',
      msg: `${label} 指向的目录不存在: ${dir}。该根不可用于解析证据路径，已忽略`,
    });
    continue;
  }
  EVIDENCE_ROOTS.push({ label, dir });
}

function locateEvidence(rawPath) {
  if (isAbsolute(rawPath)) {
    return { decided: true, found: existsSync(rawPath), tried: [rawPath] };
  }
  if (EVIDENCE_ROOTS.length === 0) {
    // 没有根 → 只还能试 cwd。命中即通过；未命中则**无法判定**（降级 WARN）。
    // 不直接判 FAIL：调用方没给根，测不到不等于不存在。
    const cwdPath = join(process.cwd(), rawPath);
    if (existsSync(cwdPath)) return { decided: true, found: true, tried: [cwdPath], hit: cwdPath };
    return { decided: false, found: false, tried: [cwdPath] };
  }
  const tried = [...new Set([
    ...EVIDENCE_ROOTS.map((r) => join(r.dir, rawPath)),
    join(process.cwd(), rawPath),
  ])];
  const hit = tried.find((p) => existsSync(p));
  return { decided: true, found: !!hit, tried, hit };
}
```

三个设计点值得单独说明：

1. **`--artifact-dir` 排在 `--repo` 前**，与任务书的「先按 `--artifact-dir` 拼，再按 `--repo` 拼，再按 cwd 拼」逐字一致。case 124c 用「文件只存在于 artifact-dir 一侧」反证顺序不可颠倒。
2. **绝对路径不需要任何根**。`locateEvidence` 第一条分支就短路，所以「不给根」不等于「全都不可判定」——绝对路径仍然会被判死。case 124b 覆盖。
3. **`decided: false` 是独立于 `found: false` 的状态**。这是降级纪律的实现基础：`!found` 才 FAIL，`!decided` 只 WARN。把两者混成一个布尔值，就会退化成「没给根 = 全部违规」。

### 2.3 三条新增规则

```js
// tools/check-payload.mjs:244-311（缩在 if (d === 'FIXED') 之内）
// 规则 3 — 裸文件名 → WARN，不 FAIL
if (typeof rlp === 'string' && rlp.trim() !== '' && !/[\\/]/.test(rlp.trim())) {
  warnings.push({
    field: `${prefix}.red_log_path`, rule: 'red_log_no_directory',
    msg: `red_log_path 是裸文件名（${rlp}），不含任何路径分隔符——无法判断它落在哪个目录，`
      + '容易和「当前工作目录」混淆。建议写成相对产物或仓库根的路径'
      + '（例如 experiments/<round>/red-<finding>.log）',
  });
}

const undecided = [];

// 规则 1 — red_log_path 解析后不存在 → FAIL
if (typeof rlp === 'string' && rlp.trim() !== '') {
  const p = rlp.trim();
  const loc = locateEvidence(p);
  if (!loc.decided) {
    undecided.push({ field: `${prefix}.red_log_path`, path: p, rule: 'red_log_not_found' });
  } else if (!loc.found) {
    out.push({
      field: `${prefix}.red_log_path`, rule: 'red_log_not_found',
      msg: `red_log_path 指向的文件不存在（${TRIED_MSG(loc.tried)}）。`
        + '路径形状对了不代表文件存在过——2026-11-15 那次验收引用的三个红测日志就是这样：'
        + '路径都合法，但已经被构建清理掉了，验收却写着『证据存在且内容可信』。',
    });
  }
}

// 规则 2 — test_path 解析后不存在 → FAIL；占位值跳过并 WARN
if (typeof tp === 'string' && tp.trim() !== '') {
  const p = tp.trim();
  if (isPlaceholderPath(p)) {
    warnings.push({
      field: `${prefix}.test_path`, rule: 'test_path_placeholder',
      msg: `test_path 是占位值（${p}）：按 wave4-fix.md 契约允许，本次跳过存在性检查。`
        + '**但意味着这条修复的测试当时并不存在**——验收波必须确认它后来真的被建出来了',
    });
  } else {
    const loc = locateEvidence(p);
    if (!loc.decided) {
      undecided.push({ field: `${prefix}.test_path`, path: p, rule: 'test_path_not_found' });
    } else if (!loc.found) {
      out.push({
        field: `${prefix}.test_path`, rule: 'test_path_not_found',
        msg: `test_path 指向的文件不存在（${TRIED_MSG(loc.tried)}）。`
          + 'FIXED 声称「有证明修复前是红的测试」，但测试文件本身找不到——'
          + '「声称有测试」和「测试真的存在」是两件事',
      });
    }
  }
}

// 降级纪律（规则 1/2 的降级合并成一条警告，按路径集合去重）
if (undecided.length > 0) {
  const key = JSON.stringify(undecided.map((u) => u.path).sort());
  if (!UNDECIDED_WARNED.has(key)) {
    UNDECIDED_WARNED.add(key);
    warnings.push({
      field: undecided.map((u) => u.field).join(', '),
      rule: 'evidence_existence_unchecked',
      msg: '未提供 --repo/--artifact-dir，无法校验证据是否存在：'
        + undecided.map((u) => `${u.field}（${u.path}）`).join(' / ')
        + '。路径形状检查仍然生效，但**「文件是否真的存在过」这一项本轮没有验证**——'
        + '请主 Agent 在接收时带 --repo <被审仓库根> 或 --artifact-dir <产物目录> 重跑一次',
    });
  }
}
```

### 2.4 占位值判据（`test_path` 的契约例外）

`framework/templates/wave4-fix.md:169` 原文：「`disposition_condition` 所依赖的测试文件或复现脚本的路径；**如果不存在，写明“需新建”**」。所以占位值是**契约允许的合法写法**，不能判死。

```js
// tools/check-payload.mjs:170-181
const TEST_PATH_PLACEHOLDER = /^(需新建|待创建|待新建|需创建|新建|TODO|TBD|N\/?A|无)$/i;
const isPlaceholderPath = (s) => {
  const t = String(s ?? '').replace(ZERO_WIDTH, '').trim()
    .replace(/[\s。，,.;；:：!！?？()[\]（）]/g, '');
  if (t === '') return false;
  // 精确占位词，或「需新建」「TODO:<说明>」这类以占位词开头并带补充说明的写法
  return TEST_PATH_PLACEHOLDER.test(t)
    || /^(需新建|待创建|待新建|需创建|TODO|TBD).{2,}$/i.test(t);
};
```

两个细节：

- 先剥零宽字符再比对，沿用文件里既有的 `ZERO_WIDTH` / `substanceLength` 纪律——否则 `需新建` 加一个零宽字符就能「不算占位」。
- 支持「需新建 + 说明」的形式（`需新建 覆盖恢复量测试`、`TODO: 等上游 API 稳定后补`）。真实产物几乎不会只写两个字。case 122b 覆盖三种写法。

### 2.5 规则的作用域

三条规则全部在 `if (d === 'FIXED')` 之内。理由：`test_path` / `red_log_path` 本来就是 FIXED 的条件必填字段，非 FIXED 档位（`WONT_FIX` / `DEFERRED` / `NEW_FINDING`）根本不要求它们存在。把它们拿到外面检查，会让「不修」也必须提供一个测试文件——这不是洞 4 要修的东西，属于过度执法。case 128 反向锁定这一点。

而既有的 `red_log_in_target` **保持在 `if (d === 'FIXED')` 之外**（原设计：只要给了路径就查形状），本轮**没有改动它一行**。这是有意的：洞 4 是「缺一条检查」，不是「现有检查写错了」。

---

## 三、新测试在改代码前的失败信息原文

**先写测试，跑一遍，确认 FAIL，再改实现。** 下面是加完 case 117–128、尚未改 `check-payload.mjs` 时的完整失败输出（原文，未删节）：

```
case 117: FIXED + red_log_path/test_path 都指向真实存在的文件 → 通过（不误杀）
  ✓ 无错误
  ✓ 不报 red_log_not_found
  ✓ 不报 test_path_not_found
case 118: FIXED + red_log_path 指向不存在的文件 → 必须 FAIL red_log_not_found
  ✗ 退出码 1 — got 0
  ✗ 报 red_log_not_found — []
  ✗ 消息列出试过的解析路径
  ✗ 消息点明「路径形状对了不代表文件存在过」
case 119: FIXED + red_log_path 是裸文件名 red.log → WARN red_log_no_directory（不是 FAIL）
  ✗ 报 red_log_no_directory 警告 — ["artifact_outdir_placeholder"]
  ✓ 不因裸文件名 FAIL
  ✓ 裸文件名且文件确实存在时不报 red_log_not_found
case 120: FIXED + test_path 指向存在的文件 → 通过
  ✓ 无错误
case 121: FIXED + test_path 指向不存在的文件 → 必须 FAIL test_path_not_found
  ✗ 退出码 1 — got 0
  ✗ 报 test_path_not_found — []
case 122: FIXED + test_path 是「需新建」→ 跳过存在性检查并 WARN
  ✓ 不报 test_path_not_found
  ✗ 报 test_path_placeholder 警告 — ["artifact_outdir_placeholder"]
  ✓ 整体无错误
case 123: 不给 --repo 也不给 --artifact-dir + 路径不存在 → WARN 而非 FAIL（降级纪律）
  ✓ 退出码 0
  ✓ 不报 red_log_not_found
  ✓ 不报 test_path_not_found
  ✗ 报 evidence_existence_unchecked 降级警告 — ["artifact_outdir_placeholder"]
  ✗ 警告写明未提供 --repo/--artifact-dir
case 124: --repo 解析相对路径（日志只在仓库根下存在）→ 通过
  ✓ 无错误
case 124b: 绝对路径不依赖任何根即可判定（存在 → 通过）
  ✓ 绝对路径存在时不报 red_log_not_found
case 125: 回归 —— target/ 的 4 种写法仍然报 red_log_in_target（给出根时同样成立）
  ✓ 四种 target/ 写法全部被抓
case 126: 真实事故的完整形态 —— target/ 日志已不存在 → 同时报 in_target 与 not_found
  ✓ 报 red_log_in_target
  ✗ 同时报 red_log_not_found（文件已被清理） — ["red_log_in_target"]
case 127: 证据已存在但路径落在 target/ → 有根时仍只报 in_target，不报 not_found
  ✓ 报 red_log_in_target
  ✓ 不报 red_log_not_found
case 128: 非 FIXED 的 disposition 不因 test_path 不存在而 FAIL（不能过度执法）
  ✓ 不报 test_path_not_found
  ✓ 无错误

=== 结果: 145 通过 / 11 失败 ===
```

计数对照：既有 126 个断言 + 本轮新增 30 个 = 156；`145 + 11 = 156`。
**失败全部落在新增规则那一侧（11 个），既有的 126 个断言一个都没红**——这是「洞 4 此前确实没被检查」的直接证据。

失败信号的质量与洞 4 完全对应：

| 失败断言 | 它证明了什么 |
|---|---|
| `✗ 退出码 1 — got 0`（case 118/121） | 不存在的证据路径**不阻断**——正是 R7 实测的 `exit 0` |
| `✗ 报 red_log_not_found — []` | 该规则此前**不存在**，`errors` 里空空如也 |
| `✗ 报 red_log_no_directory 警告 — ["artifact_outdir_placeholder"]` | 裸文件名此前**完全无声**：唯一那条 warning 是 `artifact_path` 的，与 `red_log_path` 无关 |
| `✗ 同时报 red_log_not_found — ["red_log_in_target"]`（case 126） | 事故的**完整形态**此前只报了一半：形状抓到了，存在性没抓 |
| `✓ 退出码 0`（case 123） | 降级纪律的**现状**：不给根时确实不卡死——这条断言在改代码前后都是绿的，它守的是「不要把已有行为改坏」 |
| `✓ 不因裸文件名 FAIL`（case 119） | 同上：裸文件名不得升级为 FAIL，改代码前后都绿 |

最后两条是我有意写成**改代码前就绿**的：它们守的是边界纪律，如果实现时手滑把 WARN 写成了 FAIL，它们会立刻变红。

---

## 四、修 R7 洞 4 的三种形态：前后对照

| R7 实测输入 | 改动前 | 改动后 |
|---|---|---|
| `red_log` 指向不存在的文件（`target/` 外） | `exit 0` \| `rules []` | `exit 1` \| `red_log_not_found` |
| `test_path` 指向不存在的文件 | `exit 0` \| `rules []` | `exit 1` \| `test_path_not_found` |
| `red_log_path` 写成 `red.log`（无目录） | `exit 0` \| `rules []` | `exit 0` \| `red_log_no_directory`（WARN） |

第三种按任务书要求**不升级为 FAIL**：有些环境里产物和日志就是并排的，升级会误杀合法产物。但「无声」变成了「有声」，且不阻断。

### 4.1 双重报错就是这个事故的完整形态

case 126 锁定了这一点。产物写 `red_log_path: 'target/repair1-red.log'`、`--artifact-dir .`，而该文件确实不存在时：

```
[red_log_in_target] payload.red_log_path
  red_log_path 指向构建产物目录（target/repair1-red.log），会被构建清理…
[red_log_not_found] payload.red_log_path
  red_log_path 指向的文件不存在（试过：`…/target/repair1-red.log` / `…/target/repair1-red.log`）。
  路径形状对了不代表文件存在过——…
```

两条规则判的是**两件不同的事**：

- `red_log_in_target` = 「这份证据**将来会被**清理掉」（形状）
- `red_log_not_found` = 「这份证据**现在**打不开」（存在）

事故当时是：日志放在 `target/` 下（第一条会响），然后 `mvn clean` 删掉了它（第二条此刻会响），**而验收记录写的是「证据存在且内容可信」**。单看第一条，人能辩解「我验收时它还在」；第二条把「现在不在了」变成机器可判的事实。

case 127 反过来锁定二者的独立性：`target/red-F1.log` **真实存在**时，只报 `red_log_in_target`，不报 `red_log_not_found`。这说明新规则不是 `in_target` 的重复包装。

---

## 五、真实数据自证

### 5.1 `done-*.md` 有没有 fix 角色的 JSON 信封？——没有，一封都没有

按任务书要求先查：

```
$ grep -c '"schema_version"' experiments/hilltop-dsh/repair/*.md
experiments/hilltop-dsh/repair/ACCEPTANCE-ROUND1.md:0
experiments/hilltop-dsh/repair/ACCEPTANCE-ROUND2.md:0
experiments/hilltop-dsh/repair/ADJUDICATION-2.md:0
experiments/hilltop-dsh/repair/ADJUDICATION-5.md:0
experiments/hilltop-dsh/repair/DISPATCH-PITFALLS.md:0
experiments/hilltop-dsh/repair/MAIN-THREAD-VIOLATION.md:0
experiments/hilltop-dsh/repair/PRECEDENTS.md:0
experiments/hilltop-dsh/repair/REPAIR-LOG.md:0
experiments/hilltop-dsh/repair/SUMMARY.md:0
experiments/hilltop-dsh/repair/done-1.md:0
experiments/hilltop-dsh/repair/done-3.md:0
experiments/hilltop-dsh/repair/done-4.md:0
experiments/hilltop-dsh/repair/done-6.md:0
experiments/hilltop-dsh/repair/done-7.md:0
experiments/hilltop-dsh/repair/done-8.md:0
```

直接跑校验器（原文）：

```
$ node tools/check-payload.mjs experiments/hilltop-dsh/repair/done-7.md --role fix --json
{
  "file": "experiments/hilltop-dsh/repair/done-7.md",
  "ok": false,
  "role": null,
  "errors": [
    {
      "field": "(root)",
      "rule": "no_json_envelope",
      "msg": "产物里没有 ```json 代码块。契约要求返回必须包在 JSON 信封里。",
      "fix": "在产物文件末尾追加一个 ```json 块，内容见 components/output-contract.md §1"
    }
  ],
  "warnings": []
}
```

### 5.2 这个事实意味着什么（诚实结论）

**新规则对那批真实产物完全无能为力。** `role` 是 `null`，因为信封不存在；三条新规则都挂在 `envelope.role === 'fix'` 之下的 `disposition === 'FIXED'` 分支里，一条都走不到。校验器对这 6 份产物只会说一句「没有 JSON 信封」——这一句在 R6 之前就已经会说了，R11 一个字都没多加。

这不是新规则写错了，而是**这个洞的观测窗口本来就是空的**：

1. **修复产物在契约体系里至今不可见。** 6 份 `done-*.md` 全是人读的 Markdown，从未经过任何结构化校验。`DIAG2-coverage-gap.md:289` 已经记过同一事实（「`grep -c '"schema_version"' repair/done-*.md` = 0」），R11 复查仍是 0。
2. **所以那次事故里，「证据存在且内容可信」这句话是纯人工断言，没有任何机器参与。** 加 `existsSync` 能让校验器在**将来**拦住同形产物，但它救不回那 6 份——它们在契约之外。
3. **真正的前置条件是「修复产物必须带信封」，而不是「信封里的路径必须存在」。** R11 修的是后半句。前半句（信封强制 + 修复相位必须调 `check-payload`）仍然敞着，见第七节。

**这条要如实记在报告里，不能包装成「已验证真实数据」**：本轮我验证的是**规则在合成 fixture 上正确**，以及**在真实仓库路径上会给出正确结论**（见 5.3），而不是「真实产物被新规则拦下了」。

### 5.3 用真实仓库路径做反事实自证

`done-*.md` 没有信封，所以我做了一件任务书没要求但更能说明问题的事：**给真实产物补一个它当时本该有的信封（其余字段逐字采自 `ACCEPTANCE-ROUND1.md` 的引用），拿真实仓库 `repair-work/project` 当 `--repo` 跑。**

产物内容（`red_log_path: target/config7-red.log`、`test_path: …/ConfigManagerClampTest.java`，均取自 ACCEPTANCE-ROUND1 表格）：

```
$ node tools/check-payload.mjs /tmp/selfproof.md --role fix \
    --repo experiments/hilltop-dsh/repair-work/project
```

输出（原文，只截断言部分）：

```
  ✗ 3 项违规:

    [red_log_in_target] payload.red_log_path
      red_log_path 指向构建产物目录（target/config7-red.log），会被构建清理（如 mvn clean / gradle clean / rm -rf target）删掉…
    [red_log_not_found] payload.red_log_path
      red_log_path 指向的文件不存在（试过：`…\repair-work\project\target\config7-red.log`
      / `…\multi-agent-audit-framework\target\config7-red.log`）。路径形状对了不代表文件存在过——
      2026-11-15 那次验收引用的三个红测日志就是这样：路径都合法，但已经被构建清理掉了，
      验收却写着『证据存在且内容可信』。
    [test_path_not_found] payload.test_path
      test_path 指向的文件不存在（试过：`…\repair-work\project\src\test\java\…\ConfigManagerClampTest.java`
      / `…\multi-agent-audit-framework\src\test\java\…\ConfigManagerClampTest.java`）。
      FIXED 声称「有证明修复前是红的测试」，但测试文件本身找不到——「声称有测试」和「测试真的存在」是两件事
```

而磁盘上的事实与之一致：

```
$ ls experiments/hilltop-dsh/repair-work/project/target
classes  generated-sources  generated-test-sources  maven-status  surefire-reports  test-classes

$ find experiments/hilltop-dsh/repair-work/project/target -name "*.log"
（无输出）

config7-red.log          → MISSING
config7-infinity-red.log → MISSING
repair1-red.log          → MISSING
full-test-final.log      → MISSING
```

**这就是那次事故的完整形态，机器现在能自己说出来了**：路径形状合法但落在 `target/`（`in_target`），且文件已被清理（`not_found`）。改动前只有第一条会响。

> 五个目标路径全部不存在这一点还有独立价值：`ACCEPTANCE-ROUND1.md:36-38` 与 `SUMMARY.md:25-26`
> 把这些日志当成「三个『修复前是红的』证据文件存在且内容可信」引用，
> **而它们现在全部不在**。当时那句话是对的（验收时文件还在），但**不可复核**——
> 这正是「证据一旦可被构建清理，等于没有证据」的字面含义。

### 5.4 降级纪律的真实形态

同一份产物，**不带任何根**：

```
$ node tools/check-payload.mjs /tmp/selfproof.md --role fix

  ✗ 1 项违规:
    [red_log_in_target] payload.red_log_path   …（形状检查照旧生效）

  ⚠️  2 项警告:
    [artifact_outdir_placeholder] …
    [evidence_existence_unchecked] 未提供 --repo/--artifact-dir，无法校验证据是否存在：
      payload.red_log_path（target/config7-red.log） / payload.test_path（…/ConfigManagerClampTest.java）。
      路径形状检查仍然生效，但**「文件是否真的存在过」这一项本轮没有验证**——
      请主 Agent 在接收时带 --repo <被审仓库根> 或 --artifact-dir <产物目录> 重跑一次
```

形状检查不回归，存在性降级为可见的 WARN。**既有调用方（`experiments/hilltop-audit-via-dsh.mjs:140` 那种 `node tools/check-payload.mjs <产物> --role <role>`）的行为不变**——它们不带新参数，不会因为本轮改动突然全红。

---

## 六、CLI 边界实测

新参数最容易出的错是「选项值被当成位置参数」。四组实测：

```
$ node tools/check-payload.mjs --repo . /tmp/a.md --role fix --json
  file= C:/Users/…/a.md   ok= false   err= [ 'red_log_not_found' ]
  warn= [ 'artifact_outdir_placeholder', 'red_log_no_directory', 'test_path_placeholder' ]
  # --repo 放在产物路径**之前**也能正确识别产物；三条新规则同时命中

$ node tools/check-payload.mjs /tmp/a.md --repo
  --repo 需要一个目录参数
  exit=2
  # 给了 flag 不给值 → exit 2，不静默忽略

$ node tools/check-payload.mjs --repo .
  用法: node check-payload.mjs <产物文件> [--role …] [--repo <被审仓库根>] [--artifact-dir <产物所在目录>] [--json]
  exit=2

$ node tools/check-payload.mjs /tmp/a.md --role fix --repo ./不存在的目录
  # → WARN evidence_root_not_found，该根被忽略，其余照常判定
```

第二、三组是有意的：**「参数给了但无效」必须当场失败**，否则调用方会以为存在性检查生效了，而实际上它被静默跳过——那正是洞 4 的同一种失败方式（看起来检查了，其实没检查）。

---

## 七、不要改 stop-hook：判断依据

任务书要求说明这个判断。我的依据是**调用路径本身**：

1. **它被任务书里的自检命令显式调用。** `framework/components/output-contract.md:53-65`「### 0.2 发送前自检（**强制**）」写明 `node check-payload.mjs <产物> --role <角色>`，退出码 1 = 「不得返回」；`:65` 还要求主 Agent 收到任何返回后再跑一次。`experiments/hilltop-audit-via-dsh.mjs:140` 也是这个形态：`写完立刻自检：node ${FW}/tools/check-payload.mjs <产物> --role <role>`。
2. **stop-hook 是「回合结束」的门，不是「产物内容」的门。** 它读 `state.json` 判相位闭合、判多缺陷单实例串行（R1）。`check-payload` 需要的是**产物文件路径**，而 stop-hook 在回合结束时拿不到「这一回合产生的产物是哪一份」这个信息——它只知道 state 里登记了什么。硬挂上去就得让 stop-hook 去猜路径，猜错就误拦。
3. **加参数后挂载会变成危险动作。** 新规则的效果依赖 `--repo` / `--artifact-dir` 是否被提供。stop-hook 自动调用时几乎必然拿不到这两个参数，于是每次都只产出 `evidence_existence_unchecked` 警告——**一个永远降级的检查挂在强阻断点上，等于用「看起来在查」替换「真的在查」**，比不挂更坏。
4. **本轮明确不改文件作用域。** 任务书只授权两个文件，stop-hook 及其测试不在其中。

所以：`check-payload` 保持「派发前/接收时显式调用」的定位。它需要的不是更强的挂载点，而是**调用方带上 `--repo`**——这一点我写进了降级警告的文案里（「请主 Agent 在接收时带 --repo … 重跑一次」），让人有明确的下一步。

---

## 八、诚实评估：这个改动之后，还有哪些「证据造假」形态查不出来

按「攻击者视角」逐条列，越靠前越容易做到：

### 8.1 查不出来的（本轮之后仍然是洞）

| # | 形态 | 为什么查不出 |
|---|---|---|
| 1 | **产物没有 JSON 信封** | 校验器的全部规则都挂在信封上。`role: null` 时除 `no_json_envelope` 外一条都不跑。**那 6 份真实产物就在这个洞里**（第五节）。R11 完全没碰到它。 |
| 2 | **修复相位根本不调 `check-payload`** | 校验器无法观测「自己是否被调用过」。`wave4-fix.md` / `wave5-verify.md` 的自检表里 `grep "check-payload"` = 0（`DIAG3-three-layer-closure.md:194` 记过），`wave2-audit.md:793` 才有。**再强的规则，不被调用就等于不存在。** |
| 3 | **伪造一个内容无害的文件** | `existsSync` 只回答「这个路径现在能打开吗」。攻击者 `echo FAIL > experiments/round1/red-F1.log` 就能通过。新规则把成本从「0」抬到「写一行」，**没有**抬到「真的跑过测试」。 |
| 4 | **日志存在但内容与主张无关** | 没有任何内容校验：不看时间戳、不看是否含 `FAIL`/`BUILD FAILURE`、不看是否对应该 `finding_id`、不看是否早于修复时间。**一份 `echo hi > red.log` 与一份真实 `mvn test` 输出等价。** |
| 5 | **路径存在但是个目录 / 空文件 / 别的东西** | `existsSync` 对目录、空文件、符号链接一律返回 `true`。我没有加 `statSync().isFile()` 或大小下限——加了自己也是在猜阈值。 |
| 6 | **`test_path` 指向一个原本就绿的测试** | 「测试文件存在」≠「这个测试证明修复前是红的」。这与 `red_log` 是同一个问题：**红测的语义在文件系统层面不可见。** |
| 7 | **`--repo` 指错 / 故意指向一个造好的假仓库** | 我在目录不存在时 WARN（`evidence_root_not_found`），但目录**存在且恰好放了符合名字的假文件**就无从分辨。校验器拿不到「哪个才是真的被审仓库」这个基准。 |
| 8 | **多发现形态里只处置一部分**（与洞 4 无关，但同属「产物造假」） | `dispositions[]` 的覆盖检查只在 `target_finding_ids` **非空**时生效。不传 `target_finding_ids` 就无基准可比——`disposition_missing_for_target` 会静默跳过。这属于 R4/R6 的地盘，不是本轮。 |
| 9 | **`files_touched` 声称改了但实际没改** | 全部字段都是自述。`check-payload` 不读代码、不算 diff。`check-fix-instances`（R6）也只对账登记，不验代码。 |
| 10 | **删掉旧证据后再补一份新造的** | `existsSync` 只看「现在有没有」。没有 `created_at` / 内容哈希 / 与 `baseline_result` 的关联，无法证明这份日志是**当时**那份。 |

### 8.2 一条结构性观察

这十项里，1、2、3、4 是同一条链上的四个环节，而**本轮只补了「路径能不能打开」这一环**：

```
产物有没有信封（1） → 有没有人调校验器（2） → 路径存在吗（3，本轮）→ 内容对得上主张吗（4）
```

严格说，**本轮修的是这条链上第三容易的一环**。它值得修，因为成本和收益比最好（一次 `existsSync`，零误报风险，且 2026-11-15 那次事故正卡在这一环）；但它**不是**这条链上最关键的一环——最关键的是 (1) 和 (2)，因为没有信封、或没人调用，后面的检查全部空转。

我在 5.2 里如实写了这一点：**新规则对那批真实产物无能为力，因为它们没有信封。** 一份报告如果说「洞 4 已修」而不说这句话，就是用一个正确的改动去掩盖一个更大的洞。

### 8.3 如果继续修，优先级建议

| 序 | 内容 | 理由 | 成本 |
|---|---|---|---|
| 1 | 修复产物强制信封 + 修复相位自检表补 `check-payload` | 让 (1)(2) 两环闭合。当前 6/6 真实修复产物在契约之外 | 中（要改 `wave4-fix.md` + 一个「产物是否跑过校验器」的机制） |
| 2 | `red_log_path` 内容最低要求：必须含失败标记（`FAIL`/`BUILD FAILURE`/非 0 退出码），且修改时间早于 `files_touched` | 把 (4) 从「完全不可见」抬到「粗粒度可判」。误报风险靠白名单控制 | 低 |
| 3 | `existsSync` 升级为 `statSync().isFile()` + 非空 | 堵住「建个空文件/目录」的最廉价绕过 | 极低 |
| 4 | `test_path` 指向的测试必须在该产物的 `verification_commands` 里出现过 | 把「测试存在」与「测试被跑过」关联起来 | 低 |

---

## 九、改动清单

| 文件 | 改动 |
|---|---|
| `tools/check-payload.mjs` | `git diff d119b39 HEAD --numstat` = **+182 / −3**。新增 `--repo` / `--artifact-dir` 参数（含缺值 exit 2、选项值不当作产物路径）、`EVIDENCE_ROOTS` / `locateEvidence()` / `isPlaceholderPath()` / `UNDECIDED_WARNED`，以及 6 条新规则：`red_log_not_found`、`test_path_not_found`、`red_log_no_directory`、`test_path_placeholder`、`evidence_existence_unchecked`、`evidence_root_not_found`。**既有规则一行未改**，既有调用方式（`<产物> --role <角色>`）行为不变。 |
| `tools/check-payload.test.mjs` | `git diff d119b39 HEAD --numstat` = **+280 / −1**。新增 `runIn()` 辅助（在产物目录里真建文件、显式传根、可指定 cwd）、`hasRule` / `hasWarn`，以及 case 117–128 共 35 个断言。既有 fixture（`env` / `fixEnv`）与辅助（`run` / `runRaw`）原样保留。 |

**未改**：`stop-hook.mjs`（理由见第七节）、任何契约文档、`check-all.mjs`（新测试被既有条目 `check-payload.test.mjs` 自动收纳，无需登记）。

**我的改动未 commit**（见文首关于 `afb590e` 的记录：它由外部动作产生，不是我执行 `git commit` 的结果；内容与本轮工作树逐字一致）。

---

## 十、验证原文

```
$ node tools/check-payload.test.mjs
  …（126 个既有断言全绿 + 35 个新断言全绿）…
=== 结果: 161 通过 / 0 失败 ===

$ node tools/check-all.mjs
  ……
  修复实例对账（UPHELD 是否都进入了修复登记）
    → === 结果: 167 通过 / 0 失败 ===

──────────────────────────────────────────
✅ 全部通过
EXIT=0
```

`grep -c "✗" /tmp/ca2.log` = **0**。
