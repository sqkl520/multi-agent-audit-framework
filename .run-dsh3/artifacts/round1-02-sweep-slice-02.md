# slice-02 宽扫（round1 / Hilltop Village）

- trace_id: `trace-r1-20260215-hilltop-dsh3`
- slice_id: `slice-02`
- 被审仓库: `D:\Server\MCServers\Server plugin\Hilltop Village\Hilltop Village Plugin`（只读）
- 扫描范围: 3 个文件（切片给定的全部文件），无 shared_dependencies
- 扫描方式: 逐行通读 3 个文件 + 2 次只读 grep（仅用于可达性与文案键交叉核对，未通读命中文件）
- 性质: 线索（lead），不判严重性、不做完整证据链，允许后续被证伪

## 1. 切片内容概览

| 文件 | 行数 | 作用 |
|---|---|---|
| `src/main/java/com/hilltopvillage/admin/LocationParticlePreview.java` | 137 | 按 viewer UUID 隔离的坐标粒子预览任务（`BukkitRunnable` + `runTaskTimer`，4 tick 周期） |
| `src/main/java/com/hilltopvillage/admin/PointKind.java` | 71 | 五类点位的「颜色 + 文案键 + 预构造 DustOptions」枚举 |
| `src/main/java/com/hilltopvillage/admin/PointParticleRenderer.java` | 66 | 光柱（20 格 / 0.4 步长）+ 三条螺旋的 DUST 绘制 |

## 2. 逐维度快扫结论

| 维度 | 观察 |
|---|---|
| `logic` | 快照语义（浅拷贝 vs 注释宣称的保护）与枚举静态字段初始化顺序是主要可疑点；光柱循环的 `y += 0.4` 浮点累加实测为 51 次、末值 19.999999999999993，**未构成 off-by-one**，故不列线索 |
| `concurrency` | 全部路径在主线程 tick 内执行，`previewTasks` 用 `ConcurrentHashMap` 仅为可见性；未见异步回调，**本维度 0 条** |
| `security` | 无玩家输入进入路径/键/UUID 解析，无权限判定，无可被负值利用的数值；**本维度 0 条** |
| `error-handling` | 定时任务内的异常路径未清理任务表；「世界未加载」的判据只有 null 检查 |
| `data-consistency` | 异常导致任务表与实际任务状态可能不一致（陈旧条目） |
| `contract` | `PointKind` 提供的按类别文案键在本类中未被使用；`kind` 参数无空值校验 |

## 3. 可达性判定

`reachability = PROD`。依据（只读 grep 命中，未通读这些文件）：

- `HilltopVillagePlugin.java:143` — `this.locationParticlePreview = new LocationParticlePreview(this);`（插件启用时实例化）
- `HilltopVillagePlugin.java:429` — `public LocationParticlePreview getLocationParticlePreview()`
- `ArenaManageGUI.java:1018-1019` — `previewService()` 返回 `hilltop.getLocationParticlePreview()`
- `AdminDeployManager.java:187` — 另一条调用 `PointParticleRenderer.drawMarker(...)` 的生产路径
- 测试侧另有 `LocationParticlePreviewTest` / `PointParticleRendererTest` / `PointKindTest` 引用，但生产入口已存在，故非 TEST_ONLY

## 4. 线索

### L1 — 「世界未加载」只做了 null 检查

`if (world == null) continue;` 的注释宣称「世界未加载：跳过该点，不抛异常」，但未加载的世界其引用通常仍非 null，因此该分支未必覆盖注释声称的场景；异常会发生在 4 tick 周期的定时任务里。

### L2 — 预览忽略了 PointKind 的按类别文案键

`PointKind` 明确提供 `emptyKey()` / `showingKey()`，且其类注释称「同一种颜色同时用于两套预览系统」；部署侧 `AdminDeployManager` 确实用了 `kind.emptyKey()` / `kind.showingKey()`，而本类对空列表硬编码通用键 `manage.entry.particles-empty`、对开始提示硬编码 `manage.preview.header`，接收到的 `kind` 只用于取色。可对照 `AdminDeployManager.java:142` 与 `:150`。

### L3 — 「快照」是浅拷贝

注释称快照一份以避免源列表被改动，但 `new ArrayList<>(locations)` 只复制列表结构，`Location` 元素仍与调用方共享引用。

### L4 — 异常退出路径不清理任务表

`cancel()` 与 `removeIfCurrent(...)` 只写在正常结束分支里；若循环内 `drawMarker` 抛异常，条目会留在 `previewTasks` 中指向已死的任务。

### L5 — `kind` 在渲染侧被解引用但无空值校验

`show(...)` 未校验 `kind`，`drawMarker` 的 javadoc 只声明 world 由调用方保证非 null，随后直接 `kind.beamDust()`。

### L6 — 枚举常量先于其引用的静态字段初始化

`PointKind` 的枚举常量写在 `BEAM_DUST_SIZE` / `SPIRAL_DUST_SIZE` 声明之前，常量构造时按文本顺序这些静态字段尚未赋值；当前因 `1.0f` / `1.3f` 是编译期常量被 javac 内联而未显形。

## 5. 明确排除的候选（避免深挖浪费）

- 光柱循环 `for (double y = 0; y <= BEAM_HEIGHT; y += BEAM_STEP)`：用 IEEE-754 double 实测迭代 51 次（末值 19.999999999999993），与注释「共 51 次迭代」一致，不是 off-by-one。
- `viewer.getLocation().distanceSquared(loc)` 的跨世界 `IllegalArgumentException`：其前一行已用 `viewer.getWorld() != world` 过滤，当前不可达。
- `ticksElapsed` 为 `int` 而 `totalTicks` 为 `long` 的溢出：需要 `durationTicks > 2^31-1`（约 3.4 年）才可能触发，不列为线索。

## 6. 覆盖率与自检说明

- `files_read` 覆盖切片 3/3 个文件，无 `files_unreadable`。
- 未读取切片外文件；2 次 grep 仅取命中行，未通读。
- 行号以 Node.js `split(/\r?\n/)` 语义核对（`read` 工具编号与之一致）；PowerShell `Get-Content` 在本机对这些文件会合并部分行，已弃用其行号。
- 产物未对被审仓库做任何写入。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "sweep-round1-slice-02",
  "role": "sweep",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/.run-dsh3/artifacts/round1-02-sweep-slice-02.md",
  "payload": {
    "slice_id": "slice-02",
    "reachability": "PROD",
    "generator_ref": null,
    "files_read": [
      {
        "path": "src/main/java/com/hilltopvillage/admin/LocationParticlePreview.java",
        "lines": 137,
        "quote": "public void show(Player viewer, List<Location> locations, PointKind kind, long durationTicks) {"
      },
      {
        "path": "src/main/java/com/hilltopvillage/admin/PointKind.java",
        "lines": 71,
        "quote": "PointKind(String emptyKey, String showingKey, Color color) {"
      },
      {
        "path": "src/main/java/com/hilltopvillage/admin/PointParticleRenderer.java",
        "lines": 66,
        "quote": "static void drawMarker(World world, Location loc, PointKind kind, double angle, int ticksElapsed) {"
      }
    ],
    "files_unreadable": [],
    "leads": [
      {
        "lead_id": "L1",
        "suspected_dimension": "error-handling",
        "file": "src/main/java/com/hilltopvillage/admin/LocationParticlePreview.java",
        "line": 97,
        "quote": "if (world == null) continue;  // 世界未加载：跳过该点，不抛异常",
        "why_suspicious": "注释声称覆盖「世界未加载」，但判据只有引用为 null，未加载世界的引用通常仍非 null，逐点绘制仍会走进 spawnParticle。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L2",
        "suspected_dimension": "contract",
        "file": "src/main/java/com/hilltopvillage/admin/LocationParticlePreview.java",
        "line": 67,
        "quote": "if (lang != null) viewer.sendMessage(lang.getFor(viewer, \"manage.entry.particles-empty\"));",
        "why_suspicious": "PointKind 提供的 emptyKey()/showingKey() 按类别区分文案且部署侧确实在用，本类却硬编码通用键，传入的 kind 只用于取色，两套预览的文案契约不一致。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L3",
        "suspected_dimension": "logic",
        "file": "src/main/java/com/hilltopvillage/admin/LocationParticlePreview.java",
        "line": 72,
        "quote": "final List<Location> targets = new ArrayList<>(locations);",
        "why_suspicious": "上一行注释称「快照一份，避免预览过程中源列表被其它逻辑改动」，但这是浅拷贝，Location 元素仍与调用方共享引用。",
        "confidence": "LOW"
      },
      {
        "lead_id": "L4",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/admin/LocationParticlePreview.java",
        "line": 88,
        "quote": "removeIfCurrent(viewerId, getTaskId());",
        "why_suspicious": "任务表的清理只写在正常结束分支内，循环里 drawMarker 一旦抛异常就跳过 cancel/清理，previewTasks 会残留指向已死任务的条目。",
        "confidence": "LOW"
      },
      {
        "lead_id": "L5",
        "suspected_dimension": "contract",
        "file": "src/main/java/com/hilltopvillage/admin/PointParticleRenderer.java",
        "line": 52,
        "quote": "1, 0, 0, 0, 0, kind.beamDust());",
        "why_suspicious": "show(...) 未校验 kind，drawMarker 的 javadoc 也只声明 world 非 null，这里直接解引用 kind；null 会在 4 tick 周期的任务里抛 NPE。",
        "confidence": "LOW"
      },
      {
        "lead_id": "L6",
        "suspected_dimension": "logic",
        "file": "src/main/java/com/hilltopvillage/admin/PointKind.java",
        "line": 52,
        "quote": "this.beamDust = new Particle.DustOptions(color, BEAM_DUST_SIZE);",
        "why_suspicious": "枚举常量位于 BEAM_DUST_SIZE/SPIRAL_DUST_SIZE 声明之前，构造常量时按文本顺序这两个静态字段尚未赋值，当前只因它们是编译期常量被内联才没暴露成 0.0f 尺寸。",
        "confidence": "LOW"
      }
    ],
    "lead_count": 6,
    "dimension_histogram": {
      "logic": 2,
      "concurrency": 0,
      "security": 0,
      "error-handling": 1,
      "data-consistency": 1,
      "contract": 2
    }
  },
  "error": null
}
```
