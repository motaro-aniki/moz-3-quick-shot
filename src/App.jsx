import React, { useState, useEffect, useRef, useCallback } from 'react';
import './index.css';
import TitleBar from './components/TitleBar';
import Gallery from './components/Gallery';
import AIPanel from './components/AIPanel';
import SettingsModal from './components/SettingsModal';
import { useT } from './i18n';

const { ipcRenderer } = window.require('electron');

export default function App() {
  const { t } = useT();
  const [screenshots, setScreenshots] = useState([]);
  const [filter, setFilter] = useState('all');
  const [toast, setToast] = useState(null);

  // モーダル管理（Preview/Editorを廃止しAIパネルへ統合）
  const [aiShot, setAiShot] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [fading, setFading] = useState(false);
  const [isDefaultStorage, setIsDefaultStorage] = useState(true);
  const [showQuitConfirm, setShowQuitConfirm] = useState(false);
  const [scrollTrigger, setScrollTrigger] = useState(0);
  const [scrollSignal, setScrollSignal] = useState(null);
  const hideTimerRef = useRef(null);
  const fadeTimerRef = useRef(null);
  const captureTimeRef = useRef(0);
  const delayExpiryRef = useRef(0);
  const isHoveringRef = useRef(false);
  const justShownTimerRef = useRef(null); // スクショ直後のblur誤発火防止用
  const isDraggingWindowRef = useRef(false); // ウィンドウドラッグ中フラグ
  const aiShotOpenRef = useRef(false);    // AIパネル開いている間 true
  const keepAiOpenRef = useRef(true);     // 設定値キャッシュ（デフォルト true）

  useEffect(() => {
    ipcRenderer.invoke('get-screenshots').then(shots => {
      setScreenshots(shots.sort((a, b) => a.timestamp - b.timestamp));
    });

    const onAdded = (_, shots) => {
      setScreenshots(shots.sort((a, b) => a.timestamp - b.timestamp));
      setScrollTrigger(n => n + 1);
      setShowSettings(false); // 設定画面を閉じてギャラリーを表示
      setFading(false);
      showToast(t('toastScreenshotSaved'));
      captureTimeRef.current = Date.now();

      // スクショ直後に show() されると blur が即発火する電子の挙動を防ぐ
      // 600ms だけ blur を無視し、その後は普通に「外クリックで即閉じ」に戻す
      clearTimeout(justShownTimerRef.current);
      justShownTimerRef.current = setTimeout(() => {
        justShownTimerRef.current = null;
      }, 600);

      startHideTimerDelayed(); // 撮影後も3秒間は消さないようにする
    };
    ipcRenderer.on('screenshot-added', onAdded);
    const onStartTimer = (_, delay = false) => {
      if (delay) startHideTimerDelayed();
      else startHideTimer();
    };
    ipcRenderer.on('start-visibility-timer', onStartTimer);

    const onReload = () => {
      setScreenshots([]); // 旧データを即座にクリアして幽霊サムネイルを防ぐ
      ipcRenderer.invoke('get-screenshots').then(shots => {
        setScreenshots(shots.sort((a, b) => a.timestamp - b.timestamp));
      });
      ipcRenderer.invoke('get-config').then(cfg => {
        setIsDefaultStorage(!cfg.customSavePath);
      });
    };
    ipcRenderer.on('reload-workspace', onReload);

    // 初回マウント時にも Config 読み込み
    ipcRenderer.invoke('get-config').then(cfg => {
      setIsDefaultStorage(!cfg.customSavePath);
      keepAiOpenRef.current = cfg.keepAiOpen !== false; // デフォルト true
    });

    // ウィンドウドラッグ中はホバー扱いにしてフェードアウトを抑制
    const onDragging = (_, dragging) => {
      isDraggingWindowRef.current = dragging;
      if (dragging) {
        clearTimeout(hideTimerRef.current);
        clearTimeout(fadeTimerRef.current);
        setFading(false);
        isHoveringRef.current = true;
      }
    };
    ipcRenderer.on('workspace-dragging', onDragging);

    const onWorkspaceShown = () => setScrollTrigger(n => n + 1);
    ipcRenderer.on('workspace-shown', onWorkspaceShown);

    const onRequestQuitConfirm = () => {
      // blur による自動非表示を抑制しつつダイアログを表示
      window.isConfirmingAction = true;
      setShowQuitConfirm(true);
    };
    ipcRenderer.on('request-quit-confirm', onRequestQuitConfirm);

    return () => {
      ipcRenderer.removeListener('screenshot-added', onAdded);
      ipcRenderer.removeListener('start-visibility-timer', onStartTimer);
      ipcRenderer.removeListener('reload-workspace', onReload);
      ipcRenderer.removeListener('workspace-dragging', onDragging);
      ipcRenderer.removeListener('workspace-shown', onWorkspaceShown);
      ipcRenderer.removeListener('request-quit-confirm', onRequestQuitConfirm);
    };
  }, []);

  // Fade out rules:
  // 1. Mouse leaves workspace -> 5 seconds later auto-fadeout
  // 2. Click another app/browser -> auto-fadeout immediately
  const startHideTimer = useCallback(() => {
    if (isDraggingWindowRef.current) return; // ドラッグ中は消さない
    if (aiShotOpenRef.current && keepAiOpenRef.current) return; // AIパネル表示中は消さない
    isHoveringRef.current = false;
    if (Date.now() < delayExpiryRef.current) return; // 3秒以内は上書き禁止

    clearTimeout(hideTimerRef.current);
    clearTimeout(fadeTimerRef.current);
    setFading(false);
    hideTimerRef.current = setTimeout(() => {
      setFading(true);
      fadeTimerRef.current = setTimeout(() => {
        ipcRenderer.send('hide-workspace');
        setFading(false);
      }, 200); // 0.2s fade out animation
    }, 400); // 0.4 sec before starting fade
  }, []);

  const startHideTimerDelayed = useCallback(() => {
    clearTimeout(hideTimerRef.current);
    clearTimeout(fadeTimerRef.current);
    setFading(false);

    delayExpiryRef.current = Date.now() + 3000;

    hideTimerRef.current = setTimeout(() => {
      // 3秒経過後、もしマウスが乗っていなければ通常通り消す
      if (!isHoveringRef.current) {
        setFading(true);
        fadeTimerRef.current = setTimeout(() => {
          ipcRenderer.send('hide-workspace');
          setFading(false);
        }, 200);
      }
    }, 3000); // 3 sec guaranteed display
  }, []);

  const cancelHideTimer = useCallback(() => {
    isHoveringRef.current = true;
    if (Date.now() < delayExpiryRef.current) return; // 3秒タイマー中はキャンセルしない

    clearTimeout(hideTimerRef.current);
    clearTimeout(fadeTimerRef.current);
    setFading(false);
  }, []);

  useEffect(() => {
    const handleBlur = () => {
      if (window.isConfirmingAction) return;
      // スクショ直後の短時間(600ms)はblurを無視する (show()直後の誤発火防止)
      if (justShownTimerRef.current) return;
      // ウィンドウドラッグ中はblurを無視する
      if (isDraggingWindowRef.current) return;
      // AIパネル表示中（設定ON時）はblurを無視する
      if (aiShotOpenRef.current && keepAiOpenRef.current) return;

      // 別のアプリやブラウザをクリックすると自動フェードアウト (すぐ消す)
      clearTimeout(hideTimerRef.current);
      clearTimeout(fadeTimerRef.current);
      delayExpiryRef.current = 0; // すぐ消すので3秒保護も強制解除

      // 即座に消す
      setFading(true);
      fadeTimerRef.current = setTimeout(() => {
        ipcRenderer.send('hide-workspace');
        setFading(false);
      }, 150);
    };
    window.addEventListener('blur', handleBlur);
    return () => window.removeEventListener('blur', handleBlur);
  }, []);

  // AIパネルの開閉を ref に同期し、開いたらタイマーをキャンセル
  useEffect(() => {
    aiShotOpenRef.current = aiShot !== null;
    if (aiShot !== null && keepAiOpenRef.current) {
      clearTimeout(hideTimerRef.current);
      clearTimeout(fadeTimerRef.current);
      setFading(false);
    }
  }, [aiShot]);

  // 設定画面が閉じたら設定値を再読み込み＋スクリーンショット一覧を同期
  useEffect(() => {
    if (!showSettings) {
      ipcRenderer.invoke('get-config').then(cfg => {
        keepAiOpenRef.current = cfg.keepAiOpen !== false;
        setIsDefaultStorage(!cfg.customSavePath);
      });
      // フォルダ変更等で reload-workspace が届かなかった場合のフォールバック同期
      ipcRenderer.invoke('get-screenshots').then(shots => {
        setScreenshots(shots.sort((a, b) => a.timestamp - b.timestamp));
      });
    }
  }, [showSettings]);

  const showToast = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2000);
  }, []);

  const handleKeep = async (id) => {
    const res = await ipcRenderer.invoke('toggle-lock', id);
    if (!res.ok && res.reason === 'max9') { showToast(t('toastMaxKept')); return; }
    if (res.ok) {
      setScreenshots(prev => prev.map(s => s.id === id ? { ...s, locked: res.locked } : s));
      showToast(res.locked ? t('toastKept') : t('toastUnkept'));
    }
  };

  const handleDelete = async (id) => {
    try {
      await ipcRenderer.invoke('delete-screenshot', id);
    } catch (e) {
      console.warn('[delete-screenshot] IPC error (treating as success):', e.message);
    }
    // IPC の成否に関わらず UI から確実に除外する
    setScreenshots(prev => prev.filter(s => s.id !== id));
    if (aiShot?.id === id) setAiShot(null);
    showToast(t('toastDeleted'));
  };

  // AI統合のアシストパネルでの保存時に使用（保存後はパネルを閉じ保存した画像へスクロール）
  const handleSaveAIShot = async (base64Data) => {
    const newId = await ipcRenderer.invoke('save-ai-shot', { base64Data, originalId: aiShot?.id });
    const shots = await ipcRenderer.invoke('get-screenshots');
    setScreenshots(shots.sort((a, b) => a.timestamp - b.timestamp));
    showToast(t('toastProcessDone'));
    setScrollSignal({ id: newId, seq: Date.now() });
    setAiShot(null);
  };

  const handleOpenFolder = () => ipcRenderer.send('open-screenshots-folder');

  const keptCount = screenshots.filter(s => s.locked).length;

  const displayed = filter === 'kept-sort'
    ? [
      ...screenshots.filter(s => !s.locked),
      ...screenshots.filter(s => s.locked),
    ]
    : screenshots;

  return (
    <div
      className="qs-app"
      style={{ opacity: fading ? 0 : 1, transition: fading ? 'opacity 1s ease' : 'opacity 0.2s ease' }}
      onMouseEnter={cancelHideTimer}
      onMouseLeave={startHideTimer}
    >
      <TitleBar />

      {/* ── HEADER LAYOUT ── */}
      <div className="qs-header-layout" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>

        {/* Left ── BIG CAMERA BUTTON */}
        <button
          onClick={() => ipcRenderer.send('start-capture')}
          style={{
            width: 140, height: 50,
            borderRadius: 12, border: '2px solid rgba(0,255,255,0.4)',
            background: 'linear-gradient(135deg, rgba(0,255,255,0.15), rgba(0,255,255,0.03))',
            color: '#00ffff', fontSize: 24, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 4px 16px rgba(0,255,255,0.1)',
            userSelect: 'none', transition: 'all 0.2s ease', flexShrink: 0
          }}
          title={t('titleCapture')}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'linear-gradient(135deg, rgba(0,255,255,0.25), rgba(0,255,255,0.08))'; e.currentTarget.style.boxShadow = '0 4px 20px rgba(0,255,255,0.2)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'linear-gradient(135deg, rgba(0,255,255,0.15), rgba(0,255,255,0.03))'; e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,255,255,0.1)'; }}
        >
          <img src="./picture/mobacamera.png" alt="capture" style={{ height: 40, width: 'auto', objectFit: 'contain', display: 'block', pointerEvents: 'none' }} />
        </button>

        {/* Right ── STATS & FILTERS */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end', userSelect: 'none' }}>

          {/* Top Row: Stats */}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button
              onClick={handleOpenFolder}
              style={{
                background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                color: 'var(--text-main)', fontSize: 11, padding: '0 10px', height: 22, cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 4, fontFamily: 'Inter, system-ui'
              }}
              title={t('titleFolder')}
            >
              <span style={{ color: '#ffd166', fontSize: 12 }}>📁</span> 
              {isDefaultStorage && (
                <>
                  <span style={{ fontWeight: 700 }}>{screenshots.length}</span>
                  <span style={{ color: 'var(--text-sub)' }}>/99</span>
                </>
              )}
            </button>
            <button
              onClick={() => setShowSettings(true)}
              style={{
                background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                color: 'var(--text-main)', fontSize: 13, padding: '0 8px', height: 22, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.2s',
              }}
              title={t('titleSettings')}
              onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.1)'}
              onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
            >
              ⚙
            </button>
          </div>

          {/* Bottom Row: Filters */}
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              style={{
                background: filter === 'all' ? 'rgba(0, 255, 255, 0.15)' : 'rgba(255,255,255,0.03)',
                border: filter === 'all' ? '1px solid rgba(0, 255, 255, 0.5)' : '1px solid var(--border)',
                color: filter === 'all' ? '#00ffff' : 'var(--text-sub)',
                borderRadius: 'var(--radius-sm)', fontSize: 11, padding: '0 14px', height: 22, cursor: 'pointer',
                fontFamily: 'Inter, system-ui', fontWeight: filter === 'all' ? 700 : 400
              }}
              onClick={() => setFilter('all')}
            >
              {t('filterAll')} ({screenshots.length})
            </button>
            <button
              style={{
                background: filter === 'kept-sort' ? 'rgba(255, 68, 102, 0.15)' : 'rgba(255,255,255,0.03)',
                border: filter === 'kept-sort' ? '1px solid rgba(255, 68, 102, 0.5)' : '1px solid var(--border)',
                color: filter === 'kept-sort' ? '#ff4466' : 'var(--text-sub)',
                borderRadius: 'var(--radius-sm)', fontSize: 11, padding: '0 10px', height: 22, cursor: 'pointer',
                fontFamily: 'Inter, system-ui', display: 'flex', alignItems: 'center', gap: 4,
                fontWeight: filter === 'kept-sort' ? 700 : 400
              }}
              onClick={() => setFilter(f => f === 'kept-sort' ? 'all' : 'kept-sort')}
              title={t('filterKeptSort')}
            >
              <span style={{ color: filter === 'kept-sort' ? '#ff4466' : 'var(--text-sub)' }}>📌</span> <span style={{ fontWeight: 700 }}>{keptCount}</span> <span style={{ color: filter === 'kept-sort' ? 'rgba(255,68,102,0.7)' : 'var(--text-sub)' }}>/9</span>
            </button>
          </div>

        </div>
      </div>

      {/* ギャラリー + 設定パネルの重ね合わせコンテナ */}
      <div style={{ position: 'relative', flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <Gallery
          screenshots={displayed}
          filter={filter}
          scrollTrigger={scrollTrigger}
          scrollSignal={scrollSignal}
          onLock={handleKeep}
          onDelete={handleDelete}
          onPreview={setAiShot}
          onAI={setAiShot}
        />
        {/* 設定パネル（ギャラリー上に重ねて表示） */}
        {showSettings && <SettingsModal onClose={() => setShowSettings(false)} keptCount={keptCount} />}
      </div>

      {toast && <div className="qs-toast" key={toast + Date.now()}>{toast}</div>}

      {/* 統合アシストパネル */}
      {aiShot && <AIPanel shot={aiShot} onClose={() => {
        setScrollSignal({ id: aiShot.id, seq: Date.now() });
        setAiShot(null);
      }} onSave={handleSaveAIShot} />}

      {/* ── 終了確認ダイアログ ── */}
      {showQuitConfirm && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)',
        }}>
          <div style={{
            background: 'var(--bg-panel, #1a1a2e)',
            border: '1px solid rgba(0,255,255,0.35)',
            borderRadius: 12,
            boxShadow: '0 8px 40px rgba(0,0,0,0.7), 0 0 0 1px rgba(0,255,255,0.1)',
            padding: '28px 32px 24px',
            maxWidth: 360, width: '90%',
            display: 'flex', flexDirection: 'column', gap: 20,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <img src="./logo/Quick_Shot.png" alt="logo" style={{ height: 24, width: 'auto', objectFit: 'contain', pointerEvents: 'none' }} />
              <span style={{ fontSize: 13, fontWeight: 700, color: '#00ffff', letterSpacing: 0.5 }}>
                MOZ-3 Quick Shot
              </span>
            </div>
            <p style={{
              margin: 0, fontSize: 13, lineHeight: 1.7,
              color: 'var(--text-main, #e0e0e0)',
              whiteSpace: 'pre-line',
            }}>
              {t('quitDialogMsg')}
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                onClick={() => {
                  window.isConfirmingAction = false;
                  setShowQuitConfirm(false);
                }}
                style={{
                  padding: '8px 20px', borderRadius: 7, fontSize: 12, fontWeight: 600,
                  border: '1px solid var(--border, rgba(255,255,255,0.15))',
                  background: 'transparent',
                  color: 'var(--text-sub, #aaa)', cursor: 'pointer',
                }}
              >
                {t('quitDialogCancel')}
              </button>
              <button
                onClick={() => ipcRenderer.send('confirm-quit')}
                style={{
                  padding: '8px 24px', borderRadius: 7, fontSize: 12, fontWeight: 700,
                  border: '1px solid rgba(0,255,255,0.5)',
                  background: 'linear-gradient(135deg, rgba(0,255,255,0.2), rgba(0,255,255,0.08))',
                  color: '#00ffff', cursor: 'pointer',
                  boxShadow: '0 0 12px rgba(0,255,255,0.15)',
                }}
              >
                {t('quitDialogOk')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
