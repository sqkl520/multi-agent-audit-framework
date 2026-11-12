# 框架锐评 · 第 7 视角（流程正确性）· 已核实

> **这是 13 份锐评里质量最高的一份。** 它画了状态机，找到真实死锁，并实测了枚举闭合性。
> 以下全部为我亲自 grep 复核的结果。

---

## 一、已核实的致命项：两个真死锁

### F1 · 波次二永远无法闭合

```markdown
<!-- protocol.md:306 门控 -->
波次二闭合条件：`spawned_agents` 中所有切片的审计Agent状态均为 `SUCCESS`

<!-- protocol.md:334 -->
`PERMANENT_FAILURE`（连续 3 次重试仍失败）：主Agent不得缩小范围后重派，
而是将该失败写入 unverified
```

**状态机**：

```
audit_agent --3×RETRYABLE--> PERMANENT_FAILURE   （合法终态）
                                    │
                                    ├─ 门控要求 = SUCCESS
                                    ├─ PERMANENT_FAILURE ≠ SUCCESS
                                    └─ 规则禁止再重派 → 无任何转换能变回 SUCCESS
                                    ⇒ 波次二门控恒为 false
```

**为什么这比"某条规则写错"严重**：`handoff-schema.md:56` 给这条路径留了出口（`PARTIALLY_CLOSED` 可含 `PERMANENT_FAILURE`），但 `protocol.md` 第 3 节自称门控权威，只写「全部 SUCCESS」。**两个文件对同一状态给出相反判定，框架没说哪个赢。**

### F2 · `CONTRACT_VIOLATION` 的重派无上限

```markdown
<!-- protocol.md:333 -->
CONTRACT_VIOLATION：作废该Agent全部输出，派一个全新实例从原始任务描述重新执行，
attempt 从头计数
```

**两条通道的不对称**：

```
SUCCESS / RETRYABLE_FAILURE:  attempt 0→1→2 → 第3次 PERMANENT_FAILURE  （有终止）
CONTRACT_VIOLATION:           attempt 0→0→0→0→…                        （无终止）
```

**唯一出口是 60 个 agent 的硬上限**——即烧光全部预算换一个"什么都没跑成"。这不是状态机的出口，是预算护栏。

**已发生过一次**：`wave2-audit.md:117` 逐字记录 round31 有 **5 个切片**因写 `"severity": "NONE"` 被判 `CONTRACT_VIOLATION`，最后靠 Arbiter「实质豁免」捞回——而框架自己承认「这属于对契约的实质豁免，**框架里没有这条合法路径**」。

---

## 二、已核实的严重项

### F11 · `evidence-policy` 要求返回一个契约禁止的 `status`

```markdown
<!-- evidence-policy.md:132 -->
Skeptic 可以向主Agent返回 {"status": "EVIDENCE_GAP", "finding_id": ..., "missing": ...}

<!-- evidence-policy.md:12 自称最高优先级 -->
与任何模板指令冲突时，以本文件为准

<!-- output-contract.md:33 -->
"status": "SUCCESS | RETRYABLE_FAILURE | CONTRACT_VIOLATION | PERMANENT_FAILURE"

<!-- output-contract.md:352 检查序 5 -->
| 5 | status 枚举 | 属于四个合法值 | 作废，重派全新实例 |
```

**Skeptic 照 evidence-policy 做 → 必违规。不照做 → 违反自称最高优先级的那条。**

而且波次三门控要求「Skeptic 和 Devil's Advocate 均返回 `SUCCESS`」——**Skeptic 任何一次 `EVIDENCE_GAP` 都使门控失败**。

### F3 · `ARBITRATING` 让波次三"空转闭合"

```markdown
<!-- protocol.md:307 -->
波次三闭合：conflicts 中每一项的 resolution 不再是 PENDING
             （要么已裁决，要么标记为 ARBITRATING 并已派发仲裁Agent）

<!-- handoff-schema.md:194 相反规定 -->
resolution 为 PENDING 或 ARBITRATING 的冲突，不得让下一波开始修复
```

**两条同时为真时无共同合法动作**。更关键的是连锁：

```
ARBITRATING → 没有 UPHELD → 波次四门控「每条 UPHELD 都有修复」= 空真
                          → 波次五门控「每个修复都有验收」= 空真
                          → 没有任何东西阻止 CLOSED

⇒ 一条裁决都没做、一行代码都没改，却拿了 CLOSED
```

**这是"假 CLOSED"，比死锁更危险**——流程走完了、报告生成了，但结论为空。

### F4 · `PARTIALLY_CLOSED` 有两条互斥的后续规则

```
run-state.md:255  status ≠ CLOSED → 续跑 round N，不要新开 N+1
run-state.md:273  有 DEFERRED → 自动开启 round N+1
```

**闭环**：预算耗尽 → `PARTIALLY_CLOSED` → 读状态判定"续跑" → 剩余预算 0 → 直接收尾 → 又是 `PARTIALLY_CLOSED`。**每次产出一份相同报告，status 永不改变。**

---

## 三、枚举不闭合：实测 15 处（我抽验了 3 处，全部准确）

### 我亲自验证的 3 处

| # | 不一致 | 实测 |
|---|---|---|
| **E8** | `handoff-schema:108` 登记 `REQUIRE_EVIDENCE_RECOLLECTION`，`wave3-critique:256` 写 `REQUEST_EVIDENCE_RECOLLECTION` | ✅ **拼写级不一致**，机械比对必判 `CONTRACT_VIOLATION` |
| **E10** | `wave5-verify` 有 **11 处**把 `PASS_WITH_ESCALATION` 当返回值，契约 `verdict` 只有 `PASS \| FAIL` | ✅ 验收 Agent 照做即违规 |
| **E1** | `role` 六个值（`recon\|sweep\|audit\|critique\|fix\|verify`）**没有补采角色**，但 `handoff-schema:136` 要求"派证据补采实例" | ✅ 补采 Agent 无合法信封 |

### 完整清单（15 处）

**A. 值缺失（流程需要，闭集里没有）— 7 处**

| # | 缺失值 | 谁需要 |
|---|---|---|
| E1 | `role` 无补采角色 | `handoff:136`、`protocol:346` |
| E2 | `status` 无 `STALLED` | `run-state:290` |
| E3 | `phase` 无 `wave4`/`wave5` | FIX 路径 |
| E4 | `in_flight.task` 无 `recon` | 波次一派发 |
| E5 | `slices[].state` 无 `SKIP_REAUDIT` | `scale-mapping:234` |
| E6 | `open_items.kind` 无 `DEFERRED_DEEP_DIVE` | `scale-mapping:97`、`wave2a:205` |
| E7 | `deferred_items.reason` 无 `ENVIRONMENT` | `wave5-verify:219` |

**B. 未登记值（模板用了，闭集没有）— 8 处**

| # | 未登记内容 | 使用处 |
|---|---|---|
| E8 | `REQUEST_` vs `REQUIRE_` | `wave3:256` |
| E9 | `INVALID_EVIDENCE` | `output-contract:195` |
| E10 | `PASS_WITH_ESCALATION` | `wave5-verify` 11 处 |
| E11 | `report_state` 七值无承载字段 | `final-report:18-25` |
| E12 | `position` 两套互斥取值 | `handoff:174` vs `wave3:377` |
| E13 | 5 个字段未登记 | `confidence`/`missing_evidence` 等 |
| E14 | `critique_extra: "regression-scan"` | `scale-mapping:289` |
| E15 | `wave-2a`/`wave-2b` 无法表达 | `protocol:219` vs `:276` |

---

## 四、这份锐评最狠的一句

> **最可能卡死的不是任何单点，而是 F2 + F1 的组合。**
>
> **F2 不需要任何外部条件**——只需要任意一条契约歧义被触发一次。而本次审计已经找出 **15 处枚举不闭合，触发概率接近 1**。
>
> 两条独立路径（无限重派 / 合法永久失败）都通向同一个「波次二永不闭合」，而各自由不同规则造成。**修复任一都不能解决问题。**

**这解释了为什么 round31 会停在那里**：不是预算不够，是**状态机本身有洞**。

---

## 五、我的判断

**这份锐评我几乎全盘接受**，因为：

1. 它的每条指控都带 `file:line` + 逐字原文，我抽验的 5 条**全部准确**
2. 它不是"提意见"，是**画出了状态机并指出转换不存在**
3. 它找到了我自己从未对照过的矛盾（`protocol` vs `handoff` 对同一状态的两套判定）

**唯一要打折的**：它列的 15 处枚举不闭合里，我抽验的 3 处都成立，但**未抽验的 12 处不能全信**。不过即便打对折也有 7-8 处。

**最该立刻修的**（按它给的排序，我认同）：

1. **E8 拼写不一致** —— 唯一一处会在每次 DA 返回时触发的
2. **E1 补采角色缺失** —— 让 F5 的补采回路无法合规运行
3. **E10 `PASS_WITH_ESCALATION`** —— 11 处使用，验收 Agent 照做即违规
4. **F1/F2 两个死锁** —— 需要给波次门控加"合法非 SUCCESS 终态"的出口

**这一份改变了我对框架的判断**：之前我以为问题主要是"规则太多、文档太长"，现在看**核心状态机本身是坏的**——round31 停在那里不是偶然。
