"""Voice + image features (owner: Eng C).

Voice (Muse Voice Transcribe, streaming ASR over WebSocket):
  browser mic -> wss://<our host>/api/voice  (relay, so the Meta key never reaches the browser)
  Message format (C documents it in evals/api_samples/voice.md by Wed 5 PM for B):
    client -> server: binary audio frames (format per Meta ASR docs) ; text {"type":"stop"}
    server -> client: {"type":"partial"|"final","text":...} ; {"type":"error","error":...}
             -> Meta realtime ASR endpoint (URL from dev.meta.ai; verify Day 2) with keyword biasing
  final transcript -> POST /agent (same path as typed questions)

Image (Muse Image edits; owner Eng B, Eng C reviews): street photo + "add bioswale and widened drain"
  -> /v1/images/edits -> PNG, ALWAYS watermarked "AI illustration - not engineering design".
"""

# Must match the chosen AOI (default Lekki-Ajah) and the `places` layer names (Eng D).
LAGOS_KEYWORDS = [
    "Lekki", "Lekki Phase 1", "Ajah", "Sangotedo", "Chevron", "Admiralty Way", "Ikota", "Osapa",
    "Agungi", "Jakande", "Ikate", "Lekki-Epe Expressway", "Abraham Adesanya", "Badore", "Ado Road",
    "Lagos Lagoon", "Victoria Island", "Victoria Garden City", "Ojomu", "Lekki Peninsula II", "Chisco",
]

ASR_MODEL = "muse-voice-transcribe-1.0"
IMAGE_MODEL = "muse-image-1.0"


async def relay_voice(client_ws) -> None:  # TODO Eng C Day 5 (owner: C)
    raise NotImplementedError


def render_intervention(photo: bytes, instruction: str) -> bytes:  # TODO Day 5 (owner: B; C reviews)
    raise NotImplementedError
