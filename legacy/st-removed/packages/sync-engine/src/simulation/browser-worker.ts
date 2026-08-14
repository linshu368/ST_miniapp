import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { config } from '../lib/config.js';
import { loginStUser } from '../provisioner/st-user.js';
import {
  provisionSimulationConversation,
  type SimulationProvisionResult,
} from '../provisioner/simulation.js';

declare global {
  interface Window {
    __miniappSimulation?: {
      selectCharacter: (
        avatar: string,
        forceNewChat?: boolean
      ) => Promise<{ chatId: string | null }>;
      openChat: (fileName: string) => Promise<{ chatId: string }>;
      changeModel: (model: string) => Promise<{ appliedModel: string }>;
      sendMessage: (input: {
        userMessage: string;
        turnId: string;
        metadata: Record<string, unknown>;
      }) => Promise<{
        assistantReply: string;
        chatId: string | null;
        effectiveConfig: Record<string, unknown>;
      }>;
    };
  }
}

interface WorkerSession {
  context: BrowserContext;
  page: Page;
  stChatId: string;
  queue: Promise<void>;
  lastActiveAt: number;
}

export interface SimulationWorkerInput {
  conversationId: string;
  stHandle: string;
  characterId: string;
  stChatId: string | null;
  userMessage: string;
  turnId: string;
  metadata: Record<string, unknown>;
  requestedModelId?: string | null;
  requestedPresetId?: string | null;
}

export interface SimulationWorkerResult {
  assistantReply: string;
  stChatId: string;
  effectiveConfig: {
    model_id: string;
    model_name: string;
    preset_id: string | null;
    preset_version: string | null;
    sampling: Record<string, unknown>;
  };
}

const sessions = new Map<string, WorkerSession>();
let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  browserPromise ??= chromium.launch({
    executablePath: config.SIMULATION_CHROMIUM_EXECUTABLE,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  return await browserPromise;
}

export async function sendSimulationTurn(
  input: SimulationWorkerInput
): Promise<SimulationWorkerResult> {
  const session = await getOrCreateSession(input);
  let releaseQueue: () => void = () => undefined;
  const previous = session.queue;
  session.queue = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  await previous;

  try {
    session.lastActiveAt = Date.now();
    const provision = await provisionSimulationConversation({
      conversationId: input.conversationId,
      stHandle: input.stHandle,
      characterId: input.characterId,
      requestedModelId: input.requestedModelId,
      requestedPresetId: input.requestedPresetId,
    });

    await session.page.evaluate(async (modelName) => {
      const runtime = (
        window as typeof window & {
          __miniappSimulation?: {
            changeModel: (model: string) => Promise<{ appliedModel: string }>;
          };
        }
      ).__miniappSimulation;
      if (!runtime) throw new Error('simulation runtime is unavailable');
      await runtime.changeModel(modelName);
    }, provision.effectiveOpenRouterModel);

    const generated = await session.page.evaluate(
      async (turn) => {
        const runtime = (
          window as typeof window & {
            __miniappSimulation?: {
              sendMessage: (value: typeof turn) => Promise<{
                assistantReply: string;
                chatId: string | null;
                effectiveConfig: Record<string, unknown>;
              }>;
            };
          }
        ).__miniappSimulation;
        if (!runtime) throw new Error('simulation runtime is unavailable');
        return await runtime.sendMessage(turn);
      },
      {
        userMessage: input.userMessage,
        turnId: input.turnId,
        metadata: input.metadata,
      }
    );

    if (!generated.chatId) {
      throw new Error('ST did not return a chat id after generation');
    }
    session.stChatId = generated.chatId;
    const effective = normalizeEffectiveConfig(generated.effectiveConfig, provision);
    return {
      assistantReply: generated.assistantReply,
      stChatId: generated.chatId,
      effectiveConfig: effective,
    };
  } finally {
    releaseQueue();
  }
}

async function getOrCreateSession(input: SimulationWorkerInput): Promise<WorkerSession> {
  const existing = sessions.get(input.conversationId);
  if (existing) return existing;

  const simulationStBaseUrl = (config.SIMULATION_ST_BASE_URL ?? config.ST_BASE_URL).replace(
    /\/$/,
    ''
  );
  const provision = await provisionSimulationConversation({
    conversationId: input.conversationId,
    stHandle: input.stHandle,
    characterId: input.characterId,
    requestedModelId: input.requestedModelId,
    requestedPresetId: input.requestedPresetId,
  });
  const browser = await getBrowser();
  const context = await browser.newContext();
  const cookieHeader = await loginStUser(input.stHandle);
  const stUrl = new URL(simulationStBaseUrl);
  await context.addCookies(
    cookieHeader
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf('=');
        return {
          name: part.slice(0, separator),
          value: part.slice(separator + 1),
          domain: stUrl.hostname,
          path: '/',
          httpOnly: true,
          secure: stUrl.protocol === 'https:',
        };
      })
  );

  const page = await context.newPage();
  await page.goto(`${simulationStBaseUrl}/?miniapp_simulation=1`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForFunction(() => Boolean(window.__miniappSimulation), undefined, {
    timeout: 90_000,
  });

  if (provision.stUserCreated) {
    await provisionSimulationConversation({
      conversationId: input.conversationId,
      stHandle: input.stHandle,
      characterId: input.characterId,
      requestedModelId: input.requestedModelId,
      requestedPresetId: input.requestedPresetId,
      force: true,
    });
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForFunction(() => Boolean(window.__miniappSimulation), undefined, {
      timeout: 90_000,
    });
  }

  const avatar = `platform_${input.characterId}.png`;
  const stChatId = input.stChatId
    ? await page.evaluate(
        async ({ chatId, characterAvatar }) => {
          const runtime = window.__miniappSimulation;
          if (!runtime) throw new Error('simulation runtime is unavailable');
          await runtime.selectCharacter(characterAvatar, false);
          const result = await runtime.openChat(chatId);
          return result.chatId;
        },
        { chatId: input.stChatId, characterAvatar: avatar }
      )
    : await page.evaluate(async (characterAvatar) => {
        const runtime = window.__miniappSimulation;
        if (!runtime) throw new Error('simulation runtime is unavailable');
        const result = await runtime.selectCharacter(characterAvatar);
        if (!result.chatId) throw new Error('ST failed to create a chat');
        return result.chatId;
      }, avatar);

  const session: WorkerSession = {
    context,
    page,
    stChatId,
    queue: Promise.resolve(),
    lastActiveAt: Date.now(),
  };
  sessions.set(input.conversationId, session);
  return session;
}

function normalizeEffectiveConfig(
  captured: Record<string, unknown>,
  provision: SimulationProvisionResult
): SimulationWorkerResult['effectiveConfig'] {
  const sampling =
    captured.sampling && typeof captured.sampling === 'object' && !Array.isArray(captured.sampling)
      ? (captured.sampling as Record<string, unknown>)
      : {};
  return {
    model_id: provision.effectiveModelId,
    model_name:
      typeof captured.model_name === 'string' && captured.model_name
        ? captured.model_name
        : provision.effectiveOpenRouterModel,
    preset_id: provision.presetId,
    preset_version: provision.presetVersion,
    sampling,
  };
}

export async function closeSimulationBrowser(): Promise<void> {
  for (const session of sessions.values()) {
    await session.context.close();
  }
  sessions.clear();
  if (browserPromise) {
    const browser = await browserPromise;
    browserPromise = null;
    await browser.close();
  }
}
