/**
 * 验证 R2-AI-002：airdrop-mob-type 为空时 NPE 逃出，且清理代码不可达，
 * 导致 goal 每 tick 重复失败、永久不结束。
 *
 * 复刻自 AirdropSpawnGoal.java:
 *   :234 String mobTypeName = monsterCfg != null ? monsterCfg.getAirdropMobType() : "ZOMBIE";
 *   :237 mobType = EntityType.lookup(mobTypeName.toUpperCase(Locale.ROOT));
 *   :238 catch (IllegalArgumentException e) { mobType = ZOMBIE; }
 *   :135-137 if (arrived) { executeAirdrop(); targetDropLocation = null; }
 */
import java.util.*;

public class NpeProbe {

    enum EntityType {
        ZOMBIE("ZOMBIE");
        final String n;
        EntityType(String n) { this.n = n; }
        static EntityType lookup(String s) {
            if (!s.equals("ZOMBIE")) throw new IllegalArgumentException("No enum constant " + s);
            return ZOMBIE;
        }
    }

    /** 模拟 MonsterConfig.getAirdropMobType() 可能返回 null */
    static String airdropMobType;

    static boolean goalActive = true;
    static int arrivals = 0;
    static int airdropsCompleted = 0;
    static List<String> errors = new ArrayList<>();

    /** 复刻 executeAirdrop() 的 :234-239 —— 注意 :238 只 catch IAE */
    static void executeAirdrop() {
        String mobTypeName = airdropMobType;             // 可能为 null
        EntityType mobType;
        try {
            mobType = EntityType.lookup(mobTypeName.toUpperCase(Locale.ROOT));   // NPE 在这里
        } catch (IllegalArgumentException e) {           // 只捕 IAE，NPE 逃出
            mobType = EntityType.ZOMBIE;
        }
        airdropsCompleted++;
    }

    /** 复刻 tick() 的 :135-137 */
    static void tick(boolean arrived) {
        if (!arrived) return;
        try {
            executeAirdrop();
            // ↓ 只有 executeAirdrop 正常返回才执行得到
            goalActive = false;                          // 模拟 targetDropLocation = null
        } catch (RuntimeException e) {
            errors.add(e.getClass().getSimpleName() + ": " + e.getMessage());
            // 注意：真实代码里这里**没有任何 catch**——异常直接抛给 Bukkit 调度器，
            // goalActive / targetDropLocation 都没被清，所以下一 tick 会再来一次。
            // 探针为了能继续观察，才在这里接住。
        }
    }

    public static void main(String[] a) {
        System.out.println("场景：monsters.flying-dropper.airdrop-mob-type 留空");
        System.out.println("（ConfigManager.java:1645 用 getString() 读取，键存在但值为空 → null）");
        System.out.println();

        airdropMobType = null;

        for (int t = 1; t <= 5; t++) {
            tick(true);      // 每 tick 都到达投放点
            System.out.printf("tick %d: goalActive=%s  累计异常=%d  完成空投=%d%n",
                t, goalActive, errors.size(), airdropsCompleted);
        }

        System.out.println();
        System.out.println("异常类型: " + (errors.isEmpty() ? "-" : errors.get(0)));
        System.out.println();

        boolean stuck = goalActive && errors.size() == 5 && airdropsCompleted == 0;
        System.out.println(stuck
            ? "❌ 确认缺陷：NPE 逃出 IAE 的 catch，清理不可达，goal 永远 active，每 tick 重试一次"
            : "✅ 未复现");

        System.out.println();
        System.out.println("--- 对照：如果 mob-type 是个合法但未知的字符串 ---");
        airdropMobType = "NOT_A_MOB";
        errors.clear(); goalActive = true; airdropsCompleted = 0;
        tick(true);
        System.out.printf("tick 1: goalActive=%s  累计异常=%d  完成空投=%d%n",
            goalActive, errors.size(), airdropsCompleted);
        System.out.println("（IAE 被正确捕获 → 回退 ZOMBIE → goal 正常结束）");
        System.out.println();
        System.out.println("区别只在 mobTypeName 是「非法字符串」还是「null」——前者被兜住，后者逃逸。");
    }
}
