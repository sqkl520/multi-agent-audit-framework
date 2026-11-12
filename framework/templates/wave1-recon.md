---
file: templates/wave1-recon.md
title: 波次一：侦察（recon scout）
group_order: 1
loaded: 加载前必须已加载 evidence-policy.md 和 output-contract.md
source: https://chat.deepseek.com/share/yn99k1mum4qp5fqwj8 (第 10 轮)
---

# templates/wave1-recon.md

## 文件头部：强制加载与角色边界

> wave1-recon.md
> 侦察Agent（recon scout）专属模板。
> 加载本模板前，必须已加载 evidence-policy.md 和 output-contract.md。
> 本模板与 evidence-policy / output-contract 冲突时，以两者为准；
> 本模板只负责“侦察要产出什么、按什么规则构造切片”，不重新定义证据结构或返回格式。
> 侦察Agent的返回必须符合 output-contract.md 的 role: "recon" payload schema。

---

## 第 1 节：侦察Agent的职责边界——三做三不做

**做**：

1. **编目**：扫描项目，列出所有源代码文件及其顶层目录归属；
2. **切片**：按第 2 节的硬规则把文件聚合成可独立审计的工作单元；
3. **标记未知**：对无法确认归属、无法读取或无法判断类型的路径，显式写入 `unverified`。

**不做**：

1. **不返回“项目大小”标签**。不写“小型/中型/大型/企业级”，不写“约 X 千行”。`slice_count` 和 `audit_slices` 本身就是规模信号，主Agent用 `scale-mapping.md` 做区间映射，不需要侦察Agent先做一个语义判断。
2. **不评估代码质量或发现缺陷**。侦察波次不产出 `findings`，不评价“这个模块看起来有风险”。缺陷发现是波次二的职责，侦察Agent如果越界，会污染切片的中立性。
3. **不按“重要性”排序或筛选切片**。切片顺序只由第 2 节的确定性规则（目录归属 + 文件名排序）决定，不按“这个模块更重要”重新排列。

---

## 第 2 节：切片的构造规则——独立性 + 可扇出性

切片的唯一目的是让每个发现波Agent拿到一个**足够小、边界清晰、与其他切片不相交**的工作单元。

#### 2.1 切片独立性判据

一个切片必须满足以下**全部**条件：

- **文件集合不相交**：任意两个切片不得共享同一个文件。如果某个文件被多个模块引用（例如共享的类型定义文件 `types.ts`、`shared/utils.py`），该文件**不得**出现在多个切片中；侦察Agent必须把它单独列为**共享切片**（`shared_dependencies`），或归入引用它最多的那个切片并在 `rationale` 中说明。CIH 的“charter meant to touch disjoint files”原则在这里直接适用[^ref4]。
- **同目录聚合优先**：同一目录下的源文件优先归入同一切片，除非该目录文件数超过上限（见 2.2）。Fan-out auditing 的规则是“keeping same-directory files together”，因为同目录文件通常共享局部上下文，拆开反而增加每个Agent的理解成本[^ref5]。
- **单一职责边界**：如果一个目录内明显存在多个独立子模块（例如 `src/handlers/` 下有 20 个互不依赖的 handler 文件），可以拆成多个切片，但每个切片必须在 `rationale` 中写明“为什么这些文件构成一个独立工作单元”。**不允许**为了凑文件数而把无关目录混在一起。

#### 2.2 切片大小：建议区间与硬约束

**建议区间**：每个切片 **5–8 个源文件**（仅供参考的可读性建议）。Fan-out auditing 的观察是 Agent 在 5–8 个文件的范围内倾向于逐行阅读[^ref6]。「keeping same-directory files together」这条聚合原则同样出自该文[^ref5]。

**硬约束只有一条**：`line_count ≤ 1800`。**文件数是代理指标，不是门控条件**——2026-11-04 在 `D:\Web\style` 实跑的 40 个切片里，24 个（60%）文件数 < 5 但行数合规，全部是合法切片。详见 §2.2.1 的实测修订。

> **注**：曾有一处引用声称「LobeHub 的并行审计实践也使用 typically 5–10 files per chunk」并挂了一个 Zenodo PDF 出处，经核实**该 PDF 全文不含此内容**（与 LobeHub、切片粒度均无关），该引用已移除。若需「5–10 files」这一说法，请另找 LobeHub 的原始页面作为出处；在找到之前，**以 `5–8` 为准**，不要引用未经核实的区间。

#### 2.2.1 文件数不是唯一约束：行数上限（2026-11-01 新增）

**「5–8 文件」是一个代理指标，真正要控制的是「单个 Agent 要读多少内容」。** 在内容密度差异大的项目上，只按文件数切分会失效：

`D:\Web\style` 实测：198 个源文件切出 56 片，其中 **19 片（34%）无法同时满足「≥5 文件」与「不超合理行数」**——因为该项目有 `app.js`(1655 行)、`prompt-copy.js`(1817 行)、`clean-dna.mjs`(1524 行) 这类单文件巨型脚本。

**因此增加第二条约束（与文件数并列，不是替代）**：

```
每个切片的 总行数 应落在 800–1800 行
若某文件自身 > 1800 行 → 单文件成片，标 oversized_file: true
```

**两条规则的优先级**：

| 情形 | 处理 |
|---|---|
| ≤1800 行 | **正常切片，无论文件数多少** |
| 文件数 > 8 但可按行数拆成多片 | **优先按行数拆**（每片 ≤1800 行） |
| 文件数 < 5 但总行数 ≤1800 | **正常切片**，`undersized` 按下方定义填写，不再视为「例外」 |
| 单个文件 > 1800 行 | **单文件成片**，标 `oversized_file: true`，并在 `rationale` 写明「该文件自身超出切片上限，无法与其他文件合并」 |

**为什么允许「单文件成片」违反 5 文件下限**：

原规则说「小于 5 文件的切片会让 Agent 没什么可读，倾向于从外部推测」。但**这条理由在一个 1800 行的单文件上恰好不成立**——它内容和上下文都充足，Agent 不会「没什么可读」。**规则约束的其实是「内容量」，文件数只是内容量的粗略代理。** 当代理指标与实际目标冲突时，以实际目标为准。

**2026-11-04 实测修订：文件数降为建议，行数才是硬约束。**

`D:\Web\style` 实跑生成的 40 个切片里，**24 个（60%）文件数 < 5，但行数全部落在 821–1739 的合规区间**。原因很直接：一个前端原型的自然单元就是 `index.html` + `style.css` 两个文件，行数 700–1200。

原规则把 `undersized` 描述成「小目录合并失败时的**合理例外**」，暗示它罕见。**实测它是常态。** 一个把 60% 合法产物标成「例外」的规则，描述的是错误的世界模型。

| 字段 | 新定义 |
|---|---|
| `undersized` | **纯信息字段**：`files.length < 5` 时为 `true`。**不表示不合规、不触发合并、不影响门控** |
| 硬约束 | **只有 `line_count` ≤ 1800**（超了用 `oversized_file`） |
| 建议 | 5–8 文件/片；低于 5 时优先按模块聚簇，不要为了凑数跨模块拼接 |

> **为什么不能强行凑够 5 个文件**：把 `S04-mango-collage-wall` 的 `style.css` 和另外三个不相干原型的 CSS 拼成一片，Agent 会花大量上下文判断「这几份文件到底有没有关系」，而它们其实没有。**同构小文件聚簇（同一原型、同一模块）才是正确的切片单位。**

**`oversized_file` 切片的额外要求**：深挖时**必须**在报告中声明「本切片为单文件，可能存在跨文件调用链盲区」，并列出该文件的关键导出符号，供下游 Devil's Advocate 检查调用方是否未被覆盖。

**超限处理**（按**行数**判定，不按文件数）：

- 如果一个目录的**总行数 > 1800**，侦察Agent**必须**拆成多个切片，按文件名排序或按模块边界拆分；
- 如果文件数 **超过 15** 且总行数合规，按子目录进一步拆分；目录扁平且无法按子目录拆时，按文件名排序后每 8 个一组（这是**可读性建议**，不是硬约束）；
- 如果某个目录只有 **1–4 个文件**且行数 ≤1800，**允许单独成片**（见上方 2026-11-04 修订）。优先与**同构的相邻目录**合并（例如同一批原型、同一模块），但**不得**为了凑文件数把无关目录拼在一起。若合并后跨了模块边界，宁可不合并。

**判断依据是行数，不是文件数。** 一个 2 文件、1200 行的前端原型切片是合规的；一个 8 文件、5000 行的切片才是不合规的。

#### 2.3 文件扩展名的纳入规则

侦察Agent只把**源代码文件**纳入切片。默认纳入的扩展名分两组：

**第一组 · 通用编程语言**：`.py`、`.js`、`.ts`、`.tsx`、`.jsx`、`.mjs`、`.cjs`、`.go`、`.rs`、`.java`、`.kt`、`.rb`、`.php`、`.cs`、`.swift`、`.c`、`.cpp`、`.h`、`.hpp`、`.scala`、`.ex`、`.exs`、`.lua`、`.sh`、`.sql`

**第二组 · Web 前端（2026-11-01 新增，此前被误判为资源）**：`.html`、`.htm`、`.css`、`.scss`、`.sass`、`.less`、`.vue`、`.svelte`、`.astro`、`.jsx`、`.tsx`

> **为什么必须加第二组**：原清单把 `.css` 明确列为「资源文件，不纳入」，且完全没有 `.html` / `.mjs`。这在 Web 项目上会造成灾难性漏审。实测：`D:\Web\style` 项目共 2249 个文件，按其 19 个可纳入文件计算，**179 个 CSS/HTML/MJS（项目主体）被全部排除，覆盖率仅 9.6%，且排除理由完全合规**。
>
> `.css` 在现代项目里**是代码**：它含 `@import` 依赖图、可用 `calc()` / 自定义属性 / 媒体查询构成分支，也是注入面（`url()` 外链、样式覆盖导致的点击劫持）。把它与 `.png` 并列是范畴错误。

**不纳入**：文档（`.md`、`.txt`）、配置（`.json`、`.yaml`、`.toml`、`.lock`）、二进制资源（图片、字体、音视频、`.woff2`、`.png`、`.jpg`、`.svg` 等）。

#### 2.3.1 项目级配置覆盖（强制）

**默认清单只是起点，不是终点。** 侦察Agent必须执行以下步骤：

1. **读项目自身的配置文件**（如 `.gitattributes`、构建脚本、`package.json` 的 `scripts`、`Makefile`），判断项目实际是什么技术栈；
2. **若发现默认清单外的源文件类型**（例如 `.tmpl`、`.j2`、`.hbs`、`.njk`、`.razor`、`.sol`、`.zig`、`.nim`），**必须**把它们纳入，并在 `rationale` 中说明依据；
3. **允许项目在派发时传入 `include_extensions` / `exclude_extensions` 覆盖默认清单**，覆盖值优先。

#### 2.3.2 强制暴露排除项（防止静默漏审）

**排除本身不违规，静默排除才违规。** 侦察Agent必须输出 `exclusion_report`：

```json
{
  "exclusion_report": {
    "included_files": 209,
    "excluded_by_type": {
      ".md":   { "count": 277, "reason": "文档，非源码（合理）" },
      ".woff2":{ "count": 951, "reason": "字体二进制（合理）" },
      ".jpg":  { "count": 515, "reason": "图片资源（合理）" }
    },
    "excluded_source_like": [
      { "ext": ".hbs", "count": 12, "reason": "模板文件，未确认是否含逻辑" }
    ],
    "exclusion_dominant": false,
    "dominant_threshold_note": "任一被排除类型数 > 已纳入总数 × 0.2 时置 true"
  }
}
```

**硬规则**：

| 条件 | 动作 |
|---|---|
| `excluded_source_like` 非空 | **必须**在 `unverified` 中逐项登记，标 `AMBIGUOUS_TYPE` |
| 任一被排除类型的数量 > `included_files × 0.2` | 置 `exclusion_dominant: true`，**必须**在最终报告单列，由人确认 |
| `exclusion_dominant: true` 但 `included_files == 0` | 返回 `RETRYABLE_FAILURE`，说明「扩展名规则与项目技术栈不匹配」，**不得**返回空切片 |

> **这一节的由来**：`D:\Web\style` 项目的 179 个 CSS/HTML/MJS 被排除时，框架**没有任何提示**——它安静地产出了 19 个文件的切片，看起来完全正常。如果没有这道强制暴露，使用者会以为「审计完成了」，实际上 90% 的代码从未被看过。

#### 2.4 切片输出的字段

每个切片必须返回：

```json
{
  "slice_id": "slice-01",
  "files": ["src/dispatch/pipeline.ts", "src/dispatch/worker-pool.ts", "..."],
  "file_count": 7,
  "root_dir": "src/dispatch",
  "rationale": "同一目录下的 dispatch 核心文件，共享 worker 池和 pipeline 的状态管理。",
  "is_entry_slice": false,
  "shared_dependencies": ["src/types/agent.ts"]
}
```

`shared_dependencies` 记录该切片读取但不独占的共享文件，供发现波Agent在需要时引用，但**不把它们算入 `files` 或 `file_count`**，以避免同一文件出现在多个切片中违反独立性。

---

## 第 3 节：入口点发现——必须带证据，不是“列个大概”

侦察Agent的第二项产出是 `entry_points`。这不是“猜一下主文件在哪”，而是按 entry-trace 的要求枚举**外部Actor进入系统的所有面**，并映射到具体的文件位置。

#### 3.1 必须覆盖的入口类别

侦察Agent必须检查以下入口类别，**每一类都要么返回具体位置，要么在 `unverified` 中写明“未发现”**：

| 类别 | 典型形态 |
|---|---|
| HTTP 路由/端点 | `app.get(...)`、`router.post(...)`、`@GetMapping`、Flask `@app.route` |
| CLI 命令 | `argparse`、`click.command`、`cobra.Command` |
| 定时触发器 | cron job、`setInterval`、`schedule.every` |
| 入站 Webhook | 专门处理外部 POST 的 handler |
| 消息消费者 | queue subscriber、event listener、Kafka consumer |
| 前端动作入口 | 按钮/表单提交绑定的 handler（如果项目含前端） |

#### 3.2 每个入口点必须携带的字段

```json
{
  "entry_id": "entry-http-post-agents",
  "kind": "HTTP_ROUTE",
  "location": "src/routes/agents.ts:24",
  "trigger": "external POST",
  "next_hop": "src/controllers/agent-controller.ts:createAgent",
  "evidence_quote": "router.post('/agents', createAgentHandler);"
}
```

`evidence_quote` 必须来自**本回合实际读取的文件**，符合 `evidence-policy.md` 的门 0。如果某个入口类别在项目中不存在，侦察Agent**不得**凭“通常这种项目会有”而虚构一个，必须写入 `unverified`，格式见第 4 节。

#### 3.3 入口点的数量纪律

侦察Agent**不限制**入口点数量，但每个入口点必须带 `location` 和 `evidence_quote`。如果入口点超过 20 个，侦察Agent可以在 `entry_points` 中只保留**每个类别的前 5 个代表性入口**，其余标记为 `entry_points_truncated: true` 并在 `unverified` 中说明“该类别共有 N 个入口，已截断，完整列表需在发现波按需读取”。**不允许**在没有说明的情况下静默截断。

---

## 第 4 节：UNKNOWN / unverified 标记——完整枚举与可操作格式

`unverified` 是侦察Agent诚实性的核心输出。它必须覆盖以下五类情况，**每一类都不能省略**：

| `reason` 枚举 | 含义 | 示例 |
|---|---|---|
| `READ_FAILED` | 文件存在但无法读取（权限、编码、工具限制） | `{"target": "src/legacy/old.php", "reason": "READ_FAILED", "detail": "permission denied"}` |
| `AMBIGUOUS_TYPE` | 文件扩展名不在纳入列表内，但可能是源码或强相关 | `{"target": "src/runtime/handler.wasm", "reason": "AMBIGUOUS_TYPE"}` |
| `ORPHAN_FILE` | 文件不属于任何按行数划分的切片，且无法按模块合并 | `{"target": "scripts/migrate.ts", "reason": "ORPHAN_FILE", "detail": "root-level script, no sibling to merge"}` |
| `NO_ENTRY_FOUND` | 某个入口类别未发现任何实例 | `{"target": "CLI", "reason": "NO_ENTRY_FOUND", "detail": "no argparse/click/cobra usage found"}` |
| `TRUNCATED` | 入口点或切片因数量过多被显式截断 | `{"target": "entry_points.HTTP_ROUTE", "reason": "TRUNCATED", "detail": "12 routes found, 5 retained"}` |

**硬规则**：`unverified` 中每一条必须带有 `target` 和 `reason`。**不允许**写“一些文件可能有问题”这种没有 `target` 的模糊条目。`unverified` 为空数组是合法的，但前提是侦察Agent确实检查了上述所有类别且全部有结果。

---

## 第 5 节：内建交叉校验——覆盖探针与切分校验

侦察Agent的切片清单必须经过**两个低成本的交叉检查**，而不是直接返回给主Agent。

#### 5.1 覆盖探针（Coverage Probe）

侦察Agent在完成切片后，必须做一次**全量文件列表 vs 切片文件列表的集合差**：

```
all_source_files = 按 2.3 的扩展名规则扫描整个项目得到的文件集合
sliced_files = 所有切片 files 的并集
uncovered = all_source_files - sliced_files
```

如果 `uncovered` 非空，侦察Agent**必须**把每个未覆盖文件写入 `unverified`，`reason` 为 `ORPHAN_FILE` 或 `READ_FAILED`（按实际情况）。这个探针确保侦察Agent不能因为“漏看了某个文件”而让一个可审计的源文件静默消失。Cloudflare 的 coverage-led hunting 正是为了防止“skipped sections”，这一步在侦察阶段就先把覆盖账本建立起来[^ref9]。

#### 5.2 切分独立性校验

侦察Agent在返回前必须检查：**任意两个切片的 `files` 集合是否相交**。如果相交，侦察Agent**不得**直接返回并让主Agent去处理冲突，而是必须自行修正——把相交的文件移入 `shared_dependencies`，或将其归入引用次数更多的切片并调整另一个切片的 `rationale`。修正后再次校验，直到所有切片的 `files` 两两不相交。

**为什么校验放在侦察Agent内部而不是主Agent**：主Agent没有读取文件的权限，无法判断“这个共享文件到底应该归谁”；侦察Agent有文件读取能力，并且它的任务边界就是“产出可独立扇出的切片”，修正切分是它的职责，不是主Agent的调度职责。

#### 5.3 最小规模校验

如果经过切分和合并后，`audit_slices` 的数量为 **0**，侦察Agent**必须**返回 `RETRYABLE_FAILURE` 并在 `error` 中说明“未找到任何符合条件的源代码文件，可能扩展名规则不匹配或项目路径错误”，而不是返回一个空的 `audit_slices` 让主Agent去猜测。如果 `audit_slices` 数量为 **1**，且该切片 `file_count` 小于 5，侦察Agent应当检查是否确实只有一个独立工作单元；如果是，返回该切片并在 `rationale` 中说明“项目仅有一个可审计单元，无法进一步切分”。

---

## 第 6 节：与 `scale-mapping.md` 的精确对接

侦察Agent的返回必须让主Agent在**不阅读任何切片内容**的情况下，直接完成 `scale-mapping` 的输入计算：

- `slice_count` 必须等于 `len(audit_slices)`，主Agent不做仲裁；
- `unverified` 中的条目在 `scale-mapping` 中作为**追加切片**计入 `effective_slices`，因此 `unverified` 的 `target` 必须是可审计的文件路径或明确的入口类别，而不是模糊描述；
- `entry_points` 只写入 `handoff-schema` 的 `open_items` 或直接传给验收波，**不参与 `effective_slices` 的计算**；
- `harness_concurrency_cap` 由侦察Agent从运行时环境读取或声明；如果无法读取，必须写入 `null`，由主Agent按 `scale-mapping` 的规则取保守值 `4`，侦察Agent不得自行推测一个并发数。

---

## 第 7 节：返回前的自检清单（侦察Agent执行）

侦察Agent在发出 `output-contract` 返回前，必须逐项确认：

| 检查 | 通过条件 | 失败动作 |
|---|---|---|
| 切片独立性 | 任意两个 `audit_slices.files` 无交集 | 修正后重新校验 |
| 切片大小 | **每个切片 `line_count ≤ 1800`**（唯一例外：`oversized_file: true` 且 `rationale` 已说明）。`file_count` 只作参考，不作为通过条件 | 按行数拆分 |
| 覆盖完整性 | `all_source_files - sliced_files` 为空，或每个差集文件已在 `unverified` 中 | 补写 `unverified` |
| 入口点证据 | 每个 `entry_points` 条目有 `location` 和 `evidence_quote`，`evidence_quote` 来自本回合读取 | 删除无证据条目，写入 `unverified` |
| UNKNOWN 完整性 | 五类 `reason` 均被检查，缺失类别有对应的 `NO_ENTRY_FOUND` 或 `READ_FAILED` 记录 | 补全 |
| 无规模标签 | 返回中不出现“小型/中型/大型/企业级”或类似语义标签 | 删除 |
| `slice_count` 一致性 | `slice_count == len(audit_slices)` | 修正 |
| 无 `findings` | `payload` 中不存在 `findings` 数组（侦察波次不产出缺陷） | 删除 |

---

---

## 参考来源

[^ref4]: [cih-agent - Continuous Improvement Harness (CIH)](https://pypi.org/project/cih-agent/0.2.5/#1)
[^ref5]: [Fan-out auditing: making AI coding agents actually read your entire codebase - DEV Community](https://dev.to/lachiejames/fan-out-auditing-making-ai-coding-agents-actually-read-your-entire-codebase-31ba#comments#1)
[^ref6]: [Fan-out auditing: making AI coding agents actually read your entire codebase - DEV Community](https://dev.to/lachiejames/fan-out-auditing-making-ai-coding-agents-actually-read-your-entire-codebase-31ba#comments#1)
[^ref7]: **（已移除）** 原引用 `zenodo.org/records/19520243/.../orthogonal-63.pdf` 声称支撑「LobeHub typically 5–10 files per chunk」，经核实该 PDF 全文不含此内容。此脚注编号保留为空，避免其他文件的脚注编号错位。
[^ref9]: [Cloudflare Open-Sources security-audit-skill for Multi-Agent Code Auditing | TAU-HOME.COM](https://tau-home.com/en/post/dev_tool-2112125353594401162/)
