/**
 * 验证 R2-mechanics F1：TabListManager 异常后是否真的会产生两条刷新链。
 *
 * 复刻的关键语义（来自 TabListManager.java:143-157, 266-270, 293-301）：
 *   refreshAll() 内部 try/catch，异常时 refreshTask=null; scheduledPeriod=-1
 *   start(): if (refreshTask != null && !cancelled && period==scheduledPeriod) return;
 *            stopTask(); scheduledPeriod=period; refreshTask=runTaskTimer(...)
 *   stopTask(): if (refreshTask != null) { refreshTask.cancel(); refreshTask=null; }
 *
 * 问题：异常路径把 refreshTask 置 null，**没有 cancel 那个还在跑的 ticker**。
 * 下一帧 start() 看到 refreshTask==null → 早退条件不成立 → stopTask() 拿到 null
 * 什么也不做 → 新建一个 ticker。**旧 ticker 从未被 cancel。**
 */
import java.util.*;

public class TabProbe {

    static class Task {
        final int id; volatile boolean cancelled = false;
        Task(int id) { this.id = id; }
        void cancel() { cancelled = true; }
        boolean isCancelled() { return cancelled; }
    }

    static class Scheduler {
        List<Task> live = new ArrayList<>();
        int nextId = 1;
        Task runTaskTimer() { Task t = new Task(nextId++); live.add(t); return t; }
        List<Task> active() { return live.stream().filter(t -> !t.cancelled).toList(); }
    }

    static class TabListManager {
        final Scheduler sch;
        Task refreshTask = null;
        int scheduledPeriod = -1;
        int refreshes = 0;
        TabListManager(Scheduler s) { this.sch = s; }

        void stopTask() { if (refreshTask != null) { refreshTask.cancel(); refreshTask = null; } }

        void start(int period) {
            if (refreshTask != null && !refreshTask.isCancelled() && period == scheduledPeriod) return;
            stopTask();
            scheduledPeriod = period;
            refreshTask = sch.runTaskTimer();
        }

        /** 复刻 refreshAll()：内部 catch，异常时置 null 但不 cancel */
        void refreshAll(int period, boolean throwsThisTime) {
            try {
                if (throwsThisTime) throw new RuntimeException("模拟 refreshAllUnchecked 抛异常");
                refreshes++;
                // 正常路径里 period 变化会重排
                int p = period;
                if (p != scheduledPeriod) { start(p); }
            } catch (RuntimeException e) {
                refreshTask = null;
                scheduledPeriod = -1;
            }
        }
    }

    public static void main(String[] a) {
        System.out.println("场景：任务启动后第 3 帧抛一次异常，之后恢复");
        System.out.println();

        Scheduler sch = new Scheduler();
        TabListManager m = new TabListManager(sch);
        m.start(20);
        System.out.println("start() 后活跃任务数 = " + sch.active().size());

        for (int frame = 1; frame <= 8; frame++) {
            boolean boom = (frame == 3);
            m.refreshAll(20, boom);
            String mark = boom ? "  ← 抛异常" : "";
            System.out.printf("  帧 %d  活跃任务=%d  refreshTask=%s  scheduledPeriod=%d%s%n",
                frame, sch.active().size(),
                m.refreshTask == null ? "null" : "#" + m.refreshTask.id,
                m.scheduledPeriod, mark);
        }

        System.out.println();
        int n = sch.active().size();
        if (n > 1) {
            System.out.println("❌ 复现：活跃任务 " + n + " 条 —— 刷新链重复，tab 更新频率翻倍");
            System.out.println("   原因：异常路径置 null 但不 cancel，start() 的 stopTask() 拿不到旧句柄");
        } else {
            System.out.println("✅ 未复现：活跃任务 " + n + " 条");
        }
    }
}
