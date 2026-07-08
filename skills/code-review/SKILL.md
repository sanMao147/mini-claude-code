---
name: code-review
description: Review code for bugs, security issues, and style problems before merging.
---

# Code Review

When asked to review code:

1. Read the relevant files with `read_file`.
2. Check for: null/undefined access, off-by-one, race conditions, injection, hardcoded secrets.
3. Verify error handling and input validation.
4. Report findings as a prioritized list (critical → minor) with file:line references.
5. Suggest concrete fixes, but do not edit unless explicitly asked.
