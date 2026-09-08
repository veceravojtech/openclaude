import { afterEach, describe, expect, mock, test } from 'bun:test'

// Capture the genuine settings module once, through a query-suffixed specifier so
// the capture can never pick up an already-registered mock. A plain
// `import * as … from '../settings/settings.js'` would bind the live namespace,
// which `mock.module()` mutates in place, so restoring from it re-installs the stub.
const realSettings = (await import(
  `../settings/settings.js?dangerousModePromptRuntimeReal=${Date.now()}-${Math.random()}`
)) as typeof import('../settings/settings.js')

// Bun's `mock.restore()` restores spyOn/function mocks only — it does NOT
// unregister a `mock.module()` registration, so the settings stub below would
// otherwise outlive this file for the rest of the runner process. Re-register the
// genuine module first, then restore the function mocks.
afterEach(() => {
  mock.module('../settings/settings.js', () => ({ ...realSettings }))
  mock.restore()
})

describe('dangerousModePromptRuntime', () => {
  test('startup prompt state and acceptance persistence use the settings-backed runtime wiring', async () => {
    let hasBypassAcceptance = false
    let hasFullAccessAcceptance = false
    const updates: Array<{
      source: string
      settings: Record<string, unknown>
    }> = []

    mock.module('../settings/settings.js', () => ({
      ...realSettings,
      hasSkipDangerousModePermissionPrompt: () => hasBypassAcceptance,
      hasSkipFullAccessModePermissionPrompt: () => hasFullAccessAcceptance,
      updateSettingsForSource: (
        source: string,
        settings: Record<string, unknown>,
      ) => {
        updates.push({ source, settings })
        return { error: null }
      },
    }))

    const {
      getStartupDangerousPermissionPromptState,
      persistDangerousModeAcceptance,
    } = await import(
      `./dangerousModePromptRuntime.js?ts=${Date.now()}-${Math.random()}`
    )

    expect(
      getStartupDangerousPermissionPromptState({
        permissionMode: 'fullAccess',
        allowDangerouslySkipPermissions: false,
      }),
    ).toEqual({
      mode: 'fullAccess',
      shouldShow: true,
    })

    hasFullAccessAcceptance = true

    expect(
      getStartupDangerousPermissionPromptState({
        permissionMode: 'fullAccess',
        allowDangerouslySkipPermissions: false,
      }),
    ).toEqual({
      mode: 'fullAccess',
      shouldShow: false,
    })

    persistDangerousModeAcceptance('fullAccess')
    persistDangerousModeAcceptance('bypassPermissions')

    expect(updates).toEqual([
      {
        source: 'userSettings',
        settings: { skipFullAccessModePermissionPrompt: true },
      },
      {
        source: 'userSettings',
        settings: { skipDangerousModePermissionPrompt: true },
      },
    ])
  })
})
