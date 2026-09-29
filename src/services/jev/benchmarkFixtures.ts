/**
 * Fixtures for the JEV decision benchmark: a synthetic environment (so results
 * do not depend on this machine's saved profiles or auth) and a seed scenario
 * set.
 *
 * The seed labels are STARTER labels. The role → tier gold follows the
 * documented policy (docs/agent-routing.md); complexity, long-context and
 * agent-type labels are one reviewer's judgment. Review and extend them before
 * using the set to train anything, and prefer scenarios that carry a real
 * signal over ones that merely restate a keyword.
 */
import type { ProviderProfile } from '../../utils/config.js'
import type { SettingsJson } from '../../utils/settings/types.js'
import type { AgentTypeOption } from '../api/smartRouting/teammate.js'
import type { BenchEnvironment, BenchScenario } from './benchmark.js'

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export const BENCH_PROFILE_NAMES = ['deepseek', 'zai', 'codex', 'fireworks'] as const
export type BenchProfileName = (typeof BENCH_PROFILE_NAMES)[number]

/** The profiles a default run includes. `fireworks` (about 280 models) is opt-in. */
export const DEFAULT_BENCH_PROFILES: readonly BenchProfileName[] = ['deepseek', 'zai', 'codex']

const PROFILES: Readonly<Record<BenchProfileName, ProviderProfile>> = {
  deepseek: {
    id: 'bench_deepseek',
    name: 'DeepSeek',
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-pro, deepseek-v4.1-flash',
    apiKey: 'sk-bench-not-real',
  },
  zai: {
    id: 'bench_zai',
    name: 'Z.ai',
    provider: 'zai',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    model: 'glm-5.3, glm-5.3-flash',
    apiKey: 'zai-bench-not-real',
  },
  codex: {
    id: 'bench_codex',
    name: 'Codex',
    provider: 'openai',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    model: 'codexplan',
  },
  fireworks: {
    id: 'bench_fireworks',
    name: 'Fireworks',
    provider: 'openai',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    model: 'accounts/fireworks/models/deepseek-v3p1',
    apiKey: 'fw-bench-not-real',
  },
}

/**
 * Agent definitions JEV may choose between. Project-sourced ones are offered
 * on the teammate path; the built-ins only on the subagent path.
 */
export const DEFAULT_BENCH_AGENT_TYPES: readonly AgentTypeOption[] = [
  {
    agentType: 'explorer',
    source: 'project',
    whenToUse:
      'Read-only codebase exploration: locate code, trace how something works, summarize findings. Never modifies files.',
    tools: ['Read', 'Grep', 'Glob', 'Bash'],
  },
  {
    agentType: 'planner',
    source: 'project',
    whenToUse:
      'Software architect: plans an implementation, weighs trade-offs and produces a step-by-step design. Read-only.',
    tools: ['Read', 'Grep', 'Glob'],
  },
  {
    agentType: 'dev',
    source: 'project',
    whenToUse:
      'Implements features and fixes bugs in the repository: edits files, runs the build and tests, commits.',
  },
  {
    agentType: 'verifier',
    source: 'project',
    whenToUse:
      'Independently verifies that a change works: runs tests, typecheck and the build, probes edge cases, and reports pass/fail with evidence.',
    tools: ['Read', 'Grep', 'Glob', 'Bash'],
  },
  {
    agentType: 'code-reviewer',
    source: 'project',
    whenToUse:
      'Reviews a diff or change for correctness, security and maintainability; reports findings without editing.',
    tools: ['Read', 'Grep', 'Glob', 'Bash'],
  },
  {
    agentType: 'browser-tester',
    source: 'project',
    whenToUse:
      'Drives a real browser with Playwright: navigates, clicks, fills forms and takes screenshots to check UI flows.',
    tools: [
      'Read',
      'Bash',
      'mcp__playwright__browser_navigate',
      'mcp__playwright__browser_click',
      'mcp__playwright__browser_take_screenshot',
    ],
  },
  {
    agentType: 'general-purpose',
    source: 'built-in',
    whenToUse:
      'General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks.',
  },
  {
    agentType: 'Explore',
    source: 'built-in',
    whenToUse:
      'Fast read-only agent specialized for exploring codebases: find files by pattern, search code for keywords, answer questions about the codebase.',
    tools: ['Read', 'Grep', 'Glob', 'Bash'],
  },
  {
    agentType: 'Plan',
    source: 'built-in',
    whenToUse:
      'Software architect agent for designing implementation plans: returns step-by-step plans and identifies critical files. Read-only.',
    tools: ['Read', 'Grep', 'Glob'],
  },
]

export type EnvironmentOptions = {
  /**
   * `default`: leave teammateModelAllowlist unset, so only the matrix families
   * are offered (what an unconfigured user gets). `*`: every catalog model on
   * every route. Or an explicit list of families / ids.
   */
  allowlist?: 'default' | '*' | readonly string[]
  leaderRoute?: string
  anthropicAuth?: boolean
  profiles?: readonly BenchProfileName[]
  agentTypes?: readonly AgentTypeOption[]
  /** Rule A thresholds and the JEV timeout, as `teammateDispatch.jev` settings. */
  minP?: number
  minMargin?: number
  timeoutMs?: number
}

export function buildBenchEnvironment(options: EnvironmentOptions = {}): BenchEnvironment {
  const allowlist = options.allowlist ?? 'default'
  const jev: Record<string, unknown> = { enabled: true }
  if (options.minP !== undefined) jev.minP = options.minP
  if (options.minMargin !== undefined) jev.minMargin = options.minMargin
  if (options.timeoutMs !== undefined) jev.timeoutMs = options.timeoutMs
  const settings = {
    ...(allowlist === 'default'
      ? {}
      : { teammateModelAllowlist: allowlist === '*' ? ['*'] : [...allowlist] }),
    teammateDispatch: { mode: 'auto', jev },
  } as SettingsJson
  return {
    leaderRoute: options.leaderRoute ?? 'anthropic',
    anthropicAuth: options.anthropicAuth ?? true,
    profiles: (options.profiles ?? DEFAULT_BENCH_PROFILES).map(name => PROFILES[name]),
    settings,
    agentTypes: options.agentTypes ?? DEFAULT_BENCH_AGENT_TYPES,
  }
}

// ---------------------------------------------------------------------------
// Seed scenarios
// ---------------------------------------------------------------------------

const EXPLORER = 'explorer'
const PLANNER = 'planner'
const DEV = 'dev'
const VERIFIER = 'verifier'
const REVIEWER = 'code-reviewer'
const BROWSER = 'browser-tester'

export const SEED_SCENARIOS: readonly BenchScenario[] = [
  // ---- research --------------------------------------------------------
  {
    id: 'research-trivial-locate',
    tags: ['research', 'trivial'],
    description: 'Find where --max-turns is parsed',
    prompt:
      'Locate where the CLI parses the --max-turns option and tell me the file and line. Read-only; do not change anything.',
    gold: {
      role: 'research',
      complexity: 'trivial',
      needsLongContext: false,
      agentType: EXPLORER,
      model: { tier: ['fast', 'standard'] },
    },
  },
  {
    id: 'research-moderate-oauth',
    tags: ['research'],
    description: 'Investigate the OAuth token refresh flow',
    prompt:
      'Investigate how OAuth token refresh works across src/utils/auth*.ts and src/services/oauth. Explain the lock handling and what happens when two processes refresh at once. Report findings only — do not modify files.',
    gold: {
      role: 'research',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: EXPLORER,
      model: { tier: 'standard' },
    },
  },
  {
    id: 'research-hard-transcripts',
    tags: ['research', 'long-context'],
    description: 'Survey every reader and writer of the session transcript format',
    prompt:
      'Survey the whole repository for every place the session transcript (jsonl) format is read, written or migrated — roughly 150 files across src/utils, src/cli and src/tools — and produce an impact report for changing the message schema. Do not modify files.',
    gold: {
      role: 'research',
      complexity: 'hard',
      needsLongContext: true,
      agentType: EXPLORER,
      model: { tier: ['standard', 'deep'], minContext: 200_000 },
    },
  },
  {
    id: 'research-long-docs',
    tags: ['research', 'long-context'],
    description: 'Find contradictions across all docs',
    prompt:
      'Read every file under docs/ and README.md and list statements that contradict each other or the current code behaviour (for example env var names and defaults). Cite file and line for each contradiction.',
    gold: {
      role: 'research',
      complexity: 'moderate',
      needsLongContext: true,
      agentType: EXPLORER,
      model: { tier: ['standard', 'deep'], minContext: 200_000 },
    },
  },
  {
    id: 'research-negation',
    tags: ['research', 'negation'],
    description: 'Survey the tests',
    prompt:
      'Survey the test files under src/services/api and summarise what each file covers. Do not modify files. Do not commit anything.',
    gold: {
      role: 'research',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: EXPLORER,
      model: { tier: ['standard', 'fast'] },
    },
  },
  {
    id: 'research-explicit-explorer',
    tags: ['research', 'explicit-type'],
    subagentType: EXPLORER,
    description: 'Where is the stream idle timeout configured?',
    prompt:
      'Find where the stream idle timeout is configured and what its default is. Report only.',
    gold: {
      role: 'research',
      complexity: 'trivial',
      needsLongContext: false,
      model: { tier: ['fast', 'standard'] },
    },
  },
  {
    id: 'research-subagent-explore',
    tags: ['research', 'subagent'],
    spawnPath: 'subagent',
    description: 'Find usages of getAPIProvider',
    prompt:
      'List every file that calls getAPIProvider() and group them by how they use the result. Read-only.',
    gold: {
      role: 'research',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: 'Explore',
      model: { tier: 'standard' },
    },
  },

  // ---- implement -------------------------------------------------------
  {
    id: 'impl-trivial-typo',
    tags: ['implement', 'trivial'],
    description: 'Fix typo in retry comment',
    prompt:
      "Fix the typo 'recieve' in the comment above the retry loop in src/services/api/withRetry.ts. Nothing else should change.",
    gold: {
      role: 'implement',
      complexity: 'trivial',
      needsLongContext: false,
      agentType: DEV,
      model: { tier: ['fast', 'standard'] },
    },
  },
  {
    id: 'impl-trivial-czech',
    tags: ['implement', 'trivial', 'non-english'],
    description: 'Oprav překlep v komentáři',
    prompt:
      "V souboru src/utils/retry.ts oprav překlep ve slově 'exponencialni' v komentáři nad funkcí backoff. Nic jiného neměň.",
    gold: {
      role: 'implement',
      complexity: 'trivial',
      needsLongContext: false,
      agentType: DEV,
      model: { tier: ['fast', 'standard'] },
    },
  },
  {
    id: 'impl-trivial-docs',
    tags: ['implement', 'trivial'],
    description: 'Document the new env var',
    prompt:
      'Add a short section to docs/advanced-setup.md describing the OPENCLAUDE_DISABLE_HEAP_RELAUNCH environment variable and when to use it.',
    gold: {
      role: 'implement',
      complexity: 'trivial',
      needsLongContext: false,
      agentType: DEV,
      model: { tier: ['fast', 'standard'] },
    },
  },
  {
    id: 'impl-moderate-pagination',
    tags: ['implement'],
    description: 'Add cursor pagination to the sessions list endpoint',
    prompt:
      'Add cursor-based pagination to the sessions list in src/server/routes.ts: accept ?cursor= and ?limit=, return nextCursor, and keep the existing response shape when no cursor is given. Add unit tests and run them.',
    gold: {
      role: 'implement',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: DEV,
      model: { tier: 'standard' },
    },
  },
  {
    id: 'impl-hard-race',
    tags: ['implement', 'hard'],
    description: 'Fix the mailbox race that drops teammate messages',
    prompt:
      "Two writers can append to a teammate's mailbox at the same time and one message is lost. Reproduce it with a failing test, fix it without holding a lock across await points, and make sure the existing swarm tests still pass.",
    gold: {
      role: 'implement',
      complexity: 'hard',
      needsLongContext: false,
      agentType: DEV,
      model: { tier: 'deep' },
    },
  },
  {
    id: 'impl-hard-wide-refactor',
    tags: ['implement', 'hard', 'long-context'],
    description: 'Consolidate provider env handling into one resolver',
    prompt:
      'Provider environment variables are read in seven different places. Introduce a single resolver, migrate all call sites (about 40 files across src/utils, src/services and src/integrations), keep behaviour identical and update the tests.',
    gold: {
      role: 'implement',
      complexity: 'hard',
      needsLongContext: true,
      agentType: DEV,
      model: { tier: 'deep', minContext: 200_000 },
    },
  },

  // ---- review (separated from the implementer's model family) ----------
  {
    id: 'review-auth-diff',
    tags: ['review', 'separation'],
    implementers: ['claude-opus-5-5'],
    description: 'Review the auth refresh diff',
    prompt:
      'Review the diff on branch feature/auth-refresh (src/utils/auth.ts and the new tests) for correctness and security. Focus on token handling and lock ordering. Report findings ranked by severity; do not edit.',
    gold: {
      role: 'review',
      complexity: ['moderate', 'hard'],
      needsLongContext: false,
      agentType: REVIEWER,
      model: { tier: 'deep' },
    },
  },
  {
    id: 'review-small-change',
    tags: ['review', 'separation'],
    implementers: ['claude-sonnet-5-5'],
    description: 'Code review a small retry change',
    prompt:
      'Code review this 20-line change to the retry backoff in src/services/api/withRetry.ts — check off-by-one errors and that the jitter is bounded.',
    gold: {
      role: 'review',
      complexity: ['trivial', 'moderate'],
      needsLongContext: false,
      agentType: REVIEWER,
      model: { tier: 'deep' },
    },
  },
  {
    id: 'review-security-audit',
    tags: ['review', 'hard'],
    description: 'Audit the Bash tool for command injection',
    prompt:
      'Audit src/tools/BashTool and src/utils/bash for command-injection weaknesses: quoting, redirections, here-docs and substitutions. Critique the existing validators and list concrete bypasses you can construct.',
    gold: {
      role: 'review',
      complexity: 'hard',
      needsLongContext: false,
      agentType: REVIEWER,
      model: { tier: 'deep' },
    },
  },
  {
    id: 'review-design-doc',
    tags: ['review'],
    description: 'Critique the agent routing doc',
    prompt:
      'Read docs/agent-routing.md and critique it: what is unclear, contradicted by the code, or missing? Give feedback on the structure as well.',
    gold: {
      role: 'review',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: [REVIEWER, 'default'],
      model: { tier: 'deep' },
    },
  },
  {
    id: 'review-vs-deepseek',
    tags: ['review', 'separation'],
    implementers: ['deepseek-v4-pro'],
    description: 'Review the pagination change',
    prompt:
      'Review the pagination change in src/server/routes.ts (cursor + limit). Look for boundary bugs and missing tests.',
    gold: {
      role: 'review',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: REVIEWER,
      model: { tier: 'deep', notIn: ['deepseek-v4-pro', 'deepseek-flash'] },
    },
  },
  {
    id: 'review-explicit-reviewer',
    tags: ['review', 'separation', 'explicit-type'],
    subagentType: REVIEWER,
    implementers: ['claude-sonnet-5-5'],
    description: 'Review the retry backoff change',
    prompt: 'Review the retry backoff change in src/services/api/withRetry.ts.',
    gold: {
      role: 'review',
      complexity: ['trivial', 'moderate'],
      model: { tier: 'deep' },
    },
  },

  // ---- verify ----------------------------------------------------------
  {
    id: 'verify-run-tests',
    tags: ['verify'],
    description: 'Run the swarm tests and report',
    prompt:
      'Run the tests under src/utils/swarm and report which pass and which fail, with the failure output for each failing test. Do not change any code.',
    gold: {
      role: 'verify',
      complexity: ['trivial', 'moderate'],
      needsLongContext: false,
      agentType: VERIFIER,
      model: { tier: ['standard', 'fast'] },
    },
  },
  {
    id: 'verify-edge-cases',
    tags: ['verify', 'separation'],
    implementers: ['claude-sonnet-5-5'],
    description: 'Verify the pagination fix with edge cases',
    prompt:
      'Prove the pagination change works: write and run tests for an empty result, exactly one page, the last page, an invalid cursor and a limit of zero. Report any case that misbehaves.',
    gold: {
      role: 'verify',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: VERIFIER,
      model: { tier: 'standard' },
    },
  },
  {
    id: 'verify-stress-hard',
    tags: ['verify', 'hard', 'separation'],
    implementers: ['claude-opus-5-5'],
    description: 'Verify the mailbox race is really fixed',
    prompt:
      'Determine whether the mailbox message-loss race is actually fixed: build a stress test with 1000 concurrent writers across 20 runs, report the loss rate before and after the fix, and say how confident you are.',
    gold: {
      role: 'verify',
      complexity: 'hard',
      needsLongContext: false,
      agentType: VERIFIER,
      model: { tier: ['standard', 'deep'] },
    },
  },
  {
    id: 'verify-build-check',
    tags: ['verify', 'trivial', 'negation'],
    description: 'Confirm typecheck and build pass',
    prompt:
      'Do not modify any files. Run the typecheck and the build and confirm both pass; if not, paste the first error.',
    gold: {
      role: 'verify',
      complexity: 'trivial',
      needsLongContext: false,
      agentType: VERIFIER,
      model: { tier: ['fast', 'standard'] },
    },
  },
  {
    id: 'verify-qa-flow',
    tags: ['verify'],
    description: 'QA the provider onboarding flow',
    prompt:
      'QA the /provider onboarding flow against the checklist in docs/quick-start-mac-linux.md. Run each step, note where the wording or the behaviour differs from the checklist, and report.',
    gold: {
      role: 'verify',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: VERIFIER,
      model: { tier: 'standard' },
    },
  },

  // ---- design ----------------------------------------------------------
  {
    id: 'design-cache-arch',
    tags: ['design', 'hard'],
    description: 'Design incremental repo map updates',
    prompt:
      'Design how the repo map should update incrementally when files change instead of rebuilding from scratch. Cover cache invalidation, the PageRank recomputation cost and failure modes. Produce a plan with trade-offs; do not implement.',
    gold: {
      role: 'design',
      complexity: 'hard',
      needsLongContext: false,
      agentType: PLANNER,
      model: { tier: 'deep' },
    },
  },
  {
    id: 'design-flaky-root-cause',
    tags: ['design', 'hard', 'long-context'],
    description: 'Find the root cause of the order-dependent test failure',
    prompt:
      'The full test suite fails in one model-picker test but that test passes alone. Find the root cause: bisect the preceding files, inspect process-wide module mocks, and explain exactly which leak causes it. Recommend a fix.',
    gold: {
      role: 'design',
      complexity: 'hard',
      needsLongContext: true,
      model: { tier: 'deep' },
    },
  },
  {
    id: 'design-migration-plan',
    tags: ['design'],
    description: 'Plan the settings schema migration',
    prompt:
      'Plan the migration of the settings schema from v1 to v2 with backward compatibility for existing ~/.openclaude/settings.json files: list the steps, the compatibility shims and how to roll back. Do not implement.',
    gold: {
      role: 'design',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: PLANNER,
      model: { tier: 'deep' },
    },
  },
  {
    id: 'design-tradeoffs',
    tags: ['design'],
    description: 'Compare in-process and pane teammates',
    prompt:
      'Compare running teammates in-process versus in tmux panes for the supervisor. Weigh isolation, observability and failure recovery, and recommend one approach with the trade-offs spelled out.',
    gold: {
      role: 'design',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: PLANNER,
      model: { tier: 'deep' },
    },
  },
  {
    id: 'design-api-shape',
    tags: ['design'],
    description: 'Propose the SDK session fork API',
    prompt:
      'Propose the public API for forking a session in the SDK: function names, options, error cases and how it composes with resume. Give two alternatives and recommend one. Do not write code.',
    gold: {
      role: 'design',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: PLANNER,
      model: { tier: 'deep' },
    },
  },
  {
    id: 'design-subagent-plan',
    tags: ['design', 'subagent'],
    spawnPath: 'subagent',
    description: 'Plan the settings v2 migration',
    prompt:
      'Plan how to migrate settings.json from schema v1 to v2 without breaking existing files. List the steps and the risks. Read-only.',
    gold: {
      role: 'design',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: 'Plan',
      model: { tier: 'deep' },
    },
  },

  // ---- computer_use (needs vision) ---------------------------------------
  {
    id: 'cu-screenshot-login',
    tags: ['computer_use', 'trivial', 'vision'],
    description: 'Screenshot the login page after clicking Login',
    prompt:
      'Open http://localhost:3000 in the browser, click the Login button and take a screenshot of the page that appears.',
    gold: {
      role: 'computer_use',
      complexity: 'trivial',
      needsLongContext: false,
      agentType: BROWSER,
      model: { vision: true, tier: ['fast', 'standard'] },
    },
  },
  {
    id: 'cu-playwright-checkout',
    tags: ['computer_use', 'vision'],
    description: 'Walk through checkout with Playwright',
    prompt:
      'Use Playwright to walk through the checkout: add an item to the cart, apply the coupon SAVE10, pay with the test card 4242 4242 4242 4242 and take a screenshot at each step. Report anything that looks broken.',
    gold: {
      role: 'computer_use',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: BROWSER,
      model: { vision: true, tier: ['fast', 'standard'] },
    },
  },
  {
    id: 'cu-visual-diff',
    tags: ['computer_use', 'vision'],
    description: 'Compare screenshots of the providers page before and after the CSS change',
    prompt:
      'Drive the docs site in the browser: capture the providers page before and after the CSS change on branch fix/table-overflow, at 1280px and 375px widths, and describe any visual regression you can see.',
    gold: {
      role: 'computer_use',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: BROWSER,
      model: { vision: true, tier: ['fast', 'standard'] },
    },
  },
  {
    id: 'cu-desktop-toggle',
    tags: ['computer_use', 'trivial', 'vision'],
    description: 'Toggle dark mode in the desktop app',
    prompt: 'Use the desktop app: open Settings, switch on dark mode and take a screenshot of the result.',
    gold: {
      role: 'computer_use',
      complexity: 'trivial',
      needsLongContext: false,
      model: { vision: true },
    },
  },

  // ---- ambiguous: measured for stability and fallback, no gold ----------
  {
    id: 'ambiguous-terse-fix',
    tags: ['ambiguous', 'terse'],
    description: 'fix login',
    prompt: '',
  },
  {
    id: 'ambiguous-handle-payments',
    tags: ['ambiguous', 'terse'],
    description: 'Handle the payments module',
    prompt: 'Take care of the payments module.',
  },
  {
    id: 'ambiguous-look-into-and-fix',
    tags: ['ambiguous', 'mixed-role'],
    description: 'Look into why login fails on Windows and fix it',
    prompt: 'Users report the login flow hangs on Windows. Look into why and fix it.',
  },
]
