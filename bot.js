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

  if (!config.timezone || typeof config.timezone !== 'string') {
    throw new Error('config.json must include a valid "timezone" string');
  }

  const groupTargets = buildGroupTargets(config);

  if (groupTargets.length === 0) {
    throw new Error('No groups configured. Add a "groups" array or legacy groupName/messages config.');
  }

  const scheduledCrons = new Set();

  for (const group of groupTargets) {
    for (const entry of group.messages) {
      if (!cron.validate(entry.cron)) {
        throw new Error(`Invalid cron expression: "${entry.cron}"`);
      }
      scheduledCrons.add(entry.cron);
    }
  }

  return {
    ...config,
    retry: { ...DEFAULT_RETRY, ...(config.retry || {}) },
    groupTargets,
    scheduledCrons: [...scheduledCrons],
  };
}

function buildGroupMessages(groupConfig, indexLabel) {
  if (Array.isArray(groupConfig.messages) && groupConfig.messages.length > 0) {
    return groupConfig.messages.map((item, index) => {
      if (!item.cron || !item.text) {
        throw new Error(`${indexLabel} messages[${index}] must include both "cron" and "text"`);
      }
      return { cron: item.cron, text: item.text };
    });
  }

  if (!groupConfig.message || typeof groupConfig.message !== 'string') {
    throw new Error(`${indexLabel} must include "messages" or "message" + "schedule"`);
  }

  if (!Array.isArray(groupConfig.schedule) || groupConfig.schedule.length === 0) {
    throw new Error(`${indexLabel} must include a non-empty "schedule" array`);
  }

  return groupConfig.schedule.map((cronExpr) => ({
    cron: cronExpr,
    text: groupConfig.message,
  }));
}

function buildGroupTargets(config) {
  if (Array.isArray(config.groups) && config.groups.length > 0) {
    return config.groups.map((group, index) => {
      const indexLabel = `groups[${index}]`;

      if (!group.groupName && !group.phoneNumber) {
        throw new Error(`${indexLabel} must include "groupName" or "phoneNumber"`);
      }

      return {
        groupName: group.groupName,
        phoneNumber: group.phoneNumber,
        countryCode: group.countryCode,
        messages: buildGroupMessages(group, indexLabel),
      };
    });
  }

  if (!config.groupName && !config.phoneNumber) {
    throw new Error('config.json must include "groups" or "groupName"/"phoneNumber"');
  }

  return [
    {
      groupName: config.groupName,
      phoneNumber: config.phoneNumber,
      countryCode: config.countryCode,
      messages: buildGroupMessages(config, 'config'),
    },
  ];
}

function getGroupCacheKey(groupConfig) {
  return (groupConfig.groupName || groupConfig.phoneNumber || 'default').trim().toLowerCase();
}

function readGroupCacheMap() {
  if (!fs.existsSync(GROUP_CACHE_PATH)) {
    return {};
  }

  try {
    const data = JSON.parse(fs.readFileSync(GROUP_CACHE_PATH, 'utf8'));

    if (data?.groupId) {
      return {
        [getGroupCacheKey({ groupName: data.groupName })]: data,
      };
    }

    return data;
  } catch (err) {
    logWarn('Could not read group cache, will rediscover groups', { error: err.message });
    return {};
  }
}

function saveGroupCacheEntry(groupConfig, chat) {
  const cacheKey = getGroupCacheKey(groupConfig);
  const cacheMap = readGroupCacheMap();

  cacheMap[cacheKey] = {
    groupId: chat.id._serialized,
    groupName: chat.name,
    savedAt: timestamp(),
  };

  fs.writeFileSync(GROUP_CACHE_PATH, JSON.stringify(cacheMap, null, 2), 'utf8');
  logInfo('Group ID cached', cacheMap[cacheKey]);
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

async function resolveTargetChat(groupConfig) {
  const chats = await listAllChats();
  let target = null;

  if (groupConfig.groupName) {
    target = chats.find(
      (chat) => chat.name.trim().toLowerCase() === groupConfig.groupName.trim().toLowerCase()
    );
  }

  if (!target && groupConfig.phoneNumber) {
    const phoneTargets = getPhoneSearchTargets(groupConfig);
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
    logError('Chat not found', {
      groupName: groupConfig.groupName || null,
      phoneNumber: groupConfig.phoneNumber || null,
      availableChats: availableNames,
    });
    throw new Error(
      `Configured chat "${groupConfig.groupName || groupConfig.phoneNumber}" was not found.`
    );
  }

  saveGroupCacheEntry(groupConfig, target);
  logSuccess(`Target chat resolved: "${target.name || groupConfig.groupName}"`, {
    id: target.id._serialized,
    type: target.isGroup ? 'group' : 'contact',
  });
  return target;
}

async function getTargetChat(groupConfig) {
  const cacheKey = getGroupCacheKey(groupConfig);
  const cacheMap = readGroupCacheMap();
  const cache = cacheMap[cacheKey];

  if (cache?.groupId) {
    try {
      const chat = await client.getChatById(cache.groupId);
      if (chat) {
        return chat;
      }
      logWarn('Cached chat ID is invalid, rediscovering chat', { group: cacheKey });
    } catch (err) {
      logWarn('Failed to load cached chat, rediscovering', { group: cacheKey, error: err.message });
    }
  }

  return resolveTargetChat(groupConfig);
}

async function resolveAllGroups(groupTargets) {
  for (const groupConfig of groupTargets) {
    await resolveTargetChat(groupConfig);
  }
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

  logInfo('Scheduled job triggered', { cron: cronExpression, timezone: config.timezone });

  for (const groupConfig of config.groupTargets) {
    const job = groupConfig.messages.find((item) => item.cron === cronExpression);

    if (!job) {
      continue;
    }

    try {
      const chat = await getTargetChat(groupConfig);
      const sent = await sendMessageWithRetry(chat, job.text, config.retry);

      logSuccess('Message sent successfully', {
        group: chat.name,
        groupId: chat.id._serialized,
        cron: cronExpression,
        messageId: sent.id._serialized,
      });
    } catch (err) {
      logError('Failed to send scheduled message', {
        group: groupConfig.groupName || groupConfig.phoneNumber,
        cron: cronExpression,
        error: err.message,
      });
    }
  }
}

function clearScheduledJobs() {
  scheduledJobs.forEach((job) => job.stop());
  scheduledJobs = [];
}

function setupCronJobs() {
  clearScheduledJobs();

  const config = loadConfig();

  config.scheduledCrons.forEach((cronExpression) => {
    const task = cron.schedule(
      cronExpression,
      () => {
        handleScheduledSend(cronExpression).catch((err) => {
          logError('Unhandled error in cron handler', { error: err.message });
        });
      },
      {
        scheduled: true,
        timezone: config.timezone,
      }
    );

    scheduledJobs.push(task);

    config.groupTargets.forEach((groupConfig) => {
      const entry = groupConfig.messages.find((item) => item.cron === cronExpression);
      if (!entry) {
        return;
      }

      logInfo('Cron job registered', {
        group: groupConfig.groupName || groupConfig.phoneNumber,
        cron: cronExpression,
        timezone: config.timezone,
        preview: entry.text.slice(0, 60).replace(/\n/g, ' '),
      });
    });
  });

  logSuccess(`${scheduledJobs.length} cron job(s) active for ${config.groupTargets.length} group(s)`);
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
      await resolveAllGroups(config.groupTargets);
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
