All findings verified. Cleaning up scratch state is unnecessary; here is the report.

## 发现 1
- **file**: `src/template.js:77`
- **类型**: 功能正确性 / 模板解析
- **严重性**: CRITICAL
- **问题**: `findMatchingClose` 的深度计数条件永远不成立，嵌套块在第一个闭合标签处被截断，且闭标签被当作普通文本输出。
- **依据**: `openTag === closeTag.replace("/","#")` 比较的是 `'{{#if '` 与 `'{{#if}}'`（后者由 `'{{/if}}'` 替换得到，缺尾随空格），恒为 false，`depth++` 永不执行。实测：`compile('{{#if a}}A{{#if b}}B{{/if}}{{/if}}')({a:1,b:1})` → `"A{{#if b}}B{{/if}}"`；`{a:0,b:1}` → `"{{/if}}"`（外层为假却泄漏出 `{{/if}}`）；嵌套 each 同样失效 → `"{{#each ys}}[{{this}}]{{/each}}"`。非嵌套块正常（`flat-if`→`"yes"`）。

## 发现 2
- **file**: `src/template.js:118`
- **类型**: 安全 / 编码正确性
- **严重性**: HIGH
- **问题**: `escapeHtml` 把 `&` 的替换放在最后，导致所有实体被二次转义，输出内容被破坏且不可用于正确转义。
- **依据**: 实测 `escapeHtml('<b>')` → `"&amp;lt;b&amp;gt;"`；`escapeHtml('<script>"x"</script>')` → `"&amp;lt;script&amp;gt;&amp;quot;x&amp;quot;..."`。正确顺序要求 `&` 最先替换。这是该模块唯一的转义入口（注释写明"用于用户输入的插值"），因此转义能力实际不可用。

## 发现 3
- **file**: `src/template.js:96`
- **类型**: 安全 / XSS
- **严重性**: HIGH
- **问题**: `renderInline` 直接把变量值 `String(v)` 拼进结果，从不转义；配合 `index.js` 的 `renderListView` 会把用户数据原样输出到 HTML。
- **依据**: 实测 `compile('<p>{{name}}</p>')({name:'<img src=x onerror=alert(1)>'})` → `"<p><img src=x onerror=alert(1)></p>"`；`renderListView('{{#each items}}<li>{{name}}</li>{{/each}}', [{name:'<img src=x onerror=alert(1)>'}])` → `"<li><img src=x onerror=alert(1)></li>"`。且因发现 2，调用方即使手动调用 `escapeHtml` 也会得到二次转义的错误结果。

## 发现 4
- **file**: `src/validate.js:37`
- **类型**: 健壮性 / 原型链污染
- **严重性**: HIGH
- **问题**: `errors` 是普通对象，字段名若与 `Object.prototype` 成员同名（`constructor`/`toString`/`__proto__`/`valueOf`/`hasOwnProperty`），`if (!errors[field])` 会因原型属性为真而跳过初始化，随后 `.push` 抛 TypeError 使整个校验崩溃。
- **依据**: 实测 `validate({}, { toString: [{rule:'minLength',arg:3}] })` → `TypeError: errors[field].push is not a function`；`constructor`、`__proto__` 同样崩溃。若规则通过则不报错但返回错误的 `valid:true`（未真正校验）。

## 发现 5
- **file**: `src/events.js:64`
- **类型**: 错误处理 / 静默失败
- **严重性**: HIGH
- **问题**: 只有**超过一个**监听器抛错时才抛出 `AggregateError`；恰好一个监听器抛错时异常被完全吞掉，与该方法注释"错误会在全部执行完后一起抛出"矛盾。
- **依据**: 实测 `on('e',()=>{throw new Error('boom')}); emit('e')` → 返回 `1`，无任何抛出；两个监听器抛错才 `THREW AggregateError | 2 handlers failed for "e"`。监听器失败对调用方完全不可见。

## 发现 6
- **file**: `src/pagination.js:15`
- **类型**: 输入校验 / 边界
- **严重性**: HIGH
- **问题**: 负数 `page` 未被排除（注释自认"未排除负数"），也未做下限钳制，产生负 `offset` 和错误的 `hasNext/hasPrev`；`paginateArray` 因此返回空页。
- **依据**: 实测 `paginate(25,0,10)` → `{"page":0,"offset":-10,"hasNext":true,"hasPrev":false}`；`paginate(25,-3,10)` → `{"page":-3,"offset":-40,...}`；`paginateArray(items,-3,10).items` → `[]`；`paginateArray(items,-1,10)` → `[6..15]`（负偏移被 slice 当作从尾部计数，返回了错误的中间页）。

## 发现 7
- **file**: `src/events.js:32`
- **类型**: 资源泄漏 / 状态管理
- **严重性**: MEDIUM
- **问题**: `#onceWrappers` 以原始 handler 为键，同一个 handler 在多个事件上 `once` 时后写覆盖前写，导致先注册的事件无法通过 `off` 取消，并永久泄漏监听器。
- **依据**: 实测 `once('a',h); once('b',h); off('a',h)` → `{"removedFromA":false,"countA":1,"countB":1}`（取消失败）；触发 `emit('a')` 后 → `{"countA":0,"countB":1}`，b 上的包装器残留。另外第 32 行的 `set` 在 `on` 校验之前执行，`on` 抛错时还会留下未注册的悬空映射。

## 发现 8
- **file**: `src/pagination.js:15`
- **类型**: 输入校验 / 一致性
- **严重性**: MEDIUM
- **问题**: `total`、`pageSize` 非法时抛 `RangeError`，而 `page` 非法（非整数、`NaN`、字符串）却被静默改写为 1，同一函数的校验策略不一致，调用方无法感知参数错误。
- **依据**: 实测 `paginate(25,'2',10)` → `{"page":1,...}`；`paginate(25,NaN,10)` → `{"page":1,...}`；`paginate(25,2.5,10)` → `{"page":1,...}`；对比 `paginate(-1,1,10)` 会抛出 `RangeError`。

## 发现 9
- **file**: `src/validate.js:8`
- **类型**: 校验缺陷
- **严重性**: MEDIUM
- **问题**: `number` 规则用 `typeof v === 'number'`，`NaN` 和 `Infinity` 均被判定为合法数字。
- **依据**: 实测 `validate({n:NaN},{n:[{rule:'number'}]})` → `{"valid":true,"errors":{}}`；`{n:Infinity}` 同样 → `{"valid":true}`。应配合 `Number.isFinite`。

## 发现 10
- **file**: `src/template.js:55`
- **类型**: 功能缺失 / 行为不一致
- **严重性**: MEDIUM
- **问题**: 块标签的键直接 `ctx[key]` 取值，不支持点号路径；而内联插值 `resolvePath` 支持 `a.b`，同一套语法两种语义。
- **依据**: 实测 `compile('{{#each a.b}}[{{this}}]{{/each}}')({a:{b:[1,2]}})` → `""`；`compile('{{#if a.b}}yes{{/if}}')({a:{b:1}})` → `""`。行 55 与行 62 均为直接下标访问。

## 发现 11
- **file**: `src/template.js:105`
- **类型**: 安全 / 信息泄露
- **严重性**: MEDIUM
- **问题**: `resolvePath` 沿原型链自由下钻，模板可读取到 `constructor`、`__proto__` 等内建成员并把函数源码渲染进输出，模板作者可借此探测运行环境。
- **依据**: 实测 `compile('{{constructor}}')({})` → `"function Object() { [native code] }"`；`compile('{{__proto__.constructor}}')({})` 同样输出该源码。行 105 仅判断 `typeof cur !== 'object'`，未做自有属性（`hasOwn`）限制。

## 发现 12
- **file**: `src/events.js:67`
- **类型**: 返回值错误
- **严重性**: MEDIUM
- **问题**: `emit` 返回的是遍历时快照之外的**实时数组长度**，当监听器在回调中 `off` 掉自己或他人时，返回值与实际执行数量不符（代码注释亦承认"返回的是原始长度，非实际执行数"）。
- **依据**: 实测 `once('e',h); on('e',h); emit('e')` → 返回 `1` 但实际执行 `2` 个；回调内 `off` 掉另一个监听器时同样 → `returned:1, executed:2`。行 67 读的是已被 splice 修改的 `list.length`。

## 发现 13
- **file**: `src/validate.js:37`
- **类型**: 输入健壮性
- **严重性**: LOW
- **问题**: 规则项为 `null`/非对象时，`r.rule` 读取直接抛原生 `TypeError`，而不是本模块统一风格的 `unknown rule` 提示。
- **依据**: 实测 `validate({}, {a:[null]})` → `THREW TypeError | Cannot read properties of null (reading 'rule')`，抛出点在行 32 的 `RULES[r.rule]`。

## 发现 14
- **file**: `src/index.js:13`
- **类型**: 参数处理
- **严重性**: LOW
- **问题**: `renderListView` 的第三个参数用默认值解构，显式传 `null` 时不会回退到默认值而直接抛错，与传 `undefined` 的行为不一致。
- **依据**: 实测 `renderListView('x', [], null)` → `THREW TypeError | Cannot read properties of null (reading 'page')`；`renderListView('x', [])` 正常返回。

## 发现 15
- **file**: `src/validate.js:4`
- **类型**: 校验缺陷
- **严重性**: LOW
- **问题**: `required` 只排除 `undefined`/`null`/`''`，空数组与纯空白字符串都被判为"已填写"。
- **依据**: 实测 `validate({s:'   '},{s:[{rule:'required'}]})` → `{"valid":true}`；`validate({s:[]},{s:[{rule:'required'}]})` → `{"valid":true}`。

---

**审计说明**：共写 4 个验证脚本（`%TEMP%\c4-scratch\t1.mjs`–`t4.mjs`），全部结论均有实测输出支撑。未修改任何被审文件，未执行 `npm`/`mvn` 等命令，未读取受限目录。最高优先级修复项为发现 1（嵌套块解析彻底失效）与发现 2+3 组合（转义功能双重失效导致 XSS 无法防御）。
