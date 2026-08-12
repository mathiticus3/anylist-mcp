# Unofficial AnyList MCP Server

An MCP server that integrates with [AnyList](https://www.anylist.com/) — shopping lists, recipes, and meal planning — exposed via the Model Context Protocol. Works with Claude Desktop, Claude Code, Claude Web/Mobile, or any MCP-compatible client like Home Assistant.

Two deployment modes:
- **Local (stdio)** — runs on your machine alongside Claude Desktop or Claude Code. Fastest setup, no server required.
- **HTTP server** — runs in Docker behind a Cloudflare Tunnel. Required for Claude Web, Claude Mobile, or home assistant and useful for sharing access across devices or users.

## Tools Overview

The MCP server provides **5 domain-grouped tools** rather than 18+ individual ones:

- **shopping** — Manage shopping lists and items: add, check off, delete, organize by category and store, and browse favorites
- **recipes** — Browse, create, and import recipes from URLs; includes ingredient and step parsing
- **meal_plan** — Schedule meals on a calendar with optional links to recipes
- **recipe_collections** — Organize recipes into curated named collections
- **health_check** — Verify your connection to AnyList and access to target lists

These tools work together to enable typical workflows: browse or create recipes → plan meals → add ingredients to your shopping list. See [docs/tools.md](docs/tools.md) for the complete reference including all actions and parameters.

The HTTP deployment also supports a server-enforced, read-first profile for
Gina in OpenWebUI. It exposes separate read and single-record additive tools and
does not register delete, bulk, overwrite, or import operations. See
[docs/gina-openwebui.md](docs/gina-openwebui.md).



---

## Installation: Claude Desktop

The fastest way to get started is to download the latest `anylist-mcp.mcpb` from the [releases page](../../releases).

1. Open Claude Desktop → Settings → Extensions
2. Drag and drop the `.mcpb` file, or click "Advanced settings" → Install extension
3. Enter your configuration when prompted:
   - **AnyList Email** — your AnyList account email
   - **AnyList Password** — your AnyList account password
   - **Default Shopping List** — optional; the list that shopping actions use
     when you don't pass one. Leave blank to require a list name per action.
     Recipes and meal planning don't need it.

---

## Installation: Claude Code / Claude Desktop (from source)

### Prerequisites
- [Node.js](https://nodejs.org/) v20+
- An [AnyList](https://www.anylist.com/) account

### Setup

```bash
git clone --recurse-submodules https://github.com/bobby060/anylist-mcp.git
cd anylist-mcp
npm install
```

Add to your MCP config (`~/.claude/claude_desktop_config.json` or equivalent):

```json
{
  "mcpServers": {
    "anylist": {
      "command": "node",
      "args": ["/absolute/path/to/anylist-mcp/src/server.js"],
      "env": {
        "ANYLIST_USERNAME": "you@example.com",
        "ANYLIST_PASSWORD": "yourpassword",
        "ANYLIST_LIST_NAME": "My Shopping List"
      }
    }
  }
}
```

---

## Installation: Claude Web / Claude Mobile

Claude Web and Mobile require an HTTP MCP server accessible over HTTPS. This project includes a Docker-based HTTP server designed to run behind a Cloudflare Tunnel. The server is designed for self-hosting, but can theoretically support any number of users. You can (should?) restrict what email addresses are allowed to create accounts in the `allowed-emails.txt` file. 

See **[docs/cloudflare-setup.md](docs/cloudflare-setup.md)** for the full setup guide, including:
- Quick tunnel for development (no Cloudflare account needed)
- Named tunnel for production (stable URL on your own domain)

The Vector72 production instance uses the scoped, fail-closed release procedure
in **[docs/production-release.md](docs/production-release.md)**.

**Quick start:**

```bash
git clone --recurse-submodules https://github.com/bobby060/anylist-mcp.git
cd anylist-mcp

# Configure
cp .env.http.example .env          # fill in SERVER_SECRET_KEY and SESSION_SECRET
mkdir -p config
cp allowed-emails.example.txt config/allowed-emails.txt   # add your email

# Start server + Cloudflare quick tunnel
docker compose --profile cloudflare-temp up --build
# Watch logs for the trycloudflare.com URL, then add it as an MCP server in Claude Settings/Connectors
```

---

## Generating OAuth Client Credentials (for Home Assistant / headless clients)

Some MCP clients — like Home Assistant — require a pre-registered `client_id` and `client_secret` rather than dynamic client registration. You create a confidential client once, then enter the credentials in your integration. Home Assistant will still send you through a one-time browser login (authorization code flow) to link your account.

**Prerequisites:** the HTTP server must already be running and you must have an account on it.

```bash
# Run inside the Docker container (the server must be up)
docker compose exec anylist-mcp node scripts/create-client.js you@example.com "Home Assistant"
```

This prints a `client_id` and `client_secret`. **Save the secret immediately** — it is hashed in the database and cannot be retrieved later.

The server URL (what you enter in HA) is:

```
https://<your-tunnel-domain>
```

See **[docs/home-assistant.md](docs/home-assistant.md)** for step-by-step Home Assistant setup.

## Security and backups

Dynamic OAuth registration uses an exact redirect allowlist, a per-IP rate
limit, and a global public-client quota. Existing registered clients retain
their bound callback. MCP sessions are bound to the OAuth client and user that
initialized them, and HTTP logs exclude request bodies and private AnyList
content.

The SQLite volume and `SERVER_SECRET_KEY` must be backed up together without
printing or storing the key in plaintext logs. See [docs/backup.md](docs/backup.md)
for the required backup set and restore acceptance checks.

See [docs/security.md](docs/security.md) for the complete boundary, the
protobufjs 8 compatibility port, and the remaining unofficial-API risk.

---

## Development

```bash
# Unit tests (mocked, no credentials needed)
npm test

# Dependency audit (production and development trees)
npm audit

# Integration tests (requires .env with real credentials)
npm run test:integration

# Inspect with the MCP inspector
npx @modelcontextprotocol/inspector node src/server.js
```

### Building the desktop extension

```bash
npm run pack   # produces anylist-mcp.mcpb
```

---

## Roadmap

- **Google OAuth** — allow users to sign in to the HTTP MCP server with their Google account instead of a separate password.
- **Web gui-based workflow for created oauth client credentials**
---

## Credits

AnyList API from a fork of [anylist](https://github.com/codetheweb/anylist) by @codetheweb.

Contributions welcome — feel free to open issues and pull requests.
