import { addGroupMember, createGroup, fundMemberWallet } from '../groups/groups.service.js'

const DEMO_MEMBERS = [
  { name: 'Jamie Cooper', balanceCents: 65_000 },
  { name: 'Alex Chen', balanceCents: 35_000 },
  { name: 'Jordan Ellis', balanceCents: 30_000 },
  { name: 'Maya Patel', balanceCents: 28_400 },
]

/** Creates a fresh, fictional group. No production payment accounts are involved. */
export async function createSandboxSession() {
  const created = await createGroup({
    name: 'Montreal crew',
    creatorName: DEMO_MEMBERS[0]!.name,
  })

  const members = [created.member]

  for (const demoMember of DEMO_MEMBERS.slice(1)) {
    const added = await addGroupMember({
      groupId: created.group.id,
      displayName: demoMember.name,
    })
    members.push(added.member)
  }

  await Promise.all(
    members.map((member, index) =>
      fundMemberWallet({
        groupId: created.group.id,
        memberId: member.id,
        amountCents: DEMO_MEMBERS[index]!.balanceCents,
        idempotencyKey: `sandbox-seed-${created.group.id}-${member.id}`,
      }),
    ),
  )

  return { groupId: created.group.id }
}
