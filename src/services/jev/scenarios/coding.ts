/**
 * Coding scenarios: bug fixes, features, refactors, migrations, performance and
 * concurrency work, and writing tests or queries.
 *
 * The difficulty ladder is deliberate. The policy sends implement work to the
 * standard tier and only bumps it to deep when the task is hard, so whether a
 * router can tell a one-line fix from a subtle concurrency bug is the thing
 * these scenarios measure. Some prompts carry words that point at another role
 * ("add unit tests" reads as verify); they are tagged `trap`.
 *
 * Labels are starter labels. Review them before using them for training.
 */
import type { BenchScenario } from '../benchmark.js'

const DEV = 'dev'
const CHEAP = { tier: ['fast', 'standard'] } as const
const STANDARD = { tier: 'standard' } as const
const DEEP = { tier: 'deep' } as const

export const CODING_SCENARIOS: readonly BenchScenario[] = [
  {
    id: 'code-bugfix-off-by-one',
    tags: ['implement', 'bugfix'],
    description: 'Fix off-by-one in pagination',
    prompt:
      'listItems() in src/api/list.ts returns one item too few on the last page when the total is an exact multiple of the page size. Fix it and add a regression test.',
    gold: { role: 'implement', complexity: ['trivial', 'moderate'], needsLongContext: false, agentType: DEV, model: CHEAP },
  },
  {
    id: 'code-bugfix-regex-email',
    tags: ['implement', 'bugfix'],
    description: 'Fix the email validation regex',
    prompt:
      'The email validator in src/validate.ts rejects addresses with a plus sign and accepts ones with two @ characters. Fix both and add test cases for them.',
    gold: { role: 'implement', complexity: 'trivial', needsLongContext: false, agentType: DEV, model: CHEAP },
  },
  {
    id: 'code-bugfix-intermittent-crash',
    tags: ['implement', 'bugfix', 'hard'],
    description: 'Fix the crash when a client disconnects mid-stream',
    prompt:
      "The server occasionally throws \"Cannot read properties of undefined\" when a client disconnects mid-stream, and only under load. Find the cause, fix it without adding a blanket try/catch, and prove it with a test that fails before the fix.",
    gold: { role: 'implement', complexity: 'hard', needsLongContext: false, agentType: DEV, model: DEEP },
  },
  {
    id: 'code-bugfix-worker-pool-deadlock',
    tags: ['implement', 'concurrency', 'hard'],
    description: 'Fix the worker pool deadlock',
    prompt:
      'The worker pool hangs when every worker is waiting on a task that needs a free worker. Reproduce it with a test, redesign the scheduling so nested tasks cannot starve the pool, and keep the public API unchanged.',
    gold: { role: 'implement', complexity: 'hard', needsLongContext: false, agentType: DEV, model: DEEP },
  },
  {
    id: 'code-feature-rate-limit',
    tags: ['implement', 'feature'],
    description: 'Add per-user rate limiting to the upload endpoint',
    prompt:
      'Add a per-user token-bucket rate limit to /api/upload (60 requests per minute, configurable through RATE_LIMIT_PER_MIN). Return 429 with a Retry-After header and cover it with tests.',
    gold: { role: 'implement', complexity: 'moderate', needsLongContext: false, agentType: DEV, model: STANDARD },
  },
  {
    id: 'code-feature-github-signin',
    tags: ['implement', 'feature', 'hard'],
    description: 'Implement Sign in with GitHub',
    prompt:
      "Implement 'Sign in with GitHub' using the existing OAuth helper: new /auth/github and /auth/github/callback routes, session creation, account linking by verified email, and tests with a mocked provider. Update the login page.",
    gold: { role: 'implement', complexity: 'hard', needsLongContext: false, agentType: DEV, model: DEEP },
  },
  {
    id: 'code-feature-lru-cache',
    tags: ['implement', 'algorithm'],
    description: 'Implement an LRU cache',
    prompt:
      'Implement an LRU cache in src/lib/lru.ts with get, set, delete and size, O(1) operations and a configurable capacity, plus property-based tests.',
    gold: { role: 'implement', complexity: 'moderate', needsLongContext: false, agentType: DEV, model: STANDARD },
  },
  {
    id: 'code-refactor-extract-retry',
    tags: ['implement', 'refactor'],
    description: 'Extract the retry logic into a shared helper',
    prompt:
      'The retry and backoff code is copy-pasted in four services. Extract one helper with a clear API, migrate all four call sites, keep behaviour the same and keep the tests green.',
    gold: { role: 'implement', complexity: 'moderate', needsLongContext: false, agentType: DEV, model: STANDARD },
  },
  {
    id: 'code-refactor-strict-types',
    tags: ['implement', 'refactor'],
    description: 'Turn on strict mode for the utils package',
    prompt:
      'Enable "strict": true in packages/utils/tsconfig.json and fix every type error it surfaces without using any or ts-ignore.',
    gold: { role: 'implement', complexity: 'moderate', agentType: DEV, model: STANDARD },
  },
  {
    id: 'code-migration-esm',
    tags: ['implement', 'migration', 'hard', 'long-context'],
    description: 'Migrate the package from CommonJS to ESM',
    prompt:
      'Convert the package from CommonJS to ESM: the package.json type field, import and export syntax, file extensions on relative imports, __dirname replacements and the jest config. The build and all tests must pass afterwards.',
    gold: { role: 'implement', complexity: 'hard', needsLongContext: true, agentType: DEV, model: { tier: 'deep', minContext: 200_000 } },
  },
  {
    id: 'code-migration-date-library',
    tags: ['implement', 'migration'],
    description: 'Replace moment with date-fns',
    prompt:
      'Replace every use of moment in src/ with the date-fns equivalent, remove the dependency, and check that the timezone-sensitive tests still pass.',
    gold: { role: 'implement', complexity: 'moderate', needsLongContext: false, agentType: DEV, model: STANDARD },
  },
  {
    id: 'code-perf-search-index',
    tags: ['implement', 'performance', 'hard'],
    description: 'Speed up the search index build',
    prompt:
      'Building the search index takes 42 seconds for 100k documents. Profile it, find the dominant cost and cut the build time at least threefold without changing the index format. Report before and after timings.',
    gold: { role: 'implement', complexity: 'hard', needsLongContext: false, agentType: DEV, model: DEEP },
  },
  {
    id: 'code-trap-add-unit-tests',
    tags: ['trap', 'implement', 'tests'],
    description: 'Add unit tests for the tokenizer',
    prompt:
      'Add unit tests for src/lib/tokenizer.ts covering empty input, unicode, escaped quotes and unterminated strings. Aim for branch coverage above 90 percent.',
    gold: { role: 'implement', complexity: 'moderate', needsLongContext: false, agentType: DEV, model: STANDARD },
  },
  {
    id: 'code-sql-monthly-revenue',
    tags: ['implement', 'sql'],
    description: 'Write the monthly revenue query',
    prompt:
      'Write a PostgreSQL query that returns monthly revenue per plan for the last 12 months from the invoices and subscriptions tables, treating refunds as negative revenue. Save it as db/queries/monthly_revenue.sql with a short comment on the assumptions.',
    gold: { role: 'implement', complexity: 'moderate', needsLongContext: false, agentType: DEV, model: STANDARD },
  },
  {
    id: 'code-port-python-to-typescript',
    tags: ['implement', 'port'],
    description: 'Port the CSV cleaner from Python to TypeScript',
    prompt:
      'Port scripts/clean_csv.py to TypeScript (src/tools/cleanCsv.ts) with identical behaviour on the sample files in fixtures/csv, and add a test that runs both versions on every fixture and compares the output.',
    gold: { role: 'implement', complexity: 'moderate', needsLongContext: false, agentType: DEV, model: STANDARD },
  },
  {
    id: 'code-codemod-config-api',
    tags: ['implement', 'codemod'],
    description: 'Write a codemod to rename the config API',
    prompt:
      'Write a jscodeshift codemod that renames getConfigValue(key) to config.get(key) across the repo, run it, and fix any call sites it could not transform.',
    gold: { role: 'implement', complexity: 'moderate', needsLongContext: false, agentType: DEV, model: STANDARD },
  },
  {
    id: 'code-ci-lint-green',
    tags: ['implement', 'ci'],
    description: 'Make the lint job pass',
    prompt:
      'The CI lint job fails on 23 ESLint errors after the config upgrade. Fix the code or the config as appropriate, preferring the code, and get the job green locally.',
    gold: { role: 'implement', complexity: 'moderate', needsLongContext: false, agentType: DEV, model: STANDARD },
  },
  {
    id: 'code-ambiguous-hotfix',
    tags: ['ambiguous', 'terse'],
    description: 'hotfix: prod 500 on /checkout',
    prompt: '',
  },
]
