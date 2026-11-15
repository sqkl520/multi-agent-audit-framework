package com.hilltopvillage.shop;

import static org.junit.jupiter.api.Assertions.assertAll;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.io.File;
import java.io.IOException;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

import org.bukkit.Material;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import com.hilltopvillage.testsupport.BareHost;
import com.hilltopvillage.testsupport.MockBukkitTestBase;

/**
 * F2 regression: a {@code MATERIAL} item must not silently fall back to a
 * {@link Material#BARRIER} icon when {@code icon.material} is omitted.
 *
 * <p>{@link ShopConfigLoader#parseItem} initializes {@code icon} to {@code BARRIER} and only
 * rejected a missing {@code icon.material} for {@code EQUIPMENT}. For {@code MATERIAL}, the
 * GUI/delivery icon is built from that same field, so an omitted key silently shipped a barrier
 * block instead of the configured item. The loader must skip such an entry just as it does for
 * {@code EQUIPMENT}, while still honoring a valid {@code MATERIAL} icon.</p>
 */
class ShopConfigMaterialValidationTest extends MockBukkitTestBase {

    private BareHost host;
    private ShopConfigLoader loader;

    @BeforeEach
    void setUp() {
        host = loadBareHost();
        loader = new ShopConfigLoader(host);
    }

    @Test
    @DisplayName("F2: MATERIAL rejects a missing icon.material but still loads a valid one")
    void materialWithoutIconIsRejectedButValidIconLoads() throws IOException {
        TestPaths.write(new File(host.getDataFolder(), "shop.yml"), """
                shop:
                  currency:
                    material: EMERALD
                  gui:
                    size: 54
                  items:
                    no_icon:
                      slot: 0
                      price: 1
                      type: MATERIAL
                    with_icon:
                      slot: 1
                      price: 1
                      type: MATERIAL
                      icon:
                        material: DIAMOND_SWORD
                """);

        ShopConfig config = loader.load();
        Map<String, ShopItem> byId = config.getItems().stream()
                .collect(Collectors.toMap(ShopItem::getId, Function.identity()));
        ShopItem missingIcon = byId.get("no_icon");
        ShopItem validIcon = byId.get("with_icon");

        assertAll("F2 MATERIAL icon validation",
                () -> assertNull(missingIcon,
                        () -> "A MATERIAL item without icon.material must be skipped like EQUIPMENT,"
                                + " but it loaded with icon " + missingIcon.getIcon()
                                + " (items: " + byId.keySet() + ")"),
                () -> {
                    assertNotNull(validIcon,
                            "Positive control: a MATERIAL item with icon.material: DIAMOND_SWORD must"
                                    + " still load (items: " + byId.keySet() + ")");
                    assertEquals("MATERIAL", validIcon.getType(),
                            "The positive control must remain a MATERIAL item");
                    assertEquals(Material.DIAMOND_SWORD, validIcon.getIcon(),
                            "The configured icon must be honored instead of the BARRIER default");
                });
    }
}
