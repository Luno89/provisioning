import { io } from 'socket.io-client';

const socket = io('http://localhost');

socket.on('device:wake', () => {
  socket.emit('device:awake', {});
});
