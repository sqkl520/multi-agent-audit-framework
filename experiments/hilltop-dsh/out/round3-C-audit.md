# Hilltop Village 第三轮静态审计：Group C 外围模块

## 审计范围

本轮只审计 Hilltop Village 的外围切片 `round3-C`，覆盖商店、工具、GUI、命令文档生成与 TPS 诊断模块，不把核心对局状态机、竞技场生命周期等 Group A/B 的职责重复纳入。目标源码根为 `<TARGET_REPO>\src\main\java\com\hilltopvillage`。

16 个指定文件均已逐文件读到文件末尾；另外读取 `src/main/resources/shop.yml` 仅用于核对默认商品配置，不计入切片文件数。审计方式为纯静态源码审阅，未启动 Paper 服务器，未执行游戏内命令，也未修改目标源码。行号与引文均以本次读取的源码为准。

### 文件清单

| 模块 | 文件 |
|---|---|
| shop | `shop/NpcManager.java` |
| shop | `shop/ShopConfig.java` |
| shop | `shop/ShopConfigLoader.java` |
| shop | `shop/ShopGUI.java` |
| shop | `shop/ShopItem.java` |
| shop | `shop/ShopListener.java` |
| shop | `shop/ShopManager.java` |
| util | `util/DisplayEntityManager.java` |
| util | `util/LanguageManager.java` |
| util | `util/MessageTextSync.java` |
| util | `util/SafeSpawnUtil.java` |
| util | `util/YamlFileGate.java` |
| util | `util/YamlFiles.java` |
| gui | `gui/ArenaSelectionGUI.java` |
| doc | `doc/CommandsDocumentGenerator.java` |
| diagnostic | `diagnostic/TpsDiagnostic.java` |

## 发现

### F1 损坏的 shop.yml 被静默降级为空商店

`load()` 直接用 `YamlConfiguration.loadConfiguration(file)` 读取 `shop.yml`，而该 API 在 YAML 语法错误或文件被截断时会返回一个空的 `YamlConfiguration`，不会把解析失败作为异常交给调用方处理。随后 `getConfigurationSection("shop.items")` 得到 `null`，商品列表保持为空，`ShopConfig` 仍被当作正常配置返回。触发方式是对 `shop.yml` 的一次错误手改、编辑器崩溃或磁盘写入截断，然后执行 `/hilltop shop reload` 或重启服务器。结果是整个商店在插件没有标记“配置损坏”、没有隔离、没有回退上一份配置的情况下变成空店，管理员只能从空 GUI 或底层日志反推原因。

`shop/ShopConfigLoader.java:46`

> `YamlConfiguration yaml = YamlConfiguration.loadConfiguration(file);`

### F2 MATERIAL 商品缺少 icon 时仍会发货屏障方块

`parseItem` 先把 `icon` 初始化为 `Material.BARRIER`，但只有 `EQUIPMENT` 分支检查 `iconConfigured`；`MATERIAL` 类型即使完全没写 `icon.material` 也会通过校验。`ShopManager.deliverItem` 的 `MATERIAL` 分支直接执行 `new ItemStack(item.getIcon(), amount)`，因此会把屏障方块当作商品发货。触发方式是新增一个 `type: MATERIAL` 的商品而漏写 `icon.material`，或把该键拼错，玩家点击购买后仍会正常扣款。影响是玩家用货币换来不可用、无价值的屏障方块，GUI 也会把屏障当成商品图标展示，属于静默的付费错误商品。

`shop/ShopConfigLoader.java:123`

> `if ("EQUIPMENT".equals(type) && !iconConfigured) {`

### F3 price 缺失时静默按 1 计价

`price` 用 `getInt(path + ".price", 1)` 读取，缺省值直接是 1；后续只对负数告警并钳到 0，没有检查该键是否存在。触发方式是新增商品时漏写 `price`、把键名拼错，或写成 YAML null，`getInt` 会静默返回 1。该值一路传到 `ShopItem` 并在购买时按 1 扣款，原本打算卖几十水晶的商品会以 1 水晶售出。影响是经济配置被静默改写，管理员在日志里看不到任何缺键提示，也不会在加载阶段被阻止。

`shop/ShopConfigLoader.java:156`

> `int price = yaml.getInt(path + ".price", 1);`

### F4 非正 amount 被静默钳为 1 后仍按原价扣款

`amount` 同样用带默认值 1 的 `getInt` 读取，加载器没有拒绝 0、负数或非数字；`ShopManager.deliverItem` 再用 `Math.max(1, item.getAmount())` 把非法值静默改成 1。触发方式是配置 `amount: 0`（本意可能是下架）或 `amount: -5`，加载阶段既不 warning 也不跳过。玩家仍按完整价格购买，却只收到 1 个商品，配置数量与实际发货不一致。影响是箭、烈焰蛋、树汁这类数量型商品出现少发，且没有日志能解释数量为什么被改写。

`shop/ShopConfigLoader.java:165`

> `int amount = yaml.getInt(path + ".amount", 1);`

### F5 购买成功消息使用被 addItem 改写后的数量

`addItem(product)` 的返回值只用于处理溢出，但紧接着的成功消息又用 `product.getAmount()` 作为“发货数量”。在 Paper 1.21.4 的 `CraftInventory.addItem` 中，商品与背包里同类部分堆合并时会把传入 `ItemStack` 的数量就地改成剩余量；例如玩家已有 60 支箭、购买 8 支，先合并 4 支后 `product` 变为 4，剩余 4 支再进空槽时消息仍显示 4。玩家实际收到 8 支，却看到“x4”，会误以为少发或重复购买。影响是购买反馈与真实到账不一致，属于可复现的显示与契约问题。

`shop/ShopListener.java:162`

> `resolveItemName(player, item), String.valueOf(product.getAmount()),`

### F6 生成的命令文档声称 TPS 输出不存在的 DisplayEntity 队列

`CommandsDocumentGenerator` 在 `/hilltop tps` 的注意事项里声称输出包含 `DisplayEntity 清理队列`，但 `TpsDiagnostic.printDiagnostic` 只输出 TPS/MSPT、对局状态、各世界实体/区块和内存，没有该队列。`DisplayEntityManager` 的类注释还明确写着原清理队列整链已作为零调用死代码删除，说明文案与当前实现不一致。该文档在插件启动时自动生成，管理员和玩家会把它当作当前命令说明。影响是排障时寻找一个不存在的输出项，降低文档可信度；这是确定性的文档数据不一致，不是运行时猜测。

`doc/CommandsDocumentGenerator.java:189`

> `md.append("- **注意事项**: 输出服务器与对局双层级诊断信息（TPS/MSPT、内存、在线/对局玩家、波次、怪物、节点、DisplayEntity 清理队列、各世界实体/区块计数）。MSPT 超过 50ms 时附排查建议。\n\n");`

### F7 异步直接覆盖 commands.md，异常中断会留下空文件或半截文档

`generate()` 把整份 Markdown 拼好后，用 `runTaskAsynchronously` 在异步线程直接 `Files.write` 覆盖 `commands.md`；`Files.write` 默认先截断目标文件再写入，没有临时文件或原子移动。触发方式是服务器在异步写过程中被强制关闭、磁盘写满或权限变化，或管理员恰好此时打开该文件。结果是 `commands.md` 变成空文件或半截文档，而启动时的生成只执行一次，失败后要等下次启动才会重试。影响是自动生成的命令参考损坏且没有旧版本可回退，这与项目 `YamlFiles.write` 的临时文件加原子移动做法不一致。

`doc/CommandsDocumentGenerator.java:441`

> `java.nio.file.Files.write(docFile.toPath(), content.getBytes(StandardCharsets.UTF_8));`

## 发现汇总

| ID | 严重度 | 维度 | 标题 |
|---|---|---|---|
| F1 | MEDIUM | error-handling | 损坏的 shop.yml 被静默降级为空商店 |
| F2 | MEDIUM | data-consistency | MATERIAL 商品缺少 icon 时仍会发货屏障方块 |
| F3 | MEDIUM | data-consistency | price 缺失时静默按 1 计价 |
| F4 | LOW | contract | 非正 amount 被静默钳为 1 后仍按原价扣款 |
| F5 | LOW | data-consistency | 购买成功消息使用被 addItem 改写后的数量 |
| F6 | LOW | data-consistency | 生成的命令文档声称 TPS 输出不存在的 DisplayEntity 队列 |
| F7 | LOW | error-handling | 异步直接覆盖 commands.md，异常中断会留下空文件或半截文档 |

本轮没有发现达到 CRITICAL 的“完整入口到缺陷”调用链，最高严重度为 MEDIUM。

## 已排除的候选

- `ShopManager.removeCurrency` 对部分货币堆的扣减：已核对 Paper 1.21.4 的 `PlayerInventory.getStorageContents()` 返回的是 `CraftItemStack` 镜像，`setAmount` 会写回底层堆，因此不构成“扣款不生效”缺陷。
- `ShopGUI` 的填充物 `ItemStack` 复用：`Inventory#setItem` 会复制物品栈，未发现多个槽位共享同一可变对象导致的串改。
- `ArenaSelectionGUI` 的监听器注册：该类只在插件启动路径构造一次，没有找到重复注册同一实例的路径，未报告重复监听器泄漏。
- `YamlFiles.write` 的落盘：实现使用临时文件并通过原子移动替换目标；未发现与 F7 同类的直接截断问题。

## 自检说明

- 标识符与行号：逐条回查了 `ShopConfigLoader.load/parseItem`、`ShopManager.deliverItem`、`ShopListener.purchase`、`CommandsDocumentGenerator` 与 `TpsDiagnostic` 的实际定义位置，未发现悬空方法或错位行号。
- 反误报：对每条候选都检查了“上层是否已兜底”“是否只是展示层差异”“是否有意为之”三类替代解释，删除了 `removeCurrency` 镜像语义、GUI 填充物共享、`ArenaSelectionGUI` 重复注册等不成立候选。
- 运行时：本次没有启动服务器，所有结论均为静态源码结论；F5 的 `addItem` 语义另外用 Paper 1.21.4 字节码核对，未进行游戏内复现。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "round3-audit-C",
  "role": "audit",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "round3-C-audit.md",
  "payload": {
    "slice_id": "round3-C",
    "searched_scope": {
      "files_read": [
        "shop/NpcManager.java",
        "shop/ShopConfig.java",
        "shop/ShopConfigLoader.java",
        "shop/ShopGUI.java",
        "shop/ShopItem.java",
        "shop/ShopListener.java",
        "shop/ShopManager.java",
        "util/DisplayEntityManager.java",
        "util/LanguageManager.java",
        "util/MessageTextSync.java",
        "util/SafeSpawnUtil.java",
        "util/YamlFileGate.java",
        "util/YamlFiles.java",
        "gui/ArenaSelectionGUI.java",
        "doc/CommandsDocumentGenerator.java",
        "diagnostic/TpsDiagnostic.java"
      ],
      "files_in_slice": 16,
      "dimension_checklist": [
        "逻辑分支与状态机",
        "并发与异步任务",
        "权限与输入边界",
        "异常处理与资源释放",
        "配置与数据一致性",
        "接口契约与返回值"
      ]
    },
    "findings": [
      {
        "finding_id": "F1",
        "severity": "MEDIUM",
        "dimension": "error-handling",
        "evidence": {
          "file": "shop/ShopConfigLoader.java",
          "line": 46,
          "quote": "YamlConfiguration yaml = YamlConfiguration.loadConfiguration(file);"
        },
        "inference": {
          "claim": "shop.yml 解析失败时被当成空配置继续加载，商店会无提示地变成空店。",
          "basis": "loadConfiguration 在语法错误或截断时返回空 YamlConfiguration；随后 shop.items 为 null，items 保持空列表，load() 仍返回正常 ShopConfig。",
          "alternatives": [
            "如果上层在 ShopManager.reload 后检查 items 为空并回退到上一份配置，影响会被掩盖；当前 reload 直接替换 config，没有该保护。",
            "如果 Bukkit 的 loadConfiguration 在解析失败时抛出异常而不是返回空配置，load() 会中止；但其 API 约定是返回空 YamlConfiguration，代码没有捕获或区分。"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "F2",
        "severity": "MEDIUM",
        "dimension": "data-consistency",
        "evidence": {
          "file": "shop/ShopConfigLoader.java",
          "line": 123,
          "quote": "if (\"EQUIPMENT\".equals(type) && !iconConfigured) {"
        },
        "inference": {
          "claim": "MATERIAL 商品漏配 icon.material 时会以 BARRIER 作为发货物，玩家付费后收到屏障方块。",
          "basis": "icon 默认 BARRIER；只有 EQUIPMENT 检查 iconConfigured；MATERIAL 未被拦截，而 deliverItem 的 MATERIAL 分支直接 new ItemStack(item.getIcon(), amount)。",
          "alternatives": [
            "如果 MATERIAL 的 icon 只用于展示、发货另有材质来源，则屏障不会进入背包；当前 deliverItem 明确把 item.getIcon() 当作发货材质。",
            "如果发布流程强制所有 MATERIAL 条目配置 icon，则缺失分支不可达；当前加载器没有该外部校验或必填检查。"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "F3",
        "severity": "MEDIUM",
        "dimension": "data-consistency",
        "evidence": {
          "file": "shop/ShopConfigLoader.java",
          "line": 156,
          "quote": "int price = yaml.getInt(path + \".price\", 1);"
        },
        "inference": {
          "claim": "price 缺键或写成 null 时会被静默当作 1，商品可能以远低于预期的价格出售。",
          "basis": "getInt 的第二个参数是缺省值 1；后续只处理负数价格，没有 contains 检查或缺失告警；该值直接进入 ShopItem 并用于购买扣款。",
          "alternatives": [
            "如果价格 1 是刻意允许的缺省促销价，则不应视为缺陷；但默认模板和注释都把 price 当作商品必填项，且缺键没有任何提示。",
            "如果外部配置校验保证 price 一定存在，则缺省分支不可达；当前加载器没有这样的校验。"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "F4",
        "severity": "LOW",
        "dimension": "contract",
        "evidence": {
          "file": "shop/ShopConfigLoader.java",
          "line": 165,
          "quote": "int amount = yaml.getInt(path + \".amount\", 1);"
        },
        "inference": {
          "claim": "amount 为 0 或负数时不会被拒绝，发货阶段静默改为 1，但价格仍按原值扣除。",
          "basis": "加载器只读取 amount，没有范围校验；ShopManager.deliverItem 使用 Math.max(1, item.getAmount())，把非法数量改成 1，购买链路没有同步修改价格或提示。",
          "alternatives": [
            "如果 amount<=0 的产品语义就是“按 1 个发货”，则这是有意的钳制；当前加载器没有告警，ShopItem 仍保留 0/负值，只有发货层静默改写。",
            "如果 GUI 在展示时也把数量显示为 1，玩家不会被误导；当前 GUI 使用商品图标展示，名称和 lore 可以写任意数量。"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "F5",
        "severity": "LOW",
        "dimension": "data-consistency",
        "evidence": {
          "file": "shop/ShopListener.java",
          "line": 162,
          "quote": "resolveItemName(player, item), String.valueOf(product.getAmount()),"
        },
        "inference": {
          "claim": "购买成功消息可能显示少于实际到账的数量，因为 addItem 会改写传入的商品栈数量。",
          "basis": "Paper 1.21.4 的 CraftInventory.addItem 在与同类部分堆合并时会 product.setAmount(剩余量)；随后代码用 product.getAmount() 拼消息，而不是使用购买前的数量。",
          "alternatives": [
            "如果 addItem 按 Bukkit 契约不修改传入 ItemStack，则 product.getAmount() 仍是原数量，消息正确；但 Paper 1.21.4 的实际实现会在部分合并时就地扣减。",
            "如果商品总是进入空槽而不与已有同类堆合并，则不会触发；玩家持有同类部分堆时该路径可达。"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "F6",
        "severity": "LOW",
        "dimension": "data-consistency",
        "evidence": {
          "file": "doc/CommandsDocumentGenerator.java",
          "line": 189,
          "quote": "md.append(\"- **注意事项**: 输出服务器与对局双层级诊断信息（TPS/MSPT、内存、在线/对局玩家、波次、怪物、节点、DisplayEntity 清理队列、各世界实体/区块计数）。MSPT 超过 50ms 时附排查建议。\\n\\n\");"
        },
        "inference": {
          "claim": "自动生成的 /hilltop tps 文档包含当前实现并不存在的 DisplayEntity 清理队列输出。",
          "basis": "TpsDiagnostic.printDiagnostic 没有输出该队列；DisplayEntityManager 的类注释说明原清理队列整链已作为零调用死代码删除，文案仍保留旧功能描述。",
          "alternatives": [
            "如果 DisplayEntity 清理队列由 TpsDiagnostic 之外的路径输出，文档可能正确；当前打印入口只有 TpsDiagnostic.printDiagnostic，未发现该输出。",
            "如果 commands.md 被视为历史文档、不要求与当前实现同步，则只是过期文案；但它在每次启动时自动生成，属于对外交付文档。"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "F7",
        "severity": "LOW",
        "dimension": "error-handling",
        "evidence": {
          "file": "doc/CommandsDocumentGenerator.java",
          "line": 441,
          "quote": "java.nio.file.Files.write(docFile.toPath(), content.getBytes(StandardCharsets.UTF_8));"
        },
        "inference": {
          "claim": "异步线程直接覆盖 commands.md，写入中断会留下空文件或半截文档。",
          "basis": "Files.write 默认截断目标文件后写入；代码没有临时文件、原子移动或备份，异步任务与服务器关停/磁盘异常竞争时可能只写入一部分内容。",
          "alternatives": [
            "如果服务器进程在写文件期间不会终止且没有并发读者，直接写入也能完成；但启动/关服窗口和运维读取使该假设不成立。",
            "如果 commands.md 只是可再生成的缓存，损坏可由下次启动修复；当前生成只在启动时执行一次，失败后没有重试。"
          ]
        },
        "status": "CONFIRMED"
      }
    ],
    "self_checks": {
      "identifier_reconcile": {
        "status": "DONE",
        "note": "逐条回查 ShopConfigLoader.load/parseItem、ShopManager.deliverItem、ShopListener.purchase、CommandsDocumentGenerator 与 TpsDiagnostic 的定义和行号，未发现悬空标识符或错位引用。"
      },
      "self_check_audit": {
        "status": "DONE",
        "note": "对 7 条发现逐条检查触发条件、代码路径和替代解释；删除了 removeCurrency 镜像语义、GUI 填充物共享、ArenaSelectionGUI 重复注册等不成立候选。"
      },
      "runtime_validation": {
        "status": "SKIPPED",
        "note": "本次为纯静态审计，未启动 Paper 服务器，也未执行游戏内命令；因此所有结论仅基于源码阅读，运行时行为未验证。"
      }
    }
  },
  "error": null
}
```
