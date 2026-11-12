所有缺陷都已分别用实测结果确认。以下是审计报告。

---

## 发现 1：`escapeHtml` 在最后才替换 `&`，把自身产出的实体二次转义

- **file**: `src/template.js:118`
- **类型**: 安全 / 编码正确性
- **严重性**: CRITICAL
- **问题**: `&` 的替换放在链尾，使前面生成的 `&lt;`、`&quot;` 中的 `&` 被再次转义，输出被双重编码，浏览器会显示成字面量 `&lt;b&gt;` 而不是标签文本。
- **依据**: 实测 `escapeHtml('<a & "b" \'c\'>')` → `"&amp;lt;a &amp; &amp;quot;b&amp;quot; &amp;#39;c&amp;#39;&amp;gt;"`；`escapeHtml('<b>')` 一次 → `&amp;lt;b&amp;gt;`，二次 → `&amp;amp;lt;...`（非幂等）。正确做法是第一个替换 `&`。

## 发现 2：插值渲染完全不做 HTML 转义，配合 `renderListView` 构成 XSS

- **file**: `src/template.js:98`
- **类型**: 安全 / 注入
- **严重性**: CRITICAL
- **问题**: `renderInline` 直接 `String(v)` 拼进 HTML，`escapeHtml` 虽被导出却从未在渲染路径调用，`renderListView`（`src/index.js:17`）把 `items`/`extra` 原样注入，用户数据可执行脚本。
- **依据**: 实测 `compile('<p>{{v}}</p>')({v:'<script>x</script>'})` → `"<p><script>x</script></p>"`；`renderListView('{{#each items}}<li>{{name}}</li>{{/each}}', [{name:'<script>alert(1)</script>'}])` → `"<li><script>alert(1)</script></li>"`。

## 发现 3：`findMatchingClose` 的配对判定条件恒为 false，同类型块无法嵌套

- **file**: `src/template.js:77`
- **类型**: 逻辑 / 死代码
- **严重性**: HIGH
- **问题**: `openTag === closeTag.replace("/","#")` 永不成立——`'{{#each '` 带尾随空格，而 `'{{/each}}'.replace('/','#')` 得到 `'{{#each}}'`（无空格），因此 `depth` 永远不递增，第一层闭合标签即被当作结束。
- **依据**: 实测 `'{{#each ' === '{{/each}}'.replace('/','#')` → `false`；`{{#each g}}{{#each it}}{{n}}{{/each}}{{/each}}` 渲染出 `"{{#each it}}{{n}}{{#each it}}{{n}}{{/each}}"` 的原始模板垃圾；`{{#if a}}{{#if b}}AB{{/if}}{{/if}}` → `"{{#if b}}AB{{/if}}"`（跨类型嵌套 `{{#if}}`+`{{#each}}` 正常，说明只坏在同类型）。

## 发现 4：`emit` 恰好只有一个监听器抛错时错误被静默吞掉

- **file**: `src/events.js:64`
- **类型**: 错误处理 / 契约违背
- **严重性**: HIGH
- **问题**: 只在 `errors.length > 1` 时抛 `AggregateError`，单个失败既不上抛也不返回，与第 50 行文档“错误会在全部执行完后一起抛出”矛盾，调用方完全无法感知失败。
- **依据**: 实测单监听器抛错：`b.emit('e')` 返回 `1`，未抛异常（`{threw:false, emitReturned:1}`）；而两个监听器抛错才得到 `AggregateError:2`。

## 发现 5：`once` 用 handler 作 WeakMap 键，同一函数注册多个事件时映射被覆盖

- **file**: `src/events.js:32`
- **类型**: 状态管理 / 内存泄漏
- **严重性**: HIGH
- **问题**: `#onceWrappers` 以用户 handler 为键，同一 handler 对两个事件各 `once` 一次时后写的 wrapper 覆盖前者，导致 `off('a', h)` 找不到已注册的 wrapper，监听器无法取消。
- **依据**: 实测 `b.once('a',h); b.once('b',h); b.off('a',h)` → 返回 `false`，取消后 `countA` 仍为 `1`、`countB` 为 `1`。

## 发现 6：once 映射只增不删，残留条目使日后普通的 `off` 失效

- **file**: `src/events.js:40`
- **类型**: 状态管理 / 内存泄漏
- **严重性**: MEDIUM
- **问题**: `once` 触发或取消后 `#onceWrappers` 条目从未清理，之后用同一函数走 `on` 注册时，`off` 会命中失效 wrapper 而非 handler 本身，返回 false 且监听器残留。
- **依据**: 实测 `b.once('a',h); b.off('a',h); b.on('b',h); b.off('b',h)` → 返回 `false`，`listenerCount('b')` 仍为 `1`。

## 发现 7：`emit` 返回值语义错误，既非注册数也非实际执行数

- **file**: `src/events.js:67`
- **类型**: API 契约
- **严重性**: MEDIUM
- **问题**: 返回 `list.length`，而 `list` 是实时数组，遍历期间被移除的监听器会让该值偏小；执行数与返回值不一致。
- **依据**: 实测 3 个监听器、全部执行、首个自取消后返回 `2`（`{emitReturn:2, listenersAfter:2}`）；注释自认“非实际执行数”。

## 发现 8：`paginate` 未对页码做下界钳制，负页码导致负数 offset 并返回数组尾部数据

- **file**: `src/pagination.js:15`
- **类型**: 边界处理 / 数据正确性
- **严重性**: HIGH
- **问题**: `safePage` 只校验“是否整数”，仅用 `Math.min` 钳上界；`page <= 0` 时 `offset` 为负，`Array.prototype.slice` 的负索引会把最后一页数据当首页返回，同时 `hasPrev:false`、`hasNext:true` 自相矛盾。
- **依据**: 实测 `paginate(100,-5,10)` → `{page:-5, offset:-60, hasPrev:false, hasNext:true}`；`paginateArray([1..12], -1, 5).items` → `[3,4,5,6,7]`（第 1 页返回第 3 页数据），`page:0` → `[]`；`renderListView(..., {page:-1, pageSize:2})` 把 5 条数据渲染成 `"2,3,"`。

## 发现 9：规则查表走原型链，`rule: 'constructor'`/`'toString'` 被当作合法规则并静默判通过

- **file**: `src/validate.js:32`
- **类型**: 安全 / 白名单绕过
- **严重性**: HIGH
- **问题**: `RULES[r.rule]` 未用 `Object.hasOwn` 限定的自有属性，schema 传入原型链上的函数名即可绕过校验（`constructor`/`toString` 返回非布尔真值，规则被当成“通过”），另一些则抛出 `TypeError`。
- **依据**: 实测 `validate({v:12345}, {v:[{rule:'constructor'}]})` → `{valid:true}`，`toString` 同；`valueOf`/`hasOwnProperty` → `THREW: Cannot convert undefined or null to object`；而 `listRules()` 并不包含这些名字。

## 发现 10：`required` 规则放过纯空白字符串、空数组、空对象与 `NaN`

- **file**: `src/validate.js:4`
- **类型**: 业务校验逻辑
- **严重性**: MEDIUM
- **问题**: 仅排除 `undefined/null/''`，`'   '`、`[]`、`{}`、`NaN` 都算“已填”，对表单必填语义而言是漏检。
- **依据**: 实测 `validate({a:'   '},{a:[{rule:'required'}]})`、`{a:[]}`、`{a:{}}`、`{a:NaN}` 四种输入均返回 `valid:true`。

## 发现 11：`number` 规则接受 `NaN` 与 `Infinity`

- **file**: `src/validate.js:8`
- **类型**: 业务校验逻辑
- **严重性**: MEDIUM
- **问题**: `typeof NaN === 'number'` 且 `Infinity` 也是 number，数值规则对二者判定为合法。
- **依据**: 实测 `validate({n:NaN},{n:[{rule:'number'}]}).valid` → `true`；`Infinity` 同样 `true`。

## 发现 12：块标签只认带空格的字面量，换行/制表符分隔的 `{{#if` 被整体漏解析并原样输出

- **file**: `src/template.js:24`
- **类型**: 解析健壮性 / 信息泄露
- **严重性**: MEDIUM
- **问题**: 仅查找 `'{{#each '` 与 `'{{#if '`（硬编码单个空格），`{{#if\nok}}`、`{{#if\tok}}` 不被识别，整段指令连同块体以原始文本进入输出，模板源码外泄且块内容永不渲染。
- **依据**: 实测 `compile('{{#if\nok}}YES{{/if}}')({ok:1})` → `"{{#if\nok}}YES{{/if}}"`；制表符版本同样输出原文。

## 发现 13：未闭合或错配的块标签静默降级为原文输出，不报错

- **file**: `src/template.js:46`
- **类型**: 错误处理 / 静默失败
- **严重性**: MEDIUM
- **问题**: `bodyEnd === -1` 时（及第 39 行 `nameEnd === -1`）直接 `out += src.slice(next)` 并 `break`，模板语法错误被当作合法内容渲染，故障在生产环境不可见。
- **依据**: 实测 `compile('A{{#each xs}}B')({xs:[1]})` → `"A{{#each xs}}B"`；`{{#each xs}}{{#if a}}X{{/each}}{{/if}}` 交叉错配 → `"{{#if a}}X{{/if}}"`。

## 发现 14：变量名正则不支持 `@index` 等循环内建变量，循环无法输出序号

- **file**: `src/template.js:96`
- **类型**: 功能缺失 / 输出污染
- **严重性**: MEDIUM
- **问题**: `/\{\{\s*([\w.]+)\s*\}\}/g` 不匹配带 `@` 的标识符，`{{@index}}` 既不解析也不报错，直接原样留在 HTML 中。
- **依据**: 实测 `compile('{{#each xs}}{{@index}}:{{this}} {{/each}}')({xs:['a','b']})` → `"{{@index}}:a {{@index}}:b "`。

## 发现 15：`resolvePath` 沿原型链取值，可读到继承属性与内建函数源码

- **file**: `src/template.js:104`
- **类型**: 安全 / 信息泄露
- **严重性**: MEDIUM
- **问题**: 逐段 `cur = cur[seg]` 且只判 `object`，未用自有属性检查，模板可读取原型链成员并把函数源码渲染进页面。
- **依据**: 实测 `compile('{{constructor}}')({})` → `"function Object() { [native code] }"`；`compile('{{x}}')(Object.create({x:'inherited'}))` → `"inherited"`。

## 发现 16：`each` 的 `...item` 置于 `this` 之后，可覆盖循环变量并遮蔽外层上下文

- **file**: `src/template.js:58`
- **类型**: 逻辑 / 作用域
- **严重性**: LOW
- **问题**: `{...ctx, this: item, ...item}` 中 item 的自有属性优先级最高，元素含 `this` 字段时会把循环变量替换掉；同时 item 键无条件覆盖外层同名变量。
- **依据**: 实测 `compile('{{#each xs}}{{this}}{{/each}}')({xs:[{this:'OBJ',v:1}]})` → `"OBJ"`（期望输出对象本身）；`compile('{{#each xs}}{{n}}{{/each}}')({n:'OUTER', xs:[{n:'INNER'}]})` → `"INNER"`。

---

审计覆盖：5 个源文件 + `package.json` 全文通读；4 个验证脚本（`<HOME>\AppData\Local\Temp\c1-scratch\s1-template.mjs`、`s2-events.mjs`、`s3-pag-val.mjs`、`s4-confirm.mjs`）在 Node v26.12.1 下执行，全部结论均以上述实测输出为依据。未修改任何被审文件，未执行任何包管理器命令。

补充说明（未计入发现，因属设计取舍而非缺陷）：`{{#if}}` 对 `0`/`''` 判假、`emit` 对遍历中新增的监听器延后到下次触发、`paginate(0,1,n)` 返回 `totalPages:1`，均为常见约定；`index.js:18-23` 的 `pagination` 对象未透出 `offset`/`limit`，与 `paginate` 返回值不一致，但属接口裁剪，未单列。
