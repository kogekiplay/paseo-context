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

Adapt changes in the upstream DTO contract at `server/upstream.ts`, `server/ui-routes.ts` and the fleet adapter, rather than modifying visual components to fit incomplete data. Native record adaptation lives in `server/fold.ts`, `server/normalize.ts` and `server/reader.ts`.

```sh
npm ci --ignore-scripts
npm run check
npm run build
paseo plugin reload paseo-context
```

Verify current and historical context, request selection while new data arrives, full content, compaction/rollback, date filters, paging, commands, fleet recipients/tasks, settings, dark styles and narrow browser layouts. Update both READMEs, overviews and the baseline in this file after accepting an upstream merge.
