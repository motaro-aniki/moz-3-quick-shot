import React, { useState, useEffect, useRef } from 'react';

const { ipcRenderer } = window.require('electron');

export default function CaptureApp() {
    const [bgImage, setBgImage] = useState(null);
    const [scaleFactor, setScaleFactor] = useState(1);
    const [selecting, setSelecting] = useState(false);
    const [start, setStart] = useState(null);
    const [current, setCurrent] = useState(null);
    const [hint, setHint] = useState(true);
    const overlayRef = useRef(null);

    useEffect(() => {
        ipcRenderer.on('capture-init-single', (_, data) => {
            setBgImage(data.imgDataUrl);
            setScaleFactor(data.scaleFactor);
        });

        ipcRenderer.on('capture-reset', () => {
            setBgImage(null);
            setSelecting(false);
            setStart(null);
            setCurrent(null);
            setHint(true);
        });

        const onKey = (e) => { if (e.key === 'Escape') ipcRenderer.send('cancel-capture'); };
        const onContextMenu = (e) => { e.preventDefault(); ipcRenderer.send('cancel-capture'); };
        window.addEventListener('keydown', onKey);
        window.addEventListener('contextmenu', onContextMenu);
        return () => {
            window.removeEventListener('keydown', onKey);
            window.removeEventListener('contextmenu', onContextMenu);
        };
    }, []);

    const onImageLoad = () => {
        ipcRenderer.send('capture-show');
    };

    const getPos = (e) => {
        const rect = overlayRef.current.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    const onMouseDown = (e) => {
        if (e.button !== 0) return;
        setHint(false);
        setSelecting(true);
        const pos = getPos(e);
        setStart(pos);
        setCurrent(pos);
    };

    const onMouseMove = (e) => {
        if (!selecting) return;
        setCurrent(getPos(e));
    };

    const onMouseUp = (e) => {
        if (!selecting) return;
        setSelecting(false);
        const end = getPos(e);

        // Coordinates are already relative to this specific monitor window
        const winX = Math.min(start.x, end.x);
        const winY = Math.min(start.y, end.y);
        const w = Math.abs(end.x - start.x);
        const h = Math.abs(end.y - start.y);

        if (w < 5 || h < 5) return;

        ipcRenderer.send('capture-area', {
            x: winX,
            y: winY,
            w,
            h,
            scaleFactor
        });
    };

    const selRect = start && current ? {
        x: Math.min(start.x, current.x),
        y: Math.min(start.y, current.y),
        w: Math.abs(current.x - start.x),
        h: Math.abs(current.y - start.y),
    } : null;

    return (
        <div
            ref={overlayRef}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            style={{
                width: '100vw', height: '100vh', position: 'fixed', top: 0, left: 0,
                cursor: 'crosshair', userSelect: 'none',
                backgroundColor: 'black', // L字配置などのディスプレイ外は黒で埋める
                overflow: 'hidden' // ensure no scrollbars
            }}
        >
            {/* Render monitor capture */}
            {bgImage && (
                <img
                    src={bgImage}
                    alt=""
                    onLoad={onImageLoad}
                    style={{
                        position: 'absolute', inset: 0,
                        width: '100%', height: '100%',
                        objectFit: 'fill', pointerEvents: 'none'
                    }}
                />
            )}

            {/* Dark overlay covering everything ONLY when not selecting */}
            {!selRect && (
                <div style={{
                    position: 'absolute', inset: 0,
                    background: 'rgba(0,0,0,0.45)',
                    pointerEvents: 'none',
                    zIndex: 10
                }} />
            )}

            {/* Hint */}
            {hint && (
                <div style={{
                    position: 'absolute', top: '50vh', left: '50vw', // center on the whole giant canvas
                    transform: 'translate(-50%, -50%)',
                    color: '#00ffff', fontFamily: 'Inter, system-ui, sans-serif',
                    textAlign: 'center', pointerEvents: 'none', zIndex: 20
                }}>
                    <div style={{ fontSize: 13, color: 'rgba(0,255,255,0.6)', marginTop: 8 }}>右クリックかEscでキャンセル</div>
                </div>
            )}

            {/* Selection rectangle */}
            {selRect && selRect.w > 0 && selRect.h > 0 && (
                <>
                    {/* Bright selection area (un-dim) */}
                    {/* We use a mask or box-shadow trick to un-dim the area */}
                    <div style={{
                        position: 'absolute',
                        left: selRect.x, top: selRect.y, width: selRect.w, height: selRect.h,
                        boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)',
                        border: '2px solid #00ffff',
                        pointerEvents: 'none',
                        zIndex: 30
                    }}>
                        {/* Size indicator */}
                        <div style={{
                            position: 'absolute', bottom: -28, left: '50%', transform: 'translateX(-50%)',
                            background: 'rgba(0,255,255,0.9)', color: '#000',
                            padding: '2px 10px', borderRadius: 4,
                            fontSize: 12, fontWeight: 700, fontFamily: 'Inter, monospace',
                            whiteSpace: 'nowrap',
                        }}>
                            {Math.round(selRect.w)} × {Math.round(selRect.h)} px
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}
