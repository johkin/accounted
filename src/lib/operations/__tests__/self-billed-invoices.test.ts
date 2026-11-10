import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { createLogger } from '@/lib/logger'
import { createSelfBilledSaleInvoice, resolveSelfBilledSaleDraft } from '@/lib/invoices/self-billed-sale'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import { selfBilledInvoicesCreate as op } from '../self-billed-invoices'

vi.mock('@/lib/invoices/self-billed-sale', () => ({
  resolveSelfBilledSaleDraft: vi.fn(),
  createSelfBilledSaleInvoice: vi.fn(),
}))
vi.mock('@/lib/api/v1/check-period-lock', () => ({ checkPeriodLock: vi.fn() }))

const input = {
  customer_id: '11111111-1111-4111-8111-111111111111',
  external_invoice_number: 'CUSTOMER-123',
  invoice_date: '2026-09-10', received_date: '2026-09-11', due_date: '2026-10-10',
  currency: 'SEK' as const,
  items: [{ description: 'Consulting', quantity: 1, unit: 'st', unit_price: 1000, vat_rate: 25 as const }],
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(resolveSelfBilledSaleDraft).mockResolvedValue({ ok: true, draft: {
    customer: { id: input.customer_id, name: 'Customer', customer_type: 'swedish_business', vat_number_validated: false },
    items: [{ ...input.items[0], sort_order: 0, line_total: 1000, vat_amount: 250 }],
    subtotal: 1000, vatAmount: 250, total: 1250, currency: 'SEK', vatTreatment: 'standard_25',
    subtotalSek: null, vatAmountSek: null, totalSek: null, exchangeRate: null, exchangeRateDate: null,
    momsRuta: '05', reverseChargeText: null, vatRate: 25,
  } })
  vi.mocked(checkPeriodLock).mockResolvedValue({ locked: false, fiscal_period_id: 'period-1' })
})

function setup(method = 'accrual') {
  const mock = createQueuedMockSupabase()
  mock.enqueue({ data: { accounting_method: method }, error: null })
  return { ...mock, ctx: { supabase: mock.supabase as never, companyId: 'company-1', userId: 'user-1', log: createLogger('test') } }
}

describe('received self-billing operation', () => {
  it.each(['external_invoice_number', 'received_date', 'customer_id'] as const)('requires %s', (key) => {
    const body: Record<string, unknown> = { ...input }
    delete body[key]
    expect(op.input.safeParse(body).success).toBe(false)
  })

  it('refuses unsupported header and line fields rather than dropping them', () => {
    expect(op.input.safeParse({ ...input, document_type: 'quote' }).success).toBe(false)
    expect(op.input.safeParse({ ...input, items: [{ ...input.items[0], revenue_account: '3001' }] }).success).toBe(false)
    expect(op.input.safeParse({ ...input, items: [] }).success).toBe(false)
  })

  it.each(['accrual', 'cash'])('previews %s without writing or allocating a number', async (method) => {
    const { ctx, findCall } = setup(method)
    const result = await op.run(ctx, input, { dryRun: true })
    expect(result).toMatchObject({ ok: true, dryRun: true, preview: {
      external_invoice_number: 'CUSTOMER-123', invoice_number: null, is_self_billed: true,
      total: 1250, vat_amount: 250, would_book_journal_entry: method === 'accrual',
    } })
    expect(findCall('invoices', 'insert')).toBeUndefined()
    expect(createSelfBilledSaleInvoice).not.toHaveBeenCalled()
    expect(resolveSelfBilledSaleDraft).toHaveBeenCalledWith(ctx.supabase, 'company-1', input)
  })

  it.each([true, false])('refuses a locked accrual period at preview and commit (dryRun=%s)', async (dryRun) => {
    const { ctx } = setup()
    vi.mocked(checkPeriodLock).mockResolvedValue({ locked: true, reason: 'period_is_closed' })
    expect(await op.run(ctx, input, { dryRun })).toMatchObject({ ok: false, code: 'PERIOD_LOCKED' })
    expect(createSelfBilledSaleInvoice).not.toHaveBeenCalled()
  })

  it('refuses a missing accrual period before inserting an invoice', async () => {
    const { ctx } = setup()
    vi.mocked(checkPeriodLock).mockResolvedValue({ locked: false, reason: 'no_fiscal_period' })
    expect(await op.run(ctx, input, { dryRun: true })).toMatchObject({ ok: false, code: 'INVOICE_BOOK_NO_FISCAL_PERIOD' })
  })

  it.each([
    [{ code: 'customer_not_found', customerId: input.customer_id }, 'INVOICE_CUSTOMER_NOT_FOUND'],
    [{ code: 'vat_rule_violation', attemptedRate: 25, allowedRates: [0], customerType: 'eu_business' }, 'INVOICE_CREATE_VAT_RULE_VIOLATION'],
    [{ code: 'fx_rate_unavailable', currency: 'EUR', invoiceDate: input.invoice_date }, 'VALIDATION_ERROR'],
  ] as const)('preserves a service refusal: %s', async (failure, code) => {
    const { ctx } = setup()
    vi.mocked(resolveSelfBilledSaleDraft).mockResolvedValue({ ok: false, failure: { ...failure, ...('allowedRates' in failure ? { allowedRates: [...failure.allowedRates] } : {}) } } as never)
    expect(await op.run(ctx, input, { dryRun: true })).toMatchObject({ ok: false, code })
    expect(createSelfBilledSaleInvoice).not.toHaveBeenCalled()
  })

  it('runs the shared writer only on commit with company and actor scope', async () => {
    const { ctx } = setup()
    vi.mocked(createSelfBilledSaleInvoice).mockResolvedValue({ ok: true, invoice: {
      id: 'inv-1', status: 'sent', journal_entry_id: 'je-1',
    } as never })
    expect(await op.run(ctx, input, { dryRun: false })).toEqual({ ok: true, created: true, data: {
      invoice_id: 'inv-1', external_invoice_number: 'CUSTOMER-123', status: 'sent', journal_entry_id: 'je-1',
    } })
    expect(createSelfBilledSaleInvoice).toHaveBeenCalledWith(ctx.supabase, 'company-1', 'user-1', input)
  })
})
