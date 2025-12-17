// app.js - ES5 Puro para compatibilidad con Android 5.1 y Corrección de NotReadableError

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

// --- LÓGICA DE CONEXIÓN ROBUSTA (FIX NotReadableError) ---

function getRobustMedia() {
    // Definir getUserMedia legacy de forma segura
    var getUserMedia = (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) 
        ? function(c) { return navigator.mediaDevices.getUserMedia(c); }
        : function(c) {
            return new Promise(function(resolve, reject) {
                var getUserMediaLegacy = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia;
                if (!getUserMediaLegacy) {
                    return reject(new Error("WebRTC no soportado en este navegador"));
                }
                getUserMediaLegacy.call(navigator, c, resolve, reject);
            });
        };

    // Estrategia de Constraints (De menor consumo a mayor compatibilidad)
    
    // 1. Low Res: Mejor para Androids viejos y redes lentas.
    var constraintsLow = { 
        audio: true, 
        video: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15 } } 
    };

    // 2. Default: Si Low falla, dejar que el navegador decida.
    var constraintsDefault = { audio: true, video: true };

    // 3. Audio Only: Último recurso si la cámara da error (NotReadable).
    var constraintsAudio = { audio: true, video: false };

    return new Promise(function(resolve, reject) {
        console.log("Intento 1: Video Baja Resolución");
        getUserMedia(constraintsLow)
            .then(resolve)
            .catch(function(err1) {
                console.warn("Fallo intento 1:", err1.name);
                
                // Si el usuario denegó permiso explícitamente, no reintentar
                if (err1.name === 'NotAllowedError' || err1.name === 'PermissionDeniedError') {
                    return reject(err1);
                }

                console.log("Intento 2: Video Default");
                dom.statusMsg.innerText = "Reintentando cámara...";
                getUserMedia(constraintsDefault)
                    .then(resolve)
                    .catch(function(err2) {
                        console.warn("Fallo intento 2:", err2.name);
                        
                        console.log("Intento 3: Solo Audio");
                        dom.statusMsg.innerText = "Cámara falló. Entrando con solo audio...";
                        getUserMedia(constraintsAudio)
                            .then(function(audioStream) {
                                alert("No se pudo iniciar la cámara (posiblemente ocupada por otra app o error de hardware). Se ha activado el modo SOLO AUDIO.");
                                resolve(audioStream);
                            })
                            .catch(function(err3) {
                                // Si falla incluso el audio, rechazar con el error original de video para info
                                reject(err2); 
                            });
                    });
            });
    });
}

function joinRoom() {
    var name = dom.usernameInput.value;
    if (!name) { alert("Por favor ingresa un nombre"); return; }
    
    state.userName = name;
    dom.statusMsg.innerText = "Solicitando permisos...";
    dom.joinBtn.disabled = true;

    getRobustMedia()
        .then(function(stream) {
            state.myStream = stream;
            // Verificar si tenemos video real
            var hasVideo = stream.getVideoTracks().length > 0;
            addVideo(stream, state.userName, true, false);
            
            if (!hasVideo) {
                state.isVideoOff = true;
                dom.videoBtn.innerHTML = '<i class="fa fa-ban"></i>';
                dom.videoBtn.disabled = true; // Deshabilitar botón de video si no hay track
            }

            initSocketAndPeer();
        })
        .catch(function(err) {
            console.error("Error fatal obteniendo media:", err);
            var msg = "Error al acceder a dispositivos: " + err.name;
            if (err.name === 'NotReadableError') {
                msg = "Error: La cámara/micrófono están siendo usados por otra aplicación o no responden. Cierra otras apps y reintenta.";
            } else if (err.name === 'NotAllowedError') {
                msg = "Error: Permiso denegado. Debes permitir el acceso para entrar.";
            }
            alert(msg);
            dom.statusMsg.innerText = "Error: " + err.name;
            dom.joinBtn.disabled = false;
        });
}

function initSocketAndPeer() {
    // 2. Conectar Socket.io
    state.socket = io(SERVER_URL);

    // 3. Conectar PeerJS
    state.myPeer = new Peer(undefined, {
        host: 'meet-clone-v0ov.onrender.com', 
        path: '/peerjs/myapp',
        secure: true,
        port: 443
    });

    state.myPeer.on('open', function(id) {
        console.log("My Peer ID: " + id);
        state.socket.emit('join-room', state.roomId, id, state.userName);
        dom.lobby.style.display = 'none';
        dom.callRoom.style.display = 'block';
    });

    // --- EVENTOS SOCKET ---
    state.socket.on('user-joined', function(data) {
        console.log("Usuario unido:", data.userName);
        addMessageSystem(data.userName + " se ha unido.");
        connectToNewUser(data.userId, state.myStream, data.userName);
    });

    state.socket.on('user-disconnected', function(userId, userName) {
        if (state.peers[userId]) {
            state.peers[userId].close();
            delete state.peers[userId];
        }
        removeVideo(userId);
        addMessageSystem((userName || "Usuario") + " salió.");
    });

    state.socket.on('createMessage', function(msg, user) {
        addMessageChat(user, msg, user === state.userName);
    });

    state.socket.on('theme-changed', function(theme) {
        applyTheme(theme);
    });

    state.socket.on('user-started-screen-share', function(data) {
        addMessageSystem(data.userName + " está compartiendo pantalla.");
    });

    // --- EVENTOS PEERJS ---
    state.myPeer.on('call', function(call) {
        var metadata = call.metadata || {};
        var isScreen = metadata.isScreenShare;
        
        call.answer(state.myStream); 

        call.on('stream', function(remoteStream) {
            var remoteId = call.peer;
            if (isScreen) remoteId += "_screen";
            
            if (document.getElementById('video-' + remoteId)) return;
            addVideo(remoteStream, metadata.userName || 'Usuario', false, isScreen, remoteId);
        });

        call.on('close', function() {
            var remoteId = call.peer;
            if (isScreen) remoteId += "_screen";
            removeVideo(remoteId);
        });

        state.peers[call.peer + (isScreen ? '_screen' : '')] = call;
    });
}

function connectToNewUser(userId, stream, remoteName) {
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

    if (state.myScreenStream) {
        state.myPeer.call(userId, state.myScreenStream, {
            metadata: { userName: state.userName, isScreenShare: true }
        });
    }
}

// --- FUNCIONES UI VIDEO ---

function addVideo(stream, name, isLocal, isScreen, id) {
    var wrapper = document.createElement('div');
    wrapper.className = 'videoWrapper';
    if (isScreen) wrapper.className += ' isScreen';
    
    wrapper.id = 'video-' + (id || 'local' + (isScreen ? '-screen' : ''));

    // Verificar si es solo audio
    var hasVideoTrack = stream.getVideoTracks().length > 0;

    var video = document.createElement('video');
    video.className = 'videoElement';
    if (isLocal && !isScreen) video.className += ' localVideo';
    
    video.srcObject = stream;
    video.autoplay = true;
    video.playsInline = true; 
    if (isLocal) video.muted = true; 

    var label = document.createElement('div');
    label.className = 'userNameLabel';
    label.innerText = name + (isScreen ? ' (Pantalla)' : '') + (!hasVideoTrack ? ' (Audio)' : '');

    // Si no hay video, podemos poner un icono o fondo
    if (!hasVideoTrack) {
        wrapper.style.background = "#333";
        wrapper.style.display = "flex";
        wrapper.style.alignItems = "center";
        wrapper.style.justifyContent = "center";
        var icon = document.createElement('i');
        icon.className = "fa fa-microphone fa-3x";
        icon.style.color = "#ccc";
        icon.style.zIndex = "1";
        wrapper.appendChild(icon);
    }

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
    var videoTracks = state.myStream.getVideoTracks();
    if (videoTracks.length > 0) {
        var videoTrack = videoTracks[0];
        videoTrack.enabled = !videoTrack.enabled;
        state.isVideoOff = !state.isVideoOff;
        dom.videoBtn.className = state.isVideoOff ? 'controlButton active' : 'controlButton';
        dom.videoBtn.innerHTML = state.isVideoOff ? '<i class="fa fa-video-camera"></i> <i class="fa fa-ban" style="font-size: 10px;"></i>' : '<i class="fa fa-video-camera"></i>';
    } else {
        alert("Modo solo audio: No hay cámara disponible para alternar.");
    }
}

function toggleScreenShare() {
    if (state.myScreenStream) {
        stopScreenShare();
    } else {
        navigator.mediaDevices.getDisplayMedia({ video: true })
            .then(function(stream) {
                state.myScreenStream = stream;
                dom.shareBtn.className = 'controlButton activeShare';
                
                addVideo(stream, state.userName, true, true, 'local-screen');
                state.socket.emit('start-screen-share', state.myPeer.id, state.userName);

                for (var peerId in state.peers) {
                    if (!peerId.includes('_screen')) { 
                        state.myPeer.call(peerId, stream, {
                            metadata: { userName: state.userName, isScreenShare: true }
                        });
                    }
                }

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