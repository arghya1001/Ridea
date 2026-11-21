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
        const prompt = String(body.prompt || "").slice(0, 2600);
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
        const sys = `You are a film director planning a 4-scene mini film (13 seconds). The user gives a short idea (and maybe an approved story and script). An image generator will paint each scene from your words alone and knows NOTHING about the story, so every scene needs a complete shot sheet that says who is visible, exactly where each one stands, what each hand holds, and what is NOT in the picture. Reply with ONLY one JSON object:
{"story":"...","plan":"...","characters":[{"name":"...","short":"...","look":"..."}],"objects":[{"name":"...","look":"..."}],"setting":"...","beats":[{"caption":"...","camera":"...","backdrop":"...","positions":[{"who":"...","where":"...","facing":"...","pose":"...","hands":"...","face":"..."}],"props":"...","absent":["..."],"light":"...","must_show":["..."],"motion":"..."}]}
"story": 4 short sentences with beginning, middle and end, naming the characters and the one fixed place. If an approved story or script is given, keep its characters, place and events exactly and make the 4 beats follow it in order.
"plan": one short sentence saying what you adapted to make the idea drawable, or an empty string.
"characters": 1 to 3 main characters (animals and important objects count too). Short unique names. "short" = under 15 words a person could use to check a picture. "look" = 25-35 words of exact visual detail: species in plain words and what it is NOT (for example "human baby, no fur, no tail"), age, hair or fur, and the full costume and props with exact counts and colors. If the idea names a role (magician, chef, knight, astronaut...), the look MUST include that role's recognisable costume and prop (a magician: tall black top hat, black cape with red lining, white gloves, small wand). Give each character a different dominant color and 2 unmistakable identifying marks (for example a rabbit: pure white fur with one black patch around the left eye and a red ribbon on its neck; a girl: a yellow dress with a green handbag) and always repeat the same marks exactly. Adapt physically awkward ideas (a baby on a bike becomes a toddler in a helmet on a tricycle).
"objects": the 1-2 story-critical props (the hat, the box, the ball...). "name" = a plain unique name. "look" = 15-25 words: exact shape, size, color, material and state (for example "a tall black silk top hat, a cylinder with a flat round brim, held upside down with its wide opening facing up, empty"). Each object must be UNIQUE: no character wears or carries another object of the same kind, so a picture can never mix them up (a magician who pulls a rabbit from a hat has exactly ONE hat: in a beat where she holds it out to show it is empty, or pulls the rabbit from it, the hat is in her hands and her head is bare; she never wears a second hat while holding it; the rabbit never comes from a box or case). Repeat the object word for word in the beats.
"setting": one fixed place with 4 fixed visible elements and a time of day, 20-30 words, matching the idea (a circus magician: a circus ring with a red and white striped tent, a sawdust floor, a bright spotlight and a red curtain). The place never changes between scenes.
"beats": exactly 4, following the story in order. For each beat:
"caption" = one warm sentence of 6-12 words describing ONLY what is visible in that picture.
"camera" = shot size, angle and height, for example "wide full-body shot, eye level, camera 4 metres away" (beat 1 must be wide or medium full-body so every character is fully visible; beats 2-4 must use a clearly different camera from beat 1, for example low angle, side view, closer medium shot).
"backdrop" = which setting elements are visible behind the characters and where in the frame (for example "striped tent wall fills the background, red curtain on the right, spotlight cone from the top left").
"positions" = one entry for EVERY character visible in this picture, and no one else. "who" = the character's name. "where" = exact place in the frame and on the floor, using left, center, right, near, far and what they are next to (for example "center of the frame, standing on the sawdust one step in front of the red curtain"). "facing" = toward the camera, to the left, to the right, or at another character. "pose" = exact body pose. "hands" = exactly what each hand holds or does. "face" = the expression.
"props" = the exact position and state of the key objects, for example "she has taken the black top hat off her head and tilts it toward the camera at chest height so its empty inside is clearly visible, her head bare". The object the story is about must stay visible in every beat where it matters (for a rabbit from a hat: beat 1 the empty open hat, beat 2 the wand raised above the open hat, beat 3 the rabbit's ears and head rising out of the hat's opening with the hat in frame, beat 4 the rabbit out in the open).
"absent" = things or characters that must NOT appear in this picture. A character who has not appeared yet in the story must be listed here and must not be in positions (the rabbit is absent in beats 1 and 2).
"light" = a few words (for example "warm spotlight from the top left, soft shadows").
"must_show" = 2-4 short things that MUST be visible.
"motion" = 30-45 words of ONLY gentle movement for a small image-to-video model: a slow camera push-in or drift, soft light changes, hair, fur, cloth and leaves swaying, blinking, breathing, a small smile. NEVER walking, running, jumping, climbing or anything entering or leaving the frame.`;
        const story = String(body.story || "").slice(0, 2500), script = String(body.script || "").slice(0, 3000);
        const run = async model => {
          const out = await chat(env, model, { max_tokens: 3800, messages: [{ role: "system", content: sys }, { role: "user", content: `Idea: ${idea}` + (story ? `\nApproved story: ${story}` : "") + (script ? `\nApproved script:\n${script}` : "") }] });
          const raw = typeof out.response === "string" ? out.response : JSON.stringify(out.response);
          const obj = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
          const chars = (Array.isArray(obj.characters) ? obj.characters : []).slice(0, 3).filter(c => c && c.look);
          const setting = String(obj.setting || "").slice(0, 240);
          const beats = (Array.isArray(obj.beats) ? obj.beats : obj.scenes || []).slice(0, 4).filter(x => x && x.caption);
          if (!chars.length || !setting || beats.length < 4) throw new Error("bad plan");
          const findChar = who => { const q = String(who || "").toLowerCase().trim(); return chars.find(c => c.name && (String(c.name).toLowerCase() === q || q.includes(String(c.name).toLowerCase()) || String(c.name).toLowerCase().includes(q))); };
          const looks = (c, n) => (c.name ? String(c.name).slice(0, 20) + ": " : "") + String(c.look).slice(0, n);
          const charTxt = chars.map(c => looks(c, 210)).join(" ");
          const t = (x, n) => String(x || "").trim().slice(0, n);
          const objs = (Array.isArray(obj.objects) ? obj.objects : []).slice(0, 2).filter(o => o && o.name && o.look).map(o => `${t(o.name, 30)}: ${t(o.look, 150)}`).join(" ");
          const scenes = beats.map(b => {
            const posList = (Array.isArray(b.positions) ? b.positions : []).filter(p => p && p.who).slice(0, 3);
            if (!posList.length) throw new Error("bad plan");
            const here = posList.map(p => findChar(p.who)).filter(Boolean);
            const detail = n => posList.map(p => { const c = findChar(p.who); return `${c ? looks(c, n) : t(p.who, 30)}. Position: ${t(p.where, 110)}, facing ${t(p.facing, 30)}. Pose: ${t(p.pose, 140)}. Hands: ${t(p.hands, 140)}. Face: ${t(p.face, 30)}.`; }).join(" ");
            const absent = (Array.isArray(b.absent) ? b.absent : []).slice(0, 4).map(s => t(s, 40)).filter(Boolean).join(", ");
            const must = (Array.isArray(b.must_show) ? b.must_show : []).slice(0, 4).map(s => t(s, 50)).filter(Boolean).join(", ");
            const common = `${objs ? "Key object details: " + objs + ". " : ""}Key objects in this picture: ${t(b.props, 160)}.${must ? " Must be clearly visible: " + must + "." : ""} Light: ${t(b.light, 60)}.${absent ? " NOT in the picture: " + absent + "." : ""}`;
            return {
              caption: t(b.caption, 90),
              visual: `Camera: ${t(b.camera, 90)}. Setting: ${setting.replace(/[.\s]+$/, "")}. Visible behind: ${t(b.backdrop, 140)}. ${detail(170)} ${common} Every character listed is fully visible. No text in the image.`.slice(0, 2000),
              edit: `Camera: ${t(b.camera, 90)}. Visible behind: ${t(b.backdrop, 140)}. ${detail(90)} ${common}`.slice(0, 1700),   // used when a reference picture exists: written as an edit
              present: (here.length ? here : chars).map(c => String(c.name || "").slice(0, 30)),
              subjects: (here.length ? here : chars).map(c => String(c.short || c.look).slice(0, 120)),
              motion: t(b.motion, 400),
            };
          });
          const plan = String(obj.plan || "").slice(0, 160);
          const sheet = ((plan ? "Plan: " + plan + " " : "") + charTxt + (objs ? " Objects: " + objs : "") + " Setting: " + setting).slice(0, 900);
          const subjects = chars.map(c => String(c.short || c.look).slice(0, 120));
          return { scenes, story: String(obj.story || story || "").slice(0, 1200), sheet, subjects };
        };
        return send(await chain(env, run));
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
