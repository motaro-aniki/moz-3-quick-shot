import React, { useState, useEffect } from 'react';

const { ipcRenderer } = window.require('electron');

export default function PreviewModal({ shot, onClose, onEdit, onAI }) {
    const [fullImg, setFullImg] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let isActive = true;
        ipcRenderer.invoke('get-full-image', shot.id).then(b64 => {
            if (!b64 || !isActive) return;
            const src = `data:image/png;base64,${b64}`;
            const img = new Image();
            img.onload = () => {
                if (!isActive) return;
                ipcRenderer.send('resize-workspace', { imgW: img.width, imgH: img.height });
                setFullImg(src);
                setLoading(false);
            };
            img.onerror = () => {
                if (!isActive) return;
                setLoading(false);
            };
            img.src = src;
        });

        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => {
            isActive = false;
            window.removeEventListener('keydown', onKey);
            ipcRenderer.send('restore-workspace');
        };
    }, [shot.id, onClose]);

    const d = new Date(shot.timestamp);
    const timeStr = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

    const CYAN = 'rgba(0,255,255,0.9)';
    const BG = 'rgba(6,6,18,0.97)';

    return (
        <div
            style={{
                position: 'fixed', inset: 0, zIndex: 2000,
                background: 'rgba(0,0,0,0.88)',
                backdropFilter: 'blur(8px)',
                display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center',
                userSelect: 'none',
            }}
            onClick={(e) => e.target === e.currentTarget && onClose()}
        >
            {/* Image container */}
            <div style={{
                position: 'relative',
                maxWidth: '85vw', maxHeight: '80vh',
                borderRadius: 12,
                border: '1px solid rgba(0,255,255,0.3)',
                overflow: 'hidden',
                boxShadow: '0 0 60px rgba(0,255,255,0.1)',
            }}>
                {loading ? (
                    <div style={{ width: 400, height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', color: CYAN, fontSize: 32 }}>⌛</div>
                ) : fullImg ? (
                    <img
                        src={fullImg}
                        alt={timeStr}
                        draggable={false}
                        style={{ display: 'block', maxWidth: '85vw', maxHeight: '80vh', objectFit: 'contain' }}
                    />
                ) : (
                    <div style={{ width: 400, height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ff4466', fontSize: 24 }}>読み込み失敗</div>
                )}
            </div>

            {/* Action menu bar */}
            <div style={{
                marginTop: 16,
                background: BG,
                border: '1px solid rgba(0,255,255,0.25)',
                borderRadius: 12,
                padding: '10px 16px',
                display: 'flex', alignItems: 'center', gap: 10,
                boxShadow: '0 4px 24px rgba(0,0,0,0.6)',
                fontFamily: 'Inter, system-ui, sans-serif',
                minWidth: 360,
            }}>
                {/* Timestamp */}
                <div style={{ fontSize: 11, color: 'rgba(0,255,255,0.5)', flex: 1 }}>{timeStr}</div>

                {/* Quick Edit */}
                <button
                    onClick={onEdit}
                    style={{
                        padding: '7px 14px', borderRadius: 8,
                        border: '1px solid rgba(0,255,255,0.35)',
                        background: 'rgba(0,255,255,0.1)', color: CYAN,
                        fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
                        display: 'flex', alignItems: 'center', gap: 6,
                        transition: 'all 0.15s',
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(0,255,255,0.2)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'rgba(0,255,255,0.1)'}
                >
                    ✏️ 記号・文字を追加
                </button>

                {/* AI / BG remove */}
                <button
                    onClick={onAI}
                    style={{
                        padding: '7px 14px', borderRadius: 8,
                        border: '1px solid rgba(255,150,0,0.4)',
                        background: 'rgba(255,150,0,0.08)', color: '#ffaa44',
                        fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
                        display: 'flex', alignItems: 'center', gap: 6,
                        transition: 'all 0.15s',
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,150,0,0.18)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'rgba(255,150,0,0.08)'}
                >
                    ✨ アシスト機能
                </button>

                {/* Close */}
                <button
                    onClick={onClose}
                    style={{
                        width: 30, height: 30, borderRadius: 8,
                        border: '1px solid rgba(255,255,255,0.1)',
                        background: 'rgba(255,255,255,0.05)', color: '#888',
                        fontSize: 14, cursor: 'pointer',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        transition: 'all 0.15s',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,51,102,0.2)'; e.currentTarget.style.color = '#ff3366'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = '#888'; }}
                >✕</button>
            </div>
        </div>
    );
}
