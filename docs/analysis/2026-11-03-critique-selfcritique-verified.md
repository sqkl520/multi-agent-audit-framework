# 框架锐评 · 第 8 视角（锐评波自身）· 已核实

> **打分 4/10。** 它的每条攻击路径都可验证，我抽验了 3 条，全部准确。
> 这份锐评的特点：它不是说"锐评波写得不好"，而是**证明"防滥杀的机制一个都没落到可校验的字段上"**。

---

## 一、已核实的三条致命项

### [02] 唯一防滥杀的证据，在契约里不存在

```bash
$ grep -n "direct_contradiction" components/output-contract.md
（零命中）

$ grep -c "direct_contradiction" templates/wave3-critique.md
5
```

**`wave3` 有 5 处要求 `direct_contradiction` 是强制字段**（"五个不可自信领域，`refuted` 必须附带一行直接矛盾的代码引用"），**但 `output-contract` 的 critique schema 里根本没有这个键**。

而契约的门 7 只校验"对应分支的必填字段全部存在"——`direct_contradiction` 不是必填字段，所以**机械校验永远看不到它**。

**后果**：Skeptic 把 `direct_contradiction` 写成 `"see above"` 或直接省略，同时在 `reason` 里写一句"与调用方逻辑矛盾"。**门 7 过、门 8 过、`contract_valid: true`、`status: SUCCESS`。** 没有任何一步会失败。

### [05] `UPHELD` 对 Skeptic 是合法返回值

```json
// output-contract.md:209 —— 三角色共用一条 schema
"verdict": "UPHELD | DOWNGRADED | REVOKED | EVIDENCE_GAP"
```

```markdown
// output-contract.md:238 —— 只给 Arbiter 加了反向约束
Arbiter 的额外约束：verdict 不得为 EVIDENCE_GAP
```

**给 Arbiter 加了约束，给 Skeptic 一侧留了空白。**

于是：**一个 100% 返回 `UPHELD` 的 Skeptic —— 枚举合法、自检通过、门控满足（SUCCESS 且无 PENDING）。**

这是成本最低的整波绕过，且**事后无法与"确实全部站得住"区分**。

### [06] Arbiter 救不回任何被误杀的发现

```markdown
// wave3-critique.md:293
→ 不存在直接矛盾证据，但 Skeptic 在非敏感领域返回 refuted：
  如果不认可该反驳的证据强度，标记 RETRYABLE_FAILURE 要求补证，
  **不得直接 UPHELD**
```

**判定树里不存在 `refuted → UPHELD` 的分支。** 把所有分支的值域列出来：

| Skeptic 结论 | Arbiter 输出 |
|---|---|
| `refuted` + 有直接矛盾 | `REVOKED`（照抄） |
| `refuted` + 无直接矛盾 | `RETRYABLE_FAILURE`（卡住，**不是救回**） |
| `holds` + 清单通过 | `UPHELD`（照抄） |
| `holds` + 清单不通过 | `DOWNGRADED`（查表） |

**Arbiter 唯一能做独立判断的是把 severity 往下调**——而那是查表（`CRITICAL` 无调用链 → `HIGH`），不需要 Agent。

**所以锐评波的实际杀伐权 100% 在 Skeptic 手里。** Arbiter 只是给它的结论盖一个"已裁决"的章。

---

## 二、最优雅的一个漏洞：否定结论零证据

锐评波有三种"否定性结论"，全部只要自报：

| 环节 | 否定结论 | 需要的证据 |
|---|---|---|
| Skeptic 的**裁量稽查** | `{performed: true, log_entries_checked: 0, overall: "CLEAN"}` | **无** |
| Devil's Advocate 的**覆盖扫描** | `coverage_gaps: []` + 四个 `*_scan_performed: true` | **无** |
| Skeptic 的**缝隙扫描** | `"skeptic_gap_scan": "no_gap_found"` | **无** |

**最讽刺的是**：`wave3:149` 明文要求「零裁量时也要返回 `log_entries_checked: 0, overall: "CLEAN"`，**不得省略**——"没有裁量"和"没检查"必须可区分」。

**但真实的"零裁量"和伪造的"零裁量"输出字节完全相同。** 这条规则把最省事的作弊输出标定成了合规的诚实输出——**它自己就是最优伪装**。

而 `Devil's Advocate` 这个角色的全部使命是攻击"absence of evidence 被当作 evidence of absence"——**它自己的否定断言正是零证据的**。

---

## 三、三条让假发现通过的具体路径（我认为都成立）

### 路径 A：利用分类漏洞（零成本，每步都合规）

```
1. 假发现标 dimension="logic"、severity="HIGH"
   （不用 CRITICAL：只有 CRITICAL 才要求调用链证据、才会被降级。HIGH 是两个检查的盲区）
2. quote 用一段真实存在的代码（门 0 只验"存在且匹配行"，不验"相关"）
3. inference.claim 写得模糊到不可驳倒
4. Skeptic：dimension=logic → 不属于五个不可自信领域（无映射表）
             → holds，引一个 file:line 即可
5. Arbiter：holds + 清单通过 → 照抄 UPHELD
```

**这条路径不需要任何角色做错事。每一步都是照规则执行的。**

### 路径 B：把自报字段变成隐身衣

```
Skeptic: discipline_audit = {performed:true, checked:0, CLEAN}
         verdicts = 128 条全 UPHELD
DA:      coverage_gaps = [], 四个 scan_performed = true

门控：Skeptic SUCCESS、DA SUCCESS、无 PENDING → 波次 CLOSED
```

### 路径 C：让假发现根本进不了锐评波

```
主 Agent 构造 target_finding_ids 时不包含它
—— 没有规则要求这个列表 == wave-2 的 CONFIRMED 集合
```

---

## 四、它给出的"哪个角色多余"答案

**Arbiter 是多余的。** 但不是因为它做得不好，而是**它的值域里没有一项是 Skeptic 给不出的**：

```
UPHELD    = Skeptic 的 holds
DOWNGRADED = severity 查表（纯函数）
REVOKED   = Skeptic 的 refuted
RETRYABLE_FAILURE = "我不知道"，不是裁决
```

**而 Devil's Advocate 不是多余的**——它是唯一在看"没被报的东西"的角色。但**它是被最先砍掉的**：`scale-mapping:68` 在 1–5 切片档直接不给 DA。

> **框架把唯一不可替代的角色设成可选，把可被一行 if 替代的角色设成必需。**

---

## 五、它的总评（我认同）

> 这是一份**知道自己哪里不牢、并把这些地方逐条写成了注释，但没有一处转成判定**的设计文档。
>
> 诚实度 **8 分**，机制强度 **3 分**。
> 运行时会退化成「Skeptic 一个人说了算，其余两个角色负责给它盖章，而 Skeptic 的产出没有任何完备性检查」。

**为什么不是更低分**：五步测试确实会杀掉**不小心的**假发现（引用不存在的行、把注释当逻辑、把定义当行为）。**但这些恰恰是单 Agent 重读一遍也能杀掉的。**

**它真正该防的是"看起来证据充分、实际不成立"的发现——一个机制都没落实。**

---

## 六、这份锐评对前几份的补充

| 前几份的结论 | 这份的补充 |
|---|---|
| 红队说锐评波"没有反盖章硬门槛" | **补充了根源**：不是缺门槛，是防滥杀的字段根本不在契约里 |
| 竞品分析说"该换成工具" | **给出了该保留什么**：五步测试的骨架是对的，`evidence-policy` 第 6 节的机械清单是真能执行的 |
| 流程审计说"F3 假 CLOSED" | **给了机制解释**：DA 的否定结论零证据，所以 `coverage_gaps: []` 永远合规 |

---

## 七、我要修的三条（已确定）

1. **把 `direct_contradiction` 加进 `output-contract` 的 critique schema**，设为"当 `critique_role=skeptic` 且 `verdict=refuted` 时必填"——这是**唯一能机械校验的防滥杀字段**
2. **给 Skeptic 加反向约束**：`critique_role=skeptic` 时 `verdict` 不得为 `UPHELD`（它没有裁决权）
3. **给 Arbiter 加一条 `refuted → UPHELD` 的救回路径**（当 Arbiter 认为 Skeptic 的反驳证据不足且能给出正面证据时）

第 3 条要谨慎——它会削弱"撤销必须有直接矛盾证据"这条原则。更好的做法可能是：**Arbiter 不能直接 UPHELD，但可以要求 Skeptic 重做**（现在的 `RETRYABLE_FAILURE` 就是干这个的，只是没有次数上限，见流程审计的 F5）。

**所以第 3 条暂不改，先修 1 和 2。**
