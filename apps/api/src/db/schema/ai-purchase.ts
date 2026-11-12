import { jsonb, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core'
import { groups } from './groups.js'
import { checkoutSessions } from './group-checkout.js'

export const aiPurchaseProposals = pgTable('ai_purchase_proposals', {
  id: uuid('id').defaultRandom().primaryKey(),
  groupId: uuid('group_id').notNull().references(() => groups.id, { onDelete: 'restrict' }),
  request: varchar('request', { length: 4000 }).notNull(),
  model: varchar('model', { length: 120 }).notNull(),
  interpretation: jsonb('interpretation').notNull(),
  checkoutSessionId: uuid('checkout_session_id').references(() => checkoutSessions.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex('ai_purchase_proposals_checkout_unique').on(table.checkoutSessionId)])
