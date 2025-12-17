// app.js - ES5 Puro para compatibilidad con Android 5.1

// --- ESTADO GLOBAL ---
var state = {
    myStream: null,
    myScreenStream: null,
    peers: {}, // Mapa de peerId -> objeto call
    userName: '',
    roomId: 'main-room',
    isMuted: false,
    isVideoOff: false,
    theme: 'dark',
    socket: null,
    myPeer: null,
    isMobile: /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
};

// URL del servidor (Backend original)
var SERVER_URL = "https://meet-clone-v0ov.onrender.com";

// --- ELEMENTOS DOM (Cache) ---
var dom = {
    lobby: document.getElementById('lobbyContainer'),
    callRoom: document.getElementById('callContainer'),
    joinBtn: document.getElementById('joinBtn'),
    usernameInput: document.getElementById('usernameInput'),
    videoGrid: document.getElementById('videoGrid'),
    muteBtn: document.getElementById('muteBtn'),
    videoBtn: document.getElementById('videoBtn'),
    shareBtn: document.getElementById('shareBtn'),
    chatToggleBtn: document.getElementById('chatToggleBtn'),
    chatSidebar: document.getElementById('chatSidebar'),
    closeChatBtn: document.getElementById('closeChatBtn'),
    chatForm: document.getElementById('chatForm'),
    chatInput: document.getElementById('chatInput'),
    chatMessages: document.getElementById('chatMessages'),
    leaveBtn: document.getElementById('leaveBtn'),
    themeDarkBtn: document.getElementById('themeDarkBtn'),
    themeLightBtn: document.getElementById('themeLightBtn'),
    statusMsg: document.getElementById('statusMsg')
};

// --- INICIALIZACIÓN ---
window.onload = function() {
    // Si es móvil, ocultar botón de compartir pantalla (no soportado en Android 5 WebView)
    if (state.isMobile) {
        dom.shareBtn.style.display = 'none';
    }

    dom.joinBtn.onclick = joinRoom;
    
    // Controles
    dom.muteBtn.onclick = toggleMute;
    dom.videoBtn.onclick = toggleVideo;
    dom.shareBtn.onclick = toggleScreenShare;
    dom.leaveBtn.onclick = leaveRoom;
    
    // Chat
    dom.chatToggleBtn.onclick = function() { toggleChat(true); };
    dom.closeChatBtn.onclick = function() { toggleChat(false); };
    dom.chatForm.onsubmit = sendMessage;

    // Tema
    dom.themeDarkBtn.onclick = function() { changeTheme('dark'); };
    dom.themeLightBtn.onclick = function() { changeTheme('light'); };
};

// --- LÓGICA PRINCIPAL ---

function joinRoom() {
    var name = dom.usernameInput.value;
    if (!name) { alert("Por favor ingresa un nombre"); return; }
    
    state.userName = name;
    dom.statusMsg.innerText = "Conectando...";
    dom.joinBtn.disabled = true;

    // 1. Obtener Media (Cámara/Micro)
    // Polyfill simple para getUserMedia antiguo
    var getUserMedia = (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) 
        ? function(c) { return navigator.mediaDevices.getUserMedia(c); }
        : function(c) {
            return new Promise(function(resolve, reject) {
                var getUserMediaLegacy = navigator.webkitGetUserMedia || navigator.mozGetUserMedia;
                if (!getUserMediaLegacy) {
                    return reject(new Error("WebRTC no soportado en este navegador"));
                }
                getUserMediaLegacy.call(navigator, c, resolve, reject);
            });
        };

    getUserMedia({ video: true, audio: true })
        .then(function(stream) {
            state.myStream = stream;
            addVideo(stream, state.userName, true, false);
            initSocketAndPeer();
        })
        .catch(function(err) {
            console.error(err);
            alert("Error al acceder a cámara/micrófono: " + err.message);
            dom.statusMsg.innerText = "Error de permisos.";
            dom.joinBtn.disabled = false;
        });
}

function initSocketAndPeer() {
    // 2. Conectar Socket.io
    state.socket = io(SERVER_URL);

    // 3. Conectar PeerJS
    state.myPeer = new Peer(undefined, {
        host: 'meet-clone-v0ov.onrender.com', // Extraído de la URL del servidor
        path: '/peerjs/myapp',
        secure: true,
        port: 443
    });

    state.myPeer.on('open', function(id) {
        console.log("My Peer ID: " + id);
        // Unirse a la sala via Socket
        state.socket.emit('join-room', state.roomId, id, state.userName);
        
        // Cambiar UI
        dom.lobby.style.display = 'none';
        dom.callRoom.style.display = 'block';
    });

    // --- EVENTOS SOCKET ---
    
    // Usuario conectado -> Llamarlo
    state.socket.on('user-joined', function(data) {
        // data = { userId, userName }
        console.log("Usuario unido:", data.userName);
        addMessageSystem(data.userName + " se ha unido.");
        connectToNewUser(data.userId, state.myStream, data.userName);
    });

    // Usuario desconectado
    state.socket.on('user-disconnected', function(userId, userName) {
        if (state.peers[userId]) {
            state.peers[userId].close();
            delete state.peers[userId];
        }
        removeVideo(userId);
        addMessageSystem((userName || "Usuario") + " salió.");
    });

    // Chat
    state.socket.on('createMessage', function(msg, user) {
        addMessageChat(user, msg, user === state.userName);
    });

    // Cambio de tema global
    state.socket.on('theme-changed', function(theme) {
        applyTheme(theme);
    });

    // Alguien comparte pantalla
    state.socket.on('user-started-screen-share', function(data) {
        console.log("Pantalla compartida iniciada por", data.userName);
        // PeerJS manejará el stream entrante, aquí solo notificamos
        addMessageSystem(data.userName + " está compartiendo pantalla.");
    });

    state.socket.on('user-stopped-screen-share', function(userId) {
        // Remover video de pantalla si existe (ID suele tener sufijo o ser manejado aparte)
        // En esta versión simplificada, PeerJS cierra el stream y el evento 'close' del call lo maneja
        var screenVideoId = 'video-' + userId + '-screen'; // Convención posible
        // Pero mejor confiamos en el evento close del call
    });

    // --- EVENTOS PEERJS ---

    // Recibir llamada
    state.myPeer.on('call', function(call) {
        var metadata = call.metadata || {};
        var isScreen = metadata.isScreenShare;
        
        // Contestar con mi stream (si no es pantalla compartida entrante pura)
        call.answer(state.myStream); 

        var videoWrapperId = null;

        call.on('stream', function(remoteStream) {
            // Generar ID único para el contenedor de video
            var remoteId = call.peer;
            if (isScreen) remoteId += "_screen";
            
            // Si ya existe, no agregar
            if (document.getElementById('video-' + remoteId)) return;

            addVideo(remoteStream, metadata.userName || 'Usuario', false, isScreen, remoteId);
        });

        call.on('close', function() {
            var remoteId = call.peer;
            if (isScreen) remoteId += "_screen";
            removeVideo(remoteId);
        });

        // Guardar referencia
        state.peers[call.peer + (isScreen ? '_screen' : '')] = call;
    });
}

function connectToNewUser(userId, stream, remoteName) {
    // Llamar normal
    var call = state.myPeer.call(userId, stream, {
        metadata: { userName: state.userName, isScreenShare: false }
    });

    call.on('stream', function(userVideoStream) {
        if (document.getElementById('video-' + userId)) return;
        addVideo(userVideoStream, remoteName, false, false, userId);
    });

    call.on('close', function() {
        removeVideo(userId);
    });

    state.peers[userId] = call;

    // Si estoy compartiendo pantalla, llamarlo también con el stream de pantalla
    if (state.myScreenStream) {
        var screenCall = state.myPeer.call(userId, state.myScreenStream, {
            metadata: { userName: state.userName, isScreenShare: true }
        });
        // No necesitamos manejar stream de vuelta para mi propia pantalla compartida hacia ellos
    }
}

// --- FUNCIONES UI VIDEO ---

function addVideo(stream, name, isLocal, isScreen, id) {
    var wrapper = document.createElement('div');
    wrapper.className = 'videoWrapper';
    if (isScreen) wrapper.className += ' isScreen';
    
    // ID único para eliminarlo después
    wrapper.id = 'video-' + (id || 'local' + (isScreen ? '-screen' : ''));

    var video = document.createElement('video');
    video.className = 'videoElement';
    if (isLocal && !isScreen) video.className += ' localVideo';
    video.srcObject = stream;
    video.autoplay = true;
    video.playsInline = true; // Importante para iOS/WebView
    if (isLocal) video.muted = true; // Evitar eco

    var label = document.createElement('div');
    label.className = 'userNameLabel';
    label.innerText = name + (isScreen ? ' (Pantalla)' : '');

    wrapper.appendChild(video);
    wrapper.appendChild(label);
    dom.videoGrid.appendChild(wrapper);
}

function removeVideo(id) {
    var el = document.getElementById('video-' + id);
    if (el) {
        el.parentNode.removeChild(el);
    }
}

// --- FUNCIONES DE CONTROLES ---

function toggleMute() {
    if (!state.myStream) return;
    var audioTrack = state.myStream.getAudioTracks()[0];
    if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        state.isMuted = !state.isMuted;
        dom.muteBtn.className = state.isMuted ? 'controlButton active' : 'controlButton';
        dom.muteBtn.innerHTML = state.isMuted ? '<i class="fa fa-microphone-slash"></i>' : '<i class="fa fa-microphone"></i>';
    }
}

function toggleVideo() {
    if (!state.myStream) return;
    var videoTrack = state.myStream.getVideoTracks()[0];
    if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        state.isVideoOff = !state.isVideoOff;
        dom.videoBtn.className = state.isVideoOff ? 'controlButton active' : 'controlButton';
        dom.videoBtn.innerHTML = state.isVideoOff ? '<i class="fa fa-video-camera"></i> <i class="fa fa-ban" style="font-size: 10px;"></i>' : '<i class="fa fa-video-camera"></i>';
    }
}

function toggleScreenShare() {
    if (state.myScreenStream) {
        // Detener compartir
        stopScreenShare();
    } else {
        // Iniciar compartir
        navigator.mediaDevices.getDisplayMedia({ video: true })
            .then(function(stream) {
                state.myScreenStream = stream;
                dom.shareBtn.className = 'controlButton activeShare';
                
                // Mostrar mi propia pantalla
                addVideo(stream, state.userName, true, true, 'local-screen');

                // Notificar socket
                state.socket.emit('start-screen-share', state.myPeer.id, state.userName);

                // Llamar a todos los peers existentes con el nuevo stream
                for (var peerId in state.peers) {
                    if (!peerId.includes('_screen')) { // No llamar a otras conexiones de pantalla
                        var call = state.myPeer.call(peerId, stream, {
                            metadata: { userName: state.userName, isScreenShare: true }
                        });
                        // Guardar referencia si es necesario, aunque sea fire-and-forget
                    }
                }

                // Listener para cuando el usuario detiene desde el navegador
                stream.getVideoTracks()[0].onended = function() {
                    stopScreenShare();
                };
            })
            .catch(function(err) {
                console.error("Error compartir pantalla", err);
            });
    }
}

function stopScreenShare() {
    if (state.myScreenStream) {
        state.myScreenStream.getTracks().forEach(function(t) { t.stop(); });
        state.myScreenStream = null;
        dom.shareBtn.className = 'controlButton';
        removeVideo('local-screen');
        state.socket.emit('stop-screen-share');
    }
}

function toggleChat(open) {
    if (open) dom.chatSidebar.className = 'chatSidebar open';
    else dom.chatSidebar.className = 'chatSidebar';
}

function sendMessage(e) {
    e.preventDefault();
    var txt = dom.chatInput.value.trim();
    if (txt && state.socket) {
        state.socket.emit('message', txt);
        // El servidor devuelve 'createMessage', así que no lo agregamos directamente aquí para evitar duplicados si la lógica del server es broadcast a todos incluyéndome.
        // Asumimos según tu código React que el server emite a todos.
        dom.chatInput.value = '';
    }
}

function addMessageChat(user, text, isMe) {
    var div = document.createElement('div');
    div.className = 'message ' + (isMe ? 'me' : 'other');
    
    var spanUser = document.createElement('span');
    spanUser.className = 'msgUser';
    spanUser.innerText = isMe ? 'Tú' : user;
    
    var spanText = document.createElement('span');
    spanText.innerText = text;
    
    div.appendChild(spanUser);
    div.appendChild(spanText);
    dom.chatMessages.appendChild(div);
    dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
}

function addMessageSystem(text) {
    var div = document.createElement('div');
    div.className = 'message system';
    div.innerText = text;
    dom.chatMessages.appendChild(div);
}

// --- TEMA ---

function changeTheme(theme) {
    applyTheme(theme);
    if (state.socket) {
        state.socket.emit('change-theme', theme);
    }
}

function applyTheme(theme) {
    state.theme = theme;
    if (theme === 'light') {
        document.body.classList.add('lightMode');
    } else {
        document.body.classList.remove('lightMode');
    }
}

function leaveRoom() {
    window.location.reload();
}