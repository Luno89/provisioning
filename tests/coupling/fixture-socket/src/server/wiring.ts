import { Server } from 'socket.io';
import { notifyGreeted } from './notify.js';

const TOKEN = 'token:sent' as const;
const io = new Server();
export const greet = notifyGreeted(io);

io.on('connection', (socket) => {
  socket.on('hello', (name: string) => { greet(name); });
  socket.emit('unheard', {});
  socket.use((packet, next) => {
    if (packet[0] === TOKEN) greet('token');
    next();
  });
});
