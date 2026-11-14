# 修复进度

**基线**：clean 编译通过 + 846 条测试全绿
**备份**：`backups/prerepair-20261114-225746/`（153 文件）
**回滚**：`experiments/hilltop-dsh/rollback.sh`

---

## 已完成

### #2 TabListManager 异常后任务累积 —— ✅ 已修

**改动**：`TabListManager.refreshAll()` 的 catch 不再清空 `refreshTask` 与 `scheduledPeriod`。

**依据**：反编译 `paper-1.21.4-232` 的 `CraftScheduler.mainThreadHeartbeat()` 字节码，
证实周期任务抛异常后**不会被取消**，而是重新入队：

```
108: task.run()                    ← 抛异常
Exception table: from 108 to 112 target 120 type Throwable
120: 记 WARNING → 发 ServerExceptionEvent → 清 currentTask
212: goto 225                      ← 与正常路径汇合
250: task.getPeriod()
258: ifle 283                      ← period <= 0 才移除
272-274: pending.add(task)         ← **period > 0 重新入队**
```

正因为旧任务从未被取消，把它置空就等于制造孤儿：下一帧 `start()` 新建一条，
旧的还在跑 → 两条并行 → `tick++` 按倍数推进，动画双倍速。

**同时修正两处错误注释**（`TabListManager.java:150-152`、`:286-290`），
它们把「CraftScheduler 会静默取消」写成了事实。

**测试**：
- 改写 `TabListManagerTest#refreshFailureIsContained` —— 原版把一个**错误前提**编码成了期望
  （断言消息写着「CraftScheduler 会静默取消抛异常的重复任务」）
- 新增 `repeatedFailuresDoNotAccumulateTasks`（连续 10 次异常，句柄必须是同一个）

**验证**：先确认新测试在未修复代码上**是红的**（`expected: <RepeatingTask@...> but was: <null>`），
修复后转绿。

### #5 AirdropSpawnGoal NPE 逃出 IAE catch —— ✅ 已修

**改动两处**：

1. `executeAirdrop()`：`mobTypeName` 在 `toUpperCase()` 之前挡掉 null / 空白
2. `tick()`：`targetDropLocation = null` 移进 `finally`

第二处比第一处更重要：只修 null 源的话，未来 `spawnParticle` / `spawnAirdropMobs`
抛任何 RuntimeException 都会重演「清理不可达 → goal 永远 active → 每 tick 重试」。

**依据**：实测（真实 `YamlConfiguration` + JUnit）——

```
airdrop-mob-type: "null"   raw=String:null   contains=true   getString=null
airdrop-mob-type: ~        raw=null          contains=false  getString=null
airdrop-mob-type:          raw=null          contains=false  getString=null
```

**两条审计结论各错一半**：
- 静态审计说「留空键 → NPE」→ **错**，留空时 `contains=false`，走默认值
- 批判复核说「contains 与 getString 互斥，NPE 不可达」→ **也错**，`"null"` 字符串打破互斥

真相：NPE 可达，但触发条件是带引号写 `"null"`。

**测试**（新增 4 条）：
- `nullMobTypeFallsBackToZombie` / `blankMobTypeFallsBackToZombie` / `validAndTypoStillHandled`
- `productionCodeHasNullGuard` —— 读源码文件，防止有人把修复删掉

> **为什么不用 `executeAirdrop()` 驱动**：那个方法在 `spawnParticle` 处撞 MockBukkit 的
> `UnimplementedOperationException`（该测试类顶部注释已写明这个边界）。
> 所以测的是「与生产代码同构的解析逻辑」+「源码守卫」，组合起来覆盖。

---

## 待修（按规划 agent 的风险排序）

| # | 缺陷 | 风险 | 依赖 |
|---|---|---|---|
| 7 | 载入侧数值钳制 | 低-中 | 与 #1、#6 一起定边界 |
| 3 | 重载丢未保存修改 | 低-中 | 与 #7 的脏标记有交互 |
| 1 | 修复扣多份只恢复一份 | **中**（改合法配置下的行为） | 必须与 #7 同批 |
| 6 | 爆炸倍率混用 | **中**（改战斗数值） | 与 #7 的 finite 钳制配套 |
| 4 | 重置第 8 步 | **高**（破坏性管理流程，无回归网） | 最后做 |

## 未裁决的分歧

批判 agent 认为 **#3 / #5 / #7 不值得修**：

- **#3**：UI 的 lore 已写明「未保存的更改将被覆盖」，加确认是画蛇添足
- **#7**：全局 `victory-waves` 是死键（有实例时走 per-arena 值），钳它零收益

这两条我需要独立验证后再决定。#5 已裁决（该修，但触发条件与原报告不同）。
