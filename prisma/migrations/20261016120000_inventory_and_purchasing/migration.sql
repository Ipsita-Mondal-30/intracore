-- CreateEnum
CREATE TYPE "TrackingMode" AS ENUM ('NONE', 'BATCH', 'SERIAL');

-- CreateEnum
CREATE TYPE "StockEntryType" AS ENUM ('OPENING', 'RECEIPT', 'ISSUE', 'ADJUSTMENT', 'TRANSFER', 'GOODS_RECEIPT', 'DELIVERY', 'SALES_RETURN', 'PURCHASE_RETURN');

-- CreateEnum
CREATE TYPE "StockEntryStatus" AS ENUM ('DRAFT', 'POSTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED', 'CLOSED');

-- CreateEnum
CREATE TYPE "VendorBillStatus" AS ENUM ('DRAFT', 'POSTED', 'CANCELLED');

-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "vendorId" TEXT;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "hasExpiry" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reorderLevel" DECIMAL(18,4),
ADD COLUMN     "reorderQty" DECIMAL(18,4),
ADD COLUMN     "trackInventory" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "trackingMode" "TrackingMode" NOT NULL DEFAULT 'NONE';

-- AlterTable
ALTER TABLE "sales_order_lines" ADD COLUMN     "returnedQty" DECIMAL(18,4) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "sales_orders" ADD COLUMN     "warehouseId" TEXT;

-- CreateTable
CREATE TABLE "uom_conversions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "uomId" TEXT NOT NULL,
    "factor" DECIMAL(18,6) NOT NULL,

    CONSTRAINT "uom_conversions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouses" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storage_locations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "storage_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_lots" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "lotNumber" TEXT NOT NULL,
    "expiryDate" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_entries" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT,
    "number" TEXT NOT NULL,
    "type" "StockEntryType" NOT NULL,
    "status" "StockEntryStatus" NOT NULL DEFAULT 'DRAFT',
    "sourceWarehouseId" TEXT,
    "targetWarehouseId" TEXT,
    "purchaseOrderId" TEXT,
    "salesOrderId" TEXT,
    "vendorId" TEXT,
    "customerId" TEXT,
    "returnOfId" TEXT,
    "reference" TEXT,
    "notes" TEXT,
    "postedAt" TIMESTAMP(3),
    "postedById" UUID,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_entry_lines" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "uomId" TEXT,
    "baseQuantity" DECIMAL(18,4) NOT NULL,
    "unitCost" DECIMAL(18,4),
    "lotNumber" TEXT,
    "expiryDate" DATE,
    "lotId" TEXT,
    "sourceLocationId" TEXT,
    "targetLocationId" TEXT,
    "purchaseOrderLineId" TEXT,
    "salesOrderLineId" TEXT,
    "returnOfLineId" TEXT,

    CONSTRAINT "stock_entry_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_moves" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "lotId" TEXT,
    "entryId" TEXT NOT NULL,
    "entryLineId" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unitCost" DECIMAL(18,4) NOT NULL,
    "value" DECIMAL(18,2) NOT NULL,
    "isReversal" BOOLEAN NOT NULL DEFAULT false,
    "movedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_moves_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_balances" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "lotId" TEXT,
    "lotKey" TEXT NOT NULL DEFAULT '',
    "quantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_valuations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "value" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "averageCost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_valuations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_reservations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "salesOrderLineId" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendors" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT,
    "name" TEXT NOT NULL,
    "legalName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "gstin" TEXT,
    "pan" TEXT,
    "stateCode" TEXT,
    "address" TEXT,
    "paymentTermsDays" INTEGER,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "orderDate" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expectedDate" DATE,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "supplierState" TEXT,
    "notes" TEXT,
    "subtotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "discountTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxableTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "grandTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "approvalRequired" BOOLEAN NOT NULL DEFAULT false,
    "approvalReason" TEXT,
    "approvalNote" TEXT,
    "approvedById" UUID,
    "approvedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_lines" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "productId" TEXT NOT NULL,
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
    "receivedQty" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "returnedQty" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "billedQty" DECIMAL(18,4) NOT NULL DEFAULT 0,

    CONSTRAINT "purchase_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_bills" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "vendorInvoiceNumber" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "purchaseOrderId" TEXT,
    "status" "VendorBillStatus" NOT NULL DEFAULT 'DRAFT',
    "billDate" DATE NOT NULL,
    "dueDate" DATE,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "supplierState" TEXT,
    "notes" TEXT,
    "subtotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "discountTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxableTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "grandTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "postedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_bill_lines" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "purchaseOrderLineId" TEXT,
    "goodsReceiptLineId" TEXT,
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

    CONSTRAINT "vendor_bill_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uom_conversions_productId_uomId_key" ON "uom_conversions"("productId", "uomId");

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_companyId_code_key" ON "warehouses"("companyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_organizationId_id_key" ON "warehouses"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_organizationId_companyId_id_key" ON "warehouses"("organizationId", "companyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "storage_locations_warehouseId_code_key" ON "storage_locations"("warehouseId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "storage_locations_organizationId_id_key" ON "storage_locations"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_lots_productId_lotNumber_key" ON "stock_lots"("productId", "lotNumber");

-- CreateIndex
CREATE UNIQUE INDEX "stock_lots_organizationId_id_key" ON "stock_lots"("organizationId", "id");

-- CreateIndex
CREATE INDEX "stock_entries_organizationId_companyId_type_status_idx" ON "stock_entries"("organizationId", "companyId", "type", "status");

-- CreateIndex
CREATE INDEX "stock_entries_organizationId_purchaseOrderId_idx" ON "stock_entries"("organizationId", "purchaseOrderId");

-- CreateIndex
CREATE INDEX "stock_entries_organizationId_salesOrderId_idx" ON "stock_entries"("organizationId", "salesOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_entries_companyId_number_key" ON "stock_entries"("companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "stock_entries_organizationId_id_key" ON "stock_entries"("organizationId", "id");

-- CreateIndex
CREATE INDEX "stock_entry_lines_entryId_idx" ON "stock_entry_lines"("entryId");

-- CreateIndex
CREATE INDEX "stock_entry_lines_organizationId_purchaseOrderLineId_idx" ON "stock_entry_lines"("organizationId", "purchaseOrderLineId");

-- CreateIndex
CREATE INDEX "stock_entry_lines_organizationId_salesOrderLineId_idx" ON "stock_entry_lines"("organizationId", "salesOrderLineId");

-- CreateIndex
CREATE INDEX "stock_entry_lines_organizationId_returnOfLineId_idx" ON "stock_entry_lines"("organizationId", "returnOfLineId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_entry_lines_organizationId_id_key" ON "stock_entry_lines"("organizationId", "id");

-- CreateIndex
CREATE INDEX "stock_moves_organizationId_companyId_productId_movedAt_idx" ON "stock_moves"("organizationId", "companyId", "productId", "movedAt");

-- CreateIndex
CREATE INDEX "stock_moves_locationId_productId_idx" ON "stock_moves"("locationId", "productId");

-- CreateIndex
CREATE INDEX "stock_moves_entryId_idx" ON "stock_moves"("entryId");

-- CreateIndex
CREATE INDEX "stock_balances_organizationId_companyId_productId_idx" ON "stock_balances"("organizationId", "companyId", "productId");

-- CreateIndex
CREATE INDEX "stock_balances_warehouseId_productId_idx" ON "stock_balances"("warehouseId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_balances_locationId_productId_lotKey_key" ON "stock_balances"("locationId", "productId", "lotKey");

-- CreateIndex
CREATE UNIQUE INDEX "stock_valuations_companyId_productId_key" ON "stock_valuations"("companyId", "productId");

-- CreateIndex
CREATE INDEX "stock_reservations_warehouseId_productId_idx" ON "stock_reservations"("warehouseId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_reservations_organizationId_salesOrderLineId_key" ON "stock_reservations"("organizationId", "salesOrderLineId");

-- CreateIndex
CREATE INDEX "vendors_organizationId_name_idx" ON "vendors"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "vendors_organizationId_id_key" ON "vendors"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "vendors_organizationId_code_key" ON "vendors"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "vendors_organizationId_gstin_key" ON "vendors"("organizationId", "gstin");

-- CreateIndex
CREATE INDEX "purchase_orders_organizationId_companyId_status_idx" ON "purchase_orders"("organizationId", "companyId", "status");

-- CreateIndex
CREATE INDEX "purchase_orders_organizationId_vendorId_idx" ON "purchase_orders"("organizationId", "vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_companyId_number_key" ON "purchase_orders"("companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_organizationId_id_key" ON "purchase_orders"("organizationId", "id");

-- CreateIndex
CREATE INDEX "purchase_order_lines_purchaseOrderId_idx" ON "purchase_order_lines"("purchaseOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_lines_organizationId_id_key" ON "purchase_order_lines"("organizationId", "id");

-- CreateIndex
CREATE INDEX "vendor_bills_organizationId_companyId_status_idx" ON "vendor_bills"("organizationId", "companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_bills_companyId_number_key" ON "vendor_bills"("companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_bills_organizationId_vendorId_vendorInvoiceNumber_key" ON "vendor_bills"("organizationId", "vendorId", "vendorInvoiceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_bills_organizationId_id_key" ON "vendor_bills"("organizationId", "id");

-- CreateIndex
CREATE INDEX "vendor_bill_lines_billId_idx" ON "vendor_bill_lines"("billId");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_bill_lines_organizationId_id_key" ON "vendor_bill_lines"("organizationId", "id");

-- CreateIndex
CREATE INDEX "contacts_organizationId_vendorId_idx" ON "contacts"("organizationId", "vendorId");

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_organizationId_vendorId_fkey" FOREIGN KEY ("organizationId", "vendorId") REFERENCES "vendors"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_organizationId_companyId_warehouseId_fkey" FOREIGN KEY ("organizationId", "companyId", "warehouseId") REFERENCES "warehouses"("organizationId", "companyId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uom_conversions" ADD CONSTRAINT "uom_conversions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uom_conversions" ADD CONSTRAINT "uom_conversions_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "products"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uom_conversions" ADD CONSTRAINT "uom_conversions_organizationId_uomId_fkey" FOREIGN KEY ("organizationId", "uomId") REFERENCES "uoms"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_organizationId_companyId_fkey" FOREIGN KEY ("organizationId", "companyId") REFERENCES "companies"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_organizationId_companyId_branchId_fkey" FOREIGN KEY ("organizationId", "companyId", "branchId") REFERENCES "branches"("organizationId", "companyId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_locations" ADD CONSTRAINT "storage_locations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_locations" ADD CONSTRAINT "storage_locations_organizationId_companyId_warehouseId_fkey" FOREIGN KEY ("organizationId", "companyId", "warehouseId") REFERENCES "warehouses"("organizationId", "companyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "products"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_entries" ADD CONSTRAINT "stock_entries_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_entries" ADD CONSTRAINT "stock_entries_organizationId_companyId_fkey" FOREIGN KEY ("organizationId", "companyId") REFERENCES "companies"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_entries" ADD CONSTRAINT "stock_entries_organizationId_companyId_branchId_fkey" FOREIGN KEY ("organizationId", "companyId", "branchId") REFERENCES "branches"("organizationId", "companyId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_entries" ADD CONSTRAINT "stock_entries_organizationId_companyId_sourceWarehouseId_fkey" FOREIGN KEY ("organizationId", "companyId", "sourceWarehouseId") REFERENCES "warehouses"("organizationId", "companyId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_entries" ADD CONSTRAINT "stock_entries_organizationId_companyId_targetWarehouseId_fkey" FOREIGN KEY ("organizationId", "companyId", "targetWarehouseId") REFERENCES "warehouses"("organizationId", "companyId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_entries" ADD CONSTRAINT "stock_entries_organizationId_purchaseOrderId_fkey" FOREIGN KEY ("organizationId", "purchaseOrderId") REFERENCES "purchase_orders"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_entries" ADD CONSTRAINT "stock_entries_organizationId_salesOrderId_fkey" FOREIGN KEY ("organizationId", "salesOrderId") REFERENCES "sales_orders"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_entries" ADD CONSTRAINT "stock_entries_organizationId_vendorId_fkey" FOREIGN KEY ("organizationId", "vendorId") REFERENCES "vendors"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_entries" ADD CONSTRAINT "stock_entries_organizationId_customerId_fkey" FOREIGN KEY ("organizationId", "customerId") REFERENCES "customers"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_entries" ADD CONSTRAINT "stock_entries_organizationId_returnOfId_fkey" FOREIGN KEY ("organizationId", "returnOfId") REFERENCES "stock_entries"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_entries" ADD CONSTRAINT "stock_entries_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_entry_lines" ADD CONSTRAINT "stock_entry_lines_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_entry_lines" ADD CONSTRAINT "stock_entry_lines_organizationId_entryId_fkey" FOREIGN KEY ("organizationId", "entryId") REFERENCES "stock_entries"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_entry_lines" ADD CONSTRAINT "stock_entry_lines_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "products"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_entry_lines" ADD CONSTRAINT "stock_entry_lines_organizationId_uomId_fkey" FOREIGN KEY ("organizationId", "uomId") REFERENCES "uoms"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_entry_lines" ADD CONSTRAINT "stock_entry_lines_organizationId_lotId_fkey" FOREIGN KEY ("organizationId", "lotId") REFERENCES "stock_lots"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_entry_lines" ADD CONSTRAINT "stock_entry_lines_organizationId_sourceLocationId_fkey" FOREIGN KEY ("organizationId", "sourceLocationId") REFERENCES "storage_locations"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_entry_lines" ADD CONSTRAINT "stock_entry_lines_organizationId_targetLocationId_fkey" FOREIGN KEY ("organizationId", "targetLocationId") REFERENCES "storage_locations"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_entry_lines" ADD CONSTRAINT "stock_entry_lines_organizationId_purchaseOrderLineId_fkey" FOREIGN KEY ("organizationId", "purchaseOrderLineId") REFERENCES "purchase_order_lines"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_entry_lines" ADD CONSTRAINT "stock_entry_lines_organizationId_salesOrderLineId_fkey" FOREIGN KEY ("organizationId", "salesOrderLineId") REFERENCES "sales_order_lines"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_entry_lines" ADD CONSTRAINT "stock_entry_lines_organizationId_returnOfLineId_fkey" FOREIGN KEY ("organizationId", "returnOfLineId") REFERENCES "stock_entry_lines"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_moves" ADD CONSTRAINT "stock_moves_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_moves" ADD CONSTRAINT "stock_moves_organizationId_locationId_fkey" FOREIGN KEY ("organizationId", "locationId") REFERENCES "storage_locations"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_moves" ADD CONSTRAINT "stock_moves_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "products"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_moves" ADD CONSTRAINT "stock_moves_organizationId_lotId_fkey" FOREIGN KEY ("organizationId", "lotId") REFERENCES "stock_lots"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_moves" ADD CONSTRAINT "stock_moves_organizationId_entryId_fkey" FOREIGN KEY ("organizationId", "entryId") REFERENCES "stock_entries"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_moves" ADD CONSTRAINT "stock_moves_organizationId_entryLineId_fkey" FOREIGN KEY ("organizationId", "entryLineId") REFERENCES "stock_entry_lines"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_organizationId_companyId_warehouseId_fkey" FOREIGN KEY ("organizationId", "companyId", "warehouseId") REFERENCES "warehouses"("organizationId", "companyId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_organizationId_locationId_fkey" FOREIGN KEY ("organizationId", "locationId") REFERENCES "storage_locations"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "products"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_organizationId_lotId_fkey" FOREIGN KEY ("organizationId", "lotId") REFERENCES "stock_lots"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_valuations" ADD CONSTRAINT "stock_valuations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_valuations" ADD CONSTRAINT "stock_valuations_organizationId_companyId_fkey" FOREIGN KEY ("organizationId", "companyId") REFERENCES "companies"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_valuations" ADD CONSTRAINT "stock_valuations_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "products"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_organizationId_companyId_warehouseId_fkey" FOREIGN KEY ("organizationId", "companyId", "warehouseId") REFERENCES "warehouses"("organizationId", "companyId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "products"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_organizationId_salesOrderLineId_fkey" FOREIGN KEY ("organizationId", "salesOrderLineId") REFERENCES "sales_order_lines"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_organizationId_companyId_fkey" FOREIGN KEY ("organizationId", "companyId") REFERENCES "companies"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_organizationId_companyId_branchId_fkey" FOREIGN KEY ("organizationId", "companyId", "branchId") REFERENCES "branches"("organizationId", "companyId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_organizationId_companyId_warehouseId_fkey" FOREIGN KEY ("organizationId", "companyId", "warehouseId") REFERENCES "warehouses"("organizationId", "companyId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_organizationId_vendorId_fkey" FOREIGN KEY ("organizationId", "vendorId") REFERENCES "vendors"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_organizationId_purchaseOrderId_fkey" FOREIGN KEY ("organizationId", "purchaseOrderId") REFERENCES "purchase_orders"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "products"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_organizationId_uomId_fkey" FOREIGN KEY ("organizationId", "uomId") REFERENCES "uoms"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_organizationId_taxRateId_fkey" FOREIGN KEY ("organizationId", "taxRateId") REFERENCES "tax_rates"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_bills" ADD CONSTRAINT "vendor_bills_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_bills" ADD CONSTRAINT "vendor_bills_organizationId_companyId_fkey" FOREIGN KEY ("organizationId", "companyId") REFERENCES "companies"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_bills" ADD CONSTRAINT "vendor_bills_organizationId_companyId_branchId_fkey" FOREIGN KEY ("organizationId", "companyId", "branchId") REFERENCES "branches"("organizationId", "companyId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_bills" ADD CONSTRAINT "vendor_bills_organizationId_vendorId_fkey" FOREIGN KEY ("organizationId", "vendorId") REFERENCES "vendors"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_bills" ADD CONSTRAINT "vendor_bills_organizationId_purchaseOrderId_fkey" FOREIGN KEY ("organizationId", "purchaseOrderId") REFERENCES "purchase_orders"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_bills" ADD CONSTRAINT "vendor_bills_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_bill_lines" ADD CONSTRAINT "vendor_bill_lines_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_bill_lines" ADD CONSTRAINT "vendor_bill_lines_organizationId_billId_fkey" FOREIGN KEY ("organizationId", "billId") REFERENCES "vendor_bills"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_bill_lines" ADD CONSTRAINT "vendor_bill_lines_organizationId_purchaseOrderLineId_fkey" FOREIGN KEY ("organizationId", "purchaseOrderLineId") REFERENCES "purchase_order_lines"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_bill_lines" ADD CONSTRAINT "vendor_bill_lines_organizationId_goodsReceiptLineId_fkey" FOREIGN KEY ("organizationId", "goodsReceiptLineId") REFERENCES "stock_entry_lines"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_bill_lines" ADD CONSTRAINT "vendor_bill_lines_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "products"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_bill_lines" ADD CONSTRAINT "vendor_bill_lines_organizationId_taxRateId_fkey" FOREIGN KEY ("organizationId", "taxRateId") REFERENCES "tax_rates"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;


-- ─── Every existing company gets a default warehouse with one stock location (new
-- companies get the same in code: seedDefaultWarehouse). ─────────────────────────
INSERT INTO "warehouses" ("id", "organizationId", "companyId", "code", "name", "updatedAt")
SELECT 'wh_' || c."id", c."organizationId", c."id", 'MAIN', 'Main warehouse', CURRENT_TIMESTAMP
FROM "companies" c
WHERE NOT EXISTS (SELECT 1 FROM "warehouses" w WHERE w."companyId" = c."id");

INSERT INTO "storage_locations" ("id", "organizationId", "companyId", "warehouseId", "code", "name", "isDefault")
SELECT 'loc_' || w."id", w."organizationId", w."companyId", w."id", 'STOCK', 'Stock', true
FROM "warehouses" w
WHERE NOT EXISTS (SELECT 1 FROM "storage_locations" l WHERE l."warehouseId" = w."id");

-- New system roles for existing organizations; their permissions come from the code catalog.
INSERT INTO "roles" ("id", "organizationId", "code", "name", "description", "isSystem", "updatedAt")
SELECT gen_random_uuid()::text, o."id", r.code, r.name, r.description, true, CURRENT_TIMESTAMP
FROM "organizations" o
CROSS JOIN (VALUES
  ('inventory_manager', 'Inventory Manager', 'Products, warehouses, stock entries and deliveries'),
  ('purchase_manager', 'Purchase Manager', 'Vendors, purchase orders, receipts and vendor bills')
) AS r(code, name, description)
ON CONFLICT ("organizationId", "code") DO NOTHING;

-- RLS on the new tables (see 20261016100000_erp_foundation).
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;
