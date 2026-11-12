# U1 代码审计报告

审计对象：`<HOME>\AppData\Local\Temp\iso-t1\code\`（5 个文件，共 319 行）
审计方式：全量通读 + Node 实际执行验证（每条结论均有可复现实测输出）。

---

## 发现 1
- **file**: src/template.js:118
- **类型**: security
- **严重性**: HIGH
- **问题**: `escapeHtml` 把 `&` 的替换放在最后（第 118 行），而 `<`、`>`、`"`、`'` 的替换在前面。输入 `'<b>&"x"'` → 输出 `'&amp;lt;b&amp;gt;&amp;&amp;quot;x&amp;quot;'`：`<` 先生成 `&lt;`，随后 `&`→`&amp;` 又把 `&lt;` 二次转义成 `&amp;lt;`。结果是所有被转义过的字符在页面上显示为字面量 `&lt;b&gt;`，转义函数对正常文本产生错误输出；若下游再做一次 HTML 解码（常见于双层模板/富文本回填），被转义的内容会还原成原始标签，转义保护失效。
- **依据**: 实测 `escapeHtml('<b>&"x"')` 返回 `&amp;lt;b&amp;gt;&amp;&amp;quot;x&amp;quot;`；`escapeHtml('Tom & Jerry <3')` 返回 `'Tom &amp; Jerry &amp;lt;3'`。正确的转义顺序必须是 `&` 最先替换。

## 发现 2
- **file**: src/template.js:96
- **类型**: security
- **严重性**: HIGH
- **问题**: `renderInline` 直接把插值结果 `String(v)` 拼进输出，不做任何 HTML 转义；`escapeHtml` 虽在同一文件第 112 行导出、`index.js` 也 re-export，但全仓库（grep）无任何调用点，属于死代码。任何经 `{{name}}` 渲染的用户输入都会原样进入 HTML。输入 `{name:'<img src=x onerror=alert(1)>'`} → 输出 `<li><img src=x onerror=alert(1)></li>`，即存储型 XSS。`index.js:renderListView` 走的就是这条路径，列表页直接中招。
- **依据**: `grep -rn escapeHtml src/` 仅命中定义与 export，无调用；实测 `compile('<li>{{name}}</li>')({name:'<img src=x onerror=alert(1)>'})` 原样输出标签；`renderListView('<ul>...{{name}}...</ul>', [{name:'<script>alert(1)</script>'}])` 返回的 html 中含未转义 `<script>`。

## 发现 3
- **file**: src/template.js:77
- **类型**: logic
- **严重性**: HIGH
- **问题**: `findMatchingClose` 的自增判据写成 `openTag === closeTag.replace("/","#")`。对 `{{#if ` 而言 `closeTag.replace("/","#")` 得到 `{{#if}}`（`/` 换成 `#` 后变成 `#if}}`，且少了尾随空格），永远不等于 `openTag`，因此 `depth` 永不递增，函数在遇到第一个内层闭合标签时就返回。后果一：**嵌套的同类块解析错位，本不该输出的内容被输出**——`{{#if a}}SECRET{{#if b}}B{{/if}}REST{{/if}}` 在 `a=0`（条件为假）时输出 `"REST{{/if}}"`，把假分支内的 `REST` 泄漏到页面，并残留裸 `{{/if}}`；在 `a=1,b=0` 时输出 `"SECRET{{#if b}}BREST{{/if}}"`，模板语法原样漏到 HTML。后果二：`{{#each xs}}[{{#each ys}}{{this}}{{/each}}]{{/each}}` 在 `xs=[{ys:[1,2]}]` 下输出 `"[{{#each ys}}{{this}}]{{/each}}"`，内层循环完全不执行。
- **依据**: 实测：`{{#if a}}SECRET{{#if b}}B{{/if}}REST{{/if}}` → `a=0,b=0` 得 `"REST{{/if}}"`，`a=1,b=0` 得 `"SECRET{{#if b}}BREST{{/if}}"`，`a=1,b=1` 得 `"A{{#if b}}BC{{/if}}"` 形式错位；嵌套 each 得 `"[{{#each ys}}{{this}}]{{/each}}"`；三层嵌套 each 输出 `"{{#each b}}{{#each c}}{{this}}{{/each}}{{/each}}"`。对照：同文件 base 版本（仅 `o !== -1 && o < c`）对同样输入 `a=0,b=0` 正确返回 `""`，嵌套 each 正确返回 `"[12]"`，证明是该判据引入的缺陷。

## 发现 4
- **file**: src/pagination.js:15
- **类型**: logic
- **严重性**: HIGH
- **问题**: `const safePage = Number.isInteger(page) ? page : 1;` 只校验了整数，未排除 `<= 0`。负页码会一路传到 `offset = (clamped - 1) * pageSize` 变成负数，再被 `paginateArray` 的 `items.slice(offset, offset+limit)` 当作「从尾部倒数」的语义执行，返回**错误且不可预测的一页数据**，同时对外报告 `page` 为负数、`hasPrev=false`。输入 `page=-1, pageSize=5`（数组 1..12）→ `page=-1, offset=-10, items=[3,4,5,6,7]`；`page=0` → `offset=-5, items=[]`；`page=-2` → `items=[1,2]`。任何由 URL 查询串直接透传的 `page` 都会命中，属于可从外部触发的逻辑错误。`paginate(12,-5,5)` 的 offset 为 `-30`。
- **依据**: 实测 `paginateArray([1..12], -1, 5)` 返回 `page:-1, offset:-10, items:[3,4,5,6,7]`；`-2` 返回 `[1,2]`；`0` 返回空数组。正确写法应为 `Number.isInteger(page) && page >= 1`。

## 发现 5
- **file**: src/events.js:64
- **类型**: error-handling
- **严重性**: HIGH
- **问题**: `emit` 收集了所有监听器异常到 `errors`，但只有 `errors.length > 1` 才抛 `AggregateError`；**恰好 1 个监听器抛错时异常被完全吞掉**，`emit` 正常返回。这与第 50 行注释承诺的「错误会在全部执行完后一起抛出」直接矛盾，调用方无法感知监听器失败，故障静默传播。输入：注册 1 个 `throw new Error('boom-single')` 的监听器后 `emit('x')` → 返回 `1`，无任何异常抛出。这也破坏了异常契约：1 个错抛原值、≥2 个错抛 `AggregateError`（当前代码连这个分支一致性也没有了）。
- **依据**: 实测单监听器抛错：`emit` 返回 `1`，「NO ERROR THROWN」；两监听器抛错：抛 `AggregateError: 2 handlers failed for "y"`，`errors` 为 `['a','b']`。对照 base 版本存在 `if (errors.length === 1) throw errors[0];`，该行在当前代码中已缺失。

## 发现 6
- **file**: src/events.js:32
- **类型**: data-consistency
- **严重性**: MEDIUM
- **问题**: `#onceWrappers` 以**原始 handler 函数**为键，`once` 每次注册都会 `set(handler, wrapper)`，所以同一个 handler 对多个事件注册 `once` 时，前一次映射被覆盖，只保留最后一次的 wrapper。此后对先注册的事件调用 `off(event, handler)`：`#onceWrappers.get(handler)` 命中的是**另一个事件的 wrapper**，`indexOf` 在目标事件的列表里找不到 → 返回 `false`，监听器**无法移除**（泄漏）。输入：`once('a', g); once('b', g); off('a', g)` → 返回 `false`，`a` 的监听器数量仍为 1。同一缺陷还会在用 `removeAll` 清空后用 `on` 重新注册同一 handler 时复现：残留映射导致 `off` 继续失效。
- **依据**: 实测 `b2.once('a',g); b2.once('b',g); b2.off('a',g)` 返回 `false`，`listenerCount('a')` 与 `listenerCount('b')` 均为 1；`once('ev',h) → removeAll('ev') → on('ev',h) → off('ev',h)` 返回 `false`，计数仍为 1。

## 发现 7
- **file**: src/validate.js:8
- **类型**: logic
- **严重性**: MEDIUM
- **问题**: `number` 规则只判断 `typeof v === 'number'`，`NaN` 与 `Infinity` 都是 `'number'` 类型，因此全部通过校验。`integer` 规则用 `Number.isInteger`，`Infinity` 也被拒，二者行为不一致，容易让调用方以为数值已合法。输入 `{n: NaN}` 或 `{n: Infinity}` 配 `[{rule:'number'}]` → `{valid:true, errors:{}}`。若后续用该值做金额/数量/除数运算，会得到 `NaN` 或溢出结果。
- **依据**: 实测 `validate({n:NaN},{n:[{rule:'number'}]})` → `{"valid":true,"errors":{}}`；`validate({n:Infinity},{n:[{rule:'number'}]})` → `{"valid":true,"errors":{}}`；同一值走 `integer` 规则则被拒。对照 base 版本含 `&& !Number.isNaN(v)`，当前代码已移除。

## 发现 8
- **file**: src/validate.js:37
- **类型**: security
- **严重性**: MEDIUM
- **问题**: `errors` 用普通对象字面量 `{}` 承载、并以 schema 字段名为键直接读写。当字段名为原型链上的名字时：`constructor`（以及 `toString`/`valueOf`/`hasOwnProperty`）在 `{}` 上天然存在且为真值，`if (!errors[field])` 判定为「已初始化」而不建数组，随后 `errors[field].push(...)` 抛 `TypeError: errors[field].push is not a function`，**整个校验流程崩溃**（对 `{constructor:''}` 这类合法表单数据即可触发）。字段名为 `__proto__` 时（例如 schema 来自 `JSON.parse` 的外配置），校验结果被静默丢弃：`validate({}, {'__proto__':[{rule:'required'}]})` 返回 `valid:true`——**本该失败的必填校验被判为通过**。
- **依据**: 实测 `validate({constructor:''},{constructor:[{rule:'required'}]})` 抛 `TypeError: errors[field].push is not a function`；`toString`/`valueOf`/`hasOwnProperty` 同样崩溃；`validate({}, JSON.parse('{"__proto__":[{"rule":"required"}]}'))` 返回 `{"valid":true,"errors":{}}`，`Object.keys(errors)` 为空。

## 发现 9
- **file**: src/pagination.js:37
- **类型**: data-consistency
- **严重性**: LOW
- **问题**: `paginateArray` 用 `items.slice(...)` 返回页数据，是浅拷贝，页内元素与源数组共享同一批对象引用。调用方按「拿到的是一份分页快照」的直觉修改 `result.items[i].xxx` 时，源数组元素会被同步改写。输入 `src=[{n:1},{n:2},{n:3}]; const p=paginateArray(src,1,2); p.items[0].n=999;` → 源数组首元素变成 `{n:999}`。
- **依据**: 实测修改 `p.items[0].n=999` 后 `src` 为 `[{"n":999},{"n":2},{"n":3}]`。若该模块的分页结果会被多方消费或用于并发渲染，此别名关系会导致数据在无显式赋值的情况下被改动；如需隔离应在文档中明确或改为深拷贝/只读视图。
