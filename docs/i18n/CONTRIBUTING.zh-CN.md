[English](../../CONTRIBUTING.md) | 简体中文

# 参与贡献

感谢关注。这个仓库是一套**提示词 / 契约框架**，不是一个库——
这里的「代码」大部分是指导 LLM 的 Markdown，加上一些 Node.js 校验器，
后者用机械的方式检查产物是否符合那些指导。

这决定了什么样的贡献是有用的。

## 最有用的贡献

1. **一个可复现的反例。** 这个框架的论断都带数字（召回率、误报率、闸门覆盖率）。
   如果你发现某道宣称存在的闸门没有触发，或者在不该触发时触发了，那是最有价值的报告。
   请附上输入与观察到的输出。
2. **可移植性修复。** 框架目前假设 harness 支持子 Agent 与文件系统。见 `framework/PORTABILITY.md`。
3. **文档与事实不符的修正。** 这个仓库历史上多次出现「契约写了 X，校验器没检查 X」。
   如果你发现一处，那就是 bug。

## 不太有用的

- 没有复现的通用提示词工程建议。
- 「用 <某框架> 重写会更干净」——这里的约束是产物必须同时**能被 LLM 读**、**能被脚本检查**。

## 开 PR 之前

跑完整的机械校验套件，必须全绿：

```bash
node tools/check-all.mjs
```

这会跑 52 个自测套件，覆盖每一个校验器。某个套件失败就说明 PR 还没准备好——
这些套件是唯一能区分「规则存在」和「规则被强制执行」的东西。

当你在 `framework/` 下新增或修改一条规则时：

```bash
# 1. 三层闭环：模板 + 契约 + 校验器必须一起改。
#    只改 Markdown 意味着这条规则没有任何强制执行。
node tools/check-rule-ledger.mjs --gate --since HEAD
```

如果你新增了一条规范性语句（含「必须 / 不得 / never」），而没有任何校验器读它、
也没有显式标为 `DISCRETIONARY` 并给出理由，这条命令会失败。

## Commit message

`type(scope): 改了什么、为什么`。本仓库用到的 type：`feat`、`fix`、`docs`、`test`、
`perf`、`cleanup`、`correct`、`diag`、`verdict`。

写**为什么**。一个只写「fix bug」的提交，六个月后没人能评审。

## 环境

- Node.js **≥ 22**（部分 harness 日志校验器用到 `zlib.zstdDecompressSync`，22.15 起提供）。
  在更旧的 Node 上，这些校验器会报「当前 Node 不支持 zstd」而不是崩溃，但支持下限是 22。
- Git，用于那些要读目标仓库 `git status` / `git diff` 的检查。
- 没有安装步骤——本仓库**刻意保持零运行时依赖**。
  不要为了一个小功能引入依赖；校验器保持无依赖是为了能在任何地方跑。

## 报告安全问题

**不要开公开 issue。** 见 [SECURITY.zh-CN.md](SECURITY.zh-CN.md)。

## 行为准则

见 [CODE_OF_CONDUCT.zh-CN.md](CODE_OF_CONDUCT.zh-CN.md)。
