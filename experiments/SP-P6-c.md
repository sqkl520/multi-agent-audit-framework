验证完成：4 个脚本均已执行，以下为审计报告。

# 审计报告（模式 6：转义 / 编码顺序）

## 发现 1 — `escapeHtml` 的 `&` 最后替换，造成二次转义

- **file**: `src/template.js:112-119`（关键行 118）
- **类型**: 转义顺序错误 / 二次转义
- **严重性**: 高
- **问题**: `.replace()` 链按 `<` → `>` → `"` → `'` → `&` 的顺序执行，`&` 放在最后。前面四步产生的实体（`&lt;`、`&gt;`、`&quot;`、`&#39;`）里的 `&` 会被第五步再次转义成 `&amp;`。
- **依据**: 实测（v1 脚本）

  | 输入 | 实际输出 | 应有输出 |
  |---|---|---|
  | `<script>alert(1)</script>` | `&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;` | `&lt;script&gt;alert(1)&lt;/script&gt;` |
  | `AT&T <b>"q"</b>` | `AT&amp;T &amp;lt;b&amp;gt;&amp;quot;q&amp;quot;&amp;lt;/b&amp;gt;` | `AT&amp;T &lt;b&gt;&quot;q&quot;&lt;/b&gt;` |

  只有纯 `&`（不含 `<`/`>`/引号）的输入才碰巧正确，因此单元测试很容易漏掉。该函数非幂等：`escapeHtml(escapeHtml(x)) !== escapeHtml(x)`，任意二次调用（例如先转义存库、渲染时再转义）都会让 `<` 逐步退化为 `&amp;amp;lt;`。**`&` 必须最先替换。**

## 发现 2 — 嵌套块匹配逻辑恒为假，嵌套 `each`/`if` 全部渲染错乱

- **file**: `src/template.js:77`
- **类型**: 字符串比较 / 替换顺序依赖
- **严重性**: 高
- **问题**: `openTag === closeTag.replace("/","#")` 用于判断“是否遇到同类开启标签”，但两侧字符串形态根本对不上：
  - `'{{#each '.replace(...)` 无关，实际比较的是 `'{{#each '`（**带尾随空格**）
  - `'{{/each}}'.replace("/","#")` → `'{{#each}}'`（**无尾随空格**）

  结果为 `false`，`depth++` 分支永远不会进入，`findMatchingClose` 退化为“取第一个关闭标签”。
- **依据**: v2 实测 `openEach === closeEach.replace('/', '#')` → `false`；嵌套模板输出

  ```
  模板: {{#each xs}}{{#each ys}}({{this}}){{/each}}{{/each}}
  实际: "{{#each ys}}({{this}}){{#each ys}}({{this}}){{/each}}"
  期望: "((a)(b))((c))"
  ```

  内层的 `{{/each}}` 被当作外层的结束符，剩余标签被当字面量输出。`{{#if}}` 嵌套同理（`"BA"` 输出为 `"{{#if b}}BA{{/if}}"`）。这是把“用 replace 从关闭标签推导开启标签”当成相等判断——字符串构造与比较的顺序/形态不一致。

## 发现 3 — 单个监听器抛错被静默吞掉

- **file**: `src/events.js:64`
- **类型**: 边界条件（`>` 应为 `>=`）
- **严重性**: 中
- **问题**: `if (errors.length > 1) throw new AggregateError(...)`。只有 1 个监听器抛错时 `errors.length === 1`，不满足 `> 1`，异常被丢弃，`emit` 静默返回。这与第 49-50 行文档注释「单个监听器抛错不影响其他监听器，错误会在全部执行完后一起抛出」直接矛盾。
- **依据**: v3 实测：1 个 handler 抛错 → `emit` 未抛出、返回值 1；2 个 handler 抛错 → 抛出 `AggregateError`（`errors.length === 2`）。生产环境中最常见的恰恰是单个 handler 出错，错误完全不可见。

## 发现 4 — `once` 的 wrapper 映射以 handler 为键，同一 handler 注册多事件时被覆盖并泄漏监听器

- **file**: `src/events.js:32`（配合 `:40`、`:28-31`）
- **类型**: 映射键冲突 / 状态覆盖
- **严重性**: 中
- **问题**: `#onceWrappers` 是 `WeakMap<handler, wrapper>`，注释本身已标注「同一 handler 注册多个事件时被覆盖」。第二次 `once` 覆盖第一次的 wrapper，导致 `off(event, handler)` 只能找回**最后一次**的 wrapper，前一个 wrapper 无法通过原 handler 移除。
- **依据**: v4 实测

  ```
  once('x', g); once('y', g);
  off('x', g)  => false   (期望 true)
  x 剩余监听器 => 1       (期望 0)
  emit('x')    => g 仍然执行，ran 递增
  ```

  即 `off` 失效 + 监听器泄漏，与 `on()` 返回的取消订阅函数语义不一致。键应为 `event + handler` 组合（或 Map<handler, Map<event, wrapper>>）。

## 发现 5 — `paginate` 未排除负数/0 页，`paginateArray` 静默返回错误切片

- **file**: `src/pagination.js:15-16`、`:20`（受影响调用点 `:37`）
- **类型**: 输入校验缺口 → 负偏移
- **严重性**: 中
- **问题**: `safePage = Number.isInteger(page) ? page : 1` 只校验整数性，不校验正负（注释「未排除负数」）。`clamped = Math.min(safePage, totalPages)` 也不设下界，负页码直接进入 `offset = (clamped - 1) * pageSize`，得到负 offset。
- **依据**: v3 实测

  ```
  paginate(10, -5, 3)  => {"page":-5, "totalPages":4, "offset":-18, "hasNext":true, "hasPrev":false}
  paginate(10,  0, 3)  => {"page":0,  "offset":-3}
  ```

  `page: -5` 且 `hasPrev: false` 自相矛盾。更严重的是 `paginateArray` 把负 offset 传给 `Array.prototype.slice`：`slice(-18, -15)` 会从**数组尾部**取值。对 10 元素数组返回空（碰巧无害），但长度 ≥ 18 的数组会静默返回倒数第 18~15 个元素——页码非法时返回完全无关的数据而非报错或空列表。正确做法是 `clamped = Math.min(Math.max(1, safePage), totalPages)`。

## 发现 6 — 插值渲染路径完全不做转义，`escapeHtml` 成为死代码

- **file**: `src/template.js:96-99`（受影响：`src/index.js:17`、`src/template.js:112`）
- **类型**: 转义缺失 / “先拼接后转义”顺序问题
- **严重性**: 高
- **问题**: `renderInline` 用 `String(v)` 直接拼进输出，模板引擎自身无任何转义。`escapeHtml` 虽被导出（`index.js:3,8`），但在整个 `src/` 内**没有任何调用点**（Grep 仅命中定义与 re-export）。`renderListView` 把 `paged.items` 与 `extra` 原样喂给 `render`，用户数据直达 HTML。
- **依据**: v1 实测 `compile('{{name}}')({ name: '<img src=x onerror=alert(1)>' })` 原样输出 `<img src=x onerror=alert(1)>`。

  这正是模式 6 的“先拼接后转义 vs 先转义后拼接”陷阱：正确顺序是在插值点（拼接前）逐值转义；现状是既不转义，且唯一可用的转义函数本身还是坏的（发现 1）。调用方即使手动 `escapeHtml` 再传入，也会因发现 1 得到 `&amp;lt;` 双重转义，页面显示字面量 `&lt;`。两处缺陷叠加形成一个既漏 XSS 又无法安全修补的局面。

## 模式检查结果

| 检查项 | 位置 | 结果 | 判定 |
|---|---|---|---|
| 多个 `.replace()` 中先替换的产物被后一个再换 | template.js:114-118 | `<`→`&lt;` 先于 `&`→`&amp;`，`&lt;` 变 `&amp;lt;` | **缺陷**（发现 1） |
| `&` 是否最先替换 | template.js:118 | 排在最后 | **缺陷**（发现 1） |
| 转义是否幂等（同一输入被转义两次） | template.js:112 | 非幂等，逐次叠加 `amp;` | **缺陷**（发现 1） |
| 先拼接后转义 vs 先转义后拼接 | template.js:96-99 / index.js:17 | 拼接时零转义，转义函数无调用点 | **缺陷**（发现 6） |
| 由标签字符串 replace 推导再做相等比较 | template.js:77 | `'{{#each '` vs `'{{#each}}'` 恒不相等 | **缺陷**（发现 2） |
| 解码顺序 / URL 编码顺序 | 全部 5 文件 | 不存在 decodeURIComponent / URL 编码逻辑 | 不适用 |
| 正则替换的前后依赖顺序 | template.js:96 单次全局替换 | 单条 replace + 回调，无链式依赖 | 通过 |
| 字符串拼接顺序（enctype/HTML 属性） | 全部 5 文件 | 无属性拼接或 href 构造 | 不适用 |
| 校验顺序依赖 | validate.js:31-40 | 按 schema 数组顺序执行，规则间无状态耦合，仅收集错误 | 通过 |

补充说明：`events.js:67` 的 `return list.length` 返回原始长度而非实际执行数，已在第 67 行注释中明确标注为已知设计取舍，不列为缺陷。`validate.js` 未发现转义/编码顺序类问题。

验证脚本位置（全部已执行）：`<HOME>\AppData\Local\Temp\p6c-scratch\v1-escape-order.mjs`、`v2-nested.mjs`、`v3-events-pagination.mjs`、`v4-once-mixed.mjs`。被审文件未做任何修改。
