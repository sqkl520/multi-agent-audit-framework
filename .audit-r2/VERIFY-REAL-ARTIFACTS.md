# 验证报告：拿真实审计产物实跑框架的全部机械检查

**日期**：2026-11-20
**验证对象**：`multi-agent-audit-framework` 对 Hilltop Village 的 2026-11-19 完整审计
**真实产物**：`.run-hv/`（10 份 findings / 45 条发现、41 份 critiques、13 条 deep、5 份报告 MD）
**被审仓库**：`D:/Server/MCServers/Server plugin/Hilltop Village/Hilltop Village Plugin`
**报告自述基线**：`12f62da`（2026-11-17）—— **实测发现这个基线不足以定位被审对象，见 §2.2**
**框架 HEAD**：`16c2dee`（2026-11-20 02:17）

---

## 0. 一句话结论

**这套框架在这一次真实审计上，机械验证了什么也没验证——用真实产物原样跑，验证率是 0/45。把产物事后改写成契约形态再跑，门 0 能到 40/45 命中，但这既不是当时发生的，也无法给出确定判罚，因为审计对象根本没有可复现的快照。**

具体地：

- 原样跑 `verify-artifacts.mjs --artifacts .run-hv` → **扫描 5 个文件、0 个信封、6 FAIL / 6 SKIP**。门 0 的 `evidence.quote` 一条都没核对过。
- 原样跑 `check-payload.mjs` 对 10 份 findings → **10/10 全部 `no_json_envelope` 失败**，契约的任何字段规则（finding_id / evidence 形状 / status / self_checks / CRITICAL 准入门槛）**一条都没执行**。
- 我把 45 条发现按契约形态包装后重跑（这是在"翻译"产物，不是当时发生的）→ 门 0 **40/45 通过**（对 `31a7f35`）/ **32/45 通过**（对自述基线 `12f62da`）。**即使用框架自己的工具、最好的树，也仍有 5 条不过。**
- 更根本的问题：**报告自述的基线 `12f62da` 定位不到被审对象**。同一批 finding 分别匹配不同 commit（`slices.json` 的行数指纹指向上千行之外的 `31a7f35`），说明审计跑在一个从未被提交的脏工作区上。门 0 需要一个被冻结的被审对象，而框架没有"审计快照"这个概念。

**没有任何一次自动化检查在审计当时跑过。** 45 条发现、41 条裁决、13 条深挖，全部是 LLM 之间互检的产物；仓库里不存在任何 `.json` 形态产物能被现有工具读到。

---

## 1. 任务一：10 份 findings 喂给 `check-payload.mjs` 的结果

### 1.1 逐份结果

命令（对 10 份逐一跑，`--repo` 与 `--artifact-dir` 都给全）：

```bash
node tools/check-payload.mjs .run-hv/findings/S01.json \
  --role audit --repo "D:/Server/MCServers/.../Hilltop Village Plugin" --artifact-dir .run-hv
```

| 产物 | 退出码 | 违规规则 | 违规数 |
|---|---|---|---|
| S01.json | 1 | `no_json_envelope` | 1 |
| S02.json | 1 | `no_json_envelope` | 1 |
| S03.json | 1 | `no_json_envelope` | 1 |
| S04.json | 1 | `no_json_envelope` | 1 |
| S05.json | 1 | `no_json_envelope` | 1 |
| S06.json | 1 | `no_json_envelope` | 1 |
| S07.json | 1 | `no_json_envelope` | 1 |
| S08.json | 1 | `no_json_envelope` | 1 |
| S09.json | 1 | `no_json_envelope` | 1 |
| S10.json | 1 | `no_json_envelope` | 1 |

**10/10 失败，且失败点完全相同——第 1 条规则（"必须有一个可解析的 JSON 信封"）就短路了，后面的 20+ 条字段规则一条都没跑到。**

原文（`--json` 输出）：

```json
{
  "file": ".run-hv/findings/S01.json",
  "ok": false,
  "role": null,
  "errors": [{
    "field": "(root)",
    "rule": "no_json_envelope",
    "msg": "产物里没有 ```json 代码块。契约要求返回必须包在 JSON 信封里。",
    "fix": "在产物文件末尾追加一个 ```json 块，内容见 components/output-contract.md §1"
  }]
}
```

注意 `"role": null`——因为信封不存在，`--role audit` 这个参数**连被比对的机会都没有**。

### 1.2 这是"产物不合规"还是"契约与实际形态不符"？

**是后者，而且是可以举证的结构性错配，不是 agent 偷懒。**

证据链：

**(a) 契约要求的物理形态是"Markdown 正文 + 末尾 json 代码块"**

`framework/components/output-contract.md` §0：

> **你的产物文件必须以一个 json 代码块结尾，里面是本契约定义的信封。**
>
> ```
> <产物文件>
> ├── Markdown 正文（随便写：分析、grep 输出、判断依据、表格）
> └── 最后一个代码块：完整的 JSON 信封
> ```

`tools/check-payload.mjs` 的实现是正则抓围栏：

```js
const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)];
if (blocks.length === 0) { errors.push({ rule: 'no_json_envelope', ... }); }
```

**(b) 但实际产出的 10 份 findings 是纯 JSON 文件，字段是自定义的**

```json
{ "slice_id": "S01", "auditor": "wave2", "files_read": [...], "findings": [...], "unverified": [...], "notes": "..." }
```

finding 条目字段：`slice_id, local_id, title, severity, file, line, line_end, evidence, problem, impact, trigger`（10 个字段，全部扁平）。

**(c) 这两者之间的差距，不只是"加一个围栏"，而是整套字段都要改写**

我做了第二个探针（`.probe-verify/wrap-literal.mjs`）：把真实 finding 对象**原样**塞进合法信封，一个字段都不改，加一个正确的 ```json 围栏，再跑 `check-payload.mjs --role audit`：

| 产物 | 错误数 | 违规规则分布 |
|---|---|---|
| S01 | 13 | `missing_role_field`×1, `invalid_enum_value`×3, `missing_finding_status`×3, `missing_finding_id`×3, `evidence_wrong_shape`×3 |
| S02 | 21 | 同上比例（5 条 finding） |
| S03 | 25 | 同上比例（6 条 finding） |
| S04 | 13 | |
| S05 | 25 | |
| S06 | 17 | |
| S07 | 21 | |
| S08 | 17 | |
| S09 | 17 | |
| S10 | 21 | |

**每一条 finding 有 4 项必填字段缺失或形状错误：**

| 真实字段 | 契约要求 | 违规规则 |
|---|---|---|
| `local_id` | `finding_id` | `missing_finding_id` |
| `evidence`（**字符串**） | `evidence: {file, line, quote}`（**对象**） | `evidence_wrong_shape` |
| `severity: "high"`（小写） | `"HIGH"`（大写闭集） | `invalid_enum_value` |
| 无 `status` | `CONFIRMED` 等 5 值之一 | `missing_finding_status` |
| 无 `dimension` | 6 值闭集 | `missing_role_field` / enum |
| 无 `inference` | `{claim, basis, alternatives}` | 未报（因 status 缺失先短路） |
| 无 `self_checks` | 3 项必做 | `missing_role_field` |

**(d) 结论：这是契约与框架自身产出形态的错配，三种症状指向同一个根因**

1. **框架自己的命名规范要求 `.md`**：`framework/artifacts/report-naming.md` §1 写死正则 `^round(\d+)-(01-recon|...)-[a-z0-9]+(-[a-z0-9]+)*\.md$`，`.json` 根本不在合法命名里。
2. **框架自己的校验器只扫 `.md`**：`verify-artifacts.mjs:1001` 是 `else if (e.name.endsWith('.md'))`。`.json` 文件连被读取的机会都没有。
3. **但这次运行实际产出的是 `.json`**：`.run-hv/findings/*.json`、`critiques/*.json`、`deep/*.json`，一个 `.md` 都没有。

也就是说：**这次审计用了框架文档里不存在的一种产物形态，而框架没有任何一处代码或文档支持它。** 这不是"agent 没遵守契约"——是执行层（dsh 多 agent 编排）自己发明了一套产物格式，而框架的机械检查链完全落在另一套格式上。

**责任归属**：不能简单归给子 agent。契约要求"最后一段写 json 代码块"，但 dsh 的实际做法是"直接写一个 .json 文件"。这两种都叫"JSON"，但校验器只认前一种。缺少的是**契约与执行层之间的一层约定**（例如"若产物本身就是 .json，校验器应直接把它当信封解析"），而 `framework/` 目录里搜不到任何一处提到 `.run-hv`、`findings/`、`critiques/`、`deep/`。

### 1.3 我为了让门 0 能跑，不得不做的改写（这就是"契约翻译成本"）

`.probe-verify/wrap.mjs` 把每条 finding 映射成契约形态：`local_id→finding_id`、`severity.toUpperCase()`、`evidence` 字符串拆成 `{file,line,quote}`、补 `status:CONFIRMED`、补 `dimension`、`problem→inference.claim`、补 `self_checks`。

**改写后 10/10 全部 `check-payload.mjs` 通过（`ok=true, errs=0`）**——说明这些发现**内容上**是符合契约语义的，只是物理封装不对。这一条很重要：它把问题从"内容不合规"降级为"封装不合规"。

---

## 2. 任务二：门 0 到底能不能验？

### 2.1 用现成工具能不能验？

**不能，对真实产物一次都跑不了。**

```bash
node tools/verify-artifacts.mjs --repo "..." --artifacts .run-hv
```

输出：

```
扫描产物: 5 个文件，解析出 0 个信封
✗ FAIL  [G7] 产物没有 JSON 信封: AUDIT-REPORT.md
✗ FAIL  [G7] 产物没有 JSON 信封: DEEP-REPORT.md
✗ FAIL  [G7] 产物没有 JSON 信封: P1-FIX-PLAN.md
✗ FAIL  [G7] 产物没有 JSON 信封: TASK3.md
✗ FAIL  [G7] 产物没有 JSON 信封: UNFIXED.md
✗ FAIL  [G0] 产物目录里一份可用产物都没有（扫描 5 个文件，0 个 JSON 信封，0 条降级线索）
- SKIP  [G0] 产物中没有任何需要门 0 校验的 evidence，跳过
- SKIP  [G1] 没有 files_read 字段，跳过
- SKIP  [G2] 没有 status=SUCCESS 的信封，跳过
- SKIP  [G8] 没有可对账的 line_count，跳过
- SKIP  [G5] 没有可校验的自述数字，跳过
- SKIP  [G4] 找不到 state.json，跳过账本对账
合计: 6 FAIL / 0 WARN / 0 PASS / 6 SKIP
```

扫描的 5 个文件全是 `.md`（顶层 5 个报告），`.json` 目录（findings/critiques/deep）**一个都没进扫描**。所以：

- **45 条 finding 的 `evidence.quote`：0 条被核对过。**
- **`--legacy-salvage` 也救不了**：实测加了该参数，输出仍是"扫描 5 个文件，0 个信封，0 条降级线索"——因为 salvage 只能从 `.md` 散文里抽线索，`.json` 文件根本不在 `readdirSync` 的 `.md` 分支里。
- 直接指向 `--artifacts .run-hv/findings` 更差：`扫描产物: 0 个文件`。

### 2.2 我自己写脚本验，能验出什么

我写了 `.probe-verify/gate0-unbounded.mjs`，**复刻 `verify-artifacts.mjs` 的 `checkGate0()` 语义**（quote ≥12 字符、exact/loose 两级、`line_end` 不参与），但把"向前 15 行窗口"放开为全文件搜索，以便区分"引错行"与"整文件都找不到"。

**这里遇到了本次验证最重要的障碍：审计没有可复现的代码快照。**

报告自述基线是 `12f62da`，但被审仓库在审计之后有 8 个提交（2026-11-19 21:37 ～ 2026-11-20 01:21）。我把多个 commit 都抽出来逐一核对（`git show <rev>:<file>`，不动工作区），结果**不一致到无法用"基线 + 少量漂移"解释**：

| Commit | 日期 | quote 在声称行命中 | 在该文件其它行命中 | 全文件找不到 |
|---|---|---|---|---|
| `12f62da`（**报告自述基线**） | 11-17 | 32 | 9 | 4 |
| `2abd942` | 11-19 21:37 | 28 | 12 | 5 |
| **`31a7f35`** | **11-19 21:49** | **40** | **4** | **1** |
| `5c7f58f` | 11-19 21:49 | 40 | 4 | 1 |
| `68d6561` | 11-20 00:16 | 37 | 6 | 2 |
| `5ed2f3a` | 11-20 00:25 | 36 | 7 | 2 |
| `a68f263` | 11-20 00:33 | 34 | 8 | 3 |
| `06688b0` / `e223e20`（HEAD） | 11-20 01:20+ | 26 | 13 | 6 |

**证据最吻合的不是自述基线，而是 `31a7f35`（40/45 vs 32/45）。**

再看 `slices.json` 的行数自述（`approx_lines`），与各 commit 的实际行数比：

| Commit | 10 个切片中 `approx_lines` 精确命中的个数 | 各切片偏差绝对值之和 |
|---|---|---|
| `12f62da`（自述基线） | **1 / 10** | **744** |
| `2abd942` | 1 / 10 | 641 |
| **`31a7f35`** | **6 / 10** | **93** |

**`slices.json` 的行数与 `31a7f35` 的吻合度比自述基线高一个数量级。** 例如 S08 的 `approx_lines=1606`，在 `31a7f35` 恰好是 1606，在 `12f62da` 是 1591。

#### 结果：按 `31a7f35` 核对（证据最吻合的那棵树）

**这条结论是用框架自己的工具跑出来的，不是我的脚本算的：**

```bash
# 把 31a7f35 抽成只读副本（不动被审仓库）
git -C "D:/Server/.../Hilltop Village Plugin" archive 31a7f35 | tar -x -C .probe-verify/baseline-31
# 用真实产物（契约化包装后）跑框架自己的门 0
node tools/verify-artifacts.mjs --repo .probe-verify/baseline-31 --artifacts .probe-verify/wrapped
# → ✗ FAIL  [G0] 门 0 回显: 40/45 通过，5 条 evidence 缺 file 或 quote（等于没有证据）
```

同样一条命令换成 `12f62da` 作 `--repo`：

```
✗ FAIL  [G0] 门 0 回显: 32/45 通过，13 条 evidence 缺 file 或 quote（等于没有证据）
```

**同一批产物、同一个校验器，只换被审树：40/45 vs 32/45。**

**口径注意**：下表把"去掉空白后能对上"也算作命中的宽松口径，与工具一致（工具对 `loose` 判 WARN 但仍计入 `ok`，把 `WRONG_LINE` 判 FAIL）。

| 结论 | 条数 | 说明 |
|---|---|---|
| `EXACT_AT_CLAIMED` | **32** | quote 逐字在声称行 |
| `REFORMATTED_AT_CLAIMED` | 8 | 内容对，但缩进/换行被改写过（`verify-artifacts` 判 WARN，算通过） |
| `WRONG_LINE` | 4 | quote 在该文件真实存在，但**不在声称行**（偏移 +20 ~ +32） |
| `FABRICATED`（全文件找不到） | **1** | S03-F3 |
| **合计** | **45** |
| **"proof 存在"小计**（能在这份文件里找到这段原文） | **44 / 45** | |
| **"位置正确"小计**（在声称行 ± 空白容差内） | **40 / 45** | |

#### 结果：按报告自述基线 `12f62da` 核对

| 结论 | 条数 |
|---|---|
| `EXACT_AT_CLAIMED` / `REFORMATTED_AT_CLAIMED`（位置正确） | **32** |
| `WRONG_LINE`（真实存在，行号不对；其中 2 条声称行还越界） | **9** |
| `FABRICATED`（全文件找不到） | **4**（S03-F1、S03-F4、S09-F1、S09-F2） |
| **合计** | **45** |
| **"proof 存在"小计** | **41 / 45** |
| **"位置正确"小计** | **32 / 45** |

`12f62da` 下的 9 条引错行：S01-F3（766→758）、S05-F2（193→182）、S05-F3（312→300）、S06-F1（265→248，且越界）、S07-F1（825→748）、S08-F1（491→476）、S08-F3（417→402）、S08-F4（225→222）、S10-F5（159→129）。

### 2.3 那 13 条不过的，是伪造还是行号偏移？

**先说结论：几乎没有伪造。按 `31a7f35`（证据最吻合的树）核，45 条里 44 条能在那份文件里找到原文，只有 1 条全文件找不到；其中 40 条位置也对（含空白容差）。按自述基线 `12f62da` 核，41 条能找到、32 条位置对。**

**换句话说：这批产物的 quote 绝大多数是真的，问题在"引在哪一行"和"引的是哪个版本的代码"，不在"编造"。**

#### 真·错行（`31a7f35` 下 4 条）

| ID | 声称行 | 实际行 | 偏移 |
|---|---|---|---|
| S03-F1 | `ConfigManager.java:1391` | 1423 | +32 |
| S05-F1 | `AdminDeployManager.java:656` | 679 | +23 |
| S05-F6 | `AdminDeployManager.java:530` | 550 | +20 |
| S10-F1 | `YamlFiles.java:226` | 252 | +26 |

**这 4 条不是伪造**：quote 逐字存在于所声称的文件。门 0 的设计明确要拦"引错行"（`GATE0-PROBE.md` 手法 03/04），所以判 FAIL 符合设计——但性质是**行号偏移**，不是编造。

#### 真·格式偏差（8 条，`reformatted_at_claimed`）

S02-F1、S03-F2、S03-F4、S03-F5、S03-F6、S05-F2、S05-F3、S05-F4 —— 行号对，但 quote 的缩进/换行与源文件不一致（agent 抄写时把多行合并或压平了空白）。门 0 判 WARN（`quote 在 loose 级别匹配`），不判 FAIL，符合工具设计。

#### 全文件找不到（`31a7f35` 下仅 1 条）

| ID | 声称位置 | 现象 |
|---|---|---|
| **S03-F3** | `ConfigManager.java:147-149` | quote 是 `if (!settingsFile.exists()) { plugin.saveResource("game-settings.yml", false); }`。**这段在 `12f62da` 里逐字存在（第 147 行），但在 `31a7f35` 里已被 P1 修复改写成带 `isQuarantined(...)` 判断的新版本** |

**而它在 `12f62da` 上是精确命中的。** 这恰好是反证：**这批产物的不同条目分别指向不同的代码状态**——S03-F3 指向修复前，S03-F1/S03-F4/S09-F1/S09-F2 指向修复后。

#### 交叉例证：三条 quote 只存在于"修复后"的提交里

| ID | `12f62da` | `31a7f35` | 引入该文本的提交 |
|---|---|---|---|
| S03-F1（`return false;` 版本） | 不存在（该函数返回 `void`） | 存在 | `31a7f35` |
| S03-F4（`boolean reloaded = ...`） | 不存在 | 存在（第 148 行精确） | `31a7f35` |
| S09-F1（`throw new IllegalStateException("Cannot use shop.yml ...`） | 不存在（该文件**无任何 ISE**） | 存在（第 110 行精确） | `31a7f35` |

`git log -S` 三条全部指向同一个提交：

```
31a7f35 2026-11-19 21:49:01 +0800 fix: 7 条 shop/config 缺陷修复 + 独立评审后的返工
```

**而 `findings/*.json` 的文件 mtime 是 2026-11-19 03:34–04:28，比这个提交早约 17 小时。**

#### 这三种事实合在一起，只支持一个结论

产物引用的代码状态，**既不是报告的基线 `12f62da`，也不是任何一个单一 commit**——它更像是一个**跨多个 commit 的混合体**：多数条目对应 `31a7f35` 附近的代码，个别条目（S03-F3）对应修复前，还有条目（S06-F1、S09-F2 的行号）只在更晚的 HEAD 上才落得进文件。

最省事的解释是：**审计是在一个"边审边改"的脏工作区上做的**。`P1-FIX-PLAN.md` 自己也写着"目标仓库工作区里还混着前几轮未提交的改动"。修复代码在审计期间就存在于工作区（后来才提交为 `2abd942`/`31a7f35`），所以一部分 finding 引到了修复后的代码，另一部分引到了修复前的代码；行号则随工作区演进而漂移。

**无论具体成因如何，可机械证实的结论是：报告的"基线提交 12f62da"是错的，或者至少不足以定位被审对象。框架里没有任何"审计快照"机制，所以门 0 的判据——"quote 必须逐字来自被审对象"——在这次审计上没有可判定的基准。**

#### 全文件找不到（1 条，`31a7f35` 下）

| ID | 声称位置 | 判定 | 说明 |
|---|---|---|---|
| **S03-F3** | `ConfigManager.java:147-149` | 在 `31a7f35`/HEAD 全文件找不到，但在 `12f62da` 第 147 行**逐字存在** | P1 修复把这个分支改写成了带 `isQuarantined(...)` 的版本 |

#### 三条只有"修复后"才存在的 quote（这是"基线不可复现"的硬证据）

| ID | `12f62da`（自述基线） | `31a7f35`（修复提交） | 引入提交 |
|---|---|---|---|
| S03-F1（`return false;` 版本） | 不存在（该函数当时返回 `void`） | 在该文件第 1423 行 | `31a7f35` |
| S03-F4（`boolean reloaded = ...`） | 不存在 | 第 148 行精确 | `31a7f35` |
| S09-F1（`throw new IllegalStateException("Cannot use shop.yml ...`） | 不存在（该文件当时**无任何 ISE**） | 第 110 行精确 | `31a7f35` |

`git log -S` 三条全部指向同一个提交：

```
31a7f35 2026-11-19 21:49:01 +0800 fix: 7 条 shop/config 缺陷修复 + 独立评审后的返工
```

**而 `findings/*.json` 的 mtime 是 2026-11-19 03:34–04:28，比这个提交早约 17 小时。**

#### 时间线

| 时间 | 事件 |
|---|---|
| 2026-11-19 03:03 | `slices.json` 写入 |
| 2026-11-19 03:34–04:28 | 10 份 `findings/*.json` 写入（mtime） |
| 2026-11-19 04:01–05:36 | 41 份 `critiques/*.json` 写入 |
| 2026-11-19 17:44 | `AUDIT-REPORT.md` 写入 |
| 2026-11-19 18:58–19:20 | `deep/*.json`、`DEEP-REPORT.md` 写入 |
| **2026-11-19 21:37–21:49** | **被审仓库提交 `2abd942`、`31a7f35`** |

#### 唯一站得住的解释

**审计是在一个"边审边改"的脏工作区上做的，且报告事后把基线错标成了 `12f62da`。**

支撑：

1. `P1-FIX-PLAN.md` 自己写着"目标仓库工作区里还混着前几轮未提交的改动"。
2. 修复代码在审计期间已存在于工作区，所以一部分 finding 引到了修复后的代码（S03-F1/F4、S09-F1/F2），一部分引到了修复前（S03-F3）。
3. `slices.json` 的行数与 `31a7f35` 吻合度（6/10 精确、偏差 93）远高于 `12f62da`（1/10、744）——**行数是通过读文件得来的，这个指纹比任何自述都硬**。
4. 没有任何单一 commit 能让 45 条全部命中（最高 `31a7f35` 的 40 条），因为工作区状态从未被提交。

**结论：门 0 在这次审计上缺少可判定的基准。** "quote 必须逐字来自被审对象"这条规则，需要一个被冻结、可重放的被审对象；而框架里没有"审计快照"这个概念——`slices.json` 记了切片的 `approx_lines`，但没有记对应 commit，也没有存快照。

#### 行号越界（`12f62da` 下 2 条，`31a7f35` 下 0 条）

| ID | 声称行 | 文件总行数（`12f62da`） | 在 `31a7f35` |
|---|---|---|---|
| S06-F1 | `AirdropSpawnGoal.java:265` | 252 | 精确命中 |
| S09-F2 | `ShopConfigLoader.java:289` | 198 | 精确命中 |

这两条是"基线不是 12f62da"的直接反证：只有文件变长之后，声称行才落得进去。

### 2.4 门 0 小结

| 指标 | `31a7f35`（最吻合） | `12f62da`（自述基线） |
|---|---|---|
| 真实产物原样跑，被核对的 evidence | **0 / 45** | **0 / 45** |
| 改写为契约形态后，`verify-artifacts` 实际核对 | 45 / 45 | 45 / 45 |
| **quote 能在所声称文件里找到** | **44 / 45** | 41 / 45 |
| **quote 在声称行（含空白容差）** | **40 / 45** | 32 / 45 |
| 精确逐字在声称行 | 32 | 24 |
| 引错行（真实存在但行号不对） | 4 | 9 |
| 全文件找不到 | 1（S03-F3） | 4 |
| 声称行越界 | 0 | 2 |
| 能被判定为**编造证据**的 | **0 条有确证** | **0 条有确证** |

**门 0 这个检查本身是有效的、能跑的、能抓出真问题（引错行、拿注释当证据、quote 过短）。但它对这次审计的覆盖面是 0%（产物形态不匹配），而且即使绕过形态问题，它也无法给出确定判罚——因为没有可复现的被审对象。这是我这份报告里最重要的两条结论。**

---

## 3. 任务三：41 份裁决 vs 45 条 finding 的对应关系

命令：读 41 份 `critiques/*.json` 的 `finding_id`，与 10 份 findings 的 `local_id` 做集合比对。

### 3.1 结论

| 检查项 | 结果 |
|---|---|
| critique 总数 | 41 |
| finding 总数 | 45 |
| **裁决指向不存在的 finding** | **0 条** |
| **未被裁决的 finding** | **4 条** |
| finding_id 重复 | 0 |
| 裁决 verdict 分布 | `confirmed` 13 / `downgraded` 22 / `revoked` 6 = 41 |

### 3.2 4 条未被裁决的 finding

| ID | 原 severity | 标题 |
|---|---|---|
| **S05-F4** | medium | Core coordinates are read without an isSet guard... |
| **S07-F4** | low | ItemsAdder reflection swallows the root cause... |
| **S07-F5** | low | Preview villagers whose chunk unloaded are dropped... |
| **S10-F5** | low | Generated commands.md still documents /hilltop help as admin |

这 4 条在 `AUDIT-REPORT.md` 的"降级表"（第三节）里**有行，但"锐评理由"列是空的**：

```
| S05-F4 | medium → medium | `AdminDeployManager.java:278` |  |
| S07-F4 | low → low | `HammerListener.java:149` |  |
| S07-F5 | low → low | `VillagerPreviewManager.java:127` |  |
| S10-F5 | low → low | `CommandsDocumentGenerator.java:159` |  |
```

**报告在第五节"未闭合项"里诚实披露了这件事**：

> **锐评未完成全部**：41 / 45 条走完了锐评，其余按「未锐评」计入降级表。
> 原因：dsh 主进程在最后一批锐评期间被手动终止（已运行约 2 小时）。

**这是本次审计里框架最健康的一处**：LLM 没有假装 45 条都评完了，而是把"没评完"写进了未闭合项，并且把 4 条原样保留在表里（理由列留空），没有伪造理由。

### 3.3 但这里有一个数字口径问题

同一件事，三份报告的写法不同：

| 报告 | 写法 |
|---|---|
| `AUDIT-REPORT.md` | 锐评后**降级 26**（= 22 真降级 + 4 未锐评） |
| `UNFIXED.md` | 独立锐评后**降级 22**（= 只算真锐评过的） |
| `critiques/*.json` 实际 | `downgraded` **22** |

**AUDIT-REPORT 的 26 把 4 条"未评"混进了"降级"**，而 `UNFIXED.md`（更晚生成，23:30 vs 17:44）已经修正为 22。两份交付物对同一事实给出两个数字，且**没有任何机械检查会发现这一点**——因为 `verify-artifacts.mjs` 的 G5（自述数字自洽）在 `.json` 产物上根本没跑。

### 3.4 裁决能否对上"降级后的严重性"

我逐条比对了报告降级表的 `原 → 新` 与 critique 文件的 `adjusted_severity`：

```
downgrade rows: 26
severity mismatches vs critique: 0
```

**26 行里 22 行有 critique 可对，全部一致，0 处不符。** 这是这次审计做得最扎实的一块——裁决的内部一致性经得起核对。

---

## 4. 任务四：报告里的数字能否与 findings 实际统计对上

### 4.1 逐项核对表

| 报告声称 | 出处 | 实际统计 | 结论 |
|---|---|---|---|
| 切片数 **10** | AUDIT-REPORT §1 | `slices.json`: `slice_count: 10`，10 个 S01–S10 | ✅ 对 |
| 覆盖 **75/75 文件** | AUDIT-REPORT §1 | `git ls-tree 12f62da src/main/java` = **75** 个 `.java`；slices 清单 75 条、去重 75、0 重复、0 遗漏 | ✅ 对 |
| 规模 **34,193 行** | AUDIT-REPORT 头部 | `12f62da` = 33,461；**`31a7f35` = 34,296** | ❌ 差 732（对自述基线）／差 103（对 `31a7f35`） |
| 规模 **34,205 行** | `slices.json.unverified` | 同上 | ⚠️ 与 34,193 不一致；对 `31a7f35` 只差 91 |
| 一轮发现 **45** | AUDIT-REPORT §1 | findings 10 份合计 **45** | ✅ 对 |
| 独立锐评 **41** | AUDIT-REPORT §1 | `critiques/` **41 份** | ✅ 对 |
| 锐评后确认 **13** | AUDIT-REPORT §1 | `verdict=confirmed` **13** | ✅ 对 |
| 锐评后降级 **26** | AUDIT-REPORT §1 | `verdict=downgraded` **22** + 未锐评 4 | ⚠️ 混算，见 §3.3 |
| 锐评后降级 **22** | UNFIXED.md | `verdict=downgraded` **22** | ✅ 对 |
| 锐评后撤销 **6** | AUDIT-REPORT §1 | `verdict=revoked` **6** | ✅ 对 |
| 撤销率 **13%** | AUDIT-REPORT §1 | 6/45 = **13.3%** | ✅ 对 |
| 降级率 **58%** | AUDIT-REPORT §1 | 26/45 = 57.8%（按报告口径）；22/45 = 48.9%（按 critique） | ⚠️ 口径依赖 |
| 深挖 **13 条** | DEEP-REPORT | `deep/` **13 份**，且 13 个 ID **完全等于** critique 的 13 条 confirmed | ✅ 对（这个对得很漂亮） |
| 深挖 REACHABLE **13 / REJECT 0** | DEEP-REPORT §0 | 13 份全部 `REACHABLE` | ✅ 对 |
| 深挖 final_severity **0 high / 3 medium / 10 low** | DEEP-REPORT §0 | 实测 **0 high / 3 medium / 10 low** | ✅ 对 |
| UNFIXED "已修复 3（P1 根因族）" | UNFIXED | P1-FIX-PLAN 声明改 5 文件、944 测试通过 | ⚠️ 无法机械核实（需跑测试） |

### 4.2 三处真实问题

**(1) 行数 34,193 / 34,205 都对不上自述基线 `12f62da`（33,461）——但它们对得上 `31a7f35`**

```
$ git show 12f62da:... | wc -l    →  33,461
$ git show 31a7f35:... | wc -l    →  34,296
```

| Commit | 实际行数 | 与 34,193 之差 | 与 34,205 之差 |
|---|---|---|---|
| `12f62da`（自述基线） | 33,461 | 732 | 744 |
| `2abd942` | 33,564 | 629 | 641 |
| **`31a7f35`** | **34,296** | **103** | **91** |
| `HEAD` | 34,879 | 686 | 674 |

**报告的两个自述数字（34,193 与 34,205）相互差 12，且都离 `12f62da` 700 多行——但离 `31a7f35` 只差约 100 行。** 这与 §2.2 的门 0 结论、`slices.json` 的 `approx_lines` 指纹（6/10 对 `31a7f35`）**三者独立地指向同一件事：审计读的不是 `12f62da`。**

这是"自述数字"一类，正是 G5 该查的，而 G5 一次都没跑。

**(1b) 附带一条：两份报告的行数自述也自相矛盾**

`AUDIT-REPORT.md` 写 34,193，`slices.json.unverified` 写 34,205，差 12 行。两个数字都出自同一次审计，但没有任何一处说明口径差异。

**(2) AUDIT-REPORT 与 DEEP-REPORT 的 confirmed 严重性不一致（4 条）**

| ID | AUDIT-REPORT | DEEP-REPORT | critique |
|---|---|---|---|
| S10-F1 | **high** | **medium** | high |
| S03-F3 | **medium** | **low** | medium |
| S08-F1 | **medium** | **low** | medium |
| S08-F2 | **medium** | **low** | medium |

`AUDIT-REPORT.md`（17:44 生成）用的是**锐评后**的严重性；`DEEP-REPORT.md`（19:20 生成，晚 1.5 小时）用的是**深挖后**的严重性。深挖把 4 条降了级，但**没人回去更新 AUDIT-REPORT**。

结果：同一批 13 条确认发现，两份报告给出两套严重性分布：

| | high | medium | low |
|---|---|---|---|
| AUDIT-REPORT | 1 | 5 | 7 |
| DEEP-REPORT | 0 | 3 | 10 |

**这是本次审计里最典型的"下游更新了、上游没回填"缺陷，而且正是 `severity-consistency.mjs` 这类的检查目标。** 但那个工具要求的是 `<fixture目录> <报告1> <报告2>` 这种 fixture 形态，喂 `.run-hv` 直接崩（`ENOENT: .run-hv/manifest.json`）。

**(3) DEEP-REPORT 自己的"13 条"表只列了 13 行，但文字说"三条降级"**

实测表里降级是 **4 条**（S10-F1 high→medium、S03-F3 medium→low、S08-F1 medium→low、S08-F2 medium→low），文字说"**三条降级** + 两条维持 + 一条危害被推翻"。**4 ≠ 3。** 这是纯文字错误，无机械影响，但同样属于"自述数字不自洽"。

---

## 5. 任务五：哪些检查因为产物是 `.json` 而完全没发生

### 5.1 完整清单

| 工具 / 检查 | 本该查什么 | 对 `.run-hv` 实跑结果 | 状态 |
|---|---|---|---|
| `verify-artifacts.mjs` **G0** 门 0 回显真实性 | quote 是否逐字出现在 file:line | SKIP（"没有需要校验的 evidence"）**→ 0/45 被核对** | **完全没发生** |
| `verify-artifacts.mjs` **G1** 文件存在性 | `files_read` / `evidence.file` 是否存在 | SKIP（"没有 files_read 字段"）。手工核：75/75 存在 | **完全没发生**（手工等价：通过） |
| `verify-artifacts.mjs` **G2** 产物真实性 | `artifact_path` 是否存在且非空 | SKIP（"没有 status=SUCCESS 的信封"） | **完全没发生** |
| `verify-artifacts.mjs` **G3** 覆盖完整性 | `files_read` 是否覆盖切片的 `files[]` | SKIP。手工核：75/75 覆盖，0 缺 | **完全没发生**（手工等价：通过） |
| `verify-artifacts.mjs` **G4** 账本对账 | `discipline_log` vs `wave2_completed` | SKIP（"找不到 state.json"）。`.run-hv` 里**确实没有 state.json** | **跑不了**（缺输入） |
| `verify-artifacts.mjs` **G5** 自述数字自洽 | `lead_count` / `approve_count` 等 | SKIP（"没有可校验的自述数字"） | **完全没发生**（而 §4.2 证明这里有真错） |
| `verify-artifacts.mjs` **G6** JSON 块解析 | 信封信封能否解析 | 未触发（0 个块） | 无对象 |
| `verify-artifacts.mjs` **G7** 信封存在性 | 每份产物都必须有信封 | **5 FAIL**（顶层 5 个 `.md`） | 只查了 `.md`，`.json` 全漏 |
| `verify-artifacts.mjs` **G8** 行数对账 | 自述 `line_count` vs 实测 | SKIP（"没有可对账的 line_count"） | **完全没发生**（§4.2 证明行数确实错） |
| `verify-artifacts.mjs` 总体 | — | **6 FAIL / 0 PASS / 6 SKIP，exit 1** | 结论是"什么都没验证"（工具自己这么说） |
| `check-payload.mjs --role audit` × 10 | 20+ 条字段规则 | **10/10 `no_json_envelope`** | **除第 1 条外全部没发生** |
| `check-payload.mjs` `missing_finding_status` | 每条 finding 必须声明 status | 从未执行（信封不存在） | **完全没发生** |
| `check-payload.mjs` `evidence_wrong_shape` | evidence 必须是对象 | 从未执行 | **完全没发生** |
| `check-payload.mjs` `confirmed_without_evidence` | CONFIRMED 必须有真实 quote | 从未执行 | **完全没发生** |
| `check-payload.mjs` `critical_without_call_chain` | CRITICAL 必须有调用链 | 从未执行 | **完全没发生**（本次无 CRITICAL，无实际影响） |
| `check-payload.mjs` `missing_self_check` | 三项必做自检 | 从未执行 | **完全没发生**（产物里确实没有 self_checks） |
| `check-payload.mjs` `no_evidence_without_scope` | NO_EVIDENCE_FOUND 需搜索范围 | 从未执行 | **完全没发生** |
| `check-payload.mjs` `id` vs `finding_id` | 字段名必须正确 | 从未执行（产物用了 `local_id`，规则只认 `id`） | **完全没发生**，且**现有规则也抓不到 `local_id`** |
| `check-disposition-coverage.mjs` | 每条发现是否被表态 | 无 `--ledger` 输入；且只扫 `.md` 信封 | **跑不了 + 不认 `.json`** |
| `check-fix-instances.mjs` | 修复实例 vs 报告裁决索引表 | `state.json` 不存在 → `state_missing` | **跑不了**（缺输入） |
| `check-state.mjs` | 状态账本一致性 | `state.json` 不存在 | **跑不了** |
| `severity-consistency.mjs` | 同一条缺陷的严重性是否一致 | 直接崩：`ENOENT .run-hv/manifest.json` | **跑不了**（这是 §4.2(2) 那 4 条不一致的检查器） |
| `check-deliverables.mjs` | 交付物命名与必交付文件 | 2 FAIL：缺 `-final-report.md`/`-ledger.md`；10 个文件不符命名；3 个子目录 | **跑得了，但结论是全部不合规**（因为框架规范要求扁平 `.md`） |
| `check-fix-artifacts-envelope.mjs` | 修复产物信封闸门 | 对 `P1-FIX-PLAN.md`：1 FAIL `artifact_without_envelope` | 跑得了，1 份 |
| `check-enum-consistency.mjs` / `check-blindspots.mjs` / `check-promises.mjs` / `check-plan.mjs` / `check-handoff.mjs` | 各种枚举/盲点/承诺检查 | 需要各自专用输入（packet.json / 特定目录形态），`.run-hv` 不满足 | **跑不了** |
| `ledger` 对账 / `round-chain` | — | 无 state.json、无 round 目录结构 | **跑不了** |

### 5.2 一句话总结这张表

**22 类机械检查里：**

| 状态 | 数量 | 具体 |
|---|---|---|
| **完全没发生**（因 `.json` 形态被跳过） | **10** | G0/G1/G2/G3/G5/G8 + check-payload 的 6 组字段规则 |
| **跑不了**（缺 state.json / manifest.json / ledger 等输入） | **8** | G4、check-state、check-fix-instances、check-disposition-coverage、severity-consistency、check-enum-consistency、check-handoff、check-plan |
| **跑了但只覆盖 `.md`** | 3 | G7、check-deliverables、check-fix-artifacts-envelope |
| **实际有效的机械验证** | **0** | — |

**零。** 没有任何一项机械检查在审计当时或审计之后，对这批产物起到过实际的验证作用。

---

## 6. 最重要的产出：这套框架在真实审计上到底验证了什么

### 6.1 总表

| 检查类别 | 实际结果 | 证据（可复现命令） |
|---|---|---|
| **findings 契约准入** | **全部失败** | `node tools/check-payload.mjs .run-hv/findings/S01.json --role audit` → `no_json_envelope`，×10 |
| **门 0 证据回显** | **原样跑：0/45 核对**。<br>改写后按 `31a7f35` 核：**40/45 通过**（1 条全文件找不到 + 4 条引错行）<br>改写后按 `12f62da` 核：**32/45 通过**（4 条找不到 + 9 条引错行） | `node tools/verify-artifacts.mjs --repo .probe-verify/baseline-31 --artifacts .probe-verify/wrapped` → `门 0 回显: 40/45 通过` |
| **门 0 抓出的真问题** | 位置正确只有 32–40 条；4–9 条引错行（最大偏移 −77/+32）、1–4 条全文件找不到、0–2 条行号越界 | `.probe-verify/gate0-unbounded.mjs <rev>` |
| **被审对象可复现性** | **失败**。自述基线 `12f62da` 与证据不吻合；`31a7f35` 更吻合（40 vs 32）；`slices.json` 行数指纹 6/10 对 `31a7f35`、1/10 对 `12f62da` | `.probe-verify/rev-score.mjs`、`git show <rev>:<file>` |
| **files_read 存在性 (G1)** | 手工核 75/75 存在 | `git archive 12f62da` + 逐条 `existsSync` |
| **切片覆盖 (G3)** | 手工核 75/75 覆盖、0 遗漏 | `slices.json` vs findings `files_read` 集合比对 |
| **critique ↔ finding 对应** | 41 对 45，**0 孤儿裁决，4 条未评** | 41 份 critique 的 `finding_id` 集合比对 |
| **裁决严重性一致性** | 22 条可比，**0 处不符** | 报告降级表 vs `adjusted_severity` |
| **报告数字 ↔ 实际统计** | 45/41/13/6/10/75 全对；**总行数对不上自述基线（33,461 vs 34,193）**；**降级 26 vs 22 口径混用** | `git show <rev>:<file> \| wc -l`、集合统计 |
| **跨报告严重性一致** | **4 条不一致**（AUDIT vs DEEP） | 两份报告 confirmed 段逐条对比 |
| **深挖覆盖率** | 13 深挖 ID == 13 confirmed ID，**完全对齐** | 集合相等 |
| **state.json / ledger / manifest** | **全部不存在** | `find .run-hv -name state.json` → 空 |
| **final-report / ledger 交付物** | **全部缺失** | `check-deliverables --round-dir .run-hv` → D1 ×2 FAIL |
| **构建 / 测试** | **从未执行**（全程只读） | 产物多处自述 "No build or test execution" |

### 6.2 直接回答"到底验证了什么、没验证什么"

**验证了的（而且是真的验证，不是自述）：**

1. **切片划分是完备的**——75 个文件、10 个切片、0 重复 0 遗漏，可用 `git ls-tree` 独立复核。这一项是真的。
2. **锐评与发现能对上**——41 份裁决全部指向真实存在的 finding，0 孤儿。13 条 confirmed 与 13 条深挖完全同一批。这一项是真的。
3. **裁决内部的严重性调整是自洽的**——22 条可比对的降级，0 处与 critique 文件不符。
4. **45 条发现的证据，绝大多数是真的**——在把产物包装成契约形态、并对到证据最吻合的树（`31a7f35`）之后，**44/45 能在所声称的文件里找到对应原文**，**40/45 位置也对**（含空白容差）。**这是这批产物最值得肯定的地方：quote 几乎都不是编的。**
5. **13 条 confirmed 与 13 条深挖完全一一对应**，深挖后的严重性也内部自洽（0 high / 3 medium / 10 low）。

**没验证的（而且是框架声称要验证的）：**

1. **门 0 对这批产物原样运行的覆盖率：0%。** 10 份 findings 全部因为不是 Markdown 信封而进不了校验器。
2. **45 条 evidence 的 file:line 真实性：框架自己从未核对过一条。** 我核对出的 44/45 是**事后重构 + 事后选树**的结果，不是当时的产物。
3. **证据链瑕疵从未被任何机械检查发现**：位置正确的只有 32–40 条；4–9 条 quote 真实但引错行（偏移最大 −77/+32）；1–4 条全文件找不到；0–2 条声称行越界。这些都是门 0 本该抓、却因为形态错配一条都没抓的。
4. **被审对象不可复现。** 报告自述基线 `12f62da`，但三条独立证据（门 0 命中率 40 vs 32、`slices.json` 行数指纹 6/10 vs 1/10、总行数 34,296 vs 34,193 只差 103 而 `12f62da` 差 732）全部指向 `31a7f35`。**这意味着报告里的"基线提交"是错的**，也意味着门 0 的"逐字来自被审对象"在这批产物上没有确定基准。
5. **行数 34,193（自述）与实际对不上自述基线**、**降级 26 vs 22**、**AUDIT vs DEEP 的 4 条严重性不一致**——这些"自述数字不自洽"全部漏网，因为它们归 G5，而 G5 SKIP。
6. **没有任何状态账本**（state.json / discipline_log / ledger / manifest），所以"谁在什么时候做了什么、重派过几次、预算超没超"这一类过程真实性**完全不可审计**。
7. **构建与测试一次没跑**，所以"已修复 3 条、944 测试通过"这类声明**无法机械核实**。

### 6.3 四条不可回避的结论

**结论一：框架的机械验证层与这次审计的产物形态完全错配，覆盖率是 0。**

不是"验证得少"，是**一条都没验**。`verify-artifacts.mjs` 甚至自己报出了这个事实（`产物目录里一份可用产物都没有……这不等于通过——它意味着什么都没验证`）。这个 FAIL 是工具设计者的先见之明，但它只说明了"没验"，没有能力去"验"。

**结论二：这不是子 Agent 不守规矩，是框架缺少"按文件类型分派"的能力。**

10 份 findings 是合法、完整、可解析的 JSON。它们的语义完全符合契约（我把它们映射成契约字段后，`check-payload.mjs` 10/10 全绿）。**唯一的问题是它们被写成了独立的 `.json` 文件，而不是"Markdown + 末尾 json 围栏"。** 而框架的命名规范只允许 `.md`，校验器的扫描循环只认 `e.name.endsWith('.md')`。契约里没有任何一句说"如果产物本身就是 .json 该怎么办"。

这是一个**格式约定与执行现实之间的缺口**，不是内容质量问题。

**结论三：即使绕开形态问题，门 0 在这批产物上也给不出确定判罚——因为没有可复现的被审对象。**

报告写的是"基线提交 12f62da"，但机械核对显示：

- 45 条里，`12f62da` 能精确命中 24 条；
- `31a7f35`（**审计之后 17 小时才提交**）能精确命中 32 条、总找到 40 条；
- `slices.json` 里 10 个切片的行数，有 6 个与 `31a7f35` 完全相等，只有 1 个与 `12f62da` 相等；
- 3 条 quote（S03-F1/F4、S09-F1）的文本在 `12f62da` 里**完全不存在**，是 `31a7f35` 才引入的；
- 反过来 1 条（S03-F3）只在 `12f62da` 存在，被 `31a7f35` 改掉了。

**没有任何单一 commit 能让 45 条全部命中。** 最自洽的解释是：审计读的是一个"边审边改"的脏工作区，而报告事后把基线误标为 `12f62da`。

**这暴露了一个结构性缺口，比"产物没写信封"更根本：框架没有"审计对象快照"机制。** `slices.json` 记了切片的 `approx_lines`，却没记对应 commit，也没存任何快照。"quote 必须逐字来自被审对象"这条整个门 0 的地基，在一个会变的工作区上没有落点——你无法事后重放一个已被覆盖的状态。

**结论四：这次审计真正起作用的是 LLM 锐评，不是机械检查。**

数字支撑：

- 45 条发现 → 锐评撤掉 6 条、降级 22 条 → 撤销率 13%、降级率 49–58%。
- 6 条撤销里，**理由全是反编译/平台行为核实**（Paper 的 `enablePlugin` 异常处理、`PluginCommand` 的 executor 字段、`Location#distanceSquared` 的跨世界行为、JDK 的 `AtomicMoveNotSupportedException` 映射）。这些**没有任何一个现有工具能验证**。
- 13 条 confirmed 之后又深挖，把 4 条的严重性再降一级，理由同样是调用链与 guard 的逐条核对。

**也就是说：这批产物的质量，来自 LLM 的自我批判（锐评 + 深挖），而不是框架的机械闸门。** 机械闸门全程开着但没通电。

**而这恰好是框架自己写在 `verify-artifacts.mjs` 结尾的那句话：**

> 注意：本脚本只验证「能否机械验证」的部分。
> 证据是否支持主张、严重性是否合理、可达性判断对不对——这些必须由 LLM 判断，脚本不碰。

**这次审计把这句话完整地演示了一遍：脚本不碰的部分（LLM 判断）做得相当扎实；脚本该碰的部分（机械验证）一次都没碰。**

---

## 7. 附：本次验证用到的全部脚本与命令

所有探针脚本在 `.probe-verify/`（收尾已删除），不修改 `tools/` / `framework/` / `.run-hv/` / 被审仓库。

| 脚本 | 作用 |
|---|---|
| `.probe-verify/gate0.mjs` | 复刻门 0，跑当前工作区 |
| `.probe-verify/gate0-deep.mjs` | 无界搜索 + token 覆盖率 |
| `.probe-verify/gate0-at-rev.mjs` | 复刻门 0，跑指定 commit |
| `.probe-verify/gate0-definitive.mjs` | 严格复刻 `checkGate0()` 语义（15 行向前窗口） |
| `.probe-verify/gate0-unbounded.mjs` | 全文件无界搜索，区分错行/改写/找不到 |
| `.probe-verify/which-tree.mjs` | 每条 finding 在基线 vs HEAD 的命中对比 |
| `.probe-verify/rev-score.mjs` | 各 commit 的命中率打分（定位被审树） |
| `.probe-verify/wrap.mjs` | 把真实 finding 映射成契约形态（10/10 通过 check-payload） |
| `.probe-verify/wrap-literal.mjs` | 原样包装（证明字段级错配） |
| `.probe-verify/baseline/` | `git archive 12f62da` 的只读副本 |

主要命令：

```bash
# 原样跑（验证率为 0 的现场）
node tools/verify-artifacts.mjs --repo "D:/Server/.../Hilltop Village Plugin" --artifacts .run-hv
for f in .run-hv/findings/S*.json; do node tools/check-payload.mjs "$f" --role audit; done

# 改写后跑（32/45 的上限）
node .probe-verify/wrap.mjs
node tools/verify-artifacts.mjs --repo ".probe-verify/baseline" --artifacts .probe-verify/wrapped

# 基线还原
git -C "D:/Server/.../Hilltop Village Plugin" archive 12f62da | tar -x -C .probe-verify/baseline

# 集合比对（critique ↔ finding）
node -e '...'   # 见 §3.1

# 行数核对
find .probe-verify/baseline/src/main/java -name '*.java' | xargs wc -l | tail -1   # 33461
```

---

*本报告只读、只跑，未修改 `tools/`、`framework/`、`.run-hv/`、被审仓库任何文件；未执行任何 git 写操作。*
