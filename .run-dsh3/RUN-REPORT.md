# dsh 原生运行记录（2026-11-20）

**方式**：`dsh 0.2.1-rc.2` 原生跑，主线程只发起调用与读结果。
**目标**：Hilltop Village（Paper 1.21.4，75 个 Java 主源文件 / 34,954 行）

---

## 一、三段式：人工 → 守卫 → 驱动

| 阶段 | 手段 | 结果 |
|---|---|---|
| 第 1 次 | `task.md` | 侦察 + 26 份宽扫完成，**父进程在深挖中退出**，4 份产物全丢 |
| 第 2 次 | `task-resume.md`（人工写续跑书） | 4 份深挖 + 1 份报告，**锐评波完全没跑**，报告多处占位符 |
| 第 3 次 | `dsh-driver.mjs`（自动驱动，上限 3 轮） | **一轮跑到位**：phase 从 `wave2b/RUNNING` → `closed/PARTIALLY_CLOSED` |

第 3 次是这次的重点：前两次都是人写续跑书、人判断该不该停；
第 3 次是脚本自己读 `state.json` 判断相位没闭合，自己生成「还差什么」再跑。

---

## 二、最终结果

```
26/26 切片全部宽扫 · 75/75 文件被读 · 14 片进入深挖
机械复核 0 FAIL / 门 0 回显 185/185 通过
23 条发现进入锐评 → 22 条裁决 + 1 条 EVIDENCE_GAP
终裁：17 UPHELD / 5 DOWNGRADED / 0 REVOKED，其中 3 条 HIGH 维持
```

### 框架校验器的判定

```
$ node tools/verify-artifacts.mjs --repo <HV> --artifacts .run-dsh3/artifacts
扫描产物: 50 个文件，解析出 48 个信封
✓ PASS [G0] 门 0 回显: 185/185 通过（0 条 quote 与源文件不符）
✓ PASS [G4] 账本对账: 47 条派发记录、4 条裁量记录，0 处不一致
合计: 0 FAIL / 9 WARN / 5 PASS / 0 SKIP

$ node tools/check-deliverables.mjs --round-dir .run-dsh3/artifacts
✓ [D2]  覆盖率有明确数值且自洽: 14/156 = 9.0%
✓ [D2b] 证据覆盖率 100%
✓ [D3]  账本四节必备齐全
合计: 0 FAIL / 0 WARN / 8 PASS
```

对比三段进展：

| 指标 | 第 1 次 | 第 2 次 | 第 3 次（驱动） |
|---|---|---|---|
| 门 0 通过 quote | — | 135/135 | **185/185** |
| 深挖产物 | 0（全丢） | 4 | **14** |
| 锐评产物 | 0 | 0 | **6**（含 Arbiter） |
| 裁决数 | 0 | 0 | **22** |
| 报告占位符 | — | 多处 | **0** |
| 交付物检查 | — | 2 FAIL | **0 FAIL** |

---

## 三、锐评波做了什么（这是第 2 次完全缺失的）

22 条终裁，其中 5 条被 DOWNGRADED。抽样：

```
F-slice-20-concurrency-01  DOWNGRADED
  Skeptic 判 untested：守卫缺失是可核事实，但「禁用窗口内 show() 仍可达」
  缺调用链与运行时证据，按判定树 untested 不得 UPHELD。
  升级所需证据：禁用期内调用 show() 的具体入口

F-slice-21-concurrency-01  DOWNGRADED
  Skeptic 判 holds 但已把「永久残留」收窄为「本次会话内残留」，
  且禁用路径存在兜底清理。后果从跨重启持久污染降为会话内短暂残留，
  影响面明显变窄，MEDIUM 过高，降为 LOW。
```

**这是框架第三波设计意图的实证**：DOWNGRADED 不是「判错了」，
是「原来的措辞承诺了比证据更多的东西」。降级理由必须写清依据。

---

## 四、发现质量（我逐条核对了源文件）

那条维持 HIGH 的：

```
F-slice-15-concurrency-01
file:line  core/PlayerGoodsManager.java:478
quote      Bukkit.getScheduler().runTaskAsynchronously(plugin, () -> writeYaml(yaml, seq));
```

源文件核对（478 行逐字一致），且 claim 提到的 422 行 `yaml.saveToString()` 确实存在：

```
$ sed -n '476,480p' .../PlayerGoodsManager.java
        final YamlConfiguration yaml = buildYaml();
        final long seq = nextWriteSeq();
        Bukkit.getScheduler().runTaskAsynchronously(plugin, () -> writeYaml(yaml, seq));

$ sed -n '420,424p' .../PlayerGoodsManager.java
                if (seq != writeSeq.get()) return;
                payload = yaml.saveToString().getBytes(StandardCharsets.UTF_8);
            }
            Files.write(tmp.toPath(), payload);
```

缺陷成立：含 `ItemStack` 的 Bukkit 配置对象在异步线程被序列化，
违反本类 336–341 行自己声明的「序列化留在主线程」。

---

## 五、根因：dsh 没有 Stop hook

第 1 次为什么丢产物：

```
主 Agent: 派 4 个深挖 Agent
主 Agent: 「Let me wait for audits. End turn.」
→ 父进程退出
→ 子 Agent 21:25–21:29 还在写，21:30 父进程已死
```

根因写在 `stop-hook.mjs` 文件头，框架自己早就知道：

> Agent 循环的退出条件是「本轮回复里没有 tool call」。
> 「我已完成 X，接下来做 Y」这段话天然没有 tool call，所以写出来就交差了。

Claude Code 有 Stop hook 能拦住这一刻。**dsh 没有**——
`--dump-config` 里没有 hook 类插件，schema 里也没有。

`dsh-session-audit.mjs` 事后抓到了（`parent_missed_child` × 19），
但那是事后审计，不是事前阻止。

### 两个补丁，一后一反

| 工具 | 时机 | 做什么 |
|---|---|---|
| `dsh-run-guard.mjs` | **事后** | R1 派发数对落盘数 / R2 骨架残留 / R3 必需相位缺失 / R4 会话层漏收 |
| `dsh-driver.mjs` | **事前** | 跑一轮 → 读 state.json 看相位闭合没有 → 没闭合带着「还差什么」再跑 |

驱动的判据用**双信号**：`phase`/`status` + 产物文件数。
只看 status 会被「说 RUNNING 但什么都不做」骗过去；只看产物会被「加了个空文件」骗过去。
连续两轮两者都不变 → 判 `STALLED` 停，不硬跑到上限。

---

## 六、它自己申报的一条 L0 违规

报告 §4 如实写了：

> **并发上限突破** `L0_VIOLATION`：峰值 **6** 个并发（上限 4）：
> 主 Agent 用「产物已落盘」当作「agent 已终态」补位

框架写了并发上限（`scale-mapping.md`），但**没有任何校验器读它**。
这条违规是被「自觉」抓住的，不是被机器抓住的。

---

## 七、仍未闭合

| 项 | 状态 |
|---|---|
| 维度覆盖率 14/156 = 9.0% | 26 片里只有 14 片做了单维度深挖，`logic` 维到后期才补 |
| 会话层 `parent_missed_child` × 19 | dsh 的固有问题，驱动只能补跑，不能消除 |
| `check-fix-instances` | 需报告含裁决索引表——现在有了，但还没跑这一项验证 |
| 修复相位 | 按设计不在默认路径，需用户授权 |

---

## 附：复现

```bash
# 上游地址运行期注入（仓库里只有 <your-upstream> 占位符）
DSH_UPSTREAM_BASEURL=http://<你的端点>:33000 \
AUDIT_API_KEY=<你的key> \
node tools/dsh-driver.mjs \
  --patch .run-dsh3/patch.yml \
  --task .run-dsh3/task.md \
  --artifacts .run-dsh3/artifacts \
  --max-iterations 3

# 跑完看丢了什么
node tools/dsh-run-guard.mjs --artifacts .run-dsh3/artifacts \
  --sessions ~/.dsh/sessions --project "<项目目录名>"
```
