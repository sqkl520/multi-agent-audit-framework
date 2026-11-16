# proto/out 下的源码副本已删除

**时间**：2026-11-17 05:40

## 删了什么

`experiments/review-7/proto/out/snapshot/`（8.2M）与 `proto/out/fulltree/`（1.6M），
共 **219 个被审仓库的 Java 测试源文件副本**。

## 为什么删

**两份都是副本，不是唯一记录。** 真实代码在
`<TARGET_REPO>`
（有 git，历史可查）。判据与 `experiments/hilltop-dsh/repair-work/CLEANUP.md` 完全相同：

> **删副本，留记录。** 副本能重建，记录不能。

还有一个额外理由：它们是被别的项目的源码，被 `git add -A` 无意中扫进来的。
框架仓库不该含有被审仓库的源码副本——那会让「只读审查」这条边界在仓库层面失效。

## 怎么重建（如果真要复现）

原型的全部脚本仍在 `proto/*.mjs`，它们从被审仓库直接读文件：

```bash
cd "<TARGET_REPO>"
node <framework>/experiments/review-7/proto/q1-quality.mjs    # 或任一 proto 脚本
```

副本只是当年跑批的中间缓存，不是数据源。

## 什么没动

`proto/*.mjs`（全部脚本）与 `proto/out/*.json`、`proto/out/*.md`（全部结果）全部保留。
**GROUND-TRUTH 文档里引用的每一个数字都出自这些 .json/.md，它们都还在。**

## 教训

`git add -A` 会扫进任何东西。本轮我用了 12 次，每次都直接提交。
这个仓库里已经因为 `git add -A` 出过一次事故（`PARALLEL-COMMIT-CONFUSION.md`：
在子 agent 工作时扫进了它们未完成的改动）。

**正确做法**：提交前 `git status --short` 逐行看一眼，或者对自己不确定的目录用显式路径。
本次是原型 agent 跑的批处理把仓库整棵树复制到了 `out/` 下，而我 `git add -A` 时没看。
