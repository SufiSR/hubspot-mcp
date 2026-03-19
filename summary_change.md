# Change Plan: Compact Engagement Summary Tool

## Problem

When a user asks *"summarize communications with company X"*, the LLM calls
`engagement_details_get_associated` which fetches **every** engagement for that
company from HubSpot's v1 API. Each engagement includes:

- `engagement` — metadata (id, type, timestamp, ownerId, source, …)
- `associations` — contactIds, companyIds, dealIds, ownerIds, ticketIds
- `metadata` — **type-specific payload** (full email HTML body, call recording
  URL, meeting attendee lists, task reminders, note body up to 64KB, …)
- `scheduledTasks`, `attachments`, etc.

For a company with substantial history this easily produces **1M+ tokens** of
raw JSON, exceeding the LLM context window before the model ever sees it.

The existing `limit` and `offset` params theoretically allow paging, but:
1. The LLM has no reason to use them — the tool description says "Get all
   engagements associated with an object" and nothing warns about size.
2. Even a single page of 100 engagements with email bodies can blow the budget.
3. Paging still returns full raw payloads per engagement.

---

## Design Constraints

1. **Don't break existing tools.** `engagement_details_get_associated` stays as
   is — some integrations may depend on the full raw output.
2. **Don't rely on agent intelligence.** The fix must work even if the LLM
   naively calls the tool without tuning parameters.
3. **Keep it in one tool call.** The user's question is simple; the answer
   should come from one (or at most two) tool invocations.
4. **Stay within HubSpot v1 API capabilities.** No v3-only features.

---

## Solution: Add `engagement_summary_associated`

A **new tool** that pages through engagements **server-side** and returns a
compact, LLM-friendly digest. The LLM calls it once; the server does the heavy
lifting.

### Tool signature

```typescript
server.tool("engagement_summary_associated",
  "Get a compact summary of all engagements associated with an object. " +
  "Returns a digest with type, date, subject/title, body preview, owner, " +
  "and association counts — suitable for summarization without exceeding context limits.",
  {
    objectType: z.enum(['CONTACT', 'COMPANY', 'DEAL', 'TICKET']),
    objectId: z.string(),
    activityTypes: z.array(
      z.enum(['EMAIL', 'CALL', 'MEETING', 'TASK', 'NOTE'])
    ).optional(),
    startTime: z.string().optional(),  // ISO 8601 or epoch ms
    endTime: z.string().optional(),
    maxResults: z.number().min(1).max(500).optional(),     // default 250
    bodyMaxChars: z.number().min(0).max(1000).optional(),  // default 200
  },
  async (params) => { ... }
)
```

### What the tool does internally

1. **Pages through the HubSpot v1 API** using
   `GET /engagements/v1/engagements/associated/{objectType}/{objectId}/paged`
   with `limit=100` per page, accumulating results until `maxResults` is
   reached or there are no more pages.

2. **Extracts only summary fields** from each engagement:

   | Field | Source | Notes |
   |-------|--------|-------|
   | `id` | `engagement.id` | For follow-up with `engagement_details_get` |
   | `type` | `engagement.type` | EMAIL, CALL, MEETING, TASK, NOTE |
   | `timestamp` | `engagement.timestamp` | Epoch ms → ISO string |
   | `ownerId` | `engagement.ownerId` | |
   | `subject` | Type-dependent: `metadata.subject` (email), `metadata.title` (meeting/call), `metadata.hs_task_subject` (task), first line of `metadata.body` (note) | |
   | `bodyPreview` | `engagement.bodyPreview` or first N chars of `metadata.body` / `metadata.text` / `metadata.html` (stripped of HTML tags) | Truncated to `bodyMaxChars` |
   | `direction` | `metadata.from` / `metadata.to` for emails; `metadata.callDirection` for calls | Helps distinguish inbound/outbound |
   | `associationCounts` | `{ contacts: N, companies: N, deals: N }` | Counts only, not full ID arrays |

3. **Returns a structured JSON array** wrapped in `formatResponse()`.
   Additionally prepends a one-line header:
   `"Found 142 engagements for COMPANY 12345 (showing 142, body previews truncated to 200 chars)"`

### Output size estimation

Per engagement: ~300–500 chars of JSON (id, type, timestamp, subject, 200-char
preview, direction, counts). For 250 engagements that's **~100KB** / roughly
**25K tokens**. Well within any model's context, with room to spare for the
system prompt, tool schemas, and the model's own reasoning.

Compare: the raw payload for 250 engagements with full email bodies can easily
be 2–5MB / 500K–1.3M tokens.

---

## Implementation Detail

### Where in `src/index.ts`

Insert the new tool immediately **after** `engagement_details_get_associated`
(after line 1803), keeping the engagement tools grouped together.

### Helper: `extractEngagementSummary`

A pure function (no API calls) that takes one raw engagement object and returns
the compact summary shape. This keeps the tool handler clean.

```typescript
function extractEngagementSummary(raw: any, bodyMaxChars: number) {
  const eng = raw.engagement || {}
  const meta = raw.metadata || {}
  const assoc = raw.associations || {}

  let subject = ''
  let bodyPreview = ''
  let direction = undefined

  switch (eng.type) {
    case 'EMAIL':
      subject = meta.subject || ''
      bodyPreview = stripQuotedContent(stripHtml(meta.text || meta.html || ''))
      direction = meta.from?.email ? `from: ${meta.from.email}` : undefined
      break
    case 'CALL':
      subject = meta.title || ''
      bodyPreview = meta.body || ''
      direction = meta.callDirection || undefined
      break
    case 'MEETING':
      subject = meta.title || ''
      bodyPreview = meta.body || ''
      break
    case 'TASK':
      subject = meta.subject || ''
      bodyPreview = meta.body || ''
      break
    case 'NOTE':
      subject = (meta.body || '').split('\n')[0]?.substring(0, 80) || ''
      bodyPreview = stripHtml(meta.body || '')
      break
  }

  if (bodyPreview.length > bodyMaxChars) {
    bodyPreview = bodyPreview.substring(0, bodyMaxChars) + '…'
  }

  return {
    id: eng.id,
    type: eng.type,
    timestamp: eng.timestamp ? new Date(eng.timestamp).toISOString() : null,
    ownerId: eng.ownerId,
    subject,
    bodyPreview,
    direction,
    associationCounts: {
      contacts: (assoc.contactIds || []).length,
      companies: (assoc.companyIds || []).length,
      deals: (assoc.dealIds || []).length,
    }
  }
}
```

### Helper: `stripHtml`

Minimal HTML→text conversion (the v1 API often returns HTML in email bodies):

```typescript
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}
```

### Helper: `stripQuotedContent`

Emails in HubSpot typically contain the entire thread quoted below the new
reply. This is the **single biggest source of wasted tokens** — a 20-message
thread means the latest email contains all 19 prior messages inline.

This function cuts the body at the first recognized reply marker:

```typescript
function stripQuotedContent(text: string): string {
  const patterns = [
    /^On .+ wrote:\s*$/m,                    // Gmail: "On Mon, Jan 1, … wrote:"
    /^-{2,}\s*Original Message\s*-{2,}/mi,   // Outlook: "-----Original Message-----"
    /^-{2,}\s*Forwarded message\s*-{2,}/mi,  // Gmail forwarded
    /^From:\s.+\nSent:\s.+\nTo:\s/m,         // Outlook block header
    /^Von:\s.+\nGesendet:\s.+\nAn:\s/m,      // Outlook DE
    /^De\s?:\s.+\nEnvoyé\s?:\s.+\nÀ\s?:\s/m, // Outlook FR
    /^>{3,}/m,                                // Deep quoting (>>> or more)
    /\n>(?:\s|$)/,                            // Single-level quote line
  ]

  for (const pattern of patterns) {
    const match = text.search(pattern)
    if (match > 0) {
      return text.substring(0, match).trim()
    }
  }
  return text
}
```

Applied inside `extractEngagementSummary` for EMAIL type, **before** the
`bodyMaxChars` truncation. This means the 200-char preview only contains
the actual new content of that email, not quoted history.

### Email thread grouping: `groupEmailThreads`

Even after stripping quoted content, fetching 30 emails from one thread
produces 30 near-identical subjects with incremental reply content. This
wastes tokens and confuses the LLM.

The tool groups emails by **normalized subject** (strip `Re:`, `Fwd:`,
`AW:`, `WG:`, `Antwort:`, `SV:` prefixes and trim) and collapses each
thread into a single digest entry:

```typescript
interface EmailThreadSummary {
  type: 'EMAIL_THREAD'
  subject: string
  messageCount: number
  firstMessage: string       // ISO timestamp
  lastMessage: string        // ISO timestamp
  participants: string[]     // unique email addresses (from/to)
  latestBodyPreview: string  // newest reply's body, quoted content stripped
  engagementIds: string[]    // all IDs, for follow-up with engagement_details_get
}
```

**Why this matters for token budget:**

| Scenario | Entries | ~Tokens |
|----------|---------|---------|
| 30 individual emails, 200-char preview each | 30 | ~7,500 |
| 1 thread summary with latest preview + metadata | 1 | ~400 |
| **Savings** | | **~95%** |

Implementation: after collecting all summaries, partition the EMAIL entries
by normalized subject. Any group with 2+ emails becomes an `EMAIL_THREAD`;
solo emails stay as individual entries. Non-email engagements (calls,
meetings, notes, tasks) are unaffected.

### Tool handler (pseudo-code)

```typescript
async (params) => {
  return handleEndpoint(async () => {
    const maxResults = params.maxResults ?? 250
    const bodyMaxChars = params.bodyMaxChars ?? 200
    const summaries: any[] = []
    let offset = 0
    let hasMore = true

    while (hasMore && summaries.length < maxResults) {
      const pageLimit = Math.min(100, maxResults - summaries.length)
      const endpoint = `/engagements/v1/engagements/associated/${params.objectType}/${params.objectId}/paged`
      const data = await makeApiRequest(hubspotAccessToken, endpoint, {
        limit: pageLimit,
        offset,
        ...(params.startTime && { startTime: params.startTime }),
        ...(params.endTime && { endTime: params.endTime }),
        ...(params.activityTypes && { activityTypes: params.activityTypes.join(',') }),
      })

      if (typeof data === 'string') {
        // error from makeApiRequest
        return formatResponse(data)
      }

      for (const result of (data.results || [])) {
        summaries.push(extractEngagementSummary(result, bodyMaxChars))
      }

      hasMore = data.hasMore === true
      offset = data.offset ?? offset + pageLimit
    }

    // Group email threads to eliminate inter-email duplication
    const grouped = groupEmailThreads(summaries)

    const header = `Found ${summaries.length} engagements for ${params.objectType} ${params.objectId}` +
      ` (${grouped.length} entries after email thread grouping, body previews truncated to ${bodyMaxChars} chars)`

    return formatResponse({ summary: header, engagements: grouped })
  })
}
```

---

## What Does NOT Change

- `engagement_details_get_associated` — untouched, still available for full
  raw retrieval when needed.
- `engagement_details_get` — still available for fetching full detail of a
  single engagement by ID (the LLM can use it as a follow-up if the summary
  reveals something interesting).
- All other tools — untouched.
- `formatResponse`, `makeApiRequest`, `makeApiRequestWithErrorHandling` — no
  changes needed.

---

## Alternatives Considered

### A. Add `compact: true` param to existing tool

**Pro:** No new tool, smaller API surface.
**Con:** Breaks the principle that existing tools should remain backwards-compatible.
Clients using `engagement_details_get_associated` programmatically may depend
on the full raw shape. Also, overloading one tool with two very different
response shapes is confusing for the LLM's tool selection.

**Verdict:** Rejected.

### B. Server-side summarization with an LLM

**Pro:** Could produce natural-language summaries directly.
**Con:** Requires an LLM API key on the server, adds latency and cost, and
the server shouldn't decide what's "relevant" — that's the client LLM's job.
The MCP server should just return compact structured data.

**Verdict:** Rejected. Defeats the purpose of MCP as a data layer.

### C. Client-side paging instructions (system prompt / tool description)

**Pro:** Zero code changes.
**Con:** Fragile — depends on the LLM reading and following multi-step
instructions perfectly. The first tool call will still attempt to fetch
everything. And the error happens at the client layer (context overflow)
before the LLM can course-correct.

**Verdict:** Rejected as a sole solution. Could be a supplement.

### D. Truncate `formatResponse` globally when output exceeds N chars

**Pro:** Simple, protects against all oversized responses.
**Con:** Crude — silently drops data without the LLM knowing what was lost.
Breaks tools where full output is expected (batch reads, search results).
Also, truncation without structure loses context (cuts mid-JSON).

**Verdict:** Rejected as primary solution. Could be a safety net later.

---

## Impact Summary

| File | Change | Scope |
|------|--------|-------|
| `src/index.ts` | Add `stripHtml` helper (~10 lines) | Before `createServer` |
| `src/index.ts` | Add `stripQuotedContent` helper (~20 lines) | Before `createServer` |
| `src/index.ts` | Add `normalizeEmailSubject` helper (~5 lines) | Before `createServer` |
| `src/index.ts` | Add `extractEngagementSummary` helper (~45 lines) | Before `createServer` |
| `src/index.ts` | Add `groupEmailThreads` helper (~40 lines) | Before `createServer` |
| `src/index.ts` | Add `engagement_summary_associated` tool (~55 lines) | After line 1803 |
| Total | ~175 lines of new code | No existing code modified |

---

## Future Considerations

- **Apply the same pattern to other high-volume endpoints** (e.g.
  `emails_list`, `notes_list`, `calls_list`) if users hit similar issues.
- **Add a global response size guard** in `formatResponse` that warns (but
  does not truncate) when output exceeds ~200KB, suggesting the compact tool.
- **Consider moving to the CRM v3 engagements API** which allows requesting
  specific properties, avoiding the "everything in metadata" problem entirely.
  However, v3 requires separate association lookups, so v1 is still simpler
  for this use case.
