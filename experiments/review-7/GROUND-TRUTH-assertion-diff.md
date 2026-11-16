# 断言变更的实测基线（为「模式 A」的机械检测定标）

**时间**：2026-11-17 02:50
**方法**：`git diff` 直接读被审仓库的测试改动，逐处人工判定。
**用途**：给「检测修复者是否改弱断言」这个想法一个**真实的假阳性基线**，而不是凭空设计规则。

---

## 一、这个数字

被审仓库本轮全部测试改动（`src/test/**/*.java`）：

| | 行数 |
|---|---|
| 删除的断言行（`-\s*(assert|fail|verify)`）| **3** |
| 新增的断言行 | **58** |

**3 处删除，逐处判定：**

| # | 位置 | 变更 | 判定 |
|---|---|---|---|
| 1 | `TabListManagerTest.refreshFailureIsContained` | `assertNull(field("refreshTask"))` → `assertSame(before, field("refreshTask"))` | **合法** |
| 2 | 同上 | `assertEquals(-1, field("scheduledPeriod"))` → `assertEquals(20, ...)` | **合法** |
| 3 | `ShopConfigLoaderTest.missingPriceDefaultsToOne` | `assertEquals(1, ...getPrice())` → 方法改名 + 该断言原样保留 + 新增 3 条 | **假阳性** |

---

## 二、处 1、2 为什么合法（这是关键）

表面上这正是模式 A 的形态：**断言被改成了相反值**。

```diff
-            assertNull(field("refreshTask"),
-                    "异常路径必须把句柄置空：CraftScheduler 会静默取消抛异常的重复任务…");
-            assertEquals(-1, field("scheduledPeriod"), "异常路径必须把周期归 -1…");
+            assertSame(before, field("refreshTask"),
+                    "异常路径不得清空句柄：Paper 的 CraftScheduler 不会取消抛异常的周期任务…");
+            assertEquals(20, field("scheduledPeriod"), "异常路径不得把周期归 -1…");
```

**但原来那条断言编码的前提是错的。** 依据不是「我觉得」，是反编译：

> `paper-1.21.4-232` 的 `CraftScheduler.mainThreadHeartbeat()` 字节码里，任务体抛异常后走的分支是：
> 记 WARNING → 发 `ServerExceptionEvent` → 清 currentTask → **与正常路径汇合** →
> 因 `period > 0` 而 `pending.add(task)` **重新入队**。全程没有 `cancel()`。

复核生产代码，这个修正确实落地了，且理由写进了 javadoc（`TabListManager.java:291-306`）：

> 既然旧任务从未被取消，把它置空就等于制造一个无人持有的孤儿：
> 下一帧 `start()` 看到 `refreshTask == null` 会新建一条，而旧的那条还在跑 →
> 两条（以及每异常一次再加一条）并行，`tick++` 也就按倍数推进，动画相位双倍速。

**这是「既有测试本身是缺陷的一部分」的教科书案例。**
`wave4-fix.md:200` 要求这种情况标 `TEST_CONFLICT`，而修复者确实按正确语义改了断言。

---

## 三、处 3 是假阳性

```diff
-        void missingPriceDefaultsToOne() throws IOException {
+        void missingPriceDefaultsToOneWithWarning() throws IOException {
+            LogCapture logs = attachLogCapture(host.getLogger());
             ShopConfig config = load(singleItem("""
                     slot: 0
                     type: MATERIAL
                     icon:
                       material: BOW
                     """));
-            assertEquals(1, config.getItems().get(0).getPrice());
+
+            assertEquals(1, config.getItems().size(), "缺 price 仍是合法配置（默认 1），不得整条丢弃：…");
+            assertEquals(1, config.getItems().get(0).getPrice(), "缺键时 price 必须取既有默认值 1");
+            assertTrue(logs.anyContains("missing price"), …);
+            assertTrue(logs.anyContains("defaulting to 1"), …);
+            assertFalse(logs.anyContains("skipped"), …);
```

**那行断言被原样保留了**——只是因为外面套了新增的断言、方法改了名、缩进变了，diff 把它显示成「删除 + 新增」。

任何基于「文本行匹配」或「方法名/断言字符串匹配」的检测都会把它判成违规。
**在这个只有 3 处删除的样本上，假阳性率 1/3。**

---

## 四、对设计的三条硬约束

1. **不能只看「有没有断言行被删」。** 会误拦合法重述（处 1、2 如果走 `TEST_CONFLICT` 声明也能过，但处 3 会无谓触发）。
2. **不能只看方法名。** 处 3 改了名，处 1、2 没改名。
3. **不能只让修复 Agent 自报。** `wave5-verify.md` 的验收输入**刻意不含**修复者的自报命令，只从 `finding_ref` 出发——让修复者自己声明「我改测试是合理的」违背这条独立验收原则。

**可行的方向（待验证）**：把「删除的断言」与「新增的断言」按**断言的语义对象**（`assertX(<target>, <expected>)` 里的 target 表达式）配对，而不是按行配对。
处 3 里 `getItems().get(0).getPrice()` 两侧都在 → 不是删除，是包裹。
处 1、2 里 `field("refreshTask")` / `field("scheduledPeriod")` 两侧都在，但 expected 从 `null`/`-1` 变成了 `before`/`20` → **这才是「断言被改反」的真实信号**，且它应当触发「要求 `TEST_CONFLICT` 声明 + 反编译级证据」，而不是直接 FAIL。

---

## 五、顺带核实的两件事

- **F1 的 `not a mapping` 分支是有测试的**：`ShopConfigCorruptFileTest.TRUNCATED_AT_ITEMS`（`items:` 值为 null）会让 `rawShop.get("items") instanceof Map` 为 false，正是 `ShopConfigLoader.java:125` 那条抛出。我一度以为它零覆盖，是错的。
- **`items: {}`（显式空 Map）被刻意判为合法**，仓库里有 5 处测试用它（`NpcManagerTest:417,440`、`ShopConfigCorruptFileTest:89,151`、`ShopGUITest:359`），代码注释也明说了。任何截断检测都不能把它一起拦掉。
- **源码文本断言（读 `.java` 比字符串）共 4 处 / 3 文件**：`AirdropSpawnGoalTest:287`、`CommandsDocumentConcurrencyTest:137`、`CommandsDocumentAtomicWriteTest:163,179`、`CommandsDocumentFallbackTest`。
  其中 `javadocStopsClaimingTheFalseInvariant` 是**刻意**的文本守卫（守的是注释本身），但它同时是「文本断言代替行为断言」的反例证据——两者在 diff 里长得一样。

---

## 六、基线本身

`937 tests / 0 failures / 0 errors / 1 skipped`（2026-11-17 02:50 复跑确认）。
那 1 个 skip 是 `YamlFilesTest` 用 `Assumptions.assumeTrue` 跳过的平台相关用例（`isPosix` 分支），不是被禁用的测试。
