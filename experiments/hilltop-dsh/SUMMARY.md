# Hilltop Village 全模块审计汇总

**日期**：2026-11-14 20:39–22:05
**主控**：dsh（不是 Claude Code 主会话）
**模型**：`virtual/opus`（<self-hosted-endpoint>:3000 → 后端 SCNet-Max）

---

## 结果

| 项 | 值 |
|---|---|
| 覆盖模块 | **13 / 13**（全部） |
| 覆盖代码 | 153 文件 / 57,852 行 |
| 发现总数 | **38 条** |
| 严重性 | HIGH **8** · MEDIUM 22 · LOW 8 |
| 契约合规 | **7 / 7 份产物全部 `✅ 契约合规`** |

| 轮次 | 模块 | 发现 |
|---|---|---|
| R1 | core | 3（MEDIUM×3） |
| R2 | ai / arena / mechanics | 14（HIGH×5） |
| R3 | config+stats / command+admin / shop+util+gui+doc+diagnostic | 21（HIGH×3） |

产物：`out/round{1,2,3}-*-audit.md`

---

## 8 条 HIGH

### R2-mechanics F1 · `TabListManager.java:298` —— 异常后任务重复累积

`refreshAll()` 的 catch 里执行 `refreshTask = null`，但**没有取消正在跑的 `BukkitTask`**。
异常在 `run()` 内部被捕获，CraftScheduler 看不到，不会自动停；句柄被清空后 `stopTask()` 也找不到它。
下一次刷新看到 `scheduledPeriod == -1` 就再 `runTaskTimer` —— **旧 ticker 还在跑，形成两条刷新链**。
反复异常会持续累积。

**同模块 `ArenaScoreboard.java:418` 是正确写法**，注释明写「取消后置空，句柄失效与任务实际状态一致」。
**同一代码库里两种做法并存，这一处是错的那种。**

### R2-mechanics F2 · `NodeListener.java:229` —— 扣多份物品，只修一份生命值

`:224` 把 `repairAmount()` 传给 `repairNode`，`:227` 取的却是 `repairCostAmount()`，
`:229` 执行 `item.setAmount(item.getAmount() - cost)`。

`GameConfig.java:119` 明确 `repairAmountPerCost` 是「每消耗 1 个物品恢复的生命值」，
所以 cost=5 时应恢复 5×amount，实际只恢复 1×amount。
且 `cost` 无正数校验：**cost=0 免费修复，cost<0 会让物品不减反增**。

### R2-mechanics F3 · `NodeSystem.java:381` —— addNode 忽略落盘失败

### R3-A A-01 · `ConfigManager.java:1636` —— 配置加载缺陷
### R3-A A-04 · `MainConfigMenu.java:149` —— 契约违反
### R3-B B-01 · `ArenaResetService.java:280` —— 重置服务数据一致性
### R2-ai R2-AI-001 · `ExplodeBeetleGoal.java:241` —— 同一个配置值两处语义不同
### R2-ai R2-AI-002 · `AirdropSpawnGoal.java:237` —— 空配置触发 NPE 且每 tick 重试

---

## 我独立验证过的（逐字回源码核对，全部成立）

| 发现 | 验证方式 |
|---|---|
| R1 F1/F2/F3 | 三处引用逐字命中；F1 的「注释说留在主线程 vs 代码在异步跑」矛盾成立 |
| R2-ai 001 | `:229` 当伤害倍率乘法、`:241` 当 Bukkit `power` 直接传 → 语义不同成立 |
| R2-ai 002 | `:234` 可能 null → `:237` NPE → `:238` 只捕获 IllegalArgumentException → `:136` 清理不到；`ConfigManager.java:1645` 用 `getString` 确实会写 null |
| R2-mech F1 | `:298` 只置 null 不 cancel；`ArenaScoreboard:418` 正确对照 |
| R2-mech F2 | `:224` / `:227` / `:229` 三行对照，扣 cost 份恢复 1 份成立 |

**抽查 5 组，全部成立，零误报。**

---

## 反复出现的缺陷模式（跨模块）

这是本批最有价值的部分——**同一个模式在不同模块反复出现**：

### 模式 1：同一个配置值，两条路径语义不同

| 位置 | 冲突 |
|---|---|
| `victory-waves` | 加载侧 `ConfigManager:1351` 不钳制 / GUI 侧 `GameRulesMenu:48` 钳 `Math.max(1,v)` |
| `explode-damage-multiplier` | `ExplodeBeetleGoal:229` 当伤害倍率 / `:241` 当 Bukkit 爆炸 `power` |
| `repairCostAmount` | `NodeListener:224` 按 amount 传 / `:227` 按 cost 扣 |

**共同后果**：改 YAML 和改 GUI 得到不同行为；字段注释说的和实际算的不是一回事。

### 模式 2：异常处理只捕获了「预期的那一种」

**`AirdropSpawnGoal.java:238` 只捕获 `IllegalArgumentException`，NPE 直接逃出**，且逃出后清理代码不可达，
于是每 tick 重复触发。Minecraft 插件的异常会拖垮整个 tick，这类缺陷代价最高。

### 模式 3：资源句柄失效与任务实际状态不一致

`TabListManager:298` 置 null 但不 cancel。同仓库 `ArenaScoreboard:418` 有正确写法。
**这类缺陷的特征是「本地看起来对，但和同代码库的正确先例不一致」。**

### 模式 4：配置值没有边界钳制

`victory-waves` 为 0、`repairCostAmount` 为 0 或负数、`explodeMultiplier` 无上限——
**都能让游戏逻辑静默走偏，且不报错**。

---

## 局限

- **没做运行时验证。** 全部是静态阅读。比如 `TabListManager` 的任务累积，静态看逻辑成立，
  但没有真跑一次让它抛异常来观察。
- **没做对照实验。** 没有验证「dsh 审得比 Claude Code 直接审更好」。
- 严重性判定是模型给的，**没有外部基准校准**——按本框架自己的记录，
  不同 agent 对同一发现的定级一致率只有 43.8%。
- 关键词外的语义问题（命名、抽象层次）不在覆盖范围内。

---

## 复现

```bash
cd "D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework"
AUDIT_API_KEY=<key> node "<dsh>/lib/bin.js" --profile headless \
  --patch experiments/hilltop-dsh/patch-audit.yml "$(cat experiments/hilltop-dsh/task-*.md)"
```

**注意：必须从项目目录启动 dsh**，因为沙箱的 `workspaceRoot` 是 `process.cwd()`。
从 dsh 自己的安装目录启动会导致所有产物被挡在 `C:\` 下写不到 `D:\`。
