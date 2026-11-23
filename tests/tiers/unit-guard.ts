import { guardLayer } from './guard.js';

guardLayer({
  layer: 'unit',
  advice: 'it belongs in the component layer: name the file *.component.test.ts',
  refusesProgram: () => true,
  refusesConnection: () => true,
  refusesListening: true,
});
