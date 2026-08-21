import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchInterval: 30_000,
      retry: (failureCount, error) => {
        const status = (error as { status?: number })?.status;
        if (status === 401) return false;
        return failureCount < 3;
      },
    },
  },
});
