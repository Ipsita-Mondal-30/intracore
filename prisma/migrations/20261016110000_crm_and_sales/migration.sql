-- CreateEnum
CREATE TYPE "CustomerType" AS ENUM ('BUSINESS', 'INDIVIDUAL');

-- CreateEnum
CREATE TYPE "OpportunityStage" AS ENUM ('PROSPECTING', 'QUALIFICATION', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('NOTE', 'CALL', 'EMAIL', 'MEETING');

-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('GOODS', 'SERVICE');

-- CreateEnum
CREATE TYPE "QuotationStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "SalesOrderStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'PARTIALLY_DELIVERED', 'DELIVERED', 'CANCELLED');

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "convertedContactId" TEXT,
ADD COLUMN     "convertedCustomerId" TEXT;

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT,
    "name" TEXT NOT NULL,
    "legalName" TEXT,
    "type" "CustomerType" NOT NULL DEFAULT 'BUSINESS',
    "email" TEXT,
    "phone" TEXT,
    "website" TEXT,
    "gstin" TEXT,
    "pan" TEXT,
    "stateCode" TEXT,
    "billingAddress" TEXT,
    "shippingAddress" TEXT,
    "paymentTermsDays" INTEGER,
    "creditLimit" DECIMAL(18,2),
    "ownerUserId" UUID,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT,
    "fullName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "jobTitle" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opportunities" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "contactId" TEXT,
    "leadId" TEXT,
    "name" TEXT NOT NULL,
    "stage" "OpportunityStage" NOT NULL DEFAULT 'PROSPECTING',
    "probability" INTEGER NOT NULL DEFAULT 10,
    "amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "expectedCloseDate" DATE,
    "ownerUserId" UUID,
    "lossReason" TEXT,
    "closedAt" TIMESTAMP(3),
    "description" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "opportunities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_activities" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "type" "ActivityType" NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT,
    "direction" "CommunicationDirection",
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "durationMin" INTEGER,
    "outcome" TEXT,
    "customerId" TEXT,
    "contactId" TEXT,
    "opportunityId" TEXT,
    "actorId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "uoms" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uoms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_categories" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_rates" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rate" DECIMAL(6,3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "barcode" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "ProductType" NOT NULL DEFAULT 'GOODS',
    "categoryId" TEXT,
    "uomId" TEXT NOT NULL,
    "hsnCode" TEXT,
    "taxRateId" TEXT,
    "salesPrice" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "purchasePrice" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_prices" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "unitPrice" DECIMAL(18,2) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "previousRevisionId" TEXT,
    "customerId" TEXT NOT NULL,
    "contactId" TEXT,
    "opportunityId" TEXT,
    "status" "QuotationStatus" NOT NULL DEFAULT 'DRAFT',
    "issueDate" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validUntil" DATE NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "placeOfSupplyState" TEXT,
    "terms" TEXT,
    "notes" TEXT,
    "subtotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "discountTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxableTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "grandTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "approvalRequired" BOOLEAN NOT NULL DEFAULT false,
    "approvalReason" TEXT,
    "approvalNote" TEXT,
    "submittedAt" TIMESTAMP(3),
    "approvedById" UUID,
    "approvedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quotations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotation_lines" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "quotationId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "productId" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "uomId" TEXT,
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

    CONSTRAINT "quotation_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_orders" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "quotationId" TEXT,
    "customerId" TEXT NOT NULL,
    "contactId" TEXT,
    "status" "SalesOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "orderDate" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expectedDeliveryDate" DATE,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "placeOfSupplyState" TEXT,
    "customerPoNumber" TEXT,
    "shippingAddress" TEXT,
    "deliveryInstructions" TEXT,
    "notes" TEXT,
    "subtotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "discountTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxableTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "grandTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "amendmentCount" INTEGER NOT NULL DEFAULT 0,
    "confirmedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_order_lines" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "salesOrderId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "quotationLineId" TEXT,
    "productId" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "uomId" TEXT,
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
    "deliveredQty" DECIMAL(18,4) NOT NULL DEFAULT 0,

    CONSTRAINT "sales_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customers_organizationId_name_idx" ON "customers"("organizationId", "name");

-- CreateIndex
CREATE INDEX "customers_organizationId_email_idx" ON "customers"("organizationId", "email");

-- CreateIndex
CREATE INDEX "customers_organizationId_phone_idx" ON "customers"("organizationId", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "customers_organizationId_id_key" ON "customers"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "customers_organizationId_code_key" ON "customers"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "customers_organizationId_gstin_key" ON "customers"("organizationId", "gstin");

-- CreateIndex
CREATE INDEX "contacts_organizationId_customerId_idx" ON "contacts"("organizationId", "customerId");

-- CreateIndex
CREATE INDEX "contacts_organizationId_email_idx" ON "contacts"("organizationId", "email");

-- CreateIndex
CREATE INDEX "contacts_organizationId_phone_idx" ON "contacts"("organizationId", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_organizationId_id_key" ON "contacts"("organizationId", "id");

-- CreateIndex
CREATE INDEX "opportunities_organizationId_stage_idx" ON "opportunities"("organizationId", "stage");

-- CreateIndex
CREATE INDEX "opportunities_organizationId_customerId_idx" ON "opportunities"("organizationId", "customerId");

-- CreateIndex
CREATE INDEX "opportunities_organizationId_ownerUserId_idx" ON "opportunities"("organizationId", "ownerUserId");

-- CreateIndex
CREATE INDEX "opportunities_organizationId_expectedCloseDate_idx" ON "opportunities"("organizationId", "expectedCloseDate");

-- CreateIndex
CREATE UNIQUE INDEX "opportunities_organizationId_leadId_key" ON "opportunities"("organizationId", "leadId");

-- CreateIndex
CREATE UNIQUE INDEX "opportunities_organizationId_id_key" ON "opportunities"("organizationId", "id");

-- CreateIndex
CREATE INDEX "crm_activities_organizationId_customerId_occurredAt_idx" ON "crm_activities"("organizationId", "customerId", "occurredAt");

-- CreateIndex
CREATE INDEX "crm_activities_organizationId_contactId_occurredAt_idx" ON "crm_activities"("organizationId", "contactId", "occurredAt");

-- CreateIndex
CREATE INDEX "crm_activities_organizationId_opportunityId_occurredAt_idx" ON "crm_activities"("organizationId", "opportunityId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "uoms_organizationId_code_key" ON "uoms"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "uoms_organizationId_id_key" ON "uoms"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_categories_organizationId_name_key" ON "product_categories"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "product_categories_organizationId_id_key" ON "product_categories"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tax_rates_organizationId_name_key" ON "tax_rates"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "tax_rates_organizationId_id_key" ON "tax_rates"("organizationId", "id");

-- CreateIndex
CREATE INDEX "products_organizationId_name_idx" ON "products"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "products_organizationId_sku_key" ON "products"("organizationId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "products_organizationId_barcode_key" ON "products"("organizationId", "barcode");

-- CreateIndex
CREATE UNIQUE INDEX "products_organizationId_id_key" ON "products"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_prices_customerId_productId_key" ON "customer_prices"("customerId", "productId");

-- CreateIndex
CREATE INDEX "quotations_organizationId_companyId_status_idx" ON "quotations"("organizationId", "companyId", "status");

-- CreateIndex
CREATE INDEX "quotations_organizationId_customerId_idx" ON "quotations"("organizationId", "customerId");

-- CreateIndex
CREATE INDEX "quotations_organizationId_opportunityId_idx" ON "quotations"("organizationId", "opportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "quotations_companyId_number_revision_key" ON "quotations"("companyId", "number", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "quotations_organizationId_previousRevisionId_key" ON "quotations"("organizationId", "previousRevisionId");

-- CreateIndex
CREATE UNIQUE INDEX "quotations_organizationId_id_key" ON "quotations"("organizationId", "id");

-- CreateIndex
CREATE INDEX "quotation_lines_quotationId_idx" ON "quotation_lines"("quotationId");

-- CreateIndex
CREATE UNIQUE INDEX "quotation_lines_organizationId_id_key" ON "quotation_lines"("organizationId", "id");

-- CreateIndex
CREATE INDEX "sales_orders_organizationId_companyId_status_idx" ON "sales_orders"("organizationId", "companyId", "status");

-- CreateIndex
CREATE INDEX "sales_orders_organizationId_customerId_idx" ON "sales_orders"("organizationId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "sales_orders_companyId_number_key" ON "sales_orders"("companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "sales_orders_organizationId_quotationId_key" ON "sales_orders"("organizationId", "quotationId");

-- CreateIndex
CREATE UNIQUE INDEX "sales_orders_organizationId_id_key" ON "sales_orders"("organizationId", "id");

-- CreateIndex
CREATE INDEX "sales_order_lines_salesOrderId_idx" ON "sales_order_lines"("salesOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_lines_organizationId_id_key" ON "sales_order_lines"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "leads_organizationId_id_key" ON "leads"("organizationId", "id");

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_organizationId_convertedCustomerId_fkey" FOREIGN KEY ("organizationId", "convertedCustomerId") REFERENCES "customers"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_organizationId_convertedContactId_fkey" FOREIGN KEY ("organizationId", "convertedContactId") REFERENCES "contacts"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_organizationId_customerId_fkey" FOREIGN KEY ("organizationId", "customerId") REFERENCES "customers"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_organizationId_customerId_fkey" FOREIGN KEY ("organizationId", "customerId") REFERENCES "customers"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_organizationId_contactId_fkey" FOREIGN KEY ("organizationId", "contactId") REFERENCES "contacts"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_organizationId_leadId_fkey" FOREIGN KEY ("organizationId", "leadId") REFERENCES "leads"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_organizationId_customerId_fkey" FOREIGN KEY ("organizationId", "customerId") REFERENCES "customers"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_organizationId_contactId_fkey" FOREIGN KEY ("organizationId", "contactId") REFERENCES "contacts"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_organizationId_opportunityId_fkey" FOREIGN KEY ("organizationId", "opportunityId") REFERENCES "opportunities"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uoms" ADD CONSTRAINT "uoms_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_organizationId_parentId_fkey" FOREIGN KEY ("organizationId", "parentId") REFERENCES "product_categories"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_organizationId_categoryId_fkey" FOREIGN KEY ("organizationId", "categoryId") REFERENCES "product_categories"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_organizationId_uomId_fkey" FOREIGN KEY ("organizationId", "uomId") REFERENCES "uoms"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_organizationId_taxRateId_fkey" FOREIGN KEY ("organizationId", "taxRateId") REFERENCES "tax_rates"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_prices" ADD CONSTRAINT "customer_prices_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_prices" ADD CONSTRAINT "customer_prices_organizationId_customerId_fkey" FOREIGN KEY ("organizationId", "customerId") REFERENCES "customers"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_prices" ADD CONSTRAINT "customer_prices_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "products"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_organizationId_companyId_fkey" FOREIGN KEY ("organizationId", "companyId") REFERENCES "companies"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_organizationId_companyId_branchId_fkey" FOREIGN KEY ("organizationId", "companyId", "branchId") REFERENCES "branches"("organizationId", "companyId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_organizationId_customerId_fkey" FOREIGN KEY ("organizationId", "customerId") REFERENCES "customers"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_organizationId_contactId_fkey" FOREIGN KEY ("organizationId", "contactId") REFERENCES "contacts"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_organizationId_opportunityId_fkey" FOREIGN KEY ("organizationId", "opportunityId") REFERENCES "opportunities"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_organizationId_previousRevisionId_fkey" FOREIGN KEY ("organizationId", "previousRevisionId") REFERENCES "quotations"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_organizationId_quotationId_fkey" FOREIGN KEY ("organizationId", "quotationId") REFERENCES "quotations"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "products"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_organizationId_uomId_fkey" FOREIGN KEY ("organizationId", "uomId") REFERENCES "uoms"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_organizationId_taxRateId_fkey" FOREIGN KEY ("organizationId", "taxRateId") REFERENCES "tax_rates"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_organizationId_companyId_fkey" FOREIGN KEY ("organizationId", "companyId") REFERENCES "companies"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_organizationId_companyId_branchId_fkey" FOREIGN KEY ("organizationId", "companyId", "branchId") REFERENCES "branches"("organizationId", "companyId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_organizationId_quotationId_fkey" FOREIGN KEY ("organizationId", "quotationId") REFERENCES "quotations"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_organizationId_customerId_fkey" FOREIGN KEY ("organizationId", "customerId") REFERENCES "customers"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_organizationId_contactId_fkey" FOREIGN KEY ("organizationId", "contactId") REFERENCES "contacts"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_organizationId_salesOrderId_fkey" FOREIGN KEY ("organizationId", "salesOrderId") REFERENCES "sales_orders"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_organizationId_quotationLineId_fkey" FOREIGN KEY ("organizationId", "quotationLineId") REFERENCES "quotation_lines"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "products"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_organizationId_uomId_fkey" FOREIGN KEY ("organizationId", "uomId") REFERENCES "uoms"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_organizationId_taxRateId_fkey" FOREIGN KEY ("organizationId", "taxRateId") REFERENCES "tax_rates"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;


-- ─── Default catalog data for existing organizations (new orgs get the same in code:
-- src/features/catalog/defaults.ts). ──────────────────────────────────────────────
INSERT INTO "uoms" ("id", "organizationId", "code", "name")
SELECT gen_random_uuid()::text, o."id", u.code, u.name
FROM "organizations" o
CROSS JOIN (VALUES ('NOS', 'Numbers'), ('KG', 'Kilogram'), ('LTR', 'Litre'), ('MTR', 'Metre'), ('BOX', 'Box'), ('HRS', 'Hours')) AS u(code, name)
ON CONFLICT ("organizationId", "code") DO NOTHING;

INSERT INTO "tax_rates" ("id", "organizationId", "name", "rate", "updatedAt")
SELECT gen_random_uuid()::text, o."id", t.name, t.rate, CURRENT_TIMESTAMP
FROM "organizations" o
CROSS JOIN (VALUES ('GST 0%', 0), ('GST 5%', 5), ('GST 12%', 12), ('GST 18%', 18), ('GST 28%', 28)) AS t(name, rate)
ON CONFLICT ("organizationId", "name") DO NOTHING;

-- RLS on the new tables (see 20261016100000_erp_foundation).
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;
