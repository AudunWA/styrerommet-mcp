# Styrerommet MCP

A local MCP server for Styrerommet, Vibbo, Cantor, Arkiv and OBOS Mitt Bygg. Read board meetings, residents, invoices, accounts and documents; manage suppliers, HMS deviations and maintenance; edit unpublished Vibbo handbook drafts.

Uses MCP SDK v2 and protocol **2026-07-28**, with compatibility for 2025 clients. Generic GraphQL tools accept cataloged queries only.

## Install

You need an OBOS account with access to your cooperative, plus Chrome or Edge for browser login. For **Claude Desktop**, use the [bundle installation](#claude-desktop) below. For npm and other clients, install [Node.js 24+](https://nodejs.org/).

**Before the first npm release:** use [Development](#development) below. Once `0.1.0` is published, open a terminal and sign in:

```sh
npx --yes styrerommet-mcp@0.1.0 --auth
```

For faster reauthentication, choose **Vipps** and enable **“Remember me in this browser”** in the login window. Complete the browser login and wait for confirmation. Your cooperative is detected automatically. Then connect your client below; clients use the same saved login. No API key or repository clone is required for the npm installation. Playwright uses your installed browser and does not download one.

## Clients

### ChatGPT Desktop

1. Open **Settings → MCP servers → Add server**.
2. Choose **STDIO** and enter:

   | Field | Value |
   | --- | --- |
   | Name | `styrerommet` |
   | Command | `npx` |
   | Arguments | `--yes`, `styrerommet-mcp@0.1.0` (two arguments) |

3. Save, then select **Restart**. Type `/mcp` in the composer to confirm the connection.

Use a chat running on your local computer. Workspace policies may restrict local servers. [Official setup](https://learn.chatgpt.com/docs/extend/mcp#configure-in-the-chatgpt-desktop-app).

### Claude Desktop

After the first GitHub Release finishes, [download Styrerommet for Claude Desktop](https://github.com/AudunWA/styrerommet-mcp/releases/latest/download/styrerommet-mcp.mcpb).

1. Open the `.mcpb` file with Claude Desktop and approve installation. Alternatively, use **Settings → Desktop app → Extensions → Manage → Advanced settings → Install Extension…**.
2. Start a chat and ask: “Sign in to Styrerommet using `login_interactive`.” Choose **Vipps** and enable **“Remember me in this browser”** when prompted.
3. Try: “Show my organization and upcoming board meetings.”

The bundle includes the server and production dependencies, so npm installation is unnecessary. It requires Claude's Node runtime to support **Node.js 24+**; use the manual setup below if your Claude version's runtime is older. To update a downloaded bundle, install the new `.mcpb` from the same link. Disable any existing manual `styrerommet` entry before installing the bundle to avoid duplicate servers.

<details>
<summary>Manual setup with Node.js 24+ and npm</summary>

Open **Settings → Developer → Edit Config**. In newer layouts, look for **Local MCP servers** under **Settings → Desktop app → Extensions → Manage**. Merge this into `claude_desktop_config.json`, preserving any existing servers:

```json
{
  "mcpServers": {
    "styrerommet": {
      "command": "npx",
      "args": ["--yes", "styrerommet-mcp@0.1.0"]
    }
  }
}
```

The configuration file lives at:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Save, fully quit Claude, and reopen it. Check **+ → Connectors** for `styrerommet`. [Official setup](https://modelcontextprotocol.io/docs/develop/connect-local-servers), [current settings layout](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop).

</details>

### Codex

```sh
codex mcp add styrerommet -- npx --yes styrerommet-mcp@0.1.0
```

Local Codex clients and ChatGPT Desktop share MCP configuration on the same host.

### Claude Code

```sh
claude mcp add --scope user --transport stdio styrerommet -- npx --yes styrerommet-mcp@0.1.0
```

**Windows:** use command `cmd` with arguments `["/c", "npx", "--yes", "styrerommet-mcp@0.1.0"]` in desktop configuration. For CLI setup, put `cmd /c npx --yes styrerommet-mcp@0.1.0` after `--`.

**Troubleshooting:** verify `node --version` reports 24 or newer, and run the sign-in command in a terminal first. If the app cannot find `npx`, use its absolute path (`command -v npx` on macOS/Linux, `where npx` on Windows), then restart the app. Keep the package version pinned in your configuration and update it when upgrading.

Try: “Show my organization and upcoming board meetings.”

## Privacy, GDPR and service terms

The server runs locally, but tool results are passed to your AI client and may be sent to its model provider. Styrerommet, Vibbo and connected services can expose residents' personal details, financial records and confidential board documents.

Before sharing personal data, confirm your cooperative authorizes the use and has a GDPR legal basis. Retrieve only what is needed; anonymize where possible. Assess the AI provider's retention, use for model training, transfers outside the EEA and need for a data processing agreement. Account access alone does not authorize onward disclosure.

Follow [Styrerommet's terms](https://styrerommet.no/bruksvilkar), [Vibbo's terms and privacy notice](https://vibbo.no/personvernerklaering), [OBOS's group privacy notice](https://www.obos.no/om-obos/personvern) and [OBOS Eiendomsforvaltning's privacy notice](https://www.obos.no/om-obos/personvern/personvernerklaring-for-obos-eiendomsforvaltning-as), plus your AI provider's terms. The MIT license covers this server's code; it does not override confidentiality duties, service terms or rights to the data.

## Credentials and access

Cookies and a dedicated browser profile are stored under `styrerommet-mcp` in your platform's application-data directory: `~/Library/Application Support` on macOS, `%LOCALAPPDATA%` on Windows, or `${XDG_DATA_HOME:-~/.local/share}` on Linux. Credentials are plaintext; files use owner-only permissions on POSIX. Protect this directory and never share it.

Set `STYREROMMET_ENV_PATH` to use a different credential file; project `.env` files are not loaded automatically. See [.env.example](https://github.com/AudunWA/styrerommet-mcp/blob/main/.env.example) for overrides. Use `--auth mittbygg` to refresh only Mitt Bygg, or `NO_AUTO_LOGIN=true` to prevent automatic browser prompts.

Write tools change real records, and upload/download tools access local files with your OS permissions. Keep client approvals enabled. Vibbo topic edits remain unpublished drafts.

## Tools

**Read** tools retrieve information. **Write** tools change records or save local files and credentials. Vibbo topic changes remain unpublished drafts.

<details>
<summary>Show all 137 tools</summary>

| Name | Description |
| --- | --- |
| `add_attachment_to_hms_deviation` | **Write** — Upload and attach a file to a deviation. |
| `add_supplier_contact` | **Write** — Add a supplier contact. |
| `add_supplier_contract` | **Write** — Create a supplier contract. |
| `add_supplier_contract_attachment` | **Write** — Link an uploaded attachment to a contract. |
| `add_supplier_document` | **Write** — Link an uploaded document to a supplier. |
| `analyze_apartment` | **Read** — Ownership, occupancy, area and shared costs for a unit. |
| `analyze_maintenance_financing` | **Read** — Assess maintenance financing using Mitt Bygg plans and Cantor figures. |
| `analyze_supplier_costs` | **Read** — Summarize spending and invoice counts by supplier. |
| `cantor_get_account_comments` | **Read** — Accountant and board comments on accounts. |
| `cantor_get_budget` | **Read** — Annual and monthly budgets, prior figures and lock status. |
| `cantor_get_budget_specifications` | **Read** — Budget line items for an account. |
| `cantor_get_chart_of_accounts` | **Read** — The cooperative's chart of accounts. |
| `cantor_get_company_info` | **Read** — Cantor company details and available reporting periods. |
| `cantor_get_dashboard_summary` | **Read** — Income, costs, results, budget variance and liquidity. |
| `cantor_get_dimensions` | **Read** — Accounting dimensions configured in Cantor. |
| `cantor_get_felleskostnader_forecast` | **Read** — Forecasts and recommended increases in common charges. |
| `cantor_get_monthly_actuals` | **Read** — Monthly actuals, rolling totals and year-to-date figures. |
| `cantor_get_trial_balance` | **Read** — Account balances, comparisons and forecasts. |
| `cantor_list_dashboard_widgets` | **Read** — Available financial dashboard widgets and reports. |
| `create_hms_deviation` | **Write** — Create a health and safety deviation, optionally with attachments. |
| `delete_hms_deviation` | **Write** — Delete a health and safety deviation. |
| `download_archive_file` | **Write** — Save an archive file locally. |
| `download_archive_zip` | **Write** — Save an archive folder or collection as a local ZIP file. |
| `download_document` | **Write** — Save a Styrerommet or Vibbo document to a local file. |
| `download_invoices` | **Write** — Save invoice attachment PDFs to local files. |
| `get_announcements` | **Read** — Styrerommet news and dashboard announcements. |
| `get_archive_file_details` | **Read** — Metadata for an archive file or folder. |
| `get_archive_file_revisions` | **Read** — An archive file's previous versions and metadata. |
| `get_audit_logs` | **Read** — The cooperative's activity and change log. |
| `get_economy` | **Read** — Bank accounts, balances, loans and finance contacts. |
| `get_expense` | **Read** — Details of an out-of-pocket expense. |
| `get_general_assembly` | **Read** — Details of a general assembly. |
| `get_hms_overview` | **Read** — Health and safety routines, risks and deviations. |
| `get_insurance_case` | **Read** — An insurance claim, messages and affected residents. |
| `get_insurance_overview` | **Read** — Insurance policies, documents and claims. |
| `get_invoice` | **Read** — Invoice details, attachments and comments. |
| `get_loan_repayment_plan` | **Read** — Loan repayment and amortization schedules. |
| `get_maintenance_project` | **Read** — Details of a building or maintenance project. |
| `get_meeting` | **Read** — Meeting agenda, attendees and minutes. |
| `get_meeting_issue` | **Read** — An agenda item's description, decisions, history and attachments. |
| `get_operation_schema` | **Read** — A Styrerommet query's fields and parameters. |
| `get_other_object_details` | **Read** — Details of a non-apartment property unit. |
| `get_resident_contact_details` | **Read** — A resident's contact details, roles and communication consents. |
| `get_sms_dispatches` | **Read** — Sent SMS messages and delivery statistics. |
| `get_supplier_details` | **Read** — A supplier's spending, contracts and contacts. |
| `get_task_details` | **Read** — A board task's description, assignments and attachments. |
| `get_transactions` | **Read** — Transactions for a bank account. |
| `get_viewer` | **Read** — Current user, cooperative, roles and permissions. |
| `graphql` | **Read** — Run a cataloged read-only Styrerommet GraphQL query. |
| `list_active_invoices` | **Read** — Invoices awaiting approval in Semine. |
| `list_apartments` | **Read** — Apartment numbers, areas, rooms and shared costs. |
| `list_archive_files` | **Read** — Arkiv files and folders. |
| `list_board_tasks` | **Read** — Active or completed board tasks. |
| `list_documents` | **Read** — Shared documents from Styrerommet and Vibbo. |
| `list_expenses` | **Read** — Out-of-pocket expenses, payees, status and amounts. |
| `list_general_assemblies` | **Read** — Annual meetings and general assemblies. |
| `list_maintenance_projects` | **Read** — Building and maintenance projects, costs and status. |
| `list_meeting_issues` | **Read** — Board meeting agenda items and cases. |
| `list_meetings` | **Read** — Board meetings, dates and signing status. |
| `list_operations` | **Read** — Available read-only Styrerommet GraphQL operations. |
| `list_other_objects` | **Read** — Commercial units, storage rooms and parking spaces. |
| `list_planned_meetings` | **Read** — Upcoming board meetings. |
| `list_residents` | **Read** — Combined resident information from Styrerommet and Vibbo. |
| `list_supplier_contracts` | **Read** — Supplier contracts and renewal dates. |
| `list_suppliers` | **Read** — Suppliers, contact information and categories. |
| `login_interactive` | **Write** — Open browser sign-in and save session credentials locally. |
| `mittbygg_add_building_part_history` | **Write** — Record completed maintenance or rehabilitation. |
| `mittbygg_assign_task` | **Write** — Assign or unassign a maintenance task. |
| `mittbygg_create_measure` | **Write** — Add a board maintenance measure to the plan. |
| `mittbygg_create_measure_from_recommendation` | **Write** — Turn a recommendation into a planned maintenance measure. |
| `mittbygg_create_task` | **Write** — Create a board maintenance task. |
| `mittbygg_delete_building_part_history` | **Write** — Delete a maintenance history entry. |
| `mittbygg_delete_document` | **Write** — Delete a building document and its metadata. |
| `mittbygg_delete_measure` | **Write** — Delete a board-created maintenance measure. |
| `mittbygg_dismiss_recommendation` | **Write** — Dismiss an automated maintenance recommendation. |
| `mittbygg_get_building_part_details` | **Read** — A building component's condition and maintenance details. |
| `mittbygg_get_building_parts` | **Read** — Building components and their condition status. |
| `mittbygg_get_company_info` | **Read** — Property and building master data from OBOS and Kartverket. |
| `mittbygg_get_condition` | **Read** — Condition scores, urgent issues and remaining component lifespans. |
| `mittbygg_get_condition_report` | **Read** — The building condition report and inspection findings. |
| `mittbygg_get_documents` | **Read** — Building and maintenance documents. |
| `mittbygg_get_maintenance_plan` | **Read** — Planned maintenance, recommendations and historical work. |
| `mittbygg_get_overview` | **Read** — Property condition and maintenance summary. |
| `mittbygg_get_tasks` | **Read** — Operational maintenance tasks and board assignments. |
| `mittbygg_reactivate_recommendation` | **Write** — Reactivate a dismissed recommendation. |
| `mittbygg_set_building_part_relevance` | **Write** — Mark a building component as relevant or irrelevant. |
| `mittbygg_update_building_name` | **Write** — Change or reset a building's display name. |
| `mittbygg_update_building_part_history` | **Write** — Update a maintenance history entry. |
| `mittbygg_update_document` | **Write** — Update building document metadata. |
| `mittbygg_update_measure` | **Write** — Update a maintenance measure's scope, schedule, cost or status. |
| `mittbygg_update_task` | **Write** — Update a maintenance task's status, comments or year. |
| `mittbygg_upload_document` | **Write** — Upload a building document with optional analysis and metadata. |
| `read_archive_file` | **Read** — Read archive document text into memory. |
| `remove_supplier_contact` | **Write** — Delete a supplier contact. |
| `remove_supplier_contract` | **Write** — Delete a supplier contract. |
| `remove_supplier_contract_attachment` | **Write** — Remove an attachment link from a contract. |
| `remove_supplier_document` | **Write** — Remove a document link from a supplier. |
| `reopen_hms_deviation` | **Write** — Reopen a resolved deviation. |
| `resolve_hms_deviation` | **Write** — Resolve a deviation with a resolution comment. |
| `search` | **Read** — Search meetings, tasks, documents and other Styrerommet records. |
| `search_archive_files` | **Read** — Search archive names and document contents. |
| `search_invoices` | **Read** — Search invoices by supplier, date and other filters. |
| `set_supplier_favourite` | **Write** — Add or remove a supplier from the board's favorites. |
| `update_supplier_contact` | **Write** — Update a supplier contact. |
| `update_supplier_contract` | **Write** — Update a supplier contract. |
| `update_supplier_notes` | **Write** — Update internal supplier notes. |
| `vibbo_add_topic_form_draft` | **Write** — Create and attach a new form to an unpublished draft. |
| `vibbo_create_topic_draft` | **Write** — Create an unpublished resident handbook topic. |
| `vibbo_delete_topic_draft` | **Write** — Delete an unpublished resident handbook topic. |
| `vibbo_edit_topic_draft_sections` | **Write** — Insert, edit, move or remove sections in an unpublished draft. |
| `vibbo_get_activity_stream` | **Read** — Recent posts, comments and community activity. |
| `vibbo_get_assembly_proposals` | **Read** — Resident proposals for the general assembly. |
| `vibbo_get_event` | **Read** — Event details, RSVPs and comments. |
| `vibbo_get_news` | **Read** — The full content of a news article. |
| `vibbo_get_operation_schema` | **Read** — A Vibbo query's fields and parameters. |
| `vibbo_get_pending_applications` | **Read** — Resident applications awaiting board handling. |
| `vibbo_get_resident_statistics` | **Read** — Vibbo adoption and notification-consent statistics. |
| `vibbo_get_thread` | **Read** — Messages and details of a resident-to-board conversation. |
| `vibbo_get_topic` | **Read** — The full content of a resident handbook topic. |
| `vibbo_get_topic_draft` | **Read** — An unpublished topic's sections, forms and revision token. |
| `vibbo_get_topic_revision` | **Read** — The content and metadata of a topic revision. |
| `vibbo_get_transfer_applications` | **Read** — Subletting applications and their approval status. |
| `vibbo_graphql` | **Read** — Run a cataloged read-only Vibbo GraphQL query. |
| `vibbo_list_calendars` | **Read** — Shared facility calendars and reservations. |
| `vibbo_list_documents` | **Read** — Published resident documents and download links. |
| `vibbo_list_events` | **Read** — Community events, dates and publication status. |
| `vibbo_list_groups` | **Read** — Resident interest groups. |
| `vibbo_list_news` | **Read** — Published news and board announcements. |
| `vibbo_list_operations` | **Read** — Available read-only Vibbo GraphQL operations. |
| `vibbo_list_posts` | **Read** — Resident discussion posts. |
| `vibbo_list_residents` | **Read** — Vibbo residents, units, roles and contact details. |
| `vibbo_list_threads` | **Read** — Resident-to-board conversations and attachments. |
| `vibbo_list_topic_revisions` | **Read** — A topic's revision history. |
| `vibbo_list_topics` | **Read** — Published resident handbook topics. |
| `vibbo_remove_topic_form_draft` | **Write** — Detach a form from a draft; preserve the form and its answers. |
| `vibbo_update_topic_draft` | **Write** — Update an unpublished resident handbook topic. |
| `vibbo_update_topic_form_draft` | **Write** — Replace a draft form with an edited copy; preserve existing answers. |

</details>

## Development

Development, CI and release builds use **Node.js 26**; the published server supports **Node.js 24+**. With Node.js 26 installed (`nvm use` if you use nvm), clone the repository and use pnpm:

```sh
git clone https://github.com/AudunWA/styrerommet-mcp.git
cd styrerommet-mcp
npm install --global pnpm@12.16.1
pnpm install --frozen-lockfile
pnpm check
pnpm auth
```

For either desktop app, replace the npm launch settings above with command `node` and one argument: `/absolute/path/to/styrerommet-mcp/dist/index.js`. Use an absolute path to Node too if it is installed through a version manager.

`pnpm start` runs from source. `pnpm check` checks source and script types, runs tests, builds, and tests both the npm installation and an extracted MCPB with both protocol generations. Build and package-check scripts are TypeScript executed directly by Node.js.

To save both artifacts locally, set `STYREROMMET_PACKAGE_OUTPUT_DIR` to `release` when running `pnpm check`.

## Releases

Use [Conventional Commits](https://www.conventionalcommits.org/) for PR titles. Choose a [SemVer](https://semver.org/) version when releasing: patch for fixes, minor for new features, major for breaking changes. The initial version is **0.1.0**.

For subsequent versions, run `pnpm version patch --no-git-tag-version` (or `minor` / `major`) and commit the version update. In **GitHub → Releases → Draft a new release**, create a matching `vX.Y.Z` tag from that commit on `main`, click **Generate release notes**, review, and publish. GitHub Releases hold the changelog; there is no separate changelog file.

Publishing a GitHub Release starts `release.yml`: it verifies the version, tests and packs the server with pnpm, then independently publishes the verified npm artifact using OIDC and attaches `styrerommet-mcp.mcpb` to the GitHub Release. An npm publishing failure does not block the Claude Desktop download. No release is created by merging to `main`. Downloads become available when the asset upload completes.

Before releasing, use **Actions → Publish → Run workflow** to test building, artifact upload/download and an npm publish dry run. This manual preflight never publishes to npm or creates a GitHub Release. Keep GitHub immutable releases disabled with this flow, since it attaches the MCPB after publication.

The committed `manifest.json` defines the Claude bundle. Packing takes its version and Node requirement from `package.json` and includes only the tested production installation. Generated bundles are release assets, not committed files; the README's latest-release link stays the same.

One-time setup: enable npm 2FA and reserve the package with a [bootstrap stage](https://docs.npmjs.com/staged-publishing/) using a separate version such as `0.0.0-bootstrap.0`, keeping `0.1.0` available for release. Staging creates a public `0.0.0-stage` placeholder. Keep the bootstrap stage pending until the first GitHub release publishes successfully, then reject it; rejecting the only stage before any release unpublishes the placeholder and triggers npm's 24-hour republishing cooldown. Do not approve the bootstrap stage.

Configure [trusted publishing](https://docs.npmjs.com/trusted-publishers/) for repository `AudunWA/styrerommet-mcp`, workflow filename `release.yml`, environment `npm`, allowing **npm publish**. Make the repository public for provenance and allow `v*` tags in the GitHub `npm` environment. Complete the first trusted publish within two days of creating its configuration. No npm token is needed. pnpm manages the repo; npm's CLI handles registry operations and consumer installation tests.

[MIT License](LICENSE). Independent of OBOS; service interfaces may change. Dependencies retain their own licenses, and service names and query definitions remain subject to their owners' rights.
