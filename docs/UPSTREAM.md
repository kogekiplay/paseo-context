# Upstream maintenance

This is a public GitHub fork of bowenliang123/dsh-context. The initial Paseo migration is based on `9e221195ac7c02cff9a21311dda6d61f50cf50d3` (v0.85.1 plus its next fix).

Keep the original component and stylesheet paths under `src/client`. Changes there should be limited to module imports, brand text and host calls. Preserve upstream layout, chart algorithms and CSS. The static primitives, store, language/path utilities and base theme under `web/vendor` originate from DeepSeek's MIT packages at `0.2.0-rc.2`; they are UI assets, not a host compatibility layer.

```sh
git remote add upstream https://github.com/bowenliang123/dsh-context.git
git fetch upstream
git switch -c sync/upstream
git merge upstream/main
```

Skip `remote add` if the remote already exists. Merge on a branch and review conflicts before merging into main.

Protect the Paseo-only runtime entries, manifest, package metadata, build scripts and documentation. Do not restore `src/host`, Cordis registration, DSH compatibility matrices, account/credential access, original release tooling or the original package name.

When upstream shared algorithms change, update their copies under `shared/core` used by daemon code. When updating the UI primitives, preserve their complete license texts and rebuild the bundled third-party notices.

The native adapter uses Paseo's already registered RNCWebView component. Verify native registration and commands when updating Paseo. Android uses acknowledged same-document history events rather than replacing the host's global WebView emitter.

Native HTML is passed directly to `loadDataWithBaseURL` using a per-frame `https://paseo-context.invalid/<nonce>/` origin, never fetched. Android treats an `about:blank` base as a data URL on some versions, which breaks the history bridge and navigation guard. Permit only the exact frame URL and its hash history; keep external and cross-frame navigation blocked. Cold tab initialization obtains public navigation during the first panel's layout commit instead of relying on a retained input's stale visibility ref.

The separate Statistics tab reuses the MIT `packages/experimental/client-ui-stats` view from `deepseek-ai/deepseek-harness` at `39163dd30f703a79079e2d2446545cff3c453738` (package 0.2.2-rc.3). Static table, view, CSS and translations live in `web/vendor/statistics`; pure contracts and aggregation live in `shared/core/stats-*`. Host imports and type seats are local, with no DSH/Cordis runtime. Preserve its CSS and visual components, and adapt captured facts in `server/statistics.ts`. The original composer overlay spacing is disabled through the wrapper's CSS variable.

Paseo Subtasks come from the public agent timeline's `tool_call` items with `detail.type: "sub_agent"`. `server/subtasks.ts` reads every history page and keeps the latest version of each call ID; the fleet adapter associates it with an existing child instead of inventing a second agent.

Native usage and timestamp boundary handling also reference the MIT CC Switch implementation at `ed6d51e590ff8a34431ca60eacfc78e12704075b`, `src-tauri/src/services/session_usage{,_codex}.rs`. The TypeScript adapter preserves missing-field provenance instead of inheriting that implementation's database zero defaults. Codex uses exact `last_token_usage` when present, cache-read aliases, and cumulative deltas as a fallback. Timing is a session timestamp estimate; delayed usage flushes must not charge tool waiting to model latency. Lazy Statistics details share the step ledger and content revision with the summary; neither live nor interrupted steps depend on usage being present.

Adapt changes in the upstream DTO contract at `server/upstream.ts`, `server/ui-routes.ts` and the fleet adapter, rather than modifying visual components to fit incomplete data. Native record adaptation lives in `server/fold.ts`, `server/normalize.ts` and `server/reader.ts`.

The offline build rewrites the vendored primitive's grammar imports in `scripts/grammars.mjs`: all 60 grammar modules become compressed JSON in the server bundle and load through the nonce-bound data bridge only when requested. No language support or original CSS is removed. Check this seam when updating the vendored module. Complete Context projections retain `detailRev` for delta invalidation and carry `paseoComplete` so `timelineSource.ts` skips redundant fact reads. Graph projections intentionally omit body arrays; full detail/facts/history routes remain available. Context family costs refresh independently after the selected session, without reading Paseo subtasks on that path.

```sh
npm ci --ignore-scripts
npm run check
npm run build
paseo plugin reload paseo-context
```

Paseo narrow-screen overrides live in `web/mobile.css`, imported after the original styles. Keep the upstream component CSS intact. The forest layout also clamps single-leaf slots to measured width; retain that boundary fix on upstream merges. Check narrow cold startup, width changes, single-child chains, table horizontal scrolling and footer controls in WebKit and Chromium. Browser engine checks do not replace physical-device verification.

Verify current and historical context, request selection while new data arrives, full content, compaction/rollback, date filters, paging, commands, fleet recipients/tasks, settings, dark styles and narrow browser layouts. Update both READMEs, overviews and the baseline in this file after accepting an upstream merge.
