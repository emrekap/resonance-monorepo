data "aws_region" "current" {}

# Fargate cluster: no EC2 capacity provider, so the cluster itself has no
# per-hour charge — you only ever pay for the vCPU/GB-seconds a running task
# actually consumes (design spec §3).
resource "aws_ecs_cluster" "this" {
  name = var.project

  setting {
    name  = "containerInsights"
    value = "disabled" # opt-in cost; not needed for a demo-only box
  }
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${var.project}/api"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/ecs/${var.project}/worker"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "poller" {
  name              = "/ecs/${var.project}/poller"
  retention_in_days = var.log_retention_days
}

# --- apps/api ------------------------------------------------------------

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.project}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.api_cpu
  memory                   = var.api_memory
  execution_role_arn       = aws_iam_role.execution.arn

  # Must be stated explicitly. Omitting this block does not mean "match the
  # image" — it means X86_64, and an arm64 image then dies on "exec format
  # error" with exit 255 before any app code runs. ARM64 (Graviton) is chosen
  # over X86_64 because it is ~20% cheaper for identical vCPU/GB, and because
  # the images are built on an Apple Silicon host, so building for it needs no
  # QEMU emulation and no cross-arch `bun install` (see the Dockerfile's pruner
  # comment on why arch has to be uniform there).
  #
  # Coupled to infra/deploy/api/Dockerfile + the Makefile's build-api: changing
  # any one of the three requires changing all three, and the matching image
  # must be pushed BEFORE this is applied.
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([
    {
      name      = "api"
      image     = "${aws_ecr_repository.api.repository_url}:latest"
      essential = true

      portMappings = [
        { containerPort = var.api_port, protocol = "tcp" }
      ]

      # Non-secret config only. Everything credential-shaped is in `secrets`,
      # resolved from SSM at launch — never a plain env var (design spec §6).
      environment = [
        { name = "PORT", value = tostring(var.api_port) },
        { name = "API_PUBLIC_URL", value = var.api_public_url },
      ]

      secrets = [
        { name = "REDIS_URL", valueFrom = aws_ssm_parameter.redis_url.arn },
        { name = "SUPABASE_URL", valueFrom = aws_ssm_parameter.supabase_url.arn },
        { name = "SUPABASE_PUBLISHABLE_KEY", valueFrom = aws_ssm_parameter.supabase_publishable_key.arn },
        { name = "APP_USER_DATABASE_URL", valueFrom = aws_ssm_parameter.app_user_database_url.arn },
        { name = "GOOGLE_CLIENT_ID", valueFrom = aws_ssm_parameter.google_client_id.arn },
        { name = "GOOGLE_CLIENT_SECRET", valueFrom = aws_ssm_parameter.google_client_secret.arn },
        { name = "OAUTH_STATE_SECRET", valueFrom = aws_ssm_parameter.oauth_state_secret.arn },
        { name = "TOKEN_ENCRYPTION_KEY", valueFrom = aws_ssm_parameter.token_encryption_key.arn },
      ]

      # Proves the process is up AND that its own HTTP stack answers — not
      # just that the container hasn't exited. Still shallow (design spec
      # §7): it doesn't check Redis/Postgres/Supabase reachability.
      healthCheck = {
        command     = ["CMD-SHELL", "bun -e \"fetch('http://localhost:${var.api_port}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 10
      }

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.api.name
          "awslogs-region"        = data.aws_region.current.name
          "awslogs-stream-prefix" = "api"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "api" {
  name            = "${var.project}-api"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.initial_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = data.aws_subnets.default.ids
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = true
  }

  # See variables.tf's initial_desired_count comment: `make start`/`make stop`
  # own this value from here on, not Terraform.
  lifecycle {
    ignore_changes = [desired_count]
  }
}

# --- apps/worker -----------------------------------------------------------
# No portMappings, no healthCheck, no ingress security group rule — it has no
# HTTP surface by construction (design spec §3, §7). Its liveness signal is
# the queue depth, which this stack does not (yet) alarm on.

resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.project}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.worker_cpu
  memory                   = var.worker_memory
  execution_role_arn       = aws_iam_role.execution.arn

  # ARM64 for the same reasons as the api task definition above — see its
  # runtime_platform comment. Both services must stay on the same architecture:
  # `make push-api`/`push-worker` build from one host, so a split would mean
  # emulating one of the two images.
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  # No ephemeral_storage block: this task writes no local files, so the
  # default 20 GiB Fargate includes for free is untouched — declaring the
  # block at all raises the floor to 21 GiB for no benefit.

  container_definitions = jsonencode([
    {
      name      = "worker"
      image     = "${aws_ecr_repository.worker.repository_url}:latest"
      essential = true
      # ECS sends SIGTERM, waits stopTimeout, then SIGKILLs.
      # apps/worker/src/index.ts already drains in-flight handlers on SIGTERM
      # (design spec §2) — this just has to give it enough room to finish. 30s
      # is a starting point pending the real worst-case handler timing (design
      # spec §10, open item 3).
      stopTimeout = 30

      # ANTHROPIC_API_KEY is only appended when set (ssm.tf) — a
      # `Boolean(process.env.ANTHROPIC_API_KEY)` check in insights.ts means
      # even an empty-string env var would read as "enabled" and start
      # failing real API calls, so the variable must be genuinely absent to
      # get the documented "insights disabled, analyses still score" behavior.
      secrets = concat(
        [
          { name = "REDIS_URL", valueFrom = aws_ssm_parameter.redis_url.arn },
          { name = "APP_SERVICE_DATABASE_URL", valueFrom = aws_ssm_parameter.app_service_database_url.arn },
        ],
        var.anthropic_api_key != "" ? [
          { name = "ANTHROPIC_API_KEY", valueFrom = aws_ssm_parameter.anthropic_api_key[0].arn }
        ] : []
      )

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.worker.name
          "awslogs-region"        = data.aws_region.current.name
          "awslogs-stream-prefix" = "worker"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "worker" {
  name            = "${var.project}-worker"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = var.initial_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets = data.aws_subnets.default.ids
    # No ingress rule needed, but the task still needs the shared SG for its
    # outbound rule (Redis, Postgres, Anthropic).
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = true
  }

  lifecycle {
    ignore_changes = [desired_count]
  }
}

# --- apps/poller ------------------------------------------------------------
# The corpus collector. Like the worker: no portMappings, no healthCheck, no
# ingress rule — it holds BYPASSRLS and has no HTTP surface by construction.
#
# TWO THINGS TO KNOW BEFORE STARTING IT.
#
# 1. IT SHARES THE DEMO LIFECYCLE. `make start` / `make stop` toggle this
#    service alongside api and worker, so it polls only on the days the demo
#    stack is up. That is a deliberate choice (cost: nothing runs idle) with a
#    real cost of its own: the corpus spec's §5c cadence assumes a daily poll,
#    and a day the service was down is a hole in a time series that CANNOT be
#    backfilled — YouTube serves current counts, not historical ones. The
#    maturation parameter needs ~14 days of observations before any label
#    exists, so a sparsely-run poller lengthens that wall-clock considerably.
#    Moving it to always-on later is a one-line change: drop it from the
#    Makefile's start/stop targets and set its desired_count to 1 once.
#
# 2. IT CRASH-LOOPS UNTIL THE SEED FRAME IS CURATED. `loadSeeds()` throws at
#    boot while `apps/poller/seeds/channels.yaml` is empty, on purpose — a
#    poller running against an empty frame looks healthy in every dashboard and
#    collects nothing. Until that file has channels in it and the image has
#    been rebuilt, expect this task to restart in a loop when started.

resource "aws_ecs_task_definition" "poller" {
  family                   = "${var.project}-poller"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.poller_cpu
  memory                   = var.poller_memory
  execution_role_arn       = aws_iam_role.execution.arn

  # ARM64, matching api and worker — see the api task definition's
  # runtime_platform comment. All three build from one host, so a split
  # architecture would mean emulating one of the images.
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([
    {
      name      = "poller"
      image     = "${aws_ecr_repository.poller.repository_url}:latest"
      essential = true

      # The maximum ECS allows. A full poll is ~40 channels of sequential HTTP
      # and can outlast even this — but being SIGKILLed mid-poll is safe here,
      # which is the point of the design rather than a tolerated risk:
      # `capturedAt` is quantised to the UTC day (`resolveRunAt`) and snapshot
      # appends use `skipDuplicates` against `@@unique([postId, capturedAt])`,
      # so the next run re-does the same work under the same keys and the
      # partial write is absorbed instead of duplicated.
      stopTimeout = 120

      environment = [
        { name = "CORPUS_REPORT_DIR", value = var.corpus_report_dir },
      ]

      # Same BYPASSRLS credential as apps/worker: `corpus` tables carry RLS
      # forced with ZERO policies, so no other role can read or write them.
      secrets = [
        { name = "REDIS_URL", valueFrom = aws_ssm_parameter.redis_url.arn },
        { name = "APP_SERVICE_DATABASE_URL", valueFrom = aws_ssm_parameter.app_service_database_url.arn },
        { name = "YOUTUBE_API_KEY", valueFrom = aws_ssm_parameter.youtube_api_key.arn },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.poller.name
          "awslogs-region"        = data.aws_region.current.name
          "awslogs-stream-prefix" = "poller"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "poller" {
  name            = "${var.project}-poller"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.poller.arn
  desired_count   = var.initial_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets = data.aws_subnets.default.ids
    # Outbound only — Redis, Postgres, and googleapis.com.
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = true
  }

  lifecycle {
    ignore_changes = [desired_count]
  }
}
