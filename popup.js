// MCQ Solver - Popup Logic
// Orchestrates: extract → solve → inject
// Stealth: injects content.js on demand, CSS via insertCSS (no DOM node)

const solveBtn = document.getElementById('solveBtn');
const statusEl = document.getElementById('status');

// Generate class name matching common CSS-in-JS patterns (blends with page)
const _cls = 'css-' + Math.random().toString(36).substring(2, 8);

function setStatus(type, message) {
  statusEl.className = `status ${type}`;
  if (type === 'loading') {
    statusEl.innerHTML = `<span class="spinner"></span>${message}`;
  } else {
    statusEl.textContent = message;
  }
}

// Inject content script on demand — never auto-loaded
async function ensureContentScript(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'PING' }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        chrome.scripting.executeScript({
          target: { tabId },
          files: ['content.js']
        }).then(() => setTimeout(resolve, 400))
          .catch(() => resolve());
      } else {
        resolve();
      }
    });
  });
}

// Inject indicator CSS via chrome API — NO <style> element in DOM
async function injectIndicatorCSS(tabId) {
  await chrome.scripting.insertCSS({
    target: { tabId },
    css: `.${_cls}::after{content:'';display:inline-block;width:10px;height:10px;min-width:10px;background:#22c55e;border-radius:50%;box-shadow:0 0 6px rgba(34,197,94,0.5);pointer-events:none;z-index:2147483647;flex-shrink:0;align-self:center;margin-left:8px;vertical-align:middle}`
  });
}

// Remove indicator CSS cleanly
async function removeIndicatorCSS(tabId) {
  try {
    await chrome.scripting.removeCSS({
      target: { tabId },
      css: `.${_cls}::after{content:'';display:inline-block;width:10px;height:10px;min-width:10px;background:#22c55e;border-radius:50%;box-shadow:0 0 6px rgba(34,197,94,0.5);pointer-events:none;z-index:2147483647;flex-shrink:0;align-self:center;margin-left:8px;vertical-align:middle}`
    });
  } catch (e) { /* tab may be closed */ }
}

solveBtn.addEventListener('click', async () => {
  solveBtn.disabled = true;
  setStatus('loading', 'Scanning page for questions...');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab) {
      setStatus('error', 'No active tab found.');
      solveBtn.disabled = false;
      return;
    }

    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:')) {
      setStatus('error', 'Cannot run on Chrome internal pages.');
      solveBtn.disabled = false;
      return;
    }

    // Inject content script only when needed
    await ensureContentScript(tab.id);

    // Extract questions
    chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_QUESTIONS' }, (extractResponse) => {
      if (chrome.runtime.lastError) {
        setStatus('error', 'Could not communicate with page. Try refreshing.');
        solveBtn.disabled = false;
        return;
      }
      handleExtraction(extractResponse, tab.id);
    });
  } catch (err) {
    setStatus('error', `Error: ${err.message}`);
    solveBtn.disabled = false;
  }
});

function handleExtraction(extractResponse, tabId) {
  if (!extractResponse || !extractResponse.questions || extractResponse.questions.length === 0) {
    setStatus('error', 'No MCQ questions found on this page.');
    solveBtn.disabled = false;
    return;
  }

  const questions = extractResponse.questions;
  setStatus('loading', `Found ${questions.length} question(s). Analyzing with AI...`);

  chrome.runtime.sendMessage(
    { type: 'SOLVE_QUESTIONS', questions: questions },
    async (response) => {
      if (chrome.runtime.lastError) {
        setStatus('error', `Communication error: ${chrome.runtime.lastError.message}`);
        solveBtn.disabled = false;
        return;
      }

      if (!response) {
        setStatus('error', 'No response from AI service.');
        solveBtn.disabled = false;
        return;
      }

      if (response.success) {
        const answers = response.answers;
        const answerCount = Object.values(answers).filter(v => v !== null).length;
        const totalQuestions = questions.length;

        // Inject CSS via chrome API (invisible to DOM)
        await injectIndicatorCSS(tabId);

        // Send answers + class name to content script
        chrome.tabs.sendMessage(tabId, {
          type: 'INJECT_DOTS',
          answers: answers,
          className: _cls
        }, () => {
          if (answerCount === totalQuestions) {
            setStatus('success', `Solved ${answerCount} question(s). Correct answers highlighted.`);
          } else if (answerCount > 0) {
            setStatus('partial', `Solved ${answerCount} / ${totalQuestions} questions. Some could not be parsed.`);
          } else {
            setStatus('error', 'Could not determine answers for any question.');
          }
          solveBtn.disabled = false;
        });
      } else {
        setStatus('error', response.error || 'Unknown error occurred.');
        solveBtn.disabled = false;
      }
    }
  );
}
