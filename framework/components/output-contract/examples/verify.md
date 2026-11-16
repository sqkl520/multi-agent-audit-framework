<!--
  自动生成，请勿手改。生成器：tools/gen-contract-examples.mjs
  这份示例**已经过 check-payload.mjs 验证**，可以直接照抄再改。
-->

# verify 角色的最小合规产物

这是能通过校验的最小完整信封。字段含义见 `components/output-contract/verify.md`。
**照抄这份再替换内容**，比从零拼要可靠。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "verify-1",
  "role": "verify",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "<OUTDIR>/round1-02-audit-S1-logic.md",
  "payload": {
    "finding_id": "F1",
    "verdict": "PASS",
    "escalation_required": false,
    "evidence": {
      "method": "mutating_call_site",
      "mutation_check": "performed",
      "mutation_scope": "implementation_and_callsite",
      "observed": "把 renameSync 改回旧行为后，定向测试变红；再把调用点改回旧的直接写入，同样变红；恢复修复后变绿。"
    },
    "notes": "修复有效。两层变异都能复现失败，说明修复点与调用点都参与决定用户可见行为。"
  },
  "error": null
}
```

## 自检

写完产物后运行：

```bash
node <FRAMEWORK_ROOT>/tools/check-payload.mjs <你的产物文件> --role verify
```
