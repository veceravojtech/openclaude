import { getGlobalConfig, type ProviderProfile } from '../../utils/config.js'
import { getPrimaryModel } from '../../utils/providerModels.js'
import { getProviderProfiles } from '../../utils/providerProfiles.js'

export const PROVIDER_PROFILE_IN_PROCESS_ERROR =
  'provider_profile cannot be used for in-process spawns: an in-process teammate shares the leader process, so its provider environment cannot be overridden. Spawn a pane teammate instead.'

/** Only identity crosses the command line. The child loads credentials locally. */
export function resolveProviderProfileEnv(
  ref: string,
  options?: { profiles?: ProviderProfile[]; model?: string },
): Record<string, string> {
  const profiles = options?.profiles ?? getProviderProfiles(getGlobalConfig())
  const trimmed = ref.trim()
  const profile = profiles.find(profile => profile.id === trimmed) ??
    profiles.find(profile => profile.name.trim().toLowerCase() === trimmed.toLowerCase())
  if (!profile) throw new Error('Unknown provider profile. Select a saved profile with /provider.')
  const model = options?.model?.trim() || getPrimaryModel(profile.model)
  if (!model) throw new Error('The selected provider profile has no default model.')
  return {
    OPENCLAUDE_TEAMMATE_PROFILE_ID: profile.id,
    OPENCLAUDE_TEAMMATE_MODEL: model,
  }
}
