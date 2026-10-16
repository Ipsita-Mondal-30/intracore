-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE');

-- CreateEnum
CREATE TYPE "PeriodStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "JournalStatus" AS ENUM ('DRAFT', 'POSTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "TaxKind" AS ENUM ('TAXABLE', 'EXEMPT', 'NIL_RATED', 'ZERO_RATED', 'NON_GST');

-- CreateEnum
CREATE TYPE "FinanceDocStatus" AS ENUM ('DRAFT', 'POSTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER', 'CHEQUE', 'UPI', 'CARD', 'OTHER');

-- CreateEnum
CREATE TYPE "BankAccountKind" AS ENUM ('BANK', 'CASH');

-- CreateEnum
CREATE TYPE "BankTxnStatus" AS ENUM ('UNRECONCILED', 'RECONCILED', 'IGNORED');

-- CreateEnum
CREATE TYPE "ExpenseClaimStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'PAID', 'CANCELLED');

-- AlterTable
ALTER TABLE "sales_order_lines" ADD COLUMN     "invoicedQty" DECIMAL(18,4) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "tax_rates" ADD COLUMN     "kind" "TaxKind" NOT NULL DEFAULT 'TAXABLE';

-- AlterTable
ALTER TABLE "vendor_bills" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedById" UUID,
ADD COLUMN     "debitedAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "journalEntryId" TEXT,
ADD COLUMN     "paidAmount" DECIMAL(18,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "fiscal_years" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "status" "PeriodStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fiscal_years_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounting_periods" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "fiscalYearId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "status" "PeriodStatus" NOT NULL DEFAULT 'OPEN',
    "closedAt" TIMESTAMP(3),
    "closedById" UUID,

    CONSTRAINT "accounting_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AccountType" NOT NULL,
    "parentId" TEXT,
    "isGroup" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_mappings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,

    CONSTRAINT "account_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entries" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "number" TEXT,
    "date" DATE NOT NULL,
    "periodId" TEXT,
    "status" "JournalStatus" NOT NULL DEFAULT 'DRAFT',
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT,
    "sourceEvent" TEXT NOT NULL DEFAULT 'post',
    "memo" TEXT,
    "totalDebit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalCredit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "reversalOfId" TEXT,
    "postedAt" TIMESTAMP(3),
    "postedById" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_lines" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "debit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "description" TEXT,
    "customerId" TEXT,
    "vendorId" TEXT,
    "bankAccountId" TEXT,

    CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_rate_versions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "taxRateId" TEXT NOT NULL,
    "rate" DECIMAL(6,3) NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_rate_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_accounts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "BankAccountKind" NOT NULL DEFAULT 'BANK',
    "bankName" TEXT,
    "accountNumberLast4" TEXT,
    "ifsc" TEXT,
    "accountId" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_invoices" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "number" TEXT,
    "salesOrderId" TEXT,
    "customerId" TEXT NOT NULL,
    "status" "FinanceDocStatus" NOT NULL DEFAULT 'DRAFT',
    "invoiceDate" DATE NOT NULL,
    "dueDate" DATE NOT NULL,
    "placeOfSupplyState" TEXT,
    "sellerGstin" TEXT,
    "customerGstin" TEXT,
    "billingAddress" TEXT,
    "shippingAddress" TEXT,
    "reverseCharge" BOOLEAN NOT NULL DEFAULT false,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "subtotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "discountTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxableTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "cgstTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "sgstTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "igstTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "grandTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "paidAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "creditedAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "terms" TEXT,
    "journalEntryId" TEXT,
    "postedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "lastReminderAt" TIMESTAMP(3),
    "irn" TEXT,
    "irnStatus" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_invoice_lines" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "salesOrderLineId" TEXT,
    "productId" TEXT,
    "description" TEXT NOT NULL,
    "hsnCode" TEXT,
    "quantity" DECIMAL(18,4) NOT NULL,
    "uomId" TEXT,
    "unitPrice" DECIMAL(18,2) NOT NULL,
    "discountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "taxRateId" TEXT,
    "taxRate" DECIMAL(6,3) NOT NULL DEFAULT 0,
    "taxKind" "TaxKind" NOT NULL DEFAULT 'TAXABLE',
    "grossAmount" DECIMAL(18,2) NOT NULL,
    "discountAmount" DECIMAL(18,2) NOT NULL,
    "taxableAmount" DECIMAL(18,2) NOT NULL,
    "cgstAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "sgstAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "igstAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(18,2) NOT NULL,
    "lineTotal" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "sales_invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_notes" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "number" TEXT,
    "invoiceId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "status" "FinanceDocStatus" NOT NULL DEFAULT 'DRAFT',
    "noteDate" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "subtotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "discountTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxableTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "cgstTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "sgstTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "igstTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "grandTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "appliedAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "journalEntryId" TEXT,
    "postedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_note_lines" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "creditNoteId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "invoiceLineId" TEXT,
    "productId" TEXT,
    "description" TEXT NOT NULL,
    "hsnCode" TEXT,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unitPrice" DECIMAL(18,2) NOT NULL,
    "discountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "taxRateId" TEXT,
    "taxRate" DECIMAL(6,3) NOT NULL DEFAULT 0,
    "taxKind" "TaxKind" NOT NULL DEFAULT 'TAXABLE',
    "grossAmount" DECIMAL(18,2) NOT NULL,
    "discountAmount" DECIMAL(18,2) NOT NULL,
    "taxableAmount" DECIMAL(18,2) NOT NULL,
    "cgstAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "sgstAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "igstAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(18,2) NOT NULL,
    "lineTotal" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "credit_note_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_receipts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "number" TEXT,
    "customerId" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "receiptDate" DATE NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "method" "PaymentMethod" NOT NULL DEFAULT 'BANK_TRANSFER',
    "reference" TEXT,
    "status" "FinanceDocStatus" NOT NULL DEFAULT 'DRAFT',
    "allocatedAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "journalEntryId" TEXT,
    "postedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receivable_allocations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "receiptId" TEXT,
    "creditNoteId" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" TIMESTAMP(3),

    CONSTRAINT "receivable_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "debit_notes" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "number" TEXT,
    "billId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "status" "FinanceDocStatus" NOT NULL DEFAULT 'DRAFT',
    "noteDate" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "subtotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "discountTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxableTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "grandTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "appliedAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "journalEntryId" TEXT,
    "postedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "debit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "debit_note_lines" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "debitNoteId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "billLineId" TEXT,
    "productId" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unitPrice" DECIMAL(18,2) NOT NULL,
    "discountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "taxRateId" TEXT,
    "taxRate" DECIMAL(6,3) NOT NULL DEFAULT 0,
    "grossAmount" DECIMAL(18,2) NOT NULL,
    "discountAmount" DECIMAL(18,2) NOT NULL,
    "taxableAmount" DECIMAL(18,2) NOT NULL,
    "cgstAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "sgstAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "igstAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(18,2) NOT NULL,
    "lineTotal" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "debit_note_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_payments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "number" TEXT,
    "vendorId" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "paymentDate" DATE NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "method" "PaymentMethod" NOT NULL DEFAULT 'BANK_TRANSFER',
    "reference" TEXT,
    "status" "FinanceDocStatus" NOT NULL DEFAULT 'DRAFT',
    "allocatedAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "journalEntryId" TEXT,
    "postedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payable_allocations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "paymentId" TEXT,
    "debitNoteId" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" TIMESTAMP(3),

    CONSTRAINT "payable_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_categories" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "expense_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_claims" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "claimantId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "status" "ExpenseClaimStatus" NOT NULL DEFAULT 'DRAFT',
    "totalAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "submittedAt" TIMESTAMP(3),
    "approvedById" UUID,
    "approvedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "bankAccountId" TEXT,
    "paidAt" TIMESTAMP(3),
    "paymentReference" TEXT,
    "approvalJournalId" TEXT,
    "paymentJournalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expense_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_claim_lines" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "expenseDate" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "taxAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,

    CONSTRAINT "expense_claim_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_imports" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "importedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_transactions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "importId" TEXT,
    "txnDate" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "status" "BankTxnStatus" NOT NULL DEFAULT 'UNRECONCILED',
    "matchedJournalLineId" TEXT,
    "reconciledAt" TIMESTAMP(3),
    "reconciledById" UUID,
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_transfers" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "fromBankAccountId" TEXT NOT NULL,
    "toBankAccountId" TEXT NOT NULL,
    "transferDate" DATE NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "reference" TEXT,
    "status" "FinanceDocStatus" NOT NULL DEFAULT 'POSTED',
    "journalEntryId" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_years_companyId_startDate_key" ON "fiscal_years"("companyId", "startDate");

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_years_organizationId_id_key" ON "fiscal_years"("organizationId", "id");

-- CreateIndex
CREATE INDEX "accounting_periods_companyId_startDate_endDate_idx" ON "accounting_periods"("companyId", "startDate", "endDate");

-- CreateIndex
CREATE UNIQUE INDEX "accounting_periods_companyId_startDate_key" ON "accounting_periods"("companyId", "startDate");

-- CreateIndex
CREATE UNIQUE INDEX "accounting_periods_organizationId_id_key" ON "accounting_periods"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_companyId_code_key" ON "accounts"("companyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_organizationId_id_key" ON "accounts"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_organizationId_companyId_id_key" ON "accounts"("organizationId", "companyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "account_mappings_companyId_key_key" ON "account_mappings"("companyId", "key");

-- CreateIndex
CREATE INDEX "journal_entries_organizationId_companyId_date_idx" ON "journal_entries"("organizationId", "companyId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_companyId_number_key" ON "journal_entries"("companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_companyId_sourceType_sourceId_sourceEvent_key" ON "journal_entries"("companyId", "sourceType", "sourceId", "sourceEvent");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_organizationId_reversalOfId_key" ON "journal_entries"("organizationId", "reversalOfId");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_organizationId_id_key" ON "journal_entries"("organizationId", "id");

-- CreateIndex
CREATE INDEX "journal_lines_companyId_accountId_idx" ON "journal_lines"("companyId", "accountId");

-- CreateIndex
CREATE INDEX "journal_lines_entryId_idx" ON "journal_lines"("entryId");

-- CreateIndex
CREATE UNIQUE INDEX "journal_lines_organizationId_id_key" ON "journal_lines"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tax_rate_versions_taxRateId_effectiveFrom_key" ON "tax_rate_versions"("taxRateId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "bank_accounts_companyId_name_key" ON "bank_accounts"("companyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "bank_accounts_organizationId_id_key" ON "bank_accounts"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "bank_accounts_organizationId_companyId_id_key" ON "bank_accounts"("organizationId", "companyId", "id");

-- CreateIndex
CREATE INDEX "sales_invoices_organizationId_companyId_status_dueDate_idx" ON "sales_invoices"("organizationId", "companyId", "status", "dueDate");

-- CreateIndex
CREATE INDEX "sales_invoices_organizationId_customerId_idx" ON "sales_invoices"("organizationId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "sales_invoices_companyId_number_key" ON "sales_invoices"("companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "sales_invoices_organizationId_id_key" ON "sales_invoices"("organizationId", "id");

-- CreateIndex
CREATE INDEX "sales_invoice_lines_invoiceId_idx" ON "sales_invoice_lines"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "sales_invoice_lines_organizationId_id_key" ON "sales_invoice_lines"("organizationId", "id");

-- CreateIndex
CREATE INDEX "credit_notes_organizationId_customerId_idx" ON "credit_notes"("organizationId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_companyId_number_key" ON "credit_notes"("companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_organizationId_id_key" ON "credit_notes"("organizationId", "id");

-- CreateIndex
CREATE INDEX "credit_note_lines_creditNoteId_idx" ON "credit_note_lines"("creditNoteId");

-- CreateIndex
CREATE UNIQUE INDEX "credit_note_lines_organizationId_id_key" ON "credit_note_lines"("organizationId", "id");

-- CreateIndex
CREATE INDEX "payment_receipts_organizationId_customerId_idx" ON "payment_receipts"("organizationId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_receipts_companyId_number_key" ON "payment_receipts"("companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "payment_receipts_organizationId_id_key" ON "payment_receipts"("organizationId", "id");

-- CreateIndex
CREATE INDEX "receivable_allocations_invoiceId_idx" ON "receivable_allocations"("invoiceId");

-- CreateIndex
CREATE INDEX "receivable_allocations_receiptId_idx" ON "receivable_allocations"("receiptId");

-- CreateIndex
CREATE INDEX "receivable_allocations_creditNoteId_idx" ON "receivable_allocations"("creditNoteId");

-- CreateIndex
CREATE INDEX "debit_notes_organizationId_vendorId_idx" ON "debit_notes"("organizationId", "vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "debit_notes_companyId_number_key" ON "debit_notes"("companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "debit_notes_organizationId_id_key" ON "debit_notes"("organizationId", "id");

-- CreateIndex
CREATE INDEX "debit_note_lines_debitNoteId_idx" ON "debit_note_lines"("debitNoteId");

-- CreateIndex
CREATE UNIQUE INDEX "debit_note_lines_organizationId_id_key" ON "debit_note_lines"("organizationId", "id");

-- CreateIndex
CREATE INDEX "vendor_payments_organizationId_vendorId_idx" ON "vendor_payments"("organizationId", "vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_payments_companyId_number_key" ON "vendor_payments"("companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_payments_organizationId_id_key" ON "vendor_payments"("organizationId", "id");

-- CreateIndex
CREATE INDEX "payable_allocations_billId_idx" ON "payable_allocations"("billId");

-- CreateIndex
CREATE INDEX "payable_allocations_paymentId_idx" ON "payable_allocations"("paymentId");

-- CreateIndex
CREATE INDEX "payable_allocations_debitNoteId_idx" ON "payable_allocations"("debitNoteId");

-- CreateIndex
CREATE UNIQUE INDEX "expense_categories_companyId_name_key" ON "expense_categories"("companyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "expense_categories_organizationId_id_key" ON "expense_categories"("organizationId", "id");

-- CreateIndex
CREATE INDEX "expense_claims_organizationId_claimantId_idx" ON "expense_claims"("organizationId", "claimantId");

-- CreateIndex
CREATE UNIQUE INDEX "expense_claims_companyId_number_key" ON "expense_claims"("companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "expense_claims_organizationId_id_key" ON "expense_claims"("organizationId", "id");

-- CreateIndex
CREATE INDEX "expense_claim_lines_claimId_idx" ON "expense_claim_lines"("claimId");

-- CreateIndex
CREATE UNIQUE INDEX "bank_imports_organizationId_id_key" ON "bank_imports"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "bank_transactions_matchedJournalLineId_key" ON "bank_transactions"("matchedJournalLineId");

-- CreateIndex
CREATE INDEX "bank_transactions_organizationId_bankAccountId_txnDate_idx" ON "bank_transactions"("organizationId", "bankAccountId", "txnDate");

-- CreateIndex
CREATE UNIQUE INDEX "bank_transactions_bankAccountId_dedupeKey_key" ON "bank_transactions"("bankAccountId", "dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "account_transfers_companyId_number_key" ON "account_transfers"("companyId", "number");

-- AddForeignKey
ALTER TABLE "fiscal_years" ADD CONSTRAINT "fiscal_years_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiscal_years" ADD CONSTRAINT "fiscal_years_organizationId_companyId_fkey" FOREIGN KEY ("organizationId", "companyId") REFERENCES "companies"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_organizationId_fiscalYearId_fkey" FOREIGN KEY ("organizationId", "fiscalYearId") REFERENCES "fiscal_years"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_organizationId_companyId_fkey" FOREIGN KEY ("organizationId", "companyId") REFERENCES "companies"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_organizationId_companyId_parentId_fkey" FOREIGN KEY ("organizationId", "companyId", "parentId") REFERENCES "accounts"("organizationId", "companyId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_mappings" ADD CONSTRAINT "account_mappings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_mappings" ADD CONSTRAINT "account_mappings_organizationId_companyId_accountId_fkey" FOREIGN KEY ("organizationId", "companyId", "accountId") REFERENCES "accounts"("organizationId", "companyId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_organizationId_companyId_fkey" FOREIGN KEY ("organizationId", "companyId") REFERENCES "companies"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_organizationId_periodId_fkey" FOREIGN KEY ("organizationId", "periodId") REFERENCES "accounting_periods"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_organizationId_reversalOfId_fkey" FOREIGN KEY ("organizationId", "reversalOfId") REFERENCES "journal_entries"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_organizationId_entryId_fkey" FOREIGN KEY ("organizationId", "entryId") REFERENCES "journal_entries"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_organizationId_companyId_accountId_fkey" FOREIGN KEY ("organizationId", "companyId", "accountId") REFERENCES "accounts"("organizationId", "companyId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_rate_versions" ADD CONSTRAINT "tax_rate_versions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_rate_versions" ADD CONSTRAINT "tax_rate_versions_organizationId_taxRateId_fkey" FOREIGN KEY ("organizationId", "taxRateId") REFERENCES "tax_rates"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_organizationId_companyId_fkey" FOREIGN KEY ("organizationId", "companyId") REFERENCES "companies"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_organizationId_companyId_accountId_fkey" FOREIGN KEY ("organizationId", "companyId", "accountId") REFERENCES "accounts"("organizationId", "companyId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_organizationId_companyId_fkey" FOREIGN KEY ("organizationId", "companyId") REFERENCES "companies"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_organizationId_companyId_branchId_fkey" FOREIGN KEY ("organizationId", "companyId", "branchId") REFERENCES "branches"("organizationId", "companyId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_organizationId_salesOrderId_fkey" FOREIGN KEY ("organizationId", "salesOrderId") REFERENCES "sales_orders"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_organizationId_customerId_fkey" FOREIGN KEY ("organizationId", "customerId") REFERENCES "customers"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoice_lines" ADD CONSTRAINT "sales_invoice_lines_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoice_lines" ADD CONSTRAINT "sales_invoice_lines_organizationId_invoiceId_fkey" FOREIGN KEY ("organizationId", "invoiceId") REFERENCES "sales_invoices"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoice_lines" ADD CONSTRAINT "sales_invoice_lines_organizationId_salesOrderLineId_fkey" FOREIGN KEY ("organizationId", "salesOrderLineId") REFERENCES "sales_order_lines"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoice_lines" ADD CONSTRAINT "sales_invoice_lines_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "products"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoice_lines" ADD CONSTRAINT "sales_invoice_lines_organizationId_taxRateId_fkey" FOREIGN KEY ("organizationId", "taxRateId") REFERENCES "tax_rates"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_organizationId_companyId_fkey" FOREIGN KEY ("organizationId", "companyId") REFERENCES "companies"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_organizationId_companyId_branchId_fkey" FOREIGN KEY ("organizationId", "companyId", "branchId") REFERENCES "branches"("organizationId", "companyId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_organizationId_invoiceId_fkey" FOREIGN KEY ("organizationId", "invoiceId") REFERENCES "sales_invoices"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_organizationId_customerId_fkey" FOREIGN KEY ("organizationId", "customerId") REFERENCES "customers"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_organizationId_creditNoteId_fkey" FOREIGN KEY ("organizationId", "creditNoteId") REFERENCES "credit_notes"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_organizationId_invoiceLineId_fkey" FOREIGN KEY ("organizationId", "invoiceLineId") REFERENCES "sales_invoice_lines"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "products"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_organizationId_taxRateId_fkey" FOREIGN KEY ("organizationId", "taxRateId") REFERENCES "tax_rates"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_organizationId_companyId_fkey" FOREIGN KEY ("organizationId", "companyId") REFERENCES "companies"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_organizationId_customerId_fkey" FOREIGN KEY ("organizationId", "customerId") REFERENCES "customers"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_organizationId_companyId_bankAccountId_fkey" FOREIGN KEY ("organizationId", "companyId", "bankAccountId") REFERENCES "bank_accounts"("organizationId", "companyId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receivable_allocations" ADD CONSTRAINT "receivable_allocations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receivable_allocations" ADD CONSTRAINT "receivable_allocations_organizationId_invoiceId_fkey" FOREIGN KEY ("organizationId", "invoiceId") REFERENCES "sales_invoices"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receivable_allocations" ADD CONSTRAINT "receivable_allocations_organizationId_receiptId_fkey" FOREIGN KEY ("organizationId", "receiptId") REFERENCES "payment_receipts"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receivable_allocations" ADD CONSTRAINT "receivable_allocations_organizationId_creditNoteId_fkey" FOREIGN KEY ("organizationId", "creditNoteId") REFERENCES "credit_notes"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_notes" ADD CONSTRAINT "debit_notes_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_notes" ADD CONSTRAINT "debit_notes_organizationId_companyId_fkey" FOREIGN KEY ("organizationId", "companyId") REFERENCES "companies"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_notes" ADD CONSTRAINT "debit_notes_organizationId_companyId_branchId_fkey" FOREIGN KEY ("organizationId", "companyId", "branchId") REFERENCES "branches"("organizationId", "companyId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_notes" ADD CONSTRAINT "debit_notes_organizationId_billId_fkey" FOREIGN KEY ("organizationId", "billId") REFERENCES "vendor_bills"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_notes" ADD CONSTRAINT "debit_notes_organizationId_vendorId_fkey" FOREIGN KEY ("organizationId", "vendorId") REFERENCES "vendors"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_note_lines" ADD CONSTRAINT "debit_note_lines_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_note_lines" ADD CONSTRAINT "debit_note_lines_organizationId_debitNoteId_fkey" FOREIGN KEY ("organizationId", "debitNoteId") REFERENCES "debit_notes"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_note_lines" ADD CONSTRAINT "debit_note_lines_organizationId_billLineId_fkey" FOREIGN KEY ("organizationId", "billLineId") REFERENCES "vendor_bill_lines"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_note_lines" ADD CONSTRAINT "debit_note_lines_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "products"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "debit_note_lines" ADD CONSTRAINT "debit_note_lines_organizationId_taxRateId_fkey" FOREIGN KEY ("organizationId", "taxRateId") REFERENCES "tax_rates"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_payments" ADD CONSTRAINT "vendor_payments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_payments" ADD CONSTRAINT "vendor_payments_organizationId_companyId_fkey" FOREIGN KEY ("organizationId", "companyId") REFERENCES "companies"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_payments" ADD CONSTRAINT "vendor_payments_organizationId_vendorId_fkey" FOREIGN KEY ("organizationId", "vendorId") REFERENCES "vendors"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_payments" ADD CONSTRAINT "vendor_payments_organizationId_companyId_bankAccountId_fkey" FOREIGN KEY ("organizationId", "companyId", "bankAccountId") REFERENCES "bank_accounts"("organizationId", "companyId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payable_allocations" ADD CONSTRAINT "payable_allocations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payable_allocations" ADD CONSTRAINT "payable_allocations_organizationId_billId_fkey" FOREIGN KEY ("organizationId", "billId") REFERENCES "vendor_bills"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payable_allocations" ADD CONSTRAINT "payable_allocations_organizationId_paymentId_fkey" FOREIGN KEY ("organizationId", "paymentId") REFERENCES "vendor_payments"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payable_allocations" ADD CONSTRAINT "payable_allocations_organizationId_debitNoteId_fkey" FOREIGN KEY ("organizationId", "debitNoteId") REFERENCES "debit_notes"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_organizationId_companyId_fkey" FOREIGN KEY ("organizationId", "companyId") REFERENCES "companies"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_organizationId_companyId_accountId_fkey" FOREIGN KEY ("organizationId", "companyId", "accountId") REFERENCES "accounts"("organizationId", "companyId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_organizationId_companyId_fkey" FOREIGN KEY ("organizationId", "companyId") REFERENCES "companies"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_claimantId_fkey" FOREIGN KEY ("claimantId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_organizationId_companyId_bankAccountId_fkey" FOREIGN KEY ("organizationId", "companyId", "bankAccountId") REFERENCES "bank_accounts"("organizationId", "companyId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_claim_lines" ADD CONSTRAINT "expense_claim_lines_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_claim_lines" ADD CONSTRAINT "expense_claim_lines_organizationId_claimId_fkey" FOREIGN KEY ("organizationId", "claimId") REFERENCES "expense_claims"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_claim_lines" ADD CONSTRAINT "expense_claim_lines_organizationId_categoryId_fkey" FOREIGN KEY ("organizationId", "categoryId") REFERENCES "expense_categories"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_imports" ADD CONSTRAINT "bank_imports_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_imports" ADD CONSTRAINT "bank_imports_organizationId_companyId_bankAccountId_fkey" FOREIGN KEY ("organizationId", "companyId", "bankAccountId") REFERENCES "bank_accounts"("organizationId", "companyId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_organizationId_companyId_bankAccountId_fkey" FOREIGN KEY ("organizationId", "companyId", "bankAccountId") REFERENCES "bank_accounts"("organizationId", "companyId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_organizationId_importId_fkey" FOREIGN KEY ("organizationId", "importId") REFERENCES "bank_imports"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_matchedJournalLineId_fkey" FOREIGN KEY ("matchedJournalLineId") REFERENCES "journal_lines"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_transfers" ADD CONSTRAINT "account_transfers_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_transfers" ADD CONSTRAINT "account_transfers_organizationId_companyId_fkey" FOREIGN KEY ("organizationId", "companyId") REFERENCES "companies"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_transfers" ADD CONSTRAINT "account_transfers_organizationId_companyId_fromBankAccount_fkey" FOREIGN KEY ("organizationId", "companyId", "fromBankAccountId") REFERENCES "bank_accounts"("organizationId", "companyId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_transfers" ADD CONSTRAINT "account_transfers_organizationId_companyId_toBankAccountId_fkey" FOREIGN KEY ("organizationId", "companyId", "toBankAccountId") REFERENCES "bank_accounts"("organizationId", "companyId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;


-- ─── Ledger integrity, enforced by the database ─────────────────────────────

ALTER TABLE "journal_lines"
  ADD CONSTRAINT "journal_lines_amounts_check"
  CHECK ("debit" >= 0 AND "credit" >= 0 AND ("debit" > 0) <> ("credit" > 0));

-- Every posted journal balances. Deferred: checked at commit, after all lines exist.
CREATE OR REPLACE FUNCTION ledger_assert_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_entry text := COALESCE(NEW."entryId", OLD."entryId");
  v_status "JournalStatus";
  v_debit numeric;
  v_credit numeric;
BEGIN
  SELECT "status" INTO v_status FROM "journal_entries" WHERE "id" = v_entry;
  IF v_status IS NULL OR v_status = 'DRAFT' THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM("debit"), 0), COALESCE(SUM("credit"), 0) INTO v_debit, v_credit
    FROM "journal_lines" WHERE "entryId" = v_entry;
  IF v_debit <> v_credit OR v_debit = 0 THEN
    RAISE EXCEPTION 'Unbalanced journal %: debit % <> credit %', v_entry, v_debit, v_credit
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER "journal_lines_balanced"
  AFTER INSERT OR UPDATE OR DELETE ON "journal_lines"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_assert_balanced();

CREATE OR REPLACE FUNCTION ledger_assert_entry_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_debit numeric; v_credit numeric;
BEGIN
  IF NEW."status" = 'DRAFT' THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM("debit"), 0), COALESCE(SUM("credit"), 0) INTO v_debit, v_credit
    FROM "journal_lines" WHERE "entryId" = NEW."id";
  IF v_debit <> v_credit OR v_debit = 0 THEN
    RAISE EXCEPTION 'Unbalanced journal %: debit % <> credit %', NEW."id", v_debit, v_credit
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER "journal_entries_balanced"
  AFTER INSERT OR UPDATE OF "status" ON "journal_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_assert_entry_balanced();

-- Posted journals are immutable: lines can never change, and an entry may only move
-- POSTED -> REVERSED. (Purging a whole tenant requires the explicit, transaction-local
-- setting app.allow_ledger_purge = 'on'; nothing in the app sets it.)
CREATE OR REPLACE FUNCTION ledger_protect_lines() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status "JournalStatus";
BEGIN
  IF current_setting('app.allow_ledger_purge', true) = 'on' THEN RETURN COALESCE(NEW, OLD); END IF;
  SELECT "status" INTO v_status FROM "journal_entries" WHERE "id" = OLD."entryId";
  IF v_status IS NOT NULL AND v_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'Posted journal lines cannot be modified (entry %)', OLD."entryId"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER "journal_lines_immutable"
  BEFORE UPDATE OR DELETE ON "journal_lines"
  FOR EACH ROW EXECUTE FUNCTION ledger_protect_lines();

CREATE OR REPLACE FUNCTION ledger_protect_entries() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.allow_ledger_purge', true) = 'on' THEN RETURN COALESCE(NEW, OLD); END IF;
  IF OLD."status" = 'DRAFT' THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Posted journals cannot be deleted (entry %)', OLD."id" USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" = 'POSTED' AND NEW."status" = 'REVERSED'
     AND NEW."date" = OLD."date" AND NEW."totalDebit" = OLD."totalDebit" AND NEW."totalCredit" = OLD."totalCredit"
     AND NEW."number" IS NOT DISTINCT FROM OLD."number" AND NEW."companyId" = OLD."companyId" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Posted journals cannot be modified (entry %); post a reversal instead', OLD."id"
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER "journal_entries_immutable"
  BEFORE UPDATE OR DELETE ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION ledger_protect_entries();

-- ─── Existing tax rates get an initial version (GST regime start, 1 Jul 2017). ─
INSERT INTO "tax_rate_versions" ("id", "organizationId", "taxRateId", "rate", "effectiveFrom")
SELECT gen_random_uuid()::text, t."organizationId", t."id", t."rate", DATE '2017-07-01'
FROM "tax_rates" t
WHERE NOT EXISTS (SELECT 1 FROM "tax_rate_versions" v WHERE v."taxRateId" = t."id");

-- RLS on the new tables (see 20261016100000_erp_foundation).
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;

-- New system role for existing organizations; permissions come from the code catalog.
INSERT INTO "roles" ("id", "organizationId", "code", "name", "description", "isSystem", "updatedAt")
SELECT gen_random_uuid()::text, o."id", 'accountant', 'Accountant',
       'Invoices, receipts, bills, payments, expenses, ledger and GST reports', true, CURRENT_TIMESTAMP
FROM "organizations" o
ON CONFLICT ("organizationId", "code") DO NOTHING;
