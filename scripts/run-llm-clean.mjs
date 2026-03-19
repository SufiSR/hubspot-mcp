#!/usr/bin/env node
/**
 * Offline helper: run the same LLM cleaning as engagement_summary_associated (llmOptimize: true)
 * on a saved JSON file that has an "engagements" array (grouped shape from llmOptimize: false).
 *
 * Usage (after npm run build):
 *   node scripts/run-llm-clean.mjs deduped_clean.json examples/llm_optimized_comparison_output.json
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { processLlmEngagementsFromGrouped } from '../dist/llmEmailCleaner.js'

const [, , inputPath, outputPath] = process.argv
if (!inputPath || !outputPath) {
  console.error('Usage: node scripts/run-llm-clean.mjs <input.json> <output.json>')
  console.error('Input must be JSON with top-level "engagements" array (grouped hubspot summary).')
  process.exit(1)
}

const raw = readFileSync(inputPath, 'utf8')
const data = JSON.parse(raw.startsWith('\ufeff') ? raw.slice(1) : raw)
const grouped = data.engagements
if (!Array.isArray(grouped)) {
  console.error('Expected top-level "engagements" array.')
  process.exit(1)
}

const { threads, other_engagements } = processLlmEngagementsFromGrouped(grouped)
const out = {
  summary: data.summary,
  threads,
  other_engagements,
  llmOptimized: true,
}

writeFileSync(outputPath, JSON.stringify(out, null, 2), 'utf8')
const inSize = JSON.stringify(data).length
const outSize = JSON.stringify(out).length
console.log(`Wrote ${outputPath}`)
console.log(`Size: ${inSize.toLocaleString()} → ${outSize.toLocaleString()} chars (${((1 - outSize / inSize) * 100).toFixed(1)}% smaller)`)
