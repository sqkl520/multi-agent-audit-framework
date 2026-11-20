# slice-10 宽扫（单文件超大切片：SetupWizard.java）

- status: COMPLETE
- trace_id: trace-r1-20260215-hilltop-dsh3
- round_id: round1
- slice_id: slice-10
- 被审文件: `src/main/java/com/hilltopvillage/command/SetupWizard.java`
- 读取范围: **1–2286 行，全文 100%**（分 4 段读完：1-480 / 481-960 / 961-1440 / 1441-2286）
- 范围偏差声明（任务书 §9.4）：任务书写 2287 物理行，`read` 实测 **2286** 行，差 1 行（多半是末尾换行计数口径）；以实测 2286 为准，不影响覆盖。

## 切片性质

一个类就是整个交互式部署向导：`/hilltop setup` 的聊天子命令分发（`handle`，1218-1674）+ 6 个 54 格 GUI 的点击处理器（1733-2189）+ 会话/上下文缓存（34、44）+ 落盘（1676-1730）+ 退出清理（2191-2203）。状态机由 `SetupSession.step`（1..8，`advance()` 就是 `step++`，2284）+ 持久化副本 `wizard.step.<uuid>` / `wizard.arena.<uuid>`（1684-1687）两层组成。

状态机骨架本身相当克制：聊天子命令**每一条**都写了 `if (s.step != N)` 守卫，`goto` 有 `1..TOTAL_STEPS` 区间校验和 `try/catch NumberFormatException`（1638-1668），完成收口有 `validateCompletion` 四项复核（1173-1206）。可疑点集中在**旁路**：GUI 点击路径没有步骤守卫、落盘顺序、以及"解析不到部署管理器"时的失败开放。

## 线索

### L1 · GUI 删除分支的裸 `parseInt`（同族另两处已包 try）
- `1944` / `2022`：`handleSpawnGuiClick`、`handleMobSpawnGuiClick` 的 `default` 分支直接 `Integer.parseInt(tag.substring("setup-spawn-".length()))`，**无 try**。
- 同文件同族分支却都包了：村民 `1858-1883`、节点 `2111-2134`，catch 里还专门写了"tag 格式漂移的第一信号必须留痕"的注释。
- 这不是"不可达所以无所谓"：作者自己在另外两处认定 tag 可能漂移。四处的输入源完全同类（`refreshXxxGui` 里 `"setup-spawn-" + i`）。
- 触发后果不是"静默"而是"外抛"：异常穿过 `@EventHandler`，Bukkit 会打整段堆栈并继续 tick，玩家侧只看到点了没反应。

### L2 · GUI 点击处理器完全没有步骤守卫，聊天路径每条都有
- `handleVillagersGuiClick` 的 `case "setup-villagers-done"`（1845）直接 `s.advance()`（1851），不校验 `s.step == 5`；`handleNodesGuiClick` 的 `setup-nodes-done`（2077-2091）、`handlePreviewGuiClick` 的 `setup-confirm`（2147-2182）同样不校验。
- 对照：聊天路径 `villagers-done` 有 `if (s.step != 5)`（1544）、`confirm-nodes` 有 `if (s.step != 4)`（1446）。
- GUI 窗口会跨越步骤存活：`goto` 只改 `s.step` 并重发消息，**不 closeInventory**（1632-1669）；聊天 `villagers-done` 也不关界面（1542-1556，对比 `confirm-nodes` 1457、`tryFinishSpawnsStep` 546 都关）。于是"第 6 步 + 仍开着的村民界面"这种组合可达，再点一次 [完成] 就把 step 推到 7，跳过强制的商店步骤。`validateCompletion`（1189-1194）只能在第 8 步兜回来，中间已经写盘。

### L3 · `autoSave`：arenas.yml 写失败仍然把 step 指针写进 config.yml
- `autoSave`（1676-1700）：先 `saved = ...saveToFile()`（1680），**无论 saved 真假**都 `plugin.getConfig().set("wizard.step." + uuid, s.step)` 然后 `plugin.saveConfig()`（1684-1687），最后才在 1693 播报失败。
- 结果：数据文件没落盘、进度指针落盘了。重启后 `start()` 按 `savedStep` 恢复（240-260），玩家落在"第 3 步但生成点其实没写进 arenas.yml"的状态；`showStep` 里 `deploy(player).getSpawnPoints()` 读的是内存旧值，界面看起来正常，直到重启后才暴露。
- 方法内的注释（1677-1679）正是为了"不让管理员以为已保存"，但顺序把这条意图抵消了一半。

### L4 · 完成复核"解析不出部署管理器就放行"（fail-open）
- `validateCompletion` 第一行：`if (d == null) return true;`（1175），注释明确写着"世界被卸载等极端情况不额外拦截"。
- 但这是**唯一**的四项必填收口（`showStepDone` 1012、`goto 8` 1664、step=8 恢复三条路都走它）。一旦 `deploy(player)` 为 null（arena 世界被 Multiverse 卸载 / 定义被 reload 掉 / `createDeploymentContext` 因 `Bukkit.getWorld` 返回 null 而返回 null，见 151-158），`showStepDone` 会继续往下走：`sessions.remove`、清 `wizard.step`/`wizard.arena`（1060-1065）、`finishDeployment` 调 `reloadDefinitions + enableArena`（171-183）。
- 即：校验失效的那一次，恰好也是"把半成品竞技场推进启用队列 + 抹掉续传进度"的那一次，且不可回退。

### L5 · 部署期上下文只重载生成点与节点，村民 / 商店仍是构造时的旧内存
- `deploymentGameManager` 命中缓存时刷新的只有两样：`cached.getAdminDeployManager().loadSpawnPoints();`（133）与 `cached.getNodeSystem().loadNodesFromConfig();`（143）。
- 上方的长注释（130-140）把动机写得很清楚：构造时缓存了整份 arenas.yml 副本，不刷新就会"拿旧内存值把外部改动整份写回"。**但村民列表与商店 NPC 位置没有对应的 reload 调用**——同一个 `AdminDeployManager` 实例里的这两份内存副本仍然会整份写回。
- 于是"管理 GUI 清了村民/商店 → 向导第 5/6 步再保存一次 → 清掉的东西复活"这条路在 spawn/nodes 被堵上之后，剩下 villagers/shop 两个口子。

### L6 · `deploy(player)` 可返回 null，但 40+ 处调用点直接解引用
- 证据：同文件里作者**五处**显式防了 null——`gameManager` 的 `arenaId == null ? null : ...`（66）、`deploy` 的 `gm == null ? null : ...`（72）、`syncVillagerPreviews` 的 `if (d == null) return;`（731）、`showStepDone` 的 `deploy == null ? null : ...`（1021）、`sendWaitingReminder` 的 `if (d == null && def == null) return;`（1141）。
- 但大量路径直接点：`sendShopStatus` 的 `Location shop = deploy(player).getShopNpcLocation();`（921）、`clear-shop` 的 `deploy(player).getShopNpcLocation()`（1344）、`showStepVillagers` 的 `deploy(player).getVillagers().size()`（875）、`autoSave` 的 `gameManager(player).getConfigManager()`（1680）。
- 触发面不是理论：`saveexit` 明确不销毁会话（1610-1631），会话可长期存活；世界被卸载/定义被移除后 `deploymentGameManager` 返回 null，此时任意一条聊天按钮（聊天历史里的旧按钮仍可点）都会 NPE 在命令处理器里，且发生在 `autoSave` 之前——内存已改、盘未写。

## 看过但没有列为线索的点（避免下游重复劳动）

| 位置 | 观察 | 为什么不列 |
|---|---|---|
| 34 `sessions` | `ConcurrentHashMap`，退出/完成时移除 | 键是 UUID、上界是玩家数，不构成泄漏；`SetupSession` 字段只在主线程写 |
| 44 `deploymentContexts` | 缓存 GameManager（内含 World 引用），只在 `finishDeployment`/`invalidateDeploymentContext` 丢弃 | 上界 = 竞技场数；持有 World 的 GC 影响属推断，缺运行时证据 → 已并入 L5 的内存侧讨论，不单列 |
| 2185 `setup-reset` | 只把 `s.step = 1`，不清任何已采集数据 | 可能是"重走流程、保留已配点"的设计意图，lang 文案不可见，判不了 |
| 1746-1750 | 只按 title 匹配，不查 `event.getClickedInventory()` | `event.setCancelled(true)` 对整视图生效，物品拿不走；未构成越权面 |
| 2219-2222 `makeItem` / 2235 `infoItem` | `meta` 未判空就 `setDisplayName` | 常规 Material 的 ItemMeta 恒非空，且同文件 `taggedItem` 已判空，属风格不一致 |
| 112-148 | `computeIfAbsent` 的 mapping function 内调 `Bukkit.getWorld` / new GameManager | 全文件无异步调用点，主线程串行；无并发证据 |
| 1517-1533 / 1969-2039 | 刷怪点与生成点两套实现高度重复（复制粘贴） | 复制本身不是缺陷；L1 的 parseInt 缺失正是这种复制的产物 |

## 可达性

`PROD`。依据（grep 全 `src/main/java`，未读第二个文件正文）：`HilltopVillagePlugin.java:181` 在 onEnable `new SetupWizard(this)`，`:187` 注释写明"监听器常驻注册"；`HilltopCommandHandler.java:47/119` 持有 `plugin.getSetupWizard()` 并转发 `/hilltop setup` 子命令；`ArenaResetService.java:351` 调 `invalidateDeploymentContext`。即：生产入口（插件启用 + 命令）→ 本文件全部方法。

## 覆盖记账

- read 调用：10 次（5 次框架文档 + 4 段本文件 + 1 次 check-payload 片段），未超 20 次上限。
- 本切片仅 1 个文件，已 100% 覆盖；无 `files_unreadable`。
- 未做：未读 `AdminDeployManager` / `MultiArenaManager` / lang 文件，因此 L5 的"旧内存写回"、L1 的"tag 何时漂移"都只到"可疑"级别，未验证。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "sweep-slice-10",
  "role": "sweep",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/.run-dsh3/artifacts/round1-02-sweep-slice-10.md",
  "payload": {
    "slice_id": "slice-10",
    "reachability": "PROD",
    "generator_ref": null,
    "files_read": [
      {
        "path": "src/main/java/com/hilltopvillage/command/SetupWizard.java",
        "lines": 2286,
        "quote": "public class SetupWizard implements Listener {"
      }
    ],
    "files_unreadable": [],
    "leads": [
      {
        "lead_id": "L1",
        "suspected_dimension": "contract",
        "file": "src/main/java/com/hilltopvillage/command/SetupWizard.java",
        "line": 1944,
        "quote": "int idx = Integer.parseInt(tag.substring(\"setup-spawn-\".length()));",
        "why_suspicious": "GUI 删除分支裸 parseInt 无 try，而同族村民(1859)/节点(2112)分支都包了 try 并留痕，输入源同为插件自造 tag。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L2",
        "suspected_dimension": "logic",
        "file": "src/main/java/com/hilltopvillage/command/SetupWizard.java",
        "line": 1845,
        "quote": "case \"setup-villagers-done\":",
        "why_suspicious": "GUI 点击处理器不校验 s.step 就直接 advance()，而聊天路径每条子命令都有步骤守卫，且 goto 不关闭已打开的界面。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L3",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/command/SetupWizard.java",
        "line": 1687,
        "quote": "plugin.saveConfig();",
        "why_suspicious": "autoSave 在 saveToFile() 返回 false 时仍写入 wizard.step 并 saveConfig，进度指针落盘而数据未落盘。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L4",
        "suspected_dimension": "error-handling",
        "file": "src/main/java/com/hilltopvillage/command/SetupWizard.java",
        "line": 1175,
        "quote": "if (d == null) return true;",
        "why_suspicious": "四项必填复核在解析不到部署管理器时直接放行(true)，而放行后紧接着会清会话与进度并 enableArena。",
        "confidence": "HIGH"
      },
      {
        "lead_id": "L5",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/command/SetupWizard.java",
        "line": 133,
        "quote": "cached.getAdminDeployManager().loadSpawnPoints();",
        "why_suspicious": "缓存上下文只重载 spawnPoints 与 nodes，villagers/shop 仍是构造期内存副本，注释所述的整份写回风险只剩这两项未堵。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L6",
        "suspected_dimension": "error-handling",
        "file": "src/main/java/com/hilltopvillage/command/SetupWizard.java",
        "line": 921,
        "quote": "Location shop = deploy(player).getShopNpcLocation();",
        "why_suspicious": "deploy() 可返回 null 且同文件五处显式防了 null，但 sendShopStatus/clear-shop/autoSave 等调用点直接解引用。",
        "confidence": "MEDIUM"
      }
    ],
    "lead_count": 6,
    "dimension_histogram": {
      "logic": 1,
      "concurrency": 0,
      "security": 0,
      "error-handling": 2,
      "data-consistency": 2,
      "contract": 1
    }
  },
  "error": null
}
```
