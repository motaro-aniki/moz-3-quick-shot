import React from 'react';
import ReactDOM from 'react-dom/client';
import MenuApp from './MenuApp';
import { LanguageProvider } from '../i18n';

ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode><LanguageProvider><MenuApp /></LanguageProvider></React.StrictMode>
);
