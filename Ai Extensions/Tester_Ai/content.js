/**
 * QA Smart Form Filler — Content Script
 * DOM scraping (incl. Shadow DOM) and resilient SPA-friendly injection.
 */
(function () {
  'use strict';

  const FIELD_SELECTOR =
    'input:not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), textarea, select';

  /**
   * @param {Element} element
   * @returns {boolean}
   */
  function isElementVisible(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    if (element.disabled) {
      return false;
    }

    const type = element instanceof HTMLInputElement ? element.type : '';
    if (type === 'hidden') {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }

    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      return false;
    }

    return true;
  }

  /**
   * @param {Element} element
   * @returns {string}
   */
  function resolveLabelText(element) {
    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel?.trim()) {
      return ariaLabel.trim();
    }

    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim())
        .filter(Boolean);
      if (parts.length > 0) {
        return parts.join(' ');
      }
    }

    if (element.id) {
      const explicit = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
      if (explicit?.textContent?.trim()) {
        return explicit.textContent.trim();
      }
    }

    if (element.labels && element.labels.length > 0) {
      const labelText = Array.from(element.labels)
        .map((label) => label.textContent?.trim())
        .filter(Boolean)
        .join(' ');
      if (labelText) {
        return labelText;
      }
    }

    let parent = element.parentElement;
    while (parent) {
      if (parent.tagName === 'LABEL') {
        const clone = parent.cloneNode(true);
        clone.querySelectorAll('input, textarea, select').forEach((node) => node.remove());
        const text = clone.textContent?.trim();
        if (text) {
          return text;
        }
      }
      parent = parent.parentElement;
    }

    const placeholder = element.getAttribute('placeholder');
    if (placeholder?.trim()) {
      return placeholder.trim();
    }

    return '';
  }

  /**
   * @param {Document | DocumentFragment | ShadowRoot | Element} root
   * @param {Element[]} collected
   */
  function collectElementsFromRoot(root, collected) {
    if (!root || typeof root.querySelectorAll !== 'function') {
      return;
    }

    root.querySelectorAll(FIELD_SELECTOR).forEach((element) => {
      if (isElementVisible(element)) {
        collected.push(element);
      }
    });

    root.querySelectorAll('*').forEach((element) => {
      if (element.shadowRoot) {
        collectElementsFromRoot(element.shadowRoot, collected);
      }
    });
  }

  /**
   * @returns {Array<{ key: string, element: Element, meta: Record<string, unknown> }>}
   */
  function scrapeFormFields() {
    const elements = [];
    collectElementsFromRoot(document, elements);

    const unique = new Map();

    elements.forEach((element, index) => {
      const dedupeKey =
        element.name ||
        element.id ||
        `${element.tagName}:${element.type}:${resolveLabelText(element)}:${index}`;

      if (unique.has(dedupeKey)) {
        return;
      }

      const key = `field_${unique.size}`;
      const meta = serializeField(element, key);
      unique.set(dedupeKey, { key, element, meta });
    });

    return Array.from(unique.values());
  }

  /**
   * @param {Element} element
   * @param {string} key
   */
  function serializeField(element, key) {
    const tag = element.tagName.toLowerCase();
    const type =
      element instanceof HTMLInputElement
        ? element.type || 'text'
        : tag === 'textarea'
          ? 'textarea'
          : tag === 'select'
            ? 'select-one'
            : tag;

    /** @type {Record<string, unknown>} */
    const meta = {
      key,
      tag,
      type,
      id: element.id || '',
      name: element.name || '',
      placeholder: element.getAttribute('placeholder') || '',
      label: resolveLabelText(element),
      required: element.required ?? false,
      disabled: element.disabled ?? false,
      min: element.getAttribute('min'),
      max: element.getAttribute('max'),
      pattern: element.getAttribute('pattern') || '',
      autocomplete: element.getAttribute('autocomplete') || '',
    };

    if (element instanceof HTMLSelectElement) {
      meta.options = Array.from(element.options).map((option) => ({
        value: option.value,
        text: option.textContent?.trim() || option.value,
        disabled: option.disabled,
      }));
    }

    if (element instanceof HTMLInputElement && element.type === 'radio' && element.name) {
      const root = element.getRootNode();
      const scope = root instanceof Document || root instanceof ShadowRoot ? root : document;
      const group = scope.querySelectorAll(
        `input[type="radio"][name="${CSS.escape(element.name)}"]`,
      );
      meta.options = Array.from(group).map((radio) => ({
        value: radio.value,
        id: radio.id,
        label: resolveLabelText(radio),
      }));
    }

    return meta;
  }

  /**
   * @param {Element} element
   * @param {unknown} value
   */
  function injectValue(element, value) {
    if (element instanceof HTMLSelectElement) {
      const stringValue = String(value ?? '');
      const match = Array.from(element.options).find(
        (option) => option.value === stringValue || option.text === stringValue,
      );
      if (match) {
        element.value = match.value;
      } else if (element.options.length > 0) {
        element.selectedIndex = 0;
      }
    } else if (element instanceof HTMLInputElement) {
      if (element.type === 'checkbox') {
        element.checked = Boolean(value);
      } else if (element.type === 'radio' && element.name) {
        const root = element.getRootNode();
        const scope = root instanceof Document || root instanceof ShadowRoot ? root : document;
        const group = scope.querySelectorAll(
          `input[type="radio"][name="${CSS.escape(element.name)}"]`,
        );
        const targetValue = String(value ?? '');
        group.forEach((radio) => {
          radio.checked = radio.value === targetValue;
          dispatchInputEvents(radio);
        });
        return;
      } else {
        element.value = String(value ?? '');
      }
    } else if (element instanceof HTMLTextAreaElement) {
      element.value = String(value ?? '');
    } else {
      return;
    }

    dispatchInputEvents(element);
  }

  /**
   * @param {Element} element
   */
  function dispatchInputEvents(element) {
    for (const eventType of ['input', 'change', 'blur']) {
      element.dispatchEvent(new Event(eventType, { bubbles: true, cancelable: true }));
    }
  }

  /**
   * @param {Array<{ key: string, element: Element }>} scraped
   * @param {Record<string, unknown>} data
   */
  function fillFields(scraped, data) {
    let filled = 0;

    for (const { key, element } of scraped) {
      if (!Object.prototype.hasOwnProperty.call(data, key)) {
        continue;
      }

      try {
        injectValue(element, data[key]);
        filled += 1;
      } catch (err) {
        console.warn(`[QA Smart Form Filler] Failed to fill ${key}:`, err);
      }
    }

    return filled;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const handleAsync = async () => {
      try {
        switch (message?.type) {
          case 'SCRAPE_FORM_FIELDS': {
            const scraped = scrapeFormFields();
            return {
              ok: true,
              fields: scraped.map(({ meta }) => meta),
              count: scraped.length,
            };
          }

          case 'CHECK_AI_CAPABILITIES': {
            if (!globalThis.QASmartAI) {
              return { ok: false, error: 'AI engine not loaded.' };
            }
            const capabilities = await globalThis.QASmartAI.checkAICapabilities();
            return { ok: true, capabilities };
          }

          case 'GENERATE_TEST_DATA': {
            if (!globalThis.QASmartAI) {
              return { ok: false, error: 'AI engine not loaded.' };
            }
            const result = await globalThis.QASmartAI.generateTestDataWithAI(message.fields || []);
            return { ok: true, ...result };
          }

          case 'AUTOFILL_FORM': {
            const scraped = scrapeFormFields();

            if (scraped.length === 0) {
              return {
                ok: false,
                error: 'No visible form inputs found on this page.',
                code: 'NO_INPUTS',
              };
            }

            if (!globalThis.QASmartAI) {
              return { ok: false, error: 'AI engine not loaded.' };
            }

            const generation = await globalThis.QASmartAI.generateTestDataWithAI(
              scraped.map(({ meta }) => meta),
            );

            const filledCount = fillFields(scraped, generation.data);

            return {
              ok: true,
              filledCount,
              totalFields: scraped.length,
              source: generation.source,
              warning: generation.warning,
            };
          }

          case 'INJECT_TEST_DATA': {
            const scraped = scrapeFormFields();
            const filledCount = fillFields(scraped, message.data || {});
            return {
              ok: true,
              filledCount,
              totalFields: scraped.length,
            };
          }

          default:
            return { ok: false, error: `Unknown message type: ${message?.type}` };
        }
      } catch (err) {
        return {
          ok: false,
          error: err?.message || 'Unexpected content script error.',
        };
      }
    };

    handleAsync().then(sendResponse);
    return true;
  });
})();
