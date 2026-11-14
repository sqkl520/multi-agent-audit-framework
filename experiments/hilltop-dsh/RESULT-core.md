# dsh 审计 Hilltop Village core 模块：首次真实运行结果

**日期**：2026-11-14 20:39–20:52
**主控**：dsh（不是 Claude Code 主会话）
**模型**：`virtual/opus`（经 <self-hosted-endpoint>:3000，后端 SCNet-Max）

---

## 结论：dsh 真的完成了审计，产出 3 条发现，全部经我独立验证

产物：`out/round1-core-audit.md`（12,728 字节）
契约校验：`check-payload.mjs --role audit` → **✅ 契约合规**

---

## 三条发现（我逐条回源码核对，全部逐字命中）

### F1 · concurrency · MEDIUM：序列化实际发生在异步线程，与类注释相反

代码自己写着「序列化读的是 Bukkit 的 YamlConfiguration，线程安全性没有官方保证，
因此**留在主线程**；只有纯粹的 Files 写入丢到异步线程」（`PlayerGoodsManager.java:339-341`）。

但实际路径是：

```
:478  Bukkit.getScheduler().runTaskAsynchronously(plugin, () -> writeYaml(yaml, seq));
:422  payload = yaml.saveToString().getBytes(StandardCharsets.UTF_8);
```

`MemorySection#set` 只把值存进 map，**真正的序列化发生在 `saveToString()`**。
所以 `saveToString` 在异步线程跑，读的是 `CraftItemStack` 镜像——**与注释声明相反**。

`syncronized(writeLock)` 只和其它 `writeYaml` 互斥，主线程改背包时**不持这把锁**。

**我的核对**：三处引用全部逐字命中，矛盾成立。

### F2 · logic · MEDIUM：`victory-waves` 为 0 或负数时首波直接判胜

```
GameManager.java:304-305   currentWave++;  if (currentWave > totalWaves) endGame(true);
ConfigManager.java:1351    if (settingsYaml.contains("victory-waves")) activeConfig.setVictoryWaves(settingsYaml.getInt("victory-waves"));
GameConfig.java:684        public void setVictoryWaves(int v) { this.victoryWaves = v; }
```

**同一个键的两条入口语义不同：**

| 入口 | 行为 |
|---|---|
| 加载 YAML（`:1351`） | 原样设置，无钳制 |
| GUI 修改（`GameRulesMenu.java:48`） | `Math.min(100, Math.max(1, v))` |

**同文件已有归一化先例**：`wave-timeout-seconds` 走 `normalizeWaveTimeout(...)`（`ConfigManager.java:394`）。
victory-waves 是漏网的那个。而 `0` 恰是最容易被当成「不限波数/关闭」写进配置的值。

**我的核对**：四处引用全部逐字命中，且 GUI 侧确实钳到 ≥1，对照成立。

### F3 · concurrency · MEDIUM：tmp 文件名唯一性只靠 `System.nanoTime()`

```
PlayerGoodsManager.java:409-410   FILE_NAME + "." + System.nanoTime() + ".tmp"
PlayerGoodsManager.java:386-387   「正因为 tmp 文件互不相干，Files#write 不需要互斥」
```

**把「tmp 互不相干」当既定事实，而它就是「写盘不加锁」的唯一依据。**

它没停在断言上——**自己写了 Java 探针实测**（`tmp-nanotime/NanoProbe.java`）：
本机 JDK 17 / Windows 10 上 `nanoTime` 最小非零增量 100 ns，两线程各取 50 万次，
有 12.5 万–44 万次撞同一数值。

后果：两个并发写选中同一 tmp → `Files.write` 内容交错 → `Files.move` 把损坏内容原子发布
→ 下次启动解析失败隔离为 `.corrupt` → **全部玩家物品快照丢失**。

**我的核对**：两处引用逐字命中。

---

## 过程记录

| 项 | 值 |
|---|---|
| 父 agent session | `session-bea11980-…` — 398 事件 / 66 次工具调用 |
| 子 agent session | 至少 2 个（`7d640903` 222 事件 / 59 工具，`4f3f00fd` 42 事件） |
| 阅读的文件 | 5 个 core Java 文件全部真读 + grep 配置项 + 写 Java 探针 |
| 结束原因 | `kind: "completed"`（第一次是 `max-tokens` 被截断，把 maxTokens 8192→32000 后成功） |

---

## 一个必须记录的问题：沙箱把产物挡在了 `D:\` 外

dsh 的沙箱禁止写 `D:\`，它只能写到自己的工作目录：

```
<HOME>\.dsh-win\versions\0.2.1-rc.2\out\round1-core-audit.md
```

**它如实报告了这件事，并给出精确的复制命令**，没有假装产物已在目标位置：

> 「产物位置（一处未落到位，需你一步）」

这是正确的行为。但也暴露一个配置问题：审计目标在 `D:\`，而 dsh 的 workspace 在 `C:\`。
后续跑更大范围时，**应该把 dsh 的工作目录设到项目侧**，否则每轮都要手工搬产物。

---

## 局限

- 只审了 `core/` 5 个文件（2,742 行），占整个插件 57,852 行的 **4.7%**。
- 三条发现都是 MEDIUM，没有 CRITICAL——**这不代表不存在**，可能只是范围没覆盖到。
- F1 的严重性依赖一个前提：Bukkit 的 `MemorySection#set` 是惰性序列化。
  这一点产物自己在 `alternatives` 里列了「需确认」——我认为这个前提成立（`set` 确实只存引用），
  但没有写探针实测。
- **未验证「dsh 的结论是否比 Claude Code 直接审更好」**——没有做对照。
