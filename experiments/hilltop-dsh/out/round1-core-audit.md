# core 模块审计

**F1 · concurrency · MEDIUM —— Bukkit 对象（ItemStack 镜像）的 YAML 序列化被丢到异步线程，与本类自述的主线程不变量相反。**
`PlayerGoodsManager#flushToDisk` 把写盘整体交给异步线程：`Bukkit.getScheduler().runTaskAsynchronously(plugin, () -> writeYaml(yaml, seq));`（PlayerGoodsManager.java:478），而 `writeYaml` 在锁内执行 `payload = yaml.saveToString().getBytes(StandardCharsets.UTF_8);`（PlayerGoodsManager.java:422）——`saveToString()` 才是把此前 `yaml.set(path + "." + i, item);`（PlayerGoodsManager.java:521）放进去的 `ItemStack` 真正转成 Map 的时刻，所以「序列化」实际发生在异步线程。类注释写的是相反口径：「序列化读的是 Bukkit 的 YamlConfiguration，线程安全性没有官方保证，因此留在主线程；只有纯粹的 Files 写入丢到异步线程」（PlayerGoodsManager.java:339-341），而快照里的元素来自 `snapshot.contents = player.getInventory().getContents().clone();`（PlayerGoodsManager.java:147）——只复制数组，元素仍是 CraftItemStack 镜像。于是异步线程在没有 happens-before 的前提下读 `ItemStack`/`ItemMeta`，违反 Bukkit 线程模型；`synchronized (writeLock)` 只与其它 `writeYaml` 调用互斥，主线程改背包时并不持这把锁，:428 的序号复检也只能保证「有更新写请求时不发布」，无法把 dump 期间的跨线程读取变成安全读取。

**F2 · logic · MEDIUM —— `victory-waves` 为 0 或负数时首波直接判胜（数值边界未在消费点兜底）。**
`GameManager` 构造时直接取配置：`this.totalWaves = configManager.getActiveConfig().getVictoryWaves();`（GameManager.java:130，竞技场覆盖走 :293），开波路径 `startNextWave()` 先 `currentWave++;`（GameManager.java:304）再判 `if (currentWave > totalWaves) {`（GameManager.java:305）→ `endGame(true)`，因此 `totalWaves <= 0` 时第一次开波就进胜利结算，玩家进场即通关、零波次。加载侧没有任何下限钳制：`if (settingsYaml.contains("victory-waves")) activeConfig.setVictoryWaves(settingsYaml.getInt("victory-waves"));`（ConfigManager.java:1351），setter 也只是 `public void setVictoryWaves(int v) { this.victoryWaves = v; }`（GameConfig.java:684）；而同一个键经 GUI 修改时却被钳到 ≥1：`v -> cfg.setVictoryWaves(Math.min(100, Math.max(1, v)))`（GameRulesMenu.java:48），两条入口对同一个键给出不同语义。同文件对同类风险键是有约定的——`wave-timeout-seconds` 走 `normalizeWaveTimeout(...)` 归一化（ConfigManager.java:1361），说明「加载时钳制危险数值」是既有做法，victory-waves 属于漏网。0 恰恰是最容易被当成「不限波数 / 关闭」写进 YAML 的值，后果是静默的假胜利并把这一局写进战绩统计。

**F3 · concurrency · MEDIUM —— tmp 文件名的唯一性只靠 `System.nanoTime()`，而它正是「写盘不需要互斥」的唯一依据。**
`writeYaml` 用 `FILE_NAME + "." + System.nanoTime() + ".tmp");`（PlayerGoodsManager.java:409-410）拼临时文件名，Javadoc 把「临时文件互不相干」当作把 `Files.write(tmp.toPath(), payload);`（PlayerGoodsManager.java:424）整段放在锁外的理由：「正因为 tmp 文件互不相干，Files.write 不需要互斥」（PlayerGoodsManager.java:386-387）。但 `System.nanoTime()` 不保证跨线程唯一且粒度很粗：本机 JDK 17 / Windows 10 实测最小非零增量为 100 ns，两线程各取 50 万次时有 12.5 万–44 万次落在对方也取到的同一数值上（探针 `tmp-nanotime/NanoProbe.java`）。当防抖异步写与 `saveNow()`（PlayerGoodsManager.java:502，玩家退出 / 关服现场）真正并发时，两者可能选中同一个 tmp 路径，各自 `Files.write` 同一文件、内容交错，随后 `Files.move` 把这份损坏内容原子发布到 `player-goods.yml`；下次启动 `loadFromDisk()` 解析失败即隔离为 `.corrupt`，全部玩家物品快照丢失。两次调用落在同一个 100 ns 桶内确实是小概率，但该设计把「绝不共用 tmp」当成既定事实，既无进程内计数器也无 UUID 兜底，而失败代价是整份快照不可恢复。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "audit-core-1",
  "role": "audit",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "round1-core-audit.md",
  "payload": {
    "findings": [
      {
        "finding_id": "F1",
        "severity": "MEDIUM",
        "dimension": "concurrency",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/core/PlayerGoodsManager.java",
          "line": 422,
          "quote": "payload = yaml.saveToString().getBytes(StandardCharsets.UTF_8);"
        },
        "inference": {
          "claim": "YamlConfiguration 里存放的 Bukkit ItemStack 镜像的序列化动作发生在异步线程（:478 runTaskAsynchronously → :422 saveToString），与本类 :339-341 声明的「序列化留在主线程、只把 Files 写入丢到异步」相反，构成对 Bukkit 线程模型的违反。",
          "basis": "MemorySection#set 只是把 value 原样存进 map，ConfigurationSerializable 的转换发生在 saveToString()/Yaml dump 阶段，因此 :521 的 yaml.set(path, item) 并不序列化，真正的 ItemStack#serialize/getItemMeta 读取在 :422 执行；而 :478 明确把 writeYaml 调度到异步线程。锁只覆盖其它 writeYaml 调用，主线程改背包时不持 writeLock，:428 的序号复检只决定「是否发布」，不能为 dump 期间的读取建立 happens-before。",
          "alternatives": [
            "若 YamlConfiguration.set 会在设置时就把 ItemStack 深拷贝/预序列化成不可变 Map，则异步侧读到的只是普通 Map，问题不成立——需确认 Bukkit MemorySection 的存储语义（本文按 1.20+ 实现判断其为惰性序列化）",
            "若快照持有的 ItemStack 在写盘期间绝不可能被任何线程触碰（例如 save 后立即被 clearInventory 摘除、restore 又必然先自增 seq 使本次写放弃），则实际数据竞争窗口为零，只剩「违反既定不变量」这一层",
            "若 Paper 的异步线程安全检查会在 saveToString 触碰 ItemStack 时直接抛异常，则表现为写盘失败而非静默脏数据，严重性判定需相应调整"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "F2",
        "severity": "MEDIUM",
        "dimension": "logic",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/core/GameManager.java",
          "line": 305,
          "quote": "if (currentWave > totalWaves) {"
        },
        "inference": {
          "claim": "totalWaves 取自未经下限钳制的配置（:130 / :293），当 victory-waves 为 0 或负数时，startNextWave 的自增后比较立刻成立并调用 endGame(true)，第一波都不开就判胜。",
          "basis": "调用链：startGame → :293 totalWaves=getArenaVictoryWaves() → :294 startNextWave() → :304 currentWave++（=1）→ :305 1 > 0 成立 → :306 endGame(true)。加载侧 ConfigManager:1351 直接 getInt 存储、GameConfig:684 setter 无校验，而 GUI 路径 GameRulesMenu:48 钳到 [1,100]，两条入口语义不一致；同文件对 wave-timeout-seconds 有 normalizeWaveTimeout 归一化，说明归一化是既有约定。",
          "alternatives": [
            "若 ConfigManager 在更早的通用校验环节（如 validate()/saveToFile 前的整体规整）已把 victory-waves 抬到 ≥1，则本条不成立——需通读 ConfigManager 的加载入口确认没有别处兜底",
            "若产品语义上 victory-waves=0 被官方定义为「立即通关/空局」，则这是特性而非缺陷；但代码与文档均未声明该语义，且 GUI 明确禁止 0"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "F3",
        "severity": "MEDIUM",
        "dimension": "concurrency",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/core/PlayerGoodsManager.java",
          "line": 410,
          "quote": "FILE_NAME + \".\" + System.nanoTime() + \".tmp\");"
        },
        "inference": {
          "claim": "临时文件名的唯一性（以及由此推出的「Files.write 无需互斥」）只依赖 System.nanoTime()，跨线程并不保证唯一；两个并发写若落到同一 100 ns 桶会写同一个 tmp 文件，交错内容再被 Files.move 发布成 player-goods.yml。",
          "basis": "Javadoc :386-387 把「tmp 文件互不相干」作为把 :424 Files.write 移出 writeLock 的唯一理由；而 :409-410 的后缀就是裸 nanoTime。本机实测（JDK 17.0.20.1 / Windows 10，NanoProbe）最小非零增量 100 ns，两线程各 50 万次采样中 125101–439838 次命中对方也取到的同一数值，说明同桶取值在并发下很常见；一旦同名，两个线程各自 open+truncate 同一路径，写入位置互不知情。",
          "alternatives": [
            "若两次 writeYaml 在时间上永不可能重叠（例如 saveNow 总是先等待在途异步写结束），则同名窗口不存在——但 :498-503 的 saveNow 只 cancel 防抖任务，并不等待已在异步线程执行的 writeYaml",
            "若 Files.write 对同一路径的并发调用在 Windows 上必然抛 IOException（共享冲突）而非交错写入，则后果退化为「写失败 + 旧文件保留」，不会产生损坏文件——需在目标平台实测同路径并发写",
            "若 nanoTime 在该 JVM 上实际来自更高分辨率时钟（不同 JDK/OS 可能不同），碰撞概率会显著下降，但「不保证唯一」这一前提仍成立"
          ]
        },
        "status": "CONFIRMED"
      }
    ],
    "searched_scope": {
      "files_read": [
        "src/main/java/com/hilltopvillage/core/GameManager.java",
        "src/main/java/com/hilltopvillage/core/WaveManager.java",
        "src/main/java/com/hilltopvillage/core/PlayerGoodsManager.java",
        "src/main/java/com/hilltopvillage/core/PlayerData.java",
        "src/main/java/com/hilltopvillage/core/GameState.java",
        "src/main/java/com/hilltopvillage/config/GameConfig.java",
        "src/main/java/com/hilltopvillage/config/ConfigManager.java",
        "src/main/java/com/hilltopvillage/config/menu/GameRulesMenu.java"
      ],
      "dimension_checklist": [
        "concurrency: 异步写盘路径（writeYaml / flushToDisk / saveNow）、共享集合（activeMobs/airdropTasks/players/goods）、AtomicLong 序号与 writeLock 的覆盖范围、Bukkit 对象的跨线程访问",
        "logic（数值边界）: 刷怪三层 Math.min 裁剪、trimProportionally 最大余数法、nextInt 取整区间与 1~64 钳制、nanoTime 命名、victory-waves / global-mob-cap / mob-cap-per-player 的加载侧钳制、波次计数比较"
      ]
    },
    "self_checks": {
      "identifier_reconcile": {
        "status": "DONE",
        "note": "逐条回查了引用到的标识符定义位置：writeYaml(PlayerGoodsManager:405)、buildYaml(:343)、saveNow(:498)、flushToDisk(:468)、writeLock(:88)、writeSeq(:98)、getVictoryWaves(GameConfig:683)、getWaveConfig(GameConfig:826)、totalWaves 赋值(GameManager:130/:293)、startNextWave(GameManager:297)，均存在且签名与引用一致；未发现悬空引用。"
      },
      "self_check_audit": {
        "status": "DONE",
        "note": "对三条发现做了反向核对：F1 确认 :422 确实位于 :478 的异步任务体内（而非主线程 flushToDisk 内），并核对了 :339-341 的原文口径；F2 确认 :305 的比较用的是自增后的 currentWave 且 endGame(true) 在 :306，同时确认 ConfigManager:1351 无钳制、GameRulesMenu:48 有钳制；F3 确认 :386-387 的论证确实以 tmp 唯一性为前提，并用独立探针复测了 nanoTime 粒度。三条均已按「仅有定义位置+推断」的上限压到 MEDIUM，未标 CRITICAL。"
      },
      "runtime_validation": {
        "status": "DONE",
        "note": "对 F3 的前提做了真机实测：JDK 17.0.20.1 / Windows 10 上 System.nanoTime() 最小非零增量 = 100 ns，两线程各 50 万次并发采样有 12.5 万–44 万次取到相同数值（探针源码 tmp-nanotime/NanoProbe.java，已编译运行）。F1/F2 未做运行时验证：本机没有 1.20+ Paper/Spigot 服务端（仅有 spigot 1.8.8），无法实跑插件，二者的结论只来自静态阅读与 ConfigManager 加载路径核对。"
      }
    }
  },
  "error": null
}
```
