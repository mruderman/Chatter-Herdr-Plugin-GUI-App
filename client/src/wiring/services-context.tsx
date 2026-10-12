// Hands the services to the views. The registry's views take no props (ViewDefinition.component), so
// the ones that need more than the store, such as the Board's Api and clock, read them from here.
import { createContext, type ComponentChildren, type JSX } from 'preact';
import { useContext } from 'preact/hooks';
import { StoreProvider } from '../state/provider';
import type { Services } from './services';

const ServicesContext = createContext<Services | null>(null);

export interface ServicesProviderProps {
  readonly services: Services;
  readonly children?: ComponentChildren;
}

/** Provides the services and, for useStore and useSnapshot, their store. */
export function ServicesProvider({ services, children }: ServicesProviderProps): JSX.Element {
  return (
    <StoreProvider store={services.store}>
      <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>
    </StoreProvider>
  );
}

export function useServices(): Services {
  const services = useContext(ServicesContext);
  if (!services) throw new Error('useServices() needs a ServicesProvider above it');
  return services;
}
