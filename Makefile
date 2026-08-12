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
AWS_REGION ?= eu-west-1
PROJECT ?= resonance

# Lazily (recursively) expanded on purpose: these shell out to `terraform
# output`, which needs a prior `make tf-apply`. Because `=` (not `:=`) only
# evaluates on actual reference, targets that don't need them (redis-check,
# ml-*, help) never pay for — or require — a Terraform state to exist.
CLUSTER          = $(shell cd $(TF_DIR) && terraform output -raw ecs_cluster_name)
API_SERVICE      = $(shell cd $(TF_DIR) && terraform output -raw ecs_api_service_name)
WORKER_SERVICE   = $(shell cd $(TF_DIR) && terraform output -raw ecs_worker_service_name)
ECR_API          = $(shell cd $(TF_DIR) && terraform output -raw ecr_api_repository_url)
ECR_WORKER       = $(shell cd $(TF_DIR) && terraform output -raw ecr_worker_repository_url)
LOG_GROUP_API    = $(shell cd $(TF_DIR) && terraform output -raw cloudwatch_log_group_api)
LOG_GROUP_WORKER = $(shell cd $(TF_DIR) && terraform output -raw cloudwatch_log_group_worker)

.PHONY: help tf-init tf-plan tf-apply \
	build-api build-worker push-api push-worker deploy-api deploy-worker \
	start stop pause restart status ip logs-api logs-worker redis-check \
	ml-pause ml-restart ml-status

help:
	@echo "Terraform (one-time / rare):"
	@echo "  make tf-init tf-plan tf-apply"
	@echo ""
	@echo "Images:"
	@echo "  make build-api build-worker      docker build only"
	@echo "  make push-api push-worker        build + push to ECR"
	@echo "  make deploy-api deploy-worker    push + force a new ECS deployment"
	@echo ""
	@echo "Demo lifecycle (apps/api + apps/worker on ECS):"
	@echo "  make start                       desired_count=1 for both"
	@echo "  make stop / make pause           desired_count=0 for both (aliases)"
	@echo "  make restart                     stop then start"
	@echo "  make status                      ECS service status + HF Space status"
	@echo "  make ip                          current public IP of the running apps/api task"
	@echo "  make logs-api / make logs-worker tail CloudWatch logs"
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

# --- Images ----------------------------------------------------------------

build-api:
	docker build -f infra/deploy/api/Dockerfile -t $(PROJECT)-api:latest .

build-worker:
	docker build -f infra/deploy/worker/Dockerfile -t $(PROJECT)-worker:latest .

push-api: build-api
	registry="$${ECR_API%%/*}"; \
	aws ecr get-login-password --region $(AWS_REGION) | docker login --username AWS --password-stdin "$$registry"
	docker tag $(PROJECT)-api:latest $(ECR_API):latest
	docker push $(ECR_API):latest

push-worker: build-worker
	registry="$${ECR_WORKER%%/*}"; \
	aws ecr get-login-password --region $(AWS_REGION) | docker login --username AWS --password-stdin "$$registry"
	docker tag $(PROJECT)-worker:latest $(ECR_WORKER):latest
	docker push $(ECR_WORKER):latest

deploy-api: push-api
	aws ecs update-service --cluster $(CLUSTER) --service $(API_SERVICE) \
		--force-new-deployment --region $(AWS_REGION) >/dev/null
	@echo "apps/api: new image pushed, deployment forced."

deploy-worker: push-worker
	aws ecs update-service --cluster $(CLUSTER) --service $(WORKER_SERVICE) \
		--force-new-deployment --region $(AWS_REGION) >/dev/null
	@echo "apps/worker: new image pushed, deployment forced."

# --- Demo lifecycle ----------------------------------------------------------

start:
	aws ecs update-service --cluster $(CLUSTER) --service $(API_SERVICE) \
		--desired-count 1 --region $(AWS_REGION) >/dev/null
	aws ecs update-service --cluster $(CLUSTER) --service $(WORKER_SERVICE) \
		--desired-count 1 --region $(AWS_REGION) >/dev/null
	@echo "Starting apps/api + apps/worker. 'make status' to watch, 'make ip' once RUNNING."

stop pause:
	aws ecs update-service --cluster $(CLUSTER) --service $(API_SERVICE) \
		--desired-count 0 --region $(AWS_REGION) >/dev/null
	aws ecs update-service --cluster $(CLUSTER) --service $(WORKER_SERVICE) \
		--desired-count 0 --region $(AWS_REGION) >/dev/null
	@echo "Stopped apps/api + apps/worker (desired_count=0)."

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
