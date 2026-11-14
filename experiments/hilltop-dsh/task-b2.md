审计目标（本批 3 个模块）：
<TARGET_REPO>/src/main/java/com/hilltopvillage/

- arena/     7 文件 4,241 行   ← 最高风险：多玩家共享状态 + 生命周期
- mechanics/ 14 文件 6,119 行  ← 最大模块：游戏机制，定时任务密集
- ai/        5 文件 1,376 行   ← 实体 AI，路径寻路与线程

## 任务

**并行派 3 个 subagent，每个负责一个模块。** 不要一个 agent 串行读三个模块——那样会因上下文超限而草率收尾。

每个子 agent 的 prompt 里必须包含：
1. 它负责的模块绝对路径
2. 「必须用 read 工具真的打开每个文件，不许凭文件名猜」
3. 「每条发现必须带 file:line 和逐字引用的代码原文，引用必须来自你这一轮实际读到的那一行」
4. 产物路径（见下）

## 查什么（按本仓库实际情况）

优先级从高到低：

1. **concurrency**——Bukkit/Paper API 大多必须在主线程。找：
   - `runTaskAsynchronously` / `runTaskTimerAsynchronously` 里碰世界状态（setBlock/spawn/实体/GUI/玩家数据）
   - `CompletableFuture`、`Thread`、线程池里访问 Bukkit 对象
   - 共享可变状态无同步（`static` 集合、缓存的 Map）
   - `synchronized` 锁范围过大或过小
2. **data-consistency**——玩家数据/存档读写，异常路径下的部分写入，缓存与源不一致
3. **error-handling**——异常被吞（空 catch、catch 后只 log）、异常会拖垮 tick
4. **数值边界**——0/负数/NaN/Infinity/小数没有校验；数组下标越界
5. **资源泄漏**——注册的 listener/task/bossbar/scoreboard 没有注销

## 已知的同类先例（本轮 core 模块已确认 3 条，供参考判断标准）

- 序列化 Bukkit 对象发生在异步线程，与类注释声称的「留在主线程」相反
- 配置键在加载侧无钳制、在 GUI 侧有钳制，两条入口语义不同
- tmp 文件名唯一性只靠 System.nanoTime()，而它正是「写盘不加锁」的依据

**这三条的共同点：不是「代码看起来不好」，而是「代码做了它自己说不做的事」或「两条路径对同一件事给出了不同答案」。**
优先找这种，不要在风格问题上浪费预算。

## 产物

每个子 agent 写一份：
`experiments/hilltop-dsh/out/round2-<模块名>-audit.md`

结构：正文 3-5 句/条 + 末尾一个完整 JSON 信封（role=audit）。
信封格式照抄 `framework/components/output-contract/examples/audit.md`。

写完自检：
`node tools/check-payload.mjs <产物> --role audit`

不通过就修到通过。**三个模块各一份，共三份。**

## 最后

汇总时告诉我：每份产物的路径、各自的校验结果、一共找到几条发现。
