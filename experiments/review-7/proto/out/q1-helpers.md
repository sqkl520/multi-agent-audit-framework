# Q1 — what the "unparsable" bucket really is

Every unparsable call in the tree is either `fail(...)` or a call to a LOCAL helper
(a `private void assertXxx(...)` in the same test class). The plan maps these to
`assertion_unparsable -> WARN` and "strong gate disabled for that file".
The cost of that decision, measured:


helpers called but not defined in the calling file: 0