# 覆盖率审计：38 条缺陷的最后去向

**日期**：2026-11-15
**方法**：只读分析。38 这个数字不是引用的，是从 `out/` 下 7 份产物的 JSON 信封里机械解析出来的
（7 份产物全部以 ` ```json ` 信封结尾，`payload.findings` 可直接解析，无需人工点表）。
**结论先行**：**38 条里真正被修的只有 6 条（15.8%）**。1 条走了「裁决不修」，**31 条从未进入任何任务书**。
其中 **HIGH 漏掉 2 条**，而且这两条在 HEAD 上仍然存在——不是误报，是真的还在。

---

## 0. 先纠正一个前提

「38 条」这个总数**是对的**，我独立数出来也是 38：

| 产物 | 条数 | HIGH | MEDIUM | LOW |
|---|---:|---:|---:|---:|
| `round1-core-audit.md` | 3 | 0 | 3 | 0 |
| `round2-ai-audit.md` | 5 | 2 | 2 | 1 |
| `round2-mechanics-audit.md` | 5 | 3 | 2 | 0 |
| `round2-arena-audit.md` | 4 | 0 | 3 | 1 |
| `round3-A-audit.md` | 7 | 2 | 5 | 0 |
| `round3-B-audit.md` | 7 | 1 | 4 | 2 |
| `round3-C-audit.md` | 7 | 0 | 3 | 4 |
| **合计** | **38** | **8** | **22** | **8** |

`SUMMARY.md:15-16` 写的 `38 条 / HIGH 8 · MEDIUM 22 · LOW 8` 与解析结果逐项吻合。总数没有虚报。

**虚报的是「然后呢」这一半。** 全部 `repair/` 与 `SUMMARY.md` 里，没有任何一处记录过这 38 条各自的去向。

---

## 1. 38 条 → 修复状态完整对照表

「修复编号」列里的 `#N` 是任务书编号，**不是 finding_id**。这张表的不存在，就是本文要诊断的那个问题。

| # | 来源 | finding_id | 级 | 位置 | 一句话 | 去向 | 修复编号 |
|---:|---|---|---|---|---|---|---|
| 1 | R1-core | F1 | MED | `PlayerGoodsManager.java:422` | ItemStack 序列化实际在异步线程，与类注释相反 | **未触动** | — |
| 2 | R1-core | F2 | MED | `GameManager.java:305` | `victory-waves` 为 0/负数时首波直接判胜 | **已修** | **#7** |
| 3 | R1-core | F3 | MED | `PlayerGoodsManager.java:410` | tmp 名唯一性只靠裸 `System.nanoTime()` | **未触动** | — |
| 4 | R2-ai | R2-AI-001 | **HIGH** | `ExplodeBeetleGoal.java:241` | 同一配置值两处语义不同（倍率 vs 爆炸 power） | **已修** | **#6**（+#7 载入钳制） |
| 5 | R2-ai | R2-AI-002 | **HIGH** | `AirdropSpawnGoal.java:237` | 空 `airdrop-mob-type` 触发 NPE 且每 tick 重试 | **已修** | **#5** |
| 6 | R2-ai | R2-AI-003 | MED | `AirdropSpawnGoal.java:107` | 跨世界 `distanceSquared` 缺 world 守卫 | **未触动** | — |
| 7 | R2-ai | R2-AI-004 | MED | `DropperAttackGoal.java:204` | 30 格限制只在首次锁定时生效 | **未触动** | — |
| 8 | R2-ai | R2-AI-005 | LOW | `HookClawHunterGoal.java:180` | 候选过滤不排除死亡玩家 | **未触动** | — |
| 9 | R2-mech | F1 | **HIGH** | `TabListManager.java:298` | 异常后只清句柄不 cancel，任务累积 | **已修** | **#2** |
| 10 | R2-mech | F2 | **HIGH** | `NodeListener.java:229` | 扣多份物品只恢复一份；cost 无正数校验 | **已修** | **#1**（+#7 钳制） |
| 11 | R2-mech | F3 | **HIGH** | `NodeSystem.java:381` | `addNode` 忽略 `saveNodesToConfig()` 失败仍报成功 | ❌ **未触动** | — |
| 12 | R2-mech | F4 | MED | `NodeSystem.java:719` | buff 刷新周期在调度时固定，热重载不生效 | **未触动** | — |
| 13 | R2-mech | F5 | MED | `ArenaScoreboard.java:480` | `title-key` 不在签名中，单独改不重绘 | **未触动** | — |
| 14 | R2-arena | F1 | MED | `ArenaManager.java:612` | 整段 `game:` 缺失时回落硬编码 2/6/20/30 | **未触动** | — |
| 15 | R2-arena | F2 | LOW | `MultiArenaManager.java:523` | `stopArena` 不更新 `statuses`，仍报 READY | **未触动** | — |
| 16 | R2-arena | F3 | MED | `ArenaInstance.java:468` | 读到被自身调用改写的 DEFEAT 状态，误判幽灵成员 | **未触动** | — |
| 17 | R2-arena | F4 | MED | `ArenaManager.java:305` | 大厅世界未加载时回退主世界却沿用原坐标 | **未触动** | — |
| 18 | R3-A | A-01 | **HIGH** | `ConfigManager.java:1636` | 怪物 `health` 载入不设区间，负值使刷怪任务被杀、波次停摆 | ❌ **未触动** | — |
| 19 | R3-A | A-02 | MED | `WaveSettingsMenu.java:226` | `total-mobs` 载入无上限，GUI 一次右键把 500 压成 100 | **未触动** | — |
| 20 | R3-A | A-03 | MED | `WaveSettingsMenu.java:118` | 新建波次编号无范围校验，生成永不刷出的幽灵波次 | **未触动** | — |
| 21 | R3-A | A-04 | **HIGH** | `MainConfigMenu.java:149` | 重载丢弃未保存修改 / 子菜单缓存旧 cfg / 不消费返回值 | **拆分裁决**（见 §3） | **#3**＋**#8** |
| 22 | R3-A | A-05 | MED | `DisplayConfigLoader.java:204` | 缺省 `tab.header/footer` 解析成空，与 scoreboard 语义相反 | **未触动** | — |
| 23 | R3-A | A-06 | MED | `NumericInputHandler.java:80` | `requestInteger` 对小数静默截断 | **未触动** | — |
| 24 | R3-A | A-07 | MED | `StatsManager.java:314` | 计数器载入无语义校验，脏值霸榜并被写回 | **未触动** | — |
| 25 | R3-B | B-01 | **HIGH** | `ArenaResetService.java:280` | 重置第 8 步失败留 0 节点可开局空图 | **已修** | **#4** |
| 26 | R3-B | B-02 | MED | `AdminDeployManager.java:530` | 写盘失败仍把内存部署数据推给运行实例 | **未触动** | — |
| 27 | R3-B | B-03 | MED | `ArenaManageGUI.java:496` | 按渲染时下标删除，列表变化后删错条目 | **未触动** | — |
| 28 | R3-B | B-04 | LOW | `SetupWizard.java:547` | 向导完成按钮不校验当前步骤 | **未触动** | — |
| 29 | R3-B | B-05 | MED | `ArenaResetService.java:233` | 异常兜底只释放 in-flight，不恢复被禁用场馆 | **未触动** | — |
| 30 | R3-B | B-06 | LOW | `HilltopTabCompleter.java:75` | `config` 补全门与执行门权限节点不同 | **未触动** | — |
| 31 | R3-B | B-07 | MED | `SetupWizard.java:1361` | clear-shop 忽略写盘结果，先删实体后不校验 | **未触动** | — |
| 32 | R3-C | F1 | MED | `ShopConfigLoader.java:46` | 损坏 `shop.yml` 被静默降级为空商店 | **未触动** | — |
| 33 | R3-C | F2 | MED | `ShopConfigLoader.java:123` | MATERIAL 缺 icon 仍发屏障方块 | **未触动** | — |
| 34 | R3-C | F3 | MED | `ShopConfigLoader.java:156` | `price` 缺失时静默按 1 计价 | **未触动** | — |
| 35 | R3-C | F4 | LOW | `ShopConfigLoader.java:165` | 非正 `amount` 钳为 1 仍按原价扣款 | **未触动** | — |
| 36 | R3-C | F5 | LOW | `ShopListener.java:162` | 成功消息用被 `addItem` 改写后的数量 | **未触动** | — |
| 37 | R3-C | F6 | LOW | `CommandsDocumentGenerator.java:189` | 文档声称 TPS 输出不存在的 DisplayEntity 队列 | **未触动** | — |
| 38 | R3-C | F7 | LOW | `CommandsDocumentGenerator.java:441` | 异步直接覆盖 `commands.md`，中断留半截 | **未触动** | — |

### 1.1 合计（机械计数）

| 去向 | 条数 | 占比 |
|---|---:|---:|
| 已修（代码已改、有测试） | **6** | 15.8% |
| 裁决「不修」（有理由、有意为之） | **1**（A-04） | 2.6% |
| **未触动（从未进入任何任务书）** | **31** | **81.6%** |

按严重性：

| 级 | 总数 | 已修 | 裁决不修 | 未触动 |
|---|---:|---:|---:|---:|
| HIGH | 8 | 5 | 1（A-04） | **2** |
| MEDIUM | 22 | 1 | 0 | **21** |
| LOW | 8 | 0 | 0 | **8** |

---

## 2. 「修复条目 → 原始 finding_id」映射

这是任务书**逐条**建立的对应关系。左列是任务书编号，右列是我回查产物得到的原始 finding。

| 任务书 | 标题 | 原始 finding_id | 级 | 状态 |
|---|---|---|---|---|
| **#2** | TabListManager 任务累积 | `R2-mechanics F1` | HIGH | 已修（前序，主线程越界完成） |
| **#5** | AirdropSpawnGoal NPE | `R2-AI-002` | HIGH | 已修（前序，主线程越界完成） |
| **#7** | 载入侧数值钳制 | `R1-core F2`（victory-waves）＋ `R2-AI-001` 的钳制部分 ＋ `R2-mech F2` 的 cost 部分 | MED | 已修（跨 3 条原始 finding 的**载入侧切片**） |
| **#3** | 重载丢未保存修改 | `R3-A A-04`（**子主张 1**） | HIGH | **裁决不修**（设计意图） |
| **#1** | 修复扣多份只恢复一份 | `R2-mechanics F2` | HIGH | 已修 |
| **#6** | 爆炸倍率语义混用 | `R2-AI-001` | HIGH | 已修 |
| **#4** | 重置第 8 步留 0 节点 | `R3-B B-01` | HIGH | 已修 |
| **#8** | reload 消息说谎 | **⚠ 不在 38 条内 → 新发现** | — | 已修 |

### 2.1 两个必须点名的结构性问题

**(a) `#7` 不是一个缺陷，是一个横切切片。**
它把三条不同 finding 里「载入侧缺钳制」这一个侧面抽出来当成一个任务。后果是：
`R2-AI-001` 与 `R2-mech F2` 在表里看起来「已修」，但**它们的语义部分分别由 #6 和 #1 修**，
`#7` 只贡献了钳制。这种「一条任务横穿多条 finding」的编号方式，使得
「#7 修完了」无法回答「哪几条 finding 闭合了」——**映射是多对多的，而任务书用的是 1..7 的一维编号**。
这正是后面无法对账的直接原因。

**(b) `#8` 是 38 条之外的新发现，必须标出来。**
全表、全部 7 份产物里都**没有** `loadFromFile()` 返回值相关的独立 finding。
`#8` 是修复过程中从 `R3-A A-04` 的一条子主张里长出来的（见 §3.3）。
`task-repair-8.md:20` 写的是「这条我现在正式派给你，编号 #8」，
`ACCEPTANCE-ROUND2.md:106` 的标题是「验收中发现的新缺陷 #8」——
它**从未被登记进 38 条的清单**，所以「38 条」这个分母在第二轮之后其实已经不准了。
准确的表述是：**39 个已知缺陷（38 审计 + 1 修复期新发现），修了 6 条原始 + 1 条新增 = 7 条代码变更。**

---

## 3. A-04 为什么在任务书里被拆成了两半

这是本报告的核心。A-04 是唯一一条在「审计→任务书」过程中被**分解**的 finding，
也因此是唯一一条信息可以逐字对比两边的地方。

### 3.1 A-04 的 claim 提到了几件事？——三件

原文（`out/round3-A-audit.md`）：

- **标题（:216）**：「重载丢弃未保存修改，已打开的子菜单继续写入被替换的旧 GameConfig」——**两件**
- **正文（:64）**：「既不检查是否存在未保存修改，**也不消费载入结果**」＋「子菜单在 `buildMenu()` 时把
  `GameConfig cfg = configManager.getActiveConfig()` 捕获进闭包」——**三件**
- **JSON `inference.basis`（:226）**：「核对 MainConfigMenu 146–156（**无 hasUnsavedChanges 检查、无返回值判断**）、
  ItemSettingsMenu 40 与 82–84（闭包捕获 cfg）」——**三件，且有「无返回值判断」这五个字**

拆开编号：

| 子主张 | 内容 | 出处 |
|---|---|---|
| **A-04-a** | 重载不检查 `hasUnsavedChanges()`，未保存修改被静默丢弃 | 标题 + 正文 + basis |
| **A-04-b** | 已打开的子菜单闭包缓存旧 `GameConfig`，重载后写入旧对象 | 标题 + 正文 + basis |
| **A-04-c** | **不消费 `loadFromFile()` 的返回值**（`loadFromFile()` 返回 `void`，失败时仍宣告成功） | 正文 + basis |

**关键事实：`A-04-c` 在产物里出现了两次（正文和 basis），不是只有 basis 里那一处。**
所以「信息只在 JSON 信封的 basis 里，正文没写」这个假设**不成立**——
它就在 prose 里，任何读 `round3-A-audit.md` 的人都看得到。

### 3.2 `task-repair.md` 的 #3 覆盖了哪几件？——只覆盖 1 件，丢了 2 件

`task-repair.md:30-39` 的 #3 全文只有两句事实：

> `MainConfigMenu.java:149` 无条件 `loadFromFile()` 后无条件发「已重载」。
> `ConfigManager:307` 有 `hasUnsavedChanges()` 但没被调用。

- **A-04-a：覆盖了。**「没被调用」= 未保存修改会丢。
- **A-04-c：丢了。** 任务书只写「无条件 loadFromFile() **后**无条件发已重载」——
  这句话讨论的是**顺序**（先 load 后发消息），而不是**返回值**（load 失败时该不该发）。
  「无条件」修饰的是「发消息」，不是「检查结果」。整份 `task-repair.md` 里
  `grep 返回值` = **0 次**（我数过）。
- **A-04-b：丢了。** 任务书完全没提闭包捕获。

也就是说：**A-04 从「3 个子主张」压缩成「1 个子主张」，压缩比 3:1，且没有任何一处声明「另外两条不修」。**

### 3.3 丢掉的 A-04-c 后来怎么样了？——被一次偶然的副作用捞回来了

`A-04-c` 的回归路径**不是任何流程保证的**，是三步巧合：

1. `task-repair.md:37` 在 #3 里要求「**把你的判断和理由写进产物**」
   ——这条要求本来是给「该不该修 A-04-a」用的，与 c 无关。
2. dsh 在写 `done-3.md` 的「风险与未覆盖场景」时，**自己**想到了 c：
   `repair/done-3.md:82-85`：
   > 「相邻的真实问题（不在 #3 范围）：`loadFromFile()` 返回 `void`……应另开缺陷」
3. `ACCEPTANCE-ROUND1.md:106-121` 读到这段，核实为真，写成 `task-repair-8.md`。

**如果 dsh 没有写那一段「相邻问题」，`A-04-c` 会永久消失。**
而 dsh 会写那一段，是因为任务的「产物格式」里恰好有一节叫「风险和未覆盖场景」——
这是一个**软性**模板项，不是任何校验器检查的字段（`repair/` 下 6 份 `done-*.md` **都没有 JSON 信封**，
`grep '"schema_version"' repair/*.md` = 0 命中，所以它们从未被 `check-payload.mjs` 校验过）。

### 3.4 A-04-b 后来怎么样了？——被推翻，但推翻结论没写回产物

`RUNTIME-VERIFICATION.md:138-166` 实测推翻了 A-04-b：

> **原主张**：「重载后子菜单缓存的 `cfg` 仍指向旧对象」
> **前提不成立。** `GameRulesMenu.buildMenu():32` 每次都重新执行 `configManager.getActiveConfig()`，
> 而 `reopen()` 会调 `buildMenu()` —— **子菜单不缓存 cfg**。

我独立复核了这个推翻（读 HEAD 源码）：

- `AbstractConfigMenu.java:56-57`：`reopen() { buildMenu(); }` —— 每次重开都重建
- `GameRulesMenu.java:32`、`ItemSettingsMenu.java:40`、`WaveSettingsMenu.java:42 / :212 / :375 / :470`：
  **全部**在 `buildMenu()` 内重新 `getActiveConfig()`

**推翻是正确的。** 但：

- `out/round3-A-audit.md` 的 A-04 **标题和正文至今仍写着**「已打开的子菜单继续写入被替换的旧 GameConfig」；
- `SUMMARY.md:53` 仍写着「`MainConfigMenu.java:149` —— 契约违反」，没有标注误报；
- 推翻记录只存在于 `RUNTIME-VERIFICATION.md`，**不在任何面向下游的清单里**。

这是第二处信息丢失，但方向相反：**一条被证伪的子主张没有从审计产物里撤下，
而是继续以 HIGH 的身份存在于 38 条的计数里。**

精确地说：A-04 这一条 finding 内含 3 个子主张，其中 b 被推翻、a 与 c 成立。
按 finding 计，38 条里 A-04 仍算「部分成立」——**但没有任何一份文件这么标注过**，
`SUMMARY.md` 与 `out/round3-A-audit.md` 都仍按完整的 HIGH 呈现它。
这不算大事，却说明「38」这个分母从未被对账过，包括它自身是否准确。

---

## 4. 丢失点定位：是「审计→汇总」还是「汇总→任务书」？

**结论：主丢失点在「汇总→任务书」，且不是一次压缩，而是一次没有留痕的挑选。**

分三段看：

### 段 1：审计 → 汇总（`out/` → `SUMMARY.md`）——**次要丢失**

`SUMMARY.md` 确实丢了很多：它只保留了 **8 条 HIGH 的标题行**（:29-56），
7 条 R3 发现里只有 3 条有正文（`A-01`、`A-04`、`B-01`），其余 35 条连标题都没进汇总。
A-04 只剩一行「契约违反」，三个子主张全部消失。

**但这一段不是致命的**：`SUMMARY.md:25` 明确写了「产物：`out/round{1,2,3}-*-audit.md`」，
下游只要打开原件就能拿到全部 38 条。汇总是一份**索引**，不是**清单**，它没有假装自己是清单。

### 段 2：汇总 → 任务书（`SUMMARY.md` → `task-repair.md`）——**主丢失点**

这是真正的断点。`task-repair.md` 从 38 条里挑了 5 条（+ 前序 2 条 = 7 条编号），
**但全仓库没有任何一份文件记录「为什么是这 5 条、剩下 31 条怎么办」**。

证据：

1. `task-repair.md` 全文 `grep "finding_id"` = **0 次**，`grep "R2-AI\|A-0\|B-0\|F1"` = **0 次**。
   **任务书里没有任何一个原始 finding_id。** 它用的是「`ConfigManager.java` 里三处缺钳制」这样的代码定位。
2. `repair/REPAIR-LOG.md:78-84` 有一张「待修（按规划 agent 的风险排序）」表，列了 #7 #3 #1 #6 #4 五条，
   **但没有一列是原始 finding_id**，也没有一列写「不修」。
3. 31 条未触动项里，**没有一条**在任何文件里出现过「已知、暂缓、下轮处理」的字样。
   `SUMMARY.md` 的「局限」一节（:105-112）讲的是方法论局限，不是缺陷清单局限。
4. 编号本身是**凭空起的**。`MAIN-THREAD-VIOLATION.md:33` 说「剩余 5 条（#7 #3 #1 #6 #4）」，
   但 #1..#7 这七个编号在任何产物里都没有定义表——#2 和 #5 是前序修的，
   说明编号是在**多轮之间连续追加**的，却始终没有一份 canonical 的 1..N → finding_id 对照。

**判定：这是一个「选择题没写答案」的丢失。** 不是汇总时手滑漏抄，而是从「38 条清单」
到「7 条任务书」之间，**缺少一个必须产出、且必须逐条表态的中间环节**。
挑选本身可能是合理的（先修 HIGH、先修有回归网的），但**没有任何地方写下来过**，
所以事后无法区分「有意暂缓」和「单纯忘了」。

### 段 3：任务书 → 修复产物（`task-repair.md` → `repair/`）——**制度性丢失**

即使只有 7 条，修复产物也没有闭合回原 finding：

- `repair/done-*.md` 6 份**全部没有 JSON 信封**（`grep '"schema_version"'` 无命中），
  所以 `check-payload.mjs` 从未跑过它们。而审计产物是跑过的（`SUMMARY.md:17`「7/7 契约合规」）。
- 契约本身**对 fix 角色只要求 `files_touched`**（`tools/check-payload.mjs:283`：
  `fix: ['files_touched']`）——`finding_id` 与 `affected_issues` 虽在
  `framework/components/output-contract/fix.md:142/149` 定义了，但**校验器不查**。
- 于是「这个修复关掉了哪条 finding」完全靠自然语言自述。

### 一句话定位

> **丢失发生在「38 → 7」这一步，即汇总与任务书之间。它不是抄写错误，而是缺少一份
> 「38 条逐条去向表」的强制产物；`SUMMARY.md` 只管计数、`task-repair.md` 只管派活，
> 两者之间没有任何东西要求「每一条都必须被表态一次」。**

A-04 是被观察到的**唯一**能被逐字对比的样本（因为它是唯一被拆开的），
它的 3→1 压缩不是特例，而是这条链路上**所有**条目的默认处理方式——只不过其余 30 条压缩到了 0。

---

## 5. 框架有没有工具能保证覆盖率？

**没有直接能保证「38 → 修复」闭环的工具。** 但框架里**存在一个结构完全对应的机制，
只是挂在了错误的角色上**。逐个核过 `tools/` 下 51 个 `.mjs`（30 个非测试脚本）：

### 5.1 能拦、但没被调用的

| 工具 | 它本可以拦住什么 | 为什么这次没拦住 |
|---|---|---|
| **`check-payload.mjs` · `verdict_missing_for_target`**（:654-668） | **这就是缺失的那个机制。** 它强制 critique 的 `verdicts` 覆盖**全部** `target_finding_ids`，报错文案：<br>「以下 target_finding_ids 没有任何 verdict（…）。**漏审一条等于放它直接进入修复波**」 | 它只对 **critique** 角色生效。**fix 角色没有等价检查**（`ROLE_REQUIRED.fix = ['files_touched']`）。<br>换句话说：框架要求「每条 finding 都必须被锐评攻击一次」，<br>**但不要求「每条 finding 都必须被修复或明确暂缓一次」**。 |
| `check-payload.mjs` · `missing_finding_id`（:505-508） | 审计发现缺 `finding_id` 时报错，文案是「下游锐评/**修复**/verify **都靠它挂接**」 | 文案自己承认 `finding_id` 是修复的挂接键，但**没有任何工具去验证这个挂接真的发生过**。本次 38 条都有 `finding_id`，仍全部挂接失败。 |
| `check-state.mjs` · `fix_contracts`（:203-228） | 强制每条修复前置登记 `finding_id / defect_statement / test_path / rollback_command / baseline_result`，缺任一即 `CONTRACT_VIOLATION` | **没有 `state.json`。** 整个 experiment 目录下 `find . -name state.json` = 0。所以这条检查一片 SKIP。 |
| `gate.mjs` · `close` 门（:52-58） | 声明 CLOSED 前强制跑 `check-state` + `check-deliverables` | **从未被调用**，因为整个实验没有走框架的 round 协议——它是手工派发 dsh 的，没有 state.json、没有 final-report。 |
| `check-deliverables.mjs` · §2 覆盖率（:166-211） | 强制最终报告写「派发覆盖率 N/N」与「证据覆盖率 Q/F」，并把「只报派发覆盖率」明确斥为**自欺** | 同上：**没有最终报告**（`find . -name "*final-report*"` = 0）。而且即便有，它测的是「切片派了多少 / quote 查了多少」，**不测「发现修了多少」**。<br>**框架有「派发覆盖率」和「证据覆盖率」，唯独没有「闭合率」。** |

### 5.2 明明存在、但结构性不适用的

| 工具 | 判定逻辑（读过源码） | 为什么对本次无效 |
|---|---|---|
| `check-blindspots.mjs` | 4 条规则：B1 返回内部容器活引用；B2 同类方法守卫不一致；B3 用 `typeof==='number'` + 范围比较但没 `Number.isFinite`；B4 调用了本文件未声明的名字。**`walk()` 只收 `.js/.mjs/.cjs/.ts`（:40）** | 目标仓是 **Java**。`extname` 白名单直接把 153 个 `.java` 全部跳过 → **0 文件扫描，什么都不报**。 |
| `check-promises.mjs` | 3 条规则：P1 JSDoc 声称 `@returns {T}` 但函数体无 `return`；P2 声称 `@throws` 但从不 `throw`；P3 声称只读却返回未 freeze 的可变对象。**同样只收 `.js/.mjs/.cjs/.ts`（:38）** | 同上，Java 目标下完全空转。<br>**讽刺的是 P1 正是 A-04-c/`#8` 的形态**：`loadFromFile()` 声称成功却无任何失败信号——<br>这是「承诺未兑现」，本来是 `check-promises` 的靶心，只因语言不匹配而漏掉。 |
| `check-pattern-coverage.mjs` | 校验每条 ground-truth 缺陷是否有模式归属（1..8 或 `none`+理由），防止「结构性查不到」 | 它读的是**框架自己的 fixture manifest**（`framework/templates/wave2-audit.md`），不针对外部 Java 仓库。 |
| `check-all.mjs` | 顺序跑 **28 个检查器**，是「一条命令跑完全部机械检查」的入口 | 28 项里**没有一项**是「审计发现 → 修复任务」的覆盖率对账。它是「框架自检」，不是「交付闭合检查」。 |

### 5.3 结论

> **框架在设计上已经知道这类丢失怎么防——`verdict_missing_for_target` 就是范例。
> 但它把这道防线只架在「锐评」这一站，没架在「修复」这一站。
> 于是「每条 finding 都必须被攻击一次」是硬约束，「每条 finding 都必须被处置一次」是软约定。**

`check-all.mjs` 的注释（:5-7）自己写过一句极贴切的话：

> 「框架有 4 个检查器，分散调用必然会漏跑一个。而『漏跑一个』在这套框架里已经造成过真实损失。」

这次的损失不是「漏跑一个检查器」，而是**「从来没有这个检查器」**。

---

## 6. 建议的防丢失机制（按性价比排序）

### M1 · 把 `verdict_missing_for_target` 复制给 fix 角色（最小改动，最高收益）

在 `check-payload.mjs` 的 fix 分支加一条，与 critique 那条同构：

```
fix 的 payload 必须有 disposition ∈ {FIXED, WONT_FIX, DEFERRED, NEW_FINDING}
且 finding_id 必须能在本轮审计产物的 findings[] 里查到
```
- `FIXED`：必须有 `test_path` 且红测日志存在
- `WONT_FIX`：必须有 `reason`（≥20 字）
- `DEFERRED`：必须有 `next_round` 或 `trigger`
- `NEW_FINDING`：允许 `finding_id` 不在 38 条内，但必须显式标记为新增（`#8` 就该走这条）

**效果**：A-04-c 会在 `#3` 的产物里被强制表态，要么修要么写理由，不可能静默蒸发。
**成本**：改 1 个校验器 + 6 份 `done-*.md` 补信封。

### M2 · 强制产出「发现去向表」（`disposition-ledger.md`），并做机械对账

在 `final-report.md` 的 §3「发现汇总」下加硬要求：一张表，**行数必须等于 findings 总数**。
新增检查器 `check-disposition-coverage.mjs`：

```
输入：out/*-audit.md（解析 findings[]）+ disposition-ledger.md
断言：│ledger 行数│ == │Σ findings│
断言：ledger 的 finding_id 集合 == findings 的 finding_id 集合（双向，无遗漏无杜撰）
断言：每行 disposition 非空，且 FIXED 行有 test_path、WONT_FIX 行有 reason
退出码：1 = 有 finding 没有任何 disposition
```

**效果**：31 条未触动会在收口时一次性暴露为 31 个 FAIL，而不是安静地活在 `out/` 里。
**为什么必要**：这是唯一能防「分母漂移」的机制——`#8` 事件证明了分母会变（38→39），
只有强制对账才能发现「表里多了一条 / 少了一条」。

### M3 · 任务书禁止使用一维编号，必须携带 finding_id

`task-repair.md` 里 `#7` 这种编号的根问题是**它无法被反查**。改成：

```
### #7 · [R1-core F2 + R2-AI-001(部分) + R2-mech F2(部分)] 载入侧数值钳制
```
并规定：**一条任务书条目若映射到 >1 个 finding，必须逐条列出被覆盖的子主张**。
`#7` 横切 3 条、`#3` 只覆盖 A-04 的 1/3 个子主张——这两种情况都必须显式写出来。

### M4 · 子主张必须可寻址（A-04 的可拆性证明）

A-04 之所以能被发现丢失，是因为我们能把它拆成 a/b/c。但这是**靠人肉读出来的**。
建议在 audit 契约里允许（并对 `severity: HIGH` 强制）`sub_claims: [{id, statement, status}]`，
finding_id 变成 `A-04/a`、`A-04/b`、`A-04/c` 这样可单独寻址、
可单独被 `verdicts` 和 `disposition` 引用。

**效果**：
- 任务书漏掉 `A-04/c` 会变成「`A-04/a` 有 disposition、`A-04/c` 没有」→ M2 的检查器直接 FAIL。
- `A-04/b` 被推翻时，`status: REFUTED` 会**原地更新**，而不是像现在这样
  推翻记录留在 `RUNTIME-VERIFICATION.md`、标题继续以 HIGH 存在、分母虚高。

### M5 · `check-blindspots` / `check-promises` 加 Java 支持（针对性扩充，不是重写）

这两个检查器的 4+3 条规则**与语言无关**，只是 `walk()` 的白名单把 `.java` 排除了。
- `check-promises` P1（JSDoc 声称返回却没 return）→ 换成 Java 的 Javadoc `@return` 即可，
  **它本来就能抓到 `loadFromFile()` 这类「返回 void 但调用方以为有结果」的形态**。
- `check-blindspots` B3（`typeof number` + 范围比较但无 `isFinite`）→ 直接对应
  `A-01`（`health` 无有限性校验）、`A-02`（`total-mobs` 无上限）、`R2-AI-001`（爆炸倍率 NaN）。
  **规则早已存在，只是不认 Java。**

这是本次最扎心的发现：**框架为「承诺未兑现」和「数值未钳制」各写了一个检查器，
然后因为扩展名白名单，让它们在唯一的 Java 实战里 100% 空转。**

### M6 · 收口门加「未闭合项必须进 open_items」

`check-deliverables.mjs` §4「失败与未闭合」目前只要求**有这一节**，
不校验其内容是否覆盖真实未闭合项（`final-report.md:139` 自己写着
「不允许空数组掩盖实际存在的未闭合项」——但校验器不查）。
接上 M2 的 ledger 后，`open_items` 应被断言为 `Σ disposition ∈ {DEFERRED, WONT_FIX}` 的超集。

---

## 7. 一句话总结

> **38 条缺陷，修了 6 条（15.8%），另有 1 条新增（#8）——共 7 次代码变更。
> 丢失不在「抄漏」，在「从 38 条挑 7 条时没有任何东西要求逐条表态」。
> 框架里唯一能拦住它的机制（`verdict_missing_for_target`）已经写好、已经跑通、
> 文案甚至写着「漏审一条等于放它直接进入修复波」——只是它守着锐评门，没守修复门。
> 而两个本该抓到 A-04-c 和 A-01/A-02 的检查器，因为只认 `.js/.mjs/.ts`，在唯一的 Java 实战里全程空转。**

**最该先做的两件事**：M1（把 crit 的覆盖检查复制给 fix，改一个校验器）和 M2（强制去向表，行数 == 发现数）。
两者都不改变任何审计方法，只改变「谁来证明 38 条都被数过」。
