---
"yv": patch
---

Say which secret is missing when a release cannot start.

Without `RELEASE_TOKEN` the Release workflow stopped at `Input required and not
supplied: token` — accurate, and useless: `token` is a required input to
`actions/checkout`, so an unset secret resolves to an empty string rather than
falling back, and the error names neither the secret nor why the workflow wants
one. A preflight step now fails with that explanation instead.
