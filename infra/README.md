# infra

Deployment & runtime glue.

- **Dockerfiles / compose** for each deployable (`apps/api` on cheap CPU, `apps/ml` on GPU).
- **Queue** config (Redis / BullMQ) between the Bun API and the Python worker.
- **Object storage** (S3 / R2) for video files.
- Deploy targets, env, and CI.

Reuse the CUDA Dockerfile from the existing `../../tribev2-api` for `apps/ml`.

_Scaffold placeholder._
