/**
 * Plain-text report for a JEV benchmark. Formatting only: every number comes
 * from `summarize` in benchmarkAnalysis.ts.
 */
import type { BenchResults } from './benchmark.js'
import type {
  BenchSummary,
  QuestionSummary,
  Rate,
  ScenarioRow,
  SweepCell,
} from './benchmarkAnalysis.js'

const NA = 'n/a'

function pct(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined ? NA : `${(value * 100).toFixed(digits)}%`
}

function ratio(r: Rate): string {
  return r.rate === null ? NA : `${pct(r.rate)} (${r.n}/${r.d})`
}

function fixed(value: number | null | undefined, digits = 3): string {
  return value === null || value === undefined ? NA : value.toFixed(digits)
}

function ms(value: number | null | undefined): string {
  return value === null || value === undefined || Number.isNaN(value) ? NA : `${Math.round(value)} ms`
}

function usd(value: number | null | undefined, digits = 5): string {
  return value === null || value === undefined ? NA : `$${value.toFixed(digits)}`
}

function table(rows: ReadonlyArray<readonly string[]>): string {
  if (rows.length === 0) return ''
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map(r => (r[c] ?? '').length)))
  return rows
    .map(r =>
      r
        .map((cell, c) => (c === r.length - 1 ? cell : cell.padEnd(widths[c]!)))
        .join('  ')
        .trimEnd(),
    )
    .join('\n')
}

function counts(map: Record<string, number>): string {
  return (
    Object.entries(map)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([k, n]) => `${k} ×${n}`)
      .join(' · ') || '-'
  )
}

function section(title: string): string {
  return `\n== ${title} ==`
}

function questionRow(name: string, q: QuestionSummary): string[] {
  return [
    name,
    String(q.asked),
    ratio(q.accepted),
    q.gold === 0 ? NA : `${ratio(q.top1)}`,
    ratio(q.precisionWhenAccepted),
    fixed(q.calibration?.brier),
    fixed(q.calibration?.ece),
  ]
}

function sweepTable(
  name: string,
  cells: readonly SweepCell[],
  configured: { minP: number; minMargin: number },
): string {
  const margins = [...new Set(cells.map(c => c.minMargin))].sort((a, b) => a - b)
  const minPs = [...new Set(cells.map(c => c.minP))].sort((a, b) => a - b)
  const header = ['minP \\ margin', ...margins.map(m => m.toFixed(2))]
  const rows = minPs.map(minP => [
    minP.toFixed(2),
    ...margins.map(minMargin => {
      const cell = cells.find(c => c.minP === minP && c.minMargin === minMargin)
      if (!cell) return NA
      const text = `${pct(cell.coverage, 0)}/${pct(cell.precision, 0)}`
      return minP === configured.minP && minMargin === configured.minMargin ? `${text} *` : text
    }),
  ])
  return `${name}\n${table([header, ...rows])}`
}

function rowsTable(rows: readonly ScenarioRow[], live: boolean): string {
  const header = ['scenario', 'gold', 'role (share, p)', 'model (share, p)', 'type', 'latency', 'flags']
  const share = (s: { value: string; share: number; meanP: number | null; ok?: boolean }) =>
    `${s.value}${s.ok === false ? ' ✗' : ''} (${s.share.toFixed(2)}${s.meanP === null ? '' : `, ${s.meanP.toFixed(2)}`})`
  return table([
    header,
    ...rows.map(r => [
      r.id,
      r.goldRole ?? '-',
      share(r.role),
      share(r.model),
      // Only JEV picks an agent type; a baseline run has none to show.
      live ? `${r.agentType.value}${r.agentType.ok === false ? ' ✗' : ''}` : '-',
      r.latencyMs === null ? '-' : ms(r.latencyMs),
      r.flags.join(',') || '-',
    ]),
  ])
}

export function formatReport(
  summary: BenchSummary,
  results: BenchResults,
  options: { verbose?: boolean } = {},
): string {
  const { config } = results
  const out: string[] = []
  const repeat = config.repeat > 1 ? ` (×${config.repeat})` : ''
  out.push(
    `JEV decision benchmark — ${summary.mode} · ${summary.scenarios} scenarios · ${summary.runs} runs${repeat}${summary.aborted ? ' · ABORTED, partial results' : ''}`,
  )
  out.push(
    summary.mode === 'live'
      ? `  ${config.jevModel} via ${config.endpoint} · Rule A minP=${summary.thresholds.minP} minMargin=${summary.thresholds.minMargin} · timeout ${config.timeoutMs} ms${config.zeroDataRetention ? ' · zero data retention' : ''}`
      : config.cyber
        ? `  cyber mode: JEV is never consulted; keyword role and complexity go onto a fixed model policy${
            config.cyberModels
              ? ` (${config.cyberModels.lead} review/verify · ${config.cyberModels.easy} easy · ${config.cyberModels.worker} hard)`
              : ''
          }`
        : '  JEV was not called: role from the keyword heuristic, model from the tier table',
  )
  out.push(
    `  leader route ${config.leaderRoute} · profiles ${config.profiles.join(', ') || '(none)'} · allowlist ${config.allowlist.length > 0 ? config.allowlist.join(',') : '(default: matrix families)'}`,
  )
  if (summary.candidates) {
    const c = summary.candidates
    out.push(`  models offered per call: min ${c.min} / median ${c.median} / max ${c.max}`)
  }

  if (summary.jev) {
    const j = summary.jev
    const failed = j.calls - j.ok
    out.push(section('JEV calls'))
    out.push(
      `calls ${j.calls} · ok ${j.ok}${j.calls > 0 ? ` (${pct(j.ok / j.calls)})` : ''} · failed ${failed}${failed > 0 ? ` [${counts(j.failures)}]` : ''}`,
    )
    if (j.latency) {
      out.push(
        `latency mean ${ms(j.latency.meanMs)} · p50 ${ms(j.latency.p50Ms)} · p95 ${ms(j.latency.p95Ms)} · max ${ms(j.latency.maxMs)}`,
      )
    }
    out.push(
      `cost ${usd(j.costUsd)} total · ${usd(j.costPerCallUsd)}/call · tokens in ${j.inputTokens.toLocaleString('en-US')} / out ${j.outputTokens.toLocaleString('en-US')}`,
    )

    out.push(section('What JEV answers (raw picks) and what Rule A accepts'))
    out.push(
      table([
        ['question', 'asked', 'Rule A accepts', 'top-1 vs gold', 'precision|accepted', 'Brier', 'ECE'],
        questionRow('role', summary.role),
        questionRow('model', summary.model),
        questionRow('agent_type', summary.agentType),
      ]),
    )
    const o = summary.model.outcomes
    out.push(
      `model outcomes: accepted ${o.accepted} · corrected by rules ${o.corrected} · unconfident→tier ${o.unconfident} · rejected-by-rules→tier ${o['rejected-by-rules']} · jev failed→tier ${o['jev-failed']} · no answer ${o['no-answer']}`,
    )
    out.push(
      `complexity: exact ${ratio(summary.complexity.exact)} · mean abs error ${fixed(summary.complexity.meanAbsError, 2)} on the 0–2 scale`,
    )
    out.push(
      `needs_long_context: accuracy ${ratio(summary.longContext.accuracy)} · Brier ${fixed(summary.longContext.brier)}`,
    )
    const misses = Object.entries(summary.role.confusion).flatMap(([gold, row]) =>
      Object.entries(row)
        .filter(([pred]) => pred !== gold)
        .map(([pred, n]) => `${gold}→${pred} ×${n}`),
    )
    if (misses.length > 0) out.push(`role confusion (gold→JEV): ${misses.join(' · ')}`)
  }

  out.push(
    section(
      summary.mode === 'live'
        ? 'Final decisions vs gold'
        : config.cyber
          ? 'Cyber-policy decisions vs gold (keyword role + fixed model policy)'
          : 'Baseline decisions vs gold (heuristic + tier table)',
    ),
  )
  out.push(`final role correct    ${ratio(summary.role.finalAccuracy)}`)
  out.push(`final model ok        ${ratio(summary.model.finalOk)}`)
  if (summary.mode === 'live') out.push(`final agent type ok   ${ratio(summary.agentType.finalAccuracy)}`)

  if (summary.errors.length > 0) {
    out.push(section(`Runs that raised instead of deciding (${summary.errors.length})`))
    for (const e of summary.errors.slice(0, 8)) {
      out.push(`${e.id}: ${e.message.length > 150 ? `${e.message.slice(0, 150)}…` : e.message}`)
    }
    if (summary.errors.length > 8) out.push(`… and ${summary.errors.length - 8} more`)
  }

  out.push(section('What gets chosen (final decisions)'))
  for (const role of Object.keys(summary.choices.byRole).sort()) {
    const models = summary.choices.byRole[role]!
    const n = Object.values(models).reduce((a, b) => a + b, 0)
    out.push(`${role.padEnd(13)} n=${String(n).padEnd(4)} ${counts(models)}`)
  }
  const order = ['trivial', 'moderate', 'hard', '?']
  out.push('by complexity:')
  for (const level of order.filter(l => summary.choices.byComplexity[l])) {
    out.push(`  ${level.padEnd(9)} ${counts(summary.choices.byComplexity[level]!)}`)
  }
  if (summary.mode === 'live' && Object.keys(summary.choices.agentTypes).length > 0) {
    out.push(`agent types: ${counts(summary.choices.agentTypes)}`)
  }

  if (summary.stability) {
    const s = summary.stability
    out.push(section(`Stability across repeats (${s.scenarios} scenarios)`))
    out.push(
      `same role ${fixed(s.roleShare, 2)} · same model ${fixed(s.modelShare, 2)} · same agent type ${fixed(s.agentTypeShare, 2)}   (1.00 = every repeat agreed)`,
    )
    for (const u of s.unstable.slice(0, 8)) out.push(`  unstable: ${u.id}  ${counts(u.models)}`)
    if (s.unstable.length > 8) out.push(`  … and ${s.unstable.length - 8} more`)
  }

  if (summary.baseline) {
    const b = summary.baseline
    out.push(section('Agreement with the JEV-off baseline'))
    out.push(`role ${ratio(b.role)} · model ${ratio(b.model)} · family ${ratio(b.family)}`)
  }

  if (summary.jev) {
    out.push(section('Rule A threshold sweep (coverage/precision %, from the recorded probabilities; * = configured)'))
    out.push(
      [
        sweepTable('role', summary.role.sweep, summary.thresholds),
        sweepTable('model', summary.model.sweep, summary.thresholds),
        sweepTable('agent_type', summary.agentType.sweep, summary.thresholds),
      ].join('\n\n'),
    )
    out.push('coverage = share of answers Rule A accepts; precision = share of accepted picks that match gold.')
  }

  if (options.verbose) {
    out.push(section('Per scenario'))
    out.push(rowsTable(summary.rows, summary.mode === 'live'))
  }
  return out.join('\n') + '\n'
}
