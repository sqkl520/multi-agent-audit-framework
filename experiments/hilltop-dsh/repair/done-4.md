# #4 — 重置第 8 步失败后重新启用，留下 0 节点可玩空图

**状态：已修复（备份/回滚，不交换步骤顺序）。**

## 涉及文件与关键代码

### `src/main/java/com/hilltopvillage/admin/ArenaResetService.java`

- `:287-289` — 第 5 步删除前先备份该世界的节点：

```java
List<Location> nodeBackup = NodeSystem.readNodesForWorld(dataFolder, world);
int expectedNodes = nodeBackup.size();
int removedNodes = NodeSystem.clearNodesForWorld(dataFolder, world);
```

- `:317-338` — 第 8 步失败时先回滚节点，再决定是否重新启用：

```java
if (!dataOk) {
    boolean nodesRolledBack = true;
    if (!nodeBackup.isEmpty()) {
        nodesRolledBack = NodeSystem.restoreNodesForWorld(dataFolder, world, nodeBackup);
        if (nodesRolledBack) {
            plugin.getLogger().info(LOG + "nodes-rolled-back arena=" + arenaId
                    + " count=" + nodeBackup.size());
        } else {
            plugin.getLogger().severe(LOG + "nodes-rollback-failed arena=" + arenaId
                    + " count=" + nodeBackup.size()
                    + " —— the arena will stay DISABLED to avoid a 0-node playable arena");
        }
    }
    abort(ctx, "deployment",
            "clearDeploymentData returned false (arena missing or arenas.yml write failed)"
                    + (nodesRolledBack ? "; nodes restored" : "; NODE ROLLBACK FAILED"),
            !nodesRolledBack || nodeBackup.isEmpty(), false, nodesRolledBack, onDone);
    return;
}
```

- `:113-116` — 新增跳过原因：

```java
NODE_ROLLBACK_FAILED
```

- `:441-461` — `abort(...)` 增加 `tryReinstate` 重载；`false` 时不再调用 `reinstateRestoring`，
  直接填 `NODE_ROLLBACK_FAILED`：

```java
ReinstateSkip skip = tryReinstate
        ? reinstateRestoring(ctx)
        : ReinstateSkip.NODE_ROLLBACK_FAILED;
```

- `:332-336` — `nodesCleared` 从“节点清理成功”改为“删除是否仍然生效”：
  回滚成功 → false；回滚失败/本来无节点 → true。`Outcome` 的 javadoc 同步更新。

### `src/main/java/com/hilltopvillage/mechanics/NodeSystem.java:526-573`

新增 `restoreNodesForWorld(dataFolder, worldName, locations)`：

- 空/null 备份 → true；dataFolder/worldName 非法 → false。
- 重新读 `nodes.yml`，保留其它世界条目。
- 只追加目标世界中缺失的坐标；`Integer 100` 与 `Double 100.0` 用 `coordinateKey` 归一化去重。
- `nodes.yml` 不可用或写盘失败 → false，绝不谎报成功。
- 节点的持久化格式只有 `world/x/y/z`（血量不落盘），所以 `Location` 备份对“重置”场景无损。

### `src/main/java/com/hilltopvillage/admin/gui/ArenaManageGUI.java:846`

```java
case NODE_ROLLBACK_FAILED -> "manage.reset.done-node-rollback-failed";
```

### `src/main/resources/messages.yml`

- EN `:1107`：`manage.reset.done-node-rollback-failed`
- ZH `:2205`：同名键

文案明确说“竞技场保持 DISABLED，修好 nodes.yml 后手动 enable”，而不是继续装作部分成功。

### `src/test/java/com/hilltopvillage/admin/ArenaResetNodeRollbackTest.java`（新增，2 条）

- `deploymentFailureRestoresNodesBeforeReinstate`：真实 `nodes.yml`（目标世界 2 个 + lobby 1 个），
  真实 `ArenaResetService` 跑到第 8 步，mock `clearDeploymentData=false`、`enableArena=true`；
  断言目标 2 个节点恢复、lobby 条目保留、`failStep=deployment`、`reinstated=true`、
  `nodesCleared=false`、`enableArena` 被调用。
- `rollbackFailureKeepsArenaDisabled`：在第 8 步的 answer 里把 dataFolder 变成普通文件，
  让 `restoreNodesForWorld` 无法创建 `nodes.yml`；断言 `reinstated=false`、
  `reinstateSkipped=NODE_ROLLBACK_FAILED`、`enableArena` 从未调用。

## 失败测试与失败信息（未修复代码）

未修复代码上，`deploymentFailureRestoresNodesBeforeReinstate` 的第一次红色先撞在
`nodesCleared`（中止后仍报告 true）；把“文件里节点是否回来”的断言提前后，得到核心红色：

```
第 8 步失败后必须把第 5 步删掉的 2 个节点恢复，否则重新启用的是 0 节点空图
==> expected: <2> but was: <0>
Tests run: 1, Failures: 1
```

这正是生产缺陷：`abort()` 只恢复 enabled 状态，不恢复第 5 步已经删掉的节点。

第二条 `rollbackFailureKeepsArenaDisabled` 是随修复新增的防线；旧代码没有
`NODE_ROLLBACK_FAILED` 这个枚举值，无法在未修复代码上编译运行。它守的是“回滚失败时不要再启用”
这一分支，而不是另一个旧 bug。

## 修复后结果

```
ArenaResetNodeRollbackTest: Tests run: 2, Failures: 0, Errors: 0, Skipped: 0
完整套件: Tests run: 877, Failures: 0, Errors: 0, Skipped: 1
BUILD SUCCESS
```

## 是否改过既有测试

没有。新增 `ArenaResetNodeRollbackTest.java`；既有 `ArenaResetServiceTest` 等未改，完整套件全绿。

## 为什么选“备份/回滚”，不选“交换第 5 步和第 8 步”

交换顺序只能把不可逆损失挪到另一条失败路径：

- 若第 8 步先做且失败：节点还没删，确实安全。
- 若第 8 步先做且成功、第 5 步随后失败：`arenas.yml` 里的 core / spawn-points / shop-npc
  已经被清掉，`reinstate()` 会因为 core 缺失而拒绝启用；竞技场留在 DISABLED，且部署数据已经永久丢失，
  管理员必须重新走 setup。问题从“0 节点可玩空图”变成“部署数据丢失 + 竞技场停用”，并没有更好。

`clearDeploymentData` 的实现是“读盘 → 改内存中的 `YamlConfiguration` → `arenasGate.write` 原子写”；
返回 false 表示竞技场不存在或写盘失败，**磁盘上的部署数据没有被改**（`YamlFiles.write` 用临时文件 +
ATOMIC_MOVE）。因此第 8 步失败时唯一需要回滚的就是第 5 步的节点删除，备份/回滚正好配对。

## 风险与未覆盖场景

- **第 7 步商店 NPC 仍是不可逆的**：`despawnOwnShopNpc(world)` 在第 8 步之前执行；若第 8 步失败，
  节点会回滚、竞技场会重新启用，但已经被 despawn 的村民不会回来。`arenas.yml` 里的 shop-npc
  位置还在（第 8 步没写成功），下次部署/启用是否重建实体取决于 NPC 管理器的生成路径，本测试未覆盖。
  这是本次修复明确没有解决的残留风险。
- 第 10 步地图回滚尚未执行，因此中止路径不会留下“地图已回滚但节点没恢复”的组合；但地图回滚
  自身失败（`failStep=restore`）的处理不在本缺陷范围。
- 如果 `readNodesForWorld` 因文件不可读返回空列表，而 `clearNodesForWorld` 也返回 0，流程会在第 5 步
  以 `expectedNodes=0` 继续；此时没有“删了但没备份”的情况，但也无法证明节点真的存在过。
- `restoreNodesForWorld` 只恢复坐标，不恢复节点当前血量/激活状态；`nodes.yml` 本来就不持久化这些，
  重置后的节点按新一局初始化，符合预期。
- 回滚失败时竞技场保持 DISABLED，管理员必须手动修 `nodes.yml` 后 `/hilltop enable`；GUI 只给文案，
  不会自动重试。这是有意的 fail-closed，但要求管理员能看懂控制台/聊天里的提示。
- `nodesCleared` 的语义从“清理成功”改成“删除仍生效”，只有中止路径会出现 false；GUI 成功路径
  的使用不受影响，但未来若有人把它当“操作成功”使用，需要看新的 javadoc。
