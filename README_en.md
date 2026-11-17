# Paseo Context

[简体中文](README.md)

Context insights for Paseo, forked from [bowenliang123/dsh-context](https://github.com/bowenliang123/dsh-context). The plugin bundles the current upstream React components, styles, charts, context browser and eight translations, connected to Paseo data through host adapters.

It keeps the upstream multicolor palette and light/dark styles. The interface is reused from source, rather than reconstructed from screenshots.

The following screenshots show the running plugin with generated sample records:

![Context panel](docs/screenshots/context.png)
![Agent fleet](docs/screenshots/fleet.png)

## Install

Requires Paseo **0.16.0+** and Node.js 22+ on the daemon machine. The original interactive interface runs in Desktop, web and native iOS/iPadOS using Paseo's bundled WebView. The iPad client has completed a live rendering handshake. Android uses a separate message transport and remains experimental. Narrow layouts use the upstream responsive styles.

After enabling plugins in Paseo:

```sh
paseo plugin install git:kogekiplay/paseo-context
```

The same source can be entered in Settings → Plugins. Git installation builds the original interface from source. A remote installation reads sessions on the selected remote daemon.

For local development:

```sh
git clone https://github.com/kogekiplay/paseo-context.git
cd paseo-context
npm ci --ignore-scripts
npm run build
paseo plugin install "$PWD"
```

After editing, build again and run `paseo plugin reload paseo-context`.

## Features

- Context panels in workspace tabs and Explorer: composition, usage, timing, trends, steps/turns, full/incremental views and comparison against the previous step or turn.
- Original context browser: DNA, grouped rows, treemap, filtering, content expansion, system prompts and captured tool schemas.
- File activity and commands: reads, writes, searches, counts, line changes, failures, duration and background process state.
- Fleet: agent network, communication timeline, delegations, captured tasks/dependencies, Paseo Subtasks, prompts and replies. Subtasks come directly from Paseo's timeline, retain running/completed/failed/canceled status and link to existing children.
- Context Insights: session usage, date ranges, heatmap, skill/tool/program rankings, search, archive and directory filters.
- Context, Fleet and Statistics workspace tabs are added automatically when an agent conversation is opened, then focus returns to that conversation. The Context composer button is removed. All three entries are available in the workspace tab bar's **+** menu.

Tab initialization uses public navigation to return to the original agent. A cold client opens its first panel, uses that panel's layout commit to create the remaining panels, then returns to the conversation. This short-lived handoff is canceled if the source is left, the panel takes too long or the plugin stops. Opening a panel later cannot trigger a delayed return. Returning on mobile does not need to focus the input or open the keyboard.
- Statistics reuses the original turn/step table, tool details, time bars, totals, event rows, context deltas, latest/cumulative context and expand controls. It covers the complete session; unrecorded first-token and decode-speed fields remain unknown.
- `/context`, `/context fleet` and `/context stats` open the corresponding tabs. `/context insights` opens cross-session insights, and `/context modal` opens the modal.
- Original preferences for placement, fleet/insights visibility, date range, granularity, comparison baseline and sorting.

These native Paseo workspace tabs sit alongside agents, terminals and files. Each workspace has one of each. A compact picker appears only for multiple available conversations; the shared selection persists in tab state. Each agent initializes its tabs once per client plugin lifetime, so ordinary session updates do not reopen manually closed tabs. Paseo has no plugin API for permanent conversation tabs or preventing a workspace tab from closing.

Sidebar-only placement opens Context in Explorer and automatically adds only Fleet and Statistics. Hidden placement disables automatic tab creation. Disabling Fleet removes its menu entry and stops adding it automatically. Existing agent-specific tabs from earlier versions remain supported.

Prompt prefix/suffix settings apply to **new agents' systemPrompt**. They do not rewrite existing agents or dynamically modify each provider request; Paseo has no equivalent dynamic system-section hook.

Pages fetch only their required data. Context paints the selected session before independently completing family costs; Fleet transfers graph summaries and reads full messages on demand; Statistics loads only its original table data. Unchanged sessions skip full retransmission and redraws, hidden documents pause page polling, and Settings does not poll sessions. Syntax grammars load through the local host on demand with all original languages retained. Public pricing requests do not block dashboard startup.

## Data and limits

The daemon reads complete local Codex rollout and Claude Code JSONL records when available, preserving historical billed requests, compaction replacement history, rollbacks and tool results. Other providers and sessions without native logs use paginated Paseo timeline fallback.

Actual usage means provider-reported usage. Colored composition uses the upstream fixed-density text estimate. Unlogged system prompts, schemas, encrypted reasoning, server injections and internal timing phases cannot be reconstructed. Empty values are not evidence of zero usage. Timeline fallback exposes less information.

Costs use public model pricing and remain unknown for unmatched models. Timing comes from observable request/tool intervals, distinguishing aggregate parallel tool work from elapsed busy time. Speed uses output samples with matching available timing. These are estimates, not account bills or complete provider traces.

Native usage and timing reference [CC Switch](https://github.com/farion1231/cc-switch/tree/ed6d51e590ff8a34431ca60eacfc78e12704075b). Codex prefers exact `last_token_usage`, accepts cache-read aliases, and falls back to cumulative deltas when per-request data is absent. Codex input already includes cache. Model and first-token timing are estimates from session timestamps; a delayed usage flush excludes tool waiting. Without output-start evidence, first-token timing and generation speed remain unavailable. Statistics preserves missing fields separately from reported zero, including cache reads and writes. Live and interrupted steps remain visible without usage.

Fleet relationships and task/communication fields reflect captured Paseo/native records. Unavailable provider team internals are left unavailable.

DSH/Cordis runtime integration, account wallets, resource protocols, file manager and built-in host pages are removed. File operations use Paseo Context previews with the upstream rich-text viewer: current text files up to 2 MiB and image files up to 20 MiB. Images retained in native records can be viewed directly. Missing attachments and unsupported binary formats are reported as unavailable.

## Data access

Session text travels from the selected Paseo host to your own client using plugin RPC. It is not sent to third-party analytics. The UI is bundled locally in an isolated frame and does not load remote scripts.

Public metadata requests fetch model pricing from `models.dev`, this fork's latest GitHub release and upstream recommendation card data. Recommendation icons can load from their HTTPS image sources. Those requests contain no session text. HTTPS image URLs already referenced by a session are fetched by the client only when that image preview is expanded.

If the daemon explicitly has `DEEPSEEK_API_KEY`, the balance capsule uses only the official `https://api.deepseek.com/user/balance` endpoint. Otherwise it is hidden. The key is not sent to the client or other sites. No DSH settings or credentials are read.

Plugins run as trusted local code with the daemon user's filesystem access. Configured prompt prefixes/suffixes are sent to the selected model provider as part of new agents' system prompts.

## Development and upstream

```sh
npm run check
npm run build
```

`src/client` and `src/shared` preserve the upstream layout. `web/` builds the original DOM UI and its bridge; `client/` contains the Paseo wrapper; `server/` contains native log/SDK adapters; `shared/core/` contains reusable upstream algorithms for the daemon.

The public GitHub fork retains upstream history. Baseline: **`9e221195ac7c02cff9a21311dda6d61f50cf50d3`**, immediately after v0.85.1. See [docs/UPSTREAM.md](docs/UPSTREAM.md) for merging updates.

## License

Apache-2.0. See [LICENSE](LICENSE), [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Static upstream primitives/theme/store modules in `web/vendor/` retain their MIT notices and do not require a DSH or Cordis host.
