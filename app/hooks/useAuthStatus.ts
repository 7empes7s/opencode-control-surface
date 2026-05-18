import { useEffect, useState } from "react";

interface AuthStatus {
  configured: boolean;
  authenticated: boolean;
  devBypass: boolean;
}

export function useAuthStatus() {
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchAuthStatus = async () => {
      try {
        const response = await fetch("/api/auth/status");
        const data = await response.json();
        setAuthStatus(data);
      } catch (error) {
        console.error("Failed to fetch auth status:", error);
        setAuthStatus({ configured: false, authenticated: false, devBypass: false });
      } finally {
        setLoading(false);
      }
    };

    fetchAuthStatus();
  }, []);

  return { authStatus, loading };
}