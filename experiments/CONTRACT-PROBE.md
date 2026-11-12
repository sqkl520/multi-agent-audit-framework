# 契约承诺 vs 校验器实际执行：19 条判据逐条实测

**日期**：2026-11-12
**方法**：把 `output-contract.md` 里每一条写着「`CONTRACT_VIOLATION`」的硬判据，各造一份**违反它的产物**，跑 `check-payload.mjs`，看校验器是否真的执行了这条。

**为什么必须做**：契约里写了「一律视为违规」不等于校验器会这么做。这个框架的核心主张是「三层闭环：模板要求 → 契约承载 → 校验器执行」，而**第三条腿最容易断**——前两条是人写的散文，看起来永远完整。

---

## 结果：19 条里，2 条一直没被执行

| 用例 | 契约判据 | 修复前 | 修复后 |
|---|---|---|---|
| **`findings: []` 空数组** | §2.2 明文「一律视为 `CONTRACT_VIOLATION`」 | **✅ 通过** ❌ | ✗ `empty_findings` |
| **`CONFIRMED` + `quote: ""`** | §2.2 CONFIRMED 必须有门 0 级证据 | **✅ 通过** ❌ | ✗ `confirmed_without_evidence` |
| **`dimension_histogram` 之和 ≠ `leads.length`** | §2.2a 明文「不一致即 `CONTRACT_VIOLATION`」 | **✅ 通过** ❌ | ✗ `histogram_mismatch` |

> 实际上是三条。前两条在上一轮（同日早些时候）修掉了，本轮做全量对照时又发现第三条。

其余 16 条判据，校验器都在正常执行：

| 用例 | 命中的规则 |
|---|---|
| `schema_version` 版本不对 | `wrong_schema_version` |
| `role` 不在六个角色里 | `invalid_role` |
| `status` 不在四个终态里 | `invalid_status` |
| `SUCCESS` 但 `artifact_path` 为 null | `missing_artifact_path` |
| `artifact_path` 指向的文件不存在 | `artifact_not_found` |
| recon `slice_count ≠ len(audit_slices)` | `count_mismatch` |
| recon 静默截断（`truncated: true` 但不写 `unverified`） | `silent_truncation` |
| recon 入口点缺 `evidence_quote` | `missing_entry_point_field` |
| sweep `lead_count ≠ len(leads)` | `count_mismatch` |
| sweep `reachability` 不是枚举值 | `invalid_enum_value` |
| audit `NO_EVIDENCE_FOUND` 但 `basis` 少于 15 字 | `vacuous_basis` |
| audit `NO_EVIDENCE_FOUND` 但无 `searched_scope` | `no_evidence_without_scope` |
| audit `SKIPPED` 不给 `note` | `self_check_no_reason` |
| audit `finding.status` 不是枚举值 | `invalid_finding_status` |
| audit 缺 `self_checks` | `missing_role_field` |

---

## 三个必须能通过的反向对照

只测「该拦的拦住了」是不够的——还要测「不该拦的没被拦」。三个豁免情形都正确：

| 用例 | 契约依据 | 结果 |
|---|---|---|
| 完全合规的 audit 产物 | — | ✅ 通过 |
| sweep 的 `leads: []` 空数组 | §2.2a：sweep 的线索**允许**为空（与 audit 的 `findings` 相反） | ✅ 通过 |

**「sweep 允许空、audit 不允许空」这个区别是契约里最容易被改坏的一处**——两者字段名不同（`leads` vs `findings`），但形态相似，改校验器时很容易顺手统一，那就会让宽扫凭空产生虚假线索，或让审计用空结果蒙混过关。现在有测试钉住了。

---

## 一个过程中的乌龙，值得记下

第一轮跑出来 A2（`artifact_path: null`）显示「通过」，我一度以为又找到一个漏洞。

**实际是我的生成脚本有 bug**：它无条件用真实文件路径覆盖 `artifact_path`，把我故意写的 `null` 盖掉了，所以测的其实是合规产物。

修法是一行：`if (obj.artifact_path === 'PLACEHOLDER') obj.artifact_path = file;`——只填占位符，不覆盖显式指定的值。

**教训**：红队工具自己也要验证。一个「所有用例都通过」的结果，可能是工具没在测你想测的东西。这次是靠「A2 的期望值和实际值不符」这个矛盾暴露出来的——**如果我只测「该拦的都拦住了」，一个全部通过的假象会让我直接收工**。

---

## 固化

| 产物 | 位置 |
|---|---|
| 19 个探针的生成器 | `tools/fixtures/contract-probe/gen.mjs` |
| 逐条对照 runner | `tools/fixtures/contract-probe/run.mjs`（输出 19/19） |
| 新增回归测试 | `check-payload.test.mjs` case 68–72 |
| 接入总检查 | `tools/check-all.mjs` 新增一项「契约判据逐条对照（红队）」 |

**当前状态：19/19 全部符合契约，`check-payload.test.mjs` 77/77 通过。**

---

## 这条经验的一般形式

**契约里的每一条硬判据，都必须有对应的「违反它」的测试用例，否则它只是一句愿望。**

而且要用**两个方向**测：
- 该拦的拦住了吗？（防止漏洞）
- 不该拦的没被拦吗？（防止误伤太狠，让产物无法通过）

只做一个方向，都会留下看不见的洞。
