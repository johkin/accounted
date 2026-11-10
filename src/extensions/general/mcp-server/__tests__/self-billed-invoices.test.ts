import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { selfBilledInvoicesCreate as op } from '@/lib/operations/self-billed-invoices'
import { commitPendingOperation } from '@/lib/pending-operations/commit'
import type { PendingOperation } from '@/types'
import { tools } from '../server'

const input = {
  customer_id: '11111111-1111-4111-8111-111111111111',
  external_invoice_number: 'CUSTOMER-123',
  invoice_date: '2026-09-10', received_date: '2026-09-11', due_date: '2026-10-10',
  currency: 'SEK',
  items: [{ description: 'Consulting', quantity: 1, unit: 'st', unit_price: 1000, vat_rate: 25 }],
}
const tool = tools.find((t) => t.name === 'gnubok_create_self_billed_invoice')!
afterEach(() => vi.restoreAllMocks())

describe('self-billing staging and approval', () => {
  it('supports dry_run without inserting a pending operation', async () => {
    vi.spyOn(op, 'run').mockResolvedValue({ ok: true, dryRun: true, preview: { total: 1250 } })
    const { supabase, findCall } = createQueuedMockSupabase()
    const result = await tool.execute({ ...input, dry_run: true }, 'company-1', 'user-1', supabase as never)
    expect(result).toMatchObject({ staged: false, dry_run: true, risk_level: 'high', preview: { total: 1250 } })
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('stages a high-risk operation after a read-only preview', async () => {
    const run = vi.spyOn(op, 'run').mockResolvedValue({ ok: true, dryRun: true, preview: { total: 1250 } })
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: null }) // period status settings
    enqueue({ data: null }) // covering period
    enqueue({ data: { id: 'op-1' } }) // stage insert
    const result = await tool.execute(input, 'company-1', 'user-1', supabase as never)
    expect(result).toMatchObject({ staged: true, operation_id: 'op-1', risk_level: 'high', preview: { total: 1250 } })
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }), input, { dryRun: true })
    expect(findCall('pending_operations', 'insert')?.[0]).toMatchObject({
      company_id: 'company-1', operation_type: 'create_self_billed_invoice', risk_level: 'high', params: input,
    })
    expect(findCall('invoices', 'insert')).toBeUndefined()
  })

  it('refuses invalid arguments without running the preview or staging', async () => {
    const run = vi.spyOn(op, 'run')
    const { supabase, findCall } = createQueuedMockSupabase()
    await expect(tool.execute({ ...input, received_date: '' }, 'company-1', 'user-1', supabase as never))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(run).not.toHaveBeenCalled()
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('never stages a preview that fails', async () => {
    vi.spyOn(op, 'run').mockResolvedValue({ ok: false, code: 'INVOICE_CUSTOMER_NOT_FOUND' })
    const { supabase, findCall } = createQueuedMockSupabase()
    await expect(tool.execute(input, 'company-1', 'user-1', supabase as never))
      .rejects.toMatchObject({ code: 'INVOICE_CUSTOMER_NOT_FOUND' })
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it.each([false, true])('revalidates staged params at approval (tampered=%s)', async (tampered) => {
    const run = vi.spyOn(op, 'run').mockResolvedValue({ ok: true, data: {
      invoice_id: 'inv-1', external_invoice_number: 'CUSTOMER-123', status: 'sent', journal_entry_id: 'je-1',
    } })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // claim
    enqueue({ data: null }) // finalize
    const pending: PendingOperation = {
      id: 'op-1', user_id: 'user-1', company_id: 'company-1', status: 'pending',
      operation_type: 'create_self_billed_invoice', risk_level: 'high',
      params: tampered ? { ...input, received_date: '' } : input, preview_data: {},
      title: 'Registrera självfaktura', result_data: null,
      actor_type: 'user', actor_id: null, actor_label: null,
      agent_metadata: null, rejection_category: null, rejection_reason: null,
      created_at: '2026-09-11T00:00:00Z', updated_at: '2026-09-11T00:00:00Z', resolved_at: null,
    }
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', pending)
    if (tampered) {
      expect(result).toMatchObject({ status: 'failed', code: 'VALIDATION_ERROR' })
      expect(run).not.toHaveBeenCalled()
    } else {
      expect(result).toMatchObject({ status: 'committed', data: { invoice_id: 'inv-1', journal_entry_id: 'je-1' } })
      expect(run).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }), input, { dryRun: false })
    }
  })
})
