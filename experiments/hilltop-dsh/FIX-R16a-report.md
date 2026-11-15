# FIX-R16a 报告：state.json 的 `target_repo` 字段与条件必填校验

**结论**：三件事全部完成，`node tools/check-state.test.mjs` 全绿。
**遗留一条**：`tools/fix-phase-e2e.test.mjs` 场景 B 的 B0 断言变红——原因见 §4，这**不在本任务允许改的三个文件里**，需要下一个任务决定。

---

## 1. 字段定义原文（`framework/artifacts/run-state.md`）

schema 示例（顶层，紧跟 `status` 之后）：

```json
"target_repo": "path|null — 被审仓库绝对路径。FIX 路径下必填（缺或指向不存在的目录则报 target_repo_required，见第 2 节）",
```

字段说明表（第 2 节，`report.dir_ready` 那张表之后新增一段）：

| 字段 | 规则 |
|---|---|
| `target_repo` | 被审仓库根的**绝对路径**，`string\|null`。`path_mode = FIX` 且 `phase ∈ {wave4, wave5}` 且 `fix_contracts` 非空时必须非空**且解析后是一个真实存在的目录**，否则 `check-state.mjs` 报 `target_repo_required`。**不在 `TOP_REQUIRED` 里**——AUDIT_ONLY 路径可缺席，存量账本不会一夜不合规 |
| 谁写 | 主 Agent 建产物目录的那一步一起写（即 `report.dir_ready` 置 `true` 的同一步，见 `report-naming.md` §5.1）。位置在顶层，不在 `report` 下 |

文档里写清的三件事：

- **为什么需要**：`check-payload.mjs` 的 `red_log_not_found` / `test_path_not_found` 要把信封里的相对路径（相对被审仓库根）解析成绝对路径才能 `existsSync`。它只认 `--repo <被审仓库根>`。拿不到就降级成 `evidence_existence_unchecked` WARN——**「证据文件是否真的存在过」这一整项被跳过**，只剩路径形状检查。
- **它不是自述吗——承认**。主 Agent 可以指向假仓库。但「指向一个假仓库」至少留了痕（路径写在账本里，可被任何人拿一试），「根本不写」连痕迹都没有。文档里用一张两行对照表把这两类失效形态在**可追溯性**上的差别写死。
- **谁来写**：主 Agent 建产物目录时（`report.dir_ready` 置 `true` 的同一步）一起写。

---

## 2. 新测试在改代码前的失败信息原文

先写测试、先跑、确认 FAIL，然后才改 `check-state.mjs`。改动前的原始输出（结尾片段）：

```
case 42: FIX + wave4 + 有契约但完全没有 target_repo → 报 target_repo_required
  ✗ 报 target_repo_required — []
  ✗ 字段指向 target_repo
case 43: FIX + wave4 + target_repo 指向不存在的路径 → 报错（不是字符串非空就算数）
  ✗ 报 target_repo_required — []
  ✗ 消息点明「不是字符串非空就算数」
case 44: FIX + wave4 + target_repo 指向真实存在的目录 → 通过
  ✓ 不报 target_repo_required
  ✓ 无错误
case 45: AUDIT_ONLY + wave4 + 无 target_repo → 通过（不误伤审计路径）
  ✓ 不报 target_repo_required
  ✓ 无错误
case 46: FIX + wave4 + fix_contracts 为空 → 不报 target_repo_required（与 case 41 同一条纪律）
  ✓ 不报 target_repo_required

=== 结果: 57 通过 / 4 失败 ===
```

关键点：**失败的是 42/43 的 4 条断言，不是全部**。44/45/46 在实现之前就是绿的——
它们测的是「不该报」，而那时实现还不存在，自然不会报。这正是要保留它们的原因：
实现加上之后如果这三条变红，就说明新规则误伤了。

---

## 3. 最终测试数

```
$ node tools/check-state.test.mjs
=== 结果: 61 通过 / 0 失败 ===
```

- 原有 52 条断言：**未改动，全部通过**。
- 新增 9 条断言（case 42–46）。
- 另有 4 处**样本侧**的补丁，不新增断言、不改原有断言：
  `case 29`（wave4/wave5 整体无错误）、`case 32`、`case 37`、`case 38` 这四个
  「应当完全合规」的样本必须带上 `target_repo`，否则它们被新规则判红。
  这是 R14 加 `report_dir_required` 时同一位置已经做过的事（该处已有 `fixReport` 常量与注释）——
  照同样的写法加了 `fixTargetRepo = HERE`。

判据实现（`tools/check-state.mjs` 4.56 节），与 `fix_contracts_required` / `report_dir_required` 同构：

- 条件：`path_mode === 'FIX' && phase ∈ {wave4, wave5} && fix_contracts 非空`
- 判据一：`state.target_repo` 是非空字符串，否则报
- 判据二：`resolve(target_repo)` 是**真实存在的目录**（`existsSync` + `statSync().isDirectory()`），否则报
- **没有加进 `TOP_REQUIRED`**

---

## 4. 曾短暂变红、已解除：`fix-phase-e2e.test.mjs` 场景 B

在本次改动的中间态，`tools/fix-phase-e2e.test.mjs` 的场景 B（B0「应当 exit 0」）曾变红：

```
✗ B0 [R1/check-state] exit 0（wave4 合法 + 8 条契约字段完整） — 实际 exit 1；["target_repo_required"]
=== 结果: 47 通过 / 1 失败 ===
```

改前该文件是 `48 通过 / 0 失败`（已用 `git stash` 验证），所以这不是既有问题。
原因是它的 `stateOf()` 构造器产出的正是「FIX + wave4 + 8 条 fix_contract」——
新规则对这个形状要求 `target_repo`，而它没有。**这是新规则按设计生效。**

该文件不在本次授权的三个文件里，所以当时**没有动它**，只在报告里留了记录。
随后同一工作区里的另一个任务（R16b）在 `tools/fix-phase-e2e.test.mjs:307` 按同样的
`...(targetRepo ? { target_repo: targetRepo } : {})` 写法补上了这个样本参数，
现在该文件已回到 **`48 通过 / 0 失败`**：

```
$ node tools/fix-phase-e2e.test.mjs
=== 结果: 48 通过 / 0 失败 ===
```

`node tools/check-all.mjs` 也是 `✅ 全部通过`。

> 注：本次会话**没有执行任何 `git add` / `git commit`**。工作区里出现了一个提交
> `01c8647`，它把 R16a 与 R16b 一起提交了——那是同一工作区里另一个会话做的，不是本任务。

---

## 5. 这个字段能防住什么、不能防住什么

**能防住**：主 Agent 在 FIX 路径的 wave4/wave5 **完全不记录被审仓库在哪**。
这一类「省略」现在会让 `check-state.mjs` 报 `target_repo_required`，而不是让
`check-payload` 的 `red_log_not_found` / `test_path_not_found` 静默降级成 WARN。
它顺带堵住了「写个空字符串/不存在的路径假装填了」——判据要求目录真实存在，
所以账本上「填了」这个状态不再能靠一个假值买到。

**不能防住**：它防不住**存心指向一个错误但真实存在的目录**。`target_repo` 终究是主 Agent 的自述字段，
没有独立来源能证明「这个目录就是被审对象」。它把失效从「无痕」变成「有痕」——
路径一旦写进账本，事后任何人都能拿它一试。这是它全部的保证，不要读成更强的意思。
