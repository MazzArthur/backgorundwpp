const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const admin = require('firebase-admin');

// --- Configuração do Worker ---
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3001; // O Worker vai rodar numa porta diferente

// --- Conexão com Firebase (para salvar o QR Code) ---
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log('[WORKER] Conectado ao Firebase.');
} catch (e) {
    console.error('[WORKER ERROR] Falha ao conectar ao Firebase:', e);
}
const db = admin.firestore();

// --- Inicialização do Cliente WhatsApp ---
const client = new Client({
    authStrategy: new LocalAuth(), // Salva a sessão localmente
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'] // Essencial para rodar no Render
    }
});

console.log('[WORKER] Inicializando cliente WhatsApp...');

// Evento: Gerar QR Code
client.on('qr', async (qr) => {
    console.log('[WORKER] QR Code recebido. Salvando no Firestore...');
    try {
        const qrImageUrl = await qrcode.toDataURL(qr);
        await db.collection('whatsapp_status').doc('session').set({
            qrCodeUrl: qrImageUrl,
            status: 'QR_CODE_READY',
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log('[WORKER] QR Code salvo no Firestore. Escaneie pelo painel de admin.');
    } catch (err) {
        console.error('[WORKER ERROR] Falha ao gerar ou salvar QR Code:', err);
    }
});

// Evento: Cliente pronto e conectado
client.on('ready', async () => {
    console.log('[WORKER] Cliente WhatsApp está pronto e conectado!');
    try {
        await db.collection('whatsapp_status').doc('session').set({
            status: 'CONNECTED',
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
    } catch (err) {
        console.error('[WORKER ERROR] Falha ao atualizar status para CONECTADO:', err);
    }
});

// Evento: Desconexão
client.on('disconnected', async (reason) => {
    console.log('[WORKER] Cliente foi desconectado:', reason);
    try {
        await db.collection('whatsapp_status').doc('session').set({
            status: 'DISCONNECTED',
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
    } catch (err) {
        console.error('[WORKER ERROR] Falha ao atualizar status para DESCONECTADO:', err);
    }
    // Tenta reiniciar o cliente
    client.initialize();
});

client.initialize();

// --- API interna do Worker ---
// O servidor principal irá chamar esta rota para enviar uma mensagem
app.post('/send-message', async (req, res) => {
    const { number, message } = req.body;
    if (!number || !message) {
        return res.status(400).json({ error: 'Número e mensagem são obrigatórios.' });
    }

    // Formata o número para o padrão do WhatsApp (ex: 5549999999999@c.us)
    const chatId = `${number.replace(/\D/g, '')}@c.us`;

    try {
        await client.sendMessage(chatId, message);
        console.log(`[WORKER] Mensagem enviada para ${number}`);
        res.status(200).json({ success: true, message: 'Mensagem enviada.' });
    } catch (error) {
        console.error(`[WORKER ERROR] Falha ao enviar mensagem para ${number}:`, error);
        res.status(500).json({ success: false, error: 'Falha ao enviar mensagem.' });
    }
});

app.listen(PORT, () => {
    console.log(`[WORKER] Servidor do Worker rodando na porta ${PORT}`);
});