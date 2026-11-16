// Ridea backend — Cloudflare Worker using Workers AI (free: 10,000 neurons/day, no card).
// On the Workers Free plan, requests simply fail after the daily limit — you are never charged.
const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const TEXT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast"; // change if Cloudflare retires it

// ---- AI video (free GPUs: Kaggle / Colab notebooks, no credit card) ---------------
// A free GPU notebook (ridea_video_worker.ipynb) runs LTX-Video and registers its public
// address here every few minutes. If it stops, the address expires on its own and the app
// quietly falls back to the free storybook. Flow:  app -> /video (submit) -> /video-result (poll).
// Needs: a KV namespace bound as RIDEA_KV, and a secret named RIDEA_TOKEN (any password).
const PROVIDERS = ["KAGGLE", "COLAB"];     // names the notebook uses (it picks automatically)
const DEFAULT_CLIPS_PER_USER_DAY = 8;      // 8 clips = 2 films per person per day

const coolMem = new Map();                 // fallback cooldown when KV is slow
const dayKey = () => new Date().toISOString().slice(0, 10);
async function kvGet(env, key) {
  if (!env.RIDEA_KV) return null;
  try { return await env.RIDEA_KV.get(key); } catch { return null; }
}
async function kvNum(env, key) { return parseFloat(await kvGet(env, key)) || 0; }
async function kvPut(env, key, val, opts) {
  if (!env.RIDEA_KV) return;
  try { await env.RIDEA_KV.put(key, String(val), opts); } catch {}
}
async function isCooling(env, name) {
  if ((coolMem.get(name) || 0) > Date.now()) return true;
  return !!(await kvGet(env, "cool:" + name));
}
async function cool(env, name, status) {
  const ttl = [402, 403, 429].includes(status) ? 3 * 3600 : 600;
  coolMem.set(name, Date.now() + ttl * 1000);
  await kvPut(env, "cool:" + name, "1", { expirationTtl: Math.max(60, ttl) });
}
// notebooks that registered recently (their address expires if they stop)
async function liveProviders(env) {
  const out = [];
  for (const name of PROVIDERS) {
    if (await isCooling(env, name)) continue;
    const url = await kvGet(env, "url:" + name);
    if (url) out.push({ name, url });
  }
  return out;
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const allowed = [env.ALLOWED_ORIGIN, "http://localhost:8000"].filter(Boolean);
    const cors = {
      "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : "null",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    const send = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST") return send({ error: "POST only" }, 405);
    if (new URL(req.url).pathname === "/worker/register") {
      let b; try { b = await req.json(); } catch { return send({ error: "Bad JSON" }, 400); }
      if (!env.RIDEA_TOKEN || b.token !== env.RIDEA_TOKEN) return send({ error: "bad token" }, 401);
      if (!env.RIDEA_KV) return send({ error: "KV namespace RIDEA_KV is not connected to this Worker" }, 500);
      const name = String(b.name || ""), u = String(b.url || "");
      if (!PROVIDERS.includes(name) || !/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(u)) return send({ error: "bad name or url" }, 400);
      await env.RIDEA_KV.put("url:" + name, u, { expirationTtl: 1500 });
      coolMem.delete(name);
      try { await env.RIDEA_KV.delete("cool:" + name); } catch {}
      return send({ ok: true });
    }
    if (!allowed.includes(origin)) return send({ error: "Origin not allowed" }, 403);

    const path = new URL(req.url).pathname;
    let body;
    try { body = await req.json(); } catch { return send({ error: "Bad JSON" }, 400); }

    try {
      if (path === "/image") {
        const prompt = String(body.prompt || "").slice(0, 500);
        if (!prompt) return send({ error: "Describe the image first" }, 400);
        const out = await env.AI.run(IMAGE_MODEL, { prompt: prompt + ". Clean image, no text, watermark, signature or logo.", steps: 4 });
        return send({ image: out.image });
      }
      if (path === "/concept") {
        const topic = String(body.topic || "").slice(0, 200);
        const genre = String(body.genre || "").slice(0, 40);
        if (!topic) return send({ error: "Add a topic first" }, 400);
        const out = await env.AI.run(TEXT_MODEL, {
          max_tokens: 500,
          messages: [
            { role: "system", content: 'You are a creative story developer. Reply with ONLY a JSON array of exactly 3 objects, each {"title": "2-4 words", "blurb": "one vivid sentence"}. No other text.' },
            { role: "user", content: `Topic: ${topic}\nGenre: ${genre}\nGive 3 distinct story directions.` },
          ],
        });
        const raw = typeof out.response === "string" ? out.response : JSON.stringify(out.response);
        const arr = JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1));
        const premises = arr.slice(0, 3).map(p => ({ title: String(p.title), blurb: String(p.blurb) }));
        return send({ premises });
      }
      if (path === "/script") {
        const topic = String(body.topic || "").slice(0, 200);
        const genre = String(body.genre || "").slice(0, 40);
        const p = body.premise || {};
        const len = { Short: 350, Medium: 600, Long: 900 }[body.length] || 600;
        const cast = body.cast && body.cast.name ? `Include a character named ${String(body.cast.name).slice(0, 30).toUpperCase()}${body.cast.voice ? ` (voice: ${String(body.cast.voice).slice(0, 40)})` : ""}.` : "";
        const out = await env.AI.run(TEXT_MODEL, {
          max_tokens: len + 300,
          messages: [
            { role: "system", content: 'You are a screenwriter. Reply with ONLY a JSON array of script lines, each {"type": one of "transition","heading","action","character","paren","dialogue", "text": string}. Start with FADE IN: and a scene heading. Each dialogue is preceded by a character line and a paren line. No other text.' },
            { role: "user", content: `Topic: ${topic}\nGenre: ${genre}\nDirection: ${String(p.title || "")} - ${String(p.blurb || "")}\n${body.withDialogue ? "Include dialogue." : "Narration and action only, no characters speaking."} ${cast}\nLength: ${body.length || "Medium"} (about ${Math.round(len / 2.5)} words).` },
          ],
        });
        const raw = typeof out.response === "string" ? out.response : JSON.stringify(out.response);
        const arr = JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1));
        const ok = ["transition", "heading", "action", "character", "paren", "dialogue"];
        const lines = arr.filter(l => l && ok.includes(l.type) && l.text).map(l => ({ type: l.type, text: String(l.text) }));
        if (lines.length < 3) throw new Error("bad script");
        return send({ lines });
      }
      if (path === "/scenes") {
        const idea = String(body.idea || "").slice(0, 200);
        if (!idea) return send({ error: "Describe your film idea first" }, 400);
        const out = await env.AI.run(TEXT_MODEL, {
          max_tokens: 800,
          messages: [
            { role: "system", content: 'You write 4-scene mini stories for a 13-second film. Reply with ONLY a JSON array of exactly 4 objects: {"caption": warm narration, max 12 words, "visual": a concrete image description for an illustrator, max 30 words, no text in the image, \"motion\": ONE calm sentence, max 25 words, describing only small gentle movement of things already in the picture (a blink, a slow head turn, swaying leaves, drifting light, a slow camera push-in), no big actions, no transformations, no new objects}. No other text.' },
            { role: "user", content: `Story idea: ${idea}` },
          ],
        });
        const raw = typeof out.response === "string" ? out.response : JSON.stringify(out.response);
        const arr = JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1));
        const scenes = arr.slice(0, 4).filter(x => x && x.caption && x.visual).map(x => ({ caption: String(x.caption).slice(0, 90), visual: String(x.visual).slice(0, 240), motion: String(x.motion || "").slice(0, 220) }));
        if (scenes.length < 4) throw new Error("bad scenes");
        return send({ scenes });
      }
      if (path === "/video-status") {
        const cap = parseInt(env.CLIPS_PER_USER_DAY) || DEFAULT_CLIPS_PER_USER_DAY;
        const ip = req.headers.get("CF-Connecting-IP") || "anon";
        const live = await liveProviders(env);
        const clipsLeft = Math.max(0, cap - await kvNum(env, `u:${ip}:${dayKey()}`));
        return send({ available: live.length > 0 && clipsLeft > 0, gpus: live.length, clipsLeftToday: clipsLeft });
      }
      if (path === "/video") {          // submit one clip; returns {id, provider} right away
        const prompt = String(body.prompt || "").slice(0, 300);
        const motion = String(body.motion || "").slice(0, 250);
        const image = String(body.image || "");
        if (!prompt || !image) return send({ error: "Missing image or prompt" }, 400);
        if (image.length > 400000) return send({ error: "Image too large" }, 413);
        const cap = parseInt(env.CLIPS_PER_USER_DAY) || DEFAULT_CLIPS_PER_USER_DAY;
        const ukey = `u:${req.headers.get("CF-Connecting-IP") || "anon"}:${dayKey()}`;
        const userUsed = await kvNum(env, ukey);
        if (userUsed >= cap) return send({ fallback: true, reason: "daily-user-limit" });
        for (const p of await liveProviders(env)) {
          try {
            const up = await fetch(p.url + "/submit", {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-Token": env.RIDEA_TOKEN || "" },
              body: JSON.stringify({ image, prompt, motion }),
              signal: AbortSignal.timeout(25000),
            });
            if (!up.ok) { try { await up.body?.cancel(); } catch {} await cool(env, p.name, up.status); continue; }
            const j = await up.json();
            await kvPut(env, ukey, userUsed + 1, { expirationTtl: 172800 });
            return send({ id: j.id, provider: p.name });
          } catch { await cool(env, p.name, 0); }
        }
        return send({ fallback: true, reason: "no-provider" });
      }
      if (path === "/video-result") {   // poll: returns the MP4 when ready, else {status}
        const provider = String(body.provider || ""), id = String(body.id || "");
        if (!PROVIDERS.includes(provider) || !/^[a-f0-9]{6,32}$/.test(id)) return send({ error: "bad request" }, 400);
        const url = await kvGet(env, "url:" + provider);
        if (!url) return send({ status: "error" });
        try {
          const up = await fetch(url + "/result/" + id, { headers: { "X-Token": env.RIDEA_TOKEN || "" }, signal: AbortSignal.timeout(60000) });
          if ((up.headers.get("Content-Type") || "").includes("video"))
            return new Response(up.body, { status: 200, headers: { ...cors, "Content-Type": "video/mp4", "Cache-Control": "no-store", "X-Video-Provider": provider.toLowerCase() } });
          if (up.status === 404) return send({ status: "error" });
          const j = await up.json().catch(() => ({}));
          return send({ status: j.status || "retry" });
        } catch { return send({ status: "retry" }); }
      }
      return send({ error: "Not found" }, 404);
    } catch (e) {
      const limit = /limit|quota|neuron|capacity/i.test(String(e));
      return send({ error: limit ? "Free daily limit reached — try again after 00:00 UTC" : "Generation failed — try again" }, limit ? 429 : 500);
    }
  },
};
