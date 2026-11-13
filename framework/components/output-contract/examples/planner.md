<!--
  自动生成，请勿手改。生成器：tools/gen-contract-examples.mjs
  这份示例**已经过 check-payload.mjs 验证**，可以直接照抄再改。
-->

# planner 角色的最小合规产物

这是能通过校验的最小完整信封。字段含义见 `components/output-contract/planner.md`。
**照抄这份再替换内容**，比从零拼要可靠。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "planner-1",
  "role": "planner",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "<OUTDIR>/round1-02-audit-S1-logic.md",
  "payload": {
    "tier": "T2",
    "score": 21,
    "score_breakdown": {
      "size": 5,
      "risk": 6,
      "dependency": 4,
      "ambiguity": 3,
      "churn": 3
    },
    "members": [
      {
        "role": "execute",
        "provider": "inherit",
        "model": "inherit",
        "count": 6,
        "reason": "六个切片并行宽扫"
      },
      {
        "role": "critique",
        "provider": "inherit",
        "model": "inherit",
        "count": 3,
        "reason": "三视角独立锐评"
      }
    ],
    "member_count": 9
  },
  "error": null
}
```

## 自检

写完产物后运行：

```bash
node <FRAMEWORK_ROOT>/tools/check-payload.mjs <你的产物文件> --role planner
```
