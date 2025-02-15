const test = require('blue-tape')
const redisSrv = require('../test/redis-server')
const session = require('express-session')
const redis = require('redis')
const ioRedis = require('ioredis')
const redisMock = require('redis-mock')
const MockDate = require('mockdate')

let RedisStore = require('../')(session)
MockDate.set('2000-11-22')

let p =
  (ctx, method) =>
  (...args) =>
    new Promise((resolve, reject) => {
      ctx[method](...args, (err, d) => {
        if (err) reject(err)
        resolve(d)
      })
    })

let q = 
    (ctx, method) => 
    (...args) => ctx[method](...args);

// test('setup', redisSrv.connect)

test('defaults', async (t) => {
  t.throws(() => new RedisStore(), 'client is required')

  var client = redis.createClient({ url: `redis://localhost:${redisSrv.port}` })
  await client.connect()
  var store = new RedisStore({ client })

  t.equal(store.client, client, 'stores client')
  t.equal(store.prefix, 'sess:', 'defaults to sess:')
  t.equal(store.ttl, 86400, 'defaults to one day')
  t.equal(store.scanCount, 100, 'defaults SCAN count to 100')
  t.equal(store.serializer, JSON, 'defaults to JSON serialization')
  t.equal(store.disableTouch, false, 'defaults to having `touch` enabled')
  t.equal(store.disableTTL, false, 'defaults to having `ttl` enabled')
  await client.quit()
})

test('node_redis', async (t) => {
  var client = redis.createClient({ url: `redis://localhost:${redisSrv.port}` })
  await client.connect();
  var store = new RedisStore({ client })
  await lifecycleTest(store, t)
  await client.quit()
})

// test('ioredis', async (t) => {
//   var client = ioRedis.createClient(redisSrv.port, 'localhost')
//   var store = new RedisStore({ client })
//   await lifecycleTest(store, t)
//   await client.quit()
// })

// test('redis-mock client', async (t) => {
//   var client = redisMock.createClient()
//   var store = new RedisStore({ client })
//   await lifecycleTest(store, t)
//   await client.quit()
// })

test('teardown', redisSrv.disconnect)

async function lifecycleTest(store, t) {
  await p(store, 'set')('123', { foo: 'bar3' })
  let res = await p(store, 'get')('123')
  t.same(res, { foo: 'bar3', lastModified: 974851200000 }, 'get value 1')
  await p(store, 'set')('123', {
    foo: 'bar3',
    luke: 'skywalker',
    obi: 'wan',
    lastModified: 974851000000,
  })
  await p(store, 'set')('123', {
    luke: 'skywalker',
    lastModified: 974851000000,
  })
  res = await p(store, 'get')('123')
  t.same(
    res,
    { foo: 'bar3', luke: 'skywalker', obi: 'wan', lastModified: 974851200000 },
    'get merged value'
  )

  res = await p(store, 'clear')()
  t.ok(res >= 1, 'cleared key')

  res = await p(store, 'set')('123', { foo: 'bar' })
  t.equal(res, 'OK', 'set value')

  res = await p(store, 'get')('123')
  t.same(res, { foo: 'bar', lastModified: 974851200000 }, 'get value')

  res = await q(store.client, 'ttl')('sess:123')
  t.ok(res >= 86399, 'check one day ttl')

  let ttl = 60
  let expires = new Date(Date.now() + ttl * 1000).toISOString()
  res = await p(store, 'set')('456', { cookie: { expires } })
  t.equal(res, 'OK', 'set cookie expires')

  res = await q(store.client, 'ttl')('sess:456')
  t.ok(res <= 60, 'check expires ttl')

  ttl = 90
  let newExpires = new Date(Date.now() + ttl * 1000).toISOString()
  // note: cookie.expires will not be updated on redis (see https://github.com/tj/connect-redis/pull/285)
  // in v4 touch will not affect the ttl
  res = await p(store, 'touch')('456', { cookie: { expires: newExpires } })
  t.equal(res, 'EXPIRED', 'set cookie expires touch')

  res = await q(store.client, 'ttl')('sess:456')
  t.ok(res > 60, 'check expires ttl touch')

  res = await p(store, 'length')()
  t.equal(res, 2, 'stored two keys length')

  res = await p(store, 'ids')()
  res.sort()
  t.same(res, ['123', '456'], 'stored two keys ids')

  res = await p(store, 'all')()
  res.sort((a, b) => (a.id > b.id ? 1 : -1))
  t.same(
    res,
    [
      { id: '123', foo: 'bar', lastModified: 974851200000 },
      { id: '456', cookie: { expires }, lastModified: 974851200000 },
    ],
    'stored two keys data'
  )

  res = await p(store, 'destroy')('456')
  t.equal(res, 'OK', 'destroyed one')

  res = await p(store, 'get')('456')
  t.equal(res, undefined, 'tombstoned one')

  res = await p(store, 'set')('456', { a: 'new hope' })
  t.equal(res, undefined, 'tombstoned set')

  res = await p(store, 'get')('456')
  t.equal(res, undefined, 'tombstoned two')

  res = await p(store, 'length')()
  t.equal(res, 1, 'one key remains')

  res = await p(store, 'clear')()
  t.equal(res, 2, 'cleared remaining key')

  res = await p(store, 'length')()
  t.equal(res, 0, 'no key remains')

  let count = 1000
  await load(store, count)

  res = await p(store, 'length')()
  t.equal(res, count, 'bulk count')

  res = await p(store, 'clear')()
  t.equal(res, count, 'bulk clear')

  expires = new Date(Date.now() + ttl * 1000).toISOString() // expires in the future
  res = await p(store, 'set')('789', { cookie: { expires } })
  t.equal(res, 'OK', 'set value')

  res = await p(store, 'length')()
  t.equal(res, 1, 'one key exists (session 789)')

  expires = new Date(Date.now() - ttl * 1000).toISOString() // expires in the past
  res = await p(store, 'set')('789', { cookie: { expires } })
  t.equal(res, 'OK', 'returns 1 because destroy was invoked')

  res = await p(store, 'length')()
  t.equal(res, 0, 'no key remains and that includes session 789')
}

function load(store, count) {
  return new Promise((resolve, reject) => {
    let set = (sid) => {
      store.set(
        's' + sid,
        {
          cookie: { expires: new Date(Date.now() + 1000) },
          data: 'some data',
        },
        (err) => {
          if (err) {
            return reject(err)
          }

          if (sid === count) {
            return resolve()
          }

          set(sid + 1)
        }
      )
    }
    set(1)
  })
}
