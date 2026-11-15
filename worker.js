// Ridea backend — Cloudflare Worker using Workers AI (free: 10,000 neurons/day, no card).
// On the Workers Free plan, requests simply fail after the daily limit — you are never charged.
const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";          // fallback
const REF_MODEL = "@cf/black-forest-labs/flux-2-klein-4b";           // accepts reference images -> consistent characters
const TEXT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast"; // change if Cloudflare retires it
const DIRECTOR_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"; // smarter "film director" for /scenes; falls back to TEXT_MODEL

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
        const prompt = String(body.prompt || "").slice(0, 900);
        if (!prompt) return send({ error: "Describe the image first" }, 400);
        const W = Math.min(1024, Math.max(256, (parseInt(body.w) || 1024) & ~15)), H = Math.min(1024, Math.max(256, (parseInt(body.h) || 1024) & ~15));
        const ref = String(body.ref || "");
        if (ref.length > 300000) return send({ error: "Reference too large" }, 413);
        const tail = ". Sharp, clean image, no text, watermark, signature or logo.";
        try {   // best quality: FLUX.2 klein, optionally conditioned on the first scene's picture
          const form = new FormData();
          form.append("prompt", prompt + tail);
          form.append("width", String(W)); form.append("height", String(H));
          if (body.seed) form.append("seed", String(parseInt(body.seed) || 1));
          if (ref) {
            const bin = atob(ref), u8 = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
            form.append("input_image_0", new Blob([u8], { type: "image/jpeg" }));
          }
          const fr = new Response(form);
          const out = await env.AI.run(REF_MODEL, { multipart: { body: fr.body, contentType: fr.headers.get("content-type") } });
          if (out && out.image) return send({ image: out.image, model: "klein" });
        } catch (e) { if (/limit|quota|neuron|capacity/i.test(String(e))) throw e; }
        const out = await env.AI.run(IMAGE_MODEL, { prompt: prompt.slice(0, 500) + tail, steps: 4 });   // fallback: no reference
        return send({ image: out.image, model: "schnell" });
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
        const idea = String(body.idea || "").slice(0, 300);
        if (!idea) return send({ error: "Describe your film idea first" }, 400);
        const sys = `You are an award-winning film director and screenwriter. The user gives a very short idea. Work out what they really want, then plan a 4-scene mini film (13 seconds) with a clear beginning, middle and end.
Reply with ONLY one JSON object: {"sheet": "...", "scenes": [{"caption": "...", "visual": "...", "motion": "..."}, ...4 items]}.
"sheet": one paragraph of 40-70 words describing every main subject in precise visual detail (species or age, colors, clothing, distinctive features) and the single setting and time of day.
Each scene: "caption" = warm narration, max 12 words. "visual" = 45-60 words for an image generator: restate the subject details from the sheet word for word, then give the shot type (wide or medium only), camera angle, lighting, emotion and ONE simple natural action. No text in the image. "motion" = 6-14 words of tiny natural movement only.
Rules: EVERY scene must show ALL subjects named in the idea together, fully visible, doing exactly what the idea says (for example if a baby rides a lion, the baby sits on the back of the lion in every scene). Never hide, crop out or replace a subject, and add no new main characters. Show story progress through mood, light and place (arrival, discovery, joyful peak, gentle ending). In the motion line nobody turns around, walks, runs, jumps or leaves the frame, nothing new appears, and the camera barely moves.`;
        const run = async model => {
          const out = await env.AI.run(model, { max_tokens: 1800, messages: [{ role: "system", content: sys }, { role: "user", content: `Idea: ${idea}` }] });
          const raw = typeof out.response === "string" ? out.response : JSON.stringify(out.response);
          const obj = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
          const scenes = (obj.scenes || []).slice(0, 4).filter(x => x && x.caption && x.visual).map(x => ({ caption: String(x.caption).slice(0, 90), visual: String(x.visual).slice(0, 520), motion: String(x.motion || "").slice(0, 120) }));
          if (scenes.length < 4) throw new Error("bad scenes");
          return { scenes, sheet: String(obj.sheet || "").slice(0, 600) };
        };
        let res;
        try { res = await run(DIRECTOR_MODEL); } catch (e) { res = await run(TEXT_MODEL); }
        return send(res);
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
              body: JSON.stringify({ image, prompt }),
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
