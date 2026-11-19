# 契约 vs 实现：偏差方向审计

审计对象：`framework/components/output-contract.md`（859 行）+ 8 份角色切片 + 7 份 wrapper **对** `tools/check-payload.mjs`（1675 行，104 条规则名）。
探针全部落在 `.probe-contract/`（已删除），未修改 `tools/` 与 `framework/` 下任何文件。

---

## 0. 一句话结论

**偏差的主方向是「校验器更松」，不是「校验器更严」。**

共清点 **120 条**可机械判定的要求（主表逐条编号，可核对）：

| 类 | 条数 | 编号 |
|---|---|---|
| **A** 一致 | **64** | 1,3,6,8,9,10,11,14,15,16,19,20,25,26,27,29,30,31,37,38,40,43,44,45,46,47,51,52,53,55,56,58,60,62,64,66,67,68,69,70,72,73,76,78,80,83,86,87,88,89,90,91,92,93,94,99,100,101,102,103,105,106,108,109 |
| **B** 校验器更严 | **9** | 2,21,41,54,77,79,82,98,120 |
| **C** 契约空文 | **40** | 4,5,7,12,13,17,22,28,32,33,34,35,36,39,42,48,49,50,61,63,65,71,74,81,84,85,95,96,97,104,107,110,111,112,113,115,116,117,118,119 |
| **D** 语义不一致 | **6** | 18,23,24,57,59,75 |
| **B/D 混合**（契约内部自相矛盾） | **1** | 114 |

（64 + 9 + 40 + 6 + 1 = 120。若把 #114 并入 B，则 B=10。）

也就是说：**一个守规矩的 Agent 大概率能通过；一个不守规矩的 Agent 也能通过。**
B 类（照契约写却被打回）确实存在，而且最恶劣的两条来自 **wrapper**（不是母契约）——wrapper 是派发给子 Agent 的「原话」，它和校验器直接对撞。C 类的量级则大得多：契约反复自我标榜「这道校验是机械的」，实际有 40 处不是。

**高一致性占比**：64/120 ≈ **53%** 的条目是 A。这个数字比「契约一片空文」的直觉要好——校验器确实把「门 0」「枚举闭集」「计数自洽」「disposition」这几块做扎实了。问题集中在**「角色内的字段完整性」**和**「error 对象」**这两片空白上，它们恰好是**失败路径**和**上游产物**，也就是最难被人肉发现的地方。

---

## 1. 主表

分类：**A** 一致 / **B** 校验器更严（契约没要求却报错）/ **C** 契约空文（要求了没人查）/ **D** 语义不一致。
「实证」列给的是探针编号与观测；**没有实证的标 PLAUSIBLE**。

### §0 / §1 通用信封

| # | 契约条目 | 契约原文（文件:行） | 校验器行为（文件:行） | 类 | 实证 | 置信度 |
|---|---|---|---|---|---|---|
| 1 | 产物必须以 json 代码块结尾 | `output-contract.md:36` | `check-payload.mjs:458` 抽块；缺块报 `no_json_envelope` | A | p22 → exit 1 | 高 |
| 2 | 代码块语言标识必须**恰好小写** `json` | `:36` 只写「一个 json 代码块」；`wrappers/*.md:57` 写 ` ```json ` | `:458` 正则 `/```json\s*\n/`，大小写敏感 | **B** | ` ```JSON ` (u10)、` ```Json ` (u11)、` ``` json ` (u9) → **全部 exit 1 `no_json_envelope`** | 高 |
| 3 | `schema_version` 必须精确等于 `output-contract-v1` | `:119` | `:568` `if (envelope.schema_version && …)` | A | 非法值 → `wrong_schema_version` | 高 |
| 4 | 同上，空串也算「不匹配」 | `:119` | 空串为假值 → 整条检查被跳过 | **C** | s1 `schema_version:""` → **exit 0 ✅** | 高 |
| 5 | 顶层 8 字段「必填，缺一即 CONTRACT_VIOLATION」（含 `error`、`artifact_path`） | `:87`、`:89-100` | `:538` `REQUIRED_TOP` 只有 6 个，**不含 `error` / `artifact_path`** | **C** | r9 无 `error` 键 → exit 0 | 高 |
| 6 | `agent_id` 必填 | `:120`、`:87` | `:556` `missing_top_field` | A | p21 缺 → exit 1 | 高 |
| 7 | `agent_id` 类型为 string | `:120` | 无类型检查 | **C** | t6 `agent_id: 7` → exit 0 | 高 |
| 8 | `role` ∈ 七值（母契约 `:93` 列 7 个；`:121` 正文却写「六个」） | `:93` / `:121` | `:575` `VALID_ROLES` 含 7 个（含 planner） | A（校验器对，**契约正文自相矛盾**） | p1 等全部通过 | 高 |
| 9 | `role` 必须等于派发时指定的 role | `:801` | `:582` `role_mismatch` | A | — | 高 |
| 10 | `status` ∈ 四值 | `:122` | `:588` `invalid_status` | A | — | 高 |
| 11 | `contract_valid` 必填 | `:123` | `:538` + `:562` | A | 缺失/null → exit 1 | 高 |
| 12 | `contract_valid` 类型为 boolean | `:123` 表格「boolean」 | 无类型检查 | **C** | t5 `"yes"` → exit 0 | 高 |
| 13 | `status=SUCCESS` ⇒ `contract_valid` 必须为 `true` | `:803`（§4 检查序 6） | **零检查** | **C** | t4 / p7 `contract_valid:false` + SUCCESS → **exit 0 ✅** | 高 |
| 14 | `SUCCESS` ⇒ `artifact_path` 必填 | `:106` | `:596` `missing_artifact_path` | A | — | 高 |
| 15 | `artifact_path` 必须为 string | `:124` | `:610` `artifact_path_wrong_type` | A | — | 高 |
| 16 | `artifact_path` 指向的文件必须存在 | `:106`、`:113` | `:652` `artifact_not_found`（支持 `<OUTDIR>` 占位） | A | q14 → exit 1 | 高 |
| 17 | `artifact_path` 只允许「仓库外绝对路径 **或** `<OUTDIR>` 相对路径」 | `:102` | `:642` 相对路径按**产物所在目录**解析，存在即放行 | **C**（多接受一种契约未列形态） | bb2 `artifact_path:"bb2-target.md"` → **exit 0 ✅** | 高 |
| 18 | `payload` 必须是对象 | `:125`（`oneOf` 分支） | `:688` `k in envelope.payload` 对非对象**抛 TypeError** | **D**（不是判违规，是校验器崩溃） | p18 `payload:"not-an-object"` → **JS 堆栈 exit 1**，无 `[rule]` 输出 | 高 |

### §2.0 planner

| # | 契约条目 | 契约原文 | 校验器行为 | 类 | 实证 | 置信度 |
|---|---|---|---|---|---|---|
| 19 | `tier`/`score`/`members`/`member_count` 必填 | `:170` | `:675` `ROLE_REQUIRED.planner` | A | — | 高 |
| 20 | `member_count == len(members)` | `:176` | `:1406` `count_mismatch`（兼容逐条/聚合两种写法） | A | q11 → exit 1 | 高 |
| 21 | `score` ≠ Σ`score_breakdown` 应为**警告** | `:177`「警告」 | `:1385` **errors.push** `score_mismatch` | **B** | r1（score=3，和=6）→ **exit 1** | 高 |
| 22 | `tier` 与 `score` 不匹配应为**警告** | `:178` | check-payload **零检查** | **C** | r2 `TIER-2`+score 0 → exit 0 | 高 |
| 23 | `tier` ∈ `TIER-0 \| TIER-1 \| TIER-2` | `:154` | check-payload 无枚举检查；`check-plan.mjs:55` 却要求 `T0/T1/T2` | **D**（三套词表打架） | p3b `tier:"TIER-9"` → check-payload **exit 0**；z1 照契约写 `TIER-1` → check-plan 判「应为 T2」 | 高 |
| 24 | `members[]` 元素是 `{agent_id, role, depends_on, note}` | `:157-164` | check-payload 两种形态都收；`check-plan.mjs:64-69` 只认 `{role,count}` + `execute/retrieve/critique/redteam/verify/arbiter` | **D**（照契约写，check-plan **7/10 项失败**） | z1 → check-payload ✅ / check-plan ✗✗✗✗✗✗✗ | 高 |

### §2.1 recon

| # | 契约条目 | 契约原文 | 校验器行为 | 类 | 实证 | 置信度 |
|---|---|---|---|---|---|---|
| 25 | `slice_count`/`audit_slices`/`entry_points`/`unverified` 必填 | `:170` 段后的「必填字段」与 `:285` 对应；wrapper `recon-scout.md` §5 | `:669` | A | — | 高 |
| 26 | `slice_count == len(audit_slices)` | `:251` | `:783` `count_mismatch` | A | — | 高 |
| 27 | `entry_points` 元素必须是对象，含 `location`+`evidence_quote` | `:233` | `:790-807` `entry_point_not_object` / `missing_entry_point_field` | A | — | 高 |
| 28 | `entry_points` 为空数组时，必须在 `unverified` 说明「未发现任何入口」及检查过的类别 | `:233` | **零检查** | **C** | p10（空数组 + unverified 只说别的）→ **exit 0 ✅** | 高 |
| 29 | 切片 `files` 两两不相交 | `:249`、`:246` | `:819` `slice_overlap` | A | q18（同片内重复）→ exit 1 | 高 |
| 30 | `shared_dependencies` 不得混入 `files`/`file_count` | `:246` | `:827` `shared_in_files` | A | — | 高 |
| 31 | `entry_points_truncated:true` ⇒ `unverified` 说明截断 | `:247` | `:840` `silent_truncation` | A | — | 高 |
| 32 | **每片**必填 `line_count`/`oversized_file`/`undersized`/`reachability_hint`/`exclusion_report`/`root_dir`/`is_entry_slice`/`shared_dependencies`/`entry_points_truncated` | `:239-247`（表头逐列标「是」）、`:243` | **零检查**（只查 `slice_count`、`entry_points` 形状、切片相交） | **C** | p9 只给 `slice_id/files/file_count` → **exit 0 ✅** | 高 |
| 33 | `file_count` 与 `files.length` 一致 | `:239` 隐含（`line_count`「与 `file_count` 并列约束」） | **零检查** | **C** | s7（`files` 2 项、`file_count:7`）→ exit 0 | 高 |
| 34 | `entry.kind` ∈ 七值闭集 | `:217` | **零检查**（`ENUM_CHECKS` 不含它） | **C** | s8 `kind:"MADE_UP"` → exit 0 | 高 |
| 35 | `exclusion_report.excluded_source_like` 非空 ⇒ 逐项进 `unverified` | `:243` | **零检查** | **C** | p25 → exit 0 | 高 |

### §2.2a sweep

| # | 契约条目 | 契约原文 | 校验器行为 | 类 | 实证 | 置信度 |
|---|---|---|---|---|---|---|
| 36 | 必填 `slice_id`/`reachability`/`files_read`/`leads`/`lead_count`/`dimension_histogram` | `:285` | `:670` `ROLE_REQUIRED.sweep` **少了 `dimension_histogram`** | **C** | p11 无直方图 → **exit 0 ✅** | 高 |
| 37 | `lead_count == len(leads)` | `:296` | `:760` `count_mismatch` | A | — | 高 |
| 38 | Σ`dimension_histogram` == `lead_count` | `:296` | `:769` `histogram_mismatch`（**仅当直方图存在**） | A | q17 值全为字符串时求和被 `typeof==='number'` 过滤成 0 → 恰好放过（见 #39） | 高 |
| 39 | 直方图各值必须是数字 | `:277-280` | `:771` `.filter(v => typeof v === 'number')` 静默丢弃非数字 | **C** | q17 全写 `"0"` → exit 0 | 高 |
| 40 | `reachability` ∈ 五值闭集 | `:261` | `:707` `invalid_enum_value` | A | — | 高 |
| 41 | `GENERATED` ⇒ `generator_ref` | **母契约未写**；只写在 `templates/wave2a-sweep.md:181` | `:750` `generated_without_generator_ref` | **B**（照母契约写 `null` 被打回） | p12 `reachability:"GENERATED", generator_ref:null` → **exit 1** | 高 |
| 42 | `files_read` 必须承担覆盖率记账（不应为空） | `:298`「覆盖率的记账由 `files_read` 承担」 | **零检查** | **C** | u6 `files_read: []` + `leads: []` → **exit 0 ✅** | 高 |

### §2.2 audit

| # | 契约条目 | 契约原文 | 校验器行为 | 类 | 实证 | 置信度 |
|---|---|---|---|---|---|---|
| 43 | `findings`、`self_checks` 必填 | `:170` 段；`:671` | `:671` | A | — | 高 |
| 44 | `findings` 不得为空数组 | `:384` | `:855` `empty_findings` | A | x1 → exit 1 | 高 |
| 45 | 每条 finding 的 `status` 必填且闭集 | `:364` | `:867` / `:873` | A | r4 → exit 1 | 高 |
| 46 | `finding_id` 必填；用 `id` 属 `wrong_field_name` | `:359` | `:895-905` | A | — | 高 |
| 47 | `evidence` 必须是对象（数组属 `evidence_wrong_shape`） | `:362` | `:907-919` | A | — | 高 |
| 48 | `evidence` 与 `inference` **每一条都必填**（表头「必填」；§4 检查序 8） | `:362`、`:363`、`:805` | 只在**存在时**查形状，**不存在不报** | **C** | p6（两者全缺）→ exit 0；u1（缺 `inference`）→ **exit 0 ✅** | 高 |
| 49 | `dimension` 必填 | `:360` | 只查闭集（存在时） | **C** | p4（无 `dimension`）→ **exit 0 ✅** | 高 |
| 50 | `severity` 必填（闭集 `CRITICAL\|HIGH\|MEDIUM\|LOW`，**不含 null**） | `:361` | 只对 `CONFIRMED` 要求；且 `:702` 枚举把 `null` 当合法值 | **C** | p5（`NO_EVIDENCE_FOUND` 无 severity）→ **exit 0 ✅**；`severity:null` 也过 | 高 |
| 51 | `CONFIRMED` 必须有非空 `file`+`quote` | `:388` 段 | `:933` `confirmed_without_evidence` | A | — | 高 |
| 52 | `CONFIRMED` 必须判 `severity` | `:361` | `:950` `confirmed_without_severity` | A | — | 高 |
| 53 | `CRITICAL` 须有调用链或可复现触发条件 | `:363`（引 `wave2-audit.md §3.3`） | `:963-981` `critical_without_call_chain` | A | v4（中文「调用链：a() → b()」）→ exit 0 | 高 |
| 54 | 同上，判据应接受任何语言的调用链 | `:363` 无语言限定 | `:970` 正则写死中文词 `调用链\|调用路径\|入口` / `caller\|call site` | **B**（D→B：判据绑定中文措辞） | v3 → **exit 1** `critical_without_call_chain` | 高 |
| 55 | 有 `NO_EVIDENCE_FOUND` ⇒ `searched_scope` 含非空 `files_read`+`dimension_checklist` | `:379` | `:988-999` `no_evidence_without_scope` | A | — | 高 |
| 56 | `NO_EVIDENCE_FOUND` 的 `inference.basis` ≥15 字 | `:380` | `:1004` `vacuous_basis`（用 `.length`） | A | — | 高 |
| 57 | 「字」应按实质字符计（契约自己在 `:80-92` 之外未复述；但同族规则 `self_checks` 已用 substance 口径） | `:380` | `:1004` 用 `basis.length`，零宽字符可凑 | **D**（同一文件两种口径） | s3（15 个零宽）→ **exit 0 ✅** | 高 |
| 58 | `self_checks` 三项 + 枚举 `DONE/SKIPPED/NOT_APPLICABLE` | `:331-338` | `:1014-1044` `missing_self_check` / `invalid_self_check_status` | A | — | 高 |
| 59 | `SKIPPED`/`NOT_APPLICABLE` 的 note ≥10 字 | `:334`「至少 10 字」 | `:1037` `String(note).trim().length < 10`（未剥零宽） | **D** | v8（20 个零宽）→ **exit 0 ✅** | 高 |
| 60 | 同一产物内 `finding_id` 不得重复（全角色生效） | `:623` | `:1431-1455` `duplicate_finding_id` | A | q15 → exit 1 | 高 |
| 61 | audit payload 含 `slice_id` | `:305`（schema） | `ROLE_REQUIRED.audit` 只有 `findings`,`self_checks` | **C** | s5（无 `slice_id`）→ exit 0 | 高 |
| 120 | wrapper 原文：「即使一条都没找到，也要写 `"findings": []`…空数组是一个结论」 | `wrappers/audit-specialist.md:82` | `:855` `empty_findings`（errors） | **B**（wrapper 与契约 `:384` 打架，校验器站契约一边） | x1（照 wrapper 原话写 `[]`）→ **exit 1** `empty_findings` | 高 |

### §2.3 critique

| # | 契约条目 | 契约原文 | 校验器行为 | 类 | 实证 | 置信度 |
|---|---|---|---|---|---|---|
| 62 | `critique_role`、`verdicts` 必填 | `:672` 段 | `:672` | A | — | 高 |
| 63 | `critique_role` ∈ `skeptic \| devils_advocate \| arbiter` | `:403`、wrapper `critique-panel.md:83` | **零枚举检查** | **C**（**最危险的一条**：写错一个字母，全部 critique 检查静默关闭） | q1 `"Skeptic"`、q2 `"judge"` + 垃圾 verdict → **双双 exit 0 ✅** | 高 |
| 64 | `verdict` 按子角色分支闭集 | `:477-481` | `:1065-1080` `invalid_verdict_enum` | A | — | 高 |
| 65 | 每条 verdict 必须有 `verdict` 值 | wrapper `critique-panel.md:60`「每项含 `finding_id` 与 `verdict`」 | `:1073` 只在 `v.verdict !== undefined` 时检查 | **C** | u2（无 `verdict` 字段，five_step 齐全）→ **exit 0 ✅** | 高 |
| 66 | `devils_advocate` 不填 `verdicts`（必须空数组） | `:480` | `:1082` `devils_advocate_has_verdicts` | A | — | 高 |
| 67 | DA 四个扫描布尔必须均为 `true` | `:485` | `:1120-1130` `missing_scan_flag` | A | — | 高 |
| 68 | `discipline_audit` 仅 skeptic 必填、其余越界 | `:533` | `:1139-1161` | A | q5（arbiter 带）→ exit 1 | 高 |
| 69 | `discipline_audit.performed` 必填 | `:462-470`、`:546` | `:1149` `discipline_audit_no_performed` | A | — | 高 |
| 70 | `five_step` 仅 skeptic 必填，五键齐全 | `:493` | `:1176-1192` | A | p13 → exit 1 | 高 |
| 71 | `five_step` 在 DA/arbiter 中「返回即越界，判 CONTRACT_VIOLATION」 | `:493` | **零检查** | **C** | r13（arbiter 的 verdict 带 `five_step`）→ **exit 0 ✅** | 高 |
| 72 | `runtime_applicable` 仅 skeptic 必填、每条都要有 | `:495` | `:1284` `missing_runtime_applicable` | A | — | 高 |
| 73 | `runtime_applicable:true` ⇒ 必须有 `runtime_evidence` | `:511` | `:1291` `runtime_required_but_missing` | A | u3 → exit 1 | 高 |
| 74 | `runtime_applicable:false` 却给 `runtime_evidence` → **警告** | `:512` | **零检查**（连警告都没有） | **C** | v1（false + 完整 evidence）→ exit 0，warnings 里无对应项 | 高 |
| 75 | `control_case` 必填；为空时 `runtime_evidence` **整段不采信** | `:544`（「必填」「不采信」） | `:1298` **warnings.push** `runtime_no_control` | **D**（契约说必填/不采信，校验器只 WARN） | r10（有 observed 无 control_case）→ **exit 0 ✅** | 高 |
| 76 | `runtime_evidence.observed` 必填 | `:432` 段、`:1306` | `:1306` `runtime_no_output`（error） | A | p14 → exit 1 | 高 |
| 77 | `runtime_evidence.main_path` 三字段 | **母契约与切片中零出现**（只有 `templates/wave2-audit.md:218`，且那是 audit 角色） | `:1315-1333` 对 **critique** 的 `runtime_evidence` 施加 `main_path` 检查 | **B**（契约完全没有的字段，缺失/不全都报） | p19（`main_path:{command}`）→ **exit 1** `runtime_main_path_incomplete` | 高 |
| 78 | `sub_claims` 四条规则（claim+verdict、闭集、refuted 须有据、机制/后果须解释） | `:522-529` | `:1223-1259` | A | — | 高 |
| 79 | skeptic `holds` 时 `reason` 须有实质内容 | `:410`「必须引用具体证据或指出具体缺失」——**无字数下限** | `:1206` 要求 `substanceLength ≥ 15` | **B** | r3 `reason:"第 42 行确无锁保护"`（具体且可核对）→ **exit 1** `vacuous_reason` | 高 |
| 80 | `reason` 否定危害/后果 ⇒ 必须拆 `sub_claims` | `:518` | `:1215-1221` `missing_sub_claims` | A | — | 高 |
| 81 | `refuted` 在**五个**敏感领域（内存安全/并发/声明一致性/行为兼容/未使用参数）必须有 `direct_contradiction` | `:489` | `:1265-1279` 只对 `dimension==='concurrency'` 硬判，其余降 WARN | **C**（5 个域只守住 1 个） | 其余四域 `refuted` 无 `direct_contradiction` → exit 0 + WARN | 高 |
| 82 | `verdicts` 必须覆盖全部 `target_finding_ids` | **母契约只在 `:590` 以规则名反向引用**（「与锐评的 `verdict_missing_for_target` 同构」），从未正面写出该要求 | `:1052-1062` errors.push | **B**（弱：有间接依据） | aa1（3 个 target 只给 1 条 verdict）→ **exit 1** | 高 |
| 83 | `coverage_gaps[].kind` 闭集 | `:447` | `:1093-1101` | A | — | 高 |
| 84 | `coverage_gaps[]` 每条要 `gap_id`/`kind`/`target`/`evidence.observation`/`potential_impact`/`recommended_action` | `:445-452`、`:1102` 注释自己也这么写 | `:1104` 只查 `kind`/`target`/`recommended_action` | **C** | q7（缺 `gap_id`/`evidence`/`potential_impact`）→ **exit 0 ✅** | 高 |
| 85 | `pattern_sweep` 在 DA + 存在 HIGH/CRITICAL 时必填 | `:531` | 只查 `:1166` **越界**（非 DA 返回报错）；**「必须填」一侧零检查** | **C** | r12（DA 完全不给 `pattern_sweep`）→ **exit 0 ✅** | 高 |

### §2.4 fix

| # | 契约条目 | 契约原文 | 校验器行为 | 类 | 实证 | 置信度 |
|---|---|---|---|---|---|---|
| 86 | `disposition` 必填且闭集四值 | `:573-583` | `:217-231` `missing_disposition` / `invalid_disposition` | A | — | 高 |
| 87 | `FIXED` ⇒ `test_path` | `:577` | `:253` `fixed_without_test` | A | — | 高 |
| 88 | `FIXED` ⇒ `red_log_path` | `:577` | `:260` `fixed_without_red_log` | A | v6 → exit 1 | 高 |
| 89 | `red_log_path` 不得落在 `target/` | `:613` | `:239` `red_log_in_target` | A | — | 高 |
| 90 | `red_log_path`/`test_path` 解析后必须存在 | `:609`「与 `red_log_path` / `test_path` 同一纪律」 | `:282-320` `red_log_not_found` / `test_path_not_found` | A | — | 高 |
| 91 | `WONT_FIX`/`DEFERRED` 的 `disposition_reason` ≥20 字 | `:578-579` | `:424-439`（用 `substanceLength`，比「字」更严） | A（偏严但方向正确） | bb1（22 实质字）→ exit 0 | 高 |
| 92 | `DEFERRED` ⇒ `next_round` | `:579` | `:443` `deferred_without_trigger` | A | — | 高 |
| 93 | `files_touched` 每个 `path` 必须解析到真实文件；`FIXED` 时空数组违规 | `:599-611` | `:326-397` `files_touched_*` | A | — | 高 |
| 94 | `dispositions[]` 覆盖 `target_finding_ids` | `:590-591` | `:1364-1379` `disposition_missing_for_target` | A | q15 → exit 1 | 高 |
| 95 | `finding_id` 必填（fix payload 顶层 / 每个 disposition 条目） | `:555` | `:1367` 只用它做覆盖集合，**不要求存在** | **C** | p16（无 `finding_id`，WONT_FIX）→ **exit 0 ✅** | 高 |
| 96 | `verification_commands[].result` ∈ `passed\|failed\|not_run` | `:565` | **零检查** | **C** | s6 `result:"WHATEVER"` → exit 0 | 高 |
| 97 | `affected_issues` 字段必须存在（即使空数组） | `:807`（§4 检查序 10）、`:567`、`:621` | **零检查** | **C** | p16 无 `affected_issues` → exit 0 | 高 |
| 98 | wrapper 原文：fix `payload` **只包含四个字段** | `wrappers/fix-worker.md:59` | `:1354` 把整个 payload 当 disposition 条目，**强制要 `disposition`** | **B**（照 wrapper 原话写必被打回） | w1（严格四字段）→ **exit 1** `missing_disposition` | 高 |

### §2.5 verify

| # | 契约条目 | 契约原文 | 校验器行为 | 类 | 实证 | 置信度 |
|---|---|---|---|---|---|---|
| 99 | `finding_id`、`verdict` 必填 | `:674` 段 | `:674` | A | — | 高 |
| 100 | `verdict` ∈ `PASS \| FAIL` | `:657`、`:739` | `:1475-1482` `invalid_verify_verdict` | A | — | 高 |
| 101 | `FAIL` ⇒ `failure_category` 且闭集 | `:702` | `:1487` / `:1493` | A | — | 高 |
| 102 | `FAIL` ⇒ `failure_trigger` | `:686` | `:1500` `missing_failure_trigger` | A | — | 高 |
| 103 | `ENVIRONMENT` 应改用 `RETRYABLE_FAILURE` | `:702` | `:1508` warning `environment_should_be_retryable` | A | — | 高 |
| 104 | `escalation_required` 必填 | `:697`（表格「必填=是」） | **零检查** | **C** | q9 / p15 / bb3（全缺该字段）→ **exit 0 ✅** | 高 |
| 105 | `mutation_check` 必填、闭集、`skipped` 须写明两种理由之一 | `:698` | `:1558-1582` | A | — | 高 |
| 106 | `mutation_scope` 在 `performed` 时必填、闭集 | `:699` | `:1585-1600` | A | — | 高 |
| 107 | 对「函数返回值决定用户可见行为」的修复，`mutation_scope` 必须 `implementation_and_callsite`，否则须在 `notes` 说明 | `:699` | **零检查** | **C** | r19（`implementation_only` + notes「通过」）→ **exit 0 ✅** | 高 |
| 108 | `input_space_basis` 必填、闭集 | `:703` | `:1614-1627` | A | — | 高 |
| 109 | `single_sample`/`unknown` ⇒ `escalation_required: true` | `:724-725` | `:1629` `weak_basis_without_escalation` | A | — | 高 |
| 110 | `residual_risk_disposition` 必须覆盖修复声明的**每一个** `residual_risks` 标记 | `:700`「缺任一条目即 CONTRACT_VIOLATION」 | **零检查**（字段是否存在都不看） | **C** | q8（空数组覆盖非空声明）→ **exit 0 ✅** | 高 |
| 111 | `affected_issues_status` 必填（无声明时可为空数组） | `:701` | **零检查** | **C** | q8 / p15 → exit 0 | 高 |
| 112 | `evidence.original_trigger_retested` / `regression_scan_performed` / `user_journey_aligned` | `:660-662`（schema） | **零检查** | **C** | u4（三键全缺）、q10（三键全 `false`）→ **exit 0 ✅** | 高 |
| 113 | **验收独立性**：payload 不得引用/复述修复 Agent 的说明，否则判 `CONTRACT_VIOLATION` | `:737` | **零检查** | **C** | u5（`notes:"根据修复报告，修复 Agent 说已经改了…"`）→ **exit 0 ✅** | 高 |
| 114 | （校验器自造）声称 `mutation_check:performed` 但验收是只读角色 | 契约无此约束（契约与 wrapper 在此**互相矛盾**：`:698` 强制 performed ／ `verifier.md` 说只读） | `:1518-1524` warning `mutation_check_vs_readonly` | **B**（契约内部矛盾，校验器只能 WARN） | p15 / r19 每次都出这条 WARN | 高 |

### §3 error 对象（整节空白）

| # | 契约条目 | 契约原文 | 校验器行为 | 类 | 实证 | 置信度 |
|---|---|---|---|---|---|---|
| 115 | `status != SUCCESS` ⇒ `error` 必填 | `:746`、`:126` | **零检查** | **C** | t1（`RETRYABLE_FAILURE`，整份无 `error` 键）→ **exit 0 ✅** | 高 |
| 116 | `error.error_type` 严格闭集（7 值） | `:751`、`:788` | **零检查** | **C** | t3 `error_type:"WHATEVER"` → exit 0 | 高 |
| 117 | `SchemaViolation` ⇒ `violated_fields` 至少一项 | `:768` | **零检查** | **C** | t3 → exit 0 | 高 |
| 118 | `violated_fields` 用 JSON Pointer、字典序、去重、最深处 | `:769-771`、`:775-784` | **零检查** | **C** | t3 `["审计Agent没有引用原文"]`（自然语言）→ exit 0 | 高 |
| 119 | `error.context.{attempted_action,failed_at,harness_capability_missing}` | `:753-757` | **零检查** | **C** | t2（`error:{foo:'bar'}`）→ **exit 0 ✅** | 高 |

---

## 2. B 类逐条：一个守规矩的 Agent 会怎么写 → 会被怎么打回

B 类共 **9 条**（#2、#21、#41、#54、#77、#79、#82、#98、#120），另有 #114 一条「契约内部自相矛盾」单列。以下逐条给出「守规矩的 Agent 会怎么写 → 会被怎么打回」。

### B1（表 #98，最危险）wrapper 说 fix 的 payload「只包含四个字段」→ 校验器强制 `disposition`

- 守规矩写法（`wrappers/fix-worker.md:76` 原文：「`payload` 只包含四个字段：`files_touched`、`verification_commands`、`affected_issues`、`residual_risks`」）
- 被打回：`w1` → `exit 1`，`[missing_disposition] payload.disposition`。
- 危害：**wrapper 是唯一派发给子 Agent 的原话**。子 Agent 按它写、按它自检，100% 失败。契约母文件 `:573` 确实要求 `disposition`，所以这是 **wrapper 落后于契约**，但后果全部由使用者承担——而 wrapper 还写着「写完立刻跑 check-payload，退出码非 0 不得返回」。

### B2（表 #120，最危险）wrapper 说「一条都没找到也要写 `findings: []`」→ 校验器判 `empty_findings`

- 守规矩写法（`wrappers/audit-specialist.md:82` 原文：「即使一条都没找到，也要写 `"findings": []`，**不能省略这个键**。空数组是一个结论（「本切片无缺陷」）」）
- 被打回：`x1` → `exit 1`，`[empty_findings] payload.findings`。
- 危害：**同一个 wrapper 的同一段话内部矛盾**——上一句说空数组是合法结论，而 `output-contract.md:384` 说「空数组一律视为 `CONTRACT_VIOLATION`」。wrapper 这句话是**一个月前**的写法，契约改了口径，wrapper 没跟。一个 Agent 完全可能因为「本切片真的没问题」而写 `[]`，然后被自己的自检脚本打回，并得到一条「必须写一条 `NO_EVIDENCE_FOUND`」的、与它所读包装互相打架的提示。

### B3（表 #21）契约里的「警告」，校验器做成了「错误」（planner `score`）

- 契约 `:177`：「`score` 与 `score_breakdown` 各项之和不一致 → **警告**——…说明判定过程不可复核」。
- 实作 `:1385`：`errors.push({ rule: 'score_mismatch' })`。
- `r1`（score=3，breakdown 和=6）→ `exit 1`。
- 危害：契约明确把它降级为「不可复核」，是**可接受但需注意**的情形；校验器把它变成硬门。K1–K7 的任何口径差异（例如 `K4_sources` 只数到 2 但写 3）都会让一份本该通过的规划书作废并触发重派。

### B4（表 #77）契约里根本没有 `main_path`，校验器却在 critique 分支强制它

- `main_path` 在 `output-contract.md` 与 8 份切片里**零出现**（`grep -n main_path framework/components/output-contract*` 无命中）；只在 `templates/wave2-audit.md:218` 出现，且那是 **audit** 角色的 `runtime_evidence`。
- 实作 `:1315-1333`：在 **critique** 的 `runtime_evidence` 上检查 `main_path`，缺 → WARN；**存在但缺 `expected`/`observed` → ERROR**。
- `p19`（`main_path: { command: 'node t.mjs' }`）→ `exit 1` `runtime_main_path_incomplete`。
- 危害：Skeptic 照契约 §2.3 的 `runtime_evidence` 五字段（`method`/`command`/`observed`/`control_case`/`reproducible`）写，写出的是**契约里的完整对象**；但只要它顺手多给一个 `main_path` 而没填全，就被判违规。**契约允许的字段组合被拒绝，且修法提示指向 `wave2-audit.md`（审计波的模板），不是它该读的规范**——这正是 `audit.md:180` 记录的那条历史失效模式的同型复发。

### B5（表 #79）skeptic 的 `reason` 有 15 字门槛，契约没有

- 契约 `:410` 只要求「必须引用具体证据或指出具体缺失」，**没有任何字数下限**。
- 实作 `:1206`：`substanceLength(reason) < 15` → ERROR `vacuous_reason`。
- `r3`：`reason: "第 42 行确无锁保护"`（10 个实质字，**精确、可核对、比很多 15 字废话有用**）→ `exit 1`。
- 危害：这是一条「**越具体越容易被判违规**」的规则——中文表述越精炼越吃亏。举例：`"L42 无锁"`、`"a.ts:88 漏判空"` 全部不到 15 字。

### B6（表 #41）`GENERATED` 必须给 `generator_ref`，母契约没写

- 母契约 `:262` 只把 `generator_ref` 声明为 `"string|null"`，`§2.2a` 的「必填字段」清单（`:285`）**不含它**；要求写在 `templates/wave2a-sweep.md:181`。
- 实作 `:750`：`reachability === 'GENERATED'` 且 `generator_ref` 为空/短于 3 → ERROR。
- `p12`（照母契约写 `generator_ref: null`）→ `exit 1`。
- 危害：中等。母契约把该字段标成 `|null`，语义上等于「可以为空」，而校验器在一种组合下不接受空。

### B7（表 #82）`verdicts` 覆盖 `target_finding_ids`，母契约从未正面写

- 母契约 `:404` 只把 `target_finding_ids` 列进 schema；`:590` 仅在讲 **fix** 时反向提到「与锐评的 `verdict_missing_for_target` **同构**」——用规则名去指代一条从未写出的要求。
- 实作 `:1052`：漏一条即 ERROR。
- `aa1`（3 个 target、1 条 verdict）→ `exit 1`。
- 危害：中等偏低（wrapper 里有派发参数 `target_finding_ids[]`，Agent 大概率会覆盖全）。但严格说：**校验器有一条契约正文不存在的硬规则，其名字被契约当作已知项引用**。

### B8（表 #2）代码块语言标识大小写（题面给的校准例）

- 契约 `:36`：「以一个 **json 代码块**结尾」——中文表述不约束大小写；wrapper 写的是 ` ```json `（小写）。
- 实作 `:458` `/```json\s*\n([\s\S]*?)```/g`，大小写敏感，且要求 `json` 后**紧跟可选空白再换行**。
- `u10`（```` ```JSON ````）、`u11`（```` ```Json ````）、`u9`（```` ``` json ```` 带空格）→ **全部 `exit 1` `no_json_envelope`**。
- 判定：**B，但置信度中**。缓解因素：所有 wrapper 都逐字给出小写 ` ```json `，且模型天然多写小写。危害低（一个机械可修的格式问题），但**失败信息会误导**——它说「产物里没有 ```json 代码块」，而产物里明明白白有一个 JSON 对象。

### B9（表 #54）`CRITICAL` 的调用链判据绑定中文措辞

- 契约 `:363` 只要求「调用链证据（从入口到问题点的完整路径）或可复现触发条件」，**没有语言限制**；`wave2-audit.md §3.3` 也是中文表述。
- 实作 `:970`：`hasCallChain` 的正则写死为 `/调用链|调用路径|从\s*\S+\s*到|入口.*→|→.*→|caller|call site/i`。
- `v3`：`claim: "handler calls parse, which calls drop without null check"`（英文里最自然的调用链写法）→ **`exit 1` `critical_without_call_chain`**；`v4` 同义中文「调用链：handle() → parse() → drop()」→ `exit 0`。
- 危害：**英文书写的仓库/发现会被系统性降级**。一个英文 Agent 诚实地写出调用链，得到的惩罚是「你的 CRITICAL 只能标 HIGH」——而这恰好与 `:979`「把 CRITICAL 锁在硬证据后面，是为了防止『看上去吓人』的东西挤占修复队列」的意图相反：它锁掉的不是噪声，是语言。

### B10（表 #114，非「更严」而是「契约自相矛盾」）`mutation_check_vs_readonly`

- 契约 `:698`：「除 `harness_unsupported` / `unsafe_revert` 外**强制为** `performed`」。
- wrapper `verifier.md`：「验收 Agent 是只读角色」。
- 实作 `:1518`：警告「声称做了变异检验，但验收 Agent 是只读角色。确认它真的有写权限」。
- 这不是「校验器更严」，而是**契约内部两条规则无法同时满足**，校验器用 WARN 把矛盾转嫁给了人。任何一份合法的 verify 产物只要 `mutation_check: performed`（这是契约要求的默认值），就会永久携带这条警告——**警告噪声化**，久了就没人读 warnings。
---

## 3. C 类：契约是空文，按危害排序

C 类共 **40 条**（#4,5,7,12,13,17,22,28,32,33,34,35,36,39,42,48,49,50,61,63,65,71,74,81,84,85,95,96,97,104,107,110,111,112,113,115,116,117,118,119）。排序依据：**该条失守时，框架还能不能发现自己在失守**。

### C1 全节失守：`error` 对象（§3）——`#115-119`

契约 `:744-788` 定义了 `error_type` 七值闭集、`violated_fields` 的 JSON Pointer/字典序/去重/最深粒度、`context` 三字段，并明说「这个字段的全部价值在于可比性」。
校验器对 `error` 的检查：**零**——不是「漏了几条」，是这个键连存在性都不查（`REQUIRED_TOP` 里没有 `error`）。

后果链：
1. `status: RETRYABLE_FAILURE` 且整份无 `error` → 「✅ 契约合规」。
2. `protocol.md §4.1` 用 `violated_fields` 判「连续两次违规是否同一原因」→ 直接 `PERMANENT_FAILURE`。**这个判据现在读不到任何 `violated_fields`**，于是死锁判定只能恒为「不同原因」，流程退回无限重派。
3. `harness_capability_missing` 的整套「不是简单重派，而是考虑同类 Agent 是否都会遇到」的判断，**没有输入**。
4. 最讽刺的是：`check-payload.mjs` **自己**在输出契约违规时，也从不产生 `error` 对象（它只 `console.log` + `exit 1`），于是「违规产物」与「违规记录」之间没有结构化桥梁。

**这是最该先补的一条**：失败路径是唯一「人不会去读」的路径，也正是最需要机械检查的路径。

### C2 `critique_role` 无枚举校验 → 一个字母关掉整个锐评契约（`#63`）

契约 `:403` 与 wrapper 都写死了三值闭集。校验器**不查这个字段的值**，而所有 critique 规则都以 `p.critique_role === 'skeptic' / 'devils_advocate' / 'arbiter'` 为开关。
实测：`critique_role: "Skeptic"`（首字母大写）+ `verdict: "WHATEVER"` + 空 `reason` → **exit 0 ✅**。
后果：`five_step`、`discipline_audit`、`runtime_applicable`、`sub_claims`、DA 四布尔、裁决枚举——**六组检查同时失效**，而产物拿到「✅ 契约合规」。这是全表里**单位字符破坏力最大**的一条。

同一类「开关字段写错就静默关闭」的还有 **#65**（`verdicts[].verdict` 整个缺失时，`invalid_verdict_enum` 因为判据是 `v.verdict !== undefined` 而跳过）：`u2` 一条**完全没有 `verdict`** 的裁决（连 `reason` 都只是「主张成立」）→ **exit 0 ✅**。wrapper `critique-panel.md:83` 明写「每项含 `finding_id` 与 `verdict`」，校验器不查这个「含」。

### C3 audit 的 `evidence` / `inference` **存在性**不查（`#48`）

契约 `:362-363` 表头逐列写「必填」，`:805`（§4 检查序 8）再次要求「每个条目包含 `evidence` 和 `inference`，且 `evidence` 非空」。
校验器只做**形状**校验：`if (f.evidence !== undefined)`——**不写就跳过**。
实测：`p6`（`{finding_id, dimension, severity, status}` 四个键，零证据）→ **exit 0 ✅**；`u1`（`CONFIRMED` + `evidence` + 无 `inference`）→ **exit 0 ✅**。
后果：门 0 是这套框架的准入根基（`evidence-policy.md`），而一份「有 `finding_id` 有 `status: CONFIRMED` 但没有任何 `quote`」的产物能过门。注意 `effective` 上 `CONFIRMED` 有 `confirmed_without_evidence` 兜着——**但 `GATE_0_FAILED` / `EVIDENCE_GAP` / `UNREADABLE` 三个状态完全没有兜底**，可以空着交。

### C4 finding 的 `dimension` / `severity` 必填性不查（`#49`、`#50`）

契约 `:360-361` 表头「必填」；校验器只在字段存在时查闭集，且 `:702` 的 severity 枚举把 `null` 当作合法值（契约的闭集是 `CRITICAL|HIGH|MEDIUM|LOW`，无 null）。
实测：`p4`（无 `dimension`）、`p5`（`NO_EVIDENCE_FOUND` 无 `severity`）→ **双双 exit 0**。
后果：`dimension` 是下游做覆盖率统计（`dimension_histogram`）与「六个维度是否都查过」的唯一挂接点；`severity` 是修复队列排序的唯一依据。两者都可以缺省且不报错，等于「下游统计可以凭空少算」。

### C5 recon 的**每片九个必填字段**全不查（`#32`、`#33`、`#34`、`#35`）

契约 `:239-247` 是一张九行列「必填=是」的表，还专门写了「`root_dir` / `is_entry_slice` / `shared_dependencies` 为什么必须进契约」（`:249`）。
校验器只查 `slice_count`、`entry_points` 的形状、切片是否相交。
实测：`p9`（每片只有 `slice_id/files/file_count`）→ **exit 0 ✅**。
后果：
- `line_count` 缺 → 800–1800 行的切片预算无人校验，「切片粒度」这条最核心的调度依据变成自觉。
- `exclusion_report` 缺 → 契约 `:243` 说「必填，**防止静默漏审**」。它就是防漏审的那一个，而它现在是可选的。
- `shared_dependencies` 缺 → 契约 `:249` 说它是「切片两两不相交这条硬规则的**唯一载体**」。相交检查（`slice_overlap`）只看 `files`，**没有 `shared_dependencies` 就无从判断一个共享文件是否被算进了两片的 `files`**——`shared_in_files` 规则也只在字段存在时生效。

### C6 验收独立性完全不查（`#113`）

契约 `:737`：「如果验收 Agent 的 `evidence` 字段中出现『根据修复报告』之类的表述，主Agent判定为 `CONTRACT_VIOLATION`。」
实测：`u5`（`notes: "根据修复报告，修复 Agent 说已经改了 NodeListener.java，因此通过"`）→ **exit 0 ✅**。
后果：契约用整段话论证「验收必须从原始用户旅程出发，而不是从『修复 Agent 说它修了什么』出发」，并把这句话称为**唯一来源**（`wrappers/verifier.md`：「你的结论是本轮报告『哪些缺陷真的被修好了』的唯一来源」）。这条不查，等于验收波可以合法地变成修复波的复读机——**而这正是整个五波设计要防的头号失效**。

### C7 `contract_valid` 是自证且无交叉校验（`#12`、`#13`）；`agent_id` 无类型检查（`#7`）

契约 `:123` 定义它为 boolean，`:803`（§4 检查序 6）要求「`status=SUCCESS` ⇒ 必须为 `true`」。
实测：`t5`（`"yes"` 字符串）、`t4`/`p7`（`false` + `SUCCESS`）→ **全部 exit 0**。
后果：这个字段的全部意义是「子 Agent 自己做完 schema 校验后的诚实声明」。它不可检查，也不与 `status` 交叉，于是**它变成一个永远为 `true` 的装饰字段**——而且一个诚实的 Agent 写 `false` 反而不会引起任何注意，契约承诺的「写 `false` 并在 `error` 中说明」没有出口（`error` 也不查，见 C1）。

### C8 `residual_risk_disposition` 覆盖校验不存在（`#110`、`#111`）

契约 `:700`：「修复 Agent 声明的**每一个** `residual_risks` 标记都必须在此有对应条目。**缺任一条目即 `CONTRACT_VIOLATION`**。」
实测：`q8`（`residual_risk_disposition: []`，同时 `affected_issues_status: []`）→ **exit 0 ✅**。
后果：`LARGE_PATCH` / `PUBLIC_API_CHANGE` / `IMPACT_UNVERIFIED` 这些标记是「这次修复有已知尾巴」的唯一登记处。校验器不查覆盖，尾巴就可以静默丢；而 `:621` 说主 Agent 要据此「在验收波中为该修复追加一个回归扫描」——**没有登记，就没有追加**。

### C9 `escalation_required` 必填但零检查（`#104`）

契约 `:697` 表格「必填=是」，并把它与 `verdict: PASS` 组合成「带保留通过」这个**第三态**（`:739`）。
实测：`q9`/`p15`/`bb3`（全缺该字段）→ **exit 0**。
后果：`weak_basis_without_escalation`（`:1629`）只在 `input_space_basis ∈ {single_sample, unknown}` 且 `escalation_required !== true` 时报错——**但字段缺失时 `!== true` 成立**，所以这一条其实是被兜住的。真正漏掉的是：一份 `input_space_basis: boundary` 但作者本意是「带保留」的产物，**无法区分「没想这件事」和「想过、认为无需保留」**。契约 §2.5 里「带保留通过」的整个设计（`:731-735` 的「已知边界」）建立在「Agent 会老实填」上，而字段是可省的。

### C10 `mutation_scope` 的「必须是 `implementation_and_callsite`」不查（`#107`）

契约 `:699`：「对『函数返回值决定用户可见行为』的修复，**必须**为后者，否则须在 `notes` 说明为何未做调用点变异。」
实测：`r19`（`implementation_only` + `notes: "通过"`）→ **exit 0**。
后果：这正是 `:1531-1541` 注释里已经记录过一次的事故（`gen-contract-examples.mjs:243` 生成的「已验证」范例自己违反此条，实战产物照抄拿到 `escalation_required: false`）。`check-payload.mjs:1585-1600` 只补了「枚举合法性」，**没有补「语义档位」**。于是同一形态的事故可以原样复发。

### C11 `pattern_sweep` 的「必填」一侧不查（`#85`）

契约 `:531`：「仅 `devils_advocate` 时，且本轮存在 `HIGH`/`CRITICAL` 发现时**必填**」。
校验器只实现了**越界**一侧（`:1166`，非 DA 返回即报错）；「必须填」一侧零检查。
实测：`r12`（DA，不给 `pattern_sweep`）→ **exit 0**。
后果：DA 是「模式级漏审」的唯一抓手（`:531` 引 `wave3-critique.md §2.4`）。这条不查，DA 的职责只剩「四个布尔 + 缺口列表」，而四个布尔本身也是自述。

### C12 fix 的三个必填/闭集字段（`#95`、`#96`、`#97`）

`:555` 的 `finding_id`、`:565` 的 `result` 闭集、`:807` 的 `affected_issues` 存在性，全部零检查（`p16` 一份全缺的 fix 产物 → exit 0）。
后果：`finding_id` 缺 → 这条修复无法挂回任何发现（`disposition_missing_for_target` 只在派发给了 `target_finding_ids` 时触发，而**派发参数不是产物的一部分**，一份自足的产物可以两边都不给）。`affected_issues` 缺 → 契约 `:621` 的「影响范围未验证 ⇒ 追加回归扫描」失去输入。

### C13（跨类补充：这是 D 类 #57/#59 造成的实际危害）零宽字符绕过只补了一半

`substanceLength` / `isVacuous`（`:83-92`）是为「中文 1 字符 + 零宽字符」这个具体攻击写的，但**只用在** `disposition_reason`、`verdicts[].reason`、`discipline_audit`。
两处该用没用的：
- `:1004` `NO_EVIDENCE_FOUND` 的 `basis`：15 个零宽字符通过（`s3` → exit 0）。
- `:1037` `self_checks` 的 `note`：20 个零宽字符通过（`v8` → exit 0）。

后果：契约 `:380` 把「`basis` < 15 字」写成**唯一**证明「我真查了」的机械判据；它可以用零宽字符满足。`evidence-policy` 的门 0 在这里被一个不可见字符绕过。**口径不统一本身是 D（#57/#59），但它的危害级别是 C 级的。**

### C14 recon 的「空入口须解释」与「排除清单须逐项声明」（`#28`、`#35`）

`p10`（空 `entry_points` + `unverified` 只说别的）→ exit 0；`p25`（`excluded_source_like: ['a.foo']` 未进 `unverified`）→ exit 0。
后果：契约 `:233` 说「空数组合法，**但此时必须在 `unverified` 中写明**」；`:243` 说「`excluded_source_like` 非空时**必须逐项进 `unverified`**」。两条都是「静默漏审」的闸门，现在都是敞开的——而「静默漏审」是这套框架记录最多的失效。

### C15 其余 C 类（低危害，列出备查）

| # | 条目 | 后果 |
|---|---|---|
| #4 | `schema_version: ""` 绕过 | 一份 `""` 版本号的产物过门 |
| #5 | `error`/`artifact_path` 不在 `REQUIRED_TOP` | 契约说「八字段缺一即违规」，实际六字段 |
| #17 | `artifact_path` 相对路径被接受 | 契约只允许绝对或 `<OUTDIR>`；相对路径让「产物在哪」依赖调用点 |
| #22 | `tier` vs `score` 不匹配不查 | 契约说警告，实际连警告都没有（`check-plan.mjs` 才查，且词表不同） |
| #36 | sweep 少要求 `dimension_histogram` | 契约明列必填，`ROLE_REQUIRED` 漏了 |
| #39 | 直方图非数字值被静默丢弃 | `{"logic":"0"}` 求和为 0 == `leads.length` 0，假通过 |
| #42 | `files_read` 可为空 | 「覆盖率记账的唯一来源」可以为空 |
| #61 | audit 无 `slice_id` 不报 | 切片归属丢失 |
| #71 | `five_step` 在 DA/arbiter 越界不查 | 契约说「判 CONTRACT_VIOLATION」 |
| #74 | `runtime_applicable:false` 却给 evidence | 契约说警告，实际无 |
| #81 | 五个敏感领域只守住 `concurrency` | 内存安全/声明一致性/行为兼容/未使用参数 四域的 `refuted` 无强制矛盾证据 |
| #84 | `coverage_gaps` 只查 3/6 字段 | `gap_id`/`evidence.observation`/`potential_impact` 可省，缺口无法机械消费 |
| #112 | verify 的三个 `evidence` 布尔 | 全可缺、可全 `false` |
| #7 | `agent_id` 无类型检查 | 契约要求 string；`agent_id: 7` 也能过，账本按 id 索引时会出现数字键 |
| #116-119 | error 的四个子字段（见 C1） | 已在 C1 详述，此处不重复 |

---

## 4. A 类：校验器确实做到了的部分（不要只报坏消息）

**64/120 ≈ 53%** 完全一致，而且这 53% 覆盖了框架里**最贵**的几块：

1. **信封物理形态**（`#1`）：无信封、非对象信封、`json_parse_failed`、尾随逗号容错（带 WARN）、多块时取「最后一个像信封的」——这里是**实打实做过一轮返工**的（`:474-533` 的注释记录了「agent 越认真写正文越被判违规」的修复）。**这一块是全文件质量最高的部分。**
2. **枚举闭集**（`#10`、`#40`、`#64`、`#83`、`#100`、`#105`、`#106`、`#108`）：`ENUM_CHECKS` 表（`:699-715`，11 条）+ 各处分支，共 18 组闭集被机械校验，且 `check-enum-consistency.mjs` 会把登记过的那几条与切片/母文件/示例做四处比对。
3. **计数自洽**（`#20`、`#26`、`#37`、`#38`）：`slice_count`、`lead_count`、`member_count`、`dimension_histogram` 全部机械对上。契约里「面板规模/覆盖率记账不可编」的承诺**兑现了**。
4. **门 0 的核心**（`#51`、`#52`、`#55`、`#58`）：`CONFIRMED` 必须有非空 `quote`、必须有 `severity`；`NO_EVIDENCE_FOUND` 必须有 `searched_scope`。「空的 `CONFIRMED`」「空的 `NO_EVIDENCE_FOUND`」两条最廉价的攻击路径**确实被堵死**（`:930-950`、`:985-1011` 的注释还留着当时红队实测的原文）。
5. **fix 的 disposition 体系**（`#86-94`）：四值闭集、`FIXED` 三件套、`red_log` 语法+存在性、`files_touched` 存在性、覆盖校验。这一段是**整份文件最完整的**——契约与实作几乎逐条对齐，连降级纪律（无 `--repo` 时 WARN 不 FAIL）都写了进去。
6. **verify 的变异/输入空间**（`#99-109`）：`FAIL` 三件套、`mutation_check` 的 skip 理由白名单、`weak_basis ⇒ escalation_required`。这几条是 2026-11-17 才补的，补得很干净。

一个可量化的对照（按角色分组的 A 占比）：

| 角色 | 条目数 | A | C | B | D | A 占比 |
|---|---|---|---|---|---|---|
| fix | 13（#86-98） | 9 | 3 | 1 | 0 | **69%** |
| audit | 19（#43-61） | 12 | 4 | 1 | 2 | **63%** |
| verify | 16（#99-114） | 9 | 6 | 1 | 0 | **56%** |
| recon | 11（#25-35） | 6 | 5 | 0 | 0 | **55%** |
| critique | 24（#62-85） | 13 | 7 | 3 | 1 | **54%** |
| sweep | 7（#36-42） | 3 | 3 | 1 | 0 | **43%** |
| 信封/error | 23（#1-18、#115-119） | 10 | 11 | 1 | 1 | **43%** |
| planner | 6（#19-24） | 2 | 1 | 1 | 2 | **33%** |

对称性与「最近改过没有」强烈相关：**fix（2026-11-15 大改）69%、audit（11-14 后补）63%** 最一致；**planner（33%）与 sweep（43%）最空**——而这两个角色恰好是「上游决定下游花多少钱」的两个（面板规模 / 切片预算）。

---

## 5. 方法与复现

- 120 条条目全部来自 `output-contract.md` 的**散文硬判据**（「必填」「必拒」「闭集」「不一致即 CONTRACT_VIOLATION」）与表格，不来自示例 JSON 的键名本身（除非散文把它标为必填）。
- 8 份切片是母文件的机械生成物（`gen-contract-slices.mjs`），实测**逐行比对无新增条文**（每份仅多 8 行：HTML 注释头、`file:` 字段、标题、角色名）。因此角色特异性要求**全部**在母文件中。
- B/C 条目 ~90% 有实证：探针文件按角色生成，`node tools/check-payload.mjs <probe> --role <role> [--repo .]`，记录退出码与首个规则名。共 5 轮探针、约 70 份产物。
- 未实证的仅 `#84` 的部分字段（`q7` 只覆盖了 `gap_id`/`evidence`/`potential_impact` 三个缺失）。
- 探针目录 `.probe-contract/` 已在收尾时删除；未修改 `tools/`、`framework/`，未执行任何 git 写操作。

### 三条最该先修的

1. **`critique_role` 加枚举**（`#63`）：一行 `invalid_enum_value`，堵住「一个字母关掉六组检查」。
2. **`error` 对象纳入 `REQUIRED_TOP` 的条件分支 + `#115-119` 五条**：失败路径是唯一没人读的路径。
3. **把 wrapper 拉回契约**（B1、B2）：两句话可以让**所有** fix/audit 子 Agent 必然失败，且它们是 `wrappers/` 里唯一被 Agent 逐字执行的原话。
