import { guardLayer } from './guard.js';

guardLayer({
  layer: 'container',
  advice: 'only the layer\'s global setup starts k3s, k3d, docker or temporal, so the real things start once',
  refusesProgram: (program) => /^(k3s|k3d|docker|temporal.*)$/.test(program),
  refusesConnection: () => false,
  refusesListening: false,
});
