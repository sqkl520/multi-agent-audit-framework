/** 累积效应：反复异常会不会持续堆积刷新链？ */
import java.util.*;
public class TabProbe2 {
    static class Task { final int id; volatile boolean cancelled=false; Task(int i){id=i;} void cancel(){cancelled=true;} }
    static class Sched {
        List<Task> live=new ArrayList<>(); int next=1;
        Task runTaskTimer(){Task t=new Task(next++);live.add(t);return t;}
        int active(){return (int)live.stream().filter(t->!t.cancelled).count();}
    }
    public static void main(String[] a){
        Sched sch=new Sched(); Task refreshTask=null; int period=-1;
        // start()
        refreshTask=sch.runTaskTimer(); int scheduled=20; period=20;
        System.out.println("初始活跃任务 = "+sch.active());
        System.out.println();
        System.out.println("异常次数   活跃任务数");
        int booms=0;
        for(int frame=1;frame<=40;frame++){
            boolean boom = (frame%4==0);   // 每 4 帧异常一次
            if(boom){
                refreshTask=null; period=-1;   // catch 分支
                booms++;
            } else {
                if(!(refreshTask!=null && !refreshTask.cancelled && period==scheduled)){
                    if(refreshTask!=null){refreshTask.cancel();refreshTask=null;}
                    period=scheduled; refreshTask=sch.runTaskTimer();
                }
            }
            if(boom) System.out.printf("  %2d 次        %d%n", booms, sch.active());
        }
        System.out.println();
        System.out.println(sch.active()>1
            ? "❌ 累积成立：40 帧内 "+booms+" 次异常 → 活跃任务堆积到 "+sch.active()+" 条"
            : "✅ 未累积");
    }
}
