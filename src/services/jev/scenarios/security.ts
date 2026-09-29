/**
 * Defensive-security scenarios: reviewing our own code and configuration,
 * triaging findings, threat modelling and writing detections. Everything here
 * targets our own systems.
 *
 * Security work is what cyber mode is for, so every scenario also carries a
 * `cyberModel` label: where the documented cyber policy should send it (see
 * reverseEngineering.ts). Run them with `--set security --cyber`.
 *
 * Labels are starter labels. Review them before using them for training.
 */
import type { BenchScenario } from '../benchmark.js'
import { CYBER_EASY, CYBER_LEAD, CYBER_WORKER } from './cyberGold.js'

const AUDITOR = 'security-auditor'

export const SECURITY_SCENARIOS: readonly BenchScenario[] = [
  {
    id: 'sec-review-session-cookies',
    tags: ['review', 'security', 'separation'],
    implementers: ['claude-sonnet-5-5'],
    description: 'Security review of the session cookie changes',
    prompt:
      'Security-review the diff on branch feat/sessions: cookie flags, session fixation, CSRF, token entropy and logout invalidation. Report the findings by severity; do not edit.',
    gold: {
      role: 'review',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: [AUDITOR, 'code-reviewer'],
      model: { tier: 'deep' },
      cyberModel: CYBER_LEAD,
    },
  },
  {
    id: 'sec-triage-npm-audit',
    tags: ['research', 'security'],
    description: 'Triage the npm audit findings',
    prompt:
      'npm audit reports 14 advisories. For each one decide whether our code actually reaches the vulnerable function, and produce a keep, upgrade or ignore table with the reason. Do not change package.json.',
    gold: {
      role: 'research',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: [AUDITOR, 'explorer'],
      model: { tier: 'standard' },
      cyberModel: CYBER_EASY,
    },
  },
  {
    id: 'sec-threat-model-upload',
    tags: ['design', 'security'],
    description: 'Threat-model the new file upload service',
    prompt:
      'Produce a STRIDE threat model for the upload service (browser to API to object storage to virus scanner). List the top risks with mitigations and say what we should test first.',
    gold: {
      role: 'design',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: ['planner', AUDITOR],
      model: { tier: 'deep' },
      cyberModel: CYBER_WORKER,
    },
  },
  {
    id: 'sec-fix-sql-injection',
    tags: ['implement', 'security'],
    description: 'Fix the SQL injection in the search endpoint',
    prompt:
      'The /search handler builds its SQL by string concatenation. Switch it to parameterised queries, add a test that would have caught the injection, and check for the same pattern elsewhere in src/db.',
    gold: {
      role: 'implement',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: 'dev',
      model: { tier: 'standard' },
      cyberModel: CYBER_EASY,
    },
  },
  {
    id: 'sec-secret-history-scan',
    tags: ['research', 'security'],
    description: 'Scan the repository history for leaked secrets',
    prompt:
      'Scan the full git history for committed secrets (keys, tokens, .env files). List what you find with the commit ids and say which ones need rotating. Never print secret values.',
    gold: {
      role: 'research',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: [AUDITOR, 'explorer'],
      model: { tier: 'standard' },
      cyberModel: CYBER_EASY,
    },
  },
  {
    id: 'sec-write-semgrep-rule',
    tags: ['implement', 'security'],
    description: 'Write a Semgrep rule for unsafe deserialization',
    prompt:
      'Write a Semgrep rule that flags pickle.loads and yaml.load on untrusted input in our Python services, with test cases for positive and negative matches.',
    gold: {
      role: 'implement',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: 'dev',
      model: { tier: 'standard' },
      cyberModel: CYBER_EASY,
    },
  },
  {
    id: 'sec-audit-csp-headers',
    tags: ['review', 'security'],
    description: 'Audit the Content-Security-Policy',
    prompt:
      'Audit the CSP headers our app sends (see nginx/security.conf): find directives that are too permissive, list the scripts and styles that would break under a strict policy, and propose a stricter one.',
    gold: {
      role: 'review',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: AUDITOR,
      model: { tier: 'deep' },
      cyberModel: CYBER_LEAD,
    },
  },
  {
    id: 'sec-verify-xss-fix',
    tags: ['verify', 'security', 'separation'],
    implementers: ['claude-opus-5-5'],
    description: 'Verify the stored XSS fix holds',
    prompt:
      'Verify the fix for the stored XSS in comments: try 20 payload variants (encoded, nested, SVG, event handlers) against a local instance of our own app and report whether any of them executes.',
    gold: {
      role: 'verify',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: ['verifier', AUDITOR],
      model: { tier: 'standard' },
      cyberModel: CYBER_LEAD,
    },
  },
]
