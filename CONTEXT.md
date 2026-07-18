# Threadmap

Orchestrates the Matt Pocock SDLC pipeline (planning → to-spec → to-tickets → implement → code-review) over headless agent sessions, against GitHub Issues, across multiple repos in one workspace.

## Language

### Structure

**Workspace**:
The directory `threadmap` runs in. Its Repos are auto-discovered: direct child directories containing a git clone, plus the root itself when it is one (the single-repo case).
_Avoid_: project, monorepo

**Repo**:
A git clone inside the Workspace, backed by a GitHub repository. Carries its own readiness (see Setup).

**Effort**:
One feature-sized unit of work flowing through the pipeline. An Effort IS its map issue in the home repo — the issue's existence means the Effort exists, and `home-repo#number` is its id. Spans one or more Repos.
_Avoid_: feature, project, initiative

**Home repo**:
The Repo hosting an Effort's map issue and spec file. Picked by the user at Effort creation.

**Member repo**:
A Repo participating in an Effort. Derived, never declared: a Repo is a member iff it owns at least one of the Effort's tickets. Before to-tickets, the home repo is the only member.

**Ticket**:
A GitHub issue that is a sub-issue of an Effort's map issue, owned by whichever Repo it was routed to.
_Avoid_: task, issue (bare)

**Spec**:
The Effort's per-effort contract: one `threadmap:spec`-labelled sub-issue of the map issue in the home repo. Closing it is the human approval. Deliberately disposable — durable knowledge graduates to CONTEXT.md and ADRs, never lives in a Spec.
_Avoid_: PRD, design doc

### Pipeline

**Setup**:
Repo-level readiness — per-repo agent docs generated and skills present. A property of a Repo, not a pipeline stage; an Effort can only start when every Repo it needs is set up.

**Stage**:
An Effort's single current position in the pipeline: planning → to-spec → to-tickets → implement → code-review. One Stage per Effort — per-repo progress is detail inside a stage, never a second stage machine. Derived purely from artifacts; nothing sets it directly.
_Avoid_: phase, step

**Gate**:
The verifiable exit condition of a Stage, derived from tracker and git artifacts. Hard: the next Stage unlocks only when the gate's condition is met, or an Override is recorded.

**Override**:
An explicit, recorded "I know what I'm doing" that makes one Stage's Gate count as passed without its condition being met: a `threadmap:override:<stage>` label on the map issue plus a structured audit comment (who, when, unmet condition, reason). Revoked by removing the label.

**Completion**:
The end of an Effort: the user closes the map issue via a UI prompt once code-review's Gate passes. Never automatic — no machine event silently finishes an Effort.

**Session**:
One headless agent run with a persistent, re-openable chat transcript. Bound to exactly one Effort + Stage, with cwd = one Repo (planning stages: the home repo; implement/review: the owning repo). Sessions produce artifacts; finishing a Session never flips a Stage by itself. Setup Sessions are the exception: bound to a Repo, no Effort.
_Avoid_: run, chat, conversation
