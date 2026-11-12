验证脚本已全部执行完毕（共 4 个）。以下是审计报告。

---

## 发现 1

- **file**: `src/index.js:17`（配套 `src/template.js:98`）
- **类型**: 导出名/注释声称的能力是空的（`escapeHtml` 声称“用于用户输入的插值”，但渲染路径从不调用）
- **严重性**: CRITICAL
- **问题**: 唯一声称负责 HTML 转义的能力 `escapeHtml`（template.js:111「用于用户输入的插值」）在全库没有任何调用点，`renderListView` 把用户数据原样拼进 HTML，构成 XSS。
- **依据**:
  - Grep 全库：`escapeHtml` 仅出现在 `template.js:112` 的定义与 `index.js:3,8` 的 import/re-export，**零次调用**。
  - `template.js:98` 渲染逻辑是 `return v === undefined || v === null ? '' : String(v);`——无任何转义。
  - 实测：`compile('<p>{{name}}</p>')({name:'<img src=x onerror=alert(1)>'})` → `"<p><img src=x onerror=alert(1)></p>"`
  - 实测：`compile('{{#each items}}[{{this.name}}]{{/each}}')({items:[{name:'<script>'}]})` → `"[<script>]"`
  - `index.js:17` 的 `render({...extra, items: paged.items, ...})` 直接返回该 html，即公开入口 `renderListView` 就是 XSS 通道。

---

## 发现 2

- **file**: `src/template.js:118`
- **类型**: 函数名声称（`escapeHtml` 真的转义了吗）
- **严重性**: HIGH
- **问题**: `&` 的替换放在最后，导致先被插入的 `&lt;` `&gt;` `&quot;` `&#39;` 再次被转义，输出全部双重转义。
- **依据**:
  - 替换顺序 114→118 为 `<` `>` `"` `'` `&`，`&` 最后执行。
  - 实测：`escapeHtml('<b>x</b>')` → `"&amp;lt;b&amp;gt;x&amp;lt;/b&amp;gt;"`（期望 `&lt;b&gt;x&lt;/b&gt;`）
  - 实测：`escapeHtml("Tom & Jerry")` → `"Tom &amp; Jerry"`（唯一正确的输入形态）
  - 实测：`escapeHtml("' onmouseover=x")` → `"&amp;#39; onmouseover=x"`
  - 即：凡是含 `< > " '` 的输入（正是它的全部用途）都被破坏，浏览器会显示成字面量 `&lt;`。该函数即使被接上（发现 1）也是坏的。

---

## 发现 3

- **file**: `src/template.js:77`
- **类型**: 注释/函数名声称（`findMatchingClose` 声称做“匹配闭合”）
- **严重性**: HIGH
- **问题**: 嵌套深度判断条件 `openTag === closeTag.replace("/", "#")` 恒为 `false`，深度计数永不递增，同名块嵌套时在第一个 `{{/…}}` 处提前截断，模板源码泄漏进输出。
- **依据**:
  - 静态：`openTag = '{{#each '`（尾随空格），`closeTag.replace('/','#') = '{{#each}}'`（尾部 `}}`），二者永不相等 ⇒ 第 77 行条件恒假 ⇒ 第 78–79 行的 `depth++` 是死代码。
  - 实测 嵌套 each：`{{#each outer}}<{{#each inner}}{{v}}{{/each}}>{{/each}}` → `"<{{#each inner}}{{v}}<{{#each inner}}{{v}}>{{/each}}"`（原始模板标签出现在结果中，数据 A/B/C 全丢）。
  - 实测 嵌套 if：`{{#if a}}A{{#if b}}B{{/if}}A2{{/if}}` → `"A{{#if b}}BA2{{/if}}"`。
  - 对照组 单层 if → `"A"`、单层 each 正常，证明缺陷只在同名嵌套。

---

## 发现 4

- **file**: `src/events.js:64`
- **类型**: JSDoc 声称（`emit`：「错误会在全部执行完后一起抛出」）
- **严重性**: HIGH
- **问题**: 只有 `errors.length > 1` 才抛 `AggregateError`；恰好一个监听器抛错时异常被静默吞掉，调用方完全感知不到失败。
- **依据**:
  - 实测：3 个监听器、第 1 个 `throw new Error('boom-1')` → `emit` 返回 `3`，**未抛出**，其余 2 个照常执行。
  - 实测：2 个监听器都抛错 → 抛 `AggregateError`，`errors.length === 2`。
  - 即 `errors.length === 1` 分支无任何处理，与注释「一起抛出」直接矛盾。

---

## 发现 5

- **file**: `src/events.js:32`（失效点在 `src/events.js:40`）
- **类型**: 参数名/注释声称（`off(event, handler)` 声称能按 handler 移除；`once` 声称返回可取消订阅函数）
- **严重性**: HIGH
- **问题**: `#onceWrappers` 用 **handler 本身**做键，同一 handler 用于多个事件时后写覆盖前写；`off` 因此找不到部分 wrapper，监听器永久泄漏且无法通过公开 API 移除。
- **依据**:
  - 实测：`once('a',fn); once('b',fn)` → 计数 `[1,1]`；`off('a',fn)` → 返回 `false`，计数仍 `[1,1]`（'a' 上的 wrapper 永久残留，只能靠 emit 触发自我清理）。
  - 实测：`on('m',fn)` + `once('n',fn)` 后 `off('m',fn)` → 返回 `false`，`listenerCount('m')` 仍为 `1`（普通监听器也被误指向 wrapper 而删不掉）。
  - 源代码第 32 行注释「同一 handler 注册多个事件时被覆盖」自认了该问题，但未提示 `off` 随之失效与泄漏后果。

---

## 发现 6

- **file**: `src/pagination.js:15`（后果在 `:20` 与 `paginateArray` 的 `:37`）
- **类型**: 参数名/注释声称（`page` 参数被读入但未被校验；`@returns` 声称给出 `offset`）
- **严重性**: HIGH
- **问题**: `page` 只做了「是否整数」兜底、**未做下界钳制**（第 15 行注释自认「未排除负数」），负数页码产生负 `offset`，`Array.slice` 负下标从尾部取数，静默返回一页**真实存在但完全错误**的数据。
- **依据**:
  - 实测：`paginate(100, -5, 10)` → `{page:-5, offset:-60, hasNext:true, hasPrev:false}`（`hasPrev` 也错）。
  - 实测：对 `[1..100]` 调 `paginateArray(data, -5, 10)` → `page:-5, offset:-60`，`items` 为 `[41,42,...,50]`——**看起来像正常一页**，实为尾段数据，无任何报错。
  - 实测：`page=0` → `offset:-10`，`paginateArray` 返回 `[]`，被误判为「空页」。
  - 上界被 `Math.min` 钳制（`page=11` → `page:10`）而下界没有，形成单向防护。

---

## 发现 7

- **file**: `src/validate.js:8`
- **类型**: 规则名声称（规则 `number` 声称校验“数字”）
- **严重性**: MEDIUM
- **问题**: `number` 规则用 `typeof v === 'number'`，`NaN` 与 `Infinity` 均通过校验；与同库 `integer` 使用 `Number.isInteger` 的严格度不一致。
- **依据**:
  - 实测：`validate({a: NaN}, {a:[{rule:'number'}]})` → `{"valid":true,"errors":{}}`
  - 实测：`validate({a: Infinity}, {a:[{rule:'number'}]})` → `{"valid":true,"errors":{}}`
  - 实测：`number('123')` → `valid:false`（字符串一侧反而是对的，说明缺陷专指非有限数）

---

## 发现 8

- **file**: `src/validate.js:32`
- **类型**: 注释声称（第 33–35 行声称对未知规则抛 `TypeError: unknown rule`）
- **严重性**: MEDIUM
- **问题**: `RULES[r.rule]` 是普通属性查找，会沿原型链命中 `toString` / `constructor` / `valueOf` 等；这类「未知规则」不仅不报错，还会被当作函数调用且返回值恒真，导致校验恒通过。
- **依据**（静态推断，对象字面量 + `Object.freeze` 不阻断原型链查找）:
  - `RULES['toString']` → `Object.prototype.toString`，`typeof === 'function'` ⇒ 通过第 33 行的守卫。
  - `fn(value, r.arg)` 以 `this === undefined` 调用 → 返回 `"[object Undefined]"`（truthy）⇒ 第 36 行 `!fn(...)` 为假 ⇒ 不记错误。
  - 结论：schema 中写 `{rule:'constructor'}` 之类拼写错误会静默变成「永远通过」的规则，`Object.freeze` 对此无防护。

---

## 发现 9

- **file**: `src/events.js:67`
- **类型**: 注释声称（返回值语义）
- **严重性**: MEDIUM
- **问题**: `emit` 返回 `list.length`（遍历前的原始数组长度），而非实际执行的监听器数；在第 57 行复制快照与监听器内部 `off` 的组合下，返回值与实际执行数不符。行内注释已自认这点，但 API 语义未在 JSDoc 说明，调用方按「已处理数」使用会得到错误计数。
- **依据**:
  - 实测：3 个监听器、其一抛错 → `emit` 返回 `3`，实际全部执行但异常被吞（与发现 4 叠加）。
  - 实测：注册 3 个，第 2 个在回调内 `off` 掉第 1 个 → `emit` 返回 `2`，随后 `listenerCount` 为 `2`，返回值既非注册数也非执行数。

---

## 发现 10

- **file**: `src/validate.js:37`
- **类型**: 注释声称（`@returns {{valid:boolean, errors:Object}}` 声称记录全部失败）
- **严重性**: LOW
- **问题**: 失败信息写入 `errors[field]`，当 `field === '__proto__'`（如来自 JSON 解析的 schema）时该赋值改的是原型而非自有属性，`Object.keys(errors)` 统计不到，校验失败被上报为 `valid: true`。
- **依据**（静态推断）:
  - `errors['__proto__'] = []` 触发 setter，设置 `errors` 的原型为一个数组；随后 `push` 落到该数组上。
  - 第 42 行 `Object.keys(errors).length === 0` ⇒ `valid: true`，失败被抹去。
  - 实测旁证：`validate({}, {['__proto__']:[{rule:'required'}]})` → `{"valid":true,"errors":{}}`；该用例中 `data.__proto__` 为 `Object.prototype`（truthy）而恰好未触发失败路径，但同一行在 `Object.create(null)` 数据下会走失败分支并被静默丢弃。

---

## 模式检查结果

| 维度 | 声称位置 | 验证方式 | 结果 |
|---|---|---|---|
| 函数名声称 | `escapeHtml`（template.js:112） | 实测 + 全库 Grep 调用点 | **不成立**，转义顺序错致双重转义（发现 2） |
| 注释/JSDoc 声称 | `escapeHtml` 注释「用于用户输入的插值」（template.js:111） | Grep 全库调用点 | **能力为空**，零调用，渲染路径不转义（发现 1） |
| 注释/JSDoc 声称 | `emit`「错误会在全部执行完后一起抛出」（events.js:50） | 实测单/双异常 | **不成立**，单异常被吞（发现 4） |
| 注释/JSDoc 声称 | `findMatchingClose` 嵌套匹配（template.js:70-87） | 实测嵌套 each/if | **不成立**，深度判断恒假（发现 3） |
| 注释/JSDoc 声称 | `paginate` `@returns.offset`（pagination.js:5） | 实测 page≤0 | **不成立**，负 offset（发现 6） |
| 注释/JSDoc 声称 | `validate` `@returns.valid/errors`（validate.js:15） | 静态推断 `__proto__` 字段 | **部分不成立**，失败被抹（发现 10） |
| 参数名声称 | `page`（pagination.js:7） | 实测 page=0/-5/2.5 | **收而不用作校验**，仅查整数不查下界（发现 6） |
| 参数名声称 | `r.arg` 经 `RULES[r.rule]` 守卫（validate.js:32） | 静态推断原型链 | **守卫失效**，未知规则恒通过（发现 8） |
| 规则名声称 | `number`（validate.js:8） | 实测 NaN/Infinity | **不成立**（发现 7） |
| 返回值语义 | `emit` 返回 `list.length`（events.js:67） | 实测 | **与实际执行数不符**（发现 9） |
| 导出名声称 | `EventBus`/`validate`/`listRules`（index.js:8） | Grep import | 仅被入口 re-export，属公开 API，非缺陷 |
| 导出名声称 | `once` 返回「取消订阅函数」（events.js:9） | 实测多重注册 | **部分失效**，`off` 删不掉（发现 5） |
| 反向：收参未用 | 全部 5 文件函数签名 | 逐个核对函数体 | 0 处（所有形参均被读取） |
| 反向：导出未用 | 内部调用统计 | Grep | `escapeHtml` 是唯一「导出且文档声称有具体用途、却零调用」者；其余为入口 re-export |

**范围说明**：仅读取了 `iso-p5-b/code/src/` 下 5 个 .js 与 `package.json`；4 个验证脚本位于 `%TEMP%\p5b-scratch\`，未执行任何构建/包管理命令，未修改被审目录。
