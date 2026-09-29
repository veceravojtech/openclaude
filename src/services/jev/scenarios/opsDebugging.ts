/**
 * Operations and debugging scenarios: build and deployment configuration,
 * incident work, profiling and reproducing bugs.
 *
 * Two of these are traps (tag `trap`): "reproduce the bug" and "run a load
 * test" are verification work. The first has no verification keyword at all;
 * the second only has the word "test".
 *
 * Labels are starter labels. Review them before using them for training.
 */
import type { BenchScenario } from '../benchmark.js'

const DEVOPS = 'devops'

export const OPS_DEBUGGING_SCENARIOS: readonly BenchScenario[] = [
  {
    id: 'ops-shrink-docker-image',
    tags: ['implement', 'ops'],
    description: 'Shrink the Docker image',
    prompt:
      'The API image is 1.9 GB. Rewrite the Dockerfile with a multi-stage build and a slim base, keep the same entrypoint, and report the new size.',
    gold: {
      role: 'implement',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: [DEVOPS, 'dev'],
      model: { tier: 'standard' },
    },
  },
  {
    id: 'ops-cron-to-systemd',
    tags: ['implement', 'ops'],
    description: 'Migrate the cron jobs to systemd timers',
    prompt:
      'Convert the five cron entries in ops/crontab to systemd timers and services with the same schedules, add logging and failure notifications, and document the rollout.',
    gold: {
      role: 'implement',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: [DEVOPS, 'dev'],
      model: { tier: 'standard' },
    },
  },
  {
    id: 'ops-main-is-red',
    tags: ['research', 'ops', 'ci'],
    description: 'Why is main red?',
    prompt:
      "The main branch CI has been red since yesterday's merge. Find the commit that broke it, explain the failure and propose a fix, but do not push anything.",
    gold: {
      role: ['research', 'design'],
      complexity: 'moderate',
      needsLongContext: false,
      agentType: ['explorer', 'default'],
      model: { tier: ['standard', 'deep'] },
    },
  },
  {
    id: 'ops-review-k8s-manifests',
    tags: ['review', 'ops'],
    description: 'Review the Kubernetes manifests for the payments service',
    prompt:
      'Review k8s/ for the new payments service: resource limits, probes, security context, secret handling and rollout strategy. List the problems by severity.',
    gold: {
      role: 'review',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: ['code-reviewer', DEVOPS, 'security-auditor'],
      model: { tier: 'deep' },
    },
  },
  {
    id: 'ops-review-terraform-plan',
    tags: ['review', 'ops'],
    description: 'Review the Terraform plan before we apply it',
    prompt:
      'Review the terraform plan output in plan.txt before we apply it: flag destructive changes, anything that recreates a stateful resource, and IAM changes that widen access.',
    gold: {
      role: 'review',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: ['code-reviewer', DEVOPS, 'security-auditor'],
      model: { tier: 'deep' },
    },
  },
  {
    id: 'ops-memory-leak-root-cause',
    tags: ['design', 'ops', 'hard'],
    description: 'Track down the memory leak in the Node worker',
    prompt:
      "The Node worker's memory grows about 40 MB an hour and never drops. Take heap snapshots, find what is retained and identify the leaking code path. Report it with the evidence.",
    gold: {
      role: 'design',
      complexity: 'hard',
      needsLongContext: false,
      agentType: ['default', 'planner'],
      model: { tier: 'deep' },
    },
  },
  {
    id: 'ops-trap-reproduce-bug-report',
    tags: ['trap', 'verify', 'ops'],
    description: "Reproduce the bug from the user's report",
    prompt:
      'A user reports that exporting a report with more than 10k rows returns an empty file. Reproduce it locally, give the exact steps, and say whether it also happens on main.',
    gold: {
      role: 'verify',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: 'verifier',
      model: { tier: 'standard' },
    },
  },
  {
    id: 'ops-trap-load-test-staging',
    tags: ['trap', 'verify', 'ops'],
    description: 'Run a load test against staging',
    prompt:
      'Run a 10-minute load test (k6, 200 virtual users, ramping up over 2 minutes) against staging /api/search and report throughput, p95 latency and the error rate.',
    gold: {
      role: 'verify',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: ['verifier', DEVOPS],
      model: { tier: 'standard' },
    },
  },
  {
    id: 'ops-draft-postmortem',
    tags: ['implement', 'ops', 'writing'],
    description: "Draft the postmortem for last night's outage",
    prompt:
      'Draft a blameless postmortem for the 02:10 to 02:40 outage using the timeline in incident/2024-06-12.md: summary, impact, root cause, what went well, and action items with owners.',
    gold: {
      role: ['implement', 'research'],
      complexity: 'moderate',
      needsLongContext: false,
      agentType: ['tech-writer', 'dev'],
      model: { tier: 'standard' },
    },
  },
]
