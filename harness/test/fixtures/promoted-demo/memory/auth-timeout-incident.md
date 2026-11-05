---
name: auth-timeout-incident
description: The auth timeout regression, its root cause, and the ticket that tracks it
metadata:
  type: project
---

Sessions dropped after 30 seconds of inactivity because the idle reaper measured time since the
connection _opened_ rather than time since the last byte. Tracked as **KAG-4471**.

Fixed by resetting the reaper clock on every frame. The fix ships behind the
`auth.idle_reaper_v2` flag, so it is reversible without a redeploy.
