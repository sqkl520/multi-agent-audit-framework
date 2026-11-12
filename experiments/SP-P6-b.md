## 发现 1

- **file**: `src/template.js:112-118`（缺陷行：118）
- **类型**: 转义 / 编码顺序（模式 6）
- **严重性**: HIGH
- **问题**: `escapeHtml` 把 `&` 的替换放在整条 `.replace()` 链的**最后**，导致前面四次替换新生成的 `&lt;` `&gt;` `&quot;` `&#39;` 被再次转义成 `&amp;lt;`、`&amp;quot;`、`&amp;#39;`，全量双重转义。
- **依据**: 实测（t1/t2）：

  | 输入 | 实际输出 | 正确输出 |
  |---|---|---|
  | `<b>` | `&amp;lt;b&amp;gt;` | `&lt;b&gt;` |
  | `"q"` | `&amp;quot;q&amp;quot;` | `&quot;q&quot;` |
  | `it's` | `it&amp;#39;s` | `it&#39;s` |
  | `Tom & Jerry <3` | `Tom &amp; Jerry &amp;lt;3` | `Tom &amp; Jerry &lt;3` |

  浏览器只解码一层，`<b>` 在页面上显示成字面量 `&lt;b&gt;`（t3 实测：`shown: "&lt;b&gt;bold&lt;/b&gt;"`，`expected: "<b>bold</b>"`，不相等）。
  附加证据：函数**非幂等**——`escapeHtml(escapeHtml('a < b & "c"'))` = `a &amp;amp;lt; b &amp;amp; &amp;amp;quot;c&amp;amp;quot;`，与单次结果不同；存储时先转义的字段（`Tom &amp; Jerry`）在渲染处再转义一次会变成 `Tom &amp;amp; Jerry`，即经典的「先转义后拼接 + 再转义」二次转义链路。
  修复：把 `.replace(/&/g, '&amp;')` 挪到链首。

## 发现 2

- **file**: `src/template.js:95-100`（`renderInline`），配合 `src/index.js:17`
- **类型**: 转义 / 编码顺序（先拼接后转义 vs 先转义后拼接 → 这里两边都没做）
- **严重性**: HIGH
- **问题**: 插值路径完全不做转义，`renderInline` 直接把 `String(v)` 塞进 HTML；而唯一的转义助手 `escapeHtml` 在 render 路径里一次都没被调用，`renderListView` 直接把用户数据拼进 `html`。
- **依据**: 全文件 Grep `escapeHtml` 只命中定义处（112）和 index.js 的转出（3、8），render 路径无调用。实测（t3）：
  - `renderListView('<ul>{{#each items}}<li>{{name}}</li>{{/each}}</ul>', [{name:'<img src=x onerror=alert(1)>'}, ...])` → `<ul><li><img src=x onerror=alert(1)></li>...`，脚本原样进入 HTML。
  - `compile('<li>{{user}}</li>')({user:'<svg/onload=alert(1)>'})` → `<li><svg/onload=alert(1)></li>`。
  即：调用方若不手动调用 `escapeHtml` 就是 XSS；手动调用又被发现 1 的双重转义毁掉输出——两条路都不通。

## 发现 3

- **file**: `src/template.js:77`（`findMatchingClose`，函数 70-87）
- **类型**: 字符串替换产物顺序（模式 6 同族：先做 `.replace` 再比较）
- **严重性**: MEDIUM
- **问题**: `openTag === closeTag.replace("/","#")` 的比较永远为假——`{{/each}}`.replace 得 `{{#each}}`，而 openTag 是带尾随空格的 `{{#each `，两者不等；因此 `depth++` 分支永不执行，同类型嵌套块无法正确配对。
- **依据**: 实测 t4：`{{#each ` vs `{{#each}}` → `equal=false`（if 同理）。后果：`{{#each a}}[{{#each b}}x{{/each}}]{{/each}}` 渲染成 `"[{{#each b}}x]{{/each}}"`（内层标签泄漏成字面量），`{{#if a}}1{{#if b}}2{{/if}}3{{/if}}` 无论 `b` 真假都输出 `"1{{#if b}}23{{/if}}"`。

## 发现 4

- **file**: `src/events.js:32`（缺陷点），影响 `src/events.js:40`
- **类型**: 映射覆盖（非模式 6，实测确认的真实缺陷）
- **严重性**: MEDIUM
- **问题**: `#onceWrappers` 以原始 `handler` 为 key，同一 handler 注册到两个事件时后写覆盖前写，`off` 取到错误的 wrapper，导致退订失效。
- **依据**: 实测 t4：`once('a',h)` + `once('b',h)` 后 `off('a',h)` 返回 `false`，`listenerCount('a')` 仍为 `1`（期望 0）。

## 发现 5

- **file**: `src/pagination.js:15-16`
- **类型**: 边界钳制缺失（静态确认）
- **严重性**: LOW
- **问题**: `safePage` 只校验整数、不排除负数，负页码经过 `Math.min(safePage, totalPages)` 仍为负，`offset` 变负，`items.slice(negative, negative+limit)` 从数组尾部取数。
- **依据**: 静态推断（第 15 行注释「未排除负数」自认，第 16 行 `Math.min` 不设下界）：`paginateArray([1..10], -1, 5)` → `clamped=-1`、`offset=-10`，`slice(-10,-5)` 返回尾部元素而非报错或夹到第 1 页。

## 模式检查结果

| 检查项（模式 6 子项） | 位置 | 结论 | 依据类型 |
|---|---|---|---|
| 连续 `.replace()` 中先替换的是否被后者再转义 | `template.js:112-118` | **命中**：`&` 最后替换，`<`/`>`/`"`/`'` 产物被二次转义 | 实测 |
| `&` 是否最先替换 | `template.js:118` | **命中**：`&` 排在最后 | 实测 |
| 同一输入转义两次是否一致 | `template.js:112` | **命中**：非幂等，`&amp;lt;` → `&amp;amp;lt;` | 实测 |
| 先拼接后转义 vs 先转义后拼接 | `template.js:96-100` / `index.js:17` | **命中**：两条路径都不转义；手动预转义再渲染造成二次转义 | 实测 |
| 解码顺序 | 全 5 文件 | 无解码逻辑，不适用 | Grep |
| URL 编解码顺序 | 全 5 文件 | 无 `encodeURI*`/`decodeURI*`，不适用 | Grep |
| 正则替换前后依赖顺序 | `template.js:96` | 单条 replace + 回调，无链式依赖，无缺陷 | 实测 |
| 替换产物用于后续比较/判断 | `template.js:77` | **命中**：`closeTag.replace` 结果与 openTag 永不相等 | 实测 |

验证脚本位置（未修改被审目录任何文件）：`<HOME>\AppData\Local\Temp\p6b-scratch\t1-escape.mjs`、`t2-double.mjs`、`t3-render.mjs`、`t4-misc.mjs`，共 4 个，已用满配额。

最关键的一条：`escapeHtml` 的 `.replace()` 链顺序错（`&` 必须在最前），并把 `escapeHtml` 的返回值继续当作可再转义的输入使用，会在整个应用范围内把用户可见文本变成 `&amp;lt;` 这类字面量。
