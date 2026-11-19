Paseo Context shows context composition, request history, usage trends, file and command activity, and agent collaboration. It reuses the current dsh-context interface and its multicolor palette, with light/dark styles and eight UI languages.

Opening an agent conversation automatically adds Context, Fleet and Statistics workspace tabs, then returns to that conversation. All three appear in the workspace tab bar's + menu; the old composer button is removed. A compact picker appears only for multiple available conversations and shares the selection across the three tabs. Manually closed tabs stay closed during ordinary session updates.

On a cold client, initialization uses the first panel's public navigator to finish creating tabs and return to the conversation. Leaving the source or a slow panel cancels that short-lived return; manually opening a panel later does not jump to another tab. Mobile initialization does not need to open the keyboard.

Statistics reuses the original turn/step table with expandable tool details, time bars, totals, event rows and context controls. Fleet also includes Paseo Subtasks and their recorded statuses. `/context`, `/context fleet` and `/context stats` open the corresponding tabs; `/context modal` opens the modal. Context Insights in the sidebar provides cross-session usage and date filters. These tabs sit alongside agents and files; Paseo has no plugin API for permanent conversation tabs or preventing a workspace tab from closing. Sidebar-only placement opens Context in Explorer; hidden placement disables automatic tab creation.

Requires Paseo 0.16.0 or newer and Node.js 22+ on the daemon. The original interactive UI supports Desktop, web and native iOS/iPadOS, including narrow layouts. Android's separate message bridge is experimental.

The daemon reads local Codex and Claude Code JSONL logs, falling back to Paseo timeline for other sessions. Actual token usage is provider reported; composition, cost and observable timing are estimates. Unlogged schemas, system prompts, provider internals and missing attachment data cannot be reconstructed.

Preferences control panel placement, date range, trends, sorting and fleet visibility. Interactive previews use sample sessions at desktop or phone widths.

Session text travels only through the selected Paseo host's plugin RPC to your own client. Public requests fetch model pricing from models.dev, release/recommendation metadata from GitHub and recommendation icons from their HTTPS sources. If the daemon explicitly has DEEPSEEK_API_KEY, its official balance API is used; no DSH settings or credentials are read. Plugins run with the daemon user's filesystem access.
