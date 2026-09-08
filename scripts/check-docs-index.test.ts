import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  checkDocsIndex,
  collectReadmeDocMentions,
  compareMirror,
  extractLlmsBlobPaths,
  extractLlmsDocumentationDocs,
  extractReadmeGuideDocs,
  findMissingBlobTargets,
  findOrphanDocs,
  formatResult,
  listTopLevelDocs,
} from './check-docs-index'

const BLOB = 'https://github.com/Gitlawb/openclaude/blob/main/'

/** A README shaped like the real one: two guide lists plus an inline mention. */
function readmeFixture(advancedDocs: string[]): string {
  return [
    '# OpenClaude',
    '',
    'See [Advanced Setup](docs/advanced-setup.md#ollama-context-length) for details.',
    '',
    '## Setup Guides',
    '',
    'Beginner-friendly guides:',
    '',
    '- [Non-Technical Setup](docs/non-technical-setup.md)',
    '',
    'Advanced and source-build guides:',
    '',
    ...advancedDocs.map(doc => `- [${doc}](${doc})`),
    '- [Android Install](ANDROID_INSTALL.md)',
    '',
    '## Supported Providers',
    '',
    '| LiteLLM | ([setup guide](docs/litellm-setup.md)) | notes |',
  ].join('\n')
}

/** An llms.txt shaped like the real one — including its missing trailing newline. */
function llmsFixture(documentationDocs: string[]): string {
  return [
    '# OpenClaude',
    '',
    '## Install',
    '',
    `- [Android install](${BLOB}ANDROID_INSTALL.md)`,
    '',
    '## Documentation',
    '',
    `- [README](${BLOB}README.md): overview`,
    ...documentationDocs.map(doc => `- [${doc}](${BLOB}${doc})`),
    `- [VS Code extension](${BLOB}vscode-extension/openclaude-vscode/README.md)`,
    '',
    '## Providers',
    '',
    `- [LiteLLM setup](${BLOB}docs/litellm-setup.md)`,
    '',
    '## Community',
    '',
    '- [Discord](https://discord.gg/k68zFR6AcB)',
  ].join('\n')
}

const MIRRORED_DOCS = [
  'docs/advanced-setup.md',
  'docs/smart-routing.md',
  'docs/agent-routing.md',
  'docs/grpc-server.md',
]

/** Build a throwaway repo root from a `relative path -> contents` map. */
function withFixtureRoot(
  files: Record<string, string>,
  run: (rootDir: string) => void,
): void {
  const rootDir = mkdtempSync(join(tmpdir(), 'docs-index-'))
  try {
    for (const [relPath, contents] of Object.entries(files)) {
      const absolute = join(rootDir, relPath)
      mkdirSync(dirname(absolute), { recursive: true })
      writeFileSync(absolute, contents)
    }
    run(rootDir)
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
}

/** A consistent fixture tree: every doc linked, both indexes mirrored, URLs resolve. */
function consistentTree(
  overrides: Partial<Record<'README.md' | 'llms', string>> = {},
): Record<string, string> {
  const files: Record<string, string> = {
    'README.md': overrides['README.md'] ?? readmeFixture(MIRRORED_DOCS),
    'web/public/llms.txt': overrides.llms ?? llmsFixture(MIRRORED_DOCS),
    'ANDROID_INSTALL.md': '# Android\n',
    'docs/non-technical-setup.md': '# Non-technical\n',
    'docs/litellm-setup.md': '# LiteLLM\n',
    'vscode-extension/openclaude-vscode/README.md': '# VS Code\n',
  }
  for (const doc of MIRRORED_DOCS) {
    files[doc] = `# ${doc}\n`
  }
  return files
}

describe('check-docs-index parsing helpers', () => {
  test('extractReadmeGuideDocs reads the advanced-guides bullets in order and skips non-docs entries', () => {
    expect(extractReadmeGuideDocs(readmeFixture(MIRRORED_DOCS))).toEqual(
      MIRRORED_DOCS,
    )
  })

  test('extractReadmeGuideDocs stops at the blank line after the bullets, excluding the beginner list', () => {
    const guides = extractReadmeGuideDocs(readmeFixture(MIRRORED_DOCS))
    expect(guides).not.toContain('docs/non-technical-setup.md')
    expect(guides).not.toContain('docs/litellm-setup.md')
  })

  test('extractLlmsDocumentationDocs stops at the next ## heading and skips non-docs blob links', () => {
    const docs = extractLlmsDocumentationDocs(llmsFixture(MIRRORED_DOCS))
    expect(docs).toEqual(MIRRORED_DOCS)
    expect(docs).not.toContain('docs/litellm-setup.md')
  })

  test('extractLlmsBlobPaths collects every blob/main target across all groups without duplicates', () => {
    const paths = extractLlmsBlobPaths(llmsFixture(MIRRORED_DOCS))
    expect(paths).toEqual([
      'ANDROID_INSTALL.md',
      'README.md',
      ...MIRRORED_DOCS,
      'vscode-extension/openclaude-vscode/README.md',
      'docs/litellm-setup.md',
    ])
  })

  test('collectReadmeDocMentions finds docs referenced outside the guide lists and strips anchors', () => {
    const mentions = collectReadmeDocMentions(readmeFixture(MIRRORED_DOCS))
    expect(mentions.has('docs/litellm-setup.md')).toBe(true)
    expect(mentions.has('docs/advanced-setup.md')).toBe(true)
  })
})

describe('C1 ORPHANS', () => {
  test('C1 accepts a doc linked only from README', () => {
    expect(
      findOrphanDocs(['docs/only-readme.md'], new Set(['docs/only-readme.md']), []),
    ).toEqual([])
  })

  test('C1 accepts a doc linked only from an llms.txt blob URL', () => {
    expect(
      findOrphanDocs(['docs/only-llms.md'], new Set(), ['docs/only-llms.md']),
    ).toEqual([])
  })

  test('C1 flags a docs file linked from neither index', () => {
    expect(
      findOrphanDocs(
        ['docs/linked.md', 'docs/orphan.md'],
        new Set(['docs/linked.md']),
        [],
      ),
    ).toEqual(['docs/orphan.md'])
  })

  test('listTopLevelDocs returns sorted top-level docs and ignores nested directories', () => {
    withFixtureRoot(
      {
        'docs/b.md': '# b\n',
        'docs/a.md': '# a\n',
        'docs/notes.txt': 'not markdown\n',
        'docs/integrations/overview.md': '# nested\n',
      },
      rootDir => {
        expect(listTopLevelDocs(rootDir)).toEqual(['docs/a.md', 'docs/b.md'])
      },
    )
  })
})

describe('C2 MIRROR', () => {
  test('C2 passes for two identical ordered lists', () => {
    const result = compareMirror(MIRRORED_DOCS, [...MIRRORED_DOCS])
    expect(result.ok).toBe(true)
    expect(result.firstMismatchIndex).toBeNull()
  })

  test('C2 reports the first mismatch position for reordered lists', () => {
    const swapped = [
      MIRRORED_DOCS[0]!,
      MIRRORED_DOCS[2]!,
      MIRRORED_DOCS[1]!,
      MIRRORED_DOCS[3]!,
    ]
    const result = compareMirror(MIRRORED_DOCS, swapped)
    expect(result.ok).toBe(false)
    expect(result.firstMismatchIndex).toBe(1)
  })

  test('C2 fails at the trailing position when llms.txt is missing the last entry', () => {
    const result = compareMirror(MIRRORED_DOCS, MIRRORED_DOCS.slice(0, -1))
    expect(result.ok).toBe(false)
    expect(result.firstMismatchIndex).toBe(MIRRORED_DOCS.length - 1)
  })

  test('C2 failure output names both sides of the diverging position', () => {
    withFixtureRoot(
      consistentTree({ llms: llmsFixture(MIRRORED_DOCS.slice(0, -1)) }),
      rootDir => {
        const report = formatResult(checkDocsIndex(rootDir))
        expect(report).toContain('C2 MIRROR')
        expect(report).toContain('position 4 (1-based)')
        expect(report).toContain('docs/grpc-server.md')
        expect(report).toContain('(missing)')
      },
    )
  })
})

describe('C3 EXISTENCE', () => {
  test('C3 passes when every blob target resolves under the root', () => {
    withFixtureRoot({ 'docs/present.md': '# present\n' }, rootDir => {
      expect(findMissingBlobTargets(rootDir, ['docs/present.md'])).toEqual([])
    })
  })

  test('C3 flags a blob target with no file under the root', () => {
    withFixtureRoot({ 'docs/present.md': '# present\n' }, rootDir => {
      expect(
        findMissingBlobTargets(rootDir, ['docs/present.md', 'docs/gone.md']),
      ).toEqual(['docs/gone.md'])
    })
  })

  test('C3 refuses to follow a target that escapes the repo root', () => {
    withFixtureRoot({ 'docs/present.md': '# present\n' }, rootDir => {
      expect(
        findMissingBlobTargets(rootDir, ['../escape.md', '/etc/hostname']),
      ).toEqual(['../escape.md', '/etc/hostname'])
    })
  })
})

describe('checkDocsIndex end to end', () => {
  test('a consistent fixture tree passes all three checks with the ok summary line', () => {
    withFixtureRoot(consistentTree(), rootDir => {
      const result = checkDocsIndex(rootDir)
      expect(result.ok).toBe(true)
      expect(result.orphans).toEqual([])
      expect(result.missingBlobTargets).toEqual([])
      expect(formatResult(result)).toBe(
        `docs-index: ok (${result.docs.length} docs, 4 mirrored, ${result.blobPaths.length} urls)`,
      )
    })
  })

  test('removing one llms.txt Documentation link fails the run and names the doc', () => {
    const kept = MIRRORED_DOCS.filter(doc => doc !== 'docs/agent-routing.md')
    withFixtureRoot(consistentTree({ llms: llmsFixture(kept) }), rootDir => {
      const result = checkDocsIndex(rootDir)
      expect(result.ok).toBe(false)
      expect(result.mirror.ok).toBe(false)
      const report = formatResult(result)
      expect(report).toContain('docs-index: FAILED')
      expect(report).toContain('docs/agent-routing.md')
    })
  })

  test('a doc present on disk but absent from both indexes is reported as an orphan', () => {
    const files = consistentTree()
    files['docs/unlinked.md'] = '# unlinked\n'
    withFixtureRoot(files, rootDir => {
      const result = checkDocsIndex(rootDir)
      expect(result.ok).toBe(false)
      expect(result.orphans).toEqual(['docs/unlinked.md'])
      expect(formatResult(result)).toContain('C1 ORPHANS')
    })
  })

  test('a blob URL pointing at a deleted file is reported by C3 end to end', () => {
    const files = consistentTree()
    delete files['vscode-extension/openclaude-vscode/README.md']
    withFixtureRoot(files, rootDir => {
      const result = checkDocsIndex(rootDir)
      expect(result.ok).toBe(false)
      expect(result.missingBlobTargets).toEqual([
        'vscode-extension/openclaude-vscode/README.md',
      ])
      expect(formatResult(result)).toContain('C3 EXISTENCE')
    })
  })

  test('a missing required index file is reported instead of crashing', () => {
    const files = consistentTree()
    delete files['web/public/llms.txt']
    withFixtureRoot(files, rootDir => {
      const result = checkDocsIndex(rootDir)
      expect(result.ok).toBe(false)
      expect(result.errors).toHaveLength(1)
      expect(formatResult(result)).toContain('INPUT - required index files')
    })
  })

  test('checkDocsIndex never writes to the tree it inspects', () => {
    withFixtureRoot(consistentTree(), rootDir => {
      const before = listTopLevelDocs(rootDir)
      checkDocsIndex(rootDir)
      checkDocsIndex(rootDir)
      expect(listTopLevelDocs(rootDir)).toEqual(before)
    })
  })
})
