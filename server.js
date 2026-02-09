const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.static(__dirname));

io.on('connection', (socket) => {
    console.log('✅ Usuario conectado:', socket.id);
    
    // Enviar número de usuarios online a TODOS
    io.emit('update-online-count', io.engine.clientsCount);
    
    // Escuchar cuando alguien (TV o Control) quiere entrar a una sala
    socket.on('join-room', (room) => {
        socket.join(room);
        console.log(`👥 Dispositivo unido a la sala: ${room}`);
    });
    
    // Escuchar comandos y enviarlos SOLO a la sala correspondiente
    socket.on('enviar-comando', (data) => {
        console.log(`🎮 Comando [${data.cmd}] para la sala: ${data.room}`);
        io.to(data.room).emit('ejecutar-comando', data);
    });
    
    socket.on('disconnect', () => {
        console.log('❌ Dispositivo desconectado:', socket.id);
        // Actualizar contador cuando se desconecta
        io.emit('update-online-count', io.engine.clientsCount);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor GMV corriendo en puerto ${PORT}`);
});
