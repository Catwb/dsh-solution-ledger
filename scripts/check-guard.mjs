/**
 * Behaviour of the route fence, exercised without a live server.
 *
 * Run with `node scripts/check-guard.mjs`.
 */
import { createGuard } from '../lib/guard.js'

let failures = 0
const expect = (label, actual, wanted) => {
  const ok = JSON.stringify(actual) === JSON.stringify(wanted)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` → got ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)}`}`)
}

/** A response stand-in that records what the fence wrote. */
function fakeResponse() {
  const record = { status: null, headers: null, body: null, ended: false }
  return {
    record,
    writeHead(status, headers) {
      record.status = status
      record.headers = headers
    },
    end(body) {
      record.body = body ?? null
      record.ended = true
    },
  }
}

const request = { headers: { host: '127.0.0.1:14559' } }

console.log('--- an authenticated caller passes ---')
{
  const guard = createGuard({ requestRejection: () => undefined })
  const res = fakeResponse()
  expect('returns false (continue)', guard(request, res), false)
  expect('writes nothing', res.record.ended, false)
}

console.log('\n--- an unauthenticated caller is refused 401 ---')
{
  const guard = createGuard({ requestRejection: () => 401 })
  const res = fakeResponse()
  expect('returns true (stop)', guard(request, res), true)
  expect('status 401', res.record.status, 401)
  expect('body', res.record.body, 'unauthorized')
  expect('never cached', res.record.headers['Cache-Control'], 'no-store')
}

console.log('\n--- a cross-site caller is refused 403 ---')
{
  const guard = createGuard({ requestRejection: () => 403 })
  const res = fakeResponse()
  expect('returns true (stop)', guard(request, res), true)
  expect('status 403', res.record.status, 403)
  expect('body', res.record.body, 'forbidden')
}

console.log('\n--- a missing connection fails closed ---')
{
  const guard = createGuard(undefined)
  const res = fakeResponse()
  expect('returns true (stop)', guard(request, res), true)
  expect('status 503', res.record.status, 503)
}

// The reported bug: connection registers after an await, so a plugin applied
// first held `undefined` forever and every request was refused. A resolver must
// be re-read per request so the fence converges on its own.
console.log('\n--- a late-registering connection is picked up per request ---')
{
  let connection
  const guard = createGuard(() => connection)
  const first = fakeResponse()
  expect('refused while absent', guard(request, first), true)
  expect('status 503 while absent', first.record.status, 503)
  connection = { requestRejection: () => 401 }
  const second = fakeResponse()
  expect('reaches the service once it exists', guard(request, second), true)
  expect('status 401 once it exists', second.record.status, 401)
  expect('body once it exists', second.record.body, 'unauthorized')
}

console.log('\n--- a throwing resolver fails closed ---')
{
  const guard = createGuard(() => {
    throw new Error('nope')
  })
  const res = fakeResponse()
  expect('returns true (stop)', guard(request, res), true)
  expect('status 503', res.record.status, 503)
}

console.log('\n--- a throwing check fails closed ---')
{
  const guard = createGuard({
    requestRejection: () => {
      throw new Error('boom')
    },
  })
  const res = fakeResponse()
  expect('returns true (stop)', guard(request, res), true)
  expect('status 403', res.record.status, 403)
}

console.log('\n--- the request is handed to the service as-is ---')
{
  let seen = null
  const guard = createGuard({
    requestRejection: (input) => {
      seen = input
      return undefined
    },
  })
  guard(request, fakeResponse())
  expect('same object forwarded', seen === request, true)
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`)
process.exitCode = failures === 0 ? 0 : 1
