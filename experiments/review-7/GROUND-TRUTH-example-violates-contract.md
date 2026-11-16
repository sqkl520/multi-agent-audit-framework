# 契约的「标准范例」自己违反了契约（而且没人能发现）

**时间**：2026-11-17 03:20
**方法**：读 `gen-contract-examples.mjs` 与 `verify.md`，交叉核对。

---

## 事实

`framework/components/output-contract/verify.md:185` 写的是硬要求：

> `evidence.mutation_scope` | `performed` 时必填 | `implementation_only` 表示只把实现改回旧行为；
> `implementation_and_callsite` 表示还额外验证了「把调用点改回旧调用，测试同样变红」。
> **对「函数返回值决定用户可见行为」的修复，必须为后者**，否则须在 `notes` 说明为何未做调用点变异 |

而框架**给 agent 照抄的那份标准范例**（`tools/gen-contract-examples.mjs:189-196`）是：

```js
verify: {
  finding_id: 'F1',
  verdict: 'PASS',
  escalation_required: false,
  evidence: {
    method: 'mutating_call_site',
    mutation_scope: 'implementation_only',          // ← 更弱的那个
    observed: '把 renameSync 改回旧行为后，定向测试变红；恢复修复后变绿。',
  },
  notes: '修复有效，且只在实现层回退即可复现，说明修复点正确。',   // ← 没有任何解释
}
```

**范例用的是弱变体，且 `notes` 里没有一句话解释「为何未做调用点变异」** ——
这正是契约说「否则须在 `notes` 说明」的那句如果被触发就必须写的东西。

---

## 为什么这件事比其他几条都严重

框架里反复出现过一句自我警告，措辞是（`gen-contract-examples.mjs:170` 附近、`audit.md` 等多处）：

> **「按文档写的却被拒」是这个仓库里最坏的一类缺陷。**

这一条是它的镜像：**「按范例写的却违反正文」**。
agent 照抄范例 → 产物在语义上违约 → **没有任何工具报错**。

因为：

```
$ grep -rn "mutation_scope" tools/*.mjs
tools/gen-contract-examples.mjs:192:      mutation_scope: 'implementation_only',
（仅此一处，是范例生成器，不是校验器）
```

**零实现。** 契约里那句「必须为 `implementation_and_callsite`」，没有任何一行代码读它。

---

## 它已经不是假设了

实战产出 `experiments/field-test-1/evidence-snapshot/round1-05-verify-1.md:80-81`：

```json
"mutation_check": "performed",
"mutation_scope": "implementation_only"
```

验收结论是 `verdict: "PASS", escalation_required: false`（同文件 `:74-75`）。

也就是说，那次实战**用的正是范例里的写法**，并拿到了「契约合规」与 `PASS`。
review-7 随后发现的那 7 条修复里 5 条有缺陷、2 条严重 —— 而验收环节是绿的。

> **不能说这一条「导致了」那 5 条缺陷。** 因果链没有证据。
> 能说的是：**验收契约里唯一一条针对「变异检验够不够深」的要求，从范例到校验器都是空的。**

---

## 闭环：那个假「已验证」标记是自动盖上去的

这份范例不是手写的，是 `gen-contract-examples.mjs` 生成的。它确实**做了验证**
（`gen-contract-examples.mjs:243`）：

```js
out = execFileSync(process.execPath, [VALIDATOR, probe, '--role', role, '--no-exists'], ...)
```

不通过就不写（`:255` `continue`），失败会打印「**写出假示例比没有示例更糟**」（`:258`）。
生成成功后，它写下（`:273`）：

> 这份示例**已经过 check-payload.mjs 验证**，可以直接照抄再改。

于是链条是：

| 环节 | 发生的事 |
|---|---|
| `verify.md:185` | 规定「必须为 `implementation_and_callsite`，否则须在 `notes` 说明」|
| `gen-contract-examples.mjs:192` | 范例用 `implementation_only`，`notes` 不解释 |
| `gen-contract-examples.mjs:243` | 调用 `check-payload.mjs` 验证 —— **通过**，因为没有 `mutation_scope` 规则 |
| `gen-contract-examples.mjs:273` | 盖上一行「**已经过验证，可以直接照抄再改**」|

**那个绿色对勾是真的经过了校验器，只是校验器不看这件事。**

这比「没有校验」更难发现：`check-all.mjs` 里挂着 `check-contract-examples.test.mjs`，
`check-contract-examples.mjs` 的头注释（`:10-16`）也在解释「这是三层闭环之外的第 0 层：
**示例必须是真的**……示例错了，前面三层写得再对也没用，因为大家是照着示例学的」。

机制被设计出来了、被接上线了、被运行了、给出了肯定结论 —— 但它验证的是
`check-payload.mjs` 知道的那部分，而契约里这一条它不知道。

> **`check-all.mjs` 全绿，只能证明「示例符合校验器」，不能证明「示例符合契约」。**

---

## 唯一的机器检查，检查的是错误方向

`tools/check-payload.mjs:1513-1520`：

```js
if (envelope && envelope.role === 'verify' && envelope.payload?.evidence?.mutation_check === 'performed') {
  warnings.push({
    rule: 'mutation_check_vs_readonly',
    msg: '声称做了变异检验，但验收 Agent 是只读角色。确认它真的有写权限',
  });
}
```

它检查的是「**只读角色声称做了写操作的变异检验**」——这确实值得怀疑。
但它是一条 `warning`，不是 `error`；而且它**不读 `mutation_scope`**。

于是同一段契约里：

| 契约要求 | 机器检查 |
|---|---|
| `mutation_check` 除两种情形外强制 `performed` | 无（没有「应为 performed 却是 skipped」的规则）|
| `mutation_scope` 在特定情形必须为 `implementation_and_callsite` | 无（工具里 `mutation_scope` 零出现）|
| 声称 `performed` 时角色应可写 | 有，但是 warning |

---

## 与另外三条模式的关系

这是同一条病在**契约层**的表现形式：

| # | 规则写在哪 | 机器读它吗 |
|---|---|---|
| A 改断言让它变绿 | `wave4-fix.md:200` | 否 |
| B 判定面只覆盖自造样本 | 无对应条目 | — |
| C 注释承诺 > 代码实际 | `wave2-audit.md:629` 模式 5，且被排除在检查项外 | 否 |
| **D 契约正文 > 契约范例** | `verify.md:185` | **否，而且范例反向示范** |

**D 比 A/B/C 更值得先修**，理由是它同时污染两个方向：
向下 agent 会照抄错的范例，向上「契约合规」这个结论本身不可信。
而且它的修法最便宜——改范例 + 加一条 `mutation_scope` 的规则，都是几行的事。

---

## 可执行的最小修法（草案，待 agent 方案交叉验证）

1. 把 `gen-contract-examples.mjs:192` 的 `'implementation_only'` 改成
   `'implementation_and_callsite'`，或保留但让 `notes` 写明「本范例不涉及函数返回值决定用户可见行为的情形」。
2. 在 `check-payload.mjs` 的 verify 分支加规则：
   - `mutation_check !== 'performed'` 且 `notes` 未说明属于 `harness_unsupported` / `unsafe_revert`
     → `mutation_check_not_performed_unexplained`（ERROR）
   - `mutation_scope === 'implementation_only'` 且 `notes` 未说明理由
     → `mutation_scope_weak_unexplained`（WARNING 起步，视误报率决定是否升 ERROR）
3. 加一条**契约自检**：`gen-contract-examples.mjs` 产出的每个示例必须能通过
   `check-payload.mjs`。这条如果早就存在，D 根本不会发生。

第 3 条是根治：**让范例本身受检**。现在 `check-all.mjs` 里挂的是
`check-contract-examples.test.mjs` —— 需要核实它到底验了什么。
