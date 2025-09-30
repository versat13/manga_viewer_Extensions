// Popup script for Manga Viewer Extension - Fixed Version

class PopupManager {
  constructor() {
    this.currentTab = null;
    this.hostname = '';
    this.init();
  }

  async init() {
    try {
      await this.getCurrentTab();
      await this.loadSettings();
      this.setupEventListeners();
      await this.updateUI();
    } catch (error) {
      console.error('Popup initialization failed:', error);
    }
  }

  async getCurrentTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      this.currentTab = tab;
      this.hostname = new URL(tab.url).hostname;
      
      document.getElementById('currentSite').textContent = `現在のサイト: ${this.hostname}`;
    } catch (error) {
      console.error('Failed to get current tab:', error);
      this.hostname = 'unknown';
    }
  }

  async loadSettings() {
    try {
      const result = await chrome.storage.sync.get('mangaViewerDomains');
      this.siteSettings = result.mangaViewerDomains || {};
      
      const detectionModeKey = `mangaDetectionMode_${this.hostname}`;
      const detectionResult = await chrome.storage.sync.get(detectionModeKey);
      this.detectionMode = detectionResult[detectionModeKey] || 'auto';
      
    } catch (error) {
      console.error('Failed to load settings:', error);
      this.siteSettings = {};
      this.detectionMode = 'auto';
    }
  }

  setupEventListeners() {
    document.getElementById('launchViewer').addEventListener('click', () => {
      this.launchViewer();
    });

    document.getElementById('testDetection').addEventListener('click', () => {
      this.testDetection();
    });

    document.getElementById('showButton').addEventListener('click', () => {
      this.setSiteMode('show');
    });

    document.getElementById('hideButton').addEventListener('click', () => {
      this.setSiteMode('hide');
    });

    document.getElementById('detectionMode').addEventListener('change', (e) => {
      this.setDetectionMode(e.target.value);
    });



    document.getElementById('resetSiteSettings').addEventListener('click', () => {
      this.resetSiteSettings();
    });

    document.getElementById('showAllSettings').addEventListener('click', () => {
      this.showAllSettings();
    });

    document.getElementById('exportSettings').addEventListener('click', () => {
      this.exportSettings();
    });
  }

  async updateUI() {
    try {
      const siteStatus = this.siteSettings[this.hostname] || 'hide';
      const statusElement = document.getElementById('siteStatus');
      
      if (siteStatus === 'show') {
        statusElement.textContent = '起動ボタンが表示されています';
        statusElement.className = 'status status-show';
      } else {
        statusElement.textContent = '起動ボタンが非表示です';
        statusElement.className = 'status status-hide';
      }

      const detectionStatus = document.getElementById('detectionStatus');
      const detectionSelect = document.getElementById('detectionMode');
      
      detectionSelect.value = this.detectionMode;
      
      const modeNames = {
        'auto': '自動検出',
        'smart': 'スマート検出',
        'deep-scan': 'ディープスキャン',
        'basic': '基本型',
        'frame-reader': 'フレーム型',
        'reading-content': 'エリア型',
        'chapter-content': 'チャプター型',
        'manga-reader': 'リーダー型',
        'entry-content': 'エントリー型',
        'niconico-seiga': 'Canvasモード'
      };
      
      detectionStatus.textContent = `現在: ${modeNames[this.detectionMode] || this.detectionMode}`;

    } catch (error) {
      console.error('Failed to update UI:', error);
    }
  }

  async launchViewer() {
    try {
      const button = document.getElementById('launchViewer');
      button.textContent = '起動中...';
      button.classList.add('loading');

      if (!this.currentTab || !this.currentTab.id) {
        throw new Error('タブ情報を取得できませんでした');
      }

      if (this.currentTab.url.startsWith('chrome://') || this.currentTab.url.startsWith('chrome-extension://')) {
        throw new Error('この種類のページでは動作しません');
      }

      // まずpingを送信してcontent scriptが読み込まれているか確認
      let response;
      try {
        response = await chrome.tabs.sendMessage(this.currentTab.id, { action: 'ping' });
      } catch (pingError) {
        // content scriptが読み込まれていない場合は注入を試みる
        console.log('[Popup] Content script not loaded, attempting injection...');
        try {
          await chrome.scripting.executeScript({
            target: { tabId: this.currentTab.id },
            files: ['content.js']
          });
          
          // 注入後、少し待機してから再度ping
          await new Promise(resolve => setTimeout(resolve, 1000));
          response = await chrome.tabs.sendMessage(this.currentTab.id, { action: 'ping' });
        } catch (injectError) {
          throw new Error('スクリプトの注入に失敗しました。ページをリロードしてください。');
        }
      }

      // ビューアを起動
      const launchResponse = await chrome.tabs.sendMessage(this.currentTab.id, {
        action: 'launchViewer'
      });

      if (launchResponse && launchResponse.success) {
        button.textContent = '起動完了';
        setTimeout(() => window.close(), 1000);
      } else {
        // 失敗の理由を詳細に表示
        const reason = launchResponse ? launchResponse.reason : 'unknown';
        if (reason === 'insufficient_images') {
          // 画像が見つからない場合は、より詳細なメッセージを表示
          throw new Error('画像が見つかりませんでした。検出モードを変更するか、検出テストを実行してください。');
        } else {
          throw new Error(`起動に失敗しました: ${reason}`);
        }
      }

    } catch (error) {
      console.error('Failed to launch viewer:', error);
      
      let errorMessage = 'ビューアの起動に失敗しました';
      if (error.message.includes('Could not establish connection')) {
        errorMessage = 'ページとの通信に失敗しました。ページをリロードしてから再試行してください。';
      } else if (error.message) {
        errorMessage = error.message;
      }
      
      this.showMessage(errorMessage, 'error');
      
      const button = document.getElementById('launchViewer');
      button.textContent = 'ビューア起動';
      button.classList.remove('loading');
    }
  }

  async testDetection() {
    try {
      const button = document.getElementById('testDetection');
      const resultsDiv = document.getElementById('testResults');
      
      button.textContent = '検出中...';
      button.classList.add('loading');
      resultsDiv.style.display = 'none';

      // content scriptが読み込まれているか確認
      try {
        await chrome.tabs.sendMessage(this.currentTab.id, { action: 'ping' });
      } catch (pingError) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: this.currentTab.id },
            files: ['content.js']
          });
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (injectError) {
          throw new Error('スクリプトの注入に失敗しました');
        }
      }

      const response = await chrome.tabs.sendMessage(this.currentTab.id, {
        action: 'testDetection'
      });

      if (response && response.success && response.results) {
        const results = response.results;
        let resultText = '検出結果:\n';
        
        // 結果を画像数の多い順にソート
        const sortedResults = Object.entries(results).sort((a, b) => b[1] - a[1]);
        
        sortedResults.forEach(([method, count]) => {
          const emoji = count > 0 ? '✅' : '❌';
          resultText += `${emoji} ${method}: ${count}枚\n`;
        });
        
        // 推奨モードを表示
        const bestMode = sortedResults[0];
        if (bestMode && bestMode[1] > 0) {
          resultText += `\n推奨: ${bestMode[0]} (${bestMode[1]}枚)`;
        } else {
          resultText += '\n⚠️ どのモードでも画像が検出できませんでした';
        }
        
        resultsDiv.textContent = resultText;
        resultsDiv.style.display = 'block';
      } else {
        throw new Error(response ? response.error : '検出テストが実行できませんでした');
      }

      button.textContent = '検出テスト';
      button.classList.remove('loading');

    } catch (error) {
      console.error('Detection test failed:', error);
      
      const resultsDiv = document.getElementById('testResults');
      resultsDiv.textContent = `エラー: ${error.message}`;
      resultsDiv.style.display = 'block';
      
      const button = document.getElementById('testDetection');
      button.textContent = '検出テスト';
      button.classList.remove('loading');
    }
  }

  async setSiteMode(mode) {
    try {
      this.siteSettings[this.hostname] = mode;
      await chrome.storage.sync.set({ mangaViewerDomains: this.siteSettings });
      
      // content scriptに通知
      try {
        await chrome.tabs.sendMessage(this.currentTab.id, {
          action: 'updateSiteMode',
          mode: mode
        });
      } catch (communicationError) {
        console.log('Could not notify content script, but setting saved');
      }
      
      await this.updateUI();
      
      const statusText = mode === 'show' ? '表示に設定しました' : '非表示に設定しました';
      this.showMessage(statusText, 'success');
      
    } catch (error) {
      console.error('Failed to set site mode:', error);
      this.showMessage('設定の保存に失敗しました', 'error');
    }
  }

  async setDetectionMode(mode) {
    try {
      this.detectionMode = mode;
      const key = `mangaDetectionMode_${this.hostname}`;
      await chrome.storage.sync.set({ [key]: mode });
      
      // content scriptに通知
      try {
        await chrome.tabs.sendMessage(this.currentTab.id, {
          action: 'updateDetectionMode',
          mode: mode
        });
      } catch (error) {
        console.log('Could not notify content script, but setting saved');
      }
      
      await this.updateUI();
      this.showMessage('検出モードを設定しました', 'success');
      
    } catch (error) {
      console.error('Failed to set detection mode:', error);
      this.showMessage('検出モードの設定に失敗しました', 'error');
    }
  }

  async setDisplayMode(isSingle) {
    try {
      this.singlePageMode = isSingle;
      const key = `mangaViewerSinglePage_${this.hostname}`;
      await chrome.storage.sync.set({ [key]: isSingle.toString() });
      
      // content scriptに通知
      try {
        await chrome.tabs.sendMessage(this.currentTab.id, {
          action: 'updateDisplayMode',
          isSingle: isSingle
        });
      } catch (error) {
        console.log('Could not notify content script, but setting saved');
      }
      
      await this.updateUI();
      
      const statusText = isSingle ? '単ページ表示に設定しました' : '見開き表示に設定しました';
      this.showMessage(statusText, 'success');
      
    } catch (error) {
      console.error('Failed to set display mode:', error);
      this.showMessage('表示モードの設定に失敗しました', 'error');
    }
  }

  async showAllSettings() {
    try {
      const button = document.getElementById('showAllSettings');
      const display = document.getElementById('settingsDisplay');
      
      button.textContent = '読込中...';
      button.classList.add('loading');

      const siteSettings = await chrome.storage.sync.get();
      
      let settingsText = '=== 全設定一覧 ===\n\n';
      
      const domains = siteSettings.mangaViewerDomains || {};
      if (Object.keys(domains).length > 0) {
        settingsText += '【サイト別表示設定】\n';
        Object.entries(domains).forEach(([hostname, mode]) => {
          settingsText += `${hostname}: ${mode === 'show' ? '表示' : '非表示'}\n`;
        });
        settingsText += '\n';
      }

      const detectionModes = Object.keys(siteSettings).filter(key => key.startsWith('mangaDetectionMode_'));
      if (detectionModes.length > 0) {
        settingsText += '【検出モード設定】\n';
        detectionModes.forEach(key => {
          const hostname = key.replace('mangaDetectionMode_', '');
          settingsText += `${hostname}: ${siteSettings[key]}\n`;
        });
        settingsText += '\n';
      }

      const singlePageModes = Object.keys(siteSettings).filter(key => key.startsWith('mangaViewerSinglePage_'));
      if (singlePageModes.length > 0) {
        settingsText += '【表示モード設定】\n';
        singlePageModes.forEach(key => {
          const hostname = key.replace('mangaViewerSinglePage_', '');
          const mode = siteSettings[key] === 'true' ? '単ページ' : '見開き';
          settingsText += `${hostname}: ${mode}\n`;
        });
        settingsText += '\n';
      }

      settingsText += '【グローバル設定】\n';
      settingsText += `背景色: ${siteSettings.mangaViewerBg || '#333333'}\n`;
      if (siteSettings.mangaViewerNiconicoThreshold) {
        settingsText += `ニコニコ静画閾値: ${siteSettings.mangaViewerNiconicoThreshold}\n`;
      }

      if (settingsText === '=== 全設定一覧 ===\n\n【グローバル設定】\n背景色: #333333\n') {
        settingsText += '\n設定されたサイトはありません。';
      }

      display.textContent = settingsText;
      display.style.display = 'block';

      button.textContent = '全設定を表示';
      button.classList.remove('loading');

    } catch (error) {
      console.error('Failed to show all settings:', error);
      const display = document.getElementById('settingsDisplay');
      display.textContent = 'エラー: 設定の取得に失敗しました';
      display.style.display = 'block';
      
      const button = document.getElementById('showAllSettings');
      button.textContent = '全設定を表示';
      button.classList.remove('loading');
    }
  }

  async exportSettings() {
    try {
      const button = document.getElementById('exportSettings');
      button.textContent = '出力中...';
      button.classList.add('loading');

      const siteSettings = await chrome.storage.sync.get();
      
      const exportData = {
        exportDate: new Date().toISOString(),
        version: '3.4.0',
        settings: siteSettings
      };

      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      
      const link = document.createElement('a');
      link.href = url;
      link.download = `manga-viewer-settings-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      this.showMessage('設定をファイルに出力しました', 'success');

      button.textContent = '設定をエクスポート';
      button.classList.remove('loading');

    } catch (error) {
      console.error('Failed to export settings:', error);
      this.showMessage('設定の出力に失敗しました', 'error');
      
      const button = document.getElementById('exportSettings');
      button.textContent = '設定をエクスポート';
      button.classList.remove('loading');
    }
  }

  async resetSiteSettings() {
    try {
      const confirmed = confirm(
        `${this.hostname} の設定をリセットしますか?\n(現在のページもリロードされます)`
      );
      
      if (!confirmed) return;
      
      delete this.siteSettings[this.hostname];
      await chrome.storage.sync.set({ mangaViewerDomains: this.siteSettings });
      
      const detectionKey = `mangaDetectionMode_${this.hostname}`;
      await chrome.storage.sync.remove(detectionKey);
      
      const singlePageKey = `mangaViewerSinglePage_${this.hostname}`;
      await chrome.storage.sync.remove(singlePageKey);
      
      await chrome.tabs.reload(this.currentTab.id);
      
      this.showMessage(`${this.hostname} の設定をリセットしました`, 'success');
      
      setTimeout(async () => {
        await this.loadSettings();
        await this.updateUI();
      }, 1000);
      
    } catch (error) {
      console.error('Failed to reset site settings:', error);
      this.showMessage('設定のリセットに失敗しました', 'error');
    }
  }

  showMessage(text, type = 'info') {
    console.log(`${type}: ${text}`);
    
    const button = document.querySelector('.btn:focus') || document.querySelector('.btn');
    if (button) {
      const originalText = button.textContent;
      button.textContent = text;
      setTimeout(() => {
        button.textContent = originalText;
      }, 2000);
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new PopupManager();
});