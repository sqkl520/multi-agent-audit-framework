# slice-01 宽扫（admin 三件套）

- status: COMPLETE
- trace_id: trace-r1-20260215-hilltop-dsh3
- round_id: round1
- slice_id: slice-01
- files: `AdminDeployManager.java` (860 行) / `ArenaAdminService.java` (794 行) / `ArenaResetService.java` (634 行)
- reachability: PROD（三个类都是插件管理 GUI / 命令的数据层与编排器，由 `HilltopVillagePlugin`/`GameManager`/`MultiArenaManager` 装配后从管理入口调用）

## 扫法说明

按 6 维度快扫，重点放在这三类代码共有的两个结构特征上：

1. **arenas.yml 的「整份读-改-写」**：`YamlFileGate.load()` → 改内存副本 → `gate.write(整份)`，任何一处没有先重读、或一次操作拆成两次写盘，都会产生半成功 / 复活 / 回滚覆盖。
2. **多步破坏性编排**：`ArenaResetService` 先 `disableArena`、删 nodes.yml、清 arenas.yml、回滚地图，中途失败只有部分步骤有回滚（nodes 有、shop NPC 实体没有），异常兜底路径与 `abort()` 的恢复语义不一致。

未发现明确的异步/Bukkit 世界状态并发点：三个文件都声明主线程使用，未见 `runTaskAsynchronously` / `CompletableFuture` / 自建线程；预览粒子走 `BukkitRunnable`（主线程），因此 `concurrency` 记 0。

## Leads（6 条，均只做定位，不判严重性）

### L1 节点只删掉一部分时不会中止
`ArenaResetService.proceed` 用 `expectedNodes > 0 && removedNodes == 0` 判失败；若 `clearNodesForWorld` 返回 0 < removed < expected（部分写入），条件不成立，重置继续清空 arenas.yml 并回滚地图，nodes.yml 里残留的条目就变成无主节点。
- `src/main/java/com/hilltopvillage/admin/ArenaResetService.java:295`，quote：`if (expectedNodes > 0 && removedNodes == 0) {`

### L2 异常兜底路径不恢复启用状态
`reset()` 的 `catch (RuntimeException)` 只 `releaseInFlight` + `deliver`，没有走 `abort()` → `reinstateRestoring()`。而 `proceed` 在删节点前就已 `disableArena`；一旦第 6–9 步抛未预期异常，竞技场停在 DISABLED 且 `core`/`enabled` 都还在，与 `abort()` 明确设计的「可完全恢复」相反。
- `src/main/java/com/hilltopvillage/admin/ArenaResetService.java:244`，quote：`if (releaseInFlight(key)) {`

### L3 商店 NPC 实体先删、配置后清，失败不回滚
第 7 步 `despawnOwnShopNpc(world)` 在第 8 步 `clearDeploymentData` 之前执行；第 8 步失败时 `abort()` 会把节点补回并重新启用竞技场，但已被清掉的商店实体没有恢复路径，而 arenas.yml 里的 `shop-npc` 仍在——恢复后的竞技场可能「配置有商店、世界里没有实体」直到重启/重新加载。
- `src/main/java/com/hilltopvillage/admin/ArenaResetService.java:312`，quote：`if (despawnOwnShopNpc(world)) {`

### L4 一次保存拆成两次整份写盘
`saveSpawnPoints()` 先在 539 行 `gate.write(arenasConfig)` 落生成点/核心，再调 `saveShopNpcLocation()`——该方法重新 `gate.load()` 后第二次整份写盘。第二次失败时磁盘是「生成点已更新、shop-npc 仍旧」的半成功状态，而内存已在 550–554 行按第一次写入刷新，返回值只给一个 false。
- `src/main/java/com/hilltopvillage/admin/AdminDeployManager.java:557`，quote：`if (!saveShopNpcLocation()) {`

### L5 旧数据迁移用陈旧副本整份覆写
`migrateLegacyShopNpc` 直接改 `arenasConfig` 字段并 `gate.write(arenasConfig)`，写前没有像 `saveSpawnPoints` / `saveShopNpcLocation` 那样重新 `load()`；该字段是 `loadSpawnPoints()` 早先读入的整份副本，期间 `ArenaManager.updateGameParams` / 其它竞技场的保存若已落盘，会被这次迁移整份回滚。
- `src/main/java/com/hilltopvillage/admin/AdminDeployManager.java:399`，quote：`if (gate == null || !gate.write(arenasConfig)) {`

### L6 只读视图走了可能触发隔离的 load 路径
`buildView` 是纯只读的 GUI 视图构建，每个竞技场都会调 `loadArenas()` → `gate.load()`；按 `AdminDeployManager` 第 471–475 行自己的注释，`load()` 本身可能把正在用的 arenas.yml 改名成 `*.corrupt` 并上闩只读。也就是说「打开管理 GUI 看一眼」可能产生写盘侧的破坏性副作用。
- `src/main/java/com/hilltopvillage/admin/ArenaAdminService.java:542`，quote：`YamlConfiguration yaml = loadArenas();`

## 覆盖与偏差

- 切片 3 个文件全部逐行读完；未读切片外文件（未用「同目录多读 1 个」的余量）。
- 未发现 `GENERATED` 标记；三个文件均无生成器头。
- 时间盒内未对 `NodeSystem.clearNodesForWorld` / `YamlFileGate.load` 的实现做交叉核实，L1 / L6 的最终定性依赖这两个类的实际语义（深挖阶段验证）。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "sweep-slice-01",
  "role": "sweep",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/.run-dsh3/artifacts/round1-02-sweep-slice-01.md",
  "payload": {
    "slice_id": "slice-01",
    "reachability": "PROD",
    "generator_ref": null,
    "files_read": [
      {
        "path": "src/main/java/com/hilltopvillage/admin/AdminDeployManager.java",
        "lines": 860,
        "quote": "public boolean saveSpawnPoints() {"
      },
      {
        "path": "src/main/java/com/hilltopvillage/admin/ArenaAdminService.java",
        "lines": 794,
        "quote": "public boolean deleteSpawnPoint(String arenaId, int index) {"
      },
      {
        "path": "src/main/java/com/hilltopvillage/admin/ArenaResetService.java",
        "lines": 634,
        "quote": "public void reset(String arenaId, Consumer<Outcome> onDone) {"
      }
    ],
    "files_unreadable": [],
    "leads": [
      {
        "lead_id": "L1",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/admin/ArenaResetService.java",
        "line": 295,
        "quote": "if (expectedNodes > 0 && removedNodes == 0) {",
        "why_suspicious": "只把 removed==0 当失败，部分删除（0<removed<expected）会继续重置，nodes.yml 残留无主节点。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L2",
        "suspected_dimension": "error-handling",
        "file": "src/main/java/com/hilltopvillage/admin/ArenaResetService.java",
        "line": 244,
        "quote": "if (releaseInFlight(key)) {",
        "why_suspicious": "异常兜底只释放 in-flight 并回调，不调用 abort/reinstate，已 disableArena 的竞技场会静默停在 DISABLED。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L3",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/admin/ArenaResetService.java",
        "line": 312,
        "quote": "if (despawnOwnShopNpc(world)) {",
        "why_suspicious": "商店实体在 clearDeploymentData 之前删除，后一步失败中止并重新启用时实体不会恢复，配置里的 shop-npc 仍在。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L4",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/admin/AdminDeployManager.java",
        "line": 557,
        "quote": "if (!saveShopNpcLocation()) {",
        "why_suspicious": "一次保存拆成两次整份写盘，第二次失败留下生成点已更新、shop-npc 未更新的半成功磁盘状态。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L5",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/admin/AdminDeployManager.java",
        "line": 399,
        "quote": "if (gate == null || !gate.write(arenasConfig)) {",
        "why_suspicious": "迁移写盘前不重新 load，用 loadSpawnPoints 期间的陈旧整份副本覆写，可能回滚其它写入方的落盘内容。",
        "confidence": "LOW"
      },
      {
        "lead_id": "L6",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/admin/ArenaAdminService.java",
        "line": 542,
        "quote": "YamlConfiguration yaml = loadArenas();",
        "why_suspicious": "只读的 buildView 调用 loadArenas -> gate.load()，而 load 可能把 arenas.yml 隔离成 .corrupt 并上闩只读。",
        "confidence": "LOW"
      }
    ],
    "lead_count": 6,
    "dimension_histogram": {
      "logic": 0,
      "concurrency": 0,
      "security": 0,
      "error-handling": 1,
      "data-consistency": 5,
      "contract": 0
    }
  },
  "error": null
}
```
