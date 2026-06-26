/**
 * Shared AI engine for popup & content script contexts.
 * LanguageModel is only available in extension page contexts, not service workers.
 */
(function (global) {
  'use strict';

  const AI_OPTIONS = {
    expectedInputs: [{ type: 'text', languages: ['en'] }],
    expectedOutputs: [{ type: 'text', languages: ['en'] }],
  };

  const SYSTEM_PROMPT =
    'You are a precise QA helper. You output raw JSON only, matching input keys to mock testing values. Do not wrap code blocks in backticks.';

  const AI_TIMEOUT_MS = 45000;

  /**
   * @returns {Promise<{ status: 'readily' | 'after-download' | 'no', downloading?: boolean, message?: string }>}
   */
  async function checkAICapabilities() {
    try {
      if (typeof LanguageModel !== 'undefined') {
        if (typeof LanguageModel.availability === 'function') {
          const availability = await LanguageModel.availability(AI_OPTIONS);
          return mapModernAvailability(availability);
        }

        if (typeof LanguageModel.capabilities === 'function') {
          const caps = await LanguageModel.capabilities();
          const status = caps?.available ?? caps?.status ?? 'no';
          return mapLegacyAvailability(status);
        }
      }

      const legacyAi = global.ai?.languageModel ?? global.chrome?.ai?.languageModel;
      if (legacyAi && typeof legacyAi.capabilities === 'function') {
        const caps = await legacyAi.capabilities();
        const status = caps?.available ?? caps?.status ?? 'no';
        return mapLegacyAvailability(status);
      }
    } catch (err) {
      return {
        status: 'no',
        message: err?.message || 'Failed to check AI capabilities.',
      };
    }

    return {
      status: 'no',
      message:
        'Built-in AI (LanguageModel) is not available. Requires Chrome 138+ with Gemini Nano enabled.',
    };
  }

  /**
   * @param {string} status
   */
  function mapModernAvailability(status) {
    switch (status) {
      case 'available':
        return { status: 'readily' };
      case 'downloadable':
        return {
          status: 'after-download',
          message: 'Gemini Nano model is downloading. Please wait and try again.',
        };
      case 'downloading':
        return {
          status: 'after-download',
          downloading: true,
          message: 'Model download in progress. Please wait for Chrome to finish.',
        };
      case 'unavailable':
      default:
        return {
          status: 'no',
          message: 'Gemini Nano is unavailable on this device or browser.',
        };
    }
  }

  /**
   * @param {string} status
   */
  function mapLegacyAvailability(status) {
    switch (status) {
      case 'readily':
        return { status: 'readily' };
      case 'after-download':
        return {
          status: 'after-download',
          message: 'Gemini Nano model needs to download. Wait for Chrome to finish.',
        };
      case 'no':
      default:
        return {
          status: 'no',
          message: 'Built-in AI is not available on this device.',
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

    if (capabilities.status === 'after-download') {
      return {
        data: generateFallbackData(fields),
        source: 'fallback',
        warning:
          capabilities.message ||
          'Model is still downloading. Used generic fallback data for now.',
      };
    }

    const fieldPayload = {};
    for (const field of fields) {
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
      'For select fields, use one of the provided option values.',
      'For checkboxes use true or false. For radio buttons use one option value.',
      '',
      JSON.stringify(fieldPayload, null, 2),
    ].join('\n');

    try {
      const aiData = await promptLanguageModel(userPrompt);
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
  async function promptLanguageModel(userPrompt) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

    try {
      const session = await LanguageModel.create({
        ...AI_OPTIONS,
        initialPrompts: [{ role: 'system', content: SYSTEM_PROMPT }],
        signal: controller.signal,
        monitor(m) {
          m.addEventListener('downloadprogress', (event) => {
            const pct = Math.round((event.loaded || 0) * 100);
            console.info(`[QA Smart Form Filler] Model download: ${pct}%`);
          });
        },
      });

      try {
        const result = await session.prompt(userPrompt, { signal: controller.signal });
        return typeof result === 'string' ? result : String(result ?? '');
      } finally {
        session.destroy();
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  global.QASmartAI = {
    checkAICapabilities,
    generateFallbackData,
    generateTestDataWithAI,
    parseAIJson,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
