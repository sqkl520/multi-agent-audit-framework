4 个验证脚本已全部跑完，结论如下。

## 发现 1

**file**: `src/pagination.js:15-16`（配合 `:20`）
**类型**: 缺失下界夹取 / 边界值符号处理
**严重性**: 严重

**问题**: `safePage` 只做了 `Number.isInteger` 判断，没有排除负数和 0；第 16 行的 `Math.min(safePage, totalPages)` 只夹上界，缺 `Math.max(1, ...)`。夹取顺序本身就是「先夹后算」（第 20 行用 `clamped` 算 offset），但因为下界没夹，负值原封不动地流进 `offset`。

**依据**: 实测（`total=100, pageSize=10`）：
- `page=0` → `page:0, offset:-10, hasPrev:false, hasNext:true`
- `page=-1` → `page:-1, offset:-20`
- `page=-5` → `page:-5, offset:-60`
- `page=-0`（即 `-0`）同样得到 `offset:-10`，因为 `(-0-1)*10 === -10`

返回值里 `page` 字段仍是负数，直接回传给调用方展示（见发现 7 的 `renderListView` 输出 `"-5/10"`）。

## 发现 2

**file**: `src/pagination.js:37`
**类型**: 负索引落入 `Array.prototype.slice` 的「从末尾数」语义
**严重性**: 严重

**问题**: `items.slice(info.offset, info.offset + info.limit)` 在 `offset` 为负时，`slice` 不报错，而是把负值解释为「从数组末尾倒数的下标」，分页语义完全翻转，返回的是另一页（甚至是未授权/不该展示）的数据。

**依据**: 实测 `len=100, pageSize=10`：

| page | offset | 实际返回 | 等价于 |
|---|---|---|---|
| 0 | -10 | `[]`（`slice(-10,0)` 起点 90、终点 0，退化为空） | 空白页 |
| -1 | -20 | `[80..89]` | 第 9 页 |
| -5 | -60 | `[40..49]` | 第 5 页 |
| -10 | -110 | `[]` | 空白页 |

脚本断言 `JSON.stringify(paginateArray(items,-5,10).items) === JSON.stringify(paginateArray(items,5,10).items)` 为 `true`——`page=-5` 精确返回第 5 页内容。`len=50` 时 `page=-1` 返回 `[30..39]`。这不是「空结果」，是静默返回错误页的数据。

## 发现 3

**file**: `src/pagination.js:22-23`
**类型**: 负值参与比较导致布尔方向错误
**严重性**: 高

**问题**: `hasNext: clamped < totalPages` 与 `hasPrev: clamped > 1` 直接拿未夹下界的 `clamped` 比较。负 page 恒满足 `clamped < totalPages`，于是空列表、末页都报告「还有下一页」；而 `hasPrev` 恒为 `false`，用户无法回退。

**依据**: `total=0, page=-1` → `{page:-1, totalPages:1, offset:-20, hasNext:true, hasPrev:false}`。空列表上 `hasNext` 为 `true`，可无限点「下一页」，而每次点都拿到空数组（发现 2）。`total=100, page=-5` → `hasNext:true, hasPrev:false`，与实际处于中间页的事实矛盾。

## 发现 4

**file**: `src/validate.js:9`
**类型**: 校验缺下界（`Number.isInteger` 无 `x >= 1`）
**严重性**: 高

**问题**: `integer: (v) => Number.isInteger(v)` 只验类型不验范围，0 与所有负数全部通过。这是发现 1/2 的上游闸门：任何用 `{rule:'integer'}` 校验 `page` 的调用方都会放行 `-1`。

**依据**: 实测 `validate({page:v},{page:[{rule:'integer'}]})`：`v=3`→true，`v=0`→true，`v=-1`→true，`v=-100`→true；只有 `1.5/NaN/Infinity/'3'/null` 为 false。规则集 `RULES` 里没有任何 `min`/`range` 类规则，负页码无法用现有规则表达拒绝。

## 发现 5

**file**: `src/validate.js:8`
**类型**: 数值边界（`number` 规则接受非有限值）
**严重性**: 中

**问题**: `number: (v) => typeof v === 'number'` 把 `NaN`、`Infinity`、`-Infinity` 当作合法数值放行；`NaN` 的 `typeof` 也是 `'number'`。下游任何算术（含 `(page-1)*pageSize`）会立刻变成 `NaN`。

**依据**: 实测 `number(NaN)`→true，`number(Infinity)`→true，`number(-Infinity)`→true，`number(0)`→true，`number(-1.5)`→true。对照 `paginate` 中 `total=NaN` 会被第 8 行拦下，但校验层放行，两层策略不一致。

## 发现 6

**file**: `src/template.js:77`
**类型**: 计数器恒不递增（下标/深度边界）
**严重性**: 高

**问题**: `findMatchingClose` 的嵌套分支条件 `o < c && openTag === closeTag.replace("/","#")` 永远不成立：`openTag` 带尾随空格（`'{{#if '`、`'{{#each '`），而 `closeTag.replace('/','#')` 得到的是 `'{{#if}}'`、`'{{#each}}'`（无空格）。因此 `depth++` 是死代码，`depth` 恒为 0，函数在第一个 `closeTag` 处就返回——同类块一旦嵌套，内层块的 `{{/if}}` 被误认成外层块的结束。

**依据**: 实测 `compile('A{{#if a}}B{{#if b}}C{{/if}}D{{/if}}E')({a:1,b:1})` 返回 `"AB{{#if b}}CD{{/if}}E"`，期望 `"ABCDE"`——内层开标签被当作字面文本输出、内层闭合标签残留在输出里。`each` 嵌套同样破损：`{{#each xs}}<{{#each ys}}y{{/each}}>{{/each}}` → `"<{{#each ys}}y>{{/each}}"`。单层块正常（`"ABC"`），证明缺陷只在 depth 应为正时暴露。

## 发现 7

**file**: `src/index.js:13-14`
**类型**: 公共入口缺边界校验（负值直通）
**严重性**: 中

**问题**: `renderListView` 是唯一对外的高层入口，`page` 的默认值只在 `undefined` 时生效，对 `0`/负数/字符串不做任何校验就直接交给 `paginateArray`；`paginate` 对 `total`、`pageSize` 都抛 `RangeError`，唯独 `page` 被放过。URL 查询串 `?page=-1` 走的就是这条路径。

**依据**: 实测 `renderListView('{{page}}/{{totalPages}}', items, {page:-5})` 的 `pagination` 为 `{page:-5, totalPages:10, hasNext:true, hasPrev:false}`，渲染出的 html 为 `"-5/10"`，且 `items` 是第 5 页数据（发现 2）。`{page:0}` → `"0/10"` 且 `items` 为空数组。

## 发现 8

**file**: `src/template.js:114-118`
**类型**: 替换顺序导致二次转义（非模式 7，附带发现）
**严重性**: 中

**问题**: `escapeHtml` 把 `&` 放在最后一行替换，先替换出的 `&lt;`/`&gt;`/`&quot;`/`&#39;` 中的 `&` 又被第 118 行再转义一次，所有含特殊字符的输入都会显示成字面实体文本。

**依据**: 实测 `escapeHtml('<a>')` → `"&amp;lt;a&amp;gt;"`（应为 `"&lt;a&gt;"`）；`escapeHtml('"')` → `"&amp;quot;"`（应为 `"&quot;"`）；`escapeHtml('&lt;')` → `"&amp;lt;"`。修法是 `&` 放第一位。

## 模式检查结果

| 检查点（模式 7） | 位置 | 结论 | 证据 |
|---|---|---|---|
| `page` 传负数/0 | `pagination.js:15-16` | 未夹下界，负值穿透 | `page=-5` → `page:-5, offset:-60` |
| `Math.max`/`Math.min` 是否成对 | `pagination.js:16` | 只有上界夹取，缺 `Math.max(1,…)` | 同上 |
| 先夹再算 vs 先算再夹 | `pagination.js:20` | 顺序正确，但夹取本身不完整 | `(clamped-1)*pageSize` 得负 offset |
| `(page-1)*size` 在 page≤0 | `pagination.js:20` | 直接产出负偏移 | `page=0` → `-10`；`page=-1` → `-20` |
| 切片起止传负值 | `pagination.js:37` | `slice` 静默按「从末尾数」解释 | `page=-5` 返回第 5 页数据（相等断言为 true） |
| 数组下标/索引边界 | `template.js:77` | `depth` 恒为 0，嵌套块解析错误 | 嵌套 if 输出 `"AB{{#if b}}CD{{/if}}E"` |
| `Number.isInteger` 缺 `x>=1` | `validate.js:9` | 0 与负数全部放行 | `integer(-100)` → `true` |
| 数值校验的非有限边界 | `validate.js:8` | `NaN`/`±Infinity` 通过 | `number(NaN)` → `true` |
| `total=0` 的连带影响 | `pagination.js:14,22` | `totalPages` 兜底为 1 尚可，但空列表上 `hasNext` 可能为 `true` | `total=0,page=-1` → `hasNext:true` |
| 公共入口默认值边界 | `index.js:13-14` | `page` 无校验直通，负数进渲染 | html 输出 `"-5/10"` |
| 负值参与布尔比较 | `pagination.js:22-23` | `hasPrev` 恒 false、`hasNext` 恒 true | 见发现 3 |

验证脚本位于 `<HOME>\AppData\Local\Temp\p7c-scratch\`（`s1.js`～`s4.js`），均为只读 import、未修改任何被审文件。

**补充说明**：`events.js` 未发现模式 7 相关缺陷——其索引操作（`indexOf`/`splice`）的 `-1` 分支都有显式处理，`listenerCount` 与重复注册行为实测符合预期（`2` → `off` 一次后 `1`）。第 67 行 `return list.length` 返回原始长度而非实际执行数、第 32 行 `onceWrappers` 被同名 handler 覆盖，这两处源码注释已自认，属已知行为，未计入发现。
