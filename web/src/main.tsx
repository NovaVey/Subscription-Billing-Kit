import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';
import './index.css';
import { Layout } from './components/Layout';
import { ToastProvider } from './components/Toast';
import { SubscriptionsListPage } from './pages/SubscriptionsListPage';
import { SubscriptionDetailPage } from './pages/SubscriptionDetailPage';
import { DunningQueuePage } from './pages/DunningQueuePage';
import { InvoicesPage } from './pages/InvoicesPage';
import { WebhookLogPage } from './pages/WebhookLogPage';
import { ReconciliationPage } from './pages/ReconciliationPage';

const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <Navigate to="/subscriptions" replace /> },
      { path: 'subscriptions', element: <SubscriptionsListPage /> },
      { path: 'subscriptions/:id', element: <SubscriptionDetailPage /> },
      { path: 'dunning', element: <DunningQueuePage /> },
      { path: 'invoices', element: <InvoicesPage /> },
      { path: 'webhook-events', element: <WebhookLogPage /> },
      { path: 'reconciliation', element: <ReconciliationPage /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>
  </StrictMode>,
);
