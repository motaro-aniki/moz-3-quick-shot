import React from 'react';

const { ipcRenderer } = window.require('electron');

export default function TitleBar() {
    return (
        <div className="qs-titlebar">
            <img
                src="./logo/Quick_Shot.png"
                alt="QS"
                style={{ width: 20, height: 20, borderRadius: 4, objectFit: 'cover', flexShrink: 0 }}
            />
            <div className="qs-title" style={{ fontSize: 11, flex: 1 }}>MOZ-3 Quick Shot</div>
            <div className="qs-win-btns">
                <button className="qs-win-btn min" style={{ width: 20, height: 20, fontSize: 10 }} onClick={() => ipcRenderer.send('window-control', 'minimize')}>−</button>
                <button className="qs-win-btn close" style={{ width: 20, height: 20, fontSize: 10 }} onClick={() => ipcRenderer.send('window-control', 'close')}>✕</button>
            </div>
        </div>
    );
}

