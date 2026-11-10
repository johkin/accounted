import { z } from 'zod'
import { CreateSelfBillingInvoiceSchema, SelfBillingInvoiceItemSchema } from '@/lib/api/schemas'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import {
  createSelfBilledSaleInvoice,
  resolveSelfBilledSaleDraft,
  type SelfBilledSaleFailure,
} from '@/lib/invoices/self-billed-sale'
import { defineOperation, type OperationOutcome } from './types'

function failureOutcome(failure: SelfBilledSaleFailure): OperationOutcome<never> {
  const codes = {
    customer_not_found: 'INVOICE_CUSTOMER_NOT_FOUND',
    vat_rule_violation: 'INVOICE_CREATE_VAT_RULE_VIOLATION',
    fx_rate_unavailable: 'VALIDATION_ERROR',
    no_fiscal_period: 'INVOICE_BOOK_NO_FISCAL_PERIOD',
    insert_failed: 'INVOICE_CREATE_INSERT_FAILED',
    items_failed: 'INVOICE_CREATE_ITEMS_FAILED',
  }
  return { ok: false, code: codes[failure.code], details: { ...failure } }
}

// Reuse the received-sale service rather than treating a self-bill as an
// ordinary draft or a supplier invoice. Approval can post a permanent entry.
export const selfBilledInvoicesCreate = defineOperation({
  id: 'invoices.create-self-billed',
  kind: 'write',
  scope: 'invoices:write',
  risk: 'high',
  reversible: false,
  input: CreateSelfBillingInvoiceSchema.extend({
    items: z.array(SelfBillingInvoiceItemSchema.strict()).min(1),
  }).strict(),
  output: z.object({
    invoice_id: z.string(),
    external_invoice_number: z.string(),
    status: z.string(),
    journal_entry_id: z.string().nullable(),
  }),
  docs: {
    summary: 'Register a received self-billing invoice as a sale.',
    description: 'Uses the customer-issued number, without allocating an F-number or sending email. Accrual accounting posts on registration; cash accounting posts on payment.',
    useWhen: 'A customer has issued a self-billing invoice on the company\'s behalf.',
    doNotUseFor: 'Own-issued customer invoices or supplier purchase invoices.',
    pitfalls: ['Approval can post an immutable journal entry. The external invoice number and received date are required.'],
    example: { response: { invoice_id: 'invoice-uuid', external_invoice_number: 'CUSTOMER-123', status: 'sent', journal_entry_id: null } },
  },
  mcp: {
    name: 'gnubok_create_self_billed_invoice',
    title: 'Register Received Self-Billing Invoice',
    description: 'Stage a received self-billing invoice (självfaktura) your customer issued on your behalf: a sale, using their number. Approval books it under accrual accounting; cash accounting books on payment. No F-number or email.',
    keywords: ['självfaktura', 'självfakturering', 'self-billing', 'self billed', 'mottagen självfaktura'],
    stage: {
      pendingType: 'create_self_billed_invoice',
      title: (input) => `Registrera självfaktura: ${input.external_invoice_number}`,
    },
  },
  run: async (ctx, input, { dryRun }) => {
    const resolved = await resolveSelfBilledSaleDraft(ctx.supabase, ctx.companyId, input)
    if (!resolved.ok) return failureOutcome(resolved.failure)

    const { data: settings, error } = await ctx.supabase
      .from('company_settings')
      .select('accounting_method')
      .eq('company_id', ctx.companyId)
      .maybeSingle()
    if (error) throw error
    const wouldBook = (settings?.accounting_method ?? 'accrual') === 'accrual'
    if (wouldBook) {
      const period = await checkPeriodLock(ctx.supabase, ctx.companyId, input.invoice_date)
      if (period.locked) {
        return { ok: false, code: 'PERIOD_LOCKED', details: { ...period, invoice_date: input.invoice_date } }
      }
      if (period.reason === 'no_fiscal_period') return failureOutcome({ code: 'no_fiscal_period' })
    }

    if (dryRun) {
      const { draft } = resolved
      return {
        ok: true,
        dryRun: true,
        preview: {
          ...input,
          customer_name: draft.customer.name,
          is_self_billed: true,
          invoice_number: null,
          status: 'sent',
          items: draft.items,
          subtotal: draft.subtotal,
          vat_amount: draft.vatAmount,
          total: draft.total,
          subtotal_sek: draft.subtotalSek,
          vat_amount_sek: draft.vatAmountSek,
          total_sek: draft.totalSek,
          exchange_rate: draft.exchangeRate,
          vat_treatment: draft.vatTreatment,
          accounting_method: settings?.accounting_method ?? 'accrual',
          would_book_journal_entry: wouldBook,
        },
      }
    }

    const result = await createSelfBilledSaleInvoice(ctx.supabase, ctx.companyId, ctx.userId, input)
    if (!result.ok) return failureOutcome(result.failure)
    return {
      ok: true,
      created: true,
      data: {
        invoice_id: result.invoice.id,
        external_invoice_number: input.external_invoice_number,
        status: result.invoice.status,
        journal_entry_id: result.invoice.journal_entry_id ?? null,
      },
    }
  },
})
