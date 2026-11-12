# 代码审计报告：模式 4「解析结果是否校验形状」

审计范围：`<HOME>\AppData\Local\Temp\iso-p4-a\code\src\` 下 5 个 .js 文件（template.js、events.js、pagination.js、validate.js、index.js）及 package.json（`{"name":"fixture2","version":"1.0.0","type":"module"}`）。所有验证脚本在 `%TEMP%\p4-scratch\` 下用 node v26.12.1 执行，未做任何构建/安装操作，未修改被审文件。

---

## 发现 1

- **file**: `src/validate.js:32`
- **类型**: 解析结果是否校验形状 — 把外部数据当作 map 用时命中继承自原型链的键名
- **严重性**: HIGH
- **问题**: 查规则表用 `RULES[r.rule]` 裸下标，没有 `hasOwnProperty` 守卫，`toString` / `constructor` / `isPrototypeOf` 这些原型链成员被当作合法规则，导致校验静默放行或抛意外异常。
- **依据**: `RULES` 是 `Object.freeze({...})` 冻结的字面量对象（第 3 行），仍继承 `Object.prototype`。实测：

```
rule bogus         => THROW TypeError: unknown rule: bogus      (未知规则本应如此)
rule toString      => {"valid":true,"errors":{}}                ← 被当成合法规则，静默通过
rule constructor   => {"valid":true,"errors":{}}                ← 同上
rule isPrototypeOf => {"valid":false,"errors":{"a":["a failed isPrototypeOf"]}}
rule valueOf       => THROW TypeError: Cannot convert undefined or null to object
rule hasOwnProperty=> THROW TypeError: Cannot convert undefined or null to object
```

本该报 `unknown rule: toString` 的情况返回了 `valid:true`；`valueOf` / `hasOwnProperty` 被当成断言函数调用，直接崩在 `Object.prototype` 方法上。第 33 行 `typeof fn !== 'function'` 只挡住真正的未知名字，挡不住这些。

## 发现 2

- **file**: `src/validate.js:37`
- **类型**: 解析结果是否校验形状 — 外部数据作 map 用时键名为 `__proto__`
- **严重性**: HIGH
- **问题**: 错误容器 `const errors = {}` 与回填 `errors[field]`，在 `field === '__proto__'` 时读到 `Object.prototype` 而非 `undefined`，导致缺字段的错误被静默丢弃，或字段确实校验失败时对原型对象 `.push` 而崩。
- **依据**: schema 可由 `JSON.parse` 得来，`__proto__` 会是 own key（实测 `Object.keys(schema) = ["__proto__"]`，`hasOwnProperty('__proto__') = true`）：

```
// schema = JSON.parse('{"__proto__":[{"rule":"required"}]}'), data = {}
validate(...) => {"valid":true,"ownKeys":[],"proto":{}}          ← 缺字段却判 valid，错误凭空消失

// schema = JSON.parse('{"__proto__":[{"rule":"minLength","arg":5}]}'), data = {"__proto__":"ab"}，必然失败
validate(...) => THROW TypeError: errors[field].push is not a function
```

第 37 行 `if (!errors[field])` 中 `errors['__proto__']` 恒为 `Object.prototype`（真值），数组永远不创建；第 38 行 `.push` 对非数组调用直接抛错。并且 `Object.keys(errors)` 里不会有 `__proto__`，即使不崩，错误也进不了第 42 行 `Object.keys(errors).length === 0` 的 `valid` 统计。

## 发现 3

- **file**: `src/validate.js:30`
- **类型**: 解析结果是否校验形状 — 读字段时未区分自有属性与继承属性
- **严重性**: MEDIUM
- **问题**: `const value = data[field]` 直接下标读取，schema 中形如 `constructor` / `toString` 的字段名会取到原型链上的函数而非用户数据，使 `required` 判定失真。
- **依据**:

```
// schema = {constructor:[{rule:'required'}]}, data = {}  （字段实际不存在）
=> {"valid":true,"errors":{}}                              ← 误判为「已提供」

// 对照：schema = {constructorx:[{rule:'required'}]}, data = {}
=> {"valid":false,"errors":{"constructorx":["constructorx failed required"]}}
```

同样 schema 定义了一个字段、同样 data 缺该字段，只因字段名恰好是 `Object.prototype.constructor`，结果就从 invalid 变成 valid。

## 发现 4

- **file**: `src/pagination.js:15`
- **类型**: 解析结果是否校验形状 — 外部数值参数未校验取值范围
- **严重性**: HIGH
- **问题**: 注释自认「未排除负数」：`Number.isInteger(page) ? page : 1` 只校验整数性，`0` / 负数 / `-0` 原样进入计算，产出负 `offset`、错误 `page`，并在 `paginateArray` 里被 `slice` 解释为「从尾部倒着取」，静默返回错误页的数据。
- **依据**（`total=100, pageSize=10`；数组 `[1..10], pageSize=3`）：

```
paginate(100, -5, 10)  => {"page":-5,"totalPages":10,"offset":-60,...}   ← 负 offset
paginate(100, 0, 10)   => {"page":0,"offset":-10,...}
paginate(10, -0, 3)    => {"page":0,"offset":-3,...}                     ← -0 被当合法值

paginateArray([1..10], -1, 3) => {"page":-1,"offset":-6,"items":[5,6,7]} ← 第 -1 页返回第 2 页数据
paginateArray([1..10], -2, 3) => {"page":-2,"offset":-9,"items":[2,3,4]}
paginateArray([1..10],  0, 3) => {"page":0,"offset":-3,"items":[]}       ← 空页却 hasNext:true
paginateArray(['a'..'f'], -10, 2) => {"page":-10,"offset":-22,"items":[]}
```

负 `offset` 时 `items.slice(-6, -3)` 返回尾部区间，调用方无法区分「非法参数」与「正常数据」。对照第 8、11 行 `total` / `pageSize` 均有下界检查，唯独 `page` 没有。`NaN` / `Infinity` / `'2'` / `1.5` 则被静默降级为第 1 页（`{"page":1,...}`），同样不报错。

## 发现 5

- **file**: `src/index.js:13`
- **类型**: 解析结果是否校验形状 — 解构默认值只覆盖 `undefined`，未校验对象形状
- **严重性**: MEDIUM
- **问题**: `renderListView(template, items, { page = 1, pageSize = 10, extra = {} } = {})` 用解构默认值充当参数校验，但默认值只对 `undefined` 生效；`null` 直接抛无意义 TypeError，字符串/数组等非对象却能悄过。
- **依据**:

```
renderListView('t', [], null)   => THROW TypeError: Cannot read properties of null (reading 'page')
renderListView('t', [], 'abc')  => {"html":"t","pagination":{...page:1...}}   ← 非对象被接受
renderListView('{{x}}', [], {extra: null})  => {"html":"","pagination":{...}}  ← extra 未校验
renderListView('{{x}}', [], {extra: 5})     => {"html":"","pagination":{...}}
```

调用方传 `null`（如一个可为 null 的 options 变量）时报错指向 `.page` 读取，与真正的参数错误无关；字符串 options 被静默当作空配置。

## 发现 6

- **file**: `src/template.js:62`
- **类型**: 解析结果是否校验形状 — 键名来自模板、查值走原型链
- **严重性**: MEDIUM
- **问题**: `{{#if k}}` / `{{#each k}}` 用 `ctx[key]` 直接取值（第 55、62 行），`resolvePath` 的 `cur = cur[seg]`（第 106 行）同理，均未用 `hasOwnProperty` 限制，传入看似「空」的上下文 `{}` 时 `constructor` / `toString` / `hasOwnProperty` 都会命中 `Object.prototype`，条件为真并把内置函数源码渲染进输出。
- **依据**（context = `{}`）：

```
{{#if constructor}}LEAK{{/if}}       => "LEAK"
{{#if toString}}LEAK{{/if}}          => "LEAK"
{{#if hasOwnProperty}}LEAK{{/if}}    => "LEAK"
{{constructor}}      => "function Object() { [native code] }"
{{toString}}         => "function toString() { [native code] }"
{{__proto__}}        => "[object Object]"

context 为数组 [1,2,3] 时：{{#if push}}YES{{/if}}{{length}} => "YES3"   ← 命中 Array.prototype.push
context 为 Date 时：{{getTime}} => "function getTime() { [native code] }"
```

`{{constructor.constructor}}` 返回 `""` 只是因为第 105 行拦下了函数类型（`typeof cur !== 'object'`），并非有意隔离。

---

## 范围外的确认缺陷（不属于模式 4，不计入判定表）

以下四项在验证中被实测确认，但不是「形状校验」维度，单列以免混淆：

1. `src/template.js:118` — `escapeHtml` 把 `&` 的替换放在最后，前面生成的 `&lt;` / `&gt;` / `&#39;` / `&quot;` 被二次转义：`escapeHtml('<b>')` → `"&amp;lt;b&amp;gt;"`，`escapeHtml("o'Brien")` → `"o&amp;#39;Brien"`。浏览器会显示为字面量 `&lt;`，转义等于失效。
2. `src/template.js:77` — `openTag === closeTag.replace("/","#")` 恒为假（`'{{#if '` 带尾空格，`'{{/if}}'.replace` 得 `'{{#if}}'`），`depth` 永不递增，嵌套块解析错乱：`{{#if a}}A{{#if b}}B{{/if}}C{{/if}}` → `"A{{#if b}}BC{{/if}}"`。同类 `{{#each}}` 嵌套同样错乱。
3. `src/events.js:64` — `if (errors.length > 1)` 使「单个监听器抛错」被静默吞掉：一个抛错监听器 + 一个正常监听器时 `emit` 返回 `2`，错误既不抛出也不记录；只有 ≥2 个错误才拼 AggregateError。
4. `src/events.js:32` — `#onceWrappers` 以 handler 为键（`WeakMap`），同一 handler 注册到两个事件时后一次覆盖前一次，导致 `off` 失效：`once('a',h); once('b',h); off('a',h)` 返回 `false`，`a`、`b` 监听器数仍各为 1（泄漏）。第 32 行注释已自述。

## 模式检查结果

| 文件 | 命中 | 说明 |
|---|---|---|
| `src/template.js` | 命中 | 发现 6；`ctx[key]`、`resolvePath` 未区分自有属性与原型链属性 |
| `src/events.js` | 未命中 | `on()` 已对 `event` 类型/非空、`handler` 类型做形状校验，该维度未发现缺陷 |
| `src/pagination.js` | 命中 | 发现 4；`page` 未做范围校验，负数与 `0`/`-0` 污染 `offset` 和 `slice` |
| `src/validate.js` | 命中 | 发现 1、2、3；规则表与错误容器按裸键名索引，字段取值走原型链 |
| `src/index.js` | 命中 | 发现 5；解构默认值不校验 `null` 与非对象 options |
