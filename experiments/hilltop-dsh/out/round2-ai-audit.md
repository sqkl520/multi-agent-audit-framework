# 第二轮 AI 模块静态审计（Hilltop Village）

审计范围：`src/main/java/com/hilltopvillage/ai/` 下 5 个 Goal 文件。以下结论均来自本轮逐行阅读与调用链核对，未修改任何源码。

## 1. ExplodeBeetleGoal 把节点伤害倍率直接当成 Bukkit 爆炸威力

`ExplodeBeetleGoal.java:226-230` 先按 `nodeDamage = resolveBaseDamage(monsterCfg) * explodeMultiplier * nodeMultiplier;` 计算节点伤害，同处注释也写明这是“怪物爆炸伤害 = 对玩家的基础攻击伤害 × 怪物爆炸倍率”。但 `ExplodeBeetleGoal.java:241` 写的是 `world.createExplosion(nodeLoc, (float) explodeMultiplier, false, false, beetle);`，把同一个 `explodeMultiplier` 原样传给了 Bukkit 的 `power`。Bukkit 的 `power` 决定爆炸半径与实体伤害，并不是“节点伤害倍率”；当 `entity-explosion` 保持默认开启时，配置里的 0.5–10 会直接变成爆炸威力，数值 10 时波及范围和实体伤害远大于“基础伤害 × 倍率”的语义。两条路径对同一个 `explode-damage-multiplier` 给出不同含义：节点伤害走乘法，实体爆炸走威力，且 `Math.max(0, ...)` 没有上限或有限值裁剪。

## 2. AirdropSpawnGoal 对空 airdrop-mob-type 触发 NPE，且每 tick 重试

`AirdropSpawnGoal.java:234` 取的是 `String mobTypeName = monsterCfg != null ? monsterCfg.getAirdropMobType() : "ZOMBIE";`；而 `ConfigManager.java:1645` 在 YAML 键存在但值为空时会把 `null` 写进 `MonsterConfig`，setter 没有回退。随后 `AirdropSpawnGoal.java:237` 执行 `mobType = EntityType.valueOf(mobTypeName.toUpperCase(Locale.ROOT));`，`mobTypeName` 为 null 时先抛 NPE；238 行只捕获 `IllegalArgumentException`，NPE 会直接逃出 `executeAirdrop()`。`tick()` 在 135 行调用 `executeAirdrop()`、136 行才清空 `targetDropLocation`，所以异常后目标仍在，`shouldStayActive()` 继续为真，下一 tick 再次执行并再次 NPE，冷却和清理都不会发生。触发条件只是把 `monsters.flying-dropper.airdrop-mob-type` 留空；这会让该空投批次和对应 activeMobs 永久卡住。

## 3. AirdropSpawnGoal 跨世界距离计算缺少 world 守卫

`AirdropSpawnGoal.java:107` 写的是 `&& dropper.getLocation().distanceSquared(targetDropLocation) > STAY_ACTIVE_DISTANCE_SQ`。`Location#distanceSquared` 在两个 Location 世界不同时会抛 `IllegalArgumentException`，这里没有先比较 `getWorld()`；`tick()` 的 134 行同样直接对 `dropperLoc` 和 `flyTarget` 做 `distanceSquared`。一旦 dropper 在持有 target 时被外部插件或管理员传送到别的世界，`shouldStayActive()` 会在每次 goal selector 查询时抛异常，`stop()` 不会被调用，`targetDropLocation` 与冷却状态都不会重置，空投永远不会完成。对比同包 `DropperAttackGoal.java:189-191` 已在距离计算前显式检查 `dropperLoc.getWorld() != gameWorld`，说明这里是遗漏而非世界不可能变化。

## 4. DropperAttackGoal 的 30 格限制只在首次锁定时生效

`DropperAttackGoal.java:204` 的 `if (distSq <= HUNT_RANGE_SQ && distSq < bestDistSq) {` 是 `findNearestPlayer()` 中唯一的范围门，`HUNT_RANGE_SQ = 900.0` 对应 30 格，42 行注释也写明“别从半张地图外横穿过来耽误空投”。但 `shouldStayActive()` 在 99 行只调用 `isValidArenaTarget(target)`，`tick()` 在 130 行继续用 `multiply(DIVE_SPEED)` 追当前 target，二者都不再检查距离。玩家在锁定后跑出 30 格甚至跨半张地图，dropper 仍会持续追击，目标只有死亡、离开竞技场或换世界才失效；空投冷却结束后也不会重新选近目标。这把“搜索半径”变成了“首次锁定半径”，与 42 行声明的行为不一致，也会让 dropper 长期离开空投点。

## 5. HookClawHunterGoal 候选过滤不排除死亡玩家

`HookClawHunterGoal.java:180` 的 `if (player == null || !player.isOnline()) continue;` 没有 `!player.isDead()`，而同一文件的 `isValidArenaTarget()` 在 350 行明确写了 `&& !player.isDead()`。`shouldActivate()` 通过 `findValidTarget()` 选中死亡玩家后会返回 true，`start()` 进入瞄准；下一 tick `tick()` 在 113 行用 `isValidArenaTarget(currentTarget, ...)` 立即判 false，`stop()` 在 106 行设置 60 tick 冷却，一枪未发。若死亡玩家仍在 `gameManager.getPlayers()` 且分数靠前，每轮都会再次被选中，钩爪怪会持续把冷却消耗在死人身上，真正的活目标被饿死。

## JSON 信封

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "ai",
  "role": "audit",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "round2-ai-audit.md",
  "payload": {
    "slice_id": "round2-ai",
    "searched_scope": {
      "files_read": [
        "src/main/java/com/hilltopvillage/ai/NodeAttackGoal.java",
        "src/main/java/com/hilltopvillage/ai/ExplodeBeetleGoal.java",
        "src/main/java/com/hilltopvillage/ai/AirdropSpawnGoal.java",
        "src/main/java/com/hilltopvillage/ai/DropperAttackGoal.java",
        "src/main/java/com/hilltopvillage/ai/HookClawHunterGoal.java"
      ],
      "files_in_slice": 5,
      "shared_dependencies_read": [
        "src/main/java/com/hilltopvillage/core/WaveManager.java",
        "src/main/java/com/hilltopvillage/mechanics/NodeSystem.java",
        "src/main/java/com/hilltopvillage/config/GameConfig.java",
        "src/main/java/com/hilltopvillage/HilltopVillagePlugin.java"
      ],
      "dimension_checklist": [
        "logic",
        "concurrency",
        "error-handling",
        "data-consistency",
        "contract"
      ]
    },
    "findings": [
      {
        "finding_id": "R2-AI-001",
        "severity": "HIGH",
        "dimension": "data-consistency",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/ai/ExplodeBeetleGoal.java",
          "line": 241,
          "quote": "world.createExplosion(nodeLoc, (float) explodeMultiplier, false, false, beetle);"
        },
        "inference": {
          "claim": "配置项 explode-damage-multiplier 在节点伤害路径中被当作倍率相乘，在实体爆炸路径中却被直接当作 Bukkit 爆炸 power，同一配置产生两种不同的数值语义。",
          "basis": "226-230 行计算 nodeDamage 时使用 resolveBaseDamage(monsterCfg) * explodeMultiplier * nodeMultiplier，说明该字段是节点伤害倍率；241 行却把同一个值作为 createExplosion 的 power。Bukkit 的 power 控制爆炸半径和实体伤害，不是节点伤害的乘法系数，因此开启 entity-explosion 时行为与字段注释和节点公式不一致。",
          "alternatives": [
            "如果 explodeMultiplier 的设计语义本来就是 Bukkit 爆炸 power，而不是节点伤害倍率，那么 241 行不算错，但 GameConfig.java:292 的字段注释和 230 行的节点伤害公式需要同时改写。",
            "如果 entity-explosion 默认关闭，实体爆炸路径不会触发；但 GameConfig 中 entityExplosion 默认为 true，且代码保留了该分支。"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "R2-AI-002",
        "severity": "HIGH",
        "dimension": "error-handling",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/ai/AirdropSpawnGoal.java",
          "line": 237,
          "quote": "mobType = EntityType.valueOf(mobTypeName.toUpperCase(Locale.ROOT));"
        },
        "inference": {
          "claim": "airdrop-mob-type 为空时 mobTypeName 为 null，toUpperCase 抛出 NPE；该异常不被后面的 IllegalArgumentException catch 捕获，executeAirdrop 每 tick 重复失败，目标与 activeMobs 无法清理。",
          "basis": "234 行从 MonsterConfig.getAirdropMobType() 取值，ConfigManager.java:1645 在 YAML 值为空时直接 setAirdropMobType(null)，setter 没有默认值回退；237 行先解引用 mobTypeName，238 行只捕获 IllegalArgumentException。tick 的 135 行调用 executeAirdrop，136 行才清 targetDropLocation，所以异常发生在清理之前，下一 tick 仍满足 shouldStayActive 并再次进入同一路径。",
          "alternatives": [
            "如果配置加载层在 airdrop-mob-type 为空时保留旧值或默认值而不是写入 null，则 NPE 触发不了；ConfigManager.java:1645 当前没有这种保护。",
            "如果 executeAirdrop 外层还有捕获 Throwable 的调度器，异常可能只被记录而不终止服务器 tick；但目标不会被清空，下一次 tick 仍会重复 NPE。"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "R2-AI-003",
        "severity": "MEDIUM",
        "dimension": "error-handling",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/ai/AirdropSpawnGoal.java",
          "line": 107,
          "quote": "&& dropper.getLocation().distanceSquared(targetDropLocation) > STAY_ACTIVE_DISTANCE_SQ"
        },
        "inference": {
          "claim": "AirdropSpawnGoal 在 shouldStayActive 和 tick 中直接对两个 Location 调用 distanceSquared，没有先检查世界；dropper 跨世界时每次查询都会抛 IllegalArgumentException，空投状态无法收尾。",
          "basis": "107 行和 134 行都未比较 getWorld()，而 Bukkit 的 Location#distanceSquared 在跨世界时抛 IllegalArgumentException。dropper 被外部插件或管理员传送后，goal selector 每次调用 shouldStayActive 都会异常，stop 不会执行，targetDropLocation 和冷却不会重置；同包 DropperAttackGoal.java:189-191 已经在距离计算前做了 world 检查，证明项目内存在同类防护需求。",
          "alternatives": [
            "如果服务器或插件保证 flying-dropper 永远不会被传送到其他世界，那么该异常路径不会发生；同包 DropperAttackGoal 仍为此写了显式守卫。",
            "如果 Paper 的 Location#distanceSquared 对跨世界返回无穷大而不是抛异常，则不成立；但 Bukkit API 的契约是抛 IllegalArgumentException，代码没有 world 检查。"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "R2-AI-004",
        "severity": "MEDIUM",
        "dimension": "logic",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/ai/DropperAttackGoal.java",
          "line": 204,
          "quote": "if (distSq <= HUNT_RANGE_SQ && distSq < bestDistSq) {"
        },
        "inference": {
          "claim": "HUNT_RANGE_SQ 只在 findNearestPlayer 首次选目标时生效，shouldStayActive 和 tick 不再检查距离，导致锁定后可以无限追击超出 30 格的目标。",
          "basis": "204 行是 findNearestPlayer 中唯一的距离门，HUNT_RANGE_SQ 为 900.0（30 格）；99 行 shouldStayActive 只调用 isValidArenaTarget(target)，130 行 tick 继续按 DIVE_SPEED 朝当前 target 移动，二者都没有距离条件。玩家离开 30 格后目标仍然合法，dropper 会持续追击，直到目标死亡、离开竞技场或换世界。",
          "alternatives": [
            "如果设计就是锁定后无限追击，那么 42 行注释应改为首次搜索半径；当前注释和 shouldStayActive 的实现不一致。",
            "如果 isValidArenaTarget 内部包含距离检查，则不会发生；实际 212-221 行只检查在线、死亡、游戏状态、竞技场、世界和游戏模式。"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "R2-AI-005",
        "severity": "LOW",
        "dimension": "data-consistency",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/ai/HookClawHunterGoal.java",
          "line": 180,
          "quote": "if (player == null || !player.isOnline()) continue;"
        },
        "inference": {
          "claim": "findValidTarget 的候选过滤没有排除死亡玩家，而 isValidArenaTarget 会排除；这会让 shouldActivate 选中死人、start 进入瞄准，下一 tick 立即 stop 并进入冷却，浪费攻击窗口。",
          "basis": "180 行只检查 null 和 isOnline，没有 isDead；350 行 isValidArenaTarget 明确包含 !player.isDead()。shouldActivate 通过 findValidTarget 选中死亡玩家后返回 true，start 设置 active 和 aimTicks；tick 的 113 行用 isValidArenaTarget 复核时立即判 false，106 行 stop 设置 60 tick 冷却，射击不会发生。",
          "alternatives": [
            "如果死亡玩家会立刻从 gameManager.getPlayers() 移除，候选集不会包含死人，问题不成立；但 findDropLocation 和 isValidArenaTarget 都保留死亡判断，说明死亡玩家可能仍在集合内。",
            "如果 targetScore 对死亡玩家返回极低分，死人不会被选中；需检查 targetScore 实现，当前过滤阶段先把死人加入了 candidates。"
          ]
        },
        "status": "CONFIRMED"
      }
    ],
    "self_checks": {
      "identifier_reconcile": {
        "status": "DONE",
        "note": "已核对 5 个 Goal 的类名、GoalKey、配置 getter 及 WaveManager 注册点，发现与证据中的标识符均能在源码中找到定义或调用点。"
      },
      "self_check_audit": {
        "status": "DONE",
        "note": "已逐条回读 evidence 的 file:line 与原文，确认引用为单行逐字文本，并检查正文与 JSON 的发现编号、严重度和维度一致。"
      },
      "runtime_validation": {
        "status": "SKIPPED",
        "note": "仅进行静态代码审计，未启动 Paper 服务器实测；运行时行为均由调用链和 Bukkit API 契约推导。"
      }
    }
  },
  "error": null
}
```
