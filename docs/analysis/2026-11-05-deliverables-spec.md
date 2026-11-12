# 交付物规范定版（2026-11-05）

> **问题**：改之前，框架只规定了「波次产物叫什么名字」，**从没规定「一次运行结束后用户该拿走什么」**。
> 用户原话：「你没改之前交付物很乱，也没有标准。」

---

## 一、改之前的实际状态

### 规范只管了一半

`report-naming.md` 定义了文件名正则和目录 `docs/reports/round{N}/`，但漏了最关键的一层。实测暴露四个问题：

| 问题 | 证据 |
|---|---|
| **最终报告不匹配自己的正则** | `round1-final-report.md` 被 `report-naming.md` 的正则判为非法 |
| **链式汇总更离谱** | `round1~round2-final-report.md`（我创建的）完全无法归类 |
| **没有「必交付」概念** | 一轮跑完，用户不知道该拿哪几个文件 |
| **文件内部结构无规定** | 用户截图里 11.6KB ~ 25.0KB 的文件，长什么样全凭 agent 心情 |

### 用户截图展示的乱局

```
docs/reports/round3/
├── round3-01 命令处理器 11.6 KB
├── round3-02 GUI 菜单 25.0 KB
├── round3-03 商店溢出 16.4 KB
├── round3-04 MonsterProp 13.5 KB
├── round3-05 R-9/R-11 15.5 KB
├── round3-06 R-6 工具链 14.0 KB
├── round3-07 波次列表 18.2 KB
├── round3-final-report.md 67.6 KB (11 节)
└── round3-ledger.md 45.9 KB (10 节)
```

**这些「命令处理器」「GUI 菜单」不是任何 stage 的产物**——规范里没有位置放它们，所以只能自由命名。

---

## 二、定版规范

### 目录：一层，一轮一个文件夹

```
docs/reports/round3/
├── round3-final-report.md      ← 必交付 ①（人读）
├── round3-ledger.md            ← 必交付 ②（机读）
├── round3-01-recon-slices.md   ┐
├── round3-02-sweep-slice-01.md │
├── round3-02-audit-slice-01-logic.md │ 过程日志
├── round3-03-critique-skeptic.md     │ （供追溯，不作交付）
├── round3-04-fix-017.md        │
├── round3-05-verify-017.md     ┘
└── state.json
```

| 项 | 规定 |
|---|---|
| 轮次如何确定 | 读已有 `round*/` 取 `max(N)+1`（`round-detection.md`） |
| 目录谁创建 | 主 Agent 在波次一启动前（`report-naming.md` §5.1） |
| 层级 | **扁平，不建子目录** |

### 必交付 ①：`round{N}-final-report.md` —— 固定七节

| 节 | 内容 | 检查 |
|---|---|---|
| 0. 一句话结论 | 三行：审出什么、覆盖多少、能不能信 | 必须有 |
| 1. 元信息 | round_id / trace_id / 起止 / 状态 / 被审仓库 / 是否自动续轮 | 必须有 |
| 2. 覆盖说明 | 四个数 + **覆盖率 `N/N = xx%`** + 未覆盖清单 | 必须有，且覆盖率要有数值 |
| 3. 发现汇总 | 表，每条带 `artifact_ref` | 必须有 |
| 4. 失败与未闭合 | `error_type` + 现象 + 处置 | 必须有 |
| 5. 零写入自证 | 原样粘贴 `git status` 真实输出 | 必须有 |
| 6. 下一步 | 是否自动开下一轮 / 停止原因 | 必须有 |

### 必交付 ②：`round{N}-ledger.md` —— 固定四节

| 节 | 内容 |
|---|---|
| 1. 切片状态表 | slice_id / 状态 / 文件数 / 线索数 / attempt / 产物 |
| 2. 预算 | total_cap / spent / 剩余 |
| 3. 失败分类 | slice_id / error_type / artifact_bytes / last_write_at / inferred_cause / 重派策略 |
| 4. 裁量日志 | seq / 波次 / 类型 / 动作 / 依据 / 机械复核方法 |
| （5. 轮次链） | 仅自动续轮时 |

**账本是 `state.json` 的可读投影**，两者必须一致；不一致时以 `state.json` 为准。

---

## 三、检查器：`tools/check-deliverables.mjs`

| 规则 | 检查 | 级别 |
|---|---|---|
| **D1** | 两类必交付文件存在且非空 | FAIL |
| **D2** | 报告七节齐全；覆盖率写成 `N/N = xx%` | FAIL / WARN |
| **D3** | 账本四节必备齐全 | FAIL |
| **D4** | 目录里没有无法归入任何规范的文件 | WARN |
| **D5** | 目录是扁平的（无子目录） | WARN |

### 对真实数据跑出的结果

**修复前**（round1 只有一份自由格式报告）：

```
✗ [D1] 必交付文件缺失: round1-ledger.md
✗ [D2] 最终报告缺节: 0.一句话结论 / 1.元信息 / 2.覆盖说明 / 4.失败与未闭合 / 5.零写入自证
     实际标题: 状态 | 已确认的发现 | 未覆盖 | 下一步 | 机械校验输出
! [D2] 覆盖说明里没找到「N/N = xx%」形式的覆盖率
合计: 2 FAIL / 1 WARN / 3 PASS
```

**修复后**（三轮全部重做）：

```
round1  合计: 0 FAIL / 0 WARN / 7 PASS   覆盖率 3/8 = 37.5%
round2  合计: 0 FAIL / 0 WARN / 7 PASS   覆盖率 3/5 = 60.0%
round3  合计: 0 FAIL / 0 WARN / 7 PASS   覆盖率 1/1 = 100.0%
```

**13 个自测用例**覆盖：缺文件、缺节、空文件、覆盖率写法、自由命名、子目录、账本缺节。

---

## 四、接入协议

`protocol.md` §1.6 新增第三个强制调用点：

| 时机 | 命令 | 失败处理 |
|---|---|---|
| 每次收到子 Agent 返回后 | `verify-artifacts.mjs` | `CONTRACT_VIOLATION` |
| 生成最终报告前 | `verify-artifacts.mjs` | 报告顶部声明失败项 |
| **声明 `CLOSED` 之前** | **`check-deliverables.mjs`** | **不得写 `CLOSED`**，只能 `PARTIALLY_CLOSED` / `BLOCKED` |

`protocol.md` §1.9 给出规范和调用点。

---

## 五、防复发：`lint-autonomy.mjs` 新增 L6

**规范写了但没人跑 = 没写。** L6 检查两件事：

| 检查 | 失败意味着 |
|---|---|
| `report-naming.md` 含两类交付物文件名、`必交付` 概念、§4 定义、检查命令引用 | 规范被删或改坏 |
| `protocol.md` 引用 `check-deliverables.mjs` | 规范存在但流程不调用 |
| `protocol.md` 规定 `CLOSED` 的前置条件 | 检查失败仍能标 CLOSED |

**实测有效**：故意把 `round{N}-ledger.md` 改名后，L6 立刻报：

```
✗ [L6] artifacts/report-naming.md — 缺少交付物规范: 账本文件名
```

---

## 六、当前全量状态

```
node tools/check-all.mjs
→ 产物机械校验      31 通过
→ 自动续轮规则模拟  23 通过
→ 失败分类器        16 通过
→ 交付物规范检查    13 通过
→ 框架自主性检查    ✅ 6 条规则（L1-L6）
✅ 全部通过

framework JSON: 36/36    工具: 10 个
```

---

## 七、还没解决的

| 问题 | 现状 |
|---|---|
| **产物格式不合规** | 用户明确说「暂时 md 格式，先修其他的」——所有波次产物都是 Markdown 散文，不是契约要求的 JSON 信封，靠 G7 降级抽取才读得到 |
| **交付物规范只验证结构，不验证内容质量** | 报告七节齐全 ≠ 报告说对了。D2 能检查覆盖率有数值，不能检查那个数值算得对不对 |
| **账本与 `state.json` 的一致性没有自动校验** | 只写了「不一致时以 `state.json` 为准」，没有脚本比对两者 |
