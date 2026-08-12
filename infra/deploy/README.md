# infra/deploy

Deploys `apps/api` and `apps/worker` to AWS ECS Fargate, provisioned with Terraform. `apps/ml` is
out of scope here — it deploys separately to a Hugging Face Space (`apps/ml/manage_space.py`).

Full design rationale: [`docs/superpowers/specs/2026-08-09-deploy-api-worker-design.md`](../../docs/superpowers/specs/2026-08-09-deploy-api-worker-design.md).
Short version: this app runs **on demand** (investor demos), not continuously — everything here is
built around `desired_count` going to 0 between demos and back to 1 for one, at near-zero idle cost.

## Layout

```
infra/deploy/
  api/Dockerfile        apps/api image (multi-stage, turbo prune — see its comments)
  worker/Dockerfile     apps/worker image (mirrors api/Dockerfile)
  terraform/            ECS cluster, ECR repos, task defs, IAM, SSM params, security group
```

## One-time setup

1. `aws configure` (or an equivalent credentials source) — needs permissions for ECS, ECR, IAM, SSM,
   CloudWatch Logs, and EC2 (security groups + reading the default VPC). The exact policy this
   project needs is `infra/deploy/terraform/local-aws-cli-policy.json`; sync it to the IAM user with
   `make iam-push-policy` (see the optional admin-profile step below).
   - **Optional:** `make iam-push-policy` writes an IAM policy, which the deploy user itself is
     deliberately *not* permitted to do to itself (no `iam:PutUserPolicy` on its own ARN — that would
     be a self-privilege-escalation path). To use that target, configure a second, admin-capable
     profile once:

     ```bash
     aws configure --profile admin-profile   # access key from an IAM user with, e.g., AdministratorAccess
     aws sts get-caller-identity --profile admin-profile   # confirm it's the admin user, not the deploy one
     AWS_PROFILE=admin-profile make iam-push-policy
     ```

     Without this, apply `local-aws-cli-policy.json` by hand in the IAM console instead.
2. `cp infra/deploy/terraform/terraform.tfvars.example infra/deploy/terraform/terraform.tfvars` and
   fill in real values (never commit this file — it's gitignored).
3. `make tf-init && make tf-plan` to review, then `make tf-apply` to provision the cluster, ECR
   repos, IAM role, security group, and SSM parameters. This is a one-time (or rarely-repeated) step
   — the demo start/stop toggle below never touches Terraform (see the design spec §11 for why).
4. `make build-api build-worker push-api push-worker` — first image push, since the ECS services
   were created above pointing at a `:latest` tag that doesn't exist yet.
5. `make start`, wait ~30-60s for tasks to reach RUNNING, `make ip`, `curl $(make ip)/health`.

## Demo-day runbook

```bash
make ml-restart start   # unpause the HF Space's GPU + bring api/worker up
make ip                 # get the API's current public IP
# ... run the demo ...
make ml-pause stop       # pause the Space's GPU meter + bring api/worker down
```

`start`/`stop` deliberately don't touch `apps/ml` automatically — the Space has its own GPU billing
clock (hourly, not per-second) and its own pre-existing lifecycle tool
(`apps/ml/manage_space.py`), so pairing them is a runbook step, not a hidden side effect of one
Makefile target.

## After a code change

```bash
make deploy-api      # build, push, force a new ECS deployment
make deploy-worker
```

## Redeploying infra changes

```bash
make tf-plan   # review
make tf-apply
```

Safe to run any time, including while a demo is in progress — `desired_count` is excluded from what
Terraform manages after the first apply (`lifecycle { ignore_changes = [desired_count] }` in
`ecs.tf`), so an unrelated infra change (bumping `api_cpu`, say) never silently stops a running
demo.

## What this does NOT do

See the design spec §9 and §10. In short: no CD, no stable domain (a Fargate task's public IP is new
every `make start` — `make ip` prints the current one), no autoscaling, and `noeviction` on the
Render Redis instance is a must-check, not an assumption (`make redis-check`).
