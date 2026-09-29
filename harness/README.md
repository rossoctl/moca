# @moca/harness

Serverless-harness glue: adapts the generic `@moca/session-backend` log store to Pi's
`SessionStorageBackend`, with write-behind durability.

## Components

- `BufferedRedisBackend` — write-behind decorator (queue + `flush()`); implements Pi's
  `SessionStorageBackend` over a `LogStore` (`RedisSessionBackend`).
- `flushExtension` — flushes at `turn_end` and `session_shutdown`.
- `cli.ts` — headless one-shot smoke entry (resume via `PI_SESSION_ID`).

## Prerequisites

The `pi-fork` workspace packages must be built before the harness can import the
compiled `@earendil-works/pi-coding-agent` (and `@earendil-works/pi-ai`). Build them in
dependency order:

```bash
for p in ai agent tui coding-agent; do pnpm -C pi-fork/packages/$p build; done
```

## Tests

- `pnpm -C harness test` — decorator units + the SessionManager↔Redis integration test
  (needs Redis at `REDIS_URL`, default `redis://127.0.0.1:6379`).

## Headless smoke

- `pnpm -C harness exec tsx src/cli.ts "<prompt>"` runs one turn; set `PI_SESSION_ID` to
  resume an existing session from Redis. Requires a model credential.
- Gateway: pinned Pi reads `ANTHROPIC_API_KEY` and a fixed base URL. `cli.ts` includes an
  env-gated bridge so a Bearer-token gateway works via `ANTHROPIC_BASE_URL` +
  `ANTHROPIC_AUTH_TOKEN` (base URL is overridden and auth is sent as `Authorization: Bearer`).

## Dependency direction

`harness → { pi-fork, @moca/session-backend }`. Pi core never imports Redis or
`@moca/session-backend`.
