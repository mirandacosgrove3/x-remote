# Couch — Xbox remote for your phone

A home-screen web app (PWA) that controls your Xbox through Microsoft's cloud, relayed by a free Cloudflare Worker.

```
iPhone (Couch PWA) ──HTTPS──▶ your Cloudflare Worker ──▶ Xbox Live cloud ──▶ console
```

Each button press is a separate request. Nothing has to stay connected, so locking your phone doesn't break anything: open the app and the buttons work right away.

**What it does:** power on (tap) / off (hold) · swipe pad (swipe = move, tap = A, hold after a swipe = repeat) · D-pad mode · A B X Y · Back / Home / Guide / View / Menu · volume, mute · play/pause, previous/next · type text into the console · restart.

**Cost:** $0. Cloudflare Workers + KV free tier. Microsoft app registration is free (see the note in step 1).

---

## Setup (~30–45 min, one time)

### 0. On the Xbox
- **Settings → Devices & connections → Remote features → Enable remote features** ✔
- **Settings → General → Power options → Sleep** (needed for "power on" from the phone)
- The console has to be signed in with the same Microsoft account you'll use below.

### 1. Register a Microsoft app (gives you a Client ID + Secret)
1. Go to **portal.azure.com** and sign in with your Microsoft account.
   - If it says you need a directory/subscription, sign up for the **free Azure account**. It may ask for a card to verify identity. You stay on the free tier and nothing in this project costs money.
2. Search **App registrations** → **New registration**
   - Name: `Couch Remote`
   - Supported account types: **Personal Microsoft accounts only**
   - Redirect URI: platform **Web**, URL: leave it for now (you'll add it in step 3)
3. Copy the **Application (client) ID**.
4. **Certificates & secrets → New client secret** → copy the **Value** (not the ID). It's only shown once.

### 2. Deploy the Worker (Cloudflare, free)
Needs Node.js on your Mac. In this folder:

```bash
npm install
npx wrangler login                       # opens browser, make a free Cloudflare account if needed
npx wrangler kv namespace create TOKENS  # copy the "id" it prints into wrangler.jsonc
npx wrangler deploy                      # prints your URL, e.g. https://couch-remote.yourname.workers.dev
npx wrangler secret put MS_CLIENT_ID     # paste Application (client) ID
npx wrangler secret put MS_CLIENT_SECRET # paste the secret VALUE
npx wrangler secret put APP_PIN          # make up a passcode, 6+ digits, this guards your Xbox
```

### 3. Tell Microsoft where to send you back
Azure → your app → **Authentication → Add a platform → Web** → Redirect URI:

```
https://couch-remote.yourname.workers.dev/auth/callback
```
(your real Worker URL + `/auth/callback`). Save.

### 4. On your iPhone
1. Open your Worker URL **in Safari**.
2. Settings sheet → enter your PIN → **Save PIN** → **Sign in with Microsoft** → approve.
3. Your console shows up → tap it.
4. **Share → Add to Home Screen**. Open it from the icon and enter the PIN once more. The home-screen app keeps its own storage, but the Microsoft login is stored on the Worker, so it's already linked.

---

## Try it without an Xbox / Microsoft setup
```bash
npm install
npm run dev     # mock mode, PIN is 1234 → open http://localhost:8787
```
Button presses are printed in the terminal instead of going to a console.

## Troubleshooting
| Symptom | Fix |
|---|---|
| "Console didn't take it" | Console off/asleep without Sleep mode, or **Remote features** not enabled |
| `xsts_failed` | Account has no Xbox profile, or it's a child account |
| `ms_token_failed` after a long time | Microsoft revoked the login → Settings → Sign in again |
| Microsoft error about redirect_uri | Redirect URI in Azure must exactly match `<worker URL>/auth/callback` |
| Laggy | Normal-ish: every press goes through Microsoft's cloud (~100–300 ms). The ms number in the top bar shows the last round trip. |

## Heads-up
This uses Xbox's **undocumented** cloud remote API (the same one Home Assistant and the open-source `xbox-webapi` library use). Microsoft can change it at any time. If commands start failing across the board, that's the likely cause.

## Files
- `src/worker.js`: relay: Microsoft sign-in, Xbox token chain, allow-listed commands, PIN check
- `public/`: the PWA (`index.html`, `app.css`, `app.js`, `sw.js`, manifest, icons)
- `wrangler.jsonc`: Cloudflare config
