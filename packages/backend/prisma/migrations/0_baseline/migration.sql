-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tg_id" TEXT NOT NULL,
    "bonus_credits" INTEGER NOT NULL DEFAULT 660,
    "main_credits" INTEGER DEFAULT 0,
    "total_credits" INTEGER GENERATED ALWAYS AS (main_credits + bonus_credits) STORED,
    "first_paid_at" TIMESTAMPTZ(6),
    "last_paid_at" TIMESTAMPTZ(6),
    "total_paid_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "source_id" TEXT,
    "last_checkin_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" SERIAL NOT NULL,
    "user_id" TEXT NOT NULL,
    "role_id" TEXT,
    "accept_at" TIMESTAMPTZ(6),
    "instructions" TEXT,
    "bot_reply" TEXT,
    "history" TEXT,
    "model_name" TEXT,
    "user_input" TEXT,
    "round" INTEGER,
    "full_response" INTEGER,
    "attempt_count" INTEGER,
    "first_response_latency" DOUBLE PRECISION,
    "meta_model" TEXT,
    "meta_generation_time" DOUBLE PRECISION,
    "meta_latency" DOUBLE PRECISION,
    "meta_native_tokens_prompt" INTEGER,
    "meta_native_tokens_completion" INTEGER,
    "meta_native_tokens_reasoning" INTEGER,
    "meta_native_tokens_cached" INTEGER,
    "meta_cache_discount" DOUBLE PRECISION,
    "meta_usage" JSONB,
    "meta_finish_reason" TEXT,
    "meta_provider_name" TEXT,
    "type" TEXT,
    "trace_id" TEXT,
    "session_id" TEXT,
    "created_at" TIMESTAMPTZ(6),
    "credits_deducted" INTEGER,
    "credits_account" TEXT,
    "user_preferences" JSONB,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_user_settings" (
    "user_id" UUID NOT NULL,
    "tg_username" TEXT,
    "tg_first_name" TEXT,
    "tg_last_name" TEXT,
    "total_round" BIGINT NOT NULL DEFAULT 0,
    "pref_word_count" TEXT NOT NULL DEFAULT '300-500',
    "pref_show_options" BOOLEAN NOT NULL DEFAULT true,
    "pref_custom_instructions" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_user_settings_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "bot_users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" TEXT NOT NULL,
    "tg_username" TEXT,
    "tg_first_name" TEXT,
    "tg_last_name" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bonus_credits" INTEGER NOT NULL DEFAULT 660,
    "main_credits" INTEGER DEFAULT 0,
    "total_credits" INTEGER GENERATED ALWAYS AS (main_credits + bonus_credits) STORED,
    "first_paid_at" TIMESTAMPTZ(6),
    "last_paid_at" TIMESTAMPTZ(6),
    "total_paid_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "source_id" TEXT,
    "total_round" BIGINT DEFAULT 0,
    "last_checkin_at" TIMESTAMPTZ(6),
    "pref_word_count" TEXT NOT NULL DEFAULT '300-500',
    "pref_show_options" BOOLEAN NOT NULL DEFAULT true,
    "pref_custom_instructions" TEXT,

    CONSTRAINT "bot_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "botlinks" (
    "id" BIGSERIAL NOT NULL,
    "bot_link" TEXT,
    "source_id" TEXT,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "source_name" TEXT,
    "start_time" DATE,
    "end_time" DATE,
    "Purchase_amount" INTEGER,
    "Procurement_days" INTEGER,

    CONSTRAINT "botlinks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" TEXT NOT NULL,
    "role_id" TEXT,
    "snapshot_name" TEXT,
    "history" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "round" INTEGER DEFAULT 0,

    CONSTRAINT "chat_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checkin_logs" (
    "id" BIGSERIAL NOT NULL,
    "user_id" TEXT NOT NULL,
    "reward" INTEGER NOT NULL,
    "checked_in_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "checkin_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "miniapp_user_settings" (
    "user_id" UUID NOT NULL,
    "tg_username" TEXT,
    "tg_first_name" TEXT,
    "tg_last_name" TEXT,
    "display_name" TEXT,
    "avatar_url" TEXT,
    "total_round" BIGINT NOT NULL DEFAULT 0,
    "pref_word_count" TEXT NOT NULL DEFAULT '300-500',
    "pref_show_options" BOOLEAN NOT NULL DEFAULT true,
    "pref_custom_instructions" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "miniapp_user_settings_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "payment_orders" (
    "transaction_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "credits_amount" INTEGER NOT NULL DEFAULT 0,
    "payment_status" TEXT NOT NULL DEFAULT 'pending',
    "payment_provider" TEXT NOT NULL,
    "provider_transaction_id" TEXT,
    "credits_added" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_orders_pkey" PRIMARY KEY ("transaction_id")
);

-- CreateTable
CREATE TABLE "role_data" (
    "id" BIGSERIAL NOT NULL,
    "role_id" TEXT NOT NULL,
    "spec" TEXT DEFAULT 'chara_card_v2',
    "spec_version" TEXT DEFAULT '2.0',
    "name" TEXT,
    "description" TEXT,
    "personality" TEXT,
    "scenario" TEXT,
    "first_mes" TEXT,
    "mes_example" TEXT,
    "creator" TEXT,
    "character_version" TEXT,
    "creator_notes" TEXT,
    "system_prompt" TEXT,
    "post_history_instructions" TEXT,
    "alternate_greetings" JSONB DEFAULT '[]',
    "character_book" JSONB,
    "tags" JSONB DEFAULT '[]',
    "title" TEXT,
    "summary" TEXT,
    "deeplink" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT timezone('utc'::text, now()),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT timezone('utc'::text, now()),
    "avatar" TEXT,
    "post_link" TEXT,
    "published_at" TIMESTAMP(6),

    CONSTRAINT "role-data_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runtime_config" (
    "key" TEXT NOT NULL,
    "value" JSONB,
    "description" TEXT,
    "version" INTEGER DEFAULT 1,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "text_value" TEXT,

    CONSTRAINT "runtime_config_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "traffic_clicks" (
    "id" BIGSERIAL NOT NULL,
    "stat_date" DATE NOT NULL DEFAULT CURRENT_DATE,
    "source_id" TEXT NOT NULL,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "traffic_clicks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_tg_id_uniq" ON "users"("tg_id");

-- CreateIndex
CREATE INDEX "idx_messages_session_id" ON "messages"("session_id");

-- CreateIndex
CREATE INDEX "idx_messages_timestamp" ON "messages"("accept_at");

-- CreateIndex
CREATE INDEX "idx_messages_user_accept" ON "messages"("user_id", "accept_at");

-- CreateIndex
CREATE INDEX "idx_messages_user_id" ON "messages"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "bot_users_user_id_uniq" ON "bot_users"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "botlinks_short_code_key" ON "botlinks"("source_id");

-- CreateIndex
CREATE INDEX "idx_chat_snapshots_user_id" ON "chat_snapshots"("user_id");

-- CreateIndex
CREATE INDEX "idx_checkin_logs_user_time" ON "checkin_logs"("user_id", "checked_in_at" DESC);

-- CreateIndex
CREATE INDEX "idx_payment_orders_created" ON "payment_orders"("created_at");

-- CreateIndex
CREATE INDEX "idx_payment_orders_status" ON "payment_orders"("payment_status");

-- CreateIndex
CREATE INDEX "idx_payment_orders_user_id" ON "payment_orders"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "role-data_role_id_key" ON "role_data"("role_id");

-- CreateIndex
CREATE INDEX "role_data_role_id_idx" ON "role_data"("role_id");

-- CreateIndex
CREATE INDEX "idx_tc_source_date" ON "traffic_clicks"("source_id", "stat_date");

-- CreateIndex
CREATE UNIQUE INDEX "traffic_clicks_uniq" ON "traffic_clicks"("stat_date", "source_id");

-- AddForeignKey
ALTER TABLE "bot_user_settings" ADD CONSTRAINT "bot_user_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "miniapp_user_settings" ADD CONSTRAINT "miniapp_user_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "traffic_clicks" ADD CONSTRAINT "traffic_clicks_fk" FOREIGN KEY ("source_id") REFERENCES "botlinks"("source_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

