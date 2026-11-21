---
title: Explainers
sidebar_label: Explainers
description: Interactive, step-through diagrams of moca's two capabilities, and of the sandbox service's authentication, admission, lease mode and async fan-out.
doc_type: navigation
audience: [evaluator, sandbox-user, harness-user, operator]
capability: both
---

# Explainers

> **Preview.** These pages describe moca on `main`; interfaces and limits may change.

Each explainer is a single self-contained page you step through, rather than read: press Next, or click a step,
and watch the request, the pool or the lease move. They open in a new tab and need an
internet connection (they load their styling from a CDN).

Each one illustrates a written design. The links below go to the prose docs that cover the same
ground, and each explainer's footer cites the code and the design record it was built from.

Start with the two overview explainers if you are new to moca. The four after them go deeper on one
part of the sandbox service or the harness.

| Explainer                                                                       | Shows                                                                                                                     | Capability      | Written docs                                                                                                         |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------- |
| [Moca: the harness and the sandbox](pathname://./harness-and-sandbox.html)      | How the two capabilities differ, how a harness turn runs end to end, and the relay, workers and route profiles they share | Both            | [Overview](../../index.md), [Brain and hands](../../harness/concepts/brain-and-hands.md)                             |
| [The moca sandbox service](pathname://./sandbox-service.html)                   | Why the agent stays on your laptop, and how one command reaches a fresh microVM and comes back as a patch                 | Sandbox service | [Overview](../../index.md), [Isolation and data handling](../../sandbox/concepts/isolation.md)                       |
| [Sandbox authentication and exec flow](pathname://./sandbox-auth-and-exec.html) | How a client gets a sandbox token, and how one `Exec` reaches a fresh microVM and comes back                              | Sandbox service | [Isolation and data handling](../../sandbox/concepts/isolation.md), [Direct API](../../sandbox/how-to/direct-api.md) |
| [Admission and the microVM pool](pathname://./admission-and-pool.html)          | How the VM pool admits, queues and reclaims work against a memory budget, and when a workspace is deleted                 | Sandbox service | [Limits](../../sandbox/concepts/limits.md), [Install the sandbox service](../../operate/sandbox-service/install.md)  |
| [Lease mode](pathname://./lease-mode.html)                                      | Why `lease` keeps one guest warm between commands, and what survives in each of the three modes                           | Sandbox service | [Keep a guest between commands](../../sandbox/how-to/lease-mode.md)                                                  |
| [Async fan-out](pathname://./async-fan-out.html)                                | How `async: true` leaves are queued, drained inside a worker under the turn admission budget and recovered after a crash  | Harness         | [Dispatch archetypes](../../harness/concepts/dispatch-archetypes.md)                                                 |
