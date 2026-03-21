import React, { useState, useEffect, useRef } from 'react';
import { useT } from '../i18n';

const ipcRenderer = window.require('electron').ipcRenderer;

export default function MenuApp() {
    const { t } = useT();
    const [expanded, setExpanded] = useState(false);
    const [count, setCount] = useState(0);
    const [isCustomFolder, setIsCustomFolder] = useState(false);
    const [isDragging, setIsDragging] = useState(false);
    const isDraggingRef = useRef(false);

    useEffect(() => {
        ipcRenderer.invoke('get-screenshot-count').then(n => setCount(n));
        ipcRenderer.invoke('get-is-custom-folder').then(v => setIsCustomFolder(v));
        ipcRenderer.on('update-count', (_, n) => setCount(n));
        ipcRenderer.on('update-is-custom-folder', (_, v) => setIsCustomFolder(v));

        const onSetExpanded = (_, val) => {
            if (!isDraggingRef.current) {
                setExpanded(val);
                if (val) {
                    ipcRenderer.send('hide-workspace');
                }
            }
        };
        ipcRenderer.on('set-expanded', onSetExpanded);

        return () => {
            ipcRenderer.removeListener('set-expanded', onSetExpanded);
        };
    }, []);

    const handleCapture = () => ipcRenderer.send('start-capture');
    const handleFolder = () => ipcRenderer.send('open-screenshots-folder');
    const handleWorkspace = () => ipcRenderer.send('show-workspace', true);

    const BG = 'rgba(6, 6, 16, 0.94)';
    const CYAN = '#00ffff';
    const BORDER = 'rgba(0,255,255,0.5)';

    return (
        <div style={{ width: 256, height: 46, position: 'relative', fontFamily: 'Inter, system-ui, sans-serif', userSelect: 'none' }}>
            {/* ── Collapsed: ultra-thin arc tab flush with screen top ── */}
            <div style={{
                position: 'absolute', top: 0, left: '50%',
                transform: 'translateX(-50%)',
                width: 45, height: 5,
                background: BG,
                borderBottom: `1.5px solid ${BORDER}`,
                borderLeft: `1px solid rgba(0,255,255,0.35)`,
                borderRight: `1px solid rgba(0,255,255,0.35)`,
                borderTop: 'none',
                borderRadius: '0 0 12px 12px',
                boxShadow: `0 2px 10px rgba(0,255,255,0.25)`,
                opacity: expanded ? 0 : 1,
                transition: 'opacity 0.1s ease',
                pointerEvents: 'none',
            }} />

            {/* ── Expanded full menu ── */}
            <div style={{
                position: 'absolute', inset: 0,
                background: BG,
                border: `1px solid ${BORDER}`,
                borderTop: 'none',
                borderRadius: '0 0 14px 14px',
                boxShadow: `0 4px 20px rgba(0,255,255,0.18)`,
                display: 'flex', alignItems: 'center',
                padding: '0 6px 0 0', gap: 6,
                opacity: expanded ? 1 : 0,
                transition: 'opacity 0.12s ease',
                pointerEvents: expanded ? 'all' : 'none',
            }}>
                {/* ── Drag Handle ── */}
                <div
                    onPointerDown={(e) => {
                        e.target.setPointerCapture(e.pointerId);
                        isDraggingRef.current = true;
                        setIsDragging(true);
                        ipcRenderer.send('menu-drag-start');
                    }}
                    onPointerUp={(e) => {
                        e.target.releasePointerCapture(e.pointerId);
                        isDraggingRef.current = false;
                        setIsDragging(false);
                        ipcRenderer.send('menu-drag-stop');
                    }}
                    style={{
                        width: 34, height: '100%',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                        cursor: isDragging ? 'grabbing' : 'grab',
                        background: 'linear-gradient(90deg, rgba(0,255,255,0.08) 0%, rgba(0,255,255,0) 100%)',
                        borderRight: `1px solid rgba(0, 255, 255, 0.2)`,
                        borderBottomLeftRadius: 14,
                        flexShrink: 0
                    }}
                >
                    <div style={{ width: 2, height: 26, background: CYAN, borderRadius: 1.5, opacity: 0.8 }} />
                    <div style={{ width: 2, height: 26, background: CYAN, borderRadius: 1.5, opacity: 0.8 }} />
                    <div style={{ width: 2, height: 26, background: CYAN, borderRadius: 1.5, opacity: 0.8 }} />
                </div>

                {/* Camera button */}
                <button onClick={handleCapture} style={{
                    width: 44, height: 34, flexShrink: 0,
                    borderRadius: 8, border: `1.5px solid ${BORDER}`,
                    background: `linear-gradient(135deg, rgba(0,255,255,0.2), rgba(0,255,255,0.06))`,
                    color: CYAN, fontSize: 20, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    marginLeft: 2
                }}><img src="./picture/mobacamera.png" alt="capture" style={{ height: 28, width: 'auto', objectFit: 'contain', display: 'block', pointerEvents: 'none' }} /></button>

                <div style={{ width: 1, height: 24, background: BORDER, flexShrink: 0 }} />

                <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: 1 }}>
                    <button onClick={handleFolder} style={{
                        width: '100%', height: 15,
                        borderRadius: 4, border: `1px solid rgba(0,255,255,0.25)`,
                        background: 'rgba(0,255,255,0.06)', color: CYAN,
                        fontSize: 9, cursor: 'pointer', fontFamily: 'Inter, system-ui',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3,
                    }}>
                        📁 {!isCustomFolder && <span style={{ color: count >= 99 ? '#ff4466' : CYAN, fontWeight: 700 }}>{count}/99</span>}
                    </button>
                    <button onClick={handleWorkspace} style={{
                        width: '100%', height: 15,
                        borderRadius: 4, border: `1px solid rgba(0,255,255,0.25)`,
                        background: 'rgba(0,255,255,0.06)', color: CYAN,
                        fontSize: 9, cursor: 'pointer', fontFamily: 'Inter, system-ui',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3,
                    }}>
                        🗂 {t('menuWorkspace')}
                    </button>
                </div>
            </div>
        </div>
    );
}
