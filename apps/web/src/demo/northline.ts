export interface NorthlineCart {
  merchant: 'Northline Travel'
  product: 'Montreal Weekend Escape'
  reference: 'NLT-M1023'
  dates: 'Oct 23–26'
  travelers: 4
  leadTraveler: { name: string; email: string }
  currency: 'USD'
  items: Array<{ id: 'tickets' | 'upgrade' | 'shuttle'; label: string; detail: string; cents: number }>
  totalCents: number
  hasUpgrade: boolean
  hasShuttle: boolean
}

export function buildNorthlineCart(hasUpgrade = true, hasShuttle = true): NorthlineCart {
  const items: NorthlineCart['items'] = [
    { id: 'tickets', label: '4 traveler passes', detail: '4 × $284.00', cents: 113_600 },
    ...(hasUpgrade ? [{ id: 'upgrade' as const, label: 'Cabin upgrade', detail: 'Private cabin', cents: 10_000 }] : []),
    ...(hasShuttle ? [{ id: 'shuttle' as const, label: 'Station shuttle', detail: '3 riders', cents: 4_800 }] : []),
  ]
  return {
  merchant: 'Northline Travel',
  product: 'Montreal Weekend Escape',
  reference: 'NLT-M1023',
  dates: 'Oct 23–26',
  travelers: 4,
  leadTraveler: { name: 'Jamie Cooper', email: 'jamie.cooper@email.com' },
  currency: 'USD' as const,
    items,
    totalCents: items.reduce((sum, item) => sum + item.cents, 0),
    hasUpgrade,
    hasShuttle,
  }
}

export const northlineCart = buildNorthlineCart()

export const formatUsd = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`
