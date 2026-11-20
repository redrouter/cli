import { catalog, opencodeProvider } from '../src/api.mjs';

/** OpenCode 1.x plugin: register live public model metadata on startup. */
export const RedRouterPlugin = async () => ({
  config: async config => {
    const provider = opencodeProvider(await catalog());
    const existing = config.provider?.redrouter;
    config.provider ??= {};
    config.provider.redrouter = { ...provider, ...existing, models: { ...provider.models, ...existing?.models }, options: { ...provider.options, ...existing?.options } };
  },
});
