# dsh 原生运行（2026-11-20）

用 **dsh 0.2.1-rc.2** 原生跑框架，主线程只发起调用与读结果，实际工作全部由 dsh 派子 Agent 完成。

| 文件 | 说明 |
|---|---|
| `RUN-REPORT.md` | **结果报告**：跑了什么、产出什么、校验器怎么判、发现了什么 |
| `task.md` | 第一次运行的任务书 |
| `task-resume.md` | 续跑任务书（含「派完必须等落盘」的教训） |
| `patch.yml` | dsh 的上游配置（endpoint / model / reasoningEffort） |
| `run.log` / `run2.log` | dsh 的推理日志 |
| `count.mjs` | 统计产物里的发现条数与严重性 |
| `artifacts/` | 产物：1 份侦察 + 26 份宽扫 + 4 份深挖 + 1 份报告 + state.json |

## 一句话

**能跑，跑出了真发现，但跑不完。**

三条真缺陷（异步线程序列化 Bukkit 对象 / 锁竞争抵消异步收益 / 非单调时钟做超时）
门 0 引用逐字可核。但锐评波完全没跑，最终报告多处「（收尾时填）」占位符。

根因不是框架规则的问题，是 **dsh 没有 Stop hook**：主 Agent 说「End turn」，
进程就走了，不管还有多少子 Agent 在跑。第 1 次运行因此丢了 4 份深挖产物。

## 复现

```bash
DSH=~/.dsh-win/versions/0.2.1-rc.2/node_modules/@deepseek-ai/dsh/lib/bin.js
AUDIT_API_KEY='<key>' node "$DSH" --profile headless \
  --patch .run-dsh3/patch.yml "$(cat .run-dsh3/task.md)"
```

跑完用守卫检查丢了什么：

```bash
node tools/dsh-run-guard.mjs --artifacts .run-dsh3/artifacts \
  --sessions ~/.dsh/sessions --project "<项目目录名>"
```
