Paseo Context shows context composition, request history, usage trends, file and command activity, and agent collaboration. It reuses the current dsh-context interface and its multicolor palette, with light/dark styles and eight UI languages.

Open Context or Fleet from an agent panel, use the Context composer button or `/context`, or open Context Insights from the sidebar for cross-session usage and date filters.

Requires Paseo 0.15.4 or newer and Node.js 22+ on the daemon. The original interactive UI supports Desktop, web and native iOS/iPadOS, including narrow layouts. Android's separate message bridge is experimental.

The daemon reads local Codex and Claude Code JSONL logs, falling back to Paseo timeline for other sessions. Actual token usage is provider reported; composition, cost and observable timing are estimates. Unlogged schemas, system prompts, provider internals and missing attachment data cannot be reconstructed.

Preferences control panel placement, date range, trends, sorting and fleet visibility. Prompt prefix/suffix settings apply to new agents' system prompts and are sent to their chosen providers.

Session text travels only through the selected Paseo host's plugin RPC to your own client. Public requests fetch model pricing from models.dev, release/recommendation metadata from GitHub and recommendation icons from their HTTPS sources. If the daemon explicitly has DEEPSEEK_API_KEY, its official balance API is used; no DSH settings or credentials are read. Plugins run with the daemon user's filesystem access.
