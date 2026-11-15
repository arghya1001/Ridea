"""
Ridea video backend on Modal: animates one still image into a ~3.4 s clip with LTX-Video.

Deploy:   modal deploy modal_ltx.py
Measure:  modal run modal_ltx.py            (prints real seconds per clip, saves bench_*.mp4)

Contract (matches the router in worker.js):
  POST JSON {token, image (base64 JPEG/PNG), prompt, frames}  ->  MP4 bytes (video/mp4)
"""
import hmac
import io
import os
import random
import tempfile

import modal

MODEL_ID = "Lightricks/LTX-Video"   # first version that loads with diffusers' LTXImageToVideoPipeline
GPU = "L4"                          # 24 GB, has native bf16 (a T4 does not). Cheaper/slower: "T4"
WIDTH, HEIGHT = 480, 640            # 3:4 portrait = Ridea's film frame; both divisible by 32
STEPS = 30                          # fewer = faster/cheaper, more = cleaner (try 20-40)
MOTION = (", gentle natural motion, soft drifting light, subtle camera push-in, "
          "smooth cinematic movement, hand-painted anime look")
NEGATIVE = "worst quality, inconsistent motion, blurry, jittery, distorted, text, watermark, logo"

app = modal.App("ridea-video")
cache = modal.Volume.from_name("ridea-hf-cache", create_if_missing=True)  # keeps model weights between cold starts

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "torch", "diffusers", "transformers", "accelerate", "sentencepiece", "protobuf",
        "imageio", "imageio-ffmpeg", "pillow", "fastapi[standard]",
    )
    .env({"HF_HOME": "/cache"})
)


@app.cls(
    image=image,
    gpu=GPU,
    volumes={"/cache": cache},
    secrets=[modal.Secret.from_name("ridea-video")],  # must contain RIDEA_TOKEN
    scaledown_window=120,   # stay warm 2 min so the 4 scenes of one film reuse the loaded model
    timeout=600,
    max_containers=1,       # hard cost guard: never spin up parallel GPUs
)
class Video:
    @modal.enter()
    def load(self):
        import torch
        from diffusers import LTXImageToVideoPipeline

        self.pipe = LTXImageToVideoPipeline.from_pretrained(MODEL_ID, torch_dtype=torch.bfloat16)
        self.pipe.to("cuda")
        try:
            self.pipe.vae.enable_tiling()   # lower peak memory while decoding frames
        except Exception:
            pass
        cache.commit()                      # persist downloaded weights

    @modal.method()
    def run(self, image_b64: str = "", prompt: str = "", frames: int = 81) -> bytes:
        import base64

        import torch
        from diffusers.utils import export_to_video
        from PIL import Image

        if image_b64:
            img = Image.open(io.BytesIO(base64.b64decode(image_b64))).convert("RGB")
        else:  # benchmark mode: plain gradient so timing works with no input image
            img = Image.linear_gradient("L").resize((WIDTH, HEIGHT)).convert("RGB")
        img = img.resize((WIDTH, HEIGHT))

        frames = max(9, min(int(frames), 97))
        frames = (frames - 1) // 8 * 8 + 1  # LTX needs 8n+1 frames
        gen = torch.Generator("cuda").manual_seed(random.randrange(2**31))
        out = self.pipe(
            image=img,
            prompt=(prompt.strip()[:300] or "a calm scene") + MOTION,
            negative_prompt=NEGATIVE,
            width=WIDTH,
            height=HEIGHT,
            num_frames=frames,
            num_inference_steps=STEPS,
            generator=gen,
        ).frames[0]

        with tempfile.NamedTemporaryFile(suffix=".mp4") as f:
            export_to_video(out, f.name, fps=24)
            with open(f.name, "rb") as fh:
                return fh.read()

    @modal.fastapi_endpoint(method="POST")
    def generate(self, item: dict):
        from fastapi import HTTPException, Response

        expected = os.environ.get("RIDEA_TOKEN", "")
        if not expected or not hmac.compare_digest(str(item.get("token", "")), expected):
            raise HTTPException(status_code=401, detail="bad token")
        if not item.get("image") or not item.get("prompt"):
            raise HTTPException(status_code=400, detail="image and prompt required")
        data = self.run.local(item["image"], item["prompt"], item.get("frames", 81))
        return Response(content=data, media_type="video/mp4")


@app.local_entrypoint()
def bench(image: str = "", prompt: str = "a quiet village at dawn, mist over the hills", runs: int = 3):
    """Time real clips. Run 1 includes the cold start and first-time model download."""
    import base64
    import time

    b64 = base64.b64encode(open(image, "rb").read()).decode() if image else ""
    v = Video()
    for i in range(runs):
        t = time.time()
        data = v.run.remote(b64, prompt)
        print(f"run {i + 1}: {time.time() - t:.1f}s, {len(data) / 1e3:.0f} KB" + ("  (cold start)" if i == 0 else ""))
        if i in (0, runs - 1):
            with open(f"bench_{i + 1}.mp4", "wb") as fh:
                fh.write(data)
