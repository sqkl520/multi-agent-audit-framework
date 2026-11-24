# 报告

正文

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "a1",
  "role": "recon",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "R2-silent-truncation.md",
  "payload": {
    "slice_id": "s1",
    "files": [
      "src/a.js"
    ],
    "file_count": 1,
    "line_count": 100,
    "oversized_file": false,
    "undersized": true,
    "reachability_hint": "PROD",
    "exclusion_report": {
      "excluded_source_like": [],
      "exclusion_dominant": false
    },
    "entry_points": [
      {
        "entry_id": "e1",
        "kind": "EXPORTED_SYMBOL",
        "location": "src/a.js:1",
        "trigger": "t",
        "next_hop": "n",
        "evidence_quote": "export function f() {"
      }
    ],
    "entry_points_truncated": true,
    "covered_modules": [],
    "harness_concurrency_cap": 4,
    "root_dir": "src",
    "is_entry_slice": true,
    "shared_dependencies": [],
    "audit_slices": [
      {
        "slice_id": "s1"
      }
    ],
    "slice_count": 1,
    "unverified": []
  },
  "error": null
}
```
