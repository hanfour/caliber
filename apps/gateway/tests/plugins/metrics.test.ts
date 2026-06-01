import { describe, it, expect, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { Counter, Histogram, Gauge } from 'prom-client'
import { metricsPlugin } from '../../src/plugins/metrics.js'

const METRIC_NAMES = [
  'gw_slot_acquire_total',
  'gw_slot_hold_duration_seconds',
  'gw_wait_queue_depth',
  'gw_idempotency_hit_total',
  'gw_redis_latency_seconds',
  'gw_upstream_duration_seconds',
  'gw_pricing_miss_total',
  'gw_oauth_refresh_dead_total',
  'gw_queue_depth',
  'gw_queue_dlq_count',
]

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(metricsPlugin)
  return app
}

describe('metricsPlugin', () => {
  const apps: FastifyInstance[] = []

  afterEach(async () => {
    for (const app of apps) {
      await app.close()
    }
    apps.length = 0
  })

  it('1. GET /metrics returns 200', async () => {
    const app = await buildTestApp()
    apps.push(app)
    const res = await app.inject({ method: 'GET', url: '/metrics' })
    expect(res.statusCode).toBe(200)
  })

  it('2. content-type starts with text/plain', async () => {
    const app = await buildTestApp()
    apps.push(app)
    const res = await app.inject({ method: 'GET', url: '/metrics' })
    expect(res.headers['content-type']).toMatch(/^text\/plain/)
  })

  it('3. response body contains all 11 metric names', async () => {
    const app = await buildTestApp()
    apps.push(app)
    const res = await app.inject({ method: 'GET', url: '/metrics' })
    const body = res.body
    for (const name of METRIC_NAMES) {
      expect(body, `expected metric "${name}" in /metrics output`).toContain(name)
    }
  })

  it('4. unlabeled gauges show zero values', async () => {
    const app = await buildTestApp()
    apps.push(app)
    const res = await app.inject({ method: 'GET', url: '/metrics' })
    const body = res.body
    expect(body).toContain('gw_wait_queue_depth 0')
    expect(body).toContain('gw_queue_depth 0')
    expect(body).toContain('gw_queue_dlq_count 0')
  })

  it('5. histogram zero-state appears as _count 0', async () => {
    const app = await buildTestApp()
    apps.push(app)
    const res = await app.inject({ method: 'GET', url: '/metrics' })
    const body = res.body
    expect(body).toContain('gw_redis_latency_seconds_count 0')
  })

  it('6. app.gwMetrics decoration exposes all 11 metric accessors', async () => {
    const app = await buildTestApp()
    apps.push(app)
    const m = app.gwMetrics
    expect(m).toBeDefined()
    expect(m.slotAcquireTotal).toBeInstanceOf(Counter)
    expect(m.slotHoldDurationSeconds).toBeInstanceOf(Histogram)
    expect(m.waitQueueDepth).toBeInstanceOf(Gauge)
    expect(m.idempotencyHitTotal).toBeInstanceOf(Counter)
    expect(m.redisLatencySeconds).toBeInstanceOf(Histogram)
    expect(m.upstreamDurationSeconds).toBeInstanceOf(Histogram)
    expect(m.pricingMissTotal).toBeInstanceOf(Counter)
    expect(m.oauthRefreshDeadTotal).toBeInstanceOf(Counter)
    expect(m.queueDepth).toBeInstanceOf(Gauge)
    expect(m.queueDlqCount).toBeInstanceOf(Gauge)
  })

  it('7. multiple buildTestApp() calls do not throw duplicate metric errors', async () => {
    const app1 = await buildTestApp()
    apps.push(app1)
    const app2 = await buildTestApp()
    apps.push(app2)
    // If we get here without error, clearRegisterOnInit worked
    const res1 = await app1.inject({ method: 'GET', url: '/metrics' })
    const res2 = await app2.inject({ method: 'GET', url: '/metrics' })
    expect(res1.statusCode).toBe(200)
    expect(res2.statusCode).toBe(200)
  })
})
