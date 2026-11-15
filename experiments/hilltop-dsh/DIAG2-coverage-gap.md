# DIAG2 · 覆盖率审计：缺陷修了几条，信息在哪一步丢的

**日期**：2026-11-15
**性质**：只读分析。本文所有数字由我自己从产物/源码机械数出，未引用任何既有结论（含同目录第一版 `DIAG-coverage-gap.md`；两份独立得出相同总数，见 §0 的交叉印证）。

**先给结论**

| 问题 | 答案 |
|---|---|
| 审计产出多少条 finding | **38 条**（HIGH 8 / MEDIUM 22 / LOW 8） |
| 真正被代码改动闭合的原始 finding | **6 条**（其中 2 条是主线程越界修的） |
| 走了「裁决不修」的 | **1 条**（A-04 的子主张 a） |
| **从未进入任何任务书、也从未被任何文件表态** | **31 条** |
| HIGH 漏掉几条 | **2 条**：`R2-mechanics F3`、`R3-A A-01`。两条我回 HEAD 源码逐字确认**仍然存在** |
| 丢失点在哪 | **「汇总 → 任务书」**（不是「审计 → 汇总」） |
| 框架有没有工具能拦 | **有一个结构完全对应的机制，但挂在了 critique 角色上**；fix 角色零等价检查；两个本该命中的静态检查器在 Java 目标上 **0 文件扫描** |
| 这次跑过校验器吗 | **产物跑过 `check-payload`（仅审计环，7/7）；`check-state` / `check-deliverables` / `gate` / `check-all` / `check-blindspots` / `check-promises` 从未跑过** |

---

## 0. 机械解析：38 条是怎么数出来的

7 份产物全部以 ` ```json ` 信封结尾。解析脚本（Node，`out/` 目录逐文件正则取最后一个 json 块 → `JSON.parse` → 取 `payload.findings`）：

| 产物 | findings | HIGH | MEDIUM | LOW |
|---|---:|---:|---:|---:|
| `round1-core-audit.md` | 3 | 0 | 3 | 0 |
| `round2-ai-audit.md` | 5 | 2 | 2 | 1 |
| `round2-arena-audit.md` | 4 | 0 | 3 | 1 |
| `round2-mechanics-audit.md` | 5 | 3 | 2 | 0 |
| `round3-A-audit.md` | 7 | 2 | 5 | 0 |
| `round3-B-audit.md` | 7 | 1 | 4 | 2 |
| `round3-C-audit.md` | 7 | 0 | 3 | 4 |
| **合计** | **38** | **8** | **22** | **8** |

38 条 `status` 全部是 `CONFIRMED`，无 `NO_EVIDENCE_FOUND`。7 份信封 `contract_valid` 全为 `true`。

### 0.1 一个必须先修的前提：`finding_id` 在跨产物维度上**不唯一**

机械统计：38 条 finding 只有 **26 个不同的裸 `finding_id`**。

```
F1 ×4  (round1-core, round2-arena, round2-mechanics, round3-C)
F2 ×4  F3 ×4  F4 ×3  F5 ×2
```

即：**如果下游只拿 `finding_id` 去挂接修复，`F1` 会同时命中 4 条互不相干的缺陷。**
框架的 `ROLE_REQUIRED.critique` 用 `target_finding_ids` 做覆盖比对（`tools/check-payload.mjs:283` 附近的 `ROLE_REQUIRED` 表、`:657-668`），这条链路一旦开跑就会退化。

我实测了校验器对重复 id 的态度（把 `round3-C` 的 7 条全部改成同一个 `finding_id`，其余不动）：

```
$ node tools/check-payload.mjs /tmp/cov/dup-artifact.md --role audit --no-exists
  ✅ 契约合规        EXIT=0
```

**`check-payload.mjs` 全文没有一处 `finding_id` 唯一性检查**（`grep -c "duplicate\|unique" = 0`）。
所以「38 条都是 CONFIRMED、7/7 契约合规」这个状态，与「id 大面积撞车」是可以并存的。这是所有后续对账失败的**底层原因之一**。

### 0.2 证据真实性抽查：quote 全部真实

我把 38 条的 `evidence.quote` 逐条拿到目标仓 **HEAD**（修复前的提交）里做归一化子串匹配：

```
quote-in-HEAD: ok=38  mismatch=0  nofile=0  total=38
```

**零编造。** 这说明问题不在审计质量，在审计之后的处置链路。（顺带说明：若拿当前工作树去比对会有 5 条 MISMATCH —— 那是修复造成的行漂移，不是误报。）

---

## 1. 完整对照表：38 条 → 最终去向

「去向」列的四档定义：
- **已修**：生产代码被改，且有红转绿测试
- **裁决不修**：有书面理由，是决策
- **部分处置**：finding 内多个子主张，只有一部分被处理
- **未触动**：从未出现在任何任务书/裁决文书中
- **被推翻**：子主张经实测证伪

| # | 来源 | finding_id | 级 | 位置 | 一句话 | 去向 | 任务书 | HEAD 仍在? |
|---:|---|---|---|---|---|---|---|---|
| 1 | round1-core | F1 | MED | `core/PlayerGoodsManager.java:422` | `saveToString()` 实际在异步线程跑，与类注释「序列化留主线程」相反 | **未触动** | — | 是（生效中，`runTaskAsynchronously` @478 → `writeYaml` @405） |
| 2 | round1-core | F2 | MED | `core/GameManager.java:305` | `victory-waves` 为 0/负数时首波即判胜 | **已修** | #7 | 否（已钳 [1,100]） |
| 3 | round1-core | F3 | MED | `core/PlayerGoodsManager.java:410` | tmp 文件名唯一性只靠裸 `System.nanoTime()` | **未触动** | — | 是 |
| 4 | round2-ai | R2-AI-001 | **HIGH** | `ai/ExplodeBeetleGoal.java:241` | 同一配置值既是节点伤害倍率又当爆炸 power | **已修** | #6（+#7 钳制） | 否 |
| 5 | round2-ai | R2-AI-002 | **HIGH** | `ai/AirdropSpawnGoal.java:237` | `airdrop-mob-type` 为 `"null"` → NPE 逃出 IAE catch → 每 tick 重试 | **已修** | #5（主线程越界修） | 否 |
| 6 | round2-ai | R2-AI-003 | MED | `ai/AirdropSpawnGoal.java:107` | `shouldStayActive` 跨世界 `distanceSquared` 缺 world 守卫 | **未触动** | — | **是**（我读了 worktree `:105-109`，仍无 world 比较） |
| 7 | round2-ai | R2-AI-004 | MED | `ai/DropperAttackGoal.java:204` | 30 格追击上限只在首次锁定生效 | **未触动** | — | 是 |
| 8 | round2-ai | R2-AI-005 | LOW | `ai/HookClawHunterGoal.java:180` | 候选过滤不排除死亡玩家 | **未触动** | — | 是 |
| 9 | round2-arena | F1 | MED | `arena/ArenaManager.java:612` | 整段 `game:` 缺失时回落硬编码 2/6/20/30 | **未触动** | — | 是（我读了 `:612-619`，defaults 仍在） |
| 10 | round2-arena | F2 | LOW | `arena/MultiArenaManager.java:523` | `stopArena` 不更新 `statuses`，仍报 READY | **未触动** | — | 是 |
| 11 | round2-arena | F3 | MED | `arena/ArenaInstance.java:468` | 读到被本调用改写的 DEFEAT 状态，误判幽灵成员 | **未触动** | — | 是 |
| 12 | round2-arena | F4 | MED | `arena/ArenaManager.java:305` | 大厅世界未加载 → 回退主世界但沿用原坐标 | **未触动** | — | 是 |
| 13 | round2-mech | F1 | **HIGH** | `mechanics/TabListManager.java:298` | catch 只清句柄不 cancel，任务累积 | **已修** | #2（主线程越界修） | 否（HEAD 有 `:269`/`:298` 两处 `refreshTask = null`，worktree 只剩 `:272` 一处） |
| 14 | round2-mech | F2 | **HIGH** | `mechanics/NodeListener.java:229` | 扣 `repairCostAmount()` 份物品、只恢复 1 份；cost 无正数校验 | **已修** | #1（+#7 钳制） | 否（改为 `planRepair` 纯函数） |
| 15 | round2-mech | **F3** | **HIGH** | `mechanics/NodeSystem.java:381` | `addNode` 忽略 `saveNodesToConfig()` 的 false 仍 `return 0` | ❌ **未触动** | — | **是 —— 逐字确认见 §3.1** |
| 16 | round2-mech | F4 | MED | `mechanics/NodeSystem.java:719` | buff 周期在 `runTaskTimer` 时固定，热重载不生效 | **未触动** | — | **是**（worktree `:796` 仍在调度时取 `buffRefreshTicks`） |
| 17 | round2-mech | F5 | MED | `mechanics/ArenaScoreboard.java:480` | `titleKey()` 不进 `buildSignature` | **未触动** | — | 是 |
| 18 | round3-A | **A-01** | **HIGH** | `config/ConfigManager.java:1636` | `monsters.*.health` 载入无区间/有限性校验；负值使刷怪任务被杀、波次停摆 | ❌ **未触动** | — | **是 —— 见 §3.2** |
| 19 | round3-A | A-02 | MED | `config/menu/WaveSettingsMenu.java:226` | `total-mobs` 载入无上限；GUI 一次右键把 500 压成 100 | **未触动** | — | 是 |
| 20 | round3-A | A-03 | MED | `config/menu/WaveSettingsMenu.java:118` | 新建波次编号无范围校验，生成永不刷出的幽灵波次 | **未触动** | — | 是 |
| 21 | round3-A | A-04 | **HIGH** | `config/menu/MainConfigMenu.java:149` | 三合一：a) 未检查未保存修改 b) 子菜单缓存旧 cfg c) 不消费 `loadFromFile()` 返回值 | **部分处置**：a=裁决不修(#3)、c=已修(#8)、**b=被推翻未撤回** | #3 + #8 | 见 §4 |
| 22 | round3-A | A-05 | MED | `config/DisplayConfigLoader.java:204` | 缺 `tab.header/footer` 解析成空，与 scoreboard「缺失=出厂」相反 | **未触动** | — | 是 |
| 23 | round3-A | A-06 | MED | `config/menu/NumericInputHandler.java:80` | `requestInteger` 对小数静默截断（0.9→0） | **未触动** | — | 是 |
| 24 | round3-A | A-07 | MED | `stats/StatsManager.java:314` | 计数器载入无语义校验，负值静默消失、超大值霸榜并被写回 | **未触动** | — | 是 |
| 25 | round3-B | B-01 | **HIGH** | `admin/ArenaResetService.java:280` | 第 5 步删节点不可逆，第 8 步失败后 `reinstate` 只恢复启用状态 → 0 节点可开局 | **已修** | #4 | 否 |
| 26 | round3-B | B-02 | MED | `admin/AdminDeployManager.java:530` | 写盘失败仍把内存部署数据推给运行实例 | **未触动** | — | 是 |
| 27 | round3-B | B-03 | MED | `admin/gui/ArenaManageGUI.java:496` | 按渲染时捕获的下标删除，列表已变则删错条目 | **未触动** | — | **是**（该文件 diff 只有 1 行 `NODE_ROLLBACK_FAILED` case，与 B-03 无关） |
| 28 | round3-B | B-04 | LOW | `command/SetupWizard.java:547` | 完成按钮不校验 `s.step` | **未触动** | — | 是 |
| 29 | round3-B | B-05 | MED | `admin/ArenaResetService.java:233` | 异常兜底只释放 in-flight 并回调 internal，不 `reinstate` | **未触动** | — | **是**（HEAD 与 worktree 该 catch 块逐字相同） |
| 30 | round3-B | B-06 | LOW | `command/HilltopTabCompleter.java:75` | `config` 补全门用 `hilltopvillage.admin`，执行门用 `…config.admin` | **未触动** | — | 是 |
| 31 | round3-B | B-07 | MED | `command/SetupWizard.java:1361` | clear-shop 丢弃写盘结果先删实体 | **未触动** | — | 是 |
| 32 | round3-C | F1 | MED | `shop/ShopConfigLoader.java:46` | `shop.yml` 解析失败被当空配置，商店静默变空 | **未触动** | — | 是 |
| 33 | round3-C | F2 | MED | `shop/ShopConfigLoader.java:123` | MATERIAL 缺 `icon.material` 时以 BARRIER 发货 | **未触动** | — | 是 |
| 34 | round3-C | F3 | MED | `shop/ShopConfigLoader.java:156` | `price` 缺键/写 null → 静默按 1 计价 | **未触动** | 部分相邻改动：worktree `:156-165` 只加了「负价钳到 0 + warning」，**缺键→1 的语义没动** | 是 |
| 35 | round3-C | F4 | LOW | `shop/ShopConfigLoader.java:165` | 非正 `amount` 钳为 1 仍按原价扣款 | **未触动** | — | 是 |
| 36 | round3-C | F5 | LOW | `shop/ShopListener.java:162` | 成功消息用被 `addItem` 改写后的数量 | **未触动** | — | 是 |
| 37 | round3-C | F6 | LOW | `doc/CommandsDocumentGenerator.java:189` | 文档声称 TPS 输出不存在的 DisplayEntity 队列 | **未触动** | — | 是 |
| 38 | round3-C | F7 | LOW | `doc/CommandsDocumentGenerator.java:441` | 异步直接覆盖 `commands.md`，中断留半截 | **未触动** | — | 是 |

### 1.1 合计

| 去向 | 条数 | 占比 |
|---|---:|---:|
| 已修（代码已改 + 有红转绿测试） | **6** | 15.8% |
| 部分处置（1 条 finding，内部 a 裁决不修 / c 已修 / b 被推翻） | 1 | 2.6% |
| **未触动（从未进入任何任务书或裁决文书）** | **31** | **81.6%** |
| 合计 | 38 | 100% |

按严重性：

| 级 | 总数 | 已修 | 部分处置 | 未触动 |
|---|---:|---:|---:|---:|
| HIGH | 8 | 5 | 1（A-04） | **2** |
| MEDIUM | 22 | 1 | 0 | **21** |
| LOW | 8 | 0 | 0 | **8** |

**另一个必须点名的数字：`#8` 是 38 条之外的新增缺陷。**

精确说法（我先做了错的口径，这里纠正）：`返回值` 这三个字在 `payload.findings` 里确实出现过若干次，但**没有一条把「`loadFromFile()` 失败却宣告成功」作为缺陷本身陈述过**：

| 出现位置 | 说的是什么 | 是不是 #8 |
|---|---|---|
| `round2-mech F3` | `NodeSystem.addNode` 丢弃 `saveNodesToConfig()` 返回值 | 否，是 F3 本条的成因 |
| `round3-B B-01` | 「需核对 `clearDeploymentData` 的返回值来源」（写在 alternatives 里，是待验证项） | 否 |
| `round3-B B-02` / `B-07` | 「不检查返回值」「丢弃 `setShopNpcLocation` 返回值」 | 否，各是本条的成因 |
| `round3-A A-04` | basis 里「（无 hasUnsavedChanges 检查、**无返回值判断**）」 | **是本条 finding 的一个并列检查点，但不是陈述出来的缺陷** |

即：A-04 的 `basis` 把「无返回值判断」当成**核对过程中的一个观察**写进了括号，**没有把它写成 claim**。A-04 的 `claim` 只讲「无条件替换 activeConfig 并提示成功 + 子菜单缓存旧 cfg」。

**`#8` 作为一条独立缺陷，在 38 条的 findings 清单里不存在**——它是 `done-3.md:82-85` 的「风险与未覆盖场景」里第一次被写成完整缺陷陈述的（见 §4.3）。
所以准确分母是 **39 个已知缺陷 = 38 审计 + 1 修复期新增**，代码变更 7 次（6 原始 + 1 新增）。

---

## 2. 「任务书编号 → 原始 finding_id」映射

| 任务书 | 标题 | 原始 finding | 级 | 关系类型 | 状态 |
|---|---|---|---|---|---|
| **#2** | TabListManager 任务累积 | `round2-mechanics F1` | HIGH | 1:1 | 已修（主线程越界） |
| **#5** | AirdropSpawnGoal NPE | `round2-ai R2-AI-002` | HIGH | 1:1 | 已修（主线程越界） |
| **#7** | 载入侧数值钳制 | `round1-core F2`（victory-waves）+ `round2-ai R2-AI-001`（倍率有限性）+ `round2-mech F2`（cost 正数） | MED/HIGH | **横切切片（1 任务 ↔ 3 finding）** | 已修 |
| **#3** | 重载丢未保存修改 | `round3-A A-04` **子主张 a** | HIGH | **1:1/3（只覆盖 finding 的一部分）** | 裁决不修 |
| **#1** | 修复扣多份只恢复一份 | `round2-mechanics F2` | HIGH | 1:1（与 #7 共管同一 finding 的两个面） | 已修 |
| **#6** | 爆炸倍率语义混用 | `round2-ai R2-AI-001` | HIGH | 1:1（与 #7 共管） | 已修 |
| **#4** | 重置第 8 步留 0 节点 | `round3-B B-01` | HIGH | 1:1 | 已修 |
| **#8** | reload 消息说谎 | **⚠ 不在 38 条内** | — | 新增 | 已修 |

**结构性结论：编号是多对多映射，而任务书只有一维序号。**

- `#7` 一条横穿 3 条 finding，且只取了每条的「载入侧钳制」这一个侧面；
- `#1` 和 `#6` 各自又与 `#7` 共享一条 finding；
- 于是「#7 修完了」在语义上无法回答「哪几条 finding 闭合了」。`R2-AI-001` 是被 `#6`（语义）+ `#7`（钳制）**两条任务合起来**才算闭合的。

**`#3` 是最严重的一例**：它不是「一条 finding」，而是「一条 finding 的三分之一」（见 §4）。
任务书里从头到尾没有出现过 `finding_id`（`grep -E 'A-0[0-9]|B-0[0-9]|R2-AI-|F[0-9]|finding_id' task-repair.md task-repair-8.md` = **0 命中**）。

---

## 3. 两条被漏掉的 HIGH：我在 HEAD 上验过，是真的还在

### 3.1 `round2-mechanics F3` —— `NodeSystem.addNode` 忽略落盘失败

`round2-mechanics-audit.md` 的 claim：`addNode` 忽略 `saveNodesToConfig()` 的 `false` 返回，继续 `return 0`（成功），造成内存有节点、`nodes.yml` 没更新。

**HEAD 源码**（`git show HEAD:src/main/java/com/hilltopvillage/mechanics/NodeSystem.java`）：

```java
public int addNode(Location location) {
    ...
    nodes.put(normalized, nodeData);
    activeNodes.add(nodeData);

    saveNodesToConfig();          // ← 返回值被丢弃
    return 0; // 成功
}
```

**当前工作树（全部修复已应用）**：逐字相同，`saveNodesToConfig();` 仍被丢弃、仍 `return 0`。

**证据的强形式**：`git diff HEAD -- NodeSystem.java` 只有**一个** hunk `@@ -506,6 +506,83 @@`（+77 行，全部是 `restoreNodesForWorld`，#4 的产物）。`grep -c addNode <diff>` = **0**。

所以 `#4` 改了同一个文件、改了同一类「落盘失败」问题，**却没有顺带看这个文件里已被审计指出的另一条 HIGH**。这是漏得最刺眼的一条：不需要跨文件、不需要新任务，当时人在那个文件里。

对比同文件里 `removeNode` 的正确写法（同一份源码，就在 `addNode` 下面）：

```java
if (saveNodesToConfig()) return true;
```

**同一个类、相隔 18 行，一个检查返回值、一个不检查。** 审计当时就是这么说的。

### 3.2 `round3-A A-01` —— `monsters.*.health` 载入无区间校验（HIGH）

claim：载入侧 `mc.setHealth(getDouble(...))` 无区间/有限性校验；GUI 声明 5–500；负值进入 `WaveManager` 使 `setBaseValue`/`setHealth` 抛 `IllegalArgumentException`，波次停摆。

**HEAD 源码**（`ConfigManager.java:1636`）：

```java
if (settingsYaml.contains("monsters." + key + ".health")) mc.setHealth(settingsYaml.getDouble("monsters." + key + ".health"));
```

**当前工作树**：仍在（`:1717`），一字未改。`grep normalizeHealth|normalizeMonster` = **0 命中** —— `#7` 只加了 3 个归一化函数（`normalizeVictoryWaves` / `normalizeRepairCostAmount` / `normalizeExplodeDamageMultiplier`，`:730/735/744`），恰好跳过了同一段代码里相邻 3 行的 `health`。

**消费端确认（不是纯静态推测）**：
- `config/menu/MonsterSettingsMenu.java:85-86` GUI 区间 `5, 500`
- `core/WaveManager.java:574-575`：`spider.getAttribute(Attribute.MAX_HEALTH).setBaseValue(health); spider.setHealth(health);` —— 负值在这里抛，且不在 `spawnEntity` 的 try/catch 内

**两条 HIGH 的共同点**：都不是「难以修复」或「有争议」，都是**在被修复的同一个文件、相邻几十行内、审计已明确写出**的项。这排除了「漏是因为难」，指向「漏是因为没人要求逐条表态」。

### 3.3 顺带纠正一条第一版诊断里的过度断言

第一版 `DIAG-coverage-gap.md` §5 写「`check-blindspots` B3 直接对应 A-01 / A-02 / R2-AI-001」。**这句不成立**，我读了规则体（见 §6.4）。B3 的判据是：

```js
const hasTypeofNumber = /typeof\s+\w+\s*!==\s*['"]number['"]|typeof\s+\w+\s*===\s*['"]number['"]/.test(m.body);
const hasFiniteCheck  = /Number\.(isFinite|isInteger)/.test(m.body);
if (hasTypeofNumber && !hasFiniteCheck) { if (/[<>]=?\s*0|0\s*[<>]=?/.test(m.body)) ... }
```

它是 **JS 专属语法**（`typeof x === 'number'`、`Number.isFinite`）。Java 里写成 `double health` + `if (health <= 0)`，`extractMethods` 的 `#{0,4}` 缩进正则与 `{`/`}` 括号计数也都不适配 Java 语法。**B3 即使在扩展名上放行 `.java`，也一条都命中不了。** 真正卡住它的是「规则是按 JS 写的」，不只是「白名单只收 JS」。这一点会改变 §7 的方案优先级（M5 的性价比没有第一版估的那么高）。

---

## 4. 丢失点定位

### 4.1 结论

> **主丢失点在「汇总 → 任务书」。**
> 它不是抄写错误，而是**一个必须产出、且必须逐条表态的中间环节根本不存在**。
> `SUMMARY.md` 只管计数、`task-repair.md` 只管派活，两者之间没有任何东西要求「38 条里每一条都被处置一次」。

分三段看：

### 段 1：审计 → 汇总（`out/` → `SUMMARY.md`）—— 次要丢失，且**没有假装自己是完整清单**

`SUMMARY.md` 我逐 id 数过，提到过的 finding 只有 **5 个**：

```
A-01:1  A-04:1  B-01:1  R2-AI-001:1  R2-AI-002:1      (其余 33 个 id: 0)
```

`grep -c '^###'` in `SUMMARY.md:29-58` = **8** —— 正好是 8 条 HIGH。其中只有 2 条（`R2-mech F1`、`F2`）有正文，其余 6 条只有一行标题（`A-01` 的标题甚至只写「配置加载缺陷」，无信息量）。

**但它没有欺骗**：`SUMMARY.md:25` 明写「产物：`out/round{1,2,3}-*-audit.md`」。它是**索引**，不是清单。下游只要打开原件就能拿全 38 条。所以此段的信息损失是**可恢复**的。

### 段 2：汇总 → 任务书（`SUMMARY.md` → `task-repair.md`）—— **主丢失点**

这是真正的断点。证据链：

1. **`task-repair.md` 全文没有任何一个 finding_id。**
   `grep -E 'A-0[0-9]|B-0[0-9]|R2-AI-|F[0-9]|finding_id' task-repair.md task-repair-8.md` → **0 命中**。
   它通篇用代码定位（「`ConfigManager.java` 里三处缺钳制」）而非 finding 标识。代码定位**不可反查**：一条 finding 可能跨多个文件，一个文件可能含多条 finding（`ConfigManager.java` 就同时含 `A-01`、`A-02` 与 `#7` 的三处钳制）。

2. **没有任何文件记录「为什么是这 5 条、剩下 33 条怎么办」。**
   - `repair/REPAIR-LOG.md:76-84` 有一张「待修（按规划 agent 的风险排序）」表，列了 #7 #3 #1 #6 #4 —— **没有 finding_id 列，也没有「不修」列**。它是**进度表**，不是**去向表**。
   - 我在整个 `experiments/hilltop-dsh/` 下 grep `暂缓|下轮|DEFER|defer`：`repair/` 与 `SUMMARY.md` 里对 31 条未触动项 **0 命中**。
   - `SUMMARY.md:105-112` 的「局限」讲的是**方法论**局限（没做运行时验证、没做对照实验、严重性无外部校准），**不是缺陷覆盖局限**。

3. **编号是凭空起的、且跨轮追加。**
   `repair/MAIN-THREAD-VIOLATION.md:33` 写「剩余 5 条（#7 #3 #1 #6 #4）」，但 #1..#7 这七个编号**在任何产物里都没有定义表**。#2/#5 是前序修的，说明编号在多轮之间连续追加，却始终没有一份 canonical 的 `1..N → finding_id` 对照。任何人拿到 `#7` 都无法反查它关了哪几条。

**判定：这是「选择题没有写答案」。** 挑选本身可能合理（先 HIGH、先有回归网的），但**没有任何地方写下来过**，所以事后无法区分「有意暂缓」与「单纯忘了」。§3 的两条 HIGH 就是「忘了」的直接证据——它们和已修项同文件、同类型、同严重性。

### 段 3：任务书 → 修复产物 —— 制度性丢失（闭合链断开）

- **6 份 `done-*.md` 全部没有 JSON 信封。**
  `grep -c '"schema_version"' repair/done-*.md` = **0**。所以 `check-payload.mjs` 从未校验过它们（对比：7 份审计产物全部有信封、全部跑过、全部 ✅）。修复产物在契约体系里是**不可见的**。
- **契约对 fix 角色的必填字段只有 `files_touched`。**
  `tools/check-payload.mjs:283`：
  ```js
  fix: ['files_touched'],
  ```
  `finding_id` 与 `affected_issues` 虽在 `framework/components/output-contract/fix.md:142/149` 定义、并在 `:155` 写明「必须显式列出可能影响到的其他已发现缺陷」，但**校验器一个字都不查**（`check-payload.mjs` 全文 `grep -c affected_issues` = 0）。
- 于是「这个修复关掉了哪条 finding」完全靠自然语言自述。

### 4.2 一句话定位

> **丢失发生在「38 → 7」这一步。`SUMMARY.md` 只管计数（且诚实地说自己只是索引），`task-repair.md` 只管派活（且不带 finding_id）。两者之间缺的是「每一条都必须被表态一次」的强制产物。**

A-04 是唯一能被逐字对比的样本（因为它是唯一被拆开的），但它的 3→1 压缩**不是特例，而是默认处理方式**——其余 30 条压缩到了 0。

### 4.3 A-04 样本：3 个子主张，任务书覆盖 1 个

**A-04 的 claim 提到了几件事？——三件。**

| 子主张 | 内容 | 出处 |
|---|---|---|
| **A-04-a** | 重载不检查 `hasUnsavedChanges()`，未保存修改被静默丢弃 | 标题 + 正文 + basis |
| **A-04-b** | 已打开子菜单在 `buildMenu()` 闭包缓存旧 `GameConfig`，重载后写入旧对象 | 标题 + 正文 + basis |
| **A-04-c** | **不消费 `loadFromFile()` 的返回值**（返回 `void`，失败时仍宣告成功） | 正文 + basis |

**关于「无返回值判断」这几个字：在的，而且不止一处。**

```text
out/round3-A-audit.md:226  "basis": "核对 MainConfigMenu 146–156（无 hasUnsavedChanges 检查、无返回值判断）、
                            ItemSettingsMenu 40 与 82–84（闭包捕获 cfg）…"
out/round3-A-audit.md:64   正文：「…既不检查是否存在未保存修改，也不消费载入结果…」
```

**关键事实：A-04-c 在 prose 里也有（`:64`「不消费载入结果」），不是只埋在 JSON `basis` 里。** 所以「信息只在机器字段里」这个假设不成立——任何读 `round3-A-audit.md` 正文的人都看得到。

**`task-repair.md` 的 #3 覆盖了几件？——一件。**

`task-repair.md:30-39` 的 #3 全文只有两句事实：
```
`MainConfigMenu.java:149` 无条件 `loadFromFile()` 后无条件发「已重载」。
`ConfigManager:307` 有 `hasUnsavedChanges()` 但没被调用。
```

| 子主张 | 任务书覆盖？ |
|---|---|
| A-04-a | ✅「没被调用」= 未保存修改会丢 |
| A-04-c | ❌ **丢了**。任务书写的「无条件 loadFromFile() **后**无条件发已重载」讲的是**顺序**（先 load 再发），不是**返回值**（load 失败该不该发）。「无条件」修饰的是「发消息」，不是「检查结果」。`grep -c 返回值 task-repair.md` = **0** |
| A-04-b | ❌ **丢了**。任务书完全没提闭包捕获 |

我数了 `task-repair.md` 里与「返回值」相关的关键词：`返回值` = 0 次、`无返回值` = 0 次、`闭包` = 0 次。**压缩比 3:1，且没有任何一处声明「另外两条不修」。**

**A-04-c 后来怎么被捞回来的？——三步巧合，不是流程保证。**

1. `task-repair.md:37` 要求「**把你的判断和理由写进产物**」——这条要求本来是给「该不该修 a」用的，与 c 无关。
2. dsh 在写 `done-3.md` 的「风险与未覆盖场景」一节时，**自己**想到了 c：
   > `repair/done-3.md:82-85`：「相邻的真实问题（不在 #3 范围）：`loadFromFile()` 返回 `void`……应另开缺陷：让 `loadFromFile` 返回成功/失败，菜单按结果发消息。」
3. `repair/ACCEPTANCE-ROUND1.md:106-121` 读到这段 → 核实为真 → 写成 `task-repair-8.md` → dsh 修完 → `ACCEPTANCE-ROUND2.md` 验收通过（885 tests 全绿）。

**如果 dsh 没有写那一段，A-04-c 会永久消失。** 而 dsh 会写，是因为产物模板里恰好有一节叫「风险和未覆盖场景」——**这是软性模板项，不是任何校验器检查的字段**（6 份 `done-*.md` 连信封都没有，从未被 `check-payload` 校验过）。

**判定：巧合，不是流程。** 更尖锐地说：**这条唯一的成功案例，恰恰证明了流程是无效的**——它救回来靠的是「执行者主动多写了一段」+「验收者认真读了」+「任务模板里恰好有那一节」，三者缺一不可，而三者都不是强制项。

**A-04-b 呢？——被推翻，但推翻结论从未写回产物。**

`RUNTIME-VERIFICATION.md:138-149` 实测推翻：`GameRulesMenu.buildMenu():32` 每次都重新执行 `configManager.getActiveConfig()`，而 `reopen()`（`AbstractConfigMenu.java:56-57`）会调 `buildMenu()` → **子菜单不缓存 cfg**。我独立复核了 HEAD/worktree：`GameRulesMenu:32`、`ItemSettingsMenu:40`、`WaveSettingsMenu:42/212` **全部**在 `buildMenu()` 内重新 `getActiveConfig()`。**推翻成立。**

但：
- `out/round3-A-audit.md:62` 的标题至今仍写「已打开的子菜单继续写入被替换的旧 GameConfig」；
- `SUMMARY.md:53` 仍写「`MainConfigMenu.java:149` —— 契约违反」，无「部分推翻」标注；
- 推翻记录只存在于 `RUNTIME-VERIFICATION.md`，**不在任何面向下游的清单里**。`payload.findings` 里 A-04 的 `status` 仍是 `CONFIRMED`。

这是**反向的信息丢失**：一条被证伪的子主张没有从审计产物撤下，继续以完整 HIGH 的身份参与计数。

---

## 5. 校验器逐个判定（带源码行号）

前提事实：`tools/` 下 51 个 `.mjs`（30 个非测试脚本）。本次实验**没有 `state.json`**（`find experiments -name state.json` = 0）、**没有 `final-report.md`**（= 0）。实验目录里只有 `run-core.log`（仅第 1 轮，229KB），第 2/3 轮无日志文件留存。

### 5.1 `check-payload.mjs`（1094 行）

| 项 | 判定 |
|---|---|
| **能拦「发现没被修复」吗？** | **不能。** 全文 role 分支共 6 处：`sweep:351` / `recon:387` / `audit:451` / `critique:652` / `planner:943` / `verify:1001`。**没有 `role === 'fix'` 分支**（`grep -n "role === 'fix'"` = 0 命中）。fix 角色只被 `ROLE_REQUIRED` 表查「字段存在性」：`:283` `fix: ['files_touched']` —— 只要有 `files_touched` 一个字段，一份什么也没修的 fix 产物也是「契约合规」。 |
| **critique 有等价物吗？** | **有，而且很硬。** `:652-668`：<br>`const targets = p.target_finding_ids; const covered = new Set(vs.map(v=>v.finding_id)); const missing = targets.filter(t=>!covered.has(t));`<br>报错文案（`:663-665`）：<br>「以下 target_finding_ids 没有任何 verdict: …。**漏审一条等于放它直接进入修复波——锐评波的价值全在「每条都被攻击过」**」<br>**这行文案恰好描述了本次失败**：它防的是「漏审即放行」，而修复侧没有任何人防「漏修即放行」。 |
| 能否拦「重复 finding_id」？ | **不能。** 我实测：把 round3-C 的 7 条 id 全改成同一个 → `✅ 契约合规`，EXIT=0。 |
| 这次跑了吗？ | **产物跑了**。`RESULT-core.md:12` 与 `SUMMARY.md:17` 有记录，我复跑了 7 份：全部 `✅ 契约合规`。但 `repair/done-*.md` 6 份**没有信封**，从未被跑。 |

### 5.2 `check-state.mjs`（~490 行）

| 项 | 判定 |
|---|---|
| **能拦吗？** | **结构上能，实际没跑。** `:203-225` 有 `fix_contracts` 检查，强制每条修复前置登记 `finding_id / fix_agent_id / registered_at / defect_statement / disproof_condition / rollback_command / test_path`，缺任一 `err('…','fix_contract_incomplete')`；另有 `:216-219` `baseline_not_recorded`「没做也没声明 = CONTRACT_VIOLATION」。<br>**这是全框架唯一一个把 `finding_id` 和「修复」绑在一起的检查。** |
| 为什么这次没拦？ | **整个实验没有 `state.json`。** 它读的 `state.fix_contracts` 是 `Array.isArray(...)` 才进（`:203`），没有 state 就一片 SKIP。实验是手工派发 dsh 的，完全绕过了 round 协议。 |
| 注意 | 即使有 state.json，它也**不检查「38 条是否都被 fix_contracts 覆盖」**——它只检查**已登记项**的字段完整性。`grep -c 'coverage\|覆盖' check-state.mjs` 只有 `:250` 一处，讲的是「计划 3–7 步覆盖相位」，与 finding 覆盖无关。 |

### 5.3 `check-deliverables.mjs`（~300 行）

| 项 | 判定 |
|---|---|
| **能拦吗？** | **不能。** `:121-129` 只校验最终报告有七个二级标题（含「3. 发现汇总」「4. 失败与未闭合」）；`:167-184` D2 只校验「覆盖率是 `N/N = xx%` 且算术自洽、≤100%」；`:189-211` D2b 只校验「证据覆盖率 Q/F」的算术。<br>**它测的是「派发覆盖率」和「证据覆盖率」，唯独没有「闭合率」。** §4「失败与未闭合」只要求**标题存在**，不校验内容是否覆盖真实未闭合项。 |
| 这次跑了吗？ | **没有。** 它要 `--round-dir`，而实验没有 round 目录结构（`gate.mjs:166-170` 的 close 分支才调它）。 |

### 5.4 `gate.mjs`（~9.6KB）

| 项 | 判定 |
|---|---|
| **能拦吗？** | **它是唯一可能把上面几个串起来的入口。** `:51-56` 定义 `close` 门 = `check-state` + `check-deliverables`，`:55` onFail「不得写 CLOSED，只能 PARTIALLY_CLOSED 或 BLOCKED」。 |
| 这次跑了吗？ | **没有。** 没有 `state.json`、没有 round-dir，`--gate close` 会两条都 add(false)。整个实验从未声明 CLOSED/PARTIALLY_CLOSED——它压根没进状态机。 |

### 5.5 `check-all.mjs`（28 项）

| 项 | 判定 |
|---|---|
| **能拦吗？** | **不能。** 它是**框架自检**入口，28 项全是 `*.test.mjs`（校验器的自测）与模拟器（`:20-166` 的 `CHECKS` 表）。28 项里**没有一项**是「审计发现 → 修复任务」的覆盖率对账。 |
| 这次跑了吗？ | **没有。** 与本次实验无关（它测的是框架自身）。 |

### 5.6 `check-blindspots.mjs` —— **实测 0 文件**

```
:34-45  function walk(dir, out=[]) {
          ...
          } else if (['.js', '.mjs', '.cjs', '.ts'].includes(extname(e.name))) { out.push(p); }
        }
```

`:40` 的扩展名白名单。我实跑：

```
$ node tools/check-blindspots.mjs "<target>/src"
  盲区模式检查: 0 个文件
  未命中 B1/B2/B3/B4 四种形态
```

目标仓 `src` 下 **161 个 `.java`**，`.js/.mjs/.ts/.cjs` **0 个**。**扫描了 0 个文件，EXIT=0。**

**追加发现（第一版未指出）**：即使把 `.java` 加进白名单也无效。B3 的判据（`:118-127`）是 `typeof x === 'number'` + `Number.isFinite` —— **纯 JS 语法**；`extractMethods`（`:48-72`）用 `^\s{0,4}…\(...\)\s*\{` 匹配方法头 + 花括号计数，Java 的访问修饰符/泛型/注解不能适配。**A-01 的形态是 `double health` + `if (health <= 0)`，B3 认不出来。**

### 5.7 `check-promises.mjs` —— **实测 0 文件**

```
:32-43  walk(...) { ... else if (['.js','.mjs','.cjs','.ts'].includes(extname(e.name))) { out.push(p); } }

$ node tools/check-promises.mjs "<target>/src"
  承诺兑现检查: 0 个文件
  未发现「承诺未兑现」
```

同样 0 文件、EXIT=0。

P1（`:98-107`）判据：`@returns {boolean|number|string|object|Array}` + 函数体无 `return`。**它在 Java 上也不可能命中 `A-04-c`**：`ConfigManager.loadFromFile()` 在修复前是 `public void loadFromFile()`（HEAD `:1298`，**上方紧邻一个空行、没有任何 Javadoc**），不存在「Javadoc 声称返回却没有 return」的形式差异。A-04-c 的本质是「返回 void 意味着调用方无法区分成功/失败」，这是**语义缺陷**，不是 P1 能表达的语法缺陷。第一版把 P1 说成「A-04-c 的靶心」是**过度类比**。

### 5.8 汇总判定表

| 校验器 | 能否检测「发现未修复或未明确暂缓」 | 关键行号 | 本次是否运行 |
|---|---|---|---|
| `check-payload.mjs` | **不能**（fix 无分支；critique 有等价物） | 分支 `:351/387/451/652/943/1001`；`fix:['files_touched']` `:283`；`verdict_missing_for_target` `:657-668` | **跑过**（7 份审计产物，全绿）；6 份 done-* 无信封，未跑 |
| `check-state.mjs` | **能，但需 state.json** | `fix_contracts` `:203-225`；`baseline_not_recorded` `:216-219` | **未跑**（无 state.json） |
| `check-deliverables.mjs` | **不能**（只有派发/证据覆盖率，无闭合率） | `:121-129`；D2 `:167-184`；D2b `:189-211` | **未跑**（无 round-dir） |
| `gate.mjs` | **间接能**（close 门串联上面两个） | `:51-56` close 定义；`:161-176` 实现 | **未跑** |
| `check-all.mjs` | **不能**（28 项全是框架自检） | `CHECKS` `:20-166` | **未跑** |
| `check-blindspots.mjs` | **不能**（0 文件；且 B3 是 JS 专属语法） | `walk` `:34-45`，白名单 `:40`；B3 `:118-127` | **未跑；我实跑 0 文件** |
| `check-promises.mjs` | **不能**（0 文件；P1 不表达 A-04-c 的形态） | `walk` `:32-43`，白名单 `:38`；P1 `:98-107` | **未跑；我实跑 0 文件** |
| `verify-artifacts.mjs` | 不能（只查 quote 回显/文件存在，不查处置） | 用途注释 `:5-27` | 我实跑：71 FAIL（全是**路径口径**问题，非真缺陷，见 §5.9） |

### 5.9 我实跑 `verify-artifacts` 的结果（附带发现）

```
$ node tools/verify-artifacts.mjs --repo "<project>" --artifacts experiments/hilltop-dsh/out
合计: 71 FAIL / 6 WARN / 1 PASS / 3 SKIP
```

**但这 71 个 FAIL 几乎全是口径问题，不是真缺陷**：`round1/round2` 的 `files_read` 写成 `src/main/java/com/hilltopvillage/xxx.java`，`round3-A/B/C` 写成 `config/xxx.java`（相对 `com/hilltopvillage`）。**同一批产物用了两套相对路径基准**，任何单一 `--repo` 都无法同时满足。

这条本身值得记一笔：**7 份产物「7/7 契约合规」是通过的，但机械真实性校验在路径层面 71 项 FAIL。** `check-payload` 不查路径存在性（用 `--no-exists` 时更不查），所以契约绿灯与真实性红灯可以并存。这不影响本次覆盖率结论，但说明「7/7 契约合规」这个数字的证明力比它看起来弱。

---

## 6. 防丢失机制设计方案

排序原则：**改一个判定点 > 新增一个产物 > 新增一个校验器 > 扩展语言支持**。前两项能立刻覆盖 31 条，后两项是长期工程。

### M1（最高优先）· 给 fix 角色加 `disposition` 覆盖检查 —— 复制 `verdict_missing_for_target`

**改哪个文件哪一行**：`tools/check-payload.mjs`，在 `:283` 的 `ROLE_REQUIRED` 表里把 fix 改为
```js
fix: ['files_touched', 'dispositions'],
```
并在 `:1001`（`verify` 分支）之前插入新的 `if (envelope.role === 'fix') { ... }` 分支，逻辑与 `:652-668` 同构。

**判定规则**：
```
1. 每个 dispositions[] 条目必填 {finding_id, disposition}
2. disposition ∈ { FIXED, WONT_FIX, DEFERRED, NEW_FINDING, PARTIAL }
3. FIXED      → 必须同时有 test_path（且文件存在）+ red_log_ref（红测日志路径存在）
4. WONT_FIX   → 必须有 reason，去空白后 ≥ 40 字
5. DEFERRED   → 必须有 trigger 或 next_round（二选一，非空）
6. PARTIAL    → 必须有 covered_sub_claims[] 与 remaining_sub_claims[]，两者都非空
7. NEW_FINDING→ finding_id 允许不在本轮审计清单内，但必须带 origin（指向发现它的产物:行）
8. 交叉断言：dispositions[].finding_id 的集合 ⊇ 本轮派发时给的 target_finding_ids
```

**为什么不能被绕过**：
- 它挂在**准入闸** `gate.mjs --gate accept --role fix` 上（`gate.mjs:143-155`），而 accept 门的语义是「不 PASS 不得进下游」——这是框架里唯一一个「绕不过去」的位置（`gate.mjs:1-17` 开头自己论证过：参考项目把 accept 做成工具调用失败，而我们 13 个检查器都是「记得要手动跑」）。
- 第 8 条用**派发清单**做分母，而不是让 agent 自报分母。分母由主 Agent 在派发时固定，修复方无法缩小它。
- 配合 M1-b**：把《done-*.md 必须有 JSON 信封》写进 `framework/components/output-contract/fix.md` 的硬要求。**这是 M1 生效的前提**——6 份 done-* 现在没有信封，M1 加完也拦不住它们。这一条比 M1 本身更容易被忽略，必须并列写。

**成本**：改 1 个校验器 + 6 份 done-* 补信封。**不改任何审计方法。**

### M2（并列最高）· 强制产出「发现去向表」，并做双向集合对账

**改哪个文件哪一行**：
1. `framework/components/output-contract/planner.md` 的「产出」节增加硬要求：planner 必须产出 `disposition-ledger.md`。
2. 新增 `tools/check-disposition-coverage.mjs`，并注册进 `tools/gate.mjs` 的 `close` 门（`:51-56` 的 `checks` 数组）与 `tools/check-all.mjs` 的 `CHECKS`。

**判定规则**：
```
输入：out/*-audit.md（解析全部 payload.findings）+ disposition-ledger.md
断言 A：ledger 表格行数 == Σ findings 条数（逐行计数，不认"等"字）
断言 B：{ledger.finding_id} == {findings.finding_id}（双向差集均须为空）
断言 C：每行 disposition 非空且 ∈ 闭集
断言 D：FIXED 行必须有 test_path；WONT_FIX 行必须有 reason；DEFERRED 行必须有 trigger/next_round
断言 E：finding_id 必须带产物前缀（`round2-mechanics/F1`），裸 `F1` 判 FAIL
        —— 这一条直接消灭 §0.1 的 id 撞车
退出码：1 = 有 finding 没有任何 disposition，或集合不等
```

**为什么不能被绕过**：
- **断言 B 是双边的**：多写一条（杜撰）和少写一条（遗漏）都 FAIL。这是唯一能防「分母漂移」的机制——`#8` 事件已经证明分母会变（38→39）。
- **断言 E 让 finding_id 可寻址**：`F1` 撞 4 次的问题在源头解决，之后 M1 的集合运算才有意义。
- 挂 close 门意味着「不写这张表就拿不到 CLOSED 状态」，而不是「建议写一张表」。

**效果**：31 条未触动会在收口时**一次性暴露为 31 个 FAIL**，而不是安静地活在 `out/` 里。

### M3 · 任务书禁止一维编号，必须携带 finding_id，且横切条目必须列子主张

**改哪个文件哪一行**：`framework/templates/` 下对应修复任务模板（及 `experiments/hilltop-dsh/task-repair.md` 的写法规范）。

**判定规则**：
```
每条任务标题格式强制为：
  ### #N · [<产物前缀>/<finding_id>[, …]] <标题>
若映射 >1 个 finding，或某 finding 只被部分覆盖，必须紧跟一张子主张表：
  | 子主张 | 覆盖? | 理由 |
```
对本次：`#7` 应写 `[round1-core/F2 + round2-ai/R2-AI-001(仅钳制) + round2-mech/F2(仅钳制)]`；
`#3` 应写 `[round3-A/A-04(a)]`，并列出 `A-04(b)=不覆盖`、`A-04(c)=不覆盖`。

**为什么不能被绕过**：M2 的断言 B 会读任务书里的 finding_id 集合与 ledger 比对；没有 id 的任务书会产生「ledger 里有、任务书里没有」的差集。**M3 是 M2 能工作的书写前提。**

### M4 · 子主张必须可寻址（针对 A-04 这类多合一 finding）

**改哪个文件哪一行**：`framework/components/output-contract/audit.md` 的 findings schema；对应 `tools/check-payload.mjs` `:451` 的 audit 分支。

**判定规则**：
```
severity==HIGH 的 finding 必须提供 sub_claims: [{id, statement, status}]
finding 的可引用标识变为 <finding_id>/<sub_id>（如 A-04/c）
critique 的 verdicts[] 与 fix 的 dispositions[] 都必须能引用到子主张层级
status ∈ {OPEN, REFUTED, FIXED, WONT_FIX}
```

**为什么值得做**：
- 任务书漏掉 `A-04/c` 会变成「`A-04/a` 有 disposition、`A-04/c` 没有」→ M2 直接 FAIL，**不需要靠人肉读 prose 才发现**。
- `A-04/b` 被 `RUNTIME-VERIFICATION.md` 推翻时，`status: REFUTED` 会**原地更新**，而不是像现在这样：推翻记录留在旁支文档、标题继续以 HIGH 存在、分母虚高。
- 成本可控：只对 HIGH 强制（本次 8 条）。

### M5 · `check-deliverables` 增加「闭合率」（与派发覆盖率、证据覆盖率并列）

**改哪个文件哪一行**：`tools/check-deliverables.mjs`，在 D2b（`:189-211`）之后加 D2c。

**判定规则**：
```
报告必须写：闭合率 = C / T = xx%（C=disposition∈{FIXED} 的条数，T=findings 总数）
算术自洽（与 D2/D2b 同款检查，含 ≤100% 与实数复核）
T 必须等于 ledger 行数（D2c 与 M2 的断言 A 交叉）
```

**为什么必要**：框架现在有「派发覆盖率」（派了多少片）和「证据覆盖率」（查了多少 quote），**唯独没有「发现闭合率」**。前两个都可以 100% 而闭合率 0%——本次正是这样：13/13 模块覆盖、7/7 契约合规、38 条发现，闭合 6 条。

### M6 · 关于 `check-blindspots` / `check-promises` 加 Java 支持 —— **降级，不建议先做**

第一版把这条列为「最扎心的发现」。我读过规则体后认为**性价比被高估**：

- 加白名单（`:40` / `:38` 加 `'.java'`）是 2 行改动，但 `extractMethods`（`:48-72`）的缩进正则与花括号计数不适配 Java 语法，`B4`（未声明名字）依赖 `import` 解析，**等于重写**。
- 更根本的是：B3 认 `typeof x === 'number'`，P1 认 `@returns {boolean}` 而无 `return`。**这两条规则在语义上都不对应本次漏掉的缺陷**（§5.6/§5.7）。A-01 是「整数/浮点变量缺区间」，A-04-c 是「void 返回无法表达失败」——都需要**新规则**，不是**新扩展名**。
- 本次两条漏掉的 HIGH 中，`R2-mech F3`（忽略 boolean 返回值）和 A-04-c 形态相同，是**「返回值被丢弃」**模式。这倒是一条可机械检测的 Java 规则（`if (x()) / 丢弃非 void 调用结果`），但它应当在 `check-payload` 的**修复产物**侧做（M1），而不是在对**目标仓源码**的静态扫描侧做——后者扫全仓误报率极高。

**建议**：M6 单独开任务，先补齐「规则语义对应的缺陷清单」，再谈语言支持。不要在 M1/M2 之前动它。

### 优先级

| 序 | 机制 | 改哪里 | 覆盖 31 条? | 防 #8 型分母漂移? | 成本 |
|---|---|---|---|---|---|
| 1 | M1 fix 角色 disposition 检查（+ 信封强制） | `check-payload.mjs:283` + 新分支 | ✅ | ✅ | 低 |
| 2 | M2 disposition-ledger + 双向对账 | 新检查器 + `gate.mjs:51-56` | ✅ | ✅ | 中 |
| 3 | M3 任务书带 finding_id | 任务模板 | ✅（间接） | ✅ | 极低 |
| 4 | M4 子主张可寻址 | `audit.md` schema + `check-payload:451` | ✅（细粒度） | ✅ | 中 |
| 5 | M5 闭合率指标 | `check-deliverables.mjs` D2c | 指标化 | ⚠️部分 | 低 |
| 6 | M6 Java 静态规则 | `check-blindspots`/`check-promises` | ❌（不针对本次缺陷） | ❌ | 高 |

---

## 7. 一句话总结

> **38 条缺陷，代码闭合 6 条（15.8%），加修复期新增 1 条（#8）共 7 次变更；31 条从未被任何文件表态。**
> **丢失不在「抄漏」，在「从 38 条挑 7 条时，没有任何东西要求逐条表态」。**
> `SUMMARY.md` 是诚实的索引（它明说自己只是索引，原件在 `out/`）；`task-repair.md` 通篇没有 finding_id。
> 框架里唯一能拦住它的机制（`check-payload.mjs:657-668` 的 `verdict_missing_for_target`）已经写好、已经跑通，文案甚至写着「漏审一条等于放它直接进入修复波」——**只是它守着锐评门，没守修复门**（`fix: ['files_touched']`，`:283`）。
> 两个本该命中的静态检查器（`check-blindspots` / `check-promises`）在唯一的 Java 实战里**各扫描 0 个文件、各返回退出码 0**；而且即使放行 `.java`，它们的规则语义也不对应本次漏掉的缺陷。
> 唯一被救回来的 A-04-c，靠的是「执行者多写了一段风险清单」+「验收者认真读了」+「模板里恰好有那一节」三步巧合——**这条成功案例恰恰证明了流程无效。**
> 两条被漏掉的 HIGH（`R2-mech F3`、`R3-A A-01`）都在**已被修复的同一个文件、相邻几十行内**，且审计已明确写出。它们不是「难」，是「没人要求数一遍」。

**最该先做的两件事**：M1（把 critique 的覆盖检查复制给 fix，且先让 `done-*.md` 有信封）和 M2（强制去向表，双向集合对账）。两者都不改变任何审计方法，只改变「谁来证明 38 条都被数过」。
