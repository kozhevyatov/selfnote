import { useEffect, useState } from 'react';
import { ActivityIndicator, Text } from 'react-native';
import type { Workspace } from '../sync/workspace';
import { fonts, useTheme } from '../theme';
import { PasswordEditor } from './PasswordEditor';
import { VaultGate } from './VaultGate';

/** Запись хранилища паролей: мастер-пароль → расшифровка ключом хранилища → редактор. */
export function PasswordsNote({ workspace, id }: { workspace: Workspace; id: string }) {
  const { c } = useTheme();
  const [error, setError] = useState('');
  const unlocked = workspace.vault.unlocked;
  const open = workspace.secure.isUnlocked(id);
  useEffect(() => {
    if (!unlocked || open) return;
    setError('');
    workspace.vault.open(id).catch((e: Error) => setError(e.message));
  }, [unlocked, open, id, workspace]);
  if (!unlocked) return <VaultGate workspace={workspace} />;
  const doc = workspace.secure.doc(id);
  if (!doc)
    return error ? (
      <Text style={{ fontFamily: fonts.medium, fontSize: 16, color: c.secondary, textAlign: 'center', padding: 40 }}>
        {error}
      </Text>
    ) : (
      <ActivityIndicator style={{ marginTop: 40 }} />
    );
  return <PasswordEditor key={doc.guid} workspace={workspace} id={id} doc={doc} />;
}
