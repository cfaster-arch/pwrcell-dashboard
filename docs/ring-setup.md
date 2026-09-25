# Real Ring camera integration

The dashboard's camera section is live in the app now (menu → **Cameras**).
Everything below runs on the VPS — no extra hardware, no router changes.

## How it works

```
Ring cloud → go2rtc (on the VPS, 127.0.0.1:1984) → /api/rtc/* (same-origin proxy) → browser WebRTC
```

- The app downloads and supervises **go2rtc** itself on first use — nothing to
  install by hand.
- The **refresh token** lives in `dashboard.env` (0600) on the server. The
  browser never sees it.
- WebRTC media goes straight from the browser to the VPS on UDP 8555 (opened
  in ufw automatically when the app runs as root). Signaling stays on HTTPS.

## Linking the Ring account (do this with the customer)

1. Open the dashboard → menu → **Cameras**.
2. Sign in with the Ring account that owns the cameras.
3. Enter the two-factor code Ring sends (text or email).
4. The dashboard discovers the cameras and assigns them to Camera 1 / Camera 2.
5. Tick **wired** on the wired camera — that unlocks the snapshot modes.
   Battery cameras without a Protect plan are live-view only.
6. Tick **Show on dashboard**. The camera section appears under the metrics.

## Behavior notes

- **Live sessions end after ~10 minutes** (Ring's limit, not ours). The player
  re-negotiates automatically — up to 3 quick retries, then a manual
  "Restart stream" button.
- **Battery camera:** live view only, and don't leave it streaming — it drains
  the battery and suppresses motion/ding events while active.
- **Wired camera:** snapshots every 30s / 60s / 5m, or continuous live.
- **Push-to-talk:** the "Hold to talk" button appears on live view once the
  kiosk grants microphone permission. (In Fully Kiosk, allow mic access for the
  page.)
- Per-camera modes: **Live / Snaps / Off**. Camera 1 / Camera 2 / Both selector
  sits above the feeds.
- Siren, floodlight and motion snooze are **not** in this build — they need the
  ring-mqtt bridge (planned).

## If the token dies

Ring rotates refresh tokens; go2rtc handles rotation internally. If a stream
fails with an auth error, the card shows it — disconnect and re-link the
account in the menu (takes 30 seconds).

## Troubleshooting

- *"Camera bridge isn't running"* — the bridge starts automatically when cameras
  are enabled and the token is saved. Give it ~30s on first link (binary download).
- *Black video / endless connecting* — UDP 8555 may be blocked. The app opens
  it in ufw itself when running as root; on a custom setup, allow `8555/udp`.
- *Wrong camera in a slot* — menu → Cameras → reassign Camera 1 / Camera 2.
- *New camera added to the Ring account later* — menu → Cameras → **Find cameras**.
