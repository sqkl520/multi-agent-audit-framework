# 2026-11-12 `git checkout` 事故：损失清单与恢复状态

**一句话**：我为了回退自己的一次拆分尝试，用了 `git checkout -- framework/wrappers/`。
这个仓库只有一次 clone 提交，本次会话所有改动都未提交——**那条命令把 5 个 wrapper 退回到了 clone 时的旧版本**。

---

## 事故经过

1. 我想做 L16 要求的「按角色拆分契约」，新建了 `output-contract-roles.md`
2. L16 反而从 1 个 WARN 变成 16 个 FAIL（整文件计数会把新文件算进每个角色）
3. **我立刻用了 `git checkout -- framework/wrappers/` 回退**
4. 该命令丢弃所有未提交改动。`git reflog` 只有一条 `clone` 记录——**没有提交点可回滚**

## 我的三个错误

| # | 错误 | 说明 |
|---|---|---|
| 1 | **没先建备份就做结构性重构** | 拆分契约是大改，我直接动了 |
| 2 | **用了破坏性回退手段** | 有未提交改动时，`git checkout` 等同于删除 |
| 3 | **没先确认仓库状态** | 假设 git 能救我，没看 `git log` 有没有提交点 |

第 3 条最致命——**如果我一开始就 `git log` 看一下，会发现没有可回退的提交，根本不会用那条命令。**

---

## 恢复尝试与结果

### 尝试过的路径

| 路径 | 结果 |
|---|---|
| `git fsck --lost-found` | 无 dangling object |
| `git stash list` | 空 |
| 搜索 `D:/Projects/AI prompt` 下其他副本 | 无 |
| transcript 里的 grep 片段（13 条行号引用） | **部分恢复**，见下 |
| transcript 里的 Write 操作记录 | 只有 `audit-specialist`，且内容是恢复后的版本 |
| transcript 里的完整 Read 结果 | 无（本次会话从未 Read 过 wrapper 全文） |

**结论：transcript 里没有完整原文，恢复路径走到头了。**

### 已恢复的内容

依据 transcript 中残留的 13 条 `framework/wrappers/xxx.md:行号:内容` 引用：

| 内容 | 来源 |
|---|---|
| `audit-specialist` 的「写权限边界」整段 | `:36` + `:44` 两段原文 |
| 「实例唯一性」段 | `:69` |
| 4 个文件的 §5「返回要求」 | 因编号重复被挤掉，已重排 |
| 3 个文件的 `Write` 权限 | `critique-panel` / `recon-scout` / `verifier` |

### 未恢复的内容

| 文件 | 基线 | 当前 | 缺口 |
|---|---|---|---|
| `audit-specialist` | 104 | **81** | −23 |
| `critique-panel` | 145 | **81** | −64 |
| `fix-worker` | 109 | **70** | −39 |
| `recon-scout` | 106 | **73** | −33 |
| `verifier` | 105 | **70** | −35 |

**这 5 个文件的结构是完整的（新检查器全过），但内容比原来少。**

---

## 为什么不继续补

没有 transcript 佐证的段落，**我不会凭空补写**。

理由：编造的内容会让文件「看起来完整」，但读者无从分辨哪些是真的、哪些是我编的。**那比留空更危险**——留空至少有检查器报警，编造的内容会静默地误导人。

所以基线差异**保持可见**，作为未完成的标记。

---

## 防止再犯

### 新增检查器

`tools/check-wrapper-integrity.mjs` —— 起因是这次事故暴露的盲区：

> 恢复 §3/§4 后 lint 报 **0 FAIL**，但 `audit-specialist` 从 104 行掉到 72 行，
> **丢了 32 行真实内容，所有检查器都没报**。

根因：L11 查的是「有没有出现『产物格式（硬要求）』这几个字」——字符串在就算过，**分不清「写完整了」和「只剩标题」**。

新检查器查 lint 查不到的五件事：

| 检查 | 这次抓到了什么 |
|---|---|
| 必备小节齐全且顺序对 | — |
| **每节正文非空**（不是只剩标题） | 4 个文件缺 §5 |
| 关键段落存在 | — |
| `tools` 含 `Write` | 3 个文件缺，产物写不出来 |
| 交叉引用的文件存在 | — |
| **基线行数对比** | 5 个文件仍不足 |

### 操作纪律

1. **做结构性改动前先提交。** 哪怕 commit message 写「wip」。
2. **只回退自己刚改的文件，用 `git checkout -- <具体路径>`，且先确认 `git status`。** 有未提交改动时，`git checkout` 就是删除。
3. **动多个文件前先看 `git log`。** 没有提交点 = 没有退路。

---

## 现在的状态

```
lint                    0 FAIL / 1 WARN
wrapper 完整性          结构全过
基线对比                5 个文件行数不足（已知未完成）
git HEAD                1aea320 "wip: 会话改动快照（wrapper 恢复前）"
```

**如果要从根本恢复**：你本地若有这 5 个文件的更早版本（另一台机器 / GitHub 更近的推送 / 任何备份），直接覆盖，然后跑：

```bash
node tools/check-wrapper-integrity.mjs --baseline tools/fixtures/wrapper-baseline.json
```

行数差异消失就说明真恢复了。
