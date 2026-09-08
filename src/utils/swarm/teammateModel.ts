import { CLAUDE_OPUS_4_8_CONFIG } from '../model/configs.js'
import { getDefaultOpusModel } from '../model/model.js'
import { getAPIProvider } from '../model/providers.js'

// When the user has never set teammateDefaultModel in /config, new teammates
// use the current default Opus. First-party follows the `opus` alias (the
// newest Opus the Models API reported, or the pinned default); Bedrock/Vertex/
// Foundry stay on their provider-specific Opus 4.8 id until 3P rollout of
// newer models is confirmed.
export function getHardcodedTeammateModelFallback(): string {
  const provider = getAPIProvider()
  if (provider === 'firstParty') {
    return getDefaultOpusModel()
  }
  return CLAUDE_OPUS_4_8_CONFIG[provider]
}
