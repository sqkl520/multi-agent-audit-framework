# slice-04 / logic 深挖审计（Hilltop Village 的 5 个 Paper 实体 Goal）

- trace_id: `trace-r1-20260215-hilltop-dsh3`
- round_id: `round1`
- slice_id: `slice-04`
- dimension: `logic`（本产物只报这一个维度）
- agent_id: `audit-slice-04-logic`
- 被审仓库（只读）: `D:\Server\MCServers\Server plugin\Hilltop Village\Hilltop Village Plugin`
- 结论: **CONFIRMED 1 条（LOW）**；NO_EVIDENCE_FOUND 0 条；L1–L6 全部处置（1 条越维度转 off-dimension，4 条 REJECTED，1 条 CONFIRMED）。

## 0. 方法与范围

本回合用 `read` 重新读取了切片全部 5 个文件、`shared_dependencies` 中的 `NodeSystem.java` 全文，以及为判定线索所需的直接被调用方片段：`WaveManager.discardMob`（:1025-1119）、`WaveManager.onMobDeath`（:780-834）、`ConfigManager` 的节点配置加载与爆炸倍率归一化（:760-804、:1470-1549）。切片外文件只读与结论直接相关的片段，不把整文件计入覆盖面。

**零写入**：未编辑、未新建、未构建被审仓库任何文件；未运行 maven/gradle（会写 `target/`）。

## 1. 线索逐条处置（L1–L6，一条不漏）

| id | 线索维度 | 本维度处置 | 依据（本回合回源） |
|---|---|---|---|
| L1 | error-handling | **OFF_DIMENSION** | `AirdropSpawnGoal.java:107` 直接 `dropper.getLocation().distanceSquared(targetDropLocation)`，未先比较 world；跨世界时 `Location#distanceSquared` 抛 `IllegalArgumentException`。同包 `DropperAttackGoal.java:191` 用 `dropperLoc.getWorld() != gameWorld` 守卫同一形态。这是未捕获异常的边界，属 error-handling，已写入 `off_dimension_notes`，不硬塞 logic。 |
| L2 | logic | **CONFIRMED → `F-slice-04-logic-01`（LOW）** | `ExplodeBeetleGoal.java:243` 对 `nodeMultiplier` 只做 `Math.max(0, ...)`；`Math.max(0, NaN)` 仍为 NaN、`Math.max(0, Infinity)` 仍为 Infinity。相邻的 `explodeMultiplier`（:241-242）做了 `Double.isFinite` 折算，同族守卫不一致。配置侧 `ConfigManager.java:1515` 对 `nodes.self-destruct-multiplier` 直接 `getDouble` 后 set，没有 `normalizeExplodeDamageMultiplier`（:776-784）那类非有限值归一化。下游 `NodeSystem.damageNode`（:696）用 `!Double.isFinite(damage)` 返回 0，因此**当前不写坏节点血量、不抛异常**，实际影响被降为 LOW。 |
| L3 | logic | **REJECTED** | `WaveManager.discardMob`（:1038-1042）：`if (mob.isValid()) mob.remove(); activeMobs.remove(mob);`。`remove()` 后 `beetle.isValid()` 为 false；`ExplodeBeetleGoal.shouldActivate()`（:87）与 `shouldStayActive()`（:137）都以 `beetle.isValid()` 为条件，下一 tick Goal 不再运行；且 `:169-172` 的 `discardMob` 后立即 `return`。同一 tick 不会重入，跨 tick 不会重跑，`discardMob` 自身对 `activeMobs` 也是幂等 remove。 |
| L4 | logic | **REJECTED** | `NodeAttackGoal.java:129` 的 `targetCenter` 用 `+0.5` 是**方块中心**（供 `lookAt` 与 3D 距离判定）；`:232` 的 `pathToNode` 用 `+1.0` 是**节点方块上方一格**（可站立方块 / `Pathfinder#moveTo` 终点）。两者不是同一坐标语义；把寻路终点改成 `+0.5` 会指向节点方块内部。垂直差 0.5 远小于 `ATTACK_RANGE = 3.0`（:32、:192），不构成射程或 off-by-one 缺陷。`ExplodeBeetleGoal.java:122` 对同一模式也用 `+1` 作为 `targetApproach`。 |
| L5 | logic | **REJECTED** | `NodeSystem.getNearestNode` 在 `:886` 执行 `nearest = node;`，返回的是 `activeNodes` 中**已存在的 `NodeData` 对象引用**，不是每次新建的包装对象；`loadNodesFromConfig`（:202-207）对同坐标节点复用 `nodes.get(loc)`。`isRegisteredActive`（:934）还用 `nodes.get(node.location) == node` 做身份校验。因此 `NodeAttackGoal.java:131` 的 `previousTarget != targetNode` 只在选择真的变化（或变 null）时为 true，不会因「新包装对象」每 30 tick 清零 stuckTicks。 |
| L6 | logic | **REJECTED** | `HUNT_RANGE_SQ` 的注释（`DropperAttackGoal.java:41-42`）明确是「锁定目标的**搜索半径**：别从半张地图外横穿过来耽误空投」；`:204` 在 `findNearestPlayer` 里执行该半径。`:86-88` 的复用分支注释说明其目的是「已有仍有效目标时避免每 tick 重扫」，`shouldStayActive`（:99-101）只判目标有效/游戏进行/实体有效，是**锁定后持续追击**的显式设计，不是漏守卫。且 `AirdropSpawnGoal` 优先级 1 高于本 Goal 的 2（类注释 :30-31），空投会抢占，不会因追击耽误空投。若产品要求「追出 30 格就放弃」，那是新需求，不是现有代码的逻辑错误。 |

## 2. 发现详情

### F-slice-04-logic-01 — `nodeMultiplier` 未对 NaN/Infinity 做本地折算，与相邻 `explodeMultiplier` 的守卫不一致（LOW）

**Evidence（本回合 `read` 原文，`ExplodeBeetleGoal.java:243`）**

```java
double nodeMultiplier = Math.max(0, cfg.getNodeSelfDestructMultiplier());
```

**Inference**

- `claim`：当 `nodes.self-destruct-multiplier` 为 NaN 或 Infinity 时，`Math.max(0, ...)` 会原样保留非有限值，使 `nodeDamage`（:244）变成 NaN/Infinity；下游 `NodeSystem.damageNode`（:696）用 `!Double.isFinite(damage)` 直接返回 0，所以**当前不会写坏节点血量、不会抛异常**，但本行声称的「钳到非负」对 NaN/Infinity 实际无效，非法配置被静默折算成 0 节点伤害且无日志。相邻的 `explodeMultiplier`（:241-242）对同一类输入做了 `Double.isFinite` 折算，同族守卫不一致。
- `basis`：第 241–242 行是 `Double.isFinite(rawExplodeMultiplier) && rawExplodeMultiplier > 0 ? rawExplodeMultiplier : 0`；第 243 行只有 `Math.max(0, ...)`。Java 语义下 `Math.max(0, Double.NaN)` 返回 NaN，`Math.max(0, Double.POSITIVE_INFINITY)` 返回 Infinity。配置侧 `ConfigManager.java:1515` 对 `nodes.self-destruct-multiplier` 仅 `settingsYaml.getDouble(...)` 后 `setNodeSelfDestructMultiplier`，而同文件 `:776-784` 的 `normalizeExplodeDamageMultiplier` 明确处理 NaN→0、+Infinity→10，并只被 `explode-damage-multiplier` 使用（:594/:1756 为调用点，属同族不对称）。控制流：`ExplodeBeetleGoal.tick():162 → :185-186 → explode():243-244 → :259 NodeSystem.damageNode():696 → return 0`。因此本条不是数据损坏，而是「本地守卫失效 + 非法配置静默归零」的低危逻辑缺陷。
- `alternatives`：
  1. 如果 `YamlFiles.gameSettingsValidator` 在加载阶段已拒绝 `.nan` / `.inf` 这类非有限 double，则该输入不可达、本条不成立——需检查 `YamlFiles.java` 的 `gameSettingsValidator`（本回合未读该文件，无法确认）。
  2. 如果所有 `setNodeSelfDestructMultiplier` 调用点都只接受 GUI 滑块值（`NodeSettingsMenu` 的 0.5–10、步长 0.5），则非有限值只能来自手改 `game-settings.yml`；`ConfigManager.java:1515` 本身不做有限性校验，故手改路径仍可达。
  3. 如果设计上把 `NodeSystem.damageNode:696` 的 `Double.isFinite` 视为该值的正式归一化点，则本行只是重复防御、无独立影响——需确认「每个消费点自守」是否为本项目约定；`explodeMultiplier` 的本地折算说明作者并不完全依赖下游。

**为什么定 LOW 而不是 HIGH**：sweep 的 L2 推测链「NaN → `damageNode(loc, NaN)` → NaN 写进节点血量」在第三段被 `NodeSystem.java:696` 明确挡住；本条没有数据损坏、没有异常、没有节点永久免疫的实际后果，剩余问题只是守卫不一致与非法配置静默归零。

## 3. REJECTED 线索的回源依据（摘要）

- **L3（重复 discardMob）**：`WaveManager.discardMob` 原文（:1038-1042）：
  ```java
  public void discardMob(LivingEntity mob) {
      if (mob == null) return;
      if (mob.isValid()) mob.remove();
      activeMobs.remove(mob);
  }
  ```
  `mob.remove()` 使实体立即失效；`ExplodeBeetleGoal.shouldStayActive()` 返回 `gameManager.isGameRunning() && beetle.isValid()`（:137），下一 tick 即为 false。`:170` 的 `discardMob` 后紧接 `return`（:172），同一 tick 也不会再次进入该分支。故「宽限期到点后每 tick 重复 discardMob」不成立。
- **L4（Y 偏移）**：`targetCenter = nearest.getLocation().add(0.5, 0.5, 0.5)`（:129）是方块中心；`pathToNode` 的 `add(0.5, 1, 0.5)`（:232）是节点上方可站立方块。`mobLoc.distance(targetCenter) <= ATTACK_RANGE`（:192）中 0.5 的垂直差远小于 3.0，不构成射程错误。`ExplodeBeetleGoal` 的 `targetApproach` 同样用 `+1` 并在字段注释（:63）说明用途。
- **L5（引用比较）**：`NodeSystem.getNearestNode` 的 `nearest = node`（:886）直接取自 `activeNodes`；`loadNodesFromConfig` 对已存在坐标复用原 `NodeData`（:202-207）；`isRegisteredActive` 用 `nodes.get(node.location) == node`（:934）做身份判定。`previousTarget != targetNode` 不会因包装对象而误判。
- **L6（缓存目标不复核半径）**：`HUNT_RANGE_SQ` 是获取目标时的搜索半径（:41-42 注释、:204 使用），不是追击 leash；`:88` 的复用与 `:99-101` 的 `shouldStayActive` 都刻意不带距离条件。空投 Goal 优先级更高（:30-31），会抢占，不会因追击阻塞空投。按现有注释与设计，这是锁定后持续追击，不是缺陷。

## 4. 自检记录

- **标识符对账**：`nodes.self-destruct-multiplier`（`ConfigManager.java:1515` 读入）↔ `ExplodeBeetleGoal.java:243` 消费；`normalizeExplodeDamageMultiplier`（:776-784）只服务 `explode-damage-multiplier`，未发现节点倍率的同名归一化函数（差集 = 1，即本条发现）。另核对 `damageNode(Location,double)` 的调用点：`ExplodeBeetleGoal.java:259`、`NodeAttackGoal.java:253`，签名一致。
- **自带自检抽验**：本切片 5 个 Goal 与 `NodeSystem` 没有自带测试/校验脚本，没有可抽验对象；仓库根 `check-*` 脚本不在本切片读取范围，未抽验。
- **运行时验证**：零写入约束禁止 `mvn/gradle` 构建（会写 `target/`）与启动 Paper 服务器；无法真实执行 Goal tick，改用 `NodeSystem.damageNode` 的控制流证据。

## 5. off-dimension notes（不进 findings）

1. **L1（error-handling）**：`AirdropSpawnGoal.java:107` 的 `dropper.getLocation().distanceSquared(targetDropLocation)` 未先比较 world。`targetDropLocation` 来自 `gameWorld`，而 dropper 可被外部传送/换世界；Bukkit `Location#distanceSquared` 跨世界抛 `IllegalArgumentException`。同包 `DropperAttackGoal.java:191` 有 `dropperLoc.getWorld() != gameWorld` 守卫，建议 error-handling 维度复核并修复。
2. **同族跨世界风险（error-handling）**：`NodeAttackGoal.java:192` 的 `mobLoc.distance(targetCenter)` 也未做 world 一致性守卫；目标获取时校验了 world，但实体可被外部传送。属 error-handling，未计入 logic。
3. **data-consistency**：sweep 的「`damageNode(loc, NaN)` 可能把 NaN 写进节点血量」已被 `NodeSystem.java:696` 的 `Double.isFinite` 守卫否定；若该守卫被移除，`NodeData.damage`（:980-981）的 `currentHealth <= 0` 对 NaN 为 false，节点会永久停留在 NaN 血量且不销毁——这是本条 LOW 的潜在放大路径，不另立 data-consistency 发现。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "audit-slice-04-logic",
  "role": "audit",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/.run-dsh3/artifacts/round1-02-audit-slice-04-logic.md",
  "payload": {
    "slice_id": "slice-04",
    "findings": [
      {
        "finding_id": "F-slice-04-logic-01",
        "severity": "LOW",
        "dimension": "logic",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/ai/ExplodeBeetleGoal.java",
          "line": 243,
          "quote": "double nodeMultiplier = Math.max(0, cfg.getNodeSelfDestructMultiplier());"
        },
        "inference": {
          "claim": "当 nodes.self-destruct-multiplier 为 NaN 或 Infinity 时，Math.max(0, ...) 会原样保留非有限值，使 nodeDamage 变成 NaN/Infinity；下游 NodeSystem.damageNode:696 的 !Double.isFinite(damage) 会返回 0，因此当前不会写坏节点血量、不会抛异常，但本行的非负钳制对 NaN/Infinity 实际无效，非法配置被静默折算成 0 伤害且无日志。相邻 explodeMultiplier 在 :241-242 做了 Double.isFinite 折算，同族守卫不一致。",
          "basis": "第 241-242 行对 rawExplodeMultiplier 使用 Double.isFinite(rawExplodeMultiplier) && rawExplodeMultiplier > 0 ? rawExplodeMultiplier : 0；第 243 行对 nodeMultiplier 只有 Math.max(0, ...)。Java 语义下 Math.max(0, Double.NaN) 返回 NaN，Math.max(0, PositiveInfinity) 返回 Infinity。配置侧 ConfigManager.java:1515 对 nodes.self-destruct-multiplier 仅 settingsYaml.getDouble(...) 后 setNodeSelfDestructMultiplier，没有 :776-784 的 normalizeExplodeDamageMultiplier 那类 NaN→0 / +Inf→10 归一化。控制流：ExplodeBeetleGoal.tick:162 -> :185-186 -> explode:243-244 -> :259 NodeSystem.damageNode:696，后者以 !Double.isFinite(damage) 返回 0，因此本条没有数据损坏，只是本地守卫失效与非法配置静默归零。",
          "alternatives": [
            "如果 YamlFiles.gameSettingsValidator 在加载阶段已拒绝 .nan / .inf 这类非有限 double，则该输入不可达、本条不成立——需检查 YamlFiles.java 的 gameSettingsValidator（本回合未读该文件，无法确认）。",
            "如果所有 setNodeSelfDestructMultiplier 调用点都只接受 GUI 滑块值（NodeSettingsMenu 的 0.5-10、步长 0.5），则非有限值只能来自手改 game-settings.yml；ConfigManager.java:1515 本身不做有限性校验，故手改路径仍可达。",
            "如果设计上把 NodeSystem.damageNode:696 的 Double.isFinite 视为该值的正式归一化点，则本行只是重复防御、无独立影响——需确认『每个消费点自守』是否为本项目约定；explodeMultiplier 的本地折算说明作者并不完全依赖下游。"
          ]
        },
        "status": "CONFIRMED"
      }
    ],
    "searched_scope": {
      "files_read": [
        "src/main/java/com/hilltopvillage/ai/AirdropSpawnGoal.java",
        "src/main/java/com/hilltopvillage/ai/DropperAttackGoal.java",
        "src/main/java/com/hilltopvillage/ai/ExplodeBeetleGoal.java",
        "src/main/java/com/hilltopvillage/ai/HookClawHunterGoal.java",
        "src/main/java/com/hilltopvillage/ai/NodeAttackGoal.java",
        "src/main/java/com/hilltopvillage/mechanics/NodeSystem.java",
        "src/main/java/com/hilltopvillage/core/WaveManager.java",
        "src/main/java/com/hilltopvillage/config/ConfigManager.java"
      ],
      "files_in_slice": 5,
      "shared_dependencies_read": [
        "src/main/java/com/hilltopvillage/mechanics/NodeSystem.java"
      ],
      "files_scanned_without_findings": [
        "src/main/java/com/hilltopvillage/ai/AirdropSpawnGoal.java",
        "src/main/java/com/hilltopvillage/ai/DropperAttackGoal.java",
        "src/main/java/com/hilltopvillage/ai/HookClawHunterGoal.java",
        "src/main/java/com/hilltopvillage/ai/NodeAttackGoal.java",
        "src/main/java/com/hilltopvillage/mechanics/NodeSystem.java",
        "src/main/java/com/hilltopvillage/core/WaveManager.java",
        "src/main/java/com/hilltopvillage/config/ConfigManager.java"
      ],
      "dimension_checklist": [
        { "pattern": "1 返回值暴露内部状态", "result": "未命中", "note": "5 个 Goal 的 getTypes() 均返回 TYPES.clone()；NodeData.getLocation 返回 clone，未暴露内部可变集合。" },
        { "pattern": "2 同族函数守卫一致性", "result": "命中", "note": "ExplodeBeetleGoal:241-243 对 explodeMultiplier 做 isFinite 折算，对 nodeMultiplier 只做 Math.max；确认 F-slice-04-logic-01。DropperAttackGoal 的 L6 经语义复核不属漏守卫。" },
        { "pattern": "3 数值边界", "result": "命中", "note": "搜索半径 radius>0、伤害 <=0、冷却 <=0 均有分支；NaN/Infinity 的节点倍率候选见 4c，下游 NodeSystem:696 拒绝。" },
        { "pattern": "4a 原型链/裸下标", "result": "不适用", "note": "Java 无原型链；Map 仅按固定键 get(\"flying-dropper\"/\"explode-beetle\")，键为常量。" },
        { "pattern": "4b 假值 vs 缺值", "result": "未命中", "note": "monsterCfg null 均有显式默认值；target null 均先判空，没有用 !x 判缺值。" },
        { "pattern": "4c NaN/Infinity/小数", "result": "命中", "note": "nodeMultiplier 的 Math.max(0, NaN) 仍为 NaN；下游 NodeSystem:696 用 isFinite 拒绝，实际伤害为 0，故只定 LOW。" },
        { "pattern": "4d 嵌套结构校验", "result": "不适用", "note": "本切片不解析外部嵌套 JSON/YAML；NodeData 由 NodeSystem 构造并规范化坐标。" },
        { "pattern": "5 能力是否真实现", "result": "未命中", "note": "GoalKey/GoalType 常量与 pathfinder/velocity 调用均在 Paper API 中存在；未发现声明能力空转。" },
        { "pattern": "6 转义/编码顺序", "result": "不适用", "note": "本切片无字符串拼接/转义/编码链。" },
        { "pattern": "7 边界符号（负数/下标）", "result": "未命中", "note": "无数组下标/分页；倒计时均以 >0 递减，未发现负值；+1 的 Y 是方块上方而非下标。" },
        { "pattern": "8 引用绑定是否存在", "result": "未命中", "note": "所有调用符号在 NodeSystem/WaveManager/本文件存在；L5 的 NodeData 身份经 NodeSystem:886/:934 排除误判。" }
      ]
    },
    "self_checks": {
      "identifier_reconcile": {
        "status": "DONE",
        "note": "对账 nodes.self-destruct-multiplier（ConfigManager:1515 读入）↔ ExplodeBeetleGoal:243 消费；normalizeExplodeDamageMultiplier（:776-784）只服务 explode-damage-multiplier，节点倍率无非有限值归一化（差集 1，即本条发现）。另核对 damageNode(Location,double) 与 ExplodeBeetleGoal:259、NodeAttackGoal:253 的调用签名一致。"
      },
      "self_check_audit": {
        "status": "NOT_APPLICABLE",
        "note": "切片 5 个 Goal 与 NodeSystem 均无自带测试或校验脚本，没有可抽验对象；仓库根 check-* 脚本不在本切片读取范围。"
      },
      "runtime_validation": {
        "status": "SKIPPED",
        "note": "零写入约束禁止 mvn/gradle 构建（会写 target/）与启动 Paper 服务器，无法真实执行 Goal tick；改用 NodeSystem.damageNode 的控制流证据。"
      }
    },
    "off_dimension_notes": [
      "L1（error-handling，越维度）：AirdropSpawnGoal.java:107 的 dropper.getLocation().distanceSquared(targetDropLocation) 未先比较 world；Bukkit Location#distanceSquared 跨世界会抛 IllegalArgumentException。同包 DropperAttackGoal.java:191 有 dropperLoc.getWorld() != gameWorld 守卫，建议 error-handling 维度复核。",
      "同族跨世界风险（error-handling）：NodeAttackGoal.java:192 的 mobLoc.distance(targetCenter) 也未做 world 一致性守卫；目标获取时校验了 world，但实体可被外部传送。未计入 logic。",
      "data-consistency：sweep 的「damageNode(loc, NaN) 可能把 NaN 写进节点血量」已被 NodeSystem.java:696 的 Double.isFinite 守卫否定；若该守卫被移除，NodeData.damage:980-981 的 currentHealth <= 0 对 NaN 为 false，节点会停在 NaN 血量且不销毁。"
    ]
  },
  "error": null
}
```
