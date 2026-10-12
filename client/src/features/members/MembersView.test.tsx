// The Members view (docs/ui-contract.md section 4): who is in the chat, with each member's kind as a
// badge, and the agents messages can be addressed to. Data is the store's directory.
import { screen, within } from '@testing-library/dom';
import { describe, expect, it } from 'vitest';
import { render } from '../../../test/render';
import { body } from '../../../test/fixtures/recorded';
import { parseDirectory } from '../../api/guards';
import type { Directory } from '../../api/types';
import { expectNoAxeViolations } from '../shell/test-utils';
import { MembersView } from './MembersView';

/** The directory the bridge sent in the recording, through the guards. */
const recorded = (): Directory => parseDirectory(body('directory'));

function show(directory: Directory | null): HTMLElement {
  // The shell supplies <main>.
  return render(
    <main>
      <MembersView directory={directory} />
    </main>,
  );
}

const memberItems = (): HTMLElement[] => within(screen.getByRole('list', { name: 'Members' })).getAllByRole('listitem');

describe('Members view: structure (ui-contract sections 2 and 4)', () => {
  it('has one h1, "Members", and an h2, "Agents", for the second list', () => {
    show(recorded());
    expect(screen.getAllByRole('heading', { level: 1 }).map((heading) => heading.textContent)).toEqual(['Members']);
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual(['Agents']);
  });

  it('has a list named "Members" and a list named "Agents", and no other list', () => {
    show(recorded());
    expect(screen.getAllByRole('list').map((list) => list.getAttribute('aria-label'))).toEqual(['Members', 'Agents']);
  });
});

describe('Members view: the recorded directory', () => {
  it('lists every member in the order the bridge sent, as "name (handle)" and a kind badge', () => {
    show(recorded());
    expect(memberItems().map((item) => item.textContent)).toEqual([
      'flan (flan) Human',
      'Thom (thom) Computational',
      'Mira (mira) Human',
      'Ezra (ezra) Human',
      'Kieran (kieran) Computational',
      'Grace (grace) Computational',
      'Temporary (temp) Computational',
    ]);
  });

  it('shows the kind as the text "Human" or "Computational" in the shell\'s badge, so it is never colour alone', () => {
    show(recorded());
    for (const item of memberItems()) {
      const badge = item.querySelector('.badge');
      expect(badge, item.textContent ?? '').toBeTruthy();
      expect(['Human', 'Computational']).toContain(badge?.textContent);
    }
  });

  it('lists the agents by name', () => {
    show(recorded());
    const items = within(screen.getByRole('list', { name: 'Agents' })).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual(['codex']);
  });

  it('says what agents are, without a claim beyond the SPEC', () => {
    show(recorded());
    expect(screen.getByText(/^Agents run in Herdr\./)).toBeTruthy();
  });

  it('never says "bot"', () => {
    const container = show(recorded());
    expect(container.textContent).not.toMatch(/\bbot\b/i);
  });
});

describe('Members view: loading and empty', () => {
  it('says it is loading while the directory is null, with no list', () => {
    show(null);
    const loading = screen.getByText('Loading the member list');
    expect(loading.getAttribute('role')).toBe('status');
    expect(screen.queryAllByRole('list')).toEqual([]);
    expect(screen.getByRole('heading', { level: 1, name: 'Members' })).toBeTruthy();
  });

  it('says so in text when there are no members and no agents', () => {
    show({ members: [], agents: [] });
    expect(screen.getByText('There are no members to show.')).toBeTruthy();
    expect(screen.getByText('No agents are known yet.')).toBeTruthy();
    expect(screen.queryAllByRole('list')).toEqual([]);
  });

  it('shows members without agents, and agents without members', () => {
    const container = show({ members: [{ handle: 'ana', display_name: 'Ana', kind: 'human' }], agents: [] });
    expect(memberItems().map((item) => item.textContent)).toEqual(['Ana (ana) Human']);
    expect(screen.getByText('No agents are known yet.')).toBeTruthy();
    expect(container.querySelectorAll('ul')).toHaveLength(1);
  });
});

describe('Members view: every field is plain text', () => {
  const markup = '<img src=x onerror="window.__membersPwned = true"><script>window.__membersPwned = true</script><b>bold</b> https://example.com/pic.png';

  it('shows markup in a name, a handle or an agent literally and creates no element from it', () => {
    const container = show({
      members: [{ handle: `${markup} handle`, display_name: `${markup} name`, kind: 'computational' }],
      agents: [`${markup} agent`],
    });
    expect(container.textContent).toContain(`${markup} name`);
    expect(container.textContent).toContain(`${markup} handle`);
    expect(container.textContent).toContain(`${markup} agent`);
    expect(container.querySelectorAll('img, script, b, a, iframe, object, embed, svg, link, style')).toHaveLength(0);
    expect(Reflect.get(window, '__membersPwned')).toBeUndefined();
  });
});

describe('Members view: follows the directory', () => {
  it('shows a member who was added, and drops one who was revoked, when the directory changes', async () => {
    const { render: preactRender } = await import('preact');
    const { act } = await import('preact/test-utils');
    const container = show({ members: [{ handle: 'ana', display_name: 'Ana', kind: 'human' }], agents: [] });
    expect(memberItems()).toHaveLength(1);
    act(() => {
      preactRender(
        <main>
          <MembersView
            directory={{
              members: [
                { handle: 'ana', display_name: 'Ana', kind: 'human' },
                { handle: 'kit', display_name: 'Kit', kind: 'computational' },
              ],
              agents: ['codex'],
            }}
          />
        </main>,
        container,
      );
    });
    expect(memberItems().map((item) => item.textContent)).toEqual(['Ana (ana) Human', 'Kit (kit) Computational']);
    expect(within(screen.getByRole('list', { name: 'Agents' })).getAllByRole('listitem')).toHaveLength(1);
    act(() => {
      preactRender(
        <main>
          <MembersView directory={{ members: [{ handle: 'kit', display_name: 'Kit', kind: 'computational' }], agents: [] }} />
        </main>,
        container,
      );
    });
    expect(memberItems().map((item) => item.textContent)).toEqual(['Kit (kit) Computational']);
  });
});

describe('Members view: accessibility', () => {
  it('has no axe violations (structural rules) with the recorded directory', async () => {
    show(recorded());
    await expectNoAxeViolations();
  });

  it('has no axe violations while loading, and when empty', async () => {
    show(null);
    await expectNoAxeViolations();
  });

  it('has no axe violations with no members and no agents', async () => {
    show({ members: [], agents: [] });
    await expectNoAxeViolations();
  });

  it('is plain content: nothing in it is focusable', () => {
    const container = show(recorded());
    expect(container.querySelectorAll('a, button, input, select, textarea, [tabindex]')).toHaveLength(0);
  });
});
