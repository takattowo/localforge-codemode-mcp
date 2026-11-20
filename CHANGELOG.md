# Changelog

## Unreleased

- `keep({ name: value })` saves plain JSON data that later programs in the same session get as constants (a `Set` as an array, a `Map` as an object); `forget(name)` drops one, `forget()` all. `execute` takes an optional `session` (default `default`) so parallel tasks don't share values. Memory only, at most 50 MB across sessions, least recently kept first out. The reply lists the session's names under `kept`.
- New defaults: 1000 tool calls (was 50) and 120 s (was 60) per program; `timeout_seconds` goes up to 280 s (was 300), since Quick ends a tool call at 300 s.
- The description no longer says shell commands must be literal strings (that rule blocked commands built from search results); its rules are shorter to make room for `keep`.
- A LocalForge restart before the first tool list no longer logs a misleading `ReferenceError`; the startup read gets the new LocalForge's tools.

## 0.2.0

- After LocalForge restarts (it exited, and the next call started it again), its tool list is read again before the calls waiting on it run, so later programs get a newer LocalForge's tools and arguments, and Quick gets the new description the next time it lists tools. A failed list keeps the old tools, with a line on stderr. It used to be read once at startup.
- Only the newest 100 spilled replies (`result-*.json` in `spillDir`) are kept; older ones are deleted after each spill. Other files in the folder are never touched. They used to pile up.
- The rules at the top of the `execute` description are shorter, leaving about 125 characters under Quick's 2,000-character cut for LocalForge to grow (it was about 30). The end-to-end test now fails with fewer than 100 left.
- Needs localforge-mcp 1.11.0 or later.
- Tests run on GitHub Actions (Windows): `bun test` and `bun run typecheck`. The end-to-end test with a real LocalForge is skipped there.

## 0.1.0

- First version: one `execute` tool that runs a JavaScript program through `@opencode/codemode`, whose calls go to a LocalForge child started with Quick's own LocalForge command and env.
