# Hilltop Village 第二轮审计：mechanics 模块

本轮对 `src/main/java/com/hilltopvillage/mechanics/` 下 14 个文件做了静态全量阅读，并用调用链回读核对任务生命周期、节点修复/持久化、记分板刷新与配置热重载路径；未启动服务端，因此所有结论均为静态证据，运行时复现列为跳过。

## F1：TabList 异常后只清句柄，旧 ticker 与新建 ticker 并存

`TabListManager.java:298` 在 `refreshAll()` 的 catch 中执行 `refreshTask = null;`，但没有取消当前正在执行的 `BukkitTask`。异常是在 `run()` 内部被捕获的，CraftScheduler 看不到异常，因此不会像 286–290 行注释假设的那样自动取消重复任务；句柄被清空后，`stopTask()` 也再也找不到它。下一次刷新在 `TabListManager.java:323` 读到 `period != scheduledPeriod`（catch 已把 `scheduledPeriod` 设为 -1），于是 `start()` 在 156 行重新调用 `runTaskTimer`，而旧 ticker 仍在运行，形成两条刷新链。一次异常就会让 tab 刷新频率翻倍，反复异常还会继续累积任务；`ArenaScoreboard.java:418` 的 `stopTask()` 正是针对同一陷阱的正确对照。

## F2：修复物品按多个扣除，却只恢复一份生命值

`NodeListener.java:229` 执行 `item.setAmount(item.getAmount() - cost);`，但 224 行只把一份 `repairAmount()` 传给 `repairNode`，而 227 行的 `cost` 来自 `repairCostAmount()`。`GameConfig.java:119` 明确把 `repairAmountPerCost` 定义为“每消耗 1 个修复物品恢复的节点生命值”，因此 cost=5 时应恢复 5×amount，当前只恢复 1×amount；同时 `ConfigManager.java:430-432` 与 `GameConfig.setRepairCostAmount` 都没有校验 cost 为正数，cost=0 会免费修复，cost<0 会让 `amount - cost` 反而增加物品数量。该路径从 `onPlayerInteract` 进入 `repairNode(..., repairAmount())`，再回到 227–229 行扣物品，配置值可以直接改变结算结果。结果是同一条修复路径同时产生少修复、免费修复和物品复制三种与字段语义不符的行为。

## F3：addNode 忽略落盘失败，内存成功而磁盘未更新

`NodeSystem.java:381` 调用 `saveNodesToConfig();` 后没有检查返回值，紧接着 382 行仍 `return 0; // 成功`。`saveNodesToConfig()` 的 javadoc 在 249 行写明“false 表示被只读降级拦下或写入失败”，实现也在 266、273、308 行返回 false；也就是说节点已经写入内存 `nodes`/`activeNodes`，磁盘却可能没有更新。`SetupWizard` 的添加节点调用点只以返回值 0 判断成功并立即提示/刷新 GUI，因此管理员会看到“添加成功”，重启后节点消失。该路径不需要异常，正常的只读门控或一次 IO 失败即可触发，属于内存与持久化的部分写入。

## F4：buff 刷新周期在调度时固定，热重载只改字段不改任务

`NodeSystem.java:719` 用 `Math.max(1, buffRefreshTicks)` 作为 `runTaskTimer` 的固定 period，而 705 行在任务体内调用 `loadConfig()` 只会更新字段，不会改变已经注册任务的周期。`loadConfig()` 在 93 行注释声称“配置中心 GUI 修改后立即生效”，`applyAllBuffs()` 也在 693–694 行先读一次配置，因此管理员在局中修改 `nodes.buff-refresh-ticks` 后会误以为新周期已生效。实际要等到本局结束、下一次 `applyAllBuffs()` 重新调度时才使用新值；在此之前增益仍按旧周期刷新。该发现是契约/注释与调度器语义的偏差，不影响启动时的首次周期。

## F5：标题键不在签名中，单独改 title-key 不会重绘标题

`ArenaScoreboard.java:480` 在 `if (signature.equals(state.signature)) return;` 处整帧短路，而标题直到 487 行才通过 `titleKey()` 重新求值。`buildSignature` 的 537–558 行只拼接 snapshot、个人数据、arena 信息和 locale，没有拼接 `titleKey()`；`resolveLayout()` 也只在 `lines` 变化时清空 `state.signature`（205–224 行）。因此单独修改 `display.yml` 的 `scoreboard.title-key` 并执行 reloadconfig，已有玩家的标题会保持旧值，直到波数/人数/locale 等某个签名输入恰好变化。注释 483–486 行声称 locale 已纳入签名所以标题会跟随，但标题键本身没有进入签名，这正是“两条路径给出不同答案”。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "hilltop-round2-mechanics",
  "role": "audit",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "round2-mechanics-audit.md",
  "payload": {
    "findings": [
      {
        "finding_id": "F1",
        "severity": "HIGH",
        "dimension": "concurrency",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/mechanics/TabListManager.java",
          "line": 298,
          "quote": "refreshTask = null;"
        },
        "inference": {
          "claim": "catch 只清空 refreshTask 句柄，没有取消当前正在执行的重复任务；下一帧 start() 会再注册一条任务，导致旧 ticker 与新建 ticker 并存。",
          "basis": "refreshAll() 在 292-300 行捕获 RuntimeException，异常没有穿出 run()，CraftScheduler 不会替调用方取消任务；298 行置空 refreshTask，299 行把 scheduledPeriod 置为 -1。下一次 refreshAllUnchecked() 在 322-324 行发现 period 与 scheduledPeriod 不等，调用 start()；start() 在 153 行因 refreshTask 为 null 不早退，在 156 行重新 runTaskTimer，而旧任务仍按原周期执行。ArenaScoreboard.java:418 的 stopTask() 是同一陷阱的显式取消修复对照。",
          "alternatives": [
            "如果 CraftScheduler 在异常被 catch 后仍会取消该重复任务，则旧任务不会存活到下一帧；但异常在 run() 内部已处理完毕，调度器看不到异常，按 Bukkit 语义不会取消。",
            "如果异常发生后插件立即禁用、没有后续 tick，则重复任务不会显现；正常对局中下一 tick 就会触发 start() 并重建。"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "F2",
        "severity": "HIGH",
        "dimension": "data-consistency",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/mechanics/NodeListener.java",
          "line": 229,
          "quote": "item.setAmount(item.getAmount() - cost);"
        },
        "inference": {
          "claim": "一次修复只传入一份 repairAmount()，却按 repairCostAmount() 扣除多个物品；cost 又未校验正数，0 会免费修复、负数会反向增加物品数量。",
          "basis": "NodeListener.java:224 把 repairAmount() 传给 repairNode，而 227 行的 cost 来自 repairCostAmount()，229 行直接用 amount-cost 扣除。GameConfig.java:119 将 repairAmountPerCost 定义为“每消耗 1 个修复物品恢复的节点生命值”，因此 cost>1 时应恢复 amount×cost，当前只恢复一份。ConfigManager.java:430-432 直接读取 YAML 的 nodes.repair-cost-amount，GameConfig.setRepairCostAmount 也只是赋值，没有范围校验。调用链为 onPlayerInteract → repairNode(..., repairAmount()) → 227-229 行扣除 cost 个物品。",
          "alternatives": [
            "如果 repairAmountPerCost 的真实语义是“每次修复动作恢复量”而不是“每消耗一个物品恢复量”，则 cost>1 的少修复不成立；但 GameConfig.java:119 与 NodeListener.java:57 的注释都写成“每消耗一个物品”。",
            "如果命令或 GUI 在上游强制 cost>=1 且恒为 1，则免费修复和复制物品路径不可达；但当前 YAML 读取与 GameConfig setter 都没有这种约束。"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "F3",
        "severity": "HIGH",
        "dimension": "data-consistency",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/mechanics/NodeSystem.java",
          "line": 381,
          "quote": "saveNodesToConfig();"
        },
        "inference": {
          "claim": "addNode 忽略 saveNodesToConfig() 的 false 返回并继续返回 0（成功），造成内存节点存在、nodes.yml 未更新的部分写入。",
          "basis": "NodeSystem.java:381 调用 saveNodesToConfig() 丢弃返回值，382 行仍 return 0。saveNodesToConfig() 的 javadoc 在 249 行写明 false 表示只读降级或写入失败；实现 266 行、273 行、308 行都会返回 false。此时 nodes.put 与 activeNodes.add 已执行，节点在本次进程内可查询、可修复，但重启后从磁盘加载不到。SetupWizard 的添加节点调用点只判断返回值 0 并立即提示/刷新 GUI，因此会把失败当成功。",
          "alternatives": [
            "如果 saveNodesToConfig() 在失败时抛出异常而不是返回 false，addNode 会中止，不会继续返回 0；但 266、273、308 行都是显式 return false。",
            "如果 SetupWizard 在收到 0 后再次读文件校验，则能发现落盘失败；当前调用点只判断返回值，没有二次校验。"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "F4",
        "severity": "MEDIUM",
        "dimension": "contract",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/mechanics/NodeSystem.java",
          "line": 719,
          "quote": "buffTask.runTaskTimer(gameManager.getPlugin(), 0L, Math.max(1, buffRefreshTicks));"
        },
        "inference": {
          "claim": "buff 刷新周期在 runTaskTimer 调用时固定；任务体内 loadConfig() 更新 buffRefreshTicks 不会改变已注册任务的 period，与“配置修改立即生效”的注释不符。",
          "basis": "applyAllBuffs() 在 694 行先 loadConfig()，719 行用当时的 buffRefreshTicks 作为 period 注册任务。任务体 705 行再次 loadConfig() 只更新字段，BukkitTask 的调度周期不会随之改变。NodeSystem.java:93 注释称“配置中心 GUI 修改后立即生效”，因此管理员在局中修改 nodes.buff-refresh-ticks 后，实际仍按旧周期刷新，直到下一次 applyAllBuffs() 重建任务。",
          "alternatives": [
            "如果 Bukkit 的 runTaskTimer 每轮重新读取 period 参数，则修改会生效；但 period 只在 719 行求值一次并传给调度器。",
            "如果 GUI 修改 buff-refresh-ticks 后主动调用 applyAllBuffs()，则会重建任务；当前 GUI 只写 GameConfig，未看到该重建调用。"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "F5",
        "severity": "MEDIUM",
        "dimension": "logic",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/mechanics/ArenaScoreboard.java",
          "line": 480,
          "quote": "if (signature.equals(state.signature)) return;"
        },
        "inference": {
          "claim": "标题键 titleKey() 没有进入 buildSignature；单独修改 scoreboard.title-key 并 reloadconfig 时，已有玩家的标题会因签名命中而保持旧值。",
          "basis": "refresh() 在 479 行构造签名，480 行命中即 return，487 行才读取 titleKey()。buildSignature 在 537-558 行拼接 snapshot、个人数据、arena 信息和 locale，没有 titleKey。resolveLayout() 只在 lines 内容变化时清空 state.signature（205-224 行），标题键变化不会触发。因此修改 display.yml 的 scoreboard.title-key 后，若波数、人数、locale 等签名输入都不变，标题不会重绘；注释 483-486 行却声称 locale 已纳入签名所以标题会跟随。",
          "alternatives": [
            "如果 reloadconfig 对所有玩家重新调用 show()，BoardState 会重建、标题会立即更新；当前刷新路径没有这种重建。",
            "如果 title-key 的修改同时改变 lines 布局，resolveLayout 会清空签名并触发重绘；只改标题键时不会。"
          ]
        },
        "status": "CONFIRMED"
      }
    ],
    "searched_scope": {
      "files_read": [
        "src/main/java/com/hilltopvillage/mechanics/HammerEffectRenderer.java",
        "src/main/java/com/hilltopvillage/mechanics/NodeListener.java",
        "src/main/java/com/hilltopvillage/mechanics/PlayerLifecycleListener.java",
        "src/main/java/com/hilltopvillage/mechanics/VillagerPreviewManager.java",
        "src/main/java/com/hilltopvillage/mechanics/VillagerSystem.java",
        "src/main/java/com/hilltopvillage/mechanics/FireballListener.java",
        "src/main/java/com/hilltopvillage/mechanics/MapRestoreManager.java",
        "src/main/java/com/hilltopvillage/mechanics/ArenaScoreboard.java",
        "src/main/java/com/hilltopvillage/mechanics/HammerListener.java",
        "src/main/java/com/hilltopvillage/mechanics/TabListManager.java",
        "src/main/java/com/hilltopvillage/mechanics/FriendlyFireListener.java",
        "src/main/java/com/hilltopvillage/mechanics/ArenaAccessListener.java",
        "src/main/java/com/hilltopvillage/mechanics/LobbyProtectionListener.java",
        "src/main/java/com/hilltopvillage/mechanics/NodeSystem.java"
      ],
      "dimension_checklist": [
        "logic",
        "concurrency",
        "security",
        "error-handling",
        "data-consistency",
        "contract"
      ],
      "methods": [
        "full-file read of every mechanics source file",
        "cross-file call-chain inspection for event handlers, scheduled tasks and persistence",
        "task registration/cancellation and reload lifecycle tracing"
      ]
    },
    "self_checks": {
      "identifier_reconcile": {
        "status": "DONE",
        "note": "findings 中引用的 TabListManager、ArenaScoreboard、NodeListener、NodeSystem 成员与行号均已回读源码核对，未发现行号漂移。"
      },
      "self_check_audit": {
        "status": "DONE",
        "note": "逐条回读 evidence 行并交叉检查同文件调用点；F1 额外对照 ArenaScoreboard 的显式 stopTask 修复，确认差异不是误读。"
      },
      "runtime_validation": {
        "status": "SKIPPED",
        "note": "本次是纯静态代码审计，未启动 Paper/Bukkit 服务端，无法进行运行时复现或命令级验证。"
      }
    }
  },
  "error": null
}
```
