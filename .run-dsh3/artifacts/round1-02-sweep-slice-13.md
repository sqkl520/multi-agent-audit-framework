# slice-13 宽扫（config/menu GUI 点击契约 + 数值输入）

- trace_id: `trace-r1-20260215-hilltop-dsh3`
- round_id: `round1` / slice_id: `slice-13`
- 被审仓库（只读）：`D:\Server\MCServers\Server plugin\Hilltop Village\Hilltop Village Plugin`
- 角色：sweep（只出线索，不判严重性、不做完整证据链）
- 覆盖：切片 7 个文件全部逐行读完（`config/menu/` 下另有 `WaveSettingsMenu.java` 未在切片内，未读）

## 1. 可达性判定：PROD

浅层引用检查（grep，非测试代码）：

| 引用点 | 内容 |
|---|---|
| `src/main/java/com/hilltopvillage/command/HilltopCommandHandler.java:647` | `MainConfigMenu menu = new MainConfigMenu(admin, cm, lang);` |
| `src/main/java/com/hilltopvillage/HilltopVillagePlugin.java:200` | `Bukkit.getPluginManager().registerEvents(new NumericInputHandler(), this);` |

`MainConfigMenu` 被命令处理器实例化 → 五個子菜单经 `openSubMenu(new GameRulesMenu(...))` 等同文件构造点进入；`NumericInputHandler` 在插件启用时注册为监听器。故整片判 `PROD`（不是 TEST_ONLY / UNREACHABLE）。

## 2. 重点维度的正向核对（这些点没写成 lead）

按派发重点逐条核对 `AbstractConfigMenu.onClick`（第 153–173 行），下列契约点**已正确处理**，因此不产出线索：

| 检查点 | 现状 |
|---|---|
| `getClickedInventory()` 是否为 null | 第 165 行判了 null 并 return |
| 点击是否落在本菜单 inventory | 第 159 行（top inventory）与第 166 行（clicked inventory）双重比对 |
| `getSlot()` 越界 | 分发前已限定 clicked inventory 必须是本菜单，`clickActions.get(slot)` 为 map 查表，无裸下标 |
| `getCurrentItem()` null | 本类不读 `getCurrentItem()` |
| `InventoryClickEvent` 是否 `setCancelled` | 第 161 行在分发动作前无条件取消 |
| Shift 点击（点进玩家背包） | 第 159 行按 top inventory 取消，第 166 行再拒绝非本菜单点击，动作不会误触发 |
| 左右键白名单 | `GameRulesMenu` 第 135/139 行已显式收窄到 `RIGHT` / `LEFT`（注释记录了旧版 else 兜底会吞掉 MIDDLE/DROP/NUMBER_KEY） |
| 数值输入负数/0/超大/空串 | `NumericInputHandler` 第 194 行拦 `!isFinite` 与 `|v|>1e9`，第 200 行按槽位 min/max clamp，空串走 `NumberFormatException` 分支重挂 |

## 3. 线索

### L1 — 菜单构建中途 return，跳过后退按钮与填充
`MonsterSettingsMenu.buildMenu()` 在第 81 行取 `cfg.getMonsters().get(monsterKey)`，第 82 行 `if (mc == null) return;` 直接返回。而 `setBackButton(...)`（第 266 行）与 `fillEmpty()`（第 267 行）都在这个 return 之后。若某个怪物键在配置里缺失（或页面键与配置键不一致），管理员会得到一个**没有返回按钮**的 54 格菜单，只能按 ESC 退出，且 `clickActions` 里只剩第 9–11 行的三个页签。这是 GUI 导航契约的破口，不是纯样式问题。

### L2 — 材质循环槽位不读 ClickType（无左右键白名单）
`ItemSettingsMenu.addMaterialCycle` 的点击动作（第 240–244 行）对任意 `ClickType` 都执行 `nextMat(...)` 并写回配置。也就是说 `DROP`（丢弃键）、`NUMBER_KEY`（热键）、`MIDDLE`、`DOUBLE_CLICK` 都会静默改配置；同一仓库的 `GameRulesMenu` 第 139–146 行已把兜底 else 收窄成显式 `LEFT` 白名单，并留注释说明「丢出键或热键会静默改配置」。两个菜单口径不一致，说明这是遗留而非设计。同类：第 45–52 行页签按钮同样忽略 `ct`。

### L3 — 布尔开关槽位任意点击都翻转
`MonsterSettingsMenu` 第 210–217 行「自爆是否附带原版实体爆炸」的槽位，动作体是 `ct -> { mc.setEntityExplosion(!mc.isEntityExplosion()); reopen(); }`，完全不判 `ClickType`。双击（`LEFT, LEFT, DOUBLE_CLICK`）会连翻多次，丢弃键/热键也会翻转；lore 只写了 `click-cycle`，没有声明哪些键有效。与 L2 同族但后果不同：这里翻转的是影响战斗表现的布尔值，且没有「当前值未变」的兜底。

### L4 — 缺 `InventoryDragEvent` 处理器，拖拽未被取消
`AbstractConfigMenu` 只有 `onClick(InventoryClickEvent)`（第 153 行）与 `onClose(InventoryCloseEvent)`（第 175 行）两个处理器，没有 `InventoryDragEvent` 分支。点击路径靠第 161 行 `event.setCancelled(true)` 拦住，但拖拽是独立事件：把物品从玩家背包拖进 GUI 上半区不会被取消，GUI 里的图标可能被替换/被拿走。同仓库 `admin/gui/AbstractAdminMenu.java:15` 的注释把「父类没有 `InventoryDragEvent` 处理器」明确记成缺口①，说明这是已知的一类缺陷形态，而 `config/menu` 这一支没有跟进。

### L5 — 人数上下限各自 clamp，可写出 min > max
`GameRulesMenu` 第 36–44 行：`min-players` 的 setter 是 `Math.min(20, Math.max(1, v))`，`max-players` 的 setter 是 `Math.min(20, Math.max(2, v))`，两者互不知道对方。管理员可以先把 `max-players` 调到 2，再把 `min-players` 调到 20，配置里就留下 `minPlayers=20 > maxPlayers=2`。同文件第 66–71 行的 `spawn-max-radius` 已经用 `effectiveMin`（`spawnRadiusMin + 5`）做了跨字段下界，人数这一对没有同样处理——同一文件里两种口径，像漏改而不是有意。

### L6 — 非法聊天输入重挂并重设计时，30 秒窗口可被无限续期
`NumericInputHandler.onChat` 第 206–215 行：解析失败时新建 `renewed` 条目并调用 `scheduleNumberTimeout(event.getPlayer(), renewed);`（第 214 行）。于是玩家在 SHIFT 输入态里每打一条**非数字**的公屏消息，都会把 30 秒超时重新计时一次——消息被 `setCancelled(true)` 吞掉，窗口却不会自然到期。类注释（第 208–210 行）认为重挂是为了避免「每条聊天都被吞掉的永久劫持条目」，但重挂同时把「等待到期退出」这条恢复路径取消了：只有输入 `cancel` 或打开任意容器（第 247 行 `onInventoryOpen`）才能脱身。

## 4. 其他观察（未计入 leads）

- `NodeSettingsMenu` 第 35–53 行的 int 槽位用 double helper，SHIFT 路径经 `requestNumber` 按 min/max clamp，再经 `(int)` 截断；小数输入会被静默截断（如 10.9 → 10），没有提示。属体验问题，未单列线索。
- `ItemSettingsMenu` 第 77 行 `hammer.max-uses` 的 min 为 0：菜单本身不说明 0 是否表示「无限次」，语义取决于 `GameConfig`，本切片无法判定。
- `NumericInputHandler` 第 189 行 `Double.parseDouble` 接受 Java 浮点字面量（`1d`、`0x1p3`、`+5`），没有严格格式校验；对管理员输入场景影响很小，仅记录。
- `MainConfigMenu` 第 26 行权限判定只在 `buildMenu()` 时做一次，点击动作不再复核权限；菜单只对 `admin` 本人可点（`AbstractConfigMenu` 第 156 行），未构成越权路径。

## 5. 覆盖清单

| 文件 | 行数 | 读取方式 |
|---|---|---|
| `src/main/java/com/hilltopvillage/config/menu/AbstractConfigMenu.java` | 183 | 全文 read |
| `src/main/java/com/hilltopvillage/config/menu/GameRulesMenu.java` | 157 | 全文 read |
| `src/main/java/com/hilltopvillage/config/menu/ItemSettingsMenu.java` | 282 | 全文 read |
| `src/main/java/com/hilltopvillage/config/menu/MainConfigMenu.java` | 189 | 全文 read |
| `src/main/java/com/hilltopvillage/config/menu/MonsterSettingsMenu.java` | 476 | 全文 read |
| `src/main/java/com/hilltopvillage/config/menu/NodeSettingsMenu.java` | 112 | 全文 read |
| `src/main/java/com/hilltopvillage/config/menu/NumericInputHandler.java` | 294 | 全文 read |

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "sweep-slice-13",
  "role": "sweep",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/.run-dsh3/artifacts/round1-02-sweep-slice-13.md",
  "payload": {
    "slice_id": "slice-13",
    "reachability": "PROD",
    "generator_ref": null,
    "files_read": [
      {
        "path": "src/main/java/com/hilltopvillage/config/menu/AbstractConfigMenu.java",
        "lines": 183,
        "quote": "public void onClick(InventoryClickEvent event) {"
      },
      {
        "path": "src/main/java/com/hilltopvillage/config/menu/GameRulesMenu.java",
        "lines": 157,
        "quote": "() -> cfg.getMinPlayers(), v -> cfg.setMinPlayers(Math.min(20, Math.max(1, v))),"
      },
      {
        "path": "src/main/java/com/hilltopvillage/config/menu/ItemSettingsMenu.java",
        "lines": 282,
        "quote": "Material next = nextMat(current, cycle);"
      },
      {
        "path": "src/main/java/com/hilltopvillage/config/menu/MainConfigMenu.java",
        "lines": 189,
        "quote": "boolean isAdmin = admin.hasPermission(ConfigPermission.ADMIN.getNode());"
      },
      {
        "path": "src/main/java/com/hilltopvillage/config/menu/MonsterSettingsMenu.java",
        "lines": 476,
        "quote": "if (mc == null) return;"
      },
      {
        "path": "src/main/java/com/hilltopvillage/config/menu/NodeSettingsMenu.java",
        "lines": 112,
        "quote": "double val = getter.getAsDouble() - step;"
      },
      {
        "path": "src/main/java/com/hilltopvillage/config/menu/NumericInputHandler.java",
        "lines": 294,
        "quote": "double value = Double.parseDouble(msg);"
      }
    ],
    "files_unreadable": [],
    "leads": [
      {
        "lead_id": "L1",
        "suspected_dimension": "contract",
        "file": "src/main/java/com/hilltopvillage/config/menu/MonsterSettingsMenu.java",
        "line": 82,
        "quote": "if (mc == null) return;",
        "why_suspicious": "这个 return 在 setBackButton/fillEmpty 之前，怪物键缺失时菜单会没有返回按钮，管理员只能按 ESC 退出。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L2",
        "suspected_dimension": "contract",
        "file": "src/main/java/com/hilltopvillage/config/menu/ItemSettingsMenu.java",
        "line": 241,
        "quote": "Material next = nextMat(current, cycle);",
        "why_suspicious": "点击动作不读 ClickType，DROP/NUMBER_KEY/MIDDLE/DOUBLE_CLICK 都会写回配置，而同仓库 GameRulesMenu 已收窄为 LEFT 白名单。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L3",
        "suspected_dimension": "contract",
        "file": "src/main/java/com/hilltopvillage/config/menu/MonsterSettingsMenu.java",
        "line": 211,
        "quote": "ct -> { mc.setEntityExplosion(!mc.isEntityExplosion()); reopen(); },",
        "why_suspicious": "布尔开关对任意 ClickType 都翻转，双击与丢出键都会改配置，且 lore 未声明哪些键有效。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L4",
        "suspected_dimension": "contract",
        "file": "src/main/java/com/hilltopvillage/config/menu/AbstractConfigMenu.java",
        "line": 154,
        "quote": "public void onClick(InventoryClickEvent event) {",
        "why_suspicious": "类里只有 click 与 close 两个处理器，没有 InventoryDragEvent，拖拽把物品拖进 GUI 上半区不会被取消。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L5",
        "suspected_dimension": "logic",
        "file": "src/main/java/com/hilltopvillage/config/menu/GameRulesMenu.java",
        "line": 38,
        "quote": "() -> cfg.getMinPlayers(), v -> cfg.setMinPlayers(Math.min(20, Math.max(1, v))),",
        "why_suspicious": "min-players 与 max-players 各自独立 clamp，可以写出 minPlayers=20 而 maxPlayers=2 的组合，同文件 spawn-max-radius 却做了跨字段下界。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L6",
        "suspected_dimension": "error-handling",
        "file": "src/main/java/com/hilltopvillage/config/menu/NumericInputHandler.java",
        "line": 214,
        "quote": "scheduleNumberTimeout(event.getPlayer(), renewed);",
        "why_suspicious": "每条非法聊天输入都重挂条目并重置 30 秒超时，玩家靠等待退不出输入态，公屏消息被持续吞掉。",
        "confidence": "MEDIUM"
      }
    ],
    "lead_count": 6,
    "dimension_histogram": {
      "logic": 1,
      "concurrency": 0,
      "security": 0,
      "error-handling": 1,
      "data-consistency": 0,
      "contract": 4
    }
  },
  "error": null
}
```
