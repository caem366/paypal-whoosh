import { bigint, boolean, index, jsonb, pgEnum, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core'
import { groupMembers, groups } from './groups.js'

export const checkoutSessionStatus = pgEnum('checkout_session_status', ['active', 'authorized_unpaid', 'paypal_order_created', 'completed', 'failed', 'cancelled'])
export const participantConsentStatus = pgEnum('participant_consent_status', ['pending', 'consented', 'declined'])
export const participantFundingStatus = pgEnum('participant_funding_status', ['not_requested', 'simulated_pending', 'verified', 'failed', 'cancelled', 'refunded'])
export const merchantPaymentStatus = pgEnum('merchant_payment_status', ['not_started', 'paypal_order_created', 'capture_verified', 'failed'])
export const paymentCommitmentStatus = pgEnum('payment_commitment_status', ['ready_to_pay', 'order_created', 'approved', 'capturing', 'paid_verified', 'failed', 'cancelled', 'refund_pending', 'refunded', 'superseded'])

export const groupPermissions = pgTable('group_permissions', {
  id: uuid('id').defaultRandom().primaryKey(), groupId: uuid('group_id').notNull().references(() => groups.id, { onDelete: 'restrict' }),
  memberId: uuid('member_id').notNull().references(() => groupMembers.id, { onDelete: 'restrict' }), limitCents: bigint('limit_cents', { mode: 'number' }).notNull(),
  status: varchar('status', { length: 24 }).notNull().default('active'), expiresAt: timestamp('expires_at', { withTimezone: true }), createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [uniqueIndex('group_permissions_member_unique').on(t.groupId, t.memberId)])

export const groupRules = pgTable('group_rules', {
  id: uuid('id').defaultRandom().primaryKey(), groupId: uuid('group_id').notNull().references(() => groups.id, { onDelete: 'restrict' }),
  allowTemporaryFronting: boolean('allow_temporary_fronting').notNull().default(false), createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [uniqueIndex('group_rules_group_unique').on(t.groupId)])

export const checkoutSessions = pgTable('checkout_sessions', {
  id: uuid('id').defaultRandom().primaryKey(), groupId: uuid('group_id').notNull().references(() => groups.id, { onDelete: 'restrict' }),
  merchant: varchar('merchant', { length: 160 }).notNull(), reference: varchar('reference', { length: 128 }).notNull(), totalCents: bigint('total_cents', { mode: 'number' }).notNull(), currency: varchar('currency', { length: 3 }).notNull(),
  merchantId: varchar('merchant_id', { length: 80 }), merchantOrderId: varchar('merchant_order_id', { length: 128 }), expectedPayeeMerchantId: varchar('expected_payee_merchant_id', { length: 128 }), expiresAt: timestamp('expires_at', { withTimezone: true }),
  cart: jsonb('cart').notNull(), instruction: varchar('instruction', { length: 4000 }), allocation: jsonb('allocation'),
  status: checkoutSessionStatus('status').notNull().default('active'), merchantPaymentStatus: merchantPaymentStatus('merchant_payment_status').notNull().default('not_started'),
  paymentMode: varchar('payment_mode', { length: 40 }).notNull().default('single_payer'),
  bookingStatus: varchar('booking_status', { length: 40 }).notNull().default('pending_allocation'),
  paypalOrderId: varchar('paypal_order_id', { length: 128 }), paypalCaptureId: varchar('paypal_capture_id', { length: 128 }), idempotencyKey: varchar('idempotency_key', { length: 255 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(), updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [uniqueIndex('checkout_sessions_idempotency_unique').on(t.idempotencyKey), uniqueIndex('checkout_sessions_paypal_capture_unique').on(t.paypalCaptureId), uniqueIndex('checkout_sessions_merchant_order_unique').on(t.merchantId, t.merchantOrderId), index('checkout_sessions_group_status_index').on(t.groupId, t.status)])

export const purchaseApprovals = pgTable('purchase_approvals', {
  id: uuid('id').defaultRandom().primaryKey(), checkoutSessionId: uuid('checkout_session_id').notNull().references(() => checkoutSessions.id, { onDelete: 'restrict' }),
  memberId: uuid('member_id').notNull().references(() => groupMembers.id, { onDelete: 'restrict' }), approvedCents: bigint('approved_cents', { mode: 'number' }).notNull(), createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [uniqueIndex('purchase_approvals_session_member_unique').on(t.checkoutSessionId, t.memberId)])

export const participantFunding = pgTable('participant_funding', {
  id: uuid('id').defaultRandom().primaryKey(), checkoutSessionId: uuid('checkout_session_id').notNull().references(() => checkoutSessions.id, { onDelete: 'restrict' }),
  memberId: uuid('member_id').notNull().references(() => groupMembers.id, { onDelete: 'restrict' }), allocationCents: bigint('allocation_cents', { mode: 'number' }).notNull(),
  consentStatus: participantConsentStatus('consent_status').notNull().default('pending'), fundingStatus: participantFundingStatus('funding_status').notNull().default('not_requested'),
}, (t) => [uniqueIndex('participant_funding_session_member_unique').on(t.checkoutSessionId, t.memberId)])

export const participantApprovalTokens = pgTable('participant_approval_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  checkoutSessionId: uuid('checkout_session_id').notNull().references(() => checkoutSessions.id, { onDelete: 'restrict' }),
  memberId: uuid('member_id').notNull().references(() => groupMembers.id, { onDelete: 'restrict' }),
  tokenHash: varchar('token_hash', { length: 64 }).notNull(),
  purpose: varchar('purpose', { length: 16 }).notNull(),
  allocationVersion: varchar('allocation_version', { length: 64 }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [uniqueIndex('participant_approval_tokens_hash_unique').on(t.tokenHash), index('participant_approval_tokens_session_member_index').on(t.checkoutSessionId, t.memberId)])

export const participantFundingEvents = pgTable('participant_funding_events', {
  id: uuid('id').defaultRandom().primaryKey(), checkoutSessionId: uuid('checkout_session_id').notNull().references(() => checkoutSessions.id, { onDelete: 'restrict' }),
  memberId: uuid('member_id').notNull().references(() => groupMembers.id, { onDelete: 'restrict' }), action: varchar('action', { length: 24 }).notNull(),
  amountCents: bigint('amount_cents', { mode: 'number' }).notNull(), idempotencyKey: varchar('idempotency_key', { length: 255 }).notNull(), createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [uniqueIndex('participant_funding_events_idempotency_unique').on(t.idempotencyKey), index('participant_funding_events_session_index').on(t.checkoutSessionId)])

/**
 * A commitment is one member's separately payable portion of a group checkout.
 * It intentionally maps to one provider order, never to a shared PayPal order.
 */
export const paymentCommitments = pgTable('payment_commitments', {
  id: uuid('id').defaultRandom().primaryKey(),
  checkoutSessionId: uuid('checkout_session_id').notNull().references(() => checkoutSessions.id, { onDelete: 'restrict' }),
  memberId: uuid('member_id').notNull().references(() => groupMembers.id, { onDelete: 'restrict' }),
  provider: varchar('provider', { length: 32 }).notNull().default('paypal'),
  revision: bigint('revision', { mode: 'number' }).notNull().default(1),
  amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
  capturedCents: bigint('captured_cents', { mode: 'number' }),
  currency: varchar('currency', { length: 3 }).notNull(),
  status: paymentCommitmentStatus('status').notNull().default('ready_to_pay'),
  expectedPayerEmail: varchar('expected_payer_email', { length: 320 }),
  payerEmail: varchar('payer_email', { length: 320 }),
  providerOrderId: varchar('provider_order_id', { length: 128 }),
  providerCustomId: varchar('provider_custom_id', { length: 127 }),
  providerInvoiceId: varchar('provider_invoice_id', { length: 255 }),
  providerPayeeMerchantId: varchar('provider_payee_merchant_id', { length: 128 }),
  providerCaptureId: varchar('provider_capture_id', { length: 128 }),
  providerRefundId: varchar('provider_refund_id', { length: 128 }),
  refundRequestId: varchar('refund_request_id', { length: 255 }),
  refundedCents: bigint('refunded_cents', { mode: 'number' }),
  approvalUrl: varchar('approval_url', { length: 2048 }),
  createRequestId: varchar('create_request_id', { length: 255 }),
  captureRequestId: varchar('capture_request_id', { length: 255 }),
  failureCode: varchar('failure_code', { length: 120 }),
  failureMessage: varchar('failure_message', { length: 500 }),
  supersededAt: timestamp('superseded_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('payment_commitments_session_member_revision_unique').on(t.checkoutSessionId, t.memberId, t.revision),
  uniqueIndex('payment_commitments_provider_order_unique').on(t.providerOrderId),
  uniqueIndex('payment_commitments_provider_invoice_unique').on(t.providerInvoiceId),
  uniqueIndex('payment_commitments_provider_capture_unique').on(t.providerCaptureId),
  uniqueIndex('payment_commitments_provider_refund_unique').on(t.providerRefundId),
  index('payment_commitments_session_status_index').on(t.checkoutSessionId, t.status),
])

export const northlineBookings = pgTable('northline_bookings', {
  id: uuid('id').defaultRandom().primaryKey(),
  checkoutSessionId: uuid('checkout_session_id').notNull().references(() => checkoutSessions.id, { onDelete: 'restrict' }),
  merchantOrderId: varchar('merchant_order_id', { length: 128 }).notNull(),
  totalCents: bigint('total_cents', { mode: 'number' }).notNull(),
  currency: varchar('currency', { length: 3 }).notNull(),
  expectedPayeeMerchantId: varchar('expected_payee_merchant_id', { length: 128 }),
  status: varchar('status', { length: 32 }).notNull().default('pending'),
  failureReason: varchar('failure_reason', { length: 200 }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [uniqueIndex('northline_bookings_session_unique').on(t.checkoutSessionId), uniqueIndex('northline_bookings_order_unique').on(t.merchantOrderId)])

export const northlineBookingEvents = pgTable('northline_booking_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  bookingId: uuid('booking_id').notNull().references(() => northlineBookings.id, { onDelete: 'restrict' }),
  eventType: varchar('event_type', { length: 80 }).notNull(),
  idempotencyKey: varchar('idempotency_key', { length: 255 }).notNull(),
  payload: jsonb('payload').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [uniqueIndex('northline_booking_events_key_unique').on(t.idempotencyKey)])

export const fundingReadyNotifications = pgTable('funding_ready_notifications', {
  id: uuid('id').defaultRandom().primaryKey(),
  checkoutSessionId: uuid('checkout_session_id').notNull().references(() => checkoutSessions.id, { onDelete: 'restrict' }),
  status: varchar('status', { length: 24 }).notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
}, (t) => [uniqueIndex('funding_ready_notifications_session_unique').on(t.checkoutSessionId)])

export const paymentCommitmentEvents = pgTable('payment_commitment_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  commitmentId: uuid('commitment_id').notNull().references(() => paymentCommitments.id, { onDelete: 'restrict' }),
  eventType: varchar('event_type', { length: 80 }).notNull(),
  idempotencyKey: varchar('idempotency_key', { length: 255 }).notNull(),
  payload: jsonb('payload').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [uniqueIndex('payment_commitment_events_idempotency_unique').on(t.idempotencyKey), index('payment_commitment_events_commitment_index').on(t.commitmentId)])

export const groupPurchases = pgTable('group_purchases', {
  id: uuid('id').defaultRandom().primaryKey(), groupId: uuid('group_id').notNull().references(() => groups.id, { onDelete: 'restrict' }), checkoutSessionId: uuid('checkout_session_id').references(() => checkoutSessions.id, { onDelete: 'restrict' }),
  merchant: varchar('merchant', { length: 160 }).notNull(), title: varchar('title', { length: 200 }).notNull(), totalCents: bigint('total_cents', { mode: 'number' }).notNull(), currency: varchar('currency', { length: 3 }).notNull(),
  isDemoData: boolean('is_demo_data').notNull().default(false), paypalCaptureId: varchar('paypal_capture_id', { length: 128 }), completedAt: timestamp('completed_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [uniqueIndex('group_purchases_session_unique').on(t.checkoutSessionId), uniqueIndex('group_purchases_capture_unique').on(t.paypalCaptureId), index('group_purchases_group_completed_index').on(t.groupId, t.completedAt)])
