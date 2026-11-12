# round2 组 D 审计报告（验证脚本群 · 35 个脚本 / 2198 行）

> **审计对象**：`D:\Web\style` 的交付验证脚本群
> `deliverables/62-exec/tpl-integration/`（10 脚本）+ `deliverables/71-verify/`（12 脚本）+ `deliverables/72-plan/`（11 脚本）+ `prototypes/S03-.../`（2 脚本）
> **路径模式**：AUDIT_ONLY
> **零写入自检**：跟踪文件零改动 ✓ / 未跟踪 1841（与基线一致）✓ / 实验在仓库外临时副本 ✓

---

## 0. 一句话结论

**这个目录里的"验证脚本"大部分不是验证器，是数据打印器。** 它们把结果 `JSON.stringify` 到 stdout，然后正常退出——**退出码与正确性完全无关**。所谓"验收通过"全靠人去读 JSON。

更严重的是：其中**用于验证"闸门是否有效"的元验证脚本，自己也 exit 0**。整个自检体系的信任链在最底层是断的。

---

## 1. 最严重的一条：H1 —— 错误通道结构性失明

**这条是本轮我复核得最彻底的，因为它不是"某个检查项写错了"，而是"整条错误通道收不到信号"。**

### 证据链（三段，缺一不成立）

**第一段：verify 家族没有断言，也没有退出码**

```bash
$ grep -cE "process\.exit|assert|throw new Error" deliverables/62-exec/tpl-integration/verify-final.mjs
0
$ tail -3 deliverables/62-exec/tpl-integration/verify-final.mjs
console.log(JSON.stringify(R, null, 1));
await b.close();
```

`verify.mjs`、`verify2.mjs` 同款。三个文件都以"打印 JSON 然后正常结束"收尾。

**第二段：唯一的错误通道只订阅了真异常**

```javascript
// tools/taste-skill/.../lib/cdp.mjs:129-131
browser.on(sessionId, 'Runtime.exceptionThrown', (p) => {
  this.consoleErrors.push((p.exceptionDetails?.exception?.description || ...).slice(0, 300));
});
```

`Runtime.exceptionThrown` 只捕获**未捕获异常**。而 `console.warn` / `console.error` 走的是 `Runtime.consoleAPICalled`——**从未被订阅**。

**第三段：被测代码故意把故障转成 `console.warn`**

```javascript
// prototypes/_selection/prompt-copy.js:1801-1808
window.onBenchRender = function (ctx) {
  try {
    renderTemplateLayer(ctx || {});
  } catch (e) {
    /* 模板层坏掉不能连累 30 个案的主清单：吞掉异常并在 console 留痕。 */
    if (window.console) console.warn("[模板层] 渲染失败：" + (e && e.message));
  }
};
```

**三段合起来**：模板层故障 → 被 `try/catch` 吞掉 → 走 `console.warn` → CDP 没订阅这个通道 → `consoleErrors` 为空 → `10_errors: []` → exit 0 → 报告写"无控制台异常"。

**这是"防护的防护"失效**：代码作者**有意识地**做了一件事（用 warn 而不是 throw，避免影响主清单），而验证工具有意识地只看 throw。**两个各自合理的设计，组合起来是致命盲区。**

### 实测

agent 把模板层整个掐死（`onBenchRender` 直接 return）后跑原版脚本：

```
2_search_restaurant | rows= 0 | stripVisible= false | stripTpls= [] | emptyTplCards= []
5_chip_coffee      | rows= 4 | stripVisible= false | stripTpls= [] | emptyTplCards= []
10_errors = []
EXIT=0
```

对照组（未注入）：

```
2_search_restaurant ... emptyTplCards= ["M02"]
5_chip_coffee      ... stripVisible= true, stripTpls= ["M02"]
EXIT=0
```

**故障态与正常态的唯一区别是两个空数组，退出码都是 0。**

---

## 2. 其余 HIGH

### H2 · `consistency.mjs:45` 的正则在匹配一个从不出现的字符串

```javascript
if (r.stripTpls.length && /有别的一个/.test(r.stripLead)) bad.push({ ... "数量词错误" });
```

而被测代码生成的是「另有**一个**」（`prompt-copy.js:1688-1690`）。全仓搜 `有别的一个`：**唯一命中就是这条断言自身**。

**这条断言永远为 false，`数量词错误` 分支是死代码**，它要抓的那类缺陷（句子里的数量词与实际卡片数不符）完全没有守卫。

> 这正好是框架 4.6 节「标识符对账」要抓的形态——只是这里的标识符是一个**正则字面量**。**对账的对象应当扩展到"用于匹配的字符串常量"。**

### H3 · S03 的交付证据 19/19 PASS，实跑是 18/19 FAIL

| 文件 | 时间戳 |
|---|---|
| `S03-verify.txt`（证据） | 2026-10-16 01:45 |
| `style.css`（被测对象） | 2026-10-20 20:15 |
| `verify.mjs`（脚本） | 2026-10-24 06:31 |

**证据文件比被测代码早 4 天、比脚本早 8 天。** 而且那条 PASS 的断言对象后来被设计**刻意移除**了——`style.css:282-292` 明确注释"阶梯内缩必须在窄屏关掉"，而断言要求窄屏保留 ≥4 个不同缩进值。

实跑：`FAIL narrow-step-indent ... 0px×7`，`18/19`。其余 18 项与证据数值一致，说明**只有这一条漂移**。

### H4 · S03 三条断言"空集即通过"

```javascript
rec('develop-sequence', dev.developed && dev.vis === dev.rows && ...);
rec('reduced-motion', rmState.transforms === 0 && rmState.rowsVisible === rmState.rows && ...);
rec('area-capture', true, '已存 ...png');   // 字面量 true，永真
```

`vis === rows` 在 `rows === 0` 时为真。**断言是"全部满足"（∀）形式，缺"至少有一个"（∃）的存在性前提。**

实测：把 `<tbody>` 的 8 行数据**全删掉**，前两条依然 PASS，总分不变（仍 18/19）。

### H5 · 同一个问题留下四个互斥结论，且其中两个审错了数据集

问题："`palette[0]` 是不是最大面积色？"

| 来源 | 答案 | 数据源 |
|---|---|---|
| `prompt-copy.js:733` | 12/30 | prompts.js |
| `adjudicate-areaanchor.mjs` | 一致 17 / 矛盾 13 | **data.js（错）** |
| `adjudicate-areaanchor2.mjs`（自称"修正版"） | 一致 24 / 矛盾 6 | **data.js（错）** |
| `LEAD-final-areaanchor.mjs` | 是最大 5/30，不是 25 | prompts.js |

`areaanchor.mjs:51` 的表头写"prompt-copy 说的第一个值"，实际读的是 `data.js`；`prompts.js` 的映射表 `pM` 在 `:16` 建好后**再没被使用**（grep `pM` 只有定义处一处）。

**四份都留在交付目录，没有任何一份标注"以谁为准"。** 修复范围会因此差 12 个案子。

---

## 3. MEDIUM / LOW

| 编号 | 严重性 | 一句话 |
|---|---|---|
| M1 | MEDIUM | `check-palette.mjs` 用**写死的 10 色快照**当判据，CSS 新增颜色不会被查；且即使判出禁区色，退出码仍 0 |
| M2 | MEDIUM | `72-plan` 三个脚本**运行即崩溃**（`s.text` 不存在、正则 `null`、路径拼错 `S02/style.css`），其"结论"无法复核 |
| M3 | MEDIUM | `test-specs-guard.mjs` 打印"✗ 守卫静默失效（摆设）"后**仍 exit 0**——**验证守卫是否摆设的脚本自己也是摆设** |
| M4 | MEDIUM | `ab-gate.mjs` 的 R4 变异用例永久失败（对应规则已被删除），脚本每跑必得 2/3 却恒 exit 0 |
| M5 | MEDIUM | `ab-gate.mjs` / `ab-r7.mjs` **直接改写受跟踪文件**，只靠 `finally` 复位；Ctrl-C 会留下坏数据。且 `_chrome_a/` 把 24MB Chrome profile 写进仓库 |
| M6 | MEDIUM | S03 `verify.mjs:8` 用 `resolve('.')` 当服务根，从仓库根跑会加载**错误的 index.html**，报错方向误导 |
| L1–L4 | LOW | 面积解析残缺（和≠100）仍下结论 / 注释与实现不一致 / 同名指标三个口径（33/34/57）/ 15 个脚本硬编码 `D:/Web/style` |

---

## 4. 这一轮给框架的教训

### 4.1 验证脚本本身必须被验证（新增原则）

这个项目有 35 个"验证脚本"，其中至少 **6 个永远 exit 0**、**2 个在检查从不出现的字符串**、**3 个运行即崩溃**。

**核心问题**：框架原来只关心"审计 agent 报的发现是否可信"，**没有关心"项目自带的自检是否可信"**。而当项目自带的自检靠不住时：
- 开发者以为"跑过 verify 了"
- 审计 agent 如果采信那些脚本的结论，会把假的绿灯当真

**新规则建议**（写进 `wave2-audit.md`）：

```
若被审项目自带验证/检查脚本，审计 Agent 必须抽验至少 N 个：
  a) 脚本是否有非零退出码路径？（grep process.exit / throw / assert）
  b) 断言是否可能空转？（"全部满足"缺存在性前提、"字面量 true"）
  c) 断言的目标字符串/标识符是否真实存在？（对账，见 4.6 节）
  d) 注入一个已知故障，脚本是否变红？（变异验证）
凡 (a)(b)(c) 任一不通过的脚本，其历史 PASS 结论一律不得采信。
```

**最关键的是 (d)**：前三条都能靠静态读出来，但"注入故障看它是否变红"才是唯一能证明检查有效的办法。**这个项目里 `ab-gate-r6.mjs` 和 `ab-r7.mjs` 就是 3/3 有效的，说明作者知道该怎么做，只是没推广到全部。**

### 4.2 "防护的防护"失效是独立的失效模式

H1 的成因值得单独记：

- 被测代码作者**有意识地**把异常降级成 `console.warn`（为了不影响主流程）——这个决定是对的；
- 验证工具作者**有意识地**只订阅 `exceptionThrown`（因为那才是"异常"）——这个决定看起来也对；
- **两者组合，形成一个谁都没预料到的盲区。**

**教训**：当"降级处理"与"只检测失败"两个设计相遇时，降级会被误判为正常。**框架应当要求：凡代码里有 `catch` 后转日志的地方，验证必须显式检查该日志通道。** 这与 `evidence-policy` 第 3 节"异常被抛出不等于会传播"是同一条原则的延伸——**异常被捕获也不等于被记录**。

### 4.3 交付证据必须有时间戳校验

H3 是典型的"过期证据"：证据文件比被测代码早 4 天。**一张旧的 PASS 报告会被当成当前状态。**

**新规则**：引用项目自带的验收证据时，**必须比对证据文件与它所验证的代码文件的 mtime**。证据早于被测对象 → 标注 `STALE_EVIDENCE`，不得采信。

---

## 5. 零写入合规

```
起始 / 结束：未跟踪 1841 条，跟踪文件零改动
所有实验在 /tmp/audit_*（仓库外）进行并已清空
服务仅监听 127.0.0.1
```

**关于 `_chrome_a/`（24MB）**：agent 报告它存在并计入泄漏。我复核了创建时间——**2026-10-30 03:31，早于本次会话**，是仓库自带的历史遗留，**不是本轮造成的**。已在报告中如实注明。
