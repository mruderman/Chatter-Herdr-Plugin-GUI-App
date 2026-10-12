import type { ComponentChildren } from 'preact';
import type { Resource } from './use-resource';

export interface ResourceStateProps<T> {
  resource: Resource<readonly T[]>;
  /** Texts for the four states that are not a list, each already a whole sentence. */
  loading: string;
  empty: string;
  adminOnly: string;
  /** Start of the failure sentence; the bridge's message is appended. */
  failed: string;
  children: (items: readonly T[]) => ComponentChildren;
}

// What a list shows instead of rows, always in text: loading, empty, not allowed, failed. A failed
// reload keeps the rows that were already shown and says so above them, so the page never goes blank
// because of one dropped request.
export function ResourceState<T>({ resource, loading, empty, adminOnly, failed, children }: ResourceStateProps<T>) {
  const { data, failure } = resource;
  if (failure?.adminOnly) return <p role="alert" class="alert tone-warning">{adminOnly}</p>;
  const failureNote = failure && (
    <div class="stack">
      <p role="alert" class="alert tone-danger">{`${failed}: ${failure.message}`}</p>
      <div class="cluster">
        <button type="button" onClick={resource.reload}>
          Try again
        </button>
      </div>
    </div>
  );
  if (data === null) return failureNote || <p>{loading}</p>;
  return (
    <>
      {failureNote}
      {data.length === 0 ? <p>{empty}</p> : children(data)}
    </>
  );
}
