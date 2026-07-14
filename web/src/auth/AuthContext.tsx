import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  fetchMe,
  logoutRequest,
  type AuthUser,
} from "../api/auth";

export type AuthStatus = "loading" | "authed" | "anon";

type AuthContextValue = {
  user: AuthUser | null;
  isAdmin: boolean;
  status: AuthStatus;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [status, setStatus] = useState<AuthStatus>("loading");

  const refresh = useCallback(async () => {
    try {
      const me = await fetchMe();
      if (me === null) {
        setUser(null);
        setIsAdmin(false);
        setStatus("anon");
        return;
      }
      setUser(me.user);
      setIsAdmin(me.isAdmin);
      setStatus("authed");
    } catch {
      setUser(null);
      setIsAdmin(false);
      setStatus("anon");
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await logoutRequest();
    } finally {
      setUser(null);
      setIsAdmin(false);
      setStatus("anon");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({ user, isAdmin, status, refresh, logout }),
    [user, isAdmin, status, refresh, logout],
  );

  return (
    <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx === null) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
