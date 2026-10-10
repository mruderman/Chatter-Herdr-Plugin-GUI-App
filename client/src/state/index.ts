// What the app takes from src/state: the real store, the Preact glue and the contract's types.
// The fake store (fake.ts) and the scripted bridge (fake-api.ts) are for tests and stay out of it.
export { createStore, type StoreOptions } from './store';
export { StoreProvider, useSnapshot, useStore, type StoreProviderProps } from './provider';
export * from './types';
