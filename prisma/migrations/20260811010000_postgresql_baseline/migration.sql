-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "devices" (
    "revision" INTEGER NOT NULL DEFAULT 0,
    "device_id" SERIAL NOT NULL,
    "pg_no" TEXT NOT NULL,
    "imei" TEXT,
    "adb_serial" TEXT,
    "model" TEXT NOT NULL,
    "model_code" TEXT,
    "model_seq" INTEGER,
    "storage" TEXT,
    "color" TEXT,
    "sale_grade" TEXT,
    "warranty" TEXT,
    "inventory_sku_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("device_id")
);

-- CreateTable
CREATE TABLE "inbounds" (
    "revision" INTEGER NOT NULL DEFAULT 0,
    "inbound_id" SERIAL NOT NULL,
    "pg_no" TEXT NOT NULL,
    "inbound_batch_id" INTEGER,
    "supplier_name" TEXT,
    "purchase_price" INTEGER,
    "purchase_price_reference_rate_id" INTEGER,
    "purchase_price_reference_amount" INTEGER,
    "purchase_price_entry_mode" TEXT,
    "received_at" TIMESTAMPTZ(3),
    "price_agreed_at" TIMESTAMPTZ(3),
    "supplier_returned_at" TIMESTAMPTZ(3),
    "inbound_status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purchase_price_updated_by_user_id" INTEGER,
    "purchase_price_updated_at" TIMESTAMPTZ(3),

    CONSTRAINT "inbounds_pkey" PRIMARY KEY ("inbound_id")
);

-- CreateTable
CREATE TABLE "inbound_batches" (
    "revision" INTEGER NOT NULL DEFAULT 0,
    "inbound_batch_id" SERIAL NOT NULL,
    "batch_date" DATE NOT NULL,
    "batch_no" INTEGER NOT NULL,
    "expected_quantity" INTEGER NOT NULL,
    "note" TEXT,
    "created_by_user_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbound_batches_pkey" PRIMARY KEY ("inbound_batch_id")
);

-- CreateTable
CREATE TABLE "inspections" (
    "revision" INTEGER NOT NULL DEFAULT 0,
    "inspection_id" SERIAL NOT NULL,
    "pg_no" TEXT NOT NULL,
    "inbound_id" INTEGER,
    "inspection_type" TEXT NOT NULL DEFAULT 'APPEARANCE',
    "inspection_round" INTEGER NOT NULL DEFAULT 1,
    "inspection_result" TEXT,
    "source_type" TEXT NOT NULL DEFAULT 'INBOUND',
    "coupang_return_allocation_id" INTEGER,
    "checked_by_user_id" INTEGER,
    "checked_at" TIMESTAMPTZ(3),
    "appearance_grade" TEXT,
    "appearance_defect" TEXT,
    "function_defect" TEXT,
    "return_yn" TEXT NOT NULL DEFAULT 'N',
    "csc" TEXT,
    "first_call_date" DATE,
    "appearance_worker" TEXT,
    "function_worker" TEXT,
    "appearance_checked_at" TIMESTAMPTZ(3),
    "function_checked_at" TIMESTAMPTZ(3),
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inspections_pkey" PRIMARY KEY ("inspection_id")
);

-- CreateTable
CREATE TABLE "inventory" (
    "revision" INTEGER NOT NULL DEFAULT 0,
    "inventory_id" SERIAL NOT NULL,
    "pg_no" TEXT NOT NULL,
    "inventory_status" TEXT NOT NULL,
    "location" TEXT,
    "stocked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_pkey" PRIMARY KEY ("inventory_id")
);

-- CreateTable
CREATE TABLE "inventory_quantity_balances" (
    "inventory_quantity_balance_id" SERIAL NOT NULL,
    "inventory_sku_id" INTEGER NOT NULL,
    "inventory_status" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "last_movement_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_quantity_balances_pkey" PRIMARY KEY ("inventory_quantity_balance_id")
);

-- CreateTable
CREATE TABLE "inventory_quantity_movements" (
    "inventory_quantity_movement_id" SERIAL NOT NULL,
    "inventory_quantity_balance_id" INTEGER NOT NULL,
    "operation_key" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "movement_type" TEXT NOT NULL,
    "pg_no" TEXT,
    "quantity_delta" INTEGER NOT NULL,
    "before_quantity" INTEGER NOT NULL,
    "after_quantity" INTEGER NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT,
    "reason" TEXT,
    "actor_user_id" INTEGER,
    "worker_job_id" INTEGER,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_quantity_movements_pkey" PRIMARY KEY ("inventory_quantity_movement_id")
);

-- CreateTable
CREATE TABLE "model_sequences" (
    "model" TEXT NOT NULL,
    "last_seq" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_sequences_pkey" PRIMARY KEY ("model")
);

-- CreateTable
CREATE TABLE "order_items" (
    "order_item_id" SERIAL NOT NULL,
    "order_id" INTEGER NOT NULL,
    "pg_no" TEXT,
    "sale_product_name" TEXT NOT NULL,
    "sale_price" INTEGER,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "matched_model" TEXT,
    "matched_storage" TEXT,
    "matched_color" TEXT,
    "matched_sale_grade" TEXT,
    "match_status" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("order_item_id")
);

-- CreateTable
CREATE TABLE "orders" (
    "order_id" SERIAL NOT NULL,
    "platform" TEXT NOT NULL,
    "platform_order_id" TEXT NOT NULL,
    "ordered_at" TIMESTAMPTZ(3),
    "buyer_name" TEXT,
    "receiver_name" TEXT,
    "phone" TEXT,
    "shipping_address" TEXT,
    "shipping_memo" TEXT,
    "order_status" TEXT NOT NULL DEFAULT 'NEW',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("order_id")
);

-- CreateTable
CREATE TABLE "users" (
    "revision" INTEGER NOT NULL DEFAULT 0,
    "credential_revision" INTEGER NOT NULL DEFAULT 0,
    "user_id" SERIAL NOT NULL,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "must_change_password" INTEGER NOT NULL DEFAULT 0,
    "role" TEXT NOT NULL,
    "is_developer" INTEGER NOT NULL DEFAULT 0,
    "mobile_packing_enabled" INTEGER NOT NULL DEFAULT 0,
    "is_active" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "mobile_registered_devices" (
    "registration_revision" INTEGER NOT NULL DEFAULT 0,
    "device_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "label" TEXT,
    "adb_serial_hmac" TEXT NOT NULL,
    "adb_serial_preview" TEXT NOT NULL,
    "registration_state" TEXT NOT NULL DEFAULT 'PROVISIONING',
    "provisioning_token_hash" TEXT,
    "provisioning_expires_at" TIMESTAMPTZ(3),
    "app_instance_id_hash" TEXT,
    "device_public_key_spki" TEXT,
    "device_public_key_fingerprint" TEXT,
    "device_token_hash" TEXT,
    "user_credential_revision" INTEGER,
    "instance_epoch" INTEGER,
    "activated_at" TIMESTAMPTZ(3),
    "registered_by_user_id" INTEGER,
    "revoked_by_user_id" INTEGER,
    "revoked_at" TIMESTAMPTZ(3),
    "last_seen_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mobile_registered_devices_pkey" PRIMARY KEY ("device_id"),
    CONSTRAINT "ck_mobile_registered_devices_revision" CHECK ("registration_revision" >= 0),
    CONSTRAINT "ck_mobile_registered_devices_state" CHECK ("registration_state" IN ('PROVISIONING', 'ACTIVE', 'REVOKED')),
    CONSTRAINT "ck_mobile_registered_devices_state_shape" CHECK (
      ("registration_state" = 'PROVISIONING' AND "provisioning_token_hash" IS NOT NULL AND "provisioning_expires_at" IS NOT NULL AND "device_token_hash" IS NULL AND "activated_at" IS NULL AND "revoked_at" IS NULL)
      OR
      ("registration_state" = 'ACTIVE' AND "provisioning_token_hash" IS NOT NULL AND "provisioning_expires_at" IS NOT NULL AND "app_instance_id_hash" IS NOT NULL AND "device_public_key_spki" IS NOT NULL AND "device_public_key_fingerprint" IS NOT NULL AND "device_token_hash" IS NOT NULL AND "user_credential_revision" IS NOT NULL AND "instance_epoch" IS NOT NULL AND "activated_at" IS NOT NULL AND "revoked_at" IS NULL)
      OR
      ("registration_state" = 'REVOKED' AND "provisioning_token_hash" IS NULL AND "provisioning_expires_at" IS NULL AND "device_token_hash" IS NULL AND "revoked_at" IS NOT NULL)
    )
);

-- CreateTable
CREATE TABLE "user_totp_credentials" (
    "credential_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "secret_ciphertext" TEXT NOT NULL,
    "secret_iv" TEXT NOT NULL,
    "secret_auth_tag" TEXT NOT NULL,
    "enabled" INTEGER NOT NULL DEFAULT 0,
    "verified_at" TIMESTAMPTZ(3),
    "last_used_step" INTEGER,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_totp_credentials_pkey" PRIMARY KEY ("credential_id")
);

-- CreateTable
CREATE TABLE "user_totp_recovery_codes" (
    "recovery_code_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_totp_recovery_codes_pkey" PRIMARY KEY ("recovery_code_id")
);

-- CreateTable
CREATE TABLE "employee_profiles" (
    "profile_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "display_name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "birth_date" DATE,
    "hire_date" DATE,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_profiles_pkey" PRIMARY KEY ("profile_id")
);

-- CreateTable
CREATE TABLE "user_preferences" (
    "user_id" INTEGER NOT NULL,
    "keyboard_shortcuts_enabled" INTEGER NOT NULL DEFAULT 1,
    "windows_notifications_enabled" INTEGER NOT NULL DEFAULT 0,
    "inspection_complete_notification_enabled" INTEGER NOT NULL DEFAULT 1,
    "shipment_change_notification_enabled" INTEGER NOT NULL DEFAULT 1,
    "return_notification_enabled" INTEGER NOT NULL DEFAULT 1,
    "settings_revision" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "user_shortcut_bindings" (
    "user_id" INTEGER NOT NULL,
    "action_code" TEXT NOT NULL,
    "modifier" TEXT NOT NULL,
    "key_code" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_shortcut_bindings_pkey" PRIMARY KEY ("user_id","action_code")
);

-- CreateTable
CREATE TABLE "employee_activity_logs" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER,
    "action_type" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT,
    "before_summary_text" TEXT,
    "after_summary_text" TEXT,
    "result" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_activity_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carrier_integration_settings" (
    "carrier_integration_setting_id" SERIAL NOT NULL,
    "carrier_code" TEXT NOT NULL,
    "sender_name" TEXT NOT NULL,
    "sender_tel" TEXT NOT NULL,
    "sender_cell" TEXT,
    "sender_zip_code" TEXT,
    "sender_address_1" TEXT NOT NULL,
    "sender_address_2" TEXT NOT NULL,
    "default_box_type_code" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "updated_by_user_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "carrier_integration_settings_pkey" PRIMARY KEY ("carrier_integration_setting_id")
);

-- CreateTable
CREATE TABLE "employee_activity_log_changes" (
    "employee_activity_log_change_id" SERIAL NOT NULL,
    "activity_log_id" INTEGER NOT NULL,
    "field_name" TEXT NOT NULL,
    "before_value" TEXT,
    "after_value" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_activity_log_changes_pkey" PRIMARY KEY ("employee_activity_log_change_id")
);

-- CreateTable
CREATE TABLE "server_job_logs" (
    "id" SERIAL NOT NULL,
    "job_type" TEXT NOT NULL,
    "job_name" TEXT,
    "status" TEXT NOT NULL,
    "triggered_by_user_id" INTEGER,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),
    "duration_ms" INTEGER,
    "summary_text" TEXT,
    "summary_processed_count" INTEGER,
    "summary_succeeded_count" INTEGER,
    "summary_failed_count" INTEGER,
    "summary_skipped_count" INTEGER,
    "summary_created_count" INTEGER,
    "summary_updated_count" INTEGER,
    "summary_warning_count" INTEGER,
    "error_code" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "server_job_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "server_job_log_fields" (
    "server_job_log_field_id" SERIAL NOT NULL,
    "server_job_log_id" INTEGER NOT NULL,
    "field_name" TEXT NOT NULL,
    "field_value" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "server_job_log_fields_pkey" PRIMARY KEY ("server_job_log_field_id")
);

-- CreateTable
CREATE TABLE "client_http_trace_observations" (
    "client_http_trace_observation_id" SERIAL NOT NULL,
    "trace_id" TEXT NOT NULL,
    "reported_by_user_id" INTEGER,
    "response_status" INTEGER NOT NULL,
    "header_received_ms" INTEGER NOT NULL,
    "response_complete_ms" INTEGER,
    "body_processing_ms" INTEGER,
    "gateway_ms" INTEGER,
    "observed_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_http_trace_observations_pkey" PRIMARY KEY ("client_http_trace_observation_id")
);

-- CreateTable
CREATE TABLE "server_worker_jobs" (
    "lease_token" UUID,
    "claim_generation" INTEGER NOT NULL DEFAULT 0,
    "worker_job_id" SERIAL NOT NULL,
    "worker_key" TEXT NOT NULL,
    "worker_name" TEXT NOT NULL,
    "worker_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IDLE',
    "schedule_enabled" INTEGER NOT NULL DEFAULT 0,
    "interval_seconds" INTEGER,
    "next_run_at" TIMESTAMPTZ(3),
    "last_run_at" TIMESTAMPTZ(3),
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "locked_by" TEXT,
    "locked_until" TIMESTAMPTZ(3),
    "progress_current" INTEGER NOT NULL DEFAULT 0,
    "progress_total" INTEGER,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "last_error_code" TEXT,
    "last_error_message" TEXT,
    "result_summary_text" TEXT,
    "result_processed_count" INTEGER,
    "result_succeeded_count" INTEGER,
    "result_failed_count" INTEGER,
    "result_skipped_count" INTEGER,
    "result_created_count" INTEGER,
    "result_updated_count" INTEGER,
    "result_warning_count" INTEGER,
    "triggered_by_user_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "server_worker_jobs_pkey" PRIMARY KEY ("worker_job_id")
);

-- CreateTable
CREATE TABLE "statistics_snapshot_batches" (
    "snapshot_batch_id" SERIAL NOT NULL,
    "data_cutoff_date" DATE NOT NULL,
    "period_from" DATE NOT NULL,
    "period_to" DATE NOT NULL,
    "day_count" INTEGER NOT NULL,
    "calculation_version" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'BUILDING',
    "worker_job_id" INTEGER,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),
    "failed_at" TIMESTAMPTZ(3),
    "error_code" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "statistics_snapshot_batches_pkey" PRIMARY KEY ("snapshot_batch_id")
);

-- CreateTable
CREATE TABLE "statistics_snapshot_items" (
    "snapshot_item_id" SERIAL NOT NULL,
    "snapshot_batch_id" INTEGER NOT NULL,
    "domain" TEXT NOT NULL,
    "payload_schema_version" INTEGER NOT NULL,
    "payload_text" TEXT NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "payload_size_bytes" INTEGER NOT NULL,
    "generated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "statistics_snapshot_items_pkey" PRIMARY KEY ("snapshot_item_id")
);

-- CreateTable
CREATE TABLE "purchase_price_rates" (
    "revision" INTEGER NOT NULL DEFAULT 0,
    "purchase_price_rate_id" SERIAL NOT NULL,
    "model_option_id" INTEGER NOT NULL,
    "storage_option_id" INTEGER NOT NULL,
    "appearance_grade_option_id" INTEGER NOT NULL,
    "price_date" DATE NOT NULL,
    "purchase_price" INTEGER NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "created_by_user_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_price_rates_pkey" PRIMARY KEY ("purchase_price_rate_id")
);

-- CreateTable
CREATE TABLE "product_criteria_options" (
    "revision" INTEGER NOT NULL DEFAULT 0,
    "relation_revision" INTEGER NOT NULL DEFAULT 0,
    "option_id" SERIAL NOT NULL,
    "category" TEXT NOT NULL,
    "option_key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "parent_key" TEXT NOT NULL DEFAULT '',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" INTEGER NOT NULL DEFAULT 1,
    "updated_by_user_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_criteria_options_pkey" PRIMARY KEY ("option_id")
);

-- CreateTable
CREATE TABLE "product_criteria_option_links" (
    "revision" INTEGER NOT NULL DEFAULT 0,
    "link_id" SERIAL NOT NULL,
    "relation_type" TEXT NOT NULL,
    "parent_option_id" INTEGER NOT NULL,
    "child_option_id" INTEGER NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" INTEGER NOT NULL DEFAULT 1,
    "updated_by_user_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_criteria_option_links_pkey" PRIMARY KEY ("link_id")
);

-- CreateTable
CREATE TABLE "inventory_skus" (
    "revision" INTEGER NOT NULL DEFAULT 0,
    "inventory_sku_id" SERIAL NOT NULL,
    "sku_code" TEXT NOT NULL,
    "model_option_id" INTEGER NOT NULL,
    "storage_option_id" INTEGER NOT NULL,
    "color_option_id" INTEGER NOT NULL,
    "sale_grade_option_id" INTEGER NOT NULL,
    "is_active" INTEGER NOT NULL DEFAULT 1,
    "deactivated_at" TIMESTAMPTZ(3),
    "created_by_user_id" INTEGER,
    "updated_by_user_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_skus_pkey" PRIMARY KEY ("inventory_sku_id")
);

-- CreateTable
CREATE TABLE "product_camera_check_rules" (
    "rule_id" SERIAL NOT NULL,
    "model_option_id" INTEGER NOT NULL,
    "camera_lens_option_id" INTEGER,
    "focus_rule_option_id" INTEGER,
    "camera_name" TEXT NOT NULL,
    "focus_rule" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" INTEGER NOT NULL DEFAULT 1,
    "updated_by_user_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_camera_check_rules_pkey" PRIMARY KEY ("rule_id")
);

-- CreateTable
CREATE TABLE "user_sessions" (
    "session_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "session_token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "sensitive_verified_until" TIMESTAMPTZ(3),
    "credential_revision" INTEGER NOT NULL,
    "instance_epoch" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("session_id")
);

-- CreateTable
CREATE TABLE "user_sensitive_auth_grants" (
    "grant_id" SERIAL NOT NULL,
    "session_id" INTEGER NOT NULL,
    "sensitive_action" TEXT NOT NULL,
    "verified_until" TIMESTAMPTZ(3) NOT NULL,
    "credential_revision" INTEGER NOT NULL,
    "totp_credential_id" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_sensitive_auth_grants_pkey" PRIMARY KEY ("grant_id")
);

-- CreateTable
CREATE TABLE "login_attempts" (
    "attempt_key" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "ip_address" TEXT NOT NULL,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "first_attempt_at" TIMESTAMPTZ(3) NOT NULL,
    "blocked_until" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "login_attempts_pkey" PRIMARY KEY ("attempt_key")
);

-- CreateTable
CREATE TABLE "sales_offers" (
    "revision" INTEGER NOT NULL DEFAULT 0,
    "sales_offer_id" SERIAL NOT NULL,
    "offer_code" TEXT NOT NULL,
    "model_option_id" INTEGER NOT NULL,
    "storage_match_mode" TEXT NOT NULL DEFAULT 'ANY',
    "storage_option_id" INTEGER,
    "color_match_mode" TEXT NOT NULL DEFAULT 'ANY',
    "color_option_id" INTEGER,
    "warranty_group_option_id" INTEGER NOT NULL,
    "is_active" INTEGER NOT NULL DEFAULT 1,
    "created_by_user_id" INTEGER,
    "updated_by_user_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_offers_pkey" PRIMARY KEY ("sales_offer_id")
);

-- CreateTable
CREATE TABLE "sales_channel_product_mappings" (
    "revision" INTEGER NOT NULL DEFAULT 0,
    "mapping_id" SERIAL NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'COUPANG',
    "external_product_id" TEXT,
    "external_vendor_item_id" TEXT NOT NULL,
    "external_option_name" TEXT,
    "sales_offer_id" INTEGER,
    "mapping_status" TEXT NOT NULL DEFAULT 'UNMAPPED',
    "mapped_by_user_id" INTEGER,
    "mapped_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_channel_product_mappings_pkey" PRIMARY KEY ("mapping_id")
);

-- CreateTable
CREATE TABLE "sales_channel_inventory_verification_states" (
    "verification_state_id" SERIAL NOT NULL,
    "mapping_id" INTEGER NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'COUPANG',
    "external_vendor_item_id" TEXT NOT NULL,
    "sales_offer_id" INTEGER,
    "verification_status" TEXT NOT NULL DEFAULT 'PENDING',
    "ledger_quantity" INTEGER NOT NULL DEFAULT 0,
    "pending_order_quantity" INTEGER NOT NULL DEFAULT 0,
    "channel_quantity" INTEGER,
    "desired_version" INTEGER NOT NULL DEFAULT 1,
    "processing_version" INTEGER,
    "execution_token" TEXT,
    "state_revision" INTEGER NOT NULL DEFAULT 1,
    "mapping_updated_at_snapshot" TIMESTAMPTZ(3),
    "projection_basis_hash" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "next_retry_at" TIMESTAMPTZ(3),
    "mismatch_since" TIMESTAMPTZ(3),
    "last_checked_at" TIMESTAMPTZ(3),
    "resolved_at" TIMESTAMPTZ(3),
    "last_error_code" TEXT,
    "last_error_message" TEXT,
    "last_api_call_log_id" INTEGER,
    "last_worker_job_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_channel_inventory_verification_states_pkey" PRIMARY KEY ("verification_state_id")
);

-- CreateTable
CREATE TABLE "order_matching_policies" (
    "policy_id" SERIAL NOT NULL,
    "sales_offer_id" INTEGER NOT NULL,
    "policy_name" TEXT,
    "auto_match_enabled" INTEGER NOT NULL DEFAULT 1,
    "candidate_sort_mode" TEXT NOT NULL DEFAULT 'SALE_GRADE_THEN_STOCKED_OLD',
    "grade_fallback_enabled" INTEGER NOT NULL DEFAULT 1,
    "is_active" INTEGER NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_user_id" INTEGER,
    "updated_by_user_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_matching_policies_pkey" PRIMARY KEY ("policy_id")
);

-- CreateTable
CREATE TABLE "order_matching_priority_tiers" (
    "tier_id" SERIAL NOT NULL,
    "policy_id" INTEGER NOT NULL,
    "priority_order" INTEGER NOT NULL,
    "is_enabled" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_matching_priority_tiers_pkey" PRIMARY KEY ("tier_id")
);

-- CreateTable
CREATE TABLE "order_matching_priority_tier_sale_grades" (
    "tier_sale_grade_id" SERIAL NOT NULL,
    "tier_id" INTEGER NOT NULL,
    "sale_grade_option_id" INTEGER NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_matching_priority_tier_sale_grades_pkey" PRIMARY KEY ("tier_sale_grade_id")
);

-- CreateTable
CREATE TABLE "order_matching_work_queue" (
    "revision" INTEGER NOT NULL DEFAULT 0,
    "work_item_id" SERIAL NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'COUPANG',
    "external_order_id" TEXT NOT NULL,
    "external_shipment_id" TEXT NOT NULL,
    "external_vendor_item_id" TEXT NOT NULL,
    "vendor_item_name" TEXT,
    "seller_product_id" TEXT,
    "seller_product_name" TEXT,
    "seller_product_item_name" TEXT,
    "external_vendor_sku_code" TEXT,
    "sales_price" INTEGER,
    "ordered_quantity" INTEGER NOT NULL DEFAULT 0,
    "cancel_hold_quantity" INTEGER NOT NULL DEFAULT 0,
    "canceled_quantity" INTEGER NOT NULL DEFAULT 0,
    "canceled" INTEGER NOT NULL DEFAULT 0,
    "matchable_quantity" INTEGER NOT NULL DEFAULT 0,
    "ordered_at" TIMESTAMPTZ(3),
    "mapping_status" TEXT NOT NULL DEFAULT 'UNMAPPED',
    "mapping_failure_reason" TEXT,
    "sales_offer_id" INTEGER,
    "required_model_label" TEXT,
    "required_storage_label" TEXT,
    "required_color_label" TEXT,
    "required_warranty_group" TEXT,
    "work_status" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "work_failure_reason" TEXT,
    "matched_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_matching_work_queue_pkey" PRIMARY KEY ("work_item_id")
);

-- CreateTable
CREATE TABLE "sales_channel_shipment_list_print_batches" (
    "shipment_list_print_batch_id" SERIAL NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'COUPANG',
    "tab_key" TEXT NOT NULL,
    "tab_label" TEXT NOT NULL,
    "warranty_label" TEXT,
    "print_date" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "batch_no" INTEGER NOT NULL,
    "batch_label" TEXT NOT NULL,
    "item_count" INTEGER NOT NULL DEFAULT 0,
    "package_group_count" INTEGER NOT NULL DEFAULT 0,
    "batch_status" TEXT NOT NULL DEFAULT 'PENDING',
    "printed_by_user_id" INTEGER,
    "printed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "print_dialog_closed_at" TIMESTAMPTZ(3),
    "confirmed_at" TIMESTAMPTZ(3),
    "canceled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_channel_shipment_list_print_batches_pkey" PRIMARY KEY ("shipment_list_print_batch_id")
);

-- CreateTable
CREATE TABLE "sales_channel_shipment_list_print_batch_items" (
    "shipment_list_print_batch_item_id" SERIAL NOT NULL,
    "shipment_list_print_batch_id" INTEGER NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'COUPANG',
    "tab_key" TEXT NOT NULL,
    "print_date" DATE NOT NULL,
    "print_line_no" INTEGER NOT NULL,
    "allocation_id" INTEGER NOT NULL,
    "package_group_id" INTEGER,
    "pg_no" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_channel_shipment_list_print_batch_items_pkey" PRIMARY KEY ("shipment_list_print_batch_item_id")
);

-- CreateTable
CREATE TABLE "sales_channel_projection_clocks" (
    "channel" TEXT NOT NULL,
    "current_revision" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_channel_projection_clocks_pkey" PRIMARY KEY ("channel")
);

-- CreateTable
CREATE TABLE "coupang_order_raw" (
    "coupang_order_raw_id" SERIAL NOT NULL,
    "external_order_id" TEXT NOT NULL,
    "external_shipment_id" TEXT NOT NULL,
    "external_order_status" TEXT,
    "ordered_at" TIMESTAMPTZ(3),
    "paid_at" TIMESTAMPTZ(3),
    "orderer_name" TEXT,
    "receiver_name" TEXT,
    "receiver_safe_number" TEXT,
    "receiver_address_1" TEXT,
    "receiver_address_2" TEXT,
    "receiver_post_code" TEXT,
    "shipping_memo" TEXT,
    "delivery_company_name" TEXT,
    "invoice_number" TEXT,
    "invoice_uploaded_at" TIMESTAMPTZ(3),
    "split_shipping" INTEGER,
    "delivered_at" TIMESTAMPTZ(3),
    "delivery_occurred_at" TIMESTAMPTZ(3),
    "delivery_time_source" TEXT,
    "projection_revision" INTEGER NOT NULL DEFAULT 0,
    "synced_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupang_order_raw_pkey" PRIMARY KEY ("coupang_order_raw_id")
);

-- CreateTable
CREATE TABLE "sales_channel_personal_data_lifecycles" (
    "personal_data_lifecycle_id" SERIAL NOT NULL,
    "channel" TEXT NOT NULL,
    "external_order_id" TEXT NOT NULL,
    "external_shipment_id" TEXT NOT NULL,
    "delivery_completed_at" TIMESTAMPTZ(3),
    "latest_claim_terminal_at" TIMESTAMPTZ(3),
    "active_claim_count" INTEGER NOT NULL DEFAULT 0,
    "retention_started_at" TIMESTAMPTZ(3),
    "retention_basis" TEXT,
    "redacted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_channel_personal_data_lifecycles_pkey" PRIMARY KEY ("personal_data_lifecycle_id")
);

-- CreateTable
CREATE TABLE "coupang_return_raw" (
    "coupang_return_raw_id" SERIAL NOT NULL,
    "external_receipt_id" TEXT NOT NULL,
    "external_order_id" TEXT NOT NULL,
    "external_shipment_id" TEXT,
    "cancel_type" TEXT,
    "return_receipt_status" TEXT,
    "return_release_status" TEXT,
    "reason_code" TEXT,
    "reason_label" TEXT,
    "reason_category" TEXT,
    "reason_detail" TEXT,
    "cancel_count" INTEGER NOT NULL,
    "item_integrity_status" TEXT NOT NULL DEFAULT 'VALID',
    "projection_revision" INTEGER NOT NULL DEFAULT 0,
    "synced_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupang_return_raw_pkey" PRIMARY KEY ("coupang_return_raw_id")
);

-- CreateTable
CREATE TABLE "coupang_return_raw_item" (
    "coupang_return_raw_item_id" SERIAL NOT NULL,
    "coupang_return_raw_id" INTEGER NOT NULL,
    "external_receipt_id" TEXT NOT NULL,
    "external_order_id" TEXT NOT NULL,
    "external_shipment_id" TEXT,
    "external_vendor_item_id" TEXT,
    "seller_product_item_id" TEXT,
    "vendor_item_name" TEXT,
    "cancel_count" INTEGER NOT NULL,
    "reason_code" TEXT,
    "reason_label" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupang_return_raw_item_pkey" PRIMARY KEY ("coupang_return_raw_item_id")
);

-- CreateTable
CREATE TABLE "coupang_return_withdrawal" (
    "coupang_return_withdrawal_id" SERIAL NOT NULL,
    "external_receipt_id" TEXT NOT NULL,
    "external_order_id" TEXT,
    "external_withdrawn_at" TIMESTAMPTZ(3),
    "refund_delivery_duty" TEXT,
    "vendor_item_ids" TEXT,
    "projection_revision" INTEGER NOT NULL DEFAULT 0,
    "source_evidence_id" UUID,
    "observed_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupang_return_withdrawal_pkey" PRIMARY KEY ("coupang_return_withdrawal_id")
);

-- CreateTable
CREATE TABLE "coupang_return_allocation" (
    "coupang_return_allocation_id" SERIAL NOT NULL,
    "coupang_return_raw_id" INTEGER NOT NULL,
    "allocation_id" INTEGER NOT NULL,
    "external_receipt_id" TEXT NOT NULL,
    "external_order_id" TEXT NOT NULL,
    "external_shipment_id" TEXT,
    "external_vendor_item_id" TEXT,
    "pg_no" TEXT NOT NULL,
    "action_type" TEXT NOT NULL,
    "linked_by_user_id" INTEGER,
    "linked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupang_return_allocation_pkey" PRIMARY KEY ("coupang_return_allocation_id")
);

-- CreateTable
CREATE TABLE "coupang_exchange_raw" (
    "coupang_exchange_raw_id" SERIAL NOT NULL,
    "external_exchange_id" TEXT NOT NULL,
    "external_order_id" TEXT NOT NULL,
    "external_shipment_id" TEXT,
    "exchange_status" TEXT,
    "reason_code" TEXT,
    "reason_label" TEXT,
    "scope_integrity_status" TEXT NOT NULL DEFAULT 'VALID',
    "projection_revision" INTEGER NOT NULL DEFAULT 0,
    "synced_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupang_exchange_raw_pkey" PRIMARY KEY ("coupang_exchange_raw_id")
);

-- CreateTable
CREATE TABLE "coupang_exchange_shipment_scope" (
    "coupang_exchange_shipment_scope_id" SERIAL NOT NULL,
    "coupang_exchange_raw_id" INTEGER NOT NULL,
    "external_exchange_id" TEXT NOT NULL,
    "external_order_id" TEXT NOT NULL,
    "external_shipment_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupang_exchange_shipment_scope_pkey" PRIMARY KEY ("coupang_exchange_shipment_scope_id")
);

-- CreateTable
CREATE TABLE "match_worker_allocation" (
    "allocation_id" SERIAL NOT NULL,
    "external_order_id" TEXT NOT NULL,
    "pg_no" TEXT NOT NULL,
    "external_shipment_id" TEXT NOT NULL,
    "external_vendor_item_id" TEXT,
    "external_product_id" TEXT,
    "vendor_item_name" TEXT,
    "seller_product_name" TEXT,
    "seller_product_item_name" TEXT,
    "option_name" TEXT,
    "external_order_status_at_allocation" TEXT,
    "available_quantity_at_allocation" INTEGER,
    "sales_offer_id" INTEGER,
    "inventory_sku_id" INTEGER,
    "required_model" TEXT,
    "required_storage" TEXT,
    "required_color" TEXT,
    "required_warranty_group" TEXT,
    "inventory_status_before_allocation" TEXT,
    "allocation_status" TEXT NOT NULL DEFAULT 'ALLOCATED',
    "failure_reason" TEXT,
    "allocation_note" TEXT,
    "allocated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMPTZ(3),
    "shipment_list_printed_at" TIMESTAMPTZ(3),
    "shipment_list_print_batch_id" INTEGER,
    "shipment_list_print_batch_no" INTEGER,
    "shipment_list_print_batch_label" TEXT,
    "worker_job_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_worker_allocation_pkey" PRIMARY KEY ("allocation_id")
);

-- CreateTable
CREATE TABLE "shipment_package_groups" (
    "revision" INTEGER NOT NULL DEFAULT 0,
    "package_group_id" SERIAL NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'COUPANG',
    "grouping_key" TEXT NOT NULL,
    "receiver_name_snapshot" TEXT NOT NULL,
    "receiver_address_snapshot" TEXT NOT NULL,
    "receiver_phone_snapshot" TEXT,
    "receiver_post_code_snapshot" TEXT,
    "receiver_address_1_snapshot" TEXT,
    "receiver_address_2_snapshot" TEXT,
    "shipping_memo_snapshot" TEXT,
    "group_status" TEXT NOT NULL DEFAULT 'DRAFT',
    "current_carrier_shipment_id" INTEGER,
    "frozen_at" TIMESTAMPTZ(3),
    "invalidated_at" TIMESTAMPTZ(3),
    "invalidation_reason" TEXT,
    "split_from_group_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_package_groups_pkey" PRIMARY KEY ("package_group_id")
);

-- CreateTable
CREATE TABLE "shipment_package_group_members" (
    "package_group_member_id" SERIAL NOT NULL,
    "package_group_id" INTEGER NOT NULL,
    "allocation_id" INTEGER NOT NULL,
    "external_order_id" TEXT NOT NULL,
    "external_shipment_id" TEXT NOT NULL,
    "member_sequence" INTEGER NOT NULL,
    "added_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMPTZ(3),

    CONSTRAINT "shipment_package_group_members_pkey" PRIMARY KEY ("package_group_member_id")
);

-- CreateTable
CREATE TABLE "sales_records" (
    "sale_record_id" SERIAL NOT NULL,
    "allocation_id" INTEGER NOT NULL,
    "pg_no" TEXT NOT NULL,
    "sales_offer_id" INTEGER,
    "inventory_sku_id" INTEGER,
    "channel" TEXT NOT NULL DEFAULT 'COUPANG',
    "external_order_id" TEXT NOT NULL,
    "external_shipment_id" TEXT,
    "external_vendor_item_id" TEXT,
    "sold_at" TIMESTAMPTZ(3) NOT NULL,
    "sale_status" TEXT NOT NULL DEFAULT 'SOLD',
    "sales_price" INTEGER,
    "purchase_price" INTEGER,
    "purchase_inbound_id" INTEGER,
    "supplier_name" TEXT,
    "purchase_agreed_at" TIMESTAMPTZ(3),
    "model" TEXT,
    "storage" TEXT,
    "color" TEXT,
    "sale_grade" TEXT,
    "warranty_group" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_records_pkey" PRIMARY KEY ("sale_record_id")
);

-- CreateTable
CREATE TABLE "sales_channel_write_requests" (
    "revision" INTEGER NOT NULL DEFAULT 0,
    "sales_channel_write_request_id" SERIAL NOT NULL,
    "channel" TEXT NOT NULL,
    "request_type" TEXT NOT NULL,
    "request_status" TEXT NOT NULL DEFAULT 'PENDING',
    "failure_stage" TEXT,
    "external_order_id" TEXT,
    "allocation_id" INTEGER,
    "pg_no" TEXT,
    "target_type" TEXT,
    "target_external_id" TEXT,
    "package_group_id" INTEGER,
    "carrier_shipment_id" INTEGER,
    "idempotency_key" TEXT NOT NULL,
    "request_digest" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "endpoint_path" TEXT NOT NULL,
    "cancel_count" INTEGER,
    "expected_before_status" TEXT,
    "requested_after_status" TEXT,
    "source_menu_key" TEXT,
    "source_entity_type" TEXT,
    "source_entity_id" TEXT,
    "source_projection_revision" INTEGER,
    "source_snapshot_digest" TEXT,
    "error_code" TEXT,
    "error_message" TEXT,
    "requested_by_user_id" INTEGER,
    "worker_job_id" INTEGER,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sending_at" TIMESTAMPTZ(3),
    "verifying_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "review_required_at" TIMESTAMPTZ(3),
    "local_finalized_at" TIMESTAMPTZ(3),
    "manual_verification_status" TEXT,
    "manual_verified_by_user_id" INTEGER,
    "manual_verified_at" TIMESTAMPTZ(3),
    "manual_verification_note" TEXT,
    "active_review_attempt_id" INTEGER,
    "active_review_heartbeat_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_channel_write_requests_pkey" PRIMARY KEY ("sales_channel_write_request_id")
);

-- CreateTable
CREATE TABLE "sales_channel_write_request_targets" (
    "sales_channel_write_request_target_id" SERIAL NOT NULL,
    "sales_channel_write_request_id" INTEGER NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_external_id" TEXT,
    "allocation_id" INTEGER,
    "pg_no" TEXT,
    "external_order_id" TEXT,
    "external_shipment_id" TEXT,
    "external_vendor_item_id" TEXT,
    "package_group_id" INTEGER,
    "carrier_shipment_id" INTEGER,
    "delivery_company_code" TEXT,
    "invoice_number_snapshot" TEXT,
    "split_shipping" INTEGER,
    "pre_split_shipped" INTEGER,
    "estimated_shipping_date" TEXT,
    "supply_consumption_event_id" INTEGER,
    "quantity" INTEGER,
    "inventory_verification_state_id" INTEGER,
    "inventory_desired_version_snapshot" INTEGER,
    "inventory_mismatch_since_snapshot" TIMESTAMPTZ(3),
    "inventory_projection_basis_hash_snapshot" TEXT,
    "inventory_ledger_quantity_snapshot" INTEGER,
    "inventory_pending_order_quantity_snapshot" INTEGER,
    "inventory_expected_channel_quantity_snapshot" INTEGER,
    "inventory_observed_channel_quantity_snapshot" INTEGER,
    "expected_before_status" TEXT,
    "requested_after_status" TEXT,
    "inspection_result" TEXT,
    "appearance_grade" TEXT,
    "appearance_defect" TEXT,
    "function_defect" TEXT,
    "inspection_note" TEXT,
    "target_position" INTEGER NOT NULL DEFAULT 0,
    "external_result_status" TEXT NOT NULL DEFAULT 'PENDING',
    "external_result_code" TEXT,
    "external_result_message" TEXT,
    "retry_required" INTEGER,
    "result_received_at" TIMESTAMPTZ(3),
    "local_finalization_status" TEXT NOT NULL DEFAULT 'PENDING',
    "local_finalized_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_channel_write_request_targets_pkey" PRIMARY KEY ("sales_channel_write_request_target_id")
);

-- CreateTable
CREATE TABLE "sales_channel_write_request_attempts" (
    "sales_channel_write_request_attempt_id" SERIAL NOT NULL,
    "sales_channel_write_request_id" INTEGER NOT NULL,
    "integration_command_id" UUID,
    "attempt_no" INTEGER NOT NULL,
    "attempt_type" TEXT NOT NULL,
    "attempt_status" TEXT NOT NULL,
    "trigger_type" TEXT NOT NULL,
    "method" TEXT,
    "endpoint_path" TEXT,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),
    "http_status_code" INTEGER,
    "external_response_code" TEXT,
    "external_response_message" TEXT,
    "error_code" TEXT,
    "error_message" TEXT,
    "request_dispatched" INTEGER NOT NULL DEFAULT 0,
    "response_received" INTEGER NOT NULL DEFAULT 0,
    "external_applied_unknown" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_channel_write_request_attempts_pkey" PRIMARY KEY ("sales_channel_write_request_attempt_id")
);

-- CreateTable
CREATE TABLE "sales_channel_write_controls" (
    "revision" INTEGER NOT NULL DEFAULT 0,
    "sales_channel_write_control_id" SERIAL NOT NULL,
    "channel" TEXT NOT NULL,
    "endpoint_key" TEXT NOT NULL,
    "request_type" TEXT NOT NULL,
    "is_paused" INTEGER NOT NULL DEFAULT 0,
    "consecutive_failure_count" INTEGER NOT NULL DEFAULT 0,
    "pause_reason" TEXT,
    "last_failure_code" TEXT,
    "last_failure_message" TEXT,
    "last_failure_at" TIMESTAMPTZ(3),
    "paused_at" TIMESTAMPTZ(3),
    "paused_by_user_id" INTEGER,
    "resumed_at" TIMESTAMPTZ(3),
    "resumed_by_user_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_channel_write_controls_pkey" PRIMARY KEY ("sales_channel_write_control_id")
);

-- CreateTable
CREATE TABLE "coupang_api_call_log" (
    "coupang_api_call_log_id" SERIAL NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'COUPANG',
    "api_name" TEXT NOT NULL,
    "endpoint_path" TEXT,
    "method" TEXT NOT NULL DEFAULT 'GET',
    "status_filter" TEXT,
    "external_order_id" TEXT,
    "external_vendor_item_id" TEXT,
    "period_from" DATE,
    "period_to" DATE,
    "page_token_hash" TEXT,
    "next_page_token_hash" TEXT,
    "max_per_page" INTEGER,
    "http_status_code" INTEGER,
    "external_response_code" TEXT,
    "external_response_message" TEXT,
    "response_hash" TEXT,
    "projection_revision" INTEGER,
    "response_row_count" INTEGER NOT NULL DEFAULT 0,
    "processed_row_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_row_count" INTEGER NOT NULL DEFAULT 0,
    "stale_snapshot_count" INTEGER NOT NULL DEFAULT 0,
    "processed_status" TEXT NOT NULL DEFAULT 'PENDING',
    "error_code" TEXT,
    "error_message" TEXT,
    "request_started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "received_at" TIMESTAMPTZ(3),
    "processing_started_at" TIMESTAMPTZ(3),
    "processed_at" TIMESTAMPTZ(3),
    "worker_job_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupang_api_call_log_pkey" PRIMARY KEY ("coupang_api_call_log_id")
);

-- CreateTable
CREATE TABLE "coupang_raw_change_event" (
    "coupang_raw_change_event_id" SERIAL NOT NULL,
    "source_table" TEXT NOT NULL,
    "source_pk" TEXT NOT NULL,
    "external_order_id" TEXT,
    "external_shipment_id" TEXT,
    "external_receipt_id" TEXT,
    "external_exchange_id" TEXT,
    "event_type" TEXT NOT NULL,
    "change_hash" TEXT NOT NULL,
    "api_call_log_id" INTEGER,
    "process_status" TEXT NOT NULL DEFAULT 'PENDING',
    "worker_attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_error_message" TEXT,
    "detected_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),
    "worker_job_id" INTEGER,
    "execution_token" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupang_raw_change_event_pkey" PRIMARY KEY ("coupang_raw_change_event_id")
);

-- CreateTable
CREATE TABLE "coupang_raw_change_event_field" (
    "coupang_raw_change_event_field_id" SERIAL NOT NULL,
    "raw_change_event_id" INTEGER NOT NULL,
    "field_name" TEXT NOT NULL,
    "before_value" TEXT,
    "after_value" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupang_raw_change_event_field_pkey" PRIMARY KEY ("coupang_raw_change_event_field_id")
);

-- CreateTable
CREATE TABLE "shipment_address_change_work" (
    "shipment_address_change_work_id" SERIAL NOT NULL,
    "raw_change_event_id" INTEGER NOT NULL,
    "api_call_log_id" INTEGER,
    "external_order_id" TEXT NOT NULL,
    "external_shipment_id" TEXT NOT NULL,
    "allocation_id" INTEGER,
    "pg_no" TEXT,
    "package_group_id" INTEGER,
    "carrier_shipment_id_at_detection" INTEGER,
    "change_status" TEXT NOT NULL DEFAULT 'PENDING',
    "shipment_stage_at_detection" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "allocation_status_at_detection" TEXT,
    "detected_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMPTZ(3),
    "ignored_at" TIMESTAMPTZ(3),
    "failed_at" TIMESTAMPTZ(3),
    "processed_by_user_id" INTEGER,
    "memo" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_address_change_work_pkey" PRIMARY KEY ("shipment_address_change_work_id")
);

-- CreateTable
CREATE TABLE "shipment_address_change_work_field" (
    "shipment_address_change_work_field_id" SERIAL NOT NULL,
    "shipment_address_change_work_id" INTEGER NOT NULL,
    "field_name" TEXT NOT NULL,
    "before_value" TEXT,
    "after_value" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_address_change_work_field_pkey" PRIMARY KEY ("shipment_address_change_work_field_id")
);

-- CreateTable
CREATE TABLE "channel_sync_cursors" (
    "sync_cursor_id" SERIAL NOT NULL,
    "channel" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "status_filter" TEXT NOT NULL DEFAULT '',
    "last_window_from" TIMESTAMPTZ(3),
    "last_window_to" TIMESTAMPTZ(3),
    "next_token" TEXT,
    "last_success_at" TIMESTAMPTZ(3),
    "last_failure_at" TIMESTAMPTZ(3),
    "last_error_code" TEXT,
    "last_error_message" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_sync_cursors_pkey" PRIMARY KEY ("sync_cursor_id")
);

-- CreateTable
CREATE TABLE "channel_credentials" (
    "channel_credential_id" SERIAL NOT NULL,
    "channel" TEXT NOT NULL,
    "provider_type" TEXT NOT NULL,
    "key_alias" TEXT,
    "key_fingerprint" TEXT,
    "expires_at" TIMESTAMPTZ(3),
    "credential_status" TEXT NOT NULL DEFAULT 'MISSING',
    "read_enabled" INTEGER NOT NULL DEFAULT 0,
    "write_enabled" INTEGER NOT NULL DEFAULT 0,
    "last_verified_at" TIMESTAMPTZ(3),
    "last_error_message" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_credentials_pkey" PRIMARY KEY ("channel_credential_id")
);

-- CreateTable
CREATE TABLE "channel_credential_events" (
    "channel_credential_event_id" SERIAL NOT NULL,
    "channel_credential_id" INTEGER,
    "channel" TEXT NOT NULL,
    "provider_type" TEXT NOT NULL,
    "key_alias" TEXT,
    "key_fingerprint" TEXT,
    "event_type" TEXT NOT NULL,
    "previous_status" TEXT,
    "new_status" TEXT NOT NULL,
    "read_enabled" INTEGER NOT NULL DEFAULT 0,
    "write_enabled" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT,
    "actor_user_id" INTEGER,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_credential_events_pkey" PRIMARY KEY ("channel_credential_event_id")
);

-- CreateTable
CREATE TABLE "supplies" (
    "revision" INTEGER NOT NULL DEFAULT 0,
    "supply_id" SERIAL NOT NULL,
    "supply_code" TEXT NOT NULL,
    "supply_name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT '',
    "base_unit" TEXT NOT NULL DEFAULT '개',
    "order_unit" TEXT NOT NULL DEFAULT '',
    "order_unit_quantity" INTEGER NOT NULL DEFAULT 1,
    "minimum_order_quantity" INTEGER NOT NULL DEFAULT 0,
    "default_supplier_name" TEXT,
    "unit_cost" INTEGER,
    "lead_time_days" INTEGER NOT NULL DEFAULT 0,
    "min_lead_time_days" INTEGER NOT NULL DEFAULT 0,
    "max_lead_time_days" INTEGER NOT NULL DEFAULT 0,
    "loss_rate_percent" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "safety_stock_days" INTEGER NOT NULL DEFAULT 3,
    "target_stock_days" INTEGER NOT NULL DEFAULT 14,
    "outbound_consumption_policy" TEXT NOT NULL DEFAULT 'PACKING_CONFIRMED_ONLY',
    "is_active" INTEGER NOT NULL DEFAULT 1,
    "note" TEXT,
    "updated_by_user_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplies_pkey" PRIMARY KEY ("supply_id")
);

-- CreateTable
CREATE TABLE "inventory_audit_sessions" (
    "inventory_audit_session_id" SERIAL NOT NULL,
    "audit_base_date" DATE NOT NULL,
    "audit_period_from" DATE NOT NULL,
    "audit_period_to" DATE NOT NULL,
    "changed_count" INTEGER NOT NULL DEFAULT 0,
    "packed_completed_count" INTEGER NOT NULL DEFAULT 0,
    "created_by_user_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_audit_sessions_pkey" PRIMARY KEY ("inventory_audit_session_id")
);

-- CreateTable
CREATE TABLE "inventory_audit_location_changes" (
    "inventory_audit_location_change_id" SERIAL NOT NULL,
    "inventory_audit_session_id" INTEGER NOT NULL,
    "pg_no" TEXT NOT NULL,
    "previous_location" TEXT,
    "new_location" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_audit_location_changes_pkey" PRIMARY KEY ("inventory_audit_location_change_id")
);

-- CreateTable
CREATE TABLE "supply_inventory" (
    "supply_inventory_id" SERIAL NOT NULL,
    "supply_id" INTEGER NOT NULL,
    "current_quantity" INTEGER NOT NULL DEFAULT 0,
    "reserved_quantity" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "inventory_location" TEXT,
    "last_counted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supply_inventory_pkey" PRIMARY KEY ("supply_inventory_id")
);

-- CreateTable
CREATE TABLE "supply_stock_movements" (
    "movement_id" SERIAL NOT NULL,
    "supply_id" INTEGER NOT NULL,
    "movement_type" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "before_quantity" INTEGER NOT NULL,
    "after_quantity" INTEGER NOT NULL,
    "reason" TEXT,
    "source_type" TEXT,
    "source_id" TEXT,
    "pg_no" TEXT,
    "shipment_id" INTEGER,
    "order_id" INTEGER,
    "allocation_id" INTEGER,
    "coupang_return_allocation_id" INTEGER,
    "reversal_of_consumption_event_id" INTEGER,
    "idempotency_key" TEXT,
    "created_by_user_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supply_stock_movements_pkey" PRIMARY KEY ("movement_id")
);

-- CreateTable
CREATE TABLE "supply_consumption_rules" (
    "revision" INTEGER NOT NULL DEFAULT 0,
    "rule_id" SERIAL NOT NULL,
    "supply_id" INTEGER NOT NULL,
    "trigger_type" TEXT NOT NULL,
    "quantity_per_unit" INTEGER NOT NULL DEFAULT 1,
    "channel" TEXT,
    "model" TEXT,
    "sale_grade" TEXT,
    "warranty" TEXT,
    "inventory_status" TEXT,
    "is_active" INTEGER NOT NULL DEFAULT 1,
    "note" TEXT,
    "updated_by_user_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supply_consumption_rules_pkey" PRIMARY KEY ("rule_id")
);

-- CreateTable
CREATE TABLE "supply_consumption_events" (
    "supply_consumption_event_id" SERIAL NOT NULL,
    "supply_id" INTEGER NOT NULL,
    "rule_id" INTEGER NOT NULL,
    "trigger_type" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT,
    "inventory_audit_session_id" INTEGER,
    "pg_no" TEXT,
    "quantity" INTEGER NOT NULL,
    "applied_rule_revision" INTEGER NOT NULL,
    "effective_period_from" DATE,
    "effective_period_to" DATE,
    "consumed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" INTEGER,
    "allocation_id" INTEGER,
    "stock_movement_id" INTEGER,
    "idempotency_key" TEXT NOT NULL,
    "consumption_stage" TEXT NOT NULL,
    "claimed_at" TIMESTAMPTZ(3),

    CONSTRAINT "supply_consumption_events_pkey" PRIMARY KEY ("supply_consumption_event_id")
);

-- CreateTable
CREATE TABLE "supply_forecast_snapshots" (
    "forecast_id" SERIAL NOT NULL,
    "supply_id" INTEGER NOT NULL,
    "forecast_date" DATE NOT NULL,
    "period_from" DATE NOT NULL,
    "period_to" DATE NOT NULL,
    "lookback_days" INTEGER NOT NULL,
    "demand_source" TEXT NOT NULL,
    "expected_usage_quantity" INTEGER NOT NULL,
    "average_daily_usage" INTEGER NOT NULL,
    "usage_stddev" INTEGER,
    "current_quantity" INTEGER NOT NULL,
    "available_quantity" INTEGER NOT NULL,
    "safety_stock_quantity" INTEGER NOT NULL,
    "reorder_point_quantity" INTEGER NOT NULL,
    "target_stock_quantity" INTEGER NOT NULL,
    "recommended_purchase_quantity" INTEGER NOT NULL,
    "economic_order_quantity" INTEGER,
    "expected_stockout_date" DATE,
    "created_by_user_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supply_forecast_snapshots_pkey" PRIMARY KEY ("forecast_id")
);

-- CreateTable
CREATE TABLE "supply_forecast_calculation_fields" (
    "supply_forecast_calculation_field_id" SERIAL NOT NULL,
    "forecast_id" INTEGER NOT NULL,
    "field_name" TEXT NOT NULL,
    "field_value" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supply_forecast_calculation_fields_pkey" PRIMARY KEY ("supply_forecast_calculation_field_id")
);

-- CreateTable
CREATE TABLE "supply_reorder_requests" (
    "revision" INTEGER NOT NULL DEFAULT 0,
    "reorder_request_id" SERIAL NOT NULL,
    "supply_id" INTEGER NOT NULL,
    "forecast_id" INTEGER,
    "request_status" TEXT NOT NULL DEFAULT 'SUGGESTED',
    "recommended_quantity" INTEGER NOT NULL DEFAULT 0,
    "requested_quantity" INTEGER,
    "ordered_quantity" INTEGER,
    "received_quantity" INTEGER,
    "expected_unit_cost" INTEGER,
    "supplier_name" TEXT,
    "reason" TEXT,
    "created_by_user_id" INTEGER,
    "approved_by_user_id" INTEGER,
    "ordered_at" TIMESTAMPTZ(3),
    "received_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supply_reorder_requests_pkey" PRIMARY KEY ("reorder_request_id")
);

-- CreateTable
CREATE TABLE "carrier_shipments" (
    "revision" INTEGER NOT NULL DEFAULT 0,
    "carrier_shipment_id" SERIAL NOT NULL,
    "carrier_code" TEXT NOT NULL,
    "source_type" TEXT NOT NULL DEFAULT 'SELF_PRINT',
    "channel" TEXT,
    "external_order_id" TEXT,
    "external_shipment_id" TEXT,
    "allocation_id" INTEGER,
    "pg_no" TEXT,
    "package_group_id" INTEGER,
    "tracking_number" TEXT NOT NULL,
    "previous_tracking_number" TEXT,
    "revision_no" INTEGER NOT NULL DEFAULT 1,
    "replaces_carrier_shipment_id" INTEGER,
    "invoice_status" TEXT NOT NULL DEFAULT 'ALLOCATED',
    "shipment_status" TEXT NOT NULL DEFAULT 'REGISTERED',
    "allocated_at" TIMESTAMPTZ(3),
    "carrier_registered_at" TIMESTAMPTZ(3),
    "last_tracked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "carrier_shipments_pkey" PRIMARY KEY ("carrier_shipment_id")
);

-- CreateTable
CREATE TABLE "carrier_tracking_events" (
    "carrier_tracking_event_id" SERIAL NOT NULL,
    "carrier_shipment_id" INTEGER NOT NULL,
    "event_fingerprint" TEXT NOT NULL,
    "scan_date" TEXT,
    "scan_time" TEXT,
    "status_name" TEXT NOT NULL,
    "branch_code" TEXT,
    "branch_name" TEXT,
    "sales_office_code" TEXT,
    "sales_office_name" TEXT,
    "recipient_type_name" TEXT,
    "response_hash" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "carrier_tracking_events_pkey" PRIMARY KEY ("carrier_tracking_event_id")
);

-- CreateTable
CREATE TABLE "carrier_return_requests" (
    "carrier_return_request_id" SERIAL NOT NULL,
    "carrier_code" TEXT NOT NULL,
    "take_no" TEXT NOT NULL,
    "carrier_shipment_id" INTEGER,
    "external_order_id" TEXT,
    "customer_code" TEXT,
    "original_tracking_number" TEXT,
    "return_tracking_number" TEXT,
    "reservation_status" TEXT,
    "delay_code" TEXT,
    "processed_date" TEXT,
    "request_status" TEXT NOT NULL DEFAULT 'CONFIRMED',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "carrier_return_requests_pkey" PRIMARY KEY ("carrier_return_request_id")
);

-- CreateTable
CREATE TABLE "carrier_api_call_logs" (
    "carrier_api_call_log_id" SERIAL NOT NULL,
    "carrier_code" TEXT NOT NULL,
    "carrier_shipment_id" INTEGER,
    "api_name" TEXT NOT NULL,
    "endpoint_path" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "operation_type" TEXT NOT NULL,
    "request_hash" TEXT,
    "response_hash" TEXT,
    "http_status_code" INTEGER,
    "external_status_code" TEXT,
    "external_status_message" TEXT,
    "item_result_code" TEXT,
    "item_result_message" TEXT,
    "external_order_id" TEXT,
    "tracking_number" TEXT,
    "take_no" TEXT,
    "worker_job_id" INTEGER,
    "processed_status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "error_code" TEXT,
    "error_message" TEXT,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "carrier_api_call_logs_pkey" PRIMARY KEY ("carrier_api_call_log_id")
);

-- CreateTable
CREATE TABLE "carrier_invoice_issue_batches" (
    "revision" INTEGER NOT NULL DEFAULT 0,
    "carrier_invoice_issue_batch_id" SERIAL NOT NULL,
    "shipment_list_print_batch_id" INTEGER NOT NULL,
    "carrier_code" TEXT NOT NULL DEFAULT 'LOGEN',
    "issue_type" TEXT NOT NULL DEFAULT 'INITIAL',
    "request_key" TEXT NOT NULL,
    "batch_status" TEXT NOT NULL DEFAULT 'PENDING',
    "requested_package_group_count" INTEGER NOT NULL,
    "allocated_package_group_count" INTEGER NOT NULL DEFAULT 0,
    "response_item_count" INTEGER NOT NULL DEFAULT 0,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "allocation_request_dispatched" INTEGER NOT NULL DEFAULT 0,
    "api_call_log_id" INTEGER,
    "requested_by_user_id" INTEGER,
    "error_code" TEXT,
    "error_message" TEXT,
    "unmatched_response_json" TEXT,
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "review_required_at" TIMESTAMPTZ(3),
    "label_print_status" TEXT NOT NULL DEFAULT 'NOT_PRINTED',
    "label_template_code" TEXT,
    "label_template_version" INTEGER,
    "label_printer_name" TEXT,
    "label_payload_hash" TEXT,
    "label_active_request_key" TEXT,
    "label_print_attempt_count" INTEGER NOT NULL DEFAULT 0,
    "label_last_started_at" TIMESTAMPTZ(3),
    "label_last_spooled_at" TIMESTAMPTZ(3),
    "label_confirmed_at" TIMESTAMPTZ(3),
    "label_last_error_code" TEXT,
    "label_last_error_message" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "carrier_invoice_issue_batches_pkey" PRIMARY KEY ("carrier_invoice_issue_batch_id")
);

-- CreateTable
CREATE TABLE "carrier_invoice_replacement_works" (
    "carrier_invoice_replacement_work_id" SERIAL NOT NULL,
    "source_type" TEXT NOT NULL,
    "request_key" TEXT NOT NULL,
    "work_status" TEXT NOT NULL DEFAULT 'PENDING',
    "current_stage" TEXT NOT NULL DEFAULT 'PRECHECK',
    "old_invoice_handling_status" TEXT NOT NULL DEFAULT 'NOT_REQUIRED',
    "workflow_version" INTEGER NOT NULL DEFAULT 0,
    "execution_token" TEXT,
    "execution_started_at" TIMESTAMPTZ(3),
    "package_group_id" INTEGER NOT NULL,
    "shipment_address_change_work_id" INTEGER,
    "old_carrier_shipment_id" INTEGER NOT NULL,
    "candidate_carrier_shipment_id" INTEGER,
    "carrier_invoice_issue_batch_id" INTEGER,
    "reason_code" TEXT NOT NULL,
    "reason_note" TEXT,
    "before_receiver_name" TEXT,
    "before_receiver_phone" TEXT,
    "before_receiver_post_code" TEXT,
    "before_receiver_address_1" TEXT,
    "before_receiver_address_2" TEXT,
    "before_shipping_memo" TEXT,
    "after_receiver_name" TEXT,
    "after_receiver_phone" TEXT,
    "after_receiver_post_code" TEXT,
    "after_receiver_address_1" TEXT,
    "after_receiver_address_2" TEXT,
    "after_shipping_memo" TEXT,
    "requested_by_user_id" INTEGER,
    "resolved_by_user_id" INTEGER,
    "last_error_code" TEXT,
    "last_error_message" TEXT,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "held_at" TIMESTAMPTZ(3),
    "old_invoice_handled_at" TIMESTAMPTZ(3),
    "channel_updated_at" TIMESTAMPTZ(3),
    "carrier_registered_at" TIMESTAMPTZ(3),
    "label_confirmed_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "review_required_at" TIMESTAMPTZ(3),
    "failed_at" TIMESTAMPTZ(3),
    "canceled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "carrier_invoice_replacement_works_pkey" PRIMARY KEY ("carrier_invoice_replacement_work_id")
);

-- CreateTable
CREATE TABLE "carrier_invoice_issue_items" (
    "carrier_invoice_issue_item_id" SERIAL NOT NULL,
    "carrier_invoice_issue_batch_id" INTEGER NOT NULL,
    "package_group_id" INTEGER NOT NULL,
    "issue_sequence" INTEGER NOT NULL,
    "revision_no" INTEGER NOT NULL DEFAULT 1,
    "item_status" TEXT NOT NULL DEFAULT 'PENDING',
    "carrier_shipment_id" INTEGER,
    "tracking_number_snapshot" TEXT,
    "result_code" TEXT,
    "result_message" TEXT,
    "label_print_status" TEXT NOT NULL DEFAULT 'NOT_PRINTED',
    "label_payload_hash" TEXT,
    "label_print_attempt_no" INTEGER NOT NULL DEFAULT 0,
    "label_print_count" INTEGER NOT NULL DEFAULT 0,
    "label_last_spooled_at" TIMESTAMPTZ(3),
    "label_confirmed_at" TIMESTAMPTZ(3),
    "label_last_error_code" TEXT,
    "label_last_error_message" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "carrier_invoice_issue_items_pkey" PRIMARY KEY ("carrier_invoice_issue_item_id")
);

-- CreateTable
CREATE TABLE "carrier_shipment_registration_works" (
    "revision" INTEGER NOT NULL DEFAULT 0,
    "carrier_shipment_registration_work_id" SERIAL NOT NULL,
    "carrier_shipment_id" INTEGER NOT NULL,
    "carrier_invoice_issue_item_id" INTEGER NOT NULL,
    "package_group_id" INTEGER NOT NULL,
    "worker_job_id" INTEGER,
    "work_status" TEXT NOT NULL DEFAULT 'PENDING',
    "fix_take_no" TEXT NOT NULL,
    "take_date" TEXT NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "execution_token" TEXT,
    "next_attempt_at" TIMESTAMPTZ(3),
    "sender_profile_hash" TEXT,
    "payload_hash" TEXT,
    "customer_code_snapshot" TEXT,
    "sender_name_snapshot" TEXT,
    "sender_tel_snapshot" TEXT,
    "sender_cell_snapshot" TEXT,
    "sender_zip_code_snapshot" TEXT,
    "sender_address_1_snapshot" TEXT,
    "sender_address_2_snapshot" TEXT,
    "receiver_branch_code" TEXT,
    "receiver_dong_name" TEXT,
    "sales_office_name" TEXT,
    "terminal_name" TEXT,
    "branch_share_yn" TEXT,
    "classification_code" TEXT,
    "classified_zip_code" TEXT,
    "jeju_region_yn" TEXT,
    "island_yn" TEXT,
    "mountain_yn" TEXT,
    "fare_type" TEXT,
    "box_type_code" TEXT,
    "delivery_fare" INTEGER,
    "extra_fare" INTEGER,
    "goods_name_snapshot" TEXT,
    "goods_amount_snapshot" INTEGER,
    "classification_api_call_log_id" INTEGER,
    "registration_api_call_log_id" INTEGER,
    "reconciliation_work_id" INTEGER,
    "last_error_code" TEXT,
    "last_error_message" TEXT,
    "prepared_at" TIMESTAMPTZ(3),
    "submitting_at" TIMESTAMPTZ(3),
    "registered_at" TIMESTAMPTZ(3),
    "review_required_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "carrier_shipment_registration_works_pkey" PRIMARY KEY ("carrier_shipment_registration_work_id")
);

-- CreateTable
CREATE TABLE "carrier_reconciliation_works" (
    "revision" INTEGER NOT NULL DEFAULT 0,
    "carrier_reconciliation_work_id" SERIAL NOT NULL,
    "carrier_code" TEXT NOT NULL,
    "operation_type" TEXT NOT NULL,
    "lookup_key_type" TEXT NOT NULL,
    "lookup_key_value" TEXT NOT NULL,
    "reconciliation_status" TEXT NOT NULL DEFAULT 'PENDING',
    "api_call_log_id" INTEGER,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT,
    "last_error_message" TEXT,
    "resolved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "carrier_reconciliation_works_pkey" PRIMARY KEY ("carrier_reconciliation_work_id")
);

-- CreateTable
CREATE TABLE "server_instance_state" (
    "singleton_key" TEXT NOT NULL DEFAULT 'QUICKHACK',
    "instance_epoch" INTEGER NOT NULL DEFAULT 1,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "server_instance_state_pkey" PRIMARY KEY ("singleton_key")
);

INSERT INTO "server_instance_state" ("singleton_key", "instance_epoch", "revision")
VALUES ('QUICKHACK', 1, 0);

-- CreateTable
CREATE TABLE "domain_operation_keys" (
    "operation_id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "operation_key" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "request_digest" TEXT NOT NULL,
    "result_digest" TEXT,
    "status" TEXT NOT NULL DEFAULT 'COMMITTED',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "domain_operation_keys_pkey" PRIMARY KEY ("operation_id")
);

-- CreateTable
CREATE TABLE "integration_commands" (
    "integration_command_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "operation_type" TEXT NOT NULL,
    "operation_key" TEXT NOT NULL,
    "target_snapshot" JSONB NOT NULL,
    "request_payload" JSONB,
    "request_digest" TEXT NOT NULL,
    "command_status" TEXT NOT NULL DEFAULT 'PENDING',
    "lease_token" UUID,
    "claim_generation" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_commands_pkey" PRIMARY KEY ("integration_command_id")
);

-- CreateTable
CREATE TABLE "integration_command_attempts" (
    "integration_command_attempt_id" UUID NOT NULL,
    "integration_command_id" UUID NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "dispatch_status" TEXT NOT NULL DEFAULT 'CREATED',
    "request_dispatched_at" TIMESTAMPTZ(3),
    "response_received_at" TIMESTAMPTZ(3),
    "http_status" INTEGER,
    "provider_code" TEXT,
    "error_code" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_command_attempts_pkey" PRIMARY KEY ("integration_command_attempt_id")
);

-- CreateTable
CREATE TABLE "integration_evidences" (
    "integration_evidence_id" UUID NOT NULL,
    "integration_command_id" UUID,
    "integration_command_attempt_id" UUID,
    "provider" TEXT NOT NULL,
    "evidence_type" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "raw_payload_text" TEXT,
    "raw_payload_digest" TEXT NOT NULL,
    "normalized_result" JSONB,
    "occurred_at" TIMESTAMPTZ(3),
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_evidences_pkey" PRIMARY KEY ("integration_evidence_id")
);

-- CreateTable
CREATE TABLE "integration_projection_jobs" (
    "integration_projection_job_id" UUID NOT NULL,
    "integration_evidence_id" UUID NOT NULL,
    "handler_key" TEXT NOT NULL,
    "projection_context" JSONB,
    "projection_status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "lease_token" UUID,
    "claim_generation" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "last_error_code" TEXT,
    "last_error_message" TEXT,
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_projection_jobs_pkey" PRIMARY KEY ("integration_projection_job_id")
);

-- CreateTable
CREATE TABLE "domain_audit_events" (
    "domain_audit_event_id" UUID NOT NULL,
    "actor_user_id" INTEGER,
    "action" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "operation_key" TEXT,
    "event_type" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "domain_audit_events_pkey" PRIMARY KEY ("domain_audit_event_id")
);

-- CreateTable
CREATE TABLE "domain_audit_event_changes" (
    "domain_audit_event_change_id" UUID NOT NULL,
    "domain_audit_event_id" UUID NOT NULL,
    "field_path" TEXT NOT NULL,
    "before_value" TEXT,
    "after_value" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "domain_audit_event_changes_pkey" PRIMARY KEY ("domain_audit_event_change_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_devices_1" ON "devices"("pg_no");

-- CreateIndex
CREATE UNIQUE INDEX "uq_devices_2" ON "devices"("imei");

-- CreateIndex
CREATE UNIQUE INDEX "uq_devices_3" ON "devices"("adb_serial");

-- CreateIndex
CREATE INDEX "idx_devices_model_code" ON "devices"("model_code");

-- CreateIndex
CREATE INDEX "idx_devices_model_seq" ON "devices"("model", "model_seq");

-- CreateIndex
CREATE INDEX "idx_devices_pg_no" ON "devices"("pg_no");

-- CreateIndex
CREATE INDEX "idx_devices_inventory_sku_id" ON "devices"("inventory_sku_id");

-- CreateIndex
CREATE INDEX "idx_devices_updated_latest" ON "devices"("updated_at", "device_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_devices_4" ON "devices"("model", "model_seq");

-- CreateIndex
CREATE INDEX "idx_inbounds_supplier_name" ON "inbounds"("supplier_name");

-- CreateIndex
CREATE INDEX "idx_inbounds_inbound_batch_id" ON "inbounds"("inbound_batch_id");

-- CreateIndex
CREATE INDEX "idx_inbounds_pg_no" ON "inbounds"("pg_no");
CREATE INDEX "idx_inbounds_pg_history" ON "inbounds"("pg_no", "inbound_id");

-- CreateIndex
CREATE INDEX "idx_inbounds_status" ON "inbounds"("inbound_status");

-- CreateIndex
CREATE INDEX "idx_inbounds_status_pg_latest" ON "inbounds"("inbound_status", "pg_no", "inbound_id");

-- CreateIndex
CREATE INDEX "idx_inbounds_purchase_price_updated_by_user_id" ON "inbounds"("purchase_price_updated_by_user_id");

-- CreateIndex
CREATE INDEX "idx_inbounds_purchase_price_reference_rate_id" ON "inbounds"("purchase_price_reference_rate_id");

-- CreateIndex
CREATE INDEX "idx_inbound_batches_batch_date" ON "inbound_batches"("batch_date");

-- CreateIndex
CREATE INDEX "idx_inbound_batches_batch_no" ON "inbound_batches"("batch_no");

-- CreateIndex
CREATE INDEX "idx_inbound_batches_expected_quantity" ON "inbound_batches"("expected_quantity");

-- CreateIndex
CREATE INDEX "idx_inbound_batches_created_by_user_id" ON "inbound_batches"("created_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_inbound_batches_date_no" ON "inbound_batches"("batch_date", "batch_no");

-- CreateIndex
CREATE INDEX "idx_inspections_pg_no" ON "inspections"("pg_no");
CREATE INDEX "idx_inspections_pg_history" ON "inspections"("pg_no", "inspection_id");

-- CreateIndex
CREATE INDEX "idx_inspections_pg_type_latest" ON "inspections"("pg_no", "inspection_type", "inspection_id");

-- CreateIndex
CREATE INDEX "idx_inspections_inbound_id" ON "inspections"("inbound_id");

-- CreateIndex
CREATE INDEX "idx_inspections_type" ON "inspections"("inspection_type");

-- CreateIndex
CREATE INDEX "idx_inspections_source_return_allocation" ON "inspections"("source_type", "coupang_return_allocation_id");

-- CreateIndex
CREATE INDEX "idx_inspections_checked_by_user_id" ON "inspections"("checked_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_inventory_1" ON "inventory"("pg_no");

-- CreateIndex
CREATE INDEX "idx_inventory_status" ON "inventory"("inventory_status");

-- CreateIndex
CREATE INDEX "idx_inventory_status_pg" ON "inventory"("inventory_status", "pg_no");

-- CreateIndex
CREATE INDEX "idx_inventory_pg_no" ON "inventory"("pg_no");

-- CreateIndex
CREATE INDEX "idx_inventory_quantity_balances_status_quantity" ON "inventory_quantity_balances"("inventory_status", "quantity");

-- CreateIndex
CREATE INDEX "idx_inventory_quantity_balances_sku_quantity" ON "inventory_quantity_balances"("inventory_sku_id", "quantity");

-- CreateIndex
CREATE INDEX "idx_inventory_quantity_balances_updated_at" ON "inventory_quantity_balances"("updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_inventory_quantity_balances_sku_status" ON "inventory_quantity_balances"("inventory_sku_id", "inventory_status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_inventory_quantity_movements_idempotency_key" ON "inventory_quantity_movements"("idempotency_key");

-- CreateIndex
CREATE INDEX "idx_inventory_quantity_movements_balance_time" ON "inventory_quantity_movements"("inventory_quantity_balance_id", "occurred_at");

-- CreateIndex
CREATE INDEX "idx_inventory_quantity_movements_operation_key" ON "inventory_quantity_movements"("operation_key");

-- CreateIndex
CREATE INDEX "idx_inventory_quantity_movements_type_time" ON "inventory_quantity_movements"("movement_type", "occurred_at");

-- CreateIndex
CREATE INDEX "idx_inventory_quantity_movements_source" ON "inventory_quantity_movements"("source_type", "source_id");

-- CreateIndex
CREATE INDEX "idx_inventory_quantity_movements_pg_no" ON "inventory_quantity_movements"("pg_no");

-- CreateIndex
CREATE INDEX "idx_inventory_quantity_movements_actor_user_id" ON "inventory_quantity_movements"("actor_user_id");

-- CreateIndex
CREATE INDEX "idx_inventory_quantity_movements_worker_job_id" ON "inventory_quantity_movements"("worker_job_id");

-- CreateIndex
CREATE INDEX "idx_inventory_quantity_movements_occurred_at" ON "inventory_quantity_movements"("occurred_at");

-- CreateIndex
CREATE INDEX "idx_order_items_match_status" ON "order_items"("match_status");

-- CreateIndex
CREATE INDEX "idx_order_items_pg_no" ON "order_items"("pg_no");
CREATE INDEX "idx_order_items_pg_history" ON "order_items"("pg_no", "order_item_id");

-- CreateIndex
CREATE INDEX "idx_order_items_order_id" ON "order_items"("order_id");

-- CreateIndex
CREATE INDEX "idx_orders_ordered_at" ON "orders"("ordered_at");

-- CreateIndex
CREATE INDEX "idx_orders_platform_order_id" ON "orders"("platform", "platform_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_orders_1" ON "orders"("platform", "platform_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_users_1" ON "users"("username");

-- CreateIndex
CREATE INDEX "idx_users_is_active" ON "users"("is_active");

-- CreateIndex
CREATE INDEX "idx_users_is_developer" ON "users"("is_developer");

-- CreateIndex
CREATE INDEX "idx_users_mobile_packing_enabled" ON "users"("mobile_packing_enabled");

-- CreateIndex
CREATE INDEX "idx_users_role" ON "users"("role");

-- CreateIndex
CREATE INDEX "idx_users_username" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "uq_mobile_registered_devices_provisioning_token_hash" ON "mobile_registered_devices"("provisioning_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "uq_mobile_registered_devices_token_hash" ON "mobile_registered_devices"("device_token_hash");

-- CreateIndex
CREATE INDEX "idx_mobile_registered_devices_user_page" ON "mobile_registered_devices"("user_id", "device_id");

-- CreateIndex
CREATE INDEX "idx_mobile_registered_devices_adb_serial_hmac" ON "mobile_registered_devices"("adb_serial_hmac");

-- CreateIndex
CREATE INDEX "idx_mobile_registered_devices_state_page" ON "mobile_registered_devices"("registration_state", "device_id");

-- One physical ADB device may have only one live QuickHack registration.
CREATE UNIQUE INDEX "uq_mobile_registered_devices_live_adb_serial" ON "mobile_registered_devices"("adb_serial_hmac") WHERE "registration_state" IN ('PROVISIONING', 'ACTIVE');

CREATE UNIQUE INDEX "uq_mobile_registered_devices_active_public_key" ON "mobile_registered_devices"("device_public_key_fingerprint") WHERE "registration_state" = 'ACTIVE';

-- CreateIndex
CREATE INDEX "idx_mobile_registered_devices_last_seen_at" ON "mobile_registered_devices"("last_seen_at");

-- CreateIndex
CREATE INDEX "idx_mobile_registered_devices_registered_by" ON "mobile_registered_devices"("registered_by_user_id");

-- CreateIndex
CREATE INDEX "idx_mobile_registered_devices_revoked_by" ON "mobile_registered_devices"("revoked_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_user_totp_credentials_1" ON "user_totp_credentials"("user_id");

-- CreateIndex
CREATE INDEX "idx_user_totp_credentials_user_id" ON "user_totp_credentials"("user_id");

-- CreateIndex
CREATE INDEX "idx_user_totp_credentials_enabled" ON "user_totp_credentials"("enabled");

-- CreateIndex
CREATE INDEX "idx_user_totp_credentials_locked_until" ON "user_totp_credentials"("locked_until");

-- CreateIndex
CREATE UNIQUE INDEX "uq_user_totp_recovery_codes_1" ON "user_totp_recovery_codes"("code_hash");

-- CreateIndex
CREATE INDEX "idx_user_totp_recovery_codes_user_id" ON "user_totp_recovery_codes"("user_id");

-- CreateIndex
CREATE INDEX "idx_user_totp_recovery_codes_used_at" ON "user_totp_recovery_codes"("used_at");

-- CreateIndex
CREATE UNIQUE INDEX "idx_employee_profiles_user_id_unique" ON "employee_profiles"("user_id");

-- CreateIndex
CREATE INDEX "idx_employee_profiles_display_name" ON "employee_profiles"("display_name");

-- CreateIndex
CREATE INDEX "idx_user_shortcut_bindings_action" ON "user_shortcut_bindings"("action_code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_user_shortcut_combination" ON "user_shortcut_bindings"("user_id", "modifier", "key_code");

-- CreateIndex
CREATE INDEX "idx_employee_activity_logs_user_id" ON "employee_activity_logs"("user_id");

-- CreateIndex
CREATE INDEX "idx_employee_activity_logs_action_type" ON "employee_activity_logs"("action_type");

-- CreateIndex
CREATE INDEX "idx_employee_activity_logs_target" ON "employee_activity_logs"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "idx_employee_activity_logs_result" ON "employee_activity_logs"("result");

-- CreateIndex
CREATE INDEX "idx_employee_activity_logs_created_at" ON "employee_activity_logs"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_carrier_integration_settings_carrier" ON "carrier_integration_settings"("carrier_code");

-- CreateIndex
CREATE INDEX "idx_carrier_integration_settings_updated_by" ON "carrier_integration_settings"("updated_by_user_id");

-- CreateIndex
CREATE INDEX "idx_employee_activity_log_changes_log_id" ON "employee_activity_log_changes"("activity_log_id");

-- CreateIndex
CREATE INDEX "idx_employee_activity_log_changes_field_name" ON "employee_activity_log_changes"("field_name");

-- CreateIndex
CREATE INDEX "idx_server_job_logs_job_type" ON "server_job_logs"("job_type");

-- CreateIndex
CREATE INDEX "idx_server_job_logs_status" ON "server_job_logs"("status");

-- CreateIndex
CREATE INDEX "idx_server_job_logs_triggered_by_user_id" ON "server_job_logs"("triggered_by_user_id");

-- CreateIndex
CREATE INDEX "idx_server_job_logs_started_at" ON "server_job_logs"("started_at");

-- CreateIndex
CREATE INDEX "idx_server_job_logs_type_started_id" ON "server_job_logs"("job_type", "started_at", "id");

-- CreateIndex
CREATE INDEX "idx_server_job_logs_finished_at" ON "server_job_logs"("finished_at");

-- CreateIndex
CREATE INDEX "idx_server_job_log_fields_log_id" ON "server_job_log_fields"("server_job_log_id");

-- CreateIndex
CREATE INDEX "idx_server_job_log_fields_field_name" ON "server_job_log_fields"("field_name");

-- CreateIndex
CREATE UNIQUE INDEX "uq_client_http_trace_observations_trace_id" ON "client_http_trace_observations"("trace_id");

-- CreateIndex
CREATE INDEX "idx_client_http_trace_observations_reported_by" ON "client_http_trace_observations"("reported_by_user_id");

-- CreateIndex
CREATE INDEX "idx_client_http_trace_observations_observed_at" ON "client_http_trace_observations"("observed_at");

-- CreateIndex
CREATE INDEX "idx_client_http_trace_observations_created_at" ON "client_http_trace_observations"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "idx_server_worker_jobs_worker_key_unique" ON "server_worker_jobs"("worker_key");

-- CreateIndex
CREATE INDEX "idx_server_worker_jobs_worker_type" ON "server_worker_jobs"("worker_type");

-- CreateIndex
CREATE INDEX "idx_server_worker_jobs_status" ON "server_worker_jobs"("status");

-- CreateIndex
CREATE INDEX "idx_server_worker_jobs_schedule" ON "server_worker_jobs"("schedule_enabled", "next_run_at");

-- CreateIndex
CREATE INDEX "idx_server_worker_jobs_locked_until" ON "server_worker_jobs"("locked_until");

-- CreateIndex
CREATE INDEX "idx_server_worker_jobs_triggered_by_user_id" ON "server_worker_jobs"("triggered_by_user_id");

-- CreateIndex
CREATE INDEX "idx_statistics_snapshot_batch_lookup" ON "statistics_snapshot_batches"("calculation_version", "data_cutoff_date");

-- CreateIndex
CREATE INDEX "idx_statistics_snapshot_batch_status_cutoff" ON "statistics_snapshot_batches"("status", "data_cutoff_date");

-- CreateIndex
CREATE INDEX "idx_statistics_snapshot_batch_worker_job" ON "statistics_snapshot_batches"("worker_job_id");

-- CreateIndex
CREATE INDEX "idx_statistics_snapshot_item_domain_batch" ON "statistics_snapshot_items"("domain", "snapshot_batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_statistics_snapshot_item_batch_domain" ON "statistics_snapshot_items"("snapshot_batch_id", "domain");

-- CreateIndex
CREATE INDEX "idx_purchase_price_rates_price_date_note" ON "purchase_price_rates"("price_date", "note");

-- CreateIndex
CREATE INDEX "idx_purchase_price_rates_option_ids" ON "purchase_price_rates"("model_option_id", "storage_option_id", "appearance_grade_option_id");

-- CreateIndex
CREATE INDEX "idx_purchase_price_rates_created_by_user_id" ON "purchase_price_rates"("created_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_purchase_price_rates_1" ON "purchase_price_rates"("model_option_id", "storage_option_id", "appearance_grade_option_id", "price_date", "note");

-- CreateIndex
CREATE INDEX "idx_product_criteria_options_category_active_sort" ON "product_criteria_options"("category", "is_active", "sort_order");

-- CreateIndex
CREATE INDEX "idx_product_criteria_options_parent" ON "product_criteria_options"("category", "parent_key");

-- CreateIndex
CREATE INDEX "idx_product_criteria_options_updated_by_user_id" ON "product_criteria_options"("updated_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_product_criteria_options_1" ON "product_criteria_options"("category", "option_key", "parent_key");

-- CreateIndex
CREATE INDEX "idx_product_criteria_option_links_type_active_sort" ON "product_criteria_option_links"("relation_type", "is_active", "sort_order");

-- CreateIndex
CREATE INDEX "idx_product_criteria_option_links_parent" ON "product_criteria_option_links"("parent_option_id");

-- CreateIndex
CREATE INDEX "idx_product_criteria_option_links_child" ON "product_criteria_option_links"("child_option_id");

-- CreateIndex
CREATE INDEX "idx_product_criteria_option_links_updated_by_user_id" ON "product_criteria_option_links"("updated_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_product_criteria_option_links_1" ON "product_criteria_option_links"("relation_type", "parent_option_id", "child_option_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_inventory_skus_sku_code" ON "inventory_skus"("sku_code");

-- CreateIndex
CREATE INDEX "idx_inventory_skus_model_storage" ON "inventory_skus"("model_option_id", "storage_option_id");

-- CreateIndex
CREATE INDEX "idx_inventory_skus_color_option_id" ON "inventory_skus"("color_option_id");

-- CreateIndex
CREATE INDEX "idx_inventory_skus_sale_grade_option_id" ON "inventory_skus"("sale_grade_option_id");

-- CreateIndex
CREATE INDEX "idx_inventory_skus_is_active" ON "inventory_skus"("is_active");

-- CreateIndex
CREATE INDEX "idx_inventory_skus_created_by_user_id" ON "inventory_skus"("created_by_user_id");

-- CreateIndex
CREATE INDEX "idx_inventory_skus_updated_by_user_id" ON "inventory_skus"("updated_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_inventory_skus_dimensions" ON "inventory_skus"("model_option_id", "storage_option_id", "color_option_id", "sale_grade_option_id");

-- CreateIndex
CREATE INDEX "idx_product_camera_check_rules_model_active_sort" ON "product_camera_check_rules"("model_option_id", "is_active", "sort_order");

-- CreateIndex
CREATE INDEX "idx_product_camera_check_rules_lens_option" ON "product_camera_check_rules"("camera_lens_option_id");

-- CreateIndex
CREATE INDEX "idx_product_camera_check_rules_focus_option" ON "product_camera_check_rules"("focus_rule_option_id");

-- CreateIndex
CREATE INDEX "idx_product_camera_check_rules_updated_by_user_id" ON "product_camera_check_rules"("updated_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_product_camera_check_rules_1" ON "product_camera_check_rules"("model_option_id", "camera_name");

-- CreateIndex
CREATE UNIQUE INDEX "uq_product_camera_check_rules_model_lens" ON "product_camera_check_rules"("model_option_id", "camera_lens_option_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_user_sessions_1" ON "user_sessions"("session_token_hash");

-- CreateIndex
CREATE INDEX "idx_user_sessions_expires_at" ON "user_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "idx_user_sessions_sensitive_verified_until" ON "user_sessions"("sensitive_verified_until");

-- CreateIndex
CREATE INDEX "idx_user_sessions_token_hash" ON "user_sessions"("session_token_hash");

-- CreateIndex
CREATE INDEX "idx_user_sessions_user_id" ON "user_sessions"("user_id");

-- CreateIndex
CREATE INDEX "idx_user_sensitive_auth_grants_session_id" ON "user_sensitive_auth_grants"("session_id");

-- CreateIndex
CREATE INDEX "idx_user_sensitive_auth_grants_action" ON "user_sensitive_auth_grants"("sensitive_action");

-- CreateIndex
CREATE INDEX "idx_user_sensitive_auth_grants_verified_until" ON "user_sensitive_auth_grants"("verified_until");

-- CreateIndex
CREATE INDEX "idx_user_sensitive_auth_grants_totp_credential_id" ON "user_sensitive_auth_grants"("totp_credential_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_user_sensitive_auth_grants_session_action" ON "user_sensitive_auth_grants"("session_id", "sensitive_action");

-- CreateIndex
CREATE INDEX "idx_login_attempts_username" ON "login_attempts"("username");

-- CreateIndex
CREATE INDEX "idx_login_attempts_blocked_until" ON "login_attempts"("blocked_until");

-- CreateIndex
CREATE INDEX "idx_login_attempts_updated_at" ON "login_attempts"("updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_sales_offers_offer_code" ON "sales_offers"("offer_code");

-- CreateIndex
CREATE INDEX "idx_sales_offers_model_warranty" ON "sales_offers"("model_option_id", "warranty_group_option_id");

-- CreateIndex
CREATE INDEX "idx_sales_offers_storage_option_id" ON "sales_offers"("storage_option_id");

-- CreateIndex
CREATE INDEX "idx_sales_offers_color_option_id" ON "sales_offers"("color_option_id");

-- CreateIndex
CREATE INDEX "idx_sales_offers_is_active" ON "sales_offers"("is_active");

-- CreateIndex
CREATE INDEX "idx_sales_offers_created_by_user_id" ON "sales_offers"("created_by_user_id");

-- CreateIndex
CREATE INDEX "idx_sales_offers_updated_by_user_id" ON "sales_offers"("updated_by_user_id");

-- CreateIndex
CREATE INDEX "idx_sales_channel_product_mappings_status" ON "sales_channel_product_mappings"("mapping_status");

-- CreateIndex
CREATE INDEX "idx_sales_channel_product_mappings_offer_id" ON "sales_channel_product_mappings"("sales_offer_id");

-- CreateIndex
CREATE INDEX "idx_sales_channel_product_mappings_mapped_by_user_id" ON "sales_channel_product_mappings"("mapped_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_sales_channel_product_mappings_channel_vendor" ON "sales_channel_product_mappings"("channel", "external_vendor_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_sales_channel_inventory_verification_states_mapping" ON "sales_channel_inventory_verification_states"("mapping_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_sales_channel_inventory_verification_states_last_api_call" ON "sales_channel_inventory_verification_states"("last_api_call_log_id");

-- CreateIndex
CREATE INDEX "idx_sales_channel_inventory_verification_states_status_updated" ON "sales_channel_inventory_verification_states"("verification_status", "updated_at");

-- CreateIndex
CREATE INDEX "idx_sales_channel_inventory_verification_states_next_retry" ON "sales_channel_inventory_verification_states"("next_retry_at");

-- CreateIndex
CREATE INDEX "idx_sales_channel_inventory_verification_states_offer" ON "sales_channel_inventory_verification_states"("sales_offer_id");

-- CreateIndex
CREATE INDEX "idx_sales_channel_inventory_verification_states_worker" ON "sales_channel_inventory_verification_states"("last_worker_job_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_sales_channel_inventory_verification_states_channel_vendor" ON "sales_channel_inventory_verification_states"("channel", "external_vendor_item_id");

-- CreateIndex
CREATE INDEX "idx_order_matching_policies_is_active" ON "order_matching_policies"("is_active");

-- CreateIndex
CREATE INDEX "idx_order_matching_policies_updated_at" ON "order_matching_policies"("updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_order_matching_policies_sales_offer_id" ON "order_matching_policies"("sales_offer_id");

-- CreateIndex
CREATE INDEX "idx_order_matching_priority_tiers_policy_id" ON "order_matching_priority_tiers"("policy_id");

-- CreateIndex
CREATE INDEX "idx_order_matching_priority_tiers_is_enabled" ON "order_matching_priority_tiers"("is_enabled");

-- CreateIndex
CREATE UNIQUE INDEX "uq_order_matching_priority_tiers_policy_order" ON "order_matching_priority_tiers"("policy_id", "priority_order");

-- CreateIndex
CREATE INDEX "idx_order_matching_tier_sale_grades_tier_id" ON "order_matching_priority_tier_sale_grades"("tier_id");

-- CreateIndex
CREATE INDEX "idx_order_matching_tier_sale_grades_option_id" ON "order_matching_priority_tier_sale_grades"("sale_grade_option_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_order_matching_tier_sale_grades_option" ON "order_matching_priority_tier_sale_grades"("tier_id", "sale_grade_option_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_order_matching_tier_sale_grades_sort" ON "order_matching_priority_tier_sale_grades"("tier_id", "sort_order");

-- CreateIndex
CREATE INDEX "idx_order_matching_work_queue_channel_order_id" ON "order_matching_work_queue"("channel", "external_order_id");

-- CreateIndex
CREATE INDEX "idx_order_matching_work_queue_shipment_id" ON "order_matching_work_queue"("external_shipment_id");

-- CreateIndex
CREATE INDEX "idx_order_matching_work_queue_vendor_item_id" ON "order_matching_work_queue"("external_vendor_item_id");

-- CreateIndex
CREATE INDEX "idx_order_matching_work_queue_mapping_status" ON "order_matching_work_queue"("mapping_status");

-- CreateIndex
CREATE INDEX "idx_order_matching_work_queue_mapping_failure_reason" ON "order_matching_work_queue"("mapping_failure_reason");

-- CreateIndex
CREATE INDEX "idx_order_matching_work_queue_sales_offer_id" ON "order_matching_work_queue"("sales_offer_id");

-- CreateIndex
CREATE INDEX "idx_order_matching_work_queue_work_status" ON "order_matching_work_queue"("work_status");

-- CreateIndex
CREATE INDEX "idx_order_matching_work_queue_work_failure_reason" ON "order_matching_work_queue"("work_failure_reason");

-- CreateIndex
CREATE INDEX "idx_order_matching_work_queue_ordered_id" ON "order_matching_work_queue"("ordered_at", "work_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_order_matching_work_queue_channel_order_shipment_vendor" ON "order_matching_work_queue"("channel", "external_order_id", "external_shipment_id", "external_vendor_item_id");

-- CreateIndex
CREATE INDEX "idx_sales_channel_shipment_print_batches_channel_tab_date" ON "sales_channel_shipment_list_print_batches"("channel", "tab_key", "print_date");

-- CreateIndex
CREATE INDEX "idx_sales_channel_shipment_print_batches_status" ON "sales_channel_shipment_list_print_batches"("batch_status");

-- CreateIndex
CREATE INDEX "idx_sales_channel_shipment_print_batches_printed_at" ON "sales_channel_shipment_list_print_batches"("printed_at");

-- CreateIndex
CREATE INDEX "idx_sales_channel_shipment_print_batches_confirmed_at" ON "sales_channel_shipment_list_print_batches"("confirmed_at");

-- CreateIndex
CREATE INDEX "idx_sales_channel_shipment_print_batches_user_id" ON "sales_channel_shipment_list_print_batches"("printed_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_sales_channel_shipment_print_batches_channel_tab_date_no" ON "sales_channel_shipment_list_print_batches"("channel", "tab_key", "print_date", "batch_no");

-- CreateIndex
CREATE INDEX "idx_sales_channel_shipment_print_batch_items_batch_id" ON "sales_channel_shipment_list_print_batch_items"("shipment_list_print_batch_id");

-- CreateIndex
CREATE INDEX "idx_sales_channel_shipment_print_batch_items_channel_tab_date" ON "sales_channel_shipment_list_print_batch_items"("channel", "tab_key", "print_date");

-- CreateIndex
CREATE INDEX "idx_sales_channel_shipment_print_batch_items_allocation_id" ON "sales_channel_shipment_list_print_batch_items"("allocation_id");

-- CreateIndex
CREATE INDEX "idx_sales_channel_shipment_print_batch_items_package_group_id" ON "sales_channel_shipment_list_print_batch_items"("package_group_id");

-- CreateIndex
CREATE INDEX "idx_sales_channel_shipment_print_batch_items_pg_no" ON "sales_channel_shipment_list_print_batch_items"("pg_no");

-- CreateIndex
CREATE UNIQUE INDEX "uq_sales_channel_shipment_print_batch_items_batch_allocation" ON "sales_channel_shipment_list_print_batch_items"("shipment_list_print_batch_id", "allocation_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_sales_channel_shipment_print_batch_items_list_date_line_no" ON "sales_channel_shipment_list_print_batch_items"("channel", "tab_key", "print_date", "print_line_no");

-- CreateIndex
CREATE UNIQUE INDEX "uq_sales_channel_shipment_print_batch_items_batch_line_no" ON "sales_channel_shipment_list_print_batch_items"("shipment_list_print_batch_id", "print_line_no");

-- CreateIndex
CREATE INDEX "idx_coupang_order_raw_order_id" ON "coupang_order_raw"("external_order_id");

-- CreateIndex
CREATE INDEX "idx_coupang_order_raw_shipment_id" ON "coupang_order_raw"("external_shipment_id");

-- CreateIndex
CREATE INDEX "idx_coupang_order_raw_status" ON "coupang_order_raw"("external_order_status");

-- CreateIndex
CREATE INDEX "idx_coupang_order_raw_ordered_at" ON "coupang_order_raw"("ordered_at");

-- CreateIndex
CREATE INDEX "idx_coupang_order_raw_synced_at" ON "coupang_order_raw"("synced_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_coupang_order_raw_order_shipment" ON "coupang_order_raw"("external_order_id", "external_shipment_id");

-- CreateIndex
CREATE INDEX "idx_sales_channel_personal_data_lifecycle_due" ON "sales_channel_personal_data_lifecycles"("active_claim_count", "redacted_at", "retention_started_at");

-- CreateIndex
CREATE INDEX "idx_sales_channel_personal_data_lifecycle_order" ON "sales_channel_personal_data_lifecycles"("channel", "external_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_sales_channel_personal_data_lifecycle_subject" ON "sales_channel_personal_data_lifecycles"("channel", "external_order_id", "external_shipment_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_coupang_return_raw_1" ON "coupang_return_raw"("external_receipt_id");

-- CreateIndex
CREATE INDEX "idx_coupang_return_raw_order_id" ON "coupang_return_raw"("external_order_id");

-- CreateIndex
CREATE INDEX "idx_coupang_return_raw_shipment_id" ON "coupang_return_raw"("external_shipment_id");

-- CreateIndex
CREATE INDEX "idx_coupang_return_raw_receipt_status" ON "coupang_return_raw"("return_receipt_status");

-- CreateIndex
CREATE INDEX "idx_coupang_return_raw_release_status" ON "coupang_return_raw"("return_release_status");

-- CreateIndex
CREATE INDEX "idx_coupang_return_raw_item_return_id" ON "coupang_return_raw_item"("coupang_return_raw_id");

-- CreateIndex
CREATE INDEX "idx_coupang_return_raw_item_receipt_id" ON "coupang_return_raw_item"("external_receipt_id");

-- CreateIndex
CREATE INDEX "idx_coupang_return_raw_item_order_id" ON "coupang_return_raw_item"("external_order_id");

-- CreateIndex
CREATE INDEX "idx_coupang_return_raw_item_shipment_id" ON "coupang_return_raw_item"("external_shipment_id");

-- CreateIndex
CREATE INDEX "idx_coupang_return_raw_item_vendor_item_id" ON "coupang_return_raw_item"("external_vendor_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_coupang_return_withdrawal_receipt" ON "coupang_return_withdrawal"("external_receipt_id");

-- CreateIndex
CREATE INDEX "idx_coupang_return_withdrawal_order" ON "coupang_return_withdrawal"("external_order_id");

-- CreateIndex
CREATE INDEX "idx_coupang_return_withdrawal_revision" ON "coupang_return_withdrawal"("projection_revision");

-- CreateIndex
CREATE INDEX "idx_coupang_return_allocation_return_id" ON "coupang_return_allocation"("coupang_return_raw_id");

-- CreateIndex
CREATE INDEX "idx_coupang_return_allocation_allocation_id" ON "coupang_return_allocation"("allocation_id");

-- CreateIndex
CREATE INDEX "idx_coupang_return_allocation_receipt_id" ON "coupang_return_allocation"("external_receipt_id");

-- CreateIndex
CREATE INDEX "idx_coupang_return_allocation_order_id" ON "coupang_return_allocation"("external_order_id");

-- CreateIndex
CREATE INDEX "idx_coupang_return_allocation_pg_no" ON "coupang_return_allocation"("pg_no");
CREATE INDEX "idx_coupang_return_allocation_pg_history" ON "coupang_return_allocation"("pg_no", "coupang_return_allocation_id");

-- CreateIndex
CREATE INDEX "idx_coupang_return_allocation_user_id" ON "coupang_return_allocation"("linked_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_coupang_return_allocation_return_allocation" ON "coupang_return_allocation"("coupang_return_raw_id", "allocation_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_coupang_exchange_raw_1" ON "coupang_exchange_raw"("external_exchange_id");

-- CreateIndex
CREATE INDEX "idx_coupang_exchange_raw_order_id" ON "coupang_exchange_raw"("external_order_id");

-- CreateIndex
CREATE INDEX "idx_coupang_exchange_raw_shipment_id" ON "coupang_exchange_raw"("external_shipment_id");

-- CreateIndex
CREATE INDEX "idx_coupang_exchange_raw_status" ON "coupang_exchange_raw"("exchange_status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_coupang_exchange_scope_exchange_shipment" ON "coupang_exchange_shipment_scope"("coupang_exchange_raw_id", "external_shipment_id");

-- CreateIndex
CREATE INDEX "idx_coupang_exchange_scope_order_shipment" ON "coupang_exchange_shipment_scope"("external_order_id", "external_shipment_id");

-- CreateIndex
CREATE INDEX "idx_coupang_exchange_scope_exchange" ON "coupang_exchange_shipment_scope"("external_exchange_id");

-- CreateIndex
CREATE INDEX "idx_match_worker_allocation_order_id" ON "match_worker_allocation"("external_order_id");

-- CreateIndex
CREATE INDEX "idx_match_worker_allocation_pg_no" ON "match_worker_allocation"("pg_no");
CREATE INDEX "idx_match_worker_allocation_pg_history" ON "match_worker_allocation"("pg_no", "allocation_id");

-- CreateIndex
CREATE INDEX "idx_match_worker_allocation_shipment_id" ON "match_worker_allocation"("external_shipment_id");

-- CreateIndex
CREATE INDEX "idx_match_worker_allocation_vendor_item_id" ON "match_worker_allocation"("external_vendor_item_id");

-- CreateIndex
CREATE INDEX "idx_match_worker_allocation_sales_offer_id" ON "match_worker_allocation"("sales_offer_id");

-- CreateIndex
CREATE INDEX "idx_match_worker_allocation_inventory_sku_id" ON "match_worker_allocation"("inventory_sku_id");

-- CreateIndex
CREATE INDEX "idx_match_worker_allocation_status" ON "match_worker_allocation"("allocation_status");

-- CreateIndex
CREATE INDEX "idx_match_worker_allocation_printed_at" ON "match_worker_allocation"("shipment_list_printed_at");

-- CreateIndex
CREATE INDEX "idx_match_worker_allocation_print_batch_id" ON "match_worker_allocation"("shipment_list_print_batch_id");

-- CreateIndex
CREATE INDEX "idx_match_worker_allocation_print_batch_no" ON "match_worker_allocation"("shipment_list_print_batch_no");

-- CreateIndex
CREATE INDEX "idx_match_worker_allocation_worker_job_id" ON "match_worker_allocation"("worker_job_id");

-- CreateIndex
CREATE INDEX "idx_match_worker_allocation_allocated_at" ON "match_worker_allocation"("allocated_at");

-- CreateIndex
CREATE INDEX "idx_shipment_package_groups_channel_key" ON "shipment_package_groups"("channel", "grouping_key");

-- CreateIndex
CREATE INDEX "idx_shipment_package_groups_status" ON "shipment_package_groups"("group_status");

-- CreateIndex
CREATE INDEX "idx_shipment_package_groups_current_carrier_shipment" ON "shipment_package_groups"("current_carrier_shipment_id");

-- CreateIndex
CREATE INDEX "idx_shipment_package_groups_split_from" ON "shipment_package_groups"("split_from_group_id");

-- CreateIndex
CREATE INDEX "idx_shipment_package_groups_created_at" ON "shipment_package_groups"("created_at");

-- CreateIndex
CREATE INDEX "idx_shipment_package_group_members_allocation" ON "shipment_package_group_members"("allocation_id");

-- CreateIndex
CREATE INDEX "idx_shipment_package_group_members_order" ON "shipment_package_group_members"("external_order_id");

-- CreateIndex
CREATE INDEX "idx_shipment_package_group_members_shipment" ON "shipment_package_group_members"("external_shipment_id");

-- CreateIndex
CREATE INDEX "idx_shipment_package_group_members_removed_at" ON "shipment_package_group_members"("removed_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_shipment_package_group_members_group_allocation" ON "shipment_package_group_members"("package_group_id", "allocation_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_shipment_package_group_members_group_sequence" ON "shipment_package_group_members"("package_group_id", "member_sequence");

-- CreateIndex
CREATE UNIQUE INDEX "uq_sales_records_1" ON "sales_records"("allocation_id");

-- CreateIndex
CREATE INDEX "idx_sales_records_pg_no" ON "sales_records"("pg_no");

-- CreateIndex
CREATE INDEX "idx_sales_records_sales_offer_id" ON "sales_records"("sales_offer_id");

-- CreateIndex
CREATE INDEX "idx_sales_records_inventory_sku_id" ON "sales_records"("inventory_sku_id");

-- CreateIndex
CREATE INDEX "idx_sales_records_channel_order_id" ON "sales_records"("channel", "external_order_id");

-- CreateIndex
CREATE INDEX "idx_sales_records_shipment_id" ON "sales_records"("external_shipment_id");

-- CreateIndex
CREATE INDEX "idx_sales_records_vendor_item_id" ON "sales_records"("external_vendor_item_id");

-- CreateIndex
CREATE INDEX "idx_sales_records_sold_at" ON "sales_records"("sold_at");

-- CreateIndex
CREATE INDEX "idx_sales_records_status" ON "sales_records"("sale_status");

-- CreateIndex
CREATE INDEX "idx_sales_records_model_storage_grade" ON "sales_records"("model", "storage", "sale_grade");

-- CreateIndex
CREATE INDEX "idx_sales_records_purchase_inbound_id" ON "sales_records"("purchase_inbound_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_sales_channel_write_requests_idempotency" ON "sales_channel_write_requests"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "uq_sales_channel_write_requests_active_review_attempt" ON "sales_channel_write_requests"("active_review_attempt_id");

-- CreateIndex
CREATE INDEX "idx_sales_channel_write_requests_channel_type" ON "sales_channel_write_requests"("channel", "request_type");

-- CreateIndex
CREATE INDEX "idx_sales_channel_write_requests_status" ON "sales_channel_write_requests"("request_status");

-- CreateIndex
CREATE INDEX "idx_sales_channel_write_requests_failure_stage" ON "sales_channel_write_requests"("failure_stage");

-- CreateIndex
CREATE INDEX "idx_sales_channel_write_requests_order_id" ON "sales_channel_write_requests"("external_order_id");

-- CreateIndex
CREATE INDEX "idx_sales_channel_write_requests_allocation_id" ON "sales_channel_write_requests"("allocation_id");

-- CreateIndex
CREATE INDEX "idx_sales_channel_write_requests_pg_no" ON "sales_channel_write_requests"("pg_no");

-- CreateIndex
CREATE INDEX "idx_sales_channel_write_requests_target" ON "sales_channel_write_requests"("target_type", "target_external_id");

-- CreateIndex
CREATE INDEX "idx_sales_channel_write_requests_package_group" ON "sales_channel_write_requests"("package_group_id");

-- CreateIndex
CREATE INDEX "idx_sales_channel_write_requests_carrier_shipment" ON "sales_channel_write_requests"("carrier_shipment_id");

-- CreateIndex
CREATE INDEX "idx_sales_channel_write_requests_requested_at" ON "sales_channel_write_requests"("requested_at");

-- CreateIndex
CREATE INDEX "idx_sales_channel_write_requests_worker_job_id" ON "sales_channel_write_requests"("worker_job_id");

-- CreateIndex
CREATE INDEX "idx_sales_channel_write_requests_requested_by" ON "sales_channel_write_requests"("requested_by_user_id");

-- CreateIndex
CREATE INDEX "idx_sales_channel_write_requests_verified_by" ON "sales_channel_write_requests"("manual_verified_by_user_id");

-- CreateIndex
CREATE INDEX "idx_sales_channel_write_requests_review_heartbeat" ON "sales_channel_write_requests"("active_review_heartbeat_at");

-- CreateIndex
CREATE INDEX "idx_sales_channel_write_targets_request_id" ON "sales_channel_write_request_targets"("sales_channel_write_request_id");

-- CreateIndex
CREATE INDEX "idx_sales_channel_write_targets_allocation_id" ON "sales_channel_write_request_targets"("allocation_id");

-- CreateIndex
CREATE INDEX "idx_sales_channel_write_targets_pg_no" ON "sales_channel_write_request_targets"("pg_no");

-- CreateIndex
CREATE INDEX "idx_sales_channel_write_targets_lookup" ON "sales_channel_write_request_targets"("target_type", "target_external_id");

-- CreateIndex
CREATE INDEX "idx_sales_channel_write_targets_order_id" ON "sales_channel_write_request_targets"("external_order_id");

-- CreateIndex
CREATE INDEX "idx_sales_channel_write_targets_shipment_id" ON "sales_channel_write_request_targets"("external_shipment_id");

-- CreateIndex
CREATE INDEX "idx_sales_channel_write_targets_vendor_item_id" ON "sales_channel_write_request_targets"("external_vendor_item_id");

-- CreateIndex
CREATE INDEX "idx_sales_channel_write_targets_result_status" ON "sales_channel_write_request_targets"("external_result_status", "local_finalization_status");

-- CreateIndex
CREATE INDEX "idx_sales_channel_write_targets_inventory_verification_state" ON "sales_channel_write_request_targets"("inventory_verification_state_id");

-- CreateIndex
CREATE INDEX "idx_sales_channel_write_targets_package_group" ON "sales_channel_write_request_targets"("package_group_id");

-- CreateIndex
CREATE INDEX "idx_sales_channel_write_targets_carrier_shipment" ON "sales_channel_write_request_targets"("carrier_shipment_id");

-- CreateIndex
CREATE INDEX "idx_sales_channel_write_targets_supply_event_id" ON "sales_channel_write_request_targets"("supply_consumption_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_sales_channel_write_targets_request_position" ON "sales_channel_write_request_targets"("sales_channel_write_request_id", "target_position");

-- CreateIndex
CREATE INDEX "idx_sales_channel_write_attempts_status" ON "sales_channel_write_request_attempts"("attempt_status");

-- CreateIndex
CREATE INDEX "idx_sales_channel_write_attempts_type_started" ON "sales_channel_write_request_attempts"("attempt_type", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_sales_channel_write_attempt_request_no" ON "sales_channel_write_request_attempts"("sales_channel_write_request_id", "attempt_no");

-- CreateIndex
CREATE UNIQUE INDEX "uq_sales_channel_write_attempts_integration_command" ON "sales_channel_write_request_attempts"("integration_command_id");

-- CreateIndex
CREATE INDEX "idx_sales_channel_write_controls_paused" ON "sales_channel_write_controls"("is_paused");

-- CreateIndex
CREATE INDEX "idx_sales_channel_write_controls_request_type" ON "sales_channel_write_controls"("request_type");

-- CreateIndex
CREATE UNIQUE INDEX "uq_sales_channel_write_controls_channel_endpoint" ON "sales_channel_write_controls"("channel", "endpoint_key");

-- CreateIndex
CREATE INDEX "idx_coupang_api_call_log_channel_api" ON "coupang_api_call_log"("channel", "api_name");

-- CreateIndex
CREATE INDEX "idx_coupang_api_call_log_endpoint_path" ON "coupang_api_call_log"("endpoint_path");

-- CreateIndex
CREATE INDEX "idx_coupang_api_call_log_status_filter" ON "coupang_api_call_log"("status_filter");

-- CreateIndex
CREATE INDEX "idx_coupang_api_call_log_order_id" ON "coupang_api_call_log"("external_order_id");

-- CreateIndex
CREATE INDEX "idx_coupang_api_call_log_vendor_item_id" ON "coupang_api_call_log"("external_vendor_item_id");

-- CreateIndex
CREATE INDEX "idx_coupang_api_call_log_response_hash" ON "coupang_api_call_log"("response_hash");

-- CreateIndex
CREATE INDEX "idx_coupang_api_call_log_processed_status" ON "coupang_api_call_log"("processed_status");

-- CreateIndex
CREATE INDEX "idx_coupang_api_call_log_received_at" ON "coupang_api_call_log"("received_at");

-- CreateIndex
CREATE INDEX "idx_coupang_api_call_log_worker_job_id" ON "coupang_api_call_log"("worker_job_id");

-- CreateIndex
CREATE INDEX "idx_coupang_api_call_log_period" ON "coupang_api_call_log"("period_from", "period_to");

-- CreateIndex
CREATE INDEX "idx_coupang_api_call_log_page_token_hash" ON "coupang_api_call_log"("page_token_hash");

-- CreateIndex
CREATE INDEX "idx_coupang_raw_change_event_source" ON "coupang_raw_change_event"("source_table", "source_pk");

-- CreateIndex
CREATE INDEX "idx_coupang_raw_change_event_type" ON "coupang_raw_change_event"("event_type");

-- CreateIndex
CREATE INDEX "idx_coupang_raw_change_event_status" ON "coupang_raw_change_event"("process_status");

-- CreateIndex
CREATE INDEX "idx_coupang_raw_change_event_order_id" ON "coupang_raw_change_event"("external_order_id");

-- CreateIndex
CREATE INDEX "idx_coupang_raw_change_event_shipment_id" ON "coupang_raw_change_event"("external_shipment_id");

-- CreateIndex
CREATE INDEX "idx_coupang_raw_change_event_receipt_id" ON "coupang_raw_change_event"("external_receipt_id");

-- CreateIndex
CREATE INDEX "idx_coupang_raw_change_event_exchange_id" ON "coupang_raw_change_event"("external_exchange_id");

-- CreateIndex
CREATE INDEX "idx_coupang_raw_change_event_type_detected" ON "coupang_raw_change_event"("event_type", "detected_at");

-- CreateIndex
CREATE INDEX "idx_coupang_raw_change_event_api_call_id" ON "coupang_raw_change_event"("api_call_log_id");

-- CreateIndex
CREATE INDEX "idx_coupang_raw_change_event_detected_at" ON "coupang_raw_change_event"("detected_at");

-- CreateIndex
CREATE INDEX "idx_coupang_raw_change_event_worker_job_id" ON "coupang_raw_change_event"("worker_job_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_coupang_raw_change_event_source_change" ON "coupang_raw_change_event"("source_table", "source_pk", "event_type", "change_hash");

-- CreateIndex
CREATE INDEX "idx_coupang_raw_change_event_field_event_id" ON "coupang_raw_change_event_field"("raw_change_event_id");

-- CreateIndex
CREATE INDEX "idx_coupang_raw_change_event_field_name" ON "coupang_raw_change_event_field"("field_name");

-- CreateIndex
CREATE INDEX "idx_coupang_raw_change_event_field_name_after" ON "coupang_raw_change_event_field"("field_name", "after_value");

-- CreateIndex
CREATE UNIQUE INDEX "uq_coupang_raw_change_event_field" ON "coupang_raw_change_event_field"("raw_change_event_id", "field_name");

-- CreateIndex
CREATE UNIQUE INDEX "uq_shipment_address_change_work_1" ON "shipment_address_change_work"("raw_change_event_id");

-- CreateIndex
CREATE INDEX "idx_shipment_address_change_work_status" ON "shipment_address_change_work"("change_status");

-- CreateIndex
CREATE INDEX "idx_shipment_address_change_work_stage" ON "shipment_address_change_work"("shipment_stage_at_detection");

-- CreateIndex
CREATE INDEX "idx_shipment_address_change_work_order_id" ON "shipment_address_change_work"("external_order_id");

-- CreateIndex
CREATE INDEX "idx_shipment_address_change_work_shipment_id" ON "shipment_address_change_work"("external_shipment_id");

-- CreateIndex
CREATE INDEX "idx_shipment_address_change_work_allocation_id" ON "shipment_address_change_work"("allocation_id");

-- CreateIndex
CREATE INDEX "idx_shipment_address_change_work_pg_no" ON "shipment_address_change_work"("pg_no");

-- CreateIndex
CREATE INDEX "idx_shipment_address_change_work_package_group" ON "shipment_address_change_work"("package_group_id");

-- CreateIndex
CREATE INDEX "idx_shipment_address_change_work_carrier_shipment" ON "shipment_address_change_work"("carrier_shipment_id_at_detection");

-- CreateIndex
CREATE INDEX "idx_shipment_address_change_work_detected_at" ON "shipment_address_change_work"("detected_at");

-- CreateIndex
CREATE INDEX "idx_shipment_address_change_work_api_call_id" ON "shipment_address_change_work"("api_call_log_id");

-- CreateIndex
CREATE INDEX "idx_shipment_address_change_work_user_id" ON "shipment_address_change_work"("processed_by_user_id");

-- CreateIndex
CREATE INDEX "idx_shipment_address_change_work_field_work_id" ON "shipment_address_change_work_field"("shipment_address_change_work_id");

-- CreateIndex
CREATE INDEX "idx_shipment_address_change_work_field_name" ON "shipment_address_change_work_field"("field_name");

-- CreateIndex
CREATE UNIQUE INDEX "uq_shipment_address_change_work_field" ON "shipment_address_change_work_field"("shipment_address_change_work_id", "field_name");

-- CreateIndex
CREATE INDEX "idx_channel_sync_cursors_last_success_at" ON "channel_sync_cursors"("last_success_at");

-- CreateIndex
CREATE INDEX "idx_channel_sync_cursors_last_failure_at" ON "channel_sync_cursors"("last_failure_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_channel_sync_cursors_1" ON "channel_sync_cursors"("channel", "resource", "status_filter");

-- CreateIndex
CREATE INDEX "idx_channel_credentials_channel_status" ON "channel_credentials"("channel", "credential_status");

-- CreateIndex
CREATE INDEX "idx_channel_credentials_provider_type" ON "channel_credentials"("provider_type");

-- CreateIndex
CREATE INDEX "idx_channel_credentials_key_fingerprint" ON "channel_credentials"("key_fingerprint");

-- CreateIndex
CREATE INDEX "idx_channel_credentials_expires_at" ON "channel_credentials"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_channel_credentials_channel_provider_alias" ON "channel_credentials"("channel", "provider_type", "key_alias");

-- CreateIndex
CREATE INDEX "idx_channel_credential_events_channel_time" ON "channel_credential_events"("channel", "occurred_at");

-- CreateIndex
CREATE INDEX "idx_channel_credential_events_credential_id" ON "channel_credential_events"("channel_credential_id");

-- CreateIndex
CREATE INDEX "idx_channel_credential_events_event_type" ON "channel_credential_events"("event_type");

-- CreateIndex
CREATE INDEX "idx_channel_credential_events_key_fingerprint" ON "channel_credential_events"("key_fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "uq_supplies_1" ON "supplies"("supply_code");

-- CreateIndex
CREATE INDEX "idx_supplies_category_active" ON "supplies"("category", "is_active");

-- CreateIndex
CREATE INDEX "idx_supplies_name" ON "supplies"("supply_name");

-- CreateIndex
CREATE INDEX "idx_supplies_updated_by_user_id" ON "supplies"("updated_by_user_id");

-- CreateIndex
CREATE INDEX "idx_inventory_audit_sessions_base_date" ON "inventory_audit_sessions"("audit_base_date");

-- CreateIndex
CREATE INDEX "idx_inventory_audit_sessions_period_to" ON "inventory_audit_sessions"("audit_period_to");

-- CreateIndex
CREATE INDEX "idx_inventory_audit_sessions_user_id" ON "inventory_audit_sessions"("created_by_user_id");

-- CreateIndex
CREATE INDEX "idx_inventory_audit_location_changes_pg_no" ON "inventory_audit_location_changes"("pg_no");

-- CreateIndex
CREATE INDEX "idx_inventory_audit_location_changes_new_location" ON "inventory_audit_location_changes"("new_location");

-- CreateIndex
CREATE UNIQUE INDEX "uq_inventory_audit_location_changes_session_pg" ON "inventory_audit_location_changes"("inventory_audit_session_id", "pg_no");

-- CreateIndex
CREATE UNIQUE INDEX "uq_supply_inventory_1" ON "supply_inventory"("supply_id");

-- CreateIndex
CREATE INDEX "idx_supply_inventory_supply_id" ON "supply_inventory"("supply_id");

-- CreateIndex
CREATE INDEX "idx_supply_inventory_location" ON "supply_inventory"("inventory_location");

-- CreateIndex
CREATE UNIQUE INDEX "uq_supply_stock_movements_idempotency_key" ON "supply_stock_movements"("idempotency_key");

-- CreateIndex
CREATE INDEX "idx_supply_stock_movements_supply_created" ON "supply_stock_movements"("supply_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_supply_stock_movements_type" ON "supply_stock_movements"("movement_type");

-- CreateIndex
CREATE INDEX "idx_supply_stock_movements_user_id" ON "supply_stock_movements"("created_by_user_id");

-- CreateIndex
CREATE INDEX "idx_supply_stock_movements_source" ON "supply_stock_movements"("source_type", "source_id");

-- CreateIndex
CREATE INDEX "idx_supply_stock_movements_allocation_id" ON "supply_stock_movements"("allocation_id");

-- CreateIndex
CREATE INDEX "idx_supply_stock_movements_return_allocation_id" ON "supply_stock_movements"("coupang_return_allocation_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_supply_stock_movements_reversal_event_id" ON "supply_stock_movements"("reversal_of_consumption_event_id");

-- CreateIndex
CREATE INDEX "idx_supply_consumption_rules_supply_active" ON "supply_consumption_rules"("supply_id", "is_active");

-- CreateIndex
CREATE INDEX "idx_supply_consumption_rules_trigger_active" ON "supply_consumption_rules"("trigger_type", "is_active");

-- CreateIndex
CREATE INDEX "idx_supply_consumption_rules_user_id" ON "supply_consumption_rules"("updated_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_supply_consumption_events_movement_id" ON "supply_consumption_events"("stock_movement_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_supply_consumption_events_idempotency_key" ON "supply_consumption_events"("idempotency_key");

-- CreateIndex
CREATE INDEX "idx_supply_consumption_events_supply_consumed" ON "supply_consumption_events"("supply_id", "consumed_at");

-- CreateIndex
CREATE INDEX "idx_supply_consumption_events_trigger_consumed" ON "supply_consumption_events"("trigger_type", "consumed_at");

-- CreateIndex
CREATE INDEX "idx_supply_consumption_events_audit_session_id" ON "supply_consumption_events"("inventory_audit_session_id");

-- CreateIndex
CREATE INDEX "idx_supply_consumption_events_pg_no" ON "supply_consumption_events"("pg_no");

-- CreateIndex
CREATE INDEX "idx_supply_consumption_events_allocation_id" ON "supply_consumption_events"("allocation_id");

-- CreateIndex
CREATE INDEX "idx_supply_consumption_events_pg_stage_claimed" ON "supply_consumption_events"("pg_no", "consumption_stage", "claimed_at");

-- CreateIndex
CREATE INDEX "idx_supply_forecast_supply_date" ON "supply_forecast_snapshots"("supply_id", "forecast_date");

-- CreateIndex
CREATE INDEX "idx_supply_forecast_date" ON "supply_forecast_snapshots"("forecast_date");

-- CreateIndex
CREATE INDEX "idx_supply_forecast_recommended_qty" ON "supply_forecast_snapshots"("recommended_purchase_quantity");

-- CreateIndex
CREATE INDEX "idx_supply_forecast_user_id" ON "supply_forecast_snapshots"("created_by_user_id");

-- CreateIndex
CREATE INDEX "idx_supply_forecast_calculation_field_forecast_id" ON "supply_forecast_calculation_fields"("forecast_id");

-- CreateIndex
CREATE INDEX "idx_supply_forecast_calculation_field_name" ON "supply_forecast_calculation_fields"("field_name");

-- CreateIndex
CREATE UNIQUE INDEX "uq_supply_forecast_calculation_field" ON "supply_forecast_calculation_fields"("forecast_id", "field_name");

-- CreateIndex
CREATE INDEX "idx_supply_reorder_supply_status" ON "supply_reorder_requests"("supply_id", "request_status");

-- CreateIndex
CREATE INDEX "idx_supply_reorder_forecast_id" ON "supply_reorder_requests"("forecast_id");

-- CreateIndex
CREATE INDEX "idx_supply_reorder_status" ON "supply_reorder_requests"("request_status");

-- CreateIndex
CREATE INDEX "idx_supply_reorder_created_by_user_id" ON "supply_reorder_requests"("created_by_user_id");

-- CreateIndex
CREATE INDEX "idx_supply_reorder_approved_by_user_id" ON "supply_reorder_requests"("approved_by_user_id");

-- CreateIndex
CREATE INDEX "idx_supply_reorder_status_updated_id" ON "supply_reorder_requests"("request_status", "updated_at", "reorder_request_id");

-- CreateIndex
CREATE INDEX "idx_carrier_shipments_channel_order" ON "carrier_shipments"("channel", "external_order_id");

-- CreateIndex
CREATE INDEX "idx_carrier_shipments_external_shipment" ON "carrier_shipments"("external_shipment_id");

-- CreateIndex
CREATE INDEX "idx_carrier_shipments_allocation" ON "carrier_shipments"("allocation_id");

-- CreateIndex
CREATE INDEX "idx_carrier_shipments_pg_no" ON "carrier_shipments"("pg_no");

-- CreateIndex
CREATE INDEX "idx_carrier_shipments_package_group" ON "carrier_shipments"("package_group_id");

-- CreateIndex
CREATE INDEX "idx_carrier_shipments_replaces" ON "carrier_shipments"("replaces_carrier_shipment_id");

-- CreateIndex
CREATE INDEX "idx_carrier_shipments_invoice_status" ON "carrier_shipments"("invoice_status");

-- CreateIndex
CREATE INDEX "idx_carrier_shipments_status" ON "carrier_shipments"("shipment_status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_carrier_shipments_carrier_tracking" ON "carrier_shipments"("carrier_code", "tracking_number");

-- CreateIndex
CREATE UNIQUE INDEX "uq_carrier_shipments_package_group_revision" ON "carrier_shipments"("package_group_id", "revision_no");

-- CreateIndex
CREATE INDEX "idx_carrier_tracking_events_shipment_scan" ON "carrier_tracking_events"("carrier_shipment_id", "scan_date", "scan_time");

-- CreateIndex
CREATE INDEX "idx_carrier_tracking_events_status" ON "carrier_tracking_events"("status_name");

-- CreateIndex
CREATE UNIQUE INDEX "uq_carrier_tracking_events_shipment_fingerprint" ON "carrier_tracking_events"("carrier_shipment_id", "event_fingerprint");

-- CreateIndex
CREATE INDEX "idx_carrier_return_requests_shipment" ON "carrier_return_requests"("carrier_shipment_id");

-- CreateIndex
CREATE INDEX "idx_carrier_return_requests_order" ON "carrier_return_requests"("external_order_id");

-- CreateIndex
CREATE INDEX "idx_carrier_return_requests_original_tracking" ON "carrier_return_requests"("original_tracking_number");

-- CreateIndex
CREATE INDEX "idx_carrier_return_requests_return_tracking" ON "carrier_return_requests"("return_tracking_number");

-- CreateIndex
CREATE INDEX "idx_carrier_return_requests_reservation_status" ON "carrier_return_requests"("reservation_status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_carrier_return_requests_carrier_take_no" ON "carrier_return_requests"("carrier_code", "take_no");

-- CreateIndex
CREATE INDEX "idx_carrier_api_call_logs_carrier_api" ON "carrier_api_call_logs"("carrier_code", "api_name");

-- CreateIndex
CREATE INDEX "idx_carrier_api_call_logs_shipment" ON "carrier_api_call_logs"("carrier_shipment_id");

-- CreateIndex
CREATE INDEX "idx_carrier_api_call_logs_endpoint" ON "carrier_api_call_logs"("endpoint_path");

-- CreateIndex
CREATE INDEX "idx_carrier_api_call_logs_order" ON "carrier_api_call_logs"("external_order_id");

-- CreateIndex
CREATE INDEX "idx_carrier_api_call_logs_tracking" ON "carrier_api_call_logs"("tracking_number");

-- CreateIndex
CREATE INDEX "idx_carrier_api_call_logs_take_no" ON "carrier_api_call_logs"("take_no");

-- CreateIndex
CREATE INDEX "idx_carrier_api_call_logs_worker_job" ON "carrier_api_call_logs"("worker_job_id");

-- CreateIndex
CREATE INDEX "idx_carrier_api_call_logs_processed_status" ON "carrier_api_call_logs"("processed_status");

-- CreateIndex
CREATE INDEX "idx_carrier_api_call_logs_started" ON "carrier_api_call_logs"("started_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_carrier_invoice_issue_batches_request_key" ON "carrier_invoice_issue_batches"("request_key");

-- CreateIndex
CREATE UNIQUE INDEX "uq_carrier_invoice_issue_batches_label_request_key" ON "carrier_invoice_issue_batches"("label_active_request_key");

-- CreateIndex
CREATE INDEX "idx_carrier_invoice_issue_batches_print_batch" ON "carrier_invoice_issue_batches"("shipment_list_print_batch_id");

-- CreateIndex
CREATE INDEX "idx_carrier_invoice_issue_batches_carrier_status" ON "carrier_invoice_issue_batches"("carrier_code", "batch_status");

-- CreateIndex
CREATE INDEX "idx_carrier_invoice_issue_batches_status_started" ON "carrier_invoice_issue_batches"("batch_status", "started_at");

-- CreateIndex
CREATE INDEX "idx_carrier_invoice_issue_batches_label_status" ON "carrier_invoice_issue_batches"("label_print_status");

-- CreateIndex
CREATE INDEX "idx_carrier_invoice_issue_batches_api_call" ON "carrier_invoice_issue_batches"("api_call_log_id");

-- CreateIndex
CREATE INDEX "idx_carrier_invoice_issue_batches_created_at" ON "carrier_invoice_issue_batches"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_carrier_invoice_replacement_works_request_key" ON "carrier_invoice_replacement_works"("request_key");

-- CreateIndex
CREATE UNIQUE INDEX "uq_carrier_invoice_replacement_works_address_change" ON "carrier_invoice_replacement_works"("shipment_address_change_work_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_carrier_invoice_replacement_works_candidate" ON "carrier_invoice_replacement_works"("candidate_carrier_shipment_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_carrier_invoice_replacement_works_issue_batch" ON "carrier_invoice_replacement_works"("carrier_invoice_issue_batch_id");

-- CreateIndex
CREATE INDEX "idx_carrier_invoice_replacement_works_group" ON "carrier_invoice_replacement_works"("package_group_id");

-- CreateIndex
CREATE INDEX "idx_carrier_invoice_replacement_works_status_updated" ON "carrier_invoice_replacement_works"("work_status", "updated_at");

-- CreateIndex
CREATE INDEX "idx_carrier_invoice_replacement_works_stage" ON "carrier_invoice_replacement_works"("current_stage");

-- CreateIndex
CREATE INDEX "idx_carrier_invoice_replacement_works_old_shipment" ON "carrier_invoice_replacement_works"("old_carrier_shipment_id");

-- CreateIndex
CREATE INDEX "idx_carrier_invoice_replacement_works_requested_by" ON "carrier_invoice_replacement_works"("requested_by_user_id");

-- CreateIndex
CREATE INDEX "idx_carrier_invoice_replacement_works_created" ON "carrier_invoice_replacement_works"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_carrier_invoice_issue_items_carrier_shipment" ON "carrier_invoice_issue_items"("carrier_shipment_id");

-- CreateIndex
CREATE INDEX "idx_carrier_invoice_issue_items_package_group" ON "carrier_invoice_issue_items"("package_group_id");

-- CreateIndex
CREATE INDEX "idx_carrier_invoice_issue_items_status" ON "carrier_invoice_issue_items"("item_status");

-- CreateIndex
CREATE INDEX "idx_carrier_invoice_issue_items_label_status" ON "carrier_invoice_issue_items"("label_print_status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_carrier_invoice_issue_items_batch_group" ON "carrier_invoice_issue_items"("carrier_invoice_issue_batch_id", "package_group_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_carrier_invoice_issue_items_batch_sequence" ON "carrier_invoice_issue_items"("carrier_invoice_issue_batch_id", "issue_sequence");

-- CreateIndex
CREATE UNIQUE INDEX "uq_carrier_shipment_registration_works_shipment" ON "carrier_shipment_registration_works"("carrier_shipment_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_carrier_shipment_registration_works_issue_item" ON "carrier_shipment_registration_works"("carrier_invoice_issue_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_carrier_shipment_registration_works_fix_take_no" ON "carrier_shipment_registration_works"("fix_take_no");

-- CreateIndex
CREATE INDEX "idx_carrier_registration_works_status_due" ON "carrier_shipment_registration_works"("work_status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "idx_carrier_registration_works_package_group" ON "carrier_shipment_registration_works"("package_group_id");

-- CreateIndex
CREATE INDEX "idx_carrier_registration_works_worker" ON "carrier_shipment_registration_works"("worker_job_id");

-- CreateIndex
CREATE INDEX "idx_carrier_registration_works_classification_call" ON "carrier_shipment_registration_works"("classification_api_call_log_id");

-- CreateIndex
CREATE INDEX "idx_carrier_registration_works_registration_call" ON "carrier_shipment_registration_works"("registration_api_call_log_id");

-- CreateIndex
CREATE INDEX "idx_carrier_registration_works_reconciliation" ON "carrier_shipment_registration_works"("reconciliation_work_id");

-- CreateIndex
CREATE INDEX "idx_carrier_reconciliation_status" ON "carrier_reconciliation_works"("reconciliation_status");

-- CreateIndex
CREATE INDEX "idx_carrier_reconciliation_api_call" ON "carrier_reconciliation_works"("api_call_log_id");

-- CreateIndex
CREATE INDEX "idx_carrier_reconciliation_updated" ON "carrier_reconciliation_works"("updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_carrier_reconciliation_lookup" ON "carrier_reconciliation_works"("carrier_code", "operation_type", "lookup_key_type", "lookup_key_value");

-- CreateIndex
CREATE INDEX "idx_domain_operation_keys_aggregate" ON "domain_operation_keys"("aggregate_type", "aggregate_id");

-- CreateIndex
CREATE INDEX "idx_domain_operation_keys_created_at" ON "domain_operation_keys"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_domain_operation_keys_scope_key" ON "domain_operation_keys"("scope", "operation_key");

-- CreateIndex
CREATE UNIQUE INDEX "uq_integration_commands_operation_key" ON "integration_commands"("operation_key");

-- CreateIndex
CREATE INDEX "idx_integration_commands_provider_status" ON "integration_commands"("provider", "command_status", "created_at");

-- CreateIndex
CREATE INDEX "idx_integration_commands_claim" ON "integration_commands"("command_status", "locked_until");

-- CreateIndex
CREATE INDEX "idx_integration_command_attempts_status" ON "integration_command_attempts"("dispatch_status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_integration_command_attempts_command_no" ON "integration_command_attempts"("integration_command_id", "attempt_no");

-- CreateIndex
CREATE INDEX "idx_integration_evidences_provider_type" ON "integration_evidences"("provider", "evidence_type", "received_at");

-- CreateIndex
CREATE INDEX "idx_integration_evidences_command" ON "integration_evidences"("integration_command_id");

-- CreateIndex
CREATE INDEX "idx_integration_projection_jobs_claim" ON "integration_projection_jobs"("projection_status", "locked_until");

-- CreateIndex
CREATE UNIQUE INDEX "uq_integration_projection_jobs_evidence_handler" ON "integration_projection_jobs"("integration_evidence_id", "handler_key");

-- CreateIndex
CREATE INDEX "idx_domain_audit_events_aggregate" ON "domain_audit_events"("aggregate_type", "aggregate_id", "occurred_at");

-- CreateIndex
CREATE INDEX "idx_domain_audit_events_actor" ON "domain_audit_events"("actor_user_id", "occurred_at");

-- CreateIndex
CREATE INDEX "idx_domain_audit_events_operation_key" ON "domain_audit_events"("operation_key");

-- CreateIndex
CREATE INDEX "idx_domain_audit_event_changes_field" ON "domain_audit_event_changes"("field_path");

-- CreateIndex
CREATE UNIQUE INDEX "uq_domain_audit_event_changes_field" ON "domain_audit_event_changes"("domain_audit_event_id", "field_path");

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_inventory_sku_id_fkey" FOREIGN KEY ("inventory_sku_id") REFERENCES "inventory_skus"("inventory_sku_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbounds" ADD CONSTRAINT "inbounds_pg_no_fkey" FOREIGN KEY ("pg_no") REFERENCES "devices"("pg_no") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbounds" ADD CONSTRAINT "inbounds_inbound_batch_id_fkey" FOREIGN KEY ("inbound_batch_id") REFERENCES "inbound_batches"("inbound_batch_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbounds" ADD CONSTRAINT "inbounds_purchase_price_updated_by_user_id_fkey" FOREIGN KEY ("purchase_price_updated_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbounds" ADD CONSTRAINT "inbounds_purchase_price_reference_rate_id_fkey" FOREIGN KEY ("purchase_price_reference_rate_id") REFERENCES "purchase_price_rates"("purchase_price_rate_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_batches" ADD CONSTRAINT "inbound_batches_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_pg_no_fkey" FOREIGN KEY ("pg_no") REFERENCES "devices"("pg_no") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_inbound_id_fkey" FOREIGN KEY ("inbound_id") REFERENCES "inbounds"("inbound_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_pg_no_fkey" FOREIGN KEY ("pg_no") REFERENCES "devices"("pg_no") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_quantity_balances" ADD CONSTRAINT "inventory_quantity_balances_inventory_sku_id_fkey" FOREIGN KEY ("inventory_sku_id") REFERENCES "inventory_skus"("inventory_sku_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_quantity_movements" ADD CONSTRAINT "inventory_quantity_movements_inventory_quantity_balance_id_fkey" FOREIGN KEY ("inventory_quantity_balance_id") REFERENCES "inventory_quantity_balances"("inventory_quantity_balance_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_quantity_movements" ADD CONSTRAINT "inventory_quantity_movements_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_quantity_movements" ADD CONSTRAINT "inventory_quantity_movements_worker_job_id_fkey" FOREIGN KEY ("worker_job_id") REFERENCES "server_worker_jobs"("worker_job_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_pg_no_fkey" FOREIGN KEY ("pg_no") REFERENCES "devices"("pg_no") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("order_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mobile_registered_devices" ADD CONSTRAINT "mobile_registered_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mobile_registered_devices" ADD CONSTRAINT "mobile_registered_devices_registered_by_user_id_fkey" FOREIGN KEY ("registered_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mobile_registered_devices" ADD CONSTRAINT "mobile_registered_devices_revoked_by_user_id_fkey" FOREIGN KEY ("revoked_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_totp_credentials" ADD CONSTRAINT "user_totp_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_totp_recovery_codes" ADD CONSTRAINT "user_totp_recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_profiles" ADD CONSTRAINT "employee_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_shortcut_bindings" ADD CONSTRAINT "user_shortcut_bindings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_activity_logs" ADD CONSTRAINT "employee_activity_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_integration_settings" ADD CONSTRAINT "carrier_integration_settings_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_activity_log_changes" ADD CONSTRAINT "employee_activity_log_changes_activity_log_id_fkey" FOREIGN KEY ("activity_log_id") REFERENCES "employee_activity_logs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_job_logs" ADD CONSTRAINT "server_job_logs_triggered_by_user_id_fkey" FOREIGN KEY ("triggered_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_job_log_fields" ADD CONSTRAINT "server_job_log_fields_server_job_log_id_fkey" FOREIGN KEY ("server_job_log_id") REFERENCES "server_job_logs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_http_trace_observations" ADD CONSTRAINT "client_http_trace_observations_reported_by_user_id_fkey" FOREIGN KEY ("reported_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_worker_jobs" ADD CONSTRAINT "server_worker_jobs_triggered_by_user_id_fkey" FOREIGN KEY ("triggered_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "statistics_snapshot_batches" ADD CONSTRAINT "statistics_snapshot_batches_worker_job_id_fkey" FOREIGN KEY ("worker_job_id") REFERENCES "server_worker_jobs"("worker_job_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "statistics_snapshot_items" ADD CONSTRAINT "statistics_snapshot_items_snapshot_batch_id_fkey" FOREIGN KEY ("snapshot_batch_id") REFERENCES "statistics_snapshot_batches"("snapshot_batch_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_price_rates" ADD CONSTRAINT "purchase_price_rates_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_price_rates" ADD CONSTRAINT "purchase_price_rates_model_option_id_fkey" FOREIGN KEY ("model_option_id") REFERENCES "product_criteria_options"("option_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_price_rates" ADD CONSTRAINT "purchase_price_rates_storage_option_id_fkey" FOREIGN KEY ("storage_option_id") REFERENCES "product_criteria_options"("option_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_price_rates" ADD CONSTRAINT "purchase_price_rates_appearance_grade_option_id_fkey" FOREIGN KEY ("appearance_grade_option_id") REFERENCES "product_criteria_options"("option_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_criteria_options" ADD CONSTRAINT "product_criteria_options_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_criteria_option_links" ADD CONSTRAINT "product_criteria_option_links_parent_option_id_fkey" FOREIGN KEY ("parent_option_id") REFERENCES "product_criteria_options"("option_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_criteria_option_links" ADD CONSTRAINT "product_criteria_option_links_child_option_id_fkey" FOREIGN KEY ("child_option_id") REFERENCES "product_criteria_options"("option_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_criteria_option_links" ADD CONSTRAINT "product_criteria_option_links_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_skus" ADD CONSTRAINT "inventory_skus_model_option_id_fkey" FOREIGN KEY ("model_option_id") REFERENCES "product_criteria_options"("option_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_skus" ADD CONSTRAINT "inventory_skus_storage_option_id_fkey" FOREIGN KEY ("storage_option_id") REFERENCES "product_criteria_options"("option_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_skus" ADD CONSTRAINT "inventory_skus_color_option_id_fkey" FOREIGN KEY ("color_option_id") REFERENCES "product_criteria_options"("option_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_skus" ADD CONSTRAINT "inventory_skus_sale_grade_option_id_fkey" FOREIGN KEY ("sale_grade_option_id") REFERENCES "product_criteria_options"("option_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_skus" ADD CONSTRAINT "inventory_skus_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_skus" ADD CONSTRAINT "inventory_skus_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_camera_check_rules" ADD CONSTRAINT "product_camera_check_rules_model_option_id_fkey" FOREIGN KEY ("model_option_id") REFERENCES "product_criteria_options"("option_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_camera_check_rules" ADD CONSTRAINT "product_camera_check_rules_camera_lens_option_id_fkey" FOREIGN KEY ("camera_lens_option_id") REFERENCES "product_criteria_options"("option_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_camera_check_rules" ADD CONSTRAINT "product_camera_check_rules_focus_rule_option_id_fkey" FOREIGN KEY ("focus_rule_option_id") REFERENCES "product_criteria_options"("option_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_camera_check_rules" ADD CONSTRAINT "product_camera_check_rules_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_sensitive_auth_grants" ADD CONSTRAINT "user_sensitive_auth_grants_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "user_sessions"("session_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_sensitive_auth_grants" ADD CONSTRAINT "user_sensitive_auth_grants_totp_credential_id_fkey" FOREIGN KEY ("totp_credential_id") REFERENCES "user_totp_credentials"("credential_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_offers" ADD CONSTRAINT "sales_offers_model_option_id_fkey" FOREIGN KEY ("model_option_id") REFERENCES "product_criteria_options"("option_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_offers" ADD CONSTRAINT "sales_offers_storage_option_id_fkey" FOREIGN KEY ("storage_option_id") REFERENCES "product_criteria_options"("option_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_offers" ADD CONSTRAINT "sales_offers_color_option_id_fkey" FOREIGN KEY ("color_option_id") REFERENCES "product_criteria_options"("option_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_offers" ADD CONSTRAINT "sales_offers_warranty_group_option_id_fkey" FOREIGN KEY ("warranty_group_option_id") REFERENCES "product_criteria_options"("option_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_offers" ADD CONSTRAINT "sales_offers_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_offers" ADD CONSTRAINT "sales_offers_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_channel_product_mappings" ADD CONSTRAINT "sales_channel_product_mappings_sales_offer_id_fkey" FOREIGN KEY ("sales_offer_id") REFERENCES "sales_offers"("sales_offer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_channel_product_mappings" ADD CONSTRAINT "sales_channel_product_mappings_mapped_by_user_id_fkey" FOREIGN KEY ("mapped_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_channel_inventory_verification_states" ADD CONSTRAINT "sales_channel_inventory_verification_states_mapping_id_fkey" FOREIGN KEY ("mapping_id") REFERENCES "sales_channel_product_mappings"("mapping_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_channel_inventory_verification_states" ADD CONSTRAINT "sales_channel_inventory_verification_states_sales_offer_id_fkey" FOREIGN KEY ("sales_offer_id") REFERENCES "sales_offers"("sales_offer_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_channel_inventory_verification_states" ADD CONSTRAINT "sales_channel_inventory_verification_states_last_api_call__fkey" FOREIGN KEY ("last_api_call_log_id") REFERENCES "coupang_api_call_log"("coupang_api_call_log_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_channel_inventory_verification_states" ADD CONSTRAINT "sales_channel_inventory_verification_states_last_worker_jo_fkey" FOREIGN KEY ("last_worker_job_id") REFERENCES "server_worker_jobs"("worker_job_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_matching_policies" ADD CONSTRAINT "order_matching_policies_sales_offer_id_fkey" FOREIGN KEY ("sales_offer_id") REFERENCES "sales_offers"("sales_offer_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_matching_priority_tiers" ADD CONSTRAINT "order_matching_priority_tiers_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "order_matching_policies"("policy_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_matching_priority_tier_sale_grades" ADD CONSTRAINT "order_matching_priority_tier_sale_grades_tier_id_fkey" FOREIGN KEY ("tier_id") REFERENCES "order_matching_priority_tiers"("tier_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_matching_priority_tier_sale_grades" ADD CONSTRAINT "order_matching_priority_tier_sale_grades_sale_grade_option_fkey" FOREIGN KEY ("sale_grade_option_id") REFERENCES "product_criteria_options"("option_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_matching_work_queue" ADD CONSTRAINT "order_matching_work_queue_sales_offer_id_fkey" FOREIGN KEY ("sales_offer_id") REFERENCES "sales_offers"("sales_offer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_channel_shipment_list_print_batches" ADD CONSTRAINT "sales_channel_shipment_list_print_batches_printed_by_user__fkey" FOREIGN KEY ("printed_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_channel_shipment_list_print_batch_items" ADD CONSTRAINT "sales_channel_shipment_list_print_batch_items_shipment_lis_fkey" FOREIGN KEY ("shipment_list_print_batch_id") REFERENCES "sales_channel_shipment_list_print_batches"("shipment_list_print_batch_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_channel_shipment_list_print_batch_items" ADD CONSTRAINT "sales_channel_shipment_list_print_batch_items_allocation_i_fkey" FOREIGN KEY ("allocation_id") REFERENCES "match_worker_allocation"("allocation_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_channel_shipment_list_print_batch_items" ADD CONSTRAINT "sales_channel_shipment_list_print_batch_items_package_grou_fkey" FOREIGN KEY ("package_group_id") REFERENCES "shipment_package_groups"("package_group_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupang_return_raw" ADD CONSTRAINT "coupang_return_raw_external_order_id_external_shipment_id_fkey" FOREIGN KEY ("external_order_id", "external_shipment_id") REFERENCES "coupang_order_raw"("external_order_id", "external_shipment_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupang_return_raw_item" ADD CONSTRAINT "coupang_return_raw_item_coupang_return_raw_id_fkey" FOREIGN KEY ("coupang_return_raw_id") REFERENCES "coupang_return_raw"("coupang_return_raw_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupang_return_allocation" ADD CONSTRAINT "coupang_return_allocation_coupang_return_raw_id_fkey" FOREIGN KEY ("coupang_return_raw_id") REFERENCES "coupang_return_raw"("coupang_return_raw_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupang_return_allocation" ADD CONSTRAINT "coupang_return_allocation_allocation_id_fkey" FOREIGN KEY ("allocation_id") REFERENCES "match_worker_allocation"("allocation_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupang_return_allocation" ADD CONSTRAINT "coupang_return_allocation_linked_by_user_id_fkey" FOREIGN KEY ("linked_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupang_exchange_shipment_scope" ADD CONSTRAINT "coupang_exchange_shipment_scope_coupang_exchange_raw_id_fkey" FOREIGN KEY ("coupang_exchange_raw_id") REFERENCES "coupang_exchange_raw"("coupang_exchange_raw_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupang_exchange_raw" ADD CONSTRAINT "coupang_exchange_raw_external_order_id_external_shipment_i_fkey" FOREIGN KEY ("external_order_id", "external_shipment_id") REFERENCES "coupang_order_raw"("external_order_id", "external_shipment_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_worker_allocation" ADD CONSTRAINT "match_worker_allocation_external_order_id_external_shipmen_fkey" FOREIGN KEY ("external_order_id", "external_shipment_id") REFERENCES "coupang_order_raw"("external_order_id", "external_shipment_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_worker_allocation" ADD CONSTRAINT "match_worker_allocation_pg_no_fkey" FOREIGN KEY ("pg_no") REFERENCES "devices"("pg_no") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_worker_allocation" ADD CONSTRAINT "match_worker_allocation_sales_offer_id_fkey" FOREIGN KEY ("sales_offer_id") REFERENCES "sales_offers"("sales_offer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_worker_allocation" ADD CONSTRAINT "match_worker_allocation_inventory_sku_id_fkey" FOREIGN KEY ("inventory_sku_id") REFERENCES "inventory_skus"("inventory_sku_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_worker_allocation" ADD CONSTRAINT "match_worker_allocation_worker_job_id_fkey" FOREIGN KEY ("worker_job_id") REFERENCES "server_worker_jobs"("worker_job_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_worker_allocation" ADD CONSTRAINT "match_worker_allocation_shipment_list_print_batch_id_fkey" FOREIGN KEY ("shipment_list_print_batch_id") REFERENCES "sales_channel_shipment_list_print_batches"("shipment_list_print_batch_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_package_groups" ADD CONSTRAINT "shipment_package_groups_split_from_group_id_fkey" FOREIGN KEY ("split_from_group_id") REFERENCES "shipment_package_groups"("package_group_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_package_groups" ADD CONSTRAINT "shipment_package_groups_current_carrier_shipment_id_fkey" FOREIGN KEY ("current_carrier_shipment_id") REFERENCES "carrier_shipments"("carrier_shipment_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_package_group_members" ADD CONSTRAINT "shipment_package_group_members_package_group_id_fkey" FOREIGN KEY ("package_group_id") REFERENCES "shipment_package_groups"("package_group_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_package_group_members" ADD CONSTRAINT "shipment_package_group_members_allocation_id_fkey" FOREIGN KEY ("allocation_id") REFERENCES "match_worker_allocation"("allocation_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_records" ADD CONSTRAINT "sales_records_allocation_id_fkey" FOREIGN KEY ("allocation_id") REFERENCES "match_worker_allocation"("allocation_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_records" ADD CONSTRAINT "sales_records_pg_no_fkey" FOREIGN KEY ("pg_no") REFERENCES "devices"("pg_no") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_records" ADD CONSTRAINT "sales_records_sales_offer_id_fkey" FOREIGN KEY ("sales_offer_id") REFERENCES "sales_offers"("sales_offer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_records" ADD CONSTRAINT "sales_records_inventory_sku_id_fkey" FOREIGN KEY ("inventory_sku_id") REFERENCES "inventory_skus"("inventory_sku_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_records" ADD CONSTRAINT "sales_records_purchase_inbound_id_fkey" FOREIGN KEY ("purchase_inbound_id") REFERENCES "inbounds"("inbound_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_channel_write_requests" ADD CONSTRAINT "sales_channel_write_requests_allocation_id_fkey" FOREIGN KEY ("allocation_id") REFERENCES "match_worker_allocation"("allocation_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_channel_write_requests" ADD CONSTRAINT "sales_channel_write_requests_pg_no_fkey" FOREIGN KEY ("pg_no") REFERENCES "devices"("pg_no") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_channel_write_requests" ADD CONSTRAINT "sales_channel_write_requests_worker_job_id_fkey" FOREIGN KEY ("worker_job_id") REFERENCES "server_worker_jobs"("worker_job_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_channel_write_requests" ADD CONSTRAINT "sales_channel_write_requests_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_channel_write_requests" ADD CONSTRAINT "sales_channel_write_requests_manual_verified_by_user_id_fkey" FOREIGN KEY ("manual_verified_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_channel_write_requests" ADD CONSTRAINT "sales_channel_write_requests_package_group_id_fkey" FOREIGN KEY ("package_group_id") REFERENCES "shipment_package_groups"("package_group_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_channel_write_requests" ADD CONSTRAINT "sales_channel_write_requests_carrier_shipment_id_fkey" FOREIGN KEY ("carrier_shipment_id") REFERENCES "carrier_shipments"("carrier_shipment_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_channel_write_requests" ADD CONSTRAINT "sales_channel_write_requests_active_review_attempt_id_fkey" FOREIGN KEY ("active_review_attempt_id") REFERENCES "sales_channel_write_request_attempts"("sales_channel_write_request_attempt_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_channel_write_request_targets" ADD CONSTRAINT "sales_channel_write_request_targets_sales_channel_write_re_fkey" FOREIGN KEY ("sales_channel_write_request_id") REFERENCES "sales_channel_write_requests"("sales_channel_write_request_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_channel_write_request_targets" ADD CONSTRAINT "sales_channel_write_request_targets_allocation_id_fkey" FOREIGN KEY ("allocation_id") REFERENCES "match_worker_allocation"("allocation_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_channel_write_request_targets" ADD CONSTRAINT "sales_channel_write_request_targets_pg_no_fkey" FOREIGN KEY ("pg_no") REFERENCES "devices"("pg_no") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_channel_write_request_targets" ADD CONSTRAINT "sales_channel_write_request_targets_supply_consumption_eve_fkey" FOREIGN KEY ("supply_consumption_event_id") REFERENCES "supply_consumption_events"("supply_consumption_event_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_channel_write_request_targets" ADD CONSTRAINT "sales_channel_write_request_targets_package_group_id_fkey" FOREIGN KEY ("package_group_id") REFERENCES "shipment_package_groups"("package_group_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_channel_write_request_targets" ADD CONSTRAINT "sales_channel_write_request_targets_carrier_shipment_id_fkey" FOREIGN KEY ("carrier_shipment_id") REFERENCES "carrier_shipments"("carrier_shipment_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_channel_write_request_attempts" ADD CONSTRAINT "sales_channel_write_request_attempts_sales_channel_write_r_fkey" FOREIGN KEY ("sales_channel_write_request_id") REFERENCES "sales_channel_write_requests"("sales_channel_write_request_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_channel_write_request_attempts" ADD CONSTRAINT "sales_channel_write_request_attempts_integration_command_id_fkey" FOREIGN KEY ("integration_command_id") REFERENCES "integration_commands"("integration_command_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_channel_write_controls" ADD CONSTRAINT "sales_channel_write_controls_paused_by_user_id_fkey" FOREIGN KEY ("paused_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_channel_write_controls" ADD CONSTRAINT "sales_channel_write_controls_resumed_by_user_id_fkey" FOREIGN KEY ("resumed_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupang_api_call_log" ADD CONSTRAINT "coupang_api_call_log_worker_job_id_fkey" FOREIGN KEY ("worker_job_id") REFERENCES "server_worker_jobs"("worker_job_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupang_raw_change_event" ADD CONSTRAINT "coupang_raw_change_event_external_order_id_external_shipme_fkey" FOREIGN KEY ("external_order_id", "external_shipment_id") REFERENCES "coupang_order_raw"("external_order_id", "external_shipment_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupang_raw_change_event" ADD CONSTRAINT "coupang_raw_change_event_api_call_log_id_fkey" FOREIGN KEY ("api_call_log_id") REFERENCES "coupang_api_call_log"("coupang_api_call_log_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupang_raw_change_event" ADD CONSTRAINT "coupang_raw_change_event_worker_job_id_fkey" FOREIGN KEY ("worker_job_id") REFERENCES "server_worker_jobs"("worker_job_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupang_raw_change_event_field" ADD CONSTRAINT "coupang_raw_change_event_field_raw_change_event_id_fkey" FOREIGN KEY ("raw_change_event_id") REFERENCES "coupang_raw_change_event"("coupang_raw_change_event_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_address_change_work" ADD CONSTRAINT "shipment_address_change_work_raw_change_event_id_fkey" FOREIGN KEY ("raw_change_event_id") REFERENCES "coupang_raw_change_event"("coupang_raw_change_event_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_address_change_work" ADD CONSTRAINT "shipment_address_change_work_api_call_log_id_fkey" FOREIGN KEY ("api_call_log_id") REFERENCES "coupang_api_call_log"("coupang_api_call_log_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_address_change_work" ADD CONSTRAINT "shipment_address_change_work_external_order_id_external_sh_fkey" FOREIGN KEY ("external_order_id", "external_shipment_id") REFERENCES "coupang_order_raw"("external_order_id", "external_shipment_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_address_change_work" ADD CONSTRAINT "shipment_address_change_work_allocation_id_fkey" FOREIGN KEY ("allocation_id") REFERENCES "match_worker_allocation"("allocation_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_address_change_work" ADD CONSTRAINT "shipment_address_change_work_pg_no_fkey" FOREIGN KEY ("pg_no") REFERENCES "devices"("pg_no") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_address_change_work" ADD CONSTRAINT "shipment_address_change_work_processed_by_user_id_fkey" FOREIGN KEY ("processed_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_address_change_work" ADD CONSTRAINT "shipment_address_change_work_package_group_id_fkey" FOREIGN KEY ("package_group_id") REFERENCES "shipment_package_groups"("package_group_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_address_change_work" ADD CONSTRAINT "shipment_address_change_work_carrier_shipment_id_at_detect_fkey" FOREIGN KEY ("carrier_shipment_id_at_detection") REFERENCES "carrier_shipments"("carrier_shipment_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_address_change_work_field" ADD CONSTRAINT "shipment_address_change_work_field_shipment_address_change_fkey" FOREIGN KEY ("shipment_address_change_work_id") REFERENCES "shipment_address_change_work"("shipment_address_change_work_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplies" ADD CONSTRAINT "supplies_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_audit_sessions" ADD CONSTRAINT "inventory_audit_sessions_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_audit_location_changes" ADD CONSTRAINT "inventory_audit_location_changes_inventory_audit_session_i_fkey" FOREIGN KEY ("inventory_audit_session_id") REFERENCES "inventory_audit_sessions"("inventory_audit_session_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_audit_location_changes" ADD CONSTRAINT "inventory_audit_location_changes_pg_no_fkey" FOREIGN KEY ("pg_no") REFERENCES "devices"("pg_no") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supply_inventory" ADD CONSTRAINT "supply_inventory_supply_id_fkey" FOREIGN KEY ("supply_id") REFERENCES "supplies"("supply_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supply_stock_movements" ADD CONSTRAINT "supply_stock_movements_supply_id_fkey" FOREIGN KEY ("supply_id") REFERENCES "supplies"("supply_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supply_stock_movements" ADD CONSTRAINT "supply_stock_movements_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supply_stock_movements" ADD CONSTRAINT "supply_stock_movements_allocation_id_fkey" FOREIGN KEY ("allocation_id") REFERENCES "match_worker_allocation"("allocation_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supply_stock_movements" ADD CONSTRAINT "supply_stock_movements_coupang_return_allocation_id_fkey" FOREIGN KEY ("coupang_return_allocation_id") REFERENCES "coupang_return_allocation"("coupang_return_allocation_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supply_stock_movements" ADD CONSTRAINT "supply_stock_movements_reversal_of_consumption_event_id_fkey" FOREIGN KEY ("reversal_of_consumption_event_id") REFERENCES "supply_consumption_events"("supply_consumption_event_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supply_consumption_rules" ADD CONSTRAINT "supply_consumption_rules_supply_id_fkey" FOREIGN KEY ("supply_id") REFERENCES "supplies"("supply_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supply_consumption_rules" ADD CONSTRAINT "supply_consumption_rules_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supply_consumption_events" ADD CONSTRAINT "supply_consumption_events_supply_id_fkey" FOREIGN KEY ("supply_id") REFERENCES "supplies"("supply_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supply_consumption_events" ADD CONSTRAINT "supply_consumption_events_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "supply_consumption_rules"("rule_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supply_consumption_events" ADD CONSTRAINT "supply_consumption_events_inventory_audit_session_id_fkey" FOREIGN KEY ("inventory_audit_session_id") REFERENCES "inventory_audit_sessions"("inventory_audit_session_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supply_consumption_events" ADD CONSTRAINT "supply_consumption_events_pg_no_fkey" FOREIGN KEY ("pg_no") REFERENCES "devices"("pg_no") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supply_consumption_events" ADD CONSTRAINT "supply_consumption_events_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supply_consumption_events" ADD CONSTRAINT "supply_consumption_events_allocation_id_fkey" FOREIGN KEY ("allocation_id") REFERENCES "match_worker_allocation"("allocation_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supply_consumption_events" ADD CONSTRAINT "supply_consumption_events_stock_movement_id_fkey" FOREIGN KEY ("stock_movement_id") REFERENCES "supply_stock_movements"("movement_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supply_forecast_snapshots" ADD CONSTRAINT "supply_forecast_snapshots_supply_id_fkey" FOREIGN KEY ("supply_id") REFERENCES "supplies"("supply_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supply_forecast_snapshots" ADD CONSTRAINT "supply_forecast_snapshots_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supply_forecast_calculation_fields" ADD CONSTRAINT "supply_forecast_calculation_fields_forecast_id_fkey" FOREIGN KEY ("forecast_id") REFERENCES "supply_forecast_snapshots"("forecast_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supply_reorder_requests" ADD CONSTRAINT "supply_reorder_requests_supply_id_fkey" FOREIGN KEY ("supply_id") REFERENCES "supplies"("supply_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supply_reorder_requests" ADD CONSTRAINT "supply_reorder_requests_forecast_id_fkey" FOREIGN KEY ("forecast_id") REFERENCES "supply_forecast_snapshots"("forecast_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supply_reorder_requests" ADD CONSTRAINT "supply_reorder_requests_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supply_reorder_requests" ADD CONSTRAINT "supply_reorder_requests_approved_by_user_id_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_shipments" ADD CONSTRAINT "carrier_shipments_package_group_id_fkey" FOREIGN KEY ("package_group_id") REFERENCES "shipment_package_groups"("package_group_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_shipments" ADD CONSTRAINT "carrier_shipments_replaces_carrier_shipment_id_fkey" FOREIGN KEY ("replaces_carrier_shipment_id") REFERENCES "carrier_shipments"("carrier_shipment_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_tracking_events" ADD CONSTRAINT "carrier_tracking_events_carrier_shipment_id_fkey" FOREIGN KEY ("carrier_shipment_id") REFERENCES "carrier_shipments"("carrier_shipment_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_return_requests" ADD CONSTRAINT "carrier_return_requests_carrier_shipment_id_fkey" FOREIGN KEY ("carrier_shipment_id") REFERENCES "carrier_shipments"("carrier_shipment_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_api_call_logs" ADD CONSTRAINT "carrier_api_call_logs_carrier_shipment_id_fkey" FOREIGN KEY ("carrier_shipment_id") REFERENCES "carrier_shipments"("carrier_shipment_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_api_call_logs" ADD CONSTRAINT "carrier_api_call_logs_worker_job_id_fkey" FOREIGN KEY ("worker_job_id") REFERENCES "server_worker_jobs"("worker_job_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_invoice_issue_batches" ADD CONSTRAINT "carrier_invoice_issue_batches_shipment_list_print_batch_id_fkey" FOREIGN KEY ("shipment_list_print_batch_id") REFERENCES "sales_channel_shipment_list_print_batches"("shipment_list_print_batch_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_invoice_issue_batches" ADD CONSTRAINT "carrier_invoice_issue_batches_api_call_log_id_fkey" FOREIGN KEY ("api_call_log_id") REFERENCES "carrier_api_call_logs"("carrier_api_call_log_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_invoice_replacement_works" ADD CONSTRAINT "carrier_invoice_replacement_works_package_group_id_fkey" FOREIGN KEY ("package_group_id") REFERENCES "shipment_package_groups"("package_group_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_invoice_replacement_works" ADD CONSTRAINT "carrier_invoice_replacement_works_shipment_address_change__fkey" FOREIGN KEY ("shipment_address_change_work_id") REFERENCES "shipment_address_change_work"("shipment_address_change_work_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_invoice_replacement_works" ADD CONSTRAINT "carrier_invoice_replacement_works_old_carrier_shipment_id_fkey" FOREIGN KEY ("old_carrier_shipment_id") REFERENCES "carrier_shipments"("carrier_shipment_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_invoice_replacement_works" ADD CONSTRAINT "carrier_invoice_replacement_works_candidate_carrier_shipme_fkey" FOREIGN KEY ("candidate_carrier_shipment_id") REFERENCES "carrier_shipments"("carrier_shipment_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_invoice_replacement_works" ADD CONSTRAINT "carrier_invoice_replacement_works_carrier_invoice_issue_ba_fkey" FOREIGN KEY ("carrier_invoice_issue_batch_id") REFERENCES "carrier_invoice_issue_batches"("carrier_invoice_issue_batch_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_invoice_replacement_works" ADD CONSTRAINT "carrier_invoice_replacement_works_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_invoice_replacement_works" ADD CONSTRAINT "carrier_invoice_replacement_works_resolved_by_user_id_fkey" FOREIGN KEY ("resolved_by_user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_invoice_issue_items" ADD CONSTRAINT "carrier_invoice_issue_items_carrier_invoice_issue_batch_id_fkey" FOREIGN KEY ("carrier_invoice_issue_batch_id") REFERENCES "carrier_invoice_issue_batches"("carrier_invoice_issue_batch_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_invoice_issue_items" ADD CONSTRAINT "carrier_invoice_issue_items_package_group_id_fkey" FOREIGN KEY ("package_group_id") REFERENCES "shipment_package_groups"("package_group_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_invoice_issue_items" ADD CONSTRAINT "carrier_invoice_issue_items_carrier_shipment_id_fkey" FOREIGN KEY ("carrier_shipment_id") REFERENCES "carrier_shipments"("carrier_shipment_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_shipment_registration_works" ADD CONSTRAINT "carrier_shipment_registration_works_carrier_shipment_id_fkey" FOREIGN KEY ("carrier_shipment_id") REFERENCES "carrier_shipments"("carrier_shipment_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_shipment_registration_works" ADD CONSTRAINT "carrier_shipment_registration_works_carrier_invoice_issue__fkey" FOREIGN KEY ("carrier_invoice_issue_item_id") REFERENCES "carrier_invoice_issue_items"("carrier_invoice_issue_item_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_shipment_registration_works" ADD CONSTRAINT "carrier_shipment_registration_works_package_group_id_fkey" FOREIGN KEY ("package_group_id") REFERENCES "shipment_package_groups"("package_group_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_shipment_registration_works" ADD CONSTRAINT "carrier_shipment_registration_works_worker_job_id_fkey" FOREIGN KEY ("worker_job_id") REFERENCES "server_worker_jobs"("worker_job_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_shipment_registration_works" ADD CONSTRAINT "carrier_shipment_registration_works_classification_api_cal_fkey" FOREIGN KEY ("classification_api_call_log_id") REFERENCES "carrier_api_call_logs"("carrier_api_call_log_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_shipment_registration_works" ADD CONSTRAINT "carrier_shipment_registration_works_registration_api_call__fkey" FOREIGN KEY ("registration_api_call_log_id") REFERENCES "carrier_api_call_logs"("carrier_api_call_log_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_shipment_registration_works" ADD CONSTRAINT "carrier_shipment_registration_works_reconciliation_work_id_fkey" FOREIGN KEY ("reconciliation_work_id") REFERENCES "carrier_reconciliation_works"("carrier_reconciliation_work_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carrier_reconciliation_works" ADD CONSTRAINT "carrier_reconciliation_works_api_call_log_id_fkey" FOREIGN KEY ("api_call_log_id") REFERENCES "carrier_api_call_logs"("carrier_api_call_log_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_command_attempts" ADD CONSTRAINT "integration_command_attempts_integration_command_id_fkey" FOREIGN KEY ("integration_command_id") REFERENCES "integration_commands"("integration_command_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_evidences" ADD CONSTRAINT "integration_evidences_integration_command_id_fkey" FOREIGN KEY ("integration_command_id") REFERENCES "integration_commands"("integration_command_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_evidences" ADD CONSTRAINT "integration_evidences_integration_command_attempt_id_fkey" FOREIGN KEY ("integration_command_attempt_id") REFERENCES "integration_command_attempts"("integration_command_attempt_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_projection_jobs" ADD CONSTRAINT "integration_projection_jobs_integration_evidence_id_fkey" FOREIGN KEY ("integration_evidence_id") REFERENCES "integration_evidences"("integration_evidence_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domain_audit_event_changes" ADD CONSTRAINT "domain_audit_event_changes_domain_audit_event_id_fkey" FOREIGN KEY ("domain_audit_event_id") REFERENCES "domain_audit_events"("domain_audit_event_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- QuickHack PostgreSQL-only domain constraints not expressible in Prisma schema.
ALTER TABLE "server_instance_state"
  ADD CONSTRAINT "ck_server_instance_state_singleton" CHECK ("singleton_key" = 'QUICKHACK'),
  ADD CONSTRAINT "ck_server_instance_state_epoch" CHECK ("instance_epoch" >= 1),
  ADD CONSTRAINT "ck_server_instance_state_revision" CHECK ("revision" >= 0);

ALTER TABLE "user_sessions"
  ADD CONSTRAINT "ck_user_sessions_credential_revision" CHECK ("credential_revision" >= 0),
  ADD CONSTRAINT "ck_user_sessions_instance_epoch" CHECK ("instance_epoch" >= 1);

ALTER TABLE "user_sensitive_auth_grants"
  ADD CONSTRAINT "ck_user_sensitive_auth_grants_credential_revision" CHECK ("credential_revision" >= 0);

ALTER TABLE "domain_operation_keys"
  ADD CONSTRAINT "ck_domain_operation_keys_status" CHECK ("status" IN ('COMMITTED', 'FAILED_LOCAL'));

ALTER TABLE "integration_commands"
  ADD CONSTRAINT "ck_integration_commands_status" CHECK ("command_status" IN ('PENDING', 'DISPATCHING', 'SUCCEEDED', 'NOT_APPLIED', 'AMBIGUOUS', 'FAILED_LOCAL')),
  ADD CONSTRAINT "ck_integration_commands_claim_generation" CHECK ("claim_generation" >= 0);

ALTER TABLE "integration_command_attempts"
  ADD CONSTRAINT "ck_integration_command_attempts_no" CHECK ("attempt_no" > 0),
  ADD CONSTRAINT "ck_integration_command_attempts_status" CHECK ("dispatch_status" IN ('CREATED', 'DISPATCHED', 'RESPONSE_RECEIVED', 'CONNECTION_LOST', 'FAILED_LOCAL'));

ALTER TABLE "integration_evidences"
  ADD CONSTRAINT "ck_integration_evidences_outcome" CHECK ("outcome" IN ('SUCCEEDED', 'NOT_APPLIED', 'AMBIGUOUS', 'FAILED_LOCAL'));

ALTER TABLE "integration_projection_jobs"
  ADD CONSTRAINT "ck_integration_projection_jobs_status" CHECK ("projection_status" IN ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED')),
  ADD CONSTRAINT "ck_integration_projection_jobs_attempt_count" CHECK ("attempt_count" >= 0),
  ADD CONSTRAINT "ck_integration_projection_jobs_claim_generation" CHECK ("claim_generation" >= 0),
  ADD CONSTRAINT "ck_integration_projection_jobs_context_object" CHECK ("projection_context" IS NULL OR jsonb_typeof("projection_context") = 'object');

ALTER TABLE "coupang_order_raw"
  ADD CONSTRAINT "ck_coupang_order_delivery_time_source" CHECK (
    "delivery_time_source" IS NULL OR
    "delivery_time_source" IN ('COUPANG_DELIVERED_DATE', 'SYNC_RECEIVED_AT_FALLBACK')
  ),
  ADD CONSTRAINT "ck_coupang_order_delivery_time_pair" CHECK (
    ("delivery_occurred_at" IS NULL) = ("delivery_time_source" IS NULL)
  );

ALTER TABLE "coupang_return_raw"
  ADD CONSTRAINT "ck_coupang_return_cancel_count_positive" CHECK ("cancel_count" > 0),
  ADD CONSTRAINT "ck_coupang_return_item_integrity" CHECK ("item_integrity_status" IN ('VALID', 'COUNT_MISMATCH')),
  ADD CONSTRAINT "ck_coupang_return_projection_revision" CHECK ("projection_revision" >= 0);

ALTER TABLE "coupang_return_raw_item"
  ADD CONSTRAINT "ck_coupang_return_item_cancel_count_positive" CHECK ("cancel_count" > 0),
  ADD CONSTRAINT "ck_coupang_return_item_shipment_required" CHECK (
    "external_shipment_id" IS NOT NULL AND btrim("external_shipment_id") <> ''
  ),
  ADD CONSTRAINT "ck_coupang_return_item_vendor_required" CHECK (
    "external_vendor_item_id" IS NOT NULL AND btrim("external_vendor_item_id") <> ''
  );

ALTER TABLE "coupang_return_withdrawal"
  ADD CONSTRAINT "ck_coupang_return_withdrawal_receipt_required" CHECK (btrim("external_receipt_id") <> ''),
  ADD CONSTRAINT "ck_coupang_return_withdrawal_revision" CHECK ("projection_revision" >= 0);

ALTER TABLE "coupang_exchange_raw"
  ADD CONSTRAINT "ck_coupang_exchange_scope_integrity" CHECK ("scope_integrity_status" IN ('VALID', 'MISSING_SCOPE')),
  ADD CONSTRAINT "ck_coupang_exchange_projection_revision" CHECK ("projection_revision" >= 0);

ALTER TABLE "coupang_exchange_shipment_scope"
  ADD CONSTRAINT "ck_coupang_exchange_scope_shipment_required" CHECK (btrim("external_shipment_id") <> '');

ALTER TABLE "sales_channel_write_requests"
  ADD CONSTRAINT "ck_sales_channel_write_source_snapshot_pair" CHECK (
    ("source_projection_revision" IS NULL) = ("source_snapshot_digest" IS NULL)
  ),
  ADD CONSTRAINT "ck_sales_channel_write_source_projection_revision" CHECK (
    "source_projection_revision" IS NULL OR "source_projection_revision" >= 0
  );

ALTER TABLE "inventory_quantity_balances"
  ADD CONSTRAINT "ck_inventory_quantity_balances_quantity" CHECK ("quantity" >= 0),
  ADD CONSTRAINT "ck_inventory_quantity_balances_version" CHECK ("version" >= 0);

ALTER TABLE "supply_inventory"
  ADD CONSTRAINT "ck_supply_inventory_quantity" CHECK ("current_quantity" >= 0),
  ADD CONSTRAINT "ck_supply_inventory_reserved_quantity" CHECK ("reserved_quantity" >= 0),
  ADD CONSTRAINT "ck_supply_inventory_version" CHECK ("version" >= 0);

ALTER TABLE "supply_consumption_rules"
  ADD CONSTRAINT "ck_supply_consumption_rules_quantity_positive_integer" CHECK ("quantity_per_unit" > 0);

ALTER TABLE "supply_consumption_events"
  ADD CONSTRAINT "ck_supply_consumption_events_quantity_positive_integer" CHECK ("quantity" > 0);

ALTER TABLE "supply_forecast_snapshots"
  ADD CONSTRAINT "ck_supply_forecast_expected_usage" CHECK ("expected_usage_quantity" >= 0),
  ADD CONSTRAINT "ck_supply_forecast_average_daily_usage" CHECK ("average_daily_usage" >= 0),
  ADD CONSTRAINT "ck_supply_forecast_safety_stock" CHECK ("safety_stock_quantity" >= 0),
  ADD CONSTRAINT "ck_supply_forecast_reorder_point" CHECK ("reorder_point_quantity" >= 0),
  ADD CONSTRAINT "ck_supply_forecast_target_stock" CHECK ("target_stock_quantity" >= 0);

CREATE FUNCTION "quickhack_reject_append_only_mutation"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'QuickHack append-only relation % cannot be updated or deleted', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "trg_domain_audit_events_append_only"
  BEFORE UPDATE OR DELETE ON "domain_audit_events"
  FOR EACH ROW EXECUTE FUNCTION "quickhack_reject_append_only_mutation"();

CREATE TRIGGER "trg_domain_audit_event_changes_append_only"
  BEFORE UPDATE OR DELETE ON "domain_audit_event_changes"
  FOR EACH ROW EXECUTE FUNCTION "quickhack_reject_append_only_mutation"();

-- Existing business invariants carried into the clean PostgreSQL baseline.
CREATE UNIQUE INDEX "uq_supply_reorder_requests_open_supply_id"
  ON "supply_reorder_requests" ("supply_id")
  WHERE "request_status" IN ('SUGGESTED', 'REQUESTED', 'APPROVED', 'ORDERED');

ALTER TABLE "users"
  ADD CONSTRAINT "ck_users_role" CHECK ("role" IN ('LEADER', 'MANAGER', 'STAFF', 'VIEWER'));

ALTER TABLE "devices"
  ADD CONSTRAINT "ck_devices_pg_no_required" CHECK (btrim("pg_no") <> ''),
  ADD CONSTRAINT "ck_devices_model_required" CHECK (btrim("model") <> ''),
  ADD CONSTRAINT "ck_devices_model_seq_positive" CHECK ("model_seq" IS NULL OR "model_seq" > 0);

ALTER TABLE "inbounds"
  ADD CONSTRAINT "ck_inbounds_status" CHECK ("inbound_status" IN ('RECEIVED', 'INSPECTING', 'INSPECTED', 'PURCHASED', 'SUPPLIER_RETURN')),
  ADD CONSTRAINT "ck_inbounds_purchase_price" CHECK ("purchase_price" IS NULL OR "purchase_price" >= 0);

ALTER TABLE "inbound_batches"
  ADD CONSTRAINT "ck_inbound_batches_expected_quantity" CHECK ("expected_quantity" > 0);

ALTER TABLE "inspections"
  ADD CONSTRAINT "ck_inspections_return_yn" CHECK ("return_yn" IN ('Y', 'N')),
  ADD CONSTRAINT "ck_inspections_source_shape" CHECK (
    (
      "source_type" IN ('INBOUND', 'MANUAL')
      AND "inbound_id" IS NOT NULL
      AND "coupang_return_allocation_id" IS NULL
      AND "inspection_type" IN ('APPEARANCE', 'FUNCTION')
    )
    OR
    (
      "source_type" = 'COUPANG_RETURN'
      AND "inbound_id" IS NULL
      AND "coupang_return_allocation_id" IS NOT NULL
      AND "inspection_type" = 'RETURN_CHECK'
    )
  );

ALTER TABLE "inventory"
  ADD CONSTRAINT "ck_inventory_status" CHECK ("inventory_status" IN (
    'SELLABLE', 'RESERVED', 'PACKING', 'PACKED', 'DEPARTURE', 'DELIVERING',
    'FINAL_DELIVERY', 'NONE_TRACKING', 'HOLD', 'DEFECTIVE',
    'RETURN_REQUESTED', 'EXCHANGE_REQUESTED', 'RETURN_CHECK'
  ));

ALTER TABLE "inventory_quantity_balances"
  ADD CONSTRAINT "ck_inventory_quantity_balances_status" CHECK ("inventory_status" IN (
    'SELLABLE', 'RESERVED', 'PACKING', 'PACKED', 'DEPARTURE', 'DELIVERING',
    'FINAL_DELIVERY', 'NONE_TRACKING', 'HOLD', 'DEFECTIVE',
    'RETURN_REQUESTED', 'EXCHANGE_REQUESTED', 'RETURN_CHECK'
  ));

ALTER TABLE "inventory_quantity_movements"
  ADD CONSTRAINT "ck_inventory_quantity_movements_type" CHECK ("movement_type" IN (
    'INVENTORY_CREATED', 'STATUS_TRANSFER',
    'SKU_RECLASSIFICATION', 'INVENTORY_REMOVED'
  ));

ALTER TABLE "server_worker_jobs"
  ADD CONSTRAINT "ck_server_worker_jobs_status" CHECK ("status" IN ('IDLE', 'RUNNING', 'SUCCESS', 'FAILED', 'RETRY_WAITING', 'DISABLED')),
  ADD CONSTRAINT "ck_server_worker_jobs_progress_current" CHECK ("progress_current" >= 0),
  ADD CONSTRAINT "ck_server_worker_jobs_progress_total" CHECK ("progress_total" IS NULL OR "progress_total" >= 0),
  ADD CONSTRAINT "ck_server_worker_jobs_attempt_count" CHECK ("attempt_count" >= 0),
  ADD CONSTRAINT "ck_server_worker_jobs_max_attempts" CHECK ("max_attempts" > 0),
  ADD CONSTRAINT "ck_server_worker_jobs_claim_generation" CHECK ("claim_generation" >= 0);

ALTER TABLE "statistics_snapshot_batches"
  ADD CONSTRAINT "ck_statistics_snapshot_batch_status" CHECK ("status" IN ('BUILDING', 'COMPLETE', 'FAILED', 'SUPERSEDED')),
  ADD CONSTRAINT "ck_statistics_snapshot_batch_period" CHECK (
    "period_from" <= "period_to"
    AND "period_to" = "data_cutoff_date"
    AND "day_count" > 0
    AND btrim("calculation_version") <> ''
  ),
  ADD CONSTRAINT "ck_statistics_snapshot_batch_lifecycle" CHECK (
    (
      "status" = 'BUILDING'
      AND "completed_at" IS NULL
      AND "failed_at" IS NULL
      AND "error_code" IS NULL
      AND "error_message" IS NULL
    )
    OR (
      "status" IN ('COMPLETE', 'SUPERSEDED')
      AND "completed_at" IS NOT NULL
      AND "failed_at" IS NULL
      AND "error_code" IS NULL
      AND "error_message" IS NULL
    )
    OR (
      "status" = 'FAILED'
      AND "completed_at" IS NULL
      AND "failed_at" IS NOT NULL
    )
  );

ALTER TABLE "statistics_snapshot_items"
  ADD CONSTRAINT "ck_statistics_snapshot_item_domain" CHECK ("domain" IN ('PURCHASE', 'INVENTORY', 'SALES', 'RETURNS')),
  ADD CONSTRAINT "ck_statistics_snapshot_item_payload" CHECK (
    "payload_schema_version" > 0
    AND length("payload_text") > 0
    AND length("payload_hash") = 64
    AND "payload_size_bytes" > 0
  );

CREATE UNIQUE INDEX "uq_statistics_snapshot_batch_complete_cutoff_version"
  ON "statistics_snapshot_batches" ("calculation_version", "data_cutoff_date")
  WHERE "status" = 'COMPLETE';

CREATE FUNCTION "quickhack_validate_statistics_snapshot_batch"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM OLD."status"
    AND NOT (
      (OLD."status" = 'BUILDING' AND NEW."status" IN ('COMPLETE', 'FAILED'))
      OR (OLD."status" = 'COMPLETE' AND NEW."status" = 'SUPERSEDED')
    ) THEN
    RAISE EXCEPTION 'invalid statistics snapshot batch status transition'
      USING ERRCODE = '23514';
  END IF;

  IF OLD."status" <> 'BUILDING' AND (
    NEW."data_cutoff_date" IS DISTINCT FROM OLD."data_cutoff_date"
    OR NEW."period_from" IS DISTINCT FROM OLD."period_from"
    OR NEW."period_to" IS DISTINCT FROM OLD."period_to"
    OR NEW."day_count" IS DISTINCT FROM OLD."day_count"
    OR NEW."calculation_version" IS DISTINCT FROM OLD."calculation_version"
    OR NEW."started_at" IS DISTINCT FROM OLD."started_at"
  ) THEN
    RAISE EXCEPTION 'completed statistics snapshot identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW."status" = 'COMPLETE' AND OLD."status" <> 'COMPLETE' AND (
    SELECT COUNT(*) <> 4 OR COUNT(DISTINCT "domain") <> 4
      FROM "statistics_snapshot_items"
     WHERE "snapshot_batch_id" = NEW."snapshot_batch_id"
       AND "domain" IN ('PURCHASE', 'INVENTORY', 'SALES', 'RETURNS')
  ) THEN
    RAISE EXCEPTION 'statistics snapshot batch requires all four domains'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_statistics_snapshot_batch_validate"
  BEFORE UPDATE ON "statistics_snapshot_batches"
  FOR EACH ROW EXECUTE FUNCTION "quickhack_validate_statistics_snapshot_batch"();

CREATE FUNCTION "quickhack_validate_statistics_snapshot_item_mutation"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_status TEXT;
  new_status TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT "status" INTO old_status
      FROM "statistics_snapshot_batches"
     WHERE "snapshot_batch_id" = OLD."snapshot_batch_id";
    IF old_status IS DISTINCT FROM 'BUILDING' THEN
      RAISE EXCEPTION 'statistics snapshot items require a BUILDING batch'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    SELECT "status" INTO new_status
      FROM "statistics_snapshot_batches"
     WHERE "snapshot_batch_id" = NEW."snapshot_batch_id";
    IF new_status IS DISTINCT FROM 'BUILDING' THEN
      RAISE EXCEPTION 'statistics snapshot items require a BUILDING batch'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER "trg_statistics_snapshot_item_validate"
  BEFORE INSERT OR UPDATE OR DELETE ON "statistics_snapshot_items"
  FOR EACH ROW EXECUTE FUNCTION "quickhack_validate_statistics_snapshot_item_mutation"();

ALTER TABLE "sales_channel_shipment_list_print_batches"
  ADD CONSTRAINT "ck_shipment_print_batches_batch_no" CHECK ("batch_no" > 0),
  ADD CONSTRAINT "ck_shipment_print_batches_item_count" CHECK ("item_count" >= 0),
  ADD CONSTRAINT "ck_shipment_print_batches_package_group_count" CHECK ("package_group_count" >= 0),
  ADD CONSTRAINT "ck_shipment_print_batches_status" CHECK ("batch_status" IN ('PENDING', 'PRINT_DIALOG_CLOSED', 'CONFIRMED', 'CANCELED'));

ALTER TABLE "carrier_shipments"
  ADD CONSTRAINT "ck_carrier_shipments_carrier_required" CHECK (btrim("carrier_code") <> ''),
  ADD CONSTRAINT "ck_carrier_shipments_tracking_required" CHECK (btrim("tracking_number") <> ''),
  ADD CONSTRAINT "ck_carrier_shipments_invoice_status" CHECK ("invoice_status" IN ('ALLOCATED', 'PRINTED', 'REGISTERED', 'FAILED', 'REPLACED', 'VOID_LOCAL')),
  ADD CONSTRAINT "ck_carrier_shipments_shipment_status" CHECK ("shipment_status" IN ('ALLOCATED', 'REGISTERED', 'IN_TRANSIT', 'DELIVERED', 'EXCEPTION')),
  ADD CONSTRAINT "ck_carrier_shipments_revision_no" CHECK ("revision_no" > 0);

ALTER TABLE "carrier_invoice_issue_batches"
  ADD CONSTRAINT "ck_carrier_invoice_issue_batches_issue_type" CHECK ("issue_type" IN ('INITIAL', 'REISSUE')),
  ADD CONSTRAINT "ck_carrier_invoice_issue_batches_status" CHECK ("batch_status" IN ('PENDING', 'ALLOCATING', 'ALLOCATED', 'REVIEW_REQUIRED', 'FAILED')),
  ADD CONSTRAINT "ck_carrier_invoice_issue_batches_requested_count" CHECK ("requested_package_group_count" > 0),
  ADD CONSTRAINT "ck_carrier_invoice_issue_batches_allocated_count" CHECK ("allocated_package_group_count" >= 0 AND "allocated_package_group_count" <= "requested_package_group_count"),
  ADD CONSTRAINT "ck_carrier_invoice_issue_batches_attempt_count" CHECK ("attempt_count" >= 0),
  ADD CONSTRAINT "ck_carrier_invoice_issue_batches_dispatch_marker" CHECK ("allocation_request_dispatched" IN (0, 1)),
  ADD CONSTRAINT "ck_carrier_invoice_issue_batches_allocating_execution" CHECK ("batch_status" <> 'ALLOCATING' OR ("attempt_count" > 0 AND "started_at" IS NOT NULL));

ALTER TABLE "carrier_invoice_issue_items"
  ADD CONSTRAINT "ck_carrier_invoice_issue_items_sequence" CHECK ("issue_sequence" > 0),
  ADD CONSTRAINT "ck_carrier_invoice_issue_items_revision" CHECK ("revision_no" > 0),
  ADD CONSTRAINT "ck_carrier_invoice_issue_items_label_attempt" CHECK ("label_print_attempt_no" >= 0),
  ADD CONSTRAINT "ck_carrier_invoice_issue_items_label_count" CHECK ("label_print_count" >= 0);

ALTER TABLE "sales_channel_inventory_verification_states"
  ADD CONSTRAINT "ck_inventory_verification_channel_required" CHECK (btrim("channel") <> ''),
  ADD CONSTRAINT "ck_inventory_verification_vendor_required" CHECK (btrim("external_vendor_item_id") <> ''),
  ADD CONSTRAINT "ck_inventory_verification_status" CHECK ("verification_status" IN ('PENDING', 'CHECKING', 'MATCHED', 'MISMATCH', 'CHECK_FAILED', 'SKIPPED')),
  ADD CONSTRAINT "ck_inventory_verification_quantities" CHECK ("ledger_quantity" >= 0 AND "pending_order_quantity" >= 0 AND ("channel_quantity" IS NULL OR "channel_quantity" >= 0)),
  ADD CONSTRAINT "ck_inventory_verification_desired_version" CHECK ("desired_version" > 0),
  ADD CONSTRAINT "ck_inventory_verification_processing_version" CHECK ("processing_version" IS NULL OR ("processing_version" > 0 AND "processing_version" <= "desired_version")),
  ADD CONSTRAINT "ck_inventory_verification_retry_count" CHECK ("retry_count" >= 0),
  ADD CONSTRAINT "ck_inventory_verification_state_revision" CHECK ("state_revision" > 0),
  ADD CONSTRAINT "ck_inventory_verification_checking_owner" CHECK ("verification_status" <> 'CHECKING' OR ("processing_version" IS NOT NULL AND "execution_token" IS NOT NULL)),
  ADD CONSTRAINT "ck_inventory_verification_processing_owner" CHECK ("processing_version" IS NULL OR "verification_status" = 'CHECKING'),
  ADD CONSTRAINT "ck_inventory_verification_execution_token" CHECK ("execution_token" IS NULL OR (btrim("execution_token") <> '' AND "verification_status" IN ('PENDING', 'CHECKING')));

ALTER TABLE "sales_channel_projection_clocks"
  ADD CONSTRAINT "ck_sales_channel_projection_clocks_channel" CHECK (btrim("channel") <> ''),
  ADD CONSTRAINT "ck_sales_channel_projection_clocks_revision" CHECK ("current_revision" >= 0);

ALTER TABLE "coupang_order_raw"
  ADD CONSTRAINT "ck_coupang_order_raw_projection_revision" CHECK ("projection_revision" >= 0);

ALTER TABLE "coupang_return_raw"
  ADD CONSTRAINT "ck_coupang_return_raw_projection_revision" CHECK ("projection_revision" >= 0);

ALTER TABLE "coupang_exchange_raw"
  ADD CONSTRAINT "ck_coupang_exchange_raw_projection_revision" CHECK ("projection_revision" >= 0);

ALTER TABLE "coupang_api_call_log"
  ADD CONSTRAINT "ck_coupang_api_call_log_method" CHECK ("method" IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
  ADD CONSTRAINT "ck_coupang_api_call_log_status" CHECK ("processed_status" IN ('PENDING', 'RECEIVED', 'PROCESSING', 'SUCCESS', 'PARTIAL', 'FAILED', 'SKIPPED', 'CANCELED')),
  ADD CONSTRAINT "ck_coupang_api_call_log_http_status" CHECK ("http_status_code" IS NULL OR "http_status_code" > 0),
  ADD CONSTRAINT "ck_coupang_api_call_log_page_size" CHECK ("max_per_page" IS NULL OR "max_per_page" > 0),
  ADD CONSTRAINT "ck_coupang_api_call_log_row_counts" CHECK ("response_row_count" >= 0 AND "processed_row_count" >= 0 AND "skipped_row_count" >= 0),
  ADD CONSTRAINT "ck_coupang_api_call_log_stale_snapshot_count" CHECK ("stale_snapshot_count" >= 0),
  ADD CONSTRAINT "ck_coupang_api_call_log_projection_revision" CHECK ("projection_revision" IS NULL OR "projection_revision" > 0),
  ADD CONSTRAINT "ck_coupang_api_call_log_applied_rows" CHECK ("processed_row_count" + "skipped_row_count" <= "response_row_count"),
  ADD CONSTRAINT "ck_coupang_api_call_log_success_rows" CHECK ("processed_status" <> 'SUCCESS' OR "processed_row_count" + "skipped_row_count" = "response_row_count");

CREATE FUNCTION "quickhack_reject_employee_audit_mutation"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "trg_employee_activity_logs_append_only_update"
  BEFORE UPDATE ON "employee_activity_logs"
  FOR EACH ROW EXECUTE FUNCTION "quickhack_reject_employee_audit_mutation"();
CREATE TRIGGER "trg_employee_activity_logs_append_only_delete"
  BEFORE DELETE ON "employee_activity_logs"
  FOR EACH ROW EXECUTE FUNCTION "quickhack_reject_employee_audit_mutation"();
CREATE TRIGGER "trg_employee_activity_log_changes_append_only_update"
  BEFORE UPDATE ON "employee_activity_log_changes"
  FOR EACH ROW EXECUTE FUNCTION "quickhack_reject_employee_audit_mutation"();
CREATE TRIGGER "trg_employee_activity_log_changes_append_only_delete"
  BEFORE DELETE ON "employee_activity_log_changes"
  FOR EACH ROW EXECUTE FUNCTION "quickhack_reject_employee_audit_mutation"();

CREATE FUNCTION "quickhack_inventory_verification_update_guard"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.verification_state_id <> OLD.verification_state_id
     OR NEW.mapping_id <> OLD.mapping_id
     OR NEW.channel <> OLD.channel
     OR NEW.external_vendor_item_id <> OLD.external_vendor_item_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'sales_channel_inventory_verification_states identity is immutable';
  END IF;
  IF NEW.state_revision <> OLD.state_revision + 1 THEN
    RAISE EXCEPTION 'sales_channel_inventory_verification_states state_revision must increase by one';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_sales_channel_inventory_verification_states_integrity_update"
  BEFORE UPDATE ON "sales_channel_inventory_verification_states"
  FOR EACH ROW EXECUTE FUNCTION "quickhack_inventory_verification_update_guard"();

CREATE FUNCTION "quickhack_projection_clock_update_guard"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.channel IS DISTINCT FROM OLD.channel
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'sales_channel_projection_clocks identity is immutable';
  END IF;
  IF NEW.current_revision <> OLD.current_revision + 1 THEN
    RAISE EXCEPTION 'sales_channel_projection_clocks revision must increase by one';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_sales_channel_projection_clocks_update"
  BEFORE UPDATE ON "sales_channel_projection_clocks"
  FOR EACH ROW EXECUTE FUNCTION "quickhack_projection_clock_update_guard"();

CREATE FUNCTION "quickhack_coupang_projection_revision_guard"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.projection_revision < OLD.projection_revision THEN
    RAISE EXCEPTION '% projection revision cannot decrease', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_coupang_order_raw_projection_revision_update"
  BEFORE UPDATE OF "projection_revision" ON "coupang_order_raw"
  FOR EACH ROW EXECUTE FUNCTION "quickhack_coupang_projection_revision_guard"();
CREATE TRIGGER "trg_coupang_return_raw_projection_revision_update"
  BEFORE UPDATE OF "projection_revision" ON "coupang_return_raw"
  FOR EACH ROW EXECUTE FUNCTION "quickhack_coupang_projection_revision_guard"();
CREATE TRIGGER "trg_coupang_exchange_raw_projection_revision_update"
  BEFORE UPDATE OF "projection_revision" ON "coupang_exchange_raw"
  FOR EACH ROW EXECUTE FUNCTION "quickhack_coupang_projection_revision_guard"();

CREATE FUNCTION "quickhack_coupang_api_call_log_update_guard"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.external_vendor_item_id IS DISTINCT FROM OLD.external_vendor_item_id THEN
    RAISE EXCEPTION 'coupang_api_call_log.external_vendor_item_id is immutable';
  END IF;
  IF NEW.projection_revision IS DISTINCT FROM OLD.projection_revision THEN
    RAISE EXCEPTION 'coupang_api_call_log projection revision is immutable';
  END IF;
  IF NEW.processed_status IS DISTINCT FROM OLD.processed_status AND NOT (
    (OLD.processed_status = 'PENDING' AND NEW.processed_status IN ('RECEIVED', 'FAILED', 'SKIPPED')) OR
    (OLD.processed_status = 'RECEIVED' AND NEW.processed_status IN ('PROCESSING', 'FAILED', 'SKIPPED')) OR
    (OLD.processed_status = 'PROCESSING' AND NEW.processed_status IN ('SUCCESS', 'PARTIAL', 'FAILED'))
  ) THEN
    RAISE EXCEPTION 'invalid coupang_api_call_log status transition';
  END IF;
  IF NEW.processed_status IN ('RECEIVED', 'PROCESSING', 'SUCCESS', 'PARTIAL')
     AND (NEW.http_status_code IS NULL OR NEW.received_at IS NULL) THEN
    RAISE EXCEPTION 'coupang_api_call_log RECEIVED requires an HTTP response';
  END IF;
  IF NEW.processed_status IN ('PROCESSING', 'SUCCESS', 'PARTIAL')
     AND NEW.processing_started_at IS NULL THEN
    RAISE EXCEPTION 'coupang_api_call_log processing timestamp is required';
  END IF;
  IF NEW.processed_status IN ('SUCCESS', 'PARTIAL', 'FAILED', 'SKIPPED')
     AND NEW.processed_at IS NULL THEN
    RAISE EXCEPTION 'coupang_api_call_log terminal timestamp is required';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_coupang_api_call_log_update_guard"
  BEFORE UPDATE ON "coupang_api_call_log"
  FOR EACH ROW EXECUTE FUNCTION "quickhack_coupang_api_call_log_update_guard"();

CREATE FUNCTION "quickhack_shipment_print_batch_transition_guard"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.batch_status IS DISTINCT FROM OLD.batch_status AND NOT (
    (OLD.batch_status = 'PENDING' AND NEW.batch_status IN ('PRINT_DIALOG_CLOSED', 'CONFIRMED', 'CANCELED')) OR
    (OLD.batch_status = 'PRINT_DIALOG_CLOSED' AND NEW.batch_status IN ('CONFIRMED', 'CANCELED'))
  ) THEN
    RAISE EXCEPTION 'sales_channel_shipment_list_print_batches.batch_status transition is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_shipment_print_batches_status_transition_guard"
  BEFORE UPDATE OF "batch_status" ON "sales_channel_shipment_list_print_batches"
  FOR EACH ROW EXECUTE FUNCTION "quickhack_shipment_print_batch_transition_guard"();

CREATE FUNCTION "quickhack_carrier_replacement_execution_guard"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.work_status IN ('COMPLETED', 'FAILED', 'CANCELED')
     AND NEW.work_status <> OLD.work_status THEN
    RAISE EXCEPTION 'carrier_invoice_replacement_works terminal status is immutable';
  END IF;
  IF NEW.workflow_version < 0 THEN
    RAISE EXCEPTION 'carrier_invoice_replacement_works.workflow_version is invalid';
  END IF;
  IF (NEW.execution_token IS NULL) <> (NEW.execution_started_at IS NULL) THEN
    RAISE EXCEPTION 'carrier_invoice_replacement_works.execution ownership is incomplete';
  END IF;
  IF NEW.work_status IN ('COMPLETED', 'FAILED', 'CANCELED') AND NEW.execution_token IS NOT NULL THEN
    RAISE EXCEPTION 'carrier_invoice_replacement_works terminal work cannot be owned';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_carrier_invoice_replacement_execution_integrity_insert"
  BEFORE INSERT ON "carrier_invoice_replacement_works"
  FOR EACH ROW EXECUTE FUNCTION "quickhack_carrier_replacement_execution_guard"();
CREATE TRIGGER "trg_carrier_invoice_replacement_execution_integrity_update"
  BEFORE UPDATE OF "workflow_version", "execution_token", "execution_started_at", "work_status"
  ON "carrier_invoice_replacement_works"
  FOR EACH ROW EXECUTE FUNCTION "quickhack_carrier_replacement_execution_guard"();

ALTER TABLE "sales_channel_write_request_targets"
  ADD CONSTRAINT "ck_sales_channel_write_targets_target_type" CHECK (btrim("target_type") <> ''),
  ADD CONSTRAINT "ck_sales_channel_write_targets_quantity" CHECK ("quantity" IS NULL OR "quantity" > 0);

ALTER TABLE "sales_channel_write_request_attempts"
  ADD CONSTRAINT "ck_sales_channel_write_attempts_no" CHECK ("attempt_no" > 0),
  ADD CONSTRAINT "ck_sales_channel_write_attempts_type" CHECK ("attempt_type" IN ('WRITE', 'VERIFY_READ', 'LOCAL_FINALIZE')),
  ADD CONSTRAINT "ck_sales_channel_write_attempts_status" CHECK ("attempt_status" IN ('SENDING', 'SUCCEEDED', 'FAILED', 'AMBIGUOUS')),
  ADD CONSTRAINT "ck_sales_channel_write_attempts_flags" CHECK (
    "request_dispatched" IN (0, 1)
    AND "response_received" IN (0, 1)
    AND "external_applied_unknown" IN (0, 1)
  ),
  ADD CONSTRAINT "ck_sales_channel_write_attempts_http_status" CHECK ("http_status_code" IS NULL OR "http_status_code" > 0);

ALTER TABLE "sales_channel_write_controls"
  ADD CONSTRAINT "ck_sales_channel_write_controls_paused" CHECK ("is_paused" IN (0, 1)),
  ADD CONSTRAINT "ck_sales_channel_write_controls_failures" CHECK ("consecutive_failure_count" >= 0),
  ADD CONSTRAINT "ck_sales_channel_write_controls_revision" CHECK ("revision" >= 0);

ALTER TABLE "order_matching_work_queue"
  ADD CONSTRAINT "ck_order_matching_work_queue_quantities" CHECK (
    "ordered_quantity" >= 0
    AND "cancel_hold_quantity" >= 0
    AND "canceled_quantity" >= 0
    AND "matchable_quantity" >= 0
    AND "canceled" IN (0, 1)
  );

ALTER TABLE "match_worker_allocation"
  ADD CONSTRAINT "ck_match_worker_allocation_status" CHECK (
    "allocation_status" IN ('ALLOCATED', 'API_ACKED', 'SHIPMENT_LIST_PRINTED', 'CANCELED', 'FAILED')
  );

CREATE FUNCTION "quickhack_match_worker_allocation_status_guard"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.allocation_status = OLD.allocation_status THEN
    IF OLD.allocation_status = 'SHIPMENT_LIST_PRINTED'
       AND ROW(
         NEW.shipment_list_printed_at,
         NEW.shipment_list_print_batch_id,
         NEW.shipment_list_print_batch_no,
         NEW.shipment_list_print_batch_label
       ) IS DISTINCT FROM ROW(
         OLD.shipment_list_printed_at,
         OLD.shipment_list_print_batch_id,
         OLD.shipment_list_print_batch_no,
         OLD.shipment_list_print_batch_label
       ) THEN
      RAISE EXCEPTION 'printed match_worker_allocation ownership is immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.allocation_status = 'ALLOCATED'
     AND NEW.allocation_status IN ('API_ACKED', 'CANCELED', 'FAILED') THEN
    RETURN NEW;
  END IF;
  IF OLD.allocation_status = 'API_ACKED'
     AND NEW.allocation_status IN ('SHIPMENT_LIST_PRINTED', 'CANCELED', 'FAILED') THEN
    RETURN NEW;
  END IF;
  IF OLD.allocation_status = 'SHIPMENT_LIST_PRINTED'
     AND NEW.allocation_status = 'CANCELED' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'match_worker_allocation status transition % -> % is invalid', OLD.allocation_status, NEW.allocation_status;
END;
$$;

CREATE TRIGGER "trg_match_worker_allocation_status_update"
  BEFORE UPDATE OF "allocation_status" ON "match_worker_allocation"
  FOR EACH ROW EXECUTE FUNCTION "quickhack_match_worker_allocation_status_guard"();

CREATE FUNCTION "quickhack_sales_channel_write_request_guard"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF btrim(NEW.channel) = ''
     OR btrim(NEW.request_type) = ''
     OR btrim(NEW.request_digest) = '' THEN
    RAISE EXCEPTION 'sales_channel_write_requests channel, request_type and request_digest are required';
  END IF;
  IF NEW.request_status NOT IN (
    'PENDING', 'SENDING', 'VERIFYING', 'LOCAL_PENDING', 'COMPLETED',
    'PARTIALLY_COMPLETED', 'REVIEW_REQUIRED', 'NOT_APPLIED', 'REJECTED',
    'RETRYING'
  ) THEN
    RAISE EXCEPTION 'sales_channel_write_requests.request_status is invalid';
  END IF;
  IF NEW.failure_stage IS NOT NULL AND NEW.failure_stage NOT IN (
    'WRITE_TRANSPORT', 'WRITE_RESPONSE', 'EXTERNAL_VERIFICATION', 'LOCAL_FINALIZATION'
  ) THEN
    RAISE EXCEPTION 'sales_channel_write_requests.failure_stage is invalid';
  END IF;
  IF NEW.cancel_count IS NOT NULL AND NEW.cancel_count < 0 THEN
    RAISE EXCEPTION 'sales_channel_write_requests.cancel_count must not be negative';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.request_status = 'RETRYING' THEN
    RAISE EXCEPTION 'sales_channel_write_requests RETRYING cannot be inserted';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.sales_channel_write_request_id IS DISTINCT FROM OLD.sales_channel_write_request_id
       OR NEW.channel IS DISTINCT FROM OLD.channel
       OR NEW.request_type IS DISTINCT FROM OLD.request_type
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.request_digest IS DISTINCT FROM OLD.request_digest THEN
      RAISE EXCEPTION 'sales_channel_write_requests identity is immutable';
    END IF;
    IF NEW.request_status = 'RETRYING'
       AND OLD.request_status NOT IN ('REJECTED', 'NOT_APPLIED') THEN
      RAISE EXCEPTION 'sales_channel_write_requests retry transition is invalid';
    END IF;
    IF OLD.request_status = 'RETRYING' AND NEW.request_status <> 'PENDING' THEN
      RAISE EXCEPTION 'sales_channel_write_requests retry completion is invalid';
    END IF;
  END IF;
  IF (NEW.active_review_attempt_id IS NULL) <> (NEW.active_review_heartbeat_at IS NULL) THEN
    RAISE EXCEPTION 'sales_channel_write_requests active review fields must be paired';
  END IF;
  IF NEW.active_review_attempt_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM sales_channel_write_request_attempts AS attempt
    WHERE attempt.sales_channel_write_request_attempt_id = NEW.active_review_attempt_id
      AND attempt.sales_channel_write_request_id = NEW.sales_channel_write_request_id
      AND attempt.attempt_type IN ('VERIFY_READ', 'LOCAL_FINALIZE')
      AND attempt.attempt_status = 'SENDING'
      AND attempt.completed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'sales_channel_write_requests active review attempt is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_sales_channel_write_requests_integrity_insert"
  BEFORE INSERT ON "sales_channel_write_requests"
  FOR EACH ROW EXECUTE FUNCTION "quickhack_sales_channel_write_request_guard"();
CREATE TRIGGER "trg_sales_channel_write_requests_integrity_update"
  BEFORE UPDATE ON "sales_channel_write_requests"
  FOR EACH ROW EXECUTE FUNCTION "quickhack_sales_channel_write_request_guard"();

CREATE FUNCTION "quickhack_sales_channel_write_target_update_guard"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.sales_channel_write_request_target_id,
    NEW.sales_channel_write_request_id,
    NEW.target_type,
    NEW.target_external_id,
    NEW.allocation_id,
    NEW.pg_no,
    NEW.external_order_id,
    NEW.external_shipment_id,
    NEW.external_vendor_item_id,
    NEW.package_group_id,
    NEW.carrier_shipment_id,
    NEW.delivery_company_code,
    NEW.invoice_number_snapshot,
    NEW.split_shipping,
    NEW.pre_split_shipped,
    NEW.estimated_shipping_date,
    NEW.supply_consumption_event_id,
    NEW.quantity,
    NEW.inventory_verification_state_id,
    NEW.inventory_desired_version_snapshot,
    NEW.inventory_mismatch_since_snapshot,
    NEW.inventory_projection_basis_hash_snapshot,
    NEW.inventory_ledger_quantity_snapshot,
    NEW.inventory_pending_order_quantity_snapshot,
    NEW.inventory_expected_channel_quantity_snapshot,
    NEW.inventory_observed_channel_quantity_snapshot,
    NEW.expected_before_status,
    NEW.requested_after_status,
    NEW.inspection_result,
    NEW.appearance_grade,
    NEW.appearance_defect,
    NEW.function_defect,
    NEW.inspection_note,
    NEW.target_position,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.sales_channel_write_request_target_id,
    OLD.sales_channel_write_request_id,
    OLD.target_type,
    OLD.target_external_id,
    OLD.allocation_id,
    OLD.pg_no,
    OLD.external_order_id,
    OLD.external_shipment_id,
    OLD.external_vendor_item_id,
    OLD.package_group_id,
    OLD.carrier_shipment_id,
    OLD.delivery_company_code,
    OLD.invoice_number_snapshot,
    OLD.split_shipping,
    OLD.pre_split_shipped,
    OLD.estimated_shipping_date,
    OLD.supply_consumption_event_id,
    OLD.quantity,
    OLD.inventory_verification_state_id,
    OLD.inventory_desired_version_snapshot,
    OLD.inventory_mismatch_since_snapshot,
    OLD.inventory_projection_basis_hash_snapshot,
    OLD.inventory_ledger_quantity_snapshot,
    OLD.inventory_pending_order_quantity_snapshot,
    OLD.inventory_expected_channel_quantity_snapshot,
    OLD.inventory_observed_channel_quantity_snapshot,
    OLD.expected_before_status,
    OLD.requested_after_status,
    OLD.inspection_result,
    OLD.appearance_grade,
    OLD.appearance_defect,
    OLD.function_defect,
    OLD.inspection_note,
    OLD.target_position,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'sales_channel_write_request_targets snapshot is immutable';
  END IF;

  IF NEW.external_result_status IS DISTINCT FROM OLD.external_result_status THEN
    IF NOT (
      (OLD.external_result_status = 'PENDING'
       AND NEW.external_result_status IN ('SUCCEEDED', 'NOT_APPLIED', 'UNKNOWN'))
      OR
      (OLD.external_result_status = 'UNKNOWN'
       AND NEW.external_result_status IN ('SUCCEEDED', 'NOT_APPLIED'))
      OR
      (OLD.external_result_status = 'NOT_APPLIED'
       AND NEW.external_result_status = 'PENDING'
       AND EXISTS (
         SELECT 1
         FROM sales_channel_write_requests AS request
         WHERE request.sales_channel_write_request_id = NEW.sales_channel_write_request_id
           AND request.request_status = 'RETRYING'
       ))
    ) THEN
      RAISE EXCEPTION 'sales_channel_write_request_targets external result transition % -> % is invalid', OLD.external_result_status, NEW.external_result_status;
    END IF;
  END IF;

  IF NEW.local_finalization_status IS DISTINCT FROM OLD.local_finalization_status THEN
    IF NOT (
      (OLD.local_finalization_status = 'PENDING'
       AND NEW.local_finalization_status IN ('SUCCEEDED', 'FAILED', 'NOT_REQUIRED'))
      OR
      (OLD.local_finalization_status = 'FAILED'
       AND NEW.local_finalization_status = 'SUCCEEDED')
      OR
      (OLD.local_finalization_status = 'NOT_REQUIRED'
       AND NEW.local_finalization_status = 'PENDING'
       AND OLD.external_result_status = 'NOT_APPLIED'
       AND NEW.external_result_status = 'PENDING'
       AND EXISTS (
         SELECT 1
         FROM sales_channel_write_requests AS request
         WHERE request.sales_channel_write_request_id = NEW.sales_channel_write_request_id
           AND request.request_status = 'RETRYING'
       ))
    ) THEN
      RAISE EXCEPTION 'sales_channel_write_request_targets local finalization transition % -> % is invalid', OLD.local_finalization_status, NEW.local_finalization_status;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "quickhack_sales_channel_write_target_delete_guard"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM sales_channel_write_requests AS request
    WHERE request.sales_channel_write_request_id = OLD.sales_channel_write_request_id
      AND request.request_status = 'RETRYING'
  ) THEN
    RAISE EXCEPTION 'sales_channel_write_request_targets are immutable';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER "trg_sales_channel_write_targets_immutable_update"
  BEFORE UPDATE ON "sales_channel_write_request_targets"
  FOR EACH ROW EXECUTE FUNCTION "quickhack_sales_channel_write_target_update_guard"();
CREATE TRIGGER "trg_sales_channel_write_targets_immutable_delete"
  BEFORE DELETE ON "sales_channel_write_request_targets"
  FOR EACH ROW EXECUTE FUNCTION "quickhack_sales_channel_write_target_delete_guard"();

CREATE FUNCTION "quickhack_sales_channel_write_attempt_update_guard"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'completed sales_channel_write_request_attempts are immutable';
  END IF;
  IF NEW.sales_channel_write_request_attempt_id IS DISTINCT FROM OLD.sales_channel_write_request_attempt_id
     OR NEW.sales_channel_write_request_id IS DISTINCT FROM OLD.sales_channel_write_request_id
     OR NEW.integration_command_id IS DISTINCT FROM OLD.integration_command_id
     OR NEW.attempt_no IS DISTINCT FROM OLD.attempt_no
     OR NEW.attempt_type IS DISTINCT FROM OLD.attempt_type THEN
    RAISE EXCEPTION 'sales_channel_write_request_attempts identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_sales_channel_write_attempts_integrity_update"
  BEFORE UPDATE ON "sales_channel_write_request_attempts"
  FOR EACH ROW EXECUTE FUNCTION "quickhack_sales_channel_write_attempt_update_guard"();

CREATE FUNCTION "quickhack_sync_sales_channel_write_integration"() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  next_command_status TEXT;
  next_dispatch_status TEXT;
BEGIN
  IF NEW.integration_command_id IS NULL OR NEW.attempt_type <> 'WRITE' THEN
    RETURN NEW;
  END IF;

  IF NEW.completed_at IS NULL AND NEW.request_dispatched = 1 THEN
    UPDATE integration_commands
       SET command_status = 'DISPATCHING', updated_at = NEW.started_at
     WHERE integration_command_id = NEW.integration_command_id
       AND command_status = 'PENDING';
    UPDATE integration_command_attempts
       SET dispatch_status = 'DISPATCHED', request_dispatched_at = NEW.started_at
     WHERE integration_command_id = NEW.integration_command_id
       AND attempt_no = 1
       AND dispatch_status = 'CREATED';
    RETURN NEW;
  END IF;

  IF NEW.completed_at IS NULL THEN
    RETURN NEW;
  END IF;

  next_command_status := CASE NEW.attempt_status
    WHEN 'SUCCEEDED' THEN 'SUCCEEDED'
    WHEN 'FAILED' THEN 'NOT_APPLIED'
    WHEN 'AMBIGUOUS' THEN 'AMBIGUOUS'
    ELSE 'FAILED_LOCAL'
  END;
  next_dispatch_status := CASE
    WHEN NEW.response_received = 1 THEN 'RESPONSE_RECEIVED'
    WHEN NEW.request_dispatched = 1 THEN 'CONNECTION_LOST'
    ELSE 'FAILED_LOCAL'
  END;

  UPDATE integration_commands
     SET command_status = next_command_status,
         lease_token = NULL,
         locked_until = NULL,
         updated_at = NEW.completed_at
   WHERE integration_command_id = NEW.integration_command_id;
  UPDATE integration_command_attempts
     SET dispatch_status = next_dispatch_status,
         request_dispatched_at = CASE
           WHEN NEW.request_dispatched = 1 THEN COALESCE(request_dispatched_at, NEW.started_at)
           ELSE request_dispatched_at
         END,
         response_received_at = CASE
           WHEN NEW.response_received = 1 THEN NEW.completed_at
           ELSE NULL
         END,
         http_status = NEW.http_status_code,
         provider_code = NEW.external_response_code,
         error_code = NEW.error_code,
         error_message = NEW.error_message
   WHERE integration_command_id = NEW.integration_command_id
     AND attempt_no = 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_sales_channel_write_attempts_integration_update"
  AFTER UPDATE OF "request_dispatched", "attempt_status", "completed_at"
  ON "sales_channel_write_request_attempts"
  FOR EACH ROW EXECUTE FUNCTION "quickhack_sync_sales_channel_write_integration"();

CREATE FUNCTION "quickhack_sales_channel_write_control_update_guard"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.sales_channel_write_control_id IS DISTINCT FROM OLD.sales_channel_write_control_id
     OR NEW.channel IS DISTINCT FROM OLD.channel
     OR NEW.endpoint_key IS DISTINCT FROM OLD.endpoint_key
     OR NEW.request_type IS DISTINCT FROM OLD.request_type THEN
    RAISE EXCEPTION 'sales_channel_write_controls identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_sales_channel_write_controls_integrity_update"
  BEFORE UPDATE ON "sales_channel_write_controls"
  FOR EACH ROW EXECUTE FUNCTION "quickhack_sales_channel_write_control_update_guard"();
