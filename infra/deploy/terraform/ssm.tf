# SecureString parameters, not Secrets Manager: Secrets Manager bills
# ~$0.40/secret/month, which alone would exceed this whole stack's idle
# target (design spec §3's ~$1/month floor). SSM Standard parameters are free
# up to 10,000 per account. Encrypted with the account's default `alias/aws/ssm`
# key — no customer-managed KMS key to also account for in the idle cost.
#
# Task definitions reference these by ARN via the `secrets` block (ecs.tf), so
# a value only ever reaches the container as an env var at runtime — never
# baked into an image, never in a docker history layer.

locals {
  ssm_prefix = "/${var.project}/${var.environment}"
}

resource "aws_ssm_parameter" "redis_url" {
  name  = "${local.ssm_prefix}/REDIS_URL"
  type  = "SecureString"
  value = var.redis_url
}

resource "aws_ssm_parameter" "supabase_url" {
  name  = "${local.ssm_prefix}/SUPABASE_URL"
  type  = "SecureString"
  value = var.supabase_url
}

resource "aws_ssm_parameter" "supabase_publishable_key" {
  name  = "${local.ssm_prefix}/SUPABASE_PUBLISHABLE_KEY"
  type  = "SecureString"
  value = var.supabase_publishable_key
}

resource "aws_ssm_parameter" "app_user_database_url" {
  name  = "${local.ssm_prefix}/APP_USER_DATABASE_URL"
  type  = "SecureString"
  value = var.app_user_database_url
}

resource "aws_ssm_parameter" "google_client_id" {
  name  = "${local.ssm_prefix}/GOOGLE_CLIENT_ID"
  type  = "SecureString"
  value = var.google_client_id
}

resource "aws_ssm_parameter" "google_client_secret" {
  name  = "${local.ssm_prefix}/GOOGLE_CLIENT_SECRET"
  type  = "SecureString"
  value = var.google_client_secret
}

resource "aws_ssm_parameter" "oauth_state_secret" {
  name  = "${local.ssm_prefix}/OAUTH_STATE_SECRET"
  type  = "SecureString"
  value = var.oauth_state_secret
}

resource "aws_ssm_parameter" "token_encryption_key" {
  name  = "${local.ssm_prefix}/TOKEN_ENCRYPTION_KEY"
  type  = "SecureString"
  value = var.token_encryption_key
}

resource "aws_ssm_parameter" "app_service_database_url" {
  name  = "${local.ssm_prefix}/APP_SERVICE_DATABASE_URL"
  type  = "SecureString"
  value = var.app_service_database_url
}


# Not created at all when empty, and NOT wired into the worker's secrets block
# (ecs.tf) in that case — apps/worker/src/insights.ts's insightsEnabled() is
# `Boolean(process.env.ANTHROPIC_API_KEY)`, which is true for a whitespace
# placeholder too. The only value that reproduces the documented "unset ->
# insights disabled, analyses still score" behavior (apps/worker/.env.example)
# is the variable being genuinely absent from the container's environment.
resource "aws_ssm_parameter" "anthropic_api_key" {
  count = var.anthropic_api_key != "" ? 1 : 0

  name  = "${local.ssm_prefix}/ANTHROPIC_API_KEY"
  type  = "SecureString"
  value = var.anthropic_api_key
}
