import React, { useRef, useEffect } from 'react';
import Tile from './Tile';
import { useT } from '../i18n';

export default function Gallery({ screenshots, filter, scrollTrigger, scrollSignal, onLock, onDelete, onPreview, onAI }) {
    const { t } = useT();
    const galleryRef = useRef(null);

    useEffect(() => {
        if (galleryRef.current) {
            galleryRef.current.scrollTop = galleryRef.current.scrollHeight;
        }
    }, [filter, scrollTrigger]);

    useEffect(() => {
        if (!scrollSignal?.id || !galleryRef.current) return;
        const el = galleryRef.current.querySelector(`[data-shot-id="${scrollSignal.id}"]`);
        if (el) el.scrollIntoView({ block: 'center', behavior: 'instant' });
    }, [scrollSignal]);

    if (screenshots.length === 0) {
        return (
            <div className="qs-gallery">
                <div className="qs-empty">
                    <div className="qs-empty-icon">📭</div>
                    <div className="qs-empty-text">
                        {t('emptyTitle')}<br />
                        {t('emptyHint')}
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="qs-gallery" ref={galleryRef}>
            <div className="qs-gallery-grid">
                {screenshots.map(shot => (
                    <Tile
                        key={shot.id}
                        shot={shot}
                        onLock={() => onLock(shot.id)}
                        onDelete={() => onDelete(shot.id)}
                        onPreview={() => onPreview(shot)}
                        onAI={() => onAI(shot)}
                    />
                ))}
            </div>
        </div>
    );
}
