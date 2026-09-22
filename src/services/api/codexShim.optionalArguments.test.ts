import { describe, expect, test } from 'bun:test'
import { codexStreamToAnthropic, convertCodexResponseToAnthropicMessage, convertToolsToResponsesTools } from './codexShim'

const schema = {
  type: 'object',
  properties: {
    required: { type: 'string' }, optional: { type: 'string', default: 'default' },
    bool: { type: 'boolean' }, number: { type: 'number' }, text: { type: 'string' },
    nil: { type: 'null' }, union: { type: ['string', 'null'] },
    enumeration: { enum: ['x', null] }, constant: { const: null },
    reference: { $ref: '#/$defs/unknown' },
    nullable: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    nested: { type: 'array', items: { type: 'object', properties: { omit: { type: 'string' }, keep: { type: 'string' } }, required: ['keep'] } },
  }, required: ['required'],
}
const schemas = new Map([['probe', schema]])
const args = { required: null, optional: null, bool: false, number: 0, text: '', nil: null, union: null, enumeration: null, constant: null, reference: null, nullable: null, nested: [{ omit: null, keep: null }] }
const expected = { ...args, nested: [{ keep: null }] } as Record<string, unknown>
delete expected.optional
const item = (argumentsText = JSON.stringify(args), id = 'item') => ({ type: 'function_call', id, call_id: id, name: 'probe', arguments: argumentsText })
const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
const added = (argumentsText = '', id = 'item') => frame('response.output_item.added', { item: item(argumentsText, id) })
const done = (argumentsText = JSON.stringify(args), id = 'item', status = 'completed') => frame('response.output_item.done', { item: { ...item(argumentsText, id), status } })
const terminal = frame('response.completed', { response: { status: 'completed' } })
async function consume(sse: string, map: ReadonlyMap<string, Record<string, unknown>> = schemas, signal?: AbortSignal) {
  const events: any[] = []
  let error: unknown
  try {
    for await (const event of codexStreamToAnthropic(new Response(sse), 'codex', signal, map)) events.push(event)
  } catch (caught) { error = caught }
  // This is the consumer's execution gate: only stopped tool blocks are executable.
  const executable = events.filter(e => e.type === 'content_block_stop')
  const inputs = new Map<number, string>()
  for (const event of events) if (event.delta?.type === 'input_json_delta') inputs.set(event.index, (inputs.get(event.index) ?? '') + event.delta.partial_json)
  return { events, executable, inputs, error }
}

describe('Codex strict optional argument roundtrip', () => {
  test('nonstream omits only synthetic nulls and preserves defaults/falsy/required/genuine null', () => {
    const result = convertCodexResponseToAnthropicMessage({ output: [item()] }, 'codex', schemas)
    expect((result.content as any[])[0].input).toEqual(expected)
    expect(schema.properties.optional.default).toBe('default')
  })

  test('enum, const and combinators are wholly wrapped, not narrowed by sibling constraints', () => {
    const properties = { enum: { type: 'string', enum: ['a'] }, const: { const: 'a' }, combo: { anyOf: [{ type: 'string' }, { type: 'number' }] } }
    const tools = convertToolsToResponsesTools([{ name: 'probe', input_schema: { type: 'object', properties } }])
    const encoded = tools[0].parameters as any
    expect(encoded.properties.enum).toEqual({ anyOf: [properties.enum, { type: 'null' }] })
    expect(encoded.properties.const).toEqual({ anyOf: [{ const: 'a', type: 'string' }, { type: 'null' }] })
    expect(encoded.properties.combo).toEqual({ anyOf: [properties.combo, { type: 'null' }] })
    expect(encoded.required).toEqual(['enum', 'const', 'combo'])
  })

  test('nullable enum/const inference preserves genuine null in the original strict branch', () => {
    const tools = convertToolsToResponsesTools([{ name: 'probe', input_schema: { type: 'object', properties: { enumeration: { enum: ['a', null] }, constant: { const: null } } } }])
    const properties = (tools[0].parameters as any).properties
    expect(properties.enumeration.anyOf[0]).toEqual({ enum: ['a', null], type: ['string', 'null'] })
    expect(properties.constant.anyOf[0]).toEqual({ const: null, type: 'null' })
  })

  test('request-local maps do not cross-contaminate same-named tools', async () => {
    const other = new Map([['probe', { type: 'object', properties: { optional: { type: 'null' } } }]])
    const sse = added() + done('{"optional":null}') + terminal
    const [a, b] = await Promise.all([consume(sse), consume(sse, other)])
    expect(JSON.parse(a.inputs.get(0)!)).toEqual({})
    expect(JSON.parse(b.inputs.get(0)!)).toEqual({ optional: null })
  })

  for (const mode of ['initial', 'delta', 'done', 'fallback']) {
    test(`normalizes once before stop with ${mode} arguments`, async () => {
      const text = JSON.stringify(args)
      let sse = added(mode === 'initial' ? text : '')
      if (mode === 'delta') sse += frame('response.function_call_arguments.delta', { item_id: 'item', delta: text })
      if (mode === 'done' || mode === 'fallback') sse += frame('response.function_call_arguments.done', { item_id: 'item', arguments: mode === 'done' ? text : '' })
      sse += done(text) + done(text) + frame('response.function_call_arguments.done', { item_id: 'item', arguments: text }) + terminal
      const result = await consume(sse)
      expect(result.error).toBeUndefined()
      expect(result.executable).toHaveLength(1)
      expect(JSON.parse(result.inputs.get(0)!)).toEqual(expected)
      expect(result.events.filter(e => e.delta?.type === 'input_json_delta')).toHaveLength(1)
    })
  }

  test('interleaved calls remain isolated', async () => {
    const result = await consume(added('', 'a') + added('', 'b') + done('{"text":"b","optional":null}', 'b') + done('{"text":"a","optional":null}', 'a') + terminal)
    expect(result.executable).toHaveLength(2)
    expect(JSON.parse(result.inputs.get(0)!)).toEqual({ text: 'a' })
    expect(JSON.parse(result.inputs.get(1)!)).toEqual({ text: 'b' })
  })

  for (const ending of ['', frame('response.incomplete', { response: { status: 'incomplete' } }), frame('response.failed', { response: { error: { message: 'failed' } } }), terminal, done('{}', 'item', 'in_progress'), done('{')]) {
    test(`unfinished calls never reach executable consumer gate: ${ending.slice(0, 80)}`, async () => {
      const result = await consume(added() + frame('response.function_call_arguments.done', { item_id: 'item', arguments: '{}' }) + ending)
      expect(result.error).toBeDefined()
      expect(result.executable).toHaveLength(0)
    })
  }

  test('missing arguments and mid-call abort cannot close an executable block', async () => {
    const missing = await consume(added() + done('') + terminal)
    expect(missing.error).toBeDefined()
    expect(missing.executable).toHaveLength(0)
    const controller = new AbortController()
    const events: any[] = []
    let error: unknown
    try {
      for await (const event of codexStreamToAnthropic(new Response(added('{}') + done('{}') + terminal), 'codex', controller.signal, schemas)) {
        events.push(event)
        if (event.type === 'content_block_start') controller.abort()
      }
    } catch (caught) { error = caught }
    expect(error).toBeDefined()
    expect(events.filter(event => event.type === 'content_block_stop')).toHaveLength(0)
  })

  test('sibling and allOf required constraints survive recursive normalization', () => {
    for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
      const nested = { type: 'object', properties: { keep: { type: 'string' } }, required: ['keep'], [keyword]: [{ type: 'object', properties: { keep: { type: 'string' }, omit: { type: 'string' } } }, ...(keyword === 'allOf' ? [] : [{ type: 'null' }])] }
      const map = new Map([['probe', { type: 'object', properties: { nested } }]])
      const result = convertCodexResponseToAnthropicMessage({ output: [item('{"nested":{"keep":null,"omit":null}}')] }, 'codex', map)
      expect((result.content as any[])[0].input).toEqual({ nested: { keep: null } })
    }
  })

  test('missing completion evidence cannot turn buffered arguments into executable calls', async () => {
    for (const incompleteItem of [{ ...item(), status: undefined }, { ...item(), status: 'completed', arguments: undefined }, { ...item(), status: 'completed', arguments: null }]) {
      const result = await consume(added() + frame('response.function_call_arguments.delta', { item_id: 'item', delta: '{}' }) + frame('response.output_item.done', { item: incompleteItem }) + frame('response.incomplete', { response: { status: 'incomplete' } }))
      expect(result.error).toBeDefined()
      expect(result.executable).toHaveLength(0)
    }
  })

  test('late deltas and contradictory duplicate argument done cannot corrupt authoritative completion', async () => {
    const result = await consume(added() + frame('response.function_call_arguments.done', { item_id: 'item', arguments: '{"text":"first"}' }) + frame('response.function_call_arguments.done', { item_id: 'item', arguments: '{"text":"wrong"}' }) + frame('response.function_call_arguments.delta', { item_id: 'item', delta: 'junk' }) + done('{"text":"authoritative"}') + terminal)
    expect(result.error).toBeUndefined()
    expect(result.executable).toHaveLength(1)
    expect(JSON.parse(result.inputs.get(0)!)).toEqual({ text: 'authoritative' })
  })

  test('missing, null and non-object nonstream arguments fail closed', async () => {
    for (const argumentsText of [undefined, null, '', 'null', '[]', '1']) {
      expect(() => convertCodexResponseToAnthropicMessage({ status: 'completed', output: [{ ...item(), status: 'completed', arguments: argumentsText }] }, 'codex', schemas)).toThrow()
      if (typeof argumentsText === 'string') {
        const result = await consume(added() + done(argumentsText) + terminal)
        expect(result.error).toBeDefined()
        expect(result.executable).toHaveLength(0)
      }
    }
  })

  test('recursive intersections preserve every required constraint and normalize every optional child', async () => {
    const cases = [
      { schema: { type: 'object', properties: { x: { type: 'string' } }, allOf: [{ allOf: [{ required: ['x'] }] }] }, input: { x: null }, expected: { x: null } },
      { schema: { allOf: [{ allOf: [{ type: 'object', properties: { x: { type: 'string' } } }] }] }, input: { x: null }, expected: {} },
      { schema: { type: 'object', properties: { list: { type: 'array', items: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] }, allOf: [{ items: { properties: { x: { type: 'string' }, omit: { type: 'string' } } } }] } } }, input: { list: [{ x: null, omit: null }] }, expected: { list: [{ x: null }] } },
      ...['anyOf', 'oneOf'].map(keyword => ({ schema: { [keyword]: [{ type: 'null' }, { allOf: [{ [keyword]: [{ type: 'null' }, { type: 'object', properties: { x: { type: 'string' } }, allOf: [{ allOf: [{ required: ['x'] }] }] }] }] }] }, input: { x: null }, expected: { x: null } })),
      { schema: { type: 'object', properties: { x: { type: 'string', anyOf: [{ type: 'null' }, { type: 'string' }] }, y: { enum: ['a'], anyOf: [{ type: 'null' }, { type: 'string' }] }, z: { const: 'a', anyOf: [{ type: 'null' }, { type: 'string' }] } } }, input: { x: null, y: null, z: null }, expected: {} },
    ]
    for (const entry of cases) {
      const map = new Map<string, Record<string, unknown>>([['probe', entry.schema]])
      const before = JSON.stringify(entry.schema)
      const text = JSON.stringify(entry.input)
      const result = convertCodexResponseToAnthropicMessage({ output: [item(text)] }, 'codex', map)
      expect((result.content as any[])[0].input).toEqual(entry.expected)
      const stream = await consume(added() + done(text) + terminal, map)
      expect(stream.error).toBeUndefined()
      expect(JSON.parse(stream.inputs.get(0)!)).toEqual(entry.expected)
      expect(JSON.stringify(entry.schema)).toBe(before)
    }
  })

  for (const ending of [terminal, '']) test(`schema-less done payload emits exactly once before legacy stop (${ending ? 'completed' : 'EOF'})`, async () => {
    const event = frame('response.function_call_arguments.done', { item_id: 'item', arguments: '{"x":1}' })
    const result = await consume(added() + event + event + ending, new Map())
    expect(result.error).toBeUndefined()
    expect(result.inputs.get(0)).toBe('{"x":1}')
    expect(result.executable).toHaveLength(1)
  })

  test('cyclic and unresolved constraints are preserved conservatively', () => {
    const cyclic: Record<string, unknown> = { type: 'object', properties: { x: { type: 'string' } } }
    cyclic.allOf = [cyclic]
    const map = new Map([['probe', cyclic]])
    const result = convertCodexResponseToAnthropicMessage({ output: [item('{"x":null}')] }, 'codex', map)
    expect((result.content as any[])[0].input).toEqual({ x: null })
    const reference = new Map([['probe', { properties: { x: { type: 'string', $ref: '#/unknown' } } }]])
    expect((convertCodexResponseToAnthropicMessage({ output: [item('{"x":null}')] }, 'codex', reference).content as any[])[0].input).toEqual({ x: null })
  })

  test('unproved applicability and unsupported assertions preserve potentially required values', async () => {
    const objectBranch = { type: 'object', properties: { kind: { const: 'a' }, x: { type: 'string' } }, required: ['kind', 'x'] }
    const schemasToTest: Record<string, unknown>[] = [
      { anyOf: [{ oneOf: [objectBranch, { type: 'object', properties: { kind: { const: 'b' } }, required: ['kind'] }] }, { type: 'object', properties: { x: { type: 'string' } } }] },
      ...[
        { if: { properties: { kind: { const: 'a' } } }, then: { required: ['x'] } },
        { if: { properties: { kind: { const: 'b' } } }, else: { required: ['x'] } },
        { dependentRequired: { kind: ['x'] } },
        { dependentSchemas: { kind: { required: ['x'] } } },
        { dependencies: { kind: ['x'] } },
        { not: { not: { required: ['x'] } } },
      ].map(assertion => ({ type: 'object', properties: { kind: { type: 'string' }, x: { type: 'string' } }, ...assertion })),
    ]
    const cases = schemasToTest.map(schema => ({ schema, input: { kind: 'a', x: null } as unknown }))
    cases.push({ schema: { properties: { list: { anyOf: [{ oneOf: [{ type: 'array', items: objectBranch }, { type: 'array', items: { properties: { kind: { const: 'b' } } } }] }, { type: 'array', items: { properties: { x: { type: 'string' } } } }] } } }, input: { list: [{ kind: 'a', x: null }] } })
    for (const { schema, input } of cases) {
      const map = new Map([['probe', schema]])
      const text = JSON.stringify(input)
      const nonstream = convertCodexResponseToAnthropicMessage({ output: [item(text)] }, 'codex', map)
      expect((nonstream.content as any[])[0].input).toEqual(input)
      const stream = await consume(added() + done(text) + terminal, map)
      expect(stream.error).toBeUndefined()
      expect(JSON.parse(stream.inputs.get(0)!)).toEqual(input)
    }
  })

  test('aborted calls never stop', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await consume(added() + done() + terminal, schemas, controller.signal)
    expect(result.error).toBeDefined()
    expect(result.executable).toHaveLength(0)
  })

  test('schema-less initial arguments are not duplicated', async () => {
    const result = await consume(added('{}') + done('{}') + terminal, new Map())
    expect(result.error).toBeUndefined()
    expect(result.inputs.get(0)).toBe('{}')
  })

  test('malformed and incomplete nonstream schema-backed calls throw; unknown legacy calls retain raw', () => {
    expect(() => convertCodexResponseToAnthropicMessage({ output: [item('{')] }, 'codex', schemas)).toThrow()
    expect(() => convertCodexResponseToAnthropicMessage({ output: [{ ...item(), status: 'in_progress' }] }, 'codex', schemas)).toThrow()
    expect(() => convertCodexResponseToAnthropicMessage({ status: 'incomplete', output: [item()] }, 'codex', schemas)).toThrow()
    const result = convertCodexResponseToAnthropicMessage({ output: [item('{')] }, 'codex')
    expect((result.content as any[])[0].input).toEqual({ raw: '{' })
  })
})
