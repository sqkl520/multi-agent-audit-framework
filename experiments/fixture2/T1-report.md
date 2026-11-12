# T1 审计报告 — template / events / pagination / validate

- **范围**：`<HOME>\AppData\Local\Temp\iso-t1\code\`，5 个源文件全部逐行读完（template.js 119 行、events.js 88、pagination.js 39、validate.js 48、index.js 25）。
- **方式**：只读审查 + 在 `%TEMP%\audit-t1\` 下写 5 个验证脚本（`verify.mjs` ~ `verify5.mjs`）实际调用并复现。下文每条「证据」均为真实运行输出，不是推断。
- **前提**：目标目录与 `experiments\fixture2\injected\` 完全一致；`base\` 为无缺陷对照组，差异已用 `diff -u` 核对，用于区分「注入缺陷」与「基线既有缺陷」。

## 模式检查结果

| 模式 | 文件 | 命中/未命中/不适用 | 说明 |
|---|---|---|---|
| 1 返回值暴露内部状态 | src/template.js | 未命中 | `compile` 返回的闭包只捕获 `template` 字符串；`render` 返回新字符串；`escapeHtml` 返回新字符串。无内部容器外泄。 |
| 1 返回值暴露内部状态 | src/events.js | 未命中 | `on` 返回的取消闭包持有 `event/handler`，不暴露 `#handlers`；`emit`/`listenerCount`/`removeAll` 只返回数字，`off` 返回布尔。 |
| 1 返回值暴露内部状态 | src/pagination.js | 命中 | `paginate` 返回全新对象（全是原始值），安全；但 `paginateArray` 的 `items: items.slice(...)` 只是**浅拷贝**，元素仍是源数组的同一个引用。实测 `pp.items[0].v = 999` 后 `objs[0].v === 999`。 |
| 1 返回值暴露内部状态 | src/validate.js | 未命中 | `errors` 是每次调用新建的局部对象；`listRules()` 返回 `Object.keys()` 新数组，实测调用方 `push('HACK')` 后再次调用输出不变。`RULES` 未导出。 |
| 1 返回值暴露内部状态 | src/index.js | 未命中 | `renderListView` 返回的 `{html, pagination}` 均为新建对象，`pagination` 是重新挑字段的浅对象，无内部引用。 |
| 2 同族函数守卫一致 | src/template.js | 未命中 | `compile` 校验 template 为 string、内部 render 校验 context；`escapeHtml` 走 `String(s)` 强制转换，属设计选择（对任意输入不抛错），两者不同类，不构成守卫冲突。 |
| 2 同族函数守卫一致 | src/events.js | 命中 | `on` 校验 event + handler；`once` **只校验 handler**，且在 event 校验发生前就写入 `#onceWrappers`（见发现 6）；`off` / `removeAll` 完全不校验 event 类型。实测 `off(123,fn)` 静默返回 `false`、`removeAll({})` 返回 `0`，而 `on(123,fn)` 抛 TypeError。 |
| 2 同族函数守卫一致 | src/pagination.js | 命中 | `total`、`pageSize` 都做了 `Number.isInteger` + 区间校验，唯独 `page` 一个字的校验都没有（`Number.isInteger(page) ? page : 1` 兜底），三者不一致（见发现 4、14）。 |
| 2 同族函数守卫一致 | src/validate.js | 命中 | `data`、`schema`、`rules` 数组都校验了，但数组里的**每个 rule 条目**、以及 `r.arg` 都不校验（见发现 9、10）。 |
| 2 同族函数守卫一致 | src/index.js | 命中 | `paginateArray` 会校验 `items is Array`，但 `renderListView` 对 `options` 不做任何校验：`options = null` 直接抛 `Cannot read properties of null (reading 'page')`，`options = 'abc'` 却被静默接受（见发现 15）。 |
| 3 数值边界校验 | src/template.js | 不适用 | 无「必须是数字」的参数；唯一的数值是比较用的下标，内部自洽。 |
| 3 数值边界校验 | src/events.js | 不适用 | 无数字参数。`listenerCount` 等返回计数，不接收计数。 |
| 3 数值边界校验 | src/pagination.js | 命中 | `total`/`pageSize` 已排除负数与小数，但 `page` 未排除 0/负数/NaN/Infinity/小数，且 `pageSize` 无上限（`1e6` 接受）。实测 `paginate(100,-5,10)` 得 `offset:-60`。 |
| 3 数值边界校验 | src/validate.js | 命中 | `number` 规则只判 `typeof === 'number'`，NaN 和 Infinity 全部放行（`typeof NaN === 'number'`；`NaN <= 0` 为 false）。`minLength`/`maxLength` 的 `arg` 也未排除 NaN / undefined / 负数 / 字符串。 |
| 3 数值边界校验 | src/index.js | 命中 | `renderListView` 的 `page` 直接透传给 `paginateArray`，自身不做任何数值校验。 |
| 4 解析结果形状 | src/template.js | 命中 | context 只判 `typeof === 'object'`：数组被完全接受（实测 `compile('{{0}}')(['a'])` 渲染 `"a"`），而内插值不做类型校验，对象渲染成 `[object Object]`、函数渲染成源码。模板串本身由正则/`indexOf` 解析，块名也不校验形状（`{{#each }}` 取到空串 key，靠巧合工作）。 |
| 4 解析结果形状 | src/events.js | 未命中 | 无 `JSON.parse`、无外部结构解析；`...args` 原样透传。 |
| 4 解析结果形状 | src/pagination.js | 未命中 | 不解析外部结构；`Array.isArray(items)` 已拦住错误形状，`items.length` 为数字，`paginate` 内再校验。 |
| 4 解析结果形状 | src/validate.js | 命中 | `schema` 只判 `typeof === 'object'`，rule 条目形状不校验：`{a:[null]}` 抛 `Cannot read properties of null (reading 'rule')`，`{a:['required']}` 报 `unknown rule: undefined`（都是未受控的内部 TypeError，而非清晰的入参错误）。`JSON.parse('{"__proto__":[...]}')` 会让 `errors` 逻辑炸掉（见发现 8）。 |
| 4 解析结果形状 | src/index.js | 命中 | `page`/`pageSize` 来自解构参数，未做「是数字」的形状校验；对象/字符串/NaN 一律透传。 |
| 5 能力是否真实现 | src/template.js | 命中 | ①`escapeHtml` 注释写「用于用户输入的插值」，但 `renderInline` **从未调用它**，插值原样输出 → XSS；②注释声称支持 `{{#if}}`/`{{#each}}` 嵌套，实际嵌套同类型块完全失效（见发现 2、3）。 |
| 5 能力是否真实现 | src/events.js | 命中 | 注释写「单个监听器抛错不影响其他监听器，错误会在**全部执行完后一起抛出**」，实际**单个**监听器抛错时错误被完全吞掉、不抛也不返回（见发现 5）；`emit` 返回值注释自认「原始长度，非实际执行数」。 |
| 5 能力是否真实现 | src/pagination.js | 命中 | 注释承诺 `page:number` 与 `hasNext/hasPrev`；负页时 `hasNext` 恒为 true、`offset` 为负，分页能力实际输出错误窗口（发现 4）。 |
| 5 能力是否真实现 | src/validate.js | 命中 | `number` 规则名不副实（放行 NaN/Infinity）；`required` 声称必填却放行纯空白与空数组（发现 18）。 |
| 5 能力是否真实现 | src/index.js | 命中 | 「渲染一个带分页的列表视图」在负页时渲染出错误行（`page:-2` 输出 `"0,"`，见发现 4 的连锁影响）。 |
| 6 转义/编码顺序 | src/template.js | 命中 | **典型错误**：先 `<` → `&lt;`，最后才 `&` → `&amp;`，导致自身产物被二次转义。实测 `escapeHtml('<b>')` → `"&amp;lt;b&amp;gt;"`（见发现 1）。 |
| 6 转义/编码顺序 | src/events.js | 不适用 | 无转义/编码逻辑。 |
| 6 转义/编码顺序 | src/pagination.js | 不适用 | 无转义/编码逻辑。 |
| 6 转义/编码顺序 | src/validate.js | 不适用 | 无转义/编码逻辑（仅正则）。 |
| 6 转义/编码顺序 | src/index.js | 不适用 | 无转义逻辑；但它把未转义的插值直接拼进 `html`，是发现 2 的放大点。 |
| 7 边界值符号处理 | src/template.js | 不适用 | 唯一的负数来源是 `indexOf` 的 `-1` 哨兵，`minIndex`/`bodyEnd === -1` 均已判掉；`slice` 的上下界都来自 `indexOf` 结果，非用户可控负数。 |
| 7 边界值符号处理 | src/events.js | 不适用 | `indexOf` 返回 `-1` 有显式判断（`if (idx === -1) return false`）。 |
| 7 边界值符号处理 | src/pagination.js | 命中 | `page` 为负 → `offset` 为负 → `slice(负数, 负数)` 不报错但语义翻转。实测 `paginateArray(arr,-5,10)` 返回 `[40..49]`（`slice(-60,-50)`），`page=0` 返回 `[]`，`page=-1000` 返回 `[]` 且 `hasNext:true`（见发现 4）。 |
| 7 边界值符号处理 | src/validate.js | 命中 | `minLength` 的 `arg` 为负时规则恒真：实测 `validate({s:''},{s:[{rule:'minLength',arg:-5}]})` → `valid:true`（见发现 9）。 |
| 7 边界值符号处理 | src/index.js | 命中 | `page` 负数直接透传，是发现 4 的入口。 |

## 发现 18 项

### 发现 1
- **file**: src/template.js:118
- **类型**: 安全 / 转义顺序（模式 6）
- **严重性**: 高
- **问题**: `escapeHtml` 的替换顺序是 `<`、`>`、`"`、`'`，最后才是 `&`。`&` 必须**最先**替换。当前实现会把自己刚生成的实体再转义一遍：输入 `<script>` → `&amp;lt;script&amp;gt;`，浏览器把 `&amp;` 还原成 `&`，页面上显示字面量 `&lt;script&gt;`，转义失效且数据被污染；输入 `&lt;` → `&amp;lt;`，用户原本想输入的 `&lt;` 文本被破坏。非幂等：`escapeHtml(escapeHtml(s))` 得到 `&amp;amp;lt;...`。
- **证据**: `escapeHtml('<b>') === '&amp;lt;b&amp;gt;'`；`escapeHtml('a&b') === 'a&amp;b'`；`escapeHtml('&lt;') === '&amp;lt;'`；`escapeHtml('it\\'s') === 'it&amp;#39;s'`。正确输出应为 `&lt;b&gt;`。

### 发现 2
- **file**: src/template.js:96-99（`renderInline`），配合 111-119
- **类型**: 安全 / 能力未实现（模式 5）
- **严重性**: 高
- **问题**: `escapeHtml` 的注释明确写「用于用户输入的插值」，但 `renderInline` 对解析出的值只做 `String(v)` 后直接拼接，全代码库没有任何地方调用 `escapeHtml`。`compile('Hello {{name}}')` 传入 `<img src=x onerror=alert(1)>` 会原样进入 HTML，构成存储型/反射型 XSS。`index.js` 的 `renderListView` 又把该结果直接作为 `html` 返回，是主要出口。
- **证据**: `compile('Hello {{name}}')({name:'<img src=x onerror=alert(1)>'})` → `"Hello <img src=x onerror=alert(1)>"`；`grep escapeHtml` 仅命中定义与 `index.js` 的 re-export，无调用点。

### 发现 3
- **file**: src/template.js:77
- **类型**: 逻辑 / 能力未实现（模式 5）
- **严重性**: 高
- **问题**: `findMatchingClose` 的嵌套判定条件 `openTag === closeTag.replace("/", "#")` 恒为 false——`closeTag` 是 `{{/if}}`/`{{/each}}`，替换后是 `{{#if}}`/`{{#each}}`，而 `openTag` 是带尾空格的 `{{#if `/`{{#each `，两者永不相等。于是 `depth` 永远不增加，同类型嵌套块被当成「已闭合」提前截断，内层标签被当作纯文本输出。注释声称支持嵌套，实际不支持。
- **证据**: `compile('{{#if a}}{{#if b}}B{{/if}}{{/if}}')({a:1,b:1})` → `"{{#if b}}B{{/if}}"`（应为 `"B"`）；`compile('{{#each xs}}{{#each ys}}{{this}}{{/each}}{{/each}}')({xs:[{ys:[1]}]})` → `"{{#each ys}}{{this}}{{/each}}"`；200 层嵌套直接原样吐出。异类型嵌套（if 套 each、each 套 if）不受影响，实测正常，说明问题只在该条件。

### 发现 4
- **file**: src/pagination.js:15（`safePage`），影响 20、37
- **类型**: 逻辑 / 数值边界 / 符号（模式 3、7）
- **严重性**: 高
- **问题**: `page` 只判断 `Number.isInteger`，未排除 `<= 0`。负数或 0 会让 `offset = (clamped - 1) * pageSize` 变成负值，`paginateArray` 里的 `items.slice(negative, negative + limit)` 不抛错，而是按「从末尾倒数」解释，返回**完全不相干的一段数据**。同时 `hasNext` 用 `clamped < totalPages` 计算，负页恒为 `true`，`hasPrev` 恒为 `false`，分页元信息全错。`renderListView` 直接透传 `page`，是真实入口。
- **证据**: `paginate(100,-5,10)` → `{page:-5, offset:-60, hasNext:true, hasPrev:false}`；`paginateArray(0..99, -5, 10)` → `items:[40,...,49]`（即 `slice(-60,-50)`）；`paginateArray(...,-1,10)` → `[80..89]`；`page=0` → `[]`；`renderListView('{{#each items}}{{this}},{{/each}}', [0..4], {page:-2, pageSize:2})` → `html:"0,"`, `pagination.page:-2`。对照 `base` 版本该行为 `Number.isInteger(page) && page >= 1 ? page : 1`，证明这是被注入的回归。

### 发现 5
- **file**: src/events.js:64-67
- **类型**: 契约 / 异常一致性（模式 5）
- **严重性**: 中
- **问题**: 注释承诺「错误会在全部执行完后一起抛出」，但实现里 `errors.length === 1` 的分支被删掉了——单个监听器抛错时既不被 `throw`，也不体现在返回值里，`emit` 照常返回 `list.length`。调用方无法区分「全部成功」和「有 1 个监听器炸了」，错误被静默吞掉（数据可能只写了一半）。2 个及以上才抛 `AggregateError`，异常类型随数量变化，调用方无法统一 `catch`。
- **证据**: 1 个抛错 handler：`emit('e')` 未抛异常，返回 `1`；2 个抛错：抛 `AggregateError`，`message:"2 handlers failed for \"e\""`, `errors.length === 2`。`base` 版本中该处为 `if (errors.length === 1) throw errors[0];`，佐证是注入回归。

### 发现 6
- **file**: src/events.js:32（`#onceWrappers.set`）+ 24-34、40
- **类型**: 数据一致性 / 守卫顺序（模式 2）
- **严重性**: 中
- **问题**: `#onceWrappers` 以**原始 handler** 为键，一个 handler 注册到多个事件时后写覆盖前写，`off` 只能找回最后一个 wrapper，导致前面的 once 监听器泄漏且无法取消。更隐蔽的是 `once` 在校验 event **之前**就写入 WeakMap：`once(123, fn)` 抛 TypeError 后映射仍残留，之后 `on('a', fn)` 注册的普通监听器再 `off('a', fn)` 会被错误地翻译成去删一个不存在的 wrapper，返回 `false`，监听器永久泄漏。
- **证据**: `once('a',fn); once('b',fn); off('a',fn)` → `false`，`listenerCount('a')` 仍为 `1`；`once(123,fn)` 抛 TypeError 后 `on('a',fn)`、`off('a',fn)` → `false`，计数仍为 `1`。

### 发现 7
- **file**: src/validate.js:8
- **类型**: 逻辑 / 数值边界（模式 3、5）
- **严重性**: 中
- **问题**: `number` 规则只写 `typeof v === 'number'`。`typeof NaN === 'number'` 为 true，且 `NaN <= 0` 为 false，所以 NaN 和 `±Infinity` 全部通过校验。下游若用该值做金额/数量计算会一路传播 NaN，或用 Infinity 做除法/取整。
- **证据**: `validate({n:NaN},{n:[{rule:'number'}]})` → `{"valid":true}`；`validate({n:Infinity},...)` → `{"valid":true}`。`base` 对照版为 `typeof v === 'number' && !Number.isNaN(v)`，实测其在 `NaN` 上返回 `valid:false`、在 `Infinity` 上仍返回 `valid:true`——即本次注入使 **NaN 也变成合法值**，Infinity 则是基线就有的遗留问题。manifest 将 F2-05 标题写作「放行 Infinity」并不准确，真正新增的回归是放行 NaN。

### 发现 8
- **file**: src/validate.js:37-38（`errors[field]`），入口 25
- **类型**: 健壮性 / 原型链（模式 4）
- **严重性**: 中
- **问题**: `errors` 是普通 `{}`，用字段名直接索引。字段名是 `constructor`、`toString`、`hasOwnProperty` 等原型属性时，`errors[field]` 取到的是 `Object.prototype` 上的**函数**，`.push` 不存在，直接抛 `TypeError: errors[field].push is not a function`——一个正常的校验请求变成 500。字段名为 `__proto__` 时（`JSON.parse` 可构造），`if (!errors[field])` 判为假不初始化，随后 `errors['__proto__'].push` 同样崩溃；若走通则会改写 `errors` 的原型。既然 `schema` 明确允许外部传入，就必须用 `Object.create(null)` 或 `hasOwnProperty` 防护。
- **证据**: `validate({constructor:'x'},{constructor:[{rule:'minLength',arg:5}]})` → `TypeError: errors[field].push is not a function`；`toString`、`hasOwnProperty` 同样崩溃；`validate({name:'abc'},{name:[{rule:'minLength',arg:5}]})` 正常返回 `{valid:false,...}` 作为对照。

### 发现 9
- **file**: src/validate.js:6-7（`minLength`/`maxLength`）
- **类型**: 逻辑 / 数值边界（模式 2、3、7）
- **严重性**: 中
- **问题**: 规则的 `arg` 完全未校验，`v.length >= n` 直接参与比较，产生反直觉结果：`arg: NaN` 使**任何**字符串都校验失败；`arg: undefined` 同理；`arg: '2'` 被隐式转成数字（碰巧正确）；`arg: -5` 使空串也通过（规则形同虚设）。`arg` 通常来自配置/DB，一旦是字符串或空值就静默改变校验语义。
- **证据**: `{s:'abc', rule:'minLength', arg:NaN}` → `valid:false`；`arg` 缺省 → `valid:false`；`arg:'2'` → `valid:true`；`{s:'', arg:-5}` → `valid:true`。

### 发现 10
- **file**: src/validate.js:31-35
- **类型**: 健壮性 / 形状校验（模式 4）
- **严重性**: 低
- **问题**: `rules` 是数组这一点校验了，但数组元素的形状没校验。`[null]` 在读取 `r.rule` 时崩成 `Cannot read properties of null`；`['required']` 会报 `unknown rule: undefined`，把「写错 schema 结构」误报成「未知规则名」，排障方向被带偏。`schema` 本身传数组也能通过 `typeof === 'object'`，随后报 `rules for "0" must be an array`。
- **证据**: `validate({a:1},{a:[null]})` → `TypeError: Cannot read properties of null (reading 'rule')`；`{a:['required']}` → `TypeError: unknown rule: undefined`；`validate({0:'x'},[{rule:'required'}])` → `TypeError: rules for "0" must be an array`。

### 发现 11
- **file**: src/template.js:102-109（`resolvePath`）
- **类型**: 安全 / 信息泄露（模式 4）
- **严重性**: 中
- **问题**: 路径解析用 `cur = cur[seg]`，未限制 `hasOwnProperty`，也未屏蔽 `__proto__`/`constructor`/`prototype`。模板里写 `{{__proto__.constructor}}` 就能把宿主环境的 `Function Object() { [native code] }` 渲染进页面，泄露运行时信息，并为后续的沙箱逃逸探测提供支点。若模板可被用户部分控制，这是可利用面；即便不可控，`{{toString}}` 之类的意外命中也会输出无意义源码。
- **证据**: `compile('{{__proto__.constructor}}')({})` → `"function Object() { [native code] }"`；`compile('{{a.hasOwnProperty}}')({a:{}})` → `"function hasOwnProperty() { [native code] }"`；`compile('{{constructor}}')({})` → `"function Object() { [native code] }"`。

### 发现 12
- **file**: src/events.js:67
- **类型**: 契约 / 返回值语义（模式 5）
- **严重性**: 低
- **问题**: `emit` 返回 `list.length`，但 `list` 是 `this.#handlers` 里的**实时数组**（`[...list]` 只用于遍历，返回时读的是原数组）。监听器在回调中 `off` 掉别人会 `splice` 掉该数组元素，于是返回值既不是触发前的监听器数，也不是实际执行数，而是「循环结束后残留的数量」。反过来，若回调里 `on` 新增监听器，返回值又会偏大。用它做「有多少监听器收到事件」的判断会出错。
- **证据**: 注册 h1（回调里 `off('e', h2)`）与 h2，`listenerCount` 为 2，`emit('e')` 返回 `1`，结束后计数为 1。实际执行了 2 个 handler（快照遍历，h2 仍打印），所以返回值 1 既非执行数 2、也非触发前数 2。

### 发现 13
- **file**: src/events.js:37-46（`off`）、77-87（`removeAll`）
- **类型**: 守卫一致性（模式 2）
- **严重性**: 低
- **问题**: `on`/`once` 对 event 有严格校验（非空字符串），`off`/`removeAll` 完全不校验。`off(123, fn)`、`off(null, fn)`、`removeAll({})` 都静默返回 `false`/`0`，调用方无法区分「参数写错」和「本来就没有监听器」。`removeAll(null)` 返回 `0` 而 `removeAll(undefined)` 清空**全部**事件——两个「空值」语义分叉，极易误删。
- **证据**: `off(123,()=>{})` → `false`；`removeAll({})` → `0`；`removeAll(null)` → `0`；而 `removeAll()` 在 a/b/c 各 1 个监听器时返回 `3` 并清空三者。

### 发现 14
- **file**: src/pagination.js:15
- **类型**: 参数类型校验（模式 2、3）
- **严重性**: 低
- **问题**: `page` 传字符串/`null`/`undefined`/`NaN`/`Infinity`/小数时全部被 `Number.isInteger(page) ? page : 1` 静默降级为第 1 页，不报错。查询参数天然是字符串（`?page=2`），这意味着「用户请求第 2 页」和「用户传了垃圾」得到完全相同的响应，且与 `total`/`pageSize` 抛 RangeError 的严格风格不一致。
- **证据**: `paginate(100,'2',10)` → `page:1`；`paginate(100,null,10)`、`paginate(100,NaN,10)`、`paginate(100,1.5,10)` 均为 `page:1`；对照 `paginate(100,2,10)` → `page:2`。

### 发现 15
- **file**: src/index.js:13
- **类型**: 参数形状校验（模式 2、4）
- **严重性**: 低
- **问题**: 第三个参数用解构默认值 `{ page = 1, ... } = {}`，只能兜住 `undefined`。显式传 `null` 会在解构时抛 `Cannot read properties of null (reading 'page')`；传字符串 `'abc'` 却能被静默接受并使用默认值——同类错误一个崩一个吞。`renderListView` 是模块对外主入口，调用方最容易踩。
- **证据**: `renderListView('x',[1],null)` → `TypeError: Cannot read properties of null (reading 'page')`；`renderListView('x',[1],'abc')` → 正常返回 `{html:'x', pagination:{page:1,...}}`。

### 发现 16
- **file**: src/pagination.js:37
- **类型**: 返回值别名（模式 1）
- **严重性**: 低
- **问题**: `items.slice()` 只复制数组壳，元素仍是源对象的同一引用。调用方对返回项做 `item.status = 'read'` 之类的改写，会直接污染源数据；`renderListView` 把 `paged.items` 交给模板，模板若通过自定义 helper 修改对象同样会反向影响入参 `items`。
- **证据**: `objs=[{v:1},...]; pp=paginateArray(objs,1,2); pp.items[0].v=999` → `objs[0].v === 999`。（注：替换整个元素不影响源数组，`pi.items.push(999)` 后重新分页仍为 `[0,1]`，所以问题仅限元素级改写。）

### 发现 17
- **file**: src/template.js:54-60
- **类型**: 逻辑 / 隐式失败（模式 5）
- **严重性**: 低
- **问题**: `{{#each}}` 只在 `Array.isArray(list)` 时渲染，其他一切（对象、字符串、null、undefined、类数组）都**静默输出空串**，不报错也不告警。模板写错字段名（`{{#each item}}` 应为 `items`）时页面「正常」渲染成空白，问题被推迟到线上发现。`{{#if}}` 同样静默按 truthy 处理。这与模块宣称的「未知变量渲染为空字符串，不抛错」哲学一致，但对块级指令而言会掩盖结构性错误。
- **证据**: `compile('{{#each xs}}X{{/each}}')({xs:{a:1}})` → `""`；`{xs:null}` → `""`；`{xs:'abc'}` → `""`；而 `{xs:[1,'a',null,undefined]}` → `"1a"`。

### 发现 18
- **file**: src/validate.js:4（`required`）
- **类型**: 逻辑 / 校验语义（模式 5）
- **严重性**: 低
- **问题**: `required` 只排除 `undefined`/`null`/`''`。纯空白字符串 `'   '`、空数组 `[]`、数字 `0`、布尔 `false` 全部判定为「已填写」。表单场景中「用户只敲了空格」应视为未填，当前实现会让这类提交通过必填校验。这是校验器最常见的语义漏洞之一。
- **证据**: `validate({s:'  '},{s:[{rule:'required'}]})` → `valid:true`；`{s:[]}` → `valid:true`；`{s:0}` → `valid:true`；`{s:false}` → `valid:true`；对照 `{s:''}` → `valid:false`。

## 附：与 fixture manifest 的对照

目标目录与 `experiments\fixture2\injected\` 逐字节一致，`diff -u base injected` 显示 4 个文件共 6 处改动：

| manifest ID | 位置 | 本报告 |
|---|---|---|
| F2-01 | template.js:118 `&` 最后替换 | 发现 1 |
| F2-02 | events.js:32 once WeakMap 覆盖 | 发现 6 |
| F2-05 | validate.js:8 number 放行 Infinity | 发现 7（实测新增的是放行 **NaN**，Infinity 在 base 中已放行） |
| F2-08 | events.js:64 单错不抛 | 发现 5 |
| F2-09 | pagination.js:15 page 未排负数 | 发现 4 |
| *（manifest 未列）* | template.js:77 嵌套块条件恒假 | 发现 3 |

注意三点：①manifest 声称 5 个缺陷，实际注入 6 个，`template.js:77` 的嵌套块回归未被登记；②manifest 对 F2-05 的描述（「放行 Infinity」）不准确，`base` 版同样放行 Infinity，注入真正引入的是放行 NaN；③发现 2、8、9、11、12、13、14、15、16、17、18 已在 `base` 对照版上逐一复现（`verify-base.mjs`），属基线既有缺陷而非本次注入，与注入缺陷应分开统计。

已用 `verify-base.mjs` 在 `base` 上复现确认属基线既有问题的：XSS 未转义插值（发现 2）、`errors[field]` 原型属性崩溃（发现 8）、`minLength` 负 arg 恒真（发现 9）、原型链路径泄露（发现 11）、`emit` 返回实时长度（发现 12）、`off`/`removeAll` 无守卫且 `removeAll()` 清空全部（发现 13）、`page` 类型静默降级（发现 14）、`options=null` 崩溃 / `options='abc'` 被吞（发现 15）、`slice` 元素别名（发现 16）、`each` 非数组静默空串（发现 17）、`required` 放行空白（发现 18）。

## 验证脚本

`<HOME>\AppData\Local\Temp\audit-t1\verify.mjs` ～ `verify5.mjs`（只读导入被审模块，未修改任何被审文件）。复现命令：`node %TEMP%\audit-t1\verify4.mjs`。
