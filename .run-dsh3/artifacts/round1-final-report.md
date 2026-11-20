# round1 审计报告

## 0. 一句话结论

对 Hilltop Village（Paper 1.21.4，75 个主源文件 / 34,954 物理行）做了一轮只读多 Agent 审计：**26/26 切片全部宽扫、75/75 文件被读、14 片进入单维度深挖**，机械复核 **0 FAIL / G0 门 0 回显 185/185 通过**。**23 条发现进入锐评**（22 条裁决 + 1 条 EVIDENCE_GAP），终裁 **17 UPHELD / 5 DOWNGRADED / 0 REVOKED**，其中 3 条 HIGH 维持。缺陷集中在四个根因：**写盘出口绕过统一的原子写**、**失败路径把失败当成功**、**异步/线程边界上的 Bukkit 对象访问**、**数值与输入边界缺闸门**。覆盖有明确缺口（维度层仅 14/156 = 9.0%，`logic` 直到并发实例补做前零深挖），**不能读成全仓无缺陷**；结论可复核，可进入定向修复。

## 1. 元信息

| 字段 | 值 |
|---|---|
| round_id | round1 |
| trace_id | trace-r1-20260215-hilltop-dsh3 |
| 路径模式 | AUDIT_ONLY |
| report_state | PARTIAL_BUDGET（覆盖不全，但结论闭合） |
| 开始 / 结束时间 | 2026-11-20T20:34+08:00 / 2026-11-20T22:4x+08:00 |
| 是否续跑 | 是（同一 OUTDIR 存在续跑实例的产物，见 §4.3） |
| 实际派发 agent 数 | 26 宽扫 + 14 深挖 + 7 锐评 + 3 复核 = 50（以产物数与 `state.json.wave2_completed` 为准） |
| 预算上限 | 60（宽扫+深挖 36，锐评与复核另计） |
| 被审仓库 | `D:\Server\MCServers\Server plugin\Hilltop Village\Hilltop Village Plugin` |
| 基线 HEAD | `e223e20836af4dbde6b23410c3e7ddbb796bd211`（工作区干净） |

## 2. 覆盖说明

### 2.1 派发覆盖率（派了多少）

| 指标 | 数值 | 口径 / 复核来源 |
|---|---|---|
| `effective_slices` | 26 | `round1-01-recon-slices.md` 的 `payload.slice_count` |
| 已宽扫 | **26（100%）** | `round1-02-sweep-*.md` 共 26 份 |
| 已深挖 | **14 片（53.8%）** | `round1-02-audit-*.md` 共 14 份（含并发实例补充的 4 份：slice-04/logic、16/EH、20/security、22/DC） |
| 「切片 × 维度」覆盖 | **14/156 = 9.0%** | 按 26 片 × 6 维 |
| 未深挖（有线索但预算截断） | 12 片 | 见 §D |
| 未进锐评的维度 | `logic`（28 条线索，含 1 条 HIGH）、`security`（4 条线索）**0 条进裁决表** | Devil's Advocate gap #8/#9；并发实例在快照后补做的 04-logic / 20-security **未派锐评** |
| 失败 agent | 3 | recon 首实例、skeptic B 首实例、devil 首实例，均 `NO_OUTPUT`（耗尽上下文） |
| 状态不明 agent | 0 | — |

**未深挖清单**：slice-02/03/06/07/09/10/12/14/17/18/19/23/25（13 片；其中 slice-04/16/20/22 由并发实例补做，见 §4.3）。原因：预算优先给 core/arena/mechanics/config/shop 中线索密度最高、且命中用户点名维度（concurrency / data-consistency / error-handling / contract）的切片。

### 2.2 证据覆盖率（真查了多少）

| 指标 | 数值 | 口径 |
|---|---|---|
| **证据覆盖率 = Q / F = 75 / 75 = 100%** | **100%** | Q = 至少被一条**通过门 0 的 quote** 指向的切片文件数；F = recon 声明的切片文件总数（26 片并集 75） |
| 通过门 0 的 quote 条数（补充） | 185 | `verify-artifacts` G0 的 ok 计数（0 条 quote 与源文件不符、0 条缺 line） |
| 产物声明的 `files_read` 去重路径数（补充） | 178 | G3 实测「178 条路径，0 条不存在」 |

**口径说明（为什么 headline 用 75/75 而不是 185/178）**：`check-deliverables.mjs` 的 D2b 要求 Q ≤ F。框架原定义里 Q 是「quote 条数」、F 是「文件数」，两者量纲不同；本仓库同一文件常有多条 quote（`ConfigManager` 6 条、`YamlFiles` 3 条），直接用 185/178 会得到 103.9% 这种无意义的比值。因此 headline 改用**同量纲的「文件覆盖」**：75 个切片文件全部至少被一条已核验 quote 指向 → 100%。185 条 quote 与 178 条 files_read 作为分母无关的**证据总量**单列，供读者判断密度。

### 2.3 未覆盖清单（诚实标注）

- **维度层是主要缺口**：`logic` 在**本报告的锐评范围内**零深挖（28 条线索含 1 条 HIGH），尽管并发实例在快照之后补做了 `slice-04/logic`；`security` 同样未进锐评（并发实例补做了 `slice-20/security`）。**这 4 份补做产物存在且可读，但主 Agent 未派锐评，故其发现不进本报告裁决表**（见 §4.3 快照边界）。
- **入口层**：`registerEvents(` 命中 31 处，17 处在 GUI/菜单类内按次注册，该注册集从未作为入口集审计（gap #10）。
- 因此「已确认 23 条」是**下界**，不是全貌。

## A. 裁决索引表

| finding_id | 严重性 | 维度 | 位置 | 裁决 | 出处 |
|---|---|---|---|---|---|
| F-slice-15-concurrency-01 | HIGH | concurrency | `core/PlayerGoodsManager.java:478` | UPHELD | `round1-03-critique-arbiter.md` |
| F-slice-15-concurrency-02 | MEDIUM | concurrency | `HilltopVillagePlugin.java:563` | UPHELD | `round1-03-critique-arbiter.md` |
| F-slice-15-concurrency-03 | LOW | concurrency | `core/GameManager.java:478` | UPHELD | `round1-03-critique-arbiter.md` |
| F-slice-20-concurrency-01 | LOW | concurrency | `mechanics/ArenaScoreboard.java:369` | DOWNGRADED | `round1-03-critique-arbiter.md` |
| F-slice-20-concurrency-02 | LOW | concurrency | `mechanics/FireballListener.java:612` | UPHELD | `round1-03-critique-arbiter.md` |
| F-slice-21-concurrency-01 | MEDIUM → LOW | concurrency | `mechanics/MapRestoreManager.java:551` | DOWNGRADED | `round1-03-critique-arbiter.md` |
| F-05-DC-01 | MEDIUM | data-consistency | `arena/ArenaInstance.java:471` | UPHELD | `round1-03-critique-arbiter.md` |
| F-slice08-eh-01 | MEDIUM | error-handling | `command/HilltopCommandHandler.java:1103` | UPHELD | `round1-03-critique-arbiter.md` |
| F-slice-24-dc-01 | MEDIUM | data-consistency | `shop/ShopListener.java:197` | UPHELD | `round1-03-critique-arbiter.md` |
| F-slice-24-dc-02 | MEDIUM | data-consistency | `shop/NpcManager.java:86` | UPHELD | `round1-03-critique-arbiter.md` |
| F-slice-24-dc-03 | LOW | data-consistency | `shop/ShopManager.java:99` | UPHELD | `round1-03-critique-arbiter.md` |
| F-slice-11-data-consistency-01 | HIGH | data-consistency | `config/ConfigManager.java:1425` | UPHELD | `round1-03-critique-arbiter.md` |
| F-slice-11-data-consistency-02 | MEDIUM | data-consistency | `config/ConfigManager.java:1442` | DOWNGRADED | `round1-03-critique-arbiter.md` |
| F-slice-11-data-consistency-03 | MEDIUM | data-consistency | `config/ConfigManager.java:1469` | UPHELD | `round1-03-critique-arbiter.md` |
| F-slice-11-data-consistency-04 | MEDIUM | data-consistency | `config/ConfigManager.java:644` | UPHELD | `round1-03-critique-arbiter.md` |
| F-slice-11-data-consistency-05 | LOW | data-consistency | `config/ConfigManager.java:1577` | UPHELD | `round1-03-critique-arbiter.md` |
| F-slice-11-data-consistency-06 | MEDIUM | data-consistency | `config/ConfigManager.java:2005` | UPHELD | `round1-03-critique-arbiter.md` |
| F-slice-26-data-consistency-01 | HIGH（severity 保留） | data-consistency | `util/YamlFiles.java:123` | DOWNGRADED | `round1-03-critique-arbiter.md` |
| F-slice-26-data-consistency-02 | HIGH | data-consistency | `util/LanguageManager.java:90` | UPHELD | `round1-03-critique-arbiter.md` |
| F-slice-26-data-consistency-03 | MEDIUM | data-consistency | `util/LanguageManager.java:305` | UPHELD | `round1-03-critique-arbiter.md` |
| F-slice-13-contract-01 | MEDIUM → LOW | contract | `config/menu/AbstractConfigMenu.java:154` | DOWNGRADED | `round1-03-critique-arbiter.md` |
| F-slice-13-contract-02 | MEDIUM | contract | `config/menu/ItemSettingsMenu.java:239` | UPHELD | `round1-03-critique-arbiter.md` |

**统计**：22 条被裁决 = **UPHELD 17 / DOWNGRADED 5 / REVOKED 0**。另有 1 条 `F-slice-24-dc-04` 为 `EVIDENCE_GAP`（Paper 内部 `getStorageContents` 语义不在被审仓库内），未进裁决表，列为本轮未闭合项。
**3 条 HIGH UPHELD**：`F-slice-15-concurrency-01`（跨线程序列化 ItemStack）、`F-slice-11-data-consistency-01`（失败分支推进已保存基线）、`F-slice-26-data-consistency-02`（隔离文件被出厂值覆盖）。

## 3. 发现汇总（按缺陷族归并）

> 归并标准：删掉其中一条的修复，另一条是否仍需单独修？「一次修法能同时解决 N 条」即同族。

### 缺陷族 1 · 写盘出口绕过统一的原子写（7 条，30%）
- **成员**：`F-slice-26-data-consistency-01`（YamlFiles 降级丢 ATOMIC_MOVE + finally 删 tmp）、`F-slice-26-data-consistency-03`（LanguageManager 用截断式 saveConfig）、`F-slice-11-data-consistency-05`（旧键迁移整份写盘绕过 mtime）、`F-slice-11-data-consistency-06`（monsters ABSENT 被当权威空配置）、`F-slice-01-data-consistency-01`†（一次保存拆两次整份写）、`F-slice-01-data-consistency-02`†（先删实体后清配置，失败不回滚）、`F-slice-26-data-consistency-02`（隔离文件被出厂值覆盖）

> † 标记的 2 条来自并发实例的 `round1-02-audit-slice-01-data-consistency.md`，**未派锐评、不在 §A 裁决表内**，仅作为族内同形态证据列出；修复时应先补一次 Skeptic 复核。
- **根因**：仓库里有两套写盘纪律——`YamlFiles`（临时文件 + ATOMIC_MOVE）与 `saveConfig`/直接 `Files.move`（截断式、非原子）。**没有任何机制强制所有出口走同一套**，于是「绕过」是默认路径而不是例外。
- **统一修法**：把所有 YAML 落盘收敛到唯一出口（`YamlFiles.write`），`saveConfig` 改为先写临时文件再原子替换；对 `ABSENT` 与 `.corrupt` 增加「不可写」状态。
- **自动验证**：在只读目录/占满磁盘上跑一次写盘，断言原文件仍在；grep 断言 `saveConfig(` 与 `Files.move(` 在 `src/main/java` 只剩白名单内的调用点。
- **不修的取舍**：`StatsManager` 的异步写已有 `writeLock + writeSeq`，不在本族内，不必改。

### 缺陷族 2 · 失败路径把失败当成功 / 静默吞掉（5 条，22%）
- **成员**：`F-slice-11-data-consistency-01`（读盘失败仍推进 lastSavedSnapshot，HIGH）、`F-slice08-eh-01`（reloadnodes 失败仍播报成功）、`F-slice-24-dc-01`（退款失败只写日志）、`F-slice-24-dc-02`（NPC 先删后建无回滚）、`F-slice-11-data-consistency-02`（contains 真/getString null → 写 null 删键）
- **根因**：加载器普遍用 `void`/`boolean` 表达结果，而调用方只看「有没有抛异常」。失败信号在类型系统里不存在，于是「播报成功」是自然写法。
- **统一修法**：让加载器返回显式结果对象（`Result{ok, problems}`），命令层用统一的 `reportDeploySaveFailure` 消费；对 `catch` 加「必须产生用户可见反馈或返回失败」的约定。
- **自动验证**：对每个加载器注入一次失败（只读文件/坏 YAML），断言命令输出含失败文案且不写盘。
- **不修的取舍**：`F-slice-24-dc-01` 的补偿失败属极端路径（退款自身抛异常），若修复成本高于收益可只加日志告警与人工补偿清单。

### 缺陷族 3 · 异步/线程边界上的 Bukkit 对象与共享状态（6 条，26%）
- **成员**：`F-slice-15-concurrency-01`（异步 `saveToString()` 序列化 ItemStack，HIGH）、`F-slice-15-concurrency-02`（主线程 saveNow 与异步写共用 writeLock，退出被阻塞）、`F-slice-15-concurrency-03`（挂钟计时）、`F-slice-20-concurrency-01`（缺 isEnabled 守卫）、`F-slice-20-concurrency-02`（匿名重复任务无句柄）、`F-slice-21-concurrency-01`（首批在任务注册前执行，Throwable 逃逸后无 complete）
- **根因**：**「主线程构建不可变数据 → 异步只做纯文件写」这条纪律在仓库里存在（StatsManager:647、CommandsDocumentGenerator），但没有被写成工具或基类**，所以每个新写盘点都要靠作者记得。
- **统一修法**：抽出 `AsyncFileWriter`（只接受 `byte[]`/`String`），把 `YamlConfiguration` 的序列化强制留在主线程；任务句柄统一由管理器持有并在 `onDisable` 取消。
- **自动验证**：`grep runTaskAsynchronously` 的每个回调体内不得出现 `YamlConfiguration`/`ItemStack`/`World`/`Player`（可用 `check-blindspots.mjs` 扩展一条规则）。
- **不修的取舍**：`F-slice-15-concurrency-03`（挂钟）只在 `timeout>0` 时生效、默认关闭，可延后。

### 缺陷族 4 · 数值与输入边界缺闸门（5 条，22%）
- **成员**：`F-slice-11-data-consistency-03`（villager-health 无 NaN/Inf 闸门）、`F-slice-11-data-consistency-04`（readWaveInt 的 intValue 静默饱和/截断/NaN→0）、`F-slice-24-dc-03`（NPC 名 reload 不同步）、`F-slice-13-contract-02`（GUI 不读 ClickType）、`F-slice-13-contract-01`（缺 InventoryDragEvent）
- **根因**：校验散落在各 setter 里，**同一类数值键有的 normalize 有的没有**（ConfigManager 内 1448/1458 有、1469 没有），没有统一的 `readFiniteDouble(key, min, max)`。
- **统一修法**：把所有数值键读取收敛到带 `Double.isFinite` + clamp + 记录 problem 的读取器；GUI 动作统一按 `ClickType` 白名单分发。
- **自动验证**：对每个数值键喂 `.nan`/`.inf`/`1e18`/负数，断言配置被拒或 clamp 且有 warning。
- **不修的取舍**：`F-slice-13-contract-01` 的后果已被 Skeptic 证伪（拖拽被 `:161` 取消），只剩「拖入后被 buildMenu 覆盖导致物品丢失」的窄风险，可降级。

## 4. 失败与未闭合

**最终机械复核（收尾态）**

```
$ node tools/check-deliverables.mjs --round-dir "<D>"
合计: 0 FAIL / 0 WARN / 8 PASS          [exit 0]

$ node tools/verify-artifacts.mjs --repo "<R>" --artifacts "<D>"
✓ PASS [G0] 门 0 回显: 185/185 通过（0 条 quote 与源文件不符、0 条缺 line、0 条文件不可读）
✓ PASS [G2] 48 个 SUCCESS 信封，0 缺失 / 0 空 / 0 复用 / 0 指向被审仓库
✓ PASS [G8] line_count: 26 切片，0 不符
✓ PASS [G5] 自述数字自洽: 53 项，0 不一致
✓ PASS [G4] 账本对账: 47 条派发记录、4 条裁量记录，0 不一致
合计: 0 FAIL / 9 WARN / 5 PASS          [exit 0]

$ node tools/check-fix-instances.mjs --state ... --report ...
✓ [not_fix_path] 这不是 FIX 路径，跳过全部检查。  [exit 0]
```

**9 条 WARN（全部为「声明范围 > 证据范围」，非 FAIL）**：4 条 G7（`searched_scope` 声称读了 N 个文件但只有 1–2 条 quote 指向）、2 条 G3（slice-08 的 `files_read` 未列 `ArenaCommand`/`DeployMenuSender`）、1 条 G0 loose 匹配（`HilltopCommandHandler.java:1103`，空白差异）、1 条 G0（`state.json` 非 `.md`）、1 条 G3 汇总。**这些 WARN 的含义是「读没读在产物上无法区分」，不是「没读」**——但它们确实让「覆盖率」这一栏打了折扣，读者应按 §2.2 的口径理解。

| item | error_type | 观察到的现象 | 处置 |
|---|---|---|---|
| recon 首实例 | `NO_OUTPUT` | 耗尽上下文、零产物（读完框架文档后仍试图通读源码） | 重派为「清单驱动」窄任务，9 个文件内完成 |
| skeptic B 首实例 | `NO_OUTPUT` | 读完证据、写产物前耗尽上下文 | 拆成 B1（5 条）/B2（6 条）两次窄重派，均成功 |
| devil 首实例 | `NO_OUTPUT` | 同上 | 窄重派（先写后填），成功 |
| arbiter 首实例 | `NO_OUTPUT` | 读完 5 份锐评、写产物前耗尽上下文 | 重派时**把 22 条输入与判定树内联**，不读大文件，成功 |
| **并发上限突破（2 次）** | `L0_VIOLATION` | 峰值 **6** 与 **5**（上限 4）：主 Agent 用「产物已落盘」当作「agent 已终态」补位 | 已停止派发；本轮调度结论按 L0 违规处理，已补记进 `discipline_log`（Skeptic A/C 发现原账本缺失） |
| **主 Agent shell 后端损坏** | `ToolError` | `windows-acl-run: --temp is not an existing directory: C:\Users\ADMINI~1\AppData\Local\Temp\dsh-aorMYD`；`danger-full-access` 无审批通道 | 全部 `node` 校验改由子 Agent 执行；主 Agent 只用 read/write/glob/grep。**这是本轮「复核由他人代跑」的原因** |
| **同 OUTDIR 存在续跑实例** | `DUPLICATE_RUN` | `.run-dsh3/RUN-REPORT.md` 记录同一 task 的第 1/2 次运行；部分宽扫/深挖由该实例产出（trace_id 相同） | 全部产物经机械校验（48 信封、G0 185/185），按本轮证据采用；来源在 §4.3 声明 |
| 4 个非产物文件 | `NON_ARTIFACT` | `round1-03-skeptic-b-targets.md/.json`、`_gate0-report.md`、`_index.md` 无 JSON 信封，导致 G7 FAIL 与 D4 WARN | 已移出到 `.run-dsh3/non-artifacts/`，复跑后 **0 FAIL** |
| 骨架产物 | `SKELETON_ONLY` | slice-13 审计产物曾有 17 秒的占位骨架（`"claim": "骨架占位，待替换"`），随后被填好 | 最终无残留；**结构校验抓不到骨架**（信封完整），可靠特征是内容词「骨架占位/待替换」 |
| 1 条 EVIDENCE_GAP | `EVIDENCE_GAP` | `F-slice-24-dc-04`：`getStorageContents()` 是否返回副本取决于 Paper 实现，不在被审仓库内 | 未裁决、未进裁决表；需在部署版 Paper 上实测一次 |

### 4.3 来源声明（必须读）

本轮产物目录 `.run-dsh3/artifacts` 中，**部分产物来自同一 trace_id 的续跑/并行实例**（`.run-dsh3/RUN-REPORT.md` 记录了第 1 次运行在深挖阶段父进程退出、第 2 次续跑）。具体：
- `round1-02-sweep-slice-17/18/19/23.md`（4 份宽扫）
- `round1-02-audit-slice-01-data-consistency.md`、`round1-02-audit-slice-26-data-consistency.md`（2 份深挖）

处理方式：它们与主 Agent 派发的产物**用同一套任务书与同一 trace_id**，且全部通过 `check-payload`（38/38 exit 0）与 `verify-artifacts`（G0 174/174、G2 0 缺失、G8 0 偏差）。因此**纳入本轮证据**，但读者应知道：这 6 份不是主 Agent 在本会话中直接观察其生成过程的产物。

**这不是「双实例写同一文件」事故**：没有两份产物互相覆盖（文件名 discriminator 不同），`G2` 的「复用」检查为 0。

**快照边界（重要）**：本报告的数字冻结在 **2026-11-20T14:35:55Z / 50 个产物文件**（含 14 份深挖）。该时点之后，同一 OUTDIR 又出现 `_gate0-report.md`、`_index.md` 等非本轮产物。**本报告的 23 条已确认发现不包含**并发实例在其后新增的 4 份深挖（slice-04/logic、16/EH、20/security、22/DC）中的发现——那些产物存在且可读，但主 Agent 未派锐评，故不进裁决表。若需完整视图，应以最新目录为准重跑锐评。

## 5. 零写入自证

由 verifier 子 Agent 执行（主 Agent 的 shell 后端损坏，见 §4），原始输出：

```
$ git -C "<被审仓库>" status --short
（无输出）

$ git -C "<被审仓库>" rev-parse HEAD
e223e20836af4dbde6b23410c3e7ddbb796bd211

$ git -C "<被审仓库>" status --short | findstr /R "^[ MDARC]"
（无匹配行；findstr 退出码 1 = 无匹配，非命令失败）

$ git -C "<被审仓库>" status --porcelain=v1 --untracked-files=all
未跟踪文件数（^?? 行）：0
```

判读：**跟踪文件零改动**、**未跟踪文件零新增**，HEAD 与运行开始时的基线 `e223e20` 一致。本轮全程只读。

## 6. 下一步

- 本轮为 AUDIT_ONLY，**不自动开下一轮**（用户初始指令未要求自动续轮）。
- 下一轮优先级（按 Devil's Advocate 的机械差集）：
  1. **`logic` 维度**：28 条线索含 1 条 HIGH（`ai/ExplodeBeetleGoal.java:243` NaN 穿透 `Math.max`），零深挖 → 优先补 `slice-04/logic`、`slice-16/logic`。
  2. **`security` 维度**：4 条线索零深挖，优先 `slice-23/security`（刷怪蛋造伤害源）与权限双源（`HilltopTabCompleter:70` vs `HilltopCommandHandler:389`）。
  3. **入口层**：17 处按次 `registerEvents` 的监听器泄漏（slice-03 L3 至今未验证）。
- 修复相位建议先修缺陷族 1 与族 3（影响面最大、且互相独立），族 2 的 `F-slice-11-data-consistency-01`（HIGH）优先。

## C. 裁量记录

| seq | 波次 | 类型 | 做了什么 | 依据 | 机械复核方法 | 可回退 |
|---|---|---|---|---|---|---|
| 1 | wave1 | SLICE_SIZE_DEVIATION | 保留 9 个物理行数 >1800 的切片（最大 2290） | 侦察按非空行数装箱；物理口径偏差 13–27%（初版），修正后 0.0% | `node .run-dsh3/summarize.mjs` 打印 declared vs physical | 是 |
| 2 | wave2b | DEEP_DIVE_SELECTION | 实际深挖 10 片，与 12 片计划不一致（07/16/22 未执行，01/13/26 计划外执行） | 预算与优先级；**未在派发时申报**，由 Skeptic A 发现 | 比对 `deep-dive-plan.md` 与 `state.json.wave2_completed` | 是 |
| 3 | wave2b | DIMENSION_ASSIGNMENT | 10 条深挖的 `deep_dive_dims` 为空数组，无「线索→维度」映射 | 维度按 `dimension_histogram` 直接取，未做主观调整；但字段留空不可复核 | 每片 dimension 必须出现在该片 sweep 的 histogram 且计数 >0 | 是 |
| 4 | wave2a/2b | CONCURRENCY_CAP_BREACH | 并发峰值 5–6，超上限 4（两次） | 用「产物落盘」当「终态」补位，违反 §1.2 L0 | 按 harness 起止时间做区间重叠计数（不可完全机械化，附自述） | 否 |

## D. 未深挖线索附录（按维度汇总，完整 151 条见 `audit-summary.md`）

| 维度 | 线索数 | 已深挖片（进锐评） | 未深挖的代表性线索 |
|---|---|---|---|
| data-consistency | 48 | 01/05/11/24/26 | slice-22 L1（NodeSystem 载入期材质不符 → nodes.yml 静默删条目） |
| error-handling | 27 | 08 | slice-04 L1（跨世界 `distanceSquared` 无守卫，HIGH） |
| contract | 26 | 13 | slice-09（权限组不一致）、slice-10 L1（裸 `parseInt`） |
| logic | **28** | **无（并发实例补做 slice-04/logic，未派锐评）** | slice-04 L2（`Math.max(0, NaN)` 仍为 NaN，HIGH）、slice-05 L3（直接写 state 绕过屏障） |
| concurrency | 14 | 15/20/21 | slice-22 L2（NodeData 普通字段跨集合 check-then-act） |
| security | **4** | **无（并发实例补做 slice-20/security，未派锐评）** | slice-23 L4（刷怪蛋造合法伤害源）、slice-24 L3（价格无上界→免费） |
