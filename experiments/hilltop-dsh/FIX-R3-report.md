# R3 报告：fix 角色的 `disposition` 契约与覆盖率校验

**任务**：防止「发现静默蒸发」——让每条 finding 必须被修复或明确暂缓一次。
**日期**：2026-11-15
**纪律**：先写失败测试 → 在未改代码的树上跑，确认 FAIL → 改代码 → 转绿 → 全量检查。

---

## 1. 改了哪些文件、哪些行

| 文件 | 改动 | 行号（改动后） |
|---|---|---|
| `tools/check-payload.test.mjs` | 新增 case 101–116（17 个新用例，239 行） | `1337`–`1573` |
| `tools/check-payload.mjs` | 新增 `§0 disposition 公共校验`（`DISPOSITIONS` 闭集、`red_log_in_target` 正则、`validateDispositionEntry()`） | `65`–`166` |
| 同上 | 新增 `if (envelope.role === 'fix')` 分支：单/多发现两种形态 + `disposition_missing_for_target` | `1055`–`1097` |
| 同上 | 新增 `duplicate_finding_id`（**对所有角色生效**） | `1143`–`1172` |
| `framework/components/output-contract.md` | §2.4 重写：新增 `disposition` / `disposition_reason` / `test_path` / `red_log_path` / `next_round` 字段与四值语义表、`target/` 教训、id 去重 | `536`–`599` |
| `framework/components/output-contract/fix.md` | **由生成器重新生成**（不手改），同步得到同样的 §2.4 | `137`–`200` |
| `framework/components/output-contract/examples/fix.md` | **由生成器重新生成**：示例补 `finding_id` / `disposition` / `test_path` / `red_log_path` | `20`–`23` |
| `tools/gen-contract-examples.mjs` | fix 的 `EXAMPLES.fix` 补 4 个字段（否则示例会被自家校验器拒绝） | `169`–`183` |

**没碰**本轮其他 agent 的文件（`check-state*` / `stop-hook*` / `fix-worker.md` / `wave4-fix.md` / `check-all.mjs` / `check-disposition-coverage*`）。

> 注：`output-contract/fix.md` 与 `examples/fix.md` 都在文件头写着「自动生成，请勿手改」，
> 所以我改的是母文件 `output-contract.md` 和生成器 `gen-contract-examples.mjs`，
> 然后跑 `gen-contract-slices.mjs` / `gen-contract-examples.mjs` 重新生成。直接手改切片会被
> `check-contract-slices.test.mjs` 的「生成器幂等」用例判红。

---

## 2. 新测试的失败信息原文（改代码前跑的）

命令：`node tools/check-payload.test.mjs`（此时 `check-payload.mjs` 尚未改动）

```
case 101: 完整合规的 fix 产物（FIXED + test_path + target/ 外的红测日志）→ 通过
  ✓ 无错误
case 102: fix 缺 disposition → 必须报 missing_disposition
  ✗ 报 missing_disposition — []
case 103: FIXED 但没有 test_path → 必须报 fixed_without_test
  ✗ 报 fixed_without_test — []
case 104: FIXED 但没有 red_log_path → 必须报 fixed_without_red_log
  ✗ 报 fixed_without_red_log — []
case 105: red_log_path 指向 target/ → 必须报 red_log_in_target（真实教训：被 mvn clean 删光）
  ✗ 四种 target/ 写法全部被抓 — 绕过: target/red-F1.log / ./target/logs/red.log / D:/proj/myapp/target/red.log / target\red.log
case 106: WONT_FIX 但 disposition_reason 太短 → 必须报 wont_fix_without_reason
  ✗ 报 wont_fix_without_reason — []
case 107: WONT_FIX 且理由充分（≥20 字）→ 通过
  ✓ 无错误
case 108: DEFERRED 但没有 next_round → 必须报 deferred_without_trigger
  ✗ 报 deferred_without_trigger — []
case 109: DEFERRED 且给出 next_round → 通过
  ✓ 无错误
case 110: NEW_FINDING 显式标记 → 通过（不算未处置）
  ✓ 无错误
case 111: disposition 用了枚举外的值 → 必须报 invalid_disposition
  ✗ 报 invalid_disposition — []
case 112: 同一产物里 finding_id 重复 → 必须报 duplicate_finding_id
  ✗ 报 duplicate_finding_id — []
case 113: finding_id 不重复 → 不报 duplicate_finding_id
  ✓ 不报 duplicate_finding_id
case 114: 派发清单里有 3 条，只处置了 1 条 → 必须报 disposition_missing_for_target
  ✗ 报 disposition_missing_for_target — []
case 115: dispositions[] 逐条覆盖全部 target → 通过（多发现形态）
  ✓ 无错误
case 116: 非 fix 角色不得被要求 disposition（不能过度执法）
  ✓ audit 产物不报 missing_disposition
  ✓ sweep 产物不报 missing_disposition

=== 结果: 116 通过 / 9 失败 ===
```

**红测证据全部是 `[]`（errors 数组为空）或「四种写法全部绕过」**——即校验器对这些产物
实际返回「✅ 契约合规」。这正是问题本身：38 条发现只修 6 条时，工具也是这个反应。

失败用例共 9 条：102 / 103 / 104 / 105 / 106 / 108 / 111 / 112 / 114。
通过的 7 条（101 / 107 / 109 / 110 / 113 / 115 / 116）是**反向用例**：它们在改代码前也通过，
用来钉住「不得过度执法」（尤其 116：audit / sweep 产物不得被要求 disposition）。

---

## 3. 实现要点

### 3.1 为什么 `disposition` 只对 fix 必填

`ROLE_REQUIRED.fix` 保持 `['files_touched']` 不变。新规则全部放在
`if (envelope.role === 'fix')` 分支内（`check-payload.mjs:1055`），
**没有**加进 `ROLE_REQUIRED`——那条路径对所有角色生效，加进去会让既有 audit/sweep/critique
产物全部变红。case 116 就是钉住这一点的回归用例。

`duplicate_finding_id` 是唯一一条**全角色**规则（按任务书要求），但它只在
`findings` / `verdicts` / `dispositions` / `target_finding_ids` 四个数组里查，
对现有产物零影响（见 §5）。

### 3.2 单发现 / 多发现两种形态

```jsonc
// 单发现：payload 本身就是一个 disposition 条目
{ "payload": { "finding_id": "F1", "disposition": "FIXED", "test_path": "...", "red_log_path": "...", ... } }

// 多发现：dispositions[] 逐条列出
{ "payload": { "target_finding_ids": ["F1","F2"], "dispositions": [ {...}, {...} ] } }
```

判定顺序：`dispositions` 非空时它就是权威清单，`payload` 顶层**不再**被当成额外条目。
这一条是在测试跑红时发现的：第一版实现把两者都当条目，于是 case 115（多发现形态）
报出一个不该存在的 `missing_disposition`（顶层那个 `finding_id` 被要求写 disposition）。
修法写成「非空即权威」，而不是给测试放宽。

### 3.3 `red_log_in_target` 的四种写法

```js
const normalized = rlp.replace(/\\/g, '/');
const RED_LOG_IN_TARGET = /(^|\/)target\//i;
```

覆盖：`target/red.log`（相对）、`./target/logs/red.log`、`D:/proj/app/target/red.log`（绝对）、
`target\red.log`（Windows 反斜杠）。case 105 逐一验证。
**只要给了 `red_log_path` 就检查，不论 disposition 是哪个值**——一条放在 `target/` 下的日志
在任何档位下都不是可复核的证据。

### 3.4 比任务书多出的一条：`deferred_without_reason`

任务书只要求 `deferred_without_trigger`。但契约字段表写的是
「`disposition_reason` — WONT_FIX / **DEFERRED** 时必填（≥20 字）」。
只对 WONT_FIX 强制，等于「文档写了、校验器不执行」——正是本仓库反复批评的那类缺陷
（`bug` 的形状与 `verdict_missing_for_target` 的成因完全同源）。
因此补了 `deferred_without_reason`，并加了 case 110b 钉住它。

### 3.5 文案

`disposition_missing_for_target` 的文案按任务书要求写「漏处置一条等于让它静默蒸发」，
并与 critique 的 `verdict_missing_for_target` 明确对举：

> 以下 target_finding_ids 没有任何 disposition: F1, F2。
> 漏处置一条等于让它静默蒸发——实测 38 条发现只修了 6 条，31 条从未进入任何任务书，
> 而框架里没有任何工具报错。锐评波要求「每条都被攻击过」，修复波必须要求「每条都被处置过」

---

## 4. 验证结果

```
node tools/check-payload.test.mjs            → 126 通过 / 0 失败
node tools/check-contract-slices.mjs         → exit 0，7 份切片全部完整
node tools/check-contract-slice-fidelity.mjs → exit 0，7 份切片无损（138 个字段全部保留）
node tools/check-contract-examples.mjs       → exit 0，7 份示例全部通过
node tools/check-enum-consistency.mjs        → exit 0
node tools/check-wrapper-contract.mjs        → exit 0
node tools/check-all.mjs                     → ✅ 全部通过（25 个检查项，0 失败）
```

`check-all` 中相关项：

```
契约准入检查器              → 126 通过 / 0 失败
契约切片完整性              → 10 通过 / 0 失败
契约切片保真度              → 11 通过 / 0 失败
契约示例可用性              → 15 通过 / 0 失败
枚举跨层一致性              → 15 通过 / 0 失败
```

补充说明：`check-contract-slice-fidelity.mjs` 与 `check-enum-consistency.mjs` 在样本内
都打印了 `[预期失败] …`，那是它们**自测用例**（故意把母文件改坏、故意破坏校验器结构）
的输出，不是真实失败——两者退出码均为 0，`check-all` 判绿。

---

## 5. 既有 fix 产物是否会因此失败

**结论：仓库内没有「真实」的 fix 产物会因此变红；唯一受影响的示例已同步。**

排查方式与结果：

| 位置 | 是否受影响 | 说明 |
|---|---|---|
| `framework/components/output-contract/examples/fix.md` | **是（已修）** | 这是全仓唯一一份 `"role": "fix"` 的完整信封（`grep -rln '"role": *"fix"'` 只命中它）。改代码后 `check-contract-examples.mjs` 立即拒绝它（`[missing_disposition] payload.disposition`）。已通过改 `gen-contract-examples.mjs` 并重跑生成器修复；生成器内建「不通过校验器就不写出」的保护，所以这份示例是验证过的 |
| `tools/fixtures/**` | 否 | 无 fix 角色产物（contract-probe 的 19 个用例全是 audit / recon / sweep） |
| `tools/fixtures/real-artifacts/` | 否 | 只有一份 audit 产物 |
| `framework/artifacts/run-state.md`、`experiments/**` | 否 | 只在散文里引用 `files_touched`，没有 fix 角色的 JSON 信封 |
| `check-payload.test.mjs` 既有 case 99 / 100 | 否 | 用了 `role: 'fix'` 但断言的是 `artifact_path_wrong_type`；新规则只 push 到 `errors`，不改变既有断言的取值 |

### 迁移成本（对历史产物）

我把改动的性质限定为「**新增必填字段**」，所以历史 fix 产物会失败，但失败面是确定的：

- 任何**缺 `disposition`** 的 fix 产物 → `missing_disposition`（当前仓库内除示例外不存在这类文件）
- 迁移动作：在 payload 里补一个 `disposition` + 该取值对应的附加字段即可，无需改结构
- 如果某份历史产物确实是 `FIXED` 但没有 `test_path` / `red_log_path`，那它**本来就无法证明
  修复成立**——被拒是这条规则的目的，不是副作用

**没有**把 `disposition` 加进 `ROLE_REQUIRED`，因此 audit / sweep / recon / critique /
planner / verify 的既有产物 100% 不受影响（case 116 是这条的回归用例）。

---

## 6. 遗留 / 未做

1. **`dispositions[]` 数组形态没有写进 `ROLE_REQUIRED` 解析**：`check-contract-slices.mjs`
   从 `ROLE_REQUIRED` 正则解析字段清单，而 `ROLE_REQUIRED.fix` 仍是 `['files_touched']`。
   所以切片校验器目前**不知道** fix 切片必须有 `disposition`——它的完整性由
   `check-contract-slice-fidelity.mjs` 覆盖（后者检查母文件 §2.4 里的全部 snake_case 字段），
   实测通过。若要更严格，需把 `disposition` 那一组也纳入 `ROLE_REQUIRED`，
   但那会同时影响 `check-wrapper-contract.mjs`，而 `fix-worker.md` 不在我的改动范围内
   （R5 正在改它），**故未做**，留给 R5 落地后在统一一轮把 `disposition` 加进去。
2. **`NEW_FINDING` 不强制 `disposition_reason`**：任务书只要求「显式标记」。
   实测无理由的新发现仍然可能被无视，但这一档的判据是语义的，机械校验只能到此为止。
3. **`red_log_in_target` 只认 `target/`**：Gradle（`build/`）、Rust（`target/` 同名）、
   .NET（`bin/` `obj/`）的清理目录没有覆盖。任务书只点了 `target/`，我没有擅自扩大闭集——
   扩大后可能误伤 `dist/target/` 这类合法路径。如需扩展，应作为独立规则并配单独测试。
4. **未 commit**（按任务书要求）。
