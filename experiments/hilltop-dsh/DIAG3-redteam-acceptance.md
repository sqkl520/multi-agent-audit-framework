# DIAG3 — 红队：攻击主线程的验收结论

**目标**：主线程结论「4 条修复成立，1 条不修成立，885 tests / 0 failures / EXIT=0，全部由我独立重跑确认。」
**方法**：只读。git diff / 源码 / 文件 mtime / 日志。不采信任何一方自述。
**写盘纪律**：每攻完一条立刻追加（本文件按 A→G 顺序增量写入，最后补可信度）。

---

## A. 验收是不是「看它自己写的报告」？

**指控（部分成立）**：验收确实读了 `git diff` 与源码（不是纯转述 `done-*.md`），但有 **6 处 `文件:行` 引用已经指向别处**，
且验收从头到尾没有做过「引用有效性」复核。第二轮改完 `ConfigManager.java` 后行号整体下移，验收仍沿用第一轮的数字。

**证据**：

`done-7.md` 自己声称的三个 `loadFromFile()` 钳制点：

```
done-7.md:  "- `:1402-1410` / `:1484-1492` / `:1707-1716` — `loadFromFile()` 的三个载入点做同样处理。"
```

当前工作区实测：

```
$ grep -n 'contains("victory-waves")\|contains("nodes.repair-cost-amount")\|monsters." + key + ".explode-damage-multiplier")' \
    src/main/java/com/hilltopvillage/config/ConfigManager.java
1416:  if (settingsYaml.contains("victory-waves")) {
1498:  if (settingsYaml.contains("nodes.repair-cost-amount")) {
1721:  if (settingsYaml.contains("monsters." + key + ".explode-damage-multiplier")) {
```

引用区间 `:1402-1410` 现在落在这段（逐字）：

```java
        activeConfig = new GameConfig();
        // slice-07-data-consistency-009：重建后归一化会重新计算，脏标志的归一化项随之重算。
        loadTimeNormalizationPending = false;

        if (settingsYaml.contains("world-name")) activeConfig.setWorldName(settingsYaml.getString("world-name"));
        if (settingsYaml.contains("core.x")) activeConfig.setCoreX(settingsYaml.getDouble("core.x"));
```

—— 是 `new GameConfig()` 与 world-name/core 赋值，**不是钳制代码**。
`:1484-1492` 现在落在 `repair-cost-name` / `repair-cost-item` 的材质校验；`:1707-1716` 落在 `display-egg`。

成因可复原：`git diff -U0 ConfigManager.java` 的 hunk 头显示第一轮加了 `+396,9 / +441,6 / +556,12 / +729,25`，
第二轮又加了 `+1349,12` 与 `+1383,5`。第一轮写 `1402` 时是正确的（HEAD 的 1351 + 52 行前序插入 = 1403），
第二轮在 1349/1383 处插入 17 行后，正确值变成 1416。**验收没有重算。**

同类偏移（小）：

| 出处 | 声称 | 实际 |
|---|---|---|
| `done-4.md` | `messages.yml` EN `:1107` | `:1109` |
| `done-4.md` | `messages.yml` ZH `:2205` | `:2209` |
| `done-4.md` | `ArenaResetService:332-336` | `:335-336` |
| `done-7.md` | merge 点 `:439-447` / `:558-567` | `:441-446` / `:556-567`（边界各差 2） |

反向核对（这些是对的）：`done-6.md:44/233-244/254-257` ✓、`done-1.md:223-247/281-304` ✓、
`NodeSystem:526-573` ✓、`ArenaManageGUI:846` ✓。

**严重度**：一般。
**为什么不是致命**：验收的核心动作是读 diff 与源码，`:1402` 指错位置不会让「钳制存在」这个结论变假——
钳制代码确实在 1416/1498/1721。但**这正是 A 问的那个问题，答案是「有」**。
**正确做法**：引用一律写成「文件 + 符号名（如 `ConfigManager#normalizeVictoryWaves` 及其调用点）」，
或每次验收前用 `grep -n` 重算行号；第二轮改完 `ConfigManager.java` 后必须回头修第一轮产物的引用。

---

## B. 「先写红测试」是真的吗？

**指控（成立，且是最硬的一条）**：三个号称证明「修复前是红的」的日志**已经不存在**，
验收却把它们列为「存在且内容可信」。而被引用的最终日志 `target/full-test-final.log` 同样不存在。

**证据**：

`ACCEPTANCE-ROUND1.md:31-38` 逐字：

> ### 红测试日志是真的，不是事后编的
> 三个「修复前是红的」证据文件存在且内容可信（UTF-16 编码，需转码读）：
> | `target/config7-red.log` | 3/4 | ... |
> | `target/config7-infinity-red.log` | 1/1 | ... |
> | `target/repair1-red.log` | 5/5 | ... |

`SUMMARY.md:25-26` 逐字：

> 最终日志：`target/full-test-final.log`（修复前红色证据：`target/config7-red.log`、
> `target/config7-infinity-red.log`、`target/repair1-red.log`）。

当前实测：

```
$ ls "…/Hilltop Village Plugin/target/"
classes  generated-sources  generated-test-sources  maven-status
surefire-reports  test-classes  test-tmp  verify-round2.log

$ find "…/Hilltop Village Plugin" -name "*red*.log"     → 无输出
$ find "…/multi-agent-audit-framework" -name "*red*.log" → 无输出
```

`target/` 只有 `verify-round2.log`（mtime `2026-11-15 03:08:29`）。四个被引用的日志**全部消失**。

成因清楚：`build.cmd` 第 11-13 行自述默认动作是 `mvn clean package`，第 164-165 行
`call "%MVN%" clean package`。第二轮在 02:59–03:08 跑了一次构建，`mvn clean` 把 `target/` 整个删了。
**验收把证据放在了构建必然清理的目录里，并且没有在验收后立刻把它拷出来。**

**能证明它们「跑在未修复代码上」吗？**

不能，而且现在连「它们存在过」都无法从工作区复核。可复核的只有两条间接线索：

1. `done-7.md` 的失败原文带 `expected: <1> but was: <0>`、`expected: <10.0> but was: <Infinity>`，
   格式与 surefire 真实输出一致；断言文案是中文自定义 message，不是人工编造的裸数字。
2. `repair/` 下全部 `.md` 的 mtime 是 `02:47:00`（同一秒批量落盘，是拷贝动作），
   而 `repair-work/project/target/` 下没有任何 red 日志——说明当时的 red 日志只存在于被验收的那个
   `target/`，从未进过任何备份目录。

**「修复后故意改坏再跑」这个可能性能排除吗？**

逻辑上不能完全排除，但成本很高：`done-4.md` 主动交代了「旧代码没有 `NODE_ROLLBACK_FAILED` 枚举值，
无法在未修复代码上编译运行」，`done-8.md` 也主动区分了「编译失败不算变红」。这种自我设限的诚实度
降低了伪造嫌疑。**但这是对叙述可信度的判断，不是对证据的判断。**

**严重度**：严重。
**正确做法**：红测日志落在 `target/` 之外（如 `repair/redlogs/`），并在验收记录里写 `sha256`；
或者至少把日志在验收通过后立刻复制出 `target/`。**引用一个随手会被 `mvn clean` 删掉的文件当唯一证据，
等于没有证据。** 本次验收应当写「证据已不可复核」，而不是「存在且内容可信」。

---

<!-- 待续：C/D/E/F/G -->
