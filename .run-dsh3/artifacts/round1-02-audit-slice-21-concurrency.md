# round1-02-audit-slice-21-concurrency

- trace_id: `trace-r1-20260215-hilltop-dsh3`
- round_id: `round1`
- slice_id: `slice-21`
- dimension: `concurrency`
- 被审仓库（只读）: `D:\Server\MCServers\Server plugin\Hilltop Village\Hilltop Village Plugin`
- 结论：**1 条 CONFIRMED（MEDIUM）**；上游 L1 的原始机制判定 **REFUTED**（见 §2），其残余形态已收窄为 F-01；L2–L6 属其它维度，转入 `off_dimension_notes`。

## 1. 切片与读入范围

| 文件 | 行数（本回合 read 实测） | 本维度结论 |
|---|---|---|
| `src/main/java/com/hilltopvillage/mechanics/MapRestoreManager.java` | 768 | 唯一有并发/任务生命周期面的文件 → F-01 |
| `src/main/java/com/hilltopvillage/mechanics/HammerListener.java` | 634 | 无线程/异步；仅主线程事件 + 1 个 10 tick 延迟任务（安全） |
| `src/main/java/com/hilltopvillage/mechanics/LobbyProtectionListener.java` | 281 | 纯事件处理器，无调度、无共享可变状态 |
| `src/main/java/com/hilltopvillage/mechanics/NodeListener.java` | 321 | 纯事件处理器，无调度、无共享可变状态 |

控制流旁证（切片外、只读、各取 1 段）：
`arena/ArenaInstance.java:1425-1446`（唯一生产调用方）、`mechanics/TabListManager.java:160-172` 与 `:323-341`（仓库内对 `CraftScheduler` 反编译行为的既有结论）。

## 2. 上游线索逐条处置（先读 `round1-02-sweep-slice-21.md`）

| lead | sweep 维度 | 处置 | 依据 |
|---|---|---|---|
| **L1** | concurrency | **REFUTED（原样）/ 收窄后 CONFIRMED = F-01** | 见 §2.1 |
| L2 | data-consistency | 越维度 → `off_dimension_notes` | 哈希序 + `setBlockData(..., false)` 的物理后果 |
| L3 | error-handling | 越维度 → `off_dimension_notes` | TileState 失败重排队无上限 |
| L4 | logic | 越维度 → `off_dimension_notes` | 落地免伤与换手放弃 |
| L5 | contract | 越维度 → `off_dimension_notes` | 村民商人界面未拦 |
| L6 | data-consistency | 越维度 → `off_dimension_notes` | 源方块不在 blockList |

### 2.1 L1 为什么原样不成立

L1 的推理链是：`runTaskTimer` 裸 lambda → 抛异常 → **「Bukkit 调度器会取消该重复任务」** → `complete()` 永不执行 → `activeRestores` 永不移除 → 世界永久 `isRestoring=true`。

前提中的加粗一句在 paper-1.21.4-232 上为**假**。同仓库 `mechanics/TabListManager.java:326-332` 记录了作者对 `CraftScheduler.mainThreadHeartbeat()` 的反编译结论（原文逐字）：

```
     * 反编译 {@code paper-1.21.4-232} 的 {@code CraftScheduler.mainThreadHeartbeat()} 可见，
     * 任务体抛异常后走的分支是：记 WARNING → 发 {@code ServerExceptionEvent} → 清 currentTask →
     * <b>与正常路径汇合</b> → 因 {@code period > 0} 而 {@code pending.add(task)} 重新入队。
     * 全程没有 {@code cancel()}。所以周期任务抛异常后会按时继续执行。</p>
```

同文件 `:166-167` 还明确写了「**不要**指望任务抛异常后 CraftScheduler 会取消它」。因此：

1. 任务在下一次 heartbeat 被重新入队，继续每 tick 调 `restoreBatch(operation)`；
2. `restoreRange` 在 `operation.entries.get(operation.nextIndex++)` 时**先自增再回滚**（`MapRestoreManager.java:585`），抛出异常的那个坐标不会被重复执行，游标继续前进；
3. 游标到末尾后 `complete()` 必然被执行（`:576`），`activeRestores.remove(...)`（`:682`）随即发生。

结论：**「异常 → 任务被取消 → 永久卡死」这条链不存在**，L1 的 MEDIUM 定级不成立。

### 2.2 残余形态：首轮同步批次没有任务可兜底（= F-01）

`restoreWithResult` 在注册任务**之前**就先跑了一批（`restoreBatch(operation)`，`:554`）。这个窗口里 `activeRestores` 已有条目（`:551`）但 `operation.task` 仍为 `null`（赋值在 `:563`）。若这一批抛出**逃出 `catch (RuntimeException)` 的 Throwable**（`:612` 只捕 RuntimeException；Error 如 OOM / NoClassDefFoundError / StackOverflow 不捕），则：异常沿 `restoreRange → restoreBatch → restoreWithResult` 抛给调用方；任务从未创建；`complete()` 从未执行；`activeRestores` 永久保留该世界的条目。此后同一世界的任何 `restoreWithResult` 都走合并分支（`:515-519`）——只挂回调、**不检查该操作是否还活着**，回调因此永远不会被调用。

调用链（入口 → 问题点）：`ArenaInstance.beginReset(…)`（`arena/ArenaInstance.java:1425`）→ `MapRestoreManager.restoreWithResult` → `activeRestores.put`（`:551`）→ `restoreBatch`（`:554`）→ `restoreRange` → `restoreBlock`（`:606`，仅捕 RuntimeException）→ Throwable 逃逸 → 无任务、无 `complete()`。后果：`isRestoring(world)` 恒 true（`:750-752`），`resolveJournal` 恒返回 null（`:268`），竞技场硬屏障 ENDING 永不解除（`ArenaInstance.java:1429-1438` 只在成功回调里复位 `restoreStarted/resetScheduled`）。

## 3. 维度清单逐项结论

| # | 模式 | 结果 | 说明 |
|---|---|---|---|
| 1 | 返回值暴露内部状态 | 未命中 | `getPendingCount` 返回 int；`journals` 无 getter 外泄 |
| 2 | 同族函数守卫一致性 | 命中（非缺陷） | `restoreWithResult`/`restoreNow`/`restoreAllNow` 三者都先 `requirePrimaryThread()`（`:512/628/644`），守卫一致 |
| 3 | 数值边界 | 未命中 | `BLOCKS_PER_TICK` 对 ≤0/非数字回退 200（`:79-95`）；`MAX_JOURNAL_ENTRIES_PER_WORLD` 判 `>=` 后停记 |
| 4a | 原型链/裸下标 | 不适用 | 无外部字符串当 map 键的路径 |
| 4b | 假值 vs 缺值 | 未命中 | `journal == null \|\| journal.isEmpty()` 分开处理（`:522-532`） |
| 4c | NaN/Infinity/小数 | 不适用 | 本维度无外部数值入参 |
| 4d | 嵌套结构校验 | 未命中 | 无解析型输入 |
| 5 | 能力是否真实现 | 命中 | 「同世界只允许一个恢复任务」：`activeRestores` 合并确实生效（`:515-519`）；但**合并无存活检查**（F-01） |
| 6 | 转义/编码顺序 | 不适用 | — |
| 7 | 边界符号（负数/下标） | 未命中 | `nextIndex` 单调自增且 `end = min(nextIndex+BLOCKS_PER_TICK, size)` |
| 8 | 引用绑定是否存在 | 未命中 | 4 个文件编译期引用均在本类/导入内；`BukkitTask` 句柄仅 `:668/679` 使用 |

其他已核查的并发面（均**未命中**，记录以免下游重复劳动）：
- 无 `runTaskAsynchronously` / `runTaskTimerAsynchronously` / `CompletableFuture` / `ExecutorService` / `new Thread` / `synchronized`（4 个文件 grep 命中为 0；唯一调度点是 `runTaskTimer`，`:563`）。
- 异步线程碰世界 API：不成立（`requirePrimaryThread` 三道门 + 所有 handler 均为同步事件）。
- `fluidJournalCache` 是普通 `HashMap`（`:155`）+ `long` tick（`:157`），但只在主线程的 `BlockFromToEvent` 路径使用，类注释 `:346-347` 明确以「主线程单写」为前提；未发现跨线程写入口。
- 关闭/重载：`onDisable` 会调 `restoreAllNow()`（`HilltopVillagePlugin.java:295`），逐个世界 `finishSynchronously`，故关闭路径不会留下活动任务；仓库内**无** `cancelTasks(plugin)` 之类的批量取消调用（grep 0 命中）。
- 跨 tick 冷却：`smashCooldowns` 用 `System.currentTimeMillis()`（`HammerListener.java:383-385`，读 `:205-206`）而 `lastBossBarTick`/`smashActivateTick` 用 tick。墙钟方案在同文件 `:54-57` 注明为设计选择（防离场重置冷却），且 NTP 步进的影响面是「单个玩家的一次技能冷却」，未达缺陷门槛，故不立条。

## 4. 发现

### F-slice-21-concurrency-01（MEDIUM, CONFIRMED）首轮同步回滚批次的 Throwable 会留下无任务、无 `complete()` 的孤儿操作，且合并分支不检查存活

- 证据锚点：`MapRestoreManager.java:551-555`（`put` → 同步 `restoreBatch` → 早退），配合 `:612`（只捕 RuntimeException）、`:563-564`（任务在批次之后才注册）、`:682`（唯一移除点）、`:515-519`（合并不查存活）。
- 为什么这不是 error-handling 而是 concurrency：缺陷实体是**任务/等待的生命周期**——操作已被发布到 `activeRestores`（对其它调用方可见）却还没有任何任务持有它；后续所有调用方改为「等一个永远不会到来的回调」。这正是任务书 concurrency 清单的「BukkitTask 泄漏 / 异步等待泄漏 / 取消时任务是否 cancel()」。
- 影响：单个竞技场永久卡在 ENDING（需重启服务器或手工改状态）；该世界的 `journals` 记录也被 `resolveJournal` 的 `activeRestores.containsKey` 门永久关掉（`:268`），即使地图被管理员修好也不再记账。
- 触发条件：`BLOCKS_PER_TICK`（默认 200）个方块的首批处理中，任一处抛 Error（该类自身在 `:100-104` 论证过 3GB 堆与 journal 体量，OOM 不是纯理论），或 `TileState#update` 因服务端/插件 API 版本不匹配抛 `NoSuchMethodError`（LinkageError，非 RuntimeException）。

**替代解释（可检查）**
1. 若把 `restoreBlock` 的捕获扩到 `Throwable`（`mechanics/MapRestoreManager.java:612`），该窗口关闭——需确认修复波是否接受「Error 也计入 failedEntries」的语义。
2. 若把任务注册（`:562-564`）提到 `activeRestores.put` 之前、或至少在 `:554` 之前，则任何 Throwable 之后仍有任务存活，下一 tick 会继续并最终 `complete()`（依据 `CraftScheduler` 异常后重新入队，`mechanics/TabListManager.java:329-332`）。
3. 若存在外部看门狗周期性扫描 `activeRestores` 并调用 `finishSynchronously`，则不成立——当前 `finishSynchronously` 只有 4 个调用点（`:518/558/567/631`），全部是「本次调用栈内」的同步收尾，无周期扫描。

## 5. 自检记录

- **标识符对账（DONE）**：对 `activeRestores` 全部出现点做集合比对——声明 `:145`、读 `:268/515/630/646/751/758`、写 `:551`、移除 `:682`（`remove(key,value)`）。**差集结论：移除点唯一 = `complete():682`**，`finishSynchronously` 与 `restoreNow` 都必须先走到 `complete()` 才能清条目；`journals` 的移除点为 `:525/540`，`journalOverflowWarned` 为 `:527/545`，`journalTruncated` 为 `:360` 加 `:691`（take-and-remove），无孤儿键。这正是 L1 得以成立的那一半事实（移除点唯一），但另一半（任务会因异常被取消）为假。
- **自带自检抽验（DONE）**：`src/test/java/com/hilltopvillage/mechanics/MapRestoreManagerTest.java` 存在，抽验结论：`restoreIsChunkedPerTick`（`:297` 起，断言在 `:313/321`）覆盖「450 块 → `isRestoring` true → false」的正常分片路径，`truncatedJournalReportsFailureButStillRestoresBlocks` 覆盖 success 判定；**没有任何用例注入「批次内抛 Throwable」**，因此 F-01 所述的孤儿状态在现有测试里不可见（不构成反证）。仓库无 `check-*.mjs` 类自检脚本（Java 工程），本项以「测试是否覆盖该不变量」的方式抽验。
- **运行时验证（SKIPPED）**：需启动 Paper 服务端或跑 maven/gradle 测试，两者都会写 `target/`/`build/` 并加载真实世界，违反本次零写入约束，故不做；F-01 的判据全部是控制流（put → 同步批次 → 任务注册的先后顺序），不依赖运行时观测。

## 6. 返回信封

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "audit-slice-21-concurrency",
  "role": "audit",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/.run-dsh3/artifacts/round1-02-audit-slice-21-concurrency.md",
  "payload": {
    "slice_id": "slice-21",
    "findings": [
      {
        "finding_id": "F-slice-21-concurrency-01",
        "severity": "MEDIUM",
        "dimension": "concurrency",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/mechanics/MapRestoreManager.java",
          "line": 551,
          "quote": "        activeRestores.put(worldName, operation);\n\n        plugin.getLogger().info(\"Starting rollback of \" + operation.entries.size() + \" block change(s) in \" + worldName);\n        restoreBatch(operation);\n        if (operation.finished) return true;"
        },
        "inference": {
          "claim": "回滚操作在任务注册之前就被发布到 activeRestores 并同步跑完首批；若这一批抛出逃出 catch (RuntimeException) 的 Throwable，该操作既没有 BukkitTask、也没有任何路径会再调用 complete()，activeRestores 中的条目永久残留，isRestoring(world) 恒为 true，竞技场 ENDING 屏障永不解除。",
          "basis": "控制流证据：restoreWithResult 在 :551 先 activeRestores.put，:554 同步调 restoreBatch，:563 才注册 runTaskTimer；restoreBlock 的 catch 只覆盖 RuntimeException（:612），Error/LinkageError 会穿透 restoreRange/restoreBatch 抛给调用方（ArenaInstance.java:1425 的调用点没有 try/catch）。complete() 是 activeRestores 的唯一移除点（:682，已用标识符对账确认），而它只可能由 restoreBatch(:576) 或 finishSynchronously(:672) 触发；任务未创建时两者都不会再发生。此后同世界的 restoreWithResult 走 :515-519 的合并分支，只 addCompletionCallback 而不检查 operation 是否仍有存活任务，回调因此永不触发。",
          "alternatives": [
            "若 restoreBlock 把捕获从 RuntimeException 扩到 Throwable（mechanics/MapRestoreManager.java:612），该窗口关闭——需修复波确认是否接受把 Error 计入 failedEntries。",
            "若把任务注册（mechanics/MapRestoreManager.java:562-564）提前到 :554 的同步批次之前，则 Throwable 之后仍有任务存活，下一 tick 继续并最终 complete()（CraftScheduler 异常后重新入队，见 mechanics/TabListManager.java:329-332）。",
            "若存在周期性看门狗扫描 activeRestores 并调用 finishSynchronously，则不成立——需检查 finishSynchronously 的全部调用点：当前仅 :518/558/567/631，均为本次调用栈内的同步收尾，无周期扫描。"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "F-slice-21-concurrency-02-L1-refuted",
        "severity": null,
        "dimension": "concurrency",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/mechanics/MapRestoreManager.java",
          "line": 576,
          "quote": "        if (operation.nextIndex >= operation.entries.size()) complete(operation);"
        },
        "inference": {
          "claim": "L1 原样判定 REFUTED：其「Bukkit 在任务抛异常时会取消该 repeating task，导致 activeRestores 永不移除」的机制前提在 paper-1.21.4-232 上不成立；任务被重新入队后会继续推进 nextIndex 并最终走到 complete()。该线索的残余真实形态已收窄为 F-slice-21-concurrency-01（首轮同步批次无任务可兜底），不再以「异常即永久卡死」立条。",
          "basis": "本仓库 mechanics/TabListManager.java:326-332 记录了作者对 CraftScheduler.mainThreadHeartbeat() 的反编译结论：异常分支为「记 WARNING → ServerExceptionEvent → 清 currentTask → 与正常路径汇合 → period>0 重新入队 → 全程无 cancel()」；同文件 :166-167 亦写明不要指望任务抛异常后被取消。控制流上 restoreRange 先自增再回滚（:585），抛错坐标不会被重复执行，游标继续前进，:576 的 complete() 终会到达，:682 的移除随之发生。因此「移除点唯一（:682）」这一事实本身不足以推出 L1 的结论，还差「任务停止推进」这一环，而该环在异常路径上不成立。",
          "alternatives": [
            "若目标服务端不是 paper-1.21.4-232 且其 CraftScheduler 在异常分支调用了 cancel()，则 L1 原样成立——需在部署实例上反编译核对 org.bukkit.scheduler 对应实现，或查看该构建的 ServerExceptionEvent 处理链。",
            "若某条异常路径每次都在同一次 restoreBatch 内抛在 complete() 之前且游标不前进（例如 :585 的 get 越界），则任务虽存活但永不收敛——需检查 operation.entries 与 nextIndex 的边界（当前 entries 为 :549 的定长副本，get 不会越界）。"
          ]
        },
        "status": "NO_EVIDENCE_FOUND"
      }
    ],
    "searched_scope": {
      "files_read": [
        "src/main/java/com/hilltopvillage/mechanics/MapRestoreManager.java",
        "src/main/java/com/hilltopvillage/mechanics/HammerListener.java",
        "src/main/java/com/hilltopvillage/mechanics/LobbyProtectionListener.java",
        "src/main/java/com/hilltopvillage/mechanics/NodeListener.java",
        "src/main/java/com/hilltopvillage/arena/ArenaInstance.java",
        "src/main/java/com/hilltopvillage/mechanics/TabListManager.java"
      ],
      "files_in_slice": 4,
      "shared_dependencies_read": [
        "src/main/java/com/hilltopvillage/arena/ArenaInstance.java",
        "src/main/java/com/hilltopvillage/mechanics/TabListManager.java"
      ],
      "files_scanned_without_findings": [
        "src/main/java/com/hilltopvillage/mechanics/HammerListener.java",
        "src/main/java/com/hilltopvillage/mechanics/LobbyProtectionListener.java",
        "src/main/java/com/hilltopvillage/mechanics/NodeListener.java"
      ],
      "dimension_checklist": [
        { "pattern": "1 返回值暴露内部状态", "result": "未命中", "note": "getPendingCount 返回 int；journals 无 getter 外泄" },
        { "pattern": "2 同族函数守卫一致性", "result": "命中", "note": "restoreWithResult/restoreNow/restoreAllNow 均先 requirePrimaryThread（512/628/644），一致，非缺陷" },
        { "pattern": "3 数值边界", "result": "未命中", "note": "BLOCKS_PER_TICK 对 ≤0/非数字回退 200；journal 上限用 >= 判停" },
        { "pattern": "4a 原型链/裸下标", "result": "不适用", "note": "本维度无外部字符串作为 map 键" },
        { "pattern": "4b 假值 vs 缺值", "result": "未命中", "note": "journal==null 与 isEmpty 分开处理（522-532）" },
        { "pattern": "4c NaN/Infinity/小数", "result": "不适用", "note": "本维度无外部数值入参" },
        { "pattern": "4d 嵌套结构校验", "result": "不适用", "note": "无解析型输入" },
        { "pattern": "5 能力是否真实现", "result": "命中", "note": "同世界单任务合并生效（515-519），但合并无存活检查 → F-01" },
        { "pattern": "6 转义/编码顺序", "result": "不适用", "note": "无字符串拼接写入" },
        { "pattern": "7 边界符号（负数/下标）", "result": "未命中", "note": "nextIndex 单调自增，end=min(nextIndex+200,size)" },
        { "pattern": "8 引用绑定是否存在", "result": "未命中", "note": "BukkitTask 句柄仅 668/679 使用，无悬空引用" }
      ]
    },
    "self_checks": {
      "identifier_reconcile": {
        "status": "DONE",
        "note": "对账 activeRestores 全部出现点（145/268/515/551/630/646/682/751/758），差集结论：移除点唯一 = complete():682；journals 移除点 525/540，journalTruncated 为 360 加 691 的 take-and-remove，无孤儿键"
      },
      "self_check_audit": {
        "status": "DONE",
        "note": "抽验 src/test/java/com/hilltopvillage/mechanics/MapRestoreManagerTest.java：restoreIsChunkedPerTick 覆盖 450 块分片的 isRestoring true→false，但无用例注入批次内 Throwable，故 F-01 的孤儿状态在现有测试中不可见"
      },
      "runtime_validation": {
        "status": "SKIPPED",
        "note": "启动 Paper 服务端或跑 maven/gradle 都会写 target 并加载真实世界，违反本次零写入约束；F-01 的判据是 put→同步批次→任务注册的先后顺序，属控制流证据，不依赖运行时观测"
      }
    },
    "off_dimension_notes": [
      "L2（data-consistency）：MapRestoreManager:549 取 ConcurrentHashMap 的哈希序、:610 以 setBlockData(...,false) 关闭物理，悬空沙砾/被截断流体可能无支撑写回。",
      "L3（error-handling）：MapRestoreManager:611 把 TileState.update 的布尔值当整块成功判据，失败条目经 :731-735 无条件重排队，无重试上限/死信。",
      "L4（logic）：HammerListener:344-345 在 isSmashActive 时无条件取消落地伤害，而 :357-360 换手放弃不写冷却，形成可重复的免摔落窗口。",
      "L5（contract）：LobbyProtectionListener:241 只拦 ArmorStand/ItemFrame，Villager 商人界面未被拦截，与类注释 :39 的「容器交互全部被阻止」及 :250-251 的伤害保护口径不一致。",
      "L6（data-consistency）：NodeListener:169 只从 blockList 剔除节点方块，BlockExplodeEvent 的源方块（event.getBlock）不在其中。",
      "观察（非缺陷，未立条）：HammerListener 的 10 tick 延迟任务（:368-373）只做 recentlyLanded.remove(uuid)，不触碰 Player 实体，玩家退出后执行安全；smashCooldowns 用墙钟（:383-385）为 :54-57 注明的设计选择。"
    ]
  },
  "error": null
}
```
