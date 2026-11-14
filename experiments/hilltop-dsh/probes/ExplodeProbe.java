/**
 * 验证 R2-AI-001：explode-damage-multiplier 一处当「节点伤害倍率」相乘，
 * 一处当 Bukkit 爆炸 power 直接使用。同一个值两种语义。
 *
 * 复刻自 ExplodeBeetleGoal.java:
 *   :226-229  explodeMultiplier = max(0, cfg.getExplodeDamageMultiplier())
 *             nodeDamage = baseDamage * explodeMultiplier * nodeMultiplier
 *   :233-242  if (!isEntityExplosion) { 纯粒子 } else { createExplosion(loc, (float)explodeMultiplier, ...) }
 * 与 GameConfig.java:
 *   :292 字段注释「自爆对节点伤害倍率」
 *   :294 entityExplosion 默认 true  ← 默认走 createExplosion
 * 与 MonsterSettingsMenu.java:203 GUI 允许 0.5 ~ 10
 */
public class ExplodeProbe {

    // Bukkit createExplosion(power) 的爆炸半径经验公式：半径 ≈ power * 2（1.14+ 每 power 2 格）
    static double blastRadius(double power) { return power * 2.0; }
    // 爆炸对实体的最大伤害 ≈ power * 7（近距离，无遮挡）
    static double blastMaxDamage(double power) { return power * 7.0; }

    public static void main(String[] a) {
        double baseDamage = 4.0;      // 典型怪物 ATTACK_DAMAGE
        double nodeMultiplier = 1.0;  // 节点自毁倍率默认

        System.out.println("配置字段注释：GameConfig:292「自爆对节点伤害倍率」");
        System.out.println("默认 entityExplosion = true → 默认走 createExplosion 分支");
        System.out.println("GUI 允许范围：0.5 ~ 10（MonsterSettingsMenu:203）");
        System.out.println();
        System.out.printf("%-8s %-14s %-14s %-12s %s%n",
            "配置值", "节点伤害(乘)", "爆炸半径", "爆炸最大伤害", "两者的关系");
        System.out.println("-".repeat(80));

        for (double m : new double[]{0.5, 1.0, 2.0, 5.0, 10.0}) {
            double nodeDamage = baseDamage * m * nodeMultiplier;
            double radius = blastRadius(m);
            double maxDmg = blastMaxDamage(m);
            String rel = (m == 1.0)
                ? "1.0 时两者恰好都等于基准"
                : String.format("半径放大 %.0f 倍，伤害放大 %.2f 倍", radius / 2.0, maxDmg / 4.0);
            System.out.printf("%-8.1f %-14.1f %-14.1f %-12.1f %s%n",
                m, nodeDamage, radius, maxDmg, rel);
        }

        System.out.println();
        System.out.println("问题：字段说它管的是「节点伤害」，但 m 同时决定了爆炸的物理范围与对实体的伤害。");
        System.out.println("      m=10 时节点伤害是 40（合理），但会在周围 20 格造成最大 70 点伤害——");
        System.out.println("      而代码注释（:234-235）在「纯视觉自爆」分支明写「节点旁的村民/玩家不受波及」；");
        System.out.println("      默认的 entityExplosion=true 分支恰恰会波及。两条分支的安全承诺不一致。");
        System.out.println();
        System.out.println("关键：GUI 把 0.5~10 当作「倍率」呈现给管理员，管理员按倍率理解去调，");
        System.out.println("      实际同时放大了爆炸半径——这不是他能从这个滑块名预期到的。");
    }
}
