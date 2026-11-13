<!--
  自动生成，请勿手改。生成器：tools/gen-contract-examples.mjs
  这份示例**已经过 check-payload.mjs 验证**，可以直接照抄再改。
-->

# fix 角色的最小合规产物

这是能通过校验的最小完整信封。字段含义见 `components/output-contract/fix.md`。
**照抄这份再替换内容**，比从零拼要可靠。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "fix-1",
  "role": "fix",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "<OUTDIR>/round1-02-audit-S1-logic.md",
  "payload": {
    "files_touched": [
      {
        "path": "src/store.js",
        "lines_added": 6,
        "lines_removed": 1
      }
    ],
    "verification_commands": [
      {
        "command": "node -e \"require('./src/store.js')\"",
        "exit_code": 0
      }
    ],
    "affected_issues": [
      "F1"
    ],
    "residual_risks": [
      "未覆盖网络文件系统场景"
    ]
  },
  "error": null
}
```

## 自检

写完产物后运行：

```bash
node <FRAMEWORK_ROOT>/tools/check-payload.mjs <你的产物文件> --role fix
```
