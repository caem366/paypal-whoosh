export type DirectAmountResult =
  | { status: 'READY'; amounts: Array<{ memberId: string; amountCents: number }> }
  | { status: 'NEEDS_CLARIFICATION'; message: string }

const units: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 }

function dollarCents(phrase: string): number | null {
  const text = phrase.trim().replace(/^(?:us\s*)?\$/i, '').replace(/\s*(?:us\s*)?dollars?\s*$/i, '').trim()
  if (/^\d[\d,]*(?:\.\d{1,2})?$/.test(text)) {
    const [whole, fraction = ''] = text.replace(/,/g, '').split('.')
    return Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  }
  const words = text.toLowerCase().replace(/-/g, ' ').split(/\s+/).filter((word) => word !== 'and')
  if (!words.length) return null
  let total = 0
  let current = 0
  for (const word of words) {
    if (word === 'hundred' && current > 0) current *= 100
    else if (word === 'thousand' && current > 0) { total += current * 1000; current = 0 }
    else if (units[word] !== undefined) current += units[word]
    else return null
  }
  return (total + current) * 100
}

/** Direct contributions are whole-receipt shares, not inferred item usage. */
export function parseDirectAmountRequest(request: string, members: Array<{ id: string; name: string }>, totalCents: number): DirectAmountResult | null {
  if (/\b(?:at most|up to|maximum|limit|must)\b/i.test(request)) return null
  const clauses = request.split(/[.;\n]+/).map((part) => part.trim()).filter(Boolean)
  const paymentClauses = clauses.filter((part) => /\b(?:pays?|covers?)\b/i.test(part))
  if (!paymentClauses.some((part) => /\$|\bdollars?\b|\b(?:same|rest|hundred|thousand)\b|\b(?:pays?|covers?)\s+\d/i.test(part))) return null
  const amounts = new Map<string, number>()
  let previous: number | undefined
  let restMember: string | undefined
  for (const clause of paymentClauses) {
    const match = /([\p{L}][\p{L}'-]*(?:\s+[\p{L}][\p{L}'-]*)?)\s+(?:pays?|covers?)\s+(.+)$/iu.exec(clause)
    if (!match) return { status: 'NEEDS_CLARIFICATION', message: `State each person's share separately, using a group member's name.` }
    const names = [match[1]!.toLowerCase(), match[1]!.split(/\s+/).at(-1)!.toLowerCase()]
    const candidates = members.filter((member) => names.some((name) => member.name.toLowerCase() === name || member.name.split(/\s+/)[0]?.toLowerCase() === name))
    if (candidates.length !== 1) return { status: 'NEEDS_CLARIFICATION', message: `“${match[1]}” does not identify one member of this group.` }
    const memberId = candidates[0]!.id
    if (amounts.has(memberId) || restMember === memberId) return { status: 'NEEDS_CLARIFICATION', message: `Give ${candidates[0]!.name} only one contribution.` }
    const value = match[2]!.trim()
    if (/^(?:the\s+)?rest$/i.test(value)) {
      if (restMember) return { status: 'NEEDS_CLARIFICATION', message: 'Only one participant can cover the remaining amount.' }
      restMember = memberId
      continue
    }
    const amountCents = /^(?:the\s+)?same(?:\s+amount)?$/i.test(value) ? previous ?? null : dollarCents(value)
    if (amountCents === null || !Number.isSafeInteger(amountCents) || amountCents <= 0) return { status: 'NEEDS_CLARIFICATION', message: `Give ${candidates[0]!.name} a clear, positive dollar amount.` }
    amounts.set(memberId, amountCents)
    previous = amountCents
  }
  if (restMember) amounts.set(restMember, totalCents - [...amounts.values()].reduce((sum, cents) => sum + cents, 0))
  if (amounts.size !== members.length || members.some((member) => !amounts.has(member.id))) return { status: 'NEEDS_CLARIFICATION', message: `State a contribution for every group member: ${members.map((member) => member.name).join(', ')}.` }
  if ([...amounts.values()].some((cents) => cents <= 0) || [...amounts.values()].reduce((sum, cents) => sum + cents, 0) !== totalCents) return { status: 'NEEDS_CLARIFICATION', message: `The four contributions must be positive and total exactly US$${(totalCents / 100).toFixed(2)}.` }
  return { status: 'READY', amounts: members.map((member) => ({ memberId: member.id, amountCents: amounts.get(member.id)! })) }
}
