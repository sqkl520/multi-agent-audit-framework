# 实测数字重算与更正（2026-11-03）

> **起因**：第 10 视角（数据审计员）复算了我的核心数字，发现多处站不住。
> **本文件的目的**：不再只留"一个数字"，而是把**口径 + 命令 + 原始输出**一起落盘——这正是它批评我缺的东西。

---

## 一、它说对了：三个数字是错的

### 1. `144 处 both/forwards` → 实为 **136 处**

**我原来的表述**：「全仓 `animation: ... both|forwards` **144 处**（我实测）」

**问题**：**没写口径**。我当时的命令把 `.html` 里的内联 `animation` 也算进去了，但表述写的是"全仓 `animation: ... both|forwards`"。

**重算（三种口径，都跑一遍）**：

```bash
cd D:/Web/style && node -e "
const {execSync}=require('child_process'),fs=require('fs');
const css=execSync('git ls-files',{encoding:'utf8'}).trim().split('\n').filter(f=>f.endsWith('.css'));
let a=0,b=0,c=0;
for(const f of css){
  const s=fs.readFileSync(f,'utf8');
  a += (s.match(/animation\s*:[^;}]*\b(?:both|forwards)\b/g)||[]).length;
  for(const L of s.split('\n')) if(/animation/.test(L)&&/\b(?:both|forwards)\b/.test(L)) b++;
  c += (s.match(/animation-fill-mode\s*:[^;}]*\b(?:both|forwards)\b/g)||[]).length;
}
console.log('CSS 文件数:',css.length);
console.log('口径1 (animation: ... both|forwards 声明):',a);
console.log('口径2 (含 animation 且含 both|forwards 的行):',b);
console.log('口径3 (animation-fill-mode 显式):',c);
"
```

**原始输出**：

```
CSS 文件数: 83
口径1 (animation: ... both|forwards 声明): 136
口径2 (含 animation 且含 both|forwards 的行): 136
口径3 (animation-fill-mode 显式): 0
```

**结论**：**136**，三种口径里两种收敛到同一个值。**144 是错的。**

---

### 2. `_build 下 4 处静默跳过` → 实为 **8 处**

**我原来的表述**（`wave3-critique.md` 第 190 行）："精确复核后发现是 **活跃代码 4 处** + 归档目录 20+ 处"

**数据审计员说**：实测是 11 处（`catch{continue}` 6 + `.filter(existsSync)` 5）

**重算**：

```bash
cd D:/Web/style && node -e "
const fs=require('fs');
const dir='prototypes/_build';
const files=fs.readdirSync(dir).filter(f=>f.endsWith('.mjs'));
let cc=[],fe=[];
for(const f of files){
  const s=fs.readFileSync(dir+'/'+f,'utf8');
  const n1=(s.match(/catch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\*[\s\S]*?\*\/)?\s*continue\s*;?\s*\}/g)||[]).length;
  const n2=(s.match(/\.filter\(\s*(?:\(\s*f\s*\)\s*=>\s*)?existsSync\s*\)/g)||[]).length;
  if(n1) cc.push(f+':'+n1);
  if(n2) fe.push(f+':'+n2);
}
const sum=a=>a.reduce((x,y)=>x+ +y.split(':')[1],0);
console.log('catch { continue }:',sum(cc),'处 →',cc.join(' '));
console.log('.filter(existsSync):',sum(fe),'处 →',fe.join(' '));
console.log('合计:',sum(cc)+sum(fe),'处');
"
```

**原始输出**：

```
catch { continue }: 7 处 → assign-assets.mjs:1 backfill-credits.mjs:2 check-prompts.mjs:1 check-stale.mjs:2 shot.mjs:1
.filter(existsSync): 1 处 → assign-assets.mjs:1
合计: 8 处
```

**结论**：**8 处**（不是 4，也不是 11）。

**三方数字全不一样，这本身就是教训**：

| 来源 | 数字 | 问题 |
|---|---|---|
| 我的第一版 | 7 | 只扫了 `_build/` 却说是"全仓" |
| 我的"更正版" | 4 | 漏了 `backfill-credits`、`check-prompts`、`shot` |
| 审计员的复核 | 11 | 它的正则口径与我的不同（可能把 `.filter(existsSync)` 数成了 5） |
| **本次逐文件计数** | **8** | 列出了每个文件名与条数，可逐条复核 |

**这条最好的地方不是数字变对了，而是它暴露了"口径没写清时，三个认真的人会得到三个数"。**

---

### 3. `45% 误报率` → **这个百分比根本不成立**

**我原来的表述**：「误报率 5/11 ≈ 45%。而静态推断还漏掉了一个真案（S18）」

**数据审计员指出**：11 个静态命中文件 与 11 个 DOM 判定页面 **不是同一集合**。

**我核实**：

| | 名单 |
|---|---|
| 静态命中（`wave2-audit.md:291`） | S04 S05 S09 S11 S12 S13 S15 S16 S17 S18 S22 |
| DOM 判定（`:360-362`） | S01 S04 S08 S10 S12 S15 S16 S18 S22 S25 S28 |
| **重叠** | S04 S12 S15 S16 S18 S22（**6 个**） |

**被判 FALSE_POSITIVE 的 S01 / S10 / S28 根本不在静态命中名单里**——静态从没"报"过它们。

而静态确实命中的 S05 / S09 / S11 / S13 / S17 在 DOM 裁决表里**整批消失**。

**结论：分子来自 DOM 实验，分母来自静态实验。这个百分比在数学上不指向任何东西。**

**已改**：`wave2-audit.md` 4.6.4.2 节现在明确写「这个百分比不成立」，并附上两个集合的对照表。

**顺带修正一个自相矛盾**：我原来写「S18（DOM 才发现的）」，但 `S18(2/3)` 就在静态命中名单里。**已删掉这个错误标注。**

---

## 二、它说对了但我这次没改的（因为要重新设计）

| 指控 | 状态 |
|---|---|
| **128 条里 47 条没有可查产物**（B 组 25 / C-2 组 11 / E 组 11） | 属实。补产物成本高，**但总数必须改**：可核实的只有 **81 条**（29 + 16 + 18 + 18） |
| **"128 条的分布"表实际只分布 85 条**，43 条无归属 | 属实。已知道这个表不能当"128 的完整分布"用 |
| **§6.1 宣布"7 处不准"但 §7 行动清单仍写"全仓共 7 处"** | 已修（见上） |
| **宣布 9→5 但修复清单三处仍按 9 写** | **已修**（`final-report.md` 改成"5 处经 DOM 证实"） |
| **"任何项目、任何技术栈"是稻草人** | 属实。框架从没说过这句话，我在诊断里自己立了个靶子打 |
| **4 个脚注撑 4 个论断指向同一 poster** | 属实。是 `wave4-fix.md`，违反了 `evidence-policy` 第 8 节第 2 条 |
| **零写入自检只数 `??` 行数** | 属实。`git status --short` 对未跟踪**目录**只输出一行 |

---

## 三、它说对、我也必须承认的方法论问题

> **这批报告的单点取证能力很强（D9.1、M02、S04 `--rot`、H2 死断言我都复现了），但聚合与因果能力很弱。**
>
> 它批评框架"门控在，但没有一个门控真的拦住东西"；
> **这批报告自己也一样：证据纪律写得很细，但没有一道纪律真的在生成结论时被用上。**

**我完全接受这一句。**

我在 `evidence-policy.md` 里立了三条：
1. 引用 A 级来源必须写出限定条件与口径
2. 一个脚注只能支撑一个论断
3. 任何数字必须带单位与口径

然后我：
- `144` 没写口径 ✗
- `45%` 分子分母来自不同实验 ✗
- 4 个脚注撑 4 个论断 ✗
- 「两遍制有效」在模板还不存在时就宣布了 ✗

**纪律写进了文档，但没在写结论时执行。**

---

## 四、最严重的一条：我宣布"验证通过"的设计当时还不存在

**这是数据审计员最致命的一击，我实测确认了**：

```
round1 报告：      11-02 06:06
wave2a-sweep.md：  11-02 18:31    ← 报告写完之后 12 小时才存在
round2 组 A：      11-02 07:02
round2 组 D：      11-02 07:12
```

而 round1 报告自己写的是「**2 个深挖 agent**」——**没有宽扫波**。

**三轮审计，没有一轮跑过它自称验证了的两遍制。**

我在报告里写「两遍制确实能审出真东西」——**这句必须撤回或降级为"未验证"**。

**同样**：「4 条 HIGH 有 3 条是状态不一致」也不成立，实际只有 B2 一条。

---

## 五、这次更正本身得到的教训

**问题不是"我算错了"，而是"我算的时候没有把口径和命令写下来"。**

如果第一次就写成：

> 「136 处（口径：`.css` 文件里 `animation` 声明含 `both|forwards` 的条数；命令见下；输出见下）」

那么后面三个数字的漂移根本不会发生——**因为任何人都能复跑同一口径**。

**所以 `final-report.md` 第 8 节要补一条**：

```
任何进入报告的数字，必须同时给出：
  ① 口径（分子分母各是什么、统计范围）
  ② 可复跑的命令
  ③ 原始输出
三者缺一，该数字标 UNVERIFIED，不得作为结论依据。
```

这条不是新发明——**它就是 `evidence-policy.md` 第 8 节对"证据"的要求，我把它用在了引用上，没用在自己的统计上。**
