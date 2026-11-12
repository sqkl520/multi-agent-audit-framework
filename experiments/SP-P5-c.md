验证完成。三个脚本已确认全部关键行为，以下是报告。

---

# 代码审计报告 —— 模式 5「能力是否真的实现了」

审计范围：`iso-p5-c/code/src/` 下 5 个模块（235 行）+ `package.json`。
验证方式：3 个 node 脚本（`%TEMP%\p5c-scratch\t1.mjs`、`t2.mjs`、`t3.mjs`），全部实测输出为准。

---

## 发现 1

**file**: `src/template.js:96-99`（另有 `src/template.js:111`、`src/index.js:3`、`src/index.js:8`）
**类型**: 声称的能力从未被调用 / 安全缺陷（XSS）
**严重性**: 严重

**问题**: `escapeHtml` 的 JSDoc 明确写着「**用于用户输入的插值**」，`index.js` 第 3 行 import 它、第 8 行导出它，但**整个代码库里没有任何一处调用它**。真正的插值路径 `renderInline`（第 96-99 行）直接 `String(v)` 拼进输出，全程无转义。声称的「安全插值」这个能力是空的。

**依据**:
- 全库 grep `escapeHtml` 只有 4 处命中：定义（template.js:112）、JSDoc（111）、import（index.js:3）、export（index.js:8）——**0 个调用点**。
- `template.js:98`：`return v === undefined || v === null ? '' : String(v);` —— 无 `escapeHtml` 调用。
- 实测：`compile('{{name}}')({name:'<img src=x onerror=alert(1)>'})` → 原样输出 `"<img src=x onerror=alert(1)>"`。
- 放大路径：`index.js:13` 的公开 API `renderListView(template, items, …)` 把 `items` 直接送进 `compile` 渲染，用户数据零转义直达 HTML。

---

## 发现 2

**file**: `src/template.js:113-118`
**类型**: 能力实现错误（转义函数本身是坏的）
**严重性**: 高

**问题**: `escapeHtml` 先替换 `<` `>` `"` `'`，**最后**才替换 `&`。先转义后转义，导致所有已生成的实体会被 `&` 那一遍二次转义，输出 `&amp;lt;` 而非 `&lt;`。即使调用方真的用了它（如发现 1 建议的那样），页面会显示字面量 `&lt;b&gt;` 而不是 `<b>`。

**依据**: 实测 `escapeHtml('<')` → `"&amp;lt;"`（期望 `&lt;`）；`escapeHtml('&lt;')` → `"&amp;lt;"`；`escapeHtml('<b>')` → `"&amp;lt;b&amp;gt;"`。`&` 必须第一个替换（第 118 行应提到第 114 行之前）。

---

## 发现 3

**file**: `src/template.js:77`
**类型**: 声称的能力未实现（嵌套块解析）
**严重性**: 高

**问题**: 第 2 行注释声称支持 `{{#if}}...{{/if}}` 和 `{{#each}}...{{/each}}` 两种块，`findMatchingClose` 里写了一段深度计数逻辑来支持**同名块嵌套**，但深度递增条件永远为假，深度机制完全没生效。

**依据**:
- 第 77 行：`if (o !== -1 && o < c && openTag === closeTag.replace("/","#"))`
  - `openTag` 是 `'{{#if '`（**带尾部空格**，见第 36 行）
  - `closeTag.replace("/","#")` 得到 `'{{#if}}'`（**无尾部空格**）
  - 两者**永远不相等**，`depth++` 分支是死代码，`depth` 恒为 0。
- 实测 `compile('{{#if a}}A{{#if b}}B{{/if}}C{{/if}}')({a:1,b:1})` → `"A{{#if b}}BC{{/if}}"`：内层开始标签被当作纯文本输出，`{{/if}}` 字面量泄漏进 HTML。跨类型嵌套（if 套 each）正常（`"[pq]"`），因为不同类型不会走进错误分支。

---

## 发现 4

**file**: `src/events.js:64-67`
**类型**: 声称的能力未实现（异常传播），且注释与行为矛盾
**严重性**: 高

**问题**: 第 50 行 JSDoc 声称「单个监听器抛错不影响其他监听器，**错误会在全部执行完后一起抛出**」。实现只在 `errors.length > 1` 时抛 `AggregateError`，**恰好 1 个监听器抛错时错误被完全吞掉**，`emit` 正常返回。调用方无法感知失败，属于静默失败。

**依据**:
- 第 64 行 `if (errors.length > 1) {` —— 条件应为 `> 0`。
- 实测：1 个监听器抛 `boom` + 1 个正常监听器 → `emit` 返回 `2`，无任何异常，第二个监听器执行。2 个抛错 → 才抛 `AggregateError: 2 handlers failed for "e"`。

---

## 发现 5

**file**: `src/pagination.js:15-16`
**类型**: 能力未实现（页码下界未钳制），参数注释自认
**严重性**: 高

**问题**: 第 15 行注释「未排除负数」自己承认了缺陷。`safePage` 只处理非整数，负数/0 原样通过，第 16 行 `Math.min` 只钳上界不钳下界，产出**负 offset**；`paginateArray` 用负 offset 做 `slice` 后返回空数组，数据静默丢失。`@returns` 声称返回可用的分页信息，实际 offset 不可用于 SQL `LIMIT/OFFSET`。

**依据**:
- 实测 `paginate(100, -5, 10)` → `{"page":-5,"offset":-60,"hasNext":true,"hasPrev":false}`；`paginate(100, 0, 10)` → `{"page":0,"offset":-10}`。
- 实测 `paginateArray(25项, -5, 10).items` → `[]`；`page=0` → `{"page":0,"offset":-10,...,"items":[]}`。25 条数据返回空页，且 `hasNext:true` 诱导翻页。

---

## 发现 6

**file**: `src/validate.js:33`
**类型**: 声称的能力未实现（未知规则拦截被原型链绕过）
**严重性**: 中

**问题**: `RULES` 是普通对象字面量（第 3 行 `Object.freeze({...})`，冻结的是自有属性，不阻断原型链）。第 33 行用 `typeof fn !== 'function'` 做「未知规则必须抛错」的判断，`r.rule` 取到 `constructor` / `toString` / `isPrototypeOf` 等**原型链继承成员**时 `typeof` 为 `'function'`，校验被跳过且**静默判定通过**。声明式 schema 里的拼写错误/恶意字段可以完全关闭该项校验。

**依据**:
- 实测 `validate({a:1}, {a:[{rule:'constructor'}]})` → `{"valid":true,"errors":{}}`（校验静默空转）。
- `validate({a:1},{a:[{rule:'toString'}]})` → `{"valid":true,"errors:{}}`。
- `rule:'valueOf'` → `TypeError: Cannot convert undefined or null to object`（内部错误外泄）。
- 对比 `listRules()` 只返回 6 个合法名，说明设计意图是白名单。
- 修复方向：`Object.prototype.hasOwnProperty.call(RULES, r.rule)` 或改用 `new Map` / `Object.create(null)`。

---

## 发现 7

**file**: `src/events.js:32`、`src/events.js:40`
**类型**: 声称的能力未实现（`off` 无法移除 once 监听器）
**严重性**: 中

**问题**: `#onceWrappers` 以**原始 handler 为 key** 存映射（第 32 行），且注释自己写着「同一 handler 注册多个事件时被覆盖」。后果：`off(event, handler)`（第 40 行查表）只对**最后一次** `once` 注册有效，对先前事件必然失配返回 `false` 并留下泄漏的监听器。更严重的是 wrapper 触发后**从不从 WeakMap 删除**，这条陈旧映射会持续劫持该 handler 后续所有普通 `on` 注册——用户用 `off` 永远摘不掉。

**依据**:
- 实测 A：`once('a',h)` + `once('b',h)` → `off('a',h)` 返回 `false`，`listenerCount('a')` 仍为 1；`off('b',h)` 返回 `true`。
- 实测 B（泄漏）：`once('a',h)` → `emit('a')` 触发 → 再 `on('a',h)` → `off('a',h)` 返回 **`false`**，`listenerCount('a')` 仍为 **1**（期望 `true` / `0`），监听器永久残留。
- 修复方向：key 改为 `${event}\0${handler}` 组合，或 wrapper 内部 `#onceWrappers.delete(handler)`。

---

## 发现 8

**file**: `src/template.js:58`
**类型**: 参数/上下文语义被覆盖（作用域污染）
**严重性**: 中

**问题**: `each` 用 `{ ...ctx, this: item, ...item }` 合并上下文，把数据对象的字段**展开到父作用域之上并覆盖同名变量**，且 item 自带的 `this` 键能反向覆盖引擎注入的 `this`。注释与语法声称 `this` 指向当前项（第 2 行 `{{#each items}}` 的循环语义），实际不可靠。

**依据**:
- 实测 `compile('{{#each l}}{{v}}{{/each}}')({v:'PARENT', l:[{v:'ITEM'}]})` → `"ITEM"`，父作用域的 `v` 被 item 无声覆盖。
- 实测 `compile('{{#each l}}[{{this}}]{{/each}}')({l:[{this:'HIJACK', id:7}]})` → `"[HIJACK]"`，`this` 被数据劫持。

---

## 发现 9

**file**: `src/template.js:62-63`（对照 `src/template.js:96-97`）
**类型**: 能力不一致（点路径只实现了一半）
**严重性**: 中

**问题**: 插值用 `resolvePath` 完整支持 `a.b.c` 点路径（第 96-97、102-109 行），但 `{{#if}}` / `{{#each}}` 的 key 走第 55 行 `ctx[key]` / 第 62 行 `ctx[key]` 的**单键直取**，完全不经过 `resolvePath`。同一个模板引擎里存在两套变量查找规则：`{{user.name}}` 能出值，`{{#if user.active}}` 永远为假、`{{#each data.items}}` 永远为空——**静默不报错**，最难排查的一类缺陷。

**依据**:
- 实测 `compile('{{user.name}}')({user:{name:'Ada'}})` → `"Ada"`。
- 实测 `compile('{{#if user.active}}YES{{/if}}')({user:{active:true}})` → `""`（期望 `"YES"`）。
- 实测 `compile('{{#each data.items}}[{{x}}]{{/each}}')({data:{items:[{x:1}]}})` → `""`（期望 `"[1]"`）。

---

## 发现 10

**file**: `src/validate.js:8`
**类型**: 规则实现不完整（`number` 名不副实）
**严重性**: 中

**问题**: `number: (v) => typeof v === 'number'` 把 `NaN` 和 `Infinity` 判定为合法数字。`number` 规则声称校验「数字」，实际放行了非有限值，下游数值计算/序列化会出问题（`NaN` 写入 JSON 变 `null`）。注意同文件的 `integer` 规则（第 9 行）因用 `Number.isInteger` 而正确拒绝了 `NaN`，两条规则行为不一致。

**依据**: 实测 `validate({n:NaN}, {n:[{rule:'number'}]})` → `{"valid":true}`；`{n:Infinity}` → `{"valid":true}`；对照 `{n:NaN}` + `integer` → `{"valid":false,"errors":{"n":["n failed integer"]}}`。

---

## 发现 11

**file**: `src/validate.js:4`
**类型**: 规则实现不完整（`required` 接受空白串）
**严重性**: 低

**问题**: `required: (v) => v !== undefined && v !== null && v !== ''` 只拒绝空字符串字面量，纯空白串（`'   '`）判为通过。表单场景下「必填」能力实际失效。

**依据**: 实测 `validate({s:'   ', x:1}, {s:[{rule:'required'}]})` → `{"valid":true,"errors":{}}`。

---

## 模式检查结果

| # | 声称的载体 | 声称的内容 | 实际实现 | 结论 |
|---|---|---|---|---|
| 1 | `template.js:111` JSDoc / `index.js:3,8` import+export | `escapeHtml`「用于用户输入的插值」 | 全库 0 调用点；`renderInline:96-99` 直接 `String(v)` 拼接 | **空转**（发现 1，严重） |
| 2 | `template.js:113-118` `escapeHtml` 实现 | 转义 HTML 特殊字符 | `&` 最后替换，先转义后转义 → `&amp;lt;` | **实现错误**（发现 2，高） |
| 3 | `template.js:2` 注释 / `template.js:77` 深度计数 | 支持 `{{#if}}`/`{{#each}}` 块，含同名嵌套 | 第 77 行 `openTag === closeTag.replace(...)` 恒假，`depth++` 死代码 | **空转**（发现 3，高） |
| 4 | `events.js:50` JSDoc | 「错误会在全部执行完后一起抛出」 | 第 64 行 `errors.length > 1`，单错被吞 | **未实现**（发现 4，高） |
| 5 | `pagination.js:5` `@returns` / `pagination.js:15` 注释 | 返回可用 offset/limit 分页信息 | 负数/0 页码未钳下界，offset 为负，slice 返回空数组 | **未实现**（发现 5，高） |
| 6 | `validate.js:33-35` 未知规则抛错 | 非白名单规则一律 `TypeError` | `typeof` 判断被原型链绕过，`constructor`/`toString` 静默通过 | **未实现**（发现 6，中） |
| 7 | `events.js:9` `@returns {() => void}` / `events.js:36` `off` | 取消订阅、移除监听器 | `#onceWrappers` 按 handler 单 key 覆盖（第 32 行注释自认），陈旧映射致 `off` 失配 | **未实现**（发现 7，中） |
| 8 | `template.js:2` `{{#each}}` 循环语义 | `this` 指向当前项 | 第 58 行 item 展开覆盖父作用域并覆盖 `this` | **被削弱**（发现 8，中） |
| 9 | `template.js:96-97` 点路径支持 | `[\w.]+` 支持 `a.b.c` | 仅 inline 走 `resolvePath`；块标签第 55/62 行直取单键 | **半实现**（发现 9，中） |
| 10 | `validate.js:8` `number` 规则 | 校验数字 | `typeof v === 'number'`，放行 `NaN`/`Infinity`；与 `integer` 不一致 | **不完整**（发现 10，中） |
| 11 | `validate.js:4` `required` 规则 | 必填校验 | 仅拒 `''`，空白串通过 | **不完整**（发现 11，低） |
| — | `pagination.js:34` `paginate` → `paginateArray` | 内部被调用 | 有真实调用 | 正常 |
| — | `index.js:5` `paginate/paginateArray`、`validate/listRules` | 导出 | 均已正确 import/export，被 `renderListView` 或外部消费 | 正常（`listRules` 属公开 API，未计为缺陷） |
| — | `template.js:102` `resolvePath` | 路径解析 | 被 `renderInline:97` 真实调用 | 正常 |
| — | `events.js:67` 注释「返回原始长度，非实际执行数」 | — | 因第 57 行复制数组，返回恒等于实际执行数，**注释描述已过期** | 观察项（无行为危害，未列为发现） |

**核心结论**: 11 个真实缺陷全部集中在「声明了但没做/做错了」这一类。最高优先级是发现 1（`escapeHtml` 全库零调用的 XSS 缺口）和发现 3、4、5（三处死代码/错误条件导致的静默失效）——这四处都不会抛错，测试也最容易漏过。发现 2、6 顺带构成可利用面：转义函数本身是坏的，而 schema 校验可被 `constructor` 之类的键整体关闭。

验证脚本位于 `<HOME>\AppData\Local\Temp\p5c-scratch\`（`t1.mjs`、`t2.mjs`、`t3.mjs`），执行命令为 `node <path>`。审计过程中未修改任何被审文件，未执行 mvn/gradle/npm/pip/cargo。
