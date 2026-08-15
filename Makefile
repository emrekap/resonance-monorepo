# Lifecycle for the AWS-deployed services: apps/api + apps/worker (ECS
# Fargate, Terraform-provisioned) and apps/ml (HF Space, its own
# manage_space.py). Design rationale:
# docs/superpowers/specs/2026-08-09-deploy-api-worker-design.md §11.
#
# This is the CLOUD lifecycle only. Local dev is unchanged and lives where it
# always has: `bun run docker:local` (Redis) + `bun run dev` in each app
# (infra/README.md) — this file does not duplicate that.
#
# `start`/`stop` never touch Terraform (see tf-apply below) — they are pure
# `aws ecs update-service --desired-count` calls, so toggling for a demo can
# never accidentally apply an unrelated pending infra change.

SHELL := /bin/bash
.DEFAULT_GOAL := help

TF_DIR := infra/deploy/terraform
AWS_REGION ?= eu-south-2
PROJECT ?= resonance
IAM_USER ?= Local-aws-cli
IAM_POLICY_NAME ?= terraform-deploy
IAM_POLICY_FILE := $(TF_DIR)/local-aws-cli-policy.json

# Lazily (recursively) expanded on purpose: these shell out to `terraform
# output`, which needs a prior `make tf-apply`. Because `=` (not `:=`) only
# evaluates on actual reference, targets that don't need them (redis-check,
# ml-*, help) never pay for — or require — a Terraform state to exist.
CLUSTER          = $(shell cd $(TF_DIR) && terraform output -raw ecs_cluster_name)
API_SERVICE      = $(shell cd $(TF_DIR) && terraform output -raw ecs_api_service_name)
WORKER_SERVICE   = $(shell cd $(TF_DIR) && terraform output -raw ecs_worker_service_name)
POLLER_SERVICE   = $(shell cd $(TF_DIR) && terraform output -raw ecs_poller_service_name)
ECR_API          = $(shell cd $(TF_DIR) && terraform output -raw ecr_api_repository_url)
ECR_WORKER       = $(shell cd $(TF_DIR) && terraform output -raw ecr_worker_repository_url)
ECR_POLLER       = $(shell cd $(TF_DIR) && terraform output -raw ecr_poller_repository_url)
LOG_GROUP_API    = $(shell cd $(TF_DIR) && terraform output -raw cloudwatch_log_group_api)
LOG_GROUP_WORKER = $(shell cd $(TF_DIR) && terraform output -raw cloudwatch_log_group_worker)
LOG_GROUP_POLLER = $(shell cd $(TF_DIR) && terraform output -raw cloudwatch_log_group_poller)

.PHONY: help tf-init tf-plan tf-apply iam-push-policy \
	build-api build-worker build-poller push-api push-worker push-poller \
	deploy-api deploy-worker deploy-poller \
	start stop pause restart status ip logs-api logs-worker logs-poller \
	redis-check ml-pause ml-restart ml-status

help:
	@echo "Terraform (one-time / rare):"
	@echo "  make tf-init tf-plan tf-apply"
	@echo "  make iam-push-policy             sync $(IAM_POLICY_FILE) to the $(IAM_USER) inline policy"
	@echo ""
	@echo "Images:"
	@echo "  make build-api build-worker build-poller     docker build only"
	@echo "  make push-api push-worker push-poller        build + push to ECR"
	@echo "  make deploy-api deploy-worker deploy-poller  push + force a new ECS deployment"
	@echo ""
	@echo "Demo lifecycle (apps/api + apps/worker + apps/poller on ECS):"
	@echo "  make start                       desired_count=1 for all three"
	@echo "  make stop / make pause           desired_count=0 for all three (aliases)"
	@echo "  make restart                     stop then start"
	@echo "  make status                      ECS service status + HF Space status"
	@echo "  make ip                          current public IP of the running apps/api task"
	@echo "  make logs-api / logs-worker / logs-poller    tail CloudWatch logs"
	@echo ""
	@echo "  NOTE: apps/poller shares this lifecycle, so it polls only while the"
	@echo "        stack is up — a day it was down is a gap in the corpus time"
	@echo "        series that cannot be backfilled (see ecs.tf). It also"
	@echo "        crash-loops until apps/poller/seeds/channels.yaml is curated."
	@echo ""
	@echo "Redis (design spec §4):"
	@echo "  make redis-check                 confirm noeviction (needs REDIS_URL env)"
	@echo ""
	@echo "apps/ml (HF Space — wraps apps/ml/manage_space.py):"
	@echo "  make ml-pause / make ml-restart / make ml-status"
	@echo ""
	@echo "Demo-day runbook:  make ml-restart start   ...   make ml-pause stop"

# --- Terraform -----------------------------------------------------------

tf-init:
	cd $(TF_DIR) && terraform init

tf-plan:
	cd $(TF_DIR) && terraform plan

tf-apply:
	cd $(TF_DIR) && terraform apply

# Local-aws-cli has no iam:PutUserPolicy on itself (deliberately — it's a
# deploy credential, not an IAM admin one), so this needs to run under a
# profile/role that can manage IAM, e.g.:
#   AWS_PROFILE=admin-profile make iam-push-policy
#
# A customer-managed policy, not `put-user-policy` — inline user policies cap
# at 2048 bytes, which this policy outgrew. Managed policies allow 6144 and
# are versioned, so an update = new version + prune old ones (max 5 kept).
iam-push-policy:
	@aws iam delete-user-policy --user-name $(IAM_USER) --policy-name $(IAM_POLICY_NAME) 2>/dev/null; \
	arn=$$(aws iam list-policies --scope Local --query "Policies[?PolicyName=='$(IAM_POLICY_NAME)'].Arn | [0]" --output text); \
	if [ -z "$$arn" ] || [ "$$arn" = "None" ]; then \
		arn=$$(aws iam create-policy --policy-name $(IAM_POLICY_NAME) \
			--policy-document file://$(IAM_POLICY_FILE) --query 'Policy.Arn' --output text); \
		echo "Created managed policy $$arn"; \
	else \
		for v in $$(aws iam list-policy-versions --policy-arn "$$arn" \
			--query 'Versions[?IsDefaultVersion==`false`].VersionId' --output text); do \
			aws iam delete-policy-version --policy-arn "$$arn" --version-id "$$v"; \
		done; \
		aws iam create-policy-version --policy-arn "$$arn" --set-as-default \
			--policy-document file://$(IAM_POLICY_FILE); \
		echo "Updated managed policy $$arn"; \
	fi; \
	aws iam attach-user-policy --user-name $(IAM_USER) --policy-arn "$$arn"
	@echo "Synced $(IAM_POLICY_FILE) -> managed policy '$(IAM_POLICY_NAME)', attached to $(IAM_USER)."

# --- Images ----------------------------------------------------------------

# No --platform flag, deliberately. Both task definitions in ecs.tf pin
# runtime_platform.cpu_architecture = ARM64 (Graviton), which matches the arm64
# these images build as natively on an Apple Silicon host — so nothing is
# emulated and the arch is identical on both sides of the push. Beyond build
# speed that buys two things: Graviton Fargate is ~20% cheaper than X86_64, and
# no cross-arch step remains where `bun install` could resolve the wrong
# arch-gated binary (bullmq -> msgpackr -> @msgpackr-extract/*-linux-<arch>).
#
# If --platform ever comes back, ecs.tf must change in the same commit, and the
# new image must be pushed BEFORE `terraform apply`: a task definition whose
# arch disagrees with its image dies on "exec format error" before any app code
# runs, which is silent in ECS terms — the task just exits 255 in a loop.
build-api:
	docker build -f infra/deploy/api/Dockerfile -t $(PROJECT)-api:latest .

build-worker:
	docker build -f infra/deploy/worker/Dockerfile -t $(PROJECT)-worker:latest .

# The seed frame ships inside this image, so re-curating
# apps/poller/seeds/channels.yaml means rebuilding and redeploying — it is not
# a config change (infra/deploy/poller/Dockerfile).
build-poller:
	docker build -f infra/deploy/poller/Dockerfile -t $(PROJECT)-poller:latest .

push-api: build-api
	registry="$(ECR_API)"; registry="$${registry%%/*}"; \
	aws ecr get-login-password --region $(AWS_REGION) | docker login --username AWS --password-stdin "$$registry"
	docker tag $(PROJECT)-api:latest $(ECR_API):latest
	docker push $(ECR_API):latest

push-worker: build-worker
	registry="$(ECR_WORKER)"; registry="$${registry%%/*}"; \
	aws ecr get-login-password --region $(AWS_REGION) | docker login --username AWS --password-stdin "$$registry"
	docker tag $(PROJECT)-worker:latest $(ECR_WORKER):latest
	docker push $(ECR_WORKER):latest

push-poller: build-poller
	registry="$(ECR_POLLER)"; registry="$${registry%%/*}"; \
	aws ecr get-login-password --region $(AWS_REGION) | docker login --username AWS --password-stdin "$$registry"
	docker tag $(PROJECT)-poller:latest $(ECR_POLLER):latest
	docker push $(ECR_POLLER):latest

deploy-api: push-api
	aws ecs update-service --cluster $(CLUSTER) --service $(API_SERVICE) \
		--force-new-deployment --region $(AWS_REGION) >/dev/null
	@echo "apps/api: new image pushed, deployment forced."

deploy-worker: push-worker
	aws ecs update-service --cluster $(CLUSTER) --service $(WORKER_SERVICE) \
		--force-new-deployment --region $(AWS_REGION) >/dev/null
	@echo "apps/worker: new image pushed, deployment forced."

deploy-poller: push-poller
	aws ecs update-service --cluster $(CLUSTER) --service $(POLLER_SERVICE) \
		--force-new-deployment --region $(AWS_REGION) >/dev/null
	@echo "apps/poller: new image pushed, deployment forced."

# --- Demo lifecycle ----------------------------------------------------------

# apps/poller rides this toggle with the other two. That keeps idle cost at
# zero, and costs the corpus its daily cadence: the poller only polls while the
# stack is up, and a missed day is a hole in the time series that cannot be
# backfilled (ecs.tf's apps/poller comment, corpus spec §5c). If the corpus
# ever needs to collect for real, lift the poller out of these two targets and
# set its desired_count to 1 once.
start:
	aws ecs update-service --cluster $(CLUSTER) --service $(API_SERVICE) \
		--desired-count 1 --region $(AWS_REGION) >/dev/null
	aws ecs update-service --cluster $(CLUSTER) --service $(WORKER_SERVICE) \
		--desired-count 1 --region $(AWS_REGION) >/dev/null
	aws ecs update-service --cluster $(CLUSTER) --service $(POLLER_SERVICE) \
		--desired-count 1 --region $(AWS_REGION) >/dev/null
	@echo "Starting apps/api + apps/worker + apps/poller. 'make status' to watch, 'make ip' once RUNNING."

stop pause:
	aws ecs update-service --cluster $(CLUSTER) --service $(API_SERVICE) \
		--desired-count 0 --region $(AWS_REGION) >/dev/null
	aws ecs update-service --cluster $(CLUSTER) --service $(WORKER_SERVICE) \
		--desired-count 0 --region $(AWS_REGION) >/dev/null
	aws ecs update-service --cluster $(CLUSTER) --service $(POLLER_SERVICE) \
		--desired-count 0 --region $(AWS_REGION) >/dev/null
	@echo "Stopped apps/api + apps/worker + apps/poller (desired_count=0)."

restart: stop start

status:
	@echo "== apps/api =="
	@aws ecs describe-services --cluster $(CLUSTER) --services $(API_SERVICE) --region $(AWS_REGION) \
		--query 'services[0].{status:status,desired:desiredCount,running:runningCount,pending:pendingCount}' \
		--output table
	@echo "== apps/worker =="
	@aws ecs describe-services --cluster $(CLUSTER) --services $(WORKER_SERVICE) --region $(AWS_REGION) \
		--query 'services[0].{status:status,desired:desiredCount,running:runningCount,pending:pendingCount}' \
		--output table
	@echo "== apps/poller =="
	@aws ecs describe-services --cluster $(CLUSTER) --services $(POLLER_SERVICE) --region $(AWS_REGION) \
		--query 'services[0].{status:status,desired:desiredCount,running:runningCount,pending:pendingCount}' \
		--output table
	@echo "== apps/ml (HF Space) =="
	@cd apps/ml && .venv/bin/python manage_space.py status || echo "  (skipped — see apps/ml/README.md#tests for venv setup)"

# Fargate + awsvpc has no stable address without an ALB (design spec §3) — the
# task's public IP is only discoverable by walking task -> ENI -> IP.
ip:
	@task_arn=$$(aws ecs list-tasks --cluster $(CLUSTER) --service-name $(API_SERVICE) \
		--desired-status RUNNING --region $(AWS_REGION) --query 'taskArns[0]' --output text); \
	if [ -z "$$task_arn" ] || [ "$$task_arn" = "None" ]; then \
		echo "No running apps/api task. Run 'make start' first." >&2; exit 1; \
	fi; \
	eni=$$(aws ecs describe-tasks --cluster $(CLUSTER) --tasks "$$task_arn" --region $(AWS_REGION) \
		--query 'tasks[0].attachments[0].details[?name==`networkInterfaceId`].value | [0]' --output text); \
	ip=$$(aws ec2 describe-network-interfaces --network-interface-ids "$$eni" --region $(AWS_REGION) \
		--query 'NetworkInterfaces[0].Association.PublicIp' --output text); \
	echo "http://$$ip:3000"

logs-api:
	aws logs tail $(LOG_GROUP_API) --follow --region $(AWS_REGION)

logs-worker:
	aws logs tail $(LOG_GROUP_WORKER) --follow --region $(AWS_REGION)

logs-poller:
	aws logs tail $(LOG_GROUP_POLLER) --follow --region $(AWS_REGION)

# --- Redis -------------------------------------------------------------------

# noeviction must be verified, not assumed, on Render's free Key Value plan —
# its docs don't state a default (design spec §4). Reads REDIS_URL from the
# environment rather than Terraform output: this is a pre-deploy check you can
# run against any Redis, before it's ever wired into a task definition.
redis-check:
	@if [ -z "$$REDIS_URL" ]; then \
		echo "Set REDIS_URL first, e.g.: REDIS_URL=rediss://... make redis-check" >&2; exit 1; \
	fi
	redis-cli -u "$$REDIS_URL" CONFIG GET maxmemory-policy

# --- apps/ml (HF Space) -------------------------------------------------------
# Thin wrappers, not a reimplementation — apps/ml/manage_space.py already does
# this and predates this design (design spec §11).

ml-pause:
	cd apps/ml && .venv/bin/python manage_space.py pause

ml-restart:
	cd apps/ml && .venv/bin/python manage_space.py restart

ml-status:
	cd apps/ml && .venv/bin/python manage_space.py status
