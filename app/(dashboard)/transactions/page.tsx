'use client'

import { useState, useEffect } from 'react'
import { AnimatePresence } from 'framer-motion'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { ToastAction } from '@/components/ui/toast'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import { X } from 'lucide-react'
import TransactionForm from '@/components/transactions/TransactionForm'
import SwipeCategorizationView from '@/components/transactions/SwipeCategorizationView'
import BatchCategorySelector from '@/components/transactions/BatchCategorySelector'
import TransactionStatusBar from '@/components/transactions/TransactionStatusBar'
import TransactionInboxCard from '@/components/transactions/TransactionInboxCard'
import TransactionHistoryList from '@/components/transactions/TransactionHistoryList'
import InboxZeroState from '@/components/transactions/InboxZeroState'
import InvoiceMatchDialog from '@/components/transactions/InvoiceMatchDialog'
import TransactionBookingDialog from '@/components/transactions/TransactionBookingDialog'
import QuickReviewDialog from '@/components/transactions/QuickReviewDialog'

import TemplatePicker from '@/components/transactions/TemplatePicker'
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from '@/components/transactions/transaction-types'
import { getDefaultAccountForCategory, getDefaultVatTreatmentForCategory } from '@/lib/bookkeeping/category-mapping'
import { getTemplateById, type BookingTemplate } from '@/lib/bookkeeping/booking-templates'
import { isCounterpartyTemplateId, extractCounterpartyId } from '@/lib/bookkeeping/counterparty-templates'
import { isLibraryTemplateId } from '@/lib/bookkeeping/template-library'
import type { TransactionWithInvoice, ViewMode, CategorizeHandler } from '@/components/transactions/transaction-types'
import { useCompany } from '@/contexts/CompanyContext'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { formatCurrency, formatDate } from '@/lib/utils'
import type { TransactionCategory, CreateTransactionInput, Invoice, Customer, VatTreatment, EntityType, LinePatternEntry } from '@/types'
import type { SuggestedCategory, SuggestedTemplate } from '@/lib/transactions/category-suggestions'

interface QuickReviewState {
  transaction: TransactionWithInvoice
  category: TransactionCategory
  label: string
  template: BookingTemplate | null
  templateId: string | undefined
  linePattern: LinePatternEntry[] | null
}

export default function TransactionsPage() {
  const { company } = useCompany()
  const [transactions, setTransactions] = useState<TransactionWithInvoice[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [mode, setMode] = useState<ViewMode>('inbox')
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [showSwipeView, setShowSwipeView] = useState(false)
  const [categorySuggestions, setCategorySuggestions] = useState<Record<string, SuggestedCategory[]>>({})
  const [templateSuggestions, setTemplateSuggestions] = useState<Record<string, SuggestedTemplate[]>>({})
  const [isLoadingSuggestions, setIsLoadingSuggestions] = useState(false)
  const [processingId, setProcessingId] = useState<string | null>(null)

  // Batch mode
  const [isBatchMode, setIsBatchMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [showBatchSelector, setShowBatchSelector] = useState(false)
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null)

  // Invoice match dialog
  const [matchDialogOpen, setMatchDialogOpen] = useState(false)
  const [selectedTransaction, setSelectedTransaction] = useState<TransactionWithInvoice | null>(null)
  const [isConfirmingMatch, setIsConfirmingMatch] = useState(false)

  // Booking dialog (journal entry form)
  const [bookingDialogOpen, setBookingDialogOpen] = useState(false)
  const [bookingDialogTransaction, setBookingDialogTransaction] = useState<TransactionWithInvoice | null>(null)

  // Template picker dialog
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false)
  const [templatePickerTransaction, setTemplatePickerTransaction] = useState<TransactionWithInvoice | null>(null)

  // Quick review dialog (suggestion review before booking)
  const [quickReviewOpen, setQuickReviewOpen] = useState(false)
  const [quickReview, setQuickReview] = useState<QuickReviewState | null>(null)

  // Entity type for tooltip context
  const [entityType, setEntityType] = useState<string>('enskild_firma')

  // Pagination
  const [hasMore, setHasMore] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)

  // True uncategorized count from DB (not limited by pagination)
  const [totalUncategorizedCount, setTotalUncategorizedCount] = useState<number | null>(null)

  // Set of transaction IDs that are animating out (just categorized)
  const [exitingIds, setExitingIds] = useState<Set<string>>(new Set())

  const { toast } = useToast()
  const { dialogProps: deleteDialogProps, confirm: confirmDelete } = useDestructiveConfirm()
  const supabase = createClient()

  // Computed lists
  const uncategorizedTransactions = transactions
    .filter((t) => t.is_business === null && !exitingIds.has(t.id))
    .sort((a, b) => {
      const aHasMatch = a.potential_invoice ? 1 : 0
      const bHasMatch = b.potential_invoice ? 1 : 0
      if (aHasMatch !== bHasMatch) return bHasMatch - aHasMatch
      return b.date.localeCompare(a.date)
    })
  const transactionsWithMatches = transactions.filter((t) => t.potential_invoice && !t.invoice_id)

  const PAGE_SIZE = 200

  async function fetchTransactions() {
    if (!company) return
    setIsLoading(true)
    const [{ data: txData, error: txError }, { count: uncatCount }] = await Promise.all([
      supabase
        .from('transactions')
        .select('*')
        .eq('company_id', company.id)
        .order('date', { ascending: false })
        .limit(PAGE_SIZE),
      supabase
        .from('transactions')
        .select('*', { count: 'exact', head: true })
        .eq('company_id', company.id)
        .is('is_business', null),
    ])

    if (txError) {
      toast({ title: 'Kunde inte ladda transaktioner', description: 'Kontrollera din anslutning och försök igen.', variant: 'destructive' })
      setIsLoading(false)
      return
    }

    const potentialInvoiceIds = (txData || [])
      .filter((t) => t.potential_invoice_id)
      .map((t) => t.potential_invoice_id)

    const invoiceResult = potentialInvoiceIds.length > 0
      ? await supabase.from('invoices').select('*, customer:customers(*)').in('id', potentialInvoiceIds)
      : { data: null }

    let invoiceMap: Record<string, Invoice & { customer?: Customer }> = {}
    if (invoiceResult.data) {
      invoiceMap = invoiceResult.data.reduce((acc, inv) => {
        acc[inv.id] = inv
        return acc
      }, {} as Record<string, Invoice & { customer?: Customer }>)
    }

    const transactionsWithInvoices: TransactionWithInvoice[] = (txData || []).map((t) => ({
      ...t,
      potential_invoice: t.potential_invoice_id ? invoiceMap[t.potential_invoice_id] : undefined,
    }))

    setTransactions(transactionsWithInvoices)
    setTotalUncategorizedCount(uncatCount ?? 0)
    setHasMore((txData || []).length >= PAGE_SIZE)
    setIsLoading(false)
  }

  async function loadMoreTransactions() {
    if (!company) return
    setIsLoadingMore(true)
    const offset = transactions.length
    const { data: txData, error: txError } = await supabase
      .from('transactions')
      .select('*')
      .eq('company_id', company.id)
      .order('date', { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1)

    if (txError || !txData) {
      setIsLoadingMore(false)
      return
    }

    setHasMore(txData.length >= PAGE_SIZE)

    const potentialInvoiceIds = txData
      .filter((t) => t.potential_invoice_id)
      .map((t) => t.potential_invoice_id)

    const invoiceResult = potentialInvoiceIds.length > 0
      ? await supabase.from('invoices').select('*, customer:customers(*)').in('id', potentialInvoiceIds)
      : { data: null }

    let invoiceMap: Record<string, Invoice & { customer?: Customer }> = {}
    if (invoiceResult.data) {
      invoiceMap = invoiceResult.data.reduce((acc, inv) => {
        acc[inv.id] = inv
        return acc
      }, {} as Record<string, Invoice & { customer?: Customer }>)
    }

    const newTransactions: TransactionWithInvoice[] = txData.map((t) => ({
      ...t,
      potential_invoice: t.potential_invoice_id ? invoiceMap[t.potential_invoice_id] : undefined,
    }))

    setTransactions((prev) => [...prev, ...newTransactions])
    setIsLoadingMore(false)
  }

  async function fetchCategorySuggestions(txIds: string[]) {
    if (txIds.length === 0) return
    setIsLoadingSuggestions(true)
    try {
      const response = await fetch('/api/transactions/suggest-categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transaction_ids: txIds }),
      })
      if (!response.ok) throw new Error('Failed to fetch suggestions')
      const data = await response.json()
      if (data.suggestions) {
        setCategorySuggestions(data.suggestions)
      }
      if (data.template_suggestions) {
        setTemplateSuggestions(data.template_suggestions)
      }
    } catch {
      // Non-critical
    }
    setIsLoadingSuggestions(false)
  }

  // Fetch transactions and entity type in parallel on mount, then suggestions
  useEffect(() => {
    let cancelled = false

    async function loadAll() {
      // Fetch transactions and entity type in parallel
      const [, entityRes] = await Promise.all([
        fetchTransactions(),
        fetch('/api/settings').then(r => r.json()).catch(() => null),
      ])

      if (cancelled) return

      if (entityRes?.entity_type) {
        setEntityType(entityRes.entity_type)
      }
    }

    loadAll()

    return () => { cancelled = true }
  }, [])

  // Auto-fetch suggestions when transactions load
  useEffect(() => {
    const uncatIds = transactions
      .filter((t) => t.is_business === null)
      .map((t) => t.id)
      .slice(0, 50)
    if (uncatIds.length > 0) {
      fetchCategorySuggestions(uncatIds)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactions.length])

  const handleCategorize: CategorizeHandler = async (id, isBusiness, category, vatTreatment, accountOverride, templateId, inboxItemId) => {
    try {
      setProcessingId(id)
      const response = await fetch(`/api/transactions/${id}/categorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          is_business: isBusiness,
          category,
          vat_treatment: vatTreatment,
          account_override: accountOverride,
          template_id: templateId,
          inbox_item_id: inboxItemId,
        }),
      })

      const result = await response.json()
      if (!response.ok) {
        toast({
          title: 'Kategorisering misslyckades',
          description: getErrorMessage(result, { context: 'transaction', statusCode: response.status }),
          variant: 'destructive',
        })
        setProcessingId(null)
        return null
      }

      // Mark as exiting for animation, then update state
      setExitingIds((prev) => new Set(prev).add(id))
      setTotalUncategorizedCount((prev) => Math.max(0, (prev ?? 1) - 1))

      if (result.journal_entry_created) {
        toast({
          title: 'Bokförd',
          description: 'Transaktion bokförd och verifikation skapad',
          action: (
            <ToastAction altText="Ångra kategorisering" onClick={async () => {
              try {
                const undoRes = await fetch(`/api/transactions/${id}/uncategorize`, { method: 'POST' })
                if (undoRes.ok) {
                  setTransactions((prev) =>
                    prev.map((t) =>
                      t.id === id
                        ? { ...t, is_business: null, category: null as unknown as TransactionCategory, journal_entry_id: null }
                        : t
                    )
                  )
                  setTotalUncategorizedCount((prev) => (prev ?? 0) + 1)
                  toast({ title: 'Ångrad', description: 'Kategorisering har ångrats' })
                } else {
                  const errData = await undoRes.json()
                  toast({
                    title: 'Kunde inte ångra',
                    description: getErrorMessage(errData, { context: 'transaction', statusCode: undoRes.status }),
                    variant: 'destructive',
                  })
                }
              } catch {
                toast({ title: 'Kunde inte ångra', description: 'Kategoriseringen kunde inte ångras. Försök igen.', variant: 'destructive' })
              }
            }}>
              Ångra
            </ToastAction>
          ),
        })
      } else if (result.journal_entry_error) {
        toast({ title: 'Delvis bokförd', description: `Verifikation kunde inte skapas: ${result.journal_entry_error}`, variant: 'destructive' })
      } else {
        toast({ title: 'Delvis bokförd', description: 'Transaktion uppdaterad men verifikation kunde inte skapas' })
      }

      // Update transaction in state after a brief delay for animation
      setExitingIds((prev) => new Set(prev).add(id))
      setTimeout(() => {
        setTransactions((prev) =>
          prev.map((t) =>
            t.id === id
              ? { ...t, is_business: isBusiness, category: result.category, journal_entry_id: result.journal_entry_id }
              : t
          )
        )
        setExitingIds((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
        setProcessingId(null)
      }, 350)

      return result.journal_entry_id || null
    } catch {
      toast({ title: 'Bokföring misslyckades', description: 'Transaktionen kunde inte bokföras. Försök igen.', variant: 'destructive' })
      setProcessingId(null)
      return null
    }
  }

  async function handleMarkPrivate(id: string) {
    await handleCategorize(id, false, 'private')
  }

  async function handleConfirmInvoiceMatch() {
    if (!selectedTransaction?.potential_invoice) return
    setIsConfirmingMatch(true)

    try {
      const response = await fetch(`/api/transactions/${selectedTransaction.id}/match-invoice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoice_id: selectedTransaction.potential_invoice.id }),
      })
      const result = await response.json()
      if (!response.ok) {
        toast({ title: 'Fakturamatchning misslyckades', description: result.error || 'Försök igen.', variant: 'destructive' })
        setIsConfirmingMatch(false)
        return
      }

      toast({
        title: 'Faktura matchad',
        description: `Faktura ${selectedTransaction.potential_invoice.invoice_number} markerad som betald`,
      })
      setMatchDialogOpen(false)

      // Mark as exiting for animation
      setExitingIds((prev) => new Set(prev).add(selectedTransaction.id))
      setTimeout(() => {
        setTransactions((prev) =>
          prev.map((t) =>
            t.id === selectedTransaction.id
              ? {
                  ...t,
                  invoice_id: selectedTransaction.potential_invoice?.id || null,
                  potential_invoice_id: null,
                  potential_invoice: undefined,
                  is_business: true,
                  category: 'income_services' as TransactionCategory,
                  journal_entry_id: result.journal_entry_id,
                }
              : t
          )
        )
        setExitingIds((prev) => {
          const next = new Set(prev)
          next.delete(selectedTransaction.id)
          return next
        })
        setSelectedTransaction(null)
        setIsConfirmingMatch(false)
      }, 350)
    } catch {
      toast({ title: 'Matchning misslyckades', description: 'Transaktionen kunde inte matchas med fakturan. Försök igen.', variant: 'destructive' })
      setIsConfirmingMatch(false)
    }
  }

  async function handleMatchInvoice(transactionId: string, invoiceId: string): Promise<boolean> {
    try {
      const response = await fetch(`/api/transactions/${transactionId}/match-invoice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoice_id: invoiceId }),
      })
      const result = await response.json()
      if (!response.ok) {
        toast({ title: 'Fakturamatchning misslyckades', description: result.error || 'Försök igen.', variant: 'destructive' })
        return false
      }

      const transaction = transactions.find((t) => t.id === transactionId)
      const invoiceNumber = transaction?.potential_invoice?.invoice_number || ''

      setTransactions((prev) =>
        prev.map((t) =>
          t.id === transactionId
            ? {
                ...t,
                invoice_id: invoiceId,
                potential_invoice_id: null,
                potential_invoice: undefined,
                is_business: true,
                category: 'income_services' as TransactionCategory,
                journal_entry_id: result.journal_entry_id,
              }
            : t
        )
      )

      toast({ title: 'Faktura matchad', description: `Faktura ${invoiceNumber} markerad som betald` })
      return true
    } catch {
      toast({ title: 'Matchning misslyckades', description: 'Transaktionen kunde inte matchas med fakturan. Försök igen.', variant: 'destructive' })
      return false
    }
  }

  async function handleCreateTransaction(data: CreateTransactionInput) {
    setIsCreating(true)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      toast({ title: 'Inloggning krävs', description: 'Du måste vara inloggad för att lägga till transaktioner.', variant: 'destructive' })
      setIsCreating(false)
      return
    }

    const { data: transaction, error } = await supabase
      .from('transactions')
      .insert({
        company_id: company!.id,
        user_id: user.id,
        date: data.date,
        description: data.description,
        amount: data.amount,
        currency: data.currency,
        category: data.category || 'uncategorized',
        is_business: null,
        notes: data.notes,
      })
      .select()
      .single()

    if (error) {
      toast({ title: 'Kunde inte skapa transaktion', description: error.message, variant: 'destructive' })
    } else {
      toast({ title: 'Transaktion tillagd', description: `${data.description} har lagts till` })
      setTransactions([transaction, ...transactions])
      setIsDialogOpen(false)
    }
    setIsCreating(false)
  }

  async function handleDeleteTransaction(id: string) {
    const transaction = transactions.find((t) => t.id === id)
    if (!transaction) return

    const ok = await confirmDelete({
      title: 'Ta bort transaktion',
      description: `Är du säker på att du vill ta bort "${transaction.description}"? Åtgärden kan inte ångras.`,
      confirmLabel: 'Ta bort',
      variant: 'destructive',
    })
    if (!ok) return

    try {
      const response = await fetch(`/api/transactions/${id}`, { method: 'DELETE' })
      if (!response.ok) {
        const result = await response.json()
        toast({
          title: 'Kunde inte ta bort',
          description: result.error || 'Försök igen.',
          variant: 'destructive',
        })
        return
      }
      setTransactions((prev) => prev.filter((t) => t.id !== id))
      toast({ title: 'Borttagen', description: 'Transaktionen har tagits bort' })
    } catch {
      toast({
        title: 'Kunde inte ta bort',
        description: 'Transaktionen kunde inte tas bort. Försök igen.',
        variant: 'destructive',
      })
    }
  }

  function handleTransactionBooked(transactionId: string, journalEntryId: string) {
    setExitingIds((prev) => new Set(prev).add(transactionId))
    setTimeout(() => {
      setTransactions((prev) =>
        prev.map((t) =>
          t.id === transactionId
            ? { ...t, is_business: true, journal_entry_id: journalEntryId }
            : t
        )
      )
      setExitingIds((prev) => {
        const next = new Set(prev)
        next.delete(transactionId)
        return next
      })
    }, 350)
    setBookingDialogOpen(false)
    setBookingDialogTransaction(null)
    toast({ title: 'Bokförd', description: 'Transaktion bokförd och verifikation skapad' })
  }

  // Batch mode handlers
  function toggleBatchSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function exitBatchMode() {
    setIsBatchMode(false)
    setSelectedIds(new Set())
  }

  async function handleBatchMarkPrivate() {
    const ids = Array.from(selectedIds)
    setBatchProgress({ done: 0, total: ids.length })
    for (let i = 0; i < ids.length; i++) {
      await handleCategorize(ids[i], false, 'private')
      setBatchProgress({ done: i + 1, total: ids.length })
    }
    setBatchProgress(null)
    toast({ title: 'Klart', description: `${ids.length} transaktioner markerade som privat` })
    exitBatchMode()
  }

  async function handleBatchCategorize(category: TransactionCategory, vatTreatment?: VatTreatment) {
    const ids = Array.from(selectedIds)
    setBatchProgress({ done: 0, total: ids.length })
    let successes = 0
    const failures: string[] = []
    for (let i = 0; i < ids.length; i++) {
      const result = await handleCategorize(ids[i], true, category, vatTreatment)
      if (result) {
        successes++
      } else {
        const tx = transactions.find((t) => t.id === ids[i])
        failures.push(tx?.description || ids[i])
      }
      setBatchProgress({ done: i + 1, total: ids.length })
    }
    setBatchProgress(null)
    setShowBatchSelector(false)
    if (failures.length === 0) {
      toast({ title: 'Klart', description: `${successes} transaktioner bokförda` })
    } else {
      toast({
        title: 'Delvis klart',
        description: `${successes} lyckades, ${failures.length} misslyckades: ${failures.slice(0, 3).join(', ')}${failures.length > 3 ? '...' : ''}`,
        variant: 'destructive',
      })
    }
    exitBatchMode()
  }

  async function openSwipeView() {
    try {
      // Match invoices to transactions
      await fetch('/api/transactions/batch-match-invoices', { method: 'POST' })
        .then((r) => r.json())
        .then((data) => {
          if (data.matched > 0) fetchTransactions()
        })
    } catch {
      // Non-critical
    }
    const uncatIds = uncategorizedTransactions.map((t) => t.id)
    await fetchCategorySuggestions(uncatIds)
    setShowSwipeView(true)
  }

  function openMatchDialog(transaction: TransactionWithInvoice) {
    setSelectedTransaction(transaction)
    setMatchDialogOpen(true)
  }

  function openCategoryDialog(transaction: TransactionWithInvoice) {
    setTemplatePickerTransaction(transaction)
    setTemplatePickerOpen(true)
  }

  function handleOpenQuickReview(transaction: TransactionWithInvoice, suggestion: SuggestedCategory) {
    const allCategories = [...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES]
    const label = allCategories.find((c) => c.value === suggestion.category)?.label || suggestion.label
    setQuickReview({ transaction, category: suggestion.category, label, template: null, templateId: undefined, linePattern: null })
    setQuickReviewOpen(true)
  }

  function handleTemplateSelected(template: BookingTemplate) {
    setTemplatePickerOpen(false)
    const tx = templatePickerTransaction
    if (!tx) return
    // Library templates aren't validated server-side via template_id; the
    // template's debit/credit + VAT drive the booking through account_override.
    const templateId = isLibraryTemplateId(template.id) ? undefined : template.id
    setQuickReview({ transaction: tx, category: template.fallback_category, label: template.name_sv, template, templateId, linePattern: null })
    setQuickReviewOpen(true)
  }

  function handleOpenTemplateReview(transaction: TransactionWithInvoice, templateId: string) {
    if (isCounterpartyTemplateId(templateId)) {
      const cpSuggestion = templateSuggestions[transaction.id]?.find(ts => ts.template_id === templateId)
      if (!cpSuggestion) return
      setQuickReview({
        transaction,
        category: transaction.amount < 0 ? 'expense_other' : 'income_services',
        label: cpSuggestion.name_sv,
        template: { id: templateId, name_sv: cpSuggestion.name_sv } as BookingTemplate,
        templateId: undefined,
        linePattern: cpSuggestion.line_pattern ?? null,
      })
      setQuickReviewOpen(true)
      return
    }

    const template = getTemplateById(templateId)
    if (!template) return
    setQuickReview({
      transaction,
      category: template.fallback_category,
      label: template.name_sv,
      template,
      templateId: template.id,
      linePattern: null,
    })
    setQuickReviewOpen(true)
  }

  function handleChangeTemplate() {
    setQuickReviewOpen(false)
    if (quickReview?.transaction) {
      setTemplatePickerTransaction(quickReview.transaction)
      setTemplatePickerOpen(true)
    }
  }

  function handleManualBooking() {
    setTemplatePickerOpen(false)
    if (templatePickerTransaction) {
      setBookingDialogTransaction(templatePickerTransaction)
      setBookingDialogOpen(true)
    }
  }

  async function handleQuickReviewConfirm(
    id: string,
    category: TransactionCategory,
    vatTreatment: VatTreatment | undefined,
    accountOverride: string | undefined,
    templateId?: string
  ): Promise<string | null> {
    let journalEntryId: string | null
    if (!templateId && quickReview?.template?.id && isCounterpartyTemplateId(quickReview.template.id)) {
      const cpTemplateId = extractCounterpartyId(quickReview.template.id)
      const response = await fetch(`/api/transactions/${id}/categorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          is_business: true,
          counterparty_template_id: cpTemplateId,
        }),
      })
      const result = await response.json()
      if (!response.ok) {
        toast({ title: 'Kategorisering misslyckades', description: result.error || 'Försök igen.', variant: 'destructive' })
        return null
      }
      setExitingIds((prev) => new Set(prev).add(id))
      journalEntryId = result.journal_entry_id || null
    } else {
      journalEntryId = await handleCategorize(id, true, category, vatTreatment, accountOverride, templateId)
    }
    if (journalEntryId) {
      setQuickReviewOpen(false)
      setQuickReview(null)
    }
    return journalEntryId
  }

  // Swipe view
  if (showSwipeView && uncategorizedTransactions.length > 0) {
    return (
      <SwipeCategorizationView
        transactions={uncategorizedTransactions}
        suggestions={categorySuggestions}
        templateSuggestions={templateSuggestions}
        onCategorize={handleCategorize}
        onMatchInvoice={handleMatchInvoice}
        onClose={() => setShowSwipeView(false)}
        entityType={entityType as EntityType}
      />
    )
  }

  return (
    <div className="space-y-6">
      {/* Status bar with mode toggle */}
      <TransactionStatusBar
        uncategorizedCount={totalUncategorizedCount ?? uncategorizedTransactions.length}
        invoiceMatchCount={transactionsWithMatches.length}
        mode={mode}
        onModeChange={setMode}
        onOpenSwipeView={openSwipeView}
        onOpenCreateDialog={() => setIsDialogOpen(true)}
        isLoadingSuggestions={isLoadingSuggestions}
        isBatchMode={isBatchMode}
        onToggleBatchMode={() => (isBatchMode ? exitBatchMode() : setIsBatchMode(true))}
      />

      {/* Content based on mode */}
      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="py-4">
                <div className="flex items-center justify-between">
                  <div className="space-y-2">
                    <div className="h-5 bg-muted rounded w-48" />
                    <div className="h-4 bg-muted rounded w-24" />
                  </div>
                  <div className="h-6 bg-muted rounded w-20" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : mode === 'inbox' ? (
        uncategorizedTransactions.length === 0 ? (
          <InboxZeroState
            hasTransactions={transactions.length > 0}
            onCreateTransaction={() => setIsDialogOpen(true)}
          />
        ) : (
          <div className="space-y-2">
            <AnimatePresence mode="popLayout">
              {uncategorizedTransactions.map((transaction) => (
                <TransactionInboxCard
                  key={transaction.id}
                  transaction={transaction}
                  suggestions={categorySuggestions[transaction.id]}
                  templateSuggestions={templateSuggestions[transaction.id]}
                  processingId={processingId}
                  isBatchMode={isBatchMode}
                  isSelected={selectedIds.has(transaction.id)}
                  entityType={entityType}
                  onCategorize={handleCategorize}
                  onMarkPrivate={handleMarkPrivate}
                  onOpenMatchDialog={openMatchDialog}
                  onOpenCategoryDialog={openCategoryDialog}
                  onDelete={handleDeleteTransaction}
                  onOpenQuickReview={handleOpenQuickReview}
                  onOpenTemplateReview={handleOpenTemplateReview}
                  onToggleSelect={toggleBatchSelect}
                />
              ))}
            </AnimatePresence>
          </div>
        )
      ) : (
        <TransactionHistoryList
          transactions={transactions}
          onOpenMatchDialog={openMatchDialog}
          onOpenCategoryDialog={openCategoryDialog}
          hasMore={hasMore}
          isLoadingMore={isLoadingMore}
          onLoadMore={loadMoreTransactions}
        />
      )}

      {/* Batch mode floating action bar */}
      {isBatchMode && selectedIds.size > 0 && (
        <div className="fixed bottom-20 md:bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 bg-background border rounded-xl shadow-lg px-4 py-3">
          {batchProgress ? (
            <>
              <Badge variant="secondary">
                {batchProgress.done}/{batchProgress.total}
              </Badge>
              <p className="text-sm text-muted-foreground">
                Bokför {batchProgress.done} av {batchProgress.total}...
              </p>
            </>
          ) : (
            <>
              <Badge variant="secondary">{selectedIds.size} valda</Badge>
              <Button variant="ghost" size="sm" onClick={() => setSelectedIds(new Set())}>
                <X className="mr-1 h-3 w-3" />
                Avmarkera
              </Button>
              <Button variant="outline" size="sm" onClick={handleBatchMarkPrivate}>
                Markera som privat
              </Button>
              <Button size="sm" onClick={() => setShowBatchSelector(true)}>
                Bokför {selectedIds.size} st
              </Button>
            </>
          )}
        </div>
      )}

      {/* Dialogs */}
      <BatchCategorySelector
        open={showBatchSelector}
        onOpenChange={setShowBatchSelector}
        selectedCount={selectedIds.size}
        onSelectCategory={handleBatchCategorize}
        progress={batchProgress}
      />

      <InvoiceMatchDialog
        open={matchDialogOpen}
        onOpenChange={setMatchDialogOpen}
        transaction={selectedTransaction}
        isConfirming={isConfirmingMatch}
        onConfirm={handleConfirmInvoiceMatch}
      />

      <TransactionBookingDialog
        open={bookingDialogOpen}
        onOpenChange={setBookingDialogOpen}
        transaction={bookingDialogTransaction}
        onBooked={handleTransactionBooked}
      />

      <Dialog open={templatePickerOpen} onOpenChange={setTemplatePickerOpen}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Välj mall</DialogTitle>
          </DialogHeader>
          {templatePickerTransaction && (
            <div className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
              <span className="truncate text-muted-foreground">{templatePickerTransaction.description}</span>
              <span className="font-medium tabular-nums flex-shrink-0 ml-3">
                {templatePickerTransaction.amount > 0 ? '+' : ''}{formatCurrency(templatePickerTransaction.amount, templatePickerTransaction.currency)}
              </span>
            </div>
          )}
          <TemplatePicker
            direction={templatePickerTransaction && templatePickerTransaction.amount < 0 ? 'expense' : 'income'}
            entityType={entityType as EntityType}
            suggestedTemplates={templatePickerTransaction ? templateSuggestions[templatePickerTransaction.id] : undefined}
            onSelect={handleTemplateSelected}
            onSelectCounterparty={(templateId) => {
              if (!templatePickerTransaction) return
              setTemplatePickerOpen(false)
              handleOpenTemplateReview(templatePickerTransaction, templateId)
            }}
          />
          <div className="pt-2 border-t">
            <Button variant="ghost" size="sm" className="w-full text-muted-foreground" onClick={handleManualBooking}>
              Ange konton manuellt...
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <QuickReviewDialog
        key={quickReview?.transaction.id ?? '' + String(quickReview?.category) + String(quickReview?.templateId) + String(quickReview?.template?.id)}
        open={quickReviewOpen}
        onOpenChange={setQuickReviewOpen}
        transaction={quickReview?.transaction ?? null}
        category={quickReview?.category ?? null}
        categoryLabel={quickReview?.label ?? ''}
        defaultAccount={
          // For library templates (no templateId but a template object), use the
          // template's debit account as the default; otherwise fall back to the
          // category's default account.
          !quickReview?.templateId && quickReview?.template
            ? quickReview.template.debit_account
            : quickReview?.category ? getDefaultAccountForCategory(quickReview.category) : ''
        }
        defaultVat={
          !quickReview?.templateId && quickReview?.template
            ? (quickReview.template.vat_treatment ?? 'none')
            : quickReview?.category ? (getDefaultVatTreatmentForCategory(quickReview.category) ?? 'none') : 'none'
        }
        entityType={entityType as EntityType}
        template={quickReview?.template ?? null}
        templateId={quickReview?.templateId}
        counterpartyLinePattern={quickReview?.linePattern ?? null}
        onConfirm={handleQuickReviewConfirm}
        onChangeTemplate={handleChangeTemplate}
      />

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Lägg till transaktion</DialogTitle>
          </DialogHeader>
          <TransactionForm onSubmit={handleCreateTransaction} isLoading={isCreating} />
        </DialogContent>
      </Dialog>

      <DestructiveConfirmDialog {...deleteDialogProps} />
    </div>
  )
}
