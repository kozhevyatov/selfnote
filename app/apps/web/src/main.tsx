import { createRoot } from 'react-dom/client';
import '@fontsource/golos-text/400.css';
import '@fontsource/golos-text/500.css';
import '@fontsource/golos-text/600.css';
import '@fontsource/golos-text/700.css';
import App from './App';
import GuestApp from './Guest';
import './styles.css';
import { initAppearance } from './theme';
initAppearance();
// /g/<токен> — гостевая страница совместной заметки, без аккаунта и рабочего пространства
const guest = /^\/g\/([A-Za-z0-9_-]{32})\/?$/.exec(location.pathname);
createRoot(document.getElementById('root')!).render(
  guest ? <GuestApp token={guest[1]} /> : <App />,
);
