<div align="center">
    <h1 align="center">HubSpot MCP Server</h1>
    <p align="center">Streamable HTTP + per-request HubSpot token · Docker-ready</p>
</div>

## Upstream

This project is based on **[shinzo-labs/hubspot-mcp](https://github.com/shinzo-labs/hubspot-mcp)** — an extensive [Model Context Protocol (MCP)](https://modelcontextprotocol.io/introduction) server for the [HubSpot](https://hubspot.com/) API. Thank you to the original authors for the implementation and tool surface.

## What changed vs. the original

| Area | Original | This fork |
|------|----------|-----------|
| **HTTP transport** | [`@smithery/sdk`](https://www.npmjs.com/package/@smithery/sdk) `createStatefulServer` (config via Smithery / init payload) | **Express** + official **`StreamableHTTPServerTransport`** from `@modelcontextprotocol/sdk` |
| **Auth for HTTP** | Token in env or Smithery-supplied config | **`Authorization: Bearer …`** per request (LibreChat OAuth injects this); optional **`HUBSPOT_ACCESS_TOKEN`** in env for the container only |
| **Smithery** | `smithery.yaml`, Smithery-focused docs | **Removed** — self-hosted only |
| **Docker** | pnpm-based image | **`npm ci`** + `package-lock.json`, **`EXPOSE 3000`**, entrypoint `node dist/index.js` |
| **Compose** | — | **`docker-compose.yml`**: host port **8003** → container `3000` |
| **npm** | pnpm lockfile in Docker | **`.npmrc`** (`legacy-peer-deps=true`) + **`package-lock.json`** for reproducible installs |
| **Build** | `tsc` | **`node --max-old-space-size=4096`** wrapper in `npm run build` for large single-file compile |
| **CI** | GitHub Actions workflows | **Workflows removed** (no `.github/workflows`) |
| **`get_current_time` tool** | — | **Added** — returns the server's current UTC timestamp so the LLM can resolve relative date expressions ("this year", "last month", "today") into exact `startTime`/`endTime` values. LibreChat does not inject a current date into the system prompt, making this necessary for reliable date-filtered queries. |

**Engagement summaries:** `engagement_summary_associated` returns a **default LLM-optimized** JSON shape (`threads` + `other_engagements` with `timestamp`, `from`, `to`, `content`). Use this for questions like *“summarize communication with company X”* — it avoids the huge raw payload from `engagement_details_get_associated`. Cleaning includes: **normalized lowercase subjects** and **merged threads** that only differed by `Re:/Fw:`/whitespace; **UTF-8 sanitization** (drops mojibake like `ÿè`); **hard-cut** at the first `From:` / `Sent:` / `On … wrote:` / `-----`; **disclaimer/signature/warning** stripping; **leading `Hi Name,` removal** when enough body remains; **drop messages** with fewer than **10** meaningful (non-stopword) words unless they contain a **URL** (then ≥5 such words). Set **`llmOptimize: false`** for the older grouped `engagements` array (`EMAIL_THREAD` + raw `body`). **Source of truth:** `src/llmEmailCleaner.ts`. Optional **Python mirror:** `preprocessing/email_cleaner.py` (offline CLI; kept in sync by hand).

**Unchanged:** stdio transport, the original **112** HubSpot API tools, `HUBSPOT_ACCESS_TOKEN` from env for local/stdio, optional `TELEMETRY_ENABLED`, core MIT license and original tooling code paths.

## Prerequisites

A HubSpot private app access token (PAT). See [HubSpot API overview](https://developers.hubspot.com/docs/guides/api/overview).

## Quick start (Docker)

```bash
docker compose up --build -d
```

MCP URL (from the host): `http://localhost:8003/mcp`  
Inside Docker networks, use `http://<service>:3000/mcp` and set `PORT=3000` (default in compose).

## LibreChat (`streamable-http`)

Point LibreChat at your deployed URL. For a **private app token** (no OAuth), pass it as Bearer:

```yaml
mcpServers:
  hubspot:
    type: streamable-http
    url: "https://your-host:8003/mcp"
    headers:
      Authorization: "Bearer {{HUBSPOT_ACCESS_TOKEN}}"
    customUserVars:
      HUBSPOT_ACCESS_TOKEN:
        title: "HubSpot access token"
        description: "Private app token from HubSpot developer settings"
```

The MCP **`Accept`** header must allow both JSON and SSE, e.g. `application/json, text/event-stream` (LibreChat does this for streamable HTTP).

**SSE:** `GET /mcp` returns a keep-alive event stream (used by some clients alongside `POST /mcp`).

### LibreChat + HubSpot OAuth (Bearer from LibreChat)

LibreChat runs the OAuth flow and sends **`Authorization: Bearer <access_token>`** to this MCP. Configure the **`oauth:`** block for your server key in `librechat.yaml` (authorization URL, token URL, client id/secret, redirect URI, scopes) — see [LibreChat MCP servers → `oauth`](https://librechat.ai/docs/configuration/librechat_yaml/object_structure/mcp_servers).

If a tool runs **before** a token is available, HubSpot API tools return an MCP result with **`isError: true`** and text **`Authentication required`** (LibreChat can use this with **`MCP_OAUTH_ON_AUTH_ERROR=true`**).

HubSpot HTTP calls use a **10s** default timeout; override with **`HUBSPOT_API_TIMEOUT_MS`** (milliseconds).

## Local stdio (Cursor, Claude Desktop, etc.)

Same as upstream: run the built server and set `HUBSPOT_ACCESS_TOKEN` in the client env.

```json
{
  "mcpServers": {
    "hubspot": {
      "command": "node",
      "args": ["/absolute/path/to/hubspot-mcp/dist/index.js"],
      "env": {
        "HUBSPOT_ACCESS_TOKEN": "your-access-token-here"
      }
    }
  }
}
```

Build from clone:

```bash
npm ci
npm run build
npm start
```

## Environment variables

| Variable | Description | Required? | Default |
|----------|-------------|-----------|---------|
| `HUBSPOT_ACCESS_TOKEN` | HubSpot PAT (stdio / default server instance) | Yes for stdio-only use without header | — |
| `PORT` | HTTP listener port inside the container | No | `3000` |
| `TELEMETRY_ENABLED` | OpenTelemetry to vendor endpoint | No | `true` (set `false` in compose to disable) |

For **HTTP**, the effective token is taken from **`X-Auth-Token`** or **`Authorization: Bearer`** on each request; env `HUBSPOT_ACCESS_TOKEN` is still used by the **stdio** side of the same process.

## Tools

This fork exposes **114 tools** (upstream **112** plus `get_current_time` and `engagement_summary_associated`) — see [shinzo-labs/hubspot-mcp](https://github.com/shinzo-labs/hubspot-mcp) (companies, contacts, leads, deals pipeline via generic objects, engagements, batch APIs, etc.). Use your client’s **`tools/list`** for the canonical names and schemas.

### Offline LLM clean (optional)

After `npm run build`, you can reproduce the same JSON as the default tool output from a saved **`{ "engagements": [...] }`** payload (e.g. exported with `llmOptimize: false`):

```bash
npm run llm-clean -- path/to/grouped.json path/to/output.json
# equivalent: node scripts/run-llm-clean.mjs …
```

See **`examples/llm_optimized_format.example.json`** for the response shape. Do not commit real CRM data (see `.gitignore`, e.g. `examples/llm_optimized_comparison_output.json`, `deduped_clean.json`).

## Development & testing

```bash
npm ci
npm run build
npm test          # Jest: e2e (MCP) + unit tests for llmEmailCleaner
```

LLM cleaning behavior is covered by **`test/llmEmailCleaner.test.ts`**. The **`preprocessing/`** folder is an optional Python port for scripts only (no pytest suite in this repo).

## Contributing

Issues and PRs are welcome on **this** repo for Docker, HTTP auth, and LibreChat integration. For changes to core HubSpot tool behavior, consider contributing upstream to [shinzo-labs/hubspot-mcp](https://github.com/shinzo-labs/hubspot-mcp) so everyone benefits.

## Data collection and privacy

Upstream may collect optional telemetry via `@shinzolabs/instrumentation-mcp`. See the original [Privacy Policy](./PRIVACY.md) and set `TELEMETRY_ENABLED=false` if you do not want it (e.g. in `docker-compose.yml`).

## License

MIT
