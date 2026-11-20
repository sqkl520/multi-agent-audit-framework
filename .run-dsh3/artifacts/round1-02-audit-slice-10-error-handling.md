# round1-02 审计 — slice-10 / error-handling

- **agent_id**: `audit-slice-10-error-handling`
- **slice_id**: `slice-10`
- **dimension**: `error-handling`（只报这一维度）
- **主文件**: `src/main/java/com/hilltopvillage/command/SetupWizard.java`（实读 **2286** 行，非派发书写的 1952 行；见 off_dimension_notes #3）
- **shared_dependencies（只读必要段）**: `command/HilltopCommandHandler.java`、`admin/AdminDeployManager.java`
- **控制流旁证（直接被调用方）**: `arena/MultiArenaManager.java:270-329`、`core/GameManager.java`（仅 grep 确认 `getAdminDeployManager` 为 final 字段）
- **结论**: 3 条 CONFIRMED（1 HIGH / 1 MEDIUM / 1 LOW），0 条 NO_EVIDENCE_FOUND

---

## 1. 发现

### F-slice-10-eh-01（对应 sweep L4）— 必填复核在“解析不到部署管理器”时 fail-open，调用方据此不可逆地清会话并启用竞技场

**Evidence**（`SetupWizard.java:1175`，本回合逐字读到）

```java
        if (d == null) return true;  // 解析不出部署管理器（世界被卸载等极端情况）不额外拦截
```

**控制流（本回合逐行读到的调用链）**

| 序 | 位置 | 代码/行为 |
|---|---|---|
| 1 | `HilltopCommandHandler.java:468-472` | `/hilltop setup goto 8` → `setupWizard.handle(player, "goto 8")` |
| 2 | `SetupWizard.java:1664` | `case 8: showStepDone(player); break;` |
| 3 | `SetupWizard.java:1012` | `if (session != null && !validateCompletion(player, session)) { return; }` |
| 4 | `SetupWizard.java:1174-1175` | `AdminDeployManager d = deploy(player);` → `d == null` 时 **`return true`**，跳过 :1178-1197 的五项检查（spawnPoints / mobSpawnPoints / nodes / villagers / shopNpcLocation） |
| 5 | `SetupWizard.java:1060-1065` | `sessions.remove(...)`、`config.set("wizard.step."+uuid, null)`、`config.set("wizard.arena."+uuid, null)`、`saveConfig()` |
| 6 | `SetupWizard.java:1068` | `boolean enableQueued = finishDeployment(arenaId);` |
| 7 | `SetupWizard.java:173-177` | `getArena(arenaId)==null` → `reloadDefinitions()` → `enableArena(arenaId)` |

**Inference**

- **claim**：当 `deploy(player)` 解析不到部署管理器（目标世界未加载 / 竞技场定义缺失 / 部署期上下文刚被丢弃）时，`validateCompletion` 把“无法检查”当成“四项齐备”返回 `true`；`showStepDone` 不区分该返回值的来源，继续移除会话、清空 `wizard.step` / `wizard.arena` 并 `saveConfig`，随后 `finishDeployment` 走 `reloadDefinitions → enableArena`。错误路径被当成完成路径，产生**不可逆**的进度清除与一次竞技场启用尝试。
- **basis**：:1012 是完成收尾的唯一门，唯一的“失败”信号来自 :1205 的 `return false`（:1178-1197 的缺项分支）；:1175 直接返回 `true` 使这条门在解析失败时失效，且 :1060-1068 无任何二次确认。`deploy()` 的 null 契约在 :70-73 明写（`return gm == null ? null : gm.getAdminDeployManager();`），`gameManager` 在 :64-67 也可为 null；同文件另有 4 处对 deploy 判空（:731、:1021、:1141、:1723），说明作者自己把 null 视为可达状态。:1015-1019 的注释也承认这是“极端情况”，但处理方式是“不额外拦截”，方向与“必填复核”相反。
- **alternatives**：
  1. 若存在会话时 `deploy()` 恒不为 null（`start(Player)` 在 :210 已用 `deploymentGameManager(arenaId)==null` 早退，且 :147 的 `computeIfAbsent` 会缓存上下文），则 :1175 不可达、本条应降为防御性冗余——需检查 `SetupWizard.java:210` 与 `:121-158`。
  2. 若 `enableArena` 对未部署竞技场一律拒绝（`MultiArenaManager.java:293-306` 对 `definition==null` / `enabled==false` / `core==null` 三处 `return false`），则“启用未完成竞技场”的后果不成立，只剩会话与进度被清——需检查 `MultiArenaManager.java:302`。
  3. 若被清掉的进度可由 `arenas.yml` 已落盘数据 + 重新 `/hilltop setup` 无损恢复（:240-260 的恢复只读 `wizard.step` / `wizard.arena`，不读业务数据），影响降为“管理员重走一遍向导”——需检查 `SetupWizard.java:240-260`。

**严重性说明**：保持 sweep 的 HIGH。理由是“错误路径被计为通过 + 副作用不可逆（会话/进度清除 + 启用尝试）”，而非单纯少一条提示；但 alternatives #2 若成立，危害上限会降到“进度丢失”。本回合未跑服务端，故不标 CRITICAL。

---

### F-slice-10-eh-02（对应 sweep L6）— 渲染/删除路径直接解引用 `deploy(player)`，与同文件 4 处判空口径不一致

**Evidence**（`SetupWizard.java:921`，本回合逐字读到）

```java
        Location shop = deploy(player).getShopNpcLocation();
```

**Inference**

- **claim**：`sendShopStatus` 在第 6 步状态行直接链式调用 `deploy(player)`，未判其 null 返回。同型未判空解引用至少还有 :452、:497-498、:538、:542、:555、:626、:875、:948、:1344、:1948、:2024。一旦 `deploy` 为 null，NPE 会从命令处理器或 `InventoryClickEvent` 处理器抛出，该次操作后续的消息、按钮行、GUI 刷新全部不执行，玩家得不到任何提示（`clear-shop` 更是在 :1344 就炸，配置与实体都不会被清）。
- **basis**：`deploy(Player)` 在 :70-73 明确可返回 null，`gameManager` 在 :64-67 也可返回 null；同文件 :731、:1021、:1141、:1723 都先判空，说明“判空”是本类的既有约定而非我的追加要求。可达窗口与 F1 同源：live 实例为 null、`deploymentContexts` 无缓存、`createDeploymentContext`（:151-158）因 `def==null` 或 `world==null` 返回 null；缓存的唯一两处移除点是 :179（finishDeployment）与 :195（invalidateDeploymentContext，重置路径调用）。`InventoryClickEvent` 侧的入口是 :1734-1767 → `handleSpawnGuiClick`（:1889）→ default 分支（:1942-1962）。
- **alternatives**：
  1. 若 `deploymentContexts` 在会话存活期间不会被移除（只有 :179、:194-196 两处 `remove`），则 d 恒非 null、本条不可达——需检查 `SetupWizard.java:179` 与 `:194-196`。
  2. 若 Bukkit/Paper 的事件分发器捕获监听器异常后继续派发给其它插件（只记 `Could not pass event`），影响限于该次点击无响应，不构成服务器级故障——需检查服务端 `InventoryClickEvent` 的调用封装。
  3. 若所有进入 :921 的路径都先经过 `start()` 的 :210 上下文检查且中途不换世界，则该窗口不存在——需检查 `SetupWizard.java:210` 与 `:1654-1661` 的 goto 分支。

---

### F-slice-10-eh-03（对应 sweep L1）— 生成点删除分支裸 `parseInt`，与同族村民/节点分支的 try + 留痕不一致

**Evidence**（`SetupWizard.java:1944`，本回合逐字读到）

```java
                    int idx = Integer.parseInt(tag.substring("setup-spawn-".length()));
```

**对照（同回合读到，构成“本仓库既有写法”而非外部规范）**

```java
1858:                        try {
1859:                            int index = Integer.parseInt(tag.substring("villager-".length()));
...
1876:                        } catch (NumberFormatException ignored) {
1880:                            plugin.getLogger().warning("SetupWizard: non-numeric villager tag index \""
```

- 村民分支 :1858-1883：`try` + `logger.warning` + 回玩家 `setup.goto-invalid-number`
- 节点分支 :2111-2134：同型
- 生成点分支 :1944：**无 try**；刷怪点分支 :2022（`Integer.parseInt(tag.substring("setup-mobspawn-".length()))`）同样无 try

**Inference**

- **claim**：标签漂移（跨版本 `/reload` 遗留的旧 GUI 物品、tag 生成前缀改动、PDC 被外部写入）时，`NumberFormatException` 会从 `InventoryClickEvent` 处理器逃逸：该次点击的删除、页码复位、GUI 刷新、`autoSave` 全部不执行，且插件侧零日志——第一信号既没进控制台也没给玩家提示，只有服务端的通用事件异常。
- **basis**：同一 `switch` 的两个同族分支（:1858-1883、:2111-2134）都包了 try，且 :1877-1879 的注释明写“正常路径不可达；真发生时……要出声，否则这第一信号被静默吞掉”——作者已经为同族分支定过口径，:1944 与 :2022 是漏网。tag 的唯一生成侧是 :463（`"setup-spawn-" + i`）与 :2227（PDC 写入），本类不持久化 GUI 物品，所以这是错误处理口径不一致，不是外部输入信任问题。
- **alternatives**：
  1. 若 GUI 物品不跨 `/reload` / 跨版本存活（关闭界面即销毁），tag 漂移不可达，本条应降为纯一致性缺陷——需检查 `SetupWizard.java:2227` 的 PDC 写入与物品生命周期（本类未见持久化容器）。
  2. 若 Paper 对监听器抛出的 `RuntimeException` 统一打印含插件名与堆栈的日志，则“零留痕”不成立，只剩“玩家无反馈”——需检查服务端事件分发的日志实现。
  3. 若 `setup-spawn-` 前缀只有 :463 一处生成点且不会改，漂移概率极低，可只做防御性补齐——需检查 `SetupWizard.java:463` 与 :651/:800 的 tag 生成点。

**严重性说明**：sweep 记为 MEDIUM（contract 维度）；本维度复核后下调为 **LOW**——输入源是插件自造 tag，正常路径不可达，缺陷是“异常逃逸 + 无留痕”而非数据损坏。

---

## 2. sweep L1–L6 处置表（漏处置 = 未审计）

| sweep | 位置 | sweep 维度/级别 | 本次处置 | 依据 |
|---|---|---|---|---|
| **L1** | `SetupWizard.java:1944` | contract / MEDIUM | **CONFIRMED** → F-slice-10-eh-03（本维度受理，级别下调为 LOW） | 裸 `parseInt` 无 try；同族 :1858-1883 / :2111-2134 有 try + warning。属 error-handling 清单“parseInt 未包 try” |
| **L2** | `SetupWizard.java:1845` | logic / MEDIUM | **OFF_DIMENSION**（logic）→ off_dimension_notes #1 | 步骤守卫缺失是 logic 分支问题；本维度不立项 |
| **L3** | `SetupWizard.java:1687` | data-consistency / MEDIUM | **REFUTED**（作为 error-handling 缺陷不成立） | 见下 |
| **L4** | `SetupWizard.java:1175` | error-handling / HIGH | **CONFIRMED** → F-slice-10-eh-01（HIGH） | 调用链 :1012 → :1175 → :1060-1068 → :176-177 完整读到 |
| **L5** | `SetupWizard.java:133` | data-consistency / MEDIUM | **OFF_DIMENSION**（data-consistency）→ off_dimension_notes #2 | 缓存重载范围属数据一致性；本维度不立项 |
| **L6** | `SetupWizard.java:921` | error-handling / MEDIUM | **CONFIRMED** → F-slice-10-eh-02（MEDIUM） | :921 本回合读到确为无判空解引用；同文件 4 处判空为对照 |

**L3 为什么 REFUTED（只针对 error-handling 口径）**

`autoSave`（:1676-1700）里 `saved` 取的是 `gameManager(player).getConfigManager().saveToFile()`（业务数据，arenas.yml / game-settings 等），而 `wizard.step` / `wizard.arena` 写的是 `plugin.getConfig()`（config.yml），由 :1687 的 `plugin.saveConfig()` 单独落盘。两者不是同一份文件，“业务写盘失败”不改变“步骤指针自身已落盘”的语义；且 :1693-1699 已按 `saved` 与 `arenaFailed` 分别播报失败/成功，没有把失败报成成功。

真正的风险是“步骤前进但业务数据未落盘”，而该风险在完成收口被 :1012 的 `validateCompletion` 五项复核挡住（缺项会弹回对应步骤并落盘新 step，:1198-1204）。本回合没有读到任何绕过 :1012 的完成路径，因此以 error-handling 立条不成立。

> 注意：以上只否定“error-handling 缺陷”。sweep 把它记在 data-consistency，该维度是否成立（例如“步骤指针领先于数据”本身算不算不一致）不由本实例裁定，未做跨维度推断。

---

## 3. off_dimension_notes

1. **L2（logic）** `SetupWizard.java:1845-1854`：`setup-villagers-done` 的 GUI 分支直接 `s.advance()`，而聊天路径 :1544 有 `if (s.step != 5)` 守卫。本回合只确认这一差异存在，未评估可达性与影响（GUI 仅在 step 5 打开），交 logic 维度实例判定。
2. **L5（data-consistency）** `SetupWizard.java:133` 只调 `loadSpawnPoints()`、:143 只调 `loadNodesFromConfig()`，villagers / shop 未重载。本回合只确认重载范围，未验证“整份写回覆盖外部改动”的路径，交 data-consistency 实例判定。
3. **文件行数不符**：派发书写 1952 行，实际 `read` 到 EOF 为 **2286** 行。三处锚点 :921 / :1175 / :1944 与描述内容一致、未漂移；但若上游按 1952 行做过其它切片的行号推算，需要复核。
4. **同方法内两种 null 口径**：`showStepDone` 对 `validateCompletion` 的 null（:1175）是“放行”，对 `deploy(player)` 的 null（:1021）是“跳过补生成”。后者已并入 F1 的 basis，不单独立条（同一根因）。
5. **未越维度**：`getSpawnPoints()` 等是否返回内部 list 引用（模式 1）属 data-consistency，本回合未展开、未在 findings 中立项。

---

## 4. 自检

- **标识符对账（DONE）**：`deploy()` 空值契约（:70-73）与调用点对账——显式判空 5 处（:731、:1021、:1141、:1246 的 `cwDeploy`、:1723），未判空直接解引用 ≥10 处（:452、:497、:498、:538、:542、:555、:626、:875、:921、:948、:1344、:1948、:2024）。与 sweep 的“五处防了 null”一致（含 :1246）。`parseInt` 三族对账：villager :1859 有 catch、node :2112 有 catch、spawn :1944 与 mobspawn :2022 无 catch——差集即 F3。
- **自带自检抽验（NOT_APPLICABLE）**：`glob src/test/**/*.java` 返回空（仓库只有 `target/classes` 下的 .class），无针对本类的测试或自检脚本可注入；改用同文件同族守卫（deploy 判空 4 处、parseInt try 2 处）作对照，确认 F2/F3 是“差异”而不是“通例”。
- **运行时验证（SKIPPED）**：需要 Bukkit/Paper 服务端 + 可卸载的竞技场世界才能触发“世界未加载 → deploy 返回 null”，且 taskbook 禁止构建（会写 `target/`），本机无可用的测试服，故只做静态控制流验证。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "audit-slice-10-error-handling",
  "role": "audit",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/.run-dsh3/artifacts/round1-02-audit-slice-10-error-handling.md",
  "payload": {
    "findings": [
      {
        "finding_id": "F-slice-10-eh-01",
        "severity": "HIGH",
        "dimension": "error-handling",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/command/SetupWizard.java",
          "line": 1175,
          "quote": "        if (d == null) return true;  // 解析不出部署管理器（世界被卸载等极端情况）不额外拦截"
        },
        "inference": {
          "claim": "当 deploy(player) 解析不到部署管理器（目标世界未加载 / 竞技场定义缺失 / 部署期上下文刚被丢弃）时，四项必填复核把「无法检查」当成「四项齐备」返回 true；调用方 showStepDone 不区分该返回值来源，继续移除会话、清空 wizard.step / wizard.arena 并 saveConfig，随后 finishDeployment 走 reloadDefinitions → enableArena。错误路径被当成完成路径，产生不可逆的进度清除与一次竞技场启用尝试。",
          "basis": "调用链（本回合逐行读到）：HilltopCommandHandler.java:468-472 的 /hilltop setup goto 8 → SetupWizard.handle:1632-1665 的 case 8 → showStepDone:1005 → :1012 的 if (session != null && !validateCompletion(player, session)) return; → validateCompletion:1173-1175 在 d==null 时 return true，跳过 :1178-1197 的 spawnPoints / mobSpawnPoints / nodes / villagers / shopNpcLocation 五项检查 → :1060 sessions.remove、:1062 与 :1064 config.set(...,null)、:1065 saveConfig、:1068 finishDeployment(arenaId) → :173-177 reloadDefinitions 与 enableArena。deploy() 的 null 契约在 :70-73 明写，同文件另有 4 处判空（:731、:1021、:1141、:1723），说明 null 被作者视为可达状态。",
          "alternatives": [
            "若存在会话时 deploy() 恒不为 null（start(Player) 在 :210 已用 deploymentGameManager(arenaId)==null 早退，且 :147 的 computeIfAbsent 会缓存上下文），则 :1175 不可达、本条应降为防御性冗余——需检查 SetupWizard.java:210 与 :121-158。",
            "若 enableArena 对未部署竞技场一律拒绝（MultiArenaManager.java:293-306 对 definition==null / enabled==false / core==null 三处 return false），则「启用未完成竞技场」的后果不成立，只剩会话与进度被清——需检查 MultiArenaManager.java:302。",
            "若被清掉的进度可由 arenas.yml 已落盘数据 + 重新 /hilltop setup 无损恢复（:240-260 的恢复只读 wizard.step / wizard.arena，不读业务数据），影响降为「管理员重走一遍向导」——需检查 SetupWizard.java:240-260。"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "F-slice-10-eh-02",
        "severity": "MEDIUM",
        "dimension": "error-handling",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/command/SetupWizard.java",
          "line": 921,
          "quote": "        Location shop = deploy(player).getShopNpcLocation();"
        },
        "inference": {
          "claim": "sendShopStatus 在第 6 步状态行直接链式调用 deploy(player)，未判其 null 返回；同型未判空解引用至少还有 :452、:497-498、:538、:542、:555、:626、:875、:948、:1344、:1948、:2024。一旦 deploy 为 null，NPE 会从命令处理器或 InventoryClickEvent 处理器抛出，该次操作后续的消息、按钮行、GUI 刷新全部不执行，玩家得不到任何提示；clear-shop 在 :1344 就炸，配置与实体都不会被清。",
          "basis": "deploy(Player) 在 :70-73 明确可返回 null（gm == null 时返回 null），gameManager 在 :64-67 也可返回 null；同文件 :731、:1021、:1141、:1723 都先判空，说明判空是本类既有约定。可达窗口与 F1 同源：live 实例 null、deploymentContexts 无缓存、createDeploymentContext（:151-158）因 def==null 或 world==null 返回 null；缓存移除点只有 :179（finishDeployment）与 :195（invalidateDeploymentContext）。GUI 侧入口为 :1734-1767 → handleSpawnGuiClick:1889 → default 分支 :1942-1962。",
          "alternatives": [
            "若 deploymentContexts 在会话存活期间不会被移除（只有 :179、:194-196 两处 remove），则 d 恒非 null、本条不可达——需检查 SetupWizard.java:179 与 :194-196。",
            "若 Bukkit/Paper 的事件分发器捕获监听器异常后继续派发（只记 Could not pass event），影响限于该次点击无响应，不构成服务器级故障——需检查服务端 InventoryClickEvent 的调用封装。",
            "若所有进入 :921 的路径都先经过 start() 的 :210 上下文检查且中途不换世界，则该窗口不存在——需检查 SetupWizard.java:210 与 :1654-1661 的 goto 分支。"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "F-slice-10-eh-03",
        "severity": "LOW",
        "dimension": "error-handling",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/command/SetupWizard.java",
          "line": 1944,
          "quote": "                    int idx = Integer.parseInt(tag.substring(\"setup-spawn-\".length()));"
        },
        "inference": {
          "claim": "第 3 步生成点 GUI 的删除分支对插件自造 tag 直接 Integer.parseInt，未包 try；同族村民分支 :1858-1883 与节点分支 :2111-2134 都包了 try、logger.warning 并回玩家一条提示，刷怪点分支 :2022 同样裸奔。tag 漂移时 NumberFormatException 会从 InventoryClickEvent 处理器逃逸：该次点击的删除、页码复位、GUI 刷新、autoSave 全部不执行，且插件侧零日志。",
          "basis": "对照证据在同一文件本回合读到：:1858-1883 的 catch (NumberFormatException ignored) 内有 plugin.getLogger().warning 与 player.sendMessage，注释明写「标签由本插件生成……正常路径不可达；真发生时……要出声」；:2111-2134 同型。而 :1944 与 :2022 的 parse 调用前后没有任何 try。tag 唯一生成侧是 :463 的 \"setup-spawn-\" + i 与 :2227 的 PDC 写入，本类不持久化 GUI 物品，因此这是错误处理口径不一致，不是外部输入信任问题。",
          "alternatives": [
            "若 GUI 物品不跨 /reload 或跨版本存活（关闭界面即销毁），tag 漂移不可达，本条应降为纯一致性缺陷——需检查 SetupWizard.java:2227 的 PDC 写入与物品生命周期（本类未见持久化容器）。",
            "若 Paper 对监听器抛出的 RuntimeException 统一打印含插件名与堆栈的日志，则「零留痕」不成立，只剩「玩家无反馈」——需检查服务端事件分发的日志实现。",
            "若 setup-spawn- 前缀只有 :463 一处生成点且不会改，漂移概率极低，可只做防御性补齐——需检查 SetupWizard.java:463 与 :651、:800 的 tag 生成点。"
          ]
        },
        "status": "CONFIRMED"
      }
    ],
    "searched_scope": {
      "files_read": [
        "src/main/java/com/hilltopvillage/command/SetupWizard.java",
        "src/main/java/com/hilltopvillage/command/HilltopCommandHandler.java",
        "src/main/java/com/hilltopvillage/admin/AdminDeployManager.java",
        "src/main/java/com/hilltopvillage/arena/MultiArenaManager.java"
      ],
      "files_in_slice": 1,
      "shared_dependencies_read": [
        "src/main/java/com/hilltopvillage/command/HilltopCommandHandler.java",
        "src/main/java/com/hilltopvillage/admin/AdminDeployManager.java",
        "src/main/java/com/hilltopvillage/arena/MultiArenaManager.java"
      ],
      "files_scanned_without_findings": [
        "src/main/java/com/hilltopvillage/core/GameManager.java"
      ],
      "dimension_checklist": [
        { "pattern": "1 返回值暴露内部状态", "result": "不适用", "note": "错误处理维度不判定列表别名；按其维度隔离交 data-consistency（见 off_dimension_notes #5）" },
        { "pattern": "2 同族函数守卫一致性", "result": "命中", "note": "parseInt 三族：村民/节点有 try，生成点 :1944 与刷怪点 :2022 无；deploy 判空 5 处 vs 未判空 ≥10 处。即 F2/F3" },
        { "pattern": "3 数值边界", "result": "未命中", "note": "本文件唯一玩家数值入口是 goto 的 :1638-1644，已包 try 且做 1..TOTAL_STEPS 范围校验" },
        { "pattern": "4a 原型链/裸下标", "result": "不适用", "note": "Java，无原型链" },
        { "pattern": "4b 假值 vs 缺值", "result": "未命中", "note": "isEmpty() 用于集合、== null 用于坐标，没把 0/空串当缺失" },
        { "pattern": "4c NaN/Infinity/小数", "result": "不适用", "note": "本文件不做数值解析，fmt 只格式化坐标" },
        { "pattern": "4d 嵌套结构校验", "result": "未命中", "note": "无嵌套结构解析路径" },
        { "pattern": "5 能力是否真实现", "result": "未命中", "note": "写盘失败播报链真消费返回值：:1690 reportSaveFailureIfAny、:1693-1699 分支，不是只在注释里声称" },
        { "pattern": "6 转义/编码顺序", "result": "不适用", "note": "无转义/编码路径，颜色码由 LanguageManager 处理" },
        { "pattern": "7 边界符号（负数/下标）", "result": "未命中", "note": "页码有 page > 0 与 page < maxPage 双向守卫（:466、:481、:1899、:1907）" },
        { "pattern": "8 引用绑定是否存在", "result": "未命中", "note": "本类 import 与调用名一致，未发现未导入标识符" }
      ]
    },
    "self_checks": {
      "identifier_reconcile": {
        "status": "DONE",
        "note": "对账 deploy()/gameManager() 空值契约与调用点：显式判空 5 处（:731、:1021、:1141、:1246、:1723），未判空解引用 ≥10 处（:452、:497-498、:538、:542、:555、:626、:875、:921、:948、:1344、:1948、:2024），与 sweep「五处防了 null」一致；另对账 parseInt 三族，生成点 :1944 与刷怪点 :2022 缺 catch，村民 :1859 与节点 :2112 有，差集即 F3。"
      },
      "self_check_audit": {
        "status": "NOT_APPLICABLE",
        "note": "glob src/test/**/*.java 返回空，仓库只有 target/classes 下的 .class，无针对 SetupWizard 的测试或自检脚本可注入；改用同文件同族守卫（deploy 判空 4 处、parseInt try 2 处）作对照，确认 F2/F3 是差异而非通例。"
      },
      "runtime_validation": {
        "status": "SKIPPED",
        "note": "触发「世界未加载 → deploy 返回 null」需要可卸载竞技场世界的 Bukkit/Paper 服务端；taskbook 禁止构建（会写 target/），本机也无运行中的测试服，故只做静态控制流验证。"
      }
    },
    "off_dimension_notes": [
      "L2（logic）SetupWizard.java:1845-1854：setup-villagers-done 的 GUI 分支直接 s.advance()，聊天路径 :1544 有 if (s.step != 5) 守卫；本回合只确认差异存在，未评估可达性，交 logic 维度。",
      "L5（data-consistency）SetupWizard.java:133 只调 loadSpawnPoints()、:143 只调 loadNodesFromConfig()，villagers / shop 未重载；未验证整份写回覆盖外部改动的路径，交 data-consistency 维度。",
      "文件行数不符：派发书写 1952 行，实际 read 到 EOF 为 2286 行；:921 / :1175 / :1944 三处锚点与描述一致未漂移，但按 1952 行推算的其它切片需要复核。",
      "showStepDone 对 validateCompletion 的 null（:1175）放行、对 deploy 的 null（:1021）跳过补生成，两种口径同根因，已并入 F1 的 basis，不单独立条。",
      "getSpawnPoints() 等是否返回内部 list 引用（模式 1）属 data-consistency，本回合未展开、未在 findings 立项。"
    ]
  },
  "error": null
}
```
