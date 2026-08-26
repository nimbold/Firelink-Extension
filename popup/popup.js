document.addEventListener('DOMContentLoaded', () => {
  const { catalogs, localeCodes, themes, resolveLocale, normalizeLanguagePreference, normalizeTheme } = globalThis.FirelinkPopupI18n;
  const callBrowserApi = (target, methodName, args = []) => {
    const method = target?.[methodName];
    if (typeof method !== 'function') {
      return Promise.resolve({ ok: false, value: undefined });
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok, value) => {
        if (settled) return;
        settled = true;
        resolve({ ok, value });
      };
      const callback = (...values) => {
        if (chrome.runtime.lastError) {
          finish(false, undefined);
          return;
        }
        finish(true, values.length <= 1 ? values[0] : values);
      };

      try {
        const result = method.call(target, ...args, callback);
        if (result && typeof result.then === 'function') {
          result.then((value) => finish(true, value), () => finish(false, undefined));
        }
      } catch (error) {
        finish(false, undefined);
      }
    });
  };
  const globalToggle = document.getElementById('global-toggle');
  const siteToggle = document.getElementById('site-toggle');
  const siteSettingRow = document.getElementById('site-setting-row');
  const hostnameSpan = document.getElementById('current-hostname');
  const settingsToggle = document.getElementById('settings-toggle');
  const settingsPanel = document.getElementById('settings-panel');
  const languageLabel = document.getElementById('language-label');
  const themeLabel = document.getElementById('theme-label');
  const languageSelect = document.getElementById('language-select');
  const themeSelect = document.getElementById('theme-select');
  const statusIndicator = document.getElementById('connection-status');
  const statusText = statusIndicator.querySelector('.status-text');
  const tokenInput = document.getElementById('extension-token');
  const saveTokenBtn = document.getElementById('save-token-btn');
  const pairingSection = document.getElementById('pairing-section');
  const pairingContent = document.getElementById('pairing-content');
  const pairingToggleBtn = document.getElementById('pairing-toggle-btn');
  const pairingDesc = document.getElementById('pairing-desc');
  const fetchMediaBtn = document.getElementById('fetch-media-btn');
  const mediaStatus = document.getElementById('media-status');
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const state = {
    languagePreference: 'system',
    locale: resolveLocale(navigator.language),
    theme: 'system',
    connection: 'checking',
    media: 'currentTab',
    activeTab: null,
    pairingExpanded: false,
    saveState: 'idle'
  };
  let saveResetTimer = null;
  let connectionRequestId = 0;
  let tokenSaveRequestId = 0;
  let tokenSaveMutation = Promise.resolve();
  let siteToggleMutation = Promise.resolve();
  const settingMutationQueues = new Map();
  const settingMutationIds = new Map();
  const persistedSettings = {
    globalCapture: false,
    language: 'system',
    theme: 'system',
    siteToggles: {}
  };
  let storageLoading = true;
  const storageChangedDuringLoad = new Set();

  const normalizeSiteToggles = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return { ...value };
  };

  const cloneSettingValue = (value) => (
    value && typeof value === 'object' ? { ...value } : value
  );

  const nextSettingMutationId = (key) => {
    const mutationId = (settingMutationIds.get(key) || 0) + 1;
    settingMutationIds.set(key, mutationId);
    return mutationId;
  };

  const invalidateSettingMutation = (key) => {
    nextSettingMutationId(key);
  };

  const persistSetting = (key, value, onFailure) => {
    const mutationId = nextSettingMutationId(key);
    const previousMutation = settingMutationQueues.get(key) || Promise.resolve();
    const operation = previousMutation
      .catch(() => {})
      .then(() => callBrowserApi(chrome.storage.local, 'set', [{ [key]: value }]))
      .then((result) => {
        if (result.ok) {
          persistedSettings[key] = cloneSettingValue(value);
        } else if (settingMutationIds.get(key) === mutationId) {
          onFailure?.(cloneSettingValue(persistedSettings[key]));
        }
        return result;
      });
    settingMutationQueues.set(key, operation.catch(() => {}));
    return operation;
  };

  const catalog = () => catalogs[state.locale];

  const isMediaFetchableTab = (tab) => {
    try {
      const url = new URL(tab?.url || '');
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch (error) {
      return false;
    }
  };

  const currentHostname = () => {
    try {
      return new URL(state.activeTab?.url || '').hostname;
    } catch (error) {
      return '';
    }
  };

  const setSelectOptions = (select, options) => {
    select.replaceChildren(...options.map(({ value, label }) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      return option;
    }));
  };

  const renderSettingsOptions = () => {
    const current = catalog();
    setSelectOptions(languageSelect, [
      { value: 'system', label: current.systemDefault },
      ...localeCodes.map((locale) => ({ value: locale, label: current.languageNames[locale] }))
    ]);
    languageSelect.value = state.languagePreference;

    setSelectOptions(themeSelect, themes.map((theme) => ({
      value: theme,
      label: current.themes[theme]
    })));
    themeSelect.value = state.theme;
  };

  const renderStaticCopy = () => {
    const current = catalog();
    document.documentElement.lang = state.locale;
    document.documentElement.dir = current.direction;
    document.documentElement.dataset.locale = state.locale;
    languageLabel.textContent = current.language;
    themeLabel.textContent = current.theme;
    document.getElementById('fetch-media-label').textContent = current.fetchMedia;
    document.getElementById('capture-downloads-label').textContent = current.captureDownloads;
    document.getElementById('disable-on-site-label').textContent = current.disableOnSite;
    document.getElementById('pairing-label').textContent = current.pairingToken;
    tokenInput.placeholder = current.pasteTokenPlaceholder;
    saveTokenBtn.textContent = state.saveState === 'saved'
      ? current.saved
      : state.saveState === 'error'
      ? current.saveFailed
      : current.save;
    settingsToggle.setAttribute('aria-label', current.settings);
    settingsToggle.title = current.settings;
    renderSettingsOptions();
    renderConnection();
    renderMediaStatus();
    renderPairing();
  };

  const renderConnection = () => {
    const current = catalog();
    statusIndicator.classList.remove('connected', 'disconnected');
    if (state.connection === 'connected') {
      statusIndicator.classList.add('connected');
      statusText.textContent = current.appConnected;
    } else if (state.connection === 'checking') {
      statusText.textContent = current.checkingConnection;
    } else if (state.connection === 'setup') {
      statusIndicator.classList.add('disconnected');
      statusText.textContent = current.setupRequired;
    } else if (state.connection === 'invalid') {
      statusIndicator.classList.add('disconnected');
      statusText.textContent = current.invalidToken;
    } else {
      statusIndicator.classList.add('disconnected');
      statusText.textContent = current.appClosed;
    }
  };

  const renderMediaStatus = () => {
    const current = catalog();
    if (state.media === 'currentTab') {
      mediaStatus.textContent = currentHostname() || current.currentTab;
    } else if (state.media === 'openWebPage') {
      mediaStatus.textContent = current.openWebPage;
    } else if (state.media === 'sending') {
      mediaStatus.textContent = current.sending;
    } else if (state.media === 'couldNotSend') {
      mediaStatus.textContent = current.couldNotSend;
    } else if (state.media === 'ambiguous') {
      mediaStatus.textContent = current.mediaAmbiguous;
    } else {
      mediaStatus.textContent = current.opened;
    }
  };

  const renderPairing = () => {
    const current = catalog();
    pairingContent.hidden = !state.pairingExpanded;
    pairingSection.dataset.expanded = String(state.pairingExpanded);
    pairingToggleBtn.setAttribute('aria-expanded', String(state.pairingExpanded));
    pairingToggleBtn.setAttribute('aria-label', state.pairingExpanded ? current.hidePairing : current.showPairing);

    if (state.connection === 'setup') {
      pairingDesc.textContent = current.pasteToken;
    } else if (state.connection === 'connected') {
      pairingDesc.textContent = current.connectedSecurely;
    } else if (state.connection === 'invalid') {
      pairingDesc.textContent = current.invalidTokenUpdate;
    } else if (state.connection === 'checking') {
      pairingDesc.textContent = current.checkingConnection;
    } else {
      pairingDesc.textContent = current.tokenSavedOffline;
    }
  };

  const setPairingExpanded = (expanded) => {
    state.pairingExpanded = expanded;
    renderPairing();
  };

  const setMediaStatusForTab = (tab) => {
    state.activeTab = tab;
    if (!isMediaFetchableTab(tab)) {
      state.media = 'openWebPage';
      fetchMediaBtn.disabled = true;
      renderMediaStatus();
      return;
    }

    state.media = 'currentTab';
    fetchMediaBtn.disabled = false;
    renderMediaStatus();
  };

  const applyTheme = (themePreference) => {
    state.theme = normalizeTheme(themePreference);
    const resolvedTheme = state.theme === 'system'
      ? (mediaQuery.matches ? 'dark' : 'light')
      : state.theme;
    document.documentElement.dataset.theme = state.theme;
    document.documentElement.style.colorScheme = resolvedTheme === 'light' ? 'light' : 'dark';
  };

  const setLanguagePreference = (preference) => {
    state.languagePreference = normalizeLanguagePreference(preference);
    state.locale = state.languagePreference === 'system'
      ? resolveLocale(navigator.language)
      : state.languagePreference;
    renderStaticCopy();
  };

  const checkConnection = async () => {
    const requestId = ++connectionRequestId;
    const token = tokenInput.value.trim();
    const isCurrentRequest = () => requestId === connectionRequestId
      && token === tokenInput.value.trim();
    state.connection = 'checking';
    renderConnection();
    renderPairing();

    if (!token) {
      state.connection = 'setup';
      setPairingExpanded(true);
      renderConnection();
      renderPairing();
      return;
    }

    try {
      await FirelinkProtocol.signedFetch("/ping", token);
      if (!isCurrentRequest()) return;
      state.connection = 'connected';
      setPairingExpanded(false);
    } catch (error) {
      if (!isCurrentRequest()) return;
      if (error?.serverReached && error.status === 403) {
        state.connection = 'invalid';
        setPairingExpanded(true);
        renderConnection();
        return;
      }

      state.connection = 'offline';
    }

    renderConnection();
    renderPairing();
  };

  tokenInput.addEventListener('input', () => {
    connectionRequestId += 1;
    tokenSaveRequestId += 1;
  });

  const loadActiveTab = () => {
    void callBrowserApi(chrome.tabs, 'query', [{ active: true, currentWindow: true }]).then((result) => {
      const tabs = result.ok ? result.value : null;
      if (!Array.isArray(tabs)) {
        setMediaStatusForTab(null);
        siteSettingRow.hidden = true;
        return;
      }
      const tab = tabs.length > 0 && tabs[0]?.url ? tabs[0] : null;
      setMediaStatusForTab(tab);
      if (!isMediaFetchableTab(tab)) {
        siteSettingRow.hidden = true;
        return;
      }

      siteSettingRow.hidden = false;
      const hostname = currentHostname();
      hostnameSpan.textContent = hostname;
      void callBrowserApi(chrome.storage.local, 'get', [['siteToggles']]).then((result) => {
        const values = result.ok ? result.value : null;
        if (!values || typeof values.siteToggles !== 'object'
          || Array.isArray(values.siteToggles)) {
          persistedSettings.siteToggles = {};
          siteToggle.checked = false;
          return;
        }
        persistedSettings.siteToggles = normalizeSiteToggles(values.siteToggles);
        siteToggle.checked = persistedSettings.siteToggles[hostname] === true;
      });
    });
  };

  const saveToken = () => {
    const token = tokenInput.value.trim();
    const requestId = ++tokenSaveRequestId;
    let settled = false;
    const finish = (success) => {
      if (settled || requestId !== tokenSaveRequestId || token !== tokenInput.value.trim()) {
        return;
      }
      settled = true;
      state.saveState = success ? 'saved' : 'error';
      renderStaticCopy();
      if (success) {
        void checkConnection();
      }
      clearTimeout(saveResetTimer);
      saveResetTimer = setTimeout(() => {
        if (requestId !== tokenSaveRequestId) return;
        state.saveState = 'idle';
        renderStaticCopy();
      }, 2000);
    };

    const saveOperation = tokenSaveMutation
      .catch(() => {})
      .then(() => callBrowserApi(chrome.storage.local, 'set', [{ extensionToken: token }]));
    tokenSaveMutation = saveOperation.catch(() => {});
    void saveOperation.then(result => finish(result.ok));
  };

  settingsToggle.addEventListener('click', () => {
    const expanded = settingsPanel.hidden;
    settingsPanel.hidden = !expanded;
    settingsToggle.setAttribute('aria-expanded', String(expanded));
  });

  languageSelect.addEventListener('change', () => {
    const preference = normalizeLanguagePreference(languageSelect.value);
    setLanguagePreference(preference);
    void persistSetting('language', preference, (persistedPreference) => {
      if (state.languagePreference === preference) {
        setLanguagePreference(persistedPreference);
      }
    });
  });

  themeSelect.addEventListener('change', () => {
    const theme = normalizeTheme(themeSelect.value);
    applyTheme(theme);
    renderSettingsOptions();
    void persistSetting('theme', theme, (persistedTheme) => {
      if (state.theme === theme) {
        applyTheme(persistedTheme);
        renderSettingsOptions();
      }
    });
  });

  pairingSection.addEventListener('click', (event) => {
    if (event.target.closest('.pairing-content')) return;
    setPairingExpanded(!state.pairingExpanded);
  });

  globalToggle.addEventListener('change', (event) => {
    const checked = event.target.checked === true;
    void persistSetting('globalCapture', checked, (persistedGlobalCapture) => {
      if (globalToggle.checked === checked) {
        globalToggle.checked = persistedGlobalCapture === true;
      }
    });
  });

  saveTokenBtn.addEventListener('click', saveToken);

  fetchMediaBtn.addEventListener('click', () => {
    if (!isMediaFetchableTab(state.activeTab)) {
      setMediaStatusForTab(state.activeTab);
      return;
    }

    fetchMediaBtn.disabled = true;
    state.media = 'sending';
    renderMediaStatus();
    void callBrowserApi(chrome.runtime, 'sendMessage', [{ action: 'fetchMediaForActiveTab' }]).then((result) => {
      const response = result.ok ? result.value : null;
      if (!response?.ok) {
        state.media = response?.ambiguous === true ? 'ambiguous' : 'couldNotSend';
        fetchMediaBtn.disabled = response?.ambiguous === true;
        renderMediaStatus();
        return;
      }

      state.media = 'opened';
      renderMediaStatus();
      setTimeout(() => setMediaStatusForTab(state.activeTab), 1600);
    });
  });

  siteToggle.addEventListener('change', (event) => {
    const hostname = currentHostname();
    if (!hostname) return;
    const checked = event.target.checked;

    siteToggleMutation = siteToggleMutation
      .catch(() => {})
      .then(async () => {
        const result = await callBrowserApi(chrome.storage.local, 'get', [['siteToggles']]);
        if (!result.ok) {
          if (currentHostname() === hostname && siteToggle.checked === checked) {
            siteToggle.checked = persistedSettings.siteToggles[hostname] === true;
          }
          return;
        }
        const values = result.value && typeof result.value === 'object' ? result.value : {};
        const storedSiteToggles = values.siteToggles;
        const siteToggles = storedSiteToggles
          && typeof storedSiteToggles === 'object'
          && !Array.isArray(storedSiteToggles)
          ? { ...storedSiteToggles }
          : {};
        siteToggles[hostname] = checked;
        const writeResult = await callBrowserApi(chrome.storage.local, 'set', [{ siteToggles }]);
        if (writeResult.ok) {
          persistedSettings.siteToggles = { ...siteToggles };
        } else if (currentHostname() === hostname && siteToggle.checked === checked) {
          siteToggle.checked = persistedSettings.siteToggles[hostname] === true;
        }
      })
      .catch(() => {});
  });

  const onSystemThemeChange = () => {
    if (state.theme === 'system') applyTheme('system');
  };
  if (typeof mediaQuery.addEventListener === 'function') {
    mediaQuery.addEventListener('change', onSystemThemeChange);
  } else if (typeof mediaQuery.addListener === 'function') {
    mediaQuery.addListener(onSystemThemeChange);
  }

  const applyStorageChange = (changes) => {
    if (!changes || typeof changes !== 'object') return;

    const globalChange = changes.globalCapture;
    if (globalChange && typeof globalChange === 'object') {
      invalidateSettingMutation('globalCapture');
      persistedSettings.globalCapture = globalChange.newValue === true;
      globalToggle.checked = persistedSettings.globalCapture;
    }

    const languageChange = changes.language;
    if (languageChange && typeof languageChange === 'object') {
      invalidateSettingMutation('language');
      persistedSettings.language = normalizeLanguagePreference(languageChange.newValue);
      setLanguagePreference(persistedSettings.language);
    }

    const themeChange = changes.theme;
    if (themeChange && typeof themeChange === 'object') {
      invalidateSettingMutation('theme');
      persistedSettings.theme = normalizeTheme(themeChange.newValue);
      applyTheme(persistedSettings.theme);
      renderSettingsOptions();
    }

    const siteTogglesChange = changes.siteToggles;
    if (siteTogglesChange && typeof siteTogglesChange === 'object') {
      persistedSettings.siteToggles = normalizeSiteToggles(siteTogglesChange.newValue);
    }
    if (siteTogglesChange && typeof siteTogglesChange === 'object' && state.activeTab) {
      const hostname = currentHostname();
      siteToggle.checked = persistedSettings.siteToggles[hostname] === true;
    }

    const extensionTokenChange = changes.extensionToken;
    if (extensionTokenChange && typeof extensionTokenChange === 'object'
      && document.activeElement !== tokenInput) {
      tokenInput.value = typeof extensionTokenChange.newValue === 'string'
        ? extensionTokenChange.newValue
        : '';
      void checkConnection();
    }
  };

  if (chrome.storage.onChanged?.addListener) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      for (const key of ['globalCapture', 'siteToggles', 'theme', 'language', 'extensionToken']) {
        if (changes?.[key] && typeof changes[key] === 'object' && storageLoading) {
          storageChangedDuringLoad.add(key);
        }
      }
      applyStorageChange(changes);
    });
  }

  void callBrowserApi(chrome.storage.local, 'get', [
    ['globalCapture', 'siteToggles', 'theme', 'language', 'extensionToken']
  ]).then((storageResult) => {
    let result = storageResult.ok ? storageResult.value : null;
    result = result && typeof result === 'object' ? result : {};
    if (!storageChangedDuringLoad.has('globalCapture')) {
      persistedSettings.globalCapture = result.globalCapture === true;
      globalToggle.checked = persistedSettings.globalCapture;
    }
    if (!storageChangedDuringLoad.has('extensionToken')) {
      tokenInput.value = typeof result.extensionToken === 'string'
        ? result.extensionToken
        : '';
    }
    if (!storageChangedDuringLoad.has('language')) {
      persistedSettings.language = normalizeLanguagePreference(result.language);
      state.languagePreference = persistedSettings.language;
      state.locale = state.languagePreference === 'system'
        ? resolveLocale(navigator.language)
        : state.languagePreference;
    }
    if (!storageChangedDuringLoad.has('theme')) {
      persistedSettings.theme = normalizeTheme(result.theme);
      applyTheme(persistedSettings.theme);
    }
    if (!storageChangedDuringLoad.has('siteToggles')) {
      persistedSettings.siteToggles = normalizeSiteToggles(result.siteToggles);
    }
    storageLoading = false;
    state.pairingExpanded = !tokenInput.value;
    renderStaticCopy();
    loadActiveTab();
    void checkConnection();
  });
});
