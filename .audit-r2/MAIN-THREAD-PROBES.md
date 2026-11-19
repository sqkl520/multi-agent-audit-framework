# 主线程自查记录（2026-11-20）

本文件只记录**主线程亲手跑过探针**的结论。Agent 的报告在各自文件里。

---

## M1 · `verify-artifacts.mjs` 只扫 `.md`，`.json` 产物从扫描计数里**消失**

**位置**：`tools/verify-artifacts.mjs:1001`

```js
else if (e.name.endsWith('.md')) {   // ← .json 产物在此被静默丢弃
```

`walk()` 遍历目录时只把 `.md` 加入 `envelopes`/`scanned`。`.json` 文件既不报「无信封」，
也不计入「扫描产物 N 个文件」——它**完全不存在**于统计里。

### 探针 1：纯 `.json` 目录

```
$ mkdir .probe-a && cp .run-hv/findings/S01.json .probe-a/
$ node tools/verify-artifacts.mjs --repo <HV> --artifacts .probe-a
  扫描产物: 0 个文件，解析出 0 个信封
合计: 1 FAIL / 0 WARN / 0 PASS / 6 SKIP
```

目录里明明有 1 个 1.4 万字节的产物文件，报告说「0 个文件」。

### 探针 2：混合目录 —— **最危险**

```
$ mkdir .probe-mix
$ cp .run-hv/findings/S01.json .probe-mix/bad-artifact.json   # 从不被检查
$ cat > .probe-mix/good.md   # 一个合规的最小信封
$ node tools/verify-artifacts.mjs --repo <HV> --artifacts .probe-mix
  扫描产物: 1 个文件，解析出 1 个信封
✓ PASS  [G1] files_read: 0 条路径，0 条不存在；切片覆盖缺 0 条
合计: 0 FAIL / 0 WARN / 1 PASS / 5 SKIP
```

**结论：0 FAIL，宣称通过。** 而目录里那个 `.json` 从未被任何规则读过。
输出里连一句「有 N 个文件因后缀不符被忽略」都没有。

### 为什么这不是「设计如此」

契约 `framework/components/output-contract.md:36`：

> **你的产物文件必须以一个 json 代码块结尾**，里面是本契约定义的信封。

契约规定的是「文件内容形态」（含 json 代码块），**没有规定文件后缀**。
而 `artifacts/report-naming.md:29` 规定的命名正则以 `\.md$` 结尾。

于是存在一个真实的两难：
- 若产物是 `.md` → 校验器能验，但本框架**曾真的产出过 `.json` 产物**（`.run-hv/findings/*.json`，10 个切片 / 45 条 finding / 41 份裁决）
- 若产物是 `.json` → 校验器静默跳过，且不报告跳过

**真正的问题不是「该不该支持 .json」，而是「被忽略的文件没有出现在报告里」。**
哪怕判定 `.json` 非法，也必须报出来；静默丢弃使「非法产物」与「没有产物」不可区分。

---

## M2 · `check-wrapper-integrity.mjs` 传错 `--baseline` 路径时静默跳过基线检查

**位置**：`tools/check-wrapper-integrity.mjs:126`

```js
if (baselinePath && existsSync(baselinePath)) {   // ← 路径不存在 → 整段跳过
```

`baselinePath` 由 `--baseline <path>` 原样传入，相对于 **cwd** 解析。

### 探针

从仓库根跑（路径写错一级）：

```
$ node tools/check-wrapper-integrity.mjs --baseline fixtures/wrapper-baseline.json
✓ audit-specialist  91  —
...
合计: 0 项问题 / 7 个文件
exit=0
```

从 `tools/` 里跑（路径正确）：

```
$ cd tools && node check-wrapper-integrity.mjs --baseline fixtures/wrapper-baseline.json
⚠ audit-specialist  91   1 项
      · 行数 91 < 基线 104（少 13%，已知未闭合）
⚠ critique-panel    93   1 项
      · 行数 93 < 基线 145（少 36%，已知未闭合）
⚠ fix-worker        81   1 项
⚠ recon-scout       85   1 项
⚠ verifier          88   1 项
合计: 0 项问题 / 5 项已知未闭合 / 7 个文件
```

**同一个文件、同一份基线，只因 cwd 不同，一个报 5 项已知未闭合，一个报 0 项。**

### 危害

这 5 项是 `experiments/CHECKOUT-INCIDENT.md` 记录的永久性内容丢失。工具的注释
（`check-wrapper-integrity.mjs:121-125`）明确写着「**不能因此不报**——它必须每次都被看见」。
但传错路径时，它一次都不会被看见，而且退出码是 0。

**当前 `check-all.mjs` 传参是对的**（`cwd: HERE` = tools 目录），所以 CI 没暴露这个问题。
但任何人在别处手跑就会得到假的绿灯——而「手跑一次看看」正是这个框架被使用的典型方式。

### 最小修法

`--baseline` 给了但文件不存在 → `exit 2`（配置错误），而不是当作没给。

---

## 待 Agent 回报

- `REDTEAM-COVERAGE.md` — 系统扫「校验器静默缩小检查范围」这一类
- `VERIFY-REAL-ARTIFACTS.md` — 拿 45 条真实 finding 复跑全部检查
- `CONTRACT-VS-IMPL.md` — 契约 vs 校验器双向对账（A/B/C/D 四分类）
- `RULE-LEDGER-TRIAGE.md` — 887 条无出口规则句的假阴性率与分诊可行性
- `CRITIQUE-DIRECTION.md` — 批判者攻击本轮方向
