# 引用核实结果与处置（2026-11-01）

> 对 `framework/` 全部外部引用逐条核实。**结论与我最初的怀疑不同，必须纠正。**

## 一句话结论

**不是编造，是用错地方。** 25 个外部 URL **无一 404**，全部真实存在。承重论断 5 条中 **3 条成立、1 条缺引用、1 条严重语境误用**。

我最初的两个怀疑，一个被推翻、一个被纠正：

| 我最初的判断 | 核实结果 | 结论 |
|---|---|---|
| `neurips.cc/.../loc/atlanta/171452` 是"会议地点页而非论文页" | **错。** 它是 Atlanta 分会场命名空间下的 **poster 详情页**，规范地址 `/virtual/2026/poster/171452`，两者均返回 200。且内容**逐字支持**框架论断 | **我错了，已纠正并改用规范 URL** |
| `protocol.md` 5 个脚注指向同一 Oracle 博客锚点 = 编造 | **半对。** URL 真实但返回 **403 无法访问**，精确标题检索无命中。问题不是编造，是**用一个不可核实的来源支撑 5 个不同论断** | 已全部降级 |

---

## 一、真正的问题：三类误用

### 1. 把「API 掉线率」当成「审计失败率」（最严重）

`scale-mapping.md` 原文：「HiveMind 实测：无协调并行 Agent 在高争用下失败率 72–100%，引入准入控制和背压后降至 0–18%」——用它论证「并发窗口 = 8」。

核实（HiveMind, arXiv 2604.17111, Agemang 等, 2026-04, cs.DC）：
- 数字**确实存在**（10+ agent 直连 100%、replay-11 为 73%；HiveMind 10%/18%）。
- **但**：实验是 **mock API server** + 「重复顺序 API 调用」的模拟 agent，**不是代码审计**；「失败」定义为**首个不可恢复的 HTTP 502 / 连接重置**。
- **论文从未建议并发窗口 = 8**（测试档位是 5/10/11/20/50）。
- **最要命**：论文消融明确写「**transparent retry 是影响最大的单一原语**」，且**仅加准入控制仍有 81.8% 失败率**。所以「准入+背压即降到 0–18%」是**反向误读**。

**处置**：已改写。窗口 8 降级为「设计假设」，并补上正确推论——**背压必须与重试配对**，这反而更强地支持 `RETRYABLE_FAILURE` 原样重派。

### 2. 引用了一个全文不含该内容的 PDF

`wave1-recon.md`：「LobeHub 的并行审计实践也使用 typically 5–10 files per chunk」→ 挂 `zenodo.org/records/19520243/.../orthogonal-63.pdf`。

核实：该 PDF 实际是《Orthogonal Probing and the Geometry of LLM Entropy》，全文 grep `LobeHub` **0 次**、`per chunk` **0 次**，与切片粒度毫无关系。

**处置**：已移除该引用并留注说明。`dev.to` 那篇的「5–8 files」是**逐字可查的**（原文第 781 行），保留。

### 3. 最硬的一条证据被浪费

NeurIPS 那条是全框架**证据链最硬的一环**，但只用它支撑「不能自验收」，浪费了它真正的价值。原文摘要：

> Prompting GPT-5 to write and run a failing test **moves neither resolve nor regression rate**, equivalent to baseline at a 10 pp margin.

配套对照数字：

| 验证方式 | silent regression 率 |
|---|---|
| FAIL TO PASS **外部**测试（瞄准故障） | **4.8%** |
| 让修复 Agent 自己随机写测试 | 10.0% |
| 不验证 / 自证 | 18.8% |

**处置**：已在 `wave4-fix.md` 补全整张表与三个推论，并把 `wave5-verify.md` 的变异检验从**可选**升级为**强制**（详见改动清单）。

---

## 二、承重论断核实表

| # | 论断 | 出处 | 存在？ | 支持？ | 处置 |
|---|---|---|---|---|---|
| 1 | 并行失败率 72–100% → 0–18% | HiveMind arXiv 2604.17111 | 是 | **数字对，语境错**（HTTP 502，非审计） | 已改写 + 降级 |
| 2 | 朴素多 agent 暴露 false-consensus | **零脚注** | 论断真实 | **缺出处** | 已补引 arXiv 2608.18167 / 2603.26130 |
| 3 | 修复 Agent 自写测试无增益 | NeurIPS 2026 poster 171452 | 是 | **逐字支持** | 保留 + 换规范 URL + 补全数据 |
| 4 | Skeptic 五步验证协议 | `adversarial-review-gate@3.0.2` | 是 | **引文准确**（逐字存在） | 保留，但降权为「借鉴角色设计」 |
| 5 | 主 Agent 不亲自执行 | Oracle 博客 | **403 无法访问** | **无法核实** | 5 处全部降级为 D 级 |

---

## 三、批量核实结果

**真实且相关内容**（可直接引用）：`pedrohcgs/.../orchestration-schemas.md`、`magnus919/.../delivery-packet.md`、`event4u-app/.../active-remediation-mechanics.md`、`pkg.go.dev/dimetron/pi-go@v0.1.4`（`SpawnWithRetry` 确实存在，默认重试 3 次）、`agent2agent.info/docs/topics/life-of-a-task/`、`learn.agentpatterns.ai/.../handoffs-and-contracts/`、`dev.to/lachiejames/fan-out-auditing...`（5–8 files 逐字可查）、`callsphere.ai/.../risk-management...`（"Blast radius is set by what you grant...not by the agent's intentions" 是原文）、`skills.sh/smallnest/goal-workflow/graph`、以及 PyPI/npm 上的 `saalis`/`sendra-ai`/`statebus`/`sdd-parallel`/`cih-agent`/`aqm`/`phionyx-pipeline-mcp`/`agent-contracts@0.12.2`。

**真实但被误引**：
- `zenodo/19520243` → 见上文，**已移除**。
- `zenodo/21842518` → 记录标题与 PDF 内标题**不一致**（PDF 实为《Telemetry Blindness at the Agent-Business Boundary》），自述"从仓库 commit 提取的草稿"、单作者、非同行评议。**证据等级极低**。
- `socket.dev` 两页被 Cloudflare 403 拦截，**未能访问**（底层包真实存在）。

**无效或疑似编造**：**无**。25 条无一 404。

**一个关键发现**：所有文件 frontmatter 的 `source:` 都指向 `chat.deepseek.com/share/...`，该链接返回 **429 限流**，无法访问。**这意味着多数论断的真实上游是一段 LLM 对话记录，而非论文。** 框架的自我定位应当据此调整——它是**一套设计约定的集合**，不是**实证研究的汇总**。

---

## 四、已执行的改动

| 文件 | 改动 |
|---|---|
| `orchestrator/scale-mapping.md` | 重写并发窗口论证；窗口 8 降级为设计假设；补 HiveMind 三个限定 + 反向误读纠正；脚注备注 |
| `templates/wave1-recon.md` | 删除错误的 LobeHub/Zenodo 引用，留注说明；`[^ref7]` 标为「已移除」 |
| `templates/wave3-critique.md` | 补 `[^refA]`–`[^refD]` 四个真实出处；加「证据强度声明（勿夸大）」；加三级证据分级表；`adversarial-review-gate` 降权声明 |
| `templates/wave4-fix.md` | NeurIPS 链接改规范地址 ×4；补全 18.8%/10.0%/4.8% 对照表与三个推论 |
| `templates/wave5-verify.md` | 变异检验 **可选 → 强制**；只允许两种 `skipped` 理由；新增调用点变异最低要求（两次变异表） |
| `components/output-contract.md` | 新增 `mutation_scope` 字段及必填规则 |
| `templates/wave2-audit.md` | `severity: "NONE"` → `null`，附契约警告（含 round31 的 5 个实例证据） |
| `orchestrator/protocol.md` | 5 个不可核实脚注全部降级；新增引用分级说明表 |

---

## 五、给框架立一条新规矩（建议纳入 evidence-policy）

**引用必须可核验，且必须分级。** 本轮核实暴露的模式是：链接都真，但**用一个「某包存在」撑起一个「某结论已被证明」**。建议在 `evidence-policy.md` 增一节：

```
引用分级（强制）
A · 研究证据：有 arXiv/DOI/会议页，且你读过摘要确认它支持该论断
B · 工程文档：可核查的仓库/博客做法，措辞须为「某项目的做法」
C · 包注册页/第三方 prompt：只能证明「该物存在」，不得承担举证责任
D · 无法核实：URL 打不开或无命中 —— 必须改写为「设计约定」，不得假装有出处

三条硬规则：
1. 引用 A 级时，必须写出该来源的**具体限定条件**（样本量、场景、"失败"的定义），
   不得只摘数字。HiveMind 那条就是反面教材。
2. 一个脚注只能支撑一个论断。5 个论断共用一个锚点 = 5 条都不可信。
3. 任何数字必须有单位与口径。"失败率 72–100%" 缺了「什么失败」就是误导。
```

> **这条规矩对本框架自身同样适用。** 我在核实外部来源时，也发现我派出的调研 agent 带有无法核实的 2026 年 arXiv 编号，已一并剔除，未写入任何框架文件。
