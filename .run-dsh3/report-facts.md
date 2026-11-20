# round1 最终报告 · 数据底稿

> 这份文件只记录**已核实的事实与口径**，供最终报告 §0–§6 引用。不是交付物。

## 元信息

- round_id: round1（OUTDIR `.run-dsh3/artifacts` 内无历史轮次，round-detection 判定 = 1）
- trace_id: `trace-r1-20260215-hilltop-dsh3`
- 路径模式: AUDIT_ONLY
- 被审仓库: `D:\Server\MCServers\Server plugin\Hilltop Village\Hilltop Village Plugin`
- 基线: git 工作区**干净**；HEAD = `e223e20836af4dbde6b23410c3e7ddbb796bd211`（运行开始前记录）
- 规模: `src/main/java` 75 个 .java，物理 34,954 行（recon 实测；非空行 34,193）

## 切片

- recon 产出 **26 个切片**，覆盖 75/75 文件，`slice_count == len(audit_slices) == 26`（check-payload 退出码 0）
- 切片行数口径修正：初版用非空行数（1778 等）→ 改为物理行数（verify-artifacts G8 口径），26/26 与实测一致
- **9 个切片物理行数 > 1800**（slice-01/05/08/10/11/15/20/21/22，最大 slice-01=2290；slice-10 为单文件 oversized=2287）→ L1 裁量已记录
- recon 的 `exclusion_dominant: true`：被排除 .java 150 个（src/test 101 + .work 49），但 src/main 75/75 全部入片

## 已完成的宽扫（22 片）

slice-01..16（16 片）+ 20/21/22/24/25/26（6 片）= 22 片。
**未宽扫**：slice-17（TpsDiagnostic 120 行）、slice-18（CommandsDocumentGenerator 598）、slice-19（ArenaSelectionGUI 339）、slice-23（VillagerSystem 356）→ 记 DEFERRED。

## 机械复核（由子 Agent 执行；主 Agent 的 shell 后端中途损坏）

- slice-08 的 agent 跑 `verify-artifacts`：**G0 门 0 回显 55/55 通过**，G1/G2/G8/G5/G4 全 PASS（当时目录内 10 份产物）
- slice-11 的 agent 跑 `verify-artifacts`：**G0 66/66 通过**，G1/G2/G5/G8 全 PASS
- slice-12 的 agent 跑 `verify-artifacts`：**G0 72/72 通过**；当时唯一 FAIL 是 slice-16 产物尚未写完（无信封）
- 结论：**已完成的宽扫 quote 全部逐字命中源文件行号**（三轮计数递增：55→66→72）

## 已知偏差与事故（必须进报告 §4）

1. **并发上限被突破**：主 Agent 用「产物已落盘」当作「agent 已到终态」补位，峰值 **6 个**并发（上限 4）。违反 `protocol.md` §1.2 L0（「槽位释放条件是进入终态，不是文件已落盘」）。已在中途停止派发并等待终态。→ 记 L0 违规，须在报告顶部声明。
2. **主 Agent 的 shell 后端损坏**：`windows-acl-run: --temp is not an existing directory: C:\Users\ADMINI~1\AppData\Local\Temp\dsh-aorMYD`。`pwsh` 全部失败；`danger-full-access` 升级无审批通道。→ 所有 `node` 校验改由子 Agent 执行；主 Agent 只做 read/write/glob/grep。
3. **recon 首次实例耗尽上下文、零产物**（NO_OUTPUT）；重派时改为「清单驱动 + 只读 9 个文件」后成功。
4. **骨架产物风险**：任务书要求「先写骨架再填」，导致 slice-20/21/22 中途出现 `status: IN_PROGRESS` / 「尚未开始」的骨架文件；若 agent 中途死亡会留下 SKELETON_ONLY。已在复核 brief 中加入检测项。

## 关键发现候选（来自宽扫，待深挖/锐评确认）

- **concurrency**
  - slice-15：`PlayerGoodsManager` 478→422 在异步线程序列化含 `ItemStack` 的 YAML（Bukkit 对象跨线程）
  - slice-21：`MapRestoreManager:564` 回滚 `runTaskTimer` 裸 lambda 无 try/catch → `activeRestores` 唯一移除点在 `complete()` → 世界永久 `isRestoring=true`
  - slice-20：`ArenaScoreboard:369` `runTaskTimer` 缺 `plugin.isEnabled()` 守卫；`FireballListener:622` 每次爆炸新建匿名重复任务、无句柄
  - slice-22：`NodeSystem` 索引用 CHM 但 `NodeData.currentHealth/active` 是普通字段，`damageNode` 跨集合 check-then-act（LOW，需异步调用方证实）
- **data-consistency**
  - slice-26：`YamlFiles:124` `ATOMIC_MOVE` 降级为 `REPLACE_EXISTING` + finally 删 tmp → 崩溃窗口原文件与临时副本可能同时丢失（HIGH）
  - slice-26：`LanguageManager:93` 只判 `isReadOnly` 不查 `.corrupt` → 隔离文件被新默认值覆盖（HIGH）
  - slice-11：`ConfigManager` loadFromFile 失败分支推进 `lastSavedSnapshot`，把未保存改动洗成已保存
  - slice-24：`ShopListener:198` 退款失败只打日志（扣款已生效）；`ShopManager:271` 主背包部分扣减未写回
  - slice-01：`AdminDeployManager` 一次保存拆两次整份写盘；迁移用陈旧副本覆写
  - slice-05：`ArenaInstance:1489` `resetNow` 与 `reset()` 对同一世界双发回滚
  - slice-22：`NodeSystem:180` 载入期材质不符的节点被静默从 nodes.yml 删除
- **error-handling**
  - slice-08：`HilltopCommandHandler:1582` `handleStatsCommand` 先 `target.getName()` 后判空（HIGH，`/hilltop stats` NPE）
  - slice-16：`WaveManager:167` 先置空 `spawnTask` 再跑 `onComplete`、cancel 在后
  - slice-20：`FireballListener:525` `UUID.fromString` 失败被空 catch 吞
  - slice-21：`MapRestoreManager:611` `TileState.update=false` 即整块失败并无限重排队
- **contract**
  - slice-13：`MonsterSettingsMenu:82` 提前 return 导致菜单无返回按钮；`AbstractConfigMenu:154` 无 `InventoryDragEvent`
  - slice-08：`/hilltop config nodes repairitem` 静默落到打开 GUI

## 宽扫线索被深挖推翻的记录（流程有效性证据）

| 线索（宽扫） | 深挖结论 | 证据 |
|---|---|---|
| slice-08 L1 `handleStatsCommand` 先 `target.getName()` 后判空 → `/hilltop stats` NPE（宽扫定 HIGH） | **REFUTED** | `StatsManager.get(UUID)` 是 `cache.computeIfAbsent(...)`，永不返回 null；`PlayerStats.name` 默认 `""` 而非 null |
| slice-08 L5 `ArenaCommand:39` 无参静默 return（宽扫定 contract） | **REFUTED（有意契约）** | `ArenaCommand` 未在 `plugin.yml` 注册，仅被 HCH 以固定实参调用；`ArenaCommandTest:381-392` 把静默写成断言 |
| slice-05 L2 同一次收尾 `gameManager.stopGame()` 执行两次 → 重复记账 | **REFUTED** | `GameManager.stopGame()` 全文只写内存字段，无任何 Stats/YAML 调用；统计写点都要求「先从 players 移除成功」 |
| slice-05 L5 `resetNow` 双发回滚 → `restoreStarted` 永不复位 | **REFUTED** | `restoreWithResult` 对同一世界合并回调（MapRestoreManager:515-520），`restoreNow` 必然触发 `complete()`，`reset()` 三条分支都复位 |
| slice-21 L1 回滚任务异常 → Bukkit 取消任务 → `isRestoring` 永久 true | **REFUTED（前提为假）** | 作者在 TabListManager:326-332 记录了 CraftScheduler 反编译结论：异常分支**不 cancel**，period>0 会重新入队；任务仍会走到 `complete()` |
| slice-15 L1/L2/L3/L5/L6（作为 concurrency） | **REFUTED** | 全部在 Bukkit 主线程，无跨线程写入；属 data-consistency/contract，转 off_dimension_notes |

**意义**：宽扫的高置信线索有相当比例在深挖阶段被证伪（本轮 6 条 REFUTED，其中 2 条宽扫标 HIGH）。这正是两遍制设计意图——线索允许 70% 被证伪，发现必须过门 0 与控制流取证。

## 本轮实际完成的覆盖（最终口径）

- **宽扫 26/26 片全部完成**（其中 slice-17/18/19/23 由同一 trace_id 的续跑实例补完，见 §4 来源声明）
- **深挖 10 片**：slice-01(DC)、05(DC)、08(EH)、11(DC)、13(contract)、15(concurrency)、20(concurrency)、21(concurrency)、24(DC)、26(DC)
- 深挖维度分布：concurrency 4 / data-consistency 5 / error-handling 1 / contract 1（security、logic 未单独深挖）
- 已确认发现（按审计产物自报）：15→3、20→2、21→1、24→3(+1 EVIDENCE_GAP)、05→1、11→6、08→1(+1 NEF)、13→2、26→3、01→(待补)
  合计 ≥22 条 CONFIRMED
- 锐评：skeptic A（15/20/21 共 6 条）、skeptic B（05/08/11/24 共 11 条）、skeptic C（26/13 共 5 条）、devils_advocate（覆盖缺口 + pattern_sweep）、arbiter（终裁）

## 权威机械复核结果（verifier，22:12–22:15 静默后快照）

- 产物 **38 份带信封**，`check-payload` **全部退出码 0**（NONZERO=0）
- `verify-artifacts`：**0 FAIL / 8 WARN / 5 PASS**
  - `G0 门 0 回显: 174/174 通过`（0 条 quote 与源文件不符）
  - `G2 artifact_path: 37 个 SUCCESS 信封，0 缺失`；`G8 line_count: 26 切片 0 不符`；`G5 自述数字自洽: 53 项 0 不一致`；`G4 账本对账: 36 派发/1 裁量，0 不一致`
  - 8 条 WARN：3 条 G7（声明读了 N 个文件但只有 1–2 条 quote 指向）、1 条 G3（slice-08 的 files_read 缺 ArenaCommand/DeployMenuSender）、1 条 G0 loose 匹配、1 条 state.json 非 .md、其余为同类
- **27 条 finding = CONFIRMED 23（HIGH 4 / MEDIUM 14 / LOW 5）+ NO_EVIDENCE_FOUND 3 + EVIDENCE_GAP 1**
- HIGH 4 条：`F-slice-11-data-consistency-01`、`F-slice-15-concurrency-01`、`F-slice-26-data-consistency-01`、`F-slice-26-data-consistency-02`
- 骨架：仅 1 次 17 秒窗口（slice-13 占位条目），最终已填充；**结构校验抓不到骨架**（信封完整），可靠特征是内容词「骨架占位/待替换」

## 数字口径



- 规划切片 26；已宽扫 **26（100%）**；深挖 **10 片（38.5%）**；锐评 4 实例 + arbiter
- 证据覆盖率：**Q = 174**（`verify-artifacts` G0 的 ok 计数，0 FAIL）、**F = 148**（全部产物 `files_read` 去重路径数，G3 实测 148 条、0 条不存在）
  - **Q/F = 117.6%**。>100% 不是错误：Q 计 quote 条数，同一文件常有多条 quote；框架公式隐含「一文件一 quote」，本仓库不满足。
  - 补充口径：**有 quote 指向的切片文件 = 75/75（100%）**（26 片文件并集全部至少被一条 quote 引用过）。
- 发现计数：27 条 = CONFIRMED 23（HIGH 4 / MEDIUM 14 / LOW 5）+ NO_EVIDENCE_FOUND 3 + EVIDENCE_GAP 1
- 宽扫线索：**151 条**（26 片合计）
