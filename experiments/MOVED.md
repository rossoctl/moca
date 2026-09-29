# Moved

The `@sh/experiments` workspace package (M6's E2/E5 in-process experiment runners, the E11
density-analysis module, and the SWE-bench evaluation harness, including
`scripts/gen_swebench_deck.py` which now lives at `experiments/swebench/gen_swebench_deck.py`
there) has moved to [rossoctl/moca-experiments](https://github.com/rossoctl/moca-experiments),
directory `experiments/`, with git history preserved.

Three things it depended on stayed in this repo, since they're production code and
infrastructure, not experiments:

- `harness/src/swebench-setup.ts` — real production code, imported by `harness/src/run-leaf.ts`.
- `remote-worker/` (the whole Go module, including `cmd/exec-driver`/`cmd/null-responder`, which
  the moved E11 test's seam-closure check wants — kept as one module rather than fragmented;
  `cmd/vmpoolctl` specifically cannot leave it at all, since it imports a Go `internal/` package).
- `deploy/knative/swebench-sandbox-buildconfig.yaml` and `swebench-sandbox-pool.yaml` — K8s
  deployment manifests. Only the latter is validated by a test
  (`packages/knative-server/test/swebench-sandbox-pool.test.ts`); the former stays for the same
  "deployment manifest, not an experiment" reason, not because a test reads it too.

See [`moca-experiments/experiments/swebench/RUNBOOK.md`](https://github.com/rossoctl/moca-experiments/blob/main/experiments/swebench/RUNBOOK.md)
for how the two halves fit together, and that repo's README for the full "what didn't move and
why" list.
