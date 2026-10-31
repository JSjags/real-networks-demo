# Order #42 — Offline-First Live Demo

Polished demo for the GDG Umuahia talk **"Building for Real Networks: Offline-First, Real-Time Patterns Across Web, Mobile, and Desktop"** (Sat Oct 31 2026, Google Meet).

**Speaker:** Jesse Abuaja ([@JSjags](https://github.com/JSjags))

One shared order **#42** ("1 bag, Ama St."). **Ada** (phone) and **Chidi** (web) both go offline, edit different fields, reconnect, and watch a **field-level merge** converge both UIs — with outbox, optimistic pending badges, cursor pull, retries, and a WebSocket nudge.

---

## What it shows

| Pattern (slides 5–14) | In this demo |
|---|---|
| Local DB as source of truth | IndexedDB via **Dexie** — UI reads/writes locally first |
| Outbox + idempotency | Outbox table; each mutation has a client UUID sent as `Idempotency-Key` |
| Optimistic UI | Per-change **pending / synced / failed** badges |
| Cursor pull | `GET /api/changes?since=c_N` |
| Retries | Exponential backoff + jitter; batched `/push` |
| Real-time nudge | WebSocket `/ws` → client pulls (not a second source of truth) |
| Conflicts | Different fields → keep both; same field → **last-write-wins** + visible note |
| Presenter tools | Debug panel (outbox, cursor, sync log), simulate offline, one-click **Reset #42** |

Visual style: mint background, Google colors (`#4285F4` `#EA4335` `#FBBC04` `#34A853`), rounded black-outlined pills.

---

## 2-minute setup

**Requirements:** Node.js 20+ and npm.

```bash
git clone <this-repo>
cd <this-repo>
npm run demo
```

That installs deps, starts the sync API on **:8787**, and the Vite UI on **[http://127.0.0.1:5173](http://127.0.0.1:5173)**.

The terminal prints the **LAN URL** and a **QR code** for phones on the same Wi-Fi.

Open the UI, click **Reset #42** once before going on stage.

---

## 5-step live demo script (slide 14)

Keep this to ~5 minutes. Narrate what to watch for.

1. **Show both clients** with the same order #42 (`1 bag`, `Ama St.`).
   - Laptop tab → pick **Chidi (web)**.
   - Phone (or second browser profile/tab) → open the LAN URL → pick **Ada (phone)**.
2. **Take both offline**
   - Phone: airplane mode (or in-app **Simulate offline**).
   - Web: Chrome DevTools → **Network** → **Offline** (do **not** kill laptop Wi-Fi — you'll drop Google Meet). Backup: **Simulate offline** in the debug panel.
3. **Edit while offline**
   - Ada: quantity → `3 bags` → **Save quantity** → pending badge + outbox entry.
   - Chidi: address → `Aba Road` → **Save address** → pending badge + outbox entry.
4. **Reconnect both** — watch outboxes flush, cursor advance, and **both** fields appear on both screens with **no refresh** (field-level merge).
5. *(Optional, if time)* Both edit **quantity** while offline → reconnect → **conflict note** explains last-write-wins per field.

**Meet tip:** Mirror the phone with `scrcpy` over USB so airplane mode stays on while the audience watches. Keep a pre-recorded backup video ready.

---

## Run on a phone (same Wi-Fi)

1. Start `npm run demo` on the MacBook.
2. Scan the QR in the terminal, or open `http://<your-lan-ip>:5173`.
3. Add to Home Screen (installable PWA / service worker in Vite) if you want an app-like chrome.
4. Select **Ada**, then use airplane mode for the offline segment.

The API is proxied through Vite (`/api`, `/ws`), so the phone only needs port **5173**.

---

## Commands

| Command | What it does |
|---|---|
| `npm run demo` | Install + run API + Vite (the one command) |
| `npm run server` | API + WebSocket only (`:8787`) |
| `npm run client` | Vite UI only (`:5173`) |
| `npm test` | Unit tests (merge + idempotency) |
| `npm run test:e2e` | Playwright: two-client offline → merge (slide 14) |
| `npm run test:all` | Unit + e2e |

---

## Deploy to Render (one public HTTPS link)

Production runs as **one Node process**: it serves the built PWA, the API under `/api/*`, and the WebSocket at `/ws` on the same origin, listening on `$PORT` (falls back to `API_PORT`, then 8787) on `0.0.0.0`.

1. Render dashboard → **New → Blueprint** → pick `JSjags/real-networks-demo`. It reads `render.yaml` (free web service, Node ≥ 20).
   - Or **New → Web Service** with:
     - Build command: `npm install --include=dev && npm run build`
     - Start command: `npm start`
     - Health check path: `/api/health`
2. Open the `https://<service>.onrender.com` URL on your laptop **and** phone — no shared Wi-Fi needed.
3. Free instances sleep after ~15 minutes idle; open the URL (or `/api/health`) a few minutes before the talk to wake it. State is in memory, so press **Reset #42** before going on.

Try production locally:

```bash
npm run build
PORT=10000 npm start          # http://127.0.0.1:10000
npm run test:e2e:prod         # e2e suite against the production server
```

## Architecture (short)

```
UI ──write──► IndexedDB (orders + outbox) ──sync engine──► POST /api/push
                  ▲                                         (Idempotency-Key)
                  │ pull GET /api/changes?since=cursor
                  │ nudge ◄── WebSocket /ws
```

Server merge: **field-level** by default; same-field conflicts use **last-write-wins** with a note stored on `fieldMeta`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Phone can't load the app | Same Wi-Fi as the laptop; allow port 5173 through the OS firewall; use the LAN IP printed in the terminal (not `127.0.0.1`). |
| DevTools Offline kills Meet | Don't toggle system Wi-Fi. Use DevTools **tab** Offline or the in-app **Simulate offline** toggle. |
| Clients don't converge | Confirm both show **Online**, WS **open**, and outbox empty. Click **Flush outbox**. Check sync log for errors. |
| Stale state from rehearsal | Click **Reset #42** (server + this device). On the other device, Reset again or hard-refresh after reset. |
| Port 5173 / 8787 in use | Stop the other process, or set `API_PORT=8790` for the server and update the Vite proxy if needed. |
| PWA / SW caching old UI | DevTools → Application → Service Workers → Unregister, then hard refresh. |
| `npm run demo` after a pull | Safe to re-run; it reinstalls then starts. For day-of, `npm run server` + `npm run client` in two terminals is fine too. |

---

## Tests as acceptance

- **Unit:** `tests/merge.test.ts` (Ada quantity + Chidi address; same-field LWW), `tests/idempotency.test.ts` (duplicate `Idempotency-Key`).
- **E2E:** `tests/e2e/slide14.spec.ts` drives two browser contexts offline → edit → reconnect → assert both see `3 bags` + `Aba Road`, plus a conflict-note case.

---

## License

Demo code for the talk — use and adapt freely for learning.
