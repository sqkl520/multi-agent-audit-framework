审计目标（限定范围）：<TARGET_REPO>/src/main/java/com/hilltopvillage/core/

这是 Minecraft 服务端插件（Paper）的核心模块，5 个 Java 文件共 2742 行：
GameManager.java / GameState.java / PlayerData.java / PlayerGoodsManager.java / WaveManager.java

## 你的任务

用 subagent 工具派一个审计 agent 去读这些文件，找**真实的代码缺陷**。

## 硬性要求（不满足就等于没做）

1. **必须真的用 read 工具打开文件**。凭文件名或目录名猜出来的结论一律不算。
2. **每条发现必须带 `file:line` 和逐字引用的代码原文**。引用必须来自你这一轮实际读到的那一行，
   不许凭记忆或推测。
3. **重点查 concurrency**：Bukkit/Paper 的 API 大多必须在主线程调用。
   如果代码在 async 任务里碰世界状态（setBlock / spawn / 修改实体 / 调用 GUI），那就是真缺陷。
   找 `Bukkit.getScheduler().runTaskAsynchronously`、`CompletableFuture`、`Thread`、
   `synchronized`、`volatile`、共享可变状态。
4. 另外查：数值边界（0/负数/NaN）、集合的并发修改、异常被吞掉、返回值暴露内部引用。

## 输出要求

产物写到：<FRAMEWORK_ROOT>/experiments/hilltop-dsh/out/round1-core-audit.md

格式：
- 正文写分析
- 最后必须有一个 ```json 代码块，内容是完整的 JSON 信封（参考
  <FRAMEWORK_ROOT>/framework/components/output-contract/examples/audit.md）
- role 填 "audit"，findings 数组里每条要有 finding_id / dimension / severity / evidence{file,line,quote} / inference{claim,basis,alternatives} / status

写完自检：
node "<FRAMEWORK_ROOT>/tools/check-payload.mjs" <你的产物> --role audit

退出码非 0 就按它说的修，修到通过为止。
