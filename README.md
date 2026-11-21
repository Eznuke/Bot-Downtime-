<div align="center">

# 🛰️ Bot Monitor

**Know the moment your Discord bot goes down, and the moment it's back.**

[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![discord.js](https://img.shields.io/badge/discord.js-v14-5865F2?logo=discord&logoColor=white)](https://discord.js.org)
![Storage](https://img.shields.io/badge/storage-JSON-lightgrey)

</div>

Bot Monitor watches other bots in your Discord server and sends an alert when one goes **offline** or comes back **online**, including how long it was up or down. It also tracks uptime, keeps a downtime history, and can post a live status panel.

Single file, no database, no native dependencies. It runs fine on a small host or even Termux.

---

## ✨ Features

- 🔴 **Instant alerts** for offline and online events, with durations
- ⚡ **Real-time detection** via presence events, plus a 30-second re-check as backup
- 🧯 **Flap protection**: short reconnects (under 5s) are ignored
- 📊 **Uptime stats** for 24h, 7d and 30d, with incident counts
- 🕓 **Downtime history** with start times and durations
- 📌 **Live status panel** that edits itself every 60 seconds
- 📅 **Daily uptime report** at an hour you choose
- 🔔 **Alerting options**: role ping, DM alerts, repeat reminders while a bot is down
- 🛠️ **Maintenance mode** to pause alerts without losing tracking
- 🌐 **HTTP health check**: a bot counts as online only if its presence is online **and** its URL responds
- ⌨️ **Slash and prefix commands** (default prefix `?`, configurable per server)
- 🌍 **Multi-server**, up to 25 monitored bots per server

---

## 📦 Requirements

- Node.js **18 or newer**
- A Discord application with a bot token

---

## 🚀 Setup

### 1. Create the bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create an application.
2. Go to **Bot** and enable these **Privileged Gateway Intents**:
   - **Presence Intent** (required to see online/offline)
   - **Server Members Intent**
   - **Message Content Intent** (required for prefix commands)
3. Copy the bot token.

### 2. Invite it

Use the OAuth2 URL generator with scopes `bot` and `applications.commands`, and these permissions:
View Channels, Send Messages, Embed Links, Read Message History. Add Manage Messages if you want the bot to replace old status panels.

> The bot must share a server with the bots you want to monitor.

### 3. Install and run

```bash
git clone https://github.com/<your-username>/<your-repo>.git
cd <your-repo>
npm install
cp .env.example .env     # then edit .env and set DISCORD_TOKEN
npm start
```

On Termux: `pkg install nodejs git`, then the same steps.

### 4. Configure in Discord

```
/monitor channel #alerts      choose where alerts go
/monitor add @YourBot         start monitoring
/monitor panel                optional live status board
```

---

## ⚙️ Environment variables

| Variable | Default | Description |
|---|---|---|
| `DISCORD_TOKEN` | none (required) | Bot token |
| `DEFAULT_PREFIX` | `?` | Default chat prefix (changeable per server) |
| `DEBOUNCE_MS` | `5000` | Ignore status flaps shorter than this |
| `SWEEP_MS` | `30000` | Interval for re-checks, health checks, reminders and reports |
| `PANEL_MS` | `60000` | Live panel refresh interval |
| `REPORT_TZ_OFFSET` | `7` | Hours from UTC used for the daily report (7 = WIB) |
| `HTTP_TIMEOUT_MS` | `8000` | Timeout for HTTP health checks |
| `TOPGG_TOKEN` | empty | Optional. Posts the server count to top.gg every 30 minutes |
| `SUPPORT_URL` | empty | Optional. Support server link shown in help, about and invite |

---

## ⌨️ Commands

Use `/monitor <command>` or the prefix form, for example `?add @Bot`. `?monitor add @Bot` works too. Mention the bot alone to see the current prefix.

Management commands need the **Manage Server** permission.

| Command | Description |
|---|---|
| `add @bot` | Start monitoring a bot |
| `remove @bot` | Stop monitoring a bot |
| `channel #channel` | Set the alert channel |
| `role @role` | Role to ping when a bot goes offline (no argument clears it) |
| `reminder <minutes>` | Repeat the alert while a bot stays offline (5-1440, 0 = off) |
| `dm` | Toggle DM alerts for yourself (max 10 people per server) |
| `url @bot <url>` | Set an HTTP health check (no URL clears it) |
| `report <hour\|off>` | Daily uptime report (0-23, or `off`) |
| `prefix <new>` | Show or change the chat prefix (1-5 characters) |
| `list` | Status of all monitored bots |
| `stats @bot` | Uptime 24h / 7d / 30d, incidents, last online/offline |
| `history @bot` | Last 10 downtime incidents |
| `panel [#channel]` | Post a self-updating status panel |
| `pause @bot` / `resume @bot` | Maintenance mode on or off |
| `test` | Send a sample alert |
| `ping` | Bot latency |
| `help` | Command list |

Prefix aliases: `watch`, `rm` / `delete`, `ls` / `status`, `info`, `log`, `remind`, `health`, `daily`, `h`.

### Public commands

Open to everyone, no permissions needed: `/help`, `/invite`, `/vote`, `/about`, `/privacy` (and `?help`, `?invite`, `?vote`, `?about`, `?privacy`).

---

## 🔍 How it works

- The bot listens for presence updates of the monitored bots and also re-checks every `SWEEP_MS`.
- A state change is only confirmed if it lasts longer than `DEBOUNCE_MS`, which avoids alert spam during quick reconnects.
- With a health URL set, the effective state is **online only when presence is online and the URL answers with a status below 500**.
- Uptime is calculated only from the time since monitoring started, not from before.

---

## 🗂️ Data and privacy

State is stored in a local `data.json`, created next to `index.js`:

- per server: alert channel and role IDs, prefix, report settings
- per monitored bot: its ID, online/offline history (last 500 changes), optional health URL
- IDs of people who enabled DM alerts

Message content is not stored. Keep `data.json` between restarts to preserve history, and **never commit it or `.env`** (see `.gitignore` below).

---

## 🧩 Hosting notes

- Works on any Node host, including free panels and Termux. Make sure the start command is `node index.js` (or `npm start`).
- On startup the bot clears old global slash commands and registers its commands per server, so new commands appear immediately.
- Hosts that deploy from GitHub overwrite local edits on each deploy, so change the code in the repository.

---

## 🛠️ Troubleshooting

| Problem | Fix |
|---|---|
| Bot never detects offline/online | Enable **Presence Intent** and **Server Members Intent**, and make sure both bots share a server |
| Prefix commands do nothing | Enable **Message Content Intent** |
| No alerts arrive | Run `/monitor channel` and check the bot can send messages and embeds there |
| `DISCORD_TOKEN is not set` | Create `.env` from `.env.example` and fill in the token |
| DM alerts fail | Allow DMs from server members, then run `dm` again |
| Slash commands missing | Restart the bot; commands are registered on startup. Reload Discord if it still shows old ones |

---

## 📄 Files

```
index.js        the whole bot
package.json    dependencies and start script
.env.example    configuration template
data.json       created at runtime (do not commit)
```

---

<div align="center">

Made with discord.js v14 • If this saved you from an unnoticed outage, consider giving the repo a ⭐

</div>
