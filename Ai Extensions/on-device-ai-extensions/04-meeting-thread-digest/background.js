const DAILY_LIMIT = 10;
const STORAGE_KEYS = { usage: 'mtd_usage', proKey: 'mtd_pro_key' };

function getSummarizer() {
  return globalThis.Summarizer || (typeof chrome !== 'undefined' && chrome.aiOriginTrial?.summarizer);
}

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

async function digestThread(threadText, platform) {
  const Summarizer = getSummarizer();
  const LanguageModel = getLanguageModel();

  let condensed = threadText;
  if (Summarizer) {
    try {
      const availability = await Summarizer.availability({ type: 'key-points', format: 'plain-text' });
      if (availability !== 'unavailable') {
        const summarizer = await Summarizer.create({
          type: 'key-points',
          format: 'plain-text',
          length: 'short',
          monitor(m) {
            m.addEventListener('downloadprogress', () => {});
          },
        });
        condensed = await summarizer.summarize(threadText.slice(0, 12000));
        summarizer.destroy?.();
      }
    } catch {
      condensed = threadText.slice(0, 8000);
    }
  }

  if (!LanguageModel) {
    throw new Error('Prompt API unavailable for executive digest.');
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
    monitor(m) {
      m.addEventListener('downloadprogress', () => {});
    },
  });

  const result = await session.prompt(
    `You are an executive assistant. Analyze this ${platform} thread and produce an HTML executive summary table.

Requirements:
1. Strip noise (greetings, emoji reactions, off-topic banter)
2. Create a table with columns: Category | Detail
3. Include rows for "Executive Summary", each "Decision Made", and each "Assigned Action Item" (with owner if mentioned)
4. Use clean semantic HTML only (<table>, <thead>, <tbody>, <tr>, <th>, <td>, <h3>)
5. No markdown, no code fences

Thread:
${condensed}`
  );
  session.destroy?.();
  return result;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'MTD_GET_STATUS') {
    Promise.all([checkRateLimit(), isPro()]).then(([limit, pro]) => {
      sendResponse({ ...limit, pro, dailyLimit: DAILY_LIMIT });
    });
    return true;
  }

  if (msg.type === 'MTD_SET_PRO_KEY') {
    chrome.storage.local.set({ [STORAGE_KEYS.proKey]: msg.key || '' }).then(() => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (msg.type === 'MTD_DIGEST') {
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

        const html = await digestThread(msg.text, msg.platform);
        await incrementUsage();
        const updated = await checkRateLimit();
        sendResponse({ success: true, html, remaining: updated.remaining });
      } catch (err) {
        sendResponse({
          success: false,
          error: err.message?.includes('download')
            ? 'On-device model downloading. Try again shortly.'
            : err.message || 'Digest failed.',
        });
      }
    })();
    return true;
  }

  return false;
});
