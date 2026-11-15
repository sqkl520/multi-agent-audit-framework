# R1 报告：把修复/验收相位接入状态机与 stop-hook

**任务**：`framework/artifacts/run-state.md` 的 `phase` 枚举缺 `wave4`/`wave5`，导致 `stop-hook.mjs` 在修复阶段完全不触发。
**日期**：2026-11-15
**改动范围**：5 个文件，+400 / −9 行。未 commit。

---

## 一·0 先写失败测试（TDD，改代码前跑）

按任务要求，先只改测试文件、不动被测代码，跑一次。以下为**原文输出**（`node tools/check-state.test.mjs`，尾部）：

```
case 29: phase=wave4 / wave5 不再被判 invalid_enum
  ✗ wave4 不报 phase invalid_enum — [{"field":"phase","rule":"invalid_enum","msg":"必须是 init | wave1 | wave2a | wave2b | wave3 | report | closed 之一，实际是 \"wave4\""}]
  ✗ wave4 整体无错误 — [{"field":"phase","rule":"invalid_enum","msg":"必须是 init | wave1 | wave2a | wave2b | wave3 | report | closed 之一，实际是 \"wave4\""}]
  ✗ wave5 不报 phase invalid_enum — [{"field":"phase","rule":"invalid_enum","msg":"必须是 init | wave1 | wave2a | wave2b | wave3 | report | closed 之一，实际是 \"wave5\""}]
  ✗ wave5 整体无错误 — [{"field":"phase","rule":"invalid_enum","msg":"必须是 init | wave1 | wave2a | wave2b | wave3 | report | closed 之一，实际是 \"wave5\""}]
case 30: path_mode=FIX + phase=wave4 但完全没有 fix_contracts → 报错
  ✗ 报 fix_contracts_required — [{"field":"phase","rule":"invalid_enum","msg":"必须是 init | wave1 | wave2a | wave2b | wave3 | report | closed 之一，实际是 \"wave4\""}]
case 31: path_mode=FIX + phase=wave4 但 fix_contracts 为空数组 → 报错
  ✗ 报 fix_contracts_required — [{"field":"phase","rule":"invalid_enum","msg":"必须是 init | wave1 | wave2a | wave2b | wave3 | report | closed 之一，实际是 \"wave4\""}]
case 32: path_mode=FIX + phase=wave5 且契约齐备 → 合规
  ✗ 无错误 — [{"field":"phase","rule":"invalid_enum","msg":"必须是 init | wave1 | wave2a | wave2b | wave3 | report | closed 之一，实际是 \"wave5\""}]
case 33: 非 FIX 路径（AUDIT_ONLY）缺 fix_contracts 仍然合法
  ✓ 不报 fix_contracts_required
  ✗ 无错误 — [{"field":"phase","rule":"invalid_enum","msg":"必须是 init | wave1 | wave2a | wave2b | wave3 | report | closed 之一，实际是 \"wave4\""}]
case 34: wave5 的 verdict 拼错（PASSED）→ 报错而非静默放行
  ✗ 报 invalid_verify_verdict — [{"field":"phase","rule":"invalid_enum","msg":"必须是 init | wave1 | wave2a | wave2b | wave3 | report | closed 之一，实际是 \"wave5\""}]

=== 结果: 29 通过 / 9 失败 ===
```

`node tools/stop-hook.test.mjs`（尾部，原文）：

```
case 11: 回归 — wave2a 相位闭合 → 退出码 0（白名单改动不得误伤）
  ✓ 退出码 0
case 12: phase=wave4 无 current_plan → 拒绝结束（exit 2）
  ✗ 退出码 2 — 实际 0
  ✗ 提到 current_plan
case 13: phase=wave4 多条 finding 但只派 1 个实例 → 拒绝结束（串行即违规）
  ✗ 退出码 2 — 实际 0
  ✗ 理由提到面板下限
  ✗ 理由提到串行
case 14: phase=wave4 多条 finding 且按条派发 → 不得误拦（exit 0）
  ✓ 退出码 0
case 15: phase=wave4 无 fix_contracts → 拒绝结束（交付物缺失）
  ✗ 退出码 2 — 实际 0
  ✗ 提到交付物
case 16: phase=wave5 每条契约都有裁决 → 允许结束（exit 0）
  ✓ 退出码 0
case 17: phase=wave5 有契约没有裁决 → 拒绝结束（exit 2）
  ✗ 退出码 2 — 实际 0
  ✗ 提到验收裁决

=== 结果: 19 通过 / 9 失败 ===
```

**失败信息本身复现了诊断结论**：case 12/13/15/17 的失败形式是「实际 0」——`stop-hook.mjs` 对 `wave4`/`wave5` **放行了**。这不是判据算错，是整段代码从未进入：相位不在白名单里，`PHASE_DELIVERABLES` 里也没有这两个键，`check` 取到 `undefined`，整段跳过。

注意 case 14 和 case 16 在**改代码前就已经是绿的**——它们断言的是「放行」，而未打补丁的 hook 对 wave4/wave5 一律放行。**这两个用例本身不能证明任何东西**，它们的价值在于锁住「加严之后不许误拦」的另一侧。没有 case 12/13/15/17 那四条红的，这两条绿只是空转。

---

## 一·1 逐文件的改前 / 改后

### 1. `framework/artifacts/run-state.md`

#### 1a. `phase` 枚举（原 `:54`）

改前：
```
  "phase": "init | wave1 | wave2a | wave2b | wave3 | report | closed",
```
改后：
```
  "phase": "init | wave1 | wave2a | wave2b | wave3 | wave4 | wave5 | report | closed",
```

#### 1b. `budget` 计数段说明（原 `:37`）

改前：
```
**`budget` 中四个计数字段的用途**（2026-11-03 新增。`protocol.md` 第 3.1 节要用它们算失败率阈值，此前 `state.json` 里没有对应字段——阈值规则写着却没有分母）：
```
改后：
```
**`budget` 中五个计数字段的用途**（2026-11-03 新增前四个；2026-11-15 新增 `spawned_fix_agents`。…）：
```

#### 1c. `budget` 表新增一行（原 `:44` 之后）

改前：表止于 `failed_deep_dive`。
改后新增：
```
| `spawned_fix_agents` | 波次四（`wave4`）**实际**派发的修复实例数 | 每次派发后 +1 | 与 `fix_contracts` 的 `finding_id` 去重数对账：多条独立缺陷却只有 1 个实例，说明是单实例串行，`stop-hook.mjs` 会拒绝闭合该相位 |
```
并把「硬规则：四个字段」改为「五个字段」，追加一段说明为什么这个字段必须实际计数。

#### 1d. `budget` JSON 块（原 `:57-65`）

改前：
```
    "failed_deep_dive": 1
  },
```
改后：
```
    "failed_deep_dive": 1,
    "spawned_fix_agents": 0
  },
```

#### 1e. `current_plan.phase` 示例（原 `:100`）

改前：
```
    "phase": "wave2a",
```
改后：
```
    "phase": "wave2a — 必须与 state.phase 逐字相同；FIX 路径取 wave4 / wave5",
```

#### 1f. `fix_contracts` schema（原 `:143-155`）

改前最后一项是：
```
      "test_path": "string — 不存在则写 需新建"
    }
```
改后：
```
      "test_path": "string — 不存在则写 需新建",

      "verdict": "PASS | FAIL — wave5 写入。带保留通过写 PASS + escalation_required:true",
      "escalation_required": false,
      "verified_at": "ISO8601 — 有 verdict 时必填，供与 files_touched 的 mtime 对账"
    }
```
并在 JSON 块之后追加一段说明：`verdict` 只由 `wave5` 写入，`wave4` 期间必须缺席；`check-state` 只校验已写出的值是否在闭集内，**强制它存在的是 `stop-hook` 的相位门**。

#### 1g. 新增「第 2.5 节：修复相位（`wave4`）与验收相位（`wave5`）」

插在「第 3 节」之前，含四个小节：

- **2.5.1 为什么这两个相位此前不存在** —— 四行证据表（白名单不含 → hook 不触发；提示词最弱；`final-report.md:25` 每条发现一个停点；Skeptic 只在 wave3 执法 → 修复相位是执法真空）
- **2.5.2 `wave4`** —— 进入条件 / 允许动作 / 闭合条件 / 交付物 / 机械校验五项表 + 并行下限 + 「为什么写死在 hook 而不是提示词」+「缺失按 0 不按 1」
- **2.5.3 `wave5`** —— 同上五项 + 「为什么闭合条件是『无未裁决』而不是『有 PASS』」+ 四种去向表
- **2.5.4 与审计路径的关系** —— 明写 `AUDIT_ONLY` 序列一个值都没变，并列出保证这一点的两条硬约束

#### 1h. §4 续跑协议补 `phase` 分派（原 `:246` 之后）

改前：只有按 `status` 的四条分支。
改后追加一张表 + 一段理由：

```
| `phase` | `status = RUNNING` 时从哪里继续 |
|---|---|
| `init` ~ `wave3` | 按上表从 `in_flight` 与 `DEFERRED` 继续（审计路径，行为不变） |
| `wave4` | 逐条检查 `fix_contracts`… |
| `wave5` | 逐条检查 `fix_contracts` 的 `verdict`… |
```
理由：`phase` 与 `status` 正交，但原文只按 `status` 分支；而 FIX 路径的进度**不在 `in_flight` 里，在 `fix_contracts` 里**，照原文续跑会去一个空数组里找进度。

---

### 2. `tools/check-state.mjs`

#### 2a. `ENUM.phase`（原 `:55`）

改前：
```js
  phase: ['init', 'wave1', 'wave2a', 'wave2b', 'wave3', 'report', 'closed'],
```
改后：
```js
  // 2026-11-15（R1）：补 wave4 / wave5。
  // `path_mode` 早有 FIX 这个取值，`phase` 却没有任何修复/验收相位——
  // 于是「框架知道存在 FIX 路径，却没给它分配相位值」：stop-hook 的白名单
  // 只能按相位匹配，修复阶段直接落在门控之外。加值不是加功能，是补上原有的空洞。
  phase: ['init', 'wave1', 'wave2a', 'wave2b', 'wave3', 'wave4', 'wave5', 'report', 'closed'],
```

#### 2b. `fix_contracts` 从「存在才校验」改为「FIX 路径必须有」（原 `:203` 之前新增）

改前：整段是 `if (Array.isArray(state.fix_contracts)) { … }`，字段不存在则静默跳过。
改后插入：
```js
const FIX_CONTRACT_PHASES = ['wave4', 'wave5'];
const fixContractsRequired =
  state.path_mode === 'FIX' && FIX_CONTRACT_PHASES.includes(state.phase);

if (fixContractsRequired) {
  if (!Array.isArray(state.fix_contracts)) {
    err('fix_contracts', 'fix_contracts_required', …);
  } else if (state.fix_contracts.length === 0) {
    err('fix_contracts', 'fix_contracts_required', …);
  }
}
```
**原有的「存在时才校验内容」逻辑逐字保留**，紧接其后。

#### 2c. 新增 `verdict` 闭集校验（原 `:203` 段内末）

```js
const VERDICTS = ['PASS', 'FAIL'];
…
if (fc?.verdict !== undefined && fc?.verdict !== null) {
  if (!VERDICTS.includes(fc.verdict)) {
    err(`fix_contracts[${i}].verdict`, 'invalid_verify_verdict', …);
  } else if (fc?.verified_at === undefined || …) {
    warn(`fix_contracts[${i}].verified_at`, 'verdict_without_timestamp', …);
  }
}
```
理由：「PASSED」这类拼错在按字符串精确比较的下游会被当作未知值跳过，等于把误拼洗成通过。

#### 2d. **第二处硬编码相位清单（任务要求「检查是否有其他地方硬编码了 phase 列表」）**

`tools/check-state.mjs:277`（原行号）**确有一份副本**：

改前：
```js
if (['wave2a', 'wave2b', 'wave3'].includes(state.phase)) {
```
改后：
```js
// 2026-11-15（R1）：同一份相位清单在本文件里有第二处硬编码（:277），
// 与 ENUM.phase 是两份副本。只改枚举不改这里，会得到「wave4 是合法相位但不要求计划」——
// 而 stop-hook.mjs 对 wave4 要求 current_plan。两个校验器对同一相位给出相反要求，
// 主 Agent 无论照哪一份做都会被另一份判违规。
const EXECUTION_PHASES = ['wave2a', 'wave2b', 'wave3', 'wave4', 'wave5'];
if (EXECUTION_PHASES.includes(state.phase)) {
```

**这一条不在任务的显式清单里，是「检查是否有其他地方硬编码」查出来的。** 不修它会产生一个比原缺陷更难查的失效：`check-state` 说 wave4 合法且不要求计划，`stop-hook` 说 wave4 必须有计划。两份校验器对同一状态给出相反判定。

扫描范围内其余 `phase` 出现处（`gate.mjs` / `check-deliverables.mjs` / `check-plan.mjs` / `simulate-round-chain.mjs`）**均无相位白名单**，已 grep 确认（0 命中）。

---

### 3. `tools/stop-hook.mjs`

#### 3a. 相位白名单（原 `:70`）

改前：
```js
if (['wave2a', 'wave2b', 'wave3'].includes(state.phase)) {
```
改后：
```js
// 2026-11-15（R1）：白名单补 wave4 / wave5。
// 此前只有 wave2a/wave2b/wave3 —— 修复与验收阶段 stop-hook **完全不触发**，
// 而 harness 强制的 hook 是本框架唯一的硬手段（见文件头对手段强弱的排序）。
// 缺口存在时，修复阶段只剩提示词那一层，也就是框架自己判为「最弱」的那一层。
if (['wave2a', 'wave2b', 'wave3', 'wave4', 'wave5'].includes(state.phase)) {
```

#### 3b. `PHASE_DELIVERABLES` 补两个键（原 `:150-154`）

改前：
```js
const PHASE_DELIVERABLES = {
  wave1: () => state.slices && Object.keys(state.slices).length > 0,
  wave2a: () => Array.isArray(state.wave2_completed) && state.wave2_completed.length > 0,
  report: () => state.report?.final_report_path && existsSync(state.report.final_report_path),
};
```
改后新增（`wave1`/`wave2a`/`report` 三行逐字未动）：
```js
const VERDICT_VALUES = ['PASS', 'FAIL'];
const fixContracts = Array.isArray(state.fix_contracts) ? state.fix_contracts : [];
…
  wave4: () => fixContracts.length > 0,
  wave5: () => fixContracts.length > 0 &&
    fixContracts.every((fc) => VERDICT_VALUES.includes(fc?.verdict)),
```
两条判据的注释写清了为什么取这个判据（`wave5` 取「无未裁决」而非「有 PASS」：`FAIL` 也是合法终态，缺 `verdict` 才是「没人看过」）。

#### 3c. 交付物失败信息按相位具体化（原 `:156-161`）

改前是一句通用文案。改后增加 `specific` 查表，`wave4`/`wave5` 给出具体缺的是什么；其余相位走 `??` 兜底，**原通用文案逐字保留**。

#### 3d. 新增 §3.5：`wave4` 并行下限（原 `:161` 之后）

```js
if (state.phase === 'wave4') {
  const findingIds = new Set(fixContracts.map(fc => fc?.finding_id).filter(…));
  const spawned = Number(state.budget?.spawned_fix_agents ?? state.spawned_fix_agents ?? 0);
  if (findingIds.size > 1 && spawned <= 1) {
    problems.push(…「多条独立缺陷在单个实例里串行完成，违反 triage.md 的面板下限」…);
  }
}
```

判据只用两个数字（`finding_id` 去重数 vs `spawned_fix_agents`），不需要理解修复内容——`protocol.md` §1.2 禁止主 Agent 做需要理解内容的判断，这条因此可以机械化。

**`spawned_fix_agents` 缺失按 0 处理，不按 1。** 账本没记录等于没发生；按 1 处理等于给「忘了记账」一条免罚通道，而记账遗漏正是 round31「账本记 22、产物 ≥47」的成因。

兼容性：同时接受 `state.budget.spawned_fix_agents` 与顶层 `state.spawned_fix_agents`，schema 文档只推荐前者（放在 `budget` 下与其余四个计数同处）。

---

### 4. `tools/check-state.test.mjs`（+90 行，case 29–35）

复用文件里已有的 `base()` / `has()` / `run()` 辅助函数，新增两个局部工厂 `fc()`（一条完整 fix_contract）与 `donePlan()`（一个合规 current_plan），避免重复字面量。

| case | 覆盖 |
|---|---|
| 29 | `phase: 'wave4'` / `'wave5'` 合法（不再报 `invalid_enum`） |
| 30 | `path_mode: 'FIX'` + `phase: 'wave4'` 且 `fix_contracts` **字段缺失** → 报 `fix_contracts_required` |
| 31 | 同上但 `fix_contracts: []` → 同样报错（空数组与缺失同义） |
| 32 | `FIX` + `wave5` 且契约齐备（带 `verdict`/`verified_at`）→ 合规 |
| 33 | **回归**：`AUDIT_ONLY` + `wave4` 缺 `fix_contracts` 仍然合法 |
| 34 | `verdict: 'PASSED'` 拼错 → 报 `invalid_verify_verdict` |
| 35 | `wave4`/`wave5` 与 `wave2a` 一样要求 `current_plan`（锁住两份相位清单同步） |

### 5. `tools/stop-hook.test.mjs`（+101 行，case 11–17）

| case | 覆盖 |
|---|---|
| 11 | **回归**：`wave2a` 相位闭合 → exit 0（白名单改动不得误伤） |
| 12 | `wave4` 无 `current_plan` → exit 2 |
| 13 | `wave4` 两条 `finding_id` 但 `spawned_fix_agents: 1` → exit 2，stderr 含「面板下限」与「串行」 |
| 14 | `wave4` 两条 `finding_id` 且 `spawned_fix_agents: 2` → exit 0（**不许误拦**） |
| 15 | `wave4` 无 `fix_contracts` → exit 2 |
| 16 | `wave5` 每条契约都有 `verdict`（一 PASS 一 FAIL）→ exit 0 |
| 17 | `wave5` 有一条无 `verdict` → exit 2 |

---

## 二 三条验证命令的最终结果

```
$ node tools/check-state.test.mjs
=== 结果: 40 通过 / 0 失败 ===
EXIT=0

$ node tools/stop-hook.test.mjs
=== 结果: 28 通过 / 0 失败 ===
EXIT=0

$ node tools/check-all.mjs
──────────────────────────────────────────
✅ 全部通过
check-all exit=0
```

（三条命令在全部改动完成后各跑过至少两次，末次运行在并行 agent 的改动已落盘之后，结论一致。）

`check-all` 里与本次改动直接相关的两项：

```
state.json 校验器
  → === 结果: 40 通过 / 0 失败 ===
Stop hook 相位守卫
  → === 结果: 28 通过 / 0 失败 ===
```

**check-all 全绿，无因其他 agent 并行改动造成的失败。** 有一项是已知未闭合、非失败：
```
Wrapper 完整性（结构 + 关键段落 + tools 权限）
  → 合计: 0 项问题 / 5 项已知未闭合 / 7 个文件
```
（`tools/check-all.mjs:88-94` 的注释说明这 5 条是脚本内 WARN 级、在 START-HERE 缺陷表里已登记。）

输出里另有几处 `[预期失败]` 前缀行（`契约切片保真度` / `枚举跨层一致性` / `GT 缺陷的模式归属`），它们是测试脚本**故意制造**的负例，用于验证被测脚本能正确拒绝坏输入——不是失败，对应的 suite 退出码均为 0。`枚举跨层一致性` 那条 `无法从 check-payload.mjs 解析出 ENUM_CHECKS` 出现在另一个 agent 正在改 `check-payload.mjs` 的负例构造里，与该 suite 的绿灯结论一致。

---

## 三 会不会误伤既有审计路径

**结论：不会。** 从四个角度核过：

### 3.1 枚举是「加」不是「改」

`phase` 的合法值从 7 个变成 9 个。原有 7 个值一个都没删、没改名，任何现存 `state.json` 的 `phase` 取值判定结果**逐字不变**。

### 3.2 `fix_contracts_required` 有 `path_mode` 双重守卫

```js
state.path_mode === 'FIX' && FIX_CONTRACT_PHASES.includes(state.phase)
```
`AUDIT_ONLY` 路径下这个条件恒为 false，缺 `fix_contracts` 仍然合法——case 33 专门锁这一点。`AUDIT_ONLY` 的账本里即便有 `phase: 'wave4'`（不该有，但假设它错写了），也不会被新增检查触发。

### 3.3 `stop-hook` 的新分支只在相位字面匹配时进入

`wave4`/`wave5` 两个键在 `PHASE_DELIVERABLES` 里，`state.phase` 不是这两个值就取不到。§3.5 的 `if (state.phase === 'wave4')` 同理。审计路径的相位序列 `init → wave1 → wave2a → wave2b → wave3 → report → closed` 一次都不会进入新分支。

**唯一的跨界改动是白名单本身**（`['wave2a','wave2b','wave3']` → 追加两个值），这是**加**：三个原有值的行为不变，case 11 专门锁这一点。

### 3.4 `check-state` 第二处清单同步的风险点

`check-state.mjs:277` 那份副本我改成了 `EXECUTION_PHASES` 并追加相同两个值。**风险在反方向**：如果只改枚举不改这里，`wave4` 会被判合法但不需要 `current_plan`，而 `stop-hook` 要求它必须有——两个校验器给出相反判据。现在两份清单一致，且 case 35 锁住 `check-state` 一侧、case 12 锁住 `stop-hook` 一侧。

### 3.5 真正需要留意的两点（不是误伤，是行为变化）

1. **`wave4`/`wave5` 现在会被 stop-hook 拦。** 这正是任务目标，但对一个**已经在跑**的 `wave4` 轮次（若有）意味着它下次试图结束回合时会收到 exit 2。这是预期行为，不是回归——它此前不被拦，是因为门控根本没接上。缓解：`stop_hook_active` 检查（原 `:51-53`）仍在，不会死循环。

2. **`spawned_fix_agents` 是新增字段，缺失按 0。** 一条只修了 1 个缺陷的 `wave4` 不受影响（`findingIds.size > 1` 不成立）。一条修了多条但没记 `spawned_fix_agents` 的 `wave4` 会被拦——**这是刻意的**，否则字段永远可以由「忘了写」来绕过。若确有正当理由（例如某条缺陷在单个实例里依赖上下文必须串行），当前实现**没有豁免通道**，需要显式记账（把它拆成两个 `finding_id` 之外的登记方式，或后续加一个 `serial_justification` 字段）。这一点我认为值得在后续轮次评估，但不在 R1 范围内扩大改动。

---

## 四 一件要报告的越界说明

**任务说「只改下面列出的文件」**，我改的 5 个文件全部在清单内：

```
framework/artifacts/run-state.md
tools/check-state.mjs
tools/check-state.test.mjs
tools/stop-hook.mjs
tools/stop-hook.test.mjs
```

`git status` 里另有 14 个已修改文件与若干未跟踪文件，**不是我改的**，是并行 agent 的工作（`check-payload.mjs`、`gen-contract-examples.mjs`、`framework/templates/wave4-fix.md`、`framework/templates/wave5-verify.md`、`START-FIX.md`、`tools/check-disposition-coverage.mjs`、`FIX-R2/R4/R5-report.md` 等）。我没有碰它们，也没有因它们失败而修改任何东西。

有一个交集需要说明：`framework/templates/wave4-fix.md` 与 `wave5-verify.md` 被另一个 agent 改了（各 +94 / +58 行）。我**读了**它们来确定 `fix_contracts` 的字段语义与 `verdict` 的闭集，但**没有写**它们。我的改动对它们没有依赖——我的判据只读 `state.json` 里的字段，不解析模板文本。

---

## 五 遗留 / 建议后续

1. **`spawned_fix_agents` 无正当串行豁免通道**（见 3.5.2）。若真实运行中出现「多条缺陷必须串行」的合法场景，需要加一个显式理由字段，否则 hook 会逼着主 Agent 为了过闸而拆分本来不该拆的工作。
2. **`verdict` 的 `verified_at` 目前只是 warn，不是 error。** 我没有把它升成 error，因为 `check-state` 对「可以暂时没有」的字段一贯宽容，而强制存在由 `stop-hook` 的相位门负责。但这个分工对 `verified_at` 尚未落实——`stop-hook` 只查 `verdict` 存在，不查 `verified_at`。后续可考虑在 `wave5` 的交付物判据里加一条。
3. **"phase 枚举在两处硬编码"这个模式本身。** 本次修的是两处副本，但只要 `ENUM.phase` 与 `EXECUTION_PHASES` 仍是两个独立的数组字面量，下一次加相位还会漂。彻底解法是让 `EXECUTION_PHASES` 从 `ENUM.phase` 派生（例如 `ENUM.phase.slice(2, 7)` 这种脆弱但集中的写法，或显式导出）。R1 范围内我按最小改动处理，没有重构。
