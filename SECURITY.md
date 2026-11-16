# Security Policy

## What this repo is (and what "a vulnerability" means here)

This is a **prompt framework plus dependency-free Node.js validators**. It ships no
service, listens on no port, and has no runtime dependencies. The realistic security
concerns are therefore narrower than for an application:

| Class | Example | In scope |
|---|---|---|
| **Credential leak in git history** | an API key committed and later deleted | **Yes — highest priority** |
| **Validator bypass** | a rule the contract marks mandatory that the checker silently skips | **Yes** |
| **Arbitrary code execution via an artifact** | a validator that shells out using unescaped artifact content | **Yes** |
| **Denial of service against a validator** | catastrophic regex backtracking on a crafted artifact | **Yes** |
| Vulnerabilities in the audited target repo | — | **No** — out of scope, report to that project |

## How to report

**Do not open a public issue.**

Use GitHub's private advisory flow:
**Security → Advisories → "Report a vulnerability"**
(<https://github.com/sqkl520/multi-agent-audit-framework/security/advisories/new>)

If you cannot use that, email the address on the maintainer's GitHub profile and
put `SECURITY` in the subject line.

Please include: affected commit or file, the input that triggers it, and what you
observed versus what the contract says should happen.

## What to expect

| Stage | Target |
|---|---|
| Acknowledgement that the report was received | **within 3 days** |
| Initial assessment (in scope? severity?) | **within 7 days** |
| Fix or mitigation for a confirmed credential leak or validator bypass | **within 30 days** |

This is a single-maintainer, spare-time project. If a timeline slips you will be told,
rather than left waiting.

## If you find a leaked credential

Tell us **the commit hash and the credential prefix only** — do not paste the full
secret into an issue, a PR, or an advisory body. We will rotate it and rewrite history.

Note that this repo has already had one such incident: four provider API keys reached
local commits and were scrubbed by rewriting all history before anything was pushed.
That is why history rewriting is treated here as an established, acceptable response —
deleting a secret in a later commit is **not** sufficient, because the object remains
reachable in the packfile.

## Supported versions

There are no tagged releases yet; the `main` branch is the supported version.
