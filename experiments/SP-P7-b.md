4 个验证脚本已跑完（pagination / validate+template / events / index 公共路径）。以下为报告。

---

## 发现 1

- **file**: `src/pagination.js:15`（配合 `:16`、`:20`、`:37`）
- **类型**: 边界值 / 符号处理（分页 page 负值）
- **严重性**: HIGH
- **问题**: `page` 只校验了 `Number.isInteger`，没有校验 `>= 1`；`Math.min` 只夹上界，负页码直接穿透成负 `offset`，`slice(负数, 负数)` 变成「从末尾倒数」的花式取值，并且 `page: -1` 被原样写进返回对象。
- **依据**:
  - `paginate(100, -1, 10)` → `{"page":-1,"totalPages":10,"offset":-20,"limit":10,"hasNext":true,"hasPrev":false}`
  - `paginateArray(items, -1, 10)`（items 为 0..99）→ `offset:-20`，`items:[80,81,...,89]` —— 第 2 页请求拿到的是末尾 10 条
  - `paginateArray(items, -5, 10)` → `offset:-60`，`items:[40..49]`；`page:-10` → `offset:-110`，`items:[]` 但 `hasNext:true`
  - `page:0` → `offset:-10`，`items:[]`（`slice(-10,0)` 起点 90 > 终点 0，空数组），而 `hasNext:true`
  - 元数据自相矛盾：`page=-1` 时 `hasPrev:false`、`hasNext:true`，UI 会显示「上一页不可用、下一页可用、当前 -1」
  - 语义翻转直接用实测佐证：`items.slice(-60,-50)` → `[40,41,...,49]`（本应是「从头第 40 条起」的位置，实际是倒数第 60 条）
  - 经公共入口同样可达：`renderListView(tpl, items, {page:-1})` → `html:"-1/3 [5..14,]"`，`pagination.page:-1`
  - `total=0` 时更荒谬：`paginate(0, -3, 10)` → `offset:-40`，`hasNext:true`（0 条数据却报告有下一页）

## 发现 2

- **file**: `src/pagination.js:14`
- **类型**: 边界值 / 零值兜底
- **严重性**: LOW
- **问题**: `Math.max(1, Math.ceil(total/pageSize))` 把 `total=0` 兜成「1 页」，空集合与「有 1 页但内容为空」不可区分，且这个假的 1 同时充当 `Math.min` 的下界参考，使 `hasNext` 在空集上也可能是 `true`。
- **依据**:
  - `paginate(0, 1, 10)` → `totalPages:1`，而实际 `total=0`
  - `paginate(0, 0, 10)` → `{"page":0,"totalPages":1,"offset":-10,"hasNext":true}` —— 0 条数据 + `hasNext:true`
  - `paginate(0, 5, 10)` → `page:1`，即不存在第 5 页却返回 `page:1` 的合法态，调用方无法从返回值判断「数据为空」

## 发现 3

- **file**: `src/validate.js:6`（同样问题在 `:7`）
- **类型**: 边界值 / 符号处理（规则参数）
- **严重性**: MEDIUM
- **问题**: `minLength` / `maxLength` 的 `arg` 没有做「非负整数」校验，负的或缺失的 `arg` 会让规则方向翻转或恒定失败，等于静默关闭/锁死校验。
- **依据**:
  - `minLength('', -100)` → `valid=true`（长度 0 通过「至少 -100 字符」，规则形同不存在）
  - `minLength('', 0)` → `valid=true`
  - `maxLength('ab', -1)` → `valid=false`（任何字符串都无法通过，字段永久报错）
  - 静态推断：`arg` 缺省时 `'abc'.length >= undefined` 为 `false`，即漏写 `arg` 时 `minLength` 恒失败、`maxLength` 恒失败（`'abc'.length <= undefined` 亦为 `false`）

## 发现 4

- **file**: `src/validate.js:8`
- **类型**: 边界值 / 非有限数
- **严重性**: MEDIUM
- **问题**: `number` 规则只判断 `typeof v === 'number'`，`NaN`、`Infinity`、`-Infinity` 全部通过校验；`parseFloat` 失败产生的 `NaN` 可以直达下游参与算术。
- **依据**:
  - `validate({n:NaN},{n:[{rule:'number'}]})` → `valid=true`
  - `validate({n:Infinity}...)` → `valid=true`；`validate({n:-Infinity}...)` → `valid=true`
  - 对照：`integer` 规则正确拒绝 `NaN`（`Number.isInteger(NaN)=false`）、`1.5`、`'3'`；`integer(-1)` 为 `true` 属正确语义（整数本可为负），此处不构成缺陷

## 发现 5

- **file**: `src/template.js:77`
- **类型**: 附带，控制流边界（非符号维度）
- **严重性**: HIGH
- **问题**: `openTag === closeTag.replace("/", "#")` 恒为假（`'{{#each '` 与 `'{{#each}}'` 差一个尾空格/括号），`depth` 永远不递增，导致同类块嵌套时第一个 `{{/each}}` 就被当成本层的闭合。
- **依据**:
  - `compile('{{#each outer}}[{{#each inner}}({{x}}){{/each}}]{{/each}}')({outer:[{inner:[{x:1},{x:2}]}]})` → `[{{#each inner}}({{x}})[{{#each inner}}({{x}})]{{/each}}`（内层标签被当纯文本输出，外层提前闭合后剩余 `{{/each}}` 漏出）
  - `compile('{{#if a}}A{{#if b}}B{{/if}}C{{/if}}')({a:1,b:1})` → `A{{#if b}}BC{{/if}}`

## 发现 6

- **file**: `src/events.js:64`
- **类型**: 附带，数量边界（`errors.length === 1` vs `> 1`）
- **严重性**: HIGH
- **问题**: 判定条件写成 `errors.length > 1`，只有 1 个监听器抛错时错误被完全吞掉，`emit` 正常返回，调用方无从感知故障；2 个及以上才抛 `AggregateError`。
- **依据**:
  - 单个抛错监听器：`single-throw: NOT thrown, returned 1`（应抛出）
  - 两个抛错监听器：`two-throw: AggregateError count= 2`（正常）

## 发现 7

- **file**: `src/events.js:67`
- **类型**: 附带，计数边界（返回值语义）
- **严重性**: MEDIUM
- **问题**: `return list.length` 读的是循环结束后被就地修改的活数组，既不是注释声称的「原始长度」，也不是「实际执行数」。
- **依据**:
  - 两个监听器、第一个在回调里 `off` 掉自己：`emit('y')` 返回 `1`，但两个 handler 都执行了（`c2=11`，即 `1 + 10`），注册时的原始长度为 2
  - 对照 `on('y', h)` 后 `listenerCount('y')=1`，返回 1 时恰好「看起来对」，掩盖了语义错误

## 发现 8

- **file**: `src/template.js:118`（`escapeHtml` 整体 `:112-119`）
- **类型**: 附带，替换顺序
- **严重性**: MEDIUM
- **问题**: `&` 的替换放在最后，前面几步生成的 `&lt;` `&quot;` 等实体的 `&` 又被转义一次，所有特殊字符都被二次转义。
- **依据**:
  - `escapeHtml('&lt;')` → `'&amp;lt;'`
  - `escapeHtml('<a & "b">')` → `'&amp;lt;a &amp; &amp;quot;b&amp;quot;&amp;gt;'`（应为 `&lt;a &amp; &quot;b&quot;&gt;`）
  - 组件往返一次（已转义内容再转义）即被破坏

## 发现 9

- **file**: `src/validate.js:32`
- **类型**: 附带，规则名解析（原型链）
- **严重性**: MEDIUM
- **问题**: `RULES[r.rule]` 未做 `Object.hasOwn` 判断，`Object.prototype` 上的函数（`constructor`、`toString`、`valueOf`、`hasOwnProperty`）会被当作合法规则取到并通过 `typeof fn === 'function'` 检查，永远不会走到 `unknown rule` 抛错分支，且这些函数返回真值使校验静默通过。
- **依据**: 静态推断——`RULES` 是 `Object.freeze` 的普通对象字面量，冻结不切断原型链；`RULES['constructor']` 为 `Object`，`typeof` 为 `'function'`，`fn(value, arg)` 返回对象（真值），故 `!fn(...)` 为假，该字段被判定通过。`validate.js:33` 的 `unknown rule` 防护对原型成员失效。

## 发现 10

- **file**: `src/events.js:32`（影响 `:40`）
- **类型**: 附带，键覆盖
- **严重性**: LOW
- **问题**: `#onceWrappers` 以原始 `handler` 为键、每 handler 仅存一个 wrapper，同一 handler 通过 `once()` 注册到多个事件时后写覆盖前写，`off(event, handler)` 只能定位最后一个 wrapper，另一事件上的 wrapper 无法按原始 handler 解除，成为泄漏的监听器。
- **依据**: 静态推断——`once('a', h)` 存 `w1`，`once('b', h)` 覆盖为 `w2`；此后 `off('a', h)` 取 `target = #onceWrappers.get(h) = w2`，在 `'a'` 的列表里 `indexOf(w2) === -1`，`events.js:42` 直接 `return false`，`w1` 仍留在 `'a'` 上直到该事件被触发。实测单事件路径无碍（`once('a',h); once('b',h)` 各自触发时 `calls=2`、两事件计数均归零），故仅 LOW。

---

## 模式检查结果

| 文件 / 检查点 | 负数 | 零 | 边界结论 |
|---|---|---|---|
| `pagination.js:15` `page` 校验 | **穿透**（`Number.isInteger(-1)=true`） | **穿透**（`page:0`） | 缺陷，见发现 1 |
| `pagination.js:16` `Math.min` 夹取 | 只夹上界，下界缺失 | 同左 | 缺陷，见发现 1 |
| `pagination.js:20` `(page-1)*size` | `-20 / -60 / -1e10` 负 offset | `-10` | 缺陷，见发现 1 |
| `pagination.js:37` `slice(offset, offset+limit)` | 语义翻转为「从末尾数」，实测 `[40..49]` | `slice(-10,0)`→`[]` | 缺陷，见发现 1 |
| `pagination.js:14` `Math.max(1, ceil(total/size))` | 不受影响 | `total=0` 被兜成 1 页，`hasNext` 可为真 | 缺陷，见发现 2 |
| `pagination.js:11` `pageSize` 校验 | 正确拒绝 `-1` | 正确拒绝 `0`、`1.5` | 无缺陷 |
| `pagination.js:8` `total` 校验 | 正确拒绝负数 | 允许 `0`（语义正确） | 无缺陷 |
| `validate.js:6` `minLength` | **负 arg 恒真**，校验失效 | `arg=0` 恒真 | 缺陷，见发现 3 |
| `validate.js:7` `maxLength` | 负 arg 恒假 | `arg=0` 仅空串通过 | 缺陷，见发现 3 |
| `validate.js:8` `number` | 接受 `-Infinity` | 接受 `NaN`、`Infinity` | 缺陷，见发现 4 |
| `validate.js:9` `integer` | 接受 `-1`（**正确语义，非缺陷**） | 接受 `0`（正确） | 无缺陷 |
| `template.js` `{{#if 0}}` | `-1` 为真（正确） | `0` 为假、内容隐藏 | JS 假值语义，非缺陷 |
| `template.js:96` 插值正则 `[\w.]+` | 负索引 `{{a.-1}}` 不匹配、原样输出标签 | `{{n}}` 且 `n=0` 正确输出 `"0"` | 无实质影响 |
| `template.js:89` `minIndex(-1,-1)` | 正确返回 `-1`，无越位 | — | 无缺陷 |
| `template.js:70` `findMatchingClose` 下标 | 无负值产生 | — | 下标安全，但见发现 5 |
| `events.js` 事件名/计数 | 拒绝 `0`、`-1`、`''` 作为事件名（正确） | `listenerCount(-1)=0` | 无符号缺陷，但见发现 6/7/10 |
| `index.js:14` 透传 `page` | 未拦截，负数直达 `paginateArray` | `page:0` 直达 | 缺陷入口，见发现 1 |

**结论**：模式 7 的核心缺陷集中在 `pagination.js` 的页码下界缺失（发现 1，HIGH）——`page` 为负时既不报错也不回落到第 1 页，而是通过 `slice` 的负数语义取到完全不相干的数据，同时输出 `page:-1`、`hasPrev:false`、`hasNext:true` 这种不可能状态。`validate.js` 的规则参数与 `number` 规则构成同类的边界缺口（发现 3、4）。发现 5-10 为验证过程中顺带实测确证的真实缺陷，与符号处理无关，单独标注。

验证脚本位置（未修改被审目录）：`<HOME>\AppData\Local\Temp\p7b-scratch\p1-pagination.mjs`、`p2-validate-template.mjs`、`p3-events.mjs`、`p4-index-boundaries.mjs`。
