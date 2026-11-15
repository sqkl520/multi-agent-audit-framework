# 存量 6 份无信封修复产物：怎么办

**状态：已有决定。**
**决定：选项 C —— 全部列入 `legacy_artifacts` 豁免，不补信封。**
**日期**：2026-11-15
**依据**：`tools/check-fix-artifacts-envelope.mjs`（第 1 环闸门）+ `tools/stop-hook.mjs` §3.7（本轮接上的门）+ 本文件的实测数据。

---

## 一、这批产物是什么

`experiments/hilltop-dsh/repair/done-{1,3,4,6,7,8}.md`，2026-11-15 那次修复派发的 6 份产物。
它们是**真实工作**，质量不低：

- `done-1.md` 给出了 `planRepair` 纯函数的完整实现与浮点噪声处理，并诚实交代「这是可感知的行为变更，已部署的旧配置注释不会迁移」；
- `done-3.md` 是**不修**的决定（WONT_FIX），论证了按钮文案 `Load Config File` + lore 第二行 `unsaved changes will be overwritten` 已经把破坏性编码为预期契约；
- `done-4.md` 主动交代了「旧代码没有 `NODE_ROLLBACK_FAILED` 枚举值，无法在未修复代码上编译运行」，即**哪条测试不是标准的红测**；
- `done-6.md` / `done-7.md` / `done-8.md` 各自给了失败原文、修复后结果、未覆盖场景。

**它们的问题是：一份都没有 JSON 信封。**

```
$ grep -c '"schema_version"' experiments/hilltop-dsh/repair/done-*.md
done-1.md:0  done-3.md:0  done-4.md:0  done-6.md:0  done-7.md:0  done-8.md:0
```

没有信封 = `check-payload.mjs` 除 `no_json_envelope` 外一条规则都不跑 = **这批产物从未被任何契约校验器观测过。**

---

## 二、逐份分析：能不能补信封

先摆一个决定性的事实（实测，不是推断）：

```
$ grep -rl "planRepair\|DEFAULT_EXPLOSION_POWER\|NODE_ROLLBACK_FAILED" --include=*.java .
（无输出）
```

**修复后的源码树在整个仓库里不存在。** `experiments/hilltop-dsh/repair-work/project/` 是**修复前的基线快照**——
`NodeListener.java` 里没有 `planRepair`（0 处）、`ExplodeBeetleGoal.java` 里没有 `DEFAULT_EXPLOSION_POWER`（0 处）、
`ConfigManager.java` 的 `loadFromFile` 仍是 `void`。

这一点改变了整件事的性质：**补信封不只是「补一个 JSON 块」，而是要为一份「成果物本身已不可访问」的产物做合规声明。**

| 产物 | `disposition` | 声称的文件 | 声称的测试是否在快照里 | `files_touched` 可取证吗 | 红测日志 | 建议 |
|---|---|---|---|---|---|---|
| `done-1.md` | FIXED | `NodeListener.java`（存在）、新 `RepairSettlementTest.java` | **缺失** | 路径可从正文读出；**内容无法核对**（快照是修复前） | 已丢失 | **C** |
| `done-3.md` | WONT_FIX | 无（不修） | 不适用 | 不适用 | 不要求 | **C**（唯一一份**技术上有机会补成合规**，见 §三） |
| `done-4.md` | FIXED | `ArenaResetService.java`、`NodeSystem.java`（均存在）、新 `ArenaResetNodeRollbackTest.java` | **缺失** | 同上 | 已丢失 | **C** |
| `done-6.md` | FIXED | `ExplodeBeetleGoal.java`（存在）、既有 `ExplodeBeetleGoalTest.java`（存在，但只有 7 个旧用例，无新增的 2 条） | 文件在、**新增用例不在** | 同上 | 已丢失 | **C** |
| `done-7.md` | FIXED | `ConfigManager.java`（存在）、新 `ConfigLoadClampTest.java` | **缺失** | 同上 | 已丢失 | **C** |
| `done-8.md` | FIXED | `ConfigManager.java`（存在）、`ConfigManagerTest.java` 等（存在） | 部分在 | 同上 | 已丢失 | **C** |

**补信封的成本**：每份一份 `files_touched` + `test_path` + `red_log_path` + `disposition`。字段本身能写（正文里有），
但补出来的信封会指向**三样不存在的东西**：

1. `red_log_path` 指向的日志文件——已被 `mvn clean` 删除；
2. 5 份产物声称的新测试文件（`RepairSettlementTest` / `ArenaResetNodeRollbackTest` / `ConfigLoadClampTest` 等）——快照里没有，仓库里也没有；
3. 修复后的代码本身——`planRepair` / `DEFAULT_EXPLOSION_POWER` / `NODE_ROLLBACK_FAILED` 在全仓库 0 处。

---

## 三、三个选项的实测结果（不是推测）

我按最忠实的读法为 done-6 补了**完整合法信封**（顶层 `schema_version` / `agent_id` / `status` / `contract_valid` /
`artifact_path` / `role` 全齐），只变 `red_log_path` 的写法，用被审仓库快照当 `--repo` 跑 `check-payload`：

| 选项 | 信封内容 | `check-payload` 结果 |
|---|---|---|
| **A** 填原始路径 | `red_log_path: "target/repair6-red.log"` + `test_path` 指向 `ExplodeBeetleGoalTest.java`（**存在于快照**） | **exit 1**：`red_log_in_target` + `red_log_not_found`（2 条 FAIL） |
| **B** 填空 | `red_log_path: ""` | **exit 1**：`fixed_without_red_log`（该字段是 FIXED 的条件必填） |
| **B'** 填 target 外的不存在路径 | `red_log_path: "experiments/hilltop-dsh/repair-work/red-6.log"` | **exit 1**：`red_log_not_found` |
| **B''** 填占位词 | `red_log_path: "不可复核（日志已被 mvn clean 删除）"` | **exit 1**：`red_log_not_found` + WARN `red_log_no_directory` |

> 注：`check-payload` 对**相对路径 + 未给根**会降级为 WARN `evidence_existence_unchecked`（R11 的降级纪律）。
> 这里是**给了 `--repo`** 的情形——而按 R12 §九的建议 3，主 Agent 收口时本来就该给根。
> 「靠不给 `--repo` 让检查降级」是 R11 报告已经点名的洞 A，不能作为设计前提。

**结论：A 与 B 的每一种写法都 exit 1。** 补出来的信封不是「一个勉强的信封」，是**一封注定 FAIL 的信封**。

---

## 四、决定：选 C，理由三条

### 理由 1：A/B 产出的不是「合规产物」，是「看起来合规的失败断言」

选项 A 把 `red_log_path` 填成已知不存在的原始路径，再在 `disposition_reason` 里注明「日志已被构建清理」。
这条路径能过**信封闸门**（有 `role`、有 `disposition`），但会在 `check-payload` 上 FAIL。

如果为了让 A 通过而去改 `red_log_path` 的规则（比如「允许声明日志已丢失」），那就是**改了判据去适应证据**。
R11 的整个立论是「证据一旦可被构建清理，等于没有证据」——开这个口子等于把那条规则撤回。

**一份 FAIL 的信封比一份豁免更糟**，因为 FAIL 在扫描结果里和「真发现了问题」同形：
下游读账的人无法区分「这 6 条 FAIL 是历史账，不是本轮新问题」。
而豁免是**显式的一类**，它在 stderr 上自报「在契约体系之外」。

### 理由 2：这批产物的「证据」已经不是产物里的那些字，而是它们被原样保留这件事

R12 §八改动清单里已经写下了这句话：

> `experiments/hilltop-dsh/repair/*.md`——6 份历史产物原样保留。它们是本轮的自证数据，**补上信封就等于毁灭证据**。

我今天复核了这句话，**成立且比 R12 写的时候更强**：修复后的源码树不在仓库里，快照是修复前的。
也就是说这 6 份 markdown 是**唯一**记录这次修复做过什么的载体。给它们追加一个 JSON 块，
就地把「2026-11-15 的原始交付」变成了「2026-11-15 的原始交付 + 2026-11-15 之后某人的补记」，
而后者是不可区分的——信封里没有、也不该有「本信封是事后补的」这个字段。

`artifact_without_envelope` 这条 FAIL 本身，就是这批产物**历史真实性的一部分**。
保留它，等于保留「当时确实没有信封」这个事实的机械可判形态。

### 理由 3：C 不是「放行」，C 是「把它记到另一本账上，并让这个动作可见」

有人会说 C 最省事，所以最容易被滥用。这一点我用 §3.7 的两道约束挡住了：

1. **只能逐个豁免**：`legacy_artifacts` 是文件名词表，不是 `true`；
2. **不能全量豁免**：豁免条目数 ≥ 产物目录下文件总数 → **exit 2**（`stop-hook.mjs` §3.7，case 25 锁定）；
   若产物 100% 被豁免而目录里有文档稀释了计数，转报一条 WARN「本轮没有任何修复产物经过信封检查」；
3. **每条豁免都单独 WARN**，措辞固定为「契约体系之外 / 证据不可机械复核 / 不是通过了检查，是没被检查」。

因此 C 之后，「6 份无信封产物」在账本上不是消失了，而是**从「本轮交付物」挪到了「不可复核的历史证据」**，
并且每次闭合都会重新报一遍。

---

## 五、那 done-3 怎么办（唯一一份技术上有机会的）

`done-3.md` 是 WONT_FIX，不要求 `test_path` / `red_log_path`，所以它**确实能补成一个 exit 0 的合规信封**。
我实测过：

```
$ node tools/check-payload.mjs <done-3 补信封版>.md --role fix --artifact-dir <dir>
  ✅ 契约合规
  EXIT=0
```

**但我仍然把它列入 C 并豁免。** 理由：

- 它的论证（「按钮文案已告知，不是缺陷」）与代码证据都在正文里，**补信封不会让它更可复核，只会让它看起来像是当时就合规**；
- 单独给它补、其余 5 份豁免，会在目录里制造一个**质量梯度假的**样本——读者会以为是这一份写得更好；
- 6 份是**同一次派发**的产物，同一次账。拆开记会让「那次派发整体没有信封」这个事实失去机械形态。

**决定：6 份同进 `legacy_artifacts`，同一种对待。** 若未来有人要重做这批修复，正确做法是**重跑**，
不是给旧产物补妆。

---

## 六、标准做法（给未来遇到同类问题的项目）

按优先级：

| 序 | 做法 | 适用 |
|---|---|---|
| 1 | **补信封并真的通过 `check-payload`** | 证据仍在（红测日志、测试文件、修复后代码都还在） |
| 2 | **移进 `<dir>/legacy/` 子目录** | 有意保留为历史证据，且不想让它们进分母；`check-fix-artifacts-envelope.mjs` 会报 `subdirectory_not_scanned` WARN |
| 3 | **列入 `legacy_artifacts`** | 产物必须留在原地（它们是唯一的自证数据 / 事故证据），且能接受每条一次 WARN |

**唯一不允许的做法是：既不移走、也不豁免、还想闭合。** 这正是 R12 §八·洞 B 描述的那个场景，
也是本轮 §3.7 接上门之后会 exit 2 的场景。

---

## 七、state.json 里怎么写（本项目 `hilltop-dsh` 的实际值）

```json
{
  "legacy_artifacts": [
    "done-1.md",
    "done-3.md",
    "done-4.md",
    "done-6.md",
    "done-7.md",
    "done-8.md"
  ]
}
```

- 字段**可选**，不写 = 不豁免（默认严格）；
- 只写文件名（`basename` 会被取，绝对路径也接受）；
- 列了目录里不存在的文件 → WARN（悬空豁免，不阻断）；
- 与 `report.dir_path` 配合：`dir_path` 决定「在哪个目录里找这些文件名」。

对应到这 6 份产物的实测行为（真实数据，见 `FIX-R13-report.md` §四）：

- **不加** `legacy_artifacts` → `stop-hook` **exit 2**，逐份列出 6 条；
- **加上**上面那个数组 → **exit 0**，stderr 上 7 条 WARN（6 条逐份 + 1 条整批「本轮没有任何修复产物经过信封检查」）。

---

## 八、诚实边界：这个决定没解决什么

1. **它没有让这 6 份产物变得可复核。** 它们在**框架仓库内**永久不可机械复核。
   任何引用它们的验收结论，只能由人读原文。

   > **⚠ 2026-11-15 事后更正（主线程核实）**：本文件 §二 写的「修复后的源码树在整个仓库里不存在」
   > 只在**框架仓库范围内**成立。真实被审仓库仍然存在，且修复**确实在里面**：
   >
   > ```
   > $ cd "<TARGET_REPO>"
   > $ grep -c "planRepair"                  src/main/java/com/hilltopvillage/mechanics/NodeListener.java   → 3
   > $ grep -c "DEFAULT_EXPLOSION_POWER"     src/main/java/com/hilltopvillage/ai/ExplodeBeetleGoal.java    → 2
   > ```
   >
   > 所以正确的表述是「**成果物不在框架仓库里**」，而不是「成果物不可访问」。
   > 这个差别是实质性的：这 6 份产物**并非永久不可复核**，只是复核需要跨仓库取证
   > （用 `D:/Server/...` 当 `--repo`、用那边的 `src/test` 当 `test_path` 的基准）。
   > 本次决定（选 C 豁免）依然成立——补信封仍然会 FAIL，因为**红测日志是真丢了**——
   > 但理由应当收窄为「红测日志不可恢复」，而不是「源码不可访问」。

2. **它没有补上「修复后源码树不在框架仓库」这个更大的问题。**
   修复后的树在 `<TARGET_REPO>`，
   而 `experiments/hilltop-dsh/repair-work/project/` 是**修复前的基线快照**。
   **这次修复的成果在实验记录里没有对应快照**——任何只看本仓库的人都会得出
   「修复没发生过」或「源码不可访问」的错误结论。
   建议另开一轮：把修复后的关键文件（`NodeListener.java` / `ExplodeBeetleGoal.java` /
   `ConfigManager.java` / 新增的几个测试类）快照到 `experiments/hilltop-dsh/repair-work/post-fix/`，
   并在实验记录里写明「pre-fix 在 `project/`，post-fix 在 `post-fix/`」。
3. **`legacy_artifacts` 只在 `stop-hook` §3.7 生效。** `check-all.mjs` 单独跑
   `check-fix-artifacts-envelope.mjs --dir experiments/hilltop-dsh/repair` 仍然会报 6 条 FAIL——
   因为检查器本身**故意没有 `--ignore`**（见其文件头「降级纪律：无」）。
   豁免是**账本层**的概念，不是检查器层的。这两者不一致是刻意的：检查器回答「这批能不能被观测」，
   账本回答「这一轮允许哪几份不可观测」。
