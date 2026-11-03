"""Muse Glimmer 30B on Modal: the agent's judge-only sovereign provider (owner: Eng C).

vLLM's OpenAI-compatible server on one L40S, open weights (Apache-2.0), FP8 block-scaled
checkpoint (32.8 GB; BF16 does not fit 48 GB). The API calls it as provider "modal"
(dryrun/meta/providers.py), and only for a request with the judge key or the team token.

Spend guardrails ($30 of Modal credit, owner 2026-11-02):
- scales to zero: min_containers=0, no keep-warm; idle containers stop after 120 s;
- never more than one container (max_containers=1), so a burst queues instead of fanning out;
- requires_proxy_auth: the URL answers 401 without a workspace proxy token (Modal-Key / Modal-Secret
  headers), so nobody can call the model directly with our credit.

Deploy: modal deploy infra/modal/glimmer.py  (prints the URL; the API takes it as MODAL_BASE_URL + "/v1").
"""

import subprocess

import modal

MODEL = "RedHatAI/Muse-Glimmer-30B-FP8-block"
REVISION = "1deb4641ff84f9a728dd11b27cac1f6a02a9ed14"
SERVED_NAME = "muse-glimmer-30b"
PORT = 8000

image = (
    modal.Image.from_registry("nvidia/cuda:12.8.1-devel-ubuntu22.04", add_python="3.12")
    .entrypoint([])
    .uv_pip_install("vllm==0.32.0", "huggingface-hub[hf_transfer]")
    .env({"HF_HUB_ENABLE_HF_TRANSFER": "1", "HF_HOME": "/cache/hf", "VLLM_CACHE_ROOT": "/cache/vllm",
          "FLASHINFER_WORKSPACE_BASE": "/cache/flashinfer"})
)
# Weights, vLLM's compile cache and FlashInfer's JIT kernels persist between cold starts (a cold start then loads,
# not downloads or builds).
cache = modal.Volume.from_name("dryrun-glimmer-cache", create_if_missing=True)

app = modal.App("dryrun-glimmer")


@app.function(image=image, gpu="L40S", volumes={"/cache": cache}, min_containers=0, max_containers=1,
              scaledown_window=120, timeout=60 * 60)
@modal.concurrent(max_inputs=8)
@modal.web_server(port=PORT, startup_timeout=20 * 60, requires_proxy_auth=True)
def serve():
    subprocess.Popen([
        "vllm", "serve", MODEL, "--revision", REVISION, "--served-model-name", SERVED_NAME,
        "--host", "0.0.0.0", "--port", str(PORT),
        # A long agent session plus the brief's 12,000-token budget passed 32K (parity eval, 2026-11-02); 64K fits the
        # KV cache the L40S has left after the weights for the one session at a time we serve.
        "--max-model-len", "65536", "--gpu-memory-utilization", "0.92",
        # Text only: the vision tower is not loaded for images we never send.
        "--limit-mm-per-prompt", '{"image": 0}',
        # Muse Glimmer frames tool calls and reasoning in its own format: both parsers, together (vLLM recipe).
        "--enable-auto-tool-choice", "--tool-call-parser", "muse_glimmer", "--reasoning-parser", "muse_glimmer",
        "--generation-config", "auto",
    ])
