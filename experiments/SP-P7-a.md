我已读取全部 5 个文件，并在 `%TEMP%\p7-scratch\` 下用 node 做了实际验证。以下是报告。

---

## 发现 1

- **file**: `src/pagination.js:15-16`
- **类型**: 边界值的符号处理 / 校验缺失下界
- **严重性**: CRITICAL
- **问题**: `Number.isInteger(page)` 只校验“是不是整数”，不校验 `page >= 1`；紧接着的 `Math.min(safePage, totalPages)` 只做上界夹取，没有 `Math.max(1, ...)`，负数页码被原样放行。
- **依据**（已在 node 中运行，见 `%TEMP%\p7-scratch\t1.mjs`）：
  ```
  paginate(100, -1, 10) => {"page":-1,"totalPages":10,"offset":-20,"limit":10,"hasNext":true,"hasPrev":false}
  paginate(100, 0, 10)  => {"page":0,"totalPages":10,"offset":-10,"limit":10,"hasNext":true,"hasPrev":false}
  paginate(100, -5, 10) => {"page":-5,"totalPages":10,"offset":-60,"limit":10,"hasNext":true,"hasPrev":false}
  ```
  同函数里 `total` 和 `pageSize` 都显式判了 `< 0` / `< 1`（第 8、11 行），只有 `page` 漏了——这是遗漏，不是设计。`Math.min(-1, 10) = -1`，若改成 `Math.max(1, Math.min(-1, 10))` 即为 `1`，证明下界夹取确实缺失。

## 发现 2

- **file**: `src/pagination.js:37`
- **类型**: 边界值的符号处理 / 负索引语义翻转
- **严重性**: HIGH
- **问题**: `items.slice(info.offset, info.offset + info.limit)` 在 `offset` 为负数时**不报错**，而是从数组末尾倒数取窗口，返回一段“看似合法”的真实数据，分页语义完全翻转。
- **依据**（`%TEMP%\p7-scratch\t3.mjs`，25 条数据、pageSize=10）：
  ```
  page=-1 offset=-20 slice(-20, -10) items=[5,6,7,8,9,10,11,12,13,14]
  page=-2 offset=-30 slice(-30, -20) items=[0,1,2,3,4]
  对照 page=2 => [10,11,12,13,14,15,16,17,18,19]
  ```
  `page=-1` 返回的不是空、不是错误，而是第 5~14 条（页边界错位半页）。越界没有变成异常，而是变成了另一条页面路径。

## 发现 3

- **file**: `src/pagination.js:20`
- **类型**: 边界值的符号处理 / 乘除后的符号
- **严重性**: MEDIUM
- **问题**: `offset: (clamped - 1) * pageSize` 在 `clamped` 为 0 或负数时，`(clamped-1)` 为负，乘 `pageSize` 后 offset 变成绝对值随页码线性放大的负数，且没有任何下限保护。
- **依据**（`%TEMP%\p7-scratch\t9.mjs`）：
  ```
  paginate(100, 0, 10)  => offset = -10
  paginate(100, -5, 10) => offset = -60
  page=-1000, pageSize=10 => offset = -10010, hasNext = true, items = 0
  page=-MAX_SAFE_INTEGER  => offset = -90071992547409920, hasNext = true, items = 0
  ```
  负数没有在中间值阶段被夹住，直接进入 `limit/offset` 语义。若下游把 `offset` 交给 SQL `LIMIT/OFFSET`，`LIMIT -20` 在多数数据库里是语法错误或全表返回，而不只是一个空页。

## 发现 4

- **file**: `src/pagination.js:15-16`
- **类型**: 边界值的符号处理 / 负零
- **严重性**: MEDIUM
- **问题**: `-0` 能穿透常见防御写法（`page >= 0` 为 true、`page < 0` 为 false），并产出自相矛盾的结果：`page` 报 0，但 `offset` 是 -10。
- **依据**（`%TEMP%\p7-scratch\t3.mjs`、`t2.mjs`）：
  ```
  guard(-0) = {"p<0":false, "p<1":true, "p>=1":false}
  paginate(100, -0, 10) => {"page":0,...,"offset":-10,...}  Object.is(page,-0)= true
  paginateArray(arr, -0, 10) => page -0  offset -10  items []
  arr.slice(-10, -0) = []   vs   arr.slice(0, 10) = [0,1,2,3,4,5,6,7,8,9]
  ```
  真实来源：`Number('-0')`、`parseInt('-0', 10)`、`Math.ceil(-0.5)` 都返回 `-0`（已实测，`t4.mjs`），所以“从 query string 转数字”这条常见路径可以产出 `-0`。JSON 序列化后 `page` 显示为 `0`（`JSON.stringify(-0) === "0"`），日志里看不出异常，但 `offset` 是 `-10`，排障时会出现 page 与 offset 对不上的鬼故事。

## 发现 5

- **file**: `src/pagination.js:22`
- **类型**: 边界值的符号处理 / `total = 0` 边界
- **严重性**: MEDIUM
- **问题**: `hasNext: clamped < totalPages` 在 `total = 0` 且 page 为负时成立（`-3 < 1`），于是“空数据集”返回 `hasNext: true`，与 `items` 为空直接矛盾，会让按 `hasNext` 翻页的客户端空转。
- **依据**（`%TEMP%\p7-scratch\t4.mjs`、`t9.mjs`）：
  ```
  paginate(0, -3, 10) => {"page":-3,"totalPages":1,"offset":-40,"limit":10,"hasNext":true,"hasPrev":false}
  空数组实际 items = [] 长度 0

  page 从 -100 开始，共 104 页，其中空页 99 页，数据只有 25 条
  ```
  翻页循环实测会经历 page=-100 → -99 → … → 1 共 104 次迭代，其中 99 次是空页。空数据集反而触发了最长的翻页链。

## 发现 6

- **file**: `src/index.js:13-14`
- **类型**: 边界值的符号处理 / 公共入口无校验
- **严重性**: MEDIUM
- **问题**: `renderListView` 把 `page` 原样透传给 `paginateArray`，自身不做任何符号检查；它是这个模块对外暴露的入口，负数与 `-0` 在这里完整泄漏到返回值和渲染出的 HTML。
- **依据**（`%TEMP%\p7-scratch\t6.mjs`）：
  ```
  renderListView(page=-1).pagination  = {"page":-1,"totalPages":3,"hasNext":true,"hasPrev":false}
  renderListView(page=-0).pagination  = {"page":0,"totalPages":3,"hasNext":true,"hasPrev":false}
  renderListView(page=-2) html        = "-2/3:0,1,2,3,4,"   ← 负页码被渲染进页面
  renderListView(page=-1) 的 html     = "5,6,7,8,9,10,11,12,13,14,"  ← 错位窗口
  ```
  返回的 `pagination.page = -1` 会被前端直接用于生成翻页链接，负数继续往 URL 里传。

## 发现 7

- **file**: `src/validate.js:6`
- **类型**: 边界值的符号处理 / 负数约束参数
- **严重性**: LOW
- **问题**: `minLength: (v, n) => v.length >= n` 不校验 `n` 是否非负；当 schema 里 `arg` 为负数时，`''.length >= -5` 恒为 true，该规则被静默禁用而不报错。
- **依据**（`%TEMP%\p7-scratch\t7.mjs`）：
  ```
  minLength arg=-5, value=""   => valid: true   errors: {}
  minLength arg=-5, value="ab" => valid: true   errors: {}
  minLength arg=3,  value=""   => valid: false  {"name":["name failed minLength"]}
  ```
  注意这是**单向**的：`maxLength: -1` 会正确地判定失败（`''.length <= -1` 为 false），所以只有 `minLength` 会出现“约束悄悄失效”。同理 `integer` 规则对负数放行（`validate({n:-99999})` 为 valid）——这一条我判定**不是**缺陷，负整数本来就是整数，`integer` 语义正确。

---

## 模式检查结果

| 文件 | 模式 7 命中 | 说明 |
|---|---|---|
| `src/template.js` | **未命中** | 所有 `slice` 的下标都来自 `indexOf` 结果或 `length`，且 `indexOf === -1` 在每个分支前都已拦截；`next` 由 `Math.min` 得出且恒 `>= i`。无可被外部输入的负下标。 |
| `src/events.js` | **不适用** | 无对外暴露的数值参数。`indexOf` 的 `-1` 返回值在第 42 行被显式拦截后才 `splice`，`splice` 不会收到负索引。 |
| `src/pagination.js` | **命中** | 发现 1、2、3、4、5。`page` 无下界、`-0` 直通、`(page-1)*pageSize` 产出负 offset、`slice` 负索引语义翻转、`total=0` 时 `hasNext` 矛盾。 |
| `src/validate.js` | **命中（LOW）** | 发现 7。值层面的符号处理正确（长度恒非负），缺口在约束参数 `arg` 未做非负校验。 |
| `src/index.js` | **命中** | 发现 6。公共入口 `renderListView` 把 `page` 无校验透传，负值泄漏到返回契约与 HTML。 |

---

## 附注（超出模式 7，仅作记录，未计入上述发现）

审计过程中顺带观察到 3 处不属于本维度的真实缺陷，供你决定是否另开任务：

1. `src/template.js:77` — `openTag === closeTag.replace("/","#")` 恒为 false（实测 `'{{#each ' === '{{/each}}'.replace('/','#')` → `false`），导致嵌套 `{{#each}}` 无法正确配对，实测输出 `"O{{#each inner}}I{{this}}O{{#each inner}}I{{this}}{{/each}}"`——内层标签被当文本吐出。
2. `src/events.js:64` — `if (errors.length > 1)` 意味着**只有 1 个监听器抛错时异常被完全吞掉**，既不抛也不记录；与注释“错误会在全部执行完后一起抛出”不符。
3. `src/template.js:113-118` — `escapeHtml` 先替换 `<`/`>`/`"`/`'` 最后才替换 `&`，实测 `escapeHtml('<a>')` 得到 `&amp;lt;a&amp;gt;`，双重转义；且输入已含 `&lt;` 时也被再转义一次。

验证脚本全部位于 `<HOME>\AppData\Local\Temp\p7-scratch\`（`t1.mjs` ~ `t10.mjs`），被审目录未做任何修改。
