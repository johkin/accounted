import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { generateBankgiroPaymentBgLb } from '@/lib/salary/payment/bg-lb-generator'
import { generateSupplierPain001 } from '@/lib/payments/pain001-supplier'
import { resolveBatchDebtor } from '@/lib/payments/batch-service'
import { resolveSkattekontoOcr, SKATTEKONTO_BANKGIRO } from '@/lib/skatteverket/skattekonto-ocr'
import { validateBankgiroNumber } from '@/lib/bankgiro/luhn'
import { getBranding } from '@/lib/branding/service'
import { parseEntityType, usesPersonnummerAsOrgNumber } from '@/lib/company/entity-type'
import { roundOre } from '@/lib/money'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { adjustDeadlineToNextBankingDay } from '@/lib/tax/swedish-holidays'
import { formatDateISO } from '@/lib/calendar/utils'

type PaymentFormat = 'bg_lb' | 'pain001'

type SelectedRow = {
  id: string
  transaktionsdatum: string
  forfallodatum: string | null
  transaktionstext: string
  belopp_skatteverket: number | string
  status: 'booked' | 'upcoming'
}

const errorResponse = (code: string, message: string, messageEn: string, status: number) =>
  NextResponse.json({ error: { code, message, message_en: messageEn } }, { status })

/**
 * Generate one payment file from selected upcoming Skattekonto debits.
 * Selection controls the funding amount, not allocation at Skatteverket:
 * every payment still lands as an unallocated credit on the tax account.
 */
export const GET = withRouteContext(
  'skattekonto.payment_file',
  async (request, { supabase, companyId }) => {
    const params = new URL(request.url).searchParams
    const ids = [...new Set((params.get('transaction_ids') ?? '').split(',').filter(Boolean))]
    const format = (params.get('format') ?? 'pain001') as PaymentFormat

    if (ids.length === 0 || ids.length > 100 || ids.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) {
      return errorResponse(
        'INVALID_TRANSACTION_SELECTION',
        'Välj mellan 1 och 100 giltiga skattekontohändelser.',
        'Select between 1 and 100 valid tax account events.',
        400,
      )
    }
    if (format !== 'bg_lb' && format !== 'pain001') {
      return errorResponse('INVALID_FORMAT', 'Ogiltigt filformat.', 'Invalid file format.', 400)
    }

    const [{ data: rows, error: rowsError }, { data: company }, { data: settings }, snapshot] =
      await Promise.all([
        supabase
          .from('skattekonto_transactions')
          .select('id, transaktionsdatum, forfallodatum, transaktionstext, belopp_skatteverket, status')
          .eq('company_id', companyId)
          .in('id', ids),
        supabase
          .from('companies')
          .select('name, org_number, entity_type')
          .eq('id', companyId)
          .single(),
        supabase
          .from('company_settings')
          .select('bankgiro')
          .eq('company_id', companyId)
          .single(),
        supabase
          .from('extension_data')
          .select('value')
          .eq('company_id', companyId)
          .eq('extension_id', 'skatteverket')
          .eq('key', 'skattekonto_balance_snapshot')
          .maybeSingle(),
      ])

    if (rowsError) throw rowsError
    if (!rows || rows.length !== ids.length) {
      return errorResponse(
        'TRANSACTION_NOT_FOUND',
        'En eller flera valda skattekontohändelser finns inte längre.',
        'One or more selected tax account events no longer exist.',
        404,
      )
    }
    const selected = rows as SelectedRow[]
    if (selected.some((row) => row.status !== 'upcoming')) {
      return errorResponse(
        'TRANSACTION_NOT_PAYABLE',
        'Endast kommande skattekontohändelser kan ingå i en betalning.',
        'Only upcoming tax account events can be included in a payment.',
        400,
      )
    }

    const dueDates = new Set(selected.map((row) => row.forfallodatum ?? row.transaktionsdatum))
    if (dueDates.size !== 1) {
      return errorResponse(
        'MIXED_DUE_DATES',
        'Välj händelser med samma förfallodag.',
        'Select events with the same due date.',
        400,
      )
    }
    const dueDate = [...dueDates][0]
    const earliestExecutionDate = dueDate < todayIsoStockholm() ? todayIsoStockholm() : dueDate
    const paymentDate = formatDateISO(adjustDeadlineToNextBankingDay(
      new Date(`${earliestExecutionDate}T12:00:00Z`),
    ))
    const selectedNet = roundOre(selected.reduce(
      (sum, row) => sum + Number(row.belopp_skatteverket),
      0,
    ))
    if (selectedNet >= 0) {
      return errorResponse(
        'NO_SELECTED_CHARGE',
        'De valda händelserna ger inget belopp att betala.',
        'The selected events do not result in an amount to pay.',
        400,
      )
    }
    const charge = Math.abs(selectedNet)
    const snapshotValue = snapshot.error ? null : (snapshot.data?.value as
      | { saldo?: { saldoSkatteverket?: unknown } }
      | null
      | undefined)
    const rawBalance = Number(snapshotValue?.saldo?.saldoSkatteverket)
    const balance = snapshotValue && Number.isFinite(rawBalance) ? roundOre(rawBalance) : null
    const amount = balance === null ? charge : Math.max(0, roundOre(charge - balance))
    if (amount <= 0) {
      return errorResponse(
        'PAYMENT_ALREADY_FUNDED',
        'Saldot på skattekontot täcker de valda händelserna.',
        'The tax account balance covers the selected events.',
        400,
      )
    }

    if (!company?.org_number) {
      return errorResponse(
        'ORG_NUMBER_MISSING',
        'Organisationsnummer saknas för företaget.',
        'The company registration number is missing.',
        400,
      )
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
      return errorResponse('OCR_ERROR', getErrorMessage(err), getErrorMessage(err), 400)
    }

    let fileContent: Buffer
    let filename: string
    let contentType: string
    if (format === 'pain001') {
      const debtorResolution = await resolveBatchDebtor(supabase, companyId)
      if (!debtorResolution.ok) {
        return errorResponse(
          'DEBTOR_DETAILS_MISSING',
          'Företagets IBAN, BIC eller organisationsnummer saknas.',
          'The company IBAN, BIC or registration number is missing.',
          400,
        )
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
            messageId: `${getBranding().appName.toUpperCase()}-SKATT-${company.org_number.replace(/\D/g, '')}-${paymentDate}`,
            createdAt: new Date().toISOString(),
          },
        )
        fileContent = Buffer.from(xml, 'utf-8')
      } catch (err) {
        return errorResponse('PAYMENT_FILE_ERROR', getErrorMessage(err), getErrorMessage(err), 400)
      }
      filename = `pain001_skatt_${paymentDate}.xml`
      contentType = 'application/xml; charset=utf-8'
    } else {
      if (!settings?.bankgiro) {
        return errorResponse(
          'BANKGIRO_MISSING',
          'Företagets bankgironummer är inte ifyllt.',
          'The company bankgiro number is missing.',
          400,
        )
      }
      if (!validateBankgiroNumber(settings.bankgiro)) {
        return errorResponse(
          'BANKGIRO_INVALID',
          'Företagets bankgironummer är ogiltigt.',
          'The company bankgiro number is invalid.',
          400,
        )
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
          { paymentDate, periodLabel: paymentDate },
        )
        fileContent = Buffer.from(result.content, 'latin1')
        filename = result.filename
      } catch (err) {
        return errorResponse('PAYMENT_FILE_ERROR', getErrorMessage(err), getErrorMessage(err), 400)
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
