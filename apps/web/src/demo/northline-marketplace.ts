export type SearchTab = 'Stays' | 'Flights' | 'Flight + Hotel' | 'Vacation Packages' | 'Experiences'
export type TravelPackage = { id: string; city: string; country: string; title: string; category: SearchTab; image: string; priceCents: number; nights: number; rating: string; reviewCount: string; cancellation: string; description: string; whooshEligible?: boolean }

export const northlinePackages: TravelPackage[] = [
  { id: 'montreal-weekend', city: 'Montréal', country: 'Canada', title: 'Montreal Weekend Escape', category: 'Flight + Hotel', image: 'northline-card-montreal', priceCents: 28_400, nights: 3, rating: '4.9', reviewCount: '182', cancellation: 'Free cancellation until Oct 16', description: 'Old Montréal stay, city passes, and time to roam.', whooshEligible: true },
  { id: 'tokyo', city: 'Tokyo', country: 'Japan', title: 'Tokyo After Dark', category: 'Flight + Hotel', image: 'northline-card-tokyo', priceCents: 1_146_00, nights: 5, rating: '4.8', reviewCount: '1,246', cancellation: 'Flexible rate available', description: 'Shibuya stay, rail pass, and food-market guide.' },
  { id: 'paris', city: 'Paris', country: 'France', title: 'Paris Left Bank Stay', category: 'Stays', image: 'northline-card-paris', priceCents: 689_00, nights: 4, rating: '4.7', reviewCount: '904', cancellation: 'Reserve now, pay later', description: 'Boutique hotel close to the Luxembourg Gardens.' },
  { id: 'new-york', city: 'New York', country: 'United States', title: 'New York City Break', category: 'Vacation Packages', image: 'northline-card-newyork', priceCents: 795_00, nights: 3, rating: '4.6', reviewCount: '2,102', cancellation: 'Cancellation options available', description: 'Midtown stay, airport transfer, and museum access.' },
  { id: 'lisbon', city: 'Lisbon', country: 'Portugal', title: 'Lisbon City & Coast', category: 'Vacation Packages', image: 'northline-card-lisbon', priceCents: 722_00, nights: 4, rating: '4.8', reviewCount: '631', cancellation: 'Flexible rate available', description: 'Hillside hotel and a day on the Atlantic coast.' },
  { id: 'vancouver', city: 'Vancouver', country: 'Canada', title: 'Vancouver Outside In', category: 'Experiences', image: 'northline-card-vancouver', priceCents: 416_00, nights: 3, rating: '4.8', reviewCount: '488', cancellation: 'Free cancellation for 24 hours', description: 'Waterfront stay and an easy day in the mountains.' },
  { id: 'cancun', city: 'Cancún', country: 'Mexico', title: 'Cancún Sun Week', category: 'Flight + Hotel', image: 'northline-card-cancun', priceCents: 938_00, nights: 5, rating: '4.5', reviewCount: '1,718', cancellation: 'Flexible rate available', description: 'Beachfront hotel with breakfast and airport transfer.' },
]

export const findPackage = (id: string) => northlinePackages.find((item) => item.id === id) ?? northlinePackages[0]!
export const usd = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`
