#!/bin/sh
# One-shot bucket bootstrap. Idempotent: safe to run on every `pnpm infra:up`.
set -eu

mc alias set local "http://minio:9000" "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null

mc mb --ignore-existing "local/$S3_BUCKET_EVIDENCE"
mc mb --ignore-existing "local/$S3_BUCKET_FRAMES"

# Moderation frames are temporary by design. `import` replaces the bucket's whole
# lifecycle config, so re-running never stacks duplicate rules.
mc ilm rule import "local/$S3_BUCKET_FRAMES" < /frames-lifecycle.json

mc ls local
