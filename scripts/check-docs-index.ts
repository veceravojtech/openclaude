/**
 * `bun run docs:check` — enforce the README.md <-> web/public/llms.txt docs-index invariant.
 *
 * The repository keeps two hand-maintained indexes of `docs/*.md`: the
 * "Advanced and source-build guides" bullet list in README.md and the
 * `## Documentation` group in web/public/llms.txt. They were restored to an
 * ordered mirror by hand, and nothing stopped the next doc added to one index
 * from silently desynchronising the other. This script is that guard.
 *
 * Three checks, all read-only:
 *   C1 ORPHANS   every top-level `docs/*.md` is referenced from README.md or
 *                from a `blob/main/docs/` URL in llms.txt.
 *   C2 MIRROR    the ordered `docs/*.md` targets of the two lists are equal.
 *                Non-`docs/` entries (ANDROID_INSTALL.md, README.md, the VS
 *                Code extension README) are ignored by design.
 *   C3 EXISTENCE every `blob/main/<path>` URL in llms.txt resolves to a file.
 *
 * Usage: `bun run scripts/check-docs-index.ts [rootDir]` (default `process.cwd()`).
 * Exit 0 with a one-line summary when all pass, exit 1 with a per-check listing
 * otherwise. It never writes to the tree.
 *
 * Deliberately NOT chained into `check`, `typecheck`, `hardening:*`, or CI —
 * the pre-push contract is maintainer-owned (same rule as `typecheck:e2e`).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

/** Repo-relative path of the README index. */
export const README_RELPATH = 'README.md'

/** Repo-relative path of the llms.txt index. */
export const LLMS_RELPATH = join('web', 'public', 'llms.txt')

/** Every llms.txt file link is an absolute URL under this prefix. */
const BLOB_PREFIX = 'https://github.com/Gitlawb/openclaude/blob/main/'

/** The README line that opens the mirrored bullet list. */
const README_GUIDE_HEADING = 'Advanced and source-build guides:'

/** The llms.txt heading that opens the mirrored group. */
const LLMS_DOC_HEADING = '## Documentation'

/** Markdown inline link: captures the target inside `[text](target)`. */
const MARKDOWN_LINK_PATTERN = /\[[^\]]*\]\(([^)\s]+)\)/g

/** Any `docs/<name>.md` path mentioned anywhere in a document. */
const DOCS_PATH_PATTERN = /docs\/[A-Za-z0-9._-]+\.md/g

/** Outcome of the C2 ordered-mirror comparison. */
export type MirrorResult = {
  ok: boolean
  /** Ordered `docs/*.md` targets from README's advanced-guides list. */
  readme: string[]
  /** Ordered `docs/*.md` targets from llms.txt's `## Documentation` group. */
  llms: string[]
  /** Zero-based index of the first divergence, or `null` when the lists match. */
  firstMismatchIndex: number | null
}

/** Full result of one `checkDocsIndex(rootDir)` run. */
export type DocsIndexResult = {
  ok: boolean
  rootDir: string
  /** Every top-level `docs/*.md`, sorted. */
  docs: string[]
  /** C1: docs referenced by neither index. */
  orphans: string[]
  /** C2. */
  mirror: MirrorResult
  /** Every `blob/main/<path>` target found in llms.txt, in document order. */
  blobPaths: string[]
  /** C3: blob targets that do not resolve to a file under `rootDir`. */
  missingBlobTargets: string[]
  /** Unreadable required inputs. When non-empty the checks above are skipped. */
  errors: string[]
}

/** Drop a `#fragment` suffix from a link target. */
function stripAnchor(target: string): string {
  const hash = target.indexOf('#')
  return hash === -1 ? target : target.slice(0, hash)
}

/** True for a top-level `docs/<name>.md` path (no nested directories). */
function isTopLevelDocsPath(value: string): boolean {
  return /^docs\/[A-Za-z0-9._-]+\.md$/.test(value)
}

/**
 * Every top-level `docs/*.md` in `rootDir`, as sorted `docs/<name>.md` paths.
 * Non-recursive by design: `docs/integrations/**` has its own overview page and
 * is not part of either index.
 */
export function listTopLevelDocs(rootDir: string): string[] {
  const docsDir = join(rootDir, 'docs')
  let entries: string[]
  try {
    entries = readdirSync(docsDir)
  } catch {
    return []
  }
  return entries
    .filter(name => name.endsWith('.md'))
    .filter(name => {
      try {
        return statSync(join(docsDir, name)).isFile()
      } catch {
        return false
      }
    })
    .map(name => `docs/${name}`)
    .sort()
}

/**
 * Every `docs/*.md` path mentioned anywhere in README.md — the bullet lists,
 * the providers table, and prose cross-references all count for C1.
 */
export function collectReadmeDocMentions(readmeText: string): Set<string> {
  const found = new Set<string>()
  for (const match of readmeText.matchAll(DOCS_PATH_PATTERN)) {
    found.add(match[0])
  }
  return found
}

/**
 * The ordered `docs/*.md` targets of README's "Advanced and source-build
 * guides" bullet list: from that heading to the first blank line after the
 * bullets start. Non-`docs/` bullets (ANDROID_INSTALL.md) are skipped.
 */
export function extractReadmeGuideDocs(readmeText: string): string[] {
  const lines = readmeText.split('\n')
  const headingIndex = lines.findIndex(
    line => line.trim() === README_GUIDE_HEADING,
  )
  if (headingIndex === -1) {
    return []
  }

  const targets: string[] = []
  let started = false
  for (let i = headingIndex + 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const trimmed = line.trim()
    if (!started) {
      // A blank line separates the heading from its bullets; skip it.
      if (trimmed === '') {
        continue
      }
      if (!trimmed.startsWith('- ')) {
        break
      }
      started = true
    } else if (trimmed === '' || !trimmed.startsWith('- ')) {
      break
    }
    for (const match of trimmed.matchAll(MARKDOWN_LINK_PATTERN)) {
      const target = stripAnchor(match[1] ?? '')
      if (isTopLevelDocsPath(target)) {
        targets.push(target)
      }
    }
  }
  return targets
}

/**
 * The ordered `docs/*.md` targets of llms.txt's `## Documentation` group: from
 * that heading to the next `## ` heading. Non-`docs/` entries (the README and
 * VS Code extension links) are skipped.
 */
export function extractLlmsDocumentationDocs(llmsText: string): string[] {
  const lines = llmsText.split('\n')
  const headingIndex = lines.findIndex(
    line => line.trim() === LLMS_DOC_HEADING,
  )
  if (headingIndex === -1) {
    return []
  }

  const targets: string[] = []
  for (let i = headingIndex + 1; i < lines.length; i++) {
    const trimmed = (lines[i] ?? '').trim()
    if (trimmed.startsWith('## ')) {
      break
    }
    for (const match of trimmed.matchAll(MARKDOWN_LINK_PATTERN)) {
      const target = stripAnchor(match[1] ?? '')
      if (!target.startsWith(BLOB_PREFIX)) {
        continue
      }
      const relPath = target.slice(BLOB_PREFIX.length)
      if (isTopLevelDocsPath(relPath)) {
        targets.push(relPath)
      }
    }
  }
  return targets
}

/**
 * Every repo-relative path behind a `blob/main/<path>` URL in llms.txt, in
 * document order, deduplicated. Matched outside markdown links too, so a bare
 * URL is still covered.
 */
export function extractLlmsBlobPaths(llmsText: string): string[] {
  const pattern = new RegExp(
    `${BLOB_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\s)\\]"'<>]+)`,
    'g',
  )
  const seen = new Set<string>()
  const paths: string[] = []
  for (const match of llmsText.matchAll(pattern)) {
    const relPath = stripAnchor(match[1] ?? '')
    if (relPath === '' || seen.has(relPath)) {
      continue
    }
    seen.add(relPath)
    paths.push(relPath)
  }
  return paths
}

/**
 * C1: docs referenced by neither index. `llmsBlobPaths` is the full blob-URL
 * path list — a doc counts as linked when it appears there or in README.
 */
export function findOrphanDocs(
  docs: string[],
  readmeMentions: Set<string>,
  llmsBlobPaths: string[],
): string[] {
  const llmsDocs = new Set(llmsBlobPaths.filter(isTopLevelDocsPath))
  return docs.filter(doc => !readmeMentions.has(doc) && !llmsDocs.has(doc))
}

/** C2: compare the two ordered lists and locate the first divergence. */
export function compareMirror(readme: string[], llms: string[]): MirrorResult {
  const limit = Math.max(readme.length, llms.length)
  for (let i = 0; i < limit; i++) {
    if (readme[i] !== llms[i]) {
      return { ok: false, readme, llms, firstMismatchIndex: i }
    }
  }
  return { ok: true, readme, llms, firstMismatchIndex: null }
}

/**
 * C3: blob targets that do not resolve to a file under `rootDir`. A path that
 * escapes `rootDir` (absolute, or `../`) is reported as missing rather than
 * followed.
 */
export function findMissingBlobTargets(
  rootDir: string,
  blobPaths: string[],
): string[] {
  const root = resolve(rootDir)
  return blobPaths.filter(relPath => {
    if (isAbsolute(relPath)) {
      return true
    }
    const absolute = resolve(root, relPath)
    const inside = relative(root, absolute)
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
      return true
    }
    try {
      return !statSync(absolute).isFile()
    } catch {
      return true
    }
  })
}

/** Read a required input, or record why it could not be read. */
function readRequired(
  rootDir: string,
  relPath: string,
  errors: string[],
): string | null {
  try {
    return readFileSync(join(rootDir, relPath), 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    errors.push(`cannot read ${relPath}: ${message}`)
    return null
  }
}

/** Run all three checks against a repository root. Never writes to disk. */
export function checkDocsIndex(rootDir: string): DocsIndexResult {
  const root = resolve(rootDir)
  const errors: string[] = []
  const readmeText = readRequired(root, README_RELPATH, errors)
  const llmsText = readRequired(root, LLMS_RELPATH, errors)

  if (readmeText === null || llmsText === null) {
    return {
      ok: false,
      rootDir: root,
      docs: [],
      orphans: [],
      mirror: { ok: false, readme: [], llms: [], firstMismatchIndex: null },
      blobPaths: [],
      missingBlobTargets: [],
      errors,
    }
  }

  const docs = listTopLevelDocs(root)
  const blobPaths = extractLlmsBlobPaths(llmsText)
  const orphans = findOrphanDocs(
    docs,
    collectReadmeDocMentions(readmeText),
    blobPaths,
  )
  const mirror = compareMirror(
    extractReadmeGuideDocs(readmeText),
    extractLlmsDocumentationDocs(llmsText),
  )
  const missingBlobTargets = findMissingBlobTargets(root, blobPaths)

  return {
    ok:
      orphans.length === 0 && mirror.ok && missingBlobTargets.length === 0,
    rootDir: root,
    docs,
    orphans,
    mirror,
    blobPaths,
    missingBlobTargets,
    errors,
  }
}

/** Render one list entry for the side-by-side mirror listing. */
function renderMirrorList(label: string, entries: string[]): string[] {
  if (entries.length === 0) {
    return [`    ${label}: (empty)`]
  }
  return [
    `    ${label}:`,
    ...entries.map((entry, i) => `      ${i + 1}. ${entry}`),
  ]
}

/** Human-readable report: one summary line when ok, a per-check listing when not. */
export function formatResult(result: DocsIndexResult): string {
  if (result.ok) {
    return `docs-index: ok (${result.docs.length} docs, ${result.mirror.readme.length} mirrored, ${result.blobPaths.length} urls)`
  }

  const lines: string[] = [`docs-index: FAILED (root ${result.rootDir})`]

  if (result.errors.length > 0) {
    lines.push('', 'INPUT - required index files could not be read:')
    for (const error of result.errors) {
      lines.push(`  - ${error}`)
    }
    return lines.join('\n')
  }

  if (result.orphans.length > 0) {
    lines.push(
      '',
      `C1 ORPHANS - ${result.orphans.length} doc(s) linked from neither ${README_RELPATH} nor ${LLMS_RELPATH}:`,
    )
    for (const orphan of result.orphans) {
      lines.push(`  - ${orphan}`)
    }
  }

  if (!result.mirror.ok) {
    const index = result.mirror.firstMismatchIndex ?? 0
    const readmeEntry = result.mirror.readme[index] ?? '(missing)'
    const llmsEntry = result.mirror.llms[index] ?? '(missing)'
    lines.push(
      '',
      `C2 MIRROR - README "${README_GUIDE_HEADING}" and ${LLMS_RELPATH} "${LLMS_DOC_HEADING}" diverge at position ${index + 1} (1-based):`,
      `    ${README_RELPATH}[${index + 1}] = ${readmeEntry}`,
      `    ${LLMS_RELPATH}[${index + 1}] = ${llmsEntry}`,
      ...renderMirrorList(README_RELPATH, result.mirror.readme),
      ...renderMirrorList(LLMS_RELPATH, result.mirror.llms),
    )
  }

  if (result.missingBlobTargets.length > 0) {
    lines.push(
      '',
      `C3 EXISTENCE - ${result.missingBlobTargets.length} blob/main URL target(s) in ${LLMS_RELPATH} do not resolve under the repo root:`,
    )
    for (const missing of result.missingBlobTargets) {
      lines.push(`  - ${missing}`)
    }
  }

  return lines.join('\n')
}

if (import.meta.main) {
  const rootDir = process.argv[2] ?? process.cwd()
  const result = checkDocsIndex(rootDir)
  const report = formatResult(result)
  if (result.ok) {
    console.log(report)
  } else {
    console.error(report)
  }
  process.exitCode = result.ok ? 0 : 1
}
