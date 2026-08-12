# Local state by default — this is a single-operator demo environment (see
# ../README.md). Uncomment + fill in a `backend "s3"` block below (and run
# `terraform init -migrate-state`) before more than one person touches this,
# or before running `terraform apply` from CI.
#
# terraform {
#   backend "s3" {
#     bucket       = "resonance-terraform-state"
#     key          = "deploy-api-worker/terraform.tfstate"
#     region       = "eu-south-2"
#     use_lockfile = true
#   }
# }

terraform {
  required_version = ">= 1.8"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.project
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
