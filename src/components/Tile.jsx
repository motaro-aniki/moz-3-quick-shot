import React, { useState, useEffect, useCallback } from 'react';
import { useT } from '../i18n';

const { ipcRenderer } = window.require('electron');

function formatTime(ts) {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function Tile({ shot, onLock, onDelete, onPreview, onAI }) {
    const { t } = useT();
    const [thumb, setThumb] = useState(null);
    const [imgSize, setImgSize] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        ipcRenderer.invoke('get-thumbnail', shot.id).then(result => {
            if (!cancelled && result) {
                setThumb(`data:image/png;base64,${result.b64}`);
                setImgSize({ w: result.w, h: result.h });
            }
            setLoading(false);
        });
        return () => { cancelled = true; };
    }, [shot.id]);

    const handleDelete = useCallback((e) => {
        e.stopPropagation();
        window.isConfirmingAction = true;
        if (window.confirm(t('confirmDelete'))) onDelete();
        setTimeout(() => { window.isConfirmingAction = false; }, 300);
    }, [onDelete, t]);

    const handleLock = useCallback((e) => {
        e.stopPropagation();
        onLock();
    }, [onLock]);

    const handleAI = useCallback((e) => {
        e.stopPropagation();
        onAI();
    }, [onAI]);

    const handleDragStart = useCallback((e) => {
        e.preventDefault();
        ipcRenderer.send('set-is-dragging', true);
        ipcRenderer.send('start-drag', shot.id);
        setTimeout(() => ipcRenderer.send('set-is-dragging', false), 2000);
    }, [shot.id]);

    return (
        <div
            className={`qs-tile ${shot.locked ? 'locked' : ''}`}
            data-shot-id={shot.id}
            draggable={true}
            onDragStart={handleDragStart}
            onDoubleClick={onPreview}
        >
            {loading ? (
                <div className="qs-tile-loading">⌛</div>
            ) : thumb ? (
                <img
                    src={thumb}
                    alt={formatTime(shot.timestamp)}
                    draggable={false}
                    style={{ pointerEvents: 'none', userSelect: 'none' }}
                />
            ) : (
                <div className="qs-tile-loading">❌</div>
            )}

            <div className="qs-tile-overlay" />

            <button
                className={`qs-tile-lock ${shot.locked ? 'locked' : ''}`}
                onMouseDown={e => e.stopPropagation()}
                onClick={handleLock}
                title={shot.locked ? t('unkeptTitle') : t('keepTitle')}
            >📌</button>

            {!shot.locked && (
                <button
                    className="qs-tile-delete"
                    onMouseDown={e => e.stopPropagation()}
                    onClick={handleDelete}
                    title={t('deleteTitle')}
                >✕</button>
            )}

            <button
                className="qs-tile-ai"
                onMouseDown={e => e.stopPropagation()}
                onClick={handleAI}
                title={t('aiTitle')}
            ><img src="./logo/Quick_Shot.png" alt="QS" style={{ width: 16, height: 16, borderRadius: '50%', objectFit: 'cover', display: 'block' }} /></button>

            <div className="qs-tile-time">{formatTime(shot.timestamp)}</div>

            {imgSize && (
                <div style={{
                    position: 'absolute', bottom: 4, left: 4,
                    background: 'rgba(0,0,0,0.55)', borderRadius: 3,
                    padding: '1px 5px', fontSize: 9,
                    color: '#cccccc', pointerEvents: 'none',
                    lineHeight: 1.6,
                }}>
                    {imgSize.w}×{imgSize.h}
                </div>
            )}
        </div>
    );
}
