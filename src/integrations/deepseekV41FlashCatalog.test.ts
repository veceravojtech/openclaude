import { expect, test } from 'bun:test'
import deepseekModels from './models/deepseek.js'
import fireworksModels from './models/fireworks-merged.js'
import deepseekVendor from './vendors/deepseek.js'
import fireworksVendor from './vendors/fireworks.js'
import fireworksBrand from './brands/fireworks.js'

test('deepseek-flash (V4.1 Flash) accepts image input and keeps the V4 Flash limits', () => {
  const model = deepseekModels.find(model => model.id === 'deepseek-flash')
  expect(model?.capabilities.supportsVision).toBe(true)
  expect(model?.capabilities.supportsFunctionCalling).toBe(true)
  expect(model?.contextWindow).toBe(1_048_576)
  expect(model?.maxOutputTokens).toBe(393_216)
  const route = deepseekVendor.catalog?.models?.find(model => model.id === 'deepseek-flash')
  expect(route?.apiName).toBe('deepseek-flash')
  expect(route?.modelDescriptorId).toBe(model?.id)
})

test('the legacy deepseek-v4-flash entry stays in the catalog', () => {
  expect(deepseekModels.some(model => model.id === 'deepseek-v4-flash')).toBe(true)
})

test('Fireworks routes DeepSeek V4.1 Flash as deepseek-v4p1-flash', () => {
  const id = 'accounts/fireworks/models/deepseek-v4p1-flash'
  const model = fireworksModels.find(model => model.id === id)
  expect(model?.contextWindow).toBe(1_040_000)
  expect(model?.capabilities.supportsVision).toBe(true)
  expect(model?.capabilities.supportsFunctionCalling).toBe(true)
  const route = fireworksVendor.catalog?.models?.find(model => model.id === id)
  expect(route?.apiName).toBe(id)
  expect(route?.modelDescriptorId).toBe(id)
  expect(JSON.stringify(fireworksBrand)).toContain(id)
})
