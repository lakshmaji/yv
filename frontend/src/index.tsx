import { render } from 'solid-js/web';
import { ErrorBoundary } from 'solid-js';
import App from './App';
import './styles.css';
import { initLogger, logError } from './lib/logger';

initLogger(__APP_VERSION__);

window.addEventListener('error', (e) => logError('uncaught error', e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => logError('unhandled rejection', e.reason));

render(
  () => (
    <ErrorBoundary
      fallback={(err) => {
        logError('render crashed', err);
        return <div style={{ padding: '2rem', color: '#eee' }}>yv hit an error and needs to restart.</div>;
      }}
    >
      <App />
    </ErrorBoundary>
  ),
  document.getElementById('root')!,
);
