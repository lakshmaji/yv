---
"yv": minor
---

Add optional Sentry-backed crash and error reporting, off by default and only enabled in release builds where the DSN secret is configured. Background goroutines and the frontend render tree now recover from panics/crashes instead of taking the whole app down silently.
