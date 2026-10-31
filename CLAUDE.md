# Agent instructions

- **Before any task:** read `CONTEXT.md` fully. It is the source of truth for project state, decisions and conventions.
- Implementation follows `MASTER_IMPLEMENTATION_PROMPT.md`, one part at a time. Do only the part you are asked to execute, and follow its **Global Rules**.
- **After any task that changes code, config or decisions:** update `CONTEXT.md` (progress tracker, layout, ports, env vars, commands, data model, Redis keys, endpoints, socket events, decisions, known issues, changelog). Do this even for small fixes outside the numbered parts.
- Never commit `.env` or secrets. Never log tokens, raw IPs, device IDs or chat content.
- Quality gate before finishing: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
