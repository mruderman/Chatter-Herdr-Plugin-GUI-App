// Every role and accessible name from docs/ui-contract.md that the specs select on, defined once.
// The specs were written blind (no UI source read), so this file is the whole of what they assume.
import type { Locator, Page } from '@playwright/test';

export const UI = {
  signIn: { heading: 'Sign in', token: 'Access token', submit: 'Sign in', failurePrefix: 'Sign-in failed: ' }, // section 1
  skipToMessages: 'Skip to messages', // section 2
  skipToComposer: 'Skip to message box',
  appName: 'Chatter',
  repository: 'Repository',
  connection: 'Connection',
  status: { online: 'Online', syncing: 'Syncing', offline: 'Offline', revoked: 'Access revoked' },
  kind: { human: 'Human', computational: 'Computational', agent: 'Agent' },
  settings: 'Settings',
  primaryNav: 'Primary',
  views: { chat: 'Chat', board: 'Board', members: 'Members', admin: 'Admin' },
  conversationsNav: 'Conversations', // section 3
  channel: '#chat',
  feed: 'Messages',
  composer: 'Message composer',
  messageBox: 'Message',
  recipient: 'To',
  send: 'Send',
  suggestions: 'Mention suggestions',
  sendError: 'Send error',
  sendErrorPrefix: 'Not sent: ',
  label: { mentionsYou: 'Mentions you', direct: 'Direct message', adminView: 'Admin view' },
  admin: { addMember: 'Add member', membersTable: 'Members', auditTable: 'Audit log', newTokenPrefix: 'New token for ' }, // section 4
  settingsDialog: { theme: 'Theme', close: 'Close' },
  theme: { light: 'light', dark: 'dark', hc: 'hc' }, // section 6: values of data-theme on <html>
} as const;

export const dmWith = (handle: string): string => `DM with ${handle}`;
/** An admin's button for a DM between two others: one button, the handles in alphabetical order (no direction). */
export const adminDm = (a: string, b: string): string => `DM ${[a, b].sort().join(' to ')}`;
export const memberIdentity = (displayName: string, handle: string): string => `${displayName} (${handle})`;
export const suggestion = (name: string, kindLabel: string): string => `${name} (${kindLabel})`;

export const ui = {
  signInHeading: (p: Page): Locator => p.getByRole('heading', { level: 1, name: UI.signIn.heading, exact: true }),
  tokenField: (p: Page): Locator => p.getByLabel(UI.signIn.token, { exact: true }),
  signInButton: (p: Page): Locator => p.getByRole('button', { name: UI.signIn.submit, exact: true }),
  // Found by its text, not by being the only alert: an app may keep an empty alert region mounted.
  signInError: (p: Page): Locator => p.getByRole('alert').filter({ hasText: UI.signIn.failurePrefix }),

  skipToMessages: (p: Page): Locator => p.getByRole('link', { name: UI.skipToMessages, exact: true }),
  skipToComposer: (p: Page): Locator => p.getByRole('link', { name: UI.skipToComposer, exact: true }),
  banner: (p: Page): Locator => p.getByRole('banner'),
  main: (p: Page): Locator => p.getByRole('main'),
  repository: (p: Page): Locator => p.getByRole('combobox', { name: UI.repository, exact: true }),
  connection: (p: Page): Locator => p.getByRole('status', { name: UI.connection, exact: true }),
  settingsButton: (p: Page): Locator => ui.banner(p).getByRole('button', { name: UI.settings, exact: true }),
  primaryNav: (p: Page): Locator => p.getByRole('navigation', { name: UI.primaryNav, exact: true }),
  viewButton: (p: Page, name: string): Locator => ui.primaryNav(p).getByRole('button', { name, exact: true }),
  viewHeading: (p: Page, name: string): Locator => ui.main(p).getByRole('heading', { level: 1, name, exact: true }),

  conversations: (p: Page): Locator => p.getByRole('navigation', { name: UI.conversationsNav, exact: true }),
  conversation: (p: Page, name: string | RegExp): Locator => ui.conversations(p).getByRole('button', { name, exact: true }),
  feed: (p: Page): Locator => p.getByRole('log', { name: UI.feed, exact: true }),
  composer: (p: Page): Locator => p.getByRole('form', { name: UI.composer, exact: true }),
  // By label, not role: the textarea's role is combobox while suggestions show (section 3).
  messageBox: (p: Page): Locator => ui.composer(p).getByLabel(UI.messageBox, { exact: true }),
  recipient: (p: Page): Locator => ui.composer(p).getByLabel(UI.recipient, { exact: true }),
  sendButton: (p: Page): Locator => ui.composer(p).getByRole('button', { name: UI.send, exact: true }),
  suggestions: (p: Page): Locator => p.getByRole('listbox', { name: UI.suggestions, exact: true }),
  sendError: (p: Page): Locator => p.getByRole('alert', { name: UI.sendError, exact: true }),

  dialog: (p: Page, name: string | RegExp): Locator => p.getByRole('dialog', { name, exact: true }),
  // The contract names the Settings dialog's controls but not the dialog itself, so it is found by its Theme select.
  settingsDialog: (p: Page): Locator => p.getByRole('dialog').filter({ has: p.getByLabel(UI.settingsDialog.theme, { exact: true }) }),
};
