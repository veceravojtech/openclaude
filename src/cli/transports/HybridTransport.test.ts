import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  mock,
  test,
} from 'bun:test'
import type { StdoutMessage } from 'src/entrypoints/sdk/controlTypes.js'
import * as realAxios from 'axios'

// Snapshot taken before any mock.module() call. mock.module() mutates the live
// namespace object in place, so restoring from the namespace (or from a spread
// of it) would re-install the stub instead of undoing it.
const pristineRealAxios = { ...realAxios }
const realAxiosDefault = pristineRealAxios.default

type AxiosPost = (
  url: string,
  data?: unknown,
  config?: unknown,
) => Promise<{ status: number }>

let postImpl: AxiosPost = async () => ({ status: 200 })

// Only `post` is redirected. The factory it replaces returned `{ default: {
// post } }`, which erased seventeen named axios exports and thirty-four members
// of the default export for every file loaded afterwards. Object.assign onto a
// forwarding function keeps the default export callable as well as indexable.
const axiosDefaultStub = Object.assign(
  function axiosStub(...args: unknown[]): unknown {
    return (realAxiosDefault as unknown as (...a: unknown[]) => unknown)(...args)
  },
  realAxiosDefault,
  {
    post: (...args: Parameters<AxiosPost>) => postImpl(...args),
  },
)

mock.module('axios', () => ({
  ...pristineRealAxios,
  default: axiosDefaultStub,
}))

afterAll(() => {
  // mock.restore() does NOT undo mock.module(); re-register axios from its
  // pre-mock snapshot.
  mock.module('axios', () => ({ ...pristineRealAxios }))
})

describe('HybridTransport close', () => {
  let originalSessionAccessToken: string | undefined

  beforeEach(() => {
    originalSessionAccessToken = process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN
    process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN = 'test-token'
  })

  afterEach(() => {
    if (originalSessionAccessToken === undefined) {
      delete process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN
    } else {
      process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN = originalSessionAccessToken
    }
    postImpl = async () => ({ status: 200 })
    jest.restoreAllMocks()
  })

  test('drains buffered stream events before closing the uploader', async () => {
    const posts: Array<{ url: string; data: unknown }> = []
    postImpl = async (url, data) => {
      posts.push({ url, data })
      return { status: 200 }
    }
    const transport = await createTransport()
    const streamEvent: StdoutMessage = {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hello' },
      },
    }

    await transport.write(streamEvent)
    await transport.close()

    expect(posts).toEqual([
      {
        url: 'https://example.com/v2/session_ingress/session/session-1/events',
        data: { events: [streamEvent] },
      },
    ])
  })

  test('uses a close grace period when the final upload stalls', async () => {
    jest.useFakeTimers()
    try {
      postImpl = async () => new Promise(() => {})
      const transport = await createTransport({ closeGraceMs: 1 })

      const writePromise = transport.write({
        type: 'result',
        subtype: 'success',
        duration_ms: 0,
        duration_api_ms: 0,
        is_error: false,
        result: 'ok',
        session_id: 'session-1',
      })
      const closePromise = transport.close().then(() => 'closed' as const)

      expect(await settledValue(closePromise)).toBe('pending')

      jest.advanceTimersByTime(1)
      await expect(closePromise).resolves.toBe('closed')
      await expect(writePromise).resolves.toBeUndefined()
    } finally {
      jest.useRealTimers()
    }
  })

  test('clears the close grace timer when the final upload finishes first', async () => {
    jest.useFakeTimers()
    try {
      const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout')
      const clearTimeoutSpy = jest.spyOn(globalThis, 'clearTimeout')
      const transport = await createTransport({ closeGraceMs: 50 })

      await transport.write({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'hello' },
        },
      })
      await transport.close()

      const closeGraceCallIndex = setTimeoutSpy.mock.calls.findIndex(
        call => call[1] === 50,
      )
      expect(closeGraceCallIndex).toBeGreaterThanOrEqual(0)
      const closeGraceTimer =
        setTimeoutSpy.mock.results[closeGraceCallIndex]?.value
      expect(
        clearTimeoutSpy.mock.calls.some(call => call[0] === closeGraceTimer),
      ).toBe(true)
    } finally {
      jest.useRealTimers()
    }
  })

  test('still drains and closes the uploader when the websocket close fails', async () => {
    const { WebSocketTransport } = await import('./WebSocketTransport.js')
    const closeError = new Error('websocket close failed')
    jest
      .spyOn(WebSocketTransport.prototype, 'close')
      .mockRejectedValueOnce(closeError)

    const posts: Array<{ url: string; data: unknown }> = []
    postImpl = async (url, data) => {
      posts.push({ url, data })
      return { status: 200 }
    }
    const transport = await createTransport()
    const streamEvent: StdoutMessage = {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'must still post' },
      },
    }

    await transport.write(streamEvent)

    await expect(transport.close()).rejects.toBe(closeError)
    expect(posts).toEqual([
      {
        url: 'https://example.com/v2/session_ingress/session/session-1/events',
        data: { events: [streamEvent] },
      },
    ])
  })

  test('preserves websocket close errors when uploader close also fails', async () => {
    const { WebSocketTransport } = await import('./WebSocketTransport.js')
    const { SerialBatchEventUploader } = await import(
      './SerialBatchEventUploader.js'
    )
    const closeError = new Error('websocket close failed')
    const uploaderError = new Error('uploader close failed')
    jest
      .spyOn(WebSocketTransport.prototype, 'close')
      .mockRejectedValueOnce(closeError)
    jest
      .spyOn(SerialBatchEventUploader.prototype, 'close')
      .mockImplementationOnce(() => {
        throw uploaderError
      })

    const transport = await createTransport()

    await expect(transport.close()).rejects.toBe(closeError)
  })

  test('surfaces uploader close errors when websocket close succeeds', async () => {
    const { SerialBatchEventUploader } = await import(
      './SerialBatchEventUploader.js'
    )
    const uploaderError = new Error('uploader close failed')
    jest
      .spyOn(SerialBatchEventUploader.prototype, 'close')
      .mockImplementationOnce(() => {
        throw uploaderError
      })

    const transport = await createTransport()

    await expect(transport.close()).rejects.toBe(uploaderError)
  })
})

async function createTransport(options?: { closeGraceMs?: number }) {
  const { HybridTransport } = await import('./HybridTransport.js')
  return new HybridTransport(
    new URL('wss://example.com/v2/session_ingress/ws/session-1'),
    {},
    'session-1',
    undefined,
    options,
  )
}

async function settledValue<T>(promise: Promise<T>): Promise<T | 'pending'> {
  const pending = Symbol('pending')
  const result = await Promise.race([promise, Promise.resolve(pending)])
  return result === pending ? 'pending' : result
}
