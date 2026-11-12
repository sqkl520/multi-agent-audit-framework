# 实验设计失误记录（第二次同类错误）

---

## 事故：答案表放在被审对象的父目录里

**E/F 两组实验（2026-11-11）**：

```
experiments/
  injected/          ← 被审对象（任务书指这里）
  manifest.json      ← 完整答案表（15 条缺陷的定义 + 行号）
  base/              ← 对照版本（无缺陷）
  D2-report.md       ← 之前的审查报告
```

任务书让 agent 审 `experiments/injected/`，但答案表就在**上一级目录**。

**F 组在回复里明确写了**：

> 我也找到了 `experiments/manifest.json` 和 `README.md`，并把它们用作交叉核对

**结果作废**：E 和 F 都报了 100%，但无法排除它们看了答案。

---

## 这是第二次犯同一个错

**第一次**（D 组）：`base/` 就在 `injected/` 旁边。D 组明确写道「`base/` 是完全没有缺陷的基线，两者的 diff 就是机械证据」，引用了 10 次。

当时我发现了，改成把代码隔离到 `/tmp/gt-hidden/` 再跑 D2。

**这一次**：我把实验数据迁进 git 仓库（为了防丢失），结果 `manifest.json` 又和 `injected/` 待在同一个目录树里了。

**为什么重犯**：我关注的是「数据别丢」，忘了「答案别泄」。两个目标需要同时满足——数据要留在 git 里，但答案必须在物理上远离被审对象。

---

## 正确做法

```
experiments/
  injected/          ← 被审对象
  ...

/tmp/iso-<run>/      ← 每次实验现建，只放代码
  code/
```

**判据**：被审目录的**任何祖先目录**里，不得出现以下文件：
- `manifest.json` / `answer*.json` / `expected*.json`
- `base/` / `original/` / `before/`
- 之前同类实验的报告

**机械检查**（应该加进实验脚本）：

```
从被审目录向上遍历到根，检查每一级目录里有没有上述文件
只要命中，立即中止实验
```

---

## 已采取的补救

1. **E/F 报告标记为作废**，不作为证据
2. 重跑 G/H，代码复制到 `/tmp/iso-a/code`，路径里只有 `code/` 一个目录
3. **写成了脚本 `setup-run.mjs`**——每次实验前自动做泄题检查

### `setup-run.mjs` 的作用

```bash
node experiments/setup-run.mjs <run-name>
```

它做三件事：

1. **从被审目录向上遍历到根**，检查每一级目录有没有这些文件：
   ```
   manifest.json / answer*.json / expected*.json
   base/ / original/ / before/ / baseline/
   *-report.md / score.mjs / verify.mjs
   ```
2. 命中就**中止**，列出全部泄露文件
3. 通过则复制到 `/tmp/iso-<run-name>/code/`，再检查一遍

**实测**：从 `experiments/injected/` 出发，它列出了 7 个泄露文件（`base/`、`manifest.json`、`D2/E/F-report.md`、`score.mjs`、`verify.mjs`）——**正是 E/F 作废的原因**。

从 `/tmp/iso-a/code` 出发，0 命中。

---

## 一个更深的问题

**两次都发生在「我把实验数据整理得更好」的时候**：

- 第一次：为了让 base 和 injected 在一起便于对比 → base 泄题
- 第二次：为了防数据丢失把全部产物收进一个目录 → manifest 泄题

**整理得越整齐，泄题风险越高。** 因为「相关的东西放一起」和「答案要和考卷分开」是矛盾的要求。

**解法只有物理隔离**：被审对象必须在独立的路径下，且该路径的祖先链上没有实验结果。
