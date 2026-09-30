/**
 * Documentation and research scenarios: writing and translating docs,
 * comparing libraries, summarising specifications and checking docs against
 * code.
 *
 * Writing a document is `implement` to the dispatcher (it edits files); reading
 * and summarising is `research`. "Check the docs against the code" is a trap
 * (tag `trap`): it is verification work with none of the verify keywords.
 *
 * Labels are starter labels. Review them before using them for training.
 */
import type { BenchScenario } from '../benchmark.js'

const WRITER = 'tech-writer'

export const DOCS_RESEARCH_SCENARIOS: readonly BenchScenario[] = [
  {
    id: 'docs-readme-quickstart',
    tags: ['implement', 'docs'],
    description: 'Write the Quickstart section of the README',
    prompt:
      'Write a Quickstart section for README.md: install, first run, a minimal config and one common error with its fix. Keep it under 40 lines and check that the commands work.',
    gold: {
      role: 'implement',
      complexity: ['trivial', 'moderate'],
      needsLongContext: false,
      agentType: [WRITER, 'dev'],
      model: { tier: ['fast', 'standard'] },
    },
  },
  {
    id: 'docs-api-reference-openapi',
    tags: ['implement', 'docs'],
    description: 'Generate the API reference from the OpenAPI spec',
    prompt:
      'Generate markdown API reference pages from openapi.yaml into docs/api/, one page per tag, with example requests, and link them from docs/index.md.',
    gold: {
      role: 'implement',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: [WRITER, 'dev'],
      model: { tier: 'standard' },
    },
  },
  {
    id: 'docs-translate-readme-czech',
    tags: ['implement', 'docs', 'non-english'],
    description: 'Přelož README do češtiny',
    prompt:
      'Přelož README.md do češtiny do souboru README.cs.md. Všechny bloky kódu a odkazy nech beze změny.',
    gold: {
      role: 'implement',
      complexity: ['trivial', 'moderate'],
      needsLongContext: false,
      agentType: [WRITER, 'dev'],
      model: { tier: ['fast', 'standard'] },
    },
  },
  {
    id: 'docs-release-notes',
    tags: ['implement', 'docs'],
    description: 'Write the release notes for 2.4',
    prompt:
      'Write release notes for 2.4 from the pull requests merged since v2.3.0 (use git log): group them into features, fixes and breaking changes, and give upgrade steps for each breaking change.',
    gold: {
      role: 'implement',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: [WRITER, 'dev'],
      model: { tier: 'standard' },
    },
  },
  {
    id: 'docs-migration-guide-v2',
    tags: ['implement', 'docs', 'hard', 'long-context'],
    description: 'Write the v1 to v2 migration guide',
    prompt:
      'Write a migration guide for users upgrading from v1 to v2: renamed options, removed APIs, behaviour changes and before-and-after snippets. Derive it from the diff between the v1 and v2 public API.',
    gold: {
      role: 'implement',
      complexity: 'hard',
      needsLongContext: true,
      agentType: [WRITER, 'dev'],
      model: { tier: ['standard', 'deep'], minContext: 200_000 },
    },
  },
  {
    id: 'docs-compare-http-clients',
    tags: ['research', 'docs'],
    description: 'Compare three HTTP client libraries',
    prompt:
      'Compare undici, axios and got for our Node service: proxy support, retries, streaming, bundle size and maintenance activity. End with a recommendation and the migration effort.',
    gold: {
      role: 'research',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: 'explorer',
      model: { tier: 'standard' },
    },
  },
  {
    id: 'docs-summarise-rfc-caching',
    tags: ['research', 'docs'],
    description: 'Summarise the caching rules in RFC 9110',
    prompt:
      'Summarise the caching rules in RFC 9110 that matter for our reverse proxy: freshness, validation and Vary. One page, with the exact section numbers.',
    gold: {
      role: 'research',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: 'explorer',
      model: { tier: 'standard' },
    },
  },
  {
    id: 'docs-find-prior-art',
    tags: ['research', 'docs'],
    description: 'Find prior art for our tree diffing approach',
    prompt:
      "Find published prior art or existing open-source libraries for tree diffing with move detection. List the three most relevant, what each does and doesn't handle, and links.",
    gold: {
      role: 'research',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: 'explorer',
      model: { tier: 'standard' },
    },
  },
  {
    id: 'docs-trap-docs-match-code',
    tags: ['trap', 'verify', 'docs'],
    description: 'Check the configuration docs against the code',
    prompt:
      'Compare docs/configuration.md with the code: every option, default and environment variable it lists must exist and match. Report the mismatches with file and line.',
    gold: {
      role: 'verify',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: ['verifier', 'explorer'],
      model: { tier: 'standard' },
    },
  },
]
