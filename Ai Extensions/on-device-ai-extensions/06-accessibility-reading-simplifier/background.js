const DAILY_LIMIT = 25;
const STORAGE_KEYS = { usage: 'ars_usage', proKey: 'ars_pro_key', settings: 'ars_settings' };

function getLanguageModel() {
  return globalThis.LanguageModel || self.LanguageModel;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function getUsage() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.usage);
  const usage = data[STORAGE_KEYS.usage] || { date: todayKey(), count: 0 };
  if (usage.date !== todayKey()) return { date: todayKey(), count: 0 };
  return usage;
}

async function isPro() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.proKey);
  return typeof data[STORAGE_KEYS.proKey] === 'string' && data[STORAGE_KEYS.proKey].trim().length >= 8;
}

async function checkRateLimit() {
  if (await isPro()) return { allowed: true, remaining: Infinity };
  const usage = await getUsage();
  const remaining = Math.max(0, DAILY_LIMIT - usage.count);
  return { allowed: remaining > 0, remaining, limit: DAILY_LIMIT };
}

async function incrementUsage() {
  if (await isPro()) return;
  const usage = await getUsage();
  usage.count += 1;
  await chrome.storage.local.set({ [STORAGE_KEYS.usage]: usage });
}

async function simplifyText(text) {
  const LanguageModel = getLanguageModel();
  if (!LanguageModel) {
    throw new Error('Prompt API unavailable. Requires Chrome 138+ with on-device AI.');
  }

  const availability = await LanguageModel.availability({
    expectedInputs: [{ type: 'text', languages: ['en'] }],
    expectedOutputs: [{ type: 'text', languages: ['en'] }],
  });

  if (availability === 'unavailable') {
    throw new Error('On-device AI unavailable on this device.');
  }

  const session = await LanguageModel.create({
    expectedInputs: [{ type: 'text', languages: ['en'] }],
    expectedOutputs: [{ type: 'text', languages: ['en'] }],
    initialPrompts: [
      {
        role: 'system',
        content:
          'You simplify complex text for readers with dyslexia, ADHD, or cognitive load challenges. Use short sentences, plain English, active voice, and common words. Preserve meaning. Return only the simplified text.',
      },
    ],
    monitor(m) {
      m.addEventListener('downloadprogress', () => {});
    },
  });

  const result = await session.prompt(
    `Simplify this text into plain, easy-to-read English. Break long sentences. Use simple words.\n\n${text.slice(0, 6000)}`
  );
  session.destroy?.();
  return result.trim();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'ARS_GET_STATUS') {
    Promise.all([checkRateLimit(), isPro(), chrome.storage.local.get(STORAGE_KEYS.settings)]).then(
      ([limit, pro, data]) => {
        sendResponse({
          ...limit,
          pro,
          dailyLimit: DAILY_LIMIT,
          settings: data[STORAGE_KEYS.settings] || { dyslexiaFont: true, lineSpacing: 1.8, fontSize: 18 },
        });
      }
    );
    return true;
  }

  if (msg.type === 'ARS_SET_PRO_KEY') {
    chrome.storage.local.set({ [STORAGE_KEYS.proKey]: msg.key || '' }).then(() => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (msg.type === 'ARS_SAVE_SETTINGS') {
    chrome.storage.local.set({ [STORAGE_KEYS.settings]: msg.settings }).then(() => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (msg.type === 'ARS_SIMPLIFY') {
    (async () => {
      try {
        const limit = await checkRateLimit();
        if (!limit.allowed) {
          sendResponse({
            success: false,
            error: `Daily limit reached (${DAILY_LIMIT}). Upgrade to Pro.`,
            upgrade: true,
          });
          return;
        }

        const simplified = await simplifyText(msg.text);
        await incrementUsage();
        const updated = await checkRateLimit();
        sendResponse({ success: true, simplified, remaining: updated.remaining });
      } catch (err) {
        sendResponse({
          success: false,
          error: err.message?.includes('download')
            ? 'Model downloading. Try again shortly.'
            : err.message || 'Simplification failed.',
        });
      }
    })();
    return true;
  }

  return false;
});
