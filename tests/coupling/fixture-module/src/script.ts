import { shout } from './shout.js';

const said = shout('hello');
console.log(said);

if (said === 'never') console.log(shout('again'));
