<!--
  自动生成，请勿手改。生成器：tools/gen-contract-examples.mjs
  这份示例**已经过 check-payload.mjs 验证**，可以直接照抄再改。
-->

# critique 角色的最小合规产物

这是能通过校验的最小完整信封。字段含义见 `components/output-contract/critique.md`。
**照抄这份再替换内容**，比从零拼要可靠。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "critique-1",
  "role": "critique",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "<OUTDIR>/round1-02-audit-S1-logic.md",
  "payload": {
    "critique_role": "skeptic",
    "discipline_audit": {
      "performed": true,
      "log_entries_checked": 3,
      "dispatch_records_checked": 2,
      "undeclared_discretions": [],
      "mechanical_check_failures": [],
      "l0_violations": []
    },
    "verdicts": [
      {
        "finding_id": "F1",
        "verdict": "holds",
        "reason": "独立复现：把文件设为只读后调用 set()，异常确实冒到调用方且无人处理。",
        "five_step": {
          "evidence_opened": true,
          "evidence_supports_claim": true,
          "path_reachable": "true",
          "already_handled": "false",
          "failure_chain_holds": true
        },
        "runtime_applicable": true,
        "runtime_evidence": {
          "method": "adversarial_execution",
          "control_case": "同一段代码在可写目录下调用 set()，写入成功且无异常——证明刚才的失败不是探针本身坏了",
          "observed": "在只读目录下调用 set()，EACCES 直接抛出且无任何捕获",
          "command": "chmod 555 /tmp/x && node -e \"require('./src/store.js').set(1)\""
        },
        "direct_contradiction": null
      }
    ]
  },
  "error": null
}
```

## 自检

写完产物后运行：

```bash
node <FRAMEWORK_ROOT>/tools/check-payload.mjs <你的产物文件> --role critique
```
