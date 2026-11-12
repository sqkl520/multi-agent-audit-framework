# 报告

正文

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "a1",
  "role": "sweep",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "D:\\Projects\\AI prompt\\many-agents_multi-prompt-files_token-heavy\\multi-agent-audit-framework\\tools\\fixtures\\contract-probe/probe/S3-bad-reachability.md",
  "payload": {
    "slice_id": "s1",
    "reachability": "MAYBE",
    "generator_ref": null,
    "files_read": [
      "src/a.js"
    ],
    "files_unreadable": [],
    "leads": [
      {
        "lead_id": "l1",
        "suspected_dimension": "logic",
        "file": "src/a.js",
        "line": 1,
        "quote": "x",
        "why_suspicious": "y",
        "confidence": "HIGH"
      }
    ],
    "lead_count": 1,
    "dimension_histogram": {
      "logic": 1,
      "concurrency": 0,
      "security": 0,
      "error-handling": 0,
      "data-consistency": 0,
      "contract": 0
    }
  },
  "error": null
}
```
