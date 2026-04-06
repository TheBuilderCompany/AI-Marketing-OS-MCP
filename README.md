# AI Marketing OS (MCP)

**Codename:** AI-Marketing-OS-MCP

**Marketing MCP Server** is a remote [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server for **content automation**: research from RSS, multi-platform drafts, publishing hooks, analytics, and Notion reporting. It is meant to work with **Claude** and other MCP clients over **HTTP + SSE**.

| Property | Value |
|----------|-------|
| npm package | `marketing-mcp-server` |
| MCP server name | `marketing-content-automation` |
| Node.js | 20+ |

## Claude project (the other half)

This repo is **Layer 3** — the MCP server that handles research storage, drafts, publishing, and Notion analytics over HTTP + SSE.

The **Layer 1** setup lives in Claude: a Project with your brand context files, platform prompts, examples, and workflow. To build that side of **AI Marketing OS**, follow the full guide:

**[AI Marketing OS — build your own automated content system](https://www.thebuilder.company/blogs/ai-marketing-os-build-your-own-automated-content-system)** (thebuilder.company)

Configure the Claude project first, then connect this server as a remote MCP (see below).

## What it does

The server exposes MCP **tools** that drive a workflow backed by **MongoDB**:

| Tool | Purpose |
|------|---------|
| `execute_research` | Pulls headlines from curated RSS feeds (Reuters, Bloomberg, FT), stores a `ResearchLog`, returns a summary. |
| `save_draft_content` | Saves newsletter, LinkedIn variants, X thread, and optional Instagram copy as a `ContentDraft` (status `draft`). |
| `publish_approved_content` | Loads a draft by ID and publishes to **X**, **LinkedIn**, and **Beehiiv** (implementation is scaffolded; enable when API keys are set). |
| `send_whatsapp_message` | Sends direct, free-form text messages to clients (within a 24-hour window). |
| `send_whatsapp_mass_campaign` | Sends pre-approved message templates for mass/cold outreach via WhatsApp Cloud API. |
| `sync_analytics_to_notion` | Aggregates metrics (mock placeholders until real platform APIs are wired), stores `AnalyticsEntry` documents, and creates a report page in **Notion** via the official SDK. |

Also included: an **Express** HTTP API, **SSE** transport for MCP, optional **OAuth discovery** endpoints for remote MCP clients, and optional **Bearer** auth via `MCP_AUTH_SECRET`.

## Quick start

```bash
git clone https://github.com/YOUR_ORG/YOUR_REPO.git
cd YOUR_REPO
npm install
cp .env.example .env
# Edit .env: set at least MONGODB_URI; add NOTION_* and MCP_AUTH_SECRET as needed
npm run build
npm start
```

Run TypeScript directly during development:

```bash
npm run dev
```

By default the server listens on `PORT` or **3000**. Health check: `GET /health`.

## Configuration

Copy **`.env.example`** to **`.env`** and fill in values. Do not commit `.env` (it is listed in `.gitignore`).

- **MongoDB** - `MONGODB_URI` (local or Atlas).
- **MCP** - optional `MCP_AUTH_SECRET`. When set, clients must send `Authorization: Bearer <secret>` (or `x-mcp-auth`) for protected routes such as `/sse` and `/messages`.
- **Notion** - `NOTION_API_KEY`, `NOTION_DATABASE_ID` for analytics sync. Your Notion database properties should match the names used in `src/index.ts`, or adjust the code.
- **Publishing** - X/Twitter, LinkedIn, and Beehiiv variables as described in `.env.example`.
- **WhatsApp** - `WHATSAPP_ACCESS_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` for messaging tools.

For production hosting (e.g. EC2, HTTPS, process manager), see **`DEPLOYMENT.md`**.

## Remote MCP (Claude)

After your [Claude Project files](https://www.thebuilder.company/blogs/ai-marketing-os-build-your-own-automated-content-system) are in place, add this server under **Settings → Integrations** using your deployed **HTTPS** base URL. The app exposes OAuth metadata and a compatibility token flow for remote MCP. Set `MCP_AUTH_SECRET` in production so the MCP endpoints are not publicly open.

## Contributing

We welcome contributions from the community! If you'd like to help improve the **AI Marketing OS**, follow these steps:

1. **Fork** the repository.
2. **Create a new branch** for your feature or bugfix: `git checkout -b feature/my-cool-feature`.
3. **Commit your changes**: `git commit -m 'Add some feature'`.
4. **Push to the branch**: `git push origin feature/my-cool-feature`.
5. **Open a Pull Request** and describe your changes.

### Ideas for Contribution:
- Add more RSS feed sources to `execute_research`.
- Implement real API publishing for the scaffolded platform hooks.
- Create more granular Notion report templates.
- Improve the OAuth flow for better remote MCP compatibility.

## Project layout

```text
src/
  index.ts   # Express app, MCP tools, SSE, OAuth helpers
  db.ts      # Mongoose connection
  models.ts  # ContentDraft, ResearchLog, AnalyticsEntry
```

## Security

- Store **API keys**, **MongoDB URIs**, and **`MCP_AUTH_SECRET`** only in `.env` or your host's secret manager.
- Add a **`LICENSE`** file when you publish the repository.
