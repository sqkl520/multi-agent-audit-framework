# round1 / slice-15 / dimension=concurrency 深挖审计

- trace_id: `trace-r1-20260215-hilltop-dsh3`
- round_id: `round1`
- slice_id: `slice-15`
- dimension: `concurrency`（本产物只报这一个维度）
- 被审仓库（只读，零写入）: `D:\Server\MCServers\Server plugin\Hilltop Village\Hilltop Village Plugin`
- 读取方式: 5 个切片文件逐个 `read` 全文；行号以 LF 切分为准（与 `tools/verify-artifacts.mjs` 的 `split(/\r?\n/)` 同口径，已用 node 复核：三个被引文件 `hasCR=false`）
- 结论: **3 条 CONFIRMED（1 HIGH / 1 MEDIUM / 1 LOW）**，无 CRITICAL，无 NO_EVIDENCE_FOUND

---

## 1. 结论摘要

| # | finding_id | 严重性 | 一句话 |
|---|---|---|---|
| 1 | `F-slice-15-concurrency-01` | HIGH | 异步线程执行 `YamlConfiguration.saveToString()`，序列化含 `ItemStack` 的配置对象——与本类 javadoc 自述的「序列化留主线程」相反 |
| 2 | `F-slice-15-concurrency-02` | MEDIUM | 主线程 `saveNow()`（`PlayerQuitEvent` 现场）与异步序列化共用同一把 `writeLock`，退出时可能被整份 YAML 序列化 + 一次 `Files.move` 阻塞 |
| 3 | `F-slice-15-concurrency-03` | LOW | 波次超时保险用挂钟 `System.currentTimeMillis()` 计时，时钟回拨会让保险推迟/失效（默认禁用，故仅 LOW） |

**切片并发面总览**：整个切片只有 **一处** 真实跨线程边界——`PlayerGoodsManager.flushToDisk()` 的 `runTaskAsynchronously`（478）。`GameManager` 的全部调度（`runTaskTimer` 340-345 / `runTaskLater` 514-535）、`HilltopVillagePlugin` 的启停路径、`PlayerData` 的计数器都在 Bukkit 主线程，**未发现竞态**。因此本切片的并发风险集中在「异步写盘」这一条链上，而不是状态机。

---

## 2. 上游线索逐条处置（L1–L6）

| lead | 上游维度 | 本片处置 | 理由 |
|---|---|---|---|
| **L4** 异步线程内 `yaml.saveToString()`（`PlayerGoodsManager.java:422`） | concurrency | **升级为 CONFIRMED** → `F-slice-15-concurrency-01`（HIGH） | 478→422 的线程边界已逐行核实；并新增「与本类 336-341 行 javadoc 相反」这一层证据；锁争用另立 `F-...-02` |
| **L1** `endGame(boolean)` 无重入守卫（`GameManager.java:652`） | data-consistency | **REFUTED（作为 concurrency 缺陷）**，转入 `off_dimension_notes` | Bukkit 主线程单线程串行，本文件内的调用点（`removeOfflinePlayer:741`、`onWaveComplete:503`、`startNextWave:306`）都在事件/调度回调内，不存在两个线程同时进入 `endGame`。它是同线程重入的**数据一致性**问题，不是竞态 |
| **L2** 结算窗口内掉线仍走 `endGame(false)`（740） | data-consistency | REFUTED（作为 concurrency），转 `off_dimension_notes` | 同 L1：无跨线程写入；属状态守卫缺失 |
| **L3** `stopGame()` 与 `endGame()` 职责不对称（657） | contract | REFUTED（作为 concurrency），转 `off_dimension_notes` | 契约/职责口径问题，无并发原语参与 |
| **L5** 写盘失败只记日志（432） | data-consistency | REFUTED（作为 concurrency），转 `off_dimension_notes` | `catch (IOException)` 的补偿缺失属持久化一致性；并发侧未发现「失败导致竞态」 |
| **L6** `onDisable` 单层 try-catch 包整批停止（`HilltopVillagePlugin.java:286`） | error-handling | REFUTED（作为 concurrency），转 `off_dimension_notes` | 异常隔离问题；任务取消清单本身（`onDisable:279-338`）在并发角度看是完整的 |

> 处置纪律：L2/L3/L5/L6 在本片**不判成立也不判不成立**，只判「不构成本维度的缺陷」；它们的原始线索原样保留在 `off_dimension_notes`，由对应维度的实例接手。L1 额外给出并发侧的否证理由（单线程），避免被误当成竞态修。

---

## 3. 发现详情

### F-slice-15-concurrency-01（HIGH）异步线程序列化含 ItemStack 的 Bukkit 配置对象

**证据（本回合读取，逐字）** — `src/main/java/com/hilltopvillage/core/PlayerGoodsManager.java:478`

```text
        Bukkit.getScheduler().runTaskAsynchronously(plugin, () -> writeYaml(yaml, seq));
```

**同一条链上的关键行（各自独立可核）**

| 行 | 原文 | 作用 |
|---|---|---|
| 476 | `final YamlConfiguration yaml = buildYaml();` | 主线程构建配置对象 |
| 354 | `yaml.set(path + ".off-hand", snapshot.offHand);` | 把 **ItemStack 引用**塞进 YAML |
| 521 | `yaml.set(path + "." + i, item);` | 背包槽位同理 |
| 422 | `payload = yaml.saveToString().getBytes(StandardCharsets.UTF_8);` | **异步线程**执行序列化 |
| 339-341 | `* <p>刻意把「序列化」与「写文件」拆开：序列化读的是 Bukkit 的` / `* {@link YamlConfiguration}，线程安全性没有官方保证，因此留在主线程；` / `* 只有纯粹的 {@link java.nio.file.Files} 写入丢到异步线程。</p>` | 作者自述的契约：序列化**必须**在主线程 |

**观察**：`flushToDisk()` 先在主线程 `buildYaml()`，再把整个 `writeYaml(yaml, seq)` 交给 `runTaskAsynchronously`；`writeYaml` 的第一段临界区就是 `yaml.saveToString()`。也就是说，被异步化的不只是 `Files.write`，还包括 `ItemStack.serialize()` / `getItemMeta()` 这条会读 NMS 物品对象的路径。

**推断**：`writeLock` 只保证「同一时刻只有一个线程在序列化」，它不能把异步线程变成主线程，也不能让 `ItemStack` 的读取变成线程安全。因此该类**自己声明的线程约束被实现违反**：读的是 Bukkit 对象、跑的是异步调度线程。后果分两层——确定的一层是契约违反（336-341 与 478/422 直接矛盾）；条件性的一层是若这些 `ItemStack` 仍可能被主线程触碰，异步序列化可能读到中间态（撕裂的物品元数据/NBT），而写出的正是下次启动用来归还玩家物品的 `player-goods.yml`。

**为什么是 HIGH 而不是 CRITICAL**：调用链完整（`save/restore → scheduleSaveToDisk → runTaskLater(flushToDisk) → runTaskAsynchronously → saveToString`），但「撕裂」需要额外的并发修改条件，本回合没有运行期证据；按 `wave2-audit.md` §3.3，最高 HIGH。

**替代解释（Skeptic 的攻击面）**
1. 如果这些 `ItemStack` 在异步序列化期间不可能被任何线程修改（快照已被 `clearInventory` 从背包摘除，且 `restore()` 的 `setContents` 在目标服务端做深拷贝），则不会有撕裂，只剩「非主线程访问 Bukkit 对象」的契约违反——需在目标 Paper 1.21.x 上核实 `CraftInventory#setContents` 是否复制 `ItemStack`（`PlayerGoodsManager.java:190-196`）。
2. 如果目标服务端的 `YamlConfiguration.saveToString()` 与 `ItemStack.serialize()` 实际是纯只读、且没有主线程断言，则不会抛异常，影响降级为潜在风险——需在目标版本实测一次异步 `saveToString` 并比对输出（`PlayerGoodsManager.java:422`）。
3. 如果该服务端的 `runTaskAsynchronously` 实际同步执行（测试 harness 或替代调度器），则线程边界不存在——需检查服务端 `Scheduler` 实现（CraftScheduler 为真实异步线程池，`PlayerGoodsManager.java:478`）。

---

### F-slice-15-concurrency-02（MEDIUM）主线程 `saveNow()` 与异步序列化共用 `writeLock`

**证据（本回合读取，逐字）** — `src/main/java/com/hilltopvillage/HilltopVillagePlugin.java:563`

```text
                playerGoodsManager.saveNow();
```

调用点上下文：`onPlayerQuit(PlayerQuitEvent)`（548）内、`multiArenaManager.handleQuit(player)` 之后，**每个玩家退出都执行一次**。

**同一条链上的关键行**

| 行 | 原文 | 作用 |
|---|---|---|
| 498-503 | `public void saveNow() {` … `writeYaml(buildYaml(), nextWriteSeq());` | 同步写路径（主线程） |
| 419 | `synchronized (writeLock) {` | 同步路径与异步路径共用的 monitor |
| 422 | `payload = yaml.saveToString().getBytes(StandardCharsets.UTF_8);` | 异步侧在**锁内**序列化整份 YAML |
| 429 | `Files.move(tmp.toPath(), goodsFile.toPath(), StandardCopyOption.REPLACE_EXISTING);` | 锁内还有一次磁盘 rename |
| 478 | `Bukkit.getScheduler().runTaskAsynchronously(plugin, () -> writeYaml(yaml, seq));` | 异步侧入口 |

**观察**：`saveNow()` 在主线程同步调用 `writeYaml`，进入 `writeLock`；而异步写线程在 419-423 持有同一把锁执行 `saveToString()`（遍历 `goods` 中全部快照、序列化所有物品），并在 425-429 再次持锁做 `Files.move`。因此主线程的等待时间不是「一次 rename」，而是「一次完整序列化 + 一次 rename」。

**推断**：这把锁把异步化的收益抵消了一部分——线上每有一名玩家退出（`PlayerQuitEvent`）、以及 `onDisable` 收尾（`HilltopVillagePlugin.java:334`），主线程都可能停在一把被异步线程持有的锁上，停顿时间随未归还快照数与物品总量线性增长。这不是数据错误，而是 tick 停顿（卡服）风险；`saveNow` 的调用频率是「每次退出」，不是「每次关服」，因此放大面比注释假设的更大。

**为什么是 MEDIUM**：机制由代码结构直接可证（同一 monitor、锁内含序列化与磁盘 move），但实际停顿时长取决于快照规模，本回合无法量化；且注释表明作者已接受「一次字符串化 + 一次 rename」的等待，属**低估了等待上限**而非完全未考虑。

**替代解释**
1. 如果未归还快照数量很小（通常 <10 名玩家），一次 `saveToString()` 只有毫秒级，tick 不受可见影响——需按实际 `pendingUuids().size()`（`PlayerGoodsManager.java:228`）与物品总量评估。
2. 如果服务端把 `PlayerQuitEvent` 放到异步线程（部分 fork / 代理实现），`saveNow()` 就不在 tick 线程，主线程阻塞不成立——需确认目标服务端的退出事件线程模型（`HilltopVillagePlugin.java:548`）。
3. 如果 419-423 的锁范围不含 `saveToString()`（例如只看 424 行之后的写文件段），主线程等待上限就只剩一次 rename——需复核 `PlayerGoodsManager.java:419-423` 的锁边界。

---

### F-slice-15-concurrency-03（LOW）波次超时保险用挂钟计时

**证据（本回合读取，逐字）** — `src/main/java/com/hilltopvillage/core/GameManager.java:478`

```text
        long elapsedSeconds = (System.currentTimeMillis() - waveStartMillis) / 1000L;
```

**同一条链上的关键行**

| 行 | 原文 | 作用 |
|---|---|---|
| 330 | `waveStartMillis = System.currentTimeMillis();` | 起点用挂钟 |
| 479 | `if (elapsedSeconds < timeoutSeconds) return;` | 据此判定是否进入第一阶段 |
| 487 | `} else if (elapsedSeconds >= (long) timeoutSeconds + WAVE_STUCK_PURGE_GRACE_SECONDS) {` | 第二阶段强清 |
| 340-345 | `.runTaskTimer(plugin, 100L, 60L);` | 驱动本身是 tick 任务 |
| 476 | `if (timeoutSeconds <= 0) return; // 显式禁用` | 默认 0 = 该保险默认关闭 |

**观察**：同一段逻辑里，驱动是 tick（每 60 tick 一次），但「已经过去多久」用的是不可单调的挂钟。`System.currentTimeMillis()` 会被 NTP 步进、手动校时、宿主快照恢复改写。

**推断**：时钟回拨（例如 120 秒）会让 `elapsedSeconds` 变小甚至为负，第一阶段的「传送+高亮」和第二阶段的「强制清怪」被推迟，本应打破的软锁继续存在——而这正是该保险存在的唯一目的；时钟前跳则会提前清掉仍在场的残怪，虚增 `wave-stuck-purge` 播报。改用 tick 计数（与 340-345 的驱动同源）即可获得单调性。由于 476 行表明该保险默认禁用（`timeoutSeconds <= 0` 直接 return），影响面被限制在显式配置了 `wave-timeout-seconds > 0` 的服务器，故定 LOW。

**替代解释**
1. 如果实际 `game-settings.yml` 未启用 `wave-timeout-seconds`（默认 0），该路径根本不执行，问题不成立——需检查部署配置（`GameManager.java:476`）。
2. 如果宿主时钟稳定、无 NTP 步进与手动校时，挂钟与单调时钟的差异可忽略——需确认部署环境的时间同步策略（`GameManager.java:478`）。
3. 如果服务器严重卡顿，tick 计数同样会滞后——但 tick 不会倒退，回拨场景仍然只有挂钟会失效（`GameManager.java:330`）。

---

## 4. 覆盖与方法

### 4.1 读取范围（5/5 切片文件，全文）

| 文件 | 行数 | 本片用途 |
|---|---|---|
| `src/main/java/com/hilltopvillage/core/GameManager.java` | 906 | 调度任务、跨 tick 计时、状态字段的线程归属 |
| `src/main/java/com/hilltopvillage/core/GameState.java` | 23 | 纯枚举，无状态 |
| `src/main/java/com/hilltopvillage/HilltopVillagePlugin.java` | 617 | 启停/退出路径的调用线程、任务取消清单 |
| `src/main/java/com/hilltopvillage/core/PlayerData.java` | 105 | 计数器与标志位的写入线程 |
| `src/main/java/com/hilltopvillage/core/PlayerGoodsManager.java` | 569 | 异步写盘全链路（本片核心） |

未读取切片外文件（`shared_dependencies` 为空）；`StatsManager` 的同类异步模式只作为切片外提示写入 `off_dimension_notes`，**不据此推断**。

### 4.2 检索方法（grep，本回合执行）

```text
pattern: runTaskAsynchronously|runTaskTimerAsynchronously|CompletableFuture|ExecutorService|new Thread|synchronized|volatile|Atomic|ConcurrentHashMap|currentTimeMillis|nanoTime
scope:   src/main/java/com/hilltopvillage/**/*.java
hits:    165
```

全仓 `runTaskAsynchronously` 仅 3 处：`CommandsDocumentGenerator.java:467`（文档生成，切片外）、`PlayerGoodsManager.java:478`（本切片）、`StatsManager.java:673`（切片外）。`runTaskTimerAsynchronously` 仅 `StatsManager.java:640`（切片外）。`ExecutorService` / `new Thread` / `CompletableFuture` 零命中。因此**本切片的跨线程面确实只有 PlayerGoodsManager 一处**，这一点是「未发现其他竞态」的正面依据，而不是「没查」。

### 4.3 明确判定为「无并发缺陷」的点

- `GameManager` 的 `waveCheckTask` / `waveSchedulerTask`：创建、取消、置空全部在 `runTaskTimer`/`runTaskLater` 回调与命令/事件线程（同为 Bukkit 主线程）内；`startNextWave` 入口先 `cancelWaveScheduler()`（300），`onWaveComplete` 排队前也先取消（510），未发现双开或泄漏。
- `GameManager.players` / `playerDataMap`：`ConcurrentHashMap` 支撑（117-118），遍历均为弱一致；全仓无异步写入方，`ConcurrentModificationException` 面不成立。
- `PlayerGoodsManager.writeSeq` 的两次校验（421 / 428）：序号在主线程分配、`AtomicLong` 跨线程可见，锁内比对 + 锁外写唯一 tmp + 发布前复检；逐条推演了「旧写后发布覆盖新写」的各种交错，未找到可落地的反例。
- `PlayerGoodsManager.writeLock` 的 tmp 文件名：`System.nanoTime()` 后缀（410），并发写不共用临时文件，未发现内容交错。
- `PlayerGoodsManager.pendingSaveTask`：`saveNow()` → `cancelScheduledSave()`（499/506-512）取消，`onDisable` 也调用 `saveNow()`（334），未发现任务泄漏。
- `PlayerData` 的 `int` 计数器：`addKill` / `addCurrencyCollected` 等只在主线程事件（`HilltopVillagePlugin.java:468-470`）与调度回调内调用，未发现跨线程累加。

---

## 5. 维度清单逐项结论（concurrency）

| # | 检查项 | 结果 | 说明 |
|---|---|---|---|
| 1 | 返回值暴露内部状态 | 未命中 | `getPlayers()` 返回 unmodifiableSet、`getSpawnPoints()` 返回拷贝、`getMobSpawnPointsView()` 为只读视图（底层列表整体替换而非原地改）；`pendingUuids()` 返回 keySet 拷贝 |
| 2 | 同族函数守卫一致性 | 未命中 | 并发守卫（调度/取消）在 `endGame`/`stopGame`/`haltGame` 三处一致；三者的**职责**差异属 data-consistency/contract，见 off_dimension_notes |
| 3 | 数值边界 | 不适用 | 本维度不评数值边界；计时边界见 F-03 |
| 4a | 原型链/裸下标 | 不适用 | 无外部字符串键查表；YAML 键为 UUID 与整数槽位 |
| 4b | 假值 vs 缺值 | 未命中 | 缺键默认值只影响读盘内容，不涉及并发语义 |
| 4c | NaN/Infinity/小数 | 未命中 | 无跨线程数值输入 |
| 4d | 嵌套结构校验 | 未命中 | YAML 仅在 `onEnable` 主线程一次性加载 |
| 5 | 能力是否真实现 | **命中** | 类注释声称「序列化留主线程」，实现把 `saveToString()` 放异步线程（F-01） |
| 6 | 转义/编码顺序 | 不适用 | 无多层转义 |
| 7 | 边界符号（负数/下标） | 不适用 | 无下标运算参与并发判断 |
| 8 | 引用绑定是否存在 | 未命中 | `writeSeq`/`nextWriteSeq`/`writeLock`/`saveScheduled` 均有定义与引用，无缺失导入 |
| C1 | 异步体调用 Bukkit 世界/配置 API | **命中** | 478→422 在异步线程序列化 `YamlConfiguration`（含 `ItemStack`），见 F-01 |
| C2 | 异步线程读写普通 HashMap/ArrayList/HashSet | 未命中 | `goods` 为 ConcurrentHashMap；`Snapshot.effects` 只在主线程 `buildYaml` 内读；异步线程只碰已构建的 YAML 及其引用的 ItemStack |
| C3 | 任务取消 / BukkitTask 泄漏 / 关服后回调 | 未命中 | 两个管理器的主任务均有 cancel + 置空；`flushToDisk` 在 `!isEnabled()` 时改同步写（471-474），不在禁用后新调度 |
| C4 | 跨 tick 计时（挂钟 vs tick） | **命中** | `waveStartMillis` 用 `System.currentTimeMillis()`，见 F-03 |
| C5 | 非原子 `++`/`--`/复合状态 | 未命中 | `writeSeq` 用 AtomicLong；`PlayerData` 计数器仅主线程 |
| C6 | 锁范围与主线程阻塞 | **命中** | `writeLock` 同时覆盖异步序列化与主线程 `saveNow`，见 F-02 |

---

## 6. 三项必做自检

### 6.1 标识符对账（identifier_reconcile）

对账了 `writeLock`、`writeSeq`、`nextWriteSeq`、`saveScheduled`、`pendingSaveTask`、`goods`、`settlementPhase` 的定义侧与全部消费侧：

| 标识符 | 定义 | 消费点 | 差集结论 |
|---|---|---|---|
| `writeLock` | 88 | 419、425 | 无差集；两段临界区均在同一 monitor 上（F-02 的依据） |
| `writeSeq` | 98 | 102、421、428 | 无差集；读写均经 `AtomicLong` |
| `nextWriteSeq` | 101 | 473、477、502 | 无差集；3 个调用点均在主线程 |
| `saveScheduled` | 70 | 455、463、469、507 | 无差集；注释声称「只在主线程读写」，4 个访问点全部落在主线程路径，**注释与实现一致** |
| `pendingSaveTask` | 78 | 464、470、508-510 | 无差集；调度与取消成对 |
| `settlementPhase` | 57 | 269、575、631、658、703、837 | 声明为 `volatile`，但本回合读到的全部读写点都在主线程调度/事件路径；属**过度同步**，不是缺陷，未立条 |

`PlayerData` 的 `kills/deaths/nodesRepaired/currencyCollected` 与 `smashActive` 等字段：无 `volatile`/`Atomic*`，但全部写入点都在主线程事件与调度回调内，未发现跨线程写入——不立条。

### 6.2 自带自检抽验（self_check_audit）

仓库无 `check-*` / `verify-*` / `test` 自检脚本：`glob **/*.{sh,mjs,js,ps1,bat}` 仅命中 `build.sh`（构建）与 `.work/fix-critical/gen-messages-legacy.mjs`（消息表迁移工具），`src/test/**/*.java` 零命中。没有「项目自己说通过了」的历史 PASS 结论可采信，故本项按 `NOT_APPLICABLE` 记录；替代做法是对 `writeYaml` 的序号协议做了静态注入式推演（见 6.4），确认「旧写覆盖新写」在现有两次校验下不可达。

### 6.3 运行时验证（runtime_validation）

`SKIPPED`：任务书硬约束禁止跑 maven/gradle（会写 `target/`，破坏零写入），且本机没有可加载该插件的 Paper 服务端；并发时序（异步序列化撕裂、tick 停顿）无法在此环境复现。

### 6.4 序号协议推演（替代性静态注入）

对 `writeYaml` 的 421/428 两次 `seq != writeSeq.get()` 校验做了交错推演：

1. 旧写 A(seq=5) 与新写 B(seq=6)：A 先取锁校验通过 → 序列化 → 放锁写 tmp；B 取锁校验通过 → 序列化 → 写 tmp → 取锁 move（发布 6）；A 再取锁时 5≠6 → 放弃 move。**结果：磁盘为 6。**
2. A 先完成 move（此时 `writeSeq` 仍为 5）→ B 随后分配 6 并发布。**结果：磁盘为 6。**
3. A 在 424 写 tmp 期间 B 分配 6 并完成发布；A 在 428 放弃。**结果：磁盘为 6。**

三种交错都收敛到「序号最大的内容胜出」，未发现反例。这也是把 L4 的「顺序覆盖」疑虑排除、只保留「异步序列化 Bukkit 对象」这一条的依据。

---

## 7. 零写入与边界自证

- 未修改、未新建、未删除被审仓库任何文件；未执行 maven/gradle/git 写操作。
- 只读取了 5 个切片文件 + 框架自身的任务书/模板/校验器；未跨切片读取被审仓库其他文件。
- 本产物只写 `round1-02-audit-slice-15-concurrency.md` 一个文件。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "audit-slice-15-concurrency",
  "role": "audit",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/.run-dsh3/artifacts/round1-02-audit-slice-15-concurrency.md",
  "payload": {
    "slice_id": "slice-15",
    "findings": [
      {
        "finding_id": "F-slice-15-concurrency-01",
        "severity": "HIGH",
        "dimension": "concurrency",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/core/PlayerGoodsManager.java",
          "line": 478,
          "quote": "Bukkit.getScheduler().runTaskAsynchronously(plugin, () -> writeYaml(yaml, seq));"
        },
        "inference": {
          "claim": "flushToDisk() 把整个 writeYaml 丢到异步线程，而 writeYaml 在 422 行执行 yaml.saveToString()，于是含 ItemStack 的 Bukkit 配置对象在异步线程被序列化——这直接违反本类 336-341 行自己声明的「序列化留在主线程、只有纯 Files 写入才异步」，异步线程因此会读取主线程仍在使用的 Bukkit/NMS 物品对象。",
          "basis": "调用链：save()/restore() → scheduleSaveToDisk()（454-465）→ runTaskLater(flushToDisk)（464）→ 476 行 buildYaml() 在主线程把 snapshot 的 ItemStack 引用直接放进 YamlConfiguration（354 行 off-hand、521 行背包槽位）→ 478 行 runTaskAsynchronously(writeYaml) → 异步线程在 419 行取 writeLock → 422 行 saveToString() 触发 ItemStack.serialize()/getItemMeta() 读取 NMS 对象。同文件 339-341 行 javadoc 明写序列化必须留主线程，代码与契约相反；writeLock 只提供互斥，不能把异步线程变成主线程，也不能保证 ItemStack 读取安全。",
          "alternatives": [
            "如果这些 ItemStack 在异步序列化期间不可能被任何线程修改（快照已被 clearInventory 从背包摘除，且 restore() 的 setContents 在目标服务端做深拷贝），则不会有撕裂，只剩非主线程访问 Bukkit 对象的契约违反——需在目标 Paper 1.21.x 上核实 CraftInventory#setContents 是否复制 ItemStack，见 src/main/java/com/hilltopvillage/core/PlayerGoodsManager.java:190-196。",
            "如果目标服务端的 YamlConfiguration.saveToString() 与 ItemStack.serialize() 实际是纯只读且没有主线程断言，则不会抛异常，影响降级为潜在风险——需在目标版本实测一次异步 saveToString 并比对输出，见 src/main/java/com/hilltopvillage/core/PlayerGoodsManager.java:422。",
            "如果该服务端的 runTaskAsynchronously 实际同步执行（测试 harness 或替代调度器），则线程边界不存在——需检查服务端 Scheduler 实现，见 src/main/java/com/hilltopvillage/core/PlayerGoodsManager.java:478。"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "F-slice-15-concurrency-02",
        "severity": "MEDIUM",
        "dimension": "concurrency",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/HilltopVillagePlugin.java",
          "line": 563,
          "quote": "playerGoodsManager.saveNow();"
        },
        "inference": {
          "claim": "PlayerQuitEvent（主线程）每次玩家退出都调用 saveNow() → writeYaml() 同步取 writeLock，而异步写线程在 419-423 行持有同一把锁执行整份 YAML 的 saveToString()、并在 429 行锁内做 Files.move；因此主线程在退出事件现场可能被一次完整序列化加一次磁盘 rename 阻塞，异步化收益被这把锁抵消，表现为 tick 停顿随未归还快照数与物品总量增长。",
          "basis": "调用链：HilltopVillagePlugin.onPlayerQuit（548）→ 563 saveNow() → PlayerGoodsManager 498-503 saveNow → 502 writeYaml(buildYaml(), nextWriteSeq()) → 419 synchronized(writeLock)。异步侧：478 runTaskAsynchronously → writeYaml → 419 取同一 writeLock → 422 锁内 saveToString()（遍历 goods 全部快照）→ 425-429 再取锁并 Files.move。两段临界区共用同一 monitor，主线程必须等异步侧序列化完成；onDisable 的 334 行同样会走到这条同步写。",
          "alternatives": [
            "如果未归还快照数量很小（通常少于 10 名玩家），一次 saveToString() 只有毫秒级，tick 不受可见影响——需按实际 pendingUuids().size() 与物品总量评估，见 src/main/java/com/hilltopvillage/core/PlayerGoodsManager.java:228。",
            "如果服务端把 PlayerQuitEvent 放到异步线程（部分 fork 或代理实现），saveNow() 就不在 tick 线程，主线程阻塞不成立——需确认目标服务端的退出事件线程模型，见 src/main/java/com/hilltopvillage/HilltopVillagePlugin.java:548。",
            "如果 419-423 的锁范围不含 saveToString()（例如只看 424 行之后的写文件段），主线程等待上限就只剩一次 rename——需复核 src/main/java/com/hilltopvillage/core/PlayerGoodsManager.java:419-423 的锁边界。"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "F-slice-15-concurrency-03",
        "severity": "LOW",
        "dimension": "concurrency",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/core/GameManager.java",
          "line": 478,
          "quote": "long elapsedSeconds = (System.currentTimeMillis() - waveStartMillis) / 1000L;"
        },
        "inference": {
          "claim": "波次超时保险用不可单调的挂钟计算已持续时间：330 行记起点、478 行求差、479/487 行据此决定传送高亮或强清残怪；系统时钟回拨会让 elapsedSeconds 变小甚至为负，本应打破软锁的保险被推迟或永不触发，时钟前跳则会提前清掉仍在场的残怪。",
          "basis": "330 行 waveStartMillis = System.currentTimeMillis()，478 行用同一挂钟求 elapsedSeconds，479 行与 487 行据此分支；同一段逻辑的驱动是 tick 任务（340-345 runTaskTimer 每 60 tick），改用 tick 计数即可获得单调性。476 行 timeoutSeconds <= 0 直接 return，说明该保险默认禁用，影响面限于显式启用 wave-timeout-seconds 的服务器。",
          "alternatives": [
            "如果实际配置未启用 wave-timeout-seconds（默认 0），该路径根本不执行，问题不成立——需检查部署的 game-settings.yml，见 src/main/java/com/hilltopvillage/core/GameManager.java:476。",
            "如果宿主时钟稳定、无 NTP 步进与手动校时，挂钟与单调时钟的差异可忽略——需确认部署环境的时间同步策略，见 src/main/java/com/hilltopvillage/core/GameManager.java:478。",
            "如果服务器严重卡顿，tick 计数同样会滞后——但 tick 不会倒退，回拨场景仍然只有挂钟会失效，见 src/main/java/com/hilltopvillage/core/GameManager.java:330。"
          ]
        },
        "status": "CONFIRMED"
      }
    ],
    "searched_scope": {
      "files_read": [
        "src/main/java/com/hilltopvillage/core/GameManager.java",
        "src/main/java/com/hilltopvillage/core/GameState.java",
        "src/main/java/com/hilltopvillage/HilltopVillagePlugin.java",
        "src/main/java/com/hilltopvillage/core/PlayerData.java",
        "src/main/java/com/hilltopvillage/core/PlayerGoodsManager.java"
      ],
      "files_in_slice": 5,
      "shared_dependencies_read": [],
      "files_scanned_without_findings": [
        "src/main/java/com/hilltopvillage/core/GameState.java",
        "src/main/java/com/hilltopvillage/core/PlayerData.java"
      ],
      "unreadable_files": [],
      "dimension_checklist": [
        {
          "pattern": "1 返回值暴露内部状态",
          "result": "未命中",
          "note": "getPlayers() 返回 unmodifiableSet；getSpawnPoints() 返回拷贝；getMobSpawnPointsView() 为只读视图且底层列表整体替换；pendingUuids() 返回 keySet 拷贝"
        },
        {
          "pattern": "2 同族函数守卫一致性",
          "result": "未命中",
          "note": "并发守卫（任务取消/句柄置空）在 endGame/stopGame/haltGame 中一致；三者的职责差异属 data-consistency/contract，已写入 off_dimension_notes"
        },
        {
          "pattern": "3 数值边界",
          "result": "不适用",
          "note": "本维度不评数值边界；计时相关的边界见 F-slice-15-concurrency-03"
        },
        {
          "pattern": "4a 原型链/裸下标",
          "result": "不适用",
          "note": "本切片无外部字符串键查表；YAML 键为 UUID 与整数槽位"
        },
        {
          "pattern": "4b 假值 vs 缺值",
          "result": "未命中",
          "note": "readItems/readEffect 的缺键默认值只影响读盘内容，不涉及并发语义"
        },
        {
          "pattern": "4c NaN/Infinity/小数",
          "result": "未命中",
          "note": "本切片没有跨线程传入的数值输入"
        },
        {
          "pattern": "4d 嵌套结构校验",
          "result": "未命中",
          "note": "YAML 仅在 onEnable 的主线程一次性加载"
        },
        {
          "pattern": "5 能力是否真实现",
          "result": "命中",
          "note": "类注释声称序列化留在主线程，实现把 YamlConfiguration.saveToString() 放进异步线程（F-01）"
        },
        {
          "pattern": "6 转义/编码顺序",
          "result": "不适用",
          "note": "本切片无多层替换或转义逻辑"
        },
        {
          "pattern": "7 边界符号（负数/下标）",
          "result": "不适用",
          "note": "没有下标运算参与并发判断"
        },
        {
          "pattern": "8 引用绑定是否存在",
          "result": "未命中",
          "note": "writeLock/writeSeq/nextWriteSeq/saveScheduled/pendingSaveTask 均有定义与引用，无缺失导入或拼写差集"
        },
        {
          "pattern": "C1 异步体调用 Bukkit 世界/配置 API",
          "result": "命中",
          "note": "478 行把 writeYaml 交给异步线程，422 行在异步线程执行含 ItemStack 的 saveToString()（F-01）"
        },
        {
          "pattern": "C2 异步线程读写普通 HashMap/ArrayList/HashSet",
          "result": "未命中",
          "note": "goods 为 ConcurrentHashMap；Snapshot 的 ArrayList 只在主线程 buildYaml 内读取；异步线程只碰已构建的 YAML 及其引用的 ItemStack"
        },
        {
          "pattern": "C3 任务取消/BukkitTask 泄漏/关服后回调",
          "result": "未命中",
          "note": "pendingSaveTask 由 cancelScheduledSave 取消且 onDisable 调用 saveNow；waveCheckTask/waveSchedulerTask 在各终止路径 cancel 并置空；flushToDisk 在 !isEnabled() 时改同步写"
        },
        {
          "pattern": "C4 跨 tick 计时（挂钟 vs tick）",
          "result": "命中",
          "note": "waveStartMillis 与 elapsedSeconds 均用 System.currentTimeMillis()，而同段逻辑的驱动是 tick 任务（F-03）"
        },
        {
          "pattern": "C5 非原子 ++/--/复合状态",
          "result": "未命中",
          "note": "writeSeq 为 AtomicLong；PlayerData 的 int 计数器只在主线程事件与调度回调内累加"
        },
        {
          "pattern": "C6 锁范围与主线程阻塞",
          "result": "命中",
          "note": "writeLock 同时覆盖异步 saveToString() 与主线程 saveNow()，锁内还有 Files.move（F-02）"
        }
      ]
    },
    "self_checks": {
      "identifier_reconcile": {
        "status": "DONE",
        "note": "对账 writeLock/writeSeq/nextWriteSeq/saveScheduled/pendingSaveTask/goods/settlementPhase 的定义与全部消费点，无拼写或绑定差集；settlementPhase 的 volatile 属过度同步而非缺陷"
      },
      "self_check_audit": {
        "status": "NOT_APPLICABLE",
        "note": "仓库无 check-*/verify-* 自检脚本与 src/test 测试（只有 build.sh 与 .work/fix-critical/gen-messages-legacy.mjs），没有历史 PASS 结论可采信；改用序号协议的静态交错推演作替代（见正文 6.4）"
      },
      "runtime_validation": {
        "status": "SKIPPED",
        "note": "任务书禁止跑 maven/gradle（会写 target/，破坏零写入），且本机无 Paper 服务端可加载插件；异步序列化撕裂与 tick 停顿无法在此环境复现"
      }
    },
    "off_dimension_notes": [
      "L1（data-consistency）：GameManager.endGame(boolean) 无已结束/结算中守卫，onGameEndCallback 可能被重复执行（GameManager.java:651-653）。作为并发缺陷判 REFUTED——全部调用点（741、503、306）都在 Bukkit 主线程，单线程串行不构成竞态；作为数据一致性线索原样转交。",
      "L2（data-consistency）：removeOfflinePlayer 在 haltGame 后的结算窗口内仍会走 endGame(false) 覆盖已定胜负（GameManager.java:740），未查 isSettlementPhase()；同为主线程状态守卫问题，转交。",
      "L3（contract）：stopGame() 不复位结算回调、不落库，与 endGame() 的收尾职责不对称（GameManager.java:656-669）；属契约口径问题，转交。",
      "L5（data-consistency）：writeYaml 的 catch (IOException) 只记日志、无重试与回传（PlayerGoodsManager.java:431-433），写失败时内存已删快照、磁盘仍旧内容；属持久化一致性，转交。",
      "L6（error-handling）：onDisable 用单层 try-catch 包住整批 stopAllArenasNow()（HilltopVillagePlugin.java:285-289），单场 RuntimeException 会跳过其余场次；属异常隔离，转交。",
      "切片外同类模式（不在本片结论内）：StatsManager.java:640 使用 runTaskTimerAsynchronously、673 使用 runTaskAsynchronously 写盘，其序列化边界是否与本片 F-01 同形需另一片确认；本回合未读该文件，不据此推断。",
      "GameManager.settlementPhase 声明为 volatile，但本回合读到的全部读写点（57/269/575/631/658/703/837）都在主线程调度或事件路径，属过度同步；未立条。",
      "PlayerData 的 int 计数器与 boolean 标志位均非 volatile/Atomic，但全部写入点在主线程事件与调度回调内（如 HilltopVillagePlugin.java:468-470），未发现跨线程写；未立条。",
      "PlayerGoodsManager 在关服期间若仍有在途异步写，可能残留 .tmp 文件（writeYaml 的 finally 只在异常路径清理）；属清理/磁盘卫生问题，不是并发缺陷，未立条。"
    ]
  },
  "error": null
}
```
