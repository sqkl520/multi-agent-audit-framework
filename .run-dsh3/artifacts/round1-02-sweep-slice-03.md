# slice-03 宽扫（admin/gui：AbstractAdminMenu + ArenaManageGUI）

- trace_id: trace-r1-20260215-hilltop-dsh3
- round_id: round1
- slice_id: slice-03
- role: sweep
- status: COMPLETE
- 被审仓库（只读）: `D:\Server\MCServers\Server plugin\Hilltop Village\Hilltop Village Plugin`

## 1. 覆盖范围

| 文件 | 行数（LF 实测） | 读法 |
|---|---|---|
| `src/main/java/com/hilltopvillage/admin/gui/AbstractAdminMenu.java` | 78 | 逐行读完 |
| `src/main/java/com/hilltopvillage/admin/gui/ArenaManageGUI.java` | 1036 | 逐行读完 |

未读其他文件；未对被审仓库做任何写入。

> 行数口径：两文件均为 LF 换行（`\n` 78 / 1036 个），与 `wc -l` 口径一致。用 PowerShell `Get-Content .Count` 会得到 68 / 974，与本口径不符，故以直接统计 `\n` 的值为准，并已用原始字节核对行 496 / 663 / 772 的内容与行号一致。

## 2. 可达性：PROD

- `ArenaManageGUI` 在命令层被 `new` 出来并经 `registerEvents` 注册：
  - `src/main/java/com/hilltopvillage/command/HilltopCommandHandler.java:665` `ArenaManageGUI gui = new ArenaManageGUI(admin, plugin);`
  - 同文件 `:666` `Bukkit.getPluginManager().registerEvents(gui, plugin);`
  - 同文件 `:26` `import com.hilltopvillage.admin.gui.ArenaManageGUI;`
- `AbstractAdminMenu` 是 `ArenaManageGUI` 的父类（`ArenaManageGUI.java:65`），随子类一并可达。
- 结论：两条文件都从管理命令入口可达，标 `PROD`（不是 ENTRY：它们是被命令代码直接实例化的类，不是脚本入口）。

（上述三行为浅层 grep 命中，用于可达性判断；未把该文件计入 `files_read`。）

## 3. 六维快扫记录

| 维度 | 扫到的点 | 处置 |
|---|---|---|
| `logic` | 分页 `clampPage` / `pageCount` 边界（0 条目走 `(totalEntries-1)/PAGE_SIZE`，Java 整除截断为 0，未发现缺陷）；视图栈 `openView`/`goBack`/`applyView` 的 `pendingResetArenaId` 清理配对正常；`reportReset` 的 restore-skipped 分支缺 `return`，会连发两条口径不同的消息 → L5 | 1 条 |
| `concurrency` | 类注释声明「纯主线程」，`handleResetOutcome` 的 `reopen()` 依赖 `ArenaResetService` 的同步/主线程保证（本切片无法证伪，仅记为背景）；`@EventHandler` 挂在每次打开都 new 的 GUI 实例上，且命令层每次打开都 `registerEvents` → L3 | 1 条 |
| `security` | GUI 内点击动作（重置/删除/禁用/传送）在本类内均无权限节点复核，权限只在打开菜单时生效 → L4 | 1 条 |
| `error-handling` | `confirmReset`/`applyParam` 对服务调用无 try/catch（异常会冒到事件分发线程）；`shopNpc` 返回 null 已用 `shop == null ? "-"` 兜住；未发现空吞 catch | 0 条 |
| `data-consistency` | `applyParam` 用点击瞬间的 `ArenaView` 快照回写其余三项 → L1 | 1 条 |
| `contract` | 列表删除用渲染时算出的全局 `index`，点击时不按当前列表重新定位/校验 → L2 | 1 条 |

## 4. 线索

| id | 维度 | 位置 | 置信 |
|---|---|---|---|
| L1 | data-consistency | ArenaManageGUI.java:663 | MEDIUM |
| L2 | contract | ArenaManageGUI.java:496 | MEDIUM |
| L3 | concurrency | AbstractAdminMenu.java:71 | MEDIUM |
| L4 | security | ArenaManageGUI.java:772 | LOW |
| L5 | logic | ArenaManageGUI.java:802 | MEDIUM |

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "sweep-slice-03",
  "role": "sweep",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/.run-dsh3/artifacts/round1-02-sweep-slice-03.md",
  "payload": {
    "slice_id": "slice-03",
    "reachability": "PROD",
    "generator_ref": null,
    "files_read": [
      {
        "path": "src/main/java/com/hilltopvillage/admin/gui/AbstractAdminMenu.java",
        "lines": 78,
        "quote": "if (event.getView().getTopInventory().getHolder() != this) return;"
      },
      {
        "path": "src/main/java/com/hilltopvillage/admin/gui/ArenaManageGUI.java",
        "lines": 1036,
        "quote": "int lastPage = Math.max(0, (totalEntries - 1) / PAGE_SIZE);"
      }
    ],
    "files_unreadable": [],
    "leads": [
      {
        "lead_id": "L1",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/admin/gui/ArenaManageGUI.java",
        "line": 663,
        "quote": "int min = arena.minPlayers();",
        "why_suspicious": "applyParam 用点击瞬间的 ArenaView 快照回写未修改的三项参数，聊天栏输入期间经命令改过的参数会被旧值覆盖（类注释 640-642 自认此取舍）。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L2",
        "suspected_dimension": "contract",
        "file": "src/main/java/com/hilltopvillage/admin/gui/ArenaManageGUI.java",
        "line": 496,
        "quote": "boolean deleted = deleteLocation(kind, arenaId, index);",
        "why_suspicious": "删除用渲染时算出的全局 index，点击时不按当前列表重新定位也不校验边界，渲染后列表被外部命令改动会删错点位。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L3",
        "suspected_dimension": "concurrency",
        "file": "src/main/java/com/hilltopvillage/admin/gui/AbstractAdminMenu.java",
        "line": 71,
        "quote": "public void guardClick(InventoryClickEvent event) {",
        "why_suspicious": "@EventHandler 挂在每次打开菜单都 new 的 GUI 实例上，而命令层每次打开都 registerEvents(gui)（HilltopCommandHandler.java:666），未见 unregisterAll，监听器随打开次数累积并持有 Player/Inventory 引用。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L4",
        "suspected_dimension": "security",
        "file": "src/main/java/com/hilltopvillage/admin/gui/ArenaManageGUI.java",
        "line": 772,
        "quote": "resetService().reset(arenaId, outcome -> handleResetOutcome(outcome, nodesBefore, worldName));",
        "why_suspicious": "破坏性重置在点击时直接执行，本类内未见权限节点复核，权限若只在打开菜单时校验，撤权后已打开的菜单仍可执行。",
        "confidence": "LOW"
      },
      {
        "lead_id": "L5",
        "suspected_dimension": "logic",
        "file": "src/main/java/com/hilltopvillage/admin/gui/ArenaManageGUI.java",
        "line": 802,
        "quote": "if (\"restore\".equals(failStep) && outcome.mapRestoreSkipped() && !outcome.mapRestored()) {",
        "why_suspicious": "该分支发完 fail-skipped-world 后没有 return，会继续执行 805 行的 manage.reset.partial + failStepText(\"restore\")，一次失败向管理员播报两条口径冲突的消息。",
        "confidence": "MEDIUM"
      }
    ],
    "lead_count": 5,
    "dimension_histogram": {
      "logic": 1,
      "concurrency": 1,
      "security": 1,
      "error-handling": 0,
      "data-consistency": 1,
      "contract": 1
    }
  },
  "error": null
}
```
