const express = require('express');
const { Client, RemoteAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const admin = require('firebase-admin');
require('dotenv').config();

// --- Configuração do Worker ---
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3001; 

// --- Conexão com Firebase ---
try {
    // Usando a lógica para ler o JSON minificado em uma única linha
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log('[WORKER] Conectado ao Firebase.');
} catch (e) {
    console.error('[WORKER ERROR] Falha ao conectar ao Firebase. Verifique a chave no .env', e);
    process.exit(1); // Para o worker se não conseguir conectar ao DB
}
const db = admin.firestore();

// --- LÓGICA PARA SALVAR A SESSÃO NO FIRESTORE ---
class FirestoreStore {
    constructor() {
        this.sessionRef = db.collection('whatsapp_sessions').doc('auth_session');
    }
    async save(session) {
        console.log('[WORKER STORE] Salvando sessão no Firestore...');
        await this.sessionRef.set(session);
    }
    async sessionExists(session) {
        const doc = await this.sessionRef.get();
        return doc.exists;
    }
    async extract(session) {
        console.log('[WORKER STORE] Tentando extrair sessão do Firestore...');
        const doc = await this.sessionRef.get();
        if (doc.exists) {
            console.log('[WORKER STORE] Sessão encontrada no Firestore.');
            return doc.data();
        }
        console.log('[WORKER STORE] Nenhuma sessão encontrada.');
        return null;
    }
    async delete(session) {
        console.log('[WORKER STORE] Deletando sessão do Firestore...');
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
        args: ['--no-sandbox', '--disable-setuid-sandbox'] // Essencial para rodar no Render
    }
});

// --- Eventos do Cliente WhatsApp ---
client.on('qr', async (qr) => {
    console.log('[WORKER] QR Code recebido. Salvando no Firestore para o painel de admin...');
    try {
        const qrImageUrl = await qrcode.toDataURL(qr);
        await db.collection('whatsapp_status').doc('session').set({
            qrCodeUrl: qrImageUrl,
            status: 'QR_CODE_READY',
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log('[WORKER] QR Code salvo. Escaneie pelo painel de admin.');
    } catch (err) { console.error('[WORKER ERROR] Falha ao gerar ou salvar QR Code:', err); }
});

client.on('ready', async () => {
    console.log('[WORKER] Cliente WhatsApp está pronto e conectado!');
    await db.collection('whatsapp_status').doc('session').set({
        status: 'CONNECTED',
        timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
});

client.on('remote_session_saved', () => {
    console.log('[WORKER] Sessão salva com sucesso no Firestore!');
});

client.on('disconnected', async (reason) => {
    console.log('[WORKER] Cliente foi desconectado:', reason);
    await db.collection('whatsapp_status').doc('session').set({
        status: 'DISCONNECTED',
        timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    client.initialize(); // Tenta reconectar
});

client.initialize().catch(err => console.error('[WORKER ERROR] Falha na inicialização do cliente:', err));

// --- API interna do Worker ---

app.get('/ping', (req, res) => {
    console.log(`[WORKER] Ping recebido em: ${new Date().toISOString()}`);
    res.status(200).json({ status: 'ok', service: 'whatsapp-worker', timestamp: new Date() });
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
            console.error(`[WORKER ERROR] Tentativa de envio para número não registrado no WhatsApp: ${number}`);
            return res.status(404).json({ success: false, error: 'Este número não parece ter WhatsApp.' });
        }

        const chat = await client.getChatById(chatId);
        await chat.sendStateTyping();
        
        const delay = Math.floor(Math.random() * 3000) + 1000; // Atraso de 1 a 4 segundos
        setTimeout(async () => {
            await client.sendMessage(chatId, message);
            console.log(`[WORKER] Mensagem enviada para ${number}`);
            await chat.clearState();
        }, delay);
        
        res.status(200).json({ success: true, message: 'Ordem de envio recebida.' });

    } catch (error) {
        console.error(`[WORKER ERROR] Falha ao processar mensagem para ${number}:`, error);
        res.status(500).json({ success: false, error: 'Falha ao processar a mensagem.' });
    }
});

app.listen(PORT, () => {
    console.log(`[WORKER] Servidor do Worker rodando na porta ${PORT}`);
});
