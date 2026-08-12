# One execution role for both services — it's what ECS itself uses to pull
# the image, write logs, and resolve `secrets` at task launch; it's never
# assumed by application code. No separate task role: neither apps/api nor
# apps/worker calls an AWS API directly (Supabase, Redis, and Anthropic are
# all reached over plain HTTPS/TLS with credentials of their own), so there's
# nothing for one to grant.

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.project}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# The managed policy above covers ECR pull + CloudWatch Logs, but not SSM —
# that's this stack's addition, scoped to just this project's parameter path
# and just the KMS key that encrypts them (the account's default SSM key, not
# a customer-managed one — see ssm.tf for why).

data "aws_kms_key" "ssm" {
  key_id = "alias/aws/ssm"
}

data "aws_iam_policy_document" "read_ssm" {
  statement {
    actions   = ["ssm:GetParameters"]
    resources = ["arn:aws:ssm:${var.aws_region}:*:parameter${local.ssm_prefix}/*"]
  }

  statement {
    actions   = ["kms:Decrypt"]
    resources = [data.aws_kms_key.ssm.arn]
  }
}

resource "aws_iam_role_policy" "execution_ssm" {
  name   = "${var.project}-read-ssm"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.read_ssm.json
}
