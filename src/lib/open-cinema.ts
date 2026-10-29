import type { AddonManifest, MediaItem, Stream } from './contracts';

export const OPEN_CINEMA_URL = 'vela://open-cinema/manifest.json';

export const openCinemaManifest: AddonManifest = {
  id: 'com.vela.open-cinema',
  name: 'Open Cinema',
  version: '1.0.0',
  description: 'Tráilers abiertos de Blender Foundation, con ilustraciones originales de Vela. Los créditos y la licencia están en la descripción de cada título.',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie'],
  idPrefixes: ['vela:'],
  catalogs: [{
    id: 'open-films',
    type: 'movie',
    name: 'Open Cinema',
    extra: [
      { name: 'search' },
      { name: 'genre', options: ['Animation', 'Adventure', 'Fantasy'] },
      { name: 'skip' },
    ],
  }],
};

export const openCinemaFilms: MediaItem[] = [
  {
    id: 'vela:big-buck-bunny',
    type: 'movie',
    name: 'Big Buck Bunny · Tráiler',
    poster: '/art/open-cinema-bunny.svg',
    background: '/art/open-cinema-bunny.svg',
    description: 'Tráiler de demostración, alojado por W3C, del cortometraje animado sobre un conejo gigante y tres animales traviesos. No es la película completa. Dirigido por Sacha Goedegebure. © 2008 Blender Foundation / www.bigbuckbunny.org. Creative Commons Attribution 3.0 (https://creativecommons.org/licenses/by/3.0/). Ilustración del cartel: Vela.',
    releaseInfo: '2008',
    released: '2008-04-10T00:00:00.000Z',
    runtime: '1 min · Tráiler',
    genres: ['Animation', 'Adventure'],
    director: ['Sacha Goedegebure'],
  },
  {
    id: 'vela:sintel',
    type: 'movie',
    name: 'Sintel · Tráiler',
    poster: '/art/open-cinema-sintel.svg',
    background: '/art/open-cinema-sintel.svg',
    description: 'Tráiler de demostración, alojado por W3C, de la aventura de una joven que busca al pequeño dragón que rescató. No es la película completa. Dirigido por Colin Levy. © 2010 Blender Foundation / durian.blender.org. Creative Commons Attribution 3.0 (https://creativecommons.org/licenses/by/3.0/). Ilustración del cartel: Vela.',
    releaseInfo: '2010',
    released: '2010-09-27T00:00:00.000Z',
    runtime: '1 min · Tráiler',
    genres: ['Animation', 'Adventure', 'Fantasy'],
    director: ['Colin Levy'],
  },
];

export function openCinemaStreams(id: string): Stream[] {
  const folder = {
    'vela:big-buck-bunny': 'bunny',
    'vela:sintel': 'sintel',
  }[id];
  if (!folder) return [];
  return [{
    name: 'Open Cinema · Tráiler MP4',
    description: 'Tráiler de Blender Foundation · CC BY 3.0 · W3C',
    url: `https://media.w3.org/2010/05/${folder}/trailer.mp4`,
  }];
}
