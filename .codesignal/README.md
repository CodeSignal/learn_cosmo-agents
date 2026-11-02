# Base task

`setup.sh` and `run_solution.sh` are the scripts the simulation's CodeSignal base task runs. They
live in the base task as read-only project files; the copies here are versioned next to the
release layout they depend on.

## Files

| Base task file | From |
|---|---|
| `readonly_main.sh` | `bash .codesignal/run_solution.sh` |
| `readonly_.codesignal/setup.sh` | [`setup.sh`](setup.sh) |
| `readonly_.codesignal/run_solution.sh` | [`run_solution.sh`](run_solution.sh) |
| `readonly_.codesignal/agent-sim.json` | a default task config (main README, "Task configuration"); each task replaces it |

- `setup.sh` installs the release for the channel in `~/.cosmo-agents` (outside the workspace)
  and starts the simulation; it returns once the server on :3000 answers. Production runs the
  latest release, staging (`APP_ENVIRONMENT=staging`) the newest build.
- `run_solution.sh` prints the simulation's report (main README, "Evaluation output").

The workspace holds only the task's own files, so the editor shows the task's code and what the
agent changes, never the simulation's.

## Settings

| Setting | Value |
|---|---|
| Environment | JavaScript (Node is used to run the simulation) |
| LLM proxy | on, with OpenAI and Anthropic for the agents the tasks use |
| Container memory | 8g (three engines and their sessions) |
| Coding details, replay | hidden |
| Preview, preview header, refresh on Run | default: tasks keep the editor and the preview side by side |

Grading is the task's own (code-task grading); the simulation adds no grader.

## Trying it by hand

In a session, setup's log and each process's output are in `~/.cosmo-agents/log/`.
`test/stock/run.sh` runs the same setup locally on a stand-in for the platform's standard image.
