# FIX-R4 报告 · 发现去向表机械对账器

**任务**：新增 `tools/check-disposition-coverage.mjs`，让「31 条发现从未被处理」这类丢失在收口时一次性暴露。

**改动范围**（仅这些，未 commit）：

| 文件 | 性质 |
|---|---|
| `tools/check-disposition-coverage.mjs` | 新建 · 校验器 |
| `tools/check-disposition-coverage.test.mjs` | 新建 · 自测（60 断言 / 22 case） |
| `experiments/hilltop-dsh/disposition-ledger-example.md` | 新建 · 真实数据示例去向表 |
| `tools/check-all.mjs` | 修改 · CHECKS 数组加 1 项（+注释说明它跑的是自测） |
| `experiments/hilltop-dsh/FIX-R4-report.md` | 新建 · 本文 |

---

## 一、规则清单

17 条 rule，每条独立命名。级别：**FAIL** 阻断（exit 1）、**WARN** 可见但不阻断、**CONFIG** 配置错误（exit 2）。

### 配置错误类（exit 2，绝不降级为「覆盖率高」）

| rule | 触发条件 | 错误消息要点 |
|---|---|---|
| `artifacts_missing` | `--artifacts` 目录不存在 / 不是目录 / 没有任何 `.md` | 「产物目录不存在」 |
| `artifacts_contain_subdirectories` | 产物目录下有子目录 | 「子目录里的产物不会进分母，等于凭空白名单」 |
| `artifact_json_invalid` | `.md` 里的 JSON 信封解析失败 | 「解析不出信封就不能当作『这份产物没有 finding』，否则分母会悄悄缩水」 |
| `artifact_without_envelope` | `.md` 里找不到 ```json 信封 | 「未解析的产物等于凭空消失」 |
| `artifact_without_findings` | 信封里没有 `payload.findings[]`，或某条 finding 没有 `finding_id` | 「无法作为对账分母」 |
| `artifact_scope_collision` | 两个文件去掉 `-audit.md` 后 scope 相同且有同名 finding | 「后一份会覆盖前一份，分母静默变小」 |
| `ledger_missing` | `--ledger` 文件不存在 | 「这不是『覆盖率 100%』——是没有分母」 |
| `ledger_unparsable` | 去向表里找不到含 `finding_id` + `disposition` 两列的表头 | 「无法解析去向表」 |

### 覆盖率类（FAIL，exit 1）

| rule | 触发条件 | 错误消息要点 |
|---|---|---|
| `duplicate_finding_id_in_artifacts` | **同一份**产物内 `finding_id` 重复 | 「同一文件内重复 N 次，下游按 id 挂接时会静默串线（N 条只能保住 1 条）」 |
| `ambiguous_finding_reference` | 去向表用裸 id，但该 id 在 ≥2 份产物里都有 | 「裸 id 无法确定指哪一条，必须写成 `scope::id`」 |
| `ledger_duplicate_id` | 去向表同一 id 出现两次 | 「后一行会悄悄覆盖前一行」 |
| **`finding_without_disposition`** | **产物里有、去向表里没有 —— 逐条列出** | 「（severity，file:line）没有任何 disposition——它从未被表态，也就可能从未被处理」 |
| `disposition_without_finding` | 去向表里有、产物里没有（且非 `NEW_FINDING`） | 「去向表不能凭空多出 id（会掩盖『表填满了但内容是编的』）」；附最接近的真实 id 提示 |
| `invalid_disposition` | 不在 `FIXED\|WONT_FIX\|DEFERRED\|NEW_FINDING` 内 | 「只能取四枚举」 |
| `disposition_missing_reason` | `WONT_FIX`/`DEFERRED` 且「依据」去空白后 < 10 字 | 「『不修』和『暂缓』都是判断，必须写理由，否则它们和『忘了』无法区分」 |

### 汇总类（WARN，`--strict-high` 时升级为 FAIL）

| rule | 触发条件 | 错误消息要点 |
|---|---|---|
| `cross_artifact_id_collision` | 裸 `finding_id` 跨产物撞名 | 「去向表必须用 `scope::id` 指定，裸 id 会被判为歧义」（提示，不阻断——各轮独立编号是合理的） |
| `high_severity_unaccounted` | `severity: HIGH` 且 disposition 为 `DEFERRED` 或无 disposition，计数 > 0 | 「N 条 HIGH 处于 DEFERRED / 无去向：……全部填 DEFERRED 能让覆盖率 100%，却让最该修的 HIGH 继续留在线上」 |

### 退出码

`0` 全部表态（允许 WARN） / `1` 有覆盖率 FAIL / `2` 配置错误。

### 去向表格式（已写进 `--help` 与文件头注释）

```markdown
| finding_id | disposition | 依据 |
|---|---|---|
| round1-core::F2 | FIXED | #7 |
| round3-A::A-04/a | WONT_FIX | 文案已告知，设计意图 |
| round2-mechanics::F3 | DEFERRED | 等 #7 合并后一起处理 |
```

`finding_id` 三种写法：`scope::id`（推荐）、`scope/id`、裸 id（仅在全局唯一时接受）。scope = 产物文件名去掉 `-audit.md`。子主张后缀 `A-04/a` 按基础 id `A-04` 归属。

---

## 二、实测：不写去向表

**这是本次最关键的一张证据。** 用真实 7 份产物 + 一张只有表头的空去向表：

```
$ node tools/check-disposition-coverage.mjs \
    --artifacts experiments/hilltop-dsh/out --ledger <空表>

  解析产物: 7 个文件，38 条 finding（HIGH 8 / MEDIUM 22 / LOW 8）
  去向表:   0 行

✗ [finding_without_disposition] round1-core::F1（MEDIUM，round1-core-audit.md:422）没有任何 disposition……
✗ [finding_without_disposition] round1-core::F2（MEDIUM，round1-core-audit.md:305）……
   … （共 38 行，逐条点名，涵盖全部 7 份产物）…
✗ [finding_without_disposition] round3-C::F7（LOW，round3-C-audit.md:441）……

! [cross_artifact_id_collision] F1/F2/F3/F4/F5 跨产物撞名（5 条提示）
! [high_severity_unaccounted] 8 条 HIGH 处于 DEFERRED / 无去向：……

合计: 38 条 finding / 已表态 0 / 未表态 38
合计: 38 FAIL / 6 WARN / 0 PASS

结论：38 条 finding 从未被表态。
EXIT=1
```

**JSON 汇总（机器可读）**：

```json
{"findings":38,"rawFindings":38,"accounted":0,"unaccounted":38,"newFindings":0,
 "high":8,"highUnaccounted":8,"severity":{"MEDIUM":22,"HIGH":8,"LOW":8}}
byRule: {"finding_without_disposition":38,"cross_artifact_id_collision":5,
         "high_severity_unaccounted":1}
```

**若连去向表文件都不给**（`--ledger <不存在的路径>`）→ `EXIT=2`，报 `ledger_missing`：
> 「这不是『覆盖率 100%』——是没有分母。收口前必须逐条产出 disposition。」

这正是要求的「38 条全部报错」：逐条点名，不是只报一个百分比。

---

## 三、实测：写示例去向表后全绿

`experiments/hilltop-dsh/disposition-ledger-example.md`，按真实修复情况填写：

- **6 条 FIXED**：#7→`round1-core::F2`；#5→`round2-ai::R2-AI-002`；#7+#6→`round2-ai::R2-AI-001`；#2→`round2-mechanics::F1`；#1+#7→`round2-mechanics::F2`；#4→`round3-B::B-01`
- **1 条 WONT_FIX**：#3→`round3-A::A-04/a`（子主张 a，裁决不修；理由「文案已告知未保存会被覆盖，属设计意图」）
- **31 条 DEFERRED**：依据均写「未纳入任何修复任务书」

```
$ node tools/check-disposition-coverage.mjs \
    --artifacts experiments/hilltop-dsh/out \
    --ledger experiments/hilltop-dsh/disposition-ledger-example.md

  解析产物: 7 个文件，38 条 finding（HIGH 8 / MEDIUM 22 / LOW 8）
  去向表:   38 行

! [high_severity_unaccounted] 2 条 HIGH 处于 DEFERRED / 无去向：
    round2-mechanics::F3（DEFERRED）、round3-A::A-01（DEFERRED）——……

合计: 38 条 finding / 已表态 38 / 未表态 0
合计: 0 FAIL / 6 WARN / 38 PASS

结论：全部 38 条都已表态，但 2 条 HIGH 仍未闭合（见上）。
EXIT=0
```

### 与任务书给定 finding_id 的差异

任务书给的对照表与产物**完全一致**，无差异。逐条核对结果：

| 修复 | 任务书给的原 finding | 产物里的实际 key | 一致? |
|---|---|---|---|
| #2 | R2-mechanics F1 | `round2-mechanics::F1`（HIGH，TabListManager:298） | ✅ |
| #5 | R2-AI-002 | `round2-ai::R2-AI-002`（HIGH，AirdropSpawnGoal:237） | ✅ |
| #7 | R1-core F2 + R2-AI-001 钳制 + R2-mech F2 cost | `round1-core::F2` / `round2-ai::R2-AI-001` / `round2-mechanics::F2` | ✅ |
| #1 | R2-mechanics F2 | `round2-mechanics::F2`（NodeListener:229） | ✅ |
| #6 | R2-AI-001 | `round2-ai::R2-AI-001`（HIGH，ExplodeBeetleGoal:241） | ✅ |
| #4 | R3-B B-01 | `round3-B::B-01`（HIGH，ArenaResetService:280） | ✅ |
| #3 | R3-A A-04 子主张 a | `round3-A::A-04/a`（HIGH，MainConfigMenu:149） | ✅ |

**唯一需要点名的结构差异**：真实产物的 `finding_id` 在跨产物维度**不唯一**——38 条只有 26 个不同的裸 id（`F1`×4、`F2`×4、`F3`×4、`F4`×3、`F5`×2）。所以去向表**必须**用 `scope::id`；写裸 `F1` 会被 `ambiguous_finding_reference` 判错。这是设计上的有意结果，不是缺陷（见下节）。

**HIGH 算术自洽**：8 HIGH − 5 FIXED − 1 WONT_FIX(A-04) = **2 条 DEFERRED**（`round2-mechanics::F3`、`round3-A::A-01`），与 `DIAG2-coverage-gap.md §1.1` 记录的「2 条 HIGH 至今仍在」完全吻合。校验器点名的正是这两条。

---

## 四、自测结果

```
$ node tools/check-disposition-coverage.test.mjs
=== 结果: 60 通过 / 0 失败 ===
EXIT=0
```

22 个 case、60 个断言，全部合成 fixture（不读 `experiments/`，避免随真实数据漂移）：

| # | case | 覆盖的规则 |
|---|---|---|
| 1 | 全覆盖 | exit 0 |
| 2 | 缺 1 条 | `finding_without_disposition` + **点名该 id** + 计数=1 |
| 3 | 产物内 id 重复 ×3 | `duplicate_finding_id_in_artifacts` |
| 4 | 去向表杜撰 F9 | `disposition_without_finding` + 点名 |
| 5 | WONT_FIX 理由 2 字 | `disposition_missing_reason` |
| 6 | DEFERRED 理由空 | `disposition_missing_reason` |
| 7 | HIGH 被 DEFERRED | `high_severity_unaccounted` 警告（级别 WARN、计数、点名） |
| 8 | 去向表不存在 | exit 2 + `ledger_missing` |
| 9 | 非法 disposition `LATER` | `invalid_disposition` |
| 10 | 去向表同一 id 两行 | `ledger_duplicate_id` |
| 11 | 裸 id 撞名 ×4 | `ambiguous_finding_reference` + 4 条仍算未表态 |
| 12 | 同数据改用 `scope::id` | exit 0（证明要求可满足） |
| 13 | `NEW_FINDING` 不在产物内 | exit 0 + 单独计数，不误判杜撰 |
| 14 | 产物目录不存在 | exit 2 |
| 15 | 信封坏 JSON | exit 2 + `artifact_json_invalid` |
| 16 | `.md` 无信封 | exit 2 + `artifact_without_envelope` |
| 17 | 人读输出样式 | 含 `✗` / `合计` / 条数 |
| 18 | `--help` | 含四枚举 + 两个参数 |
| 19 | `--strict-high` | `high_severity_unaccounted` 升级为 FAIL → exit 1 |
| 20 | 围栏代码块里的示例行 | 不被当真实行 |
| 21 | 产物藏子目录 | exit 2 + `artifacts_contain_subdirectories` |
| 22 | 两文件同 scope | exit 2 + `artifact_scope_collision` |

**红→绿过程**：先写测试，在实现前跑出 **35 失败**（`MODULE_NOT_FOUND`，脚本不存在），再写实现至 60/60。case 20/21/22 是实现期间自查发现的两个绕过口 + 一个围栏解析 bug 后补的（见第五节）。

### 注册进 check-all

`tools/check-all.mjs` 的 `CHECKS` 数组加 1 项，指向 **`.test.mjs` 自测**（不是对真实交付物跑对账）——`check-all` 是「框架自检」，不知道某次审计的产物在哪。条目注释里写清了真正校验交付物要手动跑：

```
node tools/check-disposition-coverage.mjs --artifacts <产物目录> --ledger <去向表.md> [--strict-high]
```

`check-all` 实测（29 项，全绿）：

```
发现去向对账（每条发现是否都被表态过一次）
  用例：漏 1 条点名 / 产物内 id 重复 / 去向表杜撰 / 少理由 / HIGH 被 DEFERRED 警告 / 去向表缺失 exit 2
  → === 结果: 60 通过 / 0 失败 ===
...
✅ 全部通过        EXIT=0
```

---

## 五、这个校验器能不能被绕过？

结论：**默认配置下，「全填 DEFERRED」确实能骗过它——这是真实漏洞，`--strict-high` 是唯一的刹车，而它默认关闭。**

我实测了这条路径：把真实 38 条全部填成 `DEFERRED`（依据写满 10 字以上以绕过理由检查）：

```
=== all-DEFERRED, 默认 ===       EXIT=0   ← 全绿，骗过
=== all-DEFERRED, --strict-high ===  EXIT=1   ← 被拦住
```

### 为什么默认模式拦不住

方向的根本不对称：本校验器**只能证明「每条都被表过态」，不能证明「表态是对的」**。
- 它回答「有没有表态」——这是机械可判的；
- 它不回答「`FIXED` 是不是真修了、`DEFERRED` 的理由成不成立」——那要读代码和测试，超出脚本能力（与 `verify-artifacts.mjs` 明确划的「不检查什么」同一原则）。

所以「全部 DEFERRED」在覆盖率维度上是**合法**的：它确实为每条都做了显式判断。它诚实地说「一条都没修、全部延后」——只不过这个判断本身可能是失职。

### `high_severity_unaccounted` 能挡住什么、挡不住什么

- **能挡住**：把 `HIGH` 混进 31 条 `DEFERRED` 里静默消失。实测示例表里它准确点名了 `round2-mechanics::F3`、`round3-A::A-01` 两条，正是当日真实仍在 HEAD 的两条 HIGH。这正是原事故里「2 条 HIGH 至今仍在」的直接证据。
- **挡不住**：`WONT_FIX`。`A-04` 是 HIGH，但它填 `WONT_FIX`（裁决不修）就不计入「悬空」——因为裁决不修确实是合法决策。我把这一层写进了示例表末尾的注 2，明确「HIGH 还剩几条的真实答案是 2 条，不是 3 条」。
- **默认 WARN 级别挡不住**：`--strict-high` 才升 FAIL。**交付闸门必须开这个开关**，否则同上，全 DEFERRED 仍然 EXIT=0。

### 另外两个我自查发现并堵上的口子

1. **产物藏在子目录**：原实现只 `readdirSync` 顶层，`out/round1/` 里的产物既不进分母也不报错 → 整份产物凭空消失。现改为 `artifacts_contain_subdirectories`，exit 2。
2. **两文件同 scope**：`foo-audit.md` 与 `foo.md` 都解析成 scope `foo`，后者覆盖前者的同名 finding，分母静默变小。现改为 `artifact_scope_collision`，exit 2。

### 仍然存在、且我判断应当保留的绕过面

- **`DEFERRED` 理由可以笼统但够长**：「未纳入任何修复任务书」正好 11 字，过了 10 字门槛。这是**刻意的**——这句理由准确描述了真实情况（它们确实没进任务书），逼它写更长的措辞只会产生套话。真正该挡「全 DEFERRED」的不是更严的字数，而是 `--strict-high` 对 HIGH 的拦截 + 人工复核 DEFERRED 集合。
- **`NEW_FINDING` 是个后门**：任何杜撰的 id 标成 `NEW_FINDING` 都能进表且不报错（case 13 就是这个语义）。我没有收紧它，因为修复过程中确实会冒出新发现（#8 就是真实的第 39 条）。代价是它可被滥用为「垃圾桶」；缓解是它被单独计数（`totals.newFindings`），审计时看一眼这个数字即可发现异常膨胀。
- **`FIXED` 不验证测试**：与 R3 的 fix 契约一致只查枚举与理由，不查 `test_path` / 红测日志是否存在。那属于 `verify-artifacts.mjs` 的职责，本脚本不重复实现。

**一句话**：它把「静默消失」变成「必须显式写下一个词」。写下 `DEFERRED` 是有成本的、可审计的、可被 `--strict-high` 和人工复核挑出来的；而原来那 31 条，连「写下」这一步都没有。
