import React, { useState, useEffect, useRef } from 'react';

const { ipcRenderer } = window.require('electron');

const COLORS = ['#00ffff', '#ff3366', '#ffd040', '#00ff9f', '#ffffff', '#ff6600'];
// ↖（select）は削除。→（arrow）は復活。
const TOOLS = [
    { id: 'arrow', icon: '→', label: '矢印' },
    { id: 'rect', icon: '□', label: '四角' },
    { id: 'circle', icon: '○', label: '丸' },
    { id: 'text', icon: 'T', label: 'テキスト' },
];

export default function Editor({ shot, onSave, onClose }) {
    const canvasRef = useRef(null);
    const [fullImg, setFullImg] = useState(null);
    const [tool, setTool] = useState('rect');
    const [color, setColor] = useState('#00ffff');
    const [lineWidth, setLineWidth] = useState(3);
    const [drawing, setDrawing] = useState(false);
    const [startPos, setStartPos] = useState(null);
    const [history, setHistory] = useState([]);
    const imgRef = useRef(null);

    useEffect(() => {
        ipcRenderer.invoke('get-full-image', shot.id).then(b64 => {
            if (!b64) return;
            const img = new Image();
            img.onload = () => {
                imgRef.current = img;
                setFullImg(`data:image/png;base64,${b64}`);
                const cvs = canvasRef.current;
                if (!cvs) return;
                const maxW = window.innerWidth * 0.75;
                const maxH = window.innerHeight * 0.7;
                const scale = Math.min(maxW / img.width, maxH / img.height, 1);
                cvs.width = Math.round(img.width * scale);
                cvs.height = Math.round(img.height * scale);
                const ctx = cvs.getContext('2d');
                ctx.drawImage(img, 0, 0, cvs.width, cvs.height);
                saveHistory(ctx);
            };
            img.src = `data:image/png;base64,${b64}`;
        });
    }, [shot.id]);

    const saveHistory = (ctx) => {
        const cvs = canvasRef.current;
        setHistory(h => [...h, ctx.getImageData(0, 0, cvs.width, cvs.height)]);
    };

    const getCanvasPos = (e) => {
        const rect = canvasRef.current.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    const getCtx = () => canvasRef.current?.getContext('2d');

    const onMouseDown = (e) => {
        setDrawing(true);
        const pos = getCanvasPos(e);
        setStartPos(pos);
        if (tool === 'text') {
            const text = prompt('テキストを入力:');
            if (text) {
                const ctx = getCtx();
                ctx.font = `${lineWidth * 6}px Inter, sans-serif`;
                ctx.fillStyle = color;
                ctx.fillText(text, pos.x, pos.y);
                saveHistory(ctx);
            }
            setDrawing(false);
        }
    };

    const onMouseMove = (e) => {
        if (!drawing || !startPos || tool === 'text') return;
        const cvs = canvasRef.current;
        const ctx = getCtx();
        const pos = getCanvasPos(e);

        if (history.length > 0) ctx.putImageData(history[history.length - 1], 0, 0);

        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = lineWidth;
        ctx.lineCap = 'round';

        if (tool === 'rect') {
            ctx.strokeRect(startPos.x, startPos.y, pos.x - startPos.x, pos.y - startPos.y);
        } else if (tool === 'circle') {
            const rx = (pos.x - startPos.x) / 2;
            const ry = (pos.y - startPos.y) / 2;
            ctx.beginPath();
            ctx.ellipse(startPos.x + rx, startPos.y + ry, Math.abs(rx), Math.abs(ry), 0, 0, Math.PI * 2);
            ctx.stroke();
        } else if (tool === 'arrow') {
            // Line
            ctx.beginPath();
            ctx.moveTo(startPos.x, startPos.y);
            ctx.lineTo(pos.x, pos.y);
            ctx.stroke();
            // Arrowhead
            const angle = Math.atan2(pos.y - startPos.y, pos.x - startPos.x);
            const hs = 12 + lineWidth * 2;
            ctx.beginPath();
            ctx.moveTo(pos.x, pos.y);
            ctx.lineTo(pos.x - hs * Math.cos(angle - 0.4), pos.y - hs * Math.sin(angle - 0.4));
            ctx.lineTo(pos.x - hs * Math.cos(angle + 0.4), pos.y - hs * Math.sin(angle + 0.4));
            ctx.closePath();
            ctx.fill();
        }
    };

    const onMouseUp = () => {
        if (!drawing) return;
        setDrawing(false);
        saveHistory(getCtx());
    };

    const handleUndo = () => {
        if (history.length <= 1) return;
        const newHistory = history.slice(0, -1);
        setHistory(newHistory);
        getCtx().putImageData(newHistory[newHistory.length - 1], 0, 0);
    };

    const handleSave = () => {
        const cvs = canvasRef.current;
        const b64 = cvs.toDataURL('image/png').split(',')[1];
        onSave(b64);
    };

    return (
        <div className="editor-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
            <div className="editor-modal">
                <div className="editor-header">
                    <div className="editor-title">✏️ 記号・文字を追加</div>
                    <button className="btn" onClick={handleUndo} title="元に戻す">↩ Undo</button>
                    <button className="btn primary" onClick={handleSave}>💾 保存</button>
                    <button className="btn" onClick={onClose}>✕</button>
                </div>
                <div className="editor-body">
                    <div className="editor-toolbar">
                        {TOOLS.map(t => (
                            <button
                                key={t.id}
                                className={`editor-tool-btn ${tool === t.id ? 'active' : ''}`}
                                onClick={() => setTool(t.id)}
                                title={t.label}
                            >{t.icon}</button>
                        ))}
                    </div>
                    <div className="editor-canvas-area">
                        <canvas
                            ref={canvasRef}
                            onMouseDown={onMouseDown}
                            onMouseMove={onMouseMove}
                            onMouseUp={onMouseUp}
                            style={{ cursor: tool === 'text' ? 'text' : 'crosshair' }}
                        />
                    </div>
                </div>
                <div className="editor-footer">
                    <div className="editor-color">
                        <span style={{ fontSize: 11, color: 'var(--text-sub)', marginRight: 4 }}>色:</span>
                        {COLORS.map(c => (
                            <div
                                key={c}
                                className={`editor-color-swatch ${color === c ? 'active' : ''}`}
                                style={{ background: c }}
                                onClick={() => setColor(c)}
                            />
                        ))}
                    </div>
                    <div className="editor-size">
                        太さ:
                        <input type="range" min={1} max={10} value={lineWidth}
                            onChange={e => setLineWidth(Number(e.target.value))} />
                        <span>{lineWidth}px</span>
                    </div>
                </div>
            </div>
        </div>
    );
}
