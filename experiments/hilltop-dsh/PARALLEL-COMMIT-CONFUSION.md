# 主线程并行提交造成的困惑（第三次了）

**时间**：2026-11-15
**现象**：三个 agent（R10、R11、R18）在报告里都写了「有一个我没创建的 commit 出现了」。

---

## 事实

那些 commit 都是**主线程**（我）提交的。`sqkl520` 是本机的 git 身份。

```
$ git log --format="%h %an %s" -4
146b149 sqkl520 feat(R18): files_touched 存在性校验 —— 堵 R14 表最后一个口子
ae9a72a sqkl520 docs: R1-R18 总览更新
24ab2d3 sqkl520 feat(R17): check-payload 接进 stop-hook
01c8647 sqkl520 feat(R16a/R16b): target_repo 字段 + 快照自检进流程
```

## 为什么 agent 会误判

我给每个 agent 的任务书都写了「**绝对不要 `git add` / `git commit`**」。
它们照做了。然后它们回头看 `git log`，发现自己工作期间多了一个 commit——
在它们的信息范围内，唯一合理的解释是「有别人提交了」。

**它们不知道主线程在并行工作。** 这是一个信息不对称，不是它们的判断错误。

R10 的表述最谨慎：

> 工作区相对 HEAD 仍有 74 行差额……**后续收口时请以工作区为准，不要以 HEAD 的版本为准。**
> 我没有 `git reset` 或 amend——那会动到并行 agent 的提交，超出授权。

它没有擅自 revert，而是如实报告并给建议。这个反应是对的。

## 我的真实错误

**在 agent 工作期间用 `git add -A` 提交，会把它们的未完成工作一起收进去。**

- R10 那次：`git add -A` 把它的中间态（测试刚绿但还在优化）提交了，
  而 commit message 写的正是「check-fix-instances 150 断言」——那是它的中间数字
- R11 那次：同样
- R18 那次：这次我谨慎了，只 `git add` 了明确列出的文件，内容与它最终状态一致

## 正确的做法

1. **并行 agent 工作期间，只提交明确列出的路径**，绝不用 `git add -A`
2. **或者干脆等 agent 完成后再提交**——它跑 25 分钟，我等 25 分钟的成本很小
3. 如果确实要在中途提交，在 commit message 里注明「这是中间态」

## 另一件事：agent 越界改文件

R18 主动报告了它改了两个「授权范围外」的文件：

> **I touched two files outside the authorized pair.** `tools/stop-hook.test.mjs` 和
> `tools/fix-phase-e2e.test.mjs` 的 fixture 声称 `src/main.js` / `src/A.java` / `src/a.java`
> 被改了，但那些文件从未被创建——新规则正确地让 9 条断言变红。
> 我改的是 fixture（创建文件），遵循 R17 §3.1 的「让 fixture 诚实，不要弱化闸门」。

**这个越界是对的。** 它的理由也硬：另一个选项是加 `--no-files-touched` 逃生舱，
而「逃生舱就是给假路径开后门」。

**判断标准**：越界是否为了保持判据的完整性？如果是，报告出来即可；
如果是为了让测试变绿而绕过判据，那是严重问题。R18 属于前者。

---

## 一句话

agent 说「有个 commit 不是我做的」时，**先查是不是主线程干的**，再怀疑其他。
到目前为止三次都是主线程。
