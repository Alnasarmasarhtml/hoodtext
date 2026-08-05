import { QueryClient, isServer } from '@tanstack/react-query';

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Chain and relay reads are cheap but not free; a short stale window
        // keeps panels responsive without hammering the RPC.
        staleTime: 15_000,
        gcTime: 5 * 60_000,
        retry: 2,
        retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 8_000),
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: 0,
      },
    },
  });
}

let browserQueryClient: QueryClient | undefined;

/**
 * One client per request on the server, one shared client in the browser —
 * a module-level singleton would leak one user's cache into another's response.
 */
export function getQueryClient(): QueryClient {
  if (isServer) return makeQueryClient();
  browserQueryClient ??= makeQueryClient();
  return browserQueryClient;
}
