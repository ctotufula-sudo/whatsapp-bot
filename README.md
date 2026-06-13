# WhatsApp Group Automation Bot

Production-ready Node.js bot that sends scheduled messages to a single WhatsApp group. Built for deployment on **Oracle Cloud Always Free Ubuntu** with persistent sessions, auto-reconnect, and PM2 process management.

## Features

- Sends messages to one configured WhatsApp group only
- Multiple daily schedules via `config.json` (no code changes needed)
- Persistent login with **LocalAuth** (scan QR once)
- Auto-reconnect after disconnect
- Retry failed sends (configurable)
- Lists all groups on startup and resolves target by name
- Caches group ID for faster sends
- Detailed console + daily file logging
- Graceful shutdown on `SIGINT` / `SIGTERM`

## Project Structure

```
whatsapp-bot/
├── bot.js
├── config.json
├── package.json
├── package-lock.json
├── ecosystem.config.js
├── README.md
├── sessions/          # WhatsApp session data (auto-created)
└── logs/              # Application logs (auto-created)
```

## Requirements

- Ubuntu 20.04 / 22.04 (Oracle Cloud Free Tier)
- Node.js 18+
- Chromium (for Puppeteer / whatsapp-web.js)
- PM2 (process manager)

---

## Oracle Cloud Deployment

### 1. Create Oracle Cloud VM

1. Sign in to [Oracle Cloud Console](https://cloud.oracle.com/).
2. Create a **Compute Instance** (Always Free eligible shape, e.g. Ampere or AMD).
3. Image: **Ubuntu 22.04**.
4. Open inbound ports in the **Security List** / **Network Security Group**:
   - **22** (SSH) — required for server access
5. Download your SSH private key and note the public IP.

### 2. Connect to Server

```bash
ssh -i /path/to/your-key.pem ubuntu@YOUR_SERVER_IP
```

### 3. Update System

```bash
sudo apt update && sudo apt upgrade -y
```

### 4. Install Node.js 20 (LTS)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

### 5. Install Chromium and Dependencies

whatsapp-web.js uses Puppeteer and needs Chromium on headless Linux servers.

```bash
sudo apt install -y chromium-browser \
  fonts-liberation \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libcups2 \
  libdbus-1-3 \
  libdrm2 \
  libgbm1 \
  libgtk-3-0 \
  libnspr4 \
  libnss3 \
  libx11-xcb1 \
  libxcomposite1 \
  libxdamage1 \
  libxfixes3 \
  libxrandr2 \
  libxss1 \
  libxtst6 \
  xdg-utils
```

On some Ubuntu images the binary is `chromium-browser`; on others it is `chromium`. Verify:

```bash
which chromium-browser || which chromium
```

If needed, set Puppeteer to use system Chromium (optional env var):

```bash
export PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
```

Add that line to `~/.bashrc` if your server uses a non-default Chromium path.

### 6. Install PM2 Globally

```bash
sudo npm install -g pm2
pm2 -v
```

### 7. Upload Project to Server

**Option A — Git clone**

```bash
cd ~
git clone YOUR_REPO_URL whatsapp-bot
cd whatsapp-bot
```

**Option B — SCP from local machine**

```bash
scp -i /path/to/your-key.pem -r whatsapp-bot ubuntu@YOUR_SERVER_IP:~/
```

### 8. Install Dependencies

```bash
cd ~/whatsapp-bot
npm install
```

### 9. Configure `config.json`

Edit the group name, timezone, and messages:

```bash
nano config.json
```

Example:

```json
{
  "groupName": "TUFULA TEAM",
  "timezone": "Asia/Kolkata",
  "messages": [
    {
      "cron": "0 10 * * *",
      "text": "Morning attendance reminder..."
    },
    {
      "cron": "15 18 * * *",
      "text": "Evening reminder + daily work report..."
    }
  ]
}
```

**Cron format:** `minute hour day month weekday`

| Schedule   | Cron expression |
|-----------|-----------------|
| 10:00 AM  | `0 10 * * *`    |
| 6:15 PM   | `15 18 * * *`   |

### 10. First Run — Scan QR Code

Start in foreground first to scan the QR code:

```bash
cd ~/whatsapp-bot
node bot.js
```

1. Open WhatsApp on your phone → **Linked Devices** → **Link a Device**
2. Scan the QR code shown in the terminal
3. Wait for `WhatsApp client is ready` and group detection logs
4. Press `Ctrl+C` to stop after confirming it works

Session data is saved under `sessions/` — you will not need to scan again after restarts.

### 11. Start with PM2

```bash
cd ~/whatsapp-bot
pm2 start ecosystem.config.js
pm2 status
```

### 12. Auto-Start After Reboot

```bash
pm2 save
pm2 startup
```

PM2 prints a command like:

```bash
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u ubuntu --hp /home/ubuntu
```

Copy and run that exact command, then:

```bash
pm2 save
```

---

## PM2 Commands

| Action              | Command                          |
|---------------------|----------------------------------|
| Start bot           | `pm2 start ecosystem.config.js`  |
| Stop bot            | `pm2 stop whatsapp-bot`          |
| Restart bot         | `pm2 restart whatsapp-bot`       |
| View live logs      | `pm2 logs whatsapp-bot`          |
| View last 100 lines | `pm2 logs whatsapp-bot --lines 100` |
| Save process list   | `pm2 save`                       |
| Enable boot startup | `pm2 startup`                    |
| Process status      | `pm2 status`                     |
| Monitor resources   | `pm2 monit`                      |

---

## Configuration

### `config.json` fields

| Field       | Required | Description |
|------------|----------|-------------|
| `groupName` | Yes     | Exact WhatsApp group name (case-insensitive match) |
| `timezone`  | Yes     | IANA timezone, e.g. `Asia/Kolkata` |
| `messages`  | Option A | Array of `{ cron, text }` for different messages per time |
| `message` + `schedule` | Option B | Same message sent at multiple cron times |
| `retry`     | No      | `{ maxAttempts, delayMs }` for send retries |

### Change messages without code changes

1. Edit `config.json`
2. Restart PM2:

```bash
pm2 restart whatsapp-bot
```

Cron jobs reload on restart. Message text for each schedule is read fresh when a job fires.

---

## Logs

- **PM2 logs:** `logs/pm2-out.log`, `logs/pm2-error.log`
- **App logs:** `logs/YYYY-MM-DD.log` (one file per day)

Successful sends are logged as `[SUCCESS]`. Failures are logged as `[ERROR]` or `[WARN]` with retry details.

View logs:

```bash
pm2 logs whatsapp-bot
tail -f logs/$(date +%Y-%m-%d).log
```

---

## Troubleshooting

### QR code not showing

- Run `node bot.js` in foreground (not detached PM2) for first login
- Ensure terminal supports QR rendering
- Check `pm2 logs whatsapp-bot` if started via PM2

### Group not found

- Bot account must be a **member** of the group
- Group name in `config.json` must match exactly (spacing/capitalization)
- Check startup logs — all available groups are listed
- Fix `groupName` and restart: `pm2 restart whatsapp-bot`

### Session expired / logged out

```bash
pm2 stop whatsapp-bot
rm -rf sessions/*
node bot.js
# Scan QR again, then Ctrl+C
pm2 start ecosystem.config.js
```

### Chromium / Puppeteer errors

```bash
sudo apt install -y chromium-browser
export PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
pm2 restart whatsapp-bot
```

Common errors:

- `Failed to launch browser` → install Chromium and dependencies (step 5)
- `Running as root without --no-sandbox` → bot already passes sandbox flags; run as `ubuntu` user, not root

### Messages not sending at scheduled time

- Confirm server timezone vs cron: cron uses `timezone` from config (`Asia/Kolkata`), not server UTC
- Validate cron: [crontab.guru](https://crontab.guru/)
- Check logs at scheduled time: `pm2 logs whatsapp-bot`
- Ensure process is running: `pm2 status`

### Out of memory on Free Tier

Oracle Free VMs have limited RAM. If Chromium crashes:

```bash
# Add swap (example 2GB)
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Then restart: `pm2 restart whatsapp-bot`

### WhatsApp disconnects frequently

- Keep the server online and stable
- Avoid using the same WhatsApp account on too many linked devices
- Bot auto-reconnects after 15 seconds — check logs for `Scheduling reconnect`

---

## Security Notes

- Do not commit `sessions/` or share session files
- Restrict SSH access to your IP in Oracle Cloud security rules
- Run the bot under a dedicated user (`ubuntu`)
- Keep Ubuntu and Node.js updated

---

## License

MIT
