# 实战验证结论（field-test-1）

**时间**：2026-11-15 21:57 – 2026-11-16 07:30（约 90 分钟，运行中）
**素材**：Hilltop Village `shop` 模块 7 条真实未修缺陷（R3-C F1–F7）
**要回答的问题**：R1–R21 加的所有闸门，在真实任务上会不会误拦？

---

## 一句话结论

**没有误拦。而且框架第一次在真实任务上完整跑通了多 agent 修复。**

对比基准是那次真实事故：

| | 真实事故（2026-11-15） | 这次实战 |
|---|---|---|
| 修复实例 | **1 个**（0 次 subagent） | **9 个**（10 次真实 subagent 调用）|
| 发现的处置 | 6/38，全部无信封 | **7/7，全部合契约** |
| 红测证据 | 3 份日志，后被 `mvn clean` 删光 | 30+ 份，仍在 |
| 代码产出 | 13 文件 / +531 −46 | **20 文件 / +804 −78** |
| 新增测试 | 7 个 | **15 个** |
| 全量测试 | 877 / 0 | **902 / 0 / 0** |

---

## 一、闸门逐条判定：全部 0 误拦

| 闸门 | 实战表现 | 判定 |
|---|---|---|
| R5 实例唯一性 | `spawned_fix_agents: 7` = 7 条发现 | ✅ 正确执行 |
| R1 stop-hook wave4 | 相位跑到 `wave5`，无拒绝 | ✅ 未误拦 |
| R14 `report.dir_path` | 字段存在且有效 | ✅ |
| R16a `target_repo` | 绝对路径，真实存在 | ✅ |
| R20 `fix_baseline` | `dirty_paths` 抓到 **25 项**（正好是修复前的脏文件数）| ✅ |
| R17 `check-payload` 接 stop-hook | 7 份产物全部 0 违规 | ✅ |
| R18 `files_touched` 存在性 | 每条 2–3 个文件，全部真实存在 | ✅ |
| R21 harness 对账 | 声称 7 / 真实 10 次调用 / 10 个子 session → **exit 0** | ✅ |

**最后一条是最关键的验证。** `check-fix-instances-harness.mjs` 的判定：

```
claimedAgents: 7
realSubagentCalls: 10
childSessions: 10

合计: 0 FAIL / 0 WARN / 2 INFO → exit 0
```

它给出的 INFO 分寸拿捏得对：

> 「harness 日志显示 10 次真实派发，账本 `spawned_fix_agents = 7`——**多派发不是违规**
> （重试、补派都合法），但账本少记会让后续的失败率与覆盖率算错，建议回填为实际计数。」

---

## 二、多 agent 编排：三个串行组真的并行了

任务书写的是「F1–F4 同在 `ShopConfigLoader.java` → 串行组；F5 独立；F6/F7 同在
`CommandsDocumentGenerator.java` → 串行组」。

**它完全照做了**：

| 子 session | 负责 | 目标文件 |
|---|---|---|
| `2361960f` | F1–F4 | `ShopConfigLoader.java` |
| `09140833` | F5 | `ShopListener.java` |
| `1a7e6733` | F6/F7 | `CommandsDocumentGenerator.java` |

而 `fix_contracts[].fix_agent_id` 里存的是**真实的 dsh session id**
（`2361960f-9b85-...`），不是那次事故里的 `fake-agent-1`。

**这意味着 R21 的归属对账是真能验的**，不是两个自述互相对账。

---

## 三、修得对不对：抽查三条

### F1（解析失败应报错，不该降级成空商店）

```java
/**
 * ...但文件本身无法解析（损坏/截断），或 shop.items 存在但不是映射（截断常见形态）时抛异常，
 * 不得降级成空商店。
 */
public ShopConfig load() {
```

而且用了项目已有的 `YamlFiles` 工具——符合「照抄既有先例」的纪律，没有自创方案。

### F2（缺 icon 不该发 BARRIER）

```java
plugin.getLogger().warning("shop.yml: item '" + id + "' has invalid icon material '"
        + iconMatStr + "' (unknown or not a carryable item), skipped");
```

商品被跳过并告警，而不是发屏障方块。

### 红测日志：过程可信

`redlogs/` 下的命名记录了真实的调试路径：

```
F1-red-attempt1-compile.log    ← 第一次"红"是编译失败（不算红测）
F1-pass2-red.log               ← 第二次红是真实断言失败
F1-pass2-green.log             ← 转绿
```

**它经历了「编译失败 → 修正 → 真正的红 → 绿」**，不是直接宣称成功。

---

## 四、暴露的四个真实问题

### 问题 1：构建需要 `-Djdk.attach.allowAttachSelf=true`

第一次全量构建，11 个测试 ERROR：

```
Could not initialize plugin: interface org.mockito.plugins.MockMaker
```

Mockito inline mock maker 需要 self-attach 权限。

dsh 自己摸索出加 `JAVA_TOOL_OPTIONS: -Djdk.attach.allowAttachSelf=true` 重跑 → 902/0/0。

**但框架文档里没写这条。** `wave4-fix.md` / `run-state.md` 都要求「相位闭合前跑全量」，
却没说「某些项目的测试需要特定 JVM 参数」。真实项目会因此卡住。

**建议**：在 `wave4-fix.md` 的构建章节加一句提示。

### 问题 2：`check-fix-instances-harness.mjs` 推断不出 project 目录

`state.json` 在 `<TARGET_REPO>/.work/round1/`，不在约定位置，脚本报 `project_dir_ambiguous`
（exit 2），必须手动传 `--project-dir`。

**这是真实缺口**：`stop-hook.mjs` 里的推断逻辑能向上找三级，但这个独立脚本不能。
两者行为不一致。

**建议**：把 `stop-hook.mjs` 的 `dshEncode` + 向上找逻辑抽成共享模块。

### 问题 3：产物写进了被审仓库的 `.work/`

任务书指定 `<OUTDIR>` = 框架仓库的 `experiments/field-test-1/`，
它却写到了 `<TARGET_REPO>/.work/round1/`。

`protocol.md §0` 说「不得往被审仓库写任何文件」。`.work/` 算不算？

**这是规则的模糊点**：
- 若不算 → `protocol.md §0.2` 该写明例外
- 若算 → 这次是违例

**我的判断**：`.work/` 是「工作目录」不是「仓库内容」（通常 gitignore），
从零写入原则的**目的**（不污染被审代码）看不算违例。
但文档该说清，否则下一个人会困惑。

### 问题 4：耗时约 90 分钟

336 次工具调用、9 个 subagent、3 次 compaction。

对比那次事故：196 step / 303 调用 / 1 实例 / 57 分钟。

**代价约 1.6 倍，产出翻倍，且全部合规。** 这个交换我认为值得——
但「多 agent 一定更慢」是确定的，不能假装它免费。

---

## 五、`check-state` 抓到一处真实疏漏

```
[plan_phase_mismatch] current_plan.phase=wave4 与 state.phase=wave5 不一致
```

它推进到验收相位，但没同步更新 `current_plan.phase`。

**闸门正常工作**——抓到的是一个真实的小疏漏，不是误拦。

---

## 六、这次实战证明了什么、没证明什么

### 证明了

1. **规则能被正确执行**：7 条发现 → 3 个串行组 → 7 个实例，文件级依赖分析做对了
2. **闸门不会误拦正常流程**：8 道判据全部 0 FAIL
3. **外部基准可用**：harness 记录的真实调用数（10）能对账账本声称（7），且分寸正确
4. **红测纪律可落地**：30+ 份日志，含「编译失败不算红」这种细节

### 没证明

1. **修得对不对**：我只抽查了 F1/F2 的代码，7 条没有逐条评审
2. **闸门能抓违规**：这次全部合规，所以没触发任何 FAIL——
   「不误拦」证明了，「能拦住」仍然只有合成用例支撑
3. **长期稳定性**：单次运行，重复性未知

---

## 七、证据位置

```
experiments/field-test-1/evidence-snapshot/   完整快照（state.json / 7 份产物 / 红测日志 / 构建日志）
/tmp/hilltop-pre-fieldtest-src                修复前源码（还原用）
/tmp/prefixed-status.txt                      修复前 git status
```

目标仓库当前改动：**20 文件 / +804 −78 / 15 个新测试文件**。
