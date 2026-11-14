# #3 — 点击“加载配置文件”会丢失未保存修改

**状态：不修复（判定为符合既有设计，不是缺陷）。没有改生产代码，也没有新增测试。**

## 代码与文案证据

### 触发路径 `src/main/java/com/hilltopvillage/config/menu/MainConfigMenu.java:146-156`

```java
setClickableItem(bottomRow + 4, Material.CRAFTING_TABLE,
        lang.getFor(admin, "config.menu.main.reload"),
        ct -> {
            configManager.loadFromFile();
            admin.sendMessage(lang.getFor(admin, "config.menu.main.reloaded-msg"));
            admin.playSound(admin.getLocation(),
                    org.bukkit.Sound.BLOCK_NOTE_BLOCK_PLING, 1.0f, 1.0f);
            reopen();
        },
        lang.getFor(admin, "config.menu.main.reload-lore1"),
        lang.getFor(admin, "config.menu.main.reload-lore2"));
```

`loadFromFile()` 在文件可用时执行 `activeConfig = new GameConfig()`，再用磁盘值重建内存
（`ConfigManager.java:1382-1391` 及后续），未保存的 GUI 修改确实被丢弃。这一点代码与行为都属实。

### 但按钮自身已经明确告知会覆盖

- EN `messages.yml:623-625`

```yaml
config.menu.main.reload: "&bLoad Config File"
config.menu.main.reload-lore1: "&7Reload from game-settings.yml"
config.menu.main.reload-lore2: "&8Note: unsaved changes will be overwritten"
```

- ZH `messages.yml:1723-1725`

```yaml
config.menu.main.reload: "&b加载配置文件"
config.menu.main.reload-lore1: "&7从 game-settings.yml 重新加载"
config.menu.main.reload-lore2: "&8注意：当前未保存的更改将被覆盖"
```

按钮名称是 **Load Config File / 加载配置文件**，不是“保存”；lore 第二行用一整行专门警告
未保存修改会被覆盖。管理员点击前看到的是“从磁盘重新加载 + 会覆盖未保存修改”，不是歧义操作。

### 同一菜单里还有非破坏性路径

- `MainConfigMenu.java:131-144` 的 **Revert All Unsaved Changes / 撤销所有未保存更改**，
  以及保存按钮。管理员若想保留内存修改，应先保存；若想放弃，reload 和 revert 是两条明确路径。
- 菜单打开时不会自动 reload；只有点击这个按钮才会触发。
- `/hilltop reloadconfig`（`HilltopCommandHandler.java:420`）是另一条显式管理命令，同样以磁盘为准；
  它不是“保存”命令，语义上也不承诺保留未保存内存。

## 为什么判定为“不是缺陷”

1. **可预见、已告知、由管理员主动触发**：这不是“打开菜单就悄悄丢失”，而是点击一个文案为
   “Load Config File”的按钮；警告已写在按钮 lore 里。
2. **“重新加载”在配置系统中的标准语义就是从磁盘重建**。如果 reload 还保留内存中的未保存值，
   它就不再是 reload，而是“合并磁盘与内存”，会产生更难解释的优先级问题。
3. **增加二次确认是产品/UX 设计，不是缺陷修复**。需要决定确认 UI（第二次点击？聊天输入？）、
   超时、权限、本地化，以及是否对 `/hilltop reloadconfig` 也生效；这超出了“修复缺陷”的范围，
   也会改变现有管理员已经依赖的一步操作。
4. 现有文案已经把“会覆盖”编码为预期契约。把“点击后确实覆盖”写成测试，只是在把被指控的 bug
   当成期望行为固定下来；这种测试没有回归价值。

因此没有“先写失败测试”的步骤：本项的决定就是**不修**。既有测试未改。

## 如果未来要改，应该做成独立需求

- 给 reload 增加确认步骤，并同时覆盖 GUI 与 `/hilltop reloadconfig`；
- 或把按钮改成“放弃修改并重新加载”，让破坏性更醒目；
- 或仅在 `hasUnsavedChanges()` 为 true 时弹确认，无修改时保持一步。

这些都需要新的交互测试（例如确认界面打开、取消后内存值不变、确认后磁盘值生效），
不应塞进本次缺陷修复。

## 风险与未覆盖场景

- 警告是灰色 lore，容易被忽略；误点仍会丢失未保存修改，且没有撤销。UX 上可以更好，但这是
  可发现性与确认流程的改进，不是“行为与承诺不符”。
- **相邻的真实问题（不在 #3 范围）**：`loadFromFile()` 返回 `void`。当 `game-settings.yml`
  不可用（`ConfigManager.java:1373-1380`）时，它保留内存值并提前返回，但菜单仍发送
  “Config reloaded from game-settings.yml.”。这时消息是假的，不过它并没有“丢失未保存修改”，
  而是“根本没 reload”。应另开缺陷：让 `loadFromFile` 返回成功/失败，菜单按结果发消息。
- `/hilltop reloadconfig` 不显示与 GUI 相同的“未保存会被覆盖”警告；它是管理员显式命令，
  但若未来要求一致性，应把警告补到命令反馈里。
- 没有自动化测试守护“reload 会丢弃未保存值”。这是有意不写：该行为是产品选择，若未来改成确认流程，
  测试应随之改成“取消不丢、确认才丢”。
