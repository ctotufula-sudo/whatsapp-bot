const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');

const ROOT_DIR = __dirname;
const CONFIG_PATH = path.join(ROOT_DIR, 'config.json');
const GROUP_CACHE_PATH = path.join(ROOT_DIR, 'group-cache.json');
const LOGS_DIR = path.join(ROOT_DIR, 'logs');
const SESSIONS_DIR = path.join(ROOT_DIR, 'sessions');

const DEFAULT_RETRY = { maxAttempts: 3, delayMs: 5000 };
const RECONNECT_DELAY_MS = 15000;

let client = null;
let isReady = false;
let isShuttingDown = false;
let scheduledJobs = [];
let reconnectTimer = null;

function ensureDirectories() {
  [LOGS_DIR, SESSIONS_DIR].forEach((dir) => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

function timestamp() {
  return new Date().toISOString();
}

function writeLog(level, message, meta = null) {
  const line = meta
    ? `[${timestamp()}] [${level}] ${message} ${JSON.stringify(meta)}`
    : `[${timestamp()}] [${level}] ${message}`;

  console.log(line);

  const logFile = path.join(
    LOGS_DIR,
    `${new Date().toISOString().slice(0, 10)}.log`
  );

  try {
    fs.appendFileSync(logFile, `${line}\n`, 'utf8');
  } catch (err) {
    console.error(`[${timestamp()}] [ERROR] Failed to write log file: ${err.message}`);
  }
}

function logInfo(message, meta) {
  writeLog('INFO', message, meta);
}

function logWarn(message, meta) {
  writeLog('WARN', message, meta);
}

function logError(message, meta) {
  writeLog('ERROR', message, meta);
}

function logSuccess(message, meta) {
  writeLog('SUCCESS', message, meta);
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`config.json not found at ${CONFIG_PATH}`);
  }

  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const config = JSON.parse(raw);

  if (!config.groupName && !config.phoneNumber) {
    throw new Error('config.json must include "groupName" or "phoneNumber"');
  }

  if (config.groupName && typeof config.groupName !== 'string') {
    throw new Error('config.json "groupName" must be a string');
  }

  if (config.phoneNumber && typeof config.phoneNumber !== 'string') {
    throw new Error('config.json "phoneNumber" must be a string');
  }

  if (!config.timezone || typeof config.timezone !== 'string') {
    throw new Error('config.json must include a valid "timezone" string');
  }

  const scheduledMessages = buildScheduledMessages(config);

  if (scheduledMessages.length === 0) {
    throw new Error(
      'No scheduled messages found. Provide "messages" array or "message" + "schedule" in config.json'
    );
  }

  for (const entry of scheduledMessages) {
    if (!cron.validate(entry.cron)) {
      throw new Error(`Invalid cron expression: "${entry.cron}"`);
    }
  }

  return {
    ...config,
    retry: { ...DEFAULT_RETRY, ...(config.retry || {}) },
    scheduledMessages,
  };
}

function buildScheduledMessages(config) {
  if (Array.isArray(config.messages) && config.messages.length > 0) {
    return config.messages.map((item, index) => {
      if (!item.cron || !item.text) {
        throw new Error(`messages[${index}] must include both "cron" and "text"`);
      }
      return { cron: item.cron, text: item.text };
    });
  }

  if (!config.message || typeof config.message !== 'string') {
    throw new Error('config.json must include "message" or "messages"');
  }

  if (!Array.isArray(config.schedule) || config.schedule.length === 0) {
    throw new Error('config.json must include a non-empty "schedule" array');
  }

  return config.schedule.map((cronExpr) => ({
    cron: cronExpr,
    text: config.message,
  }));
}

function saveGroupCache(group) {
  const payload = {
    groupId: group.id._serialized,
    groupName: group.name,
    savedAt: timestamp(),
  };

  fs.writeFileSync(GROUP_CACHE_PATH, JSON.stringify(payload, null, 2), 'utf8');
  logInfo('Group ID cached', payload);
}

function readGroupCache() {
  if (!fs.existsSync(GROUP_CACHE_PATH)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(GROUP_CACHE_PATH, 'utf8'));
  } catch (err) {
    logWarn('Could not read group cache, will rediscover group', { error: err.message });
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listAllChats() {
  const chats = await client.getChats();
  const namedChats = chats.filter((chat) => chat.name);

  logInfo(`Found ${namedChats.length} WhatsApp chat(s) with names`);

  namedChats.forEach((chat, index) => {
    logInfo(`Chat ${index + 1}: "${chat.name}"`, {
      id: chat.id._serialized,
      type: chat.isGroup ? 'group' : 'contact',
      participants: chat.isGroup && chat.participants ? chat.participants.length : undefined,
    });
  });

  return namedChats;
}

function normalizePhoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function getPhoneSearchTargets(config) {
  const localNumber = normalizePhoneDigits(config.phoneNumber);
  const countryCode = normalizePhoneDigits(config.countryCode || '91');

  if (!localNumber) {
    return [];
  }

  const targets = new Set([localNumber]);

  if (!localNumber.startsWith(countryCode)) {
    targets.add(`${countryCode}${localNumber}`);
  }

  return [...targets];
}

function chatMatchesPhone(chat, phoneTargets) {
  const chatDigits = normalizePhoneDigits(chat.name);
  const chatIdDigits = normalizePhoneDigits(chat.id._serialized);

  return phoneTargets.some((target) => {
    if (!target) {
      return false;
    }

    return (
      chatDigits === target ||
      chatDigits.endsWith(target) ||
      chatDigits.includes(target) ||
      chatIdDigits.includes(target)
    );
  });
}

async function resolveTargetChat(config) {
  const chats = await listAllChats();
  let target = null;

  if (config.groupName) {
    target = chats.find(
      (chat) => chat.name.trim().toLowerCase() === config.groupName.trim().toLowerCase()
    );
  }

  if (!target && config.phoneNumber) {
    const phoneTargets = getPhoneSearchTargets(config);
    logInfo('Searching chat by phone number', { phoneTargets });

    target = chats.find((chat) => chatMatchesPhone(chat, phoneTargets));

    if (!target) {
      for (const phone of phoneTargets) {
        try {
          const numberId = await client.getNumberId(phone);
          if (numberId) {
            target = await client.getChatById(numberId._serialized);
            if (target) {
              break;
            }
          }
        } catch (err) {
          logWarn('getNumberId lookup failed', { phone, error: err.message });
        }
      }
    }
  }

  if (!target) {
    const availableNames = chats.map((c) => c.name);
    logError(`Chat not found`, {
      groupName: config.groupName || null,
      phoneNumber: config.phoneNumber || null,
      availableChats: availableNames,
    });
    throw new Error(
      `Configured chat was not found. Set correct groupName or phoneNumber in config.json.`
    );
  }

  saveGroupCache(target);
  logSuccess(`Target chat resolved: "${target.name || config.groupName}"`, {
    id: target.id._serialized,
    type: target.isGroup ? 'group' : 'contact',
  });
  return target;
}

async function getTargetChat(config) {
  const cache = readGroupCache();

  if (cache?.groupId) {
    try {
      const chat = await client.getChatById(cache.groupId);
      if (chat) {
        return chat;
      }
      logWarn('Cached chat ID is invalid, rediscovering chat');
    } catch (err) {
      logWarn('Failed to load cached chat, rediscovering', { error: err.message });
    }
  }

  return resolveTargetChat(config);
}

async function sendMessageWithRetry(chat, text, retryConfig) {
  const { maxAttempts, delayMs } = retryConfig;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (!isReady || !client) {
        throw new Error('WhatsApp client is not ready');
      }

      const sentMessage = await chat.sendMessage(text);
      return sentMessage;
    } catch (err) {
      lastError = err;
      logWarn(`Send attempt ${attempt}/${maxAttempts} failed`, { error: err.message });

      if (attempt < maxAttempts) {
        await sleep(delayMs * attempt);
      }
    }
  }

  throw lastError;
}

async function handleScheduledSend(cronExpression) {
  if (isShuttingDown) {
    return;
  }

  let config;

  try {
    config = loadConfig();
  } catch (err) {
    logError('Failed to load config for scheduled job', { error: err.message });
    return;
  }

  const job = config.scheduledMessages.find((item) => item.cron === cronExpression);

  if (!job) {
    logError('No message configured for cron job', { cron: cronExpression });
    return;
  }

  logInfo('Scheduled job triggered', { cron: cronExpression, timezone: config.timezone });

  try {
    const chat = await getTargetChat(config);
    const sent = await sendMessageWithRetry(chat, job.text, config.retry);

    logSuccess('Message sent successfully', {
      group: chat.name,
      groupId: chat.id._serialized,
      cron: cronExpression,
      messageId: sent.id._serialized,
    });
  } catch (err) {
    logError('Failed to send scheduled message', {
      cron: cronExpression,
      error: err.message,
    });
  }
}

function clearScheduledJobs() {
  scheduledJobs.forEach((job) => job.stop());
  scheduledJobs = [];
}

function setupCronJobs() {
  clearScheduledJobs();

  const config = loadConfig();

  config.scheduledMessages.forEach((entry) => {
    const task = cron.schedule(
      entry.cron,
      () => {
        handleScheduledSend(entry.cron).catch((err) => {
          logError('Unhandled error in cron handler', { error: err.message });
        });
      },
      {
        scheduled: true,
        timezone: config.timezone,
      }
    );

    scheduledJobs.push(task);

    logInfo('Cron job registered', {
      cron: entry.cron,
      timezone: config.timezone,
      preview: entry.text.slice(0, 60).replace(/\n/g, ' '),
    });
  });

  logSuccess(`${scheduledJobs.length} cron job(s) active`);
}

function getChromeExecutablePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        ]
      : [
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
        ];

  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

function getPuppeteerConfig() {
  const executablePath = getChromeExecutablePath();
  const isLinux = process.platform === 'linux';

  const args = [
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--disable-gpu',
  ];

  if (isLinux) {
    args.push(
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--no-zygote',
      '--single-process'
    );
  }

  const config = {
    headless: true,
    args,
  };

  if (executablePath) {
    config.executablePath = executablePath;
    logInfo('Using browser executable', { path: executablePath });
  } else {
    logWarn(
      'No system browser found. Install Google Chrome, or run: npx puppeteer browsers install chrome'
    );
  }

  return config;
}

function createClient() {
  return new Client({
    authStrategy: new LocalAuth({
      dataPath: SESSIONS_DIR,
      clientId: 'whatsapp-group-bot',
    }),
    puppeteer: getPuppeteerConfig(),
    restartOnAuthFail: true,
    authTimeoutMs: 0,
  });
}

function attachClientEvents(activeClient) {
  activeClient.on('qr', (qr) => {
    logInfo('QR code received. Scan with WhatsApp on your phone (Linked Devices).');
    qrcode.generate(qr, { small: true });
  });

  activeClient.on('authenticated', () => {
    logSuccess('WhatsApp session authenticated');
  });

  activeClient.on('auth_failure', (message) => {
    logError('Authentication failure', { message });
    scheduleReconnect('auth_failure');
  });

  activeClient.on('loading_screen', (percent, message) => {
    logInfo('Loading WhatsApp Web', { percent, message });
  });

  activeClient.on('ready', async () => {
    isReady = true;
    logSuccess('WhatsApp client is ready');

    try {
      const config = loadConfig();
      await resolveTargetChat(config);
      setupCronJobs();
    } catch (err) {
      logError('Startup group resolution failed', { error: err.message });
    }
  });

  activeClient.on('disconnected', (reason) => {
    isReady = false;
    logWarn('WhatsApp client disconnected', { reason });
    clearScheduledJobs();
    scheduleReconnect('disconnected');
  });

  activeClient.on('change_state', (state) => {
    logInfo('Client state changed', { state });
  });
}

function scheduleReconnect(reason) {
  if (isShuttingDown || reconnectTimer) {
    return;
  }

  logInfo(`Scheduling reconnect in ${RECONNECT_DELAY_MS / 1000}s`, { reason });

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startBot().catch((err) => {
      logError('Reconnect attempt failed', { error: err.message });
      scheduleReconnect('reconnect_failed');
    });
  }, RECONNECT_DELAY_MS);
}

async function destroyClient() {
  if (!client) {
    return;
  }

  try {
    await client.destroy();
  } catch (err) {
    logWarn('Error while destroying client', { error: err.message });
  } finally {
    client = null;
    isReady = false;
  }
}

async function startBot() {
  if (isShuttingDown) {
    return;
  }

  await destroyClient();
  client = createClient();
  attachClientEvents(client);

  logInfo('Initializing WhatsApp client...');
  await client.initialize();
}

async function shutdown(signal) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  logInfo(`Graceful shutdown initiated (${signal})`);

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  clearScheduledJobs();
  await destroyClient();

  logSuccess('Shutdown complete');
  process.exit(0);
}

async function main() {
  ensureDirectories();

  try {
    loadConfig();
  } catch (err) {
    logError('Invalid configuration', { error: err.message });
    process.exit(1);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    logError('Uncaught exception', { error: err.message, stack: err.stack });
  });

  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    logError('Unhandled promise rejection', { error: message });

    if (message.toLowerCase().includes('auth timeout') && !isShuttingDown) {
      scheduleReconnect('auth_timeout');
    }
  });

  logInfo('WhatsApp Group Automation Bot starting...');

  try {
    await startBot();
  } catch (err) {
    logError('Failed to start bot', { error: err.message });
    scheduleReconnect('startup_failed');
  }
}

main();
