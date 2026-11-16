# Paseo Context

This is a Paseo-only fork of bowenliang123/dsh-context. The user explicitly requested removal of DSH compatibility. Do not restore DSH or Cordis runtime integration or DSH release tooling. The user explicitly requires direct reuse of the current upstream DOM UI and its original multicolor palette, revoking the earlier theme.colors requirement. Preserve src/client components and CSS; adapt only the host seams. The upstream UI uses an isolated web frame on desktop/web and the already registered host RNCWebView on native clients. Never register a second native component or replace the host-wide WebView messaging module. Upstream code remains available through Git history and the upstream remote.

Use shared/core for reusable upstream analysis algorithms, shared/locales for the eight upstream translations, server for Node-only adapters, and client for React Native UI. Root code is limited to the two Paseo entries.

Prioritize complete scope, accurate accounting and explicit provenance. Never present estimated composition as provider-reported context. Read complete sessions; use bounded caches and release resources on teardown. Keep authored files below 1000 lines; vendored/generated third-party artifacts are exempt.

Before committing run npm run check and npm run build, review the complete diff, and use an independent review agent to assess correctness, data integrity, resource cleanup, and cross-platform behavior. Review agents should skip typecheck, lint, and coverage, which the main agent handles. Commit and push completed changes.

Do not initialize CodeGraph; use it first only if .codegraph already exists.
