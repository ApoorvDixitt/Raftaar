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
  // MAIN EXTRACTION — cascading strategies
  // ═══════════════════════════════════════════════════
  function extractQuestionsFromDOM() {
    clearIndicators();
    let questions = [];

    // Platform-specific strategies first
    questions = strategyCoursera();
    if (questions.length > 0) return deduplicateQuestions(questions);

    questions = strategyMoodle();
    if (questions.length > 0) return deduplicateQuestions(questions);

    questions = strategyGoogleForms();
    if (questions.length > 0) return deduplicateQuestions(questions);

    questions = strategyCanvas();
    if (questions.length > 0) return deduplicateQuestions(questions);

    // Generic strategies
    questions = strategyA();
    if (questions.length > 0) return deduplicateQuestions(questions);

    questions = strategyB();
    if (questions.length > 0) return deduplicateQuestions(questions);

    questions = strategyC();
    if (questions.length > 0) return deduplicateQuestions(questions);

    questions = strategyD();
    return deduplicateQuestions(questions);
  }

  // ═══════════════════════════════════════════════════
  // COURSERA STRATEGY
  // ═══════════════════════════════════════════════════
  function strategyCoursera() {
    const questions = [];
    const parts = document.querySelectorAll(
      '[data-testid="part-Submission_MultipleChoiceQuestion"],' +
      '[data-testid="part-Submission_CheckboxQuestion"],' +
      '[data-testid="part-Submission_GradedMultipleChoiceQuestion"],' +
      '[data-testid="part-Submission_GradedCheckboxQuestion"],' +
      '[data-testid*="MultipleChoice"],' +
      '[data-testid*="Checkbox"]'
    );
    if (parts.length === 0) return questions;

    parts.forEach((part) => {
      // Get question text from the prompt/cml-viewer inside the legend
      const legendEl = part.querySelector('[data-testid="legend"]');
      if (!legendEl) return;
      const promptEl = legendEl.querySelector('[data-testid="cml-viewer"]');
      if (!promptEl) return;
      const questionText = sanitizeElement(promptEl);
      if (!questionText) return;

      // Get options from radiogroup or checkbox group
      const radioGroup = part.querySelector('[role="radiogroup"], [role="group"]');
      if (!radioGroup) return;

      const optionContainers = radioGroup.querySelectorAll('.rc-Option');
      const options = [];
      optionContainers.forEach((optContainer, idx) => {
        const labelText = optContainer.querySelector('.cds-checkboxAndRadio-labelText');
        if (!labelText) return;
        const viewer = labelText.querySelector('[data-testid="cml-viewer"]');
        // Target the radio wrapper — ::after appears right next to the radio circle
        const el = optContainer.querySelector('.cds-choiceInput-root') || optContainer.querySelector('label') || optContainer;
        const text = viewer ? sanitizeElement(viewer) : sanitizeElement(labelText);
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

    Object.entries(answersMap).forEach(([qIdx, optIdx]) => {
      if (optIdx === null) return;
      const question = _extractedQuestions[parseInt(qIdx)];
      if (!question) return;
      const option = question.options[optIdx];
      if (!option || !option.element) return;

      option.element.classList.add(_activeClass);
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
