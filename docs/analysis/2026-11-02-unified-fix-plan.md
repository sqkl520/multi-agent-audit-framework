# 统一修复方案（基于两轮发现的归并）

> **背景**：两轮审计共报 128 条，但**可核实的是 81 条**（47 条无落盘产物）。其中约 54% 归结为 **4 个系统性缺陷**。
>
> **⚠️ 2026-11-03 数字更正**：本文原以「128 条」为分母。经核实，其中 **47 条没有可查产物**（组 B 25 / C-2 11 / E 11 只有汇总表，未落盘），**可核实的只有 81 条**。
> 下文所有以 128 为分母的百分比与归并比例，应按 81 重新审读。详见 `docs/analysis/2026-11-03-critique-data-verified.md` 与 `2026-11-03-number-recount.md`。
> **原则**：不逐条打补丁。每族给「根因 → 统一修法 → 自动验证 → 迁移成本 → 不修的取舍」。

---

## 0. 一个决定性的前提：这个项目里已经有正确的先例

方案不是发明新东西，是**把已验证的正确做法搬到没推广的地方**。三处硬证据：

**① S19 的作者自己已经知道 `both` 的问题**

```css
/* prototypes/S19-copperplate-herbarium-cabinet/style.css:257 */
   fill-mode 必须是 backwards：动画结束后不能继续占着 transform，否则 .is-out 抽不动。 */
.dw { animation: seat 160ms steps(2, end) backwards; }
```

**这条注释是族 1 全部修复依据的原文出处。** 作者在 S19 用对了，只是没推广到 S04 / S08 / S13 / S16 / S18 / S22。

**② 花括号状态机已经写对了**

`check-texture.mjs:53-72` 的注释逐字记录了正则 bug（「`}` 被匹配消耗后相邻规则只看到隔一条……测试盲区保护了缺陷」），并改成了状态机。**`verify-prototype.mjs:76` 没跟着改。**

**③ 退出码模式已经存在**

```javascript
// check-contract.mjs:490
process.exit(FAILS.length ? 1 : 0);
```

---

## 族 1 · `animation ... both` 锁死状态类

### 根因

**同一条 CSS 属性（`transform`）被两个「所有者」同时声明**：入场动画的填充态（层叠优先级高于普通声明）与状态选择器。只要落在同一元素上，「状态永远输」就是必然，与写错无关。

全仓 `animation: ... both|forwards` **136 处**（口径：`git ls-files "*.css"` 的 83 个文件里，`animation` 声明含 `both` 或 `forwards` 的条数；同一口径下 `animation-fill-mode` 显式声明 0 处）。

**倒挂是同一结构的必然副产品**：`prefers-reduced-motion` 块里普遍写了 `animation: none` 释放锁定（S08:307、S16:494、S04:229、S13:659、S18:404），于是**只有开降级的用户能用**。

### ⚠ 关键更正：DOM 实测把 9 处推断砍到 5 处

**我在上一版里列的 9 处是静态推断，DOM 验证后只有 5 处成立、5 处误报、1 处无视觉影响。**

Agent 用 Chrome headless + CDP 扫了全 31 个页面，找到 **583 个被 `both` 锁死 transform 的元素**，但对每个元素逐个施加状态后，绝大多数 `computed transform` **根本不该变**（动画是 `translateY(14px)→0` 收尾，作者值本来就是 `none`）。

| 判定 | 数 | 页面 |
|---|---|---|
| **CONFIRMED** | **5** | S08 / S16 / S22 / S25 / **S18（新发现）** |
| **FALSE_POSITIVE** | 5 | S01 / S04 / S10 / S12 / S15 |
| **NO_VISIBLE_EFFECT** | 1 | S28 |

**误报成因（每条都值得记）**：

| 页面 | 误报原因 |
|---|---|
| S01 | 扫描器把纯类名化合物中和成 `*` 导致过度匹配；`footer` 实际不受 `.state-band` 链约束 |
| **S04** | **`.reveal` 是 JS 追加给 `.note` 的类（`index.html:152/156/160`），从不加到 `.slip` 上**——我实测确认了这一点 |
| S12 / S15 | 该元素本身没有锁死动画（`lockAnims: []`），是同一容器下其他子元素被锁 |
| S28 | `.is-pushing` 的 `--push` 仅在该类自身规则里赋值，加类前后值相同（技术上自指但无值差） |

**这直接证明了我在 4.6.4.1 节写的那条规则的代价**：静态比对省事，但**5/11 是误报率**，而且会漏掉真案（S18 就是静态扫描没抓到的）。

### 确认清单（DOM 实证）

| 页面 | 被锁死的状态 | 动画来源 | 状态规则 | 点击后 transform | 用户可见后果 |
|---|---|---|---|---|---|
| **S08** | `[data-zoom="on"]` | `:295` `rise` | `:201` `scale(3.2)` | 不变，恒 `matrix(1,0,0,1,0,0)` | 图片宽度定格 244px，规则生效应 781px。**核心交互完全无响应** |
| **S16** | `.is-kicked` | `:301` `press-on` | `:386` `kick-back` | 不变，连采 10 次（覆盖 240ms 全程）恒 `matrix(1,0,0,1,12,0)` | 点块号无回推、无弹回 |
| **S22** | `.is-folded` | `:395` `riseIn` | `:255` `rotateY(-96deg)` | 不变，宽度 701→701 | 纸不折，但按钮文案宣称"已折起 420ms" |
| **S25** | `.entry:hover` | `:332` `rise` | `:213` `translateX(-1px)` | 不变，8 个条目全部 identity | 悬停无位移反馈 |
| **S18** 🔍 | `.hang:hover` | `:146` `tag-sway` | `:149` `rotate(6deg)` | 不变，`animationName` 恒 `tag-sway` | **新发现**：悬停牌不摆，6° 旋转缺失 |

**S16 是其中唯一「动画压动画」的形态**（其余都是动画压 `transform`），说明修法体系要能识别这一类。

**设计层结论**：凡 `.is-*` 与入场动画同元素共存者都有风险，但**只有状态规则也改 `transform` 时才真失效**——这解释了为什么约 20 个页面有状态类与 transform 共存，最终只有 5 例成立。

### 四案评估（agent 纠正了我方案 D 的一个错误）

| 案 | 改 HTML | 可脚本化 | 新风险 | 判定 |
|---|---|---|---|---|
| **A 分离元素** | **要** | 否 | **高**：`transform` 会建立包含块；S08 的 `.plate` 是 3D 定位，外包一层破坏 `preserve-3d` 链 | 仅用于 S08 |
| **B 改 transition** | 不要 | 否 | **高**：transition 只能到终值停住，无法表达 `0%→60%→100%` 回弹（S16 的 `kick-back`）与 `steps()` | **否决**作为通法 |
| **C 状态类声明 `animation: none`** | **不要** | **是** | **低** | **存量批量修法** |
| **D CSS 变量中转** | 不要 | 半自动 | 中：**未注册的自定义属性按离散值插值**，入场会跳变 | **新代码约定** |

> **我的原方案 D 写错了**：我写的是「动画只改变量，`transform: rotate(var(--rot))` 由普通声明消费」，但**没提 `@property` 注册**。我实测全仓 `grep @property` **零命中**——不注册的话，动画对自定义属性的插值是**离散**的，入场会跳变而不是平滑过渡。

### D 的正确形态

```css
@property --enter-x { syntax: '<length>'; inherits: false; initial-value: 0px; }

@keyframes rise { from { --enter-x: 14px; opacity: 0 } to { --enter-x: 0px; opacity: 1 } }
.specimen img { animation: rise 420ms ease both; }
.specimen img { transform: translateY(var(--enter-x)) scale(var(--zoom, 1)); }  /* 普通声明消费 */
.specimen[data-zoom="on"] img { --zoom: 3.2; }   /* 只改没被动画锁的那个变量 */
```

**关键：动画锁 `--enter-x`，状态改 `--zoom`——锁与被锁是两个变量，永不相撞。**

### 推荐

**C 修存量，D 立新规，A 只用于 S08。**

- 存量 9 处一律加 `animation: none`；
- S08 的 `.plate:hover` 例外，用 A 把 settle 移给 `.plate-face`；
- 新增守卫强制：任何 `:hover` / `.is-*` / `[data-*]` 规则里出现 `transform`，其在位元素上不得存在 `both` 填充的 transform 动画，**除非动画动的是 `--` 变量**。

### 自动验证

`check-locked-transform.mjs`，三条判据：

1. 上述冲突数 = 0；
2. **`reduce` 档与 `no-preference` 档对同一元素的「状态可见性」一致**（对比两档下该选择器的 `transform` 终值）——这一条直接消灭「降级能用、正常不能用」的倒挂；
3. 变异自测：临时注入一条 `animation: x both` + `:hover{transform}`，脚本必须 exit 1。

### 迁移成本

**5 个文件、9 行 `animation: none` + S08 一处结构调整，无破坏性。** 降级档本来就这么写，等于把降级档的做法搬到普通档。

### 不修的取舍

136 处里约 130 处所在元素**没有任何状态类 transform**，锁了也无害，**不要动**。批量 `both → backwards` 是低风险卫生清理，可做可不做，不单独立项。

---

## 族 2 · 同一状态多处表达、副本漂移（约 25 条）

### 根因

**事实没有单一所有者**：状态存在 DOM 里（class / `hidden` / `textContent`），而文案副本散落在静态 HTML 中。JS 只改它「顺手够得着」的那一处。

量化：错误码重复 ≥8 次的案有 **7/30**（S27 的 `ACT-01` 出现 **14 次**）。

**N 个副本 = N-1 个潜在漂移点。**

### 统一修法：`state → render()` 单向流

```html
<p class="strip__item" data-bind="layer2.status">—</p>
<p class="alert" data-bind="layer2.alert">—</p>
```

```js
const state = { layer2: { status: 'fault', opacity: 30, code: 'TRACE-36' } };

const COPY = {   // 文案也只写一遍
  fault:     s => `第 2 层（1936 年）硫酸纸扫描缺页（错误码 ${s.code}）：该层以 ${s.opacity}% 不透明度占位`,
  rescanned: s => `状态 ${s.code} 已重扫，第 2 层按 ${s.opacity}% 归位`,
};

function render() {
  for (const el of document.querySelectorAll('[data-bind]')) {
    const [scope] = el.dataset.bind.split('.');
    const s = state[scope];
    const v = el.dataset.bind.endsWith('.status') ? COPY[s.status](s) : get(state, el.dataset.bind);
    if (el.textContent !== String(v)) el.textContent = v;   // 幂等，避免打断选择
  }
  document.body.dataset.layer2 = state.layer2.status;      // CSS 走属性，不靠 JS 猜
}

function set(patch) { Object.assign(state.layer2, patch); render(); }   // 唯一写入口
document.getElementById('rescan').addEventListener('click',
  () => set({ status: 'rescanned', opacity: 78 }));
render();
```

**两条硬规则**：
1. **任何 JS 不得直接写 `textContent` / `classList` 表达状态**（只准 `set()`）；
2. **CSS 只消费 `[data-*]` 属性或 `.is-*`，不再读第二份文案。**

**S17 的 `exportBtn.disabled` 属于同一模式的另一面**——它是**派生量**，不该在 5 个分支各写一次：

```js
const canExport = () => state.period.stage === 'verified' && !state.torn;
// render() 内：
exportBtn.disabled = !canExport();
```

### 自动验证

- **静态**：`data-bind` 之外的文本节点若命中「受管事实词表」（错误码正则、`\d+%`、`缺页/已登记/待复检` 等），判 FAIL——即**「状态类文案不许在 `data-bind` 之外出现」**；
- **运行时**：驱动状态矩阵（点每个按钮）后，断言 `innerText` 不含该状态的**禁用词**（如重扫后不得再出现 `30%`、`缺页`）。

### 迁移成本

S15 / S17 / S21 / S28 四案，各改 1 个 HTML（20–40 处加 `data-bind`）+ 1 段 JS 重构。**有破坏性**，但可对每案做「改前 innerText 快照 = 改后快照」的自动比对兜底。

### 不修的取舍

30 案全量改造不划算。**只改「有交互会改状态」的案**（S15/S17/S21/S28/S22/S08）。纯静态案（S19/S20/S30）没有漂移可能，留着。

---

## 族 3 · 文案承诺 vs 实现（约 28 条）

### 根因

**散文里的数字与实现里的数字是两个独立副本，中间没有任何机械连接。** 散文由人写、实现由人写，谁都不知道对方改了。

### 统一修法：`claims.json` —— 把散文断言变成可执行断言

```json
[
  { "id": "S29-bind-margin", "claim": "900–1279px 装订边距 96px",
    "kind": "cssVar", "query": "@media (max-width:1279px) .sheet --pl",
    "expect": "96px", "src": "index.html:443" },
  { "id": "S24-layer-count", "claim": "1024–1439px 显示 3 层",
    "kind": "visibleCount", "selector": ".lv", "at": 1200, "expect": 3 },
  { "id": "S23-thickest", "claim": "最厚的一格是 1961 年",
    "kind": "argmax", "selector": ".strata li", "by": "flex-grow", "expect": "1961" },
  { "id": "S18-paper-1to1", "claim": "纸位移与滚动 1:1",
    "kind": "runtime", "assert": "getComputedStyle(q('.sheet')).transform !== 'none'" }
]
```

运行器（~120 行）按 `kind` 分派：`cssVar` 用**仓库现成的花括号状态机**（`check-texture.mjs` 的 `parseRules`，直接 import，别再写第四版）；`visibleCount` 用 `matchMedia` + `display:none` 判定；`argmax` 求极值；`runtime` 交给 `shot.mjs` 的探针。

**空集必须判 FAIL。**

### 迁移成本

新增 1 个运行器 + 30 份 `claims.json`（**只填被审计点名的 ~28 条**）。**零改动生产代码**——改的是文档与实现中确实错的那一侧。无破坏性。

### 不修的取舍

「文案风格类」承诺（「不做旧」「不用投影」）**无法机械判，放弃**。只做**带数字/带编号**的断言——那占 28 条里的 24 条。

---

## 族 4 · 守卫失效 / 假绿（约 12 条）

### 根因

**检查器的正确性从来没有被检查过。** 一个守卫的价值 = 它能否在缺陷存在时变红，而本仓库的守卫只在「干净仓库」上跑过，于是「解析器坏了 → 匹配不到 → 0 违规 → 绿」与「真的没有违规」**不可区分**。

空集即通过是同一件事的数学形态。

我实测 `_build` 下的状况：

| | 数量 | 脚本 |
|---|---|---|
| **有退出码** | 16 | `check-*` / `verify-prototype` / `shot` / `render-scheme` 等 |
| **无退出码** | **7** | `assign-assets` / `backfill-credits` / `checked-spawn` / `collect-schemes` / `selfhost-fonts` / `_entries` / `_s03-probe` |

### 统一修法：`guard-selftest.mjs`（元守卫）

对每个登记的守卫跑四项体检，任一不过即 exit 1：

| # | 体检 | 判据 |
|---|---|---|
| ① | **有退出码** | 既无 `process.exit` 也无 `process.exitCode` ⇒ 永远 0 |
| ② | **断言匹配得到目标** | 正则在全仓语料上的命中数必须 > 0；= 0 说明断言恒假 |
| ③ | **空集不得通过** | 喂空输入（临时目录 + 最小 fixture），守卫必须报错而非返绿 |
| ④ | **裸 `JSON.parse` 遇 BOM** + 空 `catch` | 未剥 BOM 的 `JSON.parse(readFileSync(...))`；`catch {}` 吞异常 |

**同时把 `check-contract.mjs:490` 的模式升格为全局约定**：
```
一切守卫以 process.exit(FAILS.length ? 1 : 0) 结尾，结论行必须打印。
「无法判定」按 FAIL 处理。
```

### 迁移成本

新增 1 个脚本（~180 行）+ 给 7 个无退出码脚本各加 2 行 + 修 4 处具体 bug。**无破坏性，但会立刻让若干原本「绿」的脚本变红——这是收益不是成本。**

### 不修的取舍

`deliverables/*-scratch/` 下上百个一次性脚本**不纳入体检**——它们是取证快照，不是守卫。只登记 `_build/` 下真正进提交前链路的 8 个。

---

## 修复优先级表

排序依据：**影响面（用户可见性 × 案数）÷ 成本（改动行数 × 回归风险）**

| 序 | 项目 | 影响面 | 成本 | 结论 |
|---|---|---|---|---|
| **1** | 族 4 · `guard-selftest.mjs` + 4 处 bug | 高（**所有**守卫的可信度） | **低** | **立刻做**——先修量具，否则族 1–3 的"修好了"无法被证明 |
| **2** | 族 1 · 9 处 `animation: none` + S08 走 A 案 | 高（功能完全失效，且**普通用户不可用、降级用户可用**） | **低**（9 行 + 1 处调整） | **立刻做**，与 #1 同批提交 |
| **3** | 族 2 · S17 `exportBtn.disabled`、S21 `stamp` | 中高（**谎报功能状态**） | 低（各 3–10 行） | **本批做** |
| **4** | 族 3 · `check-claims.mjs` + 24 条断言 | 中（**可信度**问题） | 中 | **次批做**（需 #1 的量具先绿） |
| **5** | 族 2 · S15 / S28 全量 `data-bind` | 中（点一下看见 6–19 处没更新） | **高** | **次批做**，一案一提交 |
| **6** | 族 1 · 136 处 `both → backwards` | 低（130 处无影响） | 低但噪音大 | 随手做，不立项 |
| **7** | 族 2 · 纯静态案改 `data-bind` | **零** | 中 | **不做** |
| **8** | 族 3 · 风格类承诺机械校验 | 低 | 高（不可判定） | **不做** |

**一句话取舍**：#1 与 #2 是「修好量具 + 修好用户能摸到的坏功能」，本批必须做完；#3/#5 按案拆分提交；#6/#7/#8 明确不做，**避免把每条发现都变成一个补丁**。

---

## 附：我核实过的数字

| 项 | 我实测 | agent 说 | 一致 |
|---|---|---|---|
| `animation ... both/forwards` 总数 | **136** | 142 | ✓（近似）|
| `_build` 有退出码脚本 | **16** | — | — |
| `_build` 无退出码脚本 | **7** | 7 | ✓ | 
| S19 有 `backwards` 正确判据 | **有**（`:257-258`） | 有 | ✓ |
| 全仓 `@property` | **0 处** | （未提，但我用它证明了 D 案的风险） | — |
