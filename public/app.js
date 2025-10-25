// Top-level constants and state
const socket = io();

const generateBtn = document.getElementById('generateBtn');
const connectBtn = document.getElementById('connectBtn');
const logoutBtn = document.getElementById('logoutBtn');
const codeInput = document.getElementById('codeInput');
const chat = document.getElementById('chat');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const connectedStatus = document.getElementById('connectedStatus');
const copyBtn = document.getElementById('copyBtn');
const typingIndicator = document.getElementById('typingIndicator');
const themeToggle = document.getElementById('themeToggle');
const attachBtn = document.getElementById('attachBtn');
const mediaPickerBtn = document.getElementById('mediaPickerBtn');
const mediaPickerMenu = document.getElementById('mediaPickerMenu');
const photoOption = document.getElementById('photoOption');
const videoOption = document.getElementById('videoOption');
const documentOption = document.getElementById('documentOption');
const fileInput = document.getElementById('fileInput');

let roomCode = null;
let salt = null;         // Base64 string
let aesKey = null;       // CryptoKey
let connected = false;
let participants = 1;    // local guess; updated via presence
let typingTimeout = null;
let mediaPickerOpen = false;

// UI helpers
function addSys(msg) { addBubble(msg, 'sys'); }
function addMine(msg) { addBubble(msg, 'mine', true); }
function addTheirs(msg) { addBubble(msg, 'theirs'); }
function addBubble(text, cls, showTs = false) {
    const wrapper = document.createElement('div');
    wrapper.className = `bubble ${cls}`;
    const content = document.createElement('div');
    content.textContent = text;
    wrapper.appendChild(content);
    if (showTs) {
        const ts = document.createElement('span');
        ts.className = 'timestamp';
        ts.textContent = new Date().toLocaleTimeString();
        wrapper.appendChild(ts);
    }
    chat.appendChild(wrapper);
    chat.scrollTop = chat.scrollHeight;
}

function setConnectedState(state, codeShown) {
    connected = state;
    const statusSuffix = state ? `code: ${codeShown}${participants ? ` • users: ${participants}` : ''}` : '';
    connectedStatus.textContent = state ? `Connected (${statusSuffix})` : 'Not connected';
    logoutBtn.disabled = !state;
    messageInput.disabled = !state;
    sendBtn.disabled = !state;
    attachBtn.disabled = !state;
    mediaPickerBtn.disabled = !state;
}

// Crypto helpers
function randomCode(length = 10) {
    // Base36 uppercase, cryptographically random
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    let out = '';
    for (let b of bytes) out += alphabet[b % alphabet.length];
    return out;
}

function genSaltB64() {
    const s = new Uint8Array(16);
    crypto.getRandomValues(s);
    return bufToBase64(s.buffer);
}

async function deriveAesKeyFromCode(code, saltB64) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        'raw', enc.encode(code),
        { name: 'PBKDF2' }, false, ['deriveKey']
    );
    const key = await crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: base64ToBuf(saltB64),
            iterations: 100000,
            hash: 'SHA-256'
        },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
    return key;
}

async function encryptText(key, text) {
    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);
    const enc = new TextEncoder();
    const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        enc.encode(text)
    );
    return { ivB64: bufToBase64(iv.buffer), ciphertextB64: bufToBase64(ciphertext) };
}

async function decryptText(key, ivB64, ciphertextB64) {
    const iv = new Uint8Array(base64ToBuf(ivB64));
    const plaintextBuf = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        base64ToBuf(ciphertextB64)
    );
    const dec = new TextDecoder();
    return dec.decode(plaintextBuf);
}

// Base64 helpers (ArrayBuffer <-> Base64)
function bufToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}
function base64ToBuf(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

// File encryption/decryption helpers
async function encryptFile(key, file) {
    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);
    
    const arrayBuffer = await file.arrayBuffer();
    const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        arrayBuffer
    );
    
    return { 
        ivB64: bufToBase64(iv.buffer), 
        ciphertextB64: bufToBase64(ciphertext),
        fileName: file.name,
        fileType: file.type,
        fileSize: file.size
    };
}

async function decryptFile(key, ivB64, ciphertextB64, fileName, fileType) {
    const iv = new Uint8Array(base64ToBuf(ivB64));
    const plaintextBuf = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        base64ToBuf(ciphertextB64)
    );
    
    return new File([plaintextBuf], fileName, { type: fileType });
}

// Format file size for display
function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    else if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    else return (bytes / 1048576).toFixed(1) + ' MB';
}

// Typing indicator helpers
function showTyping() {
    typingIndicator.innerHTML = '<span>Partner is typing </span><span class="dot"></span><span class="dot"></span><span class="dot"></span>';
}
function hideTyping() {
    typingIndicator.textContent = '';
}

// Socket handlers: receive encrypted messages
socket.on('message', async ({ ivB64, ciphertextB64 }) => {
    if (!aesKey) return;
    try {
        const text = await decryptText(aesKey, ivB64, ciphertextB64);
        addTheirs(text);
        hideTyping();
    } catch (err) {
        addSys('Failed to decrypt a message (keys differ?)');
    }
});

// Receive encrypted files (accept both server payload shapes)
socket.on('file', async ({ ivB64, ciphertextB64, fileName, fileType, fileSize, filename, mime, size }) => {
    if (!aesKey) return;

    // Normalize keys to avoid undefined name/type
    const name = fileName || filename || 'file';
    const type = fileType || mime || 'application/octet-stream';
    const sz = fileSize ?? size ?? 0;

    try {
        const file = await decryptFile(aesKey, ivB64, ciphertextB64, name, type);

        // Ensure size is present for display (some browsers lock File.size)
        try {
            if (!file.size && sz) {
                Object.defineProperty(file, 'size', { value: sz, enumerable: true });
            }
        } catch (_) {}

        renderFileBubble(false, file);
        hideTyping();
    } catch (err) {
        addSys('Failed to decrypt a file.');
    }
});

// NEW: receive typing signal
socket.on('typing', ({ isTyping }) => {
    if (!connected) return;
    if (isTyping) showTyping();
    else hideTyping();
});

// Render file in chat bubble
function renderFileBubble(isMine, file) {
    const wrapper = document.createElement('div');
    wrapper.className = `bubble ${isMine ? 'mine' : 'theirs'} file-bubble`;
    
    const fileUrl = URL.createObjectURL(file);
    
    // File info section
    const fileInfo = document.createElement('div');
    fileInfo.className = 'file-info';
    
    const fileName = document.createElement('div');
    fileName.className = 'file-name';
    fileName.textContent = file.name;
    fileInfo.appendChild(fileName);
    
    const fileSize = document.createElement('div');
    fileSize.className = 'file-size';
    fileSize.textContent = formatFileSize(file.size);
    fileInfo.appendChild(fileSize);
    
    // Preview based on file type
    if (file.type.startsWith('image/')) {
        const img = document.createElement('img');
        img.className = 'file-preview';
        img.src = fileUrl;
        img.alt = file.name;
        wrapper.appendChild(img);
    } else if (file.type.startsWith('video/')) {
        const video = document.createElement('video');
        video.className = 'file-preview';
        video.src = fileUrl;
        video.controls = true;
        wrapper.appendChild(video);
    } else if (file.type.startsWith('audio/')) {
        const audio = document.createElement('audio');
        audio.controls = true;
        audio.src = fileUrl;
        wrapper.appendChild(audio);
    }
    
    wrapper.appendChild(fileInfo);
    
    // Download link
    const downloadLink = document.createElement('a');
    downloadLink.href = fileUrl;
    downloadLink.download = file.name;
    downloadLink.className = 'file-download';
    downloadLink.textContent = 'Download';
    wrapper.appendChild(downloadLink);
    
    // Add timestamp for my messages
    if (isMine) {
        const ts = document.createElement('span');
        ts.className = 'timestamp';
        ts.textContent = new Date().toLocaleTimeString();
        wrapper.appendChild(ts);
    }
    
    chat.appendChild(wrapper);
    chat.scrollTop = chat.scrollHeight;
}

// NEW: presence updates
socket.on('presence', ({ count }) => {
    participants = count;
    if (connected && roomCode) {
        setConnectedState(true, roomCode);
    }
});

// Create/generate code (creator flow)
generateBtn.addEventListener('click', async () => {
    if (connected) return;
    const code = randomCode();       // Secret code to share
    const roomSalt = genSaltB64();   // Public salt, stored on server

    socket.emit('create-room', { code, salt: roomSalt }, async (res) => {
        if (!res.ok) {
            addSys(`Failed to create room: ${res.error || 'unknown error'}`);
            return;
        }
        roomCode = code;
        salt = roomSalt;
        aesKey = await deriveAesKeyFromCode(roomCode, salt);
        codeInput.value = roomCode;      // Show for easy copy
        setConnectedState(true, roomCode);
        addSys('Room created. Share this code with your partner.');
    });
});

// Connect/join using code (joiner flow)
connectBtn.addEventListener('click', async () => {
    if (connected) return;
    const code = codeInput.value.trim().toUpperCase();
    if (!code) {
        addSys('Please enter a secret code.');
        return;
    }
    socket.emit('join-room', { code }, async (res) => {
        if (!res.ok) {
            addSys(`Join failed: ${res.error || 'unknown error'}`);
            return;
        }
        roomCode = code;
        salt = res.salt;
        aesKey = await deriveAesKeyFromCode(roomCode, salt);
        setConnectedState(true, roomCode);
        addSys('Joined room. You can now chat.');
    });
});

// Send encrypted message
sendBtn.addEventListener('click', async () => {
    if (!connected || !aesKey) return;
    const text = messageInput.value.trim();
    if (!text) return;

    try {
        const { ivB64, ciphertextB64 } = await encryptText(aesKey, text);
        socket.emit('message', { roomCode, ivB64, ciphertextB64 });
        addMine(text);
        messageInput.value = '';
        socket.emit('typing', { roomCode, isTyping: false });
        hideTyping();
    } catch (err) {
        addSys('Failed to encrypt message.');
    }
});

// NEW: keyboard UX — Enter sends, Shift+Enter newline
messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendBtn.click();
    }
});

// NEW: emit typing while user types (debounced stop)
messageInput.addEventListener('input', () => {
    if (!connected || !roomCode) return;
    socket.emit('typing', { roomCode, isTyping: true });
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
        socket.emit('typing', { roomCode, isTyping: false });
    }, 800);
});

// NEW: copy code to clipboard
copyBtn.addEventListener('click', async () => {
    const code = codeInput.value.trim();
    if (!code) {
        addSys('No code to copy.');
        return;
    }
    try {
        await navigator.clipboard.writeText(code);
        addSys('Code copied to clipboard.');
    } catch {
        addSys('Failed to copy code.');
    }
});

// NEW: theme toggle
themeToggle.addEventListener('click', () => {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    document.documentElement.setAttribute('data-theme', isDark ? 'light' : 'dark');
});

// Media picker toggle
mediaPickerBtn.addEventListener('click', () => {
    if (!connected) return;
    mediaPickerOpen = !mediaPickerOpen;
    if (mediaPickerOpen) {
        mediaPickerMenu.classList.add('active');
    } else {
        mediaPickerMenu.classList.remove('active');
    }
});

// Hide media picker when clicking elsewhere
document.addEventListener('click', (e) => {
    if (mediaPickerOpen && !mediaPickerBtn.contains(e.target) && !mediaPickerMenu.contains(e.target)) {
        mediaPickerOpen = false;
        mediaPickerMenu.classList.remove('active');
    }
});

// Media option handlers
photoOption.addEventListener('click', () => {
    fileInput.accept = 'image/*';
    fileInput.click();
    mediaPickerOpen = false;
    mediaPickerMenu.classList.remove('active');
});

videoOption.addEventListener('click', () => {
    fileInput.accept = 'video/*';
    fileInput.click();
    mediaPickerOpen = false;
    mediaPickerMenu.classList.remove('active');
});

documentOption.addEventListener('click', () => {
    fileInput.accept = 'application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain';
    fileInput.click();
    mediaPickerOpen = false;
    mediaPickerMenu.classList.remove('active');
});

// Attach button in composer
attachBtn.addEventListener('click', () => {
    if (!connected) return;
    fileInput.accept = 'image/*,video/*,audio/*,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain';
    fileInput.click();
});

// Handle file selection and sending
fileInput.addEventListener('change', async () => {
    if (!connected || !aesKey || !fileInput.files.length) return;

    const file = fileInput.files[0];
    if (file.size > 10 * 1024 * 1024) {
        addSys('File too large (max 10MB)');
        fileInput.value = '';
        return;
    }

    try {
        addSys('Encrypting and sending file...');
        const { ivB64, ciphertextB64, fileName, fileType, fileSize } = await encryptFile(aesKey, file);

        socket.emit('file', {
            roomCode,
            ivB64,
            ciphertextB64,
            fileName,
            fileType,
            fileSize
        });

        renderFileBubble(true, file);
        fileInput.value = '';
    } catch (err) {
        addSys('Failed to send file. Please try again.');
        fileInput.value = '';
    }
});

// Logout: disconnect and clear UI
logoutBtn.addEventListener('click', () => {
    if (!roomCode) return;
    socket.emit('logout', { code: roomCode });
    socket.disconnect();

    // Clear state
    roomCode = null;
    salt = null;
    aesKey = null;
    participants = 1;
    mediaPickerOpen = false;

    // Clear UI
    chat.innerHTML = '';
    codeInput.value = '';
    fileInput.value = '';
    hideTyping();
    mediaPickerMenu.classList.remove('active');
    setConnectedState(false);

    // Reconnect socket for future sessions
    setTimeout(() => socket.connect(), 200);
    addSys('Logged out. Chat cleared.');
});