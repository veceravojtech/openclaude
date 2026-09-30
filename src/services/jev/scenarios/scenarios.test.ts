import { describe, expect, test } from 'bun:test'
import { CYBER_MODELS } from '../../../utils/model/cyber.js'
import { TEAMMATE_ROLES } from '../../api/smartRouting/teammate.js'
import {
  asList,
  buildTrainingExamples,
  evaluateModelGold,
  runBenchmark,
  validateScenarios,
  type BenchScenario,
} from '../benchmark.js'
import { buildBenchEnvironment, DEFAULT_BENCH_AGENT_TYPES } from '../benchmarkFixtures.js'
import { CYBER_EASY, CYBER_LEAD, CYBER_NOT_LEAD, CYBER_WORKER } from './cyberGold.js'
import {
  allScenarios,
  DEFAULT_SCENARIO_SET,
  resolveScenarioSets,
  SCENARIO_SET_NAMES,
  SCENARIO_SETS,
} from './index.js'

/** Each family set names its scenarios with one prefix; `seed` predates the convention. */
const PREFIXES: Record<string, string> = {
  'computer-use': 'cua-',
  coding: 'code-',
  'reverse-engineering': 're-',
  security: 'sec-',
  'data-analysis': 'data-',
  'ops-debugging': 'ops-',
  'docs-research': 'docs-',
  vision: 'vis-',
}

const KNOWN_AGENT_TYPES = new Set([...DEFAULT_BENCH_AGENT_TYPES.map(a => a.agentType), 'default'])

describe('scenario sets', () => {
  test('every set has scenarios and the default set exists', () => {
    expect(SCENARIO_SET_NAMES).toContain(DEFAULT_SCENARIO_SET)
    for (const name of SCENARIO_SET_NAMES) expect(SCENARIO_SETS[name]!.length).toBeGreaterThan(0)
    expect(Object.keys(PREFIXES).sort()).toEqual(SCENARIO_SET_NAMES.filter(n => n !== 'seed').sort())
  })

  test('ids are unique across every set and every scenario validates', () => {
    expect(() => validateScenarios(allScenarios())).not.toThrow()
  })

  test('a family set keeps to its id prefix', () => {
    for (const [name, prefix] of Object.entries(PREFIXES)) {
      const stray = SCENARIO_SETS[name]!.filter(s => !s.id.startsWith(prefix)).map(s => s.id)
      expect(stray).toEqual([])
    }
  })

  test('an empty prompt is only for scenarios that are meant to be terse', () => {
    const empty = allScenarios().filter(s => s.prompt.trim() === '' && !s.tags?.includes('terse'))
    expect(empty.map(s => s.id)).toEqual([])
  })

  test('every agent type a gold names is one the benchmark environment defines', () => {
    const unknown: string[] = []
    for (const s of allScenarios()) {
      for (const t of asList(s.gold?.agentType)) if (!KNOWN_AGENT_TYPES.has(t)) unknown.push(`${s.id}: ${t}`)
    }
    expect(unknown).toEqual([])
  })

  test('scenarios with an explicit agent type do not also carry an agent-type gold', () => {
    for (const s of allScenarios()) {
      if (s.subagentType) expect(s.gold?.agentType).toBeUndefined()
    }
  })

  test('resolveScenarioSets keeps the order named and never repeats a scenario', () => {
    const ids = (names: string[]) => resolveScenarioSets(names).map(s => s.id)
    expect(ids(['vision'])).toEqual(SCENARIO_SETS.vision!.map(s => s.id))
    expect(ids(['vision', 'seed'])).toEqual([...SCENARIO_SETS.vision!, ...SCENARIO_SETS.seed!].map(s => s.id))
    expect(ids(['vision', 'vision'])).toEqual(ids(['vision']))
    expect(ids(['vision', 'all']).slice(0, SCENARIO_SETS.vision!.length)).toEqual(ids(['vision']))
    expect(ids(['vision', 'all'])).toHaveLength(allScenarios().length)
    expect(ids(['all'])).toEqual(allScenarios().map(s => s.id))
  })

  test('an unknown set is an error that lists the known ones', () => {
    expect(() => resolveScenarioSets(['nope'])).toThrow(/unknown scenario set "nope".*computer-use.*all/)
  })
})

describe('labels agree with their tags', () => {
  const golds = allScenarios().filter(s => s.gold)

  test('a role tag is one of the gold roles', () => {
    const roles: readonly string[] = TEAMMATE_ROLES
    const off = golds.filter(s => {
      const tags = (s.tags ?? []).filter(t => roles.includes(t))
      const gold: string[] = asList(s.gold!.role)
      return tags.length > 0 && gold.length > 0 && !tags.some(t => gold.includes(t))
    })
    expect(off.map(s => s.id)).toEqual([])
  })

  test('hard and long-context tags match the complexity and long-context labels', () => {
    const off: string[] = []
    for (const s of golds) {
      const tags = s.tags ?? []
      const complexity = asList(s.gold!.complexity)
      if (tags.includes('hard') && !complexity.includes('hard')) off.push(`${s.id}: tagged hard`)
      if (!tags.includes('hard') && complexity.length > 0 && complexity.every(c => c === 'hard')) {
        off.push(`${s.id}: labelled hard, not tagged`)
      }
      if (tags.includes('long-context') !== (s.gold!.needsLongContext === true)) {
        off.push(`${s.id}: long-context tag and label disagree`)
      }
    }
    expect(off).toEqual([])
  })

  test('a trap has a role label, or it could not be scored', () => {
    const traps = allScenarios().filter(s => s.tags?.includes('trap'))
    expect(traps.length).toBeGreaterThan(0)
    expect(traps.filter(s => asList(s.gold?.role).length === 0).map(s => s.id)).toEqual([])
  })

  test('computer-use scenarios that are not traps ask for a vision model', () => {
    const cua = SCENARIO_SETS['computer-use']!.filter(s => s.gold?.role === 'computer_use')
    expect(cua.length).toBeGreaterThan(0)
    expect(cua.filter(s => s.gold?.model?.vision !== true).map(s => s.id)).toEqual([])
    const vision = SCENARIO_SETS.vision!
    expect(vision.filter(s => s.gold?.model?.vision !== true).map(s => s.id)).toEqual([])
  })
})

describe('prompts are safe to send to a third party', () => {
  // A live run sends this text to the gateway. Keep it synthetic: reserved
  // hosts only, and no addresses, e-mail or credential-shaped strings.
  const text = (s: BenchScenario) => [s.description, s.prompt, s.name ?? ''].join('\n')
  const reservedHost = (host: string) =>
    host === 'localhost' || host === 'example.com' || host.endsWith('.example.com') || host.endsWith('.test')

  test('URLs use reserved hosts', () => {
    const bad: string[] = []
    for (const s of allScenarios()) {
      for (const match of text(s).matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) {
        if (!reservedHost(match[1]!.toLowerCase())) bad.push(`${s.id}: ${match[0]}`)
      }
    }
    expect(bad).toEqual([])
  })

  test('no e-mail addresses, IPv4 addresses or credential-shaped tokens', () => {
    const patterns: Array<[string, RegExp]> = [
      ['e-mail', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/],
      ['IPv4', /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/],
      ['credential', /\b(?:sk-[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})/],
    ]
    const bad: string[] = []
    for (const s of allScenarios()) {
      for (const [label, pattern] of patterns) if (pattern.test(text(s))) bad.push(`${s.id}: ${label}`)
    }
    expect(bad).toEqual([])
  })
})

describe('golds stay satisfiable', () => {
  // A gold no candidate can satisfy would silently score every model wrong,
  // and an agent-type gold JEV is never offered could never be right.
  for (const [label, allowlist] of [['default allowlist', 'default'], ['wildcard allowlist', '*']] as const) {
    test(`every JEV gold of every set is reachable under the ${label}`, async () => {
      const scenarios = allScenarios()
      const results = await runBenchmark(scenarios, {
        mode: 'baseline',
        environment: buildBenchEnvironment({ allowlist }),
      })
      const examples = new Map(buildTrainingExamples(results).map(e => [e.id, e]))
      const unreachable: string[] = []
      for (const scenario of scenarios) {
        const gold = scenario.gold
        if (!gold) continue
        const example = examples.get(scenario.id)
        if (!example) {
          unreachable.push(`${scenario.id}: no example`)
          continue
        }
        if (gold.model && !example.gold.model) unreachable.push(`${scenario.id}: no acceptable model`)
        if (asList(gold.role).length > 0 && !example.gold.role) unreachable.push(`${scenario.id}: role not offered`)
        const wantedTypes = asList(gold.agentType)
        if (wantedTypes.length > 0 && !scenario.subagentType) {
          const kept = example.gold.agent_type?.choices ?? []
          const dropped = wantedTypes.filter(t => !kept.includes(t))
          if (dropped.length > 0) unreachable.push(`${scenario.id}: agent type not offered: ${dropped.join(',')}`)
        }
      }
      expect(unreachable).toEqual([])
    })
  }
})

describe('cyber labels', () => {
  const cyberScenarios = allScenarios().filter(s => s.gold?.cyberModel)
  const policyModels: string[] = [CYBER_MODELS.lead, CYBER_MODELS.worker, CYBER_MODELS.easy]

  test('the reverse-engineering and security sets carry them wherever a model is labelled', () => {
    for (const name of ['reverse-engineering', 'security']) {
      const missing = SCENARIO_SETS[name]!.filter(s => s.gold?.model && !s.gold.cyberModel)
      expect(missing.map(s => s.id)).toEqual([])
    }
    expect(cyberScenarios.length).toBeGreaterThan(0)
  })

  test('a label only names models the cyber policy can choose', () => {
    const bad = cyberScenarios.filter(s => {
      const gold = s.gold!.cyberModel!
      return !gold.anyOf || gold.anyOf.length === 0 || gold.anyOf.some(id => !policyModels.includes(id))
    })
    expect(bad.map(s => s.id)).toEqual([])
  })

  test('labels follow the documented policy table', () => {
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
    const wrong: string[] = []
    for (const s of cyberScenarios) {
      const roles = asList(s.gold!.role)
      const complexity = asList(s.gold!.complexity)
      const separated = roles.length > 0 && roles.every(r => r === 'review' || r === 'verify')
      const design = roles.length > 0 && roles.every(r => r === 'design')
      const hard = complexity.length > 0 && complexity.every(c => c === 'hard')
      const allowed = separated ? [CYBER_LEAD, CYBER_NOT_LEAD] : hard || design ? [CYBER_WORKER] : [CYBER_EASY]
      if (!allowed.some(g => same(g, s.gold!.cyberModel))) wrong.push(s.id)
    }
    expect(wrong).toEqual([])
  })

  test('a label is reachable in a cyber environment', async () => {
    const results = await runBenchmark(cyberScenarios, {
      mode: 'baseline',
      environment: buildBenchEnvironment({ cyber: true }),
    })
    const unreachable = cyberScenarios.filter(s => {
      const candidates = results.candidates[s.id] ?? []
      return !candidates.some(c => evaluateModelGold(s.gold!.cyberModel, c, results.config.tierFamilies))
    })
    expect(unreachable.map(s => s.id)).toEqual([])
  })
})
