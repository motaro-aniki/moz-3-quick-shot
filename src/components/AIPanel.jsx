import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { useT } from '../i18n';

const { ipcRenderer } = window.require('electron');

const COLORS = ['#00ffff', '#ff3366', '#ffd040', '#00ff9f', '#ffffff', '#ff6600'];
const REFINE_HISTORY_MAX = 10;

// 安全に処理できる最大ピクセル数（16MP = 約4000×4000）
const MAX_PIXELS = 16_000_000;

/** base64 画像のピクセル数が上限を超えていたら Error を throw する */
const checkResolutionGuard = (base64Data) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
        const pixels = img.width * img.height;
        if (pixels > MAX_PIXELS) {
            reject(new Error(
                `画像サイズが大きすぎるため処理できません（${img.width}×${img.height} / ${(pixels / 1_000_000).toFixed(1)}MP）。\n縮小してからお試しください。`
            ));
        } else {
            resolve({ w: img.width, h: img.height });
        }
    };
    img.onerror = () => reject(new Error('画像の読み込みに失敗しました。'));
    img.src = `data:image/png;base64,${base64Data}`;
});


export default function AIPanel({ shot, onClose, onSave }) {
    const { t } = useT();
    const [tab, setTab] = useState('bg');
    const [processing, setProcessing] = useState(false);
    const [fullImg, setFullImg] = useState(null);
    const [imgSize, setImgSize] = useState({ w: 0, h: 0 });
    const imgRef = useRef(null);
    // SAM → プレクロップ用ドラッグボックス
    const [isDragging, setIsDragging]   = useState(false);
    const [dragBox,    setDragBox]      = useState(null);
    const [finalBox,   setFinalBox]     = useState(null);
    const [displaySrc, setDisplaySrc]   = useState(null);
    const [resultB64,  setResultB64]    = useState(null);
    // すべての編集が蓄積された最新の作業画像（null = 元画像を使用）
    const [currentWorkingImage, setCurrentWorkingImage] = useState(null);
    const [displaySize, setDisplaySize] = useState({ w: 0, h: 0 });
    const previewImgRef = useRef(null);
    const dragStartRef  = useRef(null);
    const canvasRef = useRef(null);
    const svgRef = useRef(null);
    const [tool, setTool] = useState('rect');
    const [color, setColor] = useState('#00ffff');
    const [lineWidth, setLineWidth] = useState(3);
    // オブジェクトベースのアノテーション管理
    const [annotations, setAnnotations] = useState([]);
    const [selectedId, setSelectedId] = useState(null);
    const [draftAnn, setDraftAnn] = useState(null);
    const dragRef = useRef(null);
    const canvasInitializedRef = useRef(false);
    const canvasBaseSrcRef = useRef(null);   // edit タブ再表示時のキャンバス復元用
    const canvasSizeRef = useRef({ w: 0, h: 0 }); // 再表示時の寸法復元用
    const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 });
    const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
    // テキスト入力
    const [textInput, setTextInput] = useState(null); // { canvasX, canvasY, value }
    const textInputRef = useRef(null);
    const textContentRef = useRef(''); // onBlur 時の e.currentTarget null 対策
    const textCommittingRef = useRef(false); // onBlur と Enter の二重コミット防止
    const isComposingRef = useRef(false); // IME変換中フラグ
    const [systemFonts, setSystemFonts] = useState([]);
    const [selectedFont, setSelectedFont] = useState('');

    // AI モデル状態（モデルはインストーラー同梱のため常に ready）
    const modelReady = true;

    // 対象モード: "simple"=基本モード（デフォルト）/ "complex"=特殊モード / "logo"=ロゴモード
    const [targetMode, setTargetMode] = useState('simple');

    // Refine モード（ブラシ描画）
    const [refineMode, setRefineMode] = useState(false);
    const [refineHistory, setRefineHistory] = useState([]); // [b64, ...]
    const refineOriginalPathRef  = useRef(null); // 後方互換用（未使用）
    const refineCurrentPathRef   = useRef(null); // 後方互換用（未使用）
    const refineProcessingRef    = useRef(false);
    const refineCleanupRef       = useRef([]);
    const [refineLoadingPos, setRefineLoadingPos] = useState(null);
    // 自動範囲透過 (BFS) モード
    const [autoRangeMode, setAutoRangeMode] = useState(true);
    const refineBFSOrigPathRef     = useRef(null);
    const refineBFSCurrentPathRef  = useRef(null);
    const refineBFSCleanupRef      = useRef([]);

    // ブラシ描画用
    const [brushSize, setBrushSize] = useState(30);
    const refineCanvasRef    = useRef(null); // 描画用キャンバス
    const refineOrigImgRef   = useRef(null); // セッション開始時の画像（復元用）
    const refinePrevPosRef   = useRef(null); // 前フレームのポインタ位置
    const refineIsDrawingRef = useRef(false);
    const refineButtonRef    = useRef(0);    // 0=左(消去) 2=右(復元)
    const [refineCursorPos, setRefineCursorPos] = useState(null); // コンテナ相対座標

    // 縁取りモード
    const [borderMode, setBorderMode]       = useState(false);
    const [borderHistory, setBorderHistory] = useState([]); // undo 用 b64 スナップショット列

    // モード開始時点の resultB64（コミットしていない変更の破棄に使用）
    // null = コミット済み or モード未開始
    const modeEntryB64Ref = useRef(null);

    // ズーム状態
    const [view, setView] = useState({ zoom: 1, panX: 0, panY: 0 });

    // プレビュー背景モード: 'checker' | 'white' | 'black'
    const [bgMode, setBgMode] = useState('checker');
    const BG_MODES = ['checker', 'white', 'black'];
    const BG_MODE_ICONS = { checker: '🏁', white: '⬜', black: '⬛' };
    const previewContainerRef = useRef(null);
    // ── ミドルクリックパン ──────────────────────────────────────────
    const imageWrapperRef = useRef(null);         // 単一 transform ターゲット
    const viewRef         = useRef({ zoom: 1, panX: 0, panY: 0 }); // DOM の source of truth
    const isPanningRef    = useRef(false);         // ドラッグ中フラグ
    const panStartRef     = useRef({ px: 0, py: 0, panX: 0, panY: 0 });

    const AI_TABS = [
        { id: 'bg', label: t('aiTabBg') },
        { id: 'upscale', label: t('aiTabUpscale') },
        { id: 'edit', label: t('aiTabEdit') },
    ];

    const TOOLS = [
        { id: 'arrow', icon: '→', label: t('toolArrow') },
        { id: 'rect', icon: '□', label: t('toolRect') },
        { id: 'circle', icon: '○', label: t('toolCircle') },
        { id: 'text', icon: 'T', label: t('toolText') },
    ];

    // refine temp ファイルを全削除するヘルパー
    const cleanupRefineFiles = (paths) => {
        if (!paths || paths.length === 0) return;
        ipcRenderer.invoke('ai-refine-cleanup', { paths });
    };

    // アンマウント時クリーンアップ（パネルを閉じた場合）
    useEffect(() => {
        return () => {
            if (refineCleanupRef.current.length > 0) {
                cleanupRefineFiles(refineCleanupRef.current);
                refineCleanupRef.current = [];
            }
        };
    }, []);

    // フル画像をロード
    useEffect(() => {
        let isActive = true;
        // 前のショットの refine ファイルをクリーンアップ
        if (refineCleanupRef.current.length > 0) {
            cleanupRefineFiles(refineCleanupRef.current);
            refineCleanupRef.current = [];
        }
        setFullImg(null);
        setDisplaySrc(null);
        setResultB64(null);
        setCurrentWorkingImage(null);
        setFinalBox(null);
        setDragBox(null);
        setIsDragging(false);
        setAnnotations([]);
        setSelectedId(null);
        setDraftAnn(null);
        dragRef.current = null;
        canvasInitializedRef.current = false;
        canvasBaseSrcRef.current = null;
        canvasSizeRef.current = { w: 0, h: 0 };
        setCanvasSize({ w: 0, h: 0 });
        setDisplaySize({ w: 0, h: 0 });
        setTextInput(null);
        setRefineMode(false);
        setRefineHistory([]);
        setBorderMode(false);
        setBorderHistory([]);
        modeEntryB64Ref.current       = null;
        refineOriginalPathRef.current = null;
        refineCurrentPathRef.current  = null;
        refineProcessingRef.current   = false;
        refineOrigImgRef.current      = null;
        refinePrevPosRef.current      = null;
        refineIsDrawingRef.current    = false;
        setRefineLoadingPos(null);
        setRefineCursorPos(null);
        setAutoRangeMode(true);
        refineBFSOrigPathRef.current    = null;
        refineBFSCurrentPathRef.current = null;
        if (refineBFSCleanupRef.current.length > 0) {
            cleanupRefineFiles(refineBFSCleanupRef.current);
            refineBFSCleanupRef.current = [];
        }
        setUpscaleResultB64(null);
        setUpscaleHistory([]);
        setBgMode('checker');
        setView({ zoom: 1, panX: 0, panY: 0 });
        viewRef.current   = { zoom: 1, panX: 0, panY: 0 };
        isPanningRef.current = false;
        ipcRenderer.invoke('get-full-image', shot.id).then(b64 => {
            if (!b64 || !isActive) return;
            const src = `data:image/png;base64,${b64}`;
            const img = new Image();
            img.onload = () => {
                if (!isActive) return;
                imgRef.current = img;
                setImgSize({ w: img.width, h: img.height });
                setFullImg(src);
                setDisplaySrc(src);
            };
            img.src = src;
        });
        return () => { isActive = false; };
    }, [shot.id]);


    // テキスト入力が表示されたら自動フォーカス + ショートカット無効化
    useEffect(() => {
        if (!textInput) return;
        requestAnimationFrame(() => {
            if (textInputRef.current) {
                textInputRef.current.focus();
                // カーソルを末尾に配置
                const range = document.createRange();
                const sel = window.getSelection();
                range.selectNodeContents(textInputRef.current);
                range.collapse(false);
                sel.removeAllRanges();
                sel.addRange(range);
            }
        });
    }, [textInput]);

    // edit タブ: システムフォント一覧を取得（初回のみ）
    useEffect(() => {
        if (tab !== 'edit' || systemFonts.length > 0) return;
        ipcRenderer.invoke('get-system-fonts').then(result => {
            const fonts = (result.ok && result.fonts.length > 0)
                ? result.fonts
                : ['Arial', 'Times New Roman', 'Courier New', 'Verdana', 'Georgia'];
            setSystemFonts(fonts);
            const saved = localStorage.getItem('qs-last-selected-font');
            setSelectedFont(saved && fonts.includes(saved) ? saved : fonts[0] || 'Arial');
        });
    }, [tab]);

    // edit タブ: キャンバス初期化 / 再表示時復元
    // requestAnimationFrame でキャンバスマウント後に確実に実行（並行レンダリング対策）
    // ベース画像が変わった場合（bg/upscale 処理後）は強制的に再初期化する
    useEffect(() => {
        if (tab !== 'edit') return;
        let raf;
        const run = () => {
            const cvs = canvasRef.current;
            if (!cvs) { raf = requestAnimationFrame(run); return; }

            const currentSrc = displaySrc || fullImg;
            // 未初期化 OR ベース画像が変わった場合（bg/upscale タブでの処理反映）
            const needsInit = !canvasInitializedRef.current ||
                              canvasBaseSrcRef.current !== currentSrc;

            if (needsInit) {
                const isFirstInit = !canvasInitializedRef.current; // 初回のみ true
                const prevW = canvasSizeRef.current.w;
                const prevH = canvasSizeRef.current.h;
                const src = currentSrc;
                if (!src) return;
                canvasInitializedRef.current = false; // ロード完了まで false に保持
                const img = new Image();
                img.onload = () => {
                    if (canvasRef.current !== cvs) return; // stale guard
                    const maxW = window.innerWidth * 0.8;
                    const maxH = window.innerHeight * 0.6;
                    const scale = Math.min(maxW / img.width, maxH / img.height, 1);
                    cvs.width  = Math.round(img.width  * scale);
                    cvs.height = Math.round(img.height * scale);
                    cvs.getContext('2d').drawImage(img, 0, 0, cvs.width, cvs.height);
                    const sz = { w: cvs.width, h: cvs.height };
                    setCanvasSize(sz);
                    canvasSizeRef.current    = sz;
                    canvasBaseSrcRef.current = src;
                    canvasInitializedRef.current = true;
                    setDisplaySize({ w: img.width, h: img.height });
                    if (isFirstInit) {
                        // 初回のみクリア（shot 変更時）
                        setAnnotations([]);
                        setSelectedId(null);
                    }
                    // 再初期化時（アップスケール等）はアノテーションをそのまま保持
                    // 座標系がコンテナCSS座標に統一されているためリスケール不要
                };
                img.src = src;
            } else if (canvasBaseSrcRef.current) {
                // 同じベース画像で edit タブに戻った場合:
                // display:none でキャンバス内容（描画済みアノテーション）は生きている
                // React state (canvasSize) だけ同期してSVGオーバーレイを復元
                const { w, h } = canvasSizeRef.current;
                setCanvasSize({ w, h });
            }
        };
        raf = requestAnimationFrame(run);
        return () => cancelAnimationFrame(raf);
    }, [tab, displaySrc, fullImg]); // eslint-disable-line react-hooks/exhaustive-deps

    // edit タブ時: コンテナサイズを計測し SVG ビューボックスに使用
    useEffect(() => {
        if (tab !== 'edit') return;
        const el = previewContainerRef.current;
        if (!el) return;
        const update = () => {
            const rect = el.getBoundingClientRect();
            setContainerSize({ w: rect.width, h: rect.height });
        };
        update();
        const ro = new ResizeObserver(update);
        ro.observe(el);
        return () => ro.disconnect();
    }, [tab]);

    // Delete/Backspace キーで選択中アノテーションを削除
    useEffect(() => {
        if (tab !== 'edit') return;
        const handler = (e) => {
            if (!selectedId) return;
            const tag = e.target.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.contentEditable === 'true') return;
            if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                setAnnotations(prev => prev.filter(a => a.id !== selectedId));
                setSelectedId(null);
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [tab, selectedId]);

    // Refine キャンバス: ブラシモード開始・BFS→ブラシ切り替え時に最新状態で再描画
    useEffect(() => {
        if (!refineMode || autoRangeMode) return; // BFS モード時はキャンバス不要
        let raf;
        const init = () => {
            const cvs = refineCanvasRef.current;
            if (!cvs) { raf = requestAnimationFrame(init); return; }
            const src = displaySrc || fullImg;
            if (!src) return;
            const img = new Image();
            img.onload = () => {
                cvs.width  = img.naturalWidth;
                cvs.height = img.naturalHeight;
                const ctx = cvs.getContext('2d');
                ctx.clearRect(0, 0, cvs.width, cvs.height);
                ctx.drawImage(img, 0, 0);
            };
            img.src = src;
        };
        raf = requestAnimationFrame(init);
        return () => cancelAnimationFrame(raf);
    }, [refineMode, autoRangeMode]); // eslint-disable-line react-hooks/exhaustive-deps

    // コンテナ要素の左上を原点とするCSS座標を返す
    // 座標系をコンテナ基準に統一することでletterbox計算の基準点とアノテーション座標を一致させる
    const getSVGPos = (e) => {
        const container = previewContainerRef.current;
        if (!container) return { x: 0, y: 0 };
        const rect = container.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    // アノテーション座標をスケーリング（キャンバスリサイズ時に比率を維持）
    const scaleAnnotation = (ann, sx, sy) => {
        const s = (sx + sy) / 2; // 等方スケール（線幅・フォントサイズ用）
        if (ann.type === 'arrow')  return { ...ann, startX: ann.startX * sx, startY: ann.startY * sy, endX: ann.endX * sx, endY: ann.endY * sy, lineWidth: ann.lineWidth * s };
        if (ann.type === 'rect')   return { ...ann, x: ann.x * sx, y: ann.y * sy, w: ann.w * sx, h: ann.h * sy, lineWidth: ann.lineWidth * s };
        if (ann.type === 'circle') return { ...ann, cx: ann.cx * sx, cy: ann.cy * sy, rx: ann.rx * sx, ry: ann.ry * sy, lineWidth: ann.lineWidth * s };
        if (ann.type === 'text')   return { ...ann, x: ann.x * sx, y: ann.y * sy, size: ann.size * s };
        return ann;
    };

    // アノテーションをキャンバスに描画（保存時）
    const ARROW_HEAD_ANGLE = Math.PI / 7;
    const drawAnnotationToCanvas = (ctx, ann) => {
        ctx.strokeStyle = ann.color;
        ctx.fillStyle = ann.color;
        if (ann.type === 'arrow') {
            const { startX: sx, startY: sy, endX: ex, endY: ey, lineWidth: lw } = ann;
            const angle = Math.atan2(ey - sy, ex - sx);
            const hl = 14 + lw * 2.5;
            ctx.lineWidth = lw; ctx.lineCap = 'butt'; ctx.lineJoin = 'miter'; ctx.miterLimit = 10;
            ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(ex - hl * Math.cos(angle - ARROW_HEAD_ANGLE), ey - hl * Math.sin(angle - ARROW_HEAD_ANGLE));
            ctx.lineTo(ex, ey);
            ctx.lineTo(ex - hl * Math.cos(angle + ARROW_HEAD_ANGLE), ey - hl * Math.sin(angle + ARROW_HEAD_ANGLE));
            ctx.stroke();
        } else if (ann.type === 'rect') {
            const { x, y, w, h, lineWidth: lw } = ann;
            ctx.lineWidth = lw; ctx.lineCap = 'butt';
            ctx.strokeRect(w < 0 ? x + w : x, h < 0 ? y + h : y, Math.abs(w), Math.abs(h));
        } else if (ann.type === 'circle') {
            const { cx, cy, rx, ry, lineWidth: lw } = ann;
            ctx.lineWidth = lw; ctx.lineCap = 'round';
            ctx.beginPath(); ctx.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, 0, Math.PI * 2); ctx.stroke();
        } else if (ann.type === 'text') {
            const { x, y, text: txt, font, size, color: col } = ann;
            ctx.font = `${size}px "${font}", sans-serif`;
            ctx.strokeStyle = '#000'; ctx.lineWidth = Math.max(1, size * 0.08); ctx.lineJoin = 'round';
            ctx.strokeText(txt, x, y);
            ctx.fillStyle = col; ctx.fillText(txt, x, y);
        }
    };

    // SVG アノテーション要素をレンダリング
    const renderAnnotationSVG = (ann, isSelected, isDraft = false) => {
        const opacity = isDraft ? 0.55 : 1;
        const dashArray = isDraft ? '6 3' : undefined;
        const selColor = 'rgba(0,255,255,0.75)';
        const PAD = 8;
        if (ann.type === 'arrow') {
            const { startX: sx, startY: sy, endX: ex, endY: ey, color: col, lineWidth: lw } = ann;
            const angle = Math.atan2(ey - sy, ex - sx);
            const hl = 14 + lw * 2.5;
            const hx1 = ex - hl * Math.cos(angle - ARROW_HEAD_ANGLE), hy1 = ey - hl * Math.sin(angle - ARROW_HEAD_ANGLE);
            const hx2 = ex - hl * Math.cos(angle + ARROW_HEAD_ANGLE), hy2 = ey - hl * Math.sin(angle + ARROW_HEAD_ANGLE);
            const bx = Math.min(sx, ex, hx1, hx2) - PAD, by = Math.min(sy, ey, hy1, hy2) - PAD;
            const bw = Math.max(sx, ex, hx1, hx2) - bx + PAD, bh = Math.max(sy, ey, hy1, hy2) - by + PAD;
            return (
                <g key={ann.id} data-ann-id={ann.id} style={{ cursor: isDraft ? 'crosshair' : 'move' }} opacity={opacity}>
                    {isSelected && <rect x={bx} y={by} width={bw} height={bh} fill="none" stroke={selColor} strokeWidth={1} strokeDasharray="4 2" pointerEvents="none" />}
                    <line x1={sx} y1={sy} x2={ex} y2={ey} stroke={col} strokeWidth={lw} strokeLinecap="butt" strokeDasharray={dashArray} />
                    <polyline points={`${hx1},${hy1} ${ex},${ey} ${hx2},${hy2}`} fill="none" stroke={col} strokeWidth={lw} strokeLinecap="butt" strokeLinejoin="miter" strokeMiterlimit={10} strokeDasharray={dashArray} />
                    <line x1={sx} y1={sy} x2={ex} y2={ey} stroke="transparent" strokeWidth={Math.max(lw + 12, 18)} pointerEvents="all" />
                </g>
            );
        }
        if (ann.type === 'rect') {
            const { x, y, w, h, color: col, lineWidth: lw } = ann;
            const rx2 = w < 0 ? x + w : x, ry2 = h < 0 ? y + h : y;
            const rw = Math.abs(w), rh = Math.abs(h);
            return (
                <g key={ann.id} data-ann-id={ann.id} style={{ cursor: isDraft ? 'crosshair' : 'move' }} opacity={opacity}>
                    {isSelected && <rect x={rx2 - PAD} y={ry2 - PAD} width={rw + PAD * 2} height={rh + PAD * 2} fill="none" stroke={selColor} strokeWidth={1} strokeDasharray="4 2" pointerEvents="none" />}
                    <rect x={rx2} y={ry2} width={rw} height={rh} fill="none" stroke={col} strokeWidth={lw} strokeDasharray={dashArray} />
                    <rect x={rx2 - PAD} y={ry2 - PAD} width={rw + PAD * 2} height={rh + PAD * 2} fill="transparent" pointerEvents="all" />
                </g>
            );
        }
        if (ann.type === 'circle') {
            const { cx, cy, rx, ry, color: col, lineWidth: lw } = ann;
            const arx = Math.abs(rx), ary = Math.abs(ry);
            return (
                <g key={ann.id} data-ann-id={ann.id} style={{ cursor: isDraft ? 'crosshair' : 'move' }} opacity={opacity}>
                    {isSelected && <rect x={cx - arx - PAD} y={cy - ary - PAD} width={(arx + PAD) * 2} height={(ary + PAD) * 2} fill="none" stroke={selColor} strokeWidth={1} strokeDasharray="4 2" pointerEvents="none" />}
                    <ellipse cx={cx} cy={cy} rx={arx} ry={ary} fill="none" stroke={col} strokeWidth={lw} strokeDasharray={dashArray} />
                    <ellipse cx={cx} cy={cy} rx={arx + PAD} ry={ary + PAD} fill="transparent" pointerEvents="all" />
                </g>
            );
        }
        if (ann.type === 'text') {
            const { x, y, text: txt, font, size, color: col } = ann;
            const estW = txt.length * size * 0.62 + PAD * 2;
            return (
                <g key={ann.id} data-ann-id={ann.id} style={{ cursor: isDraft ? 'crosshair' : 'move' }} opacity={opacity}>
                    {isSelected && <rect x={x - PAD} y={y - size - PAD} width={estW} height={size + PAD * 2} fill="none" stroke={selColor} strokeWidth={1} strokeDasharray="4 2" pointerEvents="none" />}
                    <rect x={x - PAD} y={y - size - PAD} width={estW} height={size + PAD * 2} fill="transparent" pointerEvents="all" />
                    <text x={x} y={y} fontFamily={`"${font}", sans-serif`} fontSize={size} fill={col}
                        stroke="#000" strokeWidth={Math.max(0.5, size * 0.05)} strokeLinejoin="round" paintOrder="stroke"
                    >{txt}</text>
                </g>
            );
        }
        return null;
    };

    // テキストレイヤーとしてコミット → annotations に追加
    const commitTextLayer = (sourceText) => {
        if (textCommittingRef.current) return;
        textCommittingRef.current = true;
        ipcRenderer.invoke('shortcut-unlock').catch(() => {});
        const text = (sourceText ?? '').trim();
        if (text) {
            const newAnn = {
                id: Date.now().toString(),
                type: 'text',
                x: textInput?.canvasX ?? 0,
                y: textInput?.canvasY ?? 0,
                text,
                font: selectedFont || 'sans-serif',
                size: lineWidth * 6,
                color,
            };
            setAnnotations(prev => [...prev, newAnn]);
            setSelectedId(newAnn.id);
        }
        setTextInput(null);
        requestAnimationFrame(() => { textCommittingRef.current = false; });
    };

    // ── SVG ポインターハンドラ ────────────────────────────────────
    const handleSvgPointerDown = (e) => {
        if (tab !== 'edit') return;
        e.preventDefault();
        // アノテーション上のクリックか判定
        const target = e.target.closest('[data-ann-id]');
        if (target) {
            const id = target.dataset.annId;
            const ann = annotations.find(a => a.id === id);
            if (!ann) return;
            setSelectedId(id);
            const pos = getSVGPos(e);
            if (ann.type === 'arrow') {
                dragRef.current = { id, type: 'arrow', mx: pos.x, my: pos.y, sx: ann.startX, sy: ann.startY, ex: ann.endX, ey: ann.endY };
            } else if (ann.type === 'rect') {
                dragRef.current = { id, type: 'rect', mx: pos.x, my: pos.y, ox: ann.x, oy: ann.y };
            } else if (ann.type === 'circle') {
                dragRef.current = { id, type: 'circle', mx: pos.x, my: pos.y, ocx: ann.cx, ocy: ann.cy };
            } else if (ann.type === 'text') {
                dragRef.current = { id, type: 'text', mx: pos.x, my: pos.y, ox: ann.x, oy: ann.y };
            }
            svgRef.current?.setPointerCapture(e.pointerId);
            return;
        }
        // 背景クリック: 選択解除
        setSelectedId(null);
        if (tool === 'text') {
            if (textInput) return;
            const pos = getSVGPos(e);
            // 座標系はコンテナCSS座標なのでスケール係数は不要
            textContentRef.current = '';
            setTextInput({ canvasX: pos.x, canvasY: pos.y, cssSx: 1, cssSy: 1, value: '' });
            return;
        }
        // 新規描画開始
        const pos = getSVGPos(e);
        const base = { color, lineWidth };
        if (tool === 'arrow') {
            setDraftAnn({ type: 'arrow', ...base, startX: pos.x, startY: pos.y, endX: pos.x, endY: pos.y });
        } else if (tool === 'rect') {
            setDraftAnn({ type: 'rect', ...base, x: pos.x, y: pos.y, w: 0, h: 0 });
        } else if (tool === 'circle') {
            setDraftAnn({ type: 'circle', ...base, cx: pos.x, cy: pos.y, rx: 0, ry: 0, _ox: pos.x, _oy: pos.y });
        }
        svgRef.current?.setPointerCapture(e.pointerId);
    };

    const handleSvgPointerMove = (e) => {
        if (tab !== 'edit') return;
        if (dragRef.current) {
            const pos = getSVGPos(e);
            const drag = dragRef.current;
            const dx = pos.x - drag.mx, dy = pos.y - drag.my;
            setAnnotations(prev => prev.map(ann => {
                if (ann.id !== drag.id) return ann;
                if (drag.type === 'arrow')  return { ...ann, startX: drag.sx + dx, startY: drag.sy + dy, endX: drag.ex + dx, endY: drag.ey + dy };
                if (drag.type === 'rect')   return { ...ann, x: drag.ox + dx, y: drag.oy + dy };
                if (drag.type === 'circle') return { ...ann, cx: drag.ocx + dx, cy: drag.ocy + dy };
                if (drag.type === 'text')   return { ...ann, x: drag.ox + dx, y: drag.oy + dy };
                return ann;
            }));
            return;
        }
        if (!draftAnn) return;
        const pos = getSVGPos(e);
        if (draftAnn.type === 'arrow') {
            setDraftAnn(prev => ({ ...prev, endX: pos.x, endY: pos.y }));
        } else if (draftAnn.type === 'rect') {
            setDraftAnn(prev => ({ ...prev, w: pos.x - prev.x, h: pos.y - prev.y }));
        } else if (draftAnn.type === 'circle') {
            const rx = (pos.x - draftAnn._ox) / 2, ry = (pos.y - draftAnn._oy) / 2;
            setDraftAnn(prev => ({ ...prev, cx: prev._ox + rx, cy: prev._oy + ry, rx, ry }));
        }
    };

    const handleSvgPointerUp = () => {
        if (tab !== 'edit') return;
        if (dragRef.current) { dragRef.current = null; return; }
        if (!draftAnn) return;
        const MIN = 4;
        let valid = false;
        if (draftAnn.type === 'arrow') { valid = Math.hypot(draftAnn.endX - draftAnn.startX, draftAnn.endY - draftAnn.startY) > MIN; }
        else if (draftAnn.type === 'rect') { valid = Math.abs(draftAnn.w) > MIN || Math.abs(draftAnn.h) > MIN; }
        else if (draftAnn.type === 'circle') { valid = Math.abs(draftAnn.rx) > MIN || Math.abs(draftAnn.ry) > MIN; }
        if (valid) {
            // eslint-disable-next-line no-unused-vars
            const { _ox, _oy, ...annData } = draftAnn;
            const newAnn = { ...annData, id: Date.now().toString() };
            setAnnotations(prev => [...prev, newAnn]);
            setSelectedId(newAnn.id);
        }
        setDraftAnn(null);
    };

    const handleDeleteSelected = () => {
        if (!selectedId) return;
        setAnnotations(prev => prev.filter(a => a.id !== selectedId));
        setSelectedId(null);
    };

    const handleUndo = () => {
        if (annotations.length === 0) return;
        const lastId = annotations[annotations.length - 1].id;
        setAnnotations(prev => prev.slice(0, -1));
        if (selectedId === lastId) setSelectedId(null);
    };


    // ── 座標系ユーティリティ ─────────────────────────────────────
    //
    // imageWrapper の LOCAL 座標系（transform 適用前）における
    // 画像コンテンツ領域のレイアウトを計算する。
    //
    // offsetWidth/offsetHeight は CSS transform の影響を受けないため、
    // パン・ズーム状態にかかわらず常に正確なレイアウト寸法を返す。
    const getImageLocalLayout = () => {
        const img     = previewImgRef.current;
        const wrapper = imageWrapperRef.current;
        if (!img || !wrapper || !img.naturalWidth) return null;
        // ラッパーの CSS レイアウト寸法（transform 非依存）
        const cW = wrapper.offsetWidth;
        const cH = wrapper.offsetHeight;
        if (!cW || !cH) return null;
        // objectFit: contain に相当するレターボックス補正
        const aspect = img.naturalWidth / img.naturalHeight;
        let imgLocalW, imgLocalH;
        if (cW / cH > aspect) {
            imgLocalH = cH; imgLocalW = cH * aspect;
        } else {
            imgLocalW = cW; imgLocalH = cW / aspect;
        }
        // 画像コンテンツ領域の LOCAL 原点（flex 中央寄せ）
        const imgLocalLeft = (cW - imgLocalW) / 2;
        const imgLocalTop  = (cH - imgLocalH) / 2;
        return { cW, cH, imgLocalW, imgLocalH, imgLocalLeft, imgLocalTop };
    };

    // スクリーン座標 → 画像上の正規化座標 (0–1) への逆変換。
    //
    // imageWrapper の transform は
    //   translate(panX, panY) scale(zoom)  transform-origin: center center
    // getBoundingClientRect() は変換後の矩形を返すため:
    //   screenX = wRect.left + lx * zoom  →  lx = (clientX - wRect.left) / zoom
    // panX / panY は消去されるため、viewRef から取得する必要はない。
    // また container の padding も自動的に吸収される。
    const screenToNorm = (clientX, clientY) => {
        const wrapper = imageWrapperRef.current;
        const layout  = getImageLocalLayout();
        if (!wrapper || !layout) return null;
        const { imgLocalW, imgLocalH, imgLocalLeft, imgLocalTop } = layout;
        const { zoom } = viewRef.current;
        // imageWrapper の transform は translate(panX, panY) scale(zoom)。
        // getBoundingClientRect() で変換後の矩形を取得し、逆変換を計算する。
        // screenX = wRect.left + lx * zoom  →  lx = (clientX - wRect.left) / zoom
        // この式で panX / panY は消去されるため不要。
        const wRect = wrapper.getBoundingClientRect();
        const lx = (clientX - wRect.left) / zoom;
        const ly = (clientY - wRect.top)  / zoom;
        return {
            normX: Math.max(0, Math.min(1, (lx - imgLocalLeft) / imgLocalW)),
            normY: Math.max(0, Math.min(1, (ly - imgLocalTop)  / imgLocalH)),
        };
    };

    // ── ドラッグ操作（プレクロップ範囲選択） ─────────────────────
    //
    // dragBox / finalBox は正規化座標 { x1, y1, x2, y2 } のみを保持する。
    // レイアウトのスナップショット（ox, oy, dw, dh, rect）は持たない。
    // 描画位置は render ごとに getImageLocalLayout() でオンザフライ計算し、
    // ボックスを imageWrapper 内に配置して transform を継承させることで
    // パン・ズーム後の座標ズレとジャンプを根本的に解消する。

    const handleDragStart = (e) => {
        if (tab !== 'bg' || processing || refineMode) return;
        e.preventDefault();
        const norm = screenToNorm(e.clientX, e.clientY);
        if (!norm) return;
        dragStartRef.current = norm;
        setIsDragging(true);
        setDragBox({ x1: norm.normX, y1: norm.normY, x2: norm.normX, y2: norm.normY });
    };

    // ドラッグ中は window にグローバルリスナーを張り、表示域外でも追従させる
    useEffect(() => {
        if (!isDragging) return;

        const onMove = (e) => {
            const s = dragStartRef.current;
            if (!s) return;
            const curr = screenToNorm(e.clientX, e.clientY);
            if (!curr) return;
            setDragBox({
                x1: Math.min(s.normX, curr.normX), y1: Math.min(s.normY, curr.normY),
                x2: Math.max(s.normX, curr.normX), y2: Math.max(s.normY, curr.normY),
            });
        };

        const onUp = (e) => {
            const s = dragStartRef.current;
            if (!s) return;
            setIsDragging(false);
            const curr = screenToNorm(e.clientX, e.clientY);
            const ex = curr?.normX ?? s.normX;
            const ey = curr?.normY ?? s.normY;
            const x1 = Math.min(s.normX, ex), y1 = Math.min(s.normY, ey);
            const x2 = Math.max(s.normX, ex), y2 = Math.max(s.normY, ey);
            // クリック（正規化座標で 1% 未満）は全体選択にリセット
            if ((x2 - x1) < 0.01 && (y2 - y1) < 0.01) {
                setFinalBox(null);
                setDragBox(null);
            } else {
                setFinalBox({ x1, y1, x2, y2 });
                setDragBox(null);
            }
            dragStartRef.current = null;
        };

        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup',   onUp);
        return () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup',   onUp);
        };
    }, [isDragging]);

    // view state → imageWrapper DOM transform の同期
    // （ズームリセット・タブ切替・プログラム的な setView 呼び出し時に使用）
    // パン中は isPanningRef で抑制し、DOM への直接書き込みを優先する
    useLayoutEffect(() => {
        viewRef.current = view;
        if (isPanningRef.current || !imageWrapperRef.current) return;
        imageWrapperRef.current.style.transform =
            `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`;
    }, [view]);

    // マウスホイールズーム（カーソル位置を中心に拡縮）
    // viewRef を直接読み書きして stale closure を回避しつつ毎フレームDOMを更新する
    useEffect(() => {
        const container = previewContainerRef.current;
        if (!container) return;
        const onWheel = (e) => {
            e.preventDefault();
            const rect    = container.getBoundingClientRect();
            const rx      = e.clientX - rect.left - rect.width  / 2;
            const ry      = e.clientY - rect.top  - rect.height / 2;
            const factor  = e.deltaY < 0 ? 1.15 : 1 / 1.15;
            const { zoom, panX, panY } = viewRef.current;
            const newZoom = Math.max(0.25, Math.min(8, zoom * factor));
            const ratio   = newZoom / zoom;
            const newPanX = rx - (rx - panX) * ratio;
            const newPanY = ry - (ry - panY) * ratio;
            viewRef.current = { zoom: newZoom, panX: newPanX, panY: newPanY };
            if (imageWrapperRef.current) {
                imageWrapperRef.current.style.transform =
                    `translate(${newPanX}px, ${newPanY}px) scale(${newZoom})`;
            }
            setView(viewRef.current); // ズーム％表示のみに使用
        };
        container.addEventListener('wheel', onWheel, { passive: false });
        return () => container.removeEventListener('wheel', onWheel);
    }, []);

    // ミドルクリックによる Windows オートスクロール防止（ネイティブリスナー必須）
    useEffect(() => {
        const container = previewContainerRef.current;
        if (!container) return;
        const preventAutoscroll = (e) => { if (e.button === 1) e.preventDefault(); };
        container.addEventListener('mousedown', preventAutoscroll);
        return () => container.removeEventListener('mousedown', preventAutoscroll);
    }, []);

    // ── ミドルクリックパン ─────────────────────────────────────────
    const handleContainerPointerDown = (e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        isPanningRef.current = true;
        panStartRef.current  = {
            px:   e.clientX,
            py:   e.clientY,
            panX: viewRef.current.panX,
            panY: viewRef.current.panY,
        };
        // Pointer Capture: 画面外でボタンを離しても pointerup を確実に受け取る
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.style.cursor = 'grabbing';
        // GPU レイヤーをパン中だけ昇格して VRAM を節約
        if (imageWrapperRef.current) imageWrapperRef.current.style.willChange = 'transform';
    };

    const handleContainerPointerMove = (e) => {
        if (!isPanningRef.current) return;
        const newPanX = panStartRef.current.panX + (e.clientX - panStartRef.current.px);
        const newPanY = panStartRef.current.panY + (e.clientY - panStartRef.current.py);
        viewRef.current = { ...viewRef.current, panX: newPanX, panY: newPanY };
        if (imageWrapperRef.current) {
            imageWrapperRef.current.style.transform =
                `translate(${newPanX}px, ${newPanY}px) scale(${viewRef.current.zoom})`;
        }
    };

    const stopPan = (e) => {
        if (!isPanningRef.current) return;
        isPanningRef.current = false;
        // Pointer Capture を明示解放（pointerup では自動解放されるが意図を明確にする）
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
        }
        e.currentTarget.style.cursor = '';
        // GPU レイヤーを解除（VRAM 節約）
        if (imageWrapperRef.current) imageWrapperRef.current.style.willChange = 'auto';
        // 最終座標を React State に commit — これがないと次の再レンダリングでスナップバックする
        setView({ ...viewRef.current });
    };

    const handleClear = () => {
        setFinalBox(null);
        setDragBox(null);
        const fallback = upscaleResultB64 || null;
        setCurrentWorkingImage(fallback);
        setDisplaySrc(fallback ? `data:image/png;base64,${fallback}` : fullImg);
        setResultB64(null);
    };

    const handleRevertBg = () => {
        if (refineCleanupRef.current.length > 0) {
            cleanupRefineFiles(refineCleanupRef.current);
            refineCleanupRef.current = [];
        }
        setFinalBox(null);
        setDragBox(null);
        const fallback = upscaleResultB64 || null;
        setCurrentWorkingImage(fallback);
        setDisplaySrc(fallback ? `data:image/png;base64,${fallback}` : fullImg);
        setResultB64(null);
        setRefineMode(false);
        setRefineHistory([]);
        setBorderMode(false);
        setBorderHistory([]);
        modeEntryB64Ref.current       = null;
        refineOriginalPathRef.current = null;
        refineCurrentPathRef.current  = null;
        refineProcessingRef.current   = false;
        setRefineLoadingPos(null);
    };

    const handleRevertUpscale = () => {
        setUpscaleResultB64(null);
        setUpscaleHistory([]);
        const fallback = resultB64 || null;
        setCurrentWorkingImage(fallback);
        setDisplaySrc(fallback ? `data:image/png;base64,${fallback}` : fullImg);
    };

    // ── U2-Net 背景透過（プレクロップ → ai-removebg） ───────────

    const runBgRemoval = async () => {
        setProcessing(true);
        try {
            // 最新の作業画像を入力とする（画質変更済み・前回透過済み等を引き継ぐ）
            let base64Data;
            if (currentWorkingImage) {
                base64Data = currentWorkingImage;
            } else {
                base64Data = await ipcRenderer.invoke('get-full-image', shot.id);
            }
            if (!base64Data) throw new Error(t('origLoadError'));

            // 解像度ガード: 処理前に画像サイズが上限を超えていないかチェック
            await checkResolutionGuard(base64Data);

            // ボックス選択がある場合は JS 側でプレクロップ
            let croppedB64 = base64Data;
            if (finalBox) {
                // 処理対象画像のサイズを基準にクロップ座標を算出する
                const srcImg = await new Promise((resolve, reject) => {
                    const img = new Image();
                    img.onload = () => resolve(img);
                    img.onerror = reject;
                    img.src = `data:image/png;base64,${base64Data}`;
                });
                const cx = Math.round(finalBox.x1 * srcImg.width);
                const cy = Math.round(finalBox.y1 * srcImg.height);
                const cw = Math.max(1, Math.round((finalBox.x2 - finalBox.x1) * srcImg.width));
                const ch = Math.max(1, Math.round((finalBox.y2 - finalBox.y1) * srcImg.height));
                const canvas = document.createElement('canvas');
                canvas.width = cw; canvas.height = ch;
                canvas.getContext('2d').drawImage(srcImg, cx, cy, cw, ch, 0, 0, cw, ch);
                croppedB64 = canvas.toDataURL('image/png').split(',')[1];
            }

            const result = await ipcRenderer.invoke('ai-removebg', { base64Data: croppedB64, target: targetMode });
            if (!result.ok) throw new Error(result.error);
            setDisplaySrc(`data:image/png;base64,${result.base64Data}`);
            setResultB64(result.base64Data);
            setCurrentWorkingImage(result.base64Data);
            setFinalBox(null);
            setDragBox(null);
            setRefineMode(false);
            setRefineHistory([]);
            setBorderMode(false);
            setBorderHistory([]);
            refineOriginalPathRef.current = null;
            refineCurrentPathRef.current  = null;
        } catch (err) {
            console.error('BG Removal Error:', err);
            alert(t('bgRemoveError') + err.message);
        } finally {
            setProcessing(false);
        }
    };

    // ── 縁取りモード ──────────────────────────────────────────────

    const handleToggleBorderMode = () => {
        if (!(resultB64 || currentWorkingImage)) return;

        // ① すでに縁取りモード → 変更を保持したまま終了
        if (borderMode) {
            setBorderMode(false);
            setBorderHistory([]);
            modeEntryB64Ref.current = null;
            return;
        }

        // ② リファインモードから切り替え（変更を保持したまま移行）
        let startB64 = currentWorkingImage || resultB64;
        if (refineMode) {
            exitRefineRaw();
        }

        // ③ 縁取りモード開始
        modeEntryB64Ref.current = startB64;
        setBorderMode(true);
        setBorderHistory([]);
    };

    // 縁取りを追加する（白・黒: 固定色 / 元絵: C# Parallel.For でエッジカラー自動サンプリング）
    const handleAddBorder = async (type) => {
        const imageB64 = currentWorkingImage || resultB64;
        if (!imageB64 || processing) return;
        setProcessing(true);
        const savedB64 = imageB64;
        try {
            let r = 255, g = 255, b = 255;
            let origBase64Data = null;
            if (type === 'black') {
                r = 0; g = 0; b = 0;
            } else if (type === 'original') {
                // JS 側でのピクセルループを廃止し、オリジナル画像を C# へ渡して
                // Parallel.For でエッジカラーをサンプリングさせる
                origBase64Data = await ipcRenderer.invoke('get-full-image', shot.id);
            }

            const result = await ipcRenderer.invoke('ai-white-border', {
                base64Data: imageB64, borderR: r, borderG: g, borderB: b, origBase64Data,
            });
            if (!result.ok) throw new Error(result.error);
            setBorderHistory(h => [...h, savedB64]);
            setDisplaySrc(`data:image/png;base64,${result.base64Data}`);
            setResultB64(result.base64Data);
            setCurrentWorkingImage(result.base64Data);
        } catch (err) {
            alert('Error: ' + err.message);
        } finally {
            setProcessing(false);
        }
    };

    const handleBorderUndo = () => {
        if (borderHistory.length === 0) return;
        const prev = borderHistory[borderHistory.length - 1];
        setBorderHistory(h => h.slice(0, -1));
        setDisplaySrc(`data:image/png;base64,${prev}`);
        setResultB64(prev);
        setCurrentWorkingImage(prev);
    };

    // ── Refine state をすべて破棄するヘルパー ──────────────────
    const exitRefineRaw = () => {
        if (refineCleanupRef.current.length > 0) {
            cleanupRefineFiles(refineCleanupRef.current);
            refineCleanupRef.current = [];
        }
        if (refineBFSCleanupRef.current.length > 0) {
            cleanupRefineFiles(refineBFSCleanupRef.current);
            refineBFSCleanupRef.current = [];
        }
        setRefineMode(false);
        setRefineHistory([]);
        setAutoRangeMode(true);
        refineOrigImgRef.current        = null;
        refinePrevPosRef.current        = null;
        refineIsDrawingRef.current      = false;
        refineOriginalPathRef.current   = null;
        refineCurrentPathRef.current    = null;
        refineBFSOrigPathRef.current    = null;
        refineBFSCurrentPathRef.current = null;
        refineProcessingRef.current     = false;
        setRefineLoadingPos(null);
        setRefineCursorPos(null);
    };


    // ── Refine モード（ブラシ描画）────────────────────────────────

    const handleToggleRefineMode = async () => {
        if (!resultB64) return;

        // ① すでにリファインモード → 変更を保持したまま終了
        if (refineMode) {
            exitRefineRaw();
            modeEntryB64Ref.current = null;
            return;
        }

        // ② 縁取りモードから切り替え（変更を保持したまま移行）
        const startB64 = resultB64;
        if (borderMode) {
            setBorderMode(false);
            setBorderHistory([]);
        }

        // ③ セッション開始時の画像をメモリに保持（Restore 用）
        modeEntryB64Ref.current = startB64;
        const origImg = new Image();
        await new Promise((res, rej) => {
            origImg.onload = res;
            origImg.onerror = rej;
            origImg.src = `data:image/png;base64,${startB64}`;
        });
        refineOrigImgRef.current = origImg;

        // ④ autoRangeMode はデフォルト true のため、モード開始時に BFS temp ファイルを初期化
        // （初期化しないと handleAutoRangeClick 内のガードで即リターンになる）
        if (autoRangeMode) {
            const bfsResult = await ipcRenderer.invoke('ai-refine-start', { base64Data: startB64 });
            if (bfsResult.ok) {
                if (refineBFSCleanupRef.current.length > 0) cleanupRefineFiles(refineBFSCleanupRef.current);
                refineBFSOrigPathRef.current    = bfsResult.originalPath;
                refineBFSCurrentPathRef.current = bfsResult.currentPath;
                refineBFSCleanupRef.current     = [bfsResult.originalPath, bfsResult.currentPath];
            }
        }

        setRefineHistory([startB64]);
        setRefineMode(true);
    };

    // ── 自動範囲透過 (BFS) チェックボックス切り替え ──────────────
    const handleToggleAutoRange = async (checked) => {
        if (!refineMode) return;
        if (checked) {
            // BFS モード: temp ファイルを作成してセッション開始
            const curB64 = refineHistory[refineHistory.length - 1] ?? resultB64;
            if (!curB64) return;
            const result = await ipcRenderer.invoke('ai-refine-start', { base64Data: curB64 });
            if (!result.ok) { alert('Auto range setup failed: ' + result.error); return; }
            if (refineBFSCleanupRef.current.length > 0) cleanupRefineFiles(refineBFSCleanupRef.current);
            refineBFSOrigPathRef.current    = result.originalPath;
            refineBFSCurrentPathRef.current = result.currentPath;
            refineBFSCleanupRef.current     = [result.originalPath, result.currentPath];
        } else {
            // ブラシモードに戻る: BFS temp ファイルをクリーンアップ
            if (refineBFSCleanupRef.current.length > 0) {
                cleanupRefineFiles(refineBFSCleanupRef.current);
                refineBFSCleanupRef.current = [];
            }
            refineBFSOrigPathRef.current    = null;
            refineBFSCurrentPathRef.current = null;
        }
        setAutoRangeMode(checked);
    };

    // ── 自動範囲透過クリックハンドラ (BFS) ─────────────────────
    const handleAutoRangeClick = async (e) => {
        if (!refineMode || !autoRangeMode || refineProcessingRef.current) return;
        if (!refineBFSOrigPathRef.current || !refineBFSCurrentPathRef.current) return;
        e.preventDefault();
        const mode = e.button === 2 ? 'restore' : 'erase';
        const norm = screenToNorm(e.clientX, e.clientY);
        if (!norm) return;
        const { normX, normY } = norm;
        const img = previewImgRef.current;
        if (!img) return;
        const x = Math.round(normX * img.naturalWidth);
        const y = Math.round(normY * img.naturalHeight);
        refineProcessingRef.current = true;
        const containerRect = previewContainerRef.current?.getBoundingClientRect();
        if (containerRect) setRefineLoadingPos({ x: e.clientX - containerRect.left, y: e.clientY - containerRect.top });
        setProcessing(true);
        try {
            const result = await ipcRenderer.invoke('ai-refine', {
                originalPath: refineBFSOrigPathRef.current,
                currentPath:  refineBFSCurrentPathRef.current,
                x, y, mode,
            });
            if (!result.ok) throw new Error(result.error);
            refineBFSCurrentPathRef.current = result.newPath;
            refineBFSCleanupRef.current.push(result.newPath);
            setDisplaySrc(`data:image/png;base64,${result.base64Data}`);
            setResultB64(result.base64Data);
            setCurrentWorkingImage(result.base64Data); // BFS 結果を currentWorkingImage に同期
            setRefineHistory(h => {
                const next = [...h, result.base64Data];
                return next.length > REFINE_HISTORY_MAX
                    ? [next[0], ...next.slice(next.length - REFINE_HISTORY_MAX + 1)]
                    : next;
            });
        } catch (err) {
            alert('Auto range error: ' + err.message);
        } finally {
            refineProcessingRef.current = false;
            setRefineLoadingPos(null);
            setProcessing(false);
        }
    };

    const handleRefineUndo = () => {
        if (refineHistory.length <= 1) return;
        const newHistory = refineHistory.slice(0, -1);
        setRefineHistory(newHistory);
        const prevB64 = newHistory[newHistory.length - 1];
        setDisplaySrc(`data:image/png;base64,${prevB64}`);
        setResultB64(prevB64);
        setCurrentWorkingImage(prevB64); // Undo 後も currentWorkingImage を同期
        // BFS モードの場合 current path を前状態で再構築（async で待機不要）
        if (autoRangeMode && refineBFSOrigPathRef.current) {
            ipcRenderer.invoke('ai-refine-start', { base64Data: prevB64 }).then(result => {
                if (!result.ok) return;
                if (refineBFSCleanupRef.current.length > 0) cleanupRefineFiles(refineBFSCleanupRef.current);
                refineBFSOrigPathRef.current    = result.originalPath;
                refineBFSCurrentPathRef.current = result.currentPath;
                refineBFSCleanupRef.current     = [result.originalPath, result.currentPath];
            });
        }
        const cvs = refineCanvasRef.current;
        if (cvs) {
            const img = new Image();
            img.onload = () => {
                const ctx = cvs.getContext('2d');
                ctx.clearRect(0, 0, cvs.width, cvs.height);
                ctx.globalCompositeOperation = 'source-over';
                ctx.drawImage(img, 0, 0);
            };
            img.src = `data:image/png;base64,${prevB64}`;
        }
    };

    // ── ブラシ描画ヘルパー ─────────────────────────────────────────

    const getRefineCanvasPos = (e) => {
        const cvs = refineCanvasRef.current;
        if (!cvs) return { x: 0, y: 0 };
        const rect = cvs.getBoundingClientRect();
        return {
            x: (e.clientX - rect.left) * (cvs.width / rect.width),
            y: (e.clientY - rect.top)  * (cvs.height / rect.height),
        };
    };

    const applyBrushStroke = (ctx, from, to, mode) => {
        const cvs = refineCanvasRef.current;
        if (!cvs) return;
        const rect = cvs.getBoundingClientRect();
        const bpx = Math.max(1, brushSize * (cvs.width / rect.width));
        ctx.save();
        if (mode === 'erase') {
            ctx.globalCompositeOperation = 'destination-out';
            ctx.strokeStyle = 'rgba(0,0,0,1)';
            ctx.lineWidth   = bpx;
            ctx.lineCap     = 'round';
            ctx.lineJoin    = 'round';
            ctx.beginPath();
            ctx.moveTo(from.x, from.y);
            ctx.lineTo(to.x, to.y);
            ctx.stroke();
        } else {
            // Restore: セッション開始時の画像ピクセルをブラシ形状で復元
            const origImg = refineOrigImgRef.current;
            if (!origImg) { ctx.restore(); return; }
            const oc = document.createElement('canvas');
            oc.width  = cvs.width;
            oc.height = cvs.height;
            const octx = oc.getContext('2d');
            // ① ブラシ軌跡マスクを描画
            octx.strokeStyle = '#000';
            octx.lineWidth   = bpx;
            octx.lineCap     = 'round';
            octx.lineJoin    = 'round';
            octx.beginPath();
            octx.moveTo(from.x, from.y);
            octx.lineTo(to.x, to.y);
            octx.stroke();
            // ② 元画像をマスク形状に切り抜く
            octx.globalCompositeOperation = 'source-in';
            octx.drawImage(origImg, 0, 0, cvs.width, cvs.height);
            // ③ メインキャンバスに合成
            ctx.globalCompositeOperation = 'source-over';
            ctx.drawImage(oc, 0, 0);
        }
        ctx.restore();
    };

    const handleRefinePointerDown = (e) => {
        if (!refineMode) return;
        e.preventDefault();
        const cvs = refineCanvasRef.current;
        if (!cvs) return;
        refineIsDrawingRef.current = true;
        refineButtonRef.current    = e.button;
        const pos  = getRefineCanvasPos(e);
        refinePrevPosRef.current   = pos;
        // 単点クリック時にも描画
        applyBrushStroke(cvs.getContext('2d'), pos, pos, e.button === 2 ? 'restore' : 'erase');
        cvs.setPointerCapture(e.pointerId);
    };

    const handleRefinePointerMove = (e) => {
        // カーソル位置更新（コンテナ相対座標）
        const containerRect = previewContainerRef.current?.getBoundingClientRect();
        if (containerRect) {
            setRefineCursorPos({ x: e.clientX - containerRect.left, y: e.clientY - containerRect.top });
        }
        if (!refineIsDrawingRef.current || !refineMode) return;
        const cvs = refineCanvasRef.current;
        if (!cvs) return;
        const pos  = getRefineCanvasPos(e);
        const prev = refinePrevPosRef.current;
        if (prev) {
            applyBrushStroke(cvs.getContext('2d'), prev, pos, refineButtonRef.current === 2 ? 'restore' : 'erase');
        }
        refinePrevPosRef.current = pos;
    };

    const handleRefinePointerUp = () => {
        if (!refineIsDrawingRef.current) return;
        refineIsDrawingRef.current = false;
        refinePrevPosRef.current   = null;
        const cvs = refineCanvasRef.current;
        if (!cvs) return;
        // Undo 履歴に追加 + displaySrc/resultB64 を更新
        const b64 = cvs.toDataURL('image/png').split(',')[1];
        setDisplaySrc(`data:image/png;base64,${b64}`);
        setResultB64(b64);
        setCurrentWorkingImage(b64);
        setDisplaySize({ w: cvs.width, h: cvs.height });
        setRefineHistory(h => {
            const next = [...h, b64];
            return next.length > REFINE_HISTORY_MAX
                ? [next[0], ...next.slice(next.length - REFINE_HISTORY_MAX + 1)]
                : next;
        });
    };

    const handleProcess = async () => {
        if (tab === 'bg') {
            if (resultB64) {
                // 透過処理済み → 最新の作業画像（後から画質変更した場合も考慮）を保存
                onSave(currentWorkingImage || resultB64);
            } else {
                // 未処理 → 透過を実行（画質変更済みなら currentWorkingImage が入力になる）
                await runBgRemoval();
            }
            return;
        } else if (tab === 'edit') {
            const cvs = canvasRef.current;
            if (!cvs) return;
            // 保存は元解像度（displaySize）で行う。キャンバスは表示用の縮小版なので
            // ベース画像を再ロードして等倍で描画し、アノテーション座標をスケールアップする
            const saveW = displaySize.w > 0 ? displaySize.w : cvs.width;
            const saveH = displaySize.h > 0 ? displaySize.h : cvs.height;
            const baseSrc = displaySrc || fullImg;
            const merge = document.createElement('canvas');
            merge.width = saveW; merge.height = saveH;
            const mCtx = merge.getContext('2d');
            if (baseSrc) {
                await new Promise(res => {
                    const baseImg = new Image();
                    baseImg.onload = () => { mCtx.drawImage(baseImg, 0, 0, saveW, saveH); res(); };
                    baseImg.onerror = res;
                    baseImg.src = baseSrc;
                });
            }
            if (annotations.length > 0 && cvs.width > 0) {
                // ハイブリッド方式: DOMからCanvas要素の実際のオフセットを取得し、
                // Canvas内のletterbox余白だけを数学計算で補正する
                const containerEl = previewContainerRef.current;
                const cvsRenderedRect = cvs.getBoundingClientRect();
                const containerRect   = containerEl?.getBoundingClientRect();

                // DOMオフセット: コンテナ左上 → Canvas表示領域左上（CSSピクセル）
                // パディング・Flexbox中央寄せによる余白がすべて統合される
                const offsetX_dom = containerRect ? cvsRenderedRect.left - containerRect.left : 0;
                const offsetY_dom = containerRect ? cvsRenderedRect.top  - containerRect.top  : 0;

                // Canvas表示サイズ（CSSピクセル）
                const cvsRenderedW = cvsRenderedRect.width  || cvs.width;
                const cvsRenderedH = cvsRenderedRect.height || cvs.height;

                // Canvas内のletterbox余白を数学計算（object-fit: contain シミュレーション）
                // DOMサイズはCanvasボックス全体を返すため内部の描画領域を数式で求める
                const cvsRatio = cvsRenderedW / cvsRenderedH;
                const imgRatio = saveW / saveH;
                let letterboxX_cvs = 0;
                let letterboxY_cvs = 0;
                if (imgRatio > cvsRatio) {
                    // 画像がCanvasより横長: Canvas幅にフィット、上下に余白
                    letterboxY_cvs = (cvsRenderedH - (cvsRenderedW / imgRatio)) / 2;
                } else {
                    // 画像がCanvasより縦長: Canvas高さにフィット、左右に余白
                    letterboxX_cvs = (cvsRenderedW - (cvsRenderedH * imgRatio)) / 2;
                }

                // 統合オフセット = DOMオフセット + Canvas内letterbox余白
                const offsetX_final = offsetX_dom + Math.max(0, letterboxX_cvs);
                const offsetY_final = offsetY_dom + Math.max(0, letterboxY_cvs);

                // 実際の画像表示領域サイズ（letterbox除去後）
                const realImgDisplayW = cvsRenderedW - letterboxX_cvs * 2;
                const realImgDisplayH = cvsRenderedH - letterboxY_cvs * 2;

                // スケール: 実際の表示サイズ → 元画像ピクセル
                const scaleX = saveW / realImgDisplayW;
                const scaleY = saveH / realImgDisplayH;

                mCtx.save();
                mCtx.scale(scaleX, scaleY);
                mCtx.translate(-offsetX_final, -offsetY_final);
                for (const ann of annotations) {
                    drawAnnotationToCanvas(mCtx, ann);
                }
                mCtx.restore();
            }
            onSave(merge.toDataURL('image/png').split(',')[1]);
        } else {
            setProcessing(true);
            setTimeout(() => { setProcessing(false); alert(t('upgradeWIP')); }, 1000);
        }
    };

    const [upscaleResultB64, setUpscaleResultB64] = useState(null);
    const [upscaleHistory, setUpscaleHistory]     = useState([]); // undo スナップショット列

    const getExecLabel = () => {
        if (processing) return t('processing');
        if (tab === 'edit') return t('saveDraw');
        if (tab === 'bg') return resultB64 ? t('saveBg') : t('execBg');
        return t('execUpscale');
    };

    const handleSaveUpscale = () => {
        const toSave = currentWorkingImage || upscaleResultB64;
        if (!toSave || processing) return;
        onSave(toSave);
    };

    const handleUpscaleUndo = () => {
        if (upscaleHistory.length === 0) return;
        const prevB64 = upscaleHistory[upscaleHistory.length - 1];
        setUpscaleHistory(h => h.slice(0, -1));
        if (prevB64 === null) {
            // 画質変更前の状態へ戻す（背景透過済みであればその画像を表示）
            const fallback = resultB64 || null;
            setCurrentWorkingImage(fallback);
            setDisplaySrc(fallback ? `data:image/png;base64,${fallback}` : fullImg);
            setUpscaleResultB64(null);
        } else {
            setCurrentWorkingImage(prevB64);
            setDisplaySrc(`data:image/png;base64,${prevB64}`);
            setUpscaleResultB64(prevB64);
        }
    };

    const handleRunUpscale = async (mode) => {
        if (processing) return;
        setProcessing(true);
        try {
            // 最新の作業画像を入力とする（透過済み・前回の画質変更済みを引き継ぐ）
            let base64Data;
            if (currentWorkingImage) {
                base64Data = currentWorkingImage;
            } else {
                base64Data = await ipcRenderer.invoke('get-full-image', shot.id);
            }
            if (!base64Data) throw new Error(t('origLoadError'));

            // 解像度ガード: 入力が上限を超えていないかチェック
            // 2x モードは出力が4倍になるため出力ピクセル数も確認する
            const { w: srcW, h: srcH } = await checkResolutionGuard(base64Data);
            if (mode === '2x' && srcW * 2 * srcH * 2 > MAX_PIXELS) {
                throw new Error(
                    `2倍拡張後のサイズが大きすぎます（${srcW * 2}×${srcH * 2} / ${(srcW * 2 * srcH * 2 / 1_000_000).toFixed(1)}MP）。\n縮小してからお試しください。`
                );
            }

            if (mode === 'degrade') {
                const origImg = new Image();
                await new Promise(res => { origImg.onload = res; origImg.src = `data:image/png;base64,${base64Data}`; });
                const downScale = 0.25;
                const dw = Math.max(1, Math.round(origImg.width * downScale));
                const dh = Math.max(1, Math.round(origImg.height * downScale));
                const dsCanvas = document.createElement('canvas');
                dsCanvas.width = dw; dsCanvas.height = dh;
                dsCanvas.getContext('2d').drawImage(origImg, 0, 0, dw, dh);
                const upCanvas = document.createElement('canvas');
                upCanvas.width = origImg.width; upCanvas.height = origImg.height;
                const upCtx = upCanvas.getContext('2d');
                upCtx.imageSmoothingEnabled = false;
                upCtx.drawImage(dsCanvas, 0, 0, origImg.width, origImg.height);
                const degradedB64 = upCanvas.toDataURL('image/png').split(',')[1];
                setUpscaleHistory(h => [...h, upscaleResultB64]);
                setDisplaySrc(`data:image/png;base64,${degradedB64}`);
                setUpscaleResultB64(degradedB64);
                setCurrentWorkingImage(degradedB64);
            } else if (mode === '2x') {
                const result = await ipcRenderer.invoke('ai-sr-upscale', { base64Data, scale: 2 });
                if (!result.ok) throw new Error(result.error);
                setUpscaleHistory(h => [...h, upscaleResultB64]);
                setDisplaySrc(`data:image/png;base64,${result.base64Data}`);
                setUpscaleResultB64(result.base64Data);
                setCurrentWorkingImage(result.base64Data);
            }
        } catch (err) {
            alert('Error: ' + err.message);
        } finally {
            setProcessing(false);
        }
    };


    return (
        <div className="ai-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
            <div className="ai-modal-wide">
                <div className="ai-header">
                    <img src="./logo/Quick_Shot.png" alt="QS" style={{ width: 22, height: 22, borderRadius: 4, objectFit: 'cover', flexShrink: 0 }} />
                    <div className="ai-header-title">{t('aiPanelTitle')}</div>
                    <button className="btn" onClick={onClose}>✕</button>
                </div>

                <div className="ai-tabs">
                    {AI_TABS.map(tb => (
                        <button key={tb.id} className={`ai-tab ${tab === tb.id ? 'active' : ''}`} onClick={() => { setTab(tb.id); setView({ zoom: 1, panX: 0, panY: 0 }); }}>
                            {tb.label}
                        </button>
                    ))}
                </div>

                <div className="ai-body-split">
                    <div
                        ref={previewContainerRef}
                        className="ai-preview-area"
                        style={{
                            position: 'relative', userSelect: 'none',
                            ...(bgMode === 'white' ? { background: '#ffffff' }
                            : bgMode === 'black'   ? { background: '#000000' }
                            : { backgroundImage: 'repeating-conic-gradient(#2a2a2a 0% 25%, #1e1e1e 0% 50%)', backgroundSize: '20px 20px' }),
                        }}
                        onPointerDown={handleContainerPointerDown}
                        onPointerMove={handleContainerPointerMove}
                        onPointerUp={stopPan}
                        onPointerLeave={stopPan}
                    >
                        {displaySrc || fullImg ? (
                            // ── 単一 transform ターゲット ─────────────────────────────
                            // transform はこの div に集約し、各子要素から除去。
                            // ミドルクリックパン・ホイールズームとも imageWrapperRef.current.style.transform を
                            // 直接書き換えて React の再レンダリングを挟まずに 60fps を維持する。
                            <div
                                ref={imageWrapperRef}
                                style={{
                                    position: 'relative',  // 選択枠の絶対配置の基準にする
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    width: '100%',
                                    height: '100%',
                                    transformOrigin: 'center center',
                                    // willChange はパン開始時に動的に付与し、終了時に 'auto' へ戻す
                                    // （常時 ON にすると高解像度画像で VRAM を無駄占有する）
                                }}
                            >
                                {/* キャンバス: 常にDOMに保持しdisplay:noneで隠す */}
                                <div style={{
                                    position: 'relative', display: tab === 'edit' ? 'inline-block' : 'none',
                                    maxWidth: '100%', maxHeight: '100%',
                                }}>
                                    <canvas
                                        ref={canvasRef}
                                        style={{ display: 'block', maxWidth: '100%', maxHeight: '100%' }}
                                    />
                                </div>
                                {/* edit以外のタブ: refine/通常imgビュー */}
                                {tab !== 'edit' && (
                                    refineMode ? (
                                        autoRangeMode ? (
                                            /* ── 自動範囲透過 (BFS) モード: img でクリック検出 ── */
                                            <img
                                                ref={previewImgRef}
                                                src={displaySrc || fullImg}
                                                alt="Preview"
                                                draggable={false}
                                                onLoad={(e) => setDisplaySize({ w: e.target.naturalWidth, h: e.target.naturalHeight })}
                                                onMouseDown={handleAutoRangeClick}
                                                onContextMenu={(e) => e.preventDefault()}
                                                style={{
                                                    maxWidth: '100%', maxHeight: '100%', objectFit: 'contain',
                                                    cursor: processing ? 'wait' : 'crosshair',
                                                    display: 'block',
                                                    filter: 'drop-shadow(0px 4px 10px rgba(0,0,0,0.55))',
                                                }}
                                            />
                                        ) : (
                                            /* ── ブラシ Refine キャンバス ── */
                                            <canvas
                                                ref={refineCanvasRef}
                                                style={{
                                                    maxWidth: '100%', maxHeight: '100%',
                                                    display: 'block',
                                                    cursor: 'none',
                                                    filter: 'drop-shadow(0px 4px 10px rgba(0,0,0,0.55))',
                                                }}
                                                onPointerDown={handleRefinePointerDown}
                                                onPointerMove={handleRefinePointerMove}
                                                onPointerUp={handleRefinePointerUp}
                                                onPointerLeave={() => { setRefineCursorPos(null); handleRefinePointerUp(); }}
                                                onContextMenu={(e) => e.preventDefault()}
                                            />
                                        )
                                    ) : (
                                        <img
                                            ref={previewImgRef}
                                            src={displaySrc || fullImg}
                                            alt="Preview"
                                            draggable={false}
                                            onLoad={(e) => setDisplaySize({ w: e.target.naturalWidth, h: e.target.naturalHeight })}
                                            onMouseDown={handleDragStart}
                                            style={{
                                                maxWidth: '100%', maxHeight: '100%', objectFit: 'contain',
                                                cursor: tab === 'bg' ? 'crosshair' : 'default',
                                                display: 'block',
                                                filter: (tab === 'bg' && resultB64)
                                                    ? 'drop-shadow(0px 4px 10px rgba(0,0,0,0.55))'
                                                    : undefined,
                                            }}
                                        />
                                    )
                                )}

                                {/* ── 選択枠オーバーレイ ─────────────────────────────────────
                                    imageWrapper 内に配置することで transform（パン・ズーム）を継承。
                                    position: absolute で flex flow から切り離し、
                                    LOCAL 座標（getImageLocalLayout）で pixel-perfect に位置合わせ。
                                    ドラッグ中・確定後で共通の div を使い回す。 */}
                                {tab === 'bg' && (() => {
                                    const box = isDragging ? dragBox : finalBox;
                                    if (!box) return null;
                                    const L = getImageLocalLayout();
                                    if (!L) return null;
                                    const { imgLocalW, imgLocalH, imgLocalLeft, imgLocalTop } = L;
                                    // ドラッグ開始直後（サイズほぼ 0）の場合は描画しない。
                                    // boxShadow が全体を覆うことで画像が「縮む・消える」ように見えるのを防ぐ。
                                    const boxW = (box.x2 - box.x1) * imgLocalW;
                                    const boxH = (box.y2 - box.y1) * imgLocalH;
                                    if (boxW < 3 && boxH < 3) return null;
                                    return (
                                        <div style={{
                                            position: 'absolute',
                                            left:   imgLocalLeft + box.x1 * imgLocalW,
                                            top:    imgLocalTop  + box.y1 * imgLocalH,
                                            width:  (box.x2 - box.x1) * imgLocalW,
                                            height: (box.y2 - box.y1) * imgLocalH,
                                            border: isDragging
                                                ? '2px dashed #00ffff'
                                                : '2px solid rgba(0,255,255,0.6)',
                                            background: isDragging ? 'rgba(0,255,255,0.06)' : 'none',
                                            boxShadow: isDragging
                                                ? '0 0 0 9999px rgba(0,0,0,0.35)'
                                                : 'none',
                                            pointerEvents: 'none',
                                        }} />
                                    );
                                })()}
                            </div>
                        ) : (
                            <div style={{ color: '#00ffff', fontSize: 20 }}>{t('loading')}</div>
                        )}

                        {/* SVG アノテーションオーバーレイ - コンテナ絶対配置（edit タブ専用） */}
                        {tab === 'edit' && containerSize.w > 0 && (
                            <svg
                                ref={svgRef}
                                viewBox={`0 0 ${containerSize.w} ${containerSize.h}`}
                                preserveAspectRatio="none"
                                style={{
                                    position: 'absolute', top: 0, left: 0,
                                    width: '100%', height: '100%',
                                    overflow: 'visible',
                                    cursor: tool === 'text' ? 'text' : 'crosshair',
                                    touchAction: 'none',
                                    zIndex: 20,
                                }}
                                onPointerDown={handleSvgPointerDown}
                                onPointerMove={handleSvgPointerMove}
                                onPointerUp={handleSvgPointerUp}
                                onPointerLeave={handleSvgPointerUp}
                            >
                                {/* 背景クリック受付用透明rect */}
                                <rect x={0} y={0} width={containerSize.w} height={containerSize.h} fill="transparent" pointerEvents="all" />
                                {/* コミット済みアノテーション */}
                                {annotations.map(ann => renderAnnotationSVG(ann, ann.id === selectedId))}
                                {/* ドラフト（描画中） */}
                                {draftAnn && renderAnnotationSVG({ ...draftAnn, id: '__draft__' }, false, true)}
                            </svg>
                        )}

                        {/* テキスト入力オーバーレイ - コンテナ絶対配置（edit タブ専用） */}
                        {tab === 'edit' && textInput && (
                            <div
                                ref={textInputRef}
                                contentEditable
                                suppressContentEditableWarning
                                autoFocus
                                onFocus={() => ipcRenderer.invoke('shortcut-lock').catch(() => {})}
                                onCompositionStart={() => { isComposingRef.current = true; }}
                                onCompositionEnd={e => {
                                    isComposingRef.current = false;
                                    const text = e.currentTarget.textContent;
                                    textContentRef.current = text;
                                    setTextInput(prev => ({ ...prev, value: text }));
                                }}
                                onInput={e => {
                                    const text = e.currentTarget.textContent;
                                    textContentRef.current = text;
                                    // IME変換中は state 更新を省略して再レンダリングによる変換中断を防ぐ
                                    if (!isComposingRef.current) {
                                        setTextInput(prev => ({ ...prev, value: text }));
                                    }
                                }}
                                onKeyDown={e => {
                                    e.stopPropagation();
                                    // IME変換確定の Enter を誤検知しないようにガード
                                    if (e.nativeEvent.isComposing) return;
                                    if (e.key === 'Enter' && !e.shiftKey) {
                                        e.preventDefault();
                                        commitTextLayer(textContentRef.current);
                                    }
                                    if (e.key === 'Escape') {
                                        ipcRenderer.invoke('shortcut-unlock').catch(() => {});
                                        setTextInput(null);
                                    }
                                }}
                                onBlur={() => commitTextLayer(textContentRef.current)}
                                style={{
                                    position: 'absolute',
                                    left: textInput.canvasX,
                                    top: textInput.canvasY - lineWidth * 6,
                                    background: 'transparent',
                                    border: '1px dashed rgba(0,255,255,0.7)',
                                    borderRadius: 2,
                                    color: color,
                                    fontSize: `${lineWidth * 6}px`,
                                    fontFamily: `"${selectedFont || 'sans-serif'}", sans-serif`,
                                    outline: 'none',
                                    minWidth: 60,
                                    padding: '2px 4px',
                                    whiteSpace: 'pre',
                                    lineHeight: 1.2,
                                    zIndex: 30,
                                    cursor: 'text',
                                }}
                            />
                        )}

                        {/* Refine ローディングインジケーター */}
                        {refineMode && refineLoadingPos && (
                            <div style={{
                                position: 'absolute',
                                left: refineLoadingPos.x - 8,
                                top:  refineLoadingPos.y - 8,
                                width: 16, height: 16,
                                borderRadius: '50%',
                                border: '2px solid #00ffff',
                                borderTopColor: 'transparent',
                                animation: 'qs-spin 0.6s linear infinite',
                                pointerEvents: 'none',
                                zIndex: 20,
                            }} />
                        )}

                        {/* ブラシカーソル円 */}
                        {refineMode && refineCursorPos && (
                            <div style={{
                                position: 'absolute',
                                left: refineCursorPos.x - brushSize / 2,
                                top:  refineCursorPos.y - brushSize / 2,
                                width:  brushSize,
                                height: brushSize,
                                borderRadius: '50%',
                                border: '1.5px solid rgba(0,255,255,0.9)',
                                boxShadow: '0 0 0 1px rgba(0,0,0,0.6)',
                                pointerEvents: 'none',
                                zIndex: 30,
                            }} />
                        )}

                        {/* 画像サイズ表示（左上） */}
                        {displaySize.w > 0 && (
                            <div style={{
                                position: 'absolute', top: 8, left: 8,
                                background: 'rgba(0,0,0,0.65)', borderRadius: 4,
                                padding: '3px 7px', fontSize: 11,
                                color: '#00ffff', fontWeight: 600,
                                zIndex: 10, pointerEvents: 'none',
                            }}>
                                {displaySize.w} × {displaySize.h}
                            </div>
                        )}

                        {/* ズームインジケーター + 背景切り替えボタン */}
                        <div style={{
                            position: 'absolute', top: 8, right: 8,
                            display: 'flex', alignItems: 'center', gap: 4,
                            background: 'rgba(0,0,0,0.65)', borderRadius: 4,
                            padding: '3px 7px', fontSize: 11, color: '#fff',
                            zIndex: 50, pointerEvents: 'auto',
                        }}>
                            {(displaySrc || fullImg) && (
                                <button
                                    onClick={() => setBgMode(m => {
                                        const i = BG_MODES.indexOf(m);
                                        return BG_MODES[(i + 1) % BG_MODES.length];
                                    })}
                                    title={bgMode === 'checker' ? '白背景' : bgMode === 'white' ? '黒背景' : '市松模様'}
                                    style={{
                                        background: 'none', border: '1px solid rgba(255,255,255,0.35)',
                                        borderRadius: 2, color: '#fff', cursor: 'pointer',
                                        padding: '0 3px', fontSize: 11, lineHeight: '14px',
                                    }}
                                >{BG_MODE_ICONS[bgMode]}</button>
                            )}
                            <span>{Math.round(view.zoom * 100)}%</span>
                            <button
                                onClick={() => setView({ zoom: 1, panX: 0, panY: 0 })}
                                title="Reset zoom"
                                style={{
                                    background: 'none', border: '1px solid rgba(255,255,255,0.35)',
                                    borderRadius: 2, color: '#fff', cursor: 'pointer',
                                    padding: '0 4px', fontSize: 10, lineHeight: '14px',
                                }}
                            >■</button>
                        </div>
                    </div>

                    <div className="ai-bottom-bar">
                        {/* ── 透過結果画面: 部分修正・縁取りモード UI ── */}
                        {tab === 'bg' && resultB64 ? (
                            <div style={{ display: 'flex', width: '100%', gap: 0 }}>
                                {/* 左: モードボタン + サブコンテンツ */}
                                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px' }}>
                                    {/* モードボタン行 */}
                                    <div style={{ display: 'flex', gap: 8 }}>
                                        {[
                                            { id: 'refine', label: t('refineModeLabel'), active: refineMode,  dimmed: !refineMode && borderMode },
                                            { id: 'border', label: t('borderModeLabel'), active: borderMode, dimmed: !borderMode && refineMode },
                                        ].map(m => (
                                            <button
                                                key={m.id}
                                                onClick={m.id === 'refine' ? handleToggleRefineMode : handleToggleBorderMode}
                                                style={{
                                                    flex: 1, padding: '8px 12px',
                                                    border: `1px solid ${m.active ? 'var(--accent)' : 'var(--border)'}`,
                                                    borderRadius: 'var(--radius-sm)',
                                                    background: m.active ? 'var(--accent-dim)' : 'var(--bg-tile)',
                                                    color: m.active ? 'var(--accent)' : 'var(--text)',
                                                    opacity: m.dimmed ? 0.4 : 1,
                                                    cursor: 'pointer',
                                                    fontWeight: m.active ? 700 : 500,
                                                    fontSize: 13,
                                                }}
                                            >{m.label}</button>
                                        ))}
                                    </div>

                                    {/* サブコンテンツ: デフォルト（説明文） */}
                                    {!refineMode && !borderMode && (
                                        <div style={{ display: 'flex', gap: 8 }}>
                                            <div style={{ flex: 1, fontSize: 10, color: 'var(--text-sub)', lineHeight: 1.5 }}>{t('refineModeDesc')}</div>
                                            <div style={{ flex: 1, fontSize: 10, color: 'var(--text-sub)', lineHeight: 1.5 }}>{t('borderModeDesc')}</div>
                                        </div>
                                    )}

                                    {/* サブコンテンツ: 部分修正モード */}
                                    {refineMode && (
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                            {/* 行1: ヒント + 自動範囲透過チェックボックス + 一つ戻る */}
                                            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                                <div style={{ flex: 1, fontSize: 10, color: 'var(--accent)', lineHeight: 1.6 }}>
                                                    {autoRangeMode
                                                        ? t('autoRangeHint')
                                                        : <>{t('refineHintLeft')}<br />{t('refineHintRight')}</>}
                                                </div>
                                                <label style={{
                                                    display: 'flex', gap: 4, alignItems: 'center',
                                                    fontSize: 12, color: 'var(--text)',
                                                    cursor: 'pointer', flexShrink: 0, whiteSpace: 'nowrap',
                                                    lineHeight: 1.4,
                                                }}>
                                                    <input
                                                        type="checkbox"
                                                        checked={autoRangeMode}
                                                        onChange={e => handleToggleAutoRange(e.target.checked)}
                                                        style={{ cursor: 'pointer', accentColor: '#00ffff', width: 14, height: 14, marginTop: 2, flexShrink: 0 }}
                                                    />
                                                    {t('autoRangeLabel')}
                                                </label>
                                                <button
                                                    className="btn"
                                                    onClick={handleRefineUndo}
                                                    disabled={refineHistory.length <= 1}
                                                >{t('undoStep')}</button>
                                            </div>
                                            {/* 行2: ブラシサイズスライダー（ブラシモード時のみ） */}
                                            {!autoRangeMode && (
                                                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                                    <span style={{ fontSize: 10, color: 'var(--text-sub)', flexShrink: 0 }}>
                                                        {t('brushSizeLabel')}: {brushSize}px
                                                    </span>
                                                    <input
                                                        type="range" min={1} max={100} value={brushSize}
                                                        onChange={e => setBrushSize(Number(e.target.value))}
                                                        style={{ flex: 1, accentColor: 'var(--accent)' }}
                                                    />
                                                </div>
                                            )}
                                        </div>
                                    )}

                                    {/* サブコンテンツ: 縁取りモード */}
                                    {borderMode && (
                                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                            <div style={{ display: 'flex', gap: 4, flex: 1, flexWrap: 'wrap', alignItems: 'center' }}>
                                                {[
                                                    { type: 'white',    label: t('borderWhite') },
                                                    { type: 'black',    label: t('borderBlack') },
                                                    { type: 'original', label: t('borderOrig') },
                                                ].map(b => (
                                                    <button
                                                        key={b.type}
                                                        className="ai-mode-btn-compact"
                                                        onClick={() => handleAddBorder(b.type)}
                                                        disabled={processing}
                                                        style={{ fontSize: 11, padding: '3px 10px' }}
                                                    >{b.label}</button>
                                                ))}
                                            </div>
                                            <button
                                                className="btn"
                                                onClick={handleBorderUndo}
                                                disabled={borderHistory.length === 0 || processing}
                                            >{t('undoStep')}</button>
                                        </div>
                                    )}
                                </div>

                                {/* 右: 透過前に戻る + この画像を保存 */}
                                <div className="ai-execute-pane">
                                    <button
                                        onClick={handleRevertBg}
                                        style={{
                                            width: '100%', padding: '8px', marginBottom: 6,
                                            border: '1px solid var(--border)',
                                            borderRadius: 'var(--radius-sm)',
                                            background: 'var(--bg-tile)',
                                            color: 'var(--text-sub)',
                                            fontSize: 12,
                                            cursor: 'pointer',
                                        }}
                                    >{t('revertBg')}</button>
                                    <button
                                        className="ai-process-btn-wide"
                                        onClick={() => onSave(resultB64)}
                                        disabled={processing}
                                    >{processing ? t('processing') : t('saveBg')}</button>
                                </div>
                            </div>

                        ) : tab === 'upscale' ? (
                            /* ── 画質の変更タブ専用 UI ── */
                            <div style={{ display: 'flex', width: '100%', gap: 0 }}>
                                {/* 左: アクションボタン行 + 一つ戻る */}
                                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px' }}>
                                    <div style={{ display: 'flex', gap: 8 }}>
                                        <button
                                            className="ai-mode-btn-compact"
                                            onClick={() => handleRunUpscale('2x')}
                                            disabled={processing}
                                            style={{ fontSize: 13, padding: '8px 12px', flex: 1 }}
                                        >{processing ? t('processing') : t('upscale2x')}</button>
                                        <button
                                            className="ai-mode-btn-compact"
                                            onClick={() => handleRunUpscale('degrade')}
                                            disabled={processing}
                                            style={{ fontSize: 13, padding: '8px 12px', flex: 1 }}
                                        >{t('upscaleDegrade')}</button>
                                    </div>
                                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                                        <button
                                            className="btn"
                                            onClick={handleUpscaleUndo}
                                            disabled={upscaleHistory.length === 0 || processing}
                                        >{t('undoStep')}</button>
                                    </div>
                                </div>

                                {/* 右: 画質変更前に戻る + この画像を保存 */}
                                <div className="ai-execute-pane">
                                    <button
                                        onClick={handleRevertUpscale}
                                        disabled={!upscaleResultB64}
                                        style={{
                                            width: '100%', padding: '8px', marginBottom: 6,
                                            border: '1px solid var(--border)',
                                            borderRadius: 'var(--radius-sm)',
                                            background: 'var(--bg-tile)',
                                            color: 'var(--text-sub)',
                                            fontSize: 12,
                                            cursor: !upscaleResultB64 ? 'not-allowed' : 'pointer',
                                            opacity: !upscaleResultB64 ? 0.4 : 1,
                                        }}
                                    >{t('revertUpscale')}</button>
                                    <button
                                        className="ai-process-btn-wide"
                                        onClick={handleSaveUpscale}
                                        disabled={!upscaleResultB64 || processing}
                                    >{processing ? t('processing') : t('saveBg')}</button>
                                </div>
                            </div>

                        ) : tab === 'edit' ? (
                            /* ── 記号・文字を追加タブ専用 UI ── */
                            <div style={{ display: 'flex', flexDirection: 'column', width: '100%', gap: 10 }}>
                                {/* Row 1: ツールボタン + フォントドロップダウン + Undo */}
                                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                    {TOOLS.map(tb => (
                                        <button
                                            key={tb.id}
                                            className={`editor-tool-btn ${tool === tb.id ? 'active' : ''}`}
                                            onClick={() => setTool(tb.id)}
                                            title={tb.label}
                                        >
                                            {tb.icon}
                                        </button>
                                    ))}
                                    <select
                                        value={selectedFont}
                                        onChange={e => {
                                            setSelectedFont(e.target.value);
                                            localStorage.setItem('qs-last-selected-font', e.target.value);
                                        }}
                                        style={{
                                            flex: 1,
                                            maxWidth: 200,
                                            background: 'rgba(0,0,0,0.4)',
                                            border: '1px solid var(--border)',
                                            borderRadius: 6,
                                            color: 'var(--accent)',
                                            fontSize: 12,
                                            padding: '6px 12px',
                                            cursor: 'pointer',
                                            fontFamily: 'Inter, system-ui',
                                            outline: 'none',
                                        }}
                                    >
                                        {systemFonts.map(f => <option key={f} value={f}>{f}</option>)}
                                    </select>
                                    <button className="btn" onClick={handleUndo} disabled={annotations.length === 0}>🔙Undo</button>
                                    {selectedId && (
                                        <button className="btn" onClick={handleDeleteSelected} style={{ color: '#ff4466' }}>🗑 削除</button>
                                    )}
                                </div>
                                {/* Row 2: カラー + 太さ + spacer + 保存ボタン */}
                                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                                    <div style={{ display: 'flex', gap: 6 }}>
                                        {COLORS.map(c => (
                                            <div key={c} className={`editor-color-swatch ${color === c ? 'active' : ''}`} style={{ background: c }} onClick={() => setColor(c)} />
                                        ))}
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                        <span style={{ color: 'var(--text-sub)', fontSize: 11 }}>{t('lineWidth')}</span>
                                        <input type="range" min="1" max="20" value={lineWidth} onChange={e => setLineWidth(parseInt(e.target.value))} style={{ width: 60, accentColor: 'var(--accent)' }} />
                                    </div>
                                    <div style={{ flex: 1 }} />
                                    <button
                                        className="ai-process-btn-wide"
                                        onClick={handleProcess}
                                        disabled={processing}
                                        style={{ width: 'auto', padding: '10px 28px', flexShrink: 0 }}
                                    >{processing ? t('processing') : t('saveBg')}</button>
                                </div>
                            </div>

                        ) : (
                            /* ── 通常ボトムバー（背景透過前のみ） ── */
                            <>
                                <div className="ai-options-pane">
                                    {tab === 'bg' && (
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                            <div style={{ display: 'flex', gap: 6 }}>
                                                {[
                                                    { id: 'simple',  label: t('targetSimple'),  desc: null },
                                                    { id: 'complex', label: t('targetComplex'), desc: t('targetComplexDesc') },
                                                    { id: 'logo',    label: t('logoMode'),      desc: t('logoModeDesc') },
                                                ].map(m => (
                                                    <button
                                                        key={m.id}
                                                        onClick={() => setTargetMode(m.id)}
                                                        style={{
                                                            flex: 1, padding: '5px 8px',
                                                            border: `1px solid ${targetMode === m.id ? 'var(--accent)' : 'var(--border)'}`,
                                                            borderRadius: 'var(--radius-sm)',
                                                            background: targetMode === m.id ? 'var(--accent-dim)' : 'var(--bg-tile)',
                                                            color: targetMode === m.id ? 'var(--accent)' : 'var(--text-sub)',
                                                            cursor: 'pointer', textAlign: 'left',
                                                            display: 'flex', flexDirection: 'column', gap: 2,
                                                        }}
                                                    >
                                                        <span style={{ fontSize: 13, fontWeight: 600 }}>{m.label}</span>
                                                        {m.desc && <span style={{ fontSize: 9.5, lineHeight: 1.35, opacity: 0.85 }}>{m.desc}</span>}
                                                    </button>
                                                ))}
                                            </div>
                                            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                                <div style={{ fontSize: 11, color: 'var(--text-sub)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                    {!finalBox ? t('samInstruction') : t('samRetry')}
                                                </div>
                                                {finalBox && (
                                                    <button
                                                        className="ai-mode-btn-compact"
                                                        onClick={handleClear}
                                                        style={{ fontSize: 11, padding: '3px 8px', flexShrink: 0 }}
                                                    >✕ クリア</button>
                                                )}
                                            </div>
                                        </div>
                                    )}
                                </div>
                                <div className="ai-execute-pane">
                                    <button
                                        className="ai-process-btn-wide"
                                        onClick={handleProcess}
                                        disabled={processing}
                                    >{getExecLabel()}</button>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
