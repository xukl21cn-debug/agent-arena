import { createRoot } from 'react-dom/client';
import App from './App';
import { TooltipProvider } from '@/components/ui/tooltip';
import './styles/tailwind.css';
import './styles/index.scss';

const container = document.getElementById('root');
if (!container) {
  throw new Error('missing #root element');
}

createRoot(container).render(
  <TooltipProvider>
    <App />
  </TooltipProvider>,
);
