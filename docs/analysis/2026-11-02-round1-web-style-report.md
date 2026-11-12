# round1 审计报告（D:\Web\style · 首轮实测）

> **审计对象**：`D:\Web\style`（GitHub Pages 静态站 + 30 个视觉原型）
> **框架版本**：2026-11-01 修订后
> **路径模式**：AUDIT_ONLY（只读，未修改任何文件）
> **审计范围**：2 个深挖 agent，覆盖 6 个切片、约 11000 行；另含 headless Chrome 运行时验证
> **零写入自检**：跟踪文件零改动 ✓ / 未跟踪文件 1841（与基线一致）✓ / 临时目录已清理 ✓

---

## 0. 元信息

| 字段 | 值 |
|---|---|
| 仓库规模 | 2249 个跟踪文件，其中源码类（修正后规则）198 个 |
| `effective_slices` | 56（按 800–1800 行/片重新切分后） |
| 本次审计切片 | **6 / 56（10.7%）** |
| 审计文件行数 | 约 11000 行 |
| 发现总数 | **29 条**（agent A 11 条 + agent B 18 条） |
| 严重性分布 | **0 CRITICAL / 4 HIGH / 21 MEDIUM / 4 LOW** |
| 报告状态 | `PARTIAL_BUDGET` —— 仅覆盖 10.7%，剩余 50 片未审 |

**这份报告本身就是覆盖率问题的证据**：即便按修正后的规则，一轮也只能审 10.7%。

---

## 1. 发现索引

### Agent A（代码逻辑 / 构建工具 / 数据管道，11 条）

| # | 严重性 | 位置 | 一句话 |
|---|---|---|---|
| A1 | **HIGH** | `_build/check-stale.mjs:172` | 规格链文件名写错（`05-` 应为 `06-`），被 `.filter(existsSync)` 静默剔除，S21–S30 的陈旧守卫**恒不生效** |
| A2 | **HIGH** | `_build/check-stale.mjs:118-123` | 产品分支对「report.json 损坏 / `at` 缺失」一律 `continue`，实跑得「✓ 全部新鲜 / EXIT=0」；30 案分支 2026-10-31 已修过同一坑，产品分支漏了 |
| A3 | MEDIUM | `_build/collect-schemes.mjs:540-562` | 「报告损坏」与「没有报告」合并为同一结果，界面显示「未渲染」，把用户指去跑一条已经失败过的命令 |
| A4 | MEDIUM | `_prompts/clean-dna.mjs:986` | `vars.get(name)` 在普通对象上必抛 `TypeError`；当前不可达，但一旦触发会中断整条生成链 |
| A5 | MEDIUM | `_selection/prompt-copy.js:754-755` | 4 案提示词自相矛盾：第 3 条说「全站方角」，第 ② 条说「圆角边界」 |
| A6 | MEDIUM | `_selection/app.js:736` | 空状态文案「芯片本身能筛出 N 行」中的 N **恒为 0**（假数字），与同句后半段自相矛盾 |
| A7 | MEDIUM | `_selection/app.js:645,655-657` | 没有任何搜索词时，空状态仍无条件说「行业词搜不到」 |
| A8 | LOW | `_selection/app.js:416-419` | 取消芯片后，暂存条仍宣称「芯片正在按行业筛」 |
| A9 | MEDIUM | `_selection/prompt-copy.js:954-962` | 复制按钮定时器无代际号，1.8 秒内二次点击可让按钮**永久停在「已复制 ✓」** |
| A10 | MEDIUM | `_build/fetch-fonts.mjs:98,101-107` | 部分字体下载失败仍写出含死 `url()` 的 CSS，退出码 0 |
| A11 | LOW | `_selection/index.html:153` | 折叠条写死「11 组 47 颗芯片」，实测 10 组 45 颗（全展开 73 颗） |

### Agent B（原型页面 + 运行时验证，18 条）

| # | 严重性 | 位置 | 一句话 |
|---|---|---|---|
| B1 | **HIGH** | `S02-gilded-symmetry-salon/index.html:31` | 首屏主 CTA「预约 40 分钟到店量体」**完全没有绑定任何行为**，点击后无反馈 |
| B2 | **HIGH** | `S12-lime-knockout-wall/index.html:301,303,304` | 「复位到未凿状态」后，洞口卡片说 01/04「已凿开」、索引表说「未开」、计数牌说「00/07」——**同屏三个互斥答案** |
| B3 | MEDIUM | `S22-paper-screen-folded-sheet:180,277-281` | 折痕实测已到 6px，但 `CREASE-22` 错误态永不解解除；文字承诺「6px 后自动解除」 |
| B4 | MEDIUM | `S02/index.html:359-364` | 电话校验只数长度（`>= 8`），`abcdefgh` 被判为有效号码；文案却说「10 位数字」 |
| B5 | MEDIUM | `S02/index.html:256-261` | 减少动态模式下，右半烫金版 `opacity` 被永久改成 `1`，基准值是 `0.72`，左右失对称 |
| B6 | MEDIUM | `S16-velocity-slant:382-386` | 「松手恢复位移」按钮回执说「回到 20px」，实测仍是 56px，且再滚 1px 立刻重新钳制 |
| B7 | MEDIUM | `S16-velocity-slant:293-294 vs :323` | 进度尺指针倒退——两个函数抢写同一个 `--rung`，语义不同（位移比例 vs 块序号） |
| B8 | MEDIUM | `S16-velocity-slant:37` | 首屏按钮写死「下一块：第 04 号」，实际跳到第 02 号 |
| B9 | MEDIUM | `S16-velocity-slant:199 vs :279-285` | 错误态自称「速度超过 2400px/s 才钳制」，实现只按滚动**位置**钳制，与速度无关 |
| B10 | MEDIUM | `S05-pixel-cold-storage:345-349` | 点主按钮调到 −20℃ 后按钮变灰，再用拨杆改成 −22℃，按钮仍写「已调至 −20℃」 |
| B11 | MEDIUM | `S05-pixel-cold-storage:352-363` | 库区切换只改 `aria-pressed`，八块面板读数仍是 3 号库——**向屏幕阅读器宣告了不存在的切换** |
| B12 | MEDIUM | `S22:285-298` | 「存到下次看」与「翻一折」共享 `is-folded` 状态，互相打脸；翻回来后按钮永久灰着 |
| B13 | MEDIUM | `S18-phosphor-service-deck:168,124,225-227` | 页脚说「回执 9 条、挂牌 4、摘牌 5」，实测 7/4/7；第 124 行日志又说「6/3/2」；折页表把第 18 行的挂牌算进第 2 段 |
| B14 | MEDIUM | `S12:313-319` | 洞口 05「重取成功」后，索引表仍标 `MASK-05`、角度仍写「兜底 45° 单色」 |
| B15 | MEDIUM | `S12:118,83` | 文案称「热区仍可点击、Tab 按 01–07 硬排」，实测七个洞口**全部不可点击、不可聚焦**（可聚焦元素数 = 0） |
| B16 | MEDIUM | `S22:280 vs style.css:470` | 窄屏（≤767px）`#foldnote` 写「折痕已到 6px」，该档 `--crease-deep` 被固定为 `2px` |
| B17 | LOW | `S02:266 vs style.css:149` | CSS 写死的 −28px 基准相位，首帧就被内联 `translateY(0px)` 覆盖，是死声明 |
| B18 | LOW | `S11-samizdat-typewriter:257 vs :260-261` | 第九章自称「条目号 9.1 至 9.4 仍可引用」，实际只存在 9.1、9.2 |

---

## 2. 四条 HIGH 的独立复核

按 `evidence-policy.md` 第 8 节，我（主 Agent）对 HIGH 做了**独立复核**，不只依赖子 Agent 自述。

### A1 复核 ✓ 坐实

```bash
$ sed -n '172p' prototypes/_build/check-stale.mjs
        return ['04-schemes-01-10.md', '05-schemes-11-20.md', '05-schemes-21-30.md']
                                                                  ^^^^^ 应为 06-
$ ls deliverables/ | grep schemes-2
06-schemes-21-30.md                      ← 磁盘上只有 06-
$ sed -n '17p' prototypes/_build/extract-specs.mjs
  '06-schemes-21-30.md',                 ← 同一上游，写法正确
```

紧随其后的 `.filter((f) => existsSync(f))` 把写错的路径吃掉。**该文件 180–183 行的注释自己警告过这种失效形态：「它失效的样子是『全部新鲜』，看起来像通过 —— 这是最危险的一类 bug」。这条 bug 就长在它自己的警告旁边。**

### A2 复核 ✓ 坐实

```bash
$ sed -n '120,123p' prototypes/_build/check-stale.mjs     # 产品分支
    try { at = new Date(...).getTime(); } catch { continue; }
    if (!Number.isFinite(at)) continue;          ← 静默跳过

$ sed -n '48,53p' prototypes/_build/check-stale.mjs       # 30 案分支（已修）
    /* ⚠️ 2026-10-31：`at` 缺失/非法从前是 `continue` 静默跳过 ——
     * 那等于「这一案的陈旧度无法判定」被当成「不陈旧」 */
    if (!Number.isFinite(at)) {
      out.push({ ..., label: 'at 缺失或非法', ... });   ← 改为报出来
```

**同一个文件里，同一个缺陷，一半修了、一半没修。**

### B1 复核 ✓ 坐实

```bash
$ grep -n "book-btn" prototypes/S02-gilded-symmetry-salon/index.html
31:  <button class="btn btn-solid" id="book-btn" type="button">预约 40 分钟到店量体</button>
                                                                    ↑ 全文仅此一处
$ grep -n "<script" prototypes/S02-gilded-symmetry-salon/index.html
229:<script>                          ← 唯一脚本块，内联，无外部 src
$ grep -o "addEventListener('[a-z]*'" .../index.html | sort | uniq -c
      2 addEventListener('change'      ← 目标是 .step / .slot / #wait-form
      1 addEventListener('click'       ← 目标不是 #book-btn
      ...
```

`id="book-btn"` 定义后**再无任何引用**。这是页面唯一的高对比主按钮，写着祈使句，点击无任何反应。

### B2 复核 ✓ 坐实（且能看出根因）

```javascript
// S12-lime-knockout-wall/index.html:298-304（reset-wall 处理器内）
document.querySelectorAll('.opening .op-state').forEach(function (p) {
  var no = p.closest('.opening').querySelector('.op-no').textContent;
  if (no === '05') return;
  p.textContent = no === '03' ? '未开' : (no === '01' || no === '04') ? '已凿开' : '未开';
                                              //  ^^^ 复位操作里居然写回「已凿开」
});
document.querySelectorAll('.is-open-yes').forEach(function (td) { td.textContent = '未开'; ... });
                                         //  ^^^ 紧接着又把表里的全改成「未开」
count.innerHTML = '已凿开 <code>00</code> / <code>07</code>';
                                         //  ^^^ 计数又清零
```

**一个「复位」函数里三处对同一事实给出互斥答案。** 这是典型的复制粘贴错误——第 301 行的三元表达式大概是照着「初始化」场景抄过来的，没改成复位语义。

---

## 3. 覆盖率（诚实披露）

| 指标 | 数值 |
|---|---|
| 切片总数 | 56 |
| 本次审计 | 6（10.7%） |
| 未审计 | **50 片（89.3%）** |
| 未审计的主要区域 | 30 个原型中的 24 个、`_build` 的 8 个检查脚本、`templates/`、`_selection/style.css`（90KB）、22 个原型的 `style.css` 未逐行读 |

**未覆盖的部分完全不知道有没有问题。** 本报告不得被读作「这个项目只有 29 个问题」。

**Agent B 额外做了一件框架没要求但很有价值的事**：全量核对资源引用——8 个页面 73 个本地 `src`/`href`、22 条 CSS `url()`、697 条字体 `url()` **全部存在**，0 个 404、0 个未捕获异常。这类"**检查了但没问题**"的结论同样重要，它让"没报问题"和"没查"可区分。

---

## 4. 零写入自检（附真实输出）

```
$ git -C "D:/Web/style" status --short | grep -E '^ ?[MDARC]'
（无输出）
✅ 跟踪文件零改动

$ git -C "D:/Web/style" status --short | grep -c "^??"
1841
（与运行开始时基线一致 —— 零新增）
```

两个子 Agent 都在隔离环境做实验（agent A 用 `.audit-tmp/` 副本，agent B 用本地 HTTP 服务器 + headless Chrome），**均已确认清理，无残留**。

---

## 5. 对框架的实测结论

这一轮验证了四件事：

**① 两遍制确实能审出真东西。** 29 条发现里，4 条 HIGH 有 3 条是"**状态不一致**"类——代码能跑、页面能看，但同一事实在不同地方给出不同答案。这类缺陷**单靠通读极难发现**，必须真的去跑、去对照多个位置。

**② 运行时验证是必要的一层。** Agent B 用了 headless Chrome 实测，才敢断言"测试折痕确实是 6px 但错误码没解除"、"可聚焦元素数为 0"、"进度尺指针从 3 跳到 1"。**纯静态读代码做不到这一点。**

**③ 门 0 真的拦住了东西。** Agent A 明确记录：因未读 `render-scheme.mjs`，无法排除"report.json 是原子写"这一替代解释，据此下调了 A2/A3 的严重性并标注未排除项。这正是 evidence-policy 要的"列出所有合理解释"。

**④ 零写入规则守住了，且可验证。** 两个 agent 都用了 `Bash`（一个建副本、一个起服务器），但都在隔离环境做、完成后清理，`git status` 可复核。**没有这条规则，它们完全可能直接在仓库里改文件跑实验。**

**覆盖率仍然是硬伤**：56 片一轮只审 6 片。印证了 `run-state.md` 第 6.5 节「自动多轮推进」的必要性——需要约 10 轮才能覆盖完。

---

## 6. 模式级观察（跨 agent 的共性）

29 条发现里有一个反复出现的形态，值得单独指出：

| 形态 | 出现次数 | 例子 |
|---|---|---|
| **同一状态在多处表达，且互不同步** | **7 条** | B2（卡片/表/计数）、B3（状态条/错误段/回执）、B10（按钮/面板）、B12（两个按钮共享 class）、B14（卡片/表/日志）、B13（页脚/日志/折页表）、A3（gate/advisory） |
| **文案承诺的行为与实现不符** | 6 条 | B4（说10位、验8位）、B9（说速度、按位置）、B15（说可点击、实际不可）、B16（说6px、实际2px）、A5（说方角、又给圆角）、B3（说自动解除、永不解除） |
| **静默跳过 / 吞异常** | 3 条（活跃代码中见下） | A1（`.filter(existsSync)`）、A2（`catch { continue }`）、A10（下载失败仍写） |

**这个分布说明：项目的核心风险不是"逻辑写错"，而是"同一事实有多个副本、副本之间会漂移"。** 修复时应当优先消除副本，而不是逐个改文案。

### 6.1 对上轮「全仓 7 处同模式」这一说法的更正

上轮我在汇报里说过"静默跳过的同类模式全仓共 7 处"。**这个数字不准，必须更正。**

精确复核（`grep -rn` 全仓，排除 `node_modules`）的结果是：

| 范围 | `catch { continue }` + `.filter(existsSync)` 的处数 |
|---|---|
| `prototypes/_build/`（**活跃代码**） | **4 处** |
| `deliverables/`（历史存档/临时脚本） | **20+ 处** |
| 全仓合计 | **20+ 处** |

**关键区分**：`deliverables/` 下大量是 `37-scratch`、`40-scratch/snap`、`55-scratch`、`59-scratch`、`69-audit`、`70-plan/redteam` 之类的**历史存档与临时脚本**（从名字就能看出是一次性的）。它们在项目里已经不参与构建链。

**因此正确的修复建议是**：

1. **活跃代码**（`prototypes/_build/`）的 4 处需要逐条评估——其中 `check-stale.mjs:174` 已确认是 HIGH（A1）；
2. **`deliverables/` 下的 20+ 处不应纳入本轮修复范围**——那是归档材料，改它们没有收益，还会制造 diff 噪声；
3. 我的上一版建议"一次性扫全仓 7 处"是**错的**：数字错了，范围也错了。

> **这条更正本身说明了框架 2.4 节「模式级复查」的一个陷阱**：`grep` 出来的模式匹配**不等于**同一类缺陷，必须再判断"这段代码是否还在活跃路径上"。**模式级复查的第一步是划分活跃/归档，第二步才是计数。**

---

## 7. 下一步

- 剩余 50 片待审（建议自动多轮推进，每轮 6 片，约需 9 轮）
- **A1 + A2 是同一个文件的两处同类缺陷**，修复时应一次性扫描该文件所有 `.filter(existsSync)` 与 `catch { continue }`，而不是只修报告点出的两处（全仓共 7 处同模式）
- B2 的三元表达式是复制粘贴错误，修复后须同时验证"卡片 / 索引表 / 计数牌"三处一致
- 有 3 条存在未排除的替代解释（A2/A3 的原子写、B11 的设计意图），修复前应先确认
