# Concepts

> **Preview.** These pages explain how the P6 runtime works and why it is shaped that way. Each states
> what the code does today and marks what only a spec or ADR proposes. For terms see the
> [glossary](../glossary.md); for commands and settings see the [reference](../reference/configuration.md).

| Page                                            | Question it answers                                                              |
| ----------------------------------------------- | -------------------------------------------------------------------------------- |
| [Sessions and turns](sessions-and-turns.md)     | Where does a conversation live, and what survives a crash or a restart?          |
| [Brain and hands](brain-and-hands.md)           | What runs in the agent process, and what runs in a sandbox?                      |
| [Session multiplexing](session-multiplexing.md) | How do many sessions share a few warm processes, and what happens at overload?   |
| [Sandboxes and tiers](sandboxes-and-tiers.md)   | What isolation does a sandbox give, and how does a session find "its" sandbox?   |
| [Multi-user](multi-user.md)                     | Who can do what, and where do credentials live?                                  |
| [Dispatch archetypes](dispatch-archetypes.md)   | How does an orchestrator hand work to MOCA, and which patterns work on P6 today? |
| [Context workflows](context-workflows.md)       | How do users move context into and out of MOCA, and which ways work today?       |

The ideas that hold across deployments are: durable resumable sessions, a brain/hands split, several
users on one deployment, and disposable sandboxes. Scale-to-zero was a property of the removed
Knative/KEDA deployment, not of these ideas.
