/// <reference types="vite/client" />
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DesktopRoot } from '@dsh-desktop/ui';
import '@dsh-desktop/ui/styles.css';
import './index.css';

const container = document.getElementById('root');
if (container == null) {
  throw new Error('DSH Desktop (Tauri): #root container missing in index.html');
}

createRoot(container).render(
  <StrictMode>
    <DesktopRoot />
  </StrictMode>,
);
