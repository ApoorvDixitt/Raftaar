// MCQ Solver - Popup Logic
// Orchestrates: extract → solve → inject
// Token management for Amazon Bedrock

const solveBtn = document.getElementById('solveBtn');
const statusEl = document.getElementById('status');
const settingsBtn = document.getElementById('settingsBtn');
const mainView = document.getElementById('mainView');
const settingsView = document.getElementById('settingsView');
const backBtn = document.getElementById('backBtn');
const tokenInput = document.getElementById('tokenInput');
const saveTokenBtn = document.getElementById('saveTokenBtn');
const deleteTokenBtn = document.getElementById('deleteTokenBtn');
const toggleVisibility = document.getElementById('toggleVisibility');
const tokenStatus = document.getElementById('tokenStatus');
const tokenWarning = document.getElementById('tokenWarning');
const goToSettings = document.getElementById('goToSettings');

const testApiBtn = document.getElementById('testApiBtn');
const testLog = document.getElementById('testLog');

const _cls = 'css-' + Math.random().toString(36).substring(2, 8);

// ═══════════════════════════════════════════════════
// VIEW SWITCHING
// ═══════════════════════════════════════════════════
function showMain() {
  settingsView.style.display = 'none';
  mainView.style.display = 'block';
  checkTokenStatus();
}

function showSettings() {
  mainView.style.display = 'none';
  settingsView.style.display = 'block';
  tokenInput.value = '';
  loadTokenStatus();
}

settingsBtn.addEventListener('click', showSettings);
backBtn.addEventListener('click', showMain);
goToSettings.addEventListener('click', showSettings);

// ═══════════════════════════════════════════════════
// TOKEN MANAGEMENT
// ═══════════════════════════════════════════════════
function checkTokenStatus() {
  chrome.runtime.sendMessage({ type: 'GET_TOKEN' }, (response) => {
    if (response && response.token) {
      tokenWarning.style.display = 'none';
      solveBtn.disabled = false;
    } else {
      tokenWarning.style.display = 'flex';
      solveBtn.disabled = true;
    }
  });
}

function loadTokenStatus() {
  chrome.runtime.sendMessage({ type: 'GET_TOKEN' }, (response) => {
    if (response && response.token) {
      const masked = response.token.substring(0, 8) + '...' + response.token.slice(-4);
      tokenStatus.textContent = `Active: ${masked}`;
      tokenStatus.className = 'token-status active';
      deleteTokenBtn.disabled = false;
    } else {
      tokenStatus.textContent = 'No token configured';
      tokenStatus.className = 'token-status inactive';
      deleteTokenBtn.disabled = true;
    }
  });
}

saveTokenBtn.addEventListener('click', () => {
  const token = tokenInput.value.trim();
  if (!token) {
    tokenStatus.textContent = 'Please enter a token';
    tokenStatus.className = 'token-status inactive';
    return;
  }

  chrome.runtime.sendMessage({ type: 'SAVE_TOKEN', token: token }, (response) => {
    if (response && response.success) {
      tokenInput.value = '';
      tokenStatus.textContent = 'Token saved successfully';
      tokenStatus.className = 'token-status active';
      setTimeout(loadTokenStatus, 1500);
    }
  });
});

deleteTokenBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'DELETE_TOKEN' }, (response) => {
    if (response && response.success) {
      tokenInput.value = '';
      tokenStatus.textContent = 'Token deleted';
      tokenStatus.className = 'token-status inactive';
      deleteTokenBtn.disabled = true;
    }
  });
});

toggleVisibility.addEventListener('click', () => {
  if (tokenInput.type === 'password') {
    tokenInput.type = 'text';
  } else {
    tokenInput.type = 'password';
  }
});

// ═══════════════════════════════════════════════════
// API TEST
// ═══════════════════════════════════════════════════
testApiBtn.addEventListener('click', () => {
  testApiBtn.disabled = true;
  testLog.innerHTML = '';
  appendLog('info', 'Starting API test...');

  chrome.runtime.sendMessage({ type: 'TEST_API' }, (response) => {
    testApiBtn.disabled = false;

    if (chrome.runtime.lastError) {
      appendLog('error', `Runtime error: ${chrome.runtime.lastError.message}`);
      return;
    }

    if (!response) {
      appendLog('error', 'No response from background script.');
      return;
    }

    if (response.logs) {
      response.logs.forEach(log => appendLog(log.type, log.msg));
    }

    if (response.success) {
      appendLog('success', 'API connection test PASSED.');
    } else {
      appendLog('error', 'API connection test FAILED.');
    }
  });
});

function appendLog(type, msg) {
  const line = document.createElement('div');
  line.className = `log-line log-${type}`;
  const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  line.textContent = `[${time}] ${msg}`;
  testLog.appendChild(line);
  testLog.scrollTop = testLog.scrollHeight;
}

// ═══════════════════════════════════════════════════
// STATUS & CONTENT SCRIPT
// ═══════════════════════════════════════════════════
function setStatus(type, message) {
  statusEl.className = `status ${type}`;
  if (type === 'loading') {
    statusEl.innerHTML = `<span class="spinner"></span>${message}`;
  } else {
    statusEl.textContent = message;
  }
}

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

async function injectIndicatorCSS(tabId) {
  await chrome.scripting.insertCSS({
    target: { tabId },
    css: `.${_cls}::after{content:'';display:inline-block;width:10px;height:10px;min-width:10px;background:#22c55e;border-radius:50%;box-shadow:0 0 6px rgba(34,197,94,0.5);pointer-events:none;z-index:2147483647;flex-shrink:0;align-self:center;margin-left:8px;vertical-align:middle}`
  });
}

// ═══════════════════════════════════════════════════
// SOLVE FLOW
// ═══════════════════════════════════════════════════
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

    await ensureContentScript(tab.id);

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

        await injectIndicatorCSS(tabId);

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

// Init
checkTokenStatus();
