审计目标：<TARGET_REPO>/src/main/java/com/hilltopvillage/core/

5 个文件共 2742 行。**只做一件事**：找出 concurrency 和数值边界两类缺陷，输出**最多 3 条**最确定的。

## 硬要求

1. 用 read 工具真实打开文件，每条发现带 `file:line` 和逐字引用的原文。
2. 只报你能给出**具体代码证据**的。不确定的不要报。
3. **不要写长篇分析**。直接写产物。

## 产物

写到：<FRAMEWORK_ROOT>/experiments/hilltop-dsh/out/round1-core-audit.md

结构：
```
# core 模块审计

（每条缺陷一段，3-5 句，带 file:line 和引用原文）

```json
{完整 JSON 信封，role=audit}
```
```

JSON 信封照抄 <FRAMEWORK_ROOT>/framework/components/output-contract/examples/audit.md 的格式，把 findings 换成你找到的。

写完立刻跑：
node "<FRAMEWORK_ROOT>/tools/check-payload.mjs" <产物> --role audit

不通过就修到通过。
