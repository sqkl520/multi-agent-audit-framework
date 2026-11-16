# 教训：追踪状态 vs 消除状态

**时间**：2026-11-17
**场景**：修「付了对价的掉落物被原版并物事件抹掉标记 → 玩家付了钱拿不到货」

---

## 我选错的方案

把 `PAID_DROP_KEY` 从 **Item 实体 PDC** 挪到 **ItemStack PDC**。

理由（当时看起来成立）：原版合并用 `copyWithCount` 重建栈，
**components 会被拷贝**，所以标记应该能活过合并。

## 为什么错

评审给出的字节码证据（`paper-1.21.4.jar`，`ItemEntity#merge`）：

```
809  private static void merge(ItemEntity this, ItemStack thisStack, ItemEntity other, ItemStack otherStack);
809-819: merge(this, thisStack, otherStack, 64) → this.setItem(merged)
845-847: other.discard(EntityRemoveEvent.Cause.MERGE)
```

`copyWithCount` 拷贝的是**存活方（`this`）**的 components。
所以：

| 谁是 `this` | 结果 |
|---|---|
| 已付款的掉落物 | 标记保留 ✅ |
| **普通掉落物** | **存活实体只带普通栈，标记没了** ❌ |

**我的方案只修好了一半，而且是最不容易触发的那一半。**

测试直接证明了这一点：

```
付过钱的掉落物作为被合并方（other / getEntity）消失时，key 必须转移到存活实体上。
当前存活实体：[BOWx1[PAID], BOWx1[plain]] ==> expected: <true> but was: <false>
```

## 评审早就给了根本修法

`finding-F5.md` §2.3 结尾，就在我读过的同一份文档里：

> 或更简单——**不要让付过钱的货以实体形式存在**：
> 背包满时直接拒绝购买（`if (!overflow.isEmpty()) { refundCurrency(...); return; }`），
> **把「钱货分离」这个状态从根上消掉**。

我读过那句话，但选了另一条路。**因为「挪 key」听起来更小、更局部、更不像改行为。**

## 判据

**当一个状态（「付了钱但货在地上」）需要被追踪时，先问能不能不让它产生。**

追踪的方案有三个必然代价：
1. **覆盖不完整**：每个产生点、每个转移路径、每个消灭路径都要处理——漏一个就是漏洞
2. **测试难写**：要模拟原版行为（合并、拾取、despawn），而这些在 MockBukkit 里常常不可控
3. **新状态引入新 bug**：标记本身成了需要维护的东西

**消除的方案只有一个代价**：可能的误拒（本来能买的说不能买）。
而那个代价是**可见的、可调的、可道歉的**——比「偶尔吞掉玩家的钱」好得多。

## 这条教训属于哪一类

和 `PRECEDENTS.md` 记的是同一类东西：**项目里已有的做法比新创的更好**。

只不过这次不是「项目里已有」，是「同一份评审文档里已有」。
**我读了，但没采纳，因为它不像是正确答案的样子。**

> **评估方案的标准不是「改动小」，是「状态是否还需要被管理」。**
