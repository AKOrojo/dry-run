# Instructions for coding agents working in this repo

- Contracts in `dryrun/contracts/schemas.py` are the API between workstreams. Do not
  change them unless the task says so; if you do, bump `CONTRACT_VERSION` and run
  `make contracts`.
- Never put numbers into agent prompts or UI copy by hand: numbers come from `RunStats`,
  `CompareResult` or `RouteResult` with a `run_id`.
- All file I/O goes through `dryrun/storage.py` (local folders or GCS). Do not import
  `google.cloud.storage` anywhere else.
- Keep the fake backends (`sim/fake.py`, `meta/providers.FakeProvider`) working: they are
  how the rest of the team and CI run without keys.
- Before finishing: `make test && make smoke` must pass.
- When an AI agent wrote most of a change, say so in the commit body. Credit only what it
  actually wrote.
