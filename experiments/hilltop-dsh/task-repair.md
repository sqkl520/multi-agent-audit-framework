修复目标项目：
<TARGET_REPO>

## 现状（已由前序工作完成，不要重做）

- 备份：<TARGET_REPO>/backups/prerepair-20261114-225746/
- 基线：`build.cmd -o test` → Tests run: 863, Failures: 0
- 已修 2 条：#2 TabListManager 任务累积、#5 AirdropSpawnGoal NPE

## 运行环境（这次运行已修正，务必照做）

- **用 `cmd.exe /c build.cmd -o test`，不要用 `./build.sh`。** `build.sh` 需要 Git Bash，而 Git Bash 在受限进程里会因 MSYS 命名对象被拒而启动失败（`NtCreateDirectoryObject ... 0xC0000022`）。`build.cmd` 是同一套四探针逻辑的原生 Windows 版本，已验证 `BUILD SUCCESS`。
- 工作目录就是 `<TARGET_REPO>`，你的写入范围已覆盖它，可以直接改文件。

## 你要修的 5 条

### #7 载入侧数值钳制（先做这个，它是 #1 和 #6 的前提）

`ConfigManager.java` 里三处缺钳制，同一文件已有正确先例 `normalizeWaveTimeout`（:689-701）：

1. `victory-waves`（:1351）无下限钳制 → 0/负数导致首波即判胜；而 GUI 侧 `GameRulesMenu:48` 是 `Math.min(100, Math.max(1, v))`
2. `explode-damage-multiplier`（:1640）无钳制 → NaN/Infinity/超大值直接进 createExplosion
3. `repair-cost-amount`（:430-432 merge、:1425 load）无正数校验 → 0 免费修复、负数物品反增

**关键纪律**（漏了等于没修）：
- 值被改写时必须置 `loadTimeNormalizationPending = true`，否则主菜单显示"已是最新"、保存按钮熄灭，钳制只存在于内存
- 两条入口都要改：`loadFromFile()` 首读 + `mergeExternalChanges()` 外部手改合并
- **不得改变合法配置**：`explode-damage-multiplier` 上限必须允许 0（有些怪种模板就是 0）

### #3 重载丢未保存修改

`MainConfigMenu.java:149` 无条件 `loadFromFile()` 后无条件发「已重载」。
`ConfigManager:307` 有 `hasUnsavedChanges()` 但没被调用。

**先独立判断该不该修**：查 `messages.yml` 里 `config.menu.main.reload-lore2` 的文案。
如果文案已经写明「未保存的更改将被覆盖」，那这是设计意图，改法应该是「修正预判而非加确认框」。
**把你的判断和理由写进产物。**

**不要改 `loadFromFile()` 内部**（`:1340` 的 `activeConfig = new GameConfig()` 是核心机制，改它会破坏 `/hilltop reloadconfig` 语义）。

### #1 修复扣多份物品只恢复一份

`NodeListener.java:224-232`：传 `repairAmount()`（每物品恢复量），扣 `repairCostAmount()`（物品数）。
实测四种失效：cost=5 少恢复；cost=0 免费；cost<0 物品反增；节点只差 30 血仍扣 5 个。

必须与 #7 的 `repair-cost-amount` 钳制同批做。
建议把结算逻辑抽成纯函数 `planRepair(deficit, perCost, maxPerAction, held)` 便于测试。

### #6 爆炸倍率语义混用

`ExplodeBeetleGoal.java:229` 当「节点伤害倍率」乘，`:242` 直接传给 `createExplosion(loc, (float)explodeMultiplier, ...)` 当 power。
字段注释 `GameConfig:292` 说它管节点伤害。GUI 允许 0.5~10。

**注意默认值是 3.0**（等于原版苦力怕），不是 10。所以默认安全，只有 GUI 拉满才有问题。
修法自己判断：固定 power 常量 / 拆两个配置项 / 其他。**说明你的取舍理由。**

### #4 重置第 8 步失败留 0 节点场馆

`ArenaResetService.proceed()`：第 5 步 `clearNodesForWorld` 不可逆删节点 → 第 8 步 `clearDeploymentData` 失败 → `abort()` → `reinstate()` 只恢复启用状态不恢复节点 → 可开局但 0 节点。

**这条风险最高**：改动破坏性管理流程，且 `ArenaResetServiceTest` 明确声明不覆盖 12 步序列（无回归网）。
建议先评估两种修法：调换步骤顺序 / 加备份回滚。**说明你的取舍。**

## 硬性要求

1. **每改一处，先写能证明它是红的测试**（在未修复代码上跑一次，确认 FAIL），再改代码，再确认转绿。
2. **每修完一条，跑全量** `cmd.exe /c build.cmd -o test`，必须保持 0 失败。基线是 863。
3. **不许改测试来迁就代码**——除非测试本身把 bug 编码成了期望（像之前 `TabListManagerTest` 那样，那种要在产物里说明理由）。
4. 构建命令是 `cmd.exe /c build.cmd -o <maven args>`（不是 `./build.sh`，也不是直接 `mvn`——项目需要 JDK 21，而默认 JAVA_HOME 是 17）。

## 产物

每修完一条写一份：
`<FRAMEWORK_ROOT>/experiments/hilltop-dsh/repair/done-<编号>.md`

内容必须有：
- 改了什么（文件:行 + 关键代码片段）
- 那个证明「修复前是红的」的测试名和失败信息
- 修复后的测试结果
- 有没有改既有测试，改了的话说明为什么
- 你认为的风险和未覆盖的场景

最后一份汇总 `repair/SUMMARY.md`：5 条各自的状态、总测试数、还剩什么问题。

**如果你判断某条不该修，明确说出来并给理由**，不要为了完成任务硬修。
