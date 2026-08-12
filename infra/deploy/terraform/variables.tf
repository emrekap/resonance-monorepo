variable "aws_region" {
  description = "AWS region for every resource in this stack."
  type        = string
  default     = "eu-west-1"
}

variable "project" {
  description = "Name prefix for every resource (ECR repos, cluster, log groups, SSM path)."
  type        = string
  default     = "resonance"
}

variable "environment" {
  description = "Tag value only — this stack is not parameterized per-environment (single demo env)."
  type        = string
  default     = "demo"
}

# --- Task sizing --------------------------------------------------------------
# 0.25 vCPU / 0.5 GB is Fargate's smallest tier and the cheapest per-second
# rate. Both apps are I/O-bound (see CLAUDE.md's polyglot-split rationale) so
# this is a starting point, not a measured floor — raise it if a real demo
# shows the API or worker CPU-throttling.

variable "api_cpu" {
  type    = number
  default = 256
}

variable "api_memory" {
  type    = number
  default = 512
}

variable "worker_cpu" {
  type    = number
  default = 256
}

variable "worker_memory" {
  type    = number
  default = 512
}

# --- Desired count --------------------------------------------------------
# This is the ONLY value the `make start` / `make stop` toggle (design spec
# §11) changes, and it changes it via `aws ecs update-service`, not Terraform.
# Both aws_ecs_service resources set `lifecycle { ignore_changes =
# [desired_count] }` for exactly that reason: without it, a routine `terraform
# apply` for an unrelated change (bumping api_cpu, say) would silently reset a
# service that's mid-demo back to whatever this variable says, stopping it.
# This variable only matters for the FIRST apply, before anything has toggled
# the service via the CLI.
variable "initial_desired_count" {
  description = "desired_count at first `terraform apply` only — ignored on every apply after (see lifecycle block in ecs.tf)."
  type        = number
  default     = 0
}

variable "log_retention_days" {
  type    = number
  default = 7
}

# --- apps/api configuration ----------------------------------------------
# Mirrors apps/api/.env.example. Values here are Terraform variables, not
# defaults with real values — every one below is required at apply time via
# terraform.tfvars (see terraform.tfvars.example), which is gitignored.

variable "api_port" {
  type    = number
  default = 3000
}

variable "api_public_url" {
  description = <<-EOT
    OAuth callback origin. A Fargate task's public IP changes on every
    `make start` (design spec §3/§6) — either re-derive this per demo from
    `make ip` and re-register the Google redirect URI, or point it at a
    Route 53 record if that's been set up (spec §10, not built by this stack).
  EOT
  type        = string
}

variable "redis_url" {
  description = "Render Key Value connection string (rediss://...). Shared by apps/api, apps/worker, and apps/ml (design spec §4)."
  type        = string
  sensitive   = true
}

variable "supabase_url" {
  type = string
}

variable "supabase_publishable_key" {
  description = "Public (anon) key — not a secret, but kept in SSM alongside the rest for uniformity."
  type        = string
}

variable "app_user_database_url" {
  description = "The RLS-enforced app_user role. Never the same value as app_service_database_url — see CLAUDE.md: apps/api never holds BYPASSRLS."
  type        = string
  sensitive   = true
}

variable "google_client_id" {
  type = string
}

variable "google_client_secret" {
  type      = string
  sensitive = true
}

variable "oauth_state_secret" {
  type      = string
  sensitive = true
}

variable "token_encryption_key" {
  description = "AES-256-GCM key, base64, must decode to 32 bytes (apps/api/.env.example)."
  type        = string
  sensitive   = true
}

# --- apps/worker configuration ---------------------------------------------
# Mirrors apps/worker/.env.example.

variable "app_service_database_url" {
  description = "The BYPASSRLS role. Only apps/worker ever holds this — CLAUDE.md."
  type        = string
  sensitive   = true
}

variable "anthropic_api_key" {
  description = "Optional — insights are best-effort (design spec §6). Leave empty to run without recommendations."
  type        = string
  sensitive   = true
  default     = ""
}
