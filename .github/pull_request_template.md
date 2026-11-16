## What changed and why

<!-- Describe the problem. "fix bug" is not reviewable in six months. -->

## Three-layer check

Most changes here need to land in **all three** places, or the rule has no enforcement:

- [ ] Execution template — `framework/templates/*.md`
- [ ] Contract / schema — `framework/components/output-contract*.md`
- [ ] Validator — `tools/*.mjs` (+ a self-test that proves it fires)

If this change deliberately touches only one layer, say why.

## Verification

- [ ] `node tools/check-all.mjs` passes
- [ ] New/changed rules have a validator, or are marked `DISCRETIONARY` with a reason
      (`node tools/check-rule-ledger.mjs --gate --since HEAD`)
- [ ] No credentials, tokens, or private data anywhere in the diff
- [ ] Docs updated in the same commit as the behaviour change

## Notes for the reviewer

<!-- Anything you are unsure about. It is fine to say "I could not verify X". -->
