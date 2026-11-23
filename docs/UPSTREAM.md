# Upstream maintenance

This is a public GitHub fork of bowenliang123/dsh-context. The initial Paseo migration is based on `9e221195ac7c02cff9a21311dda6d61f50cf50d3` (v0.85.1 plus its next fix).

Paseo Context v0.2.14 uses upstream `fa98a621e7aabdebdb04fc935221a4ba5bf72883` (v0.87.1) as its baseline. This update brings Context Timeline, workflow milestones, and history pagination. `api/paseo-context/history` serves requests, events, milestones, nodes, archive, files, and timing spans from the same context projection as facts and detail. Sequence pages keep rows with the same sequence together. Workflow milestones use recorded tool calls, delegation, and task transitions. The settings bridge exposes `defaultTimelineMode` while preserving the stored `defaultTrendMode` preference.

Both `history.live` and `facts.live` are `true` for Paseo's unified, revisioned projection, including idle and archived sessions. The client detail store uses `rev` to match and refresh pages. The agent's running state is reported separately in the session row.

Paseo Context v0.2.8 merges upstream `504bbac49dcaa5d7933027263bfa65178cdc2d48` (v0.86.0 plus subsequent fixes). Project distribution, scan progress and retries use the Paseo overview corpus. The upstream DSH log workers, persisted projection shards, and benchmark harness are tied to its own event stream and storage. Paseo continues to read native logs incrementally and uses Paseo timeline fallback, with public pricing and recommendation catalogs cached separately on disk.

Keep the original component and stylesheet paths under `src/client`. Changes there should be limited to module imports, brand text and host calls. Preserve upstream layout, chart algorithms and CSS. The static primitives, store, language/path utilities and base theme under `web/vendor` originate from DeepSeek's MIT packages at `0.2.0-rc.2`; they are UI assets, not a host compatibility layer.

```sh
git remote add upstream https://github.com/bowenliang123/dsh-context.git
git fetch upstream
git switch -c sync/upstream
git merge upstream/main
```

Skip `remote add` if the remote already exists. Merge on a branch and review conflicts before merging into main.

Protect the Paseo-only runtime entries, manifest, package metadata, build scripts and documentation. Do not restore `src/host`, Cordis registration, DSH compatibility matrices, account/credential access, original release tooling or the original package name.

When upstream shared algorithms change, update their copies under `shared/core` used by daemon code. Keep `shared/locales` synchronized with the eight Paseo-branded dictionaries in `src/client`. When updating the UI primitives, preserve their complete license texts and rebuild the bundled third-party notices.

The native adapter uses Paseo's already registered RNCWebView component. Verify native registration and commands when updating Paseo. Android uses acknowledged same-document history events rather than replacing the host's global WebView emitter.

Native HTML is passed directly to `loadDataWithBaseURL` using a per-frame `https://paseo-context.invalid/<nonce>/` origin. Chromium may report an empty HTML data URL for the same local document. Recognize that form in Android load and history events while keeping the navigation-request check scoped to the frame URL and `about:blank`. Cold tab initialization obtains public navigation during the first panel's layout commit.

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
