<!--
  自动生成，请勿手改。生成器：tools/gen-contract-examples.mjs
  这份示例**已经过 check-payload.mjs 验证**，可以直接照抄再改。
-->

# sweep 角色的最小合规产物

这是能通过校验的最小完整信封。字段含义见 `components/output-contract/sweep.md`。
**照抄这份再替换内容**，比从零拼要可靠。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "sweep-1",
  "role": "sweep",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "<OUTDIR>/round1-02-audit-S1-logic.md",
  "payload": {
    "slice_id": "S1",
    "reachability": "PROD",
    "files_read": [
      {
        "path": "src/store.js",
        "lines": 120,
        "quote": "this.#persist(value);"
      }
    ],
    "leads": [
      {
        "id": "L1",
        "file": "src/store.js",
        "line": 57,
        "confidence": "HIGH",
        "suspected_dimension": "error-handling",
        "note": "持久化失败时未捕获异常，调用方无从得知写入失败"
      }
    ],
    "lead_count": 1,
    "dimension_histogram": {
      "error-handling": 1
    }
  },
  "error": null
}
```

## 自检

写完产物后运行：

```bash
node <FRAMEWORK_ROOT>/tools/check-payload.mjs <你的产物文件> --role sweep
```
