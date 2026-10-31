-- Runs once, on first start with an empty data volume (`pnpm infra:reset` to re-run).
-- Integration tests use a separate database so they never touch dev data.
CREATE DATABASE app_test OWNER app;
