import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createMockRouteParams, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
const requireAuthMock = vi.fn()
const requireWriteMock = vi.fn()
const generatePain001Mock = vi.fn()
const resolveBatchDebtorMock = vi.fn()

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))
vi.mock('@/lib/payments/pain001-supplier', () => ({
  generateSupplierPain001: (...args: unknown[]) => generatePain001Mock(...args),
}))
vi.mock('@/lib/payments/batch-service', () => ({
  resolveBatchDebtor: (...args: unknown[]) => resolveBatchDebtorMock(...args),
}))
vi.mock('@/lib/skatteverket/skattekonto-ocr', () => ({
  resolveSkattekontoOcr: vi.fn().mockResolvedValue('1655954700217'),
  SKATTEKONTO_BANKGIRO: '5050-1055',
}))
vi.mock('@/lib/branding/service', () => ({ getBranding: () => ({ appName: 'Accounted' }) }))

import { GET } from '../route'

const ID_1 = '11111111-1111-4111-8111-111111111111'
const ID_2 = '22222222-2222-4222-8222-222222222222'
const request = (ids = `${ID_1},${ID_2}`) => createMockRequest(
  `/api/skatteverket/tax-payments/payment-file?transaction_ids=${ids}&format=pain001`,
)

const row = (id: string, amount: number, due = '2026-10-12') => ({
  id,
  transaktionsdatum: due,
  forfallodatum: due,
  transaktionstext: 'Skatt',
  belopp_skatteverket: amount,
  status: 'upcoming',
})

describe('GET /api/skatteverket/tax-payments/payment-file', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({
      user: { id: 'user-1' },
      supabase: mockSupabase,
      error: null,
    })
    requireWriteMock.mockResolvedValue({ ok: true })
    generatePain001Mock.mockReturnValue('<Document/>')
    resolveBatchDebtorMock.mockResolvedValue({
      ok: true,
      debtor: {
        name: 'Test AB',
        org_number: '5566778899',
        iban: 'SE3550000000054910000003',
        bic: 'ESSESESS',
        bankgiro: '1234567',
        city: 'Stockholm',
      },
    })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    expect((await GET(request(), createMockRouteParams({}))).status).toBe(401)
  })

  it('rejects an invalid selection before querying', async () => {
    const response = await GET(request('not-an-id'), createMockRouteParams({}))
    expect(response.status).toBe(400)
    expect(mockSupabase.from).not.toHaveBeenCalled()
  })

  it('returns 404 when a selected row no longer exists', async () => {
    enqueue({ data: [row(ID_1, -10_000)], error: null })
    enqueue({ data: { name: 'Test AB', org_number: '5566778899', entity_type: 'aktiebolag' } })
    enqueue({ data: { bankgiro: '123-4567' } })
    enqueue({ data: null, error: null })

    expect((await GET(request(), createMockRouteParams({}))).status).toBe(404)
  })

  it('rejects rows with different due dates', async () => {
    enqueue({ data: [row(ID_1, -10_000), row(ID_2, -5_000, '2026-11-12')], error: null })
    enqueue({ data: { name: 'Test AB', org_number: '5566778899', entity_type: 'aktiebolag' } })
    enqueue({ data: { bankgiro: '123-4567' } })
    enqueue({ data: null, error: null })

    const response = await GET(request(), createMockRouteParams({}))
    expect(response.status).toBe(400)
    expect(JSON.stringify(await response.json())).toContain('samma förfallodag')
  })

  it('creates one payment for the selected net charge minus the current balance', async () => {
    enqueue({ data: [row(ID_1, -10_000), row(ID_2, -5_000)], error: null })
    enqueue({ data: { name: 'Test AB', org_number: '5566778899', entity_type: 'aktiebolag' } })
    enqueue({ data: { bankgiro: '123-4567' } })
    enqueue({
      data: { value: { saldo: { saldoSkatteverket: 3_000 } } },
      error: null,
    })

    const response = await GET(request(), createMockRouteParams({}))

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Disposition')).toContain('pain001_skatt_2026-10-12.xml')
    const [, payments] = generatePain001Mock.mock.calls[0]
    expect(payments[0]).toMatchObject({
      amount: 12_000,
      paymentDate: '2026-10-12',
      reference: { type: 'ocr', value: '1655954700217' },
    })
  })

  it('nets a selected credit on the same due date against the selected debits', async () => {
    enqueue({ data: [row(ID_1, -10_000), row(ID_2, 2_000)], error: null })
    enqueue({ data: { name: 'Test AB', org_number: '5566778899', entity_type: 'aktiebolag' } })
    enqueue({ data: { bankgiro: '123-4567' } })
    enqueue({ data: null, error: null })

    const response = await GET(request(), createMockRouteParams({}))

    expect(response.status).toBe(200)
    const [, payments] = generatePain001Mock.mock.calls[0]
    expect(payments[0]).toMatchObject({ amount: 8_000 })
  })
})
