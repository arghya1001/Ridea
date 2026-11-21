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
// ---- Gemini helpers: picture checking, speech-to-text and text-to-speech (need the GEMINI_API_KEY secret) ----
async function geminiCall(env, parts, o = {}) {
  if (!env.GEMINI_API_KEY) throw new Error("no gemini key");
  const model = o.model || env.GEMINI_VISION_MODEL || env.GEMINI_MODEL || "gemini-flash-lite-latest";
  const gen = o.gen && o.gen.responseModalities ? o.gen : Object.assign({ temperature: 0.2, maxOutputTokens: o.max || 400 }, o.json ? { responseMimeType: "application/json" } : {}, o.gen || {});
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: gen }), signal: AbortSignal.timeout(25000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error((j.error && j.error.message) || "gemini " + r.status); e.status = r.status; throw e; }
  return j;
}
const geminiText = j => (((j.candidates || [])[0] || {}).content || { parts: [] }).parts.map(p => p.text || "").join("");
const geminiJson = j => { const t = geminiText(j); return JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)); };

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
        const prompt = String(body.prompt || "").slice(0, 3600);
        if (!prompt) return send({ error: "Describe the image first" }, 400);
        const W = Math.min(1024, Math.max(256, (parseInt(body.w) || 1024) & ~15)), H = Math.min(1024, Math.max(256, (parseInt(body.h) || 1024) & ~15));
        const ref = String(body.ref || "");
        if (ref.length > 300000) return send({ error: "Reference too large" }, 413);
        const refs = (Array.isArray(body.refs) ? body.refs : (ref ? [ref] : [])).slice(0, 3).map(String).filter(r => r && r.length <= 300000);
        const tail = ". Sharp, clean image, no text, watermark, signature or logo.";
        const tryKlein = async list => {   // best quality: FLUX.2 klein, conditioned on one or more reference pictures
          const form = new FormData();
          form.append("prompt", prompt + tail);
          form.append("width", String(W)); form.append("height", String(H));
          if (body.seed) form.append("seed", String(parseInt(body.seed) || 1));
          list.forEach((r, k) => {
            const bin = atob(r), u8 = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
            form.append("input_image_" + k, new Blob([u8], { type: "image/jpeg" }));
          });
          const fr = new Response(form);
          const out = await env.AI.run(REF_MODEL, { multipart: { body: fr.body, contentType: fr.headers.get("content-type") } });
          return out && out.image ? out.image : null;
        };
        for (const list of (refs.length > 1 ? [refs, refs.slice(0, 1)] : [refs])) {   // several references first; if the model refuses them, use just the first
          try { const img = await tryKlein(list); if (img) return send({ image: img, model: "klein", refs: list.length }); }
          catch (e) { if (/limit|quota|neuron|capacity/i.test(String(e))) throw e; }
        }
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
      if (path === "/director") {       // voice/chat "assistant director": talks an idea through and keeps a running film concept
        const msgs = (Array.isArray(body.messages) ? body.messages : []).slice(-14).map(m => ({ role: m && m.role === "assistant" ? "assistant" : "user", content: String((m && m.content) || "").slice(0, 600) })).filter(m => m.content);
        if (!msgs.length || msgs[msgs.length - 1].role !== "user") return send({ error: "Say or type your idea first" }, 400);
        const langName = { "en-IN": "English", "hi-IN": "Hindi", "bn-IN": "Bengali" }[String(body.lang || "")] || "";
        const sys = `You are Ridea, a warm, sharp film director and creative partner. You help the user shape a rough idea into a short vertical story film (about 13 seconds, 4 scenes). The user talks to you by voice, so write the way you would speak: 1 to 3 short sentences, no lists, no markdown, no emojis. Reply in the same language the user used (English, Hindi, Bengali, or Hinglish in Roman letters if they wrote that way); write Hindi in Devanagari and Bengali in Bengali script.${langName ? " The user picked " + langName + " for this conversation, so reply in " + langName + " unless they clearly switch language." : ""} Each turn: react briefly, add ONE concrete suggestion or offer two options (tone, twist, character look, ending), and ask ONE short question. Keep exactly what the user asked for; never replace their idea. When the user says go ahead, ready or start, or after about 3 exchanges, say the idea is ready and invite them to tap Make the film. Reply with ONLY one JSON object: {"reply":"what you say","ready":false,"concept":"..."}. "concept" = the running film idea in ENGLISH, one clear paragraph of 30-70 words naming the main characters (age, look, costume), the one place, and a beginning, middle and end of the key action, including every choice the user agreed to. "ready" = true once the concept is complete.`;
        const run = async model => {
          const out = await chat(env, model, { max_tokens: 500, messages: [{ role: "system", content: sys }, ...msgs] });
          const raw = typeof out.response === "string" ? out.response : JSON.stringify(out.response);
          const obj = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
          const reply = String(obj.reply || "").trim().slice(0, 600);
          if (!reply) throw new Error("bad reply");
          return { reply, ready: !!obj.ready, concept: String(obj.concept || "").trim().slice(0, 800) };
        };
        return send(await chain(env, run));
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
      if (path === "/stories") {        // concept -> 3 different story versions to choose from
        const idea = String(body.idea || "").slice(0, 300);
        if (!idea) return send({ error: "Describe your idea first" }, 400);
        const sys = `You are a warm, imaginative story developer. The user gives a rough idea. Write 3 DIFFERENT story versions of it, each of 4 to 6 short sentences (60-90 words) with a clear beginning, middle and end. Make them clearly different from each other: version 1 heartwarming, version 2 funny and playful, version 3 magical or adventurous. In every version keep exactly what the user asked for, name every main character, keep ONE fixed place (name it, for example a circus ring or a garden), and keep the action visual and simple enough for a picture. Quietly adapt anything physically awkward (a baby on a bike becomes a toddler in a helmet on a tricycle). Reply with ONLY one JSON object: {"stories":[{"title":"2-4 word title","story":"..."},{"title":"...","story":"..."},{"title":"...","story":"..."}]}`;
        const run = async model => {
          const out = await chat(env, model, { max_tokens: 1400, messages: [{ role: "system", content: sys }, { role: "user", content: `Idea: ${idea}` }] });
          const raw = typeof out.response === "string" ? out.response : JSON.stringify(out.response);
          const obj = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
          const stories = (obj.stories || []).slice(0, 3).filter(x => x && String(x.story || "").length > 40).map(x => ({ title: String(x.title || "Story").slice(0, 40), story: String(x.story).slice(0, 1200) }));
          if (stories.length < 2) throw new Error("bad stories");
          return { stories };
        };
        return send(await chain(env, run));
      }
      if (path === "/scenes") {
        const idea = String(body.idea || "").slice(0, 300);
        if (!idea) return send({ error: "Describe your film idea first" }, 400);
        // The model only fills in a small "story bible"; the CODE then builds every image prompt from it,
        // so the same characters, costume, props and place are repeated word for word in all 4 scenes.
        const sys = `You are a film director planning a storyboard: one picture per visible story step. The user gives a short idea (and maybe an approved story and script). An image generator will paint each scene from your words alone and knows NOTHING about the story, so every scene needs a complete shot sheet that says who is visible, exactly where each one stands, what each hand holds, and what is NOT in the picture. Reply with ONLY one JSON object:
{"story":"...","plan":"...","characters":[{"name":"...","short":"...","look":"..."}],"objects":[{"name":"...","look":"..."}],"setting":"...","beats":[{"caption":"...","camera":"...","backdrop":"...","positions":[{"who":"...","where":"...","facing":"...","head":"...","pose":"...","hands":"...","face":"..."}],"props":"...","absent":["..."],"light":"...","must_show":["..."],"motion":"..."}]}
"story": a short retelling with beginning, middle and end, naming the characters and the one fixed place. If an approved story or script is given, keep its characters, place and events exactly and make the beats follow it in order.
"plan": one short sentence saying what you adapted to make the idea drawable, or an empty string.
"characters": 1 to 5 main characters (animals and important objects count too). Short unique names. "short" = under 15 words a person could use to check a picture. "look" = 20-30 words of exact visual detail: species in plain words and what it is NOT (for example "human baby, no fur, no tail"), age, hair or fur, and the full costume and props with exact counts and colors. If the idea names a role (magician, chef, knight, astronaut...), the look MUST include that role's recognisable costume and prop (a knight: silver armor, red cape, a sword; a prop the story is about is listed under objects, not in the look). Give each character a different dominant color and ONE or TWO easy-to-draw clothing or accessory details (a puppy: pure white fur and a blue collar; a girl: a green coat and a red scarf), written BEFORE any other detail. NEVER invent face or body marks: no scars, patches, eye patches, piercings, tattoos, necklaces, glasses, freckles or makeup. Repeat the same details exactly in every beat. Adapt physically awkward ideas (a baby on a bike becomes a toddler in a helmet on a tricycle).
"objects": the 1-3 story-critical props the story is about (a box, a ball, a hat...). "name" = a plain unique name. "look" = 15-25 words: exact shape, size, color and material. Each object is ONE single physical thing for the whole film: the SAME object in every beat, never a second copy, and no character wears or carries another object of the same kind. Its state may change from beat to beat (worn, held, empty, open, with something coming out of it) and every beat's "props" field states the exact state. A character's "look" does not describe a story-critical object: it appears in "objects" and in each beat's "props", and when a character wears or holds it, "head" or "hands" says so.
"setting": one fixed place with 4 fixed visible elements and a time of day, 20-30 words, matching the idea (a kitchen: a wooden table, a window with curtains, a stove and a hanging lamp, morning light). The place never changes between scenes.
"beats": a storyboard of as many beats as the story really needs to be told clearly, no more and no fewer: one beat for a single moment, 2 or 3 for a very simple idea, more when the story has several distinct visible steps (5, 8, 12 or more if it takes that). Give every distinct visible action its own beat, in story order, and never skip a step or pad with filler. Beat 1 sets the scene and the last beat is the ending. For each beat:
"caption" = one warm sentence of 6-12 words describing ONLY what is visible in that picture.
"camera" = shot size, angle and height, for example "wide full-body shot, eye level, camera 4 metres away" (beat 1 must be wide or medium full-body so every character is fully visible; each later beat uses the camera that best shows its step, clearly different from the beat before it).
"backdrop" = which setting elements are visible behind the characters and where in the frame (for example "brick wall fills the background, a window on the right, sunlight from the top left").
"positions" = one entry for EVERY character visible in this picture, and no one else. "who" = the character's name. "where" = exact place in the frame and on the floor, using left, center, right, near, far and what they are next to (for example "center of the frame, standing on the grass one step in front of the fence"). "facing" = toward the camera, to the left, to the right, or at another character. "pose" = exact body pose. "head" = exactly what is on the head (describe only what IS there, in positive words, for example "wearing the red cap" or "short curly brown hair"). "hands" = exactly what each hand holds or does. "face" = the expression.
"props" = the exact position and state of each key object in this picture, repeating the same object word for word (for example "the green watering can is tilted in her right hand and water streams out onto the red tulip"). The object the story is about stays visible in every beat where it matters. Every beat shows a DIFFERENT moment of the story, in story order. A character is present in exactly the beats where the story has them acting. An animal or small creature is always its own separate body next to or held by a person, never attached to a head or body.
"absent" = things or characters that must NOT appear in this picture. Only characters who truly have not appeared yet in the story go here; follow the story's own order. Never list a character here if the story shows them in this beat.
"light" = a few words (for example "warm spotlight from the top left, soft shadows").
"must_show" = 2-4 short things that MUST be visible.
"motion" = 30-45 words of ONLY gentle movement for a small image-to-video model: a slow camera push-in or drift, soft light changes, hair, fur, cloth and leaves swaying, blinking, breathing, a small smile. NEVER walking, running, jumping, climbing or anything entering or leaving the frame.`;
        const story = String(body.story || "").slice(0, 2500), script = String(body.script || "").slice(0, 3000);
        const run = async model => {
          const out = await chat(env, model, { max_tokens: 7500, messages: [{ role: "system", content: sys }, { role: "user", content: `Idea: ${idea}` + (story ? `\nApproved story: ${story}` : "") + (script ? `\nApproved script:\n${script}` : "") }] });
          const raw = typeof out.response === "string" ? out.response : JSON.stringify(out.response);
          const obj = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
          const chars = (Array.isArray(obj.characters) ? obj.characters : []).slice(0, 5).filter(c => c && c.look);
          const setting = String(obj.setting || "").slice(0, 240);
          const beats = (Array.isArray(obj.beats) ? obj.beats : obj.scenes || []).slice(0, 24).filter(x => x && x.caption);
          if (!chars.length || !setting || beats.length < 1) throw new Error("bad plan");
          const findChar = who => { const q = String(who || "").toLowerCase().trim(); return chars.find(c => c.name && (String(c.name).toLowerCase() === q || q.includes(String(c.name).toLowerCase()) || String(c.name).toLowerCase().includes(q))); };
          const BAD = /[,;(]?\s*\b(?:a |an |one |tiny |small |silver |black |dark )*(?:nose ring|nose piercing|piercings?|tattoos?|scars?|eye ?patch(?:es)?|patch(?:es)? (?:around|over|on)[^,.;)]*|necklaces?|glasses|freckles|birthmarks?|makeup)\b[^,.;)]*/gi;
          const clip = (s, n) => { s = String(s || ""); if (s.length <= n) return s; const cut = s.slice(0, n), k = Math.max(cut.lastIndexOf(","), cut.lastIndexOf(" ")); return (k > n * 0.6 ? cut.slice(0, k) : cut).replace(/[,\s]+$/, ""); };
          const looks = (c, n) => (c.name ? String(c.name).slice(0, 20) + ": " : "") + clip(String(c.look).replace(BAD, "").replace(/[,;]?\s*identifying marks?:\s*$/i, "").replace(/identifying marks?:/gi, "details:").replace(/[,;(]?\s*\b(no|not|never|without)\b[^,.;)]*/gi, ""), n);
          const charTxt = chars.map(c => looks(c, 260)).join(" ");
          const t = (x, n) => String(x || "").replace(/\b(bare[- ]headed|bare head|hatless)\b/gi, "uncovered curly hair").replace(/[,;(]?\s*\b(no|not|never|without)\b[^,.;)]*/gi, "").replace(/\s{2,}/g, " ").trim().slice(0, n);
          const objs = (Array.isArray(obj.objects) ? obj.objects : []).slice(0, 2).filter(o => o && o.name && o.look).map(o => `${t(o.name, 30)}: ${t(o.look, 150)}`).join(" ");
          const scenes = beats.map(b => {
            const posList = (Array.isArray(b.positions) ? b.positions : []).filter(p => p && p.who).slice(0, 3);
            if (!posList.length) throw new Error("bad plan");
            const here = posList.map(p => findChar(p.who)).filter(Boolean);
            const detail = n => posList.map(p => { const c = findChar(p.who); return `${c ? looks(c, n) : t(p.who, 30)}. Position: ${t(p.where, 110)}, facing ${t(p.facing, 30)}. Head: ${t(p.head, 60)}. Pose: ${t(p.pose, 140)}. Hands: ${t(p.hands, 140)}. Face: ${t(p.face, 30)}.`; }).join(" ");
            const absent = (Array.isArray(b.absent) ? b.absent : []).slice(0, 4).map(s => t(s, 40)).filter(Boolean).join(", ");
            const must = (Array.isArray(b.must_show) ? b.must_show : []).slice(0, 4).map(s => t(s, 50)).filter(Boolean).join(", ");
            const common = `${objs ? "Key object details: " + objs + ". " : ""}Key objects in this picture: ${t(b.props, 160)}.${must ? " Must be clearly visible: " + must + "." : ""} Light: ${t(b.light, 60)}.`;
            return {
              caption: t(b.caption, 90),
              visual: `What happens: ${t(b.caption, 90)}. Camera: ${t(b.camera, 90)}. Setting: ${setting.replace(/[.\s]+$/, "")}. Visible behind: ${t(b.backdrop, 140)}. ${detail(260)} ${common} Every character listed is fully visible. No text in the image.`.slice(0, 2600),
              edit: `What happens: ${t(b.caption, 90)}. Camera: ${t(b.camera, 90)}. Visible behind: ${t(b.backdrop, 140)}. ${detail(200)} ${common}`.slice(0, 2200),   // used when a reference picture exists: written as an edit
              absent: (Array.isArray(b.absent) ? b.absent : []).slice(0, 4).map(s => t(s, 40)).filter(Boolean),
              present: (here.length ? here : chars).map(c => String(c.name || "").slice(0, 30)),
              subjects: (here.length ? here : chars).map(c => String(c.short || c.look).slice(0, 120)),
              motion: t(b.motion, 400),
            };
          });
          const plan = String(obj.plan || "").slice(0, 160);
          const sheet = ((plan ? "Plan: " + plan + " " : "") + charTxt + (objs ? " Objects: " + objs : "") + " Setting: " + setting).slice(0, 1400);
          const subjects = chars.map(c => String(c.short || c.look).slice(0, 120));
          return { scenes, story: String(obj.story || story || "").slice(0, 1200), sheet, subjects };
        };
        return send(await chain(env, run));
      }
      if (path === "/transcribe") {     // speech to text with Gemini (English, Hindi, Bengali and mixes)
        const audio = String(body.audio || ""), mime = String(body.mime || "audio/webm").slice(0, 40);
        if (!audio) return send({ error: "No audio" }, 400);
        if (audio.length > 2000000) return send({ error: "Recording too long" }, 413);
        if (!env.GEMINI_API_KEY) return send({ error: "Voice transcription needs the GEMINI_API_KEY secret" }, 400);
        try {
          const j = await geminiCall(env, [{ text: "Transcribe this speech exactly as spoken. The speaker may use English, Hindi or Bengali, or a mix. Write Hindi in Devanagari script and Bengali in Bengali script. Reply with ONLY the transcript and nothing else. If there is no speech, reply with an empty string." }, { inline_data: { mime_type: mime, data: audio } }], { max: 400 });
          return send({ text: geminiText(j).trim().slice(0, 800) });
        } catch (e) { return send({ error: /limit|quota|429/i.test(String(e)) ? "Free limit reached: Gemini is busy right now" : "Could not transcribe (" + String(e.message || e).slice(0, 80) + ")" }, e.status === 429 ? 429 : 502); }
      }
      if (path === "/speak") {          // text to speech with Gemini, used when the phone has no voice for the language
        const text = String(body.text || "").slice(0, 600);
        if (!text) return send({ error: "No text" }, 400);
        if (!env.GEMINI_API_KEY) return send({ error: "Spoken replies need the GEMINI_API_KEY secret" }, 400);
        try {
          const j = await geminiCall(env, [{ text }], { model: env.GEMINI_TTS_MODEL || "gemini-2.5-flash-preview-tts", gen: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: env.GEMINI_VOICE || "Kore" } } } }, max: 2000 });
          const part = (((j.candidates || [])[0] || {}).content || { parts: [] }).parts.find(p => p.inlineData || p.inline_data);
          const d = part && (part.inlineData || part.inline_data);
          if (!d || !d.data) throw new Error("no audio returned");
          const m = /rate=(\d+)/.exec(d.mimeType || d.mime_type || "");
          return send({ pcm: d.data, rate: m ? parseInt(m[1]) : 24000 });
        } catch (e) { return send({ error: "Could not speak (" + String(e.message || e).slice(0, 80) + ")" }, e.status === 429 ? 429 : 502); }
      }
      if (path === "/compare") {       // pairwise consistency: one side-by-side picture (left = reference scene, right = new scene)
        const image = String(body.image || "");
        if (!image) return send({ ok: true });
        if (image.length > 900000) return send({ error: "Image too large" }, 413);
        if (env.GEMINI_API_KEY) {
          try {
            const j = await geminiCall(env, [{ text: 'This image shows two pictures side by side from the same film. The left one is the reference scene, the right one is a new scene. Judge ONLY the characters, animals and objects that appear in BOTH pictures: are they the same (same species, face, hair or fur color, body shape, clothing colors, same props)? Different poses, camera angles, backgrounds and light are fine. Reply ONLY {"same":true or false,"differences":["short description of each real difference"]}' }, { inline_data: { mime_type: "image/jpeg", data: image } }], { json: true, max: 250 });
            const r = geminiJson(j);
            const diffs = (Array.isArray(r.differences) ? r.differences : []).map(s => String(s).slice(0, 70)).slice(0, 3);
            return send({ ok: r.same !== false, failed: diffs, by: "gemini" });
          } catch (e) { /* fall through */ }
        }
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
        if (body.exact) {   // describe first, then a text model compares the description with the checklist
          const absent = (Array.isArray(body.absent) ? body.absent : []).slice(0, 5).map(s => String(s).slice(0, 60)).filter(Boolean);
          if (env.GEMINI_API_KEY) {   // Gemini looks at the picture and compares it with the checklist in one step
            try {
              const j = await geminiCall(env, [{ text: `You check one picture from a film storyboard against a checklist. Look at it carefully.\nExpected to be visible: ${subjects.join("; ")}\nMust NOT be visible: ${absent.join("; ") || "nothing in particular"}\nNo other person or animal may appear besides the expected ones, and no expected character may appear twice.\nReply ONLY {"missing":["expected items that are not in the picture"],"unexpected":["people, animals or objects that are not expected, appear twice, or are in the must-not-be-visible list"]}` }, { inline_data: { mime_type: "image/jpeg", data: image } }], { json: true, max: 300 });
              const r = geminiJson(j);
              const miss = (Array.isArray(r.missing) ? r.missing : []).map(s => String(s).slice(0, 80)), extra = (Array.isArray(r.unexpected) ? r.unexpected : []).map(s => String(s).slice(0, 80));
              return send({ ok: !miss.length && !extra.length, missing: miss, unexpected: extra, by: "gemini" });
            } catch (e) { /* fall through to the Cloudflare vision path */ }
          }
          try {
            const o = await env.AI.run(VISION_MODEL, { image: bytes, max_tokens: 230, prompt: "Describe this picture in detail. List every person and every animal one by one: say what each is, what it wears on its head and body, what it holds in its hands, and where it stands. Also name any other main objects." });
            const desc = String(o.description || o.response || "").slice(0, 1500);
            if (desc.length < 25) return send({ ok: true, missing: [], unexpected: [] });
            const j = await env.AI.run(DIRECTOR_MODEL, { max_tokens: 220, messages: [
              { role: "system", content: "You compare a picture description with a checklist. Reply with ONLY one JSON object." },
              { role: "user", content: `Picture description: ${desc}\nExpected to be visible: ${subjects.join("; ")}\nMust NOT be visible: ${absent.join("; ") || "nothing in particular"}\nNo other person or animal may appear besides the expected ones, and no expected character may appear twice.\nReply ONLY {"missing":["expected items that are not in the description"],"unexpected":["people, animals or objects in the description that are not expected, appear twice, or are in the must-not-be-visible list"]}` }] });
            const raw = typeof j.response === "string" ? j.response : JSON.stringify(j.response);
            const r = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
            const miss = (Array.isArray(r.missing) ? r.missing : []).map(s => String(s).slice(0, 80)), extra = (Array.isArray(r.unexpected) ? r.unexpected : []).map(s => String(s).slice(0, 80));
            return send({ ok: !miss.length && !extra.length, missing: miss, unexpected: extra });
          } catch (e) { return send({ ok: true, missing: [], unexpected: [] }); }   // checker unavailable: never block the film
        }
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
