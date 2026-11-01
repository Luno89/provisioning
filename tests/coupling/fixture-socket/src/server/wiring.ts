import { Server } from 'socket.io';
import { notifyGreeted } from './notify.js';

const io = new Server();
export const greet = notifyGreeted(io);

io.on('connection', (socket) => {
  socket.on('hello', (name: string) => { greet(name); });
  socket.emit('unheard', {});
});
