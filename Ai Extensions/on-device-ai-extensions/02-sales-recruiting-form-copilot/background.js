const STORAGE_KEYS = { profiles: 'srfc_profiles', activeProfile: 'srfc_active', proKey: 'srfc_pro_key' };
const DAILY_LIMIT = 50;

function getLanguageModel() {
  return globalThis.LanguageModel || self.LanguageModel;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function getUsage() {
  const data = await chrome.storage.local.get('srfc_usage');
  const usage = data.srfc_usage || { date: todayKey(), count: 0 };
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
  await chrome.storage.local.set({ srfc_usage: usage });
}

async function createSession() {
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

  return LanguageModel.create({
    expectedInputs: [{ type: 'text', languages: ['en'] }],
    expectedOutputs: [{ type: 'text', languages: ['en'] }],
    monitor(m) {
      m.addEventListener('downloadprogress', () => {});
    },
  });
}

async function mapFieldsToProfile(fields, profile) {
  const session = await createSession();

  const prompt = `You are a form-filling assistant. Given a user profile and a list of form fields, return a JSON object mapping each field's "id" to the best matching value from the profile.

Profile:
${JSON.stringify(profile, null, 2)}

Form fields (array of {id, label, placeholder, type, name}):
${JSON.stringify(fields, null, 2)}

Rules:
- Match semantically (e.g. "Company Name" → profile.company)
- For textarea/cover letter fields, use profile.pitch
- For skills fields, use profile.skills
- Leave unknown fields as empty string ""
- Return ONLY valid JSON object, no markdown`;

  try {
    const result = await session.prompt(prompt, {
      responseConstraint: { type: 'object', additionalProperties: { type: 'string' } },
    });
    session.destroy?.();
    return JSON.parse(result);
  } catch {
    const result = await session.prompt(prompt);
    session.destroy?.();
    const cleaned = result.replace(/```json\n?|\n?```/g, '').trim();
    return JSON.parse(cleaned);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'SRFC_GET_PROFILES') {
    chrome.storage.local.get([STORAGE_KEYS.profiles, STORAGE_KEYS.activeProfile]).then((data) => {
      sendResponse({
        profiles: data[STORAGE_KEYS.profiles] || [],
        activeId: data[STORAGE_KEYS.activeProfile] || null,
      });
    });
    return true;
  }

  if (msg.type === 'SRFC_SAVE_PROFILES') {
    chrome.storage.local
      .set({
        [STORAGE_KEYS.profiles]: msg.profiles,
        [STORAGE_KEYS.activeProfile]: msg.activeId,
      })
      .then(() => sendResponse({ success: true }));
    return true;
  }

  if (msg.type === 'SRFC_EXPORT_CONFIG') {
    chrome.storage.local.get([STORAGE_KEYS.profiles]).then((data) => {
      sendResponse({ config: { version: 1, profiles: data[STORAGE_KEYS.profiles] || [] } });
    });
    return true;
  }

  if (msg.type === 'SRFC_IMPORT_CONFIG') {
    const profiles = msg.config?.profiles || [];
    chrome.storage.local.set({ [STORAGE_KEYS.profiles]: profiles }).then(() => {
      sendResponse({ success: true, count: profiles.length });
    });
    return true;
  }

  if (msg.type === 'SRFC_AUTOFILL') {
    (async () => {
      try {
        const limit = await checkRateLimit();
        if (!limit.allowed) {
          sendResponse({
            success: false,
            error: `Daily autofill limit reached (${DAILY_LIMIT}). Upgrade to Pro.`,
            upgrade: true,
          });
          return;
        }

        const data = await chrome.storage.local.get([STORAGE_KEYS.profiles, STORAGE_KEYS.activeProfile]);
        const profiles = data[STORAGE_KEYS.profiles] || [];
        const active = profiles.find((p) => p.id === data[STORAGE_KEYS.activeProfile]) || profiles[0];

        if (!active) {
          sendResponse({ success: false, error: 'No profile configured. Add one in the extension popup.' });
          return;
        }

        const mapping = await mapFieldsToProfile(msg.fields, active);
        await incrementUsage();
        const updatedLimit = await checkRateLimit();
        sendResponse({ success: true, mapping, remaining: updatedLimit.remaining });
      } catch (err) {
        const message = err.message?.includes('download')
          ? 'On-device model is downloading. Try again shortly.'
          : err.message || 'Autofill failed.';
        sendResponse({ success: false, error: message });
      }
    })();
    return true;
  }

  if (msg.type === 'SRFC_GET_STATUS') {
    Promise.all([checkRateLimit(), isPro()]).then(([limit, pro]) => {
      sendResponse({ ...limit, pro, dailyLimit: DAILY_LIMIT });
    });
    return true;
  }

  if (msg.type === 'SRFC_SET_PRO_KEY') {
    chrome.storage.local.set({ [STORAGE_KEYS.proKey]: msg.key || '' }).then(() => {
      sendResponse({ success: true });
    });
    return true;
  }

  return false;
});
