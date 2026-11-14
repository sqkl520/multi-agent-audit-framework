# 裁决：R2-AI-002（airdrop-mob-type NPE）到底成不成立

**方法**：写 JUnit 测试，用**真实的 `YamlConfiguration`** 取真实输入，跑真实代码路径。
不靠推演、不靠反编译猜测。

测试文件（已写入项目，可复跑）：
- `src/test/java/com/hilltopvillage/config/AirdropMobTypeNullabilityTest.java`
- `src/test/java/com/hilltopvillage/config/YamlNullMechanismTest.java`
- `src/test/java/com/hilltopvillage/ai/AirdropMobTypeNpeReachabilityTest.java`

---

## 结论：两条审计结论各错一半

| 主张 | 谁说的 | 裁决 |
|---|---|---|
| 「留空键 → NPE，每 tick 重试」 | 静态审计 R2-AI-002 | **触发条件错**。留空 → `contains=false` → 走默认值 `"ZOMBIE"`，不触发 |
| 「`contains()` 与 `getString()` 互斥，NPE 不可达」 | 批判复核 | **互斥性是错的**。`"null"` 字符串打破互斥 |
| **NPE 可达，条件是带引号写 `"null"`** | 我的实测 | ✅ 成立 |

---

## 实测证据

### 1. `contains` 与 `getString` 不互斥

```
airdrop-mob-type: "null"   raw=String:null   contains=true   getString=null
airdrop-mob-type: 'null'   raw=String:null   contains=true   getString=null
airdrop-mob-type: ""       raw=String:      contains=true   getString=
airdrop-mob-type: ~        raw=null         contains=false  getString=null
airdrop-mob-type:          raw=null         contains=false  getString=null
```

**批判 agent 断言**：

> 「`MemorySection.contains(String)` 的反编译：`return get(path) != null`——
> 实现就是判空！所以 `contains == true` 时 `getString` 不可能返回 null。」

**这个反编译读得没错，但推论错了。** `contains` 用的 `get()` 返回的是 `String("null")` 对象（非 null），
而 `getString()` 内部还有一层：**当字符串字面量等于 `"null"` 时返回 Java null**。
两个方法走不同的取值路径，所以「互斥」不成立。

### 2. NPE 真的会抛出

```
从 YAML 取到的值: null
抛出: NullPointerException
→ NPE 逃出了 catch(IllegalArgumentException)
```

`:237` 的 `mobTypeName.toUpperCase()` 在 null 上抛 NPE，`:238` 只 catch `IllegalArgumentException`，兜不住。

### 3. 对照组：留空和拼写错误都正常

```
留空键     → 走默认 ZOMBIE → 抛出: 无
拼写错误   → 回退到 ZOMBIE（IAE 被正确捕获，防御有效）
```

---

## 所以该不该修？

**该修，但优先级低于原报告的说法。**

- 原报告说「留空就触发」→ **不成立**，管理员把键留空是安全的
- 但「写 `"null"`」**是可达的**，而且这种写法在 YAML 里不算离谱（有人会用它表达「不设值」）
- 后果：NPE 逃出 → 清理代码不可达 → goal 重复失败

**不过批判 agent 也指出了一点值得采信**：即使 NPE 抛出，Paper 的 `guardEntityTick` 会 `entity.discard()`，
所以后果是「这只怪消失」而非「每 tick 刷屏」。这点我没能独立验证（需要真跑 Paper 服务端），
**按未验证处理，不写进结论**。

---

## 修复建议

最小改动、语义最清楚：

```java
// AirdropSpawnGoal.java:234 之前加一行
if (mobTypeName == null || mobTypeName.isBlank()) mobTypeName = "ZOMBIE";
```

**为什么不用 `catch (RuntimeException)`**：那会吞掉本该暴露的编程错误。
**为什么不在上游 ConfigManager 修**：`getString` 返回 null 是 Bukkit 的既定行为，
在所有读配置的地方都加判断成本太大。在下游消费点兜底更局部。
