---
sidebar_position: 1
---

# `mocactl sbx` reference

Every `mocactl sbx` command, flag, environment variable and exit code, as the CLI prints them with
`mocactl sbx --help`. `mocactl sbx COMMAND --help` prints one command's entries.

The block below is generated from the CLI's source (`SBX_ABOUT` and `SBX_USAGE` in
`packages/mocactl/src/sbx/cli.ts`), and a test fails when the two disagree. To update it after
changing the help text:

```bash
UPDATE_SBX_REFERENCE=1 pnpm -C packages/mocactl exec vitest run test/sbx-reference.test.ts
```

For the commands in context, start at the [user guide](../user-guide.md).

<!-- BEGIN GENERATED: mocactl sbx --help -->

```text
An sbx sandbox is a workspace on the sandbox service, made from a template, where your coding
agent's commands run in isolated VMs. In a git repository, `mocactl sbx up` creates or reuses one,
copies the working tree into its /workspace and points Claude Code, OpenCode and IBM Bob, in this
repository, at the sandbox's tools: their reads, edits and commands then run in the sandbox
service's VMs, not on this machine (Bob's local tools stay available: it has no deny list). Your
source files stay as they are, apart from the agent configuration `up` adds. The copy is not kept
in sync: `mocactl sbx push` sends later local edits, and `mocactl sbx pull --apply` applies the
agent's edits here as a patch. /workspace is kept between commands; the sandbox ends after a period
without use (7 days by default). Without a repository, `mocactl sbx create` makes one (from the
default template, or `--template ID`), and `run` and `put` use it by ID; `proc` needs one
made with `--mode lease+processes`. (A bare `mocactl` session's tools run in a sandbox of moca's
own server, SH_CONTROL_PLANE_URL: these commands do not see it.)

usage (the sandbox service):
a repository's sandbox, in the order you use it:
  mocactl sbx login [--control-plane-url URL] [--no-browser]
                                                 log in with the GitHub device flow
                                                 (--control-plane-url: the sandbox service's URL,
                                                 remembered for later commands; in a local
                                                 terminal: copies the code, opens the browser;
                                                 --no-browser: only prints the URL and the code)
  mocactl sbx up [--template T] [--name N] [--include-secrets] [--max-push MiB] [--max-file MiB]
                 [--no-agent-config] [--cortex] [--lifetime DURATION]
                                                 in a git repository: create or reuse its sandbox,
                                                 push the working tree, bind it in .sbx/sandbox.json,
                                                 and point Claude Code, OpenCode and IBM Bob at the
                                                 sandbox's MCP tools, with their local tools denied
                                                 (Bob's cannot be: it has no deny list) (merged
                                                 into .mcp.json, .claude/settings.json,
                                                 opencode.json, .bob/settings.json, .bob/mcp.json,
                                                 CLAUDE.md, AGENTS.md; a value there that conflicts
                                                 stops up before anything is done)
                                                 (a reused sandbox with changes not yet pulled is
                                                 left unpushed, with a warning, and up exits 0)
                                                 (--template: a new sandbox's template, default
                                                 'default'; a bound sandbox of another template is
                                                 refused, an unbound one is left and a new sandbox
                                                 created; matched by bare id, so ID:TAG or
                                                 ID@BUILD never reuses one; --name: a new
                                                 sandbox's name, as sbx create's (a second live
                                                 one of the name is refused); --include-secrets:
                                                 push .env*, *.pem, *.key and id_* files too;
                                                 --max-push: refuse a tree over MiB, default 256;
                                                 --max-file: refuse a file over MiB, default 12;
                                                 --no-agent-config:
                                                 write no agent configuration, only push and bind)
                                                 (--cortex: Cortex v0.9.3+ blocks the local tools
                                                 instead of a deny list, so Claude Code loads the
                                                 project's CLAUDE.md; kept by later runs)
                                                 (--lifetime: a new sandbox ends after DURATION
                                                 (36h, 14d, 90m or seconds; at least 1 h) without
                                                 use; default: the deployment's, 7 d; at most its
                                                 maximum, 30 d by default; a reused sandbox keeps
                                                 its own)
  mocactl sbx claude [-- CLAUDE_ARGS ...]        run Claude Code on this sandbox's MCP tools, for
                                                 one run (--mcp-config + --strict-mcp-config,
                                                 nothing written, no approval asked: the first
                                                 bare claude session's approval question is why
                                                 this exists, #577; Claude Code still asks once
                                                 whether you trust the folder. The session loads
                                                 no MCP server but the sandbox's; run claude
                                                 yourself for your own servers). Its local tools
                                                 are denied (--disallowed-tools) from any
                                                 directory, except in a repo up --cortex set up,
                                                 where Cortex blocks them. Auto-memory is off
                                                 in every mode (CLAUDE_CODE_DISABLE_AUTO_MEMORY=1)
  mocactl sbx codex [-- CODEX_ARGS ...]          run Codex CLI on this sandbox's MCP tools, for one
                                                 run (-c, nothing written: Codex reads no
                                                 project-local config, so up cannot configure it).
                                                 Its shell tool is off, but unified_exec cannot be
                                                 disabled, so local execution is restricted, not
                                                 denied: use Codex's own sandbox_mode as well
  mocactl sbx mcp [--sandbox ID]                 the stdio MCP server for Claude Code / OpenCode
                                                 (--sandbox: the sandbox it serves)
  mocactl sbx run [--sandbox ID] [--timeout S] [-- CMD ...]   run CMD (or the script on stdin) in /workspace
                                                 (CMD's words are quoted, so they run exactly as typed:
                                                 for pipes, $VARS or globs use stdin or -- sh -c '...';
                                                 exit: the command's code; 124 timed out or killed;
                                                 125 sandbox failure; 75 refused before it started,
                                                 every try (retried MOCACTL_SBX_BUSY_RETRIES times,
                                                 default 4, at most 20; nothing ran); 130
                                                 interrupted; --timeout: S seconds, by default and
                                                 at most the sandbox token's lifetime minus 60 s;
                                                 --sandbox: the sandbox to run it in)
  mocactl sbx put PATH [--sandbox ID]            write stdin to PATH under /workspace
                                                 (a refusal before start: retried, 75, as run's;
                                                 --sandbox: the sandbox to write to)
  mocactl sbx pull [--apply] [-o FILE]           the sandbox's changes as a patch, on stdout or in
                                                 FILE (--apply: apply it here, then advance the
                                                 sandbox's baseline)
  mocactl sbx push [--force] [--include-secrets] [--max-push MiB] [--max-file MiB]
                                                 push the working tree again
                                                 (refused while the sandbox has changes not yet
                                                 pulled, unless --force; .env*, *.pem, *.key and
                                                 id_* stay behind unless --include-secrets;
                                                 --max-push: refuse a tree over MiB, default 256;
                                                 --max-file: refuse a file over MiB, default 12)
  mocactl sbx ls [--all] [--json]                your sandboxes (--all: everyone's; admins only)
  mocactl sbx doctor [--sandbox ID] [--json]     check login, sandbox, agent config, exec and recent
                                                 calls (exit 0 when every check passes, else 1;
                                                 --sandbox: the sandbox to check)
  mocactl sbx rm [ID] [--keep-config] [--force] [--json]
                                                 delete a sandbox (its lease ended first); for the
                                                 bound one, also take back the agent configuration
                                                 sbx up added, and .sbx/ (unless --keep-config)
                                                 (refused while the sandbox has changes not yet
                                                 pulled, unless --force, or when that cannot be
                                                 checked)
  mocactl sbx logout                             end the sandbox-service login (deletes sbx-auth.json)

a sandbox by hand: create one, its lease and processes, a direct client:
  mocactl sbx create [--template ID[:TAG|@BUILD]] [--name N] [--label k=v ...] [--seed]
                     [--mode per-exec|lease|lease+processes] [--idle-timeout S] [--lifetime DURATION]
                     [--json]
                                                 create a sandbox; prints its id; --template: its
                                                 template, at a TAG or one BUILD (default: default,
                                                 at its default tag); --name: a name sbx ls shows
                                                 (a-z, 0-9 and -, not first; at most 63; unique
                                                 among your live sandboxes); --label: a key=value
                                                 label (repeatable, at most 16);
                                                 --seed: run the served build's seed, then check
                                                 /workspace is a clean tree (its HEAD becomes the
                                                 baseline pull and rm measure changes from);
                                                 --mode (default per-exec): a lease mode keeps the
                                                 guest between commands (the deployment must allow
                                                 it; an upgrade, so only from a terminal);
                                                 --idle-timeout: the lease ends after S idle
                                                 seconds (default: the worker's);
                                                 --lifetime: the sandbox ends after DURATION (36h,
                                                 14d, 90m or seconds; at least 1 h) without use
                                                 (default: the deployment's, 7 d; at most its
                                                 maximum, 30 d by default)
  mocactl sbx get [ID] [--json]                  a sandbox's mode, epoch and idle timeout, and its
                                                 lease's state (a lease mode the worker has not
                                                 taken yet is sent again)
  mocactl sbx mode per-exec|lease|lease+processes [ID] [--idle-timeout S]
                                                 change the sandbox's mode (an upgrade only from a
                                                 terminal; --idle-timeout: the lease's S idle
                                                 seconds, kept unless given); a
                                                 worker that cannot be reached takes it at the next
                                                 command; a downgrade to per-exec ends the lease;
                                                 lease+processes to lease keeps it and stops the
                                                 tracked processes (it prints those it stopped)
  mocactl sbx reset [ID]                         end the sandbox's lease: the next command starts a
                                                 new guest (/tmp, installs outside /workspace and
                                                 background processes are gone)
  mocactl sbx proc start [--name N] [--cwd D] [ID] -- CMD ...
                                                 start CMD as a tracked process, which outlives the
                                                 command (lease+processes only; CMD quoted as run's;
                                                 --cwd: D, inside /workspace; --name: N, unique
                                                 among the running ones); prints its id, name and pid
  mocactl sbx proc ls [ID] [--json]              the tracked processes: id, name, pid, state
                                                 (running, exited(code) or killed(signal)), age and
                                                 memory; an exited one stays until the lease ends
  mocactl sbx proc logs (NAME|ID) [--tail N] [--raw] [ID]
                                                 the last N lines (--tail, default 200) of a tracked
                                                 process's stdout and stderr; on a terminal its
                                                 control sequences are removed (--raw keeps them;
                                                 piped output is always as written)
  mocactl sbx proc stop (NAME|ID) [--signal S] [ID]
                                                 send signal S (--signal, default TERM), then kill
                                                 what is left after 10 s; prints its final state
                                                 (the process: its name, or its id, p<n> or n; the
                                                 last ID is the sandbox's)
  mocactl sbx token [ID] [--renew-every S] [--json]
                                                 print a fresh sandbox token (15 minutes by default);
                                                 --renew-every: a new line every S seconds until stopped
  mocactl sbx env [ID]                           shell exports for a direct sandbox/v1 client
  mocactl sbx egress [ID] [--json | --ndjson | --verify]
                                                 what the sandbox reached through its host's egress
                                                 proxy: per host, and whether the log is complete;
                                                 --ndjson prints the log whose sha256 its end record names;
                                                 --verify checks the log served against the control
                                                 plane's summary of it (sha256 and count; once the log
                                                 is sealed, at the host janitor's first sweep at least
                                                 10 minutes after the end, it is final)

the credentials the host swaps in:
  mocactl sbx credentials [list] [--json]       the credentials the host swaps into your sandboxes' HTTPS requests
  mocactl sbx credentials add NAME (--host DEST ... [--kind K] | --preset ID)
                                                 store one (the secret is read from stdin, never argv);
                                                 --host: where it is swapped in, DEST is
                                                 host[:port][/prefix] (repeatable); --kind: K is
                                                 bearer (default), basic, api-key, oauth2-token
                                                 (basic: stdin is username=... and password=...
                                                 lines); --preset: a preset's hosts and kind
                                                 instead (sbx credentials presets lists them; it
                                                 may also store NAME-<suffix> credentials)
  mocactl sbx credentials presets [--json]       the presets `add --preset` knows
  mocactl sbx credentials delete NAME            delete one

templates: what a sandbox is created from:
  mocactl sbx templates [--json]                 the templates a sandbox can be created from, with
                                                 their readiness and tags
  mocactl sbx quota [--json]                     your template quotas and use, and your live-sandbox cap
  mocactl sbx policy [--json]                    the deployment's template policy: profiles (envelope,
                                                 egress, rules), allowed registries, quotas, digest
  mocactl sbx hosts [--json]                     per KVM host: active slots, start line, memory
                                                 headroom and floor, idle grace, disk
  mocactl sbx templates create --spec F [--spec F ...] [--id ID] [--image REF] [--profile P]
                               [--visibility private|deployment] [--gate-record F] [--dry-run]
                               [--timeout S] [--json]
                                                 create a template (or a new build of your own) from a
                                                 spec, or from a gate record's template block; --id
                                                 and --image (pinned by digest) default to the
                                                 spec's; --profile: the policy profile it must pass
                                                 (sbx policy; default: the policy's defaultProfile);
                                                 --visibility: a new template's, default deployment
                                                 (a self-attested one must be private: deployment
                                                 is refused);
                                                 --gate-record: F is the image's gate record (one
                                                 --spec, at most 1 MiB), sent byte for byte.
                                                 Several --spec: one create each. --timeout: S
                                                 seconds for all the creates together (default
                                                 3600) to wait for queue slots while your
                                                 buildsQueued quota is full; specs not yet sent
                                                 when it runs out are not sent. An id already
                                                 yours: a new build of it (the same inputs: that
                                                 build, reused).
                                                 --dry-run: reads the policy, then its checks that
                                                 need only the inputs; nothing created
  mocactl sbx templates build ID --spec F [--image REF] [--profile P] [--gate-record F] [--dry-run]
                               [--timeout S] [--json]
                                                 a new build of your template ID from the spec
                                                 --spec F (--image: default the spec's; --profile:
                                                 the policy profile it must pass; --gate-record:
                                                 the image's gate record; --dry-run: only the
                                                 checks, nothing built; --timeout: up to S seconds
                                                 waiting for a queue slot, default 3600)
  mocactl sbx templates show ID [--build BUILD] [--json]
                                                 a template and its builds (status, readiness, tags,
                                                 why a build failed), or, with --build, one build
                                                 with its spec (--json); BUILD is a build's handle
                                                 or build id, as this lists them
  mocactl sbx templates follow ID [--build BUILD] [--timeout S] [--json]
                                                 poll a build (--build; default: the newest) until
                                                 registered, failed, rejected or cancelled; exit 0
                                                 only on registered, 1 on any other end, 5 past S
                                                 seconds (--timeout, default 3600), 130 on Ctrl-C
                                                 (the build goes on)
  mocactl sbx templates cancel ID --build BUILD [--json]
                                                 withdraw a queued, building or probing build
                                                 (--build: which one)
  mocactl sbx templates tag ID TAG... --build BUILD [--json]
                                                 move tags onto a registered build (--build) of a
                                                 template you own; sandboxes made earlier keep
                                                 their build
  mocactl sbx templates untag ID TAG [--json]    remove a tag; its build stays (never default)
  mocactl sbx templates edit ID [--visibility private|deployment] [--description TEXT] [--json]
                                                 change who sees it (--visibility: private, only
                                                 you, others' sandboxes already made keep running;
                                                 deployment, everyone; refused for a template with
                                                 a self-attested build), or its description
                                                 (--description)
  mocactl sbx templates activate ID [--build BUILD] [--lease S] [--wait [--timeout S]] [--json]
                                                 take or renew your activation lease on a build (tag
                                                 default, or --build BUILD; --lease: S seconds,
                                                 60-86400); a host agent starts its worker. --wait:
                                                 until it is active, saying why it waits (queued at
                                                 N, no slot, memory); --timeout default 1800 s,
                                                 raised from the host's start line when queued
                                                 (at most 4 h); exit 5 on a timeout
  mocactl sbx templates deactivate ID [--stop-now] [--json]
                                                 release your leases on a template; with none left,
                                                 its worker drains and stops (after the host's idle
                                                 grace, if it has one; --stop-now skips the grace)
  mocactl sbx templates retire ID [--build BUILD] [--reason TEXT] [--wait [--timeout S]] [--json]
                                                 retire a template you own (every build), or one
                                                 build: never served again, refused while a sandbox
                                                 runs on it, not undone (a new build is the way
                                                 back). --reason: kept in its record (not with
                                                 --build). --wait: until its worker has stopped
                                                 and every host has removed it (--timeout, default
                                                 900 s; exit 5 on a timeout), at once for a build no
                                                 host holds, or one whose worker a build neither
                                                 retired nor rejected uses

admins only:
  mocactl sbx templates transfer ID SUBJECT [--json]
                                                 make SUBJECT (github:<id> or oidc:<sub>) its owner
                                                 (admins only)
  mocactl sbx templates quota TARGET --templates N --builds-queued N --active N [--owned N] [--json]
  mocactl sbx templates quota TARGET --clear [--json]
                                                 set a subject's template quotas (--templates: the
                                                 templates it owns with a build registered or on
                                                 its way; --builds-queued: its builds queued,
                                                 building or probing at once; --active: the
                                                 templates it holds active at once) (TARGET
                                                 github:<numeric id> or oidc:<provider sub>) or the
                                                 default (TARGET default); --clear removes a
                                                 subject's override (admins only). --owned: the
                                                 template ids it may own in any status (without
                                                 it, the target keeps its current owned: to
                                                 return one subject's owned to the default,
                                                 --clear, then set the quota again). Reads, then
                                                 writes only if unchanged since the read: prints
                                                 old -> new; exit 1, nothing written, if another
                                                 admin changed it in between
  mocactl sbx admin subjects [--json]            every enrolled subject and its roles (admins only)
  mocactl sbx admin subjects enroll|unenroll SUBJECT [--json]
                                                 enroll SUBJECT (github:<id> or oidc:<sub>) or unenroll
                                                 one enrolled through the API (the settings' lists
                                                 stay; an admin named in the settings only)
  mocactl sbx admin subjects grant SUBJECT [--until DURATION|EPOCH] [--json]
  mocactl sbx admin subjects revoke SUBJECT [--json]
                                                 grant or revoke the admin role; --until (e.g. 30m, 2h,
                                                 1d, or epoch seconds; at most 365 days ahead) makes it
                                                 lapse by itself (each
                                                 change prints old -> new, and fails if the value
                                                 changed between its read and its write)
--record F (every command that calls the API but token, login, logout and credentials): one
NDJSON line per HTTP attempt appended to F (0600), with no token, host or free text in it.
--json: print the result as JSON on stdout, for a script.
ID (or --sandbox ID) defaults to the sandbox in the nearest .sbx/sandbox.json. The control plane
comes from --control-plane-url, MOCACTL_SBX_URL, the bound sandbox's, the one remembered at
login, or the login's own (a login minted by an operator). `up` skips the bound sandbox's, and
rebinds, when this machine has a login for the remembered (or login's) one and none for it. The
login is kept apart from `mocactl login`'s, so both can be active at once.
exit: 0 ok, 1 failed, 2 usage, 3 log in first, 4 control plane unreachable, 5 a wait timed out,
130 interrupted (Ctrl-C)
```

<!-- END GENERATED: mocactl sbx --help -->
