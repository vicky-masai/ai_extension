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

  /** @typedef {'RATE_LIMIT' | 'QUOTA_EXCEEDED' | 'INVALID_API_KEY' | 'MODEL_UNAVAILABLE' | 'NETWORK_ERROR' | 'TIMEOUT' | 'BAD_RESPONSE' | 'SERVER_ERROR' | 'UNKNOWN'} AIErrorCode */

  /**
   * @param {number} status
   * @param {Record<string, unknown>} errBody
   * @param {Error | null} err
   * @returns {{ code: AIErrorCode, message: string, severity: 'error' | 'warning' }}
   */
  function classifyGeminiError(status, errBody, err) {
    const apiMessage = String(
      /** @type {{ error?: { message?: string, status?: string } }} */ (errBody)?.error?.message ||
        err?.message ||
        '',
    );
    const apiStatus = String(
      /** @type {{ error?: { status?: string } }} */ (errBody)?.error?.status || '',
    );
    const lower = apiMessage.toLowerCase();

    if (err?.name === 'AbortError') {
      return {
        code: 'TIMEOUT',
        message: 'Gemini API request timed out. Try again in a moment.',
        severity: 'warning',
      };
    }

    if (
      err instanceof TypeError ||
      /failed to fetch|networkerror|network request failed/i.test(lower)
    ) {
      return {
        code: 'NETWORK_ERROR',
        message: 'Could not reach Gemini API. Check your internet connection.',
        severity: 'error',
      };
    }

    if (status === 429 || apiStatus === 'RESOURCE_EXHAUSTED' || /rate.?limit|too many requests/i.test(lower)) {
      return {
        code: 'RATE_LIMIT',
        message: 'Gemini API rate limit reached. Wait a minute, then try again.',
        severity: 'error',
      };
    }

    if (/quota|billing|exceeded your current quota/i.test(lower)) {
      return {
        code: 'QUOTA_EXCEEDED',
        message: 'Gemini API quota exceeded. Check your plan in Google AI Studio.',
        severity: 'error',
      };
    }

    if (
      status === 401 ||
      status === 403 ||
      apiStatus === 'PERMISSION_DENIED' ||
      /api.?key|invalid.*key|unauthorized/i.test(lower)
    ) {
      return {
        code: 'INVALID_API_KEY',
        message: 'Invalid or unauthorized Gemini API key. Update your key in the popup.',
        severity: 'error',
      };
    }

    if (status === 404 || apiStatus === 'NOT_FOUND' || /model.*not found/i.test(lower)) {
      return {
        code: 'MODEL_UNAVAILABLE',
        message: `Gemini model "${GEMINI_MODEL}" is unavailable. Try again later.`,
        severity: 'error',
      };
    }

    if (status >= 500) {
      return {
        code: 'SERVER_ERROR',
        message: 'Gemini API is temporarily unavailable. Try again shortly.',
        severity: 'warning',
      };
    }

    return {
      code: 'UNKNOWN',
      message: apiMessage || `Gemini API error (${status || 'unknown'}).`,
      severity: 'warning',
    };
  }

  /**
   * @param {unknown} rawValue
   * @returns {string}
   */
  function coerceToString(rawValue) {
    if (rawValue == null) {
      return '';
    }
    if (typeof rawValue === 'object') {
      const obj = /** @type {Record<string, unknown>} */ (rawValue);
      if (obj.value != null) {
        return String(obj.value).trim();
      }
      if (obj.text != null) {
        return String(obj.text).trim();
      }
    }
    return String(rawValue).trim();
  }

  /**
   * @param {Array<{ value?: string, text?: string, disabled?: boolean }>} options
   * @param {unknown} rawValue
   * @returns {string | undefined}
   */
  function resolveSelectOptionValue(options, rawValue) {
    if (!Array.isArray(options) || options.length === 0) {
      return undefined;
    }

    const target = coerceToString(rawValue);
    const enabled = options.filter((opt) => !opt.disabled);
    const pool = enabled.length > 0 ? enabled : options;

    const exactValue = pool.find((opt) => opt.value === target);
    if (exactValue) {
      return exactValue.value;
    }

    const lowerTarget = target.toLowerCase();
    const caseValue = pool.find((opt) => String(opt.value || '').toLowerCase() === lowerTarget);
    if (caseValue) {
      return caseValue.value;
    }

    const exactText = pool.find((opt) => String(opt.text || '').trim() === target);
    if (exactText) {
      return exactText.value;
    }

    const caseText = pool.find(
      (opt) => String(opt.text || '').trim().toLowerCase() === lowerTarget,
    );
    if (caseText) {
      return caseText.value;
    }

    const fallback = pool.find((opt) => opt.value !== '') ?? pool[0];
    return fallback?.value;
  }

  /**
   * @param {Record<string, unknown>[]} fields
   * @param {Record<string, unknown>} data
   * @returns {Record<string, unknown>}
   */
  function normalizeGeneratedData(fields, data) {
    const normalized = { ...data };

    for (const field of fields) {
      if (!Object.prototype.hasOwnProperty.call(normalized, field.key)) {
        continue;
      }

      if (field.tag === 'select' && Array.isArray(field.options)) {
        const resolved = resolveSelectOptionValue(field.options, normalized[field.key]);
        if (resolved != null) {
          normalized[field.key] = resolved;
        }
      }
    }

    return normalized;
  }

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
   * @returns {Promise<{ data: Record<string, unknown>, source: 'ai' | 'fallback', warning?: string, errorCode?: AIErrorCode, errorSeverity?: 'error' | 'warning' }>}
   */
  async function generateTestDataWithAI(fields) {
    const capabilities = await checkAICapabilities();

    if (capabilities.status === 'no') {
      return {
        data: generateFallbackData(fields),
        source: 'fallback',
        warning: capabilities.message || 'AI unavailable. Used generic fallback data.',
        errorCode: 'INVALID_API_KEY',
        errorSeverity: 'error',
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
          errorCode: 'BAD_RESPONSE',
          errorSeverity: 'warning',
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
          errorCode: 'BAD_RESPONSE',
          errorSeverity: 'warning',
        };
      }

      for (const field of fields) {
        if (!Object.prototype.hasOwnProperty.call(normalized, field.key)) {
          const fallbackSlice = generateFallbackData([field]);
          normalized[field.key] = fallbackSlice[field.key];
        }
      }

      return {
        data: normalizeGeneratedData(fields, normalized),
        source: 'ai',
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const errorRecord = /** @type {Record<string, unknown>} */ (error);
      const classified = classifyGeminiError(
        Number(errorRecord.status) || 0,
        /** @type {Record<string, unknown>} */ (errorRecord.body) || {},
        error,
      );

      return {
        data: generateFallbackData(fields),
        source: 'fallback',
        warning: `${classified.message} Used generic fallback data.`,
        errorCode: classified.code,
        errorSeverity: classified.severity,
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
        const classified = classifyGeminiError(response.status, errBody, null);
        const apiError = new Error(classified.message);
        apiError.name = 'GeminiAPIError';
        /** @type {Record<string, unknown>} */ (apiError).status = response.status;
        /** @type {Record<string, unknown>} */ (apiError).body = errBody;
        throw apiError;
      }

      const data = await response.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!text) {
        const emptyError = new Error('Gemini API returned an empty response.');
        emptyError.name = 'GeminiAPIError';
        throw emptyError;
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
