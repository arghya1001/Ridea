# Ridea — free setup (GitHub Pages + Cloudflare Workers AI)

## 1. Deploy the Worker
```
npm i -g wrangler
wrangler login
# edit wrangler.toml: set ALLOWED_ORIGIN to https://YOUR-USERNAME.github.io
wrangler deploy
```
Copy the URL it prints (https://ridea-api.<you>.workers.dev).

## 2. Connect the page
In `ridea.html`, set `const API_URL = "https://ridea-api.<you>.workers.dev";`

## 3. Host on GitHub Pages
Push `ridea.html` to a repo → Settings → Pages → deploy from `main` / root. Your site will be at https://YOUR-USERNAME.github.io/REPO/ridea.html (or name it `index.html` to open at the root).

## Notes
- Cost: 0. Workers AI gives 10,000 neurons/day free; on the Free plan it errors out past that, it does not bill.
- Real now: Image and Script concept ideas. Video and Voice are still demo.
- Test locally: `python3 -m http.server 8000` (localhost:8000 is allowed by the Worker).

 
