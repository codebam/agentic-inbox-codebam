<div align="center">
  <h1>Agentic Inbox</h1>
  <p><em>A self-hosted email client with an AI agent, running entirely on Cloudflare Workers</em></p>
</div>

Agentic Inbox lets you send, receive, and manage emails through a modern web interface -- all powered by your own Cloudflare account. Incoming emails arrive via [Cloudflare Email Routing](https://developers.cloudflare.com/email-routing/), each mailbox is isolated in its own [Durable Object](https://developers.cloudflare.com/durable-objects/) with a SQLite database, and attachments are stored in [R2](https://developers.cloudflare.com/r2/).

An **AI-powered Email Agent** can read your inbox, search conversations, and draft replies -- built with the [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/) and [Workers AI](https://developers.cloudflare.com/workers-ai/).

![Agentic Inbox screenshot](./demo_app.png)


Read the blog post to learn more about Cloudflare Email Service and how to use it with the Agents SDK, MCP, and from the Wrangler CLI: [Email for Agents](https://blog.cloudflare.com/email-for-agents/).

## How to setup

**Important**: Clicking the 'Deploy to Cloudflare' button is only one part of the setup. You must follow the **After deploying** steps as well. For a full step-by-step guide with screenshots, refer to this comment: 
https://github.com/cloudflare/agentic-inbox/issues/4#issuecomment-4269118513

### To set up

1. Deploy to Cloudflare. The deploy flow will automatically provision R2, Durable Objects, and Workers AI. You'll be prompted for **DOMAINS**, which is the domain (yourdomain.com) you want to receive emails for (email@yourdomain.com).

     [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/agentic-inbox)

2. **Configure Cloudflare Access** -- Enable [one-click Cloudflare Access](https://developers.cloudflare.com/changelog/post/2025-10-03-one-click-access-for-workers/) on your Worker under Settings > Domains & Routes. The modal will show your `POLICY_AUD` and `TEAM_DOMAIN` values. `TEAM_DOMAIN` can be either your Access team URL or the full `.../cdn-cgi/access/certs` URL. **You must set these as secrets for your Worker.** Add a **Bypass** policy for `/mcp` and `/mcp/*` so external agents can authenticate with Wrangler keys (see [Agent-first MCP server](#agent-first-mcp-server)).
3. **Set up Email Routing** -- In the Cloudflare dashboard, go to your domain > Email Routing and create a catch-all rule that forwards to this Worker
4. **Enable Email Service** -- The worker needs the `send_email` binding to send outbound emails. See [Email Service docs](https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/)
5. **Create a mailbox** -- Visit your deployed app and create a mailbox for any address on your domain (e.g. `hello@example.com`)

### Troubleshooting Access

1. If you see `Invalid or expired Access token`, that usually means `POLICY_AUD` or `TEAM_DOMAIN` secrets are incorrect.
   * Resolution: [turn Access off and back on for the Worker to get the Access modal again](https://developers.cloudflare.com/changelog/post/2025-10-03-one-click-access-for-workers/), then reset your Worker secrets to the latest `POLICY_AUD` and `TEAM_DOMAIN` values shown there.
2. If you see `Cloudflare Access must be configured in production`, this application is intentionally enforcing Cloudflare Access so your inbox is not exposed to anyone on the internet.
   * Resolution: enable Access using [one-click Cloudflare Access for Workers](https://developers.cloudflare.com/changelog/post/2025-10-03-one-click-access-for-workers/), then set the `POLICY_AUD` and `TEAM_DOMAIN` Worker secrets from the modal values.

## Features

- **Full email client** — Send and receive emails via Cloudflare Email Routing with a rich text composer, reply/forward threading, folder organization, search, and attachments
- **Per-mailbox isolation** — Each mailbox runs in its own Durable Object with SQLite storage and R2 for attachments
- **All Accounts view** — Browse a combined, folder-filterable list of emails across every mailbox, with each row labelled by account
- **Built-in AI agent** — Side panel with 9 email tools for reading, searching, drafting, and sending
- **Agent-first MCP server** — External agents authenticate with the local Wrangler login key (`wrangler auth token`) to read, search, draft, and send email
- **Auto-draft on new email** — Agent automatically reads inbound emails and generates draft replies, always requiring explicit confirmation before sending
- **AI categorization on arrival** — TypeSafe's Jev model (`typesafe/jev`) classifies each incoming email as spam or not-spam with a calibrated probability, and can label it with custom categories. Detected spam is filed in the Spam folder and skipped by auto-draft. Categories are configurable per mailbox in Settings.
- **Configurable and persistent** — Custom system prompts per mailbox, persistent chat history, streaming markdown responses, and tool call visibility

## Stack

- **Frontend:** React 19, React Router v7, Tailwind CSS, Zustand, TipTap, `@cloudflare/kumo`
- **Backend:** Hono, Cloudflare Workers, Durable Objects (SQLite), R2, Email Routing
- **AI Agent:** Cloudflare Agents SDK (`AIChatAgent`), AI SDK v6, Workers AI (`@cf/qwen/qwen3.8-27b`), TypeSafe Jev (`typesafe/jev`) for inbound spam + category classification, `react-markdown` + `remark-gfm`
- **Auth:** Cloudflare Access JWT validation for the browser UI; Wrangler credential bearer auth for the agent-facing `/mcp` endpoint

## Getting Started

```bash
npm install
npm run dev
```

### Configuration

1. Set your domain in `wrangler.jsonc`
2. Create an R2 bucket named `agentic-inbox`: `wrangler r2 bucket create agentic-inbox`

### Deploy

```bash
npm run deploy
```

## Prerequisites

- Cloudflare account with a domain
- [Email Routing](https://developers.cloudflare.com/email-routing/) enabled for receiving
- [Email Service](https://developers.cloudflare.com/email-service/) enabled for sending
- [Workers AI](https://developers.cloudflare.com/workers-ai/) enabled (for the agent)
- [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) configured for deployed/shared environments (required in production)

Browser access is gated by the shared Cloudflare Access policy. The `/mcp` endpoint instead accepts a Wrangler credential produced by `wrangler auth token` (or `CLOUDFLARE_API_TOKEN`). Once authenticated, both paths grant access to all mailboxes by design; external agents select a mailbox with the `mailboxId` tool parameter. There is no per-mailbox authorization, so treat the Cloudflare Access policy and each Wrangler key as full-trust credentials.

## Agent-first MCP server

The MCP server at `/mcp` is designed for agents first: it authenticates with the same Cloudflare credential already stored by the Wrangler CLI, not with a browser cookie or a Cloudflare Access JWT.

Retrieve the current key with:

```bash
npx wrangler auth token
```

### Option A — bundled stdio bridge (recommended)

MCP clients that only support local stdio servers can launch the bundled bridge. It runs `wrangler auth token` for you, keeps the credential in memory, refreshes it once if the Worker returns 401, and proxies to the remote MCP endpoint:

```json
{
  "mcpServers": {
    "agentic-inbox": {
      "command": "node",
      "args": [
        "/absolute/path/to/agentic-inbox/scripts/mcp-bridge.mjs",
        "--url",
        "https://email.example.com/mcp"
      ]
    }
  }
}
```

### Option B — remote MCP with a bearer header

If your MCP client supports remote HTTP servers and custom headers:

```json
{
  "mcpServers": {
    "agentic-inbox": {
      "url": "https://email.example.com/mcp",
      "headers": {
        "Authorization": "Bearer <output of: npx wrangler auth token>"
      }
    }
  }
}
```

> **Cloudflare Access deployments:** add a **Bypass** policy for the `/mcp` and `/mcp/*` paths in the Access application. Without it, Access will challenge MCP clients at the edge before the Worker can validate the Wrangler bearer token. The Worker still enforces the bearer check on every MCP request.

### How the Worker authorizes the key

The Worker verifies the bearer credential by calling the Cloudflare API with it. In the default mode, the token is accepted only if it can read a Cloudflare zone listed in the `DOMAINS` Worker variable (or a domain derived from `EMAIL_ADDRESSES`). This binds each key to the account that owns the inbox.

Deployments using narrowly scoped API tokens can set an explicit account allowlist instead:

```bash
npx wrangler secret put MCP_ALLOWED_ACCOUNT_IDS
# e.g. "023e105f4ecef8ad9ca31a8372d0c353,a1b2c3..."
```

Auth results are cached per Worker isolate for 5 minutes (and in the Cloudflare Cache API where it is available). Raw credentials are never logged or written to disk.

### Available MCP tools

`list_mailboxes`, `list_emails`, `get_email`, `get_thread`, `search_emails`, `draft_reply`, `create_draft`, `update_draft`, `send_reply`, `send_email`, `mark_email_read`, `move_email`, and `delete_email`.

## Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Browser    │────>│  Hono Worker     │────>│  MailboxDO      │
│  React SPA   │     │  (API + SSR)     │     │  (SQLite + R2)  │
│  Agent Panel │     │                  │     └─────────────────┘
└──────┬───────┘     │  /agents/* ──────┼────>┌─────────────────┐
       │             │                  │     │  EmailAgent DO  │
       │ WebSocket   │                  │     │  (AIChatAgent)  │
       └─────────────┤                  │     │  9 email tools  │
                     │                  │────>│  Workers AI     │
                     └──────────────────┘     └─────────────────┘
```

## License

Apache 2.0 -- see [LICENSE](LICENSE).
