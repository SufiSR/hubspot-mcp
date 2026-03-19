/**
 * Aggressive LLM-oriented cleaning for engagement summaries.
 * Normalizes subjects (merge duplicate threads), fixes encoding, hard-cuts reply chains,
 * strips noise, drops short messages, trims greetings.
 */

// ---------------------------------------------------------------------------
// Subject normalization (dedupe threads)
// ---------------------------------------------------------------------------

const SUBJECT_PREFIX = /^(re|fw|fwd|aw|wg|sv|vs|antwort|réf|ref)\s*:\s*/i

/** Canonical key: trim, lowercase, strip Re:/Fw:/… repeatedly, collapse spaces. */
export function normalizeSubjectKey(subject: string): string {
  let s = sanitizeUtf8(fixMojibake(subject.trim())).replace(/\s+/g, ' ').toLowerCase()
  let prev = ''
  while (s !== prev) {
    prev = s
    s = s.replace(SUBJECT_PREFIX, '').trim()
  }
  return s.replace(/\s+/g, ' ').trim()
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

const MOJIBAKE_MAP: Record<string, string> = {
  '├¡': 'í',
  '├▒': 'ñ',
  '├╝': 'ü',
  '├ñ': 'ñ',
  '├á': 'á',
  '├╗': 'û',
  '┬á': ' ',
  'ÔÇô': '–',
  'ÔÇö': '—',
  'ÔÇ║': '',
  'ÔÇÖ': "'",
  'ÔÇª': '…',
  'ÔÇï': '',
  'ÔÇ£': '"',
  'ÔÇ¥': '"',
  'Ô£¿': '',
  '\u0027': "'",
}

/** Broken UTF-8 / emoji fallout (e.g. ÿè); avoid stripping valid letters like é (\u00e9). */
const MANGLED_SEQUENCES =
  /[\u00ad\u0192\u0178\u02dc]{2,}|\u00ff\u00e8+|ÿè|\ufffd|\ufeff/g

export function fixMojibake(text: string): string {
  let t = text
  for (const [bad, good] of Object.entries(MOJIBAKE_MAP)) {
    t = t.split(bad).join(good)
  }
  return t
}

export function sanitizeUtf8(text: string): string {
  return text
    .replace(/\ufffd/g, '')
    .replace(/\u00ff\u00e8/g, '')
    .replace(/ÿè/g, '')
    .replace(MANGLED_SEQUENCES, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
}

// ---------------------------------------------------------------------------
// Hard-cut reply chains (first marker wins; aggressive)
// ---------------------------------------------------------------------------

const HARD_CUT_MARKERS: RegExp[] = [
  /\bFrom:\s/i,
  /\bSent:\s/i,
  /\bOn\s[\s\S]{4,240}?wrote:\s*/i,
  /-{5,}/,
]

export function hardCutReplyChain(text: string): string {
  let cut = text.length
  for (const re of HARD_CUT_MARKERS) {
    re.lastIndex = 0
    const m = re.exec(text)
    if (m !== null && m.index >= 8 && m.index < cut) cut = m.index
  }
  return cut < text.length ? text.slice(0, cut).trimEnd() : text
}

// ---------------------------------------------------------------------------
// Secondary quote patterns (after hard cut)
// ---------------------------------------------------------------------------

const QUOTE_PATTERNS_MULTILINE: RegExp[] = [
  /^-{2,}\s*Original Message\s*-{2,}/im,
  /^-{2,}\s*Forwarded message\s*-{2,}/im,
  /^-{3,}\s*$/m,
  /^On .{10,80} wrote:\s*$/m,
  /^From:\s.+\nSent:\s.+\nTo:\s/m,
  /^Von:\s.+\nGesendet:\s.+\nAn:\s/m,
  /^De\s?:\s.+\nEnvoy[eé]\s?:\s.+\n[AÀ]\s?:\s/m,
  /^From:\s.+\nTo:\s.+\nDate:\s/m,
  /^-{4,}\s*On .+ wrote\s*-{4,}/m,
  /^>{3,}/m,
  /\n>{1,2}\s/m,
]

const QUOTE_PATTERNS_INLINE: RegExp[] = [
  /\s+From:\s+\S+.*?\s+To:\s+.*?\s+(?:Date|Sent|Cc):\s/i,
  /\s+From:\s+\S+.*?\s+Sent:\s+.*?\s+To:\s/i,
  /\s+Von:\s+\S+.*?\s+Gesendet:\s+.*?\s+An:\s/i,
  /\s+-{4,}\s*On .+ wrote\s*-{4,}/i,
]

export function stripQuotedContentLlm(text: string): string {
  let earliest = text.length
  for (const pat of QUOTE_PATTERNS_MULTILINE) {
    pat.lastIndex = 0
    const m = pat.exec(text)
    if (m && m.index > 0 && m.index < earliest) earliest = m.index
  }
  for (const pat of QUOTE_PATTERNS_INLINE) {
    pat.lastIndex = 0
    const m = pat.exec(text)
    if (m && m.index > 0 && m.index < earliest) earliest = m.index
  }
  return earliest < text.length ? text.slice(0, earliest).trimEnd() : text
}

// ---------------------------------------------------------------------------
// Noise removal (global)
// ---------------------------------------------------------------------------

const SIGNATURE_PATTERNS: RegExp[] = [
  /^\[(?:cid|https?):[^\]]+\]\s*$/gim,
  /\[(?:cid|https?):[^\]]+\]/gi,
  /\[(?:Linkedin|Twitter|Facebook|Youtube|Instagram|X|Smile)\]/gi,
  /\[(?:Maria Munoz|Gunner? Leu)\]/gi,
]

const SIGNATURE_START_MULTILINE: RegExp[] = [
  /^_{5,}\s*$/m,
  /^(?:Best|Kind|Warm)\s+regards?\s*,?\s*$/im,
  /^(?:Mit freundlichen Grüßen|Cordialement|Saludos)\s*,?\s*$/im,
  /^Wishing you a wonderful/im,
  /^Thanks?,?\s*(?:and\s+)?(?:Kind|Best)?\s*regards?\s*,?\s*$/im,
]

const INLINE_SIG_CUTOFF: RegExp[] = [
  /(?:Best|Kind|Warm)\s+regards?\s*,?\s+(?:[\p{Lu}][\p{Ll}]+(?:\s+[\p{Lu}][\p{Ll}]+){0,5})\s*(?:(?:Sales|Office|Team|Revenue|Managing|Project)\s+(?:Consultant|Manager|Lead|Head|Director)\s*)?/giu,
  /_{5,}\s*\[?[A-Za-z]/i,
]

const DISCLAIMER_PATTERNS: RegExp[] = [
  /Disclaimer:\s*This e-mail.*$/is,
  /This message contains confidential.*$/is,
  /This e-mail and any attached content may contain confidential.*$/is,
  /If you are not the (?:intended |named )?(?:recipient|addressee).*$/is,
  /Plunet GmbH,?\s*Commercial Register.*$/im,
  /Managing Director:.*$/im,
]

const SECURITY_WARNING =
  /Warning\s*-\s*External message:.*?(?:#Internal-IT-Support\s*(?:for help)?|for help)[\s.]*/gis
const HTML_TAGS = /<[^>]+>/g
const HTML_ENTITIES = /&(?:nbsp|amp|lt|gt|quot);/g
const FREQUENCY_WARNING =
  /Sie erhalten nicht häufig.*?(?:wichtig ist|why this is important)\s*/gis
const TEAMS_BLOCK = /_{5,}\s*Microsoft Teams meeting.*?_{5,}/gis
const PROMO_PATTERNS: RegExp[] = [
  /This was the Plunet Summit \d{4}\s*Check Out Our Best Practice Sessions Now!/gi,
  /Check Out Our Best Practice Sessions Now!/gi,
]

const BRACKET_JUNK = /\[(?:X|Smile|cid:[^\]]*)\]/gi
const MULTI_SPACE = /[ \t]{2,}/g
const ADDR_LINE = /(?:D-\d{5}\s+\w+|Dresdener\s+Str\.?\s*\d+)\s*/gi
const PHONE_BLOCK = /\+\d[\d\s()-]{6,}/gi
const CITY_LINE =
  /(?:Manila|Berlin|London|Sheffield|San Francisco)(?:\s*\|\s*(?:Manila|Berlin|London|Sheffield|San Francisco|UK))+/gi
const PERSON_TITLE_BLOCK =
  /(?:Sales Consultant|Office Manager|Team Lead Sales|Revenue Head|Managing Director|Project Manager)\s*/gi
const COMPANY_REG = /(?:Plunet\s+GmbH|QwertyWorks\.com)(?:\s+Dresdener)?/gi

export function removeNoiseLlm(text: string): string {
  let t = text
  t = t.replace(HTML_TAGS, '')
  t = t.replace(HTML_ENTITIES, ' ')
  t = t.replace(SECURITY_WARNING, '')
  t = t.replace(FREQUENCY_WARNING, '')
  t = t.replace(TEAMS_BLOCK, '[Teams meeting link]')
  for (const pat of DISCLAIMER_PATTERNS) {
    t = t.replace(pat, '')
  }
  for (const pat of SIGNATURE_PATTERNS) {
    t = t.replace(pat, '')
  }
  for (const pat of PROMO_PATTERNS) {
    t = t.replace(pat, '')
  }
  t = t.replace(BRACKET_JUNK, '')

  const lines = t.split('\n')
  let sigStart: number | null = null
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim()
    for (const pat of SIGNATURE_START_MULTILINE) {
      pat.lastIndex = 0
      if (pat.test(stripped)) {
        const remaining = lines.slice(i + 1).join('\n').trim()
        if (
          remaining.length < 600 &&
          !remaining.split('\n').some((rl) => rl.trim().length > 100)
        ) {
          sigStart = i
          break
        }
      }
    }
    if (sigStart !== null) break
  }
  if (sigStart !== null) {
    lines.splice(sigStart)
    t = lines.join('\n')
  } else {
    t = lines.join('\n')
  }

  for (const pat of INLINE_SIG_CUTOFF) {
    pat.lastIndex = 0
    const m = pat.exec(t)
    if (m && m.index > 20) {
      t = t.slice(0, m.index).trimEnd()
      break
    }
  }

  t = t.replace(PERSON_TITLE_BLOCK, '')
  t = t.replace(COMPANY_REG, '')
  t = t.replace(ADDR_LINE, '')
  t = t.replace(PHONE_BLOCK, '')
  t = t.replace(CITY_LINE, '')
  return t
}

// ---------------------------------------------------------------------------
// Greeting strip + word threshold
// ---------------------------------------------------------------------------

const LEADING_GREETING =
  /^(?:(?:Hi|Hello|Hey|Hi\s+there|Good\s+(?:morning|afternoon|evening)|Dear)\s+[^,\n!?]{1,72},?\s+)/i

export function stripLeadingGreeting(text: string): string {
  const t = text.trim()
  if (t.length < 45) return t
  const rest = t.replace(LEADING_GREETING, '').trim()
  return rest.length >= 25 ? rest : t
}

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'you',
  'are',
  'our',
  'with',
  'this',
  'that',
  'from',
  'have',
  'has',
  'was',
  'were',
  'will',
  'can',
  'not',
  'but',
  'your',
  'any',
  'all',
  'may',
  'its',
  'been',
  'also',
  'just',
  'into',
  'than',
  'then',
  'too',
  'very',
  'here',
  'there',
  'when',
  'what',
  'which',
  'who',
  'how',
  'about',
  'some',
  'such',
  'only',
  'more',
  'most',
  'other',
])

/** Tokens ≥3 chars, not in stopword list. */
export function meaningfulWordCount(text: string): number {
  const words = text.toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) || []
  return words.filter((w) => !STOPWORDS.has(w)).length
}

/** Drop when fewer than this many non-trivial words (after stopword filter). */
const MIN_MEANINGFUL_WORDS = 10

export function passesContentThreshold(content: string): boolean {
  const t = content.trim()
  if (!t) return false
  const n = meaningfulWordCount(t)
  if (/\bhttps?:\/\/\S{8,}/i.test(t) && n >= 5) return true
  return n >= MIN_MEANINGFUL_WORDS
}

// ---------------------------------------------------------------------------
// Normalize whitespace
// ---------------------------------------------------------------------------

export function normalizeLlm(text: string): string {
  let t = text.replace(MULTI_SPACE, ' ')
  t = t.replace(/\n{3,}/g, '\n\n')
  t = t.replace(/^\s+$/gm, '')
  return t.trim()
}

function normalizeForDedup(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

export function deduplicateParagraphsLlm<T extends Record<string, unknown>>(
  items: T[],
  bodyKey: keyof T & string = 'content' as keyof T & string
): T[] {
  const seen = new Set<string>()
  for (const msg of items) {
    const body = (msg[bodyKey] as string) || ''
    if (!body) continue
    const paras = body.split(/\n\s*\n/)
    const unique: string[] = []
    for (const p of paras) {
      const trimmed = p.trim()
      if (!trimmed) continue
      const norm = normalizeForDedup(trimmed)
      if (norm.length < 50) {
        unique.push(trimmed)
        continue
      }
      if (seen.has(norm)) continue
      seen.add(norm)
      unique.push(trimmed)
    }
    ;(msg as Record<string, unknown>)[bodyKey] = unique.join('\n\n')
  }
  return items
}

// ---------------------------------------------------------------------------
// Full message body pipeline
// ---------------------------------------------------------------------------

export function cleanMessageBodyLlm(text: string): string {
  let t = sanitizeUtf8(fixMojibake(text))
  t = hardCutReplyChain(t)
  t = stripQuotedContentLlm(t)
  t = removeNoiseLlm(t)
  t = stripLeadingGreeting(t)
  t = normalizeLlm(t)
  t = sanitizeUtf8(t)
  return t
}

function directionToFrom(direction: string | undefined): string {
  if (!direction || !direction.startsWith('from: ')) return ''
  return direction.slice(6).trim()
}

function recipientsForMessage(participants: string[], fromEmail: string): string[] {
  const f = fromEmail.toLowerCase()
  return [...new Set(participants.filter((p) => p.toLowerCase() !== f))]
}

function dedupeMessages(msgs: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>()
  const out: Record<string, unknown>[] = []
  for (const m of msgs) {
    const key = `${m.timestamp}|${m.from}|${normalizeForDedup(String(m.content || ''))}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(m)
  }
  return out
}

function processEmailThreadLlm(thread: Record<string, unknown>): Record<string, unknown> | null {
  const messagesIn = (thread.messages as Record<string, unknown>[]) || []
  if (!messagesIn.length) return null

  const participants = (thread.participants as string[]) || []
  const sorted = [...messagesIn].sort(
    (a, b) =>
      new Date(String(a.timestamp || 0)).getTime() -
      new Date(String(b.timestamp || 0)).getTime()
  )

  const cleanedMessages: Record<string, unknown>[] = []
  for (const msg of sorted) {
    const body = String(msg.body || '')
    const content = cleanMessageBodyLlm(body)
    if (!passesContentThreshold(content)) continue

    const from = directionToFrom(msg.direction as string | undefined)
    cleanedMessages.push({
      timestamp: msg.timestamp,
      from,
      to: recipientsForMessage(participants, from),
      content,
    })
  }

  if (!cleanedMessages.length) return null

  deduplicateParagraphsLlm(cleanedMessages, 'content')
  const filtered = cleanedMessages.filter((m) => String(m.content || '').trim())
  if (!filtered.length) return null

  const rawSubject = String(thread.subject || '')
  return {
    subject: normalizeSubjectKey(rawSubject),
    participants: [...new Set(participants.map((p) => sanitizeUtf8(fixMojibake(p.trim()))))],
    messages: filtered,
  }
}

function processOtherEngagementLlm(eng: Record<string, unknown>): Record<string, unknown> | null {
  const body = String(eng.body || '')
  const content = cleanMessageBodyLlm(body)
  if (!passesContentThreshold(content)) return null
  return {
    type: eng.type,
    timestamp: eng.timestamp,
    subject: normalizeSubjectKey(String(eng.subject || '')),
    content,
  }
}

function mergeThreadsByNormalizedSubject(
  threads: Record<string, unknown>[]
): Record<string, unknown>[] {
  const map = new Map<string, Record<string, unknown>>()
  for (const t of threads) {
    const key = String(t.subject || '')
    const existing = map.get(key)
    if (!existing) {
      map.set(key, t)
      continue
    }
    const pa = new Set<string>([
      ...((existing.participants as string[]) || []),
      ...((t.participants as string[]) || []),
    ])
    const combined = [
      ...((existing.messages as Record<string, unknown>[]) || []),
      ...((t.messages as Record<string, unknown>[]) || []),
    ]
    combined.sort(
      (a, b) =>
        new Date(String(a.timestamp || 0)).getTime() -
        new Date(String(b.timestamp || 0)).getTime()
    )
    existing.participants = [...pa]
    existing.messages = dedupeMessages(combined)
  }
  return [...map.values()]
}

/**
 * Input: the `engagements` array from `groupEmailThreads` (EMAIL_THREAD + NOTE/TASK/MEETING/CALL/single EMAIL).
 */
export function processLlmEngagementsFromGrouped(grouped: any[]): {
  threads: Record<string, unknown>[]
  other_engagements: Record<string, unknown>[]
} {
  const threads: Record<string, unknown>[] = []
  const other: Record<string, unknown>[] = []

  for (const eng of grouped) {
    if (eng?.type === 'EMAIL_THREAD') {
      const t = processEmailThreadLlm(eng as Record<string, unknown>)
      if (t) threads.push(t)
    } else {
      const o = processOtherEngagementLlm(eng as Record<string, unknown>)
      if (o) other.push(o)
    }
  }

  const mergedThreads = mergeThreadsByNormalizedSubject(threads)

  const allForDedup: Record<string, unknown>[] = [
    ...other,
    ...mergedThreads.flatMap((t) => (t.messages as Record<string, unknown>[]) || []),
  ]
  deduplicateParagraphsLlm(allForDedup, 'content')

  for (const t of mergedThreads) {
    t.messages = ((t.messages as Record<string, unknown>[]) || []).filter((m) =>
      String(m.content || '').trim()
    )
  }

  return {
    threads: mergedThreads.filter((t) => ((t.messages as unknown[]) || []).length > 0),
    other_engagements: other.filter((o) => String(o.content || '').trim()),
  }
}
