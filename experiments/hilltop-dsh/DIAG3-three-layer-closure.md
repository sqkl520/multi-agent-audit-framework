# DIAG3 · 三层闭环的实际断裂点

> 只读分析。不改仓库任何文件，不新增校验器。
> 框架根：`D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework`
> 实验目录：`experiments/hilltop-dsh/`
> 本文所有结论均带 `文件:行`。凡未见证据者明确写「无」。

---

## 0. 先给结论

三层闭环 = ①执行模板（`framework/templates/*.md` + `framework/wrappers/*.md`）+ ②契约 schema（`framework/components/output-contract.md` + `state.json` 字段定义）+ ③校验器（`tools/check-*.mjs`）。

**断裂点不在层 3 的「没写」，而在层 2 的「没定义字段」——层 3 因此没有可校验的对象。** 校验器只能校验产物格式，而「该派子 agent 却单 session 串行干了」这件事在层 2 的 schema 里根本不是一个字段，所以层 3 无论怎么写都读不到它。

四条可一句话核实的结论：

1. **派发形态的检出能力 = 0/11。** 11 个校验器逐个读过源码（第 1 节），全部是产物格式校验器。其中 `gate.mjs` 的 dispatch 门语义是反的——它校验「已经决定要派的那个请求」，**不派就永远不触发**（1.11）。
2. **框架自称的「三层闭环」有一个校验器，判据是词频。** `lint-autonomy.mjs` 的 L13 标题就叫「必填字段三层闭环」（`:794`），实际用的是 `RegExp('\\b'+field+'\\b').test(text)`（`:852-856`）——**只查这个词在三份文档里出现过**，不查规则成立过。
3. **修复阶段的相位在 schema 里不存在。** `phase` 枚举 7 个值不含 `wave4`/`wave5`（4.1），`stop-hook.mjs:70` 的白名单同样不含，`check-state.mjs:55` 是同一份枚举的副本。修复阶段三条门控判据全跳过（4.3）。
4. **`spawned_agents` 字段存在于 `protocol.md:987`，不存在于任何工具里。** `grep -rn "spawned_agents" tools/` = 0 命中。这是「规则要求往一个不存在的地方写」的第三次发生（前两次见 `run-state.md:159`、`:185` 的自述）。

最致命的一层是**层 2**（第 5 节），因为只有它能**让另外两层的缺失看起来正常**。

本实验的现场证据：`repair/MAIN-THREAD-VIOLATION.md` 里主 agent 自述「读了 .java 源码、手写 4 个测试文件、跑 build.sh 多次、用 Edit 直接改生产代码……这些全部应该由 dsh 的子 agent 执行」——而框架对此**没有任何一个校验器能报错**。

---

## 1. 逐个校验器判定

三者要分清楚，因为本诊断的核心结论依赖这个区分：

- **产物格式**：只看「交上来的这份文件长得对不对」
- **任务真实性**：看「这份产物背后，声称做过的事是否真的发生过」
- **派发形态**：看「这件事是谁干的——子 agent 还是主 agent 自己」

**全框架没有任何一个校验器属于第三类。** 下表逐个证明。

### 1.1 `check-payload.mjs`（1094 行）

| 项 | 判定 | 证据 |
|---|---|---|
| 校验什么 | **产物格式**，且仅限最后那个 ```json 信封 | `:69` 取 `blocks`；`:87-95` 从后往前找 `looksLikeEnvelope` 的块；正文散文一律不校验 |
| 能检测「该派子 agent 却自己干了」吗 | **不能** | role 分支共 6 处：`sweep:351` / `recon:387` / `audit:451` / `critique:652` / `planner:943` / `verify:1001`。**无 `role === 'fix'` 分支**。而 fix 是修复阶段唯一角色。 |
| 能检测「HIGH 级没修」吗 | **不能** | `ROLE_REQUIRED.fix = ['files_touched']`（`:283`），只看这一个键在不在。`finding_id` / `affected_issues` / severity 一个都不查。一份什么都没修、但写了 `files_touched: []` 的 fix 产物判「契约合规」。 |
| 输入为空就跳过吗 | **不会，而且这是它做得最好的一处** | `:69-74` 无信封直接 `no_json_envelope` FAIL；`:460-468` `findings: []` 直接 `empty_findings` FAIL。<br>实测过的两次假绿都已修：`findings` 空数组曾判合规；`status` 缺省曾跳过检查（`:470-478` 注释明写「此前是 `f?.status !== undefined && ...`——不写 status 就跳过检查」）。 |
| catch 异常报 success 吗 | **不会** | `:117-129` 两处 `catch` 都把 `envelope` 置 `null` 并 push `json_parse_failed`。容错修复（尾随逗号）会留 WARN。 |
| 附带发现 | `artifact_path` 存在性检查有后门 | `:239` `const skipExists = args.includes('--no-exists')`。加了这个 flag，产物不存在也放行。所有路径检查都可被一次命令行参数关掉。 |
| 附带发现 | 路径不参与「契约合规」判定的一致性 | `:262` 存在性检查只在 `role` 有分支时才可能触及；而路径约定（仓库根相对 vs `com/hilltopvillage` 相对）不在它的判定范围内。这就是「7/7 契约合规」与 `verify-artifacts` 68~71 FAIL 可以并存的原因。 |

### 1.2 `check-blindspots.mjs`（218 行）

| 项 | 判定 | 证据 |
|---|---|---|
| 校验什么 | **源码里的三个模式**（B1 活引用 / B2 守卫不一致 / B3 缺 isFinite）+ B4 未定义名字 | `:15-20` 头注释；`:84` B1 正则；`:94` B2 守卫计数；`:116` B3 正则 |
| 能检测「该派子 agent 却自己干了」吗 | **不能** | 全文无任何 agent / 派发 / 状态概念。输入是源码目录（`:28` `process.argv[2]`）。 |
| 能检测「HIGH 级没修」吗 | **不能** | 它审的是被审项目的代码，不是审计/修复产物。修复前后的差异它看不见。 |
| 输入为空就跳过吗 | **会静默通过** | `:34-45` `walk()` 只收 `.js/.mjs/.cjs/.ts`。若指向一个纯 Java 目录，`files=[]`，`:74` for 循环零次，findings 为空 → 打印「未发现」→ `exit 0`。**没有「一个文件都没扫到」的判据**（对比 `verify-artifacts.mjs:1130` 专门补了这条）。 |
| 能否扩到 Java | **不能，加扩展名也没用** | `:40` 是扩展名白名单，但 `:116` 的规则本体是 `/typeof\s+\w+\s*!==\s*['"]number['"]\|typeof\s+\w+\s*===\s*['"]number['"]/` —— 这是 JS 的 `typeof` 语法。Java 里没有 `typeof`，加 `.java` 白名单后 B3 仍然 0 命中。`extractMethods`（`:52`）的正则也是 JS 方法语法。**伪修复陷阱**：改 `:40` 会让工具「支持 Java 了」，实际全部规则失效。 |
| catch 异常报 success 吗 | 不会，但是 `continue` 吞掉 | `:77` `try { readFileSync } catch { continue; }` —— 读不了的文件静默跳过，不计数、不 WARN。 |

### 1.3 `check-promises.mjs`（148 行）

| 项 | 判定 | 证据 |
|---|---|---|
| 校验什么 | **JSDoc 与实现的承诺差**，三条：P1 `@returns` 无 return、P2 `@throws` 无 throw、P3 声称只读却无 freeze | `:99-108` / `:111-114` / `:117-130` |
| 能检测「该派子 agent 却自己干了」吗 | **不能** | 输入是源码目录（`:26`），无 agent 概念。 |
| 能检测「HIGH 级没修」吗 | **不能** | 看的是被审项目代码。 |
| 为什么抓不到 A-04-c | **硬性前提不成立** | P1（`:99`）要求 `@returns {number}` 这类 JSDoc 存在，且类型在 `['boolean','number','string','object','Array']` 内（`:102`）。A-04 的 `loadFromFile()` 原本是 `void` 且**无 Javadoc**——前提不成立，P1 不可能触发。此外 `:38` 扩展名白名单同样排除 `.java`，`:54` 的函数识别正则是 JS 语法。**三重不命中**。 |
| 输入为空就跳过吗 | **会静默通过** | `:45` `const files = walk(root)`，空目录 → `:138` 打印「承诺兑现检查: 0 个文件」→ `:139-141` 打印「未发现」`exit 0`。0 个文件被当作「检查通过」。 |
| catch 异常报 success 吗 | `continue` 吞掉 | `:94` `try { src = readFileSync } catch { continue; }`。 |
| 诚实度加分项 | 头注释 `:15-18` 主动写明「做不到的」三类 | 这条纪律值得保留 |

### 1.4 `check-deliverables.mjs`（297 行）

| 项 | 判定 | 证据 |
|---|---|---|
| 校验什么 | **文件名 + 报告章节标题** | `:102` 要 `${roundId}-final-report.md` 与 `${roundId}-ledger.md`；`:120-128` 六个必需节关键词；`:145` 「每节必须独占一个标题、一个标题只能满足一节」 |
| 能检测「该派子 agent 却自己干了」吗 | **不能** | 无 agent 概念。 |
| 能检测「HIGH 级没修」吗 | **不能** | 只查「发现汇总」这个**标题**在不在，不查里面列了几条、修了几条。 |
| 输入为空就跳过吗 | 不会，但会以「必交付文件缺失」形式失败 | `:100-104` 文件不存在 → `fail('D1', ...)`。这比静默通过好，但**语义仍错**：它报的是「你少了报告」，不是「你少了修复」。 |
| catch 异常报 success 吗 | 会 | `:74` `catch { /* 忽略 */ }`、`:83` `catch { /* 忽略 */ }` —— 读 `state.json` 失败被静默忽略，然后退回目录名推断 round_id（`:50-60`）。降级是有意的，但**降级无日志**。 |
| 本实验中的实际状态 | **从未被触发** | 需要 `--round-dir`（`:30`），而 `experiments/hilltop-dsh/` 下没有 `state.json`、没有 `*-final-report.md`。谁都没跑它。 |

### 1.5 `check-state.mjs`（332 行）

| 项 | 判定 | 证据 |
|---|---|---|
| 校验什么 | **state.json 的 schema 与内部自洽** | `:52-66` `ENUM`；`:72` `TOP_REQUIRED`；`:201-222` `fix_contracts` 七字段；`:233` 执行相位必须有 plan |
| 能检测「该派子 agent 却自己干了」吗 | **不能** | 它只校验 `in_flight` / `slices` 的**内部一致性**（`:286-292` 冲突告警）。**「in_flight 为空」本身完全合法**——一个从没派过任何 agent 的运行，state.json 也是合规的。<br>**关键**：`budget.spawned_deep_dive` 是「实际派发的深挖实例数」（`run-state.md` 第 2 节），但 `check-state.mjs` 全文**不校验它**（`grep spawned` = 0 命中）。 |
| 能检测「HIGH 级没修」吗 | **不能，而且是结构性不能** | 它检查 `fix_contracts[]` 的七个前置字段是否齐（`:204-210`），但**不检查 `fix_contracts` 是否覆盖了所有 UPHELD 的 finding_id**。不存在「应有集合」这个输入——它拿不到审计报告里的 finding 清单，因为没有字段指向它。 |
| 输入为空就跳过吗 | **会，`exit 2` 但无人调用** | `:28-30` 无参数 `exit 2`；`:31-34` 文件不存在 `exit 2`。`exit 2` 是「用法错误」，在很多 shell/CI 流程里等同于「跳过」。<br>更要紧的是：本实验**没有 state.json**，所以它连 `exit 2` 都没机会报。 |
| catch 异常报 success 吗 | 不会 | `:38-42` JSON 解析失败 → `exit 1`。 |
| 附带发现 | 相位白名单与 stop-hook 完全一致 | `:55` `phase: ['init','wave1','wave2a','wave2b','wave3','report','closed']`；`:233` 同样是 `['wave2a','wave2b','wave3']`。**两处都不含 wave4/wave5**——这不是笔误，是同一份枚举被复制了两遍。 |

### 1.6 `check-pattern-coverage.mjs`（188 行）

| 项 | 判定 | 证据 |
|---|---|---|
| 校验什么 | **fixture 的 manifest 里每条 ground truth 缺陷有没有 `pattern` 归属** | `:44-47` 写死两个 `MANIFESTS`；`:71-73` 校验 `pattern`；`:83-95` `pattern="none"` 必须有 `none_reason`；`:107-110` 必须有 `none_keywords` |
| 能检测「该派子 agent 却自己干了」吗 | **不能** | 输入是两个 fixture manifest（`:45-46`），与被审项目、与运行过程都无关。 |
| 能检测「HIGH 级没修」吗 | **不能** | 它衡量的分母是「fixture 的缺陷数」，不是「本轮审计的发现数」。 |
| 输入为空就跳过吗 | 不会，明确 `exit 2` | `:65-68` manifest 没有 defects → `exit 2`。这条做得对。 |
| catch 异常报 success 吗 | 无 catch | — |
| 用途定位 | **框架自测工具，不是运行期校验器** | 它校验的是「模式库覆盖 fixture 的质量」，跑一次可以，与某次审计是否合规无关。`check-all.mjs` 里它被当自测跑（`script: 'check-pattern-coverage.test.mjs'`）。 |

### 1.7 `check-contract-slices.mjs`（114 行）

| 项 | 判定 | 证据 |
|---|---|---|
| 校验什么 | **契约切片文档有没有漏掉该角色的必填字段** | `:33-42` 从 `check-payload.mjs` 解析 `ROLE_REQUIRED`；`:63` `missingFields`；`:45-49` 三个通用节 |
| 能检测「该派子 agent 却自己干了」吗 | **不能** | 对象是 `framework/components/output-contract/*.md`。 |
| 能检测「HIGH 级没修」吗 | **不能** | — |
| 输入为空就跳过吗 | 会「零切片也绿」 | 若 `ROLE_REQUIRED` 解析出空对象（`:40` 正则不匹配时 `roleRequired = {}`），`:54` 循环零次，`results=[]`、`problems=[]`，`:108-110` 打印「0 份切片全部完整」`exit 0`。**解析失败被当作「没有角色」而不是「解析器坏了」**。（`:35-38` 对整块 `block` 不匹配有 `exit 2`，但**块存在而条目正则不匹配**时没有兜底。） |
| 附带发现 | fix 角色只有 1 个必填字段，切片也就只要 1 个 | 这直接继承了 `ROLE_REQUIRED.fix = ['files_touched']` 的缺口，并被 L13 当作「三层闭环成立」的证据 |

### 1.8 `check-wrapper-contract.mjs`（208 行）

| 项 | 判定 | 证据 |
|---|---|---|
| 校验什么 | **wrapper 文本里有没有提到该角色的必填字段**（三档：强/中/弱） | `:38-46` `ROLE_WRAPPER` 映射；`:56-75` `splitSections` 切「产物格式」区；`:148-166` 分档与 problems |
| 能检测「该派子 agent 却自己干了」吗 | **不能** | 纯静态文本比对。 |
| 能检测「HIGH 级没修」吗 | **不能** | — |
| 输入为空就跳过吗 | 非 strict 下「中」不算失败 | `:161` `if (level === 'medium' && !strict) continue;`。默认模式下字段只写了一句「记得填 X」即通过。<br>**而且这个校验器本身根本没被接线**：`check-all.mjs:134` 的条目是 `script: 'check-wrapper-contract.test.mjs'`——跑的是**自测**，不是校验器本体。全文搜索 `check-wrapper-contract` 在 `check-all.mjs` 里只有这 1 处命中。**校验器写好了，但没有任何流程调用它。** (同一处病史在 `check-wrapper-integrity` 上被修过：`check-all.mjs:94` 注释明写「此前只有 script、没有 args，于是总检跑的是不含基线对比的版本，永远是绿的……**检查器写对了，只是没接上线**」。) |
| 附带发现 | fix-worker.md 的字段覆盖是「查得到」而不是「强制」 | `fix-worker.md:68` 写了四个字段，但校验器只要求其中一个（`files_touched`）。wrapper 写得比契约严，契约比 wrapper 松——**以契约为准，四个字段变一个**。 |

### 1.9 `lint-autonomy.mjs`（1191 行）

| 项 | 判定 | 证据 |
|---|---|---|
| 校验什么 | **框架文档自身有没有退回到「等用户 / 不动」的旧规则** | 19 条规则 `L1..L19`，见 `:13-17` 与 `:653/724/760/794/882/946/988/1042/1081/1111` |
| 能检测「该派子 agent 却自己干了」吗 | **不能** | 它扫的是 `framework/**/*.md` + `README.md` + `START-HERE.md`（`:46-77`）。被审项目与运行产物都不在扫描范围。 |
| 能检测「HIGH 级没修」吗 | **不能** | — |
| **L13「必填字段三层闭环」实际在查什么** | **只查「这个词在不在这三份文本里」** | `:794` 标题写着「必填字段三层闭环」，但判据是 `:852-856` 的 `hasField(text, field)` —— **`RegExp('\\b' + field + '\\b').test(text)`，词边界子串匹配**。它检查的是**文字出现过**，不是**规则成立过**。<br>这是本诊断最重要的一条：**框架自称的「三层闭环」有一个校验器，而那个校验器的判据是「三份文档里都有这个词」。** |
| L13 的字段清单从哪来 | 从 `ROLE_REQUIRED` 自动提取（`:822-836`）+ 9 个手挑项（`:808-818`） | 自动提取是对的（`:800-805` 注释说明了原因）。但它提的是**校验器的字段表**——如果校验器对 fix 只要求 1 个字段，L13 就只查这 1 个字段的三处出现。**缺口的源头在 `check-payload.mjs:283`，L13 把它当成了基准。** |
| 输入为空就跳过吗 | 会 | `:46` `walk(FW)` 空目录 → `docs=[]` → 各规则的正则 `test('')` 多为 false → 部分规则会 FAIL（L4/L5 是「缺要素」型，空输入必 FAIL），但 L1/L3 是「出现了才报」型，空输入必过。**混合型**：同一份空输入下，有的规则假绿、有的假红。 |
| catch 异常报 success 吗 | 无 catch | — |

### 1.10 `check-all.mjs`（207 行）

| 项 | 判定 | 证据 |
|---|---|---|
| 校验什么 | **跑 26 个 `*.test.mjs` / fixture 探针，汇总退出码** | `:24-190` `CHECKS` 数组；`:174-200` 逐个 `execFileSync` |
| 能检测「该派子 agent 却自己干了」吗 | **不能** | 它跑的全是**框架自测**。没有一条读被审项目、读实验产物、读 `state.json`。 |
| 能检测「HIGH 级没修」吗 | **不能** | — |
| 输入为空就跳过吗 | **这是它最大的问题：它没有输入** | 全文无 `--repo` / `--round-dir` / `--state` 参数。它永远校验「框架仓库自己」，跑到哪个实验目录都一样。 |
| catch 异常报 success 吗 | 不会，但只报「失败」不区分原因 | `:181-193` 捕获后打印 `exit=N signal=S`。`:184-187` 注释承认「此前只打印『失败』无法区分测试失败和被信号杀掉」。**已部分修复，但仍不区分「断言失败」与「环境缺失」**。 |
| 定位 | **「框架健康检查」，不是「运行合规检查」** | `:5-9` 头注释：「check-all.mjs 报全绿，不代表框架没问题，只代表**那 6 个脚本没报错**」——这句话现在仍然成立，只是 6 变成了 26。 |

### 1.11 `gate.mjs`（212 行）

| 项 | 判定 | 证据 |
|---|---|---|
| 校验什么 | **四道门的编排**：dispatch / accept / close / release | `:38-60` `GATES`；`:107-190` 四段实现 |
| 能检测「该派子 agent 却自己干了」吗 | **不能，而且 dispatch 门在语义上反了** | dispatch 门的输入是 `--payload` + `--ledger`（`:111-118`），即「**你要派的这个任务**能不能派」。它校验的是**已经决定要派**时的合法性，**不校验「本次运行是否派过」**。一个从不派发的运行，**永远不会调用 dispatch 门**，因此永远不违规。<br>这是「缺席即通过」的典型：门只能检查被送到门口的请求，检查不了「根本没来敲门的那些」。 |
| 能检测「HIGH 级没修」吗 | **不能** | close 门只跑 `check-state` + `check-deliverables`（`:151-165`），两者都不看 finding 覆盖率（见 1.4 / 1.5）。 |
| 输入为空就跳过吗 | **大量跳过，且缺参被静默放行** | `:120-124` dispatch 门：`state` 未提供 → `check-state` 根本 not added；`:133-138` accept 门：`repo` 未提供 → `verify-artifacts`（门 0 真实性校验）**整条不执行**，且不产生任何 `results` 条目。<br>`:196-198` `failed = results.filter(!ok)` —— 没被 add 的检查不参与判定。<br>**结果：`node gate.mjs --gate accept --artifact x.md --role sweep`（不带 `--repo`）可以在门 0 完全没跑的情况下打印「✅ 放行」。** |
| catch 异常报 success 吗 | 不会 | `:70-73` 捕获后 `ok:false`。 |
| 附带发现 | release 门只校验框架自身 | `:172-180`：`check-state` + `lint-autonomy`。**与本次运行是否诚实无关**。 |

### 1.12 汇总：11 个校验器对「派发形态」的检出能力 = 0/11

| 校验器 | 产物格式 | 任务真实性 | 派发形态 | 空输入即跳过 | catch→success |
|---|---|---|---|---|---|
| check-payload | ✅ 主职 | ⚠️ 仅 `artifact_path` 存在性，且可 `--no-exists` 关闭 | ❌ | 否（做得对） | 否 |
| check-blindspots | ✅（源码模式） | ❌ | ❌ | **是**（无文件→绿） | `continue` 吞 |
| check-promises | ✅（注释承诺） | ❌ | ❌ | **是**（0 文件→绿） | `continue` 吞 |
| check-deliverables | ✅（文件名+标题） | ❌ | ❌ | 否 | 是（降级无日志） |
| check-state | ✅（schema 自洽） | ❌ | ❌ | `exit 2`（等同跳过） | 否 |
| check-pattern-coverage | ✅（fixture 归属） | ❌ | ❌ | 否（`exit 2`，做对了） | 无 catch |
| check-contract-slices | ✅（文档字段） | ❌ | ❌ | **是**（0 切片→绿） | 无 catch |
| check-wrapper-contract | ✅（文档字段） | ❌ | ❌ | 宽松档（中=过） | 无 catch |
| lint-autonomy | ✅（文档措辞） | ❌ | ❌ | 混合 | 无 catch |
| check-all | ❌ 无运行输入 | ❌ | ❌ | 无输入概念 | 部分 |
| gate | 编排 | ⚠️ 门 0 可整体缺席 | ❌ | **是**（缺参不 add、不判定） | 否 |

**结论**：「该派子 agent 却自己干了」在 11 个校验器里检出能力为 **0/11**。它们全部是**产物格式校验器**，其中仅 `check-payload` 与 `gate accept` 触及「任务真实性」，而两者都能被一个命令行参数或一个缺省参数整体关掉。

---

## 2. 三层闭环核对表

三层：
- **层 1 执行模板** = `framework/templates/*.md` + `framework/wrappers/*.md`
- **层 2 契约 schema** = `framework/components/output-contract.md` + `framework/components/handoff-schema.md` + `framework/artifacts/run-state.md`（state.json 字段）
- **层 3 校验器** = `tools/check-*.mjs` 等

| 强制要求 | 层1 执行模板 | 层2 契约 schema | 层3 校验器 |
|---|---|---|---|
| **每条发现带 file:line + 逐字引用** | ✅ `templates/wave2-audit.md:59`（`quote` 必须自包含，跨区域须拆条各带 `file:line`）；`components/evidence-policy.md:22`（逐字回显） | ✅ `components/output-contract.md:348`（`evidence` 必填且必须是 `{file,line,quote}` 对象，数组即 `evidence_wrong_shape`）；`:257`/`:306`；`audit.md:198` | ✅ **真校验** `check-payload.mjs` 的 `confirmed_without_evidence`（`output-contract.md:374-376` 记录该规则曾判空 quote 合规、现已修，测试 case 68-70）；`verify-artifacts.mjs` 门 0 逐字比对（`:1130` 附近 G7/G3） |
| **必须派生子 agent（不是单 agent 串行）** | ⚠️ **只有暗示，无硬要求**。`templates/wave2-audit.md:802` 写「门 0 合规 / 删除该条」；`wave4-fix.md:43` 假定「修复Agent在派发时收到一个 finding_id」——**模板通篇以「你是一个被派发的 agent」为语境，但没有一句「主 Agent 不得自行执行本任务」**。唯一接近的是 `protocol.md:1087`「不得将失败子任务合并到主线程执行」——**这条在 orchestrator/，不在 templates/wrappers，且只管「失败后合并」，不管「一开始就不派」** | ❌ **无**。`output-contract.md` 定义的是**子 agent 返回的 payload**，它假定「有一个子 agent」。`run-state.md` 的 schema 里 `in_flight[]` 与 `wave2_completed[]` 是**派发的事实账**（`run-state.md` 第 2 节），但**没有「若未派发则违规」的规则**——空数组完全合规。`budget.spawned_deep_dive` 是「实际派发数」（无分母语义），**没有 `required_agents` / `expected_agents` 配对字段** | ❌ **无，且是 0/11**（见第 1.12 节）。`check-state.mjs` 只校验 `in_flight` 与 `slices` 的内部冲突（`:286-292`）；`gate.mjs` 的 dispatch 门只校验「已决定要派的那个」的合法性（`:111-118`），不派就永远不触发 |
| **修复必须先有失败测试证明** | ⚠️ **部分，且方向相反**。`wave4-fix.md:68` 要求填 `test_path`（「不存在则写需新建」）；`:96`/`:179` 要求不得削弱测试。**但 `:21-23` 与 `:50` 明确写「修复 Agent 不得自我验收」「让修复 Agent 自己写测试既不提高解决率也不降低回归率（NeurIPS）」** —— 模板**刻意不要求修复者先跑失败测试**，把该职责推给波次五。而 `wave5-verify.md:24` 要求「在修复前的代码上它会失败，在修复后的代码上它应当通过」——**这是唯一真正要求「失败测试先行」的地方，位于验收模板，不在修复模板** | ⚠️ `run-state.md` 第 2 节 `fix_contracts[]` 有 `disproof_condition` 与 `baseline_result`（「修改前运行 disproof_condition 的实际输出与退出码」）——**这是全框架唯一承载「失败测试」的字段**。但 `baseline_result` 允许为 `null`，只需 `baseline_unverified: true`（`run-state.md` 第 2 节规则表） | ⚠️ **只校验字段在不在，不校验测试真的红过**。`check-state.mjs:204-222` 查 `baseline_result` / `baseline_unverified` 二选一。**`baseline_result` 是一段自由文本**，写 `"FAILED: assertion error"` 即合规。**没有任何校验器执行 `disproof_condition`、也没有校验器读测试的退出码** |
| **HIGH 级发现必须全部修复或给出不修理由** | ❌ **无此规则**。`grep -n "HIGH" templates/wave4-fix.md` = 0 命中（我在 `wave4-fix.md` 全文找不到任何 HIGH 约束）。`wave4-fix.md:43` 的入参只有 `finding_id` + `verdict: UPHELD`，**severity 不参与修复派发**——一条 LOW 与一条 CRITICAL 走完全相同的流程 | ❌ **无**。`ROLE_REQUIRED.fix = ['files_touched']`（`check-payload.mjs:283`）；`output-contract.md` 的 fix payload 示例（`:542`）四个字段里**没有 severity、没有 finding 覆盖率**。`run-state.md` 的 `fix_contracts[]` 有 `finding_id`，但**没有「应有 findng 集合」这个输入**——它无从对比出「缺了哪几条」 | ❌ **无**。`check-payload` 无 `role==='fix'` 分支；`check-state` 只查 `fix_contracts` 每条字段齐不齐（`:204`），**不查覆盖了多少条**。**唯一等价的机制** `verdict_missing_for_target`（`check-payload.mjs:657-668`）只对 **critique** 生效（`:652`），文案明写「漏审一条等于放它直接进入修复波」——**它守着锐评门，修复门没有对应物** |
| **修复产物必须跑契约校验** | ❌ **无**。`grep -c "check-payload\|gate.mjs\|lint-autonomy"` 在 `templates/wave4-fix.md` = **0**，`templates/wave5-verify.md` = **0**。对比 `templates/wave2-audit.md:793` 明确写「自检：`node <FRAMEWORK_ROOT>/tools/check-payload.mjs <你的产物> --role audit`」。<br>**这是本表里唯一「层 2 有、层 1 漏抄」的格子**——见右侧「层 2」列 | ⚠️ **有通用规则，但没有角色级落实**。`components/output-contract.md:53-65`「### 0.2 发送前自检（**强制**）」：`node check-payload.mjs <产物> --role <角色>`，退出码 1 = 「**不得返回**」；`:65` 还规定「**主 Agent 在收到任何子 Agent 返回后，也必须跑一次**」。<br>**但它写在通用节，`wave4-fix.md` / `wave5-verify.md` 没有把它抄进自己的自检表**——而 agent 只加载自己的模板 + wrapper（见 L16 加载量上限）。所以「强制」对修复/验收角色是**不可见的强制** | ❌ **无强制点**。`check-payload` 能校验 fix 角色（但有 `files_touched` 就过），**没有任何东西要求调它**。`gate.mjs` 的 `accept` 门本该承担（`:132-140`），但它要求调用方**主动**带 `--artifact --role`，且 `--repo` 不带则门 0 整体不跑（见 1.11）。<br>**没有任何校验器能回答「这份产物跑过 check-payload 吗」**——校验器无法观测自己是否被调用过 |
| **波次之间必须验证门控** | ⚠️ `protocol.md:1007-1017` 定义了每一波的**布尔闭合条件**（这是在 orchestrator/，不是 templates/）。`protocol.md:1087`「主Agent不得自行降低门控标准，不得将失败子任务合并到主线程执行」——**规则写得极硬**。五波闭合条件里**波次四/五有明确定义**（`:1016`/`:1017`） | ⚠️ `handoff-schema.md` 第 8 节「波次之间的使用规则」定义了 Resume Packet 的传递，但**没有 `gate_passed` 之类的布尔字段**。`run-state.md` 的 `phase` 枚举**不含 wave4/wave5**（见第 4 节），即**门控所需的相位在 schema 里不存在** | ❌ **无**。`gate.mjs` 是门控的**执行器**，但它不记录「跑过没有」。没有 `gate_results` 字段、没有「未过 gate 则拒绝进入下一波」的判据。**`stop-hook.mjs` 是唯一自动门控，但它在 wave4/wave5 三条判据全跳过**（见第 4.3 节） |
| **任务书条目必须携带原始 finding_id** | ✅ `wave4-fix.md:43`（派发时收到一个 `finding_id` + `verdict: UPHELD`）；`wave5-verify.md:23`（`finding_id` + `fix_agent_id` + `disproof_condition`）；`wave4-fix.md:152` `finding_ref` | ✅ `output-contract.md:283` 附近 fix 的 payload 示例含 `files_touched`；`run-state.md` `fix_contracts[].finding_id` 必填（`check-state.mjs:204`） | ⚠️ **只对 verify 检查，不对 fix 检查**。`ROLE_REQUIRED.verify = ['finding_id', 'verdict']`（`check-payload.mjs:284`）→ 有 `finding_id` 检查。<br>`ROLE_REQUIRED.fix = ['files_touched']`（`:283`）→ **fix 角色不要求 `finding_id`**。<br>对照实测：`framework/MANUAL.md:513` 明确写 fix 角色应含「`finding_id`、`files_touched[]`、`verification_commands[]`、`affected_issues[]`、`residual_risks[]`」——**MANUAL 要求五个，校验器只查一个** |

### 2.1 矩阵的读法

七行里：
- **1 行三层齐全**：file:line + 逐字引用（唯一真正闭环的一项，而且它是被反复红队打过的）
- **1 行三层中两层有**：finding_id 传递（模板 ✅ / schema ✅ / 校验器只覆盖 verify）
- **2 行薄弱**：失败测试证明、波次门控（都只有「文档里有规则」，校验器不执行）
- **3 行完全缺席**：派生子 agent、HIGH 全修、修复产物跑校验

**最要紧的是第 2 行**：它在三层里各有一个「看起来像」的东西，但没有一层是硬的。
- 层 1 只有「以子 agent 为语境的叙述」，没有禁止主 agent 自己干
- 层 2 只有 `in_flight` 这种「派了就记」的字段，没有「该派未派」的反向判据
- 层 3 只有 `dispatch` 门这种「派之前检查」的钩子，没派就不触发

**这三者合起来产生了一个自洽的盲区：整个框架只能观测「派发之后发生了什么」，无法观测「根本没有派发」。** 本实验的实测结果（三次运行 subagent 调用 0 次、单 session 最多 196 step / 303 调用）正是落在这个盲区里——所有 11 个校验器都会报绿，因为它们要检查的东西（子 agent 的产物、派发记录的一致性）**一个都不存在，而「不存在」在它们各自的判据下都合法**。

---

## 3. 最关键的判断：只允许加一个校验器，加什么

### 3.1 先回答问题：state.json 里有「派了几个 agent」的字段吗？

**回答分三层，因为答案是「有，但不是你需要的那一个」。**

**（a）`framework/artifacts/run-state.md` 的 state.json schema 里：**

| 字段 | 是「派了几个」吗 | 位置 | 局限 |
|---|---|---|---|
| `in_flight[]` | ⚠️ 是**当前在飞**的列表，不是累计计数 | `run-state.md` 第 2 节 | 派完就清空；**空数组是合法终态**。「全程没派过」与「派完全部完成」在这个字段上完全同形 |
| `budget.spawned_deep_dive` | ✅ **是**「波次二B **实际**派发的深挖实例数」，每次派发后 +1 | `run-state.md` 第 2 节，字段表 | **只覆盖 `deep_dive`，不覆盖 sweep / critique / fix / verify**。修复阶段的派发数**没有对应字段** |
| `budget.planned_sweep_agents` | ❌ 是**计划**数（宽扫），不是事实 | 同上 | 是分母，不是分子 |
| `budget.spent` | ⚠️ 是**累计预算消耗**，可当代理指标 | `run-state.md:222-224` 规则 3「必须来自实际派发计数，不得估算」 | 它与派发数的关系是**约定**，不是约束。校验器只查 `spent <= total_cap`（`check-state.mjs:166-170`），**不查 `spent > 0`** |
| `wave2_completed[]` | ✅ **是**派发事实账，「**客观发生**了哪些派发」（`run-state.md:192`） | `run-state.md` 第 2 节 | **`task` 枚举是 `sweep \| deep_dive`**（`check-state.mjs:66`），**不含 fix / verify**。<br>注意 schema 示例里 `in_flight[].task` 写的是 `"sweep \| deep_dive \| critique \| fix \| verify"`（`run-state.md` 第 2 节），而 `wave2_completed[].task` 写的是 `"sweep \| deep_dive"`——**同一份 schema 内两个 task 枚举不一致**，且 `check-state.mjs` 定义了 `ENUM.task` 却**从未使用**（`grep "ENUM.task"` = 0 命中） |
| `fix_contracts[].fix_agent_id` | ✅ **是**「修复派了哪个 agent」 | `run-state.md` 第 2 节 | 必填（`check-state.mjs:204`），但**是自由字符串**，可以写 `"main-thread"`。且 `fix_contracts` 整个数组**可以为空或缺失**——`check-state.mjs:203` 是 `if (Array.isArray(state.fix_contracts))`，**不存在的数组直接跳过全部检查** |

**结论（a）**：**没有「本次运行每个相位派了几个 agent」的字段。** 最接近的是 `wave2_completed`（事实账）与 `fix_contracts[].fix_agent_id`（修复派发），但它们：
- 覆盖不到 fix/verify 的派发计数（`wave2_completed.task` 枚举不含）
- 集合本身可选，缺了不报错
- 没有「应有数量」作为对照物

**（b）`framework/orchestrator/protocol.md` 另有一套 ledger schema，字段名不同：**

`protocol.md:979-1004`「## 2. 状态账本：唯一的事实来源」定义了一个**完全独立的** `ledger:` 结构，含：

```
ledger:
  planned_agents: int                # 本波计划派发数
  spawned_agents: int                # 实际已派发数（含重派）
  concurrency_cap: int
  total_agent_count: int             # 累计派发数（护栏用）
  agents: [ { agent_id, template, status, attempt, artifact_path, findings_count } ]
```

**`spawned_agents` 与 `total_agent_count` 正是我需要的字段。** 但：

1. **它们不在 `state.json` 里**，在 `protocol.md` 的一段散文代码块里。`run-state.md` 声称自己是「运行状态机（断点续跑的唯一依据）」，而这份 `ledger` 是另一份 schema。
2. **没有任何工具读它**：`grep -rn "spawned_agents" tools/` = **0 命中**。
3. `protocol.md:1014` 的波次二闭合条件写的是「`spawned_agents` 中所有切片的状态均已进入终态」——**引用了一个不存在的账本的字段**。这与 `run-state.md:159` 自己记录的病史一模一样：「规则要求往一个不存在的地方写」。

这是**同一类缺陷的第二次发生**：`run-state.md:159` 记载了 `fix_contracts` 曾「要求往一个不存在的地方写」，`:185` 记载了 `wave2_completed` 同样的问题。现在是第三次——`spawned_agents`。

**（c）真正可用的独立事实源：`tools/dsh-session-audit.mjs`**

这个工具已经在做「数派了几个 agent」：头注释 `dsh-session-audit.mjs:19-21` 明写它回答三个问题，第一个是「**这次运行一共 spawn 了几个子 agent**（按 session 文件里的 parentSession 反查）」。它的输入是 harness 写的 session 目录，**不是主 agent 自述的账本**。

`tools/scan-agent-outcomes.mjs` 也提供独立事实（转录大小、scratch 文件数、通知是否送达），头注释 `:5-8` 明确说「**转录大小不能用来判断子 Agent 是否工作过**」。

**这两者是唯一不由被审查者书写的证据。** 这是设计校验器的关键。

### 3.2 我要加的校验器

**名称**：`tools/check-dispatch-actuality.mjs`（派发真实性门）

**核心思路**：不校验「账本里写了派发」，而校验「**磁盘上的派发痕迹与账本是否一致，且两者是否都非空**」。

判据来自一个铁律：**子 agent 的产物是主 agent 写不出来的。** 一份真正的审计/修复产物里，必有主 agent 无法凭空生成的字段（`evidence.quote` 逐字引用 + `file:line`，这是门 0 已经在强制的东西）。所以派发真实性可以**归约到已经存在的产物真实性校验上**，只需要加「数量与来源」这一维。

#### 输入

```
node tools/check-dispatch-actuality.mjs \
  --state <state.json> \            # 主 agent 自述账本（被审查对象）
  --artifacts <本轮产物目录> \       # 磁盘事实（子 agent 产物）
  --sessions <harness session 根> \ # 独立事实（harness 自己写的）
  [--project <匹配子串>] \
  [--min-agents 1] \                # 缺省 1：至少要有一次真实派发
  [--json]
```

**三路输入缺一不可**，且**任何一路缺失都判 FAIL，不判 SKIP**（这是与全框架现有做法的关键区别，见 3.4）。

#### 判据

**判定 A · 磁盘产物数（不依赖账本）**

```
real_artifacts = { f ∈ artifacts 目录下所有 .md/.json
                 | 该文件含一个可解析的 ```json 信封
                 且 envelope.payload 存在
                 且 check-payload.mjs 对该文件返回 exit 0 }
```

`|real_artifacts|` 就是「至少有多少次真实交付」。

**为什么不能用「文件数」**：本实验实测（本次诊断亲自数的，不是估计）：

| 目录 | `.md` 文件数 | 含 ```` ```json ```` 块的文件数 |
|---|---|---|
| `experiments/hilltop-dsh/out/` | 7 | **7** |
| `experiments/hilltop-dsh/repair/` | 15 | **0** |
| 合计 | 22 | **7** |

（`repair/` 下 15 份：`ACCEPTANCE-ROUND1/2.md`、`ADJUDICATION-2/5.md`、`DISPATCH-PITFALLS.md`、`MAIN-THREAD-VIOLATION.md`、`PRECEDENTS.md`、`REPAIR-LOG.md`、`SUMMARY.md`、`done-1/3/4/6/7/8.md`。逐份检查，**15 份全部无 JSON 信封**。）

按文件数会得出「22 次交付」，按信封数会得出 **7**。而这 7 份**全部来自审计阶段**（`round1-core` / `round2-×3` / `round3-A/B/C`），**修复阶段贡献 0**。

**这一步必须复用 `check-payload`，不能自己写一套宽松解析。** 另外注意 `output-contract.md:30` 自己记录过同一现象：「**2026-11-09 实测：15 个真实产物，0 个含 JSON 信封（100% 不合规）**」——本实验的 `repair/` 恰好是 **0/15**，与那段病史同形。

**判定 B · harness 事实（不依赖账本、不依赖产物）**

```
spawned = dsh-session-audit.mjs 报告的、parentSession 指向本轮的子 session 数
```

若 `--sessions` 指向的目录不存在或不可读 → **FAIL（`sessions_unreadable`），不是 SKIP**。

**判定 C · 账本一致性**

```
declared = state.wave2_completed.length
         + (state.fix_contracts?.length ?? 0)
         + (state.in_flight?.length ?? 0)
```

三条交叉：

| 检查 | 规则 | 失败码 |
|---|---|---|
| C1 | `spawned >= min_agents` | `no_real_dispatch` |
| C2 | `|real_artifacts| >= min_agents` | `no_real_artifact` |
| C3 | `spawned >= declared` 且 `|real_artifacts| >= declared` | `ledger_overclaims` |

C3 的方向是**单向**的：**账本可以比事实少（主 agent 漏记），但绝不能比事实多（主 agent 虚报）。** 反过来写会逼主 agent 把每个内部动作都记成派发。

**判定 D · 串行退化信号（本校验器的真正目标）**

派发真实性还不足以防住「串行化」。真正的症状是**一个 session 干了全部工作**。用已有的独立事实来测：

```
session_steps = 本轮主 session 的 step 数（来自 harness transcript）
calls_per_step = 工具调用总数 / step 数
```

退化判据（三条同时成立）：

```
D1: spawned < declared 或 spawned == 0     # 没有真实的并行派发
D2: session_steps > 100                    # 主 session 异常长（实测 196 step / 303 调用）
D3: calls_per_step > 1.3                   # 主 session 在密集调工具，不是只在调度
```

**为什么 D3 用 1.3**：主 agent 的调度动作是「派发 → 等 → 读返回 → 写账本」，每 step 约 1 个工具调用。实测的 303 调用 / 196 step ≈ 1.55，说明它在**连续做执行动作**（读源码、写测试、跑构建）。这个阈值是启发式，**必须允许配置且有文档说明它的经验性质**——不要假装它是精确的。

#### 失败报什么

每条失败必须包含**可执行的下一步**，而不是「不合规」：

```
✗ [no_real_dispatch] 本次运行没有产生任何真实派发。
    事实: harness session 记录到 0 个子 session（--sessions 指向 <path>）
    事实: 产物目录 <path> 里 0 份产物通过 check-payload
    账本: state.wave2_completed = [] / fix_contracts = 缺失

    这意味着「自己干了」而不是「派了但失败」——后者会有 PERMANENT_FAILURE 记录。
    按 protocol.md:1087「不得将失败子任务合并到主线程执行」，本次运行的全部
    产物不得计为审计/修复成果。

✗ [ledger_overclaims] 账本声称 8 次派发，磁盘上只有 3 份有效产物，harness 记录 0 个子 session。
    按取证顺序列出三个数：
      声明(spawned)=0  账本(declared)=8  产物(real_artifacts)=3
    账本比事实多出的 5 条：<逐条列出 agent_id / slice_id>
    这是虚报，不是漏记。虚报方向不可容忍（见 C3 单向性）。
```

#### 退出码

| 码 | 含义 |
|---|---|
| 0 | 三路一致，且有真实派发 |
| 1 | 任一条判据失败 |
| 2 | **用法错误**（缺参数）。特别地：**缺 `--sessions` 也返回 2，且 `gate.mjs` 必须把 2 当作"未通过"** |

**为什么缺参必须是 2 而 gate 必须把 2 当失败**：这正是 `gate.mjs` 现在的漏洞（`:133-138`：`repo` 未提供则 `verify-artifacts` 整条不跑、不产生 results 条目，`:196-198` 只对 `results` 里的项判失败）。**新校验器必须在 gate 里以「缺参即拒绝」的方式接线**，否则它会重复同一个缺陷。

### 3.3 为什么不能被绕过

这是这个设计的关键。逐条对照绕过手法：

| 绕过手法 | 为什么无效 |
|---|---|
| **主 agent 在主线程自己产出合规产物，然后声称派了子 agent** | 判定 B 用 harness 的 session 目录（`dsh-session-audit.mjs` 的 `parentSession` 反查）。**这个文件不是主 agent 写的**，是 harness 写的。主 agent 无法伪造（除非它能写 harness 的 session 目录，那已经是逃出沙箱，不在本框架防御模型内）。 |
| **主 agent 删掉证据、留下空目录** | 判定 A 与 B 都要求 `>= min_agents` 且缺一路判 FAIL。空目录 = 两个事实都为 0 = `no_real_dispatch`。**「空」不再是合法的通过态**，这是与全部现有校验器最大的不同（见 3.4）。 |
| **主 agent 把 `fix_agent_id` 写成 `"main-thread"` 混过去** | 判定 C3 是**双向的**：账本声明 1 次修复 → 判定 A 要求至少 1 份通过 `check-payload` 的 fix 产物（含 `files_touched` 且路径真实存在）→ 判定 B 要求至少 1 个 harness session。写 `"main-thread"` 只满足了账本，满足不了另外两路。 |
| **复用上一轮的产物充数** | 判定 A 只数**本轮产物目录**（`--artifacts` 是必需参数，指向本轮目录）。加上 **`artifact_path` 的真实性**：信封的 `artifact_path` 是必填顶层字段（`output-contract.md:88`），`check-payload.mjs:262` 会解析它（相对路径按产物所在目录解析）并检查存在性。跨轮复用时 `artifact_path` 要么指向旧目录、要么不存在。<br>**注意**：不能用 `trace_id` 做这一层——**信封里没有 `trace_id` 字段**（顶层字段只有 `schema_version` / `agent_id` / `role` / `status` / `contract_valid` / `artifact_path` / `payload` / `error`，见 `output-contract.md:74-86`）。`trace_id` 只在 `state.json` 里。 |
| **把 `min_agents` 设成 0** | `min_agents` 缺省 1，且**必须 > 0**，否则 exit 2。一个「允许 0 个 agent」的门不是门。 |
| **伪造 `sessions` 目录** | 与第一条同理。若担心这一层，判定 B 可以与 `scan-agent-outcomes.mjs` 交叉：那个工具同时读转录大小与 scratch 文件数，两个独立事实必须自洽。 |
| **只在有问题的那一轮不跑这个校验器** | 这是**接线问题，不是判据问题**。必须挂到 `gate.mjs` 的 `close` 门（`:151-165`）与 `stop-hook.mjs` 的 `PHASE_DELIVERABLES`（`:150-154`）里，且**缺参拒绝**。§3.4 说明这一步在本实验里为什么会失败——这是整个方案唯一的真实弱点，必须写清楚。 |
| **主 agent 把整个修复阶段标记成 `path_mode: AUDIT_ONLY`** | 判定 C3 用的是 `declared`（账本实际条目），不是 `path_mode`。账本是空的 → `declared=0` → 若产物目录里有 fix 角色产物，则 `|real_artifacts| > declared`。C3 的单向性允许这个方向（漏记），所以**这一条确实能绕过**。<br>**补法**：判定 D 的 D2/D3（step 数与调用密度）不依赖 `path_mode`，仍然会触发。**所以 D 不是可选的加强项，是 C 的必要补集。** |

**唯一真正的弱点**：这个校验器只能在**被调用**时生效。本实验的根本事实是 `experiments/hilltop-dsh/` 下**没有 `state.json`**，所以 `check-state` / `check-deliverables` / `gate` / `stop-hook` 全部没有被触发（stop-hook 在 `:55-58` 明确 fail-open）。**新校验器如果不改接线，会得到完全相同的命运：写好了，没人跑。**

因此这个校验器的设计**必须**包含一条元要求：它自己要被 `stop-hook.mjs` 的 `PHASE_DELIVERABLES` 引用，且 `stop-hook.mjs:55-58` 的 fail-open 必须改成「报告目录存在但 state.json 缺失 → exit 2」。**否则它只是第 12 个「写好但没接线」的校验器**——`check-wrapper-integrity.mjs` 已经有过一次这样的病史（`check-all.mjs` 的对应条目注释明写：「此前只有 script、没有 args，于是总检跑的是不含基线对比的版本，永远是绿的……**检查器写对了，只是没接上线**」）。

### 3.4 为什么不用「加一个字段」而要用「加一个校验器」

有人会说：在 `state.json` 加一个 `spawned_agents: int` 字段，然后让 `check-state.mjs` 校验 `spawned_agents > 0` 就行。

**这不够，而且正是本框架反复失败的形状。** 理由：

- `spawned_agents` 是**主 agent 自己写的数**。`run-state.md:46` 已经承认过同类问题：「四个字段都只能由实际计数写入，**不得估算**」，而 round31 的 `spent=22` vs 实际 ≥47 就是估算的结果。
- 一个自述的整数，校验器能验的只有「它是个正整数」。**「写 1 但实际是主线程干的」与「真派了 1 个」在数据上完全同形。**
- 而 `dsh-session-audit.mjs` 已经在提供**不由被审查者书写**的同一事实。加字段等于让主 agent 自己给自己发通行证；加校验器等于引入第三方口径。

**这不是「信任问题」，是「证据的可证伪性」问题。** 框架已有的正确做法就是这个方向：`run-state.md:185-195` 用 `discipline_log`（自述）vs `wave2_completed`（事实）vs `artifact_paths`（磁盘）三者交叉。我的校验器只是把「三者交叉」扩展到**第四方：harness**。

---

## 4. `state.json` 的 phase 枚举与 stop-hook 相位白名单

### 4.1 phase 枚举：**不含 wave4 / wave5**

`framework/artifacts/run-state.md`，第 2 节 schema 定义（`phase` 字段）：

```
"phase": "init | wave1 | wave2a | wave2b | wave3 | report | closed",
```

7 个值：`init` / `wave1` / `wave2a` / `wave2b` / `wave3` / `report` / `closed`。

- **没有 `wave4`**
- **没有 `wave5`**
- **没有 `fix` / `repair` / `verify` 任何同义值**

同时注意 `path_mode` 枚举里有 `"AUDIT_ONLY | FIX"`——**框架知道存在 FIX 路径，但没有给 FIX 路径分配相位值**。这是本诊断最关键的一处 schema 缺口。

`status` 枚举：`"RUNNING | PARTIALLY_CLOSED | CLOSED | BLOCKED"`。
`current_plan.phase` 的示例值是 `"wave2a"`（同一 schema 块），即 `current_plan.phase` 也没有 FIX 相位。

### 4.2 `tools/stop-hook.mjs` 的相位白名单：**修复阶段整体不被门控**

`tools/stop-hook.mjs` 全文 174 行，共 3 处相位相关判定：

**判据 1 —— 执行相位必须有计划（`:70`）**

```js
if (['wave2a', 'wave2b', 'wave3'].includes(state.phase)) {
```

白名单只有三个值。`wave4` / `wave5` / `fix` 不在其中——**修复阶段不做「必须有 current_plan + exit_condition + steps」的检查**。

**判据 2 —— 在飞 agent 不许结束（`:114`）**

```js
if (Array.isArray(state.in_flight) && state.in_flight.length > 0) {
```

这一条**不按相位判断**，全相位生效。但只要 `in_flight` 为空数组（修复阶段主 agent 自己干，本来就不会往里写），这条就完全不触发。

**判据 3 —— 相位交付物（`:150-161`）**

```js
const PHASE_DELIVERABLES = {
  wave1: () => state.slices && Object.keys(state.slices).length > 0,
  wave2a: () => Array.isArray(state.wave2_completed) && state.wave2_completed.length > 0,
  report: () => state.report?.final_report_path && existsSync(state.report.final_report_path),
};
const check = PHASE_DELIVERABLES[state.phase];
if (check && !check()) {
```

交付物表只有 3 个相位：`wave1` / `wave2a` / `report`。**`wave3`（锐评）、`wave2b`（深挖）都没有交付物判据**，`wave4` / `wave5` 更没有。

### 4.3 结论：修复阶段 `stop-hook` 的实际行为

| 修复阶段写入的 phase 值 | stop-hook 的三条判据 | 实际效果 |
|---|---|---|
| `wave4`（schema 外，自造值） | 判据1 不匹配（不在白名单）→ 跳过<br>判据2 `in_flight` 空 → 跳过<br>判据3 `PHASE_DELIVERABLES['wave4']` = `undefined` → `check` 为假 → 跳过 | **三条全跳过，`process.exit(0)`，允许随时结束回合** |
| `wave3`（沿用上一相位不更新） | 判据1 匹配 → 检查 `current_plan`<br>判据3 `PHASE_DELIVERABLES['wave3']` = `undefined` → 跳过 | 只留下「计划未闭合」这一条（`:93` 要求 `state.status === 'RUNNING'`，若 status 已改则连这条也不触发） |
| `report`（提前推进） | 判据3 要求 `state.report.final_report_path` 文件真实存在 | 会拦住，但修复还没做完时这条语义是错的 |
| 不写状态 / 状态文件不存在（`experiments/hilltop-dsh/` 实际情形） | `:55-58` 无 state 文件 → `process.exit(0)`；`:61-65` JSON 解析失败 → `process.exit(0)` | **直接放行** |

**关键发现（`:55-58` 与 `:61-65` 两个 `process.exit(0)`）**：没有 `state.json` 时 stop-hook 明确选择「宁可不拦，也不要误拦」。

```js
if (!statePath || !existsSync(statePath)) {
  // 没有账本就无法判断——不阻断（宁可不拦，也不要误拦）
  process.exit(0);
}
```

这是**设计上的 fail-open**。本实验目录 `experiments/hilltop-dsh/` 下确实没有 `state.json`（已核实），所以整个实验从头到尾 stop-hook 一次都没有生效过。**修复阶段的串行不是「门控失效」，是「门控从未存在」。**

### 4.4 附带发现：`hookCtx.stop_hook_active === true` 直接放行（`:51-53`）

```js
if (hookCtx.stop_hook_active === true) {
  process.exit(0);
}
```

这是官方推荐的防死循环写法，但副作用是：只要调用方传入 `stop_hook_active: true`（或 harness 在第二次续跑时置位），**所有检查全部跳过**。一个想让回合结束的 agent 无法直接控制这个字段（它由 harness 填），所以这不是可主动利用的绕过口，但它意味着**门控最多生效一次续跑**。

---

## 5. 三层里哪一层的缺失最致命

**层 2（契约 schema）最致命。**

理由不是它缺得最多，而是**它是另外两层的前提**：

- 层 3 的校验器**只能校验层 2 定义过的字段**。`check-payload.mjs` 对 fix 只查 `files_touched`，不是因为它想不到要查 `finding_id`，而是因为 `ROLE_REQUIRED` 里就只写了这一个（`:283`）。
- 层 1 的模板**没有落点**。`wave4-fix.md` 通篇要求「先写红的测试」「只修一个缺陷」，但这些要求没有对应的 schema 字段承载——`fix_contracts` 是事后补的（`run-state.md:159` 自述「规则要求往一个不存在的地方写」），而 `phase` 枚举至今没有 `wave4`。
- `lint-autonomy.mjs` 的 **L13「必填字段三层闭环」**（`:794`）是这个判断的直接证据：它自称检查三层闭环，判据却是 `hasField()`——**`RegExp('\\b' + field + '\\b').test(text)`，只查「这个词在三份文档里出现过」**（`:852-856`）。它测的是**词汇的存在性**，不是**规则的有效性**。所以「三层闭环」在框架自己的校验器里就是一个词频检查。

**证据链的闭合**：框架最需要的那条规则——「必须派生子 agent」——在
- 层 1：13 个提示词文件（6 templates + 7 wrappers）里 `subagent` / `spawn_agent` / `派发子` 命中数**全部为 0**（实测，见上）
- 层 2：`state.json` 无「应有派发数」字段；`in_flight` 空数组合法；`phase` 无 wave4/wave5
- 层 3：11 个校验器检出能力 **0/11**（第 1.12 节）

三层同时缺席，而每一层都能合理地认为「这是别的层的责任」。**层 2 是那个让缺席得以合法化的层**——只要 schema 里不定义「该有几个 agent」，层 3 的绿灯就是诚实的，层 1 的沉默就是合规的。

**最终一句话**：这三层里，层 2（契约 schema）的缺失最致命——因为它是唯一能让另外两层的缺失「看起来正常」的一层；`lint-autonomy.mjs` 那个名叫「必填字段三层闭环」的 L13 规则只查词频不查语义，正是这个病灶的自我证成。

---

## 6. 附：本次诊断中确认的、与本主题相关的现场证据

| 证据 | 位置 | 说明 |
|---|---|---|
| 主线程越界自述 | `experiments/hilltop-dsh/repair/MAIN-THREAD-VIOLATION.md` | 主 agent 自述「读了 .java 源码、手写 4 个测试文件、跑 `./build.sh` 多次、用 Edit 直接改生产代码」，「这些全部应该由 dsh 的子 agent 执行」。**它同时记下了正确归属**：「保留，不撤回」——即越界产物被采纳 |
| 同一份文档的连带承认 | 同上 | 「我既是执行者又是裁决者，缺少了本应有的交叉质疑」——这正是「修复后无独立验收」的后果 |
| 派发日志 | `experiments/hilltop-dsh/DIAG-DISPATCH-LOG.md` | 记录 5 个 agent 派发、2 成功 3 失败（ECONNREFUSED）；并记录了**框架层面的发现**：「13 个提示词文件的 `subagent` 出现次数全部为 0」「`triage.md` 的 3/5/9 成员下限从未被触发」 |
| triage 下限 | `framework/orchestrator/triage.md:72-76` | T0 最少 **3** 成员、T1 最少 **5**、T2 最少 **9**，且 §3.0 明写「**没有『降级到 2 个』这条路**」。本实验修复阶段实际用了 **1 个**（主线程） |
| 修复任务书 | `experiments/hilltop-dsh/task-repair.md:66` / `task-repair-8.md:51` | **两份任务书都要求「先写能证明它是红的测试」**——即层 1 的「失败测试先行」在**手写任务书里被落实了，在框架模板里没有**（`wave4-fix.md` 无此要求，理由见其 `:21-23` 的 NeurIPS 论证） |
| 修复任务书不要求校验器 | `task-repair.md` / `task-repair-8.md` | `grep "check-payload\|校验\|gate"` 在两份任务书里**只命中一处，且是业务代码**（`task-repair.md:23` 的 `repair-cost-amount` 校验）。**没有任何一处要求跑框架校验器**——与 `wave2-audit.md:793` 明确写「自检：`node tools/check-payload.mjs ...`」形成对照 |
| 门控规则存在但无执行者 | `framework/orchestrator/protocol.md:1087` | 「主Agent不得自行降低门控标准，**不得将失败子任务合并到主线程执行**，不得缩小任务范围后重派」——三句禁令，`grep -rn "合并到主线程\|降低门控\|缩小任务范围" tools/` = **0 命中**。规则写得最硬的一条，是唯一一条完全没有校验器的 |

