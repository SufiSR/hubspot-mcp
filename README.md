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
| **Auth for HTTP** | Token in env or Smithery-supplied config | **`X-Auth-Token`** header (optional fallback: `Authorization: Bearer …`) so each user can send their own HubSpot PAT — e.g. **LibreChat** `customUserVars` |
| **Smithery** | `smithery.yaml`, Smithery-focused docs | **Removed** — self-hosted only |
| **Docker** | pnpm-based image | **`npm ci`** + `package-lock.json`, **`EXPOSE 3000`**, entrypoint `node dist/index.js` |
| **Compose** | — | **`docker-compose.yml`**: host port **8003** → container `3000` |
| **npm** | pnpm lockfile in Docker | **`.npmrc`** (`legacy-peer-deps=true`) + **`package-lock.json`** for reproducible installs |
| **Build** | `tsc` | **`node --max-old-space-size=4096`** wrapper in `npm run build` for large single-file compile |
| **CI** | GitHub Actions workflows | **Workflows removed** (no `.github/workflows`) |

**Unchanged:** stdio transport, all **112** HubSpot tools, `HUBSPOT_ACCESS_TOKEN` from env for local/stdio, optional `TELEMETRY_ENABLED`, core MIT license and original tooling code paths.

## Prerequisites

A HubSpot private app access token (PAT). See [HubSpot API overview](https://developers.hubspot.com/docs/guides/api/overview).

## Quick start (Docker)

```bash
docker compose up --build -d
```

MCP URL (from the host): `http://localhost:8003/mcp`  
Inside Docker networks, use `http://<service>:3000/mcp` and set `PORT=3000` (default in compose).

## LibreChat (`streamable-http`)

Point LibreChat at your deployed URL and pass the user’s token in a header:

```yaml
mcpServers:
  hubspot:
    type: streamable-http
    url: "https://your-host:8003/mcp"
    headers:
      X-Auth-Token: "{{HUBSPOT_ACCESS_TOKEN}}"
    customUserVars:
      HUBSPOT_ACCESS_TOKEN:
        title: "HubSpot access token"
        description: "Private app token from HubSpot developer settings"
```

The MCP **`Accept`** header must allow both JSON and SSE, e.g. `application/json, text/event-stream` (LibreChat does this for streamable HTTP).

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

This fork exposes the **same 112 tools** as [shinzo-labs/hubspot-mcp](https://github.com/shinzo-labs/hubspot-mcp) (companies, contacts, leads, deals pipeline via generic objects, engagements, batch APIs, etc.). Use your client’s **`tools/list`** for the canonical names and schemas.

## Contributing

Issues and PRs are welcome on **this** repo for Docker, HTTP auth, and LibreChat integration. For changes to core HubSpot tool behavior, consider contributing upstream to [shinzo-labs/hubspot-mcp](https://github.com/shinzo-labs/hubspot-mcp) so everyone benefits.

## Data collection and privacy

Upstream may collect optional telemetry via `@shinzolabs/instrumentation-mcp`. See the original [Privacy Policy](./PRIVACY.md) and set `TELEMETRY_ENABLED=false` if you do not want it (e.g. in `docker-compose.yml`).

## License

MIT
