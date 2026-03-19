# Change Plan: Remove Smithery, Add Header Auth, Dockerize

## Goal

Replace the Smithery-based HTTP transport with a self-contained, Docker-friendly
Streamable HTTP server. Authentication moves from environment variables and Smithery
config payloads to a per-request HTTP header (`X-Auth-Token`), enabling user-specific
HubSpot token injection from LibreChat.

---

## 1. `package.json`

### Remove dependency
```json
"@smithery/sdk": "1.4.3"
```

### Add dependency
```json
"express": "latest"
```
`express` is currently only a transitive dep pulled in by `@smithery/sdk`.
Declaring it directly avoids a fragile implicit dependency.

Also add the matching type definitions to `devDependencies`:
```json
"@types/express": "latest"
```

---

## 2. `src/index.ts`

### 2a. Replace import (line 5)

**Remove:**
```typescript
import { createStatefulServer } from "@smithery/sdk/server/stateful.js"
```

**Add:**
```typescript
import express from "express"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
```

`StreamableHTTPServerTransport` ships with `@modelcontextprotocol/sdk` which is
already a direct dependency — no new package required.

### 2b. Replace HTTP bootstrap (lines 2528–2531)

**Remove:**
```typescript
// Streamable HTTP Server
const { app } = createStatefulServer(createServer)
const PORT = process.env.PORT || 3000
app.listen(PORT)
```

**Replace with:**
```typescript
// Streamable HTTP Server
const app = express()
app.use(express.json())

app.post('/mcp', async (req, res) => {
  const token = (req.headers['x-auth-token'] as string)
    || (req.headers['authorization'] as string)?.replace('Bearer ', '')

  const server = createServer({ config: { HUBSPOT_ACCESS_TOKEN: token } })
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  await server.connect(transport)
  await transport.handleRequest(req, res, req.body)
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`MCP HTTP server listening on port ${PORT}`))
```

**Notes:**
- `sessionIdGenerator: undefined` selects stateless mode — each POST is self-contained.
  This is the correct model for LibreChat's per-request usage pattern.
- Token is read from `X-Auth-Token` header (LibreChat custom header) with a fallback
  to `Authorization: Bearer <token>` for standard clients.
- The `createServer` factory and `getConfig` function are **unchanged** — they already
  support receiving the token via the `config` object.
- The Stdio transport block (lines 2523–2526) is **unchanged** — it continues to work
  for local Cursor/Claude Desktop usage via `process.env.HUBSPOT_ACCESS_TOKEN`.

---

## 3. `smithery.yaml`

**Delete the file entirely.**

It is a Smithery-specific deployment descriptor with no function in the new setup.

---

## 4. `Dockerfile`

The existing Dockerfile is mostly fine. Two small improvements:

### 4a. Expose the HTTP port

Add after the `ENV` line:
```dockerfile
EXPOSE 3000
```

This is metadata only (does not publish the port) but is good practice and required
by some container orchestrators.

### 4b. Switch package manager to npm (optional but simplifies the image)

The current image installs `pnpm` globally just to run one build. If `pnpm-lock.yaml`
is kept, pnpm is still needed. If we migrate the lockfile to `package-lock.json`, the
`RUN npm install -g pnpm` line and all `pnpm` calls can be replaced with `npm`:

```dockerfile
RUN npm ci          # replaces: RUN pnpm fetch && pnpm install -r --offline
RUN npm run build   # replaces: RUN pnpm build
```
And the entrypoint:
```dockerfile
ENTRYPOINT ["node", "dist/index.js"]   # replaces: ENTRYPOINT ["pnpm", "run", "start"]
```

This change is **optional** — keeping pnpm also works.

---

## 5. `docker-compose.yml` (new file)

Create a `docker-compose.yml` at the repo root. Since this server is stateless and
multi-tenant (no secrets baked in), no environment variables are needed at compose
level — tokens arrive per-request via the header.

```yaml
services:
  hubspot-mcp:
    build: .
    restart: unless-stopped
    ports:
      - "8003:3000"
    environment:
      PORT: 3000
      TELEMETRY_ENABLED: "false"   # set to "true" to enable OpenTelemetry tracing
```

**Notes:**
- The container listens internally on port 3000 (controlled by `PORT`) and is
  published to the host on **port 8003**. To change the host port, only the left
  side of `"8003:3000"` needs to be updated.
- `HUBSPOT_ACCESS_TOKEN` is intentionally absent — it is supplied per-request by each
  LibreChat user via the `X-Auth-Token` header, not at container startup.
- `TELEMETRY_ENABLED: "false"` disables the default OpenTelemetry export to
  `api.otel.shinzo.tech`. Set to `"true"` if you want tracing.
- `restart: unless-stopped` keeps the container running across host reboots and
  crash-restarts without requiring manual intervention.
- In LibreChat, point the MCP URL at `http://<your-host>:8003/mcp`.

---

## 6. LibreChat Configuration (no code change, documentation only)

After the changes above, LibreChat users connect with:

```yaml
mcpServers:
  hubspot:
    type: streamable-http
    url: "https://your-server/mcp"
    headers:
      X-Auth-Token: "{{HUBSPOT_ACCESS_TOKEN}}"
    customUserVars:
      HUBSPOT_ACCESS_TOKEN:
        title: "HubSpot Access Token"
        description: "Enter your personal HubSpot private app access token"
```

---

## Impact Summary

| File | Change type | Scope |
|---|---|---|
| `package.json` | Swap 1 dep, add 1 dep + 1 devDep | 3 lines |
| `src/index.ts` | Swap 1 import, replace 4-line bootstrap | ~15 lines total |
| `smithery.yaml` | Delete | Entire file |
| `Dockerfile` | Add `EXPOSE`, optionally swap pnpm → npm | 1–5 lines |
| `docker-compose.yml` | Create new file | ~10 lines |

**Unchanged:** All 112 tool definitions, `createServer`, `getConfig`, `makeApiRequest`,
the Stdio transport, telemetry, tests.
