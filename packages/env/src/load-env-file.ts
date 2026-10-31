import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseEnv } from 'node:util';

const WORKSPACE_MARKER = 'pnpm-workspace.yaml';

let rootEnvLoaded = false;

/** Walks up from `startDir` to the monorepo root (the directory holding pnpm-workspace.yaml). */
export function findWorkspaceRoot(startDir: string = process.cwd()): string | undefined {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, WORKSPACE_MARKER))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Copies dotenv-formatted `content` into `target` without overwriting keys that are
 * already set, so real environment variables (shell, CI, Docker) win over the file.
 */
export function applyEnvFileContent(
  content: string,
  target: Record<string, string | undefined>,
): void {
  const parsed = parseEnv(content) as Record<string, string | undefined>;
  for (const [key, value] of Object.entries(parsed)) {
    if (value !== undefined && target[key] === undefined) target[key] = value;
  }
}

/**
 * Loads the single root `.env` into `process.env` once per process. A missing file is
 * not an error: production and CI provide variables through the real environment.
 */
export function loadRootEnvFile(): void {
  if (rootEnvLoaded) return;
  rootEnvLoaded = true;

  const root = findWorkspaceRoot();
  if (root === undefined) return;
  const file = join(root, '.env');
  if (!existsSync(file)) return;
  applyEnvFileContent(readFileSync(file, 'utf8'), process.env);
}
