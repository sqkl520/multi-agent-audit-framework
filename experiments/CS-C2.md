# 审计报告

4 个验证脚本已用 node 实际执行（v26.12.1），下面每条都有实测依据。只报我实测或从源码能直接确认的缺陷。

---

## 发现 1
- **file**: `src/template.js:70-87`（`findMatchingClose`），表现于 `src/template.js:45`
- **类型**: 逻辑正确性 / 嵌套块解析
- **严重性**: CRITICAL
- **问题**: `findMatchingClose` 的深度计数条件 `o < c && openTag === closeTag.replace("/","#")` 中，`openTag` 是 `'{{#each '`（带尾空格）、`closeTag.replace` 是 `'{{#each'`（无空格），两者永远不相等，因此 `depth++` 分支永不执行——嵌套的 `{{#if}}`/`{{#each}}` 全部按第一个 `{{/each}}`/`{{/if}}` 闭合。
- **依据**: 实测 `compile('{{#if a}}A{{#if b}}B{{/if}}C{{/if}}')({a:1,b:1})` → `"A{{#if b}}BC{{/if}}"`（内层标签未解析、外层条件内容丢失）。`compile('{{#each rows}}<{{#each cells}}{{v}}{{/each}}>{{/each}}')({rows:[{cells:[{v:1},{v:2}]},{cells:[{v:3}]}]})` → `"<{{#each cells}}{{v}}<{{#each cells}}{{v}}>{{/each}}"`；三层嵌套 `{{#each a}}{{#each b}}{{#each c}}{{v}}{{/each}}{{/each}}{{/each}}` → `"{{#each b}}{{#each c}}{{v}}{{/each}}{{/each}}"`（数据完全没渲染出来，只把原始标签吐回）。

## 发现 2
- **file**: `src/events.js:64-66`
- **类型**: 错误处理 / 静默失败
- **严重性**: HIGH
- **问题**: 只有 `errors.length > 1` 才抛 `AggregateError`；单个监听器抛错时异常被完全吞掉，`emit` 正常返回，调用方无法感知失败。
- **依据**: 实测 `b.on('e',()=>{throw new Error('boom')}); b.emit('e')` → 返回 `1`，无任何异常抛出，错误丢失。对照：两个监听器抛错时正确抛 `AggregateError: 2 handlers failed for "e"`。

## 发现 3
- **file**: `src/pagination.js:15-16`
- **类型**: 输入校验 / 负数未校验（源码注释自认）
- **严重性**: HIGH
- **问题**: `safePage` 只过滤非整数，未排除负数与 0；`Math.min` 只做上界钳制缺下界，导致 `offset` 为负，`Array.prototype.slice` 的负索引语义把数组**末尾元素**当成第一页返回。
- **依据**: 实测 `paginate(10,0,10)` → `{page:0, offset:-10, hasNext:true, hasPrev:false}`；`paginate(10,-5,10)` → `{page:-5, offset:-60}`。`paginateArray([0..9], -1, 3)` → `items:[4,5,6]`（应为第 1 页 `[0,1,2]` 或抛错），`paginateArray(arr,-2,4).items` → `[0,1]`。经 `renderListView` 透传同样成立：`{page:-1,pageSize:3}` → `pagination.page=-1`，`html="2,3,4,"`。

## 发现 4
- **file**: `src/template.js:96-99`
- **类型**: 安全 / XSS（输出编码缺失）
- **严重性**: HIGH
- **问题**: `renderInline` 直接 `String(v)` 拼接，全程不做 HTML 转义；`escapeHtml` 虽然导出但库内无任何调用点（`grep` 仅命中定义与 re-export），模板引擎默认输出即未编码，等于默认不安全。
- **依据**: 实测 `compile('<p>{{user}}</p>')({user:'<img src=x onerror=alert(1)>'})` → `"<p><img src=x onerror=alert(1)></p>"`；`{{#each rows}}<li>{{name}}</li>{{/each}}` 传入 `<script>x</script>` 原样输出。`grep -rn escapeHtml src/` 仅 3 处：定义 `template.js:112` 与 `index.js:3,8` 的 import/export，无使用。

## 发现 5
- **file**: `src/template.js:112-119`
- **类型**: 逻辑正确性 / 转义顺序错误
- **严重性**: MEDIUM
- **问题**: `escapeHtml` 把 `& → &amp;` 放在最后一步，先替换的 `<`、`>`、`"`、`'` 产生的实体中新增的 `&` 会被再次替换，导致双重编码。
- **依据**: 实测 `escapeHtml('<a href="x">&</a>')` → `"&amp;lt;a href=&amp;quot;x&amp;quot;&amp;gt;&amp;amp;lt;/a&amp;gt;"`（`<` 应得 `&lt;`，实得 `&amp;lt;`）；`escapeHtml('&lt;')` → `"&amp;lt;"`。

## 发现 6
- **file**: `src/validate.js:32-35`
- **类型**: 安全 / 原型链属性查找绕过校验
- **严重性**: HIGH
- **问题**: `RULES[r.rule]` 走普通属性查找可达 `Object.prototype`，`typeof fn === 'function'` 检查因此被绕过：`rule:'constructor'`/`'toString'` 取到原生函数并返回真值，字段被判定为**校验通过**；`rule:'valueOf'`/`'hasOwnProperty'` 则在调用时抛非预期 `TypeError`。`Object.freeze` 不阻止原型链查找。
- **依据**: 实测 `validate({a:'x'},{a:[{rule:'constructor'}]})` → `{"valid":true,"errors":{}}`（未知规则应为报错）；`{rule:'toString'}` 同样 `valid:true`；`{rule:'valueOf'}` → `THREW TypeError: Cannot convert undefined or null to object`。等价于用未校验的字符串从外部拼 schema 时可静默跳过规则。

## 发现 7
- **file**: `src/validate.js:37-38`
- **类型**: 逻辑正确性 / 原型键污染
- **严重性**: MEDIUM
- **问题**: `errors` 是普通对象字面量，字段名为 `__proto__` / `constructor` / `toString` 时 `errors[field]` 命中原型链成员，导致 `if (!errors[field])` 判断失效或 `push` 不存在。同时 `__proto__` 字段的校验失败会被完全吞掉，返回 `valid:true`。
- **依据**: 实测 `validate({},{'__proto__':[{rule:'required'}]})` → `{"valid":true,"errors":{}}`（必填项缺失却判定通过）；`validate({'toString':''},{toString:[{rule:'required'}]})` → `THREW TypeError: errors[field].push is not a function`。

## 发现 8
- **file**: `src/events.js:32`（配 `events.js:40`）
- **类型**: 逻辑正确性 / 状态映射覆盖
- **严重性**: MEDIUM
- **问题**: `#onceWrappers` 以 handler 函数为键，同一 handler 注册到多个事件时后者覆盖前者，`off` 只能反查到最后一个 wrapper；`off(event, handler)` 对先前事件的注册项失效，无法取消，监听器泄漏。注释已承认“被覆盖”。
- **依据**: 实测 `b3.once('a',h); b3.once('b',h); b3.off('a',h)` → 返回 `false`，`listenerCount('a')` 仍为 `1`（该 once 监听器无法通过公开 API 移除）。注意：`once` 返回的退订闭包仍可用（实测为 0），泄漏仅发生在按 handler 手动 `off` 的路径。

## 发现 9
- **file**: `src/events.js:40-43`
- **类型**: 逻辑正确性 / 双重注册下的 off 不一致
- **严重性**: LOW
- **问题**: 同一 handler 同时用 `on` 和 `once` 注册时，`off` 优先解析到 once wrapper，只移除 once 那条，`on` 那条无法用同一 handler 再移除。
- **依据**: 实测 `b2.on('e',h); b2.once('e',h)` → 注册后 `listenerCount=2`；`off('e',h)` 返回 `true` 但 `listenerCount` 仍为 `1`，再调用 `off` 已无效（无 wrapper 时 target=handler，仍需一次调用才能移除——语义对调用方不可预期）。

## 发现 10
- **file**: `src/events.js:67`
- **类型**: 契约错误 / 返回值语义
- **严重性**: LOW
- **问题**: `emit` 注释与实现不符——返回的是快照后的原始 `list.length`，而实际执行数因监听器内部 `off`/`on` 可不同，无法用于统计。
- **依据**: 实测：注册 5 个监听器，第 5 个内部 `off` 掉第 4 个，`emit` 返回 `4`，实际执行 `5` 个（`['a','b','c','d','e']`）。另一例：第 1 个监听器移除第 2 个，`emit` 返回 `1`，而 `listenerCount` 事后仍为 `1`。

## 发现 11
- **file**: `src/template.js:102-109`（配 `template.js:58`）
- **类型**: 安全 / 原型链读取 + 上下文遮蔽
- **严重性**: MEDIUM
- **问题**: 两处相关问题。其一，`resolvePath` 不做 `hasOwnProperty` 过滤，可读出继承属性（`__proto__`、`constructor`、原型上的业务数据），模板被视为纯数据却具备原型链读能力。其二，`renderBlock` 中 `{ ...ctx, this: item, ...item }` 让每个 item 的字段覆盖外层上下文，item 里的 `page`/`totalPages` 会静默劫持 `renderListView` 注入的分页变量。
- **依据**: 实测 `compile('{{__proto__.toString}}')({})` → `"function toString() { [native code] }"`，`compile('{{constructor}}')({})` → `"function Object() { [native code] }"`，`compile('{{secret}}')(Object.create({secret:'PROTO_SECRET'}))` → `"PROTO_SECRET"`。遮蔽实测：模板 `{{page}}/{{totalPages}} {{#each items}}{{page}}{{totalPages}}({{id}}){{/each}}`，items 含 `{page:'X',totalPages:'Y'}` → `"1/1 XY(1) 11(2)"`（分页值被 item 覆盖）。负面的：`{{constructor.constructor}}` 返回 `""`，无法直接取到 `Function`，故不构成 RCE，仅定为信息泄露/变量劫持。

## 发现 12
- **file**: `src/index.js:13`
- **类型**: 健壮性 / 默认参数不解构 null
- **严重性**: LOW
- **问题**: `{ page = 1, ... } = {}` 只对 `undefined` 生效；显式传 `null` 时抛 `TypeError`，而 `items`/`template` 的非法值都有明确校验，此处不一致。
- **依据**: 实测 `renderListView('{{page}}', [1], null)` → `THREW TypeError: Cannot read properties of null (reading 'page')`。

## 发现 13
- **file**: `src/validate.js:9`（`number` 规则）
- **类型**: 逻辑正确性 / 数值边界
- **严重性**: LOW
- **问题**: `typeof v === 'number'` 放行 `NaN` 与 `Infinity`；`NaN` 作为数值字段通过校验，后续计算必然产生 `NaN` 污染。
- **依据**: 实测 `validate({a:NaN},{a:[{rule:'number'}]})` → `{"valid":true}`；`{a:Infinity}` 同样 `valid:true`。相邻的 `integer` 规则因 `Number.isInteger` 正确拒绝了 `NaN`（`{"valid":false}`），说明这是 `number` 规则单独的实现遗漏。

---

## 已排查但判为不是缺陷（避免误报）
- `{{#if}}` 用真值判断（`[]`、`0`、`''` 处理）：属设计选择，实测行为自洽（`[]` 为真），未报。
- `{{}}` 与游离 `{{/if}}` 原样输出：与文件头注释“未知变量渲染为空、不抛错”的宽松策略一致，未报。
- `paginate(0,1,10).totalPages === 1`：空集合显示 1 页是常见约定，未报。
- `compile`/`render` 的类型校验、`pageSize < 1` 抛错：实测正确（`pageSize:0` 正确抛 `RangeError`）。
- `validate` 中 `r` 为 `null` 或缺少 `rule` 键时抛 `TypeError`：属调用方 schema 错误，抛错可接受，未计入。

## 优先级建议
1. 先修发现 1（嵌套块——引擎核心功能不可用）与发现 4（默认不转义，直接 XSS）。
2. 再修发现 6/7（校验可被静默绕过）与发现 3（负页码返回错误数据，且不报错）。
3. 发现 2 的吞错与发现 5 的双重编码属于低成本的正确性修复。

验证脚本位于 `<HOME>\AppData\Local\Temp\c2-scratch\p1.mjs` 至 `p4.mjs`；被审文件未做任何修改。
