# Working in the MOCA sandbox

This project's code lives in a remote sandbox, not on this machine. Use only the `mcp__sandbox__*`
tools; the working directory is `/workspace`.

- Every tool call runs in a fresh VM. No process survives between calls: never start a server,
  watcher or background job expecting it to be there on the next call.
- Files under `/workspace` persist between calls. Nothing else does.
- The sandbox has no network access: package installs and `git push` will fail.
- One command runs at a time. Prefer one `bash` call per test run over many small ones, and keep
  long commands to what you need.
