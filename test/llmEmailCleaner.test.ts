import {
  normalizeSubjectKey,
  sanitizeUtf8,
  hardCutReplyChain,
  stripLeadingGreeting,
  meaningfulWordCount,
  passesContentThreshold,
  cleanMessageBodyLlm,
} from '../src/llmEmailCleaner'

describe('llmEmailCleaner', () => {
  test('normalizeSubjectKey merges re/fw and lowercases', () => {
    expect(normalizeSubjectKey('  RE: FW: Hello World  ')).toBe('hello world')
    expect(normalizeSubjectKey('\tRE: Re:\xa0Foo')).toBe('foo')
  })

  test('sanitizeUtf8 removes ÿè and replacement char', () => {
    expect(sanitizeUtf8('Awesome \u00ff\u00e8 thanks')).toBe('Awesome  thanks')
    expect(sanitizeUtf8('a\ufffdb')).toBe('ab')
  })

  test('hardCutReplyChain cuts at From:', () => {
    const s = 'New line here. From: bob@test.com Sent: Mon To: you'
    expect(hardCutReplyChain(s)).toBe('New line here.')
  })

  test('stripLeadingGreeting removes Hi Name, when enough body remains', () => {
    const body =
      'Hi Kristine, Thanks again for your time this morning. We discussed pricing and next steps for the project.'
    const out = stripLeadingGreeting(body)
    expect(out.startsWith('Hi Kristine')).toBe(false)
    expect(out).toContain('pricing')
  })

  test('passesContentThreshold requires min meaningful words or URL shortcut', () => {
    expect(passesContentThreshold('ok thanks')).toBe(false)
    expect(
      passesContentThreshold(
        'one two three four five six seven eight nine ten eleven'
      )
    ).toBe(true)
    expect(
      passesContentThreshold('see https://example.com/path/to/doc and five tiny words extra')
    ).toBe(true)
  })

  test('meaningfulWordCount excludes stopwords', () => {
    expect(meaningfulWordCount('the and for you')).toBe(0)
    expect(meaningfulWordCount('pricing deadline deliverables scope budget')).toBe(5)
  })

  test('cleanMessageBodyLlm pipeline', () => {
    const raw =
      'Warning - External message: help. Hi Gunnar, NDA cleared on our end. From: Other Sent: Mon Old'
    const out = cleanMessageBodyLlm(raw)
    expect(out).toContain('NDA')
    expect(out.toLowerCase()).not.toContain('from:')
  })
})
