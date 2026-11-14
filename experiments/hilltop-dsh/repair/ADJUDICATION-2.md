# 裁决：Paper 的 CraftScheduler 会不会取消抛异常的周期任务

**方法**：从真实的 `paper-1.21.4-232.jar`（51MB，服务器实际使用的）中提取
`versions/1.21.4/paper-1.21.4.jar`，再从中取出 `org/bukkit/craftbukkit/scheduler/CraftScheduler.class`，
用 `javap -p -c` 反编译 `mainThreadHeartbeat()` 的完整字节码。

**不是读别人写的反编译报告，是我自己跑出来的字节码。**

---

## 结论：**不会取消。周期任务抛异常后会重新入队。**

---

## 字节码证据

```java
public void mainThreadHeartbeat();
  ...
  103: aload_0
  104: aload_2
  105: putfield      #95   // currentTask = task
  108: aload_2
  109: invokevirtual #357  // task.run()          ← 执行任务
  112: aload_0
  113: aconst_null
  114: putfield      #95   // currentTask = null   ← 正常路径清空
  117: goto          225
  ...
  Exception table:
       from    to  target type
         108   112   120   Class java/lang/Throwable   ← 捕获 Throwable
         108   112   215   any                          ← finally
         120   207   215   any
         215   217   215   any

  // 异常处理分支：
  120: astore_3                                     // 保存异常
  121: ldc_w  "Task #%s for %s generated an exception"
  158-172: plugin.getLogger().log(WARNING, msg, ex)  // 记日志
  176-202: Bukkit.getServer().getPluginManager()
              .callEvent(new ServerExceptionEvent(...))   // 发事件
  207: aload_0; aconst_null; putfield currentTask   // 清空 currentTask
  212: goto 225

  // 汇合点：
  225: parsePending()
  229: goto 250

  250: task.getPeriod() → lstore_3
  255: lload_3
  256: lconst_0
  257: lcmp
  258: ifle 283                    ← period <= 0 才跳到移除分支
  261-269: task.setNextRun(currentTick + period)
  272-274: pending.add(task)      ← **period > 0 时重新入队**
  280: goto 305

  283: task.isSync()
  287: ifeq 305
  290-301: runners.remove(taskId)  ← **只有 period <= 0 才从 runners 移除**
```

**关键点**：异常分支在 `207` 清空 `currentTask` 后 `goto 225`，
而 `225` 之后的流程和正常路径**汇合**，两者都走到 `250` 的周期判断。
周期任务（`period > 0`）在 `272-274` **被重新加回 `pending` 队列**。

**从头到尾没有任何 `cancel()` 调用。**

---

## 这裁决了两件事

### 1. `TabListManager` 的 javadoc 是错的

`TabListManager.java:150-152` / `:286-290`：

> 「`CraftScheduler` 对抛未捕获异常的重复任务会记录一次并**静默取消它**」

**这个前提是错的。** 记录一次是对的（`logger.log(WARNING, ...)`），但**不取消**。

### 2. `TabListManagerTest.refreshFailureIsContained` 的断言消息也是错的

该测试的断言消息：

> 「异常路径必须把句柄置空：**CraftScheduler 会静默取消抛异常的重复任务**，
> 留着旧句柄会让 start() 永远早退（slice-11-concurrency-001 的成因）」

**测试把一个错误前提编码成了期望行为。**

---

## 但这改变了修复方案吗？——没有，反而更简单

原以为需要纠结「在任务体内 cancel 自己安不安全」。现在：

- **异常路径不需要 cancel 任何东西**——任务本来就会继续跑
- 真正要做的只有一件：**不要清空句柄**

因为清空句柄 → 下一帧 `start()` 看到 `refreshTask == null` → 新建一条 →
**而旧的那条还在跑**（因为它从未被取消，Paper 刚刚把它重新入队了）→ 两条并行。

**规划 agent 的方案 A（catch 里什么都不做，保留句柄）是对的，而且理由比我原本想的更硬**：

> 异常本来就没被调度器看见（在 `refreshAll` 内部被 catch 了），任务本身是健康的，
> 下个周期会照常跑，失败条件消失后自然恢复。

---

## 与两个 agent 的交叉核对

| 主张 | 规划 agent | 批判 agent | 我的字节码 |
|---|---|---|---|
| Paper 不取消抛异常的周期任务 | ✅ 认为需要修（因为会累积） | ✅ 明确指出（`from 108 to 112 target 120` 后重新入队） | ✅ **字节码坐实** |
| catch 不可达 | 未明确 | ✅ 认为 `refreshAllUnchecked` 无可抛路径 | 未验证（需要逐个审 `refreshAllUnchecked`） |
| 修法 | catch 里不再置空 | 只改注释（认为不是缺陷） | **倾向规划 agent**——见下 |

**为什么倾向「修代码」而不只是「改注释」**：

批判 agent 说 catch 不可达所以不算缺陷。但：

1. `refreshAllUnchecked` 里调用了 `start()`，而 `start()` 里有 `Bukkit.getScheduler().runTaskTimer(...)` —— **这个调用在服务器 shutdown 时可能抛 `IllegalPluginAccessException`**
2. 即使当前不可达，**代码写在那里就表达了作者的意图**，而那个意图建立在错误前提上
3. 规划 agent 说得对：**保留句柄是成本最低且语义最正确的解**——改成不置空，代码和真实机制一致，且未来 catch 真被触发时行为也是对的

**改法只需删两行。**

---

## 复现

```bash
JAVA=$(ls -d /d/Java/*21*/bin | head -1)
cd /tmp && rm -rf pchk && mkdir pchk && cd pchk
"$JAVA/jar" xf "/d/Server/<TARGET_PARENT>/Hilltop Village/versions/1.21.4/paper-1.21.4.jar" \
  org/bukkit/craftbukkit/scheduler/CraftScheduler.class
"$JAVA/javap" -p -c org/bukkit/craftbukkit/scheduler/CraftScheduler.class | \
  sed -n '/public void mainThreadHeartbeat/,/Exception table/p'
```
