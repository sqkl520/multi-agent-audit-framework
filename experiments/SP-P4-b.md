验证已完成（共 4 个脚本，位于 `%TEMP%\p4b-scratch\`）。以下是审计报告。

---

# 代码审计报告 — 模式 4「解析结果是否校验形状」

被审计文件：`<HOME>\AppData\Local\Temp\iso-p4-b\code\src\{template,events,pagination,validate,index}.js`
`package.json` 声明 `"type":"module"`，因此验证脚本以 `.mjs` 通过 `file:///` URL 直接 import 源码模块执行。

---

## 发现 1

- **file**: `src/validate.js:32`
- **类型**: 模式 4 — 把外部数据当映射表，键名来自原型链
- **严重性**: HIGH
- **问题**: `RULES[r.rule]` 使用裸下标查表，而且只做了 `typeof fn !== 'function'` 这一项检查；当 `rule` 为 `constructor`、`toString` 等继承自 `Object.prototype` 的名字时，会取到合法函数，于是校验被**整体绕过**；当 `rule` 为 `valueOf`、`hasOwnProperty` 时，则直接抛出类型错误。
- **依据**: 实测输出
  ```
  {rule:'constructor'} on value 0    -> {"valid":true,"errors":{}}
  {rule:'constructor'} on value ""   -> {"valid":true,"errors":{}}
  {rule:'constructor'} on value null -> {"valid":true,"errors":{}}
  {rule:'toString'}    on undefined  -> {"valid":true,"errors":{}}
  {rule:'valueOf'}     -> THREW TypeError: Cannot convert undefined or null to object
  {rule:'hasOwnProperty'} -> THREW TypeError: Cannot convert undefined or null to object
  {rule:'nope'}  (对照组) -> THREW TypeError: unknown rule: nope
  ```
  `Object.prototype.constructor` 是 `Object` 本身（为真值、类型为 function），`fn(value, r.arg)` 返回一个对象，这个对象被当作真值，所以 `if (!fn(...))` 永远不会进入失败分支。这个“未知规则”的防范对原型链上的名字完全失效。

## 发现 2

- **file**: `src/validate.js:37-38`
- **类型**: 模式 4 — 结果容器当作 map 用，键名未做 own-property 校验
- **严重性**: HIGH
- **问题**: `errors[field]` 同样是裸下标。若 schema 来自 `JSON.parse`，而且字段名叫 `__proto__`、`constructor`、`toString` 或 `valueOf`，那么 `errors[field]` 取到的是继承来的非数组值（为真值），于是跳过初始化，`errors[field].push(...)` 抛出 `TypeError`，整个 `validate` 崩溃；更糟的是，写 `__proto__` 时会改写 `errors` 的原型，而不是记录一条错误。
- **依据**: 实测输出
  ```
  schema own keys = ["__proto__","name"]          // JSON.parse 保留 __proto__ 为自有键
  validate({name:"ok"}, schema) => THREW TypeError: errors[field].push is not a function
  schema {constructor:[{rule:'email'}]} data {} => THREW TypeError: errors[field].push is not a function
  schema {toString:...}  => THREW ...  schema {valueOf:...} => THREW ...  schema {isPrototypeOf:...} => THREW ...
  ```
  注意第一个用例中 `name` 字段是**合法**的，仅因为 schema 里另有一个 `__proto__` 字段就整条调用崩溃——即 `valid: false` 对调用方根本无法拿到。

## 发现 3

- **file**: `src/validate.js:30`
- **类型**: 模式 4 — 外部对象取字段未区分自有属性
- **严重性**: MEDIUM
- **问题**: `const value = data[field]` 会沿原型链读取。字段名为 `toString` / `constructor` / `valueOf` 时，即使 `data` 完全没有该字段，取到的仍是继承来的函数，`required` 规则判定为“已提供”，必填校验被绕过。
- **依据**: 实测输出
  ```
  validate({}, {toString:[{rule:'required'}]})   -> {"valid":true,"errors":{}}
  validate({}, {constructor:[{rule:'required'}]}) -> {"valid":true,"errors":{}}
  validate({}, {valueOf:[{rule:'required'}]})     -> {"valid":true,"errors":{}}
  ```

## 发现 4

- **file**: `src/template.js:55`（`{{#each}}`）、`src/template.js:62`（`{{#if}}`）
- **类型**: 模式 4 — 上下文当映射表用，条件门控键名未做 own-property 校验
- **严重性**: MEDIUM
- **问题**: `const list = ctx[key]` 与 `const cond = ctx[key]` 都是裸下标。上下文里不存在的 `constructor` / `toString` / `__proto__` / `valueOf` / `hasOwnProperty` 会被判定为真，`{{#if}}` 门控对空上下文也成立；`{{#each}}` 则因为取到函数（非数组）而静默渲染成空，掩盖了“变量名写错”的真实错误。
- **依据**: 实测输出
  ```
  {{#if constructor}}     on context {} -> "<RENDERED>"
  {{#if toString}}        on context {} -> "<RENDERED>"
  {{#if __proto__}}       on context {} -> "<RENDERED>"
  {{#if hasOwnProperty}}  on context {} -> "<RENDERED>"
  {{#if anythingMissing}} on context {} -> "<>"      // 对照：正常缺失键为假
  ```

## 发现 5

- **file**: `src/template.js:105-106`
- **类型**: 模式 4 — 路径解析未限制在自有属性上
- **严重性**: LOW
- **问题**: `resolvePath` 用 `cur = cur[seg]` 逐段裸取，唯一保护是 `typeof cur !== 'object'`。单段路径的 `{{constructor}}` / `{{toString}}` / `{{hasOwnProperty}}` 会把 `Object.prototype` 上的原生函数源码字符串直接渲染进输出。巧合的是，多段路径 `{{constructor.constructor}}` 反而被 `typeof === 'object'` 挡住（`Object` 的 typeof 为 `'function'`），说明这个保护是偶然生效、并非有意设计。
- **依据**: 实测输出
  ```
  {{constructor}}      -> "function Object() { [native code] }"
  {{toString}}         -> "function toString() { [native code] }"
  {{hasOwnProperty}}   -> "function hasOwnProperty() { [native code] }"
  {{__proto__}}        -> "[object Object]"
  {{constructor.constructor}} -> ""        // typeof 检查偶然阻断
  ```

## 发现 6

- **file**: `src/pagination.js:15-16`（消费点 `:20` `offset`、`:37` `slice`）
- **类型**: 模式 4 — 数值入参只查了“是否整数”，未查范围/正负
- **严重性**: MEDIUM
- **问题**: `Number.isInteger(page) ? page : 1` 的注释自己写明“未排除负数”，而 `Math.min(safePage, totalPages)` 只设了上界、没有下界。负数页码原样进入 `offset = (clamped - 1) * pageSize`，变成负偏移传给 `Array.prototype.slice`，于是 `slice(-4, -2)` 会从数组**末尾**切出一段，返回一个既非请求页也非首页的数据切片，同时 `hasPrev` 为 `false`、`hasNext` 为 `true`，元信息与数据互相矛盾。
- **依据**: 实测输出
  ```
  page=0  -> page:0  offset:-2 items:[]          hasPrev:false
  page=-1 -> page:-1 offset:-4 items:["e","f"]   hasPrev:false   // 取到了倒数第二页
  page=-3 -> page:-3 offset:-8 items:["a","b"]   hasPrev:false
  paginate(8,-2,2)        -> {"page":-2,"totalPages":4,"offset":-6,"hasNext":true,"hasPrev":false}
  paginateArray([],-5,1)  -> {"page":-5,...,"hasNext":true,"hasPrev":false,"items":[]}   // 空数组仍报 hasNext:true
  ```

## 发现 7

- **file**: `src/validate.js:8`
- **类型**: 模式 4 — 外部数值未排除 `NaN` / `Infinity`
- **严重性**: MEDIUM
- **问题**: `number: (v) => typeof v === 'number'` 把 `NaN`、`Infinity`、`-Infinity` 全部判为合法数字。同文件里紧邻的 `integer` 用 `Number.isInteger` 恰好挡住了 `NaN`，说明这是遗漏而非有意。`NaN` 通过 `number` 校验后会污染后续算术与序列化。
- **依据**: 实测输出
  ```
  number(NaN)      -> valid=true
  number(Infinity) -> valid=true
  number(-Infinity)-> valid=true
  integer(NaN)     -> {"valid":false,...}      // 对照组：integer 正确拒绝
  ```

## 发现 8

- **file**: `src/index.js:13`
- **类型**: 模式 4 — 解构默认值不覆盖 `null`
- **严重性**: LOW
- **问题**: `renderListView(template, items, { page = 1, ... } = {})` 只对 `undefined` 生效。传 `null` 作为 options 时不会落回默认值，而是直接抛 `TypeError`。同仓库的 `validate`（`validate.js:18,21`）与 `compile`（`template.js:13`）都显式写了 `=== null` 判断，此处是唯一缺口。另外传入非对象（如 `5`）时被静默当默认值处理，与 `null` 抛错的行为不一致。
- **依据**: 实测输出
  ```
  renderListView('{{page}}', ['a'], null) -> THREW TypeError: Cannot read properties of null (reading 'page')
  renderListView('{{page}}', ['a'], 5)    -> {"html":"1",...}     // 静默走默认值
  ```

## 发现 9

- **file**: `src/validate.js:31-35`
- **类型**: 模式 4 — 数组元素形状未校验
- **严重性**: LOW
- **问题**: `rules` 只校验了“是数组”，其元素 `r` 未校验是否为带 `rule` 的对象。`[null]` 在 `r.rule` 处抛原生 `TypeError: Cannot read properties of null`，而不是本模块统一的 `unknown rule:` 语义；`['required']`（字符串元素）则得到 `unknown rule: undefined`，报错信息完全丢失了原始输入。此外 `typeof schema !== 'object'` 让数组 `[]` 也通过 schema 校验，静默返回 `valid:true`。
- **依据**: 实测输出
  ```
  rules=[null]        -> THREW TypeError: Cannot read properties of null (reading 'rule')
  rules=['required']  -> THREW TypeError: unknown rule: undefined
  validate({f:1}, []) -> {"valid":true,"errors":{}}     // 数组被当作合法 schema
  ```

## 发现 10

- **file**: `src/validate.js:36`（`r.arg` 消费点；规则体在 `:6-7`）
- **类型**: 模式 4 — 规则参数未校验形状
- **严重性**: LOW
- **问题**: `r.arg` 原样传给规则函数，没有校验是否为有限非负整数。`minLength` 的 `arg = -1` 让空字符串通过校验；`arg = NaN` 让任何输入都失败（比较恒为 `false`）；`arg = "3"` 因隐式转换碰巧能工作——三种非法输入产生三种不同行为，全部静默。
- **依据**: 实测输出
  ```
  minLength arg=-1  on ""     -> {"valid":true,"errors":{}}      // 空串通过
  minLength arg=NaN on "abc"  -> {"valid":false,...}             // 恒失败
  minLength arg="3" on "ab"   -> {"valid":false,...}             // 隐式转换碰巧正确
  ```

---

## 模式检查结果

| # | 检查点（模式 4 提问） | 位置 | 结论 |
|---|---|---|---|
| 1 | 把外部数据当 map 用，键名是 `constructor`/`__proto__`/`toString`/`valueOf` 等原型链名字 | `validate.js:32` `RULES[r.rule]` | **失败** — 校验被绕过（`constructor`/`toString`），或崩溃（`valueOf`/`hasOwnProperty`） |
| 2 | 结果容器用裸下标写入，字段名来自外部 | `validate.js:37-38` `errors[field]` | **失败** — `__proto__`/`constructor`/`toString` 触发 `TypeError`，正常调用整体崩溃 |
| 3 | 从外部对象取字段时是否只取自有属性 | `validate.js:30` `data[field]` | **失败** — `required` 对 `toString`/`constructor`/`valueOf` 字段永远通过 |
| 4 | 上下文当映射表，条件键是否 own-property | `template.js:55,62` `ctx[key]` | **失败** — `{{#if constructor}}` 在空上下文下渲染真值分支 |
| 5 | 路径逐段取值是否限制在自有属性 | `template.js:106` `cur[seg]` | **失败** — `{{constructor}}` 泄露原生函数源码；多段被 `typeof` 偶然挡住 |
| 6 | 数值入参是否排除负数/越界 | `pagination.js:15-16,20,37` | **失败** — 负页码产生负 offset，`slice` 从末尾切片，元信息自相矛盾 |
| 7 | 数值入参是否排除 `NaN`/`Infinity` | `validate.js:8` `number` 规则 | **失败** — 三者均判为合法数字 |
| 8 | 解析/解构结果若为 `null` 会怎样 | `index.js:13` 解构默认值 | **失败** — `null` 绕过默认值直接抛错；非对象则静默忽略 |
| 9 | 数组元素形状是否校验 | `validate.js:31-35` | **失败** — `[null]` 抛原生错误；数组 `[]` 被当合法 schema |
| 10 | 规则参数形状是否校验 | `validate.js:36` `r.arg` | **失败** — 负值/`NaN`/字符串产生三种不同的静默行为 |
| — | `typeof x === 'object'` 时 `null` 是否穿透 | `template.js:13`、`validate.js:18,21` | **通过** — 三处均显式写了 `x === null` 短路 |
| — | `emit` 的监听器列表 / `EventBus` 的 handler 表 | `events.js:18,38,53` | **通过** — 使用 `Map`，不受原型链键名影响（`events.js` 无模式 4 缺陷） |
| — | `#each` 的 item 展开是否可污染原型 | `template.js:58` `{...ctx, this:item, ...item}` | **通过** — 对象展开走 `CreateDataProperty`，实测 `__proto__` 键不污染 `Object.prototype` |

---

### 附注（非模式 4，仅静态观察，未计入发现）

`events.js` 有两处与本次检查方法无关、但代码注释已自承的缺陷：`once()` 在 `:32` 用 `WeakMap` 以 `handler` 为键，同一函数注册到两个事件时后者覆盖前者，`off()` 会移除错误的 wrapper；`emit()` 在 `:67` 返回 `list.length`（原始长度）而非实际执行数，并发 off 时数字失真。按要求未对其做验证脚本。
