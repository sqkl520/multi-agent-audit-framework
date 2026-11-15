# 修复后源码快照（post-fix）

**快照时间**：2026-11-15
**来源**：`<TARGET_REPO>/`

---

## 为什么有这个目录

`../project/` 是**修复前的基线快照**。在它之后，这个仓库里**没有任何地方记录修复最终长什么样**。

后果在 `../LEGACY-ARTIFACTS.md` §八 第 2 条已经写明：

> 这次修复的成果在实验记录里没有对应快照——**任何只看本仓库的人都会得出
> 「修复没发生过」或「源码不可访问」的错误结论。**

这个目录补上那个缺口。现在实验记录是自包含的：

```
repair-work/project/     修复前（基线）
repair-work/post-fix/    修复后（本次）
```

---

## 包含什么

### 被修改的生产代码（10 个）

| 文件 | 改了什么 | 对应 |
|---|---|---|
| `mechanics/NodeListener.java` | 新增 `planRepair(...)` 纯函数 + `RepairPlan` record | #1 |
| `ai/ExplodeBeetleGoal.java` | `DEFAULT_EXPLOSION_POWER = 3.0f`，倍率与爆炸威力解耦 | #6 |
| `config/ConfigManager.java` | 三处载入侧钳制 + `loadFromFile()` 改为返回 `boolean` | #7 #8 |
| `admin/ArenaResetService.java` | 新增 `NODE_ROLLBACK_FAILED`，第 8 步失败先回滚节点 | #4 |
| `mechanics/NodeSystem.java` | 新增 `restoreNodesForWorld(...)` | #4 |
| `ai/AirdropSpawnGoal.java` | mobType 解析的 null 守卫 + `finally` 清理 | #5 |
| `mechanics/TabListManager.java` | catch 不再清句柄（任务不累积） | #2 |
| `admin/gui/ArenaManageGUI.java` | `NODE_ROLLBACK_FAILED` 的消息映射 | #4 |
| `config/menu/MainConfigMenu.java` | 消费 `loadFromFile()` 返回值 | #8 |
| `command/HilltopCommandHandler.java` | 同上 | #8 |

### 资源文件（2 个）

- `resources/game-settings.yml` —— `repair-cost-amount` 注释改为「单次最多消耗几个」
- `resources/messages.yml` —— 新增 4 个消息键（EN/ZH × `config-reload-failed` /
  `config.menu.main.reload-failed`）与 2 个（EN/ZH × `manage.reset.done-node-rollback-failed`）

### 新增的测试类（5 个）

- `RepairSettlementTest.java` —— #1 的结算逻辑
- `ArenaResetNodeRollbackTest.java` —— #4 的回滚
- `ConfigLoadClampTest.java` —— #7 的钳制
- `MainConfigMenuReloadResultTest.java` —— #8 的 GUI 路径
- `HilltopCommandReloadResultTest.java` —— #8 的命令路径

---

## 这个快照能证明什么、不能证明什么

**能证明**：

- 修复确实发生过，且内容与 `repair/done-*.md` 的描述一致
- `grep -c "planRepair"` 在 `NodeListener.java` 里是 3，
  `grep -c "DEFAULT_EXPLOSION_POWER"` 在 `ExplodeBeetleGoal.java` 里是 2
- 新测试类真实存在，可以读内容核对它们测什么

**能证明（机械）**：这份快照**完整覆盖了被审仓库的全部改动**。跑：

```
node tools/verify-postfix-snapshot.mjs \
  --repo "<TARGET_REPO>" \
  --snapshot experiments/hilltop-dsh/repair-work/post-fix \
  --exclude repair-artifacts/
```

它逐条比对 `git status --porcelain` 的每一项：改动文件必须在快照里有同名且**逐字节相同**的副本。

> **为什么需要这条命令**：第一次补拍漏了 7 个文件（4 个被修改的测试类 + 3 个新增测试类），
> 是人工逐行读 `git status` 才发现的。事后补拍的东西有共同的失效模式——**补漏了没人发现**。
> 那句 `--exclude repair-artifacts/` 也不是随口加的：那是**修复产物**目录（不是源码），
> 它有自己的落点（框架仓库的 `repair/`），混进源码快照会让「快照是否完整」这个判据变模糊。

**不能证明**：

- **红测日志仍然不可恢复。** 那三个「修复前是红的」日志被 `mvn clean` 删光了，
  快照里没有、也不可能有。`LEGACY-ARTIFACTS.md` 选 C（豁免）的核心原因正是这一条。
- 这份快照是**事后补拍**的，不是修复当时留下的。它的可信度低于
  「修复过程中自动落盘」的产物——但高于「什么都没有」。
- 快照内容与仓库一致，**不代表这些改动是对的**。那是评审的事。

---

## 与 `legacy_artifacts` 豁免的关系

`repair/done-*.md` 仍然在 `legacy_artifacts` 里，**本目录不改变那个决定**。

理由没有变：补信封会指向三样不存在的东西（红测日志、新测试文件、修复后源码），
而现在**第 3 项已经有了**——但第 1 项（红测日志）是真丢了，补出来的信封仍会 FAIL。

不过这个快照让一件事变清楚了：**「不可复核」的准确范围是「红测日志不可复核」，
不是「整个修复不可复核」**。任何人现在都可以：

1. 打开 `post-fix/.../NodeListener.java`，看到 `planRepair` 的实现
2. 打开 `post-fix/.../RepairSettlementTest.java`，看到它测什么
3. 拿 `D:/Server/...` 当 `--repo` 重跑 `check-payload`（`red_log_path` 仍会 FAIL，其余字段都能验）

**证据链从「全断」变成了「断一环」。**
