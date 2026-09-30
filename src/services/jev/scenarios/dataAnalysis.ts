/**
 * Data-analysis scenarios: statistics over files, logs and query results, and a
 * couple of design and scripting tasks around data.
 *
 * Analysis that reports numbers without changing the repository is `research`
 * to the dispatcher; producing a script or a file is `implement`.
 *
 * Labels are starter labels. Review them before using them for training.
 */
import type { BenchScenario } from '../benchmark.js'

const ANALYST = 'data-analyst'

export const DATA_ANALYSIS_SCENARIOS: readonly BenchScenario[] = [
  {
    id: 'data-latency-percentiles',
    tags: ['research', 'data'],
    description: 'Compute p50, p95 and p99 latency per endpoint',
    prompt:
      'From logs/access-2024-06.csv (4.2M rows) compute p50, p95 and p99 latency per endpoint and list the five slowest. Show the numbers in a table.',
    gold: {
      role: 'research',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: ANALYST,
      model: { tier: 'standard' },
    },
  },
  {
    id: 'data-anomaly-orders',
    tags: ['research', 'data'],
    description: 'Find anomalies in the daily order counts',
    prompt:
      'Look at data/orders_daily.csv for the last 18 months and find the days that are outliers. For each one give a short explanation (holiday, outage, promotion) if data/events.csv lets you tell.',
    gold: {
      role: 'research',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: ANALYST,
      model: { tier: 'standard' },
    },
  },
  {
    id: 'data-churn-after-price-change',
    tags: ['research', 'data', 'sql'],
    description: 'Which customers churned after the price change?',
    prompt:
      'Using the read-only analytics database, find the customers who cancelled within 30 days of the 2024-03 price change, split by plan, and estimate the churn rate against the previous quarter.',
    gold: {
      role: 'research',
      complexity: ['moderate', 'hard'],
      needsLongContext: false,
      agentType: ANALYST,
      model: { tier: ['standard', 'deep'] },
    },
  },
  {
    id: 'data-ab-test-significance',
    tags: ['research', 'data'],
    description: 'Was the A/B test significant?',
    prompt:
      'Given data/ab_test.csv (variant, converted), compute the conversion rate per variant, the confidence interval of the difference and whether it is significant at 5 percent. State your assumptions.',
    gold: {
      role: 'research',
      complexity: ['trivial', 'moderate'],
      needsLongContext: false,
      agentType: ANALYST,
      model: { tier: ['fast', 'standard'] },
    },
  },
  {
    id: 'data-outage-log-forensics',
    tags: ['research', 'data', 'hard', 'long-context'],
    description: 'Reconstruct what happened during the outage from the logs',
    prompt:
      'Between 02:10 and 02:40 UTC on 12 June the API returned 5xx. From logs/ (app, nginx and database, about 3 GB) reconstruct the timeline and the most likely root cause.',
    gold: {
      role: ['research', 'design'],
      complexity: 'hard',
      needsLongContext: true,
      agentType: [ANALYST, 'default'],
      model: { tier: ['standard', 'deep'], minContext: 200_000 },
    },
  },
  {
    id: 'data-plot-signups',
    tags: ['implement', 'data'],
    description: 'Plot weekly signups by channel',
    prompt:
      'Make a stacked bar chart of weekly signups by acquisition channel from data/signups.csv and save it as reports/signups.png.',
    gold: {
      role: ['implement', 'research'],
      complexity: 'trivial',
      needsLongContext: false,
      agentType: [ANALYST, 'dev'],
      model: { tier: ['fast', 'standard'] },
    },
  },
  {
    id: 'data-dedupe-customers',
    tags: ['implement', 'data'],
    description: 'Deduplicate the customer CSV',
    prompt:
      'data/customers.csv has near-duplicate rows (same person, different capitalisation or typos). Write a script that merges them conservatively, writes data/customers_clean.csv and logs every merge decision.',
    gold: {
      role: 'implement',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: 'dev',
      model: { tier: 'standard' },
    },
  },
  {
    id: 'data-design-audit-log-schema',
    tags: ['design', 'data'],
    description: 'Design the schema for the audit log',
    prompt:
      'Design the database schema for an audit log: who, what, when, before and after values, seven-year retention, queryable by entity. Compare a single table with partitioned tables and recommend one.',
    gold: {
      role: 'design',
      complexity: 'moderate',
      needsLongContext: false,
      agentType: ['planner', 'default'],
      model: { tier: 'deep' },
    },
  },
]
