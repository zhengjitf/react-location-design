---
'@tanstack/react-start': patch
'@tanstack/solid-start': patch
'@tanstack/vue-start': patch
---

Fix the `server-entry` package export types path so published packages include the expected declaration files, and add build-time package validation to catch similar export issues during CI.
