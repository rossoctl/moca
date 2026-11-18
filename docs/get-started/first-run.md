# First run

> **Preview.** Uses the Docker Compose trial path. The commands below are assembled from the
> [Compose README](../../deploy/compose/README.md) and the [HTTP API guide](../reference/http-api.md);
> I have not run them end to end. It is not for production.

You will start the P6 runtime on one machine, send a turn, resume the same session in a second
request, and watch a streamed turn.

## Before you start

Docker with Compose, `curl`, and a model credential (see the
[deployment chooser](../operate/index.md#choose-a-deployment)). Install and start the stack as in the
[harness quickstart](../harness/quickstart.md):

```bash
curl -fsSL https://raw.githubusercontent.com/rossoctl/moca/main/deploy/compose/install.sh \
  | ANTHROPIC_API_KEY=sk-ant-... sh
```

By default the data plane accepts unauthenticated calls on `127.0.0.1:8080` (`SH_REQUIRE_AUTH=false`),
so a plain `curl` works. Adding the control plane for `mocactl` does not close that: the operator's model
credential still serves unauthenticated `curl /turn` unless you set `SH_REQUIRE_AUTH=true` in `.env`. What
changes is that a present but invalid token is refused. See
[Using mocactl](../../deploy/compose/README.md#using-mocactl-the-control-plane).

## 1. Send a turn

```bash
curl -s -H 'Content-Type: application/json' \
  -d '{"prompt":"Remember the word pineapple, then run uname -a and tell me the kernel."}' \
  http://127.0.0.1:8080/turn
```

The reply is JSON with a `response`, a `stopReason`, `usage` and a `sessionId`. The agent's `uname`
ran in the sandbox container, not in the worker: that is the brain/hands split in action. Copy the
`sessionId`.

## 2. Resume the session

Send the id back. The session's history is in Redis, so a new request continues it:

```bash
curl -s -H 'Content-Type: application/json' \
  -d '{"sessionId":"<the id>","prompt":"What word did I ask you to remember?"}' \
  http://127.0.0.1:8080/turn
```

An anonymous call that names a session that does not exist returns 404 `session_not_found`; omit
`sessionId` to start a new one.

To prove the state does not live in the worker, restart the supervisor and ask again:

```bash
cd ~/.serverless-harness && docker compose restart supervisor
```

## 3. Stream a turn

Ask for server-sent events:

```bash
curl -N -H 'Content-Type: application/json' -H 'Accept: text/event-stream' \
  -d '{"sessionId":"<the id>","prompt":"Count to five slowly."}' \
  http://127.0.0.1:8080/turn
```

You will see `event: text` frames with a `delta`, `tool_use` and `tool_result` frames if the agent runs
a command, and a final `event: done`. The frames are listed in
[Streaming frames](../reference/http-api.md#streaming-frames).

## 4. Watch it, then stop it

```bash
cd ~/.serverless-harness && docker compose logs -f
cd ~/.serverless-harness && docker compose down     # sessions survive; `down -v` removes them
```

## Where next

- Use the terminal client against a control plane:
  [`mocactl`](../reference/cli-mocactl.md).
- Run a leaf with a human approval gate: [Leaf envelope and result](../reference/leaf-and-envelope.md#the-human-gate).
  Async fan-out runs on P6, opt-in ([dispatch archetypes](../concepts/dispatch-archetypes.md));
  scheduled dispatch has no P6 design yet ([#536](https://github.com/rossoctl/moca/issues/536)).
- A longer guided tour on a VM: [`demos/vm-multi-user-demo.md`](../demos/vm-multi-user-demo.md).
