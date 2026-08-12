# No VPC, no NAT Gateway, no ALB — deliberately (design spec §3). The default
# VPC's subnets already route to an Internet Gateway (free), so a Fargate task
# with a public IP reaches Render Redis / Supabase / Anthropic outbound with
# no NAT in between. A NAT Gateway or ALB would each add a fixed ~$16-32/month
# charge that runs whether or not the app is up, defeating the entire premise
# of this stack (pay only while a demo is actually running).

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

# One security group for both services. `apps/api` needs inbound 3000 to be
# reachable at all (there is no ALB in front of it); `apps/worker` needs no
# inbound rule and gets none — CLAUDE.md's "apps/api never holds BYPASSRLS"
# rule becomes a property of the deployment because the worker's task has no
# listening port for anything to reach.
#
# Inbound 3000 open to 0.0.0.0/0 is intentional for a demo-only box, not an
# oversight: the mitigating control is that the task normally does not exist
# (desired_count=0). Narrow this to a known IP range if that stops being true.
resource "aws_security_group" "app" {
  name        = "${var.project}-app"
  description = "apps/api inbound (3000) + unrestricted outbound for both services"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "apps/api HTTP"
    from_port   = var.api_port
    to_port     = var.api_port
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "Supabase, Render Redis, Anthropic - all outbound over the internet"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.project}-app"
  }
}
