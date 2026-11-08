-- CreateEnum 不需要：无枚举
-- W2：save_query 两阶段确认的提案表（docs/ACCEPTANCE-W2.md 1.3）

-- CreateTable
CREATE TABLE "query_proposals" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sql" TEXT NOT NULL,
    "question" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),

    CONSTRAINT "query_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "query_proposals_session_id_consumed_at_idx" ON "query_proposals"("session_id", "consumed_at");
