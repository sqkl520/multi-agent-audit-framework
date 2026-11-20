# slice-13 / contract 审计产物（round1）

窄范围重派：只核实派发消息指定的 2 条 GUI 事件契约缺陷。被审仓库只读，未构建。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "audit-slice-13-contract",
  "role": "audit",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:\\Projects\\AI prompt\\many-agents_multi-prompt-files_token-heavy\\multi-agent-audit-framework\\.run-dsh3\\artifacts\\round1-02-audit-slice-13-contract.md",
  "payload": {
    "findings": [
      {
        "finding_id": "F-slice-13-contract-01",
        "severity": "MEDIUM",
        "dimension": "contract",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/config/menu/AbstractConfigMenu.java",
          "line": 154,
          "quote": "    public void onClick(InventoryClickEvent event) {"
        },
        "inference": {
          "claim": "AbstractConfigMenu 只注册了 InventoryClickEvent 与 InventoryCloseEvent 两个处理器，没有 InventoryDragEvent 处理器；因此在本菜单为 top inventory 时，玩家可以把受管 GUI 内的物品拖进自己的背包，预期是 raw slot 落在 top inventory 范围内的拖动必须被取消。",
          "basis": "本文件 153-154 行是唯一的点击入口 @EventHandler public void onClick(InventoryClickEvent event)，175-176 行是第二个也是最后一个处理器 onClose(InventoryCloseEvent)；import 仅见 12-13 行的 InventoryClickEvent/InventoryCloseEvent，全文无 InventoryDragEvent 符号。Bukkit 对 InventoryDragEvent 不做默认取消，父类不监听就不会拦截。同仓库 AbstractAdminMenu.java:15-16 的类注释把这一点明确记为「缺口①：父类只处理 InventoryClickEvent，没有 InventoryDragEvent 处理器，因此玩家可以把 GUI 内的物品拖到自己的背包里」，并在 :48-60 用 guardDrag(InventoryDragEvent) 自行补上；而 ItemSettingsMenu.java:20、MonsterSettingsMenu.java:23、GameRulesMenu.java:14 都直接 extends AbstractConfigMenu，不继承该 guardDrag，故配置菜单全部暴露。",
          "alternatives": [
            "如果所有配置菜单实际上都继承了 AbstractAdminMenu（从而继承 admin/gui/AbstractAdminMenu.java:48 的 guardDrag），缺口即被覆盖——但 ItemSettingsMenu.java:20、MonsterSettingsMenu.java:23、GameRulesMenu.java:14 均直接 extends AbstractConfigMenu，条件不成立。",
            "如果插件在别处注册了全局 InventoryDragEvent 监听器并取消事件，本缺口会被兜底——需检查 src/main/java 下全部 InventoryDragEvent 引用（本次只读范围内仅 AbstractAdminMenu.java:48 一处）。",
            "如果受管 GUI 的空槽位都是 AIR、没有可拖动的 ItemStack，拖出无实际影响——但 AbstractConfigMenu.java:118-129 的 fillEmpty() 会给每个空槽填入 BLACK_STAINED_GLASS_PANE，槽位始终有物品。"
          ]
        },
        "status": "CONFIRMED"
      },
      {
        "finding_id": "F-slice-13-contract-02",
        "severity": "MEDIUM",
        "dimension": "contract",
        "evidence": {
          "file": "src/main/java/com/hilltopvillage/config/menu/ItemSettingsMenu.java",
          "line": 239,
          "quote": "        setClickableItemWithData(slot, icon, ChatColor.GREEN + name, loreLines,\n                ct -> {\n                    Material next = nextMat(current, cycle);\n                    setter.accept(next);\n                    reopen();\n                });"
        },
        "inference": {
          "claim": "ItemSettingsMenu 的材质循环槽位（addMaterialCycle）与 MonsterSettingsMenu 的布尔开关都不读 ClickType：任何 ClickType（DROP、MIDDLE、DOUBLE_CLICK、NUMBER_KEY 等）都会直接写配置，而预期的契约是只有 LEFT/RIGHT（及 SHIFT 自定义输入）改变配置。",
          "basis": "ItemSettingsMenu.java:239-244 注册的 lambda 形参是 ct，但函数体只做 nextMat(current, cycle) 与 setter.accept(next)，从未读取 ct；MonsterSettingsMenu.java:211 同样是 `ct -> { mc.setEntityExplosion(!mc.isEntityExplosion()); reopen(); }`，形参 ct 在函数体中零次出现。AbstractConfigMenu.java:169-172 会把 event.getClick() 原样传给每个动作，且在 161 行已先 setCancelled(true)，所以 DROP/NUMBER_KEY 等点击不会真正丢物品或换手，却仍会推进材质/翻转布尔值。同仓库 GameRulesMenu.java:139-145 在 slice-08-logic-009 注释后已把写配置分支收窄为显式 `clickType == ClickType.LEFT`，SHIFT 分支在 :124、RIGHT 分支在 :135，证明同族实现已按白名单收窄，这两个菜单没有跟上。",
          "alternatives": [
            "如果 AbstractConfigMenu 在分发前已过滤 ClickType、只放行 LEFT/RIGHT/SHIFT，则子类不读 ct 也无害——但 AbstractConfigMenu.java:171 直接调用 action.onClick(event.getClick())，没有白名单，条件不成立。",
            "如果 Bukkit 对被取消的 InventoryClickEvent 不再投递 DROP/MIDDLE/DOUBLE_CLICK，则这些 ClickType 不会到达 lambda——但 GameRulesMenu.java:140-142 的注释明确记录这些 ClickType 会到达并曾静默改配置，说明会被投递。",
            "如果 UI 文案承诺的是「任意点击都循环」（lang key config.menu.common.click-cycle），则该行为符合文案而非缺陷——需检查语言文件中该 key 的文案是否只写左/右键。",
            "如果这些槽位只对拥有 config 管理权限的 OP 开放，影响可降级为「管理员误操作」——需检查打开菜单的命令权限节点（本次未读命令类）。"
          ]
        },
        "status": "CONFIRMED"
      }
    ],
    "searched_scope": {
      "files_read": [
        "src/main/java/com/hilltopvillage/config/menu/AbstractConfigMenu.java",
        "src/main/java/com/hilltopvillage/config/menu/ItemSettingsMenu.java",
        "src/main/java/com/hilltopvillage/config/menu/MonsterSettingsMenu.java",
        "src/main/java/com/hilltopvillage/config/menu/GameRulesMenu.java",
        "src/main/java/com/hilltopvillage/admin/gui/AbstractAdminMenu.java"
      ],
      "files_scanned_without_findings": [],
      "dimension_checklist": [
        { "pattern": "GUI 拖拽事件覆盖（InventoryDragEvent）", "result": "命中", "note": "AbstractConfigMenu 只有 Click/Close 两个处理器，无 Drag。" },
        { "pattern": "ClickType 收窄一致性", "result": "命中", "note": "ItemSettingsMenu/MonsterSettingsMenu 不读 ClickType，GameRulesMenu 已收窄。" },
        { "pattern": "getClickedInventory 与 top inventory 判定", "result": "未命中", "note": "onClick 在分发前同时校验 top inventory 与 clicked inventory。" },
        { "pattern": "slot 越界 / getCurrentItem 为 null", "result": "未命中", "note": "动作按 slot 查 clickActions，不读 currentItem。" },
        { "pattern": "shift-click 把背包物品塞进 GUI", "result": "未命中", "note": "点击路径已由 top inventory 判定后统一取消。" },
        { "pattern": "命令参数 / Tab 补全契约", "result": "不适用", "note": "本切片仅 GUI 菜单类，不含命令执行器。" },
        { "pattern": "数值输入边界（负数/0/超大/小数）", "result": "不适用", "note": "数值 clamp 属 logic 维度，不在本次 contract 切片。" }
      ]
    },
    "self_checks": {
      "identifier_reconcile": { "status": "DONE", "note": "对账 @EventHandler 方法签名与 InventoryDragEvent 符号，并比对三个子菜单的 ClickType 分支。" },
      "self_check_audit": { "status": "SKIPPED", "note": "本轮为窄范围只读重派，未运行仓库自带测试，改以 GameRulesMenu 作同族实现对照。" },
      "runtime_validation": { "status": "SKIPPED", "note": "不能跑构建或服务器：任务书禁止构建（会写 target/），且被审仓库要求零写入。" }
    },
    "off_dimension_notes": []
  },
  "error": null
}
```
