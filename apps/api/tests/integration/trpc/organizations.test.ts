import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestDb, makeOrg, makeUser, callerFor } from '../../factories/index.js'

let t: Awaited<ReturnType<typeof setupTestDb>>

beforeAll(async () => {
  t = await setupTestDb()
})
afterAll(async () => {
  await t.stop()
})

describe('organizations router', () => {
  it('list returns only covered orgs', async () => {
    const a = await makeOrg(t.db)
    const b = await makeOrg(t.db)
    const user = await makeUser(t.db, {
      role: 'org_admin',
      scopeType: 'organization',
      scopeId: a.id,
      orgId: a.id
    })
    const caller = await callerFor(t.db, user.id)
    const result = await caller.organizations.list()
    expect(result.map((o) => o.id)).toEqual([a.id])
    expect(result.map((o) => o.id)).not.toContain(b.id)
  })

  it('create forbidden for non super_admin', async () => {
    const org = await makeOrg(t.db)
    const user = await makeUser(t.db, {
      role: 'org_admin',
      scopeType: 'organization',
      scopeId: org.id
    })
    const caller = await callerFor(t.db, user.id)
    await expect(
      caller.organizations.create({ slug: 'new-one', name: 'X' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('create allowed for super_admin', async () => {
    const admin = await makeUser(t.db, { role: 'super_admin', scopeType: 'global' })
    const caller = await callerFor(t.db, admin.id)
    const created = await caller.organizations.create({
      slug: 'zzz-super',
      name: 'ZZZ'
    })
    expect(created?.slug).toBe('zzz-super')
  })

  it('update forbidden for dept_manager scoped to org (not org_admin)', async () => {
    const org = await makeOrg(t.db)
    const user = await makeUser(t.db, {
      role: 'dept_manager',
      scopeType: 'organization',
      scopeId: org.id
    })
    const caller = await callerFor(t.db, user.id)
    await expect(
      caller.organizations.update({ id: org.id, name: 'x' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('update allowed for org_admin', async () => {
    const org = await makeOrg(t.db)
    const user = await makeUser(t.db, {
      role: 'org_admin',
      scopeType: 'organization',
      scopeId: org.id
    })
    const caller = await callerFor(t.db, user.id)
    const updated = await caller.organizations.update({ id: org.id, name: 'new' })
    expect(updated?.name).toBe('new')
  })

  it('get NOT_FOUND for unknown id', async () => {
    const admin = await makeUser(t.db, { role: 'super_admin', scopeType: 'global' })
    const caller = await callerFor(t.db, admin.id)
    await expect(
      caller.organizations.get({ id: '00000000-0000-0000-0000-000000000000' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  // ── resolveIdentifier (closes #70) ──────────────────────────────

  it('resolveIdentifier: accepts UUID', async () => {
    const org = await makeOrg(t.db)
    const admin = await makeUser(t.db, {
      role: 'org_admin',
      scopeType: 'organization',
      scopeId: org.id,
      orgId: org.id,
    })
    const caller = await callerFor(t.db, admin.id)
    const got = await caller.organizations.resolveIdentifier({ identifier: org.id })
    expect(got.id).toBe(org.id)
    expect(got.slug).toBe(org.slug)
  })

  it('resolveIdentifier: accepts slug', async () => {
    const org = await makeOrg(t.db)
    const admin = await makeUser(t.db, {
      role: 'org_admin',
      scopeType: 'organization',
      scopeId: org.id,
      orgId: org.id,
    })
    const caller = await callerFor(t.db, admin.id)
    const got = await caller.organizations.resolveIdentifier({ identifier: org.slug })
    expect(got.id).toBe(org.id)
    expect(got.slug).toBe(org.slug)
  })

  it('resolveIdentifier: NOT_FOUND for unknown slug', async () => {
    const admin = await makeUser(t.db, { role: 'super_admin', scopeType: 'global' })
    const caller = await callerFor(t.db, admin.id)
    await expect(
      caller.organizations.resolveIdentifier({ identifier: 'no-such-org-slug' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('resolveIdentifier: NOT_FOUND for unauthorized org (hides existence)', async () => {
    const visible = await makeOrg(t.db)
    const hidden = await makeOrg(t.db)
    const admin = await makeUser(t.db, {
      role: 'org_admin',
      scopeType: 'organization',
      scopeId: visible.id,
      orgId: visible.id,
    })
    const caller = await callerFor(t.db, admin.id)
    // Caller has no role at hidden org → NOT_FOUND, not FORBIDDEN.
    // Mirrors `get`'s behaviour — don't leak which orgs exist.
    await expect(
      caller.organizations.resolveIdentifier({ identifier: hidden.slug })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(
      caller.organizations.resolveIdentifier({ identifier: hidden.id })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
