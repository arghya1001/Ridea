// Ridea backend — Cloudflare Worker using Workers AI (free: 10,000 neurons/day, no card).
// On the Workers Free plan, requests simply fail after the daily limit — you are never charged.
const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const TEXT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast"; // change if Cloudflare retires it

// ---- AI video router -------------------------------------------------------
// A "provider" is any HTTPS endpoint that accepts POST JSON {token, image, prompt, frames}
// (image = base64 JPEG) and answers with an MP4 (Content-Type: video/mp4).
// Turn one on by setting <NAME>_URL and <NAME>_TOKEN in the Worker settings.
// Tries them in order, skips any that are out of free hours or cooling down,
// and tells the app to use the free storybook when none can take the job.
const VIDEO_PROVIDERS = [
  { name: "MODAL",     hours: 30 },  // Modal: $30 free credit / month (about 37 h of an L4 GPU)
  { name: "LIGHTNING", hours: 20 },  // Lightning AI: free monthly credits
];
const VIDEO_FRAMES = 81;                 // 81 frames @ 24 fps = about 3.4 s per scene
const SAFETY = 0.9;                      // stop at 90% of a provider's free budget
const PROVIDER_TIMEOUT_MS = 150000;      // cold start + render
const DEFAULT_CLIPS_PER_USER_DAY = 8;    // protects the free hours from one heavy user

const coolMem = new Map();               // fallback cooldown when no KV is bound
const monthKey = () => new Date().toISOString().slice(0, 7);
const dayKey = () => new Date().toISOString().slice(0, 10);
const activeProviders = env => VIDEO_PROVIDERS
  .filter(p => env[p.name + "_URL"])
  .map(p => ({
    name: p.name, url: env[p.name + "_URL"], token: env[p.name + "_TOKEN"] || "",
    budgetSec: (parseFloat(env[p.name + "_BUDGET_HOURS"]) || p.hours) * 3600 * SAFETY,
  }));
async function kvNum(env, key) {
  if (!env.RIDEA_KV) return 0;
  try { return parseFloat(await env.RIDEA_KV.get(key)) || 0; } catch { return 0; }
}
async function kvPut(env, key, val, opts) {
  if (!env.RIDEA_KV) return;
  try { await env.RIDEA_KV.put(key, String(val), opts); } catch {}
}
async function isCooling(env, name) {
  if ((coolMem.get(name) || 0) > Date.now()) return true;
  if (!env.RIDEA_KV) return false;
  try { return !!(await env.RIDEA_KV.get("cool:" + name)); } catch { return false; }
}
async function cool(env, name, status) {
  const ttl = [402, 403, 429].includes(status) ? 3 * 3600 : 600;   // out of credit -> rest longer
  coolMem.set(name, Date.now() + ttl * 1000);
  await kvPut(env, "cool:" + name, "1", { expirationTtl: ttl });
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
          max_tokens: 500,
          messages: [
            { role: "system", content: 'You write 4-scene mini stories for a 13-second film. Reply with ONLY a JSON array of exactly 4 objects: {"caption": warm narration, max 12 words, "visual": a concrete image description for an illustrator, max 30 words, no text in the image}. No other text.' },
            { role: "user", content: `Story idea: ${idea}` },
          ],
        });
        const raw = typeof out.response === "string" ? out.response : JSON.stringify(out.response);
        const arr = JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1));
        const scenes = arr.slice(0, 4).filter(x => x && x.caption && x.visual).map(x => ({ caption: String(x.caption).slice(0, 90), visual: String(x.visual).slice(0, 240) }));
        if (scenes.length < 4) throw new Error("bad scenes");
        return send({ scenes });
      }
      if (path === "/video-status") {
        const cap = parseInt(env.CLIPS_PER_USER_DAY) || DEFAULT_CLIPS_PER_USER_DAY;
        const ip = req.headers.get("CF-Connecting-IP") || "anon";
        let left = 0, total = 0, avail = false;
        for (const p of activeProviders(env)) {
          total += p.budgetSec;
          if (await isCooling(env, p.name)) continue;
          const used = await kvNum(env, `used:${p.name}:${monthKey()}`);
          if (used < p.budgetSec) { avail = true; left += p.budgetSec - used; }
        }
        const clipsLeft = Math.max(0, cap - await kvNum(env, `u:${ip}:${dayKey()}`));
        return send({ available: avail && clipsLeft > 0, percentLeft: total ? Math.round(100 * left / total) : 0, clipsLeftToday: clipsLeft });
      }
      if (path === "/video") {
        const prompt = String(body.prompt || "").slice(0, 300);
        const image = String(body.image || "");
        if (!prompt || !image) return send({ error: "Missing image or prompt" }, 400);
        if (image.length > 400000) return send({ error: "Image too large" }, 413);
        const cap = parseInt(env.CLIPS_PER_USER_DAY) || DEFAULT_CLIPS_PER_USER_DAY;
        const ukey = `u:${req.headers.get("CF-Connecting-IP") || "anon"}:${dayKey()}`;
        const userUsed = await kvNum(env, ukey);
        if (userUsed >= cap) return send({ fallback: true, reason: "daily-user-limit" });
        for (const p of activeProviders(env)) {
          if (await isCooling(env, p.name)) continue;
          const pkey = `used:${p.name}:${monthKey()}`;
          const used = await kvNum(env, pkey);
          if (used >= p.budgetSec) continue;
          const t0 = Date.now();
          try {
            const up = await fetch(p.url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ token: p.token, image, prompt, frames: VIDEO_FRAMES }),
              signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
            });
            if (!up.ok || !(up.headers.get("Content-Type") || "").includes("video")) {
              try { await up.body?.cancel(); } catch {}
              await cool(env, p.name, up.status);
              continue;
            }
            await kvPut(env, pkey, used + Math.max(1, (Date.now() - t0) / 1000));
            await kvPut(env, ukey, userUsed + 1, { expirationTtl: 172800 });
            return new Response(up.body, { status: 200, headers: { ...cors, "Content-Type": "video/mp4", "Cache-Control": "no-store", "X-Video-Provider": p.name.toLowerCase() } });
          } catch {
            await cool(env, p.name, 0);
          }
        }
        return send({ fallback: true, reason: "no-provider" });
      }
      return send({ error: "Not found" }, 404);
    } catch (e) {
      const limit = /limit|quota|neuron|capacity/i.test(String(e));
      return send({ error: limit ? "Free daily limit reached — try again after 00:00 UTC" : "Generation failed — try again" }, limit ? 429 : 500);
    }
  },
};
