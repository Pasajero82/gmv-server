const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static(__dirname));

io.on('connection', (socket) => {
    console.log('✅ Usuario conectado:', socket.id);
    
    socket.on('join-room', (room) => {
        socket.join(room);
        console.log(`👥 Dispositivo unido a la sala: ${room}`);
    });

    // Recibe la orden del celular y la retransmite a la TV
    socket.on('muvibot-ask', (data) => {
        console.log(`🔍 Buscando: ${data.query} en la sala ${data.room}`);
        
        // Le dice al celular que está buscando
        io.to(data.room).emit('muvibot-response', { 
            success: true, 
            text: "Buscando..." 
        });
        
        // Le dice a la TV que busque esta película
        io.to(data.room).emit('muvibot-search', { query: data.query });
    });
    
    socket.on('enviar-comando', (data) => {
        io.to(data.room).emit('ejecutar-comando', data);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor MUVIBOX (Modo Búsqueda) en puerto ${PORT}`);
});
