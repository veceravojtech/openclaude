import { expect, test } from 'bun:test'
import { redactFailureDetail } from './teammateFailureReasons.js'
import { redactLikelySecrets, redactSensitiveInfo } from '../redaction.js'

// Provider errors embed request/response bodies as JSON strings inside JSON
// strings, so a credential field arrives with its quotes backslash-escaped at
// any depth. Every named-field pattern must match all of them, keep the
// surrounding text, and keep the closing quote (and its escaping).

const esc = (level: number, s: string): string =>
  s.replaceAll('"', '\\'.repeat(level) + '"')

const FIELDS: Array<[string, string]> = [
  ['chatgpt-account-id', 'acct-123abcXYZ'],
  ['api_key', 'ak_SECRETVALUE_1'],
  ['api-key', 'ak_SECRETVALUE_2'],
  ['apiKey', 'ak_SECRETVALUE_3'],
  ['x-api-key', 'xk_SECRETVALUE_4'],
  ['authorization', 'Bearer abc.SECRETVALUE.5'],
  ['access_token', 'at_SECRETVALUE_6'],
  ['refresh_token', 'rt_SECRETVALUE_7'],
  ['id_token', 'it_SECRETVALUE_8'],
  ['client_secret', 'cs_SECRETVALUE_9'],
  ['password', 'pw_SECRETVALUE_10'],
  ['secret', 'sc_SECRETVALUE_11'],
]
const SECRET_PARTS = ['acct-123abcXYZ', 'SECRETVALUE']

for (const level of [0, 1, 2]) {
  for (const [field, value] of FIELDS) {
    test(`${field} at ${level} levels of escaping is redacted, text and quotes intact`, () => {
      const body = esc(level, `{"model":"gpt","${field}":"${value}","after":"keep-me"}`)
      const input = `API Error: 400 before ${body} tail`
      const out = redactFailureDetail(input)
      for (const secret of SECRET_PARTS) expect(out).not.toContain(secret)
      expect(out).toContain('API Error: 400 before ')
      expect(out).toContain(' tail')
      expect(out).toContain('keep-me')
      expect(out).toContain(esc(level, '"model":"gpt"'))
      // The closing quote and its escaping survive: `"field":"[REDACTED]"`.
      expect(out).toContain(esc(level, `"${field}":"[REDACTED]"`))
    })
  }
}

test('the exact lead repro is redacted', () => {
  const out = redactFailureDetail(
    'API Error: 400 {"message":"body {\\"chatgpt-account-id\\":\\"acct-123\\"}"}',
  )
  expect(out).not.toContain('acct-123')
  expect(out).toBe(
    'API Error: 400 {"message":"body {\\"chatgpt-account-id\\":\\"[REDACTED]\\"}"}',
  )
})

test('a double-encoded body (JSON string of a JSON string) is redacted', () => {
  const inner = JSON.stringify({ api_key: 'ak_SECRETVALUE_x', 'chatgpt-account-id': 'acct-9zzzz9zz', ok: 1 })
  const middle = JSON.stringify({ message: inner })
  const outer = JSON.stringify({ error: { message: middle } })
  const out = redactFailureDetail(`API Error: ${outer}`)
  expect(out).not.toContain('SECRETVALUE')
  expect(out).not.toContain('acct-9zzzz9zz')
  expect(out).toContain('API Error: ')
  expect(out).toContain('ok')
})

test('values outside any named field are still swept', () => {
  const out = redactFailureDetail(
    'saw acct-12345678 then eyJhbGciOiJIUzI1NiJ9.e30.sig and ghp_abcdefghijklmnopqrstu plus sk-ant-api03-abcdefghijklmnop and AIzaSyabcdefghijklmnopqrstuv and sk-proj-abcdefghijklmnopqrstuvwxyz',
  )
  for (const secret of ['acct-12345678', 'eyJhbGci', 'ghp_abcdef', 'sk-ant-api03', 'AIzaSy', 'sk-proj-abc']) {
    expect(out).not.toContain(secret)
  }
  expect(out).toContain('saw ')
})

test('a backslash inside a secret value does not end the redaction early', () => {
  const out = redactFailureDetail('x {\\"password\\":\\"pa\\\\ss\\\\word\\",\\"keep\\":1} y')
  expect(out).not.toContain('pa\\\\ss')
  expect(out).not.toContain('ss\\\\word')
  expect(out).toContain('\\"password\\":\\"[REDACTED]\\"')
  expect(out).toContain('keep')
})

test('plain, unescaped text keeps working: header form and env form', () => {
  expect(redactFailureDetail('Authorization: Bearer SECRETVALUE.abc here')).not.toContain('SECRETVALUE')
  expect(redactFailureDetail('x-api-key: SECRETVALUE done')).not.toContain('SECRETVALUE')
  expect(redactFailureDetail('OPENAI_API_KEY=SECRETVALUE done')).not.toContain('SECRETVALUE')
  expect(redactFailureDetail('nothing secret here, model=gpt-4o')).toBe('nothing secret here, model=gpt-4o')
})

// The fix lives in the shared scrubber, so every other caller gets it too.
test('the shared scrubbers redact escaped fields as well', () => {
  const escaped = 'log {\\"api_key\\":\\"SECRETVALUE\\",\\"n\\":1} end'
  expect(redactSensitiveInfo(escaped)).toBe('log {\\"api_key\\":\\"[REDACTED]\\",\\"n\\":1} end')
  expect(redactLikelySecrets(escaped)).not.toContain('SECRETVALUE')
})

// Cookie / Set-Cookie and env-var-style names go through the same escaped-quote
// helpers as the other field patterns.
const LEVELS = [0, 1, 2]

for (const level of LEVELS) {
  test(`Cookie and Set-Cookie JSON fields at ${level} levels of escaping are redacted`, () => {
    for (const field of ['cookie', 'Cookie', 'set-cookie', 'Set-Cookie']) {
      const body = esc(level, `{"a":"keep-a","${field}":"sid=SECRETCOOKIE; Path=/; Secure","b":"keep-b"}`)
      const out = redactFailureDetail(`before ${body} after`)
      expect(out).not.toContain('SECRETCOOKIE')
      expect(out).toContain('before ')
      expect(out).toContain(' after')
      expect(out).toContain('keep-a')
      expect(out).toContain('keep-b')
      expect(out).toContain(esc(level, `"${field}":"[REDACTED]"`))
    }
  })

  test(`known and generic env-var names as JSON fields at ${level} levels of escaping are redacted`, () => {
    for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'MY_SERVICE_TOKEN', 'DB_PASSWORD']) {
      const body = esc(level, `{"a":"keep-a","${name}":"SECRETENV","b":"keep-b"}`)
      const out = redactFailureDetail(`before ${body} after`)
      expect(out).not.toContain('SECRETENV')
      expect(out).toContain('keep-a')
      expect(out).toContain('keep-b')
      expect(out).toContain(esc(level, `"${name}":"[REDACTED]"`))
    }
  })
}

test('Cookie, Set-Cookie and env-var header/assignment lines are redacted with surrounding text kept', () => {
  const cookie = redactFailureDetail('req Cookie: sid=SECRETCOOKIE; Path=/; Secure')
  expect(cookie).not.toContain('SECRETCOOKIE')
  expect(cookie).toContain('req Cookie: ')
  const setCookie = redactFailureDetail('res Set-Cookie: sid=SECRETCOOKIE; HttpOnly')
  expect(setCookie).not.toContain('SECRETCOOKIE')
  expect(setCookie).toContain('res Set-Cookie: ')
  const env = redactFailureDetail('env OPENAI_API_KEY=SECRETENV then more text')
  expect(env).not.toContain('SECRETENV')
  expect(env).toContain('env OPENAI_API_KEY=')
  const quoted = redactFailureDetail('env OPENAI_API_KEY="SECRETENV" then more text')
  expect(quoted).not.toContain('SECRETENV')
  expect(quoted).toContain(' then more text')
})

// The shared scrubber has many callers (logs, bug reports, transcript shares):
// non-secret input must come out exactly as it went in.
test('Windows paths, regexes and escaped bodies without secrets come out unchanged', () => {
  const inputs = [
    'C:\\Users\\me\\proj\\file.ts',
    'C:\\\\Users\\\\me\\\\proj\\\\file.ts',
    'error at C:\\Users\\me\\proj\\src\\index.ts:12:5 (cookie jar empty, token count 3)',
    'API Error: 400 {"message":"body {\\"model\\":\\"gpt-4o\\",\\"n\\":1,\\"stream\\":false}"}',
    'API Error: 400 {\\"error\\":{\\"type\\":\\"invalid_request\\",\\"message\\":\\"bad field\\"}}',
    'regex /^\\s*(\\w+)\\\\"\\d+$/g did not match',
    'grep -E "foo|bar" src\\\\a.ts path=\\"C:\\\\tmp\\\\x\\"',
  ]
  for (const input of inputs) {
    expect(redactSensitiveInfo(input)).toBe(input)
    expect(redactLikelySecrets(input)).toBe(input)
    expect(redactFailureDetail(input)).toBe(input)
  }
})

// A value that contains its own quote, escaped more deeply than the opening
// quote, is part of the value: it must be redacted whole.
test('a value containing its own deeper-escaped quote is redacted whole', () => {
  const cases: Array<[string, string]> = [
    [
      String.raw`{\"password\":\"pa\\ss\\\"word\",\"k\":1}`,
      String.raw`{\"password\":\"[REDACTED]\",\"k\":1}`,
    ],
    [
      String.raw`{"password":"pa\"ss\"word","k":1}`,
      String.raw`{"password":"[REDACTED]","k":1}`,
    ],
    [
      String.raw`{\\\"api_key\\\":\\\"ab\\\\\\\"cd\\\",\\\"k\\\":1}`,
      String.raw`{\\\"api_key\\\":\\\"[REDACTED]\\\",\\\"k\\\":1}`,
    ],
    [
      String.raw`OPENAI_API_KEY="ab\"cd" tail`,
      String.raw`OPENAI_API_KEY="[REDACTED]" tail`,
    ],
  ]
  for (const [input, expected] of cases) {
    expect(redactFailureDetail(input)).toBe(expected)
    expect(redactSensitiveInfo(input)).toBe(expected)
  }
})

test('spaces, commas and semicolons inside a quoted value do not end the redaction', () => {
  const out = redactFailureDetail(
    String.raw`{\"password\":\"two words, a;b&c#d\",\"k\":1} OPENAI_API_KEY="my secret key" end`,
  )
  expect(out).toBe(
    String.raw`{\"password\":\"[REDACTED]\",\"k\":1} OPENAI_API_KEY="[REDACTED]" end`,
  )
})

// Some serializers write quotes as \u0022 / \u0027.
test('\\u0022 and \\u0027 quotes are recognised, at any escaping depth', () => {
  const cases: Array<[string, string]> = [
    [
      String.raw`{\u0022api_key\u0022:\u0022SECRETVAL\u0022,\u0022k\u0022:1}`,
      String.raw`{\u0022api_key\u0022:\u0022[REDACTED]\u0022,\u0022k\u0022:1}`,
    ],
    [
      String.raw`{\\u0022access_token\\u0022:\\u0022SECRETVAL\\u0022,\\u0022k\\u0022:1}`,
      String.raw`{\\u0022access_token\\u0022:\\u0022[REDACTED]\\u0022,\\u0022k\\u0022:1}`,
    ],
    [
      String.raw`{\u0027password\u0027:\u0027SECRETVAL\u0027,\u0027k\u0027:1}`,
      String.raw`{\u0027password\u0027:\u0027[REDACTED]\u0027,\u0027k\u0027:1}`,
    ],
    [
      String.raw`{\u0022cookie\u0022:\u0022sid=SECRETVAL; a=b\u0022,\u0022k\u0022:1}`,
      String.raw`{\u0022cookie\u0022:\u0022[REDACTED]\u0022,\u0022k\u0022:1}`,
    ],
    [
      String.raw`{\u0022OPENAI_API_KEY\u0022:\u0022SECRETVAL\u0022}`,
      String.raw`{\u0022OPENAI_API_KEY\u0022:\u0022[REDACTED]\u0022}`,
    ],
    [
      String.raw`{\u0022chatgpt-account-id\u0022:\u0022acct-SECRETVAL\u0022}`,
      String.raw`{\u0022chatgpt-account-id\u0022:\u0022[REDACTED]\u0022}`,
    ],
  ]
  for (const [input, expected] of cases) {
    const out = redactFailureDetail(input)
    expect(out).toBe(expected)
    expect(out).not.toContain('SECRETVAL')
  }
})

// A value that ends in a backslash must not eat its own closing quote.
test('a quoted value ending in a backslash keeps its closing quote and the next field', () => {
  const cases: Array<[string, string]> = [
    // depth 0
    [String.raw`{"password":"C:\\temp\\","model":"gpt"}`, String.raw`{"password":"[REDACTED]","model":"gpt"}`],
    // depth 1
    [String.raw`{\"password\":\"C:\\\\temp\\\\\",\"model\":\"gpt\"}`, String.raw`{\"password\":\"[REDACTED]\",\"model\":\"gpt\"}`],
    // depth 3
    [String.raw`{\\\"api_key\\\":\\\"a\\\\\\\\b\\\\\\\\\\\",\\\"model\\\":\\\"gpt\\\"}`, String.raw`{\\\"api_key\\\":\\\"[REDACTED]\\\",\\\"model\\\":\\\"gpt\\\"}`],
    // \u0022 quotes
    [String.raw`{\u0022password\u0022:\u0022C:\\temp\\\u0022,\u0022m\u0022:1}`, String.raw`{\u0022password\u0022:\u0022[REDACTED]\u0022,\u0022m\u0022:1}`],
    // an escaped quote followed by an escaped backslash is still inside the value
    [String.raw`{"password":"a\"b\\","m":1}`, String.raw`{"password":"[REDACTED]","m":1}`],
  ]
  for (const [input, expected] of cases) {
    expect(redactFailureDetail(input)).toBe(expected)
    expect(redactSensitiveInfo(input)).toBe(expected)
  }
})

// A value ends only at its own kind of quote.
test('the other quote character inside a quoted value does not end it', () => {
  const cases: Array<[string, string]> = [
    [String.raw`{"password":"don't-leak-me","m":1}`, String.raw`{"password":"[REDACTED]","m":1}`],
    [String.raw`{\"password\":\"don't-leak-me\",\"m\":1}`, String.raw`{\"password\":\"[REDACTED]\",\"m\":1}`],
    [String.raw`{"api_key":"a'b'c","m":1}`, String.raw`{"api_key":"[REDACTED]","m":1}`],
    [String.raw`{\"api_key\":\"a'b'c\",\"m\":1}`, String.raw`{\"api_key\":\"[REDACTED]\",\"m\":1}`],
    [String.raw`{"cookie":"sid=a'b; x=y","m":1}`, String.raw`{"cookie":"[REDACTED]","m":1}`],
    [String.raw`{\"cookie\":\"sid=a'b; x=y\",\"m\":1}`, String.raw`{\"cookie\":\"[REDACTED]\",\"m\":1}`],
    [String.raw`OPENAI_API_KEY="ab'cd" tail`, String.raw`OPENAI_API_KEY="[REDACTED]" tail`],
    [String.raw`{\"OPENAI_API_KEY\":\"ab'cd\",\"m\":1}`, String.raw`{\"OPENAI_API_KEY\":\"[REDACTED]\",\"m\":1}`],
    // single-quoted values end only at a single quote
    [String.raw`{'password':'say "hi" now','m':1}`, String.raw`{'password':'[REDACTED]','m':1}`],
    [String.raw`{\'password\':\'say \"hi\" now\',\'m\':1}`, String.raw`{\'password\':\'[REDACTED]\',\'m\':1}`],
    [String.raw`{\u0027password\u0027:\u0027say "hi" now\u0027,\u0027m\u0027:1}`, String.raw`{\u0027password\u0027:\u0027[REDACTED]\u0027,\u0027m\u0027:1}`],
  ]
  for (const [input, expected] of cases) {
    expect(redactFailureDetail(input)).toBe(expected)
    expect(redactSensitiveInfo(input)).toBe(expected)
    expect(redactFailureDetail(input)).not.toContain('leak-me')
  }
})

// Regression: a dotenv-style quoted value with an apostrophe in it was redacted
// whole on main (`OPENAI_API_KEY=[REDACTED]`) and leaked `'cdSECRET123` once
// the scanner ended values at ANY quote character.
test('apostrophe-in-value regressions: nothing after the apostrophe survives, closing quote and tail do', () => {
  const cases: Array<[string, string]> = [
    [String.raw`{"password":"it's a secret","u":1}`, String.raw`{"password":"[REDACTED]","u":1}`],
    [String.raw`{\"password\":\"it's a secret\",\"u\":1}`, String.raw`{\"password\":\"[REDACTED]\",\"u\":1}`],
    [String.raw`{\\\"password\\\":\\\"it's a secret\\\"}`, String.raw`{\\\"password\\\":\\\"[REDACTED]\\\"}`],
    [String.raw`{"api_key":"ab'cdSECRET123","u":1}`, String.raw`{"api_key":"[REDACTED]","u":1}`],
    [String.raw`{\"api_key\":\"ab'cdSECRET123\"}`, String.raw`{\"api_key\":\"[REDACTED]\"}`],
    [String.raw`Cookie: "sid=ab'cdSECRET; theme=dark"`, String.raw`Cookie: "[REDACTED]"`],
    [String.raw`{\"cookie\":\"sid=ab'cdSECRET; x=1\"}`, String.raw`{\"cookie\":\"[REDACTED]\"}`],
    [String.raw`OPENAI_API_KEY="ab'cdSECRET123"`, String.raw`OPENAI_API_KEY="[REDACTED]"`],
    [String.raw`{\"OPENAI_API_KEY\":\"ab'cdSECRET123\"}`, String.raw`{\"OPENAI_API_KEY\":\"[REDACTED]\"}`],
    // reverse case: a double quote inside a single-quoted value
    [String.raw`{'password': 'say "hi" SECRET'}`, String.raw`{'password': '[REDACTED]'}`],
    [String.raw`{\u0022password\u0022:\u0022it's a secret\u0022}`, String.raw`{\u0022password\u0022:\u0022[REDACTED]\u0022}`],
  ]
  for (const [input, expected] of cases) {
    for (const fn of [redactSensitiveInfo, redactLikelySecrets, redactFailureDetail]) {
      const out = fn(input)
      expect(out).toBe(expected)
      expect(out).not.toContain('s a secret')
      expect(out).not.toContain('cdSECRET')
      expect(out).not.toContain('SECRET')
    }
  }
})

// An unterminated quoted value runs to the end of ITS line, never into the next.
test('an unterminated quoted value stops at the end of its line', () => {
  const input = 'a {"password":"unterminated value\nnext line keeps "u":1 and token count 3'
  const out = redactSensitiveInfo(input)
  expect(out).toBe('a {"password":"[REDACTED]\nnext line keeps "u":1 and token count 3')
  expect(out).not.toContain('unterminated')
  for (const fn of [redactLikelySecrets, redactFailureDetail]) {
    expect(fn(input)).toContain('\nnext line keeps "u":1 and token count 3')
  }
})

test('private_key PEM blocks are still redacted whole, in text and in JSON', () => {
  const pem = 'private_key: -----BEGIN RSA PRIVATE KEY-----\nAAAA\nBBBB\n-----END RSA PRIVATE KEY----- after'
  // (the generic field pass then takes the rest of the line, as it always did)
  expect(redactSensitiveInfo(pem)).toBe('private_key: [REDACTED]')
  expect(redactSensitiveInfo(pem)).not.toContain('AAAA')
  const json = '{"private_key":"-----BEGIN PRIVATE KEY-----\\nAAAA\\n-----END PRIVATE KEY-----\\n","m":1}'
  const out = redactSensitiveInfo(json)
  expect(out).not.toContain('AAAA')
  expect(out).toContain('"m":1')
  // Two blocks: each is redacted on its own, the text between them is kept.
  const two = 'private_key: -----BEGIN A PRIVATE KEY----- x -----END A PRIVATE KEY----- mid private_key: -----BEGIN B PRIVATE KEY----- y -----END B PRIVATE KEY----- end'
  const twoOut = redactSensitiveInfo(two)
  expect(twoOut).not.toContain('PRIVATE KEY')
  expect(twoOut).not.toContain(' x ')
  expect(twoOut).not.toContain(' y ')
  expect(twoOut.startsWith('private_key: [REDACTED]')).toBe(true)
})

// CI-style prefixed names: the AWS_/GOOGLE_ segment need not start the name.
test('prefixed AWS_/GOOGLE_ names are redacted, with quotes and surrounding text kept', () => {
  const cases: Array<[string, string]> = [
    ['X_AWS_FOO=bar', 'X_AWS_FOO=[REDACTED]'],
    ['STAGING_AWS_SECRET_ACCESS_KEY=wJalrSECRET tail', 'STAGING_AWS_SECRET_ACCESS_KEY=[REDACTED] tail'],
    ['CI_AWS_SECRET_ACCESS_KEY: "wJalrSECRET" tail', 'CI_AWS_SECRET_ACCESS_KEY: "[REDACTED]" tail'],
    ['{"PROD_AWS_SECRET_ACCESS_KEY":"wJalrSECRET","u":1}', '{"PROD_AWS_SECRET_ACCESS_KEY":"[REDACTED]","u":1}'],
    [String.raw`{\"PROD_AWS_SECRET_ACCESS_KEY\":\"wJalrSECRET\",\"u\":1}`, String.raw`{\"PROD_AWS_SECRET_ACCESS_KEY\":\"[REDACTED]\",\"u\":1}`],
    ['DEV_GOOGLE_CLIENT_SECRET_JSON=SECRETJSON tail', 'DEV_GOOGLE_CLIENT_SECRET_JSON=[REDACTED] tail'],
    ['AWS_SECRET_ACCESS_KEY=wJalrSECRET tail', 'AWS_SECRET_ACCESS_KEY=[REDACTED] tail'],
  ]
  for (const [input, expected] of cases) {
    expect(redactSensitiveInfo(input)).toBe(expected)
    expect(redactFailureDetail(input)).toBe(expected)
    expect(redactFailureDetail(input)).not.toMatch(/wJalr|SECRETJSON|=bar/)
  }
})

// A secret is found wherever it sits: a leading label must never swallow the
// field that follows it. `Error: AWS_SECRET_ACCESS_KEY=...` (head `Error: `)
// leaked because a rejected head used to consume its whole value.
const SECRET_INPUTS: Array<[string, RegExp]> = [
  // AWS / Google, prefixed or not
  ['AWS_SECRET_ACCESS_KEY=wJalrSECRETKEY', /wJalrSECRETKEY/],
  ['X_AWS_FOO=wJalrSECRETKEY', /wJalrSECRETKEY/],
  ['STAGING_AWS_SECRET_ACCESS_KEY=wJalrSECRETKEY', /wJalrSECRETKEY/],
  ['CI_AWS_SECRET_ACCESS_KEY: "wJalrSECRETKEY"', /wJalrSECRETKEY/],
  ['{"PROD_AWS_SECRET_ACCESS_KEY":"wJalrSECRETKEY","u":1}', /wJalrSECRETKEY/],
  [String.raw`{\"PROD_AWS_SECRET_ACCESS_KEY\":\"wJalrSECRETKEY\",\"u\":1}`, /wJalrSECRETKEY/],
  ['DEV_GOOGLE_CLIENT_SECRET_JSON=wJalrSECRETKEY', /wJalrSECRETKEY/],
  // the apostrophe probes
  [String.raw`{"password":"it's a secret","u":1}`, /s a secret/],
  [String.raw`{\"password\":\"it's a secret\",\"u\":1}`, /s a secret/],
  [String.raw`{\\\"password\\\":\\\"it's a secret\\\"}`, /s a secret/],
  [String.raw`{"api_key":"ab'cdSECRET123","u":1}`, /cdSECRET/],
  [String.raw`{\"api_key\":\"ab'cdSECRET123\"}`, /cdSECRET/],
  [String.raw`Cookie: "sid=ab'cdSECRET; theme=dark"`, /cdSECRET/],
  [String.raw`{\"cookie\":\"sid=ab'cdSECRET; x=1\"}`, /cdSECRET/],
  [String.raw`OPENAI_API_KEY="ab'cdSECRET123"`, /cdSECRET/],
  [String.raw`{\"OPENAI_API_KEY\":\"ab'cdSECRET123\"}`, /cdSECRET/],
  [String.raw`{'password': 'say "hi" SECRET'}`, /SECRET/],
  [String.raw`{\u0022password\u0022:\u0022it's a secret\u0022}`, /s a secret/],
  // generic env, headers, cookies, account ids
  ['MY_SERVICE_TOKEN=tokSECRETVALUE', /tokSECRETVALUE/],
  ['DB_PASSWORD=pwSECRETVALUE', /pwSECRETVALUE/],
  ['ANTHROPIC_API_KEY=akSECRETVALUE', /akSECRETVALUE/],
  ['Authorization: Bearer abc.SECRETVALUE.5', /SECRETVALUE/],
  ['x-api-key: xkSECRETVALUE', /xkSECRETVALUE/],
  ['Cookie: sid=cookSECRETVALUE; Path=/', /cookSECRETVALUE/],
  ['Set-Cookie: sid=cookSECRETVALUE; HttpOnly', /cookSECRETVALUE/],
  ['{"chatgpt-account-id":"acct-SECRETACCT99"}', /SECRETACCT99/],
  ['chatgpt-account-id: acct-SECRETACCT99', /SECRETACCT99/],
]
const LABELS: Array<[string, string, string]> = [
  // [label before, text after, label that must survive]
  ['Error: ', '', 'Error: '],
  ['x=', '', 'x='],
  ['FOO=', '', 'FOO='],
  ['--env=', '', '--env='],
  ['cfg: "', '"', 'cfg: "'],
  ['x: y: ', '', 'x: y: '],
  [String.raw`\"msg\":\"`, String.raw`\"`, String.raw`\"msg\":\"`],
  // a label that is itself a (non-credential) field with an unquoted value
  ['note: ', ' trailing text', 'note: '],
]

test('a secret is redacted wherever it sits: leading labels never swallow it', () => {
  let checked = 0
  for (const [secretInput, secret] of SECRET_INPUTS) {
    for (const [before, after, kept] of LABELS) {
      const input = `${before}${secretInput}${after}`
      for (const fn of [redactSensitiveInfo, redactLikelySecrets, redactFailureDetail]) {
        const out = fn(input)
        if (secret.test(out)) throw new Error(`${fn.name} leaked on ${JSON.stringify(input)} -> ${JSON.stringify(out)}`)
        if (!out.includes(kept)) throw new Error(`${fn.name} lost its label on ${JSON.stringify(input)} -> ${JSON.stringify(out)}`)
        checked++
      }
    }
  }
  expect(checked).toBe(SECRET_INPUTS.length * LABELS.length * 3)
})

test('the five labelled AWS rows, pinned explicitly', () => {
  const rows: Array<[string, string]> = [
    ['Error: AWS_SECRET_ACCESS_KEY=wJalrSECRETKEY', 'Error: AWS_SECRET_ACCESS_KEY=[REDACTED]'],
    ['FOO=AWS_SECRET_ACCESS_KEY=wJalrSECRETKEY', 'FOO=AWS_SECRET_ACCESS_KEY=[REDACTED]'],
    ['env: STAGING_AWS_SECRET_ACCESS_KEY=wJalrSECRETKEY', 'env: STAGING_AWS_SECRET_ACCESS_KEY=[REDACTED]'],
    ['--env=STAGING_AWS_SECRET_ACCESS_KEY=wJalrSECRETKEY', '--env=STAGING_AWS_SECRET_ACCESS_KEY=[REDACTED]'],
    ['cfg: "STAGING_AWS_SECRET_ACCESS_KEY=wJalrSECRETKEY"', 'cfg: "STAGING_AWS_SECRET_ACCESS_KEY=[REDACTED]"'],
  ]
  for (const [input, expected] of rows) {
    expect(redactSensitiveInfo(input)).toBe(expected)
    expect(redactFailureDetail(input)).toBe(expected)
  }
})

// Skipping a rejected head must not make repeated heads quadratic.
test('a long chain of rejected heads stays linear', () => {
  for (const input of ['a=b='.repeat(50_000), 'x: '.repeat(80_000), 'Error: '.repeat(40_000) + 'AWS_SECRET_ACCESS_KEY=wJalrSECRETKEY']) {
    for (const fn of [redactSensitiveInfo, redactLikelySecrets, redactFailureDetail]) {
      const start = performance.now()
      const out = fn(input)
      expect(performance.now() - start).toBeLessThan(500)
      expect(out).not.toContain('wJalrSECRETKEY')
    }
  }
})

// Truncated keys inside a JSON string end at that string's closing quote.
// YAML/TOML-style raw multi-line quoted strings: the first raw line break says
// nothing about where the key ends.
test('a truncated private_key in a raw multi-line quoted value does not leak its body lines', () => {
  const lines = ['MIIEline1', 'MIIEline2']
  const cases: Array<[string, string]> = [
    // blank line ends the key; the text after it is kept
    ['private_key: "-----BEGIN PRIVATE KEY-----\nMIIEline1\nMIIEline2\n\nafter', 'private_key: "[REDACTED]\n\nafter'],
    ["private_key: '-----BEGIN PRIVATE KEY-----\nMIIEline1\nMIIEline2\n\nafter", "private_key: '[REDACTED]\n\nafter"],
    // no blank line: the key runs to the end of the text (safe side)
    ['private_key: "-----BEGIN PRIVATE KEY-----\nMIIEline1\nMIIEline2"\nafter', 'private_key: "[REDACTED]'],
  ]
  for (const [input, expected] of cases) {
    for (const fn of [redactSensitiveInfo, redactLikelySecrets, redactFailureDetail]) {
      const out = fn(input)
      for (const line of lines) expect(out).not.toContain(line)
    }
    expect(redactSensitiveInfo(input)).toBe(expected)
  }
  // CRLF
  const crlf = redactSensitiveInfo('private_key: "-----BEGIN PRIVATE KEY-----\r\nMIIEline1\r\nMIIEline2\r\n\r\nafter')
  for (const line of lines) expect(crlf).not.toContain(line)
  expect(crlf).toContain('after')
  expect(crlf.startsWith('private_key: "[REDACTED]')).toBe(true)
})

test('a truncated private_key inside JSON ends at its own closing quote, at any depth', () => {
  const cases: Array<[string, string]> = [
    [String.raw`{\"private_key\":\"-----BEGIN PRIVATE KEY-----\\nMIIEBASE64\\n\",\"u\":1}`, String.raw`{\"private_key\":\"[REDACTED]\",\"u\":1}`],
    [String.raw`{\\\"private_key\\\":\\\"-----BEGIN PRIVATE KEY-----\\\\nMIIEBASE64\\\\n\\\",\\\"u\\\":1}`, String.raw`{\\\"private_key\\\":\\\"[REDACTED]\\\",\\\"u\\\":1}`],
    [String.raw`{"private_key":"-----BEGIN PRIVATE KEY-----\nMIIEBASE64\n","u":1}`, String.raw`{"private_key":"[REDACTED]","u":1}`],
    [String.raw`{\u0022private_key\u0022:\u0022-----BEGIN PRIVATE KEY-----\\nMIIEBASE64\\n\u0022,\u0022u\u0022:1}`, String.raw`{\u0022private_key\u0022:\u0022[REDACTED]\u0022,\u0022u\u0022:1}`],
  ]
  for (const [input, expected] of cases) {
    for (const fn of [redactSensitiveInfo, redactLikelySecrets, redactFailureDetail]) {
      expect(fn(input)).toBe(expected)
    }
  }
  // An unquoted truncated key still stops at the blank line.
  expect(redactSensitiveInfo('private_key: -----BEGIN PRIVATE KEY-----\nMIIEBASE64\nMORE\n\nafter blank')).toBe(
    'private_key: [REDACTED]\n\nafter blank',
  )
})

test('long AWS_/GOOGLE_ names are redacted; non-credential words are left alone', () => {
  const aws = redactFailureDetail(`AWS_${'X'.repeat(140)}=awssecretvalue123 tail`)
  expect(aws).not.toContain('awssecretvalue123')
  expect(aws.endsWith('=[REDACTED] tail')).toBe(true)
  const google = redactFailureDetail(`GOOGLE_${'Y'.repeat(200)}=googlesecret tail`)
  expect(google).not.toContain('googlesecret')
  // Unchanged: no AWS_/GOOGLE_ segment in the name (or a word merely containing "aws").
  for (const same of ['MAX_TOKENS=4096', 'LAWS_OF_X=1', 'model=gpt-4o', 'AWSOME=1']) {
    expect(redactSensitiveInfo(same)).toBe(same)
  }
  // main redacts AWS_REGION too (any AWS_-prefixed assignment): keep that.
  expect(redactSensitiveInfo('AWS_REGION=us-east-1')).toBe('AWS_REGION=[REDACTED]')
})

// A private key cut off before its END must not leak its body.
test('a truncated private_key body (BEGIN, no END) is redacted to the blank line, or to the end', () => {
  const body = 'QUJDREVGRw==\nSElKS0xNTg==\nT1BRUlNUVQ=='
  const withBlank = `private_key: -----BEGIN RSA PRIVATE KEY-----\n${body}\n\nafter the blank line, token count 3`
  const out = redactSensitiveInfo(withBlank)
  for (const line of body.split('\n')) expect(out).not.toContain(line)
  expect(out).toBe('private_key: [REDACTED]\n\nafter the blank line, token count 3')
  for (const fn of [redactLikelySecrets, redactFailureDetail]) {
    for (const line of body.split('\n')) expect(fn(withBlank)).not.toContain(line)
  }

  const noBlank = `log: private_key: -----BEGIN PRIVATE KEY-----\n${body}`
  const out2 = redactSensitiveInfo(noBlank)
  expect(out2).toBe('log: private_key: [REDACTED]')

  // Two cut-off keys separated by a blank line: each is redacted, the text
  // between them is kept.
  const two = `private_key: -----BEGIN A PRIVATE KEY-----\nAAAA\n\nmiddle text\nprivate_key: -----BEGIN B PRIVATE KEY-----\nBBBB`
  const twoOut = redactSensitiveInfo(two)
  expect(twoOut).not.toContain('AAAA')
  expect(twoOut).not.toContain('BBBB')
  expect(twoOut).toContain('middle text')
})

test('a real PEM key with an END keeps exactly its old output', () => {
  const pem = 'private_key: -----BEGIN RSA PRIVATE KEY-----\nQUJD\n-----END RSA PRIVATE KEY----- after'
  expect(redactSensitiveInfo(pem)).toBe('private_key: [REDACTED]')
  const json = '{"private_key":"-----BEGIN PRIVATE KEY-----\\nQUJD\\n-----END PRIVATE KEY-----\\n","m":1}'
  const out = redactSensitiveInfo(json)
  expect(out).not.toContain('QUJD')
  expect(out).toContain('"m":1')
})

test('AWS_ names of any length are redacted; a name inside a longer word is left to the generic pattern', () => {
  const long = `AWS_${'X'.repeat(140)}=awssecretvalue123 tail`
  const out = redactFailureDetail(long)
  expect(out).not.toContain('awssecretvalue123')
  expect(out).toContain(' tail')
  expect(redactFailureDetail('MYAWS_SECRET=x tail')).toBe('MYAWS_SECRET=[REDACTED]')
  expect(redactFailureDetail('AWS_SECRET_ACCESS_KEY=abc tail')).toBe('AWS_SECRET_ACCESS_KEY=[REDACTED] tail')
  expect(redactFailureDetail('{\\"AWS_REGION_X\\":\\"secretvalue9\\"}')).not.toContain('secretvalue9')
})

// The scrubber is called synchronously from logs, error sinks, issue reports
// and transcript shares: no input may make it super-linear.
const PERF_BUDGET_MS = 500
const BIG = 100_000
const perfInputs: Array<[string, string, number]> = [
  ['100k backslashes', '\\'.repeat(BIG), PERF_BUDGET_MS],
  ['100k backslashes then a quote', '\\'.repeat(BIG) + '"', PERF_BUDGET_MS],
  ['api_key: then 100k backslashes', 'api_key: ' + '\\'.repeat(BIG), PERF_BUDGET_MS],
  ['"api_key":" then 100k backslashes and x', '"api_key":"' + '\\'.repeat(BIG) + 'x', PERF_BUDGET_MS],
  ['escaped api_key then 100k backslashes', '\\"api_key\\":\\"' + '\\'.repeat(BIG) + 'x', PERF_BUDGET_MS],
  ['100k dashes', '-'.repeat(BIG), PERF_BUDGET_MS],
  ['AWS_ repeated', 'AWS_'.repeat(BIG / 4), PERF_BUDGET_MS],
  ['AWS_ words repeated', 'AWS_X '.repeat(BIG / 6), PERF_BUDGET_MS],
  ['AWS_ x 50k then =v', 'AWS_'.repeat(50_000) + '=v', PERF_BUDGET_MS],
  ['a_ x 100k', 'a_'.repeat(BIG), PERF_BUDGET_MS],
  ['escaped private_key BEGIN, no END, 20k times', '{\\"private_key\\":\\"-----BEGIN '.repeat(20_000), PERF_BUDGET_MS],
  ['quoted BEGIN, no END, blank lines', '{"private_key":"-----BEGIN x\n\n'.repeat(20_000), PERF_BUDGET_MS],
  ['raw quoted multi-line BEGIN, no END, 20k times', 'private_key: "-----BEGIN x\nbody\n'.repeat(20_000), PERF_BUDGET_MS],
  ['raw quoted multi-line BEGIN with blank lines', 'private_key: "-----BEGIN x\nbody\n\n'.repeat(20_000), PERF_BUDGET_MS],
  ['blank-line scan over spaces', 'private_key: -----BEGIN x\n' + ' '.repeat(BIG) + 'y', PERF_BUDGET_MS],
  ['BEGIN with no END and a blank line after each', 'private_key: -----BEGIN x\n\n'.repeat(20_000), PERF_BUDGET_MS],
  ['1 MB of prose', 'The quick brown fox jumps over the lazy dog, then errors. '.repeat(18_000), PERF_BUDGET_MS],
  ['private_key BEGIN with no END, 20k times', 'private_key: -----BEGIN '.repeat(20_000), PERF_BUDGET_MS],
  ['private_key BEGIN, dashes, no END', 'private_key: -----BEGIN ' + '-----END '.repeat(BIG / 9), PERF_BUDGET_MS],
  ['long quoted value ending in many backslashes', '"password":"' + '\\\\'.repeat(BIG / 2) + '"', PERF_BUDGET_MS],
  ['many apostrophes in an open quote', '"password":"' + "'".repeat(BIG), PERF_BUDGET_MS],
  ['\\u0022 repeated', '\\u0022'.repeat(BIG / 6), PERF_BUDGET_MS],
  ['key and deep quotes repeated', '"token":"' + '\\\\\\"'.repeat(BIG / 4), PERF_BUDGET_MS],
  ['unterminated quoted values repeated', 'token:"x '.repeat(BIG / 9), PERF_BUDGET_MS],
  // 1 MB of double-escaped JSON. The sweep already took ~430 ms here before the
  // escaped-quote work; the bound is generous so a loaded CI machine does not
  // flake, and still far below what any super-linear pattern would take.
  ['1 MB of double-escaped JSON', '{\\"a\\":\\"b\\",\\"n\\":1}'.repeat(Math.ceil(1_000_000 / 22)), 1500],
]
for (const [name, input, budget] of perfInputs) {
  for (const [fnName, fn] of [
    ['redactSensitiveInfo', redactSensitiveInfo],
    ['redactLikelySecrets', redactLikelySecrets],
    ['redactFailureDetail', redactFailureDetail],
  ] as const) {
    test(`stays linear: ${fnName} on ${name}`, () => {
      const start = performance.now()
      fn(input)
      expect(performance.now() - start).toBeLessThan(budget)
    })
  }
}
