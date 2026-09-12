import { RouterProvider } from '@tanstack/react-router';
import { API_BASE } from './api/client';
import { router as defaultRouter, createProvisioningRouter } from './router';

export { API_BASE };

export default function App({ router }: { router?: ReturnType<typeof createProvisioningRouter> }) {
  return <RouterProvider router={router ?? defaultRouter} />;
}
