package com.hilltopvillage.shop;

import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.File;
import java.io.IOException;

import org.bukkit.Material;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import com.hilltopvillage.testsupport.BareHost;
import com.hilltopvillage.testsupport.MockBukkitTestBase;

/**
 * F1 regression: an unparseable {@code shop.yml} must not become a valid empty shop.
 *
 * <p>{@code YamlConfiguration.loadConfiguration(File)} logs and swallows parse errors, returning an
 * empty configuration. Before the fix, {@link ShopConfigLoader#load()} therefore returned a normal
 * {@link ShopConfig} with no items, silently replacing a working shop after {@code /hilltop shop reload}.
 * The loader must fail visibly instead, and {@link ShopManager#reload()} must leave the previous
 * snapshot untouched when that failure escapes.</p>
 */
class ShopConfigCorruptFileTest extends MockBukkitTestBase {

    /** YAML with an unclosed flow sequence: SnakeYAML must reject this, not parse it as empty. */
    private static final String CORRUPT_SHOP_YML = """
            shop:
              items:
                broken: [unclosed
            """;

    private BareHost host;
    private ShopConfigLoader loader;
    private File shopFile;

    @BeforeEach
    void setUp() {
        host = loadBareHost();
        loader = new ShopConfigLoader(host);
        shopFile = new File(host.getDataFolder(), "shop.yml");
    }

    @Test
    @DisplayName("F1: invalid shop.yml throws a descriptive failure instead of returning an empty ShopConfig")
    void corruptFileDoesNotReturnEmptyShop() throws IOException {
        TestPaths.write(shopFile, CORRUPT_SHOP_YML);

        IllegalStateException failure = assertThrows(IllegalStateException.class, loader::load,
                "A corrupt shop.yml must fail visibly; returning an empty ShopConfig silently replaces "
                        + "a working shop with nothing");

        String message = failure.getMessage();
        assertNotNull(message, "The parse failure must carry a diagnostic message");
        assertTrue(message.contains("shop.yml"),
                "The failure must identify the offending file so the admin can act on it: " + message);
    }

    @Test
    @DisplayName("F1: failed reload keeps the last valid ShopConfig snapshot")
    void corruptReloadKeepsPreviousConfig() throws IOException {
        TestPaths.write(shopFile, """
                shop:
                  currency:
                    material: DIAMOND
                  gui:
                    size: 27
                  items: {}
                """);
        ShopManager shop = new ShopManager(host);
        shop.reload();
        ShopConfig previous = shop.getShopConfig();

        TestPaths.write(shopFile, CORRUPT_SHOP_YML);

        assertThrows(IllegalStateException.class, shop::reload,
                "Reloading a corrupt shop.yml must fail instead of replacing the live shop with an empty one");
        assertSame(previous, shop.getShopConfig(),
                "A failed load must not assign a new empty config; the last valid snapshot must survive");
        assertSame(Material.DIAMOND, shop.getShopConfig().getCurrencyMaterial(),
                "The preserved snapshot must still be the previously loaded one");
    }
}
