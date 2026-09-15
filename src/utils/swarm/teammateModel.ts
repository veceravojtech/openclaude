import { CLAUDE_OPUS_4_8_CONFIG } from '../model/configs.js'
import { getDefaultOpusModel } from '../model/model.js'
import { getAPIProvider } from '../model/providers.js'

// When the user has never set teammateDefaultModel in /config, new teammates
// use the current default Opus. First-party follows the `opus` alias (the
// newest Opus the Models API reported, or the pinned default); Bedrock/Vertex/
// Foundry stay on their provider-specific Opus 4.8 id until 3P rollout of
// newer models is confirmed.
//
// `leaderModel` is the spawning session's model. It is used only for the
// `openai` provider category: getAPIProvider() collapses every
// OpenAI-compatible endpoint — Z.AI/GLM, DeepSeek, Ollama, vLLM, LM Studio and
// any `custom` route — onto that one key, so the table's 'gpt-4o' entry is
// correct only when the endpoint really is OpenAI. Sending it anywhere else is
// rejected ("Unknown Model"), so inherit the model we know the session is
// already talking to instead. Dedicated categories (gemini, mistral, xai,
// minimax, …) keep their table entry: those are real ids for that one provider.
export function getHardcodedTeammateModelFallback(
  leaderModel?: string | null,
): string {
  const provider = getAPIProvider()
  if (provider === 'firstParty') {
    return getDefaultOpusModel()
  }
  if (provider === 'openai' && leaderModel) {
    return leaderModel
  }
  return CLAUDE_OPUS_4_8_CONFIG[provider]
}
