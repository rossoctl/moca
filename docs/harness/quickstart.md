---
title: Harness quickstart
sidebar_label: Quickstart
sidebar_position: 1
description: Run the moca harness on your laptop with Docker Compose, send a turn, resume the session and stream a reply, in about five minutes.
doc_type: tutorial
audience: [harness-user, evaluator]
capability: harness
---

# Harness quickstart

In this quickstart you run the moca harness on your own machine, without root. It starts these
services:

- the **supervisor** and its pool of warm workers, where the agent runs;
- the **sandbox relay**;
- one **sandbox** container, where the agent's commands run;
- **Redis**, where sessions are stored.

Then you send the agent a turn, resume the session, and stream a reply.

> **Trial, not production.** The Docker Compose path is a trial by design and will not be promoted
> to Stable. When you are ready to deploy, see [Deploy and operate](../operate/index.md).

## Before you start

You need:

- **Docker** (or podman's `docker` CLI) with Compose (`docker compose` or `docker-compose`);
- `curl`;
- a model credential. This page uses an Anthropic API key.

## 1. Start the harness

```bash
curl -fsSL https://raw.githubusercontent.com/rossoctl/moca/main/deploy/compose/install.sh \
  | ANTHROPIC_API_KEY=sk-ant-... sh
```

The installer does four things:

1. It fetches `docker-compose.yml` into `~/.serverless-harness`. To use another directory, set
   `SH_COMPOSE_DIR`.
2. Once, it writes `~/.serverless-harness/.env` (mode 0600) with the relay tokens it generates and
   the model variables from your shell. A re-run never overwrites this file.
3. It pulls the images. If it can't reach the registry, it starts nothing.
4. It runs `docker compose up -d`.

The data plane listens on `http://127.0.0.1:8080`. Redis and the relay aren't published to your
host.

By default it accepts unauthenticated calls (`SH_REQUIRE_AUTH=false`), so a plain `curl` works.
Adding the control plane for `mocactl` does not close that: the operator's model credential still
serves an unauthenticated `curl /turn` unless you set `SH_REQUIRE_AUTH=true` in `.env`. What changes
is that a present but invalid token is refused.

## 2. Send a turn

```bash
curl -s -H 'Content-Type: application/json' \
  -d '{"prompt":"Remember the word pineapple, then run uname -a and tell me the kernel."}' \
  http://127.0.0.1:8080/turn
```

The reply is JSON with `response`, `stopReason`, `usage` and `sessionId`. The `uname` command ran
in the **sandbox container**, not in the worker that runs the agent. This split is moca's
"[brain and hands](concepts/brain-and-hands.md)". Copy the `sessionId`.

## 3. Resume the session

The session's history is stored in Redis, so a new request with the same id continues it:

```bash
curl -s -H 'Content-Type: application/json' \
  -d '{"sessionId":"<the id>","prompt":"What word did I ask you to remember?"}' \
  http://127.0.0.1:8080/turn
```

If you name a session that doesn't exist, the call returns 404 `session_not_found`. To start a new
session, omit `sessionId`.

## 4. Stream a turn

Ask for server-sent events:

```bash
curl -N -H 'Content-Type: application/json' -H 'Accept: text/event-stream' \
  -d '{"sessionId":"<the id>","prompt":"Count to five slowly."}' \
  http://127.0.0.1:8080/turn
```

You get these frames:

- `event: text` frames, each with a `delta`;
- `tool_use` and `tool_result` frames when the agent runs a command;
- a final `event: done`.

## 5. Watch it, then stop it

```bash
cd ~/.serverless-harness && docker compose logs -f     # watch it
cd ~/.serverless-harness && docker compose down        # stop it
```

Redis keeps sessions on the `moca-redis` named volume, with AOF on. `docker compose down` followed
by `up` keeps your sessions. `docker compose down -v` removes the volumes and starts clean.

## Optional: use mocactl instead of curl

`mocactl` talks to the harness through its **control plane**, which adds GitHub login and
per-user sessions and credentials. To add the control plane to this trial:

1. Create a GitHub OAuth app with **Enable Device Flow** ticked. It doesn't need a client secret.
2. Re-run the installer with the app's client ID:

```bash
curl -fsSL https://raw.githubusercontent.com/rossoctl/moca/main/deploy/compose/install.sh \
  | SH_GITHUB_CLIENT_ID=Ov23li... sh

mocactl --control-plane-url http://127.0.0.1:8090 login
mocactl --control-plane-url http://127.0.0.1:8090 doctor
mocactl --control-plane-url http://127.0.0.1:8090 run "hello"
```

The control plane is the only URL you give `mocactl`. It advertises the harness through
`GET /v1/discovery`.

When you first log in, `mocactl` asks for your own inference credential. The harness sends that
credential to the model endpoint as `Authorization: Bearer`, so it must be a gateway token or
another token that the endpoint accepts as a Bearer token. To install `mocactl` itself, see
[Get started](../get-started/index.md#install-the-client).

## What you just did

- A **supervisor** handed your HTTP connection to a **warm worker**: no cold start.
- The worker ran the agent loop and stored the session in **Redis**.
- The agent's command went through the **relay** to a remote **sandbox**.

The same processes run on a single VM and on Kubernetes. Only the process manager and the
isolation differ.

## Next

- **Do more:** [Set up mocactl against the Compose trial](how-to/set-up-mocactl.md),
  [Use mocactl](how-to/use-mocactl.md), [dispatch over the HTTP API](reference/http-api.md).
- **Understand:** [Sessions and turns](concepts/sessions-and-turns.md),
  [Session multiplexing](concepts/session-multiplexing.md).
- **Look up:** [HTTP API](reference/http-api.md), [mocactl](reference/cli-mocactl.md).
