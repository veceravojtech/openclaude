import { PassThrough } from 'node:stream'
import { afterAll, describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import figures from 'figures'
import React from 'react'

import { createRoot } from '../../ink.js'
import { stringWidth } from '../../ink/stringWidth.js'
import {
  type AppState,
  AppStateProvider,
  getDefaultAppState,
  useSetAppState,
} from '../../state/AppState.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import { renderToAnsiString, renderToString } from '../../utils/staticRender.js'
import { TeammateSpinnerTree } from './TeammateSpinnerTree.js'

/**
 * The spinner tree is where the team tree becomes visible: rows come in the
 * shared depth-first order (getRunningTeammatesSorted) and a sub-team member is
 * indented under the teammate that leads it, one level per step down the tree.
 * Asserted on rendered text — TeammateSpinnerTree is hand-maintained
 * react-compiler output, so a wrong cache slot would silently serve a stale
 * node that only the frame can catch.
 */

// The dim checks below read SGR codes; pin chalk to truecolor so they are
// emitted even though test stdout is not a TTY (precedent: WordmarkRow.test).
const originalChalkLevel = chalk.level
chalk.level = 3
afterAll(() => {
  chalk.level = originalChalkLevel
})

const COLUMNS = 120
/** The narrow terminal the width budget has to survive at every depth. */
const NARROW_COLUMNS = 80

function teammate(
  name: string,
  teamName: string,
  overrides: Partial<InProcessTeammateTaskState> = {},
): InProcessTeammateTaskState {
  return {
    id: `task-${teamName}-${name}`,
    type: 'in_process_teammate',
    status: 'running',
    description: `${name}: working`,
    startTime: 1_700_000_000_000,
    outputFile: `/tmp/${name}.log`,
    outputOffset: 0,
    notified: false,
    identity: {
      agentId: `${name}@${teamName}`,
      agentName: name,
      teamName,
      planModeRequired: false,
      parentSessionId: 'session-1',
    },
    prompt: `prompt of ${name}`,
    spinnerVerb: 'Working',
    pastTenseVerb: 'Worked',
    awaitingPlanApproval: false,
    permissionMode: 'default',
    pendingUserMessages: [],
    isIdle: false,
    shutdownRequested: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    ...overrides,
  }
}

/**
 * The shared two-level fixture: root team `email` with alice, supervisor and
 * zoe, plus supervisor's sub-team `email/supervisor` with worker-1 and
 * worker-2. Fed in shuffled so the rendered order can only come from the
 * component's own ordering.
 */
const TWO_LEVEL = [
  teammate('zoe', 'email'),
  teammate('worker-2', 'email/supervisor'),
  teammate('alice', 'email'),
  teammate('worker-1', 'email/supervisor'),
  teammate('supervisor', 'email'),
]

/**
 * The same teammate with `agentId` and `teamName` stripped off its identity.
 * `TeammateIdentity` types both as `string` and every spawn path sets them, so
 * the cast is a deliberate type violation — it is the shape a hand-built or
 * stale AppState can still hold, and a row without one must be drawn at the
 * root indent instead of throwing the whole spinner tree out of the render.
 */
function withoutTeam(
  t: InProcessTeammateTaskState,
): InProcessTeammateTaskState {
  const identity = { ...t.identity } as Partial<
    InProcessTeammateTaskState['identity']
  >
  delete identity.teamName
  delete identity.agentId
  return { ...t, identity } as unknown as InProcessTeammateTaskState
}

function stateWith(teammates: InProcessTeammateTaskState[]): AppState {
  return {
    ...getDefaultAppState(),
    tasks: Object.fromEntries(teammates.map(t => [t.id, t])),
  }
}

async function renderTree(
  teammates: InProcessTeammateTaskState[],
  props: Record<string, unknown> = {},
  columns: number = COLUMNS,
): Promise<string> {
  return await renderToString(
    <AppStateProvider initialState={stateWith(teammates)}>
      <TeammateSpinnerTree {...props} />
    </AppStateProvider>,
    columns,
  )
}

/**
 * The same render with the ANSI codes left in, for the assertions that are about
 * how a row is styled rather than what it says. `\u001B[2m` is dim.
 */
async function renderTreeAnsi(
  teammates: InProcessTeammateTaskState[],
  props: Record<string, unknown> = {},
): Promise<string> {
  return await renderToAnsiString(
    <AppStateProvider initialState={stateWith(teammates)}>
      <TeammateSpinnerTree {...props} />
    </AppStateProvider>,
    COLUMNS,
  )
}

/**
 * A teammate inside its 30s grace window: terminal, with the retain/grace pair
 * the three terminal-marking sites write. The deadline is taken off the real
 * clock because the tree's own call to getRunningTeammatesSorted passes no `now`.
 */
function inGrace(
  t: InProcessTeammateTaskState,
  status: 'completed' | 'failed' | 'killed' = 'killed',
): InProcessTeammateTaskState {
  return {
    ...t,
    status,
    notified: true,
    retain: false,
    evictAfter: Date.now() + 30_000,
  }
}

/** The same teammate one millisecond past its grace deadline. */
function pastGrace(
  t: InProcessTeammateTaskState,
  status: 'completed' | 'failed' | 'killed' = 'killed',
): InProcessTeammateTaskState {
  return { ...inGrace(t, status), evictAfter: Date.now() - 1 }
}

/**
 * An activity description far longer than any row can show, so every row has to
 * truncate and therefore has to have budgeted its own width correctly.
 */
const LONG_ACTIVITY =
  'Reading src/components/Spinner/TeammateSpinnerLine.tsx and cross-checking the width budget against every nested row of the tree'

/** The same teammate, now reporting a long activity plus stats. */
function busy(t: InProcessTeammateTaskState): InProcessTeammateTaskState {
  return {
    ...t,
    progress: {
      toolUseCount: 3,
      tokenCount: 12_345,
      lastActivity: {
        toolName: 'Read',
        input: {},
        activityDescription: LONG_ACTIVITY,
      },
    },
  }
}

/** The same line with its ANSI codes removed. */
function stripped(line: string): string {
  return line.replace(/\u001B\[[0-9;]*m/g, '')
}

/**
 * The text of every dimmed run on a line.
 *
 * `dimColor` resolves to theme.inactive — rgb(153,153,153) — in ThemedText
 * (design-system/ThemedText: dimColor wins over an explicit color), so a dimmed
 * run starts with that truecolor gray and ends at the next SGR escape of any
 * kind. Ending the run at ANY escape is what makes the reading precise: a live
 * row's `@name` carries its own agent colour, so it opens a new escape and falls
 * OUTSIDE the dim run, while a finished row's name stays inside it. Reading runs
 * rather than matching one escape lets a case say WHICH text is dimmed.
 */
const DIM_GRAY = '\u001B[38;2;153;153;153m'

function dimSpans(line: string): string[] {
  const spans: string[] = []
  const pattern = /\u001B\[38;2;153;153;153m((?:(?!\u001B\[)[\s\S])*)/g
  let match = pattern.exec(line)
  while (match !== null) {
    spans.push(match[1] ?? '')
    match = pattern.exec(line)
  }
  return spans
}

/** One entry per teammate row: its @name and the column its tree char sits in. */
function teammateRows(frame: string): Array<{ name: string; indent: number }> {
  const rows: Array<{ name: string; indent: number }> = []
  for (const line of frame.split('\n')) {
    const match = /@([\w-]+)/.exec(line)
    if (!match?.[1]) continue
    rows.push({ name: match[1], indent: line.search(/\S/) })
  }
  return rows
}

describe('TeammateSpinnerTree', () => {
  test('lists the two-level fixture depth-first and indents the sub-team', async () => {
    const frame = await renderTree(TWO_LEVEL)
    const rows = teammateRows(frame)

    expect(rows.map(row => row.name)).toEqual([
      'alice',
      'supervisor',
      'worker-1',
      'worker-2',
      'zoe',
    ])

    // Root-team rows share one indent; the sub-team's rows sit exactly one
    // level (2 columns) further right, under their sub-lead.
    const root = rows.find(row => row.name === 'alice')!.indent
    expect(rows.find(row => row.name === 'supervisor')!.indent).toBe(root)
    expect(rows.find(row => row.name === 'zoe')!.indent).toBe(root)
    expect(rows.find(row => row.name === 'worker-1')!.indent).toBe(root + 2)
    expect(rows.find(row => row.name === 'worker-2')!.indent).toBe(root + 2)
  })

  test('still draws the leader row above the team', async () => {
    const frame = await renderTree(TWO_LEVEL)
    expect(frame).toContain('team-lead')
    expect(frame.indexOf('team-lead')).toBeLessThan(frame.indexOf('@alice'))
  })

  test('indents a third level one step further and returns to the sibling after it', async () => {
    const frame = await renderTree([
      ...TWO_LEVEL,
      teammate('deputy', 'email/supervisor/worker-1'),
    ])
    const rows = teammateRows(frame)

    expect(rows.map(row => row.name)).toEqual([
      'alice',
      'supervisor',
      'worker-1',
      'deputy',
      'worker-2',
      'zoe',
    ])
    const root = rows.find(row => row.name === 'alice')!.indent
    expect(rows.find(row => row.name === 'deputy')!.indent).toBe(root + 4)
    expect(rows.find(row => row.name === 'worker-2')!.indent).toBe(root + 2)
  })

  test('draws an orphaned sub-team member once, under a placeholder for its absent lead', async () => {
    // Its sub-lead `ghost` has no row at all. The member must still be there,
    // exactly once and indented as its team name says — and since this change it
    // nests under a `@ghost · not running` placeholder drawn at the LEAD's
    // position, instead of appearing to hang off the previous root sibling.
    const frame = await renderTree([...TWO_LEVEL, teammate('stray', 'email/ghost')])
    const rows = teammateRows(frame)

    expect(rows.map(row => row.name)).toEqual([
      'alice',
      'supervisor',
      'worker-1',
      'worker-2',
      'zoe',
      'ghost',
      'stray',
    ])
    expect(rows.filter(row => row.name === 'stray')).toHaveLength(1)
    expect(frame).toContain('@ghost · not running')
    const root = rows.find(row => row.name === 'alice')!.indent
    // The placeholder sits at the root indent (ghost is a member of `email`);
    // its sub-team's member sits one level in, under it.
    expect(rows.find(row => row.name === 'ghost')!.indent).toBe(root)
    expect(rows.find(row => row.name === 'stray')!.indent).toBe(root + 2)
  })

  test('marks the row the selection NAMES, wherever that row now sits', async () => {
    // The selection is a task id, not a position — the same value
    // useBackgroundTaskNavigation stores in AppState.selectedTeammate.
    const selection = {
      kind: 'teammate' as const,
      taskId: 'task-email/supervisor-worker-1',
    }
    const frame = await renderTree(TWO_LEVEL, {
      isInSelectionMode: true,
      selection,
    })
    expect(
      frame.split('\n').find(line => line.includes('enter to view')),
    ).toContain('@worker-1')

    // Insert a row above it: worker-1 moves from the third row to the fourth
    // and the highlight moves WITH it. A positional selection would have stayed
    // on the third row, which is now `supervisor`.
    const shifted = await renderTree(
      [...TWO_LEVEL, teammate('aaron', 'email')],
      { isInSelectionMode: true, selection },
    )
    const rows = teammateRows(shifted)
    expect(rows.map(row => row.name)).toEqual([
      'aaron',
      'alice',
      'supervisor',
      'worker-1',
      'worker-2',
      'zoe',
    ])
    expect(
      shifted.split('\n').find(line => line.includes('enter to view')),
    ).toContain('@worker-1')
  })

  test('marks the leader row and the hide row from the same selection value', async () => {
    // The leader row is already highlighted while the leader is foregrounded,
    // so what says SELECTED is the pointer glyph in its first column.
    const leaderLine = (frame: string): string =>
      frame.split('\n').find(line => line.includes('team-lead'))!

    const onLeader = await renderTree(TWO_LEVEL, {
      isInSelectionMode: true,
      selection: { kind: 'leader' },
    })
    expect(leaderLine(onLeader)).toContain(figures.pointer)

    const onTeammate = await renderTree(TWO_LEVEL, {
      isInSelectionMode: true,
      selection: { kind: 'teammate', taskId: 'task-email-alice' },
    })
    expect(leaderLine(onTeammate)).not.toContain(figures.pointer)
    expect(
      onTeammate.split('\n').find(line => line.includes('enter to view')),
    ).toContain('@alice')

    const onHide = await renderTree(TWO_LEVEL, {
      isInSelectionMode: true,
      selection: { kind: 'hide' },
    })
    expect(onHide.split('\n').find(line => line.includes('hide'))).toContain(
      'enter to collapse',
    )
    expect(leaderLine(onHide)).not.toContain(figures.pointer)
  })

  test('marks no row at all for a selection naming a teammate that is not listed', async () => {
    // The one frame between a row leaving and the survivor rule repairing the
    // selection: nothing is highlighted, and in particular the highlight is NOT
    // handed to whoever happens to sit at that position.
    const frame = await renderTree(TWO_LEVEL, {
      isInSelectionMode: true,
      selection: { kind: 'teammate', taskId: 'task-email-ghost' },
    })
    expect(frame).not.toContain('enter to view')
  })

  test('keeps every row inside a narrow terminal: the sub-team indent is spent from the row\'s own width budget', async () => {
    // The indent is real estate the row never gets back: at 80 columns a
    // depth-3 row that still budgets from the full width overruns the terminal
    // and yoga squeezes it — the pointer column collapses (the row starts at
    // root + 3 instead of root + 4) and the "…" truncation marker is lost.
    const frame = await renderTree(
      [...TWO_LEVEL, teammate('deputy', 'email/supervisor/worker-1')].map(busy),
      {},
      NARROW_COLUMNS,
    )
    const rows = teammateRows(frame)
    const rowLines = frame.split('\n').filter(line => /@[\w-]+/.test(line))

    expect(rows.map(row => row.name)).toEqual([
      'alice',
      'supervisor',
      'worker-1',
      'deputy',
      'worker-2',
      'zoe',
    ])

    // (a) the depth-3 row still gets its full two columns per level
    const root = rows.find(row => row.name === 'alice')!.indent
    expect(rows.find(row => row.name === 'worker-1')!.indent).toBe(root + 2)
    expect(rows.find(row => row.name === 'deputy')!.indent).toBe(root + 4)

    // (b) nothing overruns the terminal
    for (const line of rowLines) {
      expect(stringWidth(line)).toBeLessThanOrEqual(NARROW_COLUMNS)
    }

    // (c) nested rows end where the root rows end — one right margin for the
    // whole tree, which is exactly what a full-width budget cannot produce
    const rootRight = stringWidth(rowLines.find(line => line.includes('@alice'))!)
    for (const line of rowLines) {
      expect(stringWidth(line)).toBe(rootRight)
    }

    // (d) the truncated activity still says it was truncated
    for (const line of rowLines) {
      expect(line).toContain('…')
    }
  })

  test('draws a teammate whose identity has no team name at the root indent', async () => {
    // getTeamDepth is never asked about an absent team name: the row degrades
    // to a root-team row (`@nomad`, indent 0) and the tree still renders.
    const frame = await renderTree([
      ...TWO_LEVEL,
      withoutTeam(teammate('nomad', 'email')),
    ])
    const rows = teammateRows(frame)

    expect(rows.map(row => row.name)).toEqual([
      'nomad',
      'alice',
      'supervisor',
      'worker-1',
      'worker-2',
      'zoe',
    ])
    const root = rows.find(row => row.name === 'alice')!.indent
    expect(rows.find(row => row.name === 'nomad')!.indent).toBe(root)
    expect(rows.find(row => row.name === 'worker-1')!.indent).toBe(root + 2)
  })

  test('draws the team-lead row and one muted line when there is no teammate at all', async () => {
    // This used to render `null`, which is what made the tree disappear the
    // moment the last teammate ended. The panel is always on screen while the
    // toggle is on, so the zero-row case is a state with its own text.
    const frame = await renderTree([])
    expect(frame).toContain('team-lead')
    expect(frame).toContain('no teammates · Agent(name: "…") spawns one')
    expect(frame.indexOf('team-lead')).toBeLessThan(frame.indexOf('no teammates'))
    expect(teammateRows(frame)).toEqual([])
  })

  test('the empty state is one line, and it still offers the hide row in selection mode', async () => {
    const plain = await renderTree([])
    const lines = plain.split('\n').filter(line => line.trim() !== '')
    expect(lines).toHaveLength(2)

    const selecting = await renderTree([], { isInSelectionMode: true, selection: { kind: 'hide' } })
    expect(selecting).toContain('hide')
    expect(selecting).toContain('enter to collapse')
  })

  test('a row inside its grace window keeps its place and reads its terminal word', async () => {
    // `supervisor` was killed while its own sub-team is still working: the row
    // stays exactly where it was — between alice and its workers — so an index
    // that named it still names it, and it now reads `killed` instead of an
    // activity it is no longer doing.
    const withGrace = [
      ...TWO_LEVEL.filter(t => t.identity.agentName !== 'supervisor'),
      inGrace(teammate('supervisor', 'email')),
    ]
    const frame = await renderTree(withGrace)
    const rows = teammateRows(frame)

    expect(rows.map(row => row.name)).toEqual([
      'alice',
      'supervisor',
      'worker-1',
      'worker-2',
      'zoe',
    ])
    const line = frame.split('\n').find(l => l.includes('@supervisor'))!
    expect(line).toContain('killed')
    const root = rows.find(row => row.name === 'alice')!.indent
    expect(rows.find(row => row.name === 'supervisor')!.indent).toBe(root)
    expect(rows.find(row => row.name === 'worker-1')!.indent).toBe(root + 2)
  })

  test.each(['completed', 'failed', 'killed'] as const)(
    'a %s row is drawn dimmed, with the status word in place of the activity',
    async status => {
      const withGrace = [inGrace(teammate('supervisor', 'email'), status)]
      const ansi = await renderTreeAnsi(withGrace)
      const line = ansi.split('\n').find(l => l.includes('@supervisor'))!
      expect(line).toContain(DIM_GRAY)
      // The whole row — its @name and its status word together — is inside one
      // dim span, which is what "drawn dimmed" means for a finished teammate.
      expect(
        dimSpans(line).some(
          span => span.includes('@supervisor') && span.includes(status),
        ),
      ).toBe(true)
      expect(stripped(line)).toContain(status)
      // …and not the verb it would have shown while running.
      expect(stripped(line)).not.toContain('Working')
    },
  )

  test('a row past its grace deadline is gone, and the last one leaves the empty state', async () => {
    const frame = await renderTree([pastGrace(teammate('supervisor', 'email'))])
    expect(frame).not.toContain('@supervisor')
    expect(frame).toContain('no teammates · Agent(name: "…") spawns one')
  })

  test('a sub-team stays nested under its sub-lead while that lead is in grace, and moves to the placeholder after it', async () => {
    const lead = teammate('supervisor', 'email')
    const members = TWO_LEVEL.filter(
      t => t.identity.teamName === 'email/supervisor',
    )

    const during = teammateRows(await renderTree([inGrace(lead), ...members]))
    expect(during.map(row => row.name)).toEqual([
      'supervisor',
      'worker-1',
      'worker-2',
    ])
    const after = await renderTree([pastGrace(lead), ...members])
    const afterRows = teammateRows(after)
    expect(after).toContain('@supervisor · not running')
    // Same order, same nesting — only the lead's row changed from a real row to
    // the placeholder, so its members never jump under a sibling.
    expect(afterRows.map(row => row.name)).toEqual([
      'supervisor',
      'worker-1',
      'worker-2',
    ])
    const placeholderIndent = afterRows.find(row => row.name === 'supervisor')!.indent
    expect(afterRows.find(row => row.name === 'worker-1')!.indent).toBe(
      placeholderIndent + 2,
    )
  })

  test('one placeholder per absent lead, however many members it has', async () => {
    const frame = await renderTree([
      teammate('worker-1', 'email/ghost'),
      teammate('worker-2', 'email/ghost'),
    ])
    const matches = frame.match(/@ghost · not running/g) ?? []
    expect(matches).toHaveLength(1)
  })

  test('a chain of absent leads is drawn outermost first, each at its own depth', async () => {
    // Only the deepest member is left: both `ghost` (a member of `email`) and
    // `phantom` (a member of `email/ghost`) need a placeholder, in that order.
    const frame = await renderTree([teammate('stray', 'email/ghost/phantom')])
    const rows = teammateRows(frame)
    expect(rows.map(row => row.name)).toEqual(['ghost', 'phantom', 'stray'])
    expect(rows[0]!.indent + 2).toBe(rows[1]!.indent)
    expect(rows[1]!.indent + 2).toBe(rows[2]!.indent)
    expect(frame).toContain('@ghost · not running')
    expect(frame).toContain('@phantom · not running')
  })

  test('the placeholder is drawn dimmed, while a running row keeps its own colour', async () => {
    const ansi = await renderTreeAnsi([
      teammate('stray', 'email/ghost'),
      teammate('alice', 'email', { progress: { toolUseCount: 1, tokenCount: 2 } }),
    ])
    const placeholder = ansi.split('\n').find(l => l.includes('@ghost'))!
    expect(
      dimSpans(placeholder).some(span => span.includes('@ghost · not running')),
    ).toBe(true)
    // The contrast that makes the assertion above mean something: a live row's
    // name is NOT inside a dim span.
    const live = ansi.split('\n').find(l => l.includes('@alice'))!
    expect(dimSpans(live).some(span => span.includes('@alice'))).toBe(false)
  })

  test('no placeholder for a lead that does have a row', async () => {
    const frame = await renderTree(TWO_LEVEL)
    expect(frame).not.toContain('not running')
  })
})

/**
 * Row IDENTITY across a placeholder appearing above a row.
 *
 * A row's React key used to flip between `teammate.id` and `row-${teammate.id}`
 * — and its element type between the row itself and a Fragment — depending on
 * whether an absent-lead placeholder was emitted with it. So when a sub-lead's
 * grace window closed, or a missing lead respawned, React unmounted and
 * remounted every member row below: TeammateSpinnerLine re-ran its
 * `useState(() => teammate.spinnerVerb ?? sample(verbs))` initializer and its
 * idleStartRef / frozenDurationRef reset, so the verb changed and "Idle for 12s"
 * restarted at 0s under the cursor.
 *
 * The probe is that initializer. It reads the prop ONCE, at mount: feed the row
 * a different `spinnerVerb` along with the change and the old verb surviving on
 * screen is proof the row was not remounted — and the second case shows the same
 * probe catching a remount when the identity really does change, so a passing
 * first case cannot be an artefact of the probe.
 */
function verbed(
  t: InProcessTeammateTaskState,
  spinnerVerb: string,
): InProcessTeammateTaskState {
  return { ...t, spinnerVerb }
}

function Driver({
  onReady,
}: {
  onReady: (
    setTeammates: (teammates: InProcessTeammateTaskState[]) => void,
  ) => void
}): null {
  const setAppState = useSetAppState()
  React.useEffect(
    () =>
      onReady(teammates =>
        setAppState(prev => ({
          ...prev,
          tasks: Object.fromEntries(teammates.map(t => [t.id, t])),
        })),
      ),
    [setAppState, onReady],
  )
  return null
}

async function mountTree(teammates: InProcessTeammateTaskState[]): Promise<{
  setTeammates: (next: InProcessTeammateTaskState[]) => Promise<string>
  cleanup: () => Promise<void>
}> {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = COLUMNS
  let written = ''
  stdout.on('data', chunk => {
    written += String(chunk)
  })
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  let setTeammates:
    | ((next: InProcessTeammateTaskState[]) => void)
    | undefined
  const teardown = async (): Promise<void> => {
    root.unmount()
    await Bun.sleep(30)
    stdin.end()
    stdout.end()
  }
  try {
    root.render(
      <AppStateProvider initialState={stateWith(teammates)}>
        <TeammateSpinnerTree />
        <Driver
          onReady={value => {
            setTeammates = value
          }}
        />
      </AppStateProvider>,
    )
    for (let attempt = 0; attempt < 100 && !setTeammates; attempt++) {
      await Bun.sleep(10)
    }
    expect(setTeammates).toBeDefined()
    return {
      async setTeammates(next) {
        // Only the frames drawn AFTER this change are read back.
        written = ''
        setTeammates!(next)
        await Bun.sleep(120)
        return stripped(written)
      },
      cleanup: teardown,
    }
  } catch (error) {
    await teardown()
    throw error
  }
}

describe('TeammateSpinnerTree — row identity', () => {
  const SUPERVISOR = teammate('supervisor', 'email')
  const WORKER = teammate('worker-1', 'email/supervisor')

  test('a placeholder appearing above a row does not remount that row', async () => {
    const mounted = await mountTree([
      SUPERVISOR,
      verbed(WORKER, 'AlphaVerb'),
    ])
    try {
      // The sub-lead's row goes away, so worker-1 gets a dimmed
      // `@supervisor · not running` placeholder above it — the exact moment the
      // key used to flip. The row is handed a different verb at the same time.
      const frame = await mounted.setTeammates([verbed(WORKER, 'BetaVerb')])

      expect(frame).toContain('@supervisor · not running')
      expect(frame).toContain('AlphaVerb')
      expect(frame).not.toContain('BetaVerb')
    } finally {
      await mounted.cleanup()
    }
  })

  test('the same row survives the placeholder DISAPPEARING again', async () => {
    // The other direction: a missing lead respawning used to remount every
    // member row below it just the same.
    const mounted = await mountTree([verbed(WORKER, 'AlphaVerb')])
    try {
      const frame = await mounted.setTeammates([
        SUPERVISOR,
        verbed(WORKER, 'BetaVerb'),
      ])

      expect(frame).not.toContain('not running')
      expect(frame).toContain('AlphaVerb')
      expect(frame).not.toContain('BetaVerb')
    } finally {
      await mounted.cleanup()
    }
  })

  test('the probe does catch a genuine remount', async () => {
    // Same change, but the row is a different task: the key really does differ,
    // React really does mount a new line, and the initializer really does read
    // the new verb. Without this the case above could pass because the probe
    // cannot see anything at all.
    const mounted = await mountTree([
      SUPERVISOR,
      verbed(WORKER, 'AlphaVerb'),
    ])
    try {
      const frame = await mounted.setTeammates([
        { ...verbed(WORKER, 'BetaVerb'), id: 'task-email/supervisor-other' },
      ])

      expect(frame).toContain('BetaVerb')
      expect(frame).not.toContain('AlphaVerb')
    } finally {
      await mounted.cleanup()
    }
  })
})
