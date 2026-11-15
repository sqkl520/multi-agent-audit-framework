# FIX-R16b 报告：把「修复后快照一致性」校验接进修复相位流程文档

日期：R16b
改动文件：`framework/templates/wave4-fix.md`、`framework/templates/wave5-verify.md`（仅此两个）
未执行 `git add` / `git commit`。

---

## 1. `framework/templates/wave4-fix.md`

新增 **§0.7 修复后快照（相位闭合前置，主Agent执行）**，插在 §0.6 之后、`---` 分隔线之前。
定位为「派发规则」第 0 节的收尾小节——它是相位闭合的前置条件，属于主Agent职责，与 §0.5 的机械对账同性质。

新增内容（39 行）：

- 三步流程：`git -C <TARGET_REPO> status --porcelain` 拿清单 → 复制到 `<OUTDIR>/repair-work/post-fix/<相对路径>` → 跑 `verify-postfix-snapshot.mjs`。退出码 `0` 才可闭合。
- `--exclude` 的语义单列一段说明：**跳过不纳入源码快照的路径前缀**（可重复），写前缀即可，`--exclude repair-artifacts/` 同时匹配目录本身与其中所有文件；并写明**不要用在源码路径上**——那等于给校验器开静默口子。
- 校验器判据表：`changed_file_not_snapshotted` / `content_differs`（FAIL）、`snapshot_file_not_in_repo`（WARN）、`snapshot_missing` / `snapshot_empty` / `repo_not_git`（exit 2）。
- 附注：未跟踪目录 `?? newdir/` 会展开成其中每个文件逐条核对，不会把「一个目录 20 个新文件」算成 1 条。
- 两段「为什么」：一是 `repair-work/project/` 是修复**前**基线，缺修复后对应物会让读者得出「修复没发生过」的结论（2026-11-15 那次诊断报告写「修复后的源码树在整个仓库里不存在」）；二是事后补拍的固有失效模式是**补漏了没人发现**（首次补拍漏 7 个文件 = 4 个改的测试类 + 3 个新增测试类，靠人工读 `git status` 才发现）。

## 2. `framework/templates/wave5-verify.md`

改动集中在第 9 节「返回前的自检清单」，共 +21/−1 行：

1. **自检表首行**新增：
   `| **快照完整（先于一切）** | verify-postfix-snapshot.mjs 退出码 0——被审仓库的每条改动在 <OUTDIR>/repair-work/post-fix/ 里都有同名且逐字节相同的副本 | **停止验收**，先补快照；缺快照时验收的对象是什么都不确定 |`
2. **机械自检块拆成两段**：原 `自检（机械，不可跳过）` 改为 `自检一（先于验收，快照完整性）`（新增，含完整 `verify-postfix-snapshot.mjs` 命令）与 `自检二（产物合规）`（原 `check-payload` 命令，内容不变）。
3. 新增一段「为什么『快照完整』必须排在最前」：验收的全部产出都是「我看到了什么」的断言；源码与快照不是同一份时，`evidence` 指向的是实验记录里不存在的对象，不可复核、不可重现。
4. 原「上表中除最后一行以外的 **10 行**」改为「除最后一行以外的条目」——新增一行后硬编码的 10 已不成立，改成不随行数漂移的措辞。

---

## 3. 实跑校验命令（真实输出）

### 3.1 主用例（`--exclude repair-artifacts/`）

```
$ node tools/verify-postfix-snapshot.mjs \
    --repo "<TARGET_REPO>" \
    --snapshot experiments/hilltop-dsh/repair-work/post-fix \
    --exclude repair-artifacts/

✓ 快照与被审仓库的改动清单一致。

EXIT=0
```

### 3.2 反向对照：去掉 `--exclude`（演示 `--exclude` 到底挡掉了什么）

```
$ node tools/verify-postfix-snapshot.mjs \
    --repo "<TARGET_REPO>" \
    --snapshot experiments/hilltop-dsh/repair-work/post-fix

  ✗ [changed_file_not_snapshotted] 仓库里 repair-artifacts/done-1.md 有改动（??），但快照里没有这个文件
  ✗ [changed_file_not_snapshotted] 仓库里 repair-artifacts/done-3.md 有改动（??），但快照里没有这个文件
  ... (共 7 条: done-1/3/4/6/7/8.md + SUMMARY.md)

合计: 7 FAIL / 0 WARN

EXIT_NO_EXCLUDE=1
```

这说明 `--exclude repair-artifacts/` **不是装饰**：被审仓库有 25 条 porcelain 条目，其中 `?? repair-artifacts/` 一个未跟踪目录被展开成 7 个文件，不排除就会变 7 条 FAIL。

### 3.3 反向对照：临时副本里删 1 个文件（验证它真的会抓漏补）

```
$ cp -r experiments/hilltop-dsh/repair-work/post-fix $TMPD/snap
$ rm $TMPD/snap/src/test/java/com/hilltopvillage/mechanics/RepairSettlementTest.java
$ node tools/verify-postfix-snapshot.mjs --repo "<同上>" --snapshot "$TMPD/snap" --exclude repair-artifacts/

  ✗ [changed_file_not_snapshotted] 仓库里 src/test/java/com/hilltopvillage/mechanics/RepairSettlementTest.java 有改动（??），但快照里没有这个文件

合计: 1 FAIL / 0 WARN

EXIT_MISSING=1
```

**用例 3.3 是这次验证里最要紧的一条**：它证明文档里那段命令在「真的漏了一个文件」时会以 exit 1 说话，而不是静默通过。三个用例合起来覆盖了「通过 / 配置对不对 / 漏补能不能抓」。

### 3.4 `--help`（`--exclude` 的权威语义）

```
$ node tools/verify-postfix-snapshot.mjs --help
用法: node verify-postfix-snapshot.mjs --repo <被审仓库> --snapshot <快照目录> [--exclude <前缀或glob>]... [--json]

  --exclude  跳过不纳入源码快照的路径前缀（可重复）。
             典型用途：修复产物目录（如 repair-artifacts/）不是源码，
             它有自己的落点（框架仓库的 repair/），不该混进源码快照。
             写成前缀即可：--exclude repair-artifacts/
EXIT=0
```

---

## 4. `node tools/check-all.mjs`

```
──────────────────────────────────────────
✅ 全部通过

EXIT=0
```

10 个检查器全部 0 失败。与本任务范围相关的一条：

```
修复后快照一致性（事后补拍有没有补漏）
  用例：漏补点名 / 快照过期内容不同 / 多余文件仅 WARN / 空快照 exit 2 / 未跟踪目录展开 / --exclude 不误伤源码
  → === 结果: 27 通过 / 0 失败 ===
```

其余检查器（wrapper 契约 / 切片保真度 / 契约示例 / 枚举一致性 / 发现去向对账 102 例 / 修复实例对账 167 例 等）均 0 失败，两处文档改动未破坏任何既有断言。

> 注：工作区里另有 `framework/artifacts/run-state.md`、`tools/check-state.mjs`、`tools/check-state.test.mjs` 三个文件在我开始前就已修改（非本次改动），check-all 在这些文件在位的情况下仍然全绿。

---

## 5. 一句话：这个检查能防住什么、不能防住什么

**能防住**：事后补拍快照的「静默漏补」——被审仓库 `git status` 里每一条改动（含未跟踪目录展开后的每个新文件）在快照里都必须有同名且**逐字节相同**的副本，漏一个就是一次机械 FAIL，不依赖任何人下次想起来去 `grep` 或逐行读 `git status`；顺带也抓「快照补完之后仓库又变了」这种过期。

**不能防住**：它只核对**改动清单的完整性**，不核对**改动的正确性**——快照里那份代码修得对不对、改动是否越权、是否删了测试断言，它一概不看（那是评审和 `wave5` 的事）；也看不到「修复本来该改却没改」的文件，因为 `git status` 里根本没有那一条。换句话说，它保证「实验记录里存的就是被审仓库现在的样子」，不保证「那个样子是对的」。
