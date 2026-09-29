/**
 * Named scenario sets for the JEV benchmark. `seed` is the original general
 * set; the others are families, so one can be run on its own:
 *
 *   bun run bench:jev --set reverse-engineering --cyber
 *   bun run bench:jev --set computer-use,vision --live
 *   bun run bench:jev --set all
 */
import type { BenchScenario } from '../benchmark.js'
import { SEED_SCENARIOS } from '../benchmarkFixtures.js'
import { CODING_SCENARIOS } from './coding.js'
import { COMPUTER_USE_SCENARIOS } from './computerUse.js'
import { DATA_ANALYSIS_SCENARIOS } from './dataAnalysis.js'
import { DOCS_RESEARCH_SCENARIOS } from './docsResearch.js'
import { OPS_DEBUGGING_SCENARIOS } from './opsDebugging.js'
import { REVERSE_ENGINEERING_SCENARIOS } from './reverseEngineering.js'
import { SECURITY_SCENARIOS } from './security.js'
import { VISION_SCENARIOS } from './vision.js'

export const SCENARIO_SETS: Readonly<Record<string, readonly BenchScenario[]>> = {
  seed: SEED_SCENARIOS,
  'computer-use': COMPUTER_USE_SCENARIOS,
  coding: CODING_SCENARIOS,
  'reverse-engineering': REVERSE_ENGINEERING_SCENARIOS,
  security: SECURITY_SCENARIOS,
  'data-analysis': DATA_ANALYSIS_SCENARIOS,
  'ops-debugging': OPS_DEBUGGING_SCENARIOS,
  'docs-research': DOCS_RESEARCH_SCENARIOS,
  vision: VISION_SCENARIOS,
}

export const SCENARIO_SET_NAMES: readonly string[] = Object.keys(SCENARIO_SETS)

export const DEFAULT_SCENARIO_SET = 'seed'

/** Every scenario of every set, in set order. */
export function allScenarios(): BenchScenario[] {
  return Object.values(SCENARIO_SETS).flatMap(set => [...set])
}

/**
 * The scenarios of the named sets, in the order named, without repeats. `all`
 * stands for every set. Unknown names throw.
 */
export function resolveScenarioSets(names: readonly string[]): BenchScenario[] {
  const out: BenchScenario[] = []
  const seen = new Set<string>()
  for (const name of names) {
    const set = name === 'all' ? allScenarios() : SCENARIO_SETS[name]
    if (!set) {
      throw new Error(
        `unknown scenario set "${name}" (sets: ${[...SCENARIO_SET_NAMES, 'all'].join(', ')})`,
      )
    }
    for (const scenario of set) {
      if (seen.has(scenario.id)) continue
      seen.add(scenario.id)
      out.push(scenario)
    }
  }
  return out
}
