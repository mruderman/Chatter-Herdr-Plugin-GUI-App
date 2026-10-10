import { MEMBER_KIND_LABEL, type MemberKind } from './types';

// Human is neutral and computational is tinted, but the label is what carries the meaning.
const KIND_TONE: Readonly<Record<MemberKind, string>> = {
  human: 'tone-neutral',
  computational: 'tone-info',
};

export function KindBadge({ kind }: { kind: MemberKind }) {
  return <span class={`badge ${KIND_TONE[kind]}`}>{MEMBER_KIND_LABEL[kind]}</span>;
}
