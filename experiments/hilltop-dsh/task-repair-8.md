修复目标项目：
<TARGET_REPO>

## 背景

上一轮你交付了 4 条修复（#7 #1 #6 #4），并把 #3 判定为设计意图不修。
我独立核实了：877 tests / 0 failures / BUILD SUCCESS，红测试日志真实，产物与实际代码一致。
**#3 的判定我认可**——`messages.yml:623-625` 与 `:1723-1725` 的 lore 确实已明确告知会覆盖，
且同一菜单有 Revert 路径。判定成立。

## 本轮要修的：你在 #3 产物里自己指出的相邻缺陷

`done-3.md` 里你写了：

> `/hilltop reloadconfig` 不显示与 GUI 相同的「未保存会被覆盖」警告
> `loadFromFile()` 返回 `void`。当 `game-settings.yml` 不可用时，它保留内存值并提前返回，
> 但菜单仍发送 "Config reloaded from game-settings.yml."。这时消息是假的。
> 应另开缺陷：让 `loadFromFile` 返回成功/失败，菜单按结果发消息。

**这条我现在正式派给你，编号 #8「reload 消息说谎」。**

### 缺陷定义

`ConfigManager.loadFromFile():1372-1382` 在 `!loaded.usable() || settingsGate.isReadOnly()`
时打一条 `SEVERE` 日志、设 `settingsLoadedFromDisk = false`、`return;`，
但调用方完全不知道失败，仍然向管理员宣布成功。

两处生产调用点：

- `MainConfigMenu.java:149` —— 点击后无条件发 `config.menu.main.reloaded-msg`
- `HilltopCommandHandler.java:420-437` —— **已核实**：它被 `try { ... } catch (RuntimeException ex)` 包住，
  但 `loadFromFile()` 失败时**不抛异常**，所以 catch 不会触发，`config-reloaded` 照样发出。
  也就是说这条路径比 GUI 更隐蔽：管理员看到「已重载」且没有任何错误提示。

后果：管理员以为配置已从磁盘重载，实际内存里还是旧的（甚至可能是坏的）值。
**这是"消息与事实不符"，比 #3 的"已告知的破坏性操作"严重。**

### 要求

1. 让 `loadFromFile()` 把结果告诉调用方（`boolean` 最简；如果你认为需要区分
   "文件不可用" 与 "只读隔离" 两种失败，可以用枚举，但说明理由）。
2. 两个调用点都按结果发消息。失败时**不得**发送 `reloaded-msg`。
3. 新增失败消息键（EN + ZH 成对，遵守项目既有 `messages.yml` 命名风格），
   文案要说清「没有重载，内存值保持不变」以及为什么要去看控制台。
4. 成功路径的消息文案不要改——已有用户依赖。
5. 既有 4 处测试调用点是 `config.loadFromFile();` 不带断言，改成返回 boolean 后
   这些行仍然合法，不会编译失败。但**请确认**，别想当然。

### 纪律（和上轮相同）

- 先写能证明它是红的测试：在未修复代码上跑，确认 FAIL，把失败信息贴进产物
- 修完跑全量：`cmd.exe /c "<绝对路径>\build.cmd" -o test`，必须保持 0 失败。
  当前基线是 **877 tests / 0 failures / 1 skipped**，不是上轮的 863
- 不许改测试迁就代码
- 构建用 `cmd.exe /c`（不是 `./build.sh`，Git Bash 在这个执行环境里起不来）
- 测试环境需要 `$env:JDK_JAVA_OPTIONS='-Djdk.attach.allowAttachSelf=true -Djava.io.tmpdir=target/test-tmp'`

## 产物

写到项目内（可写范围内）：

```
<TARGET_REPO>/repair-artifacts/done-8.md
```

**不要试图写到 `D:/Projects/...`**，那在你的沙箱外，上轮已被拒。我会自己搬。

内容照上轮格式：改了什么（文件:行 + 关键代码）、那个红的测试名和失败信息、
修复后结果、有没有改既有测试及理由、风险和未覆盖场景。

## 上轮遗留、本轮不修但要复述的

如果你在修 #8 的过程中发现这些有新证据，可以提，但**不要顺手改**：

- **#6 战斗数值变更**：所有非 0 倍率现在都是普通苦力怕威力。这会让已部署服务器的手感变化，
  需要写进 CHANGELOG。项目有 `CHANGELOG.md`，请你判断按它的既有格式补一条是否合适，
  **写进产物但先别改文件**，告诉我你建议的条目文本。
- **#1 语义变更**：`repair-cost-amount` 从"固定消耗"变成"单次上限"。同理需要 CHANGELOG。
- `nodeSelfDestructMultiplier` 未做 NaN/Infinity 钳制（#6 的相邻风险）。
- #4 第 7 步商店 NPC 仍不可逆。
- `arenas.yml` 的 per-arena `game.victory-waves` 是独立读取路径，不受 #7 钳制。

## 如果你判断 #8 不该修

明确说出来并给理由。比如你要是认为「文件不可用是极端情况，管理员看控制台就够了」，
就论证这一点，不要为了完成任务硬修。但请注意：`settingsGate.isReadOnly()` 触发的是
**隔离模式**，那是有可能在正常运行中发生的（YAML 解析失败会被隔离），不是极端情况。
