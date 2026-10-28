# Dry Run

An agentic urban-flood digital twin: design a storm, change the city (drains, green
infrastructure, retention ponds, tide), and watch a 2D flood simulation, impacted
buildings and evacuation routes change, with a Muse Spark planner agent whose every
number is verified against simulator output.

> Built during the building period of the Meta Global AI Developer Hackathon (Oct 27 – Nov 4, 2026).
> The git history is the record of what was built and when; see **Provenance** below.
> **Not an operational flood warning system.** Layers are badged Simulated / Observed / AI-illustrated.

## Quick start (no keys, no cloud)

```bash
cp .env.example .env
make setup        # python + web deps
make fixtures     # synthetic AOI -> ./data
make smoke        # fixtures -> runs -> route -> agent brief, all offline
make api          # :8080
make web          # :5173 (proxies /api and /runs to :8080)
```

## Architecture

```
web (React + CesiumJS) --/api--> FastAPI on Cloud Run --> sim engine (local-inertial solver)
        |                              |                 --> routing (NetworkX on OSM)
        |                              |                 --> agent (Muse Spark 1.3 / Spark Open)
        +-- frames (PNG) <-- GCS runs bucket <-- run outputs (content-addressed by run_id)
                               GCS data bucket <-- offline open-data + OSM pipeline
```

| Meta model | Used for |
|---|---|
| Muse Spark 1.3 | Planner agent: tool calls over the simulator, verified briefs; vision depth estimates |
| Muse Spark Open (Baseten) | "Sovereign mode": same agent on open weights |
| SAM 3.1 | Flood-water / reference-object masks from citizen photos |
| Muse Voice Transcribe | Hands-free responder queries, biased to Lagos place names |
| Muse Image | Before/after illustrations of interventions (labelled AI illustration) |

Built with Muse Spark Open. Data attributions: `ATTRIBUTION.md`.

## Provenance

Everything in this repository was built for the hackathon and the git history is the record —
real timestamps, nothing backdated, no pre-existing codebase or product reused. The first commit
is the team's scaffold (data contracts, placeholder backends, deploy scripts), written from our
own feasibility plan on Oct 27 2026 with AI assistance, reviewed by the team, and committed the
next morning. Everything after it is day-by-day work by the four of us, with AI assistance noted
in the commit body where it did the bulk of the writing.
