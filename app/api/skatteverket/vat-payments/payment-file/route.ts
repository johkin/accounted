import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { generateBankgiroPaymentBgLb } from '@/lib/salary/payment/bg-lb-generator'
import { generateSupplierPain001 } from '@/lib/payments/pain001-supplier'
import { resolveBatchDebtor } from '@/lib/payments/batch-service'
import { resolveSkattekontoOcr, SKATTEKONTO_BANKGIRO } from '@/lib/skatteverket/skattekonto-ocr'
import { validateBankgiroNumber } from '@/lib/bankgiro/luhn'
import { getBranding } from '@/lib/branding/service'
import { calculateVatDeclaration } from '@/lib/reports/vat-declaration'
import { buildFiledAmounts } from '@/lib/reports/vat-manual-filing'
import { getVatDeadlineForPeriod } from '@/lib/tax/deadline-config'
import { adjustDeadlineToNextBankingDay } from '@/lib/tax/swedish-holidays'
import { formatDateISO } from '@/lib/calendar/utils'
import { parseEntityType, usesPersonnummerAsOrgNumber } from '@/lib/company/entity-type'
import type { VatPeriodType } from '@/types'

type PaymentFormat = 'bg_lb' | 'pain001'

/**
 * Generate a payment file for the positive net amount in a VAT declaration.
 * The amount is derived from the same whole-krona filing projection as the
 * eSKD XML and PDF, so the bank instruction cannot disagree with ruta 49.
 */
export const GET = withRouteContext(
  'vat_tax_payment.payment_file',
  async (request, { supabase, companyId }) => {
    const params = new URL(request.url).searchParams
    const periodType = params.get('periodType') as VatPeriodType | null
    const year = Number(params.get('year'))
    const period = Number(params.get('period'))
    const fiscalPeriodId = params.get('fiscal_period_id') ?? undefined
    const format = (params.get('format') ?? 'bg_lb') as PaymentFormat

    if (!periodType || !['monthly', 'quarterly', 'yearly'].includes(periodType)) {
      return NextResponse.json({ error: 'Ogiltig redovisningsperiod för moms.' }, { status: 400 })
    }
    const maxPeriod = periodType === 'monthly' ? 12 : periodType === 'quarterly' ? 4 : 1
    if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(period) || period < 1 || period > maxPeriod) {
      return NextResponse.json({ error: 'Ogiltigt år eller periodnummer.' }, { status: 400 })
    }
    if (format !== 'bg_lb' && format !== 'pain001') {
      return NextResponse.json({ error: 'Ogiltigt filformat. Använd bg_lb eller pain001.' }, { status: 400 })
    }
    if (periodType === 'yearly' && !fiscalPeriodId) {
      return NextResponse.json({ error: 'Räkenskapsår saknas för helårsmoms.' }, { status: 400 })
    }

    let amount: number
    try {
      const declaration = await calculateVatDeclaration(
        supabase,
        companyId,
        periodType,
        year,
        period,
        { fiscalPeriodId },
      )
      amount = buildFiledAmounts(declaration.rutor).net
    } catch (err) {
      return NextResponse.json({ error: getErrorMessage(err) }, { status: 400 })
    }

    if (amount <= 0) {
      return NextResponse.json(
        { error: amount < 0 ? 'Momsdeklarationen visar moms att återfå, inte att betala.' : 'Momsdeklarationen har inget belopp att betala.' },
        { status: 400 },
      )
    }

    const [{ data: company }, { data: settings }] = await Promise.all([
      supabase
        .from('companies')
        .select('name, org_number, entity_type')
        .eq('id', companyId)
        .single(),
      supabase
        .from('company_settings')
        .select('bankgiro, fiscal_year_start_month, vat_has_eu_trade, vat_filing_method, vat_taxable_base_over_40m')
        .eq('company_id', companyId)
        .single(),
    ])

    if (!company?.org_number) {
      return NextResponse.json({ error: 'Organisationsnummer saknas för företaget.' }, { status: 400 })
    }

    const entityType = parseEntityType(company.entity_type)
    let ocr: string
    try {
      ocr = await resolveSkattekontoOcr(
        supabase,
        companyId,
        company.org_number,
        usesPersonnummerAsOrgNumber(entityType) ? 'enskild_firma' : 'aktiebolag',
      )
    } catch (err) {
      return NextResponse.json({ error: getErrorMessage(err) }, { status: 400 })
    }

    const deadline = getVatDeadlineForPeriod(periodType, year, period, {
      entity_type: entityType,
      fiscal_year_start_month: settings?.fiscal_year_start_month,
      vat_has_eu_trade: settings?.vat_has_eu_trade,
      vat_filing_method: settings?.vat_filing_method,
      vat_taxable_base_over_40m: settings?.vat_taxable_base_over_40m,
    })
    if (!deadline) {
      return NextResponse.json({ error: 'Förfallodatum kunde inte beräknas från företagets skatteinställningar.' }, { status: 400 })
    }
    const paymentDate = formatDateISO(
      adjustDeadlineToNextBankingDay(new Date(deadline.year, deadline.month, deadline.day)),
    )
    const periodKey = deadline.period.replace(/[^0-9A-Za-z-]/g, '-')

    let fileContent: Buffer
    let filename: string
    let contentType: string

    if (format === 'pain001') {
      const debtorResolution = await resolveBatchDebtor(supabase, companyId)
      if (!debtorResolution.ok) {
        const message = {
          iban: 'Företagets IBAN saknas i företagsinställningar.',
          bic: 'Företagsbankens BIC saknas och kunde inte härledas.',
          org_number: 'Organisationsnummer saknas för företaget.',
        }[debtorResolution.missing]
        return NextResponse.json({ error: message }, { status: 400 })
      }
      const debtor = debtorResolution.debtor
      try {
        const xml = generateSupplierPain001(
          {
            name: debtor.name,
            orgNumber: debtor.org_number,
            iban: debtor.iban,
            bic: debtor.bic,
            bankgiro: debtor.bankgiro,
            city: debtor.city,
          },
          [{
            payee: { type: 'bankgiro', bankgiro: SKATTEKONTO_BANKGIRO.replace(/\D/g, '') },
            payeeName: 'Skatteverket',
            payeeCity: 'Solna',
            amount,
            paymentDate,
            reference: { type: 'ocr', value: ocr },
          }],
          {
            messageId: `${getBranding().appName.toUpperCase()}-MOMS-${company.org_number.replace(/\D/g, '')}-${periodKey}`,
            createdAt: new Date().toISOString(),
          },
        )
        fileContent = Buffer.from(xml, 'utf-8')
      } catch (err) {
        return NextResponse.json({ error: getErrorMessage(err) }, { status: 400 })
      }
      filename = `pain001_moms_${periodKey}.xml`
      contentType = 'application/xml; charset=utf-8'
    } else {
      if (!settings?.bankgiro) {
        return NextResponse.json({ error: 'Företagets bankgironummer är inte ifyllt.' }, { status: 400 })
      }
      if (!validateBankgiroNumber(settings.bankgiro)) {
        return NextResponse.json({ error: 'Bankgironumret är ogiltigt (felaktig kontrollsiffra).' }, { status: 400 })
      }
      try {
        const result = generateBankgiroPaymentBgLb(
          { name: company.name, senderBankgiro: settings.bankgiro },
          {
            receiverBankgiro: SKATTEKONTO_BANKGIRO,
            ocr,
            amount,
            receiverName: 'Skatteverket',
          },
          { paymentDate, periodLabel: periodKey },
        )
        fileContent = Buffer.from(result.content, 'latin1')
        filename = result.filename
      } catch (err) {
        return NextResponse.json({ error: getErrorMessage(err) }, { status: 400 })
      }
      contentType = 'text/plain; charset=iso-8859-1'
    }

    return new Response(new Uint8Array(fileContent), {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  },
  { requireWrite: true },
)
