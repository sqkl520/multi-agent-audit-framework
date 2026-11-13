<!--
  自动生成，请勿手改。生成器：tools/gen-contract-examples.mjs
  这份示例**已经过 check-payload.mjs 验证**，可以直接照抄再改。
-->

# audit 角色的最小合规产物

这是能通过校验的最小完整信封。字段含义见 `components/output-contract/audit.md`。
**照抄这份再替换内容**，比从零拼要可靠。

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "audit-1",
  "role": "audit",
  "status": "SUCCESS",
  "contract_valid": true,
  "artifact_path": "<OUTDIR>/round1-02-audit-S1-logic.md",
  "payload": {
    "findings": [
      {
        "finding_id": "F1",
        "severity": "HIGH",
        "dimension": "error-handling",
        "evidence": {
          "file": "src/store.js",
          "line": 57,
          "quote": "renameSync(tmp, this.#path);"
        },
        "inference": {
          "claim": "持久化失败被静默吞掉，调用方拿不到失败信号",
          "basis": "renameSync 在跨设备或权限不足时抛异常，而 set() 没有任何 try/catch，异常直接冒到调用方；但调用方按返回值判断成功与否。",
          "alternatives": [
            "如果应用层在调用链上游统一捕获了异常并转成返回值，则问题不成立——需检查 src/api.js:30 saveHandler 的 try/catch 覆盖范围",
            "如果 renameSync 的失败已被 node:fs 的默认行为静默处理，则不会抛异常——需在只读目录实测一次"
          ]
        },
        "status": "CONFIRMED"
      }
    ],
    "self_checks": {
      "identifier_reconcile": {
        "status": "DONE",
        "note": "文件中 7 个标识符全部能在源码里找到定义；`renameSync` 的导入缺失已单列为一条发现"
      },
      "self_check_audit": {
        "status": "DONE",
        "note": "用 3 个用例跑过自检脚本，未发现自身误报"
      },
      "runtime_validation": {
        "status": "DONE",
        "note": "在只读目录下调用 set()，观察到 EACCES 未被捕获，证实发现成立"
      }
    }
  },
  "error": null
}
```

## 自检

写完产物后运行：

```bash
node <FRAMEWORK_ROOT>/tools/check-payload.mjs <你的产物文件> --role audit
```
