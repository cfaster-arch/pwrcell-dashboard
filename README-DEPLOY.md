# PWRcell Dashboard — Windows laptop install

## What this is
The full dashboard app (built by Grok from the API research), repackaged to
run 24/7 on a Windows laptop on your home Wi-Fi. The Fire tablet just opens
the dashboard in a browser — it does no work itself.

## Install (on the Windows laptop)
1. Copy this whole folder to the laptop, e.g. `C:\pwrcell-dashboard`.
2. Right-click **`setup.ps1`** → **Run with PowerShell**. (It re-launches as
   Administrator by itself.)
3. It will:
   - install Node.js LTS if missing (via winget),
   - `npm install` + production build,
   - ask for the PWRview email/password (Enter to skip → demo mode),
   - open TCP 8080 in Windows Firewall,
   - disable sleep/hibernate while plugged in,
   - create a Scheduled Task **"PWRcell Dashboard"** that starts the server
     at logon and restarts it if it crashes,
   - start the server immediately.
4. Note the LAN URL it prints, e.g. `http://192.168.1.42:8080`.

## Fire tablet
In Fully Kiosk, set the start URL to `http://<laptop-LAN-IP>:8080`.
Keep the laptop plugged in and on the same Wi-Fi.

## Stable IP (recommended)
If the laptop's Wi-Fi IP changes, the tablet's bookmark breaks. Either:
- set a DHCP reservation for the laptop in your router, or
- give the laptop a static IP outside the router's DHCP range.

Find the current IP any time with `ipconfig` (look for "IPv4 Address" under
the Wi-Fi adapter).

## Credentials later
No PWRview login yet? The dashboard runs in **demo mode** (simulated solar
day) until you add them. Two ways to add them:
- **In the dashboard:** click **PWRview login** (top-right) and enter the
  email + password. They're saved on the laptop and live data starts on the
  next poll. You can also disconnect from there.
- **Manually:** edit `dashboard.env`, then restart the
  "PWRcell Dashboard" task in Task Scheduler (or reboot).

## Gauges
Each tile shows a 270° analog-style gauge: zoned color arcs, 46 tick marks
with labeled majors, an animated needle, and a digital kW readout.
- **Solar / Home** read 0 → full scale (home's upper zones turn amber/red at
  high consumption).
- **Battery / Grid** are center-zero: left of center is charging/exporting,
  right is discharging/importing. Battery also carries a thin outer ring
  showing state of charge.
- Full-scale adapts to the recent peaks in the data (never below a sane
  floor), so the needle always has room to move.

## Health check
Open `http://<laptop-LAN-IP>:8080/api/health` — it shows whether the
PWRview credentials are configured, when the last poll ran, and any error.

## Files added for Windows deployment
- `setup.ps1` — one-shot installer (above)
- `start-dashboard.ps1` — launcher used by the Scheduled Task
- `dashboard.env` — created by setup; holds `GENERAC_EMAIL` / `GENERAC_PASSWORD`
- `vite.config.ts` — Nitro preset changed `vercel` → `node-server` so the
  build produces a standalone Node server (`.output/server/index.mjs`)
  instead of serverless functions. The 30-second poller needs a process
  that stays alive, which serverless doesn't provide.
