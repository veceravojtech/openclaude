import { defineBrand } from '../define.js'

export default defineBrand({
  id: 'deepseek',
  label: 'DeepSeek',
  canonicalVendorId: 'deepseek',
  defaultCapabilities: {
    supportsVision: false,
    supportsStreaming: true,
    supportsFunctionCalling: true,
    supportsJsonMode: true,
    supportsReasoning: true,
    supportsPreciseTokenCount: false,
  },
  modelIds: [
    'deepseek-v4-pro',
    'deepseek-flash',
  ],
})
