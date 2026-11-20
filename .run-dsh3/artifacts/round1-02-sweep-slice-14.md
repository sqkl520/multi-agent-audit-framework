# slice-14 宽扫（WaveSettingsMenu）

- status: COMPLETE
- trace_id: trace-r1-20260215-hilltop-dsh3 / round_id: round1
- 切片文件: `src/main/java/com/hilltopvillage/config/menu/WaveSettingsMenu.java`（738 行）
- 上下文文件（同目录，仅用于生命周期判定）: `AbstractConfigMenu.java`（183 行）

## 1. 可达性

`PROD`。`MainConfigMenu.java:51` 直接构造 `WaveSettingsMenu`（`new WaveSettingsMenu(admin, configManager, this, lang)`），属于 `/hilltop config` 管理菜单的子页；无测试引用，也非生成文件。

## 2. 分页与索引（重点项复核）

| 检查点 | 结论 |
|---|---|
| `page` 负数 | 已在 `buildMenu()` 入口钳制：`page = Math.max(0, Math.min(page, totalPages - 1));`（53 行），负数被收敛到 0 |
| `page` 越界 | `totalPages = Math.max(1, ceil(size/21))`（49 行），钳制后 `startIdx ≤ (totalPages-1)*21 < size`，不会出现负下标 |
| `size()==0` | `totalPages=1`、`page=0`、`startIdx=endIdx=0`，循环空转，prev/next 都不显示；删除路径有 `waveNums.size() <= 1` 拦最后一条（82 行），正常流程到不了 0 |
| 删除后索引失效 | 删除后立即 `reopen()` 重建，`page` 在重建时被重新钳制；`wnum` 是 `final` 拷贝，闭包不会串号 |
| 左右键语义 | 主菜单：LEFT 进详情、SHIFT_LEFT/SHIFT_RIGHT 删波次；详情：LEFT +1、RIGHT -1、SHIFT_LEFT 改权重、SHIFT_RIGHT 进属性页。显式白名单已收窄（91/253/267/270 行），无「其它 ClickType 兜底」 |
| 数值输入边界 | `totalMobs` 双侧钳制（1..100，226 行）；权重、怪物 count、新增波次号均只单侧或完全不钳制（见 L1/L5） |

## 3. 线索

| id | 维度 | 位置 | 一句话 |
|---|---|---|---|
| L1 | contract | WaveSettingsMenu.java:115 | 新增波次只查重不查范围，0/负数/极大值可直接成为波次键 |
| L2 | contract | WaveSettingsMenu.java:249 | 详情页怪物槽位从 27 起无上界递增，>18 条会覆盖 46 号按钮并越过 53 号槽 |
| L3 | logic | WaveSettingsMenu.java:216 | `buildMenu()` 内 `closeInventory()` 之后 `open()` 仍会无条件 `openInventory()` |
| L4 | data-consistency | WaveSettingsMenu.java:118 | 新增波次直接改内存 map，未走删除路径那样的 ConfigManager 记账 |
| L5 | logic | WaveSettingsMenu.java:257 | 权重只钳下界不钳上界，与 totalMobs 的双侧钳制不对称 |

## 4. 未展开（本轮不判）

- `AddMonsterMenu` 的 `slot` 从 9 起同样无上界（380/409 行），怪物类型 >45 时会写到 53 号槽之后；与 L2 同型，未单列。
- `addIntItem` 经 `addDblItem` 后 `(int) v` 截断（595 行），小数输入被静默取整；影响面小，未单列。
- 菜单内所有 setter 都持有 `buildMenu()` 时的 `cfg`/`wc`/`comp` 引用，聊天输入回调延迟执行期间若发生 reload 会写进旧对象；缺少 ConfigManager 侧证据，未单列。

## 5. 覆盖说明

实际读取 2 个文件（切片 1 + 同目录上下文 1），未读切片外其它文件；未运行构建、未写入被审仓库。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "sweep-slice-14-r1",
  "role": "sweep",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/.run-dsh3/artifacts/round1-02-sweep-slice-14.md",
  "payload": {
    "slice_id": "slice-14",
    "reachability": "PROD",
    "generator_ref": null,
    "files_read": [
      {
        "path": "src/main/java/com/hilltopvillage/config/menu/WaveSettingsMenu.java",
        "lines": 738,
        "quote": "List<Integer> waveNums = new ArrayList<>(cfg.getWaves().keySet());"
      },
      {
        "path": "src/main/java/com/hilltopvillage/config/menu/AbstractConfigMenu.java",
        "lines": 183,
        "quote": "admin.openInventory(inventory);"
      }
    ],
    "files_unreadable": [],
    "leads": [
      {
        "lead_id": "L1",
        "suspected_dimension": "contract",
        "file": "src/main/java/com/hilltopvillage/config/menu/WaveSettingsMenu.java",
        "line": 115,
        "quote": "if (cfg.getWaves().containsKey(num)) {",
        "why_suspicious": "新增波次只判重复不判范围，num 可为 0、负数或 Integer.MAX_VALUE 并直接作为 waves 的键。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L2",
        "suspected_dimension": "contract",
        "file": "src/main/java/com/hilltopvillage/config/menu/WaveSettingsMenu.java",
        "line": 249,
        "quote": "setClickableItemWithData(slot, getMobIcon(key),",
        "why_suspicious": "slot 从 27 起随 comp 条目无上界递增，超过 18 条会覆盖 46 号新增按钮，超过 27 条写入 >=54 的越界槽位。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L3",
        "suspected_dimension": "logic",
        "file": "src/main/java/com/hilltopvillage/config/menu/WaveSettingsMenu.java",
        "line": 216,
        "quote": "admin.closeInventory();",
        "why_suspicious": "wc == null 分支在 buildMenu 内关闭背包并 return，但 open() 随后仍无条件 openInventory，结果是一个 clickActions 已清空、点不动的空 54 格菜单。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L4",
        "suspected_dimension": "data-consistency",
        "file": "src/main/java/com/hilltopvillage/config/menu/WaveSettingsMenu.java",
        "line": 118,
        "quote": "cfg.getWaves().put(num, new GameConfig.WaveConfig(10, new LinkedHashMap<>()));",
        "why_suspicious": "新增波次直接写内存 map，而同一菜单的删除走 configManager.removeWave 记账，两条路径的落盘语义不对称。",
        "confidence": "MEDIUM"
      },
      {
        "lead_id": "L5",
        "suspected_dimension": "logic",
        "file": "src/main/java/com/hilltopvillage/config/menu/WaveSettingsMenu.java",
        "line": 257,
        "quote": "v -> { comp.setWeight(Math.max(1, v)); reopen(); },",
        "why_suspicious": "权重仅 Math.max(1, v) 钳下界、未传 min/max，极大权重会进入后续加权抽样。",
        "confidence": "LOW"
      }
    ],
    "lead_count": 5,
    "dimension_histogram": {
      "logic": 2,
      "concurrency": 0,
      "security": 0,
      "error-handling": 0,
      "data-consistency": 1,
      "contract": 2
    }
  },
  "error": null
}
```
