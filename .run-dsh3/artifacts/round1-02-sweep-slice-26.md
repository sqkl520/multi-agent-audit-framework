# slice-26 宽扫（util 存档/文本/YAML 闸门）

- trace_id: trace-r1-20260215-hilltop-dsh3
- round_id: round1
- slice_id: slice-26
- status: COMPLETE
- 范围：`src/main/java/com/hilltopvillage/util/` 下 6 个文件（只读）
- 重点：YAML 落盘原子性、失败时原文件命运、quarantine/.corrupt、并发写、MessageTextSync 文本替换顺序、LanguageManager 缺键回退

## 1. 落盘原子性：主路径原子，降级路径不原子且可能连临时副本一起丢

`YamlFiles.write` 的主路径是「同目录唯一临时名 → `ATOMIC_MOVE` + `REPLACE_EXISTING`」，这是正确的。问题在 `AtomicMoveNotSupportedException` 的降级分支（L123–125）：它退化为普通 `Files.move(..., REPLACE_EXISTING)`。在 Windows 上该组合是「先删目标再改名」，本身非原子；若此时进程崩溃或 move 抛错，目标已被删除、而 `finally`（L126–130）又会把 tmp 删掉——结果既没有原文件也没有临时副本，正是类注释 L29–30 声称要避免的「半截/丢失」。此路径的触发条件是文件系统不支持原子移动（网络盘、部分容器挂载），并非不可达。

## 2. quarantine 的「重启后仍只读」判据没有在调用方落地

`YamlFiles.isQuarantined()`（L156–158）自己写明：只看 gate 不够，因为 `readOnly` 是实例级、重启即失效，而 `.corrupt` 留在磁盘上；最坏链路正是「重启后新 gate 干净 → 模板被写回」。`LanguageManager.reload()` 只判 `loaded.usable() && !messagesGate.isReadOnly()`（L93），没有查 `.corrupt`。叠加 `YamlFileGate.reset()`（`/hilltop reloadconfig` 会调用，见 `HilltopCommandHandler:408`）：reset 清锁后 `load()` 对已被隔离的文件返回 `ABSENT`（`usable()==true`，且 ABSENT 分支不改 `readOnly`），于是 `diskWritable` 变 true，第 4 步的 `!messagesFile.exists()` 命中并写回 JAR 默认值。磁盘上 `.corrupt` 里的现场仍在，但进程已经用一份全新的默认文件继续跑，隔离语义被自己的解封动作绕过。

## 3. `plugin.saveConfig()` 与同包 YAML 策略相反

`setLocale` 直接 `plugin.saveConfig()`。Bukkit 的 `saveConfig()` 走 `FileConfiguration.save(File)`，先截断目标再写，正是 `YamlFiles` 类注释 L20–21 点名要避免的形态；`config.yml` 不在 `YamlFileGate` 保护范围内。语言切换是低频管理操作，但崩溃/磁盘满落在写入窗口内会留下 0 字节或半截 `config.yml`（语言、全部游戏配置）。

## 4. 闸门的 check-then-act

`YamlFileGate.write()` 先 `writable()` 再 `YamlFiles.write()`，两步之间没有锁/同步；`readOnly` 只是 volatile 布尔。类注释 L34 明确写「写盘可能来自异步路径」，因此「检查通过 → 另一线程 load() 判定不可用并上闩 → 本线程仍然写」的窗口是真实存在的。同理，两个线程各自基于自己的快照整文件重写同一目标时，`ATOMIC_MOVE` 只保证「不出现半截文件」，不保证「不丢更新」——后落盘者会用旧快照覆盖新快照，且无任何告警。

## 5. 粒子工具对 `getWorld()` 不判空

`DisplayEntityManager` 两个方法都先 `location.getWorld()` 再直接 `world.spawnParticle(...)`。`Location#getWorld()` 允许为 null（跨世界传送/未绑定世界的坐标），`location` 本身也未判空。调用点 `NodeListener:245`、`ExplodeBeetleGoal:260` 都在主线程实体回调里，NPE 会冒到 scheduler/tick 链。

## 6. 基线哈希写失败被静默吞掉

`MessageTextSync.keyHashesSet` 在 `_meta.keys.<locale>.<key>` 结构冲突（同名键既是字符串又是段）时 catch `RuntimeException` 返回 false，且三处调用方（L169/L192/L216/L243）都不看返回值、不记日志、不产出 Step。后果是该键的出厂哈希永远不会落盘：下一轮只能走 legacy/保守分支，若 legacy 也没有该值就被打成 custom 并永久冻结——一条本可升级的出厂文案变成「服主自定义」，而日志里看起来一切正常。

## 已核未成线索（记录，避免下游重复）

- `MessageTextSync` 的替换顺序：同步（第 2b 步）在缓存构建（第 3 步）之前，缓存只读 `diskConfig`，`compile()` 仅在缓存层做一次 `translateAlternateColorCodes`，`fill()` 插入的是原始参数、不再翻译，未发现二次转义路径。
- `LanguageManager` 缺键回退：`get(key, locale)` 依次 locale → defaultLocale → 返回 key 字面量；`getFor` 的 locale 来自 `getPlayerLocale`，非空。返回 key 字面量是显式设计（L355 注释），不构成契约破坏，未成线索。
- `SafeSpawnUtil.findSafeGround`：`isChunkLoaded` 短路、`startY` clamp、上方 2 格检查、贴底返回 null 均自洽；未发现负下标/越界（`minY` 来自 `getMinHeight()`，循环条件 `y >= minY`）。

## 可达性

`PROD`。6 个文件均被生产入口引用：`GameManager:134` 构造 `DisplayEntityManager`（`NodeListener:245`、`ExplodeBeetleGoal:260` 调用）；`SafeSpawnUtil.findSafeGround` 被 `ArenaInstance:1330`、`WaveManager:742/774/780` 调用；`LanguageManager` 由插件主类构造并服务全部消息；`YamlFileGate`/`YamlFiles` 是 `LanguageManager` 与各配置管理器的落盘底座；`MessageTextSync` 在 `LanguageManager.reload()` 内每次启动执行。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "sweep-slice-26",
  "role": "sweep",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/.run-dsh3/artifacts/round1-02-sweep-slice-26.md",
  "payload": {
    "slice_id": "slice-26",
    "reachability": "PROD",
    "generator_ref": null,
    "files_read": [
      {
        "path": "src/main/java/com/hilltopvillage/util/YamlFiles.java",
        "lines": 426,
        "quote": "    public static void write(File file, YamlConfiguration yaml) throws IOException {"
      },
      {
        "path": "src/main/java/com/hilltopvillage/util/YamlFileGate.java",
        "lines": 122,
        "quote": "    public boolean write(YamlConfiguration yaml) {"
      },
      {
        "path": "src/main/java/com/hilltopvillage/util/LanguageManager.java",
        "lines": 503,
        "quote": "    public void reload() {"
      },
      {
        "path": "src/main/java/com/hilltopvillage/util/MessageTextSync.java",
        "lines": 396,
        "quote": "    public static Result sync(YamlConfiguration jar, YamlConfiguration disk,"
      },
      {
        "path": "src/main/java/com/hilltopvillage/util/DisplayEntityManager.java",
        "lines": 38,
        "quote": "public class DisplayEntityManager {"
      },
      {
        "path": "src/main/java/com/hilltopvillage/util/SafeSpawnUtil.java",
        "lines": 90,
        "quote": "    public static Location findSafeGround(Location base) {"
      }
    ],
    "files_unreadable": [],
    "leads": [
      {
        "lead_id": "L1",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/util/YamlFiles.java",
        "line": 124,
        "quote": "                Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING);",
        "why_suspicious": "ATOMIC_MOVE 失败后的降级分支是非原子的「先删后改名」，且 finally 会删掉 tmp，崩溃窗口内原文件与临时副本可能同时消失。",
        "confidence": "HIGH"
      },
      {
        "lead_id": "L2",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/util/LanguageManager.java",
        "line": 93,
        "quote": "        boolean diskWritable = loaded.usable() && !messagesGate.isReadOnly();",
        "why_suspicious": "只判 gate 的实例级 readOnly，未查磁盘上的 .corrupt；gate.reset() 后 load() 返回 ABSENT 即可写，已隔离文件会被一份新默认内容覆盖。",
        "confidence": "HIGH"
      },
      {
        "lead_id": "L3",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/util/LanguageManager.java",
        "line": 307,
        "quote": "            plugin.saveConfig();",
        "why_suspicious": "Bukkit saveConfig 走截断式写，与同包 YamlFiles 的「临时文件 + ATOMIC_MOVE」策略相反，写入窗口内崩溃会留下半截 config.yml。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L4",
        "suspected_dimension": "concurrency",
        "file": "src/main/java/com/hilltopvillage/util/YamlFileGate.java",
        "line": 89,
        "quote": "        if (!writable()) {",
        "why_suspicious": "writable() 检查与随后的 write 之间无锁，readOnly 仅 volatile；异步写线程可在另一线程上闩之后继续写，两个写者也只会互相覆盖快照。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L5",
        "suspected_dimension": "error-handling",
        "file": "src/main/java/com/hilltopvillage/util/DisplayEntityManager.java",
        "line": 15,
        "quote": "        World world = location.getWorld();",
        "why_suspicious": "getWorld() 可为 null 且 location 未判空，随后直接 world.spawnParticle，缺世界坐标会让 NPE 冒到主线程实体回调。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L6",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/util/MessageTextSync.java",
        "line": 376,
        "quote": "        } catch (RuntimeException structureClash) {",
        "why_suspicious": "键冲突时基线哈希写失败被静默 return false，调用方不检查，该键此后只能走 legacy/保守分支并可能被永久标成自定义。",
        "confidence": "LOW"
      }
    ],
    "lead_count": 6,
    "dimension_histogram": {
      "logic": 0,
      "concurrency": 1,
      "security": 0,
      "error-handling": 1,
      "data-consistency": 4,
      "contract": 0
    }
  },
  "error": null
}
```
