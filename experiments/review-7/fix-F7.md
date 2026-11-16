# fix-F7：javadoc 假不变量 / 降级路径未被测试 / 并发写无处理

**结论：三个缺陷已修，全绿。** 最终 `930 tests / 0 failures / 1 skipped`（基线 905+，本任务新增 5 条，
其余增量来自同一工作树上的其他会话）。

改动范围严格限于：

- `src/main/java/com/hilltopvillage/doc/CommandsDocumentGenerator.java`
- `src/test/java/com/hilltopvillage/doc/CommandsDocumentFallbackTest.java`（新增，5 条）
- `src/test/java/com/hilltopvillage/doc/CommandsDocumentConcurrencyTest.java`（新增，2 条）
- `src/test/java/com/hilltopvillage/doc/CommandsDocumentAtomicWriteTest.java`（新增 1 条守卫）

未 `git add` / `git commit`。

---

## 0. 修复前的现场核实（不是照抄评审结论）

评审给的 JDK 行号我逐条对过本机 JDK 21.0.10 的 `src.zip`
（`java.base/sun/nio/fs/WindowsFileCopy.java`），结论成立：

```
// 非原子分支，target 存在时
if (targetAttrs != null) {
    if (targetAttrs.isDirectory() || ...) RemoveDirectory(targetPath);
    else                                  DeleteFile(targetPath);      // ← 旧目标先被删
}
try { MoveFileEx(sourcePath, targetPath, 0); return; }                 // ← 之后才改名
catch (WindowsException x) { if (x.lastError() != ERROR_NOT_SAME_DEVICE) x.rethrowAsIOException(...); }
```

所以「ATOMIC_MOVE 失败 → 非原子 `Files.move` 失败」这条链上，**旧 `commands.md` 在失败点之前已被删除**。
原 javadoc 第 456 行那句「任何失败都保留旧目标」在降级路径上确为假。

`moveIntoPlace` 修复前在整个测试树里**零次执行**也核实了：
`CommandsDocumentAtomicWriteTest` 注入的 `MoveStep` 在 `Files.deleteIfExists` 之外抛出，
`moveIntoPlace` 从未被触达（用 `javap` 对照后确认修复前 `private static void moveIntoPlace(Path,Path)` 无任何调用方）。

---

## 1. 缺陷 1：javadoc 假不变量 —— 选 (b)「删掉假承诺 + WARNING」，但加了条件

### 选择：(b)，理由三条

1. **评审的前提成立**：临时文件用 `Files.createTempFile(parent, ...)` 创建在与目标同目录，
   同目录不可能跨卷，因此本地 NTFS / ext4 / APFS 上降级分支不可达。为一个不可达路径写
   「备份旧目标 → 失败则还原」是过度设计。
2. **(a) 在原理上做不到它承诺的事**：在不支持原子替换的文件系统上，还原动作本身也只能靠
   非原子写（先删再改），那个窗口关不掉。做完 (a) 之后 javadoc 依然只能写「大概率保留旧目标」，
   复杂度换来的是一条同样不硬的不变量 —— 典型的用代码掩盖问题。
3. **代价可接受**：`commands.md` 是每次启动重新生成的可再生产物，丢失的代价是「某次启动没文档」，
   不是数据损失。真正有价值的是**让运维知道这条路径发生过**，而不是假装它安全。

### 但 (b) 不能只是「改注释」—— 否则等于把缺陷写进文档

所以 (b) 落地为三件事：

1. javadoc 重写成**保证边界**结构：主路径（`ATOMIC_MOVE` 成功）确实不会留半截文档；
   降级路径明确写「非原子、Windows 上先 `DeleteFile(target)` 再改名、失败时旧文档已没了」，
   并点名 JDK 源码位置。删掉「任何失败都保留旧目标」。
2. **降级必须记一条 WARNING**（原任务书的 (b) 也要求这条）：点名 `ATOMIC_MOVE` 不受支持 +
   说明 Windows 上会先删旧文件 + 附带根因。
3. javadoc 里写清「为什么不做还原」，避免下一个人重新加回一段假安全网。

### 顺手补了一个坑（评审没提，但同属这条不变量）

两参数的 `writeAtomically(Path, byte[])` 我最初写的是 `message -> { }`，即**在这条入口上降级完全无声**，
直接违反刚写下的「降级必记 WARNING」。已改成退回 `Logger.getLogger(...)` 记类名 logger，
并加了一条源码守卫钉住（`CommandsDocumentAtomicWriteTest#twoArgOverloadDoesNotSwallowTheFallbackWarning`）。

### ⚠️ 一处需要你知情的非预期改动（本次唯一超出「三缺陷」的改动）

`finally` 里清理临时文件失败时，原代码调用 `tmp.toFile().deleteOnExit()`。我在读 JDK 源码时确认
`DeleteOnExitHook.add()` 是 `synchronized` 的、且会触发类初始化 —— 在一个已经处在锁内的
清理失败路径上再去拿另一把锁、并注册一个「JVM 退出才生效」的删除，收益极低而风险是新的锁交互。
已改为记 WARNING、不注册 `deleteOnExit`。**这改变了「清理失败后的兜底行为」**。
如果你认为这超出 F7 范围，回退只需把那一行改回 `tmp.toFile().deleteOnExit();`，
其余修复不依赖它。

---

## 2. 缺陷 2：让降级路径真的被测试（本任务的重点）

### 测法：把「原子移动」这一步抽成接缝，**只注入触发条件，不注入被测逻辑**

```java
static void moveIntoPlace(Path source, Path target, AtomicMover atomicMove,
        Consumer<String> warningSink) throws IOException {
    try {
        atomicMove.move(source, target);                       // ← 注入物（只负责抛异常）
    } catch (AtomicMoveNotSupportedException fallback) {
        warningSink.accept("... does not support ATOMIC_MOVE ...");   // ← 生产代码
        Files.move(source, target, StandardCopyOption.REPLACE_EXISTING); // ← 生产代码，真实文件系统
    }
}
```

- **注入物（桩）只有一个动作**：抛 `AtomicMoveNotSupportedException`。它的唯一职责是把控制流
  推进 `catch` 分支。
- **`catch` 分支里的每一行都是生产代码**，在真实文件系统上执行：真实的字符串、真实的
  `Files.move`、真实的异常上抛、真实的 WARNING 投递。
- 关键区别：旧测试替换的是 **`MoveStep` 整个移动步骤**（异常在任何文件被操作前抛出，
  `moveIntoPlace` 根本不参与）；新测试替换的是 **`AtomicMover`，即 `moveIntoPlace` 内部的第一步**，
  `moveIntoPlace` 本身必须在调用栈上。

**为什么必须这样**：真实的 `AtomicMoveNotSupportedException` 要求「同目录但文件系统不支持原子
rename」。同目录 ⇒ 本地文件系统上不可达，构造不出来。所以只能注入触发条件；但只要被测逻辑
是真代码，结论就是关于生产的，不是关于桩的。

### 5 条测试，全部断言生产行为

| 测试 | 断言的生产行为 |
|---|---|
| `atomicMoveRejectionRunsTheRealNonAtomicFallback` | 降级分支**真的搬了文件**（目标内容变成新的、暂存文件消失）、并记了 1 条点名 `ATOMIC_MOVE` 的 WARNING |
| `failingFallbackPropagatesAndDoesNotSwallowTheError` | 降级移动自身失败时 `IOException` 原样上抛（不被吞），且**降级 WARNING 仍已记录**，目标侧内容不被破坏 |
| `otherIoExceptionsDoNotTriggerTheFallback` | 非 `AtomicMoveNotSupportedException` 的 `IOException` **不进入降级**：同一异常实例原样上抛、目标不动、零降级 WARNING |
| `generateReportsTheFallbackToThePluginLogger` | **端到端**：`generate()` 真实调用链走降级时，插件 logger 里出现 `WARNING|...ATOMIC_MOVE...`、无 SEVERE、且文档确实写出 |
| `javadocStopsClaimingTheFalseInvariant` | javadoc 不再含「任何失败都保留旧目标」，且写明了「非原子」「先删除目标 / DeleteFile」「WARNING」 |

第 4 条需要能用「走降级的 mover」构造生成器，因此给 `CommandsDocumentGenerator` 加了一个
**包内可见**构造器 `(JavaPlugin, AtomicMover)`；公开构造器行为不变（恒用 `atomicMove`）。

### 证明这些测试不是「测桩」：三条变异探针

1. **把 `catch` 分支里的 `Files.move` 注释掉**（即降级只打日志、不搬文件）
   → `atomicMoveRejectionRunsTheRealNonAtomicFallback` 与
   `failingFallbackPropagatesAndDoesNotSwallowTheError` 双双 FAIL：
   ```
   expected: <# 新文档 降级分支必须把这份内容真的搬到位。>
    but was: <# 旧文档 ...>
   Expected java.lang.Throwable to be thrown, but nothing was thrown.
   ```
2. **把 `generate()` 的 `logger::warning` 换成 `message -> { }`**
   → `generateReportsTheFallbackToThePluginLogger` FAIL：
   ```
   降级分支必须把 WARNING 打到插件 logger（...）；实际日志：
   [INFO|Command reference generated: ...\commands.md]
   ```
3. **把 `WRITE_LOCK.lock()/unlock()` 删掉** → 并发测试 FAIL，见下节。

若测试断言的是桩，这些变异都不会让它变红。

### 新测试在改代码前的失败信息（真实输出）

改代码前（6 条新用例，6 FAIL）：

```
[ERROR] CommandsDocumentConcurrencyTest.concurrentWritesNeverOverlapInsideTheCriticalSection:127
        观测到 4 个线程同时处在写盘临界区内。writeAtomically 未加锁时，两个线程可以同时
        createTempFile + move，在非原子降级路径（先删目标再改名）上这会真的丢文件；
        主路径上也表现为后移动者的写入静默覆盖先移动者 ==> expected: <1> but was: <4>
[ERROR] CommandsDocumentConcurrencyTest.writeAtomicallyIsGuardedByALock:141
        CommandsDocumentGenerator 里没有任何 synchronized / Lock ==> expected: <true> but was: <false>
[ERROR] CommandsDocumentFallbackTest.atomicMoveRejectionRunsTheRealNonAtomicFallback:65
        CommandsDocumentGenerator 缺少可单独调用的 moveIntoPlace(Path, Path, AtomicMover, Consumer)：
        降级分支必须成为可被真实执行的生产代码（缺陷 2：现有测试只替换整个 MoveStep 接缝，
        moveIntoPlace 从未被执行过） ==> expected: not <null>
[ERROR] CommandsDocumentFallbackTest.failingFallbackPropagatesAndDoesNotSwallowTheError:97
        降级失败必须以 IOException 形式上抛 ==> expected: <true> but was: <false>
[ERROR] CommandsDocumentFallbackTest.javadocStopsClaimingTheFalseInvariant:148
        javadoc 仍在承诺「任何失败都保留旧目标」—— 这在降级路径上是假的 ==> expected: <false> but was: <true>
[ERROR] CommandsDocumentFallbackTest.otherIoExceptionsDoNotTriggerTheFallback:132
        必须是同一个异常实例原样上抛 ==> expected: <IOException: 注入的普通 IO 失败> but was: <AssertionFailedError: ...>
[ERROR] Tests run: 6, Failures: 6, Errors: 0, Skipped: 0
```

（`generateReportsTheFallbackToThePluginLogger` 与两参数重载守卫是修复过程中补的，
它们在「加锁/加降级分支」之前无对应代码可测，因此不在上面这轮 6 条里；
它们各自的「去掉实现即变红」证据是上面两条变异探针。）

---

## 3. 缺陷 3：并发写 —— 选 (a) 加锁

### 先读调用点（任务书要求）

`grep` 全 `src/main`：`CommandsDocumentGenerator` **只有一个生产调用点** ——
`HilltopVillagePlugin.java:214` 的 `onEnable()` 里 `new CommandsDocumentGenerator(this).generate();`
（`plugin.yml` 里没有任何命令映射到它，命令触发路径不存在）。

**按任务书的判据，(b) 也够。但我仍选 (a)，理由是「调用点的现状」不等于「API 的契约」**：

- `generate()` 是 `public`，且第 2 节我给它加了一个包内构造器 —— 它已经是一个可被多人/多处调用
  的工具方法了，靠「目前只有一个调用点」来保证正确性是脆弱的；
- 锁的成本是**一次无竞争的 `ReentrantLock` 加解锁**，写入本来就在异步线程、且每次启动一次，完全无所谓；
- 更重要的是：**未加锁的后果是静默的**（后移动者覆盖先移动者，日志一片正常）。这类缺陷的
  预防成本远低于事后排查成本。

### 实现

`private static final ReentrantLock WRITE_LOCK`，锁覆盖**整段**临界区：
建父目录 → `createTempFile` → 写满内容 → 移动 → `finally` 清理，而不只是 `move` 那一行
（只锁 `move` 无法阻止两个线程各建一个临时文件并把 `move` 交错）。

### 并发测试为什么不是「随便写的」

刻意**没有**用「并发写完之后校验文件内容」的测法 —— 单文件替换在 Windows/POSIX 上都是一次 rename，
内容永远是某一份完整文档，那个断言**在修复前也会通过**，只会给出「并发没问题」的假结论。
可观测的真实差异是**临界区重叠**：注入的 `MoveStep` 把移动拉长到 80ms，4 个线程同时起跑，
统计「同时处在临界区内的线程数」的最大值。

修复前：`max = 4`（FAIL）。修复后：`max = 1`（PASS）。
删掉锁重跑：又回到 `max = 4`（FAIL）—— 这条变异探针证明该测试咬的是**锁本身**。

---

## 4. 最终测试数

```
[WARNING] Tests run: 930, Failures: 0, Errors: 0, Skipped: 1
[INFO] BUILD SUCCESS
```

doc 模块：`CommandsDocumentAtomicWriteTest 4` + `CommandsDocumentConcurrencyTest 2` +
`CommandsDocumentFallbackTest 5` + `CommandsDocumentGeneratorTest 7` +
`CommandsDocumentationCleanupClaimTest 1` = **19**，全绿。

那 1 条 skip 是基线就存在的（`YamlFilesTest`），与本次改动无关。

**构建命令注意**：本机 `build.cmd` / `build.sh` 的 JDK 21 探测会执行 `java -version`，
而 `JAVA_TOOL_OPTIONS=-Djdk.attach.allowAttachSelf=true` 会让 JVM 在 stdout 先打一行
`Picked up JAVA_TOOL_OPTIONS: ...`，探测脚本取首行解析版本号时因此失败，报「未找到 JDK 21」。
我用等价环境直接调用 Maven 完成验证：

```bash
JAVA_HOME='D:\Java\zulu21.48.17-ca-jdk21.0.10-win_x64' \
PATH="/d/Java/zulu21.48.17-ca-jdk21.0.10-win_x64/bin:$PATH" \
MAVEN_OPTS="-Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8" \
JAVA_TOOL_OPTIONS=-Djdk.attach.allowAttachSelf=true \
/d/maven/apache-maven-3.9.9/bin/mvn.cmd -o test
```

这是构建脚本的既有小毛病（`build.sh` 里 `out="${out%%$'\n'*}"` 之前没有跳过 `Picked up` 行），
不在我可改的范围内，仅告知。

---

## 5. 诚实评估：javadoc 里现在每一条承诺，都有对应测试吗？

逐条列。**「✅」= 有断言生产行为的测试；「⚠️」= 只有源码文本守卫；「❌」= 无测试。**

### `writeAtomically` javadoc

| # | 承诺 | 状态 | 对应测试 |
|---|---|---|---|
| 1 | 不直接 `Files.write` 目标（避免截断写） | ⚠️ | `CommandsDocumentAtomicWriteTest#asyncBlockNoLongerTruncatesTheTargetInPlace`（源码守卫）+ 同类成功路径用例观测到「移动前临时文件已写满、目标仍是旧内容」 |
| 2 | 主路径失败不留半截文档 | ⚠️ | 由 3/4 间接支撑；**没有**直接注入「主路径中途失败」的用例（见下方风险 R1） |
| 3 | 成功后目标 = 完整新内容 | ✅ | `successfulWriteReplacesTargetAndLeavesNoTempFile` |
| 4 | 临时文件与目标同目录 | ✅ | `failedMoveKeepsOldDocumentAndCleansUpTempFile` 断言 `movedFrom.getParent() == target.getParent()` |
| 5 | 临时文件在 `finally` 清理（成功/失败都不残留） | ✅ | `successfulWrite...` + `failedMoveKeeps...` 均断言目录里只剩 `commands.md` |
| 6 | 降级路径是非原子的、Windows 上先删目标、失败则旧文档没了 | ⚠️→✅ | 文本部分是 `javadocStopsClaimingTheFalseInvariant`（守卫）；**行为部分是** `failingFallbackPropagatesAndDoesNotSwallowTheError`（证明降级确实走真实文件系统、失败会抛） |
| 7 | 只有 `AtomicMoveNotSupportedException` 才降级 | ✅ | `otherIoExceptionsDoNotTriggerTheFallback`（同一异常实例原样上抛、零降级 WARNING） |
| 8 | 降级会记一条 WARNING | ✅ | `atomicMoveRejectionRunsTheRealNonAtomicFallback` + **端到端** `generateReportsTheFallbackToThePluginLogger` |
| 9 | 「为什么不做还原」 | — | 设计理由，无需测试 |
| 10 | 对同一 JVM 内的调用是串行的 | ✅ | `concurrentWritesNeverOverlapInsideTheCriticalSection`（`max=1`） |
| 11 | 锁覆盖「建临时文件 → 写满 → 移动 → 清理」整段 | ⚠️ | 行为测试只观测到「移动期间不重叠」；「清理也在锁内」目前**只有代码结构**保证（见风险 R2） |
| 12 | 「清理失败记 WARNING、不再 `deleteOnExit`」 | ❌ | **没有测试**：难以在不 mock 文件系统的前提下制造 `deleteIfExists` 失败（见风险 R3） |

### 类级 javadoc / `generate()`

| # | 承诺 | 状态 | 对应测试 |
|---|---|---|---|
| 13 | 写盘是异步的（不阻塞调用线程） | ✅ | `CommandsDocumentGeneratorTest#generateReturnsWithoutWaitingForTheDiskWrite` |
| 14 | 写盘失败不打挂启动链（只 WARNING，不 SEVERE） | ✅ | `unwritableTargetDoesNotThrow`、`writeFailureIsReportedAsWarning` |
| 15 | 文档内容与 README/`plugin.yml` 同步 | ⚠️ | `documentListsPermissionsAndCoreCommands`、`documentStatesConsoleBlacklist` 只覆盖少量抽查片段，不是全量同步校验 |

### 明确的风险（不掩饰）

- **R1（真缺口）**：没有「主路径 `ATOMIC_MOVE` 中途失败」的用例。与 F7 原缺陷无关（原缺陷是直接
  截断写），但承诺 2 严格说只有间接证据。要补需在 `AtomicMover` 注入一个「移动前抛普通 IOException」
  并断言旧目标完好 —— 那样注入的又是桩，价值有限，故未加。
- **R2**：承诺 11 的「清理在锁内」没有独立断言。若有人把 `deleteIfExists` 挪到 `unlock()` 之后，
  现有测试不会红。
- **R3**：承诺 12 完全无测试。`deleteIfExists` 失败需要文件系统层面的干预（Windows 上可用
  「临时文件被另一进程独占打开」构造，但跨平台不稳定），我选择不写一条会在别的机器上偶发红的用例，
  而是把这条降级写成 WARNING 让它在生产里可观测。
- **R4**：承诺 5 里「`createDirectories` 失败」分支无独立用例（由 `unwritableTargetDoesNotThrow`
  的目录占位路径部分覆盖）。

### 一句话总结

**三个缺陷的核心承诺现在都有行为级测试，且都能被变异探针证明会变红**：
降级分支真的执行、降级真的记 WARNING（端到端到插件 logger）、并发真的串行化。
剩下的缺口（R1–R4）都不在 F7 的攻击面上，是「更严格也更好」的增量，已在上面逐条标出，
没有用文本守卫冒充行为测试。
