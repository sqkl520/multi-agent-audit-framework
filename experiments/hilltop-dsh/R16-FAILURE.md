# R16 失败记录：30 分钟零产出

**时间**：2026-11-15 23:55 – 00:40
**任务**：把 `check-payload` 接进 stop-hook + 加 `target_repo` 字段 + 加 `files_touched` 校验
**结果**：**零产出**。`target_repo` 在 `run-state.md` 和 `check-state.mjs` 里 grep 都是 0 处。

---

## 证据

```
$ grep -c "target_repo" framework/artifacts/run-state.md tools/check-state.mjs
framework/artifacts/run-state.md:0
tools/check-state.mjs:0
```

文件 mtime 显示它确实动过手：

```
Nov 16 00:10  framework/artifacts/run-state.md
Nov 15 23:58  tools/check-state.mjs
Nov 16 00:28  tools/stop-hook.mjs
```

但最终 `git status` 是干净的——**改了又还原，或者改在别处又被覆盖**。

---

## 为什么失败（我的推测与依据）

**任务太大了。** 我在一个 prompt 里塞了四件事：

1. `run-state.md` 加字段
2. `check-state.mjs` 加条件必填
3. `stop-hook.mjs` 接 `check-payload`（要读 3000 行的校验器接口）
4. 评估 `files_touched` 该在哪实现

其中第 3 项需要理解 `check-payload.mjs` 的调用协议、`--repo`/`--artifact-dir` 的语义、
逐份调用的性能特征。这是**一个独立任务的工作量**，我把它和三个小任务捆在一起。

**对比证据**：R1（改 3 个文件 + 2 个测试）成功，R5（改 6 个文档）成功，
R8（新建 1 个校验器 + 测试）成功。这些任务的规模都比 R16 小一半以上。

**另一个可能因素**：我给的纪律是「先写失败测试，确认 FAIL，再改代码」。
R16 要先写 4 类测试（check-state 的 4 条、stop-hook 的 5 条、性能用例），
这本身就是一大坨工作。它可能一直在写测试，没来得及落到主代码。

---

## 处理

按用户的规矩「任何 agent 因任何问题报错，都必须全量重跑」，但**重跑时要拆小**——
同一个 prompt 重派一次只会再失败一次。

拆成两个：

| 新任务 | 范围 | 预期 |
|---|---|---|
| **R16a** | `run-state.md` 加字段 + `check-state.mjs` 加条件必填 + 测试 | 3 个文件，小 |
| **R16b** | 把快照校验接进 `wave4-fix.md` / `wave5-verify.md` 的流程文档 | 2 个文件，小 |

**原来 R16 里的第 3 项（stop-hook 接 check-payload）暂时不做**——
它是最大的一块，且依赖 `target_repo` 字段先存在。等 R16a 落地后再单独派。

---

## 教训

**派发粒度是调度者的责任，不是执行者的能力问题。**

我把「一个 agent 能做多大一块」估计错了。R16 的 prompt 有 5000+ 字，
包含 4 个交付物、12 条测试用例、2 个自证场景——这已经是一个「轮次」而不是「任务」。

更严重的是，我在 prompt 里写了「先写失败测试」的纪律，却没有意识到
这条纪律在任务本身过大时会变成**拖延的借口**（一直写测试，永远到不了实现）。

下次判据：**如果一个任务的 prompt 超过 3000 字，或者交付物超过 2 个，就该拆。**

---

## 还有一个可能被我忽略的问题

R16 的 prompt 里我写了：「**先评估**：能不能在不改 `check-payload.mjs` 的情况下，
由 stop-hook 自己校验 `files_touched`？」

这种「先评估再决定」的开放式指令会显著增加不确定性——
模型要花大量 token 权衡两种方案，而无论选哪个，我作为调度者本该先定好。

**调度者该做的决定，不要推给执行者。**
