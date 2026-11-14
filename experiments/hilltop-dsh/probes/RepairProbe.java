/**
 * 复现 Hilltop Village 的修复结算缺陷（R2-mechanics F2）。
 *
 * 复刻自 NodeListener.java:224-232 与 NodeSystem.java:641-646：
 *   - repairNode(loc, player, repairAmount())  ← 只传「每消耗一个物品的恢复量」
 *   - repairNode 内部 node.repair(repairAmount)  ← 只加一次
 *   - 之后扣 repairCostAmount() 个物品       ← 可能扣多个
 *
 * 期望（按 GameConfig.java:119 的字段语义「每消耗 1 个修复物品恢复的生命值」）：
 *   恢复量 = repairAmountPerCost × 消耗物品数
 * 实际：恢复量恒等于 repairAmountPerCost × 1
 */
public class RepairProbe {

    // 复刻 NodeData.repair：把 amount 加到当前生命值，封顶 maxHealth
    static class Node {
        double health; final double maxHealth;
        Node(double h, double max) { health = h; maxHealth = max; }
        void repair(double amt) { health = Math.min(maxHealth, health + amt); }
    }

    /** 复刻 NodeListener:224-232 的结算顺序 */
    static void settle(Node node, double repairAmountPerCost, int repairCostAmount, int[] itemAmount) {
        // :224 只传一份
        node.repair(repairAmountPerCost);
        // :227-232 扣 cost 份
        int cost = repairCostAmount;
        if (itemAmount[0] > cost) itemAmount[0] -= cost;
        else itemAmount[0] = 0;
    }

    public static void main(String[] a) {
        System.out.println("场景                               总恢复   期望恢复   物品剩余  判定");
        System.out.println("-".repeat(88));

        // 场景 1：cost=1（默认），应当一致
        run("cost=1（默认配置）", 50.0, 1, 10, 0, 1000);

        // 场景 2：cost=5，玩家有 10 个
        run("cost=5，玩家有 10 个", 50.0, 5, 10, 0, 1000);

        // 场景 3：cost=5，但血量只差 30（少修复但照扣 5 个）
        run("cost=5，节点只差 30 血", 50.0, 5, 10, 0, 30);

        // 场景 4：cost=0 —— 免费修复
        run("cost=0（免费修复）", 50.0, 0, 10, 0, 1000);

        // 场景 5：cost=-1 —— 物品反增
        run("cost=-1（物品反增）", 50.0, -1, 10, 0, 1000);
    }

    static void run(String label, double perCost, int cost, int startItems, int startHp, double maxHp) {
        Node n = new Node(startHp, maxHp);
        int[] items = { startItems };
        double before = n.health;
        settle(n, perCost, cost, items);
        double healed = n.health - before;
        // 按契约语义，消耗了几个就该恢复几份
        int consumed = Math.min(startItems, cost);
        double expected = perCost * consumed;

        String verdict;
        if (Math.abs(healed - expected) < 1e-9) verdict = "✅ 一致";
        else if (cost <= 0) verdict = "❌ 语义违背（消耗 " + consumed + " 个）";
        else verdict = String.format("❌ 少恢复 %.0f（消耗 %d 个只恢复 1 份）", expected - healed, consumed);

        System.out.printf("%-34s %6.0f   %6.0f    %4d 个    %s%n",
            label, healed, expected, items[0], verdict);
    }
}
