# FIX-R17 报告 · 把 `check-payload` 接进 stop-hook 的 wave4 闸门

> 任务：`FIX-R14-report.md` §六 表里的口子 2 / 3 / 4。
> 允许改的文件：`tools/stop-hook.mjs`、`tools/stop-hook.test.mjs`（本报告是第三个，按输出要求）。
> **本次会话没有执行 `git add` / `git commit`。**

一句话结论：**口子 2 和口子 3 堵上了，口子 4 没堵——因为 `check-payload` 根本没有
`files_touched` 的存在性规则，不是接线问题，是规则不存在。**（§6 逐个说。）

---

## 1. 第二道闸门的代码位置

`tools/stop-hook.mjs` §3.7.5，插在 §3.7.4（`check-fix-artifacts-envelope.mjs`）之后、
`warnings` 落盘之前。位置在 `else if (dirReadable)` 分支内部——也就是说：

- 目录推断不出来 → 走 §3.7.1 的账本判据，不进入本段（没东西可查）；
- 目录可读但一份产物都没有 → 走 §3.7.2 的拒绝闭合，不进入本段；
- **有产物** → 先跑 3.7.4（有没有信封），再跑 3.7.5（信封里的字段对不对）。

为什么必须放在 3.7.4 **之后**：3.7.4 的输出（哪些产物没有信封）决定了本段该跳过谁。
对一份没有信封的产物跑 `check-payload`，只会得到一条 `no_json_envelope`——那是噪音，
而且会诱使读的人以为「补个信封就好了」，可真正的问题是它压根没进契约体系。

### 1.1 关键片段

**候选集：只查「有信封且未被 legacy 豁免」的产物**

```js
const hasEnvelope = (absPath) => {
  let text;
  try { text = readFileSync(absPath, 'utf8'); } catch { return false; }
  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  return blocks.some((b) => /"(schema_version|role)"\s*:/.test(b[1]));
};

const candidates = files
  .filter((f) => !legacySet.has(f))
  .map((f) => ({ name: f, abs: join(inferred.dir, f) }))
  .filter((x) => hasEnvelope(x.abs));
```

探测判据与 `check-payload.mjs` 自己的 `looksLikeEnvelope`、以及
`check-fix-artifacts-envelope.mjs:299` 保持一致（含 `schema_version` 或 `role`）。

**上限与超时**

```js
const MAX_PAYLOAD_FILES = 50;
const PAYLOAD_TIMEOUT_MS = 10_000;

const toCheck = candidates.slice(0, MAX_PAYLOAD_FILES);
if (candidates.length > MAX_PAYLOAD_FILES) {
  warnings.push(
    `WARN · 待检产物 ${candidates.length} 份，超过硬上限 ${MAX_PAYLOAD_FILES} 份——`
    + `**只检查了前 ${MAX_PAYLOAD_FILES} 份**（按文件名排序），`
    + `另外 ${candidates.length - MAX_PAYLOAD_FILES} 份本次**没有经过 check-payload**。\n`
    + `这是性能保护，不是通过：…`
  );
}
```

`files` 在 §3.7.2 里已经 `.sort()` 过，所以「前 50 份」是确定性的，
不会因为文件系统返回顺序不同而在两次运行里查不同的东西。

**逐份串行调用（按任务书的决定，不并发）**

```js
for (const { name, abs } of toCheck) {
  let json = null;
  let execErr = null;
  try {
    const out = execFileSync(process.execPath, [
      join(HERE, 'check-payload.mjs'),
      abs,
      '--role', 'fix',
      '--repo', repoDir,
      '--artifact-dir', inferred.dir,
      '--json',
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: PAYLOAD_TIMEOUT_MS,
    });
    json = JSON.parse(out);
  } catch (e) {
    // exit 1（不合规）也会走这里——stdout 里仍然是完整 JSON。
    try { json = JSON.parse(String(e.stdout ?? '')); } catch { json = null; }
    if (!json) execErr = e;
  }
  …
}
```

**`target_repo` 缺失 = 账本问题，不是降级**

```js
const rawRepo = state.target_repo;
const repoMissing = !(typeof rawRepo === 'string' && rawRepo.trim() !== '');
let repoDir = null;
let repoUsable = false;
if (!repoMissing) {
  repoDir = isAbsolute(rawRepo) ? rawRepo : resolve(dirname(resolve(statePath)), rawRepo);
  try { repoUsable = existsSync(repoDir) && statSync(repoDir).isDirectory(); } catch { repoUsable = false; }
}

if (repoMissing || !repoUsable) {
  problems.push(/* 账本问题，附补法 */);
} else {
  /* 逐份调用 */
}
```

这一条是本轮最重要的设计判断，理由见 §1.2。

**失败汇总：每条都能回答「哪份、哪个字段、错在哪」**

```js
for (const { name, errs } of failed.slice(0, 10)) {
  lines.push(`  ${name}：`);
  for (const e of errs.slice(0, 6)) {
    lines.push(`    - [${e.rule}] ${e.field}：${String(e.msg ?? '').split('\n')[0]}`);
  }
  if (errs.length > 6) lines.push(`    … 另有 ${errs.length - 6} 项`);
}
```

实际输出长这样（自证时的真实截取）：

```
1. 有 1 份修复产物**信封里的字段不合规**（产物目录 …\r17proof\art，共检查 1 份，合计 1 项违规）：
  done-1.md：
    - [red_log_not_found] payload.red_log_path：red_log_path 指向的文件不存在（试过：…
```

产物名 + `[rule]` + `field` + `msg` 四项齐全。任务书要求「不要只说 check-payload 失败」，
这里是四个维度都可定位。

**超时单独一条，且明确标注「不是违规判定」**

```js
const isTimeout = execErr?.code === 'ETIMEDOUT'
  || /timed? ?out/i.test(String(execErr?.message ?? ''));
if (isTimeout) {
  timedOut.push(name);
} else {
  warnings.push(`WARN · 产物 ${name} 的 check-payload 没能执行：…`);
}
```

超时进 `timedOut` 数组，最后汇总成一条 problems，措辞是
「**这不是「产物违规」的判定**——是检查没跑完」。把「超时」和「违规」混成一句话，
会让读的人去改产物内容，而真正该做的是查为什么这份产物这么大。

### 1.2 为什么 `target_repo` 缺失必须报错而不是降级

这是口子 3 的核心，值得单独说。

`check-payload.mjs` 的证据存在性检查（R11 加的）依赖「相对路径相对于谁」。
它的 `locateEvidence()` 在拿不到 `--repo` / `--artifact-dir` 时**不判 FAIL**，
而是降级成一条 `evidence_existence_unchecked` 的 WARN（`check-payload.mjs:300-315`）。
那段代码的注释写得很清楚：「不能因为一个『需要外部信息』的参数没传就把整条流程卡死」。

那个降级在**单独使用 check-payload 时**是对的。但一旦它被接进 stop-hook，
性质就变了：**降级 = 「检查没跑」，而「检查没跑」被记进了 exit 0。**
这与 R10 点名的「降级路径本身就是一条明面上的后门」、R13/R14 的口子 1
（「用一条 WARN 换掉闸门」）是同一类问题。

实测证据（见 §5.3）：同一份产物

```
node tools/check-payload.mjs <产物> --role fix --json          → exit 0，ok=true
node tools/check-payload.mjs <产物> --role fix --repo <真仓库> --json → exit 1，2 项 FAIL
```

**同一份产物、两种结论**，差别只在有没有传 `--repo`。所以接线时必须保证
`--repo` 一定有值；没有就报账本问题。

`check-state.mjs` 在 R16a 已经加了 `target_repo_required`（FIX + wave4/wave5 +
`fix_contracts` 非空 → 必须是非空且真实存在的目录）。但 stop-hook **不能依赖
check-state 先跑过**——它是 harness 强制的最后一道闸，必须自己判。两处判据一致
（非空字符串 **且** resolve 出来真是目录），是刻意的冗余：一个在派发前、一个在收盘前。

---

## 2. 性能实测

环境：Windows / Node v26.12.1 / `execFileSync` 启动 `node` 子进程。

| 产物数 | 改前（HEAD） | 改后（R17） | 增量 |
|---|---|---|---|
| 0（空目录走别的分支） | — | — | — |
| 10 | 1409 ms | 2319 ms | **+910 ms** |
| 20 | 1163 ms | 3701 ms | **+2538 ms** |
| 50 | 1063 ms | 9808 ms | **+8745 ms** |

（每组单次测量；改前那三行彼此差异是测量噪声，量级在 1.0~1.4 s。）

**诚实修正任务书的一个预期**：任务书写「串行几十毫秒一份」。实测是
**约 180~190 ms 一份**（10 份 +910ms、20 份 +2538ms、50 份 +8745ms，都指向 ~180ms/份）。
原因是 Windows 上 `node` 进程冷启动本身就要一两百毫秒，与产物大小无关——
我用的 fixture 每份只有一行信封。

这不改变结论（20 份 ~2.5 s 对一次相位收盘完全可以接受），但**「几十毫秒」这个数字
在 Windows 上不成立**，报告里不能照抄。若将来要优化，唯一的有效手段是
**把 N 次进程启动合并成 1 次**（让 check-payload 支持多文件参数），并发没有用——
瓶颈是进程创建而不是 CPU。

### 2.1 上限与超时是不是过度设计

不是。50 份 × 180 ms ≈ 9 s，已在实测里确认（上表 N=50 那一行）。
若某天 `report.dir_path` 误指到一个摊平了历史产物的大目录，
没有上限会挂到几百秒。上限 + WARN 的语义是「本次没答案」，不是「通过」。

超时 10 秒对每份不到 1 KB 的信封是极宽的额度，只有病态输入（例如把整个会话转录
塞进 `done-*.md`）才会触发。它的价值在于**把「挂死」变成「一条可读的 FAIL」**。

---

## 3. 新测试在改代码前的失败信息原文

先写测试，跑出 FAIL，再改实现。以下是改实现之前 `node tools/stop-hook.test.mjs` 的原始输出
（`case 32` 之后部分，逐字复制）：

```
case 32 (R17): 有信封但 schema_version 错 → exit 2，消息含 wrong_schema_version
  ✗ 退出码 2 — 实际 0：
  ✗ 报 wrong_schema_version
  ✗ 指名是哪份产物
  ✗ 指名是哪个字段
case 33 (R17): 所有字段完全合法 → exit 0（最重要：证明没有误伤）
  ✓ 退出码 0
  ✓ 没有 check-payload 类错误
case 34 (R17): red_log_path 指向不存在的文件 + target_repo 有效 → exit 2，含 red_log_not_found
  ✗ 退出码 2 — 实际 0：
  ✗ 报 red_log_not_found
  ✗ 指名是哪份产物
  ✓ 不降级成 evidence_existence_unchecked
case 35 (R17): target_repo 缺失 → exit 2，说明这是账本问题
  ✗ 退出码 2 — 实际 0：
  ✗ 说明缺的是账本字段
  ✗ 点明这是账本问题而不是打包/证据问题
  ✓ 不把产物判成不合规
case 36 (R17): 产物数 > 50 → 只查前 50 份并给 WARN（不阻断）
  ✓ 退出码 0（第 51 份没被检查）
  ✗ WARN 说明超过 50 只查了前 50
  ✗ WARN 提到被跳过的份数

=== 结果: 73 通过 / 12 失败 ===
```

`case 33` 在改前就是绿的，这是**正确的**——它的作用不是「证明新功能生效」，
而是「证明新功能不会误伤」。它在改前必然绿（那时压根没有第二道闸门），
改后仍然绿才说明接上之后正常产物没被拦。任务书说它「最重要」，我理解成
「它是回归保护，不是功能证明」，所以它的绿在两侧都成立。

12 条失败 = case 32/34/35 各 3~4 条 + case 36 的 2 条。全部由新代码转绿。

### 3.1 为了让原有 68 条继续全过，改了哪些 fixture

这是本轮最容易出问题的地方：**新闸门会真的去 `existsSync`**，所以旧的 fixture
（`{"schema_version":...,"role":"fix","payload":{"disposition":"FIXED"}}` 这种最小信封）
在新闸门下是**真的不合规**，会被拦。处理原则：**让 fixture 变成真正合法的产物，
而不是放宽新闸门**。

| 位置 | 改动 | 理由 |
|---|---|---|
| `writeValidFixArtifact` | `test_path`/`red_log_path` 改为相对 `FIXTURE_REPO` 的真实文件 | case 18/19/20 要测的是 §3.6 harness 对账，不能被 §3.7.5 抢先拦 |
| case 18/19/20 的 state | 加 `target_repo: FIXTURE_REPO` | 否则 exit 2 来自「账本缺 target_repo」，测的东西变了 |
| `GOOD_ENVELOPE` | 从 3 字段最小信封改为 `VALID_FIX_ENV()` 同构的完整合法信封 | case 22/24/28 断言「有信封 → exit 0」；最小信封在 check-payload 下会报 `missing_top_field`，case 的语义会从「测信封闸门」漂成「测第二道闸门」 |
| 文件顶部 | `mkdirSync` 提前到顶部 import | 原来在文件中部 import 一次，顶部也要用，ESM 会报 `Identifier 'mkdirSync' has already been declared` |
| `FIXTURE_REPO` | 放在文件**顶部**（不是 §3.7 段） | case 19/20 在 §3.7 段之前就要用；`const` 有 TDZ，定义在后面会运行时 ReferenceError |

新增测试 6 条（case 32~36 共 18 条断言）：

```
=== 结果: 86 通过 / 0 失败 ===   （原 68 + 新 18）
```

### 3.2 case 36（>50 上限）怎么测的

造了 51 份真实文件：`done-01.md` … `done-50.md` 全部合法，
`done-99.md` 故意 `schema_version: "BAD"`。因为 `files` 已按文件名排序，
`done-99.md` 排在第 51 位。断言 exit 0 + WARN 提到「只检查」和「50」。

这条同时证明了两件事：上限生效（第 51 份没被查），**且上限生效时不阻断**。
耗时约 21 s（50 次进程启动），可接受。

---

## 4. 自证（真实数据）

`target_repo` = `experiments/hilltop-dsh/repair-work/post-fix`（真实修复后源码）。
为让 `test_path` 可解析，临时在其中建了 `test/NodeListenerTest.java`，
自证结束后删除（`rm -rf`，已确认）。

### 4.1 会被拦的那种（`red_log_path` 指向已删除文件）

```
[red gone] EXIT=2

[交付粒度检查] 还不能结束这一回合：

1. 有 1 份修复产物**信封里的字段不合规**（产物目录 C:\Users\ADMINI~1\AppData\Local\Temp\r17proof\art，共检查 1 份，合计 1 项违规）：
  done-1.md：
    - [red_log_not_found] payload.red_log_path：red_log_path 指向的文件不存在（试过：`…\art\red\GONE.log` / `…\experiments\hilltop-dsh\repair-work\post-fix\red\GONE.log` / `…\red\GONE.log`）。路径形状对了不代表文件存在过——…
```

### 4.2 完全合法的（`NodeListener.java` 存在）

```
[valid] stop-hook EXIT=0
```

### 4.3 口子 4 的自证：`files_touched[0].path` 写假路径

```
[valid] src/main/java/com/hilltopvillage/mechanics/NodeListener.java → EXIT=0
[fake]  src/main/java/com/hilltopvillage/NOT_EXIST.java               → EXIT=0
```

**假路径没有被拦。** 先确认过规则存不存在：

```
$ grep -c "files_touched" tools/check-payload.mjs
2
$ grep -n "files_touched" tools/check-payload.mjs
97:// 背景（有实测证据）：fix 角色此前的全部契约只有 `files_touched`。
574:  fix: ['files_touched'],
```

两处命中：一处是注释，一处是 `ROLE_REQUIRED.fix` 的**必填键名列表**。
含义只有「`payload.files_touched` 这个键必须存在」——**它不检查值、不检查数组元素、
不检查 path 是否存在**。

所以任务书给的自证 B（「改成 `NOT_EXIST.java` → exit 2，如果是 `files_touched_not_found`；
先确认这个规则存在，如果不存在就跳过这个自证并说明」）：
**该规则不存在，已按指示跳过，并在 §6 说明。**

---

## 5. 验证

```
$ node tools/stop-hook.test.mjs
=== 结果: 86 通过 / 0 失败 ===

$ node tools/check-state.test.mjs
=== 结果: 61 通过 / 0 失败 ===

$ node tools/check-all.mjs
…（各测试段全部 0 失败）
──────────────────────────────────────────
✅ 全部通过
exit 0

$ node tools/fix-phase-e2e.test.mjs
=== 结果: 48 通过 / 0 失败 ===   ← 见 §5.2：本任务改到中途是 47/1，由同一工作区的另一个会话修好了 fixture
```

### 5.1 原 68 条回归

`stop-hook.test.mjs` 原有 68 条断言全部通过（改前 68/0，改后 86/0，新增 18 条断言）。

### 5.2 `fix-phase-e2e.test.mjs` 曾从 48/0 变成 47/1 —— 真阳性，已被另一会话修正

**先确认不是我的回归**：`git checkout -- tools/stop-hook.mjs tools/stop-hook.test.mjs`
回到 HEAD 后跑，是 `48 通过 / 0 失败`；改后是 `47 通过 / 1 失败`。所以是本轮改动引起的。

失败的是 B1：

```
✗ B1 [R1/stop-hook] exit 0（8 个实例 > 1，不再判串行） — 实际 exit 2；stderr=[交付粒度检查]…
1. 有 8 份修复产物**信封里的字段不合规**（产物目录 …\fix-out，共检查 8 份，合计 16 项违规）：
  fix-1.md：
    - [red_log_not_found] payload.red_log_path：red_log_path 指向的文件不存在（试过：…\fix-out\experiments\round1\red-…
```

**为什么说它是真阳性**：这个 e2e fixture 的场景 B 自称「红测日志放到 `experiments/` 下」
（`fix-phase-e2e.test.mjs:480` 的打印文字），并在 `:505` 把
`red_log_path` 写成 `experiments/round1/red-<id>.log`，
但**从头到尾没有任何一行代码把那些文件写出来**（`:504-507` 只 `writeFileSync` 了
8 份 `fix-*.md`；全文 `grep writeFileSync` 共 16 处，没有一处创建 `experiments/round1/`）。

也就是说：fixture 的**文字**声称证据存在，**文件系统**里不存在。这正是
`red_log_not_found` 要抓的形态（R11 的原话：
「路径形状对了不代表文件存在过」）。旧闸门看不见它，是因为
`:539` 调用 `check-payload` 时**没传 `--repo`**：

```js
const cp = runNode(CHECK_PAYLOAD, [goodFix, '--role', 'fix', '--json']);
```

没传 `--repo` → 降级成 `evidence_existence_unchecked` WARN → `ok=true` → B4 断言通过。
**B4 的绿是站在口子 3 上的。**

同理，`test_path: 'tools/red-green.test.mjs'` 在 `--repo` 下也解析不到
（`ls tools/red-green.test.mjs` → No such file），是第二条同类问题。

**结局**：`tools/fix-phase-e2e.test.mjs` 不在本次授权的两个文件里，我**没有改它**。
但在本任务执行期间（02:53），同一工作区里的**另一个会话**修改了它的 `:504-521`，
真的把 `experiments/round1/red-*.log` 与 `tools/red-green.test.mjs` 写了出来，
注释里明确写着「2026-11-15（R17）：日志文件必须真的建出来」。

现在：

```
$ node tools/fix-phase-e2e.test.mjs
=== 结果: 48 通过 / 0 失败 ===
```

**要注意这两个「R17」是两件事**：本次任务（本报告）与那个会话都把自己的改动标成 R17，
它们是同一轮的两个并行子任务。上面这段 diff 不是我写的；
`git diff tools/fix-phase-e2e.test.mjs` 可复核。

### 5.3 §1.2 引用的「同一份产物两种结论」

```
$ node tools/check-payload.mjs <产物> --role fix --json
exit=0          ← 没有 --repo，降级成 evidence_existence_unchecked WARN

$ node tools/check-payload.mjs <产物> --role fix --repo <真仓库> --artifact-dir <产物目录> --json
exit=1，errors: [red_log_not_found, test_path_not_found]
```

---

## 6. 诚实评估：R14 表里 6 个口子，还剩几个

| # | 口子 | R14 之后 | **R17 之后** | 依据 |
|---|---|---|---|---|
| 1 | 不写 `report.dir_path` / `final_report_path` → 目录推断不出 | ✅ R14 已拦 | ✅ **仍是拦的** | 本轮没动，仍被 §3.7.1 拦；且 R17 新增的 `target_repo` 判据与它同构 |
| 2 | 有信封但字段错（`schema_version` / `role` / `disposition` 非法） | ⚠️ 只拦 role/disposition | ✅ **堵上了** | case 32 证明 `wrong_schema_version` 现在 exit 2；任意其他 check-payload 规则同样生效 |
| 3 | `red_log_path` 指向已删除文件 | ⚠️ 不给 `--repo` 就降级 | ✅ **堵上了** | case 34 + §4.1 自证；关键是 `target_repo` 缺失时**不降级**（case 35） |
| 4 | 信封里 `files_touched` 写假路径 | ❌ 无任何检查 | ❌ **完全没变** | **`check-payload` 根本没有这条规则**，见 §4.3 |
| 5 | 把无信封产物移进 `legacy/` 子目录 | ⚠️ 一条 WARN | ⚠️ **完全没变**（且 R17 有一处轻微影响） | 子目录不进分母这件事没改。R17 只对 `files`（平铺产物）跑 check-payload，子目录里的产物**连第二道闸门也不会查**——见 §6.1 |
| 6 | `legacy_artifacts` 写到 6/15（真实形态） | ⚠️ 一条 WARN | ⚠️ **完全没变** | 分母口径未改 |

**结论：6 个里，R17 前是 1 个堵住（口子 1），现在是 3 个（1/2/3）。
另外 3 个（4/5/6）一字未动。**

### 6.1 口子 4 —— 本轮任务标题里点名的那个，为什么没堵上

**`check-payload.mjs` 没有 `files_touched_not_found` 这条规则，一条都没有。**
整个文件里 `files_touched` 只出现 2 次（注释 + `ROLE_REQUIRED.fix` 的键名表），
语义仅为「`payload.files_touched` 这个键必须存在」。

所以这不是「接线时漏了传参」，是**规则本身不存在**。接到 stop-hook 里也不会变出来。
`grep -c` / `grep -n` 的输出见 §4.3。

要堵口子 4，需要的是**另一个任务、改 `tools/check-payload.mjs`**：
对 `payload.files_touched[].path`（以及 `payload.dispositions[].files_touched[]`）
做 `locateEvidence()` 存在性检查。技术上现成——`locateEvidence` / `TRIED_MSG`
就在文件里，`EVIDENCE_ROOTS` 也已经从 `--repo` / `--artifact-dir` 建好。
难点不在实现，在**判据的严格度**：`files_touched` 里可能包含
「本轮删除的文件」（不存在是正确的）和「新创建的文件」。所以不能无条件
`existsSync` 判死，需要一个 `action: create|modify|delete` 之类的字段，
或者只在 `disposition === 'FIXED'` 且非删除动作时判。这是设计决断，不适合塞进本轮。

### 6.2 口子 5 —— 本轮让它的影响面略微扩大了一点

R14 的原状是「`legacy/` 子目录里的产物不进信封检查的分母，只有一条 WARN」。
R17 之后仍然是这样，而且**第二道闸门同样只看 `files`（平铺产物）**——
子目录里的产物连 check-payload 都不会跑。

也就是说：**把一份字段全错的产物移进 `legacy/`，两道闸门都不查它。**
这不比 R14 更糟（原状也是不查），但「两道闸门都不查」比「一道闸门不查」更值得写下来，
免得下一轮以为接上 check-payload 之后子目录也被覆盖了。唯一的痕迹仍是 §3.7.2 那条
`subdirectory_not_scanned` WARN。

### 6.3 口子 6 —— 未动，且本轮不该动

`legacy_artifacts` 写到 6/15 时只有一条「本轮没有任何修复产物经过信封检查」的 WARN。
这是 R13 对分母口径的刻意决定（产物目录里产物与流程文档平铺共存，
用产物数当分母会把真实历史目录判死）。本轮任务范围不包含重新设计分母，
我也没有更好的判据能同时满足「不误杀真实历史目录」和「不让豁免变成开关」，
所以原样保留。

### 6.4 本轮新引入的、需要下轮知道的

1. **`target_repo` 现在是硬前置。** 既有 wave4 账本若没有这个字段，
   stop-hook 会在有产物时报 exit 2。R16a 已让 check-state 报 `target_repo_required`，
   所以理论上没有「check-state 绿但 stop-hook 红」的账本；但如果有人的流程只跑
   stop-hook 不跑 check-state，会直接撞上。这是**有意的严格**（理由见 §1.2），
   但它是行为变更，值得记一笔。
2. **`target_repo` 现在是硬前置。** 既有 wave4 账本若没有这个字段，
   stop-hook 会在有产物时报 exit 2。R16a 已让 check-state 报 `target_repo_required`，
   所以理论上没有「check-state 绿但 stop-hook 红」的账本；但如果有人的流程只跑
   stop-hook 不跑 check-state，会直接撞上。这是**有意的严格**（理由见 §1.2），
   但它是行为变更，值得记一笔。
3. 性能：Windows 上约 180 ms/份，20 份约占 2.5 s。若某轮产物数常态超过 20，
   值得考虑让 check-payload 支持多文件（一次进程启动），但那是下一轮的事。
4. **同一工作区有并行会话在改同一批文件。** 本任务执行期间，`tools/fix-phase-e2e.test.mjs`
   被另一个会话改了（02:53），`experiments/hilltop-dsh/FIX-R16a-report.md` 也是之前
   另一个会话改的（02:16）。两个会话都把自己的改动标成「R17」。
   `git status` 里看到的 `M tools/fix-phase-e2e.test.mjs` **不是本任务改的**。

---

## 7. 改动清单

| 文件 | 改动 |
|---|---|
| `tools/stop-hook.mjs` | 新增 §3.7.5（约 130 行含注释）：`hasEnvelope` 探测、50 份上限 + WARN、10 s 单份超时、`target_repo` 硬判据、逐份串行 `check-payload --role fix`、四条汇总（字段不合规 / 超时 / 执行失败 / `evidence_existence_unchecked` 透传）。`isAbsolute` 加入 `node:path` import。 |
| `tools/stop-hook.test.mjs` | 新增 case 32~36（18 条断言）+ `FIXTURE_REPO` fixture；`writeValidFixArtifact` 与 `GOOD_ENVELOPE` 升级为完整合法信封；case 18/19/20 补 `target_repo`；`mkdirSync` 提到顶部 import。 |

### 7.1 关于 commit

**本任务没有执行 `git add` / `git commit`。**

但工作区里出现了提交 `24ab2d3 feat(R17): check-payload 接进 stop-hook —— 口子 2/3 堵上`，
它把我改的两个文件、我的报告、以及那个并行会话对 `tools/fix-phase-e2e.test.mjs` 的修复
**一起**提交了。那是同一工作区里另一个会话做的（与我 R16a §4 记录的情况同构）。

可复核：(本任务结束时)

```
$ git diff --stat tools/stop-hook.mjs tools/stop-hook.test.mjs
（空 —— 说明提交内容与我留下的内容逐字一致）
```

同一时刻 `git status` 里还有另一个会话的痕迹（`D FIX-R1-R13-SUMMARY.md` /
`?? FIX-R1-R18-SUMMARY.md` 的重命名），也**不是本任务**做的。
