# dsh 原生运行记录（2026-11-20）

**运行方式**：`dsh --profile headless --patch .run-dsh3/patch.yml "$(cat task.md)"`
**上游**：`http://<your-upstream>:33000`，模型 `virtual/opus`，`anthropic-messages` API
**dsh 版本**：0.2.1-rc.2（`~/.dsh-win/versions/0.2.1-rc.2`）
**目标**：Hilltop Village（Paper 1.21.4，75 个 Java 主源文件）
**说明**：主线程只发起调用与读结果，**全部实际工作由 dsh 派子 Agent 完成**。

---

## 一、跑了什么

| 轮次 | 命令 | 结果 |
|---|---|---|
| 第 1 次 | `task.md`（完整审计任务） | 侦察 + 26 份宽扫完成，**父进程在深挖进行中退出**（21:30），4 个深挖产物全部丢失 |
| 第 2 次 | `task-resume.md`（续跑） | 4 份深挖 + 1 份最终报告落盘，**未执行锐评** |

### 第 1 次为什么中断

dsh 主 Agent 在派了 4 个深挖 Agent 之后输出「End turn」结束回合，
**父进程随即退出**。4 个深挖子 Agent 在 21:25–21:29 还在写入，21:30 父进程已终止。

框架自己的会话审计工具在事后确认了这个形态：

```
$ node tools/dsh-session-audit.mjs --sessions ~/.dsh/sessions --project "<本项目>" | tail
结论：发现 10 个问题
  [parent_missed_child] 子 agent 有产出，但父 session 里没有对应的 subagent-settled 注入
  ...（共 9 次）
  [turn_without_output] 开了 1 个 turn，但 0 条 assistant 消息
```

**子 Agent 有产出，但父 session 没收到通知。** 这正是框架里
`dsh-session-audit.mjs` 存在的原因，此前只在合成 fixture 上验证过，这是第一次在真实运行中抓到。

---

## 二、产出清单

```
.run-dsh3/artifacts/
  round1-01-recon-slices.md        33 KB   侦察，26 个切片，75/75 文件全覆盖
  round1-02-sweep-slice-*.md       26 份   宽扫（22 片完成，4 片预算截断）
  round1-02-audit-slice-15/20/21/24  4 份 深挖
  round1-final-report.md            5 KB   最终报告（含占位符）
  state.json                              账本
```

---

## 三、框架校验器的判定（真实产物，第一次）

### `verify-artifacts.mjs`：机械校验全部通过

```
扫描产物: 28 个文件，解析出 27 个信封
! WARN [G0] 有 1 个非 .md 文件未被检查（state.json）
✓ PASS [G0] 门 0 回显: 135/135 通过（0 条 quote 与源文件不符，0 条缺 line，0 条文件不可读）
✓ PASS [G1] files_read: 103 条路径，0 条不存在；切片覆盖缺 0 条
✓ PASS [G2] artifact_path: 27 个 SUCCESS 信封，0 个缺路径/不存在/空文件/复用
✓ PASS [G5] 自述数字自洽: 45 项检查，0 项不一致
✓ PASS [G7] 声明范围与证据范围一致（4 份产物）
✓ PASS [G8] line_count: 26 个切片，0 个与实测不符
合计: 0 FAIL / 1 WARN / 7 PASS / 0 SKIP
```

**门 0 135/135 逐字通过。** 这是对比 `.run-hv`（上一轮真实审计，45 条里 32 条通过）
的显著改善——那次是 `.json` 产物、10/10 报 `no_json_envelope`。

> 注意：那条 WARN 正是上一轮修的那个缺陷——`state.json` 被跳过时现在**会报出来**，
> 而不是从统计里消失。

### `check-deliverables.mjs`：2 项 FAIL

```
✗ [D1] 必交付文件缺失: round1-ledger.md
✗ [D2b] 最终报告缺「证据覆盖率」——唯一能暴露「派了但没查」的指标
! [D2] 覆盖说明里没找到「N/N = xx%」形式的覆盖率
✓ [D1] round1-final-report.md 存在
✓ [D2] 最终报告七节齐全（10 个二级标题）
✓ [D4] 目录内所有文件都有规范归属
合计: 2 FAIL / 1 WARN / 4 PASS
```

### `check-payload.mjs`：深挖产物合规，报告不合规

- `round1-02-audit-slice-15-concurrency.md --role audit` → **✅ 契约合规**
- `round1-final-report.md` → `[no_json_envelope]`

---

## 四、发现质量抽查（我逐条核对了源文件）

12 条 finding（HIGH 1 / MEDIUM 4 / LOW 4 / null 3）。

### 那条 HIGH 是真的

```
finding_id  F-slice-15-concurrency-01
file:line   src/main/java/com/hilltopvillage/core/PlayerGoodsManager.java:478
quote       Bukkit.getScheduler().runTaskAsynchronously(plugin, () -> writeYaml(yaml, seq));
```

我打开源文件核对：

```
$ sed -n '476,480p' .../PlayerGoodsManager.java
        final YamlConfiguration yaml = buildYaml();
        final long seq = nextWriteSeq();
        Bukkit.getScheduler().runTaskAsynchronously(plugin, () -> writeYaml(yaml, seq));
```

**478 行逐字一致。** 而 claim 里提到的 422 行 `yaml.saveToString()` 也确实存在：

```
$ sed -n '420,424p' .../PlayerGoodsManager.java
                if (seq != writeSeq.get()) return;
                payload = yaml.saveToString().getBytes(StandardCharsets.UTF_8);
            }
            Files.write(tmp.toPath(), payload);
```

缺陷成立：`flushToDisk()` 把整个 `writeYaml` 丢到异步线程，而 `writeYaml` 内部在 422 行
执行 `yaml.saveToString()`——含 `ItemStack` 的 Bukkit 配置对象在异步线程被序列化，
违反本类 336–341 行自己声明的「序列化留在主线程」。

另两条（`saveNow()` 同步取锁被异步写阻塞、`System.currentTimeMillis()` 非单调做超时）
推理同样扎实，门 0 引用也能对上。

---

## 五、这轮没做到的

| 项 | 状态 | 原因 |
|---|---|---|
| 锐评波（skeptic / devils_advocate / arbiter） | **完全没跑** | 第 2 次运行在 4 份深挖后直接写了报告 |
| 最终报告完成度 | 多处占位符 | `§2.2 证据覆盖率`、`§3 发现汇总`、`§5 零写入自证`、`§D 未深挖线索` 全是「（收尾填）」 |
| `round1-ledger.md` | 缺失 | — |
| 4 个切片宽扫 | DEFERRED | 预算截断（slice-17/18/19/23） |
| 19 个切片深挖 | 未做 | 只挑了 7 片 |

### 它自己申报的一条 L0 违规

报告 §4 里如实写了：

> **并发上限突破** `L0_VIOLATION`：峰值 **6** 个并发（上限 4）：
> 主 Agent 用「产物已落盘」当作「agent 已终态」补位

**这是它在没有任何工具拦它的情况下自己发现并记录的。**
框架的 `scale-mapping.md` 写了并发上限，但没有任何校验器读它——
这条违规是被"自觉"抓住的，不是被机器抓住的。

---

## 六、结论

**dsh 能跑这套框架，而且跑出了真实发现。**

三条真缺陷（异步序列化 Bukkit 对象、锁竞争抵消异步收益、非单调时钟做超时）
门 0 引用逐字可核，不是编造。

**但它跑不完。** 两个卡点，都不是框架规则的问题，是 harness 的问题：

1. **父进程在子 Agent 未落盘时退出**。第 1 次运行因此丢了 4 份深挖产物。
   框架的 `dsh-session-audit.mjs` 抓到了（`parent_missed_child` × 9），
   但那是**事后审计**，不是事前阻止。
2. **没有「回合未闭合就拒绝结束」的机制**。`stop-hook.mjs` 写了相位守卫，
   但没有接到 dsh 上。主 Agent 说「End turn」，进程就走了。

换句话说：**这套框架对"Agent 做错事"有 37 道检查，对"harness 提前结束"一道也没有。**

---

## 附：复现命令

```bash
DSH=~/.dsh-win/versions/0.2.1-rc.2/node_modules/@deepseek-ai/dsh/lib/bin.js
AUDIT_API_KEY='<key>' node "$DSH" --profile headless \
  --patch .run-dsh3/patch.yml "$(cat .run-dsh3/task.md)"
```

续跑用 `task-resume.md`（它会先读 state.json 与已有产物，不从头重跑）。
