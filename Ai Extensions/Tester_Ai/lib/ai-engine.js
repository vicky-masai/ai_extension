/**
 * Shared AI engine for popup & content script contexts.
 * Uses the Gemini paid API (gemini-3.1-flash-lite) for context-aware form filling.
 */
(function (global) {
  'use strict';

  const STORAGE_KEY_API = 'geminiApiKey';
  const GEMINI_MODEL = 'gemini-3.1-flash-lite';
  const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

  const SYSTEM_PROMPT = [
    'You are a precise QA form-filling assistant.',
    'Given form field metadata, generate realistic test values for automated QA.',
    'Output raw JSON only — a single object whose keys match the field keys exactly.',
    'Do not wrap output in markdown code blocks.',
    '',
    'Field-type rules:',
    '- text, email, tel, url, password, search: realistic values matching label, name, and placeholder',
    '- textarea: short realistic paragraph appropriate to the label',
    '- number, range: valid number within min/max when provided, otherwise a sensible default',
    '- date: YYYY-MM-DD; time: HH:MM; datetime-local: YYYY-MM-DDTHH:MM',
    '- select (select-one): MUST use an exact "value" from the provided options array (not display text)',
    '- checkbox: boolean true or false based on label context (e.g. opt-in vs required terms)',
    '- radio: MUST use an exact "value" from the provided options array',
    '- Skip hidden or disabled fields — do not include them in the output',
  ].join('\n');

  const AI_TIMEOUT_MS = 45000;

  /**
   * @returns {Promise<string>}
   */
  async function getApiKey() {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const result = await chrome.storage.local.get(STORAGE_KEY_API);
      return String(result[STORAGE_KEY_API] || '').trim();
    }
    return '';
  }

  /**
   * @param {string} apiKey
   * @returns {Promise<void>}
   */
  async function setApiKey(apiKey) {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ [STORAGE_KEY_API]: String(apiKey || '').trim() });
    }
  }

  /**
   * @returns {Promise<{ status: 'readily' | 'after-download' | 'no', downloading?: boolean, message?: string }>}
   */
  async function checkAICapabilities() {
    try {
      const apiKey = await getApiKey();
      if (!apiKey) {
        return {
          status: 'no',
          message: 'Gemini API key not configured. Add your key in the extension popup.',
        };
      }

      return {
        status: 'readily',
        message: `Gemini ${GEMINI_MODEL} ready.`,
      };
    } catch (err) {
      return {
        status: 'no',
        message: err?.message || 'Failed to check Gemini API configuration.',
      };
    }
  }

  /**
   * @param {Record<string, unknown>[]} fields
   * @returns {Record<string, string | number | boolean>}
   */
  function generateFallbackData(fields) {
    const data = {};
    let emailCounter = 1;
    let phoneCounter = 5550100;

    for (const field of fields) {
      const key = field.key;
      const type = String(field.type || 'text').toLowerCase();
      const label = String(field.label || field.name || field.placeholder || '').toLowerCase();
      const name = String(field.name || '').toLowerCase();

      if (type === 'hidden' || field.disabled) {
        continue;
      }

      if (type === 'email' || label.includes('email') || name.includes('email')) {
        data[key] = `qa.tester${emailCounter}@example.com`;
        emailCounter += 1;
        continue;
      }

      if (
        type === 'tel' ||
        label.includes('phone') ||
        name.includes('phone') ||
        name.includes('tel')
      ) {
        data[key] = `+1-555-${String(phoneCounter).slice(-4)}`;
        phoneCounter += 1;
        continue;
      }

      if (type === 'number' || type === 'range') {
        const min = field.min != null ? Number(field.min) : 1;
        const max = field.max != null ? Number(field.max) : 100;
        data[key] = Math.min(max, Math.max(min, 42));
        continue;
      }

      if (type === 'date') {
        data[key] = '2026-06-15';
        continue;
      }

      if (type === 'datetime-local') {
        data[key] = '2026-06-15T10:30';
        continue;
      }

      if (type === 'time') {
        data[key] = '10:30';
        continue;
      }

      if (type === 'url' || label.includes('website') || name.includes('url')) {
        data[key] = 'https://example.com';
        continue;
      }

      if (type === 'password') {
        data[key] = 'TestPass123!';
        continue;
      }

      if (type === 'checkbox') {
        data[key] = true;
        continue;
      }

      if (type === 'radio') {
        data[key] = field.options?.[0]?.value ?? 'option1';
        continue;
      }

      if (field.tag === 'select' && Array.isArray(field.options) && field.options.length > 0) {
        const preferred =
          field.options.find((opt) => !opt.disabled && opt.value) ?? field.options[0];
        data[key] = preferred.value;
        continue;
      }

      if (label.includes('first') && label.includes('name')) {
        data[key] = 'Alex';
        continue;
      }

      if (label.includes('last') && label.includes('name')) {
        data[key] = 'Rivera';
        continue;
      }

      if (label.includes('name') || name.includes('name')) {
        data[key] = 'Alex Rivera';
        continue;
      }

      if (label.includes('address') || name.includes('address')) {
        data[key] = '123 QA Test Lane';
        continue;
      }

      if (label.includes('city') || name.includes('city')) {
        data[key] = 'Testville';
        continue;
      }

      if (label.includes('zip') || label.includes('postal') || name.includes('zip')) {
        data[key] = '94107';
        continue;
      }

      if (label.includes('company') || name.includes('company')) {
        data[key] = 'QA Labs Inc.';
        continue;
      }

      if (label.includes('comment') || label.includes('message') || field.tag === 'textarea') {
        data[key] = 'Automated QA test input generated by QA Smart Form Filler.';
        continue;
      }

      data[key] = `Test value ${key.replace('field_', '')}`;
    }

    return data;
  }

  /**
   * @param {string} raw
   * @returns {Record<string, unknown> | null}
   */
  function parseAIJson(raw) {
    if (!raw || typeof raw !== 'string') {
      return null;
    }

    let cleaned = raw.trim();

    const fenceMatch = cleaned.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
    if (fenceMatch) {
      cleaned = fenceMatch[1].trim();
    }

    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }

    try {
      const parsed = JSON.parse(cleaned);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * @param {Record<string, unknown>[]} fields
   * @returns {Promise<{ data: Record<string, unknown>, source: 'ai' | 'fallback', warning?: string }>}
   */
  async function generateTestDataWithAI(fields) {
    const capabilities = await checkAICapabilities();

    if (capabilities.status === 'no') {
      return {
        data: generateFallbackData(fields),
        source: 'fallback',
        warning: capabilities.message || 'AI unavailable. Used generic fallback data.',
      };
    }

    const fieldPayload = {};
    for (const field of fields) {
      if (field.type === 'hidden' || field.disabled) {
        continue;
      }

      fieldPayload[field.key] = {
        tag: field.tag,
        type: field.type,
        name: field.name,
        id: field.id,
        label: field.label,
        placeholder: field.placeholder,
        required: field.required,
        options: field.options,
      };
    }

    const userPrompt = [
      'Generate realistic QA test values for each form field key below.',
      'Return a single JSON object where each key matches the field key exactly.',
      'Use plausible test data appropriate to each field label, type, and placeholder.',
      'For select dropdowns, pick one of the provided option values exactly.',
      'For checkboxes use true or false. For radio buttons use one option value.',
      '',
      JSON.stringify(fieldPayload, null, 2),
    ].join('\n');

    try {
      const aiData = await promptGeminiAPI(userPrompt);
      const parsed = parseAIJson(aiData);

      if (!parsed) {
        return {
          data: generateFallbackData(fields),
          source: 'fallback',
          warning: 'AI returned malformed JSON. Used generic fallback data.',
        };
      }

      const normalized = {};
      for (const field of fields) {
        if (Object.prototype.hasOwnProperty.call(parsed, field.key)) {
          normalized[field.key] = parsed[field.key];
        }
      }

      if (Object.keys(normalized).length === 0) {
        return {
          data: generateFallbackData(fields),
          source: 'fallback',
          warning: 'AI response did not match any field keys. Used generic fallback data.',
        };
      }

      for (const field of fields) {
        if (!Object.prototype.hasOwnProperty.call(normalized, field.key)) {
          const fallbackSlice = generateFallbackData([field]);
          normalized[field.key] = fallbackSlice[field.key];
        }
      }

      return { data: normalized, source: 'ai' };
    } catch (err) {
      const isAbort = err?.name === 'AbortError';
      return {
        data: generateFallbackData(fields),
        source: 'fallback',
        warning: isAbort
          ? 'AI request timed out. Used generic fallback data.'
          : `AI error: ${err?.message || 'Unknown error'}. Used generic fallback data.`,
      };
    }
  }

  /**
   * @param {string} userPrompt
   * @returns {Promise<string>}
   */
  async function promptGeminiAPI(userPrompt) {
    const apiKey = await getApiKey();
    if (!apiKey) {
      throw new Error('Gemini API key not configured.');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

    try {
      const url = `${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: SYSTEM_PROMPT }],
          },
          contents: [
            {
              role: 'user',
              parts: [{ text: userPrompt }],
            },
          ],
          generationConfig: {
            temperature: 0.3,
            responseMimeType: 'application/json',
          },
        }),
      });

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        const errMsg =
          errBody?.error?.message || `Gemini API request failed (${response.status}).`;
        throw new Error(errMsg);
      }

      const data = await response.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!text) {
        throw new Error('Gemini API returned an empty response.');
      }

      return typeof text === 'string' ? text : String(text);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  global.QASmartAI = {
    checkAICapabilities,
    generateFallbackData,
    generateTestDataWithAI,
    getApiKey,
    parseAIJson,
    setApiKey,
    GEMINI_MODEL,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
