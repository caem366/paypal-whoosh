import { eq } from 'drizzle-orm'
import { db, pool } from './client.js'
import { groupMembers, groupPermissions, groupPurchases, groupRules, groups, users } from './schema/index.js'
import { addGroupMember, createGroup } from '../modules/groups/groups.service.js'

async function seed() {
  let [group] = await db.select().from(groups).where(eq(groups.name, 'Montreal Crew')).limit(1)
  if (!group) {
    const created = await createGroup({ name: 'Montreal Crew', creatorName: 'Jamie Cooper' })
    group = created.group
    await db.update(groupMembers).set({ role: 'host' }).where(eq(groupMembers.id, created.member.id))
    for (const name of ['Alex Chen', 'Jordan Ellis', 'Maya Patel']) await addGroupMember({ groupId: group.id, displayName: name })
  }
  const members = await db.select({ id: groupMembers.id, name: users.displayName }).from(groupMembers).innerJoin(users, eq(groupMembers.userId, users.id)).where(eq(groupMembers.groupId, group.id))
  for (const member of members) await db.insert(groupPermissions).values({ groupId: group.id, memberId: member.id, limitCents: member.name === 'Maya Patel' ? 25_000 : 50_000 }).onConflictDoNothing()
  await db.insert(groupRules).values({ groupId: group.id, allowTemporaryFronting: false }).onConflictDoNothing()
  for (const purchase of [
    { title: 'Dinner at Bar Henri', merchant: 'Bar Henri', totalCents: 18_640 },
    { title: 'Concert tickets', merchant: 'MTELUS', totalCents: 31_200 },
    { title: 'Weekend cottage', merchant: 'Pine & Lake Stays', totalCents: 68_400 },
  ]) {
    const [existing] = await db.select({ id: groupPurchases.id }).from(groupPurchases).where(eq(groupPurchases.title, purchase.title)).limit(1)
    if (!existing) await db.insert(groupPurchases).values({ groupId: group.id, ...purchase, currency: 'USD', isDemoData: true })
  }
  console.info(`Seeded ${group.name} (${group.id})`)
}

seed().then(() => pool.end()).catch(async (error) => { console.error(error); await pool.end(); process.exitCode = 1 })
