// The failing reproductions of the exploratory pass's findings (docs/runbooks/exploratory-pass.md). They are kept out of the
// default run so that `npm run e2e` stays green: each one fails on the current code for the reason it names. Run them with
// `npm run e2e:pending`; when a finding is fixed, move its spec into e2e/ (fix its imports) so that it guards the fix.
import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({ ...base, testDir: 'e2e-pending' });
