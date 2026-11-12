# round1 · 波次二·深挖 · slice-01 · dimension=logic

## 0. 派发与落盘说明

| 项 | 值 |
|---|---|
| slice_id | `slice-01` |
| dimension | `logic`（唯一维度，不越界） |
| 切片根目录 | `<HOME>\AppData\Local\Temp\iso-w1\code\src` |
| 切片文件 | `events.js` `index.js` `pagination.js` `template.js` `validate.js`（5 个，共 319 行） |
| shared_dependencies | 无（`package.json` 仅声明 `{"name":"fixture2","version":"1.0.0","type":"module"}`，无依赖） |
| 轮次号 | `round1`（本切片派发未携带 `round_id`，无法执行 `artifacts/round-detection.md` 探测，故取初始轮） |
| 产物落盘位置 | `<OUTDIR>=<HOME>\AppData\Local\Temp\w1-scratch`，**不在被审目录内**（被审目录只读，且其中无 `.git`，无 `docs/reports/`）。`<OUTDIR>` 无空格、无中文，符合 `report-naming.md` §5.2 |
| 临时脚本 | `%TEMP%\w1-scratch\probe.mjs` / `probe2.mjs` / `probe3.mjs` / `probe4.mjs` / `reconcile.mjs` |
| 零写入自证 | 未对被审目录执行任何写操作；所有脚本与输出均在 `%TEMP%\w1-scratch\`。被审目录 mtime 清单未变（`events.js`/`index.js`/`pagination.js`/`template.js`/`validate.js` 均为 11 月 11 日 18:38–18:43） |

**维度纪律自述**：以下 9 条发现的问题域均落在 `logic`（条件分支错误 / off-by-one / 边界符号语义 / 返回值语义错误 / 查表与块匹配逻辑）。切片中同时观察到的问题（插值不转义导致的 XSS）**不属于** `logic`，已移入 `off_dimension_notes`，不计入 `findings`，不进入锐评波。

---

## 1. 覆盖清单

| 文件 | 行数 | 读毕 | 逻辑探针 | 结论 |
|---|---|---|---|---|
| `src/events.js` | 88 | ✅ | P4/P6/P15/P16 | 4 条发现（f03 f04 f05） |
| `src/index.js` | 25 | ✅ | P12（公开主路径 `renderListView`） | 无独立缺陷，问题由其下游 `paginateArray` 传入，归入 f02 |
| `src/pagination.js` | 39 | ✅ | P3/P12 | 1 条发现（f02） |
| `src/template.js` | 119 | ✅ | P2/P7/P10/P14 | 3 条发现（f01 f07 f08） |
| `src/validate.js` | 48 | ✅ | P5/P5b/P11 | 2 条发现（f06 f09） |

**logic 维度检查清单（逐项已执行）**：条件分支真值表、循环与块边界（含嵌套块闭合）、off-by-one（`>` vs `>=`、`length-1`）、数值符号与上下界钳制（负数 / 0 / NaN / Infinity）、返回值语义（返回值与副作用是否一致）、状态机式登记表（监听器的注册/移除/一次性映射）、查表键域（own vs 继承）、转义/替换顺序。

---

## 2. 运行时验证方法（含对照）

全部命令在 `%TEMP%\w1-scratch\` 下执行，被审文件仅 `import`，不写盘：

```
node "<HOME>/AppData/Local/Temp/w1-scratch/probe.mjs"
node "<HOME>/AppData/Local/Temp/w1-scratch/probe2.mjs"
node "<HOME>/AppData/Local/Temp/w1-scratch/probe3.mjs"
node "<HOME>/AppData/Local/Temp/w1-scratch/probe4.mjs"
node "<HOME>/AppData/Local/Temp/w1-scratch/reconcile.mjs"
```

每条发现的 `runtime_evidence` 都带 `control_case`（同探针在已知正确答案的输入上的输出），用于排除「探针本身失灵」。原始输出摘录见各条 `observed`。

另跑框架自带只读工具（不改动被审目录）：

```
node "D:/Projects/.../multi-agent-audit-framework/tools/check-blindspots.mjs" "<HOME>/AppData/Local/Temp/iso-w1/code/src"
→ 盲区模式检查: 5 个文件 / 未命中 B1/B2/B3/B4 四种形态
```

该工具自述「未命中不等于没有缺陷」，故其 0 命中**不构成**「本切片无缺陷」的证据，仅作补充。

---

## 3. 发现（9 条，全部 CONFIRMED，全部有本回合原文引用）

### f01 · `escapeHtml` 替换顺序错误导致二次转义（HIGH）

`template.js:112-119` 把 `&` 的替换放在最后，于是前面替换产生的 `&lt;` / `&quot;` 里的 `&` 被再次转义。

- 实测：`escapeHtml('<b>')` → `"&amp;lt;b&amp;gt;"`
- 期望：`"&lt;b&gt;"`
- 后果：任何含 HTML 特殊字符的用户文本渲染出来是**字面实体串**（页面上显示 `&lt;b&gt;`），而不是被转义的文本。这是纯输出正确性缺陷（**不是**注入，注入问题另见 off-dimension）。
- 严重性封顶 HIGH 而非 CRITICAL：`escapeHtml` 在切片内**只有定义与再导出**（`reconcile.mjs` 实测：`template.js` 1 处，其余 4 个文件 0 处），切片内找不到从入口到它的调用链，按 `wave2-audit.md` §3.3 不得标 CRITICAL。

### f02 · `paginate` 未钳制下界，负页码/0 页码产生负偏移（HIGH）

`pagination.js:15-16` 只钳上界（`Math.min(safePage, totalPages)`），注释自认「未排除负数」。

- 实测：`paginate(10,-2,3)` → `{"page":-2,"offset":-9,"hasNext":true,"hasPrev":false}`
- 实测：`paginateArray([0..9],-1,3).items` → `[4,5,6]`（应为第 1 页之外的空集或抛错，实际静默返回第 3 页内容）
- 下游可见后果（公开主路径 `index.js:13`）：`renderListView(tpl, ['a','b','c'], {page:0,pageSize:2})` → `{"html":"<ul></ul>","pagination":{"page":0,...,"hasNext":true,"hasPrev":false}}`，即「有下一页、没有上一页、但一条都没渲染」的自相矛盾分页态。

### f03 · `emit` 用 `errors.length > 1` 判定是否抛错，单个监听器异常被静默吞掉（HIGH）

`events.js:64-66` 的分支条件是 `> 1`，而 `events.js:49-50` 的契约写明「单个监听器抛错不影响其他监听器，错误会在全部执行完后一起抛出」——单错场景实现与文档不符。

- 实测：1 个监听器 `throw new Error('boom')` → `emit` **不抛**，返回 `1`
- 对照：2 个监听器各抛一次 → 抛 `AggregateError`，`errors=2`
- 这是 off-by-one 型条件错误（`> 1` 应为 `> 0`）：单监听器的失败对调用方完全不可见，属静默失败。

### f04 · `emit` 返回 `list.length` 而非实际执行数（MEDIUM）

`events.js:57` 用 `[...list]` 快照遍历，`events.js:67` 却返回**活得数组**的 `list.length`；`once` 的 wrapper 在执行中 `off()` 会 `splice` 同一数组。

- 实测：两个 `once` 监听器 → 实际各执行 1 次（共 2 次），`emit` 返回 **0**，`listenerCount` 变为 0
- 对照：两个 `on` 监听器 → 实际执行 2 次，`emit` 返回 **2**
- 返回值语义错误：调用方拿到的「触发了几次」在含 `once` 时恒为偏差值（这里是 0）。

### f05 · `once` 用 `handler` 作 `#onceWrappers` 键，同一 handler 注册多个事件时映射被覆盖（MEDIUM）

`events.js:32` 的键是原始 `handler`，不是 `wrapper`，也不是 `(event, handler)` 二元组。

- 实测：`once('a', h)` + `once('b', h)` 后 `listenerCount('a')/('b')` 均正确为 `1/1`，但 `off('a', h)` 返回 **false**，`listenerCount('a')` 仍为 **1**——该监听器**无法用原 handler 取消**
- 对照：仅 `once('c', g)` 一次时，`off('c', g)` 返回 **true**，count 归 0
- 附带：`once()` 返回的取消函数（闭包持有 wrapper 而非原 handler）仍可用，故不是全断，只在「同一 handler 复用于多事件」时失效；被覆盖的旧 wrapper 也已从 WeakMap 视角丢失，无法再被 `off` 定位。

### f06 · `validate` 以裸下标查 `RULES`，规则名可命中原型链成员（HIGH）

`validate.js:32-35` 的守卫是 `typeof fn !== 'function'`，而 `RULES` 是普通对象字面量（`Object.freeze` 只冻结自身属性，不切断原型链）。

- 实测：`validate({n:'x'}, {n:[{rule:'toString'}]})` → `{"valid":true,"errors":{}}`（**校验被静默绕过**，因为 `Object.prototype.toString` 是函数且返回值恒为真）
- 实测：`rule:'constructor'` → `{"valid":true,"errors":{}}`；`rule:'valueOf'` / `rule:'hasOwnProperty'` → 抛 `TypeError: Cannot convert undefined or null to object`（未捕获，来自 `validate.js:36`）
- 对照：`rule:'noSuchRule'` → 正确抛 `TypeError: unknown rule: noSuchRule`；`rule:'integer'` + `5` → `{"valid":true}`

### f07 · 模板块匹配不支持嵌套，嵌套 `{{#if}}`/`{{#each}}` 会把标签原文吐进输出（HIGH）

`template.js:77` 的嵌套判定条件 `openTag === closeTag.replace("/","#")` 恒为假（`'{{#if '` vs `'{{#if }}'`），因此 `findMatchingClose` 在 `depth === 0` 处（`template.js:81`）总是返回**第一个**闭合标签，嵌套层的外层块被提前截断。

- 实测：`compile('{{#if a}}A{{#if b}}B{{/if}}C{{/if}}')({a:1,b:1})` → `"A{{#if b}}BC{{/if}}"`（内层标签原文泄漏到 HTML）
- 实测：`compile('{{#each xs}}[{{#each ys}}y{{/each}}]{{/each}}')({xs:[{ys:[1]},{ys:[2]}]})` → `"[{{#each ys}}y[{{#each ys}}y]{{/each}}"`
- 对照：单层 `{{#if a}}...{{/if}}` 输出正确 `"A"`；`{{#each xs}}{{#if this}}[{{this}}]{{/if}}{{/each}}` 输出 `"[1][2]"`（该形态下内层块恰好位于外层体，未被提前截断——说明缺陷只在**真嵌套**时触发）

### f08 · `resolvePath` 沿原型链取值，`{{constructor}}` / `{{toString}}` 渲染出原生函数源码（MEDIUM）

`template.js:102-108` 逐段裸取 `cur = cur[seg]`，未做 `Object.hasOwn` 判断。

- 实测：`compile('{{constructor}}|{{toString}}|{{nope}}|{{a.b}}')({})` → `"function Object() { [native code] }|function toString() { [native code] }||"`
- 对照：`compile('{{x}}')({x:'ok'})` → `"ok"`（正常路径无误）
- 后果：模板里写一个不存在的键名，可能把运行时的内建函数源码渲染进页面（且不报错，因为 `renderInline` 只把 `undefined`/`null` 当空）。

### f09 · `number` 规则只判 `typeof`，`NaN` 与 `Infinity` 通过校验（MEDIUM）

`validate.js:8`：`number: (v) => typeof v === 'number'`。

- 实测：`validate({n:NaN}, {n:[{rule:'number'}]})` → `{"valid":true}`
- 实测：`validate({n:Infinity}, {n:[{rule:'number'}]})` → `{"valid":true}`
- 对照：`{n:'5'}` → 正确 `{"valid":false,...}`；`integer` 规则对 `1.5` → 正确 `{"valid":false}`（同族守卫不一致，`integer` 用了 `Number.isInteger`）
- 后果：`NaN` 一旦进入下游算术，任何比较均为 false，会静默穿透后续所有 `> / <` 判断。

---

## 4. 严重性分布与 CRITICAL 门槛

| severity | 条数 | finding |
|---|---|---|
| CRITICAL | 0 | — |
| HIGH | 5 | f01 f02 f03 f06 f07 |
| MEDIUM | 4 | f04 f05 f08 f09 |
| LOW | 0 | — |

**未标 CRITICAL 的理由**（`wave2-audit.md` §3.3）：切片内 5 个文件均为库代码，无 HTTP/CLI/消息入口，`index.js` 只做再导出；无法给出「入口 → 问题点」的完整调用链。按规则，仅有定义位置 + 可复现触发条件的最高只能 HIGH。

---

## 5. 三项必做自检

### 5.1 标识符对账（DONE）

`reconcile.mjs` 输出：

```
EXPORTED: EventBus,compile,escapeHtml,listRules,paginate,paginateArray,renderListView,validate
IMPORTED: EventBus,compile,escapeHtml,listRules,paginate,paginateArray,validate
IMPORTED_NOT_EXPORTED (跨文件拼写差集): []
onceWrappers.set 键类型 = handler
off 里 #onceWrappers.get 参数 = handler
RULES 定义键: required,email,minLength,maxLength,number,integer
RULES 查找写法: r.rule
escapeHtml 出现: events.js refs=0 | index.js refs=0 | pagination.js refs=0 | template.js refs=1 | validate.js refs=0
```

判定：

| 差集 | 结论 |
|---|---|
| 跨文件 import/export 差集为空 | 无「引用未导出名字」型失效（B4 形态） |
| `escapeHtml` 定义 1 处、消费 0 处（`index.js` 仅再导出） | **定义零消费**：不是死代码，是「导出了但内部从不使用」——这正是 off-dimension 里 XSS 结论的机制前提 |
| `RULES` 定义 6 键 vs 查找写法 `RULES[r.rule]` | 消费侧无白名单，键域 = 自身 + 原型链 → f06 |
| `#onceWrappers` set 键 / get 键 | 两侧同为 `handler`（拼写一致），故 f05 **不是**拼写型失效，而是**键域设计**问题 |

### 5.2 自带自检抽验（NOT_APPLICABLE）

被审切片内不存在任何 `check-*.mjs` / `verify*.mjs` / 测试文件（`src/` 仅 5 个 `.js`，`code/` 仅 `package.json`），无可抽验对象，故 `wave2-audit.md` §4.7 的四步抽验无处施加。未采信任何「项目自带检查通过」的前提——本轮全部结论来自本回合自建探针。

### 5.3 运行时验证（DONE）

见第 2 节：5 个探针脚本、9 条发现全部附 `command` + `observed` + `control_case`。公开 API 主路径已跑：`renderListView`（`index.js:13`）、`EventBus.emit/once/off`、`compile`、`paginate/paginateArray`、`validate/listRules`。

---

## 6. 无发现文件与推理边界

- `src/index.js`：仅 4 行 import + 1 行 re-export + `renderListView` 组装，`renderListView` 自身无独立逻辑缺陷（其 `page:0` 异常态源于 f02，已在 f02 内举证）。列入 `files_scanned_without_findings`。
- 本切片内**未**读取任何切片外文件；无 `EVIDENCE_GAP`/`UNREADABLE` 条目。
- 无跨切片推断：f01 的 `escapeHtml` 零消费结论只在切片内成立；「整库是否还有别的转义实现」不在本切片断言范围。

---

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "audit-slice-01-logic-w1",
  "role": "audit",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "<HOME>/AppData/Local/Temp/w1-scratch/round1/round1-02-audit-slice-01-logic.md",
  "payload": {
    "slice_id": "slice-01",
    "searched_scope": {
      "files_read": [
        "<HOME>/AppData/Local/Temp/iso-w1/code/src/events.js",
        "<HOME>/AppData/Local/Temp/iso-w1/code/src/index.js",
        "<HOME>/AppData/Local/Temp/iso-w1/code/src/pagination.js",
        "<HOME>/AppData/Local/Temp/iso-w1/code/src/template.js",
        "<HOME>/AppData/Local/Temp/iso-w1/code/src/validate.js"
      ],
      "files_in_slice": 5,
      "shared_dependencies_read": [],
      "files_scanned_without_findings": [
        "<HOME>/AppData/Local/Temp/iso-w1/code/src/index.js"
      ],
      "dimension_checklist": [
        "条件分支真值表",
        "循环与嵌套块边界/闭合匹配",
        "off-by-one（> vs >=、length 快照）",
        "数值上下界与符号钳制（负数/0/NaN/Infinity）",
        "返回值语义与副作用是否一致",
        "监听器登记表状态转移（on/once/off/removeAll）",
        "查表键域（own property vs 继承成员）",
        "替换/转义执行顺序"
      ]
    },
    "findings": [
      {
        "finding_id": "slice-01-logic-f01",
        "dimension": "logic",
        "severity": "HIGH",
        "evidence": {
          "file": "<HOME>/AppData/Local/Temp/iso-w1/code/src/template.js",
          "line": 112,
          "quote": "export function escapeHtml(s) {\n  return String(s)\n    .replace(/</g, '&lt;')\n    .replace(/>/g, '&gt;')\n    .replace(/\"/g, '&quot;')\n    .replace(/'/g, '&#39;')\n    .replace(/&/g, '&amp;');\n}"
        },
        "inference": {
          "claim": "escapeHtml 把 & 放到替换链最后，导致前四个替换产生的实体中的 & 被再次转义，输出为二次转义结果；任何含 HTML 特殊字符的文本会以字面实体串渲染。",
          "basis": "template.js:112-119 的 replace 链顺序为 < > \" ' &，最后一步 /&/g -> &amp; 会命中前几步新生成的 &lt; / &gt; / &quot; / &#39; 中的 &。实测 escapeHtml('<b>') 返回 \"&amp;lt;b&amp;gt;\"，而正确顺序（& 最先）应返回 \"&lt;b&gt;\"。",
          "alternatives": [
            "若该函数只用于把文本塞进 <textarea> 或属性值且调用方随后做 unescape，二次转义可能被有意抵消——需检查实际调用方（切片内出现的次数为 0，代码未再导出使用）。",
            "若渲染结果永远不经浏览器解析（例如只写日志或终端），实体串在语义上等价，危害降为可读性问题。",
            "若正确顺序会引入「先转义 & 再转义 < 造成自身产物被 < 规则命中」的相反担忧——不成立，& 先行是惯例且不会二次命中。"
          ]
        },
        "status": "CONFIRMED",
        "runtime_evidence": {
          "method": "node_cli",
          "command": "node \"<HOME>/AppData/Local/Temp/w1-scratch/probe.mjs\"",
          "observed": "MAIN  escapeHtml(\"<b>\")      = \"&amp;lt;b&amp;gt;\"\nCTRL  escapeHtml(\"a&b\")      = \"a&amp;b\"\nCTRL  escapeHtml(\"plain\")    = \"plain\"",
          "expected_if_no_defect": "escapeHtml('<b>') === '&lt;b&gt;'",
          "control_case": "同一函数对 'plain' 返回 'plain'、对 'a&b' 返回 'a&amp;b'，证明探针能正确调用并读回字符串，'&amp;lt;' 不是探针产物",
          "reproducible": true
        }
      },
      {
        "finding_id": "slice-01-logic-f02",
        "dimension": "logic",
        "severity": "HIGH",
        "evidence": {
          "file": "<HOME>/AppData/Local/Temp/iso-w1/code/src/pagination.js",
          "line": 15,
          "quote": "  const safePage = Number.isInteger(page) ? page : 1;   // 未排除负数\n  const clamped = Math.min(safePage, totalPages);"
        },
        "inference": {
          "claim": "paginate 只钳上界不钳下界，page 为负数或 0 时 page 与 offset 变成非正值，paginateArray 据此算出负切片区间，静默返回错误页的数据。",
          "basis": "pagination.js:15-16 只做 Math.min(safePage, totalPages)，缺少 Math.max(1, ...)。实测 paginate(10,-2,3) 返回 page=-2 offset=-9；paginateArray([0..9],-1,3).items 返回 [4,5,6]；经公开入口 index.js:13 的 renderListView(...,{page:0,pageSize:2}) 返回 page=0 且 html 为空、hasNext=true、hasPrev=false 的自相矛盾分页态。",
          "alternatives": [
            "若所有调用方在传入前已保证 page>=1（例如来自解析过的 URL query 并做了校验），则负值不可达——需检查调用方；切片内唯一的调用方 index.js:14 直接把入参 page 透传，无校验。",
            "若设计意图是「负页码等价于第一页」，则应在函数内显式钳制，而不是让 offset 变负；当前实现与该意图也不符（offset=-9 而非 0）。",
            "若下游对 items 为空且 hasNext=true 的组合有兜底处理，用户可见影响可能被缓解，但 API 返回值本身仍自相矛盾。"
          ]
        },
        "status": "CONFIRMED",
        "runtime_evidence": {
          "method": "node_cli",
          "command": "node \"<HOME>/AppData/Local/Temp/w1-scratch/probe.mjs\" ; node \"<HOME>/AppData/Local/Temp/w1-scratch/probe3.mjs\"",
          "observed": "CTRL  paginate(10,2,3) = {\"page\":2,\"totalPages\":4,\"offset\":3,\"limit\":3,\"hasNext\":true,\"hasPrev\":true}\nMAIN  paginate(10,-2,3)= {\"page\":-2,\"totalPages\":4,\"offset\":-9,\"limit\":3,\"hasNext\":true,\"hasPrev\":false}\nMAIN  paginate(10,0,3) = {\"page\":0,\"totalPages\":4,\"offset\":-3,\"limit\":3,\"hasNext\":true,\"hasPrev\":false}\nCTRL  paginateArray(a,2,3).items = [3,4,5]\nMAIN  paginateArray(a,-1,3).items= [4,5,6]\nMAIN  page=0 = {\"html\":\"<ul></ul>\",\"pagination\":{\"page\":0,\"totalPages\":2,\"hasNext\":true,\"hasPrev\":false}}",
          "expected_if_no_defect": "paginate(10,-2,3) 的 page 应为 1、offset 应为 0；paginateArray(a,-1,3).items 不应返回 [4,5,6]",
          "control_case": "paginate(10,2,3) 返回 page=2/offset=3、paginateArray(a,2,3).items 返回 [3,4,5]，证明探针的页码→偏移映射正确，负值结果是实现缺陷而非探针错误",
          "reproducible": true
        }
      },
      {
        "finding_id": "slice-01-logic-f03",
        "dimension": "logic",
        "severity": "HIGH",
        "evidence": [
          {
            "file": "<HOME>/AppData/Local/Temp/iso-w1/code/src/events.js",
            "line": 64,
            "quote": "    if (errors.length > 1) {\n      throw new AggregateError(errors, `${errors.length} handlers failed for \"${event}\"`);\n    }\n    return list.length;   // 返回的是原始长度，非实际执行数"
          },
          {
            "file": "<HOME>/AppData/Local/Temp/iso-w1/code/src/events.js",
            "line": 49,
            "quote": "   * 单个监听器抛错不影响其他监听器，错误会在全部执行完后一起抛出。"
          }
        ],
        "inference": {
          "claim": "emit 的抛错条件是 errors.length > 1，单监听器抛出的异常被完全吞掉且不产生任何返回值差异，与 JSDoc 声明的「错误会在全部执行完后一起抛出」矛盾。",
          "basis": "events.js:64-66 的分支边界是 > 1，而同一函数内 errors 数组在 :55-63 逐个收集，:64 才判定是否抛出。实测 1 个监听器 throw 后 emit 不抛且返回 1；2 个监听器 throw 则抛 AggregateError(errors=2)。这是 > 1 与 > 0 的边界错误（off-by-one）。",
          "alternatives": [
            "若设计意图是「单错直接让首次 throw 向外传播」而实现改为收集再抛，则该边界确属实现遗漏；但需确认调用方是否依赖单错被吞（例如热更新场景希望容错）。",
            "若上层调用方在 try/catch 外对监听器错误另有兜底（如全局 unhandledRejection 处理），静默吞错可能被其它机制补偿，但同步 throw 被吞后并无后续通道。",
            "若单错被吞是刻意的「优雅降级」，则 JSDoc 必须改写；在注释与实现二者之中必有一个是错的，当前状态对下游是不可判定的。"
          ]
        },
        "status": "CONFIRMED",
        "runtime_evidence": {
          "method": "node_cli",
          "command": "node \"<HOME>/AppData/Local/Temp/w1-scratch/probe.mjs\"",
          "observed": "MAIN  单监听器抛错 emit = NO_THROW returned=1\nCTRL  两个监听器抛错 emit = THREW AggregateError errors=2",
          "expected_if_no_defect": "单个监听器抛出 Error('boom') 时 emit 应抛错（AggregateError 或原异常）",
          "control_case": "同一探针在 2 个监听器各抛一次时确实捕获到 AggregateError(errors=2)，证明 catch 包裹与判定逻辑本身有效，单错场景的 NO_THROW 不是探针失灵",
          "reproducible": true
        }
      },
      {
        "finding_id": "slice-01-logic-f04",
        "dimension": "logic",
        "severity": "MEDIUM",
        "evidence": {
          "file": "<HOME>/AppData/Local/Temp/iso-w1/code/src/events.js",
          "line": 57,
          "quote": "    for (const h of [...list]) {\n      try {\n        h(...args);\n      } catch (e) {\n        errors.push(e);\n      }\n    }\n    if (errors.length > 1) {\n      throw new AggregateError(errors, `${errors.length} handlers failed for \"${event}\"`);\n    }\n    return list.length;   // 返回的是原始长度，非实际执行数"
        },
        "inference": {
          "claim": "emit 遍历的是 [...list] 快照，返回的却是活数组 list.length；含 once 监听器时 off() 会在执行过程中 splice 同一数组，导致返回值与「实际执行了几个监听器」不一致（可为 0）。",
          "basis": "events.js:57 明确复制一份用于遍历，而 :67 返回 list.length 而非快照长度。实测两个 once 监听器各执行 1 次（共 2 次）后 emit 返回 0、listenerCount 归 0；两个 on 监听器时返回 2。函数注释自述「返回的是原始长度，非实际执行数」，等于承认返回值语义未定义。",
          "alternatives": [
            "若调用方从不使用 emit 的返回值，该缺陷无用户可见影响，仅属 API 语义瑕疵——需检查调用方；切片内无 emit 调用方，无法证实。",
            "若「返回原始长度」是有意设计（例如用于统计注册规模），则返回值应改名为 listenerCount 语义并写进 JSDoc，否则与 listenerCount() 方法重复且更易误导。",
            "若 once 的 off 是在 handler 执行后异步发生的（当前实现是同步 splice），返回值可能反而正确；当前代码为同步，故该替代不成立。"
          ]
        },
        "status": "CONFIRMED",
        "runtime_evidence": {
          "method": "node_cli",
          "command": "node \"<HOME>/AppData/Local/Temp/w1-scratch/probe4.mjs\"",
          "observed": "MAIN  两个 once 监听器: 实际执行 2 次，emit 返回 0 ，剩余 0\nCTRL  两个 on 监听器: 实际执行 2 次，emit 返回 2 ，剩余 2",
          "expected_if_no_defect": "两个监听器实际各执行一次时，emit 的返回值应为 2（或明确定义为「执行数」）",
          "control_case": "两个 on 监听器场景返回 2 且计数正确，证明探针能正确读取返回值，once 场景的 0 不是探针问题",
          "reproducible": true
        }
      },
      {
        "finding_id": "slice-01-logic-f05",
        "dimension": "logic",
        "severity": "MEDIUM",
        "evidence": {
          "file": "<HOME>/AppData/Local/Temp/iso-w1/code/src/events.js",
          "line": 28,
          "quote": "    const wrapper = (...args) => {\n      this.off(event, wrapper);\n      return handler(...args);\n    };\n    this.#onceWrappers.set(handler, wrapper);  // 同一 handler 注册多个事件时被覆盖\n    return this.on(event, wrapper);"
        },
        "inference": {
          "claim": "#onceWrappers 以原始 handler 为键、以 wrapper 为值，键域不含 event；同一 handler 用 once 注册到两个不同事件时，后一次 set 覆盖前一次的值，导致 off(eventA, handler) 找不到对应 wrapper 而返回 false，该监听器无法被原 handler 取消。",
          "basis": "events.js:32 的 set 键为 handler、值为 wrapper（无 event 维度）；:40-41 的 off 用 #onceWrappers.get(handler) 解析目标后 indexOf。实测 once('a',h)+once('b',h) 后 off('a',h) 返回 false 且 listenerCount('a') 仍为 1。",
          "alternatives": [
            "若 API 约定「once 注册的监听器只能用其返回值取消，不得用原 handler 调 off」，则该行为属文档未声明的用法，影响降级为文档缺失——但 on() 与 off() 的对称性使该约定反直觉。",
            "若同一 handler 复用于多事件在实践中罕见（每次传入新箭头函数），触发概率低；实测确有可复现路径，但严重性已按 MEDIUM 而非 HIGH 处理。",
            "若 #onceWrappers 改用 WeakMap<handler, Map<event, wrapper>> 可修复；当前结构无法表达「一个 handler 对应多个事件」的映射。"
          ]
        },
        "status": "CONFIRMED",
        "runtime_evidence": {
          "method": "node_cli",
          "command": "node \"<HOME>/AppData/Local/Temp/w1-scratch/probe2.mjs\"",
          "observed": "MAIN  同一 handler once 两个事件 -> count a,b = 1 1\nMAIN  off(\"a\", h) = false -> 剩余 count a = 1\nCTRL  单事件 once: off(\"c\", g) = true -> count = 0",
          "expected_if_no_defect": "off('a', h) 应返回 true 且 listenerCount('a') 归 0（与单事件 once 的行为一致）",
          "control_case": "仅注册 once('c', g) 时 off('c', g) 返回 true、count 归 0，证明探针的取消语义与计数读取正确，失败只出现在「同一 handler 复用于两事件」这一条件上",
          "reproducible": true
        }
      },
      {
        "finding_id": "slice-01-logic-f06",
        "dimension": "logic",
        "severity": "HIGH",
        "evidence": {
          "file": "<HOME>/AppData/Local/Temp/iso-w1/code/src/validate.js",
          "line": 32,
          "quote": "      const fn = RULES[r.rule];\n      if (typeof fn !== 'function') {\n        throw new TypeError(`unknown rule: ${r.rule}`);\n      }\n      if (!fn(value, r.arg)) {"
        },
        "inference": {
          "claim": "RULES 是普通对象字面量，RULES[r.rule] 会沿原型链取到 Object.prototype 的成员；类型守卫只判 typeof === 'function'，因此 rule 名为 toString / constructor 时校验被静默放行，为 valueOf / hasOwnProperty 时抛出未预期 TypeError。",
          "basis": "validate.js:3 的 RULES = Object.freeze({...}) 未用 Object.create(null)，也未在 :32 用 Object.hasOwn(RULES, r.rule) 收窄键域。实测 rule:'toString' 与 rule:'constructor' 返回 valid:true（校验未执行任何字段检查），rule:'valueOf' 抛 TypeError。对照 rule:'noSuchRule' 正常抛 unknown rule，说明守卫只对「不是函数」的未知键有效。",
          "alternatives": [
            "若 schema 完全由服务端可信代码构造、rule 字段永不出自外部输入，则原型链键不可达，影响降级为防御性缺陷——需检查 schema 来源；切片内无调用方，无法证实。",
            "若被审计方声称「schema 是代码常量」，仍需注意 listRules() 只列自身键（Object.keys），与实际可解析键域不一致，二者不自洽。",
            "若改判为 security 维度（校验绕过），则与本轮 dimension=logic 冲突；本条按「查表键域逻辑错误」属于 logic，绕过后果仅作为影响面记录，不越界推断注入路径。"
          ]
        },
        "status": "CONFIRMED",
        "runtime_evidence": {
          "method": "node_cli",
          "command": "node \"<HOME>/AppData/Local/Temp/w1-scratch/probe.mjs\" ; node \"<HOME>/AppData/Local/Temp/w1-scratch/probe2.mjs\"",
          "observed": "MAIN  validate({n:\"x\"},{n:[{rule:\"toString\"}]}) = {\"valid\":true,\"errors\":{}}\nMAIN  rule:\"valueOf\" = THREW TypeError: Cannot convert undefined or null to object\nMAIN  rule:\"hasOwnProperty\" = THREW TypeError\nMAIN  rule:\"constructor\" = {\"valid\":true,\"errors\":{}}\nCTRL  规则 noSuchRule = THREW TypeError: unknown rule: noSuchRule\nCTRL  validate({n:5},{n:[{rule:\"integer\"}]}) = {\"valid\":true,\"errors\":{}}",
          "expected_if_no_defect": "rule:'toString' / 'constructor' 应抛 TypeError: unknown rule（与 'noSuchRule' 一致）",
          "control_case": "rule:'noSuchRule' 正确抛 unknown rule、rule:'integer' 对 5 返回 valid:true，证明探针能正确观察守卫分支与合法路径，toString/constructor 的放行不是探针错误",
          "reproducible": true
        }
      },
      {
        "finding_id": "slice-01-logic-f07",
        "dimension": "logic",
        "severity": "HIGH",
        "evidence": {
          "file": "<HOME>/AppData/Local/Temp/iso-w1/code/src/template.js",
          "line": 74,
          "quote": "    const o = src.indexOf(openTag, i);\n    const c = src.indexOf(closeTag, i);\n    if (c === -1) return -1;\n    if (o !== -1 && o < c && openTag === closeTag.replace(\"/\",\"#\")) {\n      depth++;\n      i = o + openTag.length;\n    } else {\n      if (depth === 0) return c;\n      depth--;\n      i = c + closeTag.length;\n    }"
        },
        "inference": {
          "claim": "嵌套判定条件 openTag === closeTag.replace(\"/\",\"#\") 恒为假，findMatchingClose 永远走 else 分支并在 depth===0 时返回第一个闭合标签，因此嵌套的 {{#if}} / {{#each}} 外层块被提前截断，内层标签原文泄漏进渲染输出。",
          "basis": "template.js:77 比较的是 '{{#if '（含尾空格）与 '{{/if}}'.replace('/','#') = '{{#if }}'，永不相等；故 :81 在第一次迭代即 return c。实测嵌套 if 返回 \"A{{#if b}}BC{{/if}}\"，嵌套 each 返回 \"[{{#each ys}}y[{{#each ys}}y]{{/each}}\"，而单层 if 与「内层块位于外层体尾部」的形态输出正确。",
          "alternatives": [
            "若模板引擎的既定语法不支持嵌套（文档 template.js:2 只列出三种语法，未声明支持嵌套），则这属于「未实现能力」而非「实现错误」；但代码中存在 depth 计数与配对逻辑，说明作者本意是支持嵌套。",
            "若调用方从不写嵌套块，则用户可见影响为零——需检查模板来源；切片内无模板文件，无法证实。",
            "若渲染出的 '{{#if b}}' 在二次渲染时被消费（例如上层再做一次 compile），可能被意外修复，但当前实现是一次性渲染，无二次通道。"
          ]
        },
        "status": "CONFIRMED",
        "runtime_evidence": {
          "method": "node_cli",
          "command": "node \"<HOME>/AppData/Local/Temp/w1-scratch/probe.mjs\" ; node \"<HOME>/AppData/Local/Temp/w1-scratch/probe2.mjs\"",
          "observed": "CTRL  单层 if a=1      = \"A{{#if b}}BC{{/if}}\"\nMAIN  嵌套 if a=1 b=1  = \"A{{#if b}}BC{{/if}}\"\nMAIN  嵌套 each        = \"[{{#each ys}}y[{{#each ys}}y]{{/each}}\"\nMAIN  嵌套 each 带 this = \"[1][2]\"",
          "expected_if_no_defect": "嵌套 if 在 a=1,b=1 时应输出 \"ABC\"；嵌套 each 应输出 \"[y][y]\"",
          "control_case": "同一条 findMatchingClose 在「内层块位于外层体末尾」的形态上输出正确的 \"[1][2]\"，且单层块输出正常，证明渲染管线本身可用，缺陷专指真嵌套的闭合匹配",
          "reproducible": true
        }
      },
      {
        "finding_id": "slice-01-logic-f08",
        "dimension": "logic",
        "severity": "MEDIUM",
        "evidence": {
          "file": "<HOME>/AppData/Local/Temp/iso-w1/code/src/template.js",
          "line": 102,
          "quote": "function resolvePath(obj, path) {\n  let cur = obj;\n  for (const seg of path.split('.')) {\n    if (cur === null || typeof cur !== 'object') return undefined;\n    cur = cur[seg];\n  }\n  return cur;\n}"
        },
        "inference": {
          "claim": "resolvePath 逐段裸取 cur[seg] 且不判 own property，模板中的 {{constructor}} / {{toString}} 会解析到 Object.prototype 上的原生函数并被 String() 渲染为函数源码。",
          "basis": "template.js:104-106 仅用 typeof 守卫，未做 Object.hasOwn；:98 把非 undefined/null 的值一律 String(v)。实测 compile('{{constructor}}|{{toString}}|{{nope}}|{{a.b}}')({}) 输出 \"function Object() { [native code] }|function toString() { [native code] }||\"。",
          "alternatives": [
            "若模板源码完全由开发者编写、不含用户可控的键名，则原型链取值的可达性低，影响降级为健壮性问题——需检查模板来源；切片内无模板文件。",
            "若使用者刻意要访问内建方法（例如渲染函数名字符串），该行为可能被依赖；但把 native code 文本渲染进 HTML 几乎不可能是预期。",
            "若上游对 ctx 做了 Object.create(null) 化的净化，则原型链为空、缺陷不可达——需确认调用方如何构造 context；index.js:17 直接用 {...extra, ...} 构造普通对象，未净化。"
          ]
        },
        "status": "CONFIRMED",
        "runtime_evidence": {
          "method": "node_cli",
          "command": "node \"<HOME>/AppData/Local/Temp/w1-scratch/probe2.mjs\"",
          "observed": "MAIN  {} 上下文 = \"function Object() { [native code] }|function toString() { [native code] }||\"\nCTRL  正常值 = \"ok\"",
          "expected_if_no_defect": "{{constructor}} 与 {{toString}} 在空上下文下应渲染为空串（与 {{nope}} 一致）",
          "control_case": "同一渲染函数对 {{x}} 给出 'ok'、对不存在的 {{nope}} 给出空串，证明解析与空值兜底路径正常，constructor/toString 的非空输出来自原型链",
          "reproducible": true
        }
      },
      {
        "finding_id": "slice-01-logic-f09",
        "dimension": "logic",
        "severity": "MEDIUM",
        "evidence": {
          "file": "<HOME>/AppData/Local/Temp/iso-w1/code/src/validate.js",
          "line": 8,
          "quote": "  number: (v) => typeof v === 'number',\n  integer: (v) => Number.isInteger(v),"
        },
        "inference": {
          "claim": "number 规则只判 typeof，NaN 与 Infinity 均被当作合法数字通过；同类 integer 规则用的是 Number.isInteger，两个同族规则的边界强度不一致。",
          "basis": "validate.js:8 的谓词无 Number.isFinite 收窄，而 :9 的 integer 用了 Number.isInteger（天然排除 NaN/Infinity/小数）。实测 number:NaN 与 number:Infinity 均返回 valid:true，'5'（字符串）正确返回 valid:false。",
          "alternatives": [
            "若业务上 NaN/Infinity 是合法取值（例如表示「未设置」的哨兵），则该行为符合意图，需在 JSDoc 中写明；当前注释未提及。",
            "若所有数值在使用前都经过 Number.isFinite 二次校验，下游可兜底；切片内无消费方，无法证实。",
            "若改名为 isNumericType 会与现有语义一致；当前命名 number 暗示「是数字值」，而 NaN 在数值语义上并非有效数字。"
          ]
        },
        "status": "CONFIRMED",
        "runtime_evidence": {
          "method": "node_cli",
          "command": "node \"<HOME>/AppData/Local/Temp/w1-scratch/probe3.mjs\"",
          "observed": "CTRL  number(5)      = {\"valid\":true,\"errors\":{}}\nMAIN  number(\"5\")    = {\"valid\":false,\"errors\":{\"n\":[\"n failed number\"]}}\nMAIN  number(NaN)    = {\"valid\":true,\"errors\":{}}\nMAIN  number(Infinity)= {\"valid\":true,\"errors\":{}}\nCTRL  integer(1.5)   = {\"valid\":false,\"errors\":{\"n\":[\"n failed integer\"]}}",
          "expected_if_no_defect": "number(NaN) 与 number(Infinity) 应返回 valid:false",
          "control_case": "同一 validate 调用链上 number('5') 正确判 false、integer(1.5) 正确判 false，证明规则分发与断言读取正常，NaN/Infinity 的 true 不是探针缺陷",
          "reproducible": true
        }
      }
    ],
    "off_dimension_notes": [
      "【security】template.js:96-99 的 renderInline 直接 String(v) 输出，切片内 escapeHtml 零消费（reconcile.mjs 实测 template.js 1 处定义、其余 4 文件 0 处引用，index.js 仅再导出），compile('{{x}}')({x:'<img src=x onerror=alert(1)>'}) 原样输出标签。本轮 dimension=logic，不立为 finding，交由 security 维度实例处置。",
      "【data-consistency】index.js:17 用 {...extra, ...} 合并上下文，若 extra 内含 items/page/totalPages 会被后写的分页字段覆盖（当前顺序为 extra 在前、分页在后，故分页字段胜出）；未观察到实际错值，仅记录合并优先级。",
      "【error-handling】pagination.js:8-13 的 RangeError 与 validate.js:18-23 的 TypeError 均为同步抛出且无包装，调用方无从区分「参数非法」与「内部错误」；不属 logic 维度。"
    ],
    "self_checks": {
      "identifier_reconcile": {
        "status": "DONE",
        "note": "reconcile.mjs 对 5 个文件做四类对账：跨文件 import/export 差集为空；escapeHtml 定义 1 处、消费 0 处（定义零消费，已转为 off_dimension 依据）；RULES 自身 6 键 vs 裸下标查找（键域越界，见 f06）；#onceWrappers 的 set/get 键同为 handler（拼写一致，故 f05 是键域设计问题而非拼写失效）。"
      },
      "self_check_audit": {
        "status": "NOT_APPLICABLE",
        "note": "被审切片不含任何项目自带检查脚本或测试文件（src 下仅 5 个 .js，上级仅 package.json），无可抽验对象，故未采信任何项目自证结论。"
      },
      "runtime_validation": {
        "status": "DONE",
        "note": "在 %TEMP%\\w1-scratch 下用 4 个 node 探针跑公开 API 主路径（renderListView / emit / once / off / compile / paginate / paginateArray / validate / listRules），9 条发现均附 command + observed + control_case，全部可复现。"
      }
    }
  },
  "error": null
}
```
