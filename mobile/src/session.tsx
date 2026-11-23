import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { currentAccount, loadAccount, onAccountChange, type Account } from './auth';
import { LocalStore } from './sync/localStore';
import { Workspace } from './sync/workspace';

type Session =
  | { status: 'loading' }
  | { status: 'signedOut' }
  | { status: 'signedIn'; account: Account; workspace: Workspace | null };

const SessionContext = createContext<Session>({ status: 'loading' });

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState<Account | null | undefined>(undefined);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);

  useEffect(() => {
    void loadAccount().then((loaded) => setAccount(currentAccount() ?? loaded));
    return onAccountChange(setAccount);
  }, []);

  // Рабочее пространство живёт, пока вошёл тот же пользователь на том же сервере.
  const key = account ? `${account.server}|${account.user.id}` : '';
  useEffect(() => {
    if (!account) return;
    let created: Workspace | null = null;
    let cancelled = false;
    void LocalStore.open(account.server, account.user.id).then((store) => {
      if (cancelled) return void store.close();
      created = new Workspace(account.server, account.user.id, store);
      setWorkspace(created);
    });
    return () => {
      cancelled = true;
      setWorkspace(null);
      void created?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    if (!workspace) return;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') workspace.wake();
      else void workspace.persist();
      // «inactive» бывает и при открытой галерее — закрываем только при настоящем уходе в фон
      if (state === 'background') workspace.lockSecure();
    });
    return () => subscription.remove();
  }, [workspace]);

  const value: Session =
    account === undefined
      ? { status: 'loading' }
      : account === null
        ? { status: 'signedOut' }
        : { status: 'signedIn', account, workspace };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  return useContext(SessionContext);
}
export function useWorkspaceOptional(): Workspace | null {
  const session = useContext(SessionContext);
  const workspace = session.status === 'signedIn' ? session.workspace : null;
  useSyncExternalStore(
    workspace?.subscribe ?? noopSubscribe,
    workspace?.getRevision ?? zero,
  );
  return workspace;
}
/** Рабочее пространство; компонент перерисовывается при любых изменениях данных. */
export function useWorkspace(): Workspace {
  const workspace = useWorkspaceOptional();
  if (!workspace) throw new Error('Рабочее пространство ещё не открыто');
  return workspace;
}
const noopSubscribe = () => () => undefined;
const zero = () => 0;
