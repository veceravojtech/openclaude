/**
 * Opt-in real-tmux e2e: an UNREQUESTED pane death is a crash, a REQUESTED
 * shutdown is a clean release.
 *
 * Drives the BUILT CLI (`bin/openclaude`, which execs dist/cli.mjs) as a lead
 * inside a private tmux server, against a fake Messages API on loopback. The
 * lead spawns a real tmux PANE teammate (teammateMode 'tmux') that creates
 * and claims team task #1. Then:
 *
 * - crash: while the teammate is inside a Bash heartbeat loop, the harness
 *   runs `tmux kill-pane` on its pane — the user's manual test. Expected: a
 *   failed task-notification reaches the lead, exactly one undecided transient
 *   attention item `failure-<taskId>-0` exists, task #1 is pending, unowned
 *   and HELD for it, and no "has shut down" message is sent. The failed
 *   notification's `<result>` carries "Last pane output (captured Ns before
 *   the pane closed):" with a heartbeat line the loop printed before the
 *   kill (the lead's rolling pane-tail capture; the killed pane itself can
 *   no longer be read).
 * - shutdown: the lead sends a shutdown_request, the teammate approves it.
 *   Expected: "has shut down", task #1 released WITHOUT a hold, no attention
 *   item, no failed notification.
 *
 * Run with: bun run build && OPENCLAUDE_E2E=1 bun run e2e:pane-crash
 * Skips (exit 0) without OPENCLAUDE_E2E=1, without tmux, or with tmux < 3.2.
 * Every run uses a throwaway config home; nothing under ~/.openclaude is read
 * or written. Not named *.test.ts, so `bun test` never collects it.
 */
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  isTmuxTooOld,
  MIN_TMUX_MAJOR,
  MIN_TMUX_MINOR,
  parseTmuxVersion,
} from './tmux-version.js'
import { E2E_FAKE_MODEL, providerFreeEnv } from './provider-env.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const LAUNCHER = join(REPO_ROOT, 'bin', 'openclaude')
const CLI_BUNDLE = join(REPO_ROOT, 'dist', 'cli.mjs')
const FAKE_KEY = 'sk-ant-api03-e2e-fake-key-0123456789abcdef'
const MATE = 'crasher'
const TEAMMATE_MARKER = '# Agent Teammate Communication'
const STEP_TIMEOUT_MS = 90_000
const SETTLE_TIMEOUT_MS = 30_000
/** Echoed by the teammate's heartbeat loop; must reach the crash report. */
const HEARTBEAT_MARKER = 'e2e-pane-heartbeat'
/** A line the loop PRINTED (numbered), not the command line that echoes `$i`. */
const HEARTBEAT_LINE = new RegExp(`${HEARTBEAT_MARKER} \\d+`)
/**
 * How long the heartbeat runs before the kill: longer than the rolling
 * pane-tail capture interval (10s) plus one sweeper tick (5s), so at least
 * one capture of the looping pane exists when the pane dies.
 */
const PRE_KILL_HEARTBEAT_MS = 18_000
const CACHED_TAIL_HEADING = /Last pane output \(captured \d+s before the pane closed\):/

type Mode = 'crash' | 'shutdown'
type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
type Step = { block: Block; stop: 'tool_use' | 'end_turn' }
type Body = {
  model?: string
  stream?: boolean
  system?: Array<{ text?: string }>
  messages?: Array<{ content: unknown }>
  tools?: Array<{ name: string }>
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const toolUse = (id: string, name: string, input: Record<string, unknown>): Step => ({
  block: { type: 'tool_use', id, name, input },
  stop: 'tool_use',
})
const text = (t: string): Step => ({ block: { type: 'text', text: t }, stop: 'end_turn' })

function lastUserText(body: Body): string {
  const last = body.messages?.at(-1)
  if (!last) return ''
  return typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
}

function sse(id: string, model: string, step: Step): string {
  const ev = (type: string, data: object) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  const b = step.block
  const start =
    b.type === 'text'
      ? ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: b.text } })
      : ev('content_block_start', {
          index: 0,
          content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} },
        }) +
        ev('content_block_delta', {
          index: 0,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) },
        })
  return (
    ev('message_start', {
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    }) +
    start +
    ev('content_block_stop', { index: 0 }) +
    ev('message_delta', {
      delta: { stop_reason: step.stop, stop_sequence: null },
      usage: { output_tokens: 20 },
    }) +
    ev('message_stop', {})
  )
}

/**
 * The first failed `<task-notification>` in the lead's requests, decoded from
 * the request JSON (each entry of `leadTexts` is a JSON-encoded messages
 * array, whose text blocks hold the notification).
 */
function failedNotificationText(leadTexts: string[]): string | undefined {
  const texts: string[] = []
  const collect = (value: unknown): void => {
    if (typeof value === 'string') texts.push(value)
    else if (Array.isArray(value)) value.forEach(collect)
    else if (value && typeof value === 'object') Object.values(value).forEach(collect)
  }
  for (const raw of leadTexts) {
    try {
      collect(JSON.parse(raw))
    } catch {
      // Not JSON: nothing to decode.
    }
  }
  for (const t of texts) {
    const match = /<task-notification>[\s\S]*?<\/task-notification>/.exec(t)
    if (match && match[0].includes('<status>failed</status>')) return match[0]
  }
  return undefined
}

/** One scenario: its own config home, tmux server and fake API. */
async function runScenario(mode: Mode): Promise<{ passed: boolean; details: string[] }> {
  const root = mkdtempSync(join(tmpdir(), `openclaude-e2e-pane-${mode}-`))
  const configDir = join(root, 'config')
  const work = join(root, 'work')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(join(root, 'home'), { recursive: true })
  mkdirSync(work, { recursive: true })
  const team = `e2epane${process.pid}${mode}`
  const socket = `openclaude-e2e-pane-${process.pid}-${mode}`
  writeFileSync(
    join(configDir, '.openclaude.json'),
    JSON.stringify({
      theme: 'dark',
      hasCompletedOnboarding: true,
      migrationVersion: 11,
      teammateMode: 'tmux',
      customApiKeyResponses: { approved: [FAKE_KEY, FAKE_KEY.slice(-20)], rejected: [] },
      projects: { [work]: { hasTrustDialogAccepted: true, allowedTools: [], history: [] } },
    }),
  )
  writeFileSync(
    join(configDir, 'settings.json'),
    JSON.stringify({
      permissions: { allow: ['Bash', 'TaskCreate', 'TaskUpdate', 'SendMessage'] },
    }),
  )
  // The private server's global environment, and so every CLI's: the
  // harness's own minus any ambient provider selection (provider-env.ts).
  const serverEnv = providerFreeEnv(process.env)
  const tmux = (...args: string[]) =>
    spawnSync('tmux', ['-L', socket, ...args], { encoding: 'utf8', env: serverEnv })

  // The fake API: per-role scripts, plus every lead request's text kept.
  const leadTexts: string[] = []
  let leadTurns = 0
  let mateTurns = 0
  let mateLooping = false
  let shutdownSent = false
  let approved = false
  const leadStep = (body: Body): Step | undefined => {
    leadTurns++
    if (leadTurns === 1) {
      return toolUse('toolu_spawn', 'Agent', {
        description: 'pane crash e2e',
        name: MATE,
        team_name: team,
        prompt: 'Create a task, claim it, then work on it.',
      })
    }
    if (leadTurns === 2) return text(`Spawned ${MATE}.`)
    if (mode === 'shutdown' && !shutdownSent && lastUserText(body).includes('idle_notification')) {
      shutdownSent = true
      return toolUse('toolu_sd', 'SendMessage', {
        to: MATE,
        message: { type: 'shutdown_request', reason: 'work done' },
      })
    }
    return undefined
  }
  const mateStep = (body: Body): Step | undefined => {
    const last = lastUserText(body)
    if (mode === 'shutdown' && !approved && last.includes('shutdown_request')) {
      const requestId = /requestId\\?"\s*:\s*\\?"([^"\\]+)/.exec(last)?.[1] ?? 'unknown'
      approved = true
      return toolUse('toolu_ap', 'SendMessage', {
        to: 'team-lead',
        message: { type: 'shutdown_response', request_id: requestId, approve: true },
      })
    }
    mateTurns++
    if (mateTurns === 1) return toolUse('toolu_tc', 'TaskCreate', { subject: 'heartbeat work', description: 'loop' })
    if (mateTurns === 2) return toolUse('toolu_tu', 'TaskUpdate', { taskId: '1', owner: MATE, status: 'in_progress' })
    if (mateTurns === 3) {
      if (mode === 'shutdown') return text('Claimed task #1; idle now.')
      mateLooping = true
      return toolUse('toolu_bash', 'Bash', {
        command: `for i in $(seq 1 600); do echo "${HEARTBEAT_MARKER} $i"; sleep 1; done`,
        description: 'heartbeat',
        timeout: 600000,
      })
    }
    return undefined
  }
  let nextId = 1
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.endsWith('/count_tokens')) return Response.json({ input_tokens: 10 })
      if (!url.pathname.endsWith('/v1/messages')) return new Response('not found', { status: 404 })
      const body = (await req.json()) as Body
      const isMate = (body.system ?? []).some(b => b?.text?.includes(TEAMMATE_MARKER))
      const main = (body.tools ?? []).some(t => t.name === 'Agent' || t.name === 'SendMessage')
      if (main && !isMate) leadTexts.push(JSON.stringify(body.messages ?? []))
      const step = (main ? (isMate ? mateStep(body) : leadStep(body)) : undefined) ?? text('ok')
      const id = `msg_e2e_${nextId++}`
      const model = body.model ?? 'e2e-model'
      if (body.stream) {
        return new Response(sse(id, model, step), { headers: { 'content-type': 'text/event-stream' } })
      }
      return Response.json({
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [step.block],
        stop_reason: step.stop,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 20 },
      })
    },
  })
  server.unref()

  const details: string[] = []
  const waitFor = async (label: string, cond: () => boolean, ms: number) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (cond()) return true
      await sleep(250)
    }
    details.push(`TIMEOUT waiting for ${label}`)
    return false
  }
  const leadSaw = (needle: string) => leadTexts.some(t => t.includes(needle))
  const taskFile = () => {
    try {
      return JSON.parse(readFileSync(join(configDir, 'tasks', team, '1.json'), 'utf8')) as {
        owner?: string
        status?: string
        metadata?: Record<string, unknown>
      }
    } catch {
      return undefined
    }
  }
  const attentionItems = () => {
    const out: Array<Record<string, unknown>> = []
    const tasksDir = join(configDir, 'tasks')
    if (!existsSync(tasksDir)) return out
    for (const list of readdirSync(tasksDir)) {
      const dir = join(tasksDir, list, '.attention')
      if (!existsSync(dir)) continue
      for (const f of readdirSync(dir)) {
        if (f.endsWith('.json')) out.push(JSON.parse(readFileSync(join(dir, f), 'utf8')))
      }
    }
    return out
  }

  let passed = false
  try {
    tmux(
      'new-session', '-d', '-s', 'lead', '-x', '220', '-y', '50', '-c', work,
      '-e', `OPENCLAUDE_CONFIG_DIR=${configDir}`,
      '-e', `HOME=${join(root, 'home')}`,
      '-e', `XDG_CONFIG_HOME=${join(root, 'xdg')}`,
      '-e', 'OPENCLAUDE_DEFAULT_YOLO=0',
      '-e', `ANTHROPIC_BASE_URL=http://127.0.0.1:${server.port}`,
      '-e', `ANTHROPIC_API_KEY=${FAKE_KEY}`,
      '-e', `ANTHROPIC_MODEL=${E2E_FAKE_MODEL}`,
      LAUNCHER,
    )
    const pane = (target: string) => tmux('capture-pane', '-p', '-t', target).stdout ?? ''
    if (!(await waitFor('the lead prompt', () => pane('lead').includes('? for shortcuts'), STEP_TIMEOUT_MS))) {
      details.push(pane('lead'))
      return { passed, details }
    }
    tmux('send-keys', '-t', 'lead', 'start', 'Enter')
    const panes = () => (tmux('list-panes', '-a', '-F', '#{pane_id}').stdout ?? '').trim().split('\n')
    if (!(await waitFor('the teammate pane', () => panes().length >= 2, STEP_TIMEOUT_MS))) {
      return { passed, details }
    }
    const matePane = panes()[1]!

    if (mode === 'crash') {
      if (!(await waitFor('the teammate heartbeat loop', () => mateLooping, STEP_TIMEOUT_MS))) {
        return { passed, details }
      }
      // Wait until the heartbeat is visibly running in the pane, then long
      // enough for the lead's rolling capture to have read it.
      if (
        !(await waitFor(
          'the heartbeat marker in the teammate pane',
          () => HEARTBEAT_LINE.test(pane(matePane)),
          STEP_TIMEOUT_MS,
        ))
      ) {
        details.push(pane(matePane))
        return { passed, details }
      }
      await sleep(PRE_KILL_HEARTBEAT_MS)
      tmux('kill-pane', '-t', matePane)
      const settled = await waitFor(
        'the failed notification, the item and the hold',
        () =>
          leadSaw('<status>failed</status>') &&
          attentionItems().length > 0 &&
          typeof taskFile()?.metadata?.attentionHold === 'string',
        SETTLE_TIMEOUT_MS,
      )
      const items = attentionItems()
      const task = taskFile()
      details.push(`items: ${JSON.stringify(items.map(i => ({ id: i.id, status: i.status, transient: i.transient })))}`)
      details.push(`task #1: ${JSON.stringify(task)}`)
      // The failed notification as the lead's model received it (decoded
      // from the request JSON). It must carry the pane's last lines, captured
      // while the pane was alive: the killed pane itself can't be read.
      const notification = failedNotificationText(leadTexts)
      details.push(`notification:\n${notification ?? '(none)'}`)
      const tailSection = notification?.split(CACHED_TAIL_HEADING)[1] ?? ''
      passed =
        settled &&
        notification !== undefined &&
        CACHED_TAIL_HEADING.test(notification) &&
        HEARTBEAT_LINE.test(tailSection) &&
        !notification.includes('no output could be captured') &&
        leadSaw('Pane was closed without a shutdown request') &&
        !leadSaw('has shut down') &&
        items.length === 1 &&
        /^failure-.+-0$/.test(String(items[0]!.id)) &&
        items[0]!.status === 'undecided' &&
        items[0]!.transient === true &&
        task?.owner === undefined &&
        task?.status === 'pending' &&
        task?.metadata?.attentionHold === items[0]!.id
    } else {
      const settled = await waitFor(
        'the clean shutdown',
        () => approved && leadSaw('has shut down') && taskFile()?.status === 'pending',
        STEP_TIMEOUT_MS,
      )
      // Long enough for two ghost-sweep scans after the pane goes away.
      await sleep(12_000)
      const task = taskFile()
      details.push(`items: ${JSON.stringify(attentionItems())}`)
      details.push(`task #1: ${JSON.stringify(task)}`)
      passed =
        settled &&
        !leadSaw('<status>failed</status>') &&
        attentionItems().length === 0 &&
        task?.owner === undefined &&
        task?.metadata?.attentionHold === undefined
    }
    return { passed, details }
  } finally {
    tmux('kill-server')
    server.stop(true)
    // The CLI flushes config on SIGHUP; give it a moment before deleting.
    await sleep(1_500)
    rmSync(root, { recursive: true, force: true })
  }
}

async function main(): Promise<number> {
  if (process.env.OPENCLAUDE_E2E !== '1') {
    console.log('SKIP: pane-crash e2e requires OPENCLAUDE_E2E=1 (set it to opt in).')
    return 0
  }
  const probe = spawnSync('tmux', ['-V'], { encoding: 'utf8' })
  if (probe.status !== 0 || !probe.stdout) {
    console.log('SKIP: pane-crash e2e requires tmux on PATH.')
    return 0
  }
  const version = probe.stdout.trim()
  if (isTmuxTooOld(parseTmuxVersion(version))) {
    console.log(
      `SKIP: pane-crash e2e requires tmux >= ${MIN_TMUX_MAJOR}.${MIN_TMUX_MINOR} (found ${version}).`,
    )
    return 0
  }
  if (!existsSync(CLI_BUNDLE)) {
    console.error(`ERROR: ${CLI_BUNDLE} is missing. Run \`bun run build\` first.`)
    return 1
  }
  let failures = 0
  for (const mode of ['crash', 'shutdown'] as const) {
    const { passed, details } = await runScenario(mode)
    console.log(`${passed ? 'PASS' : 'FAILED'}: ${mode}`)
    for (const line of details) console.log(`  ${line}`)
    if (!passed) failures++
  }
  console.log(`${2 - failures}/2 scenarios passed`)
  return failures === 0 ? 0 : 1
}

main().then(
  code => {
    process.exitCode = code
  },
  error => {
    console.error(error)
    process.exitCode = 1
  },
)
