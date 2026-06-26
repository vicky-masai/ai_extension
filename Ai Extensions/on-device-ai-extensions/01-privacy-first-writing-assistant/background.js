const DAILY_LIMIT = 20;
const STORAGE_KEYS = { usage: 'pfwa_usage', proKey: 'pfwa_pro_key' };

function getRewriter() {
  return globalThis.Rewriter || (typeof chrome !== 'undefined' && chrome.aiOriginTrial?.rewriter);
}

function getProofreader() {
  return globalThis.Proofreader || (typeof chrome !== 'undefined' && chrome.aiOriginTrial?.proofreader);
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
  if (usage.date !== todayKey()) {
    return { date: todayKey(), count: 0 };
  }
  return usage;
}

async function isPro() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.proKey);
  const key = data[STORAGE_KEYS.proKey];
  return typeof key === 'string' && key.trim().length >= 8;
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

async function handleModelDownload(API, createOptions) {
  const availability = await API.availability(createOptions);
  if (availability === 'unavailable') {
    throw new Error('On-device AI is unavailable on this device or browser.');
  }
  if (availability === 'after-download' || availability === 'downloading') {
    return API.create({
      ...createOptions,
      monitor(m) {
        m.addEventListener('downloadprogress', () => {});
      },
    });
  }
  return API.create(createOptions);
}

async function rewriteText(text, action) {
  const Rewriter = getRewriter();
  const LanguageModel = getLanguageModel();

  if (Rewriter) {
    try {
      const options = {};
      if (action === 'professional') options.tone = 'more-formal';
      if (action === 'casual') options.tone = 'more-casual';
      if (action === 'shorten') options.length = 'shorter';
      if (action === 'lengthen') options.length = 'longer';

      const rewriter = await handleModelDownload(Rewriter, options);
      const result = await rewriter.rewrite(text, options);
      rewriter.destroy?.();
      return result;
    } catch (err) {
      if (action !== 'grammar' && LanguageModel) {
        return grammarViaPrompt(text, action);
      }
      throw err;
    }
  }

  if (action === 'grammar') {
    return proofreadText(text);
  }

  if (LanguageModel) {
    return grammarViaPrompt(text, action);
  }

  throw new Error('No on-device writing APIs available. Enable Chrome built-in AI.');
}

async function proofreadText(text) {
  const Proofreader = getProofreader();
  if (Proofreader) {
    const proofreader = await handleModelDownload(Proofreader, {});
    const result = await proofreader.proofread(text);
    proofreader.destroy?.();
    return typeof result === 'string' ? result : result.correctedText || text;
  }

  const LanguageModel = getLanguageModel();
  if (!LanguageModel) {
    throw new Error('Proofreader API unavailable.');
  }
  return grammarViaPrompt(text, 'grammar');
}

async function grammarViaPrompt(text, action) {
  const LanguageModel = getLanguageModel();
  if (!LanguageModel) {
    throw new Error('Prompt API unavailable.');
  }

  const prompts = {
    professional: `Rewrite the following text in a professional, formal tone. Return only the rewritten text:\n\n${text}`,
    casual: `Rewrite the following text in a casual, friendly tone. Return only the rewritten text:\n\n${text}`,
    shorten: `Shorten the following text while keeping the meaning. Return only the shortened text:\n\n${text}`,
    lengthen: `Expand the following text with more detail. Return only the expanded text:\n\n${text}`,
    grammar: `Fix all grammar, spelling, and punctuation errors. Return only the corrected text:\n\n${text}`,
  };

  const session = await handleModelDownload(LanguageModel, {
    expectedInputs: [{ type: 'text', languages: ['en'] }],
    expectedOutputs: [{ type: 'text', languages: ['en'] }],
  });

  const result = await session.prompt(prompts[action] || prompts.grammar);
  session.destroy?.();
  return result.trim();
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    const actions = [
      { id: 'pfwa-professional', title: 'Make Professional' },
      { id: 'pfwa-casual', title: 'Make Casual' },
      { id: 'pfwa-shorten', title: 'Shorten Text' },
      { id: 'pfwa-lengthen', title: 'Lengthen Text' },
      { id: 'pfwa-grammar', title: 'Fix Grammar' },
    ];
    actions.forEach((a) => {
      chrome.contextMenus.create({
        id: a.id,
        title: a.title,
        contexts: ['selection'],
      });
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id || !info.selectionText) return;

  const actionMap = {
    'pfwa-professional': 'professional',
    'pfwa-casual': 'casual',
    'pfwa-shorten': 'shorten',
    'pfwa-lengthen': 'lengthen',
    'pfwa-grammar': 'grammar',
  };
  const action = actionMap[info.menuItemId];
  if (!action) return;

  try {
    const limit = await checkRateLimit();
    if (!limit.allowed) {
      chrome.tabs.sendMessage(tab.id, {
        type: 'PFWA_ERROR',
        error: `Daily limit reached (${DAILY_LIMIT} fixes). Upgrade to Pro for unlimited access.`,
        upgrade: true,
      });
      return;
    }

    chrome.tabs.sendMessage(tab.id, { type: 'PFWA_LOADING', action });

    const result = await rewriteText(info.selectionText, action);
    await incrementUsage();
    const updatedLimit = await checkRateLimit();

    chrome.tabs.sendMessage(tab.id, {
      type: 'PFWA_RESULT',
      text: result,
      remaining: updatedLimit.remaining,
    });
  } catch (err) {
    const message = err.message?.includes('download')
      ? 'On-device model is downloading. Please try again in a moment.'
      : err.message || 'AI processing failed.';
    chrome.tabs.sendMessage(tab.id, { type: 'PFWA_ERROR', error: message });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'PFWA_GET_STATUS') {
    Promise.all([checkRateLimit(), isPro()]).then(([limit, pro]) => {
      sendResponse({ ...limit, pro, dailyLimit: DAILY_LIMIT });
    });
    return true;
  }
  if (msg.type === 'PFWA_SET_PRO_KEY') {
    chrome.storage.local.set({ [STORAGE_KEYS.proKey]: msg.key || '' }).then(() => {
      sendResponse({ success: true });
    });
    return true;
  }
  return false;
});
