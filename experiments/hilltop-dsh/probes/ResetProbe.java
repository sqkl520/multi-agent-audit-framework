/**
 * 验证 R3-B B-01：ArenaResetService 重置在第 8 步失败时，
 * 第 5 步已删掉的节点回不来，而 abort() 只恢复「启用」状态，
 * 留下「可开局但 0 节点」的场馆。
 *
 * 复刻自 ArenaResetService.java:
 *   :278 disableArena（实例已 DISABLED）
 *   :283-288 clearNodesForWorld（第 5 步，永久删节点）
 *   abort() :408 → reinstateRestoring() :430 → reinstate() :455（只恢复启用，不恢复节点）
 */
public class ResetProbe {

    static class Arena {
        boolean enabled = true;
        int nodes = 12;                 // 重置前有 12 个节点
        boolean deploymentData = true;
        public String toString() {
            return String.format("enabled=%s nodes=%d deployData=%s", enabled, nodes, deploymentData);
        }
    }

    /** 第 5 步：物理删除该世界的全部节点（不可逆，没有备份） */
    static int clearNodesForWorld(Arena a) { int n = a.nodes; a.nodes = 0; return n; }

    /** 第 8 步：清部署数据 —— 本探针让它失败 */
    static boolean clearDeploymentData(Arena a) { return false; }

    /** 复刻 reinstate()：只把竞技场放回启用队列，不碰节点 */
    static void reinstate(Arena a) {
        if (!a.deploymentData) { /* MISSING_CORE 之类 */ }
        a.enabled = true;
    }

    /** 复刻 abort() */
    static void abort(Arena a, String step) {
        reinstate(a);
    }

    public static void main(String[] args) {
        Arena a = new Arena();
        System.out.println("重置前:              " + a);
        System.out.println();

        // :278 最先把实例 disabled
        a.enabled = false;
        System.out.println("第 4 步 disableArena: " + a);

        // 第 5 步删节点
        int removed = clearNodesForWorld(a);
        System.out.println("第 5 步 删节点 " + removed + " 个:  " + a + "   ← 不可逆");

        // 第 8 步失败
        boolean ok = clearDeploymentData(a);
        System.out.println("第 8 步 clearDeploymentData: " + (ok ? "成功" : "**失败**"));
        if (!ok) {
            abort(a, "deployment-data");
            System.out.println("abort() → reinstate():       " + a);
        }

        System.out.println();
        boolean broken = a.enabled && a.nodes == 0;
        System.out.println(broken
            ? "❌ 确认缺陷：竞技场已恢复「启用」，但节点数是 0 —— 可开局，进去没有节点"
            : "✅ 未复现");

        if (broken) {
            System.out.println();
            System.out.println("关键：reinstate() 只做一件事——把它放回启用队列。");
            System.out.println("     第 5 步的 clearNodesForWorld 是不可逆的物理删除，没有备份、没有补偿。");
            System.out.println("     代码注释（:276-277）自己写「第 5/8 步都可能失败并中止——那两处中止负责把它恢复回去」，");
            System.out.println("     但「恢复回去」指的是启用状态，不是节点。");
        }
    }
}
