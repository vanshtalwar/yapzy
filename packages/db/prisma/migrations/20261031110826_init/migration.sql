-- CreateEnum
CREATE TYPE "chat_mode" AS ENUM ('TEXT', 'VIDEO');

-- CreateEnum
CREATE TYPE "session_topology" AS ENUM ('MESH', 'SFU');

-- CreateEnum
CREATE TYPE "leave_reason" AS ENUM ('SKIP', 'STOP', 'DISCONNECT', 'RTC_FAILED', 'REPORTED', 'BANNED', 'SERVER_RESTART');

-- CreateEnum
CREATE TYPE "report_reason" AS ENUM ('NUDITY_SEXUAL', 'MINOR_SAFETY', 'HARASSMENT', 'HATE', 'SPAM_SCAM', 'VIOLENCE_SELF_HARM', 'OTHER');

-- CreateEnum
CREATE TYPE "report_status" AS ENUM ('OPEN', 'IN_REVIEW', 'ACTIONED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "evidence_type" AS ENUM ('FRAME', 'TRANSCRIPT', 'AUTO_FLAG_FRAME');

-- CreateEnum
CREATE TYPE "moderation_source" AS ENUM ('CLIENT_NSFW', 'SERVER_CLASSIFIER', 'TEXT_FILTER', 'HASH_MATCH', 'REPORT_THRESHOLD');

-- CreateEnum
CREATE TYPE "moderation_action" AS ENUM ('NONE', 'MESSAGE_BLOCKED', 'TRUST_DECREASED', 'SHADOW_BANNED', 'BANNED', 'ESCALATED');

-- CreateEnum
CREATE TYPE "ban_type" AS ENUM ('HARD', 'SHADOW');

-- CreateEnum
CREATE TYPE "admin_role" AS ENUM ('ADMIN', 'MODERATOR');

-- CreateTable
CREATE TABLE "visitors" (
    "id" UUID NOT NULL,
    "device_id_hash" CHAR(64) NOT NULL,
    "last_ip_hash" CHAR(64),
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "age_confirmed_at" TIMESTAMPTZ(3),
    "tos_version" VARCHAR(32),
    "trust_score" INTEGER NOT NULL DEFAULT 50,
    "country" CHAR(2),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "visitors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_session_logs" (
    "id" UUID NOT NULL,
    "mode" "chat_mode" NOT NULL,
    "topology" "session_topology" NOT NULL DEFAULT 'MESH',
    "max_participants" INTEGER NOT NULL DEFAULT 2,
    "common_interests" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "ended_at" TIMESTAMPTZ(3),

    CONSTRAINT "chat_session_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_participants" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "visitor_id" UUID NOT NULL,
    "participant_id" VARCHAR(32) NOT NULL,
    "joined_at" TIMESTAMPTZ(3) NOT NULL,
    "left_at" TIMESTAMPTZ(3),
    "leave_reason" "leave_reason",

    CONSTRAINT "session_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "reporter_id" UUID NOT NULL,
    "reported_id" UUID NOT NULL,
    "reported_participant_id" VARCHAR(32) NOT NULL,
    "reason" "report_reason" NOT NULL,
    "details" VARCHAR(500),
    "status" "report_status" NOT NULL DEFAULT 'OPEN',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "transcript" JSONB,
    "assigned_to_id" UUID,
    "resolved_at" TIMESTAMPTZ(3),
    "resolution_note" VARCHAR(2000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence" (
    "id" UUID NOT NULL,
    "report_id" UUID,
    "moderation_event_id" UUID,
    "type" "evidence_type" NOT NULL,
    "storage_key" VARCHAR(512) NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moderation_events" (
    "id" UUID NOT NULL,
    "visitor_id" UUID NOT NULL,
    "session_id" UUID,
    "source" "moderation_source" NOT NULL,
    "label" VARCHAR(64) NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "action_taken" "moderation_action" NOT NULL DEFAULT 'NONE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "moderation_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bans" (
    "id" UUID NOT NULL,
    "visitor_id" UUID,
    "device_id_hash" CHAR(64),
    "ip_hash" CHAR(64),
    "type" "ban_type" NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "created_by_admin_id" UUID,
    "expires_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by_admin_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "role" "admin_role" NOT NULL DEFAULT 'MODERATOR',
    "totp_secret" VARCHAR(255),
    "totp_enabled" BOOLEAN NOT NULL DEFAULT false,
    "last_login_at" TIMESTAMPTZ(3),
    "disabled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "admin_id" UUID NOT NULL,
    "action" VARCHAR(64) NOT NULL,
    "target_type" VARCHAR(32) NOT NULL,
    "target_id" VARCHAR(128),
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "visitors_device_id_hash_key" ON "visitors"("device_id_hash");

-- CreateIndex
CREATE INDEX "visitors_last_ip_hash_idx" ON "visitors"("last_ip_hash");

-- CreateIndex
CREATE INDEX "chat_session_logs_started_at_idx" ON "chat_session_logs"("started_at");

-- CreateIndex
CREATE INDEX "session_participants_visitor_id_idx" ON "session_participants"("visitor_id");

-- CreateIndex
CREATE UNIQUE INDEX "session_participants_session_id_participant_id_key" ON "session_participants"("session_id", "participant_id");

-- CreateIndex
CREATE INDEX "reports_status_priority_created_at_idx" ON "reports"("status", "priority" DESC, "created_at");

-- CreateIndex
CREATE INDEX "reports_reported_id_created_at_idx" ON "reports"("reported_id", "created_at");

-- CreateIndex
CREATE INDEX "reports_reporter_id_created_at_idx" ON "reports"("reporter_id", "created_at");

-- CreateIndex
CREATE INDEX "reports_session_id_idx" ON "reports"("session_id");

-- CreateIndex
CREATE INDEX "evidence_report_id_idx" ON "evidence"("report_id");

-- CreateIndex
CREATE INDEX "evidence_moderation_event_id_idx" ON "evidence"("moderation_event_id");

-- CreateIndex
CREATE INDEX "evidence_expires_at_idx" ON "evidence"("expires_at");

-- CreateIndex
CREATE INDEX "moderation_events_visitor_id_created_at_idx" ON "moderation_events"("visitor_id", "created_at");

-- CreateIndex
CREATE INDEX "moderation_events_created_at_idx" ON "moderation_events"("created_at");

-- CreateIndex
CREATE INDEX "bans_visitor_id_idx" ON "bans"("visitor_id");

-- CreateIndex
CREATE INDEX "bans_device_id_hash_idx" ON "bans"("device_id_hash");

-- CreateIndex
CREATE INDEX "bans_ip_hash_idx" ON "bans"("ip_hash");

-- CreateIndex
CREATE INDEX "bans_expires_at_idx" ON "bans"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_email_key" ON "admin_users"("email");

-- CreateIndex
CREATE INDEX "audit_logs_admin_id_created_at_idx" ON "audit_logs"("admin_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_target_type_target_id_idx" ON "audit_logs"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- AddForeignKey
ALTER TABLE "session_participants" ADD CONSTRAINT "session_participants_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "chat_session_logs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_participants" ADD CONSTRAINT "session_participants_visitor_id_fkey" FOREIGN KEY ("visitor_id") REFERENCES "visitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "visitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_reported_id_fkey" FOREIGN KEY ("reported_id") REFERENCES "visitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_moderation_event_id_fkey" FOREIGN KEY ("moderation_event_id") REFERENCES "moderation_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderation_events" ADD CONSTRAINT "moderation_events_visitor_id_fkey" FOREIGN KEY ("visitor_id") REFERENCES "visitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bans" ADD CONSTRAINT "bans_visitor_id_fkey" FOREIGN KEY ("visitor_id") REFERENCES "visitors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bans" ADD CONSTRAINT "bans_created_by_admin_id_fkey" FOREIGN KEY ("created_by_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bans" ADD CONSTRAINT "bans_revoked_by_admin_id_fkey" FOREIGN KEY ("revoked_by_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------
-- Hand-written constraints (Prisma cannot express CHECK constraints; it ignores them when
-- diffing, so they cause no drift).
-- ---------------------------------------------------------------------------------------

-- A ban must target something. Also enforced in code (assertBanHasTarget).
ALTER TABLE "bans" ADD CONSTRAINT "bans_target_required"
  CHECK ("visitor_id" IS NOT NULL OR "device_id_hash" IS NOT NULL OR "ip_hash" IS NOT NULL);

-- Evidence belongs to a report and/or an automated moderation event.
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_owner_required"
  CHECK ("report_id" IS NOT NULL OR "moderation_event_id" IS NOT NULL);

-- Hashes are lowercase hex SHA-256 (HMAC output); rejects raw IPs/device ids by mistake.
ALTER TABLE "visitors" ADD CONSTRAINT "visitors_device_id_hash_hex"
  CHECK ("device_id_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "visitors" ADD CONSTRAINT "visitors_last_ip_hash_hex"
  CHECK ("last_ip_hash" IS NULL OR "last_ip_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "bans" ADD CONSTRAINT "bans_device_id_hash_hex"
  CHECK ("device_id_hash" IS NULL OR "device_id_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "bans" ADD CONSTRAINT "bans_ip_hash_hex"
  CHECK ("ip_hash" IS NULL OR "ip_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "visitors" ADD CONSTRAINT "visitors_trust_score_range"
  CHECK ("trust_score" BETWEEN 0 AND 100);

ALTER TABLE "chat_session_logs" ADD CONSTRAINT "chat_session_logs_max_participants_range"
  CHECK ("max_participants" BETWEEN 2 AND 16);

ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_email_lowercase"
  CHECK ("email" = lower("email"));
