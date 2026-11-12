# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Software factory

The factory (`/factory run`, see `AGENTS.md`) uses this same vocabulary plus one label of its own, mapped in `factory/config.json` `labels`:

| Label             | Set by the factory when                                     |
| ----------------- | ----------------------------------------------------------- |
| `factory`         | (set by you) queue this issue for the factory               |
| `needs-info`      | intake asked the author a question on the issue             |
| `ready-for-human` | the job escalated: a PR waits for your decision             |
| `wontfix`         | intake or you rejected the job; `factory` is removed        |
