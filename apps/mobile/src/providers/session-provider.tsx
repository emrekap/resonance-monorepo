import type { Session } from '@supabase/supabase-js';
import { createContext, useContext, useEffect, useState, type PropsWithChildren } from 'react';

import { supabase } from '@/lib/supabase';

interface SessionContextValue {
  session: Session | null;
  /** True until the persisted session (if any) has been read from storage. */
  isLoading: boolean;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

/**
 * Owns the one piece of client auth state: the Supabase session. Everything
 * downstream — the `Stack.Protected` guards in the root layout, the RPC
 * client's bearer token — derives from it, so login/logout is just this state
 * flipping and the router reacting.
 */
export function SessionProvider({ children }: PropsWithChildren) {
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setIsLoading(false);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });
    return () => subscription.subscription.unsubscribe();
  }, []);

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <SessionContext.Provider value={{ session, isLoading, signOut }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside <SessionProvider>');
  return value;
}
