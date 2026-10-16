-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "escrowId" BIGINT,
    "jobId" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notification_address_createdAt_idx" ON "Notification"("address", "createdAt");
