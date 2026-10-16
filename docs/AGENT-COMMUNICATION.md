# Native worker tools

Pi owns every worker runtime and native history. The optional `delegation` feature
(enabled by default) exposes six tools in ordinary Pi and managed views.

| Tool | Behavior |
| --- | --- |
| `pi_agent_spawn` | Start a named native session with a task and role, without attaching a terminal |
| `pi_agent_list` | Return owned worker states and compact metadata |
| `pi_agent_send` | Deliver bounded durable mail to a worker or its parent |
| `pi_agent_inbox` | Read up to 20 messages with a cursor |
| `pi_agent_wait` | Wait up to 25 seconds for mail without running a model |
| `pi_agent_stop` | Abort and dispose an owned worker while retaining native history |

Roles are `implement`, `review`, `test`, and `research`. The assigned role and
shared worker guidance are included in the initial task. Explicit provider and
model must be supplied together; otherwise Pi's configured default is used.
The tools do not change user model, settings, or trust files. A project directory
must already exist.

`maxWorkers` defaults to two. Admission counts preparing workers and all host
sessions with active runs or pending prompts. Concurrent starts reserve capacity
synchronously; excess work is refused rather than queued. Workers cannot create
or stop other workers. Mail-only messages never start inference. An explicit wake
may steer a running worker or start a settled one when capacity permits.

Workers remain ordinary visible `/agents` sessions. Pending dialogs require normal
native user input. All managed sessions share the same host process and extension
globals.

State is stored in private `host/delegation.json`: up to 512 worker records and 256
mail messages of at most 4,000 characters. Inbox responses include a cursor and a
truncation flag when needed. After a crash, interrupted worker metadata becomes
failed; saved tasks and wake requests are never replayed. Mail survives restart.

Disable delegation with `delegation: false`; core session operations continue to
work. Malformed delegation state fails control requests without taking down the
core UI. Unsafe ownership and filesystem paths remain rejected by shared storage
checks.
