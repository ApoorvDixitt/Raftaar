// MCQ Solver Content Script
// Stealth DOM: no globals, no data-attributes, CSS pseudo-elements only

(function () {
  // All state is closure-scoped — invisible to page scripts
  let _extractedQuestions = [];
  let _activeClass = null;
  let _cleanupTimer = null;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // PING: lets popup check if content script is loaded
    if (message.type === "PING") {
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === "EXTRACT_QUESTIONS") {
      extractWithRetry(3, 800).then(questions => {
        _extractedQuestions = questions;
        const serializableQuestions = questions.map(q => ({
          index: q.index,
          questionText: q.questionText,
          // isMulti: additive hint for multiple-select (multiple correct answers)
          // questions. Defaults to false so single-answer MCQ behaviour is unchanged.
          isMulti: q.isMulti === true,
          options: q.options.map(o => ({ index: o.index, text: o.text }))
        }));
        sendResponse({ questions: serializableQuestions });
      });
      return true;
    }

    if (message.type === "INJECT_DOTS") {
      // className provided by popup — CSS injected via chrome.scripting.insertCSS (no DOM node)
      injectIndicators(message.answers, message.className);
      sendResponse({ success: true });
      return true;
    }
  });

  // ═══════════════════════════════════════════════════
  // TEXT SANITIZATION
  // Strips hidden content & injection attempts before extraction
  // ═══════════════════════════════════════════════════
  function sanitizeElement(el) {
    const clone = el.cloneNode(true);
    // Remove hidden elements that could contain injection text
    clone.querySelectorAll(
      '[style*="display:none"],[style*="display: none"],' +
      '[style*="visibility:hidden"],[style*="visibility: hidden"],' +
      '[style*="font-size:0"],[style*="font-size: 0"],' +
      '[style*="opacity:0"],[style*="opacity: 0"],' +
      '[hidden],[aria-hidden="true"],.sr-only,' +
      'input[type="hidden"],script,noscript,template,' +
      '[data-ai-instructions],' +
      '[data-testid="acknowledgment-checkpoint"],' +
      '[data-testid="visually-hidden"]'
    ).forEach(n => n.remove());
    // Remove HTML comments
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
    const comments = [];
    while (walker.nextNode()) comments.push(walker.currentNode);
    comments.forEach(c => c.remove());
    return clone.textContent.trim();
  }

  function sanitizeText(text) {
    if (!text) return '';
    // Collapse whitespace
    return text.replace(/\s+/g, ' ').trim();
  }

  // ═══════════════════════════════════════════════════
  // RETRY WRAPPER — polls for questions on SPA pages
  // ═══════════════════════════════════════════════════
  async function extractWithRetry(maxRetries, delayMs) {
    let questions = extractQuestionsFromDOM();
    let attempt = 0;
    while (questions.length === 0 && attempt < maxRetries) {
      await new Promise(r => setTimeout(r, delayMs));
      questions = extractQuestionsFromDOM();
      attempt++;
    }
    return questions;
  }

  // ═══════════════════════════════════════════════════
  // MAIN EXTRACTION — run ALL strategies, merge, deduplicate
  // ═══════════════════════════════════════════════════
  function extractQuestionsFromDOM() {
    clearIndicators();

    // Run every strategy and combine all results
    const all = [
      ...strategyCoursera(),
      ...strategyMoodle(),
      ...strategyGoogleForms(),
      ...strategyCanvas(),
      ...strategyA(),
      ...strategyB(),
      ...strategyC(),
      ...strategyD(),
      // ADDITIVE: dedicated detector for checkbox / multiple-select groups.
      // Runs alongside the existing strategies; dedup removes any overlap.
      ...strategyMultiSelect()
    ];

    const merged = deduplicateQuestions(all);

    // ADDITIVE: annotate each question with a multi-select hint WITHOUT
    // modifying any extraction strategy above. Detection is read-only and
    // derived from the already-extracted option elements. If detection is
    // inconclusive, isMulti stays false and behaviour is identical to before.
    merged.forEach(q => {
      q.isMulti = detectMultiSelect(q);
    });

    return merged;
  }

  // ═══════════════════════════════════════════════════
  // MULTI-SELECT DETECTION (additive, read-only)
  // A question is treated as multiple-select (multiple correct answers)
  // when its option controls are checkboxes rather than radios, since
  // radios are mutually exclusive by definition and checkboxes are not.
  // This never alters question/option extraction — it only inspects the
  // DOM elements already captured by the strategies.
  // ═══════════════════════════════════════════════════
  function detectMultiSelect(question) {
    try {
      const els = (question && question.optionElements) || [];
      if (!els.length) return false;

      let checkboxHits = 0;
      let radioHits = 0;

      const classify = (el) => {
        if (!el) return null;

        // 1) The element itself is a native input
        if (el.matches) {
          if (el.matches('input[type="checkbox"]')) return 'checkbox';
          if (el.matches('input[type="radio"]')) return 'radio';
          // 2) The element itself carries an ARIA role
          if (el.matches('[role="checkbox"]')) return 'checkbox';
          if (el.matches('[role="radio"]')) return 'radio';
        }

        // 3) A native input somewhere inside the element
        if (typeof el.querySelector === 'function') {
          if (el.querySelector('input[type="checkbox"]')) return 'checkbox';
          if (el.querySelector('input[type="radio"]')) return 'radio';
          // 4) An ARIA-role control inside the element (custom widgets)
          if (el.querySelector('[role="checkbox"]')) return 'checkbox';
          if (el.querySelector('[role="radio"]')) return 'radio';
        }

        // 5) A label bound to an input via for=""
        if (el.getAttribute) {
          const forId = el.getAttribute('for');
          if (forId) {
            const bound = document.getElementById(forId);
            if (bound && bound.matches) {
              if (bound.matches('input[type="checkbox"],[role="checkbox"]')) return 'checkbox';
              if (bound.matches('input[type="radio"],[role="radio"]')) return 'radio';
            }
          }
        }

        // 6) Walk up to the nearest option container and look inside it
        if (el.closest) {
          const container = el.closest(
            '.rc-Option,[role="checkbox"],[role="radio"],label,li,div'
          );
          if (container && container !== el && typeof container.querySelector === 'function') {
            if (container.querySelector('input[type="checkbox"],[role="checkbox"]')) return 'checkbox';
            if (container.querySelector('input[type="radio"],[role="radio"]')) return 'radio';
          }
        }

        return null;
      };

      els.forEach(el => {
        const kind = classify(el);
        if (kind === 'checkbox') checkboxHits++;
        else if (kind === 'radio') radioHits++;
      });

      // Multi-select when checkboxes dominate and no radios are present.
      return checkboxHits >= 2 && radioHits === 0;
    } catch (e) {
      return false;
    }
  }

  // ═══════════════════════════════════════════════════
  // COURSERA STRATEGY — robust with multiple fallbacks
  // ═══════════════════════════════════════════════════
  function strategyCoursera() {
    const questions = [];

    // Broad selector: any Submission question container (excludes non-question elements)
    const parts = document.querySelectorAll(
      '[data-testid*="part-Submission_"][data-testid*="Question"]'
    );
    if (parts.length === 0) return questions;

    parts.forEach((part) => {
      // Skip non-MCQ types (text input, free form, reflective)
      const testId = part.getAttribute('data-testid') || '';
      if (/TextInput|FreeForm|Reflective/i.test(testId)) return;

      // === EXTRACT QUESTION TEXT (multiple fallback paths) ===
      let questionText = '';

      // Path 1: legend > cml-viewer (most common)
      const legendEl = part.querySelector('[data-testid="legend"]');
      if (legendEl) {
        const cmlViewer = legendEl.querySelector('[data-testid="cml-viewer"]');
        if (cmlViewer) {
          questionText = sanitizeElement(cmlViewer);
        }
        // Path 2: legend > prompt div (id starts with "prompt-")
        if (!questionText) {
          const promptDiv = legendEl.querySelector('[id^="prompt-"]');
          if (promptDiv) questionText = sanitizeElement(promptDiv);
        }
        // Path 3: legend > any .rc-CML container
        if (!questionText) {
          const cml = legendEl.querySelector('.rc-CML');
          if (cml) questionText = sanitizeElement(cml);
        }
        // Path 4: legend text itself (last resort)
        if (!questionText) {
          questionText = sanitizeElement(legendEl);
        }
      }

      // Path 5: follow aria-labelledby from radiogroup
      if (!questionText) {
        const rg = part.querySelector('[role="radiogroup"]') || part.querySelector('[role="group"]');
        if (rg) {
          const lblId = rg.getAttribute('aria-labelledby');
          if (lblId) {
            const lblEl = document.getElementById(lblId);
            if (lblEl) {
              const cml = lblEl.querySelector('[data-testid="cml-viewer"]') || lblEl;
              questionText = sanitizeElement(cml);
            }
          }
        }
      }

      if (!questionText || questionText.length < 5) return;

      // === EXTRACT OPTIONS (multiple fallback paths) ===
      // Prefer a radiogroup (single-answer MCQ — existing behaviour).
      // ADDITIVE: if there is no radiogroup, fall back to a checkbox group
      // (role="group") which Coursera uses for "select all that apply"
      // multiple-select questions. The option-parsing paths below are
      // identical for both, so single-answer extraction is unchanged.
      const radioGroup =
        part.querySelector('[role="radiogroup"]') ||
        part.querySelector('[role="group"]');
      if (!radioGroup) return;

      let options = [];

      // Path 1: .rc-Option containers (most common)
      const rcOptions = radioGroup.querySelectorAll('.rc-Option');
      if (rcOptions.length >= 2) {
        rcOptions.forEach((optContainer, idx) => {
          // Try multiple text sources
          const labelText = optContainer.querySelector('.cds-checkboxAndRadio-labelText');
          let text = '';
          if (labelText) {
            const viewer = labelText.querySelector('[data-testid="cml-viewer"]');
            text = viewer ? sanitizeElement(viewer) : sanitizeElement(labelText);
          } else {
            // Fallback: try label element directly
            const label = optContainer.querySelector('label');
            if (label) text = sanitizeElement(label);
          }
          if (!text) {
            // Last resort: full option container text
            text = sanitizeElement(optContainer);
          }

          const el = optContainer.querySelector('.cds-choiceInput-root') || optContainer.querySelector('label') || optContainer;
          if (text) {
            options.push({ index: idx, text: cleanOptionText(text), element: el });
          }
        });
      }

      // Path 2: label-based detection (fallback)
      if (options.length < 2) {
        options = [];
        const labels = radioGroup.querySelectorAll('label');
        labels.forEach((label, idx) => {
          const text = sanitizeElement(label);
          const el = label.querySelector('.cds-choiceInput-root') || label;
          if (text) {
            options.push({ index: idx, text: cleanOptionText(text), element: el });
          }
        });
      }

      // Path 3: radio input-based detection (last resort)
      if (options.length < 2) {
        options = [];
        const radios = radioGroup.querySelectorAll('input[type="radio"], input[type="checkbox"]');
        radios.forEach((radio, idx) => {
          const label = radio.closest('label') || document.querySelector(`label[for="${radio.id}"]`);
          const el = label || radio.parentElement;
          const text = sanitizeElement(el);
          if (text) {
            options.push({ index: idx, text: cleanOptionText(text), element: radio.closest('.cds-choiceInput-root') || el });
          }
        });
      }

      if (options.length >= 2) {
        questions.push({
          index: questions.length,
          questionText: questionText,
          options: options,
          optionElements: options.map(o => o.element)
        });
      }
    });

    return questions;
  }

  // ═══════════════════════════════════════════════════
  // MOODLE STRATEGY
  // ═══════════════════════════════════════════════════
  function strategyMoodle() {
    const questions = [];
    const moodleQs = document.querySelectorAll('.que.multichoice, .que.multianswer');
    if (moodleQs.length === 0) return questions;

    moodleQs.forEach((block) => {
      const qTextEl = block.querySelector('.qtext');
      if (!qTextEl) return;
      const questionText = sanitizeElement(qTextEl);
      if (!questionText) return;

      const answerBlock = block.querySelector('.answer');
      if (!answerBlock) return;

      const optionDivs = answerBlock.querySelectorAll('div[class^="r"]');
      const options = [];
      optionDivs.forEach((div, idx) => {
        const label = div.querySelector('label');
        if (!label) return;
        const text = sanitizeElement(label);
        const cleaned = cleanOptionText(text);
        if (cleaned) {
          options.push({ index: idx, text: cleaned, element: label });
        }
      });

      if (options.length >= 2) {
        questions.push({
          index: questions.length,
          questionText: questionText,
          options: options,
          optionElements: options.map(o => o.element)
        });
      }
    });

    return questions;
  }

  // ═══════════════════════════════════════════════════
  // GOOGLE FORMS STRATEGY
  // ═══════════════════════════════════════════════════
  function strategyGoogleForms() {
    const questions = [];
    // Google Forms MCQ containers have div[data-params] with radio groups inside
    const formBlocks = document.querySelectorAll('div[role="listitem"]');
    if (formBlocks.length === 0) return questions;

    formBlocks.forEach((block) => {
      const heading = block.querySelector('[role="heading"]');
      if (!heading) return;
      const questionText = sanitizeElement(heading);
      if (!questionText) return;

      const radioGroup = block.querySelector('[role="radiogroup"], [role="list"]');
      if (!radioGroup) return;

      const optionEls = radioGroup.querySelectorAll('[role="radio"], [data-value]');
      const options = [];
      optionEls.forEach((el, idx) => {
        const label = el.querySelector('[dir="auto"]') || el;
        const text = sanitizeElement(label);
        const cleaned = cleanOptionText(text);
        if (cleaned) {
          options.push({ index: idx, text: cleaned, element: el });
        }
      });

      if (options.length >= 2) {
        questions.push({
          index: questions.length,
          questionText: questionText,
          options: options,
          optionElements: options.map(o => o.element)
        });
      }
    });

    return questions;
  }

  // ═══════════════════════════════════════════════════
  // CANVAS LMS STRATEGY
  // ═══════════════════════════════════════════════════
  function strategyCanvas() {
    const questions = [];
    const canvasQs = document.querySelectorAll('.question.display_question, .question_holder .display_question');
    if (canvasQs.length === 0) return questions;

    canvasQs.forEach((block) => {
      const qTextEl = block.querySelector('.question_text');
      if (!qTextEl) return;
      const questionText = sanitizeElement(qTextEl);
      if (!questionText) return;

      const answerEls = block.querySelectorAll('.answers .answer');
      const options = [];
      answerEls.forEach((ans, idx) => {
        const textEl = ans.querySelector('.answer_text, .answer_label');
        const el = ans.querySelector('label') || ans;
        const text = textEl ? sanitizeElement(textEl) : sanitizeElement(ans);
        if (text) {
          options.push({ index: idx, text: cleanOptionText(text), element: el });
        }
      });

      if (options.length >= 2) {
        questions.push({
          index: questions.length,
          questionText: questionText,
          options: options,
          optionElements: options.map(o => o.element)
        });
      }
    });

    return questions;
  }

  // ═══════════════════════════════════════════════════
  // STRATEGY A: Semantic role detection
  // ═══════════════════════════════════════════════════
  function strategyA() {
    const questions = [];
    const radioGroups = document.querySelectorAll('[role="radiogroup"], fieldset');

    radioGroups.forEach((group) => {
      const legend = group.querySelector('legend, [role="heading"]');
      let questionText = '';

      if (legend) {
        questionText = sanitizeElement(legend);
      }

      // Follow aria-labelledby reference if present
      if (!questionText) {
        const labelledBy = group.getAttribute('aria-labelledby');
        if (labelledBy) {
          const labelEl = document.getElementById(labelledBy);
          if (labelEl) {
            const viewer = labelEl.querySelector('[data-testid="cml-viewer"]') || labelEl;
            questionText = sanitizeElement(viewer);
          }
        }
      }

      if (!questionText) {
        const prev = group.previousElementSibling;
        if (prev) questionText = sanitizeElement(prev);
      }
      if (!questionText) return;

      const radios = group.querySelectorAll('input[type="radio"]');
      if (radios.length < 2) return;

      const options = [];
      radios.forEach((radio, optIdx) => {
        const label = radio.closest('label') || document.querySelector(`label[for="${radio.id}"]`);
        const el = label || radio.parentElement;
        const text = sanitizeElement(el);
        options.push({ index: optIdx, text: cleanOptionText(text), element: el });
      });

      if (options.length >= 2) {
        questions.push({
          index: questions.length,
          questionText: questionText,
          options: options,
          optionElements: options.map(o => o.element)
        });
      }
    });

    return questions;
  }

  // ═══════════════════════════════════════════════════
  // STRATEGY B: Structural pattern matching
  // ═══════════════════════════════════════════════════
  function strategyB() {
    const questions = [];
    const allElements = document.querySelectorAll('div, section, article');
    const optionPattern = /^[A-Da-d][.)]\s|^[1-4][.)]\s|^Option\s[A-D]/i;
    const processed = new Set();

    allElements.forEach(el => {
      if (processed.has(el)) return;
      const children = Array.from(el.children);
      if (children.length < 3) return;

      let questionEl = null;
      let optionEls = [];

      for (const child of children) {
        const text = sanitizeElement(child);
        if (!text) continue;

        if (!questionEl && text.length > 15 && (text.includes('?') || text.length > 30)) {
          questionEl = child;
        } else if (questionEl && (optionPattern.test(text) || (optionEls.length > 0 && text.length < 200))) {
          optionEls.push(child);
        }
      }

      if (questionEl && optionEls.length >= 2 && optionEls.length <= 6) {
        processed.add(el);
        const options = optionEls.map((optEl, idx) => ({
          index: idx,
          text: cleanOptionText(sanitizeElement(optEl)),
          element: optEl
        }));

        questions.push({
          index: questions.length,
          questionText: sanitizeElement(questionEl),
          options: options,
          optionElements: optionEls
        });
      }
    });

    return questions;
  }

  // ═══════════════════════════════════════════════════
  // STRATEGY C: Class/attribute heuristics
  // ═══════════════════════════════════════════════════
  function strategyC() {
    const questions = [];
    const questionSelectors = [
      '.question', '.mcq', '.quiz-question', '.q-block', '.question-block',
      '[class*="question"]', '[class*="quiz"]', '[class*="mcq"]',
      '[data-question]', '[data-quiz]'
    ];

    const questionBlocks = document.querySelectorAll(questionSelectors.join(', '));

    questionBlocks.forEach((block) => {
      const optionSelectors = [
        '.option', '.choice', '.answer', '.answer-choice', '.option-label',
        '[class*="option"]', '[class*="choice"]',
        'label', 'li'
      ];

      const optionEls = block.querySelectorAll(optionSelectors.join(', '));
      if (optionEls.length < 2) return;

      let questionText = '';
      const questionTextEl = block.querySelector(
        '.question-text, .question-stem, .q-text, h2, h3, h4, p:first-of-type, [class*="stem"]'
      );

      if (questionTextEl) {
        questionText = sanitizeElement(questionTextEl);
      } else {
        questionText = sanitizeElement(block);
        optionEls.forEach(opt => {
          questionText = questionText.replace(sanitizeElement(opt), '');
        });
        questionText = questionText.trim();
      }
      if (!questionText) return;

      const options = Array.from(optionEls).slice(0, 6).map((optEl, optIdx) => ({
        index: optIdx,
        text: cleanOptionText(sanitizeElement(optEl)),
        element: optEl
      }));

      if (options.length >= 2) {
        questions.push({
          index: questions.length,
          questionText: questionText,
          options: options,
          optionElements: options.map(o => o.element)
        });
      }
    });

    return questions;
  }

  // ═══════════════════════════════════════════════════
  // STRATEGY D: Form-based detection
  // ═══════════════════════════════════════════════════
  function strategyD() {
    const questions = [];
    const forms = document.querySelectorAll('form');

    forms.forEach(form => {
      const radioGroups = {};
      form.querySelectorAll('input[type="radio"], input[type="checkbox"]').forEach(input => {
        const name = input.name || 'default';
        if (!radioGroups[name]) radioGroups[name] = [];
        radioGroups[name].push(input);
      });

      Object.entries(radioGroups).forEach(([name, inputs]) => {
        if (inputs.length < 2) return;

        const firstInput = inputs[0];
        let questionText = '';

        const container = firstInput.closest('fieldset, div, section');
        if (container) {
          const legend = container.querySelector('legend, h1, h2, h3, h4, h5, p:first-of-type');
          if (legend) questionText = sanitizeElement(legend);
        }

        if (!questionText) {
          const parent = firstInput.closest('div, li, p');
          if (parent && parent.previousElementSibling) {
            questionText = sanitizeElement(parent.previousElementSibling);
          }
        }
        if (!questionText) return;

        const options = inputs.map((input, idx) => {
          const label = input.closest('label') || document.querySelector(`label[for="${input.id}"]`);
          const el = label || input.parentElement;
          return { index: idx, text: cleanOptionText(sanitizeElement(el)), element: el };
        });

        questions.push({
          index: questions.length,
          questionText: questionText,
          options: options,
          optionElements: options.map(o => o.element)
        });
      });
    });

    return questions;
  }

  // ═══════════════════════════════════════════════════
  // STRATEGY MULTI-SELECT (ADDITIVE)
  // Dedicated detector for "select all that apply" / multiple-answer
  // questions built on checkboxes. This runs IN ADDITION to the existing
  // strategies and never modifies them. It targets two shapes:
  //   1) ARIA checkbox groups: [role="group"] containing [role="checkbox"]
  //   2) Native checkbox groups: a container with 2+ input[type="checkbox"]
  // Questions already captured by other strategies are removed by dedup.
  // ═══════════════════════════════════════════════════
  function strategyMultiSelect() {
    const questions = [];
    const seenContainers = new Set();

    const pushFromContainer = (container, optionNodes, getText, getEl) => {
      if (!container || seenContainers.has(container)) return;

      const options = [];
      optionNodes.forEach((node, idx) => {
        const text = cleanOptionText(sanitizeText(getText(node)));
        if (!text) return;
        options.push({ index: options.length, text, element: getEl(node) });
      });
      if (options.length < 2) return;

      // Question text: nearest heading/legend/label above the group.
      let questionText = findQuestionTextFor(container, options);
      if (!questionText || questionText.length < 5) return;

      seenContainers.add(container);
      questions.push({
        index: questions.length,
        questionText,
        options,
        optionElements: options.map(o => o.element)
      });
    };

    // --- Shape 1: ARIA checkbox groups ---
    document.querySelectorAll('[role="group"]').forEach(group => {
      const checkboxes = group.querySelectorAll('[role="checkbox"]');
      if (checkboxes.length < 2) return;
      pushFromContainer(
        group,
        Array.from(checkboxes),
        node => {
          const viewer = node.querySelector('[data-testid="cml-viewer"]');
          const labelText = node.querySelector('.cds-checkboxAndRadio-labelText, label, [dir="auto"]');
          return viewer ? sanitizeElement(viewer)
               : labelText ? sanitizeElement(labelText)
               : sanitizeElement(node);
        },
        node => node
      );
    });

    // --- Shape 2: native checkbox groups ---
    // Group checkboxes by their nearest common container (fieldset/div/ul/form).
    const nativeBoxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
    const byContainer = new Map();
    nativeBoxes.forEach(box => {
      const container = box.closest('fieldset, ul, ol, form, section, div');
      if (!container) return;
      if (!byContainer.has(container)) byContainer.set(container, []);
      byContainer.get(container).push(box);
    });
    // Prefer the tightest container that holds exactly one group of boxes.
    byContainer.forEach((boxes, container) => {
      if (boxes.length < 2) return;
      pushFromContainer(
        container,
        boxes,
        box => {
          const label = box.closest('label') ||
            (box.id ? document.querySelector(`label[for="${box.id}"]`) : null) ||
            box.parentElement;
          return label ? sanitizeElement(label) : '';
        },
        box => box.closest('label') ||
          (box.id ? document.querySelector(`label[for="${box.id}"]`) : null) ||
          box.parentElement ||
          box
      );
    });

    return questions;
  }

  // Find a question stem for a group/container by walking up and looking at
  // common labelling patterns, then stripping option text as a last resort.
  function findQuestionTextFor(container, options) {
    // 1) aria-labelledby on the container
    const lblId = container.getAttribute && container.getAttribute('aria-labelledby');
    if (lblId) {
      const lblEl = document.getElementById(lblId);
      if (lblEl) {
        const viewer = lblEl.querySelector('[data-testid="cml-viewer"]') || lblEl;
        const t = sanitizeElement(viewer);
        if (t && t.length >= 5) return t;
      }
    }

    // 2) legend / heading inside the container or an ancestor
    const scope = container.closest('fieldset, [data-testid*="Question"], .question, [class*="question"], section, form, div') || container;
    const labelEl = scope.querySelector('legend, [role="heading"], .qtext, .question_text, [data-testid="legend"], [id^="prompt-"], h1, h2, h3, h4');
    if (labelEl) {
      const viewer = labelEl.querySelector('[data-testid="cml-viewer"]') || labelEl;
      const t = sanitizeElement(viewer);
      if (t && t.length >= 5) return t;
    }

    // 3) previous sibling text of the group
    let prev = container.previousElementSibling;
    while (prev) {
      const t = sanitizeElement(prev);
      if (t && t.length >= 5) return t;
      prev = prev.previousElementSibling;
    }

    // 4) scope text minus option text
    let t = sanitizeElement(scope);
    options.forEach(o => { if (o.text) t = t.replace(o.text, ''); });
    t = sanitizeText(t);
    return t;
  }

  // ═══════════════════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════════════════
  function cleanOptionText(text) {
    return text.replace(/^[A-Da-d1-4][.)]\s*/, '').trim();
  }

  function deduplicateQuestions(questions) {
    const seen = new Set();
    const unique = [];
    questions.forEach(q => {
      // Use full question text + first option text as key to avoid
      // false dedup when questions share a long common preamble
      const optSig = q.options.map(o => o.text).join('|');
      const key = q.questionText + '||' + optSig;
      if (!seen.has(key)) {
        seen.add(key);
        q.index = unique.length;
        unique.push(q);
      }
    });
    return unique;
  }

  // ═══════════════════════════════════════════════════
  // STEALTH INDICATOR INJECTION
  // - Class name provided by popup (matches page's CSS-in-JS naming: css-XXXXXX)
  // - CSS injected via chrome.scripting.insertCSS — NO <style> element in DOM
  // - Only mutation: class attribute change on existing elements
  // - Auto-cleanup after 2 minutes
  // ═══════════════════════════════════════════════════
  function injectIndicators(answersMap, className) {
    clearIndicators();
    _activeClass = className;

    if (!_extractedQuestions || _extractedQuestions.length === 0) return;

    Object.entries(answersMap).forEach(([qIdx, answer]) => {
      if (answer === null || answer === undefined) return;
      const question = _extractedQuestions[parseInt(qIdx)];
      if (!question) return;

      // ADDITIVE: an answer may be a single option index (single-answer MCQ,
      // unchanged behaviour) OR an array of indices (multiple-select). Both
      // are highlighted the same way — only the number of dots differs.
      const indices = Array.isArray(answer) ? answer : [answer];
      indices.forEach(optIdx => {
        if (optIdx === null || optIdx === undefined) return;
        const option = question.options[optIdx];
        if (!option || !option.element) return;
        option.element.classList.add(_activeClass);
      });
    });

    // Auto-cleanup: remove indicators after 2 minutes
    if (_cleanupTimer) clearTimeout(_cleanupTimer);
    _cleanupTimer = setTimeout(() => clearIndicators(), 120000);
  }

  function clearIndicators() {
    if (_activeClass) {
      document.querySelectorAll('.' + _activeClass).forEach(el => {
        el.classList.remove(_activeClass);
      });
      _activeClass = null;
    }
    if (_cleanupTimer) {
      clearTimeout(_cleanupTimer);
      _cleanupTimer = null;
    }
  }

})();
