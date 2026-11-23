<!--
  自动生成，请勿手改。生成器：tools/gen-contract-examples.mjs
  这份示例**已经过 check-payload.mjs 验证**，可以直接照抄再改。
-->

# recon 角色的最小合规产物

这是能通过校验的最小完整信封。字段含义见 `components/output-contract/recon.md`。
**照抄这份再替换内容**，比从零拼要可靠。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "recon-1",
  "role": "recon",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "<OUTDIR>/round1-02-audit-S1-logic.md",
  "payload": {
    "slice_count": 2,
    "audit_slices": [
      {
        "slice_id": "S1",
        "files": [
          "src/store.js"
        ],
        "reachability_hint": "PROD",
        "entry_point": "src/store.js:12 Store.set",
        "risk_note": "状态写入路径，改动影响面大"
      },
      {
        "slice_id": "S2",
        "files": [
          "src/render.js"
        ],
        "reachability_hint": "PROD",
        "entry_point": "src/render.js:8 render",
        "risk_note": "模板渲染，用户可见输出"
      }
    ],
    "entry_points": [
      {
        "path": "src/store.js:12",
        "location": "src/store.js:12",
        "kind": "public-api",
        "evidence": "export function set(value) {",
        "evidence_quote": "export function set(value) {"
      }
    ],
    "unverified": [],
    "exclusion_report": {
      "included_files": 2,
      "excluded_by_type": {
        ".md": {
          "count": 5,
          "reason": "文档，非源码（合理）"
        },
        ".json": {
          "count": 3,
          "reason": "配置，非源码（合理）"
        }
      },
      "excluded_source_like": [],
      "exclusion_dominant": false
    }
  },
  "error": null
}
```

## 自检

写完产物后运行：

```bash
node <FRAMEWORK_ROOT>/tools/check-payload.mjs <你的产物文件> --role recon
```
