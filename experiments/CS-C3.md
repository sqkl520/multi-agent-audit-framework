所有发现均已通过实际运行验证。以下是报告。

## 发现 1
- **file**: `src/template.js:77`
- **类型**: 控制流 / 逻辑正确性（嵌套块解析）
- **严重性**: CRITICAL
- **问题**: `findMatchingClose` 里的嵌套判定条件 `openTag === closeTag.replace("/","#")` 永远为假（`'{{#if '` 与 `'{{/if}}'` 替换后得到的是 `'{{#if}}'`，尾随空格和 `}}` 都对不上），因此 depth 永不递增，第一个内层块的闭合标签就被当成外层块的结尾，导致嵌套 `{{#if}}`/`{{#each}}` 全部解析错乱。
- **依据**: 实测 `compile('{{#if a}}A{{#if b}}B{{/if}}C{{/if}}')({a:1,b:1})` → `"A{{#if b}}BC{{/if}}"`；`b:0` 时输出完全相同。嵌套 `{{#each}}` 同样：`compile('{{#each rows}}[{{#each cols}}x{{/each}}]{{/each}}')` → `"[{{#each cols}}x]{{/each}}"`。原始模板标记泄漏进最终 HTML，条件不生效。

## 发现 2
- **file**: `src/template.js:96`
- **类型**: 安全 / 输出编码（XSS）
- **严重性**: HIGH
- **问题**: `renderInline` 对插值结果直接 `String(v)` 拼接，全流程从不调用 `escapeHtml`，而第 111-112 行注释明确声称 `escapeHtml`「用于用户输入的插值」——`compile` 与其无任何关联，导致所有 `{{var}}` 均为裸输出。
- **依据**: 实测 `compile('{{name}}')({name:'<img src=x onerror=alert(1)>'})` → 原样返回 `<img src=x onerror=alert(1)>`。`escapeHtml` 在 src 内除 `index.js` re-export 外零引用（Grep 确认）。

## 发现 3
- **file**: `src/template.js:118`
- **类型**: 安全 / 编码逻辑（转义顺序）
- **严重性**: HIGH
- **问题**: `escapeHtml` 把 `&` → `&amp;` 放在最后一步，前面替换产生的 `&lt;`/`&quot;`/`&#39;` 会被再次转义成 `&amp;lt;`，输出既双重转义又无法逆向还原。
- **依据**: 实测 `escapeHtml('<b>')` → `"&amp;lt;b&amp;gt;"`（应为 `"&lt;b&gt;"`）；`escapeHtml("O'Brien & <i>")` → `"O&amp;#39;Brien &amp; &amp;lt;i&amp;gt;"`；二次调用持续累加 `&amp;amp;lt;`。一个字符经转义后，在页面上会直接显示 `&lt;b&gt;` 字面量。

## 发现 4
- **file**: `src/events.js:64`
- **类型**: 异常处理 / 契约违背
- **严重性**: HIGH
- **问题**: `emit` 只有 `errors.length > 1` 时才抛 `AggregateError`，单一监听器抛出的异常被完全吞掉，与第 50 行文档「错误会在全部执行完后一起抛出」直接矛盾，并让 `errors` 数组的第 0 项永久丢失。
- **依据**: 实测单个 throwing handler：`b.on('e',()=>{throw new Error('oops')}); b.emit('e')` → 无异常，返回 `1`（X3）；两个 handler 时才抛 `AggregateError | 2 handlers failed`（B）。混合场景（一个正常一个抛错）→ 静默返回，`ran=1`（C）。

## 发现 5
- **file**: `src/pagination.js:15`
- **类型**: 边界值 / 输入校验
- **严重性**: HIGH
- **问题**: 注释「未排除负数」属实且更糟——`Number.isInteger` 放行 0 和负整数，`clamped = Math.min(safePage, totalPages)` 只做上界收敛，没有 `Math.max(1, …)` 下界，导致返回负 `offset`，`paginateArray` 用负偏移切数组得到空页/错页。
- **依据**: 实测 `paginate(10,0,3)` → `{"page":0,"offset":-3,"hasNext":true,"hasPrev":false}`；`paginate(10,-5,3)` → `{"page":-5,"offset":-18}`；`paginateArray([0..9],-5,3)` → `items:[]`（P3）。通过 `index.js:14` 暴露给 `renderListView`，`page=0` 时列表整体消失。

## 发现 6
- **file**: `src/events.js:32`
- **类型**: 状态管理 / 订阅泄漏
- **严重性**: HIGH
- **问题**: `#onceWrappers` 以**原始 handler** 为键，同一 handler 多次 `once` 注册到不同事件时后者覆盖前者，使得先前事件上的 wrapper 无法再通过原始 handler 反注册，`off` 返回 false 且监听器残留。
- **依据**: 实测 X1：`uPlain = b.on('a',h); b.once('b',h); uPlain()` → `{before:1, ok:false, after:1}`——取消订阅函数失效，`a` 上的监听器永久泄漏。E：两个事件 `once` 同一 handler 后 `off('a',h)` 无法命中（X2 同样 `removed:false`）。

## 发现 7
- **file**: `src/validate.js:32`
- **类型**: 输入校验 / 原型链查找
- **严重性**: MEDIUM
- **问题**: `RULES[r.rule]` 直接索引对象，会命中原型链上的 `Object.prototype.toString` / `constructor` 等函数，`typeof fn === 'function'` 成立从而绕过「unknown rule」检查，规则名写错时校验静默通过。
- **依据**: 实测 `validate({a:'zz'},{a:[{rule:'toString'}]})` → `{"valid":true,"errors":{}}`（`toString(v,undefined)` 返回 `"[object Undefined]"` 为真值）；`rule:'constructor'` 同样 `valid:true`。而 `rule:'__proto__'` 反而抛 `unknown rule`——行为不一致。

## 发现 8
- **file**: `src/validate.js:37`
- **类型**: 健壮性 / 原型键污染
- **严重性**: MEDIUM
- **问题**: `errors` 是普通对象，当字段名为 `__proto__` / `constructor` / `toString` 时 `if (!errors[field])` 判定为真（取到原型上的值）而跳过数组初始化，随后 `errors[field].push` 抛 TypeError；字段名 `__proto__` 还会把 `errors` 的 prototype 改写为数组。
- **依据**: 实测 `validate({}, JSON.parse('{"__proto__":[{"rule":"minLength","arg":100,"message":"X"}]}'))` → THROW `TypeError | errors[field].push is not a function`；`field:'constructor'`、`field:'toString'` 同样抛错。应为 `Object.create(null)` 或 `hasOwn` 判定。

## 发现 9
- **file**: `src/events.js:67`
- **类型**: 返回值正确性
- **严重性**: MEDIUM
- **问题**: `emit` 返回的是 `list.length`（快照前/后的原始长度），而非实际执行的监听器数；代码注释自己承认「返回的是原始长度，非实际执行数」，调用方据此判断「是否有监听器处理」会得到错误结论。
- **依据**: 实测 D2：两个监听器在首个回调中互相 `off`，`emit` 返回 `0`，但实际执行了 2 个；运行后剩余监听器为 0。X9 中 `once` 在 emit 期间自摘除，返回 `1`、`left=1`，语义混乱。

## 发现 10
- **file**: `src/events.js:57`
- **类型**: 事件语义 / 契约违背
- **严重性**: MEDIUM
- **问题**: `for (const h of [...list])` 遍历快照，注释称「防止监听器内部 off/on 改动数组」，但副作用是「已被 `off` 移除、尚未执行」的监听器仍会被调用——取消订阅在同一轮 emit 中不生效，与 `off` 的语义冲突。
- **依据**: 实测 H：`h1` 内调用 `b.off('e', h2)`，`emit` 结果仍为 `["h1","h2"]`——`h2` 在注销后依然执行。G：emit 期间新注册的监听器本轮不执行（`[1]`），两者行为不对称。

## 发现 11
- **file**: `src/pagination.js:15`
- **类型**: 输入校验 / 静默降级
- **严重性**: MEDIUM
- **问题**: `page` 非法（非整数、字符串数字、NaN）时不报错而是静默回退为 1，且回退后仍可能越界；调用方传入 `'2'`、`2.5` 都会得到第 1 页数据且无从感知，与 `total`/`pageSize` 的严格 RangeError 风格不一致。
- **依据**: 实测 `paginate(10,'2',3)` → `{"page":1,"offset":0}`；`paginate(10,2.5,3)` → `{"page":1,...}`；`paginate(10,NaN,3)` → `{"page":1,...}`。同期 `pageSize:0` 与 `total:10.5` 均正常抛 `RangeError`。

## 发现 12
- **file**: `src/validate.js:8`
- **类型**: 输入校验 / 数值语义
- **严重性**: MEDIUM
- **问题**: `number` 规则用 `typeof v === 'number'`，`NaN`、`Infinity` 都会被判为合法数字，脏数据可通过校验进入下游。
- **依据**: 实测 `validate({n:NaN},{n:[{rule:'number'}]})` → `{"valid":true,"errors":{}}`（V3）；`integer` 用 `Number.isInteger` 已正确排除 NaN，两条规则判定口径不一致。

## 发现 13
- **file**: `src/template.js:43`
- **类型**: 安全 / 原型链取值
- **严重性**: MEDIUM
- **问题**: 块标签的 key 通过 `ctx[key]` 取值（同样见 55 行 `ctx[key]`、105 行 `resolvePath`），会沿原型链命中 `constructor`/`toString` 等真值，使 `{{#if constructor}}` 在空上下文下也成立、`{{constructor}}` 输出原生函数源码。
- **依据**: 静态推断：`compile('{{#if constructor}}X{{/if}}')({})` 中 `ctx['constructor']` 为 `Object`（真值），分支必进；`resolvePath` 第 105 行只挡 `null`/非对象，不挡原型属性。与 56 行「未知变量渲染为空」的文档承诺冲突。

## 发现 14
- **file**: `src/template.js:58`
- **类型**: 作用域 / 数据覆盖
- **严重性**: MEDIUM
- **问题**: `{ ...ctx, this: item, ...(typeof item === 'object' ? item : {}) }` 让循环项属性覆盖外层上下文，且 `null` 的 `typeof` 也是 `'object'`（展开安全但语义含糊）；循环体内访问同名外层变量会被静默遮蔽，无任何提示。
- **依据**: 实测 `compile('{{#each xs}}{{name}}{{/each}}')({name:'OUT', xs:[{name:'IN'}]})` → `"IN"`；`compile('{{#each xs}}{{v}}{{/each}}')({xs:[null], v:'ctx'})` → `"ctx"`（null 项未报错、直接沿用外层值）。同时 `{{#each items}}` 对非数组（如字符串 `'abc'`）静默输出空串而不报错。

## 发现 15
- **file**: `src/validate.js:36`
- **类型**: API 设计缺陷 / 可选字段不可表达
- **严重性**: LOW
- **问题**: 所有规则对 `undefined` 值无条件执行，缺少「字段缺失则跳过」的短路，导致无法表达「可选但限长」的字段：不填就必然报 `minLength`/`maxLength` 错误。
- **依据**: 实测 `validate({}, {name:[{rule:'minLength',arg:3}]})` → `{"valid":false,"errors":{"name":["name failed minLength"]}}`（V6）；只有 `required` 一类的存在性规则才应作用于缺失字段。

## 发现 16
- **file**: `src/validate.js:31`
- **类型**: 健壮性 / 空值防御
- **严重性**: LOW
- **问题**: 遍历 `rules` 时未校验元素类型，schema 中混入 `null`/原始值时在第 32 行 `r.rule` 处抛原生 `TypeError`，错误信息与库内其它「明确 `TypeError(msg)`」风格不一致，排障困难。
- **依据**: 实测 `validate({a:1},{a:[null]})` → THROW `TypeError | Cannot read properties of null (reading 'rule')`（V7）。

---

补充说明（非缺陷，供参考）：`index.js:15` 每次调用都重新 `compile(template)`，无缓存；在分页/列表场景下属于性能浪费，但语义正确，故未计入缺陷。审计过程中未执行任何 `npm`/`mvn` 等命令，未修改被审文件；验证脚本仅位于 `<HOME>\AppData\Local\Temp\c3-scratch\`（t1.mjs 模板、t2/t4.mjs 事件、t3.mjs 分页+校验）。
