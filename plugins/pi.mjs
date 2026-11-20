import { catalog, piModel, ORIGIN } from '../src/api.mjs';

export default async function redrouter(pi) {
  pi.registerProvider('redrouter', {
    name: 'RedRouter', baseUrl: `${ORIGIN}/v1`, apiKey: '$REDROUTER_API_KEY',
    api: 'openai-completions', models: (await catalog()).map(piModel),
  });
}
