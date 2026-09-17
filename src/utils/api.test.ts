import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { getEmptyToolPermissionContext, type Tool, type Tools } from '../Tool.js'
import { SkillTool } from '../tools/SkillTool/SkillTool.js'
import { toolToAPISchema } from './api.js'
import { EXPERIMENTAL_BETAS_DEFAULTED_ENV } from './experimentalBetasDefault.js'

test('toolToAPISchema preserves provider-specific schema keywords in input_schema', async () => {
  const schema = await toolToAPISchema(
    {
      name: 'WebFetch',
      inputSchema: z.strictObject({}),
      inputJSONSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            format: 'uri',
            description: 'Public HTTP or HTTPS URL',
          },
          metadata: {
            type: 'object',
            propertyNames: {
              pattern: '^[a-z]+$',
            },
            properties: {
              callback: {
                type: 'string',
                format: 'uri-reference',
              },
            },
          },
        },
      },
      prompt: async () => 'Fetch a URL',
    } as unknown as Tool,
    {
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      tools: [] as unknown as Tools,
      agents: [],
    },
  )

  expect(schema).toMatchObject({
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          format: 'uri',
          description: 'Public HTTP or HTTPS URL',
        },
        metadata: {
          type: 'object',
          propertyNames: {
            pattern: '^[a-z]+$',
          },
          properties: {
            callback: {
              type: 'string',
              format: 'uri-reference',
            },
          },
        },
      },
    },
  })
})

test('toolToAPISchema keeps skill required for SkillTool', async () => {
  const schema = await toolToAPISchema(SkillTool, {
    getToolPermissionContext: async () => getEmptyToolPermissionContext(),
    tools: [] as unknown as Tools,
    agents: [],
  })

  expect((schema as { input_schema: unknown }).input_schema).toMatchObject({
    type: 'object',
    required: ['skill'],
  })
})

test('toolToAPISchema removes extra required keys not in properties (MCP schema sanitization)', async () => {
  const schema = await toolToAPISchema(
    {
      name: 'mcp__test__create_object',
      inputSchema: z.strictObject({}),
      inputJSONSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        required: ['name', 'attributes'],
      },
      prompt: async () => 'Create an object',
    } as unknown as Tool,
    {
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      tools: [] as unknown as Tools,
      agents: [],
    },
  )

  const inputSchema = (schema as { input_schema: { required?: string[] } }).input_schema
  expect(inputSchema.required).toEqual(['name'])
})

describe('the experimental-betas switch and defer_loading', () => {
  const deferredMcpTool = {
    name: 'mcp__test__lookup',
    inputSchema: z.strictObject({}),
    inputJSONSchema: { type: 'object', properties: {} },
    prompt: async () => 'Look something up',
  } as unknown as Tool

  const envKeys = [
    'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
    EXPERIMENTAL_BETAS_DEFAULTED_ENV,
    'ANTHROPIC_BASE_URL',
  ] as const

  async function deferredSchemaWith(
    env: Partial<Record<(typeof envKeys)[number], string>>,
  ): Promise<Record<string, unknown>> {
    const saved = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
    try {
      for (const key of envKeys) {
        if (env[key] === undefined) delete process.env[key]
        else process.env[key] = env[key]
      }
      return (await toolToAPISchema(deferredMcpTool, {
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        tools: [] as unknown as Tools,
        agents: [],
        deferLoading: true,
      })) as unknown as Record<string, unknown>
    } finally {
      for (const key of envKeys) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
      }
    }
  }

  test("keeps defer_loading under OpenClaude's defaulted switch on Anthropic's API", async () => {
    // Stripping it here while ToolSearch hands out references would send every
    // deferred tool in full anyway — the ~160k-token cost tool search removes.
    const schema = await deferredSchemaWith({
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: 'true',
      [EXPERIMENTAL_BETAS_DEFAULTED_ENV]: '1',
    })
    expect(schema.defer_loading).toBe(true)
  })

  test('strips defer_loading under a switch the user set, and behind a custom base URL', async () => {
    const userSet = await deferredSchemaWith({
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: 'true',
    })
    expect(userSet).not.toHaveProperty('defer_loading')

    const proxied = await deferredSchemaWith({
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: 'true',
      [EXPERIMENTAL_BETAS_DEFAULTED_ENV]: '1',
      ANTHROPIC_BASE_URL: 'https://llm-gateway.example.com',
    })
    expect(proxied).not.toHaveProperty('defer_loading')
  })
})
