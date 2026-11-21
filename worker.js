// Ridea backend — Cloudflare Worker using Workers AI (free: 10,000 neurons/day, no card).
// On the Workers Free plan, requests simply fail after the daily limit — you are never charged.
const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";          // fallback
const REF_MODEL = "@cf/black-forest-labs/flux-2-klein-4b";           // accepts reference images -> consistent characters
const TEXT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast"; // change if Cloudflare retires it
const VISION_MODEL = "@cf/llava-hf/llava-1.5-7b-hf";                  // checks that every subject is really in each picture
const DIRECTOR_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"; // smarter "film director" for /scenes; falls back to TEXT_MODEL

// ---- AI video (free GPUs: Kaggle / Colab notebooks, no credit card) ---------------
// A free GPU notebook (ridea_video_worker.ipynb) runs LTX-Video and registers its public
// address here every few minutes. If it stops, the address expires on its own and the app
// quietly falls back to the free storybook. Flow:  app -> /video (submit) -> /video-result (poll).
// Needs: a KV namespace bound as RIDEA_KV, and a secret named RIDEA_TOKEN (any password).
const PROVIDERS = ["KAGGLE", "COLAB"];     // names the notebook uses (it picks automatically)
const DEFAULT_CLIPS_PER_USER_DAY = 40;     // 40 clips = 10 films per person per day (the GPU is yours, so this is generous)

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
  const ttl = [402, 403, 429].includes(status) ? 3 * 3600 : (status === 0 || status >= 500) ? 90 : 600;   // a network hiccup must not switch a healthy GPU off for 10 minutes
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

// ---- text AI chain: several free providers, tried in order, so no single free quota can stop a film ----
// A provider is skipped if its key is not set. If one is rate-limited, errors out or returns garbled output,
// the next one is tried. Add keys as Worker secrets: GEMINI_API_KEY, CEREBRAS_API_KEY, OPENROUTER_API_KEY.
// Optional: LLM_ORDER (default "gemini,cerebras,openrouter,cf70,cf8"), GEMINI_MODEL, CEREBRAS_MODEL, OPENROUTER_MODEL.
// Cloudflare comes last on purpose: it keeps its free neurons for the pictures.
const LLM_KEYS = { gemini: "GEMINI_API_KEY", cerebras: "CEREBRAS_API_KEY", openrouter: "OPENROUTER_API_KEY" };
async function coolFor(env, name, sec) {
  coolMem.set(name, Date.now() + sec * 1000);
  await kvPut(env, "cool:" + name, "1", { expirationTtl: Math.max(60, sec) });
}
async function chat(env, p, { max_tokens, messages }) {
  if (p === "cf70" || p === "cf8") {
    const out = await env.AI.run(p === "cf70" ? DIRECTOR_MODEL : TEXT_MODEL, { max_tokens, messages });
    return { response: typeof out.response === "string" ? out.response : JSON.stringify(out.response) };
  }
  const post = async (url, headers, payload) => {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(payload), signal: AbortSignal.timeout(45000) });
    if (!r.ok) { try { await r.body?.cancel(); } catch {} const e = new Error("HTTP " + r.status); e.status = r.status; throw e; }
    return r.json();
  };
  if (p === "gemini") {
    const sys = (messages.find(m => m.role === "system") || {}).content || "";
    const user = messages.filter(m => m.role !== "system").map(m => m.content).join("\n");
    const j = await post(`https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL || "gemini-flash-lite-latest"}:generateContent`,
      { "x-goog-api-key": env.GEMINI_API_KEY },
      { systemInstruction: { parts: [{ text: sys }] }, contents: [{ role: "user", parts: [{ text: user }] }], generationConfig: { maxOutputTokens: max_tokens + 1000 } });
    return { response: ((j.candidates || [{}])[0].content?.parts || []).map(x => x.text || "").join("") };
  }
  const cfg = {
    cerebras: ["https://api.cerebras.ai/v1/chat/completions", env.CEREBRAS_API_KEY, env.CEREBRAS_MODEL || "llama-3.3-70b"],
    openrouter: ["https://openrouter.ai/api/v1/chat/completions", env.OPENROUTER_API_KEY, env.OPENROUTER_MODEL || "meta-llama/llama-3.3-70b-instruct:free"],
  }[p];
  const j = await post(cfg[0], { Authorization: "Bearer " + cfg[1] }, { model: cfg[2], messages, max_tokens });
  return { response: (j.choices || [{}])[0].message?.content || "" };
}
async function chain(env, fn) {
  const order = String(env.LLM_ORDER || "gemini,cerebras,openrouter,cf70,cf8").split(",").map(s => s.trim()).filter(Boolean);
  let last = null, limited = false;
  for (const p of order) {
    if (LLM_KEYS[p] && !env[LLM_KEYS[p]]) continue;
    if (await isCooling(env, "llm:" + p)) continue;
    try { return await fn(p); }
    catch (e) {
      last = e;
      const s = e && e.status, lim = s === 429 || /limit|quota|neuron|capacity/i.test(String(e));
      if (lim) limited = true;
      if (s || lim) await coolFor(env, "llm:" + p, [401, 402, 403].includes(s) ? 3600 : lim ? 600 : 120);   // garbled output does not cool a provider
    }
  }
  if (limited || !last) throw new Error("Free limit reached: every text AI is busy right now");
  throw last;
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
        const prompt = String(body.prompt || "").slice(0, 1500);
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
        const premises = await chain(env, async p => {
        const out = await chat(env, p, {
          max_tokens: 500,
          messages: [
            { role: "system", content: 'You are a creative story developer. Reply with ONLY a JSON array of exactly 3 objects, each {"title": "2-4 words", "blurb": "one vivid sentence"}. No other text.' },
            { role: "user", content: `Topic: ${topic}\nGenre: ${genre}\nGive 3 distinct story directions.` },
          ],
        });
        const raw = out.response;
        const arr = JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1));
        const pr = arr.slice(0, 3).map(x => ({ title: String(x.title), blurb: String(x.blurb) }));
        if (pr.length < 2 || pr.some(x => !x.title || !x.blurb)) throw new Error("bad concepts");
        return pr;
        });
        return send({ premises });
      }
      if (path === "/story") {          // concept -> mini story
        const idea = String(body.idea || "").slice(0, 300);
        if (!idea) return send({ error: "Describe your idea first" }, 400);
        const sys = `You are a warm, imaginative story developer helping someone who only has a rough idea. Turn the idea into a mini story of 4 to 6 short sentences (60-100 words) with a clear beginning, middle and end. Name every main character (a person, an animal, an object) and keep ONE fixed place for the whole story. Quietly adapt anything physically awkward so it can be drawn correctly while keeping what the user asked for (for example a baby on a bike becomes a toddler in a helmet on a small tricycle; a rider on an animal sits securely on it). Keep the action gentle and visual. Reply with ONLY the story text, no title, no quotes, no commentary.`;
        const run = async model => {
          const out = await chat(env, model, { max_tokens: 400, messages: [{ role: "system", content: sys }, { role: "user", content: `Idea: ${idea}` }] });
          const t = (typeof out.response === "string" ? out.response : "").trim().replace(/^["']|["']$/g, "");
          if (t.length < 40) throw new Error("bad story");
          return t.slice(0, 1200);
        };
        let story;
        story = await chain(env, run);
        return send({ story });
      }
      if (path === "/script") {
        const topic = String(body.topic || "").slice(0, 200);
        const genre = String(body.genre || "").slice(0, 40);
        const p = body.premise || {};
        const len = { Short: 350, Medium: 600, Long: 900 }[body.length] || 600;
        const cast = body.cast && body.cast.name ? `Include a character named ${String(body.cast.name).slice(0, 30).toUpperCase()}${body.cast.voice ? ` (voice: ${String(body.cast.voice).slice(0, 40)})` : ""}.` : "";
        const storyTxt = String(body.story || "").slice(0, 1500);
        const callModel = async model => await chat(env, model, {
          max_tokens: len + 300,
          messages: [
            { role: "system", content: 'You are a screenwriter. Keep every character physically realistic for their age (a baby under 1 only lies, sits or is carried; a toddler of 12-18 months can crawl or walk slowly) and name one main toy or object with an exact count. Reply with ONLY a JSON array of script lines, each {"type": one of "transition","heading","action","character","paren","dialogue", "text": string}. Start with FADE IN: and a scene heading. Each dialogue is preceded by a character line and a paren line. No other text.' },
            { role: "user", content: `Topic: ${topic}\n${genre ? `Genre: ${genre}\n` : ""}Direction: ${String(p.title || "")} - ${String(p.blurb || "")}\n${storyTxt ? `Approved story (write the script of exactly this story, same characters and events): ${storyTxt}\n` : ""}${body.withDialogue ? "Include dialogue." : "Narration and action only, no characters speaking."} ${cast}\nLength: ${body.length || "Medium"} (about ${Math.round(len / 2.5)} words).` },
          ],
        });
        const lines = await chain(env, async p => {
          const out = await callModel(p);
          const raw = out.response;
          const arr = JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1));
          const ok = ["transition", "heading", "action", "character", "paren", "dialogue"];
          const ls = arr.filter(l => l && ok.includes(l.type) && l.text).map(l => ({ type: l.type, text: String(l.text) }));
          if (ls.length < 3) throw new Error("bad script");
          return ls;
        });
        return send({ lines });
      }
      if (path === "/scenes") {
        const idea = String(body.idea || "").slice(0, 300);
        if (!idea) return send({ error: "Describe your film idea first" }, 400);
        const sys = `You are an award-winning film director and screenwriter. The user gives a very short idea. Work out what they really want, then plan a 4-scene mini film (13 seconds) with a clear beginning, middle and end.
Reply with ONLY one JSON object: {"story": "...", "sheet": "...", "subjects": ["..."], "scenes": [{"caption": "...", "visual": "...", "motion": "..."}, ...4 items]}.
"subjects": one short phrase (under 15 words) for each main subject, using the same species wording as the sheet, written so a person could check a picture against it, for example "a real adult lion, an animal with a golden mane" and "a human baby with no fur and no mane". The LAST entry must describe the key action or relationship from the idea exactly as the user asked, for example "the baby sits on top of the lion's back, riding it". Every scene must show that action.
"sheet": one paragraph of 40-70 words describing every main subject in precise visual detail and the single setting and time of day. Start each subject with its species in plain words and say what it is NOT, so subjects never blend (for example: "a human baby with smooth human skin and curly brown hair, no fur, no mane, no animal ears or tail, wearing a yellow onesie" and "a real adult male lion, an animal with four legs, a shaggy golden mane and brown fur"). Give each subject a different dominant color so they stay easy to tell apart.
Each scene: "caption" = one complete warm narration sentence of 6-12 words that tells what happens (never a label like "Arrival" or "Gentle ending"). "visual" = 45-60 words for an image generator: restate the subject details from the sheet word for word, then give the shot type (wide or medium only), camera angle, lighting, emotion and ONE simple natural action. No text in the image. "motion" = 30-45 words for a small image-to-video model, which melts and warps limbs if asked for big movement. So use ONLY gentle movement: a slow smooth camera move (slow push-in, or a slow sideways drift), soft light changes, small natural movement of hair, mane, fur, clothes, leaves, water and dust, and tiny life-like motions (blinking, breathing, a small smile, a head slowly turning a little). Describe it in calm present tense in the order it happens, for example: the camera pushes in very slowly, warm sunlight flickers through the leaves, the lion's mane and the baby's curls sway softly in the breeze, the baby smiles and blinks, the lion breathes calmly and blinks, petals drift in the air. NEVER ask for walking, running, jumping, climbing, riding movement, legs or arms crossing, or anything that enters or leaves the frame.
ROLE AND PROPS: if the idea names a role or profession (magician, chef, knight, astronaut, doctor...), the sheet must give that role's instantly recognisable costume and props in exact detail (for example a magician: tall black top hat, black cape with red lining, white gloves, a small wand) and the setting must fit the role (a magician performs on a small theatre stage with a curtain and spotlight, not in a plain room). KEY ACTION IN SCENE 1: the single most important action or object of the idea must be large and unmistakable in scene 1, drawn as an exact pose: for example \"holds the top hat out in front of her chest with both hands while a white rabbit rises halfway out of the hat\". Use a medium-wide shot where the subject fills most of the frame so the small object is big enough to see, never hidden behind a hand or head. CAPTIONS MUST MATCH PICTURES: each caption describes only what is visible in that scene's picture, never an action the picture does not show. STORY FIRST: the pipeline is idea -> mini story -> scenes. "story" = a mini script story of 4 short sentences (about 60-90 words) with a clear beginning, middle and end, naming the characters and the one fixed place. Then write the 4 scenes as exactly the 4 beats of that story, in order. If the user message includes an approved story and/or an approved script, do NOT rewrite them: copy the story into "story" unchanged (or summarise the script in 4 sentences if there is no story) and plan the 4 scenes from the 4 beats of the script, keeping its characters, place and events exactly.
PLAN LIKE A PRODUCER BEFORE WRITING: first decide how an image generator can draw the idea correctly, and quietly adapt the idea where it is physically awkward while keeping what the user asked for. Examples: a baby on a bike becomes a toddler in a helmet on a small tricycle or balance bike; a person riding a big animal gets a visible saddle or a secure seat; anything fast becomes a slow, gentle moment. Give every object an exact count and structure in the sheet (for example "a red tricycle with exactly three wheels and one handlebar") and pick ONE fixed setting that stays the same in all scenes, changing only the angle, the part of the place and the light. Describe the action as an exact body pose in every visual (for example "seated on the saddle, both hands holding the handlebars, both feet on the pedals"), never just "riding". Begin the sheet with the words "Plan:" followed by one short sentence saying what you adapted, if anything, so the user can see it.
Rules: SCENE 1 is the reference picture for every later scene, so it MUST be a wide or full-body medium shot in plain even light where every subject is completely visible, head to toe, clearly separate from each other, with the whole animal and the whole person in frame (never a close-up, never a face-only shot). The action in the idea (for example riding) must be clearly visible in scene 1 and in every scene: a rider sits ON the animal, never beside it. In every scene, repeat the species wording from the sheet for each subject (the human stays human, the animal stays an animal, never mix their features). EVERY scene must show ALL subjects named in the idea together, fully visible, doing exactly what the idea says (for example if a baby rides a lion, the baby sits on the back of the lion in every scene). Never hide, crop out or replace a subject, and add no new main characters. The 4 scenes must NOT look alike: change the shot type (for example wide establishing, medium, low angle, close two-shot), the camera angle, the part of the setting (path, river, clearing, hilltop) and the light (morning mist, midday sun, golden hour, dusk) from scene to scene, while the subjects keep exactly the same look. Show story progress this way. In the motion line everyone stays in the same place in the frame, exactly as in the picture (a rider stays seated and still), nobody turns away from the camera, and no new main subject appears (only leaves, petals, dust and light in the background).`;
        const story = String(body.story || "").slice(0, 2500), script = String(body.script || "").slice(0, 3000);
        const run = async model => {
          const out = await chat(env, model, { max_tokens: 2400, messages: [{ role: "system", content: sys }, { role: "user", content: `Idea: ${idea}` + (story ? `\nApproved story: ${story}` : "") + (script ? `\nApproved script:\n${script}` : "") }] });
          const raw = typeof out.response === "string" ? out.response : JSON.stringify(out.response);
          const obj = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
          const scenes = (obj.scenes || []).slice(0, 4).filter(x => x && x.caption && x.visual).map(x => ({ caption: String(x.caption).slice(0, 90), visual: String(x.visual).slice(0, 520), motion: String(x.motion || "").slice(0, 400) }));
          if (scenes.length < 4) throw new Error("bad scenes");
          return { scenes, story: String(obj.story || story || "").slice(0, 1200), sheet: String(obj.sheet || "").slice(0, 600), subjects: (Array.isArray(obj.subjects) ? obj.subjects : []).slice(0, 4).map(s => String(s).slice(0, 160)).filter(Boolean) };
        };
        let res;
        res = await chain(env, run);
        return send(res);
      }
      if (path === "/compare") {       // pairwise consistency: one side-by-side picture (left = reference scene, right = new scene)
        const image = String(body.image || "");
        if (!image) return send({ ok: true });
        if (image.length > 900000) return send({ error: "Image too large" }, 413);
        const bin = atob(image), bytes = new Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const qs = [
          ["characters", "This image is two pictures side by side. Do the left picture and the right picture show the same main characters, with the same species, face, hair or fur color and body shape? Answer only YES or NO."],
          ["clothes", "This image is two pictures side by side. Are the clothes and main objects (colors and type) the same in the left and the right picture? Answer only YES or NO."],
        ];
        const failed = [];
        await Promise.all(qs.map(async ([name, prompt]) => {
          try {
            const out = await env.AI.run(VISION_MODEL, { image: bytes, max_tokens: 8, prompt });
            if (!/^\W*yes/i.test(String(out.description || out.response || ""))) failed.push(name);
          } catch (e) { /* vision model unavailable: do not block the film */ }
        }));
        return send({ ok: failed.length === 0, failed });
      }
      if (path === "/check") {          // vision check: is every required subject really in the picture?
        const image = String(body.image || "");
        const subjects = (Array.isArray(body.subjects) ? body.subjects : []).slice(0, 4).map(s => String(s).slice(0, 160)).filter(Boolean);
        if (!image || !subjects.length) return send({ ok: true, missing: [] });
        if (image.length > 600000) return send({ error: "Image too large" }, 413);
        const bin = atob(image), bytes = new Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const missing = [];
        await Promise.all(subjects.map(async s => {
          try {
            const out = await env.AI.run(VISION_MODEL, { image: bytes, max_tokens: 8, prompt: `Look carefully at this picture. Is there ${s} clearly visible in it? Answer only YES or NO.` });
            const a = String(out.description || out.response || "");
            if (!/^\W*yes/i.test(a)) missing.push(s);
          } catch (e) { /* vision model unavailable: do not block the film */ }
        }));
        return send({ ok: missing.length === 0, missing });
      }
      if (path === "/video-status") {   // probes every registered notebook, so "online" really means reachable
        const cap = parseInt(env.CLIPS_PER_USER_DAY) || DEFAULT_CLIPS_PER_USER_DAY;
        const ip = req.headers.get("CF-Connecting-IP") || "anon";
        const live = await liveProviders(env);
        const probes = await Promise.all(live.map(async p => {
          try {
            const r = await fetch(p.url + "/result/000000000000", { headers: { "X-Token": env.RIDEA_TOKEN || "" }, signal: AbortSignal.timeout(7000) });
            try { await r.body?.cancel(); } catch {}
            if (r.status === 404) return { ok: true };   // "unknown job" = tunnel works and the password matched
            if (r.status === 401) return { ok: false, why: `${p.name}: the password in the notebook does not match RIDEA_TOKEN on the Worker` };
            return { ok: false, why: `${p.name}: the notebook tunnel answered ${r.status}. Run the notebook again.` };
          } catch (e) { return { ok: false, why: `${p.name}: cannot reach the notebook (it stopped, or the tunnel is down). Run it again.` }; }
        }));
        const good = probes.filter(x => x.ok).length;
        const clipsLeft = Math.max(0, cap - await kvNum(env, `u:${ip}:${dayKey()}`));
        const detail = probes.filter(x => !x.ok).map(x => x.why).join(" | ") || (live.length ? "" : "No notebook has registered with the Worker in the last 25 minutes.");
        return send({ available: good > 0 && clipsLeft > 0, gpus: good, clipsLeftToday: clipsLeft, detail });
      }
      if (path === "/video") {          // submit one clip; returns {id, provider} right away
        const prompt = String(body.prompt || "").slice(0, 700);
        const image = String(body.image || "");
        if (!prompt || !image) return send({ error: "Missing image or prompt" }, 400);
        if (image.length > 400000) return send({ error: "Image too large" }, 413);
        const cap = parseInt(env.CLIPS_PER_USER_DAY) || DEFAULT_CLIPS_PER_USER_DAY;
        const ukey = `u:${req.headers.get("CF-Connecting-IP") || "anon"}:${dayKey()}`;
        const userUsed = await kvNum(env, ukey);
        if (userUsed >= cap) return send({ fallback: true, reason: "daily-user-limit" });
        const errs = [], sleep = ms => new Promise(r => setTimeout(r, ms));
        const providers = (await liveProviders(env)).sort(() => Math.random() - 0.5);   // spread clips across every online GPU
        for (const p of providers) {
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const up = await fetch(p.url + "/submit", {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-Token": env.RIDEA_TOKEN || "" },
                body: JSON.stringify({ image, prompt }),
                signal: AbortSignal.timeout(25000),
              });
              if (!up.ok) {
                try { await up.body?.cancel(); } catch {}
                if (attempt === 0 && up.status >= 500) { await sleep(1500); continue; }
                errs.push(up.status === 401 ? `${p.name}: password mismatch` : up.status === 503 ? `${p.name}: GPU queue is full` : `${p.name}: HTTP ${up.status}`);
                await cool(env, p.name, up.status);
                break;
              }
              const j = await up.json();
              await kvPut(env, ukey, userUsed + 1, { expirationTtl: 172800 });
              return send({ id: j.id, provider: p.name });
            } catch (e) {
              if (attempt === 0) { await sleep(1500); continue; }
              errs.push(`${p.name}: ${e && e.name === "TimeoutError" ? "did not answer in time" : "unreachable"}`);
              await cool(env, p.name, 0);
            }
          }
        }
        return send({ fallback: true, reason: "no-provider", detail: errs.length ? errs.join(" | ") : "No GPU notebook is registered. Start the Kaggle or Colab notebook." });
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
          return send({ status: j.status || "retry", http: up.status });
        } catch { return send({ status: "retry" }); }
      }
      return send({ error: "Not found" }, 404);
    } catch (e) {
      const limit = /limit|quota|neuron|capacity/i.test(String(e));
      return send({ error: limit ? "Free daily limit reached — try again after 00:00 UTC" : "Generation failed — try again" }, limit ? 429 : 500);
    }
  },
};
