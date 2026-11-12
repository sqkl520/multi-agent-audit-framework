# 机械校验器：把能算的东西算出来（2026-11-03）

> **一句话**：`tools/verify-artifacts.mjs`，零依赖、只读、22 个自测用例，负责框架里**本来就能机械验证**的那部分。它不判断 bug 重不重要——那仍然归 LLM。

---

## 为什么做这个

框架里有一批规则，长期以来**完全靠提示词约束**：

> 「引用必须来自本回合的文件读取，不得来自会话早期的记忆、训练数据或『根据架构推测』。」
> —— `evidence-policy.md` §1，门 0

这句话是对的，但**验证它需要的不是更强的提示词，是打开文件比对字符串**。

同类还有一批：

| 规则 | 此前怎么保证 | 实际需要什么 |
|---|---|---|
| `quote` 是源文件原文 | 靠 Agent 自觉 + 另一个 LLM 抽查 | 打开 `file:line` 比对 |
| `artifact_path` 的文件存在 | **完全没有检查** | `existsSync` |
| `lead_count == len(leads)` | 契约里写了，没人算 | 数数组长度 |
| `files_read` 里的文件存在 | 门控判「A 列表是否含 B」，两者都由被审者提供 | `existsSync` |
| `discipline_log` 与派发记录对得上 | 靠 Skeptic 逐条人工比对 | 两边都是 JSON，比就行 |

**这些没有一项需要智能判断。** 而框架为此写了大量规则，再由 LLM 互相检查——这正是 13 份锐评收敛出的那句「机械归代码、判断归提示词」的具体落点。

---

## 它检查什么

```
node tools/verify-artifacts.mjs --repo <被审仓库> --artifacts <产物目录>
```

| 检查 | 内容 | 判据 |
|---|---|---|
| **G0** | 门 0 回显真实性 | `evidence.quote` 是否真的出现在 `evidence.file:line` |
| **G1** | 文件存在性 | `files_read` / `evidence.file` 路径是否真实存在 |
| **G2** | 产物真实性 | `SUCCESS` 的 `artifact_path` 文件是否存在**且非空** |
| **G3** | 覆盖完整性 | `files_read` 是否覆盖切片声明的 `files[]` |
| **G4** | 账本对账 | `discipline_log` vs `wave2_completed`；`mechanical_check` 是否为空；失败率阈值 |
| **G5** | 自述数字自洽 | `lead_count` / `slice_count` / `dimension_histogram` 之和是否与实际数组长度一致 |
| **G6** | 产物 JSON | 产物里的 JSON 块是否语法合法 |

**退出码**：`0` 全通过 / `1` 有 FAIL / `2` 用法错误 / `3`（`--strict`）有 WARN。

### 它**不**检查什么

证据是否支持主张、推断是否成立、严重性是否合理、可达性判断对不对、缺陷重不重要。

**这些是 LLM 的判断，脚本一行都不碰。** 脚本把可计算的部分拿走，留下的恰好是框架真正该做的那部分——语义入口判断、注释考古、承诺 vs 实现、减法归并。

---

## G0 的三级匹配

`quote` 和源文件的比对不能只有「相等/不等」两档，否则会大量假阳性：

| 级别 | 判据 | 结果 |
|---|---|---|
| `exact` | 去首尾空白后逐字包含 | `PASS` |
| `loose` | 压平连续空白后包含（应对缩进/换行差异） | `WARN` |
| `fuzzy` | 逐 token 顺序匹配（应对行内空白被改写） | `WARN` |
| 都不匹配 | — | `FAIL` |

**支持跨多行 quote**：从 `evidence.line` 开始向下最多扫 15 行，取最佳匹配。整段再兜底一次。

> **为什么需要 `loose`/`fuzzy`**：LLM 引用代码时经常把缩进压平、把换行合并。若一律判 FAIL，校验器会淹没在假阳性里，最后没人看。**分级的目的不是放宽标准，是让「真编造」和「格式差异」能分开。**

---

## 自测：22 个用例，一正一反

`tools/verify-artifacts.test.mjs` 用构造样本验证校验器**真的能抓到问题**：

| 用例 | 期望 |
|---|---|
| 1 | 门 0 回显正确 → PASS |
| 2 | **quote 是编的 → FAIL** |
| 3 | **evidence.file 不存在 → FAIL** |
| 4 | **行号越界 → FAIL**（并报出实际行数） |
| 5 | **artifact_path 文件不存在 → FAIL** |
| 6 | **artifact_path 为 null → FAIL** |
| 7 | **artifact 是空文件 → FAIL** |
| 8 | **lead_count 与实际不符 → FAIL** |
| 9 | **audit 的 findings 是空数组 → FAIL** |
| 10 | **裁量指派维度但无日志 → FAIL** |
| 11 | **mechanical_check 为空 → FAIL** |
| 12 | 只有空白差异 → WARN（不算 FAIL） |
| 13 | 跨多行 quote → 通过 |
| 14 | 产物 JSON 语法错误 → FAIL |
| 15 | 无 state.json → SKIP（不是 FAIL） |
| 16 | `/d/...` Git Bash 路径 → 正确归一化，不误报 |

**16 个用例、22 个断言，全通过。**

> 写这套测试的过程本身抓出两个 bug：`artifact_path: null` 因为 `??` 被回填成默认值（测试写法错）、`/d/` 风格路径在 Windows 上被判定不存在（校验器真 bug）。**如果没写测试，第二个会一直潜伏到真实使用。**

---

## 端到端：拿真实历史发现验证

用 `D:\Web\style` 上 round1/round2 已确认的三条真实缺陷源行，加上两条故意编造的：

```
REAL-1  prototypes/S04-mango-collage-wall/style.css:84   transform:rotate(var(--rot));
REAL-2  templates/M02-warm-local/style.css:257           PLACEHOLDER
REAL-3  prototypes/_build/check-stale.mjs:122            } catch { continue; }
FAKE-1  同 S04:84，但 quote 改成 transform: rotate(var(--r));    ← 编造
FAKE-2  同 S04:84, 但 line 写成 9999                              ← 越界
```

**实际输出**：

```
✗ FAIL  [G0] quote 未出现在 prototypes/S04-mango-collage-wall/style.css:84 附近
         quote: transform: rotate(var(--r));
         actual:   transform:rotate(var(--rot));
✗ FAIL  [G0] evidence.line=9999 超出文件行数 291: prototypes/S04-mango-collage-wall/style.css
✗ FAIL  [G0] 门 0 回显: 3/5 通过（2 条 quote 与源文件不符，0 条缺 line，0 条文件不可读）
✓ PASS  [G2] artifact_path: 1 个 SUCCESS 信封，0 个缺路径或文件不存在，0 个空文件
```

**3 条真发现全部通过，2 条编造全部被抓，且报出了精确差异。**

注意 G0 那条消息里 `--r` vs `--rot` 的对比——**这正是 round2 里靠人眼复核才发现的差异**（HTML 定义 `--r`，CSS 引用 `--rot`，7 处引用全失效）。现在它是机器报出来的。

---

## 怎么接进流程

`protocol.md` §1.6 规定**两个强制调用点**：

| 时机 | 失败处理 |
|---|---|
| **每次收到子 Agent 返回后**（单条验收） | 有 FAIL → 判 `CONTRACT_VIOLATION`，按 §4.1 计数重派 |
| **生成最终报告前**（全轮体检） | 有 FAIL → 报告顶部必须声明「本轮存在 N 条机械校验失败」并逐条列出，**不得静默通过** |

并加进主 Agent 的受限 `Bash` 白名单（`protocol.md` §1.5）：它只输出校验结论与路径，不读源码正文。

---

## 一个必须承认的限制

**校验器只能验证「声称的证据是否真实存在」，不能验证「真实存在的证据是否支持结论」。**

一条 agent 完全可以从源文件里抄一行真实代码，然后得出一个错误结论。G0 会通过。

这**不是**校验器的缺陷——这恰好划清了机械与判断的边界：

| 能机械验证 | 必须 LLM 判断 |
|---|---|
| 这行代码存在吗 | 这行代码是不是 bug |
| 文件真的读了吗 | 读得够不够 |
| 数字对得上吗 | 数字代表的覆盖率可信吗 |
| 产物落盘了吗 | 产物里的发现重不重要 |

**框架的价值应该集中在右列。左列交给脚本。**

---

## 复核方式

```bash
# 自测
node tools/verify-artifacts.test.mjs

# 对一个真实产物目录体检
node tools/verify-artifacts.mjs --repo "D:/path/to/repo" --artifacts "D:/path/to/OUTDIR/round31"

# 机器可读
node tools/verify-artifacts.mjs --repo ... --artifacts ... --json
```

零依赖（只用 Node 内置 `fs`/`path`），只读，不改任何文件。
