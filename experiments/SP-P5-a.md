代码审计已完成。我在 `%TEMP%\p5-scratch\` 下建了临时脚本（t1–t10.mjs），全部结论都有实际运行输出支撑。

---

## 发现 1

- **file**: `src/template.js:95-100`（`renderInline`）、`src/template.js:111-119`（`escapeHtml`）
- **类型**: 能力是否真的实现（函数名/注释声称 vs 实际调用）
- **严重性**: CRITICAL
- **问题**: `escapeHtml` 的注释写着「用于用户输入的插值」，但它在整个代码库里没有任何调用点——`renderInline` 直接把变量 `String(v)` 原样拼进输出，插值完全不转义，任何模板渲染都是 XSS 直通管道。
- **依据**: 全库 grep `escapeHtml` 只有三处：`template.js:112` 定义、`index.js:3` import、`index.js:8` re-export，零调用。实测：

```
$ node t1.mjs
raw interp: <p><img src=x onerror=alert(1)></p>

$ node t6.mjs
renderListView('<ul>{{#each items}}<li>{{name}}</li>{{/each}}</ul>', [{name:'<b>a</b>'}...])
=> {"html":"<ul><li><b>a</b></li><li>b</li></ul>", ...}
```

---

## 发现 2

- **file**: `src/template.js:113-118`
- **类型**: 函数名声称的能力 vs 实际行为
- **严重性**: MEDIUM
- **问题**: `escapeHtml` 把 `&` 的替换放在最后一步，导致先插入的 `&lt;`/`&quot;` 里的 `&` 被二次转义，输出是双重转义的结果；该函数一旦被接上（见发现 1），页面会显示字面量 `&lt;b&gt;` 而不是安全地渲染 `<b>`。
- **依据**:
```
$ node t1.mjs
escapeHtml("<")   = &amp;lt;     // 期望 &lt;
escapeHtml("&")   = &amp;       // 期望 &amp;（这条对）
escapeHtml("a&b") = a&amp;b
```
正确顺序要求 `&` 必须第一个替换。函数头注释「转义 HTML 特殊字符」在含 `<`、`"`、`'` 的输入上不成立。

---

## 发现 3

- **file**: `src/template.js:70-87`（关键行 `:77`）
- **类型**: 能力是否真的实现（`findMatchingClose` 的嵌套深度计数是死代码）
- **严重性**: HIGH
- **问题**: `findMatchingClose` 靠 `depth` 支持同名块的嵌套，但第 77 行的开标签判定 `openTag === closeTag.replace("/","#")` 恒为假：`'{{#if '`（尾部有空格）永远不等于 `'{{#if}}'`（`replace` 只把 `/` 换成 `#`，`}}` 不会变成空格）。`depth++` 分支永远不执行，函数退化为「找第一个闭标签」，任何同类块嵌套都会被截断，内层标签原样漏进输出。
- **依据**:
```
$ node t4.mjs
nested if     => "X{{#if b}}YZ{{/if}}"        // 期望 "XYZ"
each in each  => "{{#each cells}}{{this}}{{#each cells}}{{this}};{{/each}}"
nested if (经 renderListView) => "A{{#if b}}B{{/if}}"
```
`if` 套 `each` 这类异名嵌套能过，只是因为压根用不到 depth 分支——即整个 `depth` 机制是空的。

---

## 发现 4

- **file**: `src/template.js:102-108`（关键行 `:106`）
- **类型**: 参数/路径解析的能力边界
- **严重性**: MEDIUM
- **问题**: `resolvePath` 用 `cur = cur[seg]` 逐段取值，不限制原型链。`compile` 的文档说「未知变量渲染为空字符串」，但 `{{constructor}}`、`{{__proto__.constructor}}` 这类并非上下文变量的键会取到 `Object.prototype` 上的成员并被 `String()` 输出函数源码。
- **依据**:
```
$ node t1.mjs
{{constructor}}          => "function Object() { [native code] }"
{{toString}}             => "function toString() { [native code] }"
{{__proto__.constructor}}=> "function Object() { [native code] }"
```
与第 6 行「未知变量渲染为空字符串」的承诺直接冲突。

---

## 发现 5

- **file**: `src/events.js:52-68`（关键行 `:64`）
- **类型**: 注释声称的能力 vs 实际行为
- **严重性**: HIGH
- **问题**: JSDoc（`:49-50`）承诺「错误会在全部执行完后一起抛出」，但代码只在 `errors.length > 1` 时抛 `AggregateError`。**恰好一个**监听器抛错时既不抛也不上报，`emit` 正常返回，错误被静默吞掉——这正是最常见的场景。
- **依据**:
```
$ node t2.mjs
C) emit returned 1 <- no throw, error swallowed      // 单个 handler throw
D) threw AggregateError errors: 2                    // 两个 handler throw 才抛
```
调用方无法感知单监听器失败。

---

## 发现 6

- **file**: `src/events.js:32` 与 `:40`（`#onceWrappers` 以 handler 为键）
- **类型**: 配置/数据结构名声称的能力 vs 实际语义
- **严重性**: HIGH
- **问题**: `#onceWrappers` 用 `WeakMap<handler, wrapper>` 存储，同一 `handler` 注册到多个事件时后写覆盖前写（`:32` 的注释自己承认了）。后果是 `off(event, handler)`（`:40`）拿到的是**最后一次**注册的 wrapper，解绑首个事件时 `indexOf` 找不到目标：`off` 返回 `false` 但监听从没被移除，`once` 的「只触发一次」和取消订阅能力双双失效。
- **依据**:
```
$ node t7.mjs
H) off(a,h) = false | a count = 1 | b count = 1
H) fired: 2                     // 期望 off 后 a 不再触发
```
```
$ node t2.mjs
E) off(b,h) returned false | listenerCount(b) = 1
E) handler ran anyway: 1        // removeAll 后再注册的 handler 无法 off
```
`on()` 返回的取消订阅闭包在 `once` + 多事件组合下同样是坏的。

---

## 发现 7

- **file**: `src/events.js:67`
- **类型**: 注释声称的返回值 vs 实际返回值
- **严重性**: LOW
- **问题**: `return list.length` 旁边的注释说「返回的是原始长度」，但它在循环之后读取的是**已被监听器改动过**的当前长度——既不是实际执行数，也不是原始长度。三种含义都不是。
- **依据**:
```
$ node t2.mjs
F) emit returned 1 but actually executed 2   // 第一个 handler 里 off 了第二个
```

---

## 发现 8

- **file**: `src/pagination.js:15-16`（`:14` 的 `totalPages` 与之配合）
- **类型**: 边界条件声称的能力 vs 实际行为（只钳上界）
- **严重性**: HIGH
- **问题**: 第 15 行注释「未排除负数」正是缺陷本身：`safePage` 只过滤非整数，`clamped = Math.min(safePage, totalPages)` 只压上界。负数或 0 页码原样进入 `offset = (clamped - 1) * pageSize`，产生负 offset；`paginateArray` 的 `items.slice(offset, offset + limit)` 于是从数组**末尾**取数据，同时 `hasNext` 还报 `true`。`renderListView` 直接继承该行为。
- **依据**:
```
$ node t3.mjs
page  -1 {"page":-1,"offset":-6,"limit":3,"hasNext":true,"hasPrev":false}
page   0 {"page":0,"offset":-3,...,"hasNext":true,"hasPrev":false}
paginateArray(arr, -1, 3) => {"page":-1,"offset":-6,"items":["e","f","g"]}   // 取到了末尾元素

$ node t10.mjs
page arg -1 -> html "567"  pagination {"page":-1,"hasNext":true,...}
page arg 0  -> html ""     pagination {"page":0,"hasNext":true,...}
```
`@returns` 声称返回可用的 `page/offset`，但非法入参得到的是越界数据而不是钳制到 1。

---

## 发现 9

- **file**: `src/validate.js:37-38`
- **类型**: 普通对象被当作字典使用的实现缺陷
- **严重性**: MEDIUM
- **问题**: `errors` 是普通对象字面量，`if (!errors[field]) errors[field] = []` 会命中原型链上的成员。字段名取 `constructor` 时 `errors['constructor']` 是 `Object` 构造函数（真值），跳过数组初始化后直接 `.push()` 崩溃——校验器对一个合法 JSON 字段名抛出内部 `TypeError`，而不是返回 `{valid:false, errors}`。
- **依据**:
```
$ node t8.mjs
K) THROW TypeError : errors[field].push is not a function
// 输入: validate({ constructor: null }, { constructor: [{ rule: 'required' }] })
```

---

## 发现 10

- **file**: `src/validate.js:32-35`（关键行 `:33`）
- **类型**: 参数名/校验语义声称的能力 vs 实际行为
- **严重性**: MEDIUM
- **问题**: `RULES[r.rule]` 走原型链而非自有属性，所以 `typeof fn !== 'function'` 这道「unknown rule」检查可被 `constructor`/`toString` 绕过：前者被当成合法规则函数调用并**静默通过**，后者调用后抛内部错误。未知规则名应当统一报 `TypeError: unknown rule: xxx`。
- **依据**:
```
$ node t9.mjs
rule=constructor -> {"valid":true,"errors":{}}     // 非法规则被接受
rule=toString    -> {"valid":true,"errors":{}}
rule=hasOwnProperty THROW TypeError Cannot convert undefined or null to object
listRules: ["required","email","minLength","maxLength","number","integer"]   // constructor 不在其中，却被接受
```
`listRules()` 自己声称的合法规则集与 `RULES[...]` 的实际可解析集合不一致。

---

## 发现 11

- **file**: `src/validate.js:8`
- **类型**: 规则名声称的能力 vs 实际行为
- **严重性**: LOW
- **问题**: `number` 规则只判断 `typeof v === 'number'`，`NaN` 通过校验。作为表单校验规则，「number」放行 `NaN` 属于能力缺失（同文件 `integer` 用了 `Number.isInteger`，说明作者区分了这两类）。
- **依据**:
```
$ node t5.mjs
10) number NaN -> true
```

---

## 发现 12

- **file**: `src/index.js:13-24`
- **类型**: 导出/返回字段声称的能力 vs 实际调用链
- **严重性**: MEDIUM
- **问题**: `renderListView` 的返回字段叫 `html`，语义上直接可插入 DOM，但它在 `:17` 只做 `render({...extra, items, ...})`，从不经过同文件 `:8` 导出的 `escapeHtml`，也不在文档里声明输出未转义。这是发现 1 的消费端：只要调用方按字段名与注释的理解使用，用户数据即原样进入 HTML。同时 `pagination` 只回传 `page/totalPages/hasNext/hasPrev`，`offset/limit` 被丢弃，分页与数据源无法对齐（当页码为负时更明显，见发现 8）。
- **依据**:
```
$ node t6.mjs
{"html":"<ul><li><b>a</b></li><li>b</li></ul>","pagination":{"page":1,"totalPages":1,"hasNext":false,"hasPrev":false}}
$ node t10.mjs
page arg -1 -> html "567" pagination {"page":-1,"totalPages":4,"hasNext":true,"hasPrev":false}
```

---

## 模式检查结果

| 文件 | 模式 5 结果 | 命中要点 |
|---|---|---|
| `src/template.js` | 命中 | `escapeHtml` 零调用（称"用于用户输入的插值"）；转义顺序致双重转义；`findMatchingClose` 的 depth 恒假、嵌套解析能力为空；`resolvePath` 走原型链违背"未知变量渲染为空字符串" |
| `src/events.js` | 命中 | `emit` 承诺"错误一起抛出"但单错被吞；`#onceWrappers` 以 handler 为键使 `off` 静默失败；`emit` 返回值三种含义都不是 |
| `src/pagination.js` | 命中 | 注释自认"未排除负数"，`Math.min` 只钳上界，负 offset 让 `slice` 从数组尾部取数 |
| `src/validate.js` | 命中 | `RULES[...]` 与 `errors[...]` 均走原型链：非法规则被静默接受、`constructor` 字段使校验器崩溃、`number` 放行 `NaN` |
| `src/index.js` | 命中 | `html` 字段的输出从不经过同文件导出的 `escapeHtml`；`pagination` 丢弃 `offset/limit` |

补充说明：`index.js` 中的 `extra` 展开顺序（`:17`）经实测是正确的——`extra.page` 会被真实 `page` 覆盖，不计为缺陷。审计全程未执行任何构建/包管理命令，未修改被审目录文件；临时脚本仅位于 `<HOME>\AppData\Local\Temp\p5-scratch\`。
