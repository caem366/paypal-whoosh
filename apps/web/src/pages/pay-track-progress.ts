export function fundingPercentage(fundedCents: number, totalCents: number) {
  return totalCents > 0 ? Math.min(100, Math.max(0, Math.round((fundedCents / totalCents) * 1000) / 10)) : 0
}
