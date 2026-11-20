# slice-04 宽扫（Hilltop Village / `com.hilltopvillage.ai` 的 5 个 Paper 实体 Goal）

- trace_id: `trace-r1-20260215-hilltop-dsh3`
- round_id: `round1`
- slice_id: `slice-04`
- status: COMPLETE
- 被审仓库（只读）: `D:\Server\MCServers\Server plugin\Hilltop Village\Hilltop Village Plugin`
- 文件数: 5，全部读完（无 `files_unreadable`）

## 0. 切片摘要

这 5 个类都是 Paper 的 `com.destroystokyo.paper.entity.ai.Goal<Mob>` 实现，由 `core/WaveManager.java` 在刷怪时注册
（`addGoal` 调用点：`WaveManager.java:364/589/637/642/697/702`），因此切片从生产入口可达 → `reachability = PROD`。
5 个类共有的形态是：`shouldActivate()` 里做节流倒数 + 选目标，`tick()` 里推进/攻击，`stop()` 里设冷却。

数值边界（NaN/0/负值）、跨世界 `distanceSquared`、对象引用相等做「目标是否变化」的判据、以及自毁出列没有一次性闩锁，
是这一片最集中的四类可疑点。

## 1. 可达性判定（PROD）

| 证据 | 位置 |
|---|---|
| `Bukkit.getMobGoals().addGoal(mob, 3, new NodeAttackGoal(mob, gameManager));` | `core/WaveManager.java:364` |
| `Bukkit.getMobGoals().addGoal(spider, 1, new ExplodeBeetleGoal(spider, gameManager));` | `core/WaveManager.java:589` |
| `Bukkit.getMobGoals().addGoal(skeleton, 1, new HookClawHunterGoal(skeleton, gameManager));` | `core/WaveManager.java:637` |
| `Bukkit.getMobGoals().addGoal(phantom, 1, new AirdropSpawnGoal(phantom, gameManager));` | `core/WaveManager.java:697` |
| `Bukkit.getMobGoals().addGoal(phantom, 2, new DropperAttackGoal(phantom, gameManager));` | `core/WaveManager.java:702` |

（以上 5 行由 `grep` 在同一仓库内取得，仅用于可达性定位，不构成 lead 的证据主体。）

## 2. 逐维度扫视记录

| 维度 | 本片看到的东西 |
|---|---|
| `logic` | 目标「是否变化」用 `!=` 引用比较；`pathToNode()` 与 `targetCenter` 的 Y 偏移不一致；自毁出列后每 tick 重复调用；缓存目标不复核搜索半径 |
| `error-handling` | `AirdropSpawnGoal` 的 `distanceSquared` 未做世界一致性守卫（同包 `DropperAttackGoal` 做了） |
| `concurrency` | 5 个类全部是 Goal（主线程 tick），`HookClawHunterGoal` 的 `BukkitRunnable` 也是 sync 调度；未发现异步触碰世界状态的路径 |
| `security` | 无命令/权限/GUI 输入；配置值经 `EntityType.valueOf` 且有兜底；未发现可利用面 |
| `data-consistency` | `damageNode(loc, NaN)` 可能把 NaN 写进节点血量（见 L2 的下游后果） |
| `contract` | Goal 接口契约（`shouldActivate`/`shouldStayActive`/`start`/`stop`/`tick`）实现齐全，未发现签名不匹配 |

## 3. 线索

| id | 维度 | 位置 | 置信度 | 一句话 |
|---|---|---|---|---|
| L1 | error-handling | AirdropSpawnGoal.java:107 | HIGH | 跨世界 `distanceSquared` 无守卫 |
| L2 | logic | ExplodeBeetleGoal.java:243 | HIGH | `Math.max(0, NaN)` 仍为 NaN |
| L3 | logic | ExplodeBeetleGoal.java:170 | MEDIUM | 宽限期到点后每 tick 重复 `discardMob` |
| L4 | logic | NodeAttackGoal.java:232 | MEDIUM | 寻路点比攻击判定点高 0.5 格 |
| L5 | logic | NodeAttackGoal.java:131 | MEDIUM | 用引用不等判断「目标变了」 |
| L6 | logic | DropperAttackGoal.java:88 | MEDIUM | 复用缓存目标时不复核 30 格搜索半径 |

## 4. 读过的文件

| 文件 | 行数 | 说明 |
|---|---|---|
| `src/main/java/com/hilltopvillage/ai/AirdropSpawnGoal.java` | 268 | 空投落点扫描 + 空投执行 |
| `src/main/java/com/hilltopvillage/ai/DropperAttackGoal.java` | 222 | 抛投者俯冲骚扰 |
| `src/main/java/com/hilltopvillage/ai/ExplodeBeetleGoal.java` | 279 | 自爆甲虫推进/引爆 |
| `src/main/java/com/hilltopvillage/ai/HookClawHunterGoal.java` | 357 | 钩爪猎手瞄准/投射物 |
| `src/main/java/com/hilltopvillage/ai/NodeAttackGoal.java` | 283 | 普通怪物打节点 |

## 5. 不做的事（边界声明）

- 不判严重性、不构建完整证据链、不写 findings；
- 未读取切片外文件（可达性只用 `grep` 命中行定位，未把 `WaveManager.java` 计入 `files_read`）；
- 未对被审仓库做任何写入。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "sweep-slice-04",
  "role": "sweep",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/.run-dsh3/artifacts/round1-02-sweep-slice-04.md",
  "payload": {
    "slice_id": "slice-04",
    "reachability": "PROD",
    "generator_ref": null,
    "files_read": [
      {
        "path": "src/main/java/com/hilltopvillage/ai/AirdropSpawnGoal.java",
        "lines": 268,
        "quote": "private static final int SCAN_RETRY_INTERVAL_TICKS = 20;"
      },
      {
        "path": "src/main/java/com/hilltopvillage/ai/DropperAttackGoal.java",
        "lines": 222,
        "quote": "private static final double HUNT_RANGE_SQ = 900.0;"
      },
      {
        "path": "src/main/java/com/hilltopvillage/ai/ExplodeBeetleGoal.java",
        "lines": 279,
        "quote": "private static final int    NO_TARGET_SELF_DESTRUCT_TICKS = 100;"
      },
      {
        "path": "src/main/java/com/hilltopvillage/ai/HookClawHunterGoal.java",
        "lines": 357,
        "quote": "private static final double MIN_SHOOT_DIST_SQ = 64.0;"
      },
      {
        "path": "src/main/java/com/hilltopvillage/ai/NodeAttackGoal.java",
        "lines": 283,
        "quote": "private static final double ATTACK_RANGE = 3.0;"
      }
    ],
    "files_unreadable": [],
    "leads": [
      {
        "lead_id": "L1",
        "suspected_dimension": "error-handling",
        "file": "src/main/java/com/hilltopvillage/ai/AirdropSpawnGoal.java",
        "line": 107,
        "quote": "&& dropper.getLocation().distanceSquared(targetDropLocation) > STAY_ACTIVE_DISTANCE_SQ",
        "why_suspicious": "targetDropLocation 属于 gameWorld，而 dropper 可用外部传送/换世界脱离该世界；此处直接 distanceSquared 未先比 world，跨世界会抛 IllegalArgumentException，同包 DropperAttackGoal 在 :191 明确为此加了守卫而这里没有。",
        "confidence": "HIGH"
      },
      {
        "lead_id": "L2",
        "suspected_dimension": "logic",
        "file": "src/main/java/com/hilltopvillage/ai/ExplodeBeetleGoal.java",
        "line": 243,
        "quote": "double nodeMultiplier = Math.max(0, cfg.getNodeSelfDestructMultiplier());",
        "why_suspicious": "上一行注释自己写明 NaN 会穿透 Math.max(0, NaN)，但只守了 explodeMultiplier，nodeMultiplier 仍走 Math.max，NaN 会传进 nodeDamage → damageNode(loc, NaN)。",
        "confidence": "HIGH"
      },
      {
        "lead_id": "L3",
        "suspected_dimension": "logic",
        "file": "src/main/java/com/hilltopvillage/ai/ExplodeBeetleGoal.java",
        "line": 170,
        "quote": "gameManager.getWaveManager().discardMob(beetle);",
        "why_suspicious": "noTargetTicks 到点后没有置位/清零的闩锁也没 return 之外的退出条件，beetle 若未立即失效，下一 tick 仍进同一分支再次 discardMob，重复出列；:201 的卡死分支同样是先 discardMob 再 return。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L4",
        "suspected_dimension": "logic",
        "file": "src/main/java/com/hilltopvillage/ai/NodeAttackGoal.java",
        "line": 232,
        "quote": "Location nodeCenter = targetNode.getLocation().add(0.5, 1, 0.5);",
        "why_suspicious": "寻路终点用 +1.0 的 Y，而同文件 :129 的攻击判定基准 targetCenter 用 +0.5 的 Y，两处高度基准不一致（ExplodeBeetleGoal:122 也是 +1）。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L5",
        "suspected_dimension": "logic",
        "file": "src/main/java/com/hilltopvillage/ai/NodeAttackGoal.java",
        "line": 131,
        "quote": "return previousTarget != targetNode;",
        "why_suspicious": "「目标是否变了」用 NodeData 对象的引用不等来判断；若 getNearestNode 每次返回新的包装对象，同一节点也会判成 changed，tick() 里的 stuckTicks 会被每 30 tick 清零，:209 的 60-tick 卡死兜底可能永远到不了。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L6",
        "suspected_dimension": "logic",
        "file": "src/main/java/com/hilltopvillage/ai/DropperAttackGoal.java",
        "line": 88,
        "quote": "if (target != null && isValidArenaTarget(target)) return true;",
        "why_suspicious": "这条复用分支只校验目标合法，不复核 HUNT_RANGE_SQ（:42 的 900.0 平方格）也不复核距离，玩家跑远后抛投者会一直追；shouldStayActive(:99) 同样没有距离条件。",
        "confidence": "MEDIUM"
      }
    ],
    "lead_count": 6,
    "dimension_histogram": {
      "logic": 5,
      "concurrency": 0,
      "security": 0,
      "error-handling": 1,
      "data-consistency": 0,
      "contract": 0
    }
  },
  "error": null
}
```
