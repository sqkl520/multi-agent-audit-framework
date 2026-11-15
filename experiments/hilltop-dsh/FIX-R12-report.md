# R12 — 闭合证据链第 1、2 环

> 任务：让修复产物必须带 JSON 信封（第 1 环），并让修复/验收相位的自检表必须要求跑 `check-payload`（第 2 环）。
>
> 结论先说：**两环都补上了，但第 2 环仍然是「靠自觉」**——见第八节，我没有把它说成已经解决。

---

## 一、起点：R11 §8.2 的四环证据链

```
产物有没有信封（1） → 有没有人调校验器（2） → 路径存在吗（3）→ 内容对得上主张吗（4）
```

R11 修的是第 3 环（`existsSync`）。第 1、2 环是空的，本轮补它们。

**先复现两个洞（不是引述 R11，是我自己跑的）**：

```
$ grep -c 'check-payload' framework/templates/wave4-fix.md     # (HEAD 版本)
0
$ grep -c 'check-payload' framework/templates/wave5-verify.md  # (HEAD 版本)
0

$ grep -c '"schema_version"' experiments/hilltop-dsh/repair/done-*.md
done-1.md:0
done-3.md:0
done-4.md:0
done-6.md:0
done-7.md:0
done-8.md:0
```

两个都是 0。而 `wave2-audit.md:793` 早就写着「**自检**：`node <FRAMEWORK_ROOT>/tools/check-payload.mjs <你的产物> --role audit`，退出码非 0 就是不合规」。**同一个框架里，审计相位有机械自检，修复和验收相位没有。**

---

## 二、先写失败测试（TDD）

`tools/check-fix-artifacts-envelope.test.mjs` 先于实现写出，17 个 case / 47 个断言。在检查器不存在时跑：

```
$ node tools/check-fix-artifacts-envelope.test.mjs
Error: Cannot find module '...\tools\check-fix-artifacts-envelope.mjs'
...
=== 结果: 10 通过 / 36 失败 ===
```

10 个「通过」是 `expect(..., false)` 恰好为假的空洞断言（例如「退出码 1」在 `MODULE_NOT_FOUND` 时 `e.status=1`），36 个失败是真实缺口。**确认 FAIL 后才动手写检查器。**

实现后：

```
$ node tools/check-fix-artifacts-envelope.test.mjs
=== 结果: 47 通过 / 0 失败 ===
```

期间修掉 3 个真实问题（都是我自己的 bug，记录在此以免被当成「一次写对」）：

| # | 问题 | 性质 |
|---|---|---|
| 1 | 规则名写成 `expected_fix_artifact`，任务书要求 `artifact_name_not_conforming` | 偏离规格。已改名 |
| 2 | case 6 把整个产物（含正文）当作 json 块内容传给 `artifact()`，导致块被嵌套、解析出「无信封」而非「解析失败」 | **测试本身写错了**——它本该测 `envelope_invalid`，实际测的是 `artifact_without_envelope` |
| 3 | case 15 用 `rulesOf()`（按产物聚合）去查 `subdirectory_not_scanned`，而该规则是目录级的、不挂在任何产物上 | 测试用错了查询口径 |

第 2 条值得单独说：**一个写错的测试比没有测试更危险**——它会给出「`envelope_invalid` 这条规则被覆盖了」的假象。

---

## 三、新增 `tools/check-fix-artifacts-envelope.mjs`（424 行）

### 3.1 用法

```
node check-fix-artifacts-envelope.mjs --dir <修复产物目录> [--pattern '<glob>'] [--json]
```

`--pattern` 可重复，默认 `done-*.md` 与 `*-fix-*.md`（前者兼容 `experiments/hilltop-dsh/repair/` 的现有实践，后者是 `report-naming.md` 的 `round{N}-04-fix-{n}.md`）。

### 3.2 七条规则，逐条对照任务书

| 任务书要求 | 实现 | 级别 |
|---|---|---|
| `dir_missing` → exit 2 | ✅ 目录不存在 / 不是目录 | CONFIG → 2 |
| `no_fix_artifacts` → exit 2 | ✅ pattern 选中 0 个文件 | CONFIG → 2 |
| **`artifact_without_envelope`** | ✅ 逐份点名，不汇总成百分比 | FAIL |
| `envelope_invalid` | ✅ JSON 解析失败 / 解析出非对象 | FAIL |
| `envelope_wrong_role` | ✅ `role !== "fix"` | FAIL |
| `envelope_missing_disposition` | ✅ 单发现看 `disposition`，多发现看 `dispositions[]` | FAIL |
| `artifact_name_not_conforming` | ✅ WARN，不阻塞 | WARN |

另外加了 3 条任务书没要求、但不加就会留洞的：

| 规则 | 为什么加 |
|---|---|
| `subdirectory_not_scanned`（WARN） | 子目录里的产物不进分母。不加 WARN，`legacy/` 就是一个静默白名单——而这正是 `check-disposition-coverage.mjs` 已经吃过一次亏的形态 |
| `json_trailing_comma_fixed`（WARN） | 容错解析会改动字符串内的内容（quote 里的 `,}` → `}`）。静默容错等于让产物谎称「逐字原文」 |
| `bad_pattern`（exit 2） | `--pattern ''` 会匹配 0 个文件，然后走 `no_fix_artifacts`——但报「配置错误」比报「你 pattern 写空了」更含糊 |

### 3.3 两个刻意的设计决定

**决定 1：信封取块口径与 `check-payload.mjs` 对齐，但有一处**故意**不同。**

`check-payload` 从后往前找「像信封」的块（含 `schema_version` 或 `role`），都不像时**退回最后一个块**。我不退回——都没有 `schema_version`/`role` 的块只是正文里的示例 JSON，**不是信封**。

case 11 钉住这一点：一份产物正文里带 `{"a":1}` 的 json 块 → 必须判 `artifact_without_envelope`，不能因为「有个 json 块」就放行。

**决定 2：不提供任何降级开关。**

没有 `--allow-missing-envelope`，没有 `--ignore <glob>`。理由写在 `--help` 里：那个开关一旦存在就会成为默认路径，然后这个脚本等于不存在。有意的历史产物请移进子目录并用 `--dir` 指向别处（`--help` 里写了完整做法，case 1 钉住 `--help` 必须提到 `--dir` 和「子目录」）。

---

## 四、用真实数据自证

```
$ node tools/check-fix-artifacts-envelope.mjs --dir experiments/hilltop-dsh/repair
修复产物信封闸门 — experiments/hilltop-dsh/repair
pattern: done-*.md *-fix-*.md

  ✗ done-1.md
      [FAIL] artifact_without_envelope: 整个文件没有任何 ```json 代码块。**这不是「格式不规范」，是「无法被任何机械检查观测到」**——check-payload 的全部规则（含「红测日志必须在 target/ 之外」「证据文件必须存在」）在这份产物上一次都不会跑
  ✗ done-3.md
      [FAIL] artifact_without_envelope: ...
  ✗ done-4.md
      [FAIL] artifact_without_envelope: ...
  ✗ done-6.md
      [FAIL] artifact_without_envelope: ...
  ✗ done-7.md
      [FAIL] artifact_without_envelope: ...
  ✗ done-8.md
      [FAIL] artifact_without_envelope: ...

结果: 6 份产物 / 6 FAIL / 0 WARN

没有信封的修复产物 = 无法被 check-payload 观测 = 未交付。
补法：在文件末尾追加一个 ```json 代码块，内容见 components/output-contract.md §1，
然后重跑: node tools/check-payload.mjs <该产物> --role fix --repo <被审仓库>

其中 6 份没有信封: done-1.md, done-3.md, done-4.md, done-6.md, done-7.md, done-8.md
EXIT=1
```

`--json` 的 `totals`：`{"artifacts":6,"fail":6,"warn":0}`。

**预期 6 条 FAIL，实测 6 条 FAIL。** 这就是「2026-11-15 那次事故的修复产物从未被任何契约校验器观测过」的机械证明。

注意 `warn: 0` 这个细节：6 份全部命中核心规则，其余规则一条都没触发——因为它们需要能解析出信封才能跑。这不是巧合，**这是那个洞的形状本身**：规则不是没写对，是根本没跑。

---

## 五、文档改动逐字对照

### 5.1 `framework/templates/wave4-fix.md` 第 7 节

在自检表末尾新增一行（`+` 为新增）：

```diff
 | 尝试预算 | 尝试次数 ≤3 | 返回 `PERMANENT_FAILURE`，`attempts_exhausted: true` |
+| **机读信封完整** | 产物末尾有合法 JSON 信封，`check-payload --role fix` 退出码 0 | 补信封 / 修正字段直到通过 |
+
+> **自检（机械，不可跳过）**：
+> ```
+> node <FRAMEWORK_ROOT>/tools/check-payload.mjs <你的产物> --role fix --artifact-dir <产物目录> --repo <被审仓库>
+> ```
+> 退出码非 0 就是不合规——按它的提示修到通过为止，**不要用「我已人工核对」代替**。
+>
+> 先跑一条更粗的闸门，确认产物不是「看不见的」：
+> ```
+> node <FRAMEWORK_ROOT>/tools/check-fix-artifacts-envelope.mjs --dir <产物目录>
+> ```
+> 它只问一件事：这批产物里有没有哪一份**根本没有信封**。退出码非 0 = 有产物进不了 `check-payload`。
+>
+> **2026-11-15 的教训**：某次修复的 6 份产物全部没有 JSON 信封
+> （`grep -c '"schema_version"'` 逐份为 0），而 `check-payload` 的全部规则都挂在信封上——
+> `role` 取不到时，除 `no_json_envelope` 外一条都不跑。于是「红测日志必须在 `target/` 之外」
+> 「证据文件必须存在」「disposition 必须表态」这些规则**在这批产物上一次都没执行过**。
+> 它们不是通过了，是**没跑**。**产物不带信封 = 校验器无法观测它 = 未交付。**
```

### 5.2 `framework/templates/wave5-verify.md` 第 9 节

先读了该文件确认结构：自检节是**第 9 节「返回前的自检清单（验收Agent执行）」**（`:283`），表有 11 行内容。改动同构，`--role verify`：

```diff
 | 返回符合契约 | `payload.finding_id`、`fix_agent_id`、`verdict`、`evidence` 齐备，`evidence` 三项布尔值均有实际依据 | 补全 |
+| **机读信封完整** | 产物末尾有合法 JSON 信封，`check-payload --role verify` 退出码 0 | 补信封 / 修正字段直到通过 |
+
+> **自检（机械，不可跳过）**：
+> ```
+> node <FRAMEWORK_ROOT>/tools/check-payload.mjs <你的产物> --role verify --artifact-dir <产物目录> --repo <被审仓库>
+> ```
+> 退出码非 0 就是不合规——按它的提示修到通过为止，**不要用「我已人工核对」代替**。
+>
+> **为什么这一条必须存在**：上表中除最后一行以外的 10 行全都是**内容检查**，靠的是验收Agent自己诚实地逐项确认。
+> 而契约校验器的全部规则都挂在 JSON 信封上——信封不在，`verdict`、`mutation_check`、
+> `residual_risk_disposition` 一个都取不到，`check-payload` 除 `no_json_envelope` 外一条都不跑。
+> **没有信封的验收产物，在机械层面等于没交付。**
+>
+> 这条教训来自 2026-11-15：某次修复的 6 份产物全部没有信封，
+> 而当时两个相位（修复 / 验收）的自检表里都**没有任何一条要求跑 `check-payload`**。
+> 再强的规则，不被调用就等于不存在。修复产物的全目录闸门见
+> `tools/check-fix-artifacts-envelope.mjs`（`--dir <修复产物目录>`）。
```

> 一处自我纠正：我最初写的是「上面 11 行全都是内容检查」。实测表有 11 行内容、加上新增那行共 12 行，所以「上面 11 行」在加入新行后指的是**包含新行在内**的 11 行——措辞会误导。改成「上表中除最后一行以外的 10 行」，逐字可验。

### 5.3 `framework/components/output-contract/fix.md`

**关键发现：这个文件是自动生成的。** 头部写着「自动生成，请勿手改。母文件：framework/components/output-contract.md」，而 `tools/check-contract-slices.test.mjs` case 6 会重跑生成器并比对产物（防手改）。**只改切片会让 `check-all` 变红。**

所以改的是母文件 `output-contract.md` §2.4，再跑 `node tools/gen-contract-slices.mjs` 重新生成。改后 7 份切片全部无变化，只有 `fix.md` 增加了 22 行（`git diff --stat` 可验）：

```diff
 **`finding_id` 不得在同一产物内重复**（对所有角色生效，规则名 `duplicate_finding_id`）：
 ...
 实测把 7 条发现的 id 改成完全相同，校验器曾报「✅ 契约合规」。
 
+**没有信封的修复产物视为未交付**（2026-11-15 真实教训）：
+
+> **不是「格式不规范」，是「无法被任何机械检查观测到」。**
+>
+> 本次契约的第 0 节早已规定「产物必须以 JSON 信封结尾」，但规则的实际强度取决于
+> **有没有人调校验器**。实测：某次修复的 6 份产物（`done-1/3/4/6/7/8.md`）
+> `grep -c '"schema_version"'` 逐份为 **0**，于是 `check-payload.mjs` 的**全部**规则
+> 在这批产物上一条都没跑——因为校验器把每一条规则都挂在信封的 `role` / `payload` 上，
+> `role` 取不到时除 `no_json_envelope` 外全部跳过。包括
+> 「`red_log_path` 必须在 `target/` 之外」「证据文件必须存在」「`disposition` 必须表态」。
+>
+> 它们不是通过了，是**没跑**。两者的区别在事后完全不可见——这正是最坏的一类失败。
+>
+> 因此修复产物有两道机械闸门，都必须过：
+>
+> | 闸门 | 命令 | 它回答什么 |
+> |---|---|---|
+> | 目录级 | `node tools/check-fix-artifacts-envelope.mjs --dir <修复产物目录>` | 这批产物里有没有哪一份**根本没信封**（进不了校验器） |
+> | 单份级 | `node tools/check-payload.mjs <产物> --role fix --artifact-dir <目录> --repo <仓库>` | 这一份的信封与字段是否合规 |
+>
+> 两道都是退出码非 0 即不合规，**不得用「我已人工核对」代替**。
```

任务书问「确认它**已经**定义了信封结构（R3 加过 `disposition`）」——**确认了**：§2.4 的 payload schema 里 `disposition` 是四值闭集、缺一即 `CONTRACT_VIOLATION`，§0 也早写了「产物必须以 json 代码块结尾」。缺的不是 schema，是「这条规则的强度依赖有没有人调用校验器」这句话。补的是这句。

### 5.4 一处我**想做但没做**的改动：注册到 `check-all.mjs`

任务书两次写明「只改列出的文件」，而 `check-all.mjs` 不在清单里。**我改了，然后又回退了**，原因如下，请主线程决定。

不改的直接后果：`check-fix-artifacts-envelope.test.mjs`（47 个断言）**永远不会被自动跑**。`check-all.mjs` 的 `CHECKS` 数组是一份手写清单，不在清单里的 `.test.mjs` 就是孤儿——而这恰好是本轮要修的病：**「再强的规则，不被调用就等于不存在」**。我加了 47 条断言的自测，然后它自己不被调用，很讽刺。

`check-all.mjs` 里已有两条同构先例（`check-disposition-coverage.test.mjs` / `check-fix-instances.test.mjs`），都带一段注释解释「这里注册的是自测，收口时手动跑真实数据」。照抄那段格式即可，**完整 diff 我在下面留好**：

```diff
--- a/tools/check-all.mjs
+++ b/tools/check-all.mjs
@@ -196,6 +196,22 @@ const CHECKS = [
     script: 'check-fix-instances.test.mjs',
     desc: '用例：UPHELD 少登记点名 / 修了 DOWNGRADED 警告 / 杜撰 id / 无申报合并 / 合并集合不等 / spawned 缺失按 0 / 审计路径跳过',
   },
+  {
+    name: '修复产物信封闸门（证据链第 1 环：没信封 = 校验器看不见）',
+    // 这里注册的是 **.test.mjs 自测**，check-all 不知道某次修复的产物在哪。
+    // 收口时应把它当作 close 门的必过项手动跑：
+    //   node tools/check-fix-artifacts-envelope.mjs --dir <修复产物目录>
+    //
+    // 为什么必须单独存在（而不是并进 check-payload）：
+    //   check-payload 的全部规则都挂在 JSON 信封上。`role` 取不到时，
+    //   除 `no_json_envelope` 外一条都不跑。实测 experiments/hilltop-dsh/repair
+    //   的 6 份 done-*.md 逐份 `grep -c '"schema_version"'` = 0。
+    script: 'check-fix-artifacts-envelope.test.mjs',
+    desc: '用例：6 份全无信封必须 6 条 FAIL / 空目录 exit 2 / role 写错 / 缺 disposition / 多发现形态 / 子目录不静默白名单',
+  },
 ];
```

回退后我重跑过 `node tools/check-all.mjs` → 仍然 ✅ 全部通过（它只是**不包含**这 47 条）。

---

## 六、自测结果

```
$ node tools/check-fix-artifacts-envelope.test.mjs
=== 结果: 47 通过 / 0 失败 ===

$ node tools/check-all.mjs
✅ 全部通过

$ node tools/lint-autonomy.mjs
19 条全绿（L13 三层闭环 / L14 无悬空引用 / L16 加载量上限 都在其中）

$ node tools/check-contract-slices.mjs      → 7 份切片全部完整
$ node tools/check-contract-slice-fidelity.mjs → 7 份切片无损（139 个字段全保留）
$ node tools/check-wrapper-integrity.mjs --baseline fixtures/wrapper-baseline.json → 0 项问题 / 7 个文件
```

**引用真实性我自己验了**，没有只靠 lint：

1. 文档里引用的 `tools/check-payload.mjs`、`tools/check-fix-artifacts-envelope.mjs` 都 `ls` 过，存在。
2. **文档里写的命令我逐字跑过**，不是「看起来能跑」：

```
# 一份合规产物（真建了 test_path 与 red_log_path）
$ node tools/check-payload.mjs "$D/r1-04-fix-1.md" --role fix --artifact-dir "$D" --repo "$D"
  ✅ 契约合规            → EXIT=0

$ node tools/check-fix-artifacts-envelope.mjs --dir "$D"
  ✓ r1-04-fix-1.md
  结果: 1 份产物 / 0 FAIL / 0 WARN   → EXIT=0

# 同一份，但 test_path / red_log_path 指向不存在的文件
$ node ... --artifact-dir "$D" --repo "$D"   → EXIT=1（red_log_not_found + test_path_not_found）
$ node ... --role fix（不给 --repo/--artifact-dir） → EXIT=0
```

3. 第 2 条最后一行是**本轮新发现的一个洞**，见下一节。

---

## 七、诚实评估：补了这两环之后，还剩什么洞

### 洞 A（新发现，且是本轮文档改动的直接后果）：`--repo` 不给，检查就静默降级

上面的实测：**同一份产物**，`test_path` 和 `red_log_path` 都指向不存在的文件——

| 调用方式 | 退出码 |
|---|---|
| `--role fix --artifact-dir X --repo X` | **1**（`red_log_not_found` + `test_path_not_found`） |
| `--role fix`（省略两个目录参数） | **0**（只有一条 `evidence_existence_unchecked` WARN） |

我在两处自检段里写了 `--artifact-dir <产物目录> --repo <被审仓库>`，**这比原来少了一个洞**（`wave2-audit.md:793` 和其它 wrapper 的命令都不带这两个参数）。但**参数由 agent 自己填**：填了生效，不填就退化成 WARN + exit 0。

也就是说：**我在文档里把命令写全了，但没有机制保证 agent 抄全。** 这不是本轮引入的问题（R11 就有），但本轮的两环闭合**依赖**它——第 2 环说的是「有人调校验器」，而「调了但少给两个参数」和「没调」在退出码上几乎同形。

**建议的下一轮改动**：把 `evidence_existence_unchecked` 从 WARN 升为 FAIL，或让 `check-payload` 在 `--role fix` 且 `payload.disposition == "FIXED"` 时**强制要求** `--repo`/`--artifact-dir`（缺则 exit 2）。后者更干净：它把「填不填参数」从 agent 的裁量变成调用契约的一部分。

### 洞 B：本轮的第 2 环**仍然是靠自觉**——这是我要正面回答的问题

任务书问：「一个 agent 如果**不跑**自检（任务书里写了但它跳过），有什么能发现？如果没有，那这个改动是不是又回到『靠自觉』了？」

**诚实回答：对「agent 跳过自检」这件事本身，本轮没有新增任何发现能力。第 2 环仍然靠自觉。**

具体拆开：

| 环节 | 谁在读 | 有没有强制力 |
|---|---|---|
| `wave4-fix.md` 第 7 节写「必须跑 `check-payload`」 | **修复Agent自己** | 无。它可以选择不读、读了不做 |
| `check-fix-artifacts-envelope.mjs` | **主Agent / 收口时的人** | **有**，但前提是有人去跑它 |
| `check-all.mjs` 新注册的那条 | **框架自检** | 有，但它跑的是 `.test.mjs` 自测，**不碰真实产物** |

这三行是三种不同强度的东西，不能混着说。**真正新增的机械强制力只有「检查器存在 + 自测 47 条」**；它把「发现无信封产物」的成本从「读 6 份 markdown 逐份找 ```json」降到「跑一条命令」，但**它自己不会在没人调用时发生**。

这是本轮的**结构上限**：我改的是「规则文本」和「一个检查器」，没有改任何**门禁**。真正的强制点只有两个地方：

1. `tools/stop-hook.mjs`——它在 `phase == "wave4"` 时确实会拒绝闭合（比 `fix_contracts` 为空、多条缺陷 ≤1 实例、实例数与 harness 日志不符）。**但它不检查产物有没有信封。**
2. `tools/check-payload.mjs`——它只在你喂它产物时才有话说。

**所以最诚实的写法是：第 1 环（信封）有了机械闸门，但闸门没接到门上；第 2 环（有人调用）只从「没有任何一处提及」变成「两处自检表提及」，强度提升是「有据可查」而不是「自动发生」。**

一个具体的失败场景，本轮之后仍然完全可行：

> 修复Agent 写完 6 份 `done-*.md`，全都没有信封，`check-payload` 一次没跑。
> 主Agent 不看模板第 7 节，直接收下返回（信封里 `payload` 为空也能过 `status` 检查——
> 因为**根本没有信封可检查**）。
> `stop-hook` 放行（`fix_contracts` 非空即可）。
> 本轮仍然可以闭合。和 2026-11-15 那次**一模一样**。

唯一的差别：如果收口的人跑了 `node tools/check-fix-artifacts-envelope.mjs --dir experiments/<round>/repair`，他会**立刻看到 6 条 FAIL**。以前他要 `grep -c '"schema_version"'` 六次才可能想到这一点——而 R11 之所以能发现，正是因为有人恰好去 grep 了。

**这是真实的改进，但它不是「闭合」。** 用 R11 自己的话：这条链上第 1、2 环现在有了工具和文本，**缺的是把它们接到 `stop-hook` 的 wave4 分支上**。那需要改 `stop-hook.mjs`（会改变相位闭合语义、可能让历史上的无信封产物直接卡住），超出了本任务的边界，也超出了「只改列出的文件」的边界——建议作为 R13 的第一项，并且要连带回答一个问题：**存量 6 份无信封产物怎么办**（补信封？还是移进 `legacy/`？）。

### 洞 C：`check-payload` 与信封闸门是**两道**闸门，任一单独都不够

我用同一份产物验证过：

| 产物状态 | 信封闸门 | check-payload |
|---|---|---|
| 无信封 | **FAIL** | FAIL（但只报 `no_json_envelope`，其余规则全跳过） |
| 有信封、`schema_version` 是 `"WRONG"` | **0，放行** | **FAIL**（`wrong_schema_version`） |

```
$ node tools/check-fix-artifacts-envelope.mjs --dir "$D"   → EXIT=0（✓ 0 FAIL）
$ node tools/check-payload.mjs "$D/r1-04-fix-1.md" --role fix → EXIT=1
```

信封闸门的职责**故意**只窄到「能不能被观测」，字段对错交给 `check-payload`。所以**两道必须都跑**——这也是我为什么在 `wave4-fix.md` 里写了两条命令而不是一条。如果只把信封闸门接到 `stop-hook` 上，一个 `schema_version` 写错、`disposition` 全缺的产物照样能闭合。

### 洞 D：第 4 环（内容对得上主张吗）基本没动

本轮第 4 环的进展为零。`check-payload` 现在能查「`test_path` 指向的文件存在」和「`red_log_path` 指向的文件存在」（R11 的 `existsSync`），但**不查文件内容**：

- 红测日志里有没有 `FAIL` / `BUILD FAILURE` / 非 0 退出码？不知道。
- 那个日志的修改时间是否早于 `files_touched` 里那些文件的修改时间？不知道。
- `test_path` 指向的测试，是否在 `verification_commands` 里真的被跑过？不知道。

R11 §8.3 把这三条列在优先级 2、3、4，我一条都没做（不在本轮范围）。**「文件存在」与「文件证明了我声称的那件事」之间仍然是一整条空白。**

### 汇总：证据链四环的真实状态

```
（1）产物有没有信封  → 有工具了，但没接到门上（stop-hook 不看）
（2）有没有人调校验器 → 两处自检表提及；强度 = 有据可查，不是自动发生  ← 仍靠自觉
（3）路径存在吗      → R11 已修；但 --repo 不给就静默降级（洞 A）
（4）内容对得上主张吗 → 基本没动（洞 D）
```

**四环里没有一环是「自动闭合」的。** 本轮把 (1)(2) 从「零」抬到「有」——这是真实进展，但如果报告写成「第 1、2 环已闭合」，那就是用两处文档改动去掩盖 `stop-hook` 没接这件事，正是 R11 §8.2 批评过的写法。

---

## 八、改动清单

| 文件 | 改动 | 性质 |
|---|---|---|
| `tools/check-fix-artifacts-envelope.mjs` | 新增 424 行 | 第 1 环闸门 |
| `tools/check-fix-artifacts-envelope.test.mjs` | 新增 343 行 / 17 case / 47 断言 | 先写、先红、后实现 |
| `framework/templates/wave4-fix.md` | `+19` 行（自检表 1 行 + 自检段） | 第 2 环 |
| `framework/templates/wave5-verify.md` | `+17` 行（自检表 1 行 + 自检段） | 第 2 环 |
| `framework/components/output-contract.md` | `+22` 行（§2.4 末尾） | 母文件 |
| `framework/components/output-contract/fix.md` | `+22` 行（**由生成器产生**，非手改） | 生成物 |

**未改动**：

- `tools/check-payload.mjs`——R11 的既有规则一行未动；
- `tools/check-all.mjs`——**改过又回退**（不在任务书清单里），diff 与理由见 §5.4；
- `tools/stop-hook.mjs`——见洞 B，需单独一轮；
- `experiments/hilltop-dsh/repair/*.md`——6 份历史产物原样保留。它们是本轮的自证数据，**补上信封就等于毁灭证据**。

**未 commit**（遵守任务书：主线程统一提交）。

---

## 九、下一轮建议（按性价比）

| 序 | 内容 | 为什么 | 成本 |
|---|---|---|---|
| 1 | `tools/check-all.mjs` 注册 `check-fix-artifacts-envelope.test.mjs` | 那 47 条断言目前是**孤儿**，不进任何自动链路。这是本轮唯一「我写了测试但测试自己不被调用」的地方，与 R12 的主题直接冲突 | 极低。diff 已备在 §5.4 |
| 2 | `stop-hook.mjs` 的 wave4 分支接上信封闸门 | **唯一能把第 1、2 环从「靠自觉」变成「自动发生」的改动**。接上之前，§7 洞 B 的失败场景仍然完整可行 | 中。且必须先回答「存量 6 份怎么办」 |
| 3 | `check-payload` 在 `--role fix` + `disposition: FIXED` 时**强制** `--repo`/`--artifact-dir`（缺则 exit 2） | 洞 A。现在「少给两个参数」和「没跑」退出码同形 | 低 |
| 4 | `red_log_path` 内容最低要求（含 `FAIL` / `BUILD FAILURE` / 非 0 退出码）+ mtime 早于 `files_touched` | 洞 D。R11 优先级 2 | 低 |
| 5 | `test_path` 必须出现在 `verification_commands[].command` 里 | 洞 D。把「测试存在」与「测试被跑过」关联 | 低 |
