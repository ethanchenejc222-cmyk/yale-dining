# Yale Dining 🍽️

Live menu aggregator for all 14 Yale residential colleges, powered by the Nutrislice API.

---

## Run locally

```bash
npm install
npm start
# → http://localhost:3000
```

For live reload during development:
```bash
npm run dev   # uses nodemon
```

---

## Deploy to Railway (recommended — free tier available)

Railway is the easiest option and has a free hobby plan.

1. Push this folder to a GitHub repo
2. Go to [railway.app](https://railway.app) and sign in with GitHub
3. Click **New Project → Deploy from GitHub repo**
4. Select your repo — Railway auto-detects Node.js and deploys
5. Your app gets a public URL like `https://yale-dining-production.up.railway.app`

That's it. No config needed — Railway reads `package.json` and uses `npm start`.

---

## Deploy to Render (also free)

1. Push to GitHub
2. Go to [render.com](https://render.com), create a **Web Service**
3. Connect your GitHub repo
4. Set:
   - **Build Command:** `npm install`
   - **Start Command:** `node server/index.js`
5. Deploy — you get a URL like `https://yale-dining.onrender.com`

Note: Render free tier spins down after 15 min of inactivity (cold start ~30s).

---

## Deploy to Fly.io (best performance, always-on free tier)

```bash
# Install flyctl
brew install flyctl       # macOS
# or: curl -L https://fly.io/install.sh | sh

# From the project directory:
fly launch          # follow prompts, accept defaults
fly deploy
```

Fly gives you a persistent VM — no cold starts. Free tier includes 3 shared VMs.

---

## Deploy to Heroku

```bash
heroku create yale-dining
git push heroku main
heroku open
```

---

## How it works

```
Browser (iPhone web app)
    ↓  GET /api/menu/:hall/:mealType/:year/:month/:day
Node.js server (Express)
    ↓  fetch (server-side, no CORS)
Nutrislice API
  https://yalehospitality.api.nutrislice.com/menu/api/weeks/school/{hall}/menu-type/{meal}/{y}/{m}/{d}/
```

The server proxies all Nutrislice requests, bypassing the browser CORS restriction. The frontend at `/` is a static iPhone-style web app.

---

## API endpoints

| Endpoint | Description |
|---|---|
| `GET /` | The app UI |
| `GET /api/menu/:hall/:meal/:y/:m/:d` | Single hall + meal |
| `GET /api/menus/:meal/:y/:m/:d` | All 14 halls for a meal |

Example:
```
/api/menu/branford-college/lunch/2026/03/07
/api/menus/dinner/2026/03/07
```
