# slice-26 深挖审计 · data-consistency

- trace_id: `trace-r1-20260215-hilltop-dsh3`
- round_id: `round1`
- slice_id: `slice-26`
- dimension: `data-consistency`（唯一维度）
- 被审仓库：`D:\Server\MCServers\Server plugin\Hilltop Village\Hilltop Village Plugin`（只读，零写入）
- 读取方式：本回合 `read` 全文读取 6 个切片文件 + 1 个 shared dependency + 1 个调用方 + 2 个自带测试；所有 quote 均来自本回合读取。

## 0. 结论摘要

| 项 | 数 |
|---|---|
| CONFIRMED | 3（HIGH 2 / MEDIUM 1） |
| NO_EVIDENCE_FOUND | 0 |
| 线索处置 | 6 / 6（L1、L2、L3 升级；L4、L5 判不构成本维度并转 off_dimension_notes；L6 判 REFUTED） |
| 被审文件数 | 6（shared dependency 1，控制流调用方 1，自带测试 2） |

三条发现都落在同一个主题上：**这套代码已经把「不覆盖读不出来的文件」写成了机制，但三个写盘出口里有两个绕过了它**——降级移动失败时删掉唯一的临时副本（F-01）、被隔离的 `messages.yml` 在 `reloadconfig` 后仍会被出厂值重建（F-02）、唯一的非 `YamlFiles` 写盘出口用截断式 `saveConfig`（F-03）。

## 1. 线索逐条处置（L1–L6，一条不漏）

| lead | 线索维度 | 处置 | finding_id / 去向 | 处置依据（本回合核实） |
|---|---|---|---|---|
| L1 | data-consistency | **升级 CONFIRMED · HIGH** | `F-slice-26-data-consistency-01` | 降级分支确实去掉 `ATOMIC_MOVE`（`YamlFiles.java:124`），且 `finally` 在 tmp 仍存在时无条件删除（`:126-130`）；失败路径没有第二份副本。 |
| L2 | data-consistency | **升级 CONFIRMED · HIGH** | `F-slice-26-data-consistency-02` | `/hilltop reloadconfig` 确实先 `messagesGate.reset()`（`HilltopCommandHandler.java:408`）再 `reload()`（`:437`）；`YamlFiles.load` 对缺失文件返回 `ABSENT` + `usable()==true`（`:80-81`），`YamlFileGate.load` 对 `ABSENT` 不改 `readOnly`（`:54-60`），于是 `LanguageManager.java:93` 的判据在 reset 后恒为 true，第 4 步用 `!messagesFile.exists()` 触发写回（`:165`）。 |
| L3 | data-consistency | **升级 CONFIRMED · MEDIUM** | `F-slice-26-data-consistency-03` | `set` 与 `saveConfig()` 成对（`LanguageManager.java:306-307`），但 `saveConfig` 走的是 `FileConfiguration.save(File)` 截断式写，且该文件不在任何 `YamlFileGate` 保护范围；入口 `HilltopCommandHandler.java:1745-1747`。 |
| L4 | concurrency | **不构成本维度缺陷 → off_dimension_notes #1** | 不进 findings | 机制是 `writable()` 与 `write()` 之间的 check-then-act、`readOnly` 仅 volatile（`YamlFileGate.java:35/89`），属并发竞态；「两个写者互相覆盖快照」是同一竞态的下游表现，按派发维度归 concurrency。 |
| L5 | error-handling | **不构成本维度缺陷 → off_dimension_notes #2** | 不进 findings | `location.getWorld()` 未判空即 `world.spawnParticle`（`DisplayEntityManager.java:15/23`、`:32/35`），是 NPE/异常路径问题，不是落盘一致性。 |
| L6 | data-consistency | **REFUTED** | 不进 findings | `keyHashesSet` 的 catch 只在「同一路径既是字符串又是段」时触发（`MessageTextSync.java:373-379`），而 YAML/Bukkit 配置树无法同时表示这两种形态；即便触发，下一次同步的 2d 分支（`diskText.equals(jarText)`，`:191-199`）会重新记基线，影响有界。详见 §4。 |

## 2. F-01（HIGH）：ATOMIC_MOVE 降级失败时，`finally` 会删掉唯一的干净副本

**证据（本回合读取，`YamlFiles.java:123-130`，逐字）：**

```java
            } catch (AtomicMoveNotSupportedException fallback) {
                Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            if (tmp.exists() && !tmp.delete()) {
                tmp.deleteOnExit();
            }
        }
```

**控制流（逐行）：**

1. `:117` 生成同目录唯一临时名 `target.getName() + "." + nanoTime + ".tmp"`；
2. `:119` 把完整内容写进 tmp；
3. `:121-122` 首选 `REPLACE_EXISTING + ATOMIC_MOVE`；
4. `:123` 仅在文件系统不支持原子移动时进入降级；
5. `:124` 降级为**只带 `REPLACE_EXISTING`** 的 `Files.move`——这一步没有任何原子性保证；
6. `:126-130` 无论第 5 步成功、抛 `IOException`、还是别的运行时异常，只要 tmp 还在，就执行 `tmp.delete()`。

**为什么这是缺陷（而不是「降级只是慢一点」）：**

- 类注释 `:29-30` 明确承诺「本类写『同目录唯一临时名 + ATOMIC_MOVE』，失败时目标文件保持原样」。降级路径把这条承诺变成了「失败时目标文件可能已被替换，而临时副本一定被删」。
- JDK 对 `REPLACE_EXISTING` 的定义是「目标存在则替换……检查与替换相对于其它文件系统操作不是原子的」。在 Windows 上该组合的实现形态是「先删目标再改名」，本仓库自己在 `StatsManager.java:556-559` 写下了同一句判断（「Windows 上这个组合是『先删目标、再重命名』——两者之间崩进程会留下一个文件都没有的状态」）。
- 因此存在这样一条链：降级 move 删掉目标 → 改名阶段失败（占用/权限/磁盘错误）→ 抛 `IOException` → `finally` 删除 tmp → **目标与临时副本同时不存在**。`messages.yml` / `arenas.yml` 这类文件没有第二份副本，损失不可自动恢复。
- 附带的不一致：同仓 `StatsManager` 的同一形态会打一条 WARNING 明说「A crash during that window can lose the file」（`StatsManager.java:600-604`），而 `YamlFiles` 这里是静默的，日志只会看到调用方一句 `Failed to save X`（`YamlFileGate.java:96`），管理员不会知道旧文件已经没了。

**alternatives（每条指向可检查条件）：**

1. 如果本服所有配置文件都位于支持 `ATOMIC_MOVE` 的本地 NTFS 上，`:123` 的降级分支永不进入，本发现不成立——需核对部署目录所在文件系统（唯一入口 `src/main/java/com/hilltopvillage/util/YamlFiles.java:123`）。
2. 如果运行时 JRE 在 Windows 上对非原子 `REPLACE_EXISTING` 的实现是「改名失败时保留目标」，则目标不会消失，只剩 tmp 被删——需核对实际 JRE 的 `WindowsFileCopy.move` 实现（本仓库内不可见，调用点 `YamlFiles.java:124`）。
3. 如果失败形态是进程被强杀/掉电而非抛异常，`finally` 不会执行，tmp 会留在目录里可人工恢复——需确认失败形态（`:126-130` 只在正常异常路径执行）。

**为什么是 HIGH 不是 CRITICAL**：调用链完整（写盘入口 → 降级 → finally），但触发需要两个条件同时成立（非原子文件系统 + 移动在删目标后失败），且崩溃（非异常）形态下 tmp 仍可人工恢复。按 §3.3 保守定 HIGH。

## 3. F-02（HIGH）：`.corrupt` 存在时，`/hilltop reloadconfig` 仍会用出厂值重建 `messages.yml`

**证据（本回合读取，`LanguageManager.java:90-93`，逐字）：**

```java
        YamlFiles.Loaded loaded = messagesGate.load();
        // 只读锁必须与 usable 一起判断：文件被隔离成 *.corrupt 后 load() 返回 ABSENT（usable=true），
        // 若只判 usable，第 4 步的「文件不存在就写」会把 JAR 默认值写回去、绕过只读降级。
        boolean diskWritable = loaded.usable() && !messagesGate.isReadOnly();
```

**调用链（入口 → 问题点，全部本回合读到）：**

1. `/hilltop reloadconfig` → `HilltopCommandHandler.java:396` 分支；
2. `:408` `plugin.getLanguageManager().getMessagesGate().reset();` —— 把 `readOnly` 清成 false、`warned` 复位（`YamlFileGate.java:102-105`）；
3. `:437` `plugin.getLanguageManager().reload();`；
4. `LanguageManager.java:90` `messagesGate.load()` → `YamlFileGate.java:52-61` → `YamlFiles.load`；
5. `YamlFiles.java:80-81`：因为上一轮隔离已把原文件 `Files.move` 成 `.corrupt`（`:169`），`file.exists()` 为 false → 返回 `new Loaded(new YamlConfiguration(), Status.ABSENT, null)`；
6. `YamlFileGate.java:54-60`：`usable()` 为 true（`YamlFiles.java:49-51` 只判 `config != null`），`status()` 是 `ABSENT` 而不是 `OK`，于是**两个分支都不进，`readOnly` 保持 reset 后的 false**；
7. 回到 `LanguageManager.java:93`：`diskWritable = true && !false = true`；
8. `:153-167` 进入写盘段；`:165` 的条件里 `!messagesFile.exists()` 为 true（文件已被隔离），于是 `messagesGate.write(diskConfig)`；
9. `:155-163` 先把 JAR 里所有非 `_meta` 键灌进 `diskConfig`，落盘结果是一份**全新的出厂 `messages.yml`**。

**为什么这是缺陷：**

- 类注释 `YamlFiles.java:141-149` 把这条链写得很清楚：「只看闸门」不行，因为 `readOnly` 是实例级、重启即失效，而 `.corrupt` 留在磁盘上，「最坏的那条数据覆盖链正发生在重启之后」。`YamlFiles.isQuarantined(file, gate)`（`:156-157`）就是为此提供的双信号判据，且 `ConfigManager.java:148/176/209` 与 `ArenaManager.java:848` 都在 `!file.exists()` 分支里用了它——**只有 `LanguageManager` 没用**（本回合 grep `isQuarantined` 在 `LanguageManager.java` 零命中）。这是「同族守卫不一致」，不是设计选择。
- `:91-92` 的注释自称已经处理了「被隔离成 `.corrupt` 后 load() 返回 ABSENT」的情形，但它依赖的是 `messagesGate.isReadOnly()`；`reset()` 恰好把这一位清掉，于是注释描述的保护在 reloadconfig 路径上失效。
- 后果：管理员自定义的 `messages.yml` 只在 `.corrupt` 里；进程内缓存（`:119-147`）读的是空的 `diskConfig`，玩家立刻看到出厂文案；磁盘上则出现一份「看起来完全正常」的新 `messages.yml`。下一次启动它会被判 `OK`，闸门解锁——隔离态被自己的解封动作永久绕过，除非管理员手工从 `.corrupt` 恢复。
- 触发不需要异常条件：`YamlFileGate.java:78` 的拒写提示本身就在引导管理员「Repair/restore it, then restart the server or run /hilltop reloadconfig」。管理员只要在**没先修文件**的情况下执行一次 reloadconfig（例如只想重载别的配置），就会踩中。

**alternatives（每条指向可检查条件）：**

1. 如果 `reload()` 在 `:165` 写盘前调用 `YamlFiles.isQuarantined(messagesFile, messagesGate)`（或等价地检查 `.corrupt` 是否存在），则不会写回——需检查 `LanguageManager.java:93` 与 `:153-167` 之间是否存在该判断（本回合读取：没有）。
2. 如果 `/hilltop reloadconfig` 不调用 `messagesGate.reset()`，闸门仍锁、`diskWritable` 为 false，问题不成立——需检查 `HilltopCommandHandler.java:408`（本回合读到确实调用）。
3. 如果 `quarantine` 是复制而非 move，原路径仍有原文件，`ABSENT` 分支不会被走到——需检查 `YamlFiles.java:169`（`Files.move`，不是 copy）。

**为什么是 HIGH 不是 CRITICAL**：调用链与触发条件都完整可复现，但原始内容仍完整保存在 `.corrupt` 里（不是物理销毁），恢复需要人工 rename；且触发需要「先有一次隔离 + 管理员执行命令」两个前置。按 §3.3 保守定 HIGH。

## 4. F-03（MEDIUM）：`setLocale` 用截断式 `saveConfig()` 写 `config.yml`

**证据（本回合读取，`LanguageManager.java:305-308`，逐字）：**

```java
            this.defaultLocale = locale;
            plugin.getConfig().set("language", locale);
            plugin.saveConfig();
        }
```

**为什么这是缺陷：**

- `set` 与 `saveConfig()` 是成对的（这一项没问题），问题在写入方式：Bukkit 的 `JavaPlugin#saveConfig()` 走 `FileConfiguration.save(File)`，直接开文件流截断目标再写，正是 `YamlFiles.java:20-21/29-30` 点名要避免的形态；`config.yml` 不属于任何 `YamlFileGate`（各 gate 分别守护 messages/arenas/game-settings/monsters/display/shop 等文件）。
- 写入窗口内发生 `IOException`（磁盘满、进程被杀）会留下 0 字节或半截 `config.yml`；Bukkit 对 `saveConfig` 的 `IOException` 只打 SEVERE、不重试、不保留旧文件，下一次启动 `loadConfiguration` 解析失败会退化为空配置。
- 可达性：`HilltopCommandHandler.java:1745-1747`，管理员或控制台执行 `/hilltop lang en|zh` 即触发（普通玩家被 `canChangeDefault` 挡在外面，所以频率低——这也是定 MEDIUM 而非 HIGH 的原因）。

**对 sweep 的一处更正**：sweep 说 `config.yml` 承载「语言、全部游戏配置」。本回合读到的代码里游戏配置由 `ConfigManager` 的 `game-settings.yml` 等独立文件承载并有各自的 gate，`config.yml` 至少承载 `language` 及其自身其它键。因此影响面按「整份 config.yml 的键」计，不按「全部游戏配置」计。

**alternatives（每条指向可检查条件）：**

1. 如果该版本 Paper/Spigot 的 `FileConfiguration.save(File)` 已改为「先写临时文件再替换」，则不存在截断窗口——需核对该服务端实现（本仓库内不可见，调用点 `LanguageManager.java:307`）。
2. 如果 `config.yml` 的每个键都能由默认值或其它持久化文件重建，则截断只造成设置回退而非数据丢失——需检查 `config.yml` 是否承载唯一副本（`LanguageManager.java:306` 只写 `language`，但 `saveConfig` 落的是整份内存配置）。
3. 如果 `setLocale` 只能由有文件系统权限的管理员在停服时调用，窗口可忽略——需检查 `HilltopCommandHandler.java:1745-1747` 的权限判定与在线调用路径。

## 5. L6 为什么 REFUTED

`keyHashesSet`（`MessageTextSync.java:368-380`）在 `disk.set(metaPath, hashValue)` 抛 `RuntimeException` 时返回 false，而三处调用方（`:169`、`:192`、`:216`、`:243`）只把 true 当「有改动」，false 被静默忽略——`putText` 的失败有 `Action.KEEP` 分支与记账，这里没有，确实是同族不对称。

但它要触发，必须让 `_meta.keys.<locale>.<key>` 路径上「已存在一个字符串，又要往下建子段」。`collectPaths` 取的是 `getKeys(true)` 的段树路径（`:389-395`），同一 locale 下不可能同时存在字符串 `a` 与子段 `a.b`；出厂文件与历史 tag 也没有字面量点号键。即使人为构造出来，下一次同步只要磁盘值等于当前出厂值就会走 2d 分支（`:191-199`）重新写基线；只有在「构造冲突 + 之后出厂文案又变 + legacy 基线也不含该值」三条同时成立时才会退化为 `MARK_CUSTOM`。这是有界的降级，不是数据丢失，因此不构成本维度缺陷。

## 6. 已核未见缺陷（防重复劳动）

| 对象 | 结论 |
|---|---|
| `MessageTextSync` 替换/编译顺序 | 同步（第 2b 步）在缓存构建（第 3 步）之前；缓存只读 `diskConfig`；`compile()` 只在缓存层做一次 `translateAlternateColorCodes`；`fill()` 插入原始参数不再翻译。未发现二次转义或「缓存与磁盘不同源」。`changed()` 为 false 时零写入的约束在 `LanguageManager.java:164` 被遵守。 |
| `YamlFiles` 隔离动作 | `quarantine` 用 `Files.move + REPLACE_EXISTING`（`:169`），失败时保留原件并返回 `QUARANTINE_FAILED`（`:173-177`），日志措辞与结果一致；不会出现「隔离失败却宣称已隔离」。 |
| `SafeSpawnUtil.findSafeGround` | `base`/`world` 判空（`:41-43`），`isChunkLoaded` 短路（`:55`），`startY` 用 `min/max` 夹取（`:59`），循环 `y >= minY`（`:61`），`surfaceY < minY + 2` 返回 null（`:80`）。无负下标/越界。 |
| `YamlFileGate` 状态机 | `load()` 三分支（不可用→锁、OK→解、ABSENT→不变）与类注释一致；`lock()`/`reset()` 是仅有的两个直接改 `readOnly` 的方法。缺陷不在状态机本身，而在 `LanguageManager` 只消费了 `isReadOnly()` 这一半信号（F-02）。 |
| `StatsManager`（shared dependency） | 与 F-01 同形的降级 + `finally` 删 tmp（`:597-620`），但 `:600-604` 显式 WARNING 承认「crash 可能丢文件」，属已声明风险；`load()` 的 I/O 失败只读降级（`:335-347`）与「不覆盖读不出来的文件」一致。仅作同族证据，不单列发现。 |

## 7. 维度清单（逐项给结论）

| # | 模式 | 结果 | 说明 |
|---|---|---|---|
| 1 | 返回值暴露内部状态 | 未命中 | `Loaded` 是 record，`config` 可变是调用方需要；`LanguageManager.get` 返回缓存里的不可变字符串；`StatsManager.top` 的 `subList` 是方法内新建 `ArrayList` 的视图，不触达 `cache`。 |
| 2 | 同族函数守卫一致性 | 命中 | 三个写盘出口：`YamlFileGate.write`（先 `writable()`）、`setLocale`（裸 `saveConfig`，F-03）、`keyHashesSet`（失败静默，L6）。同族配置管理器用 `isQuarantined` 双信号，`LanguageManager` 不用（F-02）。 |
| 3 | 数值边界 | 不适用 | 6 个文件无 `parseInt/parseDouble` 入参；`SafeSpawnUtil` 的 y 边界由 `getMinHeight/getMaxHeight` 夹取。 |
| 4a | 原型链/裸下标 | 不适用 | Java，无对象字典查表；YAML 路径均由固定前缀拼接。 |
| 4b | 假值 vs 缺值 | 命中 | `ABSENT`（文件不存在）被 `usable()` 判为 true，与「隔离后不存在」共用同一返回值；`reset` 后两者不可区分——F-02 的根因（`LanguageManager.java:93` + `YamlFiles.java:80-81`）。 |
| 4c | NaN/Infinity/小数 | 不适用 | 无数值解析路径。 |
| 4d | 嵌套结构校验 | 命中 | `MessageTextSync` 校验 `_meta` 与 `_meta.keys` 嵌套结构并区分 `baselineCorrupt`；唯一静默点是 `keyHashesSet` 的结构冲突 catch，判不可达（L6）。`messagesValidator` 用 ≥50 键做语义哨兵。 |
| 5 | 能力是否真实现 | 命中 | `YamlFiles.isQuarantined` 已实现双信号判据并被 `ConfigManager`/`ArenaManager` 使用，`LanguageManager` 零调用（F-02）。 |
| 6 | 转义/编码顺序 | 未命中 | 颜色码只在缓存层编译一次，`fill()` 不再翻译；同步早于缓存构建，无二次转义。 |
| 7 | 边界符号（负数/下标） | 未命中 | `SafeSpawnUtil` 用 `Math.max/min` 夹取，循环条件 `y >= minY`，无负下标。 |
| 8 | 引用绑定是否存在 | 未命中 | 6 个文件的 import 与使用一致（`Files`/`StandardCopyOption`/`AtomicMoveNotSupportedException` 均已导入）；无跨文件符号缺失。 |

## 8. 自检

- **标识符对账**：对账 `YamlFiles.Status` 5 个枚举值与 `YamlFileGate.load()` 的三条分支；对账 `LanguageManager` 用到的 gate 方法（`load/isReadOnly/write/reset`）与 `YamlFiles` 的公开方法，差集 = `isQuarantined` 零调用；对账 `_meta` 键与 `isMetaKey` 前缀；gate 构造时绑定的 `messagesFile` 与 `reload()` 重新赋值的路径一致。
- **自带自检抽验**：静态抽验 `YamlFileGateTest`（10 用例）与 `YamlFilesQuarantinePersistenceTest`（7 用例）——(a) 均有 `assertFalse/assertTrue` 失败路径；(b) `corruptFileBlocksAllWrites` 还断言目录里只剩 1 个文件，不是「空集即通过」；(c) 断言目标 `isQuarantined`/`corruptFile` 在源码存在。**覆盖缺口**：`resetStillWorksAfterLock` 只断言 `writable()` 变 true，`resetUnlocksAndRepairedFileBecomesWritable` 先 `Files.deleteIfExists(.corrupt)` 再写回好文件——没有任何用例覆盖「reset + 原文件缺失 + `.corrupt` 仍在」，即 F-02 的路径，测试全绿也测不到。(d) 注入故障需跑 Maven，会写 `target/`，违反零写入，未执行。
- **运行时验证**：SKIPPED。Maven 构建会写 `target/`，且本机无 Bukkit 服务端可起；改用控制流逐行核对 + 现有单测覆盖分析代替。

## 9. off-dimension（不进 findings）

见 payload.off_dimension_notes（L4 并发竞态、L5 NPE 路径、F-03 影响面更正、StatsManager 同族观察）。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "audit-slice-26-data-consistency",
  "role": "audit",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/.run-dsh3/artifacts/round1-02-audit-slice-26-data-consistency.md",
  "payload": {
    "slice_id": "slice-26",
    "findings": [
      {
        "finding_id": "F-slice-26-data-consistency-01",
        "severity": "HIGH",
        "dimension": "data-consistency",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/util/YamlFiles.java",
          "line": 123,
          "quote": "            } catch (AtomicMoveNotSupportedException fallback) {\n                Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING);\n            }\n        } finally {\n            if (tmp.exists() && !tmp.delete()) {\n                tmp.deleteOnExit();\n            }\n        }"
        },
        "inference": {
          "claim": "当 ATOMIC_MOVE 抛 AtomicMoveNotSupportedException 时，write() 降级为不带 ATOMIC_MOVE 的 REPLACE_EXISTING 移动；该移动失败（已进入替换、尚未完成）时 finally 会删除 tmp，磁盘上既没有可用的目标文件、也没有临时副本，与类注释『失败时目标文件保持原样』相反。",
          "basis": "控制流逐行：:117 生成同目录唯一 tmp，:119 写入完整内容，:121-122 首选 REPLACE_EXISTING+ATOMIC_MOVE，:123 捕获不支持原子移动，:124 用仅带 REPLACE_EXISTING 的 Files.move（无原子性），:126-130 的 finally 只要 tmp 仍存在就 tmp.delete()。JDK 明确 REPLACE_EXISTING 的检查与替换不是原子操作；本仓库 StatsManager.java:556-559 也自述 Windows 上该组合是『先删目标再重命名』。因此『删目标后改名失败 → 抛 IOException → finally 删 tmp』会让两份都不在。类注释 :29-30 承诺失败时目标保持原样，实际降级路径没有这个保证，且不像 StatsManager.java:600-604 那样打 WARNING，失败是静默的（调用方只看到 YamlFileGate.java:96 的 Failed to save）。",
          "alternatives": [
            "如果本服配置文件所在文件系统都支持 ATOMIC_MOVE，:123 的降级分支永不进入，本发现不成立——需核对部署目录文件系统，入口 src/main/java/com/hilltopvillage/util/YamlFiles.java:123",
            "如果运行时 JRE 在 Windows 上对非原子 REPLACE_EXISTING 的实现是改名失败时保留目标，则只有 tmp 被删、目标仍在——需核对实际 JRE 的 WindowsFileCopy.move 实现（仓库内不可见），调用点 src/main/java/com/hilltopvillage/util/YamlFiles.java:124",
            "如果失败形态是进程被强杀或掉电而非抛异常，finally 不执行、tmp 留在目录可人工恢复——需确认失败形态，判断点 src/main/java/com/hilltopvillage/util/YamlFiles.java:126-130"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "F-slice-26-data-consistency-02",
        "severity": "HIGH",
        "dimension": "data-consistency",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/util/LanguageManager.java",
          "line": 90,
          "quote": "        YamlFiles.Loaded loaded = messagesGate.load();\n        // 只读锁必须与 usable 一起判断：文件被隔离成 *.corrupt 后 load() 返回 ABSENT（usable=true），\n        // 若只判 usable，第 4 步的「文件不存在就写」会把 JAR 默认值写回去、绕过只读降级。\n        boolean diskWritable = loaded.usable() && !messagesGate.isReadOnly();"
        },
        "inference": {
          "claim": "messages.yml 被隔离成 .corrupt 后，管理员执行一次 /hilltop reloadconfig 就会让 reload() 把该文件当成首次运行：load() 返回 ABSENT 且 usable()==true，readOnly 已被 reset 清成 false，于是 diskWritable 为 true，第 4 步用 !messagesFile.exists() 触发写盘，把 JAR 出厂文案写成一份新的 messages.yml，绕过『隔离期间不得写回』的降级语义。",
          "basis": "调用链：HilltopCommandHandler.java:396 reloadconfig 分支 → :408 messagesGate.reset()（清 readOnly/warned，YamlFileGate.java:102-105）→ :437 LanguageManager.reload() → :90 messagesGate.load() → YamlFileGate.java:52-61 → YamlFiles.load :80-81 因原文件已被 quarantine 的 Files.move（:169）挪走而返回 Loaded(空配置, ABSENT)；YamlFileGate.load :54-60 对 usable=true 且 status=ABSENT 两个分支都不进，readOnly 保持 reset 后的 false → :93 diskWritable=true → :155-163 把 JAR 非 _meta 键灌入 diskConfig → :165 !messagesFile.exists() 为 true → messagesGate.write(diskConfig)。YamlFiles.isQuarantined（:156-157）正是为这条链准备的双信号判据，ConfigManager.java:148/176/209 与 ArenaManager.java:848 都用了，LanguageManager 零调用；:91-92 的注释自称已处理该情形，但依赖的 isReadOnly 被 reset 清掉。",
          "alternatives": [
            "如果 reload() 在 :165 写盘前调用 YamlFiles.isQuarantined(messagesFile, messagesGate) 或等价检查 .corrupt 是否存在，则不会写回——需检查 src/main/java/com/hilltopvillage/util/LanguageManager.java:153-167 之间是否有该判断（本回合读取：没有）",
            "如果 /hilltop reloadconfig 不调用 messagesGate.reset()，闸门仍锁、diskWritable 为 false，问题不成立——需检查 src/main/java/com/hilltopvillage/command/HilltopCommandHandler.java:408（本回合读到确实调用）",
            "如果 quarantine 是复制而非 move，原路径仍有文件、不会走到 ABSENT 分支——需检查 src/main/java/com/hilltopvillage/util/YamlFiles.java:169 的 Files.move"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "F-slice-26-data-consistency-03",
        "severity": "MEDIUM",
        "dimension": "data-consistency",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/util/LanguageManager.java",
          "line": 305,
          "quote": "            this.defaultLocale = locale;\n            plugin.getConfig().set(\"language\", locale);\n            plugin.saveConfig();\n        }"
        },
        "inference": {
          "claim": "setLocale() 用 Bukkit 的 plugin.saveConfig() 落盘 config.yml，该方法先截断目标再写；写入窗口内发生 IOException（磁盘满、进程被杀）会留下 0 字节或半截 config.yml，且该文件不在任何 YamlFileGate 的保护范围内。",
          "basis": "LanguageManager.java:306 set 与 :307 saveConfig 成对，问题在写入方式：JavaPlugin#saveConfig 走 FileConfiguration.save(File)，先截断再写，正是 YamlFiles.java:20-21/29-30 点名要避免的形态；各 YamlFileGate 只守护 messages/arenas/game-settings/monsters/display/shop 等文件，config.yml 不在其中。Bukkit 对 saveConfig 的 IOException 只打 SEVERE、不重试、不保留旧文件；下次启动 loadConfiguration 解析失败会退化为空配置。入口 HilltopCommandHandler.java:1745-1747，/hilltop lang 且调用者为管理员或控制台。",
          "alternatives": [
            "如果该版本 Paper/Spigot 的 FileConfiguration.save(File) 已改为先写临时文件再替换，则不存在截断窗口——需核对该服务端实现（仓库内不可见），调用点 src/main/java/com/hilltopvillage/util/LanguageManager.java:307",
            "如果 config.yml 的每个键都能由默认值或其它持久化文件重建，则截断只造成设置回退而非数据丢失——需检查 config.yml 是否承载唯一副本，对照 src/main/java/com/hilltopvillage/util/LanguageManager.java:306 与 ConfigManager 的独立配置文件",
            "如果 setLocale 只能由有文件系统权限的管理员在停服时调用，窗口可忽略——需检查 src/main/java/com/hilltopvillage/command/HilltopCommandHandler.java:1745-1747 的权限判定与在线调用路径"
          ]
        },
        "status": "CONFIRMED"
      }
    ],
    "searched_scope": {
      "files_read": [
        "src/main/java/com/hilltopvillage/util/DisplayEntityManager.java",
        "src/main/java/com/hilltopvillage/util/LanguageManager.java",
        "src/main/java/com/hilltopvillage/util/MessageTextSync.java",
        "src/main/java/com/hilltopvillage/util/SafeSpawnUtil.java",
        "src/main/java/com/hilltopvillage/util/YamlFileGate.java",
        "src/main/java/com/hilltopvillage/util/YamlFiles.java",
        "src/main/java/com/hilltopvillage/stats/StatsManager.java",
        "src/main/java/com/hilltopvillage/command/HilltopCommandHandler.java",
        "src/test/java/com/hilltopvillage/util/YamlFileGateTest.java",
        "src/test/java/com/hilltopvillage/util/YamlFilesQuarantinePersistenceTest.java"
      ],
      "files_in_slice": 6,
      "shared_dependencies_read": [
        "src/main/java/com/hilltopvillage/stats/StatsManager.java"
      ],
      "files_scanned_without_findings": [
        "src/main/java/com/hilltopvillage/util/DisplayEntityManager.java",
        "src/main/java/com/hilltopvillage/util/SafeSpawnUtil.java",
        "src/main/java/com/hilltopvillage/util/YamlFileGate.java",
        "src/main/java/com/hilltopvillage/stats/StatsManager.java",
        "src/main/java/com/hilltopvillage/command/HilltopCommandHandler.java",
        "src/test/java/com/hilltopvillage/util/YamlFileGateTest.java",
        "src/test/java/com/hilltopvillage/util/YamlFilesQuarantinePersistenceTest.java"
      ],
      "unreadable_files": [],
      "dimension_checklist": [
        {
          "pattern": "1 返回值暴露内部状态",
          "result": "未命中",
          "note": "Loaded 是 record，config 可变是调用方需要；LanguageManager.get 返回缓存里的不可变字符串；StatsManager.top 的 subList 是方法内新建 ArrayList 的视图，不触达 cache。"
        },
        {
          "pattern": "2 同族函数守卫一致性",
          "result": "命中",
          "note": "三个写盘出口：YamlFileGate.write 先 writable()、setLocale 裸 saveConfig（F-03）、keyHashesSet 失败静默（L6）。同族配置管理器用 isQuarantined 双信号，LanguageManager 不用（F-02）。"
        },
        {
          "pattern": "3 数值边界",
          "result": "不适用",
          "note": "6 个文件无 parseInt/parseDouble 入参；SafeSpawnUtil 的 y 边界由 getMinHeight/getMaxHeight 夹取。"
        },
        {
          "pattern": "4a 原型链/裸下标",
          "result": "不适用",
          "note": "Java，无对象字典查表；YAML 路径均由固定前缀拼接。"
        },
        {
          "pattern": "4b 假值 vs 缺值",
          "result": "命中",
          "note": "ABSENT（文件不存在）被 usable() 判为 true，与「隔离后不存在」共用同一返回值；reset 后两者不可区分——F-02 的根因（LanguageManager.java:93 + YamlFiles.java:80-81）。"
        },
        {
          "pattern": "4c NaN/Infinity/小数",
          "result": "不适用",
          "note": "无数值解析路径。"
        },
        {
          "pattern": "4d 嵌套结构校验",
          "result": "命中",
          "note": "MessageTextSync 校验 _meta 与 _meta.keys 嵌套结构并区分 baselineCorrupt；唯一静默点是 keyHashesSet 的结构冲突 catch，判不可达（L6）。messagesValidator 用 >=50 键做语义哨兵。"
        },
        {
          "pattern": "5 能力是否真实现",
          "result": "命中",
          "note": "YamlFiles.isQuarantined 已实现双信号判据并被 ConfigManager/ArenaManager 使用，LanguageManager 零调用（F-02）。"
        },
        {
          "pattern": "6 转义/编码顺序",
          "result": "未命中",
          "note": "颜色码只在缓存层编译一次，fill() 不再翻译；同步早于缓存构建，无二次转义。"
        },
        {
          "pattern": "7 边界符号（负数/下标）",
          "result": "未命中",
          "note": "SafeSpawnUtil 用 Math.max/min 夹取，循环条件 y >= minY，无负下标。"
        },
        {
          "pattern": "8 引用绑定是否存在",
          "result": "未命中",
          "note": "6 个文件的 import 与使用一致（Files/StandardCopyOption/AtomicMoveNotSupportedException 均已导入）；无跨文件符号缺失。"
        }
      ]
    },
    "self_checks": {
      "identifier_reconcile": {
        "status": "DONE",
        "note": "对账 YamlFiles.Status 5 个枚举值与 YamlFileGate.load() 的三条分支（不可用→锁、OK→解、ABSENT→不变）；对账 LanguageManager 用到的 gate 方法 load/isReadOnly/write/reset 与 YamlFiles 的公开方法，差集 = isQuarantined 零调用；对账 _meta 键与 isMetaKey 前缀；gate 构造时绑定的 messagesFile 与 reload() 重新赋值的路径一致。"
      },
      "self_check_audit": {
        "status": "DONE",
        "note": "静态抽验 YamlFileGateTest（10 用例）与 YamlFilesQuarantinePersistenceTest（7 用例）：(a) 均有 assert 失败路径；(b) corruptFileBlocksAllWrites 断言目录只剩 1 个文件，不是空集即通过；(c) 断言目标 isQuarantined/corruptFile 在源码存在。缺口：resetStillWorksAfterLock 只断言 writable() 变 true，另一个用例先删除 .corrupt 再写回好文件，无任何用例覆盖「reset + 原文件缺失 + .corrupt 仍在」，即 F-02 路径，测试全绿也测不到。(d) 注入故障要跑 Maven 会写 target/，违反零写入，未执行。"
      },
      "runtime_validation": {
        "status": "SKIPPED",
        "note": "Maven 构建会写 target/ 违反零写入，且本机无 Bukkit 服务端可起；改用控制流逐行核对与现有单测覆盖分析代替。"
      }
    },
    "off_dimension_notes": [
      "L4（concurrency，YamlFileGate.java:89）：writable() 与 YamlFiles.write 之间无锁，readOnly 仅 volatile；两个写线程可各自基于旧快照整文件重写，ATOMIC_MOVE 只保证不出现半截文件、不保证不丢更新。按派发维度归 concurrency，本切片不据此立 data-consistency 发现。",
      "L5（error-handling，DisplayEntityManager.java:15/32）：location.getWorld() 未判空即 world.spawnParticle，NPE 会冒到主线程实体回调，属 error-handling。",
      "F-03 影响面更正：sweep 称 config.yml 承载「语言、全部游戏配置」与代码不符——游戏配置在 ConfigManager 的 game-settings.yml 等独立文件里并有各自 gate；F-03 已按实际影响定为 MEDIUM。",
      "StatsManager.java:597-620 与 F-01 同形（降级 REPLACE_EXISTING + finally 删 tmp），但 :600-604 显式 WARNING 承认「crash 可能丢文件」，属已声明风险；仅作同族证据，不单列发现。"
    ]
  },
  "error": null
}
```
