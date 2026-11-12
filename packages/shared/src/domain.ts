/** Monetary values are always integer cents; never pass display dollars to domain code. */
export type MoneyCents = number

/** The MVP operates in a single simulated currency. */
/** WHOOSH's original ledger foundation was CAD-only; Northline's PayPal flow
 * is explicitly USD, so both are first-class integer-cent ledger currencies. */
export type Currency = 'CAD' | 'USD'

export type SettlementStatus = 'pending' | 'processing' | 'settled' | 'failed'

export type SplitMethod = 'equal' | 'custom'
