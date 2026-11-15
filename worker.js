// Ridea backend — Cloudflare Worker using Workers AI (free: 10,000 neurons/day, no card).
// On the Workers Free plan, requests simply fail after the daily limit — you are never charged.
const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const TEXT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast"; // change if Cloudflare retires it

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
      return send({ error: "Not found" }, 404);
    } catch (e) {
      const limit = /limit|quota|neuron|capacity/i.test(String(e));
      return send({ error: limit ? "Free daily limit reached — try again after 00:00 UTC" : "Generation failed — try again" }, limit ? 429 : 500);
    }
  },
};
