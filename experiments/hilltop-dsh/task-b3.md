审计目标（第三批，剩余全部模块）：
<TARGET_REPO>/src/main/java/com/hilltopvillage/

按风险分成 3 组，**并行派 3 个 subagent**，每个负责一组：

**组 A（数据与配置，最高风险）**
- config/   13 文件 5,966 行
- stats/     1 文件   540 行

**组 B（命令与权限）**
- command/   5 文件 4,566 行
- admin/     8 文件 3,592 行

**组 C（外围）**
- shop/      7 文件 1,268 行
- util/      6 文件 1,533 行
- gui/       1 文件   338 行
- doc/       1 文件   448 行
- diagnostic/1 文件   119 行

## 每个子 agent 的硬要求

1. **必须用 read 工具真的打开文件**，不许凭文件名猜。
2. 每条发现带 `file:line` + **逐字引用的代码原文**（来自你这轮实际读到的那一行）。
3. 只报有具体代码证据的，不确定的不报。

## 查什么

组 A 重点：
- 配置加载与 GUI 修改**两条路径语义是否一致**（前两轮已发现 2 例同类：`victory-waves` 加载不钳制/GUI 钳制；`explode-damage-multiplier` 一处当伤害倍率、一处当爆炸威力）
- 空值 / 缺键 / 值为空字符串的处理
- 玩家数据落盘的部分写入、异常路径

组 B 重点：
- 命令参数的边界（数字、负数、超大值、空串）
- 权限检查是否**每条命令都有**（漏一条就是提权漏洞）
- 管理员操作是否有回滚

组 C 重点：
- 钱币/物品的数量运算（溢出、负数、小数）
- 资源泄漏（listener/task 未注销）
- 边界符号（下标、负数、`slice(-n)` 语义翻转）

## 产物

`experiments/hilltop-dsh/out/round3-<组名>-audit.md`（组名用 A/B/C），共 3 份。
正文每条 3-5 句 + 末尾完整 JSON 信封（role=audit，格式照抄 `framework/components/output-contract/examples/audit.md`）。

写完自检：`node tools/check-payload.mjs <产物> --role audit`，不通过修到通过。

## 汇总

最后告诉我：3 份产物的路径、各自校验结果、一共几条发现。
