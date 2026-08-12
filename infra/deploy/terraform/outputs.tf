output "ecr_api_repository_url" {
  value = aws_ecr_repository.api.repository_url
}

output "ecr_worker_repository_url" {
  value = aws_ecr_repository.worker.repository_url
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "ecs_api_service_name" {
  value = aws_ecs_service.api.name
}

output "ecs_worker_service_name" {
  value = aws_ecs_service.worker.name
}

output "cloudwatch_log_group_api" {
  value = aws_cloudwatch_log_group.api.name
}

output "cloudwatch_log_group_worker" {
  value = aws_cloudwatch_log_group.worker.name
}

output "aws_region" {
  value = var.aws_region
}
