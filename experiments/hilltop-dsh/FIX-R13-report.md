# R13 — 把信封闸门接到 stop-hook，并回答存量无信封产物怎么办

> 任务：在 `stop-hook.mjs` 的 wave4/wave5 分支上加 §3.7 产物信封检查，
> 设计一个可声明豁免的兼容机制，并回答「存量 6 份无信封产物怎么办」。
>
> 结论先说：**门接上了，存量 6 份的处置定了（全豁免，不补信封），但「agent 跳过自检」这件事仍然能发生**——
> 差别在于它现在**不能无声地发生**。见 §七。

---

## 一、产物目录从哪来：用已有的 `report.dir_path`，不新增字段

### 1.1 先查现有约定

按任务书要求先读 `framework/artifacts/run-state.md` 与 `report-naming.md`。结论：

| 文件 | 已有约定 |
|---|---|
| `run-state.md` 第 2 节 | `report.dir_path` =「本轮产物目录的绝对路径，供子 Agent 拼 `artifact_path`」；`report.dir_ready` 是**派发前的硬闸**（为 `false` 时不得派发任何子 Agent） |
| `report-naming.md` §4 | 「一层：一轮一个文件夹，所有产物平铺在里面。不再分子目录」；§5.1 规定目录由主 Agent 在波次一启动前创建 |

**所以 state.json 里已经有约定的产物目录字段了。**

### 1.2 加字段的代价（任务书要求核这个）

`check-state.mjs` 的 `TOP_REQUIRED`（第 76 行）：

```js
const TOP_REQUIRED = ['schema_version', 'trace_id', 'round_id', 'path_mode', 'phase', 'status', 'slices'];
```

7 个顶层键，**不含任何产物目录字段**。

关键问题不是「check-state 对未知字段严不严」——实测它对未列出的顶层字段是宽容的
（我构造了一份带 `legacy_artifacts` + 一个完全随机的 `brand_new_unknown_field` 的 state，check-state 只报了我故意留下的 3 条真违规，对这两个陌生字段一字未提）。

**真正的代价在别处**：`TOP_REQUIRED` 是「必填」清单。往它里面加一个键，会让**所有存量 `state.json` 一夜之间变不合规**——
而 `run-state.md` 第 2 节正是「断点续跑的唯一依据」，历史轮次的 `state.json` 必须永远可读。
这才是任务书问的「加字段代价太大」的那个代价。

### 1.3 选择与理由

**选「用已有字段 + 三级推断」，不新增任何字段。**

推断顺序（命中即用，都不命中则降级）：

| 序 | 来源 | 依据 |
|---|---|---|
| 1 | `state.report.dir_path` | 约定字段，直接可信 |
| 2 | `dirname(state.report.final_report_path)` | `report-naming.md` §4：报告与波次产物同目录、一层平铺 |
| 3 | `dirname(state.fix_contracts[].test_path)` | 最后兜底。**明确标注为兜底**：测试文件常在被审仓库里而非产物目录里，容易推错 |

**唯一新增的字段是 `legacy_artifacts`，它是可选的，且不进取 `TOP_REQUIRED`。**
可选字段不改变任何存量 `state.json` 的合规性——不写它就是「不豁免」，也就是默认严格。

> **任务书授权的越界改动**：`framework/artifacts/run-state.md` 不在「只改三个文件」的清单里，
> 但任务书 §1 与 §Output 都写了「同时在 `run-state.md` 里定义它」。我据此加了两处：
> schema 块里一个 `legacy_artifacts` 示例键，以及新增第 2.6 节（产物信封检查与豁免）。
> **这是本轮唯一超出清单的文件改动，如果这一授权不算数，请回退 `run-state.md`**，
> 代码与测试不依赖它。

---

## 二、`tools/stop-hook.mjs` 的改动（§3.7）

位置：紧跟 §3.6（harness 对账）之后，`problems.length > 0` 判断之前。

### 2.1 启用判据

```js
if (state.phase === 'wave4' || state.phase === 'wave5') {
  if (state.path_mode !== 'FIX') { /* 不管 */ }
  else { /* 3.7 */ }
}
```

两个条件**同时**成立才启用。`path_mode` 不是 `FIX` 时静默跳过——相位与路径模式对不上是账本自己的问题，
交给 `check-state.mjs`，本 hook 不管（case 27 锁定）。

### 2.2 调用方式

豁免**不在调用层过滤**，而是让检查器照常报 FAIL，再由本层把「已声明豁免的」降级为 WARN：

```js
execFileSync(process.execPath, [
  join(HERE, 'check-fix-artifacts-envelope.mjs'),
  '--dir', inferred.dir,
  '--json',
], ...)
```

这样 `check-fix-artifacts-envelope.mjs` 仍然保持它文件头写死的立场——
**「故意不提供 `--ignore`，因为那个开关一旦存在就会成为默认路径」**。
豁免的唯一出口在账本里，且可见。检查器一行没改。

### 2.3 降级纪律（与 R8/R10/R11 同一条）

| 情形 | 行为 |
|---|---|
| 三条推断路径全落空 | **WARN，不 FAIL**。写明「本次没有执行产物信封检查」 |
| 目录推出来了但读不了 | **WARN**（环境问题，不是产物问题） |
| 目录里 0 份 `done-*.md` / `*-fix-*.md` | **WARN**。「修复产物还没写完」是允许的中间态，相位闭合由 §3 的 `fix_contracts` 判据负责 |
| 检查器本身跑不起来 | **WARN** |
| 目录下有子目录 | **WARN**（见 §2.4） |
| 产物缺信封 / 信封坏 / role 错 / 缺 disposition | **FAIL**（升为 `problems`） |

### 2.4 一个我主动加的 WARN：子目录不进分母

`check-fix-artifacts-envelope.mjs` 文件头把「把历史产物移进 `legacy/` 子目录」列为官方出路。
但子目录不进分母这件事如果没人说出来，就等于给了它一个**静默的豁免通道**。
所以本层也报一条 WARN，措辞明确写「其中的产物不在本次检查范围内，也不进分母」。
这是「移进 `legacy/`」这条路唯一的留痕点，不能省。

---

## 三、兼容策略：`legacy_artifacts` 可声明豁免

### 3.1 字段

```json
"legacy_artifacts": ["done-1.md", "done-3.md", "done-4.md", "done-6.md", "done-7.md", "done-8.md"]
```

可选，字符串数组，只写文件名（`basename` 会被取，绝对路径也接受）。

### 3.2 四条约束（缺一条它就变成关掉检查的开关）

| # | 约束 | 实现 | 测试 |
|---|---|---|---|
| 1 | 只能逐个列文件名 | 数组，不是布尔；非数组 → FAIL | — |
| 2 | **不能全量豁免** | 匹配到产物的豁免条目数 **≥ 目录下文件总数** → **FAIL** | case 25、case 24b |
| 3 | 每条豁免都留痕 | 逐条 WARN：「契约体系之外 / 证据不可机械复核 / 不是通过了检查，是没被检查」 | case 24 |
| 4 | 悬空条目要报 | 列了但目录里没有 → WARN，不阻断 | case 28 |

### 3.3 「全量豁免」的分母：为什么取「目录下文件总数」而不是「产物数」

这是本轮最容易做错的一处，我改过两版。

**第一版**用「待检产物数」当分母。跑真实数据时立刻出问题：

```
产物目录 experiments/hilltop-dsh/repair 下 6 份产物全部豁免
→ 6/6 → 判定为全量豁免 → exit 2
```

但任务书 §2 对「全量豁免」的定义是**「数组长度 ≥ 目录下文件总数」**，
而 `repair/` 下共 **15** 个文件（6 份产物 + SUMMARY / REPAIR-LOG / PRECEDENTS / ACCEPTANCE-ROUND1/2 / ADJUDICATION-2/5 / DISPATCH-PITFALLS / MAIN-THREAD-VIOLATION 等流程文档）。
`report-naming.md` §4 明规定「一层平铺、不分子目录」——产物与流程文档共存是**规范行为**，不是脏数据。

**所以按任务书字面实现**：分母 = 目录下文件总数。6/15 才是「少数例外」的正确刻画，6/6 会误杀真实历史目录。

两个边界都保持了正确行为：

| 情形 | 结果 | 说明 |
|---|---|---|
| 2 份产物、2 条豁免（无其他文件） | 2/2 → **exit 2** | case 25 |
| 1 份产物、1 条豁免（无其他文件） | 1/1 → **exit 2** | case 24b |
| 6 份产物、15 个文件、6 条豁免 | 6/15 → **exit 0 + WARN** | 真实数据场景 2 |
| `null`、`[]`、字段缺失 | 不豁免 | 默认严格 |

### 3.4 一个残留形态，我用 WARN 而不是 FAIL 兜住

「产物 100% 被豁免，但目录里有流程文档把计数稀释了」→ 按 3.3 的分母不会触发 FAIL。
比如目录里只有 2 份产物 + 10 份文档，豁免 2 份 = 2/12。这仍然意味着**这一轮一份产物都没被检查过**。

我在这里**没有**升级为 FAIL，而是报一条醒目的 WARN：

> WARN · 待检产物 N 份**全部**在 legacy_artifacts 里——本轮没有任何修复产物经过信封检查。
> 这是「整批承认不可复核」，不是「这批产物合规」。

**理由**：这一形态正是 `hilltop-dsh` 的真实形态（6/15）。硬 FAIL 会把它判死，
而任务书与本轮 `LEGACY-ARTIFACTS.md` 对它的决定是「豁免 + 留痕」，不是「不许闭合」。
取舍写在这里，是为了让后来的人知道这是一个**被看见的决定**，不是一个漏掉的分支。

---

## 四、真实数据自证

state.json 指向 `experiments/hilltop-dsh/repair/`（`report.dir_path`），
`phase=wave4`、`path_mode=FIX`、6 条 `fix_contracts`、`budget.spawned_fix_agents=6`——除 §3.7 外全部闭合，
这样唯一的拦截来源只能是 §3.7。

### 场景 1：不加 `legacy_artifacts` → **exit 2**

```
[交付粒度检查] 还不能结束这一回合：

1. 有 6 份修复产物**没有可用的信封**（产物目录 D:\Projects\AI prompt\many-agents_multi-prompt-files_token-heavy\multi-agent-audit-framework\experiments\hilltop-dsh\repair，来自 report.dir_path）：
  - done-1.md（artifact_without_envelope）
  - done-3.md（artifact_without_envelope）
  - done-4.md（artifact_without_envelope）
  - done-6.md（artifact_without_envelope）
  - done-7.md（artifact_without_envelope）
  - done-8.md（artifact_without_envelope）

这不是「格式不规范」。没有信封 = check-payload 的全部规则在这份产物上一次都不会跑（含「红测日志必须在 target/ 之外」「证据文件必须存在」「disposition 必须表态」）——无法被任何机械检查观测 = 未交付。不是因为通过，是因为没跑。
两份 2026-11-15 的修复产物就是这样交出去的。
补法：在每份产物末尾追加一个 ```json 信封（components/output-contract.md §1）……
若这些是**历史产物**、确实无法补信封，把它们列入 state.json 的 legacy_artifacts（会留 WARN 且计入不可复核证据；不能全量豁免）。

如果你确实需要用户决定某件事，只有 protocol.md §0.8.5 列出的 6 种情形可以。其余情况请自行判断、记进 discipline_log，然后继续。
EXIT=2
```

### 场景 2：加 `legacy_artifacts` 列出 6 份 → **exit 0 + 7 条 WARN**

```
[产物信封检查 · 告警（不阻断）]

1. WARN · 产物 done-1.md 在契约体系之外（legacy_artifacts 已声明豁免）：artifact_without_envelope。
  证据不可机械复核——它不是「通过了检查」，是「没有被检查」。后续任何引用它的验收结论都无法由工具复核，只能由人读原文。

2. WARN · 产物 done-3.md 在契约体系之外（legacy_artifacts 已声明豁免）：artifact_without_envelope。
  证据不可机械复核——它不是「通过了检查」，是「没有被检查」。后续任何引用它的验收结论都无法由工具复核，只能由人读原文。

3. WARN · 产物 done-4.md …（同）
4. WARN · 产物 done-6.md …（同）
5. WARN · 产物 done-7.md …（同）
6. WARN · 产物 done-8.md …（同）

7. WARN · 待检产物 6 份**全部**在 legacy_artifacts 里（done-1.md、done-3.md、done-4.md、done-6.md、done-7.md、done-8.md）——
本轮没有任何修复产物经过信封检查。
这是「整批承认不可复核」，不是「这批产物合规」。凡是引用它们的验收结论都无法由工具复核。
EXIT=0
```

场景 2 的 7 条 WARN 是**每次闭合都会重报一遍**的——这就是「豁免留痕且可见」的机械形态，
而不是一句写在报告里的承诺。

---

## 五、存量 6 份产物怎么办：选 C（全豁免，不补信封）

详见 `experiments/hilltop-dsh/LEGACY-ARTIFACTS.md`。核心论证摘要：

### 5.1 一个决定性的事实（我先去找的，不是假设）

```
$ grep -rl "planRepair\|DEFAULT_EXPLOSION_POWER\|NODE_ROLLBACK_FAILED" --include=*.java .
（无输出）
```

**修复后的源码树在整个仓库里不存在。** `repair-work/project/` 是**修复前的基线快照**：
`NodeListener.java` 里 `planRepair` 0 处、`ExplodeBeetleGoal.java` 里 `DEFAULT_EXPLOSION_POWER` 0 处、
`ConfigManager.loadFromFile` 仍是 `void`。

这意味着补信封不只是「补一个 JSON 块」，而是**为一份成果物本身已不可访问的产物做合规声明**。

### 5.2 三个选项我都实测了，不是推测

按最忠实的读法给 done-6 补了**完整合法信封**（顶层 `schema_version`/`agent_id`/`status`/`contract_valid`/`artifact_path`/`role` 全齐），
只变 `red_log_path` 的写法，用被审仓库快照当 `--repo`：

| 选项 | 写法 | `check-payload` |
|---|---|---|
| **A** 填原始路径 | `red_log_path: "target/repair6-red.log"` | **exit 1**：`red_log_in_target` + `red_log_not_found` |
| **B** 填空 | `red_log_path: ""` | **exit 1**：`fixed_without_red_log` |
| **B'** 填 target 外的不存在路径 | `red_log_path: "experiments/.../red-6.log"` | **exit 1**：`red_log_not_found` |
| **B''** 填占位词 | `"不可复核（日志已被 mvn clean 删除）"` | **exit 1**：`red_log_not_found` + WARN |

**A 与 B 的每一种写法都 exit 1。补出来的不是「一个勉强的信封」，是一封注定 FAIL 的信封。**

### 5.3 为什么 C 比 A/B 更诚实

1. **一份 FAIL 的信封比一份豁免更糟**：FAIL 在扫描结果里和「真发现了问题」同形，
   下游无法区分「这 6 条 FAIL 是历史账」和「本轮新问题」。豁免是显式的一类，会自报「在契约体系之外」。
2. **这批产物的证据价值恰恰在于它们原样保留**：`artifact_without_envelope` 这条 FAIL 本身
   就是历史真实性的一部分——保留它，等于保留「当时确实没有信封」这个事实的机械可判形态。
   补一个信封，就地把「2026-11-15 的原始交付」变成了「原始交付 + 事后补记」，而两者不可区分。
3. **C 不是放行**：逐条 WARN + 不能全量豁免 + 每次闭合重报。

### 5.4 唯一例外：done-3 技术上能补，但我仍然豁免它

`done-3` 是 WONT_FIX，不要求 `test_path`/`red_log_path`，实测能补成 **exit 0 / ✅ 契约合规**。
我仍然把它列入 C：单独给它补、其余 5 份豁免，会在目录里制造一个**质量梯度假的**样本；
6 份是同一次派发的产物、同一次账，拆开记会让「那次派发整体没有信封」这个事实失去机械形态。

---

## 六、新测试在改代码前的失败信息（原文）

在 `tools/stop-hook.mjs` **未改**时跑 `node tools/stop-hook.test.mjs`：

```
case 21: wave4 + 产物目录里 1 份无信封 → 拒绝结束（artifact_without_envelope）
  ✗ 退出码 2 — 实际 0：
  ✗ 报 artifact_without_envelope
  ✗ 指名道姓点了 done-1.md
  ✗ 说明没有信封等于无法被观测
case 22: wave4 + 产物目录全部有信封 → 允许结束（exit 0）
  ✓ 退出码 0
  ✓ 不提 artifact_without_envelope
case 23: wave4 + 产物目录推断不出来 → exit 0 + WARN（降级纪律）
  ✓ 退出码 0（推断不出就降级，不拦人）
  ✗ stderr 有 WARN 说明没检查
  ✗ 说明产物目录无法确定
case 24: wave4 + legacy_artifacts 豁免了那份 → exit 0，但 stderr 留痕
  ✓ 退出码 0（豁免生效）
  ✗ WARN 提到 done-1.md
  ✗ 写明证据在契约体系之外 / 不可机械复核
case 25: wave4 + legacy_artifacts 覆盖了全部文件 → exit 2（全量豁免=关掉检查）
  ✗ 退出码 2 — 实际 0：
  ✗ 报全量豁免
case 26: phase=wave2a（审计路径）→ 产物信封检查不启用
  ✓ 退出码 0
  ✓ 不提产物信封
case 27: wave4 但 path_mode=AUDIT_ONLY → 产物信封检查不启用（判据要求两者同时成立）
  ✓ 退出码 0
  ✓ 不提产物信封
case 28: legacy_artifacts 列了不存在的文件 → WARN 指出豁免条目悬空（不阻断）
  ✓ 退出码 0
  ✗ WARN 提到 done-99.md 没匹配到

=== 结果: 42 通过 / 11 失败 ===
```

**回归部分**：原 33 个断言全绿（case 1–20 全过），新增断言 11 条失败。

**必须承认的一点**：case 22 / 26 / 27 在红阶段就「通过」了，但那是**空真**——
当时没有检查，所以「不误拦」自然成立。它们的作用是**锁定改完之后不误拦**，不是在红阶段证明新功能。
真正的红→绿证据是 case 21 / 23 / 24 / 25 / 28 那 11 条。

改代码后：

```
=== 结果: 55 通过 / 0 失败 ===
```

（原 33 + 新 22。新增 9 个 case，其中一个 case 24b 是补的边界。）

---

## 七、诚实评估：这个改动之后，「agent 跳过自检」还能发生吗？

### 7.1 分两层答

**Layer 1 — 「修复产物没有信封就闭合」：不能了。**

这正是 R12 §八·洞 B 逐字描述的场景：

> 修复 Agent 写完 6 份 `done-*.md`，全都没有信封，`check-payload` 一次没跑……
> `stop-hook` 放行（`fix_contracts` 非空即可）。本轮仍然可以闭合。

**在 `phase=wave4` + `path_mode=FIX` + 目录可推断 时，这个场景现在 exit 2。** 阻止它的是 harness 强制，
不是提示词。三条外部约束同时生效：产物必须存在、目录必须可推断（否则 WARN，见 7.2）、每份必须有可被观测的信封。

**Layer 2 — 「修复 Agent 自己不跑 `check-payload`」：仍然能发生。**

`check-payload` 检查的是**信封内部字段对不对**（`schema_version` 是否合法、`disposition` 是否在闭集内、
`red_log_path` 指向的文件是否存在、`test_path` 是否存在……）。
`stop-hook` §3.7 只调 `check-fix-artifacts-envelope`，而那个检查器**故意只问一件事：有没有信封**。

R12 §八·洞 C 已经用同一份产物证明过这一点：

| 产物状态 | 信封闸门 | `check-payload` |
|---|---|---|
| 无信封 | **FAIL** | FAIL（只报 `no_json_envelope`） |
| 有信封、`schema_version: "WRONG"` | **0，放行** | **FAIL** |
| 有信封、`disposition` 全缺 | **FAIL**（`envelope_missing_disposition`） | FAIL |

所以：**一个 `schema_version` 写错、`red_log_path` 指向已删除文件的产物，仍然能闭合 wave4。**

### 7.2 剩下的口子，按可利用性排

| # | 口子 | 性质 | 现在有什么拦 |
|---|---|---|---|
| 1 | **不写 `report.dir_path` / `final_report_path`**，让目录推断不出来 | 降级是设计，不是漏洞——但它是**最省力的绕过** | 只有一条 WARN「本次没有执行产物信封检查」。**这是本轮最大的残留口子。** |
| 2 | 有信封但字段错（`schema_version` / `role: "fix"` 写错 / `disposition` 非法） | 信封闸门不管内容 | 部分被拦（`envelope_wrong_role` / `envelope_missing_disposition` 是 FAIL），其余不拦 |
| 3 | `red_log_path` 指向已删除文件 | 存在性检查需要 `--repo`/`--artifact-dir` | 不给根就降级 WARN（R11 洞 A，仍未修） |
| 4 | 信封里 `files_touched` 写假路径 | 无任何检查 | 无 |
| 5 | 把无信封产物移进 `legacy/` 子目录 | 子目录不进分母 | 一条 WARN（§2.4） |
| 6 | 豁免字段写到 6/15（真实形态） | 按任务书分母定义，不触发 FAIL | 一条「本轮没有任何修复产物经过信封检查」的 WARN |

**口子 1 值得单独说**：它把「检查不通过」和「检查没跑」混在一起了——虽然 stderr 上有 WARN，
但 WARN 不阻断。这与 R10 §（b）点名的「降级路径本身就是一条明面上的后门」是同一类问题。
**修法**：`wave4` 且 `fix_contracts` 非空时，`report.dir_path` 应升为**条件必填**（缺则 FAIL），
而不是可降级的推断输入。这需要改 `check-state.mjs`（`TOP_REQUIRED` 是顶层的，这里要的是条件必填），
不在本任务「只改三个文件」的边界内。**建议作为 R14 第一项。**

### 7.3 一句话总结

> **本轮把「没有信封就闭合」从「完全可行」变成了「必须声明豁免、且每次闭合都会重报」。**
> **它没有把「信封里的字段错了」变成不可闭合——那一层仍靠自觉。**
> **四环证据链现在是：（1）产物有没有信封 → 自动闭合（门已接上）；（2）有没有人调校验器 → 仍靠自觉；
> （3）路径存在吗 → 给了根才查；（4）内容对得上主张吗 → 基本没动。**

把（1）从「有工具但没接到门上」说成「自动闭合」，同时不提（2）（3）（4）仍是自觉——那就是用一处改动去掩盖三处空白，
正是 R11 §8.2 与 R12 §八批评过的写法。所以上面这张表比结论句更重要。

---

## 八、改动清单

| 文件 | 改动 | 性质 | 在任务书清单内 |
|---|---|---|---|
| `tools/stop-hook.mjs` | +§3.7（约 290 行，含大段理由注释） | 门 | ✅ |
| `tools/stop-hook.test.mjs` | +9 个 case / +22 断言（33 → 55） | 先红后绿 | ✅ |
| `experiments/hilltop-dsh/LEGACY-ARTIFACTS.md` | 新建，回答存量 6 份怎么办 | 决策 | ✅ |
| `framework/artifacts/run-state.md` | +81 行：schema 示例键 + 新增第 2.6 节 | 字段定义 | ⚠️ 任务书 §1/§Output 明确要求「同步改 run-state.md」，故改 |
| `experiments/hilltop-dsh/FIX-R13-report.md` | 本文件 | 报告 | ✅ |

**没动的**：
- `tools/check-fix-artifacts-envelope.mjs` —— 一行未改，保持「不提供 `--ignore`」的立场；
- `tools/check-state.mjs` —— 一行未改，`TOP_REQUIRED` 未加任何键；
- `experiments/hilltop-dsh/repair/*.md` —— 6 份原样保留，一个字节未动（LEGACY-ARTIFACTS.md 的决定的直接后果）。

**未 commit**（遵守任务书）。`git status` 里另有一个 `experiments/hilltop-dsh/FIX-R1-R13-SUMMARY.md`，
时间戳 23:06，早于本轮工作的起点，**不是本轮产物**。

---

## 九、验证

```
$ node tools/stop-hook.test.mjs
=== 结果: 55 通过 / 0 失败 ===        （原 33 全过 + 新 22）

$ node tools/check-state.test.mjs
=== 结果: 40 通过 / 0 失败 ===

$ node tools/check-all.mjs
✅ 全部通过                            EXIT=0
```

---

## 十、下一轮建议

| 序 | 内容 | 为什么 | 成本 |
|---|---|---|---|
| 1 | `wave4` + `fix_contracts` 非空时，`report.dir_path` 升为条件必填（缺则 FAIL） | 堵 §7.2 的口子 1——那是当前**最省力**的绕过，只需不写一个字段 | 低（改 `check-state.mjs` + `stop-hook` 判据） |
| 2 | `stop-hook` §3.7 顺带对每份产物跑一次 `check-payload --role fix --repo <inferred>` | 补 §7.1 Layer 2：让「有信封但字段错」也不可闭合。**这是把第 2 环自动化的唯一走法** | 中（要给被审仓库根，而 state.json 里没有这个字段——又是一次「字段从哪来」） |
| 3 | `check-payload` 在 `--role fix` + `disposition: FIXED` 时强制 `--repo`/`--artifact-dir`，缺则 exit 2 | R11 洞 A / R12 §九建议 3，仍未做 | 低 |
| 4 | `red_log_path` 内容最低要求（含 `FAIL` / `BUILD FAILURE` / 非 0 退出码）+ mtime 早于 `files_touched` | R11 优先级 2 与 3，四环之第 4 环 | 低 |
| 5 | 把「修复后源码树不在仓库里」记进实验记录 | `repair-work/project` 是基线快照，这比没有信封严重得多（见 LEGACY-ARTIFACTS.md §8.2） | 极低 |
