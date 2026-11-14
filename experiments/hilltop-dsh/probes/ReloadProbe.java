/**
 * 验证：ConfigManager.loadFromFile() 无条件重建 activeConfig，
 * 会静默丢弃管理员未保存的修改。
 *
 * 复刻自 ConfigManager.java:1340 `activeConfig = new GameConfig();`
 * 与 MainConfigMenu.java:149-153 的重载入口（无 hasUnsavedChanges 检查）。
 */
import java.util.*;

public class ReloadProbe {

    static class GameConfig {
        String worldName = "world";   // 出厂默认
        int victoryWaves = 10;
        GameConfig copy() { GameConfig g = new GameConfig(); g.worldName = worldName; g.victoryWaves = victoryWaves; return g; }
        public String toString() { return "world=" + worldName + ", waves=" + victoryWaves; }
    }

    static class ConfigManager {
        GameConfig activeConfig = new GameConfig();
        GameConfig lastSavedSnapshot = activeConfig.copy();

        GameConfig getActiveConfig() { return activeConfig; }

        void setWorldName(String v) { activeConfig.worldName = v; }   // 管理员在 GUI 改，未保存
        boolean hasUnsavedChanges() {
            return !activeConfig.toString().equals(lastSavedSnapshot.toString());
        }

        /** 复刻 :1298-1340：无条件重建对象 */
        void loadFromFile() {
            // 真实实现前面有「文件不可用 → 保留内存值并提前返回」的分支，
            // 但文件**可用**时会走到这里，无任何 hasUnsavedChanges 判断。
            activeConfig = new GameConfig();          // ← :1340
            lastSavedSnapshot = activeConfig.copy();
        }
    }

    public static void main(String[] a) {
        ConfigManager cm = new ConfigManager();
        System.out.println("初始:            " + cm.getActiveConfig());

        cm.setWorldName("my-custom-world");           // 管理员在 GUI 里改了，还没点保存
        System.out.println("管理员改动后:    " + cm.getActiveConfig());
        System.out.println("有未保存改动?    " + cm.hasUnsavedChanges());
        System.out.println();

        // 点「重载」—— MainConfigMenu:149-153，无条件调用
        System.out.println("--- 点击重载（MainConfigMenu:149 无条件调用）---");
        cm.loadFromFile();

        System.out.println("重载后:          " + cm.getActiveConfig());
        System.out.println("改动还在吗?      " + cm.getActiveConfig().worldName.equals("my-custom-world"));
        System.out.println("界面提示:        「配置已重载」(reloaded-msg，无条件发送)");
        System.out.println();

        boolean lost = !cm.getActiveConfig().worldName.equals("my-custom-world");
        System.out.println(lost
            ? "❌ 确认缺陷：未保存的修改被静默丢弃，且提示「已重载」让管理员以为一切正常"
            : "✅ 未复现");

        if (lost) {
            System.out.println();
            System.out.println("对比：同类操作在其他位置是有保护的——");
            System.out.println("  ConfigManager:307 有 hasUnsavedChanges() 但重载入口没调");
            System.out.println("  ConfigManager:1338 注释自己写「不能因为重建而把管理员的未保存修改清掉」");
            System.out.println("  ——那条保护只覆盖了「文件不可用」分支，文件可用时照样清");
        }
    }
}
