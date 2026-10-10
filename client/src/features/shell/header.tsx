import { useId } from 'preact/hooks';
import { ConnectionStatusBadge } from './connection-status';
import { KindBadge } from './kind-badge';
import type { ConnectionStatus, RepoOption, ShellMember } from './types';

export interface HeaderWorkspace {
  member: ShellMember;
  repos: readonly RepoOption[];
  repoKey: string | null;
  onSelectRepo: (key: string) => void;
  connection: ConnectionStatus;
}

export interface HeaderProps {
  onOpenSettings: () => void;
  /** Absent before sign-in: the header then shows only the name and Settings. */
  workspace?: HeaderWorkspace;
}

function RepoSelect({ repos, repoKey, onSelectRepo }: Pick<HeaderWorkspace, 'repos' | 'repoKey' | 'onSelectRepo'>) {
  const id = useId();
  return (
    <div class="app-header__repo">
      <label for={id}>Repository</label>
      <select id={id} value={repoKey ?? undefined} disabled={repos.length === 0} onChange={(event) => onSelectRepo(event.currentTarget.value)}>
        {repos.length === 0 ? (
          <option value="">No repositories</option>
        ) : (
          repos.map((repo) => (
            <option key={repo.key} value={repo.key}>
              {repo.label}
            </option>
          ))
        )}
      </select>
    </div>
  );
}

export function Header({ onOpenSettings, workspace }: HeaderProps) {
  return (
    <header class="app-header">
      <span class="app-header__name">Chatter</span>
      {workspace && (
        <>
          <RepoSelect repos={workspace.repos} repoKey={workspace.repoKey} onSelectRepo={workspace.onSelectRepo} />
          <ConnectionStatusBadge status={workspace.connection} />
          <div class="app-header__member">
            <span>{`${workspace.member.displayName} (${workspace.member.handle})`}</span>
            <KindBadge kind={workspace.member.kind} />
          </div>
        </>
      )}
      <button type="button" class="app-header__settings" aria-haspopup="dialog" onClick={onOpenSettings}>
        Settings
      </button>
    </header>
  );
}
