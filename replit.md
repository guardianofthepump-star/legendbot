# LegendBot

A Discord bot that DMs server members a daily "gaming today?" check-in and maintains a live LFG board grouping players by game, overlapping time windows, role, and vibe.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `bots/legendbot/src/index.js` — entire bot (wizard, board, slash commands, cron)
- `bots/legendbot/data.json` — today's check-ins (auto-reset each day on the daily ping)
- `bots/legendbot/board.json` — pinned board message id + notified-sessions cache

Required env (already set as Replit Secrets): `DISCORD_TOKEN`, `GUILD_ID`, `PING_CHANNEL_ID`, `BOARD_CHANNEL_ID`, `DAILY_PING_HOUR`.

Slash commands: `/ping` (trigger daily ping), `/board` (repost board), `/reset` (clear today's data).

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
