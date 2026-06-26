import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  setupTestDb,
  makeOrg,
  makeDept,
  makeTeam,
  makeUser,
  callerFor
} from '../../factories/index.js'

let t: Awaited<ReturnType<typeof setupTestDb>>

beforeAll(async () => {
  t = await setupTestDb()
})
afterAll(async () => {
  await t.stop()
})

describe('teams router', () => {
  it('team_manager sees only their own team in list', async () => {
    const org = await makeOrg(t.db)
    const teamA = await makeTeam(t.db, org.id)
    await makeTeam(t.db, org.id) // teamB, invisible
    const user = await makeUser(t.db, {
      role: 'team_manager',
      scopeType: 'team',
      scopeId: teamA.id
    })
    const caller = await callerFor(t.db, user.id)
    const result = await caller.teams.list({})
    expect(result.map((r) => r.id)).toEqual([teamA.id])
  })

  it('team_manager can update own team but not another', async () => {
    const org = await makeOrg(t.db)
    const teamA = await makeTeam(t.db, org.id)
    const teamB = await makeTeam(t.db, org.id)
    const user = await makeUser(t.db, {
      role: 'team_manager',
      scopeType: 'team',
      scopeId: teamA.id
    })
    const caller = await callerFor(t.db, user.id)
    const ok = await caller.teams.update({ id: teamA.id, name: 'new-a' })
    expect(ok?.name).toBe('new-a')
    await expect(
      caller.teams.update({ id: teamB.id, name: 'new-b' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('team_manager can addMember', async () => {
    const org = await makeOrg(t.db)
    const team = await makeTeam(t.db, org.id)
    const mgr = await makeUser(t.db, {
      role: 'team_manager',
      scopeType: 'team',
      scopeId: team.id
    })
    const newb = await makeUser(t.db, { orgId: org.id })
    const caller = await callerFor(t.db, mgr.id)
    const res = await caller.teams.addMember({ teamId: team.id, userId: newb.id })
    expect(res.ok).toBe(true)
  })

  it('addMember rejects a user from a different org', async () => {
    const orgA = await makeOrg(t.db)
    const orgB = await makeOrg(t.db)
    const teamA = await makeTeam(t.db, orgA.id)
    const mgrA = await makeUser(t.db, {
      role: 'team_manager',
      scopeType: 'team',
      scopeId: teamA.id
    })
    const outsider = await makeUser(t.db, { orgId: orgB.id })
    const caller = await callerFor(t.db, mgrA.id)
    await expect(
      caller.teams.addMember({ teamId: teamA.id, userId: outsider.id })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('create rejects a departmentId from a different org', async () => {
    const orgA = await makeOrg(t.db)
    const orgB = await makeOrg(t.db)
    const deptB = await makeDept(t.db, orgB.id)
    const adminA = await makeUser(t.db, {
      role: 'org_admin',
      scopeType: 'organization',
      scopeId: orgA.id
    })
    const caller = await callerFor(t.db, adminA.id)
    await expect(
      caller.teams.create({
        orgId: orgA.id,
        departmentId: deptB.id,
        name: 'x',
        slug: 'cross-team'
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('create accepts a 2-character slug (client/server slug regex parity)', async () => {
    const org = await makeOrg(t.db)
    const admin = await makeUser(t.db, {
      role: 'org_admin',
      scopeType: 'organization',
      scopeId: org.id
    })
    const caller = await callerFor(t.db, admin.id)
    const team = await caller.teams.create({ orgId: org.id, name: 'QA', slug: 'qa' })
    expect(team?.slug).toBe('qa')
  })

  it('update rejects a departmentId from a different org', async () => {
    const orgA = await makeOrg(t.db)
    const orgB = await makeOrg(t.db)
    const teamA = await makeTeam(t.db, orgA.id)
    const deptB = await makeDept(t.db, orgB.id)
    const adminA = await makeUser(t.db, {
      role: 'org_admin',
      scopeType: 'organization',
      scopeId: orgA.id
    })
    const caller = await callerFor(t.db, adminA.id)
    await expect(
      caller.teams.update({ id: teamA.id, departmentId: deptB.id })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('member cannot create team', async () => {
    const org = await makeOrg(t.db)
    const team = await makeTeam(t.db, org.id)
    const user = await makeUser(t.db, {
      role: 'member',
      scopeType: 'team',
      scopeId: team.id
    })
    const caller = await callerFor(t.db, user.id)
    await expect(
      caller.teams.create({ orgId: org.id, name: 'x', slug: 'xteam' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
