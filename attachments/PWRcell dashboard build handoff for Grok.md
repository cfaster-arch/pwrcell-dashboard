# PWRcell Web Dashboard — Build Handoff

> Paste this whole document into Grok as the project brief. It contains the
> API research, confirmed schemas, architecture, and dead ends. A reference
> implementation already exists (Python/Flask backend + vanilla JS frontend);
> rebuild in any stack or reuse its logic.

## 1. Goal

A self-hosted **web dashboard** for a Generac **PWRcell** solar + battery
system (Pika X7602 inverter), replacing the PWRview phone app. Must run in
any browser (it will be wall-mounted on an Amazon Fire tablet). The browser
must **never** see the user's credentials — all Generac traffic happens in a
backend the dashboard polls.

## 2. The API (researched, confirmed)

Generac's PWRcell cloud lives at **`https://generac-api.neur.io`** — the same
backend the official PWRcell mobile app (`com.neurio.generachome`) uses.
Reverse-engineered from the app's HTTPS traffic; schemas confirmed from live
captures by the `ha-generac-pwrcell` Home Assistant integration
(`github.com/enter360/ha-generac-pwrcell`).

Auth is **AWS Cognito under the hood**, via a custom session API. There is
**no developer portal, no app registration, no OAuth client-credentials grant**
— you sign in with the end user's **PWRview email + password**.

### 2.1 App identity headers (send on every request)

These identify the mobile client. They are not user secrets.

```
Authorization: Basic base64("1im6pfcmq8oo8db7usd8kjrgkk:bpbuhh5u8atmuekq4rh4l8bhnig5cqd2el66tkfmp60gs3sd62f")
  (only on the sign-in call; see below)
user-agent: GeneracHome/38904 CFNetwork/3860.400.51 Darwin/25.3.0
mobileappversion: 1.30.0
mobileappbuildnumber: 38904
accept: application/json, text/plain, */*
accept-language: en-US,en;q=0.9
content-type: application/json
```

### 2.2 Sign in

```
POST https://generac-api.neur.io/sessions/v1/signin
Headers: app identity headers above (including Basic Authorization)
Body:    {"email": "<pwrvview email>", "password": "<pwrview password>"}
```

Response (200):
```json
{
  "access_token": "<Cognito JWT>",
  "id_token": "<Cognito ID JWT>",
  "refresh_token": "<opaque>",
  "token_type": "Bearer",
  "expires_in": 3600,
  "user_id": "<UUID>",
  "authChallenge": null,
  "challengeSession": null
}
```

### 2.3 Refresh

```
POST https://generac-api.neur.io/sessions/v2/refresh/token
Headers: app identity headers, NO Authorization header
Body:    {"userId": "<user_id from sign-in>", "refreshToken": "<refresh_token>"}
```

Response: new `access_token` / `id_token`. `refresh_token` may be omitted —
keep the previous one in that case. Refresh proactively ~5 minutes before
`expires_in` elapses. If refresh fails, do a full sign-in again.

### 2.4 Data endpoints (IMPORTANT: use the `id_token`, not `access_token`)

```
Authorization: Bearer <id_token>
```

**Homes / device status** (poll every ~30s, same cadence as the official app):
```
GET https://generac-api.neur.io/live/v1/homes
```
Returns an array (usually one) of home objects:
```json
[{
  "homeId": "<id>",
  "timezone": "America/Los_Angeles",
  "address1": "...", "city": "...", "state": "...",
  "systems": [{
    "serialNumber": "...",
    "systemDevices": [
      {"deviceType": "PVL",
       "deviceStatus": {"powerInWatts": 1234, "lifeTimeEnergyInWh": 567890}},
      {"deviceType": "BATTERY",
       "deviceStatus": {"powerInWatts": -500, "lifeTimeEnergyInWh": 12345,
                        "soc": 82.5, "temperatureInCelsius": 24.1, "voltage": 380.2}},
      {"deviceType": "INVERTER",
       "deviceStatus": {"powerInWatts": 900, "lifeTimeEnergyInWh": 456789,
                        "temperatureInCelsius": 41.0, "voltage": 240.1}},
      {"deviceType": "BEACON", "deviceStatus": {...}}
    ]
  }]
}]
```
Device types: `PVL` = solar string optimizer (sum `powerInWatts` /
`lifeTimeEnergyInWh` across all of them for totals), `BATTERY`, `INVERTER`,
`BEACON` (comms module, ignore for metrics).

**Live telemetry / power flow** (authoritative for aggregate watts):
```
GET https://generac-api.neur.io/live/v2/homes/{homeId}/telemetry?fromIso=<ISO8601, e.g. 90s ago>
```
Returns an array of per-second snapshots; **use the last entry**. Returns `[]`
when there is no new data since `fromIso` — keep serving the previous reading.
```json
[{
  "date": "1727224800",
  "solar":       {"powerKw": 3.42},
  "grid":        {"powerKw": 0.81},
  "consumption": {"powerKw": 2.15},
  "generator":   {"powerKw": 0.0},
  "battery":     {"powerKw": -0.46, "soC": 82.5,
                  "batteryBackupTimeInSeconds": 16200,
                  "batteryState": "BATTERY_SOC_STATUS_UNSPECIFIED"},
  "system": {"<systemId>": {"gridState": "GRID_CONNECTED",
                            "sysMode": "SELF_SUPPLY",
                            "inverterHeadRoomKw": 5.2}}
}]
```
Semantics (confirmed):
- All power values are **kW** — multiply by 1000 for watts.
- `grid.powerKw`: **positive = importing** from grid, **negative = exporting**.
- `battery.powerKw`: **positive = discharging**, negative = charging.
- `battery.soC`: note the **capital C**.
- `gridState`: e.g. `GRID_CONNECTED` / `GRID_DISCONNECTED`.
- `sysMode`: e.g. `SELF_SUPPLY`, `CLEAN_BACKUP`, `PRIORITY_BACKUP`.

### 2.5 Error handling

- On **401** from a data endpoint: discard tokens, do a full sign-in, retry
  the request once.
- **Monotonic guard**: `lifeTimeEnergyInWh` counters occasionally report a
  stale/reset (lower) value for one poll then recover. Never let a lifetime
  counter decrease — hold the previous high instead.
- Keep serving the last good reading when a poll fails; surface the error
  string in the dashboard's status line.

## 3. Suggested architecture

- **Backend** (any stack): owns credentials (env vars, e.g.
  `GENERAC_EMAIL` / `GENERAC_PASSWORD`), token lifecycle, and a poll loop
  every 30s writing normalized points into an in-memory ring buffer
  (e.g. 1440 points ≈ 12h). Exposes:
  - `GET /api/health` → config state, last poll time, last error, upstream
    call count
  - `GET /api/live` → latest point + error
  - `GET /api/series?minutes=N` → buffered points for charts
  - `GET /api/homes` → raw homes payload (debug / verify system visible)
- **Frontend** (any stack, must work in the Fire tablet's Silk/Fully Kiosk
  browser): polls the backend every 5s (backend→browser is unmetered; only
  backend→Generac counts).
  - Tiles: **Solar W**, **Home consumption W**, **Battery W** (+ SoC %,
    charging/discharging), **Grid W** (+ importing/exporting).
  - Chart: solar vs consumption vs battery vs grid over 30m / 2h / 12h.
  - System panel: solar/battery/inverter lifetime kWh, battery temp/voltage,
    grid state, system mode, estimated backup hours.

## 4. Dead ends — do NOT go here

- **`https://api.neur.io/v1` (Neurio public API, OAuth2 client-credentials):**
  wrong cloud. It's for Neurio-branded energy sensors; this account has zero
  sensors there (verified: empty sensors tab on the PWRview site).
- **Local LAN access** (`http://<sensor-ip>/current-sample`): a full
  192.168.12.0/24 scan found nothing serving it. The PWRview monitoring unit
  locks down inbound connections; cloud API is the only path.
- **The PWRview website** as a dashboard: it has no metrics view at all —
  it's only an API-access/account hub. That's why this project exists.

## 5. Reference implementation (already working, smoke-tested)

`~/workspace/pwrcell-dashboard/` — Python/Flask backend (`app.py`),
dependency-free vanilla JS frontend (`static/`), `requirements.txt`
(`Flask`, `requests`), `README.md` with run instructions. Reuse its auth
flow, parsing (`_parse_homes`, `_parse_telemetry`), and retry logic, or
reimplement from the schemas above.
