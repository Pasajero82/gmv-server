const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Groq = require('groq-sdk');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// Inicializamos Groq con la clave que guardamos en Render
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Aquí guardamos el catálogo de películas por sala
const roomCatalogs = {};

app.use(express.static(__dirname));

io.on('connection', (socket) => {
    console.log('✅ Usuario conectado:', socket.id);
    io.emit('update-online-count', io.engine.clientsCount);
    
    socket.on('join-room', (room) => {
        socket.join(room);
        console.log(`👥 Dispositivo unido a la sala: ${room}`);
    });

    // 1. La TV envía su catálogo de películas al conectarse
    socket.on('sync-catalog', (data) => {
        roomCatalogs[data.room] = data.movies;
        console.log(`📚 Catálogo sincronizado para ${data.room}. Total: ${data.movies.length} películas.`);
    });
    
    // 2. El celular le pregunta a MUVIBOT
    socket.on('muvibot-ask', async (data) => {
        const { room, query } = data;
        const catalog = roomCatalogs[room] || [];

        if (catalog.length === 0) {
            io.to(room).emit('muvibot-response', { 
                success: false, 
                message: "Aún estoy cargando el catálogo, espera un momento." 
            });
            return;
        }

        // Preparamos las instrucciones para la IA
        const systemPrompt = `
            Eres MUVIBOT, el asistente de MUVIBOX.
            El usuario te pide: "${query}"
            
            Aquí tienes las ÚNICAS películas disponibles:
            [${catalog.join(', ')}]
            
            Instrucciones:
            1. Responde en español de forma amigable y conversacional.
            2. Si el usuario pide una recomendación, elige UNA película que exista en la lista.
            3. Para que la TV sepa qué reproducir, termina tu respuesta poniendo el TÍTULO EXACTO de la película entre corchetes. Ejemplo: Claro, te recomiendo esta: [Shrek 2].
            4. Si el usuario solo saluda o pregunta algo general, responde sin usar corchetes.
            5. Si no hay coincidencias, sugiere una película aleatoria de la lista.
        `;

        try {
            // Llamada a Groq
            const chatCompletion = await groq.chat.completions.create({
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: query }
                ],
                model: "openai/gpt-oss-120b",
                temperature: 0.7,
                max_tokens: 150,
            });

            const botReply = chatCompletion.choices[0]?.message?.content || "";
            
            // Extraemos el título que la IA puso entre corchetes
            const match = botReply.match(/\[(.*?)\]/);
            let movieToPlay = null;

            if (match) {
                const exactTitle = match[1];
                movieToPlay = catalog.find(t => t.toLowerCase() === exactTitle.toLowerCase());
            }

            // 3. Enviamos la respuesta al celular
            io.to(room).emit('muvibot-response', { 
                success: true, 
                text: botReply.replace(/\[.*?\]/g, '').trim() 
            });

            // 4. Si la película existe, le decimos a la TV que la reproduzca
            if (movieToPlay) {
                io.to(room).emit('muvibot-play', { title: movieToPlay });
            }

        } catch (error) {
            console.error("Error con Groq:", error);
            io.to(room).emit('muvibot-response', { 
                success: false, 
                message: "Lo siento, mis circuitos están fallando. Intenta de nuevo." 
            });
        }
    });
    
    socket.on('enviar-comando', (data) => {
        io.to(data.room).emit('ejecutar-comando', data);
    });
    
    socket.on('disconnect', () => {
        io.emit('update-online-count', io.engine.clientsCount);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor MUVIBOX con Groq corriendo en puerto ${PORT}`);
});
