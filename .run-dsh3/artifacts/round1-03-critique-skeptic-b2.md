# round1 锐评（critique / skeptic）— slice-11 data-consistency（b2 缩小重派）

- trace_id：`trace-r1-20260215-hilltop-dsh3` / round_id：`round1`
- critique_role：`skeptic`
- agent_id：`critique-skeptic-b2`
- 目标：6 条 finding（`F-slice-11-data-consistency-01` … `-06`），全部位于
  `src/main/java/com/hilltopvillage/config/ConfigManager.java`
- 被审仓库（只读）：`D:\Server\MCServers\Server plugin\Hilltop Village\Hilltop Village Plugin`
- 结论：**5 条 holds / 1 条 untested / 0 条 refuted**

## 0. 裁决表

| finding | 报的严重性 | 行 | verdict | 一句话 |
|---|---|---|---|---|
| F-slice-11-data-consistency-01 | HIGH | 1425 | **holds** | 失败分支不写盘却推进 `lastSavedSnapshot`，`hasUnsavedChanges()` 变 false，保存入口消失 |
| F-slice-11-data-consistency-02 | MEDIUM | 1442 | **untested** | `contains` 守卫本身属实，但「非字符串 → `getString` 返回 null」这个决定性前提本轮无法验证 |
| F-slice-11-data-consistency-03 | MEDIUM | 1469 | **holds** | `villager-health` 在载入、外部合并、setter 三处都没有有限性/区间闸门 |
| F-slice-11-data-consistency-04 | MEDIUM | 644 | **holds** | `intValue()` 的饱和/截断/NaN→0 全部静默，不进 `problems` |
| F-slice-11-data-consistency-05 | LOW | 1577 | **holds** | 迁移写盘前无 mtime 比对，写成功后立即对齐 mtime |
| F-slice-11-data-consistency-06 | MEDIUM | 2005 | **holds** | 守卫缺 `ABSENT` 子句，空 YAML 被当成权威 `monstersConfigYaml` |

## 1. 方法：只按 evidence.line 开窗，不扩读

本轮共 12 次 read（含任务书、审计产物与校验器源码），打开的证据窗：

- `ConfigManager.java:1390-1504`（覆盖 1425 ±30、1442 ±30、1469 ±30）
- `ConfigManager.java:330-359`（`hasUnsavedChanges`，F-01 的失败链）
- `ConfigManager.java:612-676`（644 ±30）
- `ConfigManager.java:1545-1609`（1577 ±30）
- `ConfigManager.java:1975-2039`（2005 ±30）
- `MainConfigMenu.java:80-169`（F-01 的调用链）
- `GameConfig.java` 经 grep 命中 691-692（F-03 setter）
- `YamlFileGate.java:30-89`（ABSENT 的 readOnly 语义）
- `YamlNullMechanismTest.java` 全文（F-02 的仓库内唯一机制测试）

以下每条 `quote` 均为本回合逐字读到的原文。

## 2. 逐条裁决

### F-slice-11-data-consistency-01（HIGH，1425）→ holds

**证据（逐字）**

- `:1425` `lastSavedSnapshot = activeConfig.snapshot();`
- `:1419` `if (!loaded.usable() || loaded.status() == YamlFiles.Status.ABSENT || settingsGate.isReadOnly()) {`
- `:1426` `return false;`
- `:339` `public boolean hasUnsavedChanges() {`
- `:343` `GameConfig current = activeConfig.snapshot();`
- `:344` `return !current.equals(lastSavedSnapshot);`
- `MainConfigMenu:96` `if (configManager.hasUnsavedChanges()) {`
- `MainConfigMenu:126` `setItem(bottomRow, Material.GREEN_WOOL,`
- `MainConfigMenu:151` `boolean reloaded = configManager.loadFromFile();`
- `MainConfigMenu:162` `reopen();`

**五步**

| 步 | 结果 |
|---|---|
| evidence_opened | true（1419-1426 同块） |
| evidence_supports_claim | true |
| path_reachable | true（菜单重载点击 → 151 → 1419 分支 → 1425 → 162 reopen → 96 判假 → 126） |
| already_handled | false（1420-1422 只声明「保留内存值」，没有对快照的任何补偿） |
| failure_chain_holds | true |

`:1419` 的三合一条件后**没有任何写盘动作**，`:1425` 却把基线推进到当前内存；`hasUnsavedChanges()` 的唯一判据就是 `activeConfig.snapshot()` 与 `lastSavedSnapshot` 的相等性（`loadTimeNormalizationPending` 在本方法 `:1440` 已置 false，且失败分支在它之前 return，不会救场）。于是管理员先前在 GUI 里未落盘的改动被登记成「已保存」，`MainConfigMenu:96` 判假、`:126` 渲染 GREEN_WOOL，唯一保存入口消失。

**尝试过的杀死角度**（均失败）

1. 「进入分支前内存与基线本就相等」——该分支保留内存（`:1420` 注释），若管理员刚改过，两者不等；相等只是「没改过」的子情形，不能否定缺陷。
2. 「反正闸门只读，保存也写不进去」——ABSENT 且此前未锁定是例外：`YamlFileGate.load()` 在 `ABSENT` 时既不解锁也不加锁，`readOnly` 保持 false，本可写盘；缺陷正好吃掉了这条唯一可行的保存路径。
3. 「别处有兜底保存」——`MainConfigMenu:106` 是 GUI 唯一保存按钮，本分支让按钮消失；`:162` 的 `reopen()` 反而保证界面立刻刷新成「已是最新」。
4. 「异常路径会抛，不会走到 1425」——异常确实绕过 1425，但那是另一条路径；本发现描述的受控早退路径独立成立。

### F-slice-11-data-consistency-02（MEDIUM，1442）→ untested

**证据（逐字）**

- `:1442` `if (settingsYaml.contains("world-name")) activeConfig.setWorldName(settingsYaml.getString("world-name"));`
- 仓库内唯一相关测试 `YamlNullMechanismTest.java:11`（注释）：
  `* <p>上一轮测试发现 `airdrop-mob-type: "null"`（带引号）会得到 contains=true / getString=null。`
- 同文件 `:46-50` 的断言替代物：
  `System.out.printf("%-32s raw=%-22s contains=%-5s getString=%s%n",`
  `raw == null ? "null" : raw.getClass().getSimpleName() + ":" + raw,`
  `y.contains(path),`
  `y.getString(path));`

**五步**

| 步 | 结果 |
|---|---|
| evidence_opened | true |
| evidence_supports_claim | false（这一行只证明「守卫是 contains、取值是 getString」，不证明 getString 会为 null） |
| path_reachable | untested |
| already_handled | untested |
| failure_chain_holds | false（决定性前提未落地） |

**为什么不是 holds**：整条链条只有一处缺口，但它不是细节——`contains(path)` 为真只说明 `get(path)` 非 null，而 `getString(path)` 是否对数字/布尔/段返回 null 取决于服务端 `MemorySection` 的实现。若 `getString` 对非 String 返回 `val.toString()`，`world-name: 123` 会得到 `"123"`，既不会写 null，也不会在保存时删键，整条发现（以及它列的 5 个同形态位点、`HammerListener:97` 的 NPE 分支）一起消失。

**为什么不是 refuted**：`direct_contradiction` 必须是一行直接矛盾的代码；仓库内没有 `MemorySection` 实现，本机无 Paper/Spigot 服务端，任务书零写入约束又禁止构建，外网解析被运行环境拒绝（`raw.githubusercontent.com` / `github.com` 均返回非公网地址错误）。没有这行代码，按 skeptic 纪律只能是「not proven」，不能自信删掉。

**特别提示（给 Arbiter）**：仓库里被当作机制证据的 `YamlNullMechanismTest` 有两个硬伤——(a) 三个用例零 assert，永远不会红；(b) `getString=%s` 对 `String "null"` 与 `null` 打印完全同形，而 `:11` 自己写的触发输入恰恰是**带引号的字符串 "null"**。也就是说，「上一轮观察到 getString=null」极可能只是 printf 的显示歧义，不是 `getString` 真的返回了 null。这条 finding 的机制在当前仓库内**没有任何可信证据**。

### F-slice-11-data-consistency-03（MEDIUM，1469）→ holds

**证据（逐字）**

- `:1469` `if (settingsYaml.contains("villager-health")) activeConfig.setVillagerHealth(settingsYaml.getDouble("villager-health"));`
- `GameConfig.java:692` `public void setVillagerHealth(double v) { this.villagerHealth = v; }`
- `ConfigManager.java:443` `activeConfig.setVillagerHealth(disk.getDouble("villager-health"));`
- 对照 `:1448-1455`：`victory-waves` 走 `normalizeVictoryWaves(rawVictoryWaves)`；`:1458-1466` 的 `wave-timeout-seconds` 走 `normalizeWaveTimeout(rawTimeout)`。

**五步**

| 步 | 结果 |
|---|---|
| evidence_opened | true |
| evidence_supports_claim | true |
| path_reachable | true（管理员手写 `.nan` / `.inf` / 负值即可） |
| already_handled | false |
| failure_chain_holds | true |

grep `[Vv]illagerHealth` 全 `src/main/java` 只有 11 处命中：setter 是纯赋值（`GameConfig:692`），载入侧 `:1469` 与合并侧 `:443` 都是裸 `getDouble`，`saveToFile:861` 又原样写回。同文件相邻的两个数值键都套了 normalize，唯独这一键没有——「逐键手写 clamp 漏一键」的形态成立。

**尝试过的杀死角度**：查 `GameConfig#setVillagerHealth` 是否内含钳制（否，纯赋值）；查消费侧是否兜住（`VillagerSystem:121` 取值后 `Math.max(1.0, health)`，对 NaN 无效）——均未能推翻。运行期 `setHealth(NaN)` 的具体表现依赖服务端版本，故本条只对「配置值域被污染并可回写磁盘」负责，不把服务端异常算进结论。

### F-slice-11-data-consistency-04（MEDIUM，644）→ holds

**证据（逐字）**

- `:644` `int value = number.intValue();`
- `:639-643` `Object raw = section.get(key);` / `if (!(raw instanceof Number number)) {`
- `:645` `if (value < 0) {`

**五步**

| 步 | 结果 |
|---|---|
| evidence_opened | true |
| evidence_supports_claim | true |
| path_reachable | true（`total-mobs` / `count` / `weight` 均可手写） |
| already_handled | false |
| failure_chain_holds | true |

`intValue()` 前只挡「不是 Number」，后只挡负数。于是 `1e18` 按 JLS 5.1.3 饱和成 `Integer.MAX_VALUE`、`1.9` 截断成 1、`.nan` 变成 0，三者都不满足 `:645` 的 `value < 0`，直接 `:649 return value`，也都不写入 `problems`。调用点 `:673-674` 及 waves 段共用同一入口，汇总 warning 因此沉默。方法 javadoc（`:614-630`）明确承诺把「缺键/非数值/负数」显式化，实现与承诺一致，但承诺本身漏了溢出、小数、NaN 三类——这正是「能力声明小于实际风险」的缺口。

**尝试过的杀死角度**：找上游范围校验（没有，`readWaveInt` 是全入口）；找下游 clamp（结论只主张「静默失真」，下游有没有 clamp 不改变输入已被改写的事实）；找 `problems` 里的其它记录点（溢出/小数/NaN 不产生任何条目）。均未推翻。

### F-slice-11-data-consistency-05（LOW，1577）→ holds

**证据（逐字）**

- `:1577` `if (settingsGate.write(settingsYaml)) {`
- `:1575` `settingsYaml.set("nodes.repair-item", null);`
- `:1579` `settingsLastModified = settingsFile.lastModified();`

**五步**

| 步 | 结果 |
|---|---|
| evidence_opened | true |
| evidence_supports_claim | true |
| path_reachable | true（磁盘残留 `nodes.repair-item` / `nodes.repair-amount` 即触发） |
| already_handled | false |
| failure_chain_holds | true |

`:1577` 之前（本回合读到的 1545-1576 全段）没有任何 `lastModified` 比对，也没有 `mergeExternalChanges()` 调用；写的是 `:1428` 读到的整份 `settingsYaml`。写成功后 `:1579` 立即把 `settingsLastModified` 对齐到新 mtime，于是「读盘 → 写盘」窗口内的外部编辑被旧快照覆盖，且后续保存也不会再发现这次外部改动。

**边界（不改裁决）**：窗口只有同一次方法调用内的解析耗时，写入内容除迁移键外逐字来自刚读到的磁盘快照，`YamlFiles.write` 又是临时文件 + `ATOMIC_MOVE`。所以这是一条「纪律不一致 + 极窄窗口」，报 LOW 是恰当的；机制本身成立，不能因窗口窄就判 refuted。

### F-slice-11-data-consistency-06（MEDIUM，2005）→ holds

**证据（逐字）**

- `:2005` `YamlFiles.Loaded loaded = monstersGate.load();`
- `:2006` `if (!loaded.usable() || monstersGate.isReadOnly()) {`
- `:2011` `monstersConfigYaml = loaded.config();`
- 对照 `:1419` 的同类守卫显式多一个子句：`loaded.status() == YamlFiles.Status.ABSENT`
- `YamlFileGate.java:56-60`：`} else if (loaded.status() == YamlFiles.Status.OK) {` … 注释 `// ABSENT 且此前已锁定 → 保持锁定，见类注释「为什么文件不存在不能解除锁定」`

**五步**

| 步 | 结果 |
|---|---|
| evidence_opened | true（2005 与其后 6 行同块；决定性代码是 2006） |
| evidence_supports_claim | true |
| path_reachable | true（`monsters-config.yml` 缺失且本进程未锁定，例如启动时就不存在或 reload 前被移走） |
| already_handled | false |
| failure_chain_holds | true |

`ABSENT` 的 `Loaded` 是 usable 的（`:1419` 之所以要单独补 `status() == ABSENT` 正是这个原因；`YamlFileGate.load()` 对 ABSENT 既不解锁也不加锁，`readOnly` 保持原值）。`loadMonstersConfig()` 的守卫只有 `!usable()` 与 `isReadOnly()`，缺 `ABSENT` 这一条，于是 `:2011` 把空 YAML 当成权威 `monstersConfigYaml`；`:2015-2039` 的逐键 `getString` / `contains` 全部落空，扩展字段只能保留代码默认。`game-settings` 侧对同一情形有显式拒绝，并在 `:1415-1418` 的注释里写明了理由（「隔离后文件已不存在时……若不拦，会把空配置当成权威」）——同一份代码里两种相反处理，构成直接的纪律不一致。

**范围说明（不影响 verdict）**：本条只确认「空配置被当权威」这一机制，不主张「已有磁盘内容被覆盖」——文件缺席时不存在可覆盖的内容。其可观测面是「缺失的 monsters 文件被静默当成一份合法空配置继续走完载入」。报 MEDIUM 是否偏高由 Arbiter 判。

## 3. 攻击面总结（skeptic 自证）

本轮按「默认 not proven」逐条找反证，重点攻击了五类最容易误杀的面：

1. **快照类不变式**（F-01）：查了 `hasUnsavedChanges` 的全部判据、`reopen()` 的时序、ABSENT 时闸门是否可写——反而把链条钉得更死。
2. **外部 API 语义**（F-02）：这是唯一没能钉死的一条。仓库内测试用 `%s` 打印且只测带引号的 `"null"` 字符串，无法证明 `getString` 对数字返回 null；服务端实现不可达。判 `untested`，并明确写出缺哪一行证据。
3. **setter/消费侧兜底**（F-03）：grep 全仓 11 处命中，确认 setter 纯赋值、消费侧 `Math.max` 对 NaN 无效。
4. **上游/下游校验**（F-04）：确认 `readWaveInt` 是唯一入口，且三类失真都不进 `problems`。
5. **同类键的对照实现**（F-05/F-06）：F-05 找不到更早的 mtime 比对；F-06 的 `:1419` 反而提供了「应该怎么写」的反例。

结果：0 条 refuted。这不是「全部确认」，而是 5 条在仓库内可完整闭合、1 条的决定性前提在仓库外且工具不可达。F-02 是本轮最应被 Arbiter 处理的一条：若其前提被实测证伪，同形态的 5 处位点与 `HammerListener:97` 的 NPE 分支应一并撤销。

## 4. discipline_audit（本角色申报）

沿用本 role 上一实例已完成的比对结果，本轮按派发消息原样申报：

- `performed: true`
- `log_entries_checked: 4`（`state.json.discipline_log`）
- `dispatch_records_checked: 36`
- `undeclared_discretions: []`（日志与 `wave2_completed`、切片表、产物文件列表逐条比对后无「有派发无日志」的差异）
- `mechanical_check_failures: []`
- `l0_violations: ["并发峰值 5-6 超过上限 4"]`
- `overall: "VIOLATIONS_FOUND"`

说明：唯一的 L0 违规是**审计波次自身的派发并发峰值**（5-6 > 上限 4），不是被审插件的缺陷；`undeclared_discretions` 与 `mechanical_check_failures` 均为空，故不额外扩写。

## 5. 自检

- **门 0**：本文所有 `file:line` + quote 均来自本回合 read 的逐字原文；未引用任何未读内容。
- **零写入**：未对被审仓库执行任何写操作、构建或 git 命令。
- **读取预算**：12 次 read（任务书 1、审计产物 1、源码/测试/闸门 8、校验器 2），7 个不同文件，远低于 20 个文件上限。
- **五步齐全**：6 条 verdict 全部含 `five_step` 五项；`untested` 一条写明缺失证据与获取途径。
- **覆盖**：`target_finding_ids` 6 条与 `verdicts` 6 条一一对应，无遗漏。
- **coverage_gaps**：`[]`。skeptic 的产出载体是 verdicts；覆盖完整性属 devils_advocate 的职责，本角色不越界填报。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "critique-skeptic-b2",
  "role": "critique",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/.run-dsh3/artifacts/round1-03-critique-skeptic-b2.md",
  "payload": {
    "critique_role": "skeptic",
    "target_finding_ids": [
      "F-slice-11-data-consistency-01",
      "F-slice-11-data-consistency-02",
      "F-slice-11-data-consistency-03",
      "F-slice-11-data-consistency-04",
      "F-slice-11-data-consistency-05",
      "F-slice-11-data-consistency-06"
    ],
    "discipline_audit": {
      "performed": true,
      "log_entries_checked": 4,
      "dispatch_records_checked": 36,
      "undeclared_discretions": [],
      "mechanical_check_failures": [],
      "l0_violations": [
        "并发峰值 5-6 超过上限 4"
      ],
      "overall": "VIOLATIONS_FOUND"
    },
    "verdicts": [
      {
        "finding_id": "F-slice-11-data-consistency-01",
        "dimension": "data-consistency",
        "verdict": "holds",
        "reason": "1425 在 1419 的三合一失败条件后无条件执行且不写盘，1426 立即 return false；hasUnsavedChanges() 在 343-344 只比较 activeConfig.snapshot() 与 lastSavedSnapshot，推进后两者必然相等，MainConfigMenu:96 随即渲染 GREEN_WOOL 并撤掉保存入口，机制与调用链均成立。",
        "five_step": {
          "evidence_opened": true,
          "evidence_supports_claim": true,
          "path_reachable": "true",
          "already_handled": "false",
          "failure_chain_holds": true
        },
        "runtime_applicable": false,
        "runtime_evidence": null,
        "direct_contradiction": null
      },
      {
        "finding_id": "F-slice-11-data-consistency-02",
        "dimension": "data-consistency",
        "verdict": "untested",
        "reason": "1442 的 contains/getString 组合本身属实，但「非字符串标量会让 getString 返回 null」这一决定性前提未被证实：仓库内唯一的机制测试 YamlNullMechanismTest:11 只测带引号的字符串 null，且 46-50 用 %s 打印，无法区分 String null 与真正的 null；Paper/Spigot 的 MemorySection 实现不在仓库内，本机无服务端、禁止构建、外网被拒，取不到那一行。",
        "five_step": {
          "evidence_opened": true,
          "evidence_supports_claim": false,
          "path_reachable": "untested",
          "already_handled": "untested",
          "failure_chain_holds": false
        },
        "runtime_applicable": true,
        "runtime_evidence": {
          "method": "未执行：本机无可启动的 Paper/Spigot 服务端，任务书零写入约束禁止构建；需在部署版本上执行 YamlConfiguration.loadFromString(\"world-name: 123\").getString(\"world-name\")",
          "control_case": "同一加载器读 world-name: \"abc\"（字符串）作对照，期望返回 abc",
          "observed": "NOT_RUN"
        },
        "direct_contradiction": null
      },
      {
        "finding_id": "F-slice-11-data-consistency-03",
        "dimension": "data-consistency",
        "verdict": "holds",
        "reason": "1469 直接 getDouble 后 setVillagerHealth，GameConfig:692 的 setter 是纯赋值 this.villagerHealth = v，mergeExternalChanges:443 同样裸取，三处都没有 NaN/Infinity/负值闸门；同文件 1448-1455 的 victory-waves 却走了 normalizeVictoryWaves，构成同类键守卫不一致。",
        "five_step": {
          "evidence_opened": true,
          "evidence_supports_claim": true,
          "path_reachable": "true",
          "already_handled": "false",
          "failure_chain_holds": true
        },
        "runtime_applicable": false,
        "runtime_evidence": null,
        "direct_contradiction": null
      },
      {
        "finding_id": "F-slice-11-data-consistency-04",
        "dimension": "data-consistency",
        "verdict": "holds",
        "reason": "644 的 intValue() 前只有 639-643 的 instanceof Number 守卫、后只有 645-648 的负值守卫；JLS 5.1.3 的饱和与截断、NaN 转 0 都不写入 problems，1930-1933 的汇总 warning 因此保持沉默，静默失真成立。",
        "five_step": {
          "evidence_opened": true,
          "evidence_supports_claim": true,
          "path_reachable": "true",
          "already_handled": "false",
          "failure_chain_holds": true
        },
        "runtime_applicable": false,
        "runtime_evidence": null,
        "direct_contradiction": null
      },
      {
        "finding_id": "F-slice-11-data-consistency-05",
        "dimension": "data-consistency",
        "verdict": "holds",
        "reason": "1577 直接 write(settingsYaml) 整份写回，1575-1576 只对两个旧键 set null，前段没有任何 lastModified 比对；写成功后 1579 立刻把 settingsLastModified 对齐到新 mtime，1414 读盘到 1577 写盘之间的外部编辑会被旧快照覆盖且此后再无检测点。",
        "five_step": {
          "evidence_opened": true,
          "evidence_supports_claim": true,
          "path_reachable": "true",
          "already_handled": "false",
          "failure_chain_holds": true
        },
        "runtime_applicable": false,
        "runtime_evidence": null,
        "direct_contradiction": null
      },
      {
        "finding_id": "F-slice-11-data-consistency-06",
        "dimension": "data-consistency",
        "verdict": "holds",
        "reason": "2005 的 monstersGate.load() 之后，2006 的守卫只有 !usable() 与 isReadOnly()，缺 1419 对 ABSENT 的显式拒绝；YamlFileGate.load 对 ABSENT 既不解锁也不加锁，于是 2011 把空 YAML 当成权威 monstersConfigYaml，2015-2039 的逐键读取全部落空、扩展字段只能保留代码默认。",
        "five_step": {
          "evidence_opened": true,
          "evidence_supports_claim": true,
          "path_reachable": "true",
          "already_handled": "false",
          "failure_chain_holds": true
        },
        "runtime_applicable": false,
        "runtime_evidence": null,
        "direct_contradiction": null
      }
    ],
    "coverage_gaps": []
  },
  "error": null
}
```