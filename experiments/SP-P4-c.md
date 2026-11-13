4 个验证脚本已跑完（上限 4 个），下面是报告。

---

## 发现 1

**file**: `src/validate.js:32`
**类型**: 裸下标查表 — 规则表用外部数据当键，未校验查表结果的形状
**严重性**: 严重

**问题**: `const fn = RULES[r.rule]` 用外部传入的 `r.rule` 直接索引普通对象字面量 `RULES`。`constructor`、`toString`、`valueOf` 会从 `Object.prototype` 上取到函数，随后第 33 行的守卫 `typeof fn !== 'function'` 反而把它们全部放行（它只检查「是不是函数」，没检查「是不是 RULES 自己的规则」）。

**依据**:
```
{rule:'constructor'} → validate 返回 {valid:true}   // Object(value,arg) 返回对象，恒真 → 规则永远"通过"
{rule:'toString'}    → validate 返回 {valid:true}   // '' , '[object Object]' 恒真
{rule:'valueOf'}     → THROW TypeError: Cannot convert undefined or null to object
```
即：调用方写错/攻击者控制 schema 时，该字段的校验被**静默跳过**，而不是报 `unknown rule`。`__proto__` 恰好落到"unknown rule"分支，掩盖了这个洞。

---

## 发现 2

**file**: `src/validate.js:30`
**类型**: 把外部数据当 map 用，裸下标读值
**严重性**: 高

**问题**: `const value = data[field]` 未用 `Object.hasOwn` / 未区分「自有属性」与「原型链属性」。字段名为 `constructor`/`toString`/`hasOwnProperty`/`__proto__` 时读到的是继承来的函数/对象，即使 `data` 里**根本没有这个字段**。

**依据**:
```
validate({}, { constructor: [{rule:'required'}] })                                  → {valid:true}   // 必填被绕过
validate({}, { toString:    [{rule:'required'}] })                                  → {valid:true}
validate({}, JSON.parse('{"__proto__":[{"rule":"required"}]}'))                     → {valid:true}
// 对照：正常字段
validate({}, { username: [{rule:'required'}] })                                     → {valid:false}
```
`JSON.parse('{"__proto__":...}')` 会生成**自有**的 `__proto__` 键（`Object.keys` 可见），所以这条路径不只存在于构造字面量，真实 JSON 输入即可触发。安全性上属于「必填校验被完全旁路」。

---

## 发现 3

**file**: `src/validate.js:37`
**类型**: 把结果累加器当 map 用，裸下标写值（先判真假值再赋值）
**严重性**: 高

**问题**: `if (!errors[field]) errors[field] = [];` 用 `errors`（`{}`，带 `Object.prototype`）裸下标探测。字段名为 `constructor`/`toString`/`__proto__` 时 `errors[field]` 返回继承来的函数/对象，是**真值**，于是跳过初始化，下一行 `errors[field].push(...)` 直接崩。

**依据**:
```
validate({}, { constructor: [{rule:'email'}] })                                     → THROW TypeError: errors[field].push is not a function
validate({}, JSON.parse('{"__proto__":[{"rule":"email"}]}'))                        → THROW TypeError: errors[field].push is not a function
validate({constructor:'bad'}, { constructor: [{rule:'email'}] })                     → THROW TypeError: errors[field].push is not a function
```
只要 schema 里出现这类字段名且该字段**校验失败**，整个 `validate` 从「返回 errors」变成「抛异常」。注意：这里不是原型污染（真值判断挡住了赋值，`Object.prototype` 未被改动，已实测 `protoOwnKeys` 仍为 12），所以是可用性/拒绝服务级，不是污染级。

---

## 发现 4

**file**: `src/pagination.js:15`（及 `:16`、`:20`）
**类型**: 数值参数未校验——负数被当作合法页码
**严重性**: 高

**问题**: `const safePage = Number.isInteger(page) ? page : 1;` 注释自己写了"未排除负数"。`Math.min(safePage, totalPages)` 只夹上界、不夹下界，于是 `clamped` 为负，`offset` 为负，`slice` 按**从尾部**计算，`page` 也把负数原样返回给调用方。与第 8-13 行对 `total`/`pageSize` 的严格校验形成明显不对称。

**依据**:
```
paginate(10, -3, 3)              → {page:-3, offset:-12, hasPrev:false, hasNext:true}   // 自相矛盾的状态
paginateArray([1..10], -1, 3)    → {page:-1, offset:-6, items:[5,6,7]}                  // 拿到的是倒数第 2 页
paginateArray([1..10], 0, 3)     → {page:0,  offset:-3, items:[]}                       // 静默空页
renderListView(..., {page:-1, pageSize:2}) → html:"34", pagination.page:-1              // 经 index.js 直达对外视图
```
`page` 通常来自 query string，`"2"`（字符串）会被静默降级成第 1 页，而 `-1` 却能拿到**错页数据**且 `hasPrev` 为 false——分页控件的「上一页/下一页」判定随之失效。`page:0` 与「缺值」走了不同分支（缺值→1，0→0），属假值/缺值未区分。

---

## 发现 5

**file**: `src/validate.js:8`
**类型**: 数值校验规则形状不严——`NaN`/`Infinity` 通过
**严重性**: 中

**问题**: `number: (v) => typeof v === 'number'`。`typeof NaN === 'number'`、`typeof Infinity === 'number'` 均成立，因此 `number` 规则对非有限值一律放行。旁边已有 `integer` 用 `Number.isInteger`，说明作者本意是区分数值形态，`number` 漏了 `Number.isFinite`。

**依据**:
```
validate({a:NaN},      {a:[{rule:'number'}]}) → {valid:true}
validate({a:Infinity}, {a:[{rule:'number'}]}) → {valid:true}
```

---

## 发现 6

**file**: `src/validate.js:36`（规则实现见 `:6`、`:7`）
**类型**: 数值参数 `arg` 未校验形状（NaN / 负数 / 缺值）
**严重性**: 中

**问题**: `fn(value, r.arg)` 把 `r.arg` 原样透传，而 `minLength`/`maxLength` 直接做 `v.length >= n` / `<= n`。`arg` 为 `undefined` 或 `NaN` 时比较恒为 `false`（整条规则恒失败）；`arg` 为负数时 `minLength` 恒为 `true`（**校验失效**）。未区分「缺值」与「假值」：`arg: 0` 是合法的，`arg` 缺失却不报错。

**依据**:
```
validate({a:'abc'}, {a:[{rule:'minLength'}]})           → {valid:false}   // arg 缺失 → 恒失败
validate({a:'abc'}, {a:[{rule:'minLength',arg:NaN}]})  → {valid:false}   // 同上
validate({a:'abc'}, {a:[{rule:'maxLength',arg:NaN}]})  → {valid:false}   // 同上
validate({a:'abc'}, {a:[{rule:'minLength',arg:-5}]})   → {valid:true}    // 负值 → 恒通过（失效）
```

---

## 发现 7

**file**: `src/validate.js:32`（`r` 描述符的形状）
**类型**: 外部数组元素当对象用，未校验形状
**严重性**: 中

**问题**: `for (const r of rules)` 只校验了 `rules` 是数组（第 27 行），没校验元素 `r` 是对象、不是 `null`、且 `r.rule` 是字符串。`r` 为 `null`/`undefined` 时抛的是底层原生错误；`r` 为字符串 `'required'`（很自然的写法）时报 `unknown rule: undefined`，把调用方引到完全错误的排查方向。

**依据**:
```
validate({a:1}, {a:[null]})      → THROW TypeError: Cannot read properties of null (reading 'rule')
validate({a:1}, {a:[undefined]}) → THROW TypeError: Cannot read properties of undefined (reading 'rule')
validate({a:1}, {a:['required']}) → THROW TypeError: unknown rule: undefined
validate({a:1}, {a:[5]})          → THROW TypeError: unknown rule: undefined
```

---

## 发现 8

**file**: `src/template.js:55`、`src/template.js:62`
**类型**: 上下文当 map 用，裸下标（`{{#each}}` / `{{#if}}` 取键）
**严重性**: 高

**问题**: `const list = ctx[key]` 与 `const cond = ctx[key]` 都未校验「自有属性」。`{{#if constructor}}`、`{{#if toString}}`、`{{#if hasOwnProperty}}` 在上下文**不含该键**时读到继承来的函数，为真值，于是条件块被渲染——本该隐藏的内容被输出。这与第 96-98 行「未知变量渲染为空字符串」的约定直接冲突。

**依据**:
```
compile('{{#if constructor}}LEAK{{/if}}')({})      → "LEAK"
compile('{{#if toString}}LEAK{{/if}}')({})         → "LEAK"
compile('{{#if hasOwnProperty}}LEAK{{/if}}')({})   → "LEAK"
compile('{{#if nope}}LEAK{{/if}}')({})             → ""      // 对照
```
危害具体化：模板里写 `{{#if isAdmin}}…{{/if}}` 时，任何同名原型属性（`constructor`/`toString`/`valueOf`/`hasOwnProperty`）都会让该分支无条件可见。

---

## 发现 9

**file**: `src/template.js:106`（及 `:98`）
**类型**: 路径解析未校验取值形状，原型链值被当数据输出
**严重性**: 中

**问题**: `resolvePath` 逐段 `cur = cur[seg]` 裸取，只挡了 `null` 和非 `object`，原型链上的函数/对象会被当作正常数据返回；`renderInline` 再 `String(v)` 直接拼进 HTML。

**依据**:
```
compile('[{{constructor}}]')({})    → "[function Object() { [native code] }]"
compile('[{{toString}}]')({})       → "[function toString() { [native code] }]"
compile('[{{a.constructor}}]')({a:{}}) → "[function Object() { [native code] }]"
compile('[{{__proto__}}]')({})      → "[[object Object]]"
```
`{{#each __proto__}}` 因 `Array.isArray` 拦住而为空（这是唯一被挡住的形态）。

---

## 发现 10

**file**: `src/template.js:96`、`src/template.js:98`
**类型**: 插值输出未做编码——外部数据直接进 HTML（形状检查时顺带确认的独立缺陷）
**严重性**: 严重

**问题**: `renderInline` 用 `String(v)` 原样返回，`compile` 从不调用同文件第 112 行导出的 `escapeHtml`。而 `src/index.js:17` 把 `extra`（用户数据）直接并进上下文渲染，第 111 行注释"用于用户输入的插值"成为空头承诺。

**依据**:
```
compile('{{name}}')({name:'<script>x</script>'})  → "<script>x</script>"
renderListView('<p>{{q}}</p>', [1], {extra:{q:'<img src=x onerror=alert(1)>'}}).html
  → "<p><img src=x onerror=alert(1)></p>"
```

---

## 发现 11

**file**: `src/template.js:113-118`
**类型**: 转义顺序错误——`&` 被最后替换，导致二次转义
**严重性**: 中

**问题**: 链式 `.replace` 依次处理 `<`、`>`、`"`、`'`，最后才处理 `&`。前面几步产生的 `&lt;`、`&quot;`、`&#39;` 中的 `&` 又被第 118 行再转一次，输出变成 `&amp;lt;`，页面显示为字面量 `&lt;`。

**依据**:
```
escapeHtml('<a href="x">&</a>')
  → "&amp;lt;a href=&amp;quot;x&amp;quot;&amp;gt;&amp;&amp;lt;/a&amp;gt;"
```
正确顺序要求 `&` 第一个替换。此函数目前无人调用（见发现 10），但一旦按注释启用即产生可见的转义错乱。

---

## 发现 12

**file**: `src/template.js:77`
**类型**: 嵌套块闭合匹配条件恒为假
**严重性**: 中高

**问题**: `if (o !== -1 && o < c && openTag === closeTag.replace("/","#"))`。`openTag` 是 `'{{#each '`（带尾空格），`closeTag.replace("/","#")` 得到 `'{{#each}}'`（无尾空格），二者**永不相等**，所以深度递增分支是死代码。`findMatchingClose` 因此总在第一个 `closeTag` 处返回，嵌套块被截断。

**依据**:
```
compile('{{#each a}}{{#each b}}{{this}}{{/each}}{{/each}}')({a:[{b:['x','y']}]})
  → "{{#each b}}{{this}}{{/each}}"        // 内层标签原样漏出
compile('{{#if a}}{{#if b}}X{{/if}}Y{{/if}}')({a:1,b:1})
  → "{{#if b}}XY{{/if}}"                   // 同上，且 Y 被吞进内层
// 对照：平级块正常
compile('{{#each a}}{{this}}{{/each}}-{{#each a}}{{this}}{{/each}}')({a:[1,2]}) → "12-12"
```

---

## 发现 13

**file**: `src/events.js:64`
**类型**: 集合长度当"有错误"判据——恰好 1 个监听器抛错时错误被吞掉
**严重性**: 中

**问题**: `if (errors.length > 1) throw new AggregateError(...)`。第 50 行文档承诺"错误会在全部执行完后一起抛出"，但 `errors.length === 1` 时既不抛也不上报，唯一那个异常凭空消失，调用方无法感知。

**依据**:
```
注册 1 个抛 Error('boom') 的监听器 → emit('e') 正常返回 1，无任何异常
注册 2 个抛错的监听器           → 抛 AggregateError，errors.length === 2
```

---

## 发现 14

**file**: `src/events.js:32`（配合 `:40`）
**类型**: 以 handler 为键的映射表被覆盖，导致取消订阅失效
**严重性**: 中

**问题**: `this.#onceWrappers.set(handler, wrapper)` 以原始 `handler` 为 WeakMap 键（第 32 行注释已自认"同一 handler 注册多个事件时被覆盖"）。同一个函数用 `once` 注册到两个事件时，后一个 wrapper 覆盖前一个，`off(event1, handler)` 拿到的是**另一个事件**的 wrapper，`indexOf` 落空返回 `false`，第一个监听器永远留在表里。

**依据**:
```
const h=()=>{}; b.once('a',h); b.once('b',h);
b.off('a',h) → false   // 移除失败，listenerCount('a') 仍为 1
b.off('b',h) → true    // 只有后注册的那个能移除
```
泄漏后该监听器仍会在 `a` 上被触发，而调用方以为自己已经解绑。

---

## 发现 15

**file**: `src/index.js:13`
**类型**: 选项参数解构前未校验形状
**严重性**: 中

**问题**: `{ page = 1, pageSize = 10, extra = {} } = {}` 只对 `undefined` 生效。传 `null` 时解构直接抛原生 `TypeError`（不是本模块约定的可读错误）；`extra` 不校验是否为对象，字符串会被展开成下标键；`page` 也未在此处归一化，`'2'`、`-1`、`0` 全部原样透传给 `paginateArray`（见发现 4）。

**依据**:
```
renderListView('x',[1],null)                 → THROW TypeError: Cannot read properties of null (reading 'page')
renderListView('{{0}}',[1],{extra:'ab'}).html → "a"        // 字符串被当映射表展开成 {0:'a',1:'b'}
renderListView('{{page}}',[1,2,3,4,5],{page:'2',pageSize:2}) → page 变成 1
```

---

## 模式检查结果

| 检查项（模式 4） | template.js | events.js | pagination.js | validate.js | index.js |
|---|---|---|---|---|---|
| 外部值当对象用前校验形状（null/数组/数字/字符串） | 部分：`:13` 挡住 null，但数组通过 | 无外部对象入参，不适用 | 通过（`isInteger` 严格） | 部分：`:18`/`:21` 只查 `typeof === 'object'`，**数组照样通过** | 否：`:13` 传 null 直接崩（发现 15） |
| 裸下标查表 / 原型链键（`constructor`/`__proto__`/`toString`/`valueOf`） | **有缺陷**：`:55`、`:62`、`:106`（发现 8、9） | 无缺陷：全部走 `Map`/`WeakMap`，实测 `emit('__proto__')` 正常 | 不适用（无键查表） | **有缺陷**：`:30` 读、`:32` 查规则表、`:37` 写（发现 1、2、3） | 无 |
| 数值参数：NaN / Infinity / 负数 / 小数 | 不适用 | 不适用 | **负数未拒**：`:15`/`:16` → 负 offset、错页（发现 4） | `arg` 未校验 `:36`（发现 6）；`number` 接受 NaN/Infinity `:8`（发现 5） | `page` 原样透传，不做归一化 |
| 区分「假值」(0/false/'') 与「缺值」(undefined/null) | `:98` 处理正确（0/false 正常渲染） | 不适用 | `page:0` 与缺值走同一分支但结果不同（0→空页，缺值→第1页） | `required` 的 `!== undefined && !== null` 写得对，但在原型链键上整体失效（发现 2）；`arg:0` 与缺 arg 无法区分（发现 6） | `page = 1` 默认值只覆盖 undefined |

**补充说明**：发现 10（XSS）、发现 11（转义顺序）、发现 12（嵌套块）是在追查 `String(v)` 与标签匹配的取值形状时确认的，不属于键查表类，但均为实测可复现的真实缺陷，故一并列出。`events.js` 与 `pagination.js` 在「原型链键」一项上无问题（分别用 `Map` 和纯数值计算），未做凑数式上报。

**验证脚本**（均已执行，未修改被审文件）：
- `<HOME>\AppData\Local\Temp\p4c-scratch\s1_schema.js`
- `<HOME>\AppData\Local\Temp\p4c-scratch\s2_paging.js`
- `<HOME>\AppData\Local\Temp\p4c-scratch\s3_tpl_events.js`
- `<HOME>\AppData\Local\Temp\p4c-scratch\s4_final.js`

被审文件路径：`<HOME>\AppData\Local\Temp\iso-p4-c\code\src\{template,events,pagination,validate,index}.js`，`...\iso-p4-c\code\package.json`（`{"type":"module"}`，全部为 ESM）。