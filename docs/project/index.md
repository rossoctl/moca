---
title: Project
sidebar_position: 9
description: Where moca is going and the evidence behind it. A draft page, filled in as the docs move.
---

# Project

> **Draft.** This page collects what moca's README used to carry about the project as a whole. It
> will grow as the docs move (architecture decisions, contributing to the docs), and its content may
> change.

## Roadmap

The [milestone registry](../specs/README.md) is the source of truth for the status of every
milestone, including the process manager (P6), the microVM tier (P4), the multi-user control plane
(MU), and the zero-trust credential plane (Z track), whose parts are at different stages.

- **Async fan-out under multi-tenancy** (`MOCA_TENANCY=multi`) is being worked on, targeted for
  v0.12.0. Until then, async fan-out is single-tenant only.
- **Scheduled dispatch** has no design on the P6 runtime yet
  ([#536](https://github.com/rossoctl/moca/issues/536)).

Every deployment path is Preview; the criteria for Stable are in
[Maturity and lifecycle](../reference/maturity-and-lifecycle.md).

## Evidence

Behaviour and economics are backed by reproducible experiments rather than claims:

- **[`moca-experiments/experiments/e01-e07-knative/EXPERIMENTS.md`](https://github.com/rossoctl/moca-experiments/blob/main/experiments/e01-e07-knative/EXPERIMENTS.md)**:
  cluster experiments E1 (economics), E3 (mobility) and E4 (recovery), run live on Kind on the
  since-removed Knative path.
- **[`docs/archive/experiment-results.md`](../archive/experiment-results.md)**: E2 (reconstruction
  cost) and E5 (budget enforcement), a dated write-up from June 2026. The code these ran from now
  lives in
  [`moca-experiments/experiments/`](https://github.com/rossoctl/moca-experiments/tree/main/experiments/e02-e05-harness).

## Architecture decisions

The architecture decision records (ADRs) are kept in the repository, not on this site:
[`docs/adrs/`](../adrs/README.md) on GitHub.
