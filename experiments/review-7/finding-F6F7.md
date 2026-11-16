# 红队评审：F6 / F7 两处修复

- 仓库：`<TARGET_REPO>`
- 被审文件：`src/main/java/com/hilltopvillage/doc/CommandsDocumentGenerator.java`（未提交 diff）
- 评审方式：只读。额外在 `/tmp` 下做了两组 JDK 行为探针（**未写入仓库**），用于验证 `ATOMIC_MOVE` 语义与并发写行为。

---

## F6 — 删除 `/hilltop tps` 文档中的「DisplayEntity 清理队列」输出

### 结论：**正确**（但修复不彻底，且测试偏弱）

### 攻击点验证

**1）那句被删的描述确实不存在 —— 而且能定位到它「何时变成谎话」**

当前文档（`CommandsDocumentGenerator.java:193`，逐字）：

```java
md.append("- **注意事项**: 输出服务器与对局双层级诊断信息（TPS/MSPT、内存、在线/对局玩家、波次、怪物、节点、各世界实体/区块计数）。MSPT 超过 50ms 时附排查建议。\n\n");
```

真实输出（`src/main/java/com/hilltopvillage/diagnostic/TpsDiagnostic.java:46-105`）逐项核对：

| 文档声称 | 实现 | 结论 |
|---|---|---|
| TPS/MSPT | `:52-54` `tps.values` / `tps.mspt` | ✅ |
| 内存 | `:96-99` `tps.memory` | ✅ |
| 在线/对局玩家 | `:60-61` `tps.online-players` / `tps.game-players` | ✅ |
| 波次 | `:62` `tps.wave` | ✅ |
| 怪物 | `:63` `tps.mobs` | ✅ |
| 节点 | `:64-65` `tps.nodes` | ✅ |
| 各世界实体/区块计数 | `:70-94` `tps.world-line`（实体/区块/方块实体） | ✅ |
| MSPT>50 附建议 | `:101-105` | ✅ |
| ~~DisplayEntity 清理队列~~ | **不存在** | 删除正确 |

`printDiagnostic` 全 106 行内**没有任何** `DisplayEntity` 调用，`grep -rn "getPendingCleanupCount\|cleanupQueue"` 在 `src/main/java` 与 `src/test/java` **零命中**。

「它其实存在但代码路径不同」这个假设可以排除——但有一条更值得记的证据链：它**曾经真的存在**，是 fix6 把代码删了、没同步文档。

```
$ git show 9aadf31^:.../TpsDiagnostic.java
64:            sender.sendMessage(msg(sender, "tps.cleanup-queue",
65:                    gameManager.getDisplayEntityManager().getPendingCleanupCount()));
```

而 `9aadf31`（fix6 Y4 死代码清扫）删掉了这条链，`DisplayEntityManager.java:9-10` 的类注释写得很明确：

```java
 * <p>fix6 Y4-A2：原类中的锤击巨物展示与 DisplayEntity 清理队列整链为零调用死代码，
 * 已随本轮删除；类语义收窄为纯粒子工具，不再持有插件引用。</p>
```

**结论：删对了地方、也删对了原因。** 这不是「原因错、动作对」的运气，而是 fix6 的文档滞后。

**2）更硬的旁证：消息键成了孤儿**

`src/main/resources/messages-legacy.yml:1964`（en）与 `:4047`（zh）仍留着 `tps.cleanup-queue`，但 Java 侧已无人引用。这反证「输出项已删、文案未清」。这属于 F6 的漏网（见下）。

**3）「还有没有别的描述不存在」—— 有，而且比原目标更严重**

F6 只删了一句就收工，但文档里至少还有三处与实现不符：

**(a) `/hilltop help` 的权限与「管理员专用」是假的 —— 这是本次评审在 F6 范围内发现的最严重遗留**

`CommandsDocumentGenerator.java:128-133`：

```java
md.append("### `/hilltop help`\n\n");
md.append("- **功能**: 查看命令帮助。\n");
md.append("- **权限**: `hilltopvillage.admin`\n");
...
md.append("- **注意事项**: 管理员专用，显示所有可用命令及简要说明。\n\n");
```

实现（`HilltopCommandHandler.java:374-378`）：

```java
case "help":
    // fix6 Y3-R07-08：撤掉 admin 门——sendUsage 内部按权限裁剪（玩家看不到管理段），
    // 与无参 / default 路径行为对齐（正确入口不应被锁、错误入口反而畅通）。
    deployMenuSender.sendUsage(sender);
    break;
```

无任何权限判断；`DeployMenuSender.java:32-45` 的玩家段**无条件发送**，只有 `:48` 的管理段才 `hasPermission` 分档。README 也已更新为「所有玩家可用」：

```
README.md:573:| `/hilltop help` | 查看命令帮助（所有玩家可用；内容按权限分档） | ✅ |
```

也就是说：**代码、README 都是新口径，只有自动生成的 commands.md 还在告诉玩家「你没权限」。** 这正是 F6 声称要消灭的那类缺陷（管理员/玩家据文档得到错误结果），F6 却没扫到。git 证据：该段自 `3fd65c9` 原样带入，`fix6` 改代码时未同步。

**(b) `/hilltop lobby` 的「4 格内」是错的（实现是 2 格）**

`CommandsDocumentGenerator.java:66`（逐字节选）：「已站在大厅出生点附近（**4 格内**）时不重复传送」

实现 `HilltopCommandHandler.java:1308`：`player.getLocation().distanceSquared(lobbySpawn) <= 4.0`

`distanceSquared` 与常量 4.0 比较 = 距离 ≤ **2.0** 格。而且实现自己的注释（`:1301`）写的是「2 格内」。文档把「平方距离阈值」当成了「格数」，差 2 倍。

**(c) `/hilltop deploy showparticles` 的「五类点位各有专属颜色」与同一份文档自相矛盾**

`CommandsDocumentGenerator.java:238` 说「在所有玩家出生点周围展示粒子」，`:242` 又说「五类点位各有专属颜色（玩家出生点=绿、怪物刷怪点=红、能量节点=蓝、村民=黄、商店=金）」。

实现只有一套数据源（`AdminDeployManager.java:92-94`）：

```java
public void showSpawnPointParticles(Player viewer, LanguageManager lang, long durationTicks) {
    showPointParticles(viewer, savedSpawnPoints, PointKind.SPAWN, lang, durationTicks);
}
```

只有 `PointKind.SPAWN`。而文档自己的「注意事项 5」（`:436`）又写对了：「仅展示当前已设置的**玩家出生点**对应粒子」。同一份文档里两条规则互相打脸——这比单纯写错更容易误导：管理员会以为一条命令能看到五类点位。

**(d) 次要**：`/hilltop config nodes repairitem`（`:409-414`）只说「必须为有效的 Minecraft 材料枚举名」，漏了实现的 `mat.isItem()` 约束（`HilltopCommandHandler.java:616`）——`WATER`/`LAVA` 是合法材料名但会被拒。这是「不充分」而非「虚假」，优先级低。

**4）F6 的测试为什么挡不住上面这些**

`src/test/java/com/hilltopvillage/doc/CommandsDocumentationCleanupClaimTest.java:38-43` 只有两条断言：

```java
assertTrue(content.contains("### `/hilltop tps`"), ...);
assertFalse(content.contains("DisplayEntity 清理队列"), ...);
```

问题有三：
- **只否定、不列举**：它锁死的是「不许出现这一个字符串」，对 help 权限、4 格、五色粒子这类错误零覆盖。F6 的缺陷类别是「文档与实现脱节」，测试却只测了一个实例。
- **前置条件可能造成假通过**：`awaitDocument`（`:47-62`）用「长度连续 3 次采样稳定」判定写完。在**修复前**的截断写路径下，一份写到一半、恰好包含 `### /hilltop tps` 但尚未写到「DisplayEntity 清理队列」那一行的文件，会让 `assertFalse` 通过——也就是说这条测试在缺陷代码上存在时序性假绿窗口。修复后（原子写）这个窗口才真正消失。
- 断言的是**生成物**（好），但没有任何断言校验「文档输出项集合 == `printDiagnostic` 实际输出项集合」这种结构性契约，所以下一个 fix6 式的删代码仍会静默失配。

### 最严重的问题

**F6 修对了它瞄准的那一句，但同一类缺陷（文档承诺了实现里没有的东西）在 `/hilltop help` 上原样存活，且更严重**：文档写「权限 `hilltopvillage.admin` / 管理员专用」，代码早已对全体玩家开放，README 也已改口径。玩家照文档会放弃使用这条命令。F6 的「一句话删除」不构成对缺陷**类别**的处置。

---

## F7 — `commands.md` 改为临时文件 + `ATOMIC_MOVE`

### 结论：**有缺陷**（主路径确实修好了截断写；但 javadoc 的核心不变量在自己的降级路径上是假的，另有权限回归与无 fsync 的残留）

### 攻击点验证

#### 1）`ATOMIC_MOVE` 在同一目录内是否保证原子 —— 是，探针实证

`writeAtomically` 全文（`CommandsDocumentGenerator.java:459-490`）：

```java
static void writeAtomically(Path target, byte[] content) throws IOException {
    writeAtomically(target, content, CommandsDocumentGenerator::moveIntoPlace);
}

static void writeAtomically(Path target, byte[] content, MoveStep moveStep) throws IOException {
    Path absoluteTarget = target.toAbsolutePath();
    Path parent = absoluteTarget.getParent();
    if (parent != null && !Files.isDirectory(parent)) {
        Files.createDirectories(parent);
    }
    Path tmp = Files.createTempFile(parent, absoluteTarget.getFileName() + ".", ".tmp");
    try {
        Files.write(tmp, content);
        moveStep.move(tmp, absoluteTarget);
    } finally {
        try {
            Files.deleteIfExists(tmp);
        } catch (IOException cleanupFailure) {
            tmp.toFile().deleteOnExit();
        }
    }
}

private static void moveIntoPlace(Path source, Path target) throws IOException {
    try {
        Files.move(source, target,
                StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
    } catch (AtomicMoveNotSupportedException fallback) {
        Files.move(source, target, StandardCopyOption.REPLACE_EXISTING);
    }
}
```

同目录 ⇒ 同卷 ⇒ 不触发跨设备。Windows 上 `ATOMIC_MOVE` 走 `MoveFileEx(..., MOVEFILE_REPLACE_EXISTING)`（JDK `WindowsFileCopy.move`，atomic 分支），POSIX 上是 `rename(2)` 语义。实测（JDK 17.0.20.1 / Windows）：

```
[1] atomic over existing: OK target=NEW tmpExists=false
```

覆盖已有目标成功，临时文件消失。**这一层成立。**

#### 2）`finally` 清理会不会在成功路径抛异常并掩盖结果 —— 不会

`Files.deleteIfExists` 对「移动后已不存在的临时文件」返回 `false`，不抛：

```
[2] deleteIfExists on moved-away tmp = false
```

而且即便抛 `IOException`，`:477-479` 也吞掉并转 `deleteOnExit()`，不会覆盖 `moveStep.move` 的成功返回。**这个攻击点不成立，写法是对的。**（唯一残留：`deleteOnExit()` 在服务器长驻进程里会累积 JVM shutdown hook 列表并可能永久留垃圾文件，但这是失败路径的次要问题。）

#### 3）降级路径：**不完全是「等于没修」，但它把 F7 的核心不变量弄假了**

先给结论，再给证据：

- **POSIX**：降级后的 `Files.move` 仍是同目录 `rename(2)`，天然原子。降级在这里无害。
- **Windows**：降级后的非原子路径是 **先删除目标、再改名**。JDK 源码 `sun/nio/fs/WindowsFileCopy.move` 非原子分支：

```java
152:        // if target exists then delete it.
158:                    DeleteFile(targetPath);
...
399:            MoveFileEx(sourcePath, targetPath, 0);
```

这直接推翻写在 `:456` 的承诺：

> 「临时文件与目标同目录 ⇒ 不会跨分区，`ATOMIC_MOVE` 才能生效。**任何失败都保留旧目标**，临时文件在 `finally` 里清理。」

在 `AtomicMoveNotSupportedException` 之后的第二次 `Files.move` 里，目标**先被删除**；若随后 `MoveFileEx` 失败，`commands.md` **已经没了**——旧文档不保留，读者还会看到一个「文件不存在」的窗口。这句 javadoc 是**假的不变量**，而且是 F7 唯一想卖给运维的保证。

**「降级路径是否等于没修」的准确答案**：不是「等于没修」，而是**「修好的部分在降级路径上被悄悄收回，而测试完全看不见」**。理由：

- 该测试的故障注入点（`CommandsDocumentAtomicWriteTest.java:102-122`）替换的是 `MoveStep` 整个接缝，异常在**删除任何东西之前**抛出。因此 `moveIntoPlace`（真正的生产实现，含降级分支）在全部测试中**一次都没被执行过**。`:151-152` 那条「移动失败后旧文档必须原样保留」证明的是**注入桩的行为**，不是生产代码的行为。
- `:172-174` 的「源码守卫」只断言源码里**出现字符串** `AtomicMoveNotSupportedException`，是文本断言，不是行为断言。

也就是说：**F7 唯一未经测试的代码路径，恰好是唯一会违反 F7 自身不变量的路径。** 这是最该红队打的一点。

补充一个让它更微妙的现实性判断：Windows 上 `ATOMIC_MOVE` 只在 `ERROR_NOT_SAME_DEVICE`（`WindowsFileCopy.java:311`）时抛 `AtomicMoveNotSupportedException`，而同目录不可能跨设备 ⇒ **生产环境（Windows 服务器）里降级分支实际不可达**。所以它不是当下的活跃 bug，而是一枚**「一旦换了 provider / 挂了网络盘 / 用了非默认 FileSystem 就会引爆」**的哑弹，并且注释把它包装成了安全网。

#### 4）并发写：**完全没有处理**

`grep -n "synchronized\|Lock\|concurrent" CommandsDocumentGenerator.java` → **零命中**。两个线程各自 `createTempFile`、各自 `move`，**后 move 者赢，先 move 者的写入被静默覆盖**，日志里连一条 INFO 都没有。

用逐字复刻生产逻辑的探针跑 150 轮双线程：

```
atomicUnsupported=0 accessDenied=11 otherFail=0 tornOrMixed=0 leftoverTmp=0
final=AAAAA
```

三个读数值得记：

1. **`tornOrMixed=0`** —— 原子性目标达成，任何时候读到的都是完整文档。F7 的**卖点是真的**。
2. **`accessDenied=11`（150 轮中 11 次，约 7%）** —— 在 Windows 上争用同一个目标做 `MoveFileEx(REPLACE_EXISTING)` 会**真的失败**，抛的是 `AccessDeniedException` 而**不是** `AtomicMoveNotSupportedException`，所以**不会降级、直接上抛**，最后由 `:444-446` 打成一条 WARNING。即并发下会打出**误导性失败日志**，而另一线程其实已经成功。
3. 无 `tornOrMixed` 但**有内容丢失**：`[5] sequential double-move: final = WRITER_B_WINS (A silently discarded)`。

**当下严重性：低。** 调用链只有一处（`HilltopVillagePlugin.java:211-217`，`onEnable` 内一次），`generate()` 之间不会重叠；`CommandsDocumentGeneratorTest.repeatedGenerationOverwrites` 也是「等第一份落定再发第二次」，不构成并发。**但这是「靠调用者自律」而不是「靠实现保证」**——任何人日后把 `generate()` 挂到 `/hilltop reloadconfig` 或某个定时刷新上，就会立刻踩到「静默丢失 + 误导 WARNING」。成本极低（一个 `static final Object LOCK` 或 `synchronized`）而修复为零。

#### 5）「异步线程」这个前提是否仍然成立 —— 是，未变

`CommandsDocumentGenerator.java:440-447` 原样保留：

```java
Bukkit.getScheduler().runTaskAsynchronously(plugin, () -> {
    try {
        writeAtomically(docFile.toPath(), content.getBytes(StandardCharsets.UTF_8));
        plugin.getLogger().info("Command reference generated: " + docFile.getAbsolutePath());
    } catch (IOException e) {
        plugin.getLogger().warning("Failed to generate the command reference commands.md: " + e.getMessage());
    }
});
```

异步块、异常分级（WARNING 不 SEVERE）、成功/失败日志互斥都保持原样，`CommandsDocumentGeneratorTest.writeFailureIsReportedAsWarning` 仍然有效。**这部分没有被改坏。**

注意一个 F7 引入的新交互：`writeAtomically` 现在会 `Files.createDirectories(parent)`（`:467-469`），而旧代码只在 `getParentFile().exists()` 时 `mkdirs()`。既有测试 `unwritableTargetDoesNotThrow` 用「同名目录占位」构造失败，探针确认该场景抛 `AccessDeniedException`（非 `AtomicMoveNotSupportedException`，不降级），旧目录保留，行为不变：

```
[3] move onto dir THREW java.nio.file.AccessDeniedException atomicNotSupported=false
```

#### 6）两个被忽略的实质缺陷（不在提问清单里，但比降级路径更可能真的咬人）

**(a) POSIX 权限回归：`commands.md` 从 0644 变 0600。** `Files.createTempFile` 在 POSIX 上以 `rw-------` 创建（JDK `TempFileHelper.java:67`），`ATOMIC_MOVE` 保留该属性，所以最终 `commands.md` 的权限是 **0600**，而旧的 `Files.write(docFile.toPath(), ...)` 产出的是按 umask 的常规 0644。若服主用 Web 面板 / 另一个用户（如 nginx、备份脚本 `restic`、面板进程）读这份文档，**升级后会突然 EACCES**。这是 F7 引入的**新回归**，且无任何测试覆盖。修法很简单：`Files.write` 之后 `setPosixFilePermissions(tmp, 0644)`（或按目标已有权限复制），但当前没有。

**(b) 没有 fsync，所以「崩溃会留下空文件」严格说未修完。** `Files.write` 不保证数据落盘，`ATOMIC_MOVE` 只保证**目录项**替换原子。掉电时某些文件系统（ext4 `data=writeback`、部分 SMB/NFS）可能让 rename 先持久化、而临时文件内容仍为 0 字节 —— 于是出现**长度 0 的 commands.md**。要真正覆盖 javadoc 里写的「崩溃」，需要在 `Files.write` 之后对临时文件 `FileChannel.force(true)`（并可选地 force 父目录）。当前代码没有 `force(`，`grep` 零命中。

#### 7）文档生成时机

`generate()` 的唯一调用点（`HilltopVillagePlugin.java:211-217`）：

```java
// Generate documentation
// 纯文档产物：命令文档生成失败绝不能禁用插件（此时全部功能已就绪），只记 warning 继续启动。
try {
    new CommandsDocumentGenerator(this).generate();
} catch (RuntimeException exception) {
    getLogger().log(Level.WARNING, "Failed to generate the command reference (continuing startup)", exception);
}
```

`:214` 是**全仓库唯一**调用点（`grep -rn "CommandsDocumentGenerator"` 除自身与测试外仅此一处）。`/hilltop reloadconfig`（`HilltopCommandHandler.java:396-453`）**不**重新生成文档。

**判定：这是已知限制，不是本次修复引入的缺陷，但文档自我描述需要一个红队注记。** 文档首行自称（`:34`）：

```java
md.append("> 本文档由插件在服务器启动时自动生成/更新。\n");
```

「启动时」是诚实的，所以不算虚假宣传。但它意味着：**服务器运行中改了命令（或换插件版本后没重启）时，`commands.md` 会静默过期**，而容器里的 `/hilltop help` 永远是最新的——两份「权威」会分叉。F6/F7 这类「文档与实现脱节」的缺陷之所以能反复出现（fix5 M-18、fix6 Y4、本次 F6 三连），根因就在这：**文档是硬编码 + 只在启动时写，没有任何一致性闸门**。`CommandsDocumentationCleanupClaimTest` 是人工补的闸，不可扩展。

### 最严重的问题

**F7 把「旧文档在任何失败下都保留」写进了 javadoc，却在自己唯一的降级分支上用 JDK 的「先删目标再改名」非原子移动把这条不变量拆掉了；而全部测试通过注入 `MoveStep` 接缝绕过了 `moveIntoPlace`，所以这条分支从未被执行、也永远不会被这些测试发现。** 换句话说：**F7 的可信度来自测试，而测试没碰真正危险的代码。**

其次是可用于生产的两个实际回归/残留：**POSIX 下 `commands.md` 权限变 0600**（可能直接打断现有读取方）、**无 `force()` 导致掉电仍可能得到 0 字节文档**（即 F7 声称修好的那个场景之一，严格说没修完）。

---

## 附：可疑点专项标注

### ⚠️ 可疑点一：降级路径是否等于没修

**不完全等于，但性质比「等于没修」更糟。**

| 平台 | 降级后行为 | 评价 |
|---|---|---|
| POSIX | 同目录 `rename(2)`，原子 | 无害（此时根本不该抛异常） |
| Windows | `DeleteFile(target)` → `MoveFileEx`（`WindowsFileCopy.java:152-158, 399`） | **销毁旧目标**，并有「文件不存在」窗口 |
| 其他 provider（网络盘/SMB/Jimfs 等） | 取决于实现，可能是 copy+delete | **不可保证**，且是唯一真正会走到这里的情形 |

- 不是「换了个写法没修」——主路径（生产实际唯一走到的路径）确实修好了截断写。
- 但 `:456` 的「**任何失败都保留旧目标**」是假命题，且这条假命题正是 F7 的核心卖点。
- 更关键：这个分支**不可达**（Windows 同目录不会 `ERROR_NOT_SAME_DEVICE`），所以它既是哑弹，又是**注释层面的虚假安全感**。正确做法是：降级时明确记录「已降级为非原子，旧文件可能丢失」，或干脆不降级直接失败（保留旧文件），而不是无声地换成会删目标的写法。

### ⚠️ 可疑点二：并发写如何处理

**零处理。`grep` 无任何锁。**

- 语义：最后 `move` 者赢，另一个写入**静默丢弃**（探针 `[5]` 已复现），仅靠「只有一处调用点」兜住。
- Windows 争用下还会产生 `AccessDeniedException`（150 轮 11 次），直接上抛并打一条**误导性 WARNING**（另一线程其实成功了）。
- 原子性本身达标：`tornOrMixed=0`，读者永远看不到半截文档。**F7 的原始目标在并发下是成立的，丢的是「写入不丢失」这个没人承诺过、但迟早会有人假设的性质。**
- 建议：`private static final Object WRITE_LOCK`，`synchronized (WRITE_LOCK)` 包住 `writeAtomically` 的整个临时文件生命周期。改动 <5 行，零风险。

---

## 建议的最小后续动作（按性价比排序）

1. **修假不变量**：把 `:456` 的「任何失败都保留旧目标」改成事实，或让降级分支在失败时显式 WARN「旧文档已可能丢失」。（1 行注释 + 1 行日志）
2. **补 POSIX 权限**：移动前把临时文件权限对齐目标（或设 0644），消除 0600 回归。（~5 行）
3. **补 `force(true)`**：真正覆盖「崩溃留空文件」。（~3 行）
4. **并发锁**：`synchronized` 包 `writeAtomically`。（~3 行）
5. **修 `/hilltop help` 文档**（F6 遗留，严重度最高但最便宜）：权限改「无（所有玩家可用）」，「管理员专用」删除。（1 行）
6. **修 `/hilltop lobby` 「4 格内」→「2 格内」**；**修 `showparticles` 五色描述**与 `:436` 的矛盾。（2 行）
7. **补一条真·行为测试**：直接调 `writeAtomically(target, bytes)`（非接缝版），断言目标被整份替换、无 `.tmp` 残留、权限未变——让 `moveIntoPlace` 至少被执行一次。
8. `messages-legacy.yml:1964 / :4047` 的孤儿键 `tps.cleanup-queue` 一并清掉，避免下次又被当成「输出存在」的证据。
