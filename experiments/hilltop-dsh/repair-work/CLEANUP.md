# repair-work 已清理

**时间**：2026-11-16

原目录 23M，含 `project/`（修复前基线快照）与 `post-fix/`（修复后快照）。
两者已删除，保留本说明。

## 它们是什么

- **`project/`**：修复前的被审仓库快照（当时用来对照）
- **`post-fix/`**：修复后的源码快照（24 个文件，R13 补的）

## 为什么可以删

两份都是**副本**，不是唯一记录：

- 修复前后的真实代码在 `<TARGET_REPO>`
  （且该仓库有 git，历史可查）
- `post-fix/` 当初建它是因为「修复后的源码曾一度完全不在框架仓库内」（见 `LEGACY-ARTIFACTS.md`）。
  现在源码在目标仓库里好好的，这份副本的历史作用已经完成
- 逐轮的验收记录（`ACCEPTANCE-ROUND1.md` / `ACCEPTANCE-ROUND2.md`）都在，它们才是结论

## 什么没动

`experiments/hilltop-dsh/` 下所有 `.md` 报告（约 145K）全部保留：
`DIAG-FINAL.md`、`FIX-R1-R18-SUMMARY.md`、每轮的 `FIX-RN-report.md`、
`LEGACY-ARTIFACTS.md`、`DISPATCH-PITFALLS.md` 等。

## 判据同 field-test-1

**删副本，留记录。** 副本能重建，记录不能。

## 另删（2026-11-16）

- `baseline.log`（4.5M）/ `baseline2.log`（172K）/ `probe.log`（8K）

都是 `build.cmd -o test` 的原始输出。**可重新生成**：在被审仓库跑一次同样的命令即可。
它们的价值（905/0/0 这个结论）已经写进 `ACCEPTANCE-ROUND2.md` 与 `FIELD-TEST-RESULTS.md`。
