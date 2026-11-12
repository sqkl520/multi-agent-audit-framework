验证完成。以下是审计报告。

---

## 发现 1

- **file**: `src/template.js:96-99`（拼接点同时在 `src/index.js:17`）
- **类型**: 模式 6 — 拼接与转义的先后（拼接前根本没转义）
- **严重性**: CRITICAL
- **问题**: `renderInline` 用 `String(v)` 把上下文值原样拼进输出，整条渲染链上没有任何转义步骤，导致任何进入模板的用户数据直接成为 HTML。
- **依据**: 全仓 `Grep 'escapeHtml\s*\('` 只有 1 处命中，就是 `template.js:112` 的定义本身——`escapeHtml` 虽然被 `index.js:8` 导出，但**从未被调用过**。而 `escapeHtml` 的注释写着「用于用户输入的插值」，说明转义阶段本应存在，实际缺失。跑 `renderListView` 复现：

```
[4] html: <ul><li><img src=x onerror=alert(1)></li><li>a & b</li><li><b>bold</b></li></ul>
```

直接 `compile` 也一样：

```
render raw: "<script>alert(1)</script>"
nested    : "<img src=x>"
```

输入里的 `<img src=x onerror=alert(1)>` 未经任何处理进入 `.html` 字段，属可直接利用的存储型 XSS。

---

## 发现 2

- **file**: `src/template.js:114-118`（关键行 118）
- **类型**: 模式 6 — 多层 `.replace` 的顺序
- **严重性**: HIGH
- **问题**: `escapeHtml` 的 5 个 `.replace` 中，`&` 被放在**最后**（118 行），于是前面 4 次替换产出的 `&lt;` `&gt;` `&quot;` `&#39;` 里的 `&` 又被第 5 次替换二次转义，变成 `&amp;lt;` 等；`&` 的替换必须排在最前面，这是本模式的经典错误形态。
- **依据**: `node` 实测（`escapeHtml` 直接从 `template.js` import）：

```
"<script>alert(1)</script>" => "&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;"
"<b>"                       => "&amp;lt;b&amp;gt;"
"it's"                      => "it&amp;#39;s"
"A & B"                     => "A &amp; B"

once  : "&amp;lt;b&amp;gt;AT&amp;T&amp;lt;/b&amp;gt;"
twice : "&amp;amp;lt;b&amp;amp;gt;AT&amp;amp;T&amp;amp;lt;/b&amp;amp;gt;"
```

正确顺序（`&` 先行）与错误实现的对比：

```
"Tom & Jerry <3"  buggy: "Tom &amp; Jerry &amp;lt;3"
"Tom & Jerry <3"  fixed: "Tom &amp; Jerry &lt;3"
```

函数不幂等（`idempotent? false`），二次调用每次再叠一层 `amp;`：

```
input "&"  buggy: "&amp;" -> "&amp;amp;" -> "&amp;amp;amp;"
```

标准解码一轮后无法还原原文，`round-trip == input: false`，实际结果是 `"Tom & Jerry &lt;3"`——用户看到的不是 `&` 和 `<`，而是字面量 `&amp;` / `&lt;`。影响定位为实体损坏与接口契约破坏（输出中已无裸 `<`/`>`，不构成直接 XSS 升级，故不给 CRITICAL）。

---

## 模式检查结果

| 文件 | 模式 6 | 说明 |
|---|---|---|
| `src/template.js` | **命中** | `escapeHtml` 中 `&` 的替换排在最后导致二次转义（:118）；`renderInline` 拼接前无任何转义（:96-99） |
| `src/events.js` | 不适用 | 仅 `Map`/`WeakMap` 增删查，无字符串替换或编码转换 |
| `src/pagination.js` | 不适用 | 纯数值运算，无字符串处理 |
| `src/validate.js` | 不适用 | 只有正则 `.test()`，无 `.replace`、无编码/解码、无产物依赖 |
| `src/index.js` | **命中** | `renderListView` 在 :17 把未转义的 `extra`/`items` 值直接拼入 `html`，缺"先转义后拼接"这一步 |

---

## 范围外附带观察（非模式 6，不计入上表）

`src/template.js:77` 用 `closeTag.replace("/","#")` 反推开标签，得到 `{{#if}}`（无尾部空格），而实际 `openTag` 是 `"{{#if "`（有尾部空格），两者永远不相等，`depth++` 分支是死代码。后果是嵌套同名块解析错乱：

```
nested if template: {{#if a}}A{{#if b}}B{{/if}}C{{/if}}
render a=1,b=1      : "A{{#if b}}BC{{/if}}"     // 期望 "ABC"
render a=0,b=1      : "C{{/if}}"                // 期望 ""
```

这是确实存在的缺陷，但属块解析/标签匹配问题，不属"转义或编码顺序"，仅作旁注。
