package com.hilltopvillage.shop;

import com.hilltopvillage.HilltopVillagePlugin;
import com.hilltopvillage.util.YamlFiles;
import org.bukkit.Material;
import org.bukkit.configuration.ConfigurationSection;
import org.bukkit.configuration.file.YamlConfiguration;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.yaml.snakeyaml.Yaml;

/**
 * 村民商店配置加载器（shop.yml）。
 * 首次运行释放默认模板，之后每次调用 load() 重新解析为 ShopConfig 快照。
 */
public class ShopConfigLoader {

    /** 合法商品类型 */
    private static final Set<String> VALID_TYPES = new HashSet<>(
            Arrays.asList("HAMMER", "FIREBALL", "REPAIR_ITEM", "MATERIAL", "EQUIPMENT"));

    /** GUI 允许的尺寸（Bukkit 箱子行数：9/18/27/36/45/54） */
    private static final List<Integer> VALID_GUI_SIZES = Arrays.asList(9, 18, 27, 36, 45, 54);

    /** fix5 M-10：本次加载已占用的 GUI 槽位（id → slot），重复槽位检测用 */
    private final java.util.Map<Integer, String> occupiedSlots = new java.util.HashMap<>();

    private final HilltopVillagePlugin plugin;

    public ShopConfigLoader(HilltopVillagePlugin plugin) {
        this.plugin = plugin;
    }

    /**
     * 加载 shop.yml 为 ShopConfig。
     * 配置缺失/非法的条目跳过并 warning，不阻断整体加载；
     * 但文件本身无法解析（损坏/截断），或 shop.items 存在但不是映射（截断常见形态）时抛异常，
     * 不得降级成空商店。
     */
    public ShopConfig load() {
        File file = new File(plugin.getDataFolder(), "shop.yml");
        if (!file.exists()) {
            plugin.saveResource("shop.yml", false);
        }
        YamlFiles.Loaded loaded = YamlFiles.load(file, null, plugin.getLogger());
        if (!loaded.usable()) {
            String detail = loaded.detail();
            throw new IllegalStateException("Cannot use shop.yml (" + loaded.status() + ")"
                    + (detail == null ? "" : ": " + detail)
                    + ". Refusing to replace the live shop with an empty configuration.");
        }
        YamlConfiguration yaml = loaded.config();

        // F1: a parseable truncation can leave `items:` with a null value. Bukkit drops null
        // values while converting the YAML map, so the key disappears from YamlConfiguration and
        // looks identical to an omitted key. Inspect the raw YAML only in that ambiguous case:
        // a present-but-null (or otherwise non-mapping) items value is a truncation. An explicit
        // `items: {}` is a Map and stays valid, and an omitted key keeps the existing behavior.
        if (yaml.getConfigurationSection("shop.items") == null) {
            Map<?, ?> rawShop = rawShopSection(file);
            if (rawShop != null && rawShop.containsKey("items")
                    && !(rawShop.get("items") instanceof Map)) {
                throw new IllegalStateException("shop.yml: 'shop.items' is present but is not a mapping"
                        + " (value: " + rawShop.get("items") + "); the file appears truncated."
                        + " Refusing to replace the live shop configuration.");
            }
        }

        // ---- 货币 ----
        Material currencyMaterial = Material.EMERALD;
        String currencyMatStr = yaml.getString("shop.currency.material");
        if (currencyMatStr != null && !currencyMatStr.isEmpty()) {
            Material parsed = Material.getMaterial(currencyMatStr);
            // fix6 Y2-06：非 item 材质会让 createCurrencyItem 的 new ItemStack 抛异常（掉币/退款链）
            if (parsed != null && parsed.isItem()) {
                currencyMaterial = parsed;
            } else {
                plugin.getLogger().warning("shop.yml: invalid currency material '"
                        + currencyMatStr + "' (unknown or not a carryable item), keeping default EMERALD");
            }
        }
        String currencyName = yaml.getString("shop.currency.name");
        if (currencyName != null && currencyName.isEmpty()) {
            currencyName = null;
        }

        // ---- NPC ----
        String npcName = yaml.getString("shop.npc.name");
        if (npcName != null && npcName.isEmpty()) {
            npcName = null;
        }

        // ---- GUI ----
        String guiTitle = yaml.getString("shop.gui.title");
        if (guiTitle != null && guiTitle.isEmpty()) {
            guiTitle = null;
        }
        int guiSize = clampGuiSize(yaml.getInt("shop.gui.size", 27));

        // ---- 商品列表 ----
        occupiedSlots.clear();
        List<ShopItem> items = new ArrayList<>();
        ConfigurationSection itemsSection = yaml.getConfigurationSection("shop.items");
        if (itemsSection != null) {
            for (String id : itemsSection.getKeys(false)) {
                ShopItem item = parseItem(yaml, id, guiSize);
                if (item != null) {
                    items.add(item);
                }
            }
        }

        return new ShopConfig(currencyMaterial, currencyName, npcName, guiTitle, guiSize, items);
    }

    /**
     * 重新读取原始 YAML 的 shop 段。仅用于区分「没有 items 键」与「items 键值为 null」：
     * 后者在 Bukkit 转换时会被丢弃，{@link YamlConfiguration} 已经看不到它。
     */
    private Map<?, ?> rawShopSection(File file) {
        try {
            Object root = new Yaml().load(Files.readString(file.toPath(), StandardCharsets.UTF_8));
            if (root instanceof Map<?, ?> rootMap) {
                Object shop = rootMap.get("shop");
                if (shop instanceof Map<?, ?> shopMap) {
                    return shopMap;
                }
            }
            return null;
        } catch (IOException | RuntimeException failure) {
            throw new IllegalStateException("shop.yml could not be inspected for a truncated"
                    + " 'shop.items' section: " + failure.getMessage(), failure);
        }
    }

    /** 解析单个商品，非法条目返回 null 并 warning */
    private ShopItem parseItem(YamlConfiguration yaml, String id, int guiSize) {
        String path = "shop.items." + id;

        String type = yaml.getString(path + ".type", "");
        if (!VALID_TYPES.contains(type)) {
            plugin.getLogger().warning("shop.yml: item '" + id + "' has unknown type '" + type
                    + "' (valid: HAMMER/FIREBALL/REPAIR_ITEM/MATERIAL/EQUIPMENT), skipped");
            return null;
        }

        Material icon = Material.BARRIER;
        boolean iconConfigured = false;
        String iconMatStr = yaml.getString(path + ".icon.material");
        if (iconMatStr != null && !iconMatStr.isEmpty()) {
            Material parsed = Material.getMaterial(iconMatStr);
            // fix6 Y2-06：非 item 材质放行会让 ShopGUI:72 的 new ItemStack(icon) 先抛 → 整个商店 GUI
            // 打不开（MATERIAL/EQUIPMENT 发货链同抛）；跳过该条目比放行更正确，与未知材质行为对齐
            if (parsed == null || !parsed.isItem()) {
                plugin.getLogger().warning("shop.yml: item '" + id + "' has invalid icon material '"
                        + iconMatStr + "' (unknown or not a carryable item), skipped");
                return null;
            }
            icon = parsed;
            iconConfigured = true;
        }
        // EQUIPMENT 的发货材质 = icon.material（GUI 图标同），MATERIAL 的 GUI/发货图标同：
        // 缺省 BARRIER 会发出/显示屏障方块，属明确误配，直接 skip 而不是静默发错东西
        if (("EQUIPMENT".equals(type) || "MATERIAL".equals(type)) && !iconConfigured) {
            plugin.getLogger().warning("shop.yml: " + type + " item '" + id
                    + "' is missing icon.material, skipped");
            return null;
        }
        if ("EQUIPMENT".equals(type) && !icon.isItem()) {
            plugin.getLogger().warning("shop.yml: EQUIPMENT item '" + id + "' icon material '"
                    + icon.name() + "' is not a carryable item, skipped");
            return null;
        }

        // fix3 F3：缺键 / 显式 null 与 price: 0 不能混为一谈——getInt(...,1) 会把前者静默变成
        // 1 货币。缺价是误配，跳过并点名；0 仍是有意免费，负数仍走下面的钳制分支。
        // 放在槽位登记之前：被跳过的条目不应占用槽位，否则会误报槽位冲突。
        if (!yaml.isSet(path + ".price")) {
            plugin.getLogger().warning("shop.yml: item '" + id
                    + "' is missing price (key absent or null), skipped");
            return null;
        }

        int slot = yaml.getInt(path + ".slot", -1);
        if (slot < 0 || slot >= guiSize) {
            // fix5 M-17：1.1.0 新模板按 54 格分区布局（护甲区槽位 27-53）；旧盘若仍是
            // gui.size: 27，按新模板补加的商品会全部落在这里被跳过。warning 补上升级指引，
            // 让「为什么全被跳过」在日志里自答。
            // fix5 锐评 C-18：升级指引仅在 gui.size 确实小于 54 时附加——gui.size 已是 54
            // 却 slot 越界（如 slot 60）是配置写错而非旧盘升级场景，提示旧值只会误导。
            plugin.getLogger().warning("shop.yml: item '" + id + "' slot " + slot
                    + " out of GUI size " + guiSize + ", skipped"
                    + (guiSize < 54 ? " (the full 1.1.0 item layout needs gui.size: 54; check whether gui.size at the top of this file is an old value)" : ""));
            return null;
        }

        String occupiedBy = occupiedSlots.putIfAbsent(slot, id);
        if (occupiedBy != null) {
            // fix5 M-10：槽位冲突会让 ShopGUI 的 setItem/bySlot 静默覆盖（后者胜出），
            // 先到的商品在 GUI 上完全消失且无日志。这里明确告警指出双方 id，
            // 保留两件商品（GUI 最终行为仍为后者覆盖），服主据此修正配置。
            plugin.getLogger().warning("shop.yml: item '" + id + "' slot " + slot
                    + " conflicts with item '" + occupiedBy + "' (later item wins in GUI), please fix slots");
        }

        int price = yaml.getInt(path + ".price", 1);
        // 负数价格会被 removeCurrency 直接判为「无需扣除」（amount <= 0 时返回 true），
        // 于是变成「免费发货」——服主误配 -1 就会白送商品。钳到 0 并明确告警，
        // 让 0（有意免费）与负数（误配）分得开，也不至于让整个条目被 skip 掉。
        if (price < 0) {
            plugin.getLogger().warning("shop.yml: item '" + id + "' has negative price " + price
                    + ", clamped to 0 (free)");
            price = 0;
        }
        int amount = yaml.getInt(path + ".amount", 1);
        // fix4 F4：deliverItem 会把非正数量钳成 1 发货，但购买仍按整价扣费——显式 0/负数必须在加载期跳过。
        if (amount <= 0) {
            plugin.getLogger().warning("shop.yml: item '" + id + "' has invalid amount " + amount
                    + " (must be at least 1), skipped");
            return null;
        }

        String name = yaml.getString(path + ".name");
        if (name != null && name.isEmpty()) {
            name = null;
        }
        List<String> lore = yaml.getStringList(path + ".lore");
        if (lore.isEmpty()) {
            lore = null;
        }

        // 是否不可破坏（仅 EQUIPMENT 生效；不配置 = 普通耐久）
        boolean unbreakable = yaml.getBoolean(path + ".unbreakable", false);

        return new ShopItem(id, slot, price, type, amount, icon, name, lore, unbreakable);
    }

    /** GUI 尺寸校验：合法值原样返回；非法值钳制到不超过原值的最大档（全小则 9）并 warning */
    private int clampGuiSize(int size) {
        if (VALID_GUI_SIZES.contains(size)) {
            return size;
        }
        int clamped = 9;
        for (int valid : VALID_GUI_SIZES) {
            if (size >= valid) {
                clamped = valid;
            }
        }
        plugin.getLogger().warning("shop.yml: invalid GUI size " + size
                + " (valid: 9/18/27/36/45/54), falling back to " + clamped);
        return clamped;
    }
}
