# Three private repos — ECS pulls from here, not Docker Hub. `make push-api` /
# `make push-worker` / `make push-poller` push to these; see outputs.tf for the
# URLs the Makefile reads.

resource "aws_ecr_repository" "api" {
  name                 = "${var.project}-api"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_repository" "worker" {
  name                 = "${var.project}-worker"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

# The corpus poller. Its image carries `apps/poller/seeds/channels.yaml`, so
# re-curating the sampling frame means a new image here — see
# infra/deploy/poller/Dockerfile's note on the frame.
resource "aws_ecr_repository" "poller" {
  name                 = "${var.project}-poller"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

# Cost/clutter hygiene, not correctness: every `make deploy-*` pushes a new
# `:latest`, and untagged images (the previous `:latest` manifest, once
# superseded) would otherwise accumulate forever at ~$0.10/GB-month each.
locals {
  expire_untagged_policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Expire untagged images after 7 days"
      selection = {
        tagStatus   = "untagged"
        countType   = "sinceImagePushed"
        countUnit   = "days"
        countNumber = 7
      }
      action = {
        type = "expire"
      }
    }]
  })
}

resource "aws_ecr_lifecycle_policy" "api" {
  repository = aws_ecr_repository.api.name
  policy     = local.expire_untagged_policy
}

resource "aws_ecr_lifecycle_policy" "worker" {
  repository = aws_ecr_repository.worker.name
  policy     = local.expire_untagged_policy
}

resource "aws_ecr_lifecycle_policy" "poller" {
  repository = aws_ecr_repository.poller.name
  policy     = local.expire_untagged_policy
}
