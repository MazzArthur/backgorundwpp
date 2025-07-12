const express = require('express');
const { Client, RemoteAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3001; 

// --- Conexão com Firebase (Lógica Corrigida) ---
try {
    // Lê o JSON minificado diretamente da variável de ambiente
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log('[WORKER] Conectado ao Firebase.');
} catch (e) {
    console.error('[WORKER ERROR] Falha ao conectar ao Firebase. Verifique a chave no .env', e);
    process.exit(1);
}
const db = admin.firestore();

// --- Lógica para Salvar a Sessão no Firestore ---
class FirestoreStore {
    constructor() {
        this.sessionRef = db.collection('whatsapp_sessions').doc('auth_session');
    }
    async save(session) {
        await this.sessionRef.set(session);
    }
    async sessionExists() {
        const doc = await this.sessionRef.get();
        return doc.exists;
    }
    async extract() {
        const doc = await this.sessionRef.get();
        return doc.exists ? doc.data() : null;
    }
    async delete() {
        await this.sessionRef.delete();
    }
}
const store = new FirestoreStore();

// --- Inicialização do Cliente WhatsApp ---
console.log('[WORKER] Inicializando cliente WhatsApp com RemoteAuth...');
const client = new Client({
    authStrategy: new RemoteAuth({
        store: store,
        backupSyncIntervalMs: 300000 // Salva a sessão a cada 5 minutos
    }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

// --- Eventos do Cliente WhatsApp ---
client.on('qr', async (qr) => {
    console.log('[WORKER] QR Code recebido. Salvando no Firestore...');
    try {
        const qrImageUrl = await qrcode.toDataURL(qr);
        await db.collection('whatsapp_status').doc('session').set({
            qrCodeUrl: qrImageUrl,
            status: 'QR_CODE_READY',
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
    } catch (err) { console.error('[WORKER ERROR] Falha ao salvar QR Code:', err); }
});

client.on('ready', async () => {
    console.log('[WORKER] Cliente WhatsApp está pronto e conectado!');
    await db.collection('whatsapp_status').doc('session').set({ status: 'CONNECTED' });
});

client.on('remote_session_saved', () => {
    console.log('[WORKER] Sessão salva com sucesso no Firestore!');
});

client.on('disconnected', async (reason) => {
    console.log('[WORKER] Cliente foi desconectado:', reason);
    await db.collection('whatsapp_status').doc('session').set({ status: 'DISCONNECTED' });
    client.initialize(); // Tenta reconectar
});

client.initialize().catch(err => console.error('[WORKER ERROR] Falha na inicialização do cliente:', err));


// --- API interna do Worker ---
app.get('/ping', (req, res) => {
    console.log(`[WORKER] Ping recebido em: ${new Date().toISOString()}`);
    res.status(200).json({ status: 'ok', service: 'whatsapp-worker' });
});

app.post('/send-message', async (req, res) => {
    const { number, message } = req.body;
    if (!number || !message) {
        return res.status(400).json({ error: 'Número e mensagem são obrigatórios.' });
    }
    const chatId = `${number.replace(/\D/g, '')}@c.us`;
    try {
        const isRegistered = await client.isRegisteredUser(chatId);
        if (!isRegistered) {
            return res.status(404).json({ success: false, error: 'Este número não parece ter WhatsApp.' });
        }
        const chat = await client.getChatById(chatId);
        await chat.sendStateTyping();
        const delay = Math.floor(Math.random() * 3000) + 1000;
        setTimeout(async () => {
            await client.sendMessage(chatId, message);
            await chat.clearState();
        }, delay);
        res.status(200).json({ success: true, message: 'Ordem de envio recebida.' });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Falha ao processar a mensagem.' });
    }
});

app.listen(PORT, () => {
    console.log(`[WORKER] Servidor do Worker rodando na porta ${PORT}`);
});
