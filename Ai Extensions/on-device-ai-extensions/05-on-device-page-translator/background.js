const DAILY_LIMIT = 30;
const STORAGE_KEYS = { glossary: 'odpt_glossary', targetLang: 'odpt_target', usage: 'odpt_usage', proKey: 'odpt_pro_key' };

function getTranslator() {
  return globalThis.Translator || (typeof chrome !== 'undefined' && chrome.aiOriginTrial?.translator);
}

function getLanguageDetector() {
  return globalThis.LanguageDetector || (typeof chrome !== 'undefined' && chrome.aiOriginTrial?.languageDetector);
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

function applyGlossary(text, glossary) {
  let result = text;
  Object.entries(glossary || {}).forEach(([term, replacement]) => {
    const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    result = result.replace(regex, replacement);
  });
  return result;
}

function protectGlossaryTerms(text, glossary) {
  const placeholders = {};
  let protectedText = text;
  let idx = 0;
  Object.keys(glossary || {}).forEach((term) => {
    const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    protectedText = protectedText.replace(regex, (match) => {
      const key = `__GLOSS_${idx}__`;
      placeholders[key] = match;
      idx += 1;
      return key;
    });
  });
  return { protectedText, placeholders };
}

function restoreGlossaryTerms(text, placeholders) {
  let result = text;
  Object.entries(placeholders).forEach(([key, term]) => {
    result = result.replace(new RegExp(key, 'g'), term);
  });
  return result;
}

async function detectLanguage(text) {
  const LanguageDetector = getLanguageDetector();
  if (!LanguageDetector) {
    throw new Error('Language Detector API unavailable.');
  }

  const availability = await LanguageDetector.availability();
  if (availability === 'unavailable') {
    throw new Error('Language detection unavailable on this device.');
  }

  const detector = await LanguageDetector.create({
    monitor(m) {
      m.addEventListener('downloadprogress', () => {});
    },
  });

  const results = await detector.detect(text.slice(0, 1000));
  detector.destroy?.();
  return results[0]?.detectedLanguage || 'en';
}

async function translateText(text, targetLang, sourceLang) {
  const Translator = getTranslator();
  if (!Translator) {
    throw new Error('Translator API unavailable. Requires Chrome 138+.');
  }

  const data = await chrome.storage.local.get(STORAGE_KEYS.glossary);
  const glossary = data[STORAGE_KEYS.glossary] || {};

  const { protectedText, placeholders } = protectGlossaryTerms(text, glossary);

  const options = { sourceLanguage: sourceLang, targetLanguage: targetLang };
  const availability = await Translator.availability(options);

  if (availability === 'unavailable') {
    throw new Error(`Translation from ${sourceLang} to ${targetLang} unavailable.`);
  }

  const translator = await Translator.create({
    ...options,
    monitor(m) {
      m.addEventListener('downloadprogress', () => {});
    },
  });

  let translated = await translator.translate(protectedText);
  translator.destroy?.();

  translated = restoreGlossaryTerms(translated, placeholders);
  translated = applyGlossary(translated, glossary);

  return translated;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'odpt-translate-selection',
    title: 'Translate Selection (On-Device)',
    contexts: ['selection'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'odpt-translate-selection' || !tab?.id || !info.selectionText) return;

  try {
    const limit = await checkRateLimit();
    if (!limit.allowed) {
      chrome.tabs.sendMessage(tab.id, {
        type: 'ODPT_ERROR',
        error: `Daily limit (${DAILY_LIMIT}) reached. Upgrade to Pro.`,
      });
      return;
    }

    const data = await chrome.storage.local.get(STORAGE_KEYS.targetLang);
    const targetLang = data[STORAGE_KEYS.targetLang] || 'en';

    chrome.tabs.sendMessage(tab.id, { type: 'ODPT_LOADING' });

    const sourceLang = await detectLanguage(info.selectionText);
    const translated = await translateText(info.selectionText, targetLang, sourceLang);
    await incrementUsage();
    const updated = await checkRateLimit();

    chrome.tabs.sendMessage(tab.id, {
      type: 'ODPT_RESULT',
      original: info.selectionText,
      translated,
      sourceLang,
      targetLang,
      remaining: updated.remaining,
    });
  } catch (err) {
    chrome.tabs.sendMessage(tab.id, {
      type: 'ODPT_ERROR',
      error: err.message?.includes('download')
        ? 'Model downloading. Try again shortly.'
        : err.message || 'Translation failed.',
    });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'ODPT_GET_SETTINGS') {
    chrome.storage.local
      .get([STORAGE_KEYS.glossary, STORAGE_KEYS.targetLang, STORAGE_KEYS.proKey])
      .then((data) => {
        sendResponse({
          glossary: data[STORAGE_KEYS.glossary] || {},
          targetLang: data[STORAGE_KEYS.targetLang] || 'en',
        });
      });
    return true;
  }

  if (msg.type === 'ODPT_SAVE_SETTINGS') {
    chrome.storage.local
      .set({
        [STORAGE_KEYS.glossary]: msg.glossary || {},
        [STORAGE_KEYS.targetLang]: msg.targetLang || 'en',
      })
      .then(() => sendResponse({ success: true }));
    return true;
  }

  if (msg.type === 'ODPT_TRANSLATE_ELEMENT') {
    (async () => {
      try {
        const limit = await checkRateLimit();
        if (!limit.allowed) {
          sendResponse({ success: false, error: 'Daily limit reached.', upgrade: true });
          return;
        }

        const data = await chrome.storage.local.get(STORAGE_KEYS.targetLang);
        const targetLang = data[STORAGE_KEYS.targetLang] || 'en';
        const sourceLang = await detectLanguage(msg.text);
        const translated = await translateText(msg.text, targetLang, sourceLang);
        await incrementUsage();
        const updated = await checkRateLimit();
        sendResponse({ success: true, translated, sourceLang, targetLang, remaining: updated.remaining });
      } catch (err) {
        sendResponse({ success: false, error: err.message || 'Translation failed.' });
      }
    })();
    return true;
  }

  if (msg.type === 'ODPT_GET_STATUS') {
    Promise.all([checkRateLimit(), isPro()]).then(([limit, pro]) => {
      sendResponse({ ...limit, pro, dailyLimit: DAILY_LIMIT });
    });
    return true;
  }

  if (msg.type === 'ODPT_SET_PRO_KEY') {
    chrome.storage.local.set({ [STORAGE_KEYS.proKey]: msg.key || '' }).then(() => {
      sendResponse({ success: true });
    });
    return true;
  }

  return false;
});
