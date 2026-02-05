import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
} from './config.js';
import {
  getAllChats,
  getAllTasks,
  getLastGroupSync,
  getMessagesSince,
  getNewMessages,
  getTaskById,
  initDatabase,
  setLastGroupSync,
  storeChatMetadata,
  storeSimpleMessage,
  updateChatName,
} from './db.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { NewMessage, RegisteredGroup, Session } from './types.js';
import { loadJson, saveJson } from './utils.js';
import { logger } from './logger.js';
import { kimi } from './ai/kimi-client.js';
import { ChannelManager } from './channels/manager.js';
import { TelegramChannel } from './channels/telegram.js';
import { IncomingMessage } from './channels/types.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

let lastTimestamp = '';
let sessions: Session = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;
let groupSyncTimerStarted = false;
let channelManager: ChannelManager;

interface AgentOutput {
  result: string;
  status: 'success' | 'error';
  error?: string;
  newSessionId?: string;
}

function loadState(): void {
  const statePath = path.join(DATA_DIR, 'router_state.json');
  const state = loadJson<{
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  }>(statePath, {});
  lastTimestamp = state.last_timestamp || '';
  lastAgentTimestamp = state.last_agent_timestamp || {};
  sessions = loadJson(path.join(DATA_DIR, 'sessions.json'), {});
  registeredGroups = loadJson(
    path.join(DATA_DIR, 'registered_groups.json'),
    {},
  );
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  saveJson(path.join(DATA_DIR, 'router_state.json'), {
    last_timestamp: lastTimestamp,
    last_agent_timestamp: lastAgentTimestamp,
  });
  saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = group;
  saveJson(path.join(DATA_DIR, 'registered_groups.json'), registeredGroups);

  // Create group folder
  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

async function syncGroupMetadata(force = false): Promise<void> {
  // Check if we need to sync (skip if synced recently, unless forced)
  if (!force) {
    const lastSync = getLastGroupSync();
    if (lastSync) {
      const lastSyncTime = new Date(lastSync).getTime();
      const now = Date.now();
      if (now - lastSyncTime < GROUP_SYNC_INTERVAL_MS) {
        logger.debug({ lastSync }, 'Skipping group sync - synced recently');
        return;
      }
    }
  }

  // Group sync not needed for Kimi-based system, but keep for compatibility
  setLastGroupSync();
  logger.debug('Group sync skipped (not needed for Kimi-based system)');
}

function getAvailableGroups(): Array<{
  jid: string;
  name: string | null;
  lastActivity: string | null;
  isRegistered: boolean;
}> {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__')
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

async function processMessage(msg: NewMessage): Promise<void> {
  const group = registeredGroups[msg.chat_jid];
  if (!group) return;

  const content = msg.content.trim();

  // Get all messages since last agent interaction so the session has full context
  const sinceTimestamp = lastAgentTimestamp[msg.chat_jid] || '';
  const missedMessages = getMessagesSince(
    msg.chat_jid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  const lines = missedMessages.map((m) => {
    // Escape XML special characters in content
    const escapeXml = (s: string) =>
      s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    return `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`;
  });
  const prompt = `<messages>\n${lines.join('\n')}\n</messages>`;

  if (!prompt) return;

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing message',
  );

  const response = await runAgent(group, prompt, msg.chat_jid);

  if (response) {
    lastAgentTimestamp[msg.chat_jid] = msg.timestamp;
    await sendMessage(msg.chat_jid, `${ASSISTANT_NAME}: ${response}`);
  }
}

const SYSTEM_PROMPT = `You are ${ASSISTANT_NAME}, a helpful AI assistant.

You are participating in a group conversation. Review the message history provided in XML format and respond naturally.

Guidelines:
- Be helpful, friendly, and concise
- Reference previous messages when relevant
- If asked to perform tasks, do so to the best of your ability
- If you don't know something, say so honestly
- Keep responses appropriate for group chat context

The messages are provided in this format:
<message sender="Name" time="ISO timestamp">Content</message>`;

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
): Promise<string | null> {
  try {
    const content = await kimi.complete(prompt, SYSTEM_PROMPT);
    
    return content;
  } catch (err) {
    logger.error({ group: group.name, err }, 'Kimi API error');
    return null;
  }
}

async function sendMessage(jid: string, text: string): Promise<void> {
  try {
    logger.info({ jid, length: text.length }, 'Message sent');
    
    // Send via Telegram channel manager
    if (channelManager) {
      await channelManager.sendMessage('telegram', jid, text);
    }
  } catch (err) {
    logger.error({ jid, err }, 'Failed to send message');
  }
}

async function handleIncomingMessage(msg: IncomingMessage): Promise<void> {
  try {
    // Check if this is for a registered group
    const group = registeredGroups[msg.chatId];
    if (!group) {
      // Auto-register new chats
      logger.info({ chatId: msg.chatId, name: msg.chatName }, 'Auto-registering new chat');
      registerGroup(msg.chatId, {
        name: msg.chatName || msg.chatId,
        folder: `chat_${msg.chatId.replace(/[^a-z0-9]/gi, '_')}`,
        trigger: `@${ASSISTANT_NAME}`,
        added_at: new Date().toISOString(),
      });
    }

    // Store the message
    storeSimpleMessage({
      id: msg.id,
      chatJid: msg.chatId,
      sender: msg.senderId,
      senderName: msg.senderName,
      content: msg.content,
      timestamp: msg.timestamp.toISOString(),
      isFromMe: msg.isFromMe ? 1 : 0,
    });

    // Check if we should respond (mention in groups, always in DMs)
    const isMentioned = msg.content.toLowerCase().includes(`@${ASSISTANT_NAME.toLowerCase()}`);
    const isDM = !msg.isGroup;
    
    if (!isMentioned && !isDM) {
      return; // Ignore group messages without mention
    }

    // Process the message
    const groupData = registeredGroups[msg.chatId]!;
    
    // Get conversation history
    const history = getMessagesSince(msg.chatId, '', ASSISTANT_NAME);
    const context = history.map(m => `${m.sender_name}: ${m.content}`).join('\n');
    
    const prompt = `Conversation history:\n${context}\n\nRespond to the latest message.`;
    
    const response = await runAgent(groupData, prompt, msg.chatId);
    
    if (response) {
      await sendMessage(msg.chatId, `${ASSISTANT_NAME}: ${response}`);
    }
  } catch (err) {
    logger.error({ err, msg }, 'Error handling incoming message');
  }
}

async function runTask(
  taskId: string,
  groupFolder: string,
  prompt: string,
  chatJid: string,
): Promise<void> {
  const group = Object.entries(registeredGroups).find(
    ([, g]) => g.folder === groupFolder,
  )?.[1];

  if (!group) {
    logger.warn({ taskId, groupFolder }, 'Task group not found');
    return;
  }

  const response = await runAgent(group, prompt, chatJid);

  if (response) {
    await sendMessage(chatJid, `${ASSISTANT_NAME} [task ${taskId}]: ${response}`);
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;
  logger.info(`Damien running with Kimi ${process.env.KIMI_MODEL || 'kimi-k2-5'}`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages } = getNewMessages(jids, lastTimestamp, ASSISTANT_NAME);

      if (messages.length > 0)
        logger.info({ count: messages.length }, 'New messages');
      for (const msg of messages) {
        try {
          await processMessage(msg);
          // Only advance timestamp after successful processing for at-least-once delivery
          lastTimestamp = msg.timestamp;
          saveState();
        } catch (err) {
          logger.error(
            { err, msg: msg.id },
            'Error processing message, will retry',
          );
          // Stop processing this batch - failed message will be retried next loop
          break;
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

async function main(): Promise<void> {
  // Verify Kimi API key is configured
  if (!process.env.KIMI_API_KEY) {
    logger.error('KIMI_API_KEY environment variable is required');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: KIMI_API_KEY not configured                           ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Please set the KIMI_API_KEY environment variable:            ║',
    );
    console.error(
      '║  export KIMI_API_KEY="your-api-key"                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    process.exit(1);
  }

  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Initialize channel manager
  channelManager = new ChannelManager();
  
  // Set up incoming message handler
  channelManager.onMessage(handleIncomingMessage);

  // Initialize Telegram if token is provided
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  if (telegramToken) {
    try {
      const telegram = new TelegramChannel(telegramToken);
      await channelManager.registerChannel(telegram);
      logger.info('Telegram channel registered');
    } catch (err) {
      logger.error({ err }, 'Failed to initialize Telegram channel');
    }
  } else {
    logger.warn('TELEGRAM_BOT_TOKEN not set, Telegram integration disabled');
  }
  
  // Start the scheduler with dependencies
  startSchedulerLoop({
    sendMessage,
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
  });
  
  logger.info(`Damien started with Kimi ${process.env.KIMI_MODEL || 'kimi-k2-5'}`);
  
  // Keep the process running
  await new Promise(() => {});
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start Damien');
  process.exit(1);
});
