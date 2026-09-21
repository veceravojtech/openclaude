import { defineVendor } from '../define.js'

export default defineVendor({
  id: 'deepseek',
  label: 'DeepSeek',
  classification: 'openai-compatible',
  defaultBaseUrl: 'https://api.deepseek.com/v1',
  defaultModel: 'deepseek-v4-pro',
  requiredEnvVars: ['DEEPSEEK_API_KEY'],
  setup: {
    requiresAuth: true,
    authMode: 'api-key',
    credentialEnvVars: ['DEEPSEEK_API_KEY'],
  },
  transportConfig: {
    kind: 'openai-compatible',
    openaiShim: {
      preserveReasoningContent: true,
      requireReasoningContentOnAssistantMessages: true,
      reasoningContentFallback: '',
      thinkingRequestFormat: 'deepseek-compatible',
      maxTokensField: 'max_tokens',
      removeBodyFields: ['store'],
      supportsApiFormatSelection: false,
      supportsAuthHeaders: false,
    },
  },
  preset: {
    id: 'deepseek',
    description: 'DeepSeek OpenAI-compatible endpoint',
    apiKeyEnvVars: ['DEEPSEEK_API_KEY'],
  },
  catalog: {
    source: 'static',
    models: [
      {
        id: 'deepseek-v4-pro',
        apiName: 'deepseek-v4-pro',
        label: 'DeepSeek V4 Pro',
        modelDescriptorId: 'deepseek-v4-pro',
        maxOutputTokens: 393_216,
      },
      {
        id: 'deepseek-flash',
        apiName: 'deepseek-flash',
        label: 'DeepSeek Flash',
        modelDescriptorId: 'deepseek-flash',
        maxOutputTokens: 393_216,
      },
    ],
  },
  usage: { supported: false },
})
