# slice-19 宽扫（round1 / trace-r1-20260215-hilltop-dsh3）

- status: COMPLETE
- slice_id: slice-19
- 切片文件: `src/main/java/com/hilltopvillage/gui/ArenaSelectionGUI.java`（338 行，本回合全文 read）
- shared_dependencies: 无
- reachability: PROD（派发 hint 为 PROD；该类由插件构造并 `registerEvents` 注册，属于玩家可见的选场 GUI 路径）

## 1. 扫描范围与方法

本回合只读切片文件全文一次（read 工具，325/338 行显示差异来自空行与 CRLF 计法，实际读到末行 338）。
按任务书 §5 的 6 个问题域逐一快扫，命中即记 lead，不验证、不判严重性、不做因果链。

| 维度 | 本切片关注点 | 结果 |
|---|---|---|
| `logic` | 状态机分支完整性、槽位边界、渲染与判定一致性 | 2 条 |
| `concurrency` | 异步/线程、共享 Map 读写 | 0 条（本文件无 async/线程；`slotArenaIds` 仅在主线程渲染与点击回调中读写） |
| `security` | 权限节点、输入进敏感操作 | 0 条（仅硬编码 `hilltopvillage.admin` 判定，fail-closed） |
| `error-handling` | 未判空、异常冒泡、失败反馈 | 2 条 |
| `data-consistency` | 渲染快照 vs 实时列表、重载清理 | 0 条（用 holder 快照 + `getArena(id)` 反查，已显式处理场消失） |
| `contract` | GUI 点击契约、返回值处理、槽位越界 | 2 条 |

## 2. 线索

### L1（logic，MEDIUM）STARTING 可加入，但图标落入 default 的 WOODEN_SWORD

`canJoin` 明确允许 `STARTING`（第 244 行），而 `createArenaIcon` 的 switch（第 120–136 行）没有 `STARTING` 分支，落入 `default` 得到 `Material.WOODEN_SWORD`；类注释第 33 行把 WOODEN_SWORD 定义为「未启用 / 未部署 / 地图缺失（不可用）」。同一状态在 lore 里给的是绿色/黄色可点击提示，图标却是「不可用」样式。

### L2（contract，MEDIUM）关闭 GUI 后调用 joinArena，返回值被丢弃

第 320–329 行先 `canJoin` 再 `player.closeInventory()`，随后 `arenaManager.joinArena(player, arena.getArenaId());` 的返回值没有被检查。若 join 在最后一刻失败（场状态变化 / 满员 / 已在别场），玩家只看到 GUI 关闭、没有任何失败消息，且 `join-failed` 分支（第 321 行）不会走到。

### L3（logic，MEDIUM）超过 45 个竞技场时静默截断，注释声称的导航行未实现

第 81 行注释写「leaving bottom row for navigation」，第 85 行 `if (slot >= 45) break;` 直接丢弃第 46 个及以后的竞技场；`openGUI` 里没有任何翻页/导航控件（第 45–52 槽位始终为空），也没有告知玩家还有未显示的场。这是「能力未实现但注释声称有」的形态。

### L4（error-handling，LOW）地图缺失时仍把 getWorldName() 直接塞进语言占位符

第 158 行把 `arena.getWorldName()` 作为参数传给 `languageManager.getFor`，未判空。`getStatusText` 已对 `!arena.isWorldAvailable()` 做了专门分支（第 197 行），说明「世界不可用」是正常状态；此时 worldName 很可能是 null，占位符会渲染成 `null` 或在格式化阶段 NPE。缺少运行时证据，故 LOW。

### L5（logic，LOW）maxPlayers 为 0/负数时所有玩家都被判满

第 241 行用 `>=` 比较玩家数与上限，没有对 `getMaxPlayers()` 做下界校验。配置写错（0）或未初始化时，`getPlayerCount() >= 0` 恒真，`canJoin` 恒 false，GUI 对所有玩家永久不可加入。属数值边界类可疑点，需看 arena 配置来源才能定论。

### L6（error-handling，LOW）GUI 标题未判空即传入 createInventory

第 75 行取语言键 `gui-arena-select-title` 后，第 76 行直接 `Bukkit.createInventory(holder, 54, title)`。若语言文件缺该键且 `getFor` 返回 null，createInventory 对 null 标题会抛异常，打开 GUI 的调用方没有 try/catch。是否真会返回 null 取决于 LanguageManager 实现（切片外），故 LOW。

## 3. 可达性判断

- 类实现 `Listener`，构造函数内 `Bukkit.getPluginManager().registerEvents(this, plugin)`（第 67 行），说明实例由插件主类创建并常驻。
- `openGUI(Player)` 是 public 入口，供命令/其他 GUI 调用；`onInventoryClick` / `onInventoryDrag` 是事件入口。
- 综合派发 hint 与上述结构证据，判 `PROD`（生产可达，优先深挖）。

## 4. 自检

- 每条 lead 的 quote 均为本回合 read 到的单行原文，line 为该行行号。
- `lead_count = 6`，histogram 之和 = 6。
- 覆盖：切片唯一文件已全文读取并给出短引。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "sweep-slice-19",
  "role": "sweep",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/.run-dsh3/artifacts/round1-02-sweep-slice-19.md",
  "payload": {
    "slice_id": "slice-19",
    "reachability": "PROD",
    "generator_ref": null,
    "files_read": [
      {
        "path": "src/main/java/com/hilltopvillage/gui/ArenaSelectionGUI.java",
        "lines": 338,
        "quote": "public class ArenaSelectionGUI implements Listener {"
      }
    ],
    "files_unreadable": [],
    "leads": [
      {
        "lead_id": "L1",
        "suspected_dimension": "logic",
        "file": "src/main/java/com/hilltopvillage/gui/ArenaSelectionGUI.java",
        "line": 244,
        "quote": "return state == GameState.WAITING || state == GameState.STARTING;",
        "why_suspicious": "canJoin 允许 STARTING，但图标 switch 无 STARTING 分支，落入 default 的 WOODEN_SWORD（类注释称其为不可用样式）。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L2",
        "suspected_dimension": "contract",
        "file": "src/main/java/com/hilltopvillage/gui/ArenaSelectionGUI.java",
        "line": 329,
        "quote": "arenaManager.joinArena(player, arena.getArenaId());",
        "why_suspicious": "先 closeInventory 再调用 joinArena，返回值未检查，join 失败时玩家得不到任何反馈。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L3",
        "suspected_dimension": "logic",
        "file": "src/main/java/com/hilltopvillage/gui/ArenaSelectionGUI.java",
        "line": 85,
        "quote": "if (slot >= 45) break; // Max 45 arenas (5 rows)",
        "why_suspicious": "注释称保留底行做导航，实际超过 45 个竞技场即静默丢弃且没有任何翻页或提示。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L4",
        "suspected_dimension": "error-handling",
        "file": "src/main/java/com/hilltopvillage/gui/ArenaSelectionGUI.java",
        "line": 158,
        "quote": "lore.add(languageManager.getFor(player, \"gui-arena-lore-map\", arena.getWorldName()));",
        "why_suspicious": "地图缺失（世界未加载）是正常状态，但 getWorldName() 未判空就作为语言占位符参数。",
        "confidence": "LOW"
      },
      {
        "lead_id": "L5",
        "suspected_dimension": "logic",
        "file": "src/main/java/com/hilltopvillage/gui/ArenaSelectionGUI.java",
        "line": 241,
        "quote": "if (arena.getPlayerCount() >= arena.getMaxPlayers()) return false;",
        "why_suspicious": "maxPlayers 为 0 或负数时该比较恒真，所有玩家都被判满、GUI 永久不可加入。",
        "confidence": "LOW"
      },
      {
        "lead_id": "L6",
        "suspected_dimension": "error-handling",
        "file": "src/main/java/com/hilltopvillage/gui/ArenaSelectionGUI.java",
        "line": 75,
        "quote": "String title = languageManager.getFor(player, \"gui-arena-select-title\");",
        "why_suspicious": "标题直接来自语言键且未判空，缺键返回 null 时 createInventory 会抛异常，调用方无兜底。",
        "confidence": "LOW"
      }
    ],
    "lead_count": 6,
    "dimension_histogram": {
      "logic": 2,
      "concurrency": 0,
      "security": 0,
      "error-handling": 2,
      "data-consistency": 0,
      "contract": 2
    }
  },
  "error": null
}
```
